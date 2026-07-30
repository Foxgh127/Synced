import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/signal-message-scheduler.ts")],
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

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function turns(count = 3) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("one slow peer negotiation does not block another peer", async () => {
  const { SignalMessageScheduler } = await loadModule();
  const gate = deferred();
  const handled = [];
  const scheduler = new SignalMessageScheduler({
    async handle(message) {
      handled.push(message.id);
      if (message.id === "a1") await gate.promise;
    },
    onError: assert.fail,
  });
  scheduler.dispatch({ type: "signal", from: "a", sessionId: "s", id: "a1" });
  scheduler.dispatch({ type: "signal", from: "a", sessionId: "s", id: "a2" });
  scheduler.dispatch({ type: "signal", from: "b", sessionId: "s", id: "b1" });
  await turns();
  assert.deepEqual(handled, ["a1", "b1"]);
  gate.resolve();
  await turns();
  assert.deepEqual(handled, ["a1", "b1", "a2"]);
  scheduler.close();
});

test("mutable state coalesces to the latest value while lifecycle stays ordered", async () => {
  const { SignalMessageScheduler } = await loadModule();
  const gate = deferred();
  const handled = [];
  const scheduler = new SignalMessageScheduler({
    async handle(message) {
      handled.push(message.id);
      if (message.id === "q1") await gate.promise;
    },
    onError: assert.fail,
  });
  scheduler.dispatch({ type: "quality:request", viewerId: "v", id: "q1" });
  scheduler.dispatch({ type: "quality:request", viewerId: "v", id: "q2" });
  scheduler.dispatch({ type: "quality:request", viewerId: "v", id: "q3" });
  scheduler.dispatch({ type: "broadcast:started", id: "start" });
  scheduler.dispatch({ type: "broadcast:stopped", id: "stop" });
  await turns();
  assert.deepEqual(handled, ["q1", "start", "stop"]);
  gate.resolve();
  await turns();
  assert.deepEqual(handled, ["q1", "start", "stop", "q3"]);
  scheduler.close();
});

test("room snapshot and every participant delta share one ordered actor", async () => {
  const { SignalMessageScheduler } = await loadModule();
  const snapshotGate = deferred();
  const handled = [];
  const scheduler = new SignalMessageScheduler({
    async handle(message) {
      handled.push(message.id);
      if (message.id === "snapshot") await snapshotGate.promise;
    },
    onError: assert.fail,
  });
  scheduler.dispatch({ type: "channel:joined", id: "snapshot" });
  scheduler.dispatch({ type: "participant:joined", id: "joined" });
  scheduler.dispatch({ type: "participant:left", id: "left" });
  scheduler.dispatch({ type: "broadcast:started", id: "started" });
  await turns();
  assert.deepEqual(handled, ["snapshot"]);
  snapshotGate.resolve();
  await turns(6);
  assert.deepEqual(handled, ["snapshot", "joined", "left", "started"]);
  scheduler.close();
});

test("revision gate converges across 100,000 delayed-state observations", async () => {
  const { RoomStateRevisionGate } = await loadModule();
  const gate = new RoomStateRevisionGate();
  const authoritativeParticipants = new Set();
  const localParticipants = new Set();
  let authoritativeBroadcaster;
  let localBroadcaster;
  let roomRevision = 0;
  let participantRevision = 0;
  let broadcastRevision = 0;
  assert.equal(
    gate.accept({
      type: "channel:joined",
      roomRevision,
      participantRevision,
      broadcastRevision,
    }),
    true,
  );
  let random = 0x6d2b79f5;
  const nextRandom = () => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return random >>> 0;
  };
  let previous;
  for (let index = 0; index < 100_000; index += 1) {
    const participantId = `p${nextRandom() % 257}`;
    let message;
    if (index % 19 === 0) {
      roomRevision += 1;
      broadcastRevision += 1;
      const started = (nextRandom() & 1) === 1;
      authoritativeBroadcaster = started ? participantId : undefined;
      message = {
        type: started ? "broadcast:started" : "broadcast:stopped",
        roomRevision,
        participantRevision,
        broadcastRevision,
        broadcasterId: authoritativeBroadcaster,
      };
    } else {
      roomRevision += 1;
      participantRevision += 1;
      const joined = (nextRandom() & 3) !== 0;
      if (joined) authoritativeParticipants.add(participantId);
      else authoritativeParticipants.delete(participantId);
      message = {
        type: joined ? "participant:updated" : "participant:left",
        roomRevision,
        participantRevision,
        broadcastRevision,
        participantId,
      };
    }
    if (gate.accept(message)) {
      if (message.type === "broadcast:started") {
        localBroadcaster = message.broadcasterId;
      } else if (message.type === "broadcast:stopped") {
        localBroadcaster = undefined;
      } else if (message.type === "participant:left") {
        localParticipants.delete(message.participantId);
      } else {
        localParticipants.add(message.participantId);
      }
    }
    if (index % 23 === 0 && previous) {
      assert.equal(gate.accept(previous), false);
    }
    previous = message;
  }
  assert.deepEqual(
    [...localParticipants].sort(),
    [...authoritativeParticipants].sort(),
  );
  assert.equal(localBroadcaster, authoritativeBroadcaster);
  assert.deepEqual(gate.current, {
    roomRevision,
    participantRevision,
    broadcastRevision,
  });
  assert.equal(
    gate.accept({
      type: "channel:joined",
      roomRevision,
      participantRevision,
      broadcastRevision,
    }),
    false,
    "a duplicate snapshot cannot overwrite the reduced room state",
  );
  gate.reset();
  assert.equal(
    gate.accept({
      type: "channel:joined",
      roomRevision: 1,
      participantRevision: 1,
      broadcastRevision: 0,
    }),
    true,
    "a new WebSocket generation accepts a restarted server revision baseline",
  );
});

test("reset invalidates queued work without allowing an old worker to steal the new generation", async () => {
  const { SignalMessageScheduler } = await loadModule();
  const oldGate = deferred();
  const newGate = deferred();
  const handled = [];
  const scheduler = new SignalMessageScheduler({
    async handle(message) {
      handled.push(message.id);
      if (message.id === "old") await oldGate.promise;
      if (message.id === "new1") await newGate.promise;
    },
    onError: assert.fail,
  });
  scheduler.dispatch({ type: "quality:request", viewerId: "v", id: "old" });
  await turns(1);
  scheduler.reset();
  scheduler.dispatch({ type: "quality:request", viewerId: "v", id: "new1" });
  scheduler.dispatch({ type: "quality:request", viewerId: "v", id: "new2" });
  oldGate.resolve();
  await turns();
  assert.deepEqual(handled, ["old", "new1"]);
  newGate.resolve();
  await turns();
  assert.deepEqual(handled, ["old", "new1", "new2"]);
  scheduler.close();
});

test("a hung lifecycle handler is aborted and cannot freeze later lifecycle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { SignalMessageScheduler } = await loadModule();
  const handled = [];
  let firstSignal;
  const scheduler = new SignalMessageScheduler({
    timeoutMs: 1_000,
    async handle(message, signal) {
      handled.push(message.id);
      if (message.id !== "start") return;
      firstSignal = signal;
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
    },
    onError() {},
  });
  scheduler.dispatch({ type: "broadcast:started", id: "start" });
  scheduler.dispatch({ type: "broadcast:stopped", id: "stop" });
  await turns();
  assert.deepEqual(handled, ["start"]);
  t.mock.timers.tick(1_000);
  await turns();
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(handled, ["start", "stop"]);
  scheduler.close();
});
