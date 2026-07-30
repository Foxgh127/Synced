import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
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
  return modulePromise;
}

function fixtureData(length = 150_000) {
  return Uint8Array.from({ length }, (_value, index) => (index * 31) & 0xff);
}

test("chunks carry complete identity, timing, length, and CRC metadata", async () => {
  const transport = await loadModule();
  const data = fixtureData();
  const fragment = {
    roomId: "ABC123",
    sessionId: "session_123456",
    mediaVersion: 4,
    transportEpoch: 7,
    sequence: 19,
    timestampMs: 1_760_000_000_000,
    mediaTimeMs: 42_500,
    timelineTimeMs: 5_250,
    trackType: "muxed",
    keyframe: true,
    data,
  };
  const chunks = transport.chunkEmbyFragment(fragment);
  assert.equal(chunks.length, Math.ceil(data.length / transport.EMBY_CHUNK_BYTES));
  for (const { header, packet } of chunks) {
    const decoded = transport.decodeEmbyChunk(packet);
    assert.deepEqual(decoded.header, header);
    assert.equal(header.roomId, fragment.roomId);
    assert.equal(header.sessionId, fragment.sessionId);
    assert.equal(header.mediaVersion, fragment.mediaVersion);
    assert.equal(header.transportEpoch, fragment.transportEpoch);
    assert.equal(header.fragmentSeq, fragment.sequence);
    assert.equal(header.timelineTimeMs, fragment.timelineTimeMs);
    assert.equal(header.dataLength, data.length);
    assert.equal(header.checksum, transport.crc32(data));
  }
  assert.throws(
    () =>
      transport.encodeEmbyChunk(
        {
          ...chunks[0].header,
          dataLength: 1,
          chunkCount: 2,
        },
        new Uint8Array(chunks[0].header.chunkLength),
      ),
    /布局与总长度不一致/,
  );
});

test("repairs source timestamp jumps into one continuous movie timeline", async () => {
  const { EmbyTimelineNormalizer } = await loadModule();
  const timeline = new EmbyTimelineNormalizer(37_000);

  assert.deepEqual(timeline.normalize(37_829, 1), {
    timelineTimeMs: 37_000,
    timestampOffsetMs: -829,
    discontinuity: false,
  });
  assert.deepEqual(timeline.normalize(38_579, 2), {
    timelineTimeMs: 37_750,
    timestampOffsetMs: -829,
    discontinuity: false,
  });
  assert.deepEqual(timeline.normalize(39_329, 3), {
    timelineTimeMs: 38_500,
    timestampOffsetMs: -829,
    discontinuity: false,
  });

  const repaired = timeline.normalize(78_674, 4);
  assert.deepEqual(repaired, {
    timelineTimeMs: 39_250,
    timestampOffsetMs: -39_424,
    discontinuity: true,
  });
  assert.equal(timeline.discontinuityCount, 1);

  assert.deepEqual(timeline.normalize(79_424, 5), {
    timelineTimeMs: 40_000,
    timestampOffsetMs: -39_424,
    discontinuity: false,
  });
});

test("legacy chunks without a transport epoch decode as epoch zero", async () => {
  const transport = await loadModule();
  const fragment = {
    roomId: "ROOM",
    sessionId: "session_legacy_epoch",
    mediaVersion: 1,
    sequence: 1,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    trackType: "muxed",
    keyframe: true,
    data: fixtureData(64),
  };
  const [{ header }] = transport.chunkEmbyFragment(fragment);
  const packet = transport.encodeEmbyChunk(
    { ...header, transportEpoch: undefined },
    fragment.data,
  );
  assert.equal(transport.decodeEmbyChunk(packet).header.transportEpoch, 0);
});

test("receiver reassembles out-of-order chunks and verifies the whole fragment", async () => {
  const transport = await loadModule();
  globalThis.window ||= globalThis;
  const data = fixtureData(220_000);
  const packets = transport
    .chunkEmbyFragment({
      roomId: "ROOM55",
      sessionId: "session_receiver_1",
      mediaVersion: 2,
      sequence: 7,
      timestampMs: Date.now(),
      mediaTimeMs: 12_000,
      trackType: "muxed",
      keyframe: true,
      data,
    })
    .map(({ packet }) => packet)
    .reverse();
  const completed = [];
  const assembler = new transport.EmbyFragmentAssembler(
    {
      roomId: "ROOM55",
      sessionId: "session_receiver_1",
      mediaVersion: 2,
    },
    (fragment) => completed.push(fragment),
    () => assert.fail("a complete reliable fragment must not request chunks"),
  );
  for (const packet of packets) assembler.accept(packet);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].data, data);
  assembler.reset();
});

test("an exhausted partial keyframe reports abandonment instead of disappearing silently", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const transport = await loadModule();
  globalThis.window ||= globalThis;
  const packets = transport
    .chunkEmbyFragment({
      roomId: "ROOM",
      sessionId: "session_abandoned_keyframe",
      mediaVersion: 4,
      sequence: 17,
      timestampMs: Date.now(),
      mediaTimeMs: 12_000,
      trackType: "muxed",
      keyframe: true,
      data: fixtureData(80_000),
    })
    .map(({ packet }) => packet);
  const abandoned = [];
  const assembler = new transport.EmbyFragmentAssembler(
    {
      roomId: "ROOM",
      sessionId: "session_abandoned_keyframe",
      mediaVersion: 4,
    },
    () => assert.fail("the incomplete fragment must not be delivered"),
    () => {},
    undefined,
    (detail) => abandoned.push(detail),
  );
  assembler.accept(packets[0]);
  const assembly = [...assembler.pending.values()][0];
  assembly.createdAt = performance.now() - 10_001;
  t.mock.timers.tick(800);

  assert.equal(assembler.hasPending, false);
  assert.deepEqual(abandoned, [
    {
      mediaVersion: 4,
      fragmentSeq: 17,
      trackType: "muxed",
      transportEpoch: 0,
      keyframe: true,
      reason: "repair-exhausted",
    },
  ]);
});

test("throttled repair wake-ups still consume the absolute retry budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const transport = await loadModule();
  globalThis.window ||= globalThis;
  const packets = transport
    .chunkEmbyFragment({
      roomId: "ROOM",
      sessionId: "session_throttled_repair",
      mediaVersion: 5,
      sequence: 21,
      timestampMs: Date.now(),
      mediaTimeMs: 15_000,
      trackType: "muxed",
      keyframe: true,
      data: fixtureData(80_000),
    })
    .map(({ packet }) => packet);
  const repairs = [];
  const abandoned = [];
  const assembler = new transport.EmbyFragmentAssembler(
    {
      roomId: "ROOM",
      sessionId: "session_throttled_repair",
      mediaVersion: 5,
    },
    () => assert.fail("the incomplete fragment must not be delivered"),
    (...args) => repairs.push(args),
    undefined,
    (detail) => abandoned.push(detail),
  );
  assembler.accept(packets[0]);

  for (let attempt = 0; attempt < 6 && assembler.hasPending; attempt += 1) {
    const assembly = [...assembler.pending.values()][0];
    assembly.lastRequestAt = Date.now() + 400;
    t.mock.timers.tick(800);
  }

  assert.equal(repairs.length, 0);
  assert.equal(assembler.hasPending, false);
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].reason, "repair-exhausted");
});

test("receiver keeps a wide mobile TURN reorder window without evicting reliable fragments", async () => {
  const transport = await loadModule();
  globalThis.window ||= globalThis;
  const completed = [];
  const repairs = [];
  const assembler = new transport.EmbyFragmentAssembler(
    {
      roomId: "TURN48",
      sessionId: "session_wide_reorder",
      mediaVersion: 9,
    },
    (fragment) => completed.push(fragment.sequence),
    (_version, sequence, _track, missing) =>
      repairs.push({ sequence, missing }),
  );
  const packetGroups = Array.from({ length: 48 }, (_value, index) =>
    transport
      .chunkEmbyFragment({
        roomId: "TURN48",
        sessionId: "session_wide_reorder",
        mediaVersion: 9,
        sequence: index + 1,
        timestampMs: Date.now(),
        mediaTimeMs: index * 750,
        trackType: "muxed",
        keyframe: index % 4 === 0,
        data: fixtureData(80_000 + index),
      })
      .map(({ packet }) => packet),
  );

  // Model an unordered relay: every fragment's first packet arrives before
  // the remaining packets, spanning far beyond the old 16-fragment window.
  for (const packets of packetGroups) assembler.accept(packets[0]);
  for (const packets of packetGroups.reverse()) {
    for (const packet of packets.slice(1).reverse()) {
      assembler.accept(packet);
    }
  }

  assert.equal(completed.length, 48);
  assert.deepEqual(
    [...completed].sort((left, right) => left - right),
    Array.from({ length: 48 }, (_value, index) => index + 1),
  );
  assert.deepEqual(repairs, []);
  assembler.reset();
});

test("a newer transport epoch replaces partial old assembly and rejects late old packets", async () => {
  const transport = await loadModule();
  globalThis.window ||= globalThis;
  const oldData = fixtureData(80_000);
  const newData = Uint8Array.from(
    { length: 80_000 },
    (_value, index) => (index * 17 + 9) & 0xff,
  );
  const base = {
    roomId: "ROOM",
    sessionId: "session_epoch_switch",
    mediaVersion: 3,
    sequence: 9,
    timestampMs: Date.now(),
    mediaTimeMs: 9_000,
    trackType: "muxed",
    keyframe: true,
  };
  const oldPackets = transport
    .chunkEmbyFragment({ ...base, transportEpoch: 0, data: oldData })
    .map(({ packet }) => packet);
  const newPackets = transport
    .chunkEmbyFragment({ ...base, transportEpoch: 1, data: newData })
    .map(({ packet }) => packet);
  const completed = [];
  const advanced = [];
  const assembler = new transport.EmbyFragmentAssembler(
    {
      roomId: base.roomId,
      sessionId: base.sessionId,
      mediaVersion: base.mediaVersion,
      transportEpoch: 0,
    },
    (fragment) => completed.push(fragment),
    () => assert.fail("complete replacement must not request repair"),
    (epoch) => {
      advanced.push(epoch);
      return true;
    },
  );

  assembler.accept(oldPackets[0]);
  for (const packet of newPackets) assembler.accept(packet);
  for (const packet of oldPackets.slice(1)) assembler.accept(packet);

  assert.deepEqual(advanced, [1]);
  assert.equal(assembler.transportEpoch, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].transportEpoch, 1);
  assert.deepEqual(completed[0].data, newData);
  assembler.reset();
});

test("fragment cache retains the current version and supports keyframe catch-up", async () => {
  const { EmbyFragmentCache } = await loadModule();
  const cache = new EmbyFragmentCache(60_000, 4_000_000);
  for (let sequence = 1; sequence <= 8; sequence += 1) {
    cache.add({
      roomId: "ROOM",
      sessionId: "session_cache",
      mediaVersion: 3,
      sequence,
      timestampMs: Date.now(),
      mediaTimeMs: sequence * 1_500,
      trackType: "muxed",
      keyframe: [1, 4, 7].includes(sequence),
      data: fixtureData(1_000),
    });
  }
  assert.deepEqual(
    cache.after(3, 6_000).map((fragment) => fragment.sequence),
    [4, 5, 6, 7, 8],
  );
  assert.deepEqual(
    cache.after(3, 7_500).map((fragment) => fragment.sequence),
    [4, 5, 6, 7, 8],
  );
  cache.clearVersion(4);
  assert.equal(cache.get(3, 8), undefined);
});

test("fragment cache never returns an undecodable tail without a keyframe", async () => {
  const { EmbyFragmentCache } = await loadModule();
  const cache = new EmbyFragmentCache(60_000, 4_000_000);
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    cache.add({
      roomId: "ROOM",
      sessionId: "session_cache_without_keyframe",
      mediaVersion: 4,
      sequence,
      timestampMs: Date.now(),
      mediaTimeMs: sequence * 1_000,
      trackType: "muxed",
      keyframe: false,
      data: fixtureData(1_000),
    });
  }
  assert.deepEqual(cache.after(4, 0), []);
});

test("fragment cache excludes the retained init segment from its LRU byte budget", async () => {
  const { EmbyFragmentCache } = await loadModule();
  const cache = new EmbyFragmentCache(60_000, 1_000);
  const base = {
    roomId: "ROOM",
    sessionId: "session_init_budget",
    mediaVersion: 1,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    trackType: "muxed",
    keyframe: true,
  };
  cache.setInit({
    ...base,
    sequence: 0,
    data: fixtureData(900),
  });
  cache.add({
    ...base,
    sequence: 1,
    data: fixtureData(600),
  });
  assert.ok(cache.getInit(1), "init must remain available to late joiners");
  assert.ok(
    cache.get(1, 1),
    "an init segment must not consume the rolling fragment budget",
  );

  cache.add({
    ...base,
    sequence: 2,
    mediaTimeMs: 1_500,
    data: fixtureData(600),
  });
  assert.equal(cache.get(1, 1), undefined, "oldest media fragment is evicted");
  assert.ok(cache.get(1, 2), "newest media fragment remains cached");
  assert.ok(cache.getInit(1), "fragment eviction must not evict init");
});

test("peer sender sizes its bounded startup queue from the stream bitrate", async () => {
  const { EmbyPeerSender } = await loadModule();
  class BudgetChannel extends EventTarget {
    binaryType = "arraybuffer";
    bufferedAmountLowThreshold = 0;
    bufferedAmount = 0;
    readyState = "connecting";
    send() {}
    close() {
      this.readyState = "closed";
    }
  }
  const channel = new BudgetChannel();
  const sender = new EmbyPeerSender(channel);
  const ordinaryBudget = sender.primeBudgetBytes;
  sender.setMediaBitrate(46_000_000);
  assert.ok(
    sender.primeBudgetBytes > ordinaryBudget,
    "4K startup gets more bytes instead of the old fixed 16 MiB ceiling",
  );
  assert.ok(sender.primeBudgetBytes <= 96 * 1024 * 1024);
  assert.ok(channel.bufferedAmountLowThreshold >= 64 * 1024);
  sender.close();
});

test("each viewer queue pauses at the DataChannel high water independently", async () => {
  const { EmbyPeerSender, EMBY_BUFFER_HIGH_WATER } = await loadModule();
  class FakeDataChannel extends EventTarget {
    binaryType = "arraybuffer";
    bufferedAmountLowThreshold = 0;
    bufferedAmount = EMBY_BUFFER_HIGH_WATER + 1;
    readyState = "open";
    sent = [];
    send(value) {
      this.sent.push(value);
    }
    close() {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
  }
  const slow = new FakeDataChannel();
  const fast = new FakeDataChannel();
  fast.bufferedAmount = 0;
  const slowSender = new EmbyPeerSender(slow);
  const fastSender = new EmbyPeerSender(fast);
  const fragment = {
    roomId: "ROOM",
    sessionId: "session_senders",
    mediaVersion: 1,
    sequence: 1,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    trackType: "muxed",
    keyframe: true,
    data: fixtureData(60_000),
  };
  slowSender.sendFragment(fragment);
  fastSender.sendFragment(fragment);
  assert.equal(slow.sent.length, 0);
  assert.ok(fast.sent.length > 0);
  slow.bufferedAmount = 0;
  slow.dispatchEvent(new Event("bufferedamountlow"));
  assert.equal(slow.sent.length, fast.sent.length);
  slowSender.close();
  fastSender.close();
});

test("peer sender exposes queued media time so recovery can cap sync drift", async () => {
  const { EmbyPeerSender, EMBY_BUFFER_HIGH_WATER } = await loadModule();
  class FakeDataChannel extends EventTarget {
    binaryType = "arraybuffer";
    bufferedAmountLowThreshold = 0;
    bufferedAmount = EMBY_BUFFER_HIGH_WATER + 1;
    readyState = "open";
    send() {}
    close() {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
  }
  const channel = new FakeDataChannel();
  const sender = new EmbyPeerSender(channel);
  for (const [sequence, mediaTimeMs] of [0, 750, 1_500, 2_750].entries()) {
    sender.sendFragment({
      roomId: "ROOM",
      sessionId: "session_queue_duration",
      mediaVersion: 1,
      sequence: sequence + 1,
      timestampMs: Date.now(),
      mediaTimeMs,
      trackType: "muxed",
      keyframe: sequence === 0,
      data: fixtureData(1_000),
    });
  }
  assert.equal(sender.stats.queuedDurationMs, 2_750);
  assert.ok(
    sender.stats.totalQueuedDurationMs > sender.stats.queuedDurationMs,
    "SCTP bufferedAmount is included in the total delay estimate",
  );
  sender.clearMediaQueue();
  assert.equal(sender.stats.queuedDurationMs, 0);
  assert.equal(sender.stats.queuedBytes, 0);
  sender.close();
});

test("a completely non-draining channel is bounded near one second of SCTP media", async () => {
  const {
    EmbyPeerSender,
    EMBY_BUFFER_HIGH_WATER,
    EMBY_CHUNK_BYTES,
  } = await loadModule();
  class NonDrainingChannel extends EventTarget {
    binaryType = "arraybuffer";
    bufferedAmountLowThreshold = 0;
    bufferedAmount = 0;
    readyState = "open";
    send(value) {
      this.bufferedAmount +=
        typeof value === "string"
          ? Buffer.byteLength(value)
          : value.byteLength;
    }
    close() {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
  }
  const channel = new NonDrainingChannel();
  const sender = new EmbyPeerSender(channel);
  for (let sequence = 1; sequence <= 14; sequence += 1) {
    sender.sendFragment({
      roomId: "ROOM",
      sessionId: "session_non_draining",
      mediaVersion: 1,
      sequence,
      timestampMs: Date.now(),
      mediaTimeMs: (sequence - 1) * 300,
      trackType: "muxed",
      keyframe: sequence === 1,
      data: fixtureData(93_750),
    });
  }
  assert.ok(channel.bufferedAmount <= EMBY_BUFFER_HIGH_WATER + EMBY_CHUNK_BYTES);
  assert.ok(sender.stats.bufferedDurationMs < 1_100);
  assert.ok(sender.stats.totalQueuedDurationMs >= 1_800);
  sender.close();
});

test("slow drain accounting combines queued JavaScript and SCTP duration", async () => {
  const { EmbyPeerSender } = await loadModule();
  class SlowlyDrainingChannel extends EventTarget {
    binaryType = "arraybuffer";
    bufferedAmountLowThreshold = 0;
    bufferedAmount = 0;
    readyState = "open";
    send(value) {
      this.bufferedAmount += value.byteLength;
    }
    drain(bytes) {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.dispatchEvent(new Event("bufferedamountlow"));
      }
    }
    close() {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
  }
  const channel = new SlowlyDrainingChannel();
  const sender = new EmbyPeerSender(channel);
  for (let sequence = 1; sequence <= 12; sequence += 1) {
    sender.sendFragment({
      roomId: "ROOM",
      sessionId: "session_slow_drain",
      mediaVersion: 1,
      sequence,
      timestampMs: Date.now(),
      mediaTimeMs: (sequence - 1) * 300,
      trackType: "muxed",
      keyframe: sequence === 1,
      data: fixtureData(93_750),
    });
    channel.drain(35_000);
  }
  assert.ok(sender.stats.bufferedDurationMs > 0);
  assert.ok(sender.stats.queuedDurationMs > 0);
  assert.ok(
    sender.stats.totalQueuedDurationMs >=
      sender.stats.bufferedDurationMs + sender.stats.queuedDurationMs - 0.01,
  );
  while (sender.stats.queuedBytes > 0) {
    channel.bufferedAmount = 0;
    channel.dispatchEvent(new Event("bufferedamountlow"));
  }
  channel.bufferedAmount = 0;
  assert.equal(sender.stats.totalQueuedDurationMs, 0);
  sender.close();
});

test("4K backlog pruning gates media until a new epoch starts on a keyframe", async () => {
  const { EmbyPeerSender, EMBY_BUFFER_HIGH_WATER, decodeEmbyChunk } =
    await loadModule();
  class BlockedChannel extends EventTarget {
    binaryType = "arraybuffer";
    bufferedAmountLowThreshold = 0;
    bufferedAmount = EMBY_BUFFER_HIGH_WATER + 1;
    readyState = "open";
    sent = [];
    send(value) {
      this.sent.push(value);
    }
    close() {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
  }
  const channel = new BlockedChannel();
  const sender = new EmbyPeerSender(channel);
  const base = {
    roomId: "ROOM",
    sessionId: "session_4k_resync",
    mediaVersion: 5,
    transportEpoch: 3,
    timestampMs: Date.now(),
    trackType: "muxed",
  };
  sender.sendFragment(
    {
      ...base,
      sequence: 0,
      mediaTimeMs: 0,
      keyframe: true,
      data: fixtureData(900_000),
    },
    { priority: true, transportEpoch: 3 },
  );
  for (let sequence = 1; sequence <= 32; sequence += 1) {
    sender.sendFragment({
      ...base,
      sequence,
      mediaTimeMs: sequence * 750,
      keyframe: sequence % 4 === 1,
      data: fixtureData(600_000),
    });
  }
  assert.ok(sender.stats.droppedFragments > 0);
  assert.ok(sender.stats.recoveryGeneration > 0);
  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event("bufferedamountlow"));
  assert.equal(
    channel.sent.filter((packet) => packet instanceof ArrayBuffer).length,
    0,
    "the undecodable tail is held until the controller re-primes it",
  );
  sender.clearMediaQueue({ waitForKeyframe: true });
  sender.sendControl({
    type: "resync",
    sessionId: base.sessionId,
    mediaVersion: base.mediaVersion,
    transportEpoch: 4,
    targetTime: 24,
  });
  sender.sendFragment(
    {
      ...base,
      sequence: 0,
      mediaTimeMs: 0,
      keyframe: true,
      data: fixtureData(900_000),
    },
    { priority: true, transportEpoch: 4 },
  );
  sender.sendFragment(
    {
      ...base,
      sequence: 33,
      mediaTimeMs: 24_750,
      keyframe: false,
      data: fixtureData(600_000),
    },
    { transportEpoch: 4 },
  );
  sender.sendFragment(
    {
      ...base,
      sequence: 34,
      mediaTimeMs: 25_500,
      keyframe: true,
      data: fixtureData(600_000),
    },
    { transportEpoch: 4 },
  );
  const headers = channel.sent
    .filter((packet) => packet instanceof ArrayBuffer)
    .map((packet) => decodeEmbyChunk(packet).header);
  assert.ok(headers.some((header) => header.fragmentSeq === 0));
  assert.ok(
    headers
      .filter((header) => header.fragmentSeq === 0)
      .every((header) => header.transportEpoch === 4),
  );
  assert.equal(
    headers.find((header) => header.fragmentSeq > 0)?.fragmentSeq,
    34,
  );
  assert.equal(
    headers.find((header) => header.fragmentSeq > 0)?.keyframe,
    true,
  );
  sender.close();
});

test("repeated priority repair for one 4K fragment is deduplicated and bounded", async () => {
  const { EmbyPeerSender, EMBY_BUFFER_HIGH_WATER } = await loadModule();
  class BlockedChannel extends EventTarget {
    binaryType = "arraybuffer";
    bufferedAmountLowThreshold = 0;
    bufferedAmount = EMBY_BUFFER_HIGH_WATER + 1;
    readyState = "open";
    send() {}
    close() {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
  }
  const channel = new BlockedChannel();
  const sender = new EmbyPeerSender(channel);
  const fragment = {
    roomId: "ROOM",
    sessionId: "session_repair_dedupe",
    mediaVersion: 2,
    transportEpoch: 4,
    sequence: 18,
    timestampMs: Date.now(),
    mediaTimeMs: 13_500,
    trackType: "muxed",
    keyframe: false,
    data: fixtureData(1_200_000),
  };
  for (let request = 0; request < 200; request += 1) {
    sender.sendFragment(fragment, {
      priority: true,
      onlyChunks: [0, 1, 2, 3],
      transportEpoch: 4,
    });
  }
  assert.ok(
    sender.stats.queuedBytes < 256 * 1024,
    "identical repair chunks exist only once in the JavaScript queue",
  );

  for (let sequence = 20; sequence < 60; sequence += 1) {
    sender.sendFragment(
      { ...fragment, sequence, mediaTimeMs: sequence * 750 },
      { priority: true, transportEpoch: 4 },
    );
  }
  assert.ok(sender.stats.queuedBytes <= 16 * 1024 * 1024);
  sender.close();
});

test("peer sender preserves string controls and ArrayBuffer media packets", async () => {
  const { EmbyPeerSender, EMBY_BUFFER_HIGH_WATER } = await loadModule();
  class FakeDataChannel extends EventTarget {
    binaryType = "arraybuffer";
    bufferedAmountLowThreshold = 0;
    bufferedAmount = EMBY_BUFFER_HIGH_WATER + 1;
    readyState = "open";
    sent = [];
    send(value) {
      this.sent.push(value);
    }
    close() {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
  }
  const channel = new FakeDataChannel();
  const sender = new EmbyPeerSender(channel);
  sender.sendControl({
    type: "request-init",
    sessionId: "session_sender_types",
    mediaVersion: 1,
  });
  sender.sendFragment({
    roomId: "ROOM",
    sessionId: "session_sender_types",
    mediaVersion: 1,
    sequence: 1,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    trackType: "muxed",
    keyframe: true,
    data: fixtureData(10),
  });
  assert.equal(channel.sent.length, 0);

  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event("bufferedamountlow"));
  assert.equal(typeof channel.sent[0], "string");
  assert.ok(
    channel.sent.slice(1).every((packet) => packet instanceof ArrayBuffer),
  );
  sender.close();
});

test("dedicated control channel bypasses a congested media queue", async () => {
  const { EmbyPeerSender, EMBY_BUFFER_HIGH_WATER } = await loadModule();
  class FakeDataChannel extends EventTarget {
    binaryType = "arraybuffer";
    bufferedAmountLowThreshold = 0;
    bufferedAmount = 0;
    readyState = "open";
    sent = [];
    send(value) {
      this.sent.push(value);
    }
    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
  }
  const media = new FakeDataChannel();
  media.bufferedAmount = EMBY_BUFFER_HIGH_WATER + 1;
  const control = new FakeDataChannel();
  const received = [];
  const sender = new EmbyPeerSender(
    media,
    (message) => received.push(message),
    undefined,
    control,
  );
  sender.sendFragment({
    roomId: "ROOM",
    sessionId: "session_control_bypass",
    mediaVersion: 1,
    sequence: 1,
    timestampMs: Date.now(),
    mediaTimeMs: 0,
    trackType: "muxed",
    keyframe: true,
    data: fixtureData(100_000),
  });
  sender.sendControl({
    type: "sync-pong",
    clientTimeMs: 10,
    hostTimeMs: 20,
  });

  assert.equal(media.sent.length, 0, "media remains backpressured");
  assert.equal(control.sent.length, 1, "control is delivered immediately");
  assert.equal(JSON.parse(control.sent[0]).type, "sync-pong");

  control.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ type: "sync-ping", clientTimeMs: 30 }),
    }),
  );
  assert.equal(received[0].type, "sync-ping");
  sender.close();
});
