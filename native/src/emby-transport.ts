import { detectVideoEnhancementCapabilities } from "./video-enhancement";

export const EMBY_DATA_CHANNEL_LABEL = "synced-emby-v1";
export const EMBY_CONTROL_CHANNEL_LABEL = "synced-emby-control-v1";
export const EMBY_PROTOCOL_VERSION = 1;
// Smaller SCTP messages recover much faster on lossy mobile/TURN routes and
// avoid monopolizing the association behind one large fragment.
export const EMBY_CHUNK_BYTES = 16 * 1024;
export const EMBY_BUFFER_HIGH_WATER = 2 * 1024 * 1024;
export const EMBY_BUFFER_LOW_WATER = 512 * 1024;
export const EMBY_INITIAL_MEDIA_BYTES_PER_MS = 2_500_000 / 8 / 1_000;

const LEGACY_MAGIC = new Uint8Array([0x59, 0x4b, 0x4d, 0x31]); // YKM1
const MAGIC = new Uint8Array([0x59, 0x4b, 0x4d, 0x32]); // YKM2
const LEGACY_HEADER_PREFIX_BYTES = 6;
const FIXED_HEADER_BYTES = 64;
const BINARY_FRAMING_VERSION = 2;
const MAX_FRAGMENT_BYTES = 96 * 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_PENDING_ASSEMBLY_BYTES = 128 * 1024 * 1024;
const MAX_RELIABLE_REPAIR_REQUESTS = 1;
const RELIABLE_REPAIR_LIFETIME_MS = 2_500;
// A reliable unordered SCTP stream can deliver the first chunk of many later
// fragments while one retransmitted chunk is still in flight. Sixteen
// assemblies represent about 32 seconds for the GOP-aligned 2 s CMAF cadence
// and caused the receiver itself to evict otherwise reliable media on mobile
// TURN routes. Keep a much wider, still byte-bounded reorder window.
const MAX_PENDING_ASSEMBLIES = 96;

export type EmbyTrackType = "muxed" | "subtitle";

export interface EmbyChunkHeader {
  protocol: 1;
  roomId: string;
  sessionId: string;
  mediaVersion: number;
  transportEpoch: number;
  fragmentSeq: number;
  chunkIndex: number;
  chunkCount: number;
  timestampMs: number;
  mediaTimeMs: number;
  /**
   * Absolute movie time assigned by the broadcaster after repairing source
   * timestamp discontinuities. Older protocol-v1 senders omit this field.
   */
  timelineTimeMs?: number;
  trackType: EmbyTrackType;
  keyframe: boolean;
  dataLength: number;
  chunkLength: number;
  checksum: number;
}

export interface EmbyTransportFragment {
  roomId: string;
  sessionId: string;
  mediaVersion: number;
  transportEpoch?: number;
  sequence: number;
  timestampMs: number;
  mediaTimeMs: number;
  timelineTimeMs?: number;
  trackType: EmbyTrackType;
  keyframe: boolean;
  data: Uint8Array;
}

export interface DecodedEmbyChunk {
  header: EmbyChunkHeader;
  data: Uint8Array;
}

export interface EmbySenderStats {
  queuedBytes: number;
  bufferedBytes: number;
  queuedMessages: number;
  droppedFragments: number;
  queuedDurationMs: number;
  bufferedDurationMs: number;
  totalQueuedDurationMs: number;
}

export interface EmbyTimelinePoint {
  timelineTimeMs: number;
  timestampOffsetMs: number;
  discontinuity: boolean;
}

export interface EmbySegmentSessionDescriptor {
  protocol: "synced-cmaf-v1";
  sessionId: string;
  assetId: string;
  mediaVersion: number;
  manifestPath: string;
}

/**
 * Converts the raw `tfdt` clock emitted by FFmpeg/Emby into one continuous
 * movie clock. Some otherwise valid MKV/remote-transcode sources contain
 * 30-60 second timestamp jumps between consecutive fragments. MSE preserves
 * those jumps as unplayable holes unless each fragment carries a repaired
 * target time.
 */
export class EmbyTimelineNormalizer {
  private previousSequence?: number;
  private previousMediaTimeMs?: number;
  private previousTimelineTimeMs?: number;
  private timestampOffsetMs = 0;
  private recentCadenceMs: number[] = [];
  private discontinuities = 0;

  constructor(private startTimeMs = 0) {
    this.reset(startTimeMs);
  }

  reset(startTimeMs = 0): void {
    this.startTimeMs =
      Number.isFinite(startTimeMs) && startTimeMs >= 0 ? startTimeMs : 0;
    this.previousSequence = undefined;
    this.previousMediaTimeMs = undefined;
    this.previousTimelineTimeMs = undefined;
    this.timestampOffsetMs = 0;
    this.recentCadenceMs = [];
    this.discontinuities = 0;
  }

  get offsetMs(): number {
    return this.timestampOffsetMs;
  }

  get discontinuityCount(): number {
    return this.discontinuities;
  }

  normalize(mediaTimeMs: number, sequence: number): EmbyTimelinePoint {
    const rawTime = Number(mediaTimeMs);
    const rawSequence = Number(sequence);
    if (
      !Number.isFinite(rawTime) ||
      rawTime < 0 ||
      !Number.isSafeInteger(rawSequence) ||
      rawSequence < 1
    ) {
      return {
        timelineTimeMs: Math.max(0, Number.isFinite(rawTime) ? rawTime : 0),
        timestampOffsetMs: 0,
        discontinuity: false,
      };
    }

    if (
      this.previousSequence === undefined ||
      this.previousMediaTimeMs === undefined ||
      this.previousTimelineTimeMs === undefined
    ) {
      this.timestampOffsetMs = this.startTimeMs - rawTime;
      this.previousSequence = rawSequence;
      this.previousMediaTimeMs = rawTime;
      this.previousTimelineTimeMs = this.startTimeMs;
      return {
        timelineTimeMs: this.startTimeMs,
        timestampOffsetMs: this.timestampOffsetMs,
        // A non-zero first offset is the expected mapping from the source
        // clock to movie time, not a mid-stream discontinuity.
        discontinuity: false,
      };
    }

    const consecutive = rawSequence === this.previousSequence + 1;
    const rawDelta = rawTime - this.previousMediaTimeMs;
    const cadence = this.expectedCadenceMs;
    const discontinuityThreshold = Math.min(
      5_000,
      Math.max(2_500, cadence * 4),
    );
    const discontinuity =
      consecutive &&
      (rawDelta < -1 || rawDelta > discontinuityThreshold);

    let timelineTime = rawTime + this.timestampOffsetMs;
    if (discontinuity) {
      timelineTime = this.previousTimelineTimeMs + cadence;
      this.timestampOffsetMs = timelineTime - rawTime;
      this.discontinuities += 1;
    } else if (consecutive && rawDelta >= 20 && rawDelta <= 2_000) {
      this.recentCadenceMs.push(rawDelta);
      if (this.recentCadenceMs.length > 12) this.recentCadenceMs.shift();
    }

    this.previousSequence = rawSequence;
    this.previousMediaTimeMs = rawTime;
    this.previousTimelineTimeMs = timelineTime;
    return {
      timelineTimeMs: Math.max(0, timelineTime),
      timestampOffsetMs: this.timestampOffsetMs,
      discontinuity,
    };
  }

  private get expectedCadenceMs(): number {
    if (!this.recentCadenceMs.length) return 750;
    const sorted = [...this.recentCadenceMs].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }
}

export type EmbyControlMessage =
  | {
      type: "session";
      roomId: string;
      sessionId: string;
      mediaVersion: number;
      transportEpoch?: number;
      mimeType: string;
      plan: EmbyStreamPlan;
      title: string;
      segmentRelay?: EmbySegmentSessionDescriptor;
    }
  | {
      type: "playback-state";
      sessionId: string;
      mediaVersion: number;
      stateVersion: number;
      currentTime: number;
      paused: boolean;
      playbackRate: number;
      serverTimeMs: number;
    }
  | {
      type: "need";
      sessionId: string;
      mediaVersion: number;
      transportEpoch?: number;
      fragmentSeq: number;
      trackType: EmbyTrackType;
      missing: number[];
    }
  | {
      type: "init-request";
      sessionId: string;
      mediaVersion: number;
      transportEpoch?: number;
    }
  | {
      type: "sync-ping";
      clientTimeMs: number;
      clientMonotonicMs?: number;
    }
  | {
      type: "sync-pong";
      clientTimeMs: number;
      hostTimeMs: number;
      clientMonotonicMs?: number;
    }
  | {
      type: "buffer-state";
      sessionId: string;
      mediaVersion: number;
      transportEpoch?: number;
      aheadSeconds: number;
      urgent: boolean;
    }
  | {
      type: "media-ready";
      sessionId: string;
      mediaVersion: number;
      transportEpoch?: number;
    }
  | {
      type: "session-ready";
      sessionId: string;
      mediaVersion: number;
      transportEpoch?: number;
    }
  | {
      type: "catch-up";
      sessionId: string;
      mediaVersion: number;
      transportEpoch?: number;
      targetTime: number;
    }
  | {
      type: "segment-fallback-request";
      sessionId: string;
      mediaVersion: number;
      targetTime: number;
    }
  | {
      type: "segment-fallback-release";
      sessionId: string;
      mediaVersion: number;
    }
  | {
      type: "resync";
      sessionId: string;
      mediaVersion: number;
      transportEpoch?: number;
      targetTime: number;
    }
  | {
      type: "stream-transition";
      sessionId: string;
      mediaVersion: number;
      nextMediaVersion: number;
      targetTime: number;
    }
  | {
      type: "stream-ended";
      sessionId: string;
      mediaVersion: number;
      transportEpoch?: number;
      finalFragmentSeq?: number;
      finalTrackType?: EmbyTrackType;
    }
  | {
      type: "error";
      sessionId?: string;
      mediaVersion?: number;
      message: string;
    };

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function cleanIdentifier(value: unknown, maxLength: number): string {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || !/^[a-z0-9_-]+$/i.test(text)) {
    throw new Error("媒体分片身份字段无效");
  }
  return text;
}

function validateHeader(value: unknown): EmbyChunkHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("媒体分片头无效");
  }
  const input = value as Partial<EmbyChunkHeader>;
  if (input.trackType !== "muxed" && input.trackType !== "subtitle") {
    throw new Error("媒体分片轨道类型无效");
  }
  const rawChecksum = Number(input.checksum);
  const header: EmbyChunkHeader = {
    protocol: 1,
    roomId: cleanIdentifier(input.roomId, 32),
    sessionId: cleanIdentifier(input.sessionId, 128),
    mediaVersion: Number(input.mediaVersion),
    transportEpoch:
      input.transportEpoch === undefined ? 0 : Number(input.transportEpoch),
    fragmentSeq: Number(input.fragmentSeq),
    chunkIndex: Number(input.chunkIndex),
    chunkCount: Number(input.chunkCount),
    timestampMs: Number(input.timestampMs),
    mediaTimeMs: Number(input.mediaTimeMs),
    timelineTimeMs:
      input.timelineTimeMs === undefined
        ? undefined
        : Number(input.timelineTimeMs),
    trackType: input.trackType,
    keyframe: input.keyframe === true,
    dataLength: Number(input.dataLength),
    chunkLength: Number(input.chunkLength),
    checksum: rawChecksum >>> 0,
  };
  if (
    input.protocol !== EMBY_PROTOCOL_VERSION ||
    !Number.isSafeInteger(header.mediaVersion) ||
    header.mediaVersion < 1 ||
    header.mediaVersion > 0xffffffff ||
    !Number.isSafeInteger(header.transportEpoch) ||
    header.transportEpoch < 0 ||
    header.transportEpoch > 1_000_000_000 ||
    !Number.isSafeInteger(header.fragmentSeq) ||
    header.fragmentSeq < 0 ||
    header.fragmentSeq > 0xffffffff ||
    !Number.isSafeInteger(header.chunkIndex) ||
    header.chunkIndex < 0 ||
    !Number.isSafeInteger(header.chunkCount) ||
    header.chunkCount < 1 ||
    header.chunkCount > 4_096 ||
    header.chunkIndex >= header.chunkCount ||
    !Number.isFinite(header.timestampMs) ||
    header.timestampMs < 0 ||
    !Number.isFinite(header.mediaTimeMs) ||
    header.mediaTimeMs < 0 ||
    header.mediaTimeMs > 30 * 24 * 60 * 60 * 1_000 ||
    (header.timelineTimeMs !== undefined &&
      (!Number.isFinite(header.timelineTimeMs) ||
        header.timelineTimeMs < 0 ||
        header.timelineTimeMs > 30 * 24 * 60 * 60 * 1_000)) ||
    !Number.isSafeInteger(header.dataLength) ||
    header.dataLength < 0 ||
    header.dataLength > MAX_FRAGMENT_BYTES ||
    !Number.isSafeInteger(header.chunkLength) ||
    header.chunkLength < 0 ||
    header.chunkLength > EMBY_CHUNK_BYTES ||
    !Number.isSafeInteger(rawChecksum) ||
    rawChecksum < 0 ||
    rawChecksum > 0xffffffff
  ) {
    throw new Error("媒体分片头参数越界");
  }
  const expectedChunkCount = Math.max(
    1,
    Math.ceil(header.dataLength / EMBY_CHUNK_BYTES),
  );
  const expectedChunkLength = Math.max(
    0,
    Math.min(
      EMBY_CHUNK_BYTES,
      header.dataLength - header.chunkIndex * EMBY_CHUNK_BYTES,
    ),
  );
  if (
    header.chunkCount !== expectedChunkCount ||
    header.chunkLength !== expectedChunkLength
  ) {
    throw new Error("媒体分片块布局与总长度不一致");
  }
  return header;
}

export function encodeEmbyChunk(
  header: EmbyChunkHeader,
  payload: Uint8Array,
): ArrayBuffer {
  const validated = validateHeader(header);
  if (payload.byteLength !== validated.chunkLength) {
    throw new Error("媒体分片块长度不匹配");
  }
  const encoder = new TextEncoder();
  const roomBytes = encoder.encode(validated.roomId);
  const sessionBytes = encoder.encode(validated.sessionId);
  const headerLength =
    FIXED_HEADER_BYTES + roomBytes.byteLength + sessionBytes.byteLength;
  if (
    roomBytes.byteLength > 255 ||
    sessionBytes.byteLength > 255 ||
    headerLength > MAX_HEADER_BYTES
  ) {
    throw new Error("媒体分片头过大");
  }
  const result = new Uint8Array(headerLength + payload.length);
  result.set(MAGIC, 0);
  const view = new DataView(result.buffer);
  view.setUint8(4, BINARY_FRAMING_VERSION);
  view.setUint8(
    5,
    (validated.keyframe ? 0x01 : 0) |
      (validated.timelineTimeMs !== undefined ? 0x02 : 0),
  );
  view.setUint8(6, validated.trackType === "subtitle" ? 1 : 0);
  view.setUint8(7, roomBytes.byteLength);
  view.setUint8(8, sessionBytes.byteLength);
  view.setUint8(9, 0);
  view.setUint16(10, headerLength, false);
  view.setUint32(12, validated.mediaVersion, false);
  view.setUint32(16, validated.transportEpoch, false);
  view.setUint32(20, validated.fragmentSeq, false);
  view.setUint16(24, validated.chunkIndex, false);
  view.setUint16(26, validated.chunkCount, false);
  view.setFloat64(28, validated.timestampMs, false);
  view.setFloat64(36, validated.mediaTimeMs, false);
  view.setFloat64(
    44,
    validated.timelineTimeMs === undefined
      ? Number.NaN
      : validated.timelineTimeMs,
    false,
  );
  view.setUint32(52, validated.dataLength, false);
  view.setUint32(56, validated.chunkLength, false);
  view.setUint32(60, validated.checksum, false);
  result.set(roomBytes, FIXED_HEADER_BYTES);
  result.set(sessionBytes, FIXED_HEADER_BYTES + roomBytes.byteLength);
  result.set(payload, headerLength);
  return result.buffer;
}

export function decodeEmbyChunk(input: ArrayBuffer | Uint8Array): DecodedEmbyChunk {
  const bytes =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(input);
  const binary =
    bytes.length >= FIXED_HEADER_BYTES &&
    MAGIC.every((value, index) => bytes[index] === value);
  const legacy =
    bytes.length >= LEGACY_HEADER_PREFIX_BYTES &&
    LEGACY_MAGIC.every((value, index) => bytes[index] === value);
  if (!binary && !legacy) {
    throw new Error("不是同频 Emby 媒体分片");
  }
  if (legacy) return decodeLegacyEmbyChunk(bytes);
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  if (view.getUint8(4) !== BINARY_FRAMING_VERSION) {
    throw new Error("媒体分片二进制头版本不受支持");
  }
  const flags = view.getUint8(5);
  const track = view.getUint8(6);
  const roomLength = view.getUint8(7);
  const sessionLength = view.getUint8(8);
  const headerLength = view.getUint16(10, false);
  if (
    track > 1 ||
    headerLength !== FIXED_HEADER_BYTES + roomLength + sessionLength ||
    headerLength > MAX_HEADER_BYTES ||
    headerLength > bytes.byteLength
  ) {
    throw new Error("媒体分片二进制头长度无效");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const roomStart = FIXED_HEADER_BYTES;
  const sessionStart = roomStart + roomLength;
  const timeline = view.getFloat64(44, false);
  const header = validateHeader({
    protocol: EMBY_PROTOCOL_VERSION,
    roomId: decoder.decode(bytes.subarray(roomStart, sessionStart)),
    sessionId: decoder.decode(
      bytes.subarray(sessionStart, sessionStart + sessionLength),
    ),
    mediaVersion: view.getUint32(12, false),
    transportEpoch: view.getUint32(16, false),
    fragmentSeq: view.getUint32(20, false),
    chunkIndex: view.getUint16(24, false),
    chunkCount: view.getUint16(26, false),
    timestampMs: view.getFloat64(28, false),
    mediaTimeMs: view.getFloat64(36, false),
    timelineTimeMs: flags & 0x02 ? timeline : undefined,
    trackType: track === 1 ? "subtitle" : "muxed",
    keyframe: Boolean(flags & 0x01),
    dataLength: view.getUint32(52, false),
    chunkLength: view.getUint32(56, false),
    checksum: view.getUint32(60, false),
  });
  const data = bytes.subarray(headerLength);
  if (data.byteLength !== header.chunkLength) {
    throw new Error("媒体分片负载长度不匹配");
  }
  return { header, data };
}

function decodeLegacyEmbyChunk(bytes: Uint8Array): DecodedEmbyChunk {
  const headerLength = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(4, false);
  if (
    headerLength < 2 ||
    headerLength > MAX_HEADER_BYTES ||
    LEGACY_HEADER_PREFIX_BYTES + headerLength > bytes.length
  ) {
    throw new Error("媒体分片头长度无效");
  }
  const header = validateHeader(
    JSON.parse(
      new TextDecoder().decode(
        bytes.subarray(
          LEGACY_HEADER_PREFIX_BYTES,
          LEGACY_HEADER_PREFIX_BYTES + headerLength,
        ),
      ),
    ),
  );
  const data = bytes.subarray(LEGACY_HEADER_PREFIX_BYTES + headerLength);
  if (data.byteLength !== header.chunkLength) {
    throw new Error("媒体分片负载长度不匹配");
  }
  return { header, data };
}

export function chunkEmbyFragment(
  fragment: EmbyTransportFragment,
  onlyChunks?: ReadonlySet<number>,
): Array<{ header: EmbyChunkHeader; packet: ArrayBuffer }> {
  if (fragment.data.byteLength > MAX_FRAGMENT_BYTES) {
    throw new Error("单个媒体片段过大");
  }
  const checksum = crc32(fragment.data);
  const chunkCount = Math.max(
    1,
    Math.ceil(fragment.data.byteLength / EMBY_CHUNK_BYTES),
  );
  const packets: Array<{ header: EmbyChunkHeader; packet: ArrayBuffer }> = [];
  for (let index = 0; index < chunkCount; index += 1) {
    if (onlyChunks && !onlyChunks.has(index)) continue;
    const start = index * EMBY_CHUNK_BYTES;
    const payload = fragment.data.subarray(
      start,
      Math.min(fragment.data.byteLength, start + EMBY_CHUNK_BYTES),
    );
    const header: EmbyChunkHeader = {
      protocol: EMBY_PROTOCOL_VERSION,
      roomId: fragment.roomId,
      sessionId: fragment.sessionId,
      mediaVersion: fragment.mediaVersion,
      transportEpoch:
        fragment.transportEpoch === undefined
          ? 0
          : Number(fragment.transportEpoch),
      fragmentSeq: fragment.sequence,
      chunkIndex: index,
      chunkCount,
      timestampMs: fragment.timestampMs,
      mediaTimeMs: fragment.mediaTimeMs,
      timelineTimeMs:
        fragment.timelineTimeMs === undefined
          ? undefined
          : Number(fragment.timelineTimeMs),
      trackType: fragment.trackType,
      keyframe: fragment.keyframe,
      dataLength: fragment.data.byteLength,
      chunkLength: payload.byteLength,
      checksum,
    };
    packets.push({ header, packet: encodeEmbyChunk(header, payload) });
  }
  return packets;
}

interface CachedFragment {
  fragment: EmbyTransportFragment;
  cachedAt: number;
}

export class EmbyFragmentCache {
  private fragments = new Map<string, CachedFragment>();
  private init?: CachedFragment;
  // Init is retained separately for late joiners and does not participate in
  // the rolling media-fragment byte budget.
  private fragmentBytes = 0;

  constructor(
    private maxAgeMs = 120_000,
    private maxBytes = 256 * 1024 * 1024,
  ) {}

  configureLimits(maxAgeMs: number, maxBytes: number): void {
    this.maxAgeMs = Math.max(15_000, Math.min(180_000, Number(maxAgeMs) || 0));
    this.maxBytes = Math.max(
      32 * 1024 * 1024,
      Math.min(384 * 1024 * 1024, Number(maxBytes) || 0),
    );
    this.prune();
  }

  get cachedBytes(): number {
    return this.fragmentBytes;
  }

  private key(version: number, sequence: number, trackType: EmbyTrackType): string {
    return `${version}:${trackType}:${sequence}`;
  }

  setInit(fragment: EmbyTransportFragment): void {
    this.init = { fragment, cachedAt: Date.now() };
    this.prune();
  }

  getInit(version: number): EmbyTransportFragment | undefined {
    return this.init?.fragment.mediaVersion === version
      ? this.init.fragment
      : undefined;
  }

  add(fragment: EmbyTransportFragment): void {
    const key = this.key(
      fragment.mediaVersion,
      fragment.sequence,
      fragment.trackType,
    );
    const existing = this.fragments.get(key);
    if (existing) this.fragmentBytes -= existing.fragment.data.byteLength;
    this.fragments.set(key, { fragment, cachedAt: Date.now() });
    this.fragmentBytes += fragment.data.byteLength;
    this.prune();
  }

  get(
    version: number,
    sequence: number,
    trackType: EmbyTrackType = "muxed",
  ): EmbyTransportFragment | undefined {
    return this.fragments.get(this.key(version, sequence, trackType))?.fragment;
  }

  after(
    version: number,
    mediaTimeMs: number,
    limit = 48,
  ): EmbyTransportFragment[] {
    const candidates = [...this.fragments.values()]
      .map(({ fragment }) => fragment)
      .filter(
        (fragment) =>
          fragment.mediaVersion === version &&
          fragment.trackType === "muxed",
      )
      .sort((left, right) => left.sequence - right.sequence);
    if (!candidates.length) return [];
    let start = candidates.findIndex(
      (fragment) => fragment.mediaTimeMs >= mediaTimeMs,
    );
    if (start < 0) start = candidates.length - 1;
    while (start > 0 && !candidates[start].keyframe) start -= 1;
    if (!candidates[start].keyframe) {
      const nextKeyframe = candidates.findIndex(
        (fragment, index) => index >= start && fragment.keyframe,
      );
      if (nextKeyframe >= 0) start = nextKeyframe;
    }
    return candidates.slice(start, start + limit);
  }

  clearVersion(version?: number): void {
    if (version === undefined) {
      this.fragments.clear();
      this.init = undefined;
      this.fragmentBytes = 0;
      return;
    }
    for (const [key, entry] of this.fragments) {
      if (entry.fragment.mediaVersion !== version) {
        this.fragmentBytes -= entry.fragment.data.byteLength;
        this.fragments.delete(key);
      }
    }
    if (this.init && this.init.fragment.mediaVersion !== version) {
      this.init = undefined;
    }
  }

  private prune(): void {
    const expiry = Date.now() - this.maxAgeMs;
    for (const [key, entry] of this.fragments) {
      if (entry.cachedAt < expiry) {
        this.fragmentBytes -= entry.fragment.data.byteLength;
        this.fragments.delete(key);
      }
    }
    while (this.fragmentBytes > this.maxBytes && this.fragments.size) {
      const first = this.fragments.entries().next().value as
        | [string, CachedFragment]
        | undefined;
      if (!first) break;
      this.fragments.delete(first[0]);
      this.fragmentBytes -= first[1].fragment.data.byteLength;
    }
  }
}

interface QueuedPacket {
  packet: string | ArrayBuffer;
  bytes: number;
  mediaVersion?: number;
  transportEpoch?: number;
  fragmentSeq?: number;
  chunkIndex?: number;
  mediaTimeMs?: number;
  trackType?: EmbyTrackType;
  priority: boolean;
  packetKey?: string;
  fragmentKey?: string;
  cancelled?: boolean;
}

interface QueuedFragment {
  items: QueuedPacket[];
  activeItems: number;
  mediaTimeMs?: number;
  mediaBytes: number;
}

const COALESCED_CONTROL_TYPES = new Set<EmbyControlMessage["type"]>([
  "playback-state",
  "buffer-state",
  "sync-ping",
  "sync-pong",
  "catch-up",
  "resync",
]);
const MAX_QUEUED_CONTROL_BYTES = 1024 * 1024;

export class EmbyPeerSender {
  private priorityQueue: QueuedPacket[] = [];
  private priorityHead = 0;
  private normalQueue: QueuedPacket[] = [];
  private normalHead = 0;
  private queuedMessages = 0;
  private queuedBytes = 0;
  private queuedMediaBytes = 0;
  private readonly packetKeys = new Set<string>();
  private readonly queuedFragments = new Map<string, QueuedFragment>();
  private fragmentOrder: string[] = [];
  private fragmentOrderHead = 0;
  private readonly mediaTimeCounts = new Map<number, number>();
  private minimumMediaTimeMs?: number;
  private maximumMediaTimeMs?: number;
  private controlEssentialQueue: string[] = [];
  private controlEssentialHead = 0;
  private controlTypeOrder: EmbyControlMessage["type"][] = [];
  private controlTypeHead = 0;
  private readonly latestControlByType = new Map<
    EmbyControlMessage["type"],
    string
  >();
  private queuedControlBytes = 0;
  private droppedFragments = 0;
  private pumping = false;
  private closed = false;
  private mediaClosed = false;
  private controlClosed = false;
  private estimatedMediaBytesPerMs = EMBY_INITIAL_MEDIA_BYTES_PER_MS;
  private previousMediaSample?: {
    mediaVersion: number;
    mediaTimeMs: number;
    bytes: number;
  };
  private readonly onBufferedLow = () => this.pump();
  private readonly onOpen = () => this.pump();
  private readonly onControlOpen = () => this.pumpControls();
  private readonly onControlClose = () => {
    this.controlClosed = true;
    this.clearControlQueue();
    if (this.controlChannel === this.channel) {
      this.markMediaClosed();
    }
    this.publishStats();
  };
  private readonly onMediaClose = () => {
    this.markMediaClosed();
    if (this.controlChannel === this.channel) {
      this.controlClosed = true;
      this.clearControlQueue();
    }
    this.publishStats();
  };
  private readonly onMessage = (event: MessageEvent) => {
    if (
      typeof event.data !== "string" ||
      event.data.length > 16 * 1024
    ) {
      return;
    }
    try {
      const message = JSON.parse(event.data) as EmbyControlMessage;
      if (
        !message ||
        typeof message !== "object" ||
        typeof message.type !== "string"
      ) {
        return;
      }
      this.controlHandler?.(message);
    } catch {
      // Invalid control messages never enter the media pipeline.
    }
  };

  constructor(
    readonly channel: RTCDataChannel,
    private readonly controlHandler?: (message: EmbyControlMessage) => void,
    private readonly statsHandler?: (stats: EmbySenderStats) => void,
    readonly controlChannel: RTCDataChannel = channel,
  ) {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = Math.min(
      EMBY_BUFFER_LOW_WATER,
      Math.floor(this.bufferHighWaterBytes / 4),
    );
    channel.addEventListener("bufferedamountlow", this.onBufferedLow);
    channel.addEventListener("open", this.onOpen);
    controlChannel.addEventListener("open", this.onControlOpen);
    controlChannel.addEventListener("message", this.onMessage);
    controlChannel.addEventListener("close", this.onControlClose);
    channel.addEventListener("close", this.onMediaClose);
  }

  sendControl(message: EmbyControlMessage, priority = true): void {
    const packet = JSON.stringify(message);
    if (this.controlChannel !== this.channel && priority) {
      if (this.closed || this.controlClosed) return;
      if (this.controlChannel.readyState === "open") {
        try {
          this.controlChannel.send(packet);
          return;
        } catch {
          this.onControlClose();
          return;
        }
      }
      this.enqueueControl(message.type, packet);
      return;
    }
    this.enqueuePacket({
      packet,
      bytes: new TextEncoder().encode(packet).byteLength,
      priority,
    });
  }

  sendFragment(
    fragment: EmbyTransportFragment,
    options: {
      priority?: boolean;
      onlyChunks?: number[];
      transportEpoch?: number;
    } = {},
  ): void {
    if (this.closed || this.mediaClosed) return;
    const onlyChunks = options.onlyChunks
      ? new Set(options.onlyChunks)
      : undefined;
    const outboundFragment: EmbyTransportFragment = {
      ...fragment,
      transportEpoch:
        options.transportEpoch ?? fragment.transportEpoch ?? 0,
    };
    if (!onlyChunks && fragment.trackType === "muxed" && fragment.sequence > 0) {
      this.observeMediaFragment(fragment);
    }
    for (const { header, packet } of chunkEmbyFragment(
      outboundFragment,
      onlyChunks,
    )) {
      this.enqueuePacket({
        packet,
        bytes: packet.byteLength,
        mediaVersion: fragment.mediaVersion,
        transportEpoch: outboundFragment.transportEpoch,
        fragmentSeq: fragment.sequence,
        chunkIndex: header.chunkIndex,
        mediaTimeMs: fragment.mediaTimeMs,
        trackType: fragment.trackType,
        priority: options.priority === true,
      });
    }
  }

  setMediaBitrate(bitsPerSecond: number): void {
    const bytesPerMs = Number(bitsPerSecond) / 8 / 1_000;
    if (!Number.isFinite(bytesPerMs) || bytesPerMs <= 0) return;
    this.estimatedMediaBytesPerMs = Math.max(
      32,
      Math.min(12_500, bytesPerMs),
    );
    this.channel.bufferedAmountLowThreshold = Math.max(
      64 * 1024,
      Math.floor(this.bufferHighWaterBytes / 4),
    );
    this.dropSlowBacklog();
    this.publishStats();
  }

  cancelVersionsExcept(mediaVersion: number): void {
    this.forEachQueuedPacket((item) => {
      if (
        item.mediaVersion !== undefined &&
        item.mediaVersion !== mediaVersion
      ) {
        this.deactivatePacket(item);
      }
    });
    this.compactPacketQueues();
    this.publishStats();
  }

  clearMediaQueue(): void {
    this.forEachQueuedPacket((item) => {
      if (item.mediaVersion !== undefined) this.deactivatePacket(item);
    });
    this.compactPacketQueues();
    this.publishStats();
  }

  get stats(): EmbySenderStats {
    const queuedDurationByBytes =
      this.queuedMediaBytes / this.estimatedMediaBytesPerMs;
    const queuedDurationByTimeline =
      this.mediaTimeCounts.size > 1 &&
      this.minimumMediaTimeMs !== undefined &&
      this.maximumMediaTimeMs !== undefined
        ? this.maximumMediaTimeMs - this.minimumMediaTimeMs
        : 0;
    const queuedDurationMs = Math.max(
      queuedDurationByBytes,
      queuedDurationByTimeline,
    );
    const bufferedDurationMs =
      this.channel.bufferedAmount / this.estimatedMediaBytesPerMs;
    return {
      queuedBytes: this.queuedBytes,
      bufferedBytes: this.mediaClosed ? 0 : this.channel.bufferedAmount,
      queuedMessages: this.queuedMessages,
      droppedFragments: this.droppedFragments,
      queuedDurationMs,
      bufferedDurationMs,
      totalQueuedDurationMs: queuedDurationMs + bufferedDurationMs,
    };
  }

  get primeBudgetBytes(): number {
    return Math.max(
      8 * 1024 * 1024,
      Math.floor(this.maxQueuedBytes * 0.7),
    );
  }

  private observeMediaFragment(fragment: EmbyTransportFragment): void {
    const previous = this.previousMediaSample;
    if (
      previous &&
      previous.mediaVersion === fragment.mediaVersion &&
      fragment.mediaTimeMs > previous.mediaTimeMs
    ) {
      const durationMs = fragment.mediaTimeMs - previous.mediaTimeMs;
      if (durationMs >= 40 && durationMs <= 30_000 && previous.bytes > 0) {
        const measuredBytesPerMs = Math.min(
          12_500,
          Math.max(32, previous.bytes / durationMs),
        );
        this.estimatedMediaBytesPerMs =
          this.estimatedMediaBytesPerMs * 0.65 +
          measuredBytesPerMs * 0.35;
      }
    } else if (
      previous &&
      previous.mediaVersion !== fragment.mediaVersion
    ) {
      this.estimatedMediaBytesPerMs = EMBY_INITIAL_MEDIA_BYTES_PER_MS;
    }
    this.previousMediaSample = {
      mediaVersion: fragment.mediaVersion,
      mediaTimeMs: fragment.mediaTimeMs,
      bytes: fragment.data.byteLength,
    };
    this.channel.bufferedAmountLowThreshold = Math.max(
      16 * 1024,
      Math.min(
        EMBY_BUFFER_LOW_WATER,
        Math.floor(this.bufferHighWaterBytes / 4),
      ),
    );
  }

  private get bufferHighWaterBytes(): number {
    return Math.max(
      256 * 1024,
      Math.min(
        EMBY_BUFFER_HIGH_WATER,
        Math.floor(this.estimatedMediaBytesPerMs * 400),
      ),
    );
  }

  private get maxQueuedBytes(): number {
    return Math.max(
      16 * 1024 * 1024,
      Math.min(
        96 * 1024 * 1024,
        Math.floor(this.estimatedMediaBytesPerMs * 12_000),
      ),
    );
  }

  private enqueuePacket(item: QueuedPacket): void {
    if (this.closed || this.mediaClosed) return;
    if (
      item.fragmentSeq !== undefined &&
      item.chunkIndex !== undefined &&
      item.mediaVersion !== undefined
    ) {
      item.packetKey =
        `${item.mediaVersion}:${item.transportEpoch ?? 0}:` +
        `${item.trackType ?? "muxed"}:${item.fragmentSeq}:${item.chunkIndex}`;
      if (this.packetKeys.has(item.packetKey)) return;
      this.packetKeys.add(item.packetKey);
      if (item.fragmentSeq > 0) {
        item.fragmentKey =
          `${item.mediaVersion}:${item.transportEpoch ?? 0}:` +
          `${item.trackType ?? "muxed"}:${item.fragmentSeq}`;
      }
    }
    if (item.priority) {
      this.priorityQueue.push(item);
    } else {
      this.normalQueue.push(item);
    }
    this.queuedMessages += 1;
    this.queuedBytes += item.bytes;
    const isTimedMedia =
      item.trackType === "muxed" &&
      item.fragmentSeq !== undefined &&
      item.fragmentSeq > 0 &&
      Number.isFinite(item.mediaTimeMs);
    if (isTimedMedia) this.queuedMediaBytes += item.bytes;
    if (item.fragmentKey) {
      let fragment = this.queuedFragments.get(item.fragmentKey);
      if (!fragment) {
        fragment = {
          items: [],
          activeItems: 0,
          mediaTimeMs: isTimedMedia ? item.mediaTimeMs : undefined,
          mediaBytes: 0,
        };
        this.queuedFragments.set(item.fragmentKey, fragment);
        this.fragmentOrder.push(item.fragmentKey);
        if (fragment.mediaTimeMs !== undefined) {
          this.addMediaTime(fragment.mediaTimeMs);
        }
      }
      fragment.items.push(item);
      fragment.activeItems += 1;
      if (isTimedMedia) fragment.mediaBytes += item.bytes;
    }
    this.dropSlowBacklog();
    this.publishStats();
    this.pump();
  }

  private dropSlowBacklog(): void {
    // Keep enough encoded media to absorb a short Wi-Fi/TURN fluctuation, but
    // derive the byte ceiling from the actual stream bitrate. A fixed 16 MiB
    // queue represented 50+ seconds at 2.5 Mbps yet less than three seconds
    // for a 4K original, causing its startup/seek burst to be discarded.
    const maxQueued = this.maxQueuedBytes;
    if (this.queuedBytes <= maxQueued) return;
    const lowWater = Math.max(
      8 * 1024 * 1024,
      Math.floor(maxQueued * 0.65),
    );
    while (this.queuedBytes > lowWater) {
      const fragmentKey = this.nextQueuedFragmentKey();
      if (!fragmentKey) break;
      if (this.cancelFragment(fragmentKey)) {
        this.droppedFragments += 1;
      }
    }
    if (this.queuedBytes > maxQueued) {
      // Only init/control packets can remain here. A legitimate init segment
      // is tiny; exceeding the hard ceiling indicates a broken or abusive
      // peer repair loop. Drop this peer rather than risking renderer OOM.
      this.markMediaClosed();
      if (this.channel.readyState !== "closed") this.channel.close();
    }
    this.compactPacketQueues();
  }

  private pump(): void {
    if (
      this.pumping ||
      this.closed ||
      this.mediaClosed ||
      this.channel.readyState !== "open"
    ) {
      return;
    }
    this.pumping = true;
    try {
      while (
        this.queuedMessages &&
        this.channel.bufferedAmount < this.bufferHighWaterBytes
      ) {
        const item = this.takeNextPacket();
        if (!item) break;
        try {
          (
            this.channel.send as (packet: string | ArrayBuffer) => void
          )(item.packet);
        } catch {
          this.markMediaClosed();
          break;
        }
      }
    } finally {
      this.pumping = false;
      this.compactPacketQueues();
      this.publishStats();
    }
  }

  private pumpControls(): void {
    if (
      this.closed ||
      this.controlClosed ||
      this.controlChannel.readyState !== "open"
    ) {
      return;
    }
    while (this.hasQueuedControls()) {
      const packet = this.takeNextControl();
      if (!packet) break;
      try {
        this.controlChannel.send(packet);
      } catch {
        this.onControlClose();
        return;
      }
    }
  }

  private publishStats(): void {
    this.statsHandler?.(this.stats);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener("bufferedamountlow", this.onBufferedLow);
    this.channel.removeEventListener("open", this.onOpen);
    this.controlChannel.removeEventListener("open", this.onControlOpen);
    this.controlChannel.removeEventListener("message", this.onMessage);
    this.controlChannel.removeEventListener("close", this.onControlClose);
    this.channel.removeEventListener("close", this.onMediaClose);
    this.markMediaClosed();
    this.controlClosed = true;
    this.clearControlQueue();
    if (this.channel.readyState !== "closed") this.channel.close();
    if (
      this.controlChannel !== this.channel &&
      this.controlChannel.readyState !== "closed"
    ) {
      this.controlChannel.close();
    }
  }

  private enqueueControl(
    type: EmbyControlMessage["type"],
    packet: string,
  ): void {
    const bytes = new TextEncoder().encode(packet).byteLength;
    if (COALESCED_CONTROL_TYPES.has(type)) {
      const previous = this.latestControlByType.get(type);
      if (previous === undefined) this.controlTypeOrder.push(type);
      else {
        this.queuedControlBytes -=
          new TextEncoder().encode(previous).byteLength;
      }
      this.latestControlByType.set(type, packet);
      this.queuedControlBytes += bytes;
    } else {
      this.controlEssentialQueue.push(packet);
      this.queuedControlBytes += bytes;
    }
    if (this.queuedControlBytes > MAX_QUEUED_CONTROL_BYTES) {
      this.controlClosed = true;
      this.clearControlQueue();
      if (this.controlChannel.readyState !== "closed") {
        this.controlChannel.close();
      }
    }
  }

  private hasQueuedControls(): boolean {
    return (
      this.controlEssentialHead < this.controlEssentialQueue.length ||
      this.controlTypeHead < this.controlTypeOrder.length
    );
  }

  private takeNextControl(): string | undefined {
    if (this.controlEssentialHead < this.controlEssentialQueue.length) {
      const packet =
        this.controlEssentialQueue[this.controlEssentialHead++];
      this.queuedControlBytes = Math.max(
        0,
        this.queuedControlBytes -
          new TextEncoder().encode(packet).byteLength,
      );
      this.compactControlQueues();
      return packet;
    }
    while (this.controlTypeHead < this.controlTypeOrder.length) {
      const type = this.controlTypeOrder[this.controlTypeHead++];
      const packet = this.latestControlByType.get(type);
      this.latestControlByType.delete(type);
      if (!packet) continue;
      this.queuedControlBytes = Math.max(
        0,
        this.queuedControlBytes -
          new TextEncoder().encode(packet).byteLength,
      );
      this.compactControlQueues();
      return packet;
    }
    this.compactControlQueues();
    return undefined;
  }

  private clearControlQueue(): void {
    this.controlEssentialQueue = [];
    this.controlEssentialHead = 0;
    this.controlTypeOrder = [];
    this.controlTypeHead = 0;
    this.latestControlByType.clear();
    this.queuedControlBytes = 0;
  }

  private compactControlQueues(): void {
    if (
      this.controlEssentialHead > 256 &&
      this.controlEssentialHead * 2 >= this.controlEssentialQueue.length
    ) {
      this.controlEssentialQueue = this.controlEssentialQueue.slice(
        this.controlEssentialHead,
      );
      this.controlEssentialHead = 0;
    }
    if (
      this.controlTypeHead > 64 &&
      this.controlTypeHead * 2 >= this.controlTypeOrder.length
    ) {
      this.controlTypeOrder = this.controlTypeOrder.slice(
        this.controlTypeHead,
      );
      this.controlTypeHead = 0;
    }
  }

  private takeNextPacket(): QueuedPacket | undefined {
    const take = (
      queue: QueuedPacket[],
      head: "priorityHead" | "normalHead",
    ): QueuedPacket | undefined => {
      while (this[head] < queue.length) {
        const item = queue[this[head]++];
        if (item.cancelled) continue;
        this.deactivatePacket(item);
        return item;
      }
      return undefined;
    };
    return (
      take(this.priorityQueue, "priorityHead") ||
      take(this.normalQueue, "normalHead")
    );
  }

  private forEachQueuedPacket(
    callback: (item: QueuedPacket) => void,
  ): void {
    for (
      let index = this.priorityHead;
      index < this.priorityQueue.length;
      index += 1
    ) {
      const item = this.priorityQueue[index];
      if (!item.cancelled) callback(item);
    }
    for (
      let index = this.normalHead;
      index < this.normalQueue.length;
      index += 1
    ) {
      const item = this.normalQueue[index];
      if (!item.cancelled) callback(item);
    }
  }

  private deactivatePacket(item: QueuedPacket): void {
    if (item.cancelled) return;
    item.cancelled = true;
    this.queuedMessages = Math.max(0, this.queuedMessages - 1);
    this.queuedBytes = Math.max(0, this.queuedBytes - item.bytes);
    if (item.packetKey) this.packetKeys.delete(item.packetKey);
    const isTimedMedia =
      item.trackType === "muxed" &&
      item.fragmentSeq !== undefined &&
      item.fragmentSeq > 0 &&
      Number.isFinite(item.mediaTimeMs);
    if (isTimedMedia) {
      this.queuedMediaBytes = Math.max(
        0,
        this.queuedMediaBytes - item.bytes,
      );
    }
    if (!item.fragmentKey) return;
    const fragment = this.queuedFragments.get(item.fragmentKey);
    if (!fragment) return;
    fragment.activeItems = Math.max(0, fragment.activeItems - 1);
    if (isTimedMedia) {
      fragment.mediaBytes = Math.max(0, fragment.mediaBytes - item.bytes);
    }
    if (fragment.activeItems > 0) return;
    this.queuedFragments.delete(item.fragmentKey);
    if (fragment.mediaTimeMs !== undefined) {
      this.removeMediaTime(fragment.mediaTimeMs);
    }
  }

  private cancelFragment(fragmentKey: string): boolean {
    const fragment = this.queuedFragments.get(fragmentKey);
    if (!fragment) return false;
    let removed = false;
    for (const item of fragment.items) {
      if (item.cancelled) continue;
      removed = true;
      this.deactivatePacket(item);
    }
    return removed;
  }

  private nextQueuedFragmentKey(): string | undefined {
    while (this.fragmentOrderHead < this.fragmentOrder.length) {
      const key = this.fragmentOrder[this.fragmentOrderHead++];
      if (this.queuedFragments.has(key)) return key;
    }
    this.fragmentOrder = [];
    this.fragmentOrderHead = 0;
    return undefined;
  }

  private addMediaTime(mediaTimeMs: number): void {
    this.mediaTimeCounts.set(
      mediaTimeMs,
      (this.mediaTimeCounts.get(mediaTimeMs) || 0) + 1,
    );
    this.minimumMediaTimeMs =
      this.minimumMediaTimeMs === undefined
        ? mediaTimeMs
        : Math.min(this.minimumMediaTimeMs, mediaTimeMs);
    this.maximumMediaTimeMs =
      this.maximumMediaTimeMs === undefined
        ? mediaTimeMs
        : Math.max(this.maximumMediaTimeMs, mediaTimeMs);
  }

  private removeMediaTime(mediaTimeMs: number): void {
    const count = this.mediaTimeCounts.get(mediaTimeMs) || 0;
    if (count > 1) {
      this.mediaTimeCounts.set(mediaTimeMs, count - 1);
      return;
    }
    this.mediaTimeCounts.delete(mediaTimeMs);
    if (!this.mediaTimeCounts.size) {
      this.minimumMediaTimeMs = undefined;
      this.maximumMediaTimeMs = undefined;
      return;
    }
    if (
      mediaTimeMs !== this.minimumMediaTimeMs &&
      mediaTimeMs !== this.maximumMediaTimeMs
    ) {
      return;
    }
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const time of this.mediaTimeCounts.keys()) {
      minimum = Math.min(minimum, time);
      maximum = Math.max(maximum, time);
    }
    this.minimumMediaTimeMs = minimum;
    this.maximumMediaTimeMs = maximum;
  }

  private compactPacketQueues(): void {
    if (
      this.priorityHead > 1_024 &&
      this.priorityHead * 2 >= this.priorityQueue.length
    ) {
      this.priorityQueue = this.priorityQueue.slice(this.priorityHead);
      this.priorityHead = 0;
    }
    if (
      this.normalHead > 1_024 &&
      this.normalHead * 2 >= this.normalQueue.length
    ) {
      this.normalQueue = this.normalQueue.slice(this.normalHead);
      this.normalHead = 0;
    }
    if (
      this.fragmentOrderHead > 1_024 &&
      this.fragmentOrderHead * 2 >= this.fragmentOrder.length
    ) {
      this.fragmentOrder = this.fragmentOrder.slice(this.fragmentOrderHead);
      this.fragmentOrderHead = 0;
    }
  }

  private markMediaClosed(): void {
    if (this.mediaClosed) return;
    this.mediaClosed = true;
    this.forEachQueuedPacket((item) => this.deactivatePacket(item));
    this.priorityQueue = [];
    this.priorityHead = 0;
    this.normalQueue = [];
    this.normalHead = 0;
    this.packetKeys.clear();
    this.queuedFragments.clear();
    this.fragmentOrder = [];
    this.fragmentOrderHead = 0;
    this.mediaTimeCounts.clear();
    this.minimumMediaTimeMs = undefined;
    this.maximumMediaTimeMs = undefined;
    this.queuedMessages = 0;
    this.queuedBytes = 0;
    this.queuedMediaBytes = 0;
  }
}

interface PendingAssembly {
  header: EmbyChunkHeader;
  chunks: Array<Uint8Array | undefined>;
  receivedChunks: number;
  receivedBytes: number;
  timer?: number;
  lastRequestAt: number;
  createdAt: number;
  requests: number;
}

export interface EmbyAssemblyAbandonment {
  mediaVersion: number;
  fragmentSeq: number;
  trackType: EmbyTrackType;
  transportEpoch: number;
  keyframe: boolean;
  reason: "capacity" | "header-conflict" | "repair-exhausted";
}

export class EmbyFragmentAssembler {
  private pending = new Map<string, PendingAssembly>();
  private pendingDeclaredBytes = 0;
  private activeTransportEpoch: number;

  constructor(
    private readonly expected: {
      roomId: string;
      sessionId: string;
      mediaVersion: number;
      transportEpoch?: number;
    },
    private readonly onFragment: (fragment: EmbyTransportFragment) => void,
    private readonly onMissing: (
      version: number,
      sequence: number,
      trackType: EmbyTrackType,
      missing: number[],
      transportEpoch: number,
    ) => void,
    private readonly onEpochAdvance?: (transportEpoch: number) => boolean,
    private readonly onAbandoned?: (
      detail: EmbyAssemblyAbandonment,
    ) => void,
  ) {
    const initialEpoch = Number(expected.transportEpoch ?? 0);
    this.activeTransportEpoch =
      Number.isSafeInteger(initialEpoch) &&
      initialEpoch >= 0 &&
      initialEpoch <= 1_000_000_000
        ? initialEpoch
        : 0;
  }

  get transportEpoch(): number {
    return this.activeTransportEpoch;
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  advanceTransportEpoch(transportEpoch: number): boolean {
    if (
      !Number.isSafeInteger(transportEpoch) ||
      transportEpoch < this.activeTransportEpoch ||
      transportEpoch > 1_000_000_000
    ) {
      return false;
    }
    if (transportEpoch === this.activeTransportEpoch) return true;
    this.reset();
    this.activeTransportEpoch = transportEpoch;
    return true;
  }

  accept(input: ArrayBuffer | Uint8Array): void {
    const { header, data } = decodeEmbyChunk(input);
    if (
      header.roomId !== this.expected.roomId ||
      header.sessionId !== this.expected.sessionId ||
      header.mediaVersion !== this.expected.mediaVersion
    ) {
      return;
    }
    if (header.transportEpoch < this.activeTransportEpoch) return;
    if (header.transportEpoch > this.activeTransportEpoch) {
      if (!this.onEpochAdvance?.(header.transportEpoch)) return;
      this.reset();
      this.activeTransportEpoch = header.transportEpoch;
    }
    const key =
      `${header.mediaVersion}:${header.transportEpoch}:` +
      `${header.trackType}:${header.fragmentSeq}`;
    let assembly = this.pending.get(key);
    if (!assembly) {
      while (
        this.pending.size >= MAX_PENDING_ASSEMBLIES ||
        (this.pending.size > 0 &&
          this.pendingDeclaredBytes + header.dataLength >
            MAX_PENDING_ASSEMBLY_BYTES)
      ) {
        const oldest = this.pending.keys().next().value as string | undefined;
        if (oldest) this.abandonAssembly(oldest, "capacity");
        else break;
      }
      assembly = {
        header,
        chunks: new Array<Uint8Array | undefined>(
          header.chunkCount,
        ).fill(undefined),
        receivedChunks: 0,
        receivedBytes: 0,
        lastRequestAt: 0,
        createdAt: performance.now(),
        requests: 0,
      };
      this.pending.set(key, assembly);
      this.pendingDeclaredBytes += header.dataLength;
    }
    if (
      assembly.header.chunkCount !== header.chunkCount ||
      assembly.header.checksum !== header.checksum ||
      assembly.header.dataLength !== header.dataLength ||
      assembly.header.timelineTimeMs !== header.timelineTimeMs
    ) {
      this.abandonAssembly(key, "header-conflict");
      return;
    }
    if (!assembly.chunks[header.chunkIndex]) {
      assembly.chunks[header.chunkIndex] = data;
      assembly.receivedChunks += 1;
      assembly.receivedBytes += data.byteLength;
    }
    if (assembly.receivedChunks === assembly.chunks.length) {
      if (assembly.timer !== undefined) window.clearTimeout(assembly.timer);
      this.pending.delete(key);
      this.pendingDeclaredBytes = Math.max(
        0,
        this.pendingDeclaredBytes - assembly.header.dataLength,
      );
      const complete = new Uint8Array(assembly.receivedBytes);
      let offset = 0;
      for (const chunk of assembly.chunks) {
        complete.set(chunk!, offset);
        offset += chunk!.byteLength;
      }
      if (
        complete.byteLength !== header.dataLength ||
        crc32(complete) !== header.checksum
      ) {
        this.onMissing(
          header.mediaVersion,
          header.fragmentSeq,
          header.trackType,
          assembly.chunks.map((_chunk, index) => index),
          header.transportEpoch,
        );
        return;
      }
      this.onFragment({
        roomId: header.roomId,
        sessionId: header.sessionId,
        mediaVersion: header.mediaVersion,
        transportEpoch: header.transportEpoch,
        sequence: header.fragmentSeq,
        timestampMs: header.timestampMs,
        mediaTimeMs: header.mediaTimeMs,
        timelineTimeMs: header.timelineTimeMs,
        trackType: header.trackType,
        keyframe: header.keyframe,
        data: complete,
      });
      return;
    }
    this.armMissingRequest(key, assembly);
  }

  reset(): void {
    for (const key of this.pending.keys()) this.clearAssembly(key);
  }

  private armMissingRequest(key: string, assembly: PendingAssembly): void {
    if (assembly.timer !== undefined) return;
    assembly.timer = window.setTimeout(() => {
      assembly.timer = undefined;
      if (!this.pending.has(key)) return;
      const now = performance.now();
      if (
        now - assembly.createdAt > RELIABLE_REPAIR_LIFETIME_MS ||
        assembly.requests >= MAX_RELIABLE_REPAIR_REQUESTS
      ) {
        this.abandonAssembly(key, "repair-exhausted");
        return;
      }
      if (now - assembly.lastRequestAt < 500) {
        // A throttled wake-up is still a failed repair observation. Count it
        // toward the absolute retry budget so repeated re-arming cannot keep
        // a broken assembly alive indefinitely.
        assembly.requests += 1;
        if (assembly.requests >= MAX_RELIABLE_REPAIR_REQUESTS) {
          this.abandonAssembly(key, "repair-exhausted");
          return;
        }
        this.armMissingRequest(key, assembly);
        return;
      }
      assembly.lastRequestAt = now;
      const missing = assembly.chunks
        .map((chunk, index) => (chunk ? -1 : index))
        .filter((index) => index >= 0);
      if (missing.length) {
        assembly.requests += 1;
        this.onMissing(
          assembly.header.mediaVersion,
          assembly.header.fragmentSeq,
          assembly.header.trackType,
          missing,
          assembly.header.transportEpoch,
        );
        this.armMissingRequest(key, assembly);
      }
    }, 800);
  }

  private abandonAssembly(
    key: string,
    reason: EmbyAssemblyAbandonment["reason"],
  ): void {
    const assembly = this.pending.get(key);
    if (!assembly) return;
    const { header } = assembly;
    this.clearAssembly(key);
    this.onAbandoned?.({
      mediaVersion: header.mediaVersion,
      fragmentSeq: header.fragmentSeq,
      trackType: header.trackType,
      transportEpoch: header.transportEpoch,
      keyframe: header.keyframe,
      reason,
    });
  }

  private clearAssembly(key: string): void {
    const assembly = this.pending.get(key);
    if (assembly?.timer !== undefined) window.clearTimeout(assembly.timer);
    if (this.pending.delete(key) && assembly) {
      this.pendingDeclaredBytes = Math.max(
        0,
        this.pendingDeclaredBytes - assembly.header.dataLength,
      );
    }
  }
}

export function detectEmbyMediaCapabilities(): {
  mse: boolean;
  h264: boolean;
  hevc: boolean;
  aac: boolean;
  desktop: boolean;
  videoEnhancementBackends: Array<"webgl2-spatial">;
  maxEnhancementPixels: number;
} {
  const mediaSource = globalThis.MediaSource;
  const supports = (mime: string) =>
    Boolean(mediaSource?.isTypeSupported?.(mime));
  const enhancement = detectVideoEnhancementCapabilities();
  const desktop = Boolean(window.roomDesktop);
  return {
    mse: Boolean(mediaSource),
    h264: supports('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
    hevc:
      supports('video/mp4; codecs="hvc1.1.6.L120.B0, mp4a.40.2"') ||
      supports('video/mp4; codecs="hev1.1.6.L120.B0, mp4a.40.2"'),
    aac: supports('audio/mp4; codecs="mp4a.40.2"'),
    desktop,
    videoEnhancementBackends: desktop ? enhancement.backends : [],
    maxEnhancementPixels: desktop ? enhancement.maxPixels : 0,
  };
}
