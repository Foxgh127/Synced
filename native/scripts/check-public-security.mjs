import assert from "node:assert/strict";
import WebSocket from "ws";
import ownerTools from "./channel-owner.cjs";

const signalUrl =
  process.argv[2] || "wss://synced.com.cn/signal";
const roomAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const sockets = new Set();
const startedAt = Date.now();

function trace(label) {
  if (process.env.SYNCED_CHECK_DEBUG === "1") {
    console.error(
      `[security-check +${((Date.now() - startedAt) / 1_000).toFixed(1)}s] ${label}`,
    );
  }
}

function legacyConstructedTokenForRoom(room, fill = 97) {
  const bytes = Buffer.alloc(32, fill);
  for (let index = 0; index < room.length; index += 1) {
    bytes[index] = roomAlphabet.indexOf(room[index]);
  }
  return bytes.toString("base64url");
}

function openSocketAttempt(label, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(signalUrl, options);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`${label} 连接超时`));
    }, 8_000);
    socket.once("open", () => {
      clearTimeout(timer);
      sockets.add(socket);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} 连接失败：${error.message}`));
    });
  });
}

async function openSocket(label, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await openSocketAttempt(label, options);
    } catch (error) {
      lastError = error;
      trace(`${label} 第 ${attempt} 次连接失败`);
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }
  throw lastError;
}

function nextMessage(socket, label, expectedType, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} 等待 ${expectedType} 超时`));
    }, timeoutMs);
    const onClose = (code) => {
      cleanup();
      reject(new Error(`${label} 提前断开（${code}）`));
    };
    const onMessage = (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        cleanup();
        reject(new Error(`${label} 收到无效 JSON`));
        return;
      }
      if (message.type !== expectedType) {
        if (message.type === "error") {
          cleanup();
          reject(
            new Error(`${label} 被拒绝：${message.message || "未知错误"}`),
          );
        }
        return;
      }
      cleanup();
      resolve(message);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

async function sendAndWait(socket, label, payload, expectedType) {
  const response = nextMessage(socket, label, expectedType);
  socket.send(JSON.stringify(payload));
  return response;
}

function closeSocket(socket) {
  if (!socket) return;
  sockets.delete(socket);
  if (socket.readyState !== WebSocket.CLOSED) {
    // This is a one-shot deployment probe. Terminating after assertions keeps
    // a slow or malicious close handshake from holding CI open for 30 seconds.
    socket.terminate();
  }
}

async function assertOriginRejected() {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(signalUrl, {
      headers: { Origin: "https://attacker.invalid" },
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("恶意 Origin 未在时限内被拒绝"));
    }, 8_000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("恶意 Origin 被错误放行"));
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.destroy();
      socket.terminate();
      try {
        assert.equal(response.statusCode, 403);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (/403/u.test(error.message)) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

const timeout = setTimeout(() => {
  for (const socket of sockets) socket.terminate();
  console.error("public security check exceeded 45 seconds");
  process.exit(1);
}, 45_000);

try {
  await assertOriginRejected();
  trace("origin rejected");

  const { room, ownerToken } = ownerTools.createChannelOwner();
  // Reuse one unauthenticated socket for all rejected join attempts. Apart
  // from making the probe faster, this avoids mistaking a burst-protection
  // throttle at the public load balancer for a protocol regression.
  const rejectedClient = await openSocket("拒绝场景客户端");
  const legacyError = await sendAndWait(
    rejectedClient,
    "旧协议客户端",
    { type: "host:create", room },
    "error",
  );
  assert.match(legacyError.message, /版本过旧/u);
  trace("legacy protocol rejected");

  const visitorError = await sendAndWait(
    rejectedClient,
    "抢先进入者",
    {
      type: "channel:join",
      room,
      nickname: "抢先进入者",
      canBroadcast: true,
      createIfMissing: true,
    },
    "error",
  );
  assert.match(visitorError.message, /频道暂时无人在线/u);
  trace("first visitor rejected");

  const forgedError = await sendAndWait(
    rejectedClient,
    "旧算法伪造者",
    {
      type: "channel:join",
      room,
      nickname: "旧算法伪造者",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: legacyConstructedTokenForRoom(room),
    },
    "error",
  );
  assert.match(forgedError.message, /频道暂时无人在线/u);
  trace("reversible credential rejected");

  const owner = await openSocket("频道主");
  const ownerJoined = await sendAndWait(
    owner,
    "频道主",
    {
      type: "channel:join",
      room,
      nickname: "安全检查频道主",
      channelName: "安全检查",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken,
    },
    "channel:joined",
  );
  assert.equal(ownerJoined.created, true);
  assert.equal(
    ownerJoined.participants.find(
      (participant) => participant.id === ownerJoined.clientId,
    )?.role,
    "host",
  );
  trace("owner created channel");

  const member = await openSocket("普通成员");
  const memberJoined = await sendAndWait(
    member,
    "普通成员",
    {
      type: "channel:join",
      room,
      nickname: "普通成员",
      canBroadcast: true,
      createIfMissing: false,
    },
    "channel:joined",
  );
  assert.equal(
    memberJoined.participants.find(
      (participant) => participant.id === memberJoined.clientId,
    )?.role,
    "viewer",
  );
  trace("member joined");

  const ownerLeft = nextMessage(member, "普通成员", "participant:left");
  closeSocket(owner);
  assert.equal((await ownerLeft).participantId, ownerJoined.clientId);
  trace("owner disconnected");

  const moderationError = await sendAndWait(
    member,
    "普通成员",
    {
      type: "moderation:kick",
      target: ownerJoined.clientId,
    },
    "error",
  );
  assert.match(moderationError.message, /只有频道主/u);
  trace("ownership did not transfer");

  const wrongCredential = ownerTools.createChannelOwner();
  const credentialError = await sendAndWait(
    rejectedClient,
    "错误凭证客户端",
    {
      type: "channel:join",
      room,
      nickname: "错误凭证客户端",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken: wrongCredential.ownerToken,
    },
    "error",
  );
  assert.match(credentialError.message, /频道主身份凭证无效/u);
  closeSocket(rejectedClient);
  trace("invalid owner credential rejected");

  const returningOwner = await openSocket("重新上线的频道主");
  const returned = await sendAndWait(
    returningOwner,
    "重新上线的频道主",
    {
      type: "channel:join",
      room,
      nickname: "安全检查频道主",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken,
    },
    "channel:joined",
  );
  assert.equal(
    returned.participants.find(
      (participant) => participant.id === returned.clientId,
    )?.role,
    "host",
  );
  trace("owner returned");

  console.log(
    JSON.stringify({
      ok: true,
      room,
      originAllowlist: true,
      legacyProtocolBlocked: true,
      firstVisitorBlocked: true,
      reversibleCredentialBlocked: true,
      ownerRoleBound: true,
      ownerDisconnectDoesNotTransfer: true,
      invalidOwnerCredentialBlocked: true,
      ownerCanReturn: true,
    }),
  );

  closeSocket(returningOwner);
  closeSocket(member);
} finally {
  clearTimeout(timeout);
  for (const socket of sockets) closeSocket(socket);
}
