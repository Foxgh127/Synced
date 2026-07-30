import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createSegmentRelay,
  SegmentRelayStore,
} from "../server/segment-relay.mjs";

const ROOM = "23456789";
const OTHER_ROOM = "3456789A";
const SESSION = "session-fixture";
const ASSET = "0123456789abcdef0123456789abcdef01234567";
const VERSION = 7;
const ROOT =
  `/media/v1/rooms/${ROOM}/sessions/${SESSION}/assets/${ASSET}/` +
  `versions/${VERSION}`;

async function listen(relay) {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void relay.handle(request, response, url).then((handled) => {
      if (!handled && !response.headersSent) {
        response.writeHead(404, { "content-length": "0" });
        response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function authorization(token) {
  return { authorization: `Bearer ${token}` };
}

test("segment relay scopes tokens and serves immutable ranged CMAF objects", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "synced-relay-test-"));
  let clock = 1_900_000_000_000;
  const relay = createSegmentRelay({
    rootDir,
    secret: "fixture-secret-with-enough-entropy-for-tests",
    now: () => clock,
    originAllowed: (origin) => origin === "https://app.example",
    authorizeIdentity: (identity, requiredScope) =>
      requiredScope === "publish"
        ? identity.clientId === "host"
        : ["host", "viewer"].includes(identity.clientId),
  });
  const server = await listen(relay);
  try {
    const publish = relay.issueToken({
      room: ROOM,
      clientId: "host",
      scope: "publish",
      lifetimeMs: 120_000,
    });
    const read = relay.issueToken({
      room: ROOM,
      clientId: "viewer",
      scope: "read",
      lifetimeMs: 120_000,
    });
    const wrongRoom = relay.issueToken({
      room: OTHER_ROOM,
      clientId: "viewer",
      scope: "read",
      lifetimeMs: 120_000,
    });
    const init = Buffer.from("fixture-init");
    const segment = Buffer.from("0123456789abcdef");
    const initPath = `${ROOT}/renditions/720p4/init.mp4`;
    const segmentPath = `${ROOT}/renditions/720p4/segments/1.m4s`;
    const manifestPath = `${ROOT}/manifest.json`;
    const manifest = {
      protocol: "synced-cmaf-v1",
      segmentEncoding: "tuple-v1",
      roomId: ROOM,
      sessionId: SESSION,
      assetId: ASSET,
      mediaVersion: VERSION,
      title: "Fixture",
      startTimeTicks: 0,
      updatedAt: clock,
      renditions: [
        {
          id: "720p4",
          label: "720p",
          width: 1280,
          height: 720,
          frameRate: 30,
          bitrate: 4_000_000,
          mimeType: 'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
          switchGroup: "fixture",
          initPath,
          segments: [[1, 0, 0, 2_000, 1, segment.length]],
        },
      ],
    };

    for (const [url, body, contentType] of [
      [initPath, init, "video/mp4"],
      [segmentPath, segment, "video/iso.segment"],
      [manifestPath, Buffer.from(JSON.stringify(manifest)), "application/json"],
    ]) {
      const response = await fetch(`${server.baseUrl}${url}`, {
        method: "PUT",
        headers: {
          ...authorization(publish.token),
          "content-type": contentType,
          "content-length": String(body.length),
        },
        body,
      });
      assert.equal(response.status, 201);
      assert.match(response.headers.get("etag") || "", /^"[a-f0-9]{64}"$/);
    }

    const full = await fetch(`${server.baseUrl}${segmentPath}`, {
      headers: {
        ...authorization(read.token),
        origin: "https://app.example",
      },
    });
    assert.equal(full.status, 200);
    assert.equal(
      full.headers.get("access-control-allow-origin"),
      "https://app.example",
    );
    assert.equal(Buffer.from(await full.arrayBuffer()).toString(), segment.toString());
    const etag = full.headers.get("etag");

    const ranged = await fetch(`${server.baseUrl}${segmentPath}`, {
      headers: {
        ...authorization(read.token),
        range: "bytes=4-9",
      },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 4-9/16");
    assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), "456789");

    const head = await fetch(`${server.baseUrl}${segmentPath}`, {
      method: "HEAD",
      headers: authorization(read.token),
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "16");

    const unchanged = await fetch(`${server.baseUrl}${segmentPath}`, {
      headers: {
        ...authorization(read.token),
        "if-none-match": etag,
      },
    });
    assert.equal(unchanged.status, 304);

    const idempotentUpload = await fetch(`${server.baseUrl}${segmentPath}`, {
      method: "PUT",
      headers: {
        ...authorization(publish.token),
        "content-type": "video/iso.segment",
        "content-length": String(segment.length),
      },
      body: segment,
    });
    assert.equal(idempotentUpload.status, 201);

    const conflictingUpload = await fetch(`${server.baseUrl}${segmentPath}`, {
      method: "PUT",
      headers: {
        ...authorization(publish.token),
        "content-type": "video/iso.segment",
        "content-length": "9",
      },
      body: "corrupted",
    });
    assert.equal(conflictingUpload.status, 409);
    const preserved = await fetch(`${server.baseUrl}${segmentPath}`, {
      headers: authorization(read.token),
    });
    assert.equal(
      Buffer.from(await preserved.arrayBuffer()).toString(),
      segment.toString(),
    );

    const invalidRange = await fetch(`${server.baseUrl}${segmentPath}`, {
      headers: {
        ...authorization(read.token),
        range: "bytes=99-100",
      },
    });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get("content-range"), "bytes */16");

    const readCannotPublish = await fetch(`${server.baseUrl}${segmentPath}`, {
      method: "PUT",
      headers: {
        ...authorization(read.token),
        "content-length": "1",
      },
      body: "x",
    });
    assert.equal(readCannotPublish.status, 403);

    const wrongRoomResponse = await fetch(`${server.baseUrl}${segmentPath}`, {
      headers: authorization(wrongRoom.token),
    });
    assert.equal(wrongRoomResponse.status, 403);

    const deniedOrigin = await fetch(`${server.baseUrl}${segmentPath}`, {
      headers: {
        ...authorization(read.token),
        origin: "https://evil.example",
      },
    });
    assert.equal(deniedOrigin.status, 403);

    clock = read.expiresAt + 1;
    const expired = await fetch(`${server.baseUrl}${segmentPath}`, {
      headers: authorization(read.token),
    });
    assert.equal(expired.status, 403);
    assert.equal(relay.snapshot().objects, 3);
  } finally {
    await server.close();
    await relay.close();
  }

  const reloaded = new SegmentRelayStore({ rootDir });
  try {
    assert.equal(reloaded.snapshot().objects, 3);
    reloaded.deleteRoom(ROOM);
    assert.equal(reloaded.snapshot().objects, 0);
  } finally {
    await reloaded.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("segment relay rejects a manifest whose route identity is forged", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "synced-relay-test-"));
  const relay = createSegmentRelay({
    rootDir,
    secret: "fixture-secret-with-enough-entropy-for-tests",
  });
  const server = await listen(relay);
  try {
    const publish = relay.issueToken({
      room: ROOM,
      clientId: "host",
      scope: "publish",
    });
    const response = await fetch(`${server.baseUrl}${ROOT}/manifest.json`, {
      method: "PUT",
      headers: {
        ...authorization(publish.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: "synced-cmaf-v1",
        roomId: OTHER_ROOM,
        sessionId: SESSION,
        assetId: ASSET,
        mediaVersion: VERSION,
        renditions: [],
      }),
    });
    assert.equal(response.status, 400);
  } finally {
    await server.close();
    await relay.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("segment relay rejects cross-asset media paths in a manifest", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "synced-relay-path-"));
  const relay = createSegmentRelay({
    rootDir,
    secret: "fixture-secret-with-enough-entropy-for-tests",
  });
  const server = await listen(relay);
  try {
    const publish = relay.issueToken({
      room: ROOM,
      clientId: "host",
      scope: "publish",
    });
    const response = await fetch(`${server.baseUrl}${ROOT}/manifest.json`, {
      method: "PUT",
      headers: {
        ...authorization(publish.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: "synced-cmaf-v1",
        roomId: ROOM,
        sessionId: SESSION,
        assetId: ASSET,
        mediaVersion: VERSION,
        renditions: [
          {
            id: "720p4",
            bitrate: 4_000_000,
            mimeType: 'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
            initPath: `${ROOT}/renditions/720p4/init.mp4`,
            segments: [
              {
                sequence: 1,
                mediaTimeMs: 0,
                timelineTimeMs: 0,
                durationMs: 2_000,
                keyframe: true,
                bytes: 16,
                path:
                  "/media/v1/rooms/23456789/sessions/session-fixture/assets/" +
                  "ffffffffffffffffffffffffffffffffffffffff/versions/7/" +
                  "renditions/720p4/segments/1.m4s",
              },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(relay.snapshot().objects, 0);
  } finally {
    await server.close();
    await relay.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("session namespaces isolate reused asset versions and conflicting concurrent PUTs stay immutable", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "synced-relay-session-"));
  const relay = createSegmentRelay({
    rootDir,
    secret: "fixture-secret-with-enough-entropy-for-tests",
  });
  const server = await listen(relay);
  try {
    const publish = relay.issueToken({
      room: ROOM,
      clientId: "host",
      scope: "publish",
    });
    const read = relay.issueToken({
      room: ROOM,
      clientId: "viewer",
      scope: "read",
    });
    const sessionOne =
      `/media/v1/rooms/${ROOM}/sessions/session-one/assets/${ASSET}/` +
      `versions/1/renditions/720p4/segments/1.m4s`;
    const sessionTwo =
      `/media/v1/rooms/${ROOM}/sessions/session-two/assets/${ASSET}/` +
      `versions/1/renditions/720p4/segments/1.m4s`;
    const first = Buffer.from("first-session-payload");
    const conflicting = Buffer.from("other-session-payload");
    const results = await Promise.all([
      fetch(`${server.baseUrl}${sessionOne}`, {
        method: "PUT",
        headers: {
          ...authorization(publish.token),
          "content-length": String(first.length),
        },
        body: first,
      }),
      fetch(`${server.baseUrl}${sessionOne}`, {
        method: "PUT",
        headers: {
          ...authorization(publish.token),
          "content-length": String(conflicting.length),
        },
        body: conflicting,
      }),
    ]);
    assert.deepEqual(
      results.map((response) => response.status).sort(),
      [201, 409],
    );
    const preserved = Buffer.from(
      await (
        await fetch(`${server.baseUrl}${sessionOne}`, {
          headers: authorization(read.token),
        })
      ).arrayBuffer(),
    );
    assert.ok(
      preserved.equals(first) || preserved.equals(conflicting),
      "the winner is preserved byte-for-byte",
    );

    const secondSessionUpload = await fetch(
      `${server.baseUrl}${sessionTwo}`,
      {
        method: "PUT",
        headers: {
          ...authorization(publish.token),
          "content-length": String(conflicting.length),
        },
        body: conflicting,
      },
    );
    assert.equal(secondSessionUpload.status, 201);
    const secondSessionRead = await fetch(
      `${server.baseUrl}${sessionTwo}`,
      { headers: authorization(read.token) },
    );
    assert.equal(
      Buffer.from(await secondSessionRead.arrayBuffer()).toString(),
      conflicting.toString(),
    );
  } finally {
    await server.close();
    await relay.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("active-session LRU trims only expired history and exposes a coordinated tombstone", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "synced-relay-lru-"));
  const relay = createSegmentRelay({
    rootDir,
    secret: "fixture-secret-with-enough-entropy-for-tests",
  });
  const server = await listen(relay);
  try {
    const publish = relay.issueToken({
      room: ROOM,
      clientId: "host",
      scope: "publish",
    });
    const read = relay.issueToken({
      room: ROOM,
      clientId: "viewer",
      scope: "read",
    });
    relay.activateSession(ROOM, SESSION);
    const initPath = `${ROOT}/renditions/720p4/init.mp4`;
    const segmentPath = (sequence) =>
      `${ROOT}/renditions/720p4/segments/${sequence}.m4s`;
    const objects = [
      [initPath, Buffer.from("init")],
      [segmentPath(1), Buffer.from("cold-one")],
      [segmentPath(2), Buffer.from("hot-two")],
      [segmentPath(3), Buffer.from("future-three")],
    ];
    for (const [url, body] of objects) {
      const response = await fetch(`${server.baseUrl}${url}`, {
        method: "PUT",
        headers: {
          ...authorization(publish.token),
          "content-length": String(body.length),
        },
        body,
      });
      assert.equal(response.status, 201);
    }
    const manifest = {
      protocol: "synced-cmaf-v1",
      segmentEncoding: "tuple-v1",
      roomId: ROOM,
      sessionId: SESSION,
      assetId: ASSET,
      mediaVersion: VERSION,
      revision: 1,
      evictionRevision: 0,
      acknowledgedEvictionRevision: 0,
      tombstones: [],
      title: "LRU fixture",
      startTimeTicks: 0,
      playbackTimeMs: 100_000,
      updatedAt: Date.now(),
      renditions: [
        {
          id: "720p4",
          bitrate: 4_000_000,
          mimeType: 'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
          initPath,
          segments: [
            [1, 0, 0, 2_000, 1, 8],
            [2, 80_000, 80_000, 2_000, 1, 7],
            [3, 200_000, 200_000, 2_000, 1, 12],
          ],
        },
      ],
    };
    const manifestBody = Buffer.from(JSON.stringify(manifest));
    const uploadedManifest = await fetch(
      `${server.baseUrl}${ROOT}/manifest.json`,
      {
        method: "PUT",
        headers: {
          ...authorization(publish.token),
          "content-length": String(manifestBody.length),
        },
        body: manifestBody,
      },
    );
    assert.equal(uploadedManifest.status, 201);
    const originalEtag = uploadedManifest.headers.get("etag");

    relay.store.maxDiskBytes = Math.max(
      1,
      relay.snapshot().diskBytes - 1,
    );
    relay.store.evict();

    const cold = await fetch(`${server.baseUrl}${segmentPath(1)}`, {
      headers: authorization(read.token),
    });
    assert.equal(cold.status, 404);
    const hot = await fetch(`${server.baseUrl}${segmentPath(2)}`, {
      headers: authorization(read.token),
    });
    assert.equal(hot.status, 200);
    const future = await fetch(`${server.baseUrl}${segmentPath(3)}`, {
      headers: authorization(read.token),
    });
    assert.equal(future.status, 200);
    const manifestResponse = await fetch(
      `${server.baseUrl}${ROOT}/manifest.json`,
      { headers: authorization(read.token) },
    );
    assert.equal(manifestResponse.status, 200);
    assert.notEqual(manifestResponse.headers.get("etag"), originalEtag);
    const trimmed = await manifestResponse.json();
    assert.deepEqual(
      trimmed.renditions[0].segments.map((segment) => segment[0]),
      [2, 3],
    );
    assert.equal(trimmed.evictionRevision, 1);
    assert.equal(trimmed.revision, 2);
    assert.deepEqual(trimmed.tombstones, [
      {
        renditionId: "720p4",
        throughSequence: 1,
        evictionRevision: 1,
      },
    ]);

    const staleManifest = {
      ...manifest,
      revision: 2,
      playbackTimeMs: 102_000,
      updatedAt: Date.now(),
    };
    const staleBody = Buffer.from(JSON.stringify(staleManifest));
    const rejected = await fetch(
      `${server.baseUrl}${ROOT}/manifest.json`,
      {
        method: "PUT",
        headers: {
          ...authorization(publish.token),
          "content-length": String(staleBody.length),
        },
        body: staleBody,
      },
    );
    assert.equal(rejected.status, 409);
    const conflict = await rejected.json();
    assert.equal(conflict.code, "manifest-revision-conflict");
    assert.equal(conflict.evictionRevision, 1);
    assert.deepEqual(conflict.tombstones, trimmed.tombstones);

    const coordinatedManifest = {
      ...trimmed,
      revision: 3,
      acknowledgedEvictionRevision: 1,
      playbackTimeMs: 102_000,
      ended: true,
      updatedAt: Date.now(),
    };
    const coordinatedBody = Buffer.from(
      JSON.stringify(coordinatedManifest),
    );
    // The hard cap is deliberately one byte below the pre-eviction store.
    // Make room for the larger coordinated manifest itself after asserting
    // that the cold segment was reclaimed.
    relay.store.maxDiskBytes += 4 * 1024;
    const resumed = await fetch(
      `${server.baseUrl}${ROOT}/manifest.json`,
      {
        method: "PUT",
        headers: {
          ...authorization(publish.token),
          "content-length": String(coordinatedBody.length),
        },
        body: coordinatedBody,
      },
    );
    assert.equal(resumed.status, 201);
    const finalManifest = await (
      await fetch(`${server.baseUrl}${ROOT}/manifest.json`, {
        headers: authorization(read.token),
      })
    ).json();
    assert.equal(finalManifest.playbackTimeMs, 102_000);
    assert.equal(finalManifest.ended, true);
  } finally {
    await server.close();
    await relay.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("active relay reclaims a far-future suffix and rejects writes past its hard cap", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "synced-relay-suffix-"));
  const relay = createSegmentRelay({
    rootDir,
    secret: "fixture-secret-with-enough-entropy-for-tests",
  });
  const server = await listen(relay);
  try {
    const publish = relay.issueToken({
      room: ROOM,
      clientId: "host",
      scope: "publish",
    });
    const read = relay.issueToken({
      room: ROOM,
      clientId: "viewer",
      scope: "read",
    });
    relay.activateSession(ROOM, SESSION);
    const initPath = `${ROOT}/renditions/720p4/init.mp4`;
    const segmentPath = (sequence) =>
      `${ROOT}/renditions/720p4/segments/${sequence}.m4s`;
    const init = await fetch(`${server.baseUrl}${initPath}`, {
      method: "PUT",
      headers: {
        ...authorization(publish.token),
        "content-length": "4",
      },
      body: "init",
    });
    assert.equal(init.status, 201);
    const timeline = [80_000, 100_000, 200_000, 400_000, 600_000];
    const segmentBytes = 1024 * 1024;
    for (let index = 0; index < timeline.length; index += 1) {
      const sequence = index + 1;
      const body = Buffer.alloc(segmentBytes, sequence);
      const response = await fetch(
        `${server.baseUrl}${segmentPath(sequence)}`,
        {
          method: "PUT",
          headers: {
            ...authorization(publish.token),
            "content-length": String(body.length),
            "x-synced-media-time-ms": String(timeline[index]),
            "x-synced-timeline-time-ms": String(timeline[index]),
            "x-synced-duration-ms": "2000",
            "x-synced-keyframe": "true",
          },
          body,
        },
      );
      assert.equal(response.status, 201);
    }
    const manifest = {
      protocol: "synced-cmaf-v1",
      segmentEncoding: "tuple-v1",
      roomId: ROOM,
      sessionId: SESSION,
      assetId: ASSET,
      mediaVersion: VERSION,
      revision: 1,
      evictionRevision: 0,
      acknowledgedEvictionRevision: 0,
      tombstones: [],
      title: "Suffix fixture",
      startTimeTicks: 0,
      playbackTimeMs: 100_000,
      ended: true,
      updatedAt: Date.now(),
      renditions: [
        {
          id: "720p4",
          bitrate: 4_000_000,
          mimeType: 'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
          initPath,
          ended: true,
          finalSequence: 5,
          finalTimelineEndMs: 602_000,
          segments: timeline.map((time, index) => [
            index + 1,
            time,
            time,
            2_000,
            1,
            segmentBytes,
          ]),
        },
      ],
    };
    const body = Buffer.from(JSON.stringify(manifest));
    const uploaded = await fetch(`${server.baseUrl}${ROOT}/manifest.json`, {
      method: "PUT",
      headers: {
        ...authorization(publish.token),
        "content-length": String(body.length),
      },
      body,
    });
    assert.equal(uploaded.status, 201);

    relay.store.maxDiskBytes = relay.snapshot().diskBytes - 1;
    relay.store.evict();
    assert.ok(
      relay.snapshot().diskBytes <= relay.store.maxDiskBytes,
      "eviction returns the active store to its configured hard ceiling",
    );
    for (const sequence of [1, 2, 3]) {
      const current = await fetch(
        `${server.baseUrl}${segmentPath(sequence)}`,
        { headers: authorization(read.token) },
      );
      assert.equal(current.status, 200);
    }
    for (const sequence of [4, 5]) {
      const farFuture = await fetch(
        `${server.baseUrl}${segmentPath(sequence)}`,
        { headers: authorization(read.token) },
      );
      assert.equal(farFuture.status, 404);
    }
    const trimmed = await (
      await fetch(`${server.baseUrl}${ROOT}/manifest.json`, {
        headers: authorization(read.token),
      })
    ).json();
    assert.deepEqual(
      trimmed.renditions[0].segments.map((segment) => segment[0]),
      [1, 2, 3],
    );
    assert.equal(trimmed.ended, false);
    assert.equal(trimmed.renditions[0].ended, false);
    assert.deepEqual(trimmed.tombstones, [
      {
        renditionId: "720p4",
        fromSequence: 4,
        evictionRevision: 1,
      },
    ]);

    const beforeRejectedWrite = relay.snapshot().diskBytes;
    relay.store.maxDiskBytes = beforeRejectedWrite + segmentBytes / 2;
    const rejectedBody = Buffer.alloc(segmentBytes, 6);
    const rejected = await fetch(
      `${server.baseUrl}${segmentPath(6)}`,
      {
        method: "PUT",
        headers: {
          ...authorization(publish.token),
          "content-length": String(rejectedBody.length),
          "x-synced-media-time-ms": "700000",
          "x-synced-timeline-time-ms": "700000",
          "x-synced-duration-ms": "2000",
          "x-synced-keyframe": "true",
        },
        body: rejectedBody,
      },
    );
    assert.equal(rejected.status, 507);
    assert.equal(rejected.headers.get("x-synced-storage-pressure"), "true");
    const pressure = await rejected.json();
    assert.equal(pressure.code, "storage-capacity-exceeded");
    assert.equal(pressure.storagePressure, true);
    assert.equal(relay.snapshot().diskBytes, beforeRejectedWrite);
    assert.ok(relay.snapshot().diskBytes <= relay.store.maxDiskBytes);
  } finally {
    await server.close();
    await relay.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
