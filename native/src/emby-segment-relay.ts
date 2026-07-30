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
const MANIFEST_POLL_MS = 650;
const FETCH_HEADER_TIMEOUT_MS = 10_000;
const FETCH_BODY_IDLE_TIMEOUT_MS = 15_000;
const FETCH_RANGE_RETRIES = 2;
const ABR_UPGRADE_STABLE_MS = 20_000;
const ABR_UPGRADE_HOLD_MS = 20_000;
const WARM_WINDOW_SECONDS = 120;
const PREFETCH_BANDWIDTH_SHARE = 0.65;
const MAX_BACKGROUND_CACHE_MARKERS = 20_000;
const BACKGROUND_CACHE_MARKER_TRIM = 4_000;

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
  label: string;
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  mimeType: string;
  switchGroup: string;
  initPath: string;
  segments: EmbySegmentManifestEntry[];
}

export interface EmbySegmentManifest {
  protocol: "synced-cmaf-v1";
  roomId: string;
  sessionId: string;
  assetId: string;
  mediaVersion: number;
  title: string;
  startTimeTicks: number;
  runtimeTicks?: number;
  updatedAt: number;
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
  appendedSegments: number;
  warmedSegments: number;
  prefetchedSegments: number;
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
    `${baseUrl.pathname}rooms/${encodeURIComponent(roomId)}/assets/` +
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
    `/media/v1/rooms/${expected.roomId}/assets/${expected.assetId}/` +
    `versions/${expected.mediaVersion}/`;
  const renditionIds = new Set<string>();
  for (const candidate of input.renditions) {
    const rendition = candidate as Partial<EmbyRenditionManifest>;
    const renditionId = String(rendition.id || "");
    const initPath = String(rendition.initPath || "");
    const renditionRoot = `${versionRoot}renditions/${renditionId}/`;
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
      initPath !== `${renditionRoot}init.mp4` ||
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
    renditionIds.add(renditionId);
    renditions.push({
      id: renditionId,
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
    });
  }
  return {
    protocol: "synced-cmaf-v1",
    roomId: expected.roomId,
    sessionId: String(input.sessionId || "").slice(0, 128),
    assetId: expected.assetId,
    mediaVersion: expected.mediaVersion,
    title: String(input.title || "Emby 影片").slice(0, 300),
    startTimeTicks: Math.max(0, finite(input.startTimeTicks)),
    runtimeTicks:
      input.runtimeTicks === undefined
        ? undefined
        : Math.max(0, finite(input.runtimeTicks)),
    updatedAt: Math.max(0, finite(input.updatedAt)),
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
      item.bitrate <= safeBitrate && item.height <= preferredHeight,
  );
  let selected =
    eligible.at(-1) ||
    ordered.find((item) => item.height <= preferredHeight) ||
    ordered[0];
  if (!current) return selected;
  if (selected.bitrate < current.bitrate) return selected;
  if (selected.bitrate === current.bitrate) return current;
  if (
    input.stableForMs < ABR_UPGRADE_STABLE_MS ||
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
  private cache?: Cache;
  private memory = new Map<string, Uint8Array>();
  private bytes = 0;
  private budgetBytes = 256 * MEBIBYTE;
  private initialized?: Promise<void>;

  constructor(
    private readonly cacheStorage: CacheStorage | undefined =
      globalThis.caches,
  ) {}

  private ensureInitialized(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
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
      if (!this.cacheStorage) return;
      this.cache = await this.cacheStorage.open(
        "synced-emby-segments-v1",
      );
      const keys = await this.cache.keys();
      const discarded = keys.slice(0, Math.max(0, keys.length - 10_000));
      await Promise.all(
        discarded.map((request) => this.cache!.delete(request)),
      );
      for (const request of keys.slice(-10_000)) {
        const response = await this.cache.match(request);
        const bytes = finite(response?.headers.get("content-length"));
        this.entries.set(request.url, {
          key: request.url,
          bytes,
          lastAccess: Date.now(),
        });
        this.bytes += bytes;
      }
      await this.evict();
    })();
    return this.initialized;
  }

  async get(url: string): Promise<Uint8Array | undefined> {
    await this.ensureInitialized();
    const memory = this.memory.get(url);
    if (memory) {
      this.touch(url, memory.byteLength);
      return memory.slice();
    }
    const response = await this.cache?.match(url);
    if (!response) return undefined;
    const data = new Uint8Array(await response.arrayBuffer());
    this.touch(url, data.byteLength);
    return data;
  }

  async put(url: string, data: Uint8Array, headers?: Headers): Promise<void> {
    await this.ensureInitialized();
    this.touch(url, data.byteLength);
    if (this.cache) {
      const responseHeaders = new Headers(headers);
      responseHeaders.set("content-length", String(data.byteLength));
      responseHeaders.set("x-synced-cached-at", String(Date.now()));
      await this.cache.put(
        url,
        new Response(data.slice(), { headers: responseHeaders }),
      );
    } else {
      this.memory.set(url, data.slice());
    }
    await this.evict();
  }

  async delete(url: string): Promise<void> {
    await this.ensureInitialized();
    const previous = this.entries.get(url);
    if (previous) {
      this.entries.delete(url);
      this.bytes = Math.max(0, this.bytes - previous.bytes);
    }
    this.memory.delete(url);
    await this.cache?.delete(url);
  }

  private touch(key: string, bytes: number): void {
    const previous = this.entries.get(key);
    if (previous) this.bytes = Math.max(0, this.bytes - previous.bytes);
    this.bytes += bytes;
    this.entries.delete(key);
    this.entries.set(key, { key, bytes, lastAccess: Date.now() });
  }

  private async evict(): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.budgetBytes) break;
      this.entries.delete(key);
      this.bytes = Math.max(0, this.bytes - entry.bytes);
      this.memory.delete(key);
      await this.cache?.delete(key);
    }
  }

  async close(): Promise<void> {
    this.memory.clear();
    this.entries.clear();
    this.bytes = 0;
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
  private deliverySequence = 0;
  private appended = new Set<string>();
  private appendedTimelineEndMs = 0;
  private lastObservedPlaybackTime = 0;
  private lastRebufferAt = performance.now();
  private backgroundCaching = false;
  private readonly backgroundCached = new Set<string>();
  private readonly prefetchCursorByRendition = new Map<string, number>();
  private recoveryTargetTime?: number;
  private requiresKeyframe = true;
  private baselineNetworkRttMs?: number;
  private appliedSubtitlePath = "";
  private diagnosticsState: EmbyAbrDiagnostics = {
    active: false,
    estimatedThroughputBps: 0,
    fetchGeneration: 0,
    cacheHits: 0,
    networkFetches: 0,
    rangeRetries: 0,
    appendedSegments: 0,
    warmedSegments: 0,
    prefetchedSegments: 0,
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
    },
  ) {
    this.access = options.access;
    this.baseUrl = buildEmbySegmentRelayBaseUrl(
      options.signalUrl,
      this.access,
    );
    this.cache = options.cache || new BrowserSegmentCache();
    this.fetchImpl = options.fetchImpl || fetch;
    this.options.player.addEventListener?.(
      "segmentrecoveryneeded",
      this.handleSegmentRecovery,
    );
  }

  private readonly cache: SegmentCacheLike;
  private readonly fetchImpl: typeof fetch;

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
    this.currentRendition = undefined;
    this.stableSince = performance.now();
    this.upgradeHoldUntil = 0;
    this.lastObservedPlaybackTime = this.options.player.currentTime;
    this.diagnosticsState = {
      active: true,
      estimatedThroughputBps: this.throughputBps,
      fetchGeneration: this.fetchGeneration,
      cacheHits: 0,
      networkFetches: 0,
      rangeRetries: 0,
      appendedSegments: 0,
      warmedSegments: 0,
      prefetchedSegments: 0,
    };
    void this.run(this.controller.signal);
  }

  stop(closeCache = false): void {
    this.controller?.abort("replaced");
    this.mediaFetchController?.abort("replaced");
    this.unlinkMediaFetchAbort?.();
    this.mediaFetchController = undefined;
    this.unlinkMediaFetchAbort = undefined;
    this.controller = undefined;
    this.session = undefined;
    this.descriptor = undefined;
    this.currentRendition = undefined;
    this.recoveryTargetTime = undefined;
    this.requiresKeyframe = true;
    this.backgroundCaching = false;
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
      try {
        if (this.access.expiresAt - Date.now() < 2 * 60_000) {
          this.options.onTokenExpiring?.();
        }
        const manifest = await this.fetchManifest(signal);
        if (signal.aborted) return;
        await this.applyManifestSubtitle(manifest, signal);
        await this.fillPlaybackBuffer(manifest, signal);
        this.maybeCacheAhead(
          this.mediaFetchController?.signal || signal,
          this.fetchGeneration,
        );
        this.diagnosticsState.lastError = undefined;
      } catch (error) {
        if (signal.aborted) return;
        this.diagnosticsState.lastError =
          error instanceof Error ? error.message : String(error);
        this.lastRebufferAt = performance.now();
        this.stableSince = performance.now();
      }
      this.options.onDiagnostic?.(this.diagnostics);
      await abortableDelay(signal, MANIFEST_POLL_MS);
    }
  }

  private async fetchManifest(
    signal: AbortSignal,
  ): Promise<EmbySegmentManifest> {
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
        },
        cache: "no-store",
      },
      signal,
      async (response, controller) => {
        if (response.status === 404) {
          throw new Error("分片清单尚未就绪");
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
        return parseEmbySegmentManifest(
          JSON.parse(new TextDecoder().decode(bytes)),
          {
            roomId: this.session!.roomId,
            assetId: this.descriptor!.assetId,
            mediaVersion: this.descriptor!.mediaVersion,
            sessionId: this.session!.sessionId,
          },
        );
      },
    );
  }

  private async fillPlaybackBuffer(
    manifest: EmbySegmentManifest,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.session || !manifest.renditions.length) return;
    const supportedRenditions = manifest.renditions.filter(
      (rendition) =>
        typeof globalThis.MediaSource === "undefined" ||
        typeof globalThis.MediaSource.isTypeSupported !== "function" ||
        globalThis.MediaSource.isTypeSupported(rendition.mimeType),
    );
    if (!supportedRenditions.length) {
      throw new Error("当前设备不支持清单中的任何视频编码档位");
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
    const selected = selectEmbyAbrRendition(supportedRenditions, {
      throughputBps: this.throughputBps,
      preferredHeight: this.preferredHeight,
      currentId: this.currentRendition?.id,
      bufferAheadSeconds: this.options.player.bufferedAhead,
      stableForMs: now - this.stableSince,
      upgradeHoldRemainingMs: Math.max(0, this.upgradeHoldUntil - now),
    });
    if (selected.id !== this.currentRendition?.id) {
      const upgrading =
        Boolean(this.currentRendition) &&
        selected.bitrate > this.currentRendition!.bitrate;
      await this.switchRendition(
        selected,
        fetchSignal,
        fetchGeneration,
      );
      if (upgrading) this.upgradeHoldUntil = now + ABR_UPGRADE_HOLD_MS;
      this.stableSince = now;
    } else {
      // Every manifest is a fresh immutable snapshot. Keep the selected
      // rendition object current so newly uploaded segments become visible.
      this.currentRendition = selected;
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
      20,
      Math.min(60, this.options.player.bufferProfile.targetSeconds),
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
        !this.appended.has(`${rendition.id}:${segment.sequence}`),
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
      await this.appendSegment(
        rendition,
        segment,
        fetchSignal,
        fetchGeneration,
      );
    }
    if (this.options.player.bufferedAhead < 1.5) {
      this.lastRebufferAt = now;
      this.stableSince = now;
    }
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
      previous.switchGroup !== rendition.switchGroup;
    if (needsMediaSourceRebuild) {
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
      this.options.player.configure(this.session);
      this.deliverySequence = 0;
      this.appended.clear();
      this.appendedTimelineEndMs = Math.max(
        0,
        this.options.player.currentTime * 1_000,
      );
    }
    this.options.player.appendInit(init);
    this.currentRendition = rendition;
    this.requiresKeyframe = true;
  }

  private async appendSegment(
    rendition: EmbyRenditionManifest,
    segment: EmbySegmentManifestEntry,
    signal: AbortSignal,
    fetchGeneration: number,
  ): Promise<void> {
    const key = `${rendition.id}:${segment.sequence}`;
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
      this.currentRendition?.id !== rendition.id
    ) {
      return;
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
    this.options.player.appendFragment(fragment);
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
  }

  private maybeCacheAhead(
    signal: AbortSignal,
    fetchGeneration: number,
  ): void {
    if (
      this.backgroundCaching ||
      signal.aborted ||
      !this.currentRendition
    ) {
      return;
    }
    const rendition = this.currentRendition;
    const currentMs =
      (this.recoveryTargetTime ?? this.options.player.currentTime) * 1_000;
    const warmEndMs = currentMs + WARM_WINDOW_SECONDS * 1_000;
    const segmentKey = (segment: EmbySegmentManifestEntry): string =>
      `${rendition.id}:${segment.sequence}`;
    const warmStartMs =
      currentMs +
      Math.max(15, this.options.player.bufferProfile.targetSeconds) *
        1_000;
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
    const priority = segment.timelineTimeMs <= warmEndMs ? "warm" : "prefetch";
    const prefetchRateLimitBps =
      priority === "prefetch"
        ? Math.max(
            1,
            (this.throughputBps - rendition.bitrate) *
              PREFETCH_BANDWIDTH_SHARE,
          )
        : undefined;
    this.backgroundCaching = true;
    void this.fetchMediaBytes(
      mediaUrl(this.baseUrl, segment.path),
      segment,
      signal,
      false,
      prefetchRateLimitBps,
    )
      .then(async () => {
        if (
          signal.aborted ||
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
  ): Promise<Uint8Array> {
    const cacheKey = url.toString();
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      const sizeValid =
        !segment?.bytes ||
        segment.bytes <= 0 ||
        cached.byteLength === segment.bytes;
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
    let responseHeaders: Headers | undefined;
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
            if (received > 0 && response.status === 200) {
              // Some otherwise valid HTTP caches ignore Range. Restart from
              // byte zero instead of concatenating a duplicate prefix.
              chunks.length = 0;
              received = 0;
            } else if (received > 0 && response.status !== 206) {
              throw new Error(`分片续传被拒绝（${response.status}）`);
            }
            if (!response.ok) {
              throw new Error(`分片请求失败（${response.status}）`);
            }
            responseHeaders = response.headers;
            const receivedBeforeBody = received;
            const reader = response.body?.getReader();
            if (!reader) {
              const data = new Uint8Array(await response.arrayBuffer());
              chunks.push(data);
              received += data.byteLength;
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
                    chunks.push(read.value);
                    received += read.value.byteLength;
                    if (received > MAX_SEGMENT_BYTES) {
                      throw new Error("媒体分片异常过大");
                    }
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
                      while (delayMs > 1 && !controller.signal.aborted) {
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
            const declaredHeader =
              response.headers.get("content-length");
            const declaredBytes =
              declaredHeader === null
                ? undefined
                : Number(declaredHeader);
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
        if (signal.aborted || attempt >= FETCH_RANGE_RETRIES) throw error;
        this.diagnosticsState.rangeRetries += 1;
      }
    }
    const expectedBytes = segment?.bytes;
    if (expectedBytes !== undefined && expectedBytes > 0 && received !== expectedBytes) {
      throw new Error("媒体分片长度不完整");
    }
    const data = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
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
    // Playback must not fail merely because the browser denied a best-effort
    // persistent cache write or another origin consumed the shared quota.
    await this.cache.put(cacheKey, data, responseHeaders).catch(() => undefined);
    return data;
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
