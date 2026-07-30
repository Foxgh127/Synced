import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;
let transportModulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/emby-player.ts")],
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

async function loadTransportModule() {
  if (!transportModulePromise) {
    transportModulePromise = build({
      entryPoints: [path.resolve("src/emby-transport.ts")],
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
  return transportModulePromise;
}

test("converts SRT timing into appendable WebVTT", async () => {
  const { normalizeWebVtt } = await loadModule();
  const result = normalizeWebVtt(
    "1\n00:00:01,250 --> 00:00:03,500\n你好，世界\n",
  );
  assert.match(result, /^WEBVTT/);
  assert.match(result, /00:00:01\.250 --> 00:00:03\.500/);
  assert.match(result, /你好，世界/);
});

test("keeps numeric subtitle dialogue while removing only SRT cue indexes", async () => {
  const { normalizeWebVtt } = await loadModule();
  const result = normalizeWebVtt(
    "1\n00:00:01,000 --> 00:00:02,000\n1\n\n2\n00:00:03,000 --> 00:00:04,000\n第二条\n",
  );
  assert.match(result, /00:00:01\.000 --> 00:00:02\.000\n1/);
  assert.doesNotMatch(result, /\n2\n00:00:03/);
});

test("extracts ASS dialogue without burning subtitles into video", async () => {
  const { normalizeWebVtt } = await loadModule();
  const result = normalizeWebVtt(
    [
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:02.00,0:00:04.50,Default,,0,0,0,,{\\b1}第一行\\N第二行",
    ].join("\n"),
  );
  assert.match(result, /00:00:02\.000 --> 00:00:04\.500/);
  assert.match(result, /第一行\n第二行/);
  assert.match(result, /<b>第一行\n第二行<\/b>/);
  assert.doesNotMatch(result, /\\b1/);
});

test("preserves safe ASS emphasis, color, size, font, and alignment", async () => {
  const { normalizeWebVtt } = await loadModule();
  const result = normalizeWebVtt(
    [
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8\\fs28\\fnMicrosoft YaHei\\c&H00FF00&\\i1}保留样式",
    ].join("\n"),
  );
  assert.match(
    result,
    /line:10% position:50% align:center/,
  );
  assert.match(result, /::cue\(\.ass-color-00ff00\) \{ color: #00ff00; \}/);
  assert.match(result, /::cue\(\.ass-size-28\) \{ font-size: 28px; \}/);
  assert.match(result, /font-family: "Microsoft YaHei"/);
  assert.match(result, /<i><c\.[^>]+>保留样式<\/c><\/i>/);
  assert.doesNotMatch(result, /\\(?:an8|fs28|fnMicrosoft|c&H|i1)/);
});

test("converts TTML/DFXP cues and strips active cue markup", async () => {
  const { normalizeWebVtt } = await loadModule();
  const result = normalizeWebVtt(
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>',
      '<p begin="00:00:05.500" end="00:00:07.000">第一行<br/>第二行<script>alert(1)</script></p>',
      "</div></body></tt>",
    ].join(""),
  );
  assert.match(result, /00:00:05\.500 --> 00:00:07\.000/);
  assert.match(result, /第一行\n第二行alert\(1\)/);
  assert.doesNotMatch(result, /<script>/);
});

test("appends queued MSE bytes without sharing the caller buffer", async () => {
  const { EmbyMsePlayer } = await loadModule();
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    playbackRate: 1,
    buffered: {
      length: 0,
      start: () => 0,
      end: () => 0,
    },
  });
  const appended = [];
  const queuedBytes = [];
  const player = new EmbyMsePlayer({ video });
  player.addEventListener("appendqueuechange", (event) => {
    queuedBytes.push(event.detail.queuedBytes);
  });
  player.sourceBuffer = {
    updating: false,
    buffered: video.buffered,
    appendBuffer(data) {
      appended.push(new Uint8Array(data));
    },
  };
  const init = new Uint8Array([1, 2, 3, 4]);
  player.appendInit(init);
  init.fill(9);
  assert.deepEqual([...appended[0]], [1, 2, 3, 4]);
  assert.equal(player.queuedAppendBytes, 0);
  assert.deepEqual(
    queuedBytes,
    [4, 0],
    "queue observers see both enqueue and the real append-queue drain",
  );
});

test("repeated MSE quota failures have a terminal fragment path", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  globalThis.document ||= { getElementById: () => null };
  const video = Object.assign(new EventTarget(), {
    currentTime: 12,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    querySelectorAll: () => [],
    removeAttribute() {},
    load() {},
    pause() {},
    play: async () => {},
  });
  let aborts = 0;
  const player = new EmbyMsePlayer({
    video,
    host: false,
    initialBufferSeconds: 8,
    targetBufferSeconds: 40,
    maxBufferSeconds: 60,
  });
  player.session = {
    roomId: "ROOM",
    sessionId: "quota-session",
    mediaVersion: 1,
    transportEpoch: 0,
    mimeType: 'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.externalSegmentTransport = true;
  player.mediaSourceRecoveryAttempts = 1;
  player.sourceBuffer = {
    updating: false,
    buffered: video.buffered,
    abort() {
      aborts += 1;
    },
  };
  const fragment = Uint8Array.of(1, 2, 3, 4);
  player.appendQueue = [fragment];
  player.appendTimestampOffsets = [0];
  player.appendRetryCounts = [0];
  player.appendQueueBytes = fragment.byteLength;
  const recovery = new Promise((resolve) =>
    player.addEventListener("segmentrecoveryneeded", resolve, { once: true }),
  );

  player.recoverFromQuotaExceeded();
  player.recoverFromQuotaExceeded();
  player.recoverFromQuotaExceeded();
  player.recoverFromQuotaExceeded();
  await recovery;

  assert.equal(aborts, 1);
  assert.equal(player.appendQueue.length, 0);
  assert.equal(player.appendRetryCounts.length, 0);
  assert.equal(player.queuedAppendBytes, 0);
  assert.ok(player.targetBufferSeconds < 40);
  player.destroy();
});

test("applies repaired fragment time before MSE append", async () => {
  const { EmbyMsePlayer } = await loadModule();
  const video = Object.assign(new EventTarget(), {
    currentTime: 37,
    playbackRate: 1,
    buffered: {
      length: 0,
      start: () => 0,
      end: () => 0,
    },
  });
  const offsetsAtAppend = [];
  const player = new EmbyMsePlayer({ video, host: true });
  player.sourceBuffer = {
    updating: false,
    timestampOffset: 37,
    buffered: video.buffered,
    appendBuffer() {
      offsetsAtAppend.push(this.timestampOffset);
    },
  };

  player.appendQueue = [Uint8Array.of(1), Uint8Array.of(2)];
  player.appendTimestampOffsets = [-0.829, -39.424];
  player.pumpAppendQueue();
  player.appendBusy = false;
  player.pumpAppendQueue();

  assert.deepEqual(offsetsAtAppend, [-0.829, -39.424]);
  assert.equal(player.appendQueue.length, 0);
  assert.equal(player.appendTimestampOffsets.length, 0);
});

test("keeps fresh restarted fragments whose raw clock begins at zero", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  const video = Object.assign(new EventTarget(), {
    currentTime: 76,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    pause() {},
    play: async () => {},
  });
  const player = new EmbyMsePlayer({ video });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_restarted_clock",
    mediaVersion: 2,
    transportEpoch: 0,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.started = true;

  player.appendFragment({
    roomId: "ROOM",
    sessionId: "session_restarted_clock",
    mediaVersion: 2,
    transportEpoch: 0,
    sequence: 16,
    timestampMs: Date.now(),
    mediaTimeMs: 11_284,
    timelineTimeMs: 87_557,
    trackType: "muxed",
    keyframe: true,
    data: Uint8Array.of(16),
  });
  assert.equal(player.pendingMediaFragments.has(16), true);

  player.appendFragment({
    roomId: "ROOM",
    sessionId: "session_restarted_clock",
    mediaVersion: 2,
    transportEpoch: 0,
    sequence: 17,
    timestampMs: Date.now(),
    mediaTimeMs: 12_035,
    timelineTimeMs: 50_000,
    trackType: "muxed",
    keyframe: true,
    data: Uint8Array.of(17),
  });
  assert.equal(player.pendingMediaFragments.has(17), false);
});

test("uses the configured 8/24/32 second buffer policy", async () => {
  const { evaluateEmbyBufferPolicy } = await loadModule();
  assert.deepEqual(evaluateEmbyBufferPolicy(7.9, 0), {
    canStart: false,
    shouldTrim: false,
    pausedForFlow: false,
    urgent: true,
  });
  assert.equal(
    evaluateEmbyBufferPolicy(7.999999, 0).canStart,
    true,
    "fragment timestamp rounding must not deadlock an exact 8-second buffer",
  );
  assert.deepEqual(evaluateEmbyBufferPolicy(24, 31), {
    canStart: true,
    shouldTrim: true,
    pausedForFlow: false,
    urgent: false,
  });
  assert.deepEqual(evaluateEmbyBufferPolicy(32, 0), {
    canStart: true,
    shouldTrim: false,
    pausedForFlow: true,
    urgent: false,
  });
  assert.equal(evaluateEmbyBufferPolicy(32.01, 0).shouldTrim, true);
});

test("adaptive Emby buffering uses bitrate and device memory as a hard byte budget", async () => {
  const { planEmbyAdaptiveBufferProfile } = await loadModule();
  const ordinaryViewer = planEmbyAdaptiveBufferProfile({
    bitrate: 8_000_000,
    host: false,
    deviceMemoryGb: 4,
    initialSeconds: 10,
    targetSeconds: 52,
    maxSeconds: 72,
  });
  assert.deepEqual(
    {
      initial: ordinaryViewer.initialSeconds,
      target: ordinaryViewer.targetSeconds,
      maximum: ordinaryViewer.maxSeconds,
    },
    { initial: 10, target: 52, maximum: 72 },
  );

  const constrained4kViewer = planEmbyAdaptiveBufferProfile({
    bitrate: 100_000_000,
    host: false,
    deviceMemoryGb: 2,
    initialSeconds: 10,
    targetSeconds: 52,
    maxSeconds: 72,
  });
  assert.equal(constrained4kViewer.memoryBudgetBytes, 96 * 1024 * 1024);
  assert.deepEqual(
    {
      initial: constrained4kViewer.initialSeconds,
      target: constrained4kViewer.targetSeconds,
      maximum: constrained4kViewer.maxSeconds,
    },
    { initial: 4, target: 5, maximum: 6 },
  );
  assert.ok(
    constrained4kViewer.maxSeconds * 100_000_000 / 8 <=
      constrained4kViewer.memoryBudgetBytes,
    "the time target may shrink but cannot exceed its encoded-byte budget",
  );
});

test("a stream transition retains channels but rejects old-version media", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  let paused = false;
  const video = Object.assign(new EventTarget(), {
    currentTime: 21,
    playbackRate: 1,
    buffered: { length: 1, start: () => 0, end: () => 40 },
    pause() {
      paused = true;
    },
    play() {
      paused = false;
      return Promise.resolve();
    },
  });
  const player = new EmbyMsePlayer({ video, host: false });
  const mediaChannel = { id: "media" };
  const controlChannel = { id: "control" };
  player.channel = mediaChannel;
  player.controlChannel = controlChannel;
  player.session = {
    roomId: "ROOM",
    sessionId: "session_transition",
    mediaVersion: 4,
    transportEpoch: 2,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: { bitrate: 8_000_000 },
    title: "Fixture",
  };
  player.assembler = { reset() {} };
  player.appendQueue = [Uint8Array.of(1, 2, 3)];
  player.handleControlText(
    JSON.stringify({
      type: "stream-transition",
      sessionId: "session_transition",
      mediaVersion: 4,
      nextMediaVersion: 5,
      targetTime: 80,
    }),
  );
  assert.equal(paused, true);
  assert.equal(player.channel, mediaChannel);
  assert.equal(player.controlChannel, controlChannel);
  assert.equal(player.assembler, undefined);
  assert.equal(player.awaitingMediaVersion, 5);
  assert.equal(player.queuedAppendBytes, 0);

  player.appendFragment({
    roomId: "ROOM",
    sessionId: "session_transition",
    mediaVersion: 4,
    transportEpoch: 2,
    sequence: 9,
    timestampMs: Date.now(),
    mediaTimeMs: 22_000,
    trackType: "muxed",
    keyframe: true,
    data: Uint8Array.of(9),
  });
  assert.equal(player.pendingMediaFragments.size, 0);
  player.clearStreamTransitionTimer();
});

test("absorbs ordinary live drift before using a decoder-flushing seek", async () => {
  const { planEmbyPlaybackCorrection } = await loadModule();
  assert.deepEqual(planEmbyPlaybackCorrection(0.2, false, 1), {
    action: "rate",
    playbackRate: 1.008,
    restoreAfterMs: 2_000,
  });
  assert.deepEqual(planEmbyPlaybackCorrection(-0.2, false, 1), {
    action: "rate",
    playbackRate: 0.992,
    restoreAfterMs: 2_000,
  });
  assert.equal(
    planEmbyPlaybackCorrection(0.6, false, 1).action,
    "rate",
  );
  assert.equal(
    planEmbyPlaybackCorrection(1.81, false, 1).action,
    "seek",
  );
  assert.equal(
    planEmbyPlaybackCorrection(0.6, true, 1).action,
    "seek",
  );
  assert.equal(
    planEmbyPlaybackCorrection(0.2, true, 1).action,
    "none",
  );
});

test("startup state packets do not chase the advancing host clock", async () => {
  const { EmbyMsePlayer } = await loadModule();
  let currentTime = 100;
  let currentTimeWrites = 0;
  const video = Object.assign(new EventTarget(), {
    playbackRate: 1,
    buffered: {
      length: 1,
      start: () => 100,
      end: () => 105,
    },
    pause() {},
    play() {
      return Promise.resolve();
    },
  });
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => currentTime,
    set: (value) => {
      currentTimeWrites += 1;
      currentTime = value;
    },
  });
  const player = new EmbyMsePlayer({ video });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_startup_stable",
    mediaVersion: 1,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };

  for (let version = 1; version <= 4; version += 1) {
    player.handlePlaybackState({
      type: "playback-state",
      sessionId: "session_startup_stable",
      mediaVersion: 1,
      stateVersion: version,
      currentTime: 108 + version * 0.5,
      paused: false,
      playbackRate: 1,
      serverTimeMs: Date.now(),
    });
  }

  assert.equal(player.started, false);
  assert.equal(currentTimeWrites, 0);
});

test("an asynchronous Android startup anchor is not repeated every 500 ms", async () => {
  const { EmbyMsePlayer } = await loadModule();
  let currentTimeWrites = 0;
  const video = Object.assign(new EventTarget(), {
    playbackRate: 1,
    buffered: {
      length: 1,
      start: () => 100,
      end: () => 101,
    },
    pause() {},
    play() {
      return Promise.resolve();
    },
  });
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => 0,
    set: () => {
      currentTimeWrites += 1;
    },
  });
  const player = new EmbyMsePlayer({ video });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_anchor_cooldown",
    mediaVersion: 1,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.lastBufferReportAt = performance.now();

  player.inspectBuffer();
  player.inspectBuffer();

  assert.equal(currentTimeWrites, 1);
});

test("playing drift uses a 0.75 second hard-resync ceiling", async () => {
  const {
    EMBY_MAX_SYNC_DRIFT_SECONDS,
    shouldHardResyncEmbyPlayback,
  } = await loadModule();
  assert.equal(EMBY_MAX_SYNC_DRIFT_SECONDS, 0.75);
  assert.equal(shouldHardResyncEmbyPlayback(0.75, false), false);
  assert.equal(shouldHardResyncEmbyPlayback(0.76, false), true);
  assert.equal(shouldHardResyncEmbyPlayback(8, true), false);
  assert.equal(shouldHardResyncEmbyPlayback(-8, false), false);
});

test("SFU viewer recovery requests a local transport fallback without broadcasting catch-up", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  globalThis.document ||= { getElementById: () => null };
  const video = Object.assign(new EventTarget(), {
    autoplay: false,
    currentTime: 18,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    querySelectorAll: () => [],
    removeAttribute() {},
    load() {},
    pause() {},
    play: async () => {},
  });
  const sent = [];
  const player = new EmbyMsePlayer({
    video,
    recoveryStrategy: "transport-fallback",
  });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_sfu_isolated",
    mediaVersion: 2,
    transportEpoch: 1,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.controlChannel = {
    readyState: "open",
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const recoveries = [];
  player.addEventListener("recoveryneeded", (event) => {
    recoveries.push(event.detail);
  });

  player.requestCatchUp(18, "fragment-repair-exhausted");
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].reason, "fragment-repair-exhausted");
  assert.equal(
    sent.some((message) => message.type === "catch-up"),
    false,
  );
  player.destroy();
});

test("receiver catch-up requests back off under repeated weak-network stalls and reset after healthy buffering", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  globalThis.document ||= { getElementById: () => null };
  const video = Object.assign(new EventTarget(), {
    autoplay: false,
    currentTime: 5,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 40 },
    querySelectorAll: () => [],
    removeAttribute() {},
    load() {},
    pause() {
      this.paused = true;
    },
    async play() {
      this.paused = false;
    },
  });
  const sent = [];
  const player = new EmbyMsePlayer({ video });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_adaptive_catch_up",
    mediaVersion: 3,
    transportEpoch: 0,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: { bitrate: 8_000_000 },
    title: "Fixture",
  };
  player.controlChannel = {
    readyState: "open",
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  player.started = true;
  player.hostWantsPaused = false;

  player.requestCatchUp(18, "first-stall");
  player.requestCatchUp(19, "immediate-repeat");
  assert.equal(
    sent.filter(({ type }) => type === "catch-up").length,
    1,
  );
  assert.equal(player.catchUpCooldownMs, 2_400);

  player.lastCatchUpRequestAt =
    performance.now() - player.catchUpCooldownMs - 1;
  player.requestCatchUp(20, "later-stall");
  assert.equal(
    sent.filter(({ type }) => type === "catch-up").length,
    2,
  );
  assert.equal(player.catchUpCooldownMs, 4_800);

  for (let sample = 0; sample < 12; sample += 1) {
    player.inspectBuffer();
  }
  assert.equal(player.catchUpCooldownMs, 1_200);
  player.destroy();
});

test("a silently frozen SFU Emby transport falls back once without waiting for close", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.document = {
    visibilityState: "visible",
    getElementById: () => null,
  };
  const video = Object.assign(new EventTarget(), {
    autoplay: false,
    currentTime: 27,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    pause() {},
    play: async () => {},
  });
  const player = new EmbyMsePlayer({
    video,
    recoveryStrategy: "transport-fallback",
  });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_sfu_silent",
    mediaVersion: 4,
    transportEpoch: 2,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.lastInboundActivityAt = performance.now() - 16_000;
  const recoveries = [];
  player.addEventListener("recoveryneeded", (event) => {
    recoveries.push(event.detail);
  });

  player.inspectTransportLiveness();
  player.inspectTransportLiveness();

  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].reason, "transport-silent");
});

test("a resync envelope pauses stale playback and discards queued media", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  let paused = false;
  const video = Object.assign(new EventTarget(), {
    currentTime: 10,
    playbackRate: 1,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 20,
    },
    pause() {
      paused = true;
    },
    play() {
      paused = false;
      return Promise.resolve();
    },
  });
  const player = new EmbyMsePlayer({ video });
  let assemblerReset = false;
  player.session = {
    roomId: "ROOM",
    sessionId: "session_hard_resync",
    mediaVersion: 4,
    transportEpoch: 0,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.assembler = {
    reset() {
      assemblerReset = true;
    },
    advanceTransportEpoch() {
      return true;
    },
  };
  player.appendQueue = [Uint8Array.of(1), Uint8Array.of(2)];
  player.handleControlText(
    JSON.stringify({
      type: "resync",
      sessionId: "session_hard_resync",
      mediaVersion: 4,
      transportEpoch: 1,
      targetTime: 30,
    }),
  );
  assert.equal(paused, true);
  assert.equal(assemblerReset, true);
  assert.equal(player.queuedAppendBytes, 0);
  assert.equal(player.pendingCatchUpTarget, 30);
  if (player.initRequestTimer !== undefined) {
    clearTimeout(player.initRequestTimer);
  }
});

test("control parsing rejects null, arrays, and primitives without throwing", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    pause() {},
    play: async () => {},
  });
  const player = new EmbyMsePlayer({ video });
  for (const payload of ["null", "[]", "1", '"text"']) {
    assert.doesNotThrow(() => player.handleControlText(payload));
  }
  assert.equal(player.invalidPacketCount, 4);
});

test("seq2 before init still waits for a repaired seq1 before flushing", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    pause() {},
    play: async () => {},
  });
  const player = new EmbyMsePlayer({ video });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_init_barrier",
    mediaVersion: 1,
    transportEpoch: 0,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  const base = {
    roomId: "ROOM",
    sessionId: "session_init_barrier",
    mediaVersion: 1,
    transportEpoch: 0,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    trackType: "muxed",
    keyframe: true,
  };
  player.appendFragment({ ...base, sequence: 2, data: Uint8Array.of(2) });
  assert.equal(player.queuedAppendBytes, 0);
  assert.equal(player.pendingMediaFragments.size, 1);

  player.appendFragment({ ...base, sequence: 0, data: Uint8Array.of(0) });
  assert.deepEqual(player.appendQueue.map((data) => data[0]), [0]);
  await new Promise((resolve) => setTimeout(resolve, 850));
  player.appendFragment({ ...base, sequence: 1, data: Uint8Array.of(1) });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(
    player.appendQueue.map((data) => data[0]),
    [0, 1, 2],
  );
  assert.equal(player.pendingMediaFragments.size, 0);
});

test("reorder wait allows the previous fragment repair cycle to finish", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    pause() {},
    play: async () => {},
  });
  const player = new EmbyMsePlayer({ video });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_repair_order",
    mediaVersion: 1,
    transportEpoch: 0,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  const base = {
    roomId: "ROOM",
    sessionId: "session_repair_order",
    mediaVersion: 1,
    transportEpoch: 0,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    trackType: "muxed",
    keyframe: true,
  };
  player.appendFragment({ ...base, sequence: 0, data: Uint8Array.of(0) });
  player.appendQueue = [];
  player.appendFragment({ ...base, sequence: 2, data: Uint8Array.of(2) });
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.equal(player.queuedAppendBytes, 0);
  player.appendFragment({ ...base, sequence: 1, data: Uint8Array.of(1) });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(
    player.appendQueue.map((data) => data[0]),
    [1, 2],
  );
});

test("higher-epoch media may arrive before resync control without losing fresh fragments", async () => {
  const { EmbyMsePlayer } = await loadModule();
  const transport = await loadTransportModule();
  globalThis.window ||= globalThis;
  let paused = false;
  const video = Object.assign(new EventTarget(), {
    currentTime: 10,
    playbackRate: 1,
    buffered: { length: 1, start: () => 0, end: () => 60 },
    pause() {
      paused = true;
    },
    play() {
      paused = false;
      return Promise.resolve();
    },
  });
  const player = new EmbyMsePlayer({ video });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_media_first_epoch",
    mediaVersion: 2,
    transportEpoch: 0,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.appendQueue = [Uint8Array.of(99)];
  player.assembler = new transport.EmbyFragmentAssembler(
    {
      roomId: "ROOM",
      sessionId: "session_media_first_epoch",
      mediaVersion: 2,
      transportEpoch: 0,
    },
    (fragment) => player.appendFragment(fragment),
    () => {},
    (epoch) =>
      player.advanceTransportEpochFromMedia(
        "session_media_first_epoch",
        2,
        epoch,
      ),
  );
  const base = {
    roomId: "ROOM",
    sessionId: "session_media_first_epoch",
    mediaVersion: 2,
    transportEpoch: 1,
    timestampMs: Date.now(),
    mediaTimeMs: 30_000,
    trackType: "muxed",
    keyframe: true,
  };
  for (const { packet } of transport.chunkEmbyFragment({
    ...base,
    sequence: 1,
    data: Uint8Array.of(11),
  })) {
    player.assembler.accept(packet);
  }
  assert.equal(player.session.transportEpoch, 1);
  assert.equal(player.awaitingResyncEpoch, 1);
  assert.equal(player.syncHeld, true);
  assert.equal(paused, true);
  assert.equal(player.queuedAppendBytes, 0, "old append queue was discarded");

  for (const { packet } of transport.chunkEmbyFragment({
    ...base,
    sequence: 0,
    data: Uint8Array.of(10),
  })) {
    player.assembler.accept(packet);
  }
  assert.deepEqual(player.appendQueue.map((data) => data[0]), [10]);
  assert.equal(player.pendingMediaFragments.size, 1);

  player.handleControlText(JSON.stringify({
    type: "resync",
    sessionId: "session_media_first_epoch",
    mediaVersion: 2,
    transportEpoch: 1,
    targetTime: 30,
  }));
  assert.equal(player.awaitingResyncEpoch, undefined);
  assert.deepEqual(
    player.appendQueue.map((data) => data[0]),
    [10],
    "matching control must not clear media that already arrived in its epoch",
  );
  assert.equal(player.pendingMediaFragments.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.deepEqual(player.appendQueue.map((data) => data[0]), [10, 11]);
  const freshQueue = player.appendQueue.map((data) => data[0]);

  for (const { packet } of transport.chunkEmbyFragment({
    ...base,
    transportEpoch: 0,
    sequence: 1,
    data: Uint8Array.of(77),
  })) {
    player.assembler.accept(packet);
  }
  assert.deepEqual(player.appendQueue.map((data) => data[0]), freshQueue);
});

test("each resync epoch rearms an epoch-scoped init request", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    pause() {},
    play: async () => {},
  });
  const sent = [];
  const player = new EmbyMsePlayer({ video });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_epoch_init_request",
    mediaVersion: 4,
    transportEpoch: 0,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.assembler = {
    reset() {},
    advanceTransportEpoch() {
      return true;
    },
  };
  player.controlChannel = {
    readyState: "open",
    send(value) {
      sent.push(JSON.parse(value));
    },
  };
  player.handleControlText(JSON.stringify({
    type: "resync",
    sessionId: "session_epoch_init_request",
    mediaVersion: 4,
    transportEpoch: 1,
    targetTime: 12,
  }));
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.ok(
    sent.some(
      (message) =>
        message.type === "init-request" &&
        message.transportEpoch === 1,
    ),
  );
});

test("stream end waits for reorder-buffered tail media", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    pause() {},
    play: async () => {},
  });
  const player = new EmbyMsePlayer({ video });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_tail_reorder",
    mediaVersion: 1,
    transportEpoch: 0,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.appendFragment({
    roomId: "ROOM",
    sessionId: "session_tail_reorder",
    mediaVersion: 1,
    transportEpoch: 0,
    sequence: 0,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    trackType: "muxed",
    keyframe: true,
    data: Uint8Array.of(0),
  });
  player.appendQueue = [];
  player.appendFragment({
    roomId: "ROOM",
    sessionId: "session_tail_reorder",
    mediaVersion: 1,
    transportEpoch: 0,
    sequence: 2,
    timestampMs: Date.now(),
    mediaTimeMs: 750,
    trackType: "muxed",
    keyframe: false,
    data: Uint8Array.of(2),
  });
  let ended = 0;
  player.sourceBuffer = { updating: true };
  player.mediaSource = {
    readyState: "open",
    endOfStream() {
      ended += 1;
    },
  };
  player.markEnded();
  assert.equal(ended, 0);
  assert.equal(player.appendQueue.length, 0);
  assert.ok(player.mediaReorderTimer !== undefined);
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.deepEqual(player.appendQueue.map((data) => data[0]), [2]);
  assert.equal(player.mediaReorderTimer, undefined);
  player.sourceBuffer.updating = false;
  player.appendQueue = [];
  player.maybeEndStream();
  assert.equal(ended, 1);
  assert.equal(player.endRequested, false);
});

test("a completely lost media fragment is repaired before creating an MSE gap", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  const video = Object.assign(new EventTarget(), {
    currentTime: 20,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    pause() {},
    play: async () => {},
  });
  const player = new EmbyMsePlayer({ video, host: false });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_whole_fragment_repair",
    mediaVersion: 8,
    transportEpoch: 3,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.receivedInitKey = "session_whole_fragment_repair:8:3";
  player.nextMediaSequence = 22;
  const sent = [];
  player.controlChannel = {
    readyState: "open",
    send(value) {
      sent.push(JSON.parse(value));
    },
  };
  player.appendFragment({
    roomId: "ROOM",
    sessionId: "session_whole_fragment_repair",
    mediaVersion: 8,
    transportEpoch: 3,
    sequence: 23,
    timestampMs: Date.now(),
    mediaTimeMs: 21_000,
    trackType: "muxed",
    keyframe: false,
    data: Uint8Array.of(23),
  });

  player.flushPendingMedia(true);
  assert.equal(player.appendQueue.length, 0);
  assert.equal(player.nextMediaSequence, 22);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "need");
  assert.equal(sent[0].fragmentSeq, 22);
  assert.equal(sent[0].missing.length, 64);

  player.appendFragment({
    roomId: "ROOM",
    sessionId: "session_whole_fragment_repair",
    mediaVersion: 8,
    transportEpoch: 3,
    sequence: 22,
    timestampMs: Date.now(),
    mediaTimeMs: 20_250,
    trackType: "muxed",
    keyframe: false,
    data: Uint8Array.of(22),
  });
  assert.deepEqual(
    player.appendQueue.map((data) => data[0]),
    [22, 23],
    "the repaired predecessor is appended before the later fragment",
  );
  if (player.mediaReorderTimer !== undefined) {
    window.clearTimeout(player.mediaReorderTimer);
    player.mediaReorderTimer = undefined;
  }
});

test("external CMAF mode ignores RTC end boundaries from the host preview sequence space", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    pause() {},
    play: async () => {},
  });
  const player = new EmbyMsePlayer({ video });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_external_eos",
    mediaVersion: 8,
    transportEpoch: 0,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.externalSegmentTransport = true;
  player.handleControlText(
    JSON.stringify({
      type: "stream-ended",
      sessionId: "session_external_eos",
      mediaVersion: 8,
      transportEpoch: 0,
      finalFragmentSeq: 999,
      finalTrackType: "muxed",
    }),
  );
  assert.equal(player.endRequested, false);
  assert.equal(player.streamComplete, false);
});

test("EOS control arriving before its final muxed fragment cannot truncate playback", async () => {
  const { EmbyMsePlayer } = await loadModule();
  globalThis.window ||= globalThis;
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    pause() {},
    play: async () => {},
  });
  const player = new EmbyMsePlayer({ video });
  player.session = {
    roomId: "ROOM",
    sessionId: "session_eos_first",
    mediaVersion: 3,
    transportEpoch: 2,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  const base = {
    roomId: "ROOM",
    sessionId: "session_eos_first",
    mediaVersion: 3,
    transportEpoch: 2,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    trackType: "muxed",
    keyframe: true,
  };
  player.appendFragment({ ...base, sequence: 0, data: Uint8Array.of(10) });
  player.appendQueue = [];
  let ended = 0;
  player.sourceBuffer = { updating: true };
  let unrelatedAssemblyPending = true;
  player.assembler = {
    get hasPending() {
      return unrelatedAssemblyPending;
    },
    reset() {
      unrelatedAssemblyPending = false;
    },
  };
  player.mediaSource = {
    readyState: "open",
    endOfStream() {
      ended += 1;
    },
  };

  player.handleControlText(JSON.stringify({
    type: "stream-ended",
    sessionId: "session_eos_first",
    mediaVersion: 3,
    transportEpoch: 2,
    finalFragmentSeq: 1,
    finalTrackType: "muxed",
  }));
  assert.equal(ended, 0);
  assert.equal(player.endRequested, true);
  assert.equal(player.streamComplete, false);

  player.appendFragment({
    ...base,
    sequence: 1,
    mediaTimeMs: 750,
    data: Uint8Array.of(11),
  });
  assert.equal(ended, 0);
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.deepEqual(player.appendQueue.map((data) => data[0]), [11]);
  assert.equal(player.lastDeliveredMediaSequence, 1);
  assert.equal(player.streamComplete, true);
  assert.equal(
    unrelatedAssemblyPending,
    false,
    "final muxed delivery clears unrelated partial assembly",
  );
  assert.equal(ended, 0);

  player.sourceBuffer.updating = false;
  player.appendQueue = [];
  player.maybeEndStream();
  assert.equal(ended, 1);
  assert.equal(player.endRequested, false);
});

test("an unbuffered playback-state drift above 1.8 seconds enters hard catch-up", async () => {
  const { EmbyMsePlayer } = await loadModule();
  let paused = false;
  const video = Object.assign(new EventTarget(), {
    currentTime: 10,
    playbackRate: 1,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 11,
    },
    pause() {
      paused = true;
    },
    play() {
      paused = false;
      return Promise.resolve();
    },
  });
  const player = new EmbyMsePlayer({ video });
  player.started = true;
  player.session = {
    roomId: "ROOM",
    sessionId: "session_state_resync",
    mediaVersion: 2,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    plan: {},
    title: "Fixture",
  };
  player.appendQueue = [Uint8Array.of(1, 2, 3)];
  player.handlePlaybackState({
    type: "playback-state",
    sessionId: "session_state_resync",
    mediaVersion: 2,
    stateVersion: 1,
    currentTime: 11.9,
    paused: false,
    playbackRate: 1,
    serverTimeMs: Date.now(),
  });
  assert.equal(paused, true);
  assert.equal(player.queuedAppendBytes, 0);
  assert.ok(player.pendingCatchUpTarget >= 11.89);
});

test("throttles buffer reports to one every 500 ms", async () => {
  const { shouldReportEmbyBuffer } = await loadModule();
  assert.equal(shouldReportEmbyBuffer(1_000, 1_499), false);
  assert.equal(shouldReportEmbyBuffer(1_000, 1_500), true);
});
