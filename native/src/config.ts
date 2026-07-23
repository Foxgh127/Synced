export type QualityKey = "balanced" | "high" | "ultra";

export interface QualityPreset {
  key: QualityKey;
  label: string;
  detail: string;
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
  audioBitrate: number;
  codecOrder: string[];
}

export const QUALITY_PRESETS: Record<QualityKey, QualityPreset> = {
  balanced: {
    key: "balanced",
    label: "流畅",
    detail: "1080p · 30 帧 · 12 Mbps",
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 12_000_000,
    audioBitrate: 192_000,
    codecOrder: ["video/VP9", "video/H264", "video/VP8"],
  },
  high: {
    key: "high",
    label: "高清",
    detail: "2K · 30 帧 · 25 Mbps",
    width: 2560,
    height: 1440,
    frameRate: 30,
    maxBitrate: 25_000_000,
    audioBitrate: 224_000,
    codecOrder: ["video/AV1", "video/VP9", "video/H264", "video/VP8"],
  },
  ultra: {
    key: "ultra",
    label: "影院",
    detail: "4K · 30 帧 · 45 Mbps",
    width: 3840,
    height: 2160,
    frameRate: 30,
    maxBitrate: 45_000_000,
    audioBitrate: 256_000,
    codecOrder: ["video/AV1", "video/VP9", "video/H264", "video/VP8"],
  },
};

const ROOM_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function createRoomCode(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length]).join("");
}

export function normalizeSignalUrl(input: string): string {
  const value = input.trim();
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("服务器地址必须以 ws:// 或 wss:// 开头");
  }
  if (url.pathname === "/") {
    url.pathname = "/signal";
  }
  url.hash = "";
  return url.toString();
}

export function buildJoinLink(room: string, signal: string): string {
  const params = new URLSearchParams({ room, signal });
  return `yiqikan://join?${params.toString()}`;
}

export function parseJoinLink(input: string): { room?: string; signal?: string } {
  try {
    const url = new URL(input);
    return {
      room: url.searchParams.get("room")?.toUpperCase() || undefined,
      signal: url.searchParams.get("signal") || undefined,
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
