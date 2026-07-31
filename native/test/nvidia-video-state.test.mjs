import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_CONFIRMATION_AGE_MS,
  parseNvidiaVsrState,
} = require("../electron/nvidia-video-state.cjs");

function stateBlock(timestamp, enabled, quality = 0) {
  return `${timestamp} INFO  nvapp/VideoService  VSR state fetched: {
\t"isSupported": true,
\t"isEnabled": ${enabled},
\t"quality": ${quality},
\t"isActive": false
}`;
}

test("uses only a recent complete NVIDIA App VSR confirmation", () => {
  const now = new Date("2026-07-31T12:00:00").getTime();
  const state = parseNvidiaVsrState(
    [
      stateBlock("2026-07-31 10:00:00.000", false),
      stateBlock("2026-07-31 11:59:00.000", true, 4),
    ].join("\n"),
    { now },
  );
  assert.equal(state.state, "enabled");
  assert.equal(state.enabled, true);
  assert.equal(state.quality, 4);
});

test("stale or incomplete NVIDIA state is unknown so GPU fallback remains active", () => {
  const now = new Date("2026-07-31T12:00:00").getTime();
  const stale = parseNvidiaVsrState(
    stateBlock("2026-07-29 11:59:00.000", true, 4),
    { now, maxAgeMs: DEFAULT_CONFIRMATION_AGE_MS },
  );
  assert.equal(stale.state, "unknown");
  assert.equal(
    parseNvidiaVsrState(
      '2026-07-31 11:59:00.000 INFO VSR state fetched: {"isEnabled":',
      { now },
    ).state,
    "unknown",
  );
});
