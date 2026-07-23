const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("roomDesktop", {
  listSources: () => ipcRenderer.invoke("capture:list-sources"),
  selectSource: (sourceId) => ipcRenderer.invoke("capture:select-source", sourceId),
  setCaptureActive: (active) => ipcRenderer.invoke("capture:set-active", Boolean(active)),
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  getNetworkInfo: () => ipcRenderer.invoke("app:get-network-info"),
  platform: process.platform,
});
