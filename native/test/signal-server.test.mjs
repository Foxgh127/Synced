import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import {
  createSignalServer,
  networkAdviceValidUntil,
  recommendedResolution,
} from "../server/index.mjs";

let server;
let baseUrl;
const inboxes = new WeakMap();
const roomAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function roomForOwnerToken(ownerToken) {
  const digest = createHash("sha256")
    .update(Buffer.from(ownerToken, "base64url"))
    .digest();
  const values = [
    digest[0] >>> 3,
    ((digest[0] & 0x07) << 2) | (digest[1] >>> 6),
    (digest[1] >>> 1) & 0x1f,
    ((digest[1] & 0x01) << 4) | (digest[2] >>> 4),
    ((digest[2] & 0x0f) << 1) | (digest[3] >>> 7),
    (digest[3] >>> 2) & 0x1f,
    ((digest[3] & 0x03) << 3) | (digest[4] >>> 5),
    digest[4] & 0x1f,
  ];
  return values.map((value) => roomAlphabet[value]).join("");
}

function ownerCredential(fill) {
  const bytes = Buffer.alloc(32, fill);
  const ownerToken = bytes.toString("base64url");
  return {
    room: roomForOwnerToken(ownerToken),
    ownerToken,
  };
}

function legacyConstructedTokenForRoom(room, fill = 97) {
  const bytes = Buffer.alloc(32, fill);
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = roomAlphabet.indexOf(room[index]);
  }
  return bytes.toString("base64url");
}

const capacityOwner = ownerCredential(31);
const broadcastOwner = ownerCredential(53);
const persistentOwner = ownerCredential(79);
const moderationOwner = ownerCredential(101);
const resumeOwner = ownerCredential(127);
const modeOwner = ownerCredential(151);
const restartOwner = ownerCredential(173);
const graceOwner = ownerCredential(183);

function sendMalformedWebSocketFrame(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("malformed WebSocket frame was not rejected"));
    }, 2_000);
    let response = "";
    let frameSent = false;
    socket.on("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        [
          "GET /signal HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${key}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (data) => {
      response += data.toString("latin1");
      if (!frameSent && response.includes("\r\n\r\n")) {
        frameSent = true;
        // A masked client frame with reserved opcode 0x3 is a protocol error.
        socket.write(Buffer.from([0x83, 0x80, 1, 2, 3, 4]));
      }
    });
    socket.on("error", () => {
      // ECONNRESET is an acceptable protocol-error shutdown.
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

before(async () => {
  server = createSignalServer({
    env: {
      ICE_SERVERS_JSON: JSON.stringify([
        { urls: ["stun:127.0.0.1:3478"] },
      ]),
      TURN_URLS: "turn:127.0.0.1:3478?transport=udp",
      TURN_SECRET: "test-secret",
      ALLOW_LEGACY_PROTOCOL: "true",
    },
  });
  const address = await server.listen(0, "127.0.0.1");
  baseUrl = `ws://127.0.0.1:${address.port}/signal`;
});

after(async () => {
  await server.close();
});

function openSocket(url = baseUrl, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const queue = [];
    const waiters = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type);
      if (waiterIndex >= 0) {
        waiters.splice(waiterIndex, 1)[0].resolve(message);
      } else {
        queue.push(message);
      }
    });
    inboxes.set(socket, { queue, waiters });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket, type) {
  const inbox = inboxes.get(socket);
  const queuedIndex = inbox.queue.findIndex((message) => !type || message.type === type);
  if (queuedIndex >= 0) {
    return Promise.resolve(inbox.queue.splice(queuedIndex, 1)[0]);
  }
  return new Promise((resolve) => {
    inbox.waiters.push({ type, resolve });
  });
}

function discardQueuedMessages(socket, type) {
  const inbox = inboxes.get(socket);
  inbox.queue = inbox.queue.filter((message) => message.type !== type);
}

function networkReport(overrides = {}) {
  return {
    probeVersion: 1,
    sampleId: `sample-${randomBytes(8).toString("hex")}`,
    uploadKbps: 50_000,
    downloadKbps: 100_000,
    signalRttMs: 35,
    jitterMs: 4,
    networkType: "ethernet",
    metered: false,
    measuredAt: Date.now(),
    ...overrides,
  };
}

test("uses the shared 30 fps quality policy for resolution advice", () => {
  assert.equal(recommendedResolution(17_999_999), "high");
  assert.equal(recommendedResolution(18_000_000), "ultra");
  assert.equal(recommendedResolution(32_000_000), "original");
});

test("caps advice validity at the earliest telemetry expiry", () => {
  const now = 1_000_000;
  const states = [
    {
      networkReport: {
        receivedAt: now - (5 * 60_000 - 1_250),
      },
      transportReports: new Map([
        [
          "broadcast:receive",
          {
            receivedAt: now - (20_000 - 2_500),
          },
        ],
      ]),
    },
  ];
  assert.equal(networkAdviceValidUntil(states, now), now + 1_250);
  assert.equal(networkAdviceValidUntil([{}], now), now + 35_000);
});

test("bounds WSS latency, upload, and download network probes", async () => {
  const socket = await openSocket();
  const probeId = "network-probe-round-01";

  const latencyResult = nextMessage(socket, "network:probe-result");
  socket.send(
    JSON.stringify({
      type: "network:probe",
      probeId,
      phase: "latency",
      sequence: 0,
      total: 1,
    }),
  );
  assert.deepEqual(await latencyResult, {
    type: "network:probe-result",
    probeId,
    phase: "latency",
    sequence: 0,
    total: 1,
  });

  const uploadResult = nextMessage(socket, "network:probe-result");
  socket.send(
    JSON.stringify({
      type: "network:probe",
      probeId,
      phase: "upload",
      sequence: 0,
      total: 1,
      payload: "u".repeat(32 * 1024),
    }),
  );
  assert.deepEqual(await uploadResult, {
    type: "network:probe-result",
    probeId,
    phase: "upload",
    sequence: 0,
    total: 1,
  });

  const downloadResult = nextMessage(socket, "network:probe-result");
  socket.send(
    JSON.stringify({
      type: "network:probe",
      probeId,
      phase: "download",
      sequence: 0,
      total: 1,
    }),
  );
  const download = await downloadResult;
  assert.equal(download.phase, "download");
  assert.equal(download.sequence, 0);
  assert.equal(Buffer.byteLength(download.payload, "utf8"), 32 * 1024);

  const duplicateError = nextMessage(socket, "error");
  socket.send(
    JSON.stringify({
      type: "network:probe",
      probeId,
      phase: "download",
      sequence: 0,
      total: 1,
    }),
  );
  assert.equal((await duplicateError).code, "network-probe-invalid");

  const sizeError = nextMessage(socket, "error");
  socket.send(
    JSON.stringify({
      type: "network:probe",
      probeId: "network-probe-round-02",
      phase: "upload",
      sequence: 0,
      total: 1,
      payload: "u".repeat(32 * 1024 + 1),
    }),
  );
  assert.equal((await sizeError).code, "network-probe-size-limit");

  for (const [phase, payload] of [
    ["upload", "u"],
    ["latency", undefined],
    ["download", undefined],
  ]) {
    const result = nextMessage(socket, "network:probe-result");
    socket.send(
      JSON.stringify({
        type: "network:probe",
        probeId: "network-probe-round-02",
        phase,
        sequence: 0,
        total: 1,
        ...(payload === undefined ? {} : { payload }),
      }),
    );
    assert.equal((await result).phase, phase);
  }

  const connectionRateError = nextMessage(socket, "error");
  socket.send(
    JSON.stringify({
      type: "network:probe",
      probeId: "network-probe-round-03",
      phase: "latency",
      sequence: 0,
      total: 1,
    }),
  );
  assert.equal(
    (await connectionRateError).code,
    "network-probe-rate-limit",
  );

  const invalidTotal = await openSocket();
  const totalError = nextMessage(invalidTotal, "error");
  invalidTotal.send(
    JSON.stringify({
      type: "network:probe",
      probeId: "network-probe-too-many",
      phase: "download",
      sequence: 0,
      total: 17,
    }),
  );
  assert.equal((await totalError).code, "network-probe-invalid");

  const targeted = await openSocket();
  const targetError = nextMessage(targeted, "error");
  targeted.send(
    JSON.stringify({
      type: "network:probe",
      probeId: "network-probe-targeted",
      phase: "latency",
      sequence: 0,
      total: 1,
      target: "https://internal.example",
    }),
  );
  assert.equal((await targetError).code, "network-probe-invalid");

  socket.close();
  invalidTotal.close();
  targeted.close();
});

test("publishes protocol-v3 capabilities and bounded v2 probes", async () => {
  const httpBaseUrl = baseUrl
    .replace(/^ws:/u, "http:")
    .replace(/\/signal$/u, "");
  const capabilitiesResponse = await fetch(`${httpBaseUrl}/capabilities`);
  assert.equal(capabilitiesResponse.status, 200);
  assert.match(
    capabilitiesResponse.headers.get("cache-control"),
    /no-store/,
  );
  const capabilities = await capabilitiesResponse.json();
  assert.equal(capabilities.protocolVersion, 3);
  assert.ok(capabilities.serverFeatures.includes("server-time"));
  assert.ok(capabilities.serverFeatures.includes("voice-policy-v2"));
  assert.deepEqual(capabilities.networkProbe.versions, [1, 2]);
  assert.equal(capabilities.networkProbe.version2.chunkBytes, 64 * 1024);
  assert.equal(
    capabilities.networkProbe.version2.maximumBytesPerDirection,
    2 * 1024 * 1024,
  );
  assert.equal(capabilities.voicePolicy.speechTargetBitrateBps, 256_000);

  const socket = await openSocket();
  const hello = await nextMessage(socket, "server:hello");
  assert.equal(hello.protocolVersion, 3);
  assert.equal(hello.networkProbe.version2.maximumChunks, 32);

  const requestedCapabilities = nextMessage(
    socket,
    "server:capabilities",
  );
  socket.send(JSON.stringify({ type: "capabilities:get" }));
  const requested = await requestedCapabilities;
  assert.equal(requested.relayCapacityBps, null);
  assert.equal(requested.relaySessionCapacityBps, null);
  assert.equal(requested.relayCapacityEnforced, false);

  const probeId = "network-probe-v2-round-01";
  const latencyResult = nextMessage(socket, "network:probe-result");
  socket.send(
    JSON.stringify({
      type: "network:probe",
      probeVersion: 2,
      probeId,
      phase: "latency",
      sequence: 0,
      total: 1,
    }),
  );
  const latency = await latencyResult;
  assert.equal(latency.probeVersion, 2);
  assert.ok(latency.serverSentAt >= latency.serverReceivedAt);

  const uploadResult = nextMessage(socket, "network:probe-result");
  socket.send(
    JSON.stringify({
      type: "network:probe",
      probeVersion: 2,
      probeId,
      phase: "upload",
      sequence: 0,
      total: 1,
      payload: "u".repeat(64 * 1024),
    }),
  );
  assert.equal((await uploadResult).phase, "upload");

  const downloadResult = nextMessage(socket, "network:probe-result");
  socket.send(
    JSON.stringify({
      type: "network:probe",
      probeVersion: 2,
      probeId,
      phase: "download",
      sequence: 0,
      total: 1,
      payloadBytes: 12_345,
    }),
  );
  const download = await downloadResult;
  assert.equal(Buffer.byteLength(download.payload), 12_345);
  assert.equal(download.completed, true);

  const metricsResponse = await fetch(`${httpBaseUrl}/metrics`);
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.text();
  assert.match(metrics, /synced_signal_network_probe_rounds_total\s+\d+/);
  assert.match(metrics, /synced_signal_network_probe_bytes_total\s+\d+/);
  socket.close();
});

test("issues scoped LiveKit access and refreshable TURN credentials", async () => {
  const apiKey = "synced_test";
  const apiSecret = "s".repeat(48);
  const credential = ownerCredential(207);
  const sfuServer = createSignalServer({
    env: {
      ICE_SERVERS_JSON: JSON.stringify([
        { urls: ["stun:127.0.0.1:3478"] },
      ]),
      TURN_URLS: "turn:127.0.0.1:3478?transport=udp",
      TURN_SECRET: "t".repeat(48),
      TURN_CREDENTIAL_TTL_SECONDS: "3600",
      SFU_ENABLED: "true",
      SFU_PUBLIC_URL: "wss://media.example.test/sfu",
      LIVEKIT_API_KEY: apiKey,
      LIVEKIT_API_SECRET: apiSecret,
      MAX_CLIENTS: "8",
      MAX_CLIENTS_PER_IP: "8",
    },
  });
  const address = await sfuServer.listen(0, "127.0.0.1");
  const socketUrl = `ws://127.0.0.1:${address.port}/signal`;
  const httpUrl = `http://127.0.0.1:${address.port}`;
  const host = await openSocket(socketUrl);
  const viewer = await openSocket(socketUrl);
  try {
    const hostJoinedMessage = nextMessage(host, "channel:joined");
    host.send(
      JSON.stringify({
        type: "channel:join",
        room: credential.room,
        nickname: "SFU 放映端",
        canBroadcast: true,
        createIfMissing: true,
        ownerToken: credential.ownerToken,
      }),
    );
    const hostJoined = await hostJoinedMessage;
    assert.equal(hostJoined.sfu.url, "wss://media.example.test/sfu");
    assert.equal(hostJoined.sfu.room, `synced-${credential.room.toLowerCase()}`);
    assert.ok(hostJoined.sfu.expiresAt > Date.now() + 5 * 60_000);
    assert.ok(hostJoined.iceRefreshToken);
    assert.ok(hostJoined.iceExpiresAt > Date.now());
    const [header, payload, signature] = hostJoined.sfu.token.split(".");
    assert.equal(
      signature,
      createHmac("sha256", apiSecret)
        .update(`${header}.${payload}`)
        .digest("base64url"),
    );
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(claims.iss, apiKey);
    assert.equal(claims.sub, hostJoined.clientId);
    assert.equal(claims.video.roomJoin, true);
    assert.equal(claims.video.canPublish, true);
    assert.equal(claims.video.canPublishData, true);
    assert.equal(claims.video.canSubscribe, true);

    const viewerJoinedMessage = nextMessage(viewer, "channel:joined");
    viewer.send(
      JSON.stringify({
        type: "channel:join",
        room: credential.room,
        nickname: "SFU 观看端",
        canBroadcast: false,
      }),
    );
    const viewerJoined = await viewerJoinedMessage;
    const viewerClaims = JSON.parse(
      Buffer.from(viewerJoined.sfu.token.split(".")[1], "base64url").toString(),
    );
    assert.equal(viewerClaims.video.canPublish, false);
    assert.equal(viewerClaims.video.canPublishData, true);

    const hostGranted = nextMessage(host, "broadcast:granted");
    const viewerSawBroadcast = nextMessage(viewer, "broadcast:started");
    host.send(
      JSON.stringify({
        type: "broadcast:start",
        broadcastCapabilities: {
          width: 2560,
          height: 1440,
          frameRate: 30,
        },
      }),
    );
    await hostGranted;
    await viewerSawBroadcast;
    discardQueuedMessages(host, "network:advice");

    const publisherActiveAdvice = nextMessage(host, "network:advice");
    host.send(
      JSON.stringify({
        type: "sfu:status",
        sfuRole: "publisher",
        active: true,
      }),
    );
    const publisherActive = await publisherActiveAdvice;
    assert.equal(publisherActive.networkAdvice.sfuPublisherActive, true);
    assert.equal(
      publisherActive.networkAdvice.p2pFallbackViewerCount,
      1,
    );

    const viewerActiveAdvice = nextMessage(host, "network:advice");
    viewer.send(
      JSON.stringify({
        type: "sfu:status",
        sfuRole: "viewer",
        active: true,
      }),
    );
    const viewerActive = await viewerActiveAdvice;
    assert.equal(viewerActive.networkAdvice.sfuPublisherActive, true);
    assert.equal(viewerActive.networkAdvice.p2pFallbackViewerCount, 0);

    const fallbackAdvice = nextMessage(host, "network:advice");
    viewer.send(
      JSON.stringify({
        type: "sfu:status",
        sfuRole: "viewer",
        active: false,
      }),
    );
    const fallback = await fallbackAdvice;
    assert.equal(fallback.networkAdvice.sfuPublisherActive, true);
    assert.equal(fallback.networkAdvice.p2pFallbackViewerCount, 1);

    const invalidStatus = nextMessage(viewer, "error");
    viewer.send(
      JSON.stringify({
        type: "sfu:status",
        sfuRole: "publisher",
        active: true,
      }),
    );
    assert.equal((await invalidStatus).code, "sfu-status-invalid");

    const pushedRefresh = nextMessage(host, "server:ice-refresh");
    host.send(JSON.stringify({ type: "ice:refresh" }));
    const refreshed = await pushedRefresh;
    assert.ok(Array.isArray(refreshed.iceServers));
    assert.ok(refreshed.iceExpiresAt > Date.now());

    const endpoint = await fetch(
      `${httpUrl}/iceservers?clientId=${encodeURIComponent(hostJoined.clientId)}`,
      {
        headers: {
          Authorization: `Bearer ${hostJoined.iceRefreshToken}`,
        },
      },
    );
    assert.equal(endpoint.status, 200);
    const endpointBody = await endpoint.json();
    assert.ok(Array.isArray(endpointBody.iceServers));
    assert.ok(endpointBody.iceExpiresAt > Date.now());
    const unauthorized = await fetch(
      `${httpUrl}/iceservers?clientId=${encodeURIComponent(hostJoined.clientId)}`,
    );
    assert.equal(unauthorized.status, 403);
  } finally {
    host.close();
    viewer.close();
    await sfuServer.close();
  }
});

test("serves a full 2 MiB v2 download probe without tripping backpressure", async () => {
  const socket = await openSocket();
  const probeId = "network-probe-v2-full-download";
  for (const [phase, payload] of [
    ["latency", undefined],
    ["upload", "u"],
  ]) {
    const result = nextMessage(socket, "network:probe-result");
    socket.send(
      JSON.stringify({
        type: "network:probe",
        probeVersion: 2,
        probeId,
        phase,
        sequence: 0,
        total: 1,
        ...(payload === undefined ? {} : { payload }),
      }),
    );
    await result;
  }
  const responses = Array.from({ length: 32 }, () =>
    nextMessage(socket, "network:probe-result"),
  );
  for (let sequence = 0; sequence < 32; sequence += 1) {
    socket.send(
      JSON.stringify({
        type: "network:probe",
        probeVersion: 2,
        probeId,
        phase: "download",
        sequence,
        total: 32,
        payloadBytes: 64 * 1024,
      }),
    );
  }
  const downloads = await Promise.all(responses);
  assert.equal(
    downloads.reduce(
      (bytes, message) => bytes + Buffer.byteLength(message.payload),
      0,
    ),
    2 * 1024 * 1024,
  );
  const pong = nextMessage(socket, "pong");
  socket.send(JSON.stringify({ type: "ping" }));
  await pong;
  socket.close();
});

test("unknown operations are identified without closing the healthy socket", async () => {
  const socket = await openSocket();
  const unsupported = nextMessage(socket, "error");
  socket.send(JSON.stringify({ type: "future:optional-feature" }));
  assert.deepEqual(await unsupported, {
    type: "error",
    code: "unsupported-operation",
    requestedType: "future:optional-feature",
    message: "不支持的操作",
  });
  const pong = nextMessage(socket, "pong");
  socket.send(JSON.stringify({ type: "ping" }));
  assert.equal((await pong).type, "pong");
  socket.close();
});

test("rate-limits complete network-probe rounds by source IP", async () => {
  const probeServer = createSignalServer({
    env: {
      MAX_CLIENTS: "32",
      MAX_CLIENTS_PER_IP: "16",
    },
  });
  const address = await probeServer.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const sockets = await Promise.all(
    Array.from({ length: 9 }, () => openSocket(url)),
  );
  try {
    for (let index = 0; index < sockets.length; index += 1) {
      const expectedType =
        index < 8 ? "network:probe-result" : "error";
      const response = nextMessage(sockets[index], expectedType);
      sockets[index].send(
        JSON.stringify({
          type: "network:probe",
          probeId: `network-ip-limit-${index}`,
          phase: "latency",
          sequence: 0,
          total: 1,
        }),
      );
      const message = await response;
      if (index < 8) {
        assert.equal(message.phase, "latency");
      } else {
        assert.equal(message.code, "network-probe-rate-limit");
      }
    }
  } finally {
    sockets.forEach((socket) => socket.close());
    await probeServer.close();
  }
});

test("debounces bursty network advice updates once per room", async () => {
  const debounceServer = createSignalServer({
    env: {
      MAX_CLIENTS: "8",
      MAX_CLIENTS_PER_IP: "8",
    },
  });
  const address = await debounceServer.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const credential = ownerCredential(212);
  const host = await openSocket(url);
  try {
    const joined = nextMessage(host, "channel:joined");
    const initialAdvice = nextMessage(host, "network:advice");
    host.send(
      JSON.stringify({
        type: "channel:join",
        room: credential.room,
        nickname: "防抖测试端",
        canBroadcast: true,
        createIfMissing: true,
        ownerToken: credential.ownerToken,
      }),
    );
    await joined;
    await initialAdvice;
    const before = debounceServer.metrics().adviceBroadcastsTotal;
    const burstAdvice = nextMessage(host, "network:advice");
    for (let index = 0; index < 12; index += 1) {
      host.send(
        JSON.stringify({
          type: "sfu:status",
          sfuRole: "viewer",
          active: index % 2 === 1,
        }),
      );
    }
    await burstAdvice;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      debounceServer.metrics().adviceBroadcastsTotal - before,
      1,
    );
  } finally {
    host.close();
    await debounceServer.close();
  }
});

test("keeps network reports private and sends revisioned room advice", async () => {
  const adviceServer = createSignalServer({
    env: {
      MAX_CLIENTS: "8",
      MAX_CLIENTS_PER_IP: "8",
    },
  });
  const address = await adviceServer.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const credential = ownerCredential(211);
  const outsider = await openSocket(url);
  const host = await openSocket(url);
  const viewer = await openSocket(url);
  try {
    const outsiderError = nextMessage(outsider, "error");
    outsider.send(
      JSON.stringify({
        type: "network:report",
        networkReport: networkReport(),
      }),
    );
    assert.equal(
      (await outsiderError).code,
      "network-report-not-joined",
    );

    const hostJoined = nextMessage(host, "channel:joined");
    const initialHostAdvice = nextMessage(host, "network:advice");
    host.send(
      JSON.stringify({
        type: "channel:join",
        room: credential.room,
        nickname: "网络放映端",
        canBroadcast: true,
        createIfMissing: true,
        ownerToken: credential.ownerToken,
      }),
    );
    const joinedHost = await hostJoined;
    assert.equal(joinedHost.protocolVersion, 3);
    assert.ok(joinedHost.serverFeatures.includes("network-probe"));
    assert.ok(joinedHost.serverFeatures.includes("network-probe-v2"));
    assert.ok(joinedHost.serverFeatures.includes("network-report"));
    assert.ok(
      joinedHost.serverFeatures.includes("network-transport-report"),
    );
    const adviceRevision1 = (await initialHostAdvice).networkAdvice;
    assert.equal(adviceRevision1.revision, 1);
    assert.equal(adviceRevision1.participantCount, 1);
    assert.equal(adviceRevision1.measuredCount, 0);
    assert.equal(adviceRevision1.confidence, "low");
    assert.equal(adviceRevision1.routeMode, "balanced");
    assert.equal(
      Object.hasOwn(adviceRevision1, "recommendedFrameRate"),
      false,
    );

    const viewerJoined = nextMessage(viewer, "channel:joined");
    const hostJoinAdvice = nextMessage(host, "network:advice");
    const viewerJoinAdvice = nextMessage(viewer, "network:advice");
    viewer.send(
      JSON.stringify({
        type: "channel:join",
        room: credential.room,
        nickname: "网络观看端",
        canBroadcast: false,
      }),
    );
    const joinedViewer = await viewerJoined;
    const adviceRevision2 = (await hostJoinAdvice).networkAdvice;
    assert.equal(adviceRevision2.revision, 2);
    assert.equal(adviceRevision2.participantCount, 2);
    assert.equal(
      (await viewerJoinAdvice).networkAdvice.revision,
      adviceRevision2.revision,
    );
    assert.ok(
      joinedViewer.participants.every(
        (participant) => !Object.hasOwn(participant, "networkReport"),
      ),
    );

    const hostReportAdvice = nextMessage(host, "network:advice");
    const viewerSawHostReport = nextMessage(viewer, "network:advice");
    const hostSample = networkReport({
      uploadKbps: 50_000,
      downloadKbps: 100_000,
      networkType: "ethernet",
    });
    host.send(
      JSON.stringify({
        type: "network:report",
        networkReport: hostSample,
      }),
    );
    const adviceRevision3 = (await hostReportAdvice).networkAdvice;
    assert.equal(adviceRevision3.revision, 3);
    assert.equal(adviceRevision3.measuredCount, 1);
    assert.equal(adviceRevision3.recommendedResolution, "high");
    assert.equal(
      (await viewerSawHostReport).networkAdvice.revision,
      adviceRevision3.revision,
    );

    const hostSawViewerReport = nextMessage(host, "network:advice");
    const viewerReportAdvice = nextMessage(viewer, "network:advice");
    viewer.send(
      JSON.stringify({
        type: "network:report",
        networkReport: networkReport({
          uploadKbps: 20_000,
          downloadKbps: 80_000,
          networkType: "wifi",
          directReachable: false,
          turnReachable: true,
        }),
      }),
    );
    const adviceRevision4 = (await hostSawViewerReport).networkAdvice;
    const viewerRevision4 = (await viewerReportAdvice).networkAdvice;
    assert.equal(adviceRevision4.revision, 4);
    assert.equal(viewerRevision4.revision, 4);
    assert.equal(adviceRevision4.measuredCount, 2);
    assert.equal(adviceRevision4.confidence, "high");
    assert.equal(adviceRevision4.perViewerBudgetBps, 37_500_000);
    assert.equal(adviceRevision4.recommendedResolution, "original");
    assert.equal(adviceRevision4.maxFrameRateByResolution.original, 30);
    assert.equal(adviceRevision4.maxFrameRateByResolution.ultra, 60);
    assert.equal(adviceRevision4.routeMode, "relay-preferred");
    assert.equal(viewerRevision4.routeMode, "relay-preferred");
    assert.doesNotMatch(
      JSON.stringify(adviceRevision4),
      new RegExp(
        [
          hostSample.sampleId,
          "uploadKbps",
          "downloadKbps",
          "measuredAt",
          "networkType",
        ].join("|"),
      ),
    );

    const targetedError = nextMessage(host, "error");
    host.send(
      JSON.stringify({
        type: "network:report",
        target: joinedViewer.clientId,
        networkReport: networkReport(),
      }),
    );
    assert.equal(
      (await targetedError).code,
      "network-report-invalid",
    );

    const nestedAddressError = nextMessage(host, "error");
    host.send(
      JSON.stringify({
        type: "network:report",
        networkReport: networkReport({
          ip: "127.0.0.1",
        }),
      }),
    );
    assert.equal(
      (await nestedAddressError).code,
      "network-report-invalid",
    );

    const stringNumberError = nextMessage(host, "error");
    host.send(
      JSON.stringify({
        type: "network:report",
        networkReport: networkReport({
          signalRttMs: "35",
        }),
      }),
    );
    assert.equal(
      (await stringNumberError).code,
      "network-report-invalid",
    );

    const staleReportError = nextMessage(host, "error");
    host.send(
      JSON.stringify({
        type: "network:report",
        networkReport: networkReport({
          measuredAt: Date.now() - 6 * 60_000,
        }),
      }),
    );
    assert.equal(
      (await staleReportError).code,
      "network-report-invalid",
    );

    const reportRateError = nextMessage(viewer, "error");
    viewer.send(
      JSON.stringify({
        type: "network:report",
        networkReport: networkReport(),
      }),
    );
    assert.equal(
      (await reportRateError).code,
      "network-report-rate-limit",
    );

    const hostSawRename = nextMessage(host, "participant:updated");
    viewer.send(
      JSON.stringify({
        type: "participant:rename",
        nickname: "网络观看端二号",
      }),
    );
    const renamed = await hostSawRename;
    assert.equal(
      Object.hasOwn(renamed.participant, "networkReport"),
      false,
    );

    const hostSawLeave = nextMessage(host, "participant:left");
    const leaveAdvice = nextMessage(host, "network:advice");
    viewer.close();
    assert.equal(
      (await hostSawLeave).participantId,
      joinedViewer.clientId,
    );
    const adviceRevision5 = (await leaveAdvice).networkAdvice;
    assert.equal(adviceRevision5.revision, 5);
    assert.equal(adviceRevision5.participantCount, 1);
    assert.equal(adviceRevision5.measuredCount, 1);
    assert.equal(
      adviceServer.clients.has(joinedViewer.clientId),
      false,
    );
    assert.ok(adviceServer.clients.get(joinedHost.clientId).state.networkReport);
  } finally {
    outsider.close();
    host.close();
    viewer.close();
    await adviceServer.close();
  }
});

test("aggregates private v2 transport telemetry into stable room advice", async () => {
  const telemetryServer = createSignalServer({
    env: {
      MAX_CLIENTS: "8",
      MAX_CLIENTS_PER_IP: "8",
      // Legacy capacity variables must no longer clamp recommendations.
      RELAY_CAPACITY_BPS: "120000000",
      RELAY_SESSION_CAPACITY_BPS: "20000000",
    },
  });
  const address = await telemetryServer.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const credential = ownerCredential(229);
  const host = await openSocket(url);
  const viewer = await openSocket(url);
  try {
    const hostJoined = nextMessage(host, "channel:joined");
    const hostInitialAdvice = nextMessage(host, "network:advice");
    host.send(
      JSON.stringify({
        type: "channel:join",
        room: credential.room,
        nickname: "v3 放映端",
        canBroadcast: true,
        createIfMissing: true,
        ownerToken: credential.ownerToken,
      }),
    );
    await hostJoined;
    await hostInitialAdvice;

    const viewerJoined = nextMessage(viewer, "channel:joined");
    const hostJoinAdvice = nextMessage(host, "network:advice");
    const viewerJoinAdvice = nextMessage(viewer, "network:advice");
    viewer.send(
      JSON.stringify({
        type: "channel:join",
        room: credential.room,
        nickname: "v3 观看端",
        canBroadcast: false,
      }),
    );
    await viewerJoined;
    await hostJoinAdvice;
    await viewerJoinAdvice;

    const hostAccepted = nextMessage(host, "network:report-accepted");
    const hostReportAdvice = nextMessage(host, "network:advice");
    const viewerSawHostReport = nextMessage(viewer, "network:advice");
    host.send(
      JSON.stringify({
        type: "network:report",
        networkReport: networkReport({
          probeVersion: 2,
          uploadKbps: 70_000,
          availableOutgoingBitrateBps: 60_000_000,
          packetLossPercent: 0.5,
          activeCandidateType: "srflx",
        }),
      }),
    );
    assert.equal((await hostAccepted).nextReportAfterMs, 5_000);
    await hostReportAdvice;
    await viewerSawHostReport;

    const viewerAccepted = nextMessage(
      viewer,
      "network:report-accepted",
    );
    const hostSawViewerReport = nextMessage(host, "network:advice");
    const viewerReportAdvice = nextMessage(viewer, "network:advice");
    viewer.send(
      JSON.stringify({
        type: "network:report",
        networkReport: networkReport({
          probeVersion: 2,
          downloadKbps: 60_000,
          availableIncomingBitrateBps: 55_000_000,
          directReachable: false,
          turnReachable: true,
          activeCandidateType: "relay",
          relayProtocol: "udp",
          relayRttMs: 88,
        }),
      }),
    );
    await viewerAccepted;
    const hostRelayAdvice = (await hostSawViewerReport).networkAdvice;
    const viewerRelayAdvice = (await viewerReportAdvice).networkAdvice;
    assert.equal(hostRelayAdvice.routeMode, "relay-preferred");
    assert.equal(viewerRelayAdvice.routeMode, "relay-preferred");
    assert.equal(hostRelayAdvice.perViewerBudgetBps, 40_500_000);
    assert.equal(viewerRelayAdvice.perViewerBudgetBps, 40_500_000);
    assert.equal(
      viewerRelayAdvice.recommendedTargetBitrateBps,
      35_640_000,
    );
    assert.equal(viewerRelayAdvice.recommendedResolution, "original");
    assert.equal(viewerRelayAdvice.relaySessionCapacityBps, null);
    assert.equal(viewerRelayAdvice.relayCapacityEnforced, false);

    const sampleId = "transport-sample-0001";
    const sessionId = "broadcast-session-0001";
    const accepted = nextMessage(
      viewer,
      "network:transport-accepted",
    );
    const hostTransportAdvice = nextMessage(host, "network:advice");
    const viewerTransportAdvice = nextMessage(viewer, "network:advice");
    viewer.send(
      JSON.stringify({
        type: "network:transport-report",
        transportReport: {
          reportVersion: 1,
          sampleId,
          sessionId,
          mediaKind: "broadcast",
          direction: "receive",
          candidateType: "relay",
          relayProtocol: "udp",
          roundTripTimeMs: 310,
          jitterMs: 58,
          packetLossPercent: 7,
          inboundBitrateBps: 12_000_000,
          availableIncomingBitrateBps: 22_000_000,
          framesDroppedPercent: 6,
          freezeCount: 2,
          reportedAt: Date.now(),
        },
      }),
    );
    assert.equal((await accepted).sampleId, sampleId);
    await hostTransportAdvice;
    const advice = (await viewerTransportAdvice).networkAdvice;
    assert.equal(advice.schemaVersion, 2);
    assert.equal(advice.routeMode, "relay-preferred");
    assert.equal(advice.congestion, "constrained");
    assert.equal(advice.relayCapacityBps, null);
    assert.equal(advice.relaySessionCapacityBps, null);
    assert.equal(advice.relayCapacityEnforced, false);
    assert.equal(advice.aggregate.relayParticipants, 1);
    assert.equal(advice.aggregate.lossyParticipants, 1);
    assert.ok(advice.recommendedTargetBitrateBps < advice.perViewerBudgetBps);
    assert.doesNotMatch(
      JSON.stringify(advice),
      new RegExp(`${sampleId}|${sessionId}|packetLossPercent`),
    );

    const ready = nextMessage(viewer, "voice:ready");
    viewer.send(JSON.stringify({ type: "voice:join" }));
    const voiceReady = await ready;
    assert.equal(voiceReady.voicePolicy.version, 2);
    assert.equal(voiceReady.voicePolicy.sampleRate, 48_000);
    assert.equal(voiceReady.voicePolicy.minimumBitrateBps, 96_000);
    assert.equal(voiceReady.voicePolicy.speechTargetBitrateBps, 256_000);

    const rateLimited = nextMessage(viewer, "error");
    viewer.send(
      JSON.stringify({
        type: "network:transport-report",
        transportReport: {
          reportVersion: 1,
          sampleId: "transport-sample-0002",
          sessionId,
          mediaKind: "broadcast",
          direction: "receive",
          candidateType: "relay",
          relayProtocol: "udp",
          reportedAt: Date.now(),
        },
      }),
    );
    assert.equal(
      (await rateLimited).code,
      "network-transport-rate-limit",
    );
  } finally {
    host.close();
    viewer.close();
    await telemetryServer.close();
  }
});

test("creates a room, joins a viewer, and relays signaling", async () => {
  const host = await openSocket();
  const hostCreated = nextMessage(host, "room:created");
  host.send(JSON.stringify({ type: "host:create", room: "A7K9P2WX" }));
  const created = await hostCreated;
  assert.equal(created.type, "room:created");
  assert.equal(created.iceServers[0].urls[0], "stun:127.0.0.1:3478");
  const turnServer = created.iceServers[1];
  assert.equal(turnServer.urls[0], "turn:127.0.0.1:3478?transport=udp");
  assert.ok(turnServer.credential);

  const viewer = await openSocket();
  const viewerJoined = nextMessage(viewer, "room:joined");
  const hostSawViewer = nextMessage(host, "viewer:joined");
  viewer.send(JSON.stringify({ type: "viewer:join", room: "A7K9P2WX" }));
  const joined = await viewerJoined;
  const appeared = await hostSawViewer;
  assert.equal(joined.type, "room:joined");
  assert.equal(appeared.type, "viewer:joined");
  const viewerTurnServer = joined.iceServers.find((entry) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) =>
      String(url).startsWith("turn:"),
    ),
  );
  assert.ok(viewerTurnServer?.username);
  assert.notEqual(
    viewerTurnServer.username,
    turnServer.username,
    "every client needs an independent coturn quota identity",
  );

  const viewerReceived = nextMessage(viewer, "signal");
  host.send(
    JSON.stringify({
      type: "signal",
      target: appeared.viewerId,
      data: { type: "offer", sdp: "test" },
    }),
  );
  const relayed = await viewerReceived;
  assert.equal(relayed.type, "signal");
  assert.equal(relayed.data.type, "offer");

  const invalidSignal = nextMessage(host, "error");
  host.send(
    JSON.stringify({
      type: "signal",
      target: appeared.viewerId,
      data: { candidate: "not-an-ice-candidate" },
    }),
  );
  assert.match((await invalidSignal).message, /协商数据无效/);

  host.close();
  viewer.close();
});

test("rejects invalid and missing rooms", async () => {
  const invalid = await openSocket();
  const invalidMessage = nextMessage(invalid, "error");
  invalid.send(JSON.stringify({ type: "host:create", room: "123" }));
  assert.equal((await invalidMessage).type, "error");
  invalid.close();

  const viewer = await openSocket();
  const missingMessage = nextMessage(viewer, "error");
  viewer.send(JSON.stringify({ type: "viewer:join", room: "ZZZZZZZZ" }));
  assert.match((await missingMessage).message, /暂未开播/);
  viewer.close();

  const modernViewer = await openSocket();
  const modernMissingMessage = nextMessage(modernViewer, "error");
  modernViewer.send(
    JSON.stringify({
      type: "channel:join",
      room: "ZZZZZZZZ",
      canBroadcast: false,
      resumeToken: "offline-rejoin-token-0001",
    }),
  );
  assert.equal((await modernMissingMessage).code, "channel-offline");
  modernViewer.close();
});

test("announces participants, relays voice signaling, and broadcasts chat", async () => {
  const host = await openSocket();
  const createdMessage = nextMessage(host, "room:created");
  host.send(
    JSON.stringify({
      type: "host:create",
      room: "C7K9P2WX",
      nickname: "小明",
      channelName: "周五电影夜",
    }),
  );
  const created = await createdMessage;
  assert.equal(created.channelName, "周五电影夜");
  assert.equal(created.participants[0].nickname, "小明");

  const viewer = await openSocket();
  const joinedMessage = nextMessage(viewer, "room:joined");
  viewer.send(
    JSON.stringify({
      type: "viewer:join",
      room: "C7K9P2WX",
      nickname: "小红",
    }),
  );
  const joined = await joinedMessage;
  assert.equal(joined.participants.length, 2);
  const viewerId = joined.clientId;

  const hostReadyMessage = nextMessage(host, "voice:ready");
  const viewerSawHostVoice = nextMessage(viewer, "voice:joined");
  host.send(JSON.stringify({ type: "voice:join" }));
  assert.deepEqual((await hostReadyMessage).participants, []);
  assert.equal((await viewerSawHostVoice).participant.nickname, "小明");

  const viewerReadyMessage = nextMessage(viewer, "voice:ready");
  const hostSawViewerVoice = nextMessage(host, "voice:joined");
  viewer.send(JSON.stringify({ type: "voice:join" }));
  const viewerReady = await viewerReadyMessage;
  assert.equal(viewerReady.participants.length, 1);
  assert.equal(viewerReady.participants[0].nickname, "小明");
  assert.equal((await hostSawViewerVoice).participant.id, viewerId);

  const viewerMusicStarted = nextMessage(viewer, "voice:music");
  host.send(JSON.stringify({ type: "voice:music", active: true }));
  const musicStarted = await viewerMusicStarted;
  assert.equal(musicStarted.active, true);
  assert.equal(musicStarted.senderId, created.clientId);
  assert.equal(musicStarted.nickname, "小明");

  const viewerMusicStopped = nextMessage(viewer, "voice:music");
  host.send(JSON.stringify({ type: "voice:music", active: false }));
  assert.equal((await viewerMusicStopped).active, false);

  const viewerPeersMessage = nextMessage(viewer, "voice:peers");
  viewer.send(JSON.stringify({ type: "voice:sync" }));
  const viewerPeers = await viewerPeersMessage;
  assert.equal(viewerPeers.participants.length, 1);
  assert.equal(viewerPeers.participants[0].id, created.clientId);

  const hostSawViewerMuted = nextMessage(host, "participant:updated");
  const viewerSawViewerMuted = nextMessage(viewer, "participant:updated");
  viewer.send(JSON.stringify({ type: "voice:mute", muted: true }));
  const mutedViewer = await hostSawViewerMuted;
  assert.equal(mutedViewer.participant.id, viewerId);
  assert.equal(mutedViewer.participant.microphoneMuted, true);
  assert.equal(
    (await viewerSawViewerMuted).participant.microphoneMuted,
    true,
  );

  const hostVoiceSignal = nextMessage(host, "voice:signal");
  viewer.send(
    JSON.stringify({
      type: "voice:signal",
      target: created.clientId,
      sessionId: "voice-session-01",
      iceMode: "relay",
      data: { type: "offer", sdp: "voice-test" },
    }),
  );
  const voiceSignal = await hostVoiceSignal;
  assert.equal(voiceSignal.from, viewerId);
  assert.equal(voiceSignal.data.sdp, "voice-test");
  assert.equal(voiceSignal.sessionId, "voice-session-01");
  assert.equal(voiceSignal.iceMode, "relay");

  const hostChat = nextMessage(host, "chat:message");
  const viewerChat = nextMessage(viewer, "chat:message");
  viewer.send(JSON.stringify({ type: "chat:send", text: "  大家好！  " }));
  const receivedChat = await hostChat;
  assert.equal(receivedChat.text, "大家好！");
  assert.equal(typeof receivedChat.sentAt, "number");
  assert.ok(receivedChat.sentAt > 0);
  assert.equal((await viewerChat).nickname, "小红");

  const hostSawRename = nextMessage(host, "participant:updated");
  const viewerSawRename = nextMessage(viewer, "participant:updated");
  viewer.send(
    JSON.stringify({ type: "participant:rename", nickname: "小红帽" }),
  );
  assert.equal((await hostSawRename).participant.nickname, "小红帽");
  assert.equal((await viewerSawRename).participant.nickname, "小红帽");

  const hostQualityRequest = nextMessage(host, "quality:request");
  viewer.send(
    JSON.stringify({
      type: "quality:request",
      height: 1200,
      frameRate: 24,
    }),
  );
  const qualityRequest = await hostQualityRequest;
  assert.equal(qualityRequest.viewerId, viewerId);
  assert.equal(qualityRequest.height, 1200);
  assert.equal(qualityRequest.frameRate, 24);

  const highRefreshRequest = nextMessage(host, "quality:request");
  viewer.send(
    JSON.stringify({
      type: "quality:request",
      height: 480,
      frameRate: 120,
    }),
  );
  const highRefresh = await highRefreshRequest;
  assert.equal(highRefresh.height, 480);
  assert.equal(highRefresh.frameRate, 120);

  for (const height of [1440, 2160]) {
    const expandedResolutionRequest = nextMessage(
      host,
      "quality:request",
    );
    viewer.send(
      JSON.stringify({
        type: "quality:request",
        height,
        frameRate: 30,
      }),
    );
    const expandedResolution = await expandedResolutionRequest;
    assert.equal(expandedResolution.height, height);
    assert.equal(expandedResolution.frameRate, 30);
  }

  host.close();
  viewer.close();
});

test("skips stale members when a legacy room transfers ownership", async () => {
  const host = await openSocket();
  const createdMessage = nextMessage(host, "room:created");
  host.send(
    JSON.stringify({
      type: "host:create",
      room: "E7K9P2WX",
      nickname: "原房主",
    }),
  );
  const created = await createdMessage;

  const viewer = await openSocket();
  const joinedMessage = nextMessage(viewer, "room:joined");
  viewer.send(
    JSON.stringify({
      type: "viewer:join",
      room: "E7K9P2WX",
      nickname: "接任者",
    }),
  );
  const joined = await joinedMessage;
  const room = server.rooms.get("E7K9P2WX");
  room.members = new Set([
    created.clientId,
    "stale-client-awaiting-departure",
    joined.clientId,
  ]);

  const participantLeft = nextMessage(viewer, "participant:left");
  const participantUpdated = nextMessage(viewer, "participant:updated");
  host.close();
  assert.equal((await participantLeft).participantId, created.clientId);
  const promoted = await participantUpdated;
  assert.equal(promoted.participant.id, joined.clientId);
  assert.equal(promoted.participant.role, "host");
  assert.equal(room.ownerId, joined.clientId);
  assert.equal(room.members.has("stale-client-awaiting-departure"), false);

  viewer.close();
});

test("rejects invalid viewer quality preferences", async () => {
  const host = await openSocket();
  const createdMessage = nextMessage(host, "room:created");
  host.send(JSON.stringify({ type: "host:create", room: "D7K9P2WX" }));
  await createdMessage;

  const viewer = await openSocket();
  const joinedMessage = nextMessage(viewer, "room:joined");
  viewer.send(JSON.stringify({ type: "viewer:join", room: "D7K9P2WX" }));
  await joinedMessage;

  const errorMessage = nextMessage(viewer, "error");
  viewer.send(
    JSON.stringify({
      type: "quality:request",
      height: 999,
      frameRate: 120,
    }),
  );
  assert.match((await errorMessage).message, /画质参数无效/);

  host.close();
  viewer.close();
});

test("does not let the first desktop visitor claim an unowned channel code", async () => {
  const visitor = await openSocket();
  const rejected = nextMessage(visitor, "error");
  visitor.send(
    JSON.stringify({
      type: "channel:join",
      room: "K7K9P2WX",
      nickname: "抢先进入的人",
      canBroadcast: true,
      createIfMissing: true,
    }),
  );
  assert.match((await rejected).message, /频道暂时无人在线/);
  assert.equal(server.rooms.has("K7K9P2WX"), false);
  visitor.close();

  const wrongCredential = await openSocket();
  const wrongRejected = nextMessage(wrongCredential, "error");
  wrongCredential.send(
    JSON.stringify({
      type: "channel:join",
      room: "K7K9P2WX",
      nickname: "伪造频道主",
      canBroadcast: true,
      createIfMissing: true,
      // This is the old reversible construction: its first eight bytes spell
      // the target room, but it must not pass the SHA-256 ownership check.
      ownerToken: legacyConstructedTokenForRoom("K7K9P2WX"),
    }),
  );
  assert.match((await wrongRejected).message, /频道暂时无人在线/);
  assert.equal(server.rooms.has("K7K9P2WX"), false);
  wrongCredential.close();
});

test("keeps the legacy host protocol from bypassing owner binding by default", async () => {
  const protectedServer = createSignalServer({ env: {} });
  const address = await protectedServer.listen(0, "127.0.0.1");
  const socket = await new Promise((resolve, reject) => {
    const candidate = new WebSocket(
      `ws://127.0.0.1:${address.port}/signal`,
    );
    candidate.once("open", () => resolve(candidate));
    candidate.once("error", reject);
  });
  try {
    const rejected = new Promise((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });
    socket.send(
      JSON.stringify({ type: "host:create", room: "N7K9P2WX" }),
    );
    assert.match((await rejected).message, /版本过旧/);
    assert.equal(protectedServer.rooms.has("N7K9P2WX"), false);
  } finally {
    socket.close();
    await protectedServer.close();
  }
});

test("allows eight people in one channel and rejects the ninth", async () => {
  const sockets = [];
  const owner = await openSocket();
  sockets.push(owner);
  const ownerJoined = nextMessage(owner, "channel:joined");
  owner.send(
    JSON.stringify({
      type: "channel:join",
      room: capacityOwner.room,
      nickname: "成员 1",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: capacityOwner.ownerToken,
    }),
  );
  assert.equal((await ownerJoined).participants.length, 1);

  for (let index = 2; index <= 8; index += 1) {
    const member = await openSocket();
    sockets.push(member);
    const joined = nextMessage(member, "channel:joined");
    member.send(
      JSON.stringify({
        type: "channel:join",
        room: capacityOwner.room,
        nickname: `成员 ${index}`,
        canBroadcast: index < 8,
        createIfMissing: false,
      }),
    );
    assert.equal((await joined).participants.length, index);
  }

  const rejected = await openSocket();
  sockets.push(rejected);
  const full = nextMessage(rejected, "error");
  rejected.send(
    JSON.stringify({
      type: "channel:join",
      room: capacityOwner.room,
      nickname: "第九个人",
      canBroadcast: false,
      createIfMissing: false,
    }),
  );
  assert.match((await full).message, /人数已满/);
  sockets.forEach((socket) => socket.close());
});

test("lets any desktop member start and stop broadcasting in a channel", async () => {
  const owner = await openSocket();
  const ownerJoinedMessage = nextMessage(owner, "channel:joined");
  owner.send(
    JSON.stringify({
      type: "channel:join",
      room: broadcastOwner.room,
      nickname: "频道主",
      channelName: "可切换放映",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: broadcastOwner.ownerToken,
    }),
  );
  const ownerJoined = await ownerJoinedMessage;
  assert.equal(ownerJoined.created, true);
  assert.equal(ownerJoined.broadcasterId, undefined);

  const member = await openSocket();
  const memberJoinedMessage = nextMessage(member, "channel:joined");
  member.send(
    JSON.stringify({
      type: "channel:join",
      room: broadcastOwner.room,
      nickname: "朋友电脑",
      canBroadcast: true,
      createIfMissing: false,
      embyCapabilities: {
        mse: true,
        h264: true,
        hevc: false,
        aac: true,
        desktop: true,
        password: "must-not-enter-participant-state",
      },
    }),
  );
  const memberJoined = await memberJoinedMessage;
  assert.equal(memberJoined.created, false);
  assert.equal(memberJoined.participants.length, 2);
  assert.deepEqual(
    memberJoined.participants.find(
      (participant) => participant.id === memberJoined.clientId,
    )?.embyCapabilities,
    {
      mse: true,
      h264: true,
      hevc: false,
      aac: true,
      desktop: true,
    },
  );
  assert.doesNotMatch(
    JSON.stringify(memberJoined),
    /must-not-enter-participant-state/,
  );

  const invalidCapabilitiesMessage = nextMessage(member, "error");
  member.send(
    JSON.stringify({
      type: "broadcast:start",
      broadcastCapabilities: {
        width: "not-a-number",
        height: 1440,
        frameRate: 30,
      },
    }),
  );
  assert.match(
    (await invalidCapabilitiesMessage).message,
    /放映画质能力参数无效/,
  );

  const memberCapabilities = {
    width: 2560,
    height: 1440,
    frameRate: 30,
  };
  const ownerSawBroadcast = nextMessage(owner, "broadcast:started");
  const memberGranted = nextMessage(member, "broadcast:granted");
  member.send(
    JSON.stringify({
      type: "broadcast:start",
      broadcastCapabilities: memberCapabilities,
    }),
  );
  const granted = await memberGranted;
  const started = await ownerSawBroadcast;
  assert.equal(started.broadcasterId, memberJoined.clientId);
  assert.deepEqual(started.broadcastCapabilities, memberCapabilities);
  assert.deepEqual(granted.broadcastCapabilities, memberCapabilities);
  assert.deepEqual(granted.viewerIds, []);

  const measuredCapabilities = {
    width: 2560,
    height: 1600,
    frameRate: 24,
  };
  const ownerSawCapabilities = nextMessage(
    owner,
    "broadcast:capabilities",
  );
  member.send(
    JSON.stringify({
      type: "broadcast:capabilities",
      broadcastCapabilities: measuredCapabilities,
    }),
  );
  const capabilitiesUpdate = await ownerSawCapabilities;
  assert.equal(capabilitiesUpdate.broadcasterId, memberJoined.clientId);
  assert.deepEqual(
    capabilitiesUpdate.broadcastCapabilities,
    measuredCapabilities,
  );

  const lateViewer = await openSocket();
  const lateViewerJoinedMessage = nextMessage(lateViewer, "channel:joined");
  lateViewer.send(
    JSON.stringify({
      type: "channel:join",
      room: broadcastOwner.room,
      nickname: "后来加入的手机",
      canBroadcast: false,
      createIfMissing: false,
    }),
  );
  const lateViewerJoined = await lateViewerJoinedMessage;
  assert.equal(lateViewerJoined.broadcasterId, memberJoined.clientId);
  assert.deepEqual(
    lateViewerJoined.broadcastCapabilities,
    measuredCapabilities,
  );

  const memberSawReadyViewer = nextMessage(member, "viewer:joined");
  owner.send(
    JSON.stringify({
      type: "broadcast:watch-ready",
      attempt: 2,
      sessionId: "session-test-02",
      codecs: ["video/H264", "video/VP8", "invalid/codec"],
      embyCapabilities: {
        mse: true,
        h264: true,
        hevc: false,
        aac: true,
        desktop: true,
        token: "must-not-be-relayed",
      },
    }),
  );
  const readyViewer = await memberSawReadyViewer;
  assert.equal(readyViewer.viewerId, ownerJoined.clientId);
  assert.equal(readyViewer.attempt, 2);
  assert.equal(readyViewer.sessionId, "session-test-02");
  assert.deepEqual(readyViewer.codecs, ["video/H264", "video/VP8"]);
  assert.deepEqual(readyViewer.embyCapabilities, {
    mse: true,
    h264: true,
    hevc: false,
    aac: true,
    desktop: true,
  });
  assert.doesNotMatch(JSON.stringify(readyViewer), /must-not-be-relayed/);

  const memberSawMediaReady = nextMessage(member, "media:ready");
  owner.send(
    JSON.stringify({
      type: "media:ready",
      sessionId: "session-test-02",
    }),
  );
  const mediaReady = await memberSawMediaReady;
  assert.equal(mediaReady.viewerId, ownerJoined.clientId);
  assert.equal(mediaReady.sessionId, "session-test-02");

  const memberSawAudioMissing = nextMessage(member, "media:audio-missing");
  owner.send(
    JSON.stringify({
      type: "media:audio-missing",
      sessionId: "session-test-02",
    }),
  );
  const audioMissing = await memberSawAudioMissing;
  assert.equal(audioMissing.viewerId, ownerJoined.clientId);
  assert.equal(audioMissing.sessionId, "session-test-02");

  const memberSawCodecFailure = nextMessage(member, "media:codec-failed");
  owner.send(
    JSON.stringify({
      type: "media:codec-failed",
      attempt: 2,
      sessionId: "session-test-02",
      codec: "invalid/codec",
    }),
  );
  owner.send(
    JSON.stringify({
      type: "media:codec-failed",
      attempt: 2,
      sessionId: "session-test-02",
      codec: "VIDEO/VP9",
      bytesReceived: 123_456,
      framesDecoded: 0,
      injected: "must-not-be-relayed",
    }),
  );
  const codecFailure = await memberSawCodecFailure;
  assert.deepEqual(codecFailure, {
    type: "media:codec-failed",
    viewerId: ownerJoined.clientId,
    attempt: 2,
    sessionId: "session-test-02",
    codec: "video/vp9",
  });

  const memberReceivedSignal = nextMessage(member, "signal");
  owner.send(
    JSON.stringify({
      type: "signal",
      target: "broadcaster",
      attempt: 2,
      sessionId: "session-test-02",
      data: { type: "answer", sdp: "viewer-to-broadcaster" },
    }),
  );
  const relayedAnswer = await memberReceivedSignal;
  assert.equal(relayedAnswer.data.sdp, "viewer-to-broadcaster");
  assert.equal(relayedAnswer.attempt, 2);
  assert.equal(relayedAnswer.sessionId, "session-test-02");

  const ownerReceivedSignal = nextMessage(owner, "signal");
  member.send(
    JSON.stringify({
      type: "signal",
      target: ownerJoined.clientId,
      attempt: 2,
      sessionId: "session-test-02",
      data: { type: "offer", sdp: "broadcaster-to-viewer" },
    }),
  );
  const relayedOffer = await ownerReceivedSignal;
  assert.equal(relayedOffer.data.sdp, "broadcaster-to-viewer");
  assert.equal(relayedOffer.attempt, 2);
  assert.equal(relayedOffer.sessionId, "session-test-02");

  const ownerSawStop = nextMessage(owner, "broadcast:stopped");
  member.send(JSON.stringify({ type: "broadcast:stop" }));
  assert.equal((await ownerSawStop).reason, "stopped");

  const betweenBroadcastsViewer = await openSocket();
  const betweenBroadcastsJoinedMessage = nextMessage(
    betweenBroadcastsViewer,
    "channel:joined",
  );
  betweenBroadcastsViewer.send(
    JSON.stringify({
      type: "channel:join",
      room: broadcastOwner.room,
      nickname: "换片时加入",
      canBroadcast: false,
      createIfMissing: false,
    }),
  );
  const betweenBroadcastsJoined = await betweenBroadcastsJoinedMessage;
  assert.equal(betweenBroadcastsJoined.broadcasterId, undefined);
  assert.equal(betweenBroadcastsJoined.broadcastCapabilities, undefined);

  const ownerGranted = nextMessage(owner, "broadcast:granted");
  const memberSawOwnerBroadcast = nextMessage(member, "broadcast:started");
  const ownerCapabilities = {
    width: 3840,
    height: 2160,
    frameRate: 30,
    mode: "emby",
    mimeType: 'video/mp4; codecs="hvc1.1.6.L120.B0, mp4a.40.2"',
    videoCodec: "hevc",
    audioCodec: "aac",
    title: "Emby UHD",
    bitrate: 18_000_000,
    durationTicks: 72_000_000_000,
    token: "must-not-enter-room-state",
  };
  owner.send(
    JSON.stringify({
      type: "broadcast:start",
      broadcastCapabilities: ownerCapabilities,
    }),
  );
  const ownerGrant = await ownerGranted;
  assert.equal(ownerGrant.broadcasterId, ownerJoined.clientId);
  assert.deepEqual(ownerGrant.broadcastCapabilities, {
    width: 3840,
    height: 2160,
    frameRate: 30,
    mode: "emby",
    mimeType: 'video/mp4; codecs="hvc1.1.6.L120.B0, mp4a.40.2"',
    videoCodec: "hevc",
    audioCodec: "aac",
    title: "Emby UHD",
    bitrate: 18_000_000,
    durationTicks: 72_000_000_000,
  });
  assert.doesNotMatch(JSON.stringify(ownerGrant), /must-not-enter-room-state/);
  const ownerStarted = await memberSawOwnerBroadcast;
  assert.equal(ownerStarted.broadcasterId, ownerJoined.clientId);
  assert.deepEqual(
    ownerStarted.broadcastCapabilities,
    ownerGrant.broadcastCapabilities,
  );

  owner.close();
  member.close();
  lateViewer.close();
  betweenBroadcastsViewer.close();
});

test("keeps ownership bound to the creator credential across disconnects", async () => {
  const owner = await openSocket();
  const ownerJoinedMessage = nextMessage(owner, "channel:joined");
  owner.send(
    JSON.stringify({
      type: "channel:join",
      room: persistentOwner.room,
      nickname: "先到的人",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: persistentOwner.ownerToken,
    }),
  );
  const ownerJoined = await ownerJoinedMessage;
  assert.equal(
    ownerJoined.participants.find(
      (participant) => participant.id === ownerJoined.clientId,
    )?.role,
    "host",
  );

  const member = await openSocket();
  const memberJoinedMessage = nextMessage(member, "channel:joined");
  member.send(
    JSON.stringify({
      type: "channel:join",
      room: persistentOwner.room,
      nickname: "留下的人",
      canBroadcast: true,
      createIfMissing: false,
    }),
  );
  const memberJoined = await memberJoinedMessage;
  assert.equal(
    memberJoined.participants.find(
      (participant) => participant.id === memberJoined.clientId,
    )?.role,
    "viewer",
  );
  const ownerLeftMessage = nextMessage(member, "participant:left");
  owner.close();
  assert.equal((await ownerLeftMessage).participantId, ownerJoined.clientId);

  const unauthorized = nextMessage(member, "error");
  member.send(
    JSON.stringify({
      type: "moderation:kick",
      target: memberJoined.clientId,
    }),
  );
  assert.match((await unauthorized).message, /只有频道主/);

  const wrongOwner = await openSocket();
  const wrongOwnerRejected = nextMessage(wrongOwner, "error");
  wrongOwner.send(
    JSON.stringify({
      type: "channel:join",
      room: persistentOwner.room,
      nickname: "错误凭证",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: ownerCredential(80).ownerToken,
    }),
  );
  assert.match(
    (await wrongOwnerRejected).message,
    /频道主身份凭证无效/,
  );
  wrongOwner.close();

  const lateMember = await openSocket();
  const lateJoinedMessage = nextMessage(lateMember, "channel:joined");
  lateMember.send(
    JSON.stringify({
      type: "channel:join",
      room: persistentOwner.room,
      nickname: "后来的人",
      canBroadcast: true,
      createIfMissing: false,
    }),
  );
  const lateJoined = await lateJoinedMessage;
  assert.equal(lateJoined.created, false);
  assert.equal(lateJoined.participants.length, 2);
  assert.equal(
    lateJoined.participants.find(
      (participant) => participant.id === lateJoined.clientId,
    )?.role,
    "viewer",
  );

  const returnedOwner = await openSocket();
  const returnedOwnerJoinedMessage = nextMessage(
    returnedOwner,
    "channel:joined",
  );
  returnedOwner.send(
    JSON.stringify({
      type: "channel:join",
      room: persistentOwner.room,
      nickname: "真正的频道主",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: persistentOwner.ownerToken,
    }),
  );
  const returnedOwnerJoined = await returnedOwnerJoinedMessage;
  assert.equal(
    returnedOwnerJoined.participants.find(
      (participant) => participant.id === returnedOwnerJoined.clientId,
    )?.role,
    "host",
  );

  member.close();
  lateMember.close();
  returnedOwner.close();
});

test("lets the channel owner manage microphones, broadcasts, and members", async () => {
  const owner = await openSocket();
  const ownerJoinedMessage = nextMessage(owner, "channel:joined");
  owner.send(
    JSON.stringify({
      type: "channel:join",
      room: moderationOwner.room,
      nickname: "频道主",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: moderationOwner.ownerToken,
    }),
  );
  const ownerJoined = await ownerJoinedMessage;

  const member = await openSocket();
  const memberJoinedMessage = nextMessage(member, "channel:joined");
  member.send(
    JSON.stringify({
      type: "channel:join",
      room: moderationOwner.room,
      nickname: "成员",
      canBroadcast: true,
      createIfMissing: false,
    }),
  );
  const memberJoined = await memberJoinedMessage;

  const memberReady = nextMessage(member, "voice:ready");
  member.send(JSON.stringify({ type: "voice:join" }));
  await memberReady;

  const memberForcedMute = nextMessage(member, "moderation:microphone");
  const ownerSawDisabled = nextMessage(owner, "participant:updated");
  owner.send(
    JSON.stringify({
      type: "moderation:microphone",
      target: memberJoined.clientId,
      disabled: true,
    }),
  );
  assert.equal((await memberForcedMute).disabled, true);
  const disabledParticipant = await ownerSawDisabled;
  assert.equal(disabledParticipant.participant.microphoneDisabled, true);
  assert.equal(disabledParticipant.participant.microphoneMuted, true);

  const ownerSawStillMuted = nextMessage(owner, "participant:updated");
  member.send(JSON.stringify({ type: "voice:mute", muted: false }));
  assert.equal(
    (await ownerSawStillMuted).participant.microphoneMuted,
    true,
  );

  const ownerSawBroadcast = nextMessage(owner, "broadcast:started");
  const memberGranted = nextMessage(member, "broadcast:granted");
  member.send(
    JSON.stringify({
      type: "broadcast:start",
      broadcastCapabilities: {
        width: 1920,
        height: 1080,
        frameRate: 30,
      },
    }),
  );
  await ownerSawBroadcast;
  await memberGranted;

  const memberSawStopped = nextMessage(member, "broadcast:stopped");
  owner.send(
    JSON.stringify({
      type: "moderation:stop-broadcast",
      target: memberJoined.clientId,
    }),
  );
  assert.equal((await memberSawStopped).reason, "moderated");

  const unauthorized = nextMessage(member, "error");
  member.send(
    JSON.stringify({
      type: "moderation:kick",
      target: ownerJoined.clientId,
    }),
  );
  assert.match((await unauthorized).message, /只有频道主/);

  const kicked = nextMessage(member, "moderation:kicked");
  const ownerSawLeave = nextMessage(owner, "participant:left");
  owner.send(
    JSON.stringify({
      type: "moderation:kick",
      target: memberJoined.clientId,
    }),
  );
  assert.match((await kicked).message, /移出频道/);
  assert.equal((await ownerSawLeave).participantId, memberJoined.clientId);

  owner.close();
});

test("reclaims the same broadcaster immediately after a network switch", async () => {
  const broadcaster = await openSocket();
  const joinedMessage = nextMessage(broadcaster, "channel:joined");
  broadcaster.send(
    JSON.stringify({
      type: "channel:join",
      room: resumeOwner.room,
      nickname: "放映电脑",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: resumeOwner.ownerToken,
      resumeToken: "portable-resume-token-0001",
    }),
  );
  const joined = await joinedMessage;
  const grantedMessage = nextMessage(broadcaster, "broadcast:granted");
  broadcaster.send(
    JSON.stringify({
      type: "broadcast:start",
      broadcastCapabilities: {
        width: 2560,
        height: 1600,
        frameRate: 24,
      },
    }),
  );
  await grantedMessage;

  const viewer = await openSocket();
  const viewerJoinedMessage = nextMessage(viewer, "channel:joined");
  viewer.send(
    JSON.stringify({
      type: "channel:join",
      room: resumeOwner.room,
      nickname: "手机",
      canBroadcast: false,
      createIfMissing: false,
      resumeToken: "phone-resume-token-000001",
    }),
  );
  await viewerJoinedMessage;

  const broadcasterVoiceReady = nextMessage(broadcaster, "voice:ready");
  const viewerSawVoiceJoin = nextMessage(viewer, "voice:joined");
  broadcaster.send(JSON.stringify({ type: "voice:join" }));
  await broadcasterVoiceReady;
  assert.equal(
    (await viewerSawVoiceJoin).participant.voiceActive,
    true,
  );

  const replacement = await openSocket();
  const resumedMessage = nextMessage(replacement, "channel:joined");
  const viewerSawResume = nextMessage(viewer, "broadcast:capabilities");
  const viewerSawParticipantResume = nextMessage(
    viewer,
    "participant:updated",
  );
  replacement.send(
    JSON.stringify({
      type: "channel:join",
      room: resumeOwner.room,
      nickname: "放映电脑",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: resumeOwner.ownerToken,
      resumeToken: "portable-resume-token-0001",
    }),
  );
  const resumed = await resumedMessage;
  assert.equal(resumed.clientId, joined.clientId);
  assert.equal(resumed.broadcasterId, joined.clientId);
  assert.equal(resumed.resumed, true);
  assert.equal(
    resumed.participants.find(
      (participant) => participant.id === joined.clientId,
    )?.voiceActive,
    true,
  );
  assert.deepEqual(resumed.broadcastCapabilities, {
    width: 2560,
    height: 1600,
    frameRate: 24,
  });
  assert.equal((await viewerSawResume).broadcasterId, joined.clientId);
  assert.equal(
    (await viewerSawParticipantResume).participant.voiceActive,
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    inboxes
      .get(viewer)
      .queue.some((message) => message.type === "voice:left"),
    false,
    "a superseded socket must not emit voice:left after state transfer",
  );

  replacement.close();
  viewer.close();
});

test("preserves an active broadcast after the old socket fully closes", async () => {
  const broadcaster = await openSocket();
  const joinedMessage = nextMessage(broadcaster, "channel:joined");
  broadcaster.send(
    JSON.stringify({
      type: "channel:join",
      room: graceOwner.room,
      nickname: "弱网放映端",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: graceOwner.ownerToken,
      resumeToken: "graceful-network-resume-0001",
    }),
  );
  const joined = await joinedMessage;
  const granted = nextMessage(broadcaster, "broadcast:granted");
  broadcaster.send(
    JSON.stringify({
      type: "broadcast:start",
      broadcastCapabilities: {
        width: 1920,
        height: 1080,
        frameRate: 24,
        mode: "screen",
      },
    }),
  );
  await granted;

  const viewer = await openSocket();
  const viewerJoined = nextMessage(viewer, "channel:joined");
  viewer.send(
    JSON.stringify({
      type: "channel:join",
      room: graceOwner.room,
      nickname: "弱网观看端",
      canBroadcast: false,
      createIfMissing: false,
      resumeToken: "grace-viewer-resume-000001",
    }),
  );
  await viewerJoined;

  const oldClosed = new Promise((resolve) =>
    broadcaster.once("close", resolve),
  );
  broadcaster.close(4001, "client reconnect");
  await oldClosed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    server.rooms.get(graceOwner.room)?.broadcasterId,
    joined.clientId,
    "transient close must retain broadcaster state during the resume grace",
  );

  const replacement = await openSocket();
  const resumedMessage = nextMessage(replacement, "channel:joined");
  const viewerSawResume = nextMessage(viewer, "broadcast:capabilities");
  replacement.send(
    JSON.stringify({
      type: "channel:join",
      room: graceOwner.room,
      nickname: "弱网放映端",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: graceOwner.ownerToken,
      resumeToken: "graceful-network-resume-0001",
    }),
  );
  const resumed = await resumedMessage;
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.clientId, joined.clientId);
  assert.equal(resumed.broadcasterId, joined.clientId);
  assert.equal((await viewerSawResume).broadcasterId, joined.clientId);
  replacement.close();
  viewer.close();
});

test("rejects browser origins outside the native-app allowlist", async () => {
  const restrictedServer = createSignalServer({
    env: {
      ALLOWED_ORIGINS: "file://,http://localhost",
      ALLOW_NO_ORIGIN: "true",
    },
  });
  const address = await restrictedServer.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/signal`;
  try {
    const rejection = await new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        origin: "https://untrusted.example",
      });
      const timeout = setTimeout(
        () => reject(new Error("origin rejection timed out")),
        2_000,
      );
      socket.once("unexpected-response", (_request, response) => {
        clearTimeout(timeout);
        resolve({
          statusCode: response.statusCode,
          connection: response.headers.connection,
          contentLength: response.headers["content-length"],
        });
        response.destroy();
        socket.terminate();
      });
      socket.once("open", () => {
        clearTimeout(timeout);
        socket.close();
        reject(new Error("untrusted origin was accepted"));
      });
      socket.once("error", () => undefined);
    });
    assert.deepEqual(rejection, {
      statusCode: 403,
      connection: "close",
      contentLength: "0",
    });
  } finally {
    await restrictedServer.close();
  }
});

test("default origin policy rejects remote websites and permits loopback UI", async () => {
  const defaultPolicyServer = createSignalServer({ env: {} });
  const address = await defaultPolicyServer.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/signal`;
  try {
    const rejection = await new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        origin: "https://untrusted.example",
      });
      const timeout = setTimeout(
        () => reject(new Error("default origin rejection timed out")),
        2_000,
      );
      socket.once("unexpected-response", (_request, response) => {
        clearTimeout(timeout);
        resolve(response.statusCode);
        response.destroy();
        socket.terminate();
      });
      socket.once("open", () => {
        clearTimeout(timeout);
        socket.close();
        reject(new Error("default policy accepted a remote website"));
      });
      socket.once("error", () => undefined);
    });
    assert.equal(rejection, 403);

    const loopback = await openSocket(url, {
      origin: "http://127.0.0.1:5173",
    });
    loopback.close();
  } finally {
    await defaultPolicyServer.close();
  }
});

test("applies per-IP limits to the real client behind a local trusted proxy", async () => {
  const proxyServer = createSignalServer({
    env: {
      TRUST_PROXY: "true",
      MAX_CLIENTS: "8",
      MAX_CLIENTS_PER_IP: "2",
    },
  });
  const address = await proxyServer.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const first = await openSocket(url, {
    headers: { "x-forwarded-for": "203.0.113.10" },
  });
  const second = await openSocket(url, {
    headers: { "x-forwarded-for": "203.0.113.10" },
  });
  const otherIp = await openSocket(url, {
    headers: { "x-forwarded-for": "203.0.113.11" },
  });
  try {
    await assert.rejects(
      openSocket(url, {
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
      /503/,
    );
  } finally {
    first.close();
    second.close();
    otherIp.close();
    await proxyServer.close();
  }
});

test("does not advertise TCP TURN until that relay path is explicitly enabled", async () => {
  const cautiousServer = createSignalServer({
    env: {
      TURN_URLS:
        "turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp",
      TURN_SECRET: "test-secret",
      ALLOW_LEGACY_PROTOCOL: "true",
    },
  });
  const address = await cautiousServer.listen(0, "127.0.0.1");
  const socket = await new Promise((resolve, reject) => {
    const candidate = new WebSocket(
      `ws://127.0.0.1:${address.port}/signal`,
    );
    candidate.once("open", () => resolve(candidate));
    candidate.once("error", reject);
  });
  try {
    const joined = new Promise((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "room:created") resolve(message);
      });
    });
    socket.send(
      JSON.stringify({ type: "host:create", room: "M7K9P2WX" }),
    );
    const created = await joined;
    const urls = created.iceServers.flatMap((entry) =>
      Array.isArray(entry.urls) ? entry.urls : [entry.urls],
    );
    assert.ok(urls.some((url) => url.includes("transport=udp")));
    assert.ok(!urls.some((url) => url.includes("transport=tcp")));
  } finally {
    socket.close();
    await cautiousServer.close();
  }
});

test("isolates malformed WebSocket frames without crashing the signal service", async () => {
  const errors = [];
  const isolatedServer = createSignalServer({
    logger: {
      error(message) {
        errors.push(String(message));
      },
    },
  });
  const address = await isolatedServer.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/signal`;
  try {
    const handshake = await sendMalformedWebSocketFrame(address.port);
    assert.match(handshake, /101 Switching Protocols/);
    assert.ok(
      errors.some((message) => /invalid opcode|WebSocket/i.test(message)),
    );
    const healthy = await openSocket(url);
    healthy.close();
  } finally {
    await isolatedServer.close();
  }
});

test("refuses an in-place switch between screen and Emby broadcast modes", async () => {
  const host = await openSocket();
  const joinedMessage = nextMessage(host, "channel:joined");
  host.send(
    JSON.stringify({
      type: "channel:join",
      room: modeOwner.room,
      nickname: "模式测试",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: modeOwner.ownerToken,
    }),
  );
  await joinedMessage;
  const granted = nextMessage(host, "broadcast:granted");
  host.send(
    JSON.stringify({
      type: "broadcast:start",
      broadcastCapabilities: {
        width: 1920,
        height: 1080,
        frameRate: 30,
      },
    }),
  );
  await granted;

  const rejected = nextMessage(host, "error");
  host.send(
    JSON.stringify({
      type: "broadcast:capabilities",
      broadcastCapabilities: {
        width: 1920,
        height: 1080,
        frameRate: 30,
        mode: "emby",
        mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
        videoCodec: "h264",
        audioCodec: "aac",
        bitrate: 8_000_000,
      },
    }),
  );
  const error = await rejected;
  assert.equal(error.code, "broadcast-mode-change");
  assert.equal(
    server.rooms.get(modeOwner.room).broadcastCapabilities.mode,
    undefined,
  );
  host.close();
});

test("routes a viewer ICE-restart request only to the active broadcaster", async () => {
  const host = await openSocket();
  const hostJoined = nextMessage(host, "channel:joined");
  host.send(
    JSON.stringify({
      type: "channel:join",
      room: restartOwner.room,
      nickname: "放映端",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: restartOwner.ownerToken,
    }),
  );
  await hostJoined;
  const hostGranted = nextMessage(host, "broadcast:granted");
  host.send(
    JSON.stringify({
      type: "broadcast:start",
      broadcastCapabilities: {
        width: 1280,
        height: 720,
        frameRate: 30,
      },
    }),
  );
  await hostGranted;

  const viewer = await openSocket();
  const viewerJoined = nextMessage(viewer, "channel:joined");
  viewer.send(
    JSON.stringify({
      type: "channel:join",
      room: restartOwner.room,
      nickname: "观看端",
      canBroadcast: false,
    }),
  );
  const joined = await viewerJoined;
  const restart = nextMessage(host, "media:ice-restart");
  viewer.send(
    JSON.stringify({
      type: "media:ice-restart",
      attempt: 2,
      sessionId: "restart-session-123",
    }),
  );
  assert.deepEqual(await restart, {
    type: "media:ice-restart",
    viewerId: joined.clientId,
    attempt: 2,
    sessionId: "restart-session-123",
  });
  host.close();
  viewer.close();
});

test("groups IPv6 clients by /64 and ignores a forged left-most XFF hop", async () => {
  const proxyServer = createSignalServer({
    env: {
      TRUST_PROXY: "true",
      MAX_CLIENTS: "8",
      MAX_CLIENTS_PER_IP: "2",
    },
  });
  const address = await proxyServer.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const first = await openSocket(url, {
    headers: {
      "x-forwarded-for": "198.51.100.99, 2001:db8:abcd:42::1",
    },
  });
  const second = await openSocket(url, {
    headers: { "x-forwarded-for": "2001:db8:abcd:42::2" },
  });
  const otherPrefix = await openSocket(url, {
    headers: { "x-forwarded-for": "2001:db8:abcd:43::1" },
  });
  try {
    await assert.rejects(
      openSocket(url, {
        headers: { "x-forwarded-for": "2001:db8:abcd:42::ffff" },
      }),
      /503/,
    );
  } finally {
    first.close();
    second.close();
    otherPrefix.close();
    await proxyServer.close();
  }
});

test("a kicked resume token cannot bypass a newly full room", async () => {
  const capacityServer = createSignalServer({
    env: {
      MAX_VIEWERS_PER_ROOM: "1",
      MAX_CLIENTS: "8",
      MAX_CLIENTS_PER_IP: "8",
    },
  });
  const address = await capacityServer.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const credential = ownerCredential(197);
  const owner = await openSocket(url);
  const member = await openSocket(url);
  const staleResumeToken = "resume-token-kicked-1234";
  try {
    const ownerJoined = nextMessage(owner, "channel:joined");
    owner.send(
      JSON.stringify({
        type: "channel:join",
        room: credential.room,
        canBroadcast: true,
        createIfMissing: true,
        ownerToken: credential.ownerToken,
      }),
    );
    await ownerJoined;
    const memberJoined = nextMessage(member, "channel:joined");
    member.send(
      JSON.stringify({
        type: "channel:join",
        room: credential.room,
        canBroadcast: false,
        resumeToken: staleResumeToken,
      }),
    );
    const joined = await memberJoined;
    const memberKicked = nextMessage(member, "moderation:kicked");
    const ownerSawLeave = nextMessage(owner, "participant:left");
    owner.send(
      JSON.stringify({
        type: "moderation:kick",
        target: joined.clientId,
      }),
    );
    await memberKicked;
    await ownerSawLeave;

    const replacement = await openSocket(url);
    const replacementJoined = nextMessage(replacement, "channel:joined");
    replacement.send(
      JSON.stringify({
        type: "channel:join",
        room: credential.room,
        canBroadcast: false,
      }),
    );
    await replacementJoined;

    const resumed = await openSocket(url);
    const rejected = nextMessage(resumed, "error");
    resumed.send(
      JSON.stringify({
        type: "channel:join",
        room: credential.room,
        canBroadcast: false,
        resumeToken: staleResumeToken,
      }),
    );
    assert.match((await rejected).message, /频道人数已满/);
    resumed.close();
    replacement.close();
  } finally {
    owner.close();
    member.close();
    await capacityServer.close();
  }
});
