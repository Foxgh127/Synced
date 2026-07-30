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

test("keeps full-band voice at a high-quality bitrate across room sizes", async () => {
  const { voiceBitrateForPeerCount } = await loadModule();
  assert.equal(voiceBitrateForPeerCount(0), 256_000);
  assert.equal(voiceBitrateForPeerCount(1), 256_000);
  assert.equal(voiceBitrateForPeerCount(2), 240_000);
  assert.equal(voiceBitrateForPeerCount(3), 224_000);
  assert.equal(voiceBitrateForPeerCount(5), 224_000);
});

test("reserves a higher stereo Opus budget while accompaniment is active", async () => {
  const { voiceBitrateForPeerCount } = await loadModule();
  assert.equal(voiceBitrateForPeerCount(1, true), 320_000);
  assert.equal(voiceBitrateForPeerCount(2, true), 288_000);
  assert.equal(voiceBitrateForPeerCount(4, true), 256_000);
});

test("voice bitrate falls quickly on severe loss but remains above 96 kbps", async () => {
  const {
    AdaptiveVoiceBitrateController,
    MIN_ADAPTIVE_VOICE_BITRATE,
  } = await loadModule();
  const controller = new AdaptiveVoiceBitrateController(256_000);
  const reduced = controller.update(
    256_000,
    {
      availableOutgoingBitrate: 170_000,
      currentRoundTripTime: 0.72,
      packetLossRatio: 0.16,
    },
    10_000,
  );
  assert.equal(reduced, 119_000);
  assert.equal(MIN_ADAPTIVE_VOICE_BITRATE, 112_000);
  assert.ok(reduced > 96_000);
});

test("voice bitrate recovers gradually only after sustained healthy samples", async () => {
  const { AdaptiveVoiceBitrateController } = await loadModule();
  const controller = new AdaptiveVoiceBitrateController(256_000);
  controller.update(
    256_000,
    {
      availableOutgoingBitrate: 170_000,
      currentRoundTripTime: 0.7,
      packetLossRatio: 0.15,
    },
    10_000,
  );
  const healthy = {
    availableOutgoingBitrate: 900_000,
    currentRoundTripTime: 0.08,
    packetLossRatio: 0.002,
  };
  assert.equal(controller.update(256_000, healthy, 14_000), 119_000);
  assert.equal(controller.update(256_000, healthy, 18_000), 119_000);
  assert.equal(controller.update(256_000, healthy, 22_000), 151_000);
  assert.equal(controller.update(256_000, healthy, 26_000), 151_000);
  assert.equal(controller.update(256_000, healthy, 30_000), 151_000);
  assert.equal(controller.update(256_000, healthy, 34_000), 183_000);
});
