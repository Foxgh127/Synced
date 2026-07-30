const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("danmakuOverlay", {
  onMessage: (callback) => {
    ipcRenderer.on("overlay:danmaku", (_event, message) => callback(message));
  },
  onClear: (callback) => {
    ipcRenderer.on("overlay:clear", () => callback());
  },
});
