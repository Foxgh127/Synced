import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { createSignalServer } from "../server/index.mjs";

let server;
let baseUrl;

before(async () => {
  server = createSignalServer({
    env: {
      TURN_URLS: "turn:127.0.0.1:3478?transport=udp",
      TURN_SECRET: "test-secret",
    },
  });
  const address = await server.listen(0, "127.0.0.1");
  baseUrl = `ws://127.0.0.1:${address.port}/signal`;
});

after(async () => {
  await server.close();
});

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(baseUrl);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

test("creates a room, joins a viewer, and relays signaling", async () => {
  const host = await openSocket();
  const hostCreated = nextMessage(host);
  host.send(JSON.stringify({ type: "host:create", room: "A7K9P2WX" }));
  const created = await hostCreated;
  assert.equal(created.type, "room:created");
  assert.equal(created.iceServers[0].urls[0], "turn:127.0.0.1:3478?transport=udp");
  assert.ok(created.iceServers[0].credential);

  const viewer = await openSocket();
  const viewerJoined = nextMessage(viewer);
  const hostSawViewer = nextMessage(host);
  viewer.send(JSON.stringify({ type: "viewer:join", room: "A7K9P2WX" }));
  const joined = await viewerJoined;
  const appeared = await hostSawViewer;
  assert.equal(joined.type, "room:joined");
  assert.equal(appeared.type, "viewer:joined");

  const viewerReceived = nextMessage(viewer);
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

  host.close();
  viewer.close();
});

test("rejects invalid and missing rooms", async () => {
  const invalid = await openSocket();
  const invalidMessage = nextMessage(invalid);
  invalid.send(JSON.stringify({ type: "host:create", room: "123" }));
  assert.equal((await invalidMessage).type, "error");
  invalid.close();

  const viewer = await openSocket();
  const missingMessage = nextMessage(viewer);
  viewer.send(JSON.stringify({ type: "viewer:join", room: "ZZZZZZZZ" }));
  assert.match((await missingMessage).message, /不存在/);
  viewer.close();
});
