import {
  ConnectionState,
  RemoteDataTrack,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  type LocalDataTrack,
  type LocalTrackPublication,
} from "livekit-client";

export const SFU_EMBY_MEDIA_TRACK = "yiqikan-emby-media";
export const SFU_EMBY_CONTROL_TRACK = "yiqikan-emby-control";
const SFU_EMBY_VIEWER_CONTROL_TOPIC = "yiqikan:emby-viewer-control";
const DATA_KIND_TEXT = 0;
const DATA_KIND_BINARY = 1;
const SFU_DATA_SEND_TIMEOUT_MS = 5_000;
const SFU_PUBLISH_TIMEOUT_MS = 10_000;
const SFU_TEARDOWN_TIMEOUT_MS = 2_000;

export interface SfuAccess {
  url: string;
  room: string;
  token: string;
  expiresAt: number;
}

export interface SfuPublishPreset {
  maxBitrate: number;
  frameRate: number;
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
  readonly protocol = "yiqikan-sfu";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "connecting";
  private sendTail: Promise<void> = Promise.resolve();
  private failureCount = 0;

  constructor(
    label: string,
    private readonly outbound?: (
      payload: Uint8Array<ArrayBuffer>,
    ) => Promise<void>,
    private readonly onFatal?: (error: unknown) => void,
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
    const previousBufferedAmount = this.bufferedAmount;
    this.bufferedAmount += payload.byteLength;
    this.sendTail = this.sendTail
      .then(() =>
        withTimeout(
          this.outbound!(payload),
          SFU_DATA_SEND_TIMEOUT_MS,
          `SFU ${this.label} send timed out`,
        ),
      )
      .then(() => {
        this.failureCount = 0;
      })
      .catch((error) => {
        if (this.readyState !== "open") return;
        this.failureCount += 1;
        this.dispatchEvent(new Event("error"));
        if (this.failureCount >= 3) {
          this.onFatal?.(error);
          this.close();
        }
      })
      .finally(() => {
        this.bufferedAmount = Math.max(
          0,
          this.bufferedAmount - payload.byteLength,
        );
        if (
          previousBufferedAmount > this.bufferedAmountLowThreshold &&
          this.bufferedAmount <= this.bufferedAmountLowThreshold
        ) {
          this.dispatchEvent(new Event("bufferedamountlow"));
        }
      });
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
    queueMicrotask(() => {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    });
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
  private localMediaTrack?: LocalDataTrack;
  private localControlTrack?: LocalDataTrack;
  private hostMediaChannel?: SfuRtcDataChannel;
  private hostControlChannel?: SfuRtcDataChannel;
  private viewerMediaChannel?: SfuRtcDataChannel;
  private viewerControlChannel?: SfuRtcDataChannel;
  private readers: ActiveReader[] = [];
  private watchingBroadcasterId = "";
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
    const streamName = "yiqikan-screen";
    for (const sourceTrack of stream.getTracks()) {
      const track = sourceTrack.clone();
      const publishing = room.localParticipant.publishTrack(track, {
        name:
          sourceTrack.kind === "video"
            ? "yiqikan-screen-video"
            : "yiqikan-screen-audio",
        source:
          sourceTrack.kind === "video"
            ? Track.Source.ScreenShare
            : Track.Source.ScreenShareAudio,
        stream: streamName,
        ...(sourceTrack.kind === "video"
          ? {
              videoCodec: "h264" as const,
              simulcast: true,
              screenShareEncoding: {
                maxBitrate: Math.max(500_000, preset.maxBitrate),
                maxFramerate: Math.max(1, preset.frameRate),
              },
              degradationPreference: "maintain-resolution" as const,
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
    }
    if (!this.publishedScreenTracks.some((track) => track.kind === "video")) {
      await this.invalidatePublication(publicationGeneration);
      throw new Error("SFU screen publication has no video track");
    }
    this.options.onDiagnostic?.("sfu-screen-published", {
      tracks: this.publishedScreenTracks.length,
      maxBitrate: preset.maxBitrate,
      frameRate: preset.frameRate,
    });
  }

  async publishEmby(): Promise<{
    mediaChannel: RTCDataChannel;
    controlChannel: RTCDataChannel;
  }> {
    const room = this.requireConnectedRoom();
    const publicationGeneration = ++this.publicationGeneration;
    await this.clearPublishedState();
    if (!this.isCurrentPublication(room, publicationGeneration)) {
      throw new DOMException("SFU publication was replaced", "AbortError");
    }
    const publishingMedia = room.localParticipant.publishDataTrack({
      name: SFU_EMBY_MEDIA_TRACK,
    });
    let mediaTrack: LocalDataTrack;
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
      async (payload) => {
        await mediaTrack.tryPush({ payload });
        await mediaTrack.flush();
      },
      fatal,
    );
    const controlChannel = new SfuRtcDataChannel(
      SFU_EMBY_CONTROL_TRACK,
      async (payload) => {
        await controlTrack.tryPush({ payload });
        await controlTrack.flush();
      },
      fatal,
    );
    this.hostMediaChannel = mediaChannel;
    this.hostControlChannel = controlChannel;
    mediaChannel.open();
    controlChannel.open();
    this.options.onDiagnostic?.("sfu-emby-published", {
      mediaTrack: mediaTrack.info?.sid,
      controlTrack: controlTrack.info?.sid,
    });
    return {
      mediaChannel: asRtcDataChannel(mediaChannel),
      controlChannel: asRtcDataChannel(controlChannel),
    };
  }

  async watchScreen(
    broadcasterId: string,
    timeoutMs = 10_000,
  ): Promise<MediaStream> {
    const room = this.requireConnectedRoom();
    await this.stopWatching();
    const watchController = new AbortController();
    this.watchAbortController = watchController;
    this.watchingBroadcasterId = broadcasterId;
    const stream = new MediaStream();
    let resolveVideoTrack: (() => void) | undefined;
    const videoTrackReady = new Promise<void>((resolve) => {
      resolveVideoTrack = resolve;
    });
    const addTrack = (
      track: RemoteTrack,
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
        stream.getTracks().some(
          (candidate) => candidate.id === track.mediaStreamTrack.id,
        )
      ) {
        return;
      }
      stream.addTrack(track.mediaStreamTrack);
      if (track.kind === Track.Kind.Video) resolveVideoTrack?.();
    };
    const subscribed = (
      track: RemoteTrack,
      _publication: unknown,
      participant: RemoteParticipant,
    ) => addTrack(track, participant);
    room.on(RoomEvent.TrackSubscribed, subscribed);
    const cleanupListener = () => room.off(RoomEvent.TrackSubscribed, subscribed);
    this.readers.push({
      cancel: async () => {
        cleanupListener();
      },
    });
    const existing = room.remoteParticipants.get(broadcasterId);
    existing?.trackPublications.forEach((publication) => {
      publication.setSubscribed(true);
      if (publication.track) addTrack(publication.track, existing);
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

  async watchEmby(
    broadcasterId: string,
    timeoutMs = 10_000,
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
        withTimeout(
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
        publishViewerControl,
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
      this.consumeDataTrack(mediaTrack, mediaChannel);
      this.consumeDataTrack(controlTrack, controlChannel);
      this.options.onDiagnostic?.("sfu-emby-subscribed", {
        broadcasterId,
        mediaTrack: mediaTrack.info.sid,
        controlTrack: controlTrack.info.sid,
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
    this.hostMediaChannel?.close();
    this.hostControlChannel?.close();
    this.hostMediaChannel = undefined;
    this.hostControlChannel = undefined;
    const mediaTrack = this.localMediaTrack;
    const controlTrack = this.localControlTrack;
    this.localMediaTrack = undefined;
    this.localControlTrack = undefined;
    const room = this.room;
    const publications = this.publishedScreenPublications.splice(0);
    this.publishedScreenTracks.splice(0).forEach((track) => track.stop());
    await Promise.all([
      ...(mediaTrack
        ? [
            withTimeout(
              mediaTrack.unpublish(),
              SFU_TEARDOWN_TIMEOUT_MS,
              "SFU Emby media unpublish timed out",
            ).catch(() => undefined),
          ]
        : []),
      ...(controlTrack
        ? [
            withTimeout(
              controlTrack.unpublish(),
              SFU_TEARDOWN_TIMEOUT_MS,
              "SFU Emby control unpublish timed out",
            ).catch(() => undefined),
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
    const index = this.publishedScreenPublications.findIndex(
      (publication) =>
        publication.track?.kind === sourceTrack.kind,
    );
    const publication = this.publishedScreenPublications[index];
    const localTrack = publication?.track;
    if (!localTrack) return false;
    const replacement = sourceTrack.clone();
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
    this.options.onDiagnostic?.("sfu-screen-track-replaced", {
      kind: sourceTrack.kind,
      trackId: replacement.id,
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
