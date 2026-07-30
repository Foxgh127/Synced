const { app, BrowserWindow, desktopCapturer, session } = require("electron");
const path = require("node:path");
const {
  createChannelOwner,
  roomForOwnerToken,
} = require("./channel-owner.cjs");

const SOURCE_TITLE = "Synced Phone E2E Source";
const signalUrl =
  process.env.SYNCED_PHONE_SIGNAL || "wss://synced.com.cn/signal";
const generatedOwner = createChannelOwner();
const ownerToken =
  process.env.SYNCED_PHONE_OWNER_TOKEN || generatedOwner.ownerToken;
const room = roomForOwnerToken(ownerToken);
const requestedRoom = process.env.SYNCED_PHONE_ROOM?.trim().toUpperCase();
if (requestedRoom && requestedRoom !== room) {
  throw new Error(
    "SYNCED_PHONE_ROOM 与 SYNCED_PHONE_OWNER_TOKEN 不匹配；安全频道码必须由频道主凭证派生",
  );
}
const syntheticVideo = process.env.SYNCED_PHONE_SYNTHETIC === "1";
const voiceEnabled = process.env.SYNCED_PHONE_VOICE === "1";
const holdMilliseconds = Number(
  process.env.SYNCED_PHONE_HOLD_MS || "20000",
);

async function main() {
  process.stdout.write(`PHONE_E2E_CHANNEL ${room}\n`);
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  await app.whenReady();

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) =>
      ["media", "display-capture"].includes(permission),
  );
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) =>
      callback(["media", "display-capture"].includes(permission)),
  );
  let sourceMediaId;
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 },
      });
      const source = sources.find(
        (candidate) =>
          candidate.id === sourceMediaId ||
          candidate.id.split(":")[1] === sourceMediaId?.split(":")[1] ||
          candidate.name === SOURCE_TITLE,
      ) || sources[0];
      if (!source) {
        process.stderr.write(
          `PHONE_E2E_SOURCE_MISSING ${JSON.stringify({ sourceMediaId, sources: sources.map((item) => ({ id: item.id, name: item.name })) })}\n`,
        );
        callback({});
        return;
      }
      callback({ video: source });
    },
  );

  const sourceWindow = new BrowserWindow({
    title: SOURCE_TITLE,
    width: 960,
    height: 540,
    show: true,
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false },
  });
  await sourceWindow.loadFile(
    path.join(__dirname, "smoke-window-source.html"),
  );
  await sourceWindow.webContents.executeJavaScript(
    `document.title = ${JSON.stringify(SOURCE_TITLE)}`,
  );
  sourceMediaId = sourceWindow.getMediaSourceId();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await sourceWindow.webContents.executeJavaScript(
      "window.videoReady === true",
    );
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const controller = new BrowserWindow({
    width: 640,
    height: 360,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await controller.loadFile(
    path.join(__dirname, "smoke-window-capture.html"),
  );
  controller.webContents.on("console-message", (_event, level, message) => {
    process.stdout.write(`PHONE_E2E_LOG ${level} ${message}\n`);
  });
  process.stdout.write(`PHONE_E2E_ROOM ${room}\n`);

  try {
    const result = await controller.webContents.executeJavaScript(`(async () => {
      const signalUrl = ${JSON.stringify(signalUrl)};
      const room = ${JSON.stringify(room)};
      const ownerToken = ${JSON.stringify(ownerToken)};
      const syntheticVideo = ${JSON.stringify(syntheticVideo)};
      const voiceEnabled = ${JSON.stringify(voiceEnabled)};
      const holdMilliseconds = ${JSON.stringify(holdMilliseconds)};
      const events = [];
      const peers = new Map();
      const voicePeers = new Map();
      let iceServers = [];
      const socket = new WebSocket(signalUrl);
      const send = (message) => socket.send(JSON.stringify(message));
      const log = (type, detail = {}) => {
        const event = { at: Date.now(), type, ...detail };
        events.push(event);
        console.log(JSON.stringify(event));
      };
      let syntheticTimer;
      let capture;
      if (syntheticVideo) {
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const context = canvas.getContext("2d");
        let phase = 0;
        const draw = () => {
          phase = (phase + 8) % canvas.width;
          const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
          gradient.addColorStop(0, "#101d3d");
          gradient.addColorStop(1, "#4b1d66");
          context.fillStyle = gradient;
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#65e6ff";
          context.fillRect(phase - 160, 250, 160, 160);
          context.fillStyle = "#ffffff";
          context.font = "700 64px sans-serif";
          context.fillText("同频 TURN 真机测试", 220, 150);
          context.font = "36px sans-serif";
          context.fillText(new Date().toLocaleTimeString(), 500, 580);
        };
        draw();
        syntheticTimer = setInterval(draw, 33);
        capture = canvas.captureStream(30);
      } else {
        capture = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
            frameRate: { ideal: 30, max: 30 }
          },
          audio: false
        });
      }
      const videoTrack = capture.getVideoTracks()[0];
      videoTrack.contentHint = "motion";

      const audioContext = new AudioContext({ sampleRate: 48000 });
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const audioDestination = audioContext.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      gain.gain.value = 0.03;
      oscillator.connect(gain).connect(audioDestination);
      oscillator.start();
      let voiceOscillator;
      let voiceDestination;
      if (voiceEnabled) {
        voiceOscillator = audioContext.createOscillator();
        const voiceGain = audioContext.createGain();
        voiceDestination = audioContext.createMediaStreamDestination();
        voiceOscillator.frequency.value = 660;
        voiceGain.gain.value = 0.025;
        voiceOscillator.connect(voiceGain).connect(voiceDestination);
        voiceOscillator.start();
      }
      await audioContext.resume();
      const stream = new MediaStream([
        videoTrack,
        audioDestination.stream.getAudioTracks()[0]
      ]);

      const completion = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("phone did not decode a frame within 90 seconds")),
          90000
        );
        socket.addEventListener("open", () => {
          log("signal-open");
          send({
            type: "channel:join",
            room,
            nickname: "Windows实机测试",
            channelName: "手机实机测试",
            canBroadcast: true,
            createIfMissing: true,
            ownerToken
          });
        });
        socket.addEventListener("message", async (event) => {
          const message = JSON.parse(event.data);
          log("signal-" + message.type, {
            attempt: message.attempt,
            sessionId: message.sessionId
          });
          if (message.type === "channel:joined") {
            iceServers = message.iceServers || [];
            const captureSettings = videoTrack.getSettings();
            send({
              type: "broadcast:start",
              broadcastCapabilities: {
                width: Number(captureSettings.width) || 1280,
                height: Number(captureSettings.height) || 720,
                frameRate: Number(captureSettings.frameRate) || 30,
              },
            });
            if (voiceEnabled) send({ type: "voice:join" });
            return;
          }
          if (
            message.type === "voice:signal" &&
            message.from &&
            message.data &&
            voiceEnabled &&
            voiceDestination
          ) {
            let voicePeer = voicePeers.get(message.from);
            if (!voicePeer) {
              const pc = new RTCPeerConnection({
                iceServers,
                bundlePolicy: "max-bundle",
                rtcpMuxPolicy: "require",
                iceCandidatePoolSize: 4
              });
              voicePeer = { pc, candidates: [] };
              voicePeers.set(message.from, voicePeer);
              pc.addTrack(
                voiceDestination.stream.getAudioTracks()[0],
                voiceDestination.stream
              );
              pc.addEventListener("icecandidate", (candidateEvent) => {
                if (!candidateEvent.candidate) return;
                send({
                  type: "voice:signal",
                  target: message.from,
                  data: candidateEvent.candidate.toJSON()
                });
              });
              pc.addEventListener("connectionstatechange", () =>
                log("voice-connection-state", {
                  state: pc.connectionState,
                  peerId: message.from
                })
              );
              pc.addEventListener("track", (trackEvent) =>
                log("voice-remote-track", {
                  kind: trackEvent.track.kind,
                  readyState: trackEvent.track.readyState,
                  peerId: message.from
                })
              );
            }
            const { pc } = voicePeer;
            if (message.data.type) {
              await pc.setRemoteDescription(message.data);
              for (const candidate of voicePeer.candidates.splice(0)) {
                await pc.addIceCandidate(candidate);
              }
              if (message.data.type === "offer") {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                send({
                  type: "voice:signal",
                  target: message.from,
                  data: pc.localDescription
                });
              }
            } else if (pc.remoteDescription) {
              await pc.addIceCandidate(message.data);
            } else {
              voicePeer.candidates.push(message.data);
            }
            return;
          }
          if (message.type === "viewer:joined") {
            peers.get(message.viewerId)?.pc.close();
            const pc = new RTCPeerConnection({
              iceServers,
              bundlePolicy: "max-bundle",
              rtcpMuxPolicy: "require",
              iceCandidatePoolSize: 4
            });
            peers.set(message.viewerId, { pc, candidates: [] });
            pc.addEventListener("icecandidate", (candidateEvent) => {
              if (!candidateEvent.candidate) {
                log("ice-complete");
                return;
              }
              log("local-candidate", {
                candidate: candidateEvent.candidate.candidate
              });
              send({
                type: "signal",
                target: message.viewerId,
                data: candidateEvent.candidate.toJSON(),
                attempt: message.attempt,
                sessionId: message.sessionId
              });
            });
            pc.addEventListener("connectionstatechange", () =>
              log("connection-state", { state: pc.connectionState })
            );
            pc.addEventListener("iceconnectionstatechange", () =>
              log("ice-state", { state: pc.iceConnectionState })
            );
            for (const track of stream.getTracks()) {
              const sender = pc.addTrack(track, stream);
              const parameters = sender.getParameters();
              parameters.encodings = parameters.encodings?.length
                ? parameters.encodings
                : [{}];
              parameters.encodings[0].maxBitrate =
                track.kind === "video" ? 1_500_000 : 160_000;
              await sender.setParameters(parameters).catch(() => undefined);
            }
            const codecs = RTCRtpSender.getCapabilities("video").codecs;
            const ranked = [...codecs].sort((left, right) => {
              const order = ["video/H264", "video/VP9", "video/VP8"];
              const leftRank = order.indexOf(left.mimeType);
              const rightRank = order.indexOf(right.mimeType);
              return (leftRank < 0 ? 99 : leftRank) -
                (rightRank < 0 ? 99 : rightRank);
            });
            pc.getTransceivers()
              .find((item) => item.sender.track?.kind === "video")
              ?.setCodecPreferences(ranked);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            send({
              type: "signal",
              target: message.viewerId,
              data: pc.localDescription,
              attempt: message.attempt,
              sessionId: message.sessionId
            });
            return;
          }
          if (message.type === "signal" && message.from && message.data) {
            const peer = peers.get(message.from);
            if (!peer) return;
            const { pc } = peer;
            if (message.data.type) {
              await pc.setRemoteDescription(message.data);
              for (const candidate of peer.candidates.splice(0)) {
                await pc.addIceCandidate(candidate).catch((error) =>
                  log("candidate-error", { message: error.message })
                );
              }
            } else {
              if (pc.remoteDescription) {
                await pc.addIceCandidate(message.data).catch((error) =>
                  log("candidate-error", { message: error.message })
                );
              } else {
                peer.candidates.push(message.data);
              }
            }
            return;
          }
          if (message.type === "media:ready") {
            const pc = peers.get(message.viewerId)?.pc;
            const stats = pc ? await pc.getStats() : new Map();
            const selected = [];
            stats.forEach((item) => {
              if (
                item.type === "candidate-pair" &&
                (item.selected || item.nominated) &&
                item.state === "succeeded"
              ) {
                const local = stats.get(item.localCandidateId);
                const remote = stats.get(item.remoteCandidateId);
                selected.push({
                  localType: local?.candidateType,
                  localProtocol: local?.protocol,
                  remoteType: remote?.candidateType,
                  remoteProtocol: remote?.protocol,
                  bytesSent: item.bytesSent
                });
              }
            });
            clearTimeout(timeout);
            resolve({
              ok: true,
              events,
              selected,
              captureSettings: videoTrack.getSettings()
            });
          }
          if (message.type === "error") {
            log("server-error", { message: message.message });
          }
        });
        socket.addEventListener("error", () =>
          reject(new Error("signal websocket failed"))
        );
      });
      const result = await completion;
      await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
      socket.close();
      peers.forEach(({ pc }) => pc.close());
      voicePeers.forEach(({ pc }) => pc.close());
      stream.getTracks().forEach((track) => track.stop());
      if (syntheticTimer) clearInterval(syntheticTimer);
      oscillator.stop();
      if (voiceOscillator) voiceOscillator.stop();
      await audioContext.close();
      return result;
    })()`);
    process.stdout.write(`PHONE_E2E_RESULT ${JSON.stringify(result)}\n`);
  } finally {
    controller.destroy();
    sourceWindow.destroy();
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(
      `PHONE_E2E_FAILED ${error instanceof Error ? error.stack : error}\n`,
    );
    app.exit(1);
  });
