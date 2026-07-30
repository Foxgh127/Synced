import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

async function loadChannelStore() {
  const { outputFiles } = await build({
    entryPoints: [path.resolve("src/channel-store.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function roomFromToken(token) {
  const bytes = Buffer.from(token, "base64url");
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
  return values.map((value) => alphabet[value]).join("");
}

test("rotates an unauthenticated legacy code into a stable private credential", async () => {
  globalThis.localStorage = memoryStorage({
    "yiqikan:host-channel": "F7K9P2WX",
  });
  const store = await loadChannelStore();
  const first = await store.getHostChannelOwnership();
  const second = await store.getHostChannelOwnership();

  assert.notEqual(first.room, "F7K9P2WX");
  assert.equal(first.ownerToken.length, 43);
  assert.equal(roomFromToken(first.ownerToken), first.room);
  assert.deepEqual(second, first);
  assert.equal(await store.getHostChannelCode(), first.room);
});
