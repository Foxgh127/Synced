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
      width: 848,
      height: 480,
      frameRate: 24,
      quality: "low",
      emergency: true,
    },
  );
});

test("SFU emergency publication requires verified 480p track settings", async () => {
  const { isVerifiedEmergencyTrackSettings } = await loadModule("src/sfu.ts");
  assert.equal(
    isVerifiedEmergencyTrackSettings({
      width: 848,
      height: 480,
      frameRate: 24,
    }),
    true,
  );
  assert.equal(
    isVerifiedEmergencyTrackSettings({
      width: 2560,
      height: 1440,
      frameRate: 24,
    }),
    false,
    "a driver that ignores clone constraints cannot be labelled 480p",
  );
  assert.equal(
    isVerifiedEmergencyTrackSettings({
      width: 848,
      height: 480,
    }),
    false,
    "frame rate must be measured rather than inferred from the publication name",
  );
  assert.equal(
    isVerifiedEmergencyTrackSettings({
      width: 848,
      height: 480,
      frameRate: 30,
    }),
    false,
  );
  assert.equal(
    isVerifiedEmergencyTrackSettings({
      width: 854,
      height: 480,
      frameRate: 24,
    }),
    false,
    "the emergency publication width must use a complete decoder row",
  );
  assert.equal(
    isVerifiedEmergencyTrackSettings({
      width: 842,
      height: 480,
      frameRate: 24,
    }),
    false,
    "a smaller but unaligned emergency track is still decoder-unsafe",
  );
});

test("SFU publication constraints align non-standard source rasters", async () => {
  const { safeSfuScreenDimensions } = await loadModule("src/sfu.ts");
  const target = safeSfuScreenDimensions(3_618, 2_160);
  assert.equal(target.width % 16, 0);
  assert.equal(target.height % 2, 0);
  assert.ok(target.width <= 2_560);
  assert.ok(target.height <= 1_440);
  assert.ok(Math.abs(target.width / target.height - 3_618 / 2_160) < 0.01);
  assert.deepEqual(safeSfuScreenDimensions(2_560, 1_440), {
    width: 2_560,
    height: 1_440,
  });
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
  viewers[2].observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      currentRoundTripTime: 0.15,
      baselineRoundTripTime: 0.15,
      availableBandwidthBps: 25_000_000,
    },
    4_000,
  );
  viewers[2].observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      currentRoundTripTime: 0.15,
      baselineRoundTripTime: 0.15,
      availableBandwidthBps: 25_000_000,
    },
    5_000,
  );
  const recovered = viewers[2].observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      currentRoundTripTime: 0.15,
      baselineRoundTripTime: 0.15,
      availableBandwidthBps: 25_000_000,
    },
    25_000,
  );
  assert.equal(recovered.direction, "up");
  assert.equal(viewers[2].requestedHeight, undefined);
});
