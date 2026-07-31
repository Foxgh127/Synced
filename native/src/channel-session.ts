import { App } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import {
  AdaptivePlaybackController,
  type AdaptivePressure,
  type ScreenContentMode,
} from "./adaptive-playback";
import {
  captureWindowGeometryChanged,
  normalizeCaptureWindowGeometry,
  physicalCaptureTarget,
  safeVideoEncodingTarget,
  type CaptureWindowGeometry,
} from "./capture-resolution";
import { CaptureVideoHealthController } from "./capture-health";
import { rememberChannel, saveNickname } from "./channel-store";
import {
  FRAME_RATE_OPTIONS,
  RESOLUTION_OPTIONS,
  buildJoinLink,
  buildQualityPreset,
  formatBitrate,
  isFrameRateOption,
  isResolutionKey,
  recommendBroadcastPreset,
  type FrameRateOption,
  type QualityPreset,
  type ResolutionKey,
} from "./config";
import { DanmakuOverlay } from "./danmaku-overlay";
import {
  shouldEnableDesktopDanmaku,
  shouldRenderStageDanmaku,
} from "./danmaku-mode";
import { IDLE_HIDE_MS } from "./design/motion";
import {
  EMBY_CONTROL_CHANNEL_LABEL,
  EMBY_DATA_CHANNEL_LABEL,
  EmbyBroadcastController,
} from "./emby-broadcast";
import { EmbyMsePlayer } from "./emby-player";
import { EmbyAbrSegmentClient } from "./emby-segment-relay";
import {
  composeEmbyEndpoint,
  endpointDefaultPort,
  parseEmbyEndpointInput,
  type EmbyEndpointDraft,
  type EmbyEndpointProtocol,
} from "./emby-endpoint";
import { detectEmbyMediaCapabilities } from "./emby-transport";
import {
  VideoEnhancementController,
  type VideoEnhancementPreference,
  type VideoEnhancementState,
} from "./video-enhancement";
import {
  bindEmbeddedGameRail,
  embeddedGameRailButtonMarkup,
  hideEmbeddedGame,
} from "./embedded-game";
import {
  enterImmersivePlayer,
  exitImmersivePlayer,
  isNativeAndroid,
} from "./immersive";
import { ProcessAudioCapture } from "./process-audio";
import { ResourceBudgetMonitor } from "./resource-monitor";
import {
  ChannelMusicController,
  channelMusicRailButtonMarkup,
} from "./channel-music";
import {
  getNativeLocalAddresses,
  listenForNativeNetworkChanges,
  reportNativePlaybackDiagnostic,
} from "./native-network";
import {
  ensureNetworkProbe,
  probeIceCandidateGatherability,
} from "./network-probe";
import {
  fallbackNetworkAdvice,
  formatNetworkRate,
  networkConfidenceLabel,
  networkRouteLabel,
  sanitizeNetworkAdvice,
  selectResolutionAndFrameRate,
  type NetworkAdvice,
  type NetworkReport,
} from "./network-quality";
import { copyText } from "./platform-clipboard";
import {
  getPlaybackControlState,
  setNativePlaybackActive,
  setPlaybackBrightness,
  type PlaybackControlState,
} from "./playback-controls";
import {
  embyPauseStateChanged,
  embyPresentationProgressed,
  playbackRecoveryCompleted,
  playbackRecoveryAction,
  shouldPreserveActiveWatcher,
  shouldRestartIceForPlaybackRepair,
  shouldReplaceWatcherForRouteAdvice,
} from "./playback-continuity";
import { RoomCompanion, roomSidebarMarkup } from "./room-companion";
import { AmbientLightController } from "./ui/ambient-light";
import { dialogController } from "./ui/dialog-controller";
import {
  closeTopmostFloatingSurface,
  FloatingSurface,
} from "./ui/floating-surface";
import { hydrateIcons } from "./ui/icons";
import { animateElement } from "./ui/motion-controller";
import { PresenceController } from "./ui/presence-controller";
import { VirtualGrid } from "./ui/virtual-grid";
import {
  isVerifiedEmergencyTrackSettings,
  SfuSession,
  sanitizeSfuAccess,
  type SfuAccess,
  type SfuScreenReceiverStats,
} from "./sfu";
import {
  calculateCenteredSmartCrop,
  exactSourceLabel,
  measureEmbeddedHorizontalBars,
  stableEmbeddedHorizontalBars,
  type EmbeddedHorizontalBars,
} from "./video-presentation";
import {
  RoomStateRevisionGate,
  SignalMessageScheduler,
} from "./signal-message-scheduler";
import {
  SignalClient,
  applyReceiverPreference,
  configureMovieJitterBuffer,
  createPeerConnection,
  deferFailedVideoCodecs,
  exposeLocalIceDescription,
  inboundDecodeFailureCodec,
  isUsableIceCandidate,
  matchingVideoCodecFailure,
  normalizeVideoCodecMime,
  preferVideoCodecs,
  readDataChannelStats,
  readIceConnectivityDiagnostics,
  readInboundAudioStats,
  readInboundVideoStats,
  readOutboundVideoStats,
  selectPeerIceServers,
  stripUnsafeIceCandidates,
  tuneMovieSdp,
  tuneSenders,
  videoTiasBitrate,
  VideoBitrateRampController,
  type BroadcastCapabilities,
  type DataChannelSnapshot,
  type IceConnectivityDiagnostics,
  type InboundAudioSnapshot,
  type InboundSnapshot,
  type OutboundSnapshot,
  type RoomParticipant,
  type SegmentRelayAccess,
  type SignalEnvelope,
} from "./rtc";

export interface ChannelSessionOptions {
  root: HTMLDivElement;
  desktop: boolean;
  room: string;
  signalUrl: string;
  nickname: string;
  channelName?: string;
  createIfMissing: boolean;
  ownerToken?: string;
  notify: (
    message: string,
    type?: boolean | "info" | "warn" | "danger",
  ) => void;
  onLeave: () => void | Promise<void>;
  showInviteOnStart?: boolean;
  operationSignal?: AbortSignal;
}

interface OutboundPeer {
  pc: RTCPeerConnection;
  candidates: RTCIceCandidateInit[];
  snapshot?: OutboundSnapshot;
  bitrateRamp?: VideoBitrateRampController;
  codecAttempt?: number;
  sessionId?: string;
  mediaReady?: boolean;
  negotiatedVideoCodec?: string;
  mode: "screen" | "emby";
  degradationPreference: RTCDegradationPreference;
  cpuLimitedSamples: number;
  cpuStableSamples: number;
  statsFailureSamples: number;
  statsConfidence: "high" | "reduced" | "missing";
  fallbackBitrateCeiling?: number;
  fallbackHeightCeiling?: number;
  iceRestartInFlight?: boolean;
}

interface PendingWatcherSignal {
  data: RTCSessionDescriptionInit | RTCIceCandidateInit;
  attempt?: number;
  sessionId?: string;
}

type EmbyFrameRate = NonNullable<EmbyPlaybackRequest["frameRate"]>;
const MAX_WATCH_RECOVERY_CYCLES = 10;
const SFU_SCREEN_SILENCE_TIMEOUT_MS = 12_000;
const SFU_PRIMARY_RECOVERY_DELAYS_MS = [
  15_000,
  30_000,
  60_000,
  120_000,
  240_000,
] as const;
const MAX_PENDING_MEDIA_ICE_CANDIDATES = 64;
const MAX_PENDING_WATCHER_SIGNALS = 96;
const RTC_NEGOTIATION_TIMEOUT_MS = 8_000;
const RTC_CANDIDATE_TIMEOUT_MS = 2_000;
const RTC_STATS_TIMEOUT_MS = 2_500;
const RTC_TRACK_REPLACE_TIMEOUT_MS = 5_000;
const MAX_SCREEN_P2P_FALLBACK_VIEWERS = 2;
const SCREEN_P2P_FALLBACK_BUDGETS = Object.freeze([
  { height: 1_080, bitrate: 8_000_000 },
  { height: 720, bitrate: 4_000_000 },
] as const);

function queuePendingMediaCandidate(
  candidates: RTCIceCandidateInit[],
  candidate: RTCIceCandidateInit,
): boolean {
  if (candidates.length >= MAX_PENDING_MEDIA_ICE_CANDIDATES) return false;
  candidates.push(candidate);
  return true;
}

function queuePendingWatcherSignal(
  queue: PendingWatcherSignal[],
  pending: PendingWatcherSignal,
): boolean {
  if (queue.length < MAX_PENDING_WATCHER_SIGNALS) {
    queue.push(pending);
    return true;
  }
  if (!("type" in pending.data) || !pending.data.type) return false;
  const candidateIndex = queue.findIndex(
    (entry) => !("type" in entry.data) || !entry.data.type,
  );
  if (candidateIndex >= 0) {
    queue.splice(candidateIndex, 1);
  } else {
    queue.shift();
  }
  queue.push(pending);
  return true;
}

function normalizeEmbyFrameRate(value: unknown): EmbyFrameRate {
  const frameRate = Number(value);
  return frameRate === 24 || frameRate === 60 ? frameRate : 30;
}

function sanitizeSegmentRelayAccess(
  value: SegmentRelayAccess | undefined,
): SegmentRelayAccess | undefined {
  if (
    !value ||
    typeof value.basePath !== "string" ||
    !/^\/media\/v\d+(?:\/)?$/u.test(value.basePath) ||
    typeof value.token !== "string" ||
    value.token.length < 64 ||
    value.token.length > 2_048 ||
    !["read", "publish"].includes(value.scope) ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= Date.now()
  ) {
    return undefined;
  }
  return {
    basePath: value.basePath.replace(/\/+$/u, ""),
    token: value.token,
    scope: value.scope,
    expiresAt: value.expiresAt,
  };
}

function embyQualityForRequestedHeight(
  height: number | undefined,
): EmbyPlaybackRequest["quality"] | undefined {
  if (!Number.isFinite(height) || !height || height <= 0) return undefined;
  if (height >= 2_160) return "4k-18";
  if (height >= 1_440) return "1440p-18";
  if (height >= 1_080) return "1080p-12";
  if (height >= 720) return "720p-6";
  if (height >= 480) return "480p-2.5";
  return "360p-1.2";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readableError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message
      .replace(
        /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i,
        "",
      )
      .replace(/^Error:\s*/i, "")
      .trim() || fallback
  );
}

function safeEmbyEndpointDraft(value = ""): EmbyEndpointDraft {
  try {
    return parseEmbyEndpointInput(value);
  } catch {
    return parseEmbyEndpointInput("");
  }
}

function embyEndpointRowMarkup(
  draft: EmbyEndpointDraft,
  primary = false,
): string {
  return `
    <div class="emby-endpoint-row" data-emby-endpoint-row>
      <span class="emby-endpoint-order">${primary ? "主" : "备"}</span>
      <label class="emby-endpoint-protocol"><span>协议</span>
        <select data-emby-endpoint-protocol aria-label="${primary ? "主线路" : "备用线路"}协议">
          <option value="https" ${draft.protocol === "https" ? "selected" : ""}>HTTPS</option>
          <option value="http" ${draft.protocol === "http" ? "selected" : ""}>HTTP</option>
        </select>
      </label>
      <label class="emby-endpoint-host"><span>地址（可直接粘贴完整 URL）</span>
        <input data-emby-endpoint-host type="text" autocomplete="url" value="${escapeHtml(draft.host)}" placeholder="nas.example.com 或 https://nas.example.com:8920/emby" />
      </label>
      <label class="emby-endpoint-port"><span>端口</span>
        <input data-emby-endpoint-port type="number" inputmode="numeric" min="1" max="65535" value="${escapeHtml(draft.port)}" />
      </label>
      <label class="emby-endpoint-path"><span>路径</span>
        <input data-emby-endpoint-path type="text" value="${escapeHtml(draft.path)}" placeholder="/emby（可选）" />
      </label>
      <button data-remove-emby-endpoint class="emby-endpoint-remove" type="button"
              aria-label="删除此备用线路" ${primary ? "hidden" : ""}>
        <i data-lucide="x"></i>
      </button>
    </div>
  `;
}

function embyEndpointEditorMarkup(context: "login" | "manage", initial = ""): string {
  return `
    <section class="emby-endpoint-editor" data-emby-endpoint-editor="${context}">
      <header>
        <div><strong>服务器线路</strong><span>每台服务器一组，可配置最多 8 条备用入口</span></div>
        <button type="button" data-add-emby-endpoint class="ghost-button emby-endpoint-add">
          <i data-lucide="plus"></i>添加备用线路
        </button>
      </header>
      <div class="emby-endpoint-list" data-emby-endpoint-list>
        ${embyEndpointRowMarkup(safeEmbyEndpointDraft(initial), true)}
      </div>
      <p class="emby-endpoint-feedback" data-emby-endpoint-feedback aria-live="polite"></p>
    </section>
  `;
}

export async function openChannelSession(
  options: ChannelSessionOptions,
): Promise<void> {
  options.operationSignal?.throwIfAborted();
  const {
    root,
    desktop,
    room,
    signalUrl,
    createIfMissing,
    ownerToken,
    notify,
  } = options;
  let nickname = options.nickname;
  let channelName = options.channelName || "朋友的频道";
  let selfId = "";
  let broadcasterId: string | undefined;
  let broadcasterNickname = "";
  let broadcastCapabilities: BroadcastCapabilities | undefined;
  let iceServers: RTCIceServer[] = [];
  let signal: SignalClient | undefined;
  let companion: RoomCompanion | undefined;
  let musicController: ChannelMusicController | undefined;
  let leaving = false;
  let joined = false;
  let awaitingBroadcastGrant = false;
  let preparingBroadcast = false;
  const signalMessageScheduler = new SignalMessageScheduler<SignalEnvelope>({
    handle: (message, operationSignal) =>
      handleMessage(message, operationSignal),
    timeoutMs: (message) =>
      message.type === "channel:joined"
        ? 30_000
        : message.type === "signal" ||
            message.type === "media:ice-restart"
          ? 12_000
          : 20_000,
    onError: (error, message) => {
      window.roomDesktop?.reportDiagnostic("signal-handler-failed", {
        type: message.type,
        attempt: message.attempt,
        sessionId: message.sessionId,
        message: error instanceof Error ? error.message : String(error),
        stack:
          error instanceof Error
            ? error.stack?.split("\n").slice(0, 5).join("\n")
            : undefined,
      });
      setStatus("媒体协商失败", "error");
      notify(error instanceof Error ? error.message : "媒体协商失败", true);
    },
  });
  let backButtonHandle: PluginListenerHandle | undefined;
  let networkChangeHandle: PluginListenerHandle | undefined;
  let fullscreenChangeHandler: (() => void) | undefined;
  let removeMainWindowRestoredListener: (() => void) | undefined;
  let pictureInPictureOwnsWindowMinimize = false;
  const miniWindowPreferenceKey = "synced:mini-window-enabled";
  let miniWindowEnabled =
    localStorage.getItem(miniWindowPreferenceKey) === "true";
  let signalReconnectTimer: number | undefined;
  let channelJoinAckTimer: number | undefined;
  let signalReconnectAttempt = 0;
  let signalReconnectInFlight = false;
  let signalUnavailable = false;
  let networkChangeDebounceTimer: number | undefined;
  let desktopNetworkTimer: number | undefined;
  let desktopNetworkSignature = "";
  let hasJoinedOnce = false;
  let broadcastPreparationEpoch = 0;
  let resumeBroadcastAfterReconnect = false;
  let resumeVoiceAfterReconnect = false;
  let forceMediaRenegotiationAfterReconnect = false;
  let signalFeatures = new Set<string>();
  let networkProbeVersions: ReadonlyArray<number> = [1];
  let sfuAccess: SfuAccess | undefined;
  let segmentRelayAccess: SegmentRelayAccess | undefined;
  let segmentRelayRefreshTimer: number | undefined;
  let lastSegmentRelayRefreshRequestAt = 0;
  let sfuViewerActive = false;
  let sfuFailedBroadcastKey = "";
  let sfuWatchPromise: Promise<boolean> | undefined;
  let sfuWatchKey = "";
  let sfuWatchEpoch = 0;
  let sfuPrimaryRecoveryTimer: number | undefined;
  let sfuPrimaryRecoveryAttempts = 0;
  let sfuPrimaryRecoveryInFlight = false;
  let sfuPrimaryRecoveryExhaustedReported = false;
  let sfuPublishPromise: Promise<boolean> | undefined;
  let sfuPublishedKey = "";
  let reportedSfuPublisherActive: boolean | undefined;
  let reportedSfuViewerActive: boolean | undefined;
  const SFU_EMBY_VIEWER_ID = "__sfu__";

  const participants = new Map<string, RoomParticipant>();
  const roomStateRevisionGate = new RoomStateRevisionGate();
  const outboundPeers = new Map<string, OutboundPeer>();
  const failedVideoCodecsByViewer = new Map<string, Set<string>>();
  const receiverPreferences = new Map<
    string,
    {
      height?: number;
      frameRate?: number;
      originalDemand?: boolean;
      highDemand?: boolean;
      lowDemand?: boolean;
      availableDownloadBps?: number;
      renditionPolicy?: {
        maxActiveRenditions?: number;
        allowOriginal?: boolean;
        serverVerified?: boolean;
      };
    }
  >();
  let watcherPc: RTCPeerConnection | undefined;
  let retainedWatcherPc: RTCPeerConnection | undefined;
  let sfuStabilityTimer: number | undefined;
  let watcherRelayOnly = false;
  let watcherCandidates: RTCIceCandidateInit[] = [];
  let pendingWatcherSignals: PendingWatcherSignal[] = [];
  let remoteStream = new MediaStream();
  let retainedRemoteStream: MediaStream | undefined;
  let watchRetryTimer: number | undefined;
  let watchCycleRetryTimer: number | undefined;
  let disconnectGraceTimer: number | undefined;
  let disconnectReplaceTimer: number | undefined;
  let videoFrameCallbackId: number | undefined;
  let viewerStatsTimer: number | undefined;
  let viewerStatsPollRunning = false;
  let viewerStatsEpoch = 0;
  let viewerStatsOutstanding = 0;
  let inboundSnapshot: InboundSnapshot | undefined;
  let inboundAudioSnapshot: InboundAudioSnapshot | undefined;
  let p2pScreenFrameSnapshot:
    | { frames: number; currentTime: number }
    | undefined;
  let sfuScreenFrameSnapshot:
    | { frames: number; currentTime: number }
    | undefined;
  let sfuScreenReceiverSnapshot: SfuScreenReceiverStats | undefined;
  let viewerStatsFailures = 0;
  let viewerAudioStalledSamples = 0;
  let viewerAudioEverReceived = false;
  let embyDataSnapshot: DataChannelSnapshot | undefined;
  let embyFrameSnapshot:
    | { frames: number; dropped: number; timestamp: number }
    | undefined;
  let embyLivenessFrameSnapshot:
    | { frames: number; currentTime: number }
    | undefined;
  let embyBufferedAhead = 0;
  let embyStartupBufferProgressAt = 0;
  let embyStartupLastBufferAhead = 0;
  let embyHostPaused = false;
  let embyHostPauseStateKnown = false;
  let viewerTransportProgressAt = 0;
  let viewerPresentationProgressAt = 0;
  let viewerRecoveryStartedAt = 0;
  let firstFrameRepairStartedAt = 0;
  let embyLastPlaybackTime = 0;
  let lastPlaybackDiagnosticAt = 0;
  let viewerBandwidthWarningShown = false;
  let watchAttempts = 0;
  let watchRecoveryCycles = 0;
  let watchInFlight = false;
  let watchSessionId = "";
  let remoteFirstFrame = false;
  let autoSoundRetryTimer: number | undefined;
  let viewerAudioTrackTimer: number | undefined;
  let viewerAudioMissing = false;
  let lastIceDiagnostics: IceConnectivityDiagnostics | undefined;
  let oneWayPathObserved = false;
  let virtualCandidateObserved = false;
  let localDirectAddresses: string[] = [];
  const adaptivePlayback = new AdaptivePlaybackController();
  // Both native wrappers explicitly permit autoplay. The manual sound button
  // is retained only as a browser fallback.
  const nativeAndroid = isNativeAndroid();
  document.body.classList.toggle("native-android", nativeAndroid);
  const nativeAutoplay = desktop || nativeAndroid;
  const savedMovieVolumeValue =
    localStorage.getItem("synced:movie-volume");
  const savedMovieVolume = Number(savedMovieVolumeValue ?? "1");
  const savedMovieMuteWasExplicit =
    localStorage.getItem("synced:movie-muted-explicit") === "true";
  let movieVolume = Number.isFinite(savedMovieVolume)
    ? Math.max(
        0,
        Math.min(
          1,
          savedMovieVolume <= 0 && !savedMovieMuteWasExplicit
            ? 1
            : savedMovieVolume,
        ),
      )
    : 1;
  let lastAudibleMovieVolume = movieVolume > 0 ? movieVolume : 1;
  let soundEnabled = nativeAutoplay && movieVolume > 0;
  let nativeMovieAudioNeedsGesture = false;
  let lastNativeMovieAudioRestartAt = 0;
  let nativePlaybackActive = false;

  function reportPlaybackDiagnostic(
    event: string,
    detail: Record<string, unknown>,
  ): void {
    window.roomDesktop?.reportDiagnostic(event, detail);
    if (nativeAndroid) {
      reportNativePlaybackDiagnostic(event, detail);
    }
  }

  const sfuSession = new SfuSession({
    onDiagnostic: reportPlaybackDiagnostic,
    onParticipantDisconnected: (identity) => {
      embyBroadcast?.forgetSfuViewer(identity);
      if (
        sfuViewerActive &&
        identity === broadcasterId &&
        broadcasterId !== selfId &&
        !leaving
      ) {
        void fallbackFromSfu(
          "SFU 放映端已离线，正在切换当前观众的 P2P 备用链路",
        );
      }
    },
    onStateChange: (state) => {
      if (state === "reconnecting" && sfuViewerActive) {
        setStatus("SFU 连接波动 · 正在自动恢复", "neutral");
        return;
      }
      if (state !== "disconnected" || leaving) return;
      if (broadcasterId === selfId) {
        sfuPublishedKey = "";
        reportSfuStatus("publisher", false);
        embyBroadcast?.detachViewer(SFU_EMBY_VIEWER_ID);
        setStatus("SFU 暂不可用 · P2P 备用链路仍可加入", "neutral");
        scheduleSfuPrimaryRecovery("SFU publisher disconnected");
        return;
      }
      if (sfuViewerActive) {
        void fallbackFromSfu("服务器 SFU 链路中断，正在切换 P2P 备用链路");
      }
    },
  });

  let mediaStream: MediaStream | undefined;
  let displayStream: MediaStream | undefined;
  let audioCapture: ProcessAudioCapture | undefined;
  let embyBroadcast: EmbyBroadcastController | undefined;
  let embyRebalanceTimer: number | undefined;
  let embyViewerPreferenceTimer: number | undefined;
  let embyPressureQualityCooldownUntil = 0;
  let embyPressureRecoveryTimer: number | undefined;
  const embyPressureQualityByViewer = new Map<
    string,
    {
      quality: EmbyPlaybackRequest["quality"];
      expiresAt: number;
    }
  >();
  let embyAdaptiveHeight = 0;
  let embyAdaptivePressureSamples = 0;
  let embyAdaptiveStableSamples = 0;
  let embyAdaptiveChangedAt = 0;
  let lastEmbyHostDiagnosticAt = 0;
  let embyViewer: EmbyMsePlayer | undefined;
  let embyAbrViewer: EmbyAbrSegmentClient | undefined;
  let embyFallbackMediaChannel: RTCDataChannel | undefined;
  let embySegmentFallbackActive = false;
  let embySegmentFallbackRequested = false;
  let embySegmentFallbackTargetTime = 0;
  let embyLogin: EmbyAccount | undefined;
  let embyAccounts: EmbyAccount[] = [];
  let embyActiveAccountId = "";
  let embyAccountPersistence: EmbyAccountState["persistence"] = "session-only";
  let embySelectedItem: EmbyLibraryItem | undefined;
  let embyPlaybackInfo: EmbyPlaybackInfo | undefined;
  let embyBrowseItems: EmbyLibraryItem[] = [];
  let embyBrowseTotal = 0;
  let embyBrowseRequestId = 0;
  let embyLibraryRequestId = 0;
  let embyAccountRefreshRequestId = 0;
  let embyActivationRequestId = 0;
  let embyActivationQueue: Promise<void> = Promise.resolve();
  let embySelectionRequestId = 0;
  let pendingEmbySelectionKey = "";
  let localBroadcastMode: "screen" | "emby" | undefined;
  let activePreset: QualityPreset | undefined;
  let statsTimer: number | undefined;
  let outboundStatsPollRunning = false;
  let bandwidthLimitedSamples = 0;
  let bandwidthWarningShown = false;
  let cpuWarningShown = false;
  let relayFallbackNoticeShown = false;
  let highRttSamples = 0;
  let highRttWarningShown = false;
  let measuredAvailableOutgoingBitrate: number | undefined;
  let capabilityUpdateTimer: number | undefined;
  let networkReport: NetworkReport | undefined;
  let networkAdvice: NetworkAdvice = fallbackNetworkAdvice(1);
  let networkProbePromise: Promise<void> | undefined;
  let networkProbeGeneration = 0;
  let networkProbeAbortController = new AbortController();
  let desktopNetworkPollRunning = false;
  let networkReportSendTimer: number | undefined;
  let networkMembershipProbeTimer: number | undefined;
  let networkAdviceExpiryTimer: number | undefined;
  let lastNetworkReportSentAt = 0;
  let forceNextNetworkProbe = false;
  let qualitySelectionTouched = false;
  let frameRateLockedByUser = false;
  let cleanupLocalBroadcastPromise: Promise<void> | undefined;
  let audioCaptureEpoch = 0;
  let audioRecoveryPromise: Promise<void> | undefined;
  let captureVideoEpoch = 0;
  let captureVideoRecoveryTimer: number | undefined;
  let captureVideoRecoveryInFlight = false;
  let captureVideoRecoveryFailures = 0;
  let captureVideoHealthTimer: number | undefined;
  let captureVideoHealthPollRunning = false;
  let activeCaptureSourceId = "";
  let captureSourceGeometry: CaptureWindowGeometry | undefined;
  const captureVideoHealth = new CaptureVideoHealthController();

  const savedResolution = localStorage.getItem("synced:resolution");
  let resolutionKey: ResolutionKey = isResolutionKey(savedResolution)
    ? savedResolution
    : "original";
  const savedFrameRate = Number(localStorage.getItem("synced:frame-rate"));
  let frameRate: FrameRateOption = isFrameRateOption(savedFrameRate)
    ? savedFrameRate
    : 30;
  const savedScreenContentMode = localStorage.getItem(
    "synced:screen-content-mode",
  );
  let screenContentMode: ScreenContentMode =
    savedScreenContentMode === "detail" ||
    savedScreenContentMode === "motion" ||
    savedScreenContentMode === "balanced"
      ? savedScreenContentMode
      : "balanced";
  let embyFrameRate = normalizeEmbyFrameRate(
    localStorage.getItem("synced:emby-frame-rate"),
  );
  // Every new broadcast starts at the source's full quality. Viewer reductions
  // are deliberately session-scoped so yesterday's reduced choice cannot make
  // a later full-quality broadcast look unexpectedly soft.
  let preferredHeight = 0;
  let preferredFrameRate = 0;
  const savedFullscreenFit = localStorage.getItem("synced:fullscreen-fit");
  let fullscreenFit: "smart" | "contain" | "cover" =
    savedFullscreenFit === "contain" || savedFullscreenFit === "cover"
      ? savedFullscreenFit
      : nativeAndroid
        ? "contain"
        : "smart";
  if (nativeAndroid && fullscreenFit === "cover") {
    fullscreenFit = "contain";
  }
  let highlightCorrection =
    localStorage.getItem("synced:highlight-correction") === "true";
  let videoEnhancementPreference: VideoEnhancementPreference =
    localStorage.getItem("synced:video-enhancement") === "off"
      ? "off"
      : "auto";
  const resourceBudgetMonitor = new ResourceBudgetMonitor();
  let resourceBudget = resourceBudgetMonitor.budget;
  const resumeTokenKey = `synced:resume-token:${room}`;
  let resumeToken =
    sessionStorage.getItem(resumeTokenKey) ||
    localStorage.getItem(resumeTokenKey) ||
    "";
  localStorage.removeItem(resumeTokenKey);
  if (!/^[a-z0-9-]{16,128}$/i.test(resumeToken)) {
    resumeToken =
      crypto.randomUUID?.() ||
      `${Date.now().toString(36)}-${crypto
        .getRandomValues(new Uint32Array(4))
        .join("-")}`;
    sessionStorage.setItem(resumeTokenKey, resumeToken);
  }
  let dockHideTimer: number | undefined;
  let fullscreenHintTimer: number | undefined;
  let activeBroadcastMode: "screen" | "emby" = "screen";
  let broadcastModeTransition = 0;
  let broadcastModeAbort: AbortController | undefined;
  const sessionUiAbortController = new AbortController();
  let ambientLight: AmbientLightController | undefined;
  let dockMoreSurface: FloatingSurface | undefined;
  let profileSurface: FloatingSurface | undefined;
  let initialInvitePending = options.showInviteOnStart === true;
  let connectionProgressDelay: number | undefined;
  let danmakuEnabled =
    localStorage.getItem("synced:danmaku") !== "false";
  let mobileGestureHudTimer: number | undefined;
  let playbackControlFrame: number | undefined;
  let playbackControlState: PlaybackControlState = {
    brightness: 0.5,
    volume: movieVolume,
  };
  let pendingPlaybackControl:
    | { kind: "brightness" | "volume"; value: number }
    | undefined;
  let mobileGesture:
    | {
        pointerId: number;
        kind: "brightness" | "volume" | "tap";
        startX: number;
        startY: number;
        startValue: number;
        moved: boolean;
      }
    | undefined;
  let fullscreenFitProbeSequence = 0;
  let fullscreenViewportTimer: number | undefined;
  let lastSmartBars: EmbeddedHorizontalBars | undefined;
  let smartBarSamples: EmbeddedHorizontalBars[] = [];
  let smartCropCanvas: HTMLCanvasElement | undefined;
  let smartCropContext: CanvasRenderingContext2D | null | undefined;

  root.innerHTML = `
    <div class="channel-layout viewer-layout session-shell">
      <aside class="channel-rail session-rail" aria-label="频道导航">
        <div
          id="session-room-identity"
          class="active-room-pill rail-current"
          role="img"
          aria-label="当前频道 ${escapeHtml(channelName)}"
          title="${escapeHtml(channelName)} · ${escapeHtml(room)}"
        >${escapeHtml(Array.from(channelName).slice(0, 2).join("") || room.slice(0, 2))}</div>
        <div class="rail-divider"></div>
        ${desktop ? embeddedGameRailButtonMarkup() : ""}
        ${desktop ? channelMusicRailButtonMarkup() : ""}
        <div class="rail-spacer"></div>
        <button
          id="session-profile"
          class="profile-orb profile-action"
          type="button"
          aria-label="修改昵称，当前昵称 ${escapeHtml(nickname)}"
          title="${escapeHtml(nickname)} · 点击修改昵称"
        >${escapeHtml(Array.from(nickname)[0] || "友")}</button>
        <div id="session-profile-menu" class="profile-popover" hidden>
          <label for="session-nickname-input">频道昵称</label>
          <input id="session-nickname-input" type="text" maxlength="24"
                 autocomplete="nickname" value="${escapeHtml(nickname)}" />
          <button id="save-session-nickname" class="btn btn-primary" type="button">
            保存昵称
          </button>
        </div>
      </aside>
      <main class="stage-column">
        <header class="channel-header session-header">
          <div>
            <span id="session-live-dot" class="live-dot idle"></span>
            <div>
              <strong id="session-channel-name">${escapeHtml(channelName)}</strong>
              <small>频道 ${escapeHtml(room)} · 任意 Windows 成员可放映</small>
            </div>
          </div>
          <div class="channel-header-actions">
            <div
              class="hud-bar session-status-line is-idle"
              id="hud-bar"
              data-playback-state="idle"
              aria-label="连接与播放状态，当前无放映"
            >
              <button class="hud-track" id="hud-signal" type="button"
                      aria-label="信令服务器状态：连接中" aria-live="polite">
                <span class="dot" id="hud-signal-dot"></span>
                <span class="hud-label" id="hud-signal-text">连接中</span>
              </button>
              <span class="hud-track" id="hud-media" role="status" aria-live="polite">
                <span class="hud-label" id="hud-media-text">等待放映</span>
              </span>
              <span class="hud-track hud-voice-compact" id="hud-voice" role="status" aria-live="polite">
                <span class="meter" id="hud-voice-meter" aria-hidden="true">
                  <i></i><i></i><i></i>
                </span>
                <span class="hud-label" id="hud-voice-text">未连麦</span>
              </span>
            </div>
            ${
              desktop
                ? `<button id="broadcast-action" class="btn btn-subtle header-broadcast-action" type="button" hidden>停止放映</button>`
                : ""
            }
            <button id="session-companion" class="btn btn-ghost btn-icon" type="button"
                    aria-label="打开聊天与成员" title="聊天与成员">
              <i data-lucide="users"></i>
            </button>
            <button id="session-invite" class="btn btn-secondary" type="button"
                    aria-label="邀请朋友" title="邀请朋友" data-tooltip="邀请朋友">
              <i data-lucide="user-plus"></i><span>邀请</span>
            </button>
            <button id="leave-room" class="btn btn-danger" type="button"
                    aria-label="退出频道" title="退出频道" data-tooltip="退出频道">
              <i data-lucide="log-out"></i><span>退出</span>
            </button>
          </div>
        </header>
        <section id="player-stage" class="video-stage viewer-stage${nativeAndroid ? " native-android-player" : ""}">
          <div class="ambient-light-field" aria-hidden="true"></div>
          <video id="channel-video" autoplay playsinline hidden></video>
          <canvas id="video-enhancement-canvas" class="video-enhancement-canvas" hidden aria-hidden="true"></canvas>
          <div id="video-enhancement-subtitles" class="video-enhancement-subtitles" hidden aria-hidden="true"></div>
          <audio id="channel-movie-audio" autoplay playsinline hidden></audio>
          <div id="stage-danmaku" class="danmaku-layer" aria-hidden="true"></div>
          <div id="receiver-stream-badge" class="receiver-stream-badge" hidden aria-live="polite"></div>
          <div id="channel-empty" class="channel-empty channel-lobby">
            <div class="lobby-light-field" data-decorative-motion aria-hidden="true">
              <i></i><i></i><i></i>
            </div>
            <span class="eyebrow">频道大厅</span>
            <h2>${escapeHtml(channelName)}</h2>
            <button id="lobby-copy-room" class="lobby-room-code tnum" type="button"
                    aria-label="复制频道码 ${escapeHtml(room)}">
              ${escapeHtml(room.slice(0, 4))}<span>·</span>${escapeHtml(room.slice(4))}
            </button>
            <div id="lobby-participants" class="lobby-participants" aria-live="polite">
              <span class="lobby-avatar" title="${escapeHtml(nickname)}">${escapeHtml(Array.from(nickname)[0] || "友")}</span>
            </div>
            <p id="lobby-participant-summary">正在同步频道成员…</p>
            <div class="lobby-actions">
              ${
                desktop
                  ? `<button id="stage-start-broadcast" class="btn btn-primary" type="button">
                       <i data-lucide="monitor-play"></i>开始放映
                     </button>`
                  : `<span class="lobby-waiting-note">等待 Windows 成员开始放映</span>`
              }
              <button id="lobby-invite" class="btn btn-secondary" type="button">
                <i data-lucide="user-plus"></i>邀请朋友
              </button>
            </div>
            <p id="lobby-voice-summary" class="lobby-voice-summary">还没有人加入连麦</p>
          </div>
          <div id="channel-buffering" class="channel-buffering" hidden>
            <span class="buffer-spinner" aria-hidden="true"></span>
            <strong id="buffering-title">正在连接放映画面</strong>
            <p id="buffering-detail">已通知放映端，正在协商点对点连接…</p>
            <progress id="buffering-progress" max="5" value="1" aria-label="连接进度"></progress>
            <button id="retry-watch" class="ghost-button" type="button" hidden>重新连接画面</button>
          </div>
          ${
            nativeAndroid
              ? `
                <output id="mobile-playback-stats" class="mobile-playback-stats" aria-live="polite" hidden>等待画面数据</output>
                <div id="mobile-gesture-hud" class="mobile-gesture-hud" hidden aria-live="polite">
                  <i class="brightness-icon" data-lucide="sun"></i>
                  <i class="volume-icon" data-lucide="volume-2"></i>
                  <strong id="mobile-gesture-value">50%</strong>
                </div>
                <div class="mobile-gesture-hint" aria-hidden="true">左侧滑动调亮度 · 右侧滑动调音量</div>
              `
              : ""
          }
          <div class="progress-rail" id="stage-progress" hidden
             role="slider" tabindex="0" aria-label="播放进度"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
             aria-valuetext="0:00">
          <div class="progress-buffer" id="progress-buffer"></div>
          <div class="progress-fill" id="progress-fill"></div>
          <div class="progress-thumb" id="progress-thumb" aria-hidden="true"></div>
          <span class="progress-tooltip" id="progress-tooltip" aria-hidden="true"></span>
        </div>
        <div class="dock material-clear" id="stage-dock" role="toolbar" aria-label="播放控制" hidden>
          <div class="dock-cluster dock-transport" role="group" aria-label="播放">
            <button class="btn btn-ghost btn-icon" id="dock-play"
                    type="button" aria-label="播放" aria-pressed="false"
                    title="播放 / 暂停" data-tooltip="播放 / 暂停">
              <i class="play-icon" data-lucide="play"></i>
              <i class="pause-icon" data-lucide="pause"></i>
            </button>
            <button class="btn btn-ghost btn-icon btn-icon-sm" id="dock-rewind"
                    type="button" aria-label="后退 10 秒"
                    title="后退 10 秒" data-tooltip="后退 10 秒">
              <i data-lucide="rotate-ccw"></i>
            </button>
            <button class="btn btn-ghost btn-icon btn-icon-sm" id="dock-forward"
                    type="button" aria-label="前进 10 秒"
                    title="前进 10 秒" data-tooltip="前进 10 秒">
              <i data-lucide="rotate-cw"></i>
            </button>
          </div>
          <span class="dock-sep dock-sep-after-transport" aria-hidden="true"></span>
          <div class="dock-cluster dock-audio" role="group" aria-label="声音">
            <button id="enable-sound" class="btn btn-subtle" type="button" hidden>开启声音</button>
            <div id="movie-volume-control" class="dock-volume">
              <button class="btn btn-ghost btn-icon btn-icon-sm" id="dock-mute"
                      type="button" aria-label="静音切换" aria-pressed="false"
                      title="影片静音" data-tooltip="影片静音">
                <i data-lucide="volume-2"></i>
              </button>
              <input class="slider" type="range" min="0" max="1" step="0.05"
                     id="dock-volume" aria-label="影片音量" value="${movieVolume}">
              <output id="movie-volume-value" class="sr-only">${Math.round(movieVolume * 100)}%</output>
            </div>
          </div>
          <span class="mono tnum dock-time" id="dock-time" aria-live="off"></span>
          <span class="dock-sep dock-sep-before-social" aria-hidden="true"></span>
          <div class="dock-cluster dock-social" role="group" aria-label="互动">
            <button class="btn btn-ghost btn-icon btn-icon-sm${danmakuEnabled ? " is-on" : ""}" id="dock-danmaku"
                    type="button" aria-label="${danmakuEnabled ? "关闭弹幕" : "开启弹幕"}"
                    aria-pressed="${danmakuEnabled}"
                    title="${danmakuEnabled ? "弹幕已开启，点击关闭" : "弹幕已关闭，点击开启"}"
                    data-tooltip="${danmakuEnabled ? "弹幕：已开启" : "弹幕：已关闭"}">
              <i data-lucide="list"></i>
            </button>
            <button class="btn btn-ghost btn-icon btn-icon-sm" id="dock-chat"
                      type="button" title="打开聊天" data-tooltip="聊天"
                      aria-label="快捷发送弹幕" aria-pressed="false"
                      aria-expanded="false" aria-controls="dock-chat-composer">
                <i data-lucide="message-circle"></i>
              </button>
          </div>
          <span class="dock-sep" aria-hidden="true"></span>
          <div class="dock-cluster dock-view" role="group" aria-label="画面与窗口">
            <button class="btn btn-ghost btn-icon btn-icon-sm" id="dock-quality"
                    type="button" title="画面设置" data-tooltip="画面设置" aria-label="画面设置">
              <i data-lucide="sliders-horizontal"></i>
            </button>
            <button class="btn btn-ghost btn-icon btn-icon-sm" id="dock-emby-settings"
                    type="button" title="流设置" data-tooltip="音轨 / 字幕 / 画质" aria-label="流设置" hidden>
              <i data-lucide="settings"></i>
            </button>
            <button class="btn btn-ghost btn-icon btn-icon-sm" id="dock-more"
                    type="button" aria-label="更多播放操作" aria-expanded="false"
                    aria-controls="dock-more-menu" title="更多" data-tooltip="更多">
              <i data-lucide="ellipsis"></i>
            </button>
            <button class="btn btn-ghost btn-icon btn-icon-sm" id="dock-fullscreen"
                    type="button" aria-label="进入全屏" aria-pressed="false" disabled
                    title="全屏播放" data-tooltip="全屏播放">
              <i data-lucide="maximize-2"></i>
            </button>
          </div>
          <div id="dock-more-menu" class="dock-more-menu" hidden role="menu"
               aria-label="更多播放操作">
            <button class="dock-menu-item${fullscreenFit === "smart" ? " is-on" : ""}" id="dock-smart-crop"
                    type="button" role="menuitemcheckbox"
                    aria-checked="${fullscreenFit === "smart"}"
                    aria-label="${fullscreenFit === "smart" ? "关闭智能裁剪" : "开启智能裁剪"}">
              <i data-lucide="scan-line"></i><span>智能裁剪</span><small>全屏去黑边</small>
            </button>
            <button class="dock-menu-item" id="dock-highlight" type="button" role="menuitemcheckbox"
                    aria-checked="${highlightCorrection}">
              <i data-lucide="sliders-horizontal"></i><span>高光修正</span><small>${highlightCorrection ? "已开启" : "已关闭"}</small>
            </button>
            <button class="dock-menu-item" id="dock-enhancement" type="button" role="menuitemcheckbox"
                    aria-checked="${videoEnhancementPreference !== "off"}">
              <i data-lucide="sparkles"></i><span>视频增强</span><small>${videoEnhancementPreference === "off" ? "已关闭" : "自动"}</small>
            </button>
            <button class="dock-menu-item" id="dock-pip"
                    type="button" role="menuitemcheckbox" aria-label="小窗模式已关闭，点击开启"
                    aria-checked="false">
              <i data-lucide="picture-in-picture-2"></i><span>小窗模式</span>
              <small class="mini-window-state">关</small>
            </button>
            <button class="dock-menu-item" id="dock-stats" type="button" role="menuitem">
              <i data-lucide="radio"></i><span>统计信息</span><small>可关闭面板</small>
            </button>
            <button class="dock-menu-item" id="dock-diagnostics" type="button" role="menuitem">
              <i data-lucide="wifi"></i><span>线路诊断</span><small>网络与媒体路径</small>
            </button>
            <button class="dock-menu-item" id="dock-shortcuts" type="button" role="menuitem">
              <i data-lucide="command"></i><span>键盘快捷键</span><small>随时查看</small>
            </button>
          </div>
          <form id="dock-chat-composer" class="dock-chat-composer material-regular"
                aria-label="快捷发送弹幕" hidden>
            <label class="sr-only" for="dock-chat-input">弹幕内容</label>
            <input id="dock-chat-input" class="dock-chat-input" type="text"
                   maxlength="120" autocomplete="off" enterkeyhint="send"
                   placeholder="发条弹幕，不离开画面…" />
            <button id="dock-chat-send" class="dock-chat-send btn btn-primary"
                    type="submit">发送</button>
            <button id="dock-chat-close" class="dock-chat-close btn btn-ghost btn-icon"
                    type="button" aria-label="关闭快捷弹幕"><i data-lucide="x"></i></button>
          </form>
        </section>
      </main>
      ${roomSidebarMarkup()}
    </div>
    <section id="session-connection-progress" class="session-connection-progress material-card"
             aria-labelledby="session-connection-title" aria-live="polite" hidden>
      <div class="connection-orbit" aria-hidden="true"></div>
      <span class="eyebrow">正在进入光域</span>
      <h2 id="session-connection-title">正在连接服务器</h2>
      <ol class="connection-steps">
        <li data-connection-step="server" data-state="active">
          <i data-lucide="circle"></i><span>连接服务器</span>
        </li>
        <li data-connection-step="room" data-state="pending">
          <i data-lucide="circle"></i><span>加入频道</span>
        </li>
        <li data-connection-step="members" data-state="pending">
          <i data-lucide="circle"></i><span>同步成员</span>
        </li>
        <li data-connection-step="media" data-state="pending">
          <i data-lucide="circle"></i><span>准备媒体线路</span>
        </li>
      </ol>
      <button id="cancel-session-connection" class="btn btn-secondary" type="button">取消</button>
    </section>
    <dialog id="invite-dialog" class="invite-dialog dialog">
      <div class="dialog-header">
        <div>
          <span class="eyebrow">${createIfMissing ? "频道已准备好" : "邀请朋友"}</span>
          <h2>${createIfMissing ? "把朋友带进这束光" : "邀请朋友进入频道"}</h2>
        </div>
        <button data-close-invite class="btn btn-ghost btn-icon" type="button" aria-label="关闭">
          <i data-lucide="x"></i>
        </button>
      </div>
      <p class="invite-channel-name">${escapeHtml(channelName)}</p>
      <button id="copy-room" class="invite-code tnum" type="button" aria-label="复制频道码 ${escapeHtml(room)}">
        <span>${escapeHtml(room.slice(0, 4))}<i aria-hidden="true">·</i>${escapeHtml(room.slice(4))}</span>
        <small><i data-lucide="copy"></i>点击复制频道码</small>
      </button>
      ${desktop ? `<img id="invite-qr" alt="加入 ${escapeHtml(channelName)} 的二维码" width="220" height="220" />` : ""}
      <p class="invite-help">${desktop ? "朋友扫码、打开邀请链接或输入频道码即可加入。" : "复制邀请或使用系统分享发送给朋友。"}</p>
      <div class="dialog-actions invite-actions">
        <button id="copy-invite" class="btn btn-secondary" type="button">
          <i data-lucide="copy"></i>复制邀请
        </button>
        <button id="share-invite" class="btn btn-secondary" type="button">
          <i data-lucide="share-2"></i>系统分享
        </button>
        <button id="enter-created-room" class="btn btn-primary" type="button">
          进入频道
        </button>
      </div>
    </dialog>
    <dialog id="playback-diagnostics-dialog" class="dialog playback-diagnostics-dialog">
      <div class="dialog-header">
        <div>
          <span class="eyebrow">播放诊断</span>
          <h2 id="playback-diagnostics-title">统计信息</h2>
        </div>
        <button class="btn btn-ghost btn-icon" type="button"
                data-close-playback-diagnostics aria-label="关闭">
          <i data-lucide="x"></i>
        </button>
      </div>
      <output id="desktop-playback-stats" class="playback-stats-output"
              aria-live="polite">等待媒体统计数据</output>
      <dl id="playback-route-details" class="playback-route-details">
        <div><dt>信令</dt><dd id="diagnostic-signal-route">正在连接</dd></div>
        <div><dt>媒体</dt><dd id="diagnostic-media-route">等待放映</dd></div>
        <div><dt>网络建议</dt><dd id="diagnostic-network-advice">正在检测</dd></div>
        <div><dt>隐私</dt><dd>只显示路径状态，不公开本地地址</dd></div>
      </dl>
    </dialog>
    <dialog id="picture-dialog" class="picture-dialog">
      <header>
        <div>
          <span class="eyebrow">PLAYBACK</span>
          <h2>画面设置</h2>
        </div>
        <button data-close-picture type="button" aria-label="关闭画面设置"><i data-lucide="x"></i></button>
      </header>
      <p id="picture-source-summary" class="picture-source-summary">等待放映画面</p>
      <div id="receiver-quality" class="receiver-quality picture-quality" aria-label="观看画质偏好" hidden>
        <label>
          <span>清晰度</span>
          <select id="viewer-resolution" aria-label="观看清晰度">
            <option value="0">原画</option>
            <option value="2160">4K · 最高 2160p</option>
            <option value="1440">2K · 最高 1440p</option>
            <option value="1200">平衡 · 最高 1200p</option>
            <option value="1080">高清 · 最高 1080p</option>
            <option value="720">标清 · 最高 720p</option>
            <option value="480">流畅 · 最高 480p</option>
          </select>
        </label>
        <label>
          <span>帧率</span>
          <select id="viewer-frame-rate" aria-label="观看帧率">
            <option value="0">原帧率</option>
            <option value="24">24 帧</option>
            <option value="30">30 帧</option>
          </select>
        </label>
        <small id="receiver-capability" class="receiver-capability" hidden></small>
      </div>
      <fieldset class="picture-choice-group">
        <legend>全屏显示</legend>
        <div class="segmented-control">
          <button type="button" data-fit-mode="smart" aria-pressed="${fullscreenFit === "smart"}">智能铺满</button>
          <button type="button" data-fit-mode="contain" aria-pressed="${fullscreenFit === "contain"}">完整画面</button>
          <button type="button" data-fit-mode="cover" aria-pressed="${fullscreenFit === "cover"}">铺满屏幕</button>
        </div>
        <small>智能铺满会稳定检测黑边、始终居中并保留字幕安全区；“铺满屏幕”会更激进地裁切上下画面。</small>
      </fieldset>
      <label class="highlight-correction">
        <span>
          <strong>HDR 高光修正</strong>
          <small>画面过亮时压低高光；若细节已经被截断，请关闭放映电脑或播放器的 HDR。</small>
        </span>
        <input id="highlight-correction" type="checkbox" ${highlightCorrection ? "checked" : ""} />
      </label>
      ${
        desktop
          ? `<label class="highlight-correction video-enhancement-setting">
              <span>
                <strong>GPU 清晰增强</strong>
                <small id="video-enhancement-status">仅在远端 Emby 低于 1080p、输出接近 2K/4K 且 GPU 有余量时自动开启。</small>
              </span>
              <input id="video-enhancement" type="checkbox" ${videoEnhancementPreference === "auto" ? "checked" : ""} />
            </label>`
          : ""
      }
    </dialog>
    <dialog id="emby-settings-dialog" class="picture-dialog emby-settings-dialog">
      <header>
        <div>
          <span class="eyebrow">STREAM</span>
          <h2>流设置</h2>
        </div>
        <button data-close-emby-settings type="button" aria-label="关闭流设置"><i data-lucide="x"></i></button>
      </header>
      <p id="emby-settings-summary" class="picture-source-summary">Emby 高清放映中</p>
      <div class="emby-live-settings">
        <label>
          <span>画质</span>
          <select id="emby-live-quality" aria-label="切换 Emby 画质">
            <option value="auto">自动（按人数与上行）</option>
            <option value="original">原始码率</option>
            <option value="4k-18">4K · 18 Mbps</option>
            <option value="4k-12">4K · 12 Mbps</option>
            <option value="1440p-18">2K · 18 Mbps</option>
            <option value="1080p-12">1080P · 12 Mbps</option>
            <option value="1080p-8">1080P · 8 Mbps</option>
            <option value="720p-6">720P · 6 Mbps</option>
            <option value="720p-4">720P · 4 Mbps</option>
            <option value="480p-2.5">480P · 2.5 Mbps</option>
            <option value="360p-1.2">360P · 1.2 Mbps（弱网保底）</option>
          </select>
        </label>
        <label>
          <span>帧率上限</span>
          <select id="emby-live-frame-rate" aria-label="切换 Emby 帧率">
            <option value="24">24 帧 · 电影原帧</option>
            <option value="30">30 帧 · 均衡</option>
            <option value="60">60 帧 · 高流畅</option>
          </select>
        </label>
        <label>
          <span>音轨</span>
          <select id="emby-live-audio" aria-label="切换音轨"></select>
        </label>
        <label>
          <span>字幕</span>
          <select id="emby-live-subtitle" aria-label="切换字幕"></select>
        </label>
      </div>
      <small class="emby-settings-note">切换音轨或字幕将从当前位置重新建立媒体流，约需2–3秒。</small>
    </dialog>
    ${
      desktop
        ? `
          <dialog id="broadcast-dialog" class="source-dialog broadcast-dialog">
            <header>
              <div><span class="eyebrow">START BROADCAST</span><h2>选择放映模式</h2></div>
              <button data-close-broadcast type="button" aria-label="关闭"><i data-lucide="x"></i></button>
            </header>
            <div class="broadcast-mode-tabs" role="tablist" aria-label="放映模式" data-active-mode="screen">
              <span class="broadcast-mode-glider" aria-hidden="true"></span>
              <button id="screen-mode-tab" class="active" type="button" role="tab"
                      aria-selected="true" aria-controls="screen-broadcast-panel"
                      data-selected="true" tabindex="0" data-broadcast-mode="screen">
                <strong>普通屏幕共享</strong><span>兼容所有播放器和内容</span>
              </button>
              <button id="emby-mode-tab" type="button" role="tab"
                      aria-selected="false" aria-controls="emby-broadcast-panel"
                      data-selected="false" tabindex="-1" data-broadcast-mode="emby">
                <strong>Emby 高清播放</strong><span>服务器原始编码流，不捕获屏幕</span>
              </button>
            </div>
            <section id="screen-broadcast-panel" class="broadcast-mode-panel"
                     role="tabpanel" aria-labelledby="screen-mode-tab">
            <div class="source-toolbar">
              <label>
                <i data-lucide="search" aria-hidden="true"></i>
                <input id="session-source-search" type="search" autocomplete="off"
                       placeholder="搜索播放器或窗口名称" aria-label="搜索可分享窗口" />
              </label>
              <span id="session-source-count">尚未读取</span>
              <button id="refresh-session-sources" class="btn btn-ghost" type="button">
                <i data-lucide="refresh-cw"></i>刷新
              </button>
            </div>
            <div class="source-filter-row" role="group" aria-label="筛选窗口来源">
              <button class="btn btn-subtle" type="button" data-source-filter="recent" aria-pressed="false">最近</button>
              <button class="btn btn-subtle" type="button" data-source-filter="player" aria-pressed="false">播放器</button>
              <button class="btn btn-subtle" type="button" data-source-filter="browser" aria-pressed="false">浏览器</button>
              <button class="btn btn-subtle" type="button" data-source-filter="all" aria-pressed="true">全部</button>
            </div>
            <div id="session-source-grid" class="source-grid" role="listbox"
                 aria-label="可分享窗口" aria-live="polite">
              ${Array.from({ length: 6 }, () => `<div class="source-card source-skeleton" aria-hidden="true"><span></span><i></i></div>`).join("")}
            </div>
            <section id="selected-source-summary" class="selected-source-summary" aria-live="polite">
              <div>
                <span>当前来源</span>
                <strong id="selected-source-name">请选择要放映的窗口</strong>
                <small id="selected-source-detail">选择后可在开始前确认分辨率与声音能力</small>
              </div>
              <i data-lucide="monitor-play" aria-hidden="true"></i>
            </section>
            <section class="screen-smart-default" aria-labelledby="screen-smart-title">
              <div>
                <span>画质</span>
                <strong id="screen-smart-title">智能推荐</strong>
                <small id="screen-smart-reason">依据房间人数、实时上行与窗口尺寸自动选择</small>
              </div>
              <fieldset class="content-mode-field">
                <legend>内容</legend>
                <div class="segmented-control">
                  ${([
                    ["motion", "电影"],
                    ["detail", "文字"],
                    ["balanced", "高动态"],
                  ] as const)
                    .map(
                      ([value, label]) => `
                        <button type="button" class="${screenContentMode === value ? "active" : ""}"
                                data-screen-content-mode="${value}"
                                aria-pressed="${screenContentMode === value}">
                          ${label}
                        </button>
                      `,
                    )
                    .join("")}
                </div>
              </fieldset>
            </section>
            <details id="broadcast-advanced" class="broadcast-advanced">
              <summary>高级编码设置</summary>
            <section id="broadcast-network-card" class="broadcast-network-card" data-confidence="low" aria-labelledby="broadcast-network-title">
              <header>
                <div>
                  <span class="network-pulse" aria-hidden="true"></span>
                  <div>
                    <strong id="broadcast-network-title">房间网络体检</strong>
                    <span id="network-confidence">后台检测中</span>
                  </div>
                </div>
                <span id="network-route" class="network-route">智能线路 · 按真实 ICE 结果选择</span>
              </header>
              <div class="network-metric-grid">
                <div><span>上行</span><strong id="network-upload">待检测</strong></div>
                <div><span>下行</span><strong id="network-download">待检测</strong></div>
                <div><span>延迟</span><strong id="network-latency">待检测</strong></div>
                <div><span>房间设备</span><strong id="network-room-size">1 台</strong></div>
              </div>
              <p id="network-advice-reason">正在汇总当前房间设备的匿名网络状态，不上传 IP、运营商或网卡信息。</p>
            </section>
            <div class="broadcast-quality-panel">
              <fieldset class="quality-field">
                <legend>分辨率 <span id="bw-recommend-hint" class="bw-recommend-hint"></span></legend>
                <div class="quality-grid">
                  ${RESOLUTION_OPTIONS.map(
                    (option) => `
                      <button type="button" class="quality-option ${resolutionKey === option.key ? "active" : ""}" data-session-resolution="${option.key}">
                        <strong>${option.label}</strong><span>${option.description}</span>
                        <span class="quality-recommended-badge" hidden>推荐</span>
                      </button>
                    `,
                  ).join("")}
                </div>
              </fieldset>
              <fieldset class="quality-field frame-rate-field">
                <legend>帧率</legend>
                <div class="quality-grid">
                  ${FRAME_RATE_OPTIONS.map(
                    (option) => `
                      <button type="button" class="quality-option ${frameRate === option ? "active" : ""}" data-session-frame-rate="${option}">
                        <strong>${option} 帧</strong><span>${option === 24 ? "电影原帧" : option === 30 ? "均衡" : option === 60 ? "流畅" : option === 90 ? "高刷" : "极致高刷"}</span>
                      </button>
                    `,
                  ).join("")}
                </div>
              </fieldset>
              <p id="session-quality-summary" class="quality-summary">${escapeHtml(buildQualityPreset(resolutionKey, frameRate).detail)}</p>
            </div>
            </details>
            <footer class="source-dialog-footer">
              <div>
                <strong id="broadcast-ready-title">选择一个来源后即可开始</strong>
                <small id="broadcast-ready-detail">启动前会再次确认画质、帧率和声音</small>
              </div>
              <div class="source-dialog-actions">
                <button id="cancel-screen-broadcast" class="btn btn-secondary" type="button">取消</button>
                <button id="start-screen-broadcast" class="btn btn-primary" type="button" disabled>
                  <i data-lucide="cast"></i><span id="start-screen-broadcast-label">开始放映</span>
                </button>
              </div>
            </footer>
            </section>
            <section id="emby-broadcast-panel" class="broadcast-mode-panel emby-broadcast-panel"
                     role="tabpanel" aria-labelledby="emby-mode-tab" hidden>
              <div id="emby-login-panel" class="emby-login-panel">
                <div id="emby-saved-accounts" class="emby-saved-accounts" hidden>
                  <div class="emby-saved-heading">
                    <div><strong>已保存的 Emby 服务器</strong><span id="emby-saved-note"></span></div>
                  </div>
                  <div id="emby-saved-account-list" class="emby-saved-account-list"></div>
                </div>
                <div class="emby-mode-intro">
                  <strong>由本程序直接读取 Emby 媒体流</strong>
                  <span>密码不会保存；登录令牌由 Windows 系统加密后保留在本机，不会发送到房间或朋友设备。</span>
                </div>
                <form id="emby-login-form" class="emby-login-form">
                  ${embyEndpointEditorMarkup("login", localStorage.getItem("synced:emby-server") || "")}
                  <label><span>用户名</span><input id="emby-username" type="text" required autocomplete="username" maxlength="128" /></label>
                  <label><span>密码</span><input id="emby-password" type="password" autocomplete="current-password" maxlength="1024" placeholder="无密码账户可留空" /></label>
                  <label class="emby-http-consent"><input id="emby-allow-http" type="checkbox" /><span>允许可信局域网中的未加密 HTTP（登录密码会经过局域网明文传输）</span></label>
                  <button id="emby-login-submit" class="primary-button compact-button" type="submit">登录并保存</button>
                </form>
                <p id="emby-login-status" class="emby-status" aria-live="polite"></p>
              </div>
              <div id="emby-library-panel" class="emby-library-panel" hidden>
                <div class="emby-library-layout">
                  <nav class="emby-library-nav" aria-label="Emby 媒体库">
                    <div class="emby-library-identity">
                      <strong id="emby-account-name">已连接 Emby</strong>
                      <span id="emby-account-detail"></span>
                    </div>
                    <button type="button" data-emby-nav-mode="all" aria-current="page" tabindex="0">
                      <i data-lucide="library"></i>首页
                    </button>
                    <button type="button" data-emby-nav-mode="resume" tabindex="-1">
                      <i data-lucide="play"></i>继续观看
                    </button>
                    <button type="button" data-emby-nav-mode="movies" tabindex="-1">
                      <i data-lucide="monitor-play"></i>电影
                    </button>
                    <button type="button" data-emby-nav-mode="episodes" tabindex="-1">
                      <i data-lucide="library"></i>剧集
                    </button>
                    <button type="button" data-emby-nav-mode="favorite" tabindex="-1">
                      <i data-lucide="heart"></i>收藏
                    </button>
                    <button type="button" data-emby-nav-mode="latest" tabindex="-1">
                      <i data-lucide="sparkles"></i>最近添加
                    </button>
                    <label class="emby-library-select-label">
                      <span>媒体库</span>
                      <select id="emby-library-select">
                        <option value="">全部媒体</option>
                      </select>
                    </label>
                    <button id="emby-open-settings" type="button">
                      <i data-lucide="settings"></i>账户与线路设置
                    </button>
                  </nav>
                  <section class="emby-library-content">
                    <header class="emby-content-header">
                      <div>
                        <span class="eyebrow">LIBRARY</span>
                        <h3 id="emby-content-title">媒体首页</h3>
                      </div>
                      <select id="emby-account-switch" aria-label="切换 Emby 服务器"></select>
                    </header>
                    <div class="emby-browser-toolbar">
                      <label class="emby-search">
                        <i data-lucide="search" aria-hidden="true"></i>
                        <input id="emby-search-input" type="search" maxlength="160"
                               placeholder="搜索电影、剧集或集名" aria-label="搜索 Emby 媒体" />
                      </label>
                      <select id="emby-browse-filter" class="sr-only" aria-label="内容筛选">
                        <option value="all">全部可播放内容</option>
                        <option value="resume">继续观看</option>
                        <option value="latest">最近新增</option>
                        <option value="movies">电影与视频</option>
                        <option value="episodes">剧集</option>
                        <option value="favorite">收藏</option>
                      </select>
                      <button id="emby-refresh-library" class="btn btn-ghost" type="button">
                        <i data-lucide="refresh-cw"></i>刷新
                      </button>
                    </div>
                    <p id="emby-library-status" class="emby-status" aria-live="polite">
                      登录后读取媒体库
                    </p>
                    <div id="emby-item-grid" class="emby-item-grid"></div>
                    <button id="emby-load-more" class="btn btn-secondary emby-load-more"
                            type="button" hidden>加载更多</button>
                  </section>
                </div>
              </div>
            </section>
        <aside id="emby-item-popup" class="emby-item-popup-dialog" hidden
               aria-label="Emby 媒体详情">
          <button type="button" data-close-emby-popup class="emby-popup-close"
                  aria-label="关闭影片详情"><i data-lucide="x"></i></button>
          <div class="emby-popup-layout">
            <div class="emby-popup-poster">
              <img class="emby-popup-poster-img" alt="" hidden />
              <div class="emby-popup-poster-placeholder" aria-hidden="true"><i data-lucide="play"></i></div>
            </div>
            <div class="emby-popup-info">
              <div class="emby-popup-meta">
                <span class="emby-popup-kind"></span>
                <span class="emby-popup-year"></span>
              </div>
              <h2 class="emby-popup-title"></h2>
              <p class="emby-popup-tagline" hidden></p>
              <dl class="emby-popup-facts">
                <div data-popup-fact="premiere"><dt>上映时间</dt><dd class="emby-popup-premiere"></dd></div>
                <div data-popup-fact="runtime"><dt>时长</dt><dd class="emby-popup-runtime"></dd></div>
                <div data-popup-fact="rating"><dt>分级 / 评分</dt><dd class="emby-popup-rating"></dd></div>
                <div data-popup-fact="genres"><dt>类型</dt><dd class="emby-popup-genres"></dd></div>
                <div data-popup-fact="studios"><dt>出品</dt><dd class="emby-popup-studios"></dd></div>
                <div data-popup-fact="server"><dt>媒体来源</dt><dd class="emby-popup-server"></dd></div>
              </dl>
              <p class="emby-popup-overview"></p>
            </div>
          </div>
          <div class="emby-popup-options" id="emby-selection-panel-popup">
            <div class="emby-stream-options">
              <label><span>媒体版本</span><select id="emby-media-source"></select></label>
              <label><span>质量与总上行预算</span>
                <select id="emby-quality">
                  <option value="auto">自动（按片源、人数与总上行选择）</option>
                  <option value="1440p-18">2K · 18 Mbps</option>
                  <option value="1080p-12">1080P · 12 Mbps</option>
                  <option value="1080p-8">1080P · 8 Mbps</option>
                  <option value="720p-6">720P · 6 Mbps</option>
                  <option value="720p-4">720P · 4 Mbps</option>
                  <option value="480p-2.5">480P · 2.5 Mbps</option>
                  <option value="360p-1.2">360P · 1.2 Mbps（弱网保底）</option>
                  <option value="4k-18">4K · 18 Mbps</option>
                  <option value="4k-12">4K · 12 Mbps</option>
                  <option value="original">原始码率（仅在总上行充足时）</option>
                </select>
              </label>
              <label><span>帧率上限</span>
                <select id="emby-frame-rate">
                  <option value="24" ${embyFrameRate === 24 ? "selected" : ""}>24 帧 · 电影原帧</option>
                  <option value="30" ${embyFrameRate === 30 ? "selected" : ""}>30 帧 · 均衡</option>
                  <option value="60" ${embyFrameRate === 60 ? "selected" : ""}>60 帧 · 高流畅</option>
                </select>
              </label>
              <label><span>音轨</span><select id="emby-audio-track"></select></label>
              <label><span>字幕</span><select id="emby-subtitle-track"><option value="">无字幕</option></select></label>
              <label class="emby-hevc-option" hidden>
                <input id="emby-allow-hevc" type="checkbox" />
                <span>
                  <b>允许 HEVC 直传（自动检测）</b>
                  <small id="emby-hevc-support" aria-live="polite">正在检查本机与观众设备…</small>
                </span>
                <i data-lucide="circle-help" tabindex="0" role="note" aria-label="HEVC 说明" title="HEVC 在相近画质下通常更省带宽，但 Windows、浏览器和手机的硬件解码支持并不一致。只有本机和当前所有观众都明确上报支持时才可开启；否则自动使用兼容性更高的 H.264。"></i>
              </label>
              <label id="emby-resume-option" class="emby-resume-option" hidden><input id="emby-resume-playback" type="checkbox" checked /><span id="emby-resume-label">从上次位置继续播放</span></label>
            </div>
            <p id="emby-bandwidth-budget" class="emby-bandwidth-budget" hidden></p>
            <p id="emby-stream-method" class="emby-stream-method" aria-live="polite"></p>
          </div>
          <div class="emby-popup-actions">
            <button id="emby-start-from-popup" type="button" class="primary-button compact-button">开始 Emby 高清放映</button>
          </div>
        </aside>
          </dialog>
        <dialog id="emby-endpoint-dialog" class="emby-endpoint-dialog">
          <header>
            <div>
              <span class="eyebrow">ROUTES</span>
              <h2>管理 Emby 线路</h2>
            </div>
            <button type="button" data-close-emby-endpoints aria-label="关闭线路管理"><i data-lucide="x"></i></button>
          </header>
          <p class="emby-endpoint-dialog-note">备用线路会先匿名验证 Server Id；只有确认属于同一台 Emby 后，才会保存并在主线路故障时使用。</p>
          ${embyEndpointEditorMarkup("manage")}
          <label class="emby-http-consent emby-endpoint-http-consent"><input id="emby-manage-allow-http" type="checkbox" /><span>允许可信局域网中的 HTTP 线路</span></label>
          <button id="emby-save-endpoints" type="button" class="primary-button">保存并验证线路</button>
        </dialog>
        `
        : ""
    }
  `;

  hydrateIcons(root);
  const video = document.querySelector<HTMLVideoElement>("#channel-video");
  const movieAudio =
    document.querySelector<HTMLAudioElement>("#channel-movie-audio");
  const playerStage = document.querySelector<HTMLElement>("#player-stage");
  const connectionProgress =
    document.querySelector<HTMLElement>("#session-connection-progress");
  const connectionTitle =
    document.querySelector<HTMLElement>("#session-connection-title");
  const connectionPresence = connectionProgress
    ? new PresenceController(connectionProgress, {
        enter: [
          {
            opacity: 0,
            transform: "translate(-50%, calc(-50% + 8px)) scale(0.99)",
          },
          { opacity: 1, transform: "translate(-50%, -50%)" },
        ],
        exit: [
          { opacity: 1, transform: "translate(-50%, -50%)" },
          {
            opacity: 0,
            transform: "translate(-50%, calc(-50% - 3px)) scale(0.995)",
          },
        ],
      })
    : undefined;
  if (video && playerStage) {
    ambientLight = new AmbientLightController(video, playerStage);
    ambientLight.start();
  }
  const emptyState = document.querySelector<HTMLElement>("#channel-empty");
  const bufferingState =
    document.querySelector<HTMLElement>("#channel-buffering");
  const bufferingTitle =
    document.querySelector<HTMLElement>("#buffering-title");
  const bufferingProgress =
    document.querySelector<HTMLProgressElement>("#buffering-progress");
  const retryButton =
    document.querySelector<HTMLButtonElement>("#retry-watch");
  const fullscreenButton =
    document.querySelector<HTMLButtonElement>("#dock-fullscreen");
  const soundButton =
    document.querySelector<HTMLButtonElement>("#enable-sound");
  const movieVolumeControl =
    document.querySelector<HTMLElement>("#movie-volume-control");
  const movieVolumeInput =
    document.querySelector<HTMLInputElement>("#dock-volume");
  const movieVolumeValue =
    document.querySelector<HTMLOutputElement>("#movie-volume-value");
  const stageDock =
    document.querySelector<HTMLElement>("#stage-dock");
  const dockMoreButton =
    document.querySelector<HTMLButtonElement>("#dock-more");
  const dockMoreMenu =
    document.querySelector<HTMLElement>("#dock-more-menu");
  const playbackDiagnosticsDialog =
    document.querySelector<HTMLDialogElement>(
      "#playback-diagnostics-dialog",
    );
  const embyItemPopup =
    document.querySelector<HTMLElement>("#emby-item-popup");
  const embyDetailPresence = embyItemPopup
    ? new PresenceController(embyItemPopup, {
        enter: [
          { opacity: 0, transform: "translateX(18px)" },
          { opacity: 1, transform: "none" },
        ],
        exit: [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateX(10px)" },
        ],
      })
    : undefined;
  let embyDetailOpener: HTMLElement | undefined;
  const dockChatButton =
    document.querySelector<HTMLButtonElement>("#dock-chat");
  const dockChatComposer =
    document.querySelector<HTMLFormElement>("#dock-chat-composer");
  const dockChatInput =
    document.querySelector<HTMLInputElement>("#dock-chat-input");
  const dockChatPresence = dockChatComposer
    ? new PresenceController(dockChatComposer, {
        enter: [
          {
            opacity: 0,
            transform: "translateX(-50%) translateY(8px) scale(0.98)",
          },
          {
            opacity: 1,
            transform: "translateX(-50%) translateY(0) scale(1)",
          },
        ],
        exit: [
          {
            opacity: 1,
            transform: "translateX(-50%) translateY(0) scale(1)",
          },
          {
            opacity: 0,
            transform: "translateX(-50%) translateY(4px) scale(0.99)",
          },
        ],
      })
    : undefined;
  const stageProgress =
    document.querySelector<HTMLElement>("#stage-progress");
  const progressBuffer =
    document.querySelector<HTMLElement>("#progress-buffer");
  const progressFill =
    document.querySelector<HTMLElement>("#progress-fill");
  const progressThumb =
    document.querySelector<HTMLElement>("#progress-thumb");
  const progressTooltip =
    document.querySelector<HTMLElement>("#progress-tooltip");
  let progressScrubPointerId: number | undefined;
  let progressScrubRatio = 0;
  let suppressProgressClick = false;
  const dockTime =
    document.querySelector<HTMLElement>("#dock-time");
  const receiverQuality =
    document.querySelector<HTMLElement>("#receiver-quality");
  const viewerResolutionSelect =
    document.querySelector<HTMLSelectElement>("#viewer-resolution");
  const viewerFrameRateSelect =
    document.querySelector<HTMLSelectElement>("#viewer-frame-rate");
  const receiverCapability =
    document.querySelector<HTMLElement>("#receiver-capability");
  const receiverStreamBadge =
    document.querySelector<HTMLElement>("#receiver-stream-badge");
  const pictureSettingsButton =
    document.querySelector<HTMLButtonElement>("#dock-quality");
  const pictureDialog =
    document.querySelector<HTMLDialogElement>("#picture-dialog");
  const embySettingsButton =
    document.querySelector<HTMLButtonElement>("#dock-emby-settings");
  const embySettingsDialog =
    document.querySelector<HTMLDialogElement>("#emby-settings-dialog");
  const pictureSourceSummary =
    document.querySelector<HTMLElement>("#picture-source-summary");
  const mobilePlaybackStats =
    document.querySelector<HTMLOutputElement>("#mobile-playback-stats");
  const desktopPlaybackStats =
    document.querySelector<HTMLOutputElement>("#desktop-playback-stats");
  const smartCropButton =
    document.querySelector<HTMLButtonElement>("#dock-smart-crop");
  const pictureInPictureButton =
    document.querySelector<HTMLButtonElement>("#dock-pip");
  const mobileGestureHud =
    document.querySelector<HTMLElement>("#mobile-gesture-hud");
  const mobileGestureValue =
    document.querySelector<HTMLElement>("#mobile-gesture-value");
  const highlightCorrectionInput =
    document.querySelector<HTMLInputElement>("#highlight-correction");
  const videoEnhancementInput =
    document.querySelector<HTMLInputElement>("#video-enhancement");
  const videoEnhancementStatus =
    document.querySelector<HTMLElement>("#video-enhancement-status");
  const videoEnhancementCanvas =
    document.querySelector<HTMLCanvasElement>("#video-enhancement-canvas");
  const videoEnhancementSubtitles =
    document.querySelector<HTMLElement>("#video-enhancement-subtitles");
  const broadcastButton =
    document.querySelector<HTMLButtonElement>("#broadcast-action");
  const stageStartButton =
    document.querySelector<HTMLButtonElement>("#stage-start-broadcast");
  const stageDanmakuElement =
    document.querySelector<HTMLElement>("#stage-danmaku");
  if (!stageDanmakuElement) {
    throw new Error("弹幕图层尚未准备好");
  }
  const danmakuSurface = stageDanmakuElement;
  const stageDanmaku = new DanmakuOverlay(danmakuSurface);
  let videoEnhancement: VideoEnhancementController | undefined;
  let videoEnhancementAdaptivePressure:
    | "healthy"
    | "decoder-limited"
    | "render-limited"
    | "encoder-limited" = "healthy";
  if (
    desktop &&
    video &&
    playerStage &&
    videoEnhancementCanvas &&
    videoEnhancementSubtitles
  ) {
    videoEnhancement = new VideoEnhancementController({
      video,
      canvas: videoEnhancementCanvas,
      stage: playerStage,
      subtitleLayer: videoEnhancementSubtitles,
      getFitMode: () =>
        isImmersivePlayback() ? fullscreenFit : "contain",
      onDiagnostic: reportPlaybackDiagnostic,
    });
    videoEnhancement.setPreference(videoEnhancementPreference);
    const capabilities = detectEmbyMediaCapabilities();
    const supported = capabilities.videoEnhancementBackends.includes(
      "webgl2-spatial",
    );
    if (videoEnhancementInput) {
      videoEnhancementInput.disabled = !supported;
      videoEnhancementInput.title = supported
        ? "自动使用通用 WebGL2 空间增强"
        : "当前图形驱动不支持 WebGL2 增强后端";
    }
    videoEnhancement.addEventListener("statechange", (event) => {
      const state = (event as CustomEvent<VideoEnhancementState>).detail;
      if (!videoEnhancementStatus) return;
      if (state.active) {
        videoEnhancementStatus.textContent =
          `WebGL2 空间增强已开启 · ${state.sourceWidth}×${state.sourceHeight}` +
          ` → ${state.outputWidth}×${state.outputHeight}`;
        videoEnhancementStatus.dataset.tone = "active";
        return;
      }
      delete videoEnhancementStatus.dataset.tone;
      if (
        state.reason === "render-budget" ||
        state.reason === "dropped-frames" ||
        state.reason === "resource-pressure" ||
        state.reason === "cooldown"
      ) {
        videoEnhancementStatus.textContent =
          "检测到 GPU、渲染或解码压力，已自动暂停增强；稳定 30 秒后重试。";
      } else if (state.reason === "hdr-unsupported") {
        videoEnhancementStatus.textContent =
          "HDR 视频保持原生色彩路径，不经过当前 SDR 空间增强后端。";
      } else if (state.reason === "backend-unavailable") {
        videoEnhancementStatus.textContent =
          "当前图形驱动不支持通用 WebGL2 空间增强。";
      } else if (state.reason === "preference-off") {
        videoEnhancementStatus.textContent = "GPU 清晰增强已手动关闭。";
      } else {
        videoEnhancementStatus.textContent =
          "仅在远端 Emby 360p–1080p、输出接近 2K/4K 且 GPU 有余量时自动开启。";
      }
    });
  }
  resourceBudgetMonitor.addEventListener("change", (event) => {
    resourceBudget = (
      event as CustomEvent<typeof resourceBudget>
    ).detail;
    reportPlaybackDiagnostic("resource-budget-changed", {
      pressure: resourceBudget.pressure,
      reason: resourceBudget.reason,
      allowGpuEnhancement: resourceBudget.allowGpuEnhancement,
      allowDeepPrefetch: resourceBudget.allowDeepPrefetch,
      maxConcurrentProducers: resourceBudget.maxConcurrentProducers,
      maxSfuLayers: resourceBudget.maxSfuLayers,
      maxP2pFallbacks: resourceBudget.maxP2pFallbacks,
    });
    syncVideoEnhancement();
    rebalanceScreenP2pFallbackBudgets();
    updateEmbySegmentRenditionDemand();
    if (
      broadcasterId === selfId &&
      broadcastCapabilities?.mode !== "emby" &&
      mediaStream
    ) {
      void publishBroadcastToSfu().catch(() => undefined);
    }
  });
  void resourceBudgetMonitor.start().catch(() => undefined);

  const connectionSteps = [
    "server",
    "room",
    "members",
    "media",
  ] as const;
  type ConnectionStep = (typeof connectionSteps)[number];

  function setConnectionStep(
    active: ConnectionStep,
    title: string,
  ): void {
    if (connectionTitle) connectionTitle.textContent = title;
    const activeIndex = connectionSteps.indexOf(active);
    connectionSteps.forEach((step, index) => {
      const item = document.querySelector<HTMLElement>(
        `[data-connection-step="${step}"]`,
      );
      if (!item) return;
      item.dataset.state =
        index < activeIndex
          ? "complete"
          : index === activeIndex
            ? "active"
            : "pending";
      const icon = item.querySelector<HTMLElement>("[data-lucide]");
      if (icon) {
        icon.dataset.lucide = index < activeIndex ? "check" : "circle";
      }
    });
    hydrateIcons(connectionProgress || root);
  }

  async function finishConnectionProgress(): Promise<void> {
    if (connectionProgressDelay !== undefined) {
      window.clearTimeout(connectionProgressDelay);
      connectionProgressDelay = undefined;
    }
    connectionSteps.forEach((step) => {
      const item = document.querySelector<HTMLElement>(
        `[data-connection-step="${step}"]`,
      );
      if (item) item.dataset.state = "complete";
      const icon = item?.querySelector<HTMLElement>("[data-lucide]");
      if (icon) icon.dataset.lucide = "check";
    });
    hydrateIcons(connectionProgress || root);
    if (connectionTitle) connectionTitle.textContent = "频道已同步";
    if (connectionProgress && !connectionProgress.hidden) {
      await connectionPresence?.hide(sessionUiAbortController.signal);
    }
  }

  connectionProgressDelay = window.setTimeout(() => {
    connectionProgressDelay = undefined;
    if (!joined && !leaving) {
      void connectionPresence?.show(sessionUiAbortController.signal);
    }
  }, 900);

  function renderLobbyParticipants(
    nextParticipants: RoomParticipant[] = [...participants.values()],
    speakingLevels: ReadonlyMap<string, number> = new Map(),
  ): void {
    const list =
      document.querySelector<HTMLElement>("#lobby-participants");
    const summary =
      document.querySelector<HTMLElement>("#lobby-participant-summary");
    const voiceSummary =
      document.querySelector<HTMLElement>("#lobby-voice-summary");
    if (!list) return;
    const sorted = [...nextParticipants].sort((left, right) => {
      if (left.role !== right.role) return left.role === "host" ? -1 : 1;
      return left.nickname.localeCompare(right.nickname, "zh-CN");
    });
    const existing = new Map(
      [...list.querySelectorAll<HTMLElement>("[data-lobby-participant]")].map(
        (element) => [
          element.dataset.lobbyParticipant as string,
          element,
        ],
      ),
    );
    list.querySelectorAll(":scope > :not([data-lobby-participant])")
      .forEach((element) => element.remove());
    sorted.slice(0, 8).forEach((participant, index) => {
      let avatar = existing.get(participant.id);
      const isNew = !avatar;
      if (!avatar) {
        avatar = document.createElement("span");
        avatar.className = "lobby-avatar";
        avatar.dataset.lobbyParticipant = participant.id;
      }
      avatar.textContent = Array.from(participant.nickname)[0] || "友";
      avatar.title =
        `${participant.nickname} · ${
          participant.broadcasting
            ? "正在放映"
            : participant.voiceActive
              ? "已连麦"
              : participant.role === "host"
                ? "频道主"
                : "在频道中"
        }`;
      avatar.classList.toggle("is-voice-active", participant.voiceActive);
      avatar.classList.toggle(
        "is-speaking",
        speakingLevels.has(participant.id),
      );
      const level = speakingLevels.get(participant.id) || 0;
      avatar.dataset.speakingLevel =
        level >= 0.16 ? "high" : level >= 0.07 ? "medium" : "low";
      list.append(avatar);
      existing.delete(participant.id);
      if (isNew && index < 8) {
        void animateElement(
          avatar,
          [
            { opacity: 0, transform: "translateY(8px) scale(0.96)" },
            { opacity: 1, transform: "none" },
          ],
          {
            kind: "control",
            id: `lobby-${participant.id}`,
            signal: sessionUiAbortController.signal,
          },
        );
      }
    });
    existing.forEach((element) => element.remove());
    if (summary) {
      summary.textContent =
        sorted.length > 0
          ? `${sorted.length} 位朋友已经在这里`
          : "正在同步频道成员…";
    }
    if (voiceSummary) {
      const active = sorted
        .filter((participant) => participant.voiceActive)
        .map((participant) => participant.nickname);
      voiceSummary.textContent =
        active.length > 0
          ? `当前正在连麦：${active.join("、")}`
          : "还没有人加入连麦";
    }
  }

  function openDialog(dialog: HTMLDialogElement): void {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    void dialogController.open(dialog, opener);
  }

  function closeDialog(dialog: HTMLDialogElement): void {
    void dialogController.close(dialog);
  }

  function hideControls(): void {
    if (!stageDock || stageDock.hidden) return;
    if (
      stageDock.querySelector(":focus-visible") ||
      (dockChatComposer && !dockChatComposer.hidden) ||
      dockMoreButton?.getAttribute("aria-expanded") === "true" ||
      (video && !video.hidden && video.paused) ||
      (bufferingState && !bufferingState.hidden)
    ) {
      window.clearTimeout(dockHideTimer);
      dockHideTimer = window.setTimeout(hideControls, IDLE_HIDE_MS);
      return;
    }
    stageDock.classList.add("is-hidden", "material-released");
    document
      .getElementById("hud-bar")
      ?.classList.add("is-hidden", "material-released");
    stageProgress?.classList.add("is-hidden");
    if (nativeAndroid && mobilePlaybackStats) {
      mobilePlaybackStats.hidden = true;
    }
    if (isImmersivePlayback()) {
      document.body.classList.add("fullscreen-controls-hidden");
    }
  }

  function showControlsWithGlass(): void {
    document.body.classList.remove("fullscreen-controls-hidden");
    stageDock?.classList.remove("is-hidden", "material-released");
    document
      .getElementById("hud-bar")
      ?.classList.remove("is-hidden", "material-released");
    stageProgress?.classList.remove("is-hidden");
    if (
      nativeAndroid &&
      mobilePlaybackStats?.dataset.available === "true" &&
      !video?.hidden
    ) {
      mobilePlaybackStats.hidden = false;
    }
    window.clearTimeout(dockHideTimer);
    if (
      document.body.classList.contains("mode-theater") ||
      document.body.classList.contains("mode-immersive")
    ) {
      dockHideTimer = window.setTimeout(hideControls, IDLE_HIDE_MS);
    }
  }

  const passiveUiListener = {
    passive: true,
    signal: sessionUiAbortController.signal,
  };
  document.addEventListener(
    "mousemove",
    showControlsWithGlass,
    passiveUiListener,
  );
  document.addEventListener(
    "keydown",
    showControlsWithGlass,
    passiveUiListener,
  );
  stageDock?.addEventListener("pointerdown", showControlsWithGlass, {
    passive: true,
    signal: sessionUiAbortController.signal,
  });
  stageProgress?.addEventListener("pointerdown", showControlsWithGlass, {
    passive: true,
    signal: sessionUiAbortController.signal,
  });
  if (dockMoreButton && dockMoreMenu) {
    dockMoreSurface = new FloatingSurface(dockMoreButton, dockMoreMenu, {
      placement: "top-end",
      closeOnOutside: true,
    });
    dockMoreButton.addEventListener(
      "click",
      () => {
        showControlsWithGlass();
        void dockMoreSurface?.toggle();
      },
      { signal: sessionUiAbortController.signal },
    );
  }
  if (!nativeAndroid) {
    document.addEventListener(
      "touchstart",
      showControlsWithGlass,
      passiveUiListener,
    );
  }

  function syncStageDanmakuBounds(): void {
    if (!playerStage || !danmakuSurface.isConnected) return;
    if (!broadcasterId) {
      danmakuSurface.style.top = "0px";
      danmakuSurface.style.bottom = "0px";
      return;
    }
    const bounds = playerStage.getBoundingClientRect();
    danmakuSurface.style.top = `${Math.max(0, bounds.top)}px`;
    danmakuSurface.style.bottom = `${Math.max(
      0,
      window.innerHeight - bounds.bottom,
    )}px`;
  }
  window.requestAnimationFrame(syncStageDanmakuBounds);

  function syncDesktopDanmaku(): void {
    const active =
      danmakuEnabled &&
      shouldEnableDesktopDanmaku({
        desktop,
        broadcasterId,
      });
    window.roomDesktop?.setDesktopDanmakuActive(active);
    const state = document.querySelector<HTMLElement>(
      "#danmaku-surface-state",
    );
    if (state) {
      state.hidden = !desktop;
      state.textContent = active
        ? "光影交织，共此时光"
        : broadcasterId === selfId
          ? "弹幕显示在放映窗口"
          : broadcasterId
            ? "弹幕显示在观看画面"
            : "光影交织，共此时光";
      state.classList.toggle("active", active);
    }
  }

  function setSignalStatus(
    state: "connecting" | "connected" | "reconnecting" | "lost",
    text?: string,
    reconnectable = state === "lost",
  ): void {
    const dot = document.getElementById("hud-signal-dot");
    const label = document.getElementById("hud-signal-text");
    const track = document.getElementById("hud-signal");
    if (!dot || !label || !track) return;
    dot.className =
      "dot" +
      (state === "connected"
        ? " is-live"
        : state === "reconnecting"
          ? " is-warn"
          : state === "lost"
            ? " is-danger"
            : "");
    const nextText =
      text ??
      {
        connecting: "连接中",
        connected: "已连接",
        reconnecting: "重连中",
        lost: "服务器断开",
      }[state];
    label.textContent = nextText;
    track.dataset.reconnectable = String(reconnectable);
    track.setAttribute("aria-label", `信令服务器状态：${nextText}`);
    track.title = reconnectable ? "点击立即重新连接服务器" : nextText;
  }

  function setMediaStatus(text: string, warn = false): void {
    const label = document.getElementById("hud-media-text");
    if (!label) return;
    label.style.color = warn ? "var(--warn-text)" : "";
    label.textContent = text;
    label.title = text;
    label.parentElement?.setAttribute("aria-label", `播放状态：${text}`);
  }

  function setVoiceStatus(active: boolean, count: number): void {
    const meter = document.getElementById("hud-voice-meter");
    const label = document.getElementById("hud-voice-text");
    if (!meter || !label) return;
    meter.classList.toggle("is-active", active);
    label.textContent =
      count > 0 ? `${count} 人在麦` : active ? "连麦中" : "未连麦";
    label.title = label.textContent;
  }

  /**
   * Compatibility router for legacy media call sites. Signal state is kept
   * isolated from playback and chat so one track can never overwrite another.
   */
  function setStatus(
    text: string,
    tone: "ready" | "error" | "neutral" = "neutral",
    reconnectable = false,
  ): void {
    if (
      signalUnavailable &&
      !reconnectable &&
      !text.includes("服务器") &&
      !text.includes("重连") &&
      !text.includes("网络已切换")
    ) {
      return;
    }
    const signalRelated =
      reconnectable ||
      /(服务器|信令|重连|网络已|网络路由|网络断开|频道在线|频道已恢复)/.test(
        text,
      );
    if (signalRelated) {
      const state =
        tone === "error"
          ? "lost"
          : tone === "ready"
            ? "connected"
            : /(重连|恢复|连接中|正在)/.test(text)
              ? "reconnecting"
              : "connected";
      setSignalStatus(state, text, reconnectable);
      return;
    }
    setMediaStatus(text, tone === "error");
  }

  function safeSignalSend(message: SignalEnvelope): boolean {
    const activeSignal = signal;
    if (!activeSignal) return false;
    try {
      activeSignal.send(message);
      return true;
    } catch {
      return false;
    }
  }

  function boundedRtcOperation<T>(
    operation: Promise<T>,
    timeoutMessage: string,
    timeoutMs = RTC_NEGOTIATION_TIMEOUT_MS,
  ): Promise<T> {
    return boundedUiOperation(operation, timeoutMs, timeoutMessage);
  }

  function clearSignalReconnectTimer(): void {
    if (signalReconnectTimer !== undefined) {
      window.clearTimeout(signalReconnectTimer);
      signalReconnectTimer = undefined;
    }
  }

  function clearChannelJoinAckTimer(): void {
    if (channelJoinAckTimer !== undefined) {
      window.clearTimeout(channelJoinAckTimer);
      channelJoinAckTimer = undefined;
    }
  }

  function sendChannelJoin(): void {
    clearChannelJoinAckTimer();
    safeSignalSend({
      type: "channel:join",
      room,
      nickname,
      channelName,
      canBroadcast: desktop,
      createIfMissing,
      ownerToken,
      resumeToken,
      embyCapabilities: detectEmbyMediaCapabilities(),
    });
    channelJoinAckTimer = window.setTimeout(() => {
      channelJoinAckTimer = undefined;
      if (joined || leaving) return;
      signalUnavailable = true;
      setStatus("频道恢复响应超时 · 正在重新连接", "error", true);
      scheduleSignalReconnect(true);
    }, 12_000);
  }

  function scheduleSignalReconnect(immediate = false): void {
    if (leaving || signalReconnectInFlight) return;
    clearSignalReconnectTimer();
    const delay = immediate
      ? 0
      : Math.min(15_000, 900 * 2 ** Math.min(signalReconnectAttempt, 4));
    if (delay) {
      setStatus(
        `服务器已断开 · ${Math.ceil(delay / 1_000)} 秒后重连`,
        "error",
        true,
      );
    }
    signalReconnectTimer = window.setTimeout(() => {
      signalReconnectTimer = undefined;
      void reconnectSignal();
    }, delay);
  }

  async function reconnectSignal(): Promise<void> {
    if (leaving || signalReconnectInFlight || !signal) return;
    clearSignalReconnectTimer();
    signalReconnectInFlight = true;
    signalReconnectAttempt += 1;
    let retry = false;
    setStatus(
      `正在重连服务器 · 第 ${signalReconnectAttempt} 次`,
      "neutral",
    );
    try {
      await signal.reconnect();
      if (leaving) return;
      sendChannelJoin();
      setStatus("服务器已连接 · 正在恢复频道", "neutral");
    } catch {
      retry = !leaving;
    } finally {
      signalReconnectInFlight = false;
    }
    if (retry) scheduleSignalReconnect(false);
  }

  async function recoverAfterNetworkChange(): Promise<void> {
    if (leaving || !signal || signalReconnectInFlight) return;
    clearSignalReconnectTimer();
    signalReconnectInFlight = true;
    forceMediaRenegotiationAfterReconnect = true;
    localDirectAddresses = desktop
      ? localDirectAddresses
      : await getNativeLocalAddresses();
    resumeBroadcastAfterReconnect ||= Boolean(
      embyBroadcast?.active ||
        mediaStream
          ?.getVideoTracks()
          .some((track) => track.readyState === "live"),
    );
    resumeVoiceAfterReconnect ||= companion?.voiceActive || false;
    joined = false;
    updateBroadcastControls();
    let retry = false;
    try {
      await signal.reconnect();
      if (leaving) return;
      sendChannelJoin();
      setStatus("网络已切换 · 正在恢复频道", "neutral");
    } catch {
      retry = !leaving;
    } finally {
      signalReconnectInFlight = false;
    }
    if (retry) scheduleSignalReconnect(true);
  }

  function handleBrowserOnline(): void {
    clearSfuPrimaryRecovery();
    if (networkChangeDebounceTimer !== undefined) {
      window.clearTimeout(networkChangeDebounceTimer);
    }
    forceNextNetworkProbe = true;
    networkChangeDebounceTimer = window.setTimeout(() => {
      networkChangeDebounceTimer = undefined;
      void recoverAfterNetworkChange();
    }, 450);
  }

  function handleBrowserOffline(): void {
    signalUnavailable = true;
    setStatus("当前网络已断开 · 恢复后自动重连", "error", true);
  }

  function handleVisibilityRecovery(): void {
    if (document.visibilityState !== "visible" || leaving) return;
    if (!signal?.connected || signalUnavailable) {
      scheduleSignalReconnect(true);
    } else if (
      broadcasterId &&
      broadcasterId !== selfId &&
      (!watcherPc ||
        ["failed", "disconnected"].includes(watcherPc.connectionState))
    ) {
      watchAttempts = 0;
      void beginWatching(true);
    }
  }

  async function pollDesktopNetworkRoute(): Promise<void> {
    if (
      desktopNetworkPollRunning ||
      !desktop ||
      !window.roomDesktop ||
      leaving
    ) {
      return;
    }
    desktopNetworkPollRunning = true;
    try {
      const network = await boundedUiOperation(
        window.roomDesktop.getNetworkInfo(),
        3_000,
        "读取桌面网络信息超时",
      );
      const signature = JSON.stringify({
        addresses: [...network.lanAddresses].sort(),
        tunnels: [...network.virtualInterfaces].sort(),
      });
      localDirectAddresses = network.lanAddresses;
      if (!desktopNetworkSignature) {
        desktopNetworkSignature = signature;
        return;
      }
      if (signature === desktopNetworkSignature) return;
      desktopNetworkSignature = signature;
      setStatus("检测到网络路由变化 · 正在恢复", "neutral");
      handleBrowserOnline();
    } catch {
      // The browser online/offline events and clickable status remain active.
    } finally {
      desktopNetworkPollRunning = false;
    }
  }

  function formatPlaybackTime(seconds: number): string {
    const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const hours = Math.floor(safe / 3_600);
    const minutes = Math.floor((safe % 3_600) / 60);
    const remainingSeconds = Math.floor(safe % 60);
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(
          remainingSeconds,
        ).padStart(2, "0")}`
      : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  function syncMovieVolumeUi(): void {
    const percent = Math.round(movieVolume * 100);
    if (movieVolumeInput) movieVolumeInput.value = String(movieVolume);
    if (movieVolumeValue) movieVolumeValue.textContent = `${percent}%`;
  }

  function resetNativeMovieAudio(): void {
    nativeMovieAudioNeedsGesture = false;
    lastNativeMovieAudioRestartAt = 0;
    if (!movieAudio) return;
    movieAudio.pause();
    movieAudio.srcObject = null;
    movieAudio.removeAttribute("src");
    movieAudio.load();
  }

  function nativeMovieAudioIsAudible(): boolean {
    return Boolean(
      movieAudio &&
        movieAudio.srcObject &&
        !movieAudio.muted &&
        movieAudio.volume > 0 &&
        !movieAudio.paused &&
        movieAudio.readyState >= HTMLMediaElement.HAVE_METADATA,
    );
  }

  async function playNativeMovieAudio(
    forceReattach = false,
  ): Promise<boolean> {
    if (
      !nativeAndroid ||
      !movieAudio ||
      !video ||
      !broadcasterId ||
      broadcasterId === selfId ||
      broadcastCapabilities?.mode === "emby"
    ) {
      return false;
    }
    const liveTracks = remoteStream
      .getAudioTracks()
      .filter((track) => track.readyState === "live");
    if (!liveTracks.length) return false;
    const current = movieAudio.srcObject;
    const currentTrackIds =
      current instanceof MediaStream
        ? current
            .getAudioTracks()
            .filter((track) => track.readyState === "live")
            .map((track) => track.id)
            .sort()
            .join("|")
        : "";
    const nextTrackIds = liveTracks
      .map((track) => track.id)
      .sort()
      .join("|");
    if (forceReattach || currentTrackIds !== nextTrackIds) {
      movieAudio.srcObject = new MediaStream(liveTracks);
    }
    // Android WebView can report the video element as "playing" while a late
    // WebRTC audio track remains silent. Keep movie audio on a dedicated media
    // element, matching the resilient playout path used by voice chat.
    video.muted = true;
    movieAudio.autoplay = true;
    movieAudio.muted = movieVolume <= 0;
    movieAudio.volume = movieVolume;
    if (movieVolume <= 0) {
      nativeMovieAudioNeedsGesture = false;
      return true;
    }
    try {
      await movieAudio.play();
      nativeMovieAudioNeedsGesture = false;
      soundEnabled = true;
      if (soundButton) soundButton.hidden = true;
      return nativeMovieAudioIsAudible();
    } catch {
      nativeMovieAudioNeedsGesture = true;
      soundEnabled = false;
      if (soundButton) {
        soundButton.hidden = false;
        soundButton.textContent = "点击开启影片声音";
      }
      return false;
    }
  }

  function applyMovieVolume(value: number, persist = true): void {
    movieVolume = Math.max(0, Math.min(1, Number(value) || 0));
    playbackControlState.volume = movieVolume;
    if (movieVolume > 0) lastAudibleMovieVolume = movieVolume;
    if (persist) {
      localStorage.setItem("synced:movie-volume", String(movieVolume));
      localStorage.setItem(
        "synced:movie-muted-explicit",
        String(movieVolume <= 0),
      );
    }
    if (video && broadcasterId !== selfId) {
      video.volume = movieVolume;
      // Android screen sharing plays its late WebRTC audio track through the
      // dedicated <audio> element. Emby is a muxed MSE stream, so muting the
      // <video> here silences its only audio path.
      video.muted =
        movieVolume <= 0 ||
        (nativeAndroid && broadcastCapabilities?.mode !== "emby");
      soundEnabled = movieVolume > 0;
      if (soundEnabled && video.paused) void video.play().catch(() => undefined);
    }
    if (
      nativeAndroid &&
      movieAudio &&
      broadcasterId !== selfId &&
      broadcastCapabilities?.mode !== "emby"
    ) {
      movieAudio.volume = movieVolume;
      movieAudio.muted = movieVolume <= 0;
      nativeMovieAudioNeedsGesture = false;
      if (movieVolume > 0) void playNativeMovieAudio();
    }
    if (soundButton) soundButton.hidden = soundEnabled;
    syncMovieVolumeUi();
  }

  function updateEmbyViewerTimeline(): void {
    if (
      !stageProgress ||
      !progressFill ||
      !dockTime ||
      broadcastCapabilities?.mode !== "emby"
    ) {
      if (stageProgress) stageProgress.hidden = true;
      if (dockTime) dockTime.textContent = "";
      return;
    }
    const plannedDuration =
      Number(embyViewer?.activeSession?.plan.runtimeTicks) / 10_000_000;
    const duration =
      Number.isFinite(plannedDuration) && plannedDuration > 0
        ? plannedDuration
        : video && Number.isFinite(video.duration)
          ? video.duration
          : 0;
    const current = Math.max(0, video?.currentTime || 0);
    const percent =
      duration > 0 ? Math.max(0, Math.min(100, current / duration * 100)) : 0;
    const bufferedPercent =
      duration > 0
        ? Math.max(
            percent,
            Math.min(100, (current + (embyViewer?.bufferedAhead || 0)) / duration * 100),
          )
        : percent;
    stageProgress.hidden = false;
    if (progressScrubPointerId !== undefined) return;
    progressFill.style.width = `${percent.toFixed(2)}%`;
    if (progressThumb) progressThumb.style.left = `${percent.toFixed(2)}%`;
    if (progressBuffer) {
      progressBuffer.style.width = `${bufferedPercent.toFixed(2)}%`;
    }
    stageProgress.setAttribute("aria-valuenow", percent.toFixed(1));
    stageProgress.setAttribute(
      "aria-valuetext",
      `${formatPlaybackTime(current)} / ${
        duration > 0 ? formatPlaybackTime(duration) : "--:--"
      }`,
    );
    dockTime.textContent = `${formatPlaybackTime(current)} / ${
      duration > 0 ? formatPlaybackTime(duration) : "--:--"
    }`;
  }

  async function updateDisplayFrameRateLimits(): Promise<void> {
    if (!window.roomDesktop) return;
    try {
      const display = await boundedUiOperation(
        window.roomDesktop.getDisplayInfo(),
        3_000,
        "读取显示器信息超时",
      );
      document
        .querySelectorAll<HTMLButtonElement>("[data-session-frame-rate]")
        .forEach((button) => {
          const option = Number(button.dataset.sessionFrameRate);
          button.disabled = option > display.refreshRate;
          button.title = button.disabled
            ? `超过本机屏幕 ${display.refreshRate} Hz 刷新率`
            : "";
        });
    } catch {
      // Keep every frame-rate choice available when display inspection is
      // unavailable. The capture layer still clamps unsupported values.
    }
  }

  function normalizeBroadcastCapabilities(
    value: BroadcastCapabilities | undefined,
  ): BroadcastCapabilities | undefined {
    if (
      !value ||
      !Number.isFinite(value.width) ||
      !Number.isFinite(value.height) ||
      !Number.isFinite(value.frameRate) ||
      value.width < 1 ||
      value.height < 1 ||
      value.frameRate < 1
    ) {
      return undefined;
    }
    const normalized: BroadcastCapabilities = {
      width: Math.round(value.width),
      height: Math.round(value.height),
      frameRate: Math.round(value.frameRate),
      mode: value.mode === "emby" ? "emby" : "screen",
      contentMode:
        value.contentMode === "detail" ||
        value.contentMode === "motion" ||
        value.contentMode === "balanced"
          ? value.contentMode
          : value.mode === "emby"
            ? "motion"
            : "balanced",
    };
    if (normalized.mode === "emby") {
      normalized.mimeType = String(value.mimeType || "").slice(0, 180);
      normalized.videoCodec = String(value.videoCodec || "").slice(0, 32);
      normalized.audioCodec = String(value.audioCodec || "").slice(0, 32);
      normalized.title = String(value.title || "Emby 高清播放").slice(0, 300);
      normalized.bitrate = Number(value.bitrate) || undefined;
      normalized.durationTicks = Number(value.durationTicks) || undefined;
      normalized.allowOriginalRendition =
        value.allowOriginalRendition !== false;
      normalized.maxActiveRenditions = Math.max(
        1,
        Math.min(3, Math.round(Number(value.maxActiveRenditions) || 3)),
      );
    }
    return normalized;
  }

  function setBroadcastCapabilities(
    value: BroadcastCapabilities | undefined,
    resetViewerPreference = false,
  ): void {
    const previousMode = broadcastCapabilities?.mode;
    broadcastCapabilities = normalizeBroadcastCapabilities(value);
    if (previousMode !== broadcastCapabilities?.mode) {
      viewerBandwidthWarningShown = false;
      inboundSnapshot = undefined;
      embyDataSnapshot = undefined;
      embyFrameSnapshot = undefined;
      embyBufferedAhead = 0;
      embyStartupBufferProgressAt = 0;
      embyStartupLastBufferAhead = 0;
      embyHostPaused = false;
      embyHostPauseStateKnown = false;
    }
    if (resetViewerPreference) {
      preferredHeight = 0;
      preferredFrameRate = 0;
      lastSmartBars = undefined;
      smartBarSamples = [];
      smartCropCanvas = undefined;
      smartCropContext = undefined;
    }
    if (broadcastCapabilities && broadcastCapabilities.mode !== "emby") {
      adaptivePlayback.configure(
        broadcastCapabilities.height,
        preferredHeight || (nativeAndroid ? 720 : 0),
        !resetViewerPreference,
        {
          contentMode: broadcastCapabilities.contentMode,
          sourceWidth: broadcastCapabilities.width,
          sourceFrameRate: broadcastCapabilities.frameRate,
        },
      );
    } else {
      adaptivePlayback.configure(1);
    }
    if (viewerResolutionSelect) {
      const screenSfuMaximumHeight =
        broadcastCapabilities?.mode !== "emby" &&
        signalFeatures.has("sfu-primary")
          ? Math.min(1_440, broadcastCapabilities?.height || 1_440)
          : broadcastCapabilities?.height;
      for (const option of viewerResolutionSelect.options) {
        const height = Number(option.value);
        const embyMode = broadcastCapabilities?.mode === "emby";
        if (!height) {
          option.textContent = broadcastCapabilities
            ? `原画 · ${broadcastCapabilities.width}×${broadcastCapabilities.height}`
            : "原画";
        }
        option.disabled = Boolean(
          !embyMode &&
            height &&
            broadcastCapabilities &&
            height > (screenSfuMaximumHeight || broadcastCapabilities.height),
        );
        option.title = embyMode
          ? signalFeatures.has("emby-segment-relay-v1")
            ? "仅切换当前设备的 HTTPS ABR 档位，不影响其他观看端"
            : "兼容模式会请求放映端重建共享清晰度"
          : option.disabled
            ? signalFeatures.has("sfu-primary")
              ? `服务器多人主线最高稳定档为 ${screenSfuMaximumHeight || 1_440}p`
              : `超过放映端最高 ${broadcastCapabilities?.height || 0}p`
            : "";
      }
      if (
        preferredHeight &&
        broadcastCapabilities &&
        broadcastCapabilities.mode !== "emby" &&
        preferredHeight > broadcastCapabilities.height
      ) preferredHeight = 0;
      viewerResolutionSelect.value = String(preferredHeight);
    }
    if (viewerFrameRateSelect) {
      const screenSfuMaximumFrameRate =
        broadcastCapabilities?.mode !== "emby" &&
        signalFeatures.has("sfu-primary")
          ? Math.min(30, broadcastCapabilities?.frameRate || 30)
          : broadcastCapabilities?.frameRate;
      for (const option of viewerFrameRateSelect.options) {
        const optionFrameRate = Number(option.value);
        const embyMode = broadcastCapabilities?.mode === "emby";
        if (!optionFrameRate) {
          option.textContent = broadcastCapabilities
            ? `原帧率 · ${broadcastCapabilities.frameRate} 帧`
            : "原帧率";
        }
        option.disabled = Boolean(
          embyMode
            ? optionFrameRate > 60
            : optionFrameRate &&
                broadcastCapabilities &&
                optionFrameRate >
                  (screenSfuMaximumFrameRate ||
                    broadcastCapabilities.frameRate),
        );
        option.title = embyMode
          ? option.disabled
            ? "Emby 共享流最高支持 60 帧"
            : signalFeatures.has("emby-segment-relay-v1")
              ? "当前设备会独立选择可用的 CMAF 档位"
              : "兼容模式会请求放映端重建共享帧率"
          : option.disabled
            ? signalFeatures.has("sfu-primary")
              ? `服务器多人主线最高稳定档为 ${screenSfuMaximumFrameRate || 30} 帧`
              : `超过放映端最高 ${broadcastCapabilities?.frameRate || 0} 帧`
            : "";
      }
      if (
        preferredFrameRate &&
        broadcastCapabilities &&
        broadcastCapabilities.mode !== "emby" &&
        preferredFrameRate > broadcastCapabilities.frameRate
      ) preferredFrameRate = 0;
      viewerFrameRateSelect.value = String(preferredFrameRate);
    }
    const sourceLabel = broadcastCapabilities
      ? broadcastCapabilities.mode === "emby"
        ? `Emby · ${broadcastCapabilities.title || "高清播放"} · ${broadcastCapabilities.width}×${broadcastCapabilities.height}`
        : exactSourceLabel(
          broadcastCapabilities.width,
          broadcastCapabilities.height,
          broadcastCapabilities.frameRate,
        )
      : "等待放映画面";
    if (receiverCapability) {
      receiverCapability.hidden = !broadcastCapabilities;
      receiverCapability.textContent = broadcastCapabilities
        ? broadcastCapabilities.mode === "emby"
          ? signalFeatures.has("emby-segment-relay-v1")
            ? `HTTPS 多档 CMAF · ${broadcastCapabilities.videoCodec?.toUpperCase() || "H.264"} / ${broadcastCapabilities.audioCodec?.toUpperCase() || "AAC"}；当前设备独立 ABR、磁盘缓存与可选 GPU 增强，不影响其他观看端`
            : `兼容共享流 · ${broadcastCapabilities.videoCodec?.toUpperCase() || "H.264"} / ${broadcastCapabilities.audioCodec?.toUpperCase() || "AAC"}；画质变化需要放映端重建`
          : `可按网络状况手动降低；默认保持 ${sourceLabel}`
        : "";
    }
    if (pictureSourceSummary) {
      pictureSourceSummary.textContent = sourceLabel;
    }
    // Capabilities can arrive after the watcher stage has already been
    // revealed (for example after signaling recovery). Re-apply the saved
    // volume when the mode becomes known so an Android video that was
    // provisionally muted for WebRTC screen audio is immediately unmuted for
    // the muxed Emby MSE audio track.
    if (
      broadcastCapabilities &&
      broadcasterId &&
      broadcasterId !== selfId &&
      video &&
      !video.hidden
    ) {
      applyMovieVolume(movieVolume, false);
    }
    syncPlayerAspect();
    syncVideoEnhancement();
  }

  function syncPlayerAspect(): void {
    if (!playerStage) return;
    const width = video?.videoWidth || broadcastCapabilities?.width || 16;
    const height = video?.videoHeight || broadcastCapabilities?.height || 9;
    if (width > 0 && height > 0) {
      playerStage.style.setProperty("--stream-aspect", `${width} / ${height}`);
    }
    window.requestAnimationFrame(syncStageDanmakuBounds);
  }

  function applyHighlightCorrection(): void {
    const enabled = highlightCorrection && broadcasterId !== selfId;
    video?.classList.toggle(
      "highlight-correction",
      enabled,
    );
    videoEnhancementCanvas?.classList.toggle(
      "highlight-correction",
      enabled,
    );
  }

  function syncVideoEnhancement(): void {
    if (!videoEnhancement) return;
    const remoteEmbyVisible = Boolean(
      broadcastCapabilities?.mode === "emby" &&
        broadcasterId &&
        broadcasterId !== selfId &&
        video &&
        !video.hidden,
    );
    videoEnhancement.setPlaybackMode(
      remoteEmbyVisible ? "emby-viewer" : "off",
    );
    videoEnhancement.setPressure(
      remoteEmbyVisible
        ? resourceBudget.allowGpuEnhancement
          ? videoEnhancementAdaptivePressure
          : "render-limited"
        : "healthy",
    );
    videoEnhancement.refresh();
  }

  function syncVideoEnhancementPressure(
    pressure: AdaptivePressure,
  ): void {
    const next =
      pressure === "decoder-limited" ||
      pressure === "render-limited" ||
      pressure === "encoder-limited"
        ? pressure
        : "healthy";
    videoEnhancementAdaptivePressure = next;
    videoEnhancement?.setPressure(next);
  }

  function sampleEmbeddedBars():
    | { topRatio: number; bottomRatio: number }
    | undefined {
    if (
      !video ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !video.videoWidth ||
      !video.videoHeight
    ) {
      return undefined;
    }
    try {
      const width = 128;
      const height = Math.max(
        48,
        Math.min(96, Math.round((width * video.videoHeight) / video.videoWidth)),
      );
      smartCropCanvas ||= document.createElement("canvas");
      if (
        smartCropCanvas.width !== width ||
        smartCropCanvas.height !== height
      ) {
        smartCropCanvas.width = width;
        smartCropCanvas.height = height;
        smartCropContext = undefined;
      }
      if (smartCropContext === undefined) {
        smartCropContext = smartCropCanvas.getContext("2d", {
          alpha: false,
          willReadFrequently: true,
        });
      }
      const context = smartCropContext;
      if (!context) return undefined;
      context.drawImage(video, 0, 0, width, height);
      const frame = context.getImageData(0, 0, width, height);
      return measureEmbeddedHorizontalBars(frame);
    } catch {
      return undefined;
    }
  }

  function cacheSmartCropSample(): EmbeddedHorizontalBars | undefined {
    const bars = sampleEmbeddedBars();
    if (!bars) return undefined;
    smartBarSamples.push(bars);
    if (smartBarSamples.length > 6) {
      smartBarSamples.splice(0, smartBarSamples.length - 6);
    }
    const stable = stableEmbeddedHorizontalBars(smartBarSamples);
    if (stable) lastSmartBars = stable;
    return bars;
  }

  function warmSmartCropMeasurement(): void {
    if (
      fullscreenFit !== "smart" ||
      (!nativeAndroid && !isImmersivePlayback())
    ) {
      return;
    }
    for (const delay of [0, 70, 150]) {
      window.setTimeout(() => {
        if (!leaving && video && !video.hidden) {
          cacheSmartCropSample();
        }
      }, delay);
    }
  }

  function updateMobilePlayerButtons(): void {
    if (smartCropButton) {
      const enabled = fullscreenFit === "smart";
      smartCropButton.classList.toggle("is-on", enabled);
      smartCropButton.setAttribute("aria-pressed", String(enabled));
      smartCropButton.setAttribute(
        "aria-label",
        enabled ? "关闭智能裁剪" : "开启智能裁剪",
      );
    }
    if (fullscreenButton) {
      const fullscreen = isImmersivePlayback();
      fullscreenButton.setAttribute(
        "aria-pressed",
        String(fullscreen),
      );
      fullscreenButton.setAttribute(
        "aria-label",
        fullscreen ? "退出全屏" : "进入全屏",
      );
    }
  }

  function revealMobilePlayerControls(): void {
    if (!nativeAndroid || video?.hidden) return;
    showControlsWithGlass();
    updateMobilePlayerButtons();
  }

  function hideMobilePlayerControls(): void {
    hideControls();
  }

  function toggleMobilePlayerControls(): void {
    if (!stageDock || stageDock.hidden) return;
    if (stageDock.classList.contains("is-hidden")) {
      revealMobilePlayerControls();
    } else {
      hideMobilePlayerControls();
    }
  }

  function setMobileControlsAvailable(available: boolean): void {
    if (mobilePlaybackStats) {
      mobilePlaybackStats.dataset.available = String(available);
      mobilePlaybackStats.hidden = !available;
    }
  }

  function showMobileGestureHud(
    kind: "brightness" | "volume",
    value: number,
  ): void {
    if (!mobileGestureHud || !mobileGestureValue) return;
    if (mobileGestureHudTimer !== undefined) {
      window.clearTimeout(mobileGestureHudTimer);
      mobileGestureHudTimer = undefined;
    }
    mobileGestureHud.dataset.kind = kind;
    mobileGestureValue.textContent = `${Math.round(value * 100)}%`;
    mobileGestureHud.hidden = false;
  }

  function hideMobileGestureHudSoon(): void {
    if (!mobileGestureHud) return;
    if (mobileGestureHudTimer !== undefined) {
      window.clearTimeout(mobileGestureHudTimer);
    }
    mobileGestureHudTimer = window.setTimeout(() => {
      mobileGestureHudTimer = undefined;
      if (mobileGestureHud) mobileGestureHud.hidden = true;
    }, 650);
  }

  function schedulePlaybackControl(
    kind: "brightness" | "volume",
    value: number,
  ): void {
    pendingPlaybackControl = { kind, value };
    if (playbackControlFrame !== undefined) return;
    playbackControlFrame = window.requestAnimationFrame(() => {
      playbackControlFrame = undefined;
      const pending = pendingPlaybackControl;
      pendingPlaybackControl = undefined;
      if (!pending) return;
      if (pending.kind === "volume") {
        applyMovieVolume(pending.value);
        return;
      }
      const operation = setPlaybackBrightness(pending.value);
      void operation
        .then((state) => {
          playbackControlState = {
            ...state,
            volume: movieVolume,
          };
        })
        .catch(() => {
          // Brightness remains best effort; playback volume is application
          // local and was applied synchronously above.
        });
    });
  }

  function updateFullscreenFitUi(): void {
    document
      .querySelectorAll<HTMLButtonElement>("[data-fit-mode]")
      .forEach((button) => {
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.fitMode === fullscreenFit),
        );
      });
    smartCropButton?.classList.toggle("is-on", fullscreenFit === "smart");
    smartCropButton?.setAttribute(
      "aria-checked",
      String(fullscreenFit === "smart"),
    );
    smartCropButton?.setAttribute(
      "aria-label",
      fullscreenFit === "smart"
        ? "关闭智能裁剪"
        : "开启智能裁剪",
    );
    updateMobilePlayerButtons();
  }

  async function resolveFullscreenFit(): Promise<void> {
    if (!playerStage) return;
    const probeSequence = ++fullscreenFitProbeSequence;
    playerStage.dataset.fullscreenFit = "contain";
    playerStage.style.removeProperty("--smart-scale");
    playerStage.style.removeProperty("--smart-shift-y");
    updateFullscreenFitUi();
    if (fullscreenFit === "cover") {
      playerStage.dataset.fullscreenFit = "cover";
      return;
    }
    if (fullscreenFit !== "smart" || video?.hidden) return;

    const applyBars = (
      bars: EmbeddedHorizontalBars | undefined,
    ): boolean => {
      if (!video?.videoWidth || !video.videoHeight || !bars) return false;
      const crop = calculateCenteredSmartCrop({
        stageWidth: playerStage.clientWidth,
        stageHeight: playerStage.clientHeight,
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
        bars,
      });
      if (crop.scale <= 1) return false;
      playerStage.style.setProperty("--smart-scale", crop.scale.toFixed(4));
      playerStage.style.setProperty("--smart-shift-y", `${crop.shiftY}px`);
      playerStage.dataset.fullscreenFit = "smart";
      return true;
    };

    // Reuse the last stable measurement immediately after an orientation or
    // viewport change, then refresh it below. This avoids a visible jump back
    // to pillar-boxed playback while the phone finishes rotating.
    const appliedCached = applyBars(lastSmartBars);
    const immediate = cacheSmartCropSample();
    if (!appliedCached) applyBars(immediate);
    for (const delay of [36, 44, 52]) {
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, delay),
      );
      if (
        probeSequence !== fullscreenFitProbeSequence ||
        (!isImmersivePlayback() && !nativeAndroid)
      ) {
        return;
      }
      if (
        fullscreenFit === "smart" &&
        (nativeAndroid || isImmersivePlayback())
      ) {
        cacheSmartCropSample();
      }
    }
    const stableBars =
      stableEmbeddedHorizontalBars(smartBarSamples) || lastSmartBars;
    if (!stableBars) return;
    lastSmartBars = stableBars;
    applyBars(stableBars);
  }

  function handleFullscreenViewportChange(): void {
    window.requestAnimationFrame(syncStageDanmakuBounds);
    videoEnhancement?.refresh();
    syncAppMode();
    if (
      !isImmersivePlayback() &&
      !(nativeAndroid && window.innerWidth > window.innerHeight)
    ) {
      return;
    }
    if (fullscreenViewportTimer !== undefined) {
      window.clearTimeout(fullscreenViewportTimer);
    }
    fullscreenViewportTimer = window.setTimeout(() => {
      fullscreenViewportTimer = undefined;
      if (isImmersivePlayback()) void resolveFullscreenFit();
    }, 80);
  }

  function isImmersivePlayback(): boolean {
    return Boolean(
      document.fullscreenElement ||
        document.body.classList.contains("immersive-player"),
    );
  }

  function revealFullscreenControls(): void {
    showControlsWithGlass();
  }

  function finishImmersiveUi(): void {
    window.clearTimeout(dockHideTimer);
    document.body.classList.remove("fullscreen-controls-hidden");
    stageDock?.classList.remove("is-hidden", "material-released");
    stageProgress?.classList.remove("is-hidden");
    updateMobilePlayerButtons();
  }

  function hideReceiverStreamBadge(): void {
    if (receiverStreamBadge) {
      receiverStreamBadge.hidden = true;
      receiverStreamBadge.textContent = "";
    }
  }

  function isPictureInPictureActive(): boolean {
    return Boolean(video && document.pictureInPictureElement === video);
  }

  function updatePictureInPictureButton(): void {
    if (!pictureInPictureButton || !video) return;
    const pictureInPictureVisible = isPictureInPictureActive();
    const supported =
      document.pictureInPictureEnabled &&
      typeof video.requestPictureInPicture === "function";
    pictureInPictureButton.disabled = !desktop || !supported;
    pictureInPictureButton.classList.toggle("active", miniWindowEnabled);
    pictureInPictureButton.classList.toggle(
      "pip-visible",
      pictureInPictureVisible,
    );
    pictureInPictureButton.setAttribute(
      "aria-checked",
      String(miniWindowEnabled),
    );
    pictureInPictureButton.setAttribute(
      "aria-pressed",
      String(miniWindowEnabled),
    );
    pictureInPictureButton.setAttribute(
      "aria-label",
      miniWindowEnabled
        ? "小窗模式已开启，点击关闭"
        : "小窗模式已关闭，点击开启",
    );
    pictureInPictureButton.title = !supported
        ? "当前系统不支持小窗模式"
        : miniWindowEnabled
          ? "已开启：最小化软件时显示当前放映画面"
          : "已关闭：点击开启最小化自动小窗";
    const state = pictureInPictureButton.querySelector<HTMLElement>(
      ".mini-window-state",
    );
    if (state) state.textContent = miniWindowEnabled ? "开" : "关";
  }

  async function setMiniWindowPreference(
    enabled: boolean,
    announce = true,
  ): Promise<void> {
    miniWindowEnabled = enabled;
    localStorage.setItem(miniWindowPreferenceKey, String(enabled));
    window.roomDesktop?.setMiniWindowEnabled(enabled);
    if (!enabled && isPictureInPictureActive()) {
      pictureInPictureOwnsWindowMinimize = false;
      await document.exitPictureInPicture().catch(() => undefined);
    }
    updatePictureInPictureButton();
    if (announce) {
      notify(
        enabled
          ? "小窗模式已开启：最小化软件时自动显示小窗"
          : "小窗模式已关闭",
      );
    }
  }

  async function enterMiniWindowForMinimize(): Promise<boolean> {
    if (!miniWindowEnabled || !video) return false;
    const supported =
      document.pictureInPictureEnabled &&
      typeof video.requestPictureInPicture === "function";
    if (!supported) {
      notify("当前系统不支持小窗模式", true);
      return false;
    }
    if (isPictureInPictureActive()) {
      pictureInPictureOwnsWindowMinimize = true;
      return true;
    }
    if (
      video.hidden ||
      !(video.srcObject || video.currentSrc || video.getAttribute("src")) ||
      video.readyState < HTMLMediaElement.HAVE_METADATA
    ) {
      notify("小窗模式已开启，但当前没有可显示的放映画面", true);
      return false;
    }
    try {
      if (video.paused) void video.play().catch(() => undefined);
      await video.requestPictureInPicture();
      pictureInPictureOwnsWindowMinimize = true;
      updatePictureInPictureButton();
      return true;
    } catch (error) {
      pictureInPictureOwnsWindowMinimize = false;
      notify(
        error instanceof Error
          ? `小窗模式开启失败：${error.message}`
          : "小窗模式开启失败",
        true,
      );
      return false;
    }
  }

  type AppMode = "lobby" | "theater" | "immersive";

  function showImmersiveHint(): void {
    if (sessionStorage.getItem("synced:shown-immersive-hint")) return;
    sessionStorage.setItem("synced:shown-immersive-hint", "1");
    const hint = document.createElement("div");
    hint.className = "immersive-hint material-clear";
    hint.textContent = nativeAndroid
      ? "轻触画面显示控件 · 返回键退出全屏"
      : "移动鼠标显示控件 · 按 Esc 退出全屏";
    hint.setAttribute("aria-live", "polite");
    document.body.append(hint);
    if (fullscreenHintTimer !== undefined) {
      window.clearTimeout(fullscreenHintTimer);
    }
    fullscreenHintTimer = window.setTimeout(() => {
      fullscreenHintTimer = undefined;
      void animateElement(
        hint,
        [
          { opacity: 1, transform: "translateY(0)" },
          { opacity: 0, transform: "translateY(-4px)" },
        ],
        {
          kind: "control",
          id: "fullscreen-hint",
          signal: sessionUiAbortController.signal,
          reducedKeyframes: [{ opacity: 1 }, { opacity: 0 }],
        },
      ).finally(() => hint.remove());
    }, 3_000);
  }

  function setAppMode(mode: AppMode): void {
    const previous = document.body.classList.contains("mode-immersive")
      ? "immersive"
      : document.body.classList.contains("mode-theater")
        ? "theater"
        : "lobby";
    document.body.classList.remove(
      "mode-lobby",
      "mode-theater",
      "mode-immersive",
    );
    document.body.classList.add(`mode-${mode}`);
    document.body.classList.toggle("is-lobby", mode === "lobby");
    if (stageDock) stageDock.hidden = mode === "lobby";
    showControlsWithGlass();
    if (mode === "immersive" && previous !== "immersive") {
      showImmersiveHint();
    }
  }

  function syncAppMode(): void {
    const androidLandscape =
      nativeAndroid && window.innerWidth > window.innerHeight;
    setAppMode(
      isImmersivePlayback() || androidLandscape
        ? "immersive"
        : broadcasterId
          ? "theater"
          : "lobby",
    );
  }

  function updateBroadcastControls(): void {
    const selfBroadcasting = Boolean(selfId && broadcasterId === selfId);
    const otherBroadcasting = Boolean(
      broadcasterId && broadcasterId !== selfId,
    );
    const hudBar = document.querySelector<HTMLElement>("#hud-bar");
    const playbackState = awaitingBroadcastGrant
      ? "preparing"
      : broadcasterId
        ? "active"
        : "idle";
    if (hudBar) {
      hudBar.dataset.playbackState = playbackState;
      hudBar.classList.toggle("is-idle", playbackState === "idle");
      hudBar.setAttribute(
        "aria-label",
        playbackState === "idle"
          ? "连接与播放状态，当前无放映"
          : playbackState === "preparing"
            ? "连接与播放状态，正在准备放映"
            : "连接与播放状态，放映中",
      );
    }
    if (broadcastButton) {
      broadcastButton.hidden = !selfBroadcasting && !awaitingBroadcastGrant;
      broadcastButton.disabled =
        !joined || otherBroadcasting || awaitingBroadcastGrant;
      broadcastButton.classList.toggle("active", selfBroadcasting);
      broadcastButton.textContent = awaitingBroadcastGrant
        ? "正在准备放映…"
        : selfBroadcasting
          ? broadcastCapabilities?.mode === "emby"
            ? "停止 Emby 放映"
            : "停止放映"
          : "停止放映";
    }
    if (stageStartButton) {
      stageStartButton.hidden = Boolean(broadcasterId);
      stageStartButton.disabled = !joined;
    }
    updateEmbyHevcSupport();
    const dot = document.querySelector<HTMLElement>("#session-live-dot");
    dot?.classList.toggle("idle", !broadcasterId);
    updateDockPlaybackState();
    syncAppMode();
  }

  function showIdleStage(): void {
    setDockChatComposerOpen(false);
    clearViewerAudioTrackTimer();
    viewerAudioMissing = false;
    resetNativeMovieAudio();
    if (video) {
      video.pause();
      video.srcObject = null;
      video.removeAttribute("src");
      video.controls = false;
      video.load();
      video.hidden = true;
    }
    if (emptyState) emptyState.hidden = false;
    if (bufferingState) bufferingState.hidden = true;
    if (fullscreenButton) fullscreenButton.disabled = true;
    if (soundButton) soundButton.hidden = true;
    if (movieVolumeControl) movieVolumeControl.hidden = true;
    if (stageProgress) stageProgress.hidden = true;
    if (receiverQuality) receiverQuality.hidden = true;
    if (pictureSettingsButton) pictureSettingsButton.hidden = true;
    if (embySettingsButton) embySettingsButton.hidden = true;
    setMobileControlsAvailable(false);
    hideReceiverStreamBadge();
    applyHighlightCorrection();
    syncVideoEnhancement();
    setMediaStatus("当前无人放映");
    updatePictureInPictureButton();
    setAppMode("lobby");
  }

  function showWaitingStage(detail = "已通知放映端，正在协商点对点连接…"): void {
    clearViewerAudioTrackTimer();
    viewerAudioMissing = false;
    resetNativeMovieAudio();
    if (video) {
      video.pause();
      video.srcObject = null;
      if (broadcastCapabilities?.mode === "emby") {
        video.removeAttribute("src");
        video.load();
      }
      video.hidden = true;
    }
    if (emptyState) emptyState.hidden = true;
    if (bufferingState) bufferingState.hidden = false;
    const attempt = Math.max(1, Math.min(5, watchAttempts || 1));
    if (bufferingTitle) {
      bufferingTitle.textContent = `正在连接放映画面 · 尝试 ${attempt}/5`;
    }
    if (bufferingProgress) {
      bufferingProgress.max = 5;
      bufferingProgress.value = attempt;
    }
    const detailElement =
      document.querySelector<HTMLElement>("#buffering-detail");
    if (detailElement) detailElement.textContent = detail;
    if (retryButton) retryButton.hidden = false;
    if (fullscreenButton) fullscreenButton.disabled = true;
    if (soundButton) soundButton.hidden = true;
    if (movieVolumeControl) movieVolumeControl.hidden = true;
    if (stageProgress) stageProgress.hidden = true;
    if (receiverQuality) {
      receiverQuality.hidden = !broadcastCapabilities;
    }
    if (pictureSettingsButton) pictureSettingsButton.hidden = false;
    setMobileControlsAvailable(false);
    hideReceiverStreamBadge();
    syncVideoEnhancement();
    setMediaStatus(`${broadcasterNickname || "朋友"}正在放映 · 连接中`);
    updatePictureInPictureButton();
    syncAppMode();
  }

  function showLocalStage(): void {
    if (!video || !mediaStream) return;
    resetNativeMovieAudio();
    video.srcObject = mediaStream;
    video.muted = true;
    video.hidden = false;
    void video.play();
    if (emptyState) emptyState.hidden = true;
    if (bufferingState) bufferingState.hidden = true;
    if (fullscreenButton) fullscreenButton.disabled = false;
    if (soundButton) soundButton.hidden = true;
    if (movieVolumeControl) movieVolumeControl.hidden = true;
    if (stageProgress) stageProgress.hidden = true;
    if (receiverQuality) receiverQuality.hidden = true;
    if (pictureSettingsButton) pictureSettingsButton.hidden = true;
    if (embySettingsButton) embySettingsButton.hidden = true;
    setMobileControlsAvailable(false);
    hideReceiverStreamBadge();
    syncPlayerAspect();
    applyHighlightCorrection();
    syncVideoEnhancement();
    setMediaStatus(
      broadcastCapabilities
        ? `${exactSourceLabel(
            broadcastCapabilities.width,
            broadcastCapabilities.height,
            broadcastCapabilities.frameRate,
          )} · 本地放映中`
        : activePreset?.detail || "本地放映中",
    );
    updatePictureInPictureButton();
    syncAppMode();
  }

  function showLocalEmbyStage(): void {
    if (!video || !embyBroadcast?.streamPlan) return;
    resetNativeMovieAudio();
    video.muted = false;
    video.volume = 1;
    video.controls = false;
    video.hidden = false;
    if (emptyState) emptyState.hidden = true;
    if (bufferingState) bufferingState.hidden = true;
    if (fullscreenButton) fullscreenButton.disabled = false;
    if (soundButton) soundButton.hidden = true;
    if (movieVolumeControl) movieVolumeControl.hidden = false;
    if (receiverQuality) receiverQuality.hidden = true;
    if (pictureSettingsButton) pictureSettingsButton.hidden = false;
    if (embySettingsButton) embySettingsButton.hidden = false;
    setMobileControlsAvailable(false);
    hideReceiverStreamBadge();
    syncPlayerAspect();
    applyHighlightCorrection();
    syncVideoEnhancement();
    const plan = embyBroadcast.streamPlan;
    setMediaStatus(
      `Emby ${plan.width}×${plan.height} · ${plan.videoCodec.toUpperCase()} / ${plan.audioCodec.toUpperCase()} · ${plan.method}`,
    );
    updateEmbyViewerTimeline();
    updatePictureInPictureButton();
    syncAppMode();
  }

  function showRemoteStage(): void {
    if (!video) return;
    if (emptyState) emptyState.hidden = true;
    if (bufferingState) bufferingState.hidden = true;
    if (fullscreenButton) fullscreenButton.disabled = false;
    if (soundButton) soundButton.hidden = soundEnabled;
    if (movieVolumeControl) movieVolumeControl.hidden = nativeAndroid;
    applyMovieVolume(movieVolume, false);
    if (nativeAndroid) void playNativeMovieAudio();
    updateEmbyViewerTimeline();
    if (receiverQuality) {
      receiverQuality.hidden = !broadcastCapabilities;
    }
    if (embySettingsButton) embySettingsButton.hidden = true;
    if (pictureSettingsButton) pictureSettingsButton.hidden = false;
    setMobileControlsAvailable(true);
    syncPlayerAspect();
    applyHighlightCorrection();
    syncVideoEnhancement();
    void resolveFullscreenFit();
    const embyRoute = signalFeatures.has("emby-segment-relay-v1")
      ? "HTTPS 独立 ABR"
      : sfuViewerActive
        ? "服务器 SFU"
        : "P2P 备用链路";
    setMediaStatus(
      broadcastCapabilities?.mode === "emby"
        ? `${broadcasterNickname || "朋友"}正在 Emby 高清放映 · ${embyRoute}`
        : `${broadcasterNickname || "朋友"}正在放映 · ${
            sfuViewerActive ? "服务器 SFU" : "P2P 备用链路"
          }`,
    );
    updatePictureInPictureButton();
    syncAppMode();
  }

  function recordViewerStatsFailure(
    reason: "timeout" | "error" | "capacity",
    error?: unknown,
  ): void {
    viewerStatsFailures = Math.min(5, viewerStatsFailures + 1);
    if (viewerStatsFailures !== 3 && viewerStatsFailures !== 5) return;
    reportPlaybackDiagnostic("viewer-stats-confidence-reduced", {
      consecutiveFailures: viewerStatsFailures,
      confidence: viewerStatsFailures >= 5 ? "missing" : "reduced",
      reason,
      transport: sfuViewerActive ? "sfu" : "p2p",
      mediaStillProgressing:
        Date.now() - viewerPresentationProgressAt <
        SFU_SCREEN_SILENCE_TIMEOUT_MS,
      outstandingOperations: viewerStatsOutstanding,
      message: error instanceof Error ? error.message : undefined,
    });
  }

  function ensureViewerStatsTimer(): void {
    if (viewerStatsTimer) return;
    viewerStatsTimer = window.setInterval(() => {
      const recoveryAction =
        broadcastCapabilities?.mode === "emby"
          ? updateEmbyElementLiveness()
          : sfuViewerActive
            ? (updateSfuScreenLiveness(), "none" as const)
            : updateP2pScreenLiveness();
      if (recoveryAction === "replace") return;
      if (viewerStatsPollRunning) return;
      // Chromium does not expose an AbortSignal for getStats(). Never pile up
      // an unbounded number of native stats requests when a suspended WebView
      // leaves one unresolved. Capacity misses reduce telemetry confidence but
      // remain completely separate from media recovery decisions.
      if (viewerStatsOutstanding >= 2) {
        recordViewerStatsFailure("capacity");
        return;
      }
      viewerStatsPollRunning = true;
      const statsEpoch = viewerStatsEpoch;
      viewerStatsOutstanding += 1;
      const statsOperation =
        broadcastCapabilities?.mode === "emby"
          ? updateEmbyInboundStats()
          : updateInboundStats();
      void statsOperation
        .finally(() => {
          if (statsEpoch === viewerStatsEpoch) {
            viewerStatsOutstanding = Math.max(
              0,
              viewerStatsOutstanding - 1,
            );
          }
        })
        .catch(() => undefined);
      void boundedRtcOperation(
        statsOperation,
        "观看端 WebRTC 统计长时间无响应",
        RTC_STATS_TIMEOUT_MS,
      ).then(
        () => {
          if (statsEpoch === viewerStatsEpoch) viewerStatsFailures = 0;
        },
        (error) => {
          if (statsEpoch !== viewerStatsEpoch) return;
          recordViewerStatsFailure(
            error instanceof Error && /超时|timeout/i.test(error.message)
              ? "timeout"
              : "error",
            error,
          );
        },
      )
        .finally(() => {
          if (statsEpoch === viewerStatsEpoch) {
            viewerStatsPollRunning = false;
          }
        });
    }, 1_000);
  }

  function resetViewerMediaLiveness(now = Date.now()): void {
    viewerTransportProgressAt = now;
    viewerPresentationProgressAt = now;
    viewerRecoveryStartedAt = 0;
    embyLastPlaybackTime = Math.max(0, Number(video?.currentTime) || 0);
  }

  function updateEmbyElementLiveness(): "none" | "repair" | "replace" {
    if (
      broadcastCapabilities?.mode !== "emby" ||
      !remoteFirstFrame ||
      !video
    ) {
      return "none";
    }
    if (document.visibilityState === "hidden") {
      embyLivenessFrameSnapshot = undefined;
      resetViewerMediaLiveness();
      return "none";
    }
    let frames = 0;
    try {
      frames = Number(video.getVideoPlaybackQuality?.().totalVideoFrames) || 0;
    } catch {
      // currentTime remains a monotonic presentation fallback.
    }
    const currentTime = Math.max(0, Number(video.currentTime) || 0);
    const previous = embyLivenessFrameSnapshot;
    embyLivenessFrameSnapshot = { frames, currentTime };
    if (
      !previous ||
      frames > previous.frames ||
      currentTime > previous.currentTime + 0.01
    ) {
      viewerPresentationProgressAt = Date.now();
    }
    return monitorViewerMediaLiveness("emby");
  }

  function monitorViewerMediaLiveness(
    mode: "screen" | "emby",
  ): "none" | "repair" | "replace" {
    const peer = watcherPc;
    const independentHttpsMedia =
      mode === "emby" && Boolean(embyAbrViewer?.diagnostics.active);
    if ((!peer && !independentHttpsMedia) || !remoteFirstFrame) return "none";
    if (document.visibilityState === "hidden") {
      // Renderer/video clocks are intentionally suspended in the background.
      // Start a fresh observation window when the app becomes visible again.
      resetViewerMediaLiveness();
      return "none";
    }
    const now = Date.now();
    const liveness = {
      mode,
      now,
      // The CMAF media path is HTTPS and remains independently observable even
      // when its SFU/P2P control connection is being replaced.
      peerState: independentHttpsMedia
        ? "connected"
        : peer?.connectionState,
      hostPaused: mode === "emby" && embyHostPaused,
      transportProgressAt: viewerTransportProgressAt || now,
      presentationProgressAt: viewerPresentationProgressAt || now,
      bufferedAhead:
        mode === "emby"
          ? Math.max(0, embyBufferedAhead || embyViewer?.bufferedAhead || 0)
          : undefined,
      recoveryStartedAt: viewerRecoveryStartedAt || undefined,
    } satisfies Parameters<typeof playbackRecoveryAction>[0];
    const action = playbackRecoveryAction(liveness);
    if (action === "none") {
      if (playbackRecoveryCompleted(liveness)) {
        reportPlaybackDiagnostic("viewer-media-recovered", {
          mode,
          recoveryMs: now - viewerRecoveryStartedAt,
          transportIdleMs: now - viewerTransportProgressAt,
          presentationIdleMs: now - viewerPresentationProgressAt,
          bufferedAhead: embyBufferedAhead,
        });
        viewerRecoveryStartedAt = 0;
      }
      return action;
    }
    if (action === "repair") {
      viewerRecoveryStartedAt = now;
      if (mode === "emby") embyViewer?.requestRecovery();
      const restartIce =
        !independentHttpsMedia &&
        shouldRestartIceForPlaybackRepair(liveness);
      setStatus(
        mode === "emby"
          ? restartIce
            ? "播放数据停滞 · 正在补发缓存并重启链路"
            : "播放数据停滞 · 正在补发关键帧缓存"
          : "媒体数据停滞 · 正在重启 ICE 链路",
        "neutral",
      );
      if (restartIce) {
        try {
          safeSignalSend({
            type: "media:ice-restart",
            attempt: Math.max(1, watchAttempts),
            sessionId: watchSessionId,
          });
        } catch {
          // The replacement phase below also runs after signaling reconnects.
        }
      }
      reportPlaybackDiagnostic("viewer-media-stalled", {
        mode,
        connectionState: independentHttpsMedia
          ? "https-independent"
          : peer?.connectionState,
        mediaTransport: independentHttpsMedia ? "https-cmaf" : "webrtc",
        transportIdleMs: now - viewerTransportProgressAt,
        presentationIdleMs: now - viewerPresentationProgressAt,
        bufferedAhead: embyBufferedAhead,
        iceRestartRequested: restartIce,
      });
      return action;
    }
    reportPlaybackDiagnostic("viewer-media-replacing", {
      mode,
      connectionState: independentHttpsMedia
        ? "https-independent"
        : peer?.connectionState,
      mediaTransport: independentHttpsMedia ? "https-cmaf" : "webrtc",
      recoveryMs: now - viewerRecoveryStartedAt,
      transportIdleMs: now - viewerTransportProgressAt,
      presentationIdleMs: now - viewerPresentationProgressAt,
      bufferedAhead: embyBufferedAhead,
      attempt: watchAttempts,
    });
    viewerRecoveryStartedAt = now;
    retryWatching(
      mode === "emby"
        ? independentHttpsMedia
          ? "HTTPS 分片补发后仍无画面，正在重建 Emby 播放会话"
          : "补发与 ICE 重启后仍无数据，正在重建 Emby 媒体连接"
        : "ICE 重启后媒体仍停滞，正在重建放映连接",
      true,
    );
    return action;
  }

  function updateNativePlaybackActivity(
    active: boolean,
    title = "正在观看频道",
  ): void {
    if (!nativeAndroid || nativePlaybackActive === active) return;
    nativePlaybackActive = active;
    void setNativePlaybackActive(active, title).catch((error) => {
      nativePlaybackActive = false;
      if (active && !leaving) {
        notify(
          error instanceof Error
            ? `后台播放保护启动失败：${error.message}`
            : "后台播放保护启动失败",
          true,
        );
      }
    });
  }

  function clearViewerAudioTrackTimer(): void {
    if (viewerAudioTrackTimer !== undefined) {
      window.clearTimeout(viewerAudioTrackTimer);
      viewerAudioTrackTimer = undefined;
    }
  }

  function hasLiveViewerAudioTrack(): boolean {
    return remoteStream
      .getAudioTracks()
      .some((track) => track.readyState === "live");
  }

  function confirmViewerAudioTrack(): void {
    clearViewerAudioTrackTimer();
    viewerAudioStalledSamples = 0;
    if (!viewerAudioMissing) return;
    viewerAudioMissing = false;
    setStatus("影片声音已恢复 · 播放中", "ready");
    notify("影片声音轨道已经自动恢复。");
  }

  function reportViewerAudioMissing(message: string): void {
    if (viewerAudioMissing) return;
    viewerAudioMissing = true;
    setStatus("画面已到达 · 等待放映端恢复影片声音", "neutral");
    setMediaStatus(
      `${broadcasterNickname || "朋友"}正在放映 · 当前无影片声音，已请求自动修复`,
    );
    notify(message, true);
    try {
      safeSignalSend({
        type: "media:audio-missing",
        sessionId: watchSessionId || undefined,
      });
    } catch {
      // A reconnect will request a fresh offer with the audio track.
    }
  }

  function armViewerAudioTrackCheck(delayMs = 3_000): void {
    clearViewerAudioTrackTimer();
    if (
      broadcastCapabilities?.mode === "emby" ||
      broadcasterId === selfId ||
      hasLiveViewerAudioTrack()
    ) {
      viewerAudioMissing = false;
      return;
    }
    viewerAudioTrackTimer = window.setTimeout(() => {
      viewerAudioTrackTimer = undefined;
      if (
        !remoteFirstFrame ||
        broadcastCapabilities?.mode === "emby" ||
        broadcasterId === selfId ||
        hasLiveViewerAudioTrack()
      ) {
        return;
      }
      reportViewerAudioMissing(
        "画面已经到达，但暂未收到影片声音轨道；已通知放映端自动修复。",
      );
    }, delayMs);
  }

  function confirmRemoteFirstFrame(): void {
    if (remoteFirstFrame) return;
    remoteFirstFrame = true;
    firstFrameRepairStartedAt = 0;
    resetViewerMediaLiveness();
    if (sfuViewerActive && retainedWatcherPc) {
      scheduleStableSfuCommit();
    } else {
      retainedRemoteStream?.getTracks().forEach((track) => track.stop());
      retainedRemoteStream = undefined;
    }
    playerStage?.classList.remove("playback-recovering");
    clearWatchRetry();
    watchAttempts = 0;
    watchRecoveryCycles = 0;
    showRemoteStage();
    syncPlayerAspect();
    warmSmartCropMeasurement();
    void resolveFullscreenFit();
    setStatus("画面已到达 · 播放中", "ready");
    try {
      safeSignalSend({
        type: "media:ready",
        sessionId: watchSessionId || undefined,
      });
    } catch {
      // Playback can continue even if the acknowledgement is lost.
    }
    ensureViewerStatsTimer();
    armViewerAudioTrackCheck();
    updateNativePlaybackActivity(
      true,
      `${broadcasterNickname || "朋友"}正在放映`,
    );
  }

  function confirmEmbyPlaybackReady(): void {
    if (remoteFirstFrame) return;
    remoteFirstFrame = true;
    resetViewerMediaLiveness();
    playerStage?.classList.remove("playback-recovering");
    clearWatchRetry();
    watchAttempts = 0;
    watchRecoveryCycles = 0;
    showRemoteStage();
    syncPlayerAspect();
    void resolveFullscreenFit();
    setStatus("Emby 编码流已缓存 · 高清播放中", "ready");
    safeSignalSend({
      type: "media:ready",
      sessionId: watchSessionId || undefined,
    });
    ensureViewerStatsTimer();
    updateNativePlaybackActivity(
      true,
      `${broadcasterNickname || "朋友"}正在进行 Emby 放映`,
    );
  }

  function nextLowerEmbyViewerHeight(currentHeight: number): number {
    if (currentHeight > 720) return 720;
    if (currentHeight > 480) return 480;
    return 360;
  }

  function reduceEmbyViewerQuality(reason: string): boolean {
    if (broadcastCapabilities?.mode !== "emby") return false;
    const currentHeight =
      effectiveEmbyViewerHeight() ||
      broadcastCapabilities.height ||
      embyViewer?.activeSession?.plan.height ||
      1_080;
    const nextHeight = nextLowerEmbyViewerHeight(currentHeight);
    if (
      currentHeight <= 360 ||
      (embyAdaptiveHeight > 0 && nextHeight >= embyAdaptiveHeight)
    ) {
      return false;
    }
    embyAdaptiveHeight = nextHeight;
    embyAdaptiveChangedAt = Date.now();
    embyAdaptivePressureSamples = 0;
    embyAdaptiveStableSamples = 0;
    sendViewerQualityPreference(false);
    reportPlaybackDiagnostic("emby-viewer-quality-down", {
      reason,
      fromHeight: currentHeight,
      toHeight: nextHeight,
      bufferAhead: embyBufferedAhead,
      attempt: watchAttempts,
    });
    setStatus(
      `弱网持续积压 · 已请求全房间降至 ${nextHeight}p 恢复播放`,
      "neutral",
    );
    return true;
  }

  function maybeRecoverEmbyViewerQuality(): void {
    if (
      embyAdaptiveHeight <= 0 ||
      Date.now() - embyAdaptiveChangedAt < 30_000
    ) {
      return;
    }
    const targetHeight = preferredHeight || automaticEmbyViewerHeight();
    if (!targetHeight || targetHeight <= embyAdaptiveHeight) return;
    const nextHeight =
      embyAdaptiveHeight < 480
        ? Math.min(480, targetHeight)
        : embyAdaptiveHeight < 720
          ? Math.min(720, targetHeight)
          : Math.min(1_080, targetHeight);
    if (nextHeight <= embyAdaptiveHeight) return;
    const previous = embyAdaptiveHeight;
    embyAdaptiveHeight =
      nextHeight >= targetHeight ? 0 : nextHeight;
    embyAdaptiveChangedAt = Date.now();
    embyAdaptiveStableSamples = 0;
    sendViewerQualityPreference(false);
    reportPlaybackDiagnostic("emby-viewer-quality-up", {
      fromHeight: previous,
      toHeight: nextHeight,
      bufferAhead: embyBufferedAhead,
    });
  }

  async function updateEmbyInboundStats(): Promise<void> {
    const player = embyViewer;
    if (!player || !remoteFirstFrame) return;
    const sampleNow = Date.now();
    const playbackTime = Math.max(0, Number(video?.currentTime) || 0);
    const previousPlaybackTime = embyLastPlaybackTime;
    embyLastPlaybackTime = playbackTime;
    const frameSampleNow = performance.now();
    let quality: VideoPlaybackQuality | undefined;
    try {
      quality = video?.getVideoPlaybackQuality();
    } catch {
      // Older WebViews may expose the method without implementing it.
    }
    const frameCounterAvailable = Boolean(
      quality && Number.isFinite(Number(quality.totalVideoFrames)),
    );
    const previousFrameSnapshot = embyFrameSnapshot;
    const frameSnapshot = {
      frames: Number(quality?.totalVideoFrames) || 0,
      dropped: Number(quality?.droppedVideoFrames) || 0,
      timestamp: frameSampleNow,
    };
    const framesDecodedDelta = Math.max(
      0,
      frameSnapshot.frames - (previousFrameSnapshot?.frames || 0),
    );
    if (
      embyPresentationProgressed({
        frameCounterAvailable,
        previousFrames: previousFrameSnapshot?.frames,
        currentFrames: frameSnapshot.frames,
        previousTime: previousPlaybackTime,
        currentTime: playbackTime,
      })
    ) {
      viewerPresentationProgressAt = sampleNow;
    }
    let frameRate = 0;
    let droppedFrames = 0;
    if (
      previousFrameSnapshot &&
      frameSampleNow > previousFrameSnapshot.timestamp
    ) {
      frameRate =
        (framesDecodedDelta * 1_000) /
        (frameSampleNow - previousFrameSnapshot.timestamp);
      droppedFrames = Math.max(
        0,
        frameSnapshot.dropped - previousFrameSnapshot.dropped,
      );
    }
    embyFrameSnapshot = frameSnapshot;
    const decodedOrDroppedFrames = Math.max(
      framesDecodedDelta,
      droppedFrames,
    );
    syncVideoEnhancementPressure(
      decodedOrDroppedFrames > 0 &&
        droppedFrames / decodedOrDroppedFrames >= 0.06
        ? "decoder-limited"
        : "healthy",
    );
    const recoveryAction = monitorViewerMediaLiveness("emby");
    if (recoveryAction === "replace") return;
    const abrDiagnostics = embyAbrViewer?.diagnostics;
    if (abrDiagnostics?.active) {
      const diagnosticNow = Date.now();
      const mseDiagnostics = player.diagnostics;
      const plan = player.activeSession?.plan;
      const width =
        video?.videoWidth ||
        abrDiagnostics.renditionWidth ||
        plan?.width ||
        0;
      const height =
        video?.videoHeight ||
        abrDiagnostics.renditionHeight ||
        plan?.height ||
        0;
      const renditionFrameRate =
        abrDiagnostics.renditionFrameRate || frameRate;
      const bufferedAhead = Math.max(
        0,
        embyBufferedAhead || player.bufferedAhead,
      );
      if (
        recoveryAction !== "none" ||
        diagnosticNow - lastPlaybackDiagnosticAt >= 10_000
      ) {
        lastPlaybackDiagnosticAt = diagnosticNow;
        reportPlaybackDiagnostic("emby-cmaf-viewer-sample", {
          action: recoveryAction,
          mediaTransport: "https-cmaf",
          controlTransport: sfuViewerActive ? "sfu" : "p2p",
          renditionId: abrDiagnostics.renditionId,
          renditionLabel: abrDiagnostics.renditionLabel,
          renditionBitrate: abrDiagnostics.renditionBitrate,
          estimatedThroughputBps: Math.round(
            abrDiagnostics.estimatedThroughputBps,
          ),
          bufferedAhead: Number(bufferedAhead.toFixed(2)),
          playbackTime: Number(playbackTime.toFixed(3)),
          elementPaused: Boolean(video?.paused),
          hostPaused: embyHostPaused,
          frameCounterAvailable,
          totalVideoFrames: frameSnapshot.frames,
          framesDecodedDelta,
          droppedVideoFrames: frameSnapshot.dropped,
          readyState: mseDiagnostics.readyState,
          seeking: mseDiagnostics.seeking,
          bufferedWindows: mseDiagnostics.bufferedWindows.map((range) => [
            Number(range.start.toFixed(3)),
            Number(range.end.toFixed(3)),
          ]),
          appendQueueItems: mseDiagnostics.appendQueueItems,
          pendingMediaItems: mseDiagnostics.pendingMediaItems,
          presentationIdleMs:
            diagnosticNow - viewerPresentationProgressAt,
          transportIdleMs: diagnosticNow - viewerTransportProgressAt,
          cacheHits: abrDiagnostics.cacheHits,
          networkFetches: abrDiagnostics.networkFetches,
          rangeRetries: abrDiagnostics.rangeRetries,
          appendedSegments: abrDiagnostics.appendedSegments,
          prefetchedSegments: abrDiagnostics.prefetchedSegments,
          fetchGeneration: abrDiagnostics.fetchGeneration,
          lastError: abrDiagnostics.lastError,
        });
      }
      const details = [
        "HTTPS 独立 ABR",
        sfuViewerActive ? "SFU 控制" : "P2P 控制",
        abrDiagnostics.renditionLabel || abrDiagnostics.renditionId || "",
        width && height ? `${width}×${height}` : "",
        renditionFrameRate > 0
          ? `${Math.round(renditionFrameRate)} fps`
          : "帧率计算中",
        abrDiagnostics.renditionBitrate
          ? `媒体 ${formatBitrate(abrDiagnostics.renditionBitrate)}`
          : "",
        abrDiagnostics.estimatedThroughputBps > 0
          ? `带宽估计 ${formatBitrate(abrDiagnostics.estimatedThroughputBps)}`
          : "",
        `缓冲 ${bufferedAhead.toFixed(1)} 秒`,
        abrDiagnostics.cacheHits > 0
          ? `缓存命中 ${abrDiagnostics.cacheHits}`
          : "",
        abrDiagnostics.rangeRetries > 0
          ? `续传 ${abrDiagnostics.rangeRetries}`
          : "",
        embyHostPaused ? "放映端已暂停" : "",
        droppedFrames > 0 ? `丢帧 +${droppedFrames}` : "",
      ].filter(Boolean);
      const text = details.join(" · ");
      if (receiverStreamBadge) {
        receiverStreamBadge.textContent = text;
        receiverStreamBadge.hidden = false;
      }
      if (mobilePlaybackStats) mobilePlaybackStats.textContent = text;
      if (desktopPlaybackStats) desktopPlaybackStats.textContent = text;
      setMediaStatus(
        embyHostPaused
          ? `${broadcasterNickname || "朋友"}已暂停 Emby 放映 · ${text}`
          : `${broadcasterNickname || "朋友"}正在 Emby 高清放映 · ${text}`,
      );
      if (embyHostPaused) {
        setStatus("放映端已暂停 · 等待继续播放", "neutral");
      }
      updateEmbyViewerTimeline();
      return;
    }
    const peer = watcherPc;
    if (!peer || peer.connectionState === "closed") return;
    try {
      const previousDataSnapshot = embyDataSnapshot;
      const stats = await readDataChannelStats(
        peer,
        EMBY_DATA_CHANNEL_LABEL,
        previousDataSnapshot,
      );
      if (watcherPc !== peer || embyViewer !== player) return;
      embyDataSnapshot = stats.snapshot;
      if (
        stats.snapshot &&
        stats.snapshot.bytes > (previousDataSnapshot?.bytes || 0)
      ) {
        viewerTransportProgressAt = Date.now();
      }
      const plan = player.activeSession?.plan;
      const plannedBitrate = Number(plan?.bitrate) || 0;
      const receivingTooSlow =
        stats.bitrate > 0 &&
        plannedBitrate > 0 &&
        stats.bitrate < plannedBitrate * 0.72;
      const starving =
        !embyHostPaused &&
        (embyBufferedAhead < 2.5 ||
          (embyBufferedAhead < 8 && receivingTooSlow));
      embyAdaptivePressureSamples = starving
        ? Math.min(12, embyAdaptivePressureSamples + 1)
        : Math.max(0, embyAdaptivePressureSamples - 1);
      const presentationMoving =
        viewerPresentationProgressAt >= Date.now() - 2_500;
      const stable =
        !embyHostPaused &&
        presentationMoving &&
        embyBufferedAhead >= 18 &&
        (!plannedBitrate || stats.bitrate >= plannedBitrate * 0.8);
      embyAdaptiveStableSamples = stable
        ? Math.min(180, embyAdaptiveStableSamples + 1)
        : 0;
      if (embyAdaptivePressureSamples >= 4) {
        reduceEmbyViewerQuality("接收码率或前向缓存连续不足");
      } else if (embyAdaptiveStableSamples >= 120) {
        maybeRecoverEmbyViewerQuality();
      }
      const diagnosticNow = Date.now();
      const mseDiagnostics = player.diagnostics;
      if (
        recoveryAction !== "none" ||
        diagnosticNow - lastPlaybackDiagnosticAt >= 10_000
      ) {
        lastPlaybackDiagnosticAt = diagnosticNow;
        reportPlaybackDiagnostic("emby-viewer-sample", {
          action: recoveryAction,
          peerState: peer.connectionState,
          bitrate: Math.round(stats.bitrate || 0),
          plannedBitrate,
          bytesReceived: stats.bytesReceived,
          bufferedAhead: Number(embyBufferedAhead.toFixed(2)),
          playbackTime: Number(playbackTime.toFixed(3)),
          elementPaused: Boolean(video?.paused),
          hostPaused: embyHostPaused,
          frameCounterAvailable,
          totalVideoFrames: frameSnapshot.frames,
          framesDecodedDelta,
          droppedVideoFrames: frameSnapshot.dropped,
          readyState: mseDiagnostics.readyState,
          seeking: mseDiagnostics.seeking,
          bufferedWindows: mseDiagnostics.bufferedWindows.map((range) => [
            Number(range.start.toFixed(3)),
            Number(range.end.toFixed(3)),
          ]),
          appendQueueItems: mseDiagnostics.appendQueueItems,
          pendingMediaItems: mseDiagnostics.pendingMediaItems,
          presentationIdleMs:
            diagnosticNow - viewerPresentationProgressAt,
          transportIdleMs: diagnosticNow - viewerTransportProgressAt,
          relayed: stats.relayed,
          rttMs:
            stats.currentRoundTripTime === undefined
              ? undefined
              : Math.round(stats.currentRoundTripTime * 1_000),
          adaptiveHeight: embyAdaptiveHeight || undefined,
        });
      }
      const width = video?.videoWidth || plan?.width || 0;
      const height = video?.videoHeight || plan?.height || 0;
      const measuredBitrate = stats.bitrate || 0;
      const rtt =
        stats.currentRoundTripTime !== undefined
          ? `RTT ${Math.round(stats.currentRoundTripTime * 1_000)} ms`
          : "RTT 计算中";
      const details = [
        stats.relayed ? "腾讯云中继" : "P2P 直连",
        width && height ? `${width}×${height}` : "",
        frameRate > 0 ? `${Math.round(frameRate)} fps` : "帧率计算中",
        measuredBitrate > 0
          ? `接收 ${formatBitrate(measuredBitrate)}`
          : plannedBitrate > 0
            ? `媒体 ${formatBitrate(plannedBitrate)}`
            : "",
        rtt,
        `缓冲 ${Math.max(0, embyBufferedAhead || player.bufferedAhead).toFixed(1)} 秒`,
        embyHostPaused ? "放映端已暂停" : "",
        droppedFrames > 0 ? `丢帧 +${droppedFrames}` : "",
      ].filter(Boolean);
      const text = details.join(" · ");
      if (receiverStreamBadge) {
        receiverStreamBadge.textContent = text;
        receiverStreamBadge.hidden = false;
      }
      if (mobilePlaybackStats) mobilePlaybackStats.textContent = text;
      if (desktopPlaybackStats) desktopPlaybackStats.textContent = text;
      setMediaStatus(
        embyHostPaused
          ? `${broadcasterNickname || "朋友"}已暂停 Emby 放映 · ${text}`
          : `${broadcasterNickname || "朋友"}正在 Emby 高清放映 · ${text}`,
      );
      if (embyHostPaused) {
        setStatus("放映端已暂停 · 等待继续播放", "neutral");
      }
      updateEmbyViewerTimeline();
    } catch (error) {
      // The stats timer owns advisory failure accounting. Propagating this
      // error only lowers telemetry confidence; it never enters recovery.
      throw error;
    }
  }

  function updateSfuScreenLiveness(): void {
    if (
      !sfuViewerActive ||
      broadcastCapabilities?.mode === "emby" ||
      !remoteFirstFrame ||
      !video
    ) {
      return;
    }
    const now = Date.now();
    if (document.visibilityState === "hidden") {
      resetViewerMediaLiveness(now);
      sfuScreenFrameSnapshot = undefined;
      sfuScreenReceiverSnapshot = undefined;
      return;
    }
    let frames = 0;
    try {
      frames = Number(video.getVideoPlaybackQuality?.().totalVideoFrames) || 0;
    } catch {
      // currentTime remains a usable fallback on older Android WebViews.
    }
    const currentTime = Math.max(0, Number(video.currentTime) || 0);
    const previous = sfuScreenFrameSnapshot;
    sfuScreenFrameSnapshot = { frames, currentTime };
    if (
      !previous ||
      frames > previous.frames ||
      currentTime > previous.currentTime + 0.01
    ) {
      viewerTransportProgressAt = now;
      viewerPresentationProgressAt = now;
      return;
    }
    if (
      now - viewerPresentationProgressAt < SFU_SCREEN_SILENCE_TIMEOUT_MS
    ) {
      return;
    }
    reportPlaybackDiagnostic("sfu-screen-silent", {
      broadcasterId,
      silenceMs: now - viewerPresentationProgressAt,
      trackStates: remoteStream.getTracks().map((track) => ({
        kind: track.kind,
        readyState: track.readyState,
        muted: track.muted,
      })),
    });
    void fallbackFromSfu(
      "SFU 画面长时间无新帧，正在切换 P2P 备用链路",
    );
  }

  async function updateSfuScreenStats(): Promise<void> {
    updateSfuScreenLiveness();
    if (!sfuViewerActive || broadcastCapabilities?.mode === "emby") return;
    const stats = await sfuSession.readScreenReceiverStats();
    if (!stats || !sfuViewerActive) return;
    if (
      stats.emergency &&
      stats.framesDecoded > 0 &&
      !isVerifiedEmergencyTrackSettings({
        width: stats.frameWidth,
        height: stats.frameHeight,
        frameRate: stats.framesPerSecond,
      })
    ) {
      reportPlaybackDiagnostic("sfu-emergency-receiver-invalid", {
        frameWidth: stats.frameWidth,
        frameHeight: stats.frameHeight,
        framesPerSecond: stats.framesPerSecond,
      });
      void fallbackFromSfu(
        "SFU 应急轨实际规格异常，正在切换 P2P 备用链路",
      );
      return;
    }
    const previous = sfuScreenReceiverSnapshot;
    sfuScreenReceiverSnapshot = stats;
    if (!previous || stats.timestamp <= previous.timestamp) return;
    const packetDelta = Math.max(
      0,
      stats.packetsReceived +
        stats.packetsLost -
        previous.packetsReceived -
        previous.packetsLost,
    );
    const lostDelta = Math.max(
      0,
      stats.packetsLost - previous.packetsLost,
    );
    const decodedDelta = Math.max(
      0,
      stats.framesDecoded - previous.framesDecoded,
    );
    const droppedDelta = Math.max(
      0,
      stats.framesDropped - previous.framesDropped,
    );
    const elapsedSeconds = Math.max(
      0.001,
      (stats.timestamp - previous.timestamp) / 1_000,
    );
    const bitrate = Math.max(
      0,
      ((stats.bytesReceived - previous.bytesReceived) * 8) / elapsedSeconds,
    );
    if (stats.bytesReceived > previous.bytesReceived) {
      viewerTransportProgressAt = Date.now();
    }
    if (decodedDelta > 0) {
      viewerPresentationProgressAt = Date.now();
    }
    const decision = adaptivePlayback.observe({
      connectionState: sfuSession.connected ? "connected" : "disconnected",
      packetLossRatio: packetDelta > 0 ? lostDelta / packetDelta : undefined,
      jitter: stats.jitter,
      framesDroppedRatio:
        decodedDelta + droppedDelta > 0
          ? droppedDelta / (decodedDelta + droppedDelta)
          : undefined,
      frameRate: stats.framesPerSecond,
      availableBandwidthBps: stats.availableIncomingBitrate,
      currentRoundTripTime: stats.currentRoundTripTime,
      transportProgressAgeMs: Date.now() - viewerTransportProgressAt,
    });
    syncVideoEnhancementPressure(decision.pressure);
    if (decision.changed) {
      sendViewerQualityPreference(false);
      const preference = currentSfuScreenPreference();
      setStatus(
        decision.direction === "down"
          ? `${decision.reason || "媒体压力"} · 当前设备已切换至 ${preference.height}p/${preference.frameRate} 帧`
          : `网络持续稳定 · 当前设备正回升至 ${preference.height}p/${preference.frameRate} 帧`,
        decision.direction === "down" ? "neutral" : "ready",
      );
    }
    const dimensions = [
      stats.frameWidth && stats.frameHeight
        ? `${Math.round(stats.frameWidth)}×${Math.round(stats.frameHeight)}`
        : "SFU 分层",
      stats.framesPerSecond
        ? `${Math.round(stats.framesPerSecond)} fps`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const pressure =
      adaptivePlayback.currentPressure === "healthy"
        ? ""
        : adaptivePlayback.currentPressure;
    setMediaStatus(
      [
        `${broadcasterNickname || "朋友"}正在放映`,
        "服务器 SFU",
        dimensions,
        bitrate > 0 ? formatBitrate(bitrate) : "",
        pressure,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }

  function updateP2pScreenLiveness(): "none" | "repair" | "replace" {
    if (
      sfuViewerActive ||
      broadcastCapabilities?.mode === "emby" ||
      !remoteFirstFrame ||
      !video
    ) {
      return "none";
    }
    if (document.visibilityState === "hidden") {
      p2pScreenFrameSnapshot = undefined;
      resetViewerMediaLiveness();
      return "none";
    }
    let frames = 0;
    try {
      frames = Number(video.getVideoPlaybackQuality?.().totalVideoFrames) || 0;
    } catch {
      // currentTime remains a monotonic presentation fallback.
    }
    const currentTime = Math.max(0, Number(video.currentTime) || 0);
    const previous = p2pScreenFrameSnapshot;
    p2pScreenFrameSnapshot = { frames, currentTime };
    if (
      !previous ||
      frames > previous.frames ||
      currentTime > previous.currentTime + 0.01
    ) {
      const now = Date.now();
      // Actual presentation progress is stronger evidence than a missing or
      // delayed stats report. Keep both health clocks advancing here.
      viewerTransportProgressAt = now;
      viewerPresentationProgressAt = now;
    }
    return monitorViewerMediaLiveness("screen");
  }

  async function updateInboundStats(): Promise<void> {
    if (sfuViewerActive) {
      await updateSfuScreenStats();
      return;
    }
    const peer = watcherPc;
    if (
      !peer ||
      peer.connectionState === "closed" ||
      !remoteFirstFrame
    ) {
      return;
    }
    const recoveryAction = updateP2pScreenLiveness();
    if (recoveryAction === "replace") return;
    try {
      const previousVideoSnapshot = inboundSnapshot;
      const previousAudioSnapshot = inboundAudioSnapshot;
      const [stats, audioStats] = await Promise.all([
        readInboundVideoStats(peer, previousVideoSnapshot),
        readInboundAudioStats(peer, previousAudioSnapshot),
      ]);
      if (watcherPc !== peer || sfuViewerActive) return;
      // A selected two-endpoint candidate pair is reported separately through
      // network:transport-report. Candidate gathering is only a local
      // capability and must never be relabelled as path reachability.
      inboundSnapshot = stats.snapshot;
      inboundAudioSnapshot = audioStats.snapshot;
      if (
        stats.snapshot &&
        stats.snapshot.bytes > (previousVideoSnapshot?.bytes || 0)
      ) {
        viewerTransportProgressAt = Date.now();
      }
      if (
        stats.snapshot &&
        stats.snapshot.framesDecoded >
          (previousVideoSnapshot?.framesDecoded || 0)
      ) {
        viewerPresentationProgressAt = Date.now();
      }
      const diagnosticNow = Date.now();
      if (
        recoveryAction !== "none" ||
        diagnosticNow - lastPlaybackDiagnosticAt >= 10_000
      ) {
        lastPlaybackDiagnosticAt = diagnosticNow;
        reportPlaybackDiagnostic("screen-viewer-sample", {
          action: recoveryAction,
          peerState: peer.connectionState,
          bitrate: Math.round(stats.bitrate || 0),
          bytesReceived: stats.bytesReceived,
          framesDecoded: stats.framesDecoded,
          framesDecodedDelta: stats.framesDecodedDelta,
          frameRate: stats.framesPerSecond,
          codec: stats.codec,
          decoder: stats.decoderImplementation,
          relayed: stats.relayed,
          rttMs:
            stats.currentRoundTripTime === undefined
              ? undefined
              : Math.round(stats.currentRoundTripTime * 1_000),
          presentationIdleMs:
            diagnosticNow - viewerPresentationProgressAt,
          transportIdleMs: diagnosticNow - viewerTransportProgressAt,
        });
      }
      const liveAudioTrack = remoteStream
        .getAudioTracks()
        .find((track) => track.readyState === "live");
      const audioBytesGrowing =
        audioStats.bytesReceived > (previousAudioSnapshot?.bytes || 0);
      const audioEnergyGrowing =
        audioStats.totalAudioEnergy >
          (previousAudioSnapshot?.totalAudioEnergy || 0) + 0.000_000_1 ||
        (audioStats.audioLevel || 0) > 0.000_1;
      const audioSamplesGrowing =
        audioStats.totalSamplesDuration >
        (previousAudioSnapshot?.totalSamplesDuration || 0);
      const playbackElementReady =
        movieVolume <= 0 ||
        (nativeAndroid
          ? nativeMovieAudioIsAudible()
          : Boolean(video && !video.muted && !video.paused));
      if (audioBytesGrowing) {
        viewerAudioEverReceived = true;
        if (
          nativeAndroid &&
          movieVolume > 0 &&
          !nativeMovieAudioIsAudible()
        ) {
          void playNativeMovieAudio();
        }
        if (
          playbackElementReady &&
          (audioEnergyGrowing || audioSamplesGrowing)
        ) {
          confirmViewerAudioTrack();
          viewerAudioStalledSamples = 0;
        } else if (movieVolume > 0 && !playbackElementReady) {
          viewerAudioStalledSamples += 1;
          if (viewerAudioStalledSamples >= 6) {
            reportViewerAudioMissing(
              nativeAndroid
                ? "已收到影片声音数据，但手机播放链未启动；请点击工具栏声音按钮恢复。"
                : "已收到影片声音数据，但播放器处于静音或暂停状态；请点击声音按钮恢复。",
            );
          }
        }
      } else if (liveAudioTrack) {
        const shouldCountStall =
          !viewerAudioEverReceived ||
          liveAudioTrack.muted ||
          (stats.bitrate > 16_000 && audioStats.bitrate === 0);
        viewerAudioStalledSamples = shouldCountStall
          ? viewerAudioStalledSamples + 1
          : 0;
        const threshold = viewerAudioEverReceived ? 15 : 6;
        if (viewerAudioStalledSamples >= threshold) {
          reportViewerAudioMissing(
            viewerAudioEverReceived
              ? "影片声音数据已长时间停止，已通知放映端自动重建音轨。"
              : "画面已经到达，但影片声音数据始终为零；已通知放映端自动修复。",
          );
        }
      }
      const receivedWidth = stats.width || video?.videoWidth || 0;
      const receivedHeight = stats.height || video?.videoHeight || 0;
      const dimensions =
        receivedWidth && receivedHeight
          ? `${receivedWidth}×${receivedHeight}`
          : "";
      const receivedFrameRate = stats.framesPerSecond
        ? `${Math.round(stats.framesPerSecond)} fps`
        : "";
      const codec = stats.codec || "";
      const decoder =
        stats.powerEfficientDecoder === true
          ? "硬件解码"
          : stats.powerEfficientDecoder === false
            ? "软件解码"
            : "";
      const route = stats.relayed ? "腾讯云中继" : "P2P 直连";
      const roundTripTime = stats.currentRoundTripTime;
      const rtt =
        roundTripTime !== undefined
          ? `RTT ${Math.round(roundTripTime * 1000)} ms`
          : "";
      const audioDetail =
        audioStats.bitrate > 0
          ? `音频 ${formatBitrate(audioStats.bitrate)}`
          : viewerAudioMissing
            ? "当前无影片声音"
            : "";
      const detail = [
        route,
        dimensions,
        receivedFrameRate,
        codec,
        decoder,
        formatBitrate(stats.bitrate),
        audioDetail,
        rtt,
      ]
        .filter(Boolean)
        .join(" · ");
      if (detail) {
        setMediaStatus(
          `${broadcasterNickname || "朋友"}正在放映 · ${detail}`,
        );
      }
      if (receiverStreamBadge) {
        const playbackDetail = [
          dimensions,
          receivedFrameRate,
          stats.bitrate ? formatBitrate(stats.bitrate) : "",
          audioDetail,
          rtt,
          viewerAudioMissing ? "等待影片音轨" : "",
        ]
          .filter(Boolean)
          .join(" · ");
        receiverStreamBadge.textContent = playbackDetail
          ? `正在观看 · ${playbackDetail}`
          : "";
        receiverStreamBadge.hidden = !playbackDetail;
      }
      if (mobilePlaybackStats) {
        mobilePlaybackStats.textContent =
          [
            dimensions || "读取分辨率",
            receivedFrameRate || "读取帧率",
            stats.bitrate ? formatBitrate(stats.bitrate) : "计算码率",
            audioDetail || "检测影片声音",
            rtt || "读取 RTT",
          ].join(" · ");
      }
      if (desktopPlaybackStats) {
        desktopPlaybackStats.textContent =
          [
            dimensions || "读取分辨率",
            receivedFrameRate || "读取帧率",
            stats.bitrate ? formatBitrate(stats.bitrate) : "计算码率",
            audioDetail || "检测影片声音",
            rtt || "读取 RTT",
          ].join(" · ");
      }
      if (
        fullscreenFit === "smart" &&
        (nativeAndroid || isImmersivePlayback())
      ) {
        cacheSmartCropSample();
      }
      setStatus(
        viewerAudioMissing
          ? "画面已到达 · 等待放映端恢复影片声音"
          : `画面已到达 · ${route}播放中`,
        viewerAudioMissing ? "neutral" : "ready",
      );
      const adaptation = adaptivePlayback.observe({
        connectionState: peer.connectionState,
        packetLossRatio: stats.packetLossRatio,
        jitter: stats.jitter,
        freezeDurationDelta: stats.freezeDurationDelta,
        framesDroppedRatio: stats.framesDroppedRatio,
        averageDecodeTime: stats.averageDecodeTime,
        frameRate: stats.framesPerSecond,
      });
      syncVideoEnhancementPressure(adaptation.pressure);
      if (adaptation.changed) {
        sendViewerQualityPreference(false);
        const target = adaptation.requestedHeight
          ? `${adaptation.requestedHeight}p`
          : "原画";
        if (adaptation.direction === "down") {
          setStatus(`网络波动 · 已自动降至 ${target}`, "neutral");
          if (!viewerBandwidthWarningShown) {
            viewerBandwidthWarningShown = true;
            notify(
              `检测到持续丢包，已自动降至 ${target} 保证流畅；网络稳定后会自动恢复。`,
            );
          }
        } else {
          setStatus(`网络恢复 · 正在回升至 ${target}`, "ready");
          if (!adaptivePlayback.reduced) {
            viewerBandwidthWarningShown = false;
          }
        }
      }
    } catch (error) {
      // The stats timer owns advisory failure accounting. Propagating this
      // error only lowers telemetry confidence; it never enters recovery.
      throw error;
    }
  }

  function attachRemoteStream(peer?: RTCPeerConnection): void {
    if (!video) return;
    const isActiveTransport = (): boolean =>
      peer ? watcherPc === peer : sfuViewerActive;
    const attachedStream = remoteStream;
    const seamlessRecovery = Boolean(retainedRemoteStream);
    const alreadyAttached = video.srcObject === attachedStream;
    if (!alreadyAttached) video.srcObject = attachedStream;
    video.muted = nativeAndroid ? true : !soundEnabled;
    video.volume = movieVolume;
    video.autoplay = true;
    video.playsInline = true;
    if (nativeAndroid) void playNativeMovieAudio();
    if (alreadyAttached) {
      void video.play().catch(() => undefined);
      return;
    }
    video.hidden = false;
    if (emptyState) emptyState.hidden = true;
    if (bufferingState) bufferingState.hidden = seamlessRecovery;
    if (seamlessRecovery) {
      setMobileControlsAvailable(true);
      playerStage?.classList.add("playback-recovering");
    }
    if (soundButton) {
      soundButton.hidden = soundEnabled;
      soundButton.textContent = soundEnabled
        ? "影片声音已开启"
        : "点击开启影片声音";
    }
    const detail = document.querySelector<HTMLElement>("#buffering-detail");
    if (detail) {
      detail.textContent =
        `媒体轨协商完成，正在等待${
          peer ? " P2P 备用链路" : "服务器 SFU"
        }解码后的第一帧…`;
    }
    setMediaStatus(
      `媒体轨已协商 · 正在确认${peer ? " P2P" : " SFU"}数据`,
    );
    const confirmRenderedFrame = (): void => {
      if (
        !isActiveTransport() ||
        video.srcObject !== attachedStream ||
        remoteFirstFrame
      ) {
        return;
      }
      if (
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ||
        video.videoWidth > 0
      ) {
        confirmRemoteFirstFrame();
      }
    };
    for (const eventName of ["loadeddata", "canplay", "playing", "resize"]) {
      video.addEventListener(eventName, confirmRenderedFrame, { once: true });
    }
    if (videoFrameCallbackId !== undefined) {
      video.cancelVideoFrameCallback(videoFrameCallbackId);
      videoFrameCallbackId = undefined;
    }
    if (typeof video.requestVideoFrameCallback === "function") {
      videoFrameCallbackId = video.requestVideoFrameCallback(() => {
        videoFrameCallbackId = undefined;
        if (isActiveTransport() && video.srcObject === attachedStream) {
          confirmRemoteFirstFrame();
        }
      });
    }
    void video.play().catch(() => {
      if (!isActiveTransport() || video.srcObject !== attachedStream) return;
      if (nativeAndroid) {
        video.muted = true;
        void video.play().catch(() => undefined);
        void playNativeMovieAudio(true);
        return;
      }
      if (nativeAutoplay) {
        // Start the decoder muted if the platform rejected the first attempt,
        // then immediately restore sound. Electron and the Android wrapper
        // both disable the user-gesture requirement, so this also recovers
        // when the audio track arrived a moment after the video track.
        video.muted = true;
        void video.play().finally(() => {
          if (!isActiveTransport() || video.srcObject !== attachedStream) {
            return;
          }
          video.muted = movieVolume <= 0;
          video.volume = movieVolume;
          soundEnabled = movieVolume > 0;
          if (soundButton) soundButton.hidden = true;
          if (autoSoundRetryTimer !== undefined) {
            window.clearTimeout(autoSoundRetryTimer);
          }
          autoSoundRetryTimer = window.setTimeout(() => {
            autoSoundRetryTimer = undefined;
            if (isActiveTransport() && video.srcObject === attachedStream) {
              video.muted = movieVolume <= 0;
              void video.play().catch(() => undefined);
            }
          }, 500);
        });
        return;
      }
      soundEnabled = false;
      video.muted = true;
      if (soundButton) {
        soundButton.hidden = false;
        soundButton.textContent = "点击开启影片声音";
      }
      void video.play().catch(() => undefined);
      setStatus("请点击“开启影片声音”继续播放", "ready");
    });
  }

  function clearWatchRetry(): void {
    if (watchRetryTimer) window.clearTimeout(watchRetryTimer);
    watchRetryTimer = undefined;
    if (watchCycleRetryTimer !== undefined) {
      window.clearTimeout(watchCycleRetryTimer);
      watchCycleRetryTimer = undefined;
    }
  }

  function clearDisconnectGrace(): void {
    if (disconnectGraceTimer !== undefined) {
      window.clearTimeout(disconnectGraceTimer);
    }
    disconnectGraceTimer = undefined;
    if (disconnectReplaceTimer !== undefined) {
      window.clearTimeout(disconnectReplaceTimer);
    }
    disconnectReplaceTimer = undefined;
  }

  function receiverCodecNames(): string[] {
    const capabilities = RTCRtpReceiver.getCapabilities?.("video");
    return [
      ...new Set(
        (capabilities?.codecs || [])
          .map((codec) => codec.mimeType)
          .filter((mimeType) => /^video\/(H264|VP8|VP9|AV1)$/i.test(mimeType)),
      ),
    ];
  }

  function directAttemptLabel(attempt: number): string {
    if (attempt === 2) {
      return "正在保留全部直连路径、切换兼容编码并重新打洞…";
    }
    if (attempt === 3) {
      return "正在重建完整 P2P 链路并请求新的关键帧…";
    }
    if (attempt === 4) {
      return "正在按当前网络重新收集公网与局域网候选…";
    }
    if (attempt >= 5) {
      return "正在进行最后一次直连打洞与兼容编码协商…";
    }
    return "正在同时尝试物理局域网与公网打洞；不会占用服务器中继带宽…";
  }

  function armWatchRetry(): void {
    clearWatchRetry();
    watchRetryTimer = window.setTimeout(() => {
      watchRetryTimer = undefined;
      if (!broadcasterId || broadcasterId === selfId || remoteFirstFrame) {
        return;
      }
      const peer = watcherPc;
      if (!peer) {
        retryWatching("P2P 连接尚未建立，正在重新协商");
        return;
      }
      if (
        broadcastCapabilities?.mode === "emby" &&
        peer.connectionState === "connected" &&
        embyViewer
      ) {
        const now = Date.now();
        const diagnostics = embyViewer.diagnostics;
        const mediaArrived =
          embyBufferedAhead >= 0.12 ||
          diagnostics.bufferedRanges > 0 ||
          diagnostics.appendQueueItems > 0 ||
          diagnostics.pendingMediaItems > 0;
        const bufferStillGrowing =
          embyStartupBufferProgressAt > 0 &&
          now - embyStartupBufferProgressAt < 8_000;
        if (!diagnostics.mediaErrorCode && mediaArrived && bufferStillGrowing) {
          setStatus(
            `Emby 链路已连接 · 正在积累首屏缓冲 ${embyBufferedAhead.toFixed(1)} 秒`,
            "neutral",
          );
          reportPlaybackDiagnostic("emby-startup-buffering", {
            attempt: watchAttempts,
            bufferedAhead: Number(embyBufferedAhead.toFixed(2)),
            readyState: diagnostics.readyState,
            appendQueueItems: diagnostics.appendQueueItems,
            pendingMediaItems: diagnostics.pendingMediaItems,
          });
          // Active DataChannel/MSE progress is authoritative. Recreating the
          // peer here used to throw away 6–9 seconds of valid LTE buffering on
          // every 15-second retry, so the startup barrier could never finish.
          armWatchRetry();
          return;
        }
        if (!diagnostics.mediaErrorCode && mediaArrived) {
          const qualityReduced = reduceEmbyViewerQuality(
            "首屏缓存连续停止增长",
          );
          if (qualityReduced) {
            embyStartupBufferProgressAt = now;
            setStatus(
              "首屏缓存增长不足 · 已降低共享码率并保持当前连接",
              "neutral",
            );
            reportPlaybackDiagnostic("emby-startup-quality-down", {
              attempt: watchAttempts,
              bufferedAhead: Number(embyBufferedAhead.toFixed(2)),
              readyState: diagnostics.readyState,
            });
            armWatchRetry();
            return;
          }
        }
      }
      const diagnosticOperation = readIceConnectivityDiagnostics(peer)
        .then((diagnostics) => {
          if (watcherPc !== peer || remoteFirstFrame) return undefined;
          lastIceDiagnostics = diagnostics;
          oneWayPathObserved ||= diagnostics.oneWayInboundBlocked;
          virtualCandidateObserved ||= diagnostics.hasVirtualCandidate;
          return readInboundVideoStats(peer);
        });
      void boundedRtcOperation(
        diagnosticOperation,
        "首帧 WebRTC 诊断超时",
        RTC_STATS_TIMEOUT_MS,
      )
        .then((stats) => {
          if (!stats || watcherPc !== peer || remoteFirstFrame) return;
          if ((stats.framesDecoded || 0) > 0) {
            // Some Android WebView versions decode correctly but never invoke
            // requestVideoFrameCallback. The WebRTC counter is authoritative.
            confirmRemoteFirstFrame();
            return;
          }
          if (peer.connectionState !== "connected") {
            retryWatching("P2P 直连尚未建立，正在重新收集网络候选");
          } else if ((stats.bytesReceived || 0) > 0) {
            const failedCodec = inboundDecodeFailureCodec(stats);
            if (failedCodec) {
              try {
                safeSignalSend({
                  type: "media:codec-failed",
                  attempt: watchAttempts,
                  sessionId: watchSessionId,
                  codec: failedCodec,
                });
              } catch {
                // The new watch-ready request still rebuilds this connection;
                // codec memory is skipped when its evidence cannot be relayed.
              }
            }
            retryWatching("视频数据已到达但当前编码无法解码，正在切换兼容编码");
          } else {
            retryWatching("P2P 已连接但尚无视频帧，正在重启发送编码器");
          }
        })
        .catch((error) => {
          if (watcherPc !== peer || remoteFirstFrame) return;
          reportPlaybackDiagnostic("first-frame-stats-missing", {
            connectionState: peer.connectionState,
            iceConnectionState: peer.iceConnectionState,
            waitedMs: watchAttempts === 1 ? 25_000 : 15_000,
            message: error instanceof Error ? error.message : String(error),
          });
          const now = Date.now();
          if (
            firstFrameRepairStartedAt > 0 &&
            now - firstFrameRepairStartedAt >= 12_000
          ) {
            // Rebuild because an independently observed first-frame deadline
            // remained broken after ICE repair, never because getStats failed.
            retryWatching(
              "ICE 修复后仍未收到视频首帧，正在重建兼容媒体连接",
            );
            return;
          }
          firstFrameRepairStartedAt = now;
          try {
            safeSignalSend({
              type: "media:ice-restart",
              attempt: Math.max(1, watchAttempts),
              sessionId: watchSessionId,
            });
          } catch {
            // The next deadline can replace the connection if media stays idle.
          }
          setStatus("首帧仍未到达 · 正在修复 ICE 链路", "neutral");
          armWatchRetry();
        });
    }, watchAttempts === 1 ? 25_000 : 15_000);
  }

  function showWatchFailure(): void {
    clearWatchRetry();
    clearDisconnectGrace();
    if (retainedRemoteStream) {
      retainedRemoteStream.getTracks().forEach((track) => track.stop());
      retainedRemoteStream = undefined;
      showWaitingStage();
    }
    playerStage?.classList.remove("playback-recovering");
    setStatus("画面连接超时", "error");
    const detail = document.querySelector<HTMLElement>("#buffering-detail");
    if (detail) {
      if (oneWayPathObserved || lastIceDiagnostics?.oneWayInboundBlocked) {
        detail.textContent =
          "直连检查只有发包、没有收到任何回包。常见原因是路由器开启了“AP/无线终端隔离、访客网络”，或 Meta/Clash TUN 接管了局域网 UDP；关闭相关限制后可直接重试。";
      } else if (
        virtualCandidateObserved ||
        lastIceDiagnostics?.hasVirtualCandidate
      ) {
        detail.textContent =
          "检测到放映电脑的 VPN/TUN 虚拟网卡正在干扰 P2P。应用已排除虚拟候选；若仍失败，请让 Meta/Clash 绕过局域网，或暂时关闭 TUN 后重试。";
      } else {
        detail.textContent =
          broadcastCapabilities?.mode === "emby"
            ? "媒体链路连续恢复仍未稳定，应用会降低共享码率并继续后台重连；也可点击按钮立即重试。"
            : "已经轮换直连、TURN 中继和兼容编码仍未收到连续画面；应用会按退避节奏继续后台重连，也可点击按钮立即重试。";
      }
    }
    if (retryButton) retryButton.hidden = false;
  }

  function scheduleNextWatchCycle(reason: string): void {
    if (
      watchCycleRetryTimer !== undefined ||
      !broadcasterId ||
      broadcasterId === selfId ||
      leaving
    ) {
      return;
    }
    showWatchFailure();
    watchRecoveryCycles += 1;
    if (watchRecoveryCycles >= MAX_WATCH_RECOVERY_CYCLES) {
      watchAttempts = 0;
      setStatus(
        "自动连接已达到上限 · 请点击“重新连接画面”再试",
        "error",
      );
      const detail = document.querySelector<HTMLElement>("#buffering-detail");
      if (detail) {
        detail.textContent =
          "连续恢复 10 轮仍未建立稳定媒体链路，已停止后台自动探测，避免持续消耗网络与服务器资源。请检查网络、代理或防火墙后点击按钮重试。";
      }
      if (retryButton) retryButton.hidden = false;
      reportPlaybackDiagnostic("viewer-retry-exhausted", {
        mode: broadcastCapabilities?.mode === "emby" ? "emby" : "screen",
        cycles: watchRecoveryCycles,
        peerState: watcherPc?.connectionState,
      });
      return;
    }
    const embyMode = broadcastCapabilities?.mode === "emby";
    const qualityReduced =
      embyMode && reduceEmbyViewerQuality("连接恢复达到本轮上限");
    const delayMs = qualityReduced
      ? 9_000
      : Math.min(30_000, 5_000 + watchRecoveryCycles * 3_000);
    watchAttempts = 0;
    setStatus(
      qualityReduced
        ? "已降低 Emby 共享码率 · 等待新流后继续连接"
        : `${reason} · ${Math.ceil(delayMs / 1_000)} 秒后继续自动连接`,
      "neutral",
    );
    reportPlaybackDiagnostic("viewer-retry-cycle", {
      mode: embyMode ? "emby" : "screen",
      cycle: watchRecoveryCycles,
      delayMs,
      qualityReduced,
      peerState: watcherPc?.connectionState,
      bufferAhead: embyBufferedAhead,
    });
    watchCycleRetryTimer = window.setTimeout(() => {
      watchCycleRetryTimer = undefined;
      if (!broadcasterId || broadcasterId === selfId || leaving) return;
      const now = Date.now();
      const presentationHealthy =
        remoteFirstFrame &&
        viewerPresentationProgressAt > 0 &&
        now - viewerPresentationProgressAt < 4_000;
      const transportHealthy =
        viewerTransportProgressAt > 0 &&
        now - viewerTransportProgressAt < 4_000;
      if (
        watcherPc?.connectionState === "connected" &&
        presentationHealthy &&
        (transportHealthy || (embyMode && embyBufferedAhead >= 2.5))
      ) {
        watchRecoveryCycles = 0;
        resetViewerMediaLiveness(now);
        setStatus(
          embyMode
            ? "Emby 高清流已自动恢复 · 播放中"
            : "画面已自动恢复 · 播放中",
          "ready",
        );
        return;
      }
      void beginWatching(true);
    }, delayMs);
  }

  function retryWatching(reason: string, replaceActive = false): void {
    if (watchCycleRetryTimer !== undefined) return;
    if (
      !broadcasterId ||
      broadcasterId === selfId ||
      (remoteFirstFrame && !replaceActive)
    ) {
      return;
    }
    if (watchAttempts >= 5) {
      scheduleNextWatchCycle(reason);
      return;
    }
    setStatus(reason, "neutral");
    void beginWatching(true);
  }

  function automaticEmbyViewerHeight(): number {
    const fresh =
      networkReport &&
      Date.now() - networkReport.measuredAt <= 5 * 60_000
        ? networkReport
        : undefined;
    // Android can join and request quality before the multi-step probe has
    // completed. Starting that unknown route at 720p rebuilds Emby at 6 Mbps,
    // which is enough to starve many LTE/TURN paths before the first frame.
    if (!fresh) return nativeAndroid ? 480 : 0;
    const safeDownloadBps =
      Math.max(0, fresh.downloadKbps) *
      1_000 *
      (fresh.networkType === "cellular" || fresh.metered ? 0.5 : 0.62);
    if (
      safeDownloadBps >= 15_000_000 &&
      !fresh.metered &&
      fresh.networkType !== "cellular"
    ) {
      // HTTPS CMAF ABR is independent from P2P reachability. Leaving the
      // height unbounded lets the rendition actor select original only after
      // it measures 1.5x bitrate headroom and has a healthy forward buffer.
      return 0;
    }
    if (fresh.networkType === "cellular" || fresh.metered) {
      return safeDownloadBps >= 3_200_000 ? 480 : 360;
    }
    // A fixed 720p ceiling duplicates the ABR bitrate decision and prevents a
    // healthy-but-not-exceptional fixed connection from reaching 1080p. Keep
    // 1080p available here; the rendition actor still requires measured 1.5x
    // bitrate headroom before it upgrades.
    if (safeDownloadBps >= 3_200_000) return 1_080;
    return 480;
  }

  function effectiveEmbyViewerHeight(): number | undefined {
    const requested = preferredHeight || automaticEmbyViewerHeight();
    if (embyAdaptiveHeight > 0) {
      return requested > 0
        ? Math.min(requested, embyAdaptiveHeight)
        : embyAdaptiveHeight;
    }
    return requested || undefined;
  }

  function currentSfuScreenPreference(): {
    width?: number;
    height?: number;
    frameRate?: number;
    sourceWidth?: number;
    sourceHeight?: number;
  } {
    const capabilities = broadcastCapabilities;
    if (!capabilities || capabilities.mode === "emby") return {};
    const sfuSourceScale = Math.min(
      1,
      2_560 / capabilities.width,
      1_440 / capabilities.height,
    );
    const sfuSourceWidth = Math.max(
      1,
      Math.round(capabilities.width * sfuSourceScale),
    );
    const sfuSourceHeight = Math.max(
      1,
      Math.round(capabilities.height * sfuSourceScale),
    );
    const height = Math.max(
      1,
      Math.min(
        adaptivePlayback.requestedHeight || capabilities.height,
        sfuSourceHeight,
      ),
    );
    const width = Math.max(
      1,
      Math.min(
        sfuSourceWidth,
        Math.round((height * sfuSourceWidth) / sfuSourceHeight),
      ),
    );
    return {
      width,
      height,
      frameRate: Math.max(
        1,
        Math.min(
          preferredFrameRate ||
            adaptivePlayback.requestedFrameRate ||
            capabilities.frameRate,
          Math.min(capabilities.frameRate, 30),
        ),
      ),
      sourceWidth: sfuSourceWidth,
      sourceHeight: sfuSourceHeight,
    };
  }

  function sendViewerQualityPreference(showFeedback = false): void {
    if (
      !signal ||
      !broadcasterId ||
      broadcasterId === selfId
    ) {
      return;
    }
    const embyMode = broadcastCapabilities?.mode === "emby";
    const requestedHeight = embyMode
      ? effectiveEmbyViewerHeight()
      : adaptivePlayback.requestedHeight;
    if (
      embyMode &&
      signalFeatures.has("emby-segment-relay-v1")
    ) {
      embyAbrViewer?.setPreferredHeight(requestedHeight);
      // The height remains a local ABR ceiling. The publisher only consumes
      // this advisory request to wake or idle independent CMAF producers; it
      // never rebuilds the shared preview pipeline in segment-relay mode.
      safeSignalSend({
        type: "quality:request",
        height: requestedHeight,
        frameRate: preferredFrameRate || undefined,
        originalDemand:
          requestedHeight === undefined &&
          detectEmbyMediaCapabilities().desktop &&
          Boolean(
            networkReport &&
              Date.now() - networkReport.measuredAt <= 5 * 60_000 &&
              !networkReport.metered &&
              networkReport.networkType !== "cellular" &&
              networkReport.downloadKbps * 1_000 * 0.62 >=
                15_000_000,
          ),
        highDemand:
          requestedHeight === undefined || requestedHeight > 720,
        lowDemand:
          requestedHeight !== undefined && requestedHeight <= 480,
        availableDownloadBps:
          networkReport &&
          Date.now() - networkReport.measuredAt <= 5 * 60_000
            ? Math.max(0, networkReport.downloadKbps) * 1_000
            : undefined,
      });
      if (showFeedback) {
        notify(
          `已仅为当前设备设置 Emby ABR 上限：${
            requestedHeight ? `${requestedHeight}p` : "自动原画"
          }`,
        );
      }
      return;
    }
    if (!embyMode && sfuViewerActive) {
      const updated = sfuSession.setScreenSubscriptionPreference(
        currentSfuScreenPreference(),
      );
      if (updated && showFeedback) {
        const preference = currentSfuScreenPreference();
        notify(
          `已仅为当前设备切换 SFU 订阅层：${preference.height || "原画"}p / ${preference.frameRate || "原"} 帧`,
        );
      }
      return;
    }
    if (
      !safeSignalSend({
        type: "quality:request",
        height: requestedHeight,
        frameRate:
          preferredFrameRate ||
          (!embyMode ? adaptivePlayback.requestedFrameRate : undefined),
      })
    ) {
      return;
    }
    if (showFeedback) {
      notify(
        preferredHeight || preferredFrameRate
          ? embyMode
            ? "已请求兼容共享流切换画质"
            : "已把自动画质上限调整为你的选择"
          : embyMode
            ? "已请求恢复兼容共享流画质"
            : "已恢复自动原画与放映端原帧率",
      );
    }
  }

  function currentSfuBroadcastKey(): string {
    return [
      broadcasterId || "",
      broadcastCapabilities?.mode || "",
      sfuAccess?.expiresAt || 0,
    ].join(":");
  }

  function currentSfuPublishKey(): string {
    if (broadcasterId !== selfId) return "";
    if (broadcastCapabilities?.mode === "emby") {
      return embyBroadcast ? `emby:${embyBroadcast.sessionId}` : "";
    }
    if (!mediaStream || !activePreset) return "";
    const tracks = mediaStream
      .getTracks()
      .filter((track) => track.readyState === "live")
      .map((track) => `${track.kind}:${track.id}`)
      .sort()
      .join(",");
    return tracks
      ? `screen:${tracks}:${activePreset.width}x${activePreset.height}@${activePreset.frameRate}:layers=${resourceBudget.maxSfuLayers}`
      : "";
  }

  function clearSfuPrimaryRecovery(resetAttempts = true): void {
    if (sfuPrimaryRecoveryTimer !== undefined) {
      window.clearTimeout(sfuPrimaryRecoveryTimer);
      sfuPrimaryRecoveryTimer = undefined;
    }
    if (resetAttempts) {
      sfuPrimaryRecoveryAttempts = 0;
      sfuPrimaryRecoveryExhaustedReported = false;
    }
  }

  function scheduleSfuPrimaryRecovery(reason: string): void {
    if (
      leaving ||
      !sfuAccess ||
      sfuPrimaryRecoveryTimer !== undefined ||
      sfuPrimaryRecoveryInFlight
    ) {
      return;
    }
    const publishing = broadcasterId === selfId;
    const watching = Boolean(broadcasterId && broadcasterId !== selfId);
    if (
      (!publishing && !watching) ||
      (publishing &&
        sfuSession.connected &&
        sfuSession.publishing &&
        sfuPublishedKey === currentSfuPublishKey()) ||
      (watching && sfuViewerActive)
    ) {
      clearSfuPrimaryRecovery();
      return;
    }
    if (
      sfuPrimaryRecoveryAttempts >= SFU_PRIMARY_RECOVERY_DELAYS_MS.length
    ) {
      if (!sfuPrimaryRecoveryExhaustedReported) {
        sfuPrimaryRecoveryExhaustedReported = true;
        reportPlaybackDiagnostic("sfu-primary-recovery-exhausted", {
          role: publishing ? "publisher" : "viewer",
          attempts: sfuPrimaryRecoveryAttempts,
          reason,
        });
      }
      return;
    }
    const delay =
      SFU_PRIMARY_RECOVERY_DELAYS_MS[sfuPrimaryRecoveryAttempts] ??
      SFU_PRIMARY_RECOVERY_DELAYS_MS.at(-1)!;
    sfuPrimaryRecoveryTimer = window.setTimeout(() => {
      sfuPrimaryRecoveryTimer = undefined;
      if (leaving || !sfuAccess) return;
      const role =
        broadcasterId === selfId
          ? "publisher"
          : broadcasterId
            ? "viewer"
            : undefined;
      if (!role || (role === "viewer" && sfuViewerActive)) {
        clearSfuPrimaryRecovery();
        return;
      }
      if (role === "viewer" && sfuWatchPromise) {
        scheduleSfuPrimaryRecovery("SFU watch attempt already in progress");
        return;
      }
      sfuPrimaryRecoveryAttempts += 1;
      sfuPrimaryRecoveryInFlight = true;
      void (async () => {
        let recovered = false;
        try {
          if (role === "publisher") {
            recovered = await publishBroadcastToSfu();
          } else {
            // A healthy P2P watcher stays alive until the SFU subscription has
            // actually produced tracks/channels. This makes failback seamless.
            sfuFailedBroadcastKey = "";
            recovered = await beginSfuWatching();
          }
        } finally {
          sfuPrimaryRecoveryInFlight = false;
          if (recovered) {
            const attempts = sfuPrimaryRecoveryAttempts;
            clearSfuPrimaryRecovery();
            reportPlaybackDiagnostic("sfu-primary-recovered", {
              role,
              attempts,
            });
          } else {
            scheduleSfuPrimaryRecovery("SFU primary retry failed");
          }
        }
      })();
    }, delay);
    reportPlaybackDiagnostic("sfu-primary-recovery-scheduled", {
      role: publishing ? "publisher" : "viewer",
      attempt: sfuPrimaryRecoveryAttempts + 1,
      delayMs: delay,
      reason,
    });
  }

  function reportSfuStatus(
    role: "publisher" | "viewer",
    active: boolean,
  ): void {
    if (!signal || !signalFeatures.has("sfu-primary")) return;
    const current =
      role === "publisher"
        ? reportedSfuPublisherActive
        : reportedSfuViewerActive;
    if (current === active) return;
    if (
      !safeSignalSend({
        type: "sfu:status",
        sfuRole: role,
        active,
      })
    ) {
      return;
    }
    if (role === "publisher") {
      reportedSfuPublisherActive = active;
    } else {
      reportedSfuViewerActive = active;
    }
  }

  async function ensureSfuConnection(): Promise<boolean> {
    if (!sfuAccess || leaving) return false;
    return sfuSession.connect(sfuAccess, iceServers);
  }

  function clearSfuStabilityTimer(closeRetained = false): void {
    if (sfuStabilityTimer !== undefined) {
      window.clearTimeout(sfuStabilityTimer);
      sfuStabilityTimer = undefined;
    }
    if (closeRetained) {
      retainedWatcherPc?.close();
      retainedWatcherPc = undefined;
      retainedRemoteStream?.getTracks().forEach((track) => track.stop());
      retainedRemoteStream = undefined;
    }
  }

  function scheduleStableSfuCommit(): void {
    if (!retainedWatcherPc || sfuStabilityTimer !== undefined) return;
    sfuStabilityTimer = window.setTimeout(() => {
      sfuStabilityTimer = undefined;
      if (
        sfuViewerActive &&
        remoteFirstFrame &&
        Date.now() - viewerPresentationProgressAt < 2_500
      ) {
        const previousPeer = retainedWatcherPc;
        clearSfuStabilityTimer(true);
        reportPlaybackDiagnostic("sfu-make-before-break-committed", {
          stabilizationMs: 7_000,
          previousState: previousPeer?.connectionState,
        });
        return;
      }
      if (sfuViewerActive && retainedWatcherPc && !leaving) {
        scheduleStableSfuCommit();
      }
    }, 7_000);
  }

  function prepareSfuViewerSwitch(nextStream?: MediaStream): void {
    clearWatchRetry();
    clearDisconnectGrace();
    if (video && videoFrameCallbackId !== undefined) {
      video.cancelVideoFrameCallback(videoFrameCallbackId);
      videoFrameCallbackId = undefined;
    }
    const previousWatcher = watcherPc;
    const keepP2PUntilStable = Boolean(
      nextStream &&
        previousWatcher &&
        remoteFirstFrame &&
        !["failed", "closed"].includes(previousWatcher.connectionState),
    );
    clearSfuStabilityTimer(true);
    if (keepP2PUntilStable) {
      retainedWatcherPc = previousWatcher;
    } else {
      previousWatcher?.close();
    }
    watcherPc = undefined;
    watcherRelayOnly = false;
    watcherCandidates = [];
    pendingWatcherSignals = [];
    watchAttempts = 0;
    watchRecoveryCycles = 0;
    watchSessionId = "";
    const preserveLastFrame = Boolean(
      keepP2PUntilStable &&
        video &&
        !video.hidden &&
        video.srcObject === remoteStream,
    );
    if (preserveLastFrame) {
      retainedRemoteStream?.getTracks().forEach((track) => track.stop());
      retainedRemoteStream = remoteStream;
      playerStage?.classList.add("playback-recovering");
    } else {
      remoteStream.getTracks().forEach((track) => track.stop());
      retainedRemoteStream?.getTracks().forEach((track) => track.stop());
      retainedRemoteStream = undefined;
    }
    remoteStream = nextStream || new MediaStream();
    const preserveEmbyDataPlane =
      broadcastCapabilities?.mode === "emby" &&
      Boolean(embyViewer && embyAbrViewer?.diagnostics.active);
    if (!preserveEmbyDataPlane) {
      embyAbrViewer?.destroy();
      embyAbrViewer = undefined;
      embyViewer?.destroy();
      embyViewer = undefined;
      embyBufferedAhead = 0;
      embyStartupBufferProgressAt = 0;
      embyStartupLastBufferAhead = 0;
      remoteFirstFrame = false;
    }
    sfuScreenFrameSnapshot = undefined;
    sfuScreenReceiverSnapshot = undefined;
    resetViewerMediaLiveness();
  }

  function requestSegmentRelayTokenRefresh(): void {
    const now = Date.now();
    if (
      !signal ||
      now - lastSegmentRelayRefreshRequestAt < 30_000
    ) {
      return;
    }
    lastSegmentRelayRefreshRequestAt = now;
    safeSignalSend({ type: "segment:token-refresh" });
  }

  function scheduleSegmentRelayTokenRefresh(): void {
    if (segmentRelayRefreshTimer !== undefined) {
      window.clearTimeout(segmentRelayRefreshTimer);
      segmentRelayRefreshTimer = undefined;
    }
    if (!segmentRelayAccess) return;
    const delay = Math.max(
      5_000,
      segmentRelayAccess.expiresAt - Date.now() - 2 * 60_000,
    );
    segmentRelayRefreshTimer = window.setTimeout(() => {
      segmentRelayRefreshTimer = undefined;
      requestSegmentRelayTokenRefresh();
    }, Math.min(delay, 2_147_000_000));
  }

  function updateSegmentRelayAccess(
    value: SegmentRelayAccess | undefined,
  ): void {
    const next = sanitizeSegmentRelayAccess(value);
    if (!next) return;
    segmentRelayAccess = next;
    scheduleSegmentRelayTokenRefresh();
    embyAbrViewer?.updateAccess(next);
    if (next.scope === "publish") {
      embyBroadcast?.setSegmentRelayAccess(signalUrl, next);
    }
  }

  function activatePendingEmbySegmentFallback(
    player: EmbyMsePlayer,
  ): boolean {
    const channel = embyFallbackMediaChannel;
    if (
      !channel ||
      channel.readyState !== "open" ||
      embyViewer !== player ||
      !embyAbrViewer?.diagnostics.relayFallbackActive
    ) {
      return false;
    }
    if (embySegmentFallbackRequested) return true;
    embySegmentFallbackRequested =
      player.enableDataChannelSegmentFallback(
        channel,
        embySegmentFallbackTargetTime ||
          Math.max(0, player.currentTime),
      );
    if (embySegmentFallbackRequested) {
      setStatus(
        "HTTPS 分片服务波动 · 正在确认 P2P 媒体应急链路",
        "neutral",
      );
    }
    return embySegmentFallbackRequested;
  }

  function attachSegmentRelayViewer(
    player: EmbyMsePlayer,
    isActive: () => boolean,
  ): void {
    let observedAbrMediaProgress = 0;
    player.addEventListener("segmentfallbackack", (event) => {
      if (!isActive() || embyViewer !== player) return;
      const detail = (
        event as CustomEvent<{
          requestId: string;
          sessionId: string;
          mediaVersion: number;
          transportEpoch: number;
        }>
      ).detail;
      embySegmentFallbackRequested = true;
      embySegmentFallbackActive = true;
      setStatus(
        "HTTPS 分片服务波动 · P2P 媒体应急链路已接管",
        "neutral",
      );
      reportPlaybackDiagnostic("emby-segment-fallback-acknowledged", {
        mediaVersion: detail.mediaVersion,
        transportEpoch: detail.transportEpoch,
        requestId: detail.requestId,
      });
    });
    player.addEventListener("segmentfallbackfailed", (event) => {
      if (!isActive() || embyViewer !== player || leaving) return;
      const detail = (
        event as CustomEvent<{
          requestId: string;
          mediaVersion: number;
          targetTime: number;
        }>
      ).detail;
      embySegmentFallbackRequested = false;
      embySegmentFallbackActive = false;
      if (embyFallbackMediaChannel?.readyState !== "closed") {
        embyFallbackMediaChannel?.close();
      }
      embyFallbackMediaChannel = undefined;
      reportPlaybackDiagnostic("emby-segment-fallback-failed", {
        requestId: detail.requestId,
        mediaVersion: detail.mediaVersion,
        targetTime: Number(detail.targetTime.toFixed(3)),
      });
      setStatus(
        "P2P 媒体应急确认超时 · 正在重建备用连接",
        "neutral",
      );
      void beginP2PWatching(true);
    });
    player.addEventListener("segmentrelay", (event) => {
      if (
        !isActive() ||
        !segmentRelayAccess ||
        !signalFeatures.has("emby-segment-relay-v1")
      ) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          session: NonNullable<EmbyMsePlayer["activeSession"]>;
          descriptor: {
            protocol: "synced-cmaf-v1";
            sessionId: string;
            assetId: string;
            mediaVersion: number;
            manifestPath: string;
          };
        }>
      ).detail;
      if (embyAbrViewer?.matchesSession(detail.session, detail.descriptor)) {
        embyAbrViewer.updateAccess(segmentRelayAccess);
        embyAbrViewer.setPreferredHeight(effectiveEmbyViewerHeight());
        return;
      }
      player.enableExternalSegmentTransport();
      embyAbrViewer?.destroy();
      const abr = new EmbyAbrSegmentClient({
        player,
        signalUrl,
        access: segmentRelayAccess,
        allowDeepPrefetch: () => resourceBudget.allowDeepPrefetch,
        onTokenExpiring: requestSegmentRelayTokenRefresh,
        onMediaFallbackNeeded: (fallback) => {
          if (!isActive() || embyAbrViewer !== abr || leaving) return;
          embySegmentFallbackTargetTime = fallback.targetTime;
          abr.activateMediaFallback();
          reportPlaybackDiagnostic("emby-segment-fallback-requested", {
            reason: fallback.reason,
            mediaVersion: fallback.mediaVersion,
            targetTime: Number(fallback.targetTime.toFixed(3)),
          });
          if (activatePendingEmbySegmentFallback(player)) return;
          if (sfuViewerActive) {
            void fallbackFromSfu(
              "HTTPS 分片服务暂不可用，正在建立 P2P 媒体应急链路",
            );
          } else {
            void beginP2PWatching(true);
          }
        },
        onRelayRecovered: () => {
          if (
            !isActive() ||
            embyAbrViewer !== abr
          ) {
            return;
          }
          if (embySegmentFallbackRequested) {
            player.releaseDataChannelSegmentFallback();
          }
          player.enableExternalSegmentTransport();
          embySegmentFallbackActive = false;
          embySegmentFallbackRequested = false;
          abr.resumeHttps();
          resetViewerMediaLiveness();
          setStatus("HTTPS 独立 ABR 已稳定恢复", "ready");
          reportPlaybackDiagnostic("emby-segment-fallback-released", {
            mediaVersion: player.activeSession?.mediaVersion,
          });
        },
        onDiagnostic: (diagnostics) => {
          if (!isActive() || embyAbrViewer !== abr) return;
          const mediaProgress =
            diagnostics.appendedSegments +
            diagnostics.cacheHits +
            diagnostics.networkFetches;
          if (mediaProgress > observedAbrMediaProgress) {
            observedAbrMediaProgress = mediaProgress;
            viewerTransportProgressAt = Date.now();
          }
          if (diagnostics.lastError) {
            reportPlaybackDiagnostic("emby-segment-abr-error", {
              renditionId: diagnostics.renditionId,
              message: diagnostics.lastError,
              fetchGeneration: diagnostics.fetchGeneration,
              rangeRetries: diagnostics.rangeRetries,
            });
          }
          if (diagnostics.renditionId) {
            setMediaStatus(
              `${broadcasterNickname || "朋友"}正在 Emby 高清放映 · ` +
                `HTTPS 独立 ABR ${diagnostics.renditionLabel || diagnostics.renditionId} · ` +
                `缓冲 ${embyBufferedAhead.toFixed(1)} 秒`,
            );
          }
        },
      });
      embyAbrViewer = abr;
      abr.setPreferredHeight(effectiveEmbyViewerHeight());
      abr.start(detail.session, detail.descriptor);
      reportPlaybackDiagnostic("emby-segment-abr-started", {
        sessionId: detail.descriptor.sessionId,
        assetId: detail.descriptor.assetId,
        mediaVersion: detail.descriptor.mediaVersion,
      });
    });
  }

  function attachSfuEmbyViewer(
    mediaChannel: RTCDataChannel,
    controlChannel: RTCDataChannel,
  ): void {
    if (!video) throw new Error("Emby viewer video element is unavailable");
    if (embyViewer) {
      embyViewer.attachControlChannel(controlChannel);
      if (!embyAbrViewer?.diagnostics.active) {
        embyViewer.attachChannel(mediaChannel);
      }
      resetViewerMediaLiveness();
      return;
    }
    const player = new EmbyMsePlayer({
      video,
      host: false,
      initialBufferSeconds: nativeAndroid ? 6 : 10,
      targetBufferSeconds: nativeAndroid ? 32 : 52,
      maxBufferSeconds: nativeAndroid ? 48 : 72,
      recoveryStrategy: "transport-fallback",
    });
    embyViewer = player;
    video.srcObject = null;
    video.muted = !soundEnabled;
    video.volume = movieVolume;
    video.autoplay = true;
    video.playsInline = true;
    const active = () =>
      embyViewer === player &&
      broadcastCapabilities?.mode === "emby" &&
      !leaving;
    attachSegmentRelayViewer(player, active);
    player.addEventListener("session", (event) => {
      if (!active()) return;
      const detail = (
        event as CustomEvent<{ title: string; plan: EmbyStreamPlan }>
      ).detail;
      embyStartupBufferProgressAt = Date.now();
      embyStartupLastBufferAhead = 0;
      if (bufferingTitle) bufferingTitle.textContent = "正在缓存 Emby 高清流";
      const bufferingDetail =
        document.querySelector<HTMLElement>("#buffering-detail");
      if (bufferingDetail) {
        bufferingDetail.textContent =
          `正在通过 SFU 缓存 ${detail.title} · ` +
          `${detail.plan.videoCodec.toUpperCase()} / ` +
          `${detail.plan.audioCodec.toUpperCase()} 编码片段…`;
      }
      setMediaStatus(
        `服务器 SFU · Emby ${detail.plan.width}×${detail.plan.height} · 初始缓存中`,
      );
      updateEmbyViewerTimeline();
    });
    player.addEventListener("ready", () => {
      if (active()) confirmEmbyPlaybackReady();
    });
    player.addEventListener("buffer", (event) => {
      if (!active()) return;
      const detail = (
        event as CustomEvent<{
          aheadSeconds: number;
          initialSeconds: number;
          targetSeconds: number;
        }>
      ).detail;
      embyBufferedAhead = Math.max(0, detail.aheadSeconds);
      if (embyBufferedAhead >= embyStartupLastBufferAhead + 0.12) {
        embyStartupBufferProgressAt = Date.now();
        embyStartupLastBufferAhead = embyBufferedAhead;
        viewerTransportProgressAt = Date.now();
      }
      const initial = Math.max(1, detail.initialSeconds || 8);
      if (!remoteFirstFrame && bufferingProgress) {
        bufferingProgress.max = initial;
        bufferingProgress.value = Math.min(initial, embyBufferedAhead);
      }
      setMediaStatus(
        `${broadcasterNickname || "朋友"}正在 Emby 高清放映 · ` +
          `服务器 SFU · 缓冲 ${embyBufferedAhead.toFixed(1)} 秒`,
      );
    });
    player.addEventListener("playbackstate", (event) => {
      if (!active()) return;
      const detail = (
        event as CustomEvent<{
          paused: boolean;
          currentTime: number;
          playbackRate: number;
        }>
      ).detail;
      embyHostPaused = detail.paused;
      embyHostPauseStateKnown = true;
      viewerPresentationProgressAt = Date.now();
      updateEmbyViewerTimeline();
      setStatus(
        detail.paused
          ? "放映端已暂停 · 等待继续播放"
          : remoteFirstFrame
            ? "Emby 高清流已到达 · SFU 播放中"
            : "SFU 已连接 · 正在缓存 Emby 高清流",
        detail.paused ? "neutral" : "ready",
      );
    });
    player.addEventListener("error", (event) => {
      if (!active()) return;
      const message =
        (event as CustomEvent<string>).detail || "SFU Emby 数据无法播放";
      reportPlaybackDiagnostic("sfu-emby-player-error", { message });
      void fallbackFromSfu("SFU Emby 播放异常，正在切换 P2P 备用链路");
    });
    player.addEventListener("disconnected", () => {
      if (active() && !leaving) {
        void fallbackFromSfu(
          "SFU Emby 数据通道中断，正在切换 P2P 备用链路",
        );
      }
    });
    player.addEventListener("recoveryneeded", (event) => {
      if (!active() || leaving) return;
      const detail = (
        event as CustomEvent<{ reason?: string }>
      ).detail;
      reportPlaybackDiagnostic("sfu-emby-viewer-isolated-fallback", {
        reason: detail?.reason || "viewer-recovery-needed",
        broadcasterId,
      });
      void fallbackFromSfu(
        "当前观众的 SFU 缓存已中断，正在单独切换 P2P 备用链路",
      );
    });
    player.attachControlChannel(controlChannel);
    player.attachChannel(mediaChannel);
  }

  async function beginSfuWatching(): Promise<boolean> {
    const watchEpoch = ++sfuWatchEpoch;
    const expectedBroadcasterId = broadcasterId;
    if (
      !expectedBroadcasterId ||
      expectedBroadcasterId === selfId ||
      !sfuAccess ||
      (broadcastCapabilities?.mode === "emby" &&
        (embySegmentFallbackActive ||
          embySegmentFallbackRequested ||
          embyAbrViewer?.diagnostics.relayFallbackActive))
    ) {
      return false;
    }
    const key = currentSfuBroadcastKey();
    if (sfuFailedBroadcastKey === key) return false;
    setStatus("正在连接服务器 SFU 主线路", "neutral");
    try {
      if (!(await ensureSfuConnection())) {
        throw new Error("SFU server is unavailable");
      }
      if (
        leaving ||
        watchEpoch !== sfuWatchEpoch ||
        broadcasterId !== expectedBroadcasterId ||
      !broadcastCapabilities
      ) {
        if (watchEpoch === sfuWatchEpoch) {
          await sfuSession.stopWatching().catch(() => undefined);
        }
        return false;
      }
      if (broadcastCapabilities.mode === "emby") {
        const controlOnly =
          signalFeatures.has("emby-segment-relay-v1") &&
          Boolean(segmentRelayAccess);
        const channels = await sfuSession.watchEmby(
          expectedBroadcasterId,
          10_000,
          controlOnly,
        );
        if (
          watchEpoch !== sfuWatchEpoch ||
          broadcasterId !== expectedBroadcasterId ||
          leaving
        ) {
          if (watchEpoch === sfuWatchEpoch) {
            await sfuSession.stopWatching().catch(() => undefined);
          }
          return false;
        }
        prepareSfuViewerSwitch();
        sfuViewerActive = true;
        reportSfuStatus("viewer", true);
        attachSfuEmbyViewer(
          channels.mediaChannel,
          channels.controlChannel,
        );
        showWaitingStage("SFU 已连接，正在接收 Emby 编码片段…");
      } else {
        const stream = await sfuSession.watchScreen(
          expectedBroadcasterId,
          currentSfuScreenPreference(),
        );
        if (
          watchEpoch !== sfuWatchEpoch ||
          broadcasterId !== expectedBroadcasterId ||
          leaving
        ) {
          if (watchEpoch === sfuWatchEpoch) {
            await sfuSession.stopWatching().catch(() => undefined);
          }
          return false;
        }
        prepareSfuViewerSwitch(stream);
        sfuViewerActive = true;
        reportSfuStatus("viewer", true);
        for (const track of stream.getTracks()) {
          track.addEventListener(
            "ended",
            () => {
              if (
                sfuViewerActive &&
                broadcasterId === expectedBroadcasterId &&
                !leaving
              ) {
                void fallbackFromSfu(
                  "SFU 媒体轨已中断，正在切换 P2P 备用链路",
                );
              }
            },
            { once: true },
          );
        }
        attachRemoteStream();
        setStatus("SFU 媒体已连接 · 等待视频首帧", "ready");
      }
      sfuFailedBroadcastKey = "";
      clearSfuPrimaryRecovery();
      sendViewerQualityPreference(false);
      reportPlaybackDiagnostic("sfu-viewer-active", {
        broadcasterId: expectedBroadcasterId,
        mode: broadcastCapabilities.mode,
      });
      return true;
    } catch (error) {
      if (watchEpoch !== sfuWatchEpoch) return false;
      sfuViewerActive = false;
      reportSfuStatus("viewer", false);
      sfuFailedBroadcastKey = key;
      await sfuSession.stopWatching().catch(() => undefined);
      reportPlaybackDiagnostic("sfu-viewer-fallback", {
        broadcasterId: expectedBroadcasterId,
        message: error instanceof Error ? error.message : String(error),
      });
      setStatus("服务器 SFU 暂不可用 · 正在启用 P2P 备用链路", "neutral");
      scheduleSfuPrimaryRecovery("initial SFU viewer attempt failed");
      return false;
    }
  }

  async function fallbackFromSfu(reason: string): Promise<void> {
    if (!sfuViewerActive || leaving) return;
    const warmFallbackPeer = retainedWatcherPc;
    const warmFallbackStream = retainedRemoteStream;
    const canWarmFallback = Boolean(
      broadcastCapabilities?.mode !== "emby" &&
        warmFallbackPeer &&
        warmFallbackStream?.getVideoTracks().some(
          (track) => track.readyState === "live",
        ) &&
        !["failed", "closed"].includes(
          warmFallbackPeer!.connectionState,
        ),
    );
    sfuFailedBroadcastKey = currentSfuBroadcastKey();
    sfuViewerActive = false;
    reportSfuStatus("viewer", false);
    await sfuSession.stopWatching().catch(() => undefined);
    if (canWarmFallback && warmFallbackPeer && warmFallbackStream) {
      clearSfuStabilityTimer();
      retainedWatcherPc = undefined;
      retainedRemoteStream = undefined;
      remoteStream.getTracks().forEach((track) => track.stop());
      remoteStream = warmFallbackStream;
      watcherPc = warmFallbackPeer;
      remoteFirstFrame = true;
      resetViewerMediaLiveness();
      attachRemoteStream(warmFallbackPeer);
      setStatus(`${reason} · P2P 热备用已接管`, "neutral");
      reportPlaybackDiagnostic("sfu-warm-p2p-fallback", {
        reason,
        broadcasterId,
        peerState: warmFallbackPeer.connectionState,
      });
      scheduleSfuPrimaryRecovery("runtime SFU viewer fallback");
      return;
    }
    clearSfuStabilityTimer(true);
    if (broadcastCapabilities?.mode !== "emby") {
      embyAbrViewer?.destroy();
      embyAbrViewer = undefined;
      embyViewer?.destroy();
      embyViewer = undefined;
    }
    watchAttempts = 0;
    setStatus(reason, "neutral");
    reportPlaybackDiagnostic("sfu-runtime-fallback", {
      reason,
      broadcasterId,
      mode: broadcastCapabilities?.mode,
    });
    await beginP2PWatching(true);
    scheduleSfuPrimaryRecovery("runtime SFU viewer fallback");
  }

  async function beginWatching(recreate = false): Promise<void> {
    if (sfuViewerActive) return;
    const requestedKey = currentSfuBroadcastKey();
    if (
      sfuAccess &&
      sfuFailedBroadcastKey !== requestedKey
    ) {
      if (sfuWatchPromise && sfuWatchKey !== requestedKey) {
        sfuWatchEpoch += 1;
        await sfuSession.stopWatching().catch(() => undefined);
        await sfuWatchPromise.catch(() => false);
        if (leaving || !broadcasterId || broadcasterId === selfId) return;
        return beginWatching(recreate);
      }
      if (!sfuWatchPromise) {
        sfuWatchKey = requestedKey;
        const pending = beginSfuWatching();
        sfuWatchPromise = pending;
        void pending.finally(() => {
          if (sfuWatchPromise === pending) {
            sfuWatchPromise = undefined;
            sfuWatchKey = "";
          }
        });
      }
      const attemptedKey = sfuWatchKey;
      if (await sfuWatchPromise) return;
      if (
        attemptedKey !== currentSfuBroadcastKey() &&
        !leaving &&
        broadcasterId &&
        broadcasterId !== selfId
      ) {
        return beginWatching(recreate);
      }
    }
    await beginP2PWatching(recreate);
  }

  async function publishBroadcastToSfu(): Promise<boolean> {
    const publishKey = currentSfuPublishKey();
    if (!sfuAccess || !publishKey || broadcasterId !== selfId) return false;
    if (
      sfuSession.connected &&
      sfuSession.publishing &&
      sfuPublishedKey === publishKey
    ) {
      clearSfuPrimaryRecovery();
      return true;
    }
    if (sfuPublishPromise) {
      await sfuPublishPromise;
      if (leaving || broadcasterId !== selfId) return false;
      return publishBroadcastToSfu();
    }
    const expectedMode = broadcastCapabilities?.mode;
    const expectedSfuAccess = sfuAccess;
    const expectedEmbyController = embyBroadcast;
    const expectedStream = mediaStream;
    const expectedPreset = activePreset;
    const stillCurrent = (): boolean =>
      !leaving &&
      sfuAccess === expectedSfuAccess &&
      broadcasterId === selfId &&
      currentSfuPublishKey() === publishKey &&
      (expectedMode === "emby"
        ? embyBroadcast === expectedEmbyController
        : mediaStream === expectedStream && activePreset === expectedPreset);
    const operation = (async (): Promise<boolean> => {
    try {
      if (!(await ensureSfuConnection())) {
        throw new Error("SFU server is unavailable");
      }
      if (!stillCurrent()) return false;
      if (expectedMode === "emby") {
        if (!expectedEmbyController) {
          throw new Error("Emby broadcast is unavailable");
        }
        const channels = await sfuSession.publishEmby({
          controlOnly: expectedEmbyController.segmentRelayActive,
        });
        if (!stillCurrent()) {
          await sfuSession.stopPublishing().catch(() => undefined);
          return false;
        }
        expectedEmbyController.attachTransport(
          SFU_EMBY_VIEWER_ID,
          channels.mediaChannel,
          channels.controlChannel,
        );
      } else {
        if (!expectedStream || !expectedPreset) {
          throw new Error("Screen capture is unavailable");
        }
        await sfuSession.publishScreen(expectedStream, {
          maxBitrate: expectedPreset.maxBitrate,
          frameRate: expectedPreset.frameRate,
          maxLayers: resourceBudget.maxSfuLayers,
          contentMode: screenContentMode,
        });
      }
      if (!stillCurrent()) {
        expectedEmbyController?.detachViewer(SFU_EMBY_VIEWER_ID);
        await sfuSession.stopPublishing().catch(() => undefined);
        sfuPublishedKey = "";
        return false;
      }
      sfuPublishedKey = publishKey;
      clearSfuPrimaryRecovery();
      reportPlaybackDiagnostic("sfu-broadcast-active", {
        mode: expectedMode,
        maxBitrate: expectedPreset?.maxBitrate,
      });
      reportSfuStatus("publisher", true);
      setMediaStatus(
        expectedMode === "emby"
          ? "Emby 高清 · 服务器 SFU 单路上传 · P2P 故障兜底"
          : "服务器 SFU 单路上传 · P2P 故障兜底",
      );
      return true;
    } catch (error) {
      sfuPublishedKey = "";
      reportSfuStatus("publisher", false);
      expectedEmbyController?.detachViewer(SFU_EMBY_VIEWER_ID);
      await sfuSession.stopPublishing().catch(() => undefined);
      reportPlaybackDiagnostic("sfu-broadcast-fallback", {
        message: error instanceof Error ? error.message : String(error),
        mode: expectedMode,
      });
      if (stillCurrent()) {
        setStatus("SFU 发布失败 · 已保留 P2P 备用放映", "neutral");
        scheduleSfuPrimaryRecovery("SFU publisher attempt failed");
      }
      return false;
    }
    })();
    sfuPublishPromise = operation;
    try {
      return await operation;
    } finally {
      if (sfuPublishPromise === operation) sfuPublishPromise = undefined;
    }
  }

  async function replacePublishedSfuScreenTrack(
    track: MediaStreamTrack,
    reason: string,
  ): Promise<boolean> {
    if (!sfuSession.publishing || localBroadcastMode !== "screen") {
      return true;
    }
    try {
      const replaced = await sfuSession.replacePublishedScreenTrack(track);
      if (!replaced) {
        throw new Error(`SFU has no published ${track.kind} track`);
      }
      sfuPublishedKey = currentSfuPublishKey();
      return true;
    } catch (error) {
      reportPlaybackDiagnostic("sfu-screen-track-replace-failed", {
        kind: track.kind,
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
      reportSfuStatus("publisher", false);
      sfuPublishedKey = "";
      // Do not leave every SFU viewer attached to a permanently frozen old
      // publication. Ending it makes only those viewers enter their existing
      // P2P fallback path while the local capture and P2P senders stay alive.
      await sfuSession.stopPublishing().catch(() => undefined);
      setStatus("SFU 发布轨更新失败 · 已保留 P2P 备用放映", "neutral");
      scheduleSfuPrimaryRecovery("SFU published screen track replacement failed");
      return false;
    }
  }

  async function beginP2PWatching(recreate = false): Promise<void> {
    if (!signal || !broadcasterId || broadcasterId === selfId) return;
    if (watchInFlight) return;
    if (recreate && watchAttempts >= 5) {
      scheduleNextWatchCycle("本轮媒体协商仍未稳定");
      return;
    }
    watchInFlight = true;
    try {
    clearWatchRetry();
    const attempt = watchAttempts + 1;
    watchAttempts = attempt;
    if (
      attempt > 1 &&
      broadcastCapabilities?.mode !== "emby"
    ) {
      const startupReduction = adaptivePlayback.forceDegrade(
        "首帧在当前码率下持续未到达",
      );
      if (startupReduction.changed) {
        reportPlaybackDiagnostic("screen-startup-quality-down", {
          attempt,
          requestedHeight: startupReduction.requestedHeight,
        });
      }
    }
    const preserveLastFrame = Boolean(
      recreate &&
        remoteFirstFrame &&
        video &&
        !video.hidden &&
        video.srcObject,
    );
    if (recreate || !watcherPc) {
      const sessionId =
        crypto.randomUUID?.() ||
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      watchSessionId = sessionId;
      clearDisconnectGrace();
      remoteFirstFrame = false;
      if (video && videoFrameCallbackId !== undefined) {
        video.cancelVideoFrameCallback(videoFrameCallbackId);
        videoFrameCallbackId = undefined;
      }
      watcherPc?.close();
      const useRelayOnly =
        networkAdvice.routeMode === "relay-preferred";
      const peer = createPeerConnection(
        iceServers,
        (candidate) => {
          if (watcherPc !== peer) return;
          safeSignalSend({
            type: "signal",
            target: "broadcaster",
            data: candidate,
            attempt,
            sessionId,
          });
        },
        {
          // A recipient whose own probe proved direct ICE unavailable starts
          // with TURN. Everyone else keeps direct and relay candidates so ICE
          // can choose the best measured route.
          relayOnly: useRelayOnly,
          candidatePolicy: "balanced",
          localAddresses: localDirectAddresses,
        },
      );
      watcherPc = peer;
      watcherRelayOnly = useRelayOnly;
      configureMovieJitterBuffer(peer);
      watcherCandidates = [];
      if (preserveLastFrame) {
        retainedRemoteStream?.getTracks().forEach((track) => track.stop());
        retainedRemoteStream = remoteStream;
      } else {
        remoteStream.getTracks().forEach((track) => track.stop());
      }
      remoteStream = new MediaStream();
      embyFallbackMediaChannel = undefined;
      embySegmentFallbackActive = false;
      embySegmentFallbackRequested = false;
      if (broadcastCapabilities?.mode !== "emby") {
        embyAbrViewer?.destroy();
        embyAbrViewer = undefined;
        embyViewer?.destroy();
        embyViewer = undefined;
        embyBufferedAhead = 0;
        embyStartupBufferProgressAt = 0;
        embyStartupLastBufferAhead = 0;
      }
      if (broadcastCapabilities?.mode === "emby") {
        peer.addEventListener("datachannel", (event) => {
          if (
            watcherPc !== peer ||
            ![
              EMBY_DATA_CHANNEL_LABEL,
              EMBY_CONTROL_CHANNEL_LABEL,
            ].includes(event.channel.label)
          ) {
            event.channel.close();
            return;
          }
          if (event.channel.label === EMBY_DATA_CHANNEL_LABEL) {
            embyFallbackMediaChannel = event.channel;
            const activateFallback = () => {
              if (
                watcherPc === peer &&
                embyFallbackMediaChannel === event.channel &&
                embyViewer
              ) {
                activatePendingEmbySegmentFallback(embyViewer);
              }
            };
            event.channel.addEventListener("open", activateFallback, {
              once: true,
            });
            event.channel.addEventListener(
              "close",
              () => {
                if (embyFallbackMediaChannel === event.channel) {
                  embyFallbackMediaChannel = undefined;
                  embySegmentFallbackActive = false;
                  embySegmentFallbackRequested = false;
                }
              },
              { once: true },
            );
          }
          let player = embyViewer;
          if (!player) {
            player = new EmbyMsePlayer({
              video: video!,
              host: false,
              initialBufferSeconds: nativeAndroid ? 6 : 10,
              targetBufferSeconds: nativeAndroid ? 32 : 52,
              maxBufferSeconds: nativeAndroid ? 48 : 72,
            });
            embyViewer = player;
            attachSegmentRelayViewer(
              player,
              () =>
                embyViewer === player &&
                broadcastCapabilities?.mode === "emby" &&
                !leaving,
            );
            if (video) {
              video.muted = !soundEnabled;
              video.volume = movieVolume;
              video.autoplay = true;
              video.playsInline = true;
            }
            player.addEventListener("session", (sessionEvent) => {
            const detail = (
              sessionEvent as CustomEvent<{
                title: string;
                plan: EmbyStreamPlan;
              }>
            ).detail;
            if (
              embyViewer !== player ||
              broadcastCapabilities?.mode !== "emby" ||
              leaving
            ) return;
            embyStartupBufferProgressAt = Date.now();
            embyStartupLastBufferAhead = 0;
            const bufferingDetail =
              document.querySelector<HTMLElement>("#buffering-detail");
            if (bufferingDetail) {
              bufferingDetail.textContent =
                `正在缓存 ${detail.title} · ${detail.plan.videoCodec.toUpperCase()} / ${detail.plan.audioCodec.toUpperCase()} 编码片段…`;
            }
            if (bufferingTitle) {
              bufferingTitle.textContent = "正在缓存 Emby 高清流";
            }
            setMediaStatus(
              `Emby ${detail.plan.width}×${detail.plan.height} · 初始缓存中`,
            );
            updateEmbyViewerTimeline();
          });
            player.addEventListener("ready", () => {
            if (
              embyViewer === player &&
              broadcastCapabilities?.mode === "emby" &&
              !leaving
            ) {
              confirmEmbyPlaybackReady();
            }
          });
            player.addEventListener("buffer", (bufferEvent) => {
            if (
              embyViewer !== player ||
              broadcastCapabilities?.mode !== "emby" ||
              leaving
            ) return;
            const detail = (
              bufferEvent as CustomEvent<{
                aheadSeconds: number;
                initialSeconds: number;
                targetSeconds: number;
              }>
            ).detail;
            embyBufferedAhead = Math.max(0, detail.aheadSeconds);
            if (
              embyBufferedAhead >= embyStartupLastBufferAhead + 0.12
            ) {
              embyStartupBufferProgressAt = Date.now();
              embyStartupLastBufferAhead = embyBufferedAhead;
            }
            const text = `Emby 高清播放 · 前向缓存 ${detail.aheadSeconds.toFixed(1)} 秒`;
            if (!remoteFirstFrame) {
              const initial = Math.max(1, detail.initialSeconds || 8);
              const percent = Math.min(
                100,
                Math.round((detail.aheadSeconds / initial) * 100),
              );
              const bufferingDetail =
                document.querySelector<HTMLElement>("#buffering-detail");
              if (bufferingDetail) {
                bufferingDetail.textContent =
                  `正在缓存 ${player!.activeSession?.title || "Emby 媒体"} · ${percent}%（${detail.aheadSeconds.toFixed(1)} / ${initial.toFixed(0)} 秒）`;
              }
              if (bufferingProgress) {
                bufferingProgress.max = initial;
                bufferingProgress.value = Math.min(
                  initial,
                  Math.max(0, detail.aheadSeconds),
                );
              }
            }
            if (!remoteFirstFrame) {
              if (receiverStreamBadge) {
                receiverStreamBadge.textContent = text;
                receiverStreamBadge.hidden = false;
              }
              if (mobilePlaybackStats) mobilePlaybackStats.textContent = text;
              if (desktopPlaybackStats) {
                desktopPlaybackStats.textContent = text;
              }
            } else {
              setMediaStatus(
                `${broadcasterNickname || "朋友"}正在 Emby 高清放映 · ${text}`,
              );
            }
          });
          player.addEventListener("playbackstate", (playbackEvent) => {
            if (
              embyViewer !== player ||
              broadcastCapabilities?.mode !== "emby" ||
              leaving
            ) return;
            const detail = (
              playbackEvent as CustomEvent<{
                paused: boolean;
                currentTime: number;
                playbackRate: number;
              }>
            ).detail;
            const pauseStateChanged = embyPauseStateChanged({
              known: embyHostPauseStateKnown,
              previousPaused: embyHostPaused,
              nextPaused: detail.paused,
            });
            embyHostPaused = detail.paused;
            embyHostPauseStateKnown = true;
            if (pauseStateChanged) {
              resetViewerMediaLiveness();
              reportPlaybackDiagnostic("emby-host-pause-state", {
                paused: detail.paused,
                currentTime: Number(detail.currentTime.toFixed(3)),
              });
            }
            updateEmbyViewerTimeline();
            if (detail.paused) {
              setStatus("放映端已暂停 · 等待继续播放", "neutral");
              setMediaStatus(
                `${broadcasterNickname || "朋友"}已暂停 Emby 放映 · ${formatPlaybackTime(detail.currentTime)}`,
              );
            } else if (remoteFirstFrame) {
              setStatus("Emby 高清流已到达 · 播放中", "ready");
            }
          });
            player.addEventListener("error", (errorEvent) => {
            if (
              embyViewer !== player ||
              broadcastCapabilities?.mode !== "emby" ||
              leaving
            ) return;
            const message =
              (errorEvent as CustomEvent<string>).detail ||
              "Emby 编码片段无法播放";
            setStatus("Emby 高清播放失败", "error");
            notify(message, true);
            if (retryButton) retryButton.hidden = false;
          });
            player.addEventListener("disconnected", () => {
            if (watcherPc === peer && embyViewer === player && !leaving) {
              retryWatching("Emby 数据通道中断，正在重新连接", true);
            }
            });
          }
          if (event.channel.label === EMBY_CONTROL_CHANNEL_LABEL) {
            player.attachControlChannel(event.channel);
            event.channel.addEventListener(
              "open",
              () => activatePendingEmbySegmentFallback(player!),
              { once: true },
            );
            activatePendingEmbySegmentFallback(player);
          } else if (embyAbrViewer?.diagnostics.active) {
            activatePendingEmbySegmentFallback(player);
          } else {
            player.attachChannel(event.channel);
          }
        });
      }
      peer.addEventListener("track", (event) => {
        if (broadcastCapabilities?.mode === "emby") return;
        if (watcherPc !== peer) return;
        configureMovieJitterBuffer(peer);
        if (!remoteStream.getTracks().some((track) => track.id === event.track.id)) {
          remoteStream.addTrack(event.track);
        }
        const attachWhenReady = (): void => {
          if (watcherPc === peer) attachRemoteStream(peer);
        };
        if (event.track.kind !== "video") {
          // Audio often arrives before video. Android WebView needs a
          // dedicated audio element to make a late WebRTC track reliably
          // audible, so attach it immediately instead of waiting for video.
          if (nativeAndroid) void playNativeMovieAudio(true);
          event.track.addEventListener(
            "ended",
            () => {
              if (
                watcherPc === peer &&
                remoteFirstFrame &&
                broadcastCapabilities?.mode !== "emby"
              ) {
                armViewerAudioTrackCheck(800);
              }
            },
            { once: true },
          );
          const attachedVideo = video;
          if (attachedVideo?.srcObject === remoteStream) {
            attachedVideo.muted = nativeAndroid ? true : !soundEnabled;
            void attachedVideo.play().catch(() => undefined);
          }
          return;
        }
        event.track.addEventListener(
          "unmute",
          attachWhenReady,
          { once: true },
        );
        if (!event.track.muted) attachWhenReady();
      });
      peer.addEventListener("connectionstatechange", () => {
        if (watcherPc !== peer) return;
        if (peer.connectionState === "connected") {
          clearDisconnectGrace();
          setStatus(
            remoteFirstFrame
              ? broadcastCapabilities?.mode === "emby"
                ? "Emby 高清流已到达 · 播放中"
                : "画面已到达 · 播放中"
              : broadcastCapabilities?.mode === "emby"
                ? "P2P 已连接 · 正在接收 Emby 编码片段"
                : "媒体已连接 · 等待视频首帧",
            "ready",
          );
        } else if (peer.connectionState === "disconnected") {
          clearDisconnectGrace();
          setStatus("连接短暂中断 · 正在等待 ICE 自愈", "neutral");
          disconnectGraceTimer = window.setTimeout(() => {
            disconnectGraceTimer = undefined;
            if (watcherPc === peer && peer.connectionState === "disconnected") {
              setStatus("连接仍未恢复 · 正在重启 ICE", "neutral");
              safeSignalSend({
                type: "media:ice-restart",
                attempt: watchAttempts,
                sessionId: watchSessionId,
              });
            }
          }, 4_000);
          disconnectReplaceTimer = window.setTimeout(() => {
            disconnectReplaceTimer = undefined;
            if (watcherPc === peer && peer.connectionState === "disconnected") {
              retryWatching("ICE 重启后仍未恢复，正在重建媒体连接", true);
            }
          }, 8_000);
        } else if (peer.connectionState === "failed") {
          clearDisconnectGrace();
          retryWatching("当前链路失败，正在切换兼容连接", true);
        }
      });
    }
    if (preserveLastFrame) {
      playerStage?.classList.add("playback-recovering");
      setStatus("网络波动 · 正在后台恢复画面", "neutral");
      setMediaStatus(
        `${broadcasterNickname || "朋友"}正在放映 · 正在无缝恢复 P2P`,
      );
    } else {
      showWaitingStage(
        attempt > 1
          ? `第 ${attempt} 次重新协商：${directAttemptLabel(attempt)}`
          : `已通知放映端，${directAttemptLabel(attempt)}`,
      );
    }
    if (
      !safeSignalSend({
        type: "broadcast:watch-ready",
        attempt,
        codecs: receiverCodecNames(),
        embyCapabilities: detectEmbyMediaCapabilities(),
        sessionId: watchSessionId,
      })
    ) {
      setStatus("信令连接已中断 · 正在恢复频道", "neutral");
      scheduleSignalReconnect(true);
      return;
    }
    sendViewerQualityPreference(false);
    for (const pending of pendingWatcherSignals.splice(0)) {
      await handleWatcherSignal(
        pending.data,
        pending.attempt,
        pending.sessionId,
      );
    }
    armWatchRetry();
    } finally {
      watchInFlight = false;
    }
  }

  async function handleWatcherSignal(
    data: RTCSessionDescriptionInit | RTCIceCandidateInit,
    attempt?: number,
    sessionId?: string,
  ): Promise<void> {
    const remotePolicy = "balanced";
    if (
      !("type" in data) &&
      !isUsableIceCandidate(data, remotePolicy)
    ) {
      return;
    }
    if (attempt !== undefined && attempt !== watchAttempts) {
      return;
    }
    if (sessionId && sessionId !== watchSessionId) {
      return;
    }
    if (!watcherPc) {
      queuePendingWatcherSignal(pendingWatcherSignals, {
        data,
        attempt,
        sessionId,
      });
      return;
    }
    const peer = watcherPc;
    if ("type" in data && data.type) {
      await boundedRtcOperation(
        peer.setRemoteDescription(
          stripUnsafeIceCandidates(
            data as RTCSessionDescriptionInit,
            remotePolicy,
          ),
        ),
        "应用放映端远端描述超时",
      );
      configureMovieJitterBuffer(peer);
      if (watcherPc !== peer) return;
      for (const candidate of watcherCandidates.splice(0)) {
        if (watcherPc !== peer) return;
        try {
          await boundedRtcOperation(
            peer.addIceCandidate(candidate),
            "应用放映端 ICE candidate 超时",
            RTC_CANDIDATE_TIMEOUT_MS,
          );
        } catch {
          // A candidate from a superseded ICE generation is safe to ignore.
        }
      }
      if (data.type === "offer") {
        const answer = tuneMovieSdp(
          await boundedRtcOperation(
            peer.createAnswer(),
            "创建观看端 P2P answer 超时",
          ),
          videoTiasBitrate(data as RTCSessionDescriptionInit) ?? 32_000_000,
        );
        if (watcherPc !== peer) return;
        await boundedRtcOperation(
          peer.setLocalDescription(answer),
          "设置观看端本地描述超时",
        );
        if (watcherPc !== peer) return;
        safeSignalSend({
          type: "signal",
          target: "broadcaster",
          data: exposeLocalIceDescription(
            stripUnsafeIceCandidates(
              peer.localDescription!,
              "balanced",
              localDirectAddresses,
            ),
            localDirectAddresses,
          ),
          attempt: watchAttempts,
          sessionId: watchSessionId,
        });
      }
    } else if (peer.remoteDescription) {
      try {
        await boundedRtcOperation(
          peer.addIceCandidate(data as RTCIceCandidateInit),
          "应用放映端实时 ICE candidate 超时",
          RTC_CANDIDATE_TIMEOUT_MS,
        );
      } catch {
        // Ignore late candidates from an already replaced negotiation.
      }
    } else {
      queuePendingMediaCandidate(
        watcherCandidates,
        data as RTCIceCandidateInit,
      );
    }
  }

  function closeWatcher(): void {
    sfuWatchEpoch += 1;
    clearSfuPrimaryRecovery();
    sfuViewerActive = false;
    reportSfuStatus("viewer", false);
    void sfuSession.stopWatching().catch(() => undefined);
    if (isPictureInPictureActive()) {
      void document.exitPictureInPicture().catch(() => undefined);
    }
    clearWatchRetry();
    clearDisconnectGrace();
    if (video && videoFrameCallbackId !== undefined) {
      video.cancelVideoFrameCallback(videoFrameCallbackId);
      videoFrameCallbackId = undefined;
    }
    if (viewerStatsTimer) window.clearInterval(viewerStatsTimer);
    if (autoSoundRetryTimer !== undefined) {
      window.clearTimeout(autoSoundRetryTimer);
      autoSoundRetryTimer = undefined;
    }
    viewerStatsTimer = undefined;
    viewerStatsEpoch += 1;
    viewerStatsPollRunning = false;
    viewerStatsOutstanding = 0;
    viewerStatsFailures = 0;
    clearViewerAudioTrackTimer();
    viewerAudioMissing = false;
    inboundSnapshot = undefined;
    inboundAudioSnapshot = undefined;
    p2pScreenFrameSnapshot = undefined;
    sfuScreenFrameSnapshot = undefined;
    sfuScreenReceiverSnapshot = undefined;
    viewerAudioStalledSamples = 0;
    viewerAudioEverReceived = false;
    embyDataSnapshot = undefined;
    embyFrameSnapshot = undefined;
    embyLivenessFrameSnapshot = undefined;
    embyBufferedAhead = 0;
    embyStartupBufferProgressAt = 0;
    embyStartupLastBufferAhead = 0;
    embyHostPaused = false;
    embyHostPauseStateKnown = false;
    viewerTransportProgressAt = 0;
    viewerPresentationProgressAt = 0;
    viewerRecoveryStartedAt = 0;
    firstFrameRepairStartedAt = 0;
    embyLastPlaybackTime = 0;
    viewerBandwidthWarningShown = false;
    embyAbrViewer?.destroy();
    embyAbrViewer = undefined;
    embyViewer?.destroy();
    embyViewer = undefined;
    embyFallbackMediaChannel = undefined;
    embySegmentFallbackActive = false;
    embySegmentFallbackRequested = false;
    embySegmentFallbackTargetTime = 0;
    watcherPc?.close();
    watcherPc = undefined;
    clearSfuStabilityTimer(true);
    watcherRelayOnly = false;
    watcherCandidates = [];
    pendingWatcherSignals = [];
    remoteStream.getTracks().forEach((track) => track.stop());
    remoteStream = new MediaStream();
    resetNativeMovieAudio();
    retainedRemoteStream?.getTracks().forEach((track) => track.stop());
    retainedRemoteStream = undefined;
    watchAttempts = 0;
    watchRecoveryCycles = 0;
    watchInFlight = false;
    watchSessionId = "";
    remoteFirstFrame = false;
    lastIceDiagnostics = undefined;
    oneWayPathObserved = false;
    virtualCandidateObserved = false;
    adaptivePlayback.resetSamples();
    embyAdaptiveHeight = 0;
    embyAdaptivePressureSamples = 0;
    embyAdaptiveStableSamples = 0;
    embyAdaptiveChangedAt = 0;
    lastPlaybackDiagnosticAt = 0;
    playerStage?.classList.remove("playback-recovering");
    hideReceiverStreamBadge();
    updatePictureInPictureButton();
  }

  function codecOrderForAttempt(
    viewerId: string,
    attempt = 1,
    supportedCodecs: string[] = [],
  ): string[] {
    const rotations = [
      activePreset!.codecOrder,
      ["video/VP9", "video/H264", "video/AV1", "video/VP8"],
      ["video/VP8", "video/H264", "video/VP9", "video/AV1"],
    ];
    const supported = new Set(
      supportedCodecs.map((codec) => codec.toLowerCase()),
    );
    const preferred = rotations[Math.min(Math.max(attempt, 1), 3) - 1];
    const compatible = supported.size
      ? preferred.filter((codec) => supported.has(codec.toLowerCase()))
      : preferred;
    const order = [...compatible, ...activePreset!.codecOrder].filter(
      (codec, index, values) =>
        values.findIndex(
          (candidate) => candidate.toLowerCase() === codec.toLowerCase(),
        ) === index,
    );
    return deferFailedVideoCodecs(
      order,
      failedVideoCodecsByViewer.get(viewerId) || [],
    );
  }

  function forgetDepartedViewer(viewerId: string): void {
    embyBroadcast?.detachViewer(viewerId);
    const peer = outboundPeers.get(viewerId);
    if (peer) {
      outboundPeers.delete(viewerId);
      peer.pc.close();
      rebalanceScreenP2pFallbackBudgets();
    }
    failedVideoCodecsByViewer.delete(viewerId);
    receiverPreferences.delete(viewerId);
    updateEmbySegmentRenditionDemand();
    const pressureRemoved =
      embyPressureQualityByViewer.delete(viewerId);
    if (pressureRemoved) scheduleEmbyPressureRecovery();
    if (
      receiverPreferences.size === 0 &&
      embyViewerPreferenceTimer !== undefined
    ) {
      window.clearTimeout(embyViewerPreferenceTimer);
      embyViewerPreferenceTimer = undefined;
    }
    if (
      pressureRemoved &&
      localBroadcastMode === "emby" &&
      broadcasterId === selfId
    ) {
      scheduleEmbyQualityRebalance(
        "弱网观看端已离开，正在恢复房间共享画质",
      );
    }
  }

  async function applyOutboundPreference(
    viewerId: string,
    peer: OutboundPeer,
  ): Promise<void> {
    if (
      peer.mode !== "screen" ||
      !peer.bitrateRamp ||
      !activePreset ||
      outboundPeers.get(viewerId) !== peer
    ) {
      return;
    }
    const requestedPreference = receiverPreferences.get(viewerId) || {};
    const applied = await boundedRtcOperation(
      applyReceiverPreference(
        peer.pc,
        activePreset,
        {
          ...requestedPreference,
          height: Math.min(
            requestedPreference.height || activePreset.height,
            peer.fallbackHeightCeiling || activePreset.height,
          ),
        },
        {
          videoBitrateCeiling: Math.min(
            peer.bitrateRamp.currentBitrate,
            peer.fallbackBitrateCeiling || Number.POSITIVE_INFINITY,
          ),
          degradationPreference: peer.degradationPreference,
        },
      ),
      `更新观看端 ${viewerId} 的发送参数超时`,
    );
    if (applied && outboundPeers.get(viewerId) === peer) {
      peer.bitrateRamp.setTarget(
        Math.min(
          applied.targetBitrate,
          peer.fallbackBitrateCeiling || Number.POSITIVE_INFINITY,
        ),
      );
    }
  }

  function rebalanceScreenP2pFallbackBudgets(): void {
    const screenPeers = [...outboundPeers.entries()].filter(
      ([, peer]) => peer.mode === "screen",
    );
    const maximumFallbacks = Math.min(
      MAX_SCREEN_P2P_FALLBACK_VIEWERS,
      sfuSession.publishing
        ? resourceBudget.maxP2pFallbacks
        : Math.max(1, resourceBudget.maxP2pFallbacks),
    );
    for (const [index, [viewerId, peer]] of screenPeers.entries()) {
      if (index >= maximumFallbacks) {
        outboundPeers.delete(viewerId);
        peer.pc.close();
        reportPlaybackDiagnostic("p2p-fallback-resource-released", {
          viewerId,
          maximumFallbacks,
          pressure: resourceBudget.pressure,
        });
        continue;
      }
      const budget =
        SCREEN_P2P_FALLBACK_BUDGETS[
          Math.min(index, SCREEN_P2P_FALLBACK_BUDGETS.length - 1)
        ];
      const changed =
        peer.fallbackBitrateCeiling !== budget.bitrate ||
        peer.fallbackHeightCeiling !== budget.height;
      peer.fallbackBitrateCeiling = budget.bitrate;
      peer.fallbackHeightCeiling = budget.height;
      peer.bitrateRamp?.setTarget(budget.bitrate);
      if (changed) void applyOutboundPreference(viewerId, peer);
    }
  }

  async function createOfferForViewer(
    viewerId: string,
    attempt = 1,
    supportedCodecs: string[] = [],
    sessionId?: string,
    embyCapabilities?: RoomParticipant["embyCapabilities"],
  ): Promise<void> {
    const embyMode =
      localBroadcastMode === "emby" && Boolean(embyBroadcast?.active);
    if (
      !signal ||
      broadcasterId !== selfId ||
      (!embyMode && (!mediaStream || !activePreset))
    ) {
      return;
    }
    if (!embyMode) {
      const existingScreenFallbacks = [...outboundPeers.entries()].filter(
        ([id, peer]) => id !== viewerId && peer.mode === "screen",
      ).length;
      const maximumFallbacks = Math.min(
        MAX_SCREEN_P2P_FALLBACK_VIEWERS,
        sfuSession.publishing
          ? resourceBudget.maxP2pFallbacks
          : Math.max(1, resourceBudget.maxP2pFallbacks),
      );
      if (existingScreenFallbacks >= maximumFallbacks) {
        window.roomDesktop?.reportDiagnostic("p2p-fallback-budget-rejected", {
          viewerId,
          activeFallbacks: existingScreenFallbacks,
          maximumFallbacks,
          totalBudgetBps: SCREEN_P2P_FALLBACK_BUDGETS.reduce(
            (sum, budget) => sum + budget.bitrate,
            0,
          ),
        });
        notify(
          `${participants.get(viewerId)?.nickname || "一位观众"}未建立 P2P 备用链路：当前设备资源预算已满`,
          "warn",
        );
        return;
      }
    }
    window.roomDesktop?.reportDiagnostic("p2p-offer-start", {
      viewerId,
      attempt,
      sessionId,
      supportedCodecs,
      localDirectAddresses,
      mode: embyMode ? "emby" : "screen",
      embyCapabilities,
      tracks: (mediaStream?.getTracks() || []).map((track) => ({
        kind: track.kind,
        state: track.readyState,
        muted: track.muted,
      })),
    });
    const previousPeer = outboundPeers.get(viewerId);
    previousPeer?.pc.close();
    const candidatePolicy = "balanced";
    const codecOrder = embyMode
      ? []
      : codecOrderForAttempt(viewerId, attempt, supportedCodecs);
    const fallbackBudget = embyMode
      ? undefined
      : SCREEN_P2P_FALLBACK_BUDGETS[
          [...outboundPeers.entries()].filter(
            ([id, candidate]) =>
              id !== viewerId && candidate.mode === "screen",
          ).length
        ];
    const peer: OutboundPeer = {
      pc: createPeerConnection(
        iceServers,
        (candidate) => {
          if (outboundPeers.get(viewerId)?.pc !== peer.pc) return;
          safeSignalSend({
            type: "signal",
            target: viewerId,
            data: candidate,
            attempt,
            sessionId,
          });
        },
        {
          candidatePolicy,
          localAddresses: localDirectAddresses,
        },
      ),
      candidates: [],
      bitrateRamp: activePreset
        ? new VideoBitrateRampController(
            Math.min(
              activePreset.maxBitrate,
              fallbackBudget?.bitrate || activePreset.maxBitrate,
            ),
            Math.min(
              fallbackBudget?.bitrate || Number.POSITIVE_INFINITY,
              networkAdvice.routeMode === "relay-preferred"
                ? 2_000_000
                : networkAdvice.routeMode === "p2p-preferred"
                  ? 4_000_000
                  : 3_000_000,
            ),
            3,
          )
        : undefined,
      codecAttempt: attempt,
      sessionId,
      mediaReady: false,
      mode: embyMode ? "emby" : "screen",
      degradationPreference:
        screenContentMode === "motion"
          ? "maintain-framerate"
          : screenContentMode === "detail"
            ? "maintain-resolution"
            : "balanced",
      cpuLimitedSamples: 0,
      cpuStableSamples: 0,
      statsFailureSamples: 0,
      statsConfidence: "high",
      fallbackBitrateCeiling: fallbackBudget?.bitrate,
      fallbackHeightCeiling: fallbackBudget?.height,
    };
    outboundPeers.set(viewerId, peer);
    if (!embyMode) rebalanceScreenP2pFallbackBudgets();
    const peerIsCurrent = (): boolean =>
      outboundPeers.get(viewerId) === peer &&
      broadcasterId === selfId &&
      !leaving;
    if (embyMode) {
      const requiredCodec =
        embyBroadcast?.streamPlan?.videoCodec === "hevc" ? "hevc" : "h264";
      const incompatibility = embyCapabilityIssue(
        embyCapabilities,
        requiredCodec,
      );
      if (incompatibility) {
        const channel = peer.pc.createDataChannel(
          EMBY_CONTROL_CHANNEL_LABEL,
          { ordered: true },
        );
        channel.addEventListener(
          "open",
          () => {
            channel.send(
              JSON.stringify({
                type: "error",
                message: `此设备不能加入当前 Emby 高清流：${incompatibility}`,
              }),
            );
          },
          { once: true },
        );
        notify(
          `${participants.get(viewerId)?.nickname || "一位观众"}无法加入 Emby 高清流：${incompatibility}`,
          true,
        );
      } else {
        embyBroadcast!.attachViewer(viewerId, peer.pc);
      }
    } else {
      mediaStream!
        .getTracks()
        .forEach((track) => peer.pc.addTrack(track, mediaStream!));
      preferVideoCodecs(peer.pc, codecOrder);
      await boundedRtcOperation(
        tuneSenders(peer.pc, activePreset!, {
          videoBitrateCeiling: Math.min(
            peer.bitrateRamp!.currentBitrate,
            peer.fallbackBitrateCeiling || Number.POSITIVE_INFINITY,
          ),
          degradationPreference: peer.degradationPreference,
        }),
        `配置观看端 ${viewerId} 的发送轨超时`,
      );
      if (!peerIsCurrent()) {
        peer.pc.close();
        return;
      }
      await applyOutboundPreference(viewerId, peer);
      if (!peerIsCurrent()) {
        peer.pc.close();
        return;
      }
    }
    peer.pc.addEventListener("connectionstatechange", () => {
      if (
        outboundPeers.get(viewerId) === peer &&
        ["failed", "closed"].includes(peer.pc.connectionState)
      ) {
        embyBroadcast?.detachViewer(viewerId);
        outboundPeers.delete(viewerId);
        rebalanceScreenP2pFallbackBudgets();
      }
    });
    // TIAS describes the negotiated session maximum. The sender's live
    // setParameters ceiling remains lower during GCC warm-up and ramps
    // independently as the selected ICE path demonstrates headroom.
    try {
      if (!peerIsCurrent()) {
        peer.pc.close();
        return;
      }
      const rawOffer = await boundedRtcOperation(
        peer.pc.createOffer(),
        `为观看端 ${viewerId} 创建 P2P offer 超时`,
      );
      if (!peerIsCurrent()) {
        peer.pc.close();
        return;
      }
      const offer =
        peer.mode === "emby"
          ? rawOffer
          : tuneMovieSdp(rawOffer, peer.bitrateRamp!.targetBitrate);
      await boundedRtcOperation(
        peer.pc.setLocalDescription(offer),
        `为观看端 ${viewerId} 设置本地描述超时`,
      );
      if (!peerIsCurrent()) {
        peer.pc.close();
        return;
      }
      window.roomDesktop?.reportDiagnostic("p2p-offer-ready", {
        viewerId,
        attempt,
        sessionId,
        signalingState: peer.pc.signalingState,
        iceGatheringState: peer.pc.iceGatheringState,
      });
      safeSignalSend({
        type: "signal",
        target: viewerId,
        data: exposeLocalIceDescription(
          stripUnsafeIceCandidates(
            peer.pc.localDescription!,
            candidatePolicy,
            localDirectAddresses,
          ),
          localDirectAddresses,
        ),
        attempt,
        sessionId,
      });
    } catch (error) {
      if (!peerIsCurrent()) return;
      embyBroadcast?.detachViewer(viewerId);
      outboundPeers.delete(viewerId);
      rebalanceScreenP2pFallbackBudgets();
      peer.pc.close();
      throw error;
    }
  }

  async function restartOutboundIce(
    viewerId: string,
    attempt?: number,
    sessionId?: string,
  ): Promise<void> {
    const peer = outboundPeers.get(viewerId);
    if (
      !signal ||
      broadcasterId !== selfId ||
      !peer ||
      peer.pc.connectionState === "closed" ||
      peer.iceRestartInFlight ||
      (attempt !== undefined &&
        peer.codecAttempt !== undefined &&
        attempt !== peer.codecAttempt) ||
      (sessionId && peer.sessionId && sessionId !== peer.sessionId)
    ) {
      return;
    }
      peer.iceRestartInFlight = true;
    try {
      peer.candidates = [];
      peer.pc.restartIce();
      const rawOffer = await boundedRtcOperation(
        peer.pc.createOffer({ iceRestart: true }),
        `为观看端 ${viewerId} 创建 ICE restart offer 超时`,
      );
      if (outboundPeers.get(viewerId) !== peer) return;
      const offer =
        peer.mode === "emby" || !peer.bitrateRamp
          ? rawOffer
          : tuneMovieSdp(rawOffer, peer.bitrateRamp.targetBitrate);
      await boundedRtcOperation(
        peer.pc.setLocalDescription(offer),
        `为观看端 ${viewerId} 设置 ICE restart 描述超时`,
      );
      if (outboundPeers.get(viewerId) !== peer) return;
      window.roomDesktop?.reportDiagnostic("p2p-ice-restart", {
        viewerId,
        attempt: peer.codecAttempt,
        sessionId: peer.sessionId,
        mode: peer.mode,
      });
      if (
        !safeSignalSend({
          type: "signal",
          target: viewerId,
          data: exposeLocalIceDescription(
            stripUnsafeIceCandidates(
              peer.pc.localDescription!,
              "balanced",
              localDirectAddresses,
            ),
            localDirectAddresses,
          ),
          attempt: peer.codecAttempt,
          sessionId: peer.sessionId,
        })
      ) {
        throw new Error("signaling disconnected during P2P ICE restart");
      }
    } catch (error) {
      window.roomDesktop?.reportDiagnostic("p2p-ice-restart-failed", {
        viewerId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (outboundPeers.get(viewerId) === peer) {
        peer.iceRestartInFlight = false;
      }
    }
  }

  async function handleOutboundSignal(
    viewerId: string,
    data: RTCSessionDescriptionInit | RTCIceCandidateInit,
    attempt?: number,
    sessionId?: string,
  ): Promise<void> {
    const viewerPolicy = "balanced";
    if (
      !("type" in data) &&
      !isUsableIceCandidate(data, viewerPolicy)
    ) {
      return;
    }
    const peer = outboundPeers.get(viewerId);
    if (!peer) return;
    const peerIsCurrent = (): boolean =>
      outboundPeers.get(viewerId) === peer &&
      broadcasterId === selfId &&
      !leaving;
    if (
      attempt !== undefined &&
      peer.codecAttempt !== undefined &&
      attempt !== peer.codecAttempt
    ) {
      return;
    }
    if (sessionId && peer.sessionId && sessionId !== peer.sessionId) {
      return;
    }
    if ("type" in data && data.type) {
      await boundedRtcOperation(
        peer.pc.setRemoteDescription(
          stripUnsafeIceCandidates(
            data as RTCSessionDescriptionInit,
            viewerPolicy,
          ),
        ),
        `应用观看端 ${viewerId} 的远端描述超时`,
      );
      if (!peerIsCurrent()) return;
      if (
        data.type === "answer" &&
        peer.mode === "screen" &&
        peer.bitrateRamp &&
        activePreset
      ) {
        // Re-apply the final encoding parameters after negotiation. Chromium
        // may discard pre-offer scale/bitrate settings when the selected codec
        // is instantiated; this also forces a fresh keyframe for the viewer.
        await boundedRtcOperation(
          tuneSenders(peer.pc, activePreset, {
            videoBitrateCeiling: Math.min(
              peer.bitrateRamp.currentBitrate,
              peer.fallbackBitrateCeiling || Number.POSITIVE_INFINITY,
            ),
            degradationPreference: peer.degradationPreference,
          }),
          `协商后更新观看端 ${viewerId} 的发送轨超时`,
        );
        if (!peerIsCurrent()) return;
        await applyOutboundPreference(viewerId, peer);
        if (!peerIsCurrent()) return;
      }
      for (const candidate of peer.candidates.splice(0)) {
        if (!peerIsCurrent()) return;
        try {
          await boundedRtcOperation(
            peer.pc.addIceCandidate(candidate),
            `应用观看端 ${viewerId} 的 ICE candidate 超时`,
            RTC_CANDIDATE_TIMEOUT_MS,
          );
        } catch {
          // Ignore candidates from a superseded receiver negotiation.
        }
      }
    } else if (peer.pc.remoteDescription) {
      try {
        await boundedRtcOperation(
          peer.pc.addIceCandidate(data as RTCIceCandidateInit),
          `应用观看端 ${viewerId} 的实时 ICE candidate 超时`,
          RTC_CANDIDATE_TIMEOUT_MS,
        );
      } catch {
        // Ignore late candidates from a replaced receiver connection.
      }
    } else {
      queuePendingMediaCandidate(
        peer.candidates,
        data as RTCIceCandidateInit,
      );
    }
  }

  async function updateOutboundStats(): Promise<void> {
    if (outboundStatsPollRunning) return;
    outboundStatsPollRunning = true;
    try {
    let bitrate = 0;
    let bandwidthLimited = false;
    const pathBandwidthSamples: number[] = [];
    const pathRttSamples: number[] = [];
    const pendingSamples = await Promise.all(
      [...outboundPeers.entries()]
        .filter(
          (
            entry,
          ): entry is [
            string,
            OutboundPeer & { bitrateRamp: VideoBitrateRampController },
          ] => entry[1].mode === "screen" && Boolean(entry[1].bitrateRamp),
        )
        .map(async ([viewerId, peer]) => {
        let stats: Awaited<ReturnType<typeof readOutboundVideoStats>>;
        try {
          stats = await boundedRtcOperation(
            readOutboundVideoStats(peer.pc, peer.snapshot),
            `读取观看端 ${viewerId} 的 WebRTC 统计超时`,
            RTC_STATS_TIMEOUT_MS,
          );
        } catch (error) {
          if (outboundPeers.get(viewerId) === peer) {
            peer.statsFailureSamples += 1;
            peer.statsConfidence =
              peer.statsFailureSamples >= 5 ? "missing" : "reduced";
            if (
              peer.statsFailureSamples === 3 ||
              peer.statsFailureSamples === 5
            ) {
              reportPlaybackDiagnostic("outbound-stats-missing", {
                viewerId,
                consecutiveFailures: peer.statsFailureSamples,
                confidence: peer.statsConfidence,
                connectionState: peer.pc.connectionState,
                iceConnectionState: peer.pc.iceConnectionState,
                mediaReady: peer.mediaReady,
                message:
                  error instanceof Error ? error.message : String(error),
              });
            }
          }
          return undefined;
        }
        if (outboundPeers.get(viewerId) !== peer) return undefined;
        peer.statsFailureSamples = 0;
        peer.statsConfidence = "high";
        peer.snapshot = stats.snapshot;
        const negotiatedCodec = normalizeVideoCodecMime(stats.codec);
        if (negotiatedCodec) peer.negotiatedVideoCodec = negotiatedCodec;
        bitrate += stats.bitrate;
        bandwidthLimited ||= stats.qualityLimitationReason === "bandwidth";
        if (
          stats.availableOutgoingBitrate !== undefined &&
          Number.isFinite(stats.availableOutgoingBitrate) &&
          stats.availableOutgoingBitrate > 0
        ) {
          pathBandwidthSamples.push(stats.availableOutgoingBitrate);
        }
        if (
          stats.currentRoundTripTime !== undefined &&
          Number.isFinite(stats.currentRoundTripTime) &&
          stats.currentRoundTripTime >= 0
        ) {
          pathRttSamples.push(stats.currentRoundTripTime);
        }
        const raisedCeiling = peer.bitrateRamp.observe(
          stats.availableOutgoingBitrate,
          stats.qualityLimitationReason,
        );
        let senderModeChanged = false;
        if (stats.qualityLimitationReason === "cpu") {
          peer.cpuLimitedSamples += 1;
          peer.cpuStableSamples = 0;
          if (
            peer.cpuLimitedSamples >= 3 &&
            peer.degradationPreference !== "maintain-framerate"
          ) {
            // Software encoders can become the bottleneck with several
            // viewers. Only after sustained CPU pressure let Chromium lower
            // resolution to protect motion; the normal stable path continues
            // to preserve the selected physical raster.
            peer.degradationPreference = "maintain-framerate";
            peer.cpuLimitedSamples = 0;
            senderModeChanged = true;
          }
        } else if (stats.qualityLimitationReason === "none") {
          peer.cpuLimitedSamples = 0;
          if (peer.degradationPreference === "maintain-framerate") {
            peer.cpuStableSamples += 1;
            if (peer.cpuStableSamples >= 10) {
              peer.degradationPreference = "maintain-resolution";
              peer.cpuStableSamples = 0;
              senderModeChanged = true;
            }
          } else {
            peer.cpuStableSamples = 0;
          }
        } else {
          peer.cpuLimitedSamples = Math.max(0, peer.cpuLimitedSamples - 1);
          peer.cpuStableSamples = 0;
        }
        if (
          (raisedCeiling !== undefined || senderModeChanged) &&
          outboundPeers.get(viewerId) === peer
        ) {
          await applyOutboundPreference(viewerId, peer);
        }
        return { viewerId, peer, stats };
        }),
    );
    const samples = pendingSamples.filter(
      (
        sample,
      ): sample is Exclude<
        (typeof pendingSamples)[number],
        undefined
      > => Boolean(sample),
    );
    if (pathBandwidthSamples.length) {
      const currentPathEstimate = Math.min(...pathBandwidthSamples);
      measuredAvailableOutgoingBitrate =
        measuredAvailableOutgoingBitrate === undefined
          ? currentPathEstimate
          : measuredAvailableOutgoingBitrate * 0.72 +
            currentPathEstimate * 0.28;
    }
    const worstPathRtt = pathRttSamples.length
      ? Math.max(...pathRttSamples)
      : undefined;
    if (worstPathRtt !== undefined && worstPathRtt >= 0.08) {
      highRttSamples += 1;
    } else if (worstPathRtt !== undefined && worstPathRtt <= 0.06) {
      highRttSamples = 0;
      highRttWarningShown = false;
    }
    const relaySamples = samples.filter(({ stats }) => stats.relayed);
    if (outboundPeers.size) {
      const readyViewers = [...outboundPeers.values()].filter(
        (peer) => peer.mediaReady,
      ).length;
      const cpuProtected = [...outboundPeers.values()].some(
        (peer) => peer.degradationPreference === "maintain-framerate",
      );
      const relayCount = relaySamples.length;
      const directCount = Math.max(0, samples.length - relayCount);
      const routeSummary = relayCount
        ? `腾讯云中继 ${relayCount} 路${directCount ? ` · P2P ${directCount} 路` : ""}`
        : `P2P 直连 ${outboundPeers.size} 路`;
      setMediaStatus(
        `${activePreset?.label || "放映中"} · ${routeSummary} · 已出画 ${readyViewers}/${outboundPeers.size} · 总上行 ${formatBitrate(bitrate)}${
          worstPathRtt !== undefined
            ? ` · RTT ${Math.round(worstPathRtt * 1000)} ms`
            : ""
        }${cpuProtected ? " · 编码器流畅保护" : ""}`,
      );
      if (cpuProtected && !cpuWarningShown) {
        cpuWarningShown = true;
        notify(
          "检测到发送端编码压力持续过高，已优先保持帧率并临时降低该路分辨率；压力恢复后会自动回到原画。",
          true,
        );
      } else if (!cpuProtected) {
        cpuWarningShown = false;
      }
    }
    if (relaySamples.length && !relayFallbackNoticeShown) {
      relayFallbackNoticeShown = true;
      notify("P2P 直连未能建立，已自动切换腾讯云备用中继。");
    }
    bandwidthLimitedSamples = bandwidthLimited
      ? bandwidthLimitedSamples + 1
      : 0;
    if (bandwidthLimitedSamples >= 3 && !bandwidthWarningShown) {
      bandwidthWarningShown = true;
      notify(
        "检测到上行带宽不足，画面正在自动降码率；建议降低分辨率或帧率。",
        true,
      );
    }
    if (highRttSamples >= 5 && !highRttWarningShown) {
      highRttWarningShown = true;
      notify(
        `P2P 路径往返延迟持续达到 ${Math.round((worstPathRtt || 0) * 1000)} ms，播放缓冲和画面延迟可能增加。`,
        true,
      );
    }
    } catch {
      // Sender statistics are advisory. The next bounded interval retries,
      // while negotiation and track-replacement failures recover separately.
    } finally {
      outboundStatsPollRunning = false;
    }
  }

  async function cleanupLocalBroadcast(): Promise<void> {
    if (cleanupLocalBroadcastPromise) {
      await cleanupLocalBroadcastPromise;
      return;
    }
    const cleanup = performLocalBroadcastCleanup();
    cleanupLocalBroadcastPromise = cleanup;
    try {
      await cleanup;
    } finally {
      if (cleanupLocalBroadcastPromise === cleanup) {
        cleanupLocalBroadcastPromise = undefined;
      }
    }
  }

  async function performLocalBroadcastCleanup(): Promise<void> {
    broadcastPreparationEpoch += 1;
    audioCaptureEpoch += 1;
    captureVideoEpoch += 1;
    if (captureVideoRecoveryTimer !== undefined) {
      window.clearTimeout(captureVideoRecoveryTimer);
      captureVideoRecoveryTimer = undefined;
    }
    if (captureVideoHealthTimer !== undefined) {
      window.clearInterval(captureVideoHealthTimer);
      captureVideoHealthTimer = undefined;
    }
    captureVideoHealthPollRunning = false;
    activeCaptureSourceId = "";
    captureSourceGeometry = undefined;
    captureVideoHealth.reset();
    captureVideoRecoveryInFlight = false;
    captureVideoRecoveryFailures = 0;
    const captureToStop = audioCapture;
    audioCapture = undefined;
    if (statsTimer) window.clearInterval(statsTimer);
    statsTimer = undefined;
    outboundStatsPollRunning = false;
    if (capabilityUpdateTimer !== undefined) {
      window.clearTimeout(capabilityUpdateTimer);
      capabilityUpdateTimer = undefined;
    }
    if (embyRebalanceTimer !== undefined) {
      window.clearTimeout(embyRebalanceTimer);
      embyRebalanceTimer = undefined;
    }
    if (embyViewerPreferenceTimer !== undefined) {
      window.clearTimeout(embyViewerPreferenceTimer);
      embyViewerPreferenceTimer = undefined;
    }
    embyPressureQualityCooldownUntil = 0;
    if (embyPressureRecoveryTimer !== undefined) {
      window.clearTimeout(embyPressureRecoveryTimer);
      embyPressureRecoveryTimer = undefined;
    }
    embyPressureQualityByViewer.clear();
    lastEmbyHostDiagnosticAt = 0;
    const embyController = embyBroadcast;
    embyBroadcast = undefined;
    clearSfuPrimaryRecovery();
    sfuPublishedKey = "";
    reportSfuStatus("publisher", false);
    embyController?.detachViewer(SFU_EMBY_VIEWER_ID);
    await sfuSession.stopPublishing().catch(() => undefined);
    if (embyController) {
      await embyController.destroy();
    } else if (embyLogin) {
      await boundedUiOperation(
        Promise.resolve(
          window.roomDesktop?.embyStopStream("room-session-ended"),
        ),
        8_000,
        "关闭残留 Emby 管线超时",
      ).catch((error) => {
        reportPlaybackDiagnostic("emby-orphan-stop-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    outboundPeers.forEach(({ pc }) => pc.close());
    outboundPeers.clear();
    failedVideoCodecsByViewer.clear();
    receiverPreferences.clear();
    relayFallbackNoticeShown = false;
    cpuWarningShown = false;
    highRttSamples = 0;
    highRttWarningShown = false;
    await captureToStop?.stop();
    await audioRecoveryPromise?.catch(() => undefined);
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = undefined;
    displayStream?.getTracks().forEach((track) => track.stop());
    displayStream = undefined;
    activePreset = undefined;
    localBroadcastMode = undefined;
    // A broadcast is only one consumer of the active Emby account. Keep the
    // authenticated account, library results and current selection alive so
    // a failed stream start or stopping ordinary screen share cannot turn the
    // library into an inert empty view. PlaybackInfo is stream-scoped and is
    // intentionally refreshed before the next start.
    embyPlaybackInfo = undefined;
    window.roomDesktop?.clearDanmaku();
    await boundedUiOperation(
      Promise.resolve(window.roomDesktop?.setCaptureActive(false)),
      3_000,
      "关闭桌面采集状态超时",
    ).catch((error) => {
      reportPlaybackDiagnostic("capture-deactivate-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (!broadcasterId || broadcasterId === selfId || awaitingBroadcastGrant) {
      setBroadcastCapabilities(undefined);
    }
    awaitingBroadcastGrant = false;
  }

  async function stopBroadcast(sendMessage = true): Promise<void> {
    if (sendMessage && signal && broadcasterId === selfId) {
      safeSignalSend({ type: "broadcast:stop" });
    }
    await cleanupLocalBroadcast();
    if (broadcasterId === selfId) {
      broadcasterId = undefined;
      broadcasterNickname = "";
      setBroadcastCapabilities(undefined);
      companion?.setBroadcaster(undefined);
      syncDesktopDanmaku();
      showIdleStage();
      updateBroadcastControls();
      setSignalStatus("connected", "已连接");
      setMediaStatus("当前无人放映");
      updateNativePlaybackActivity(false);
    }
  }

  function readCaptureCapabilities(
    preset: QualityPreset,
    sourceTrack: MediaStreamTrack,
  ): BroadcastCapabilities {
    const settings = sourceTrack.getSettings();
    const sourceWidth = Math.max(
      1,
      Math.round(Number(settings.width) || preset.width),
    );
    const sourceHeight = Math.max(
      1,
      Math.round(Number(settings.height) || preset.height),
    );
    const safeTarget = safeVideoEncodingTarget(
      sourceWidth,
      sourceHeight,
      Math.min(sourceHeight, preset.height),
    );
    // "Original" is a capture ceiling, not an instruction to invent pixels.
    // Advertise the track's real physical dimensions so viewers see an honest
    // "original" option and never request a resolution the source cannot send.
    // If WGC ignored an exact safe-size request, advertise the actual
    // decoder-safe sender raster rather than its padded source row.
    return {
      width: safeTarget?.width ?? sourceWidth,
      height: safeTarget?.height ?? sourceHeight,
      frameRate: Math.max(
        1,
        Math.min(
          preset.frameRate,
          Math.round(Number(settings.frameRate) || preset.frameRate),
        ),
      ),
      contentMode: screenContentMode,
    };
  }

  function scheduleCaptureCapabilitiesUpdate(): void {
    if (
      !signal ||
      broadcasterId !== selfId ||
      !mediaStream ||
      !activePreset
    ) {
      return;
    }
    if (capabilityUpdateTimer !== undefined) {
      window.clearTimeout(capabilityUpdateTimer);
    }
    capabilityUpdateTimer = window.setTimeout(() => {
      capabilityUpdateTimer = undefined;
      const sourceTrack = mediaStream?.getVideoTracks()[0];
      if (!sourceTrack || !activePreset || broadcasterId !== selfId) return;
      const next = readCaptureCapabilities(activePreset, sourceTrack);
      const changed =
        !broadcastCapabilities ||
        next.width !== broadcastCapabilities.width ||
        next.height !== broadcastCapabilities.height ||
        next.frameRate !== broadcastCapabilities.frameRate ||
        next.contentMode !== broadcastCapabilities.contentMode;
      if (!changed) return;
      setBroadcastCapabilities(next);
      try {
        safeSignalSend({
          type: "broadcast:capabilities",
          broadcastCapabilities: next,
        });
      } catch {
        // The retained capabilities are sent when signaling reconnects.
      }
      for (const [viewerId, peer] of outboundPeers) {
        void applyOutboundPreference(viewerId, peer);
      }
      setMediaStatus(
        `${exactSourceLabel(next.width, next.height, next.frameRate)} · 本地放映中`,
      );
    }, 350);
  }

  function captureAttempt(
    createStream: () => Promise<MediaStream>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<MediaStream> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      void createStream().then(
        (stream) => {
          if (settled) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          settled = true;
          window.clearTimeout(timer);
          resolve(stream);
        },
        (error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function applyScreenContentHint(track: MediaStreamTrack): void {
    track.contentHint =
      screenContentMode === "detail"
        ? "detail"
        : screenContentMode === "motion"
          ? "motion"
          : "";
  }

  async function captureSelectedWindow(
    sourceId: string,
    preset: QualityPreset,
  ): Promise<MediaStream> {
    const directConstraints = (
      exactSize?: { width: number; height: number },
    ) =>
      ({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
            ...(exactSize
              ? {
                  minWidth: exactSize.width,
                  minHeight: exactSize.height,
                }
              : {}),
            maxWidth: exactSize?.width ?? preset.width,
            maxHeight: exactSize?.height ?? preset.height,
            maxFrameRate: preset.frameRate,
          },
        },
      }) as unknown as MediaStreamConstraints;
    try {
      // Electron's source-id path does not reopen a picker and does not depend
      // on a second window enumeration. It is substantially more reliable for
      // portable builds and Store/UWP video players.
      let stream = await captureAttempt(
        () => navigator.mediaDevices.getUserMedia(directConstraints()),
        12_000,
        "Windows 窗口采集响应超时",
      );
      const track = stream.getVideoTracks()[0];
      if (track) {
        applyScreenContentHint(track);
        await track
          .applyConstraints({
            width: { ideal: preset.width, max: preset.width },
            height: { ideal: preset.height, max: preset.height },
            frameRate: { ideal: preset.frameRate, max: preset.frameRate },
          })
          .catch(() => undefined);
        // Let WGC publish its logical size and screenPixelRatio before deciding
        // whether this is a high-DPI or decoder-row-alignment source.
        // Re-applying an exact constraint to an existing track does not restore
        // physical pixels or discard the padded edge; Chromium must create the
        // track at that raster size.
        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, 180),
        );
        const target = physicalCaptureTarget(
          track.getSettings() as MediaTrackSettings & {
            screenPixelRatio?: number;
          },
          preset.width,
          preset.height,
        );
        if (target?.recreateRequired) {
          const bootstrapSettings = track.getSettings();
          stream.getTracks().forEach((candidate) => candidate.stop());
          try {
            stream = await captureAttempt(
              () =>
                navigator.mediaDevices.getUserMedia(
                  directConstraints({
                    width: target.width,
                    height: target.height,
                  }),
               ),
               12_000,
               "Windows 安全画面栅格采集响应超时",
             );
            window.roomDesktop?.reportDiagnostic(
              "capture-physical-pixels-restored",
              {
                logicalWidth: bootstrapSettings.width,
                logicalHeight: bootstrapSettings.height,
                screenPixelRatio: (
                  bootstrapSettings as MediaTrackSettings & {
                   screenPixelRatio?: number;
                 }
                ).screenPixelRatio,
                physicalWidth: target.width,
                physicalHeight: target.height,
                edgeGuardRequired: target.edgeGuardRequired,
              },
            );
          } catch (upgradeError) {
            window.roomDesktop?.reportDiagnostic(
              "capture-physical-pixels-fallback",
              {
                message:
                  upgradeError instanceof Error
                    ? upgradeError.message.slice(0, 300)
                    : String(upgradeError).slice(0, 300),
              },
            );
            stream = await captureAttempt(
              () => navigator.mediaDevices.getUserMedia(directConstraints()),
              12_000,
              "安全画面栅格升级失败后无法恢复窗口采集",
            );
          }
        }
      }
      return stream;
    } catch (directError) {
      window.roomDesktop?.reportDiagnostic("capture-direct-fallback", {
        name:
          directError instanceof DOMException
            ? directError.name
            : directError instanceof Error
              ? directError.name
              : "UnknownError",
        message:
          directError instanceof Error
            ? directError.message.slice(0, 300)
            : String(directError).slice(0, 300),
      });
      return captureAttempt(
        () =>
          navigator.mediaDevices.getDisplayMedia({
            video: {
              width: { ideal: preset.width },
              height: { ideal: preset.height },
              frameRate: { ideal: preset.frameRate },
            },
            audio: false,
          }),
        12_000,
        "备用窗口采集也没有响应；请恢复播放器窗口后重试",
      );
    }
  }

  function bindCaptureVideoTrack(
    track: MediaStreamTrack,
    epoch: number,
  ): void {
    applyScreenContentHint(track);
    track.addEventListener("ended", () => {
      if (
        epoch === captureVideoEpoch &&
        mediaStream?.getVideoTracks()[0] === track &&
        !captureVideoRecoveryInFlight
      ) {
        void stopBroadcast();
      }
    });
    track.addEventListener("mute", () => {
      if (
        epoch !== captureVideoEpoch ||
        mediaStream?.getVideoTracks()[0] !== track
      ) {
        return;
      }
      setStatus("播放器正在切换画面 · 尝试跟随全屏窗口", "neutral");
      if (captureVideoRecoveryTimer !== undefined) {
        window.clearTimeout(captureVideoRecoveryTimer);
      }
      captureVideoRecoveryTimer = window.setTimeout(() => {
        captureVideoRecoveryTimer = undefined;
        if (
          track.muted &&
          mediaStream?.getVideoTracks()[0] === track
        ) {
          const decision = captureVideoHealth.claim("track-muted");
          if (decision.recover) {
            void recoverFullscreenCapture(track, epoch);
          }
        }
      }, 900);
    });
    track.addEventListener("unmute", () => {
      if (
        epoch !== captureVideoEpoch ||
        mediaStream?.getVideoTracks()[0] !== track
      ) {
        return;
      }
      if (captureVideoRecoveryTimer !== undefined) {
        window.clearTimeout(captureVideoRecoveryTimer);
        captureVideoRecoveryTimer = undefined;
      }
      captureVideoRecoveryFailures = 0;
      if (broadcasterId === selfId) {
        setStatus("原始窗口轨正在直传", "ready");
      }
    });
  }

  async function recoverFullscreenCapture(
    failedTrack: MediaStreamTrack,
    epoch: number,
    sourceId = activeCaptureSourceId,
  ): Promise<void> {
    if (
      captureVideoRecoveryInFlight ||
      epoch !== captureVideoEpoch ||
      localBroadcastMode !== "screen" ||
      !activePreset ||
      mediaStream?.getVideoTracks()[0] !== failedTrack
    ) {
      return;
    }
    if (!sourceId) return;
    captureVideoRecoveryInFlight = true;
    let replacementStream: MediaStream | undefined;
    try {
      const preset = activePreset;
      replacementStream = await captureSelectedWindow(sourceId, preset);
      const replacementTrack = replacementStream.getVideoTracks()[0];
      if (!replacementTrack) {
        throw new Error("全屏窗口没有返回可用画面轨");
      }
      if (
        epoch !== captureVideoEpoch ||
        localBroadcastMode !== "screen" ||
        mediaStream?.getVideoTracks()[0] !== failedTrack
      ) {
        replacementStream.getTracks().forEach((track) => track.stop());
        return;
      }
      applyScreenContentHint(replacementTrack);
      // captureSelectedWindow may have recreated this track at a safe exact
      // width (for example 3616 rather than 3618). Reapplying broad preset
      // constraints here would relax that guard and let WGC expose padded
      // decoder rows again after an F11 transition.
      const previousDisplayStream = displayStream;
      mediaStream.removeTrack(failedTrack);
      mediaStream.addTrack(replacementTrack);
      displayStream = replacementStream;
      activeCaptureSourceId = sourceId;
      bindCaptureVideoTrack(replacementTrack, epoch);
      const replacements = [...outboundPeers.values()]
        .filter((peer) => peer.mode === "screen")
        .flatMap((peer) =>
          peer.pc
            .getSenders()
            .filter((sender) => sender.track?.kind === "video")
            .map((sender) =>
              boundedRtcOperation(
                sender.replaceTrack(replacementTrack),
                "替换 P2P 视频轨超时",
                RTC_TRACK_REPLACE_TIMEOUT_MS,
              ),
            ),
        );
      const replacementResults = await Promise.allSettled(replacements);
      const replacementFailures = replacementResults.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (replacementFailures.length) {
        const messages = replacementFailures
          .map((result) => readableError(result.reason, "replaceTrack failed"))
          .slice(0, 4);
        console.warn(
          `Failed to replace ${replacementFailures.length} outbound video track(s)`,
          messages,
        );
        window.roomDesktop?.reportDiagnostic(
          "capture-track-replace-partial-failure",
          {
            failed: replacementFailures.length,
            total: replacements.length,
            messages,
          },
        );
      }
      await replacePublishedSfuScreenTrack(
        replacementTrack,
        "capture-video-recovered",
      );
      // replaceTrack retains the old RTCRtpEncodingParameters. A browser F11
      // transition changes the source width while keeping that stale scale,
      // which can turn a safe row back into an Android-unsafe 1206px raster.
      // Recalculate every viewer's scale against the replacement track before
      // the first new keyframe is emitted.
      await Promise.allSettled(
        [...outboundPeers.entries()]
          .filter(([, peer]) => peer.mode === "screen")
          .map(([viewerId, peer]) =>
            applyOutboundPreference(viewerId, peer),
          ),
      );
      previousDisplayStream
        ?.getTracks()
        .filter((track) => track !== replacementTrack)
        .forEach((track) => track.stop());
      failedTrack.stop();
      const capabilities = readCaptureCapabilities(preset, replacementTrack);
      setBroadcastCapabilities(capabilities);
      scheduleCaptureCapabilitiesUpdate();
      if (broadcasterId === selfId) {
        safeSignalSend({
          type: "broadcast:capabilities",
          broadcastCapabilities: capabilities,
        });
      }
      captureVideoRecoveryFailures = 0;
      setStatus("已自动跟随播放器的全屏窗口", "ready");
      window.roomDesktop?.reportDiagnostic(
        "capture-fullscreen-track-replaced",
        {
          width: replacementTrack.getSettings().width,
          height: replacementTrack.getSettings().height,
          frameRate: replacementTrack.getSettings().frameRate,
          viewers: replacements.length,
        },
      );
    } catch (error) {
      replacementStream?.getTracks().forEach((track) => track.stop());
      captureVideoRecoveryFailures += 1;
      window.roomDesktop?.reportDiagnostic(
        "capture-fullscreen-recovery-failed",
        {
          attempt: captureVideoRecoveryFailures,
          message:
            error instanceof Error
              ? error.message.slice(0, 300)
              : String(error).slice(0, 300),
        },
      );
      if (captureVideoRecoveryFailures === 1) {
        notify(
          "播放器全屏窗口暂时无法跟随；正在保留连接，可恢复窗口后重试",
          true,
        );
      }
    } finally {
      captureVideoRecoveryInFlight = false;
    }
  }

  function startCaptureVideoHealthMonitor(epoch: number): void {
    if (captureVideoHealthTimer !== undefined) {
      window.clearInterval(captureVideoHealthTimer);
    }
    captureVideoHealth.reset();
    const poll = async (): Promise<void> => {
      if (
        captureVideoHealthPollRunning ||
        epoch !== captureVideoEpoch ||
        localBroadcastMode !== "screen" ||
        !mediaStream
      ) {
        return;
      }
      captureVideoHealthPollRunning = true;
      try {
        const sourceHealth = await boundedUiOperation(
          Promise.resolve(window.roomDesktop?.getCaptureSourceHealth()),
          2_000,
          "读取窗口采集状态超时",
        ).catch(() => undefined);
        const nextGeometry = normalizeCaptureWindowGeometry(sourceHealth);
        const sourceGeometryChanged = captureWindowGeometryChanged(
          captureSourceGeometry,
          nextGeometry,
        );
        if (nextGeometry) captureSourceGeometry = nextGeometry;
        const geometryWidth = nextGeometry?.width || 0;
        const geometryHeight = nextGeometry?.height || 0;
        let framesEncoded = 0;
        let encoderPresent = false;
        await Promise.all(
          [...outboundPeers.values()]
            .filter(
              (peer) =>
                peer.mode === "screen" &&
                peer.pc.connectionState === "connected",
            )
            .map(async (peer) => {
              try {
                const report = await boundedRtcOperation(
                  peer.pc.getStats(),
                  "读取屏幕发送编码统计超时",
                  RTC_STATS_TIMEOUT_MS,
                );
                report.forEach((item) => {
                  const kind = item.kind || item.mediaType;
                  if (
                    item.type === "outbound-rtp" &&
                    kind === "video" &&
                    !item.isRemote &&
                    Number.isFinite(Number(item.framesEncoded))
                  ) {
                    encoderPresent = true;
                    framesEncoded += Math.max(
                      0,
                      Number(item.framesEncoded),
                    );
                  }
                });
              } catch {
                // Thumbnail/source identity still provide health evidence.
              }
            }),
        );
        if (
          epoch !== captureVideoEpoch ||
          localBroadcastMode !== "screen"
        ) {
          return;
        }
        const track = mediaStream?.getVideoTracks()[0];
        if (!track) return;
        const nextSourceId =
          sourceHealth?.sourceId || activeCaptureSourceId;
        if (sourceHealth?.changed && nextSourceId) {
          activeCaptureSourceId = nextSourceId;
        }
        const decision = captureVideoHealth.observe({
          sourceChanged:
            sourceHealth?.changed === true || sourceGeometryChanged,
          thumbnailActivity: sourceHealth?.available
            ? sourceHealth.activity
            : undefined,
          framesEncoded,
          encoderPresent,
          trackMuted: track.muted,
        });
        if (!decision.recover) return;
        window.roomDesktop?.reportDiagnostic(
          "capture-video-health-recovery",
          {
            reason: decision.reason,
            attempt: decision.attempts,
            sourceChanged: sourceHealth?.changed,
            sourceGeometryChanged,
            geometryWidth: geometryWidth || undefined,
            geometryHeight: geometryHeight || undefined,
            thumbnailActivity: sourceHealth?.activity,
            framesEncoded: encoderPresent ? framesEncoded : undefined,
          },
        );
        await recoverFullscreenCapture(track, epoch, nextSourceId);
      } finally {
        captureVideoHealthPollRunning = false;
      }
    };
    // Track mute/ended events already provide the fast fullscreen-recovery
    // path. Delay this expensive thumbnail/process fallback until the initial
    // capture, audio helper and first WebRTC offer have settled.
    captureVideoHealthTimer = window.setInterval(
      () => void poll(),
      5_000,
    );
  }

  function friendlyCaptureError(error: unknown): string {
    if (error instanceof DOMException) {
      if (error.name === "NotAllowedError") {
        return "Windows 拒绝了窗口捕获。请确认播放器没有以管理员身份运行，然后重新选择。";
      }
      if (error.name === "NotReadableError") {
        return "所选播放器画面当前无法读取。请退出播放器独占全屏、恢复窗口后重试。";
      }
      if (error.name === "AbortError") {
        return "Windows 中断了窗口捕获，请保持播放器窗口打开后重试。";
      }
    }
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }
    return "无法启动所选窗口的画面采集";
  }

  function bindProcessAudioCapture(
    capture: ProcessAudioCapture,
    epoch: number,
  ): void {
    capture.addEventListener("silence", () => {
      if (audioCapture !== capture || epoch !== audioCaptureEpoch) return;
      notify(
        "没有检测到所选窗口的声音。请先播放影片并确认播放器未静音；画面仍会继续放映。",
        true,
      );
    });
    capture.addEventListener("error", (event) => {
      if (
        audioCapture !== capture ||
        epoch !== audioCaptureEpoch ||
        localBroadcastMode !== "screen"
      ) {
        return;
      }
      const message =
        (event as CustomEvent<string>).detail || "窗口声音采集中断";
      window.setTimeout(() => {
        if (
          audioCapture === capture &&
          epoch === audioCaptureEpoch &&
          localBroadcastMode === "screen"
        ) {
          void recoverProcessAudioCapture(capture, message, epoch);
        }
      }, preparingBroadcast && !mediaStream ? 250 : 0);
    });
  }

  async function startMovieAudioCapture(
    epoch: number,
    attempts: number,
  ): Promise<{
    capture: ProcessAudioCapture;
    track: MediaStreamTrack;
  }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (
        epoch !== audioCaptureEpoch ||
        localBroadcastMode !== "screen"
      ) {
        throw new Error("窗口声音采集已取消");
      }
      const capture = new ProcessAudioCapture();
      audioCapture = capture;
      bindProcessAudioCapture(capture, epoch);
      try {
        const track = await capture.start();
        if (!capture.active || track.readyState !== "live") {
          throw new Error("窗口声音轨道在建立连接前已经结束");
        }
        return { capture, track };
      } catch (error) {
        lastError = error;
        if (audioCapture === capture) audioCapture = undefined;
        await capture.stop();
        const mainStatus = await boundedUiOperation(
          Promise.resolve(window.roomDesktop?.getProcessAudioStatus()),
          2_000,
          "读取声音采集状态超时",
        ).catch(() => undefined);
        window.roomDesktop?.reportDiagnostic(
          "process-audio-attempt-failed",
          {
            attempt,
            attempts,
            message:
              error instanceof Error
                ? error.message.slice(0, 300)
                : String(error).slice(0, 300),
            mainStatus,
          },
        );
        if (attempt < attempts) {
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, attempt * 300),
          );
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("窗口声音采集启动失败");
  }

  async function recoverProcessAudioCapture(
    failedCapture: ProcessAudioCapture | undefined,
    reason: string,
    epoch: number,
  ): Promise<void> {
    if (audioRecoveryPromise) {
      await audioRecoveryPromise;
      return;
    }
    const recovery = (async (): Promise<void> => {
      if (
        epoch !== audioCaptureEpoch ||
        localBroadcastMode !== "screen" ||
        !mediaStream ||
        (failedCapture && audioCapture !== failedCapture) ||
        (!failedCapture && audioCapture?.active)
      ) {
        return;
      }
      if (failedCapture && audioCapture === failedCapture) {
        audioCapture = undefined;
      }
      await failedCapture?.stop();
      notify("窗口声音链路中断，正在自动恢复；画面不会停止。", true);
      let lastError: unknown;
      for (const [index, delay] of [0, 500, 1_500].entries()) {
        if (delay) {
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, delay),
          );
        }
        if (
          epoch !== audioCaptureEpoch ||
          localBroadcastMode !== "screen" ||
          !mediaStream
        ) {
          return;
        }
        try {
          const { capture, track } = await startMovieAudioCapture(epoch, 1);
          if (
            epoch !== audioCaptureEpoch ||
            localBroadcastMode !== "screen" ||
            !mediaStream ||
            audioCapture !== capture
          ) {
            await capture.stop();
            return;
          }
          const activeStream = mediaStream;
          const oldTracks = activeStream
            .getAudioTracks()
            .filter((candidate) => candidate !== track);
          for (const oldTrack of oldTracks) {
            activeStream.removeTrack(oldTrack);
            oldTrack.stop();
          }
          if (!activeStream.getAudioTracks().includes(track)) {
            activeStream.addTrack(track);
          }

          const renegotiate: Array<{
            viewerId: string;
            peer: OutboundPeer;
          }> = [];
          let replacedSenders = 0;
          for (const [viewerId, peer] of outboundPeers) {
            if (peer.mode !== "screen") continue;
            const audioSender = peer.pc
              .getTransceivers()
              .find(
                (transceiver) =>
                  transceiver.sender.track?.kind === "audio" ||
                  transceiver.receiver.track.kind === "audio",
              )?.sender;
            if (!audioSender) {
              renegotiate.push({ viewerId, peer });
              continue;
            }
            try {
              await boundedRtcOperation(
                audioSender.replaceTrack(track),
                `替换观看端 ${viewerId} 的 P2P 音轨超时`,
                RTC_TRACK_REPLACE_TIMEOUT_MS,
              );
              replacedSenders += 1;
            } catch {
              renegotiate.push({ viewerId, peer });
            }
          }
          for (const { viewerId, peer } of renegotiate) {
            if (outboundPeers.get(viewerId) !== peer) continue;
            await createOfferForViewer(
              viewerId,
              peer.codecAttempt || 1,
              [],
              peer.sessionId,
            );
          }
          await replacePublishedSfuScreenTrack(
            track,
            "process-audio-recovered",
          );
          const mainStatus = await boundedUiOperation(
            Promise.resolve(window.roomDesktop?.getProcessAudioStatus()),
            2_000,
            "读取声音恢复状态超时",
          ).catch(() => undefined);
          window.roomDesktop?.reportDiagnostic("process-audio-recovered", {
            reason: reason.slice(0, 300),
            attempt: index + 1,
            replacedSenders,
            renegotiatedPeers: renegotiate.length,
            rendererStatus: capture.diagnostics,
            mainStatus,
          });
          notify("窗口声音已经自动恢复，所有观看者的音轨已更新。");
          return;
        } catch (error) {
          lastError = error;
        }
      }
      const mainStatus = await boundedUiOperation(
        Promise.resolve(window.roomDesktop?.getProcessAudioStatus()),
        2_000,
        "读取声音恢复失败状态超时",
      ).catch(() => undefined);
      window.roomDesktop?.reportDiagnostic("process-audio-recovery-failed", {
        reason: reason.slice(0, 300),
        message:
          lastError instanceof Error
            ? lastError.message.slice(0, 300)
            : String(lastError || "未知错误").slice(0, 300),
        mainStatus,
      });
      notify(
        `窗口声音自动恢复失败，画面仍会继续放映：${
          lastError instanceof Error ? lastError.message : "未知错误"
        }`,
        true,
      );
    })();
    audioRecoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      if (audioRecoveryPromise === recovery) {
        audioRecoveryPromise = undefined;
      }
    }
  }

  async function prepareLocalBroadcast(sourceId: string): Promise<void> {
    if (!window.roomDesktop || !signal || preparingBroadcast) return;
    if (broadcasterId) {
      notify(
        broadcasterId === selfId
          ? "请先停止当前放映，再切换放映方式"
          : `${broadcasterNickname || "其他成员"}正在放映，暂时无法开始新的放映`,
        true,
      );
      closeBroadcastDialog();
      return;
    }
    if (musicController?.active) {
      await musicController.stop(false);
      if (leaving || broadcasterId) return;
      notify("已停止共享伴奏，并把窗口声音通道交给屏幕放映。", "info");
    }
    preparingBroadcast = true;
    const preparationEpoch = ++broadcastPreparationEpoch;
    const broadcastAudioEpoch = ++audioCaptureEpoch;
    const broadcastVideoEpoch = ++captureVideoEpoch;
    localBroadcastMode = "screen";
    const preset = buildQualityPreset(resolutionKey, frameRate);
    activePreset = preset;
    bandwidthLimitedSamples = 0;
    bandwidthWarningShown = false;
    cpuWarningShown = false;
    relayFallbackNoticeShown = false;
    highRttSamples = 0;
    highRttWarningShown = false;
    awaitingBroadcastGrant = true;
    updateBroadcastControls();
    const broadcastStillCurrent = (): boolean =>
      !leaving &&
      preparationEpoch === broadcastPreparationEpoch &&
      broadcastAudioEpoch === audioCaptureEpoch &&
      broadcastVideoEpoch === captureVideoEpoch &&
      localBroadcastMode === "screen";
    const requireCurrentBroadcast = (): void => {
      if (!broadcastStillCurrent()) {
        throw new DOMException("屏幕放映启动已取消", "AbortError");
      }
    };
    try {
      setStatus("正在取得所选窗口画面", "neutral");
      const selection = await boundedUiOperation(
        window.roomDesktop.selectSource(sourceId),
        5_000,
        "选择共享窗口超时；请刷新窗口列表后重试",
      );
      requireCurrentBroadcast();
      activeCaptureSourceId = selection.id;
      captureSourceGeometry = undefined;
      closeBroadcastDialog();
      window.roomDesktop.reportDiagnostic("capture-start", {
        sourceName: selection.name,
        sourceHandle: selection.windowHandle,
        width: preset.width,
        height: preset.height,
        frameRate: preset.frameRate,
      });
      displayStream = await captureSelectedWindow(selection.id, preset);
      requireCurrentBroadcast();
      const sourceTrack = displayStream.getVideoTracks()[0];
      if (!sourceTrack) throw new Error("没有获取到窗口画面");
      setStatus("窗口画面已取得 · 正在连接影片声音", "neutral");
      // Set this before the track is ever added to a PeerConnection so the
      // display source is encoded as movie motion rather than text/screen
      // content from the first frame.
      bindCaptureVideoTrack(sourceTrack, broadcastVideoEpoch);
      // Keep Chromium's native WGC video track intact. Routing it through a
      // 2D canvas can turn hardware/HDR surfaces black and discards HDR color
      // metadata before WebRTC gets a chance to tone-map it.
      let movieAudioTrack: MediaStreamTrack | undefined;
      let movieAudioError = "";
      const firewallPromise = window.roomDesktop
        .ensurePortableFirewall()
        .catch(() => ({
          portable: true,
          configured: false,
          repaired: false,
        }));
      try {
        ({ track: movieAudioTrack } = await startMovieAudioCapture(
          broadcastAudioEpoch,
          2,
        ));
        requireCurrentBroadcast();
      } catch (audioError) {
        requireCurrentBroadcast();
        movieAudioError =
          audioError instanceof Error ? audioError.message : "未知错误";
        notify(
          `窗口画面已经取得，但影片声音暂未启动；画面先继续放映，声音将在后台自动重试：${movieAudioError}`,
          true,
        );
      }
      // Publish the stream object before waiting for a possible 60-second UAC
      // prompt. If WASAPI or its helper fails during that prompt, the existing
      // recovery path can now replace/add the audio track instead of returning
      // early because mediaStream is still undefined.
      mediaStream = new MediaStream([
        sourceTrack,
        ...(movieAudioTrack?.readyState === "live"
          ? [movieAudioTrack]
          : []),
      ]);
      startCaptureVideoHealthMonitor(broadcastVideoEpoch);
      const captureCapabilities = readCaptureCapabilities(preset, sourceTrack);
      setBroadcastCapabilities(captureCapabilities);
      await boundedUiOperation(
        window.roomDesktop.setCaptureActive(true),
        3_000,
        "启用桌面采集状态超时",
      );
      requireCurrentBroadcast();
      if (
        movieAudioTrack?.readyState !== "live" ||
        !audioCapture?.active
      ) {
        void recoverProcessAudioCapture(
          audioCapture,
          movieAudioError || "窗口声音在连接准备阶段中断",
          broadcastAudioEpoch,
        );
      }

      setStatus("正在取得放映权", "neutral");
      window.roomDesktop.reportDiagnostic("capture-ready", {
        videoWidth: sourceTrack.getSettings().width,
        videoHeight: sourceTrack.getSettings().height,
        videoFrameRate: sourceTrack.getSettings().frameRate,
        movieAudio: mediaStream
          .getAudioTracks()
          .some((track) => track.readyState === "live"),
        firewallCheckPending: true,
      });
      if (
        !safeSignalSend({
          type: "broadcast:start",
          broadcastCapabilities: captureCapabilities,
        })
      ) {
        throw new Error("信令连接已断开，无法取得放映权");
      }
      void firewallPromise.then((firewall) => {
        if (!broadcastStillCurrent()) return;
        window.roomDesktop?.reportDiagnostic("portable-firewall-result", {
          configured: firewall.configured,
          repaired: firewall.repaired,
          mode: "screen",
        });
        if (firewall.portable && !firewall.configured) {
          notify(
            "未获得 Windows 防火墙修复权限；SFU 主线路仍可播放，P2P 备用直连可能不可用。",
            true,
          );
        }
      });
    } catch (error) {
      const superseded = !broadcastStillCurrent();
      await cleanupLocalBroadcast();
      if (superseded || leaving) return;
      updateBroadcastControls();
      renderBroadcastSources();
      const broadcastDialog =
        document.querySelector<HTMLDialogElement>("#broadcast-dialog");
      if (broadcastDialog && !broadcastDialog.open) {
        openDialog(broadcastDialog);
      }
      setStatus("放映启动失败 · 请重新选择窗口", "error");
      const message = friendlyCaptureError(error);
      window.roomDesktop.reportDiagnostic("capture-failed", {
        name:
          error instanceof DOMException
            ? error.name
            : error instanceof Error
              ? error.name
              : "UnknownError",
        message: message.slice(0, 300),
      });
      notify(message, true);
    } finally {
      preparingBroadcast = false;
    }
  }

  function closeBroadcastDialog(): void {
    hideEmbyItemPopup(false);
    const dialog =
      document.querySelector<HTMLDialogElement>("#broadcast-dialog");
    if (dialog) closeDialog(dialog);
  }

  async function openBroadcastDialog(): Promise<void> {
    if (!desktop || !window.roomDesktop || broadcasterId) return;
    const dialog =
      document.querySelector<HTMLDialogElement>("#broadcast-dialog");
    if (!dialog) return;
    qualitySelectionTouched = false;
    frameRateLockedByUser = false;
    openDialog(dialog);
    applyBandwidthRecommendation(true);
    // Let the modal and its mode transition paint before entering desktop
    // source enumeration. The latter crosses into Electron/Windows and may
    // briefly contend with the compositor on machines with many windows.
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });
    void updateDisplayFrameRateLimits();
    await loadBroadcastSources();
  }

  function syncBroadcastQualityUi(): void {
    document
      .querySelectorAll<HTMLButtonElement>("[data-session-resolution]")
      .forEach((button) => {
        const active = button.dataset.sessionResolution === resolutionKey;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    document
      .querySelectorAll<HTMLButtonElement>("[data-session-frame-rate]")
      .forEach((button) => {
        const active =
          Number(button.dataset.sessionFrameRate) === frameRate;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    document
      .querySelectorAll<HTMLButtonElement>("[data-screen-content-mode]")
      .forEach((button) => {
        const active =
          button.dataset.screenContentMode === screenContentMode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    const summary = document.querySelector<HTMLElement>(
      "#session-quality-summary",
    );
    if (summary) {
      summary.textContent = buildQualityPreset(
        resolutionKey,
        frameRate,
      ).detail;
    }
    const smartReason = document.getElementById("screen-smart-reason");
    if (smartReason) {
      smartReason.textContent =
        `${buildQualityPreset(resolutionKey, frameRate).detail} · ` +
        networkAdvice.reason;
    }
    updateSelectedSourceSummary();
  }

  function renderNetworkRecommendation(): void {
    const card = document.querySelector<HTMLElement>(
      "#broadcast-network-card",
    );
    if (!card) return;
    card.dataset.confidence = networkAdvice.confidence;
    const confidence = card.querySelector<HTMLElement>(
      "#network-confidence",
    );
    const upload = card.querySelector<HTMLElement>("#network-upload");
    const download = card.querySelector<HTMLElement>("#network-download");
    const latency = card.querySelector<HTMLElement>("#network-latency");
    const roomSize = card.querySelector<HTMLElement>("#network-room-size");
    const route = card.querySelector<HTMLElement>("#network-route");
    const reason = card.querySelector<HTMLElement>(
      "#network-advice-reason",
    );
    if (confidence) {
      confidence.textContent = networkProbePromise
        ? "正在刷新网络样本"
        : `${networkConfidenceLabel(networkAdvice.confidence)} · ${networkAdvice.measuredCount}/${networkAdvice.participantCount} 台已测`;
    }
    if (upload) upload.textContent = formatNetworkRate(networkReport?.uploadKbps);
    if (download) {
      download.textContent = formatNetworkRate(networkReport?.downloadKbps);
    }
    if (latency) {
      latency.textContent = networkReport
        ? `${Math.round(networkReport.signalRttMs)} ms`
        : "待检测";
    }
    if (roomSize) {
      roomSize.textContent = `${networkAdvice.participantCount} 台`;
    }
    if (route) route.textContent = networkRouteLabel(networkAdvice.routeMode);
    if (reason) reason.textContent = networkAdvice.reason;
  }

  function applyBandwidthRecommendation(
    applySelection = false,
  ): void {
    const localRecommendation = recommendBroadcastPreset(
      measuredAvailableOutgoingBitrate,
    );
    const recommendation =
      networkAdvice.revision > 0
        ? {
            resolution: networkAdvice.recommendedResolution,
            reason: networkAdvice.reason,
          }
        : localRecommendation;
    // A bandwidth-only score cannot see local GPU/encoder contention. Keep the
    // automatic path at a stable 2K ceiling; 4K remains available when the
    // broadcaster deliberately selects it after seeing the source preview.
    const stableRecommendation =
      recommendation.resolution === "original"
        ? {
            resolution: "ultra" as ResolutionKey,
            reason: `${recommendation.reason}；已按本机实时编码稳定性默认到 2K，可手动选择 4K`,
          }
        : recommendation;
    const hint = document.querySelector<HTMLElement>("#bw-recommend-hint");
    if (hint) hint.textContent = stableRecommendation.reason;
    document
      .querySelectorAll<HTMLElement>(
        "[data-session-resolution] .quality-recommended-badge",
      )
      .forEach((badge) => { badge.hidden = true; });
    const recResolutionBtn = document.querySelector<HTMLButtonElement>(
      `[data-session-resolution="${stableRecommendation.resolution}"] .quality-recommended-badge`,
    );
    if (recResolutionBtn) recResolutionBtn.hidden = false;
    if (applySelection) {
      const selected = selectResolutionAndFrameRate({
        resolution: stableRecommendation.resolution,
        // The recommendation (including the local 2K encoder ceiling) was
        // already resolved immediately above.
        resolutionLockedByUser: true,
        currentFrameRate: frameRate,
        frameRateLockedByUser,
        advice: networkAdvice,
      });
      resolutionKey = selected.resolution;
      frameRate = selected.frameRate;
    }
    syncBroadcastQualityUi();
    renderNetworkRecommendation();
  }

  function scheduleNetworkAdviceExpiry(advice: NetworkAdvice): void {
    if (networkAdviceExpiryTimer !== undefined) {
      window.clearTimeout(networkAdviceExpiryTimer);
      networkAdviceExpiryTimer = undefined;
    }
    if (!advice.validUntil) return;
    const revision = advice.revision;
    const expire = (): void => {
      networkAdviceExpiryTimer = undefined;
      if (networkAdvice.revision !== revision) return;
      networkAdvice = fallbackNetworkAdvice(Math.max(1, participants.size));
      applyBandwidthRecommendation(false);
      updateEmbyBudget();
    };
    const delayMs = Math.max(0, advice.validUntil - Date.now());
    if (delayMs === 0) {
      expire();
      return;
    }
    networkAdviceExpiryTimer = window.setTimeout(
      expire,
      Math.min(delayMs, 2_147_483_647),
    );
  }

  function refreshNetworkReport(force = false): Promise<void> {
    if (!signal?.connected || leaving) return Promise.resolve();
    // Feature negotiation is deliberately opt-in. A 2.4-or-older signaling
    // service treats every network:* envelope as an unknown operation and
    // returns a generic error. Never send optional probes unless the joined
    // response explicitly advertised them.
    if (
      !signalFeatures.has("network-probe") ||
      !signalFeatures.has("network-report")
    ) {
      networkProbePromise = undefined;
      networkAdvice = fallbackNetworkAdvice(Math.max(1, participants.size));
      renderNetworkRecommendation();
      return Promise.resolve();
    }
    if (broadcasterId && broadcastCapabilities) {
      // A v2 probe moves roughly 4 MiB through the signaling socket. Running
      // that burst while a viewer is filling its first media buffer—or while
      // the host is uploading—can manufacture the very weak-network stall it
      // is meant to diagnose. Playback stats and ICE selection are already
      // route-specific, so defer active throughput probing until the room is
      // idle and keep any previously measured report as advisory evidence.
      if (networkProbePromise) {
        networkProbeGeneration += 1;
        networkProbeAbortController.abort();
        networkProbeAbortController = new AbortController();
        networkProbePromise = undefined;
      }
      networkAdvice = fallbackNetworkAdvice(
        Math.max(1, participants.size),
      );
      renderNetworkRecommendation();
      return Promise.resolve();
    }
    if (networkProbePromise) return networkProbePromise;
    const generation = networkProbeGeneration;
    const refresh = (async () => {
      renderNetworkRecommendation();
      const baseReport = await ensureNetworkProbe(signalUrl, signal!, {
        force,
        abortSignal: networkProbeAbortController.signal,
        cacheResult: false,
        cacheScope: room,
        serverVersions: networkProbeVersions,
      });
      if (
        !baseReport ||
        leaving ||
        generation !== networkProbeGeneration ||
        !signal?.connected
      ) {
        return;
      }
      const candidateGatherability =
        await probeIceCandidateGatherability(
        iceServers,
        networkProbeAbortController.signal,
        { networkType: baseReport.networkType },
      );
      if (
        leaving ||
        generation !== networkProbeGeneration ||
        !signal?.connected
      ) {
        return;
      }
      const report: NetworkReport = {
        ...baseReport,
        ...candidateGatherability,
      };
      networkReport = report;
      updateEmbySegmentRenditionDemand();
      sendNetworkReportWhenAllowed();
      if (
        broadcastCapabilities?.mode === "emby" &&
        broadcasterId &&
        broadcasterId !== selfId &&
        preferredHeight === 0
      ) {
        sendViewerQualityPreference(false);
      }
    })().finally(() => {
      if (
        generation === networkProbeGeneration &&
        networkProbePromise === refresh
      ) {
        networkProbePromise = undefined;
      }
      if (generation !== networkProbeGeneration) return;
      const dialog =
        document.querySelector<HTMLDialogElement>("#broadcast-dialog");
      applyBandwidthRecommendation(
        Boolean(dialog?.open && !qualitySelectionTouched),
      );
    });
    networkProbePromise = refresh;
    renderNetworkRecommendation();
    return refresh;
  }

  function scheduleMembershipNetworkProbe(): void {
    if (networkMembershipProbeTimer !== undefined) {
      window.clearTimeout(networkMembershipProbeTimer);
    }
    // Join/leave events often arrive in a short burst while a client resumes.
    // Coalesce that burst so every device performs one fresh room sample, not
    // one multi-megabyte probe per signaling envelope.
    networkMembershipProbeTimer = window.setTimeout(() => {
      networkMembershipProbeTimer = undefined;
      void refreshNetworkReport(true);
    }, 700);
  }

  function sendNetworkReportWhenAllowed(): void {
    if (
      !networkReport ||
      !joined ||
      !signal?.connected ||
      leaving ||
      !signalFeatures.has("network-report")
    ) {
      return;
    }
    if (networkReportSendTimer !== undefined) {
      window.clearTimeout(networkReportSendTimer);
      networkReportSendTimer = undefined;
    }
    const waitMs = Math.max(
      0,
      5_200 - (Date.now() - lastNetworkReportSentAt),
    );
    if (waitMs > 0) {
      networkReportSendTimer = window.setTimeout(() => {
        networkReportSendTimer = undefined;
        sendNetworkReportWhenAllowed();
      }, waitMs);
      return;
    }
    if (
      safeSignalSend({
        type: "network:report",
        networkReport,
      })
    ) {
      lastNetworkReportSentAt = Date.now();
    }
  }

  type SourceFilter = "recent" | "player" | "browser" | "all";
  const recentSourceKey = "synced:recent-capture-sources";
  let broadcastSources: CaptureSource[] = [];
  let selectedBroadcastSourceId = "";
  let sourceFilter: SourceFilter = "all";
  let sourceEnumerationGeneration = 0;

  function recentCaptureSources(): Array<{
    id: string;
    name: string;
    usedAt: number;
  }> {
    try {
      const stored = JSON.parse(localStorage.getItem(recentSourceKey) || "[]");
      if (!Array.isArray(stored)) return [];
      return stored
        .filter(
          (entry) =>
            entry &&
            typeof entry.id === "string" &&
            typeof entry.name === "string" &&
            Number.isFinite(entry.usedAt),
        )
        .slice(0, 8);
    } catch {
      return [];
    }
  }

  function rememberCaptureSource(source: CaptureSource): void {
    const next = [
      { id: source.id, name: source.name, usedAt: Date.now() },
      ...recentCaptureSources().filter(
        (entry) => entry.id !== source.id && entry.name !== source.name,
      ),
    ].slice(0, 8);
    localStorage.setItem(recentSourceKey, JSON.stringify(next));
  }

  function sourceCategory(
    source: CaptureSource,
  ): Exclude<SourceFilter, "recent" | "all"> | "other" {
    const identity =
      `${source.processName || ""} ${source.executableName || ""} ${source.name}`
        .toLocaleLowerCase("zh-CN");
    if (
      /(chrome|msedge|firefox|brave|opera|vivaldi|browser|浏览器)/iu.test(
        identity,
      )
    ) {
      return "browser";
    }
    if (
      /(potplayer|vlc|mpv|mpc|media player|video|player|播放器|影视|爱奇艺|腾讯视频|哔哩哔哩)/iu.test(
        identity,
      )
    ) {
      return "player";
    }
    return "other";
  }

  function updateSelectedSourceSummary(): void {
    const source = broadcastSources.find(
      (candidate) => candidate.id === selectedBroadcastSourceId,
    );
    const name = document.getElementById("selected-source-name");
    const detail = document.getElementById("selected-source-detail");
    const readyTitle = document.getElementById("broadcast-ready-title");
    const readyDetail = document.getElementById("broadcast-ready-detail");
    const start =
      document.querySelector<HTMLButtonElement>("#start-screen-broadcast");
    if (!source) {
      if (name) name.textContent = "请选择要放映的窗口";
      if (detail) {
        detail.textContent = "选择后可在开始前确认分辨率与声音能力";
      }
      if (readyTitle) readyTitle.textContent = "选择一个来源后即可开始";
      if (readyDetail) {
        readyDetail.textContent = "启动前会再次确认画质、帧率和声音";
      }
      if (start) start.disabled = true;
      return;
    }
    const dimensions =
      source.width && source.height
        ? `${source.width}×${source.height}`
        : "启动时确认尺寸";
    const audio = source.audioAvailable
      ? "可采集应用声音"
      : "声音能力启动时确认";
    if (name) name.textContent = source.name || "未命名窗口";
    if (detail) detail.textContent = `${dimensions} · ${audio}`;
    if (readyTitle) {
      readyTitle.textContent = `当前：${source.name || "未命名窗口"}`;
    }
    if (readyDetail) {
      readyDetail.textContent =
        `${dimensions} · ${audio} · ${buildQualityPreset(resolutionKey, frameRate).detail}`;
    }
    if (start) start.disabled = preparingBroadcast;
  }

  function renderBroadcastSources(): void {
    const grid = document.querySelector<HTMLElement>("#session-source-grid");
    const count = document.querySelector<HTMLElement>(
      "#session-source-count",
    );
    const search = document.querySelector<HTMLInputElement>(
      "#session-source-search",
    );
    if (!grid) return;
    const query = search?.value.trim().toLocaleLowerCase("zh-CN") || "";
    const recent = recentCaptureSources();
    const recentIds = new Set(recent.map((entry) => entry.id));
    const recentNames = new Set(recent.map((entry) => entry.name));
    const visible = broadcastSources.filter((source) => {
      if (
        query &&
        !`${source.name} ${source.processName || ""} ${source.executableName || ""}`
          .toLocaleLowerCase("zh-CN")
          .includes(query)
      ) {
        return false;
      }
      if (sourceFilter === "all") return true;
      if (sourceFilter === "recent") {
        return recentIds.has(source.id) || recentNames.has(source.name);
      }
      return sourceCategory(source) === sourceFilter;
    });
    if (count) {
      count.textContent = query || sourceFilter !== "all"
        ? `显示 ${visible.length} / 共 ${broadcastSources.length} 个`
        : `共 ${broadcastSources.length} 个窗口 · 向下滚动查看全部`;
    }
    if (!visible.length) {
      grid.innerHTML = `<div class="loading-state">${
        broadcastSources.length
          ? "没有匹配的窗口，请换个关键词"
          : "没有发现可分享的窗口；请先打开并恢复播放器，然后刷新"
      }</div>`;
      return;
    }
    grid.innerHTML = visible
      .map(
        (source) => `
          <button class="source-card${selectedBroadcastSourceId === source.id ? " selected" : ""}"
                  data-session-source="${escapeHtml(source.id)}" type="button"
                  role="option"
                  aria-selected="${selectedBroadcastSourceId === source.id}"
                  data-selected="${selectedBroadcastSourceId === source.id}"
                  title="${escapeHtml(source.name || "未命名窗口")}">
            <span class="source-preview">
              ${
                source.thumbnail
                  ? `<img src="${source.thumbnail}" alt="" decoding="async" />`
                  : ""
              }
              <span class="source-placeholder" aria-hidden="true" ${source.thumbnail ? "hidden" : ""}>
                <i data-lucide="monitor-play"></i>
              </span>
              ${
                source.appIcon
                  ? `<img class="source-app-icon" src="${source.appIcon}" alt="" width="28" height="28" />`
                  : ""
              }
              <span class="source-selected-check" aria-hidden="true">
                <i data-lucide="check"></i>
              </span>
            </span>
            <span class="source-card-copy">
              <strong>${escapeHtml(source.name || "未命名窗口")}</strong>
              <small>${source.width && source.height ? `${source.width}×${source.height}` : "尺寸待确认"} · ${source.audioAvailable ? "可采集声音" : "声音待确认"}</small>
            </span>
            ${
              recentIds.has(source.id) || recentNames.has(source.name)
                ? `<span class="source-recent-badge">最近使用</span>`
                : ""
            }
          </button>
        `,
      )
      .join("");
    hydrateIcons(grid);
    grid.querySelectorAll<HTMLImageElement>(".source-preview > img").forEach(
      (image) => {
        image.addEventListener(
          "error",
          () => {
            image.hidden = true;
            const placeholder =
              image.parentElement?.querySelector<HTMLElement>(
                ".source-placeholder",
              );
            if (placeholder) placeholder.hidden = false;
          },
          { once: true },
        );
      },
    );
    grid
      .querySelectorAll<HTMLButtonElement>("[data-session-source]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          if (preparingBroadcast) return;
          selectedBroadcastSourceId = button.dataset.sessionSource || "";
          grid
            .querySelectorAll<HTMLButtonElement>("[data-session-source]")
            .forEach((item) => {
              const selected =
                item.dataset.sessionSource === selectedBroadcastSourceId;
              item.classList.toggle("selected", selected);
              item.setAttribute("aria-selected", String(selected));
              item.dataset.selected = String(selected);
            });
          updateSelectedSourceSummary();
        });
      });
    updateSelectedSourceSummary();
  }

  async function loadBroadcastSources(): Promise<void> {
    if (!window.roomDesktop) return;
    const grid = document.querySelector<HTMLElement>("#session-source-grid");
    const refresh = document.querySelector<HTMLButtonElement>(
      "#refresh-session-sources",
    );
    const count = document.querySelector<HTMLElement>(
      "#session-source-count",
    );
    if (!grid) return;
    const generation = ++sourceEnumerationGeneration;
    grid.innerHTML = Array.from(
      { length: 6 },
      () =>
        `<div class="source-card source-skeleton" aria-hidden="true"><span></span><i></i></div>`,
    ).join("");
    if (count) count.textContent = "正在刷新";
    if (refresh) refresh.disabled = true;
    try {
      broadcastSources = await boundedUiOperation(
        window.roomDesktop.listSources(),
        5_000,
        "读取可共享窗口超时",
      );
      if (
        generation !== sourceEnumerationGeneration ||
        leaving ||
        !grid.isConnected
      ) {
        return;
      }
      if (
        selectedBroadcastSourceId &&
        !broadcastSources.some(
          (source) => source.id === selectedBroadcastSourceId,
        )
      ) {
        selectedBroadcastSourceId = "";
      }
      renderBroadcastSources();
    } catch (error) {
      if (generation !== sourceEnumerationGeneration || leaving) return;
      grid.innerHTML = `<div class="loading-state">${escapeHtml(error instanceof Error ? error.message : "读取窗口失败")}</div>`;
      if (count) count.textContent = "读取失败";
    } finally {
      if (refresh?.isConnected) refresh.disabled = false;
    }
  }

  function switchBroadcastMode(mode: "screen" | "emby"): void {
    const screenPanel =
      document.querySelector<HTMLElement>("#screen-broadcast-panel");
    const embyPanel =
      document.querySelector<HTMLElement>("#emby-broadcast-panel");
    const tabs =
      document.querySelector<HTMLElement>(".broadcast-mode-tabs");
    if (!screenPanel || !embyPanel) return;

    const previousMode = activeBroadcastMode;
    activeBroadcastMode = mode;
    broadcastModeAbort?.abort();
    broadcastModeAbort = new AbortController();
    const transition = ++broadcastModeTransition;

    screenPanel?.toggleAttribute("hidden", mode !== "screen");
    embyPanel?.toggleAttribute("hidden", mode !== "emby");
    tabs?.setAttribute("data-active-mode", mode);
    document
      .querySelectorAll<HTMLButtonElement>("[data-broadcast-mode]")
      .forEach((button) => {
        const active = button.dataset.broadcastMode === mode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
        button.dataset.selected = String(active);
        button.tabIndex = active ? 0 : -1;
      });

    const incoming = mode === "emby" ? embyPanel : screenPanel;
    if (previousMode !== mode) {
      const direction = mode === "emby" ? 1 : -1;
      incoming.classList.add("is-mode-switching");
      void animateElement(
        incoming,
        [
          {
            opacity: 0,
            transform: `translate3d(${direction * 12}px, 0, 0)`,
          },
          { opacity: 1, transform: "translate3d(0, 0, 0)" },
        ],
        {
          kind: "panel",
          id: "broadcast-mode",
          signal: broadcastModeAbort.signal,
        },
      ).finally(() => {
        if (transition === broadcastModeTransition) {
          incoming.classList.remove("is-mode-switching");
        }
      });
    }
    if (mode === "emby") {
      void refreshEmbyAccounts();
      updateEmbyHevcSupport();
    }
  }

  function endpointEditor(
    context: "login" | "manage",
  ): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      `[data-emby-endpoint-editor="${context}"]`,
    );
  }

  function applyEndpointDraft(
    row: HTMLElement,
    draft: EmbyEndpointDraft,
  ): void {
    const protocol = row.querySelector<HTMLSelectElement>(
      "[data-emby-endpoint-protocol]",
    );
    const host = row.querySelector<HTMLInputElement>(
      "[data-emby-endpoint-host]",
    );
    const port = row.querySelector<HTMLInputElement>(
      "[data-emby-endpoint-port]",
    );
    const path = row.querySelector<HTMLInputElement>(
      "[data-emby-endpoint-path]",
    );
    if (protocol) protocol.value = draft.protocol;
    if (host) host.value = draft.host;
    if (port) port.value = draft.port;
    if (path) path.value = draft.path;
    row.dataset.endpointProtocol = draft.protocol;
  }

  function setEndpointEditorUrls(
    context: "login" | "manage",
    urls: string[],
  ): void {
    const editor = endpointEditor(context);
    const list = editor?.querySelector<HTMLElement>(
      "[data-emby-endpoint-list]",
    );
    if (!list) return;
    const values = urls.length ? urls.slice(0, 8) : [""];
    list.innerHTML = values
      .map((value, index) =>
        embyEndpointRowMarkup(safeEmbyEndpointDraft(value), index === 0),
      )
      .join("");
    list
      .querySelectorAll<HTMLElement>("[data-emby-endpoint-row]")
      .forEach((row) => {
        row.dataset.endpointProtocol =
          row.querySelector<HTMLSelectElement>(
            "[data-emby-endpoint-protocol]",
          )?.value || "https";
      });
  }

  function endpointEditorFeedback(
    editor: HTMLElement,
    message: string,
    error = false,
  ): void {
    const feedback = editor.querySelector<HTMLElement>(
      "[data-emby-endpoint-feedback]",
    );
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle("error", error);
  }

  function collectEndpointEditorUrls(
    context: "login" | "manage",
  ): string[] {
    const editor = endpointEditor(context);
    if (!editor) return [];
    const urls: string[] = [];
    for (const row of editor.querySelectorAll<HTMLElement>(
      "[data-emby-endpoint-row]",
    )) {
      const protocol =
        row.querySelector<HTMLSelectElement>(
          "[data-emby-endpoint-protocol]",
        )?.value === "http"
          ? "http"
          : "https";
      const host =
        row.querySelector<HTMLInputElement>("[data-emby-endpoint-host]")
          ?.value || "";
      const port =
        row.querySelector<HTMLInputElement>("[data-emby-endpoint-port]")
          ?.value || "";
      const path =
        row.querySelector<HTMLInputElement>("[data-emby-endpoint-path]")
          ?.value || "";
      const url = composeEmbyEndpoint({
        protocol,
        host,
        port,
        path,
      });
      if (!urls.includes(url)) urls.push(url);
    }
    if (!urls.length) throw new Error("请至少填写一条服务器线路");
    endpointEditorFeedback(
      editor,
      `${urls.length} 条线路已就绪${urls.length > 1 ? "，保存时会逐条验证" : ""}`,
    );
    return urls;
  }

  function bindEndpointEditor(context: "login" | "manage"): void {
    const editor = endpointEditor(context);
    if (!editor) return;
    setEndpointEditorUrls(
      context,
      context === "login"
        ? [localStorage.getItem("synced:emby-server") || ""]
        : [""],
    );
    editor.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-add-emby-endpoint]")) {
        const list = editor.querySelector<HTMLElement>(
          "[data-emby-endpoint-list]",
        );
        if (!list) return;
        const rows = list.querySelectorAll("[data-emby-endpoint-row]");
        if (rows.length >= 8) {
          endpointEditorFeedback(editor, "每台服务器最多 8 条线路", true);
          return;
        }
        list.insertAdjacentHTML(
          "beforeend",
          embyEndpointRowMarkup(parseEmbyEndpointInput(""), false),
        );
        const row = list.lastElementChild as HTMLElement | null;
        if (row) {
          hydrateIcons(row);
          row.dataset.endpointProtocol = "https";
          row
            .querySelector<HTMLInputElement>("[data-emby-endpoint-host]")
            ?.focus();
        }
        return;
      }
      const remove = target.closest("[data-remove-emby-endpoint]");
      if (remove) {
        remove.closest("[data-emby-endpoint-row]")?.remove();
        endpointEditorFeedback(editor, "");
      }
    });
    editor.addEventListener("change", (event) => {
      const select = (event.target as Element | null)?.closest<HTMLSelectElement>(
        "[data-emby-endpoint-protocol]",
      );
      if (!select) return;
      const row = select.closest<HTMLElement>("[data-emby-endpoint-row]");
      const port = row?.querySelector<HTMLInputElement>(
        "[data-emby-endpoint-port]",
      );
      const previous =
        row?.dataset.endpointProtocol === "http" ? "http" : "https";
      const next: EmbyEndpointProtocol =
        select.value === "http" ? "http" : "https";
      if (!port?.value || port.value === endpointDefaultPort(previous)) {
        if (port) port.value = endpointDefaultPort(next);
      }
      if (row) row.dataset.endpointProtocol = next;
    });
    editor.addEventListener("paste", (event) => {
      const input = (event.target as Element | null)?.closest<HTMLInputElement>(
        "[data-emby-endpoint-host]",
      );
      if (!input) return;
      const pasted = event.clipboardData?.getData("text").trim() || "";
      if (!pasted) return;
      const row = input.closest<HTMLElement>("[data-emby-endpoint-row]");
      const protocol =
        row?.querySelector<HTMLSelectElement>(
          "[data-emby-endpoint-protocol]",
        )?.value === "http"
          ? "http"
          : "https";
      try {
        const draft = parseEmbyEndpointInput(pasted, protocol);
        event.preventDefault();
        if (row) applyEndpointDraft(row, draft);
        endpointEditorFeedback(editor, "已自动拆分协议、地址、端口与路径");
      } catch (error) {
        endpointEditorFeedback(
          editor,
          error instanceof Error ? error.message : "无法识别粘贴的地址",
          true,
        );
      }
    });
  }

  function renderEmbyAccountControls(): void {
    const savedPanel =
      document.querySelector<HTMLElement>("#emby-saved-accounts");
    const savedList =
      document.querySelector<HTMLElement>("#emby-saved-account-list");
    const savedNote =
      document.querySelector<HTMLElement>("#emby-saved-note");
    const switcher =
      document.querySelector<HTMLSelectElement>("#emby-account-switch");
    if (savedPanel) savedPanel.hidden = embyAccounts.length === 0;
    if (savedNote) {
      savedNote.textContent =
        embyAccountPersistence === "encrypted"
          ? `${embyAccounts.length} 个账户 · Windows 加密保存`
          : `${embyAccounts.length} 个账户 · 当前仅保留到本次退出`;
    }
    if (savedList) {
      savedList.innerHTML = embyAccounts
        .map(
          (account) => `
            <button type="button" class="emby-saved-account${account.id === embyActiveAccountId ? " active" : ""}" data-emby-account="${escapeHtml(account.id)}">
              <span class="emby-saved-account-copy"><strong>${escapeHtml(account.server.name)}</strong><span>${escapeHtml(account.user.name)} · ${escapeHtml(account.server.address)}</span></span>
              <small>${account.server.endpoints?.length || 1} 条线路</small>
            </button>
          `,
        )
        .join("");
      savedList
        .querySelectorAll<HTMLButtonElement>("[data-emby-account]")
        .forEach((button) => {
          button.addEventListener("click", () => {
            if (button.dataset.embyAccount) {
              void activateEmbyAccount(button.dataset.embyAccount);
            }
          });
        });
    }
    if (switcher) {
      switcher.innerHTML = embyAccounts
        .map(
          (account) =>
            `<option value="${escapeHtml(account.id)}" ${account.id === embyActiveAccountId ? "selected" : ""}>${escapeHtml(account.server.name)} · ${escapeHtml(account.user.name)}</option>`,
        )
        .join("");
      switcher.hidden = embyAccounts.length < 2;
    }
  }

  function hideEmbyItemPopup(restoreFocus = true): void {
    if (!embyItemPopup || embyItemPopup.hidden) return;
    embySelectionRequestId += 1;
    pendingEmbySelectionKey = "";
    const restoreTarget = embyDetailOpener;
    embyDetailOpener = undefined;
    const sourcePoster =
      restoreTarget?.querySelector<HTMLElement>(".emby-poster");
    const popupPoster =
      embyItemPopup.querySelector<HTMLElement>(".emby-popup-poster");
    const reduced =
      matchMedia("(prefers-reduced-motion: reduce)").matches ||
      document.documentElement.dataset.motion === "reduced";
    if (
      document.startViewTransition &&
      sourcePoster &&
      sourcePoster.isConnected &&
      popupPoster &&
      !reduced
    ) {
      embyDetailPresence?.cancel();
      popupPoster.style.setProperty("view-transition-name", "emby-poster");
      const transition = document.startViewTransition(() => {
        popupPoster.style.removeProperty("view-transition-name");
        embyItemPopup.hidden = true;
        embyItemPopup.dataset.presence = "left";
        sourcePoster.style.setProperty("view-transition-name", "emby-poster");
      });
      void transition.finished.finally(() => {
        sourcePoster.style.removeProperty("view-transition-name");
        if (restoreFocus && restoreTarget?.isConnected) {
          restoreTarget.focus();
        }
      });
      return;
    }
    void embyDetailPresence
      ?.hide(sessionUiAbortController.signal)
      .then(() => {
        if (restoreFocus && restoreTarget?.isConnected) {
          restoreTarget.focus();
        }
      });
  }

  function resetEmbyBrowser(clearItems = true): void {
    embySelectedItem = undefined;
    embyPlaybackInfo = undefined;
    embyBrowseRequestId += 1;
    embyLibraryRequestId += 1;
    embySelectionRequestId += 1;
    pendingEmbySelectionKey = "";
    hideEmbyItemPopup(false);
    if (!clearItems) return;
    embyVirtualGrid?.destroy();
    embyVirtualGrid = undefined;
    embyBrowseItems = [];
    embyBrowseTotal = 0;
    const grid = document.querySelector<HTMLElement>("#emby-item-grid");
    if (grid) grid.innerHTML = "";
    const loadMore =
      document.querySelector<HTMLButtonElement>("#emby-load-more");
    if (loadMore) loadMore.hidden = true;
  }

  function setEmbyLoginUi(loggedIn: boolean): void {
    const loginPanel =
      document.querySelector<HTMLElement>("#emby-login-panel");
    const libraryPanel =
      document.querySelector<HTMLElement>("#emby-library-panel");
    if (loginPanel) loginPanel.hidden = loggedIn;
    if (libraryPanel) libraryPanel.hidden = !loggedIn;
    renderEmbyAccountControls();
    if (loggedIn && embyLogin) {
      const name = document.querySelector<HTMLElement>("#emby-account-name");
      const detail =
        document.querySelector<HTMLElement>("#emby-account-detail");
      if (name) {
        name.textContent = `${embyLogin.user.name} · ${embyLogin.server.name}`;
      }
      if (detail) {
        detail.textContent = [
          embyLogin.server.address,
          embyLogin.server.version
            ? `Emby ${embyLogin.server.version}`
            : "",
          embyLogin.server.insecure ? "局域网 HTTP" : "HTTPS",
          `${embyLogin.server.endpoints?.length || 1} 条已验证线路`,
        ]
          .filter(Boolean)
          .join(" · ");
      }
    }
  }

  function boundedUiOperation<T>(
    operation: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      void operation.then(
        (value) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function refreshEmbyAccounts(loadContent = true): Promise<boolean> {
    const bridge = window.roomDesktop;
    if (!bridge) return false;
    const refreshRequestId = ++embyAccountRefreshRequestId;
    const previousAccountId = embyActiveAccountId;
    try {
      const state = await boundedUiOperation(
        bridge.embyAccounts(),
        4_000,
        "读取本机 Emby 账户超时；登录凭证仍保留，可点击账户重试",
      );
      if (refreshRequestId !== embyAccountRefreshRequestId) return false;
      embyAccounts = state.accounts;
      embyActiveAccountId = state.activeAccountId || "";
      embyAccountPersistence = state.persistence;
      const active = embyAccounts.find(
        (account) => account.id === embyActiveAccountId,
      );
      embyLogin = active;
      setEmbyLoginUi(Boolean(active));
      if (
        active &&
        loadContent &&
        (previousAccountId !== active.id || embyBrowseItems.length === 0)
      ) {
        resetEmbyBrowser();
        await loadEmbyLibraries();
        await loadEmbyItems();
      }
      return Boolean(active);
    } catch (error) {
      if (refreshRequestId !== embyAccountRefreshRequestId) return false;
      const status =
        document.querySelector<HTMLElement>("#emby-login-status");
      if (status) {
        status.textContent =
          error instanceof Error ? error.message : "读取本机 Emby 账户失败";
        status.classList.add("error");
      }
      // A transient IPC timeout must never erase or hide the last usable
      // in-memory account. The encrypted credential remains untouched and the
      // saved account button provides an immediate manual retry.
      if (!embyLogin) setEmbyLoginUi(false);
      return false;
    }
  }

  async function activateEmbyAccount(
    accountId: string,
    loadContent = true,
  ): Promise<boolean> {
    const bridge = window.roomDesktop;
    if (!bridge) return false;
    const activationRequestId = ++embyActivationRequestId;
    const status =
      document.querySelector<HTMLElement>("#emby-library-status");
    if (status) {
      status.textContent = "正在验证 Emby 账户与备用线路…";
      status.classList.remove("error");
    }
    try {
      const activation = embyActivationQueue
        .catch(() => undefined)
        .then(() =>
          boundedUiOperation(
            bridge.embyActivateAccount(accountId),
            6_000,
            "验证 Emby 账户超时；本机凭证未删除，请检查线路后重试",
          ),
        );
      embyActivationQueue = activation.then(
        () => undefined,
        () => undefined,
      );
      const account = await activation;
      if (activationRequestId !== embyActivationRequestId) return false;
      embyLogin = account;
      embyActiveAccountId = account.id;
      embyAccounts = [
        account,
        ...embyAccounts.filter((candidate) => candidate.id !== account.id),
      ];
      if (loadContent) {
        resetEmbyBrowser();
      } else {
        embyPlaybackInfo = undefined;
      }
      setEmbyLoginUi(true);
      if (loadContent) {
        await loadEmbyLibraries();
        await loadEmbyItems();
      }
      return true;
    } catch (error) {
      if (activationRequestId !== embyActivationRequestId) return false;
      if (status) {
        status.textContent =
          error instanceof Error ? error.message : "切换 Emby 服务器失败";
        status.classList.add("error");
      }
      return false;
    }
  }

  function beginAddingEmbyAccount(): void {
    // Keep the active account alive until a replacement login succeeds.
    // Clearing it here made a cancelled/failed add-account attempt strand an
    // already selected title in the misleading "正在恢复账户" state.
    setEmbyLoginUi(false);
    const username =
      document.querySelector<HTMLInputElement>("#emby-username");
    const password =
      document.querySelector<HTMLInputElement>("#emby-password");
    const status =
      document.querySelector<HTMLElement>("#emby-login-status");
    setEndpointEditorUrls("login", [""]);
    if (username) username.value = "";
    if (password) password.value = "";
    if (status) {
      status.textContent = "输入另一台 Emby 服务器；登录后会加入上方账户列表";
      status.classList.remove("error");
    }
    window.setTimeout(
      () =>
        endpointEditor("login")
          ?.querySelector<HTMLInputElement>("[data-emby-endpoint-host]")
          ?.focus(),
      0,
    );
  }

  async function loginEmby(): Promise<void> {
    const bridge = window.roomDesktop;
    const username =
      document.querySelector<HTMLInputElement>("#emby-username");
    const password =
      document.querySelector<HTMLInputElement>("#emby-password");
    const allowHttp =
      document.querySelector<HTMLInputElement>("#emby-allow-http");
    const submit =
      document.querySelector<HTMLButtonElement>("#emby-login-submit");
    const status =
      document.querySelector<HTMLElement>("#emby-login-status");
    if (!bridge || !username || !password) return;
    if (submit) submit.disabled = true;
    if (status) {
      status.textContent = "正在直接连接 Emby 服务器并验证账户…";
      status.classList.remove("error");
    }
    try {
      const serverUrls = collectEndpointEditorUrls("login");
      const account = await boundedUiOperation(
        bridge.embyLogin({
          serverUrl: serverUrls[0],
          serverUrls,
          username: username.value,
          password: password.value,
          allowInsecure: allowHttp?.checked === true,
        }),
        30_000,
        "连接 Emby 服务器超时；请检查地址或网络后重试",
      );
      embyLogin = account;
      embyActiveAccountId = account.id;
      const state = await boundedUiOperation(
        bridge.embyAccounts(),
        4_000,
        "读取登录后的 Emby 账户状态超时",
      );
      embyAccounts = state.accounts;
      embyAccountPersistence = state.persistence;
      localStorage.setItem("synced:emby-server", serverUrls[0]);
      resetEmbyBrowser();
      setEmbyLoginUi(true);
      await loadEmbyLibraries();
      await loadEmbyItems();
    } catch (error) {
      if (status) {
        status.textContent =
          error instanceof Error ? error.message : "Emby 登录失败";
        status.classList.add("error");
      }
    } finally {
      // The password is used once and is never retained in DOM or storage.
      password.value = "";
      if (submit?.isConnected) submit.disabled = false;
    }
  }

  function openEmbyEndpointManager(): void {
    if (!embyLogin) {
      notify("请先选择一个已保存的 Emby 服务器", "warn");
      return;
    }
    const urls =
      embyLogin.server.endpoints
        ?.sort((left, right) => left.priority - right.priority)
        .map((endpoint) => endpoint.url) || [embyLogin.server.address];
    setEndpointEditorUrls("manage", urls);
    const allowHttp = document.querySelector<HTMLInputElement>(
      "#emby-manage-allow-http",
    );
    if (allowHttp) {
      allowHttp.checked = urls.some((url) => /^http:\/\//i.test(url));
    }
    const dialog =
      document.querySelector<HTMLDialogElement>("#emby-endpoint-dialog");
    if (dialog) openDialog(dialog);
  }

  async function saveEmbyEndpoints(): Promise<void> {
    if (!window.roomDesktop || !embyLogin) return;
    const previousAccountId = embyLogin.id;
    const editor = endpointEditor("manage");
    const save = document.querySelector<HTMLButtonElement>(
      "#emby-save-endpoints",
    );
    const allowHttp = document.querySelector<HTMLInputElement>(
      "#emby-manage-allow-http",
    );
    if (save) {
      save.disabled = true;
      save.setAttribute("aria-busy", "true");
      save.textContent = "正在匿名验证每条线路…";
    }
    try {
      const serverUrls = collectEndpointEditorUrls("manage");
      const account = await boundedUiOperation(
        window.roomDesktop.embyUpdateEndpoints(embyLogin.id, {
          serverUrls,
          allowInsecure: allowHttp?.checked === true,
        }),
        30_000,
        "验证 Emby 备用线路超时；原有线路仍然保留",
      );
      embyLogin = account;
      embyActiveAccountId = account.id;
      embyAccounts = [
        account,
        ...embyAccounts.filter(
          (candidate) =>
            candidate.id !== account.id &&
            candidate.id !== previousAccountId,
        ),
      ];
      if (account.id !== previousAccountId) {
        embyBrowseItems = embyBrowseItems.map((item) =>
          item.accountId === previousAccountId
            ? { ...item, accountId: account.id }
            : item,
        );
        if (embySelectedItem?.accountId === previousAccountId) {
          embySelectedItem = {
            ...embySelectedItem,
            accountId: account.id,
          };
        }
      }
      setEmbyLoginUi(true);
      const dialog =
        document.querySelector<HTMLDialogElement>("#emby-endpoint-dialog");
      if (dialog?.open) closeDialog(dialog);
      notify(
        `${account.server.endpoints?.length || 1} 条 Emby 线路已验证并保存`,
        "info",
      );
    } catch (error) {
      if (editor) {
        endpointEditorFeedback(
          editor,
          error instanceof Error ? error.message : "线路验证失败",
          true,
        );
      }
    } finally {
      if (save?.isConnected) {
        save.disabled = false;
        save.removeAttribute("aria-busy");
        save.textContent = "保存并验证线路";
      }
    }
  }

  async function logoutEmby(): Promise<void> {
    const removedAddress = embyLogin?.server.address || "";
    await boundedUiOperation(
      Promise.resolve(window.roomDesktop?.embyLogout()),
      8_000,
      "移除 Emby 账户超时",
    ).catch((error) => {
      reportPlaybackDiagnostic("emby-logout-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    embyLogin = undefined;
    embyActiveAccountId = "";
    resetEmbyBrowser();
    await refreshEmbyAccounts(true);
    const server =
      document.querySelector<HTMLInputElement>("#emby-server-url");
    if (server && !embyLogin) server.value = removedAddress;
    const status =
      document.querySelector<HTMLElement>("#emby-login-status");
    if (status && !embyLogin) {
      status.textContent = "此账户及其加密登录令牌已从本机移除";
      status.classList.remove("error");
    }
  }

  async function loadEmbyLibraries(): Promise<void> {
    const select =
      document.querySelector<HTMLSelectElement>("#emby-library-select");
    if (!select || !window.roomDesktop || !embyLogin) return;
    const accountId = embyLogin.id;
    const requestId = ++embyLibraryRequestId;
    const views = await boundedUiOperation(
      window.roomDesktop.embyListViews({ accountId }),
      10_000,
      "读取 Emby 媒体库目录超时",
    );
    if (
      requestId !== embyLibraryRequestId ||
      accountId !== embyLogin?.id
    ) {
      return;
    }
    select.innerHTML = `<option value="">全部媒体</option>${views
      .map(
        (view) =>
          `<option value="${escapeHtml(view.id)}">${escapeHtml(view.name)}</option>`,
      )
      .join("")}`;
  }

  function embyItemLabel(item: EmbyLibraryItem): string {
    if (item.type === "Episode") {
      const episode =
        item.parentIndexNumber && item.indexNumber
          ? `S${item.parentIndexNumber}E${item.indexNumber}`
          : "";
      return [item.seriesName, episode, item.name].filter(Boolean).join(" · ");
    }
    return [item.name, item.productionYear].filter(Boolean).join(" · ");
  }

  function embyItemKey(item: EmbyLibraryItem): string {
    return `${item.accountId || embyActiveAccountId || "active"}:${item.id}`;
  }

  function formatEmbyCalendarDate(value?: string): string {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date);
  }

  function formatEmbyRuntime(ticks?: number): string {
    if (!ticks) return "";
    const minutes = Math.max(1, Math.round(ticks / 600_000_000));
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return hours
      ? `${hours} 小时${remainder ? ` ${remainder} 分钟` : ""}`
      : `${minutes} 分钟`;
  }

  function setEmbyPopupFact(
    dialog: HTMLElement,
    name: string,
    value: string,
  ): void {
    const row = dialog.querySelector<HTMLElement>(
      `[data-popup-fact="${name}"]`,
    );
    if (!row) return;
    row.hidden = !value;
    const detail = row.querySelector<HTMLElement>("dd");
    if (detail) detail.textContent = value;
  }

  async function showEmbyItemPopup(item: EmbyLibraryItem): Promise<void> {
    const dialog = embyItemPopup;
    if (!dialog) { void selectEmbyItem(item); return; }
    const sourceCard = document.querySelector<HTMLElement>(
      `[data-emby-item="${CSS.escape(embyItemKey(item))}"]`,
    );
    embyDetailOpener = sourceCard ?? undefined;
    embySelectedItem = item;
    const popupTitle = dialog.querySelector<HTMLElement>(".emby-popup-title");
    const popupYear = dialog.querySelector<HTMLElement>(".emby-popup-year");
    const popupOverview = dialog.querySelector<HTMLElement>(".emby-popup-overview");
    const popupPoster = dialog.querySelector<HTMLImageElement>(".emby-popup-poster-img");
    const popupKind = dialog.querySelector<HTMLElement>(".emby-popup-kind");
    const popupTagline = dialog.querySelector<HTMLElement>(".emby-popup-tagline");
    const popupPosterShell =
      dialog.querySelector<HTMLElement>(".emby-popup-poster");
    const popupPlaceholder =
      dialog.querySelector<HTMLElement>(".emby-popup-poster-placeholder");
    const selectionKey = embyItemKey(item);
    pendingEmbySelectionKey = selectionKey;
    if (popupTitle) popupTitle.textContent = item.name || "";
    if (popupYear) popupYear.textContent = item.productionYear ? String(item.productionYear) : "";
    const episode =
      item.type === "Episode" &&
      item.parentIndexNumber !== undefined &&
      item.indexNumber !== undefined
        ? ` · S${item.parentIndexNumber}E${item.indexNumber}`
        : "";
    const kind = item.type === "Episode" ? `剧集${episode}` : item.type === "Movie" ? "电影" : "视频";
    if (popupKind) popupKind.textContent = kind;
    if (popupOverview) popupOverview.textContent = item.overview || "暂无简介";
    if (popupTagline) {
      popupTagline.textContent = item.taglines?.[0] || "";
      popupTagline.hidden = !popupTagline.textContent;
    }
    setEmbyPopupFact(
      dialog,
      "premiere",
      formatEmbyCalendarDate(item.premiereDate) ||
        (item.productionYear ? `${item.productionYear} 年` : ""),
    );
    setEmbyPopupFact(dialog, "runtime", formatEmbyRuntime(item.runtimeTicks));
    setEmbyPopupFact(
      dialog,
      "rating",
      [
        item.officialRating,
        item.communityRating !== undefined
          ? `观众 ${item.communityRating.toFixed(1)} / 10`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
    setEmbyPopupFact(dialog, "genres", item.genres?.join(" · ") || "");
    setEmbyPopupFact(dialog, "studios", item.studios?.join(" · ") || "");
    setEmbyPopupFact(
      dialog,
      "server",
      [
        item.serverName,
        item.dateCreated
          ? `入库 ${formatEmbyCalendarDate(item.dateCreated)}`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
    if (popupPoster) {
      popupPoster.hidden = true;
      popupPoster.removeAttribute("src");
      popupPoster.alt = item.name ? `${item.name} 海报` : "影片海报";
      if (popupPlaceholder) popupPlaceholder.hidden = false;
      dialog.style.removeProperty("--emby-detail-accent");
      if (item.imageTag && window.roomDesktop) {
        void window.roomDesktop.embyImageData({
          itemId: item.imageItemId || item.id,
          tag: item.imageTag,
          accountId: item.accountId,
        }).then((url) => {
          if (
            popupPoster &&
            embySelectedItem &&
            embyItemKey(embySelectedItem) === selectionKey
          ) {
            popupPoster.addEventListener(
              "load",
              () => {
                if (
                  !embySelectedItem ||
                  embyItemKey(embySelectedItem) !== selectionKey
                ) {
                  return;
                }
                popupPoster.hidden = false;
                if (popupPlaceholder) popupPlaceholder.hidden = true;
                try {
                  const canvas = document.createElement("canvas");
                  canvas.width = 8;
                  canvas.height = 8;
                  const context = canvas.getContext("2d", {
                    willReadFrequently: true,
                  });
                  context?.drawImage(popupPoster, 0, 0, 8, 8);
                  const pixels = context?.getImageData(0, 0, 8, 8).data;
                  if (pixels) {
                    let red = 0;
                    let green = 0;
                    let blue = 0;
                    let count = 0;
                    for (let offset = 0; offset < pixels.length; offset += 8) {
                      red += pixels[offset];
                      green += pixels[offset + 1];
                      blue += pixels[offset + 2];
                      count += 1;
                    }
                    dialog.style.setProperty(
                      "--emby-detail-accent",
                      `rgba(${Math.round(red / count)}, ${Math.round(green / count)}, ${Math.round(blue / count)}, 0.18)`,
                    );
                  }
                } catch {
                  dialog.style.removeProperty("--emby-detail-accent");
                }
              },
              { once: true },
            );
            popupPoster.addEventListener(
              "error",
              () => {
                popupPoster.hidden = true;
                if (popupPlaceholder) popupPlaceholder.hidden = false;
              },
              { once: true },
            );
            popupPoster.src = url;
          }
        }).catch(() => undefined);
      }
    }
    if (dialog.hidden) {
      const sourcePoster =
        sourceCard?.querySelector<HTMLElement>(".emby-poster");
      const reduced =
        matchMedia("(prefers-reduced-motion: reduce)").matches ||
        document.documentElement.dataset.motion === "reduced";
      if (document.startViewTransition && sourcePoster && popupPosterShell && !reduced) {
        sourcePoster.style.setProperty(
          "view-transition-name",
          "emby-poster",
        );
        const transition = document.startViewTransition(() => {
          sourcePoster.style.removeProperty("view-transition-name");
          popupPosterShell.style.setProperty(
            "view-transition-name",
            "emby-poster",
          );
          void embyDetailPresence?.show(sessionUiAbortController.signal);
        });
        void transition.finished.finally(() => {
          popupPosterShell.style.removeProperty("view-transition-name");
        });
      } else {
        void embyDetailPresence?.show(sessionUiAbortController.signal);
      }
      queueMicrotask(() => {
        dialog
          .querySelector<HTMLButtonElement>("[data-close-emby-popup]")
          ?.focus();
      });
    }
    await selectEmbyItem(item);
  }

  let embyVirtualGrid: VirtualGrid<EmbyLibraryItem> | undefined;
  let embyVirtualShowServer = false;

  function createEmbyItemCard(item: EmbyLibraryItem): HTMLElement {
    const itemKey = embyItemKey(item);
    const progress = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          item.playedPercentage ??
            (item.playbackPositionTicks && item.runtimeTicks
              ? (item.playbackPositionTicks / item.runtimeTicks) * 100
              : 0),
        ),
      ),
    );
    const kind =
      item.type === "Episode"
        ? item.seasonName || "剧集"
        : item.type === "Movie"
          ? "电影"
          : "视频";
    const state = item.played
      ? "已看完"
      : progress > 0
        ? `继续观看 · ${progress}%`
        : kind;
    const episode =
      item.type === "Episode" &&
      item.parentIndexNumber !== undefined &&
      item.indexNumber !== undefined
        ? `S${item.parentIndexNumber}E${item.indexNumber}`
        : "";
    const context = [
      item.type === "Episode" ? item.seriesName : item.productionYear,
      episode,
      state,
    ]
      .filter(Boolean)
      .join(" · ");
    const template = document.createElement("template");
    template.innerHTML = `
      <button type="button" class="emby-item-card"
              data-emby-item="${escapeHtml(itemKey)}"
              aria-label="${escapeHtml(embyItemLabel(item))}">
        <span class="emby-poster">
          <span class="emby-poster-placeholder" aria-hidden="true">
            <i data-lucide="play"></i>
          </span>
          <img data-emby-image="${escapeHtml(itemKey)}"
               alt="${escapeHtml(item.name)} 海报" loading="lazy"
               decoding="async" hidden />
          <span class="emby-card-overlay" aria-hidden="true">
            <b><i data-lucide="play"></i></b><small>查看详情</small>
          </span>
          <span class="emby-kind-chip">${escapeHtml(kind)}</span>
          ${
            embyVirtualShowServer && item.serverName
              ? `<span class="emby-server-chip">${escapeHtml(item.serverName)}</span>`
              : ""
          }
          ${
            progress > 0 && progress < 100
              ? `<progress class="emby-progress" max="100" value="${progress}" aria-label="观看进度 ${progress}%"></progress>`
              : ""
          }
        </span>
        <strong>${escapeHtml(item.name)}</strong>
        <small class="emby-card-meta">${escapeHtml(context)}</small>
      </button>
    `;
    return template.content.firstElementChild as HTMLElement;
  }

  function mountEmbyItemCard(
    element: HTMLElement,
    item: EmbyLibraryItem,
  ): void {
    hydrateIcons(element);
    element.addEventListener("click", () => {
      void showEmbyItemPopup(item);
    });
    if (!item.imageTag || !window.roomDesktop) return;
    const image =
      element.querySelector<HTMLImageElement>("[data-emby-image]");
    const placeholder =
      element.querySelector<HTMLElement>(".emby-poster-placeholder");
    if (!image) return;
    void window.roomDesktop
      .embyImageData({
        itemId: item.imageItemId || item.id,
        tag: item.imageTag,
        accountId: item.accountId,
      })
      .then((dataUrl) => {
        if (
          !image.isConnected ||
          image.dataset.embyImage !== embyItemKey(item)
        ) {
          return;
        }
        image.addEventListener(
          "load",
          () => {
            image.hidden = false;
            if (placeholder) placeholder.hidden = true;
          },
          { once: true },
        );
        image.addEventListener(
          "error",
          () => {
            image.hidden = true;
            if (placeholder) placeholder.hidden = false;
          },
          { once: true },
        );
        image.src = dataUrl;
      })
      .catch(() => {
        if (placeholder) placeholder.hidden = false;
      });
  }

  async function renderEmbyItems(items: EmbyLibraryItem[]): Promise<void> {
    const grid = document.querySelector<HTMLElement>("#emby-item-grid");
    const scroller =
      document.querySelector<HTMLElement>("#emby-broadcast-panel");
    if (!grid || !scroller) return;
    const playable = items.filter((item) =>
      ["Movie", "Episode", "Video"].includes(item.type),
    );
    if (!playable.length) {
      embyVirtualGrid?.destroy();
      embyVirtualGrid = undefined;
      grid.innerHTML =
        `<div class="loading-state">没有找到可播放的电影或剧集</div>`;
      return;
    }
    embyVirtualShowServer =
      new Set(playable.map((item) => item.accountId).filter(Boolean)).size > 1;
    if (!embyVirtualGrid) {
      embyVirtualGrid = new VirtualGrid(grid, scroller, {
        key: embyItemKey,
        renderItem: createEmbyItemCard,
        onMount: mountEmbyItemCard,
        minColumnWidth: 148,
        gap: 20,
        aspectRatio: 2 / 3,
        extraHeight: 64,
        overscanRows: 2,
        virtualizationThreshold: 24,
      });
    }
    embyVirtualGrid.setItems(playable);
  }

  async function loadEmbyItems(reset = true): Promise<void> {
    if (!window.roomDesktop || !embyLogin) return;
    const accountId = embyLogin.id;
    const library =
      document.querySelector<HTMLSelectElement>("#emby-library-select");
    const search =
      document.querySelector<HTMLInputElement>("#emby-search-input");
    const status =
      document.querySelector<HTMLElement>("#emby-library-status");
    const grid = document.querySelector<HTMLElement>("#emby-item-grid");
    const filter =
      document.querySelector<HTMLSelectElement>("#emby-browse-filter");
    const loadMore =
      document.querySelector<HTMLButtonElement>("#emby-load-more");
    const requestId = ++embyBrowseRequestId;
    if (reset) {
      embyBrowseItems = [];
      embyBrowseTotal = 0;
    }
    if (status) {
      status.textContent = reset
        ? "正在读取 Emby 媒体库…"
        : "正在加载更多媒体…";
      status.classList.remove("error");
    }
    if (grid && reset) {
      embyVirtualGrid?.destroy();
      embyVirtualGrid = undefined;
      grid.innerHTML = Array.from(
        { length: 10 },
        () =>
          `<div class="emby-item-card emby-item-skeleton" aria-hidden="true"><span></span><i></i></div>`,
      ).join("");
    }
    if (loadMore) {
      loadMore.disabled = true;
      loadMore.textContent = "加载中…";
    }
    try {
      const mode = filter?.value || "all";
      const searchTerm = search?.value.trim() || undefined;
      const includeItemTypes =
        mode === "movies"
          ? ["Movie", "Video"]
          : mode === "episodes"
            ? ["Episode"]
            : ["Movie", "Episode", "Video"];
      const filters =
        mode === "resume"
          ? (["IsResumable"] as const)
          : mode === "favorite"
            ? (["IsFavorite"] as const)
            : undefined;
      const recent = mode === "latest" || mode === "resume";
      const crossServer = Boolean(searchTerm && embyAccounts.length > 1);
      const commonQuery = {
        searchTerm: searchTerm!,
        includeItemTypes,
        limit: crossServer ? 180 : 60,
        filters: filters ? [...filters] : undefined,
        sortBy: recent ? "DatePlayed,DateCreated" : "SortName,ProductionYear",
        sortOrder: recent ? ("Descending" as const) : ("Ascending" as const),
      };
      const result = await boundedUiOperation(
        crossServer
          ? window.roomDesktop.embySearchAll(commonQuery)
          : window.roomDesktop.embyListItems({
              ...commonQuery,
              accountId,
              parentId: library?.value || undefined,
              searchTerm,
              recursive: true,
              limit: 60,
              startIndex: reset ? 0 : embyBrowseItems.length,
            }),
        10_000,
        crossServer
          ? "联合搜索 Emby 服务器超时；可立即修改关键词后重试"
          : "读取 Emby 媒体库超时；账户仍保持连接，可立即重试",
      );
      if (
        requestId !== embyBrowseRequestId ||
        (!crossServer && accountId !== embyLogin?.id)
      ) {
        return;
      }
      const known = new Set(embyBrowseItems.map(embyItemKey));
      embyBrowseItems = reset
        ? result.items
        : [
            ...embyBrowseItems,
            ...result.items.filter((item) => !known.has(embyItemKey(item))),
          ];
      embyBrowseTotal = result.total;
      const jointSummary =
        "serverCount" in result && "failedServers" in result
          ? {
              serverCount: Number(result.serverCount) || 0,
              failedServers: Array.isArray(result.failedServers)
                ? result.failedServers.filter(
                    (server): server is string => typeof server === "string",
                  )
                : [],
            }
          : undefined;
      if (status) {
        status.textContent =
          jointSummary
            ? `已联合搜索 ${jointSummary.serverCount} 台服务器，显示 ${embyBrowseItems.length} 个结果${
                jointSummary.failedServers.length
                  ? `；${jointSummary.failedServers.join("、")} 暂时不可用`
                  : ""
              }`
            : `已读取 ${embyBrowseItems.length} / ${embyBrowseTotal} 个可播放项目`;
      }
      await renderEmbyItems(embyBrowseItems);
      if (loadMore) {
        loadMore.hidden =
          Boolean(jointSummary) ||
          !result.items.length || embyBrowseItems.length >= embyBrowseTotal;
      }
    } catch (error) {
      if (requestId !== embyBrowseRequestId) return;
      if (status) {
        status.textContent =
          error instanceof Error ? error.message : "读取媒体库失败";
        status.classList.add("error");
      }
      if (grid && reset) grid.innerHTML = "";
      if (loadMore) loadMore.hidden = true;
    } finally {
      if (requestId === embyBrowseRequestId && loadMore?.isConnected) {
        loadMore.disabled = false;
        loadMore.textContent = "加载更多";
      }
    }
  }

  function selectedEmbyMediaSource():
    | EmbyPlaybackInfo["mediaSources"][number]
    | undefined {
    const sourceSelect =
      document.querySelector<HTMLSelectElement>("#emby-media-source");
    return (
      embyPlaybackInfo?.mediaSources.find(
        (source) => source.id === sourceSelect?.value,
      ) || embyPlaybackInfo?.mediaSources[0]
    );
  }

  function updateEmbySourceUi(): void {
    const source = selectedEmbyMediaSource();
    if (!source) return;
    const audioSelect =
      document.querySelector<HTMLSelectElement>("#emby-audio-track");
    const subtitleSelect =
      document.querySelector<HTMLSelectElement>("#emby-subtitle-track");
    const method =
      document.querySelector<HTMLElement>("#emby-stream-method");
    const audio = source.streams.filter(
      (stream) => stream.type === "Audio",
    );
    const subtitles = source.streams.filter(
      (stream) => stream.type === "Subtitle",
    );
    const preferredSubtitle =
      subtitles.find((stream) => stream.isForced) ||
      subtitles.find((stream) => stream.isDefault && stream.isText) ||
      subtitles.find((stream) =>
        stream.isText &&
        (["chi", "zh", "zho", "chs", "cht"].includes(stream.language?.toLowerCase() ?? "") ||
          /chinese|中文/i.test(stream.title ?? "")),
      );
    if (audioSelect) {
      audioSelect.innerHTML = audio
        .map(
          (stream) =>
            `<option value="${stream.index}" ${stream.isDefault ? "selected" : ""}>${escapeHtml(
              [
                stream.title,
                stream.language,
                stream.codec.toUpperCase(),
                stream.channels ? `${stream.channels} 声道` : "",
              ]
                .filter(Boolean)
                .join(" · "),
            )}</option>`,
        )
        .join("");
    }
    if (subtitleSelect) {
      subtitleSelect.innerHTML = `<option value="" ${!preferredSubtitle ? "selected" : ""}>无字幕</option>${subtitles
        .map((stream) => {
          const text =
            stream.isText === true ||
            [
              "srt",
              "subrip",
              "vtt",
              "webvtt",
              "ass",
              "ssa",
              "ttml",
              "dfxp",
              "mov_text",
            ].includes(stream.codec);
          return `<option value="${stream.index}" ${preferredSubtitle?.index === stream.index ? "selected" : ""}>${escapeHtml(
            [
              stream.title,
              stream.language,
              stream.codec.toUpperCase(),
              text ? "独立字幕" : "服务器烧录 · 会转码",
            ]
              .filter(Boolean)
              .join(" · "),
          )}</option>`;
        })
        .join("")}`;
    }
    const video = source.streams.find(
      (stream) => stream.type === "Video",
    );
    if (method) {
      method.classList.remove("error");
      const safeOriginal = embySourceCanUseOriginal(source, false);
      method.textContent = [
        `${source.container.toUpperCase()} · ${video?.codec.toUpperCase() || "未知视频编码"}`,
        safeOriginal
          ? source.supportsDirectPlay
            ? "可安全 Direct Play"
            : "可安全 Direct Stream"
          : "自动模式将转为兼容 H.264 / AAC",
        source.bitrate ? `原始 ${formatBitrate(source.bitrate)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    updateEmbyBudget();
  }

  const embyQualityBitrates: Record<
    Exclude<EmbyPlaybackRequest["quality"], "original">,
    number
  > = {
    "4k-18": 18_000_000,
    "4k-12": 12_000_000,
    "1440p-18": 18_000_000,
    "1080p-12": 12_000_000,
    "1080p-8": 8_000_000,
    "720p-6": 6_000_000,
    "720p-4": 4_000_000,
    "480p-2.5": 2_500_000,
    "360p-1.2": 1_200_000,
  };
  const embyQualityLabels: Record<EmbyPlaybackRequest["quality"], string> = {
    original: "原始码率",
    "4k-18": "4K · 18 Mbps",
    "4k-12": "4K · 12 Mbps",
    "1440p-18": "2K · 18 Mbps",
    "1080p-12": "1080P · 12 Mbps",
    "1080p-8": "1080P · 8 Mbps",
    "720p-6": "720P · 6 Mbps",
    "720p-4": "720P · 4 Mbps",
    "480p-2.5": "480P · 2.5 Mbps",
    "360p-1.2": "360P · 1.2 Mbps",
  };
  function embyQualityAtOrBelow(
    requested: EmbyPlaybackRequest["quality"],
    ceiling: EmbyPlaybackRequest["quality"] | undefined,
  ): EmbyPlaybackRequest["quality"] {
    if (!ceiling) return requested;
    return embyQualityBitrate(requested) <= embyQualityBitrate(ceiling)
      ? requested
      : ceiling;
  }

  function activeEmbyPressureCeiling():
    | EmbyPlaybackRequest["quality"]
    | undefined {
    const activePressures: Array<{
      viewerId: string;
      quality: EmbyPlaybackRequest["quality"];
    }> = [];
    const now = Date.now();
    for (const [viewerId, pressure] of embyPressureQualityByViewer) {
      if (pressure.expiresAt <= now) {
        embyPressureQualityByViewer.delete(viewerId);
        continue;
      }
      if (viewerId !== SFU_EMBY_VIEWER_ID && !participants.has(viewerId)) {
        embyPressureQualityByViewer.delete(viewerId);
        continue;
      }
      activePressures.push({ viewerId, quality: pressure.quality });
    }
    if (!activePressures.length) return undefined;
    const sharedSfuPressure = activePressures.some(
      ({ viewerId }) => viewerId === SFU_EMBY_VIEWER_ID,
    );
    const viewerCount = embyViewerCount();
    const requiredAffectedViewers =
      viewerCount <= 1 ? 1 : Math.floor(viewerCount / 2) + 1;
    if (
      !sharedSfuPressure &&
      activePressures.length < requiredAffectedViewers
    ) {
      // One weak viewer must not downgrade or rebuild the shared stream for
      // every healthy viewer. A strict majority (or pressure on the single
      // shared publisher-to-SFU path) is required for a room-wide change.
      return undefined;
    }
    return activePressures.reduce<EmbyPlaybackRequest["quality"] | undefined>(
      (result, { quality }) =>
        !result ||
        embyQualityBitrate(quality) < embyQualityBitrate(result)
          ? quality
          : result,
      undefined,
    );
  }

  function scheduleEmbyPressureRecovery(): void {
    if (embyPressureRecoveryTimer !== undefined) {
      window.clearTimeout(embyPressureRecoveryTimer);
      embyPressureRecoveryTimer = undefined;
    }
    const expiresAt = Math.min(
      ...[...embyPressureQualityByViewer.values()].map(
        (pressure) => pressure.expiresAt,
      ),
    );
    if (!Number.isFinite(expiresAt)) return;
    embyPressureRecoveryTimer = window.setTimeout(() => {
      embyPressureRecoveryTimer = undefined;
      const before = embyPressureQualityByViewer.size;
      activeEmbyPressureCeiling();
      if (embyPressureQualityByViewer.size < before) {
        scheduleEmbyQualityRebalance(
          "弱网链路已持续稳定，正在谨慎恢复共享画质",
        );
      }
      scheduleEmbyPressureRecovery();
    }, Math.max(250, expiresAt - Date.now() + 100));
  }

  function pressureSafeEmbyQuality(
    requested: EmbyPlaybackRequest["quality"],
  ): EmbyPlaybackRequest["quality"] {
    return embyQualityAtOrBelow(requested, activeEmbyPressureCeiling());
  }

  function sharedEmbyViewerPreference(): {
    height?: number;
    frameRate?: EmbyFrameRate;
  } {
    const activeViewerIds = [...participants.keys()].filter(
      (id) => id !== selfId,
    );
    const heights = activeViewerIds
      .map((id) => {
        const height = Number(receiverPreferences.get(id)?.height);
        return Number.isFinite(height) && height > 0
          ? height
          : Number.POSITIVE_INFINITY;
      })
      .sort((left, right) => left - right);
    const frameRates = activeViewerIds
      .map((id) => {
        const value = Number(receiverPreferences.get(id)?.frameRate);
        return value === 24 || value === 30 || value === 60
          ? value
          : Number.POSITIVE_INFINITY;
      })
      .sort((left, right) => left - right);
    const majorityHeight = heights[Math.floor(heights.length / 2)];
    const majorityFrameRate =
      frameRates[Math.floor(frameRates.length / 2)];
    return {
      ...(Number.isFinite(majorityHeight)
        ? { height: majorityHeight }
        : {}),
      ...(majorityFrameRate === 24 ||
      majorityFrameRate === 30 ||
      majorityFrameRate === 60
        ? {
            frameRate: majorityFrameRate as EmbyFrameRate,
          }
        : {}),
    };
  }

  function embyViewerCount(): number {
    return Math.max(
      1,
      [...participants.keys()].filter((id) => id !== selfId).length,
    );
  }

  function independentEmbyCmafRelayAvailable(): boolean {
    return (
      signalFeatures.has("emby-segment-relay-v1") &&
      segmentRelayAccess?.scope === "publish"
    );
  }

  function embyUplinkCount(viewers = embyViewerCount()): number {
    if (independentEmbyCmafRelayAvailable()) return 1;
    if (!sfuSession.publishing) return Math.max(1, viewers);
    const p2pFallbacks = [...outboundPeers.values()].filter(
      (peer) =>
        peer.mode === "emby" &&
        peer.pc.connectionState !== "closed",
    ).length;
    return Math.max(1, 1 + p2pFallbacks);
  }

  function embyBudget(viewers = embyViewerCount()): {
    overhead: number;
    mediaPerViewer: number;
    uplinkCount: number;
    measuredSafeUplinkBps?: number;
  } {
    const overhead = 2_000_000 + viewers * 350_000;
    const uplinkCount = embyUplinkCount(viewers);
    const freshNetworkReport =
      networkReport &&
      Date.now() - networkReport.measuredAt <= 5 * 60_000
        ? networkReport
        : undefined;
    const measuredSafeUplinkBps = freshNetworkReport
      ? freshNetworkReport.uploadKbps * 1_000 * 0.72
      : undefined;
    const measuredHostMediaPerViewer = freshNetworkReport
      ? (measuredSafeUplinkBps! - overhead) / uplinkCount
      : 10_000_000;
    const roomMediaPerViewer =
      networkAdvice.revision > 0
        ? networkAdvice.perViewerBudgetBps
        : 10_000_000;
    return {
      overhead,
      uplinkCount,
      measuredSafeUplinkBps,
      mediaPerViewer: Math.max(
        1_200_000,
        Math.min(
          measuredHostMediaPerViewer,
          roomMediaPerViewer,
        ),
      ),
    };
  }

  function embyQualityBitrate(
    quality: EmbyPlaybackRequest["quality"],
    source = selectedEmbyMediaSource(),
  ): number {
    return quality === "original"
      ? source?.bitrate || 100_000_000
      : embyQualityBitrates[quality];
  }

  function embySourceCanUseOriginal(
    source = selectedEmbyMediaSource(),
    allowHevc = false,
  ): boolean {
    if (!source || (!source.supportsDirectPlay && !source.supportsDirectStream)) {
      return false;
    }
    const video = source.streams.find((stream) => stream.type === "Video");
    if (!video) return false;
    const codec = String(video.codec || "").toLowerCase();
    const profile = String(video.profile || "").toLowerCase();
    const bitDepth = Number(video.bitDepth || 8);
    const browserSafeVideo =
      (["h264", "avc", "avc1"].includes(codec) &&
        bitDepth <= 8 &&
        !profile.includes("10")) ||
      (["hevc", "h265", "hev1", "hvc1"].includes(codec) &&
        allowHevc &&
        bitDepth <= 10);
    if (!browserSafeVideo) return false;
    const subtitleSelect =
      document.querySelector<HTMLSelectElement>("#emby-subtitle-track");
    const subtitleIndex =
      subtitleSelect?.value !== "" ? Number(subtitleSelect?.value) : undefined;
    const subtitle = source.streams.find(
      (stream) =>
        stream.type === "Subtitle" && stream.index === subtitleIndex,
    );
    if (!subtitle) return true;
    const subtitleCodec = String(subtitle.codec || "").toLowerCase();
    return (
      subtitle.isText === true ||
      [
        "srt",
        "subrip",
        "vtt",
        "webvtt",
        "ass",
        "ssa",
        "ttml",
        "dfxp",
        "mov_text",
      ].includes(subtitleCodec)
    );
  }

  function automaticEmbyQuality(
    allowHevc = false,
  ): EmbyPlaybackRequest["quality"] {
    const source = selectedEmbyMediaSource();
    if (!source) return "1080p-8";
    const video = source.streams.find((stream) => stream.type === "Video");
    const height = video?.height || 1080;
    const sourceBitrate = Math.max(0, Number(source.bitrate) || 0);
    if (independentEmbyCmafRelayAvailable()) {
      // The host preview and emergency cache are no longer multiplied by the
      // number of viewers. Keep Auto on a broadly decodable preview profile;
      // independent rendition actors and each viewer's measured HTTPS ABR
      // decide whether original is warranted.
      if (
        sourceBitrate > 0 &&
        sourceBitrate <= 8_000_000 &&
        embySourceCanUseOriginal(source, allowHevc)
      ) {
        return "original";
      }
      if (height > 720) return "1080p-8";
      if (height > 480) return "720p-4";
      return "480p-2.5";
    }
    const available = embyBudget().mediaPerViewer;
    if (
      source.bitrate &&
      source.bitrate <= available * 0.9 &&
      embySourceCanUseOriginal(source, allowHevc)
    ) {
      return "original";
    }
    // Complex HEVC/HDR/10-bit sources must not make "auto" request an
    // unbounded 4K HEVC -> H.264 transcode. A user may still explicitly choose
    // 4K, while automatic playback starts with a bounded decoder-safe profile.
    if (height >= 1_440 && available >= 18_000_000) return "1440p-18";
    if (height > 720 && available >= 12_000_000) return "1080p-12";
    if (height > 720 && available >= 8_000_000) return "1080p-8";
    if (height > 480 && available >= 6_000_000) return "720p-6";
    if (height > 480 && available >= 4_000_000) return "720p-4";
    if (height > 360 && available >= 2_500_000) return "480p-2.5";
    return "360p-1.2";
  }

  function budgetSafeQuality(
    requested: EmbyPlaybackRequest["quality"] | "auto",
    allowHevc = false,
  ): EmbyPlaybackRequest["quality"] {
    if (requested === "auto") return automaticEmbyQuality(allowHevc);
    const source = selectedEmbyMediaSource();
    if (!source) return requested;
    // "Original" is only a zero-cost choice when the selected source is
    // actually safe for every active decoder.  Keeping the original label for
    // an incompatible 4K HEVC/Dolby Vision source made Emby attempt a
    // 4K-to-4K H.264 conversion before the bounded compatibility retry.  On
    // modest Emby hosts that can spend the entire startup window without
    // producing an init segment.  Resolve it to the same high-quality,
    // bandwidth-aware compatibility rung used by Auto before opening the
    // stateful playback session.
    if (
      requested === "original" &&
      !embySourceCanUseOriginal(source, allowHevc)
    ) {
      const height =
        source.streams.find((stream) => stream.type === "Video")?.height ||
        1080;
      return height >= 2_160
        ? "4k-18"
        : height >= 1_440
          ? "1440p-18"
        : height > 720
          ? "1080p-12"
          : height > 480
            ? "720p-6"
            : "480p-2.5";
    }
    // Network measurements are recommendations for Auto. A user-selected
    // profile is authoritative; silently replacing 1080P/4K with 480P made
    // both the launch selector and live settings appear broken.
    return requested;
  }

  function updateEmbyBudget(): void {
    const quality =
      document.querySelector<HTMLSelectElement>("#emby-quality");
    const budget =
      document.querySelector<HTMLElement>("#emby-bandwidth-budget");
    const source = selectedEmbyMediaSource();
    if (!quality || !budget || !source) return;
    const requested = quality.value as EmbyPlaybackRequest["quality"] | "auto";
    const resolved = budgetSafeQuality(requested);
    const perViewer = embyQualityBitrate(resolved, source);
    if (independentEmbyCmafRelayAvailable()) {
      const freshNetworkReport =
        networkReport &&
        Date.now() - networkReport.measuredAt <= 5 * 60_000
          ? networkReport
          : undefined;
      const uploadBudget = freshNetworkReport
        ? Math.max(
            1,
            freshNetworkReport.uploadKbps * 1_000 -
              (2_000_000 +
                Math.max(0, participants.size - 1) * 350_000),
          ) * 0.65
        : undefined;
      budget.textContent =
        `HTTPS CMAF 独立 ABR · 主播预览 ${embyQualityLabels[resolved]}；` +
        "默认生产 1080p8 / 720p4，原画与弱网档按观看需求启停；" +
        `辅助分片共享上行${
          uploadBudget
            ? `最多 ${formatBitrate(uploadBudget)}（测速上行 65%）`
            : "按测速结果限制到上行 65%"
        }`;
      budget.classList.remove("warning");
      return;
    }
    const viewerCount = embyViewerCount();
    const {
      overhead,
      uplinkCount,
      measuredSafeUplinkBps,
    } = embyBudget(viewerCount);
    const total = perViewer * uplinkCount + overhead;
    const compatibilityDowngrade =
      requested === "original" &&
      resolved !== requested &&
      !embySourceCanUseOriginal(source, false);
    const automatic =
      requested === "auto"
        ? `自动选择 ${embyQualityLabels[resolved]} · `
        : compatibilityDowngrade
          ? `原始媒体需兼容转换，预选 ${embyQualityLabels[resolved]} · `
        : resolved !== requested
          ? `预算建议降至 ${embyQualityLabels[resolved]} · `
          : "";
    budget.textContent =
      `${automatic}${viewerCount} 位观众 · ${
        sfuSession.publishing
          ? `SFU 主线路 1 路${uplinkCount > 1 ? ` + P2P 备用 ${uplinkCount - 1} 路` : ""}`
          : `P2P 备用 ${uplinkCount} 路`
      }：共享媒体 ${formatBitrate(perViewer)}，连麦/信令/协议预留 ${formatBitrate(overhead)}，主播总上行约 ${formatBitrate(total)}；服务器不设置带宽上限`;
    budget.classList.toggle(
      "warning",
      measuredSafeUplinkBps !== undefined &&
        total > measuredSafeUplinkBps,
    );
  }

  function lowerEmbyQuality(
    current: EmbyPlaybackRequest["quality"],
  ): EmbyPlaybackRequest["quality"] {
    const height =
      selectedEmbyMediaSource()?.streams.find(
        (stream) => stream.type === "Video",
      )?.height || 1080;
    const ladder: EmbyPlaybackRequest["quality"][] =
      height > 1080
        ? [
            "original",
            "4k-18",
            "4k-12",
            "1440p-18",
            "1080p-12",
            "1080p-8",
            "720p-6",
            "720p-4",
            "480p-2.5",
            "360p-1.2",
          ]
        : height > 720
          ? [
              "original",
              "1080p-12",
              "1080p-8",
              "720p-6",
              "720p-4",
              "480p-2.5",
              "360p-1.2",
            ]
          : height > 480
            ? [
                "original",
                "720p-6",
                "720p-4",
                "480p-2.5",
                "360p-1.2",
              ]
            : ["original", "480p-2.5", "360p-1.2"];
    const index = ladder.indexOf(current);
    return ladder[Math.min(ladder.length - 1, Math.max(0, index) + 1)];
  }

  function scheduleEmbyQualityRebalance(
    reason: string,
    forcedQuality?: EmbyPlaybackRequest["quality"],
  ): void {
    // Viewer count and per-viewer preferences only affect independent CMAF
    // rendition demand. Rebuilding the shared host preview here would change
    // mediaVersion and discard every viewer's otherwise healthy cache.
    if (embyBroadcast?.segmentRelayActive) return;
    if (
      localBroadcastMode !== "emby" ||
      broadcasterId !== selfId ||
      !embyBroadcast?.active
    ) {
      return;
    }
    if (embyRebalanceTimer !== undefined) {
      window.clearTimeout(embyRebalanceTimer);
    }
    embyRebalanceTimer = window.setTimeout(() => {
      embyRebalanceTimer = undefined;
      const controller = embyBroadcast;
      const qualitySelect =
        document.querySelector<HTMLSelectElement>("#emby-quality");
      if (
        !controller?.active ||
        localBroadcastMode !== "emby" ||
        broadcasterId !== selfId
      ) {
        return;
      }
      const requested = (qualitySelect?.value ||
        "auto") as EmbyPlaybackRequest["quality"] | "auto";
      const target = pressureSafeEmbyQuality(
        forcedQuality || budgetSafeQuality(requested),
      );
      if (controller.playbackQuality === target) return;
      void controller
        .setQuality(target, reason)
        .then((changed) => {
          if (!changed) return;
          updateEmbyBudget();
          notify(
            `${reason}，Emby 已重新分配为 ${embyQualityLabels[target]}；播放位置和暂停状态保持不变`,
          );
        })
        .catch((error) =>
          notify(readableError(error, "Emby 动态画质调整失败"), true),
        );
    }, forcedQuality ? 120 : 650);
  }

  function updateEmbySegmentRenditionDemand(): void {
    const controller = embyBroadcast;
    if (
      !controller?.segmentRelayActive ||
      localBroadcastMode !== "emby" ||
      broadcasterId !== selfId
    ) {
      return;
    }
    let original = false;
    let high = false;
    let low = false;
    const originalBitrate =
      Math.max(0, Number(selectedEmbyMediaSource()?.bitrate) || 0);
    for (const [viewerId, preference] of receiverPreferences) {
      const participant = participants.get(viewerId);
      if (!participant || viewerId === selfId) continue;
      if (preference.lowDemand === true) {
        low = true;
      }
      if (preference.highDemand === true) {
        high = true;
      }
      if (
        preference.originalDemand === true &&
        preference.renditionPolicy?.serverVerified === true &&
        preference.renditionPolicy?.allowOriginal !== false &&
        participant.embyCapabilities?.desktop === true &&
        (originalBitrate <= 0 ||
          Number(preference.availableDownloadBps) >=
            originalBitrate * 1.5)
      ) {
        original = true;
      }
    }
    const verifiedPublisherBudgetBps =
      measuredAvailableOutgoingBitrate ??
      networkAdvice.publisherAdvice?.budgetBps;
    const canPublishHigh =
      Number(verifiedPublisherBudgetBps) >= 12_000_000;
    const canPublishOriginal =
      originalBitrate > 0 &&
      Number(verifiedPublisherBudgetBps) >= originalBitrate * 1.35;
    const maximumActiveRenditions = Math.max(
      1,
      Math.min(
        3,
        resourceBudget.maxConcurrentProducers,
        Number(broadcastCapabilities?.maxActiveRenditions) || 3,
      ),
    );
    let remainingAuxiliarySlots = Math.max(
      0,
      maximumActiveRenditions - 2,
    );
    const selectedLow = low && remainingAuxiliarySlots-- > 0;
    const selectedHigh =
      high && canPublishHigh && remainingAuxiliarySlots-- > 0;
    const selectedOriginal =
      original &&
      canPublishOriginal &&
      broadcastCapabilities?.allowOriginalRendition !== false &&
      remainingAuxiliarySlots-- > 0;
    controller.setSegmentRenditionDemand({
      original: selectedOriginal,
      high: selectedHigh,
      low: selectedLow,
      ...(Number.isFinite(verifiedPublisherBudgetBps)
        ? {
            availableUploadBps:
              Math.max(
                0,
                Math.max(0, Number(verifiedPublisherBudgetBps)) -
                  (2_000_000 +
                    Math.max(0, participants.size - 1) * 350_000),
              ),
          }
        : {}),
    });
  }

  function scheduleEmbyViewerPreference(
    viewerId: string,
    preference: {
      height?: number;
      frameRate?: number;
      originalDemand?: boolean;
      highDemand?: boolean;
      lowDemand?: boolean;
      availableDownloadBps?: number;
      renditionPolicy?: {
        maxActiveRenditions?: number;
        allowOriginal?: boolean;
        serverVerified?: boolean;
      };
    },
  ): void {
    receiverPreferences.set(viewerId, preference);
    if (embyBroadcast?.segmentRelayActive) {
      updateEmbySegmentRenditionDemand();
      return;
    }
    if (embyViewerPreferenceTimer !== undefined) {
      window.clearTimeout(embyViewerPreferenceTimer);
    }
    // Resolution and frame-rate selects are often changed back-to-back on a
    // phone. Rebuild the shared FFmpeg/MSE pipeline once after that gesture,
    // rather than interrupting playback twice.
    embyViewerPreferenceTimer = window.setTimeout(() => {
      embyViewerPreferenceTimer = undefined;
      const controller = embyBroadcast;
      if (
        !controller?.active ||
        localBroadcastMode !== "emby" ||
        broadcasterId !== selfId
      ) {
        return;
      }
      const launchQuality =
        document.querySelector<HTMLSelectElement>("#emby-quality");
      const hostRequested = (launchQuality?.value ||
        "auto") as EmbyPlaybackRequest["quality"] | "auto";
      const hostQuality = budgetSafeQuality(
        hostRequested,
        controller.currentRequest?.allowHevc === true,
      );
      const sharedPreference = sharedEmbyViewerPreference();
      const viewerQuality = embyQualityForRequestedHeight(
        sharedPreference.height,
      );
      const quality = pressureSafeEmbyQuality(
        viewerQuality
          ? embyQualityAtOrBelow(viewerQuality, hostQuality)
          : hostQuality,
      );
      const sharedFrameRate = Math.min(
        embyFrameRate,
        sharedPreference.frameRate || embyFrameRate,
      ) as EmbyFrameRate;
      updateEmbyBudget();
      void controller
        .setPlaybackProfile(
          {
            quality,
            frameRate: sharedFrameRate,
          },
          "观看端请求切换全房间共享画质",
        )
        .then((changed) => {
          if (!changed) return;
          notify(
            `观看端已请求共享流切换为 ${embyQualityLabels[quality]}${
              ` · ${sharedFrameRate} 帧`
            }；所有观众将同步使用新流`,
          );
        })
        .catch((error) =>
          notify(readableError(error, "切换 Emby 共享画质失败"), true),
        );
    }, 450);
  }

  function handleEmbyNetworkPressure(detail: {
    viewerId: string;
    queuedBytes: number;
    bufferedBytes: number;
  }): void {
    const controller = embyBroadcast;
    if (
      !controller?.active ||
      Date.now() < embyPressureQualityCooldownUntil
    ) {
      return;
    }
    const current = controller.playbackQuality;
    if (!current) return;
    const currentBitrate = embyQualityBitrate(current);
    let lower = lowerEmbyQuality(current);
    while (
      lower !== lowerEmbyQuality(lower) &&
      (embyQualityBitrate(lower) >= currentBitrate ||
        embyQualityBitrate(lower) > 4_000_000)
    ) {
      lower = lowerEmbyQuality(lower);
    }
    if (
      lower === current ||
      embyQualityBitrate(lower) >= currentBitrate
    ) {
      return;
    }
    embyPressureQualityCooldownUntil = Date.now() + 30_000;
    const previous = embyPressureQualityByViewer.get(detail.viewerId);
    embyPressureQualityByViewer.set(
      detail.viewerId,
      {
        quality: previous
          ? embyQualityAtOrBelow(lower, previous.quality)
          : lower,
        expiresAt: Date.now() + 120_000,
      },
    );
    scheduleEmbyPressureRecovery();
    reportPlaybackDiagnostic("emby-network-pressure", {
      viewerId: detail.viewerId,
      from: current,
      to: lower,
      queuedBytes: detail.queuedBytes,
      bufferedBytes: detail.bufferedBytes,
      activePressureViewers: embyPressureQualityByViewer.size,
    });
    scheduleEmbyQualityRebalance(
      "检测到观看端持续积压，已优先恢复同步",
      lower,
    );
  }

  function formatEmbyPosition(ticks: number): string {
    const seconds = Math.max(0, Math.floor(ticks / 10_000_000));
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    const remainder = seconds % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
      : `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function updateEmbyResumeOption(item: EmbyLibraryItem): void {
    const option =
      document.querySelector<HTMLElement>("#emby-resume-option");
    const input =
      document.querySelector<HTMLInputElement>("#emby-resume-playback");
    const label =
      document.querySelector<HTMLElement>("#emby-resume-label");
    const position = Math.max(0, item.playbackPositionTicks || 0);
    const resumable =
      position >= 30 * 10_000_000 &&
      (!item.runtimeTicks || position < item.runtimeTicks - 60 * 10_000_000);
    if (option) option.hidden = !resumable;
    if (input) input.checked = resumable;
    if (label) {
      label.textContent = resumable
        ? `从 ${formatEmbyPosition(position)} 继续播放`
        : "从头播放";
    }
  }

  async function selectEmbyItem(item: EmbyLibraryItem): Promise<void> {
    if (!window.roomDesktop) return;
    const selectionKey = embyItemKey(item);
    const requestId = ++embySelectionRequestId;
    pendingEmbySelectionKey = selectionKey;
    embySelectedItem = item;
    embyPlaybackInfo = undefined;
    document
      .querySelectorAll<HTMLButtonElement>("[data-emby-item]")
      .forEach((button) => {
        const selected = button.dataset.embyItem === embyItemKey(item);
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      });
    const method =
      document.querySelector<HTMLElement>("#emby-stream-method");
    if (method) {
      method.textContent = "正在读取媒体版本、音轨与字幕…";
      method.classList.remove("error");
    }
    updateEmbyResumeOption(item);
    try {
      const quality =
        document.querySelector<HTMLSelectElement>("#emby-quality");
      const previewQuality =
        quality?.value === "auto"
          ? "1080p-8"
          : (quality?.value || "1080p-12");
      const playbackInfo = await boundedUiOperation(
        window.roomDesktop.embyPlaybackInfo({
          accountId: item.accountId || embyActiveAccountId,
          itemId: item.id,
          quality: previewQuality as EmbyPlaybackRequest["quality"],
          allowHevc: false,
        }),
        12_000,
        "读取 Emby 媒体版本与音轨超时",
      );
      if (
        requestId !== embySelectionRequestId ||
        pendingEmbySelectionKey !== selectionKey
      ) {
        return;
      }
      embyPlaybackInfo = playbackInfo;
      const sourceSelect =
        document.querySelector<HTMLSelectElement>("#emby-media-source");
      if (!embyPlaybackInfo.mediaSources.length) {
        throw new Error("Emby 没有返回媒体源");
      }
      if (sourceSelect) {
        sourceSelect.innerHTML = embyPlaybackInfo.mediaSources
          .map(
            (source) =>
              `<option value="${escapeHtml(source.id)}">${escapeHtml(
                [
                  source.name,
                  source.container.toUpperCase(),
                  source.bitrate
                    ? formatBitrate(source.bitrate)
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · "),
              )}</option>`,
          )
          .join("");
      }
      updateEmbySourceUi();
    } catch (error) {
      if (
        requestId !== embySelectionRequestId ||
        pendingEmbySelectionKey !== selectionKey
      ) {
        return;
      }
      embyPlaybackInfo = undefined;
      if (method) {
        method.textContent =
          error instanceof Error ? error.message : "PlaybackInfo 请求失败";
        method.classList.add("error");
      }
    }
  }

  function embyCapabilityIssue(
    capabilities: RoomParticipant["embyCapabilities"],
    codec: "h264" | "hevc",
  ): string | undefined {
    if (!capabilities) return "客户端版本过旧，未上报媒体解码能力";
    if (!capabilities.mse) return "系统没有可用的 Media Source 播放器";
    if (!capabilities.aac) return "系统不能解码 AAC 音频";
    if (!capabilities[codec]) {
      return codec === "hevc"
        ? "系统不能解码 HEVC，请让放映端改用 H.264"
        : "系统不能解码 H.264";
    }
    return undefined;
  }

  function updateEmbyHevcSupport(): void {
    const input =
      document.querySelector<HTMLInputElement>("#emby-allow-hevc");
    const summary =
      document.querySelector<HTMLElement>("#emby-hevc-support");
    if (!input || !summary) return;
    const local = detectEmbyMediaCapabilities();
    const viewers = [...participants.values()].filter(
      (participant) => participant.id !== selfId,
    );
    const incompatible = viewers.filter((participant) =>
      embyCapabilityIssue(participant.embyCapabilities, "hevc"),
    );
    const available = local.hevc && incompatible.length === 0;
    input.disabled = !available;
    if (!available) input.checked = false;
    summary.classList.toggle("supported", available);
    summary.classList.toggle("unsupported", !available);
    if (!local.hevc) {
      summary.textContent =
        "此电脑的媒体栈未确认支持 HEVC fMP4，将使用 H.264";
    } else if (incompatible.length) {
      summary.textContent = `当前不可用：${incompatible
        .map((participant) => participant.nickname)
        .join("、")}未确认支持 HEVC`;
    } else if (viewers.length) {
      summary.textContent = `已确认：本机和当前 ${viewers.length} 位观众均支持 HEVC`;
    } else {
      summary.textContent =
        "本机支持；观众加入后会再次检测，不兼容时自动回退 H.264";
    }
    input.title = summary.textContent;
  }

  async function prepareEmbyBroadcast(): Promise<void> {
    const startButton =
      document.querySelector<HTMLButtonElement>("#emby-start-from-popup");
    const restoreStartButton = (recoveryFailed = false): void => {
      if (!startButton?.isConnected) return;
      startButton.disabled = false;
      startButton.removeAttribute("aria-busy");
      startButton.textContent = recoveryFailed
        ? "重试恢复 Emby 账户"
        : "开始 Emby 高清放映";
    };
    if (preparingBroadcast) {
      notify("放映正在准备中，请稍候", "info");
      return;
    }
    if (!window.roomDesktop) {
      notify("Emby 高清放映仅支持 Windows 桌面端", "danger");
      return;
    }
    if (!signal || !video || !joined) {
      notify("频道连接尚未就绪，请等待“已连接”后重试", "warn");
      return;
    }
    const preparationEpoch = ++broadcastPreparationEpoch;
    const preparationSuperseded = (): boolean =>
      leaving || preparationEpoch !== broadcastPreparationEpoch;
    if (!embyLogin) {
      if (startButton) {
        startButton.disabled = true;
        startButton.setAttribute("aria-busy", "true");
        startButton.textContent = "正在恢复 Emby 账户…";
      }
      try {
        await refreshEmbyAccounts(false);
      } finally {
        // Every recovery exit restores an actionable button. Previously an
        // early return below could leave this label and disabled state stuck.
        restoreStartButton(!embyLogin);
      }
      if (preparationSuperseded()) return;
    }
    if (!embyLogin) {
      notify(
        "Emby 账户尚未恢复；请点击上方已保存账户重试，或重新输入密码登录",
        "warn",
      );
      return;
    }
    if (!embySelectedItem) {
      restoreStartButton();
      notify("请先从媒体库选择要放映的影片或剧集", "warn");
      return;
    }
    if (!embyPlaybackInfo) {
      if (startButton) startButton.textContent = "正在重新读取媒体信息…";
      await selectEmbyItem(embySelectedItem);
      if (preparationSuperseded()) return;
    }
    if (!embyPlaybackInfo) {
      restoreStartButton();
      const reason =
        document.querySelector<HTMLElement>("#emby-stream-method")
          ?.textContent;
      notify(
        reason || "Emby 没有返回可播放媒体信息，请刷新媒体库后重试",
        "danger",
      );
      return;
    }
    if (broadcasterId) {
      restoreStartButton();
      notify(
        broadcasterId === selfId
          ? "请先停止当前放映，再切换放映方式"
          : `${broadcasterNickname || "其他成员"}正在放映，暂时无法开始新的放映`,
        true,
      );
      closeBroadcastDialog();
      return;
    }
    const allowHevc =
      document.querySelector<HTMLInputElement>("#emby-allow-hevc");
    const otherParticipants = [...participants.values()].filter(
      (participant) => participant.id !== selfId,
    );
    const hevcIncompatible = otherParticipants.filter((participant) =>
      embyCapabilityIssue(participant.embyCapabilities, "hevc"),
    );
    let useHevc =
      allowHevc?.checked === true &&
      detectEmbyMediaCapabilities().hevc;
    if (useHevc && hevcIncompatible.length) {
      useHevc = false;
      if (allowHevc) allowHevc.checked = false;
      notify(
        `${hevcIncompatible
          .map((participant) => participant.nickname)
        .join("、")}不支持 HEVC，已统一回退到 H.264。`,
      );
    }
    if (!useHevc) {
      const h264Incompatible = otherParticipants.filter((participant) =>
        embyCapabilityIssue(participant.embyCapabilities, "h264"),
      );
      if (h264Incompatible.length) {
        restoreStartButton();
        notify(
          `以下成员客户端暂不支持 Emby 高清播放：${h264Incompatible
            .map((participant) => participant.nickname)
            .join("、")}。请先升级客户端或让其离开后再开播。`,
          true,
        );
        return;
      }
    }
    preparingBroadcast = true;
    if (startButton) {
      startButton.disabled = true;
      startButton.setAttribute("aria-busy", "true");
      startButton.textContent = "正在建立 Emby 媒体流…";
    }
    localBroadcastMode = "emby";
    awaitingBroadcastGrant = true;
    updateBroadcastControls();
    const qualitySelect =
      document.querySelector<HTMLSelectElement>("#emby-quality");
    const frameRateSelect =
      document.querySelector<HTMLSelectElement>("#emby-frame-rate");
    const audioSelect =
      document.querySelector<HTMLSelectElement>("#emby-audio-track");
    const subtitleSelect =
      document.querySelector<HTMLSelectElement>("#emby-subtitle-track");
    const resume =
      document.querySelector<HTMLInputElement>("#emby-resume-playback");
    const requestedQuality = (qualitySelect?.value ||
      "auto") as EmbyPlaybackRequest["quality"] | "auto";
    const quality = budgetSafeQuality(requestedQuality, useHevc);
    embyFrameRate = normalizeEmbyFrameRate(
      frameRateSelect?.value || embyFrameRate,
    );
    localStorage.setItem(
      "synced:emby-frame-rate",
      String(embyFrameRate),
    );
    const compatibilityDowngrade =
      requestedQuality === "original" &&
      quality !== requestedQuality &&
      !embySourceCanUseOriginal(selectedEmbyMediaSource(), useHevc);
    if (requestedQuality === "auto") {
      notify(`自动画质已选择 ${embyQualityLabels[quality]}`);
    } else if (compatibilityDowngrade) {
      notify(
        `原始媒体需要高负载兼容转换，已优先使用 ${embyQualityLabels[quality]} H.264 / AAC；播放稳定后仍可在设置中调整`,
      );
    } else if (quality !== requestedQuality) {
      notify(
        `当前共享线路建议使用 ${embyQualityLabels[quality]}；SFU 服务器不设置带宽上限，自动档只依据实际端到端网络调整`,
      );
      updateEmbyBudget();
    }
    const request: EmbyPlaybackRequest = {
      accountId:
        embySelectedItem.accountId || embyActiveAccountId || undefined,
      itemId: embySelectedItem.id,
      mediaSourceId: selectedEmbyMediaSource()?.id,
      quality,
      audioStreamIndex:
        audioSelect?.value !== "" ? Number(audioSelect?.value) : undefined,
      subtitleStreamIndex:
        subtitleSelect?.value !== ""
          ? Number(subtitleSelect?.value)
          : undefined,
      frameRate: embyFrameRate,
      startTimeTicks:
        resume?.checked === true
          ? embySelectedItem.playbackPositionTicks
          : undefined,
      allowHevc: useHevc,
    };
    const broadcastStillCurrent = (): boolean =>
      !preparationSuperseded() && localBroadcastMode === "emby";
    const requireCurrentBroadcast = (): void => {
      if (!broadcastStillCurrent()) {
        throw new DOMException("Emby 放映启动已取消", "AbortError");
      }
    };
    try {
      setStatus("正在从 Emby 建立编码媒体流", "neutral");
      const firewallPromise = window.roomDesktop
        .ensurePortableFirewall()
        .catch(() => ({ portable: true, configured: false, repaired: false }));
      const controller = new EmbyBroadcastController({
        roomId: room,
        video,
        notify,
        onStatus: (stats) => {
          if (localBroadcastMode !== "emby" || broadcasterId !== selfId) return;
          setMediaStatus(
            sfuSession.publishing
              ? `Emby 高清 · SFU 单路上传 · 本地缓存 ${stats.localBufferedSeconds.toFixed(1)} 秒 · 发送队列 ${(stats.queuedBytes / 1_048_576).toFixed(1)} MB`
              : `Emby 高清 · P2P 备用 ${stats.viewers} 路 · 已播放 ${stats.readyViewers}/${stats.viewers} · 本地缓存 ${stats.localBufferedSeconds.toFixed(1)} 秒 · 独立队列 ${(stats.queuedBytes / 1_048_576).toFixed(1)} MB`,
          );
          if (stats.droppedFragments > 0) {
            setStatus("有观众网络过慢 · 正在从缓存独立补片", "neutral");
          }
          const now = Date.now();
          if (now - lastEmbyHostDiagnosticAt >= 10_000) {
            lastEmbyHostDiagnosticAt = now;
            const local = embyBroadcast?.localPlaybackDiagnostics;
            reportPlaybackDiagnostic("emby-host-sample", {
              viewers: stats.viewers,
              readyViewers: stats.readyViewers,
              queuedBytes: stats.queuedBytes,
              bufferedBytes: stats.bufferedBytes,
              droppedFragments: stats.droppedFragments,
              localBufferedSeconds: Number(
                stats.localBufferedSeconds.toFixed(2),
              ),
              quality: embyBroadcast?.playbackQuality,
              bitrate: embyBroadcast?.streamPlan?.bitrate,
              pressureCeiling: activeEmbyPressureCeiling(),
              documentHidden: document.visibilityState === "hidden",
              currentTime:
                local === undefined
                  ? undefined
                  : Number(local.currentTime.toFixed(3)),
              paused: local?.paused,
              seeking: local?.seeking,
              readyState: local?.readyState,
              bufferedWindows: local?.bufferedWindows.map((range) => [
                Number(range.start.toFixed(3)),
                Number(range.end.toFixed(3)),
              ]),
              appendQueueItems: local?.appendQueueItems,
              pendingMediaItems: local?.pendingMediaItems,
            });
          }
        },
        onStreamReady: (detail) => {
          if (localBroadcastMode !== "emby") return;
          reportPlaybackDiagnostic("emby-stream-ready", {
            width: detail.plan.width,
            height: detail.plan.height,
            frameRate: detail.plan.frameRate,
            bitrate: detail.plan.bitrate,
            videoCodec: detail.plan.videoCodec,
            method: detail.plan.method,
            pressureCeiling: activeEmbyPressureCeiling(),
          });
          const capabilities: BroadcastCapabilities = {
            width: Math.max(1, detail.plan.width),
            height: Math.max(1, detail.plan.height),
            frameRate: Math.max(1, detail.plan.frameRate),
            mode: "emby",
            mimeType: detail.mimeType,
            videoCodec: detail.plan.videoCodec,
            audioCodec: detail.plan.audioCodec,
            title: detail.title,
            bitrate: detail.plan.bitrate,
            durationTicks: detail.plan.runtimeTicks,
            allowOriginalRendition: true,
            maxActiveRenditions: 3,
          };
          setBroadcastCapabilities(capabilities);
          updateEmbySegmentRenditionDemand();
          if (broadcasterId === selfId) {
            try {
              safeSignalSend({
                type: "broadcast:capabilities",
                broadcastCapabilities: capabilities,
              });
            } catch {
              // The latest capabilities are re-sent after signaling reconnects.
            }
          }
        },
        onNetworkPressure: handleEmbyNetworkPressure,
      });
      embyBroadcast = controller;
      if (
        signalFeatures.has("emby-segment-relay-v1") &&
        segmentRelayAccess?.scope === "publish"
      ) {
        controller.setSegmentRelayAccess(signalUrl, segmentRelayAccess);
      }
      const stream = await controller.start(
        request,
        embyItemLabel(embySelectedItem),
      );
      requireCurrentBroadcast();
      if (embyBroadcast !== controller) {
        throw new DOMException("Emby 放映启动已替代", "AbortError");
      }
      const capabilities: BroadcastCapabilities = {
        width: Math.max(1, stream.plan.width),
        height: Math.max(1, stream.plan.height),
        frameRate: Math.max(1, stream.plan.frameRate),
        mode: "emby",
        mimeType: stream.mimeType,
        videoCodec: stream.plan.videoCodec,
        audioCodec: stream.plan.audioCodec,
        title: stream.title,
        bitrate: stream.plan.bitrate,
        durationTicks: stream.plan.runtimeTicks,
        allowOriginalRendition: true,
        maxActiveRenditions: 3,
      };
      setBroadcastCapabilities(capabilities);
      updateEmbySegmentRenditionDemand();
      await boundedUiOperation(
        window.roomDesktop.setCaptureActive(true),
        3_000,
        "启用 Emby 放映状态超时",
      );
      requireCurrentBroadcast();
      hideEmbyItemPopup(false);
      closeBroadcastDialog();
      setStatus("Emby 编码流已就绪 · 正在取得放映权", "neutral");
      if (
        !safeSignalSend({
          type: "broadcast:start",
          broadcastCapabilities: capabilities,
          sessionId: controller.sessionId,
        })
      ) {
        throw new Error("信令连接已断开，无法取得放映权");
      }
      void firewallPromise.then((firewall) => {
        if (!broadcastStillCurrent()) return;
        window.roomDesktop?.reportDiagnostic("portable-firewall-result", {
          configured: firewall.configured,
          repaired: firewall.repaired,
          mode: "emby",
        });
        if (firewall.portable && !firewall.configured) {
          notify(
            "Windows 防火墙规则未确认；SFU 主线路仍可播放，P2P 备用直连可能不可用。",
            true,
          );
        }
      });
    } catch (error) {
      const superseded = !broadcastStillCurrent();
      await cleanupLocalBroadcast();
      if (superseded || leaving) return;
      updateBroadcastControls();
      setStatus("Emby 高清放映启动失败", "error");
      notify(readableError(error, "Emby 高清放映启动失败"), true);
    } finally {
      preparingBroadcast = false;
      if (startButton?.isConnected) {
        startButton.disabled = false;
        startButton.removeAttribute("aria-busy");
        startButton.textContent = "开始 Emby 高清放映";
      }
    }
  }

  function hostControlsEmby(): boolean {
    return (
      localBroadcastMode === "emby" &&
      broadcasterId === selfId &&
      Boolean(embyBroadcast?.active)
    );
  }

  function hostCanSeekEmby(): boolean {
    return (
      localBroadcastMode === "emby" &&
      broadcasterId === selfId &&
      Boolean(embyBroadcast?.currentRequest)
    );
  }

  function playbackDuration(): number {
    const planned =
      Number(
        embyViewer?.activeSession?.plan.runtimeTicks ||
          embyBroadcast?.streamPlan?.runtimeTicks,
      ) / 10_000_000;
    if (Number.isFinite(planned) && planned > 0) return planned;
    return video && Number.isFinite(video.duration) ? video.duration : 0;
  }

  function updateDockPlaybackState(): void {
    const canControl = hostControlsEmby();
    const playButton =
      document.querySelector<HTMLButtonElement>("#dock-play");
    const rewindButton =
      document.querySelector<HTMLButtonElement>("#dock-rewind");
    const forwardButton =
      document.querySelector<HTMLButtonElement>("#dock-forward");
    const muteButton =
      document.querySelector<HTMLButtonElement>("#dock-mute");
    if (playButton) {
      playButton.disabled = !canControl;
      playButton.classList.toggle("is-playing", canControl && !video?.paused);
      playButton.setAttribute(
        "aria-label",
        canControl && !video?.paused ? "暂停" : "播放",
      );
      playButton.setAttribute(
        "aria-pressed",
        String(canControl && !video?.paused),
      );
    }
    if (rewindButton) rewindButton.disabled = !canControl;
    if (forwardButton) forwardButton.disabled = !canControl;
    if (muteButton) {
      muteButton.disabled = !broadcasterId;
      const muted = hostControlsEmby()
        ? Boolean(video?.muted || video?.volume === 0)
        : movieVolume <= 0;
      muteButton.setAttribute("aria-pressed", String(muted));
      muteButton.setAttribute("aria-label", muted ? "取消静音" : "静音");
    }
  }

  function handlePlayPause(): void {
    if (!video) return;
    if (hostControlsEmby()) {
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
      return;
    }
    if (broadcasterId && broadcasterId !== selfId) {
      notify("播放由放映端控制", "info");
    }
  }

  function toggleFullscreen(): void {
    if (!playerStage || !broadcasterId || video?.hidden) return;
    if (isImmersivePlayback()) {
      finishImmersiveUi();
      void exitImmersivePlayer().finally(syncAppMode);
      return;
    }
    void enterImmersivePlayer(playerStage)
      .then(() => {
        revealFullscreenControls();
        syncAppMode();
        void resolveFullscreenFit();
      })
      .catch((error) => {
        finishImmersiveUi();
        syncAppMode();
        notify(readableError(error, "无法进入全屏播放"), "warn");
      });
  }

  function toggleMute(): void {
    if (!video || !broadcasterId) return;
    if (hostControlsEmby()) {
      video.muted = !video.muted;
      notify(video.muted ? "本地影片声音已静音" : "本地影片声音已开启");
    } else if (broadcasterId !== selfId) {
      applyMovieVolume(
        movieVolume > 0 ? 0 : Math.max(0.05, lastAudibleMovieVolume),
      );
      notify(movieVolume > 0 ? "影片声音已开启" : "影片声音已静音");
    }
    updateDockPlaybackState();
  }

  function adjustVolume(delta: number): void {
    if (!video || !broadcasterId) return;
    if (hostControlsEmby()) {
      video.volume = Math.max(0, Math.min(1, video.volume + delta));
      video.muted = video.volume === 0;
      if (movieVolumeInput) movieVolumeInput.value = String(video.volume);
      if (movieVolumeValue) {
        movieVolumeValue.value = `${Math.round(video.volume * 100)}%`;
      }
    } else if (broadcasterId !== selfId) {
      applyMovieVolume(movieVolume + delta);
    }
    updateDockPlaybackState();
  }

  function seekRelative(seconds: number): void {
    if (!video || !hostCanSeekEmby()) {
      if (broadcasterId && broadcasterId !== selfId) {
        notify("播放进度由放映端统一控制", "info");
      }
      return;
    }
    const duration = playbackDuration() || Number.POSITIVE_INFINITY;
    const target = Math.max(
      0,
      Math.min(duration, (video.currentTime || 0) + seconds),
    );
    embyBroadcast?.seekTo(target);
    updateEmbyViewerTimeline();
  }

  function seekToPercent(percent: number): void {
    if (!video || !hostCanSeekEmby()) return;
    const duration = playbackDuration();
    if (duration > 0) {
      embyBroadcast?.seekTo(
        duration * Math.max(0, Math.min(100, percent)) / 100,
      );
      updateEmbyViewerTimeline();
    }
  }

  function toggleDanmaku(): void {
    danmakuEnabled = !danmakuEnabled;
    localStorage.setItem("synced:danmaku", String(danmakuEnabled));
    const button = document.getElementById("dock-danmaku");
    button?.classList.toggle("is-on", danmakuEnabled);
    button?.setAttribute("aria-pressed", String(danmakuEnabled));
    button?.setAttribute(
      "aria-label",
      danmakuEnabled ? "关闭弹幕" : "开启弹幕",
    );
    button?.setAttribute(
      "title",
      danmakuEnabled ? "弹幕已开启，点击关闭" : "弹幕已关闭，点击开启",
    );
    if (button instanceof HTMLElement) {
      button.dataset.tooltip = danmakuEnabled
        ? "弹幕：已开启"
        : "弹幕：已关闭";
    }
    if (!danmakuEnabled) {
      stageDanmaku.clear();
      window.roomDesktop?.clearDanmaku();
    }
    syncDesktopDanmaku();
    notify(
      danmakuEnabled
        ? "弹幕已开启，聊天消息会显示在画面上"
        : "弹幕已关闭，聊天消息仍会保留在聊天记录中",
    );
  }

  function focusCompanion(target: "chat" | "members"): void {
    const targetElement = document.getElementById(
      target === "chat" ? "chat-panel" : "member-panel",
    );
    document.body.classList.remove("panel-collapsed");
    document.body.classList.add("panel-open");
    document.dispatchEvent(
      new CustomEvent<"chat" | "members">("synced:companion-tab", {
        detail: target,
      }),
    );
    const toggle = document.getElementById("panel-toggle");
    toggle?.setAttribute("aria-expanded", "true");
    toggle?.setAttribute("aria-label", "收起频道陪伴面板");
    toggle?.setAttribute("title", "收起频道陪伴面板");
    if (toggle instanceof HTMLElement) {
      toggle.dataset.tooltip = "收起频道陪伴面板";
    }
    targetElement?.focus({ preventScroll: true });
    if (target === "chat") {
      document.getElementById("chat-input")?.focus();
    }
  }

  function setDockChatComposerOpen(
    open: boolean,
    restoreButtonFocus = false,
  ): void {
    if (!dockChatComposer || !dockChatButton || !dockChatPresence) return;
    dockChatButton.setAttribute("aria-expanded", String(open));
    dockChatButton.setAttribute("aria-pressed", String(open));
    dockChatButton.classList.toggle("is-on", open);
    if (open) {
      showControlsWithGlass();
      dockChatComposer.classList.add("is-open");
      void dockChatPresence.show(sessionUiAbortController.signal);
      queueMicrotask(() => {
        if (
          dockChatButton.getAttribute("aria-expanded") === "true" &&
          !dockChatComposer.hidden
        ) {
          dockChatInput?.focus({ preventScroll: true });
        }
      });
      return;
    }
    dockChatComposer.classList.remove("is-open");
    void dockChatPresence.hide(sessionUiAbortController.signal);
    if (restoreButtonFocus) {
      dockChatButton.focus({ preventScroll: true });
    }
  }

  function toggleDockChatComposer(forceOpen?: boolean): void {
    if (!dockChatComposer || !dockChatButton) return;
    const open =
      forceOpen ?? dockChatButton.getAttribute("aria-expanded") !== "true";
    setDockChatComposerOpen(open);
  }

  function focusChat(): void {
    toggleDockChatComposer(true);
  }

  async function togglePiP(): Promise<void> {
    if (!video || !desktop) return;
    if (isPictureInPictureActive()) {
      await setMiniWindowPreference(false, false);
      return;
    }
    if (
      video.hidden ||
      !document.pictureInPictureEnabled ||
      typeof video.requestPictureInPicture !== "function"
    ) {
      notify("当前没有可用于小窗播放的画面", "warn");
      return;
    }
    try {
      await setMiniWindowPreference(true, false);
      await video.requestPictureInPicture();
      updatePictureInPictureButton();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "小窗模式开启失败",
        "danger",
      );
    }
    const displayedVolume = hostControlsEmby()
      ? video?.volume ?? 1
      : movieVolume;
    if (movieVolumeInput) {
      movieVolumeInput.disabled = !broadcasterId;
      movieVolumeInput.value = String(displayedVolume);
    }
    if (movieVolumeValue) {
      movieVolumeValue.value = `${Math.round(displayedVolume * 100)}%`;
    }
  }

  function cycleSmartCrop(): void {
    const modes: Array<"smart" | "contain" | "cover"> = nativeAndroid
      ? ["smart", "contain"]
      : ["smart", "contain", "cover"];
    const currentIndex = modes.indexOf(fullscreenFit);
    fullscreenFit = modes[(currentIndex + 1) % modes.length] ?? "smart";
    localStorage.setItem("synced:fullscreen-fit", fullscreenFit);
    updateFullscreenFitUi();
    void resolveFullscreenFit();
    videoEnhancement?.refresh();
  }

  function closeCommandPalette(): void {
    const dialog = document.querySelector<HTMLDialogElement>(
      ".command-palette[open]",
    );
    if (!dialog) return;
    void dialogController.close(dialog).finally(() => dialog.remove());
  }

  function runCommand(command: string): void {
    if (command === "play") handlePlayPause();
    else if (command === "fullscreen") toggleFullscreen();
    else if (command === "mute") toggleMute();
    else if (command === "danmaku") toggleDanmaku();
    else if (command === "chat") focusChat();
    else if (command === "members") focusCompanion("members");
    else if (command === "picture") pictureSettingsButton?.click();
    else if (command === "invite") {
      document.getElementById("session-invite")?.click();
    } else if (command === "help") showKeyboardHelp();
  }

  function toggleCommandPalette(): void {
    const existing = document.querySelector<HTMLDialogElement>(
      ".command-palette",
    );
    if (existing) {
      if (existing.open) closeCommandPalette();
      else existing.remove();
      return;
    }
    const dialog = document.createElement("dialog");
    dialog.className = "command-palette material-regular";
    dialog.innerHTML = `
      <header>
        <label for="command-search">命令面板</label>
        <button class="btn btn-ghost btn-icon" type="button" data-close-command aria-label="关闭">
          <i data-lucide="x"></i>
        </button>
      </header>
      <input id="command-search" type="search" autocomplete="off"
             placeholder="搜索操作…" aria-label="搜索命令">
      <div class="command-list" role="listbox">
        <button type="button" data-command="play"><span>播放 / 暂停</span><kbd>Space</kbd></button>
        <button type="button" data-command="fullscreen"><span>全屏切换</span><kbd>F</kbd></button>
        <button type="button" data-command="mute"><span>静音切换</span><kbd>M</kbd></button>
        <button type="button" data-command="danmaku"><span>弹幕开关</span><kbd>D</kbd></button>
        <button type="button" data-command="chat"><span>打开聊天</span><kbd>C</kbd></button>
        <button type="button" data-command="members"><span>打开成员列表</span></button>
        <button type="button" data-command="picture"><span>画面设置</span><kbd>S</kbd></button>
        <button type="button" data-command="invite"><span>邀请朋友</span></button>
        <button type="button" data-command="help"><span>键盘快捷键</span><kbd>?</kbd></button>
      </div>
    `;
    document.body.append(dialog);
    hydrateIcons(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog
      .querySelector("[data-close-command]")
      ?.addEventListener("click", closeCommandPalette);
    dialog.querySelectorAll<HTMLButtonElement>("[data-command]").forEach(
      (button) => {
        button.addEventListener("click", () => {
          const command = button.dataset.command || "";
          closeCommandPalette();
          runCommand(command);
        });
      },
    );
    dialog
      .querySelector<HTMLInputElement>("#command-search")
      ?.addEventListener("input", (event) => {
        const query = (event.currentTarget as HTMLInputElement).value
          .trim()
          .toLocaleLowerCase("zh-CN");
        dialog
          .querySelectorAll<HTMLButtonElement>("[data-command]")
          .forEach((button) => {
            button.hidden =
              Boolean(query) &&
              !button.textContent?.toLocaleLowerCase("zh-CN").includes(query);
          });
      });
    openDialog(dialog);
    dialog.querySelector<HTMLInputElement>("#command-search")?.focus();
  }

  function showKeyboardHelp(): void {
    const existing = document.getElementById(
      "keyboard-help-dialog",
    ) as HTMLDialogElement | null;
    if (existing) {
      if (existing.open) {
        void dialogController.close(existing).finally(() => existing.remove());
      } else {
        existing.remove();
      }
      return;
    }
    const dialog = document.createElement("dialog");
    dialog.id = "keyboard-help-dialog";
    dialog.className = "keyboard-help-dialog material-regular";
    dialog.innerHTML = `
      <header>
        <h2>键盘快捷键</h2>
        <button class="btn btn-ghost btn-icon" id="kbhelp-close" type="button" aria-label="关闭">
          <i data-lucide="x"></i>
        </button>
      </header>
      <div class="keyboard-help-grid">
        <section>
          <h3>播放控制</h3>
          <table>
            <tr><td><kbd>Space</kbd> / <kbd>K</kbd></td><td>播放 / 暂停</td></tr>
            <tr><td><kbd>←</kbd> / <kbd>J</kbd></td><td>后退 10 秒</td></tr>
            <tr><td><kbd>→</kbd> / <kbd>L</kbd></td><td>前进 10 秒</td></tr>
            <tr><td><kbd>Shift</kbd>+<kbd>←/→</kbd></td><td>前后 60 秒</td></tr>
            <tr><td><kbd>0</kbd>–<kbd>9</kbd></td><td>跳到 0%–90%</td></tr>
            <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>音量 ±5%</td></tr>
            <tr><td><kbd>M</kbd></td><td>静音切换</td></tr>
          </table>
        </section>
        <section>
          <h3>界面</h3>
          <table>
            <tr><td><kbd>F</kbd></td><td>全屏切换</td></tr>
            <tr><td><kbd>P</kbd></td><td>小窗切换</td></tr>
            <tr><td><kbd>D</kbd></td><td>弹幕开关</td></tr>
            <tr><td><kbd>C</kbd></td><td>聊天 / 侧栏</td></tr>
            <tr><td><kbd>S</kbd></td><td>智能裁剪循环</td></tr>
            <tr><td><kbd>Ctrl/⌘ K</kbd></td><td>命令面板</td></tr>
            <tr><td><kbd>Esc</kbd></td><td>逐级退出</td></tr>
            <tr><td><kbd>?</kbd></td><td>本面板</td></tr>
          </table>
        </section>
      </div>
    `;
    document.body.append(dialog);
    hydrateIcons(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.querySelector("#kbhelp-close")?.addEventListener("click", () => {
      void dialogController.close(dialog).finally(() => dialog.remove());
    });
    openDialog(dialog);
  }

  function handleGlobalKey(event: KeyboardEvent): void {
    const key =
      event.key ||
      (/^Key[A-Z]$/.test(event.code)
        ? event.code.slice(3).toLowerCase()
        : /^Digit[0-9]$/.test(event.code)
          ? event.code.slice(5)
          : event.code === "Space"
            ? " "
            : event.code);
    const target = event.target;
    const inInput =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.contentEditable === "true");

    if (
      (event.metaKey || event.ctrlKey) &&
      key.toLowerCase() === "k"
    ) {
      event.preventDefault();
      toggleCommandPalette();
      return;
    }
    if (inInput && key !== "Escape") return;

    if (key === "Escape") {
      if (dockChatComposer && !dockChatComposer.hidden) {
        event.preventDefault();
        setDockChatComposerOpen(false, true);
        return;
      }
      if (document.fullscreenElement || isImmersivePlayback()) {
        event.preventDefault();
        toggleFullscreen();
        return;
      }
      if (document.pictureInPictureElement) {
        event.preventDefault();
        void document.exitPictureInPicture();
        return;
      }
      if (document.querySelector(".command-palette[open]")) {
        event.preventDefault();
        closeCommandPalette();
        return;
      }
      if (embyItemPopup && !embyItemPopup.hidden) {
        event.preventDefault();
        hideEmbyItemPopup();
        return;
      }
      const openDialogElement =
        document.querySelector<HTMLDialogElement>("dialog[open]");
      if (openDialogElement) {
        event.preventDefault();
        closeDialog(openDialogElement);
        return;
      }
      if (
        (nativeAndroid || overlayPanelQuery.matches) &&
        document.body.classList.contains("panel-open")
      ) {
        event.preventDefault();
        applyPanelState(true);
        document.getElementById("session-companion")?.focus();
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || inInput) return;

    switch (key) {
      case " ":
      case "k":
      case "K":
        event.preventDefault();
        if (!event.repeat) handlePlayPause();
        break;
      case "f":
      case "F":
        event.preventDefault();
        if (!event.repeat) toggleFullscreen();
        break;
      case "m":
      case "M":
        event.preventDefault();
        if (!event.repeat) toggleMute();
        break;
      case "ArrowUp":
        event.preventDefault();
        adjustVolume(0.05);
        break;
      case "ArrowDown":
        event.preventDefault();
        adjustVolume(-0.05);
        break;
      case "ArrowLeft":
      case "j":
      case "J":
        event.preventDefault();
        seekRelative(event.shiftKey ? -60 : -10);
        break;
      case "ArrowRight":
      case "l":
      case "L":
        event.preventDefault();
        seekRelative(event.shiftKey ? 60 : 10);
        break;
      case "d":
      case "D":
        toggleDanmaku();
        break;
      case "c":
      case "C":
        focusChat();
        break;
      case "p":
      case "P":
        if (desktop) void togglePiP();
        break;
      case "s":
      case "S":
        cycleSmartCrop();
        break;
      case "?":
        showKeyboardHelp();
        break;
      default:
        if (/^[0-9]$/.test(key)) {
          seekToPercent(Number(key) * 10);
        }
    }
  }

  async function handleMessage(
    message: SignalEnvelope,
    operationSignal?: AbortSignal,
  ): Promise<void> {
    operationSignal?.throwIfAborted();
    const ensureScheduledOperationActive = (): void => {
      operationSignal?.throwIfAborted();
    };
    if (leaving) return;
    if (!roomStateRevisionGate.accept(message)) return;
    if (message.type === "server:hello") {
      const advertised = Array.isArray(message.networkProbe?.versions)
        ? message.networkProbe.versions
            .map(Number)
            .filter((version) => version === 1 || version === 2)
        : [];
      networkProbeVersions = advertised.length
        ? [...new Set(advertised)].sort((left, right) => right - left)
        : [1];
      return;
    }
    if (
      message.type === "server:ice-refresh" &&
      Array.isArray(message.iceServers)
    ) {
      iceServers = message.iceServers;
      if (watcherPc) {
        try {
          watcherPc.setConfiguration({
            ...watcherPc.getConfiguration(),
            iceServers: selectPeerIceServers(
              iceServers,
              watcherRelayOnly ? "relay" : "all",
            ),
          });
        } catch {
          // A closing peer will be rebuilt with the new credentials.
        }
      }
      for (const peer of outboundPeers.values()) {
        try {
          peer.pc.setConfiguration({
            ...peer.pc.getConfiguration(),
            iceServers: selectPeerIceServers(iceServers, "all"),
          });
        } catch {
          // A closing viewer peer no longer needs refreshed credentials.
        }
      }
      companion?.updateIceServers(iceServers);
      return;
    }
    if (message.type === "segment:token") {
      updateSegmentRelayAccess(message.segmentRelay);
      return;
    }
    if (message.type === "channel:joined" && message.clientId) {
      clearChannelJoinAckTimer();
      setConnectionStep("members", "正在同步频道成员");
      const rejoined = hasJoinedOnce;
      const previousSelfId = selfId;
      const previousBroadcasterId = broadcasterId;
      const retainedCapabilities = broadcastCapabilities;
      const retainedBroadcastLive = Boolean(
        embyBroadcast?.active ||
          mediaStream
          ?.getVideoTracks()
          .some((track) => track.readyState === "live"),
      );
      const sameIdentity =
        rejoined &&
        Boolean(previousSelfId) &&
        previousSelfId === message.clientId;
      const preserveWatcher =
        Boolean(
          sfuViewerActive &&
            rejoined &&
            previousSelfId === message.clientId &&
            previousBroadcasterId === message.broadcasterId &&
            remoteFirstFrame,
        ) ||
        shouldPreserveActiveWatcher({
          rejoined,
          previousSelfId,
          nextSelfId: message.clientId,
          previousBroadcasterId,
          nextBroadcasterId: message.broadcasterId,
          peerState: watcherPc?.connectionState,
          hasDecodedFrame: remoteFirstFrame,
        });
      const preserveOutboundPeers = Boolean(
        sameIdentity &&
          previousBroadcasterId === previousSelfId &&
          message.broadcasterId === message.clientId &&
          retainedBroadcastLive,
      );
      const refreshOutboundPeers =
        preserveOutboundPeers && forceMediaRenegotiationAfterReconnect;
      const preserveCompanion = Boolean(
        sameIdentity &&
          companion,
      );
      const refreshWatcherInBackground =
        preserveWatcher && forceMediaRenegotiationAfterReconnect;
      const shouldResumeBroadcast =
        resumeBroadcastAfterReconnect &&
        retainedBroadcastLive &&
        (!message.broadcasterId ||
          message.broadcasterId === message.clientId);
      const broadcastIdentityResumed =
        shouldResumeBroadcast &&
        message.broadcasterId === message.clientId;
      const shouldResumeVoice =
        resumeVoiceAfterReconnect || companion?.voiceActive || false;
      hasJoinedOnce = true;
      clearSignalReconnectTimer();
      signalReconnectAttempt = 0;
      signalReconnectInFlight = false;
      signalUnavailable = false;
      signalFeatures = new Set(
        Array.isArray(message.serverFeatures || message.features)
          ? (message.serverFeatures || message.features || [])
              .map((feature) => String(feature || "").trim())
              .filter((feature) => /^[a-z][a-z0-9-]{0,63}$/i.test(feature))
          : [],
      );
      if (signalFeatures.has("emby-segment-relay-v1")) {
        updateSegmentRelayAccess(message.segmentRelay);
      } else {
        segmentRelayAccess = undefined;
        embyAbrViewer?.destroy();
        embyAbrViewer = undefined;
        embySegmentFallbackActive = false;
        embySegmentFallbackRequested = false;
        embySegmentFallbackTargetTime = 0;
      }
      reportedSfuPublisherActive = undefined;
      reportedSfuViewerActive = undefined;
      setSignalStatus("connected", rejoined ? "已重连" : "已连接");
      if (rejoined) {
        if (!preserveWatcher) closeWatcher();
        if (!preserveOutboundPeers) {
          outboundPeers.forEach(({ pc }) => pc.close());
          outboundPeers.clear();
          receiverPreferences.clear();
        }
        if (!preserveCompanion) {
          await musicController?.stop(false);
          await companion?.destroy();
          ensureScheduledOperationActive();
          companion = undefined;
        }
      }
      selfId = message.clientId;
      joined = true;
      channelName = message.channelName || channelName;
      broadcasterId = message.broadcasterId;
      if (message.broadcastCapabilities) {
        setBroadcastCapabilities(
          message.broadcastCapabilities,
          !preserveWatcher,
        );
      } else if (shouldResumeBroadcast && retainedCapabilities) {
        setBroadcastCapabilities(retainedCapabilities);
      } else if (preserveWatcher && retainedCapabilities) {
        setBroadcastCapabilities(retainedCapabilities);
      } else {
        setBroadcastCapabilities(undefined, true);
      }
      iceServers = message.iceServers || [];
      clearSfuPrimaryRecovery();
      sfuAccess = sanitizeSfuAccess(message.sfu);
      if (sfuAccess) {
        void ensureSfuConnection();
      } else {
        sfuPublishedKey = "";
        sfuWatchEpoch += 1;
        sfuViewerActive = false;
        void sfuSession.disconnect().catch(() => undefined);
      }
      if (sfuViewerActive) reportSfuStatus("viewer", true);
      if (broadcasterId === selfId && sfuSession.publishing) {
        reportSfuStatus("publisher", true);
      } else if (
        sfuAccess &&
        broadcasterId &&
        broadcasterId !== selfId &&
        !sfuViewerActive
      ) {
        scheduleSfuPrimaryRecovery("refreshed SFU access is available");
      }
      participants.clear();
      for (const participant of message.participants || []) {
        participants.set(participant.id, participant);
      }
      renderLobbyParticipants();
      setConnectionStep("media", "正在准备媒体线路");
      if (broadcasterId === selfId) {
        for (const viewerId of [...outboundPeers.keys()]) {
          if (!participants.has(viewerId)) forgetDepartedViewer(viewerId);
        }
        for (const viewerId of [...receiverPreferences.keys()]) {
          if (!participants.has(viewerId)) {
            receiverPreferences.delete(viewerId);
          }
        }
        updateEmbySegmentRenditionDemand();
      }
      networkAdvice = fallbackNetworkAdvice(
        Math.max(1, participants.size),
      );
      const forceProbe = !rejoined || forceNextNetworkProbe;
      forceNextNetworkProbe = false;
      void refreshNetworkReport(forceProbe);
      const broadcaster = broadcasterId
        ? participants.get(broadcasterId)
        : undefined;
      broadcasterNickname = broadcaster?.nickname || "";
      const title =
        document.querySelector<HTMLElement>("#session-channel-name");
      if (title) title.textContent = channelName;
      if (preserveCompanion && companion) {
        companion.syncParticipants(message.participants || []);
        syncDesktopDanmaku();
      } else {
        companion = new RoomCompanion(
          signal!,
          selfId,
          iceServers,
          message.participants || [],
          notify,
          (author, text, mine) => {
            if (
              shouldRenderStageDanmaku({
                enabled: danmakuEnabled,
                desktop,
                broadcasterId,
                appFocused: document.hasFocus(),
              })
            ) {
              // A screen broadcaster has to return to the app to type. The
              // native player overlay correctly hides while that player is no
              // longer foreground, so echo the message on the in-app stage as
              // immediate confirmation instead of making it appear lost.
              stageDanmaku.add(author, text, mine);
            }
            if (danmakuEnabled) {
              window.roomDesktop?.showDanmaku(author, text, mine);
            }
          },
          (active, count) => {
            syncDesktopDanmaku();
            setVoiceStatus(active, count);
          },
          (nextParticipants, speakingLevels) => {
            renderLobbyParticipants(nextParticipants, speakingLevels);
          },
        );
      }
      resumeVoiceAfterReconnect = false;
      if (shouldResumeVoice && !preserveCompanion) {
        void companion.resumeVoice().catch((error) => {
          notify(
            error instanceof Error
              ? `频道已恢复，但连麦恢复失败：${error.message}`
              : "频道已恢复，但连麦恢复失败",
            true,
          );
        });
      }
      rememberChannel({
        room,
        name: channelName,
        signalUrl,
        lastJoinedAt: Date.now(),
      });
      setStatus(
        message.created ? "频道已创建" : "频道已加入",
        "ready",
      );
      void finishConnectionProgress().then(() => {
        if (!initialInvitePending || rejoined || leaving) return;
        initialInvitePending = false;
        const inviteDialog =
          document.querySelector<HTMLDialogElement>("#invite-dialog");
        if (inviteDialog) openDialog(inviteDialog);
      });
      if (desktop && window.roomDesktop) {
        try {
          const network = await boundedUiOperation(
            window.roomDesktop.getNetworkInfo(),
            3_000,
            "读取桌面网络信息超时",
          );
          ensureScheduledOperationActive();
          localDirectAddresses = network.lanAddresses;
          desktopNetworkSignature = JSON.stringify({
            addresses: [...network.lanAddresses].sort(),
            tunnels: [...network.virtualInterfaces].sort(),
          });
        } catch {
          localDirectAddresses = [];
        }
      } else {
        localDirectAddresses = await getNativeLocalAddresses();
        ensureScheduledOperationActive();
      }
      if (refreshOutboundPeers && broadcasterId === selfId) {
        for (const [viewerId, peer] of [...outboundPeers]) {
          await createOfferForViewer(
            viewerId,
            peer.codecAttempt,
            [],
            peer.sessionId,
            participants.get(viewerId)?.embyCapabilities,
          );
          ensureScheduledOperationActive();
        }
      }
      updateBroadcastControls();
      forceMediaRenegotiationAfterReconnect = false;
      if (
        shouldResumeBroadcast &&
        signal &&
        ((localBroadcastMode === "emby" && embyBroadcast?.active) ||
          (activePreset && mediaStream))
      ) {
        resumeBroadcastAfterReconnect = false;
        awaitingBroadcastGrant = !broadcastIdentityResumed;
        broadcasterId = broadcastIdentityResumed ? selfId : undefined;
        if (localBroadcastMode === "emby") {
          showLocalEmbyStage();
        } else {
          showLocalStage();
        }
        updateBroadcastControls();
        if (broadcastIdentityResumed) {
          companion?.setBroadcaster(selfId);
          setStatus("频道与放映已恢复", "ready");
          if (!safeSignalSend({
            type: "broadcast:capabilities",
            broadcastCapabilities:
              broadcastCapabilities || retainedCapabilities,
          })) {
            scheduleSignalReconnect(true);
          }
          await publishBroadcastToSfu();
          ensureScheduledOperationActive();
        } else {
          setStatus("频道已恢复 · 正在恢复放映", "neutral");
          if (!safeSignalSend({
            type: "broadcast:start",
            broadcastCapabilities:
              broadcastCapabilities || retainedCapabilities,
            ...(localBroadcastMode === "emby" && embyBroadcast
              ? { sessionId: embyBroadcast.sessionId }
              : {}),
          })) {
            scheduleSignalReconnect(true);
          }
        }
      } else if (broadcasterId && broadcasterId !== selfId) {
        resumeBroadcastAfterReconnect = false;
        if (mediaStream || embyBroadcast) {
          await cleanupLocalBroadcast();
          ensureScheduledOperationActive();
        }
        if (preserveWatcher) {
          showRemoteStage();
          if (refreshWatcherInBackground) {
            setStatus("网络已切换 · 正在后台更新直连路径", "neutral");
            await beginWatching(true);
            ensureScheduledOperationActive();
          } else {
            setStatus("服务器已恢复 · 画面继续播放", "ready");
            sendViewerQualityPreference(false);
          }
        } else {
          await beginWatching(true);
          ensureScheduledOperationActive();
        }
      } else {
        resumeBroadcastAfterReconnect = false;
        showIdleStage();
        setSignalStatus("connected", rejoined ? "已重连" : "已连接");
        setMediaStatus("当前无人放映");
      }
      return;
    }

    if (message.type === "moderation:kicked") {
      notify(message.message || "你已被频道主移出频道", true);
      await leaveSession();
      return;
    }

    if (message.type === "network:probe-result") {
      // The bounded probe runner consumes this event directly so media
      // negotiation never waits behind throughput samples.
      return;
    }

    if (message.type === "network:advice") {
      const nextAdvice = sanitizeNetworkAdvice(
        message.networkAdvice,
        networkAdvice.revision,
      );
      if (nextAdvice) {
        const previousRouteMode = networkAdvice.routeMode;
        networkAdvice = nextAdvice;
        scheduleNetworkAdviceExpiry(nextAdvice);
        const dialog =
          document.querySelector<HTMLDialogElement>("#broadcast-dialog");
        applyBandwidthRecommendation(
          Boolean(dialog?.open && !qualitySelectionTouched),
        );
        const desiredRelayOnly =
          nextAdvice.routeMode === "relay-preferred";
        const relayPolicyChanged =
          previousRouteMode !== nextAdvice.routeMode &&
          desiredRelayOnly !== watcherRelayOnly;
        if (
          relayPolicyChanged &&
          broadcasterId &&
          broadcasterId !== selfId &&
          watcherPc &&
          shouldReplaceWatcherForRouteAdvice({
            peerState: watcherPc.connectionState,
            hasDecodedFrame: remoteFirstFrame,
          })
        ) {
          watchAttempts = 0;
          setStatus("已记录新线路建议 · 正在恢复失败的媒体连接", "neutral");
          await beginWatching(true);
        }
      }
      return;
    }

    const previousEmbyViewerCount = embyViewerCount();
    const previousParticipantCount = participants.size;
    if (message.participant) {
      participants.set(message.participant.id, message.participant);
    }
    if (message.type === "participant:left" && message.participantId) {
      participants.delete(message.participantId);
      if (broadcasterId === selfId) {
        forgetDepartedViewer(message.participantId);
      }
    }
    if (
      message.type === "participant:joined" ||
      message.type === "participant:left" ||
      message.type === "participant:updated"
    ) {
      if (networkAdvice.revision === 0) {
        networkAdvice = fallbackNetworkAdvice(
          Math.max(1, participants.size),
        );
        renderNetworkRecommendation();
      }
      if (
        (message.type === "participant:joined" ||
          message.type === "participant:left") &&
        participants.size !== previousParticipantCount
      ) {
        scheduleMembershipNetworkProbe();
      }
      updateEmbyBudget();
      updateEmbySegmentRenditionDemand();
      if (embyViewerCount() !== previousEmbyViewerCount) {
        scheduleEmbyQualityRebalance(
          "频道人数变化，正在重新分配每路码率",
        );
      }
    }
    if (companion) {
      await companion.handle(message);
      ensureScheduledOperationActive();
    }

    if (message.type === "broadcast:granted" && message.broadcasterId === selfId) {
      updateSegmentRelayAccess(message.segmentRelay);
      awaitingBroadcastGrant = false;
      broadcasterId = selfId;
      broadcasterNickname = nickname;
      // The grant is the signaling server's positive acknowledgement. Clear
      // any reconnect/recovery label that was shown while the broadcast was
      // being reclaimed; media status updates are intentionally routed to a
      // separate HUD track and therefore cannot clear it on their own.
      setSignalStatus("connected", "已连接");
      closeBroadcastDialog();
      if (message.broadcastCapabilities) {
        setBroadcastCapabilities(message.broadcastCapabilities);
      }
      updateEmbySegmentRenditionDemand();
      companion?.setBroadcaster(selfId);
      syncDesktopDanmaku();
      if (broadcastCapabilities?.mode === "emby") {
        showLocalEmbyStage();
      } else {
        showLocalStage();
      }
      updateBroadcastControls();
      setStatus(
        broadcastCapabilities?.mode === "emby"
          ? "你正在进行 Emby 高清放映"
          : "你正在放映",
        "ready",
      );
      updateNativePlaybackActivity(
        true,
        broadcastCapabilities?.mode === "emby"
          ? "正在进行 Emby 放映"
          : "正在进行屏幕放映",
      );
      if (statsTimer !== undefined) {
        window.clearInterval(statsTimer);
      }
      statsTimer =
        broadcastCapabilities?.mode === "emby"
          ? undefined
          : window.setInterval(updateOutboundStats, 1_000);
      clearSfuPrimaryRecovery();
      await publishBroadcastToSfu();
      ensureScheduledOperationActive();
      return;
    }
    if (message.type === "broadcast:started" && message.broadcasterId) {
      if (message.broadcasterId === selfId) return;
      closeBroadcastDialog();
      if (
        message.broadcasterId === broadcasterId &&
        watcherPc &&
        !["failed", "closed"].includes(watcherPc.connectionState) &&
        remoteFirstFrame
      ) {
        broadcasterNickname =
          message.nickname || broadcasterNickname || "朋友";
        if (message.broadcastCapabilities) {
          setBroadcastCapabilities(message.broadcastCapabilities);
        }
        setStatus("放映端信令已恢复 · 画面继续播放", "ready");
        sendViewerQualityPreference(false);
        return;
      }
      await cleanupLocalBroadcast();
      ensureScheduledOperationActive();
      broadcasterId = message.broadcasterId;
      broadcasterNickname = message.nickname || "朋友";
      clearSfuPrimaryRecovery();
      sfuFailedBroadcastKey = "";
      setBroadcastCapabilities(message.broadcastCapabilities, true);
      companion?.setBroadcaster(broadcasterId);
      syncDesktopDanmaku();
      updateBroadcastControls();
      await beginWatching(true);
      ensureScheduledOperationActive();
      return;
    }
    if (
      message.type === "broadcast:capabilities" &&
      message.broadcasterId === broadcasterId
    ) {
      setBroadcastCapabilities(message.broadcastCapabilities);
      syncPlayerAspect();
      sendViewerQualityPreference(false);
      return;
    }
    if (message.type === "broadcast:stopped") {
      const wasSelf = broadcasterId === selfId;
      closeWatcher();
      if (wasSelf) {
        await cleanupLocalBroadcast();
        ensureScheduledOperationActive();
      }
      broadcasterId = undefined;
      broadcasterNickname = "";
      sfuFailedBroadcastKey = "";
      setBroadcastCapabilities(undefined);
      companion?.setBroadcaster(undefined);
      syncDesktopDanmaku();
      showIdleStage();
      updateBroadcastControls();
      setSignalStatus("connected", "已连接");
      setMediaStatus("放映已停止");
      updateNativePlaybackActivity(false);
      return;
    }
    if (message.type === "viewer:joined" && message.viewerId) {
      if (broadcasterId === selfId && message.sessionId) {
        window.roomDesktop?.reportDiagnostic("p2p-viewer-ready", {
          viewerId: message.viewerId,
          attempt: message.attempt,
          sessionId: message.sessionId,
          codecs: message.codecs,
        });
        await createOfferForViewer(
          message.viewerId,
          message.attempt,
          message.codecs,
          message.sessionId,
          message.embyCapabilities,
        );
        ensureScheduledOperationActive();
      }
      return;
    }
    if (message.type === "media:ready" && message.viewerId) {
      const peer = outboundPeers.get(message.viewerId);
      if (
        peer &&
        (!message.sessionId ||
          !peer.sessionId ||
          message.sessionId === peer.sessionId)
      ) {
        peer.mediaReady = true;
        if (!peer.negotiatedVideoCodec && peer.mode === "screen") {
          try {
            const stats = await boundedRtcOperation(
              readOutboundVideoStats(peer.pc, peer.snapshot),
              `读取观看端 ${message.viewerId} 就绪统计超时`,
              RTC_STATS_TIMEOUT_MS,
            );
            ensureScheduledOperationActive();
            if (outboundPeers.get(message.viewerId) !== peer) return;
            peer.snapshot = stats.snapshot;
            peer.negotiatedVideoCodec = normalizeVideoCodecMime(stats.codec);
          } catch {
            // Readiness remains authoritative even if stats are unavailable.
          }
        }
        if (peer.negotiatedVideoCodec) {
          const failed = failedVideoCodecsByViewer.get(message.viewerId);
          failed?.delete(peer.negotiatedVideoCodec);
          if (failed?.size === 0) {
            failedVideoCodecsByViewer.delete(message.viewerId);
          }
        }
      }
      return;
    }
    if (message.type === "media:codec-failed" && message.viewerId) {
      const peer = outboundPeers.get(message.viewerId);
      if (!peer || peer.mode !== "screen" || peer.mediaReady) return;
      const failedCodec = matchingVideoCodecFailure({
        reportedSessionId: message.sessionId,
        reportedAttempt: message.attempt,
        reportedCodec: message.codec,
        peerSessionId: peer.sessionId,
        peerAttempt: peer.codecAttempt,
        negotiatedCodec: peer.negotiatedVideoCodec,
      });
      if (!failedCodec) return;
      const failed =
        failedVideoCodecsByViewer.get(message.viewerId) || new Set<string>();
      failed.add(failedCodec);
      failedVideoCodecsByViewer.set(message.viewerId, failed);
      window.roomDesktop?.reportDiagnostic("p2p-codec-deferred", {
        viewerId: message.viewerId,
        codec: failedCodec,
        failedCodecs: [...failed],
        attempt: message.attempt,
        sessionId: message.sessionId,
        evidence: "viewer-inbound-bytes-with-zero-decoded-frames",
      });
      return;
    }
    if (
      message.type === "media:audio-missing" &&
      message.viewerId &&
      broadcasterId === selfId &&
      localBroadcastMode === "screen"
    ) {
      const peer = outboundPeers.get(message.viewerId);
      if (
        !peer ||
        (message.sessionId &&
          peer.sessionId &&
          message.sessionId !== peer.sessionId)
      ) {
        return;
      }
      const liveAudioTrack = mediaStream
        ?.getAudioTracks()
        .find((track) => track.readyState === "live");
      window.roomDesktop?.reportDiagnostic("viewer-audio-track-missing", {
        viewerId: message.viewerId,
        sessionId: message.sessionId,
        captureActive: audioCapture?.active || false,
        liveAudioTrack: Boolean(liveAudioTrack),
      });
      if (!liveAudioTrack || !audioCapture?.active) {
        void recoverProcessAudioCapture(
          audioCapture,
          "观看端报告画面已到达但影片音轨缺失",
          audioCaptureEpoch,
        );
      } else {
        await createOfferForViewer(
          message.viewerId,
          peer.codecAttempt,
          [],
          peer.sessionId,
        );
        ensureScheduledOperationActive();
      }
      return;
    }
    if (
      message.type === "media:ice-restart" &&
      message.viewerId &&
      broadcasterId === selfId
    ) {
      await restartOutboundIce(
        message.viewerId,
        message.attempt,
        message.sessionId,
      );
      ensureScheduledOperationActive();
      return;
    }
    if (message.type === "viewer:left" && message.viewerId) {
      forgetDepartedViewer(message.viewerId);
      return;
    }
    if (message.type === "quality:request" && message.viewerId) {
      const preference = {
        height: message.height,
        frameRate: message.frameRate,
        originalDemand: message.originalDemand === true,
        highDemand: message.highDemand === true,
        lowDemand: message.lowDemand === true,
        availableDownloadBps: message.availableDownloadBps,
        renditionPolicy: message.renditionPolicy,
      };
      if (broadcastCapabilities?.mode === "emby") {
        scheduleEmbyViewerPreference(message.viewerId, preference);
        return;
      }
      receiverPreferences.set(message.viewerId, preference);
      const peer = outboundPeers.get(message.viewerId);
      if (peer && activePreset) {
        await applyOutboundPreference(message.viewerId, peer);
        ensureScheduledOperationActive();
      }
      return;
    }
    if (message.type === "signal" && message.data) {
      if (broadcasterId === selfId && message.from) {
        await handleOutboundSignal(
          message.from,
          message.data,
          message.attempt,
          message.sessionId,
        );
        ensureScheduledOperationActive();
      } else if (!broadcasterId) {
        queuePendingWatcherSignal(pendingWatcherSignals, {
          data: message.data,
          attempt: message.attempt,
          sessionId: message.sessionId,
        });
      } else {
        await handleWatcherSignal(
          message.data,
          message.attempt,
          message.sessionId,
        );
        ensureScheduledOperationActive();
      }
      return;
    }
    if (message.type === "error") {
      if (!joined) clearChannelJoinAckTimer();
      if (message.code === "channel-offline" && hasJoinedOnce && !leaving) {
        signalUnavailable = true;
        joined = false;
        setStatus("频道服务刚恢复 · 正在等待放映端重新上线", "neutral", true);
        scheduleSignalReconnect(false);
        return;
      }
      const messageText = String(
        message.message || "发生错误",
      ).slice(0, 200);
      if (
        message.code === "unsupported-operation" ||
        messageText === "不支持的操作"
      ) {
        // Old signaling services return this for optional network telemetry.
        // The WebSocket and room membership are still healthy, so presenting
        // it as a disconnect creates a needless reconnect loop.
        if (message.requestedType?.startsWith("network:")) {
          signalFeatures.delete("network-probe");
          signalFeatures.delete("network-report");
          signalFeatures.delete("network-advice");
        }
        if (awaitingBroadcastGrant) {
          await cleanupLocalBroadcast();
          ensureScheduledOperationActive();
          updateBroadcastControls();
          notify("当前信令服务版本较旧，不支持这项放映操作", "warn");
        }
        setSignalStatus("connected", "已连接 · 兼容模式");
        return;
      }
      if (
        message.code === "chat-rate-limit" ||
        message.code === "chat-invalid" ||
        messageText.includes("弹幕") ||
        messageText.includes("消息") ||
        messageText.includes("聊天")
      ) {
        notify(messageText, "warn");
        return;
      }
      if (awaitingBroadcastGrant) {
        await cleanupLocalBroadcast();
        ensureScheduledOperationActive();
        updateBroadcastControls();
      }
      setSignalStatus("lost", messageText, true);
      notify(messageText, "danger");
    }
  }

  async function leaveSession(): Promise<void> {
    if (leaving) return;
    leaving = true;
    resourceBudgetMonitor.destroy();
    signalMessageScheduler.close();
    videoEnhancement?.destroy();
    videoEnhancement = undefined;
    ambientLight?.destroy();
    ambientLight = undefined;
    dockMoreSurface?.destroy();
    dockMoreSurface = undefined;
    profileSurface?.destroy();
    profileSurface = undefined;
    connectionPresence?.cancel();
    embyDetailPresence?.cancel();
    if (connectionProgressDelay !== undefined) {
      window.clearTimeout(connectionProgressDelay);
      connectionProgressDelay = undefined;
    }
    hideEmbeddedGame();
    sessionUiAbortController.abort();
    networkProbeAbortController.abort();
    window.clearTimeout(dockHideTimer);
    updateNativePlaybackActivity(false);
    if (broadcasterId === selfId) {
      try {
        safeSignalSend({ type: "broadcast:stop" });
      } catch {
        // Ignore disconnect races.
      }
    }
    finishImmersiveUi();
    await exitImmersivePlayer().catch(() => undefined);
    if (isPictureInPictureActive()) {
      await document.exitPictureInPicture().catch(() => undefined);
    }
    pictureInPictureOwnsWindowMinimize = false;
    if (
      window.__syncedEnterMiniWindowForMinimize ===
      enterMiniWindowForMinimize
    ) {
      delete window.__syncedEnterMiniWindowForMinimize;
    }
    window.roomDesktop?.setMiniWindowEnabled(false);
    removeMainWindowRestoredListener?.();
    removeMainWindowRestoredListener = undefined;
    if (fullscreenChangeHandler) {
      document.removeEventListener("fullscreenchange", fullscreenChangeHandler);
    }
    await backButtonHandle?.remove();
    await networkChangeHandle?.remove();
    window.removeEventListener("online", handleBrowserOnline);
    window.removeEventListener("offline", handleBrowserOffline);
    document.removeEventListener(
      "visibilitychange",
      handleVisibilityRecovery,
    );
    document.removeEventListener("keydown", handleGlobalKey);
    video?.removeEventListener("timeupdate", updateEmbyViewerTimeline);
    video?.removeEventListener("durationchange", updateEmbyViewerTimeline);
    clearSignalReconnectTimer();
    clearChannelJoinAckTimer();
    if (segmentRelayRefreshTimer !== undefined) {
      window.clearTimeout(segmentRelayRefreshTimer);
      segmentRelayRefreshTimer = undefined;
    }
    segmentRelayAccess = undefined;
    if (networkChangeDebounceTimer !== undefined) {
      window.clearTimeout(networkChangeDebounceTimer);
      networkChangeDebounceTimer = undefined;
    }
    if (networkReportSendTimer !== undefined) {
      window.clearTimeout(networkReportSendTimer);
      networkReportSendTimer = undefined;
    }
    if (networkMembershipProbeTimer !== undefined) {
      window.clearTimeout(networkMembershipProbeTimer);
      networkMembershipProbeTimer = undefined;
    }
    if (networkAdviceExpiryTimer !== undefined) {
      window.clearTimeout(networkAdviceExpiryTimer);
      networkAdviceExpiryTimer = undefined;
    }
    if (fullscreenHintTimer !== undefined) {
      window.clearTimeout(fullscreenHintTimer);
      fullscreenHintTimer = undefined;
    }
    document.querySelector(".fullscreen-enter-hint")?.remove();
    dockChatPresence?.cancel();
    if (fullscreenViewportTimer !== undefined) {
      window.clearTimeout(fullscreenViewportTimer);
      fullscreenViewportTimer = undefined;
    }
    if (mobileGestureHudTimer !== undefined) {
      window.clearTimeout(mobileGestureHudTimer);
      mobileGestureHudTimer = undefined;
    }
    if (playbackControlFrame !== undefined) {
      window.cancelAnimationFrame(playbackControlFrame);
      playbackControlFrame = undefined;
    }
    if (desktopNetworkTimer !== undefined) {
      window.clearInterval(desktopNetworkTimer);
      desktopNetworkTimer = undefined;
    }
    desktopNetworkPollRunning = false;
    window.removeEventListener("resize", handleFullscreenViewportChange);
    screen.orientation?.removeEventListener(
      "change",
      handleFullscreenViewportChange,
    );
    clearWatchRetry();
    closeWatcher();
    stageDanmaku.clear();
    window.roomDesktop?.setDesktopDanmakuActive(false);
    await cleanupLocalBroadcast();
    await sfuSession.disconnect();
    sfuAccess = undefined;
    embyLogin = undefined;
    embySelectedItem = undefined;
    embyPlaybackInfo = undefined;
    embyVirtualGrid?.destroy();
    embyVirtualGrid = undefined;
    await musicController?.destroy();
    musicController = undefined;
    await companion?.destroy();
    signal?.close();
    const openDialogElement =
      document.querySelector<HTMLDialogElement>("dialog[open]");
    if (openDialogElement) {
      await dialogController.close(openDialogElement);
    }
    document
      .querySelectorAll(".command-palette, #keyboard-help-dialog")
      .forEach((element) => element.remove());
    document.body.classList.remove(
      "mode-lobby",
      "mode-theater",
      "mode-immersive",
      "is-lobby",
      "panel-collapsed",
      "panel-open",
      "panel-overlay",
      "panel-mobile-sheet",
      "panel-inline",
    );
    await options.onLeave();
  }

  bindEmbeddedGameRail(
    document.querySelector<HTMLElement>(".session-rail") ?? document,
  );
  if (desktop) {
    musicController = new ChannelMusicController({
      notify,
      getCompanion: () => companion,
      isProcessAudioBusy: () =>
        localBroadcastMode === "screen" &&
        (Boolean(audioCapture?.active) || preparingBroadcast),
      onSharedStateChange: (active) => {
        if (
          !safeSignalSend({
            type: "voice:music",
            active,
          }) &&
          active
        ) {
          notify("伴奏已在本机启动，但未能通知其他频道成员", "warn");
        }
      },
    });
    musicController.bind(
      document.querySelector<HTMLElement>(".session-rail") ?? document,
    );
  }
  const sessionProfile =
    document.querySelector<HTMLButtonElement>("#session-profile");
  const sessionProfileMenu =
    document.querySelector<HTMLElement>("#session-profile-menu");
  const sessionNicknameInput =
    document.querySelector<HTMLInputElement>("#session-nickname-input");
  if (sessionProfile && sessionProfileMenu) {
    profileSurface = new FloatingSurface(
      sessionProfile,
      sessionProfileMenu,
      {
        placement: "right-end",
        closeOnOutside: true,
      },
    );
    sessionProfile.addEventListener(
      "click",
      () => {
        hideEmbeddedGame();
        if (sessionNicknameInput) sessionNicknameInput.value = nickname;
        void profileSurface?.toggle();
      },
      { signal: sessionUiAbortController.signal },
    );
  }
  const saveSessionNickname = (): void => {
    const nextNickname = saveNickname(
      sessionNicknameInput?.value || nickname,
    );
    if (nextNickname === nickname) {
      void profileSurface?.close();
      return;
    }
    nickname = nextNickname;
    if (sessionProfile) {
      sessionProfile.textContent = Array.from(nickname)[0] || "友";
      sessionProfile.title = `${nickname} · 点击修改昵称`;
      sessionProfile.setAttribute(
        "aria-label",
        `修改昵称，当前昵称 ${nickname}`,
      );
    }
    safeSignalSend({ type: "participant:rename", nickname });
    notify(`昵称已改为 ${nickname}`);
    void profileSurface?.close();
  };
  document
    .querySelector("#save-session-nickname")
    ?.addEventListener("click", saveSessionNickname);
  sessionNicknameInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveSessionNickname();
  });
  document.addEventListener("keydown", handleGlobalKey);
  const panelToggle =
    document.querySelector<HTMLButtonElement>("#panel-toggle");
  const companionScrim =
    document.querySelector<HTMLButtonElement>("#companion-scrim");
  const companionPanel =
    document.querySelector<HTMLElement>(".room-sidebar.companion-panel");
  const companionSheetHandle =
    document.querySelector<HTMLElement>("#companion-sheet-handle");
  const overlayPanelQuery = window.matchMedia("(max-width: 1199px)");
  const mobileSheetQuery = window.matchMedia("(max-width: 599px)");
  const splitCompanionQuery = window.matchMedia(
    "(min-width: 768px) and (min-aspect-ratio: 4 / 3)",
  );
  let sheetPointerId: number | undefined;
  let sheetDragStartY = 0;
  let sheetDragLatestY = 0;
  let sheetDragStartedAt = 0;
  let sheetDragFrame = 0;
  const resetSheetDrag = (): void => {
    if (sheetDragFrame) {
      cancelAnimationFrame(sheetDragFrame);
      sheetDragFrame = 0;
    }
    sheetPointerId = undefined;
    sheetDragLatestY = 0;
    companionPanel?.classList.remove("is-sheet-dragging");
    companionPanel?.style.removeProperty("--sheet-drag-y");
  };
  const usesSplitCompanion = (): boolean =>
    splitCompanionQuery.matches;
  const usesOverlayCompanion = (): boolean =>
    !usesSplitCompanion() &&
    (nativeAndroid || overlayPanelQuery.matches);
  const usesMobileSheet = (): boolean =>
    !usesSplitCompanion() &&
    (nativeAndroid || mobileSheetQuery.matches);
  const applyPanelState = (
    collapsed: boolean,
    persist = true,
  ): void => {
    resetSheetDrag();
    if (!collapsed) {
      setDockChatComposerOpen(false);
    }
    document.body.classList.toggle(
      "panel-overlay",
      usesOverlayCompanion(),
    );
    document.body.classList.toggle(
      "panel-mobile-sheet",
      usesMobileSheet(),
    );
    document.body.classList.toggle(
      "panel-inline",
      !usesOverlayCompanion(),
    );
    if (panelToggle) panelToggle.hidden = false;
    document.body.classList.toggle("panel-collapsed", collapsed);
    document.body.classList.toggle("panel-open", !collapsed);
    if (companionScrim) {
      companionScrim.hidden = collapsed || !usesOverlayCompanion();
    }
    if (persist) {
      localStorage.setItem("synced:panel-collapsed", String(collapsed));
    }
    panelToggle?.setAttribute(
      "aria-label",
      collapsed ? "展开频道陪伴面板" : "收起频道陪伴面板",
    );
    panelToggle?.setAttribute(
      "title",
      collapsed ? "展开频道陪伴面板" : "收起频道陪伴面板",
    );
    if (panelToggle) {
      panelToggle.dataset.tooltip = collapsed
        ? "展开频道陪伴面板"
        : "收起频道陪伴面板";
    }
    panelToggle?.setAttribute("aria-expanded", String(!collapsed));
  };
  const savedPanelState =
    localStorage.getItem("synced:panel-collapsed");
  applyPanelState(
    savedPanelState === null
      ? usesOverlayCompanion()
      : savedPanelState === "true",
    false,
  );
  panelToggle?.addEventListener("click", () => {
    const collapsed =
      !document.body.classList.contains("panel-collapsed");
    applyPanelState(collapsed);
  });
  companionScrim?.addEventListener("click", () => {
    applyPanelState(true);
    document.getElementById("session-companion")?.focus();
  });
  overlayPanelQuery.addEventListener(
    "change",
    () => {
      const saved = localStorage.getItem("synced:panel-collapsed");
      applyPanelState(
        saved === null ? usesOverlayCompanion() : saved === "true",
        false,
      );
    },
    { signal: sessionUiAbortController.signal },
  );
  mobileSheetQuery.addEventListener(
    "change",
    () =>
      applyPanelState(
        document.body.classList.contains("panel-collapsed"),
        false,
    ),
    { signal: sessionUiAbortController.signal },
  );
  splitCompanionQuery.addEventListener(
    "change",
    () => {
      const saved = localStorage.getItem("synced:panel-collapsed");
      applyPanelState(
        saved === null ? usesOverlayCompanion() : saved === "true",
        false,
      );
    },
    { signal: sessionUiAbortController.signal },
  );
  companionSheetHandle?.addEventListener(
    "pointerdown",
    (event) => {
      if (
        !usesMobileSheet() ||
        document.body.classList.contains("panel-collapsed") ||
        !companionPanel
      ) {
        return;
      }
      event.preventDefault();
      sheetPointerId = event.pointerId;
      sheetDragStartY = event.clientY;
      sheetDragLatestY = 0;
      sheetDragStartedAt = performance.now();
      companionPanel.classList.add("is-sheet-dragging");
      companionSheetHandle.setPointerCapture?.(event.pointerId);
    },
    { signal: sessionUiAbortController.signal },
  );
  companionSheetHandle?.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerId !== sheetPointerId || !companionPanel) return;
      sheetDragLatestY = Math.max(0, event.clientY - sheetDragStartY);
      if (sheetDragFrame) return;
      sheetDragFrame = requestAnimationFrame(() => {
        sheetDragFrame = 0;
        companionPanel.style.setProperty(
          "--sheet-drag-y",
          `${Math.round(sheetDragLatestY)}px`,
        );
      });
    },
    { signal: sessionUiAbortController.signal },
  );
  const finishSheetDrag = (event: PointerEvent): void => {
    if (event.pointerId !== sheetPointerId || !companionPanel) return;
    const elapsed = Math.max(1, performance.now() - sheetDragStartedAt);
    const velocity = sheetDragLatestY / elapsed;
    const shouldClose =
      sheetDragLatestY > Math.min(180, companionPanel.clientHeight * 0.24) ||
      velocity > 0.68;
    resetSheetDrag();
    if (shouldClose) {
      applyPanelState(true);
      document.getElementById("session-companion")?.focus();
    }
  };
  companionSheetHandle?.addEventListener(
    "pointerup",
    finishSheetDrag,
    { signal: sessionUiAbortController.signal },
  );
  companionSheetHandle?.addEventListener(
    "pointercancel",
    (event) => {
      if (event.pointerId === sheetPointerId) resetSheetDrag();
    },
    { signal: sessionUiAbortController.signal },
  );
  window.addEventListener("resize", resetSheetDrag, {
    passive: true,
    signal: sessionUiAbortController.signal,
  });
  document
    .querySelector("#session-companion")
    ?.addEventListener("click", () => focusCompanion("chat"));
  document
    .querySelector("#dock-play")
    ?.addEventListener("click", handlePlayPause);
  document
    .querySelector("#dock-rewind")
    ?.addEventListener("click", () => seekRelative(-10));
  document
    .querySelector("#dock-forward")
    ?.addEventListener("click", () => seekRelative(10));
  document
    .querySelector("#dock-mute")
    ?.addEventListener("click", toggleMute);
  document
    .querySelector("#dock-danmaku")
    ?.addEventListener("click", toggleDanmaku);
  document
    .querySelector("#dock-smart-crop")
    ?.addEventListener("click", () => {
      fullscreenFit = fullscreenFit === "smart" ? "contain" : "smart";
      localStorage.setItem("synced:fullscreen-fit", fullscreenFit);
      updateFullscreenFitUi();
      void resolveFullscreenFit();
      videoEnhancement?.refresh();
      const btn = document.getElementById("dock-smart-crop");
      btn?.classList.toggle("is-on", fullscreenFit === "smart");
      btn?.setAttribute("aria-checked", String(fullscreenFit === "smart"));
      btn?.setAttribute("aria-label", fullscreenFit === "smart" ? "关闭智能裁剪" : "开启智能裁剪");
    });
  document
    .querySelector("#dock-highlight")
    ?.addEventListener("click", () => {
      if (!highlightCorrectionInput) return;
      highlightCorrectionInput.checked = !highlightCorrectionInput.checked;
      highlightCorrectionInput.dispatchEvent(
        new Event("change", { bubbles: true }),
      );
    });
  document
    .querySelector("#dock-enhancement")
    ?.addEventListener("click", () => {
      if (!videoEnhancementInput || videoEnhancementInput.disabled) {
        notify("当前设备暂不支持视频增强", "warn");
        return;
      }
      videoEnhancementInput.checked = !videoEnhancementInput.checked;
      videoEnhancementInput.dispatchEvent(
        new Event("change", { bubbles: true }),
      );
    });
  const openPlaybackDiagnostics = (
    section: "stats" | "route",
  ): void => {
    if (!playbackDiagnosticsDialog) return;
    const title = document.getElementById("playback-diagnostics-title");
    if (title) {
      title.textContent =
        section === "stats" ? "播放统计信息" : "线路诊断";
    }
    const signalRoute =
      document.getElementById("diagnostic-signal-route");
    if (signalRoute) {
      signalRoute.textContent = signalUnavailable ? "正在重连" : "连接正常";
    }
    const mediaRoute =
      document.getElementById("diagnostic-media-route");
    if (mediaRoute) {
      mediaRoute.textContent =
        !broadcasterId
          ? "等待放映"
          : broadcastCapabilities?.mode === "emby" &&
              signalFeatures.has("emby-segment-relay-v1")
            ? "HTTPS CMAF 独立 ABR"
            : sfuViewerActive || broadcasterId === selfId
              ? "服务器 SFU"
              : "P2P 备用链路";
    }
    const advice =
      document.getElementById("diagnostic-network-advice");
    if (advice) {
      advice.textContent =
        `${networkRouteLabel(networkAdvice.routeMode)} · ` +
        networkAdvice.reason;
    }
    playbackDiagnosticsDialog.dataset.section = section;
    void dockMoreSurface?.close();
    openDialog(playbackDiagnosticsDialog);
  };
  document
    .querySelector("#dock-stats")
    ?.addEventListener("click", () => openPlaybackDiagnostics("stats"));
  document
    .querySelector("#dock-diagnostics")
    ?.addEventListener("click", () => openPlaybackDiagnostics("route"));
  document
    .querySelector("#dock-shortcuts")
    ?.addEventListener("click", () => {
      void dockMoreSurface?.close();
      showKeyboardHelp();
    });
  document
    .querySelector("[data-close-playback-diagnostics]")
    ?.addEventListener("click", () => {
      if (playbackDiagnosticsDialog) {
        closeDialog(playbackDiagnosticsDialog);
      }
    });
  document
    .querySelector("#dock-chat")
    ?.addEventListener("click", () => toggleDockChatComposer());
  dockChatComposer?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = dockChatInput?.value.trim() || "";
    if (!text) return;
    const sender = companion as
      | (RoomCompanion & { sendChat?: (rawText: string) => boolean })
      | undefined;
    let sent = false;
    if (sender?.sendChat) {
      sent = sender.sendChat(text);
    } else {
      sent = safeSignalSend({
        type: "chat:send",
        text: text.slice(0, 120),
      });
      if (!sent) {
        notify("弹幕发送失败，服务器连接可能已断开", true);
      }
    }
    if (!sent) return;
    if (dockChatInput) dockChatInput.value = "";
    setDockChatComposerOpen(false);
  });
  document
    .querySelector("#dock-chat-close")
    ?.addEventListener("click", () => {
      setDockChatComposerOpen(false, true);
    });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!dockChatComposer || dockChatComposer.hidden) return;
      const target = event.target;
      if (
        target instanceof Node &&
        !dockChatComposer.contains(target) &&
        !dockChatButton?.contains(target)
      ) {
        setDockChatComposerOpen(false);
      }
    },
    { signal: sessionUiAbortController.signal },
  );
  document
    .querySelector("#dock-fullscreen")
    ?.addEventListener("click", toggleFullscreen);
  document
    .querySelector("#dock-pip")
    ?.addEventListener("click", () => {
      void setMiniWindowPreference(!miniWindowEnabled);
    });
  document.getElementById("dock-danmaku")?.classList.toggle(
    "is-on",
    danmakuEnabled,
  );
  document
    .getElementById("dock-danmaku")
    ?.setAttribute("aria-pressed", String(danmakuEnabled));
  playerStage?.addEventListener(
    "wheel",
    (event) => {
      if (!broadcasterId || nativeAndroid) return;
      event.preventDefault();
      adjustVolume(event.deltaY < 0 ? 0.05 : -0.05);
    },
    { passive: false },
  );
  const progressRatioAt = (clientX: number): number => {
    if (!stageProgress) return 0;
    const bounds = stageProgress.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(1, (clientX - bounds.left) / Math.max(1, bounds.width)),
    );
  };
  const renderProgressScrub = (ratio: number): void => {
    progressScrubRatio = Math.max(0, Math.min(1, ratio));
    const duration = playbackDuration();
    const percent = progressScrubRatio * 100;
    if (progressTooltip) {
      progressTooltip.textContent =
        duration > 0
          ? formatPlaybackTime(duration * progressScrubRatio)
          : "--:--";
      progressTooltip.style.left = `${percent.toFixed(2)}%`;
      progressTooltip.hidden = false;
    }
    if (progressScrubPointerId === undefined) return;
    if (progressFill) progressFill.style.width = `${percent.toFixed(2)}%`;
    if (progressThumb) progressThumb.style.left = `${percent.toFixed(2)}%`;
    stageProgress?.setAttribute("aria-valuenow", percent.toFixed(1));
    stageProgress?.setAttribute(
      "aria-valuetext",
      duration > 0
        ? `${formatPlaybackTime(duration * progressScrubRatio)} / ${formatPlaybackTime(duration)}`
        : "--:--",
    );
    if (dockTime && duration > 0) {
      dockTime.textContent =
        `${formatPlaybackTime(duration * progressScrubRatio)} / ${formatPlaybackTime(duration)}`;
    }
  };
  const finishProgressScrub = (
    event: PointerEvent,
    commit: boolean,
  ): void => {
    if (
      !stageProgress ||
      progressScrubPointerId === undefined ||
      event.pointerId !== progressScrubPointerId
    ) {
      return;
    }
    const pointerId = progressScrubPointerId;
    if (stageProgress.hasPointerCapture?.(pointerId)) {
      stageProgress.releasePointerCapture(pointerId);
    }
    progressScrubPointerId = undefined;
    if (commit) {
      suppressProgressClick = true;
      seekToPercent(progressScrubRatio * 100);
      window.setTimeout(() => {
        suppressProgressClick = false;
      }, 0);
    } else {
      updateEmbyViewerTimeline();
    }
    if (progressTooltip) progressTooltip.hidden = true;
  };
  stageProgress?.addEventListener("pointerdown", (event) => {
    if (!hostCanSeekEmby() || event.button !== 0) return;
    event.preventDefault();
    progressScrubPointerId = event.pointerId;
    stageProgress.setPointerCapture?.(event.pointerId);
    renderProgressScrub(progressRatioAt(event.clientX));
  });
  stageProgress?.addEventListener("pointermove", (event) => {
    if (
      progressScrubPointerId !== undefined &&
      event.pointerId !== progressScrubPointerId
    ) {
      return;
    }
    renderProgressScrub(progressRatioAt(event.clientX));
  });
  stageProgress?.addEventListener("pointerleave", () => {
    if (
      progressScrubPointerId === undefined &&
      progressTooltip
    ) {
      progressTooltip.hidden = true;
    }
  });
  stageProgress?.addEventListener("pointerup", (event) => {
    finishProgressScrub(event, true);
  });
  stageProgress?.addEventListener("pointercancel", (event) => {
    finishProgressScrub(event, false);
  });
  stageProgress?.addEventListener("click", (event) => {
    if (suppressProgressClick) return;
    if (!hostCanSeekEmby()) {
      notify("播放进度由放映端统一控制", "info");
      return;
    }
    seekToPercent(progressRatioAt(event.clientX) * 100);
  });
  stageProgress?.addEventListener("keydown", (event) => {
    if (!hostCanSeekEmby()) return;
    let nextPercent = Number(stageProgress.getAttribute("aria-valuenow")) || 0;
    if (event.key === "Home") nextPercent = 0;
    else if (event.key === "End") nextPercent = 100;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      nextPercent -= 2;
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      nextPercent += 2;
    } else if (event.key === "PageDown") nextPercent -= 10;
    else if (event.key === "PageUp") nextPercent += 10;
    else return;
    event.preventDefault();
    event.stopPropagation();
    seekToPercent(Math.max(0, Math.min(100, nextPercent)));
  });
  video?.addEventListener("play", updateDockPlaybackState);
  video?.addEventListener("pause", updateDockPlaybackState);
  video?.addEventListener("volumechange", updateDockPlaybackState);
  video?.addEventListener("timeupdate", updateEmbyViewerTimeline);
  video?.addEventListener("durationchange", updateEmbyViewerTimeline);
  document
    .querySelector("#leave-room")
    ?.addEventListener("click", () => void leaveSession());
  const showInviteDialog = (): void => {
    const dialog =
      document.querySelector<HTMLDialogElement>("#invite-dialog");
    if (dialog) openDialog(dialog);
  };
  document
    .querySelector("#session-invite")
    ?.addEventListener("click", showInviteDialog);
  document
    .querySelector("#lobby-invite")
    ?.addEventListener("click", showInviteDialog);
  document
    .querySelector("#lobby-copy-room")
    ?.addEventListener("click", () => {
      document.getElementById("copy-room")?.click();
    });
  document
    .querySelector("#cancel-session-connection")
    ?.addEventListener("click", () => void leaveSession());
  options.operationSignal?.addEventListener(
    "abort",
    () => void leaveSession(),
    { once: true, signal: sessionUiAbortController.signal },
  );
  document
    .querySelector("[data-close-invite]")
    ?.addEventListener("click", () => {
      const dialog =
        document.querySelector<HTMLDialogElement>("#invite-dialog");
      if (dialog) closeDialog(dialog);
    });
  document.querySelector("#copy-room")?.addEventListener("click", async () => {
    const button = document.querySelector<HTMLButtonElement>("#copy-room");
    const hint = document.querySelector<HTMLElement>("#copy-room small");
    try {
      await copyText(room);
      if (hint) hint.textContent = "已复制到剪贴板";
      if (button) button.dataset.copied = "true";
      notify("频道码已复制");
      window.setTimeout(() => {
        if (hint?.isConnected) hint.textContent = "点击复制";
        if (button?.isConnected) delete button.dataset.copied;
      }, 2_400);
    } catch (error) {
      if (hint) hint.textContent = "复制失败，请重试";
      notify(error instanceof Error ? error.message : "复制失败", true);
    }
  });
  const joinLink = buildJoinLink(room, signalUrl);
  const inviteQr = document.querySelector<HTMLImageElement>("#invite-qr");
  if (inviteQr) {
    const rootStyle = getComputedStyle(document.documentElement);
    const dark = rootStyle.getPropertyValue("--n-850").trim();
    const light = rootStyle.getPropertyValue("--n-000").trim();
    void import("qrcode")
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(joinLink, {
          width: 220,
          margin: 1,
          color: { dark, light },
        }),
      )
      .then((url) => {
        if (inviteQr.isConnected) inviteQr.src = url;
      })
      .catch(() => {
        if (inviteQr.isConnected) {
          inviteQr.alt = "二维码生成失败，请复制频道码";
        }
      });
  }
  document.querySelector("#copy-invite")?.addEventListener("click", async () => {
    try {
      await copyText(
        `${channelName}\n频道码：${room}\n打开“同频”后扫码或输入频道码加入`,
      );
      notify("邀请信息已复制");
    } catch (error) {
      notify(error instanceof Error ? error.message : "复制失败", true);
    }
  });
  const shareInvite =
    document.querySelector<HTMLButtonElement>("#share-invite");
  if (shareInvite && typeof navigator.share !== "function") {
    shareInvite.hidden = true;
  }
  shareInvite?.addEventListener("click", async () => {
    try {
      await navigator.share({
        title: channelName,
        text: `加入“${channelName}”，频道码 ${room}`,
        url: joinLink,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      notify(error instanceof Error ? error.message : "系统分享失败", true);
    }
  });
  document
    .querySelector("#enter-created-room")
    ?.addEventListener("click", () => {
      const dialog =
        document.querySelector<HTMLDialogElement>("#invite-dialog");
      if (dialog) closeDialog(dialog);
    });
  pictureSettingsButton?.addEventListener("click", () => {
    if (pictureDialog) openDialog(pictureDialog);
  });
  document
    .querySelector("[data-close-picture]")
    ?.addEventListener("click", () => {
      if (pictureDialog) closeDialog(pictureDialog);
    });
  embySettingsButton?.addEventListener("click", () => {
    if (!embySettingsDialog || !embyBroadcast?.active) return;
    // Populate selects from current embyPlaybackInfo
    const liveAudio = embySettingsDialog.querySelector<HTMLSelectElement>("#emby-live-audio");
    const liveSub = embySettingsDialog.querySelector<HTMLSelectElement>("#emby-live-subtitle");
    const liveQuality = embySettingsDialog.querySelector<HTMLSelectElement>("#emby-live-quality");
    const liveFrameRate = embySettingsDialog.querySelector<HTMLSelectElement>("#emby-live-frame-rate");
    const source = embyPlaybackInfo?.mediaSources.find(
      (s) => s.id === embyBroadcast?.currentRequest?.mediaSourceId,
    ) ?? embyPlaybackInfo?.mediaSources[0];
    if (liveAudio && source) {
      const currentAudio = embyBroadcast?.currentRequest?.audioStreamIndex;
      liveAudio.innerHTML = source.streams
        .filter((s) => s.type === "Audio")
        .map((s) => `<option value="${s.index}" ${s.index === currentAudio ? "selected" : ""}>${
          escapeHtml(
            [s.title, s.language, s.codec?.toUpperCase(), s.channels ? `${s.channels} ch` : ""]
              .filter(Boolean).join(" · "),
          )
        }</option>`)
        .join("");
    }
    if (liveSub && source) {
      const currentSub = embyBroadcast?.currentRequest?.subtitleStreamIndex;
      liveSub.innerHTML = `<option value="" ${currentSub === undefined ? "selected" : ""}>无字幕</option>` +
        source.streams
          .filter((s) => s.type === "Subtitle")
          .map((s) => `<option value="${s.index}" ${s.index === currentSub ? "selected" : ""}>${
            escapeHtml(
              [s.title, s.language, s.codec?.toUpperCase()]
                .filter(Boolean).join(" · "),
            )
          }</option>`)
          .join("");
    }
    if (liveQuality) {
      liveQuality.value =
        document.querySelector<HTMLSelectElement>("#emby-quality")?.value ||
        embyBroadcast?.currentRequest?.quality ||
        "auto";
    }
    if (liveFrameRate) {
      liveFrameRate.value = String(
        embyBroadcast?.currentRequest?.frameRate || embyFrameRate,
      );
    }
    const summary = embySettingsDialog.querySelector<HTMLElement>("#emby-settings-summary");
    if (summary && embyBroadcast?.streamPlan) {
      const p = embyBroadcast.streamPlan;
      summary.textContent = `${p.width}×${p.height} · ${p.videoCodec?.toUpperCase()} / ${p.audioCodec?.toUpperCase()}`;
    }
    openDialog(embySettingsDialog);
  });
  embySettingsDialog?.querySelector("[data-close-emby-settings]")
    ?.addEventListener("click", () => {
      if (embySettingsDialog) closeDialog(embySettingsDialog);
    });
  embySettingsDialog?.querySelector<HTMLSelectElement>("#emby-live-quality")
    ?.addEventListener("change", (event) => {
      const selected = (event.target as HTMLSelectElement).value as
        | EmbyPlaybackRequest["quality"]
        | "auto";
      const value = budgetSafeQuality(
        selected,
        embyBroadcast?.currentRequest?.allowHevc === true,
      );
      const launchQuality =
        document.querySelector<HTMLSelectElement>("#emby-quality");
      if (launchQuality) launchQuality.value = selected;
      embyPressureQualityByViewer.clear();
      embyPressureQualityCooldownUntil = 0;
      if (embyPressureRecoveryTimer !== undefined) {
        window.clearTimeout(embyPressureRecoveryTimer);
        embyPressureRecoveryTimer = undefined;
      }
      void embyBroadcast?.setQuality(value, "手动切换画质");
    });
  embySettingsDialog?.querySelector<HTMLSelectElement>("#emby-live-frame-rate")
    ?.addEventListener("change", (event) => {
      embyFrameRate = normalizeEmbyFrameRate(
        (event.target as HTMLSelectElement).value,
      );
      localStorage.setItem(
        "synced:emby-frame-rate",
        String(embyFrameRate),
      );
      const launchFrameRate =
        document.querySelector<HTMLSelectElement>("#emby-frame-rate");
      if (launchFrameRate) launchFrameRate.value = String(embyFrameRate);
      void embyBroadcast?.setFrameRate(embyFrameRate, "手动切换帧率");
    });
  embySettingsDialog?.querySelector<HTMLSelectElement>("#emby-live-audio")
    ?.addEventListener("change", (event) => {
      const index = Number((event.target as HTMLSelectElement).value);
      void embyBroadcast?.setAudioTrack(index);
    });
  embySettingsDialog?.querySelector<HTMLSelectElement>("#emby-live-subtitle")
    ?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value;
      void embyBroadcast?.setSubtitleTrack(value === "" ? undefined : Number(value));
      if (embySettingsDialog) closeDialog(embySettingsDialog);
    });
  // Emby item popup: close + start handlers
  document
    .querySelector("[data-close-emby-popup]")
    ?.addEventListener("click", () => {
      hideEmbyItemPopup();
    });
  document
    .querySelector<HTMLButtonElement>("#emby-start-from-popup")
    ?.addEventListener("click", () => {
      void prepareEmbyBroadcast();
    });
  document
    .querySelectorAll<HTMLButtonElement>("[data-fit-mode]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        fullscreenFit =
          button.dataset.fitMode === "contain"
            ? "contain"
            : button.dataset.fitMode === "cover"
              ? "cover"
              : "smart";
        localStorage.setItem("synced:fullscreen-fit", fullscreenFit);
        updateFullscreenFitUi();
        void resolveFullscreenFit();
        videoEnhancement?.refresh();
      });
    });
  highlightCorrectionInput?.addEventListener("change", () => {
    highlightCorrection = highlightCorrectionInput.checked;
    localStorage.setItem(
      "synced:highlight-correction",
      String(highlightCorrection),
    );
    applyHighlightCorrection();
    const item = document.querySelector<HTMLElement>("#dock-highlight");
    item?.setAttribute("aria-checked", String(highlightCorrection));
    const state = item?.querySelector("small");
    if (state) state.textContent = highlightCorrection ? "已开启" : "已关闭";
  });
  videoEnhancementInput?.addEventListener("change", () => {
    videoEnhancementPreference = videoEnhancementInput.checked
      ? "auto"
      : "off";
    localStorage.setItem(
      "synced:video-enhancement",
      videoEnhancementPreference,
    );
    videoEnhancement?.setPreference(videoEnhancementPreference);
    syncVideoEnhancement();
    const item = document.querySelector<HTMLElement>("#dock-enhancement");
    item?.setAttribute(
      "aria-checked",
      String(videoEnhancementPreference !== "off"),
    );
    const state = item?.querySelector("small");
    if (state) {
      state.textContent =
        videoEnhancementPreference === "off" ? "已关闭" : "自动";
    }
  });
  const requestBroadcast = (): void => {
    if (broadcasterId === selfId) {
      void stopBroadcast();
    } else if (!broadcasterId) {
      void openBroadcastDialog();
    }
  };
  broadcastButton?.addEventListener("click", requestBroadcast);
  stageStartButton?.addEventListener("click", requestBroadcast);
  document
    .querySelector("[data-close-broadcast]")
    ?.addEventListener("click", () => {
      const password =
        document.querySelector<HTMLInputElement>("#emby-password");
      if (password) password.value = "";
      const dialog =
        document.querySelector<HTMLDialogElement>("#broadcast-dialog");
      if (dialog) closeBroadcastDialog();
    });
  document
    .querySelector("#refresh-session-sources")
    ?.addEventListener("click", () => void loadBroadcastSources());
  document
    .querySelectorAll<HTMLButtonElement>("[data-source-filter]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        sourceFilter =
          button.dataset.sourceFilter === "recent" ||
          button.dataset.sourceFilter === "player" ||
          button.dataset.sourceFilter === "browser"
            ? button.dataset.sourceFilter
            : "all";
        document
          .querySelectorAll<HTMLButtonElement>("[data-source-filter]")
          .forEach((candidate) => {
            candidate.setAttribute(
              "aria-pressed",
              String(candidate.dataset.sourceFilter === sourceFilter),
            );
          });
        renderBroadcastSources();
      });
    });
  document
    .querySelector("#cancel-screen-broadcast")
    ?.addEventListener("click", closeBroadcastDialog);
  document
    .querySelector("#start-screen-broadcast")
    ?.addEventListener("click", async () => {
      if (preparingBroadcast || !selectedBroadcastSourceId) return;
      const source = broadcastSources.find(
        (candidate) => candidate.id === selectedBroadcastSourceId,
      );
      if (!source) {
        selectedBroadcastSourceId = "";
        renderBroadcastSources();
        notify("所选窗口已经关闭，请重新选择", "warn");
        return;
      }
      const start =
        document.querySelector<HTMLButtonElement>("#start-screen-broadcast");
      if (start) {
        start.disabled = true;
        start.setAttribute("aria-busy", "true");
        const label = document.getElementById(
          "start-screen-broadcast-label",
        );
        if (label) label.textContent = "正在启动…";
      }
      closeBroadcastDialog();
      await prepareLocalBroadcast(source.id);
      if (mediaStream) {
        rememberCaptureSource(source);
      }
      if (start?.isConnected) {
        start.removeAttribute("aria-busy");
        const label = document.getElementById(
          "start-screen-broadcast-label",
        );
        if (label) label.textContent = "开始放映";
      }
      updateSelectedSourceSummary();
    });
  document
    .querySelectorAll<HTMLButtonElement>("[data-broadcast-mode]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        switchBroadcastMode(
          button.dataset.broadcastMode === "emby" ? "emby" : "screen",
        );
      });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          return;
        }
        event.preventDefault();
        const tabs = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            "[data-broadcast-mode]",
          ),
        );
        const current = tabs.indexOf(button);
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : (current +
                  (event.key === "ArrowRight" ? 1 : -1) +
                  tabs.length) %
                tabs.length;
        tabs[nextIndex]?.click();
        tabs[nextIndex]?.focus();
      });
    });
  bindEndpointEditor("login");
  bindEndpointEditor("manage");
  document
    .querySelector<HTMLFormElement>("#emby-login-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      void loginEmby();
    });
  document
    .querySelector("#emby-logout")
    ?.addEventListener("click", () => void logoutEmby());
  document
    .querySelector<HTMLSelectElement>("#emby-account-switch")
    ?.addEventListener("change", (event) => {
      const accountId = (event.currentTarget as HTMLSelectElement).value;
      if (accountId && accountId !== embyActiveAccountId) {
        void activateEmbyAccount(accountId);
      }
    });
  document
    .querySelector("#emby-add-account")
    ?.addEventListener("click", beginAddingEmbyAccount);
  document
    .querySelector("#emby-manage-endpoints")
    ?.addEventListener("click", openEmbyEndpointManager);
  document
    .querySelector("[data-close-emby-endpoints]")
    ?.addEventListener("click", () => {
      const dialog =
        document.querySelector<HTMLDialogElement>("#emby-endpoint-dialog");
      if (dialog?.open) closeDialog(dialog);
    });
  document
    .querySelector("#emby-save-endpoints")
    ?.addEventListener("click", () => void saveEmbyEndpoints());
  document
    .querySelector("#emby-refresh-library")
    ?.addEventListener("click", () => void loadEmbyItems());
  document
    .querySelector<HTMLSelectElement>("#emby-library-select")
    ?.addEventListener("change", () => void loadEmbyItems());
  document
    .querySelectorAll<HTMLButtonElement>("[data-emby-nav-mode]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.embyNavMode || "all";
        const filter =
          document.querySelector<HTMLSelectElement>("#emby-browse-filter");
        if (filter) filter.value = mode;
        document
          .querySelectorAll<HTMLButtonElement>("[data-emby-nav-mode]")
          .forEach((candidate) => {
            if (candidate === button) {
              candidate.setAttribute("aria-current", "page");
              candidate.tabIndex = 0;
            } else {
              candidate.removeAttribute("aria-current");
              candidate.tabIndex = -1;
            }
          });
        const title = document.getElementById("emby-content-title");
        if (title) {
          title.textContent =
            mode === "resume"
              ? "继续观看"
              : mode === "movies"
                ? "电影"
                : mode === "episodes"
                  ? "剧集"
                  : mode === "favorite"
                    ? "收藏"
                    : mode === "latest"
                      ? "最近添加"
                      : "媒体首页";
        }
        void loadEmbyItems();
      });
      button.addEventListener("keydown", (event) => {
        if (
          ![
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
          ].includes(event.key)
        ) {
          return;
        }
        event.preventDefault();
        const items = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            "[data-emby-nav-mode]",
          ),
        );
        const current = items.indexOf(button);
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current +
                  (["ArrowDown", "ArrowRight"].includes(event.key)
                    ? 1
                    : -1) +
                  items.length) %
                items.length;
        items[nextIndex]?.click();
        items[nextIndex]?.focus();
      });
    });
  document
    .querySelector("#emby-open-settings")
    ?.addEventListener("click", () => {
      closeBroadcastDialog();
      document.dispatchEvent(
        new CustomEvent("synced:open-settings", { detail: "emby" }),
      );
    });
  document
    .querySelector<HTMLSelectElement>("#emby-browse-filter")
    ?.addEventListener("change", () => void loadEmbyItems());
  document
    .querySelector("#emby-load-more")
    ?.addEventListener("click", () => void loadEmbyItems(false));
  let embySearchTimer: number | undefined;
  document
    .querySelector<HTMLInputElement>("#emby-search-input")
    ?.addEventListener("input", () => {
      if (embySearchTimer !== undefined) window.clearTimeout(embySearchTimer);
      embySearchTimer = window.setTimeout(() => {
        embySearchTimer = undefined;
        void loadEmbyItems();
      }, 350);
    });
  document
    .querySelector<HTMLSelectElement>("#emby-media-source")
    ?.addEventListener("change", updateEmbySourceUi);
  document
    .querySelector<HTMLSelectElement>("#emby-quality")
    ?.addEventListener("change", updateEmbyBudget);
  document
    .querySelector<HTMLSelectElement>("#emby-frame-rate")
    ?.addEventListener("change", (event) => {
      embyFrameRate = normalizeEmbyFrameRate(
        (event.currentTarget as HTMLSelectElement).value,
      );
      localStorage.setItem(
        "synced:emby-frame-rate",
        String(embyFrameRate),
      );
    });
  document
    .querySelector<HTMLInputElement>("#session-source-search")
    ?.addEventListener("input", renderBroadcastSources);
  document
    .querySelectorAll<HTMLButtonElement>("[data-session-resolution]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        qualitySelectionTouched = true;
        const selected = selectResolutionAndFrameRate({
          resolution: button.dataset.sessionResolution as ResolutionKey,
          resolutionLockedByUser: true,
          currentFrameRate: frameRate,
          frameRateLockedByUser,
          advice: networkAdvice,
        });
        resolutionKey = selected.resolution;
        frameRate = selected.frameRate;
        localStorage.setItem("synced:resolution", resolutionKey);
        localStorage.setItem("synced:frame-rate", String(frameRate));
        syncBroadcastQualityUi();
      });
    });
  document
    .querySelectorAll<HTMLButtonElement>("[data-session-frame-rate]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        qualitySelectionTouched = true;
        frameRateLockedByUser = true;
        frameRate = Number(button.dataset.sessionFrameRate) as FrameRateOption;
        localStorage.setItem("synced:frame-rate", String(frameRate));
        syncBroadcastQualityUi();
      });
    });
  document
    .querySelectorAll<HTMLButtonElement>("[data-screen-content-mode]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const value = button.dataset.screenContentMode;
        if (
          value !== "detail" &&
          value !== "motion" &&
          value !== "balanced"
        ) {
          return;
        }
        screenContentMode = value;
        qualitySelectionTouched = true;
        localStorage.setItem("synced:screen-content-mode", value);
        syncBroadcastQualityUi();
      });
    });

  soundButton?.addEventListener("click", async () => {
    if (!video) return;
    try {
      if (movieVolume <= 0) {
        applyMovieVolume(Math.max(0.05, lastAudibleMovieVolume));
      }
      if (
        nativeAndroid &&
        broadcasterId !== selfId &&
        broadcastCapabilities?.mode !== "emby"
      ) {
        soundEnabled = true;
        const playing = await playNativeMovieAudio(true);
        if (!playing) {
          throw new Error("Android movie audio did not enter playing state");
        }
        soundButton.hidden = true;
        notify("影片声音已开启");
        return;
      }
      video.muted = false;
      video.volume = movieVolume;
      await video.play();
      soundEnabled = true;
      soundButton.hidden = true;
      notify("影片声音已开启");
    } catch {
      video.muted = true;
      soundEnabled = false;
      notify("系统暂未允许自动播放声音，请再点击一次", true);
    }
  });
  const recoverNativeMovieAudio = (): void => {
    if (
      !nativeAndroid ||
      !movieAudio?.srcObject ||
      movieVolume <= 0 ||
      broadcasterId === selfId ||
      broadcastCapabilities?.mode === "emby"
    ) {
      return;
    }
    const now = Date.now();
    if (now - lastNativeMovieAudioRestartAt < 700) return;
    lastNativeMovieAudioRestartAt = now;
    window.setTimeout(() => {
      if (movieAudio.srcObject && movieVolume > 0) {
        void playNativeMovieAudio(true);
      }
    }, 120);
  };
  for (const eventName of ["error", "stalled", "pause"]) {
    movieAudio?.addEventListener(eventName, recoverNativeMovieAudio, {
      signal: sessionUiAbortController.signal,
    });
  }
  document.addEventListener(
    "pointerdown",
    () => {
      if (nativeMovieAudioNeedsGesture) void playNativeMovieAudio(true);
    },
    {
      capture: true,
      signal: sessionUiAbortController.signal,
    },
  );
  movieVolumeInput?.addEventListener("input", () => {
    const value = Math.max(
      0,
      Math.min(1, Number(movieVolumeInput.value)),
    );
    if (hostControlsEmby() && video) {
      video.volume = value;
      video.muted = value === 0;
      if (movieVolumeValue) {
        movieVolumeValue.value = `${Math.round(value * 100)}%`;
      }
    } else {
      applyMovieVolume(value);
    }
    updateDockPlaybackState();
  });
  video?.addEventListener("enterpictureinpicture", () => {
    updatePictureInPictureButton();
    notify("已进入小窗模式，恢复主窗口后会自动收起");
  });
  video?.addEventListener("leavepictureinpicture", () => {
    updatePictureInPictureButton();
    const shouldRestoreMainWindow = pictureInPictureOwnsWindowMinimize;
    pictureInPictureOwnsWindowMinimize = false;
    if (shouldRestoreMainWindow && !leaving) {
      void window.roomDesktop?.restoreFromPictureInPicture();
    }
  });
  removeMainWindowRestoredListener =
    window.roomDesktop?.onMainWindowRestored(() => {
      if (!isPictureInPictureActive()) return;
      pictureInPictureOwnsWindowMinimize = false;
      void document.exitPictureInPicture().catch(() => undefined);
    });
  window.__syncedEnterMiniWindowForMinimize =
    enterMiniWindowForMinimize;
  window.roomDesktop?.setMiniWindowEnabled(miniWindowEnabled);
  updatePictureInPictureButton();
  if (!nativeAndroid) {
    playerStage?.addEventListener("pointermove", () => {
      if (isImmersivePlayback()) revealFullscreenControls();
    });
    playerStage?.addEventListener("pointerup", (event) => {
      if (!isImmersivePlayback()) return;
      if ((event.target as HTMLElement).closest("button")) return;
      revealFullscreenControls();
    });
  } else {
    playerStage?.addEventListener("pointerdown", (event) => {
      if (
        !playerStage ||
        video?.hidden ||
        (event.target as HTMLElement).closest(
          "#stage-dock, #stage-progress, #dock-chat-composer, button, input, select, textarea, a, [role='button']",
        )
      ) {
        return;
      }
      const bounds = playerStage.getBoundingClientRect();
      const horizontalRatio =
        bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 0.5;
      const kind =
        horizontalRatio <= 1 / 3
          ? "brightness"
          : horizontalRatio >= 2 / 3
            ? "volume"
            : "tap";
      mobileGesture = {
        pointerId: event.pointerId,
        kind,
        startX: event.clientX,
        startY: event.clientY,
        startValue:
          kind === "brightness"
            ? playbackControlState.brightness
            : kind === "volume"
              ? playbackControlState.volume
              : 0,
        moved: false,
      };
      playerStage.setPointerCapture?.(event.pointerId);
    });
    playerStage?.addEventListener("pointermove", (event) => {
      if (!playerStage) return;
      const gesture = mobileGesture;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const distanceX = event.clientX - gesture.startX;
      const distanceY = event.clientY - gesture.startY;
      if (Math.hypot(distanceX, distanceY) >= 9) {
        gesture.moved = true;
      }
      if (!gesture.moved || gesture.kind === "tap") return;
      event.preventDefault();
      const travel = Math.max(140, playerStage.clientHeight * 0.68);
      const minimum = gesture.kind === "brightness" ? 0.02 : 0;
      const value = Math.max(
        minimum,
        Math.min(1, gesture.startValue - distanceY / travel),
      );
      if (gesture.kind === "brightness") {
        playbackControlState.brightness = value;
      } else {
        playbackControlState.volume = value;
      }
      hideMobilePlayerControls();
      showMobileGestureHud(gesture.kind, value);
      schedulePlaybackControl(gesture.kind, value);
    });
    const finishMobileGesture = (
      event: PointerEvent,
      cancelled = false,
    ): void => {
      if (!playerStage) return;
      const gesture = mobileGesture;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      mobileGesture = undefined;
      if (playerStage.hasPointerCapture?.(event.pointerId)) {
        playerStage.releasePointerCapture(event.pointerId);
      }
      if (!cancelled && !gesture.moved) {
        toggleMobilePlayerControls();
      } else if (gesture.moved) {
        hideMobileGestureHudSoon();
      }
    };
    playerStage?.addEventListener("pointerup", (event) => {
      finishMobileGesture(event);
    });
    playerStage?.addEventListener("pointercancel", (event) => {
      finishMobileGesture(event, true);
    });
  }
  fullscreenChangeHandler = () => {
    if (
      !document.fullscreenElement &&
      document.body.classList.contains("immersive-player") &&
      !isNativeAndroid()
    ) {
      document.body.classList.remove("immersive-player");
    }
    if (!document.fullscreenElement) finishImmersiveUi();
    updateMobilePlayerButtons();
    syncAppMode();
  };
  document.addEventListener("fullscreenchange", fullscreenChangeHandler);
  window.addEventListener("resize", handleFullscreenViewportChange);
  screen.orientation?.addEventListener(
    "change",
    handleFullscreenViewportChange,
  );
  video?.addEventListener("resize", () => {
    syncPlayerAspect();
    if (broadcasterId === selfId) scheduleCaptureCapabilitiesUpdate();
    if (isImmersivePlayback()) void resolveFullscreenFit();
  });
  retryButton?.addEventListener("click", () => {
    watchAttempts = 0;
    watchRecoveryCycles = 0;
    clearSfuPrimaryRecovery();
    sfuFailedBroadcastKey = "";
    void beginWatching(true);
  });
  document
    .querySelector<HTMLSelectElement>("#viewer-resolution")
    ?.addEventListener("change", (event) => {
      preferredHeight = Number(
        (event.currentTarget as HTMLSelectElement).value,
      );
      if (broadcastCapabilities) {
        adaptivePlayback.configure(
          broadcastCapabilities.height,
          preferredHeight,
          false,
          {
            contentMode: broadcastCapabilities.contentMode,
            sourceWidth: broadcastCapabilities.width,
            sourceFrameRate: broadcastCapabilities.frameRate,
          },
        );
      }
      sendViewerQualityPreference(true);
    });
  document
    .querySelector<HTMLSelectElement>("#viewer-frame-rate")
    ?.addEventListener("change", (event) => {
      preferredFrameRate = Number(
        (event.currentTarget as HTMLSelectElement).value,
      );
      sendViewerQualityPreference(true);
    });

  if (!desktop) {
    void App.addListener("backButton", () => {
      if (dialogController.closeTopmost()) {
        return;
      }
      if (closeTopmostFloatingSurface()) {
        return;
      } else if (
        usesOverlayCompanion() &&
        document.body.classList.contains("panel-open")
      ) {
        applyPanelState(true);
        document.getElementById("session-companion")?.focus();
      } else if (document.body.classList.contains("immersive-player")) {
        finishImmersiveUi();
        void exitImmersivePlayer().finally(() => {
          syncAppMode();
          updateMobilePlayerButtons();
          revealMobilePlayerControls();
        });
      } else {
        void leaveSession();
      }
    }).then((handle) => {
      if (leaving) void handle.remove();
      else backButtonHandle = handle;
    });
  }

  if (nativeAndroid) {
    void getPlaybackControlState(movieVolume)
      .then((state) => {
        playbackControlState = state;
      })
      .catch(() => undefined);
  }
  updateMobilePlayerButtons();
  showIdleStage();
  updateBroadcastControls();
  signal = new SignalClient();
  document
    .querySelector<HTMLButtonElement>("#hud-signal")
    ?.addEventListener("click", () => {
      const status =
        document.querySelector<HTMLButtonElement>("#hud-signal");
      if (status?.dataset.reconnectable !== "true") return;
      signalReconnectAttempt = 0;
      void recoverAfterNetworkChange();
    });
  window.addEventListener("online", handleBrowserOnline);
  window.addEventListener("offline", handleBrowserOffline);
  if (desktop) {
    desktopNetworkTimer = window.setInterval(() => {
      void pollDesktopNetworkRoute();
    }, 3_000);
  }
  document.addEventListener(
    "visibilitychange",
    handleVisibilityRecovery,
  );
  void listenForNativeNetworkChanges(({ connected }) => {
    if (!connected) {
      handleBrowserOffline();
    } else if (hasJoinedOnce || signalUnavailable) {
      handleBrowserOnline();
    }
  }).then((handle) => {
    if (leaving) void handle?.remove();
    else networkChangeHandle = handle;
  });
  signal.addEventListener("message", (event) => {
    const message = (event as CustomEvent<SignalEnvelope>).detail;
    signalMessageScheduler.dispatch(message);
  });
  signal.addEventListener("close", () => {
    signalMessageScheduler.reset();
    roomStateRevisionGate.reset();
    clearChannelJoinAckTimer();
    networkProbeGeneration += 1;
    networkProbePromise = undefined;
    if (networkMembershipProbeTimer !== undefined) {
      window.clearTimeout(networkMembershipProbeTimer);
      networkMembershipProbeTimer = undefined;
    }
    networkProbeAbortController.abort();
    networkProbeAbortController = new AbortController();
    if (!leaving) {
      signalUnavailable = true;
      resumeBroadcastAfterReconnect ||= Boolean(
        embyBroadcast?.active ||
          mediaStream
          ?.getVideoTracks()
          .some((track) => track.readyState === "live"),
      );
      resumeVoiceAfterReconnect ||= companion?.voiceActive || false;
      joined = false;
      updateBroadcastControls();
      setStatus("服务器连接已断开 · 点击立即重连", "error", true);
      scheduleSignalReconnect(false);
    }
  });
  try {
    await signal.connect(signalUrl);
    options.operationSignal?.throwIfAborted();
    setConnectionStep("room", "正在加入频道");
    sendChannelJoin();
  } catch (error) {
    if (options.operationSignal?.aborted || leaving) return;
    signalUnavailable = true;
    if (connectionTitle) connectionTitle.textContent = "连接暂时中断";
    void connectionPresence?.show(sessionUiAbortController.signal);
    setStatus(
      error instanceof Error ? error.message : "无法连接频道服务器",
      "error",
      true,
    );
    notify(
      error instanceof Error ? error.message : "无法连接频道服务器",
      true,
    );
    scheduleSignalReconnect(false);
  }
}
