import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  link,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export const SEGMENT_RELAY_BASE_PATH = "/media/v1";
const TOKEN_VERSION = "sr1";
const TOKEN_LIFETIME_MS = 15 * 60_000;
const MAX_TOKEN_LIFETIME_MS = 30 * 60_000;
const MAX_SEGMENT_BYTES = 96 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 12 * 1024 * 1024;
const UPLOAD_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_MEMORY_BYTES = 192 * 1024 * 1024;
const MIN_DISK_BYTES = 64 * 1024 * 1024;
const MAX_DISK_BYTES = 5 * 1024 * 1024 * 1024;
const INDEX_WRITE_DELAY_MS = 250;
const ACTIVE_REWIND_PIN_MS = 30_000;
const ACTIVE_FORWARD_PIN_MS = 120_000;
const UNADVERTISED_UPLOAD_GRACE_MS = 15_000;
const ROOM_PATTERN = /^[23456789A-HJ-NP-Z]{8}$/;
const SESSION_PATTERN = /^[a-z0-9-]{8,128}$/i;
const ASSET_PATTERN = /^[a-f0-9]{24,64}$/;
const RENDITION_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
    : fallback;
}

function safeTimingEqual(left, right) {
  const leftBytes = Buffer.from(String(left || ""));
  const rightBytes = Buffer.from(String(right || ""));
  return (
    leftBytes.length > 0 &&
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function contentTypeForKind(kind) {
  if (kind === "manifest") return "application/json; charset=utf-8";
  if (kind === "subtitle") return "text/vtt; charset=utf-8";
  if (kind === "init") return "video/mp4";
  return "video/iso.segment";
}

function defaultDiskBudget(rootDir) {
  try {
    const disk = statfsSync(rootDir);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    return Math.min(
      MAX_DISK_BYTES,
      Math.max(MIN_DISK_BYTES, Math.floor(freeBytes * 0.04)),
    );
  } catch {
    return 2 * 1024 * 1024 * 1024;
  }
}

function safeRecordName(key) {
  return createHash("sha256").update(key).digest("hex");
}

function recordExtension(kind) {
  if (kind === "manifest") return "json";
  if (kind === "subtitle") return "vtt";
  if (kind === "init") return "mp4";
  return "m4s";
}

function indexedRecordKey(value) {
  if (!SESSION_PATTERN.test(String(value.sessionId || ""))) {
    return undefined;
  }
  const root =
    `${value.room}/${value.sessionId}/${value.assetId}/` +
    `${value.mediaVersion}`;
  if (value.kind === "manifest") return `${root}/manifest`;
  if (value.kind === "subtitle") return `${root}/subtitle`;
  if (!RENDITION_PATTERN.test(String(value.rendition || ""))) {
    return undefined;
  }
  if (value.kind === "init") {
    const epoch = Number(value.epoch);
    return Number.isSafeInteger(epoch) && epoch >= 1
      ? `${root}/${value.rendition}/epoch/${epoch}/init`
      : `${root}/${value.rendition}/init`;
  }
  if (
    value.kind !== "segment" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    value.sequence > 0xffffffff
  ) {
    return undefined;
  }
  return `${root}/${value.rendition}/${value.sequence}`;
}

function parseRange(value, size) {
  if (!value) return undefined;
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || String(value).includes(",")) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }
  return { start, end: Math.min(size - 1, end) };
}

function relayRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (
    parts[0] !== "media" ||
    parts[1] !== "v1" ||
    parts[2] !== "rooms" ||
    parts[4] !== "sessions" ||
    parts[6] !== "assets" ||
    parts[8] !== "versions"
  ) {
    return undefined;
  }
  const room = String(parts[3] || "").toUpperCase();
  const sessionId = String(parts[5] || "").toLowerCase();
  const assetId = String(parts[7] || "").toLowerCase();
  const mediaVersion = Number(parts[9]);
  if (
    !ROOM_PATTERN.test(room) ||
    !SESSION_PATTERN.test(sessionId) ||
    !ASSET_PATTERN.test(assetId) ||
    !Number.isSafeInteger(mediaVersion) ||
    mediaVersion < 1 ||
    mediaVersion > 0xffffffff
  ) {
    return null;
  }
  const root = { room, sessionId, assetId, mediaVersion };
  const keyRoot = `${room}/${sessionId}/${assetId}/${mediaVersion}`;
  if (parts.length === 11 && parts[10] === "manifest.json") {
    return {
      ...root,
      kind: "manifest",
      key: `${keyRoot}/manifest`,
    };
  }
  if (parts.length === 11 && parts[10] === "subtitle.vtt") {
    return {
      ...root,
      kind: "subtitle",
      key: `${keyRoot}/subtitle`,
    };
  }
  if (
    parts[10] !== "renditions" ||
    !RENDITION_PATTERN.test(String(parts[11] || ""))
  ) {
    return null;
  }
  const rendition = parts[11];
  if (parts.length === 13 && parts[12] === "init.mp4") {
    return {
      ...root,
      rendition,
      kind: "init",
      key: `${keyRoot}/${rendition}/init`,
    };
  }
  const initEpoch =
    parts.length === 15 &&
    parts[12] === "epochs" &&
    parts[14] === "init.mp4"
      ? Number(parts[13])
      : undefined;
  if (
    Number.isSafeInteger(initEpoch) &&
    initEpoch >= 1 &&
    initEpoch <= 0xffffffff
  ) {
    return {
      ...root,
      rendition,
      epoch: initEpoch,
      kind: "init",
      key: `${keyRoot}/${rendition}/epoch/${initEpoch}/init`,
    };
  }
  const sequenceMatch =
    parts.length === 14 &&
    parts[12] === "segments" &&
    String(parts[13] || "").match(/^(\d+)\.m4s$/);
  if (!sequenceMatch) return null;
  const sequence = Number(sequenceMatch[1]);
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > 0xffffffff
  ) {
    return null;
  }
  return {
    ...root,
    rendition,
    sequence,
    kind: "segment",
    key: `${keyRoot}/${rendition}/${sequence}`,
  };
}

function validateManifest(bytes, route) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw Object.assign(new Error("manifest-json"), { statusCode: 400 });
  }
  if (
    manifest?.protocol !== "synced-cmaf-v1" ||
    manifest.roomId !== route.room ||
    manifest.sessionId !== route.sessionId ||
    manifest.assetId !== route.assetId ||
    Number(manifest.mediaVersion) !== route.mediaVersion ||
    (manifest.playbackTimeMs !== undefined &&
      (!Number.isFinite(Number(manifest.playbackTimeMs)) ||
        Number(manifest.playbackTimeMs) < 0)) ||
    (manifest.ended !== undefined &&
      typeof manifest.ended !== "boolean") ||
    (manifest.revision !== undefined &&
      (!Number.isSafeInteger(Number(manifest.revision)) ||
        Number(manifest.revision) < 1)) ||
    (manifest.evictionRevision !== undefined &&
      (!Number.isSafeInteger(Number(manifest.evictionRevision)) ||
        Number(manifest.evictionRevision) < 0)) ||
    (manifest.acknowledgedEvictionRevision !== undefined &&
      (!Number.isSafeInteger(
        Number(manifest.acknowledgedEvictionRevision),
      ) ||
        Number(manifest.acknowledgedEvictionRevision) < 0)) ||
    (manifest.tombstones !== undefined &&
      (!Array.isArray(manifest.tombstones) ||
        manifest.tombstones.length > 16)) ||
    !Array.isArray(manifest.renditions) ||
    manifest.renditions.length < 1 ||
    manifest.renditions.length > 8
  ) {
    throw Object.assign(new Error("manifest-schema"), { statusCode: 400 });
  }
  manifest.revision = Number(manifest.revision) || 1;
  manifest.evictionRevision =
    Number(manifest.evictionRevision) || 0;
  manifest.acknowledgedEvictionRevision =
    Number(manifest.acknowledgedEvictionRevision) || 0;
  manifest.tombstones = Array.isArray(manifest.tombstones)
    ? manifest.tombstones
    : [];
  const tombstoneRenditions = new Set();
  for (const tombstone of manifest.tombstones) {
    const throughSequence = Number(tombstone?.throughSequence);
    const fromSequence = Number(tombstone?.fromSequence);
    const hasThrough = Number.isSafeInteger(throughSequence);
    const hasFrom = Number.isSafeInteger(fromSequence);
    if (
      !tombstone ||
      typeof tombstone !== "object" ||
      !RENDITION_PATTERN.test(String(tombstone.renditionId || "")) ||
      tombstoneRenditions.has(tombstone.renditionId) ||
      (!hasThrough && !hasFrom) ||
      (hasThrough && (throughSequence < 1 || throughSequence > 0xffffffff)) ||
      (hasFrom && (fromSequence < 1 || fromSequence > 0xffffffff)) ||
      (hasThrough && hasFrom && throughSequence >= fromSequence) ||
      !Number.isSafeInteger(Number(tombstone.evictionRevision)) ||
      Number(tombstone.evictionRevision) < 1 ||
      Number(tombstone.evictionRevision) > manifest.evictionRevision
    ) {
      throw Object.assign(new Error("manifest-tombstone"), {
        statusCode: 400,
      });
    }
    tombstoneRenditions.add(tombstone.renditionId);
  }
  const versionRoot =
    `${SEGMENT_RELAY_BASE_PATH}/rooms/${route.room}/sessions/` +
    `${route.sessionId}/assets/${route.assetId}/` +
    `versions/${route.mediaVersion}/`;
  if (
    manifest.subtitle !== undefined &&
    (!manifest.subtitle ||
      typeof manifest.subtitle !== "object" ||
      manifest.subtitle.path !== `${versionRoot}subtitle.vtt` ||
      (manifest.subtitle.language !== undefined &&
        (typeof manifest.subtitle.language !== "string" ||
          manifest.subtitle.language.length > 24)) ||
      (manifest.subtitle.title !== undefined &&
        (typeof manifest.subtitle.title !== "string" ||
          manifest.subtitle.title.length > 160)))
  ) {
    throw Object.assign(new Error("manifest-subtitle"), {
      statusCode: 400,
    });
  }
  const renditionIds = new Set();
  for (const rendition of manifest.renditions) {
    const renditionRoot =
      `${versionRoot}renditions/${String(rendition?.id || "")}/`;
    const epoch =
      rendition?.epoch === undefined ? undefined : Number(rendition.epoch);
    const expectedInitPath =
      epoch === undefined
        ? `${renditionRoot}init.mp4`
        : `${renditionRoot}epochs/${epoch}/init.mp4`;
    if (
      !RENDITION_PATTERN.test(String(rendition?.id || "")) ||
      renditionIds.has(rendition.id) ||
      (epoch !== undefined &&
        (!Number.isSafeInteger(epoch) ||
          epoch < 1 ||
          epoch > 0xffffffff)) ||
      rendition?.initPath !== expectedInitPath ||
      typeof rendition?.mimeType !== "string" ||
      !rendition.mimeType.startsWith("video/mp4") ||
      !Number.isFinite(Number(rendition?.bitrate)) ||
      Number(rendition.bitrate) <= 0 ||
      Number(rendition.bitrate) > 250_000_000 ||
      (rendition.ended !== undefined &&
        typeof rendition.ended !== "boolean") ||
      (rendition.finalSequence !== undefined &&
        (!Number.isSafeInteger(Number(rendition.finalSequence)) ||
          Number(rendition.finalSequence) < 1 ||
          Number(rendition.finalSequence) > 0xffffffff)) ||
      (rendition.finalTimelineEndMs !== undefined &&
        (!Number.isFinite(Number(rendition.finalTimelineEndMs)) ||
          Number(rendition.finalTimelineEndMs) < 0)) ||
      (rendition.finalTimelineEndMs !== undefined &&
        rendition.finalSequence === undefined) ||
      !Array.isArray(rendition?.segments) ||
      rendition.segments.length > 100_000
    ) {
      throw Object.assign(new Error("manifest-rendition"), {
        statusCode: 400,
      });
    }
    renditionIds.add(rendition.id);
    const segmentSequences = new Set();
    let previousSequence;
    for (const segment of rendition.segments) {
      if (Array.isArray(segment)) {
        const sequence = Number(segment[0]);
        if (
          segment.length < 6 ||
          !Number.isSafeInteger(sequence) ||
          sequence < 1 ||
          sequence > 0xffffffff ||
          segmentSequences.has(sequence) ||
          !Number.isFinite(Number(segment[1])) ||
          Number(segment[1]) < 0 ||
          !Number.isFinite(Number(segment[2])) ||
          Number(segment[2]) < 0 ||
          !Number.isFinite(Number(segment[3])) ||
          Number(segment[3]) < 0 ||
          Number(segment[3]) > 60_000 ||
          ![0, 1, true, false].includes(segment[4]) ||
          !Number.isSafeInteger(Number(segment[5])) ||
          Number(segment[5]) < 0 ||
          Number(segment[5]) > MAX_SEGMENT_BYTES ||
          (segment[6] !== undefined &&
            !/^[a-f0-9]{64}$/.test(String(segment[6])))
        ) {
          throw Object.assign(new Error("manifest-segment"), {
            statusCode: 400,
          });
        }
        segmentSequences.add(sequence);
        if (
          previousSequence !== undefined &&
          sequence !== previousSequence + 1
        ) {
          throw Object.assign(new Error("manifest-segment-gap"), {
            statusCode: 400,
          });
        }
        previousSequence = sequence;
      } else {
        const sequence = Number(segment?.sequence);
        if (
          !segment ||
          !Number.isSafeInteger(sequence) ||
          sequence < 1 ||
          sequence > 0xffffffff ||
          segmentSequences.has(sequence) ||
          !Number.isFinite(Number(segment.mediaTimeMs)) ||
          Number(segment.mediaTimeMs) < 0 ||
          !Number.isFinite(Number(segment.timelineTimeMs)) ||
          Number(segment.timelineTimeMs) < 0 ||
          !Number.isFinite(Number(segment.durationMs)) ||
          Number(segment.durationMs) < 0 ||
          Number(segment.durationMs) > 60_000 ||
          typeof segment.keyframe !== "boolean" ||
          !Number.isSafeInteger(Number(segment.bytes)) ||
          Number(segment.bytes) < 0 ||
          Number(segment.bytes) > MAX_SEGMENT_BYTES ||
          segment.path !== `${renditionRoot}segments/${sequence}.m4s` ||
          (segment.sha256 !== undefined &&
            !/^[a-f0-9]{64}$/.test(String(segment.sha256)))
        ) {
          throw Object.assign(new Error("manifest-segment"), {
            statusCode: 400,
          });
        }
        segmentSequences.add(sequence);
        if (
          previousSequence !== undefined &&
          sequence !== previousSequence + 1
        ) {
          throw Object.assign(new Error("manifest-segment-gap"), {
            statusCode: 400,
          });
        }
        previousSequence = sequence;
      }
    }
  }
  return manifest;
}

export class SegmentRelayStore {
  constructor(options = {}) {
    this.rootDir = path.resolve(
      options.rootDir ||
        path.join(tmpdir(), "synced-segment-relay-cache"),
    );
    mkdirSync(this.rootDir, { recursive: true });
    this.maxDiskBytes = boundedInteger(
      options.maxDiskBytes,
      defaultDiskBudget(this.rootDir),
      64 * 1024 * 1024,
      MAX_DISK_BYTES,
    );
    this.maxMemoryBytes = boundedInteger(
      options.maxMemoryBytes,
      DEFAULT_MEMORY_BYTES,
      8 * 1024 * 1024,
      1024 * 1024 * 1024,
    );
    this.records = new Map();
    this.activeSessions = new Map();
    this.diskBytes = 0;
    this.memoryBytes = 0;
    this.indexTimer = undefined;
    this.mutationQueue = Promise.resolve();
    this.lastAdmissionRejectedAt = 0;
    this.closed = false;
    this.loadIndex();
  }

  loadIndex() {
    const indexPath = path.join(this.rootDir, "index.json");
    if (!existsSync(indexPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
      for (const value of Array.isArray(parsed?.records) ? parsed.records : []) {
        const expectedKey = indexedRecordKey(value || {});
        if (
          typeof value?.key !== "string" ||
          typeof value?.fileName !== "string" ||
          !/^[a-f0-9]{64}\.(?:json|vtt|mp4|m4s)$/.test(value.fileName) ||
          !["manifest", "subtitle", "init", "segment"].includes(value.kind) ||
          !ROOM_PATTERN.test(String(value.room || "")) ||
          !SESSION_PATTERN.test(String(value.sessionId || "")) ||
          !ASSET_PATTERN.test(String(value.assetId || "")) ||
          !Number.isSafeInteger(value.mediaVersion) ||
          value.mediaVersion < 1 ||
          value.mediaVersion > 0xffffffff ||
          !/^[a-f0-9]{64}$/.test(String(value.sha256 || "")) ||
          !Number.isSafeInteger(value?.bytes) ||
          value.bytes < 0 ||
          !expectedKey ||
          value.key !== expectedKey ||
          value.fileName !==
            `${safeRecordName(expectedKey)}.${recordExtension(value.kind)}`
        ) {
          continue;
        }
        const filePath = path.resolve(this.rootDir, value.fileName);
        if (path.dirname(filePath) !== this.rootDir) continue;
        if (!existsSync(filePath)) continue;
        const actualBytes = statSync(filePath).size;
        if (actualBytes !== value.bytes) continue;
        const record = {
          ...value,
          filePath,
          contentType: contentTypeForKind(value.kind),
          etag: `"${value.sha256}"`,
          buffer: undefined,
          manifest: undefined,
          lastAccess: Number(value.lastAccess) || Date.now(),
          uploadedAt:
            Number(value.uploadedAt) ||
            Number(value.lastAccess) ||
            Date.now(),
          firstAdvertisedRevision:
            Number.isSafeInteger(value.firstAdvertisedRevision) &&
            value.firstAdvertisedRevision >= 1
              ? value.firstAdvertisedRevision
              : undefined,
          lastAdvertisedRevision:
            Number.isSafeInteger(value.lastAdvertisedRevision) &&
            value.lastAdvertisedRevision >= 1
              ? value.lastAdvertisedRevision
              : undefined,
          advertisedAt:
            Number.isFinite(Number(value.advertisedAt)) &&
            Number(value.advertisedAt) > 0
              ? Number(value.advertisedAt)
              : undefined,
        };
        if (record.kind === "manifest") {
          try {
            record.manifest = validateManifest(
              readFileSync(filePath),
              record,
            );
          } catch {
            continue;
          }
        }
        this.records.set(record.key, record);
        this.diskBytes += record.bytes;
      }
      for (const record of this.records.values()) {
        if (record.kind === "manifest") {
          this.markManifestObjectsAdvertised(record);
        }
      }
      this.evict();
    } catch {
      // A stale cache index is disposable; new writes rebuild it atomically.
    }
  }

  createUploadPath() {
    return path.join(this.rootDir, `.upload-${randomUUID()}.tmp`);
  }

  async commit(route, temporaryPath, bytes, metadata) {
    let releaseMutation;
    const previousMutation = this.mutationQueue;
    this.mutationQueue = new Promise((resolve) => {
      releaseMutation = resolve;
    });
    await previousMutation;
    try {
      return await this.commitLocked(
        route,
        temporaryPath,
        bytes,
        metadata,
      );
    } finally {
      releaseMutation();
    }
  }

  async commitLocked(route, temporaryPath, bytes, metadata) {
    if (this.closed) throw new Error("segment-store-closed");
    let existing = this.records.get(route.key);
    if (route.kind === "manifest") {
      if (existing && existing.sha256 === metadata.sha256) {
        await unlink(temporaryPath).catch(() => undefined);
        existing.lastAccess = Date.now();
        this.records.delete(route.key);
        this.records.set(route.key, existing);
        return existing;
      }
      this.validateManifestRevision(route, metadata.manifest, existing);
      this.validateManifestObjects(route, metadata.manifest);
    }
    if (existing && route.kind !== "manifest") {
      await unlink(temporaryPath).catch(() => undefined);
      if (
        existing.bytes !== bytes ||
        existing.sha256 !== metadata.sha256
      ) {
        throw Object.assign(new Error("immutable-object-conflict"), {
          statusCode: 409,
        });
      }
      existing.lastAccess = Date.now();
      this.records.delete(route.key);
      this.records.set(route.key, existing);
      return existing;
    }
    const protectedForAdmission = new Set([route.key]);
    if (route.kind === "manifest") {
      for (const key of this.manifestObjectKeys(route, metadata.manifest)) {
        protectedForAdmission.add(key);
      }
    }
    this.ensureCapacity(
      route,
      bytes,
      existing?.bytes || 0,
      protectedForAdmission,
    );
    // Capacity reclamation can advance a coordinated manifest revision.
    // Re-read and revalidate under the same mutation lock before replacing it.
    existing = this.records.get(route.key);
    if (route.kind === "manifest") {
      if (existing && existing.sha256 === metadata.sha256) {
        await unlink(temporaryPath).catch(() => undefined);
        existing.lastAccess = Date.now();
        this.records.delete(route.key);
        this.records.set(route.key, existing);
        return existing;
      }
      this.validateManifestRevision(route, metadata.manifest, existing);
      this.validateManifestObjects(route, metadata.manifest);
    }
    const fileName =
      `${safeRecordName(route.key)}.${recordExtension(route.kind)}`;
    const filePath = path.join(this.rootDir, fileName);
    if (route.kind === "manifest") {
      await rename(temporaryPath, filePath).catch(async (error) => {
        if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
        await unlink(filePath).catch(() => undefined);
        await rename(temporaryPath, filePath);
      });
    } else {
      try {
        // Hard-linking is an exclusive create on every supported relay
        // platform. Unlike rename(), it cannot silently replace an immutable
        // object when two PUT requests for the same key finish together.
        await link(temporaryPath, filePath);
        await unlink(temporaryPath);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const onDisk = await readFile(filePath);
        const onDiskHash = createHash("sha256").update(onDisk).digest("hex");
        await unlink(temporaryPath).catch(() => undefined);
        if (onDisk.length !== bytes || onDiskHash !== metadata.sha256) {
          throw Object.assign(new Error("immutable-object-conflict"), {
            statusCode: 409,
          });
        }
      }
    }
    if (existing) {
      this.diskBytes -= existing.bytes;
      if (existing.buffer) this.memoryBytes -= existing.buffer.byteLength;
    }
    const record = {
      key: route.key,
      room: route.room,
      sessionId: route.sessionId,
      assetId: route.assetId,
      mediaVersion: route.mediaVersion,
      rendition: route.rendition,
      epoch: route.epoch,
      sequence: route.sequence,
      kind: route.kind,
      bytes,
      contentType: contentTypeForKind(route.kind),
      etag: `"${metadata.sha256}"`,
      sha256: metadata.sha256,
      mediaTimeMs: metadata.mediaTimeMs,
      timelineTimeMs: metadata.timelineTimeMs,
      durationMs: metadata.durationMs,
      keyframe: metadata.keyframe,
      bitrate: metadata.bitrate,
      fileName,
      filePath,
      lastAccess: Date.now(),
      uploadedAt: Date.now(),
      firstAdvertisedRevision: undefined,
      lastAdvertisedRevision: undefined,
      advertisedAt: undefined,
      buffer: undefined,
      manifest:
        route.kind === "manifest" ? metadata.manifest : undefined,
    };
    this.records.delete(route.key);
    this.records.set(route.key, record);
    this.diskBytes += bytes;
    if (bytes <= 8 * 1024 * 1024) {
      try {
        record.buffer = await readFile(filePath);
        this.memoryBytes += record.buffer.byteLength;
      } catch {
        record.buffer = undefined;
      }
    }
    if (record.kind === "manifest") {
      this.noteManifest(record);
      this.markManifestObjectsAdvertised(record);
    }
    this.evict();
    this.scheduleIndex();
    return record;
  }

  ensureCapacity(route, incomingBytes, replacingBytes, protectedKeys) {
    const delta = Math.max(
      0,
      Math.max(0, Number(incomingBytes) || 0) -
        Math.max(0, Number(replacingBytes) || 0),
    );
    if (delta <= 0) return;
    const targetBeforeCommit = this.maxDiskBytes - delta;
    if (targetBeforeCommit >= 0 && this.diskBytes > targetBeforeCommit) {
      this.evict(targetBeforeCommit, protectedKeys);
    }
    if (
      targetBeforeCommit >= 0 &&
      this.diskBytes <= targetBeforeCommit
    ) {
      return;
    }
    this.lastAdmissionRejectedAt = Date.now();
    throw Object.assign(new Error("storage-capacity-exceeded"), {
      statusCode: 507,
      relayBody: {
        ...this.manifestCoordination(
          route,
          "storage-capacity-exceeded",
        ),
        storagePressure: true,
        maxDiskBytes: this.maxDiskBytes,
        diskBytes: this.diskBytes,
        incomingBytes: Math.max(0, Number(incomingBytes) || 0),
        retryAfterMs: UNADVERTISED_UPLOAD_GRACE_MS,
      },
    });
  }

  manifestCoordination(route, code, missing = []) {
    const key =
      `${route.room}/${route.sessionId}/${route.assetId}/` +
      `${route.mediaVersion}/manifest`;
    const current = this.records.get(key);
    const manifest = current?.manifest;
    return {
      code,
      revision: Math.max(0, Number(manifest?.revision) || 0),
      evictionRevision: Math.max(
        0,
        Number(manifest?.evictionRevision) || 0,
      ),
      tombstones: Array.isArray(manifest?.tombstones)
        ? manifest.tombstones
        : [],
      etag: current?.etag,
      missing,
    };
  }

  conflict(route, code, missing = []) {
    return Object.assign(new Error(code), {
      statusCode: 409,
      relayBody: this.manifestCoordination(route, code, missing),
    });
  }

  validateManifestRevision(route, manifest, existing) {
    if (!existing?.manifest) return;
    const current = existing.manifest;
    const currentRevision = Math.max(1, Number(current.revision) || 1);
    const currentEvictionRevision = Math.max(
      0,
      Number(current.evictionRevision) || 0,
    );
    const nextRevision = Math.max(1, Number(manifest.revision) || 1);
    const acknowledgedEvictionRevision = Math.max(
      0,
      Number(manifest.acknowledgedEvictionRevision) || 0,
    );
    const suppliedEvictionRevision = Math.max(
      0,
      Number(manifest.evictionRevision) || 0,
    );
    if (
      nextRevision <= currentRevision ||
      acknowledgedEvictionRevision !== currentEvictionRevision ||
      suppliedEvictionRevision !== currentEvictionRevision
    ) {
      throw this.conflict(route, "manifest-revision-conflict");
    }
    const suppliedTombstones = new Map(
      manifest.tombstones.map((item) => [item.renditionId, item]),
    );
    for (const currentTombstone of current.tombstones || []) {
      const supplied = suppliedTombstones.get(
        currentTombstone.renditionId,
      );
      if (
        !supplied ||
        (currentTombstone.throughSequence !== undefined &&
          Number(supplied.throughSequence) <
            Number(currentTombstone.throughSequence)) ||
        (currentTombstone.fromSequence !== undefined &&
          Number(supplied.fromSequence) >
            Number(currentTombstone.fromSequence)) ||
        Number(supplied.evictionRevision) <
          Number(currentTombstone.evictionRevision)
      ) {
        throw this.conflict(route, "manifest-tombstone-conflict");
      }
    }
  }

  validateManifestObjects(route, manifest) {
    const root =
      `${route.room}/${route.sessionId}/${route.assetId}/` +
      `${route.mediaVersion}`;
    const missing = [];
    for (const rendition of manifest.renditions) {
      const initKey =
        rendition.epoch === undefined
          ? `${root}/${rendition.id}/init`
          : `${root}/${rendition.id}/epoch/${rendition.epoch}/init`;
      if (!this.records.has(initKey)) {
        missing.push({
          kind: "init",
          renditionId: rendition.id,
          ...(rendition.epoch === undefined
            ? {}
            : { epoch: Number(rendition.epoch) }),
        });
      }
      for (const segment of rendition.segments) {
        const sequence = Number(
          Array.isArray(segment) ? segment[0] : segment.sequence,
        );
        const bytes = Number(
          Array.isArray(segment) ? segment[5] : segment.bytes,
        );
        const sha256 = Array.isArray(segment)
          ? segment[6]
          : segment.sha256;
        const record = this.records.get(
          `${root}/${rendition.id}/${sequence}`,
        );
        if (
          !record ||
          record.kind !== "segment" ||
          record.bytes !== bytes ||
          (sha256 !== undefined && record.sha256 !== sha256)
        ) {
          missing.push({
            kind: "segment",
            renditionId: rendition.id,
            sequence,
            timelineTimeMs: Number(
              Array.isArray(segment)
                ? segment[2]
                : segment.timelineTimeMs,
            ),
          });
        }
      }
    }
    if (
      manifest.subtitle &&
      !this.records.has(`${root}/subtitle`)
    ) {
      missing.push({ kind: "subtitle" });
    }
    if (missing.length) {
      throw this.conflict(route, "manifest-object-missing", missing);
    }
  }

  manifestObjectKeys(route, manifest) {
    const root =
      `${route.room}/${route.sessionId}/${route.assetId}/` +
      `${route.mediaVersion}`;
    const keys = new Set();
    if (manifest.subtitle) keys.add(`${root}/subtitle`);
    for (const rendition of manifest.renditions) {
      keys.add(
        rendition.epoch === undefined
          ? `${root}/${rendition.id}/init`
          : `${root}/${rendition.id}/epoch/${rendition.epoch}/init`,
      );
      for (const segment of rendition.segments) {
        const sequence = Number(
          Array.isArray(segment) ? segment[0] : segment.sequence,
        );
        keys.add(`${root}/${rendition.id}/${sequence}`);
      }
    }
    return keys;
  }

  markManifestObjectsAdvertised(manifestRecord) {
    const manifest = manifestRecord?.manifest;
    if (!manifest) return;
    const revision = Math.max(1, Number(manifest.revision) || 1);
    const advertisedAt = Date.now();
    manifestRecord.firstAdvertisedRevision ??= revision;
    manifestRecord.lastAdvertisedRevision = revision;
    manifestRecord.advertisedAt = advertisedAt;
    for (const key of this.manifestObjectKeys(manifestRecord, manifest)) {
      const record = this.records.get(key);
      if (!record) continue;
      record.firstAdvertisedRevision ??= revision;
      record.lastAdvertisedRevision = revision;
      record.advertisedAt = advertisedAt;
    }
  }

  get(key) {
    const record = this.records.get(key);
    if (!record) return undefined;
    record.lastAccess = Date.now();
    this.records.delete(key);
    this.records.set(key, record);
    return record;
  }

  activeSessionKey(room, sessionId) {
    return `${room}/${sessionId}`;
  }

  activateSession(room, sessionId) {
    const normalizedRoom = String(room || "").toUpperCase();
    const normalizedSession = String(sessionId || "").toLowerCase();
    if (
      !ROOM_PATTERN.test(normalizedRoom) ||
      !SESSION_PATTERN.test(normalizedSession)
    ) {
      return false;
    }
    const key = this.activeSessionKey(normalizedRoom, normalizedSession);
    const existing = this.activeSessions.get(key);
    const entry = existing || {
      room: normalizedRoom,
      sessionId: normalizedSession,
      mediaVersion: undefined,
      previousVersions: new Map(),
    };
    entry.activatedAt = Date.now();
    let newestVersion = entry.mediaVersion;
    for (const record of this.records.values()) {
      if (
        record.kind === "manifest" &&
        record.room === normalizedRoom &&
        record.sessionId === normalizedSession &&
        (!Number.isSafeInteger(newestVersion) ||
          record.mediaVersion > newestVersion)
      ) {
        newestVersion = record.mediaVersion;
      }
    }
    entry.mediaVersion = newestVersion;
    this.activeSessions.set(key, entry);
    return true;
  }

  deactivateSession(room, sessionId) {
    const key = this.activeSessionKey(
      String(room || "").toUpperCase(),
      String(sessionId || "").toLowerCase(),
    );
    const removed = this.activeSessions.delete(key);
    if (removed) this.evict();
    return removed;
  }

  noteManifest(record) {
    const key = this.activeSessionKey(record.room, record.sessionId);
    const entry = this.activeSessions.get(key);
    if (!entry) return;
    if (
      Number.isSafeInteger(entry.mediaVersion) &&
      record.mediaVersion > entry.mediaVersion
    ) {
      entry.previousVersions.set(entry.mediaVersion, Date.now() + 120_000);
    }
    if (
      !Number.isSafeInteger(entry.mediaVersion) ||
      record.mediaVersion >= entry.mediaVersion
    ) {
      entry.mediaVersion = record.mediaVersion;
    }
  }

  protectedActiveKeys(now = Date.now(), extraKeys = new Set()) {
    const protectedKeys = new Set(extraKeys);
    // Uploading an immutable object and advertising it in the next manifest
    // are separate requests. A short, persisted grace period closes that race
    // without pinning an unlimited unpublished future forever.
    for (const [key, record] of this.records) {
      if (
        !Number.isSafeInteger(record.firstAdvertisedRevision) &&
        now - Math.max(0, Number(record.uploadedAt) || 0) <=
          UNADVERTISED_UPLOAD_GRACE_MS
      ) {
        protectedKeys.add(key);
      }
    }
    for (const entry of this.activeSessions.values()) {
      for (const [version, expiresAt] of entry.previousVersions) {
        if (expiresAt <= now) entry.previousVersions.delete(version);
      }
      const versions = new Set(entry.previousVersions.keys());
      if (Number.isSafeInteger(entry.mediaVersion)) {
        versions.add(entry.mediaVersion);
      }
      for (const [key, manifestRecord] of this.records) {
        if (
          manifestRecord.room !== entry.room ||
          manifestRecord.sessionId !== entry.sessionId ||
          manifestRecord.kind !== "manifest" ||
          (versions.size && !versions.has(manifestRecord.mediaVersion))
        ) {
          continue;
        }
        protectedKeys.add(key);
        let manifest = manifestRecord.manifest;
        if (!manifest) {
          try {
            manifest = validateManifest(
              readFileSync(manifestRecord.filePath),
              manifestRecord,
            );
          } catch {
            continue;
          }
        }
        const root =
          `${manifestRecord.room}/${manifestRecord.sessionId}/` +
          `${manifestRecord.assetId}/${manifestRecord.mediaVersion}`;
        if (manifest.subtitle) protectedKeys.add(`${root}/subtitle`);
        const playbackTimeMs =
          Number.isFinite(Number(manifest.playbackTimeMs))
            ? Number(manifest.playbackTimeMs)
            : Math.max(0, Number(manifest.startTimeTicks) || 0) / 10_000;
        const protectedStart =
          playbackTimeMs - ACTIVE_REWIND_PIN_MS;
        const protectedEnd =
          playbackTimeMs + ACTIVE_FORWARD_PIN_MS;
        for (const rendition of manifest.renditions) {
          protectedKeys.add(
            rendition.epoch === undefined
              ? `${root}/${rendition.id}/init`
              : `${root}/${rendition.id}/epoch/${rendition.epoch}/init`,
          );
          for (const segment of rendition.segments) {
            const sequence = Number(
              Array.isArray(segment) ? segment[0] : segment.sequence,
            );
            const timelineTimeMs = Number(
              Array.isArray(segment)
                ? segment[2]
                : segment.timelineTimeMs,
            );
            const durationMs = Math.max(
              1,
              Number(
                Array.isArray(segment) ? segment[3] : segment.durationMs,
              ) || 1,
            );
            if (
              timelineTimeMs + durationMs >= protectedStart &&
              timelineTimeMs <= protectedEnd
            ) {
              protectedKeys.add(`${root}/${rendition.id}/${sequence}`);
            }
          }
        }
      }
    }
    return protectedKeys;
  }

  rewriteManifestWithoutSegment(segment) {
    const manifestKey =
      `${segment.room}/${segment.sessionId}/${segment.assetId}/` +
      `${segment.mediaVersion}/manifest`;
    const manifestRecord = this.records.get(manifestKey);
    if (!manifestRecord) return true;
    let manifest = manifestRecord.manifest;
    if (!manifest) {
      try {
        manifest = validateManifest(
          readFileSync(manifestRecord.filePath),
          manifestRecord,
        );
      } catch {
        return false;
      }
    }
    let removed = false;
    const discardedSequences = new Set();
    const playbackTimeMs =
      Number.isFinite(Number(manifest.playbackTimeMs))
        ? Number(manifest.playbackTimeMs)
        : Math.max(0, Number(manifest.startTimeTicks) || 0) / 10_000;
    const targetRendition = manifest.renditions.find(
      (rendition) => rendition.id === segment.rendition,
    );
    const targetEntry = targetRendition?.segments.find(
      (entry) =>
        Number(Array.isArray(entry) ? entry[0] : entry.sequence) ===
        segment.sequence,
    );
    const segmentTimelineTimeMs = Number.isFinite(
      Number(segment.timelineTimeMs),
    )
      ? Number(segment.timelineTimeMs)
      : Number(
          Array.isArray(targetEntry)
            ? targetEntry[2]
            : targetEntry?.timelineTimeMs,
        );
    const segmentDurationMs = Number.isFinite(Number(segment.durationMs))
      ? Number(segment.durationMs)
      : Number(
          Array.isArray(targetEntry)
            ? targetEntry[3]
            : targetEntry?.durationMs,
        );
    const trimPrefix =
      segmentTimelineTimeMs +
        Math.max(1, segmentDurationMs || 1) <
      playbackTimeMs - ACTIVE_REWIND_PIN_MS;
    const trimSuffix =
      segmentTimelineTimeMs >
      playbackTimeMs + ACTIVE_FORWARD_PIN_MS;
    // Keep the currently playable window contiguous. Capacity reclamation may
    // advance either edge, but it never punches a hole through the middle.
    if (!trimPrefix && !trimSuffix) return false;
    const targetReferenced = targetRendition?.segments.some(
      (entry) =>
        Number(Array.isArray(entry) ? entry[0] : entry.sequence) ===
        segment.sequence,
    );
    if (!targetReferenced) return true;
    const evictionRevision =
      Math.max(0, Number(manifest.evictionRevision) || 0) + 1;
    const priorTombstone = (manifest.tombstones || []).find(
      (item) => item.renditionId === segment.rendition,
    );
    const tombstone = {
      ...(priorTombstone || {}),
      renditionId: segment.rendition,
      ...(trimPrefix
        ? {
            throughSequence: Math.max(
              Number(priorTombstone?.throughSequence) || 0,
              segment.sequence,
            ),
          }
        : {}),
      ...(trimSuffix
        ? {
            fromSequence: Math.min(
              Number(priorTombstone?.fromSequence) ||
                Number.MAX_SAFE_INTEGER,
              segment.sequence,
            ),
          }
        : {}),
      evictionRevision,
    };
    const nextManifest = {
      ...manifest,
      updatedAt: Date.now(),
      revision: Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(1, Number(manifest.revision) || 1) + 1,
      ),
      evictionRevision,
      ...(trimSuffix ? { ended: false } : {}),
      tombstones: [
        ...(manifest.tombstones || []).filter(
          (item) => item.renditionId !== segment.rendition,
        ),
        tombstone,
      ],
      renditions: manifest.renditions.map((rendition) => {
        if (rendition.id !== segment.rendition) return rendition;
        const segments = rendition.segments.filter((entry) => {
          const sequence = Number(Array.isArray(entry) ? entry[0] : entry.sequence);
          const discard = trimPrefix
            ? sequence <= segment.sequence
            : sequence >= segment.sequence;
          if (discard) {
            removed = true;
            discardedSequences.add(sequence);
          }
          return !discard;
        });
        return {
          ...rendition,
          segments,
          ...(trimSuffix
            ? {
                ended: false,
                finalSequence: undefined,
                finalTimelineEndMs: undefined,
              }
            : {}),
        };
      }),
    };
    if (!removed) return true;
    const body = Buffer.from(JSON.stringify(nextManifest));
    if (body.length > MAX_MANIFEST_BYTES) return false;
    const temporaryPath =
      `${manifestRecord.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, body, { mode: 0o600 });
      renameSync(temporaryPath, manifestRecord.filePath);
    } catch {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // A failed atomic manifest rewrite means the segment stays pinned.
      }
      return false;
    }
    this.diskBytes += body.length - manifestRecord.bytes;
    if (manifestRecord.buffer) {
      this.memoryBytes -= manifestRecord.buffer.byteLength;
    }
    manifestRecord.bytes = body.length;
    manifestRecord.sha256 = createHash("sha256").update(body).digest("hex");
    manifestRecord.etag = `"${manifestRecord.sha256}"`;
    manifestRecord.buffer = body;
    manifestRecord.manifest = nextManifest;
    this.memoryBytes += body.byteLength;
    this.markManifestObjectsAdvertised(manifestRecord);
    for (const [key, record] of [...this.records]) {
      if (
        key === segment.key ||
        record.kind !== "segment" ||
        record.room !== segment.room ||
        record.sessionId !== segment.sessionId ||
        record.assetId !== segment.assetId ||
        record.mediaVersion !== segment.mediaVersion ||
        record.rendition !== segment.rendition ||
        !discardedSequences.has(record.sequence)
      ) {
        continue;
      }
      this.records.delete(key);
      this.diskBytes = Math.max(0, this.diskBytes - record.bytes);
      if (record.buffer) {
        this.memoryBytes = Math.max(
          0,
          this.memoryBytes - record.buffer.byteLength,
        );
      }
      try {
        unlinkSync(record.filePath);
      } catch {
        // The coordinated tombstone already removed this immutable object
        // from the manifest; an open reader may retain its descriptor.
      }
    }
    return true;
  }

  removeRecord(key, record, protectedKeys) {
    if (protectedKeys.has(key)) return false;
    if (
      record.kind === "segment" &&
      !this.rewriteManifestWithoutSegment(record)
    ) {
      return false;
    }
    this.records.delete(key);
    this.diskBytes -= record.bytes;
    if (record.buffer) this.memoryBytes -= record.buffer.byteLength;
    try {
      unlinkSync(record.filePath);
    } catch {
      // Concurrent readers retain an already-open descriptor. The index no
      // longer advertises this record, so a later sweep can clean leftovers.
    }
    return true;
  }

  evict(targetBytes, extraProtectedKeys = new Set()) {
    if (this.memoryBytes > this.maxMemoryBytes) {
      for (const record of this.records.values()) {
        if (this.memoryBytes <= this.maxMemoryBytes) break;
        if (!record.buffer || record.kind === "manifest") continue;
        this.memoryBytes -= record.buffer.byteLength;
        record.buffer = undefined;
      }
    }
    const target = Number.isFinite(Number(targetBytes))
      ? Math.max(
          0,
          Math.min(this.maxDiskBytes, Math.floor(Number(targetBytes))),
        )
      : Math.floor(this.maxDiskBytes * 0.9);
    if (this.diskBytes <= this.maxDiskBytes && this.diskBytes <= target) {
      return;
    }
    const protectedKeys = this.protectedActiveKeys(
      Date.now(),
      extraProtectedKeys,
    );
    for (const [key, record] of this.records) {
      if (this.diskBytes <= target) break;
      if (record.kind === "manifest" || record.kind === "init") continue;
      this.removeRecord(key, record, protectedKeys);
    }
    // Inactive sessions may be deleted as a unit. Active session identity,
    // rather than a mutable lastAccess guess, controls protection.
    for (const [key, record] of this.records) {
      if (this.diskBytes <= target) break;
      this.removeRecord(key, record, protectedKeys);
    }
    this.scheduleIndex();
  }

  deleteRoom(room) {
    for (const [key, record] of this.records) {
      if (record.room !== room) continue;
      this.records.delete(key);
      this.diskBytes -= record.bytes;
      if (record.buffer) this.memoryBytes -= record.buffer.byteLength;
      try {
        unlinkSync(record.filePath);
      } catch {
        // Best effort cleanup; the budget pass will retry on future writes.
      }
    }
    for (const [key, entry] of this.activeSessions) {
      if (entry.room === room) this.activeSessions.delete(key);
    }
    this.scheduleIndex();
  }

  scheduleIndex() {
    if (this.closed || this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined;
      this.writeIndex();
    }, INDEX_WRITE_DELAY_MS);
    this.indexTimer.unref?.();
  }

  writeIndex() {
    if (this.closed) return;
    const indexPath = path.join(this.rootDir, "index.json");
    const temporaryPath = `${indexPath}.${randomUUID()}.tmp`;
    const records = [...this.records.values()].map(
      ({
        buffer: _buffer,
        filePath: _filePath,
        manifest: _manifest,
        ...record
      }) => record,
    );
    try {
      writeFileSync(
        temporaryPath,
        JSON.stringify({ version: 1, records }),
        { mode: 0o600 },
      );
      renameSync(temporaryPath, indexPath);
    } catch {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Cache metadata is recoverable.
      }
    }
  }

  snapshot() {
    return {
      objects: this.records.size,
      diskBytes: this.diskBytes,
      memoryBytes: this.memoryBytes,
      maxDiskBytes: this.maxDiskBytes,
      maxMemoryBytes: this.maxMemoryBytes,
      activeSessions: this.activeSessions.size,
      storagePressure: this.isStoragePressured(),
    };
  }

  isStoragePressured() {
    return (
      this.diskBytes >= this.maxDiskBytes ||
      Date.now() - this.lastAdmissionRejectedAt <=
        UNADVERTISED_UPLOAD_GRACE_MS
    );
  }

  async close() {
    if (this.closed) return;
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = undefined;
    }
    await this.mutationQueue;
    this.writeIndex();
    this.closed = true;
  }
}

async function receiveUpload(request, store, route) {
  const maximum =
    route.kind === "manifest"
      ? MAX_MANIFEST_BYTES
      : route.kind === "subtitle"
        ? MAX_SUBTITLE_BYTES
        : MAX_SEGMENT_BYTES;
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && (declared < 0 || declared > maximum)) {
    throw Object.assign(new Error("payload-too-large"), { statusCode: 413 });
  }
  const temporaryPath = store.createUploadPath();
  const output = createWriteStream(temporaryPath, {
    flags: "wx",
    mode: 0o600,
  });
  const hash = createHash("sha256");
  let bytes = 0;
  let idleTimer;
  const refreshIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      request.destroy(Object.assign(new Error("upload-idle"), {
        statusCode: 408,
      }));
    }, UPLOAD_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  refreshIdle();
  try {
    for await (const chunk of request) {
      refreshIdle();
      bytes += chunk.byteLength;
      if (bytes > maximum) {
        throw Object.assign(new Error("payload-too-large"), {
          statusCode: 413,
        });
      }
      hash.update(chunk);
      if (!output.write(chunk)) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            output.off("drain", drained);
            output.off("error", failed);
            output.off("close", closed);
          };
          const drained = () => {
            cleanup();
            resolve();
          };
          const failed = (error) => {
            cleanup();
            reject(error);
          };
          const closed = () => {
            cleanup();
            reject(new Error("segment-upload-output-closed"));
          };
          output.once("drain", drained);
          output.once("error", failed);
          output.once("close", closed);
        });
      }
    }
    await new Promise((resolve, reject) => {
      output.end(resolve);
      output.once("error", reject);
    });
    const manifest =
      route.kind === "manifest"
        ? validateManifest(await readFile(temporaryPath), route)
        : undefined;
    return {
      temporaryPath,
      bytes,
      sha256: hash.digest("hex"),
      manifest,
    };
  } catch (error) {
    output.destroy();
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(idleTimer);
  }
}

function responseHeaders(origin) {
  return {
    "access-control-allow-origin": origin || "null",
    "access-control-allow-headers":
      "authorization, content-type, if-none-match, range, x-content-sha256, x-synced-media-time-ms, x-synced-timeline-time-ms, x-synced-duration-ms, x-synced-keyframe, x-synced-bitrate",
    "access-control-allow-methods": "GET, HEAD, PUT, OPTIONS",
    "access-control-expose-headers":
      "accept-ranges, content-length, content-range, etag, x-synced-media-time-ms, x-synced-timeline-time-ms, x-synced-duration-ms, x-synced-keyframe, x-synced-bitrate, x-synced-manifest-revision, x-synced-eviction-revision, x-synced-storage-pressure",
    vary: "Origin",
    "x-content-type-options": "nosniff",
  };
}

function sendEmpty(response, statusCode, headers = {}) {
  response.writeHead(statusCode, {
    ...headers,
    "content-length": "0",
  });
  response.end();
}

function sendJson(response, statusCode, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  response.end(body);
}

export function createSegmentRelay(options = {}) {
  const store =
    options.store ||
    new SegmentRelayStore({
      rootDir: options.rootDir,
      maxDiskBytes: options.maxDiskBytes,
      maxMemoryBytes: options.maxMemoryBytes,
    });
  const secret = Buffer.from(
    options.secret || randomBytes(48).toString("base64url"),
  );
  const now = typeof options.now === "function" ? options.now : Date.now;
  const authorizeIdentity =
    typeof options.authorizeIdentity === "function"
      ? options.authorizeIdentity
      : () => true;
  const originAllowed =
    typeof options.originAllowed === "function"
      ? options.originAllowed
      : () => true;

  const sign = (payload) =>
    createHmac("sha256", secret)
      .update(`${TOKEN_VERSION}.${payload}`)
      .digest("base64url");

  const issueToken = ({ room, clientId, scope, lifetimeMs }) => {
    if (
      !ROOM_PATTERN.test(String(room || "").toUpperCase()) ||
      !String(clientId || "") ||
      !["read", "publish"].includes(scope)
    ) {
      throw new TypeError("invalid segment relay token scope");
    }
    const issuedAt = now();
    const expiresAt =
      issuedAt +
      boundedInteger(
        lifetimeMs,
        TOKEN_LIFETIME_MS,
        60_000,
        MAX_TOKEN_LIFETIME_MS,
      );
    const payload = encodeBase64Url(
      JSON.stringify({
        room: String(room).toUpperCase(),
        clientId: String(clientId),
        scope,
        iat: issuedAt,
        exp: expiresAt,
        nonce: randomUUID(),
      }),
    );
    return {
      basePath: SEGMENT_RELAY_BASE_PATH,
      token: `${TOKEN_VERSION}.${payload}.${sign(payload)}`,
      scope,
      expiresAt,
    };
  };

  const validateToken = (token, route, requiredScope) => {
    const [version, payload, signature, extra] = String(token || "").split(".");
    if (
      version !== TOKEN_VERSION ||
      !payload ||
      !signature ||
      extra !== undefined ||
      !safeTimingEqual(signature, sign(payload))
    ) {
      return undefined;
    }
    let parsed;
    try {
      parsed = JSON.parse(decodeBase64Url(payload));
    } catch {
      return undefined;
    }
    if (
      parsed?.room !== route.room ||
      !String(parsed?.clientId || "") ||
      !["read", "publish"].includes(parsed?.scope) ||
      Number(parsed?.iat) > now() + 30_000 ||
      Number(parsed?.exp) <= now() ||
      Number(parsed?.exp) - Number(parsed?.iat) > MAX_TOKEN_LIFETIME_MS ||
      (requiredScope === "publish" && parsed.scope !== "publish") ||
      !authorizeIdentity(parsed, requiredScope)
    ) {
      return undefined;
    }
    return parsed;
  };

  const handle = async (request, response, requestUrl) => {
    const route = relayRoute(requestUrl.pathname);
    if (route === undefined) return false;
    const origin = String(request.headers.origin || "");
    const corsHeaders = responseHeaders(
      origin && originAllowed(origin) ? origin : "null",
    );
    if (route === null) {
      sendEmpty(response, 400, corsHeaders);
      return true;
    }
    const method = String(request.method || "GET").toUpperCase();
    if (method === "OPTIONS") {
      if (origin && !originAllowed(origin)) {
        sendEmpty(response, 403, corsHeaders);
      } else {
        sendEmpty(response, 204, {
          ...corsHeaders,
          "access-control-max-age": "600",
        });
      }
      return true;
    }
    if (origin && !originAllowed(origin)) {
      sendEmpty(response, 403, corsHeaders);
      return true;
    }
    const token =
      String(request.headers.authorization || "").match(
        /^Bearer\s+([A-Za-z0-9._~-]+)$/i,
      )?.[1] || "";
    const requiredScope = method === "PUT" ? "publish" : "read";
    if (!validateToken(token, route, requiredScope)) {
      sendEmpty(response, 403, corsHeaders);
      return true;
    }

    if (method === "PUT") {
      if (!["manifest", "subtitle", "init", "segment"].includes(route.kind)) {
        sendEmpty(response, 405, corsHeaders);
        return true;
      }
      let upload;
      try {
        upload = await receiveUpload(request, store, route);
        const suppliedHash = String(
          request.headers["x-content-sha256"] || "",
        ).toLowerCase();
        if (suppliedHash && !safeTimingEqual(suppliedHash, upload.sha256)) {
          await unlink(upload.temporaryPath).catch(() => undefined);
          sendEmpty(response, 422, corsHeaders);
          return true;
        }
        const record = await store.commit(
          route,
          upload.temporaryPath,
          upload.bytes,
          {
            sha256: upload.sha256,
            mediaTimeMs: Number(
              request.headers["x-synced-media-time-ms"],
            ),
            timelineTimeMs: Number(
              request.headers["x-synced-timeline-time-ms"],
            ),
            durationMs: Number(request.headers["x-synced-duration-ms"]),
            keyframe:
              String(request.headers["x-synced-keyframe"]) === "true",
            bitrate: Number(request.headers["x-synced-bitrate"]),
            manifest: upload.manifest,
          },
        );
        response.writeHead(201, {
          ...corsHeaders,
          etag: record.etag,
          ...(record.kind === "manifest"
            ? {
                "x-synced-manifest-revision": String(
                  Math.max(1, Number(record.manifest?.revision) || 1),
                ),
                "x-synced-eviction-revision": String(
                  Math.max(
                    0,
                    Number(record.manifest?.evictionRevision) || 0,
                  ),
                ),
              }
            : {}),
          "x-synced-storage-pressure": String(
            store.isStoragePressured(),
          ),
          "content-length": "0",
        });
        response.end();
      } catch (error) {
        if (upload?.temporaryPath) {
          await unlink(upload.temporaryPath).catch(() => undefined);
        }
        const statusCode = boundedInteger(
          error?.statusCode,
          500,
          400,
          599,
        );
        if (error?.relayBody) {
          sendJson(response, statusCode, error.relayBody, {
            ...corsHeaders,
            ...(error.relayBody.etag
              ? { etag: error.relayBody.etag }
              : {}),
            "x-synced-manifest-revision": String(
              Math.max(0, Number(error.relayBody.revision) || 0),
            ),
            "x-synced-eviction-revision": String(
              Math.max(
                0,
                Number(error.relayBody.evictionRevision) || 0,
              ),
            ),
            "x-synced-storage-pressure": String(
              error.relayBody.storagePressure === true ||
                store.isStoragePressured(),
            ),
          });
        } else {
          sendEmpty(response, statusCode, corsHeaders);
        }
      }
      return true;
    }

    if (!["GET", "HEAD"].includes(method)) {
      sendEmpty(response, 405, {
        ...corsHeaders,
        allow: "GET, HEAD, PUT, OPTIONS",
      });
      return true;
    }
    const record = store.get(route.key);
    if (!record) {
      sendEmpty(response, 404, corsHeaders);
      return true;
    }
    if (request.headers["if-none-match"] === record.etag) {
      sendEmpty(response, 304, {
        ...corsHeaders,
        etag: record.etag,
      });
      return true;
    }
    const range = parseRange(request.headers.range, record.bytes);
    if (range === null) {
      sendEmpty(response, 416, {
        ...corsHeaders,
        "content-range": `bytes */${record.bytes}`,
      });
      return true;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, record.bytes - 1);
    const contentLength = record.bytes ? end - start + 1 : 0;
    const headers = {
      ...corsHeaders,
      "accept-ranges": "bytes",
      "cache-control":
        route.kind === "manifest"
          ? "no-store"
          : "private, max-age=31536000, immutable",
      "content-type": record.contentType,
      "content-length": String(contentLength),
      etag: record.etag,
      ...(route.kind === "manifest"
        ? {
            "x-synced-manifest-revision": String(
              Math.max(1, Number(record.manifest?.revision) || 1),
            ),
            "x-synced-eviction-revision": String(
              Math.max(
                0,
                Number(record.manifest?.evictionRevision) || 0,
              ),
            ),
          }
        : {}),
      "x-synced-storage-pressure": String(
        store.isStoragePressured(),
      ),
      ...(range
        ? { "content-range": `bytes ${start}-${end}/${record.bytes}` }
        : {}),
      ...(Number.isFinite(record.mediaTimeMs)
        ? { "x-synced-media-time-ms": String(record.mediaTimeMs) }
        : {}),
      ...(Number.isFinite(record.durationMs)
        ? { "x-synced-duration-ms": String(record.durationMs) }
        : {}),
      ...(Number.isFinite(record.timelineTimeMs)
        ? {
            "x-synced-timeline-time-ms": String(record.timelineTimeMs),
          }
        : {}),
      ...(route.kind === "segment"
        ? { "x-synced-keyframe": String(record.keyframe === true) }
        : {}),
      ...(Number.isFinite(record.bitrate)
        ? { "x-synced-bitrate": String(record.bitrate) }
        : {}),
    };
    response.writeHead(range ? 206 : 200, headers);
    if (method === "HEAD" || record.bytes === 0) {
      response.end();
      return true;
    }
    if (record.buffer) {
      response.end(record.buffer.subarray(start, end + 1));
      return true;
    }
    const stream = createReadStream(record.filePath, { start, end });
    try {
      await pipeline(stream, response);
    } catch {
      response.destroy();
    }
    return true;
  };

  return {
    handle,
    issueToken,
    snapshot: () => store.snapshot(),
    activateSession: (room, sessionId) =>
      store.activateSession(room, sessionId),
    deactivateSession: (room, sessionId) =>
      store.deactivateSession(room, sessionId),
    deleteRoom: (room) => store.deleteRoom(room),
    close: () => store.close(),
    store,
  };
}
