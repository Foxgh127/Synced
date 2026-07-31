const {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  session,
} = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "synced-resource",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

const temporaryUserData = fs.mkdtempSync(
  path.join(os.tmpdir(), "synced-voice-smoke-"),
);
app.setPath("userData", temporaryUserData);

function withTimeout(promise, label, timeoutMs = 15_000) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function waitFor(window, expression, label, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await window.webContents.executeJavaScript(expression);
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out`);
}

async function main() {
  let signalServer;
  let signalUrl = process.env.SYNCED_SMOKE_SIGNAL_URL;
  if (!signalUrl) {
    const serverModuleUrl = pathToFileURL(
      path.join(__dirname, "..", "server", "index.mjs"),
    ).href;
    const { createSignalServer } = await import(serverModuleUrl);
    signalServer = createSignalServer({
      maxViewersPerRoom: 3,
    });
    await signalServer.listen(8_787, "127.0.0.1");
    signalUrl = "ws://localhost:8787/signal";
  }

  await app.whenReady();
  protocol.handle("synced-resource", (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname)
      .replace(/^\/+/, "")
      .replaceAll("\\", "/");
    const rendererRoot = path.resolve(__dirname, "..", "dist-renderer");
    return net.fetch(
      pathToFileURL(path.resolve(rendererRoot, relativePath)).href,
    );
  });
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => permission === "media",
  );
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "media");
    },
  );
  ipcMain.handle("app:get-network-info", () => ({
    lanAddresses: [],
  }));
  ipcMain.handle(
    "permission:request-media",
    (_event, kind) => kind === "microphone",
  );
  ipcMain.on("permission:release-media", () => undefined);
  const channelOwnershipByRenderer = new Map();
  ipcMain.on("channel-owner:load", (event) => {
    event.returnValue = channelOwnershipByRenderer.get(event.sender.id);
  });
  ipcMain.on("channel-owner:save", (event, value) => {
    channelOwnershipByRenderer.set(event.sender.id, value);
    event.returnValue = true;
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on("console-message", (...args) => {
    const event = args[0];
    const message =
      typeof event === "object" && event && "message" in event
        ? event.message
        : typeof args[2] === "string"
          ? args[2]
          : "";
    if (message) {
      process.stderr.write(`[renderer] ${message}\n`);
    }
  });
  let viewerWindow;

  try {
    await withTimeout(
      window.loadFile(
        path.join(__dirname, "..", "dist-renderer", "index.html"),
      ),
      "renderer load",
    );
    await window.webContents.executeJavaScript(
      `document.querySelector("#choose-host")?.click()`,
    );
    await waitFor(
      window,
      `Boolean(document.querySelector("#start-share"))`,
      "host setup",
    );
    await window.webContents.executeJavaScript(`
      (() => {
        const input = document.querySelector("#host-signal-url");
        input.value = ${JSON.stringify(signalUrl)};
        document.querySelector("#start-share")?.click();
      })()
    `);
    try {
      await waitFor(
        window,
        `Boolean(document.querySelector("#voice-button") && document.querySelector(".participant-row"))`,
        "channel join",
      );
    } catch (error) {
      const diagnostics = await window.webContents.executeJavaScript(`({
        body: document.body.innerText.slice(0, 1500),
        toasts: [...document.querySelectorAll(".toast")].map((item) => item.textContent),
        status: document.querySelector("#hud-signal-text")?.textContent,
      })`);
      throw new Error(
        `${error instanceof Error ? error.message : error}: ${JSON.stringify(diagnostics)}`,
      );
    }
    await window.webContents.executeJavaScript(
      `document.querySelector("#voice-button")?.click()`,
    );
    let result;
    try {
      result = await waitFor(
        window,
        `(() => {
        const button = document.querySelector("#voice-button");
        const quality = document.querySelector("#voice-quality")?.textContent || "";
        const error = document.querySelector(".toast.error")?.textContent || "";
        if (error) return { error };
        if (!button?.classList.contains("connected")) return undefined;
        return {
          connected: true,
          systemNoiseSuppression:
            quality.includes("清晰人声 · 语音隔离"),
          echoCancellation: quality.includes("回声消除"),
          quality,
          inputDevices: [...document.querySelectorAll("#voice-input-device option")]
            .map((option) => option.textContent),
          outputDevices: [...document.querySelectorAll("#voice-output-device option")]
            .map((option) => option.textContent),
        };
      })()`,
        "clear-voice platform processing join",
        30_000,
      );
    } catch (error) {
      const diagnostics = await window.webContents.executeJavaScript(`({
        voiceButton: document.querySelector("#voice-button")?.textContent,
        voiceButtonDisabled: document.querySelector("#voice-button")?.disabled,
        quality: document.querySelector("#voice-quality")?.textContent,
        toasts: [...document.querySelectorAll(".toast")].map((item) => item.textContent),
      })`);
      throw new Error(
        `${error instanceof Error ? error.message : error}: ${JSON.stringify(diagnostics)}`,
      );
    }

    if (
      result.error ||
      !result.connected ||
      !result.systemNoiseSuppression ||
      !result.echoCancellation
    ) {
      throw new Error(`voice validation failed: ${JSON.stringify(result)}`);
    }

    const displayedRoom = await window.webContents.executeJavaScript(
      `document.querySelector("#copy-room span")?.textContent?.trim()`,
    );
    const room = String(displayedRoom || "")
      .toUpperCase()
      .replace(/[^23456789A-HJ-NP-Z]/gu, "");
    if (!/^[23456789A-HJ-NP-Z]{8}$/.test(room)) {
      throw new Error(`host room code was not available: ${displayedRoom}`);
    }
    const viewerPartition = `voice-viewer-${Date.now()}`;
    const viewerSession = session.fromPartition(viewerPartition);
    viewerSession.setPermissionCheckHandler(
      (_webContents, permission) => permission === "media",
    );
    viewerSession.setPermissionRequestHandler(
      (_webContents, permission, callback) => {
        callback(permission === "media");
      },
    );
    viewerWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "..", "electron", "preload.cjs"),
        partition: viewerPartition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    viewerWindow.webContents.on("console-message", (...args) => {
      const event = args[0];
      const message =
        typeof event === "object" && event && "message" in event
          ? event.message
          : typeof args[2] === "string"
            ? args[2]
            : "";
      if (message) {
        process.stderr.write(`[viewer-renderer] ${message}\n`);
      }
    });
    await withTimeout(
      viewerWindow.loadFile(
        path.join(__dirname, "..", "dist-renderer", "index.html"),
      ),
      "viewer renderer load",
    );
    await viewerWindow.webContents.executeJavaScript(
      `document.querySelector("#choose-viewer")?.click()`,
    );
    await waitFor(
      viewerWindow,
      `Boolean(document.querySelector("#join-room"))`,
      "viewer setup",
    );
    await viewerWindow.webContents.executeJavaScript(`(() => {
      const roomInput = document.querySelector("#room-input");
      roomInput.value = ${JSON.stringify(room)};
      roomInput.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#viewer-signal-url").value = ${JSON.stringify(signalUrl)};
      document.querySelector("#join-room")?.click();
    })()`);
    try {
      await waitFor(
        viewerWindow,
        `Boolean(
          document.querySelector("#broadcast-action") &&
          !document.querySelector("#broadcast-action").disabled &&
          document.querySelector("#voice-button")
        )`,
        "viewer channel join",
      );
    } catch (error) {
      const diagnostics =
        await viewerWindow.webContents.executeJavaScript(`({
          body: document.body?.innerText?.slice(0, 2_000) || "",
          broadcastDisabled:
            document.querySelector("#broadcast-action")?.disabled,
          signal: document.querySelector("#hud-signal-text")?.textContent,
          toasts: [...document.querySelectorAll(".toast")].map(
            (item) => item.textContent
          ),
        })`);
      throw new Error(
        `${error instanceof Error ? error.message : error}: ${JSON.stringify(diagnostics)}`,
      );
    }
    await viewerWindow.webContents.executeJavaScript(
      `document.querySelector("#voice-button")?.click()`,
    );

    const mediaExpression = `(async () => {
      const audio = document.querySelector("audio[data-voice-peer]");
      const peer = [...(window.__syncedRtcPeers || [])]
        .reverse()
        .find((entry) => entry.pc.connectionState === "connected");
      if (!audio || !peer || audio.paused) return undefined;
      const report = await peer.pc.getStats();
      let bytesReceived = 0;
      let packetsReceived = 0;
      let totalAudioEnergy = 0;
      let totalSamplesDuration = 0;
      report.forEach((item) => {
        const kind = item.kind || item.mediaType;
        if (item.type === "inbound-rtp" && kind === "audio" && !item.isRemote) {
          bytesReceived += Number(item.bytesReceived || 0);
          packetsReceived += Number(item.packetsReceived || 0);
          totalAudioEnergy += Number(item.totalAudioEnergy || 0);
          totalSamplesDuration += Number(item.totalSamplesDuration || 0);
        }
      });
      const track = audio.srcObject?.getAudioTracks?.()[0];
      const receiverTrack = peer.pc.getReceivers()
        .find((receiver) => receiver.track?.kind === "audio")?.track;
      const directPlayback = Boolean(
        track && receiverTrack && track.id === receiverTrack.id
      );
      return bytesReceived > 0 &&
        packetsReceived > 0 &&
        totalAudioEnergy > 0 &&
        totalSamplesDuration > 0 &&
        track?.readyState === "live" &&
        directPlayback
        ? {
            bytesReceived,
            packetsReceived,
            totalAudioEnergy,
            totalSamplesDuration,
            audioPaused: audio.paused,
            audioTrackState: track.readyState,
            directPlayback,
            connected: peer.pc.connectionState,
          }
        : undefined;
    })()`;
    const hostMedia = await waitFor(
      window,
      mediaExpression,
      "host inbound voice media",
      30_000,
    );
    const viewerMedia = await waitFor(
      viewerWindow,
      mediaExpression,
      "viewer inbound voice media",
      30_000,
    );
    result.twoPartyMedia = {
      host: hostMedia,
      viewer: viewerMedia,
    };

    // Master and per-person sliders can exceed the HTMLMediaElement 100%
    // ceiling. Verify that both boosted Web Audio paths continue receiving
    // real RTP media instead of replacing the remote stream with a silent
    // MediaStreamDestination.
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector("#voice-volume");
      input.value = "150";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await viewerWindow.webContents.executeJavaScript(`(() => {
      document.querySelector("[data-participant-toggle]")?.click();
      return true;
    })()`);
    await waitFor(
      viewerWindow,
      `Boolean(document.querySelector("[data-peer-volume]"))`,
      "viewer per-person volume control",
      10_000,
    );
    await viewerWindow.webContents.executeJavaScript(`(() => {
      const input = document.querySelector("[data-peer-volume]");
      input.value = "140";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await waitFor(
      window,
      `document.querySelector("audio[data-voice-peer]")?.muted === true`,
      "host boosted master volume graph",
      10_000,
    );
    await waitFor(
      viewerWindow,
      `document.querySelector("audio[data-voice-peer]")?.muted === true`,
      "viewer boosted peer volume graph",
      10_000,
    );
    const hostBoostExpression = mediaExpression
      .replace(
        "bytesReceived > 0",
        `bytesReceived > ${Number(hostMedia.bytesReceived)}`,
      )
      .replace(
        "totalAudioEnergy > 0",
        `totalAudioEnergy > ${Number(hostMedia.totalAudioEnergy)}`,
      );
    const viewerBoostExpression = mediaExpression
      .replace(
        "bytesReceived > 0",
        `bytesReceived > ${Number(viewerMedia.bytesReceived)}`,
      )
      .replace(
        "totalAudioEnergy > 0",
        `totalAudioEnergy > ${Number(viewerMedia.totalAudioEnergy)}`,
      );
    result.boostedVolumeMedia = {
      host: await waitFor(
        window,
        hostBoostExpression,
        "host media after master volume boost",
        15_000,
      ),
      viewer: await waitFor(
        viewerWindow,
        viewerBoostExpression,
        "viewer media after peer volume boost",
        15_000,
      ),
    };

    // Reproduce the old main-thread denoiser failure mode: renderer work used
    // to starve ScriptProcessor callbacks, insert zero-filled gaps, and sound
    // like electrical crackle. The recommended platform voice-isolation mode
    // must keep emitting real RTP audio while the renderer is blocked.
    await window.webContents.executeJavaScript(`(() => {
      const deadline = performance.now() + 900;
      while (performance.now() < deadline) {
        Math.sqrt(144);
      }
      return true;
    })()`);
    const mainThreadStallExpression = mediaExpression
      .replace(
        "bytesReceived > 0",
        `bytesReceived > ${Number(viewerMedia.bytesReceived)}`,
      )
      .replace(
        "totalAudioEnergy > 0",
        `totalAudioEnergy > ${Number(viewerMedia.totalAudioEnergy)}`,
      );
    const mainThreadStall = await waitFor(
      viewerWindow,
      mainThreadStallExpression,
      "system audio-thread media through renderer stall",
      10_000,
    );

    await window.webContents.executeJavaScript(`(() => {
      const select = document.querySelector("#voice-noise-mode");
      select.value = "strong";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    const deepFilter = await waitFor(
      window,
      `(() => {
        const quality = document.querySelector("#voice-quality")?.textContent || "";
        const error = document.querySelector(".toast.error")?.textContent || "";
        if (error) return { error };
        return quality.includes("强力消噪 · DeepFilterNet3 深度滤波")
          ? { ready: true, quality }
          : undefined;
      })()`,
      "DeepFilterNet3 strong mode",
      90_000,
    );
    if (deepFilter.error || !deepFilter.ready) {
      throw new Error(
        `DeepFilterNet3 validation failed: ${JSON.stringify(deepFilter)}`,
      );
    }
    const viewerAfterDeviceSwapExpression = mediaExpression
      .replace(
        "bytesReceived > 0",
        `bytesReceived > ${Number(mainThreadStall.bytesReceived)}`,
      )
      .replace(
        "totalAudioEnergy > 0",
        `totalSamplesDuration > ${Number(mainThreadStall.totalSamplesDuration)}`,
      );
    let viewerAfterDeviceSwap;
    try {
      viewerAfterDeviceSwap = await waitFor(
        viewerWindow,
        viewerAfterDeviceSwapExpression,
        "voice media after live microphone processing swap",
        30_000,
      );
    } catch (error) {
      const diagnostics = {
        host: await window.webContents.executeJavaScript(`(async () => {
          const peer = [...(window.__syncedRtcPeers || [])]
            .reverse()
            .find((entry) => entry.pc.connectionState === "connected");
          const rows = [];
          if (peer) {
            const report = await peer.pc.getStats();
            report.forEach((item) => {
              if (item.type === "outbound-rtp" && (item.kind || item.mediaType) === "audio") {
                rows.push({
                  bytesSent: item.bytesSent,
                  packetsSent: item.packetsSent,
                  totalPacketSendDelay: item.totalPacketSendDelay,
                  audioLevel: item.audioLevel,
                });
              }
            });
          }
          return {
            rows,
            quality: document.querySelector("#voice-quality")?.textContent,
            toasts: [...document.querySelectorAll(".toast")].map((item) => item.textContent),
          };
        })()`),
        viewer: await viewerWindow.webContents.executeJavaScript(`(async () => {
          const peer = [...(window.__syncedRtcPeers || [])]
            .reverse()
            .find((entry) => entry.pc.connectionState === "connected");
          const rows = [];
          if (peer) {
            const report = await peer.pc.getStats();
            report.forEach((item) => {
              if (item.type === "inbound-rtp" && (item.kind || item.mediaType) === "audio") {
                rows.push({
                  bytesReceived: item.bytesReceived,
                  packetsReceived: item.packetsReceived,
                  totalAudioEnergy: item.totalAudioEnergy,
                  totalSamplesDuration: item.totalSamplesDuration,
                });
              }
            });
          }
          const audio = document.querySelector("audio[data-voice-peer]");
          return {
            rows,
            audioMuted: audio?.muted,
            audioPaused: audio?.paused,
            trackMuted: audio?.srcObject?.getAudioTracks?.()[0]?.muted,
            trackState: audio?.srcObject?.getAudioTracks?.()[0]?.readyState,
            toasts: [...document.querySelectorAll(".toast")].map((item) => item.textContent),
          };
        })()`),
      };
      throw new Error(
        `${error instanceof Error ? error.message : error}: ${JSON.stringify(diagnostics)}`,
      );
    }
    // Stay connected past the production media-stall threshold and several
    // four-second health/sync cycles. The original regression appeared only
    // after a successful join, so an immediate packet check was insufficient.
    await new Promise((resolve) => setTimeout(resolve, 13_000));
    const strongModeSoakExpression = mediaExpression
      .replace(
        "bytesReceived > 0",
        `bytesReceived > ${Number(viewerAfterDeviceSwap.bytesReceived)}`,
      )
      .replace(
        "totalAudioEnergy > 0",
        `totalSamplesDuration > ${Number(viewerAfterDeviceSwap.totalSamplesDuration)}`,
      );
    const strongModeSoak = await waitFor(
      viewerWindow,
      strongModeSoakExpression,
      "voice energy after strong-mode health-cycle soak",
      15_000,
    );
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        ...result,
        mainThreadStall,
        deepFilter,
        viewerAfterDeviceSwap,
        strongModeSoak,
      })}\n`,
    );
  } finally {
    viewerWindow?.destroy();
    window.destroy();
    ipcMain.removeHandler("app:get-network-info");
    await signalServer?.close();
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    app.exit(1);
  });
