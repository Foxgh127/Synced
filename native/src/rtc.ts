import type { QualityPreset } from "./config";
import { safeVideoEncodingTarget } from "./capture-resolution";
import type {
  NetworkAdvice,
  NetworkReport,
} from "./network-quality";
import type { SfuAccess } from "./sfu";

const SIGNAL_OPEN_TIMEOUT_MS = 15_000;
const SIGNAL_HEARTBEAT_INTERVAL_MS = 10_000;
const SIGNAL_HEARTBEAT_TIMEOUT_MS = 60_000;
const SIGNAL_TIMER_SUSPENSION_MS = 25_000;

export interface RoomParticipant {
  id: string;
  nickname: string;
  role: "host" | "viewer";
  voiceActive: boolean;
  microphoneMuted?: boolean;
  microphoneDisabled?: boolean;
  broadcasting?: boolean;
  embyCapabilities?: EmbyReceiverCapabilities;
}

export interface BroadcastCapabilities {
  width: number;
  height: number;
  frameRate: number;
  mode?: "screen" | "emby";
  contentMode?: "detail" | "motion" | "balanced";
  mimeType?: string;
  videoCodec?: string;
  audioCodec?: string;
  title?: string;
  bitrate?: number;
  durationTicks?: number;
}

export interface EmbyReceiverCapabilities {
  mse: boolean;
  h264: boolean;
  hevc: boolean;
  aac: boolean;
  desktop: boolean;
  videoEnhancementBackends?: Array<"webgl2-spatial" | "rtx-video">;
  maxEnhancementPixels?: number;
}

export interface SegmentRelayAccess {
  basePath: string;
  token: string;
  scope: "read" | "publish";
  expiresAt: number;
}

export interface SignalEnvelope {
  type: string;
  protocolVersion?: number;
  features?: string[];
  serverFeatures?: string[];
  requestedType?: string;
  room?: string;
  clientId?: string;
  channelName?: string;
  nickname?: string;
  viewerId?: string;
  viewerIds?: string[];
  broadcasterId?: string;
  created?: boolean;
  code?: string;
  codec?: string;
  codecs?: string[];
  embyCapabilities?: EmbyReceiverCapabilities;
  attempt?: number;
  sessionId?: string;
  iceMode?: "all" | "relay";
  canBroadcast?: boolean;
  createIfMissing?: boolean;
  reason?: string;
  participantId?: string;
  participant?: RoomParticipant;
  participants?: RoomParticipant[];
  target?: string;
  from?: string;
  disabled?: boolean;
  active?: boolean;
  sfuRole?: "publisher" | "viewer";
  muted?: boolean;
  resumed?: boolean;
  data?: RTCSessionDescriptionInit | RTCIceCandidateInit;
  iceServers?: RTCIceServer[];
  iceExpiresAt?: number;
  iceRefreshToken?: string;
  sfu?: SfuAccess;
  segmentRelay?: SegmentRelayAccess;
  message?: string;
  messageId?: string;
  ownerToken?: string;
  resumeToken?: string;
  senderId?: string;
  text?: string;
  sentAt?: number;
  height?: number;
  frameRate?: number;
  originalDemand?: boolean;
  lowDemand?: boolean;
  availableDownloadBps?: number;
  broadcastCapabilities?: BroadcastCapabilities;
  probeId?: string;
  phase?: "latency" | "upload" | "download";
  sequence?: number;
  total?: number;
  payload?: string;
  payloadBytes?: number;
  probeVersion?: 1 | 2;
  networkProbe?: {
    versions?: number[];
    latencySamples?: number;
    version1?: {
      chunkBytes?: number;
      maximumChunks?: number;
      maximumBytesPerDirection?: number;
    };
    version2?: {
      chunkBytes?: number;
      maximumChunks?: number;
      maximumBytesPerDirection?: number;
    };
  };
  networkReport?: NetworkReport;
  networkAdvice?: NetworkAdvice;
}

export const MAX_SIGNAL_MESSAGE_BYTES = 256 * 1024;

export function parseSignalEnvelope(value: unknown): SignalEnvelope | undefined {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > MAX_SIGNAL_MESSAGE_BYTES ||
    new TextEncoder().encode(value).byteLength > MAX_SIGNAL_MESSAGE_BYTES
  ) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const type = (parsed as { type?: unknown }).type;
    if (
      typeof type !== "string" ||
      !/^[a-z][a-z0-9:_-]{0,95}$/i.test(type)
    ) {
      return undefined;
    }
    return parsed as SignalEnvelope;
  } catch {
    return undefined;
  }
}

export class SignalClient extends EventTarget {
  private socket?: WebSocket;
  private heartbeatTimer?: number;
  private requestedUrl?: string;
  private connectGeneration = 0;
  private lastServerActivity = 0;
  private lastHeartbeatTickAt = 0;
  private networkProbeVersions?: Array<1 | 2>;

  private candidateUrls(input: string): string[] {
    const candidates = [input];
    try {
      const url = new URL(input);
      // Keep the legacy plain-WebSocket fallback only for an explicitly
      // entered development endpoint. Production defaults to trusted WSS on
      // TCP 443, which is the most consistently reachable mobile path.
      if (url.protocol === "ws:" && url.port === "8787") {
        const fallback = new URL(url);
        fallback.port = "443";
        candidates.push(fallback.toString());
      }
    } catch {
      // normalizeSignalUrl reports malformed input before this point.
    }
    return [...new Set(candidates)];
  }

  async connect(url: string): Promise<void> {
    this.requestedUrl = url;
    const generation = ++this.connectGeneration;
    this.disconnectSocket(4001, "client reconnect");
    const attempts = this.candidateUrls(url).map((candidate) =>
      this.openSocket(candidate),
    );
    let socket: WebSocket;
    try {
      // Mobile operators and proxy tools frequently allow only one of 8787
      // and 443. Race both endpoints instead of making the user wait for an
      // eight-second timeout before trying the usable path.
      socket = await Promise.any(attempts);
    } catch {
      throw new Error("无法连接信令服务器");
    }
    for (const attempt of attempts) {
      void attempt.then((candidateSocket) => {
        if (candidateSocket !== socket) candidateSocket.close(1000, "alternate path");
      }).catch(() => undefined);
    }
    if (generation !== this.connectGeneration || !this.requestedUrl) {
      socket.close(1000, "superseded");
      throw new Error("连接已被新的网络请求替代");
    }
    this.attachSocket(socket);
    this.dispatchEvent(new Event("open"));
  }

  async reconnect(): Promise<void> {
    if (!this.requestedUrl) {
      throw new Error("没有可重连的服务器地址");
    }
    await this.connect(this.requestedUrl);
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get supportedNetworkProbeVersions(): ReadonlyArray<1 | 2> | undefined {
    return this.networkProbeVersions
      ? [...this.networkProbeVersions]
      : undefined;
  }

  private openSocket(url: string): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close(4002, "open timeout");
        reject(new Error("连接服务器超时"));
      }, SIGNAL_OPEN_TIMEOUT_MS);

      socket.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(socket);
      }, { once: true });
      socket.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        socket.close(1000, "open failed");
        reject(new Error("无法连接信令服务器"));
      }, { once: true });
      socket.addEventListener("close", () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(new Error("服务器在握手前断开"));
      }, { once: true });
    });
  }

  private attachSocket(socket: WebSocket): void {
    this.socket = socket;
    this.lastServerActivity = Date.now();
    this.lastHeartbeatTickAt = this.lastServerActivity;
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.lastServerActivity = Date.now();
      const detail = parseSignalEnvelope(event.data);
      if (!detail) return;
      if (detail.type === "server:hello") {
        const versions = Array.isArray(detail.networkProbe?.versions)
          ? detail.networkProbe.versions
              .map(Number)
              .filter((version): version is 1 | 2 =>
                version === 1 || version === 2,
              )
          : [];
        this.networkProbeVersions = [...new Set(versions)].sort(
          (left, right) => left - right,
        );
      }
      this.dispatchEvent(new CustomEvent<SignalEnvelope>("message", { detail }));
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.stopHeartbeat();
      this.dispatchEvent(new Event("close"));
    });
    socket.addEventListener("error", () => {
      // The close event is the single authoritative disconnect signal.
    });
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
        const now = Date.now();
        const timerGap = now - this.lastHeartbeatTickAt;
        this.lastHeartbeatTickAt = now;
        // Chromium pauses renderer timers while a mobile WebView is backgrounded
        // or the system is under pressure. Advance lastServerActivity by the
        // actual wall-clock gap so the pre-suspension idle time is preserved.
        // Resetting to `now` previously granted a full SIGNAL_HEARTBEAT_TIMEOUT_MS
        // fresh window on every wake-up, meaning a server that died before the
        // device went to sleep was never detected until the next backgrounding cycle.
        if (timerGap > SIGNAL_TIMER_SUSPENSION_MS) {
          this.lastServerActivity = Math.min(now, this.lastServerActivity + timerGap);
        } else if (now - this.lastServerActivity > SIGNAL_HEARTBEAT_TIMEOUT_MS) {
          socket.close(4000, "heartbeat timeout");
          return;
        }
        try {
          socket.send(JSON.stringify({ type: "ping" }));
        } catch {
          socket.close(4000, "heartbeat send failed");
        }
      }
    }, SIGNAL_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  send(message: SignalEnvelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("信令服务器尚未连接");
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.requestedUrl = undefined;
    this.connectGeneration += 1;
    this.disconnectSocket(1000, "client close");
  }

  private disconnectSocket(code = 1000, reason = "client close"): void {
    const socket = this.socket;
    this.socket = undefined;
    this.networkProbeVersions = undefined;
    this.stopHeartbeat();
    if (
      socket &&
      (socket.readyState === WebSocket.CONNECTING ||
        socket.readyState === WebSocket.OPEN)
    ) {
      socket.close(code, reason);
    }
  }
}

export function createPeerConnection(
  iceServers: RTCIceServer[],
  onIceCandidate: (candidate: RTCIceCandidateInit) => void,
  options: {
    directOnly?: boolean;
    relayOnly?: boolean;
    candidatePolicy?: DirectIceCandidatePolicy;
    localAddresses?: string[];
  } = {},
): RTCPeerConnection {
  const iceMode: PeerIceMode = options.directOnly
    ? "direct"
    : options.relayOnly
      ? "relay"
      : "all";
  const configuredIceServers = selectPeerIceServers(iceServers, iceMode);
  const pc = new RTCPeerConnection({
    iceServers: configuredIceServers,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceTransportPolicy: options.relayOnly ? "relay" : "all",
    // Huawei/Honor WebViews can create pooled sockets before Android binds
    // them to the active network, yielding unusable 0.0.0.0 candidates. Other
    // platforms benefit from two pre-gathered pools on high-latency links.
    iceCandidatePoolSize: shouldDisableIceCandidatePool() ? 0 : 2,
  });
  const debugGlobal = globalThis as typeof globalThis & {
    __syncedRtcPeers?: Array<{
      id: number;
      createdAt: number;
      directOnly: boolean;
      relayOnly: boolean;
      localAddresses: string[];
      localCandidates: Array<{ raw: string; sent: string }>;
      errors: Array<{
        code?: number;
        text?: string;
        url?: string;
        address?: string;
        port?: number;
      }>;
      states: Array<{
        at: number;
        connection: RTCPeerConnectionState;
        ice: RTCIceConnectionState;
        gathering: RTCIceGatheringState;
        signaling: RTCSignalingState;
      }>;
      pc: RTCPeerConnection;
    }>;
  };
  const peers = (debugGlobal.__syncedRtcPeers ||= []);
  const debugPeer = {
    id: (peers.at(-1)?.id || 0) + 1,
    createdAt: Date.now(),
    directOnly: options.directOnly === true,
    relayOnly: options.relayOnly === true,
    localAddresses: [...(options.localAddresses || [])],
    localCandidates: [] as Array<{ raw: string; sent: string }>,
    errors: [] as Array<{
      code?: number;
      text?: string;
      url?: string;
      address?: string;
      port?: number;
    }>,
    states: [] as Array<{
      at: number;
      connection: RTCPeerConnectionState;
      ice: RTCIceConnectionState;
      gathering: RTCIceGatheringState;
      signaling: RTCSignalingState;
    }>,
    pc,
  };
  peers.push(debugPeer);
  if (peers.length > 24) peers.splice(0, peers.length - 24);

  const recordState = (): void => {
    const previous = debugPeer.states.at(-1);
    if (
      previous?.connection === pc.connectionState &&
      previous.ice === pc.iceConnectionState &&
      previous.gathering === pc.iceGatheringState &&
      previous.signaling === pc.signalingState
    ) {
      return;
    }
    debugPeer.states.push({
      at: Date.now(),
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      gathering: pc.iceGatheringState,
      signaling: pc.signalingState,
    });
    if (debugPeer.states.length > 40) debugPeer.states.shift();
  };
  for (const eventName of [
    "connectionstatechange",
    "iceconnectionstatechange",
    "icegatheringstatechange",
    "signalingstatechange",
  ]) {
    pc.addEventListener(eventName, recordState);
  }
  pc.addEventListener("icecandidateerror", (event) => {
    const failure = event as RTCPeerConnectionIceErrorEvent;
    debugPeer.errors.push({
      code: failure.errorCode,
      text: failure.errorText,
      url: failure.url,
      address: failure.address || undefined,
      port: failure.port ?? undefined,
    });
    if (debugPeer.errors.length > 24) debugPeer.errors.shift();
  });
  recordState();

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      const candidate = exposeLocalIceCandidate(
        event.candidate.toJSON(),
        options.localAddresses || [],
      );
      debugPeer.localCandidates.push({
        raw: event.candidate.candidate,
        sent: candidate.candidate || "",
      });
      if (debugPeer.localCandidates.length > 40) {
        debugPeer.localCandidates.shift();
      }
      if (
        options.directOnly
          ? isUsableDirectIceCandidate(
              candidate,
              options.candidatePolicy || "balanced",
              options.localAddresses || [],
            )
          : !options.candidatePolicy ||
            isUsableIceCandidate(
              candidate,
              options.candidatePolicy,
              options.localAddresses || [],
            )
      ) {
        onIceCandidate(candidate);
      }
    }
  });
  return pc;
}

export function shouldDisableIceCandidatePool(
  userAgent = globalThis.navigator?.userAgent || "",
  nativeHuawei = Boolean(
    (
      globalThis as typeof globalThis & {
        roomDesktop?: { isHuawei?: boolean };
      }
    ).roomDesktop?.isHuawei,
  ),
): boolean {
  return (
    nativeHuawei ||
    /\b(?:huawei|honor|harmonyos)\b/iu.test(String(userAgent))
  );
}

export type DirectIceCandidatePolicy = "balanced" | "public" | "lan";
export type PeerIceMode = "all" | "direct" | "relay";

function iceServerUrls(server: RTCIceServer): string[] {
  return (Array.isArray(server.urls) ? server.urls : [server.urls])
    .map(String)
    .filter(Boolean);
}

export function hasTurnIceServer(iceServers: RTCIceServer[]): boolean {
  return iceServers.some((server) =>
    iceServerUrls(server).some((url) => /^turns?:/i.test(url)),
  );
}

export function selectPeerIceServers(
  iceServers: RTCIceServer[],
  mode: PeerIceMode,
): RTCIceServer[] {
  if (mode === "all") return iceServers;
  const protocolPattern =
    mode === "relay" ? /^turns?:/i : /^stuns?:/i;
  return iceServers.flatMap((server) => {
    const urls = iceServerUrls(server).filter((url) =>
      protocolPattern.test(url),
    );
    return urls.length ? [{ ...server, urls }] : [];
  });
}

interface ParsedIceCandidate {
  address?: string;
  relatedAddress?: string;
  type?: string;
}

function preferredLocalIpv4(addresses: string[]): string | undefined {
  return addresses.find(
    (address) =>
      /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address) &&
      !/^198\.(?:18|19)\./.test(address),
  );
}

export function serializableSessionDescription(
  description: RTCSessionDescriptionInit,
): RTCSessionDescriptionInit {
  // RTCSessionDescription exposes `type` and `sdp` through prototype accessors.
  // Spreading the native object therefore silently drops both fields and the
  // signaling server quite correctly rejects the resulting `{}` payload.
  return {
    type: description.type,
    ...(description.sdp !== undefined ? { sdp: description.sdp } : {}),
  };
}

function exposeCandidateLine(candidateLine: string, addresses: string[]): string {
  const address = preferredLocalIpv4(addresses);
  if (!address) return candidateLine;
  const prefix = candidateLine.match(/^a=/i)?.[0] || "";
  const value = prefix ? candidateLine.slice(prefix.length) : candidateLine;
  const fields = value.trim().split(/\s+/);
  const typeIndex = fields.findIndex(
    (field) => field.toLocaleLowerCase() === "typ",
  );
  const candidateAddress = fields[4]
    ?.replace(/^\[|\]$/g, "")
    .toLocaleLowerCase();
  const addressNeedsExposure =
    candidateAddress?.endsWith(".local") ||
    candidateAddress === "0.0.0.0" ||
    candidateAddress === "::";
  if (
    fields.length < 8 ||
    typeIndex < 0 ||
    fields[typeIndex + 1]?.toLocaleLowerCase() !== "host" ||
    !addressNeedsExposure
  ) {
    return candidateLine;
  }
  fields[4] = address;
  return `${prefix}${fields.join(" ")}`;
}

export function exposeLocalIceCandidate(
  candidate: RTCIceCandidateInit,
  addresses: string[],
): RTCIceCandidateInit {
  if (!candidate.candidate || !addresses.length) return candidate;
  return {
    ...candidate,
    candidate: exposeCandidateLine(candidate.candidate, addresses),
  };
}

export function exposeLocalIceDescription(
  description: RTCSessionDescriptionInit,
  addresses: string[],
): RTCSessionDescriptionInit {
  if (!description.sdp || !addresses.length) {
    return serializableSessionDescription(description);
  }
  return {
    type: description.type,
    sdp: description.sdp
      .split(/\r?\n/)
      .map((line) =>
        /^a=candidate:/i.test(line)
          ? exposeCandidateLine(line, addresses)
          : line,
      )
      .join("\r\n"),
  };
}

function parsedIceCandidate(candidateLine = ""): ParsedIceCandidate {
  const normalized = candidateLine
    .trim()
    .replace(/^a=/i, "")
    .replace(/^candidate:/i, "");
  const fields = normalized.split(/\s+/);
  const typeIndex = fields.findIndex(
    (field) => field.toLocaleLowerCase() === "typ",
  );
  const relatedIndex = fields.findIndex(
    (field) => field.toLocaleLowerCase() === "raddr",
  );
  return {
    address: fields[4]?.replace(/^\[|\]$/g, "").toLocaleLowerCase(),
    relatedAddress:
      relatedIndex >= 0
        ? fields[relatedIndex + 1]
            ?.replace(/^\[|\]$/g, "")
            .toLocaleLowerCase()
        : undefined,
    type:
      typeIndex >= 0
        ? fields[typeIndex + 1]?.toLocaleLowerCase()
        : undefined,
  };
}

function isTunnelAddress(address?: string): boolean {
  if (!address) return false;
  const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  return (
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

function isBenchmarkOrVirtualAddress(address?: string): boolean {
  if (!address) return false;
  if (
    address === "0.0.0.0" ||
    address === "::" ||
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("169.254.") ||
    address.startsWith("fe80:")
  ) {
    return true;
  }
  // RFC 2544 benchmarking space is widely used by Clash/Mihomo TUN adapters.
  // Advertising it as a WebRTC host candidate makes peers probe the virtual
  // tunnel rather than the physical LAN and can produce a one-way ICE path.
  return isTunnelAddress(address);
}

function isPrivateAddress(address?: string): boolean {
  if (!address) return false;
  if (
    address.endsWith(".local") ||
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  ) {
    return true;
  }
  if (!address.includes(":")) return false;
  const firstGroup = Number.parseInt(address.split(":")[0] || "0", 16);
  return (firstGroup & 0xfe00) === 0xfc00;
}

export function isRelayIceCandidate(
  candidate: RTCIceCandidateInit,
): boolean {
  return /\btyp\s+relay\b/i.test(candidate.candidate || "");
}

/**
 * Keep safe direct candidates and TURN relay candidates while rejecting host
 * candidates exposed by loopback/TUN adapters. ICE can therefore prefer P2P
 * and naturally fall back to TURN without reintroducing the adapter bug.
 */
export function isUsableIceCandidate(
  candidate: RTCIceCandidateInit,
  policy: DirectIceCandidatePolicy = "balanced",
  localAddresses: string[] = [],
): boolean {
  return (
    isRelayIceCandidate(candidate) ||
    isUsableDirectIceCandidate(candidate, policy, localAddresses)
  );
}

export function isUsableDirectIceCandidate(
  candidate: RTCIceCandidateInit,
  policy: DirectIceCandidatePolicy = "balanced",
  localAddresses: string[] = [],
): boolean {
  const parsed = parsedIceCandidate(candidate.candidate);
  const normalizedLocalAddresses = new Set(
    localAddresses.map((address) => address.toLocaleLowerCase()),
  );
  const isNumericIpv4Host =
    parsed.type === "host" &&
    Boolean(parsed.address?.match(/^\d{1,3}(?:\.\d{1,3}){3}$/));
  if (
    parsed.type === "relay" ||
    (parsed.type === "host" &&
      isBenchmarkOrVirtualAddress(parsed.address)) ||
    (isNumericIpv4Host &&
      normalizedLocalAddresses.size > 0 &&
      !normalizedLocalAddresses.has(parsed.address!))
  ) {
    return false;
  }
  if (policy === "public") {
    return (
      parsed.type === "srflx" ||
      parsed.type === "prflx" ||
      (parsed.type === "host" &&
        !isPrivateAddress(parsed.address) &&
        !parsed.address?.endsWith(".local"))
    );
  }
  if (policy === "lan") {
    return (
      parsed.type === "host" &&
      (isPrivateAddress(parsed.address) ||
        Boolean(parsed.address?.endsWith(".local")))
    );
  }
  return true;
}

export function stripDirectIceCandidates(
  description: RTCSessionDescriptionInit,
  policy: DirectIceCandidatePolicy = "balanced",
  localAddresses: string[] = [],
): RTCSessionDescriptionInit {
  if (!description.sdp) return serializableSessionDescription(description);
  return {
    type: description.type,
    sdp: description.sdp
      .split(/\r?\n/)
      .filter((line) => {
        if (!/^a=candidate:/i.test(line)) return true;
        return isUsableDirectIceCandidate(
          { candidate: line.replace(/^a=/i, "") },
          policy,
          localAddresses,
        );
      })
      .join("\r\n"),
  };
}

export function stripUnsafeIceCandidates(
  description: RTCSessionDescriptionInit,
  policy: DirectIceCandidatePolicy = "balanced",
  localAddresses: string[] = [],
): RTCSessionDescriptionInit {
  if (!description.sdp) return serializableSessionDescription(description);
  return {
    type: description.type,
    sdp: description.sdp
      .split(/\r?\n/)
      .filter((line) => {
        if (!/^a=candidate:/i.test(line)) return true;
        return isUsableIceCandidate(
          { candidate: line.replace(/^a=/i, "") },
          policy,
          localAddresses,
        );
      })
      .join("\r\n"),
  };
}

export function stripRelayIceCandidates(
  description: RTCSessionDescriptionInit,
): RTCSessionDescriptionInit {
  if (!description.sdp) return serializableSessionDescription(description);
  return {
    type: description.type,
    sdp: description.sdp
      .split(/\r?\n/)
      .filter((line) => !/^a=candidate:.*\btyp\s+relay\b/i.test(line))
      .join("\r\n"),
  };
}

export function deferFailedVideoCodecs(
  order: string[],
  failedCodecs: Iterable<string>,
): string[] {
  const failed = new Set(
    [...failedCodecs].map((mimeType) => mimeType.toLowerCase()),
  );
  const unique = order.filter(
    (mimeType, index, values) =>
      values.findIndex(
        (candidate) =>
          candidate.toLowerCase() === mimeType.toLowerCase(),
      ) === index,
  );
  return [
    ...unique.filter(
      (mimeType) => !failed.has(mimeType.toLowerCase()),
    ),
    ...unique.filter((mimeType) => failed.has(mimeType.toLowerCase())),
  ];
}

export function normalizeVideoCodecMime(
  value: string | undefined,
): string | undefined {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  const mimeType = normalized.startsWith("video/")
    ? normalized
    : `video/${normalized}`;
  return /^video\/(?:h264|vp8|vp9|av1)$/.test(mimeType)
    ? mimeType
    : undefined;
}

export function inboundDecodeFailureCodec(
  stats: Pick<InboundStats, "bytesReceived" | "framesDecoded" | "codec">,
): string | undefined {
  if (
    !Number.isFinite(stats.bytesReceived) ||
    Number(stats.bytesReceived) <= 0 ||
    Number(stats.framesDecoded) !== 0
  ) {
    return undefined;
  }
  return normalizeVideoCodecMime(stats.codec);
}

export function matchingVideoCodecFailure(input: {
  reportedSessionId?: string;
  reportedAttempt?: number;
  reportedCodec?: string;
  peerSessionId?: string;
  peerAttempt?: number;
  negotiatedCodec?: string;
}): string | undefined {
  if (
    !input.reportedSessionId ||
    !input.peerSessionId ||
    input.reportedSessionId !== input.peerSessionId ||
    !Number.isInteger(input.reportedAttempt) ||
    input.reportedAttempt !== input.peerAttempt
  ) {
    return undefined;
  }
  const reported = normalizeVideoCodecMime(input.reportedCodec);
  if (!reported) return undefined;
  const negotiated = normalizeVideoCodecMime(input.negotiatedCodec);
  if (negotiated && negotiated !== reported) return undefined;
  return negotiated || reported;
}

export function preferVideoCodecs(
  pc: RTCPeerConnection,
  order: string[],
): string | undefined {
  if (
    typeof RTCRtpSender === "undefined" ||
    typeof RTCRtpSender.getCapabilities !== "function"
  ) {
    return undefined;
  }
  const capabilities = RTCRtpSender.getCapabilities("video");
  if (!capabilities) {
    return undefined;
  }
  const normalizedOrder = order.map((mimeType) => mimeType.toLowerCase());
  const auxiliaryCodecs = new Set([
    "video/rtx",
    "video/red",
    "video/ulpfec",
    "video/flexfec-03",
  ]);
  const h264ProfileRank = (codec: {
    mimeType: string;
    sdpFmtpLine?: string;
  }): number =>
    codec.mimeType.toLowerCase() === "video/h264"
      ? advertisedH264ProfileRank(codec.sdpFmtpLine)
      : 0;
  const ranked = capabilities.codecs
    .map((codec, originalIndex) => {
      const mimeType = codec.mimeType.toLowerCase();
      const preferredIndex = normalizedOrder.indexOf(mimeType);
      return {
        codec,
        rank:
          preferredIndex >= 0
            ? preferredIndex
            : auxiliaryCodecs.has(mimeType)
              ? normalizedOrder.length + 1
              : normalizedOrder.length,
        h264ProfileRank: h264ProfileRank(codec),
        originalIndex,
      };
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.h264ProfileRank - b.h264ProfileRank ||
        a.originalIndex - b.originalIndex,
    )
    .map(({ codec }) => codec);
  const selectedPrimary = ranked.find(
    (codec) => !auxiliaryCodecs.has(codec.mimeType.toLowerCase()),
  );
  let applied = false;
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.sender.track?.kind === "video" && transceiver.setCodecPreferences) {
      try {
        // Keep every RTX/RED/ULPFEC capability in the preference list. Passing
        // only primary codecs would explicitly disable those repair formats.
        transceiver.setCodecPreferences(ranked);
        applied = true;
      } catch (error) {
        console.warn("浏览器未接受视频编码偏好，将使用默认协商顺序", error);
      }
    }
  }
  return applied ? selectedPrimary?.mimeType : undefined;
}

export const INITIAL_VIDEO_BITRATE_CEILING = 10_000_000;
// 300 ms absorbs a typical Wi-Fi burst-loss event (~200 ms) without letting
// the decoder run dry, while staying short enough that latency stays
// invisible to co-watchers. The previous 180 ms was too close to the
// retransmit deadline and caused frequent decoder stalls on weak Wi-Fi.
export const MOVIE_JITTER_BUFFER_TARGET_MS = 300;
export const VOICE_JITTER_BUFFER_TARGET_MS = 90;
export const VOICE_RELAY_JITTER_BUFFER_TARGET_MS = 125;

export function voiceJitterBufferTarget(relayOnly = false): number {
  return relayOnly
    ? VOICE_RELAY_JITTER_BUFFER_TARGET_MS
    : VOICE_JITTER_BUFFER_TARGET_MS;
}

export function advertisedH264ProfileRank(
  sdpFmtpLine?: string,
): number {
  const profileLevelId = sdpFmtpLine
    ?.match(/(?:^|;)\s*profile-level-id=([0-9a-f]{6})(?:;|$)/i)?.[1];
  if (!profileLevelId) return 3;
  const profileIdc = Number.parseInt(profileLevelId.slice(0, 2), 16);
  if ([0x64, 0x6e, 0x7a, 0xf4].includes(profileIdc)) return 0;
  if (profileIdc === 0x4d) return 1;
  if (profileIdc === 0x42) return 2;
  return 3;
}

export class VideoBitrateRampController {
  private target: number;
  private current: number;
  private stableSamples = 0;
  private readonly confirmationSamples: number;

  constructor(
    targetBitrate: number,
    initialCeiling?: number,
    confirmationSamples = 1,
  ) {
    this.target = this.normalizeBitrate(targetBitrate);
    // maxBitrate is only a ceiling; WebRTC's own congestion controller still
    // decides the rate that is safe for the selected ICE path. Starting at a
    // separate 10 Mbps application ceiling prevented Chromium from ever
    // testing the user's selected quality on implementations that do not
    // expose availableOutgoingBitrate. Publish the selected ceiling
    // immediately and retain the explicit initialCeiling argument for callers
    // that have a measured reason to warm up.
    this.current =
      initialCeiling === undefined
        ? this.target
        : Math.min(
            this.target,
            this.normalizeBitrate(initialCeiling),
          );
    this.confirmationSamples = Math.max(
      1,
      Math.round(confirmationSamples),
    );
  }

  get targetBitrate(): number {
    return this.target;
  }

  get currentBitrate(): number {
    return this.current;
  }

  setTarget(targetBitrate: number): number {
    const nextTarget = this.normalizeBitrate(targetBitrate);
    if (nextTarget !== this.target) {
      this.target = nextTarget;
      this.stableSamples = 0;
    }
    if (this.current > this.target) {
      this.current = this.target;
    }
    return this.current;
  }

  observe(
    availableOutgoingBitrate?: number,
    qualityLimitationReason?: string,
  ): number | undefined {
    if (this.current >= this.target) {
      this.stableSamples = 0;
      return undefined;
    }
    if (
      (qualityLimitationReason !== undefined &&
        qualityLimitationReason !== "none") ||
      availableOutgoingBitrate === undefined ||
      !Number.isFinite(availableOutgoingBitrate) ||
      availableOutgoingBitrate < this.current * 1.18
    ) {
      this.stableSamples = 0;
      return undefined;
    }
    this.stableSamples += 1;
    if (this.stableSamples < this.confirmationSamples) {
      return undefined;
    }
    this.stableSamples = 0;
    const safeEstimate = Math.floor(availableOutgoingBitrate * 0.82);
    // A conservative 15% ramp avoids repeatedly overshooting paths whose
    // available bandwidth sits only slightly above the current encoding.
    const steppedCeiling = Math.floor(this.current * 1.15);
    const next = Math.min(this.target, safeEstimate, steppedCeiling);
    if (next <= this.current * 1.03) {
      return undefined;
    }
    this.current = next;
    return this.current;
  }

  private normalizeBitrate(value: number): number {
    return Number.isFinite(value)
      ? Math.max(300_000, Math.round(value))
      : INITIAL_VIDEO_BITRATE_CEILING;
  }
}

export interface VideoSenderTuningOptions {
  videoBitrateCeiling?: number;
  degradationPreference?: RTCDegradationPreference;
}

export async function tuneSenders(
  pc: RTCPeerConnection,
  preset: QualityPreset,
  options: VideoSenderTuningOptions = {},
): Promise<void> {
  await Promise.all(
    pc.getSenders().map(async (sender) => {
      if (!sender.track) {
        return;
      }
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) {
        parameters.encodings = [{}];
      }
      const encoding = parameters.encodings[0] as RTCRtpEncodingParameters & {
        priority?: RTCPriorityType;
        networkPriority?: RTCPriorityType;
        bitratePriority?: number;
      };
      if (sender.track.kind === "video") {
        const settings = sender.track.getSettings();
        const sourceWidth =
          Number(settings.width) || Math.max(16, preset.width);
        const sourceHeight =
          Number(settings.height) || Math.max(2, preset.height);
        const safeTarget = safeVideoEncodingTarget(
          sourceWidth,
          sourceHeight,
          Math.min(sourceHeight, preset.height),
        );
        (
          parameters as RTCRtpSendParameters & {
            degradationPreference?: RTCDegradationPreference;
          }
        // Preserve the selected physical raster until the receiver's
        // hysteretic controller explicitly requests a lower rung. Chromium's
        // "balanced" adapter was observed turning a stable 1080p30 local path
        // into 360p15 and keeping it there; receiver-directed adaptation gives
        // us both a sharp steady state and controlled recovery on poor Wi-Fi.
        ).degradationPreference =
          options.degradationPreference ?? "maintain-resolution";
        encoding.maxBitrate = Math.min(
          preset.maxBitrate,
          options.videoBitrateCeiling ?? preset.maxBitrate,
        );
        encoding.maxFramerate = preset.frameRate;
        encoding.scaleResolutionDownBy =
          safeTarget?.scaleResolutionDownBy ?? 1;
        encoding.priority = "high";
        encoding.networkPriority = "high";
        encoding.bitratePriority = 2;
      } else {
        encoding.maxBitrate = preset.audioBitrate;
        encoding.priority = "high";
      }
      try {
        await sender.setParameters(parameters);
      } catch (error) {
        console.warn("浏览器未接受全部发送参数，将使用兼容设置", error);
      }
    }),
  );
}

export interface ReceiverPreference {
  height?: number;
  frameRate?: number;
}

export interface AppliedReceiverPreference {
  targetBitrate: number;
  appliedBitrate: number;
  sourceBitrateCeiling: number;
  requestedHeight: number;
  requestedFrameRate: number;
  encodedWidth: number;
  encodedHeight: number;
}

/**
 * Turns the selected preset into a ceiling for the pixels that are actually
 * captured. "Original" is intentionally an 8K-sized constraint, not evidence
 * that a 1080p window needs an 8K bitrate. The previous 0.16 bpp/f hard cap
 * was too low for film grain and fast motion, and it was applied on top of
 * WebRTC's own congestion control. A 0.32 bpp/f ceiling keeps 1080p24 near
 * 16 Mbps and lets a 2560×1600 movie use the full 28 Mbps original preset.
 */
export function sourceVideoBitrateCeiling(
  presetMaximum: number,
  sourceWidth: number,
  sourceHeight: number,
  frameRate: number,
): number {
  const maximum = Number.isFinite(presetMaximum)
    ? Math.max(300_000, Math.round(presetMaximum))
    : INITIAL_VIDEO_BITRATE_CEILING;
  const width = Number.isFinite(sourceWidth)
    ? Math.max(1, Math.round(sourceWidth))
    : 1;
  const height = Number.isFinite(sourceHeight)
    ? Math.max(1, Math.round(sourceHeight))
    : 1;
  const fps = Number.isFinite(frameRate)
    ? Math.max(1, Math.min(120, frameRate))
    : 30;
  const motionCeiling = Math.round(width * height * fps * 0.32);
  return Math.min(maximum, Math.max(3_000_000, motionCeiling));
}

export function receiverBitrateCeiling(
  presetMaximum: number,
  requestedHeight: number,
  qualityRatio: number,
): number {
  const minimum =
    requestedHeight <= 480
      ? 3_000_000
      : requestedHeight <= 720
        ? 6_000_000
        : requestedHeight <= 1080
          ? 12_000_000
          : 18_000_000;
  const scaled = Math.round(
    presetMaximum * Math.max(0.02, Math.min(1, qualityRatio)) ** 0.72,
  );
  return Math.min(presetMaximum, Math.max(minimum, scaled));
}

export async function applyReceiverPreference(
  pc: RTCPeerConnection,
  preset: QualityPreset,
  preference: ReceiverPreference,
  options: VideoSenderTuningOptions = {},
): Promise<AppliedReceiverPreference | undefined> {
  const sender = pc
    .getSenders()
    .find((candidate) => candidate.track?.kind === "video");
  if (!sender) {
    return;
  }
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) {
    parameters.encodings = [{}];
  }
  const settings = sender.track?.getSettings();
  // Display-capture tracks can be smaller than the selected preset, especially
  // when Windows display scaling is enabled. Scaling from the preset would
  // downscale such a track twice (for example, a real 1080p track requested as
  // 1080p under an oversized capture ceiling became 540p).
  const sourceHeight = Math.max(
    1,
    Number(settings?.height) || preset.height,
  );
  const sourceFrameRate = Math.max(
    1,
    Number(settings?.frameRate) || preset.frameRate,
  );
  const availableHeight = Math.min(sourceHeight, preset.height);
  const availableFrameRate = Math.min(sourceFrameRate, preset.frameRate);
  const requestedHeight = preference.height
    ? Math.min(preference.height, availableHeight)
    : availableHeight;
  const requestedFrameRate = preference.frameRate
    ? Math.min(preference.frameRate, availableFrameRate)
    : availableFrameRate;
  const scaleResolutionDownBy = Math.max(1, sourceHeight / requestedHeight);
  const sourceWidth = Math.max(
    1,
    Number(settings?.width) ||
      Math.round(sourceHeight * (preset.width / preset.height)),
  );
  const safeTarget = safeVideoEncodingTarget(
    sourceWidth,
    sourceHeight,
    requestedHeight,
  );
  const encodedWidth =
    safeTarget?.width ??
    Math.max(1, Math.floor(sourceWidth / scaleResolutionDownBy));
  const encodedHeight =
    safeTarget?.height ??
    Math.max(1, Math.floor(sourceHeight / scaleResolutionDownBy));
  const safeScaleResolutionDownBy =
    safeTarget?.scaleResolutionDownBy ?? scaleResolutionDownBy;
  const sourceBitrateCeiling = sourceVideoBitrateCeiling(
    preset.maxBitrate,
    sourceWidth,
    availableHeight,
    availableFrameRate,
  );
  const sourcePixelsPerSecond =
    sourceWidth * availableHeight * availableFrameRate;
  const requestedPixelsPerSecond =
    encodedWidth * encodedHeight * requestedFrameRate;
  const qualityRatio = Math.max(
    0.02,
    Math.min(1, requestedPixelsPerSecond / sourcePixelsPerSecond),
  );
  const encoding = parameters.encodings[0] as RTCRtpEncodingParameters & {
    priority?: RTCPriorityType;
    networkPriority?: RTCPriorityType;
    bitratePriority?: number;
  };
  encoding.scaleResolutionDownBy = safeScaleResolutionDownBy;
  encoding.maxFramerate = requestedFrameRate;
  const targetBitrate = receiverBitrateCeiling(
    sourceBitrateCeiling,
    requestedHeight,
    qualityRatio,
  );
  const appliedBitrate = Math.min(
    targetBitrate,
    options.videoBitrateCeiling ?? targetBitrate,
  );
  encoding.maxBitrate = appliedBitrate;
  encoding.priority = "high";
  encoding.networkPriority = "high";
  encoding.bitratePriority = 2;
  (
    parameters as RTCRtpSendParameters & {
      degradationPreference?: RTCDegradationPreference;
    }
  ).degradationPreference =
    options.degradationPreference ?? "maintain-resolution";
  try {
    await sender.setParameters(parameters);
  } catch (error) {
    console.warn("浏览器未接受观看端画质偏好", error);
  }
  return {
    targetBitrate,
    appliedBitrate,
    sourceBitrateCeiling,
    requestedHeight,
    requestedFrameRate,
    encodedWidth,
    encodedHeight,
  };
}

/**
 * A movie is not an interactive call. Giving Chromium a modest 180 ms target
 * lets retransmissions arrive before playout and materially reduces freezes on
 * ordinary Wi-Fi, while voice remains on its separate low-latency connection.
 */
export function configureMovieJitterBuffer(
  pc: RTCPeerConnection,
  targetMs = MOVIE_JITTER_BUFFER_TARGET_MS,
): number {
  const target = Number.isFinite(targetMs)
    ? Math.max(0, Math.min(4_000, targetMs))
    : MOVIE_JITTER_BUFFER_TARGET_MS;
  let configured = 0;
  for (const receiver of pc.getReceivers()) {
    if (
      !receiver.track ||
      !["audio", "video"].includes(receiver.track.kind) ||
      !("jitterBufferTarget" in receiver)
    ) {
      continue;
    }
    try {
      (
        receiver as RTCRtpReceiver & {
          jitterBufferTarget: number | null;
        }
      ).jitterBufferTarget = target;
      configured += 1;
    } catch {
      // Older Android WebViews expose an immutable receiver. Their adaptive
      // default remains usable and must not block the negotiation.
    }
  }
  return configured;
}

export function configureVoiceJitterBuffer(
  pc: RTCPeerConnection,
  targetMs = VOICE_JITTER_BUFFER_TARGET_MS,
): number {
  const target = Number.isFinite(targetMs)
    ? Math.max(0, Math.min(4_000, targetMs))
    : VOICE_JITTER_BUFFER_TARGET_MS;
  let configured = 0;
  for (const receiver of pc.getReceivers()) {
    if (receiver.track?.kind !== "audio") {
      continue;
    }
    let receiverConfigured = false;
    try {
      if ("jitterBufferTarget" in receiver) {
        (
          receiver as RTCRtpReceiver & {
            jitterBufferTarget: number | null;
          }
        ).jitterBufferTarget = target;
        receiverConfigured = true;
      }
    } catch {
      // Browser-managed adaptive buffering remains the compatibility path.
    }
    try {
      if ("playoutDelayHint" in receiver) {
        (
          receiver as RTCRtpReceiver & {
            playoutDelayHint: number | null;
          }
        ).playoutDelayHint = target / 1_000;
        receiverConfigured = true;
      }
    } catch {
      // Some Android WebViews expose this hint as read-only.
    }
    if (receiverConfigured) configured += 1;
  }
  return configured;
}

function tuneOpusSettings(
  description: RTCSessionDescriptionInit,
  settings: string,
): RTCSessionDescriptionInit {
  if (!description.sdp) {
    return serializableSessionDescription(description);
  }
  const lines = description.sdp.split(/\r?\n/);
  const opusLine = lines.find((line) => /^a=rtpmap:\d+ opus\/48000\/2$/i.test(line));
  const payload = opusLine?.match(/^a=rtpmap:(\d+)/)?.[1];
  if (!payload) {
    return serializableSessionDescription(description);
  }
  const fmtpPrefix = `a=fmtp:${payload}`;
  const fmtpIndex = lines.findIndex((line) => line.startsWith(fmtpPrefix));
  const settingsKeys = new Set(
    settings.split(";").map((part) => part.split("=")[0]),
  );
  if (fmtpIndex >= 0) {
    const existing = lines[fmtpIndex].split(" ", 2)[1] || "";
    const retained = existing
      .split(";")
      .filter(Boolean)
      .filter((part) => !settingsKeys.has(part.split("=")[0]));
    lines[fmtpIndex] = `${fmtpPrefix} ${[...retained, ...settings.split(";")].join(";")}`;
  } else {
    lines.splice(lines.indexOf(opusLine) + 1, 0, `${fmtpPrefix} ${settings}`);
  }
  return { type: description.type, sdp: lines.join("\r\n") };
}

export function tuneOpus(
  description: RTCSessionDescriptionInit,
): RTCSessionDescriptionInit {
  return tuneOpusSettings(
    description,
    "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000;usedtx=0;cbr=0",
  );
}

export function tuneMovieOpus(
  description: RTCSessionDescriptionInit,
): RTCSessionDescriptionInit {
  return tuneOpusSettings(
    description,
    "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxplaybackrate=48000;sprop-maxcapturerate=48000;maxaveragebitrate=320000;usedtx=0;cbr=0",
  );
}

export function videoTiasBitrate(
  description: RTCSessionDescriptionInit,
): number | undefined {
  if (!description.sdp) return undefined;
  const lines = description.sdp.split(/\r?\n/);
  const videoStart = lines.findIndex((line) => /^m=video\b/i.test(line));
  if (videoStart < 0) return undefined;
  const videoEnd = lines.findIndex(
    (line, index) => index > videoStart && /^m=/i.test(line),
  );
  const sectionEnd = videoEnd < 0 ? lines.length : videoEnd;
  const line = lines
    .slice(videoStart + 1, sectionEnd)
    .find((candidate) => /^b=TIAS:\d+$/i.test(candidate));
  const value = Number(line?.split(":")[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function prioritizeAdvertisedH264Profiles(
  description: RTCSessionDescriptionInit,
): RTCSessionDescriptionInit {
  if (!description.sdp) return serializableSessionDescription(description);
  const lines = description.sdp.split(/\r?\n/);
  const videoStart = lines.findIndex((line) => /^m=video\b/i.test(line));
  if (videoStart < 0) return serializableSessionDescription(description);
  const nextMedia = lines.findIndex(
    (line, index) => index > videoStart && /^m=/i.test(line),
  );
  const videoEnd = nextMedia < 0 ? lines.length : nextMedia;
  const h264Payloads = new Set<string>();
  const profileRanks = new Map<string, number>();
  for (let index = videoStart + 1; index < videoEnd; index += 1) {
    const rtpmap = lines[index].match(
      /^a=rtpmap:(\d+)\s+H264\/90000(?:\s|$)/i,
    );
    if (rtpmap) h264Payloads.add(rtpmap[1]);
    const fmtp = lines[index].match(/^a=fmtp:(\d+)\s+(.+)$/i);
    if (fmtp) {
      profileRanks.set(
        fmtp[1],
        advertisedH264ProfileRank(fmtp[2]),
      );
    }
  }
  if (h264Payloads.size < 2) {
    return { type: description.type, sdp: lines.join("\r\n") };
  }
  const media = lines[videoStart].trim().split(/\s+/);
  const payloads = media.slice(3);
  const orderedH264 = payloads
    .filter((payload) => h264Payloads.has(payload))
    .sort(
      (a, b) =>
        (profileRanks.get(a) ?? 3) - (profileRanks.get(b) ?? 3),
    );
  let h264Index = 0;
  for (let index = 0; index < payloads.length; index += 1) {
    if (h264Payloads.has(payloads[index])) {
      payloads[index] = orderedH264[h264Index];
      h264Index += 1;
    }
  }
  lines[videoStart] = [...media.slice(0, 3), ...payloads].join(" ");
  return { type: description.type, sdp: lines.join("\r\n") };
}

export function tuneMovieSdp(
  description: RTCSessionDescriptionInit,
  videoBitrate: number,
): RTCSessionDescriptionInit {
  const tuned = prioritizeAdvertisedH264Profiles(tuneMovieOpus(description));
  if (!tuned.sdp) return serializableSessionDescription(tuned);
  const bitrate = Number.isFinite(videoBitrate)
    ? Math.max(300_000, Math.round(videoBitrate))
    : INITIAL_VIDEO_BITRATE_CEILING;
  const lines = tuned.sdp.split(/\r?\n/);
  const videoStart = lines.findIndex((line) => /^m=video\b/i.test(line));
  if (videoStart < 0) return serializableSessionDescription(tuned);
  let videoEnd = lines.findIndex(
    (line, index) => index > videoStart && /^m=/i.test(line),
  );
  if (videoEnd < 0) videoEnd = lines.length;
  for (let index = videoEnd - 1; index > videoStart; index -= 1) {
    if (/^b=(?:TIAS|AS):/i.test(lines[index])) {
      lines.splice(index, 1);
      videoEnd -= 1;
    }
  }
  let insertionIndex = videoStart + 1;
  while (
    insertionIndex < videoEnd &&
    /^(?:i=|c=)/i.test(lines[insertionIndex])
  ) {
    insertionIndex += 1;
  }
  lines.splice(insertionIndex, 0, `b=TIAS:${bitrate}`);
  return { type: tuned.type, sdp: lines.join("\r\n") };
}

export function tuneVoiceOpus(
  description: RTCSessionDescriptionInit,
): RTCSessionDescriptionInit {
  return tuneMovieOpus(description);
}

export async function tuneVoiceSender(
  sender: RTCRtpSender,
  maxBitrate = 256_000,
): Promise<void> {
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) {
    parameters.encodings = [{}];
  }
  const encoding = parameters.encodings[0] as RTCRtpEncodingParameters & {
    priority?: RTCPriorityType;
    networkPriority?: RTCPriorityType;
  };
  const clampedBitrate = Number.isFinite(maxBitrate)
    ? Math.max(112_000, Math.min(320_000, maxBitrate))
    : 256_000;
  encoding.maxBitrate = clampedBitrate;
  encoding.priority = "high";
  encoding.networkPriority = "high";
  try {
    await sender.setParameters(parameters);
  } catch (error) {
    console.warn("浏览器未接受全部连麦编码参数", error);
  }
}

export interface OutboundSnapshot {
  bytes: number;
  timestamp: number;
}

export interface OutboundStats {
  bitrate: number;
  width?: number;
  height?: number;
  framesPerSecond?: number;
  codec?: string;
  qualityLimitationReason?: string;
  availableOutgoingBitrate?: number;
  currentRoundTripTime?: number;
  relayed?: boolean;
  transportProtocol?: string;
  snapshot?: OutboundSnapshot;
}

export interface OutboundAudioSnapshot {
  bytes: number;
  timestamp: number;
  packetsSent: number;
  remotePacketsLost: number;
}

export interface OutboundAudioStats {
  bitrate: number;
  packetLossRatio?: number;
  availableOutgoingBitrate?: number;
  currentRoundTripTime?: number;
  relayed?: boolean;
  transportProtocol?: string;
  snapshot?: OutboundAudioSnapshot;
}

export interface InboundSnapshot {
  bytes: number;
  timestamp: number;
  packetsReceived: number;
  packetsLost: number;
  framesDecoded: number;
  framesDropped: number;
  totalDecodeTime: number;
  totalFreezesDuration: number;
  jitterBufferTargetDelay: number;
  jitterBufferEmittedCount: number;
}

export interface InboundStats {
  bitrate: number;
  bytesReceived?: number;
  packetsReceived?: number;
  framesReceived?: number;
  width?: number;
  height?: number;
  framesPerSecond?: number;
  codec?: string;
  jitter?: number;
  packetLossRatio?: number;
  framesDecodedDelta?: number;
  framesDroppedRatio?: number;
  averageDecodeTime?: number;
  freezeDurationDelta?: number;
  framesDecoded?: number;
  keyFramesDecoded?: number;
  decoderImplementation?: string;
  powerEfficientDecoder?: boolean;
  jitterBufferTargetMs?: number;
  currentRoundTripTime?: number;
  relayed?: boolean;
  transportProtocol?: string;
  snapshot?: InboundSnapshot;
}

export interface InboundAudioSnapshot {
  bytes: number;
  timestamp: number;
  totalAudioEnergy: number;
  totalSamplesDuration: number;
}

export interface InboundAudioStats {
  bitrate: number;
  bytesReceived: number;
  packetsReceived: number;
  audioLevel?: number;
  totalAudioEnergy: number;
  totalSamplesDuration: number;
  snapshot: InboundAudioSnapshot;
}

export interface DataChannelSnapshot {
  bytes: number;
  timestamp: number;
}

export interface DataChannelStats {
  bitrate: number;
  bytesReceived: number;
  messagesReceived: number;
  currentRoundTripTime?: number;
  relayed?: boolean;
  transportProtocol?: string;
  snapshot?: DataChannelSnapshot;
}

export interface IceConnectivityDiagnostics {
  requestsSent: number;
  responsesReceived: number;
  requestsReceived: number;
  responsesSent: number;
  hasVirtualCandidate: boolean;
  hasCandidatePair: boolean;
  oneWayInboundBlocked: boolean;
}

export async function readIceConnectivityDiagnostics(
  pc: RTCPeerConnection,
): Promise<IceConnectivityDiagnostics> {
  const report = await pc.getStats();
  let requestsSent = 0;
  let responsesReceived = 0;
  let requestsReceived = 0;
  let responsesSent = 0;
  let hasVirtualCandidate = false;
  let hasCandidatePair = false;
  report.forEach((item) => {
    if (
      (item.type === "local-candidate" ||
        item.type === "remote-candidate") &&
      isTunnelAddress(
        String(item.address || item.ip || "").toLocaleLowerCase(),
      )
    ) {
      hasVirtualCandidate = true;
    }
    if (item.type !== "candidate-pair") return;
    hasCandidatePair = true;
    requestsSent += Number(item.requestsSent || 0);
    responsesReceived += Number(item.responsesReceived || 0);
    requestsReceived += Number(item.requestsReceived || 0);
    responsesSent += Number(item.responsesSent || 0);
  });
  return {
    requestsSent,
    responsesReceived,
    requestsReceived,
    responsesSent,
    hasVirtualCandidate,
    hasCandidatePair,
    oneWayInboundBlocked:
      requestsSent > 0 &&
      responsesReceived === 0 &&
      requestsReceived > 0 &&
      responsesSent > 0,
  };
}

interface SelectedCandidatePairStats extends RTCStats {
  localCandidateId?: string;
  remoteCandidateId?: string;
  availableOutgoingBitrate?: number;
  currentRoundTripTime?: number;
}

function selectedCandidatePair(
  report: RTCStatsReport,
  transportId?: string,
): SelectedCandidatePairStats | undefined {
  const transport = transportId ? report.get(transportId) : undefined;
  let pair = transport?.selectedCandidatePairId
    ? report.get(transport.selectedCandidatePairId)
    : undefined;
  if (!pair) {
    report.forEach((item) => {
      if (
        !pair &&
        item.type === "candidate-pair" &&
        item.state === "succeeded" &&
        (item.selected || item.nominated)
      ) {
        pair = item;
      }
    });
  }
  return pair as SelectedCandidatePairStats | undefined;
}

function selectedCandidateDetails(
  report: RTCStatsReport,
  transportId?: string,
): {
  relayed?: boolean;
  transportProtocol?: string;
  currentRoundTripTime?: number;
} {
  const pair = selectedCandidatePair(report, transportId);
  if (!pair) return {};
  const local = pair.localCandidateId
    ? report.get(pair.localCandidateId)
    : undefined;
  const remote = pair.remoteCandidateId
    ? report.get(pair.remoteCandidateId)
    : undefined;
  return {
    relayed:
      local?.candidateType === "relay" || remote?.candidateType === "relay",
    transportProtocol: [
      local?.protocol,
      local?.relayProtocol,
      remote?.protocol,
    ]
      .filter(Boolean)
      .join("/"),
    currentRoundTripTime:
      Number.isFinite(Number(pair.currentRoundTripTime)) &&
      Number(pair.currentRoundTripTime) >= 0
        ? Number(pair.currentRoundTripTime)
        : undefined,
  };
}

export async function readDataChannelStats(
  pc: RTCPeerConnection,
  label: string,
  previous?: DataChannelSnapshot,
): Promise<DataChannelStats> {
  const report = await pc.getStats();
  let result: DataChannelStats = {
    bitrate: 0,
    bytesReceived: 0,
    messagesReceived: 0,
  };
  let transportId: string | undefined;
  report.forEach((item) => {
    if (
      item.type !== "data-channel" ||
      (label && String(item.label || "") !== label)
    ) {
      return;
    }
    const snapshot: DataChannelSnapshot = {
      bytes: Number(item.bytesReceived || 0),
      timestamp: Number(item.timestamp || performance.now()),
    };
    const bitrate =
      previous && snapshot.timestamp > previous.timestamp
        ? Math.max(
            0,
            ((snapshot.bytes - previous.bytes) * 8 * 1_000) /
              (snapshot.timestamp - previous.timestamp),
          )
        : 0;
    result = {
      bitrate,
      bytesReceived: snapshot.bytes,
      messagesReceived: Number(item.messagesReceived || 0),
      snapshot,
    };
    transportId = item.transportId;
  });
  Object.assign(result, selectedCandidateDetails(report, transportId));
  return result;
}

export async function readOutboundVideoStats(
  pc: RTCPeerConnection,
  previous?: OutboundSnapshot,
): Promise<OutboundStats> {
  const report = await pc.getStats();
  let result: OutboundStats = { bitrate: 0 };
  let transportId: string | undefined;
  report.forEach((item) => {
    if (item.type !== "outbound-rtp" || item.kind !== "video" || item.isRemote) {
      return;
    }
    const snapshot = {
      bytes: Number(item.bytesSent || 0),
      timestamp: Number(item.timestamp || performance.now()),
    };
    let bitrate = 0;
    if (previous && snapshot.timestamp > previous.timestamp) {
      bitrate =
        ((snapshot.bytes - previous.bytes) * 8 * 1000) /
        (snapshot.timestamp - previous.timestamp);
    }
    const codecReport = item.codecId ? report.get(item.codecId) : undefined;
    result = {
      bitrate,
      width: item.frameWidth,
      height: item.frameHeight,
      framesPerSecond: item.framesPerSecond,
      codec: codecReport?.mimeType?.replace("video/", ""),
      qualityLimitationReason: item.qualityLimitationReason,
      snapshot,
    };
    transportId = item.transportId;
  });
  const candidatePair = selectedCandidatePair(report, transportId);
  const availableOutgoingBitrate = Number(
    candidatePair?.availableOutgoingBitrate,
  );
  if (
    Number.isFinite(availableOutgoingBitrate) &&
    availableOutgoingBitrate > 0
  ) {
    result.availableOutgoingBitrate = availableOutgoingBitrate;
  }
  Object.assign(result, selectedCandidateDetails(report, transportId));
  return result;
}

export async function readOutboundAudioStats(
  pc: RTCPeerConnection,
  previous?: OutboundAudioSnapshot,
): Promise<OutboundAudioStats> {
  const report = await pc.getStats();
  let result: OutboundAudioStats = { bitrate: 0 };
  let transportId: string | undefined;
  report.forEach((item) => {
    const kind = item.kind || item.mediaType;
    if (item.type !== "outbound-rtp" || kind !== "audio" || item.isRemote) {
      return;
    }
    const remote = item.remoteId ? report.get(item.remoteId) : undefined;
    const snapshot: OutboundAudioSnapshot = {
      bytes: Number(item.bytesSent || 0),
      timestamp: Number(item.timestamp || performance.now()),
      packetsSent: Number(item.packetsSent || 0),
      remotePacketsLost: Math.max(0, Number(remote?.packetsLost || 0)),
    };
    const elapsedMs =
      previous && snapshot.timestamp > previous.timestamp
        ? snapshot.timestamp - previous.timestamp
        : 0;
    const bitrate =
      previous && elapsedMs > 0
        ? Math.max(
            0,
            ((snapshot.bytes - previous.bytes) * 8 * 1_000) / elapsedMs,
          )
        : 0;
    let packetLossRatio: number | undefined;
    const reportedFractionLost = Number(remote?.fractionLost);
    if (
      Number.isFinite(reportedFractionLost) &&
      reportedFractionLost >= 0
    ) {
      packetLossRatio = Math.min(1, reportedFractionLost);
    } else if (previous) {
      const sentDelta = Math.max(
        0,
        snapshot.packetsSent - previous.packetsSent,
      );
      const lostDelta = Math.max(
        0,
        snapshot.remotePacketsLost - previous.remotePacketsLost,
      );
      if (sentDelta > 0) {
        packetLossRatio = Math.min(1, lostDelta / sentDelta);
      }
    }
    result = {
      bitrate,
      packetLossRatio,
      currentRoundTripTime:
        Number.isFinite(Number(remote?.roundTripTime)) &&
        Number(remote?.roundTripTime) >= 0
          ? Number(remote.roundTripTime)
          : undefined,
      snapshot,
    };
    transportId = item.transportId;
  });
  const pair = selectedCandidatePair(report, transportId);
  const availableOutgoingBitrate = Number(pair?.availableOutgoingBitrate);
  if (
    Number.isFinite(availableOutgoingBitrate) &&
    availableOutgoingBitrate > 0
  ) {
    result.availableOutgoingBitrate = availableOutgoingBitrate;
  }
  const remoteRoundTripTime = result.currentRoundTripTime;
  Object.assign(result, selectedCandidateDetails(report, transportId));
  if (
    result.currentRoundTripTime === undefined &&
    remoteRoundTripTime !== undefined
  ) {
    result.currentRoundTripTime = remoteRoundTripTime;
  }
  return result;
}

export async function readInboundVideoStats(
  pc: RTCPeerConnection,
  previous?: InboundSnapshot,
): Promise<InboundStats> {
  const report = await pc.getStats();
  let result: InboundStats = { bitrate: 0 };
  let transportId: string | undefined;
  report.forEach((item) => {
    const kind = item.kind || item.mediaType;
    if (item.type !== "inbound-rtp" || kind !== "video" || item.isRemote) {
      return;
    }
    const snapshot: InboundSnapshot = {
      bytes: Number(item.bytesReceived || 0),
      timestamp: Number(item.timestamp || performance.now()),
      packetsReceived: Number(item.packetsReceived || 0),
      packetsLost: Number(item.packetsLost || 0),
      framesDecoded: Number(item.framesDecoded || 0),
      framesDropped: Number(item.framesDropped || 0),
      totalDecodeTime: Number(item.totalDecodeTime || 0),
      totalFreezesDuration: Number(item.totalFreezesDuration || 0),
      jitterBufferTargetDelay: Number(item.jitterBufferTargetDelay || 0),
      jitterBufferEmittedCount: Number(item.jitterBufferEmittedCount || 0),
    };
    let bitrate = 0;
    let packetLossRatio: number | undefined;
    let measuredFrameRate: number | undefined;
    let framesDecodedDelta: number | undefined;
    let framesDroppedRatio: number | undefined;
    let averageDecodeTime: number | undefined;
    let freezeDurationDelta: number | undefined;
    let jitterBufferTargetMs: number | undefined;
    if (previous && snapshot.timestamp > previous.timestamp) {
      const elapsedSeconds = (snapshot.timestamp - previous.timestamp) / 1000;
      bitrate =
        ((snapshot.bytes - previous.bytes) * 8 * 1000) /
        (snapshot.timestamp - previous.timestamp);
      const decodedDelta = Math.max(
        0,
        snapshot.framesDecoded - previous.framesDecoded,
      );
      framesDecodedDelta = decodedDelta;
      const droppedDelta = Math.max(
        0,
        snapshot.framesDropped - previous.framesDropped,
      );
      const frameTotal = decodedDelta + droppedDelta;
      if (frameTotal > 0) {
        framesDroppedRatio = droppedDelta / frameTotal;
      }
      const decodeTimeDelta = Math.max(
        0,
        snapshot.totalDecodeTime - previous.totalDecodeTime,
      );
      if (decodedDelta > 0) {
        averageDecodeTime = decodeTimeDelta / decodedDelta;
      }
      freezeDurationDelta = Math.max(
        0,
        snapshot.totalFreezesDuration - previous.totalFreezesDuration,
      );
      if (elapsedSeconds > 0 && decodedDelta > 0) {
        measuredFrameRate = decodedDelta / elapsedSeconds;
      }
      const receivedDelta = Math.max(
        0,
        snapshot.packetsReceived - previous.packetsReceived,
      );
      const lostDelta = Math.max(
        0,
        snapshot.packetsLost - previous.packetsLost,
      );
      const totalDelta = receivedDelta + lostDelta;
      if (totalDelta > 0) {
        packetLossRatio = lostDelta / totalDelta;
      }
      const emittedDelta = Math.max(
        0,
        snapshot.jitterBufferEmittedCount -
          previous.jitterBufferEmittedCount,
      );
      if (emittedDelta > 0) {
        jitterBufferTargetMs =
          ((snapshot.jitterBufferTargetDelay -
            previous.jitterBufferTargetDelay) /
            emittedDelta) *
          1_000;
      }
    }
    const codecReport = item.codecId ? report.get(item.codecId) : undefined;
    result = {
      bitrate,
      bytesReceived: snapshot.bytes,
      packetsReceived: snapshot.packetsReceived,
      framesReceived: Number(item.framesReceived || 0),
      width: item.frameWidth,
      height: item.frameHeight,
      framesPerSecond:
        Number(item.framesPerSecond) || measuredFrameRate || undefined,
      codec: codecReport?.mimeType?.replace("video/", ""),
      jitter: Number.isFinite(Number(item.jitter))
        ? Number(item.jitter)
        : undefined,
      packetLossRatio,
      framesDecodedDelta,
      framesDroppedRatio,
      averageDecodeTime,
      freezeDurationDelta,
      framesDecoded: Number(item.framesDecoded || 0),
      keyFramesDecoded: Number(item.keyFramesDecoded || 0),
      decoderImplementation:
        typeof item.decoderImplementation === "string"
          ? item.decoderImplementation
          : undefined,
      powerEfficientDecoder:
        typeof item.powerEfficientDecoder === "boolean"
          ? item.powerEfficientDecoder
          : undefined,
      jitterBufferTargetMs,
      snapshot,
    };
    transportId = item.transportId;
  });
  Object.assign(result, selectedCandidateDetails(report, transportId));
  return result;
}

export async function readInboundAudioStats(
  pc: RTCPeerConnection,
  previous?: InboundAudioSnapshot,
): Promise<InboundAudioStats> {
  const report = await pc.getStats();
  let bytesReceived = 0;
  let packetsReceived = 0;
  let timestamp = performance.now();
  let audioLevel: number | undefined;
  let totalAudioEnergy = 0;
  let totalSamplesDuration = 0;
  report.forEach((item) => {
    const kind = item.kind || item.mediaType;
    if (item.type !== "inbound-rtp" || kind !== "audio" || item.isRemote) {
      return;
    }
    const itemBytesReceived = Number(item.bytesReceived);
    if (Number.isFinite(itemBytesReceived) && itemBytesReceived >= 0) {
      bytesReceived += itemBytesReceived;
    }
    packetsReceived += Number(item.packetsReceived || 0);
    timestamp = Math.max(timestamp, Number(item.timestamp || 0));
    const level = Number(item.audioLevel);
    if (Number.isFinite(level)) {
      audioLevel = Math.max(audioLevel || 0, level);
    }
    const energy = Number(item.totalAudioEnergy);
    if (Number.isFinite(energy) && energy >= 0) {
      totalAudioEnergy += energy;
    }
    const samplesDuration = Number(item.totalSamplesDuration);
    if (Number.isFinite(samplesDuration) && samplesDuration >= 0) {
      totalSamplesDuration += samplesDuration;
    }
  });
  const snapshot = {
    bytes: bytesReceived,
    timestamp,
    totalAudioEnergy,
    totalSamplesDuration,
  };
  const elapsedMs =
    previous && timestamp > previous.timestamp
      ? timestamp - previous.timestamp
      : 0;
  const previousBytes =
    previous && Number.isFinite(previous.bytes)
      ? Math.max(0, previous.bytes)
      : 0;
  return {
    bitrate:
      elapsedMs > 0
        ? Math.max(
            0,
            ((bytesReceived - previousBytes) * 8 * 1_000) / elapsedMs,
          )
        : 0,
    bytesReceived,
    packetsReceived,
    audioLevel,
    totalAudioEnergy,
    totalSamplesDuration,
    snapshot,
  };
}
