import { EmbyMsePlayer } from "./emby-player";
import {
  buildEmbySegmentRelayBaseUrl,
  deriveEmbyAssetId,
} from "./emby-segment-relay";
import {
  EMBY_CHUNK_BYTES,
  EMBY_CONTROL_CHANNEL_LABEL,
  EMBY_DATA_CHANNEL_LABEL,
  EmbyFragmentCache,
  EmbyPeerSender,
  EmbyTimelineNormalizer,
  type EmbyControlMessage,
  type EmbySenderStats,
  type EmbySegmentSessionDescriptor,
  type EmbyTransportFragment,
} from "./emby-transport";
import type { SegmentRelayAccess } from "./rtc";

interface EmbyBroadcastControllerOptions {
  roomId: string;
  video: HTMLVideoElement;
  notify: (message: string, error?: boolean) => void;
  onStatus: (status: {
    viewers: number;
    readyViewers: number;
    queuedBytes: number;
    bufferedBytes: number;
    droppedFragments: number;
    localBufferedSeconds: number;
  }) => void;
  onStreamReady: (detail: {
    plan: EmbyStreamPlan;
    mimeType: string;
    title: string;
  }) => void;
  onNetworkPressure?: (detail: {
    viewerId: string;
    queuedBytes: number;
    bufferedBytes: number;
  }) => void;
}

interface PeerState {
  sender: EmbyPeerSender;
  stats: EmbySenderStats;
  ready: boolean;
  sessionReady: boolean;
  bufferAhead: number;
  slowSamples: number;
  recoveries: number;
  lastCatchUpAt: number;
  recoveryCooldownMs: number;
  healthyRecoverySamples: number;
  lastPressureReportAt: number;
  observedDroppedFragments: number;
  observedRecoveryGeneration: number;
  backlogRecoveryScheduled: boolean;
  transportEpoch: number;
  repairTokens: number;
  repairTokenUpdatedAt: number;
  recentRepairRequests: Map<string, number>;
  lastInitRequestAt: number;
  lastSyncPingAt: number;
  lastBufferStateAt: number;
  mediaFallbackActive: boolean;
  lastMediaFallbackAt: number;
  mediaFallbackOffer?: {
    requestId: string;
    targetTime: number;
    transportEpoch: number;
    activated: boolean;
  };
}

interface PendingStart {
  resolve: (detail: {
    plan: EmbyStreamPlan;
    mimeType: string;
    title: string;
  }) => void;
  reject: (error: Error) => void;
  timer: number;
  attempt: number;
  earlyEvents: EmbyStreamEvent[];
}

interface RestartIntent {
  id: number;
  signature: string;
  request: EmbyPlaybackRequest;
  seconds: number;
  notice?: string;
  seekRevision?: number;
  waiters: Array<() => void>;
}

class EmbyStartupCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbyStartupCompatibilityError";
  }
}

class EmbyIpcTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs} ms`);
    this.name = "EmbyIpcTimeoutError";
  }
}

async function withEmbyIpcTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new EmbyIpcTimeoutError(label, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

const EMBY_APPEND_QUEUE_HIGH_WATER = 24 * 1024 * 1024;
const EMBY_APPEND_QUEUE_LOW_WATER = 8 * 1024 * 1024;
const EMBY_MAX_AUTO_RECOVERIES = 2;
const EMBY_STABLE_STREAM_RESET_MS = 30_000;
const EMBY_RECOVERY_DELAYS_MS = [1_500, 5_000] as const;
const EMBY_START_BARRIER_MS = 2_800;
const EMBY_LOCAL_READY_TIMEOUT_MS = 14_000;
const EMBY_LOCAL_READY_GRACE_MS = 8_000;
const EMBY_FLOW_CONTROL_COMMAND_TIMEOUT_MS = 1_500;
const EMBY_FLOW_CONTROL_STATE_TIMEOUT_MS = 1_000;
const EMBY_PIPELINE_STOP_TIMEOUT_MS = 8_000;
const EMBY_LOGOUT_TIMEOUT_MS = 8_000;
const EMBY_PLAYBACK_REPORT_TIMEOUT_MS = 3_000;
const EMBY_SLOW_PEER_MIN_RECOVERY_COOLDOWN_MS = 5_000;
const EMBY_SLOW_PEER_MAX_RECOVERY_COOLDOWN_MS = 30_000;
const EMBY_SLOW_PEER_HEALTHY_RESET_SAMPLES = 12;

export class EmbyBroadcastController {
  readonly sessionId =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private readonly bridge: NonNullable<Window["roomDesktop"]>;
  private readonly localPlayer: EmbyMsePlayer;
  private readonly cache = new EmbyFragmentCache();
  private readonly timelineNormalizer = new EmbyTimelineNormalizer();
  private readonly peers = new Map<string, PeerState>();
  private readonly sfuViewerIds = new Set<string>();
  private mediaVersion = 0;
  private lastMuxedFragmentSeq = 0;
  private streamHasEnded = false;
  private pipelineId = "";
  private expectedPipelineId = "";
  private plan?: EmbyStreamPlan;
  private mimeType = "";
  private title = "";
  private activeRequest?: EmbyPlaybackRequest;
  private removeStreamListener?: () => void;
  private pendingStart?: PendingStart;
  private stateVersion = 0;
  private playbackTimer?: number;
  private progressTimer?: number;
  private seekTimer?: number;
  private pendingSeekSeconds?: number;
  private seekRevision = 0;
  private activeSeekPromise?: Promise<void>;
  private seekCancellation?: Promise<void>;
  private statusTimer?: number;
  private stopping = false;
  private restarting = false;
  private restartOperation?: Promise<void>;
  private runningRestart?: RestartIntent;
  private pendingRestart?: RestartIntent;
  private restartCancellation?: Promise<void>;
  private restartRevision = 0;
  private destroyed = false;
  private destroying = false;
  private ignoreSeekUntil = 0;
  private flowPaused = false;
  private appliedFlowPaused: boolean | undefined = false;
  private flowControlOperation?: Promise<void>;
  private flowControlGeneration = 0;
  private flowControlRetryTimer?: number;
  private readonly playbackReportsInFlight = new Set<
    "start" | "progress" | "stop"
  >();
  private readonly flowPauseReasons = new Set<"buffer" | "append-queue">();
  private startAttempt = 0;
  private inFlightPipelineStarts = 0;
  private localReady = false;
  private desiredPausedAfterStart = false;
  private userWantsPaused = false;
  private initialPlaybackStarted = false;
  private startBarrierTimer?: number;
  private localReadyTimer?: number;
  private suppressHostSeek = false;
  private autoRecoveryTimer?: number;
  private autoRecoveryFailures = 0;
  private streamReadyAt = 0;
  private localFailureHandledForVersion = -1;
  private lastFragmentAt = 0;
  private lastLocalPlaybackProgressAt = 0;
  private lastLocalPlaybackTime = 0;
  private segmentRelay?: {
    signalUrl: string;
    access: SegmentRelayAccess;
  };
  private segmentDescriptor?: EmbySegmentSessionDescriptor;
  private segmentRenditionDemandSignature = "";

  constructor(private readonly options: EmbyBroadcastControllerOptions) {
    const bridge = window.roomDesktop;
    if (!bridge) throw new Error("Emby 高清模式只支持桌面放映端");
    this.bridge = bridge;
    this.localPlayer = new EmbyMsePlayer({
      video: options.video,
      host: true,
      initialBufferSeconds: 10,
      targetBufferSeconds: 64,
      maxBufferSeconds: 90,
    });
    // Screen sharing intentionally starts muted to prevent feedback, whereas
    // Emby playback is the host's actual local player.
    options.video.muted = false;
    options.video.volume = 1;
    this.removeStreamListener = bridge.onEmbyStreamEvent((event) =>
      this.handleStreamEvent(event),
    );
    this.localPlayer.addEventListener("buffer", (event) => {
      const detail = (event as CustomEvent<{ aheadSeconds: number }>).detail;
      this.syncFlowControl(detail.aheadSeconds);
      this.publishStatus();
    });
    this.localPlayer.addEventListener("appendqueuechange", () => {
      this.syncFlowControl();
      this.publishStatus();
    });
    this.localPlayer.addEventListener("ready", () => {
      this.clearLocalReadyTimer();
      this.localReady = true;
      this.suppressHostSeek = false;
      this.maybeStartSynchronizedPlayback();
      void this.reportPlayback("start", "TimeUpdate");
    });
    this.localPlayer.addEventListener("error", (event) => {
      const message =
        (event as CustomEvent<string>).detail || "Emby 本地播放失败";
      // An exact MIME rejection can be emitted synchronously from configure().
      // Let the init handler resolve the user-visible start first; otherwise
      // stopPipelineOnly rejects that same pending promise and the outer room
      // cleanup destroys the controller before its compatibility retry runs.
      window.setTimeout(() => this.handleLocalPlaybackFailure(message), 0);
    });
    this.options.video.addEventListener("play", this.handleHostPlay);
    this.options.video.addEventListener("pause", this.handleHostPause);
    this.options.video.addEventListener("ratechange", this.handleHostRate);
    this.options.video.addEventListener("seeking", this.handleHostSeeking);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  get active(): boolean {
    return Boolean(this.pipelineId && this.plan && this.mimeType);
  }

  get streamPlan(): EmbyStreamPlan | undefined {
    return this.plan;
  }

  get currentMediaVersion(): number {
    return this.mediaVersion;
  }

  get playbackQuality(): EmbyPlaybackRequest["quality"] | undefined {
    return this.desiredPlaybackRequest()?.quality;
  }

  get currentRequest(): EmbyPlaybackRequest | undefined {
    const request = this.desiredPlaybackRequest();
    return request ? { ...request } : undefined;
  }

  get segmentRelayActive(): boolean {
    return Boolean(this.segmentRelay && this.segmentDescriptor);
  }

  setSegmentRelayAccess(
    signalUrl: string,
    access: SegmentRelayAccess | undefined,
  ): void {
    if (!access || access.scope !== "publish") {
      this.segmentRelay = undefined;
      return;
    }
    this.segmentRelay = {
      signalUrl,
      access: { ...access },
    };
    if (this.pipelineId && this.bridge.embyUpdateSegmentRelay) {
      void this.bridge
        .embyUpdateSegmentRelay({
          token: access.token,
          expiresAt: access.expiresAt,
        })
        .catch(() => undefined);
    }
  }

  setSegmentRenditionDemand(input: {
    original?: boolean;
    high?: boolean;
    low?: boolean;
    availableUploadBps?: number;
  }): void {
    if (!this.segmentRelayActive || !this.bridge.embyUpdateRenditionDemand) {
      return;
    }
    const normalized = {
      original: input.original === true,
      high: input.high === true,
      low: input.low === true,
      ...(Number.isFinite(Number(input.availableUploadBps)) &&
      Number(input.availableUploadBps) >= 0
        ? { availableUploadBps: Number(input.availableUploadBps) }
        : {}),
    };
    const signature = JSON.stringify(normalized);
    if (signature === this.segmentRenditionDemandSignature) return;
    this.segmentRenditionDemandSignature = signature;
    void this.bridge
      .embyUpdateRenditionDemand(normalized)
      .catch(() => {
        if (this.segmentRenditionDemandSignature === signature) {
          this.segmentRenditionDemandSignature = "";
        }
      });
  }

  get localPlaybackDiagnostics() {
    return {
      ...this.localPlayer.diagnostics,
      sourceTimelineOffsetMs: this.timelineNormalizer.offsetMs,
      sourceTimelineDiscontinuities:
        this.timelineNormalizer.discontinuityCount,
    };
  }

  seekTo(seconds: number): boolean {
    if (
      !this.activeRequest ||
      (!this.active && !this.activeSeekPromise && !this.restarting) ||
      this.destroyed ||
      this.stopping
    ) {
      return false;
    }
    const runtimeSeconds = Math.max(
      0,
      Number(this.plan?.runtimeTicks || 0) / 10_000_000,
    );
    const target = Math.max(
      0,
      Math.min(
        runtimeSeconds > 0 ? runtimeSeconds : 30 * 24 * 60 * 60,
        Number(seconds) || 0,
      ),
    );
    this.scheduleSeek(target);
    return true;
  }

  async start(
    request: EmbyPlaybackRequest,
    title: string,
  ): Promise<{
    plan: EmbyStreamPlan;
    mimeType: string;
    title: string;
  }> {
    if (this.destroyed) throw new Error("Emby 放映管线已经关闭");
    this.clearAutoRecoveryTimer();
    if (!this.restarting) this.autoRecoveryFailures = 0;
    const attempt = ++this.startAttempt;
    if (!this.restarting) {
      this.desiredPausedAfterStart = false;
      this.userWantsPaused = false;
      this.initialPlaybackStarted = false;
    }
    try {
      return await this.startPipelineAttempt(
        request,
        title,
        attempt,
        "replaced",
      );
    } catch (error) {
      if (
        !(error instanceof EmbyStartupCompatibilityError) ||
        this.destroyed ||
        attempt !== this.startAttempt
      ) {
        throw error;
      }
    }

    const fallbackRequest: EmbyPlaybackRequest = {
      ...request,
      quality:
        request.quality === "original" ||
        request.quality?.startsWith("4k-")
          ? "1080p-12"
          : request.quality || "1080p-12",
      allowHevc: false,
      forceVideoTranscode: true,
    };
    this.options.notify(
      "Emby 首次初始化失败，正在切换兼容 H.264 线路重试一次…",
    );
    // Do not start the fallback until the old FFmpeg/proxy pipeline has
    // completely released the Emby playback session. This also prevents a
    // late event from the first pipeline from configuring the replacement.
    await this.stopPipelineOnly("start-compatibility-retry");
    if (this.destroyed || attempt !== this.startAttempt) {
      throw new Error("Emby 启动请求已被更新的操作替代");
    }
    try {
      return await this.startPipelineAttempt(
        fallbackRequest,
        title,
        attempt,
      );
    } catch (error) {
      // The compatibility attempt is terminal: tear it down and return the
      // actual second error without scheduling or recursively entering
      // another retry.
      await this.stopPipelineOnly("start-fallback-error");
      throw error;
    }
  }

  private async startPipelineAttempt(
    request: EmbyPlaybackRequest,
    title: string,
    attempt: number,
    replaceReason?: string,
  ): Promise<{
    plan: EmbyStreamPlan;
    mimeType: string;
    title: string;
  }> {
    if (replaceReason) await this.stopPipelineOnly(replaceReason);
    if (this.destroyed || attempt !== this.startAttempt) {
      throw new Error("Emby 启动请求已被更新的操作替代");
    }
    this.activeRequest = { ...request };
    this.title = String(title || "Emby 影片").slice(0, 300);
    this.plan = undefined;
    this.mimeType = "";
    this.mediaVersion += 1;
    this.segmentDescriptor = undefined;
    let segmentRelayRequest:
      | NonNullable<EmbyPlaybackRequest["segmentRelay"]>
      | undefined;
    if (
      this.segmentRelay?.access.scope === "publish" &&
      this.segmentRelay.access.expiresAt > Date.now()
    ) {
      const assetId = await deriveEmbyAssetId(
        request.accountId,
        request.itemId,
        request.mediaSourceId,
      );
      if (this.destroyed || attempt !== this.startAttempt) {
        throw new Error("Emby 启动请求已被更新的操作替代");
      }
      const baseUrl = buildEmbySegmentRelayBaseUrl(
        this.segmentRelay.signalUrl,
        this.segmentRelay.access,
      ).toString();
      segmentRelayRequest = {
        baseUrl,
        token: this.segmentRelay.access.token,
        roomId: this.options.roomId,
        sessionId: this.sessionId,
        mediaVersion: this.mediaVersion,
        assetId,
      };
      const manifestPath =
        `${new URL(baseUrl).pathname}rooms/${this.options.roomId}/sessions/` +
        `${this.sessionId}/assets/` +
        `${assetId}/versions/${this.mediaVersion}/manifest.json`;
      this.segmentDescriptor = {
        protocol: "synced-cmaf-v1",
        sessionId: this.sessionId,
        assetId,
        mediaVersion: this.mediaVersion,
        manifestPath,
      };
    }
    this.timelineNormalizer.reset(
      Math.max(0, Number(request.startTimeTicks) || 0) / 10_000,
    );
    this.lastMuxedFragmentSeq = 0;
    this.streamHasEnded = false;
    this.localReady = false;
    this.localFailureHandledForVersion = -1;
    this.lastFragmentAt = 0;
    this.lastLocalPlaybackProgressAt = Date.now();
    this.lastLocalPlaybackTime = 0;
    this.suppressHostSeek = true;
    this.clearLocalReadyTimer();
    if (this.startBarrierTimer !== undefined) {
      window.clearTimeout(this.startBarrierTimer);
      this.startBarrierTimer = undefined;
    }
    this.cache.clearVersion(this.mediaVersion);
    for (const state of this.peers.values()) {
      state.ready = false;
      state.sessionReady = false;
      state.slowSamples = 0;
      state.recoveryCooldownMs =
        EMBY_SLOW_PEER_MIN_RECOVERY_COOLDOWN_MS;
      state.healthyRecoverySamples = 0;
      state.transportEpoch = 0;
      state.repairTokens = 128;
      state.repairTokenUpdatedAt = Date.now();
      state.recentRepairRequests.clear();
      state.lastInitRequestAt = 0;
      state.lastBufferStateAt = 0;
      state.mediaFallbackActive = false;
      state.mediaFallbackOffer = undefined;
      const { sender } = state;
      sender.cancelVersionsExcept(this.mediaVersion);
    }
    this.ignoreSeekUntil = Date.now() + 1_500;
    this.stopping = false;
    let pending!: PendingStart;
    const ready = new Promise<{
      plan: EmbyStreamPlan;
      mimeType: string;
      title: string;
    }>((resolve, reject) => {
      pending = {
        resolve,
        reject,
        timer: 0,
        attempt,
        earlyEvents: [],
      };
      this.pendingStart = pending;
      this.armPendingStartTimeout(pending);
    });
    // A stop/replacement can reject this deferred result while the IPC start
    // call is still pending and before start() has returned it to its caller.
    void ready.catch(() => undefined);
    try {
      this.inFlightPipelineStarts += 1;
      const startInvocation = this.bridge.embyStartStream({
        ...request,
        title: this.title,
        ...(segmentRelayRequest
          ? { segmentRelay: segmentRelayRequest }
          : {}),
      });
      void startInvocation
        .finally(() => {
          this.inFlightPipelineStarts = Math.max(
            0,
            this.inFlightPipelineStarts - 1,
          );
        })
        .catch(() => undefined);
      // The first deadline bounds playback planning and also propagates if the
      // IPC invoke itself gets stuck before returning a pipeline id. Once the
      // main process has created a pipeline, give FFmpeg/MSE a fresh init
      // window instead of spending that budget on endpoint selection.
      const pendingFailure = ready.then<never>(
        () => new Promise<never>(() => undefined),
      );
      const result = await Promise.race([startInvocation, pendingFailure]);
      if (
        this.pendingStart !== pending ||
        pending.attempt !== this.startAttempt ||
        this.destroyed
      ) {
        return ready;
      }
      this.armPendingStartTimeout(pending);
      this.expectedPipelineId = result.pipelineId;
      this.pipelineId = result.pipelineId;
      this.plan = result.plan;
      const earlyEvents = pending.earlyEvents.splice(0);
      for (const event of earlyEvents) this.handleStreamEvent(event);
    } catch (error) {
      this.suppressHostSeek = false;
      this.rejectPending(error, pending);
      throw error;
    }
    this.startTimers();
    return ready;
  }

  attachViewer(viewerId: string, pc: RTCPeerConnection): RTCDataChannel {
    if (this.segmentDescriptor) {
      const mediaChannel = pc.createDataChannel(EMBY_DATA_CHANNEL_LABEL, {
        ordered: false,
        maxRetransmits: 1,
      });
      const controlChannel = pc.createDataChannel(
        EMBY_CONTROL_CHANNEL_LABEL,
        { ordered: true },
      );
      this.attachTransport(viewerId, mediaChannel, controlChannel);
      return mediaChannel;
    }
    const channel = pc.createDataChannel(EMBY_DATA_CHANNEL_LABEL, {
      // Avoid reliable SCTP retransmission stalls. The receiver's fragment
      // assembler and bounded application-level NACK path repair the rare
      // missing chunk without holding unrelated traffic behind it.
      ordered: false,
      maxRetransmits: 1,
    });
    const controlChannel = pc.createDataChannel(EMBY_CONTROL_CHANNEL_LABEL, {
      ordered: true,
    });
    this.attachTransport(viewerId, channel, controlChannel);
    return channel;
  }

  attachTransport(
    viewerId: string,
    channel: RTCDataChannel,
    controlChannel: RTCDataChannel = channel,
  ): void {
    this.detachViewer(viewerId, false);
    const initialStats: EmbySenderStats = {
      queuedBytes: 0,
      bufferedBytes: 0,
      queuedMessages: 0,
      droppedFragments: 0,
      recoveryGeneration: 0,
      queuedDurationMs: 0,
      bufferedDurationMs: 0,
      totalQueuedDurationMs: 0,
    };
    const state: PeerState = {
      sender: undefined as unknown as EmbyPeerSender,
      stats: initialStats,
      ready: false,
      sessionReady: false,
      bufferAhead: 0,
      slowSamples: 0,
      recoveries: 0,
      lastCatchUpAt: 0,
      recoveryCooldownMs: EMBY_SLOW_PEER_MIN_RECOVERY_COOLDOWN_MS,
      healthyRecoverySamples: 0,
      lastPressureReportAt: 0,
      observedDroppedFragments: 0,
      observedRecoveryGeneration: 0,
      backlogRecoveryScheduled: false,
      transportEpoch: 0,
      repairTokens: 128,
      repairTokenUpdatedAt: Date.now(),
      recentRepairRequests: new Map(),
      lastInitRequestAt: 0,
      lastSyncPingAt: 0,
      lastBufferStateAt: 0,
      mediaFallbackActive: false,
      lastMediaFallbackAt: 0,
      mediaFallbackOffer: undefined,
    };
    state.sender = new EmbyPeerSender(
      channel,
      (message) => this.handlePeerControl(viewerId, message),
      (stats) => {
        state.stats = stats;
        if (
          stats.recoveryGeneration >
            state.observedRecoveryGeneration &&
          !state.backlogRecoveryScheduled
        ) {
          state.observedRecoveryGeneration = stats.recoveryGeneration;
          state.backlogRecoveryScheduled = true;
          queueMicrotask(() => {
            state.backlogRecoveryScheduled = false;
            if (
              this.peers.get(viewerId) !== state ||
              !state.sessionReady ||
              !this.active
            ) {
              return;
            }
            state.recoveries += 1;
            state.lastCatchUpAt = Date.now();
            this.primeMediaForPeer(
              state,
              Math.max(0, this.options.video.currentTime || 0),
              true,
            );
            this.bridge.reportDiagnostic(
              "emby-keyframe-backlog-recovery",
              {
                viewerId,
                mediaVersion: this.mediaVersion,
                transportEpoch: state.transportEpoch,
                recoveryGeneration: stats.recoveryGeneration,
              },
            );
          });
        }
        this.publishStatus();
      },
      controlChannel,
    );
    if (this.plan?.bitrate) {
      state.sender.setMediaBitrate(this.plan.bitrate);
    }
    this.peers.set(viewerId, state);
    controlChannel.addEventListener(
      "open",
      () => {
        if (this.peers.get(viewerId) !== state) return;
        this.sendSessionToPeer(state);
      },
      { once: true },
    );
    const handleControlClose = () => {
      if (this.peers.get(viewerId) === state) {
        this.peers.delete(viewerId);
        state.sender.close();
        this.maybeStartSynchronizedPlayback();
        this.publishStatus();
      }
    };
    const handleMediaClose = () => {
      if (controlChannel === channel) {
        handleControlClose();
        return;
      }
      if (this.peers.get(viewerId) !== state) return;
      // Keep the reliable control plane alive while this viewer replaces its
      // partial-reliability media path. Closing it here used to discard the
      // very catch-up/session messages needed for isolated recovery.
      state.ready = false;
      this.bridge.reportDiagnostic("emby-viewer-media-channel-closed", {
        viewerId,
        mediaVersion: this.mediaVersion,
        transportEpoch: state.transportEpoch,
      });
      this.publishStatus();
    };
    channel.addEventListener("close", handleMediaClose, { once: true });
    if (controlChannel !== channel) {
      controlChannel.addEventListener("close", handleControlClose, {
        once: true,
      });
    }
    if (controlChannel.readyState === "open") this.sendSessionToPeer(state);
    this.publishStatus();
  }

  detachViewer(viewerId: string, releaseStartBarrier = true): void {
    const state = this.peers.get(viewerId);
    if (!state) return;
    this.peers.delete(viewerId);
    state.sender.close();
    if (viewerId === "__sfu__") this.sfuViewerIds.clear();
    if (releaseStartBarrier) this.maybeStartSynchronizedPlayback();
    this.publishStatus();
  }

  refreshViewer(viewerId: string): void {
    const state = this.peers.get(viewerId);
    if (state) this.sendSessionToPeer(state);
  }

  forgetSfuViewer(viewerId: string): void {
    this.sfuViewerIds.delete(viewerId);
  }

  broadcastPlaybackState(_force = false): void {
    if (!this.active) return;
    this.stateVersion += 1;
    const message: EmbyControlMessage = {
      type: "playback-state",
      sessionId: this.sessionId,
      mediaVersion: this.mediaVersion,
      stateVersion: this.stateVersion,
      currentTime: this.options.video.currentTime || 0,
      paused: this.options.video.paused,
      playbackRate: this.options.video.playbackRate || 1,
      serverTimeMs: Date.now(),
    };
    for (const { sender } of this.peers.values()) {
      sender.sendControl(message, true);
    }
  }

  markEnded(priority = false): void {
    if (!this.active) return;
    this.streamHasEnded = true;
    for (const state of this.peers.values()) {
      // End-of-stream must remain behind every already queued media chunk.
      this.sendEndedToPeer(state, priority);
    }
    this.localPlayer.markEnded();
  }

  private sendEndedToPeer(state: PeerState, priority = false): void {
    state.sender.sendControl(
      {
        type: "stream-ended",
        sessionId: this.sessionId,
        mediaVersion: this.mediaVersion,
        transportEpoch: state.transportEpoch,
        finalFragmentSeq: this.lastMuxedFragmentSeq,
        finalTrackType: "muxed",
      },
      priority,
    );
  }

  async stop(logout = false): Promise<void> {
    if (this.destroyed && !logout) return;
    this.cancelScheduledSeek();
    this.cancelQueuedRestarts();
    this.clearAutoRecoveryTimer();
    this.autoRecoveryFailures = 0;
    this.streamReadyAt = 0;
    this.startAttempt += 1;
    this.stopping = true;
    if (this.active) this.markEnded(true);
    // Playback telemetry must never delay FFmpeg/proxy teardown when the
    // Emby server is offline. The main process also sends a best-effort stop
    // report from its captured pipeline state.
    void this.reportPlayback("stop", "Stop").catch(() => undefined);
    await this.stopPipelineOnly("broadcast-stopped");
    for (const [viewerId] of this.peers) this.detachViewer(viewerId);
    this.initialPlaybackStarted = false;
    this.plan = undefined;
    this.mimeType = "";
    this.cache.clearVersion();
    this.stopTimers();
    if (logout) {
      await this.settleIpcOperation(
        Promise.resolve().then(() => this.bridge.embyLogout()),
        EMBY_LOGOUT_TIMEOUT_MS,
        "emby-logout",
        "",
      );
    }
  }

  async setQuality(
    quality: EmbyPlaybackRequest["quality"],
    reason = "观众链路变化",
  ): Promise<boolean> {
    return this.setPlaybackProfile({ quality }, reason);
  }

  async setFrameRate(
    frameRate: NonNullable<EmbyPlaybackRequest["frameRate"]>,
    reason = "帧率设置变化",
  ): Promise<boolean> {
    return this.setPlaybackProfile({ frameRate }, reason);
  }

  async setPlaybackProfile(
    profile: {
      quality?: EmbyPlaybackRequest["quality"];
      frameRate?: NonNullable<EmbyPlaybackRequest["frameRate"]>;
    },
    reason = "共享流设置变化",
  ): Promise<boolean> {
    const currentRequest = this.desiredPlaybackRequest();
    if (
      !currentRequest ||
      (!this.active && !this.restarting) ||
      this.destroyed
    ) {
      return false;
    }
    const nextRequest: EmbyPlaybackRequest = {
      ...currentRequest,
      ...(profile.quality ? { quality: profile.quality } : {}),
      ...(profile.frameRate ? { frameRate: profile.frameRate } : {}),
    };
    if (
      nextRequest.quality === currentRequest.quality &&
      (nextRequest.frameRate || 30) ===
        (currentRequest.frameRate || 30)
    ) {
      return false;
    }
    this.activeRequest = nextRequest;
    await this.restartAt(
      this.getRestartTime(),
      `${reason}，正在无缝重建 ${
        nextRequest.quality === "original"
          ? "原画"
          : nextRequest.quality
      } · ${nextRequest.frameRate || 30} 帧媒体流…`,
      undefined,
      nextRequest,
    );
    return true;
  }

  async setAudioTrack(audioStreamIndex: number): Promise<void> {
    const currentRequest = this.desiredPlaybackRequest();
    if (
      !currentRequest ||
      (!this.active && !this.restarting) ||
      this.destroyed ||
      currentRequest.audioStreamIndex === audioStreamIndex
    ) {
      return;
    }
    const nextRequest = { ...currentRequest, audioStreamIndex };
    this.activeRequest = nextRequest;
    await this.restartAt(
      this.getRestartTime(),
      "正在切换音轨，重新建立媒体流…",
      undefined,
      nextRequest,
    );
  }

  async setSubtitleTrack(subtitleStreamIndex: number | undefined): Promise<void> {
    const currentRequest = this.desiredPlaybackRequest();
    if (
      !currentRequest ||
      (!this.active && !this.restarting) ||
      this.destroyed ||
      currentRequest.subtitleStreamIndex === subtitleStreamIndex
    ) {
      return;
    }
    const nextRequest = { ...currentRequest, subtitleStreamIndex };
    this.activeRequest = nextRequest;
    await this.restartAt(
      this.getRestartTime(),
      subtitleStreamIndex !== undefined
        ? "正在切换字幕轨，重新建立媒体流…"
        : "正在关闭字幕，重新建立媒体流…",
      undefined,
      nextRequest,
    );
  }

  async destroy(): Promise<void> {
    if (this.destroyed || this.destroying) return;
    this.destroying = true;
    try {
      await this.stop(false);
      this.destroyed = true;
      this.removeStreamListener?.();
      this.removeStreamListener = undefined;
      this.options.video.removeEventListener("play", this.handleHostPlay);
      this.options.video.removeEventListener("pause", this.handleHostPause);
      this.options.video.removeEventListener("ratechange", this.handleHostRate);
      this.options.video.removeEventListener("seeking", this.handleHostSeeking);
      document.removeEventListener(
        "visibilitychange",
        this.handleVisibilityChange,
      );
      this.localPlayer.destroy();
    } finally {
      this.destroying = false;
    }
  }

  private readonly handleHostPlay = (): void => {
    if (!this.active) return;
    this.userWantsPaused = false;
    if (this.localReady) {
      this.initialPlaybackStarted = true;
      if (this.startBarrierTimer !== undefined) {
        window.clearTimeout(this.startBarrierTimer);
        this.startBarrierTimer = undefined;
      }
    }
    if (Date.now() < this.ignoreSeekUntil) return;
    this.broadcastPlaybackState(true);
    void this.reportPlayback("progress", "Unpause");
  };

  private readonly handleHostPause = (): void => {
    if (!this.active || this.stopping || Date.now() < this.ignoreSeekUntil) {
      return;
    }
    if (this.localReady && !this.options.video.error) {
      this.userWantsPaused = true;
    }
    this.broadcastPlaybackState(true);
    void this.reportPlayback("progress", "Pause");
  };

  private readonly handleHostRate = (): void => {
    if (!this.active) return;
    this.broadcastPlaybackState(true);
  };

  private readonly handleHostSeeking = (): void => {
    if (
      !this.active ||
      this.stopping ||
      this.suppressHostSeek ||
      Date.now() < this.ignoreSeekUntil
    ) {
      return;
    }
    const target = Math.max(0, this.options.video.currentTime || 0);
    this.scheduleSeek(target);
  };

  private scheduleSeek(target: number): void {
    this.pendingSeekSeconds = Math.max(0, Number(target) || 0);
    const revision = ++this.seekRevision;
    if (this.seekTimer !== undefined) window.clearTimeout(this.seekTimer);
    this.seekTimer = window.setTimeout(() => {
      this.seekTimer = undefined;
      void this.commitScheduledSeek(revision);
    }, 360);
  }

  private async commitScheduledSeek(revision: number): Promise<void> {
    if (
      revision !== this.seekRevision ||
      this.pendingSeekSeconds === undefined ||
      this.destroyed ||
      this.stopping
    ) {
      return;
    }
    const inFlightRestart =
      this.activeSeekPromise || this.restartOperation;
    if (inFlightRestart) {
      if (!this.seekCancellation) {
        // A seek is the newest explicit user intent. Cancel any in-flight
        // seek/profile/audio rebuild instead of polling a boolean forever.
        // The renderer start promise is rejected synchronously and every IPC
        // teardown wait below has its own deadline.
        this.startAttempt += 1;
        this.seekCancellation = this.stopPipelineOnly(
          "seek-superseded",
        ).catch(() => undefined);
      }
      await Promise.allSettled([
        inFlightRestart,
        this.seekCancellation,
      ]);
      this.seekCancellation = undefined;
      if (revision !== this.seekRevision) return;
    }
    if (
      revision !== this.seekRevision ||
      this.pendingSeekSeconds === undefined
    ) {
      return;
    }
    const target = this.pendingSeekSeconds;
    this.pendingSeekSeconds = undefined;
    const operation = this.restartAt(target, undefined, revision);
    this.activeSeekPromise = operation;
    try {
      await operation;
    } finally {
      if (this.activeSeekPromise === operation) {
        this.activeSeekPromise = undefined;
      }
      if (
        this.pendingSeekSeconds !== undefined &&
        this.seekTimer === undefined &&
        !this.destroyed &&
        !this.stopping
      ) {
        const latestRevision = this.seekRevision;
        this.seekTimer = window.setTimeout(() => {
          this.seekTimer = undefined;
          void this.commitScheduledSeek(latestRevision);
        }, 0);
      }
    }
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState !== "visible" || !this.active) return;
    this.broadcastPlaybackState(true);
    void this.reportPlayback("progress", "TimeUpdate");
  };

  private getRestartTime(): number {
    // Creating/replacing an MSE object resets HTMLMediaElement.currentTime to
    // zero before the first frame is ready. A viewer quality request can land
    // in exactly that window; use the requested movie position until the
    // replacement player has actually crossed its decode barrier.
    return this.localReady
      ? Math.max(0, Number(this.options.video.currentTime) || 0)
      : Math.max(
          0,
          Number(this.desiredPlaybackRequest()?.startTimeTicks || 0) /
            10_000_000,
        );
  }

  private desiredPlaybackRequest(): EmbyPlaybackRequest | undefined {
    return (
      this.pendingRestart?.request ||
      this.runningRestart?.request ||
      this.activeRequest
    );
  }

  private restartAt(
    seconds: number,
    notice?: string,
    seekRevision?: number,
    request: EmbyPlaybackRequest | undefined = this.activeRequest,
  ): Promise<void> {
    if (!request || this.destroyed) return Promise.resolve();
    const normalizedSeconds = Math.max(0, Number(seconds) || 0);
    const signature = JSON.stringify({
      seconds: Math.round(normalizedSeconds * 1_000),
      request,
    });
    let resolveWaiter!: () => void;
    const waiter = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
    if (this.pendingRestart?.signature === signature) {
      this.pendingRestart.waiters.push(resolveWaiter);
      return waiter;
    }
    if (
      !this.pendingRestart &&
      this.runningRestart?.signature === signature
    ) {
      this.runningRestart.waiters.push(resolveWaiter);
      return waiter;
    }

    const waiters = [
      ...(this.pendingRestart?.waiters || []),
      resolveWaiter,
    ];
    if (this.runningRestart) {
      waiters.unshift(...this.runningRestart.waiters.splice(0));
    }
    const intent: RestartIntent = {
      id: ++this.restartRevision,
      signature,
      request: { ...request },
      seconds: normalizedSeconds,
      notice,
      seekRevision,
      waiters,
    };
    this.pendingRestart = intent;

    if (this.runningRestart && !this.restartCancellation) {
      // A later quality/audio/subtitle operation owns the desired pipeline.
      // Reject the stale deferred start immediately, while one bounded
      // teardown releases any FFmpeg/proxy work before the latest intent runs.
      this.startAttempt += 1;
      this.restartCancellation = this.stopPipelineOnly(
        "restart-superseded",
      )
        .catch(() => undefined)
        .finally(() => {
          this.restartCancellation = undefined;
        });
    }
    this.startRestartDrain();
    return waiter;
  }

  private startRestartDrain(): void {
    if (this.restartOperation || this.destroyed) return;
    this.restarting = true;
    const operation = this.drainRestarts().finally(() => {
      if (this.restartOperation !== operation) return;
      this.restartOperation = undefined;
      this.restarting = false;
      if (this.pendingRestart && !this.destroyed) {
        this.startRestartDrain();
      }
    });
    this.restartOperation = operation;
  }

  private async drainRestarts(): Promise<void> {
    while (this.pendingRestart && !this.destroyed) {
      if (this.restartCancellation) await this.restartCancellation;
      const intent = this.pendingRestart;
      this.pendingRestart = undefined;
      this.runningRestart = intent;
      try {
        await this.performRestartAt(intent);
      } catch (error) {
        if (intent.id === this.restartRevision && !this.destroyed) {
          this.options.notify(
            error instanceof Error
              ? error.message
              : "Emby 媒体流重建失败",
            true,
          );
        }
      } finally {
        for (const resolve of intent.waiters.splice(0)) resolve();
        if (this.runningRestart === intent) this.runningRestart = undefined;
      }
    }
  }

  private async performRestartAt(
    intent: RestartIntent,
  ): Promise<void> {
    const {
      id,
      request,
      seconds,
      notice,
      seekRevision,
    } = intent;
    if (this.destroyed) return;
    // MSE is intentionally paused before the startup buffer barrier and may
    // also auto-pause on decoder failure. Preserve explicit user intent, not
    // that transient media-element state, across a compatibility rebuild.
    const wasPaused = this.userWantsPaused;
    this.desiredPausedAfterStart = wasPaused;
    const transitionVersion = this.mediaVersion;
    if (transitionVersion > 0) {
      for (const state of this.peers.values()) {
        state.ready = false;
        state.sender.sendControl({
          type: "stream-transition",
          sessionId: this.sessionId,
          mediaVersion: transitionVersion,
          nextMediaVersion: Math.min(
            1_000_000_000,
            transitionVersion + 1,
          ),
          targetTime: Math.max(0, seconds),
        });
      }
      this.publishStatus();
    }
    this.options.notify(
      notice ||
        `正在从 ${Math.floor(seconds / 60)}:${String(
          Math.floor(seconds % 60),
        ).padStart(2, "0")} 重新建立关键帧缓存…`,
    );
    try {
      await this.start(
        {
          ...request,
          startTimeTicks: Math.round(seconds * 10_000_000),
        },
        this.title,
      );
      this.broadcastPlaybackState(true);
      void this.reportPlayback("progress", "TimeUpdate");
    } catch (error) {
      this.desiredPausedAfterStart = wasPaused;
      const superseded =
        id !== this.restartRevision ||
        (seekRevision !== undefined && seekRevision !== this.seekRevision);
      if (!superseded) {
        this.options.notify(
          error instanceof Error ? error.message : "Emby 跳转失败",
          true,
        );
      }
    }
  }

  private handleStreamEvent(event: EmbyStreamEvent): void {
    if (this.destroyed) return;
    if (this.pendingStart && !this.expectedPipelineId) {
      // Electron can deliver stream events before the invoke() result that
      // identifies the new pipeline. Keep them scoped to this one start
      // attempt, then replay only the events matching the returned id.
      if (this.pendingStart.earlyEvents.length >= 128) {
        const staleFragment = this.pendingStart.earlyEvents.findIndex(
          (item) => item.type === "fragment",
        );
        this.pendingStart.earlyEvents.splice(
          staleFragment >= 0 ? staleFragment : 0,
          1,
        );
      }
      this.pendingStart.earlyEvents.push(event);
      return;
    }
    if (
      !this.expectedPipelineId ||
      event.pipelineId !== this.expectedPipelineId
    ) {
      return;
    }
    if (event.type === "started") {
      this.pipelineId = event.pipelineId;
      this.plan = event.plan;
      return;
    }
    if (event.type === "init") {
      this.pipelineId = event.pipelineId;
      this.plan = event.plan;
      this.mimeType = event.mimeType;
      this.streamReadyAt = Date.now();
      this.lastFragmentAt = this.streamReadyAt;
      this.lastLocalPlaybackProgressAt = this.streamReadyAt;
      this.lastLocalPlaybackTime = Math.max(
        0,
        Number(this.options.video.currentTime) || 0,
      );
      const detail = {
        plan: event.plan,
        mimeType: event.mimeType,
        title: this.title,
      };
      this.localPlayer.configure({
        roomId: this.options.roomId,
        sessionId: this.sessionId,
        mediaVersion: this.mediaVersion,
        mimeType: event.mimeType,
        plan: event.plan,
        title: this.title,
      });
      const bufferProfile = this.localPlayer.bufferProfile || {
        initialSeconds: 10,
        targetSeconds: 64,
        maxSeconds: 90,
        memoryBudgetBytes: 320 * 1024 * 1024,
      };
      this.cache.configureLimits(
        this.segmentDescriptor
          ? Math.min(
              60_000,
              Math.max(
                30_000,
                Math.ceil(bufferProfile.maxSeconds * 1_000),
              ),
            )
          : Math.min(
              180_000,
              Math.max(
                60_000,
                Math.ceil(bufferProfile.maxSeconds * 1_250),
              ),
            ),
        Math.min(
          this.segmentDescriptor
            ? 160 * 1024 * 1024
            : 320 * 1024 * 1024,
          Math.max(
            96 * 1024 * 1024,
            Math.floor(bufferProfile.memoryBudgetBytes * 0.75),
          ),
        ),
      );
      const init: EmbyTransportFragment = {
        roomId: this.options.roomId,
        sessionId: this.sessionId,
        mediaVersion: this.mediaVersion,
        sequence: 0,
        timestampMs: Date.now(),
        mediaTimeMs: event.plan.startTimeTicks / 10_000,
        timelineTimeMs: event.plan.startTimeTicks / 10_000,
        trackType: "muxed",
        keyframe: true,
        data: event.data,
      };
      this.cache.setInit(init);
      this.localPlayer.appendInit(event.data);
      this.armLocalReadyTimer();
      this.syncFlowControl();
      for (const state of this.peers.values()) this.sendSessionToPeer(state);
      this.resolvePending(detail);
      this.options.onStreamReady(detail);
      return;
    }
    if (event.type === "fragment") {
      if (!this.plan || event.pipelineId !== this.pipelineId) return;
      this.lastFragmentAt = Date.now();
      if (event.timelineRepairs?.length) {
        this.bridge.reportDiagnostic("emby-track-timeline-repaired", {
          mediaVersion: this.mediaVersion,
          repairs: event.timelineRepairs.slice(0, 8),
        });
      }
      this.lastMuxedFragmentSeq = Math.max(
        this.lastMuxedFragmentSeq,
        event.sequence,
      );
      const timeline = this.timelineNormalizer.normalize(
        event.mediaTimeMs,
        event.sequence,
      );
      if (timeline.discontinuity) {
        this.bridge.reportDiagnostic("emby-source-timeline-repaired", {
          mediaVersion: this.mediaVersion,
          sequence: event.sequence,
          mediaTimeMs: event.mediaTimeMs,
          timelineTimeMs: timeline.timelineTimeMs,
          timestampOffsetMs: timeline.timestampOffsetMs,
          discontinuities: this.timelineNormalizer.discontinuityCount,
        });
      }
      const fragment: EmbyTransportFragment = {
        roomId: this.options.roomId,
        sessionId: this.sessionId,
        mediaVersion: this.mediaVersion,
        sequence: event.sequence,
        timestampMs: event.timestampMs,
        mediaTimeMs: event.mediaTimeMs,
        timelineTimeMs: timeline.timelineTimeMs,
        trackType: "muxed",
        keyframe: event.keyframe,
        data: event.data,
      };
      this.cache.add(fragment);
      this.localPlayer.appendFragment(fragment);
      for (const state of this.peers.values()) {
        if (
          state.sessionReady &&
          (!this.segmentDescriptor || state.mediaFallbackActive)
        ) {
          state.sender.sendFragment(fragment, {
            transportEpoch: state.transportEpoch,
          });
        }
      }
      // IPC can have fragments already in flight after stdout is paused. Use
      // those events to observe a drained append queue and resume immediately.
      this.syncFlowControl();
      return;
    }
    if (event.type === "subtitle") {
      if (!event.subtitle.supported || !event.subtitle.text) {
        if (event.subtitle.message) {
          this.options.notify(event.subtitle.message, true);
        }
        return;
      }
      const data = new TextEncoder().encode(event.subtitle.text);
      const fragment: EmbyTransportFragment = {
        roomId: this.options.roomId,
        sessionId: this.sessionId,
        mediaVersion: this.mediaVersion,
        sequence: 0,
        timestampMs: Date.now(),
        mediaTimeMs: 0,
        trackType: "subtitle",
        keyframe: true,
        data,
      };
      this.cache.add(fragment);
      this.localPlayer.applySubtitle(event.subtitle.text);
      for (const state of this.peers.values()) {
        if (
          state.sessionReady &&
          (!this.segmentDescriptor || state.mediaFallbackActive)
        ) {
          state.sender.sendFragment(fragment, {
            priority: true,
            transportEpoch: state.transportEpoch,
          });
        }
      }
      return;
    }
    if (event.type === "ended") {
      this.markEnded();
      return;
    }
    if (event.type === "error") {
      const failedDuringStartup = Boolean(this.pendingStart);
      const error = failedDuringStartup
        ? new EmbyStartupCompatibilityError(
            event.message || "Emby 媒体流处理失败",
          )
        : new Error(event.message || "Emby 媒体流处理失败");
      this.rejectPending(error);
      this.options.notify(error.message, true);
      for (const { sender } of this.peers.values()) {
        sender.sendControl({
          type: "error",
          sessionId: this.sessionId,
          mediaVersion: this.mediaVersion,
          message: error.message,
        });
      }
      if (!failedDuringStartup) {
        void this.stopPipelineOnly("stream-error");
        // Established playback gets two bounded recovery attempts. A stream
        // that has stayed healthy for 30 seconds earns a fresh recovery
        // budget. Pre-init failures are handled synchronously by start(),
        // which performs exactly one compatibility attempt.
        this.scheduleAutoRecovery();
      }
    }
  }

  private scheduleAutoRecovery(): void {
    if (
      this.destroyed ||
      this.stopping ||
      this.restarting ||
      !this.activeRequest
    ) {
      return;
    }
    if (
      this.streamReadyAt > 0 &&
      Date.now() - this.streamReadyAt >= EMBY_STABLE_STREAM_RESET_MS
    ) {
      this.autoRecoveryFailures = 0;
    }
    this.streamReadyAt = 0;
    this.autoRecoveryFailures += 1;
    if (this.autoRecoveryFailures > EMBY_MAX_AUTO_RECOVERIES) {
      this.options.notify(
        "媒体流连续恢复失败，已停止自动重试；请检查 Emby 线路后手动重试",
        true,
      );
      return;
    }
    this.clearAutoRecoveryTimer();
    const delay =
      EMBY_RECOVERY_DELAYS_MS[this.autoRecoveryFailures - 1] ??
      EMBY_RECOVERY_DELAYS_MS.at(-1) ??
      5_000;
    this.autoRecoveryTimer = window.setTimeout(() => {
      this.autoRecoveryTimer = undefined;
      if (
        this.destroyed ||
        this.stopping ||
        this.restarting ||
        !this.activeRequest
      ) {
        return;
      }
      const currentTime = this.localReady
        ? Math.max(0, this.options.video.currentTime || 0)
        : Math.max(
            0,
            Number(this.activeRequest.startTimeTicks || 0) / 10_000_000,
          );
      void this.restartAt(
        currentTime,
        `媒体流出错，正在自动恢复（${this.autoRecoveryFailures}/${EMBY_MAX_AUTO_RECOVERIES}）…`,
      );
    }, delay);
  }

  private armLocalReadyTimer(graceUsed = false): void {
    this.clearLocalReadyTimer();
    const mediaVersion = this.mediaVersion;
    this.localReadyTimer = window.setTimeout(() => {
      this.localReadyTimer = undefined;
      if (
        this.destroyed ||
        this.stopping ||
        this.localReady ||
        mediaVersion !== this.mediaVersion
      ) {
        return;
      }
      const diagnostics = this.localPlayer.diagnostics;
      const mediaIsStillProgressing =
        diagnostics.mediaSourceState === "open" &&
        diagnostics.sourceBufferAttached &&
        (diagnostics.bufferedRanges > 0 ||
          diagnostics.appendBusy ||
          diagnostics.appendQueueItems > 0);
      if (!graceUsed && mediaIsStillProgressing) {
        this.armLocalReadyTimer(true);
        return;
      }
      this.handleLocalPlaybackFailure(
        "本地播放器未能在预期时间内完成解码，正在切换兼容 H.264 播放线路",
      );
    }, graceUsed ? EMBY_LOCAL_READY_GRACE_MS : EMBY_LOCAL_READY_TIMEOUT_MS);
  }

  private clearLocalReadyTimer(): void {
    if (this.localReadyTimer === undefined) return;
    window.clearTimeout(this.localReadyTimer);
    this.localReadyTimer = undefined;
  }

  private handleLocalPlaybackFailure(message: string): void {
    if (
      this.destroyed ||
      this.stopping ||
      !this.activeRequest ||
      this.localFailureHandledForVersion === this.mediaVersion
    ) {
      return;
    }
    this.localFailureHandledForVersion = this.mediaVersion;
    this.clearLocalReadyTimer();
    const diagnostics = this.localPlayer.diagnostics;
    this.bridge.reportDiagnostic("emby-local-player-failure", {
      mediaVersion: this.mediaVersion,
      method: this.plan?.method,
      videoCodec: this.plan?.videoCodec,
      audioCodec: this.plan?.audioCodec,
      forceVideoTranscode: this.activeRequest.forceVideoTranscode === true,
      mediaSourceState: diagnostics.mediaSourceState,
      sourceBufferAttached: diagnostics.sourceBufferAttached,
      sourceBufferUpdating: diagnostics.sourceBufferUpdating,
      appendBusy: diagnostics.appendBusy,
      appendQueueItems: diagnostics.appendQueueItems,
      appendQueueBytes: diagnostics.appendQueueBytes,
      pendingMediaItems: diagnostics.pendingMediaItems,
      pendingMediaBytes: diagnostics.pendingMediaBytes,
      readyState: diagnostics.readyState,
      networkState: diagnostics.networkState,
      mediaErrorCode: diagnostics.mediaErrorCode,
      videoWidth: diagnostics.videoWidth,
      videoHeight: diagnostics.videoHeight,
      bufferedRanges: diagnostics.bufferedRanges,
      bufferedAhead: diagnostics.bufferedAhead,
    });
    this.options.notify(message, true);
    // The source profile or exact MSE codec was rejected. Renegotiate with
    // stream copy disabled and HEVC off; Emby then returns browser-safe H.264
    // while preserving the user's selected resolution/bitrate class.
    const recoveryTime = this.localReady
      ? Math.max(0, this.options.video.currentTime || 0)
      : Math.max(
          0,
          Number(this.activeRequest.startTimeTicks || 0) / 10_000_000,
        );
    this.activeRequest = {
      ...this.activeRequest,
      allowHevc: false,
      forceVideoTranscode: true,
      startTimeTicks: Math.round(recoveryTime * 10_000_000),
    };
    void this.stopPipelineOnly("local-player-error").finally(() => {
      this.scheduleAutoRecovery();
    });
  }

  private clearAutoRecoveryTimer(): void {
    if (this.autoRecoveryTimer === undefined) return;
    window.clearTimeout(this.autoRecoveryTimer);
    this.autoRecoveryTimer = undefined;
  }

  private sendSessionToPeer(state: PeerState): void {
    if (!this.plan || !this.mimeType) return;
    state.sender.cancelVersionsExcept(this.mediaVersion);
    state.sender.setMediaBitrate(this.plan.bitrate);
    state.ready = false;
    state.sessionReady = false;
    state.sender.sendControl({
      type: "session",
      roomId: this.options.roomId,
      sessionId: this.sessionId,
      mediaVersion: this.mediaVersion,
      transportEpoch: state.transportEpoch,
      mimeType: this.mimeType,
      plan: this.plan,
      title: this.title,
      ...(this.segmentDescriptor
        ? { segmentRelay: this.segmentDescriptor }
        : {}),
    });
    this.broadcastPlaybackState(true);
  }

  private primeMediaForPeer(
    state: PeerState,
    targetTime = this.options.video.currentTime,
    clearQueuedMedia = false,
    transportEpochOverride?: number,
  ): void {
    if (!state.sessionReady) return;
    if (this.segmentDescriptor && !state.mediaFallbackActive) {
      this.broadcastPlaybackState(true);
      if (this.streamHasEnded) this.sendEndedToPeer(state);
      return;
    }
    const mediaVersion = this.mediaVersion;
    const sessionId = this.sessionId;
    if (clearQueuedMedia) {
      state.transportEpoch =
        Number.isSafeInteger(transportEpochOverride) &&
        Number(transportEpochOverride) > state.transportEpoch &&
        Number(transportEpochOverride) <= 1_000_000_000
          ? Number(transportEpochOverride)
          : Math.min(
              1_000_000_000,
              state.transportEpoch + 1,
            );
    }
    const transportEpoch = state.transportEpoch;
    const sendCachedMedia = (): void => {
      if (
        !state.sessionReady ||
        this.mediaVersion !== mediaVersion ||
        state.transportEpoch !== transportEpoch
      ) {
        return;
      }
      const init = this.cache.getInit(mediaVersion);
      if (init) {
        state.sender.sendFragment(init, {
          priority: true,
          transportEpoch,
        });
      }
      const currentMs = Math.max(0, targetTime * 1_000 - 1_000);
      let primedBytes = 0;
      for (const fragment of this.cache.after(
        mediaVersion,
        currentMs,
        128,
      )) {
        if (
          primedBytes > 0 &&
          primedBytes + fragment.data.byteLength >
            state.sender.primeBudgetBytes
        ) {
          break;
        }
        state.sender.sendFragment(fragment, { transportEpoch });
        primedBytes += fragment.data.byteLength;
      }
      const subtitle = this.cache.get(mediaVersion, 0, "subtitle");
      if (subtitle) {
        state.sender.sendFragment(subtitle, {
          priority: true,
          transportEpoch,
        });
      }
      this.broadcastPlaybackState(true);
      if (this.streamHasEnded) this.sendEndedToPeer(state);
    };
    if (clearQueuedMedia) {
      state.sender.clearMediaQueue({ waitForKeyframe: true });
      state.sender.sendControl({
        type: "resync",
        sessionId,
        mediaVersion,
        transportEpoch,
        targetTime: Math.max(0, targetTime),
      });
      // Normal epoch advancement is safe even when media wins the SCTP race:
      // the receiver treats the higher-epoch media header as an atomic queue
      // reset. Segment fallback uses an explicit offer/ready barrier before
      // this point, so no timing delay is needed on either path.
      sendCachedMedia();
      return;
    }
    sendCachedMedia();
  }

  private validMediaFallbackRequest(
    viewerId: string,
    message: Extract<
      EmbyControlMessage,
      { type: "segment-fallback-request" }
    >,
  ): boolean {
    return (
      viewerId !== "__sfu__" &&
      Boolean(this.segmentDescriptor) &&
      /^[a-z0-9-]{8,64}$/i.test(message.requestId) &&
      Number.isSafeInteger(message.transportEpoch) &&
      message.transportEpoch >= 0 &&
      message.transportEpoch <= 1_000_000_000 &&
      Number.isFinite(message.targetTime) &&
      message.targetTime >= 0 &&
      message.targetTime <= 30 * 24 * 60 * 60
    );
  }

  private sendMediaFallbackOffer(state: PeerState): void {
    const offer = state.mediaFallbackOffer;
    const normalizedMimeType = this.mimeType.toLowerCase();
    const mimeMatchesPlan =
      /\bmp4a\./i.test(normalizedMimeType) &&
      (this.plan?.videoCodec === "h264"
        ? /\bavc[13]\./i.test(normalizedMimeType)
        : this.plan?.videoCodec === "hevc" &&
          /\b(?:hvc1|hev1)\./i.test(normalizedMimeType));
    if (
      !offer ||
      !this.plan ||
      !this.mimeType ||
      !["h264", "hevc"].includes(this.plan.videoCodec) ||
      this.plan.audioCodec !== "aac" ||
      !mimeMatchesPlan
    ) {
      return;
    }
    const videoCodec = this.plan.videoCodec as "h264" | "hevc";
    state.sender.sendControl(
      {
        type: "segment-fallback-offer",
        requestId: offer.requestId,
        sessionId: this.sessionId,
        mediaVersion: this.mediaVersion,
        transportEpoch: offer.transportEpoch,
        mimeType: this.mimeType,
        videoCodec,
        audioCodec: "aac",
        plan: this.plan,
        targetTime: offer.targetTime,
      },
      true,
    );
  }

  private acknowledgeMediaFallback(
    state: PeerState,
    offer: NonNullable<PeerState["mediaFallbackOffer"]>,
  ): void {
    state.sender.sendControl(
      {
        type: "segment-fallback-ack",
        requestId: offer.requestId,
        sessionId: this.sessionId,
        mediaVersion: this.mediaVersion,
        transportEpoch: offer.transportEpoch,
      },
      true,
    );
  }

  private offerMediaFallbackToPeer(
    viewerId: string,
    state: PeerState,
    message: Extract<
      EmbyControlMessage,
      { type: "segment-fallback-request" }
    >,
  ): void {
    const existing = state.mediaFallbackOffer;
    if (existing?.requestId === message.requestId) {
      if (state.sessionReady) {
        this.sendMediaFallbackOffer(state);
        if (existing.activated) {
          this.acknowledgeMediaFallback(state, existing);
        }
      }
      return;
    }
    if (message.transportEpoch !== state.transportEpoch) return;
    const transportEpoch = Math.min(
      1_000_000_000,
      state.transportEpoch + 1,
    );
    if (transportEpoch <= state.transportEpoch) return;
    state.mediaFallbackOffer = {
      requestId: message.requestId,
      targetTime: message.targetTime,
      transportEpoch,
      activated: false,
    };
    if (!state.sessionReady) {
      return;
    }
    this.sendMediaFallbackOffer(state);
    this.bridge.reportDiagnostic("emby-segment-media-fallback-offered", {
      viewerId,
      mediaVersion: this.mediaVersion,
      requestId: message.requestId,
      transportEpoch,
      mimeType: this.mimeType,
      videoCodec: this.plan?.videoCodec,
      audioCodec: this.plan?.audioCodec,
    });
  }

  private activateMediaFallbackForPeer(
    viewerId: string,
    state: PeerState,
    message: Extract<
      EmbyControlMessage,
      { type: "segment-fallback-ready" }
    >,
  ): void {
    const offer = state.mediaFallbackOffer;
    if (
      !offer ||
      offer.requestId !== message.requestId ||
      offer.transportEpoch !== message.transportEpoch
    ) {
      return;
    }
    if (offer.activated) {
      this.acknowledgeMediaFallback(state, offer);
      return;
    }
    const now = Date.now();
    state.mediaFallbackActive = true;
    state.lastMediaFallbackAt = now;
    offer.activated = true;
    this.primeMediaForPeer(
      state,
      offer.targetTime,
      true,
      offer.transportEpoch,
    );
    this.bridge.reportDiagnostic(
      "emby-segment-media-fallback-started",
      {
        viewerId,
        mediaVersion: this.mediaVersion,
        requestId: offer.requestId,
        targetTime: offer.targetTime,
        transportEpoch: state.transportEpoch,
      },
    );
    // The ACK is queued after resync/init/media. The media and control SCTP
    // streams may still interleave, but the viewer's READY guaranteed that
    // the offered MIME/profile and epoch were installed first.
    this.acknowledgeMediaFallback(state, offer);
  }

  private handlePeerControl(
    viewerId: string,
    message: EmbyControlMessage,
  ): void {
    const state = this.peers.get(viewerId);
    if (!state) return;
    if (message.type === "sync-ping") {
      if (!Number.isFinite(message.clientTimeMs)) return;
      const sfuViewerId =
        viewerId === "__sfu__"
          ? String(
              (message as EmbyControlMessage & {
                __sfuViewerId?: unknown;
              }).__sfuViewerId || "",
            )
          : "";
      if (
        /^[0-9a-f-]{8,64}$/i.test(sfuViewerId) &&
        !this.sfuViewerIds.has(sfuViewerId)
      ) {
        this.sfuViewerIds.add(sfuViewerId);
        this.sendSessionToPeer(state);
      }
      const now = Date.now();
      if (now - state.lastSyncPingAt < 100) return;
      state.lastSyncPingAt = now;
      state.sender.sendControl({
        type: "sync-pong",
        clientTimeMs: message.clientTimeMs,
        clientMonotonicMs: message.clientMonotonicMs,
        hostTimeMs: Date.now(),
      });
      return;
    }
    if (
      "sessionId" in message &&
      message.sessionId !== this.sessionId
    ) {
      return;
    }
    if (
      "mediaVersion" in message &&
      message.mediaVersion !== this.mediaVersion
    ) {
      return;
    }
    if (
      "transportEpoch" in message &&
      message.transportEpoch !== undefined &&
      message.transportEpoch !== state.transportEpoch &&
      message.type !== "segment-fallback-request" &&
      message.type !== "segment-fallback-ready"
    ) {
      return;
    }
    if (message.type === "segment-fallback-request") {
      if (!this.validMediaFallbackRequest(viewerId, message)) {
        return;
      }
      this.offerMediaFallbackToPeer(viewerId, state, message);
      return;
    }
    if (message.type === "segment-fallback-ready") {
      if (
        viewerId === "__sfu__" ||
        !state.sessionReady ||
        !/^[a-z0-9-]{8,64}$/i.test(message.requestId) ||
        !Number.isSafeInteger(message.transportEpoch) ||
        message.transportEpoch < 1 ||
        message.transportEpoch > 1_000_000_000
      ) {
        return;
      }
      this.activateMediaFallbackForPeer(viewerId, state, message);
      return;
    }
    if (message.type === "init-request") {
      if (!state.sessionReady) return;
      const now = Date.now();
      if (now - state.lastInitRequestAt < 750) return;
      state.lastInitRequestAt = now;
      const init = this.cache.getInit(this.mediaVersion);
      if (init) {
        state.sender.sendFragment(init, {
          priority: true,
          transportEpoch: state.transportEpoch,
        });
      }
      return;
    }
    if (message.type === "session-ready") {
      if (state.sessionReady) return;
      state.sessionReady = true;
      state.ready = false;
      if (state.mediaFallbackOffer) {
        this.sendMediaFallbackOffer(state);
      } else {
        this.primeMediaForPeer(state);
      }
      this.publishStatus();
      return;
    }
    if (message.type === "segment-fallback-release") {
      const wasActive = state.mediaFallbackActive;
      state.mediaFallbackOffer = undefined;
      state.mediaFallbackActive = false;
      if (wasActive) {
        state.sender.clearMediaQueue();
        this.bridge.reportDiagnostic(
          "emby-segment-media-fallback-released",
          {
            viewerId,
            mediaVersion: this.mediaVersion,
          },
        );
      }
      return;
    }
    if (!state.sessionReady) return;
    if (message.type === "catch-up") {
      if (viewerId === "__sfu__") {
        // The published SFU data track is shared by every subscriber. A
        // viewer-scoped catch-up would advance its single transport epoch and
        // force all healthy viewers to discard their buffers. SFU viewers
        // therefore switch only their own client to the P2P fallback instead.
        return;
      }
      if (
        !Number.isFinite(message.targetTime) ||
        message.targetTime < 0 ||
        message.targetTime > 30 * 24 * 60 * 60
      ) {
        return;
      }
      const now = Date.now();
      if (now - state.lastCatchUpAt < 1_800) return;
      state.lastCatchUpAt = now;
      state.recoveries += 1;
      this.primeMediaForPeer(state, message.targetTime, true);
      return;
    }
    if (message.type === "need") {
      if (!Array.isArray(message.missing)) return;
      const repairGeneration = Number(message.repairGeneration);
      if (
        message.repairGeneration !== undefined &&
        (
          !Number.isSafeInteger(repairGeneration) ||
          repairGeneration < 1 ||
          repairGeneration > 1_000_000
        )
      ) {
        return;
      }
      const acknowledgeRepair = (accepted: boolean): void => {
        if (message.repairGeneration === undefined) return;
        state.sender.sendControl({
          type: "repair-ack",
          sessionId: this.sessionId,
          mediaVersion: this.mediaVersion,
          transportEpoch: state.transportEpoch,
          fragmentSeq: Number(message.fragmentSeq),
          trackType: message.trackType,
          repairGeneration,
          accepted,
        });
      };
      if (
        !Number.isSafeInteger(message.fragmentSeq) ||
        message.fragmentSeq < 0 ||
        message.fragmentSeq > 10_000_000 ||
        (message.trackType !== "muxed" &&
          message.trackType !== "subtitle")
      ) {
        return;
      }
      const missing = [...new Set(message.missing
        .map(Number)
        .filter(
          (index) =>
            Number.isSafeInteger(index) && index >= 0 && index < 4_096,
        )
      )]
        .sort((left, right) => left - right)
        .slice(0, 64);
      if (!missing.length) return;
      const fragment =
        message.trackType === "muxed" && message.fragmentSeq === 0
          ? this.cache.getInit(this.mediaVersion)
          : this.cache.get(
              this.mediaVersion,
              message.fragmentSeq,
              message.trackType === "subtitle" ? "subtitle" : "muxed",
            );
      if (!fragment) {
        acknowledgeRepair(false);
        return;
      }
      const chunkCount = Math.max(
        1,
        Math.ceil(fragment.data.byteLength / EMBY_CHUNK_BYTES),
      );
      const availableMissing = missing.filter(
        (index) => index < chunkCount,
      );
      if (!availableMissing.length) {
        acknowledgeRepair(false);
        return;
      }
      const now = Date.now();
      const elapsed = Math.max(0, now - state.repairTokenUpdatedAt);
      state.repairTokens = Math.min(
        128,
        state.repairTokens + elapsed * 0.064,
      );
      state.repairTokenUpdatedAt = now;
      const repairKey =
        `${state.transportEpoch}:${message.trackType}:` +
        `${message.fragmentSeq}:${availableMissing.join(",")}`;
      for (const [key, requestedAt] of state.recentRepairRequests) {
        if (now - requestedAt > 1_000) {
          state.recentRepairRequests.delete(key);
        }
      }
      if (
        state.recentRepairRequests.has(repairKey)
      ) {
        acknowledgeRepair(true);
        return;
      }
      if (state.repairTokens < availableMissing.length) {
        acknowledgeRepair(false);
        return;
      }
      state.repairTokens -= availableMissing.length;
      state.recentRepairRequests.set(repairKey, now);
      while (state.recentRepairRequests.size > 64) {
        const oldest = state.recentRepairRequests.keys().next()
          .value as string | undefined;
        if (!oldest) break;
        state.recentRepairRequests.delete(oldest);
      }
      const accepted = state.sender.sendFragment(fragment, {
        priority: true,
        onlyChunks: availableMissing,
        transportEpoch: state.transportEpoch,
      });
      acknowledgeRepair(accepted);
      return;
    }
    if (message.type === "buffer-state") {
      if (
        !Number.isFinite(message.aheadSeconds) ||
        message.aheadSeconds < 0 ||
        message.aheadSeconds > 3_600
      ) {
        return;
      }
      state.bufferAhead = message.aheadSeconds;
      const now = Date.now();
      if (now - state.lastBufferStateAt >= 100) {
        state.lastBufferStateAt = now;
        this.publishStatus();
      }
      return;
    }
    if (message.type === "media-ready") {
      if (state.ready) return;
      state.ready = true;
      // media-ready means the viewer crossed its startup barrier. Seed the
      // same conservative floor before the following ordered buffer-state
      // envelope arrives, avoiding a 500 ms timer race that could mistake the
      // initial cache burst for a starving peer.
      state.bufferAhead = Math.max(
        state.bufferAhead,
        this.localPlayer.bufferProfile?.initialSeconds || 10,
      );
      state.slowSamples = 0;
      state.healthyRecoverySamples = 0;
      this.publishStatus();
      this.maybeStartSynchronizedPlayback();
    }
  }

  private maybeStartSynchronizedPlayback(force = false): void {
    if (!this.localReady || !this.active) return;
    if (this.desiredPausedAfterStart || this.userWantsPaused) {
      if (this.startBarrierTimer !== undefined) {
        window.clearTimeout(this.startBarrierTimer);
        this.startBarrierTimer = undefined;
      }
      this.options.video.pause();
      this.broadcastPlaybackState(true);
      return;
    }
    const waitingForViewer = [...this.peers.values()].some(
      (state) => state.sessionReady && !state.ready,
    );
    // The barrier belongs only to the first start of a broadcast. A viewer
    // joining an already-playing room, or a viewer rebuilding after a local
    // network problem, must never pause the host and every healthy viewer.
    if (!this.initialPlaybackStarted && waitingForViewer && !force) {
      this.options.video.pause();
      this.broadcastPlaybackState(true);
      if (this.startBarrierTimer === undefined) {
        this.startBarrierTimer = window.setTimeout(() => {
          this.startBarrierTimer = undefined;
          this.maybeStartSynchronizedPlayback(true);
        }, EMBY_START_BARRIER_MS);
      }
      return;
    }
    if (this.startBarrierTimer !== undefined) {
      window.clearTimeout(this.startBarrierTimer);
      this.startBarrierTimer = undefined;
    }
    const mediaVersion = this.mediaVersion;
    if (!this.options.video.paused) {
      this.initialPlaybackStarted = true;
      this.broadcastPlaybackState(true);
      return;
    }
    void this.options.video
      .play()
      .then(() => {
        if (
          this.destroyed ||
          this.stopping ||
          mediaVersion !== this.mediaVersion ||
          !this.active
        ) {
          return;
        }
        this.initialPlaybackStarted = true;
        this.broadcastPlaybackState(true);
      })
      .catch((error: unknown) => {
        if (mediaVersion !== this.mediaVersion) return;
        this.broadcastPlaybackState(true);
        const aborted =
          error instanceof DOMException && error.name === "AbortError";
        if (
          aborted &&
          this.localReady &&
          this.active &&
          this.mediaVersion > 1
        ) {
          // Replacing an MSE source aborts the stale play() promise. Once the
          // replacement is locally ready this is not a failed first start;
          // consume the one-shot room barrier so a late viewer cannot hold
          // every healthy participant paused forever.
          this.initialPlaybackStarted = true;
          if (this.startBarrierTimer !== undefined) {
            window.clearTimeout(this.startBarrierTimer);
            this.startBarrierTimer = undefined;
          }
        }
        if (
          this.destroyed ||
          this.stopping ||
          aborted
        ) {
          return;
        }
        const reason =
          error instanceof Error && error.message
            ? `：${error.message}`
            : "";
        this.handleLocalPlaybackFailure(
          `本地播放器无法开始解码${reason}，正在切换兼容 H.264 播放线路`,
        );
      });
  }

  private recoverSlowPeers(): void {
    if (!this.active || !this.localReady) return;
    const now = Date.now();
    for (const [viewerId, state] of this.peers) {
      const droppedSinceLastSample =
        state.stats.droppedFragments > state.observedDroppedFragments;
      state.observedDroppedFragments = state.stats.droppedFragments;
      if (!state.sessionReady || !state.ready) {
        state.slowSamples = 0;
        state.healthyRecoverySamples = 0;
        continue;
      }
      const backlogDelayed =
        state.bufferAhead < 4 &&
        state.stats.totalQueuedDurationMs >= 1_800;
      const delayed = droppedSinceLastSample || backlogDelayed;
      const recoveryCooldownMs =
        state.recoveryCooldownMs ||
        EMBY_SLOW_PEER_MIN_RECOVERY_COOLDOWN_MS;
      state.slowSamples = delayed
        ? Math.min(12, state.slowSamples + 1)
        : Math.max(0, state.slowSamples - 1);
      if (delayed) {
        state.healthyRecoverySamples = 0;
      } else if (
        state.bufferAhead >= 6 &&
        state.stats.totalQueuedDurationMs < 1_200
      ) {
        state.healthyRecoverySamples =
          (state.healthyRecoverySamples || 0) + 1;
        if (
          state.healthyRecoverySamples >=
          EMBY_SLOW_PEER_HEALTHY_RESET_SAMPLES
        ) {
          state.recoveryCooldownMs =
            EMBY_SLOW_PEER_MIN_RECOVERY_COOLDOWN_MS;
          state.healthyRecoverySamples = 0;
        }
      } else {
        state.healthyRecoverySamples = 0;
      }
      if (
        state.slowSamples < 4 ||
        now - state.lastCatchUpAt < recoveryCooldownMs
      ) {
        continue;
      }
      state.lastCatchUpAt = now;
      state.recoveryCooldownMs = Math.min(
        EMBY_SLOW_PEER_MAX_RECOVERY_COOLDOWN_MS,
        recoveryCooldownMs * 2,
      );
      state.slowSamples = 0;
      state.recoveries += 1;
      this.primeMediaForPeer(
        state,
        Math.max(0, this.options.video.currentTime || 0),
        true,
      );
      if (
        state.recoveries >= 1 &&
        now - state.lastPressureReportAt >= 8_000
      ) {
        state.lastPressureReportAt = now;
        this.options.onNetworkPressure?.({
          viewerId,
          queuedBytes: state.stats.queuedBytes,
          bufferedBytes: state.stats.bufferedBytes,
        });
      }
    }
  }

  private publishStatus(): void {
    let queuedBytes = 0;
    let bufferedBytes = 0;
    let droppedFragments = 0;
    let readyViewers = 0;
    for (const state of this.peers.values()) {
      queuedBytes += state.stats.queuedBytes;
      bufferedBytes += state.stats.bufferedBytes;
      droppedFragments += state.stats.droppedFragments;
      if (state.ready) readyViewers += 1;
    }
    this.options.onStatus({
      viewers: this.peers.size,
      readyViewers,
      queuedBytes,
      bufferedBytes,
      droppedFragments,
      localBufferedSeconds: this.localPlayer.bufferedAhead,
    });
  }

  private startTimers(): void {
    this.stopTimers();
    this.playbackTimer = window.setInterval(
      () => this.broadcastPlaybackState(false),
      500,
    );
    this.progressTimer = window.setInterval(
      () => void this.reportPlayback("progress", "TimeUpdate"),
      10_000,
    );
    this.statusTimer = window.setInterval(() => {
      this.syncFlowControl();
      this.recoverSlowPeers();
      this.monitorEstablishedPlayback();
      this.publishStatus();
    }, 500);
  }

  private monitorEstablishedPlayback(): void {
    if (
      !this.active ||
      !this.localReady ||
      this.stopping ||
      this.restarting ||
      this.userWantsPaused ||
      this.streamHasEnded
    ) {
      return;
    }
    const now = Date.now();
    const currentTime = Math.max(
      0,
      Number(this.options.video.currentTime) || 0,
    );
    if (this.flowPaused || this.startBarrierTimer !== undefined) {
      this.lastFragmentAt = now;
      this.lastLocalPlaybackProgressAt = now;
      this.lastLocalPlaybackTime = currentTime;
      return;
    }
    if (Math.abs(currentTime - this.lastLocalPlaybackTime) >= 0.04) {
      this.lastLocalPlaybackTime = currentTime;
      this.lastLocalPlaybackProgressAt = now;
    }
    const durationSeconds = Math.max(
      0,
      Number(this.plan?.runtimeTicks || 0) / 10_000_000,
    );
    if (durationSeconds > 0 && durationSeconds - currentTime <= 2.5) return;
    const bufferedAhead = this.localPlayer.bufferedAhead;
    if (
      this.lastFragmentAt > 0 &&
      now - this.lastFragmentAt >= 12_000 &&
      bufferedAhead < 3
    ) {
      this.handleLocalPlaybackFailure(
        "Emby 编码进程长时间未输出媒体数据，正在从当前进度自动重建",
      );
      return;
    }
    if (
      bufferedAhead >= 1 &&
      now - this.lastLocalPlaybackProgressAt >= 12_000
    ) {
      this.handleLocalPlaybackFailure(
        "本地播放器有缓存但画面长时间未推进，正在自动重建解码链",
      );
    }
  }

  private stopTimers(): void {
    if (this.playbackTimer !== undefined) {
      window.clearInterval(this.playbackTimer);
    }
    if (this.progressTimer !== undefined) {
      window.clearInterval(this.progressTimer);
    }
    if (this.statusTimer !== undefined) window.clearInterval(this.statusTimer);
    if (this.startBarrierTimer !== undefined) {
      window.clearTimeout(this.startBarrierTimer);
    }
    this.clearLocalReadyTimer();
    this.playbackTimer = undefined;
    this.progressTimer = undefined;
    this.statusTimer = undefined;
    this.startBarrierTimer = undefined;
  }

  private cancelScheduledSeek(): void {
    this.seekRevision += 1;
    this.pendingSeekSeconds = undefined;
    if (this.seekTimer !== undefined) {
      window.clearTimeout(this.seekTimer);
      this.seekTimer = undefined;
    }
  }

  private cancelQueuedRestarts(): void {
    this.restartRevision += 1;
    const pending = this.pendingRestart;
    this.pendingRestart = undefined;
    if (pending) {
      for (const resolve of pending.waiters.splice(0)) resolve();
    }
    if (this.runningRestart) {
      for (const resolve of this.runningRestart.waiters.splice(0)) resolve();
    }
  }

  private async reportPlayback(
    action: "start" | "progress" | "stop",
    eventName: string,
  ): Promise<void> {
    if (!this.plan) return;
    if (this.playbackReportsInFlight.has(action)) return;
    this.playbackReportsInFlight.add(action);
    try {
      await withEmbyIpcTimeout(
        this.bridge.embyReportPlayback({
          action,
          positionTicks: Math.round(
            Math.max(0, this.options.video.currentTime || 0) * 10_000_000,
          ),
          isPaused: this.options.video.paused,
          eventName,
        }),
        EMBY_PLAYBACK_REPORT_TIMEOUT_MS,
        `playback-report-${action}`,
      );
    } catch (error) {
      this.bridge.reportDiagnostic("emby-playback-report-failed", {
        action,
        eventName,
        pipelineId: this.pipelineId || this.expectedPipelineId || undefined,
        timeoutMs: EMBY_PLAYBACK_REPORT_TIMEOUT_MS,
        timedOut: error instanceof EmbyIpcTimeoutError,
        message:
          error instanceof Error
            ? error.message.slice(0, 300)
            : String(error).slice(0, 300),
      });
    } finally {
      this.playbackReportsInFlight.delete(action);
    }
  }

  private async settleIpcOperation(
    operation: Promise<unknown>,
    timeoutMs: number,
    label: string,
    pipelineId: string,
  ): Promise<boolean> {
    try {
      await withEmbyIpcTimeout(operation, timeoutMs, label);
      return true;
    } catch (error) {
      this.bridge.reportDiagnostic("emby-ipc-operation-failed", {
        operation: label,
        pipelineId: pipelineId || undefined,
        timeoutMs,
        timedOut: error instanceof EmbyIpcTimeoutError,
        message:
          error instanceof Error
            ? error.message.slice(0, 300)
            : String(error).slice(0, 300),
      });
      return false;
    }
  }

  private async stopPipelineOnly(reason: string): Promise<void> {
    const pipelineIdentity =
      this.pipelineId || this.expectedPipelineId;
    const hadPipeline = Boolean(
      pipelineIdentity ||
        this.pendingStart ||
        this.inFlightPipelineStarts > 0,
    );
    this.rejectPending(new Error("Emby 启动请求已取消"));
    this.flowPauseReasons.clear();
    this.flowPaused = false;
    this.clearFlowControlRetry();
    // Invalidate the old event identity before either IPC await. Otherwise a
    // late init/fragment delivered while the main process is stopping could
    // configure the cancelled pipeline after its pending start was rejected.
    this.pipelineId = "";
    this.expectedPipelineId = "";
    this.suppressHostSeek = false;
    this.flowControlGeneration += 1;
    this.flowControlOperation = undefined;
    // Stop is never coupled to the flow-control actor. The command is
    // idempotent and intentionally fire-and-forget; stopStream terminates the
    // pipeline even if this IPC request is delayed by a suspended renderer.
    void Promise.resolve()
      .then(() =>
        this.bridge.embySetFlowPaused(
          false,
          pipelineIdentity || undefined,
          this.flowControlGeneration,
        ),
      )
      .catch(() => undefined);
    this.appliedFlowPaused = undefined;
    if (hadPipeline) {
      await this.settleIpcOperation(
        Promise.resolve().then(() =>
          this.bridge.embyStopStream(
            reason,
            pipelineIdentity || undefined,
          ),
        ),
        EMBY_PIPELINE_STOP_TIMEOUT_MS,
        "pipeline-stop",
        pipelineIdentity,
      );
    }
  }

  private syncFlowControl(
    aheadSeconds = this.localPlayer.bufferedAhead,
  ): void {
    const ahead = Math.max(0, Number(aheadSeconds) || 0);
    const queuedBytes = this.localPlayer.queuedAppendBytes;
    const bufferProfile = this.localPlayer.bufferProfile || {
      initialSeconds: 10,
      targetSeconds: 64,
      maxSeconds: 90,
      memoryBudgetBytes: 320 * 1024 * 1024,
    };
    const bufferHighWater = Math.max(
      bufferProfile.targetSeconds + 4,
      bufferProfile.maxSeconds - 4,
    );
    const bufferLowWater = Math.max(
      bufferProfile.initialSeconds + 4,
      Math.min(
        bufferProfile.targetSeconds,
        bufferHighWater - 8,
      ),
    );
    if (ahead >= bufferHighWater) {
      this.flowPauseReasons.add("buffer");
    } else if (ahead <= bufferLowWater) {
      this.flowPauseReasons.delete("buffer");
    }
    if (queuedBytes >= EMBY_APPEND_QUEUE_HIGH_WATER) {
      this.flowPauseReasons.add("append-queue");
    } else if (queuedBytes <= EMBY_APPEND_QUEUE_LOW_WATER) {
      this.flowPauseReasons.delete("append-queue");
    }
    const paused = this.flowPauseReasons.size > 0;
    if (paused !== this.flowPaused) {
      this.flowPaused = paused;
      this.flowControlGeneration += 1;
      this.clearFlowControlRetry();
    }
    this.flushFlowControl();
  }

  private clearFlowControlRetry(): void {
    if (this.flowControlRetryTimer !== undefined) {
      window.clearTimeout(this.flowControlRetryTimer);
      this.flowControlRetryTimer = undefined;
    }
  }

  private flushFlowControl(): void {
    if (
      this.destroyed ||
      this.flowControlOperation ||
      this.flowControlRetryTimer !== undefined ||
      this.appliedFlowPaused === this.flowPaused
    ) {
      return;
    }
    const requested = this.flowPaused;
    const generation = this.flowControlGeneration;
    const pipelineId = this.pipelineId || this.expectedPipelineId || "";
    let applied = false;
    const operation = Promise.resolve()
      .then(() =>
        withEmbyIpcTimeout(
          this.bridge.embySetFlowPaused(
            requested,
            pipelineId || undefined,
            generation,
          ),
          EMBY_FLOW_CONTROL_COMMAND_TIMEOUT_MS,
          "flow-control-command",
        ),
      )
      .then((ack) => {
        if (generation !== this.flowControlGeneration) return;
        const actualPaused =
          ack && typeof ack.actualPaused === "boolean"
            ? ack.actualPaused
            : requested;
        const matchingAck =
          !ack ||
          ((ack.generation === generation || ack.generation === undefined) &&
            (!pipelineId || !ack.pipelineId || ack.pipelineId === pipelineId));
        applied = matchingAck && actualPaused === requested;
        this.appliedFlowPaused = matchingAck
          ? actualPaused
          : undefined;
      })
      .catch(async (error) => {
        if (generation !== this.flowControlGeneration) return;
        this.appliedFlowPaused = undefined;
        const getFlowState = this.bridge.embyGetFlowState;
        if (typeof getFlowState === "function") {
          try {
            const state = await withEmbyIpcTimeout(
              getFlowState(pipelineId || undefined),
              EMBY_FLOW_CONTROL_STATE_TIMEOUT_MS,
              "flow-control-state",
            );
            if (generation !== this.flowControlGeneration) return;
            if (
              (!pipelineId || !state.pipelineId || state.pipelineId === pipelineId) &&
              state.active
            ) {
              this.appliedFlowPaused = state.actualPaused;
              applied = state.actualPaused === requested;
            }
          } catch {
            // A bounded retry below remains the final recovery path.
          }
        }
        this.bridge.reportDiagnostic("emby-flow-control-retry", {
          pipelineId: pipelineId || undefined,
          generation,
          requested,
          actual: this.appliedFlowPaused,
          timedOut: error instanceof EmbyIpcTimeoutError,
        });
        if (this.destroyed || this.flowControlRetryTimer !== undefined) return;
        this.flowControlRetryTimer = window.setTimeout(() => {
          this.flowControlRetryTimer = undefined;
          this.flushFlowControl();
        }, 750);
      })
      .finally(() => {
        if (this.flowControlOperation === operation) {
          this.flowControlOperation = undefined;
        }
        if (this.destroyed) return;
        if (
          generation !== this.flowControlGeneration ||
          !applied ||
          this.appliedFlowPaused !== this.flowPaused
        ) {
          this.flushFlowControl();
        }
      });
    this.flowControlOperation = operation;
  }

  private resolvePending(detail: {
    plan: EmbyStreamPlan;
    mimeType: string;
    title: string;
  }): void {
    const pending = this.pendingStart;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.pendingStart = undefined;
    pending.resolve(detail);
  }

  private armPendingStartTimeout(pending: PendingStart): void {
    window.clearTimeout(pending.timer);
    pending.timer = window.setTimeout(() => {
      if (this.pendingStart === pending) {
        this.rejectPending(
          new EmbyStartupCompatibilityError(
            "Emby 媒体流初始化超时",
          ),
          pending,
        );
      }
    }, 30_000);
  }

  private rejectPending(error: unknown, expected?: PendingStart): void {
    const pending = this.pendingStart;
    if (!pending || (expected && pending !== expected)) return;
    window.clearTimeout(pending.timer);
    this.pendingStart = undefined;
    pending.reject(
      error instanceof Error ? error : new Error(String(error || "Emby 启动失败")),
    );
  }
}

export { EMBY_CONTROL_CHANNEL_LABEL, EMBY_DATA_CHANNEL_LABEL };
