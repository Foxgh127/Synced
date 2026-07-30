import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/danmaku-mode.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    }).then(({ outputFiles }) =>
      import(
        `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
      ),
    );
  }
  return modulePromise;
}

test("uses the full desktop whenever Windows has no active broadcast", async () => {
  const { shouldEnableDesktopDanmaku } = await loadModule();
  assert.equal(
    shouldEnableDesktopDanmaku({
      desktop: true,
      broadcasterId: undefined,
    }),
    true,
  );
  assert.equal(
    shouldEnableDesktopDanmaku({
      desktop: true,
      broadcasterId: undefined,
    }),
    true,
  );
  assert.equal(
    shouldEnableDesktopDanmaku({
      desktop: true,
      broadcasterId: "friend",
    }),
    false,
  );
  assert.equal(
    shouldEnableDesktopDanmaku({
      desktop: false,
      broadcasterId: undefined,
    }),
    false,
  );
});

test("echoes chat on the stage while a broadcast is active", async () => {
  const { shouldRenderStageDanmaku } = await loadModule();
  assert.equal(
    shouldRenderStageDanmaku({
      enabled: true,
      desktop: true,
      broadcasterId: "self",
    }),
    true,
  );
  assert.equal(
    shouldRenderStageDanmaku({
      enabled: true,
      desktop: true,
      broadcasterId: "friend",
    }),
    true,
  );
  assert.equal(
    shouldRenderStageDanmaku({
      enabled: true,
      desktop: true,
      broadcasterId: undefined,
    }),
    false,
  );
  assert.equal(
    shouldRenderStageDanmaku({
      enabled: true,
      desktop: true,
      broadcasterId: undefined,
      appFocused: true,
    }),
    true,
  );
  assert.equal(
    shouldRenderStageDanmaku({
      enabled: false,
      desktop: false,
      broadcasterId: "friend",
    }),
    false,
  );
});
