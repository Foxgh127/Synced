import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/video-enhancement.ts")],
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

function healthyPolicy(overrides = {}) {
  return {
    preference: "auto",
    playbackMode: "emby-viewer",
    backendAvailable: true,
    sourceWidth: 1_920,
    sourceHeight: 1_080,
    outputWidth: 3_840,
    outputHeight: 2_160,
    hdr: false,
    pressure: "healthy",
    now: 10_000,
    ...overrides,
  };
}

test("4K enhancement activates only for useful Emby viewer scaling", async () => {
  const { evaluateVideoEnhancementPolicy } = await loadModule();
  const active = evaluateVideoEnhancementPolicy(healthyPolicy());
  assert.equal(active.active, true);
  assert.equal(active.reason, "active");
  assert.equal(active.scale, 2);
  assert.ok(active.sharpness > 0);

  assert.equal(
    evaluateVideoEnhancementPolicy(
      healthyPolicy({ playbackMode: "off" }),
    ).reason,
    "not-emby-viewer",
  );
  assert.equal(
    evaluateVideoEnhancementPolicy(
      healthyPolicy({ outputWidth: 1_920, outputHeight: 1_080 }),
    ).reason,
    "scale-too-small",
  );
  assert.equal(
    evaluateVideoEnhancementPolicy(
      healthyPolicy({ sourceWidth: 2_560, sourceHeight: 1_440 }),
    ).reason,
    "source-out-of-range",
  );
  assert.equal(
    evaluateVideoEnhancementPolicy(healthyPolicy({ hdr: true })).reason,
    "hdr-unsupported",
  );
  assert.equal(
    evaluateVideoEnhancementPolicy(
      healthyPolicy({ hdr: true, hdrBackendSupported: true }),
    ).reason,
    "active",
  );
});

test("GPU, decoder, and cooldown pressure terminate enhancement", async () => {
  const { evaluateVideoEnhancementPolicy } = await loadModule();
  assert.equal(
    evaluateVideoEnhancementPolicy(
      healthyPolicy({ renderP95Ms: 22.01 }),
    ).reason,
    "render-budget",
  );
  assert.equal(
    evaluateVideoEnhancementPolicy(
      healthyPolicy({ droppedFrameRatio: 0.031 }),
    ).reason,
    "dropped-frames",
  );
  assert.equal(
    evaluateVideoEnhancementPolicy(
      healthyPolicy({ pressure: "decoder-limited" }),
    ).reason,
    "resource-pressure",
  );
  assert.equal(
    evaluateVideoEnhancementPolicy(
      healthyPolicy({ cooldownUntil: 10_001 }),
    ).reason,
    "cooldown",
  );
});

test("4K targets preserve the viewport aspect ratio and even dimensions", async () => {
  const { target4kDimensions } = await loadModule();
  assert.deepEqual(target4kDimensions(16, 9), {
    width: 3_840,
    height: 2_160,
  });
  assert.deepEqual(target4kDimensions(4, 3), {
    width: 2_880,
    height: 2_160,
  });
  const ultraWide = target4kDimensions(21, 9);
  assert.equal(ultraWide.width, 3_840);
  assert.equal(ultraWide.width % 2, 0);
  assert.equal(ultraWide.height % 2, 0);
  assert.ok(Math.abs(ultraWide.width / ultraWide.height - 21 / 9) < 0.002);
});

test("RTX hardware detection is reflected in negotiated capabilities", async () => {
  const {
    detectVideoEnhancementCapabilities,
    rememberVideoEnhancementHardwareInfo,
  } = await loadModule();
  rememberVideoEnhancementHardwareInfo({
    deviceName: "NVIDIA GeForce RTX 5060 Laptop GPU",
    driverVersion: "32.0.16.1074",
    driverRelease: 610,
    activeGpuIsNvidia: true,
    rtxGpu: true,
    hardwareVideoDecode: true,
    videoDecodeStatus: "enabled",
    rtxVideoSupported: true,
    rtxVideoDriverState: "enabled",
    rtxVideoDriverQuality: 4,
    onBatteryPower: false,
  });
  assert.deepEqual(detectVideoEnhancementCapabilities().backends, [
    "rtx-video",
  ]);
});

test("unconfirmed NVIDIA driver VSR never suppresses deterministic 4K fallback", async () => {
  const {
    detectVideoEnhancementCapabilities,
    rememberVideoEnhancementHardwareInfo,
  } = await loadModule();
  rememberVideoEnhancementHardwareInfo({
    deviceName: "NVIDIA GeForce RTX 5060 Laptop GPU",
    driverVersion: "32.0.16.1074",
    driverRelease: 610,
    activeGpuIsNvidia: true,
    rtxGpu: true,
    hardwareVideoDecode: true,
    videoDecodeStatus: "enabled",
    rtxVideoSupported: true,
    rtxVideoDriverState: "unknown",
    onBatteryPower: false,
  });
  assert.deepEqual(detectVideoEnhancementCapabilities().backends, []);
});

test("p95 calculation is deterministic and rejects invalid samples", async () => {
  const { percentile95 } = await loadModule();
  assert.equal(percentile95([]), undefined);
  assert.equal(percentile95([Number.NaN, -1]), undefined);
  assert.equal(percentile95([4, 1, 3, 2]), 4);
  assert.equal(
    percentile95(Array.from({ length: 100 }, (_, index) => index + 1)),
    95,
  );
});
