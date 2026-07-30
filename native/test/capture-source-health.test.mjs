import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const mainSource = readFileSync(
  new URL("../electron/main.cjs", import.meta.url),
  "utf8",
);
const globalTypes = readFileSync(
  new URL("../src/global.d.ts", import.meta.url),
  "utf8",
);

function namedFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${name}`);
}

const snapshotSource = namedFunctionSource(
  mainSource,
  "captureWindowHealthSnapshot",
);

function snapshot(overrides = {}) {
  const context = {
    latestCaptureWindow: {
      type: "window",
      captureId: 7,
      width: 1919.6,
      height: 1079.5,
      foreground: true,
      visible: true,
      minimized: false,
      ...overrides.latestCaptureWindow,
    },
    audioCaptureState: {
      captureId: 7,
      active: true,
      starting: false,
      sourceHandle: "process:2048",
      ...overrides.audioCaptureState,
    },
    audioCaptureProcess:
      overrides.audioCaptureProcess === undefined
        ? {}
        : overrides.audioCaptureProcess,
    selectedSource: {
      id: "window:abcd:0",
      windowHandle: "abcd",
      processId: 2048,
      ...overrides.selectedSource,
    },
    sourceHandle(sourceId) {
      return sourceId?.match(/^window:([^:]+):/)?.[1];
    },
  };
  return vm.runInNewContext(
    `${snapshotSource}; captureWindowHealthSnapshot()`,
    context,
  );
}

test("capture health exposes the current process-audio window state", () => {
  assert.deepEqual(
    { ...snapshot() },
    {
      width: 1920,
      height: 1080,
      foreground: true,
      visible: true,
      minimized: false,
    },
  );
  assert.match(
    mainSource,
    /const windowState = captureWindowHealthSnapshot\(\);[\s\S]{0,300}?\.\.\.\(windowState \|\| \{\}\)/,
  );
  for (const field of [
    "width",
    "height",
    "foreground",
    "visible",
    "minimized",
  ]) {
    assert.match(globalTypes, new RegExp(`\\b${field}\\?:`));
  }
});

test("stale, stopped, and source-mismatched window state is withheld", () => {
  assert.equal(
    snapshot({ latestCaptureWindow: { captureId: 6 } }),
    undefined,
  );
  assert.equal(
    snapshot({ audioCaptureState: { active: false, starting: false } }),
    undefined,
  );
  assert.equal(snapshot({ audioCaptureProcess: null }), undefined);
  assert.equal(
    snapshot({ audioCaptureState: { sourceHandle: "process:4096" } }),
    undefined,
  );
  assert.equal(
    snapshot({
      selectedSource: {
        id: "window:beef:0",
        processId: undefined,
        windowHandle: "beef",
      },
      audioCaptureState: { sourceHandle: "abcd" },
    }),
    undefined,
  );
});

test("window-handle capture is accepted without another desktop inspection", () => {
  assert.deepEqual(
    {
      ...snapshot({
        selectedSource: {
          id: "window:beef:0",
          processId: undefined,
          windowHandle: "beef",
        },
        audioCaptureState: { sourceHandle: "beef" },
      }),
    },
    {
      width: 1920,
      height: 1080,
      foreground: true,
      visible: true,
      minimized: false,
    },
  );
  assert.doesNotMatch(
    snapshotSource,
    /desktopCapturer|inspectWindowProcesses|inspectKnownMusicProcesses|PowerShell|spawn\(/,
  );
});
