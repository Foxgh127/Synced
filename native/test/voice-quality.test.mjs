import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/voice-quality.ts")],
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

test("keeps full-band speech bounded as room size grows", async () => {
  const { voiceBitrateForPeerCount } = await loadModule();
  assert.equal(voiceBitrateForPeerCount(0), 64_000);
  assert.equal(voiceBitrateForPeerCount(1), 64_000);
  assert.equal(voiceBitrateForPeerCount(2), 56_000);
  assert.equal(voiceBitrateForPeerCount(3), 48_000);
  assert.equal(voiceBitrateForPeerCount(5), 48_000);
});

test("reserves a higher stereo Opus budget while accompaniment is active", async () => {
  const { voiceBitrateForPeerCount } = await loadModule();
  assert.equal(voiceBitrateForPeerCount(1, true), 96_000);
  assert.equal(voiceBitrateForPeerCount(2, true), 80_000);
  assert.equal(voiceBitrateForPeerCount(4, true), 72_000);
});

test("voice bitrate falls quickly to a safe full-band floor on severe loss", async () => {
  const {
    AdaptiveVoiceBitrateController,
    MIN_ADAPTIVE_VOICE_BITRATE,
  } = await loadModule();
  const controller = new AdaptiveVoiceBitrateController(64_000);
  const reduced = controller.update(
    64_000,
    {
      availableOutgoingBitrate: 40_000,
      currentRoundTripTime: 0.72,
      packetLossRatio: 0.16,
    },
    10_000,
  );
  assert.equal(reduced, 32_000);
  assert.equal(MIN_ADAPTIVE_VOICE_BITRATE, 32_000);
});

test("voice bitrate recovers gradually only after sustained healthy samples", async () => {
  const { AdaptiveVoiceBitrateController } = await loadModule();
  const controller = new AdaptiveVoiceBitrateController(64_000);
  controller.update(
    64_000,
    {
      availableOutgoingBitrate: 40_000,
      currentRoundTripTime: 0.7,
      packetLossRatio: 0.15,
    },
    10_000,
  );
  const healthy = {
    availableOutgoingBitrate: 300_000,
    currentRoundTripTime: 0.08,
    packetLossRatio: 0.002,
  };
  assert.equal(controller.update(64_000, healthy, 14_000), 32_000);
  assert.equal(controller.update(64_000, healthy, 18_000), 32_000);
  assert.equal(controller.update(64_000, healthy, 22_000), 40_000);
  assert.equal(controller.update(64_000, healthy, 26_000), 40_000);
  assert.equal(controller.update(64_000, healthy, 30_000), 40_000);
  assert.equal(controller.update(64_000, healthy, 34_000), 48_000);
});
