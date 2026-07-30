const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createChannelOwner } = require("./channel-owner.cjs");

function installSmokeClient() {
  const state = {
    ws: undefined,
    id: "",
    broadcasterId: undefined,
    iceServers: [],
    stream: undefined,
    drawTimer: undefined,
    audioContext: undefined,
    audioOscillator: undefined,
    receivedAudioContext: undefined,
    receivedAudioTimer: undefined,
    receivedAudioPeak: 0,
    watcher: undefined,
    watcherCandidates: [],
    watcherAttempt: 0,
    watcherSessionId: "",
    outbound: new Map(),
    gotVideo: false,
    gotAudioTrack: false,
    receivedFrames: 0,
    mediaReadyAcks: 0,
    events: [],
    queue: Promise.resolve(),
  };

  const send = (payload) => state.ws.send(JSON.stringify(payload));

  const closeWatcher = () => {
    if (state.receivedAudioTimer) {
      window.clearInterval(state.receivedAudioTimer);
      state.receivedAudioTimer = undefined;
    }
    void state.receivedAudioContext?.close();
    state.receivedAudioContext = undefined;
    state.receivedAudioPeak = 0;
    state.watcher?.close();
    state.watcher = undefined;
    state.watcherCandidates = [];
    state.gotVideo = false;
    state.gotAudioTrack = false;
  };

  const handleWatcherSignal = async (data, attempt, sessionId) => {
    if (!state.watcher) {
      return;
    }
    if (
      (attempt && attempt !== state.watcherAttempt) ||
      (sessionId && sessionId !== state.watcherSessionId)
    ) {
      return;
    }
    if (data.type) {
      await state.watcher.setRemoteDescription(data);
      for (const candidate of state.watcherCandidates.splice(0)) {
        await state.watcher.addIceCandidate(candidate);
      }
      if (data.type === "offer") {
        const answer = await state.watcher.createAnswer();
        await state.watcher.setLocalDescription(answer);
        send({
          type: "signal",
          target: "broadcaster",
          data: state.watcher.localDescription,
          attempt: state.watcherAttempt,
          sessionId: state.watcherSessionId,
        });
      }
    } else if (state.watcher.remoteDescription) {
      await state.watcher.addIceCandidate(data);
    } else {
      state.watcherCandidates.push(data);
    }
  };

  const beginWatching = () => {
    closeWatcher();
    state.watcherAttempt = 1;
    state.watcherSessionId =
      crypto.randomUUID?.() ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    state.watcher = pc;
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        send({
          type: "signal",
          target: "broadcaster",
          data: event.candidate.toJSON(),
          attempt: state.watcherAttempt,
          sessionId: state.watcherSessionId,
        });
      }
    });
    pc.addEventListener("track", (event) => {
      if (event.track.kind === "audio") {
        state.gotAudioTrack = true;
        state.events.push("audio-track");
        state.receivedAudioContext = new AudioContext({ sampleRate: 48_000 });
        const source = state.receivedAudioContext.createMediaStreamSource(
          new MediaStream([event.track]),
        );
        const analyser = state.receivedAudioContext.createAnalyser();
        const mute = state.receivedAudioContext.createGain();
        const samples = new Float32Array(analyser.fftSize);
        mute.gain.value = 0;
        source.connect(analyser);
        analyser.connect(mute);
        mute.connect(state.receivedAudioContext.destination);
        void state.receivedAudioContext.resume();
        state.receivedAudioTimer = window.setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          let peak = 0;
          for (const sample of samples) {
            peak = Math.max(peak, Math.abs(sample));
          }
          state.receivedAudioPeak = Math.max(
            state.receivedAudioPeak,
            peak,
          );
        }, 40);
        return;
      }
      if (event.track.kind !== "video") {
        return;
      }
      const video = document.querySelector("video");
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      video.play().then(() => {
        video.requestVideoFrameCallback(() => {
          state.gotVideo = true;
          state.receivedFrames += 1;
          state.events.push("video-frame");
          send({
            type: "media:ready",
            sessionId: state.watcherSessionId,
          });
        });
      });
      state.events.push("video-track");
    });
    send({
      type: "broadcast:watch-ready",
      attempt: state.watcherAttempt,
      sessionId: state.watcherSessionId,
      codecs: ["video/H264", "video/VP8", "video/VP9"],
    });
  };

  const offerTo = async (viewerId, attempt = 1, sessionId = "") => {
    state.outbound.get(viewerId)?.pc.close();
    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    state.outbound.set(viewerId, { pc, attempt, sessionId });
    for (const track of state.stream.getTracks()) {
      pc.addTrack(track, state.stream);
    }
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        send({
          type: "signal",
          target: viewerId,
          data: event.candidate.toJSON(),
          attempt,
          sessionId,
        });
      }
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({
      type: "signal",
      target: viewerId,
      data: pc.localDescription,
      attempt,
      sessionId,
    });
  };

  const handleOutboundSignal = async (
    viewerId,
    data,
    attempt,
    sessionId,
  ) => {
    const outbound = state.outbound.get(viewerId);
    if (
      !outbound ||
      (attempt && attempt !== outbound.attempt) ||
      (sessionId && sessionId !== outbound.sessionId)
    ) {
      return;
    }
    const { pc } = outbound;
    if (data.type) {
      await pc.setRemoteDescription(data);
    } else if (pc.remoteDescription) {
      await pc.addIceCandidate(data);
    }
  };

  const handleMessage = async (message) => {
    state.events.push(message.type);
    if (message.type === "channel:joined") {
      state.id = message.clientId;
      state.broadcasterId = message.broadcasterId;
      state.iceServers = message.iceServers || [];
      window.__resolveJoined(message);
      if (state.broadcasterId && state.broadcasterId !== state.id) {
        beginWatching();
      }
      return;
    }
    if (message.type === "broadcast:granted") {
      state.broadcasterId = state.id;
      for (const viewerId of message.viewerIds || []) {
        await offerTo(viewerId);
      }
      return;
    }
    if (message.type === "broadcast:started") {
      state.broadcasterId = message.broadcasterId;
      if (state.broadcasterId !== state.id) {
        beginWatching();
      }
      return;
    }
    if (message.type === "viewer:joined" && state.broadcasterId === state.id) {
      await offerTo(
        message.viewerId,
        message.attempt,
        message.sessionId,
      );
      return;
    }
    if (message.type === "signal" && message.data) {
      if (state.broadcasterId === state.id) {
        await handleOutboundSignal(
          message.from,
          message.data,
          message.attempt,
          message.sessionId,
        );
      } else {
        await handleWatcherSignal(
          message.data,
          message.attempt,
          message.sessionId,
        );
      }
      return;
    }
    if (message.type === "broadcast:stopped") {
      closeWatcher();
      state.outbound.forEach(({ pc }) => pc.close());
      state.outbound.clear();
      state.broadcasterId = undefined;
      return;
    }
    if (message.type === "media:ready") {
      state.mediaReadyAcks += 1;
      return;
    }
    if (message.type === "error") {
      throw new Error(message.message || "signal error");
    }
  };

  window.smokeJoin = (
    url,
    room,
    nickname,
    createIfMissing,
    ownerToken,
  ) =>
    new Promise((resolve, reject) => {
      window.__resolveJoined = resolve;
      const timeout = window.setTimeout(
        () => reject(new Error("channel join timeout")),
        5_000,
      );
      window.__resolveJoined = (message) => {
        window.clearTimeout(timeout);
        resolve(message);
      };
      const ws = new WebSocket(url);
      state.ws = ws;
      ws.addEventListener("open", () => {
        send({
          type: "channel:join",
          room,
          nickname,
          canBroadcast: true,
          createIfMissing,
          ownerToken,
        });
      });
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        state.queue = state.queue.then(() => handleMessage(message));
      });
      ws.addEventListener("error", () => reject(new Error("websocket error")));
    });

  window.smokeStartBroadcast = async () => {
    const canvas = document.querySelector("canvas");
    const context = canvas.getContext("2d");
    let frame = 0;
    const draw = () => {
      frame += 1;
      context.fillStyle = frame % 2 ? "#7c5cff" : "#20d6c7";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ffffff";
      context.font = "28px sans-serif";
      context.fillText(`Synced ${frame}`, 24, 70);
    };
    draw();
    state.drawTimer = window.setInterval(draw, 80);
    state.stream = canvas.captureStream(12);
    state.audioContext = new AudioContext({ sampleRate: 48_000 });
    state.audioOscillator = state.audioContext.createOscillator();
    const gain = state.audioContext.createGain();
    const destination = state.audioContext.createMediaStreamDestination();
    state.audioOscillator.frequency.value = 880;
    gain.gain.value = 0.08;
    state.audioOscillator.connect(gain);
    gain.connect(destination);
    state.audioOscillator.start();
    await state.audioContext.resume();
    state.stream.addTrack(destination.stream.getAudioTracks()[0]);
    send({ type: "broadcast:start" });
  };

  window.smokeSnapshot = async () => {
    let audioBytesReceived = 0;
    let totalAudioEnergy = 0;
    if (state.watcher) {
      const report = await state.watcher.getStats();
      report.forEach((item) => {
        if (
          item.type === "inbound-rtp" &&
          (item.kind || item.mediaType) === "audio" &&
          !item.isRemote
        ) {
          audioBytesReceived += Number(item.bytesReceived || 0);
          totalAudioEnergy += Number(item.totalAudioEnergy || 0);
        }
      });
    }
    return {
      id: state.id,
      broadcasterId: state.broadcasterId,
      gotVideo: state.gotVideo,
      gotAudioTrack: state.gotAudioTrack,
      audioBytesReceived,
      totalAudioEnergy,
      receivedAudioPeak: state.receivedAudioPeak,
      receivedFrames: state.receivedFrames,
      mediaReadyAcks: state.mediaReadyAcks,
      events: [...state.events],
    };
  };

  window.smokeClose = () => {
    if (state.drawTimer) {
      window.clearInterval(state.drawTimer);
    }
    state.audioOscillator?.stop();
    void state.audioContext?.close();
    state.stream?.getTracks().forEach((track) => track.stop());
    closeWatcher();
    state.outbound.forEach(({ pc }) => pc.close());
    state.ws?.close();
  };
}

async function waitForVideo(window, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot;
  while (Date.now() < deadline) {
    const snapshot = await window.webContents.executeJavaScript(
      "window.smokeSnapshot()",
    );
    lastSnapshot = snapshot;
    if (
      snapshot.gotVideo &&
      snapshot.gotAudioTrack &&
      snapshot.audioBytesReceived > 0 &&
      snapshot.receivedAudioPeak >= 0.005
    ) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `watcher did not receive a decoded video frame: ${JSON.stringify(lastSnapshot)}`,
  );
}

async function waitForMediaReadyAck(window, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot;
  while (Date.now() < deadline) {
    lastSnapshot = await window.webContents.executeJavaScript(
      "window.smokeSnapshot()",
    );
    if (lastSnapshot.mediaReadyAcks > 0) {
      return lastSnapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `broadcaster did not receive media-ready acknowledgement: ${JSON.stringify(lastSnapshot)}`,
  );
}

async function createClientWindow() {
  const window = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(
    path.join(__dirname, "smoke-window-capture.html"),
  );
  await window.webContents.executeJavaScript(
    `(${installSmokeClient.toString()})()`,
  );
  return window;
}

async function main() {
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  await app.whenReady();

  const externalSignalUrl = process.env.SYNCED_SMOKE_SIGNAL_URL;
  let signalServer;
  let signalUrl = externalSignalUrl;
  if (!signalUrl) {
    const serverModuleUrl = pathToFileURL(
      path.join(__dirname, "..", "server", "index.mjs"),
    ).href;
    const { createSignalServer } = await import(serverModuleUrl);
    signalServer = createSignalServer();
    const address = await signalServer.listen(0, "127.0.0.1");
    signalUrl = `ws://127.0.0.1:${address.port}/signal`;
  }
  const { room, ownerToken } = createChannelOwner();
  let owner;
  let member;

  try {
    owner = await createClientWindow();
    member = await createClientWindow();
    await owner.webContents.executeJavaScript(
      `window.smokeJoin(${JSON.stringify(signalUrl)}, ${JSON.stringify(room)}, "频道主", true, ${JSON.stringify(ownerToken)})`,
    );
    await member.webContents.executeJavaScript(
      `window.smokeJoin(${JSON.stringify(signalUrl)}, ${JSON.stringify(room)}, "朋友电脑", false)`,
    );
    await member.webContents.executeJavaScript("window.smokeStartBroadcast()");
    const ownerSnapshot = await waitForVideo(owner);
    const memberSnapshot = await waitForMediaReadyAck(member);
    if (memberSnapshot.broadcasterId !== memberSnapshot.id) {
      throw new Error("joined desktop member did not become broadcaster");
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        watcher: ownerSnapshot,
        broadcaster: memberSnapshot,
      })}\n`,
    );
  } finally {
    await owner?.webContents
      .executeJavaScript("window.smokeClose()")
      .catch(() => undefined);
    await member?.webContents
      .executeJavaScript("window.smokeClose()")
      .catch(() => undefined);
    owner?.destroy();
    member?.destroy();
    await signalServer?.close();
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    app.exit(1);
  });
