import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import protocolPolicy from "./protocol-policy.json" with { type: "json" };
import { createSegmentRelay } from "./segment-relay.mjs";

const SIGNAL_PROTOCOL_VERSION = 3;
const SIGNAL_FEATURES = Object.freeze([
  "network-probe",
  "network-probe-v2",
  "network-report",
  "network-transport-report",
  "network-advice",
  "network-advice-v2",
  "broadcast-capabilities",
  "resume-token",
  "server-capabilities",
  "server-time",
  "voice-policy-v2",
  "ice-restart",
  "turn-rest-credentials",
  "ice-credential-refresh",
  "sfu-primary",
  "p2p-fallback",
  "emby-segment-relay-v1",
]);

function signalCompatibility() {
  const serverTime = Date.now();
  return {
    protocolVersion: SIGNAL_PROTOCOL_VERSION,
    features: SIGNAL_FEATURES,
    serverFeatures: SIGNAL_FEATURES,
    serverTime,
    clockPrecisionMs: 1,
  };
}

const MAX_PARTICIPANTS_PER_ROOM =
  protocolPolicy.maxParticipantsPerRoom;
const DEFAULT_MAX_VIEWERS_PER_ROOM = MAX_PARTICIPANTS_PER_ROOM - 1;
const MAX_MESSAGES_PER_MINUTE = 600;
const MAX_CHAT_MESSAGES_PER_10_SECONDS = 20;
const DEFAULT_MAX_CLIENTS = 128;
const DEFAULT_MAX_CLIENTS_PER_IP = 16;
const CLIENT_JOIN_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const ICE_CREDENTIAL_REFRESH_MAX_INTERVAL_MS = 3 * 60 * 60 * 1_000;
const DEFAULT_DISCONNECT_GRACE_MS = 45_000;
const NETWORK_PROBE_CHUNK_BYTES =
  protocolPolicy.networkProbe.version1.chunkBytes;
const NETWORK_PROBE_MAX_CHUNKS =
  protocolPolicy.networkProbe.version1.maximumChunks;
const NETWORK_PROBE_V2_CHUNK_BYTES =
  protocolPolicy.networkProbe.version2.chunkBytes;
const NETWORK_PROBE_V2_MAX_CHUNKS =
  protocolPolicy.networkProbe.version2.maximumChunks;
const NETWORK_PROBE_MAX_LATENCY_SAMPLES = 5;
const NETWORK_PROBE_MAX_BYTES_PER_DIRECTION =
  NETWORK_PROBE_CHUNK_BYTES * NETWORK_PROBE_MAX_CHUNKS;
const NETWORK_PROBE_V2_MAX_BYTES_PER_DIRECTION =
  NETWORK_PROBE_V2_CHUNK_BYTES * NETWORK_PROBE_V2_MAX_CHUNKS;
const NETWORK_PROBE_MAX_ROUNDS_PER_CONNECTION = 2;
const NETWORK_PROBE_V2_MAX_ROUNDS_PER_CONNECTION = 3;
const NETWORK_PROBE_MAX_ROUNDS_PER_IP_PER_MINUTE = 8;
const NETWORK_PROBE_MAX_CONCURRENT_ROUNDS = 16;
const NETWORK_PROBE_ROUND_TIMEOUT_MS = 15_000;
const NETWORK_REPORT_MIN_INTERVAL_MS = 5_000;
const NETWORK_REPORT_TTL_MS = 5 * 60_000;
const TRANSPORT_REPORT_MIN_INTERVAL_MS = 2_000;
const TRANSPORT_REPORT_TTL_MS = 20_000;
const NETWORK_ADVICE_VALIDITY_MS = 35_000;
const NETWORK_ADVICE_DEBOUNCE_MS = 50;
const SIGNAL_MAX_BUFFERED_BYTES = 768 * 1024;
const DEFAULT_PER_VIEWER_BUDGET_BPS = 10_000_000;
const ROOM_PATTERN = /^[23456789A-HJ-NP-Z]{8}$/;
const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const NETWORK_PROBE_PAYLOAD = "0123456789abcdef".repeat(
  NETWORK_PROBE_CHUNK_BYTES / 16,
);
const NETWORK_PROBE_V2_PAYLOAD = "0123456789abcdef".repeat(
  NETWORK_PROBE_V2_CHUNK_BYTES / 16,
);
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "file://",
  "capacitor://localhost",
  "https://localhost",
]);

const QUALITY_BITRATE_BPS = protocolPolicy.quality.bitrateBps;
const QUALITY_RESOLUTION_ORDER =
  protocolPolicy.quality.resolutionOrder;
const QUALITY_FRAME_RATE_ORDER =
  protocolPolicy.quality.frameRateOrder;
const QUALITY_RECOMMENDATION_BASELINE_FRAME_RATE =
  protocolPolicy.quality.recommendationBaselineFrameRate;

function turnCredentialTtlSeconds(env = process.env) {
  return boundedInteger(
    env.TURN_CREDENTIAL_TTL_SECONDS,
    4 * 60 * 60,
    10 * 60,
    24 * 60 * 60,
  );
}

function buildIceServers(room, env = process.env, clientIdentity = "") {
  const allowTurnTcp = env.TURN_TCP_ENABLED === "true";
  const usableIceUrl = (value) =>
    typeof value === "string" &&
    /^(?:stun|stuns|turn|turns):/iu.test(value) &&
    (
      allowTurnTcp ||
      !/^turns?:/iu.test(value) ||
      !/[?&]transport=tcp(?:&|$)/iu.test(value)
    );
  let configuredServers = [];
  if (env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(env.ICE_SERVERS_JSON);
      configuredServers = Array.isArray(parsed)
        ? parsed.flatMap((server) => {
            if (!server || typeof server !== "object" || Array.isArray(server)) {
              return [];
            }
            const urls = (
              Array.isArray(server.urls) ? server.urls : [server.urls]
            ).filter(usableIceUrl);
            return urls.length ? [{ ...server, urls }] : [];
          })
        : [];
    } catch {
      configuredServers = [];
    }
  }
  const turnUrls = env.TURN_URLS?.split(",")
    .map((value) => value.trim())
    // TCP TURN must be explicitly enabled only after the public relay port has
    // passed the smoke test. Advertising a blocked TCP listener makes clients
    // on UDP-restricted networks wait on a route that can never carry audio.
    .filter(usableIceUrl);
  if (turnUrls?.length && env.TURN_SECRET) {
    const credentialTtlSeconds = turnCredentialTtlSeconds(env);
    const expiresAt =
      Math.floor(Date.now() / 1000) + credentialTtlSeconds;
    // coturn applies user-quota to the complete REST username. Using only the
    // room code made every member, every movie PeerConnection and every ICE
    // restart consume one shared quota. After a few weak-network rebuilds the
    // whole room could receive 486 allocation failures until old allocations
    // expired. Scope the quota bucket to one client while retaining the room
    // in the auditable credential identity.
    const safeClientIdentity = String(clientIdentity || "")
      .replace(/[^a-z0-9_-]/gi, "")
      .slice(0, 64);
    const username = safeClientIdentity
      ? `${expiresAt}:${room}:${safeClientIdentity}`
      : `${expiresAt}:${room}`;
    // coturn's TURN REST API deliberately uses HMAC-SHA1. This is an
    // expiring credential MAC, not a password hash, and must match coturn.
    const credential = createHmac("sha1", env.TURN_SECRET)
      .update(username)
      .digest("base64");
    return [...configuredServers, { urls: turnUrls, username, credential }];
  }
  return configuredServers;
}

function temporaryIceCredentialExpiresAt(iceServers) {
  const expirations = iceServers
    .map((server) => Number(String(server?.username || "").split(":")[0]))
    .filter((value) => Number.isInteger(value) && value > 0);
  return expirations.length
    ? Math.min(...expirations) * 1_000
    : undefined;
}

function normalizedSfuUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["ws:", "wss:"].includes(url.protocol)) return undefined;
    if (url.username || url.password) return undefined;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

function sfuEnabled(env = process.env) {
  return Boolean(
    env.SFU_ENABLED !== "false" &&
      normalizedSfuUrl(env.SFU_PUBLIC_URL) &&
      cleanText(env.LIVEKIT_API_KEY, 128) &&
      String(env.LIVEKIT_API_SECRET || "").length >= 32,
  );
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function buildSfuAccess(room, state, env = process.env) {
  if (!sfuEnabled(env)) return undefined;
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const ttlSeconds = boundedInteger(
    env.SFU_TOKEN_TTL_SECONDS,
    6 * 60 * 60,
    10 * 60,
    24 * 60 * 60,
  );
  const expiresAt = (nowSeconds + ttlSeconds) * 1_000;
  const sfuRoom = `synced-${String(room).toLowerCase()}`;
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const payload = base64UrlJson({
    iss: cleanText(env.LIVEKIT_API_KEY, 128),
    sub: state.id,
    name: cleanText(state.nickname, 64, "朋友"),
    nbf: nowSeconds - 5,
    exp: nowSeconds + ttlSeconds,
    video: {
      room: sfuRoom,
      roomJoin: true,
      canPublish: state.canBroadcast === true,
      canPublishData: true,
      canSubscribe: true,
    },
  });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", env.LIVEKIT_API_SECRET)
    .update(unsigned)
    .digest("base64url");
  return {
    url: normalizedSfuUrl(env.SFU_PUBLIC_URL),
    room: sfuRoom,
    token: `${unsigned}.${signature}`,
    expiresAt,
  };
}

function resolveServerEnvironment(input) {
  const resolved = { ...input };
  for (const [valueKey, fileKey] of [
    ["TURN_SECRET", "TURN_SECRET_FILE"],
    ["METRICS_TOKEN", "METRICS_TOKEN_FILE"],
    ["LIVEKIT_API_SECRET", "LIVEKIT_API_SECRET_FILE"],
    ["SEGMENT_RELAY_SECRET", "SEGMENT_RELAY_SECRET_FILE"],
  ]) {
    if (resolved[valueKey] || !resolved[fileKey]) continue;
    try {
      const secret = readFileSync(resolved[fileKey], "utf8").trim();
      if (secret) resolved[valueKey] = secret;
    } catch (error) {
      console.error(
        `Unable to read ${fileKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return resolved;
}

function cleanText(value, maxLength, fallback = "") {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned || fallback).slice(0, maxLength).join("");
}

function cleanVideoCodec(value) {
  const codec = cleanText(value, 16).toLowerCase();
  return /^video\/(?:h264|vp8|vp9|av1)$/.test(codec) ? codec : undefined;
}

function cleanResumeToken(value) {
  const token = String(value || "").trim();
  return /^[a-z0-9-]{16,128}$/i.test(token) ? token : undefined;
}

function cleanOwnerToken(value) {
  const token = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  try {
    const bytes = Buffer.from(token, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === token
      ? token
      : undefined;
  } catch {
    return undefined;
  }
}

function roomForOwnerToken(token) {
  const bytes = token ? Buffer.from(token, "base64url") : undefined;
  if (!bytes || bytes.length !== 32) return undefined;
  const digest = createHash("sha256").update(bytes).digest();
  const values = [
    digest[0] >>> 3,
    ((digest[0] & 0x07) << 2) | (digest[1] >>> 6),
    (digest[1] >>> 1) & 0x1f,
    ((digest[1] & 0x01) << 4) | (digest[2] >>> 4),
    ((digest[2] & 0x0f) << 1) | (digest[3] >>> 7),
    (digest[3] >>> 2) & 0x1f,
    ((digest[3] & 0x03) << 3) | (digest[4] >>> 5),
    digest[4] & 0x1f,
  ];
  return values.map((value) => ROOM_ALPHABET[value]).join("");
}

function ownerKeyForToken(token) {
  return token
    ? createHash("sha256")
        .update(Buffer.from(token, "base64url"))
        .digest("base64url")
    : undefined;
}

function cleanBroadcastCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const width = Number(value.width);
  const height = Number(value.height);
  const frameRate = Number(value.frameRate);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(frameRate) ||
    width < 1 ||
    width > 7680 ||
    height < 1 ||
    height > 4320 ||
    frameRate < 1 ||
    frameRate > 120
  ) {
    return undefined;
  }
  const capabilities = {
    width: Math.round(width),
    height: Math.round(height),
    frameRate: Math.round(frameRate),
  };
  if (
    value.mode !== "emby" &&
    ["detail", "motion", "balanced"].includes(value.contentMode)
  ) {
    capabilities.contentMode = value.contentMode;
  }
  if (value.mode === "emby") {
    capabilities.mode = "emby";
    const mimeType = cleanText(value.mimeType, 180);
    const videoCodec = cleanText(value.videoCodec, 32).toLowerCase();
    const audioCodec = cleanText(value.audioCodec, 32).toLowerCase();
    const title = cleanText(value.title, 300);
    const bitrate = Number(value.bitrate);
    const durationTicks = Number(value.durationTicks);
    if (
      !/^video\/mp4;\s*codecs="[-a-z0-9., ]+"$/i.test(mimeType) ||
      !["h264", "hevc"].includes(videoCodec) ||
      audioCodec !== "aac" ||
      !Number.isFinite(bitrate) ||
      bitrate < 128_000 ||
      bitrate > 100_000_000
    ) {
      return undefined;
    }
    capabilities.mimeType = mimeType;
    capabilities.videoCodec = videoCodec;
    capabilities.audioCodec = audioCodec;
    capabilities.title = title || "Emby 高清播放";
    capabilities.bitrate = Math.round(bitrate);
    if (
      Number.isFinite(durationTicks) &&
      durationTicks > 0 &&
      durationTicks <= 7 * 24 * 60 * 60 * 10_000_000
    ) {
      capabilities.durationTicks = Math.round(durationTicks);
    }
  }
  return capabilities;
}

function broadcastMode(capabilities) {
  return capabilities?.mode === "emby" ? "emby" : "screen";
}

function cleanEmbyCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const capabilities = {
    mse: value.mse === true,
    h264: value.h264 === true,
    hevc: value.hevc === true,
    aac: value.aac === true,
    desktop: value.desktop === true,
  };
  const enhancementBackends = Array.isArray(value.videoEnhancementBackends)
    ? [
        ...new Set(
          value.videoEnhancementBackends.filter(
            (backend) =>
              backend === "webgl2-spatial" || backend === "rtx-video",
          ),
        ),
      ].slice(0, 2)
    : [];
  if (enhancementBackends.length) {
    capabilities.videoEnhancementBackends = enhancementBackends;
  }
  const maxEnhancementPixels = Number(value.maxEnhancementPixels);
  if (
    Number.isFinite(maxEnhancementPixels) &&
    maxEnhancementPixels >= 640 * 360 &&
    maxEnhancementPixels <= 16_384 * 8_640
  ) {
    capabilities.maxEnhancementPixels = Math.round(maxEnhancementPixels);
  }
  return capabilities;
}

function cleanNetworkReport(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (
    [
      "target",
      "url",
      "host",
      "hostname",
      "ip",
      "address",
      "origin",
      "iceServers",
    ].some((field) => Object.hasOwn(value, field))
  ) {
    return undefined;
  }
  const probeVersion = Number(value.probeVersion);
  const sampleId =
    typeof value.sampleId === "string" ? value.sampleId.trim() : "";
  const uploadKbps = value.uploadKbps;
  const downloadKbps = value.downloadKbps;
  const signalRttMs = value.signalRttMs;
  const jitterMs =
    value.jitterMs === undefined ? undefined : value.jitterMs;
  const measuredAt = value.measuredAt;
  const networkType =
    typeof value.networkType === "string" ? value.networkType : "";
  if (
    ![1, 2].includes(probeVersion) ||
    !/^[a-z0-9-]{8,64}$/i.test(sampleId) ||
    typeof uploadKbps !== "number" ||
    !Number.isFinite(uploadKbps) ||
    uploadKbps < 1 ||
    uploadKbps > 2_000_000 ||
    typeof downloadKbps !== "number" ||
    !Number.isFinite(downloadKbps) ||
    downloadKbps < 1 ||
    downloadKbps > 2_000_000 ||
    typeof signalRttMs !== "number" ||
    !Number.isFinite(signalRttMs) ||
    signalRttMs < 0 ||
    signalRttMs > 10_000 ||
    (jitterMs !== undefined &&
      (typeof jitterMs !== "number" ||
        !Number.isFinite(jitterMs) ||
        jitterMs < 0 ||
        jitterMs > 10_000)) ||
    typeof measuredAt !== "number" ||
    !Number.isFinite(measuredAt) ||
    measuredAt < now - NETWORK_REPORT_TTL_MS ||
    measuredAt > now + 5 * 60_000 ||
    !["ethernet", "wifi", "cellular", "unknown"].includes(networkType) ||
    typeof value.metered !== "boolean" ||
    (value.directReachable !== undefined &&
      typeof value.directReachable !== "boolean") ||
    (value.turnReachable !== undefined &&
      typeof value.turnReachable !== "boolean")
  ) {
    return undefined;
  }
  const report = {
    probeVersion,
    sampleId,
    uploadKbps: Math.round(uploadKbps),
    downloadKbps: Math.round(downloadKbps),
    signalRttMs: Math.round(signalRttMs),
    ...(jitterMs === undefined ? {} : { jitterMs: Math.round(jitterMs) }),
    networkType,
    metered: value.metered,
    measuredAt: Math.round(measuredAt),
    ...(value.directReachable === undefined
      ? {}
      : { directReachable: value.directReachable }),
    ...(value.turnReachable === undefined
      ? {}
      : { turnReachable: value.turnReachable }),
    receivedAt: now,
  };
  if (probeVersion === 1) return report;

  const optionalNumbers = {
    packetLossPercent: [0, 100],
    availableOutgoingBitrateBps: [10_000, 2_000_000_000],
    availableIncomingBitrateBps: [10_000, 2_000_000_000],
    relayRttMs: [0, 10_000],
  };
  for (const [field, [minimum, maximum]] of Object.entries(
    optionalNumbers,
  )) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      candidate < minimum ||
      candidate > maximum
    ) {
      return undefined;
    }
    report[field] = Math.round(candidate);
  }
  if (
    value.activeCandidateType !== undefined &&
    !["host", "srflx", "prflx", "relay", "unknown"].includes(
      value.activeCandidateType,
    )
  ) {
    return undefined;
  }
  if (
    value.relayProtocol !== undefined &&
    !["udp", "tcp", "tls", "unknown"].includes(value.relayProtocol)
  ) {
    return undefined;
  }
  if (value.activeCandidateType !== undefined) {
    report.activeCandidateType = value.activeCandidateType;
  }
  if (value.relayProtocol !== undefined) {
    report.relayProtocol = value.relayProtocol;
  }
  return report;
}

function cleanTransportReport(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (
    [
      "target",
      "url",
      "host",
      "hostname",
      "ip",
      "address",
      "origin",
      "iceServers",
      "candidate",
      "localCandidate",
      "remoteCandidate",
    ].some((field) => Object.hasOwn(value, field))
  ) {
    return undefined;
  }
  const sampleId = String(value.sampleId || "").trim();
  const sessionId = String(value.sessionId || "").trim();
  const mediaKind = String(value.mediaKind || "");
  const direction = String(value.direction || "");
  const candidateType = String(value.candidateType || "unknown");
  const relayProtocol = String(value.relayProtocol || "unknown");
  const reportedAt = Number(value.reportedAt);
  if (
    value.reportVersion !== 1 ||
    !/^[a-z0-9-]{8,64}$/i.test(sampleId) ||
    !/^[a-z0-9-]{8,64}$/i.test(sessionId) ||
    !["broadcast", "voice"].includes(mediaKind) ||
    !["send", "receive"].includes(direction) ||
    !["host", "srflx", "prflx", "relay", "unknown"].includes(
      candidateType,
    ) ||
    !["udp", "tcp", "tls", "unknown"].includes(relayProtocol) ||
    !Number.isFinite(reportedAt) ||
    reportedAt < now - NETWORK_REPORT_TTL_MS ||
    reportedAt > now + 5 * 60_000
  ) {
    return undefined;
  }
  const ranges = {
    roundTripTimeMs: [0, 10_000],
    jitterMs: [0, 10_000],
    packetLossPercent: [0, 100],
    availableOutgoingBitrateBps: [0, 2_000_000_000],
    availableIncomingBitrateBps: [0, 2_000_000_000],
    outboundBitrateBps: [0, 2_000_000_000],
    inboundBitrateBps: [0, 2_000_000_000],
    framesDroppedPercent: [0, 100],
    freezeCount: [0, 1_000_000],
  };
  const cleaned = {
    reportVersion: 1,
    sampleId,
    sessionId,
    mediaKind,
    direction,
    candidateType,
    relayProtocol,
    reportedAt: Math.round(reportedAt),
    receivedAt: now,
  };
  for (const [field, [minimum, maximum]] of Object.entries(ranges)) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      candidate < minimum ||
      candidate > maximum
    ) {
      return undefined;
    }
    cleaned[field] = Math.round(candidate);
  }
  return cleaned;
}

function freshNetworkReport(state, now = Date.now()) {
  const report = state?.networkReport;
  return report &&
    Number.isFinite(report.receivedAt) &&
    now - report.receivedAt < NETWORK_REPORT_TTL_MS
    ? report
    : undefined;
}

function freshTransportReports(state, now = Date.now()) {
  if (!(state?.transportReports instanceof Map)) return [];
  return [...state.transportReports.values()].filter(
    (report) =>
      Number.isFinite(report.receivedAt) &&
      now - report.receivedAt < TRANSPORT_REPORT_TTL_MS,
  );
}

function transportPenalty(reports) {
  if (!reports.length) return 1;
  const worstLoss = Math.max(
    ...reports.map((report) => report.packetLossPercent || 0),
  );
  const worstRtt = Math.max(
    ...reports.map((report) => report.roundTripTimeMs || 0),
  );
  const worstJitter = Math.max(
    ...reports.map((report) => report.jitterMs || 0),
  );
  const worstDropped = Math.max(
    ...reports.map((report) => report.framesDroppedPercent || 0),
  );
  const lossPenalty =
    worstLoss >= 12 ? 0.45 : worstLoss >= 6 ? 0.62 : worstLoss >= 2 ? 0.82 : 1;
  const latencyPenalty =
    worstRtt >= 500 ? 0.55 : worstRtt >= 250 ? 0.72 : worstRtt >= 140 ? 0.88 : 1;
  const jitterPenalty =
    worstJitter >= 100 ? 0.65 : worstJitter >= 50 ? 0.8 : 1;
  const decoderPenalty =
    worstDropped >= 12 ? 0.62 : worstDropped >= 5 ? 0.8 : 1;
  return Math.max(
    0.28,
    lossPenalty * latencyPenalty * jitterPenalty * decoderPenalty,
  );
}

function networkSafetyRatio(report, transportReports = []) {
  if (!report) return 0.55;
  const base =
    report.metered || report.networkType === "cellular"
      ? 0.5
      : report.networkType === "ethernet"
        ? 0.75
        : report.networkType === "wifi"
          ? 0.65
          : 0.55;
  const probeLossPenalty =
    report.packetLossPercent >= 10
      ? 0.55
      : report.packetLossPercent >= 4
        ? 0.75
        : report.packetLossPercent >= 1
          ? 0.9
          : 1;
  return Math.max(
    0.25,
    base * probeLossPenalty * transportPenalty(transportReports),
  );
}

function maxFrameRateByResolution(perViewerBudgetBps) {
  return Object.fromEntries(
    Object.entries(QUALITY_BITRATE_BPS).map(([resolution, bitrates]) => {
      const supported = QUALITY_FRAME_RATE_ORDER.filter(
        (frameRate) => bitrates[frameRate] <= perViewerBudgetBps,
      );
      return [resolution, supported.at(-1) || QUALITY_FRAME_RATE_ORDER[0]];
    }),
  );
}

export function recommendedResolution(perViewerBudgetBps) {
  return (
    QUALITY_RESOLUTION_ORDER.find(
      (resolution) =>
        QUALITY_BITRATE_BPS[resolution][
          QUALITY_RECOMMENDATION_BASELINE_FRAME_RATE
        ] <=
        perViewerBudgetBps,
    ) || "smooth"
  );
}

export function networkAdviceValidUntil(members, now = Date.now()) {
  let validUntil = now + NETWORK_ADVICE_VALIDITY_MS;
  for (const state of members) {
    const report = freshNetworkReport(state, now);
    if (report) {
      validUntil = Math.min(
        validUntil,
        report.receivedAt + NETWORK_REPORT_TTL_MS,
      );
    }
    for (const transportReport of freshTransportReports(state, now)) {
      validUntil = Math.min(
        validUntil,
        transportReport.receivedAt + TRANSPORT_REPORT_TTL_MS,
      );
    }
  }
  return Math.max(now, validUntil);
}

function reportedCapacityBps(report, transportReports, direction) {
  if (!report) return undefined;
  const measured =
    (direction === "send" ? report.uploadKbps : report.downloadKbps) *
    1_000;
  const probeEstimate =
    direction === "send"
      ? report.availableOutgoingBitrateBps
      : report.availableIncomingBitrateBps;
  const transportEstimates = transportReports
    .filter((candidate) => candidate.direction === direction)
    .map((candidate) =>
      direction === "send"
        ? candidate.availableOutgoingBitrateBps
        : candidate.availableIncomingBitrateBps,
    )
    .filter((candidate) => Number.isFinite(candidate) && candidate > 0);
  return Math.min(
    measured,
    ...(Number.isFinite(probeEstimate) ? [probeEstimate] : []),
    ...transportEstimates,
  );
}

function voicePolicyFor(state, now = Date.now()) {
  const report = freshNetworkReport(state, now);
  const transportReports = freshTransportReports(state, now).filter(
    (candidate) => candidate.mediaKind === "voice",
  );
  const constrained =
    report?.metered === true ||
    report?.networkType === "cellular" ||
    transportPenalty(transportReports) < 0.72;
  return {
    version: 2,
    sampleRate: 48_000,
    channels: 2,
    minimumBitrateBps: 96_000,
    speechTargetBitrateBps: constrained ? 192_000 : 256_000,
    musicTargetBitrateBps: constrained ? 256_000 : 320_000,
    maximumBitrateBps: 320_000,
    packetizationMs: 20,
    inbandFec: true,
    dtx: false,
    constrained,
  };
}

function buildNetworkAdvice({
  revision,
  recipient,
  broadcaster,
  members,
  activeRelaySessions = 0,
  sfuPrimary = false,
  now = Date.now(),
}) {
  const participantCount = members.length;
  const freshReports = members
    .map((state) => freshNetworkReport(state, now))
    .filter(Boolean);
  const measuredCount = freshReports.length;
  const broadcasterReport = freshNetworkReport(broadcaster, now);
  const viewers = broadcaster
    ? members.filter((state) => state.id !== broadcaster.id)
    : members.filter((state) => state.id !== recipient.id);
  const viewerCount = viewers.length;
  // A healthy SFU publication costs one broadcaster uplink. Viewers that have
  // explicitly fallen back still cost one additional P2P uplink each. Until
  // clients confirm SFU activity, use the conservative all-P2P fanout.
  const sfuPublisherActive = Boolean(
    sfuPrimary && broadcaster?.sfuPublisherActive,
  );
  const p2pFallbackViewerCount = viewers.filter(
    (viewer) => viewer.sfuViewerActive !== true,
  ).length;
  const fanoutCount = sfuPublisherActive
    ? Math.max(1, 1 + p2pFallbackViewerCount)
    : Math.max(1, viewerCount);
  const broadcasterTransportReports = freshTransportReports(
    broadcaster,
    now,
  ).filter((report) => report.mediaKind === "broadcast");
  const broadcasterBudget = broadcasterReport
    ? reportedCapacityBps(
        broadcasterReport,
        broadcasterTransportReports,
        "send",
      ) *
      networkSafetyRatio(
        broadcasterReport,
        broadcasterTransportReports,
      )
    : DEFAULT_PER_VIEWER_BUDGET_BPS * fanoutCount;
  const receiverBudget = viewers.length
    ? Math.min(
        ...viewers.map((state) => {
          const report = freshNetworkReport(state, now);
          const transportReports = freshTransportReports(
            state,
            now,
          ).filter((candidate) => candidate.mediaKind === "broadcast");
          return report
            ? reportedCapacityBps(
                report,
                transportReports,
                "receive",
              ) * networkSafetyRatio(report, transportReports)
            : DEFAULT_PER_VIEWER_BUDGET_BPS;
        }),
      )
    : Number.POSITIVE_INFINITY;
  const rawBudget = Math.min(
    broadcasterBudget / fanoutCount,
    receiverBudget,
    2_000_000_000,
  );
  const perViewerBudgetBps = Math.max(
    1_000_000,
    Math.round(rawBudget / 250_000) * 250_000,
  );
  const confidence =
    participantCount > 0 && measuredCount === participantCount
      ? "high"
      : measuredCount > 0
        ? "medium"
        : "low";
  const recipientReport = freshNetworkReport(recipient, now);
  const recipientTransportReports = freshTransportReports(
    recipient,
    now,
  );
  const recipientUsingRelay = recipientTransportReports.some(
    (report) => report.candidateType === "relay",
  );
  const recipientTransportPoor =
    transportPenalty(recipientTransportReports) < 0.72;
  const roomRequiresRelay = members.some((state) => {
    const report = freshNetworkReport(state, now);
    return (
      report?.directReachable === false &&
      report?.turnReachable === true
    );
  });
  const hasVerifiedRelayPreference =
    (recipientReport?.directReachable === false &&
      recipientReport?.turnReachable === true) ||
    recipientUsingRelay ||
    roomRequiresRelay ||
    activeRelaySessions > 0;
  const p2pConditionsLookHealthy =
    freshReports.length === participantCount &&
    freshReports.every(
      (report) => {
        const owner = members.find(
          (state) => state.networkReport === report,
        );
        return (
          report.directReachable !== false &&
          !report.metered &&
          ["ethernet", "wifi"].includes(report.networkType) &&
          report.signalRttMs <= 120 &&
          (report.packetLossPercent ?? 0) < 3 &&
          transportPenalty(freshTransportReports(owner, now)) >= 0.82
        );
      },
    );
  const routeMode = sfuPrimary
    ? "sfu-preferred"
    : hasVerifiedRelayPreference
      ? "relay-preferred"
      : p2pConditionsLookHealthy
        ? "p2p-preferred"
        : "balanced";
  // TURN and SFU are transport paths, not bandwidth governors. Encoder
  // recommendations follow measured endpoint capacity only; the server never
  // clamps a room or allocation to a configured relay budget.
  const boundedBudgetBps = perViewerBudgetBps;
  const transportReports = members.flatMap((state) =>
    freshTransportReports(state, now),
  );
  const lossyParticipants = members.filter((state) =>
    freshTransportReports(state, now).some(
      (report) =>
        (report.packetLossPercent || 0) >= 4 ||
        (report.framesDroppedPercent || 0) >= 5,
    ),
  ).length;
  const highLatencyParticipants = members.filter((state) =>
    freshTransportReports(state, now).some(
      (report) => (report.roundTripTimeMs || 0) >= 250,
    ),
  ).length;
  const relayParticipants = members.filter((state) =>
    freshTransportReports(state, now).some(
      (report) => report.candidateType === "relay",
    ),
  ).length;
  const congestion =
    recipientTransportPoor || lossyParticipants > 0
      ? "constrained"
      : transportReports.length
        ? "healthy"
        : "unknown";
  const routeLabel =
    routeMode === "sfu-preferred"
      ? "优先使用服务器 SFU，故障时自动回退 P2P"
      : routeMode === "relay-preferred"
      ? "建议优先尝试腾讯云中继"
      : routeMode === "p2p-preferred"
        ? "当前条件适合优先 P2P"
        : "建议同时保留 P2P 与中继兜底";
  return {
    revision,
    participantCount,
    measuredCount,
    confidence,
    perViewerBudgetBps: boundedBudgetBps,
    recommendedResolution: recommendedResolution(boundedBudgetBps),
    maxFrameRateByResolution:
      maxFrameRateByResolution(boundedBudgetBps),
    routeMode,
    reason:
      viewerCount > 0
        ? sfuPublisherActive
          ? p2pFallbackViewerCount > 0
            ? `${participantCount} 人频道由 SFU 主线路和 ${p2pFallbackViewerCount} 路 P2P 备用共同承载；${routeLabel}`
            : `${participantCount} 人频道由 SFU 单路接收并转发；${routeLabel}`
          : sfuPrimary
            ? `SFU 尚未确认就绪，暂按 ${viewerCount} 路 P2P 备用上行计算；${routeLabel}`
            : `${participantCount} 人频道按 ${viewerCount} 路上行综合计算；${routeLabel}`
        : `当前暂无观众；${routeLabel}`,
    schemaVersion: 2,
    generatedAt: now,
    validUntil: networkAdviceValidUntil(members, now),
    recommendedTargetBitrateBps: Math.max(
      800_000,
      Math.floor(boundedBudgetBps * 0.88),
    ),
    relayCapacityBps: null,
    relaySessionCapacityBps: null,
    relayCapacityEnforced: false,
    sfuPublisherActive,
    p2pFallbackViewerCount,
    congestion,
    aggregate: {
      transportSampleCount: transportReports.length,
      lossyParticipants,
      highLatencyParticipants,
      relayParticipants,
      unmeasuredParticipants: Math.max(
        0,
        participantCount - measuredCount,
      ),
    },
  };
}

function cleanSignalData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (typeof value.type === "string") {
    const type = cleanText(value.type, 16);
    if (!["offer", "answer", "pranswer", "rollback"].includes(type)) {
      return undefined;
    }
    if (type === "rollback") {
      return { type };
    }
    if (typeof value.sdp !== "string" || value.sdp.length > 196 * 1024) {
      return undefined;
    }
    return { type, sdp: value.sdp };
  }
  if (
    typeof value.candidate !== "string" ||
    value.candidate.length > 4_096 ||
    (value.candidate &&
      !/^(?:a=)?candidate:/i.test(value.candidate.trim()))
  ) {
    return undefined;
  }
  const candidate = { candidate: value.candidate };
  if (
    value.sdpMid === null ||
    (typeof value.sdpMid === "string" && value.sdpMid.length <= 64)
  ) {
    candidate.sdpMid = value.sdpMid;
  }
  if (
    value.sdpMLineIndex === null ||
    (Number.isInteger(value.sdpMLineIndex) &&
      value.sdpMLineIndex >= 0 &&
      value.sdpMLineIndex <= 32)
  ) {
    candidate.sdpMLineIndex = value.sdpMLineIndex;
  }
  if (
    value.usernameFragment === null ||
    (typeof value.usernameFragment === "string" &&
      value.usernameFragment.length <= 256)
  ) {
    candidate.usernameFragment = value.usernameFragment;
  }
  return candidate;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
}

function normalizedIp(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return undefined;
  const ipv4Mapped = candidate.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const normalized = ipv4Mapped || candidate;
  return isIP(normalized) ? normalized : undefined;
}

function ipv6Prefix64(value) {
  const convertPart = (part) => {
    if (!part.includes(".")) return [part];
    const octets = part.split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return [];
    }
    return [
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    ];
  };
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0]
    ? halves[0].split(":").flatMap(convertPart)
    : [];
  const right = halves.length === 2 && halves[1]
    ? halves[1].split(":").flatMap(convertPart)
    : [];
  const missing = 8 - left.length - right.length;
  if (
    left.length + right.length > 8 ||
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return undefined;
  }
  const words = [
    ...left,
    ...Array.from({ length: Math.max(0, missing) }, () => "0"),
    ...right,
  ];
  if (
    words.length !== 8 ||
    words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))
  ) {
    return undefined;
  }
  return words
    .slice(0, 4)
    .map((word) => word.padStart(4, "0"))
    .join(":");
}

function rateLimitKey(ip) {
  if (isIP(ip) !== 6) return `ipv4:${ip}`;
  return `ipv6-64:${ipv6Prefix64(ip) || ip.toLowerCase()}`;
}

function requestIp(request, env) {
  const directIp = normalizedIp(request.socket.remoteAddress) || "unknown";
  const localProxy =
    directIp === "127.0.0.1" ||
    directIp === "::1";
  if (env.TRUST_PROXY === "true" && localProxy) {
    const forwardedHeader = request.headers["x-forwarded-for"];
    const forwardedValues = (
      Array.isArray(forwardedHeader)
        ? forwardedHeader[0]
        : forwardedHeader
    )
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    // The nearest trusted proxy appends (or, preferably, overwrites with) the
    // actual client address. Taking the right-most hop prevents a client from
    // prepending a forged X-Forwarded-For value to evade per-IP limits.
    const forwarded = forwardedValues?.at(-1);
    return normalizedIp(forwarded) || directIp;
  }
  return directIp;
}

function originAllowed(origin, env) {
  const allowed = env.ALLOWED_ORIGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowed?.includes("*")) {
    return true;
  }
  if (!origin) {
    return env.ALLOW_NO_ORIGIN !== "false";
  }
  if (allowed?.length) {
    return allowed.includes(origin);
  }
  if (DEFAULT_ALLOWED_ORIGINS.has(origin)) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    const configuredMaximum =
      socket.syncedMaxBufferedBytes || SIGNAL_MAX_BUFFERED_BYTES;
    const maximumBufferedBytes =
      payload?.type === "network:probe-result"
        ? Math.max(
            configuredMaximum,
            NETWORK_PROBE_V2_MAX_BYTES_PER_DIRECTION + 128 * 1024,
          )
        : configuredMaximum;
    if (socket.bufferedAmount > maximumBufferedBytes) {
      if (socket.syncedMetrics) {
        socket.syncedMetrics.slowClientDropsTotal += 1;
      }
      try {
        socket.close(1013, "signaling backpressure");
      } catch {
        socket.terminate();
      }
      return false;
    }
    try {
      socket.send(JSON.stringify(payload));
      if (socket.syncedMetrics) {
        socket.syncedMetrics.messagesSentTotal += 1;
      }
      return true;
    } catch {
      socket.terminate();
      return false;
    }
  }
  return false;
}

function rejectUpgrade(socket, statusCode, statusText) {
  try {
    socket.end(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        "Connection: close\r\n" +
        "Content-Length: 0\r\n\r\n",
    );
  } catch {
    socket.destroy();
  }
}

function participantFor(state) {
  return {
    id: state.id,
    nickname: state.nickname,
    role: state.role,
    voiceActive: state.voiceActive,
    microphoneMuted: state.microphoneMuted,
    microphoneDisabled: state.microphoneDisabled,
    broadcasting: state.broadcasting,
    embyCapabilities: state.embyCapabilities,
  };
}

function stabilizeNetworkAdvice(previous, candidate) {
  if (
    !previous ||
    previous.confidence !== "high" ||
    candidate.confidence !== "high"
  ) {
    return candidate;
  }
  const previousBudget = previous.perViewerBudgetBps;
  const proposedBudget = candidate.perViewerBudgetBps;
  let stableBudget = proposedBudget;
  if (proposedBudget > previousBudget * 1.25) {
    stableBudget = Math.round((previousBudget * 1.25) / 250_000) * 250_000;
  } else if (
    proposedBudget < previousBudget &&
    proposedBudget >= previousBudget * 0.88
  ) {
    // Small WebRTC estimates bounce on every stats sample. Preserve the
    // current quality for minor dips, but degrade immediately for a real
    // congestion event so buffers do not build up.
    stableBudget = previousBudget;
  }
  if (stableBudget === proposedBudget) return candidate;
  return {
    ...candidate,
    perViewerBudgetBps: stableBudget,
    recommendedResolution: recommendedResolution(stableBudget),
    maxFrameRateByResolution: maxFrameRateByResolution(stableBudget),
    recommendedTargetBitrateBps: Math.max(
      800_000,
      Math.floor(stableBudget * 0.88),
    ),
  };
}

function publicIceCapabilities(env) {
  const urls = [
    ...(env.TURN_URLS || "").split(","),
    ...(() => {
      try {
        const servers = JSON.parse(env.ICE_SERVERS_JSON || "[]");
        return Array.isArray(servers)
          ? servers.flatMap((server) =>
              Array.isArray(server?.urls)
                ? server.urls
                : [server?.urls],
            )
          : [];
      } catch {
        return [];
      }
    })(),
  ].filter((value) => typeof value === "string");
  return {
    stun: urls.some((url) => /^stuns?:/iu.test(url)),
    turnUdp: urls.some(
      (url) =>
        /^turns?:/iu.test(url) &&
        !/[?&]transport=(?:tcp|tls)(?:&|$)/iu.test(url),
    ),
    turnTcp:
      env.TURN_TCP_ENABLED === "true" &&
      urls.some(
        (url) =>
          /^turns?:/iu.test(url) &&
          /[?&]transport=tcp(?:&|$)/iu.test(url),
      ),
    temporaryCredentials: Boolean(env.TURN_SECRET && env.TURN_URLS),
  };
}

export function createSignalServer(options = {}) {
  const startedAt = Date.now();
  const rooms = new Map();
  const clients = new Map();
  const clientsByIp = new Map();
  const networkProbeRoundsByIp = new Map();
  const env = resolveServerEnvironment(options.env || process.env);
  const logger = options.logger || console;
  const segmentRelay = createSegmentRelay({
    rootDir: env.SEGMENT_RELAY_CACHE_DIR,
    maxDiskBytes: Number(env.SEGMENT_RELAY_DISK_BYTES) || undefined,
    maxMemoryBytes: Number(env.SEGMENT_RELAY_MEMORY_BYTES) || undefined,
    secret: env.SEGMENT_RELAY_SECRET,
    // Chromium serializes a packaged file:// fetch origin as "null".
    // Accept it only on the independently bearer-authenticated media route;
    // the WebSocket origin policy remains stricter.
    originAllowed: (origin) =>
      origin === "null" || originAllowed(origin, env),
    authorizeIdentity: (identity, requiredScope) => {
      const client = clients.get(identity.clientId);
      const room = rooms.get(identity.room);
      if (
        !client ||
        !room ||
        client.state.room !== identity.room ||
        !room.members.has(identity.clientId) ||
        client.state.disconnectFinalized
      ) {
        return false;
      }
      if (identity.scope === "publish" || requiredScope === "publish") {
        return (
          room.broadcasterId === identity.clientId &&
          client.state.broadcasting === true
        );
      }
      return true;
    },
  });
  const configuredViewerLimit = Number(env.MAX_VIEWERS_PER_ROOM);
  const maxParticipantsPerRoom =
    Number.isInteger(configuredViewerLimit) && configuredViewerLimit > 0
      ? Math.min(
          configuredViewerLimit + 1,
          MAX_PARTICIPANTS_PER_ROOM,
        )
      : DEFAULT_MAX_VIEWERS_PER_ROOM + 1;
  const maxClients = boundedInteger(
    env.MAX_CLIENTS,
    DEFAULT_MAX_CLIENTS,
    8,
    2_048,
  );
  const maxClientsPerIp = boundedInteger(
    env.MAX_CLIENTS_PER_IP,
    DEFAULT_MAX_CLIENTS_PER_IP,
    2,
    128,
  );
  const disconnectGraceMs = boundedInteger(
    env.DISCONNECT_GRACE_MS,
    DEFAULT_DISCONNECT_GRACE_MS,
    10_000,
    120_000,
  );
  const allowLegacyProtocol = env.ALLOW_LEGACY_PROTOCOL === "true";
  const maxMessagesPerMinute = boundedInteger(
    env.MAX_MESSAGES_PER_MINUTE,
    MAX_MESSAGES_PER_MINUTE,
    60,
    3_600,
  );
  const maxBufferedBytes = boundedInteger(
    env.SIGNAL_MAX_BUFFERED_BYTES,
    SIGNAL_MAX_BUFFERED_BYTES,
    256 * 1024,
    8 * 1024 * 1024,
  );
  const metrics = {
    websocketConnectionsTotal: 0,
    rejectedUpgradesTotal: 0,
    messagesReceivedTotal: 0,
    messagesSentTotal: 0,
    invalidMessagesTotal: 0,
    rateLimitedTotal: 0,
    networkProbeRoundsTotal: 0,
    networkProbeBytesTotal: 0,
    networkReportsTotal: 0,
    transportReportsTotal: 0,
    adviceBroadcastsTotal: 0,
    mediaSignalsRelayedTotal: 0,
    voiceSignalsRelayedTotal: 0,
    slowClientDropsTotal: 0,
    resumedConnectionsTotal: 0,
    disconnectGraceExpiredTotal: 0,
  };
  const nodeIdentity = {
    nodeId: cleanText(env.SIGNAL_NODE_ID, 64, "signal-primary"),
    region: cleanText(env.SIGNAL_REGION, 64, "unknown"),
  };

  function activeRelaySessions(now = Date.now()) {
    return [...clients.values()].reduce(
      (count, client) =>
        count +
        freshTransportReports(client.state, now).filter(
          (report) => report.candidateType === "relay",
        ).length,
      0,
    );
  }

  function serverCapabilities() {
    return {
      name: "synced-signal",
      status: "ready",
      ...signalCompatibility(),
      ...nodeIdentity,
      websocket: "/signal",
      limits: {
        maxClients,
        maxClientsPerIp,
        maxParticipantsPerRoom,
        maxMessagesPerMinute,
        maximumBufferedBytes: maxBufferedBytes,
      },
      networkProbe: {
        versions: [1, 2],
        latencySamples: NETWORK_PROBE_MAX_LATENCY_SAMPLES,
        version1: {
          chunkBytes: NETWORK_PROBE_CHUNK_BYTES,
          maximumChunks: NETWORK_PROBE_MAX_CHUNKS,
          maximumBytesPerDirection:
            NETWORK_PROBE_MAX_BYTES_PER_DIRECTION,
        },
        version2: {
          chunkBytes: NETWORK_PROBE_V2_CHUNK_BYTES,
          maximumChunks: NETWORK_PROBE_V2_MAX_CHUNKS,
          maximumBytesPerDirection:
            NETWORK_PROBE_V2_MAX_BYTES_PER_DIRECTION,
        },
      },
      ice: publicIceCapabilities(env),
      sfu: {
        enabled: sfuEnabled(env),
        ...(sfuEnabled(env)
          ? { url: normalizedSfuUrl(env.SFU_PUBLIC_URL) }
          : {}),
        primary: true,
        fallback: "p2p",
      },
      segmentRelay: {
        enabled: true,
        basePath: "/media/v1",
        protocol: "synced-cmaf-v1",
        tokenLifetimeSeconds: 15 * 60,
      },
      relayCapacityBps: null,
      relaySessionCapacityBps: null,
      relayCapacityEnforced: false,
      voicePolicy: voicePolicyFor(undefined),
    };
  }

  function runtimeSnapshot() {
    let broadcasters = 0;
    let voiceParticipants = 0;
    for (const client of clients.values()) {
      if (client.state.broadcasting) broadcasters += 1;
      if (client.state.voiceActive) voiceParticipants += 1;
    }
    const clientUtilization = Number(
      (clients.size / maxClients).toFixed(4),
    );
    const memory = process.memoryUsage();
    return {
      ok: true,
      status: clientUtilization >= 0.9 ? "saturated" : "ready",
      protocolVersion: SIGNAL_PROTOCOL_VERSION,
      ...nodeIdentity,
      serverTime: Date.now(),
      uptimeSeconds: Math.max(
        0,
        Math.floor((Date.now() - startedAt) / 1_000),
      ),
      rooms: rooms.size,
      clients: clients.size,
      broadcasters,
      voiceParticipants,
      activeRelaySessions: activeRelaySessions(),
      capacity: {
        acceptingConnections: clients.size < maxClients,
        clientUtilization,
        relayCapacityBps: null,
        relaySessionCapacityBps: null,
        relayCapacityEnforced: false,
      },
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      },
      segmentRelay: segmentRelay.snapshot(),
    };
  }

  function metricsText() {
    const snapshot = runtimeSnapshot();
    const gauges = {
      synced_signal_up: 1,
      synced_signal_rooms: snapshot.rooms,
      synced_signal_clients: snapshot.clients,
      synced_signal_broadcasters: snapshot.broadcasters,
      synced_signal_voice_participants: snapshot.voiceParticipants,
      synced_signal_active_relay_sessions:
        snapshot.activeRelaySessions,
      synced_signal_uptime_seconds: snapshot.uptimeSeconds,
      synced_signal_memory_rss_bytes: snapshot.memory.rssBytes,
      synced_signal_memory_heap_used_bytes:
        snapshot.memory.heapUsedBytes,
    };
    const counters = Object.fromEntries(
      Object.entries(metrics).map(([key, value]) => [
        `synced_signal_${key
          .replace(/Total$/u, "_total")
          .replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`,
        value,
      ]),
    );
    return Object.entries({ ...gauges, ...counters })
      .map(([name, value]) => `${name} ${value}`)
      .join("\n")
      .concat("\n");
  }

  function getRoomClientIds(room) {
    return [...room.members];
  }

  function getRoomParticipants(room) {
    return getRoomClientIds(room)
      .map((id) => clients.get(id)?.state)
      .filter(Boolean)
      .map(participantFor);
  }

  function broadcastRoom(room, payload, exceptId) {
    for (const id of getRoomClientIds(room)) {
      if (id === exceptId) {
        continue;
      }
      const client = clients.get(id);
      if (client) {
        send(client.socket, payload);
      }
    }
  }

  function iceConfigurationFor(roomCode, clientId) {
    const iceServers = buildIceServers(roomCode, env, clientId);
    const iceExpiresAt = temporaryIceCredentialExpiresAt(iceServers);
    return {
      iceServers,
      ...(iceExpiresAt ? { iceExpiresAt } : {}),
    };
  }

  function scheduleNextIceRefresh(state, now = Date.now()) {
    const ttlIntervalMs = Math.floor(
      turnCredentialTtlSeconds(env) * 1_000 * 0.7,
    );
    state.nextIceRefreshAt =
      now +
      Math.min(
        ICE_CREDENTIAL_REFRESH_MAX_INTERVAL_MS,
        Math.max(5 * 60_000, ttlIntervalMs),
      );
  }

  function sendIceRefresh(client, now = Date.now()) {
    const state = client?.state;
    if (!state?.room || !state.role) return false;
    send(client.socket, {
      type: "server:ice-refresh",
      ...iceConfigurationFor(state.room, state.id),
    });
    state.lastIceRefreshAt = now;
    scheduleNextIceRefresh(state, now);
    return true;
  }

  function clientIceConfiguration(state, now = Date.now()) {
    scheduleNextIceRefresh(state, now);
    const sfu = buildSfuAccess(state.room, state, env);
    return {
      ...iceConfigurationFor(state.room, state.id),
      iceRefreshToken: state.iceRefreshToken,
      ...(sfu ? { sfu } : {}),
    };
  }

  function segmentRelayAccess(state, scope = "read") {
    if (!state?.room || !state.id) return undefined;
    return segmentRelay.issueToken({
      room: state.room,
      clientId: state.id,
      scope,
    });
  }

  function clearNetworkAdviceTimer(room) {
    if (room?.networkAdviceTimer) {
      clearTimeout(room.networkAdviceTimer);
      room.networkAdviceTimer = undefined;
    }
  }

  function emitNetworkAdvice(room, now = Date.now()) {
    const members = getRoomClientIds(room)
      .map((id) => clients.get(id)?.state)
      .filter(Boolean);
    if (!members.length) return;
    room.networkAdviceRevision =
      Math.max(0, Number(room.networkAdviceRevision) || 0) + 1;
    room.lastNetworkAdviceAt = now;
    room.networkAdviceByRecipient ??= new Map();
    const activeBroadcaster = room.broadcasterId
      ? clients.get(room.broadcasterId)?.state
      : undefined;
    // This is a global client scan. Compute it once per room update, not once
    // again for every recipient in that room.
    const relaySessions = activeRelaySessions(now);
    for (const recipient of members) {
      const broadcaster =
        activeBroadcaster ||
        (recipient.canBroadcast ? recipient : undefined) ||
        members.find((state) => state.canBroadcast) ||
        recipient;
      const client = clients.get(recipient.id);
      if (!client) continue;
      const candidateAdvice = buildNetworkAdvice({
        revision: room.networkAdviceRevision,
        recipient,
        broadcaster,
        members,
        activeRelaySessions: relaySessions,
        sfuPrimary: sfuEnabled(env),
        now,
      });
      const networkAdvice = stabilizeNetworkAdvice(
        room.networkAdviceByRecipient.get(recipient.id),
        candidateAdvice,
      );
      room.networkAdviceByRecipient.set(recipient.id, networkAdvice);
      send(client.socket, {
        type: "network:advice",
        networkAdvice,
      });
      metrics.adviceBroadcastsTotal += 1;
    }
  }

  function broadcastNetworkAdvice(room) {
    if (!room || room.networkAdviceTimer) return;
    room.networkAdviceTimer = setTimeout(() => {
      room.networkAdviceTimer = undefined;
      emitNetworkAdvice(room, Date.now());
    }, NETWORK_ADVICE_DEBOUNCE_MS);
    room.networkAdviceTimer.unref?.();
  }

  function activeClientCount() {
    let count = 0;
    for (const { socket } of clients.values()) {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        count += 1;
      }
    }
    return count;
  }

  function finalizeClientDeparture(clientId, state) {
    if (state.superseded) {
      // A resumed socket keeps the same participant id and inherits voice,
      // microphone, broadcast and telemetry state before the old socket is
      // terminated. Emitting voice:left here would tear down a healthy,
      // seamlessly transferred voice session for every other participant.
      return;
    }
    if (state.disconnectFinalized) return;
    const current = clients.get(clientId);
    if (!current || current.state !== state) return;
    state.disconnectFinalized = true;
    if (state.disconnectTimer) {
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = undefined;
    }
    if (!state.room || !state.role) {
      clients.delete(clientId);
      return;
    }
    const roomCode = state.room;
    const room = rooms.get(roomCode);
    if (!room) {
      clients.delete(clientId);
      return;
    }
    leaveVoice(state, room);
    const wasBroadcaster = room.broadcasterId === clientId;
    if (wasBroadcaster) {
      stopBroadcast(room, clientId, "left");
      if (state.protocol === "legacy-host") {
        broadcastRoom(room, { type: "host:left" }, clientId);
      }
    } else if (room.broadcasterId) {
      const broadcaster = clients.get(room.broadcasterId);
      if (broadcaster) {
        send(broadcaster.socket, {
          type: "viewer:left",
          viewerId: clientId,
        });
      }
    }
    room.members.delete(clientId);
    room.networkAdviceByRecipient?.delete(clientId);
    clients.delete(clientId);
    broadcastRoom(room, {
      type: "participant:left",
      participantId: clientId,
    });

    if (room.members.size === 0) {
      clearNetworkAdviceTimer(room);
      rooms.delete(roomCode);
      segmentRelay.deleteRoom(roomCode);
      return;
    }
    if (room.ownerId === clientId) {
      if (room.ownerKey) {
        room.ownerId = undefined;
      } else {
        let nextOwner;
        for (const memberId of [...room.members]) {
          const candidate = clients.get(memberId);
          if (
            !candidate ||
            candidate.state.superseded ||
            candidate.state.disconnectFinalized ||
            candidate.state.room !== roomCode
          ) {
            room.members.delete(memberId);
            room.networkAdviceByRecipient?.delete(memberId);
            continue;
          }
          if (
            candidate.state.disconnectTimer ||
            candidate.socket.readyState !== WebSocket.OPEN
          ) {
            continue;
          }
          nextOwner = candidate.state;
          break;
        }
        room.ownerId = nextOwner?.id;
        if (nextOwner) {
          nextOwner.role = "host";
          broadcastRoom(room, {
            type: "participant:updated",
            participant: participantFor(nextOwner),
          });
        }
      }
    }
    broadcastNetworkAdvice(room);
  }

  function consumeNetworkProbeRound(ipLimitKey, now) {
    const recentRounds = (
      networkProbeRoundsByIp.get(ipLimitKey)?.timestamps || []
    ).filter((timestamp) => now - timestamp < 60_000);
    if (
      recentRounds.length >=
      NETWORK_PROBE_MAX_ROUNDS_PER_IP_PER_MINUTE
    ) {
      networkProbeRoundsByIp.set(ipLimitKey, {
        timestamps: recentRounds,
      });
      return false;
    }
    recentRounds.push(now);
    networkProbeRoundsByIp.set(ipLimitKey, {
      timestamps: recentRounds,
    });
    metrics.networkProbeRoundsTotal += 1;
    return true;
  }

  function sendNetworkProbeError(socket, code, message) {
    send(socket, {
      type: "error",
      code,
      message,
    });
  }

  function handleNetworkProbe(socket, state, message, now) {
    if (
      ["target", "url", "host", "hostname", "ip", "address", "origin"].some(
        (field) => Object.hasOwn(message, field),
      )
    ) {
      sendNetworkProbeError(
        socket,
        "network-probe-invalid",
        "网络探测参数无效",
      );
      return;
    }
    const probeId = String(message.probeId || "").trim();
    const phase = String(message.phase || "");
    const sequence = message.sequence;
    const total = message.total;
    const probeVersion =
      message.probeVersion === undefined
        ? 1
        : Number(message.probeVersion);
    const chunkBytes =
      probeVersion === 2
        ? NETWORK_PROBE_V2_CHUNK_BYTES
        : NETWORK_PROBE_CHUNK_BYTES;
    const maximumChunks =
      probeVersion === 2
        ? NETWORK_PROBE_V2_MAX_CHUNKS
        : NETWORK_PROBE_MAX_CHUNKS;
    const maximumBytesPerDirection =
      probeVersion === 2
        ? NETWORK_PROBE_V2_MAX_BYTES_PER_DIRECTION
        : NETWORK_PROBE_MAX_BYTES_PER_DIRECTION;
    const maximumTotal =
      phase === "latency"
        ? NETWORK_PROBE_MAX_LATENCY_SAMPLES
        : phase === "upload" || phase === "download"
          ? maximumChunks
          : 0;
    if (
      ![1, 2].includes(probeVersion) ||
      !/^[a-z0-9-]{8,64}$/i.test(probeId) ||
      !maximumTotal ||
      typeof sequence !== "number" ||
      !Number.isInteger(sequence) ||
      typeof total !== "number" ||
      !Number.isInteger(total) ||
      total < 1 ||
      total > maximumTotal ||
      sequence < 0 ||
      sequence >= total
    ) {
      sendNetworkProbeError(
        socket,
        "network-probe-invalid",
        "网络探测参数无效",
      );
      return;
    }

    let probe = state.networkProbe;
    if (
      probe &&
      now - probe.startedAt > NETWORK_PROBE_ROUND_TIMEOUT_MS
    ) {
      probe = undefined;
      state.networkProbe = undefined;
    }
    if (probe && probe.probeId !== probeId && !probe.completed) {
      sendNetworkProbeError(
        socket,
        "network-probe-active",
        "上一轮网络探测尚未完成",
      );
      return;
    }
    if (!probe || probe.probeId !== probeId) {
      const activeProbeRounds = [...clients.values()].filter(
        (client) =>
          client.state.networkProbe &&
          !client.state.networkProbe.completed &&
          now - client.state.networkProbe.startedAt <=
            NETWORK_PROBE_ROUND_TIMEOUT_MS,
      ).length;
      if (activeProbeRounds >= NETWORK_PROBE_MAX_CONCURRENT_ROUNDS) {
        metrics.rateLimitedTotal += 1;
        sendNetworkProbeError(
          socket,
          "network-probe-busy",
          "服务器测速队列繁忙，请稍后重试",
        );
        return;
      }
      const maximumRounds =
        probeVersion === 2
          ? NETWORK_PROBE_V2_MAX_ROUNDS_PER_CONNECTION
          : NETWORK_PROBE_MAX_ROUNDS_PER_CONNECTION;
      if (
        state.networkProbeRounds >= maximumRounds
      ) {
        sendNetworkProbeError(
          socket,
          "network-probe-rate-limit",
          "网络探测过于频繁",
        );
        return;
      }
      if (!consumeNetworkProbeRound(state.ipLimitKey, now)) {
        sendNetworkProbeError(
          socket,
          "network-probe-rate-limit",
          "当前网络的探测请求过于频繁",
        );
        return;
      }
      probe = {
        probeId,
        probeVersion,
        startedAt: now,
        completed: false,
        phases: new Map(),
        uploadBytes: 0,
        downloadBytes: 0,
        requests: 0,
      };
      state.networkProbe = probe;
      state.networkProbeRounds += 1;
    }
    if (probe.probeVersion !== probeVersion) {
      sendNetworkProbeError(
        socket,
        "network-probe-invalid",
        "同一轮网络探测的版本不能改变",
      );
      return;
    }

    let phaseState = probe.phases.get(phase);
    if (!phaseState) {
      phaseState = {
        total,
        sequences: new Set(),
      };
      probe.phases.set(phase, phaseState);
    }
    if (
      phaseState.total !== total ||
      phaseState.sequences.has(sequence) ||
      probe.requests >=
        NETWORK_PROBE_MAX_LATENCY_SAMPLES +
          maximumChunks * 2
    ) {
      sendNetworkProbeError(
        socket,
        "network-probe-invalid",
        "网络探测分片无效或重复",
      );
      return;
    }

    let resultPayload;
    if (phase === "upload") {
      if (typeof message.payload !== "string") {
        sendNetworkProbeError(
          socket,
          "network-probe-invalid",
          "上传探测分片无效",
        );
        return;
      }
      const payloadBytes = Buffer.byteLength(message.payload, "utf8");
      if (
        payloadBytes < 1 ||
        payloadBytes > chunkBytes ||
        probe.uploadBytes + payloadBytes >
          maximumBytesPerDirection
      ) {
        sendNetworkProbeError(
          socket,
          "network-probe-size-limit",
          "上传探测数据超过限制",
        );
        return;
      }
      probe.uploadBytes += payloadBytes;
      metrics.networkProbeBytesTotal += payloadBytes;
    } else {
      if (
        message.payload !== undefined &&
        message.payload !== ""
      ) {
        sendNetworkProbeError(
          socket,
          "network-probe-invalid",
          "该探测阶段不能携带数据",
        );
        return;
      }
      if (phase === "download") {
        const requestedPayloadBytes =
          probeVersion === 2 && message.payloadBytes !== undefined
            ? Number(message.payloadBytes)
            : chunkBytes;
        if (
          !Number.isInteger(requestedPayloadBytes) ||
          requestedPayloadBytes < 1 ||
          requestedPayloadBytes > chunkBytes
        ) {
          sendNetworkProbeError(
            socket,
            "network-probe-size-limit",
            "下载探测分片大小超过限制",
          );
          return;
        }
        if (
          probe.downloadBytes + requestedPayloadBytes >
          maximumBytesPerDirection
        ) {
          sendNetworkProbeError(
            socket,
            "network-probe-size-limit",
            "下载探测数据超过限制",
          );
          return;
        }
        resultPayload = (
          probeVersion === 2
            ? NETWORK_PROBE_V2_PAYLOAD
            : NETWORK_PROBE_PAYLOAD
        ).slice(0, requestedPayloadBytes);
        probe.downloadBytes += requestedPayloadBytes;
        metrics.networkProbeBytesTotal += requestedPayloadBytes;
      }
    }

    phaseState.sequences.add(sequence);
    probe.requests += 1;
    if (phaseState.sequences.size === phaseState.total) {
      phaseState.completed = true;
    }
    probe.completed =
      ["latency", "upload", "download"].every(
        (candidate) => probe.phases.get(candidate)?.completed === true,
      );
    const serverSentAt = Date.now();
    send(socket, {
      type: "network:probe-result",
      probeId,
      phase,
      sequence,
      total,
      ...(probeVersion === 2
        ? {
            probeVersion: 2,
            serverReceivedAt: now,
            serverSentAt,
            completed: probe.completed,
          }
        : {}),
      ...(resultPayload === undefined ? {} : { payload: resultPayload }),
    });
  }

  function leaveVoice(state, room) {
    if (!state.voiceActive) {
      return;
    }
    state.voiceActive = false;
    state.microphoneMuted = false;
    broadcastRoom(
      room,
      {
        type: "voice:left",
        participantId: state.id,
      },
      state.id,
    );
  }

  function stopBroadcast(room, broadcasterId, reason = "stopped") {
    if (room.broadcasterId !== broadcasterId) {
      return false;
    }
    const broadcaster = clients.get(broadcasterId)?.state;
    if (broadcaster) {
      broadcaster.broadcasting = false;
      broadcaster.sfuPublisherActive = false;
    }
    for (const memberId of room.members) {
      const member = clients.get(memberId)?.state;
      if (member) member.sfuViewerActive = false;
    }
    if (room.segmentSessionId) {
      segmentRelay.deactivateSession(
        room.code || broadcaster?.room || "",
        room.segmentSessionId,
      );
    }
    room.broadcasterId = undefined;
    room.broadcastCapabilities = undefined;
    room.segmentSessionId = undefined;
    broadcastRoom(room, {
      type: "broadcast:stopped",
      broadcasterId,
      reason,
    });
    broadcastNetworkAdvice(room);
    return true;
  }

  const httpServer = createServer(async (request, response) => {
    const method = String(request.method || "GET").toUpperCase();
    let pathname = "/";
    let requestUrl;
    try {
      requestUrl = new URL(request.url || "/", "http://localhost");
      pathname = requestUrl.pathname;
    } catch {
      response.writeHead(400, {
        connection: "close",
        "content-length": "0",
      });
      response.end();
      return;
    }
    const baseHeaders = {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    };
    try {
      if (await segmentRelay.handle(request, response, requestUrl)) return;
    } catch (error) {
      logger.error(
        `segment relay request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (!response.headersSent) {
        response.writeHead(500, {
          ...baseHeaders,
          "content-length": "0",
        });
        response.end();
      } else {
        response.destroy();
      }
      return;
    }
    if (!["GET", "HEAD"].includes(method)) {
      response.writeHead(405, {
        ...baseHeaders,
        allow: "GET, HEAD",
        "content-length": "0",
      });
      response.end();
      return;
    }
    const sendJson = (statusCode, payload) => {
      const body = JSON.stringify(payload);
      response.writeHead(statusCode, {
        ...baseHeaders,
        "content-length": Buffer.byteLength(body),
      });
      response.end(method === "HEAD" ? undefined : body);
    };
    if (pathname === "/health" || pathname === "/healthz") {
      sendJson(200, runtimeSnapshot());
      return;
    }
    if (pathname === "/readyz") {
      const acceptingConnections = clients.size < maxClients;
      const capabilities = serverCapabilities();
      sendJson(acceptingConnections ? 200 : 503, {
        ok: acceptingConnections,
        status: acceptingConnections ? "ready" : "saturated",
        protocolVersion: SIGNAL_PROTOCOL_VERSION,
        serverTime: Date.now(),
        limits: capabilities.limits,
        relayCapacityBps: null,
        relaySessionCapacityBps: null,
        relayCapacityEnforced: false,
        sfu: capabilities.sfu,
      });
      return;
    }
    if (pathname === "/capabilities") {
      sendJson(200, serverCapabilities());
      return;
    }
    if (pathname === "/iceservers") {
      const clientId = cleanText(
        requestUrl?.searchParams.get("clientId"),
        64,
      );
      const client = clients.get(clientId);
      const suppliedToken =
        String(request.headers.authorization || "").match(
          /^Bearer\s+(.+)$/iu,
        )?.[1] || "";
      const expectedToken = String(
        client?.state?.iceRefreshToken || "",
      );
      const expectedBytes = Buffer.from(expectedToken);
      const suppliedBytes = Buffer.from(suppliedToken);
      const tokenAccepted =
        expectedBytes.length >= 32 &&
        suppliedBytes.length === expectedBytes.length &&
        timingSafeEqual(expectedBytes, suppliedBytes);
      if (!client?.state?.room || !tokenAccepted) {
        response.writeHead(403, {
          ...baseHeaders,
          "content-length": "0",
        });
        response.end();
        return;
      }
      sendJson(
        200,
        iceConfigurationFor(client.state.room, client.state.id),
      );
      return;
    }
    if (pathname === "/metrics") {
      const directIp =
        normalizedIp(request.socket.remoteAddress) || "unknown";
      const loopback = ["127.0.0.1", "::1"].includes(directIp);
      const expectedToken = String(env.METRICS_TOKEN || "");
      const suppliedToken =
        String(request.headers.authorization || "").match(
          /^Bearer\s+(.+)$/iu,
        )?.[1] || "";
      const expectedTokenBytes = Buffer.from(expectedToken);
      const suppliedTokenBytes = Buffer.from(suppliedToken);
      const tokenAccepted =
        expectedTokenBytes.length >= 24 &&
        suppliedTokenBytes.length === expectedTokenBytes.length &&
        timingSafeEqual(
          suppliedTokenBytes,
          expectedTokenBytes,
        );
      if (!loopback && !tokenAccepted) {
        response.writeHead(403, {
          ...baseHeaders,
          "content-length": "0",
        });
        response.end();
        return;
      }
      const body = metricsText();
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "x-content-type-options": "nosniff",
      });
      response.end(method === "HEAD" ? undefined : body);
      return;
    }
    if (pathname === "/") {
      sendJson(200, {
        name: "synced-signal",
        status: "ready",
        websocket: "/signal",
        protocolVersion: SIGNAL_PROTOCOL_VERSION,
      });
      return;
    }
    response.writeHead(404, {
      ...baseHeaders,
      "content-length": "0",
    });
    response.end();
  });
  // Upload/download body liveness is enforced by the segment relay's
  // per-byte idle watchdog. A total request deadline would incorrectly abort
  // a healthy 96 MiB Range transfer on a slow mobile link.
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 6_000;
  httpServer.keepAliveTimeout = 5_000;

  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });
  const logTransportError = (scope, error) => {
    logger.error(
      `${scope}: ${String(
        error instanceof Error ? error.message : error || "unknown error",
      ).slice(0, 500)}`,
    );
  };
  httpServer.on("error", (error) => {
    logTransportError("signal HTTP server error", error);
  });
  httpServer.on("clientError", (error, socket) => {
    logTransportError("signal HTTP client error", error);
    rejectUpgrade(socket, 400, "Bad Request");
  });
  websocketServer.on("error", (error) => {
    logTransportError("signal WebSocket server error", error);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", (error) => {
      logTransportError("signal upgrade socket error", error);
      socket.destroy();
    });
    let pathname = "/";
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/signal") {
      metrics.rejectedUpgradesTotal += 1;
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    if (!originAllowed(origin, env)) {
      metrics.rejectedUpgradesTotal += 1;
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const ip = requestIp(request, env);
    const ipLimitKey = rateLimitKey(ip);
    if (
      activeClientCount() >= maxClients ||
      (clientsByIp.get(ipLimitKey) || 0) >= maxClientsPerIp
    ) {
      metrics.rejectedUpgradesTotal += 1;
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of networkProbeRoundsByIp) {
      const timestamps = (entry.timestamps || []).filter(
        (timestamp) => now - timestamp < 60_000,
      );
      if (!timestamps.length) {
        networkProbeRoundsByIp.delete(key);
      } else {
        entry.timestamps = timestamps;
      }
    }
    for (const { socket } of clients.values()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
    for (const client of clients.values()) {
      if (
        client.state.room &&
        now >= (client.state.nextIceRefreshAt || 0)
      ) {
        sendIceRefresh(client, now);
      }
    }
    for (const room of rooms.values()) {
      if (
        room.members.size > 0 &&
        now - (room.lastNetworkAdviceAt || 0) >=
          NETWORK_ADVICE_VALIDITY_MS
      ) {
        broadcastNetworkAdvice(room, now);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  websocketServer.on("connection", (socket, request) => {
    request.socket.setNoDelay(true);
    request.socket.setKeepAlive(true, 15_000);
    let clientId = randomUUID();
    const ip = requestIp(request, env);
    const ipLimitKey = rateLimitKey(ip);
    socket.isAlive = true;
    socket.syncedMetrics = metrics;
    socket.syncedMaxBufferedBytes = maxBufferedBytes;
    metrics.websocketConnectionsTotal += 1;
    const state = {
      id: clientId,
      role: undefined,
      room: undefined,
      nickname: "朋友",
      voiceActive: false,
      microphoneMuted: false,
      microphoneDisabled: false,
      broadcasting: false,
      sfuPublisherActive: false,
      sfuViewerActive: false,
      canBroadcast: false,
      protocol: "channel",
      resumeToken: undefined,
      iceRefreshToken: randomUUID(),
      nextIceRefreshAt: 0,
      lastIceRefreshAt: 0,
      ownerKey: undefined,
      embyCapabilities: undefined,
      networkReport: undefined,
      lastNetworkReportAt: 0,
      networkProbe: undefined,
      networkProbeRounds: 0,
      transportReports: new Map(),
      lastTransportReportAt: new Map(),
      ipLimitKey,
      superseded: false,
      disconnectTimer: undefined,
      disconnectFinalized: false,
      messages: 0,
      windowStartedAt: Date.now(),
      chatTimestamps: [],
    };
    clients.set(clientId, { socket, state, ip, ipLimitKey });
    clientsByIp.set(
      ipLimitKey,
      (clientsByIp.get(ipLimitKey) || 0) + 1,
    );
    send(socket, {
      type: "server:hello",
      ...signalCompatibility(),
      ...nodeIdentity,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      networkProbe: serverCapabilities().networkProbe,
    });
    const joinTimer = setTimeout(() => {
      if (!state.room && socket.readyState === WebSocket.OPEN) {
        socket.close(1008, "join timeout");
      }
    }, CLIENT_JOIN_TIMEOUT_MS);
    joinTimer.unref?.();
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("error", (error) => {
      logTransportError(`signal client ${clientId} error`, error);
      socket.terminate();
    });

    socket.on("message", (buffer) => {
      try {
        if (state.superseded) return;
      const now = Date.now();
      metrics.messagesReceivedTotal += 1;
      if (now - state.windowStartedAt >= 60_000) {
        state.windowStartedAt = now;
        state.messages = 0;
      }
      state.messages += 1;
      if (state.messages > maxMessagesPerMinute) {
        metrics.rateLimitedTotal += 1;
        send(socket, { type: "error", message: "消息过于频繁" });
        socket.close(1008, "rate limit");
        return;
      }

      let message;
      try {
        message = JSON.parse(buffer.toString());
      } catch {
        metrics.invalidMessagesTotal += 1;
        send(socket, { type: "error", message: "消息格式错误" });
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        metrics.invalidMessagesTotal += 1;
        send(socket, { type: "error", message: "消息格式错误" });
        return;
      }

      if (
        message.type === "server:capabilities" ||
        message.type === "capabilities:get"
      ) {
        send(socket, {
          type: "server:capabilities",
          ...serverCapabilities(),
        });
        return;
      }

      if (message.type === "network:probe") {
        handleNetworkProbe(socket, state, message, now);
        return;
      }

      if (message.type === "channel:join") {
        const roomCode = String(message.room || "").toUpperCase();
        if (state.room) {
          send(socket, {
            type: "error",
            code: "channel-already-joined",
            message: "已经加入其他频道",
          });
          return;
        }
        if (!ROOM_PATTERN.test(roomCode)) {
          send(socket, {
            type: "error",
            code: "channel-invalid",
            message: "频道码格式错误",
          });
          return;
        }
        const canBroadcast = message.canBroadcast === true;
        const resumeToken = cleanResumeToken(message.resumeToken);
        const ownerToken = cleanOwnerToken(message.ownerToken);
        const ownerKey = ownerKeyForToken(ownerToken);
        const ownsRequestedCode =
          Boolean(ownerToken) &&
          roomForOwnerToken(ownerToken) === roomCode;
        let room = rooms.get(roomCode);
        let created = false;
        if (!room) {
          if (
            !canBroadcast ||
            message.createIfMissing !== true ||
            !ownsRequestedCode ||
            !ownerKey
          ) {
            send(socket, {
              type: "error",
              code: "channel-offline",
              message: "频道暂时无人在线",
            });
            return;
          }
          room = {
            code: roomCode,
            ownerId: undefined,
            ownerKey,
            members: new Set(),
            broadcasterId: undefined,
            broadcastCapabilities: undefined,
            segmentSessionId: undefined,
            networkAdviceRevision: 0,
            networkAdviceByRecipient: new Map(),
            lastNetworkAdviceAt: 0,
            channelName: cleanText(
              message.channelName,
              24,
              `${cleanText(message.nickname, 16, "朋友")}的频道`,
            ),
          };
          rooms.set(roomCode, room);
          created = true;
        }
        if (
          room.ownerKey &&
          message.ownerToken !== undefined &&
          (!ownerKey ||
            ownerKey !== room.ownerKey ||
            !ownsRequestedCode)
        ) {
          // Never silently downgrade a client that presented an invalid
          // creator credential into a normal member. That would hide a
          // damaged local credential and make a credential-guessing probe
          // look like successful authentication to older clients.
          send(socket, {
            type: "error",
            code: "channel-owner-invalid",
            message: "频道主身份凭证无效",
          });
          return;
        }
        const resumeClient =
          room && resumeToken
            ? getRoomClientIds(room)
                .map((id) => clients.get(id))
                .find(
                  (client) =>
                    client?.state !== state &&
                    client?.state.resumeToken === resumeToken,
                )
            : undefined;
        const replacingExistingMember = Boolean(
          resumeClient && room.members.has(resumeClient.state.id),
        );
        if (
          room.members.size + (replacingExistingMember ? 0 : 1) >
          maxParticipantsPerRoom
        ) {
          send(socket, {
            type: "error",
            code: "channel-full",
            message: "频道人数已满",
          });
          return;
        }
        if (resumeClient) {
          const previous = resumeClient.state;
          if (
            previous.role === "host" &&
            room.ownerKey &&
            ownerKey !== room.ownerKey
          ) {
            send(socket, {
              type: "error",
              message: "频道主身份凭证无效",
            });
            return;
          }
          const temporaryId = clientId;
          previous.superseded = true;
          if (previous.disconnectTimer) {
            clearTimeout(previous.disconnectTimer);
            previous.disconnectTimer = undefined;
          }
          clients.delete(temporaryId);
          clientId = previous.id;
          state.id = clientId;
          state.role = previous.role;
          state.room = roomCode;
          state.nickname = cleanText(
            message.nickname,
            16,
            previous.nickname,
          );
          state.voiceActive = previous.voiceActive;
          state.microphoneMuted = previous.microphoneMuted;
          state.microphoneDisabled = previous.microphoneDisabled;
          state.broadcasting = previous.broadcasting;
          state.sfuPublisherActive =
            previous.sfuPublisherActive === true;
          state.sfuViewerActive = previous.sfuViewerActive === true;
          state.canBroadcast = canBroadcast || previous.canBroadcast;
          state.protocol = "channel";
          state.resumeToken = resumeToken;
          state.ownerKey = previous.ownerKey;
          state.embyCapabilities =
            cleanEmbyCapabilities(message.embyCapabilities) ||
            previous.embyCapabilities;
          state.networkReport = freshNetworkReport(previous)
            ? previous.networkReport
            : undefined;
          state.lastNetworkReportAt = previous.lastNetworkReportAt || 0;
          state.transportReports =
            previous.transportReports instanceof Map
              ? new Map(previous.transportReports)
              : new Map();
          state.lastTransportReportAt =
            previous.lastTransportReportAt instanceof Map
              ? new Map(previous.lastTransportReportAt)
              : new Map();
          state.disconnectTimer = undefined;
          state.disconnectFinalized = false;
          if (state.role === "host") {
            room.ownerId = clientId;
          }
          clients.set(clientId, {
            socket,
            state,
            ip,
            ipLimitKey,
          });
          metrics.resumedConnectionsTotal += 1;
          clearTimeout(joinTimer);
          resumeClient.socket.terminate();
          send(socket, {
            type: "channel:joined",
            ...signalCompatibility(),
            room: roomCode,
            clientId,
            created: false,
            resumed: true,
            channelName: room.channelName,
            broadcasterId: room.broadcasterId,
            broadcastCapabilities: room.broadcastCapabilities,
            participants: getRoomParticipants(room),
            segmentRelay: segmentRelayAccess(
              state,
              room.broadcasterId === clientId && state.broadcasting
                ? "publish"
                : "read",
            ),
            ...clientIceConfiguration(state),
          });
          broadcastRoom(
            room,
            {
              type: "participant:updated",
              participant: participantFor(state),
            },
            clientId,
          );
          broadcastNetworkAdvice(room);
          if (room.broadcasterId === clientId) {
            // A signaling socket can reconnect while the WebRTC media path is
            // still perfectly healthy. Re-announcing "broadcast:started"
            // made every viewer tear down that healthy P2P connection and
            // briefly show the buffering screen. Capabilities are enough to
            // refresh room state; clients whose ICE route truly changed will
            // renegotiate from their own connection-state monitor.
            broadcastRoom(
              room,
              {
                type: "broadcast:capabilities",
                broadcasterId: clientId,
                broadcastCapabilities: room.broadcastCapabilities,
                resumed: true,
              },
              clientId,
            );
          }
          return;
        }
        const authenticatedOwner =
          Boolean(room.ownerKey) &&
          Boolean(ownerKey) &&
          ownerKey === room.ownerKey;
        if (
          authenticatedOwner &&
          room.ownerId &&
          room.ownerId !== clientId
        ) {
          send(socket, { type: "error", message: "频道主已经在线" });
          return;
        }
        state.role = authenticatedOwner ? "host" : "viewer";
        if (authenticatedOwner) {
          room.ownerId = clientId;
        }
        state.room = roomCode;
        state.nickname = cleanText(message.nickname, 16, "朋友");
        state.canBroadcast = canBroadcast;
        state.protocol = "channel";
        state.resumeToken = resumeToken;
        state.ownerKey = authenticatedOwner ? ownerKey : undefined;
        state.embyCapabilities = cleanEmbyCapabilities(
          message.embyCapabilities,
        );
        room.members.add(clientId);
        clearTimeout(joinTimer);
        send(socket, {
          type: "channel:joined",
          ...signalCompatibility(),
          room: roomCode,
          clientId,
          created,
          channelName: room.channelName,
          broadcasterId: room.broadcasterId,
          broadcastCapabilities: room.broadcastCapabilities,
          participants: getRoomParticipants(room),
          segmentRelay: segmentRelayAccess(
            state,
            room.broadcasterId === clientId && state.broadcasting
              ? "publish"
              : "read",
          ),
          ...clientIceConfiguration(state),
        });
        broadcastRoom(
          room,
          {
            type: "participant:joined",
            participant: participantFor(state),
          },
          clientId,
        );
        broadcastNetworkAdvice(room);
        return;
      }

      if (message.type === "host:create") {
        if (!allowLegacyProtocol) {
          send(socket, {
            type: "error",
            message: "客户端版本过旧，请升级后重新进入频道",
          });
          return;
        }
        const roomCode = String(message.room || "").toUpperCase();
        if (state.room) {
          send(socket, { type: "error", message: "已经加入其他频道" });
          return;
        }
        if (!ROOM_PATTERN.test(roomCode)) {
          send(socket, { type: "error", message: "频道码格式错误" });
          return;
        }
        if (rooms.has(roomCode)) {
          send(socket, { type: "error", message: "该频道已在线，请直接进入或更换频道码" });
          return;
        }
        state.role = "host";
        state.room = roomCode;
        state.nickname = cleanText(message.nickname, 16, "放映者");
        state.canBroadcast = true;
        state.broadcasting = true;
        state.protocol = "legacy-host";
        clearTimeout(joinTimer);
        const room = {
          code: roomCode,
          ownerId: clientId,
          ownerKey: undefined,
          members: new Set([clientId]),
          broadcasterId: clientId,
          broadcastCapabilities: undefined,
          segmentSessionId: undefined,
          networkAdviceRevision: 0,
          networkAdviceByRecipient: new Map(),
          lastNetworkAdviceAt: 0,
          channelName: cleanText(message.channelName, 24, `${state.nickname}的频道`),
        };
        rooms.set(roomCode, room);
        send(socket, {
          type: "room:created",
          room: roomCode,
          clientId,
          channelName: room.channelName,
          broadcasterId: room.broadcasterId,
          broadcastCapabilities: room.broadcastCapabilities,
          participants: getRoomParticipants(room),
          ...clientIceConfiguration(state),
        });
        broadcastNetworkAdvice(room);
        return;
      }

      if (message.type === "viewer:join") {
        if (!allowLegacyProtocol) {
          send(socket, {
            type: "error",
            message: "客户端版本过旧，请升级后重新进入频道",
          });
          return;
        }
        const roomCode = String(message.room || "").toUpperCase();
        if (state.room) {
          send(socket, { type: "error", message: "已经加入其他频道" });
          return;
        }
        const room = rooms.get(roomCode);
        if (!room) {
          send(socket, { type: "error", message: "频道暂未开播" });
          return;
        }
        if (room.members.size >= maxParticipantsPerRoom) {
          send(socket, { type: "error", message: "频道人数已满" });
          return;
        }
        state.role = "viewer";
        state.room = roomCode;
        state.nickname = cleanText(message.nickname, 16, "朋友");
        state.canBroadcast = false;
        state.protocol = "legacy-viewer";
        room.members.add(clientId);
        clearTimeout(joinTimer);
        send(socket, {
          type: "room:joined",
          room: roomCode,
          clientId,
          channelName: room.channelName,
          broadcasterId: room.broadcasterId,
          broadcastCapabilities: room.broadcastCapabilities,
          participants: getRoomParticipants(room),
          ...clientIceConfiguration(state),
        });
        const broadcaster = room.broadcasterId
          ? clients.get(room.broadcasterId)
          : undefined;
        if (broadcaster) {
          send(broadcaster.socket, {
            type: "viewer:joined",
            viewerId: clientId,
            participant: participantFor(state),
          });
        }
        broadcastRoom(
          room,
          {
            type: "participant:joined",
            participant: participantFor(state),
          },
          clientId,
        );
        broadcastNetworkAdvice(room);
        return;
      }

      if (message.type === "ice:refresh") {
        if (!state.room || !state.role) {
          send(socket, {
            type: "error",
            code: "ice-refresh-not-joined",
            message: "请先加入频道再刷新网络凭证",
          });
          return;
        }
        // Avoid letting a compromised renderer turn credential signing into
        // an unbounded hot loop. Automatic refresh remains scheduled well
        // ahead of expiry; an explicit request is intended for network swaps.
        if (now - state.lastIceRefreshAt < 30_000) return;
        sendIceRefresh(clients.get(clientId), now);
        return;
      }

      if (message.type === "sfu:status") {
        if (!state.room || !state.role) {
          send(socket, {
            type: "error",
            code: "sfu-status-not-joined",
            message: "请先加入频道再上报 SFU 状态",
          });
          return;
        }
        const room = rooms.get(state.room);
        const active = message.active === true;
        if (
          !room ||
          !["publisher", "viewer"].includes(message.sfuRole) ||
          (active &&
            message.sfuRole === "publisher" &&
            room.broadcasterId !== state.id) ||
          (active &&
            message.sfuRole === "viewer" &&
            room.broadcasterId === state.id)
        ) {
          send(socket, {
            type: "error",
            code: "sfu-status-invalid",
            message: "SFU 状态与当前放映角色不一致",
          });
          return;
        }
        const property =
          message.sfuRole === "publisher"
            ? "sfuPublisherActive"
            : "sfuViewerActive";
        if (state[property] !== active) {
          state[property] = active;
          broadcastNetworkAdvice(room, now);
        }
        return;
      }

      if (message.type === "network:report") {
        if (!state.room || !state.role) {
          send(socket, {
            type: "error",
            code: "network-report-not-joined",
            message: "请先加入频道再上报网络状态",
          });
          return;
        }
        if (
          ["target", "url", "host", "hostname", "ip", "address"].some(
            (field) => Object.hasOwn(message, field),
          )
        ) {
          send(socket, {
            type: "error",
            code: "network-report-invalid",
            message: "网络状态参数无效",
          });
          return;
        }
        const networkReport = cleanNetworkReport(
          message.networkReport,
          now,
        );
        if (!networkReport) {
          send(socket, {
            type: "error",
            code: "network-report-invalid",
            message: "网络状态参数无效",
          });
          return;
        }
        if (
          now - state.lastNetworkReportAt <
          NETWORK_REPORT_MIN_INTERVAL_MS
        ) {
          send(socket, {
            type: "error",
            code: "network-report-rate-limit",
            message: "网络状态上报过于频繁",
          });
          return;
        }
        const room = rooms.get(state.room);
        if (!room) {
          send(socket, {
            type: "error",
            code: "network-report-room-ended",
            message: "频道已经结束",
          });
          return;
        }
        state.networkReport = networkReport;
        state.lastNetworkReportAt = now;
        metrics.networkReportsTotal += 1;
        if (networkReport.probeVersion === 2) {
          send(socket, {
            type: "network:report-accepted",
            sampleId: networkReport.sampleId,
            serverTime: now,
            nextReportAfterMs: NETWORK_REPORT_MIN_INTERVAL_MS,
          });
        }
        broadcastNetworkAdvice(room);
        return;
      }

      if (message.type === "network:transport-report") {
        if (!state.room || !state.role) {
          send(socket, {
            type: "error",
            code: "network-transport-not-joined",
            message: "请先加入频道再上报传输状态",
          });
          return;
        }
        const report = cleanTransportReport(
          message.transportReport,
          now,
        );
        if (!report) {
          metrics.invalidMessagesTotal += 1;
          send(socket, {
            type: "error",
            code: "network-transport-invalid",
            message: "传输状态参数无效",
          });
          return;
        }
        const throttleKey = `${report.mediaKind}:${report.direction}`;
        const lastReportedAt =
          state.lastTransportReportAt.get(throttleKey) || 0;
        if (now - lastReportedAt < TRANSPORT_REPORT_MIN_INTERVAL_MS) {
          metrics.rateLimitedTotal += 1;
          send(socket, {
            type: "error",
            code: "network-transport-rate-limit",
            message: "传输状态上报过于频繁",
          });
          return;
        }
        const room = rooms.get(state.room);
        if (!room) {
          send(socket, {
            type: "error",
            code: "network-transport-room-ended",
            message: "频道已经结束",
          });
          return;
        }
        for (const [key, candidate] of state.transportReports) {
          if (now - candidate.receivedAt > TRANSPORT_REPORT_TTL_MS) {
            state.transportReports.delete(key);
          }
        }
        while (state.transportReports.size >= 8) {
          state.transportReports.delete(
            state.transportReports.keys().next().value,
          );
        }
        state.transportReports.set(
          `${throttleKey}:${report.sessionId}`,
          report,
        );
        state.lastTransportReportAt.set(throttleKey, now);
        metrics.transportReportsTotal += 1;
        send(socket, {
          type: "network:transport-accepted",
          sampleId: report.sampleId,
          serverTime: now,
          nextReportAfterMs: TRANSPORT_REPORT_MIN_INTERVAL_MS,
        });
        broadcastNetworkAdvice(room, now);
        return;
      }

      if (message.type === "participant:rename") {
        if (!state.room || !state.role) {
          send(socket, { type: "error", message: "请先加入频道" });
          return;
        }
        const room = rooms.get(state.room);
        if (!room) {
          send(socket, { type: "error", message: "频道已经结束" });
          return;
        }
        const nextNickname = cleanText(message.nickname, 16);
        if (!nextNickname) {
          send(socket, { type: "error", message: "昵称不能为空" });
          return;
        }
        if (nextNickname === state.nickname) return;
        state.nickname = nextNickname;
        broadcastRoom(room, {
          type: "participant:updated",
          participant: participantFor(state),
        });
        return;
      }

      if (message.type === "broadcast:start") {
        if (!state.room || !state.canBroadcast) {
          send(socket, { type: "error", message: "当前设备不能发起放映" });
          return;
        }
        const room = rooms.get(state.room);
        if (!room) {
          send(socket, { type: "error", message: "频道已经结束" });
          return;
        }
        if (room.broadcasterId && room.broadcasterId !== clientId) {
          const current = clients.get(room.broadcasterId)?.state;
          send(socket, {
            type: "error",
            code: "broadcast-busy",
            message: `${current?.nickname || "其他成员"}正在放映`,
          });
          return;
        }
        const broadcastCapabilities = cleanBroadcastCapabilities(
          message.broadcastCapabilities,
        );
        if (
          message.broadcastCapabilities !== undefined &&
          !broadcastCapabilities
        ) {
          send(socket, {
            type: "error",
            message: "放映画质能力参数无效",
          });
          return;
        }
        if (
          room.broadcasterId === clientId &&
          state.broadcasting &&
          broadcastMode(room.broadcastCapabilities) !==
            broadcastMode(broadcastCapabilities)
        ) {
          send(socket, {
            type: "error",
            code: "broadcast-mode-change",
            message: "切换放映模式前请先停止当前放映",
          });
          return;
        }
        room.broadcasterId = clientId;
        room.broadcastCapabilities = broadcastCapabilities;
        const requestedSegmentSessionId = cleanText(
          message.sessionId,
          128,
        ).toLowerCase();
        const nextSegmentSessionId =
          broadcastMode(broadcastCapabilities) === "emby" &&
          /^[a-z0-9-]{8,128}$/i.test(requestedSegmentSessionId)
            ? requestedSegmentSessionId
            : undefined;
        if (
          room.segmentSessionId &&
          room.segmentSessionId !== nextSegmentSessionId
        ) {
          segmentRelay.deactivateSession(
            state.room,
            room.segmentSessionId,
          );
        }
        room.segmentSessionId = nextSegmentSessionId;
        if (nextSegmentSessionId) {
          segmentRelay.activateSession(state.room, nextSegmentSessionId);
        }
        state.broadcasting = true;
        state.sfuPublisherActive = false;
        for (const memberId of room.members) {
          const member = clients.get(memberId)?.state;
          if (member && member.id !== clientId) {
            member.sfuViewerActive = false;
          }
        }
        send(socket, {
          type: "broadcast:granted",
          broadcasterId: clientId,
          broadcastCapabilities,
          segmentRelay: segmentRelayAccess(state, "publish"),
          // Channel-protocol viewers explicitly announce when their RTCPeerConnection
          // is ready. Keeping eager offers only for legacy viewers avoids overlapping
          // SDP negotiations during join/start races.
          viewerIds: getRoomClientIds(room).filter(
            (id) =>
              id !== clientId &&
              clients.get(id)?.state.protocol === "legacy-viewer",
          ),
        });
        broadcastRoom(
          room,
          {
            type: "broadcast:started",
            broadcasterId: clientId,
            nickname: state.nickname,
            broadcastCapabilities,
            sessionId: nextSegmentSessionId,
          },
          clientId,
        );
        broadcastNetworkAdvice(room);
        return;
      }

      if (message.type === "segment:token-refresh") {
        if (!state.room || !state.role) return;
        const activeRoom = rooms.get(state.room);
        if (!activeRoom?.members.has(clientId)) return;
        const scope =
          activeRoom.broadcasterId === clientId && state.broadcasting
            ? "publish"
            : "read";
        send(socket, {
          type: "segment:token",
          segmentRelay: segmentRelayAccess(state, scope),
        });
        return;
      }

      if (message.type === "broadcast:stop") {
        if (!state.room) {
          return;
        }
        const room = rooms.get(state.room);
        if (room) {
          stopBroadcast(room, clientId);
        }
        return;
      }

      if (message.type === "broadcast:capabilities") {
        if (!state.room) return;
        const room = rooms.get(state.room);
        if (!room || room.broadcasterId !== clientId) return;
        const broadcastCapabilities = cleanBroadcastCapabilities(
          message.broadcastCapabilities,
        );
        if (!broadcastCapabilities) {
          send(socket, {
            type: "error",
            message: "放映画质能力参数无效",
          });
          return;
        }
        if (
          broadcastMode(room.broadcastCapabilities) !==
          broadcastMode(broadcastCapabilities)
        ) {
          send(socket, {
            type: "error",
            code: "broadcast-mode-change",
            message: "切换放映模式前请先停止当前放映",
          });
          return;
        }
        room.broadcastCapabilities = broadcastCapabilities;
        broadcastRoom(
          room,
          {
            type: "broadcast:capabilities",
            broadcasterId: clientId,
            broadcastCapabilities,
          },
          clientId,
        );
        return;
      }

      if (message.type === "broadcast:watch-ready") {
        if (!state.room) {
          return;
        }
        const room = rooms.get(state.room);
        if (
          !room?.broadcasterId ||
          room.broadcasterId === clientId
        ) {
          return;
        }
        const broadcaster = clients.get(room.broadcasterId);
        if (broadcaster) {
          const codecs = Array.isArray(message.codecs)
            ? message.codecs
                .map((codec) => cleanText(codec, 16))
                .filter((codec) => /^video\/(H264|VP8|VP9|AV1)$/i.test(codec))
                .slice(0, 8)
            : [];
          const attempt = Math.min(
            5,
            Math.max(1, Number(message.attempt) || 1),
          );
          const sessionId = cleanText(message.sessionId, 64);
          const embyCapabilities = cleanEmbyCapabilities(
            message.embyCapabilities,
          );
          send(broadcaster.socket, {
            type: "viewer:joined",
            viewerId: clientId,
            participant: participantFor(state),
            codecs,
            embyCapabilities,
            attempt,
            sessionId: /^[a-z0-9-]{8,64}$/i.test(sessionId)
              ? sessionId
              : undefined,
          });
        }
        return;
      }

      if (message.type === "media:ready") {
        if (!state.room) {
          return;
        }
        const room = rooms.get(state.room);
        if (!room?.broadcasterId || room.broadcasterId === clientId) {
          return;
        }
        const broadcaster = clients.get(room.broadcasterId);
        if (broadcaster) {
          const sessionId = cleanText(message.sessionId, 64);
          send(broadcaster.socket, {
            type: "media:ready",
            viewerId: clientId,
            sessionId: /^[a-z0-9-]{8,64}$/i.test(sessionId)
              ? sessionId
              : undefined,
          });
        }
        return;
      }

      if (message.type === "media:audio-missing") {
        if (!state.room) {
          return;
        }
        const room = rooms.get(state.room);
        if (!room?.broadcasterId || room.broadcasterId === clientId) {
          return;
        }
        const broadcaster = clients.get(room.broadcasterId);
        if (broadcaster) {
          const sessionId = cleanText(message.sessionId, 64);
          send(broadcaster.socket, {
            type: "media:audio-missing",
            viewerId: clientId,
            sessionId: /^[a-z0-9-]{8,64}$/i.test(sessionId)
              ? sessionId
              : undefined,
          });
        }
        return;
      }

      if (message.type === "media:codec-failed") {
        if (!state.room) {
          return;
        }
        const room = rooms.get(state.room);
        if (!room?.broadcasterId || room.broadcasterId === clientId) {
          return;
        }
        const broadcaster = clients.get(room.broadcasterId);
        const sessionId = cleanText(message.sessionId, 64);
        const attempt = Number(message.attempt);
        const codec = cleanVideoCodec(message.codec);
        if (
          !broadcaster ||
          !/^[a-z0-9-]{8,64}$/i.test(sessionId) ||
          !Number.isInteger(attempt) ||
          attempt < 1 ||
          attempt > 5 ||
          !codec
        ) {
          return;
        }
        send(broadcaster.socket, {
          type: "media:codec-failed",
          viewerId: clientId,
          attempt,
          sessionId,
          codec,
        });
        return;
      }

      if (message.type === "media:ice-restart") {
        if (!state.room) {
          return;
        }
        const room = rooms.get(state.room);
        if (!room?.broadcasterId || room.broadcasterId === clientId) {
          return;
        }
        const broadcaster = clients.get(room.broadcasterId);
        if (broadcaster) {
          const sessionId = cleanText(message.sessionId, 64);
          send(broadcaster.socket, {
            type: "media:ice-restart",
            viewerId: clientId,
            attempt:
              Number.isInteger(Number(message.attempt)) &&
              Number(message.attempt) >= 1 &&
              Number(message.attempt) <= 5
                ? Number(message.attempt)
                : undefined,
            sessionId: /^[a-z0-9-]{8,64}$/i.test(sessionId)
              ? sessionId
              : undefined,
          });
        }
        return;
      }

      if (message.type === "signal") {
        const signalData = cleanSignalData(message.data);
        if (!state.room || !state.role) {
          send(socket, { type: "error", message: "尚未加入频道" });
          return;
        }
        if (!signalData) {
          send(socket, { type: "error", message: "媒体协商数据无效" });
          return;
        }
        const room = rooms.get(state.room);
        if (!room) {
          send(socket, { type: "error", message: "频道已经结束" });
          return;
        }
        const targetId =
          (message.target === "host" || message.target === "broadcaster") &&
          room.broadcasterId &&
          state.id !== room.broadcasterId
            ? room.broadcasterId
            : state.id === room.broadcasterId &&
                room.members.has(message.target)
              ? message.target
              : undefined;
        const target = targetId ? clients.get(targetId) : undefined;
        if (!target) {
          send(socket, { type: "error", message: "目标用户不存在" });
          return;
        }
        send(target.socket, {
          type: "signal",
          from: clientId,
          data: signalData,
          attempt:
            Number.isInteger(Number(message.attempt)) &&
            Number(message.attempt) >= 1 &&
            Number(message.attempt) <= 5
              ? Number(message.attempt)
              : undefined,
          sessionId: /^[a-z0-9-]{8,64}$/i.test(
            cleanText(message.sessionId, 64),
          )
            ? cleanText(message.sessionId, 64)
            : undefined,
        });
        metrics.mediaSignalsRelayedTotal += 1;
        return;
      }

      if (message.type === "quality:request") {
        if (!state.room || !state.role) {
          send(socket, { type: "error", message: "只有观看者可以设置观看画质" });
          return;
        }
        const room = rooms.get(state.room);
        const broadcaster =
          room?.broadcasterId ? clients.get(room.broadcasterId) : undefined;
        if (!room || !broadcaster) {
          send(socket, { type: "error", message: "频道当前无人放映" });
          return;
        }
        const requestedHeight =
          message.height === undefined ? undefined : Number(message.height);
        const requestedFrameRate =
          message.frameRate === undefined ? undefined : Number(message.frameRate);
        const availableDownloadBps =
          message.availableDownloadBps === undefined
            ? undefined
            : Number(message.availableDownloadBps);
        if (
          (requestedHeight !== undefined &&
            ![480, 720, 1080, 1200, 1440, 2160].includes(
              requestedHeight,
            )) ||
          (requestedFrameRate !== undefined &&
            ![24, 30, 60, 90, 120].includes(requestedFrameRate)) ||
          (availableDownloadBps !== undefined &&
            (!Number.isFinite(availableDownloadBps) ||
              availableDownloadBps < 0 ||
              availableDownloadBps > 1_000_000_000))
        ) {
          send(socket, { type: "error", message: "观看画质参数无效" });
          return;
        }
        send(broadcaster.socket, {
          type: "quality:request",
          viewerId: clientId,
          height: requestedHeight,
          frameRate: requestedFrameRate,
          originalDemand: message.originalDemand === true,
          lowDemand: message.lowDemand === true,
          availableDownloadBps,
        });
        return;
      }

      if (message.type === "voice:music") {
        if (!state.room || !state.role) {
          send(socket, { type: "error", message: "请先加入频道" });
          return;
        }
        const room = rooms.get(state.room);
        if (!room) {
          send(socket, { type: "error", message: "频道已经结束" });
          return;
        }
        const active = message.active === true;
        if (active && !state.voiceActive) {
          send(socket, {
            type: "error",
            message: "请先加入连麦，再共享伴奏",
          });
          return;
        }
        broadcastRoom(
          room,
          {
            type: "voice:music",
            active,
            senderId: clientId,
            nickname: state.nickname,
          },
          clientId,
        );
        return;
      }

      if (message.type === "voice:join") {
        if (!state.room || !state.role) {
          send(socket, { type: "error", message: "请先加入频道" });
          return;
        }
        const room = rooms.get(state.room);
        if (!room) {
          send(socket, { type: "error", message: "频道已经结束" });
          return;
        }
        const wasVoiceActive = state.voiceActive;
        state.voiceActive = true;
        if (!wasVoiceActive) {
          state.microphoneMuted = Boolean(state.microphoneDisabled);
        }
        const voicePeers = getRoomParticipants(room).filter(
          (participant) => participant.id !== clientId && participant.voiceActive,
        );
        send(socket, {
          type: "voice:ready",
          participants: voicePeers,
          ...clientIceConfiguration(state),
          voicePolicy: voicePolicyFor(state, now),
          serverTime: now,
        });
        if (!wasVoiceActive) {
          broadcastRoom(
            room,
            {
              type: "voice:joined",
              participant: participantFor(state),
            },
            clientId,
          );
        }
        return;
      }

      if (message.type === "voice:sync") {
        if (!state.room || !state.voiceActive) {
          return;
        }
        const room = rooms.get(state.room);
        if (!room) {
          return;
        }
        send(socket, {
          type: "voice:peers",
          participants: getRoomParticipants(room).filter(
            (participant) =>
              participant.id !== clientId && participant.voiceActive,
          ),
          voicePolicy: voicePolicyFor(state, now),
          serverTime: now,
        });
        return;
      }

      if (message.type === "voice:mute") {
        if (!state.room || !state.voiceActive) {
          return;
        }
        const room = rooms.get(state.room);
        if (!room) {
          return;
        }
        const requestedMuted = message.muted === true;
        state.microphoneMuted =
          state.microphoneDisabled || requestedMuted;
        broadcastRoom(room, {
          type: "participant:updated",
          participant: participantFor(state),
        });
        return;
      }

      if (message.type === "voice:leave") {
        if (!state.room) {
          return;
        }
        const room = rooms.get(state.room);
        if (room) {
          leaveVoice(state, room);
        }
        return;
      }

      if (message.type === "voice:signal") {
        const signalData = cleanSignalData(message.data);
        if (
          !state.room ||
          !state.voiceActive ||
          !message.target
        ) {
          send(socket, { type: "error", message: "尚未加入连麦" });
          return;
        }
        if (!signalData) {
          send(socket, { type: "error", message: "连麦协商数据无效" });
          return;
        }
        const room = rooms.get(state.room);
        const target = clients.get(message.target);
        if (
          !room ||
          !target ||
          target.state.room !== state.room ||
          !target.state.voiceActive
        ) {
          send(socket, { type: "error", message: "连麦用户已经离开" });
          return;
        }
        send(target.socket, {
          type: "voice:signal",
          from: clientId,
          data: signalData,
          iceMode:
            message.iceMode === "relay"
              ? "relay"
              : message.iceMode === "all"
                ? "all"
                : undefined,
          sessionId: /^[a-z0-9-]{8,64}$/i.test(
            cleanText(message.sessionId, 64),
          )
            ? cleanText(message.sessionId, 64)
            : undefined,
        });
        metrics.voiceSignalsRelayedTotal += 1;
        return;
      }

      if (
        message.type === "moderation:microphone" ||
        message.type === "moderation:stop-broadcast" ||
        message.type === "moderation:kick"
      ) {
        if (!state.room || !state.role) {
          send(socket, { type: "error", message: "请先加入频道" });
          return;
        }
        const room = rooms.get(state.room);
        const authenticatedOwner = Boolean(
          room?.ownerKey &&
            state.ownerKey &&
            state.ownerKey === room.ownerKey,
        );
        const legacyOwner = Boolean(
          room && !room.ownerKey && room.ownerId === clientId,
        );
        if (!room || (!authenticatedOwner && !legacyOwner)) {
          send(socket, {
            type: "error",
            message: "只有频道主可以管理成员",
          });
          return;
        }
        const targetId = String(message.target || "");
        const target = clients.get(targetId);
        if (
          !target ||
          target.state.room !== state.room ||
          !room.members.has(targetId)
        ) {
          send(socket, { type: "error", message: "该成员已经离开频道" });
          return;
        }
        if (targetId === clientId) {
          send(socket, {
            type: "error",
            message: "频道主不能对自己执行此操作",
          });
          return;
        }

        if (message.type === "moderation:microphone") {
          const disabled = message.disabled === true;
          target.state.microphoneDisabled = disabled;
          if (disabled) {
            target.state.microphoneMuted = true;
          }
          send(target.socket, {
            type: "moderation:microphone",
            target: targetId,
            disabled,
            from: clientId,
          });
          broadcastRoom(room, {
            type: "participant:updated",
            participant: participantFor(target.state),
          });
          return;
        }

        if (message.type === "moderation:stop-broadcast") {
          if (!stopBroadcast(room, targetId, "moderated")) {
            send(socket, {
              type: "error",
              message: "该成员当前没有放映",
            });
          }
          return;
        }

        target.state.resumeToken = undefined;
        send(target.socket, {
          type: "moderation:kicked",
          from: clientId,
          message: "你已被频道主移出频道",
        });
        try {
          target.socket.close(4003, "kicked by host");
        } catch {
          target.socket.terminate();
        }
        return;
      }

      if (message.type === "chat:send") {
        if (!state.room || !state.role) {
          send(socket, { type: "error", message: "请先加入频道" });
          return;
        }
        const room = rooms.get(state.room);
        if (!room) {
          send(socket, { type: "error", message: "频道已经结束" });
          return;
        }
        state.chatTimestamps = state.chatTimestamps.filter((timestamp) => now - timestamp < 10_000);
        if (state.chatTimestamps.length >= MAX_CHAT_MESSAGES_PER_10_SECONDS) {
          send(socket, {
            type: "error",
            code: "chat-rate-limit",
            message: "弹幕发送得太快了",
          });
          return;
        }
        const text = cleanText(message.text, 120);
        if (!text) {
          send(socket, {
            type: "error",
            code: "chat-invalid",
            message: "弹幕不能为空",
          });
          return;
        }
        state.chatTimestamps.push(now);
        broadcastRoom(room, {
          type: "chat:message",
          messageId: randomUUID(),
          senderId: clientId,
          nickname: state.nickname,
          text,
          sentAt: now,
        });
        return;
      }

      if (message.type === "ping") {
        send(socket, { type: "pong" });
        return;
      }
        send(socket, {
          type: "error",
          code: "unsupported-operation",
          requestedType: cleanText(message.type, 80, ""),
          message: "不支持的操作",
        });
        metrics.invalidMessagesTotal += 1;
      } catch (error) {
        logTransportError("signal message handler failed", error);
        send(socket, {
          type: "error",
          message: "服务器处理消息时出现异常，请重新连接",
        });
        socket.close(1011, "message handler failed");
      }
    });

    socket.on("close", (code) => {
      clearTimeout(joinTimer);
      clientsByIp.set(
        ipLimitKey,
        Math.max(0, (clientsByIp.get(ipLimitKey) || 1) - 1),
      );
      if (clientsByIp.get(ipLimitKey) === 0) {
        clientsByIp.delete(ipLimitKey);
      }
      if (state.superseded) {
        return;
      }
      if (!state.room || !state.role) {
        clients.delete(clientId);
        return;
      }
      const canResume =
        state.protocol === "channel" &&
        Boolean(state.resumeToken) &&
        code !== 1000 &&
        code !== 1005 &&
        !state.disconnectFinalized;
      if (canResume) {
        if (state.disconnectTimer) {
          clearTimeout(state.disconnectTimer);
        }
        state.disconnectTimer = setTimeout(() => {
          state.disconnectTimer = undefined;
          metrics.disconnectGraceExpiredTotal += 1;
          finalizeClientDeparture(clientId, state);
        }, disconnectGraceMs);
        state.disconnectTimer.unref?.();
        return;
      }
      finalizeClientDeparture(clientId, state);
    });
  });

  return {
    httpServer,
    rooms,
    clients,
    capabilities: serverCapabilities,
    snapshot: runtimeSnapshot,
    metrics: () => ({ ...metrics }),
    listen(port = 8787, host = "0.0.0.0") {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve(httpServer.address());
        });
      });
    },
    close() {
      clearInterval(heartbeatTimer);
      for (const room of rooms.values()) {
        clearNetworkAdviceTimer(room);
      }
      for (const client of clients.values()) {
        if (client.state.disconnectTimer) {
          clearTimeout(client.state.disconnectTimer);
          client.state.disconnectTimer = undefined;
        }
        client.socket.terminate();
      }
      return Promise.all([
        new Promise((resolve) => httpServer.close(resolve)),
        segmentRelay.close(),
      ]).then(() => undefined);
    },
  };
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  const server = createSignalServer();
  await server.listen(port, host);
  console.log(`synced-signal listening on ${host}:${port}`);
}
