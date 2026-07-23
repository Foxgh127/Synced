import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const MAX_VIEWERS_PER_ROOM = 8;
const MAX_MESSAGES_PER_MINUTE = 240;
const ROOM_PATTERN = /^[23456789A-HJ-NP-Z]{8}$/;

function buildIceServers(room, env = process.env) {
  const turnUrls = env.TURN_URLS?.split(",").map((value) => value.trim()).filter(Boolean);
  if (turnUrls?.length && env.TURN_SECRET) {
    const expiresAt = Math.floor(Date.now() / 1000) + 4 * 60 * 60;
    const username = `${expiresAt}:${room}`;
    const credential = createHmac("sha1", env.TURN_SECRET).update(username).digest("base64");
    return [{ urls: turnUrls, username, credential }];
  }
  if (env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(env.ICE_SERVERS_JSON);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export function createSignalServer(options = {}) {
  const rooms = new Map();
  const clients = new Map();
  const env = options.env || process.env;
  const httpServer = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        name: "yiqikan-signal",
        status: "ready",
        websocket: "/signal",
      }),
    );
  });
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });

  httpServer.on("upgrade", (request, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/signal") {
      socket.destroy();
      return;
    }
    const allowedOrigins = env.ALLOWED_ORIGINS?.split(",").map((value) => value.trim());
    const origin = request.headers.origin;
    if (
      allowedOrigins?.length &&
      !allowedOrigins.includes("*") &&
      (!origin || !allowedOrigins.includes(origin))
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (socket) => {
    const clientId = randomUUID();
    const state = {
      id: clientId,
      role: undefined,
      room: undefined,
      messages: 0,
      windowStartedAt: Date.now(),
    };
    clients.set(clientId, { socket, state });

    socket.on("message", (buffer) => {
      const now = Date.now();
      if (now - state.windowStartedAt >= 60_000) {
        state.windowStartedAt = now;
        state.messages = 0;
      }
      state.messages += 1;
      if (state.messages > MAX_MESSAGES_PER_MINUTE) {
        send(socket, { type: "error", message: "消息过于频繁" });
        socket.close(1008, "rate limit");
        return;
      }

      let message;
      try {
        message = JSON.parse(buffer.toString());
      } catch {
        send(socket, { type: "error", message: "消息格式错误" });
        return;
      }

      if (message.type === "host:create") {
        const room = String(message.room || "").toUpperCase();
        if (!ROOM_PATTERN.test(room)) {
          send(socket, { type: "error", message: "房间码格式错误" });
          return;
        }
        if (rooms.has(room)) {
          send(socket, { type: "error", message: "房间码冲突，请重新开始分享" });
          return;
        }
        state.role = "host";
        state.room = room;
        rooms.set(room, { hostId: clientId, viewers: new Set() });
        send(socket, { type: "room:created", room, iceServers: buildIceServers(room, env) });
        return;
      }

      if (message.type === "viewer:join") {
        const room = String(message.room || "").toUpperCase();
        const entry = rooms.get(room);
        if (!entry) {
          send(socket, { type: "error", message: "房间不存在或已经结束" });
          return;
        }
        if (entry.viewers.size >= MAX_VIEWERS_PER_ROOM) {
          send(socket, { type: "error", message: "房间人数已满" });
          return;
        }
        state.role = "viewer";
        state.room = room;
        entry.viewers.add(clientId);
        send(socket, {
          type: "room:joined",
          room,
          viewerId: clientId,
          iceServers: buildIceServers(room, env),
        });
        const host = clients.get(entry.hostId);
        if (host) {
          send(host.socket, { type: "viewer:joined", viewerId: clientId });
        }
        return;
      }

      if (message.type === "signal") {
        if (!state.room || !state.role || !message.data) {
          send(socket, { type: "error", message: "尚未加入房间" });
          return;
        }
        const room = rooms.get(state.room);
        if (!room) {
          send(socket, { type: "error", message: "房间已经结束" });
          return;
        }
        const targetId =
          state.role === "viewer" && message.target === "host"
            ? room.hostId
            : state.role === "host" && room.viewers.has(message.target)
              ? message.target
              : undefined;
        const target = targetId ? clients.get(targetId) : undefined;
        if (!target) {
          send(socket, { type: "error", message: "目标用户不存在" });
          return;
        }
        send(target.socket, {
          type: "signal",
          from: clientId,
          data: message.data,
        });
        return;
      }

      if (message.type === "ping") {
        send(socket, { type: "pong" });
        return;
      }
      send(socket, { type: "error", message: "不支持的操作" });
    });

    socket.on("close", () => {
      clients.delete(clientId);
      if (!state.room || !state.role) {
        return;
      }
      const room = rooms.get(state.room);
      if (!room) {
        return;
      }
      if (state.role === "host") {
        for (const viewerId of room.viewers) {
          const viewer = clients.get(viewerId);
          if (viewer) {
            send(viewer.socket, { type: "host:left" });
            viewer.state.room = undefined;
            viewer.state.role = undefined;
          }
        }
        rooms.delete(state.room);
      } else {
        room.viewers.delete(clientId);
        const host = clients.get(room.hostId);
        if (host) {
          send(host.socket, { type: "viewer:left", viewerId: clientId });
        }
      }
    });
  });

  return {
    httpServer,
    rooms,
    clients,
    listen(port = 8787, host = "0.0.0.0") {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve(httpServer.address());
        });
      });
    },
    close() {
      for (const client of clients.values()) {
        client.socket.close();
      }
      return new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  const server = createSignalServer();
  await server.listen(port, host);
  console.log(`yiqikan-signal listening on ${host}:${port}`);
}
