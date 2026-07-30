"use strict";

const { randomInt } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const WebSocket = require("ws");

const EXPECTED_VERSION = "2.9.1";
const projectRoot = path.join(__dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const portablePath =
  process.env.SYNCED_EMBY_FIELD_EXE ||
  path.join(
    projectRoot,
    "release",
    "windows-dist",
    `Synced-${EXPECTED_VERSION}-portable.exe`,
  );
const debugPort = Number(process.env.SYNCED_EMBY_FIELD_PORT || 9349);
const playbackDurationMs = Math.max(
  30_000,
  Number(process.env.SYNCED_EMBY_FIELD_PLAYBACK_MS || 30_000),
);
const artifactStamp = new Date().toISOString().replace(/[:.]/gu, "-");
const artifactDirectory = path.join(projectRoot, "release", "field-tests");
const screenshotPath = path.join(
  artifactDirectory,
  `emby-${EXPECTED_VERSION}-${artifactStamp}.jpg`,
);
const reportPath = path.join(
  artifactDirectory,
  `emby-${EXPECTED_VERSION}-${artifactStamp}.json`,
);
const searchProbe = "__synced_2_9_1_field_probe_no_match__";
const CDP_CONNECT_TIMEOUT_MS = 8_000;
const CDP_COMMAND_TIMEOUT_MS = 6_000;
const CDP_SHUTDOWN_TIMEOUT_MS = 1_500;

class FieldTestFault extends Error {
  constructor(classification, stage, outcome = "failed") {
    super(classification);
    this.classification = classification;
    this.stage = stage;
    this.outcome = outcome;
  }
}

class CdpTransportFault extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fault(classification, stage, outcome = "failed") {
  throw new FieldTestFault(classification, stage, outcome);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("invalid-cdp-response"));
        }
      });
    });
    request.once("error", reject);
    request.setTimeout(1_000, () =>
      request.destroy(new Error("cdp-request-timeout")),
    );
  });
}

async function debugPortIsOccupied() {
  try {
    await requestJson(`http://127.0.0.1:${debugPort}/json/version`);
    return true;
  } catch {
    return false;
  }
}

async function waitForPage(timeoutMs = 50_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await requestJson(
        `http://127.0.0.1:${debugPort}/json/list`,
      );
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          typeof target.webSocketDebuggerUrl === "string",
      );
      if (page) return page;
    } catch {
      // The portable launcher can spend several seconds extracting itself.
    }
    await delay(200);
  }
  fault("portable-cdp-start-timeout", "portable-launch");
}

function createCdp(
  webSocketUrl,
  {
    connectTimeoutMs = CDP_CONNECT_TIMEOUT_MS,
    commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS,
  } = {},
) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();

  const rejectPending = (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new CdpTransportFault(code));
    }
    pending.clear();
  };

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(new CdpTransportFault("cdp-command-rejected"));
    }
    else waiter.resolve(message.result);
  });
  socket.on("error", () => rejectPending("cdp-connection-error"));
  socket.on("close", () => rejectPending("cdp-connection-closed"));

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      callback(value);
    };
    const onOpen = () => finish(resolve);
    const onError = () =>
      finish(reject, new CdpTransportFault("cdp-connect-failed"));
    const onClose = () =>
      finish(reject, new CdpTransportFault("cdp-connect-closed"));
    const timer = setTimeout(() => {
      finish(reject, new CdpTransportFault("cdp-connect-timeout"));
      socket.terminate();
    }, Math.max(250, finite(connectTimeoutMs, CDP_CONNECT_TIMEOUT_MS)));
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });

  const client = {
    socket,
    ready,
    get pendingCount() {
      return pending.size;
    },
    send(method, params = {}, timeoutMs = commandTimeoutMs) {
      return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new CdpTransportFault("cdp-connection-unavailable"));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          const waiter = pending.get(id);
          if (!waiter) return;
          pending.delete(id);
          waiter.reject(new CdpTransportFault("cdp-command-timeout"));
        }, Math.max(250, finite(timeoutMs, commandTimeoutMs)));
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(
            JSON.stringify({ id, method, params }),
            (error) => {
              if (!error) return;
              const waiter = pending.get(id);
              if (!waiter) return;
              pending.delete(id);
              clearTimeout(waiter.timer);
              waiter.reject(new CdpTransportFault("cdp-send-failed"));
            },
          );
        } catch {
          const waiter = pending.get(id);
          pending.delete(id);
          clearTimeout(waiter?.timer);
          reject(new CdpTransportFault("cdp-send-failed"));
        }
      });
    },
    async shutdown(timeoutMs = CDP_SHUTDOWN_TIMEOUT_MS) {
      const boundedTimeout = Math.max(
        250,
        finite(timeoutMs, CDP_SHUTDOWN_TIMEOUT_MS),
      );
      if (socket.readyState === WebSocket.OPEN) {
        await client
          .send("Browser.close", {}, boundedTimeout)
          .catch(() => undefined);
      }
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = new Promise((resolve) => socket.once("close", resolve));
        if (socket.readyState === WebSocket.OPEN) socket.close();
        else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        await Promise.race([closed, delay(boundedTimeout)]);
      }
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      rejectPending("cdp-client-shutdown");
    },
  };
  return client;
}

async function stopLauncher(launcher) {
  if (!launcher || !Number.isInteger(launcher.pid) || launcher.pid < 1) return;
  if (launcher.exitCode !== null || launcher.signalCode !== null) return;

  if (process.platform === "win32") {
    spawnSync(
      "taskkill.exe",
      ["/PID", String(launcher.pid), "/T", "/F"],
      {
        windowsHide: true,
        stdio: "ignore",
        timeout: 5_000,
      },
    );
    return;
  }

  launcher.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => launcher.once("exit", () => resolve(true))),
    delay(1_500).then(() => false),
  ]);
  if (!exited && launcher.exitCode === null) launcher.kill("SIGKILL");
}

function captureLauncherWindow(launcher, outputPath) {
  if (
    process.platform !== "win32" ||
    !launcher ||
    !Number.isInteger(launcher.pid) ||
    launcher.pid < 1
  ) {
    return false;
  }
  const source = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SyncedFieldCapture {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  public static IntPtr FindVisibleWindow(uint processId) {
    IntPtr result = IntPtr.Zero;
    EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
      uint owner;
      GetWindowThreadProcessId(handle, out owner);
      if (owner == processId && IsWindowVisible(handle)) {
        result = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
$targetPid = [int]$env:SYNCED_FIELD_CAPTURE_PID
$target = Get-Process -Id $targetPid -ErrorAction Stop
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 100
  $target.Refresh()
  $handle = $target.MainWindowHandle
  if ($handle -eq 0) {
    $handle = [SyncedFieldCapture]::FindVisibleWindow([uint32]$targetPid)
  }
  if ($handle -ne 0) { break }
}
if ($handle -eq 0) { exit 2 }
[SyncedFieldCapture]::ShowWindow($handle, 9) | Out-Null
[SyncedFieldCapture]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 250
$rect = New-Object SyncedFieldCapture+Rect
if (-not [SyncedFieldCapture]::GetWindowRect($handle, [ref]$rect)) { exit 3 }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 1 -or $height -lt 1) { exit 4 }
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
  $bitmap.Save(
    $env:SYNCED_FIELD_SCREENSHOT,
    [System.Drawing.Imaging.ImageFormat]::Jpeg
  )
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`;
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      windowsHide: true,
      stdio: "ignore",
      timeout: 8_000,
      env: {
        ...process.env,
        SYNCED_FIELD_CAPTURE_PID: String(launcher.pid),
        SYNCED_FIELD_SCREENSHOT: outputPath,
      },
    },
  );
  return (
    result.status === 0 &&
    fs.existsSync(outputPath) &&
    fs.statSync(outputPath).size > 1_000
  );
}

function readPortableVersion() {
  if (process.platform !== "win32") return "";
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Item -LiteralPath $env:SYNCED_FIELD_PORTABLE_PATH).VersionInfo.ProductVersion",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        SYNCED_FIELD_PORTABLE_PATH: portablePath,
      },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    },
  );
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[
    Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))
  ];
}

function publicReport(base, update) {
  return {
    schemaVersion: 1,
    test: "portable-emby-field",
    portableVersion: EXPECTED_VERSION,
    generatedAt: new Date().toISOString(),
    ...base,
    ...update,
    reportPath,
  };
}

function writeReport(report) {
  fs.mkdirSync(artifactDirectory, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

async function main() {
  let stage = "preflight";
  let launcher;
  let cdp;
  const report = {
    ok: false,
    outcome: "failed",
    classification: "not-run",
    stage,
    account: {
      available: false,
      restored: false,
      savedCount: 0,
    },
    library: {
      loaded: false,
      candidateCount: 0,
      selectionAttempts: 0,
    },
    quality: {
      requested: "highest",
      selectedClass: "",
      optionCount: 0,
    },
    playbackStart: {
      broadcastOwned: false,
      startBusy: false,
      popupOpen: false,
      videoHidden: true,
      paused: true,
      readyState: 0,
      decodedFrames: 0,
      bufferedRanges: 0,
      bufferedAhead: 0,
      currentTime: 0,
      width: 0,
      height: 0,
      mediaErrorCode: 0,
      rendererErrors: 0,
      unhandledRejections: 0,
      dangerToastCount: 0,
    },
    playback: {
      requiredSeconds: playbackDurationMs / 1_000,
      observedSeconds: 0,
      decodedFramesDelta: 0,
      frameCallbacks: 0,
      currentTimeDelta: 0,
      readyStateMin: 0,
      bufferedAheadMin: 0,
      bufferedAheadMedian: 0,
      stalls: 0,
      waitingEvents: 0,
      mediaErrorCode: 0,
      width: 0,
      height: 0,
    },
    postStopSearch: {
      completed: false,
      probeResultCount: 0,
      restoredResultCount: 0,
      durationMs: 0,
    },
    screenshotPath: "",
    privacy: {
      accountFieldsRead: false,
      credentialStorageRead: false,
      mediaTitlesRead: false,
      mediaUrlsRead: false,
    },
  };

  try {
    if (packageJson.version !== EXPECTED_VERSION) {
      fault("package-version-mismatch", stage);
    }
    if (!fs.existsSync(portablePath)) {
      fault("portable-missing", stage);
    }
    const fileVersion = readPortableVersion();
    if (
      !fileVersion ||
      !new RegExp(`^${EXPECTED_VERSION.replaceAll(".", "\\.")}(?:\\.0)*$`, "u")
        .test(fileVersion)
    ) {
      fault("portable-version-mismatch", stage);
    }
    report.portableFileVersion = fileVersion;
    if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65_535) {
      fault("invalid-cdp-port", stage);
    }
    if (await debugPortIsOccupied()) {
      fault("cdp-port-in-use", stage);
    }

    stage = "portable-launch";
    launcher = spawn(
      portablePath,
      [`--remote-debugging-port=${debugPort}`],
      {
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          SYNCED_E2E: "1",
          SYNCED_E2E_VISIBLE: "1",
          SYNCED_SKIP_FIREWALL_REPAIR: "1",
        },
      },
    );
    // Keep a failed Windows process launch inside the sanitized classification
    // path instead of letting ChildProcess emit an uncaught error with paths.
    launcher.once("error", () => undefined);
    const page = await waitForPage();
    cdp = createCdp(page.webSocketDebuggerUrl);
    try {
      await cdp.ready;
    } catch (error) {
      fault(
        error?.code === "cdp-connect-timeout"
          ? "portable-cdp-connect-timeout"
          : "portable-cdp-connect-failed",
        stage,
      );
    }

    const sendCdp = async (
      method,
      params = {},
      timeoutMs = CDP_COMMAND_TIMEOUT_MS,
    ) => {
      try {
        return await cdp.send(method, params, timeoutMs);
      } catch (error) {
        fault(
          error?.code === "cdp-command-timeout"
            ? "renderer-unresponsive"
            : "cdp-transport-failed",
          stage,
        );
      }
    };

    const captureEvidence = async () => {
      fs.mkdirSync(artifactDirectory, { recursive: true });
      try {
        const screenshot = await cdp.send(
          "Page.captureScreenshot",
          {
            format: "jpeg",
            quality: 76,
            optimizeForSpeed: true,
            fromSurface: true,
            captureBeyondViewport: false,
          },
          3_500,
        );
        if (screenshot?.data) {
          fs.writeFileSync(
            screenshotPath,
            Buffer.from(screenshot.data, "base64"),
          );
          return true;
        }
      } catch {
        // Some GPU-backed video surfaces do not answer CDP screenshots while
        // decoding. Fall back to the composed Windows application window.
      }
      return captureLauncherWindow(launcher, screenshotPath);
    };

    await sendCdp("Runtime.enable");
    await sendCdp("Page.enable");

    const evaluate = async (expression) => {
      const result = await sendCdp(
        "Runtime.evaluate",
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
        CDP_COMMAND_TIMEOUT_MS,
      );
      if (result.exceptionDetails) {
        fault("renderer-evaluation-failed", stage);
      }
      return result.result?.value;
    };

    const waitFor = async (expression, timeoutMs, classification) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const value = await evaluate(expression);
        if (value) return value;
        await delay(180);
      }
      fault(classification, stage);
    };

    const trustedClick = async (selector, index = 0) => {
      const point = await evaluate(`(() => {
        const candidates = [...document.querySelectorAll(${JSON.stringify(
          selector,
        )})].filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== "hidden" &&
            style.display !== "none" &&
            rect.width > 0 &&
            rect.height > 0 &&
            !element.disabled;
        });
        const element = candidates[${Number(index)}];
        if (!element) return undefined;
        element.scrollIntoView({ block: "center", inline: "center" });
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      if (!point) fault("ui-control-unavailable", stage);
      await sendCdp("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      await sendCdp("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
    };

    const setKnownInput = async (selector, value) =>
      evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return false;
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);

    stage = "channel-entry";
    await waitFor(
      "Boolean(document.querySelector('#choose-host') || document.querySelector('#broadcast-action'))",
      30_000,
      "application-ui-timeout",
    );
    const inChannel = await evaluate(
      "Boolean(document.querySelector('#broadcast-action'))",
    );
    if (!inChannel) {
      await trustedClick("#choose-host");
      await waitFor(
        "Boolean(document.querySelector('#start-share'))",
        10_000,
        "host-setup-timeout",
      );
      await evaluate(`(() => {
        const nickname = document.querySelector("#host-nickname");
        const channel = document.querySelector("#channel-name");
        if (nickname && !nickname.value.trim()) nickname.value = "2.9.1 实地验收";
        if (channel && !channel.value.trim()) channel.value = "Emby 实地验收";
        nickname?.dispatchEvent(new Event("input", { bubbles: true }));
        channel?.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);
      await trustedClick("#start-share");
    }
    await waitFor(
      `(() => {
        const action = document.querySelector("#broadcast-action");
        const stageStart = document.querySelector("#stage-start-broadcast");
        return Boolean(
          (stageStart && !stageStart.hidden && !stageStart.disabled) ||
          (action && !action.hidden && !action.disabled &&
            action.classList.contains("active"))
        );
      })()`,
      35_000,
      "channel-connect-failed",
    );
    const resumedOwnBroadcast = await evaluate(
      `(() => {
        const action = document.querySelector("#broadcast-action");
        return Boolean(
          action &&
          !action.hidden &&
          action.classList.contains("active") &&
          action.textContent?.includes("停止")
        );
      })()`,
    );
    if (resumedOwnBroadcast) {
      await trustedClick("#broadcast-action");
      await waitFor(
        `(() => {
          const action = document.querySelector("#broadcast-action");
          const stageStart = document.querySelector("#stage-start-broadcast");
          return Boolean(
            action &&
            (action.hidden || !action.classList.contains("active")) &&
            stageStart &&
            !stageStart.hidden
          );
        })()`,
        15_000,
        "existing-broadcast-stop-failed",
      );
    }

    stage = "account-restore";
    // Before a broadcast starts the compact header action intentionally stays
    // hidden; the empty-stage action is the visible entry point. The selector
    // keeps supporting an already active header layout without trying to click
    // the hidden duplicate.
    await trustedClick("#stage-start-broadcast, #broadcast-action");
    await waitFor(
      "document.querySelector('#broadcast-dialog')?.open === true",
      10_000,
      "broadcast-dialog-timeout",
    );
    await trustedClick("#emby-mode-tab");
    await delay(5_000);

    let accountState = await evaluate(`(() => ({
      savedCount: document.querySelectorAll("[data-emby-account]").length,
      libraryVisible:
        document.querySelector("#emby-library-panel")?.hidden === false
    }))()`);
    report.account.savedCount = finite(accountState?.savedCount);
    if (!accountState?.libraryVisible && report.account.savedCount > 0) {
      await trustedClick("[data-emby-account]");
      await delay(1_000);
    }
    if (!accountState?.libraryVisible && report.account.savedCount === 0) {
      fault("saved-account-missing", stage, "skipped");
    }
    try {
      accountState = await waitFor(
        `(() => {
          const savedCount =
            document.querySelectorAll("[data-emby-account]").length;
          const libraryVisible =
            document.querySelector("#emby-library-panel")?.hidden === false;
          return libraryVisible ? { savedCount, libraryVisible } : false;
        })()`,
        20_000,
        "saved-account-restore-failed",
      );
    } catch (error) {
      const savedCount = await evaluate(
        'document.querySelectorAll("[data-emby-account]").length',
      );
      if (finite(savedCount) === 0) {
        fault("saved-account-missing", stage, "skipped");
      }
      throw error;
    }
    report.account.available = true;
    report.account.restored = true;
    report.account.savedCount = finite(accountState.savedCount);

    stage = "library-load";
    let libraryState;
    const libraryDeadline = Date.now() + 45_000;
    while (Date.now() < libraryDeadline) {
      libraryState = await evaluate(`(() => ({
        itemCount: document.querySelectorAll("[data-emby-item]").length,
        failed:
          document.querySelector("#emby-library-status")
            ?.classList.contains("error") === true
      }))()`);
      if (libraryState?.itemCount > 0) break;
      if (libraryState?.failed) {
        await trustedClick("#emby-refresh-library");
        await delay(3_000);
      } else {
        await delay(350);
      }
    }
    report.library.candidateCount = finite(libraryState?.itemCount);
    if (report.library.candidateCount < 1) {
      fault(
        libraryState?.failed
          ? "external-media-library-unavailable"
          : "external-media-library-empty",
        stage,
        libraryState?.failed ? "failed" : "skipped",
      );
    }
    report.library.loaded = true;

    stage = "media-selection";
    const candidateCount = report.library.candidateCount;
    const candidateIndexes = [];
    while (
      candidateIndexes.length < Math.min(5, candidateCount)
    ) {
      const index = randomInt(candidateCount);
      if (!candidateIndexes.includes(index)) candidateIndexes.push(index);
    }
    let selectedIndex = -1;
    for (const candidateIndex of candidateIndexes) {
      report.library.selectionAttempts += 1;
      await trustedClick("[data-emby-item]", candidateIndex);
      const selectionStartedAt = Date.now();
      let selectionState;
      while (Date.now() - selectionStartedAt < 25_000) {
        selectionState = await evaluate(`(() => {
          const popup = document.querySelector("#emby-item-popup");
          const source = document.querySelector("#emby-media-source");
          const audio = document.querySelector("#emby-audio-track");
          const method = document.querySelector("#emby-stream-method");
          return {
            open: popup?.open === true,
            sourceCount: source?.options.length || 0,
            audioCount: audio?.options.length || 0,
            failed: method?.classList.contains("error") === true
          };
        })()`);
        if (
          selectionState?.open &&
          selectionState.sourceCount > 0 &&
          selectionState.audioCount > 0
        ) {
          selectedIndex = candidateIndex;
          break;
        }
        if (selectionState?.failed) break;
        await delay(250);
      }
      if (selectedIndex >= 0) break;
      await trustedClick("[data-close-emby-popup]").catch(() => undefined);
      await delay(250);
    }
    if (selectedIndex < 0) {
      fault("external-media-playback-info-unavailable", stage);
    }
    report.library.selectedOrdinal = selectedIndex + 1;

    const qualityState = await evaluate(`(() => {
      const quality = document.querySelector("#emby-quality");
      if (!quality) return undefined;
      const enabled = [...quality.options].filter((option) => !option.disabled);
      const preferred = enabled.find((option) => option.value === "original") ||
        enabled.find((option) => option.value === "4k-18") ||
        enabled.find((option) => option.value === "4k-12") ||
        enabled.find((option) => option.value === "1080p-12") ||
        enabled[0];
      if (!preferred) return undefined;
      quality.value = preferred.value;
      quality.dispatchEvent(new Event("change", { bubbles: true }));
      const resume = document.querySelector("#emby-resume-playback");
      if (resume) resume.checked = false;
      const allowed = new Set([
        "original", "4k-18", "4k-12", "1080p-12",
        "1080p-8", "720p-6", "720p-4", "480p-2.5", "360p-1.2", "auto"
      ]);
      return {
        optionCount: enabled.length,
        selectedClass: allowed.has(preferred.value) ? preferred.value : "other"
      };
    })()`);
    if (!qualityState) fault("quality-control-unavailable", stage);
    report.quality.optionCount = finite(qualityState.optionCount);
    report.quality.selectedClass = qualityState.selectedClass;

    await evaluate(`(() => {
      const video = document.querySelector("#channel-video");
      if (!video) return false;
      const state = {
        waiting: 0,
        stalled: 0,
        errors: 0,
        rendererErrors: 0,
        unhandledRejections: 0,
        frameCallbacks: 0,
        active: true
      };
      video.addEventListener("waiting", () => { state.waiting += 1; });
      video.addEventListener("stalled", () => { state.stalled += 1; });
      video.addEventListener("error", () => { state.errors += 1; });
      window.addEventListener("error", () => { state.rendererErrors += 1; });
      window.addEventListener("unhandledrejection", () => {
        state.unhandledRejections += 1;
      });
      if (typeof video.requestVideoFrameCallback === "function") {
        const onFrame = () => {
          if (!state.active) return;
          state.frameCallbacks += 1;
          video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
      }
      window.__syncedEmbyFieldMetrics = state;
      return true;
    })()`);

    stage = "playback-start";
    await trustedClick("#emby-start-from-popup");
    let lastStartClickAt = Date.now();
    let startClickRetries = 0;
    const playbackStartDeadline = Date.now() + 60_000;
    let playbackStarted = false;
    while (Date.now() < playbackStartDeadline) {
      const startState = await evaluate(`(() => {
        const video = document.querySelector("#channel-video");
        const quality = video?.getVideoPlaybackQuality?.();
        const decoded = quality?.totalVideoFrames ??
          video?.webkitDecodedFrameCount ?? 0;
        let bufferedAhead = 0;
        if (video) {
          for (let index = 0; index < video.buffered.length; index += 1) {
            if (
              video.buffered.start(index) <= video.currentTime + 0.05 &&
              video.buffered.end(index) >= video.currentTime
            ) {
              bufferedAhead = Math.max(
                bufferedAhead,
                video.buffered.end(index) - video.currentTime
              );
            }
          }
        }
        const metrics = window.__syncedEmbyFieldMetrics || {};
        const action = document.querySelector("#broadcast-action");
        const broadcastOwned = Boolean(
          action &&
          !action.hidden &&
          action.classList.contains("active")
        );
        const ready = Boolean(
          broadcastOwned &&
          video &&
          !video.hidden &&
          !video.paused &&
          video.readyState >= 2 &&
          video.videoWidth > 0 &&
          decoded > 0
        );
        return {
          ready,
          broadcastOwned,
          startBusy:
            document.querySelector("#emby-start-from-popup")
              ?.getAttribute("aria-busy") === "true",
          popupOpen:
            document.querySelector("#emby-item-popup")?.open === true,
          videoHidden: video?.hidden !== false,
          paused: video?.paused !== false,
          readyState: Number(video?.readyState) || 0,
          decodedFrames: Number(decoded) || 0,
          bufferedRanges: Number(video?.buffered?.length) || 0,
          bufferedAhead: Number(bufferedAhead) || 0,
          currentTime: Number(video?.currentTime) || 0,
          width: Number(video?.videoWidth) || 0,
          height: Number(video?.videoHeight) || 0,
          mediaErrorCode: Number(video?.error?.code) || 0,
          rendererErrors: Number(metrics.rendererErrors) || 0,
          unhandledRejections: Number(metrics.unhandledRejections) || 0,
          dangerToastCount:
            document.querySelectorAll(".toast-danger").length
        };
      })()`,
      );
      report.playbackStart = startState || report.playbackStart;
      if (startState?.ready) {
        playbackStarted = true;
        break;
      }
      if (
        startClickRetries < 2 &&
        Date.now() - lastStartClickAt >= 4_000 &&
        startState?.popupOpen &&
        !startState.startBusy &&
        startState.videoHidden &&
        !startState.broadcastOwned &&
        startState.dangerToastCount === 0
      ) {
        await trustedClick("#emby-start-from-popup");
        startClickRetries += 1;
        lastStartClickAt = Date.now();
      }
      await delay(250);
    }
    if (!playbackStarted) {
      if (await captureEvidence()) {
        report.screenshotPath = screenshotPath;
      }
      fault("external-media-playback-start-failed", stage);
    }

    const mediaSnapshot = async () =>
      evaluate(`(() => {
        const video = document.querySelector("#channel-video");
        const metrics = window.__syncedEmbyFieldMetrics || {};
        if (!video) return undefined;
        let bufferedAhead = 0;
        for (let index = 0; index < video.buffered.length; index += 1) {
          if (
            video.buffered.start(index) <= video.currentTime + 0.05 &&
            video.buffered.end(index) >= video.currentTime
          ) {
            bufferedAhead = Math.max(
              bufferedAhead,
              video.buffered.end(index) - video.currentTime
            );
          }
        }
        const quality = video.getVideoPlaybackQuality?.();
        return {
          currentTime: Number(video.currentTime) || 0,
          readyState: Number(video.readyState) || 0,
          paused: video.paused === true,
          ended: video.ended === true,
          width: Number(video.videoWidth) || 0,
          height: Number(video.videoHeight) || 0,
          bufferedAhead: Number(bufferedAhead) || 0,
          decodedFrames:
            Number(quality?.totalVideoFrames ??
              video.webkitDecodedFrameCount ?? 0) || 0,
          droppedFrames:
            Number(quality?.droppedVideoFrames ??
              video.webkitDroppedFrameCount ?? 0) || 0,
          mediaErrorCode: Number(video.error?.code) || 0,
          waitingEvents: Number(metrics.waiting) || 0,
          stalls: Number(metrics.stalled) || 0,
          mediaErrorEvents: Number(metrics.errors) || 0,
          rendererErrors: Number(metrics.rendererErrors) || 0,
          unhandledRejections: Number(metrics.unhandledRejections) || 0,
          frameCallbacks: Number(metrics.frameCallbacks) || 0
        };
      })()`);

    stage = "playback-observation";
    const samples = [];
    const firstSample = await mediaSnapshot();
    if (!firstSample) fault("media-element-missing", stage);
    samples.push(firstSample);
    const observationStartedAt = Date.now();
    while (Date.now() - observationStartedAt < playbackDurationMs) {
      await delay(1_000);
      const sample = await mediaSnapshot();
      if (!sample) fault("media-element-lost", stage);
      samples.push(sample);
      if (
        sample.mediaErrorCode ||
        sample.mediaErrorEvents ||
        sample.rendererErrors ||
        sample.unhandledRejections
      ) {
        fault("external-media-playback-error", stage);
      }
      if (sample.ended) fault("external-media-ended-too-early", stage);
    }
    const lastSample = samples.at(-1);
    const buffered = samples.map((sample) =>
      Math.max(0, finite(sample.bufferedAhead)),
    );
    const readyStates = samples.map((sample) => finite(sample.readyState));
    report.playback = {
      requiredSeconds: playbackDurationMs / 1_000,
      observedSeconds:
        Math.round((Date.now() - observationStartedAt) / 100) / 10,
      decodedFramesDelta: Math.max(
        0,
        finite(lastSample.decodedFrames) - finite(firstSample.decodedFrames),
      ),
      droppedFramesDelta: Math.max(
        0,
        finite(lastSample.droppedFrames) - finite(firstSample.droppedFrames),
      ),
      frameCallbacks: Math.max(
        0,
        finite(lastSample.frameCallbacks) - finite(firstSample.frameCallbacks),
      ),
      currentTimeDelta:
        Math.round(
          Math.max(
            0,
            finite(lastSample.currentTime) - finite(firstSample.currentTime),
          ) * 100,
        ) / 100,
      readyStateMin: Math.min(...readyStates),
      bufferedAheadMin:
        Math.round(Math.min(...buffered) * 100) / 100,
      bufferedAheadMedian:
        Math.round(percentile(buffered, 0.5) * 100) / 100,
      stalls: finite(lastSample.stalls),
      waitingEvents: finite(lastSample.waitingEvents),
      mediaErrorCode: finite(lastSample.mediaErrorCode),
      width: finite(lastSample.width),
      height: finite(lastSample.height),
    };
    if (
      report.playback.observedSeconds < 30 ||
      report.playback.decodedFramesDelta < 30 ||
      report.playback.currentTimeDelta < playbackDurationMs / 1_000 - 6 ||
      report.playback.readyStateMin < 2 ||
      report.playback.mediaErrorCode !== 0 ||
      report.playback.width < 1 ||
      report.playback.height < 1
    ) {
      fault("playback-continuity-threshold-failed", stage);
    }

    stage = "playback-screenshot";
    if (!(await captureEvidence())) fault("screenshot-capture-failed", stage);
    report.screenshotPath = screenshotPath;

    stage = "playback-stop";
    await trustedClick("#broadcast-action");
    await waitFor(
      `(() => {
        const video = document.querySelector("#channel-video");
        const action = document.querySelector("#broadcast-action");
        return video?.hidden === true &&
          Boolean(
            action &&
            (action.hidden || !action.classList.contains("active"))
          );
      })()`,
      20_000,
      "playback-stop-failed",
    );
    await evaluate(`(() => {
      if (window.__syncedEmbyFieldMetrics) {
        window.__syncedEmbyFieldMetrics.active = false;
      }
      return true;
    })()`);

    stage = "post-stop-search";
    await trustedClick("#stage-start-broadcast, #broadcast-action");
    await waitFor(
      "document.querySelector('#broadcast-dialog')?.open === true",
      10_000,
      "post-stop-dialog-timeout",
    );
    await trustedClick("#emby-mode-tab");
    await waitFor(
      `document.querySelector("#emby-library-panel")?.hidden === false`,
      20_000,
      "post-stop-account-restore-failed",
    );
    const searchStartedAt = Date.now();
    if (!(await setKnownInput("#emby-search-input", searchProbe))) {
      fault("post-stop-search-control-missing", stage);
    }
    await delay(700);
    const probeState = await waitFor(
      `(() => {
        const status = document.querySelector("#emby-library-status");
        const busy = /正在|加载中/.test(status?.textContent || "");
        if (busy) return false;
        return {
          failed: status?.classList.contains("error") === true,
          itemCount: document.querySelectorAll("[data-emby-item]").length
        };
      })()`,
      30_000,
      "post-stop-search-timeout",
    );
    if (probeState.failed) fault("post-stop-search-failed", stage);
    report.postStopSearch.probeResultCount = finite(probeState.itemCount);

    await setKnownInput("#emby-search-input", "");
    await delay(700);
    const restoredSearch = await waitFor(
      `(() => {
        const status = document.querySelector("#emby-library-status");
        const busy = /正在|加载中/.test(status?.textContent || "");
        const count = document.querySelectorAll("[data-emby-item]").length;
        if (busy || count < 1) return false;
        return {
          failed: status?.classList.contains("error") === true,
          itemCount: count
        };
      })()`,
      30_000,
      "post-stop-library-recovery-timeout",
    );
    if (restoredSearch.failed) {
      fault("post-stop-library-recovery-failed", stage);
    }
    report.postStopSearch = {
      completed: true,
      probeResultCount: report.postStopSearch.probeResultCount,
      restoredResultCount: finite(restoredSearch.itemCount),
      durationMs: Date.now() - searchStartedAt,
    };

    report.ok = true;
    report.outcome = "passed";
    report.classification = "passed";
    report.stage = "complete";
  } catch (error) {
    const known = error instanceof FieldTestFault;
    report.ok = false;
    report.outcome = known ? error.outcome : "failed";
    report.classification = known
      ? error.classification
      : "field-test-harness-failed";
    report.stage = known ? error.stage : stage;
    process.exitCode = report.outcome === "failed" ? 1 : 0;
  } finally {
    if (cdp) {
      await cdp.shutdown().catch(() => undefined);
    }
    await delay(300);
    await stopLauncher(launcher);
    writeReport(publicReport({}, report));
  }
}

module.exports = {
  CdpTransportFault,
  captureLauncherWindow,
  createCdp,
  stopLauncher,
};

if (require.main === module) void main();
