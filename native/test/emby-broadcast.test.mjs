import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/emby-broadcast.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      plugins: [
        {
          name: "stub-emby-player",
          setup(buildApi) {
            buildApi.onResolve(
              { filter: /^\.\/emby-player$/ },
              () => ({ path: "emby-player", namespace: "test-stub" }),
            );
            buildApi.onLoad(
              { filter: /.*/, namespace: "test-stub" },
              () => ({
                loader: "js",
                contents: `
                  export class EmbyMsePlayer extends EventTarget {
                    constructor(options) {
                      super();
                      this.video = options.video;
                      this.queuedAppendBytes = 0;
                      this.bufferedAhead = 0;
                      this.configured = [];
                      this.initSegments = [];
                      this.fragments = [];
                      this.diagnostics = {
                        mediaSourceState: "open",
                        sourceBufferAttached: true,
                        sourceBufferUpdating: false,
                        appendBusy: false,
                        appendQueueItems: 0,
                        appendQueueBytes: 0,
                        pendingMediaItems: 0,
                        pendingMediaBytes: 0,
                        readyState: 0,
                        networkState: 2,
                        mediaErrorCode: 0,
                        videoWidth: 0,
                        videoHeight: 0,
                        bufferedRanges: 0,
                        bufferedAhead: 0,
                      };
                      globalThis.__embyBroadcastTestPlayers.push(this);
                    }
                    configure(session) { this.configured.push(session); }
                    appendInit(data) { this.initSegments.push(data); }
                    appendFragment(fragment) { this.fragments.push(fragment); }
                    setQueuedAppendBytes(bytes) {
                      this.queuedAppendBytes = bytes;
                      this.dispatchEvent(new CustomEvent("appendqueuechange", {
                        detail: { queuedBytes: bytes },
                      }));
                    }
                    applySubtitle() {}
                    markEnded() {}
                    destroy() {}
                  }
                `,
              }),
            );
          },
        },
      ],
    }).then(({ outputFiles }) =>
      import(
        `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
      ),
    );
  }
  return modulePromise;
}

class FakeVideo extends EventTarget {
  muted = false;
  volume = 1;
  currentTime = 0;
  paused = true;
  playCalls = 0;
  playError = undefined;
  playbackRate = 1;
  readyState = 4;
  buffered = {
    length: 0,
    start: () => 0,
    end: () => 0,
  };

  play() {
    this.playCalls += 1;
    if (this.playError) return Promise.reject(this.playError);
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
}

class FakeDocument extends EventTarget {
  visibilityState = "visible";
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function plan(itemId, startTimeTicks = 0) {
  return {
    itemId,
    mediaSourceId: `source-${itemId}`,
    playSessionId: `session-${itemId}`,
    method: "LocalRemux",
    quality: {
      label: "原画",
      maxBitrate: 8_000_000,
      maxHeight: 1080,
    },
    video: {},
    audio: {},
    videoCodec: "h264",
    audioCodec: "aac",
    localAudioTranscode: false,
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrate: 8_000_000,
    runtimeTicks: 600_000_000,
    startTimeTicks,
  };
}

function createHarness(startResults, options = {}) {
  globalThis.window = globalThis;
  globalThis.document = new FakeDocument();
  globalThis.__embyBroadcastTestPlayers = [];
  let streamListener;
  const flowChanges = [];
  const stopped = [];
  const readyDetails = [];
  const startRequests = [];
  const diagnostics = [];
  const reportCalls = [];
  const bridge = {
    onEmbyStreamEvent(callback) {
      streamListener = callback;
      return () => {
        streamListener = undefined;
      };
    },
    embyStartStream(request) {
      startRequests.push({ ...request });
      const next = startResults.shift();
      assert.ok(next, "test must provide a deferred start result");
      return next.promise;
    },
    async embyStopStream(reason) {
      stopped.push(reason);
      await options.stopGate?.promise;
    },
    async embySetFlowPaused(paused) {
      flowChanges.push(paused);
      if (bridge.failNextFlowChange) {
        bridge.failNextFlowChange = false;
        throw new Error("temporary IPC flow-control failure");
      }
    },
    async embyReportPlayback(request) {
      reportCalls.push({ ...request });
      await options.reportGate?.promise;
    },
    async embyLogout() {},
    reportDiagnostic(event, detail) {
      diagnostics.push({ event, detail });
    },
  };
  window.roomDesktop = bridge;
  return {
    bridge,
    video: new FakeVideo(),
    flowChanges,
    stopped,
    readyDetails,
    startRequests,
    diagnostics,
    reportCalls,
    emit(event) {
      assert.ok(streamListener, "stream listener must be installed");
      streamListener(event);
    },
  };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("start replays only early events matching the returned pipeline id", async () => {
  const { EmbyBroadcastController } = await loadModule();
  const startResult = deferred();
  const harness = createHarness([startResult]);
  const currentPlan = plan("current");
  const stalePlan = plan("stale");
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: (detail) => harness.readyDetails.push(detail),
  });

  const starting = controller.start({ itemId: "current" }, "Current title");
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-stale",
    plan: stalePlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(1),
  });
  harness.emit({
    type: "started",
    pipelineId: "pipeline-current",
    plan: currentPlan,
  });
  harness.emit({
    type: "init",
    pipelineId: "pipeline-current",
    plan: currentPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(2),
  });
  harness.emit({
    type: "fragment",
    pipelineId: "pipeline-current",
    sequence: 1,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    keyframe: true,
    data: Uint8Array.of(3),
  });
  startResult.resolve({
    pipelineId: "pipeline-current",
    plan: currentPlan,
  });

  const detail = await starting;
  const player = globalThis.__embyBroadcastTestPlayers[0];
  assert.equal(detail.plan.itemId, "current");
  assert.equal(player.configured.length, 1);
  assert.equal(player.configured[0].plan.itemId, "current");
  assert.deepEqual([...player.initSegments[0]], [2]);
  assert.deepEqual(
    player.fragments.map((fragment) => fragment.sequence),
    [1],
  );
  assert.equal(harness.readyDetails.length, 1);

  harness.emit({
    type: "init",
    pipelineId: "pipeline-stale",
    plan: stalePlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(4),
  });
  harness.emit({
    type: "fragment",
    pipelineId: "pipeline-stale",
    sequence: 99,
    timestampMs: Date.now(),
    mediaTimeMs: 99_000,
    keyframe: true,
    data: Uint8Array.of(5),
  });
  assert.equal(player.configured.length, 1);
  assert.deepEqual(
    player.fragments.map((fragment) => fragment.sequence),
    [1],
  );
  await controller.destroy();
});

test("shared Emby quality and frame rate restart the pipeline once", async () => {
  const { EmbyBroadcastController } = await loadModule();
  const harness = createHarness([]);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  controller.activeRequest = {
    itemId: "profile-switch",
    quality: "480p-2.5",
    frameRate: 24,
  };
  controller.pipelineId = "pipeline-profile-switch";
  controller.plan = plan("profile-switch");
  controller.mimeType =
    'video/mp4; codecs="avc1.640028,mp4a.40.2"';
  const restarts = [];
  controller.restartAt = async (currentTime, message) => {
    restarts.push({ currentTime, message });
  };

  assert.equal(
    await controller.setPlaybackProfile(
      { quality: "1080p-12", frameRate: 60 },
      "viewer preference",
    ),
    true,
  );
  assert.equal(controller.currentRequest?.quality, "1080p-12");
  assert.equal(controller.currentRequest?.frameRate, 60);
  assert.equal(restarts.length, 1);
  assert.match(restarts[0].message, /1080p-12 · 60 帧/u);
  assert.equal(
    await controller.setPlaybackProfile({
      quality: "1080p-12",
      frameRate: 60,
    }),
    false,
  );
  assert.equal(restarts.length, 1);

  await controller.destroy();
});

test("a startup quality request preserves the requested resume position", async () => {
  const { EmbyBroadcastController } = await loadModule();
  const harness = createHarness([]);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  controller.activeRequest = {
    itemId: "startup-profile-switch",
    quality: "original",
    startTimeTicks: 970_000_000,
  };
  controller.pipelineId = "pipeline-startup-profile-switch";
  controller.plan = plan("startup-profile-switch", 970_000_000);
  controller.mimeType =
    'video/mp4; codecs="avc1.640028,mp4a.40.2"';
  controller.localReady = false;
  harness.video.currentTime = 0;
  const restarts = [];
  controller.restartAt = async (currentTime) => {
    restarts.push(currentTime);
  };

  assert.equal(await controller.setQuality("480p-2.5"), true);
  assert.deepEqual(restarts, [97]);

  await controller.destroy();
});

test("a rapid pipeline replacement ignores the previous pipeline's late init", async () => {
  const { EmbyBroadcastController } = await loadModule();
  const firstResult = deferred();
  const secondResult = deferred();
  const harness = createHarness([firstResult, secondResult]);
  const firstPlan = plan("first");
  const secondPlan = plan("second", 120_000_000);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: (detail) => harness.readyDetails.push(detail),
  });

  const firstStart = controller.start({ itemId: "first" }, "First");
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-first",
    plan: firstPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(1),
  });
  firstResult.resolve({ pipelineId: "pipeline-first", plan: firstPlan });
  await firstStart;

  const secondStart = controller.start(
    { itemId: "second", startTimeTicks: 120_000_000 },
    "Second",
  );
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-first",
    plan: firstPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(2),
  });
  harness.emit({
    type: "init",
    pipelineId: "pipeline-second",
    plan: secondPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(3),
  });
  secondResult.resolve({ pipelineId: "pipeline-second", plan: secondPlan });
  await secondStart;

  const player = globalThis.__embyBroadcastTestPlayers[0];
  assert.deepEqual(
    player.configured.map((session) => session.plan.itemId),
    ["first", "second"],
  );
  assert.deepEqual(
    player.initSegments.map((data) => [...data]),
    [[1], [3]],
  );
  assert.deepEqual(
    harness.readyDetails.map((detail) => detail.plan.itemId),
    ["first", "second"],
  );
  await controller.destroy();
});

test("replacement rejects old events while IPC stop is still pending", async () => {
  const { EmbyBroadcastController } = await loadModule();
  const firstResult = deferred();
  const secondResult = deferred();
  const stopGate = deferred();
  const harness = createHarness(
    [firstResult, secondResult],
    { stopGate },
  );
  const firstPlan = plan("first-pending");
  const secondPlan = plan("second-current", 90_000_000);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: (detail) => harness.readyDetails.push(detail),
  });

  const firstStart = controller
    .start({ itemId: "first-pending" }, "First pending")
    .catch((error) => error);
  await nextTurn();
  firstResult.resolve({
    pipelineId: "pipeline-first-pending",
    plan: firstPlan,
  });
  await nextTurn();

  const secondStart = controller.start(
    { itemId: "second-current", startTimeTicks: 90_000_000 },
    "Second current",
  );
  await nextTurn();
  assert.match((await firstStart).message, /取消/);
  assert.deepEqual(harness.stopped, ["replaced"]);

  harness.emit({
    type: "init",
    pipelineId: "pipeline-first-pending",
    plan: firstPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(1),
  });
  harness.emit({
    type: "fragment",
    pipelineId: "pipeline-first-pending",
    sequence: 1,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    keyframe: true,
    data: Uint8Array.of(2),
  });
  const player = globalThis.__embyBroadcastTestPlayers[0];
  assert.equal(player.configured.length, 0);
  assert.equal(player.fragments.length, 0);
  assert.equal(harness.readyDetails.length, 0);

  stopGate.resolve();
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-second-current",
    plan: secondPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(3),
  });
  secondResult.resolve({
    pipelineId: "pipeline-second-current",
    plan: secondPlan,
  });
  const detail = await secondStart;

  assert.equal(detail.plan.itemId, "second-current");
  assert.deepEqual(
    player.configured.map((session) => session.plan.itemId),
    ["second-current"],
  );
  assert.deepEqual(
    player.initSegments.map((data) => [...data]),
    [[3]],
  );
  assert.deepEqual(
    harness.readyDetails.map((ready) => ready.plan.itemId),
    ["second-current"],
  );
  await controller.destroy();
});

test("an initial stream error retries once after teardown and preserves playback selections", async () => {
  const { EmbyBroadcastController } = await loadModule();
  const startResult = deferred();
  const fallbackResult = deferred();
  const stopGate = deferred();
  const harness = createHarness([startResult, fallbackResult], { stopGate });
  const currentPlan = plan("initial-error");
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  const request = {
    accountId: "account-preserved",
    itemId: "initial-error",
    mediaSourceId: "media-source-preserved",
    quality: "4k-18",
    startTimeTicks: 918_273_645,
    audioStreamIndex: 7,
    subtitleStreamIndex: 13,
    allowHevc: true,
  };

  const starting = controller.start(request, "Initial error");
  await nextTurn();
  startResult.resolve({
    pipelineId: "pipeline-initial-error",
    plan: currentPlan,
  });
  await nextTurn();
  harness.emit({
    type: "error",
    pipelineId: "pipeline-initial-error",
    message: "fixture init failure",
  });

  await nextTurn();
  assert.equal(harness.startRequests.length, 1);
  assert.deepEqual(harness.stopped, ["start-compatibility-retry"]);
  stopGate.resolve();
  await nextTurn();
  assert.equal(harness.startRequests.length, 2);
  assert.deepEqual(harness.startRequests[1], {
    ...request,
    quality: "1080p-12",
    allowHevc: false,
    forceVideoTranscode: true,
  });

  const fallbackPlan = {
    ...currentPlan,
    method: "Transcode",
    startTimeTicks: request.startTimeTicks,
  };
  fallbackResult.resolve({
    pipelineId: "pipeline-initial-error-fallback",
    plan: fallbackPlan,
  });
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-initial-error-fallback",
    plan: fallbackPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(1),
  });
  const detail = await starting;

  assert.equal(detail.title, "Initial error");
  assert.equal(controller.currentRequest?.audioStreamIndex, 7);
  assert.equal(controller.currentRequest?.subtitleStreamIndex, 13);
  assert.equal(
    controller.currentRequest?.startTimeTicks,
    request.startTimeTicks,
  );
  assert.equal(controller.autoRecoveryTimer, undefined);
  await controller.destroy();
});

test("a second pre-init failure is returned without a recursive retry", async () => {
  const { EmbyBroadcastController } = await loadModule();
  const startResult = deferred();
  const fallbackResult = deferred();
  const harness = createHarness([startResult, fallbackResult]);
  const currentPlan = plan("double-error");
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });

  const starting = controller.start(
    {
      itemId: "double-error",
      quality: "1080p-8",
      audioStreamIndex: 2,
      subtitleStreamIndex: 4,
      startTimeTicks: 123_000_000,
    },
    "Double error",
  );
  await nextTurn();
  startResult.resolve({
    pipelineId: "pipeline-double-error",
    plan: currentPlan,
  });
  await nextTurn();
  harness.emit({
    type: "error",
    pipelineId: "pipeline-double-error",
    message: "first init failure",
  });
  await nextTurn();
  assert.equal(harness.startRequests.length, 2);
  fallbackResult.resolve({
    pipelineId: "pipeline-double-error-fallback",
    plan: currentPlan,
  });
  await nextTurn();
  harness.emit({
    type: "error",
    pipelineId: "pipeline-double-error-fallback",
    message: "fallback init failure",
  });

  await assert.rejects(starting, /fallback init failure/u);
  await nextTurn();
  assert.equal(harness.startRequests.length, 2);
  assert.equal(harness.startRequests[1].quality, "1080p-8");
  assert.equal(harness.startRequests[1].audioStreamIndex, 2);
  assert.equal(harness.startRequests[1].subtitleStreamIndex, 4);
  assert.equal(harness.startRequests[1].startTimeTicks, 123_000_000);
  assert.deepEqual(harness.stopped, [
    "start-compatibility-retry",
    "start-fallback-error",
  ]);
  assert.equal(controller.autoRecoveryTimer, undefined);
  await controller.destroy();
});

test("a 30-second pre-init timeout performs the same one-shot compatibility fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { EmbyBroadcastController } = await loadModule();
  const startResult = deferred();
  const fallbackResult = deferred();
  const harness = createHarness([startResult, fallbackResult]);
  const currentPlan = plan("timeout-fallback", 456_000_000);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());

  const starting = controller.start(
    {
      accountId: "timeout-account",
      itemId: "timeout-fallback",
      mediaSourceId: "timeout-source",
      quality: "original",
      startTimeTicks: 456_000_000,
      audioStreamIndex: 5,
      subtitleStreamIndex: 8,
      allowHevc: true,
    },
    "Timeout fallback",
  );
  await nextTurn();
  // Keep the first IPC invoke unresolved: the 30-second pending-init deadline
  // must still tear the possible server pipeline down and enter the fallback.
  t.mock.timers.tick(30_000);
  await nextTurn();

  assert.equal(harness.startRequests.length, 2);
  assert.equal(harness.startRequests[1].quality, "1080p-12");
  assert.equal(harness.startRequests[1].allowHevc, false);
  assert.equal(harness.startRequests[1].forceVideoTranscode, true);
  assert.equal(harness.startRequests[1].startTimeTicks, 456_000_000);
  assert.deepEqual(harness.stopped, ["start-compatibility-retry"]);

  const fallbackPlan = {
    ...currentPlan,
    method: "Transcode",
  };
  fallbackResult.resolve({
    pipelineId: "pipeline-timeout-fallback",
    plan: fallbackPlan,
  });
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-timeout-fallback",
    plan: fallbackPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(9),
  });
  const detail = await starting;
  assert.equal(detail.title, "Timeout fallback");
  assert.equal(harness.startRequests.length, 2);
});

test("a slow playback plan receives a fresh 30-second init window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { EmbyBroadcastController } = await loadModule();
  const startResult = deferred();
  const harness = createHarness([startResult]);
  const currentPlan = plan("slow-plan");
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());

  const starting = controller.start(
    { itemId: "slow-plan", quality: "1080p-8" },
    "Slow plan",
  );
  await nextTurn();
  t.mock.timers.tick(25_000);
  startResult.resolve({
    pipelineId: "pipeline-slow-plan",
    plan: currentPlan,
  });
  await nextTurn();

  // This crosses the original end-to-end 30-second mark, but remains well
  // inside the fresh init deadline armed after the main process created the
  // pipeline.
  t.mock.timers.tick(6_000);
  await nextTurn();
  assert.equal(harness.startRequests.length, 1);
  assert.deepEqual(harness.stopped, []);
  harness.emit({
    type: "init",
    pipelineId: "pipeline-slow-plan",
    plan: currentPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(4),
  });
  const detail = await starting;
  assert.equal(detail.plan.itemId, "slow-plan");
});

test("a local MSE rejection retries once with browser-safe H.264 transcoding", async (t) => {
  const { EmbyBroadcastController } = await loadModule();
  const firstResult = deferred();
  const fallbackResult = deferred();
  const harness = createHarness([firstResult, fallbackResult]);
  const resumeTicks = 900_000_000;
  const currentPlan = plan("mse-fallback", resumeTicks);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());

  const starting = controller.start(
    {
      itemId: "mse-fallback",
      quality: "original",
      allowHevc: true,
      startTimeTicks: resumeTicks,
    },
    "Fallback",
  );
  await nextTurn();
  firstResult.resolve({
    pipelineId: "pipeline-mse-original",
    plan: currentPlan,
  });
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-mse-original",
    plan: currentPlan,
    mimeType: 'video/mp4; codecs="avc1.6E0028,mp4a.40.2"',
    data: Uint8Array.of(1),
  });
  await starting;

  globalThis.__embyBroadcastTestPlayers[0].dispatchEvent(
    new CustomEvent("error", { detail: "unsupported profile" }),
  );
  const deadline = Date.now() + 2_500;
  while (harness.startRequests.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(harness.startRequests.length, 2);
  assert.equal(harness.startRequests[1].forceVideoTranscode, true);
  assert.equal(harness.startRequests[1].allowHevc, false);
  assert.equal(harness.startRequests[1].startTimeTicks, resumeTicks);
  assert.ok(harness.stopped.includes("local-player-error"));
  assert.equal(harness.diagnostics[0]?.event, "emby-local-player-failure");

  fallbackResult.resolve({
    pipelineId: "pipeline-mse-fallback",
    plan: { ...currentPlan, method: "Transcode" },
  });
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-mse-fallback",
    plan: { ...currentPlan, method: "Transcode" },
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(2),
  });
  await nextTurn();
  globalThis.__embyBroadcastTestPlayers[0].dispatchEvent(new Event("ready"));
  await nextTurn();
  assert.equal(harness.video.paused, false);
  assert.equal(
    harness.video.playCalls,
    1,
    "a startup compatibility retry preserves the user's intent to play",
  );
});

test("stop tears down the pipeline without waiting for offline playback telemetry", async () => {
  const { EmbyBroadcastController } = await loadModule();
  const startResult = deferred();
  const reportGate = deferred();
  const harness = createHarness([startResult], { reportGate });
  const currentPlan = plan("offline-stop");
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  const starting = controller.start({ itemId: "offline-stop" }, "Offline");
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-offline-stop",
    plan: currentPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(1),
  });
  startResult.resolve({
    pipelineId: "pipeline-offline-stop",
    plan: currentPlan,
  });
  await starting;

  await Promise.race([
    controller.stop(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("stop waited for playback telemetry")),
        150,
      ),
    ),
  ]);
  assert.ok(harness.stopped.includes("broadcast-stopped"));
  reportGate.resolve();
});

test("playback telemetry is bounded and overlapping progress reports are coalesced", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { EmbyBroadcastController } = await loadModule();
  const reportGate = deferred();
  const harness = createHarness([], { reportGate });
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  controller.plan = plan("stalled-telemetry");
  controller.pipelineId = "pipeline-stalled-telemetry";

  const first = controller.reportPlayback("progress", "TimeUpdate");
  await nextTurn();
  await controller.reportPlayback("progress", "TimeUpdate");
  assert.equal(harness.reportCalls.length, 1);

  t.mock.timers.tick(3_000);
  await first;
  assert.deepEqual(
    harness.diagnostics
      .filter(({ event }) => event === "emby-playback-report-failed")
      .map(({ detail }) => [detail.action, detail.timedOut]),
    [["progress", true]],
  );

  reportGate.resolve();
  await controller.reportPlayback("progress", "TimeUpdate");
  assert.equal(harness.reportCalls.length, 2);
  await controller.destroy();
});

test("stop and seek teardown cannot wait forever on stalled Electron IPC", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { EmbyBroadcastController } = await loadModule();
  const harness = createHarness([]);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  controller.pipelineId = "pipeline-stalled-ipc";
  controller.plan = plan("stalled-ipc");
  controller.mimeType = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
  controller.flowControlOperation = new Promise(() => {});
  harness.bridge.embySetFlowPaused = () => new Promise(() => {});
  harness.bridge.embyStopStream = (reason) => {
    harness.stopped.push(reason);
    return new Promise(() => {});
  };

  const stopping = controller.stop();
  await nextTurn();
  t.mock.timers.tick(2_000);
  await nextTurn();
  t.mock.timers.tick(2_000);
  await nextTurn();
  assert.deepEqual(harness.stopped, ["broadcast-stopped"]);
  t.mock.timers.tick(8_000);
  await stopping;

  assert.deepEqual(
    harness.diagnostics
      .filter(({ event }) => event === "emby-ipc-operation-failed")
      .map(({ detail }) => detail.operation),
    ["flow-control-settle", "flow-control-reset", "pipeline-stop"],
  );
  assert.ok(
    harness.diagnostics
      .filter(({ event }) => event === "emby-ipc-operation-failed")
      .every(({ detail }) => detail.timedOut === true),
  );

  harness.bridge.embySetFlowPaused = async () => {};
  harness.bridge.embyStopStream = async () => {};
  await controller.destroy();
});

test("append-queue drain resumes a flow-paused pipeline without another fragment", async () => {
  const { EmbyBroadcastController } = await loadModule();
  const startResult = deferred();
  const harness = createHarness([startResult]);
  const currentPlan = plan("flow");
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });

  const starting = controller.start({ itemId: "flow" }, "Flow");
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-flow",
    plan: currentPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(1),
  });
  startResult.resolve({ pipelineId: "pipeline-flow", plan: currentPlan });
  await starting;

  const player = globalThis.__embyBroadcastTestPlayers[0];
  harness.flowChanges.length = 0;
  player.queuedAppendBytes = 25 * 1024 * 1024;
  harness.emit({
    type: "fragment",
    pipelineId: "pipeline-flow",
    sequence: 1,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    keyframe: true,
    data: Uint8Array.of(2),
  });
  await nextTurn();
  assert.deepEqual(harness.flowChanges, [true]);

  player.setQueuedAppendBytes(0);
  await nextTurn();
  assert.deepEqual(harness.flowChanges, [true, false]);
  await controller.destroy();
});

test("a failed flow-pause IPC command is retried instead of wedging FFmpeg", async () => {
  const { EmbyBroadcastController } = await loadModule();
  const harness = createHarness([]);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  controller.appliedFlowPaused = false;
  controller.flowPaused = true;
  harness.bridge.failNextFlowChange = true;

  controller.flushFlowControl();
  await nextTurn();
  assert.deepEqual(harness.flowChanges, [true]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(
    harness.flowChanges,
    [true, true],
    "the desired pause must be retried after a transient IPC failure",
  );
  await controller.destroy();
});

test("viewer handshake separates control traffic and synchronizes initial play", async (t) => {
  const {
    EMBY_CONTROL_CHANNEL_LABEL,
    EMBY_DATA_CHANNEL_LABEL,
    EmbyBroadcastController,
  } = await loadModule();
  const startResult = deferred();
  const harness = createHarness([startResult]);
  const currentPlan = plan("handshake");
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());
  const starting = controller.start({ itemId: "handshake" }, "Handshake");
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-handshake",
    plan: currentPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(1, 2),
  });
  startResult.resolve({
    pipelineId: "pipeline-handshake",
    plan: currentPlan,
  });
  await starting;

  class FakeChannel extends EventTarget {
    binaryType = "arraybuffer";
    bufferedAmountLowThreshold = 0;
    bufferedAmount = 0;
    readyState = "connecting";
    sent = [];
    constructor(label) {
      super();
      this.label = label;
    }
    open() {
      this.readyState = "open";
      this.dispatchEvent(new Event("open"));
    }
    send(value) {
      this.sent.push(value);
    }
    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
  }
  const channels = [];
  controller.attachViewer("viewer-1", {
    createDataChannel(label, options) {
      const channel = new FakeChannel(label);
      channel.options = options;
      channels.push(channel);
      return channel;
    },
  });
  const media = channels.find(
    (channel) => channel.label === EMBY_DATA_CHANNEL_LABEL,
  );
  const control = channels.find(
    (channel) => channel.label === EMBY_CONTROL_CHANNEL_LABEL,
  );
  assert.ok(media);
  assert.ok(control);
  assert.deepEqual(
    media.options,
    { ordered: false },
    "movie media is reliable but unordered so packet loss cannot create an MSE time hole",
  );
  assert.deepEqual(control.options, { ordered: true });

  control.open();
  assert.equal(JSON.parse(control.sent[0]).type, "session");
  assert.equal(media.sent.length, 0, "media waits for session-ready");
  control.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "session-ready",
        sessionId: controller.sessionId,
        mediaVersion: controller.currentMediaVersion,
      }),
    }),
  );
  media.open();
  assert.ok(
    media.sent.some((packet) => packet instanceof ArrayBuffer),
    "init media begins only after the viewer is configured",
  );

  const player = globalThis.__embyBroadcastTestPlayers[0];
  harness.video.paused = false;
  player.dispatchEvent(new Event("ready"));
  assert.equal(
    harness.video.paused,
    true,
    "host waits while the viewer builds its initial buffer",
  );
  control.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "media-ready",
        sessionId: controller.sessionId,
        mediaVersion: controller.currentMediaVersion,
      }),
    }),
  );
  await nextTurn();
  assert.equal(harness.video.paused, false, "all ready peers start together");

  const controlsBeforeBackgroundClock = control.sent.length;
  globalThis.document.visibilityState = "hidden";
  controller.broadcastPlaybackState();
  assert.ok(
    control.sent
      .slice(controlsBeforeBackgroundClock)
      .some(
        (packet) =>
          typeof packet === "string" &&
          JSON.parse(packet).type === "playback-state",
      ),
    "a minimized host keeps publishing its playback clock",
  );
  globalThis.document.visibilityState = "visible";

  controller.ignoreSeekUntil = 0;
  const controlsBeforePause = control.sent.length;
  harness.video.pause();
  assert.ok(
    control.sent
      .slice(controlsBeforePause)
      .some(
        (packet) =>
          typeof packet === "string" &&
          JSON.parse(packet).type === "playback-state",
      ),
    "pause state bypasses the media channel",
  );
  await controller.destroy();
});

test("only the initial viewer barrier may wait; a late viewer never pauses active playback", async (t) => {
  const { EmbyBroadcastController } = await loadModule();
  const harness = createHarness([]);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());
  controller.pipelineId = "pipeline-barrier";
  controller.plan = plan("barrier");
  controller.mimeType = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
  controller.mediaVersion = 1;
  controller.localReady = true;
  const state = {
    sender: {
      sendControl() {},
      close() {},
    },
    ready: false,
    sessionReady: false,
  };
  controller.peers.set("stale-viewer", state);

  controller.maybeStartSynchronizedPlayback();
  await nextTurn();
  assert.equal(harness.video.paused, false);
  assert.equal(harness.video.playCalls, 1);
  assert.equal(controller.startBarrierTimer, undefined);

  state.sessionReady = true;
  controller.maybeStartSynchronizedPlayback();
  assert.equal(harness.video.paused, false, "a late viewer cannot pause the room");
  assert.equal(controller.startBarrierTimer, undefined);
  assert.equal(harness.video.playCalls, 1);

  controller.initialPlaybackStarted = false;
  harness.video.paused = true;
  harness.video.playCalls = 0;
  controller.maybeStartSynchronizedPlayback();
  assert.equal(harness.video.paused, true);
  assert.equal(controller.startBarrierTimer?._idleTimeout, 2_800);
  controller.maybeStartSynchronizedPlayback(true);
  await nextTurn();
  assert.equal(harness.video.paused, false);
  assert.equal(harness.video.playCalls, 1);
});

test("a waiting viewer leaving releases the initial barrier but a host pause remains authoritative", async (t) => {
  const { EmbyBroadcastController } = await loadModule();
  const harness = createHarness([]);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());
  controller.pipelineId = "pipeline-leave-barrier";
  controller.plan = plan("leave-barrier");
  controller.mimeType = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
  controller.mediaVersion = 1;
  controller.localReady = true;
  controller.peers.set("viewer-leaving", {
    sender: { sendControl() {}, close() {} },
    ready: false,
    sessionReady: true,
  });

  controller.maybeStartSynchronizedPlayback();
  assert.notEqual(controller.startBarrierTimer, undefined);
  controller.detachViewer("viewer-leaving");
  await nextTurn();
  assert.equal(controller.startBarrierTimer, undefined);
  assert.equal(harness.video.paused, false);

  harness.video.pause();
  controller.userWantsPaused = true;
  controller.peers.set("late-viewer", {
    sender: { sendControl() {}, close() {} },
    ready: false,
    sessionReady: true,
  });
  const playCalls = harness.video.playCalls;
  controller.maybeStartSynchronizedPlayback();
  assert.equal(harness.video.paused, true);
  assert.equal(harness.video.playCalls, playCalls);
});

test("a rejected host play promise enters the bounded compatibility recovery path", async (t) => {
  const { EmbyBroadcastController } = await loadModule();
  const harness = createHarness([]);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());
  controller.pipelineId = "pipeline-play-rejection";
  controller.plan = plan("play-rejection");
  controller.mimeType = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
  controller.mediaVersion = 3;
  controller.localReady = true;
  controller.activeRequest = {
    itemId: "play-rejection",
    startTimeTicks: 120_000_000,
  };
  harness.video.playError = new Error("decoder rejected stream");

  controller.maybeStartSynchronizedPlayback();
  await nextTurn();
  await nextTurn();
  assert.equal(controller.localFailureHandledForVersion, 3);
  assert.equal(controller.activeRequest.forceVideoTranscode, true);
  assert.equal(controller.activeRequest.allowHevc, false);
  assert.ok(harness.stopped.includes("local-player-error"));
});

test("slow-peer recovery ignores initial and healthy forward cache but reacts to low buffer", async (t) => {
  const { EmbyBroadcastController } = await loadModule();
  const harness = createHarness([]);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());
  controller.pipelineId = "pipeline-recovery";
  controller.plan = plan("recovery");
  controller.mimeType = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
  controller.mediaVersion = 1;
  controller.localReady = true;
  const controls = [];
  let clears = 0;
  const state = {
    sender: {
      clearMediaQueue() {
        clears += 1;
      },
      sendControl(message) {
        controls.push(message);
      },
      sendFragment() {},
      close() {},
    },
    stats: {
      queuedBytes: 12 * 1024 * 1024,
      bufferedBytes: 256 * 1024,
      queuedMessages: 200,
      droppedFragments: 0,
      queuedDurationMs: 9_000,
      bufferedDurationMs: 800,
      totalQueuedDurationMs: 9_800,
    },
    ready: false,
    sessionReady: true,
    bufferAhead: 0,
    slowSamples: 0,
    recoveries: 0,
    lastCatchUpAt: 0,
    lastPressureReportAt: 0,
    observedDroppedFragments: 0,
    transportEpoch: 0,
  };
  controller.peers.set("viewer-recovery", state);

  controller.recoverSlowPeers();
  controller.recoverSlowPeers();
  assert.equal(clears, 0, "initial prime must not cause an epoch loop");
  assert.equal(state.transportEpoch, 0);

  state.ready = true;
  state.bufferAhead = 12;
  controller.recoverSlowPeers();
  assert.equal(clears, 0, "healthy forward buffer tolerates queued future media");

  state.bufferAhead = 2;
  controller.recoverSlowPeers();
  controller.recoverSlowPeers();
  controller.recoverSlowPeers();
  assert.equal(clears, 0, "one weak sample must not cause a resync loop");
  controller.recoverSlowPeers();
  assert.equal(clears, 1);
  assert.equal(state.transportEpoch, 1);
  assert.ok(
    controls.some(
      (message) =>
        message.type === "resync" && message.transportEpoch === 1,
    ),
  );
  controller.recoverSlowPeers();
  assert.equal(clears, 1, "the cooldown prevents immediate repeat resync");
});

test("peer repair controls are deduplicated and token-bucket limited", async (t) => {
  const { EmbyBroadcastController } = await loadModule();
  const harness = createHarness([]);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());
  controller.mediaVersion = 1;
  const fragment = {
    roomId: "ROOM",
    sessionId: controller.sessionId,
    mediaVersion: 1,
    sequence: 7,
    timestampMs: Date.now(),
    mediaTimeMs: 5_250,
    trackType: "muxed",
    keyframe: false,
    data: new Uint8Array(1_200_000),
  };
  const init = { ...fragment, sequence: 0, data: Uint8Array.of(1, 2) };
  controller.cache.add(fragment);
  controller.cache.setInit(init);
  let repairs = 0;
  let initRepairs = 0;
  const state = {
    sender: {
      sendFragment(outbound) {
        if (outbound.sequence === 0) initRepairs += 1;
        else repairs += 1;
      },
      sendControl() {},
      close() {},
    },
    stats: {
      queuedBytes: 0,
      bufferedBytes: 0,
      queuedMessages: 0,
      droppedFragments: 0,
      queuedDurationMs: 0,
      bufferedDurationMs: 0,
      totalQueuedDurationMs: 0,
    },
    ready: true,
    sessionReady: true,
    bufferAhead: 8,
    slowSamples: 0,
    recoveries: 0,
    lastCatchUpAt: 0,
    lastPressureReportAt: 0,
    observedDroppedFragments: 0,
    transportEpoch: 0,
    repairTokens: 128,
    repairTokenUpdatedAt: Date.now(),
    recentRepairRequests: new Map(),
    lastInitRequestAt: 0,
    lastSyncPingAt: 0,
    lastBufferStateAt: 0,
  };
  controller.peers.set("viewer-repair-limit", state);
  state.sessionReady = false;
  state.ready = false;
  controller.handlePeerControl("viewer-repair-limit", {
    type: "media-ready",
    sessionId: controller.sessionId,
    mediaVersion: 1,
    transportEpoch: 0,
  });
  assert.equal(
    state.ready,
    false,
    "media-ready cannot bypass the session-ready handshake",
  );
  let primes = 0;
  controller.primeMediaForPeer = () => {
    primes += 1;
  };
  const sessionReady = {
    type: "session-ready",
    sessionId: controller.sessionId,
    mediaVersion: 1,
    transportEpoch: 0,
  };
  for (let request = 0; request < 200; request += 1) {
    controller.handlePeerControl("viewer-repair-limit", sessionReady);
  }
  assert.equal(primes, 1, "session-ready primes only on false-to-true");

  const repeated = {
    type: "need",
    sessionId: controller.sessionId,
    mediaVersion: 1,
    transportEpoch: 0,
    fragmentSeq: 7,
    trackType: "muxed",
    missing: [0, 1],
  };
  for (let request = 0; request < 200; request += 1) {
    controller.handlePeerControl("viewer-repair-limit", repeated);
  }
  assert.equal(repairs, 1);

  for (let request = 0; request < 200; request += 1) {
    controller.handlePeerControl("viewer-repair-limit", {
      ...repeated,
      missing: [request % 4, 4 + Math.floor(request / 4)],
    });
  }
  assert.ok(repairs <= 64, "one burst cannot exceed the repair token budget");

  const initRequest = {
    type: "init-request",
    sessionId: controller.sessionId,
    mediaVersion: 1,
    transportEpoch: 0,
  };
  for (let request = 0; request < 200; request += 1) {
    controller.handlePeerControl("viewer-repair-limit", initRequest);
  }
  assert.equal(initRepairs, 1);
});

test("EOS advertises the per-peer epoch and final muxed sequence", async (t) => {
  const { EmbyBroadcastController } = await loadModule();
  const harness = createHarness([]);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());
  controller.pipelineId = "pipeline-eos-boundary";
  controller.plan = plan("eos-boundary");
  controller.mimeType = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
  controller.mediaVersion = 6;
  controller.lastMuxedFragmentSeq = 19;
  const sent = [];
  controller.peers.set("viewer-eos", {
    transportEpoch: 4,
    sender: {
      sendControl(message, priority) {
        sent.push({ message, priority });
      },
      close() {},
    },
  });
  controller.markEnded();
  assert.deepEqual(sent, [
    {
      message: {
        type: "stream-ended",
        sessionId: controller.sessionId,
        mediaVersion: 6,
        transportEpoch: 4,
        finalFragmentSeq: 19,
        finalTrackType: "muxed",
      },
      priority: false,
    },
  ]);
});

test("host seek restarts at the requested timestamp and ignores the MSE reset to zero", async (t) => {
  const { EmbyBroadcastController } = await loadModule();
  const firstResult = deferred();
  const seekResult = deferred();
  const harness = createHarness([firstResult, seekResult]);
  const firstPlan = plan("seek");
  const seekPlan = plan("seek", 370_000_000);
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: () => {},
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());

  const starting = controller.start({ itemId: "seek" }, "Seek");
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-seek-0",
    plan: firstPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(1),
  });
  firstResult.resolve({ pipelineId: "pipeline-seek-0", plan: firstPlan });
  await starting;

  globalThis.__embyBroadcastTestPlayers[0].dispatchEvent(new Event("ready"));
  await nextTurn();
  controller.ignoreSeekUntil = 0;
  harness.video.paused = false;
  harness.video.currentTime = 37;
  harness.video.dispatchEvent(new Event("seeking"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(harness.startRequests.length, 2);
  assert.equal(harness.startRequests[1].startTimeTicks, 370_000_000);

  // MediaSource assigns a fresh source and can emit a transient seek to zero.
  // It belongs to the replacement pipeline and must not launch a third stream.
  harness.video.currentTime = 0;
  harness.video.dispatchEvent(new Event("seeking"));
  harness.emit({
    type: "init",
    pipelineId: "pipeline-seek-37",
    plan: seekPlan,
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(2),
  });
  seekResult.resolve({ pipelineId: "pipeline-seek-37", plan: seekPlan });
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.equal(
    harness.startRequests.length,
    2,
    "the programmatic zero-time reset must not restart playback from the beginning",
  );
});

test("continuous seek commits the latest target and supersedes an in-flight rebuild", async (t) => {
  const { EmbyBroadcastController } = await loadModule();
  const initialResult = deferred();
  const staleSeekResult = deferred();
  const finalSeekResult = deferred();
  const harness = createHarness([
    initialResult,
    staleSeekResult,
    finalSeekResult,
  ]);
  const notifications = [];
  const controller = new EmbyBroadcastController({
    roomId: "ROOM",
    video: harness.video,
    notify: (message, error) => notifications.push({ message, error }),
    onStatus: () => {},
    onStreamReady: () => {},
  });
  t.after(() => controller.destroy());

  const starting = controller.start({ itemId: "scrub" }, "Scrub");
  await nextTurn();
  harness.emit({
    type: "init",
    pipelineId: "pipeline-initial",
    plan: plan("scrub"),
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(1),
  });
  initialResult.resolve({
    pipelineId: "pipeline-initial",
    plan: plan("scrub"),
  });
  await starting;

  assert.equal(controller.seekTo(12), true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(controller.seekTo(28), true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(harness.startRequests.length, 2);
  assert.equal(harness.startRequests[1].startTimeTicks, 280_000_000);

  // A newer settled position takes ownership while the old Electron/FFmpeg
  // invocation is still unresolved.
  assert.equal(controller.seekTo(43), true);
  await new Promise((resolve) => setTimeout(resolve, 420));
  assert.equal(harness.startRequests.length, 3);
  assert.equal(harness.startRequests[2].startTimeTicks, 430_000_000);
  assert.ok(harness.stopped.includes("seek-superseded"));

  staleSeekResult.resolve({
    pipelineId: "pipeline-stale-seek",
    plan: plan("scrub", 280_000_000),
  });
  harness.emit({
    type: "init",
    pipelineId: "pipeline-stale-seek",
    plan: plan("scrub", 280_000_000),
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(2),
  });
  harness.emit({
    type: "init",
    pipelineId: "pipeline-final-seek",
    plan: plan("scrub", 430_000_000),
    mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
    data: Uint8Array.of(3),
  });
  finalSeekResult.resolve({
    pipelineId: "pipeline-final-seek",
    plan: plan("scrub", 430_000_000),
  });
  await nextTurn();
  assert.equal(controller.streamPlan?.startTimeTicks, 430_000_000);
  assert.equal(
    globalThis.__embyBroadcastTestPlayers[0].configured.at(-1).plan
      .startTimeTicks,
    430_000_000,
  );
  assert.equal(
    notifications.some(
      ({ message, error }) =>
        error === true && /取消|替代/u.test(message),
    ),
    false,
  );
});
