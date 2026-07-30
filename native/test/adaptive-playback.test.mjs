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

test("degrades resolution after sustained packet loss and recovers stepwise", async () => {
  const { AdaptivePlaybackController } = await loadModule();
  const controller = new AdaptivePlaybackController();
  controller.configure(1600);

  assert.equal(controller.requestedHeight, undefined);
  let down;
  for (let index = 0; index < 5; index += 1) {
    down = controller.observe(
      { connectionState: "connected", packetLossRatio: 0.06, jitter: 0.09 },
      1_000 + index * 1_000,
    );
  }
  assert.equal(down.direction, "down");
  assert.equal(down.requestedHeight, 1440);

  let up;
  for (let index = 0; index < 5; index += 1) {
    up = controller.observe(
      { connectionState: "connected", packetLossRatio: 0, jitter: 0.01 },
      10_000 + index * 1_000,
    );
  }
  assert.equal(up.direction, "up");
  assert.equal(up.requestedHeight, undefined);
});

test("a manual quality ceiling is never exceeded during recovery", async () => {
  const { AdaptivePlaybackController } = await loadModule();
  const controller = new AdaptivePlaybackController();
  controller.configure(2160, 720);
  assert.equal(controller.requestedHeight, 720);

  controller.observe(
    { connectionState: "connected", packetLossRatio: 0.2 },
    2_000,
  );
  controller.observe(
    { connectionState: "connected", packetLossRatio: 0.2 },
    3_000,
  );
  const down = controller.observe(
    { connectionState: "connected", packetLossRatio: 0.2 },
    4_000,
  );
  assert.equal(down.requestedHeight, 480);

  let up;
  for (let index = 0; index < 5; index += 1) {
    up = controller.observe(
      { connectionState: "connected", packetLossRatio: 0, jitter: 0 },
      10_000 + index * 1_000,
    );
  }
  assert.equal(up.requestedHeight, 720);
});

test("missing startup frames force mobile quality down through 480p and 360p", async () => {
  const { AdaptivePlaybackController } = await loadModule();
  const controller = new AdaptivePlaybackController();
  controller.configure(2160, 720);

  const first = controller.forceDegrade();
  const second = controller.forceDegrade();
  const exhausted = controller.forceDegrade();

  assert.equal(first.requestedHeight, 480);
  assert.equal(second.requestedHeight, 360);
  assert.equal(exhausted.changed, false);
  assert.equal(exhausted.requestedHeight, 360);
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

test("neutral 1-2% Wi-Fi loss does not erase accumulated recovery samples", async () => {
  const { AdaptivePlaybackController } = await loadModule();
  const controller = new AdaptivePlaybackController();
  controller.configure(1600);

  let decision;
  for (let index = 0; index < 5; index += 1) {
    decision = controller.observe(
      { connectionState: "connected", packetLossRatio: 0.06, jitter: 0.09 },
      1_000 + index * 1_000,
    );
  }
  assert.equal(decision.direction, "down");
  assert.equal(controller.requestedHeight, 1440);

  for (let index = 0; index < 3; index += 1) {
    decision = controller.observe(
      { connectionState: "connected", packetLossRatio: 0, jitter: 0.01 },
      10_000 + index * 1_000,
    );
  }
  decision = controller.observe(
    { connectionState: "connected", packetLossRatio: 0.018, jitter: 0.02 },
    13_000,
  );
  assert.equal(decision.changed, false);

  for (let index = 0; index < 2; index += 1) {
    decision = controller.observe(
      { connectionState: "connected", packetLossRatio: 0, jitter: 0.01 },
      14_000 + index * 1_000,
    );
  }
  assert.equal(decision.direction, "up");
  assert.equal(controller.requestedHeight, undefined);
});

test("degrades when the receiver cannot decode frames in real time", async () => {
  const { AdaptivePlaybackController } = await loadModule();
  const controller = new AdaptivePlaybackController();
  controller.configure(2160);

  let decision;
  for (let index = 0; index < 3; index += 1) {
    decision = controller.observe(
      {
        connectionState: "connected",
        packetLossRatio: 0,
        jitter: 0.005,
        framesDroppedRatio: 0.22,
        averageDecodeTime: 0.03,
        frameRate: 30,
      },
      20_000 + index * 1_000,
    );
  }

  assert.equal(decision.changed, true);
  assert.equal(decision.direction, "down");
  assert.equal(decision.requestedHeight, 1440);
  assert.match(decision.reason, /解码压力/);
});
