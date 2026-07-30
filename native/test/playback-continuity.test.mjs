import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/playback-continuity.ts")],
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

test("keeps a healthy decoded watcher through signaling reconnection", async () => {
  const { shouldPreserveActiveWatcher } = await loadModule();
  assert.equal(
    shouldPreserveActiveWatcher({
      rejoined: true,
      previousSelfId: "viewer",
      nextSelfId: "viewer",
      previousBroadcasterId: "host",
      nextBroadcasterId: "host",
      peerState: "connected",
      hasDecodedFrame: true,
    }),
    true,
  );
});

test("replaces only a failed, undecoded, or identity-changed watcher", async () => {
  const { shouldPreserveActiveWatcher } = await loadModule();
  const healthy = {
    rejoined: true,
    previousSelfId: "viewer",
    nextSelfId: "viewer",
    previousBroadcasterId: "host",
    nextBroadcasterId: "host",
    peerState: "connected",
    hasDecodedFrame: true,
  };
  assert.equal(
    shouldPreserveActiveWatcher({ ...healthy, peerState: "failed" }),
    false,
  );
  assert.equal(
    shouldPreserveActiveWatcher({ ...healthy, hasDecodedFrame: false }),
    false,
  );
  assert.equal(
    shouldPreserveActiveWatcher({ ...healthy, nextSelfId: "new-viewer" }),
    false,
  );
});

test("repairs a connected screen stream with no RTP or decoded-frame progress", async () => {
  const { playbackRecoveryAction } = await loadModule();
  // transportAge = 30 000 ms >= 25 000 ms threshold → stalled
  const stalled = {
    mode: "screen",
    now: 40_000,
    peerState: "connected",
    transportProgressAt: 10_000,
    presentationProgressAt: 10_000,
  };
  assert.equal(playbackRecoveryAction(stalled), "repair");
  // now - recoveryStartedAt = 21 000 ms >= 20 000 ms → replace
  assert.equal(
    playbackRecoveryAction({ ...stalled, recoveryStartedAt: 19_000 }),
    "replace",
  );
  assert.equal(
    playbackRecoveryAction({
      ...stalled,
      transportProgressAt: 39_500,
      presentationProgressAt: 39_500,
    }),
    "none",
  );
});

test("lets Emby drain a healthy buffer but repairs a starved stalled player", async () => {
  const { playbackRecoveryAction } = await loadModule();
  const base = {
    mode: "emby",
    now: 30_000,
    peerState: "connected",
    transportProgressAt: 10_000,
    presentationProgressAt: 10_000,
  };
  assert.equal(
    playbackRecoveryAction({
      ...base,
      presentationProgressAt: 29_500,
      bufferedAhead: 18,
    }),
    "none",
  );
  assert.equal(
    playbackRecoveryAction({ ...base, bufferedAhead: 0.5 }),
    "repair",
  );
  assert.equal(
    playbackRecoveryAction({
      ...base,
      transportProgressAt: 29_500,
      bufferedAhead: 18,
    }),
    "repair",
    "fresh bytes and a large buffer must not hide a frozen decoder",
  );
  assert.equal(
    playbackRecoveryAction({ ...base, bufferedAhead: 0, hostPaused: true }),
    "none",
  );
});

test("decoder-only Emby repair does not restart a healthy flowing ICE route", async () => {
  const { shouldRestartIceForPlaybackRepair } = await loadModule();
  const flowingEmby = {
    mode: "emby",
    now: 30_000,
    peerState: "connected",
    transportProgressAt: 29_950,
  };
  assert.equal(
    shouldRestartIceForPlaybackRepair(flowingEmby),
    false,
  );
  assert.equal(
    shouldRestartIceForPlaybackRepair({
      ...flowingEmby,
      transportProgressAt: 19_000,
    }),
    true,
  );
  assert.equal(
    shouldRestartIceForPlaybackRepair({
      ...flowingEmby,
      mode: "screen",
    }),
    true,
  );
});

test("Emby liveness uses decoded frames instead of a jittering media clock", async () => {
  const { embyPresentationProgressed } = await loadModule();
  assert.equal(
    embyPresentationProgressed({
      frameCounterAvailable: true,
      previousFrames: 420,
      currentFrames: 420,
      previousTime: 123.04,
      currentTime: 123.11,
    }),
    false,
  );
  assert.equal(
    embyPresentationProgressed({
      frameCounterAvailable: true,
      previousFrames: 420,
      currentFrames: 421,
      previousTime: 123.11,
      currentTime: 123.11,
    }),
    true,
  );
  assert.equal(
    embyPresentationProgressed({
      frameCounterAvailable: false,
      previousFrames: 0,
      currentFrames: 0,
      previousTime: 10,
      currentTime: 10.2,
    }),
    true,
    "older browsers without frame counters retain a conservative clock fallback",
  );
});

test("periodic playback-state sync cannot refresh the Emby liveness clock", async () => {
  const { embyPauseStateChanged } = await loadModule();
  assert.equal(
    embyPauseStateChanged({
      known: false,
      previousPaused: false,
      nextPaused: false,
    }),
    true,
  );
  assert.equal(
    embyPauseStateChanged({
      known: true,
      previousPaused: false,
      nextPaused: false,
    }),
    false,
  );
  assert.equal(
    embyPauseStateChanged({
      known: true,
      previousPaused: false,
      nextPaused: true,
    }),
    true,
  );
});

test("does not cancel decoder replacement just because bytes still arrive", async () => {
  const {
    playbackRecoveryAction,
    playbackRecoveryCompleted,
  } = await loadModule();
  const frozenDecoder = {
    mode: "screen",
    now: 56_000,
    peerState: "connected",
    transportProgressAt: 55_500,    // fresh bytes; presentationAge = 46 000 ms triggers stall
    presentationProgressAt: 10_000,
    recoveryStartedAt: 35_000,      // now − recoveryStartedAt = 21 000 ms ≥ 20 000 ms → replace
  };
  assert.equal(playbackRecoveryCompleted(frozenDecoder), false);
  assert.equal(playbackRecoveryAction(frozenDecoder), "replace");
  assert.equal(
    playbackRecoveryCompleted({
      ...frozenDecoder,
      presentationProgressAt: 36_000,
    }),
    true,
  );
});

test("Emby recovery needs rendered progress and either fresh data or usable buffer", async () => {
  const { playbackRecoveryCompleted } = await loadModule();
  const base = {
    mode: "emby",
    now: 30_000,
    peerState: "connected",
    transportProgressAt: 20_000,
    presentationProgressAt: 20_000,
    recoveryStartedAt: 21_000,
    bufferedAhead: 0.4,
  };
  assert.equal(playbackRecoveryCompleted(base), false);
  assert.equal(
    playbackRecoveryCompleted({
      ...base,
      presentationProgressAt: 29_000,
      bufferedAhead: 8,
    }),
    true,
  );
});

test("route recommendations never replace decoded media", async () => {
  const { shouldReplaceWatcherForRouteAdvice } = await loadModule();
  assert.equal(
    shouldReplaceWatcherForRouteAdvice({
      peerState: "connected",
      hasDecodedFrame: true,
    }),
    false,
  );
  assert.equal(
    shouldReplaceWatcherForRouteAdvice({
      peerState: "failed",
      hasDecodedFrame: false,
    }),
    true,
  );
});
