import {
  ConnectionState,
  RemoteDataTrack,
  RemoteParticipant,
  RemoteTrack,
  VideoPreset,
  VideoQuality,
  Room,
  RoomEvent,
  Track,
  type LocalDataTrack,
  type LocalTrackPublication,
  type RemoteTrackPublication,
} from "livekit-client";
import {
  resolveSfuScreenSubscription,
  type SfuScreenSubscriptionPreference,
} from "./sfu-screen-policy";

export type { SfuScreenSubscriptionPreference } from "./sfu-screen-policy";

export const SFU_EMBY_MEDIA_TRACK = "synced-emby-media";
export const SFU_EMBY_CONTROL_TRACK = "synced-emby-control";
const SFU_EMBY_VIEWER_CONTROL_TOPIC = "synced:emby-viewer-control";
const DATA_KIND_TEXT = 0;
const DATA_KIND_BINARY = 1;
const SFU_DATA_SEND_TIMEOUT_MS = 5_000;
const SFU_PUBLISH_TIMEOUT_MS = 10_000;
const SFU_TEARDOWN_TIMEOUT_MS = 2_000;
const SFU_DATA_OUTSTANDING_BYTES = 8 * 1024 * 1024;
const SCREEN_VIDEO_TRACK = "synced-screen-video";
const SCREEN_VIDEO_EMERGENCY_TRACK = "synced-screen-video-emergency";
const SCREEN_AUDIO_TRACK = "synced-screen-audio";
const EMERGENCY_VIDEO_WIDTH = 854;
const EMERGENCY_VIDEO_HEIGHT = 480;
const EMERGENCY_VIDEO_FPS = 24;

export function isVerifiedEmergencyTrackSettings(
  settings: MediaTrackSettings | undefined,
): boolean {
  const width = Number(settings?.width);
  const height = Number(settings?.height);
  const frameRate = Number(settings?.frameRate);
  return (
    Number.isFinite(width) &&
    width > 0 &&
    width <= EMERGENCY_VIDEO_WIDTH &&
    Number.isFinite(height) &&
    height > 0 &&
    height <= EMERGENCY_VIDEO_HEIGHT &&
    Number.isFinite(frameRate) &&
    frameRate > 0 &&
    frameRate <= EMERGENCY_VIDEO_FPS + 0.5
  );
}

async function constrainEmergencyTrack(
  track: MediaStreamTrack,
  requestedFrameRate = EMERGENCY_VIDEO_FPS,
): Promise<boolean> {
  try {
    await track.applyConstraints({
      width: {
        ideal: EMERGENCY_VIDEO_WIDTH,
        max: EMERGENCY_VIDEO_WIDTH,
      },
      height: {
        ideal: EMERGENCY_VIDEO_HEIGHT,
        max: EMERGENCY_VIDEO_HEIGHT,
      },
      frameRate: {
        ideal: Math.min(EMERGENCY_VIDEO_FPS, requestedFrameRate),
        max: Math.min(EMERGENCY_VIDEO_FPS, requestedFrameRate),
      },
    });
  } catch {
    return false;
  }
  return isVerifiedEmergencyTrackSettings(track.getSettings());
}

export interface SfuAccess {
  url: string;
  room: string;
  token: string;
  expiresAt: number;
}

export interface SfuPublishPreset {
  maxBitrate: number;
  frameRate: number;
  contentMode?: "detail" | "motion" | "balanced";
}

export interface SfuScreenReceiverStats {
  timestamp: number;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  framesDecoded: number;
  framesDropped: number;
  framesPerSecond?: number;
  frameWidth?: number;
  frameHeight?: number;
  emergency: boolean;
  jitter?: number;
  currentRoundTripTime?: number;
  availableIncomingBitrate?: number;
}

export interface SfuSessionOptions {
  onStateChange?: (
    state: "connected" | "reconnecting" | "disconnected",
  ) => void;
  onDiagnostic?: (
    event: string,
    detail: Record<string, unknown>,
  ) => void;
  onParticipantDisconnected?: (identity: string) => void;
}

interface ActiveReader {
  cancel: () => Promise<void>;
}

function normalizedAccess(value: SfuAccess | undefined): SfuAccess | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(String(value.url || ""));
    if (!["ws:", "wss:"].includes(url.protocol)) return undefined;
    if (
      !/^[A-Za-z0-9._~-]{1,256}$/.test(String(value.room || "")) ||
      String(value.token || "").split(".").length !== 3
    ) {
      return undefined;
    }
    const expiresAt = Number(value.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) {
      return undefined;
    }
    return {
      url: url.toString().replace(/\/$/u, ""),
      room: value.room,
      token: value.token,
      expiresAt,
    };
  } catch {
    return undefined;
  }
}

function byteView(
  data: string | Blob | ArrayBuffer | ArrayBufferView,
): { kind: number; bytes: Uint8Array } {
  if (typeof data === "string") {
    return { kind: DATA_KIND_TEXT, bytes: new TextEncoder().encode(data) };
  }
  if (data instanceof ArrayBuffer) {
    return { kind: DATA_KIND_BINARY, bytes: new Uint8Array(data) };
  }
  if (ArrayBuffer.isView(data)) {
    return {
      kind: DATA_KIND_BINARY,
      bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    };
  }
  throw new TypeError("Blob messages are not supported by the SFU transport");
}

function framedPayload(
  data: string | Blob | ArrayBuffer | ArrayBufferView,
): Uint8Array<ArrayBuffer> {
  const { kind, bytes } = byteView(data);
  const framed = new Uint8Array(bytes.byteLength + 1);
  framed[0] = kind;
  framed.set(bytes, 1);
  return framed;
}

class SfuRtcDataChannel extends EventTarget {
  readonly binaryType = "arraybuffer";
  readonly id = null;
  readonly label: string;
  readonly maxPacketLifeTime = null;
  readonly maxRetransmits = null;
  readonly negotiated = false;
  readonly ordered = true;
  readonly protocol = "synced-sfu";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "connecting";
  private readonly queue: Uint8Array<ArrayBuffer>[] = [];
  private queueHead = 0;
  private writing = false;
  private readonly epochController = new AbortController();
  private readonly drainWaiters = new Set<() => void>();

  constructor(
    label: string,
    private readonly outbound?: (
      payload: Uint8Array<ArrayBuffer>,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly onFatal?: (error: unknown) => void,
    private readonly onAbort?: () => void,
  ) {
    super();
    this.label = label;
  }

  open(): void {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    queueMicrotask(() => {
      if (this.readyState === "open") this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== "open" || !this.outbound) {
      throw new DOMException("SFU data channel is not open", "InvalidStateError");
    }
    const payload = framedPayload(data);
    if (
      payload.byteLength > SFU_DATA_OUTSTANDING_BYTES ||
      this.bufferedAmount + payload.byteLength >
        SFU_DATA_OUTSTANDING_BYTES
    ) {
      throw new DOMException(
        `SFU ${this.label} writer exceeded its outstanding-byte budget`,
        "QuotaExceededError",
      );
    }
    this.bufferedAmount += payload.byteLength;
    this.queue.push(payload);
    void this.pump();
  }

  receive(payload: Uint8Array): void {
    if (this.readyState !== "open" || payload.byteLength < 1) return;
    const content = payload.subarray(1);
    const data =
      payload[0] === DATA_KIND_TEXT
        ? new TextDecoder().decode(content)
        : content.buffer.slice(
            content.byteOffset,
            content.byteOffset + content.byteLength,
          );
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  receiveText(payload: Uint8Array, viewerId?: string): void {
    if (this.readyState !== "open") return;
    let data = new TextDecoder().decode(payload);
    if (viewerId) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = JSON.stringify({ ...parsed, __sfuViewerId: viewerId });
        }
      } catch {
        return;
      }
    }
    this.dispatchEvent(
      new MessageEvent("message", {
        data,
      }),
    );
  }

  close(): void {
    if (this.readyState === "closed" || this.readyState === "closing") return;
    this.readyState = "closing";
    this.epochController.abort();
    this.onAbort?.();
    this.dropQueuedPayloads();
    queueMicrotask(() => {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    });
  }

  async closeGracefully(timeoutMs = SFU_TEARDOWN_TIMEOUT_MS): Promise<void> {
    if (this.readyState === "closed") return;
    if (this.readyState === "connecting") {
      this.close();
      return;
    }
    this.readyState = "closing";
    await withTimeout(
      this.drain(),
      timeoutMs,
      `SFU ${this.label} writer drain timed out`,
    ).catch(() => {
      this.epochController.abort();
      this.onAbort?.();
      this.dropQueuedPayloads();
    });
    this.epochController.abort();
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  private async pump(): Promise<void> {
    if (this.writing || !this.outbound) return;
    this.writing = true;
    try {
      while (
        this.queueHead < this.queue.length &&
        !this.epochController.signal.aborted
      ) {
        const payload = this.queue[this.queueHead]!;
        try {
          await withTimeout(
            this.outbound(payload, this.epochController.signal),
            SFU_DATA_SEND_TIMEOUT_MS,
            `SFU ${this.label} send timed out`,
            this.epochController.signal,
          );
        } catch (error) {
          if (!this.epochController.signal.aborted) {
            this.dispatchEvent(new Event("error"));
            this.onFatal?.(error);
          }
          this.epochController.abort();
          this.onAbort?.();
          this.dropQueuedPayloads();
          if (
            this.readyState !== "closing" &&
            this.readyState !== "closed"
          ) {
            this.readyState = "closing";
            queueMicrotask(() => {
              if (this.readyState !== "closing") return;
              this.readyState = "closed";
              this.dispatchEvent(new Event("close"));
            });
          }
          break;
        }
        this.queueHead += 1;
        this.releaseBufferedBytes(payload.byteLength);
        if (
          this.queueHead >= 256 &&
          this.queueHead * 2 >= this.queue.length
        ) {
          this.queue.splice(0, this.queueHead);
          this.queueHead = 0;
        }
      }
    } finally {
      this.writing = false;
      if (this.queueHead >= this.queue.length) {
        this.queue.length = 0;
        this.queueHead = 0;
        this.resolveDrainWaiters();
      }
    }
  }

  private drain(): Promise<void> {
    if (!this.writing && this.queueHead >= this.queue.length) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }

  private dropQueuedPayloads(): void {
    let dropped = 0;
    for (let index = this.queueHead; index < this.queue.length; index += 1) {
      dropped += this.queue[index]?.byteLength || 0;
    }
    this.queue.length = 0;
    this.queueHead = 0;
    this.releaseBufferedBytes(dropped);
    // A timed-out LocalDataTrack write may never settle even after unpublish.
    // Closing this epoch makes the queued bytes terminal, so release graceful
    // close waiters instead of retaining a native-writer drain forever.
    this.resolveDrainWaiters();
  }

  private releaseBufferedBytes(byteLength: number): void {
    const previous = this.bufferedAmount;
    this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLength);
    if (
      previous > this.bufferedAmountLowThreshold &&
      this.bufferedAmount <= this.bufferedAmountLowThreshold
    ) {
      this.dispatchEvent(new Event("bufferedamountlow"));
    }
  }

  private resolveDrainWaiters(): void {
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}

function asRtcDataChannel(channel: SfuRtcDataChannel): RTCDataChannel {
  return channel as unknown as RTCDataChannel;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException("SFU watch was cancelled", "AbortError");
  }
  let timeout: number | undefined;
  let handleAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error(message)),
          timeoutMs,
        );
      }),
      ...(signal
        ? [
            new Promise<T>((_resolve, reject) => {
              handleAbort = () =>
                reject(
                  new DOMException(
                    "SFU watch was cancelled",
                    "AbortError",
                  ),
                );
              signal.addEventListener("abort", handleAbort, {
                once: true,
              });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
    if (signal && handleAbort) {
      signal.removeEventListener("abort", handleAbort);
    }
  }
}

export class SfuSession {
  private room?: Room;
  private access?: SfuAccess;
  private connectPromise?: Promise<void>;
  private pendingAccess?: SfuAccess;
  private publishedScreenTracks: MediaStreamTrack[] = [];
  private publishedScreenPublications: LocalTrackPublication[] = [];
  private publishedScreenRoles: Array<"primary" | "emergency" | "audio"> = [];
  private localMediaTrack?: LocalDataTrack;
  private localControlTrack?: LocalDataTrack;
  private hostMediaChannel?: SfuRtcDataChannel;
  private hostControlChannel?: SfuRtcDataChannel;
  private viewerMediaChannel?: SfuRtcDataChannel;
  private viewerControlChannel?: SfuRtcDataChannel;
  private readers: ActiveReader[] = [];
  private watchingBroadcasterId = "";
  private screenWatchStream?: MediaStream;
  private screenPreference: SfuScreenSubscriptionPreference = {};
  private watchAbortController?: AbortController;
  private intentionalDisconnect = false;
  private publicationGeneration = 0;

  constructor(private readonly options: SfuSessionOptions = {}) {}

  get connected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }

  get currentAccess(): SfuAccess | undefined {
    return this.access;
  }

  get publishing(): boolean {
    return Boolean(
      this.publishedScreenTracks.length ||
        this.localMediaTrack ||
        this.localControlTrack,
    );
  }

  async connect(
    accessInput: SfuAccess | undefined,
    iceServers: RTCIceServer[] = [],
  ): Promise<boolean> {
    const access = normalizedAccess(accessInput);
    if (!access) return false;
    if (
      this.connected &&
      this.access?.url === access.url &&
      this.access?.room === access.room
    ) {
      // A refreshed token is only needed for the next reconnect. Do not tear
      // down a healthy room merely because the token used for the original
      // WebSocket is nearing expiry.
      this.access = access;
      return true;
    }
    if (this.connectPromise) {
      const pending = this.connectPromise;
      const pendingAccess = this.pendingAccess;
      await pending;
      if (
        this.connected &&
        pendingAccess?.url === access.url &&
        pendingAccess.room === access.room
      ) {
        this.access = access;
        return true;
      }
      // The desired SFU room changed while the previous connect was pending,
      // or that attempt failed. Start a fresh, serialized attempt instead of
      // reporting an unrelated room as connected.
      return this.connect(access, iceServers);
    }
    await this.disconnect();
    this.intentionalDisconnect = false;
    this.access = access;
    const room = new Room({
      adaptiveStream: false,
      dynacast: true,
      disconnectOnPageLeave: true,
      stopLocalTrackOnUnpublish: false,
      publishDefaults: {
        simulcast: true,
        videoCodec: "h264",
        degradationPreference: "maintain-resolution",
      },
    });
    this.room = room;
    this.pendingAccess = access;
    room.on(RoomEvent.Reconnecting, () => {
      if (this.room !== room) return;
      this.options.onStateChange?.("reconnecting");
    });
    room.on(RoomEvent.Reconnected, () => {
      if (this.room !== room) return;
      this.options.onStateChange?.("connected");
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      if (this.room !== room) return;
      this.options.onDiagnostic?.("sfu-disconnected", {
        reason: reason === undefined ? "unknown" : String(reason),
        intentional: this.intentionalDisconnect,
      });
      if (!this.intentionalDisconnect) {
        this.options.onStateChange?.("disconnected");
        // RoomEvent.Disconnected is terminal (temporary transport loss uses
        // Reconnecting). Release local clones/readers immediately so a
        // delayed retry cannot keep sending into a dead room.
        void Promise.all([
          this.stopWatching(),
          this.stopPublishing(),
        ]).catch(() => undefined);
      }
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (this.room !== room) return;
      this.options.onParticipantDisconnected?.(participant.identity);
    });
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (this.room !== room) return;
      if (
        topic === SFU_EMBY_VIEWER_CONTROL_TOPIC &&
        participant &&
        this.hostControlChannel?.readyState === "open"
      ) {
        this.hostControlChannel.receiveText(payload, participant.identity);
      }
    });
    const connecting = room.connect(access.url, access.token, {
      autoSubscribe: true,
      maxRetries: 1,
      peerConnectionTimeout: 8_000,
      websocketTimeout: 8_000,
      ...(iceServers.length
        ? {
            rtcConfig: {
              iceServers,
              iceCandidatePoolSize: 2,
            },
          }
        : {}),
    });
    this.connectPromise = withTimeout(
      connecting,
      12_000,
      "SFU connection timed out",
    )
      .then(async () => {
        if (this.room !== room) {
          await withTimeout(
            room.disconnect(false),
            SFU_TEARDOWN_TIMEOUT_MS,
            "stale SFU connection cleanup timed out",
          ).catch(() => undefined);
          return;
        }
        this.options.onDiagnostic?.("sfu-connected", {
          url: access.url,
          room: access.room,
        });
        this.options.onStateChange?.("connected");
      })
      .catch(async (error) => {
        if (this.room === room) {
          this.options.onDiagnostic?.("sfu-connect-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          this.intentionalDisconnect = true;
          void connecting
            .then(() =>
              withTimeout(
                room.disconnect(false),
                SFU_TEARDOWN_TIMEOUT_MS,
                "late SFU connection cleanup timed out",
              ),
            )
            .catch(() => undefined);
          await withTimeout(
            room.disconnect(false),
            SFU_TEARDOWN_TIMEOUT_MS,
            "SFU failed connection teardown timed out",
          ).catch(() => undefined);
          this.room = undefined;
        }
      })
      .finally(() => {
        this.connectPromise = undefined;
        this.pendingAccess = undefined;
      });
    await this.connectPromise;
    return this.connected;
  }

  async publishScreen(
    stream: MediaStream,
    preset: SfuPublishPreset,
  ): Promise<void> {
    const room = this.requireConnectedRoom();
    const publicationGeneration = ++this.publicationGeneration;
    await this.clearPublishedState();
    if (!this.isCurrentPublication(room, publicationGeneration)) {
      throw new DOMException("SFU publication was replaced", "AbortError");
    }
    const streamName = "synced-screen";
    const publicationSpecs: Array<{
      sourceTrack: MediaStreamTrack;
      role: "primary" | "emergency" | "audio";
      name: string;
    }> = [];
    for (const sourceTrack of stream.getTracks()) {
      if (sourceTrack.kind === "video") {
        publicationSpecs.push(
          {
            sourceTrack,
            role: "primary",
            name: SCREEN_VIDEO_TRACK,
          },
          {
            sourceTrack,
            role: "emergency",
            name: SCREEN_VIDEO_EMERGENCY_TRACK,
          },
        );
      } else {
        publicationSpecs.push({
          sourceTrack,
          role: "audio",
          name: SCREEN_AUDIO_TRACK,
        });
      }
    }
    for (const spec of publicationSpecs) {
      const { sourceTrack, role } = spec;
      const track = sourceTrack.clone();
      if (role === "primary") {
        track.contentHint =
          preset.contentMode === "motion" ? "motion" : "detail";
        const settings = sourceTrack.getSettings();
        const sourceWidth = Math.max(1, settings.width || 2_560);
        const sourceHeight = Math.max(1, settings.height || 1_440);
        const sourceScale = Math.min(
          1,
          2_560 / sourceWidth,
          1_440 / sourceHeight,
        );
        const cappedWidth = Math.max(1, Math.round(sourceWidth * sourceScale));
        const cappedHeight = Math.max(
          1,
          Math.round(sourceHeight * sourceScale),
        );
        await track
          .applyConstraints({
            width: { ideal: cappedWidth, max: 2_560 },
            height: { ideal: cappedHeight, max: 1_440 },
            frameRate: {
              ideal: Math.min(30, preset.frameRate),
              max: Math.min(30, preset.frameRate),
            },
          })
          .catch(() => undefined);
      } else if (role === "emergency") {
        track.contentHint =
          preset.contentMode === "motion" ? "motion" : "detail";
        if (!(await constrainEmergencyTrack(track, preset.frameRate))) {
          const actual = track.getSettings();
          track.stop();
          this.options.onDiagnostic?.(
            "sfu-emergency-track-rejected",
            {
              reason: "capture-driver-did-not-apply-480p-constraints",
              width: actual.width,
              height: actual.height,
              frameRate: actual.frameRate,
            },
          );
          continue;
        }
      }
      const sourceHeight =
        sourceTrack.getSettings().height ||
        stream.getVideoTracks()[0]?.getSettings().height ||
        1_440;
      const explicitLayers =
        sourceHeight > 1_080
          ? [
              new VideoPreset(1_280, 720, 5_000_000, 30),
              new VideoPreset(1_920, 1_080, 10_000_000, 30),
            ]
          : sourceHeight > 720
            ? [
                new VideoPreset(854, 480, 2_200_000, 24),
                new VideoPreset(1_280, 720, 5_000_000, 30),
              ]
            : [new VideoPreset(854, 480, 2_200_000, 24)];
      const publishing = room.localParticipant.publishTrack(track, {
        name: spec.name,
        source:
          sourceTrack.kind === "video"
            ? Track.Source.ScreenShare
            : Track.Source.ScreenShareAudio,
        stream: streamName,
        ...(role === "primary"
          ? {
              videoCodec: "h264" as const,
              simulcast: true,
              screenShareSimulcastLayers: explicitLayers,
              screenShareEncoding: {
                maxBitrate: Math.max(500_000, preset.maxBitrate),
                maxFramerate: Math.max(1, Math.min(30, preset.frameRate)),
              },
              degradationPreference:
                preset.contentMode === "motion"
                  ? ("maintain-framerate" as const)
                  : preset.contentMode === "detail"
                    ? ("maintain-resolution" as const)
                    : ("balanced" as const),
            }
          : role === "emergency"
            ? {
                videoCodec: "h264" as const,
                simulcast: false,
                screenShareSimulcastLayers: [],
                screenShareEncoding: {
                  maxBitrate: 2_200_000,
                  maxFramerate: Math.min(24, preset.frameRate),
                },
                degradationPreference: "maintain-framerate" as const,
              }
            : {
              forceStereo: true,
              dtx: false,
              red: true,
            }),
      });
      let publication: LocalTrackPublication;
      try {
        publication = await withTimeout(
          publishing,
          SFU_PUBLISH_TIMEOUT_MS,
          `SFU ${sourceTrack.kind} publication timed out`,
        );
      } catch (error) {
        track.stop();
        void publishing
          .then((latePublication) =>
            this.discardScreenPublication(
              room,
              latePublication,
              "late SFU screen publication cleanup timed out",
            ),
          )
          .catch(() => undefined);
        await this.invalidatePublication(publicationGeneration);
        throw error;
      }
      if (!this.isCurrentPublication(room, publicationGeneration)) {
        track.stop();
        await this.discardScreenPublication(
          room,
          publication,
          "stale SFU screen publication cleanup timed out",
        );
        throw new DOMException("SFU publication was replaced", "AbortError");
      }
      this.publishedScreenTracks.push(track);
      this.publishedScreenPublications.push(publication);
      this.publishedScreenRoles.push(role);
    }
    if (!this.publishedScreenTracks.some((track) => track.kind === "video")) {
      await this.invalidatePublication(publicationGeneration);
      throw new Error("SFU screen publication has no video track");
    }
    this.options.onDiagnostic?.("sfu-screen-published", {
      tracks: this.publishedScreenTracks.length,
      maxBitrate: preset.maxBitrate,
      frameRate: Math.min(30, preset.frameRate),
      simulcastLayers: [
        "1440p",
        "1080p",
        "720p",
        ...(this.publishedScreenRoles.includes("emergency")
          ? ["480p-emergency-verified"]
          : ["primary-low-fallback"]),
      ],
      contentMode: preset.contentMode || "balanced",
    });
  }

  async publishEmby(
    options: { controlOnly?: boolean } = {},
  ): Promise<{
    mediaChannel: RTCDataChannel;
    controlChannel: RTCDataChannel;
  }> {
    const room = this.requireConnectedRoom();
    const publicationGeneration = ++this.publicationGeneration;
    await this.clearPublishedState();
    if (!this.isCurrentPublication(room, publicationGeneration)) {
      throw new DOMException("SFU publication was replaced", "AbortError");
    }
    let mediaTrack: LocalDataTrack | undefined;
    if (!options.controlOnly) {
      const publishingMedia = room.localParticipant.publishDataTrack({
        name: SFU_EMBY_MEDIA_TRACK,
      });
      try {
        mediaTrack = await withTimeout(
          publishingMedia,
          SFU_PUBLISH_TIMEOUT_MS,
          "SFU Emby media publication timed out",
        );
      } catch (error) {
        void publishingMedia
          .then((lateTrack) =>
            this.discardDataTrack(
              lateTrack,
              "late SFU Emby media cleanup timed out",
            ),
          )
          .catch(() => undefined);
        await this.invalidatePublication(publicationGeneration);
        throw error;
      }
      if (!this.isCurrentPublication(room, publicationGeneration)) {
        await this.discardDataTrack(
          mediaTrack,
          "stale SFU Emby media cleanup timed out",
        );
        throw new DOMException("SFU publication was replaced", "AbortError");
      }
      this.localMediaTrack = mediaTrack;
    }
    const publishingControl = room.localParticipant.publishDataTrack({
      name: SFU_EMBY_CONTROL_TRACK,
    });
    let controlTrack: LocalDataTrack;
    try {
      controlTrack = await withTimeout(
        publishingControl,
        SFU_PUBLISH_TIMEOUT_MS,
        "SFU Emby control publication timed out",
      );
    } catch (error) {
      void publishingControl
        .then((lateTrack) =>
          this.discardDataTrack(
            lateTrack,
            "late SFU Emby control cleanup timed out",
          ),
        )
        .catch(() => undefined);
      await this.invalidatePublication(publicationGeneration);
      throw error;
    }
    if (!this.isCurrentPublication(room, publicationGeneration)) {
      await this.discardDataTrack(
        controlTrack,
        "stale SFU Emby control cleanup timed out",
      );
      throw new DOMException("SFU publication was replaced", "AbortError");
    }
    this.localControlTrack = controlTrack;
    const fatal = (error: unknown) => {
      this.options.onDiagnostic?.("sfu-data-track-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.options.onStateChange?.("disconnected");
    };
    const mediaChannel = new SfuRtcDataChannel(
      SFU_EMBY_MEDIA_TRACK,
      mediaTrack
        ? async (payload, signal) => {
            if (signal.aborted) {
              throw new DOMException(
                "SFU media writer was cancelled",
                "AbortError",
              );
            }
            await mediaTrack!.tryPush({ payload });
            if (signal.aborted) {
              throw new DOMException(
                "SFU media writer was cancelled",
                "AbortError",
              );
            }
          }
        : undefined,
      fatal,
      () => {
        void mediaTrack?.unpublish().catch(() => undefined);
      },
    );
    const controlChannel = new SfuRtcDataChannel(
      SFU_EMBY_CONTROL_TRACK,
      async (payload, signal) => {
        if (signal.aborted) {
          throw new DOMException(
            "SFU control writer was cancelled",
            "AbortError",
          );
        }
        await controlTrack.tryPush({ payload });
        if (signal.aborted) {
          throw new DOMException(
            "SFU control writer was cancelled",
            "AbortError",
          );
        }
      },
      fatal,
      () => {
        void controlTrack.unpublish().catch(() => undefined);
      },
    );
    this.hostMediaChannel = mediaChannel;
    this.hostControlChannel = controlChannel;
    mediaChannel.open();
    controlChannel.open();
    this.options.onDiagnostic?.("sfu-emby-published", {
      mediaTrack: mediaTrack?.info?.sid,
      controlTrack: controlTrack.info?.sid,
      controlOnly: options.controlOnly === true,
    });
    return {
      mediaChannel: asRtcDataChannel(mediaChannel),
      controlChannel: asRtcDataChannel(controlChannel),
    };
  }

  async watchScreen(
    broadcasterId: string,
    preferenceOrTimeout: SfuScreenSubscriptionPreference | number = {},
    timeoutMs = 10_000,
  ): Promise<MediaStream> {
    const room = this.requireConnectedRoom();
    const preference =
      typeof preferenceOrTimeout === "number" ? {} : preferenceOrTimeout;
    if (typeof preferenceOrTimeout === "number") {
      timeoutMs = preferenceOrTimeout;
    }
    await this.stopWatching();
    const watchController = new AbortController();
    this.watchAbortController = watchController;
    this.watchingBroadcasterId = broadcasterId;
    this.screenPreference = { ...preference };
    const stream = new MediaStream();
    this.screenWatchStream = stream;
    let resolveVideoTrack: (() => void) | undefined;
    const videoTrackReady = new Promise<void>((resolve) => {
      resolveVideoTrack = resolve;
    });
    const addTrack = (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ): void => {
      if (
        this.room !== room ||
        this.watchAbortController !== watchController ||
        this.watchingBroadcasterId !== broadcasterId ||
        participant.identity !== broadcasterId ||
        ![Track.Source.ScreenShare, Track.Source.ScreenShareAudio].includes(
          track.source,
        ) ||
        !this.screenPublicationDesired(
          publication,
          this.screenPreference,
        ) ||
        stream.getTracks().some(
          (candidate) => candidate.id === track.mediaStreamTrack.id,
        )
      ) {
        return;
      }
      stream.addTrack(track.mediaStreamTrack);
      if (track.kind === Track.Kind.Video) {
        resolveVideoTrack?.();
        this.pruneUndesiredScreenTracks(
          participant,
          publication,
          stream,
        );
      }
    };
    const subscribed = (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => addTrack(track, publication, participant);
    const unsubscribed = (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (participant.identity !== broadcasterId) return;
      const mediaTrack = stream
        .getTracks()
        .find((candidate) => candidate.id === track.mediaStreamTrack.id);
      if (mediaTrack) stream.removeTrack(mediaTrack);
    };
    const published = (
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (
        participant.identity !== broadcasterId ||
        ![
          Track.Source.ScreenShare,
          Track.Source.ScreenShareAudio,
        ].includes(publication.source)
      ) {
        return;
      }
      this.applyScreenPublicationPreference(
        publication,
        this.screenPreference,
      );
      if (publication.track) {
        addTrack(publication.track, publication, participant);
      }
    };
    room.on(RoomEvent.TrackSubscribed, subscribed);
    room.on(RoomEvent.TrackUnsubscribed, unsubscribed);
    room.on(RoomEvent.TrackPublished, published);
    const cleanupListener = () => {
      room.off(RoomEvent.TrackSubscribed, subscribed);
      room.off(RoomEvent.TrackUnsubscribed, unsubscribed);
      room.off(RoomEvent.TrackPublished, published);
    };
    this.readers.push({
      cancel: async () => {
        cleanupListener();
      },
    });
    const existing = room.remoteParticipants.get(broadcasterId);
    existing?.trackPublications.forEach((publication) => {
      this.applyScreenPublicationPreference(
        publication,
        this.screenPreference,
      );
      if (publication.track) {
        addTrack(publication.track, publication, existing);
      }
    });
    try {
      if (!stream.getVideoTracks().length) {
        await withTimeout(
          videoTrackReady,
          timeoutMs,
          "SFU broadcaster did not publish a screen track",
          watchController.signal,
        );
      }
      if (this.watchAbortController !== watchController) {
        throw new DOMException("SFU watch was replaced", "AbortError");
      }
      return stream;
    } catch (error) {
      if (this.watchAbortController === watchController) {
        await this.stopWatching();
      }
      throw error;
    }
  }

  setScreenSubscriptionPreference(
    preference: SfuScreenSubscriptionPreference,
  ): boolean {
    const room = this.room;
    const participant = room?.remoteParticipants.get(
      this.watchingBroadcasterId,
    );
    if (!room || !participant || !this.screenWatchStream) return false;
    this.screenPreference = {
      ...this.screenPreference,
      ...preference,
    };
    const publications = [...participant.trackPublications.values()].filter(
      (publication) =>
        [
          Track.Source.ScreenShare,
          Track.Source.ScreenShareAudio,
        ].includes(publication.source),
    );
    for (const publication of publications) {
      this.applyScreenPublicationPreference(
        publication,
        this.screenPreference,
      );
    }
    const desiredVideo = publications.find(
      (publication) =>
        publication.kind === Track.Kind.Video &&
        this.screenPublicationDesired(
          publication,
          this.screenPreference,
        ),
    );
    if (desiredVideo?.track) {
      const mediaTrack = desiredVideo.track.mediaStreamTrack;
      if (
        !this.screenWatchStream
          .getTracks()
          .some((candidate) => candidate.id === mediaTrack.id)
      ) {
        this.screenWatchStream.addTrack(mediaTrack);
      }
      this.pruneUndesiredScreenTracks(
        participant,
        desiredVideo,
        this.screenWatchStream,
      );
    }
    this.options.onDiagnostic?.("sfu-screen-subscription-updated", {
      broadcasterId: participant.identity,
      width: this.screenPreference.width,
      height: this.screenPreference.height,
      frameRate: this.screenPreference.frameRate,
      quality: this.screenVideoQuality(this.screenPreference),
      emergency: this.screenWantsEmergency(this.screenPreference),
    });
    return true;
  }

  async readScreenReceiverStats(): Promise<
    SfuScreenReceiverStats | undefined
  > {
    const participant = this.room?.remoteParticipants.get(
      this.watchingBroadcasterId,
    );
    const publication = participant
      ? [...participant.trackPublications.values()].find(
          (candidate) =>
            candidate.kind === Track.Kind.Video &&
            candidate.track &&
            this.screenPublicationDesired(
              candidate,
              this.screenPreference,
            ),
        )
      : undefined;
    const report = await publication?.track?.getRTCStatsReport();
    if (!report) return undefined;
    let inbound: RTCInboundRtpStreamStats | undefined;
    let candidatePair: RTCIceCandidatePairStats | undefined;
    report.forEach((item) => {
      if (
        item.type === "inbound-rtp" &&
        item.kind === "video" &&
        (!inbound ||
          Number(item.bytesReceived) > Number(inbound.bytesReceived || 0))
      ) {
        inbound = item as RTCInboundRtpStreamStats;
      } else if (
        item.type === "candidate-pair" &&
        item.state === "succeeded" &&
        (item.nominated || !candidatePair)
      ) {
        candidatePair = item as RTCIceCandidatePairStats;
      }
    });
    if (!inbound) return undefined;
    return {
      timestamp: Number(inbound.timestamp) || performance.now(),
      bytesReceived: Math.max(0, Number(inbound.bytesReceived) || 0),
      packetsReceived: Math.max(0, Number(inbound.packetsReceived) || 0),
      packetsLost: Math.max(0, Number(inbound.packetsLost) || 0),
      framesDecoded: Math.max(0, Number(inbound.framesDecoded) || 0),
      framesDropped: Math.max(0, Number(inbound.framesDropped) || 0),
      framesPerSecond:
        Number(inbound.framesPerSecond) > 0
          ? Number(inbound.framesPerSecond)
          : undefined,
      frameWidth:
        Number(inbound.frameWidth) > 0
          ? Number(inbound.frameWidth)
          : undefined,
      frameHeight:
        Number(inbound.frameHeight) > 0
          ? Number(inbound.frameHeight)
          : undefined,
      emergency:
        publication?.trackName === SCREEN_VIDEO_EMERGENCY_TRACK,
      jitter:
        Number(inbound.jitter) >= 0 ? Number(inbound.jitter) : undefined,
      currentRoundTripTime:
        candidatePair && Number(candidatePair.currentRoundTripTime) >= 0
          ? Number(candidatePair.currentRoundTripTime)
          : undefined,
      availableIncomingBitrate:
        candidatePair && Number(candidatePair.availableIncomingBitrate) > 0
          ? Number(candidatePair.availableIncomingBitrate)
          : undefined,
    };
  }

  private applyScreenPublicationPreference(
    publication: RemoteTrackPublication,
    preference: SfuScreenSubscriptionPreference,
  ): void {
    const desired = this.screenPublicationDesired(publication, preference);
    if (publication.kind === Track.Kind.Video && desired) {
      const target = resolveSfuScreenSubscription(preference);
      publication.setVideoQuality(
        target.quality === "low"
          ? VideoQuality.LOW
          : target.quality === "medium"
            ? VideoQuality.MEDIUM
            : VideoQuality.HIGH,
      );
      publication.setVideoDimensions({
        width: target.width,
        height: target.height,
      });
      publication.setVideoFPS(target.frameRate);
    }
    publication.setSubscribed(desired);
  }

  private screenPublicationDesired(
    publication: RemoteTrackPublication,
    preference: SfuScreenSubscriptionPreference,
  ): boolean {
    if (publication.source === Track.Source.ScreenShareAudio) return true;
    if (publication.source !== Track.Source.ScreenShare) return false;
    const emergency =
      publication.trackName === SCREEN_VIDEO_EMERGENCY_TRACK;
    const participant = this.room?.remoteParticipants.get(
      this.watchingBroadcasterId,
    );
    const emergencyAvailable = participant
      ? [...participant.trackPublications.values()].some(
          (candidate) =>
            candidate.kind === Track.Kind.Video &&
            candidate.source === Track.Source.ScreenShare &&
            candidate.trackName === SCREEN_VIDEO_EMERGENCY_TRACK,
        )
      : false;
    return (
      emergency ===
      (this.screenWantsEmergency(preference) && emergencyAvailable)
    );
  }

  private screenWantsEmergency(
    preference: SfuScreenSubscriptionPreference,
  ): boolean {
    return resolveSfuScreenSubscription(preference).emergency;
  }

  private screenVideoQuality(
    preference: SfuScreenSubscriptionPreference,
  ): VideoQuality {
    const quality = resolveSfuScreenSubscription(preference).quality;
    return quality === "low"
      ? VideoQuality.LOW
      : quality === "medium"
        ? VideoQuality.MEDIUM
        : VideoQuality.HIGH;
  }

  private pruneUndesiredScreenTracks(
    participant: RemoteParticipant,
    desiredPublication: RemoteTrackPublication,
    stream: MediaStream,
  ): void {
    for (const publication of participant.trackPublications.values()) {
      if (
        publication === desiredPublication ||
        publication.kind !== Track.Kind.Video ||
        publication.source !== Track.Source.ScreenShare
      ) {
        continue;
      }
      const track = publication.track?.mediaStreamTrack;
      if (track) {
        const attached = stream
          .getTracks()
          .find((candidate) => candidate.id === track.id);
        if (attached) stream.removeTrack(attached);
      }
      publication.setSubscribed(false);
    }
  }

  async watchEmby(
    broadcasterId: string,
    timeoutMs = 10_000,
    controlOnly = false,
  ): Promise<{
    mediaChannel: RTCDataChannel;
    controlChannel: RTCDataChannel;
  }> {
    const room = this.requireConnectedRoom();
    await this.stopWatching();
    const watchController = new AbortController();
    this.watchAbortController = watchController;
    this.watchingBroadcasterId = broadcasterId;
    try {
      const participant = await this.waitForParticipant(
        broadcasterId,
        timeoutMs,
        watchController.signal,
      );
      const [mediaTrack, controlTrack] = await Promise.all([
        controlOnly
          ? Promise.resolve(undefined)
          : withTimeout(
              participant.dataTracks.getDeferred(SFU_EMBY_MEDIA_TRACK),
              timeoutMs,
              "SFU broadcaster did not publish the Emby media track",
              watchController.signal,
            ),
        withTimeout(
          participant.dataTracks.getDeferred(SFU_EMBY_CONTROL_TRACK),
          timeoutMs,
          "SFU broadcaster did not publish the Emby control track",
          watchController.signal,
        ),
      ]);
      if (this.watchAbortController !== watchController) {
        throw new DOMException("SFU watch was replaced", "AbortError");
      }
      const publishViewerControl = async (
        payload: Uint8Array<ArrayBuffer>,
      ) => {
        const framedKind = payload[0];
        if (framedKind !== DATA_KIND_TEXT) return;
        const controlPayload = new Uint8Array(payload.byteLength - 1);
        controlPayload.set(payload.subarray(1));
        await room.localParticipant.publishData(controlPayload, {
          reliable: true,
          topic: SFU_EMBY_VIEWER_CONTROL_TOPIC,
          destinationIdentities: [broadcasterId],
        });
      };
      const fatal = (error: unknown) => {
        this.options.onDiagnostic?.("sfu-viewer-data-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        this.options.onStateChange?.("disconnected");
      };
      const mediaChannel = new SfuRtcDataChannel(
        SFU_EMBY_MEDIA_TRACK,
        undefined,
        fatal,
      );
      const controlChannel = new SfuRtcDataChannel(
        SFU_EMBY_CONTROL_TRACK,
        publishViewerControl,
        fatal,
      );
      this.viewerMediaChannel = mediaChannel;
      this.viewerControlChannel = controlChannel;
      mediaChannel.open();
      controlChannel.open();
      if (mediaTrack) this.consumeDataTrack(mediaTrack, mediaChannel);
      this.consumeDataTrack(controlTrack, controlChannel);
      this.options.onDiagnostic?.("sfu-emby-subscribed", {
        broadcasterId,
        mediaTrack: mediaTrack?.info.sid,
        controlTrack: controlTrack.info.sid,
        controlOnly,
      });
      return {
        mediaChannel: asRtcDataChannel(mediaChannel),
        controlChannel: asRtcDataChannel(controlChannel),
      };
    } catch (error) {
      if (this.watchAbortController === watchController) {
        await this.stopWatching();
      }
      throw error;
    }
  }

  async stopWatching(): Promise<void> {
    const watchController = this.watchAbortController;
    this.watchAbortController = undefined;
    watchController?.abort();
    const watchedIdentity = this.watchingBroadcasterId;
    this.watchingBroadcasterId = "";
    this.screenWatchStream = undefined;
    this.screenPreference = {};
    const readers = this.readers.splice(0);
    await Promise.all(
      readers.map((reader) =>
        withTimeout(
          reader.cancel(),
          SFU_TEARDOWN_TIMEOUT_MS,
          "SFU reader cancellation timed out",
        ).catch(() => undefined),
      ),
    );
    if (watchedIdentity) {
      this.room?.remoteParticipants
        .get(watchedIdentity)
        ?.trackPublications.forEach((publication) => {
          publication.setSubscribed(false);
        });
    }
    this.viewerMediaChannel?.close();
    this.viewerControlChannel?.close();
    this.viewerMediaChannel = undefined;
    this.viewerControlChannel = undefined;
  }

  async stopPublishing(): Promise<void> {
    this.publicationGeneration += 1;
    await this.clearPublishedState();
  }

  private async clearPublishedState(): Promise<void> {
    const mediaChannel = this.hostMediaChannel;
    const controlChannel = this.hostControlChannel;
    this.hostMediaChannel = undefined;
    this.hostControlChannel = undefined;
    const mediaTrack = this.localMediaTrack;
    const controlTrack = this.localControlTrack;
    this.localMediaTrack = undefined;
    this.localControlTrack = undefined;
    const room = this.room;
    const publications = this.publishedScreenPublications.splice(0);
    this.publishedScreenRoles.splice(0);
    this.publishedScreenTracks.splice(0).forEach((track) => track.stop());
    await Promise.all([
      mediaChannel?.closeGracefully(),
      controlChannel?.closeGracefully(),
    ]);
    await Promise.all([
      ...(mediaTrack
        ? [
            withTimeout(
              mediaTrack.flush(),
              SFU_TEARDOWN_TIMEOUT_MS,
              "SFU Emby media flush timed out",
            )
              .catch(() => undefined)
              .then(() =>
                withTimeout(
                  mediaTrack.unpublish(),
                  SFU_TEARDOWN_TIMEOUT_MS,
                  "SFU Emby media unpublish timed out",
                ).catch(() => undefined),
              ),
          ]
        : []),
      ...(controlTrack
        ? [
            withTimeout(
              controlTrack.flush(),
              SFU_TEARDOWN_TIMEOUT_MS,
              "SFU Emby control flush timed out",
            )
              .catch(() => undefined)
              .then(() =>
                withTimeout(
                  controlTrack.unpublish(),
                  SFU_TEARDOWN_TIMEOUT_MS,
                  "SFU Emby control unpublish timed out",
                ).catch(() => undefined),
              ),
          ]
        : []),
      ...(room
        ? publications
            .filter((publication) => Boolean(publication.track))
            .map((publication) =>
              withTimeout(
                room.localParticipant.unpublishTrack(
                  publication.track!,
                  false,
                ),
                SFU_TEARDOWN_TIMEOUT_MS,
                "SFU screen unpublish timed out",
              ).catch(() => undefined),
            )
        : []),
    ]);
  }

  private isCurrentPublication(
    room: Room,
    publicationGeneration: number,
  ): boolean {
    return (
      this.room === room &&
      room.state === ConnectionState.Connected &&
      this.publicationGeneration === publicationGeneration
    );
  }

  private async invalidatePublication(
    publicationGeneration: number,
  ): Promise<void> {
    if (this.publicationGeneration !== publicationGeneration) return;
    this.publicationGeneration += 1;
    await this.clearPublishedState();
  }

  private async discardScreenPublication(
    room: Room,
    publication: LocalTrackPublication,
    timeoutMessage: string,
  ): Promise<void> {
    if (!publication.track) return;
    await withTimeout(
      room.localParticipant.unpublishTrack(publication.track, false),
      SFU_TEARDOWN_TIMEOUT_MS,
      timeoutMessage,
    ).catch(() => undefined);
  }

  private async discardDataTrack(
    track: LocalDataTrack,
    timeoutMessage: string,
  ): Promise<void> {
    await withTimeout(
      track.unpublish(),
      SFU_TEARDOWN_TIMEOUT_MS,
      timeoutMessage,
    ).catch(() => undefined);
  }

  async replacePublishedScreenTrack(
    sourceTrack: MediaStreamTrack,
  ): Promise<boolean> {
    const room = this.requireConnectedRoom();
    const indexes = this.publishedScreenPublications
      .map((publication, index) =>
        publication.track?.kind === sourceTrack.kind ? index : -1,
      )
      .filter((index) => index >= 0);
    if (!indexes.length) return false;
    const rejectedEmergencyIndexes: number[] = [];
    await Promise.all(
      indexes.map(async (index) => {
        const publication = this.publishedScreenPublications[index];
        const localTrack = publication?.track;
        if (!localTrack) return;
        const replacement = sourceTrack.clone();
        if (this.publishedScreenRoles[index] === "emergency") {
          if (!(await constrainEmergencyTrack(replacement))) {
            replacement.stop();
            rejectedEmergencyIndexes.push(index);
            return;
          }
        }
        try {
          await withTimeout(
            localTrack.replaceTrack(replacement, {
              userProvidedTrack: false,
            }),
            SFU_PUBLISH_TIMEOUT_MS,
            `SFU ${sourceTrack.kind} track replacement timed out`,
          );
        } catch (error) {
          replacement.stop();
          throw error;
        }
        const previous = this.publishedScreenTracks[index];
        this.publishedScreenTracks[index] = replacement;
        if (previous && previous !== replacement) previous.stop();
      }),
    );
    for (const index of rejectedEmergencyIndexes.sort(
      (left, right) => right - left,
    )) {
      const publication = this.publishedScreenPublications[index];
      const previous = this.publishedScreenTracks[index];
      if (publication) {
        await this.discardScreenPublication(
          room,
          publication,
          "invalid emergency track cleanup timed out",
        );
      }
      previous?.stop();
      this.publishedScreenTracks.splice(index, 1);
      this.publishedScreenPublications.splice(index, 1);
      this.publishedScreenRoles.splice(index, 1);
    }
    if (rejectedEmergencyIndexes.length) {
      this.options.onDiagnostic?.("sfu-emergency-track-rejected", {
        reason: "replacement-track-did-not-apply-480p-constraints",
        publications: rejectedEmergencyIndexes.length,
      });
    }
    this.options.onDiagnostic?.("sfu-screen-track-replaced", {
      kind: sourceTrack.kind,
      trackId: sourceTrack.id,
      publications: indexes.length,
    });
    return true;
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    await this.stopWatching();
    await this.stopPublishing();
    const room = this.room;
    this.room = undefined;
    this.access = undefined;
    this.pendingAccess = undefined;
    if (room) {
      await withTimeout(
        room.disconnect(false),
        SFU_TEARDOWN_TIMEOUT_MS,
        "SFU disconnect timed out",
      ).catch(() => undefined);
    }
  }

  private requireConnectedRoom(): Room {
    if (!this.room || this.room.state !== ConnectionState.Connected) {
      throw new Error("SFU is not connected");
    }
    return this.room;
  }

  private async waitForParticipant(
    identity: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RemoteParticipant> {
    const room = this.requireConnectedRoom();
    const existing = room.remoteParticipants.get(identity);
    if (existing) return existing;
    let connected:
      | ((participant: RemoteParticipant) => void)
      | undefined;
    try {
      return await withTimeout(
        new Promise<RemoteParticipant>((resolve) => {
          connected = (participant: RemoteParticipant) => {
            if (participant.identity === identity) resolve(participant);
          };
          room.on(RoomEvent.ParticipantConnected, connected);
        }),
        timeoutMs,
        "SFU broadcaster is not connected",
        signal,
      );
    } finally {
      if (connected) room.off(RoomEvent.ParticipantConnected, connected);
    }
  }

  private consumeDataTrack(
    track: RemoteDataTrack,
    channel: SfuRtcDataChannel,
  ): void {
    track.setPipelineOptions({ maxPartialFrames: 256 });
    const reader = track.subscribe({ bufferSize: 2048 }).getReader();
    let active = true;
    let cancelPromise: Promise<void> | undefined;
    const handle: ActiveReader = {
      cancel: () => {
        if (cancelPromise) return cancelPromise;
        active = false;
        cancelPromise = reader.cancel().catch(() => undefined);
        return cancelPromise;
      },
    };
    this.readers.push(handle);
    void (async () => {
      let closeOnExit = false;
      try {
        while (active && channel.readyState === "open") {
          const result = await reader.read();
          if (!active || channel.readyState !== "open") break;
          if (result.done) {
            closeOnExit = true;
            break;
          }
          if (!active || channel.readyState !== "open") break;
          channel.receive(result.value.payload);
        }
      } catch (error) {
        if (active) {
          closeOnExit = true;
          this.options.onDiagnostic?.("sfu-data-read-failed", {
            track: track.info.name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        active = false;
        const index = this.readers.indexOf(handle);
        if (index >= 0) this.readers.splice(index, 1);
        try {
          reader.releaseLock();
        } catch {
          // A concurrent cancellation may still own the reader briefly.
        }
        if (closeOnExit && channel.readyState === "open") channel.close();
      }
    })();
  }
}

export function sanitizeSfuAccess(
  value: SfuAccess | undefined,
): SfuAccess | undefined {
  return normalizedAccess(value);
}
