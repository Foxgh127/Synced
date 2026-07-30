import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/emby-segment-relay.ts")],
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

function rendition(id, height, bitrate) {
  return {
    id,
    label: id,
    width: Math.round((height * 16) / 9),
    height,
    frameRate: 30,
    bitrate,
    mimeType: 'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
    switchGroup: "fixture",
    initPath: `/media/v1/renditions/${id}/init.mp4`,
    segments: [],
  };
}

test("relay URL and asset identity are stable and credential-free", async () => {
  const {
    buildEmbySegmentRelayBaseUrl,
    deriveEmbyAssetId,
  } = await loadModule();
  const access = {
    basePath: "/media/v1",
    token: "token",
    scope: "read",
    expiresAt: Date.now() + 60_000,
  };
  assert.equal(
    buildEmbySegmentRelayBaseUrl(
      "wss://user:password@example.test/signal?secret=1#x",
      access,
    ).toString(),
    "https://example.test/media/v1/",
  );
  const first = await deriveEmbyAssetId("account", "item", "source");
  const second = await deriveEmbyAssetId("account", "item", "source");
  const different = await deriveEmbyAssetId("account", "item-2", "source");
  assert.match(first, /^[a-f0-9]{40}$/);
  assert.equal(first, second);
  assert.notEqual(first, different);
});

test("tuple manifests infer immutable segment paths and treat unknown keys as non-keyframes", async () => {
  const { parseEmbySegmentManifest } = await loadModule();
  const expected = {
    roomId: "23456789",
    assetId: "0123456789abcdef0123456789abcdef01234567",
    mediaVersion: 3,
    sessionId: "session",
  };
  const initPath =
    `/media/v1/rooms/${expected.roomId}/assets/${expected.assetId}/` +
    `versions/3/renditions/720p4/init.mp4`;
  const parsed = parseEmbySegmentManifest(
    {
      protocol: "synced-cmaf-v1",
      ...expected,
      sessionId: "session",
      title: "Fixture",
      updatedAt: 1,
      renditions: [
        {
          ...rendition("720p4", 720, 4_000_000),
          initPath,
          segments: [
            [2, 2_000, 2_000, 2_000, 0, 200],
            [1, 0, 0, 2_000, undefined, 100],
          ],
        },
      ],
    },
    expected,
  );
  assert.deepEqual(
    parsed.renditions[0].segments.map((segment) => ({
      sequence: segment.sequence,
      keyframe: segment.keyframe,
      path: segment.path,
    })),
    [
      {
        sequence: 1,
        keyframe: false,
        path: initPath.replace("init.mp4", "segments/1.m4s"),
      },
      {
        sequence: 2,
        keyframe: false,
        path: initPath.replace("init.mp4", "segments/2.m4s"),
      },
    ],
  );
  assert.throws(
    () =>
      parseEmbySegmentManifest(
        {
          protocol: "synced-cmaf-v1",
          ...expected,
          roomId: "3456789A",
          renditions: [rendition("720p4", 720, 4_000_000)],
        },
        expected,
      ),
    /身份不匹配/,
  );
  assert.throws(
    () =>
      parseEmbySegmentManifest(
        {
          protocol: "synced-cmaf-v1",
          ...expected,
          sessionId: "stale-session",
          renditions: [rendition("720p4", 720, 4_000_000)],
        },
        expected,
      ),
    /身份不匹配/,
  );
});

test("timeline lookup uses a spanning binary window on long manifests", async () => {
  const { embySegmentTimelineWindow } = await loadModule();
  const segments = Array.from({ length: 20_000 }, (_unused, index) => ({
    sequence: index + 1,
    mediaTimeMs: index * 2_000,
    timelineTimeMs: index * 2_000,
    durationMs: 2_000,
    keyframe: index % 2 === 0,
    bytes: 1,
    path: `/segments/${index + 1}.m4s`,
  }));
  assert.deepEqual(
    embySegmentTimelineWindow(segments, 19_999_500, 20_004_100).map(
      (segment) => segment.sequence,
    ),
    [10_000, 10_001, 10_002, 10_003],
  );
  assert.deepEqual(
    embySegmentTimelineWindow(segments, 50_000_000, 50_001_000),
    [],
  );
});

test("ABR downgrades immediately but upgrades one rung after 20 seconds and 1.5x headroom", async () => {
  const { selectEmbyAbrRendition } = await loadModule();
  const renditions = [
    rendition("480p18", 480, 1_800_000),
    rendition("720p4", 720, 4_000_000),
    rendition("1080p8", 1080, 8_000_000),
  ];
  assert.equal(
    selectEmbyAbrRendition(renditions, {
      throughputBps: 3_000_000,
      currentId: "1080p8",
      bufferAheadSeconds: 3,
      stableForMs: 1_000,
      upgradeHoldRemainingMs: 0,
    }).id,
    "480p18",
  );
  assert.equal(
    selectEmbyAbrRendition(renditions, {
      throughputBps: 13_000_000,
      currentId: "480p18",
      bufferAheadSeconds: 30,
      stableForMs: 19_999,
      upgradeHoldRemainingMs: 0,
    }).id,
    "480p18",
  );
  assert.equal(
    selectEmbyAbrRendition(renditions, {
      throughputBps: 13_000_000,
      currentId: "480p18",
      bufferAheadSeconds: 30,
      stableForMs: 20_000,
      upgradeHoldRemainingMs: 0,
    }).id,
    "720p4",
  );
  assert.equal(
    selectEmbyAbrRendition(renditions, {
      throughputBps: 30_000_000,
      preferredHeight: 720,
      currentId: "1080p8",
      bufferAheadSeconds: 30,
      stableForMs: 60_000,
      upgradeHoldRemainingMs: 0,
    }).id,
    "720p4",
  );
});

test("paced deep prefetch cannot poison the foreground ABR estimate", async () => {
  const { updateEmbyThroughputEstimate } = await loadModule();
  assert.equal(
    updateEmbyThroughputEstimate(20_000_000, 7_800_000, true),
    20_000_000,
  );
  assert.equal(
    updateEmbyThroughputEstimate(8_000_000, 20_000_000, false),
    11_360_000,
  );
  assert.equal(
    updateEmbyThroughputEstimate(8_000_000, Number.NaN, false),
    8_000_000,
  );
});

test("ABR polling advances an existing rendition snapshot without replaying old segments", async () => {
  const { EmbyAbrSegmentClient } = await loadModule();
  globalThis.window = globalThis;
  const roomId = "23456789";
  const assetId = "0123456789abcdef0123456789abcdef01234567";
  const mediaVersion = 9;
  const root =
    `/media/v1/rooms/${roomId}/assets/${assetId}/versions/${mediaVersion}`;
  const initPath = `${root}/renditions/720p4/init.mp4`;
  const media = new Map([
    [initPath, Uint8Array.of(1, 2, 3)],
    [`${root}/renditions/720p4/segments/1.m4s`, Uint8Array.of(11)],
    [`${root}/renditions/720p4/segments/2.m4s`, Uint8Array.of(22)],
  ]);
  let manifestCalls = 0;
  const manifest = (segments) => ({
    protocol: "synced-cmaf-v1",
    roomId,
    sessionId: "session-fixture",
    assetId,
    mediaVersion,
    title: "Fixture",
    startTimeTicks: 0,
    updatedAt: Date.now(),
    renditions: [
      {
        ...rendition("720p4", 720, 4_000_000),
        initPath,
        segments,
      },
    ],
  });
  const fetchImpl = async (url, options) => {
    assert.match(options.headers.authorization, /^Bearer /);
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/manifest.json")) {
      manifestCalls += 1;
      return new Response(
        JSON.stringify(
          manifest(
            manifestCalls === 1
              ? [[1, 0, 0, 2_000, 1, 1]]
              : [
                  [1, 0, 0, 2_000, 1, 1],
                  [2, 2_000, 2_000, 2_000, 1, 1],
                ],
          ),
        ),
        { status: 200 },
      );
    }
    const bytes = media.get(pathname);
    return bytes
      ? new Response(bytes, { status: 200 })
      : new Response(null, { status: 404 });
  };
  const fragments = [];
  const player = {
    currentTime: 0,
    bufferedAhead: 0,
    bufferProfile: { targetSeconds: 20 },
    configure() {},
    appendInit() {},
    appendFragment(fragment) {
      fragments.push(fragment);
    },
    applySubtitle() {},
  };
  const cacheValues = new Map();
  const client = new EmbyAbrSegmentClient({
    player,
    signalUrl: "wss://relay.example/signal",
    access: {
      basePath: "/media/v1",
      token: "token",
      scope: "read",
      expiresAt: Date.now() + 15 * 60_000,
    },
    fetchImpl,
    cache: {
      async get(key) {
        return cacheValues.get(key)?.slice();
      },
      async put(key, value) {
        cacheValues.set(key, value.slice());
      },
      async delete(key) {
        cacheValues.delete(key);
      },
      async close() {},
    },
  });
  try {
    client.start(
      {
        roomId,
        sessionId: "session-fixture",
        mediaVersion,
        mimeType: 'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
        plan: {},
        title: "Fixture",
      },
      {
        protocol: "synced-cmaf-v1",
        assetId,
        mediaVersion,
        manifestPath: `${root}/manifest.json`,
      },
    );
    const deadline = performance.now() + 2_000;
    while (fragments.length < 2 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(manifestCalls >= 2);
    assert.deepEqual(
      fragments.map(({ sequence, data }) => [sequence, [...data]]),
      [
        [1, [11]],
        [2, [22]],
      ],
      JSON.stringify(client.diagnostics),
    );
    assert.deepEqual(
      {
        id: client.diagnostics.renditionId,
        label: client.diagnostics.renditionLabel,
        width: client.diagnostics.renditionWidth,
        height: client.diagnostics.renditionHeight,
        frameRate: client.diagnostics.renditionFrameRate,
        bitrate: client.diagnostics.renditionBitrate,
      },
      {
        id: "720p4",
        label: "720p4",
        width: 1_280,
        height: 720,
        frameRate: 30,
        bitrate: 4_000_000,
      },
    );
  } finally {
    client.destroy();
  }
});

test("a stalled segment body aborts the underlying fetch before Range retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { EmbyAbrSegmentClient } = await loadModule();
  globalThis.window = globalThis;
  const requestSignals = [];
  const client = new EmbyAbrSegmentClient({
    player: {
      currentTime: 0,
      bufferedAhead: 0,
      bufferProfile: { targetSeconds: 20 },
    },
    signalUrl: "wss://relay.example/signal",
    access: {
      basePath: "/media/v1",
      token: "token",
      scope: "read",
      expiresAt: Date.now() + 60_000,
    },
    fetchImpl: async (_url, options) => {
      requestSignals.push(options.signal);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.of(1));
            options.signal.addEventListener(
              "abort",
              () =>
                controller.error(
                  new DOMException("aborted", "AbortError"),
                ),
              { once: true },
            );
          },
        }),
        {
          status: requestSignals.length === 1 ? 200 : 206,
          headers: { "content-length": "2" },
        },
      );
    },
    cache: {
      async get() {},
      async put() {},
      async delete() {},
      async close() {},
    },
  });
  const parent = new AbortController();
  const operation = client.fetchMediaBytes(
    new URL(
      "https://relay.example/media/v1/rooms/23456789/assets/" +
        "0123456789abcdef0123456789abcdef01234567/versions/1/" +
        "renditions/720p4/segments/1.m4s",
    ),
    {
      sequence: 1,
      mediaTimeMs: 0,
      timelineTimeMs: 0,
      durationMs: 2_000,
      keyframe: true,
      bytes: 2,
      path: "unused",
    },
    parent.signal,
    false,
  );
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestSignals[0].aborted, true);
  assert.ok(requestSignals.length >= 2);
  parent.abort("test-complete");
  await assert.rejects(operation);
  client.destroy();
});
