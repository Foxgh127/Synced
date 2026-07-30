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
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
  const root = `${value.room}/${value.assetId}/${value.mediaVersion}`;
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
    parts[4] !== "assets" ||
    parts[6] !== "versions"
  ) {
    return undefined;
  }
  const room = String(parts[3] || "").toUpperCase();
  const assetId = String(parts[5] || "").toLowerCase();
  const mediaVersion = Number(parts[7]);
  if (
    !ROOM_PATTERN.test(room) ||
    !ASSET_PATTERN.test(assetId) ||
    !Number.isSafeInteger(mediaVersion) ||
    mediaVersion < 1 ||
    mediaVersion > 0xffffffff
  ) {
    return null;
  }
  const root = { room, assetId, mediaVersion };
  if (parts.length === 9 && parts[8] === "manifest.json") {
    return {
      ...root,
      kind: "manifest",
      key: `${room}/${assetId}/${mediaVersion}/manifest`,
    };
  }
  if (parts.length === 9 && parts[8] === "subtitle.vtt") {
    return {
      ...root,
      kind: "subtitle",
      key: `${room}/${assetId}/${mediaVersion}/subtitle`,
    };
  }
  if (
    parts[8] !== "renditions" ||
    !RENDITION_PATTERN.test(String(parts[9] || ""))
  ) {
    return null;
  }
  const rendition = parts[9];
  if (parts.length === 11 && parts[10] === "init.mp4") {
    return {
      ...root,
      rendition,
      kind: "init",
      key: `${room}/${assetId}/${mediaVersion}/${rendition}/init`,
    };
  }
  const sequenceMatch =
    parts.length === 12 &&
    parts[10] === "segments" &&
    String(parts[11] || "").match(/^(\d+)\.m4s$/);
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
    key: `${room}/${assetId}/${mediaVersion}/${rendition}/${sequence}`,
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
    manifest.assetId !== route.assetId ||
    Number(manifest.mediaVersion) !== route.mediaVersion ||
    typeof manifest.sessionId !== "string" ||
    manifest.sessionId.length < 1 ||
    manifest.sessionId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(manifest.sessionId) ||
    !Array.isArray(manifest.renditions) ||
    manifest.renditions.length < 1 ||
    manifest.renditions.length > 8
  ) {
    throw Object.assign(new Error("manifest-schema"), { statusCode: 400 });
  }
  const versionRoot =
    `${SEGMENT_RELAY_BASE_PATH}/rooms/${route.room}/assets/${route.assetId}/` +
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
      !Array.isArray(rendition?.segments) ||
      rendition.segments.length > 100_000
    ) {
      throw Object.assign(new Error("manifest-rendition"), {
        statusCode: 400,
      });
    }
    renditionIds.add(rendition.id);
    const segmentSequences = new Set();
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
    this.diskBytes = 0;
    this.memoryBytes = 0;
    this.indexTimer = undefined;
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
          lastAccess: Number(value.lastAccess) || Date.now(),
        };
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
    if (this.closed) throw new Error("segment-store-closed");
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
    await rename(temporaryPath, filePath).catch(async (error) => {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await unlink(filePath).catch(() => undefined);
      await rename(temporaryPath, filePath);
    });
    if (existing) {
      this.diskBytes -= existing.bytes;
      if (existing.buffer) this.memoryBytes -= existing.buffer.byteLength;
    }
    const record = {
      key: route.key,
      room: route.room,
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
      durationMs: metadata.durationMs,
      keyframe: metadata.keyframe,
      bitrate: metadata.bitrate,
      fileName,
      filePath,
      lastAccess: Date.now(),
      buffer: undefined,
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
    this.evict();
    this.scheduleIndex();
    return record;
  }

  get(key) {
    const record = this.records.get(key);
    if (!record) return undefined;
    record.lastAccess = Date.now();
    this.records.delete(key);
    this.records.set(key, record);
    return record;
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
    const protectedMetadata = new Set();
    const currentManifestByAsset = new Map();
    for (const [key, record] of this.records) {
      if (record.kind !== "manifest") continue;
      const assetKey = `${record.room}/${record.assetId}`;
      const current = currentManifestByAsset.get(assetKey);
      if (!current || record.lastAccess > current.record.lastAccess) {
        currentManifestByAsset.set(assetKey, { key, record });
      }
    }
    for (const { key, record: manifest } of currentManifestByAsset.values()) {
      protectedMetadata.add(key);
      for (const [candidateKey, candidate] of this.records) {
        if (
          candidate.room === manifest.room &&
          candidate.assetId === manifest.assetId &&
          candidate.mediaVersion === manifest.mediaVersion &&
          (candidate.kind === "init" || candidate.kind === "subtitle")
        ) {
          protectedMetadata.add(candidateKey);
        }
      }
    }
    const removeRecord = (key, record) => {
      this.records.delete(key);
      this.diskBytes -= record.bytes;
      if (record.buffer) this.memoryBytes -= record.buffer.byteLength;
      try {
        unlinkSync(record.filePath);
      } catch {
        // Concurrent readers keep their open descriptor on supported systems.
      }
    };
    for (const [key, record] of this.records) {
      if (this.diskBytes <= targetBytes) break;
      if (record.kind === "manifest" || record.kind === "init") continue;
      if (protectedMetadata.has(key)) continue;
      removeRecord(key, record);
    }
    // Old versions must not accumulate unbounded manifests and init segments.
    // The newest manifest plus its decoding metadata remain protected.
    for (const [key, record] of this.records) {
      if (this.diskBytes <= targetBytes) break;
      if (protectedMetadata.has(key)) continue;
      removeRecord(key, record);
    }
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
      ({ buffer: _buffer, filePath: _filePath, ...record }) => record,
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
    };
  }

  async close() {
    if (this.closed) return;
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = undefined;
    }
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
    if (route.kind === "manifest") {
      validateManifest(await readFile(temporaryPath), route);
    }
    return {
      temporaryPath,
      bytes,
      sha256: hash.digest("hex"),
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
      "authorization, content-type, range, x-content-sha256, x-synced-media-time-ms, x-synced-duration-ms, x-synced-keyframe, x-synced-bitrate",
    "access-control-allow-methods": "GET, HEAD, PUT, OPTIONS",
    "access-control-expose-headers":
      "accept-ranges, content-length, content-range, etag, x-synced-media-time-ms, x-synced-duration-ms, x-synced-keyframe, x-synced-bitrate",
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
            durationMs: Number(request.headers["x-synced-duration-ms"]),
            keyframe:
              String(request.headers["x-synced-keyframe"]) === "true",
            bitrate: Number(request.headers["x-synced-bitrate"]),
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
    deleteRoom: (room) => store.deleteRoom(room),
    close: () => store.close(),
    store,
  };
}
