const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  MessageChannelMain,
  powerSaveBlocker,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  WebContentsView,
} = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { AudioPacketDecoder } = require("./audio-packet.cjs");
const { EmbyAccountManager } = require("./emby-account-manager.cjs");
const { EmbyService } = require("./emby-service.cjs");

let mainWindow;
let selectedSource;
let lastCaptureHealthDeepInspectAt = 0;
let powerBlockerId;
let audioCaptureProcess;
let audioCaptureSequence = 0;
let audioCaptureState = {
  captureId: 0,
  active: false,
  starting: false,
  packetCount: 0,
  byteCount: 0,
  lastPacketAt: 0,
};
let overlayWindow;
let overlayReady = false;
let overlayMessages = [];
let latestCaptureWindow;
let captureActive = false;
let desktopDanmakuActive = false;
let lastOverlayMoveTopAt = 0;
let miniWindowEnabled = false;
let allowMainWindowMinimize = false;
let preparingMainWindowMinimize = false;
let embyAccounts;
let embyStreamPort;
let shutdownInProgress = false;
let shutdownComplete = false;
let gameView;
let gameViewAttached = false;
let mediaPermissionIntent;
let microphonePermissionSessionActive = false;

function closeEmbyStreamPort() {
  try {
    embyStreamPort?.close();
  } catch {
    // The renderer may already have closed its end during reload.
  }
  embyStreamPort = undefined;
}

function installEmbyStreamPort() {
  if (
    !MessageChannelMain ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  ) {
    return;
  }
  closeEmbyStreamPort();
  const { port1, port2 } = new MessageChannelMain();
  embyStreamPort = port1;
  port1.on("close", () => {
    if (embyStreamPort === port1) embyStreamPort = undefined;
  });
  port1.start();
  mainWindow.webContents.postMessage("emby:stream-port", null, [port2]);
}

function sendEmbyStreamEvent(payload) {
  if (embyStreamPort) {
    try {
      const data = payload?.data;
      if (data && ArrayBuffer.isView(data)) {
        // Fragment parser buffers may be pooled. Copy only the live view into
        // an exactly sized payload so the full Node slab is never serialized.
        const transferable = new Uint8Array(data.byteLength);
        transferable.set(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
        embyStreamPort.postMessage({ ...payload, data: transferable });
      } else {
        embyStreamPort.postMessage(payload);
      }
      return;
    } catch {
      closeEmbyStreamPort();
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("emby:stream-event", payload);
  }
}
const GAME_URL = "https://bluff.synced.com.cn/";
const GAME_ORIGIN = new URL(GAME_URL).origin;
const KNOWN_MUSIC_PROCESS_NAMES = [
  "cloudmusic",
  "orpheus",
  "qqmusic",
  "kugou",
  "qishui",
  "luna",
  ...(
    process.env.SYNCED_E2E === "1" &&
    /^[a-z0-9._-]{1,64}$/i.test(
      process.env.SYNCED_E2E_MUSIC_PROCESS || "",
    )
      ? [process.env.SYNCED_E2E_MUSIC_PROCESS.toLowerCase()]
      : []
  ),
];
const hardenedGameSessions = new WeakSet();
const smokeTest = process.env.SYNCED_SMOKE_TEST === "1";
const e2eTest = process.env.SYNCED_E2E === "1";
const e2eVisible = process.env.SYNCED_E2E_VISIBLE === "1";
const isInviteUrl = (argument) =>
  typeof argument === "string" &&
  argument.startsWith("synced://");
let pendingOpenUrl = process.argv.find(isInviteUrl);
let diagnosticLogPath;
let diagnosticBuffer = [];
let diagnosticBufferedBytes = 0;
let diagnosticFlushTimer;
let diagnosticWriteQueue = Promise.resolve();
const DIAGNOSTIC_FLUSH_DELAY_MS = 250;
const DIAGNOSTIC_FLUSH_BYTES = 64 * 1024;
const DIAGNOSTIC_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DIAGNOSTIC_MAX_ENTRY_BYTES = 16 * 1024;
const FIREWALL_SUCCESS_CACHE_MS = 10 * 60_000;
const FIREWALL_FAILURE_CACHE_MS = 15_000;
let portableFirewallCache;
let portableFirewallInFlight;

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

if (!smokeTest && !e2eTest && !app.requestSingleInstanceLock()) {
  app.quit();
}

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// A portable desktop application is allowed to reveal its physical LAN
// candidate to the invited peers. mDNS host names are frequently not
// resolvable between Android WebView and Windows on consumer routers.
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");
// Chromium's "default_public_and_private_interfaces" policy means "only the
// HTTP default route", not "all public and private adapters". When Clash,
// Mihomo or another TUN becomes that route, the physical Wi-Fi/Ethernet
// candidates disappear and direct ICE has no usable path. The native app has
// explicit media permission and filters fake TUN host candidates itself, so
// the true default policy is the reliable choice here.
app.commandLine.appendSwitch(
  "force-webrtc-ip-handling-policy",
  "default",
);

function initialiseDiagnosticLog() {
  try {
    const logDirectory = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDirectory, { recursive: true });
    diagnosticLogPath = path.join(logDirectory, "portable.log");
    rotateDiagnosticLogIfNeeded(diagnosticLogPath, 0);
    try {
      fs.chmodSync(logDirectory, 0o700);
      if (fs.existsSync(diagnosticLogPath)) {
        fs.chmodSync(diagnosticLogPath, 0o600);
      }
    } catch {
      // Windows ACLs and read-only portable locations may ignore POSIX modes.
    }
  } catch {
    diagnosticLogPath = undefined;
  }
}

function rotateDiagnosticLogIfNeeded(targetPath, incomingBytes) {
  let currentBytes = 0;
  try {
    currentBytes = fs.statSync(targetPath).size;
  } catch {
    return;
  }
  if (
    currentBytes + Math.max(0, Number(incomingBytes) || 0) <=
    DIAGNOSTIC_MAX_FILE_BYTES
  ) {
    return;
  }
  const previousPath = `${targetPath}.previous`;
  try {
    fs.rmSync(previousPath, { force: true });
    fs.renameSync(targetPath, previousPath);
    fs.chmodSync(previousPath, 0o600);
  } catch {
    // Enforce the hard ceiling even if antivirus or a stale .previous file
    // prevents an atomic rotation.
    try {
      fs.truncateSync(targetPath, 0);
    } catch {
      diagnosticLogPath = undefined;
    }
  }
}

function sanitizeDiagnosticValue(value, key = "", depth = 0, seen = new WeakSet()) {
  if (
    /authorization|cookie|sdp|candidate|secret|password|token|credential|owner|resume|segment|url|uri|path/i.test(
      key,
    )
  ) {
    return "[redacted]";
  }
  if (depth > 5) return "[depth-limit]";
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]")
      .replace(
        /\bhttps?:\/\/[^\s"'<>]+/giu,
        (candidate) => {
          try {
            const parsed = new URL(candidate);
            parsed.username = "";
            parsed.password = "";
            parsed.search = "";
            parsed.hash = "";
            return parsed.toString();
          } catch {
            return "[redacted-url]";
          }
        },
      )
      .slice(0, 1_000);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map((entry) =>
        sanitizeDiagnosticValue(entry, key, depth + 1, seen),
      );
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const output = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 64)) {
      output[childKey] = sanitizeDiagnosticValue(
        childValue,
        childKey,
        depth + 1,
        seen,
      );
    }
    return output;
  }
  return String(value).slice(0, 256);
}

function flushDiagnosticLog() {
  if (diagnosticFlushTimer) {
    clearTimeout(diagnosticFlushTimer);
    diagnosticFlushTimer = undefined;
  }
  if (!diagnosticLogPath || diagnosticBuffer.length === 0) {
    return diagnosticWriteQueue;
  }
  const targetPath = diagnosticLogPath;
  const payload = diagnosticBuffer.join("");
  diagnosticBuffer = [];
  diagnosticBufferedBytes = 0;
  diagnosticWriteQueue = diagnosticWriteQueue
    .catch(() => undefined)
    .then(async () => {
      rotateDiagnosticLogIfNeeded(
        targetPath,
        Buffer.byteLength(payload, "utf8"),
      );
      if (!diagnosticLogPath) return;
      await fs.promises.appendFile(targetPath, payload, {
        encoding: "utf8",
        mode: 0o600,
      });
    })
    .catch(() => undefined);
  return diagnosticWriteQueue;
}

function scheduleDiagnosticFlush() {
  if (diagnosticFlushTimer) return;
  diagnosticFlushTimer = setTimeout(() => {
    diagnosticFlushTimer = undefined;
    void flushDiagnosticLog();
  }, DIAGNOSTIC_FLUSH_DELAY_MS);
  diagnosticFlushTimer.unref?.();
}

function diagnostic(event, detail = {}) {
  if (!diagnosticLogPath) return;
  const safeDetail = sanitizeDiagnosticValue(
    detail && typeof detail === "object"
      ? detail
      : { detail: String(detail) },
  );
  try {
    let entry = `${JSON.stringify({
      at: new Date().toISOString(),
      event: String(event).slice(0, 80),
      ...safeDetail,
    })}\n`;
    if (Buffer.byteLength(entry, "utf8") > DIAGNOSTIC_MAX_ENTRY_BYTES) {
      entry = `${JSON.stringify({
        at: new Date().toISOString(),
        event: String(event).slice(0, 80),
        discarded: "diagnostic entry exceeded hard size limit",
      })}\n`;
    }
    diagnosticBuffer.push(entry);
    diagnosticBufferedBytes += Buffer.byteLength(entry, "utf8");
    if (diagnosticBufferedBytes >= DIAGNOSTIC_FLUSH_BYTES) {
      void flushDiagnosticLog();
    } else {
      scheduleDiagnosticFlush();
    }
  } catch {
    // Diagnostics must never interrupt the capture path.
  }
}

function persistentEmbyDeviceId() {
  const deviceIdPath = path.join(app.getPath("userData"), "emby-device-id.txt");
  try {
    const existing = fs.readFileSync(deviceIdPath, "utf8").trim();
    if (/^[a-z0-9-]{16,128}$/i.test(existing)) return existing;
  } catch {
    // The first Emby login creates a device identity.
  }
  const created = randomUUID();
  try {
    fs.writeFileSync(deviceIdPath, created, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // A portable read-only location can still use an in-memory device id.
  }
  return created;
}

function channelOwnerStoragePath() {
  return path.join(app.getPath("userData"), "channel-owner.v1.bin");
}

function loadSecureChannelOwnership() {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  try {
    const encrypted = fs.readFileSync(channelOwnerStoragePath());
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    if (
      !/^[23456789A-HJ-NP-Z]{8}$/u.test(String(parsed?.room || "")) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(String(parsed?.ownerToken || ""))
    ) {
      return undefined;
    }
    return {
      room: parsed.room,
      ownerToken: parsed.ownerToken,
    };
  } catch {
    return undefined;
  }
}

function saveSecureChannelOwnership(value) {
  if (
    !safeStorage.isEncryptionAvailable() ||
    !/^[23456789A-HJ-NP-Z]{8}$/u.test(String(value?.room || "")) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(String(value?.ownerToken || ""))
  ) {
    return false;
  }
  const targetPath = channelOwnerStoragePath();
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    const encrypted = safeStorage.encryptString(
      JSON.stringify({
        room: value.room,
        ownerToken: value.ownerToken,
      }),
    );
    fs.writeFileSync(temporaryPath, encrypted, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryPath, targetPath);
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      // Windows protects safeStorage ciphertext with the current OS account.
    }
    return true;
  } catch {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Best effort cleanup.
    }
    return false;
  }
}

function assertMainRenderer(event) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents
  ) {
    throw new Error("主窗口当前不可用");
  }
}

function grantMediaPermissionIntent(kind, uses = 1) {
  mediaPermissionIntent = {
    kind,
    remaining: Math.max(1, Math.min(8, Number(uses) || 1)),
    expiresAt: Date.now() + 60_000,
  };
}

function hasMediaPermissionIntent(kind) {
  return Boolean(
    mediaPermissionIntent &&
      mediaPermissionIntent.kind === kind &&
      mediaPermissionIntent.remaining > 0 &&
      Date.now() <= mediaPermissionIntent.expiresAt,
  );
}

function consumeMediaPermissionIntent(kind) {
  if (!hasMediaPermissionIntent(kind)) return false;
  mediaPermissionIntent.remaining -= 1;
  if (mediaPermissionIntent.remaining <= 0) {
    mediaPermissionIntent = undefined;
  }
  return true;
}

function isMainRenderer(webContents) {
  return (
    Boolean(mainWindow) &&
    !mainWindow.isDestroyed() &&
    webContents === mainWindow.webContents
  );
}

function isAllowedGameUrl(value) {
  try {
    return new URL(value).origin === GAME_ORIGIN;
  } catch {
    return false;
  }
}

function sendGameViewState(state, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("game:view-state", {
    state,
    message: String(message || "").slice(0, 240),
  });
}

function normalizeGameViewBounds(input) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("主窗口当前不可用");
  }
  const content = mainWindow.getContentBounds();
  const x = Math.max(
    0,
    Math.min(content.width - 1, Math.round(Number(input?.x) || 0)),
  );
  const y = Math.max(
    0,
    Math.min(content.height - 1, Math.round(Number(input?.y) || 0)),
  );
  const width = Math.max(
    1,
    Math.min(content.width - x, Math.round(Number(input?.width) || 1)),
  );
  const height = Math.max(
    1,
    Math.min(content.height - y, Math.round(Number(input?.height) || 1)),
  );
  return { x, y, width, height };
}

function ensureGameView() {
  if (gameView && !gameView.webContents.isDestroyed()) return gameView;
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      partition: "persist:synced-bluff",
      // A hidden game view is retained for fast return, but it must be allowed
      // to sleep while detached or it can keep rendering at full speed after
      // the user returns to the channel.
      backgroundThrottling: true,
    },
  });
  gameView = view;
  gameViewAttached = false;
  view.setBackgroundColor("#080a0f");

  const gameSession = view.webContents.session;
  if (!hardenedGameSessions.has(gameSession)) {
    hardenedGameSessions.add(gameSession);
    gameSession.setPermissionCheckHandler(() => false);
    gameSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    gameSession.on("will-download", (event) => event.preventDefault());
  }

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedGameUrl(url)) {
      setImmediate(() => {
        if (gameView === view && !view.webContents.isDestroyed()) {
          void view.webContents.loadURL(url);
        }
      });
    }
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedGameUrl(url)) event.preventDefault();
  });
  view.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedGameUrl(url)) event.preventDefault();
  });
  view.webContents.on("did-start-loading", () => {
    if (gameView === view) sendGameViewState("loading");
  });
  view.webContents.on("did-finish-load", () => {
    if (gameView === view) sendGameViewState("ready");
  });
  view.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (
        gameView === view &&
        isMainFrame &&
        errorCode !== -3
      ) {
        sendGameViewState(
          "error",
          `游戏加载失败（${errorCode}）：${errorDescription}`,
        );
      }
    },
  );
  view.webContents.on("render-process-gone", (_event, details) => {
    if (gameView !== view) return;
    diagnostic("game-renderer-gone", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
    sendGameViewState("error", "游戏进程意外退出，请点击刷新");
  });
  return view;
}

function showGameView(bounds) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("主窗口当前不可用");
  }
  const view = ensureGameView();
  if (!gameViewAttached) {
    mainWindow.contentView.addChildView(view);
    gameViewAttached = true;
  }
  view.setBounds(normalizeGameViewBounds(bounds));
  const current = view.webContents.getURL();
  if (!isAllowedGameUrl(current)) {
    void view.webContents.loadURL(GAME_URL);
  } else {
    sendGameViewState(
      view.webContents.isLoading() ? "loading" : "ready",
    );
  }
}

function hideGameView() {
  if (
    !gameView ||
    !gameViewAttached ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return;
  }
  mainWindow.contentView.removeChildView(gameView);
  gameViewAttached = false;
}

function destroyGameView() {
  hideGameView();
  if (gameView && !gameView.webContents.isDestroyed()) {
    gameView.webContents.close();
  }
  gameView = undefined;
  gameViewAttached = false;
}

function createWindow() {
  miniWindowEnabled = false;
  allowMainWindowMinimize = false;
  preparingMainWindowMinimize = false;
  mainWindow = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 920,
    minHeight: 650,
    show: false,
    backgroundColor: "#0c0e13",
    autoHideMenuBar: true,
    title: "同频",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Voice, WebRTC decoding, and video Picture-in-Picture must continue
      // while the main window is minimized or covered by another app.
      backgroundThrottling: false,
    },
  });

  let revealTimer;
  const revealWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) {
      return;
    }
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = undefined;
    }
    mainWindow.show();
  };
  if (!smokeTest && (!e2eTest || e2eVisible)) {
    mainWindow.once("ready-to-show", revealWindow);
    mainWindow.webContents.once("did-finish-load", revealWindow);
    // Antivirus scanning or a slow graphics driver can occasionally delay
    // ready-to-show. The window already has a dark background, so revealing it
    // is preferable to leaving the user with no visible response.
    revealTimer = setTimeout(revealWindow, 1_200);
  }
  mainWindow.webContents.once("did-finish-load", async () => {
    if (pendingOpenUrl) {
      mainWindow.webContents.send("app:open-url", pendingOpenUrl);
      pendingOpenUrl = undefined;
    }
    if (!smokeTest) {
      return;
    }
    try {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        return {
          desktopBridge: Boolean(window.roomDesktop),
          roleButtons: document.querySelectorAll("[data-desktop-role]").length,
          title: document.title
        };
      })()`);
      const smokeView = process.env.SYNCED_SMOKE_VIEW;
      if (smokeView === "host" || smokeView === "channel") {
        await mainWindow.webContents.executeJavaScript(
          `document.querySelector("#choose-host")?.click()`,
        );
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (smokeView === "channel") {
        await mainWindow.webContents.executeJavaScript(`(() => {
          const input = document.querySelector("#host-signal-url");
          if (input) input.value = "wss://synced.com.cn/signal";
          document.querySelector("#start-share")?.click();
        })()`);
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const ready = await mainWindow.webContents.executeJavaScript(
            `Boolean(
              document.querySelector("#broadcast-action") &&
              !document.querySelector("#broadcast-action").disabled &&
              document.querySelector("#channel-empty") &&
              document.querySelector(".participant-row")
            )`,
          );
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        result.channelReady = await mainWindow.webContents.executeJavaScript(`Boolean(
          document.querySelector("#broadcast-action") &&
          !document.querySelector("#broadcast-action").disabled &&
          document.querySelector("#channel-empty") &&
          document.querySelector("#voice-button") &&
          document.querySelector("#chat-form") &&
          document.querySelector(".participant-row")
        )`);
      }
      if (process.env.SYNCED_SMOKE_SCREENSHOT) {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(process.env.SYNCED_SMOKE_SCREENSHOT, image.toPNG());
      }
      console.log(`SYNCED_SMOKE ${JSON.stringify(result)}`);
      const channelPassed = smokeView !== "channel" || result.channelReady;
      app.exit(
        result.desktopBridge &&
        result.roleButtons === 2 &&
        channelPassed
          ? 0
          : 1,
      );
    } catch (error) {
      console.error("SYNCED_SMOKE_FAILED", error);
      app.exit(1);
    }
  });
  mainWindow.webContents.on("did-finish-load", installEmbyStreamPort);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("move", updateOverlayBounds);
  mainWindow.on("focus", updateOverlayBounds);
  mainWindow.on("blur", updateOverlayBounds);
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    diagnostic("renderer-gone", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  mainWindow.webContents.on("console-message", (_event, ...args) => {
    const details =
      args.length === 1 && typeof args[0] === "object"
        ? args[0]
        : { level: args[0], message: args[1], lineNumber: args[2] };
    if (Number(details.level) >= 2) {
      diagnostic("renderer-console", {
        level: details.level,
        message: String(details.message || "").slice(0, 800),
        lineNumber: details.lineNumber,
      });
    }
  });
  mainWindow.on("minimize", (event) => {
    if (
      allowMainWindowMinimize ||
      !miniWindowEnabled ||
      preparingMainWindowMinimize ||
      !mainWindow ||
      mainWindow.isDestroyed()
    ) {
      return;
    }
    event.preventDefault();
    preparingMainWindowMinimize = true;
    const windowToMinimize = mainWindow;
    void windowToMinimize.webContents
      .executeJavaScript(
        "Promise.resolve(globalThis.__syncedEnterMiniWindowForMinimize?.() ?? false)",
        true,
      )
      .then((entered) => {
        diagnostic("mini-window-minimize", {
          enabled: true,
          entered: entered === true,
        });
      })
      .catch((error) => {
        diagnostic("mini-window-minimize-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        preparingMainWindowMinimize = false;
        if (windowToMinimize.isDestroyed()) return;
        allowMainWindowMinimize = true;
        windowToMinimize.minimize();
        allowMainWindowMinimize = false;
      });
  });
  mainWindow.on("restore", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window:restored");
    }
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL();
    const targetUrl = typeof url === "string" ? url : event.url;
    if (targetUrl !== currentUrl) {
      event.preventDefault();
    }
  });
  mainWindow.on("closed", () => {
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = undefined;
    }
    destroyGameView();
    closeEmbyStreamPort();
    mainWindow = undefined;
    miniWindowEnabled = false;
    allowMainWindowMinimize = false;
    preparingMainWindowMinimize = false;
    stopProcessAudioCapture();
    stopDanmakuOverlay();
    overlayWindow?.destroy();
    overlayWindow = undefined;
  });

  const devUrl = process.env.SYNCED_DEV_URL;
  let trustedDevUrl = false;
  if (!app.isPackaged && devUrl) {
    try {
      const parsed = new URL(devUrl);
      trustedDevUrl =
        ["http:", "https:"].includes(parsed.protocol) &&
        ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    } catch {
      trustedDevUrl = false;
    }
  }
  if (trustedDevUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    if (devUrl) {
      diagnostic("untrusted-dev-url-rejected", { devUrl });
    }
    void mainWindow.loadFile(path.join(__dirname, "..", "dist-renderer", "index.html"));
  }
}

async function findSelectedSource(options = {}) {
  if (!selectedSource) {
    return undefined;
  }
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    // A small thumbnail lets us distinguish a hidden/blanked legacy window
    // from the new top-level surface many players create for fullscreen.
    thumbnailSize: { width: 160, height: 90 },
    fetchWindowIcons: false,
  });
  const exactOriginal =
    sources.find((source) => source.id === selectedSource.id) ||
    sources.find(
      (source) =>
        sourceHandle(source.id) &&
        sourceHandle(source.id) === selectedSource.windowHandle,
    );
  const original =
    exactOriginal ||
    (!selectedSource.processId
      ? sources.find((source) => source.name === selectedSource.name)
      : undefined);
  if (!selectedSource.processId) return original;
  const originalActivity = sourceVisualActivity(original);
  // Healthy captures avoid spawning the window-inspection helper on every
  // low-frequency health poll. Process matching is only needed when the old
  // surface disappeared or its thumbnail became effectively blank.
  if (
    original &&
    originalActivity >= 0.01 &&
    options.forceProcessInspection !== true
  ) {
    return original;
  }

  const processByHandle = await inspectWindowProcesses(
    sources.map((source) => source.id),
  );
  const normalizedTitle = (value) =>
    String(value || "")
      .toLocaleLowerCase("zh-CN")
      .replace(
        /\b(fullscreen|full screen|picture-in-picture|pip)\b/giu,
        "",
      )
      .replace(/[^\p{L}\p{N}]+/gu, "");
  const selectedTitle = normalizedTitle(selectedSource.name);
  const sameIdentity = sources.filter((source) => {
    const detail = processByHandle.get(sourceHandle(source.id));
    if (
      Number(detail?.processId) !== Number(selectedSource.processId)
    ) {
      return false;
    }
    if (
      selectedSource.executableName &&
      detail?.executableName &&
      String(detail.executableName).toLowerCase() !==
        String(selectedSource.executableName).toLowerCase()
    ) {
      return false;
    }
    const classMatches =
      Boolean(selectedSource.className) &&
      Boolean(detail?.className) &&
      detail.className === selectedSource.className;
    const candidateTitle = normalizedTitle(source.name);
    const titleMatches =
      selectedTitle.length >= 3 &&
      candidateTitle.length >= 3 &&
      (
        selectedTitle === candidateTitle ||
        selectedTitle.includes(candidateTitle) ||
        candidateTitle.includes(selectedTitle)
      );
    const ownerMatches =
      Boolean(detail?.ownerHandle) &&
      [
        selectedSource.windowHandle,
        selectedSource.ownerHandle,
      ].includes(detail.ownerHandle);
    // A replacement needs the exact process plus at least two stable window
    // identity signals. Visual activity alone can never redirect capture.
    return (
      (classMatches && titleMatches) ||
      (classMatches && ownerMatches) ||
      (titleMatches && ownerMatches)
    );
  });
  if (!sameIdentity.length) return original;
  const windowScore = (source) => {
    const detail = processByHandle.get(sourceHandle(source.id));
    const area =
      Math.max(0, Number(detail?.width) || 0) *
      Math.max(0, Number(detail?.height) || 0);
    return (
      sourceVisualActivity(source) * 10 +
      (detail?.foreground === true ? 100 : 0) +
      (detail?.visible === true ? 10 : 0) +
      (detail?.minimized === false ? 5 : 0) +
      Math.min(4, area / 1_000_000)
    );
  };
  const replacement = [...sameIdentity].sort(
    (left, right) => windowScore(right) - windowScore(left),
  )[0];
  if (!original) {
    diagnostic("display-source-followed-process", {
      processId: selectedSource.processId,
      previousName: selectedSource.name,
      replacementName: replacement.name,
      reason: "window-recreated",
    });
    return replacement;
  }
  const replacementActivity = sourceVisualActivity(replacement);
  if (
    replacement.id !== original.id &&
    originalActivity < 0.01 &&
    replacementActivity >= Math.max(0.03, originalActivity + 0.03)
  ) {
    diagnostic("display-source-followed-process", {
      processId: selectedSource.processId,
      previousName: original.name,
      replacementName: replacement.name,
      reason: "legacy-window-blank",
    });
    return replacement;
  }
  return original;
}

function sourceHandle(sourceId) {
  return sourceId?.match(/^window:([^:]+):/)?.[1];
}

function sourceVisualActivity(source) {
  try {
    const thumbnail = source?.thumbnail;
    if (!thumbnail || thumbnail.isEmpty()) return 0;
    const bitmap = thumbnail.toBitmap();
    const pixels = Math.floor(bitmap.length / 4);
    if (!pixels) return 0;
    const stride = Math.max(1, Math.floor(pixels / 2_048));
    let sampled = 0;
    let visible = 0;
    for (let pixel = 0; pixel < pixels; pixel += stride) {
      const offset = pixel * 4;
      // Electron NativeImage bitmaps use BGRA ordering.
      const luminance =
        bitmap[offset] * 0.0722 +
        bitmap[offset + 1] * 0.7152 +
        bitmap[offset + 2] * 0.2126;
      sampled += 1;
      if (luminance >= 12) visible += 1;
    }
    return sampled ? visible / sampled : 0;
  } catch {
    return 0;
  }
}

function audioHelperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "audio-helper", "Synced.AudioCapture.exe");
  }
  return path.join(__dirname, "..", "audio-helper", "publish", "win-x64", "Synced.AudioCapture.exe");
}

async function inspectWindowProcesses(sourceIds) {
  if (process.platform !== "win32") return new Map();
  const handles = [
    ...new Set(sourceIds.map(sourceHandle).filter(Boolean)),
  ];
  const executable = audioHelperPath();
  if (!handles.length || !fs.existsSync(executable)) return new Map();
  return new Promise((resolve) => {
    const child = spawn(
      executable,
      ["--inspect-windows", handles.join(",")],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let output = "";
    let settled = false;
    const finish = (entries = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(
        new Map(
          entries
            .filter((entry) => entry?.handle)
            .map((entry) => [String(entry.handle), entry]),
        ),
      );
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish();
    }, 2_500);
    child.stdout.on("data", (chunk) => {
      if (output.length < 512_000) output += chunk.toString("utf8");
    });
    child.once("error", () => finish());
    child.once("exit", (code) => {
      if (code !== 0) {
        finish();
        return;
      }
      try {
        const payload = JSON.parse(output);
        finish(Array.isArray(payload?.windows) ? payload.windows : []);
      } catch {
        finish();
      }
    });
  });
}

async function inspectKnownMusicProcesses() {
  if (process.platform !== "win32") return [];
  const executable = audioHelperPath();
  if (!fs.existsSync(executable)) return [];
  return new Promise((resolve) => {
    const child = spawn(
      executable,
      ["--inspect-processes", KNOWN_MUSIC_PROCESS_NAMES.join(",")],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let output = "";
    let settled = false;
    const finish = (entries = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(
        entries.filter(
          (entry) =>
            Number.isSafeInteger(Number(entry?.processId)) &&
            Number(entry.processId) > 0 &&
            KNOWN_MUSIC_PROCESS_NAMES.includes(
              String(entry?.processName || "").toLowerCase(),
            ),
        ),
      );
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish();
    }, 2_500);
    child.stdout.on("data", (chunk) => {
      if (output.length < 256_000) output += chunk.toString("utf8");
    });
    child.once("error", () => finish());
    child.once("exit", (code) => {
      if (code !== 0) {
        finish();
        return;
      }
      try {
        const payload = JSON.parse(output);
        finish(Array.isArray(payload?.processes) ? payload.processes : []);
      } catch {
        finish();
      }
    });
  });
}

async function inspectAndRepairPortableFirewallRules(executable) {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const quotePowerShell = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const ruleNames = ["Synced P2P UDP v3"];
  // Query the single private-profile UDP app rule in one structured
  // NetSecurity invocation. Starting
  // PowerShell is materially more expensive than the rule lookup itself.
  const query = [
    `$requiredNames = @(${ruleNames.map(quotePowerShell).join(", ")})`,
    "foreach ($requiredName in $requiredNames) {",
    "  $matched = $false",
    "  $rules = @(Get-NetFirewallRule -DisplayName $requiredName -ErrorAction SilentlyContinue)",
    "  foreach ($rule in $rules) {",
    "    if ($rule.Enabled -ne 'True' -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow' -or $rule.Profile -ne 'Private') { continue }",
    "    $apps = @($rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue)",
    "    $ports = @($rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue)",
    "    foreach ($appFilter in $apps) {",
    `      if ($appFilter.Program -ieq ${quotePowerShell(executable)} -and @($ports | Where-Object { $_.Protocol -eq 'UDP' -or $_.Protocol -eq 17 }).Count -gt 0) { $matched = $true; break }`,
    "    }",
    "    if ($matched) { break }",
    "  }",
    "  if (-not $matched) { exit 1 }",
    "}",
    "exit 0",
  ].join("\r\n");
  const encodedQuery = Buffer.from(query, "utf16le").toString("base64");
  const present = await new Promise((resolve) => {
    const child = spawn(
      powershell,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedQuery],
      { windowsHide: true, stdio: "ignore" },
    );
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 12_000);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
  if (present) {
    diagnostic("firewall-ready", { executable });
    return { portable: true, configured: true, repaired: false };
  }
  if (process.env.SYNCED_SKIP_FIREWALL_REPAIR === "1") {
    diagnostic("firewall-repair-skipped-for-test", { executable });
    return { portable: true, configured: false, repaired: false };
  }

  const netsh = path.join(systemRoot, "System32", "netsh.exe");
  const commands = [];
  for (const legacyRuleName of [
    "Synced P2P UDP",
    "Synced P2P TCP",
    "Synced P2P UDP v2",
    "Synced P2P TCP v2",
    "Synced P2P UDP v3",
  ]) {
    commands.push(
      `& ${quotePowerShell(netsh)} @('advfirewall','firewall','delete','rule',${quotePowerShell(`name=${legacyRuleName}`)}) | Out-Null`,
    );
  }
  const ruleName = "Synced P2P UDP v3";
  commands.push(
    `& ${quotePowerShell(netsh)} @('advfirewall','firewall','delete','rule',${quotePowerShell(`name=${ruleName}`)}) | Out-Null`,
    `& ${quotePowerShell(netsh)} @('advfirewall','firewall','add','rule',${quotePowerShell(`name=${ruleName}`)},'dir=in','action=allow',${quotePowerShell(`program=${executable}`)},'enable=yes','profile=private','protocol=UDP','edge=no') | Out-Null`,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  );
  const elevatedScript = commands.join("\r\n");
  const encodedScript = Buffer.from(elevatedScript, "utf16le").toString("base64");
  const outerScript = [
    `$arguments = @('-NoProfile','-NonInteractive','-EncodedCommand','${encodedScript}')`,
    "try {",
    "  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru",
    "  exit $process.ExitCode",
    "} catch { exit 1223 }",
  ].join("\r\n");
  const result = await new Promise((resolve) => {
    const child = spawn(
      path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoProfile", "-NonInteractive", "-Command", outerScript],
      { windowsHide: true, stdio: "ignore" },
    );
    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 60_000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
  diagnostic(result ? "firewall-repaired" : "firewall-repair-skipped", {
    executable,
  });
  return { portable: true, configured: result, repaired: result };
}

async function ensurePortableFirewallRules() {
  if (
    process.platform !== "win32" ||
    !app.isPackaged ||
    !process.env.PORTABLE_EXECUTABLE_FILE
  ) {
    return { portable: false, configured: true, repaired: false };
  }
  const executable = process.execPath;
  const cacheKey = `${executable}\0${process.env.PORTABLE_EXECUTABLE_FILE}`;
  const cached = portableFirewallCache;
  if (cached?.key === cacheKey) {
    const ttl = cached.result.configured
      ? FIREWALL_SUCCESS_CACHE_MS
      : FIREWALL_FAILURE_CACHE_MS;
    if (Date.now() - cached.checkedAt < ttl) {
      return cached.result;
    }
  }
  if (portableFirewallInFlight?.key === cacheKey) {
    return portableFirewallInFlight.promise;
  }
  const operation = {
    key: cacheKey,
    promise: undefined,
  };
  operation.promise = inspectAndRepairPortableFirewallRules(executable)
    .then((result) => {
      portableFirewallCache = {
        key: cacheKey,
        checkedAt: Date.now(),
        result,
      };
      return result;
    })
    .finally(() => {
      if (portableFirewallInFlight === operation) {
        portableFirewallInFlight = undefined;
      }
    });
  portableFirewallInFlight = operation;
  return operation.promise;
}

function selectedWindowHandle() {
  if (!selectedSource?.windowHandle) {
    throw new Error("没有选中可采集声音的窗口");
  }
  return selectedSource.windowHandle;
}

function ensureOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }
  overlayReady = false;
  overlayMessages = [];
  lastOverlayMoveTopAt = 0;
  overlayWindow = new BrowserWindow({
    width: 800,
    height: 450,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setContentProtection(true);
  overlayWindow.webContents.once("did-finish-load", () => {
    overlayReady = true;
    for (const message of overlayMessages.splice(0)) {
      overlayWindow?.webContents.send(message.channel, message.payload);
    }
    updateOverlayBounds();
  });
  overlayWindow.on("closed", () => {
    overlayWindow = undefined;
    overlayReady = false;
    overlayMessages = [];
    lastOverlayMoveTopAt = 0;
  });
  void overlayWindow.loadFile(path.join(__dirname, "overlay.html"));
  return overlayWindow;
}

function sendToOverlay(channel, payload) {
  const window = ensureOverlayWindow();
  if (!overlayReady) {
    overlayMessages.push({ channel, payload });
    if (overlayMessages.length > 50) {
      overlayMessages = overlayMessages.slice(-50);
    }
    return;
  }
  window.webContents.send(channel, payload);
}

function desktopDanmakuDisplay() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return screen.getDisplayMatching(mainWindow.getBounds());
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function showOverlayAtBounds(bounds) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const current = overlayWindow.getBounds();
  if (
    current.x !== bounds.x ||
    current.y !== bounds.y ||
    current.width !== bounds.width ||
    current.height !== bounds.height
  ) {
    overlayWindow.setBounds(bounds, false);
  }
  if (!overlayWindow.isVisible()) {
    overlayWindow.showInactive();
  }
  const now = Date.now();
  if (now - lastOverlayMoveTopAt >= 1_000) {
    lastOverlayMoveTopAt = now;
    overlayWindow.moveTop();
  }
}

function updateOverlayBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }
  if (!captureActive && desktopDanmakuActive) {
    try {
      // The focused channel window renders this message over its own full
      // viewport. Hide the protected native overlay there to prevent a
      // duplicate; as soon as another app is focused, the native full-desktop
      // surface takes over again.
      if (
        mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.isVisible() &&
        !mainWindow.isMinimized() &&
        mainWindow.isFocused()
      ) {
        overlayWindow.hide();
        return;
      }
      // "No broadcast" is a true desktop mode. Anchor it to the display that
      // owns the room window so moving the mouse to a second monitor cannot
      // make danmaku unexpectedly jump away from the active conversation.
      const display = desktopDanmakuDisplay();
      showOverlayAtBounds(display.bounds);
    } catch (error) {
      console.warn("Unable to position desktop danmaku overlay", error);
      overlayWindow.hide();
    }
    return;
  }
  const info = latestCaptureWindow;
  if (
    !captureActive ||
    !info?.visible ||
    !info.foreground ||
    info.width < 160 ||
    info.height < 90
  ) {
    overlayWindow.hide();
    return;
  }
  try {
    const bounds = screen.screenToDipRect(null, {
      x: Math.round(info.left),
      y: Math.round(info.top),
      width: Math.round(info.width),
      height: Math.round(info.height),
    });
    showOverlayAtBounds(bounds);
  } catch (error) {
    console.warn("Unable to position danmaku overlay", error);
    overlayWindow.hide();
  }
}

function stopDanmakuOverlay() {
  captureActive = false;
  desktopDanmakuActive = false;
  latestCaptureWindow = undefined;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("overlay:clear");
    overlayWindow.hide();
  }
}

function processAudioStatusSnapshot() {
  return {
    ...audioCaptureState,
    lastPacketAgeMs: audioCaptureState.lastPacketAt
      ? Math.max(0, Date.now() - audioCaptureState.lastPacketAt)
      : undefined,
  };
}

function captureWindowHealthSnapshot() {
  const info = latestCaptureWindow;
  const captureId = Number(info?.captureId);
  const activeCaptureId = Number(audioCaptureState.captureId);
  const processId = Number(selectedSource?.processId);
  const expectedSourceHandle =
    Number.isSafeInteger(processId) && processId > 0
      ? `process:${processId}`
      : selectedSource?.id?.startsWith("window:")
        ? selectedSource.windowHandle || sourceHandle(selectedSource.id)
        : undefined;
  const currentCapture =
    Boolean(audioCaptureProcess) &&
    (audioCaptureState.active === true || audioCaptureState.starting === true) &&
    Number.isSafeInteger(captureId) &&
    captureId > 0 &&
    captureId === activeCaptureId &&
    typeof expectedSourceHandle === "string" &&
    expectedSourceHandle.length > 0 &&
    audioCaptureState.sourceHandle === expectedSourceHandle;
  const width = Number(info?.width);
  const height = Number(info?.height);
  if (
    !currentCapture ||
    !Number.isFinite(width) ||
    width < 0 ||
    !Number.isFinite(height) ||
    height < 0
  ) {
    return undefined;
  }
  return {
    width: Math.round(width),
    height: Math.round(height),
    foreground: info.foreground === true,
    visible: info.visible === true,
    minimized: info.minimized === true,
  };
}

function sendProcessAudioStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("capture:audio-status", status);
  }
}

function stopProcessAudioCapture(captureId, reason = "requested") {
  if (!audioCaptureProcess) {
    return false;
  }
  if (
    Number.isSafeInteger(captureId) &&
    captureId !== audioCaptureState.captureId
  ) {
    diagnostic("process-audio-stop-ignored", {
      requestedCaptureId: captureId,
      activeCaptureId: audioCaptureState.captureId,
      reason,
    });
    return false;
  }
  const processToStop = audioCaptureProcess;
  const stoppedCaptureId = audioCaptureState.captureId;
  audioCaptureProcess = undefined;
  audioCaptureState = {
    ...audioCaptureState,
    active: false,
    starting: false,
    stoppedAt: Date.now(),
    stopReason: reason,
  };
  processToStop.stdout?.removeAllListeners();
  processToStop.stderr?.removeAllListeners();
  if (!processToStop.killed) {
    processToStop.kill();
  }
  diagnostic("process-audio-stop", {
    captureId: stoppedCaptureId,
    reason,
    packetCount: audioCaptureState.packetCount,
    byteCount: audioCaptureState.byteCount,
  });
  return true;
}

async function startProcessAudioCapture() {
  stopProcessAudioCapture(undefined, "replaced");
  const executable = audioHelperPath();
  if (!fs.existsSync(executable)) {
    throw new Error(
      `窗口声音组件缺失，请重新安装或重新构建应用：${path.basename(executable)}`,
    );
  }
  const processId = Number(selectedSource?.processId);
  const processMode = Number.isSafeInteger(processId) && processId > 0;
  const windowHandle = processMode ? undefined : selectedWindowHandle();
  const captureTarget = processMode
    ? `process:${processId}`
    : windowHandle;
  const captureId = ++audioCaptureSequence;
  audioCaptureState = {
    captureId,
    active: false,
    starting: true,
    packetCount: 0,
    byteCount: 0,
    lastPacketAt: 0,
    sourceHandle: captureTarget,
    startedAt: Date.now(),
  };
  diagnostic("process-audio-start", {
    captureId,
    sourceHandle: captureTarget,
    processId: processMode ? processId : undefined,
    executable: path.basename(executable),
  });
  const child = spawn(
    executable,
    processMode
      ? ["--capture-process", String(processId)]
      : ["--capture-window", windowHandle],
    {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
  audioCaptureProcess = child;
  let flowReported = false;
  const audioPacketDecoder = new AudioPacketDecoder((packet) => {
    if (audioCaptureProcess === child && mainWindow && !mainWindow.isDestroyed()) {
      audioCaptureState.packetCount += 1;
      audioCaptureState.byteCount += packet.pcm.length;
      audioCaptureState.lastPacketAt = Date.now();
      if (!flowReported) {
        flowReported = true;
        diagnostic("process-audio-flow", {
          captureId,
          sampleRate: packet.sampleRate,
          firstPacketBytes: packet.pcm.length,
        });
        sendProcessAudioStatus({
          type: "flow",
          captureId,
          packetCount: audioCaptureState.packetCount,
          byteCount: audioCaptureState.byteCount,
        });
      }
      mainWindow.webContents.send("capture:audio-data", {
        ...packet,
        captureId,
      });
    }
  });
  child.stdout.on("data", (chunk) => {
    if (audioCaptureProcess === child) audioPacketDecoder.push(chunk);
  });

  let stderrBuffer = "";
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        stopProcessAudioCapture(captureId, "startup-timeout");
        reject(new Error("窗口声音采集启动超时"));
      }
    }, 8_000);

    const finish = (error, status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        audioCaptureState = {
          ...audioCaptureState,
          active: false,
          starting: false,
          lastError: error.message,
        };
        stopProcessAudioCapture(captureId, "startup-failed");
        reject(error);
      } else {
        resolve(status);
      }
    };

    let runtimeErrorMessage = "";
    child.on("error", (error) => {
      const wrapped = new Error(`无法启动窗口声音采集：${error.message}`);
      if (!settled) {
        finish(wrapped);
        return;
      }
      if (audioCaptureProcess === child) {
        runtimeErrorMessage = wrapped.message;
        audioCaptureProcess = undefined;
        audioCaptureState = {
          ...audioCaptureState,
          active: false,
          starting: false,
          lastError: wrapped.message,
        };
        diagnostic("process-audio-runtime-error", {
          captureId,
          message: wrapped.message,
        });
        sendProcessAudioStatus({
          type: "error",
          captureId,
          message: wrapped.message,
        });
      }
    });
    child.on("exit", (code) => {
      const startupComplete = settled;
      const unexpected = audioCaptureProcess === child;
      if (unexpected) {
        audioCaptureProcess = undefined;
        audioCaptureState = {
          ...audioCaptureState,
          active: false,
          starting: false,
          stoppedAt: Date.now(),
          exitCode: code,
        };
      }
      if (!settled) {
        finish(new Error(`窗口声音采集意外退出（${code ?? "未知"}）`));
      }
      if (unexpected && startupComplete && !runtimeErrorMessage) {
        const message =
          code === 0
            ? "所选播放器窗口或声音进程已经结束"
            : `窗口声音采集意外退出（${code ?? "未知"}）`;
        audioCaptureState.lastError = message;
        diagnostic("process-audio-unexpected-exit", {
          captureId,
          code,
          packetCount: audioCaptureState.packetCount,
          byteCount: audioCaptureState.byteCount,
        });
        sendProcessAudioStatus({
          type: "error",
          captureId,
          code,
          message,
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        let status;
        try {
          status = JSON.parse(line);
        } catch {
          status = { type: "error", message: line.trim() };
        }
        const enrichedStatus = { ...status, captureId };
        sendProcessAudioStatus(enrichedStatus);
        if (status.type === "window") {
          latestCaptureWindow = enrichedStatus;
          updateOverlayBounds();
        }
        if (status.type === "ready") {
          audioCaptureState = {
            ...audioCaptureState,
            active: true,
            starting: false,
            processId: Number(status.processId) || undefined,
            sampleRate: Number(status.sampleRate) || undefined,
            channels: Number(status.channels) || undefined,
            bitsPerSample: Number(status.bitsPerSample) || undefined,
            latencyMs: Number(status.latencyMs) || undefined,
          };
          diagnostic("process-audio-ready", {
            captureId,
            processId: audioCaptureState.processId,
            sampleRate: audioCaptureState.sampleRate,
            channels: audioCaptureState.channels,
            bitsPerSample: audioCaptureState.bitsPerSample,
            latencyMs: audioCaptureState.latencyMs,
          });
          finish(undefined, enrichedStatus);
        } else if (status.type === "error") {
          runtimeErrorMessage = status.message || "窗口声音采集失败";
          audioCaptureState = {
            ...audioCaptureState,
            active: false,
            starting: false,
            lastError: runtimeErrorMessage,
          };
          finish(new Error(status.message || "窗口声音采集失败"));
        }
      }
    });
  });
}

app.whenReady().then(() => {
  initialiseDiagnosticLog();
  ipcMain.on("channel-owner:load", (event) => {
    event.returnValue = isMainRenderer(event.sender)
      ? loadSecureChannelOwnership()
      : undefined;
  });
  ipcMain.on("channel-owner:save", (event, value) => {
    event.returnValue = isMainRenderer(event.sender)
      ? saveSecureChannelOwnership(value)
      : false;
  });
  ipcMain.handle("permission:request-media", async (event, kind) => {
    assertMainRenderer(event);
    if (kind !== "microphone") return false;
    if (microphonePermissionSessionActive) return true;
    const userActivated = await event.sender
      .executeJavaScript(
        "Boolean(navigator.userActivation?.isActive)",
        true,
      )
      .catch(() => false);
    if (!userActivated) return false;
    grantMediaPermissionIntent("microphone", 4);
    return true;
  });
  ipcMain.on("permission:release-media", (event, kind) => {
    if (!isMainRenderer(event.sender) || kind !== "microphone") return;
    microphonePermissionSessionActive = false;
    if (mediaPermissionIntent?.kind === "microphone") {
      mediaPermissionIntent = undefined;
    }
  });
  screen.on("display-added", updateOverlayBounds);
  screen.on("display-removed", updateOverlayBounds);
  screen.on("display-metrics-changed", updateOverlayBounds);
  const embyServiceOptions = {
    version: app.getVersion(),
    deviceId: persistentEmbyDeviceId(),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    cacheDir: path.join(app.getPath("userData"), "emby-segment-cache"),
    sendEvent: (payload) => {
      sendEmbyStreamEvent(payload);
      diagnostic("emby-stream-event", {
        type: payload?.type,
        pipelineId: payload?.pipelineId,
        sequence: payload?.sequence,
        bytes: payload?.data?.length,
        method: payload?.plan?.method,
        videoCodec: payload?.plan?.videoCodec,
        audioCodec: payload?.plan?.audioCodec,
        videoBitDepth: payload?.plan?.video?.bitDepth,
        videoProfile: payload?.plan?.video?.profile,
        width: payload?.plan?.width,
        height: payload?.plan?.height,
        bitrate: payload?.plan?.bitrate,
        message: payload?.message,
      });
    },
  };
  embyAccounts = new EmbyAccountManager({
    createService: () => new EmbyService(embyServiceOptions),
    storagePath: path.join(app.getPath("userData"), "emby-accounts.v1.json"),
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(value),
  });
  diagnostic("app-ready", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    executable: process.execPath,
    audioHelperExists: fs.existsSync(audioHelperPath()),
  });
  protocol.handle("synced-resource", async (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname)
      .replace(/^\/+/, "")
      .replaceAll("\\", "/");
    if (
      !/^models\/deepfilternet3\/v3\/(?:pkg\/df_bg\.wasm|models\/DeepFilterNet3_onnx\.tar\.gz)$/.test(
        relativePath,
      )
    ) {
      return new Response("Not found", { status: 404 });
    }
    const resourceRoot = app.isPackaged
      ? path.resolve(process.resourcesPath)
      : path.resolve(__dirname, "..", "dist-renderer");
    const resourcePath = path.resolve(resourceRoot, relativePath);
    if (!resourcePath.startsWith(`${resourceRoot}${path.sep}`)) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const bytes = await fs.promises.readFile(resourcePath);
      return new Response(bytes, {
        headers: {
          "content-type": relativePath.endsWith(".wasm")
            ? "application/wasm"
            : "application/gzip",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient("synced");
  } else if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient("synced", process.execPath, [path.resolve(process.argv[1])]);
  }
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        request.frame !== mainWindow.webContents.mainFrame ||
        (!captureActive && !hasMediaPermissionIntent("display"))
      ) {
        diagnostic("display-source-rejected", { reason: "untrusted-renderer" });
        callback({});
        return;
      }
      consumeMediaPermissionIntent("display");
      const source = await findSelectedSource();
      if (!source) {
        diagnostic("display-source-missing", {
          selectedName: selectedSource?.name,
          selectedHandle: selectedSource?.windowHandle,
        });
        callback({});
        return;
      }
      selectedSource = {
        ...selectedSource,
        id: source.id,
        name: source.name,
        windowHandle: sourceHandle(source.id),
      };
      diagnostic("display-source-granted", {
        name: source.name,
        windowHandle: selectedSource.windowHandle,
        processId: selectedSource.processId,
      });
      callback({ video: source });
    } catch (error) {
      diagnostic("display-source-error", {
        message: error instanceof Error ? error.message : String(error),
      });
      callback({});
    }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    if (!isMainRenderer(webContents)) return false;
    if (permission === "fullscreen") return true;
    if (permission === "display-capture") {
      return captureActive || hasMediaPermissionIntent("display");
    }
    if (permission === "media") {
      const mediaTypes = Array.isArray(details?.mediaTypes)
        ? details.mediaTypes
        : [];
      if (mediaTypes.includes("audio")) {
        if (hasMediaPermissionIntent("microphone")) {
          microphonePermissionSessionActive = true;
        }
        return (
          microphonePermissionSessionActive ||
          hasMediaPermissionIntent("microphone")
        );
      }
      return hasMediaPermissionIntent("display");
    }
    return false;
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!isMainRenderer(webContents)) {
      callback(false);
      return;
    }
    if (permission === "fullscreen") {
      callback(true);
      return;
    }
    if (permission === "display-capture") {
      callback(
        captureActive || consumeMediaPermissionIntent("display"),
      );
      return;
    }
    if (permission === "media") {
      const mediaTypes = Array.isArray(details?.mediaTypes)
        ? details.mediaTypes
        : [];
      if (mediaTypes.includes("audio")) {
        const granted =
          microphonePermissionSessionActive ||
          consumeMediaPermissionIntent("microphone");
        microphonePermissionSessionActive = granted;
        callback(granted);
      } else {
        callback(consumeMediaPermissionIntent("display"));
      }
      return;
    }
    callback(false);
  });

  ipcMain.handle("capture:list-sources", async (event, options) => {
    assertMainRenderer(event);
    const withThumbnails = options?.thumbnails !== false;
    const includeAudioProcesses = options?.audioProcesses === true;
    const lightweightAudioList = includeAudioProcesses && !withThumbnails;
    const knownMusicProcessesPromise = includeAudioProcesses
      ? inspectKnownMusicProcesses()
      : Promise.resolve([]);
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: withThumbnails
        ? { width: 320, height: 180 }
        : { width: 0, height: 0 },
      fetchWindowIcons: withThumbnails,
    });
    const visibleSources = sources
      .filter(
        (source) =>
          source.id.startsWith("window:") &&
          source.name.trim() &&
          (!mainWindow || source.name !== mainWindow.getTitle()),
      )
      .sort((left, right) =>
        left.name.localeCompare(right.name, "zh-CN", {
          numeric: true,
          sensitivity: "base",
        }),
      );
    // The music popover needs names, not a process lookup for every open
    // window. A selected window is inspected once by capture:select-source.
    const processByHandle = lightweightAudioList
      ? new Map()
      : await inspectWindowProcesses(
          visibleSources.map((source) => source.id),
        );
    const sourceDetails = visibleSources.map((source) => {
      const processInfo = processByHandle.get(sourceHandle(source.id));
      return {
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.isEmpty() ? undefined : source.thumbnail.toDataURL(),
        appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : undefined,
        processId: processInfo?.processId,
        processName: processInfo?.processName,
        executableName: processInfo?.executableName,
      };
    });
    if (includeAudioProcesses) {
      const existingProcessIds = new Set(
        sourceDetails
          .map((source) => Number(source.processId))
          .filter((processId) => Number.isSafeInteger(processId) && processId > 0),
      );
      for (const processInfo of await knownMusicProcessesPromise) {
        const processId = Number(processInfo.processId);
        if (existingProcessIds.has(processId)) continue;
        const processName = String(processInfo.processName || "");
        sourceDetails.push({
          id: `process:${processId}`,
          name: processName,
          thumbnail: undefined,
          appIcon: undefined,
          processId,
          processName,
          executableName: processInfo.executableName,
        });
      }
    }
    sourceDetails.sort((left, right) => {
      const processOrder =
        Number(right.id.startsWith("process:")) -
        Number(left.id.startsWith("process:"));
      if (processOrder !== 0) return processOrder;
      return left.name.localeCompare(right.name, "zh-CN", {
        numeric: true,
        sensitivity: "base",
      });
    });
    diagnostic("capture-sources-listed", { count: sourceDetails.length });
    return sourceDetails;
  });

  ipcMain.handle("capture:select-source", async (event, sourceId) => {
    assertMainRenderer(event);
    if (typeof sourceId !== "string") {
      throw new Error("无效的窗口来源");
    }
    const processMatch = sourceId.match(/^process:(\d{1,10})$/);
    if (processMatch) {
      const requestedProcessId = Number(processMatch[1]);
      const processInfo = (await inspectKnownMusicProcesses()).find(
        (entry) => Number(entry.processId) === requestedProcessId,
      );
      if (!processInfo) {
        throw new Error("音乐应用已经退出，请重新选择");
      }
      selectedSource = {
        id: sourceId,
        name: String(processInfo.processName || "音乐应用"),
        processId: requestedProcessId,
      };
      grantMediaPermissionIntent("display", 8);
      diagnostic("capture-process-selected", {
        name: selectedSource.name,
        processId: requestedProcessId,
      });
      return selectedSource;
    }
    if (!sourceId.startsWith("window:")) {
      throw new Error("无效的窗口来源");
    }
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const requestedHandle = sourceHandle(sourceId);
    const source =
      sources.find((candidate) => candidate.id === sourceId) ||
      sources.find(
        (candidate) =>
          requestedHandle && sourceHandle(candidate.id) === requestedHandle,
      );
    if (!source) {
      diagnostic("capture-source-closed", {
        sourceId,
        requestedHandle,
      });
      throw new Error("窗口已经关闭，请重新选择");
    }
    const selectedProcessInfo = (
      await inspectWindowProcesses([source.id])
    ).get(sourceHandle(source.id));
    selectedSource = {
      id: source.id,
      name: source.name,
      windowHandle: sourceHandle(source.id),
      processId:
        Number(selectedProcessInfo?.processId) || undefined,
      processName: selectedProcessInfo?.processName,
      executableName: selectedProcessInfo?.executableName,
      className: selectedProcessInfo?.className,
      ownerHandle: selectedProcessInfo?.ownerHandle,
    };
    grantMediaPermissionIntent("display", 8);
    diagnostic("capture-source-selected", {
        name: source.name,
        windowHandle: selectedSource.windowHandle,
        processId: selectedSource.processId,
    });
    lastCaptureHealthDeepInspectAt = 0;
    return selectedSource;
  });

  ipcMain.handle("capture:get-source-health", async (event) => {
    assertMainRenderer(event);
    if (!selectedSource || !selectedSource.id.startsWith("window:")) {
      return {
        available: false,
        activity: 0,
        changed: false,
      };
    }
    const selectedId = selectedSource.id;
    const now = Date.now();
    const forceProcessInspection =
      now - lastCaptureHealthDeepInspectAt >= 7_500;
    if (forceProcessInspection) {
      lastCaptureHealthDeepInspectAt = now;
    }
    const source = await findSelectedSource({ forceProcessInspection });
    if (!source) {
      return {
        available: false,
        activity: 0,
        changed: false,
        selectedId,
      };
    }
    const windowState = captureWindowHealthSnapshot();
    return {
      available: true,
      activity: sourceVisualActivity(source),
      changed: source.id !== selectedId,
      selectedId,
      sourceId: source.id,
      name: source.name,
      ...(windowState || {}),
    };
  });

  ipcMain.handle("capture:start-process-audio", async (event) => {
    assertMainRenderer(event);
    if (process.platform !== "win32") {
      throw new Error("按窗口采集声音目前仅支持 Windows");
    }
    return startProcessAudioCapture();
  });
  ipcMain.handle("capture:get-process-audio-status", (event) => {
    assertMainRenderer(event);
    return processAudioStatusSnapshot();
  });
  ipcMain.handle("network:ensure-portable-firewall", (event) => {
    assertMainRenderer(event);
    return ensurePortableFirewallRules();
  });
  ipcMain.handle("clipboard:write", (event, value) => {
    assertMainRenderer(event);
    const text = String(value || "");
    if (!text) throw new Error("没有可复制的内容");
    if (text.length > 16_384) throw new Error("复制内容过长");
    clipboard.writeText(text);
  });
  ipcMain.handle("clipboard:read", (event) => {
    assertMainRenderer(event);
    return clipboard.readText().slice(0, 16_384);
  });
  ipcMain.handle("system:get-display-info", (event) => {
    assertMainRenderer(event);
    const display = screen.getPrimaryDisplay();
    const scale = Number(display.scaleFactor) || 1;
    const physicalWidth =
      Math.round((display.size.width * scale) / 8) * 8;
    const physicalHeight =
      Math.round((display.size.height * scale) / 8) * 8;
    const colorSpace = String(display.colorSpace || "");
    const depthPerComponent = Number(display.depthPerComponent) || 8;
    return {
      width: physicalWidth,
      height: physicalHeight,
      refreshRate: Number(display.displayFrequency) || 60,
      scaleFactor: scale,
      colorSpace,
      depthPerComponent,
      hdr:
        depthPerComponent > 8 ||
        /BT2020|PQ|HLG|SCRGB/i.test(colorSpace),
    };
  });
  ipcMain.handle("system:open-display-settings", (event) => {
    assertMainRenderer(event);
    return shell.openExternal("ms-settings:display");
  });
  ipcMain.handle("emby:login", (event, input) => {
    assertMainRenderer(event);
    return embyAccounts.login(input);
  });
  ipcMain.handle("emby:logout", (event) => {
    assertMainRenderer(event);
    return embyAccounts.removeActive();
  });
  ipcMain.handle("emby:accounts", (event) => {
    assertMainRenderer(event);
    return embyAccounts.state();
  });
  ipcMain.handle("emby:activate-account", (event, accountId) => {
    assertMainRenderer(event);
    return embyAccounts.activate(accountId);
  });
  ipcMain.handle("emby:update-endpoints", (event, accountId, input) => {
    assertMainRenderer(event);
    return embyAccounts.updateEndpoints(accountId, input);
  });
  ipcMain.handle("emby:search-all", (event, input) => {
    assertMainRenderer(event);
    return embyAccounts.searchAll(input);
  });
  ipcMain.handle("emby:list-views", (event, input) => {
    assertMainRenderer(event);
    return embyAccounts.listViews(input);
  });
  ipcMain.handle("emby:list-items", (event, input) => {
    assertMainRenderer(event);
    return embyAccounts.listItems(input);
  });
  ipcMain.handle("emby:image-data", (event, input) => {
    assertMainRenderer(event);
    return embyAccounts.imageData(input);
  });
  ipcMain.handle("emby:playback-info", (event, input) => {
    assertMainRenderer(event);
    return embyAccounts.playbackInfo(input);
  });
  ipcMain.handle("emby:start-stream", (event, input) => {
    assertMainRenderer(event);
    return embyAccounts.startStream(input);
  });
  ipcMain.handle("emby:stop-stream", (event, reason, expectedPipelineId) => {
    assertMainRenderer(event);
    return embyAccounts.stopStream(reason, expectedPipelineId);
  });
  ipcMain.handle(
    "emby:set-flow-paused",
    (event, command) => {
      assertMainRenderer(event);
      return embyAccounts.setFlowPaused(
        command?.paused === true,
        command?.pipelineId,
        command?.generation,
      );
    },
  );
  ipcMain.handle("emby:get-flow-state", (event, expectedPipelineId) => {
    assertMainRenderer(event);
    return embyAccounts.getFlowState(expectedPipelineId);
  });
  ipcMain.handle("emby:update-segment-relay", (event, input) => {
    assertMainRenderer(event);
    return embyAccounts.updateSegmentRelayAccess(input);
  });
  ipcMain.handle("emby:update-rendition-demand", (event, input) => {
    assertMainRenderer(event);
    return embyAccounts.updateRenditionDemand(input);
  });
  ipcMain.handle("emby:report-playback", (event, input) => {
    assertMainRenderer(event);
    return embyAccounts.reportPlayback(input);
  });
  ipcMain.on("diagnostic:event", (ipcEvent, event, detail) => {
    if (!isMainRenderer(ipcEvent.sender)) return;
    if (typeof event !== "string" || event.length > 80) return;
    let boundedDetail = detail;
    try {
      const serialized = JSON.stringify(detail);
      boundedDetail =
        serialized && serialized.length <= 8_192
          ? JSON.parse(serialized)
          : { discarded: "diagnostic detail too large" };
    } catch {
      boundedDetail = { discarded: "diagnostic detail is not serializable" };
    }
    diagnostic(`renderer-${event}`, boundedDetail);
  });
  ipcMain.handle("capture:stop-process-audio", (event, captureId) => {
    assertMainRenderer(event);
    const requestedCaptureId =
      captureId === undefined ? undefined : Number(captureId);
    if (
      requestedCaptureId !== undefined &&
      !Number.isSafeInteger(requestedCaptureId)
    ) {
      throw new Error("窗口声音采集会话编号无效");
    }
    stopProcessAudioCapture(requestedCaptureId, "renderer-request");
  });
  ipcMain.handle("capture:set-active", (event, active) => {
    assertMainRenderer(event);
    if (active) {
      if (powerBlockerId === undefined) {
        powerBlockerId = powerSaveBlocker.start("prevent-display-sleep");
      }
      captureActive = true;
      ensureOverlayWindow();
      updateOverlayBounds();
    } else {
      if (powerBlockerId !== undefined) {
        if (powerSaveBlocker.isStarted(powerBlockerId)) {
          powerSaveBlocker.stop(powerBlockerId);
        }
        powerBlockerId = undefined;
      }
      stopProcessAudioCapture();
      selectedSource = undefined;
      captureActive = false;
      latestCaptureWindow = undefined;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("overlay:clear");
      }
      updateOverlayBounds();
    }
  });
  ipcMain.on("overlay:set-desktop-active", (event, active) => {
    if (!isMainRenderer(event.sender)) return;
    const nextActive = active === true;
    if (desktopDanmakuActive === nextActive) {
      updateOverlayBounds();
      return;
    }
    desktopDanmakuActive = nextActive;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("overlay:clear");
    }
    if (desktopDanmakuActive) {
      ensureOverlayWindow();
    }
    updateOverlayBounds();
  });
  ipcMain.on("overlay:danmaku", (event, message) => {
    if (!isMainRenderer(event.sender)) return;
    if (
      (!captureActive && !desktopDanmakuActive) ||
      !message ||
      typeof message !== "object"
    ) {
      return;
    }
    const nickname = String(message.nickname || "").trim().slice(0, 16);
    const text = String(message.text || "").trim().slice(0, 120);
    if (!nickname || !text) {
      return;
    }
    sendToOverlay("overlay:danmaku", {
      nickname,
      text,
      mine: message.mine === true,
    });
  });
  ipcMain.on("overlay:clear", (event) => {
    if (!isMainRenderer(event.sender)) return;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("overlay:clear");
    }
  });
  ipcMain.on("window:set-mini-window-enabled", (event, enabled) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event.sender !== mainWindow.webContents
    ) {
      return;
    }
    miniWindowEnabled = enabled === true;
    diagnostic("mini-window-preference", { enabled: miniWindowEnabled });
  });
  ipcMain.handle("window:restore-from-picture-in-picture", (event) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event.sender !== mainWindow.webContents
    ) {
      throw new Error("主窗口当前不可用");
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });
  ipcMain.handle("game:view-open", (event, bounds) => {
    assertMainRenderer(event);
    showGameView(bounds);
    return { url: GAME_URL };
  });
  ipcMain.handle("game:view-set-bounds", (event, bounds) => {
    assertMainRenderer(event);
    if (gameView && gameViewAttached && !gameView.webContents.isDestroyed()) {
      gameView.setBounds(normalizeGameViewBounds(bounds));
    }
  });
  ipcMain.on("game:view-hide", (event) => {
    assertMainRenderer(event);
    hideGameView();
  });
  ipcMain.handle("game:view-reload", (event) => {
    assertMainRenderer(event);
    if (!gameView || gameView.webContents.isDestroyed()) return false;
    gameView.webContents.reloadIgnoringCache();
    return true;
  });
  ipcMain.handle("game:view-back", (event) => {
    assertMainRenderer(event);
    if (!gameView || gameView.webContents.isDestroyed()) return false;
    const navigation = gameView.webContents.navigationHistory;
    if (!navigation.canGoBack()) return false;
    navigation.goBack();
    return true;
  });
  ipcMain.handle("app:get-version", (event) => {
    assertMainRenderer(event);
    return app.getVersion();
  });
  ipcMain.handle("app:get-network-info", (event) => {
    assertMainRenderer(event);
    const addresses = [];
    const virtualInterfaces = new Set();
    for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
          const virtual =
            /virtual|vmware|vethernet|hyper-v|wsl|loopback|wireguard|openvpn|sing-box|shadowsocks|(?:^|\b)(?:tun\d*|tap\d*|wg\d*|vpn|meta|clash|mihomo|wintun|tailscale|zerotier|v2ray|xray)(?:\b|$)/i.test(
              interfaceName,
            ) ||
            /^198\.(?:18|19)\./.test(entry.address);
          if (virtual) {
            virtualInterfaces.add(interfaceName);
            continue;
          }
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
    return {
      lanAddresses,
      hasVirtualTunnel: virtualInterfaces.size > 0,
      virtualInterfaces: [...virtualInterfaces],
    };
  });

  // Desktop clients always use the hardened public service. The only
  // production standby is the signalling-only Alibaba Cloud node; the app
  // must never open a local signalling listener.
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("second-instance", (_event, commandLine) => {
  const url = commandLine.find(isInviteUrl);
  if (url && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:open-url", url);
  } else if (url) {
    pendingOpenUrl = url;
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:open-url", url);
  } else {
    pendingOpenUrl = url;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  stopProcessAudioCapture();
  stopDanmakuOverlay();
  overlayWindow?.destroy();
  overlayWindow = undefined;
  const accountsToDestroy = embyAccounts;
  embyAccounts = undefined;
  void Promise.allSettled([
    accountsToDestroy?.destroy(),
  ])
    .then(() => flushDiagnosticLog())
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
