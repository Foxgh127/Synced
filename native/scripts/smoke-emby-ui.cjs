process.env.SYNCED_E2E = "1";

const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const {
  createReadStream,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

require("../electron/main.cjs");

const root = path.resolve(__dirname, "..");
const ffmpeg = path.join(root, "vendor", "ffmpeg", "ffmpeg.exe");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
      "sine=frequency=523.25:sample_rate=48000",
      "-t",
      "16",
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
  const token = "ui-host-only-secret";
  const audit = {
    mediaRequests: 0,
    playbackReports: 0,
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
        const login = JSON.parse(body);
        if (login.Username !== "Readonly" || login.Pw !== "temporary") {
          response.writeHead(401).end();
          return;
        }
        json({
          AccessToken: token,
          User: { Id: "user-ui", Name: "Readonly" },
        });
      });
      return;
    }
    if (url.pathname === "/System/Info") {
      json({ ServerName: "UI Smoke Emby", Version: "4.8.0" });
      return;
    }
    if (url.pathname === "/Users/user-ui/Views") {
      json({
        Items: [
          { Id: "movies", Name: "电影", Type: "CollectionFolder" },
        ],
      });
      return;
    }
    if (url.pathname === "/Users/user-ui/Items") {
      json({
        TotalRecordCount: 1,
        Items: [
          {
            Id: "movie-ui",
            Name: "UI 高清验收片",
            Type: "Movie",
            RunTimeTicks: 160_000_000,
            Overview: "由测试 Emby 服务器提供的真实编码媒体流。",
          },
        ],
      });
      return;
    }
    if (url.pathname === "/Items/movie-ui/PlaybackInfo") {
      json({
        PlaySessionId: "ui-play-session",
        MediaSources: [
          {
            Id: "source-ui",
            Name: "H264 AAC MP4",
            Container: "mp4",
            Bitrate: 4_200_000,
            RunTimeTicks: 160_000_000,
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
    if (url.pathname === "/Videos/movie-ui/stream") {
      if (request.headers["x-emby-token"] !== token) {
        response.writeHead(401).end();
        return;
      }
      audit.mediaRequests += 1;
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
      audit.playbackReports += 1;
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

async function waitForWindow(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed(),
    );
    if (window) {
      const ready = await window.webContents
        .executeJavaScript("Boolean(document.querySelector('#choose-host'))")
        .catch(() => false);
      if (ready) return window;
    }
    await delay(100);
  }
  throw new Error("main application window did not become ready");
}

async function waitFor(window, expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await window.webContents.executeJavaScript(`(${expression})`);
    } catch (error) {
      last = { evaluationError: String(error) };
      await delay(100);
      continue;
    }
    if (last) return last;
    await delay(100);
  }
  throw new Error(
    `UI condition timed out: ${expression}; last=${JSON.stringify(last)}`,
  );
}

async function click(window, expression) {
  try {
    return await window.webContents.executeJavaScript(
      `(() => { const target = ${expression}; if (!target) throw new Error("target missing"); target.click(); return true; })()`,
      true,
    );
  } catch (error) {
    throw new Error(`click failed for ${expression}: ${String(error)}`, {
      cause: error,
    });
  }
}

async function main() {
  const temporary = mkdtempSync(
    path.join(os.tmpdir(), "synced-emby-ui-"),
  );
  // Account persistence is part of this smoke test. Keep its encrypted test
  // tokens inside the disposable fixture directory so repeated release runs
  // cannot pollute the developer's real quick-login account list.
  app.setPath("userData", path.join(temporary, "user-data"));
  const fixture = path.join(temporary, "fixture.mp4");
  makeFixture(fixture);
  const mock = await createMockEmby(fixture);
  const serverModuleUrl = pathToFileURL(
    path.join(root, "server", "index.mjs"),
  ).href;
  const { createSignalServer } = await import(serverModuleUrl);
  const signalServer = createSignalServer();
  // The packaged renderer intentionally permits only the production endpoint
  // and this fixed loopback development endpoint in connect-src. Keep the
  // end-to-end smoke inside that exact production CSP instead of weakening it
  // with an arbitrary test port.
  await signalServer.listen(8_787, "127.0.0.1");
  const signalUrl = "ws://localhost:8787/signal";
  let window;
  const screenshotPath = path.join(
    os.tmpdir(),
    "synced-emby-ui-smoke.png",
  );
  const broadcastScreenshotPath = path.join(
    os.tmpdir(),
    "synced-broadcast-mode-smoke.png",
  );
  const rendererErrors = [];
  let phase = "startup";

  try {
    await app.whenReady();
    window = await waitForWindow();
    window.webContents.on("console-message", (_event, ...args) => {
      const detail =
        args.length === 1 && typeof args[0] === "object"
          ? args[0]
          : { level: args[0], message: args[1] };
      if (Number(detail.level) >= 2) {
        rendererErrors.push(String(detail.message || ""));
      }
    });
    phase = "open host setup";
    await click(window, "document.querySelector('#choose-host')");
    await waitFor(
      window,
      "Boolean(document.querySelector('#start-share'))",
    );
    phase = "configure host";
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector("#host-signal-url").value =
        ${JSON.stringify(signalUrl)};
      document.querySelector("#host-nickname").value = "Emby UI 验收";
      window.__syncedScreenCaptureCalls = 0;
      const mediaDevices = navigator.mediaDevices;
      if (mediaDevices?.getDisplayMedia) {
        const original = mediaDevices.getDisplayMedia.bind(mediaDevices);
        mediaDevices.getDisplayMedia = (...args) => {
          window.__syncedScreenCaptureCalls += 1;
          return original(...args);
        };
      }
    })()`);
    phase = "create channel";
    await click(window, "document.querySelector('#start-share')");
    await waitFor(
      window,
      "Boolean(document.querySelector('#broadcast-action') && !document.querySelector('#broadcast-action').disabled)",
    );
    phase = "open Emby mode";
    await click(window, "document.querySelector('#broadcast-action')");
    await waitFor(
      window,
      "document.querySelector('#broadcast-dialog')?.open === true",
    );
    const networkLayout = await window.webContents.executeJavaScript(`(() => {
      const card = document.querySelector("#broadcast-network-card");
      const panel = document.querySelector("#screen-broadcast-panel");
      const header = card?.querySelector(":scope > header");
      const metrics = card?.querySelector(".network-metric-grid");
      const tabs = document.querySelector(".broadcast-mode-tabs");
      const glider = document.querySelector(".broadcast-mode-glider");
      const advanced = document.querySelector("#broadcast-advanced");
      const cardRect = card?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      const headerRect = header?.getBoundingClientRect();
      return {
        cardHeight: Math.round(cardRect?.height || 0),
        cardTop: Math.round(cardRect?.top || 0),
        cardBottom: Math.round(cardRect?.bottom || 0),
        panelTop: Math.round(panelRect?.top || 0),
        panelBottom: Math.round(panelRect?.bottom || 0),
        headerHeight: Math.round(headerRect?.height || 0),
        headerPaddingTop: getComputedStyle(header).paddingTop,
        metricDisplay: getComputedStyle(metrics).display,
        metricCount: metrics?.children.length || 0,
        metricTop: Math.round(metrics?.getBoundingClientRect().top || 0),
        headerBottom: Math.round(headerRect?.bottom || 0),
        cardInsidePanel: panel?.contains(card) === true,
        advancedOpen: advanced?.open === true,
        obsoleteGuidanceAbsent:
          !document.querySelector(".hdr-guidance") &&
          !document.querySelector("#hdr-display-summary") &&
          !document.querySelector("#open-display-settings") &&
          !document.querySelector("#screen-broadcast-panel > .dialog-tip"),
        activeMode: tabs?.getAttribute("data-active-mode"),
        gliderVisible:
          glider && getComputedStyle(glider).display !== "none" &&
          glider.getBoundingClientRect().width > 100
      };
    })()`);
    if (
      !networkLayout.cardInsidePanel ||
      networkLayout.advancedOpen ||
      networkLayout.headerHeight > 64 ||
      networkLayout.headerPaddingTop !== "0px" ||
      networkLayout.metricDisplay !== "grid" ||
      networkLayout.metricCount !== 4 ||
      networkLayout.metricTop < networkLayout.headerBottom ||
      !networkLayout.obsoleteGuidanceAbsent ||
      networkLayout.activeMode !== "screen" ||
      !networkLayout.gliderVisible
    ) {
      throw new Error(
        `network health card layout regressed: ${JSON.stringify(networkLayout)}`,
      );
    }
    const originalContentSize = window.getContentSize();
    window.setContentSize(960, 700);
    await delay(360);
    const compactBroadcastLayout =
      await window.webContents.executeJavaScript(`(() => {
        const dialog = document.querySelector("#broadcast-dialog");
        const panel = document.querySelector("#screen-broadcast-panel");
        const card = document.querySelector("#broadcast-network-card");
        const tabs = document.querySelector(".broadcast-mode-tabs");
        const advanced = document.querySelector("#broadcast-advanced");
        const dialogRect = dialog?.getBoundingClientRect();
        const panelRect = panel?.getBoundingClientRect();
        const cardRect = card?.getBoundingClientRect();
        return {
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          dialogLeft: dialogRect?.left || 0,
          dialogRight: dialogRect?.right || 0,
          dialogBottom: dialogRect?.bottom || 0,
          panelClientWidth: panel?.clientWidth || 0,
          panelScrollWidth: panel?.scrollWidth || 0,
          cardTop: cardRect?.top || 0,
          cardBottom: cardRect?.bottom || 0,
          panelTop: panelRect?.top || 0,
          panelBottom: panelRect?.bottom || 0,
          tabsHeight: tabs?.getBoundingClientRect().height || 0,
          cardInsidePanel: panel?.contains(card) === true,
          advancedOpen: advanced?.open === true,
        };
      })()`);
    if (
      compactBroadcastLayout.dialogLeft < 8 ||
      compactBroadcastLayout.dialogRight >
        compactBroadcastLayout.viewportWidth - 8 ||
      compactBroadcastLayout.dialogBottom >
        compactBroadcastLayout.viewportHeight - 8 ||
      compactBroadcastLayout.panelScrollWidth >
        compactBroadcastLayout.panelClientWidth + 1 ||
      !compactBroadcastLayout.cardInsidePanel ||
      compactBroadcastLayout.advancedOpen ||
      compactBroadcastLayout.tabsHeight < 56
    ) {
      throw new Error(
        `compact broadcast dialog overflowed: ${JSON.stringify(compactBroadcastLayout)}`,
      );
    }
    window.setContentSize(...originalContentSize);
    await delay(300);
    await window.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await delay(120);
    window.showInactive();
    await delay(180);
    writeFileSync(
      broadcastScreenshotPath,
      await window.webContents.capturePage().then((image) => image.toPNG()),
    );
    window.hide();
    await click(window, "document.querySelector('#emby-mode-tab')");
    await delay(650);
    const endpointLayout = await window.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector(
        '[data-emby-endpoint-editor="login"]'
      );
      const header = editor?.querySelector(":scope > header");
      const button = editor?.querySelector("[data-add-emby-endpoint]");
      const rect = button?.getBoundingClientRect();
      return {
        width: Math.round(rect?.width || 0),
        height: Math.round(rect?.height || 0),
        scrollWidth: button?.scrollWidth || 0,
        clientWidth: button?.clientWidth || 0,
        whiteSpace: getComputedStyle(button).whiteSpace,
        headerPaddingTop: getComputedStyle(header).paddingTop,
        activeMode:
          document.querySelector(".broadcast-mode-tabs")
            ?.getAttribute("data-active-mode"),
        transitionFinished:
          !document.querySelector("#broadcast-dialog")
            ?.classList.contains("is-mode-switching")
      };
    })()`);
    if (
      endpointLayout.width < 80 ||
      endpointLayout.width > 180 ||
      endpointLayout.height < 43 ||
      endpointLayout.height > 52 ||
      endpointLayout.scrollWidth > endpointLayout.clientWidth ||
      endpointLayout.whiteSpace !== "nowrap" ||
      endpointLayout.headerPaddingTop !== "0px" ||
      endpointLayout.activeMode !== "emby" ||
      !endpointLayout.transitionFinished
    ) {
      throw new Error(
        `Emby endpoint action layout regressed: ${JSON.stringify(endpointLayout)}`,
      );
    }
    await window.webContents.executeJavaScript(`(() => {
      const endpoint = new URL(${JSON.stringify(mock.url)});
      const row = document.querySelector(
        '[data-emby-endpoint-editor="login"] [data-emby-endpoint-row]'
      );
      row.querySelector("[data-emby-endpoint-protocol]").value =
        endpoint.protocol.slice(0, -1);
      row.querySelector("[data-emby-endpoint-host]").value = endpoint.hostname;
      row.querySelector("[data-emby-endpoint-port]").value =
        endpoint.port || (endpoint.protocol === "http:" ? "80" : "443");
      row.querySelector("[data-emby-endpoint-path]").value =
        endpoint.pathname === "/" ? "" : endpoint.pathname;
      document.querySelector("#emby-username").value = "Readonly";
      document.querySelector("#emby-password").value = "temporary";
      document.querySelector("#emby-allow-http").checked = true;
    })()`);
    phase = "login to Emby";
    await click(window, "document.querySelector('#emby-login-submit')");
    await waitFor(
      window,
      "Boolean(document.querySelector('[data-emby-item]'))",
    );
    const passwordAfterLogin = await window.webContents.executeJavaScript(
      "document.querySelector('#emby-password').value",
    );
    if (passwordAfterLogin !== "") {
      throw new Error("password remained in the renderer after login");
    }
    phase = "open Emby item popup";
    await click(window, "document.querySelector('[data-emby-item]')");
    await waitFor(
      window,
      `(() => {
        const popup = document.querySelector("#emby-item-popup");
        return popup?.hidden === false &&
          popup?.dataset.presence === "present" &&
          !document.querySelector("#emby-selection-panel") &&
          Boolean(document.querySelector("#emby-selection-panel-popup")) &&
          Boolean(document.querySelector("#emby-start-from-popup")) &&
          !/正在读取|正在请求/.test(
            document.querySelector("#emby-stream-method")?.textContent || ""
          ) &&
          document.querySelector("#emby-audio-track")?.options.length > 0;
      })()`,
    );
    await window.webContents.executeJavaScript(`(() => {
      const quality = document.querySelector("#emby-quality");
      quality.value = "original";
      quality.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    const popupLayout = await window.webContents.executeJavaScript(`(() => {
      const popup = document.querySelector("#emby-item-popup");
      const options = document.querySelector(".emby-popup-options");
      const popupRect = popup?.getBoundingClientRect();
      return {
        clientWidth: popup?.clientWidth || 0,
        scrollWidth: popup?.scrollWidth || 0,
        optionsClientWidth: options?.clientWidth || 0,
        optionsScrollWidth: options?.scrollWidth || 0,
        controlsInside: [...options.querySelectorAll("select")].every((select) => {
          const rect = select.getBoundingClientRect();
          return rect.left >= popupRect.left && rect.right <= popupRect.right;
        })
      };
    })()`);
    if (
      popupLayout.scrollWidth > popupLayout.clientWidth + 1 ||
      popupLayout.optionsScrollWidth > popupLayout.optionsClientWidth + 1 ||
      !popupLayout.controlsInside
    ) {
      throw new Error(
        `Emby popup overflowed horizontally: ${JSON.stringify(popupLayout)}`,
      );
    }
    phase = "capture Emby item popup";
    window.showInactive();
    await delay(550);
    writeFileSync(
      screenshotPath,
      (await window.webContents.capturePage()).toPNG(),
    );
    window.hide();
    phase = "start Emby playback from popup";
    await click(window, "document.querySelector('#emby-start-from-popup')");
    phase = "wait for Emby playback";
    const playback = await waitFor(
      window,
      `(() => {
        const video = document.querySelector("#channel-video");
        if (
          !video ||
          video.videoWidth !== 1280 ||
          video.videoHeight !== 720 ||
          video.currentTime <= 0.25 ||
          video.readyState < 3
        ) return false;
        return {
          width: video.videoWidth,
          height: video.videoHeight,
          currentTime: video.currentTime,
          readyState: video.readyState,
          paused: video.paused,
          legacyStageBadges:
            Boolean(document.querySelector("#local-stage-badge")) ||
            Boolean(document.querySelector("#audio-route-badge")),
          mediaStatus: document.querySelector("#hud-media-text")?.textContent,
          captureCalls: window.__syncedScreenCaptureCalls,
          password: document.querySelector("#emby-password")?.value || "",
          tokenInDom: document.documentElement.innerHTML.includes(${JSON.stringify(
            mock.token,
          )}),
          tokenInStorage: Object.values(localStorage).some((value) =>
            String(value).includes(${JSON.stringify(mock.token)})
          )
        };
      })()`,
      30_000,
    );
    if (playback.captureCalls !== 0) {
      throw new Error("Emby mode unexpectedly called getDisplayMedia");
    }
    if (playback.password || playback.tokenInDom || playback.tokenInStorage) {
      throw new Error("Emby credentials leaked into renderer-visible state");
    }
    if (playback.legacyStageBadges) {
      throw new Error("obsolete LIVE/audio stage badges are still rendered");
    }
    if (!/Emby/i.test(playback.mediaStatus || "")) {
      throw new Error(`missing compact Emby HUD status: ${playback.mediaStatus}`);
    }
    if (mock.audit.mediaRequests < 1 || mock.audit.playbackReports < 1) {
      throw new Error(
        `Emby session audit missing: ${JSON.stringify(mock.audit)}`,
      );
    }
    const keyboardMute = await window.webContents.executeJavaScript(`(() => {
      const video = document.querySelector("#channel-video");
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyM", bubbles: true })
      );
      const muted = video?.muted === true;
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyM", bubbles: true })
      );
      return { muted, restored: video?.muted === false };
    })()`);
    if (!keyboardMute.muted || !keyboardMute.restored) {
      throw new Error(
        `Emby host M shortcut did not toggle local audio: ${JSON.stringify(
          keyboardMute,
        )}`,
      );
    }
    playback.keyboardMute = keyboardMute;

    // Reproduce the host-side regression reported by users: pausing and then
    // seeking used to restart the replacement MediaSource from zero. Keep the
    // host paused across the pipeline rebuild, then resume from the requested
    // timestamp and prove that the clock advances there.
    await delay(1_800);
    const mediaRequestsBeforeSeek = mock.audit.mediaRequests;
    await window.webContents.executeJavaScript(`(() => {
      const video = document.querySelector("#channel-video");
      video.pause();
      video.currentTime = 8;
      return { paused: video.paused, requested: video.currentTime };
    })()`);
    const seekDeadline = Date.now() + 30_000;
    while (
      mock.audit.mediaRequests <= mediaRequestsBeforeSeek &&
      Date.now() < seekDeadline
    ) {
      await delay(100);
    }
    if (mock.audit.mediaRequests <= mediaRequestsBeforeSeek) {
      throw new Error("Emby seek did not rebuild the stream at the requested timestamp");
    }
    let seekPlayback;
    try {
      seekPlayback = await waitFor(
        window,
        `(() => {
          const video = document.querySelector("#channel-video");
          if (
            !video ||
            !video.paused ||
            video.readyState < 3 ||
            video.currentTime < 7.5 ||
            video.currentTime > 9.5
          ) return false;
          return {
            currentTime: video.currentTime,
            paused: video.paused,
            readyState: video.readyState
          };
        })()`,
        30_000,
      );
    } catch (error) {
      const diagnostics = await window.webContents.executeJavaScript(`(() => {
        const video = document.querySelector("#channel-video");
        const ranges = [];
        for (let index = 0; index < video.buffered.length; index += 1) {
          ranges.push([video.buffered.start(index), video.buffered.end(index)]);
        }
        return {
          currentTime: video.currentTime,
          paused: video.paused,
          ended: video.ended,
          duration: video.duration,
          readyState: video.readyState,
          ranges,
          error: video.error?.message || "",
          media: document.querySelector("#hud-media-text")?.textContent,
          toasts: [...document.querySelectorAll(".toast")].map((item) => item.textContent)
        };
      })()`);
      throw new Error(
        `${error instanceof Error ? error.message : error}: ${JSON.stringify(diagnostics)}`,
      );
    }
    // Let the replacement pipeline cross its own local-ready barrier before
    // treating the next play event as an explicit resume action.
    await delay(1_600);
    const playAttempt = await window.webContents.executeJavaScript(
      `(() => {
        const video = document.querySelector("#channel-video");
        return video.play().then(
          () => ({ ok: true, currentTime: video.currentTime }),
          (error) => ({ ok: false, message: String(error) })
        );
      })()`,
      true,
    );
    let resumedPlayback;
    try {
      resumedPlayback = await waitFor(
        window,
        `(() => {
          const video = document.querySelector("#channel-video");
          return video && !video.paused && video.currentTime > 8.2
            ? { currentTime: video.currentTime, paused: video.paused }
            : false;
        })()`,
        15_000,
      );
    } catch (error) {
      const diagnostics = await window.webContents.executeJavaScript(`(() => {
        const video = document.querySelector("#channel-video");
        const ranges = [];
        for (let index = 0; index < video.buffered.length; index += 1) {
          ranges.push([video.buffered.start(index), video.buffered.end(index)]);
        }
        return {
          playAttempt: ${JSON.stringify(playAttempt)},
          currentTime: video.currentTime,
          paused: video.paused,
          ended: video.ended,
          duration: video.duration,
          readyState: video.readyState,
          networkState: video.networkState,
          ranges,
          error: video.error?.message || "",
          media: document.querySelector("#hud-media-text")?.textContent,
          toasts: [...document.querySelectorAll(".toast")].map((item) => item.textContent)
        };
      })()`);
      throw new Error(
        `${error instanceof Error ? error.message : error}: ${JSON.stringify(diagnostics)}`,
      );
    }
    playback.seek = {
      requested: 8,
      rebuiltMediaRequests:
        mock.audit.mediaRequests - mediaRequestsBeforeSeek,
      pausedAtTarget: seekPlayback,
      resumed: resumedPlayback,
    };

    await click(window, "document.querySelector('#broadcast-action')");
    await waitFor(
      window,
      "document.querySelector('#channel-video')?.hidden === true && /无人放映|已停止/.test(document.querySelector('#hud-media-text')?.textContent || '')",
    );
    if (mock.audit.logout !== 0) {
      throw new Error("stopping playback unexpectedly removed the saved Emby login");
    }
    await click(window, "document.querySelector('#broadcast-action')");
    await click(window, "document.querySelector('#emby-mode-tab')");
    const savedLogin = await waitFor(
      window,
      `(() => {
        const login = document.querySelector("#emby-login-panel");
        const library = document.querySelector("#emby-library-panel");
        const account = document.querySelector("#emby-account-name")?.textContent || "";
        const saved = document.querySelector("#emby-saved-note")?.textContent || "";
        if (!login?.hidden || library?.hidden || !document.querySelector("[data-emby-item]")) {
          return false;
        }
        return { account, saved };
      })()`,
    );
    if (!/UI Smoke Emby/.test(savedLogin.account)) {
      throw new Error(`saved Emby account was not restored: ${JSON.stringify(savedLogin)}`);
    }
    playback.savedLogin = savedLogin;
    await click(window, "document.querySelector('[data-close-broadcast]')");
    if (
      rendererErrors.some((message) =>
        /uncaught|unhandled|append.*failed|media.*error/i.test(message),
      )
    ) {
      throw new Error(
        `renderer reported playback errors: ${JSON.stringify(rendererErrors)}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode: "actual-ui-ipc-emby-local-playback",
        playback,
        networkLayout,
        compactBroadcastLayout,
        endpointLayout,
        popupLayout,
        audit: mock.audit,
        rendererErrors,
        broadcastScreenshotPath,
        screenshotPath,
      })}\n`,
    );
  } catch (error) {
    const diagnostics = await window?.webContents
      .executeJavaScript(`(() => ({
        location: location.href,
        title: document.title,
        bodyText: document.body?.innerText?.slice(0, 2_000) || "",
        broadcastAction: document.querySelector("#broadcast-action")
          ? {
              disabled: document.querySelector("#broadcast-action").disabled,
              hidden: document.querySelector("#broadcast-action").hidden,
            }
          : null,
        toasts: [...document.querySelectorAll(".toast")].map((item) => item.textContent),
        rendererErrors: ${JSON.stringify(rendererErrors)},
      }))()`)
      .catch((diagnosticError) => ({
        evaluationError: String(diagnosticError),
      }));
    throw new Error(
      `Emby UI smoke failed during ${phase}: ${
        error instanceof Error ? error.message : String(error)
      }; diagnostics=${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  } finally {
    await window?.webContents
      .executeJavaScript(
        "document.querySelector('#leave-room')?.click(); true",
        true,
      )
      .catch(() => undefined);
    await delay(100);
    await signalServer.close();
    await new Promise((resolve) => mock.server.close(resolve));
    try {
      rmSync(temporary, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    } catch (error) {
      if (!["EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
      // On Windows, Electron can retain an empty temporary directory handle
      // until process shutdown even after FFmpeg and the HTTP stream closed.
    }
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    app.exit(1);
  });
