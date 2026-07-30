import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/config.ts")],
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

test("movie presets prefer the broadly hardware-accelerated H.264 path", async () => {
  const { buildQualityPreset } = await loadModule();
  assert.deepEqual(
    buildQualityPreset("original", 30).codecOrder.slice(0, 3),
    ["video/H264", "video/VP9", "video/AV1"],
  );
});

test("client presets use the same shared bitrate table as signal advice", async () => {
  const { buildQualityPreset, FRAME_RATE_OPTIONS, isFrameRateOption } =
    await loadModule();
  assert.equal(buildQualityPreset("ultra", 30).maxBitrate, 18_000_000);
  assert.equal(buildQualityPreset("original", 30).maxBitrate, 32_000_000);
  assert.deepEqual(FRAME_RATE_OPTIONS, [24, 30]);
  assert.equal(isFrameRateOption(60), false);
});

test("broadcast recommendations use measured P2P outgoing bandwidth", async () => {
  const { recommendBroadcastPreset } = await loadModule();
  assert.equal(recommendBroadcastPreset().resolution, "high");
  assert.equal(recommendBroadcastPreset(3_000_000).resolution, "smooth");
  assert.equal(recommendBroadcastPreset(6_000_000).resolution, "standard");
  assert.deepEqual(recommendBroadcastPreset(10_000_000), {
    resolution: "high",
    reason: "P2P 实测上行适合 1080p",
  });
  assert.equal(recommendBroadcastPreset(30_000_000).resolution, "original");
});
