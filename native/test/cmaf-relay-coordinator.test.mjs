import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CmafRelayCoordinator,
  renditionIdForQuality,
} from "../electron/emby-service.cjs";

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for relay coordinator");
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
      "/media/v1/rooms/23456789/assets/" +
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
      "/media/v1/rooms/23456789/assets/" +
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
      "/media/v1/rooms/23456789/assets/" +
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
