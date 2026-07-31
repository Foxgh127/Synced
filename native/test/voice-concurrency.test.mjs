import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadVoiceModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/voice.ts")],
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

test("microphone capture mutations execute serially and recover after rejection", async () => {
  const { SerialAsyncQueue } = await loadVoiceModule();
  const queue = new SerialAsyncQueue();
  const events = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run(async () => {
    events.push("first:start");
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await firstGate;
    active -= 1;
    events.push("first:end");
    throw new Error("expected replacement failure");
  });
  const second = queue.run(async () => {
    events.push("second:start");
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    active -= 1;
    events.push("second:end");
    return "installed";
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await assert.rejects(first, /expected replacement failure/);
  assert.equal(await second, "installed");
  assert.equal(maximumActive, 1);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("a stuck voice mutation times out and releases later work", async () => {
  const { SerialAsyncQueue, VoiceOperationTimeoutError } =
    await loadVoiceModule();
  const queue = new SerialAsyncQueue(25);
  const stuck = queue.run(() => new Promise(() => {}), {
    label: "stuck voice mutation",
  });
  const next = queue.run(async () => "released");
  await assert.rejects(
    stuck,
    (error) =>
      error instanceof VoiceOperationTimeoutError &&
      /stuck voice mutation/u.test(error.message),
  );
  assert.equal(await next, "released");
});

test("a timed-out operation receives cancellation before its late result", async () => {
  const { SerialAsyncQueue, VoiceOperationTimeoutError } =
    await loadVoiceModule();
  const queue = new SerialAsyncQueue(10);
  let mutated = false;
  const late = queue.run(async (signal) => {
    await new Promise((resolve) => setTimeout(resolve, 35));
    if (!signal.aborted) mutated = true;
  });

  await assert.rejects(
    late,
    (error) => error instanceof VoiceOperationTimeoutError,
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(mutated, false);
});

test("a cancelled queued voice mutation never applies late state", async () => {
  const { SerialAsyncQueue } = await loadVoiceModule();
  const queue = new SerialAsyncQueue();
  const controller = new AbortController();
  let mutated = false;
  const blocker = queue.run(
    () => new Promise((resolve) => setTimeout(resolve, 30)),
  );
  const cancelled = queue.run(
    async () => {
      mutated = true;
    },
    { signal: controller.signal, label: "cancelled voice mutation" },
  );
  controller.abort(new DOMException("cancelled", "AbortError"));
  await blocker;
  await assert.rejects(cancelled, /cancelled/u);
  assert.equal(mutated, false);
});

test("pending voice ICE candidates have a hard 64-entry limit", async () => {
  const {
    MAX_PENDING_VOICE_CANDIDATES,
    queuePendingVoiceCandidate,
  } = await loadVoiceModule();
  const candidates = [];
  for (let index = 0; index < MAX_PENDING_VOICE_CANDIDATES; index += 1) {
    assert.equal(
      queuePendingVoiceCandidate(candidates, {
        candidate: `candidate:${index}`,
      }),
      true,
    );
  }
  assert.equal(
    queuePendingVoiceCandidate(candidates, {
      candidate: "candidate:overflow",
    }),
    false,
  );
  assert.equal(candidates.length, 64);
  assert.equal(candidates.at(-1).candidate, "candidate:63");
});

test("voice WebRTC operations have a hard deadline", async () => {
  const {
    boundedVoiceOperation,
    VoiceOperationTimeoutError,
  } = await loadVoiceModule();
  await assert.rejects(
    boundedVoiceOperation(
      new Promise(() => undefined),
      "test voice operation",
      10,
    ),
    (error) =>
      error instanceof VoiceOperationTimeoutError &&
      error.operation === "test voice operation" &&
      error.timeoutMs === 10,
  );
});

test("voice negotiation, stats, track replacement, and tuning are bounded", () => {
  const source = readFileSync(path.resolve("src/voice.ts"), "utf8");

  assert.match(
    source,
    /boundedVoiceOperation\(\s*peer\.pc\.createOffer\(\)/,
  );
  assert.match(
    source,
    /boundedVoiceOperation\(\s*peer\.pc\.setRemoteDescription\(description\)/,
  );
  assert.match(
    source,
    /boundedVoiceOperation\(\s*peer\.pc\.addIceCandidate\(candidate\)/,
  );
  assert.match(
    source,
    /boundedVoiceOperation\(\s*readOutboundAudioStats\(/,
  );
  assert.match(
    source,
    /boundedVoiceOperation\(\s*sender\.replaceTrack\(replacementTrack\)/,
  );
  assert.match(
    source,
    /boundedVoiceOperation\(\s*tuneVoiceSender\(sender, bitrate\)/,
  );
  assert.match(source, /VOICE_CAPTURE_REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(source, /signal\.addEventListener\("abort", abortHandler/);
  assert.match(
    source,
    /request[\s\S]*?stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/,
  );
  assert.match(source, /VOICE_NOISE_PROCESSOR_TIMEOUT_MS = 12_000/);
});

test("a signaling race rolls back shared-audio listener state and timers", () => {
  const source = readFileSync(path.resolve("src/voice.ts"), "utf8");
  const start = source.indexOf("async listenForSharedAudio()");
  const end = source.indexOf("async stopSharedAudioListener()", start);
  const listener = source.slice(start, end);

  assert.ok(start > 0);
  assert.match(listener, /try \{[\s\S]*?type: "voice:join"/);
  assert.match(listener, /catch \(error\)/);
  assert.match(listener, /this\.active = false/);
  assert.match(listener, /this\.listeningOnly = false/);
  assert.match(listener, /this\.stopSpeakingMonitor\(\)/);
  assert.match(listener, /this\.stopPeerHealthMonitor\(\)/);
  assert.match(listener, /throw error/);
});

test("a pending capture join cannot publish after leave invalidates its lifecycle", async () => {
  const { SerialAsyncQueue, VoiceCaptureLifecycle } =
    await loadVoiceModule();
  const queue = new SerialAsyncQueue();
  const lifecycle = new VoiceCaptureLifecycle();
  const joinEpoch = lifecycle.begin();
  const events = [];
  let releaseCapture;
  const captureGate = new Promise((resolve) => {
    releaseCapture = resolve;
  });

  const joining = queue.run(async () => {
    events.push("join:capture-start");
    await captureGate;
    if (!lifecycle.isCurrent(joinEpoch)) {
      events.push("join:discard-stale-graph");
      return;
    }
    events.push("join:publish");
  });
  lifecycle.invalidate();
  const leaving = queue.run(async () => {
    events.push("leave:cleanup");
  });

  releaseCapture();
  await Promise.all([joining, leaving]);
  assert.deepEqual(events, [
    "join:capture-start",
    "join:discard-stale-graph",
    "leave:cleanup",
  ]);
});

test("old capture recovery cannot overwrite a newly joined session", async () => {
  const { SerialAsyncQueue, VoiceCaptureLifecycle } =
    await loadVoiceModule();
  const queue = new SerialAsyncQueue();
  const lifecycle = new VoiceCaptureLifecycle();
  const oldEpoch = lifecycle.begin();
  const events = [];
  let releaseRecovery;
  const recoveryGate = new Promise((resolve) => {
    releaseRecovery = resolve;
  });

  const oldRecovery = queue.run(async () => {
    events.push("old-recovery:start");
    await recoveryGate;
    if (!lifecycle.isCurrent(oldEpoch)) {
      events.push("old-recovery:discard");
      return;
    }
    events.push("old-recovery:publish");
  });
  lifecycle.invalidate();
  const leaveCleanup = queue.run(async () => {
    events.push("leave:cleanup");
  });
  const newEpoch = lifecycle.begin();
  const newJoin = queue.run(async () => {
    assert.equal(lifecycle.isCurrent(newEpoch), true);
    events.push("new-join:publish");
  });

  releaseRecovery();
  await Promise.all([oldRecovery, leaveCleanup, newJoin]);
  assert.deepEqual(events, [
    "old-recovery:start",
    "old-recovery:discard",
    "leave:cleanup",
    "new-join:publish",
  ]);
});

test("invalidating microphone capture aborts the old permission generation", async () => {
  const { VoiceCaptureLifecycle } = await loadVoiceModule();
  const lifecycle = new VoiceCaptureLifecycle();
  const firstEpoch = lifecycle.begin();
  const firstSignal = lifecycle.signalFor(firstEpoch);
  assert.equal(firstSignal.aborted, false);

  lifecycle.invalidate();
  assert.equal(firstSignal.aborted, true);
  assert.equal(lifecycle.signalFor(firstEpoch).aborted, true);

  const secondEpoch = lifecycle.begin();
  assert.equal(lifecycle.signalFor(secondEpoch).aborted, false);
});
