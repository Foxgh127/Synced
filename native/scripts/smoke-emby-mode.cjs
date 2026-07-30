const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const {
  createReadStream,
  mkdtempSync,
  rmSync,
  statSync,
} = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");
const { EmbyService } = require("../electron/emby-service.cjs");

const root = path.resolve(__dirname, "..");
const ffmpeg = path.join(root, "vendor", "ffmpeg", "ffmpeg.exe");

const browserBundle = buildSync({
  stdin: {
    contents: `
      import {
        EmbyPeerSender,
      } from "./src/emby-transport.ts";
      import { EmbyMsePlayer } from "./src/emby-player.ts";

      const bytes = (base64) => {
        const binary = atob(base64);
        const output = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          output[index] = binary.charCodeAt(index);
        }
        return output;
      };

      const waitForIce = (pc) => {
        if (pc.iceGatheringState === "complete") return Promise.resolve();
        return new Promise((resolve) => {
          const timeout = setTimeout(resolve, 5_000);
          const changed = () => {
            if (pc.iceGatheringState !== "complete") return;
            clearTimeout(timeout);
            pc.removeEventListener("icegatheringstatechange", changed);
            resolve();
          };
          pc.addEventListener("icegatheringstatechange", changed);
        });
      };

      window.createEmbySmoke = (role) => {
        const video = document.querySelector("video");
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        const state = {
          role,
          errors: [],
          connected: false,
          session: false,
          ready: false,
          decodedFrame: false,
          mediaReadyAcks: 0,
          fragments: 0,
          initRequests: 0,
          retransmits: 0,
          bufferAhead: 0,
          plan: undefined,
          mimeType: "",
          init: undefined,
          cache: new Map(),
          sender: undefined,
          player: undefined,
          pc: undefined,
          channel: undefined,
          playbackTimer: undefined,
        };
        const roomId = "emby-smoke";
        const sessionId = "smoke-session";
        const mediaVersion = 1;

        const playbackState = () => {
          state.sender?.sendControl({
            type: "playback-state",
            sessionId,
            mediaVersion,
            stateVersion: Date.now(),
            currentTime: 0,
            paused: false,
            playbackRate: 1,
            serverTimeMs: Date.now(),
          });
        };

        const sendSession = () => {
          if (!state.sender || !state.plan || !state.mimeType || !state.init) {
            return;
          }
          state.sender.sendControl({
            type: "session",
            roomId,
            sessionId,
            mediaVersion,
            mimeType: state.mimeType,
            plan: state.plan,
            title: "Emby smoke fixture",
          });
          state.sender.sendFragment(state.init, { priority: true });
          playbackState();
        };

        const handleHostControl = (message) => {
          if (message.type === "sync-ping") {
            state.sender?.sendControl({
              type: "sync-pong",
              clientTimeMs: message.clientTimeMs,
              hostTimeMs: Date.now(),
            });
            return;
          }
          if (
            "sessionId" in message &&
            message.sessionId !== sessionId
          ) {
            return;
          }
          if (message.type === "init-request") {
            state.initRequests += 1;
            if (state.init) {
              state.sender?.sendFragment(state.init, { priority: true });
            }
            return;
          }
          if (message.type === "need") {
            const fragment = state.cache.get(message.fragmentSeq);
            if (fragment) {
              state.retransmits += 1;
              state.sender?.sendFragment(fragment, {
                priority: true,
                onlyChunks: message.missing,
              });
            }
            return;
          }
          if (message.type === "media-ready") {
            state.mediaReadyAcks += 1;
          }
        };

        const attachViewerChannel = (channel) => {
          state.channel = channel;
          channel.addEventListener("open", () => {
            state.connected = true;
          });
          const player = new EmbyMsePlayer({
            video,
            host: false,
            initialBufferSeconds: 2,
            targetBufferSeconds: 8,
            maxBufferSeconds: 16,
          });
          state.player = player;
          player.addEventListener("session", () => {
            state.session = true;
          });
          player.addEventListener("buffer", (event) => {
            state.bufferAhead = event.detail.aheadSeconds;
          });
          player.addEventListener("error", (event) => {
            state.errors.push(String(event.detail || "player error"));
          });
          player.addEventListener("ready", () => {
            state.ready = true;
            void video.play().then(() => {
              if (typeof video.requestVideoFrameCallback === "function") {
                video.requestVideoFrameCallback(() => {
                  state.decodedFrame = true;
                });
              } else {
                state.decodedFrame = video.readyState >= 2;
              }
            }).catch((error) => state.errors.push(String(error)));
          });
          player.attachChannel(channel);
        };

        window.embySmoke = {
          async createHostOffer() {
            const pc = new RTCPeerConnection({ iceServers: [] });
            state.pc = pc;
            pc.addEventListener("connectionstatechange", () => {
              state.connected = pc.connectionState === "connected";
            });
            const channel = pc.createDataChannel("synced-emby-v1", {
              ordered: false,
            });
            state.channel = channel;
            state.sender = new EmbyPeerSender(
              channel,
              handleHostControl,
            );
            channel.addEventListener("open", () => {
              state.connected = true;
              sendSession();
            });
            await pc.setLocalDescription(await pc.createOffer());
            await waitForIce(pc);
            return JSON.parse(JSON.stringify(pc.localDescription));
          },

          async createViewerAnswer(offer) {
            const pc = new RTCPeerConnection({ iceServers: [] });
            state.pc = pc;
            pc.addEventListener("connectionstatechange", () => {
              state.connected = pc.connectionState === "connected";
            });
            pc.addEventListener("datachannel", (event) => {
              if (event.channel.label !== "synced-emby-v1") {
                event.channel.close();
                return;
              }
              attachViewerChannel(event.channel);
            });
            await pc.setRemoteDescription(offer);
            await pc.setLocalDescription(await pc.createAnswer());
            await waitForIce(pc);
            return JSON.parse(JSON.stringify(pc.localDescription));
          },

          async acceptHostAnswer(answer) {
            await state.pc.setRemoteDescription(answer);
          },

          acceptStreamEvent(event) {
            if (event.type === "init") {
              state.plan = event.plan;
              state.mimeType = event.mimeType;
              state.init = {
                roomId,
                sessionId,
                mediaVersion,
                sequence: 0,
                timestampMs: Date.now(),
                mediaTimeMs: Number(event.plan.startTimeTicks || 0) / 10_000,
                trackType: "muxed",
                keyframe: true,
                data: bytes(event.data),
              };
              sendSession();
              if (!state.playbackTimer) {
                state.playbackTimer = setInterval(playbackState, 1_000);
              }
              return;
            }
            if (event.type === "fragment") {
              const fragment = {
                roomId,
                sessionId,
                mediaVersion,
                sequence: event.sequence,
                timestampMs: event.timestampMs,
                mediaTimeMs: event.mediaTimeMs,
                trackType: "muxed",
                keyframe: event.keyframe,
                data: bytes(event.data),
              };
              state.cache.set(event.sequence, fragment);
              state.fragments += 1;
              state.sender?.sendFragment(fragment);
              return;
            }
            if (event.type === "ended") {
              state.sender?.sendControl({
                type: "stream-ended",
                sessionId,
                mediaVersion,
              });
            }
            if (event.type === "error") {
              state.errors.push(event.message || "stream error");
            }
          },

          snapshot() {
            const ranges = [];
            for (let index = 0; index < video.buffered.length; index += 1) {
              ranges.push([
                video.buffered.start(index),
                video.buffered.end(index),
              ]);
            }
            return {
              role: state.role,
              connected: state.connected,
              session: state.session,
              ready: state.ready,
              decodedFrame: state.decodedFrame,
              mediaReadyAcks: state.mediaReadyAcks,
              fragments: state.fragments,
              initRequests: state.initRequests,
              retransmits: state.retransmits,
              bufferAhead: state.bufferAhead,
              sender: state.sender?.stats,
              video: {
                currentTime: video.currentTime,
                readyState: video.readyState,
                width: video.videoWidth,
                height: video.videoHeight,
                paused: video.paused,
                ranges,
                error: video.error?.message || "",
              },
              errors: [...state.errors],
            };
          },

          close() {
            if (state.playbackTimer) clearInterval(state.playbackTimer);
            state.player?.destroy();
            state.sender?.close();
            state.pc?.close();
          },
        };
      };
    `,
    resolveDir: root,
    sourcefile: "emby-smoke-browser.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  write: false,
}).outputFiles[0].text;

function makeFixture(target) {
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "14",
      "-c:v",
      "libopenh264",
      "-b:v",
      "4M",
      "-maxrate",
      "4M",
      "-bufsize",
      "8M",
      "-g",
      "48",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      target,
      "-y",
    ],
    { windowsHide: true },
  );
}

async function createMockEmby(source) {
  const token = "smoke-host-only-token";
  const audit = {
    mediaTokens: [],
    playback: [],
    logout: 0,
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const json = (value) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/Users/AuthenticateByName") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const credentials = JSON.parse(body);
        if (
          credentials.Username !== "Readonly" ||
          credentials.Pw !== "temporary"
        ) {
          response.writeHead(401).end();
          return;
        }
        json({
          AccessToken: token,
          User: { Id: "user-1", Name: "Readonly" },
        });
      });
      return;
    }
    if (url.pathname === "/System/Info") {
      json({ ServerName: "Smoke Emby", Version: "4.8.0" });
      return;
    }
    if (url.pathname === "/Items/movie-1/PlaybackInfo") {
      json({
        PlaySessionId: "smoke-play-session",
        MediaSources: [
          {
            Id: "source-1",
            Name: "H264 AAC MP4",
            Container: "mp4",
            Bitrate: 4_200_000,
            RunTimeTicks: 140_000_000,
            SupportsDirectPlay: true,
            SupportsDirectStream: true,
            MediaStreams: [
              {
                Index: 0,
                Type: "Video",
                Codec: "h264",
                Width: 1280,
                Height: 720,
                BitRate: 4_000_000,
              },
              {
                Index: 1,
                Type: "Audio",
                Codec: "aac",
                Channels: 2,
                BitRate: 192_000,
                IsDefault: true,
              },
            ],
          },
        ],
      });
      return;
    }
    if (url.pathname === "/Videos/movie-1/stream") {
      audit.mediaTokens.push(request.headers["x-emby-token"] || "");
      const size = statSync(source).size;
      const match = /^bytes=(\d+)-(\d*)$/i.exec(
        String(request.headers.range || ""),
      );
      const start = match ? Number(match[1]) : 0;
      const end =
        match && match[2]
          ? Math.min(size - 1, Number(match[2]))
          : size - 1;
      response.writeHead(match ? 206 : 200, {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        ...(match
          ? { "content-range": `bytes ${start}-${end}/${size}` }
          : {}),
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(source, { start, end }).pipe(response);
      return;
    }
    if (
      [
        "/Sessions/Playing",
        "/Sessions/Playing/Progress",
        "/Sessions/Playing/Stopped",
      ].includes(url.pathname)
    ) {
      audit.playback.push(url.pathname);
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/Sessions/Logout") {
      audit.logout += 1;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    token,
    audit,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

async function createWindow(role) {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(path.join(__dirname, "smoke-window-capture.html"));
  await window.webContents.executeJavaScript(browserBundle);
  await window.webContents.executeJavaScript(
    `window.createEmbySmoke(${JSON.stringify(role)})`,
  );
  return window;
}

async function waitForPlayback(host, viewer, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let hostSnapshot;
  let viewerSnapshot;
  while (Date.now() < deadline) {
    hostSnapshot = await host.webContents.executeJavaScript(
      "window.embySmoke.snapshot()",
    );
    viewerSnapshot = await viewer.webContents.executeJavaScript(
      "window.embySmoke.snapshot()",
    );
    if (
      hostSnapshot.mediaReadyAcks > 0 &&
      viewerSnapshot.ready &&
      viewerSnapshot.decodedFrame &&
      viewerSnapshot.video.currentTime > 0.25
    ) {
      return { hostSnapshot, viewerSnapshot };
    }
    if (hostSnapshot.errors.length || viewerSnapshot.errors.length) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `Emby viewer did not reach decoded playback: ${JSON.stringify({
      hostSnapshot,
      viewerSnapshot,
    })}`,
  );
}

async function waitForCompleteBuffer(host, viewer, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let hostSnapshot;
  let viewerSnapshot;
  while (Date.now() < deadline) {
    hostSnapshot = await host.webContents.executeJavaScript(
      "window.embySmoke.snapshot()",
    );
    viewerSnapshot = await viewer.webContents.executeJavaScript(
      "window.embySmoke.snapshot()",
    );
    const ranges = viewerSnapshot.video.ranges;
    const bufferedEnd = ranges.length ? ranges[ranges.length - 1][1] : 0;
    if (
      bufferedEnd >= 13.5 &&
      hostSnapshot.sender.queuedBytes === 0 &&
      hostSnapshot.errors.length === 0 &&
      viewerSnapshot.errors.length === 0
    ) {
      return { hostSnapshot, viewerSnapshot };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Emby final fragments did not arrive before end-of-stream: ${JSON.stringify({
      hostSnapshot,
      viewerSnapshot,
    })}`,
  );
}

async function main() {
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  app.commandLine.appendSwitch(
    "disable-features",
    "WebRtcHideLocalIpsWithMdns",
  );
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  await app.whenReady();

  const temporary = mkdtempSync(path.join(os.tmpdir(), "synced-emby-e2e-"));
  const fixture = path.join(temporary, "fixture.mp4");
  makeFixture(fixture);
  const mock = await createMockEmby(fixture);
  let host;
  let viewer;
  let pipelineArgs = "";
  const deliveredEvents = [];
  let eventDelivery = Promise.resolve();
  const service = new EmbyService({
    version: "1.0.0",
    deviceId: "smoke-device-123456",
    ffmpegPath: ffmpeg,
    sendEvent: (event) => {
      if (!host || host.isDestroyed()) return;
      const safe = {
        ...event,
        data: event.data?.toString("base64"),
      };
      deliveredEvents.push({
        type: event.type,
        bytes: event.data?.length || 0,
        mediaTimeMs: event.mediaTimeMs,
        keyframe: event.keyframe,
        message: event.message,
      });
      eventDelivery = eventDelivery.then(() =>
        host.webContents.executeJavaScript(
          `window.embySmoke.acceptStreamEvent(${JSON.stringify(safe)})`,
        ),
      );
    },
  });

  try {
    host = await createWindow("host");
    viewer = await createWindow("viewer");
    const offer = await host.webContents.executeJavaScript(
      "window.embySmoke.createHostOffer()",
    );
    const answer = await viewer.webContents.executeJavaScript(
      `window.embySmoke.createViewerAnswer(${JSON.stringify(offer)})`,
    );
    await host.webContents.executeJavaScript(
      `window.embySmoke.acceptHostAnswer(${JSON.stringify(answer)})`,
    );

    await service.login({
      serverUrl: mock.url,
      username: "Readonly",
      password: "temporary",
      allowInsecure: true,
    });
    const started = await service.startStream({
      itemId: "movie-1",
      quality: "original",
    });
    pipelineArgs = service.pipeline.child.spawnargs.join(" ");
    await waitForPlayback(host, viewer);
    const snapshots = await waitForCompleteBuffer(host, viewer);
    await service.reportPlayback({
      action: "start",
      positionTicks: Math.round(
        snapshots.viewerSnapshot.video.currentTime * 10_000_000,
      ),
      isPaused: false,
      eventName: "TimeUpdate",
    });
    await eventDelivery;

    if (started.plan.method !== "DirectPlay") {
      throw new Error(`unexpected playback method: ${started.plan.method}`);
    }
    if (
      snapshots.viewerSnapshot.video.width !== 1280 ||
      snapshots.viewerSnapshot.video.height !== 720
    ) {
      throw new Error(
        `decoded resolution mismatch: ${JSON.stringify(
          snapshots.viewerSnapshot.video,
        )}`,
      );
    }
    if (
      snapshots.hostSnapshot.sender.queuedBytes > 4 * 1024 * 1024 ||
      snapshots.hostSnapshot.sender.bufferedBytes > 4 * 1024 * 1024
    ) {
      throw new Error("DataChannel backpressure ceiling was exceeded");
    }
    if (
      !mock.audit.mediaTokens.length ||
      mock.audit.mediaTokens.some((value) => value !== mock.token)
    ) {
      throw new Error("Emby media request did not keep the host token scoped");
    }
    if (
      pipelineArgs.includes(mock.token) ||
      JSON.stringify(deliveredEvents).includes(mock.token)
    ) {
      throw new Error("Emby token escaped into FFmpeg arguments or events");
    }
    const mediaTimes = deliveredEvents
      .filter((event) => event.type === "fragment")
      .map((event) => event.mediaTimeMs);
    if (
      !mediaTimes.length ||
      mediaTimes.some((value) => !Number.isFinite(value)) ||
      mediaTimes.some(
        (value, index) => index > 0 && value <= mediaTimes[index - 1],
      )
    ) {
      throw new Error(
        `fMP4 media timeline was not monotonic: ${JSON.stringify(mediaTimes)}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode: "emby-direct-play-fmp4-datachannel-mse",
        plan: started.plan,
        host: snapshots.hostSnapshot,
        viewer: snapshots.viewerSnapshot,
        events: deliveredEvents,
        embyPlaybackReports: mock.audit.playback.length,
      })}\n`,
    );
  } finally {
    await service.destroy().catch(() => undefined);
    await eventDelivery.catch(() => undefined);
    await host?.webContents
      .executeJavaScript("window.embySmoke.close()")
      .catch(() => undefined);
    await viewer?.webContents
      .executeJavaScript("window.embySmoke.close()")
      .catch(() => undefined);
    host?.destroy();
    viewer?.destroy();
    await new Promise((resolve) => mock.server.close(resolve));
    rmSync(temporary, { recursive: true, force: true });
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    app.exit(1);
  });
