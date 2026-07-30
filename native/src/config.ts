import { QUALITY_BITRATE_BPS } from "./quality-table";

export type ResolutionKey =
  | "original"
  | "ultra"
  | "high"
  | "standard"
  | "smooth";
export type FrameRateOption = 24 | 30 | 60 | 90 | 120;

export interface QualityPreset {
  key: `${ResolutionKey}-${FrameRateOption}`;
  label: string;
  detail: string;
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
  audioBitrate: number;
  codecOrder: string[];
}

export interface ResolutionOption {
  key: ResolutionKey;
  label: string;
  description: string;
  width: number;
  height: number;
}

export const RESOLUTION_OPTIONS: ResolutionOption[] = [
  {
    key: "original",
    label: "4K 原画",
    description: "最高 3840×2160",
    width: 3840,
    height: 2160,
  },
  {
    key: "ultra",
    label: "2K",
    description: "最高 2560×1440",
    width: 2560,
    height: 1440,
  },
  {
    key: "high",
    label: "高清",
    description: "最高 1920×1080",
    width: 1920,
    height: 1080,
  },
  {
    key: "standard",
    label: "标清",
    description: "最高 1280×720",
    width: 1280,
    height: 720,
  },
  {
    key: "smooth",
    label: "流畅",
    description: "最高 854×480",
    width: 854,
    height: 480,
  },
];

export const FRAME_RATE_OPTIONS: FrameRateOption[] = [24, 30, 60, 90, 120];

export function isResolutionKey(value: string | null): value is ResolutionKey {
  return RESOLUTION_OPTIONS.some((option) => option.key === value);
}

export function isFrameRateOption(
  value: number,
): value is FrameRateOption {
  return FRAME_RATE_OPTIONS.includes(value as FrameRateOption);
}

export function buildQualityPreset(
  resolutionKey: ResolutionKey,
  frameRate: FrameRateOption,
): QualityPreset {
  const resolution =
    RESOLUTION_OPTIONS.find((option) => option.key === resolutionKey) ||
    RESOLUTION_OPTIONS[0];
  const maxBitrate = QUALITY_BITRATE_BPS[resolution.key][frameRate];
  return {
    key: `${resolution.key}-${frameRate}`,
    label: `${resolution.label} · ${frameRate} 帧`,
    detail: `${resolution.label} · ${frameRate} 帧 · 最高 ${Math.round(maxBitrate / 1_000_000)} Mbps`,
    width: resolution.width,
    height: resolution.height,
    frameRate,
    maxBitrate,
    audioBitrate:
      resolution.key === "original"
        ? 256_000
        : resolution.key === "ultra"
          ? 256_000
        : resolution.key === "high"
          ? 224_000
          : 192_000,
    // A watch party values stable frame delivery more than codec efficiency
    // on paper. Windows and Android overwhelmingly provide hardware H.264
    // encode/decode, whereas VP9 encoding is still software-only on many
    // systems and can become CPU-limited as soon as a second viewer joins.
    // Keep VP9/AV1 as efficiency fallbacks after the hardware-first path.
    codecOrder: ["video/H264", "video/VP9", "video/AV1", "video/VP8"],
  };
}

export interface RecommendedPreset {
  resolution: ResolutionKey;
  reason: string;
}

export function recommendBroadcastPreset(
  availableOutgoingBitrate?: number,
): RecommendedPreset {
  // navigator.connection describes the device's access network, not the
  // selected ICE path to this particular peer. It is also coarsened on many
  // Electron/WebView builds. Only make a path-specific recommendation after
  // WebRTC exposes the selected candidate pair's live bandwidth estimate.
  if (
    availableOutgoingBitrate === undefined ||
    !Number.isFinite(availableOutgoingBitrate) ||
    availableOutgoingBitrate <= 0
  ) {
    return {
      resolution: "high",
      reason: "连接朋友后将按 P2P 实测上行推荐",
    };
  }
  if (availableOutgoingBitrate < 3_500_000) {
    return {
      resolution: "smooth",
      reason: "P2P 实测上行适合流畅画质",
    };
  }
  if (availableOutgoingBitrate < 7_500_000) {
    return {
      resolution: "standard",
      reason: "P2P 实测上行适合 720p",
    };
  }
  if (availableOutgoingBitrate < 14_000_000) {
    return {
      resolution: "high",
      reason: "P2P 实测上行适合 1080p",
    };
  }
  if (availableOutgoingBitrate < 24_000_000) {
    return {
      resolution: "ultra",
      reason: "P2P 实测上行适合 2K",
    };
  }
  if (availableOutgoingBitrate < 28_000_000) {
    return {
      resolution: "ultra",
      reason: "P2P 实测上行适合高帧率 2K",
    };
  }
  return {
    resolution: "original",
    reason: "P2P 实测上行适合原画",
  };
}

/** The primary signalling service shipped with this build. */
export const HOME_SIGNAL_HOST = "synced.com.cn";
export const HOME_SIGNAL_URL = `wss://${HOME_SIGNAL_HOST}/signal`;
/** Operator-selected signalling-only standby; never used for media relay. */
export const STANDBY_SIGNAL_HOST = "47.98.173.139";
export const STANDBY_SIGNAL_URL = `wss://${STANDBY_SIGNAL_HOST}/signal`;

export function normalizeSignalUrl(input: string): string {
  const value = input.trim();
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("服务器地址必须以 ws:// 或 wss:// 开头");
  }
  if (url.username || url.password) {
    throw new Error("服务器地址不能包含用户名或密码");
  }
  if (
    url.hostname === STANDBY_SIGNAL_HOST &&
    (url.protocol === "ws:" || url.port === "8787")
  ) {
    url.hostname = HOME_SIGNAL_HOST;
    url.protocol = "wss:";
    url.port = "";
  } else if (
    url.protocol === "ws:" &&
    url.hostname === HOME_SIGNAL_HOST &&
    ["", "443", "8787"].includes(url.port)
  ) {
    url.protocol = "wss:";
    url.port = "";
  }
  if (url.pathname === "/") {
    url.pathname = "/signal";
  }
  url.hash = "";
  return url.toString();
}

/**
 * Hosts a deep link may point at without asking the user first.
 *
 * A `synced://join` link carries its own `signal` parameter, so without this
 * check any web page could silently move the app onto a server it controls and
 * receive the user's microphone once they join voice. Loopback and RFC1918
 * ranges stay allowed so local development links keep working.
 */
const TRUSTED_SIGNAL_HOSTS = new Set([
  HOME_SIGNAL_HOST,
  STANDBY_SIGNAL_HOST,
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

function isPrivateSignalHost(hostname: string): boolean {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/u.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/u.test(hostname)) return true;
  return false;
}

export function isTrustedSignalHost(signal: string): boolean {
  try {
    const { hostname } = new URL(signal);
    const normalized = hostname.toLowerCase();
    return TRUSTED_SIGNAL_HOSTS.has(normalized) || isPrivateSignalHost(normalized);
  } catch {
    return false;
  }
}

/** True when an externally supplied signalling URL needs explicit consent. */
export function requiresSignalTrust(signal: string | undefined): boolean {
  if (!signal) return false;
  return !isTrustedSignalHost(signal);
}

/** Host and port shown in the trust prompt, so the user sees where they land. */
export function describeSignalHost(signal: string): string {
  try {
    const url = new URL(signal);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return signal;
  }
}

export const JOIN_LINK_SCHEME = "synced";

/** The pre-2.0 scheme stays accepted so links already shared keep working. */
const ACCEPTED_JOIN_SCHEMES = new Set(["synced:", "yiqikan:"]);

export interface ParsedJoinLink {
  room?: string;
  signal?: string;
  /** Set when `signal` points somewhere the user has not approved. */
  needsSignalTrust?: boolean;
}

export function buildJoinLink(room: string, signal: string): string {
  const params = new URLSearchParams({ room, signal });
  return `${JOIN_LINK_SCHEME}://join?${params.toString()}`;
}

export function parseJoinLink(input: string): ParsedJoinLink {
  try {
    const url = new URL(input);
    if (!ACCEPTED_JOIN_SCHEMES.has(url.protocol) || url.hostname !== "join") {
      return {};
    }
    const room = url.searchParams.get("room")?.trim().toUpperCase() || "";
    if (!/^[23456789A-HJ-NP-Z]{8}$/u.test(room)) {
      return {};
    }
    const rawSignal = url.searchParams.get("signal")?.trim();
    const signal = rawSignal ? normalizeSignalUrl(rawSignal) : undefined;
    return {
      room,
      signal,
      needsSignalTrust: requiresSignalTrust(signal),
    };
  } catch {
    return {};
  }
}

export function formatBitrate(bitsPerSecond: number): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) {
    return "等待数据";
  }
  return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
}
