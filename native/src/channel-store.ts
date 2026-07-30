export interface RecentChannel {
  room: string;
  name: string;
  signalUrl: string;
  lastJoinedAt: number;
}

const RECENT_KEY = "yiqikan:recent-channels";
const HOST_CHANNEL_KEY = "yiqikan:host-channel";
const HOST_CHANNEL_OWNER_KEY = "yiqikan:host-channel-owner-v3";
const LEGACY_HOST_CHANNEL_OWNER_KEY = "yiqikan:host-channel-owner-v2";
const NICKNAME_KEY = "yiqikan:nickname";
const CHANNEL_NAME_KEY = "yiqikan:channel-name";
const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export interface HostChannelOwnership {
  room: string;
  ownerToken: string;
}

function clean(value: string, maxLength: number): string {
  return Array.from(value.replace(/\s+/g, " ").trim()).slice(0, maxLength).join("");
}

export function getRecentChannels(): RecentChannel[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (item): item is RecentChannel =>
          typeof item?.room === "string" &&
          typeof item?.name === "string" &&
          typeof item?.signalUrl === "string" &&
          typeof item?.lastJoinedAt === "number",
      )
      .slice(0, 8);
  } catch {
    return [];
  }
}

export function rememberChannel(channel: RecentChannel): void {
  const normalized = {
    ...channel,
    room: channel.room.toUpperCase(),
    name: clean(channel.name, 24) || "朋友的频道",
  };
  const recent = getRecentChannels().filter((item) => item.room !== normalized.room);
  localStorage.setItem(RECENT_KEY, JSON.stringify([normalized, ...recent].slice(0, 8)));
}

export function forgetRecentChannel(room: string): boolean {
  const normalizedRoom = room.trim().toUpperCase();
  const recent = getRecentChannels();
  const remaining = recent.filter((item) => item.room.toUpperCase() !== normalizedRoom);
  if (remaining.length === recent.length) {
    return false;
  }
  if (remaining.length) {
    localStorage.setItem(RECENT_KEY, JSON.stringify(remaining));
  } else {
    localStorage.removeItem(RECENT_KEY);
  }
  return true;
}

function roomForDigest(digest: Uint8Array): string {
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

async function roomForOwnerBytes(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestInput.buffer),
  );
  return roomForDigest(digest);
}

function ownerTokenForBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function ownerBytesForToken(token: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
  try {
    const padded = token
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(token.length / 4) * 4, "=");
    const binary = atob(padded);
    if (binary.length !== 32) return undefined;
    return Uint8Array.from(binary, (value) => value.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * Returns this installation's creator credential.
 *
 * The visible room code is derived from a SHA-256 digest of a private 256-bit
 * token. The one-way derivation prevents somebody who only knows the room
 * code from constructing a matching creator credential.
 */
export async function getHostChannelOwnership(): Promise<HostChannelOwnership> {
  for (const key of [
    HOST_CHANNEL_OWNER_KEY,
    LEGACY_HOST_CHANNEL_OWNER_KEY,
  ]) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      const bytes =
        typeof saved?.ownerToken === "string"
          ? ownerBytesForToken(saved.ownerToken)
          : undefined;
      if (bytes) {
        const ownership = {
          room: await roomForOwnerBytes(bytes),
          ownerToken: saved.ownerToken,
        };
        localStorage.setItem(
          HOST_CHANNEL_OWNER_KEY,
          JSON.stringify(ownership),
        );
        localStorage.setItem(HOST_CHANNEL_KEY, ownership.room);
        return ownership;
      }
    } catch {
      // Try the older credential before replacing malformed local data.
    }
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const ownership = {
    room: await roomForOwnerBytes(bytes),
    ownerToken: ownerTokenForBytes(bytes),
  };
  localStorage.setItem(HOST_CHANNEL_OWNER_KEY, JSON.stringify(ownership));
  // A legacy room code cannot be retained safely because it has no private
  // credential. Rotate it once and keep the old key synchronized for UI code.
  localStorage.setItem(HOST_CHANNEL_KEY, ownership.room);
  return ownership;
}

export async function getHostChannelCode(): Promise<string> {
  return (await getHostChannelOwnership()).room;
}

export function getNickname(): string {
  return clean(localStorage.getItem(NICKNAME_KEY) || "", 16) || "朋友";
}

export function saveNickname(value: string): string {
  const nickname = clean(value, 16) || "朋友";
  localStorage.setItem(NICKNAME_KEY, nickname);
  return nickname;
}

export function getChannelName(): string {
  return clean(localStorage.getItem(CHANNEL_NAME_KEY) || "", 24) || "今晚一起看";
}

export function saveChannelName(value: string): string {
  const channelName = clean(value, 24) || "今晚一起看";
  localStorage.setItem(CHANNEL_NAME_KEY, channelName);
  return channelName;
}
