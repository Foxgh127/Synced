import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/adaptive-playback.ts")],
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

test("degrades within three bad samples and recovers only after sustained headroom", async () => {
  const { AdaptivePlaybackController } = await loadModule();
  const controller = new AdaptivePlaybackController();
  controller.configure(1600);

  assert.equal(controller.requestedHeight, undefined);
  let decision;
  for (let index = 0; index < 3; index += 1) {
    decision = controller.observe(
      {
        connectionState: "connected",
        packetLossRatio: 0.06,
        jitter: 0.09,
      },
      1_000 + index * 1_000,
    );
  }
  assert.equal(decision.direction, "down");
  assert.equal(decision.requestedHeight, 1080);
  assert.equal(decision.pressure, "network-limited");

  decision = controller.observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      jitter: 0.01,
      availableBandwidthBps: 25_000_000,
      currentRoundTripTime: 0.03,
    },
    10_000,
  );
  assert.equal(decision.changed, false);
  decision = controller.observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      jitter: 0.01,
      availableBandwidthBps: 25_000_000,
      currentRoundTripTime: 0.03,
    },
    30_000,
  );
  assert.equal(decision.direction, "up");
  assert.equal(decision.requestedHeight, undefined);
});

test("a manual ceiling is retained and upgrade requires 1.5x bandwidth", async () => {
  const { AdaptivePlaybackController } = await loadModule();
  const controller = new AdaptivePlaybackController();
  controller.configure(2160, 720);
  assert.equal(controller.requestedHeight, 720);

  const down = controller.observe(
    { connectionState: "connected", packetLossRatio: 0.2 },
    2_000,
  );
  assert.equal(down.direction, "down");
  assert.equal(down.requestedHeight, 480);

  controller.observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      jitter: 0,
      availableBandwidthBps: 4_700_000,
    },
    10_000,
  );
  let held = controller.observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      jitter: 0,
      availableBandwidthBps: 4_700_000,
    },
    35_000,
  );
  assert.equal(held.changed, false);
  assert.equal(held.requestedHeight, 480);

  held = controller.observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      jitter: 0,
      availableBandwidthBps: 5_000_000,
    },
    36_000,
  );
  assert.equal(held.direction, "up");
  assert.equal(held.requestedHeight, 720);
});

test("detail mode sacrifices frame rate before pixels and has a terminal 480p rung", async () => {
  const { AdaptivePlaybackController } = await loadModule();
  const controller = new AdaptivePlaybackController();
  controller.configure(2160, 720, false, {
    contentMode: "detail",
    sourceFrameRate: 30,
  });

  assert.deepEqual(
    [controller.requestedHeight, controller.requestedFrameRate],
    [720, 30],
  );
  const first = controller.forceDegrade();
  const second = controller.forceDegrade();
  const third = controller.forceDegrade();
  const exhausted = controller.forceDegrade();

  assert.deepEqual(
    [first.requestedHeight, first.requestedFrameRate],
    [720, 20],
  );
  assert.deepEqual(
    [second.requestedHeight, second.requestedFrameRate],
    [720, 15],
  );
  assert.deepEqual(
    [third.requestedHeight, third.requestedFrameRate],
    [480, 20],
  );
  assert.equal(exhausted.changed, false);
});

test("a short isolated jitter spike does not change quality", async () => {
  const { AdaptivePlaybackController } = await loadModule();
  const controller = new AdaptivePlaybackController();
  controller.configure(2160);

  const spike = controller.observe(
    { connectionState: "connected", packetLossRatio: 0.04, jitter: 0.09 },
    3_000,
  );
  const recovered = controller.observe(
    { connectionState: "connected", packetLossRatio: 0, jitter: 0.01 },
    4_000,
  );
  assert.equal(spike.changed, false);
  assert.equal(recovered.changed, false);
  assert.equal(controller.requestedHeight, undefined);
});

test("an ambiguous Wi-Fi sample restarts the continuous upgrade window", async () => {
  const { AdaptivePlaybackController } = await loadModule();
  const controller = new AdaptivePlaybackController();
  controller.configure(1600);

  controller.observe(
    { connectionState: "connected", packetLossRatio: 0.15 },
    1_000,
  );
  assert.equal(controller.requestedHeight, 1080);

  controller.observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      availableBandwidthBps: 25_000_000,
    },
    5_000,
  );
  controller.observe(
    {
      connectionState: "connected",
      packetLossRatio: 0.018,
      jitter: 0.02,
      availableBandwidthBps: 25_000_000,
    },
    24_000,
  );
  let decision = controller.observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      availableBandwidthBps: 25_000_000,
    },
    25_000,
  );
  assert.equal(decision.changed, false);

  decision = controller.observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      availableBandwidthBps: 25_000_000,
    },
    45_000,
  );
  assert.equal(decision.direction, "up");
});

test("severe receiver decode pressure degrades immediately and is classified", async () => {
  const { AdaptivePlaybackController } = await loadModule();
  const controller = new AdaptivePlaybackController();
  controller.configure(2160);

  const decision = controller.observe(
    {
      connectionState: "connected",
      packetLossRatio: 0,
      jitter: 0.005,
      framesDroppedRatio: 0.22,
      averageDecodeTime: 0.03,
      frameRate: 30,
    },
    20_000,
  );

  assert.equal(decision.changed, true);
  assert.equal(decision.direction, "down");
  assert.equal(decision.requestedHeight, 1080);
  assert.equal(decision.pressure, "decoder-limited");
  assert.match(decision.reason, /解码压力/);
});
