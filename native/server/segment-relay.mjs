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
  if (value.kind === "init") return `${root}/${value.rendition}/init`;
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
    !Array.isArray(manifest.renditions) ||
    manifest.renditions.length < 1 ||
    manifest.renditions.length > 8
  ) {
    throw Object.assign(new Error("manifest-schema"), { statusCode: 400 });
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
    if (
      !RENDITION_PATTERN.test(String(rendition?.id || "")) ||
      renditionIds.has(rendition.id) ||
      rendition?.initPath !== `${renditionRoot}init.mp4` ||
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
    if (route.kind === "manifest") {
      this.validateManifestObjects(route, metadata.manifest);
    }
    const existing = this.records.get(route.key);
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
    if (record.kind === "manifest") this.noteManifest(record);
    this.evict();
    this.scheduleIndex();
    return record;
  }

  validateManifestObjects(route, manifest) {
    const root =
      `${route.room}/${route.sessionId}/${route.assetId}/` +
      `${route.mediaVersion}`;
    for (const rendition of manifest.renditions) {
      if (!this.records.has(`${root}/${rendition.id}/init`)) {
        throw Object.assign(new Error("manifest-init-missing"), {
          statusCode: 409,
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
          throw Object.assign(new Error("manifest-segment-missing"), {
            statusCode: 409,
          });
        }
      }
    }
    if (
      manifest.subtitle &&
      !this.records.has(`${root}/subtitle`)
    ) {
      throw Object.assign(new Error("manifest-subtitle-missing"), {
        statusCode: 409,
      });
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

  protectedActiveKeys(now = Date.now()) {
    const protectedKeys = new Set();
    for (const entry of this.activeSessions.values()) {
      for (const [version, expiresAt] of entry.previousVersions) {
        if (expiresAt <= now) entry.previousVersions.delete(version);
      }
      const versions = new Set(entry.previousVersions.keys());
      if (Number.isSafeInteger(entry.mediaVersion)) {
        versions.add(entry.mediaVersion);
      }
      const matchingManifests = [];
      for (const [key, record] of this.records) {
        if (
          record.room === entry.room &&
          record.sessionId === entry.sessionId &&
          record.kind === "manifest" &&
          (!versions.size || versions.has(record.mediaVersion))
        ) {
          protectedKeys.add(key);
          matchingManifests.push(record);
        }
      }
      if (!matchingManifests.length) {
        // Before the first manifest lands, retain the small in-flight object
        // set for the explicitly active session. A subsequent manifest gives
        // eviction an exact advertised window and playback anchor.
        for (const [key, record] of this.records) {
          if (
            record.room === entry.room &&
            record.sessionId === entry.sessionId &&
            (!versions.size || versions.has(record.mediaVersion))
          ) {
            protectedKeys.add(key);
          }
        }
        continue;
      }
      for (const manifestRecord of matchingManifests) {
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
        for (const rendition of manifest.renditions) {
          protectedKeys.add(`${root}/${rendition.id}/init`);
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
              timelineTimeMs + durationMs >= playbackTimeMs - 60_000 &&
              timelineTimeMs <= playbackTimeMs + 120_000
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
    const playbackTimeMs =
      Number.isFinite(Number(manifest.playbackTimeMs))
        ? Number(manifest.playbackTimeMs)
        : Math.max(0, Number(manifest.startTimeTicks) || 0) / 10_000;
    const trimPrefix =
      Number(segment.timelineTimeMs) < playbackTimeMs;
    const targetRendition = manifest.renditions.find(
      (rendition) => rendition.id === segment.rendition,
    );
    const targetReferenced = targetRendition?.segments.some(
      (entry) =>
        Number(Array.isArray(entry) ? entry[0] : entry.sequence) ===
        segment.sequence,
    );
    if (!targetReferenced) return true;
    const nextManifest = {
      ...manifest,
      updatedAt: Date.now(),
      renditions: manifest.renditions.map((rendition) => {
        if (rendition.id !== segment.rendition) return rendition;
        const segments = rendition.segments.filter((entry) => {
          const sequence = Number(Array.isArray(entry) ? entry[0] : entry.sequence);
          const discard = trimPrefix
            ? sequence <= segment.sequence
            : sequence >= segment.sequence;
          if (discard) removed = true;
          return !discard;
        });
        return {
          ...rendition,
          segments,
          ...(!trimPrefix
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

  evict() {
    if (this.memoryBytes > this.maxMemoryBytes) {
      for (const record of this.records.values()) {
        if (this.memoryBytes <= this.maxMemoryBytes) break;
        if (!record.buffer || record.kind === "manifest") continue;
        this.memoryBytes -= record.buffer.byteLength;
        record.buffer = undefined;
      }
    }
    if (this.diskBytes <= this.maxDiskBytes) return;
    const targetBytes = Math.floor(this.maxDiskBytes * 0.9);
    const protectedKeys = this.protectedActiveKeys();
    for (const [key, record] of this.records) {
      if (this.diskBytes <= targetBytes) break;
      if (record.kind === "manifest" || record.kind === "init") continue;
      this.removeRecord(key, record, protectedKeys);
    }
    // Inactive sessions may be deleted as a unit. Active session identity,
    // rather than a mutable lastAccess guess, controls protection.
    for (const [key, record] of this.records) {
      if (this.diskBytes <= targetBytes) break;
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
    };
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
      "accept-ranges, content-length, content-range, etag, x-synced-media-time-ms, x-synced-timeline-time-ms, x-synced-duration-ms, x-synced-keyframe, x-synced-bitrate",
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
          "content-length": "0",
        });
        response.end();
      } catch (error) {
        if (upload?.temporaryPath) {
          await unlink(upload.temporaryPath).catch(() => undefined);
        }
        sendEmpty(
          response,
          boundedInteger(error?.statusCode, 500, 400, 599),
          corsHeaders,
        );
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
