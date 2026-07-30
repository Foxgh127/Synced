import {
  addNativeVoiceDevicesListener,
  hasNativeAudioRoute,
  listNativeVoiceOutputs,
  requestNativeVoiceBluetoothAccess,
  setNativeVoiceOutput,
  startNativeVoiceRoute,
  stopNativeVoiceRoute,
  type VoiceOutputDevice,
} from "./audio-route";
import type { PluginListenerHandle } from "@capacitor/core";
import {
  SignalClient,
  configureVoiceJitterBuffer,
  createPeerConnection,
  hasTurnIceServer,
  readOutboundAudioStats,
  selectPeerIceServers,
  serializableSessionDescription,
  tuneVoiceOpus,
  tuneVoiceSender,
  type OutboundAudioSnapshot,
  voiceJitterBufferTarget,
  type SignalEnvelope,
} from "./rtc";
import {
  AdaptiveVoiceBitrateController,
  voiceBitrateForPeerCount,
} from "./voice-quality";
import {
  createDeepFilterNoiseProcessor,
  type DeepFilterNoiseProcessor,
} from "./deepfilter-noise-suppressor";
import {
  VOICE_CAPTURE_AUDIO_PROFILE,
  boostedPlaybackGain,
  buildVoiceCaptureConstraints,
  normalizeVoiceProcessingMode,
  voiceCaptureProfileForMode,
  voicePeerMediaStallTimeout,
} from "./voice-processing";

interface VoicePeer {
  pc: RTCPeerConnection;
  relayOnly: boolean;
  candidates: RTCIceCandidateInit[];
  candidateApplyQueue: SerialAsyncQueue;
  remoteDescriptionApplying: boolean;
  sessionId: string;
  createdAt: number;
  makingOffer: boolean;
  ignoreOffer: boolean;
  localDescriptionSent: boolean;
  pendingLocalCandidates: RTCIceCandidateInit[];
  boostingPlayback?: boolean;
  remoteStream?: MediaStream;
  remoteTrack?: MediaStreamTrack;
  remoteTrackMutedAt?: number;
  signaledMuted: boolean;
  lastInboundBytes: number;
  lastInboundProgressAt: number;
  recentlyUnmutedAt?: number;
  disconnectedAt?: number;
  audioEnergy?: {
    energy: number;
    duration: number;
  };
  voiceBitrateController: AdaptiveVoiceBitrateController;
  outboundVoiceSnapshot?: OutboundAudioSnapshot;
  appliedVoiceBitrate?: number;
}

interface CaptureGraph {
  sourceStream: MediaStream;
  processedStream: MediaStream;
  context: AudioContext;
  selectedDeviceId: string;
  microphoneGate: GainNode;
  mixLimiter: DynamicsCompressorNode;
  destination: MediaStreamAudioDestinationNode;
  accompanimentSource?: MediaStreamAudioSourceNode;
  accompanimentGain?: GainNode;
  analyser: AnalyserNode;
  analyserSamples: Float32Array<ArrayBuffer>;
  rawAnalyser: AnalyserNode;
  rawAnalyserSamples: Float32Array<ArrayBuffer>;
  browserNoiseSuppression: boolean;
  processorBypassed: boolean;
  silentProcessorSamples: number;
  activateNoiseBypass?: () => void;
  noiseProcessor?: DeepFilterNoiseProcessor;
}

interface PlaybackGraph {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  limiter: DynamicsCompressorNode;
}

interface AudioContextWithSink extends AudioContext {
  setSinkId?: (sinkId: string) => Promise<void>;
}

interface PlaybackRepairQueue {
  forceReattach: boolean;
  rerun: boolean;
  promise: Promise<void>;
}

export const MAX_PENDING_VOICE_CANDIDATES = 64;

export function queuePendingVoiceCandidate(
  candidates: RTCIceCandidateInit[],
  candidate: RTCIceCandidateInit,
): boolean {
  if (candidates.length >= MAX_PENDING_VOICE_CANDIDATES) {
    return false;
  }
  candidates.push(candidate);
  return true;
}

/**
 * Serializes asynchronous media mutations while allowing each caller to
 * observe its own result. A rejected operation does not poison later work.
 */
export class SerialAsyncQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class VoiceCaptureLifecycle {
  private epoch = 0;
  private abortController = new AbortController();

  begin(): number {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.epoch += 1;
    return this.epoch;
  }

  invalidate(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.epoch += 1;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.epoch;
  }

  signalFor(epoch: number): AbortSignal {
    if (this.isCurrent(epoch)) return this.abortController.signal;
    const stale = new AbortController();
    stale.abort();
    return stale.signal;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }
}

export interface VoiceInputDevice {
  id: string;
  label: string;
}

export interface VoiceDevices {
  inputs: VoiceInputDevice[];
  outputs: VoiceOutputDevice[];
}

export interface VoiceDevicesChange {
  devices: VoiceDevices;
  inputFallback: boolean;
  outputFallback: boolean;
}

export type VoiceNoiseMode = "natural" | "clear" | "strong";

export interface VoiceState {
  active: boolean;
  listeningOnly: boolean;
  muted: boolean;
  microphoneDisabled: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  noiseSuppression: boolean;
  neuralNoiseSuppression: boolean;
  noiseProcessorName?: "DeepFilterNet3";
  noiseMode: VoiceNoiseMode;
  inputDeviceId: string;
  outputDeviceId: string;
  volume: number;
  bitrate: number;
  connectedPeers: number;
  relayedPeers: number;
}

export interface VoiceSpeakingChange {
  participantId: string;
  speaking: boolean;
  level: number;
}

type AudioWithSink = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

const INPUT_KEY = "synced:voice-input";
const OUTPUT_KEY = "synced:voice-output";
const VOLUME_KEY = "synced:voice-volume";
const NOISE_MODE_KEY = "synced:voice-noise-mode";
const DEVICE_CHANGE_DEBOUNCE_MS = 400;
const SPEAKING_SAMPLE_INTERVAL_MS = 150;
const SPEAKING_START_LEVEL = 0.032;
const SPEAKING_CONTINUE_LEVEL = 0.014;
const SPEAKING_HANGOVER_MS = 420;
const SPEAKING_STATS_TIMEOUT_MS = 900;
const VOICE_PEER_SYNC_INTERVAL_MS = 4_000;
const VOICE_PEER_CONNECT_TIMEOUT_MS = 8_000;
const VOICE_PEER_DISCONNECTED_GRACE_MS = 3_200;
const VOICE_CAPTURE_RECOVERY_DELAY_MS = 1_200;
const VOICE_REMOTE_TRACK_MUTE_GRACE_MS = 4_500;
const PROCESSOR_SILENCE_SAMPLE_LIMIT = 8;
const PLAYBACK_REPAIR_DEBOUNCE_MS = 180;
const PLAYBACK_SINK_TIMEOUT_MS = 5_000;
const VOICE_RTC_NEGOTIATION_TIMEOUT_MS = 8_000;
const VOICE_RTC_CANDIDATE_TIMEOUT_MS = 2_000;
const VOICE_RTC_STATS_TIMEOUT_MS = 2_500;
const VOICE_RTC_TRACK_REPLACE_TIMEOUT_MS = 5_000;
const VOICE_RTC_TUNE_TIMEOUT_MS = 5_000;
const VOICE_AUDIO_RESUME_TIMEOUT_MS = 3_000;
const VOICE_CAPTURE_REQUEST_TIMEOUT_MS = 30_000;
const VOICE_DEVICE_OPERATION_TIMEOUT_MS = 8_000;
const VOICE_NOISE_PROCESSOR_TIMEOUT_MS = 12_000;

export class VoiceOperationTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs} ms`);
    this.name = "VoiceOperationTimeoutError";
  }
}

export async function boundedVoiceOperation<T>(
  operation: Promise<T>,
  message: string,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(
          () =>
            reject(new VoiceOperationTimeoutError(message, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

async function requestVoiceUserMedia(
  constraints: MediaStreamConstraints,
  signal?: AbortSignal,
): Promise<MediaStream> {
  if (signal?.aborted) {
    throw new DOMException("麦克风采集请求已取消", "AbortError");
  }
  const request = navigator.mediaDevices.getUserMedia(constraints);
  let timeout: number | undefined;
  let abortHandler: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = window.setTimeout(
      () =>
        reject(
          new VoiceOperationTimeoutError(
            "等待麦克风授权",
            VOICE_CAPTURE_REQUEST_TIMEOUT_MS,
          ),
        ),
      VOICE_CAPTURE_REQUEST_TIMEOUT_MS,
    );
  });
  const cancellation = new Promise<never>((_, reject) => {
    if (!signal) return;
    abortHandler = () =>
      reject(new DOMException("麦克风采集请求已取消", "AbortError"));
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([request, deadline, cancellation]);
  } catch (error) {
    // getUserMedia has no cross-browser AbortSignal support. If permission is
    // granted after the room/session was already left, stop that late stream
    // immediately instead of leaking a microphone indicator or reviving it.
    void request
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      })
      .catch(() => undefined);
    throw error;
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

async function closeVoiceAudioContext(
  context: AudioContext,
  label = "关闭语音音频处理超时",
): Promise<void> {
  if (context.state === "closed") return;
  await boundedVoiceOperation(
    context.close(),
    label,
    VOICE_AUDIO_RESUME_TIMEOUT_MS,
  ).catch(() => undefined);
}

const VIRTUAL_DEVICE_PATTERN =
  /virtual(?: audio| microphone| speaker)?|虚拟(?:音频|声卡|麦克风|扬声器)?|stereo mix|立体声混音|what u hear|wave out mix|loopback|回环|vb-audio|voicemeeter|blackhole|soundflower|obs virtual|cable (?:input|output)|zoom audio device|teams audio device|steam streaming|remote audio|远程音频/iu;
const LOW_QUALITY_OUTPUT_PROFILE_PATTERN =
  /hands[\s-]?free(?: ag audio)?|免提(?:通话)?/iu;

interface NormalizedDeviceInventory {
  devices: VoiceDevices;
  inputAvailabilityKnown: boolean;
  outputAvailabilityKnown: boolean;
}

function normalizedDeviceLabel(label: string): string {
  return label
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(
      /^(?:default|communications?|系统默认|默认|通信设备|通讯设备)\s*[-—:：]\s*/iu,
      "",
    )
    .replace(/[\s()[\]{}（）【】_\-—:：·.]+/gu, "");
}

function isHiddenBrowserDevice(
  device: MediaDeviceInfo,
): boolean {
  if (device.deviceId === "default") return false;
  if (!device.deviceId || !device.label.trim()) return true;
  return device.deviceId.toLocaleLowerCase() === "communications";
}

function devicePreferenceRank(label: string, kind: MediaDeviceKind): number {
  if (
    kind === "audiooutput" &&
    LOW_QUALITY_OUTPUT_PROFILE_PATTERN.test(label)
  ) {
    return 2;
  }
  return VIRTUAL_DEVICE_PATTERN.test(label) ? 1 : 0;
}

function normalizeBrowserDevices(
  mediaDevices: MediaDeviceInfo[],
  kind: "audioinput",
  selectedId: string,
): VoiceInputDevice[];
function normalizeBrowserDevices(
  mediaDevices: MediaDeviceInfo[],
  kind: "audiooutput",
  selectedId: string,
): VoiceOutputDevice[];
function normalizeBrowserDevices(
  mediaDevices: MediaDeviceInfo[],
  kind: "audioinput" | "audiooutput",
  selectedId: string,
): VoiceInputDevice[] | VoiceOutputDevice[] {
  const aliases: Array<VoiceInputDevice | VoiceOutputDevice> =
    kind === "audioinput"
      ? [{ id: "default", label: "系统默认麦克风" }]
      : [
          {
            id: "default",
            label: "系统默认扬声器",
            kind: "other" as const,
          },
        ];
  const candidates = mediaDevices
    .filter((device) => device.kind === kind)
    .filter((device) => !isHiddenBrowserDevice(device))
    .filter((device) => device.deviceId !== "default")
    .sort((left, right) => {
      const selectedRank =
        Number(right.deviceId === selectedId) -
        Number(left.deviceId === selectedId);
      if (selectedRank) return selectedRank;
      const qualityRank =
        devicePreferenceRank(left.label, kind) -
        devicePreferenceRank(right.label, kind);
      return qualityRank || left.label.localeCompare(right.label, "zh-CN");
    });
  const seenIds = new Set<string>(["default"]);
  const seenEndpoints = new Set<string>();
  for (const device of candidates) {
    if (seenIds.has(device.deviceId)) continue;
    const normalizedLabel = normalizedDeviceLabel(device.label);
    const endpointKey = device.groupId
      ? `${device.groupId}\u0000${normalizedLabel}`
      : normalizedLabel;
    if (!normalizedLabel || seenEndpoints.has(endpointKey)) continue;
    seenIds.add(device.deviceId);
    seenEndpoints.add(endpointKey);
    aliases.push(
      kind === "audioinput"
        ? {
            id: device.deviceId,
            label: device.label.trim(),
          }
        : {
            id: device.deviceId,
            label: device.label.trim(),
            kind: "other" as const,
          },
    );
  }
  return aliases as VoiceInputDevice[] | VoiceOutputDevice[];
}

function normalizeNativeOutputs(
  outputs: VoiceOutputDevice[],
  selectedId: string,
): VoiceOutputDevice[] {
  const normalized: VoiceOutputDevice[] = [
    {
      id: "default",
      label: "自动（耳机优先）",
      kind: "other",
    },
  ];
  const seenIds = new Set<string>(["default"]);
  const seenEndpoints = new Set<string>();
  const candidates = [...outputs].sort(
    (left, right) => {
      const selectedRank =
        Number(right.id === selectedId) - Number(left.id === selectedId);
      if (selectedRank) return selectedRank;
      const qualityRank =
        devicePreferenceRank(left.label, "audiooutput") -
        devicePreferenceRank(right.label, "audiooutput");
      return qualityRank || left.label.localeCompare(right.label, "zh-CN");
    },
  );
  for (const device of candidates) {
    const id = device.id.trim();
    const label = device.label.trim();
    if (
      !id ||
      id === "default" ||
      !label ||
      seenIds.has(id)
    ) {
      continue;
    }
    const endpointKey = `${device.kind}\u0000${normalizedDeviceLabel(label)}`;
    if (seenEndpoints.has(endpointKey)) continue;
    seenIds.add(id);
    seenEndpoints.add(endpointKey);
    normalized.push({ ...device, id, label });
  }
  return normalized;
}

function deviceFingerprint(devices: VoiceDevices): string {
  return JSON.stringify({
    inputs: devices.inputs.map(({ id, label }) => [id, label]),
    outputs: devices.outputs.map(({ id, label, kind }) => [id, label, kind]),
  });
}

function inputDeviceFingerprint(devices: VoiceDevices): string {
  return JSON.stringify(
    devices.inputs.map(({ id, label }) => [id, label]),
  );
}

function outputDeviceFingerprint(devices: VoiceDevices): string {
  return JSON.stringify(
    devices.outputs.map(({ id, label, kind }) => [id, label, kind]),
  );
}

function storedVolume(): number {
  const stored = localStorage.getItem(VOLUME_KEY);
  if (stored === null) return 1;
  const value = Number(stored);
  // 85% was the old untouched default. Migrate it to the new 100% default;
  // users can still turn the master or per-person slider back down.
  if (Math.abs(value - 0.85) < 0.0001) return 1;
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : 1;
}

function storedNoiseMode(): VoiceNoiseMode {
  const stored = localStorage.getItem(NOISE_MODE_KEY);
  const normalized = normalizeVoiceProcessingMode(stored);
  if (stored && stored !== normalized) {
    localStorage.setItem(NOISE_MODE_KEY, normalized);
  }
  return normalized;
}

export class VoiceMesh extends EventTarget {
  private readonly peers = new Map<string, VoicePeer>();
  private readonly expectedPeers = new Set<string>();
  private readonly retiredPeerSessions = new Map<string, Set<string>>();
  private readonly peerRetryTimers = new Map<string, number>();
  private readonly peerFailureCounts = new Map<string, number>();
  private readonly peerNetworkErrorsReported = new Set<string>();
  private readonly expectedPeerMuteStates = new Map<string, boolean>();
  private readonly peerVolumes = new Map<string, number>();
  private readonly playbackGraphs = new Map<string, PlaybackGraph>();
  private readonly playbackRepairTimers = new Map<
    string,
    {
      timer: number;
      forceReattach: boolean;
    }
  >();
  private readonly playbackRepairQueues = new Map<
    string,
    PlaybackRepairQueue
  >();
  private readonly blockedPlaybackPeers = new Set<string>();
  private playbackGestureRetryArmed = false;
  private voiceTuneQueue: Promise<void> = Promise.resolve();
  private readonly captureMutationQueue = new SerialAsyncQueue();
  private readonly captureLifecycle = new VoiceCaptureLifecycle();
  private joinInFlight?: {
    epoch: number;
    promise: Promise<void>;
  };
  private graph?: CaptureGraph;
  private accompanimentTrack?: MediaStreamTrack;
  private accompanimentEndedHandler?: () => void;
  private accompanimentVolume = 0.7;
  private muted = false;
  private microphoneDisabled = false;
  private active = false;
  private listeningOnly = false;
  private destroyed = false;
  private inputDeviceId = localStorage.getItem(INPUT_KEY) || "default";
  private outputDeviceId = localStorage.getItem(OUTPUT_KEY) || "default";
  private volume = storedVolume();
  private noiseMode = storedNoiseMode();
  private deviceChangeTimer?: number;
  private captureRecoveryTimer?: number;
  private captureRecoveryInFlight = false;
  private captureRecoveryPending = false;
  private captureRecoveryErrorNotified = false;
  private captureRecoveryForceFallback = false;
  private captureProcessorFallbackNotified = false;
  private nativeDeviceListener?: PluginListenerHandle;
  private knownDeviceFingerprint = "";
  private knownInputDeviceFingerprint = "";
  private knownOutputDeviceFingerprint = "";
  private speakingTimer?: number;
  private peerHealthTimer?: number;
  private voiceStatsPollRunning = false;
  private speakingPollRunning = false;
  private audioResumeInFlight = false;
  private readonly speakingStates = new Map<
    string,
    {
      speaking: boolean;
      lastVoiceAt: number;
      noiseFloor: number;
      attackSamples: number;
    }
  >();
  private readonly handleMediaDevicesChange = (): void => {
    if (this.destroyed) return;
    if (this.deviceChangeTimer !== undefined) {
      window.clearTimeout(this.deviceChangeTimer);
    }
    this.deviceChangeTimer = window.setTimeout(() => {
      this.deviceChangeTimer = undefined;
      void this.reconcileMediaDevicesChange();
    }, DEVICE_CHANGE_DEBOUNCE_MS);
  };
  private readonly handleVisibilityChange = (): void => {
    if (
      document.visibilityState !== "visible" ||
      this.destroyed ||
      !this.active
    ) {
      return;
    }
    void this.resumeAudioAfterInterruption();
  };
  private readonly handlePlaybackGesture = (): void => {
    const peerIds = [...this.blockedPlaybackPeers];
    this.blockedPlaybackPeers.clear();
    this.disarmPlaybackGestureRetry();
    if (!this.active || this.destroyed) return;
    for (const peerId of peerIds) {
      if (!this.peers.has(peerId)) continue;
      const playback = this.playbackGraphs.get(peerId);
      if (playback && playback.context.state !== "running") {
        void playback.context
          .resume()
          .catch(() => this.fallbackToDirectPlayback(peerId));
      }
      const audio = this.audioContainer.querySelector<HTMLAudioElement>(
        `audio[data-voice-peer="${CSS.escape(peerId)}"]`,
      );
      if (audio) {
        // Invoke play() directly inside the trusted gesture handler so the
        // browser's transient user activation is still available.
        this.playRemoteAudio(audio);
      }
    }
  };

  constructor(
    private readonly signal: SignalClient,
    private readonly selfId: string,
    private iceServers: RTCIceServer[],
    private readonly audioContainer: HTMLElement,
  ) {
    super();
    navigator.mediaDevices?.addEventListener(
      "devicechange",
      this.handleMediaDevicesChange,
    );
    document.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    void addNativeVoiceDevicesListener(this.handleMediaDevicesChange)
      .then((listener) => {
        if (this.destroyed) {
          void listener?.remove();
          return;
        }
        this.nativeDeviceListener = listener;
      })
      .catch(() => undefined);
  }

  updateIceServers(iceServers: RTCIceServer[]): void {
    this.iceServers = iceServers.map((server) => ({ ...server }));
    for (const peer of this.peers.values()) {
      try {
        peer.pc.setConfiguration({
          ...peer.pc.getConfiguration(),
          iceServers: selectPeerIceServers(
            this.iceServers,
            peer.relayOnly ? "relay" : "all",
          ),
        });
      } catch {
        // A peer can close between the map snapshot and setConfiguration.
      }
    }
  }

  get state(): VoiceState {
    const settings = this.graph?.sourceStream
      .getAudioTracks()[0]
      ?.getSettings();
    return {
      active: this.active,
      listeningOnly: this.listeningOnly,
      muted: this.muted,
      microphoneDisabled: this.microphoneDisabled,
      echoCancellation: settings?.echoCancellation !== false,
      autoGainControl: settings?.autoGainControl === true,
      noiseSuppression:
        Boolean(
          this.graph?.noiseProcessor && !this.graph.processorBypassed,
        ) ||
        Boolean(this.graph?.browserNoiseSuppression) ||
        settings?.noiseSuppression === true,
      neuralNoiseSuppression: Boolean(
        this.graph?.noiseProcessor && !this.graph.processorBypassed,
      ),
      noiseProcessorName: this.graph?.processorBypassed
        ? undefined
        : this.graph?.noiseProcessor?.name,
      noiseMode: this.noiseMode,
      inputDeviceId: this.inputDeviceId,
      outputDeviceId: this.outputDeviceId,
      volume: this.volume,
      bitrate: this.voiceBitrate(),
      connectedPeers: [...this.peers.values()].filter(
        ({ pc }) => pc.connectionState === "connected",
      ).length,
      relayedPeers: [...this.peers.values()].filter(
        ({ pc, relayOnly }) =>
          relayOnly && pc.connectionState === "connected",
      ).length,
    };
  }

  async listDevices(): Promise<VoiceDevices> {
    return (await this.refreshDevices()).devices;
  }

  async requestOptionalOutputAccess(): Promise<void> {
    if (this.destroyed) {
      throw new Error("连麦设备管理已关闭");
    }
    await boundedVoiceOperation(
      requestNativeVoiceBluetoothAccess(),
      "请求蓝牙语音设备权限超时",
      VOICE_DEVICE_OPERATION_TIMEOUT_MS,
    );
  }

  async refreshDevices(): Promise<VoiceDevicesChange> {
    if (this.destroyed) {
      throw new Error("连麦设备管理已关闭");
    }
    const inventory = await this.enumerateNormalizedDevices();
    if (this.destroyed) {
      throw new Error("连麦设备管理已关闭");
    }
    const result = await this.reconcileSelectedDevices(inventory);
    this.knownDeviceFingerprint = deviceFingerprint(result.devices);
    this.knownInputDeviceFingerprint = inputDeviceFingerprint(result.devices);
    this.knownOutputDeviceFingerprint =
      outputDeviceFingerprint(result.devices);
    return result;
  }

  async join(): Promise<void> {
    if (this.destroyed) {
      throw new Error("连麦设备管理已关闭");
    }
    if (this.active && !this.listeningOnly) return;
    const upgradingListener = this.active && this.listeningOnly;
    const existing = this.joinInFlight;
    if (existing && this.captureLifecycle.isCurrent(existing.epoch)) {
      await existing.promise;
      return;
    }
    const epoch = this.captureLifecycle.begin();
    // Create and resume the processing context synchronously from the button
    // gesture. Waiting for the Android bridge, permission UI and model load
    // first can consume transient user activation and leave a later context
    // permanently suspended even though getUserMedia succeeded.
    const captureContext = new AudioContext({
      sampleRate: 48_000,
      latencyHint: "interactive",
    });
    void captureContext.resume().catch(() => undefined);
    const promise = this.captureMutationQueue.run(() =>
      this.performJoin(epoch, captureContext, upgradingListener),
    );
    const request = { epoch, promise };
    this.joinInFlight = request;
    try {
      await promise;
    } finally {
      if (this.joinInFlight === request) {
        this.joinInFlight = undefined;
      }
    }
  }

  private async performJoin(
    epoch: number,
    captureContext: AudioContext,
    upgradingListener = false,
  ): Promise<void> {
    let replacement: CaptureGraph | undefined;
    let installed = false;
    let nativeRouteStarted = false;
    const current = (): boolean =>
      !this.destroyed && this.captureLifecycle.isCurrent(epoch);
    try {
      if (!current()) return;
      try {
        await boundedVoiceOperation(
          startNativeVoiceRoute(),
          "启动系统语音路由超时",
          VOICE_DEVICE_OPERATION_TIMEOUT_MS,
        );
        nativeRouteStarted = true;
      } catch {
        // Some Android OEMs reject MODE_IN_COMMUNICATION; voice chat
        // continues with the browser's default audio path instead.
        nativeRouteStarted = false;
      }
      if (!current()) return;
      replacement = await this.createCaptureGraph(
        this.inputDeviceId,
        this.noiseMode,
        captureContext,
        this.captureLifecycle.signalFor(epoch),
      );
      if (!current()) return;
      if (hasNativeAudioRoute()) {
        await boundedVoiceOperation(
          setNativeVoiceOutput(this.outputDeviceId),
          "设置系统语音输出超时",
          VOICE_DEVICE_OPERATION_TIMEOUT_MS,
        );
      } else {
        await this.applyOutputDevice(this.outputDeviceId);
      }
      if (!current()) return;

      replacement.processedStream
        .getAudioTracks()
        .forEach((track) => {
          track.enabled = true;
        });
      this.applyMicrophoneGate(replacement);
      this.graph = replacement;
      installed = true;
      this.bindCaptureGraphRecovery(replacement);
      this.inputDeviceId = replacement.selectedDeviceId;
      localStorage.setItem(INPUT_KEY, this.inputDeviceId);
      if (upgradingListener) {
        for (const peerId of [...this.peers.keys()]) {
          this.closePeer(peerId);
        }
      }
      this.active = true;
      this.listeningOnly = false;
      this.muted = this.microphoneDisabled;
      this.startSpeakingMonitor();
      this.startPeerHealthMonitor();
      this.signal.send({ type: "voice:join" });
      this.signal.send({ type: "voice:mute", muted: this.muted });
      this.emitState();
    } catch (error) {
      if (!current()) return;
      this.active = upgradingListener;
      this.listeningOnly = upgradingListener;
      this.muted = upgradingListener;
      if (!upgradingListener) {
        this.stopSpeakingMonitor();
        this.stopPeerHealthMonitor();
      }
      if (this.graph === replacement) {
        this.graph = undefined;
        installed = false;
      }
      if (nativeRouteStarted) {
        await boundedVoiceOperation(
          stopNativeVoiceRoute(),
          "停止系统语音路由超时",
          VOICE_DEVICE_OPERATION_TIMEOUT_MS,
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      if (!installed) {
        await this.disposeGraph(replacement);
        await closeVoiceAudioContext(
          captureContext,
          "关闭未采用的麦克风处理上下文超时",
        );
      }
    }
  }

  async handle(message: SignalEnvelope): Promise<boolean> {
    if (message.type === "voice:ready" && message.participants) {
      if (message.iceServers?.length) {
        this.iceServers = message.iceServers;
      }
      const peerIds = this.reconcileExpectedPeers(message.participants);
      await Promise.allSettled(peerIds.map((peerId) => this.offerTo(peerId)));
      return true;
    }
    if (message.type === "voice:peers" && message.participants) {
      this.reconcileExpectedPeers(message.participants);
      this.ensureMissingPeers();
      return true;
    }
    if (message.type === "voice:signal" && message.from && message.data) {
      const peerId = message.from;
      this.expectedPeers.add(peerId);
      await this.handlePeerSignal(
        peerId,
        message.data,
        message.sessionId,
        message.iceMode,
      ).catch(() => {
        this.schedulePeerRecovery(peerId);
      });
      return true;
    }
    if (message.type === "voice:left" && message.participantId) {
      this.expectedPeers.delete(message.participantId);
      this.expectedPeerMuteStates.delete(message.participantId);
      this.clearPeerRetry(message.participantId);
      this.closePeer(message.participantId);
      this.retiredPeerSessions.delete(message.participantId);
      this.peerFailureCounts.delete(message.participantId);
      this.peerNetworkErrorsReported.delete(message.participantId);
      return true;
    }
    if (message.type === "voice:joined" && message.participant) {
      if (message.participant.id !== this.selfId) {
        this.expectedPeers.add(message.participant.id);
        // The newly joined member sends the first offer. If that offer is
        // lost, the deterministic health monitor below rebuilds the edge.
        this.schedulePeerRecovery(message.participant.id, 8_000);
      }
      return true;
    }
    return false;
  }

  async listenForSharedAudio(): Promise<void> {
    if (this.destroyed || this.active) return;
    this.captureLifecycle.invalidate();
    this.active = true;
    this.listeningOnly = true;
    this.muted = true;
    this.startSpeakingMonitor();
    this.startPeerHealthMonitor();
    try {
      this.signal.send({ type: "voice:join" });
      this.signal.send({ type: "voice:mute", muted: true });
      this.emitState();
    } catch (error) {
      // A shared-audio notification can race with signaling teardown. Do not
      // leave an inactive listener marked active with health timers running.
      this.active = false;
      this.listeningOnly = false;
      this.muted = false;
      this.stopSpeakingMonitor();
      this.stopPeerHealthMonitor();
      this.emitState();
      throw error;
    }
  }

  async stopSharedAudioListener(): Promise<void> {
    if (!this.listeningOnly) return;
    await this.leave();
  }

  toggleMute(): boolean {
    if (!this.active || !this.graph) return false;
    if (this.listeningOnly) return true;
    if (this.microphoneDisabled) {
      return true;
    }
    this.muted = !this.muted;
    this.applyMicrophoneGate(this.graph);
    if (this.muted) {
      this.updateSpeakingState(this.selfId, 0, false);
    }
    try {
      this.signal.send({ type: "voice:mute", muted: this.muted });
    } catch {
      // The state is re-sent after signaling reconnects.
    }
    this.emitState();
    return this.muted;
  }

  setMicrophoneDisabled(disabled: boolean): void {
    this.microphoneDisabled = disabled;
    if (disabled) {
      this.muted = true;
      this.updateSpeakingState(this.selfId, 0, false);
    }
    this.applyMicrophoneGate(this.graph);
    this.emitState();
  }

  get accompanimentActive(): boolean {
    return (
      this.accompanimentTrack?.readyState === "live" &&
      Boolean(this.graph?.accompanimentSource)
    );
  }

  setAccompanimentTrack(
    track: MediaStreamTrack,
    volume = this.accompanimentVolume,
  ): void {
    if (this.destroyed || !this.active || !this.graph) {
      throw new Error("请先加入连麦，再播放伴奏");
    }
    if (track.kind !== "audio" || track.readyState !== "live") {
      throw new Error("伴奏音轨不可用，请重新选择来源");
    }
    this.clearAccompaniment();
    this.accompanimentTrack = track;
    this.accompanimentVolume = Math.min(1.5, Math.max(0, volume));
    this.accompanimentEndedHandler = () => {
      if (this.accompanimentTrack !== track) return;
      this.clearAccompaniment();
      this.dispatchEvent(new Event("accompanimentended"));
    };
    track.addEventListener("ended", this.accompanimentEndedHandler, {
      once: true,
    });
    this.attachAccompaniment(this.graph);
    void this.retuneVoiceSenders();
  }

  setAccompanimentVolume(volume: number): void {
    this.accompanimentVolume = Math.min(1.5, Math.max(0, volume));
    const graph = this.graph;
    if (!graph?.accompanimentGain) return;
    const now = graph.context.currentTime;
    graph.accompanimentGain.gain.cancelScheduledValues(now);
    graph.accompanimentGain.gain.setTargetAtTime(
      this.accompanimentVolume,
      now,
      0.03,
    );
  }

  clearAccompaniment(): void {
    const track = this.accompanimentTrack;
    if (track && this.accompanimentEndedHandler) {
      track.removeEventListener("ended", this.accompanimentEndedHandler);
    }
    this.accompanimentEndedHandler = undefined;
    this.accompanimentTrack = undefined;
    this.detachAccompaniment(this.graph);
    const processedTrack = this.graph?.processedStream.getAudioTracks()[0];
    if (processedTrack) processedTrack.contentHint = "speech";
    if (this.active) void this.retuneVoiceSenders();
  }

  syncActiveParticipants(
    participants: Array<{
      id: string;
      voiceActive: boolean;
      microphoneMuted?: boolean;
      microphoneDisabled?: boolean;
    }>,
  ): void {
    if (!this.active || this.destroyed) return;
    this.reconcileExpectedPeers(
      participants.filter((participant) => participant.voiceActive),
    );
    this.requestPeerSnapshot();
    this.ensureMissingPeers();
  }

  async setInputDevice(deviceId: string, force = false): Promise<void> {
    const requested = deviceId || "default";
    await this.captureMutationQueue.run(async () => {
      if (this.destroyed) {
        throw new Error("连麦设备管理已关闭");
      }
      if (requested === this.inputDeviceId && !force) return;
      if (!this.active) {
        this.inputDeviceId = requested;
        localStorage.setItem(INPUT_KEY, requested);
        this.emitState();
        return;
      }

      const replacement = await this.createCaptureGraph(
        requested,
        this.noiseMode,
        undefined,
        this.captureLifecycle.signal,
      );
      if (!(await this.replaceCaptureGraph(replacement))) {
        if (!this.destroyed) {
          this.inputDeviceId = requested;
          localStorage.setItem(INPUT_KEY, requested);
          this.emitState();
        }
        return;
      }
      this.inputDeviceId = replacement.selectedDeviceId;
      localStorage.setItem(INPUT_KEY, this.inputDeviceId);
      this.emitState();
    });
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const requested = deviceId || "default";
    await this.applyOutputDevice(requested);
    this.outputDeviceId = requested;
    localStorage.setItem(OUTPUT_KEY, requested);
    await this.repairAllRemotePlayback(true);
    this.emitState();
  }

  async setNoiseMode(mode: VoiceNoiseMode): Promise<void> {
    if (!["natural", "clear", "strong"].includes(mode)) {
      throw new Error("无效的麦克风降噪模式");
    }
    await this.captureMutationQueue.run(async () => {
      if (this.destroyed) {
        throw new Error("连麦设备管理已关闭");
      }
      if (mode === this.noiseMode) return;
      this.captureProcessorFallbackNotified = false;
      if (!this.active) {
        this.noiseMode = mode;
        localStorage.setItem(NOISE_MODE_KEY, mode);
        this.emitState();
        return;
      }

      const replacement = await this.createCaptureGraph(
        this.inputDeviceId,
        mode,
        undefined,
        this.captureLifecycle.signal,
      );
      if (!(await this.replaceCaptureGraph(replacement))) {
        if (!this.destroyed) {
          this.noiseMode = mode;
          localStorage.setItem(NOISE_MODE_KEY, mode);
          this.emitState();
        }
        return;
      }
      this.inputDeviceId = replacement.selectedDeviceId;
      this.noiseMode = mode;
      localStorage.setItem(INPUT_KEY, this.inputDeviceId);
      localStorage.setItem(NOISE_MODE_KEY, mode);
      this.emitState();
    });
  }

  setVolume(value: number): void {
    this.volume = Math.min(2, Math.max(0, value));
    localStorage.setItem(VOLUME_KEY, String(this.volume));
    this.audioContainer
      .querySelectorAll<HTMLAudioElement>("audio[data-voice-peer]")
      .forEach((audio) => {
        this.applyPeerVolume(audio, audio.dataset.voicePeer || "");
      });
    this.emitState();
  }

  getPeerVolume(peerId: string): number {
    return this.peerVolumes.get(peerId) ?? 1;
  }

  setPeerVolume(peerId: string, value: number): void {
    if (!peerId || peerId === this.selfId) return;
    const normalized = Math.min(2, Math.max(0, value));
    this.peerVolumes.set(peerId, normalized);
    const audio = this.audioContainer.querySelector<HTMLAudioElement>(
      `audio[data-voice-peer="${CSS.escape(peerId)}"]`,
    );
    if (audio) {
      this.applyPeerVolume(audio, peerId);
    }
  }

  async leave(): Promise<void> {
    this.captureLifecycle.invalidate();
    this.joinInFlight = undefined;
    if (this.active) {
      try {
        this.signal.send({ type: "voice:leave" });
      } catch {
        // The channel may already have closed.
      }
    }
    this.active = false;
    this.listeningOnly = false;
    this.muted = false;
    this.clearAccompaniment();
    const graph = this.graph;
    this.graph = undefined;
    this.stopSpeakingMonitor();
    this.stopPeerHealthMonitor();
    this.clearCaptureRecovery();
    this.expectedPeers.clear();
    this.expectedPeerMuteStates.clear();
    this.retiredPeerSessions.clear();
    this.peerFailureCounts.clear();
    this.peerNetworkErrorsReported.clear();
    this.captureProcessorFallbackNotified = false;
    for (const peerId of [...this.peers.keys()]) {
      this.closePeer(peerId);
    }
    for (const peerId of this.playbackGraphs.keys()) {
      this.disposePlaybackGraph(peerId);
    }
    for (const request of this.playbackRepairTimers.values()) {
      window.clearTimeout(request.timer);
    }
    this.playbackRepairTimers.clear();
    this.blockedPlaybackPeers.clear();
    this.disarmPlaybackGestureRetry();
    this.audioContainer.replaceChildren();
    this.emitState();
    await this.captureMutationQueue.run(async () => {
      await this.disposeGraph(graph);
      await boundedVoiceOperation(
        stopNativeVoiceRoute(),
        "停止系统语音路由超时",
        VOICE_DEVICE_OPERATION_TIMEOUT_MS,
      ).catch(() => undefined);
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.deviceChangeTimer !== undefined) {
      window.clearTimeout(this.deviceChangeTimer);
      this.deviceChangeTimer = undefined;
    }
    navigator.mediaDevices?.removeEventListener(
      "devicechange",
      this.handleMediaDevicesChange,
    );
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    const nativeDeviceListener = this.nativeDeviceListener;
    this.nativeDeviceListener = undefined;
    const removingNativeDeviceListener = nativeDeviceListener
      ? boundedVoiceOperation(
          nativeDeviceListener.remove(),
          "移除系统语音设备监听超时",
          VOICE_DEVICE_OPERATION_TIMEOUT_MS,
        ).catch(() => undefined)
      : undefined;
    await this.leave();
    await removingNativeDeviceListener;
  }

  private async enumerateNormalizedDevices(): Promise<NormalizedDeviceInventory> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      throw new Error("当前系统无法读取音频设备");
    }
    const mediaDevices = await boundedVoiceOperation(
      navigator.mediaDevices.enumerateDevices(),
      "读取系统音频设备超时",
      VOICE_DEVICE_OPERATION_TIMEOUT_MS,
    );
    const rawInputs = mediaDevices.filter(
      (device) => device.kind === "audioinput",
    );
    const rawOutputs = mediaDevices.filter(
      (device) => device.kind === "audiooutput",
    );
    const inputs = normalizeBrowserDevices(
      mediaDevices,
      "audioinput",
      this.inputDeviceId,
    );
    const native = await boundedVoiceOperation(
      listNativeVoiceOutputs(),
      "读取原生语音输出设备超时",
      VOICE_DEVICE_OPERATION_TIMEOUT_MS,
    ).catch(() => undefined);
    if (native) {
      return {
        devices: {
          inputs,
          outputs: normalizeNativeOutputs(
            native.devices,
            this.outputDeviceId,
          ),
        },
        inputAvailabilityKnown:
          this.active ||
          rawInputs.some(
            (device) =>
              device.deviceId !== "default" &&
              device.deviceId !== "communications" &&
              Boolean(device.label.trim()),
          ),
        outputAvailabilityKnown: true,
      };
    }
    return {
      devices: {
        inputs,
        outputs: normalizeBrowserDevices(
          mediaDevices,
          "audiooutput",
          this.outputDeviceId,
        ),
      },
      inputAvailabilityKnown:
        this.active ||
        rawInputs.some(
          (device) =>
            device.deviceId !== "default" &&
            device.deviceId !== "communications" &&
            Boolean(device.label.trim()),
        ),
      outputAvailabilityKnown:
        this.active ||
        rawOutputs.some(
          (device) =>
            device.deviceId !== "default" &&
            device.deviceId !== "communications" &&
            Boolean(device.label.trim()),
        ),
    };
  }

  private async reconcileSelectedDevices(
    inventory: NormalizedDeviceInventory,
  ): Promise<VoiceDevicesChange> {
    const { devices } = inventory;
    const inputFallback =
      inventory.inputAvailabilityKnown &&
      !devices.inputs.some((device) => device.id === this.inputDeviceId);
    const outputFallback =
      inventory.outputAvailabilityKnown &&
      !devices.outputs.some((device) => device.id === this.outputDeviceId);

    if (inputFallback) {
      await this.setInputDevice("default");
    }
    if (outputFallback) {
      await this.setOutputDevice("default");
    }
    return { devices, inputFallback, outputFallback };
  }

  private async reconcileMediaDevicesChange(): Promise<void> {
    if (this.destroyed) return;
    const previousFingerprint = this.knownDeviceFingerprint;
    const previousInputFingerprint = this.knownInputDeviceFingerprint;
    const previousOutputFingerprint = this.knownOutputDeviceFingerprint;
    const wasUsingDefaultInput =
      this.active && this.inputDeviceId === "default";
    const wasUsingAutomaticNativeOutput =
      this.active &&
      hasNativeAudioRoute() &&
      this.outputDeviceId === "default";
    try {
      const result = await this.refreshDevices();
      const outputInventoryChanged =
        outputDeviceFingerprint(result.devices) !==
        previousOutputFingerprint;
      let rerouteError: unknown;
      if (
        wasUsingDefaultInput &&
        inputDeviceFingerprint(result.devices) !== previousInputFingerprint
      ) {
        try {
          await this.setInputDevice("default", true);
        } catch (error) {
          rerouteError = error;
        }
      }
      if (
        wasUsingAutomaticNativeOutput &&
        outputInventoryChanged
      ) {
        try {
          await this.applyOutputDevice("default");
          await this.repairAllRemotePlayback(true);
        } catch (error) {
          rerouteError ??= error;
        }
      }
      if (
        this.active &&
        outputInventoryChanged &&
        !wasUsingAutomaticNativeOutput
      ) {
        await this.repairAllRemotePlayback(true);
      }
      if (
        !this.destroyed &&
        (result.inputFallback ||
          result.outputFallback ||
          deviceFingerprint(result.devices) !== previousFingerprint)
      ) {
        this.dispatchEvent(
          new CustomEvent<VoiceDevicesChange>("deviceschange", {
            detail: result,
          }),
        );
      }
      if (!this.destroyed && rerouteError) {
        this.dispatchEvent(
          new CustomEvent<string>("deviceerror", {
            detail:
              rerouteError instanceof Error
                ? rerouteError.message
                : "音频设备已刷新，但自动切换失败",
          }),
        );
      }
    } catch (error) {
      if (!this.destroyed) {
        this.dispatchEvent(
          new CustomEvent<string>("deviceerror", {
            detail:
              error instanceof Error
                ? error.message
                : "音频设备变化后无法自动刷新",
          }),
        );
      }
    }
  }

  private async createCaptureGraph(
    deviceId: string,
    noiseMode = this.noiseMode,
    preparedContext?: AudioContext,
    cancellationSignal?: AbortSignal,
  ): Promise<CaptureGraph> {
    const context =
      preparedContext ||
      new AudioContext({
        sampleRate: 48_000,
        latencyHint: "interactive",
      });
    void context.resume().catch(() => undefined);
    const profile = voiceCaptureProfileForMode(noiseMode);
    let noiseProcessor: DeepFilterNoiseProcessor | undefined;
    if (noiseMode === "strong") {
      const processorRequest = createDeepFilterNoiseProcessor(
        context,
        "attenuationLimitDb" in profile
          ? profile.attenuationLimitDb
          : 34,
      );
      try {
        noiseProcessor = await boundedVoiceOperation(
          processorRequest,
          "加载 DeepFilterNet3 语音降噪超时",
          VOICE_NOISE_PROCESSOR_TIMEOUT_MS,
        );
      } catch (error) {
        void processorRequest
          .then((lateProcessor) => lateProcessor.dispose())
          .catch(() => undefined);
        console.warn(
          "DeepFilterNet3 could not start; using browser audio processing",
          error,
        );
      }
    }

    // Natural deliberately uses the platform's low-cost AEC/NS path. Clear
    // and strong own suppression in-app, but fall back to the platform path
    // when a model cannot be initialized on an older mobile WebView.
    const browserNoiseSuppression = !noiseProcessor;
    const audio = buildVoiceCaptureConstraints(
      Boolean(noiseProcessor),
      browserNoiseSuppression,
      noiseMode !== "natural",
    );
    if (deviceId && deviceId !== "default") {
      audio.deviceId = { exact: deviceId };
    }

    let sourceStream: MediaStream;
    let selectedDeviceId = deviceId || "default";
    try {
      sourceStream = await requestVoiceUserMedia(
        {
          audio,
          video: false,
        },
        cancellationSignal,
      );
    } catch (error) {
      if (
        cancellationSignal?.aborted ||
        (error instanceof DOMException && error.name === "AbortError") ||
        error instanceof VoiceOperationTimeoutError
      ) {
        noiseProcessor?.dispose();
        await closeVoiceAudioContext(context);
        throw error;
      }
      if (!audio.deviceId) {
        noiseProcessor?.dispose();
        await closeVoiceAudioContext(context);
        throw error;
      }
      delete audio.deviceId;
      selectedDeviceId = "default";
      try {
        sourceStream = await requestVoiceUserMedia(
          {
            audio,
            video: false,
          },
          cancellationSignal,
        );
      } catch (fallbackError) {
        noiseProcessor?.dispose();
        await closeVoiceAudioContext(context);
        throw fallbackError;
      }
    }
    const sourceTrack = sourceStream.getAudioTracks()[0];
    if (!sourceTrack) {
      sourceStream.getTracks().forEach((track) => track.stop());
      noiseProcessor?.dispose();
      await closeVoiceAudioContext(context);
      throw new Error("没有找到可用的麦克风");
    }
    sourceTrack.contentHint = "speech";
    await sourceTrack
      .applyConstraints({
        echoCancellation: true,
        noiseSuppression: browserNoiseSuppression,
        autoGainControl: false,
      })
      .catch(() => {
        // Some hardware exposes immutable capture processing. The original
        // getUserMedia request and the conservative graph remain in effect.
      });

    try {
      const source = context.createMediaStreamSource(sourceStream);
      const highPass = context.createBiquadFilter();
      highPass.type = "highpass";
      highPass.frequency.value = profile.highPassFrequencyHz;
      highPass.Q.value = profile.highPassQ;
      const inputGain = context.createGain();
      // Leave headroom before neural processing. Close/hot microphones no
      // longer hit the model at full scale, while ordinary speech loses less
      // than 2 dB.
      inputGain.gain.value = profile.inputGain;
      const voicePresence = context.createBiquadFilter();
      voicePresence.type = "peaking";
      voicePresence.frequency.value = profile.presence.frequencyHz;
      voicePresence.gain.value = profile.presence.gainDb;
      voicePresence.Q.value = profile.presence.q;
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = profile.compressor.thresholdDb;
      compressor.knee.value = profile.compressor.kneeDb;
      compressor.ratio.value = profile.compressor.ratio;
      compressor.attack.value = profile.compressor.attackSeconds;
      compressor.release.value = profile.compressor.releaseSeconds;
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value =
        VOICE_CAPTURE_AUDIO_PROFILE.limiter.thresholdDb;
      limiter.knee.value = VOICE_CAPTURE_AUDIO_PROFILE.limiter.kneeDb;
      limiter.ratio.value = VOICE_CAPTURE_AUDIO_PROFILE.limiter.ratio;
      limiter.attack.value =
        VOICE_CAPTURE_AUDIO_PROFILE.limiter.attackSeconds;
      limiter.release.value =
        VOICE_CAPTURE_AUDIO_PROFILE.limiter.releaseSeconds;
      const microphoneGate = context.createGain();
      microphoneGate.gain.value =
        this.muted || this.microphoneDisabled ? 0 : 1;
      const outputGain = context.createGain();
      outputGain.gain.value = profile.outputGain;
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      const rawAnalyser = context.createAnalyser();
      rawAnalyser.fftSize = 512;
      rawAnalyser.smoothingTimeConstant = 0.25;
      const destination = context.createMediaStreamDestination();
      const conditionedInput = source
        .connect(highPass)
        .connect(inputGain);
      let deepFilterWetGain: GainNode | undefined;
      let deepFilterDryGain: GainNode | undefined;
      if (noiseProcessor?.name === "DeepFilterNet3") {
        // Keep a dry branch pulled through the graph at zero gain. If the
        // AudioWorklet throws, the platform permanently turns that node into
        // silence; this parallel branch can cross-fade in immediately instead
        // of waiting for a microphone recapture and renegotiation.
        deepFilterWetGain = context.createGain();
        deepFilterDryGain = context.createGain();
        deepFilterWetGain.gain.value = 1;
        deepFilterDryGain.gain.value = 0;
        conditionedInput
          .connect(noiseProcessor.node)
          .connect(deepFilterWetGain)
          .connect(voicePresence)
          .connect(compressor);
        conditionedInput
          .connect(rawAnalyser)
          .connect(deepFilterDryGain)
          .connect(voicePresence)
          .connect(compressor);
      } else if (noiseProcessor) {
        conditionedInput
          .connect(rawAnalyser)
          .connect(noiseProcessor.node)
          .connect(voicePresence)
          .connect(compressor);
      } else {
        conditionedInput
          .connect(rawAnalyser)
          .connect(voicePresence)
          .connect(compressor);
      }
      compressor
        .connect(microphoneGate)
        .connect(limiter)
        .connect(outputGain)
        .connect(analyser)
        .connect(destination);
      await boundedVoiceOperation(
        context.resume(),
        "启动麦克风音频处理超时",
        VOICE_AUDIO_RESUME_TIMEOUT_MS,
      );
      if (context.state !== "running") {
        throw new Error("系统没有启动麦克风音频处理，请重新点击加入连麦");
      }
      const processedTrack = destination.stream.getAudioTracks()[0];
      if (!processedTrack) {
        throw new Error("无法建立麦克风降噪处理通道");
      }
      processedTrack.contentHint = "speech";
      const graph: CaptureGraph = {
        sourceStream,
        processedStream: destination.stream,
        context,
        selectedDeviceId,
        microphoneGate,
        mixLimiter: limiter,
        destination,
        analyser,
        analyserSamples: new Float32Array(analyser.fftSize),
        rawAnalyser,
        rawAnalyserSamples: new Float32Array(rawAnalyser.fftSize),
        browserNoiseSuppression,
        processorBypassed: false,
        silentProcessorSamples: 0,
        noiseProcessor,
      };
      this.attachAccompaniment(graph);
      if (
        noiseProcessor?.name === "DeepFilterNet3" &&
        deepFilterWetGain &&
        deepFilterDryGain
      ) {
        graph.activateNoiseBypass = () => {
          if (graph.processorBypassed) return;
          graph.processorBypassed = true;
          graph.silentProcessorSamples = 0;
          const now = context.currentTime;
          deepFilterWetGain.gain.cancelScheduledValues(now);
          deepFilterDryGain.gain.cancelScheduledValues(now);
          deepFilterWetGain.gain.setValueAtTime(
            deepFilterWetGain.gain.value,
            now,
          );
          deepFilterDryGain.gain.setValueAtTime(
            deepFilterDryGain.gain.value,
            now,
          );
          deepFilterWetGain.gain.linearRampToValueAtTime(0, now + 0.03);
          deepFilterDryGain.gain.linearRampToValueAtTime(1, now + 0.03);
          try {
            noiseProcessor.bypass();
          } catch {
            // A crashed worklet cannot receive the bypass message; the
            // parallel dry path above is independent of that processor.
          }
          if (this.graph !== graph || !this.active || this.destroyed) {
            return;
          }
          if (!this.captureProcessorFallbackNotified) {
            this.captureProcessorFallbackNotified = true;
            this.dispatchEvent(
              new CustomEvent<string>("deviceerror", {
                detail:
                  "强降噪处理器异常，已无缝切换到兼容降噪，连麦会自动继续",
              }),
            );
          }
          this.emitState();
          this.scheduleCaptureRecovery(350, true);
        };
        noiseProcessor.node.addEventListener(
          "processorerror",
          graph.activateNoiseBypass,
          { once: true },
        );
      }
      return graph;
    } catch (error) {
      sourceStream.getTracks().forEach((track) => track.stop());
      noiseProcessor?.dispose();
      await closeVoiceAudioContext(context);
      throw error;
    }
  }

  private async disposeGraph(graph?: CaptureGraph): Promise<void> {
    if (!graph) return;
    this.detachAccompaniment(graph);
    graph.processedStream.getTracks().forEach((track) => track.stop());
    graph.sourceStream.getTracks().forEach((track) => track.stop());
    graph.noiseProcessor?.dispose();
    await closeVoiceAudioContext(graph.context);
  }

  private async replaceCaptureGraph(
    replacement: CaptureGraph,
  ): Promise<boolean> {
    if (!this.active || this.destroyed) {
      await this.disposeGraph(replacement);
      return false;
    }
    const replacementTrack =
      replacement.processedStream.getAudioTracks()[0];
    if (!replacementTrack) {
      await this.disposeGraph(replacement);
      throw new Error("无法建立麦克风发送音轨");
    }
    replacementTrack.enabled = true;
    this.applyMicrophoneGate(replacement);
    await Promise.all(
      [...this.peers.entries()].map(async ([peerId, peer]) => {
        const replacements = peer.pc
          .getSenders()
          .filter((sender) => sender.track?.kind === "audio")
          .map((sender) =>
            boundedVoiceOperation(
              sender.replaceTrack(replacementTrack),
              `替换 ${peerId} 的语音音轨超时`,
              VOICE_RTC_TRACK_REPLACE_TIMEOUT_MS,
            ),
          );
        const results = await Promise.allSettled(replacements);
        if (
          results.some((result) => result.status === "rejected") &&
          this.peers.get(peerId) === peer
        ) {
          this.closePeer(peerId);
          this.schedulePeerRecovery(peerId, 120, true);
        }
      }),
    );
    if (!this.active || this.destroyed) {
      // leave() closes every sender before clearing active, so no live sender
      // can retain this replacement when a queued mutation finishes late.
      await this.disposeGraph(replacement);
      return false;
    }
    const previous = this.graph;
    this.graph = replacement;
    this.bindCaptureGraphRecovery(replacement);
    await this.disposeGraph(previous);
    return true;
  }

  private bindCaptureGraphRecovery(graph: CaptureGraph): void {
    const sourceTrack = graph.sourceStream.getAudioTracks()[0];
    const processedTrack = graph.processedStream.getAudioTracks()[0];
    const scheduleIfCurrent = (delay = VOICE_CAPTURE_RECOVERY_DELAY_MS): void => {
      if (this.graph === graph && this.active && !this.destroyed) {
        this.scheduleCaptureRecovery(delay);
      }
    };
    sourceTrack?.addEventListener(
      "ended",
      () => scheduleIfCurrent(120),
      { once: true },
    );
    sourceTrack?.addEventListener("mute", () => scheduleIfCurrent());
    processedTrack?.addEventListener(
      "ended",
      () => scheduleIfCurrent(120),
      { once: true },
    );
    processedTrack?.addEventListener("mute", () => scheduleIfCurrent(350));
    graph.context.addEventListener("statechange", () => {
      if (
        graph.context.state !== "running" &&
        document.visibilityState === "visible"
      ) {
        scheduleIfCurrent(350);
      }
    });
  }

  private clearCaptureRecovery(): void {
    if (this.captureRecoveryTimer !== undefined) {
      window.clearTimeout(this.captureRecoveryTimer);
      this.captureRecoveryTimer = undefined;
    }
    this.captureRecoveryPending = false;
    this.captureRecoveryErrorNotified = false;
    this.captureRecoveryForceFallback = false;
  }

  private scheduleCaptureRecovery(
    delay = VOICE_CAPTURE_RECOVERY_DELAY_MS,
    forceFallback = false,
  ): void {
    this.captureRecoveryForceFallback ||= forceFallback;
    if (this.captureRecoveryInFlight) {
      this.captureRecoveryPending = true;
      return;
    }
    if (
      !this.active ||
      this.destroyed ||
      this.captureRecoveryTimer !== undefined
    ) {
      return;
    }
    this.captureRecoveryTimer = window.setTimeout(() => {
      this.captureRecoveryTimer = undefined;
      void this.recoverCaptureGraph();
    }, delay);
  }

  private async recoverCaptureGraph(): Promise<void> {
    if (!this.active || this.destroyed || this.captureRecoveryInFlight) {
      return;
    }
    const forceFallback = this.captureRecoveryForceFallback;
    this.captureRecoveryForceFallback = false;
    this.captureRecoveryInFlight = true;
    this.captureRecoveryPending = false;
    let retry = false;
    try {
      await this.captureMutationQueue.run(async () => {
        if (!this.active || this.destroyed) return;
        const current = this.graph;
        const sourceTrack = current?.sourceStream.getAudioTracks()[0];
        const processedTrack =
          current?.processedStream.getAudioTracks()[0];
        if (
          !forceFallback &&
          current &&
          sourceTrack?.readyState === "live" &&
          !sourceTrack.muted &&
          processedTrack?.readyState === "live" &&
          !processedTrack.muted
        ) {
          if (current.context.state !== "running") {
            await boundedVoiceOperation(
              current.context.resume(),
              "恢复麦克风处理上下文超时",
              VOICE_AUDIO_RESUME_TIMEOUT_MS,
            ).catch(() => undefined);
          }
          if (current.context.state === "running") {
            this.captureRecoveryErrorNotified = false;
            return;
          }
        }

        const replacement = await this.createCaptureGraph(
          this.inputDeviceId,
          forceFallback ? "clear" : this.noiseMode,
          undefined,
          this.captureLifecycle.signal,
        );
        if (!(await this.replaceCaptureGraph(replacement))) return;
        this.inputDeviceId = replacement.selectedDeviceId;
        localStorage.setItem(INPUT_KEY, this.inputDeviceId);
        this.captureRecoveryErrorNotified = false;
        await this.retuneVoiceSenders();
        this.emitState();
      });
    } catch (error) {
      if (!this.captureRecoveryErrorNotified && !this.destroyed) {
        this.captureRecoveryErrorNotified = true;
        this.dispatchEvent(
          new CustomEvent<string>("deviceerror", {
            detail:
              error instanceof Error
                ? `麦克风音频中断，自动恢复失败：${error.message}`
                : "麦克风音频中断，自动恢复失败",
          }),
        );
      }
      retry = true;
    } finally {
      this.captureRecoveryInFlight = false;
      const pending =
        this.captureRecoveryPending ||
        this.captureRecoveryForceFallback;
      this.captureRecoveryPending = false;
      if (retry) {
        this.scheduleCaptureRecovery(
          3_000,
          forceFallback || this.captureRecoveryForceFallback,
        );
      } else if (pending) {
        this.scheduleCaptureRecovery(
          120,
          this.captureRecoveryForceFallback,
        );
      }
    }
  }

  private async resumeAudioAfterInterruption(): Promise<void> {
    if (this.audioResumeInFlight || !this.active || this.destroyed) return;
    this.audioResumeInFlight = true;
    try {
      if (hasNativeAudioRoute()) {
        await boundedVoiceOperation(
          startNativeVoiceRoute(),
          "恢复系统语音路由超时",
          VOICE_AUDIO_RESUME_TIMEOUT_MS,
        ).catch(() => undefined);
      }
      const graph = this.graph;
      if (graph && graph.context.state !== "running") {
        await boundedVoiceOperation(
          graph.context.resume(),
          "恢复麦克风音频处理超时",
          VOICE_AUDIO_RESUME_TIMEOUT_MS,
        ).catch(() => undefined);
      }
      if (!this.active || this.destroyed || this.graph !== graph) return;
      const sourceTrack = graph?.sourceStream.getAudioTracks()[0];
      const processedTrack = graph?.processedStream.getAudioTracks()[0];
      if (
        graph &&
        (graph.context.state !== "running" ||
          sourceTrack?.readyState !== "live" ||
          sourceTrack.muted ||
          processedTrack?.readyState !== "live" ||
          processedTrack.muted)
      ) {
        this.scheduleCaptureRecovery(120);
      }
      await Promise.allSettled(
        [...this.playbackGraphs.entries()].map(
          async ([peerId, playback]) => {
            if (playback.context.state !== "running") {
              await boundedVoiceOperation(
                playback.context.resume(),
                `恢复 ${peerId} 的语音播放超时`,
                VOICE_AUDIO_RESUME_TIMEOUT_MS,
              ).catch(() => undefined);
            }
            if (
              this.playbackGraphs.get(peerId) === playback &&
              playback.context.state !== "running"
            ) {
              this.fallbackToDirectPlayback(peerId);
            }
          },
        ),
      );
      if (!this.active || this.destroyed) return;
      await this.repairAllRemotePlayback(true);
    } finally {
      this.audioResumeInFlight = false;
    }
  }

  private voiceBitrate(): number {
    return voiceBitrateForPeerCount(
      this.peers.size,
      Boolean(this.accompanimentTrack),
    );
  }

  private applyMicrophoneGate(graph = this.graph): void {
    if (!graph) return;
    const now = graph.context.currentTime;
    const value = this.muted || this.microphoneDisabled ? 0 : 1;
    graph.microphoneGate.gain.cancelScheduledValues(now);
    graph.microphoneGate.gain.setTargetAtTime(value, now, 0.012);
    graph.processedStream
      .getAudioTracks()
      .forEach((track) => {
        track.enabled = true;
      });
  }

  private attachAccompaniment(graph: CaptureGraph): void {
    const track = this.accompanimentTrack;
    if (!track || track.readyState !== "live") return;
    this.detachAccompaniment(graph);
    const stream = new MediaStream([track]);
    const source = graph.context.createMediaStreamSource(stream);
    const gain = graph.context.createGain();
    gain.gain.value = this.accompanimentVolume;
    source.connect(gain).connect(graph.mixLimiter);
    graph.accompanimentSource = source;
    graph.accompanimentGain = gain;
    const processedTrack = graph.processedStream.getAudioTracks()[0];
    if (processedTrack) processedTrack.contentHint = "music";
  }

  private detachAccompaniment(graph = this.graph): void {
    if (!graph) return;
    graph.accompanimentSource?.disconnect();
    graph.accompanimentGain?.disconnect();
    graph.accompanimentSource = undefined;
    graph.accompanimentGain = undefined;
  }

  private async retuneVoiceSenders(): Promise<void> {
    this.voiceTuneQueue = this.voiceTuneQueue
      .catch(() => undefined)
      .then(async () => {
        const targetBitrate = this.voiceBitrate();
        await Promise.allSettled(
          [...this.peers.entries()].flatMap(([peerId, peer]) => {
            const bitrate = Math.min(
              targetBitrate,
              peer.voiceBitrateController.currentBitrate,
            );
            peer.appliedVoiceBitrate = bitrate;
            return peer.pc
              .getSenders()
              .filter((sender) => sender.track?.kind === "audio")
              .map((sender) =>
                boundedVoiceOperation(
                  tuneVoiceSender(sender, bitrate),
                  `调整 ${peerId} 的语音码率超时`,
                  VOICE_RTC_TUNE_TIMEOUT_MS,
                ),
              );
          }),
        );
        this.emitState();
      })
      .catch(() => undefined);
    await this.voiceTuneQueue;
  }

  private startSpeakingMonitor(): void {
    if (this.speakingTimer !== undefined) return;
    void this.pollSpeakingLevels();
    this.speakingTimer = window.setInterval(
      () => void this.pollSpeakingLevels(),
      SPEAKING_SAMPLE_INTERVAL_MS,
    );
  }

  private stopSpeakingMonitor(): void {
    if (this.speakingTimer !== undefined) {
      window.clearInterval(this.speakingTimer);
      this.speakingTimer = undefined;
    }
    this.speakingPollRunning = false;
    for (const participantId of [...this.speakingStates.keys()]) {
      this.updateSpeakingState(participantId, 0, false);
    }
    this.speakingStates.clear();
  }

  private startPeerHealthMonitor(): void {
    if (this.peerHealthTimer !== undefined) return;
    this.requestPeerSnapshot();
    this.peerHealthTimer = window.setInterval(() => {
      this.requestPeerSnapshot();
      this.checkPeerHealth();
      void this.adaptVoiceBitrates().catch(() => undefined);
    }, VOICE_PEER_SYNC_INTERVAL_MS);
  }

  private stopPeerHealthMonitor(): void {
    if (this.peerHealthTimer !== undefined) {
      window.clearInterval(this.peerHealthTimer);
      this.peerHealthTimer = undefined;
    }
    for (const timer of this.peerRetryTimers.values()) {
      window.clearTimeout(timer);
    }
    this.peerRetryTimers.clear();
    this.voiceStatsPollRunning = false;
  }

  private async adaptVoiceBitrates(): Promise<void> {
    if (
      this.voiceStatsPollRunning ||
      !this.active ||
      this.destroyed ||
      !this.peers.size
    ) {
      return;
    }
    this.voiceStatsPollRunning = true;
    try {
      const targetBitrate = this.voiceBitrate();
      const samples = await Promise.all(
        [...this.peers.entries()].map(async ([peerId, peer]) => {
          try {
            const stats = await boundedVoiceOperation(
              readOutboundAudioStats(
                peer.pc,
                peer.outboundVoiceSnapshot,
              ),
              `读取 ${peerId} 的语音统计超时`,
              VOICE_RTC_STATS_TIMEOUT_MS,
            );
            return { peerId, peer, stats };
          } catch (error) {
            if (
              error instanceof VoiceOperationTimeoutError &&
              this.peers.get(peerId) === peer
            ) {
              this.closePeer(peerId);
              this.schedulePeerRecovery(peerId, 120, true);
            }
            return undefined;
          }
        }),
      );
      const changed: Array<{ peer: VoicePeer; bitrate: number }> = [];
      for (const sample of samples) {
        if (!sample || this.peers.get(sample.peerId) !== sample.peer) continue;
        sample.peer.outboundVoiceSnapshot = sample.stats.snapshot;
        const bitrate = sample.peer.voiceBitrateController.update(
          targetBitrate,
          sample.stats,
        );
        if (sample.peer.appliedVoiceBitrate !== bitrate) {
          changed.push({ peer: sample.peer, bitrate });
        }
      }
      if (!changed.length) return;
      this.voiceTuneQueue = this.voiceTuneQueue
        .catch(() => undefined)
        .then(async () => {
          await Promise.allSettled(
            changed.flatMap(({ peer, bitrate }) => {
              peer.appliedVoiceBitrate = bitrate;
              return peer.pc
                .getSenders()
                .filter((sender) => sender.track?.kind === "audio")
                .map((sender) =>
                  boundedVoiceOperation(
                    tuneVoiceSender(sender, bitrate),
                    "调整自适应语音码率超时",
                    VOICE_RTC_TUNE_TIMEOUT_MS,
                  ),
                );
            }),
          );
          this.emitState();
        });
      await this.voiceTuneQueue;
    } finally {
      this.voiceStatsPollRunning = false;
    }
  }

  private requestPeerSnapshot(): void {
    if (!this.active || this.destroyed) return;
    try {
      this.signal.send({ type: "voice:sync" });
      if (this.muted) {
        this.signal.send({ type: "voice:mute", muted: true });
      }
    } catch {
      // Signaling reconnection is managed by the channel session.
    }
  }

  private reconcileExpectedPeers(
    participants: Array<{
      id: string;
      voiceActive: boolean;
      microphoneMuted?: boolean;
      microphoneDisabled?: boolean;
    }>,
  ): string[] {
    const next = new Set(
      participants
        .filter(
          (participant) =>
            participant.id !== this.selfId && participant.voiceActive,
        )
        .map((participant) => participant.id),
    );
    for (const peerId of [...this.expectedPeers]) {
      if (next.has(peerId)) continue;
      this.expectedPeers.delete(peerId);
      this.expectedPeerMuteStates.delete(peerId);
      this.clearPeerRetry(peerId);
      this.closePeer(peerId);
    }
    for (const participant of participants) {
      if (
        participant.id === this.selfId ||
        !participant.voiceActive
      ) {
        continue;
      }
      const peerId = participant.id;
      const muted = Boolean(
        participant.microphoneMuted || participant.microphoneDisabled,
      );
      this.expectedPeers.add(peerId);
      this.expectedPeerMuteStates.set(peerId, muted);
      const peer = this.peers.get(peerId);
      if (peer) {
        const wasMuted = peer.signaledMuted;
        peer.signaledMuted = muted;
        if (wasMuted && !muted) {
          const unmutedAt = performance.now();
          peer.lastInboundProgressAt = unmutedAt;
          peer.recentlyUnmutedAt = unmutedAt;
          if (peer.remoteTrack?.muted) {
            peer.remoteTrackMutedAt ??= unmutedAt;
          } else {
            peer.remoteTrackMutedAt = undefined;
          }
          void this.repairRemotePlayback(peerId, true);
        } else if (muted) {
          peer.recentlyUnmutedAt = undefined;
        }
      }
    }
    return [...next];
  }

  private isRecoveryInitiator(peerId: string): boolean {
    return this.selfId.localeCompare(peerId) > 0;
  }

  private ensureMissingPeers(): void {
    if (!this.active || this.destroyed) return;
    for (const peerId of this.expectedPeers) {
      if (!this.peers.has(peerId) && this.isRecoveryInitiator(peerId)) {
        this.schedulePeerRecovery(peerId, 120);
      }
    }
  }

  private checkPeerHealth(): void {
    if (!this.active || this.destroyed) return;
    const now = performance.now();
    const captureTrack = this.graph?.sourceStream.getAudioTracks()[0];
    const processedTrack =
      this.graph?.processedStream.getAudioTracks()[0];
    if (
      this.graph?.context.state !== "running" ||
      captureTrack?.readyState !== "live" ||
      captureTrack.muted ||
      processedTrack?.readyState !== "live" ||
      processedTrack.muted
    ) {
      void this.resumeAudioAfterInterruption();
    }
    for (const [peerId, peer] of this.peers) {
      const state = peer.pc.connectionState;
      if (state === "connected") {
        peer.disconnectedAt = undefined;
        const audio = this.audioContainer.querySelector<HTMLAudioElement>(
          `audio[data-voice-peer="${CSS.escape(peerId)}"]`,
        );
        const graph = this.playbackGraphs.get(peerId);
        if (graph && graph.context.state !== "running") {
          void graph.context
            .resume()
            .then(() => {
              if (graph.context.state !== "running") {
                this.fallbackToDirectPlayback(peerId);
              }
            })
            .catch(() => this.fallbackToDirectPlayback(peerId));
        }
        if (
          peer.remoteTrack?.readyState === "ended" ||
          (
            peer.remoteTrack?.muted &&
            !peer.signaledMuted &&
            now -
              (peer.remoteTrackMutedAt || peer.lastInboundProgressAt) >=
              VOICE_REMOTE_TRACK_MUTE_GRACE_MS
          )
        ) {
          this.closePeer(peerId);
          this.schedulePeerRecovery(peerId, 120, true);
          continue;
        }
        const expectedPlaybackStream = peer.remoteStream;
        if (
          !audio ||
          audio.error ||
          audio.srcObject !== expectedPlaybackStream ||
          audio.paused
        ) {
          void this.repairRemotePlayback(
            peerId,
            Boolean(audio?.error),
          );
        }
        const mediaStallTimeout = voicePeerMediaStallTimeout(
          peer.recentlyUnmutedAt !== undefined,
        );
        if (
          !peer.signaledMuted &&
          now - peer.lastInboundProgressAt > mediaStallTimeout
        ) {
          this.closePeer(peerId);
          this.schedulePeerRecovery(peerId, 120, true);
        }
        continue;
      }
      if (state === "disconnected") {
        peer.disconnectedAt ??= now;
        if (
          now - peer.disconnectedAt <
          VOICE_PEER_DISCONNECTED_GRACE_MS
        ) {
          continue;
        }
      } else if (
        state === "new" ||
        state === "connecting"
      ) {
        if (now - peer.createdAt < VOICE_PEER_CONNECT_TIMEOUT_MS) {
          continue;
        }
      }
      this.schedulePeerRecovery(peerId);
    }
    this.ensureMissingPeers();
  }

  private clearPeerRetry(peerId: string): void {
    const timer = this.peerRetryTimers.get(peerId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.peerRetryTimers.delete(peerId);
    }
  }

  private schedulePeerRecovery(
    peerId: string,
    delay = 450,
    forceInitiator = false,
  ): void {
    if (
      !this.active ||
      this.destroyed ||
      !this.expectedPeers.has(peerId) ||
      this.peerRetryTimers.has(peerId)
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      this.peerRetryTimers.delete(peerId);
      if (
        !this.active ||
        !this.expectedPeers.has(peerId) ||
        this.destroyed
      ) {
        return;
      }
      const current = this.peers.get(peerId);
      if (current?.pc.connectionState === "connected") return;
      const failures = (this.peerFailureCounts.get(peerId) || 0) + 1;
      this.peerFailureCounts.set(peerId, failures);
      const relayOnly =
        hasTurnIceServer(this.iceServers) &&
        (current?.relayOnly === true || failures >= 1);
      if (
        failures >= 3 &&
        !this.peerNetworkErrorsReported.has(peerId)
      ) {
        this.peerNetworkErrorsReported.add(peerId);
        this.dispatchEvent(
          new CustomEvent<string>("connectionerror", {
            detail:
              relayOnly
                ? "与一位成员的语音中继仍未连通，正在继续重试；请检查代理、防火墙或服务器 TURN"
                : "与一位成员的语音通道多次连接失败，正在继续重试",
          }),
        );
      }
      if (!forceInitiator && !this.isRecoveryInitiator(peerId)) {
        if (
          current &&
          ["failed", "closed"].includes(current.pc.connectionState)
        ) {
          this.closePeer(peerId);
        }
        return;
      }
      this.closePeer(peerId);
      void this.offerTo(peerId, relayOnly).catch(() => {
        this.schedulePeerRecovery(peerId, 1_200, forceInitiator);
      });
    }, delay);
    this.peerRetryTimers.set(peerId, timer);
  }

  private localSpeakingLevel(): number {
    const graph = this.graph;
    if (!graph || !this.active || this.muted) return 0;
    try {
      graph.analyser.getFloatTimeDomainData(graph.analyserSamples);
      let outputEnergy = 0;
      for (const sample of graph.analyserSamples) {
        outputEnergy += sample * sample;
      }
      const outputLevel = Math.sqrt(
        outputEnergy / Math.max(1, graph.analyserSamples.length),
      );
      if (
        graph.noiseProcessor?.name === "DeepFilterNet3" &&
        !graph.processorBypassed
      ) {
        graph.rawAnalyser.getFloatTimeDomainData(
          graph.rawAnalyserSamples,
        );
        let rawEnergy = 0;
        for (const sample of graph.rawAnalyserSamples) {
          rawEnergy += sample * sample;
        }
        const rawLevel = Math.sqrt(
          rawEnergy / Math.max(1, graph.rawAnalyserSamples.length),
        );
        // A thrown AudioWorklet becomes an exact-zero generator for the rest
        // of its lifetime. Require repeated non-trivial raw input and
        // near-digital-zero output so ordinary denoising does not trip this.
        if (rawLevel >= 0.006 && outputLevel <= 0.000001) {
          graph.silentProcessorSamples += 1;
          if (
            graph.silentProcessorSamples >=
            PROCESSOR_SILENCE_SAMPLE_LIMIT
          ) {
            graph.activateNoiseBypass?.();
          }
        } else {
          graph.silentProcessorSamples = 0;
        }
      }
      return outputLevel;
    } catch {
      return 0;
    }
  }

  private async remoteSpeakingLevel(
    peerId: string,
    peer: VoicePeer,
  ): Promise<number> {
    let statsTimeout: number | undefined;
    const report = await Promise.race([
      peer.pc.getStats(),
      new Promise<never>((_, reject) => {
        statsTimeout = window.setTimeout(
          () => reject(new Error("voice stats timeout")),
          SPEAKING_STATS_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      if (statsTimeout !== undefined) {
        window.clearTimeout(statsTimeout);
      }
    });
    let level = 0;
    let nextEnergy: VoicePeer["audioEnergy"];
    let inboundBytes = peer.lastInboundBytes;
    report.forEach((item) => {
      const kind = item.kind || item.mediaType;
      if (item.type !== "inbound-rtp" || kind !== "audio" || item.isRemote) {
        return;
      }
      inboundBytes = Math.max(
        inboundBytes,
        Number(item.bytesReceived || 0),
      );
      const audioLevel = Number(item.audioLevel);
      if (Number.isFinite(audioLevel) && audioLevel >= 0) {
        level = Math.max(level, audioLevel);
      }
      const energy = Number(item.totalAudioEnergy);
      const duration = Number(item.totalSamplesDuration);
      if (
        Number.isFinite(energy) &&
        Number.isFinite(duration) &&
        energy >= 0 &&
        duration >= 0
      ) {
        nextEnergy = { energy, duration };
        const previous = peer.audioEnergy;
        const energyDelta = previous ? energy - previous.energy : 0;
        const durationDelta = previous ? duration - previous.duration : 0;
        if (energyDelta >= 0 && durationDelta > 0) {
          level = Math.max(level, Math.sqrt(energyDelta / durationDelta));
        }
      }
    });
    if (inboundBytes > peer.lastInboundBytes) {
      peer.lastInboundBytes = inboundBytes;
      peer.lastInboundProgressAt = performance.now();
      peer.recentlyUnmutedAt = undefined;
      this.peerFailureCounts.delete(peerId);
      this.peerNetworkErrorsReported.delete(peerId);
    }
    peer.audioEnergy = nextEnergy;
    return level;
  }

  private async pollSpeakingLevels(): Promise<void> {
    if (
      this.speakingPollRunning ||
      this.destroyed ||
      !this.active
    ) {
      return;
    }
    this.speakingPollRunning = true;
    try {
      this.updateSpeakingState(
        this.selfId,
        this.localSpeakingLevel(),
        !this.muted,
      );
      await Promise.allSettled(
        [...this.peers.entries()].map(async ([peerId, peer]) => {
          if (peer.pc.connectionState !== "connected") {
            this.updateSpeakingState(peerId, 0, false);
            return;
          }
          try {
            const level = await this.remoteSpeakingLevel(peerId, peer);
            if (this.peers.get(peerId) !== peer) return;
            this.updateSpeakingState(
              peerId,
              level,
              !peer.signaledMuted,
            );
          } catch {
            if (this.peers.get(peerId) === peer) {
              this.updateSpeakingState(peerId, 0, false);
            }
          }
        }),
      );
    } finally {
      this.speakingPollRunning = false;
    }
  }

  private updateSpeakingState(
    participantId: string,
    level: number,
    canSpeak: boolean,
  ): void {
    const now = performance.now();
    const previous = this.speakingStates.get(participantId) || {
      speaking: false,
      lastVoiceAt: 0,
      noiseFloor: 0.006,
      attackSamples: 0,
    };
    const normalizedLevel =
      Number.isFinite(level) && level > 0 ? Math.min(level, 1) : 0;
    let noiseFloor = previous.noiseFloor;
    if (canSpeak && !previous.speaking) {
      const boundedNoiseSample = Math.min(normalizedLevel, 0.04);
      const weight = normalizedLevel <= 0.025 ? 0.12 : 0.025;
      noiseFloor =
        previous.noiseFloor * (1 - weight) + boundedNoiseSample * weight;
    }
    const startThreshold = Math.max(
      SPEAKING_START_LEVEL,
      noiseFloor * 2.8,
    );
    const continueThreshold = Math.max(
      SPEAKING_CONTINUE_LEVEL,
      noiseFloor * 1.7,
    );
    const aboveStart = canSpeak && normalizedLevel >= startThreshold;
    const attackSamples = aboveStart
      ? previous.attackSamples + 1
      : 0;
    if (
      canSpeak &&
      (normalizedLevel >= continueThreshold || attackSamples >= 2)
    ) {
      previous.lastVoiceAt = now;
    }
    const speaking =
      canSpeak &&
      ((previous.speaking && normalizedLevel >= continueThreshold) ||
        attackSamples >= 2 ||
        (previous.speaking &&
          now - previous.lastVoiceAt < SPEAKING_HANGOVER_MS));
    this.speakingStates.set(participantId, {
      speaking,
      lastVoiceAt: previous.lastVoiceAt,
      noiseFloor,
      attackSamples: speaking ? attackSamples : Math.min(attackSamples, 2),
    });
    if (speaking === previous.speaking || this.destroyed) return;
    this.dispatchEvent(
      new CustomEvent<VoiceSpeakingChange>("speakingchange", {
        detail: {
          participantId,
          speaking,
          level: normalizedLevel,
        },
      }),
    );
  }

  private createPeer(
    peerId: string,
    sessionId?: string,
    relayOnly = false,
  ): VoicePeer {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    const useRelayOnly =
      relayOnly && hasTurnIceServer(this.iceServers);
    const normalizedSessionId =
      sessionId && /^[a-z0-9-]{8,64}$/i.test(sessionId)
        ? sessionId
        : crypto.randomUUID();
    let peer: VoicePeer;
    const pc = createPeerConnection(this.iceServers, (candidate) => {
      if (this.peers.get(peerId) !== peer) return;
      if (!peer.localDescriptionSent) {
        peer.pendingLocalCandidates.push(candidate);
        return;
      }
      try {
        this.signal.send({
          type: "voice:signal",
          target: peerId,
          sessionId: peer.sessionId,
          iceMode: peer.relayOnly ? "relay" : "all",
          data: candidate,
        });
      } catch {
        this.schedulePeerRecovery(peerId);
      }
    }, { relayOnly: useRelayOnly });
    peer = {
      pc,
      relayOnly: useRelayOnly,
      candidates: [],
      candidateApplyQueue: new SerialAsyncQueue(),
      remoteDescriptionApplying: false,
      sessionId: normalizedSessionId,
      createdAt: performance.now(),
      makingOffer: false,
      ignoreOffer: false,
      localDescriptionSent: false,
      pendingLocalCandidates: [],
      signaledMuted:
        this.expectedPeerMuteStates.get(peerId) === true,
      lastInboundBytes: 0,
      lastInboundProgressAt: performance.now(),
      voiceBitrateController: new AdaptiveVoiceBitrateController(
        this.voiceBitrate(),
      ),
    };
    this.peers.set(peerId, peer);
    configureVoiceJitterBuffer(pc, voiceJitterBufferTarget(useRelayOnly));

    const localTrack = this.graph?.processedStream.getAudioTracks()[0];
    if (localTrack && this.graph) {
      pc.addTrack(localTrack, this.graph.processedStream);
      void this.retuneVoiceSenders();
    } else if (this.listeningOnly) {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }
    pc.addEventListener("track", (event) => {
      if (
        this.peers.get(peerId) === peer &&
        event.track.kind === "audio"
      ) {
        configureVoiceJitterBuffer(pc, voiceJitterBufferTarget(peer.relayOnly));
        const clearSpeaking = (): void => {
          this.updateSpeakingState(peerId, 0, false);
        };
        event.track.addEventListener("mute", () => {
          clearSpeaking();
          peer.remoteTrackMutedAt ??= performance.now();
          window.setTimeout(() => {
            if (
              this.peers.get(peerId) !== peer ||
              peer.remoteTrack !== event.track ||
              !event.track.muted ||
              peer.signaledMuted
            ) {
              return;
            }
            this.closePeer(peerId);
            this.schedulePeerRecovery(peerId, 120, true);
          }, VOICE_REMOTE_TRACK_MUTE_GRACE_MS);
        });
        event.track.addEventListener("unmute", () => {
          if (this.peers.get(peerId) !== peer) return;
          peer.remoteTrackMutedAt = undefined;
          peer.lastInboundProgressAt = performance.now();
          void this.repairRemotePlayback(peerId, true);
        });
        event.track.addEventListener(
          "ended",
          () => {
            clearSpeaking();
            if (
              this.peers.get(peerId) !== peer ||
              peer.remoteTrack !== event.track
            ) {
              return;
            }
            this.closePeer(peerId);
            this.schedulePeerRecovery(peerId, 120, true);
          },
          { once: true },
        );
        const remoteStream =
          event.streams[0] || new MediaStream([event.track]);
        peer.remoteTrack = event.track;
        peer.remoteTrackMutedAt = event.track.muted
          ? performance.now()
          : undefined;
        peer.remoteStream = remoteStream;
        this.attachRemoteAudio(peerId, remoteStream);
      }
    });
    pc.addEventListener("connectionstatechange", () => {
      if (this.peers.get(peerId) !== peer) return;
      if (pc.connectionState === "connected") {
        peer.disconnectedAt = undefined;
        this.clearPeerRetry(peerId);
        // Reset the media-stall clock to connection time so the stall window
        // starts when we know the transport is alive, not at peer creation.
        peer.lastInboundProgressAt = performance.now();
        if (peer.recentlyUnmutedAt !== undefined) {
          peer.recentlyUnmutedAt = peer.lastInboundProgressAt;
        }
      } else if (pc.connectionState === "disconnected") {
        peer.disconnectedAt ??= performance.now();
        this.clearPeerRetry(peerId);
        this.schedulePeerRecovery(
          peerId,
          VOICE_PEER_DISCONNECTED_GRACE_MS,
        );
      } else if (pc.connectionState === "failed") {
        this.updateSpeakingState(peerId, 0, false);
        this.clearPeerRetry(peerId);
        this.schedulePeerRecovery(peerId, 120);
      } else if (pc.connectionState === "closed") {
        this.closePeer(peerId);
      }
      this.emitState();
    });
    return peer;
  }

  private flushLocalCandidates(peerId: string, peer: VoicePeer): void {
    if (this.peers.get(peerId) !== peer) return;
    peer.localDescriptionSent = true;
    for (const candidate of peer.pendingLocalCandidates.splice(0)) {
      try {
        this.signal.send({
          type: "voice:signal",
          target: peerId,
          sessionId: peer.sessionId,
          iceMode: peer.relayOnly ? "relay" : "all",
          data: candidate,
        });
      } catch {
        this.schedulePeerRecovery(peerId);
        return;
      }
    }
  }

  private retirePeerSession(peerId: string, sessionId: string): void {
    if (!sessionId) return;
    const retired =
      this.retiredPeerSessions.get(peerId) || new Set<string>();
    retired.add(sessionId);
    while (retired.size > 8) {
      const oldest = retired.values().next().value;
      if (!oldest) break;
      retired.delete(oldest);
    }
    this.retiredPeerSessions.set(peerId, retired);
  }

  private isRetiredPeerSession(
    peerId: string,
    sessionId?: string,
  ): boolean {
    return Boolean(
      sessionId &&
        this.retiredPeerSessions.get(peerId)?.has(sessionId),
    );
  }

  private async offerTo(
    peerId: string,
    relayOnly = false,
  ): Promise<void> {
    if (
      !this.active ||
      this.destroyed ||
      !this.expectedPeers.has(peerId)
    ) {
      return;
    }
    const peer = this.createPeer(peerId, undefined, relayOnly);
    if (
      peer.makingOffer ||
      peer.pc.connectionState === "connected" ||
      peer.pc.signalingState !== "stable"
    ) {
      return;
    }
    peer.makingOffer = true;
    try {
      const offer = tuneVoiceOpus(
        await boundedVoiceOperation(
          peer.pc.createOffer(),
          `创建 ${peerId} 的语音 offer 超时`,
          VOICE_RTC_NEGOTIATION_TIMEOUT_MS,
        ),
      );
      if (this.peers.get(peerId) !== peer) return;
      await boundedVoiceOperation(
        peer.pc.setLocalDescription(offer),
        `设置 ${peerId} 的本地语音描述超时`,
        VOICE_RTC_NEGOTIATION_TIMEOUT_MS,
      );
      if (this.peers.get(peerId) !== peer) return;
      this.signal.send({
        type: "voice:signal",
        target: peerId,
        sessionId: peer.sessionId,
        iceMode: peer.relayOnly ? "relay" : "all",
        data: serializableSessionDescription(peer.pc.localDescription!),
      });
      this.flushLocalCandidates(peerId, peer);
    } finally {
      if (this.peers.get(peerId) === peer) {
        peer.makingOffer = false;
      }
    }
  }

  private async handlePeerSignal(
    peerId: string,
    data: RTCSessionDescriptionInit | RTCIceCandidateInit,
    sessionId?: string,
    iceMode?: "all" | "relay",
  ): Promise<void> {
    const normalizedSessionId =
      sessionId && /^[a-z0-9-]{8,64}$/i.test(sessionId)
        ? sessionId
        : undefined;
    if (this.isRetiredPeerSession(peerId, normalizedSessionId)) {
      return;
    }
    const requestedRelayOnly =
      iceMode === "relay" && hasTurnIceServer(this.iceServers);
    let peer = this.peers.get(peerId);
    if ("type" in data && data.type) {
      const description = data as RTCSessionDescriptionInit;
      if (
        description.type === "answer" &&
        peer &&
        normalizedSessionId &&
        normalizedSessionId !== peer.sessionId
      ) {
        return;
      }
      if (
        description.type === "offer" &&
        peer &&
        normalizedSessionId &&
        normalizedSessionId !== peer.sessionId
      ) {
        const offerCollision =
          peer.makingOffer || peer.pc.signalingState !== "stable";
        const polite = !this.isRecoveryInitiator(peerId);
        if (offerCollision && !polite) {
          this.retirePeerSession(peerId, normalizedSessionId);
          return;
        }
        this.closePeer(peerId);
        peer = undefined;
      }
      if (
        description.type === "offer" &&
        peer &&
        peer.relayOnly !== requestedRelayOnly
      ) {
        // A fallback offer starts a fresh ICE policy. Reusing the previous
        // all-candidate connection would keep selecting the same broken TUN
        // route even though the sender explicitly requested TURN-only.
        this.closePeer(peerId, false);
        peer = undefined;
      }
      peer ||= this.createPeer(
        peerId,
        normalizedSessionId,
        requestedRelayOnly,
      );
      const offerCollision =
        description.type === "offer" &&
        (peer.makingOffer || peer.pc.signalingState !== "stable");
      const polite = !this.isRecoveryInitiator(peerId);
      peer.ignoreOffer = !polite && offerCollision;
      if (peer.ignoreOffer) {
        return;
      }
      if (offerCollision) {
        try {
          await boundedVoiceOperation(
            peer.pc.setLocalDescription({ type: "rollback" }),
            `回滚 ${peerId} 的语音协商超时`,
            VOICE_RTC_NEGOTIATION_TIMEOUT_MS,
          );
          if (this.peers.get(peerId) !== peer) return;
        } catch {
          const retainedSessionId = peer.sessionId;
          const retainedRelayOnly = peer.relayOnly;
          this.closePeer(peerId, false);
          peer = this.createPeer(
            peerId,
            retainedSessionId,
            retainedRelayOnly,
          );
        }
      }
      if (
        description.type === "answer" &&
        peer.pc.signalingState !== "have-local-offer"
      ) {
        return;
      }
      peer.remoteDescriptionApplying = true;
      try {
        await boundedVoiceOperation(
          peer.pc.setRemoteDescription(description),
          `设置 ${peerId} 的远端语音描述超时`,
          VOICE_RTC_NEGOTIATION_TIMEOUT_MS,
        );
        if (this.peers.get(peerId) !== peer) return;
        configureVoiceJitterBuffer(
          peer.pc,
          voiceJitterBufferTarget(peer.relayOnly),
        );
        peer.ignoreOffer = false;
        while (peer.candidates.length) {
          await this.applyRemoteCandidates(
            peerId,
            peer,
            peer.candidates.splice(0),
          );
        }
      } finally {
        peer.remoteDescriptionApplying = false;
      }
      if (description.type === "offer") {
        const answer = tuneVoiceOpus(
          await boundedVoiceOperation(
            peer.pc.createAnswer(),
            `创建 ${peerId} 的语音 answer 超时`,
            VOICE_RTC_NEGOTIATION_TIMEOUT_MS,
          ),
        );
        if (this.peers.get(peerId) !== peer) return;
        await boundedVoiceOperation(
          peer.pc.setLocalDescription(answer),
          `设置 ${peerId} 的本地语音 answer 超时`,
          VOICE_RTC_NEGOTIATION_TIMEOUT_MS,
        );
        if (this.peers.get(peerId) !== peer) return;
        this.signal.send({
          type: "voice:signal",
          target: peerId,
          sessionId: peer.sessionId,
          iceMode: peer.relayOnly ? "relay" : "all",
          data: serializableSessionDescription(peer.pc.localDescription!),
        });
        this.flushLocalCandidates(peerId, peer);
      }
      return;
    }
    if (
      peer &&
      normalizedSessionId &&
      normalizedSessionId !== peer.sessionId
    ) {
      return;
    }
    peer ||= this.createPeer(
      peerId,
      normalizedSessionId,
      requestedRelayOnly,
    );
    const candidate = data as RTCIceCandidateInit;
    if (peer.ignoreOffer) return;
    if (peer.pc.remoteDescription && !peer.remoteDescriptionApplying) {
      await this.applyRemoteCandidates(peerId, peer, [candidate]);
    } else {
      queuePendingVoiceCandidate(peer.candidates, candidate);
    }
  }

  private applyRemoteCandidates(
    peerId: string,
    peer: VoicePeer,
    candidates: RTCIceCandidateInit[],
  ): Promise<void> {
    if (!candidates.length) return Promise.resolve();
    return peer.candidateApplyQueue.run(async () => {
      if (
        this.peers.get(peerId) !== peer ||
        !peer.pc.remoteDescription
      ) {
        return;
      }
      for (const candidate of candidates) {
        if (this.peers.get(peerId) !== peer) return;
        await boundedVoiceOperation(
          peer.pc.addIceCandidate(candidate),
          `应用 ${peerId} 的语音 ICE candidate 超时`,
          VOICE_RTC_CANDIDATE_TIMEOUT_MS,
        ).catch(() => undefined);
      }
    });
  }

  private attachRemoteAudio(peerId: string, stream: MediaStream): void {
    let audio = this.audioContainer.querySelector<AudioWithSink>(
      `audio[data-voice-peer="${CSS.escape(peerId)}"]`,
    );
    if (!audio) {
      audio = document.createElement("audio") as AudioWithSink;
      audio.autoplay = true;
      audio.preload = "auto";
      audio.setAttribute("playsinline", "");
      audio.setAttribute("webkit-playsinline", "");
      audio.dataset.voicePeer = peerId;
      this.audioContainer.append(audio);
      audio.addEventListener("error", () =>
        this.schedulePlaybackRepair(peerId, true),
      );
      audio.addEventListener("stalled", () =>
        this.schedulePlaybackRepair(peerId, false),
      );
      audio.addEventListener("emptied", () =>
        this.schedulePlaybackRepair(peerId, false),
      );
      audio.addEventListener("pause", () =>
        this.schedulePlaybackRepair(peerId, false),
      );
    }
    this.disposePlaybackGraph(peerId);
    // A direct MediaStream is the reliable baseline. Creating a fresh Web
    // Audio context from the asynchronous ontrack callback is commonly
    // blocked/suspended by Android WebView and browsers; its destination can
    // then remain silent even though the audio element reports "playing".
    audio.srcObject = stream;
    audio.playbackRate = 1.0;
    this.applyPeerVolume(audio, peerId);
    audio.muted = false;
    void this.applySink(audio)
      .catch((error) => {
        this.dispatchEvent(
          new CustomEvent<string>("deviceerror", {
            detail:
              error instanceof Error
                ? error.message
                : "无法切换连麦播放设备",
          }),
        );
      })
      .finally(() => this.playRemoteAudio(audio!));
  }

  private schedulePlaybackRepair(
    peerId: string,
    forceReattach: boolean,
  ): void {
    if (!this.active || this.destroyed || !this.peers.has(peerId)) return;
    const existing = this.playbackRepairTimers.get(peerId);
    if (existing) {
      window.clearTimeout(existing.timer);
    }
    const request = {
      timer: 0,
      // Never let a later pause/stalled event weaken an earlier error event.
      forceReattach: forceReattach || Boolean(existing?.forceReattach),
    };
    request.timer = window.setTimeout(() => {
      if (this.playbackRepairTimers.get(peerId) !== request) return;
      this.playbackRepairTimers.delete(peerId);
      if (!this.active || this.destroyed || !this.peers.has(peerId)) return;
      void this.repairRemotePlayback(peerId, request.forceReattach);
    }, PLAYBACK_REPAIR_DEBOUNCE_MS);
    this.playbackRepairTimers.set(peerId, request);
  }

  private clearPlaybackRepair(peerId: string): void {
    const request = this.playbackRepairTimers.get(peerId);
    if (!request) return;
    window.clearTimeout(request.timer);
    this.playbackRepairTimers.delete(peerId);
  }

  private repairRemotePlayback(
    peerId: string,
    forceReattach = false,
  ): Promise<void> {
    const existing = this.playbackRepairQueues.get(peerId);
    if (existing) {
      existing.forceReattach ||= forceReattach;
      existing.rerun = true;
      return existing.promise;
    }
    const queue: PlaybackRepairQueue = {
      forceReattach,
      rerun: true,
      promise: Promise.resolve(),
    };
    queue.promise = (async () => {
      while (queue.rerun) {
        queue.rerun = false;
        const shouldForceReattach = queue.forceReattach;
        queue.forceReattach = false;
        await this.performRemotePlaybackRepair(
          peerId,
          shouldForceReattach,
        );
        if (!this.active || this.destroyed || !this.peers.has(peerId)) {
          queue.rerun = false;
        }
      }
    })().finally(() => {
      if (this.playbackRepairQueues.get(peerId) === queue) {
        this.playbackRepairQueues.delete(peerId);
      }
    });
    this.playbackRepairQueues.set(peerId, queue);
    return queue.promise;
  }

  private async performRemotePlaybackRepair(
    peerId: string,
    forceReattach: boolean,
  ): Promise<void> {
    const peer = this.peers.get(peerId);
    const stream = peer?.remoteStream;
    if (!peer || !stream || !this.active || this.destroyed) return;
    let audio = this.audioContainer.querySelector<AudioWithSink>(
      `audio[data-voice-peer="${CSS.escape(peerId)}"]`,
    );
    if (!audio) {
      this.attachRemoteAudio(peerId, stream);
      return;
    }
    if (forceReattach) {
      this.disposePlaybackGraph(peerId);
    }
    if (forceReattach || audio.srcObject !== stream) {
      audio.srcObject = null;
      audio.srcObject = stream;
    }
    audio.autoplay = true;
    audio.playbackRate = 1;
    this.applyPeerVolume(audio, peerId);
    await this.applySink(audio).catch((error) => {
      this.dispatchEvent(
        new CustomEvent<string>("deviceerror", {
          detail:
            error instanceof Error
              ? error.message
              : "无法恢复连麦播放设备",
        }),
      );
    });
    this.playRemoteAudio(audio);
  }

  private async repairAllRemotePlayback(
    forceReattach = false,
  ): Promise<void> {
    await Promise.allSettled(
      [...this.peers.keys()].map((peerId) =>
        this.repairRemotePlayback(peerId, forceReattach),
      ),
    );
  }

  private async applyOutputDevice(deviceId: string): Promise<void> {
    if (hasNativeAudioRoute()) {
      if (this.active) {
        await boundedVoiceOperation(
          setNativeVoiceOutput(deviceId),
          "切换系统语音输出超时",
          VOICE_DEVICE_OPERATION_TIMEOUT_MS,
        );
      }
      return;
    }
    const audioElements =
      this.audioContainer.querySelectorAll<AudioWithSink>(
        "audio[data-voice-peer]",
      );
    const selected = deviceId === "default" ? "" : deviceId;
    for (const [peerId, playback] of this.playbackGraphs) {
      const context = playback.context as AudioContextWithSink;
      if (!context.setSinkId) {
        if (selected) this.fallbackToDirectPlayback(peerId);
        continue;
      }
      await boundedVoiceOperation(
        context.setSinkId(selected),
        `切换 ${peerId} 的增强语音输出超时`,
        VOICE_DEVICE_OPERATION_TIMEOUT_MS,
      );
    }
    for (const audio of audioElements) {
      if (!audio.setSinkId) {
        if (selected) {
          throw new Error("当前系统不支持在应用内切换扬声器");
        }
        continue;
      }
      await this.setSinkWithTimeout(audio, selected);
    }
  }

  private async applySink(audio: AudioWithSink): Promise<void> {
    if (hasNativeAudioRoute() || !audio.setSinkId) return;
    await this.setSinkWithTimeout(
      audio,
      this.outputDeviceId === "default" ? "" : this.outputDeviceId,
    );
  }

  private async setSinkWithTimeout(
    audio: AudioWithSink,
    deviceId: string,
  ): Promise<void> {
    if (!audio.setSinkId) return;
    let timeout: number | undefined;
    try {
      const sinkChange = audio.setSinkId(deviceId);
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error("切换连麦播放设备超时（setSinkId）")),
          PLAYBACK_SINK_TIMEOUT_MS,
        );
      });
      await Promise.race([sinkChange, deadline]);
    } finally {
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
    }
  }

  private effectivePeerVolume(peerId: string): number {
    return Math.min(
      2,
      Math.max(
        0,
        this.volume * (this.peerVolumes.get(peerId) ?? 1),
      ),
    );
  }

  private playRemoteAudio(audio: HTMLAudioElement): void {
    const peerId = audio.dataset.voicePeer || "";
    void audio
      .play()
      .then(() => {
        delete audio.dataset.voicePlaybackError;
        if (peerId) {
          this.blockedPlaybackPeers.delete(peerId);
          if (this.blockedPlaybackPeers.size === 0) {
            this.disarmPlaybackGestureRetry();
          }
        }
      })
      .catch((error: unknown) => {
        if (
          this.destroyed ||
          !this.active ||
          !peerId ||
          !this.peers.has(peerId)
        ) {
          return;
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "NotAllowedError"
        ) {
          this.armPlaybackGestureRetry(peerId);
        }
        if (audio.dataset.voicePlaybackError === "true") return;
        audio.dataset.voicePlaybackError = "true";
        this.dispatchEvent(
          new CustomEvent<string>("playbackerror", {
            detail:
              "系统阻止了连麦声音播放，请点击页面任意位置，系统会自动重试",
          }),
        );
      });
  }

  private armPlaybackGestureRetry(peerId: string): void {
    this.blockedPlaybackPeers.add(peerId);
    if (this.playbackGestureRetryArmed) return;
    this.playbackGestureRetryArmed = true;
    document.addEventListener("pointerdown", this.handlePlaybackGesture, {
      capture: true,
      once: true,
    });
    document.addEventListener("touchend", this.handlePlaybackGesture, {
      capture: true,
      once: true,
    });
    document.addEventListener("keydown", this.handlePlaybackGesture, {
      capture: true,
      once: true,
    });
  }

  private disarmPlaybackGestureRetry(): void {
    if (!this.playbackGestureRetryArmed) return;
    this.playbackGestureRetryArmed = false;
    document.removeEventListener(
      "pointerdown",
      this.handlePlaybackGesture,
      true,
    );
    document.removeEventListener(
      "touchend",
      this.handlePlaybackGesture,
      true,
    );
    document.removeEventListener(
      "keydown",
      this.handlePlaybackGesture,
      true,
    );
  }

  private async enableBoostedPlayback(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    const stream = peer?.remoteStream;
    const audio = this.audioContainer.querySelector<AudioWithSink>(
      `audio[data-voice-peer="${CSS.escape(peerId)}"]`,
    );
    if (
      !peer ||
      !stream ||
      !audio ||
      peer.boostingPlayback ||
      this.playbackGraphs.has(peerId) ||
      this.effectivePeerVolume(peerId) <= 1
    ) {
      return;
    }
    peer.boostingPlayback = true;
    let context: AudioContext | undefined;
    let graphInstalled = false;
    let graphFailed = false;
    try {
      context = new AudioContext({
        sampleRate: 48_000,
        latencyHint: "interactive",
      });
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value =
        VOICE_CAPTURE_AUDIO_PROFILE.limiter.thresholdDb;
      limiter.knee.value = VOICE_CAPTURE_AUDIO_PROFILE.limiter.kneeDb;
      limiter.ratio.value = VOICE_CAPTURE_AUDIO_PROFILE.limiter.ratio;
      limiter.attack.value =
        VOICE_CAPTURE_AUDIO_PROFILE.limiter.attackSeconds;
      limiter.release.value =
        VOICE_CAPTURE_AUDIO_PROFILE.limiter.releaseSeconds;
      source.connect(gain).connect(limiter).connect(context.destination);
      const contextWithSink = context as AudioContextWithSink;
      if (contextWithSink.setSinkId) {
        await contextWithSink.setSinkId(
          this.outputDeviceId === "default" ? "" : this.outputDeviceId,
        );
      } else if (this.outputDeviceId !== "default") {
        throw new Error("当前系统无法为增强音量选择指定扬声器");
      }
      await boundedVoiceOperation(
        context.resume(),
        `启动 ${peerId} 的增强语音播放超时`,
        VOICE_AUDIO_RESUME_TIMEOUT_MS,
      );
      if (
        context.state !== "running" ||
        this.peers.get(peerId) !== peer ||
        peer.remoteStream !== stream ||
        this.effectivePeerVolume(peerId) <= 1
      ) {
        throw new Error("boosted playback unavailable");
      }
      this.playbackGraphs.set(peerId, {
        context,
        source,
        gain,
        limiter,
      });
      graphInstalled = true;
      context = undefined;
      audio.srcObject = stream;
      audio.muted = true;
      gain.gain.value = boostedPlaybackGain(
        this.effectivePeerVolume(peerId),
      );
      audio.volume = 1;
      this.playRemoteAudio(audio);
    } catch {
      graphFailed = true;
      if (context) await closeVoiceAudioContext(context);
      this.fallbackToDirectPlayback(peerId);
    } finally {
      if (this.peers.get(peerId) === peer) {
        peer.boostingPlayback = false;
        if (
          graphInstalled &&
          !graphFailed &&
          peer.remoteStream === stream &&
          this.effectivePeerVolume(peerId) > 1 &&
          !this.playbackGraphs.has(peerId)
        ) {
          const currentAudio =
            this.audioContainer.querySelector<HTMLAudioElement>(
              `audio[data-voice-peer="${CSS.escape(peerId)}"]`,
            );
          if (currentAudio) {
            this.applyPeerVolume(currentAudio, peerId);
          }
        }
      }
    }
  }

  private fallbackToDirectPlayback(peerId: string): void {
    const stream = this.peers.get(peerId)?.remoteStream;
    const audio = this.audioContainer.querySelector<HTMLAudioElement>(
      `audio[data-voice-peer="${CSS.escape(peerId)}"]`,
    );
    this.disposePlaybackGraph(peerId);
    if (!stream || !audio) return;
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }
    audio.muted = false;
    audio.volume = Math.min(1, this.effectivePeerVolume(peerId));
    this.playRemoteAudio(audio);
  }

  private applyPeerVolume(audio: HTMLAudioElement, peerId: string): void {
    const effectiveVolume = this.effectivePeerVolume(peerId);
    const graph = this.playbackGraphs.get(peerId);
    if (
      graph &&
      graph.context.state === "running" &&
      effectiveVolume > 1
    ) {
      graph.gain.gain.setTargetAtTime(
        boostedPlaybackGain(effectiveVolume),
        graph.context.currentTime,
        0.015,
      );
      audio.muted = true;
      audio.volume = 1;
      return;
    }
    if (graph) {
      this.fallbackToDirectPlayback(peerId);
    } else {
      const stream = this.peers.get(peerId)?.remoteStream;
      if (stream && audio.srcObject !== stream) {
        audio.srcObject = stream;
      }
      audio.muted = false;
      audio.volume = Math.min(1, effectiveVolume);
    }
    if (effectiveVolume > 1) {
      void this.enableBoostedPlayback(peerId);
    }
  }

  private disposePlaybackGraph(peerId: string): void {
    const graph = this.playbackGraphs.get(peerId);
    if (!graph) return;
    this.playbackGraphs.delete(peerId);
    graph.source.disconnect();
    graph.gain.disconnect();
    graph.limiter.disconnect();
    void closeVoiceAudioContext(graph.context);
  }

  private closePeer(peerId: string, retireSession = true): void {
    this.updateSpeakingState(peerId, 0, false);
    this.speakingStates.delete(peerId);
    const peer = this.peers.get(peerId);
    if (peer) {
      this.peers.delete(peerId);
      if (retireSession) {
        this.retirePeerSession(peerId, peer.sessionId);
      }
      peer.pc.close();
    }
    this.clearPlaybackRepair(peerId);
    const repairQueue = this.playbackRepairQueues.get(peerId);
    if (repairQueue) {
      repairQueue.forceReattach = false;
      repairQueue.rerun = false;
    }
    this.blockedPlaybackPeers.delete(peerId);
    if (this.blockedPlaybackPeers.size === 0) {
      this.disarmPlaybackGestureRetry();
    }
    this.disposePlaybackGraph(peerId);
    this.audioContainer
      .querySelector<HTMLAudioElement>(
        `audio[data-voice-peer="${CSS.escape(peerId)}"]`,
      )
      ?.remove();
    void this.retuneVoiceSenders();
    this.emitState();
  }

  private emitState(): void {
    if (this.destroyed) return;
    this.dispatchEvent(
      new CustomEvent<VoiceState>("statechange", { detail: this.state }),
    );
  }
}
