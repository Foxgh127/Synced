const { createHash, randomBytes } = require("node:crypto");

const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function roomForOwnerToken(ownerToken) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ownerToken || "")) {
    throw new Error("频道主凭证格式无效");
  }
  const bytes = Buffer.from(ownerToken, "base64url");
  if (
    bytes.length !== 32 ||
    bytes.toString("base64url") !== ownerToken
  ) {
    throw new Error("频道主凭证格式无效");
  }
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

function createChannelOwner() {
  const ownerToken = randomBytes(32).toString("base64url");
  return {
    room: roomForOwnerToken(ownerToken),
    ownerToken,
  };
}

module.exports = {
  createChannelOwner,
  roomForOwnerToken,
};
