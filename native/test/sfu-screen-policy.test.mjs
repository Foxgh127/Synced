import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

const modules = new Map();

async function loadModule(relativePath) {
  if (!modules.has(relativePath)) {
    modules.set(
      relativePath,
      build({
        entryPoints: [path.resolve(relativePath)],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
      }).then(({ outputFiles }) =>
        import(
          `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
        ),
      ),
    );
  }
  return modules.get(relativePath);
}

test("1440p SFU subscription policy maps every viewer rung explicitly", async () => {
  const { resolveSfuScreenSubscription } = await loadModule(
    "src/sfu-screen-policy.ts",
  );
  const source = { sourceWidth: 2_560, sourceHeight: 1_440 };
  assert.deepEqual(resolveSfuScreenSubscription(source), {
    width: 2_560,
    height: 1_440,
    frameRate: 30,
    quality: "high",
    emergency: false,
  });
  assert.deepEqual(
    resolveSfuScreenSubscription({ ...source, height: 1_080 }),
    {
      width: 1_920,
      height: 1_080,
      frameRate: 30,
      quality: "medium",
      emergency: false,
    },
  );
  assert.deepEqual(
    resolveSfuScreenSubscription({ ...source, height: 720 }),
    {
      width: 1_280,
      height: 720,
      frameRate: 30,
      quality: "low",
      emergency: false,
    },
  );
  assert.deepEqual(
    resolveSfuScreenSubscription({
      ...source,
      width: 854,
      height: 480,
      frameRate: 60,
    }),
    {
      width: 854,
      height: 480,
      frameRate: 24,
      quality: "low",
      emergency: true,
    },
  );
});

test("one weak viewer degrades within two seconds without changing peers", async () => {
  const { AdaptivePlaybackController } = await loadModule(
    "src/adaptive-playback.ts",
  );
  const { resolveSfuScreenSubscription } = await loadModule(
    "src/sfu-screen-policy.ts",
  );
  const viewers = Array.from(
    { length: 3 },
    () => new AdaptivePlaybackController(),
  );
  for (const viewer of viewers) {
    viewer.configure(1_440, 0, false, {
      contentMode: "motion",
      sourceFrameRate: 30,
    });
  }
  for (let second = 0; second <= 2; second += 1) {
    viewers[2].observe(
      {
        connectionState: "connected",
        packetLossRatio: 0.05,
        currentRoundTripTime: 0.15,
        availableBandwidthBps: 4_000_000,
      },
      second * 1_000,
    );
  }
  assert.deepEqual(
    viewers.map((viewer) => viewer.requestedHeight),
    [undefined, undefined, 1_080],
  );
  assert.deepEqual(
    viewers.map((viewer) =>
      resolveSfuScreenSubscription({
        sourceWidth: 2_560,
        sourceHeight: 1_440,
        height: viewer.requestedHeight,
        frameRate: viewer.requestedFrameRate,
      }).quality,
    ),
    ["high", "high", "medium"],
  );

  viewers[2].observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      currentRoundTripTime: 0.15,
      baselineRoundTripTime: 0.15,
      availableBandwidthBps: 25_000_000,
    },
    3_000,
  );
  const recovered = viewers[2].observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      currentRoundTripTime: 0.15,
      baselineRoundTripTime: 0.15,
      availableBandwidthBps: 25_000_000,
    },
    23_000,
  );
  assert.equal(recovered.direction, "up");
  assert.equal(viewers[2].requestedHeight, undefined);
});
