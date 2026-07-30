process.env.YIQIKAN_E2E = "1";

const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

require("../electron/main.cjs");

async function waitFor(read, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("embedded game smoke test timed out");
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const { createSignalServer } = await import(
    pathToFileURL(path.join(root, "server", "index.mjs")).href
  );
  const signalServer = createSignalServer();
  const signalAddress = await signalServer.listen(0, "127.0.0.1");
  const signalUrl = `ws://127.0.0.1:${signalAddress.port}/signal`;
  await app.whenReady();
  const mainWindow = await waitFor(() =>
    BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.isDestroyed() &&
        !candidate.webContents.getURL().endsWith("/overlay.html"),
    ),
  );
  mainWindow.show();
  mainWindow.setSize(1280, 820);
  await waitFor(() =>
    mainWindow.webContents.executeJavaScript(
      "Boolean(document.querySelector('#choose-host'))",
    ),
  );
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('#choose-host')?.click()",
  );
  await waitFor(() =>
    mainWindow.webContents.executeJavaScript(
      "Boolean(document.querySelector('#start-share'))",
    ),
  );
  await mainWindow.webContents.executeJavaScript(`(() => {
    document.querySelector("#host-signal-url").value = ${JSON.stringify(signalUrl)};
    document.querySelector("#host-nickname").value = "游戏验收";
    document.querySelector("#start-share").click();
  })()`);
  await waitFor(() =>
    mainWindow.webContents.executeJavaScript(
      "Boolean(document.querySelector('[data-game-button]'))",
    ),
  );
  const captureSources =
    await mainWindow.webContents.executeJavaScript(
      "window.roomDesktop.listSources()",
    );
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('[data-music-button]')?.click()",
  );
  await waitFor(() =>
    mainWindow.webContents.executeJavaScript(
      "Boolean(document.querySelector('.music-source-popover .music-source-row, .music-source-popover .music-popover-error'))",
    ),
  );
  const audioSources =
    await mainWindow.webContents.executeJavaScript(
      "window.roomDesktop.listSources({ thumbnails: false, audioProcesses: true })",
    );
  const processOnlySource = audioSources.find((source) =>
    String(source.id).startsWith("process:"),
  );
  let processAudioProbe;
  if (processOnlySource) {
    processAudioProbe = await mainWindow.webContents.executeJavaScript(`(async () => {
      await window.roomDesktop.selectSource(${JSON.stringify(processOnlySource.id)});
      const status = await window.roomDesktop.startProcessAudio();
      await window.roomDesktop.stopProcessAudio(status.captureId);
      return {
        type: status.type,
        processId: status.processId,
        captureId: status.captureId
      };
    })()`);
  }
  const neteaseDetected = await mainWindow.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll(".music-source-row")].find(
      (candidate) => candidate.textContent?.includes("网易云音乐")
    );
    return Boolean(row && !row.disabled && !row.classList.contains("unavailable"));
  })()`);
  const musicScreenshotPath = path.join(
    os.tmpdir(),
    "yiqikan-music-menu-smoke.png",
  );
  const processAnnotatedSourceCount = captureSources.filter(
    (source) => source.processName || source.executableName,
  ).length;
  const sampleSourceIdentities = captureSources.slice(0, 5).map((source) => ({
    name: source.name,
    processName: source.processName,
    executableName: source.executableName,
  }));
  writeFileSync(
    musicScreenshotPath,
    (await mainWindow.webContents.capturePage()).toPNG(),
  );
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('[data-music-close]')?.click()",
  );
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  app.getAppMetrics();
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const idleMetrics = app.getAppMetrics();
  const idleCpuPercent = Number(
    idleMetrics
      .reduce(
        (total, metric) => total + Number(metric.cpu?.percentCPUUsage || 0),
        0,
      )
      .toFixed(2),
  );
  const idleWorkingSetMb = Number(
    (
      idleMetrics.reduce(
        (total, metric) =>
          total + Number(metric.memory?.workingSetSize || 0),
        0,
      ) / 1024
    ).toFixed(1),
  );
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('[data-game-button]')?.click()",
  );
  const centerOpened = await waitFor(() =>
    mainWindow.webContents.executeJavaScript(
      "Boolean(document.querySelector('[data-game-center]:not([hidden])') && document.querySelector('[data-game-launch=\"bluff\"]'))",
    ),
  );
  const viewBeforeLaunch = mainWindow.contentView.children.some(
    (view) =>
      view.webContents &&
      !view.webContents.isDestroyed() &&
      view.webContents.getURL().startsWith("https://bluff.synced.com.cn/"),
  );
  const gameCenterScreenshotPath = path.join(
    os.tmpdir(),
    "yiqikan-game-center-smoke.png",
  );
  writeFileSync(
    gameCenterScreenshotPath,
    (await mainWindow.webContents.capturePage()).toPNG(),
  );
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('[data-game-launch=\"bluff\"]')?.click()",
  );

  const firstView = await waitFor(() =>
    mainWindow.contentView.children.find(
      (view) =>
        view.webContents &&
        !view.webContents.isDestroyed() &&
        view.webContents.getURL().startsWith("https://bluff.synced.com.cn/"),
    ),
  );
  await waitFor(
    () => !firstView.webContents.isLoadingMainFrame(),
    30_000,
  );
  const page = await firstView.webContents.executeJavaScript(`({
    title: document.title,
    origin: location.origin,
    bodyReady: Boolean(document.body && document.body.childElementCount)
  })`);
  const preferences = firstView.webContents.getLastWebPreferences();
  const firstId = firstView.webContents.id;

  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('[data-game-button]')?.click()",
  );
  await waitFor(
    () =>
      !mainWindow.contentView.children.some(
        (view) => view.webContents?.id === firstId,
      ),
  );
  const shellHidden = await mainWindow.webContents.executeJavaScript(
    "document.querySelector('#embedded-game-shell')?.hidden === true",
  );

  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('[data-game-button]')?.click()",
  );
  await waitFor(() =>
    mainWindow.webContents.executeJavaScript(
      "Boolean(document.querySelector('[data-game-center]:not([hidden])'))",
    ),
  );
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('[data-game-launch=\"bluff\"]')?.click()",
  );
  const restoredView = await waitFor(() =>
    mainWindow.contentView.children.find(
      (view) => view.webContents?.id === firstId,
    ),
  );

  const result = {
    ok:
      page.origin === "https://bluff.synced.com.cn" &&
      page.bodyReady === true &&
      preferences.nodeIntegration === false &&
      preferences.contextIsolation === true &&
      preferences.sandbox === true &&
      centerOpened &&
      !viewBeforeLaunch &&
      shellHidden &&
      restoredView.webContents.id === firstId &&
      idleCpuPercent < 25 &&
      (!processOnlySource ||
        (processAudioProbe?.type === "ready" &&
          Number(processAudioProbe?.processId) > 0)),
    url: restoredView.webContents.getURL(),
    title: page.title,
    embedded: true,
    retainedAcrossHide: restoredView.webContents.id === firstId,
    gameCenterScreenshotPath,
    musicScreenshotPath,
    captureSourceCount: captureSources.length,
    processAnnotatedSourceCount,
    sampleSourceIdentities,
    audioProcessSourceCount: audioSources.filter((source) =>
      String(source.id).startsWith("process:"),
    ).length,
    processAudioProbe,
    neteaseDetected,
    idleCpuPercent,
    idleWorkingSetMb,
    security: {
      nodeIntegration: preferences.nodeIntegration,
      contextIsolation: preferences.contextIsolation,
      sandbox: preferences.sandbox,
    },
  };
  console.log(JSON.stringify(result));
  await signalServer.close();
  app.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
