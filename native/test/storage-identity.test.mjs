import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

async function loadMigration() {
  const { outputFiles } = await build({
    entryPoints: [path.resolve("src/storage-identity.ts")],
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
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
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

const retiredPrefix = ["yi", "qi", "kan", ":"].join("");

test("moves saved settings to the Synced prefix and removes retired keys", async () => {
  const storage = memoryStorage({
    [`${retiredPrefix}nickname`]: "小狐",
    [`${retiredPrefix}resume-token:ROOM1234`]: "secret-token",
    unrelated: "keep",
  });
  const { migrateStorageIdentity } = await loadMigration();

  assert.equal(migrateStorageIdentity(storage), 2);
  assert.equal(storage.getItem("synced:nickname"), "小狐");
  assert.equal(
    storage.getItem("synced:resume-token:ROOM1234"),
    "secret-token",
  );
  assert.equal(storage.getItem(`${retiredPrefix}nickname`), null);
  assert.equal(storage.getItem(`${retiredPrefix}resume-token:ROOM1234`), null);
  assert.equal(storage.getItem("unrelated"), "keep");
});

test("keeps a current Synced value when both identities are present", async () => {
  const storage = memoryStorage({
    [`${retiredPrefix}movie-volume`]: "0.4",
    "synced:movie-volume": "0.8",
  });
  const { migrateStorageIdentity } = await loadMigration();

  assert.equal(migrateStorageIdentity(storage), 0);
  assert.equal(storage.getItem("synced:movie-volume"), "0.8");
  assert.equal(storage.getItem(`${retiredPrefix}movie-volume`), null);
});
