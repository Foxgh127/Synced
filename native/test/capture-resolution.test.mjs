import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  modulePromise ??= build({
    entryPoints: [path.resolve("src/capture-resolution.ts")],
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

test("restores the physical raster hidden by Windows display scaling", async () => {
  const { physicalCaptureTarget } = await loadModule();
  assert.deepEqual(
    physicalCaptureTarget(
      { width: 1280, height: 720, screenPixelRatio: 1.5 },
      7680,
      4320,
    ),
    {
      width: 1920,
      height: 1080,
      upgradeRequired: true,
      edgeGuardRequired: false,
      recreateRequired: true,
    },
  );
});

test("fits a physical source inside the selected preset without distortion", async () => {
  const { physicalCaptureTarget } = await loadModule();
  assert.deepEqual(
    physicalCaptureTarget(
      { width: 2560, height: 1440, screenPixelRatio: 1.5 },
      1920,
      1080,
    ),
    {
      width: 1920,
      height: 1080,
      upgradeRequired: false,
      edgeGuardRequired: false,
      recreateRequired: false,
    },
  );
  assert.deepEqual(
    physicalCaptureTarget(
      { width: 1920, height: 1080, screenPixelRatio: 1 },
      1920,
      1080,
    ),
    {
      width: 1920,
      height: 1080,
      upgradeRequired: false,
      edgeGuardRequired: false,
      recreateRequired: false,
    },
  );
});

test("aligns unsafe captured row widths without reducing standard 1080p", async () => {
  const { physicalCaptureTarget } = await loadModule();
  assert.deepEqual(
    physicalCaptureTarget(
      { width: 3618, height: 2160, screenPixelRatio: 1 },
      7680,
      4320,
    ),
    {
      width: 3616,
      height: 2160,
      upgradeRequired: false,
      edgeGuardRequired: true,
      recreateRequired: true,
    },
  );
  assert.deepEqual(
    physicalCaptureTarget(
      { width: 1206, height: 720, screenPixelRatio: 1 },
      7680,
      4320,
    ),
    {
      width: 1200,
      height: 720,
      upgradeRequired: false,
      edgeGuardRequired: true,
      recreateRequired: true,
    },
  );
});

test("aligns the local WGC texture height without masking valid picture rows", async () => {
  const { physicalCaptureTarget } = await loadModule();
  assert.deepEqual(
    physicalCaptureTarget(
      { width: 1924, height: 1244, screenPixelRatio: 1.5 },
      3840,
      2160,
    ),
    {
      width: 2880,
      height: 1864,
      upgradeRequired: true,
      edgeGuardRequired: true,
      recreateRequired: true,
    },
  );
  assert.deepEqual(
    physicalCaptureTarget(
      { width: 1920, height: 1080, screenPixelRatio: 1 },
      1920,
      1080,
    ),
    {
      width: 1920,
      height: 1080,
      upgradeRequired: false,
      edgeGuardRequired: false,
      recreateRequired: false,
    },
  );
});

test("aligns DPR-derived physical targets without exceeding their physical bounds", async () => {
  const { physicalCaptureTarget } = await loadModule();
  const largeTarget = physicalCaptureTarget(
    { width: 2412, height: 1440, screenPixelRatio: 1.5 },
    7680,
    4320,
  );
  const compactTarget = physicalCaptureTarget(
    { width: 804, height: 480, screenPixelRatio: 1.5 },
    7680,
    4320,
  );

  assert.deepEqual(largeTarget, {
    width: 3616,
    height: 2160,
    upgradeRequired: true,
    edgeGuardRequired: true,
    recreateRequired: true,
  });
  assert.deepEqual(compactTarget, {
    width: 1200,
    height: 720,
    upgradeRequired: true,
    edgeGuardRequired: true,
    recreateRequired: true,
  });
  for (const [target, physicalWidth, physicalHeight] of [
    [largeTarget, 3618, 2160],
    [compactTarget, 1206, 720],
  ]) {
    assert.ok(target);
    assert.equal(target.width % 16, 0);
    assert.equal(target.height % 8, 0);
    assert.ok(target.width <= physicalWidth);
    assert.ok(target.height <= physicalHeight);
    const sourceAspect = physicalWidth / physicalHeight;
    const targetAspect = target.width / target.height;
    assert.ok(Math.abs(targetAspect / sourceAspect - 1) <= 0.005);
  }
});

test("keeps final receiver encoding rows safe after fullscreen downscaling", async () => {
  const { safeVideoEncodingTarget } = await loadModule();
  const fullscreen720 = safeVideoEncodingTarget(3616, 2160, 720);
  const ignoredExactConstraint = safeVideoEncodingTarget(3618, 2160, 2160);
  const standard1080 = safeVideoEncodingTarget(1920, 1080, 1080);

  assert.ok(fullscreen720);
  assert.equal(fullscreen720.width, 1200);
  assert.equal(fullscreen720.height, 716);
  assert.equal(fullscreen720.width % 16, 0);
  assert.equal(fullscreen720.height % 2, 0);
  assert.ok(fullscreen720.height <= 720);
  assert.ok(fullscreen720.scaleResolutionDownBy > 3);
  assert.equal(fullscreen720.edgeGuardRequired, true);

  assert.ok(ignoredExactConstraint);
  assert.equal(ignoredExactConstraint.width, 3616);
  assert.equal(ignoredExactConstraint.height, 2158);
  assert.equal(ignoredExactConstraint.width % 16, 0);
  assert.ok(ignoredExactConstraint.scaleResolutionDownBy > 1);

  assert.deepEqual(standard1080, {
    width: 1920,
    height: 1080,
    scaleResolutionDownBy: 1,
    edgeGuardRequired: false,
  });
});

test("clips only incomplete legacy decoder rows as a compatibility guard", async () => {
  const { decoderEdgeGuardPixels } = await loadModule();
  assert.equal(decoderEdgeGuardPixels(1_920), 0);
  assert.equal(decoderEdgeGuardPixels(848), 0);
  assert.equal(decoderEdgeGuardPixels(854), 5);
  assert.equal(decoderEdgeGuardPixels(1_206), 5);
  assert.equal(decoderEdgeGuardPixels(Number.NaN), 0);
});

test("preserves ordinary aligned 720p rungs without needless quality loss", async () => {
  const { safeVideoEncodingTarget } = await loadModule();
  assert.deepEqual(safeVideoEncodingTarget(1920, 1080, 720), {
    width: 1280,
    height: 720,
    scaleResolutionDownBy: 1.5,
    edgeGuardRequired: false,
  });
  assert.deepEqual(safeVideoEncodingTarget(2560, 1600, 720), {
    width: 1152,
    height: 720,
    scaleResolutionDownBy: 2560 / 1152,
    edgeGuardRequired: false,
  });
});

test("returns no target when a complete decoder row cannot fit", async () => {
  const { physicalCaptureTarget } = await loadModule();
  assert.equal(
    physicalCaptureTarget(
      { width: 12, height: 12, screenPixelRatio: 1 },
      12,
      12,
    ),
    undefined,
  );
});

test("detects the measured Chrome F11 geometry transition but ignores resize noise", async () => {
  const {
    captureWindowGeometryChanged,
    normalizeCaptureWindowGeometry,
  } = await loadModule();
  const windowed = normalizeCaptureWindowGeometry({
    width: 1550,
    height: 1440,
    visible: true,
    minimized: false,
  });
  const fullscreen = normalizeCaptureWindowGeometry({
    width: 2412,
    height: 1440,
    visible: true,
    minimized: false,
  });
  assert.deepEqual(windowed, { width: 1550, height: 1440 });
  assert.deepEqual(fullscreen, { width: 2412, height: 1440 });
  assert.equal(captureWindowGeometryChanged(windowed, fullscreen), true);
  assert.equal(captureWindowGeometryChanged(fullscreen, windowed), true);
  assert.equal(
    captureWindowGeometryChanged(
      fullscreen,
      normalizeCaptureWindowGeometry({
        width: 2408,
        height: 1438,
        visible: true,
        minimized: false,
      }),
    ),
    false,
  );
  assert.equal(
    captureWindowGeometryChanged(
      { width: 1706, height: 1066 },
      { width: 1706, height: 1018 },
    ),
    false,
    "hiding a player control bar must not rebuild the capture track",
  );
});

test("does not treat hidden, minimized, or zero-size F11 transition frames as geometry", async () => {
  const { normalizeCaptureWindowGeometry } = await loadModule();
  assert.equal(
    normalizeCaptureWindowGeometry({
      width: 0,
      height: 0,
      visible: false,
      minimized: false,
    }),
    undefined,
  );
  assert.equal(
    normalizeCaptureWindowGeometry({
      width: 2412,
      height: 1440,
      visible: true,
      minimized: true,
    }),
    undefined,
  );
});
