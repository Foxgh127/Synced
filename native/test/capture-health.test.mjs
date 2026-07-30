import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  modulePromise ??= build({
    entryPoints: [path.resolve("src/capture-health.ts")],
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

test("sustained near-black thumbnails recover an unmuted live track", async () => {
  const { CaptureVideoHealthController } = await loadModule();
  const health = new CaptureVideoHealthController();
  health.observe(
    {
      thumbnailActivity: 0.4,
      framesEncoded: 100,
      encoderPresent: true,
      trackMuted: false,
    },
    0,
  );
  for (let sample = 1; sample <= 3; sample += 1) {
    assert.equal(
      health.observe(
        {
          thumbnailActivity: 0,
          framesEncoded: 100 + sample,
          encoderPresent: true,
          trackMuted: false,
        },
        sample * 2_500,
      ).recover,
      false,
    );
  }
  assert.deepEqual(
    health.observe(
      {
        thumbnailActivity: 0,
        framesEncoded: 104,
        encoderPresent: true,
        trackMuted: false,
      },
      10_000,
    ),
    {
      recover: true,
      reason: "near-black",
      attempts: 1,
    },
  );
});

test("encoded-frame stalls recover quickly and cooldown bounds retries", async () => {
  const { CaptureVideoHealthController } = await loadModule();
  const health = new CaptureVideoHealthController();
  health.observe(
    {
      thumbnailActivity: 0.3,
      framesEncoded: 50,
      encoderPresent: true,
    },
    0,
  );
  assert.equal(
    health.observe(
      {
        thumbnailActivity: 0.3,
        framesEncoded: 50,
        encoderPresent: true,
      },
      2_500,
    ).recover,
    false,
  );
  assert.equal(
    health.observe(
      {
        thumbnailActivity: 0.3,
        framesEncoded: 50,
        encoderPresent: true,
      },
      5_000,
    ).reason,
    "encoder-stalled",
  );
  assert.equal(health.claim("track-muted", 6_000).recover, false);
  assert.equal(health.claim("track-muted", 13_000).recover, true);
  assert.equal(health.claim("track-muted", 30_000).recover, true);
  assert.equal(health.claim("track-muted", 60_000).recover, false);
});
