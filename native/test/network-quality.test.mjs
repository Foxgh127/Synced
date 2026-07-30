import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  modulePromise ??= build({
    entryPoints: [path.resolve("src/network-quality.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  }).then(({ outputFiles }) =>
    import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
    ),
  );
  return modulePromise;
}

test("network advice falls back to a stable 1080p selection", async () => {
  const { fallbackNetworkAdvice, frameRateForResolution } =
    await loadModule();
  const advice = fallbackNetworkAdvice(3);
  assert.equal(advice.recommendedResolution, "high");
  assert.equal(advice.participantCount, 3);
  assert.equal(frameRateForResolution("high", advice), 30);
  assert.equal(frameRateForResolution("original", advice), 30);
});

test("an unlocked selection applies the advised resolution and 30 fps ceiling", async () => {
  const { sanitizeNetworkAdvice, selectResolutionAndFrameRate } =
    await loadModule();
  const advice = sanitizeNetworkAdvice({
    revision: 4,
    participantCount: 2,
    measuredCount: 2,
    confidence: "high",
    perViewerBudgetBps: 32_000_000,
    recommendedResolution: "ultra",
    routeMode: "p2p-preferred",
    reason: "两端网络稳定",
    maxFrameRateByResolution: {
      original: 24,
      ultra: 30,
      high: 30,
      standard: 30,
      smooth: 24,
    },
  });
  assert.ok(advice);
  assert.deepEqual(
    selectResolutionAndFrameRate({
      resolution: "original",
      currentFrameRate: 24,
      frameRateLockedByUser: false,
      advice,
    }),
    { resolution: "ultra", frameRate: 30 },
  );
});

test("a manually selected frame rate remains authoritative", async () => {
  const { fallbackNetworkAdvice, selectResolutionAndFrameRate } =
    await loadModule();
  assert.deepEqual(
    selectResolutionAndFrameRate({
      resolution: "ultra",
      currentFrameRate: 30,
      frameRateLockedByUser: true,
      advice: fallbackNetworkAdvice(),
    }),
    { resolution: "ultra", frameRate: 30 },
  );
});

test("server advice is rejected after its source-bound validity expires", async () => {
  const { sanitizeNetworkAdvice } = await loadModule();
  const base = {
    revision: 7,
    participantCount: 8,
    measuredCount: 8,
    confidence: "high",
    perViewerBudgetBps: 18_000_000,
    recommendedResolution: "ultra",
    routeMode: "sfu-preferred",
    reason: "SFU 主线路",
    maxFrameRateByResolution: {},
  };
  assert.equal(
    sanitizeNetworkAdvice({
      ...base,
      validUntil: Date.now() - 1,
    }),
    undefined,
  );
  const current = sanitizeNetworkAdvice({
    ...base,
    validUntil: Date.now() + 30_000,
  });
  assert.equal(current?.participantCount, 8);
  assert.ok(current?.validUntil > Date.now());
});

test("stale and malformed network advice is rejected", async () => {
  const { sanitizeNetworkAdvice } = await loadModule();
  assert.equal(
    sanitizeNetworkAdvice(
      {
        revision: 2,
        participantCount: 2,
        measuredCount: 2,
        confidence: "high",
        perViewerBudgetBps: 20_000_000,
        recommendedResolution: "ultra",
        routeMode: "balanced",
        maxFrameRateByResolution: {},
      },
      2,
    ),
    undefined,
  );
  assert.equal(
    sanitizeNetworkAdvice({
      revision: 3,
      participantCount: 99,
      measuredCount: 2,
      confidence: "impossible",
      perViewerBudgetBps: Number.POSITIVE_INFINITY,
      recommendedResolution: "8k",
      routeMode: "force-everyone-through-relay",
    }),
    undefined,
  );
});
