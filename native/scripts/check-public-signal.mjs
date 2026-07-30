import WebSocket from "ws";
import ownerTools from "./channel-owner.cjs";

const url = process.argv[2] || "wss://synced.com.cn/signal";
const { room, ownerToken } = ownerTools.createChannelOwner();

function summarizeIceServers(iceServers) {
  const urls = (Array.isArray(iceServers) ? iceServers : []).flatMap(
    (server) =>
      (Array.isArray(server?.urls) ? server.urls : [server?.urls]).filter(
        (candidate) => typeof candidate === "string",
      ),
  );
  const credentialTtlSeconds = (Array.isArray(iceServers)
    ? iceServers
    : []
  )
    .map((server) => String(server?.username || "").split(":")[0])
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite)
    .map((expiresAt) =>
      Math.max(0, expiresAt - Math.floor(Date.now() / 1_000)),
    );
  return {
    count: urls.length,
    urls,
    transports: {
      stun: urls.some((candidate) => /^stuns?:/iu.test(candidate)),
      turnUdp: urls.some(
        (candidate) =>
          /^turns?:/iu.test(candidate) &&
          !/[?&]transport=(?:tcp|tls)(?:&|$)/iu.test(candidate),
      ),
      turnTcp: urls.some(
        (candidate) =>
          /^turns?:/iu.test(candidate) &&
          /[?&]transport=tcp(?:&|$)/iu.test(candidate),
      ),
      turnTls: urls.some((candidate) => /^turns:/iu.test(candidate)),
    },
    credentialTtlSeconds:
      credentialTtlSeconds.length > 0
        ? Math.min(...credentialTtlSeconds)
        : undefined,
  };
}

function turnUsernames(iceServers) {
  return new Set(
    (Array.isArray(iceServers) ? iceServers : [])
      .filter((server) =>
        (Array.isArray(server?.urls) ? server.urls : [server?.urls]).some(
          (candidate) =>
            typeof candidate === "string" && /^turns?:/iu.test(candidate),
        ),
      )
      .map((server) => server?.username)
      .filter((username) => typeof username === "string" && username.length > 0),
  );
}

function connect(label) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const queue = [];
    const waiters = [];
    const recentTypes = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      recentTypes.push(message.type);
      if (recentTypes.length > 12) recentTypes.shift();
      if (message.type === "error") {
        const error = new Error(
          `${label} 被服务器拒绝：${message.message || "未知错误"}`,
        );
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        queue.push(message);
        return;
      }
      const index = waiters.findIndex((waiter) => waiter.type === message.type);
      if (index >= 0) {
        const waiter = waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        queue.push(message);
      }
    });
    socket.once("open", () => {
      resolve({
        socket,
        next(type, waitMs = 6_000) {
          const queuedError = queue.find((message) => message.type === "error");
          if (queuedError) {
            return Promise.reject(
              new Error(
                `${label} 被服务器拒绝：${queuedError.message || "未知错误"}`,
              ),
            );
          }
          const index = queue.findIndex((message) => message.type === type);
          if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
          return new Promise((nextResolve, nextReject) => {
            const timer = setTimeout(() => {
              const waiterIndex = waiters.findIndex(
                (waiter) => waiter.timer === timer,
              );
              if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
              nextReject(
                new Error(
                  `${label} 等待 ${type} 超时；最近消息：${recentTypes.join(",") || "无"}`,
                ),
              );
            }, waitMs);
            waiters.push({
              type,
              resolve: nextResolve,
              reject: nextReject,
              timer,
            });
          });
        },
      });
    });
    socket.once("error", reject);
  });
}

const timeout = setTimeout(() => {
  console.error("public signal check exceeded 30 seconds");
  process.exit(1);
}, 30_000);

try {
  const owner = await connect("频道主");
  const member = await connect("成员");
  const ownerJoined = owner.next("channel:joined");
  owner.socket.send(
    JSON.stringify({
      type: "channel:join",
      room,
      nickname: "公网测试-频道主",
      channelName: "公网联机测试",
      canBroadcast: true,
      createIfMissing: true,
      ownerToken,
      resumeToken: "public-owner-resume-token-0001",
    }),
  );
  const created = await ownerJoined;

  const memberJoined = member.next("channel:joined");
  member.socket.send(
    JSON.stringify({
      type: "channel:join",
      room,
      nickname: "公网测试-朋友电脑",
      canBroadcast: true,
      createIfMissing: false,
      resumeToken: "public-member-resume-token-001",
    }),
  );
  const joined = await memberJoined;

  const ownerSawBroadcast = owner.next("broadcast:started");
  const memberGranted = member.next("broadcast:granted");
  const broadcastCapabilities = {
    width: 2560,
    height: 1440,
    frameRate: 30,
  };
  member.socket.send(
    JSON.stringify({
      type: "broadcast:start",
      broadcastCapabilities,
    }),
  );
  const granted = await memberGranted;
  const started = await ownerSawBroadcast;

  const memberSawWatcher = member.next("viewer:joined");
  owner.socket.send(
    JSON.stringify({
      type: "broadcast:watch-ready",
      attempt: 2,
      sessionId: "public-check-02",
      codecs: ["video/VP8", "video/H264"],
    }),
  );
  const watcher = await memberSawWatcher;

  const memberSawSignal = member.next("signal");
  owner.socket.send(
    JSON.stringify({
      type: "signal",
      target: "broadcaster",
      attempt: 2,
      sessionId: "public-check-02",
      data: { type: "answer", sdp: "public-check-answer" },
    }),
  );
  const relayedSignal = await memberSawSignal;

  const memberSawMediaReady = member.next("media:ready");
  owner.socket.send(
    JSON.stringify({
      type: "media:ready",
      sessionId: "public-check-02",
    }),
  );
  const mediaReady = await memberSawMediaReady;

  const ownerVoiceReady = owner.next("voice:ready");
  owner.socket.send(JSON.stringify({ type: "voice:join" }));
  await ownerVoiceReady;

  const memberVoiceReady = member.next("voice:ready");
  member.socket.send(JSON.stringify({ type: "voice:join" }));
  const voiceReady = await memberVoiceReady;
  const ownerVoiceSignal = owner.next("voice:signal");
  member.socket.send(
    JSON.stringify({
      type: "voice:signal",
      target: created.clientId,
      sessionId: "public-voice-relay-01",
      iceMode: "relay",
      data: { type: "offer", sdp: "public-voice-relay-offer" },
    }),
  );
  const voiceSignal = await ownerVoiceSignal;
  if (
    voiceSignal.iceMode !== "relay" ||
    voiceSignal.sessionId !== "public-voice-relay-01"
  ) {
    throw new Error("public server did not preserve TURN-only voice mode");
  }

  const ownerMusicStarted = owner.next("voice:music");
  member.socket.send(JSON.stringify({ type: "voice:music", active: true }));
  const musicStarted = await ownerMusicStarted;
  if (
    musicStarted.active !== true ||
    musicStarted.senderId !== joined.clientId
  ) {
    throw new Error("public server did not relay shared accompaniment state");
  }
  const ownerMusicStopped = owner.next("voice:music");
  member.socket.send(JSON.stringify({ type: "voice:music", active: false }));
  const musicStopped = await ownerMusicStopped;

  const ownerChat = owner.next("chat:message");
  member.socket.send(JSON.stringify({ type: "chat:send", text: "公网弹幕正常" }));
  const chat = await ownerChat;

  const memberQuality = member.next("quality:request");
  owner.socket.send(
    JSON.stringify({
      type: "quality:request",
      height: 1080,
      frameRate: 24,
    }),
  );
  const quality = await memberQuality;
  const replacement = await connect("重连成员");
  const replacementJoined = replacement.next("channel:joined");
  const ownerSawResume = owner.next("broadcast:capabilities");
  replacement.socket.send(
    JSON.stringify({
      type: "channel:join",
      room,
      nickname: "公网测试-朋友电脑",
      canBroadcast: true,
      createIfMissing: false,
      resumeToken: "public-member-resume-token-001",
    }),
  );
  const resumed = await replacementJoined;
  const resumedBroadcast = await ownerSawResume;
  const ownerTurnUsernames = turnUsernames(created.iceServers);
  const memberTurnUsernames = turnUsernames(joined.iceServers);
  const turnCredentialsPerClient =
    ownerTurnUsernames.size > 0 &&
    memberTurnUsernames.size > 0 &&
    [...ownerTurnUsernames].every(
      (username) => !memberTurnUsernames.has(username),
    );
  const capabilitiesSynced =
    JSON.stringify(granted.broadcastCapabilities) ===
      JSON.stringify(broadcastCapabilities) &&
    JSON.stringify(started.broadcastCapabilities) ===
      JSON.stringify(broadcastCapabilities);
  if (!capabilitiesSynced) {
    throw new Error("public server did not relay broadcast capabilities");
  }

  console.log(
    JSON.stringify({
      ok: true,
      room,
      channelName: created.channelName,
      participants: joined.participants.length,
      broadcaster: granted.broadcasterId === joined.clientId,
      broadcastCapabilities: capabilitiesSynced,
      watcherReady:
        watcher.viewerId === created.clientId &&
        watcher.attempt === 2 &&
        watcher.sessionId === "public-check-02",
      negotiationTagged:
        relayedSignal.attempt === 2 &&
        relayedSignal.sessionId === "public-check-02" &&
        mediaReady.sessionId === "public-check-02",
      voicePeers: voiceReady.participants.length,
      voiceRelayMode: voiceSignal.iceMode,
      sharedMusic:
        musicStarted.active === true && musicStopped.active === false,
      chat: chat.text,
      quality: `${quality.height}p/${quality.frameRate}fps`,
      reconnectTakeover:
        resumed.resumed === true &&
        resumed.clientId === joined.clientId &&
        resumed.broadcasterId === joined.clientId &&
        resumedBroadcast.broadcasterId === joined.clientId,
      turnCredentialsPerClient,
      // Never print the short-lived TURN username or HMAC credential. CI logs
      // need topology and TTL diagnostics, not replayable relay access.
      iceServers: summarizeIceServers(created.iceServers),
    }),
  );
  owner.socket.close();
  member.socket.close();
  replacement.socket.close();
} finally {
  clearTimeout(timeout);
}
