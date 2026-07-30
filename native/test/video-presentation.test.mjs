import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let presentationModulePromise;

async function loadPresentationModule() {
  if (!presentationModulePromise) {
    presentationModulePromise = build({
      entryPoints: [path.resolve("src/video-presentation.ts")],
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
  return presentationModulePromise;
}

function frameWithBars(width, height, topRows, bottomRows, content = 180) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const value =
      y < topRows || y >= height - bottomRows ? 0 : content;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

test("detects baked-in movie letterbox bars and measures both edges", async () => {
  const presentation = await loadPresentationModule();
  const bars = presentation.measureEmbeddedHorizontalBars(
    frameWithBars(128, 80, 13, 8),
  );
  assert.ok(bars);
  assert.equal(bars.topRatio, 13 / 80);
  assert.equal(bars.bottomRatio, 8 / 80);
});

test("does not crop an ordinary full-frame or fully black scene", async () => {
  const presentation = await loadPresentationModule();
  assert.equal(
    presentation.measureEmbeddedHorizontalBars(
      frameWithBars(128, 80, 0, 0),
    ),
    undefined,
  );
  assert.equal(
    presentation.measureEmbeddedHorizontalBars(
      frameWithBars(128, 80, 80, 0, 0),
    ),
    undefined,
  );
});

test("formats the real source size instead of the selected capture ceiling", async () => {
  const presentation = await loadPresentationModule();
  assert.equal(
    presentation.exactSourceLabel(2560, 1600, 23.7),
    "原画 2560×1600 · 24 帧",
  );
});

test("requires stable temporal bar measurements before cropping", async () => {
  const presentation = await loadPresentationModule();
  assert.deepEqual(
    presentation.stableEmbeddedHorizontalBars([
      { topRatio: 0.15, bottomRatio: 0.15 },
      { topRatio: 0.16, bottomRatio: 0.14 },
      { topRatio: 0.14, bottomRatio: 0.16 },
      { topRatio: 0.02, bottomRatio: 0.3 },
    ]),
    { topRatio: 0.15, bottomRatio: 0.15 },
  );
  assert.equal(
    presentation.stableEmbeddedHorizontalBars([
      { topRatio: 0.03, bottomRatio: 0.2 },
      { topRatio: 0.18, bottomRatio: 0.04 },
    ]),
    undefined,
  );
});

test("smart crop fills a landscape phone while staying exactly centered", async () => {
  const presentation = await loadPresentationModule();
  const crop = presentation.calculateCenteredSmartCrop({
    stageWidth: 2400,
    stageHeight: 1080,
    sourceWidth: 2560,
    sourceHeight: 1600,
    bars: { topRatio: 0.16, bottomRatio: 0.16 },
  });
  assert.ok(crop.scale > 1.38 && crop.scale < 1.4);
  assert.equal(crop.shiftY, 0);
});

test("smart crop preserves the smaller edge as a subtitle safety limit", async () => {
  const presentation = await loadPresentationModule();
  const crop = presentation.calculateCenteredSmartCrop({
    stageWidth: 2400,
    stageHeight: 1080,
    sourceWidth: 2560,
    sourceHeight: 1600,
    bars: { topRatio: 0.18, bottomRatio: 0.08 },
  });
  assert.ok(crop.scale > 1 && crop.scale < 1.2);
  assert.equal(crop.shiftY, 0);
});
