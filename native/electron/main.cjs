const { app, BrowserWindow, desktopCapturer, ipcMain, powerSaveBlocker, session } = require("electron");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

let mainWindow;
let selectedSourceId;
let powerBlockerId;
let localSignalServer;
let localSignalReady = false;
const smokeTest = process.env.YIQIKAN_SMOKE_TEST === "1";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 920,
    minHeight: 650,
    show: false,
    backgroundColor: "#050b16",
    autoHideMenuBar: true,
    title: "一起看",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  if (!smokeTest) {
    mainWindow.once("ready-to-show", () => mainWindow.show());
  }
  mainWindow.webContents.once("did-finish-load", async () => {
    if (!smokeTest) {
      return;
    }
    try {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const network = await window.roomDesktop?.getNetworkInfo();
        return {
          desktopBridge: Boolean(window.roomDesktop),
          startButton: Boolean(document.querySelector("#start-share")),
          title: document.title,
          localSignalReady: Boolean(network?.localSignalReady)
        };
      })()`);
      console.log(`YIQIKAN_SMOKE ${JSON.stringify(result)}`);
      app.exit(result.desktopBridge && result.startButton && result.localSignalReady ? 0 : 1);
    } catch (error) {
      console.error("YIQIKAN_SMOKE_FAILED", error);
      app.exit(1);
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  const devUrl = process.env.YIQIKAN_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "dist-renderer", "index.html"));
  }
}

async function startLocalSignalServer() {
  try {
    const moduleUrl = pathToFileURL(path.join(__dirname, "..", "server", "index.mjs")).href;
    const { createSignalServer } = await import(moduleUrl);
    localSignalServer = createSignalServer();
    await localSignalServer.listen(8787, "0.0.0.0");
    localSignalReady = true;
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      localSignalReady = true;
      return;
    }
    console.error("Unable to start local signal server", error);
  }
}

async function findSelectedSource() {
  if (!selectedSourceId) {
    return undefined;
  }
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  return sources.find((source) => source.id === selectedSourceId);
}

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const source = await findSelectedSource();
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source, audio: "loopback" });
    } catch {
      callback({});
    }
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ["media", "display-capture", "fullscreen"].includes(permission);
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["media", "display-capture", "fullscreen"].includes(permission));
  });

  ipcMain.handle("capture:list-sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: true,
    });
    return sources
      .filter((source) => !mainWindow || source.name !== mainWindow.getTitle())
      .map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
        appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : undefined,
      }));
  });

  ipcMain.handle("capture:select-source", async (_event, sourceId) => {
    if (typeof sourceId !== "string" || !sourceId.startsWith("window:")) {
      throw new Error("无效的窗口来源");
    }
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 0, height: 0 },
    });
    if (!sources.some((source) => source.id === sourceId)) {
      throw new Error("窗口已经关闭，请重新选择");
    }
    selectedSourceId = sourceId;
    return true;
  });

  ipcMain.handle("capture:set-active", (_event, active) => {
    if (active && powerBlockerId === undefined) {
      powerBlockerId = powerSaveBlocker.start("prevent-display-sleep");
    } else if (!active && powerBlockerId !== undefined) {
      if (powerSaveBlocker.isStarted(powerBlockerId)) {
        powerSaveBlocker.stop(powerBlockerId);
      }
      powerBlockerId = undefined;
      selectedSourceId = undefined;
    }
  });
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:get-network-info", () => {
    const addresses = [];
    for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
          const virtual = /virtual|vmware|vethernet|hyper-v|wsl|loopback/i.test(interfaceName);
          const privateLan =
            entry.address.startsWith("192.168.") ||
            entry.address.startsWith("10.") ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address);
          addresses.push({
            address: entry.address,
            rank: (virtual ? 10 : 0) + (privateLan ? 0 : 2),
          });
        }
      }
    }
    addresses.sort((left, right) => left.rank - right.rank);
    const lanAddresses = [...new Set(addresses.map((entry) => entry.address))];
    return { localSignalReady, lanAddresses: [...new Set(lanAddresses)] };
  });

  void startLocalSignalServer().finally(createWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void localSignalServer?.close();
});
