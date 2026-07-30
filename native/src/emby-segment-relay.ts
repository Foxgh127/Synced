import {
  type EmbyPlayerSession,
  EmbyMsePlayer,
} from "./emby-player";
import type {
  EmbySegmentSessionDescriptor,
  EmbyTransportFragment,
} from "./emby-transport";
import type { SegmentRelayAccess } from "./rtc";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 96 * MEBIBYTE;
const MANIFEST_URGENT_POLL_MS = 400;
const MANIFEST_CHANGED_POLL_MS = 650;
const MANIFEST_NORMAL_POLL_MS = 2_500;
const MANIFEST_DEEP_BUFFER_POLL_MS = 5_000;
const MANIFEST_FAILURE_MAX_BACKOFF_MS = 30_000;
const FETCH_HEADER_TIMEOUT_MS = 10_000;
const FETCH_BODY_IDLE_TIMEOUT_MS = 15_000;
const FETCH_RANGE_RETRIES = 2;
const ABR_UPGRADE_STABLE_MS = 20_000;
const ABR_UPGRADE_HOLD_MS = 20_000;
const WARM_WINDOW_SECONDS = 120;
const PREFETCH_BANDWIDTH_SHARE = 0.65;
const MAX_BACKGROUND_CACHE_MARKERS = 20_000;
const BACKGROUND_CACHE_MARKER_TRIM = 4_000;
const MAX_PERSISTED_CACHE_ENTRIES = 10_000;
const SEGMENT_GAP_EPSILON_MS = 250;

class EmbyRelayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly resource: "manifest" | "segment",
  ) {
    super(`${resource} request failed with HTTP ${status}`);
    this.name = "EmbyRelayHttpError";
  }
}

export function embyManifestPollDelayMs(
  bufferAheadSeconds: number,
  consecutiveFailures: number,
  manifestChanged: boolean,
): number {
  if (consecutiveFailures > 0) {
    return Math.min(
      MANIFEST_FAILURE_MAX_BACKOFF_MS,
      MANIFEST_CHANGED_POLL_MS *
        2 ** Math.min(6, consecutiveFailures - 1),
    );
  }
  if (bufferAheadSeconds < 5) return MANIFEST_URGENT_POLL_MS;
  if (manifestChanged && bufferAheadSeconds < 15) {
    return MANIFEST_CHANGED_POLL_MS;
  }
  if (bufferAheadSeconds >= 45) return MANIFEST_DEEP_BUFFER_POLL_MS;
  return MANIFEST_NORMAL_POLL_MS;
}

export interface EmbySegmentManifestEntry {
  sequence: number;
  mediaTimeMs: number;
  timelineTimeMs: number;
  durationMs: number;
  keyframe: boolean;
  bytes: number;
  path: string;
  sha256?: string;
}

export interface EmbyRenditionManifest {
  id: string;
  epoch: number;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  mimeType: string;
  switchGroup: string;
  initPath: string;
  segments: EmbySegmentManifestEntry[];
  ended?: boolean;
  finalSequence?: number;
  finalTimelineEndMs?: number;
}

export interface EmbySegmentManifest {
  protocol: "synced-cmaf-v1";
  roomId: string;
  sessionId: string;
  assetId: string;
  mediaVersion: number;
  revision: number;
  evictionRevision: number;
  tombstones: Array<{
    renditionId: string;
    throughSequence?: number;
    fromSequence?: number;
    evictionRevision: number;
  }>;
  title: string;
  startTimeTicks: number;
  runtimeTicks?: number;
  updatedAt: number;
  playbackTimeMs?: number;
  ended?: boolean;
  subtitle?: {
    path: string;
    language?: string;
    title?: string;
  };
  renditions: EmbyRenditionManifest[];
}

export interface EmbyAbrDiagnostics {
  active: boolean;
  renditionId?: string;
  renditionLabel?: string;
  renditionWidth?: number;
  renditionHeight?: number;
  renditionFrameRate?: number;
  renditionBitrate?: number;
  estimatedThroughputBps: number;
  stableSince?: number;
  fetchGeneration: number;
  cacheHits: number;
  networkFetches: number;
  rangeRetries: number;
  foregroundFetchBytes: number;
  backgroundFetchBytes: number;
  cacheStagingBytes: number;
  appendedSegments: number;
  warmedSegments: number;
  prefetchedSegments: number;
  upgradeFailures: number;
  relayFallbackActive: boolean;
  consecutiveRelayFailures: number;
  lastError?: string;
}

interface CachedEntry {
  key: string;
  bytes: number;
  lastAccess: number;
}

interface SegmentCacheLike {
  get(url: string): Promise<Uint8Array | undefined>;
  put(url: string, data: Uint8Array, headers?: Headers): Promise<void>;
  delete(url: string): Promise<void>;
  close(): Promise<void>;
  setMemoryBudget?(bytes: number): void;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildEmbySegmentRelayBaseUrl(
  signalUrl: string,
  access: SegmentRelayAccess,
): URL {
  const url = new URL(signalUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  else if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("分片服务地址无效");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  url.pathname = `${access.basePath.replace(/\/+$/u, "")}/`;
  return url;
}

export async function deriveEmbyAssetId(
  accountId: string | undefined,
  itemId: string,
  mediaSourceId: string | undefined,
): Promise<string> {
  const input = new TextEncoder().encode(
    `${accountId || "default"}\0${itemId}\0${mediaSourceId || "default"}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .slice(0, 20)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function manifestUrl(
  baseUrl: URL,
  roomId: string,
  descriptor: EmbySegmentSessionDescriptor,
): URL {
  const expected =
    `${baseUrl.pathname}rooms/${encodeURIComponent(roomId)}/sessions/` +
    `${encodeURIComponent(descriptor.sessionId)}/assets/` +
    `${descriptor.assetId}/versions/${descriptor.mediaVersion}/manifest.json`;
  const url = new URL(expected, baseUrl);
  if (
    url.origin !== baseUrl.origin ||
    !url.pathname.startsWith(baseUrl.pathname)
  ) {
    throw new Error("分片清单地址越界");
  }
  return url;
}

function mediaUrl(baseUrl: URL, value: string): URL {
  const url = new URL(value, baseUrl);
  if (
    url.origin !== baseUrl.origin ||
    !url.pathname.startsWith(baseUrl.pathname)
  ) {
    throw new Error("分片地址越界");
  }
  return url;
}

function validateSegment(
  value: unknown,
  inferredPath?: (sequence: number) => string,
): EmbySegmentManifestEntry | undefined {
  const input: Partial<EmbySegmentManifestEntry> = Array.isArray(value)
    ? {
        sequence: value[0],
        mediaTimeMs: value[1],
        timelineTimeMs: value[2],
        durationMs: value[3],
        keyframe: value[4] === 1 || value[4] === true,
        bytes: value[5],
        sha256: value[6],
      }
    : (value as Partial<EmbySegmentManifestEntry>);
  const sequence = Number(input?.sequence);
  const segment: EmbySegmentManifestEntry = {
    sequence,
    mediaTimeMs: Number(input?.mediaTimeMs),
    timelineTimeMs: Number(input?.timelineTimeMs),
    durationMs: Number(input?.durationMs),
    keyframe: input?.keyframe === true,
    bytes: Number(input?.bytes),
    path: String(input?.path || inferredPath?.(sequence) || ""),
    sha256:
      typeof input?.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(input.sha256)
        ? input.sha256
        : undefined,
  };
  if (
    !Number.isSafeInteger(segment.sequence) ||
    segment.sequence < 1 ||
    !Number.isFinite(segment.mediaTimeMs) ||
    segment.mediaTimeMs < 0 ||
    !Number.isFinite(segment.timelineTimeMs) ||
    segment.timelineTimeMs < 0 ||
    !Number.isFinite(segment.durationMs) ||
    segment.durationMs < 0 ||
    segment.durationMs > 60_000 ||
    !Number.isSafeInteger(segment.bytes) ||
    segment.bytes < 0 ||
    segment.bytes > MAX_SEGMENT_BYTES ||
    !segment.path ||
    segment.path.length > 2_048
  ) {
    return undefined;
  }
  return segment;
}

export function parseEmbySegmentManifest(
  value: unknown,
  expected: {
    roomId: string;
    assetId: string;
    mediaVersion: number;
    sessionId?: string;
  },
): EmbySegmentManifest {
  const input = value as Partial<EmbySegmentManifest>;
  if (
    input?.protocol !== "synced-cmaf-v1" ||
    input.roomId !== expected.roomId ||
    input.assetId !== expected.assetId ||
    Number(input.mediaVersion) !== expected.mediaVersion ||
    (expected.sessionId !== undefined &&
      input.sessionId !== expected.sessionId) ||
    typeof input.sessionId !== "string" ||
    input.sessionId.length < 1 ||
    input.sessionId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(input.sessionId) ||
    !Array.isArray(input.renditions) ||
    input.renditions.length < 1 ||
    input.renditions.length > 8
  ) {
    throw new Error("分片清单身份不匹配");
  }
  const renditions: EmbyRenditionManifest[] = [];
  const versionRoot =
    `/media/v1/rooms/${expected.roomId}/sessions/${input.sessionId}/` +
    `assets/${expected.assetId}/` +
    `versions/${expected.mediaVersion}/`;
  const renditionIds = new Set<string>();
  for (const candidate of input.renditions) {
    const rendition = candidate as Partial<EmbyRenditionManifest>;
    const renditionId = String(rendition.id || "");
    const epoch =
      rendition.epoch === undefined ? 1 : Number(rendition.epoch);
    const initPath = String(rendition.initPath || "");
    const renditionRoot = `${versionRoot}renditions/${renditionId}/`;
    const expectedInitPath =
      rendition.epoch === undefined
        ? `${renditionRoot}init.mp4`
        : `${renditionRoot}epochs/${epoch}/init.mp4`;
    const segments = Array.isArray(rendition.segments)
      ? rendition.segments
          .map((segment) =>
            validateSegment(
              segment,
              (sequence) =>
                `${renditionRoot}segments/${sequence}.m4s`,
            ),
          )
          .filter(
            (segment): segment is EmbySegmentManifestEntry =>
              Boolean(
                segment &&
                  segment.path ===
                    `${renditionRoot}segments/${segment.sequence}.m4s`,
              ),
          )
          .sort(
            (left, right) =>
              left.timelineTimeMs - right.timelineTimeMs ||
              left.sequence - right.sequence,
          )
      : [];
    if (
      !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(renditionId) ||
      renditionIds.has(renditionId) ||
      !Number.isSafeInteger(epoch) ||
      epoch < 1 ||
      epoch > 0xffffffff ||
      initPath !== expectedInitPath ||
      !String(rendition.mimeType || "").startsWith("video/mp4") ||
      !Number.isFinite(Number(rendition.bitrate)) ||
      Number(rendition.bitrate) <= 0 ||
      Number(rendition.bitrate) > 250_000_000 ||
      !Number.isFinite(Number(rendition.width)) ||
      Number(rendition.width) < 1 ||
      Number(rendition.width) > 16_384 ||
      !Number.isFinite(Number(rendition.height)) ||
      Number(rendition.height) < 1 ||
      Number(rendition.height) > 8_640 ||
      segments.length > 100_000
    ) {
      throw new Error("分片清单档位无效");
    }
    const uniqueSequences = new Set(
      segments.map((segment) => segment.sequence),
    );
    if (uniqueSequences.size !== segments.length) {
      throw new Error("分片清单包含重复序号");
    }
    if (
      segments.some(
        (segment, index) =>
          index > 0 &&
          segment.sequence !== segments[index - 1].sequence + 1,
      )
    ) {
      throw new Error("分片清单包含不连续序号");
    }
    renditionIds.add(renditionId);
    renditions.push({
      id: renditionId,
      epoch,
      label: String(rendition.label || rendition.id).slice(0, 80),
      width: Math.max(1, Math.floor(finite(rendition.width, 1))),
      height: Math.max(1, Math.floor(finite(rendition.height, 1))),
      frameRate: Math.max(1, Math.min(120, finite(rendition.frameRate, 30))),
      bitrate: Math.max(1, Math.floor(Number(rendition.bitrate))),
      mimeType: String(rendition.mimeType),
      switchGroup: String(rendition.switchGroup || rendition.mimeType).slice(
        0,
        120,
      ),
      initPath,
      segments,
      ended: rendition.ended === true,
      finalSequence:
        Number.isSafeInteger(Number(rendition.finalSequence)) &&
        Number(rendition.finalSequence) >= 1
          ? Number(rendition.finalSequence)
          : undefined,
      finalTimelineEndMs:
        Number.isFinite(Number(rendition.finalTimelineEndMs)) &&
        Number(rendition.finalTimelineEndMs) >= 0
          ? Number(rendition.finalTimelineEndMs)
          : undefined,
    });
  }
  return {
    protocol: "synced-cmaf-v1",
    roomId: expected.roomId,
    sessionId: String(input.sessionId || "").slice(0, 128),
    assetId: expected.assetId,
    mediaVersion: expected.mediaVersion,
    revision: Math.max(1, Math.floor(finite(input.revision, 1))),
    evictionRevision: Math.max(
      0,
      Math.floor(finite(input.evictionRevision, 0)),
    ),
    tombstones: Array.isArray(input.tombstones)
      ? input.tombstones
          .map((value) => ({
            renditionId: String(value?.renditionId || ""),
            ...(value?.throughSequence === undefined
              ? {}
              : { throughSequence: Number(value.throughSequence) }),
            ...(value?.fromSequence === undefined
              ? {}
              : { fromSequence: Number(value.fromSequence) }),
            evictionRevision: Number(value?.evictionRevision),
          }))
          .filter(
            (value) =>
              /^[a-z0-9][a-z0-9-]{0,31}$/u.test(value.renditionId) &&
              ((Number.isSafeInteger(value.throughSequence) &&
                Number(value.throughSequence) >= 1) ||
                (Number.isSafeInteger(value.fromSequence) &&
                  Number(value.fromSequence) >= 1)) &&
              !(
                Number.isSafeInteger(value.throughSequence) &&
                Number.isSafeInteger(value.fromSequence) &&
                Number(value.throughSequence) >=
                  Number(value.fromSequence)
              ) &&
              Number.isSafeInteger(value.evictionRevision) &&
              value.evictionRevision >= 1,
          )
          .slice(0, 16)
      : [],
    title: String(input.title || "Emby 影片").slice(0, 300),
    startTimeTicks: Math.max(0, finite(input.startTimeTicks)),
    runtimeTicks:
      input.runtimeTicks === undefined
        ? undefined
        : Math.max(0, finite(input.runtimeTicks)),
    updatedAt: Math.max(0, finite(input.updatedAt)),
    playbackTimeMs:
      input.playbackTimeMs === undefined
        ? undefined
        : Math.max(0, finite(input.playbackTimeMs)),
    ended: input.ended === true,
    subtitle:
      input.subtitle &&
      typeof input.subtitle === "object" &&
      input.subtitle.path === `${versionRoot}subtitle.vtt`
        ? {
            path: input.subtitle.path,
            language:
              typeof input.subtitle.language === "string"
                ? input.subtitle.language.slice(0, 24)
                : undefined,
            title:
              typeof input.subtitle.title === "string"
                ? input.subtitle.title.slice(0, 160)
                : undefined,
          }
        : undefined,
    renditions,
  };
}

function lowerBoundSegmentTimeline(
  segments: EmbySegmentManifestEntry[],
  timelineTimeMs: number,
): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].timelineTimeMs < timelineTimeMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function embySegmentTimelineWindow(
  segments: EmbySegmentManifestEntry[],
  startMs: number,
  endMs: number,
): EmbySegmentManifestEntry[] {
  if (!segments.length || endMs < startMs) return [];
  let index = lowerBoundSegmentTimeline(segments, startMs);
  while (
    index > 0 &&
    segments[index - 1].timelineTimeMs +
      Math.max(1, segments[index - 1].durationMs) >=
      startMs
  ) {
    index -= 1;
  }
  const window: EmbySegmentManifestEntry[] = [];
  for (; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.timelineTimeMs > endMs) break;
    if (
      segment.timelineTimeMs + Math.max(1, segment.durationMs) >=
      startMs
    ) {
      window.push(segment);
    }
  }
  return window;
}

export function selectEmbyAbrRendition(
  renditions: EmbyRenditionManifest[],
  input: {
    throughputBps: number;
    preferredHeight?: number;
    currentId?: string;
    bufferAheadSeconds: number;
    stableForMs: number;
    upgradeHoldRemainingMs: number;
    upgradeFailureCount?: number;
  },
): EmbyRenditionManifest {
  const ordered = [...renditions].sort(
    (left, right) =>
      left.bitrate - right.bitrate || left.height - right.height,
  );
  const current = ordered.find((item) => item.id === input.currentId);
  const preferredHeight = Math.max(
    1,
    finite(input.preferredHeight, Number.POSITIVE_INFINITY),
  );
  const headroom =
    input.bufferAheadSeconds < 5
      ? 2
      : input.bufferAheadSeconds < 15
        ? 1.7
        : 1.5;
  const safeBitrate = Math.max(0, input.throughputBps / headroom);
  const eligible = ordered.filter(
    (item) =>
      item.bitrate <= safeBitrate &&
      item.height <= preferredHeight &&
      (item.id !== "original" ||
        (input.bufferAheadSeconds >= 20 &&
          input.throughputBps >= item.bitrate * 1.5)),
  );
  let selected =
    eligible.at(-1) ||
    ordered.find((item) => item.height <= preferredHeight) ||
    ordered[0];
  if (!current) return selected;
  if (selected.bitrate < current.bitrate) return selected;
  if (selected.bitrate === current.bitrate) return current;
  if (
    input.stableForMs <
      Math.min(
        60_000,
        ABR_UPGRADE_STABLE_MS +
          Math.max(0, finite(input.upgradeFailureCount)) * 10_000,
      ) ||
    input.upgradeHoldRemainingMs > 0 ||
    input.throughputBps < selected.bitrate * 1.5
  ) {
    return current;
  }
  const currentIndex = ordered.indexOf(current);
  return ordered[Math.min(ordered.indexOf(selected), currentIndex + 1)];
}

export function updateEmbyThroughputEstimate(
  currentBps: number,
  measuredBps: number,
  intentionallyThrottled = false,
): number {
  const current = Math.max(1, finite(currentBps, 1));
  const measured = finite(measuredBps);
  if (intentionallyThrottled || measured <= 0) return current;
  return current * 0.72 + measured * 0.28;
}

class BrowserSegmentCache implements SegmentCacheLike {
  private readonly entries = new Map<string, CachedEntry>();
  private readonly memory = new Map<string, Uint8Array>();
  private bytes = 0;
  private memoryBytes = 0;
  private budgetBytes = 256 * MEBIBYTE;
  private memoryBudgetBytes = 8 * MEBIBYTE;
  private cachePromise?: Promise<Cache | undefined>;
  private metadataPromise?: Promise<IDBDatabase | undefined>;
  private backgroundIndexStarted = false;
  private closed = false;

  constructor(
    private readonly cacheStorage: CacheStorage | undefined =
      globalThis.caches,
  ) {}

  setMemoryBudget(bytes: number): void {
    this.memoryBudgetBytes = Math.max(
      0,
      Math.min(64 * MEBIBYTE, Math.floor(finite(bytes))),
    );
    void this.evictMemory();
  }

  private openCache(): Promise<Cache | undefined> {
    if (this.cachePromise) return this.cachePromise;
    this.cachePromise = this.cacheStorage
      ? this.cacheStorage
          .open("synced-emby-segments-v1")
          .then((cache) => {
            this.startBackgroundIndex(cache);
            return cache;
          })
          .catch(() => undefined)
      : Promise.resolve(undefined);
    return this.cachePromise;
  }

  private startBackgroundIndex(cache: Cache): void {
    if (this.backgroundIndexStarted || this.closed) return;
    this.backgroundIndexStarted = true;
    void (async () => {
      try {
        const estimate = await navigator.storage?.estimate?.();
        const quota = finite(estimate?.quota);
        if (quota > 0) {
          const available = Math.max(0, quota - finite(estimate?.usage));
          this.budgetBytes = Math.min(
            5 * GIBIBYTE,
            Math.floor(available * 0.04),
          );
        }
      } catch {
        // The conservative fallback remains bounded.
      }
      const persisted = await this.readMetadata();
      if (persisted.length) {
        for (const entry of persisted) {
          const current = this.entries.get(entry.key);
          if (!current || current.lastAccess < entry.lastAccess) {
            this.entries.set(entry.key, entry);
          }
        }
        this.recalculateBytes();
        const retained = new Set(this.entries.keys());
        const keys = await cache.keys();
        await Promise.all(
          keys
            .filter((request) => !retained.has(request.url))
            .map((request) => cache.delete(request)),
        );
      } else {
        // Migration from the original CacheStorage-only index happens in the
        // background. A foreground exact match never waits for this scan.
        const keys = await cache.keys();
        const discarded = keys.slice(
          0,
          Math.max(0, keys.length - MAX_PERSISTED_CACHE_ENTRIES),
        );
        await Promise.all(discarded.map((request) => cache.delete(request)));
        const kept = keys.slice(-MAX_PERSISTED_CACHE_ENTRIES);
        for (let offset = 0; offset < kept.length; offset += 32) {
          await Promise.all(
            kept.slice(offset, offset + 32).map(async (request) => {
              const response = await cache.match(request);
              if (!response) return;
              const entry = {
                key: request.url,
                bytes: Math.max(
                  0,
                  finite(response.headers.get("content-length")),
                ),
                lastAccess: Math.max(
                  0,
                  finite(response.headers.get("x-synced-cached-at")),
                ) || Date.now(),
              };
              const current = this.entries.get(entry.key);
              if (!current || current.lastAccess <= entry.lastAccess) {
                this.entries.set(entry.key, entry);
                void this.persistMetadata(entry);
              }
            }),
          );
        }
        this.recalculateBytes();
      }
      await this.pruneMetadataCount();
      await this.evict(cache);
    })().catch(() => undefined);
  }

  private openMetadata(): Promise<IDBDatabase | undefined> {
    if (this.metadataPromise) return this.metadataPromise;
    if (typeof globalThis.indexedDB === "undefined") {
      this.metadataPromise = Promise.resolve(undefined);
      return this.metadataPromise;
    }
    this.metadataPromise = new Promise((resolve) => {
      const request = globalThis.indexedDB.open(
        "synced-emby-cache-index-v1",
        1,
      );
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("entries")) {
          const store = database.createObjectStore("entries", {
            keyPath: "key",
          });
          store.createIndex("lastAccess", "lastAccess");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
      request.onblocked = () => resolve(undefined);
    });
    return this.metadataPromise;
  }

  private async readMetadata(): Promise<CachedEntry[]> {
    const database = await this.openMetadata();
    if (!database) return [];
    return new Promise((resolve) => {
      const transaction = database.transaction("entries", "readonly");
      const entries: CachedEntry[] = [];
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve(entries.sort((left, right) => left.lastAccess - right.lastAccess));
      };
      const request = transaction
        .objectStore("entries")
        .index("lastAccess")
        .openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || entries.length >= MAX_PERSISTED_CACHE_ENTRIES) {
          finish();
          return;
        }
        const entry = cursor.value as Partial<CachedEntry>;
        if (
          typeof entry?.key === "string" &&
          Number.isFinite(entry.bytes) &&
          Number.isFinite(entry.lastAccess)
        ) {
          entries.push({
            key: entry.key,
            bytes: Number(entry.bytes),
            lastAccess: Number(entry.lastAccess),
          });
        }
        cursor.continue();
      };
      request.onerror = finish;
      transaction.onabort = finish;
      transaction.oncomplete = finish;
    });
  }

  private async pruneMetadataCount(): Promise<void> {
    const database = await this.openMetadata();
    if (!database) return;
    await new Promise<void>((resolve) => {
      const transaction = database.transaction("entries", "readwrite");
      const request = transaction
        .objectStore("entries")
        .index("lastAccess")
        .openCursor(null, "prev");
      let count = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        count += 1;
        if (count > MAX_PERSISTED_CACHE_ENTRIES) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  }

  private async persistMetadata(entry: CachedEntry): Promise<void> {
    const database = await this.openMetadata();
    if (!database || this.closed) return;
    await new Promise<void>((resolve) => {
      const transaction = database.transaction("entries", "readwrite");
      transaction.objectStore("entries").put(entry);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  }

  private async deleteMetadata(key: string): Promise<void> {
    const database = await this.openMetadata();
    if (!database) return;
    await new Promise<void>((resolve) => {
      const transaction = database.transaction("entries", "readwrite");
      transaction.objectStore("entries").delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  }

  private recalculateBytes(): void {
    this.bytes = [...this.entries.values()].reduce(
      (total, entry) => total + Math.max(0, entry.bytes),
      0,
    );
  }

  async get(url: string): Promise<Uint8Array | undefined> {
    const memory = this.memory.get(url);
    if (memory) {
      this.touch(url, memory.byteLength);
      return memory.slice();
    }
    const cache = await this.openCache();
    const response = await cache?.match(url);
    if (!response) return undefined;
    const data = new Uint8Array(await response.arrayBuffer());
    this.touch(url, data.byteLength);
    return data;
  }

  async put(url: string, data: Uint8Array, headers?: Headers): Promise<void> {
    this.touch(url, data.byteLength);
    const cache = await this.openCache();
    if (cache) {
      const responseHeaders = new Headers(headers);
      responseHeaders.set("content-length", String(data.byteLength));
      responseHeaders.set("x-synced-cached-at", String(Date.now()));
      await cache.put(
        url,
        new Response(data.slice(), { headers: responseHeaders }),
      );
    } else {
      const previous = this.memory.get(url);
      if (previous) {
        this.memoryBytes = Math.max(
          0,
          this.memoryBytes - previous.byteLength,
        );
      }
      if (data.byteLength <= this.memoryBudgetBytes) {
        const retained = data.slice();
        this.memory.set(url, retained);
        this.memoryBytes += retained.byteLength;
      } else {
        this.memory.delete(url);
        const entry = this.entries.get(url);
        if (entry) {
          this.entries.delete(url);
          this.bytes = Math.max(0, this.bytes - entry.bytes);
          await this.deleteMetadata(url);
        }
      }
    }
    await this.evictMemory();
    await this.evict(cache);
  }

  async delete(url: string): Promise<void> {
    const previous = this.entries.get(url);
    if (previous) {
      this.entries.delete(url);
      this.bytes = Math.max(0, this.bytes - previous.bytes);
    }
    const memory = this.memory.get(url);
    if (memory) {
      this.memoryBytes = Math.max(0, this.memoryBytes - memory.byteLength);
      this.memory.delete(url);
    }
    const cache = await this.openCache();
    await Promise.all([
      cache?.delete(url),
      this.deleteMetadata(url),
    ]);
  }

  private touch(key: string, bytes: number): void {
    const previous = this.entries.get(key);
    if (previous) this.bytes = Math.max(0, this.bytes - previous.bytes);
    this.bytes += bytes;
    this.entries.delete(key);
    const entry = { key, bytes, lastAccess: Date.now() };
    this.entries.set(key, entry);
    void this.persistMetadata(entry);
  }

  private async evict(cache?: Cache): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (
        this.bytes <= this.budgetBytes &&
        this.entries.size <= MAX_PERSISTED_CACHE_ENTRIES
      ) {
        break;
      }
      this.entries.delete(key);
      this.bytes = Math.max(0, this.bytes - entry.bytes);
      const memory = this.memory.get(key);
      if (memory) {
        this.memoryBytes = Math.max(
          0,
          this.memoryBytes - memory.byteLength,
        );
        this.memory.delete(key);
      }
      await Promise.all([
        cache?.delete(key),
        this.deleteMetadata(key),
      ]);
    }
  }

  private async evictMemory(): Promise<void> {
    if (this.memoryBytes <= this.memoryBudgetBytes) return;
    for (const [key, entry] of this.entries) {
      if (this.memoryBytes <= this.memoryBudgetBytes) break;
      const memory = this.memory.get(key);
      if (!memory) continue;
      this.memory.delete(key);
      this.memoryBytes = Math.max(0, this.memoryBytes - memory.byteLength);
      this.entries.delete(key);
      this.bytes = Math.max(0, this.bytes - entry.bytes);
      await this.deleteMetadata(key);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.memory.clear();
    this.memoryBytes = 0;
    this.entries.clear();
    this.bytes = 0;
    const database = await this.openMetadata();
    database?.close();
  }
}

function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  const abort = () => child.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function abortableDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class EmbyAbrSegmentClient {
  private access: SegmentRelayAccess;
  private baseUrl: URL;
  private descriptor?: EmbySegmentSessionDescriptor;
  private session?: EmbyPlayerSession;
  private controller?: AbortController;
  private mediaFetchController?: AbortController;
  private backgroundFetchController?: AbortController;
  private unlinkMediaFetchAbort?: () => void;
  private fetchGeneration = 0;
  private currentRendition?: EmbyRenditionManifest;
  private preferredHeight?: number;
  private throughputBps =
    Math.max(
      2_000_000,
      finite(
        (
          globalThis.navigator as Navigator & {
            connection?: { downlink?: number };
          }
        )?.connection?.downlink,
      ) * 1_000_000,
    ) || 8_000_000;
  private stableSince = performance.now();
  private upgradeHoldUntil = 0;
  private lastUpgradeAt = 0;
  private upgradeFailures = 0;
  private deliverySequence = 0;
  private appended = new Set<string>();
  private appendedTimelineEndMs = 0;
  private lastObservedPlaybackTime = 0;
  private lastRebufferAt = performance.now();
  private backgroundCaching = false;
  private foregroundFetchBytes = 0;
  private backgroundFetchBytes = 0;
  private cacheStagingBytes = 0;
  private readonly backgroundCached = new Set<string>();
  private readonly prefetchCursorByRendition = new Map<string, number>();
  private recoveryTargetTime?: number;
  private requiresKeyframe = true;
  private baselineNetworkRttMs?: number;
  private appliedSubtitlePath = "";
  private endedSignaled = false;
  private manifestEtag = "";
  private lastManifest?: EmbySegmentManifest;
  private consecutiveManifestFailures = 0;
  private relayFallbackActive = false;
  private relayFallbackRequested = false;
  private relayRecoverySuccesses = 0;
  private relayRecoveryNotified = false;
  private forceRenditionResync = false;
  private diagnosticsState: EmbyAbrDiagnostics = {
    active: false,
    estimatedThroughputBps: 0,
    fetchGeneration: 0,
    cacheHits: 0,
    networkFetches: 0,
    rangeRetries: 0,
    foregroundFetchBytes: 0,
    backgroundFetchBytes: 0,
    cacheStagingBytes: 0,
    appendedSegments: 0,
    warmedSegments: 0,
    prefetchedSegments: 0,
    upgradeFailures: 0,
    relayFallbackActive: false,
    consecutiveRelayFailures: 0,
  };
  private readonly handleSegmentRecovery = (event: Event): void => {
    const detail = (
      event as CustomEvent<{
        targetTime?: number;
        sessionId?: string;
        mediaVersion?: number;
      }>
    ).detail;
    if (
      !this.session ||
      detail?.sessionId !== this.session.sessionId ||
      Number(detail.mediaVersion) !== this.session.mediaVersion
    ) {
      return;
    }
    const targetTime = Math.max(0, finite(detail.targetTime));
    this.recoveryTargetTime = targetTime;
    this.fetchGeneration += 1;
    this.appended.clear();
    this.appendedTimelineEndMs = targetTime * 1_000;
    this.requiresKeyframe = true;
    this.lastObservedPlaybackTime = targetTime;
    const parent = this.controller?.signal;
    if (parent) this.renewMediaFetchController(parent);
  };

  constructor(
    private readonly options: {
      player: EmbyMsePlayer;
      signalUrl: string;
      access: SegmentRelayAccess;
      fetchImpl?: typeof fetch;
      cache?: SegmentCacheLike;
      onTokenExpiring?: () => void;
      onDiagnostic?: (diagnostics: EmbyAbrDiagnostics) => void;
      onMediaFallbackNeeded?: (detail: {
        targetTime: number;
        sessionId: string;
        mediaVersion: number;
        reason: string;
      }) => void;
      onRelayRecovered?: () => void;
    },
  ) {
    this.access = options.access;
    this.baseUrl = buildEmbySegmentRelayBaseUrl(
      options.signalUrl,
      this.access,
    );
    this.cache = options.cache || new BrowserSegmentCache();
    this.cache.setMemoryBudget?.(
      finite(
        this.options.player.bufferProfile.cacheStagingLimitBytes,
        8 * MEBIBYTE,
      ),
    );
    this.fetchImpl = options.fetchImpl || fetch;
    this.options.player.addEventListener?.(
      "segmentrecoveryneeded",
      this.handleSegmentRecovery,
    );
  }

  private readonly cache: SegmentCacheLike;
  private readonly fetchImpl: typeof fetch;

  private playerCanAcceptMediaBytes(bytes: number): boolean {
    const candidate = this.options.player as EmbyMsePlayer & {
      canAcceptMediaBytes?: (requestedBytes: number) => boolean;
    };
    return typeof candidate.canAcceptMediaBytes !== "function"
      ? true
      : candidate.canAcceptMediaBytes(bytes);
  }

  private syncExternalMediaMemoryUsage(): void {
    const candidate = this.options.player as EmbyMsePlayer & {
      setExternalMediaMemoryUsage?: (usage: {
        foregroundFetchBytes: number;
        cacheStagingBytes: number;
      }) => void;
    };
    candidate.setExternalMediaMemoryUsage?.({
      foregroundFetchBytes:
        this.foregroundFetchBytes + this.backgroundFetchBytes,
      cacheStagingBytes: this.cacheStagingBytes,
    });
  }

  private unifiedMediaBudgetAllows(additionalBytes: number): boolean {
    const budget = this.options.player.mediaBudget;
    if (
      !budget ||
      !Number.isFinite(budget.budgetBytes) ||
      !Number.isFinite(budget.estimatedTotalBytes)
    ) {
      return true;
    }
    return (
      budget.estimatedTotalBytes +
        Math.max(0, Math.ceil(finite(additionalBytes))) <=
      budget.budgetBytes
    );
  }

  get diagnostics(): EmbyAbrDiagnostics {
    return {
      ...this.diagnosticsState,
      estimatedThroughputBps: this.throughputBps,
      renditionId: this.currentRendition?.id,
      renditionLabel: this.currentRendition?.label,
      renditionWidth: this.currentRendition?.width,
      renditionHeight: this.currentRendition?.height,
      renditionFrameRate: this.currentRendition?.frameRate,
      renditionBitrate: this.currentRendition?.bitrate,
      fetchGeneration: this.fetchGeneration,
      stableSince: this.stableSince,
      foregroundFetchBytes: this.foregroundFetchBytes,
      backgroundFetchBytes: this.backgroundFetchBytes,
      cacheStagingBytes: this.cacheStagingBytes,
    };
  }

  updateAccess(access: SegmentRelayAccess): void {
    this.access = access;
    this.baseUrl = buildEmbySegmentRelayBaseUrl(
      this.options.signalUrl,
      access,
    );
  }

  setPreferredHeight(height?: number): void {
    this.preferredHeight =
      Number.isFinite(height) && Number(height) > 0
        ? Number(height)
        : undefined;
  }

  matchesSession(
    session: EmbyPlayerSession,
    descriptor: EmbySegmentSessionDescriptor,
  ): boolean {
    return (
      this.diagnosticsState.active &&
      this.session?.sessionId === session.sessionId &&
      this.session.mediaVersion === session.mediaVersion &&
      this.descriptor?.sessionId === descriptor.sessionId &&
      this.descriptor.assetId === descriptor.assetId &&
      this.descriptor.mediaVersion === descriptor.mediaVersion
    );
  }

  activateMediaFallback(): void {
    if (!this.session || !this.controller) return;
    this.relayFallbackActive = true;
    this.relayFallbackRequested = true;
    this.relayRecoverySuccesses = 0;
    this.relayRecoveryNotified = false;
    this.forceRenditionResync = false;
    this.diagnosticsState.relayFallbackActive = true;
    this.mediaFetchController?.abort("relay-media-fallback");
    this.backgroundFetchController?.abort("relay-media-fallback");
  }

  resumeHttps(): void {
    if (!this.session || !this.controller) return;
    this.relayFallbackActive = false;
    this.relayFallbackRequested = false;
    this.relayRecoverySuccesses = 0;
    this.relayRecoveryNotified = false;
    this.forceRenditionResync = true;
    this.consecutiveManifestFailures = 0;
    this.diagnosticsState.relayFallbackActive = false;
    this.diagnosticsState.consecutiveRelayFailures = 0;
    this.fetchGeneration += 1;
    this.recoveryTargetTime = Math.max(
      0,
      this.options.player.currentTime,
    );
    this.appended.clear();
    this.appendedTimelineEndMs = this.recoveryTargetTime * 1_000;
    this.requiresKeyframe = true;
    this.manifestEtag = "";
    this.renewMediaFetchController(this.controller.signal);
  }

  start(
    session: EmbyPlayerSession,
    descriptor: EmbySegmentSessionDescriptor,
  ): void {
    this.stop(false);
    this.session = { ...session };
    this.descriptor = { ...descriptor };
    this.controller = new AbortController();
    this.fetchGeneration += 1;
    this.renewMediaFetchController(this.controller.signal);
    this.deliverySequence = 0;
    this.appended.clear();
    this.backgroundCached.clear();
    this.requiresKeyframe = true;
    const requestedStartTime = Math.max(
      0,
      finite(session.plan.startTimeTicks) / 10_000_000,
      this.options.player.currentTime,
    );
    this.recoveryTargetTime =
      requestedStartTime > this.options.player.currentTime + 0.5
        ? requestedStartTime
        : undefined;
    this.appendedTimelineEndMs = requestedStartTime * 1_000;
    this.appliedSubtitlePath = "";
    this.endedSignaled = false;
    this.manifestEtag = "";
    this.lastManifest = undefined;
    this.consecutiveManifestFailures = 0;
    this.relayFallbackActive = false;
    this.relayFallbackRequested = false;
    this.relayRecoverySuccesses = 0;
    this.relayRecoveryNotified = false;
    this.forceRenditionResync = false;
    this.currentRendition = undefined;
    this.backgroundFetchController?.abort("replaced");
    this.backgroundFetchController = undefined;
    this.stableSince = performance.now();
    this.upgradeHoldUntil = 0;
    this.lastUpgradeAt = 0;
    this.upgradeFailures = 0;
    this.foregroundFetchBytes = 0;
    this.backgroundFetchBytes = 0;
    this.cacheStagingBytes = 0;
    this.syncExternalMediaMemoryUsage();
    this.lastObservedPlaybackTime = this.options.player.currentTime;
    this.diagnosticsState = {
      active: true,
      estimatedThroughputBps: this.throughputBps,
      fetchGeneration: this.fetchGeneration,
      cacheHits: 0,
      networkFetches: 0,
      rangeRetries: 0,
      foregroundFetchBytes: 0,
      backgroundFetchBytes: 0,
      cacheStagingBytes: 0,
      appendedSegments: 0,
      warmedSegments: 0,
      prefetchedSegments: 0,
      upgradeFailures: 0,
      relayFallbackActive: false,
      consecutiveRelayFailures: 0,
    };
    void this.run(this.controller.signal);
  }

  stop(closeCache = false): void {
    this.controller?.abort("replaced");
    this.mediaFetchController?.abort("replaced");
    this.backgroundFetchController?.abort("replaced");
    this.unlinkMediaFetchAbort?.();
    this.mediaFetchController = undefined;
    this.backgroundFetchController = undefined;
    this.unlinkMediaFetchAbort = undefined;
    this.controller = undefined;
    this.session = undefined;
    this.descriptor = undefined;
    this.currentRendition = undefined;
    this.foregroundFetchBytes = 0;
    this.backgroundFetchBytes = 0;
    this.cacheStagingBytes = 0;
    this.syncExternalMediaMemoryUsage();
    this.recoveryTargetTime = undefined;
    this.requiresKeyframe = true;
    this.backgroundCaching = false;
    this.relayFallbackActive = false;
    this.relayFallbackRequested = false;
    this.relayRecoverySuccesses = 0;
    this.relayRecoveryNotified = false;
    this.forceRenditionResync = false;
    this.diagnosticsState.active = false;
    if (closeCache) void this.cache.close();
  }

  destroy(): void {
    this.stop(true);
    this.options.player.removeEventListener?.(
      "segmentrecoveryneeded",
      this.handleSegmentRecovery,
    );
  }

  private renewMediaFetchController(parent: AbortSignal): AbortSignal {
    this.mediaFetchController?.abort("fetch-generation-replaced");
    this.unlinkMediaFetchAbort?.();
    const controller = new AbortController();
    this.mediaFetchController = controller;
    this.unlinkMediaFetchAbort = linkAbort(parent, controller);
    return controller.signal;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.session && this.descriptor) {
      let manifestChanged = false;
      try {
        if (this.access.expiresAt - Date.now() < 2 * 60_000) {
          this.options.onTokenExpiring?.();
        }
        const result = await this.fetchManifest(signal);
        const manifest = result.manifest;
        manifestChanged = result.changed;
        if (signal.aborted) return;
        if (this.relayFallbackActive) {
          const recovered = await this.probeRelayRecovery(manifest, signal);
          this.relayRecoverySuccesses = recovered
            ? this.relayRecoverySuccesses + 1
            : 0;
          if (
            this.relayRecoverySuccesses >= 3 &&
            !this.relayRecoveryNotified
          ) {
            this.relayRecoveryNotified = true;
            this.options.onRelayRecovered?.();
          }
        } else {
          await this.applyManifestSubtitle(manifest, signal);
          await this.fillPlaybackBuffer(manifest, signal);
          this.maybeCacheAhead(
            this.mediaFetchController?.signal || signal,
            this.fetchGeneration,
          );
        }
        this.diagnosticsState.lastError = undefined;
        this.consecutiveManifestFailures = 0;
        this.diagnosticsState.consecutiveRelayFailures = 0;
      } catch (error) {
        if (signal.aborted) return;
        this.diagnosticsState.lastError =
          error instanceof Error ? error.message : String(error);
        this.lastRebufferAt = performance.now();
        this.stableSince = performance.now();
        this.consecutiveManifestFailures = Math.min(
          20,
          this.consecutiveManifestFailures + 1,
        );
        this.diagnosticsState.consecutiveRelayFailures =
          this.consecutiveManifestFailures;
        if (
          this.consecutiveManifestFailures >= 3 &&
          !this.relayFallbackRequested &&
          this.session
        ) {
          this.relayFallbackRequested = true;
          this.options.onMediaFallbackNeeded?.({
            targetTime: Math.max(
              0,
              this.options.player.currentTime,
              this.recoveryTargetTime || 0,
            ),
            sessionId: this.session.sessionId,
            mediaVersion: this.session.mediaVersion,
            reason:
              error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.options.onDiagnostic?.(this.diagnostics);
      await abortableDelay(
        signal,
        embyManifestPollDelayMs(
          this.options.player.bufferedAhead,
          this.consecutiveManifestFailures,
          manifestChanged,
        ),
      );
    }
  }

  private async probeRelayRecovery(
    manifest: EmbySegmentManifest,
    signal: AbortSignal,
  ): Promise<boolean> {
    const rendition =
      manifest.renditions.find(
        (candidate) => candidate.id === this.currentRendition?.id,
      ) ||
      [...manifest.renditions].sort(
        (left, right) => left.bitrate - right.bitrate,
      )[0];
    if (!rendition) return false;
    const currentMs = Math.max(0, this.options.player.currentTime * 1_000);
    const segment =
      embySegmentTimelineWindow(
        rendition.segments,
        Math.max(0, currentMs - 2_000),
        currentMs + 30_000,
      ).find((candidate) => candidate.keyframe) ||
      rendition.segments.at(-1);
    if (!segment) return manifest.ended === true;
    const url = mediaUrl(this.baseUrl, segment.path);
    return this.withResponseDeadlines(
      url,
      {
        method: "HEAD",
        headers: {
          authorization: `Bearer ${this.access.token}`,
          accept: "video/iso.segment",
        },
        cache: "no-store",
      },
      signal,
      async (response) => {
        if (response.status === 401 || response.status === 403) {
          this.options.onTokenExpiring?.();
          return false;
        }
        return response.ok;
      },
    );
  }

  private async fetchManifest(
    signal: AbortSignal,
  ): Promise<{ manifest: EmbySegmentManifest; changed: boolean }> {
    if (!this.descriptor) throw new Error("分片会话尚未建立");
    const url = manifestUrl(
      this.baseUrl,
      this.session!.roomId,
      this.descriptor,
    );
    return this.withResponseDeadlines(
      url,
      {
        headers: {
          authorization: `Bearer ${this.access.token}`,
          accept: "application/json",
          ...(this.manifestEtag
            ? { "if-none-match": this.manifestEtag }
            : {}),
        },
        cache: "no-cache",
      },
      signal,
      async (response, controller) => {
        if (response.status === 304 && this.lastManifest) {
          return { manifest: this.lastManifest, changed: false };
        }
        if (response.status === 404) {
          throw new EmbyRelayHttpError(404, "manifest");
        }
        if (response.status === 401 || response.status === 403) {
          this.options.onTokenExpiring?.();
          throw new Error("分片访问凭证已过期");
        }
        if (!response.ok) {
          throw new Error(`分片清单请求失败（${response.status}）`);
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            while (true) {
              const read = await this.readWithIdleDeadline(
                reader,
                controller.signal,
                controller,
              );
              if (read.done) break;
              if (read.value?.byteLength) {
                size += read.value.byteLength;
                if (size > 2 * MEBIBYTE) {
                  throw new Error("分片清单异常过大");
                }
                chunks.push(read.value);
              }
            }
          } finally {
            reader.releaseLock();
          }
        } else {
          const chunk = new Uint8Array(await response.arrayBuffer());
          size = chunk.byteLength;
          chunks.push(chunk);
        }
        if (size > 2 * MEBIBYTE) {
          throw new Error("分片清单异常过大");
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const manifest = parseEmbySegmentManifest(
          JSON.parse(new TextDecoder().decode(bytes)),
          {
            roomId: this.session!.roomId,
            assetId: this.descriptor!.assetId,
            mediaVersion: this.descriptor!.mediaVersion,
            sessionId: this.session!.sessionId,
          },
        );
        this.manifestEtag = response.headers.get("etag") || "";
        this.lastManifest = manifest;
        return { manifest, changed: true };
      },
    );
  }

  private async fillPlaybackBuffer(
    manifest: EmbySegmentManifest,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.session || !manifest.renditions.length) return;
    const bufferProfile = this.options.player.bufferProfile;
    const mediaBudgetPressured =
      this.options.player.mediaBudget?.pressured === true;
    if (mediaBudgetPressured) {
      this.backgroundFetchController?.abort("media-budget-pressure");
    }
    const maxSegmentBytes = Math.max(
      1,
      finite(bufferProfile.maxSegmentBytes, MAX_SEGMENT_BYTES),
    );
    const supportedRenditions = manifest.renditions.filter(
      (rendition) =>
        (typeof globalThis.MediaSource === "undefined" ||
          typeof globalThis.MediaSource.isTypeSupported !== "function" ||
          globalThis.MediaSource.isTypeSupported(rendition.mimeType)) &&
        rendition.segments.every(
          (segment) => segment.bytes <= maxSegmentBytes,
        ),
    );
    if (!supportedRenditions.length) {
      throw new Error(
        "当前设备的解码能力或媒体内存预算不支持清单中的任何档位",
      );
    }
    const now = performance.now();
    const observedPlaybackTime = this.options.player.currentTime;
    if (
      this.recoveryTargetTime !== undefined &&
      Math.abs(observedPlaybackTime - this.recoveryTargetTime) <= 1 &&
      this.options.player.bufferedAhead > 0.25
    ) {
      this.recoveryTargetTime = undefined;
    }
    const currentTime =
      this.recoveryTargetTime ?? observedPlaybackTime;
    let fetchSignal = this.mediaFetchController?.signal || signal;
    if (
      this.recoveryTargetTime === undefined &&
      Math.abs(currentTime - this.lastObservedPlaybackTime) > 4
    ) {
      this.fetchGeneration += 1;
      this.appended.clear();
      this.appendedTimelineEndMs = Math.max(0, currentTime * 1_000);
      fetchSignal = this.renewMediaFetchController(signal);
    }
    this.lastObservedPlaybackTime = currentTime;
    const fetchGeneration = this.fetchGeneration;
    let selected = selectEmbyAbrRendition(supportedRenditions, {
      throughputBps: this.throughputBps,
      preferredHeight: this.preferredHeight,
      currentId: this.currentRendition?.id,
      bufferAheadSeconds: this.options.player.bufferedAhead,
      stableForMs: now - this.stableSince,
      upgradeHoldRemainingMs: Math.max(0, this.upgradeHoldUntil - now),
      upgradeFailureCount: this.upgradeFailures,
    });
    if (mediaBudgetPressured && this.currentRendition) {
      const ordered = [...supportedRenditions].sort(
        (left, right) =>
          left.bitrate - right.bitrate || left.height - right.height,
      );
      const currentIndex = ordered.findIndex(
        (candidate) => candidate.id === this.currentRendition?.id,
      );
      selected =
        currentIndex > 0
          ? ordered[currentIndex - 1]
          : ordered[0];
    }
    if (
      selected.id !== this.currentRendition?.id ||
      selected.epoch !== this.currentRendition?.epoch ||
      this.forceRenditionResync
    ) {
      const upgrading =
        !this.forceRenditionResync &&
        Boolean(this.currentRendition) &&
        selected.bitrate > this.currentRendition!.bitrate;
      const downgrading =
        !this.forceRenditionResync &&
        Boolean(this.currentRendition) &&
        selected.bitrate < this.currentRendition!.bitrate;
      await this.switchRendition(
        selected,
        fetchSignal,
        fetchGeneration,
      );
      this.forceRenditionResync = false;
      if (upgrading) {
        this.upgradeHoldUntil = now + ABR_UPGRADE_HOLD_MS;
        this.lastUpgradeAt = now;
      } else if (
        downgrading &&
        this.lastUpgradeAt > 0 &&
        now - this.lastUpgradeAt <= ABR_UPGRADE_HOLD_MS
      ) {
        this.upgradeFailures = Math.min(4, this.upgradeFailures + 1);
        this.diagnosticsState.upgradeFailures = this.upgradeFailures;
      }
      this.stableSince = now;
    } else {
      // Every manifest is a fresh immutable snapshot. Keep the selected
      // rendition object current so newly uploaded segments become visible.
      this.currentRendition = selected;
      if (
        this.upgradeFailures > 0 &&
        now - this.lastUpgradeAt >= 60_000 &&
        now - this.lastRebufferAt >= 60_000
      ) {
        this.upgradeFailures -= 1;
        this.diagnosticsState.upgradeFailures = this.upgradeFailures;
        this.lastUpgradeAt = now;
      }
    }
    const rendition = this.currentRendition;
    if (
      !rendition ||
      fetchSignal.aborted ||
      fetchGeneration !== this.fetchGeneration
    ) {
      return;
    }
    const targetSeconds = Math.max(
      1,
      Math.min(
        finite(bufferProfile.targetSeconds, 20),
        finite(
          bufferProfile.maxSeconds,
          finite(bufferProfile.targetSeconds, 20) + 2,
        ) - finite(bufferProfile.safetyMarginSeconds, 1),
      ),
    );
    const targetMs = (currentTime + targetSeconds) * 1_000;
    const startMs = Math.max(0, currentTime * 1_000 - 1_500);
    let candidates = embySegmentTimelineWindow(
      rendition.segments,
      startMs,
      targetMs,
    ).filter(
      (segment) =>
        segment.timelineTimeMs + Math.max(1, segment.durationMs) >=
          this.appendedTimelineEndMs &&
        !this.appended.has(
          `${rendition.id}:${rendition.epoch}:${segment.sequence}`,
        ),
    );
    if (this.requiresKeyframe) {
      const keyframeIndex = candidates.findIndex(
        (segment) => segment.keyframe,
      );
      if (keyframeIndex < 0) return;
      candidates = candidates.slice(keyframeIndex);
    }
    for (const segment of candidates) {
      if (
        fetchSignal.aborted ||
        fetchGeneration !== this.fetchGeneration ||
        this.options.player.bufferedAhead >= targetSeconds
      ) {
        break;
      }
      if (
        !this.requiresKeyframe &&
        this.appendedTimelineEndMs > 0 &&
        segment.timelineTimeMs >
          this.appendedTimelineEndMs + SEGMENT_GAP_EPSILON_MS
      ) {
        this.armManifestGapRecovery(
          `清单时间线存在 ${Math.round(
            segment.timelineTimeMs - this.appendedTimelineEndMs,
          )} ms 空洞`,
          currentTime,
        );
        throw new Error("分片清单存在时间空洞，已停止追加并刷新清单");
      }
      try {
        if (
          !(await this.waitForPlayerCapacity(
            segment.bytes,
            fetchSignal,
            fetchGeneration,
          ))
        ) {
          break;
        }
        const appended = await this.appendSegment(
          rendition,
          segment,
          fetchSignal,
          fetchGeneration,
        );
        if (!appended) break;
      } catch (error) {
        if (
          error instanceof EmbyRelayHttpError &&
          error.status === 404
        ) {
          this.armManifestGapRecovery(
            "清单引用的分片已不存在",
            currentTime,
          );
        }
        throw error;
      }
    }
    this.maybeMarkEnded(manifest, rendition);
    if (this.options.player.bufferedAhead < 1.5) {
      this.lastRebufferAt = now;
      this.stableSince = now;
    }
  }

  private armManifestGapRecovery(reason: string, targetTime: number): void {
    this.manifestEtag = "";
    this.lastManifest = undefined;
    this.requiresKeyframe = true;
    this.recoveryTargetTime = Math.max(0, targetTime);
    this.appendedTimelineEndMs = Math.max(0, targetTime * 1_000);
    this.stableSince = performance.now();
    this.diagnosticsState.lastError = reason;
  }

  private maybeMarkEnded(
    manifest: EmbySegmentManifest,
    rendition: EmbyRenditionManifest,
  ): void {
    if (
      this.endedSignaled ||
      !manifest.ended ||
      !rendition.ended ||
      this.requiresKeyframe
    ) {
      return;
    }
    const finalSequence = rendition.finalSequence;
    const finalTimelineEndMs = rendition.finalTimelineEndMs;
    const finalAppended =
      finalSequence === undefined ||
      this.appended.has(
        `${rendition.id}:${rendition.epoch}:${finalSequence}`,
      );
    const timelineComplete =
      finalTimelineEndMs === undefined ||
      this.appendedTimelineEndMs + 50 >= finalTimelineEndMs;
    if (!finalAppended || !timelineComplete) return;
    this.endedSignaled = true;
    // HTTPS delivery has its own rendition-local sequence space. RTC fragment
    // boundaries are intentionally ignored; the authoritative CMAF manifest
    // closes MSE only after this rendition's final segment is appended.
    this.options.player.markEnded();
  }

  private async applyManifestSubtitle(
    manifest: EmbySegmentManifest,
    signal: AbortSignal,
  ): Promise<void> {
    const subtitle = manifest.subtitle;
    if (
      !subtitle ||
      subtitle.path === this.appliedSubtitlePath ||
      signal.aborted
    ) {
      return;
    }
    const url = mediaUrl(this.baseUrl, subtitle.path);
    const data = await this.fetchMediaBytes(
      url,
      undefined,
      signal,
      false,
    );
    if (data.byteLength > 12 * MEBIBYTE) {
      throw new Error("字幕文件异常过大");
    }
    this.options.player.applySubtitle(new TextDecoder().decode(data));
    this.appliedSubtitlePath = subtitle.path;
  }

  private async switchRendition(
    rendition: EmbyRenditionManifest,
    signal: AbortSignal,
    fetchGeneration: number,
  ): Promise<void> {
    if (!this.session) return;
    const initUrl = mediaUrl(this.baseUrl, rendition.initPath);
    const init = await this.fetchMediaBytes(
      initUrl,
      undefined,
      signal,
      true,
    );
    if (signal.aborted || fetchGeneration !== this.fetchGeneration) return;
    const previous = this.currentRendition;
    const needsMediaSourceRebuild =
      !previous ||
      previous.mimeType !== rendition.mimeType ||
      previous.switchGroup !== rendition.switchGroup ||
      this.options.player.activeSession?.mimeType !== rendition.mimeType;
    const plan = {
      ...this.session.plan,
      width: rendition.width,
      height: rendition.height,
      frameRate: rendition.frameRate,
      bitrate: rendition.bitrate,
    };
    this.session = {
      ...this.session,
      mimeType: rendition.mimeType,
      plan,
    };
    // configure() updates the ABR plan and buffer budget in place when the
    // codec is compatible, and rebuilds MediaSource only when the P2P
    // emergency stream used a different MIME type.
    this.options.player.configure(this.session);
    this.cache.setMemoryBudget?.(
      finite(
        this.options.player.bufferProfile.cacheStagingLimitBytes,
        8 * MEBIBYTE,
      ),
    );
    if (needsMediaSourceRebuild) {
      this.deliverySequence = 0;
      this.appended.clear();
      this.appendedTimelineEndMs = Math.max(
        0,
        this.options.player.currentTime * 1_000,
      );
    }
    if (
      !(await this.waitForPlayerCapacity(
        init.byteLength,
        signal,
        fetchGeneration,
      )) ||
      this.options.player.appendInit(init) === false
    ) {
      throw new Error("媒体追加队列处于背压状态");
    }
    this.currentRendition = rendition;
    this.requiresKeyframe = true;
  }

  private async waitForPlayerCapacity(
    bytes: number,
    signal: AbortSignal,
    fetchGeneration: number,
  ): Promise<boolean> {
    const requested = Math.max(0, Math.floor(finite(bytes)));
    if (
      requested <= 0 ||
      requested >
        finite(
          this.options.player.bufferProfile.maxSegmentBytes,
          MAX_SEGMENT_BYTES,
        )
    ) {
      return false;
    }
    const deadline = performance.now() + 5_000;
    while (
      !signal.aborted &&
      fetchGeneration === this.fetchGeneration &&
      !this.playerCanAcceptMediaBytes(requested)
    ) {
      if (performance.now() >= deadline) return false;
      await abortableDelay(signal, 50);
    }
    return (
      !signal.aborted &&
      fetchGeneration === this.fetchGeneration &&
      this.playerCanAcceptMediaBytes(requested)
    );
  }

  private async appendSegment(
    rendition: EmbyRenditionManifest,
    segment: EmbySegmentManifestEntry,
    signal: AbortSignal,
    fetchGeneration: number,
  ): Promise<boolean> {
    const key = `${rendition.id}:${rendition.epoch}:${segment.sequence}`;
    const url = mediaUrl(this.baseUrl, segment.path);
    const data = await this.fetchMediaBytes(
      url,
      segment,
      signal,
      false,
    );
    if (
      signal.aborted ||
      fetchGeneration !== this.fetchGeneration ||
      !this.session ||
      this.currentRendition?.id !== rendition.id ||
      this.currentRendition?.epoch !== rendition.epoch
    ) {
      return false;
    }
    if (
      !(await this.waitForPlayerCapacity(
        data.byteLength,
        signal,
        fetchGeneration,
      ))
    ) {
      return false;
    }
    const fragment: EmbyTransportFragment = {
      roomId: this.session.roomId,
      sessionId: this.session.sessionId,
      mediaVersion: this.session.mediaVersion,
      transportEpoch: this.session.transportEpoch ?? 0,
      sequence: ++this.deliverySequence,
      timestampMs: Date.now(),
      mediaTimeMs: segment.mediaTimeMs,
      timelineTimeMs: segment.timelineTimeMs,
      trackType: "muxed",
      keyframe: segment.keyframe,
      data,
    };
    if (this.options.player.appendFragment(fragment) === false) return false;
    if (this.requiresKeyframe && segment.keyframe) {
      this.requiresKeyframe = false;
    }
    this.appended.add(key);
    this.appendedTimelineEndMs = Math.max(
      this.appendedTimelineEndMs,
      segment.timelineTimeMs + Math.max(1, segment.durationMs),
    );
    if (this.appended.size > 10_000) {
      const iterator = this.appended.values();
      for (let index = 0; index < 2_000; index += 1) {
        const oldest = iterator.next();
        if (oldest.done) break;
        this.appended.delete(oldest.value);
      }
    }
    this.diagnosticsState.appendedSegments += 1;
    return true;
  }

  private maybeCacheAhead(
    signal: AbortSignal,
    fetchGeneration: number,
  ): void {
    if (
      this.backgroundCaching ||
      signal.aborted ||
      !this.currentRendition ||
      this.options.player.mediaBudget?.pressured === true
    ) {
      return;
    }
    const rendition = this.currentRendition;
    const currentMs =
      (this.recoveryTargetTime ?? this.options.player.currentTime) * 1_000;
    const warmEndMs = currentMs + WARM_WINDOW_SECONDS * 1_000;
    const segmentKey = (segment: EmbySegmentManifestEntry): string =>
      `${rendition.id}:${rendition.epoch}:${segment.sequence}`;
    const warmStartMs =
      currentMs +
      Math.max(
        1,
        finite(this.options.player.bufferProfile.targetSeconds, 20),
      ) * 1_000;
    const warmSegment = embySegmentTimelineWindow(
      rendition.segments,
      warmStartMs,
      warmEndMs,
    ).find(
      (candidate) =>
        !this.appended.has(segmentKey(candidate)) &&
        !this.backgroundCached.has(segmentKey(candidate)),
    );
    const warmAllowed =
      this.options.player.bufferedAhead >= 10 &&
      this.throughputBps >= rendition.bitrate * 1.2;
    const prefetchAllowed =
      performance.now() - this.lastRebufferAt >= 20_000 &&
      this.throughputBps >= rendition.bitrate * 1.5 &&
      this.connectionAllowsPrefetch();
    let prefetchIndex = -1;
    let prefetchSegment: EmbySegmentManifestEntry | undefined;
    if (prefetchAllowed && !(warmAllowed && warmSegment)) {
      const firstDeepIndex = lowerBoundSegmentTimeline(
        rendition.segments,
        warmEndMs + 0.001,
      );
      prefetchIndex = Math.max(
        firstDeepIndex,
        this.prefetchCursorByRendition.get(rendition.id) ??
          firstDeepIndex,
      );
      while (prefetchIndex < rendition.segments.length) {
        const candidate = rendition.segments[prefetchIndex];
        if (
          !this.appended.has(segmentKey(candidate)) &&
          !this.backgroundCached.has(segmentKey(candidate))
        ) {
          prefetchSegment = candidate;
          break;
        }
        prefetchIndex += 1;
      }
    }
    const segment =
      (warmAllowed ? warmSegment : undefined) || prefetchSegment;
    if (!segment) return;
    const profile = this.options.player.bufferProfile;
    if (
      segment.bytes >
        finite(profile.maxSegmentBytes, MAX_SEGMENT_BYTES) ||
      this.foregroundFetchBytes +
        this.backgroundFetchBytes +
        segment.bytes >
        finite(profile.foregroundFetchLimitBytes, 32 * MEBIBYTE)
    ) {
      return;
    }
    const priority = segment.timelineTimeMs <= warmEndMs ? "warm" : "prefetch";
    const prefetchRateLimitBps =
      priority === "prefetch"
        ? Math.max(
            1,
            (this.throughputBps - rendition.bitrate) *
              PREFETCH_BANDWIDTH_SHARE,
          )
        : undefined;
    const backgroundController = new AbortController();
    const unlinkBackgroundAbort = linkAbort(
      signal,
      backgroundController,
    );
    this.backgroundFetchController?.abort("background-replaced");
    this.backgroundFetchController = backgroundController;
    this.backgroundCaching = true;
    void this.fetchMediaBytes(
      mediaUrl(this.baseUrl, segment.path),
      segment,
      backgroundController.signal,
      false,
      prefetchRateLimitBps,
      true,
    )
      .then(async () => {
        if (
          backgroundController.signal.aborted ||
          fetchGeneration !== this.fetchGeneration
        ) {
          return;
        }
        this.markBackgroundCached(segmentKey(segment));
        if (priority === "warm") {
          this.diagnosticsState.warmedSegments += 1;
          return;
        }
        this.diagnosticsState.prefetchedSegments += 1;
        if (prefetchIndex >= 0) {
          this.prefetchCursorByRendition.set(
            rendition.id,
            prefetchIndex + 1,
          );
        }
      })
      .catch(() => undefined)
      .finally(() => {
        unlinkBackgroundAbort();
        if (this.backgroundFetchController === backgroundController) {
          this.backgroundFetchController = undefined;
        }
        this.backgroundCaching = false;
      });
  }

  private markBackgroundCached(key: string): void {
    this.backgroundCached.delete(key);
    this.backgroundCached.add(key);
    if (this.backgroundCached.size <= MAX_BACKGROUND_CACHE_MARKERS) return;
    const oldest = this.backgroundCached.values();
    for (
      let index = 0;
      index < BACKGROUND_CACHE_MARKER_TRIM;
      index += 1
    ) {
      const entry = oldest.next();
      if (entry.done) break;
      this.backgroundCached.delete(entry.value);
    }
  }

  private connectionAllowsPrefetch(): boolean {
    const connection = (
      globalThis.navigator as Navigator & {
        connection?: {
          saveData?: boolean;
          type?: string;
          effectiveType?: string;
          rtt?: number;
        };
      }
    )?.connection;
    if (connection?.saveData === true) return false;
    const type = String(connection?.type || "").toLowerCase();
    if (type && !["wifi", "ethernet"].includes(type)) return false;
    const effectiveType = String(
      connection?.effectiveType || "",
    ).toLowerCase();
    if (["slow-2g", "2g", "3g"].includes(effectiveType)) return false;
    const rtt = finite(connection?.rtt);
    if (rtt <= 0) return true;
    const baseline = this.baselineNetworkRttMs;
    this.baselineNetworkRttMs =
      baseline === undefined
        ? rtt
        : Math.min(baseline * 1.01, baseline * 0.92 + rtt * 0.08);
    return (
      baseline === undefined ||
      rtt <= Math.max(baseline * 1.35, baseline + 25)
    );
  }

  private async fetchMediaBytes(
    url: URL,
    segment: EmbySegmentManifestEntry | undefined,
    signal: AbortSignal,
    init: boolean,
    maxReadBps?: number,
    background = false,
  ): Promise<Uint8Array> {
    const profile = this.options.player.bufferProfile;
    const maxSegmentBytes = Math.max(
      1,
      finite(profile.maxSegmentBytes, MAX_SEGMENT_BYTES),
    );
    const foregroundFetchLimitBytes = Math.max(
      maxSegmentBytes * 2,
      finite(profile.foregroundFetchLimitBytes, 32 * MEBIBYTE),
    );
    const cacheStagingLimitBytes = Math.max(
      0,
      finite(profile.cacheStagingLimitBytes, 8 * MEBIBYTE),
    );
    const expectedBytes = Math.max(0, finite(segment?.bytes));
    if (
      expectedBytes > maxSegmentBytes ||
      (expectedBytes > 0 &&
        this.foregroundFetchBytes +
          this.backgroundFetchBytes +
          expectedBytes >
          foregroundFetchLimitBytes) ||
      (expectedBytes > 0 &&
        !this.unifiedMediaBudgetAllows(expectedBytes))
    ) {
      throw new Error("媒体分片超过当前设备的前台拉取预算");
    }
    const cacheKey = url.toString();
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      const sizeValid =
        cached.byteLength <= maxSegmentBytes &&
        (!segment?.bytes ||
          segment.bytes <= 0 ||
          cached.byteLength === segment.bytes);
      const hashValid =
        !segment?.sha256 ||
        (await sha256Hex(cached)) === segment.sha256;
      if (sizeValid && hashValid) {
        this.diagnosticsState.cacheHits += 1;
        return cached;
      }
      // A partial/crashed CacheStorage write must be self-healing; otherwise
      // every retry would hit the same corrupt immutable entry forever.
      await this.cache.delete(cacheKey).catch(() => undefined);
    }
    const startedAt = performance.now();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let accountedBytes = 0;
    let responseHeaders: Headers | undefined;
    const adjustFetchBytes = (delta: number): void => {
      accountedBytes = Math.max(0, accountedBytes + delta);
      if (background) {
        this.backgroundFetchBytes = Math.max(
          0,
          this.backgroundFetchBytes + delta,
        );
      } else {
        this.foregroundFetchBytes = Math.max(
          0,
          this.foregroundFetchBytes + delta,
        );
      }
      this.syncExternalMediaMemoryUsage();
    };
    const releaseChunks = (): void => {
      if (accountedBytes > 0) adjustFetchBytes(-accountedBytes);
      chunks.length = 0;
    };
    const retainChunk = (chunk: Uint8Array): void => {
      if (
        received + chunk.byteLength > maxSegmentBytes ||
        this.foregroundFetchBytes +
          this.backgroundFetchBytes +
          chunk.byteLength >
          foregroundFetchLimitBytes ||
        !this.unifiedMediaBudgetAllows(chunk.byteLength)
      ) {
        throw new Error("媒体分片超过当前设备的前台拉取预算");
      }
      chunks.push(chunk);
      received += chunk.byteLength;
      adjustFetchBytes(chunk.byteLength);
    };
    try {
      for (let attempt = 0; attempt <= FETCH_RANGE_RETRIES; attempt += 1) {
        if (signal.aborted) throw signal.reason;
        const headers: Record<string, string> = {
          authorization: `Bearer ${this.access.token}`,
          accept: init ? "video/mp4" : "video/iso.segment",
        };
        if (received > 0) headers.range = `bytes=${received}-`;
        try {
          await this.withResponseDeadlines(
            url,
            { headers, cache: "no-store" },
            signal,
            async (response, controller) => {
              if (response.status === 401 || response.status === 403) {
                this.options.onTokenExpiring?.();
                throw new Error("分片访问凭证已过期");
              }
              if (response.status === 404) {
                throw new EmbyRelayHttpError(404, "segment");
              }
              if (received > 0 && response.status === 200) {
                // Some otherwise valid HTTP caches ignore Range. Restart from
                // byte zero instead of concatenating a duplicate prefix.
                releaseChunks();
                received = 0;
              } else if (received > 0 && response.status !== 206) {
                throw new Error(`分片续传被拒绝（${response.status}）`);
              }
              if (!response.ok) {
                throw new EmbyRelayHttpError(response.status, "segment");
              }
              responseHeaders = response.headers;
              const receivedBeforeBody = received;
              const declaredHeader =
                response.headers.get("content-length");
              const declaredBytes =
                declaredHeader === null
                  ? undefined
                  : Number(declaredHeader);
              if (
                Number.isSafeInteger(declaredBytes) &&
                Number(declaredBytes) >= 0 &&
                received + Number(declaredBytes) > maxSegmentBytes
              ) {
                throw new Error("媒体分片响应超过当前设备预算");
              }
              const reader = response.body?.getReader();
              if (!reader) {
                retainChunk(
                  new Uint8Array(await response.arrayBuffer()),
                );
              } else {
                try {
                  while (true) {
                    const read = await this.readWithIdleDeadline(
                      reader,
                      controller.signal,
                      controller,
                    );
                    if (read.done) break;
                    if (read.value?.byteLength) {
                      retainChunk(read.value);
                      if (
                        maxReadBps !== undefined &&
                        Number.isFinite(maxReadBps) &&
                        maxReadBps > 0
                      ) {
                        const targetElapsedMs =
                          (received * 8 * 1_000) / maxReadBps;
                        let delayMs =
                          targetElapsedMs -
                          (performance.now() - startedAt);
                        while (
                          delayMs > 1 &&
                          !controller.signal.aborted
                        ) {
                          await abortableDelay(
                            controller.signal,
                            Math.min(1_000, delayMs),
                          );
                          delayMs =
                            targetElapsedMs -
                            (performance.now() - startedAt);
                        }
                      }
                    }
                  }
                } finally {
                  reader.releaseLock();
                }
              }
              if (
                declaredBytes !== undefined &&
                Number.isSafeInteger(declaredBytes) &&
                declaredBytes >= 0 &&
                received - receivedBeforeBody !== declaredBytes
              ) {
                throw new Error("媒体分片响应体长度不完整");
              }
            },
          );
          break;
        } catch (error) {
          if (
            signal.aborted ||
            attempt >= FETCH_RANGE_RETRIES ||
            (error instanceof EmbyRelayHttpError && error.status === 404)
          ) {
            throw error;
          }
          this.diagnosticsState.rangeRetries += 1;
        }
      }
      if (expectedBytes > 0 && received !== expectedBytes) {
        throw new Error("媒体分片长度不完整");
      }
      // The coalescing allocation overlaps with the chunk list. Its peak is
      // included in the foreground slice before the chunks are released.
      if (
        this.foregroundFetchBytes +
          this.backgroundFetchBytes +
          received >
          foregroundFetchLimitBytes ||
        !this.unifiedMediaBudgetAllows(received)
      ) {
        throw new Error("媒体分片合并超过当前设备预算");
      }
      const data = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      // The chunk allocations can be released now, but keep their accounting
      // lease until this method returns because the coalesced output owns the
      // same number of foreground bytes during hashing and cache staging.
      chunks.length = 0;
      if (segment?.sha256 && (await sha256Hex(data)) !== segment.sha256) {
        throw new Error("媒体分片校验失败");
      }
      const elapsedMs = Math.max(1, performance.now() - startedAt);
      const measuredBps = (data.byteLength * 8 * 1_000) / elapsedMs;
      // Deep prefetch is intentionally paced to a fraction of residual
      // bandwidth. Feeding that artificial ceiling back into ABR would make a
      // fast link appear slower after every background fetch and eventually
      // downgrade healthy playback.
      this.throughputBps = updateEmbyThroughputEstimate(
        this.throughputBps,
        measuredBps,
        maxReadBps !== undefined,
      );
      this.diagnosticsState.networkFetches += 1;
      // CacheStorage writes clone their body. Only stage a cache write when
      // that copy fits its dedicated slice; playback itself never waits for
      // an oversized best-effort cache allocation.
      if (
        data.byteLength <= cacheStagingLimitBytes &&
        this.cacheStagingBytes + data.byteLength <=
          cacheStagingLimitBytes &&
        this.unifiedMediaBudgetAllows(data.byteLength)
      ) {
        this.cacheStagingBytes += data.byteLength;
        this.syncExternalMediaMemoryUsage();
        try {
          await this.cache
            .put(cacheKey, data, responseHeaders)
            .catch(() => undefined);
        } finally {
          this.cacheStagingBytes = Math.max(
            0,
            this.cacheStagingBytes - data.byteLength,
          );
          this.syncExternalMediaMemoryUsage();
        }
      }
      return data;
    } finally {
      releaseChunks();
    }
  }

  private async withResponseDeadlines<T>(
    url: URL,
    init: RequestInit,
    signal: AbortSignal,
    consume: (
      response: Response,
      controller: AbortController,
    ) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const unlink = linkAbort(signal, controller);
    const timer = window.setTimeout(
      () => controller.abort("response-header-timeout"),
      FETCH_HEADER_TIMEOUT_MS,
    );
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      return await consume(response, controller);
    } finally {
      window.clearTimeout(timer);
      controller.abort("response-consumed");
      unlink();
    }
  }

  private async readWithIdleDeadline(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
    controller: AbortController,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: number | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(() => {
        controller.abort("response-body-idle-timeout");
        reject(new Error("分片响应体长时间无数据"));
      }, FETCH_BODY_IDLE_TIMEOUT_MS);
    });
    try {
      if (signal.aborted) throw signal.reason;
      return await Promise.race([reader.read(), timeout]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }
}
