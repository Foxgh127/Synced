const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const signalUrl =
  process.env.YIQIKAN_TURN_SIGNAL || "wss://synced.com.cn/signal";
const directMode = process.env.YIQIKAN_TURN_DIRECT === "1";
const requestedTransport =
  directMode
    ? "direct"
    : process.env.YIQIKAN_TURN_TRANSPORT === "tcp"
      ? "tcp"
      : "udp";
const timeoutMs = Math.max(
  2_000,
  Number(process.env.YIQIKAN_TURN_TIMEOUT_MS) || 20_000,
);
const benchmarkBytes = Math.min(
  256 * 1024 * 1024,
  Math.max(
    0,
    Math.trunc(Number(process.env.YIQIKAN_TURN_BENCH_BYTES) || 0),
  ),
);

async function main() {
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Use the same file:// origin as the packaged desktop app. The production
  // server deliberately rejects opaque data: origins.
  await window.loadFile(
    path.join(__dirname, "../dist-renderer/index.html"),
  );

  try {
    const result = await window.webContents.executeJavaScript(`(async () => {
      const signalUrl = ${JSON.stringify(signalUrl)};
      const requestedTransport = ${JSON.stringify(requestedTransport)};
      const timeoutMs = ${JSON.stringify(timeoutMs)};
      const benchmarkBytes = ${JSON.stringify(benchmarkBytes)};
      const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
      const ownerBytes = crypto.getRandomValues(new Uint8Array(32));
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", ownerBytes)
      );
      const roomIndexes = [
        digest[0] >>> 3,
        ((digest[0] & 0x07) << 2) | (digest[1] >>> 6),
        (digest[1] >>> 1) & 0x1f,
        ((digest[1] & 0x01) << 4) | (digest[2] >>> 4),
        ((digest[2] & 0x0f) << 1) | (digest[3] >>> 7),
        (digest[3] >>> 2) & 0x1f,
        ((digest[3] & 0x03) << 3) | (digest[4] >>> 5),
        digest[4] & 0x1f,
      ];
      const room = roomIndexes.map((value) => alphabet[value]).join("");
      let ownerBinary = "";
      for (const byte of ownerBytes) ownerBinary += String.fromCharCode(byte);
      const ownerToken = btoa(ownerBinary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
      const socket = new WebSocket(signalUrl);
      const iceServers = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("信令服务器没有返回 TURN 配置")), 10000);
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({
            type: "channel:join",
            room,
            nickname: "TURN自检",
            channelName: "TURN自检",
            canBroadcast: true,
            createIfMissing: true,
            ownerToken
          }));
        });
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "channel:joined") {
            clearTimeout(timeout);
            resolve(message.iceServers || []);
          } else if (message.type === "error") {
            clearTimeout(timeout);
            reject(new Error(message.message || "信令服务器拒绝了自检"));
          }
        });
        socket.addEventListener("error", () => reject(new Error("无法连接信令服务器")));
      });
      if (!${JSON.stringify(directMode)} && !iceServers.some((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => String(url).startsWith("turn:"));
      })) {
        throw new Error("信令服务器没有下发 TURN 地址");
      }
      const transportIceServers = ${JSON.stringify(directMode)} ? [] : iceServers
        .map((server) => {
          const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
            .filter((url) =>
              String(url).startsWith("turn:") &&
              String(url).includes("transport=" + requestedTransport)
            );
          return urls.length ? { ...server, urls } : undefined;
        })
        .filter(Boolean);

      const configuration = {
        iceServers: transportIceServers,
        iceTransportPolicy: ${JSON.stringify(directMode)} ? "all" : "relay",
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
      };
      const left = new RTCPeerConnection(configuration);
      const right = new RTCPeerConnection(configuration);
      const diagnostics = {
        leftCandidates: [],
        rightCandidates: [],
        leftErrors: [],
        rightErrors: []
      };
      left.addEventListener("icecandidate", (event) => {
        if (event.candidate) {
          diagnostics.leftCandidates.push(event.candidate.toJSON());
          void right.addIceCandidate(event.candidate);
        }
      });
      right.addEventListener("icecandidate", (event) => {
        if (event.candidate) {
          diagnostics.rightCandidates.push(event.candidate.toJSON());
          void left.addIceCandidate(event.candidate);
        }
      });
      left.addEventListener("icecandidateerror", (event) => {
        diagnostics.leftErrors.push({
          code: event.errorCode,
          text: event.errorText,
          url: event.url
        });
      });
      right.addEventListener("icecandidateerror", (event) => {
        diagnostics.rightErrors.push({
          code: event.errorCode,
          text: event.errorText,
          url: event.url
        });
      });

      try {
      const channel = left.createDataChannel("turn-smoke");
      channel.binaryType = "arraybuffer";
      let benchmarkReceivedBytes = 0;
      let benchmarkAcknowledged = false;
      const pong = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("TURN 数据中继超时")), timeoutMs);
        channel.addEventListener("message", (event) => {
          if (event.data === "pong") {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      const benchmarkDone = benchmarkBytes > 0
        ? new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error(
                "TURN 吞吐测试超时 " + JSON.stringify({
                  benchmarkBytes,
                  benchmarkReceivedBytes,
                  bufferedAmount: channel.bufferedAmount,
                  channelState: channel.readyState,
                  leftState: left.connectionState,
                  rightState: right.connectionState
                })
              )),
              Math.max(timeoutMs, 60_000)
            );
            channel.addEventListener("message", (event) => {
              if (
                typeof event.data === "string" &&
                event.data.startsWith("benchmark-done:")
              ) {
                clearTimeout(timeout);
                resolve(Number(event.data.slice("benchmark-done:".length)));
              }
            });
          })
        : Promise.resolve(0);
      right.addEventListener("datachannel", (event) => {
        event.channel.binaryType = "arraybuffer";
        event.channel.addEventListener("message", (message) => {
          if (message.data === "ping") {
            event.channel.send("pong");
          } else if (message.data instanceof ArrayBuffer) {
            benchmarkReceivedBytes += message.data.byteLength;
            if (
              benchmarkBytes > 0 &&
              benchmarkReceivedBytes >= benchmarkBytes &&
              !benchmarkAcknowledged
            ) {
              benchmarkAcknowledged = true;
              event.channel.send(
                "benchmark-done:" + String(benchmarkReceivedBytes)
              );
            }
          }
        });
      });

      await left.setLocalDescription(await left.createOffer());
      await right.setRemoteDescription(left.localDescription);
      await right.setLocalDescription(await right.createAnswer());
      await left.setRemoteDescription(right.localDescription);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(
          "TURN ICE 连接超时 " + JSON.stringify({
            requestedTransport,
            leftState: left.connectionState,
            leftIceState: left.iceConnectionState,
            rightState: right.connectionState,
            rightIceState: right.iceConnectionState,
            ...diagnostics
          })
        )), timeoutMs);
        channel.addEventListener("open", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      channel.send("ping");
      await pong;

      let benchmark;
      if (benchmarkBytes > 0) {
        const chunk = new Uint8Array(16 * 1024);
        crypto.getRandomValues(chunk);
        channel.bufferedAmountLowThreshold = 1024 * 1024;
        const startedAt = performance.now();
        const sendDeadline =
          startedAt + Math.max(timeoutMs, 60_000);
        let sentBytes = 0;
        while (sentBytes < benchmarkBytes) {
          if (channel.bufferedAmount > 4 * 1024 * 1024) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (performance.now() > sendDeadline) {
              throw new Error(
                "TURN 发送缓冲区未能排空 " + JSON.stringify({
                  bufferedAmount: channel.bufferedAmount,
                  channelState: channel.readyState,
                  leftState: left.connectionState,
                  rightState: right.connectionState
                })
              );
            }
            continue;
          }
          const remaining = benchmarkBytes - sentBytes;
          const payload =
            remaining >= chunk.byteLength
              ? chunk
              : chunk.subarray(0, remaining);
          channel.send(payload);
          sentBytes += payload.byteLength;
        }
        const receivedBytes = await benchmarkDone;
        const elapsedMs = performance.now() - startedAt;
        benchmark = {
          sentBytes,
          receivedBytes,
          elapsedMs: Math.round(elapsedMs),
          megabitsPerSecond: Number(
            ((receivedBytes * 8) / Math.max(elapsedMs, 1) / 1000).toFixed(2)
          )
        };
      }

      const inspect = async (pc) => {
        const stats = await pc.getStats();
        const selected = [];
        stats.forEach((item) => {
          if (
            item.type === "candidate-pair" &&
            item.state === "succeeded" &&
            (item.selected || item.nominated)
          ) {
            const local = stats.get(item.localCandidateId);
            const remote = stats.get(item.remoteCandidateId);
            selected.push({
              localType: local?.candidateType,
              localProtocol: local?.protocol,
              localRelayProtocol: local?.relayProtocol,
              localPort: local?.port,
              remoteType: remote?.candidateType,
              remoteProtocol: remote?.protocol,
              remotePort: remote?.port,
              bytesSent: item.bytesSent,
              bytesReceived: item.bytesReceived
            });
          }
        });
        return selected;
      };
      const pairs = {
        left: await inspect(left),
        right: await inspect(right)
      };
      return {
        ok: true,
        room,
        requestedTransport,
        // The short-lived TURN username and HMAC credential are deliberately
        // kept out of terminal/CI output. Relay URLs and selected-pair stats
        // are sufficient to diagnose transport reachability.
        iceServers: transportIceServers.map((server) => ({
          urls: server.urls
        })),
        benchmark,
        pairs
      };
      } finally {
        left.close();
        right.close();
        socket.close();
      }
    })()`, true);
    process.stdout.write(`TURN_SMOKE_RESULT ${JSON.stringify(result)}\n`);
  } finally {
    window.destroy();
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(
      `TURN_SMOKE_FAILED ${error instanceof Error ? error.stack : error}\n`,
    );
    app.exit(1);
  });
