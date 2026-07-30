import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/capture-frame-rate.ts")],
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

test("matches a stable 24 fps movie after five unconstrained samples", async () => {
  const { CaptureFrameRateController } = await loadModule();
  const controller = new CaptureFrameRateController();
  controller.configure(30);

  let decision;
  for (let index = 0; index < 5; index += 1) {
    decision = controller.observe({
      framesPerSecond: 23.98,
      qualityLimitationReason: "none",
    });
  }
  assert.deepEqual(decision, { changed: true, frameRate: 24 });
  controller.confirmApplied(24);
  for (let index = 0; index < 8; index += 1) {
    assert.equal(
      controller.observe({
        framesPerSecond: 24,
        qualityLimitationReason: "none",
      }).changed,
      false,
    );
  }
});

test("never treats CPU or bandwidth throttling as source cadence", async () => {
  const { CaptureFrameRateController } = await loadModule();
  const controller = new CaptureFrameRateController();
  controller.configure(30);

  for (const reason of ["cpu", "bandwidth", "other", undefined]) {
    for (let index = 0; index < 6; index += 1) {
      assert.equal(
        controller.observe({
          framesPerSecond: 24,
          qualityLimitationReason: reason,
        }).changed,
        false,
      );
    }
  }
});

test("ignores ordinary jitter around the requested frame rate", async () => {
  const { CaptureFrameRateController } = await loadModule();
  const controller = new CaptureFrameRateController();
  controller.configure(30);

  for (const framesPerSecond of [29.3, 30, 28.9, 30.2, 29.8, 30]) {
    assert.equal(
      controller.observe({
        framesPerSecond,
        qualityLimitationReason: "none",
      }).changed,
      false,
    );
  }
});
