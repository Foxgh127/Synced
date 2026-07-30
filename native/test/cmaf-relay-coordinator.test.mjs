import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CmafRelayCoordinator,
  EmbyService,
  renditionIdForQuality,
} from "../electron/emby-service.cjs";
import { createSegmentRelay } from "../server/segment-relay.mjs";

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for relay coordinator");
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function listenRelay(relay) {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void relay.handle(request, response, url).then((handled) => {
      if (!handled && !response.headersSent) {
        response.writeHead(404, { "content-length": "0" });
        response.end();
      }
    });
  });
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) =>
          error ? reject(error) : resolve(),
        ),
      ),
  };
}

function authorization(token) {
  return { authorization: `Bearer ${token}` };
}

function plan(id, height, bitrate, method = "Transcode") {
  return {
    itemId: "item",
    mediaSourceId: "source",
    playSessionId: "play",
    method,
    quality: { key: id, label: id },
    video: {},
    audio: {},
    videoCodec: "h264",
    audioCodec: "aac",
    localVideoTranscode: false,
    localAudioTranscode: true,
    width: Math.round((height * 16) / 9),
    height,
    frameRate: 30,
    bitrate,
    startTimeTicks: 0,
    runtimeTicks: 72_000_000_000,
  };
}

test("CMAF coordinator publishes aligned compact rendition snapshots", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "synced-cmaf-test-"));
  const originalFetch = globalThis.fetch;
  const uploads = new Map();
  globalThis.fetch = async (url, options) => {
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    uploads.set(new URL(url).pathname, Buffer.concat(chunks));
    return new Response(null, { status: 201 });
  };
  const coordinator = new CmafRelayCoordinator(
    {
      baseUrl: new URL("https://relay.example/media/v1/"),
      token: "t".repeat(96),
      roomId: "23456789",
      sessionId: "session-fixture",
      assetId: "0123456789abcdef0123456789abcdef01234567",
      mediaVersion: 5,
    },
    {
      cacheDir,
      maxDiskBytes: 256 * 1024 * 1024,
    },
  );
  try {
    const definitions = [
      ["original", 1440, 15_000_000, "DirectPlay"],
      ["1080p8", 1080, 8_000_000, "Transcode"],
      ["720p4", 720, 4_000_000, "Transcode"],
      ["480p18", 480, 1_800_000, "Transcode"],
    ];
    for (const [id, height, bitrate, method] of definitions) {
      coordinator.publishInit(
        id,
        plan(id, height, bitrate, method),
        'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
        Buffer.from(`init-${id}`),
        "Fixture",
      );
      coordinator.publishFragment(id, {
        sequence: 1,
        mediaTimeMs: 0,
        keyframe: true,
        data: Buffer.from(`fragment-one-${id}`),
      });
      coordinator.publishFragment(id, {
        sequence: 2,
        mediaTimeMs: 2_000,
        keyframe: true,
        data: Buffer.from(`fragment-two-${id}`),
      });
    }

    const manifestPath =
      "/media/v1/rooms/23456789/sessions/session-fixture/assets/" +
      "0123456789abcdef0123456789abcdef01234567/versions/5/manifest.json";
    const manifest = await waitFor(() => {
      const body = uploads.get(manifestPath);
      if (!body) return undefined;
      const parsed = JSON.parse(body);
      return parsed.renditions?.length === 4 &&
        parsed.renditions.every((item) => item.segments.length === 2)
        ? parsed
        : undefined;
    });
    assert.equal(manifest.segmentEncoding, "tuple-v1");
    assert.deepEqual(
      manifest.renditions.map(({ id }) => id),
      ["480p18", "720p4", "1080p8", "original"],
    );
    for (const rendition of manifest.renditions) {
      assert.equal(rendition.segments[0].length, 7);
      assert.equal(rendition.segments[0][0], 1);
      assert.equal(rendition.segments[0][3], 2_000);
      assert.equal(rendition.segments[0][4], 1);
      assert.match(rendition.segments[0][6], /^[a-f0-9]{64}$/);
      assert.equal(
        Object.prototype.hasOwnProperty.call(rendition.segments[0], "path"),
        false,
      );
    }
    assert.match(
      manifest.renditions.find(({ id }) => id === "original").switchGroup,
      /source-gop$/,
    );
    assert.match(
      manifest.renditions.find(({ id }) => id === "1080p8").switchGroup,
      /gop2$/,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(manifest)) < 1_900_000);
  } finally {
    await coordinator.close();
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("CMAF coordinator anchors its window to playback and backpressures deep producers", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "synced-cmaf-window-"));
  const originalFetch = globalThis.fetch;
  const uploads = new Map();
  globalThis.fetch = async (url, options) => {
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    uploads.set(new URL(url).pathname, Buffer.concat(chunks));
    return new Response(null, { status: 201 });
  };
  const coordinator = new CmafRelayCoordinator(
    {
      baseUrl: new URL("https://relay.example/media/v1/"),
      token: "t".repeat(96),
      roomId: "23456789",
      sessionId: "session-window",
      assetId: "fedcba9876543210fedcba9876543210fedcba98",
      mediaVersion: 1,
    },
    {
      cacheDir,
      maxDiskBytes: 256 * 1024 * 1024,
    },
  );
  let pauses = 0;
  let resumes = 0;
  try {
    coordinator.updatePlaybackAnchor(0);
    coordinator.registerProducer("original", {
      pause: () => {
        pauses += 1;
      },
      resume: () => {
        resumes += 1;
      },
    });
    coordinator.publishInit(
      "original",
      plan("original", 1080, 15_000_000, "DirectPlay"),
      'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
      Buffer.from("init-original"),
      "Window fixture",
    );
    for (let sequence = 1; sequence <= 71; sequence += 1) {
      coordinator.publishFragment("original", {
        sequence,
        mediaTimeMs: (sequence - 1) * 2_000,
        keyframe: true,
        data: Buffer.from(`fragment-${sequence}`),
      });
    }

    await waitFor(() => pauses > 0);
    const manifestPath =
      "/media/v1/rooms/23456789/sessions/session-window/assets/" +
      "fedcba9876543210fedcba9876543210fedcba98/versions/1/manifest.json";
    const manifest = await waitFor(() => {
      const body = uploads.get(manifestPath);
      if (!body) return undefined;
      const parsed = JSON.parse(body);
      const segments = parsed.renditions?.[0]?.segments;
      return segments?.length >= 8 && segments[0][0] === 1
        ? parsed
        : undefined;
    });
    const segments = manifest.renditions[0].segments;
    assert.equal(segments[0][2], 0);
    assert.ok(segments.at(-1)[2] <= 60_000);

    coordinator.updatePlaybackAnchor(1_400_000_000);
    await waitFor(() => resumes > 0);
    assert.equal(pauses, 1);
    assert.equal(resumes, 1);
  } finally {
    await coordinator.close();
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("CMAF coordinator drains the final segment before publishing ended", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "synced-cmaf-drain-"));
  const originalFetch = globalThis.fetch;
  const uploads = new Map();
  globalThis.fetch = async (url, options) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    uploads.set(new URL(url).pathname, Buffer.concat(chunks));
    return new Response(null, { status: 201 });
  };
  const coordinator = new CmafRelayCoordinator(
    {
      baseUrl: new URL("https://relay.example/media/v1/"),
      token: "t".repeat(96),
      roomId: "23456789",
      sessionId: "session-final-drain",
      assetId: "abcdef0123456789abcdef0123456789abcdef01",
      mediaVersion: 9,
    },
    {
      cacheDir,
      maxDiskBytes: 256 * 1024 * 1024,
    },
  );
  try {
    coordinator.publishInit(
      "720p4",
      plan("720p4", 720, 4_000_000),
      'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
      Buffer.from("init"),
      "Final drain",
    );
    coordinator.publishFragment("720p4", {
      sequence: 1,
      mediaTimeMs: 0,
      keyframe: true,
      data: Buffer.from("last-fragment"),
    });
    coordinator.markRenditionEnded("720p4");
    await coordinator.close(true);

    const root =
      "/media/v1/rooms/23456789/sessions/session-final-drain/assets/" +
      "abcdef0123456789abcdef0123456789abcdef01/versions/9";
    assert.equal(
      uploads.get(`${root}/renditions/720p4/segments/1.m4s`)?.toString(),
      "last-fragment",
    );
    const manifest = JSON.parse(uploads.get(`${root}/manifest.json`));
    assert.equal(manifest.ended, true);
    assert.equal(manifest.renditions[0].segments.at(-1)[0], 1);
  } finally {
    await coordinator.close();
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("CMAF manifest failures back off and recover without freezing publication", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "synced-cmaf-retry-"));
  const originalFetch = globalThis.fetch;
  let manifestAttempts = 0;
  let publishedManifest;
  const diagnostics = [];
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    if (pathname.endsWith("/manifest.json")) {
      manifestAttempts += 1;
      if (manifestAttempts <= 3) {
        return new Response(null, { status: 503 });
      }
      publishedManifest = JSON.parse(Buffer.concat(chunks));
    }
    return new Response(null, { status: 201 });
  };
  const coordinator = new CmafRelayCoordinator(
    {
      baseUrl: new URL("https://relay.example/media/v1/"),
      token: "t".repeat(96),
      roomId: "23456789",
      sessionId: "session-retry",
      assetId: "1111111111111111111111111111111111111111",
      mediaVersion: 3,
    },
    {
      cacheDir,
      maxDiskBytes: 256 * 1024 * 1024,
      sendEvent: (event) => diagnostics.push(event),
    },
  );
  try {
    coordinator.publishInit(
      "720p4",
      plan("720p4", 720, 4_000_000),
      'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
      Buffer.from("init"),
      "Retry fixture",
    );
    coordinator.publishFragment("720p4", {
      sequence: 1,
      mediaTimeMs: 0,
      keyframe: true,
      data: Buffer.from("segment"),
    });
    await waitFor(() => publishedManifest, 4_000);
    assert.equal(manifestAttempts, 4);
    assert.equal(publishedManifest.renditions[0].segments[0][0], 1);
    assert.equal(
      diagnostics.filter(
        ({ code }) => code === "segment-manifest-upload-failed",
      ).length,
      1,
    );
  } finally {
    await coordinator.close();
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("publisher reconciles an LRU tombstone and continues anchor and ended publication", async () => {
  const relayDir = await mkdtemp(
    path.join(tmpdir(), "synced-cmaf-relay-sync-"),
  );
  const spoolDir = await mkdtemp(
    path.join(tmpdir(), "synced-cmaf-spool-sync-"),
  );
  const relay = createSegmentRelay({
    rootDir: relayDir,
    secret: "coordinated-relay-test-secret",
  });
  const server = await listenRelay(relay);
  const roomId = "23456789";
  const sessionId = "session-coordinated-lru";
  const assetId = "abababababababababababababababababababab";
  const mediaVersion = 1;
  const root =
    `/media/v1/rooms/${roomId}/sessions/${sessionId}/assets/` +
    `${assetId}/versions/${mediaVersion}`;
  const publish = relay.issueToken({
    room: roomId,
    clientId: "host",
    scope: "publish",
  });
  const read = relay.issueToken({
    room: roomId,
    clientId: "viewer",
    scope: "read",
  });
  relay.activateSession(roomId, sessionId);
  const diagnostics = [];
  const coordinator = new CmafRelayCoordinator(
    {
      baseUrl: new URL(`${server.baseUrl}/media/v1/`),
      token: publish.token,
      roomId,
      sessionId,
      assetId,
      mediaVersion,
    },
    {
      cacheDir: spoolDir,
      maxDiskBytes: 256 * 1024 * 1024,
      sendEvent: (event) => diagnostics.push(event),
    },
  );
  const readManifest = async () => {
    const response = await fetch(`${server.baseUrl}${root}/manifest.json`, {
      headers: authorization(read.token),
    });
    return response.ok ? response.json() : undefined;
  };
  try {
    coordinator.updatePlaybackAnchor(510_000_000);
    coordinator.registerProducer("720p4");
    coordinator.publishInit(
      "720p4",
      plan("720p4", 720, 4_000_000),
      'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
      Buffer.from("coordinated-init"),
      "Coordinated LRU",
    );
    for (const [sequence, mediaTimeMs] of [
      [1, 0],
      [2, 20_000],
      [3, 40_000],
    ]) {
      coordinator.publishFragment("720p4", {
        sequence,
        mediaTimeMs,
        keyframe: true,
        data: Buffer.from(`coordinated-segment-${sequence}`),
      });
    }
    await waitFor(async () => {
      const manifest = await readManifest();
      return manifest?.renditions?.[0]?.segments?.length === 3
        ? manifest
        : undefined;
    });

    relay.store.maxDiskBytes = Math.max(
      1,
      relay.snapshot().diskBytes - 1,
    );
    relay.store.evict();
    const trimmed = await waitFor(async () => {
      const manifest = await readManifest();
      return manifest?.evictionRevision >= 1 &&
        manifest.renditions?.[0]?.segments?.[0]?.[0] === 3
        ? manifest
        : undefined;
    });
    assert.deepEqual(
      trimmed.renditions[0].segments.map((segment) => segment[0]),
      [3],
    );

    coordinator.updatePlaybackAnchor(530_000_000);
    const resumed = await waitFor(async () => {
      const manifest = await readManifest();
      return manifest?.playbackTimeMs === 53_000 &&
        manifest.acknowledgedEvictionRevision ===
          manifest.evictionRevision &&
        manifest.renditions?.[0]?.segments?.[0]?.[0] === 3
        ? manifest
        : undefined;
    });
    assert.ok(resumed.revision > trimmed.revision);
    assert.ok(
      diagnostics.some(
        ({ code }) => code === "segment-manifest-reconciled",
      ),
    );

    const serverSegmentKey =
      `${roomId}/${sessionId}/${assetId}/${mediaVersion}/720p4/3`;
    const missingRecord = relay.store.records.get(serverSegmentKey);
    assert.ok(missingRecord);
    relay.store.records.delete(serverSegmentKey);
    relay.store.diskBytes = Math.max(
      0,
      relay.store.diskBytes - missingRecord.bytes,
    );
    if (missingRecord.buffer) {
      relay.store.memoryBytes = Math.max(
        0,
        relay.store.memoryBytes - missingRecord.buffer.byteLength,
      );
    }
    await rm(missingRecord.filePath, { force: true });

    coordinator.updatePlaybackAnchor(540_000_000);
    const repaired = await waitFor(async () => {
      const manifest = await readManifest();
      return manifest?.playbackTimeMs === 54_000 &&
        manifest.renditions?.[0]?.segments?.[0]?.[0] === 3
        ? manifest
        : undefined;
    });
    assert.ok(repaired.revision > resumed.revision);
    const repairedSegment = await fetch(
      `${server.baseUrl}${root}/renditions/720p4/segments/3.m4s`,
      { headers: authorization(read.token) },
    );
    assert.equal(repairedSegment.status, 200);

    coordinator.markRenditionEnded("720p4");
    const ended = await waitFor(async () => {
      const manifest = await readManifest();
      return manifest?.renditions?.[0]?.ended === true
        ? manifest
        : undefined;
    });
    assert.equal(ended.playbackTimeMs, 54_000);
    assert.equal(ended.renditions[0].finalSequence, 3);
  } finally {
    await coordinator.close();
    await server.close();
    await relay.close();
    await rm(spoolDir, { recursive: true, force: true });
    await rm(relayDir, { recursive: true, force: true });
  }
});

test("CMAF uploads are serial within a rendition and concurrent across renditions", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "synced-cmaf-order-"));
  const originalFetch = globalThis.fetch;
  const started = [];
  const uploads = new Map();
  const blocked = deferred();
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    started.push(pathname);
    if (pathname.endsWith("/renditions/720p4/segments/1.m4s")) {
      await blocked.promise;
    }
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    uploads.set(pathname, Buffer.concat(chunks));
    return new Response(null, { status: 201 });
  };
  const coordinator = new CmafRelayCoordinator(
    {
      baseUrl: new URL("https://relay.example/media/v1/"),
      token: "t".repeat(96),
      roomId: "23456789",
      sessionId: "session-order",
      assetId: "2222222222222222222222222222222222222222",
      mediaVersion: 1,
    },
    { cacheDir, maxDiskBytes: 256 * 1024 * 1024 },
  );
  try {
    for (const [id, height, bitrate] of [
      ["720p4", 720, 4_000_000],
      ["1080p8", 1_080, 8_000_000],
    ]) {
      coordinator.publishInit(
        id,
        plan(id, height, bitrate),
        'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
        Buffer.from(`init-${id}`),
        "Ordering",
      );
      coordinator.publishFragment(id, {
        sequence: 1,
        mediaTimeMs: 0,
        keyframe: true,
        data: Buffer.from(`${id}-one`),
      });
      coordinator.publishFragment(id, {
        sequence: 2,
        mediaTimeMs: 2_000,
        keyframe: true,
        data: Buffer.from(`${id}-two`),
      });
    }
    await waitFor(() =>
      started.some((value) =>
        value.endsWith("/renditions/720p4/segments/1.m4s"),
      ),
    );
    await waitFor(() =>
      started.some((value) =>
        value.endsWith("/renditions/1080p8/segments/1.m4s"),
      ),
    );
    assert.equal(
      started.some((value) =>
        value.endsWith("/renditions/720p4/segments/2.m4s"),
      ),
      false,
      "a later segment must not overtake the blocked head of its rendition",
    );
    blocked.resolve();
    const manifestPath =
      "/media/v1/rooms/23456789/sessions/session-order/assets/" +
      "2222222222222222222222222222222222222222/versions/1/manifest.json";
    const manifest = await waitFor(() => {
      const body = uploads.get(manifestPath);
      if (!body) return undefined;
      const parsed = JSON.parse(body);
      return parsed.renditions.length === 2 &&
        parsed.renditions.every((item) => item.segments.length === 2)
        ? parsed
        : undefined;
    });
    for (const rendition of manifest.renditions) {
      assert.deepEqual(
        rendition.segments.map((segment) => segment[0]),
        [1, 2],
      );
    }
  } finally {
    blocked.resolve();
    await coordinator.close();
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("failed CMAF records recover on their own without a token change", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "synced-cmaf-actor-"));
  const originalFetch = globalThis.fetch;
  let segmentAttempts = 0;
  let publishedManifest;
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    if (pathname.endsWith("/renditions/720p4/segments/1.m4s")) {
      segmentAttempts += 1;
      if (segmentAttempts <= 3) {
        return new Response(null, { status: 503 });
      }
    }
    if (pathname.endsWith("/manifest.json")) {
      publishedManifest = JSON.parse(Buffer.concat(chunks));
    }
    return new Response(null, { status: 201 });
  };
  const coordinator = new CmafRelayCoordinator(
    {
      baseUrl: new URL("https://relay.example/media/v1/"),
      token: "t".repeat(96),
      roomId: "23456789",
      sessionId: "session-retry-actor",
      assetId: "3333333333333333333333333333333333333333",
      mediaVersion: 1,
    },
    {
      cacheDir,
      maxDiskBytes: 256 * 1024 * 1024,
      random: () => 0.5,
    },
  );
  try {
    coordinator.publishInit(
      "720p4",
      plan("720p4", 720, 4_000_000),
      'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
      Buffer.from("init"),
      "Retry actor",
    );
    coordinator.publishFragment("720p4", {
      sequence: 1,
      mediaTimeMs: 0,
      keyframe: true,
      data: Buffer.from("eventually-uploaded"),
    });
    const recovered = await waitFor(
      () =>
        publishedManifest?.renditions?.[0]?.segments?.[0]?.[0] === 1,
      4_500,
    );
    assert.equal(recovered, true);
    assert.equal(segmentAttempts, 4);
  } finally {
    await coordinator.close();
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("restarted rendition uses a new init epoch and monotonic global segment sequence", async () => {
  const cacheDir = await mkdtemp(
    path.join(tmpdir(), "synced-cmaf-epoch-"),
  );
  const originalFetch = globalThis.fetch;
  const uploads = new Map();
  globalThis.fetch = async (url, options) => {
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    uploads.set(new URL(url).pathname, Buffer.concat(chunks));
    return new Response(null, { status: 201 });
  };
  const coordinator = new CmafRelayCoordinator(
    {
      baseUrl: new URL("https://relay.example/media/v1/"),
      token: "t".repeat(96),
      roomId: "23456789",
      sessionId: "session-rendition-epoch",
      assetId: "5555555555555555555555555555555555555555",
      mediaVersion: 1,
    },
    { cacheDir, maxDiskBytes: 256 * 1024 * 1024 },
  );
  try {
    coordinator.registerProducer("original");
    coordinator.publishInit(
      "original",
      plan("original", 1_080, 15_000_000, "DirectPlay"),
      'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
      Buffer.from("init-epoch-one"),
      "Epoch fixture",
    );
    coordinator.publishFragment("original", {
      sequence: 1,
      mediaTimeMs: 0,
      keyframe: true,
      data: Buffer.from("segment-global-one"),
    });
    await waitFor(() =>
      [...uploads.keys()].some((value) =>
        value.endsWith("/renditions/original/segments/1.m4s"),
      ),
    );

    coordinator.unregisterProducer("original");
    coordinator.updatePlaybackAnchor(900_000_000);
    coordinator.registerProducer("original");
    coordinator.publishInit(
      "original",
      {
        ...plan("original", 1_080, 15_000_000, "DirectPlay"),
        startTimeTicks: 900_000_000,
      },
      'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
      Buffer.from("init-epoch-two"),
      "Epoch fixture",
    );
    coordinator.publishFragment("original", {
      sequence: 1,
      mediaTimeMs: 90_000,
      keyframe: true,
      data: Buffer.from("segment-global-two"),
    });
    const root =
      "/media/v1/rooms/23456789/sessions/session-rendition-epoch/assets/" +
      "5555555555555555555555555555555555555555/versions/1";
    const manifest = await waitFor(() => {
      const body = uploads.get(`${root}/manifest.json`);
      if (!body) return undefined;
      const parsed = JSON.parse(body);
      return parsed.renditions?.[0]?.epoch === 2 &&
        parsed.renditions[0].segments?.at(-1)?.[0] === 2
        ? parsed
        : undefined;
    });
    assert.equal(
      uploads.get(`${root}/renditions/original/epochs/1/init.mp4`)?.toString(),
      "init-epoch-one",
    );
    assert.equal(
      uploads.get(`${root}/renditions/original/epochs/2/init.mp4`)?.toString(),
      "init-epoch-two",
    );
    assert.equal(
      uploads.get(`${root}/renditions/original/segments/2.m4s`)?.toString(),
      "segment-global-two",
    );
    assert.equal(manifest.renditions[0].initPath, `${root}/renditions/original/epochs/2/init.mp4`);
  } finally {
    await coordinator.close();
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("optional rendition idle expiry stops and removes the child before an anchored restart", async () => {
  const created = [];
  const demandChanges = [];
  const relayCoordinator = {
    uploadBudgetBps: Number.POSITIVE_INFINITY,
    playbackAnchorTimeMs: 90_000,
    setUploadBudget: () => Number.POSITIVE_INFINITY,
    setRenditionDemandActive: (id, active) => {
      demandChanges.push([id, active]);
    },
    deactivateProducer: () => {},
  };
  const service = new EmbyService({
    relayCoordinator,
    auxiliaryIdleMs: 1_000,
    auxiliaryServiceFactory: (options) => {
      const child = {
        starts: [],
        stops: [],
        async startStream(input) {
          this.starts.push(input);
          return { pipelineId: `child-${created.length}` };
        },
        async stopStream(reason) {
          this.stops.push(reason);
          options.sendEvent({
            type: "stopped",
            pipelineId: `child-${created.length}`,
            reason,
          });
        },
      };
      created.push(child);
      return child;
    },
  });
  service.pipeline = { id: "parent", stopping: false };
  service.auxiliarySourceInput = {
    itemId: "item",
    startTimeTicks: 0,
  };
  service.updateRenditionDemand({ original: true });
  const firstOriginal = await waitFor(() =>
    service.auxiliaryServices.get("original"),
  );
  assert.equal(firstOriginal.starts.length, 1);

  service.updateRenditionDemand({});
  await waitFor(
    () =>
      firstOriginal.stops.includes("rendition-idle") &&
      !service.auxiliaryServices.has("original"),
    2_000,
  );
  relayCoordinator.playbackAnchorTimeMs = 80_000;
  service.updateRenditionDemand({ original: true });
  const secondOriginal = await waitFor(() => {
    const candidate = service.auxiliaryServices.get("original");
    return candidate && candidate !== firstOriginal
      ? candidate
      : undefined;
  });
  assert.equal(secondOriginal.starts[0].startTimeTicks, 800_000_000);
  assert.ok(
    demandChanges.some(
      ([id, active]) => id === "original" && active === false,
    ),
  );
  assert.ok(
    demandChanges.some(
      ([id, active]) => id === "original" && active === true,
    ),
  );
});

test("CMAF starts one default auxiliary and allows only one demanded extra", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "synced-cmaf-demand-"));
  const coordinator = new CmafRelayCoordinator(
    {
      baseUrl: new URL("https://relay.example/media/v1/"),
      token: "t".repeat(96),
      roomId: "23456789",
      sessionId: "session-demand",
      assetId: "4444444444444444444444444444444444444444",
      mediaVersion: 1,
    },
    { cacheDir, maxDiskBytes: 256 * 1024 * 1024 },
  );
  try {
    const service = new EmbyService({ relayCoordinator: coordinator });
    const initial = service.updateRenditionDemand({
      availableUploadBps: 20_000_000,
    });
    assert.deepEqual(initial.active, ["720p4"]);
    assert.equal(initial.uploadBudgetBps, 13_000_000);
    const expanded = service.updateRenditionDemand({
      original: true,
      low: true,
      availableUploadBps: 20_000_000,
    });
    assert.deepEqual(new Set(expanded.active), new Set(["720p4", "480p18"]));
    assert.equal(coordinator.renditions.has("original"), false);
    assert.equal(coordinator.renditions.get("480p18").demandPaused, false);
    const exhausted = service.updateRenditionDemand({
      availableUploadBps: 100_000,
    });
    assert.equal(exhausted.uploadBudgetBps, 0);
    assert.equal(coordinator.renditions.get("720p4").budgetPaused, true);
    const restored = service.updateRenditionDemand({
      availableUploadBps: 20_000_000,
    });
    assert.equal(restored.uploadBudgetBps, 13_000_000);
    assert.equal(coordinator.renditions.get("720p4").budgetPaused, false);
  } finally {
    await coordinator.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("canonical rendition ids avoid duplicate default ladder encoders", () => {
  assert.equal(renditionIdForQuality({ key: "original" }), "original");
  assert.equal(renditionIdForQuality({ key: "1080p-8" }), "1080p8");
  assert.equal(renditionIdForQuality({ key: "720p-4" }), "720p4");
  assert.equal(renditionIdForQuality({ key: "480p-1.8" }), "480p18");
  assert.equal(
    renditionIdForQuality({ key: "1440p-18" }),
    "selected-1440p-18",
  );
});
