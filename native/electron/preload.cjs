const { contextBridge, ipcRenderer } = require("electron");

const embyStreamListeners = new Set();
let embyStreamPort;
const processAudioListeners = new Set();
let processAudioPort;

function deliverEmbyStreamPayload(payload) {
  const normalized = {
    ...payload,
    data:
      payload?.data instanceof Uint8Array
        ? payload.data
        : payload?.data
          ? new Uint8Array(payload.data)
          : undefined,
  };
  for (const listener of embyStreamListeners) {
    try {
      listener(normalized);
    } catch {
      // One renderer consumer must not break delivery to another.
    }
  }
}

ipcRenderer.on("emby:stream-port", (event) => {
  const port = event.ports?.[0];
  if (!port) return;
  try {
    embyStreamPort?.close();
  } catch {
    // Replacing a port after reload is best effort.
  }
  embyStreamPort = port;
  port.onmessage = (message) => deliverEmbyStreamPayload(message.data);
  port.start();
});

ipcRenderer.on("emby:stream-event", (_event, payload) => {
  deliverEmbyStreamPayload(payload);
});

function deliverProcessAudioPacket(packet) {
  const normalized = {
    ...packet,
    pcm:
      packet?.pcm instanceof Uint8Array
        ? packet.pcm
        : new Uint8Array(packet?.pcm || 0),
    sampleRate: Number(packet?.sampleRate),
    capturedAtUnixMs: Number(packet?.capturedAtUnixMs),
    devicePosition: Number(packet?.devicePosition),
    captureId: Number(packet?.captureId),
  };
  for (const listener of processAudioListeners) {
    try {
      listener(normalized);
    } catch {
      // One audio consumer must not break delivery to another.
    }
  }
}

ipcRenderer.on("capture:audio-port", (event) => {
  const port = event.ports?.[0];
  if (!port) return;
  try {
    processAudioPort?.close();
  } catch {
    // Replacing a port after reload is best effort.
  }
  processAudioPort = port;
  port.onmessage = (message) => {
    try {
      deliverProcessAudioPacket(message.data);
    } finally {
      port.postMessage({
        type: "audio-consumed",
        transportPacketId: Number(message.data?.transportPacketId),
      });
    }
  };
  port.start();
});

contextBridge.exposeInMainWorld("roomDesktop", {
  loadChannelOwnership: () =>
    ipcRenderer.sendSync("channel-owner:load"),
  saveChannelOwnership: (value) =>
    ipcRenderer.sendSync("channel-owner:save", value) === true,
  requestMediaPermissionIntent: (kind) =>
    ipcRenderer.invoke("permission:request-media", kind),
  releaseMediaPermission: (kind) =>
    ipcRenderer.send("permission:release-media", kind),
  listSources: (options) =>
    ipcRenderer.invoke("capture:list-sources", options),
  selectSource: (sourceId) => ipcRenderer.invoke("capture:select-source", sourceId),
  getCaptureSourceHealth: () =>
    ipcRenderer.invoke("capture:get-source-health"),
  ensurePortableFirewall: () =>
    ipcRenderer.invoke("network:ensure-portable-firewall"),
  startProcessAudio: () => ipcRenderer.invoke("capture:start-process-audio"),
  getProcessAudioStatus: () =>
    ipcRenderer.invoke("capture:get-process-audio-status"),
  stopProcessAudio: (captureId) =>
    ipcRenderer.invoke("capture:stop-process-audio", captureId),
  onProcessAudioData: (callback) => {
    processAudioListeners.add(callback);
    return () => processAudioListeners.delete(callback);
  },
  onProcessAudioStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("capture:audio-status", listener);
    return () => ipcRenderer.removeListener("capture:audio-status", listener);
  },
  onOpenUrl: (callback) => {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on("app:open-url", listener);
    return () => ipcRenderer.removeListener("app:open-url", listener);
  },
  setCaptureActive: (active) => ipcRenderer.invoke("capture:set-active", Boolean(active)),
  setDesktopDanmakuActive: (active) =>
    ipcRenderer.send("overlay:set-desktop-active", Boolean(active)),
  showDanmaku: (nickname, text, mine) =>
    ipcRenderer.send("overlay:danmaku", { nickname, text, mine: Boolean(mine) }),
  clearDanmaku: () => ipcRenderer.send("overlay:clear"),
  setMiniWindowEnabled: (enabled) =>
    ipcRenderer.send("window:set-mini-window-enabled", Boolean(enabled)),
  restoreFromPictureInPicture: () =>
    ipcRenderer.invoke("window:restore-from-picture-in-picture"),
  onMainWindowRestored: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("window:restored", listener);
    return () => {
      ipcRenderer.removeListener("window:restored", listener);
    };
  },
  gameViewOpen: (bounds) => ipcRenderer.invoke("game:view-open", bounds),
  gameViewSetBounds: (bounds) =>
    ipcRenderer.invoke("game:view-set-bounds", bounds),
  gameViewHide: () => {
    ipcRenderer.send("game:view-hide");
    return Promise.resolve();
  },
  gameViewReload: () => ipcRenderer.invoke("game:view-reload"),
  gameViewBack: () => ipcRenderer.invoke("game:view-back"),
  onGameViewState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("game:view-state", listener);
    return () => ipcRenderer.removeListener("game:view-state", listener);
  },
  reportDiagnostic: (event, detail) =>
    ipcRenderer.send("diagnostic:event", event, detail),
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  getNetworkInfo: () => ipcRenderer.invoke("app:get-network-info"),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard:write", text),
  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  getDisplayInfo: () => ipcRenderer.invoke("system:get-display-info"),
  openDisplaySettings: () => ipcRenderer.invoke("system:open-display-settings"),
  embyLogin: (input) => ipcRenderer.invoke("emby:login", input),
  embyLogout: () => ipcRenderer.invoke("emby:logout"),
  embyAccounts: () => ipcRenderer.invoke("emby:accounts"),
  embyActivateAccount: (accountId) =>
    ipcRenderer.invoke("emby:activate-account", accountId),
  embyUpdateEndpoints: (accountId, input) =>
    ipcRenderer.invoke("emby:update-endpoints", accountId, input),
  embySearchAll: (input) => ipcRenderer.invoke("emby:search-all", input),
  embyListViews: (input) => ipcRenderer.invoke("emby:list-views", input),
  embyListItems: (input) => ipcRenderer.invoke("emby:list-items", input),
  embyImageData: (input) => ipcRenderer.invoke("emby:image-data", input),
  embyPlaybackInfo: (input) =>
    ipcRenderer.invoke("emby:playback-info", input),
  embyStartStream: (input) => ipcRenderer.invoke("emby:start-stream", input),
  embyStopStream: (reason, expectedPipelineId) =>
    ipcRenderer.invoke(
      "emby:stop-stream",
      reason,
      expectedPipelineId,
    ),
  embySetFlowPaused: (paused, expectedPipelineId, generation) =>
    ipcRenderer.invoke(
      "emby:set-flow-paused",
      {
        paused: Boolean(paused),
        pipelineId: expectedPipelineId,
        generation: Math.max(0, Number(generation) || 0),
      },
    ),
  embyGetFlowState: (expectedPipelineId) =>
    ipcRenderer.invoke("emby:get-flow-state", expectedPipelineId),
  embyUpdateSegmentRelay: (input) =>
    ipcRenderer.invoke("emby:update-segment-relay", input),
  embyUpdateRenditionDemand: (input) =>
    ipcRenderer.invoke("emby:update-rendition-demand", input),
  embyReportPlayback: (input) =>
    ipcRenderer.invoke("emby:report-playback", input),
  onEmbyStreamEvent: (callback) => {
    embyStreamListeners.add(callback);
    return () => embyStreamListeners.delete(callback);
  },
  platform: process.platform,
});
