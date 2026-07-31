process.env.SYNCED_E2E = "1";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const WebSocket = require("ws");
const { app, BrowserWindow } = require("electron");

require("../electron/main.cjs");

async function waitFor(read, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("sidebar layout smoke test timed out");
}

async function openMember(signalUrl, room, nickname) {
  const socket = new WebSocket(signalUrl, { origin: "file://" });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const joined = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("member join timed out")),
      5_000,
    );
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type !== "channel:joined") return;
      clearTimeout(timer);
      resolve();
    });
  });
  socket.send(
    JSON.stringify({
      type: "channel:join",
      room,
      nickname,
      canBroadcast: true,
      createIfMissing: false,
    }),
  );
  await joined;
  socket.send(JSON.stringify({ type: "voice:join" }));
  return socket;
}

async function main() {
  await app.whenReady();
  const serverModuleUrl = pathToFileURL(
    path.join(__dirname, "..", "server", "index.mjs"),
  ).href;
  const { createSignalServer } = await import(serverModuleUrl);
  const signalServer = createSignalServer();
  await signalServer.listen(8_787, "127.0.0.1");
  const signalUrl = "ws://localhost:8787/signal";
  const mainWindow = await waitFor(() =>
    BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.isDestroyed() &&
        !candidate.webContents.getURL().endsWith("/overlay.html"),
    ),
  );
  mainWindow.show();
  mainWindow.setSize(1440, 900);
  await mainWindow.webContents.executeJavaScript(
    "localStorage.setItem('synced:mini-window-enabled', 'false')",
  );
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('#choose-host')?.click()",
  );
  await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript(
        "Boolean(document.querySelector('.setup-main #start-share'))",
      )
      .catch(() => false),
  );
  const setupLayout = await mainWindow.webContents.executeJavaScript(`(() => {
    const card = document.querySelector(".setup-card");
    const copy = document.querySelector(".setup-copy");
    const labels = [
      document.querySelector("#channel-name")?.closest("label.field"),
      document.querySelector("#host-nickname")?.closest("label.field"),
    ].filter(Boolean);
    const fieldMetrics = labels.map((label) => {
      const labelRect = label.getBoundingClientRect();
      const captionRect = label.querySelector("span")?.getBoundingClientRect();
      const inputRect = label.querySelector("input")?.getBoundingClientRect();
      return {
        height: Math.round(labelRect.height),
        captionBottom: Math.round(captionRect?.bottom || 0),
        inputTop: Math.round(inputRect?.top || 0),
        inputHeight: Math.round(inputRect?.height || 0),
      };
    });
    const startButtonRect =
      document.querySelector("#start-share")?.getBoundingClientRect();
    const lastInputRect =
      labels.at(-1)?.querySelector("input")?.getBoundingClientRect();
    const railEmpty = document.querySelector(".channel-rail .recent-empty");
    return {
      cardWidth: Math.round(card?.getBoundingClientRect().width || 0),
      legacySplitCopyAbsent: !copy,
      fieldMetrics,
      buttonGap: Math.round(
        (startButtonRect?.top || 0) - (lastInputRect?.bottom || 0),
      ),
      railEmptyDisplay: railEmpty ? getComputedStyle(railEmpty).display : "none",
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`);
  const setupScreenshotPath = path.join(
    os.tmpdir(),
    "synced-setup-layout-smoke.png",
  );
  await new Promise((resolve) => setTimeout(resolve, 240));
  fs.writeFileSync(
    setupScreenshotPath,
    await mainWindow.webContents.capturePage().then((image) => image.toPNG()),
  );
  await mainWindow.webContents.executeJavaScript(`(() => {
    document.querySelector("#host-signal-url").value = ${JSON.stringify(signalUrl)};
    document.querySelector("#start-share")?.click();
  })()`);
  const room = await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript(`(() => {
        const text = document.querySelector(".channel-header small")?.textContent || "";
        return text.match(/频道\\s+([A-Z0-9]{8})/)?.[1] || "";
      })()`)
      .catch(() => ""),
  );
  await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript(
        "document.querySelectorAll('.participant-row').length === 1",
      )
      .catch(() => false),
  );
  await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript("Boolean(document.querySelector('#invite-dialog[open]'))")
      .catch(() => false),
  );
  await new Promise((resolve) => setTimeout(resolve, 320));
  const inviteLayout = await mainWindow.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector("#invite-dialog[open]");
    const header = dialog?.querySelector(".dialog-header");
    const content = dialog?.querySelector(".invite-content");
    const code = dialog?.querySelector(".invite-code");
    const qr = dialog?.querySelector(".invite-qr-shell");
    const actions = dialog?.querySelector(".invite-actions");
    const close = dialog?.querySelector("[data-close-invite]");
    const rect = dialog?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const contentRect = content?.getBoundingClientRect();
    const codeRect = code?.getBoundingClientRect();
    const qrRect = qr?.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    const closeRect = close?.getBoundingClientRect();
    return {
      open: Boolean(dialog),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      left: rect?.left || 0,
      right: rect?.right || 0,
      top: rect?.top || 0,
      bottom: rect?.bottom || 0,
      centerDelta: rect
        ? rect.left + rect.width / 2 - innerWidth / 2
        : 999,
      opaqueSurface:
        Boolean(dialog) &&
        getComputedStyle(dialog).backgroundImage !== "none",
      closeInsideHeader:
        Boolean(headerRect && closeRect) &&
        closeRect.left >= headerRect.left &&
        closeRect.right <= headerRect.right + 1 &&
        closeRect.top >= headerRect.top - 1 &&
        closeRect.bottom <= headerRect.bottom + 1,
      contentBelowHeader:
        Boolean(contentRect && headerRect) &&
        contentRect.top >= headerRect.bottom,
      codeAndQrAligned:
        Boolean(codeRect && qrRect) &&
        Math.abs(codeRect.top - qrRect.top) <= 44 &&
        codeRect.right <= qrRect.left,
      actionsBelowContent:
        Boolean(actionsRect && contentRect) &&
        actionsRect.top >= contentRect.bottom,
    };
  })()`);
  const inviteScreenshotPath = path.join(
    os.tmpdir(),
    "synced-invite-layout-smoke.png",
  );
  fs.writeFileSync(
    inviteScreenshotPath,
    await mainWindow.webContents.capturePage().then((image) => image.toPNG()),
  );
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('#enter-created-room')?.click()",
  );
  await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript("!document.querySelector('#invite-dialog[open]')")
      .catch(() => false),
  );
  const members = [
    await openMember(signalUrl, room, "音量测试一"),
    await openMember(signalUrl, room, "音量测试二"),
  ];
  await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript(
        "document.querySelectorAll('.participant-row').length === 3 && document.querySelectorAll('.participant-mic.active').length >= 2",
      )
      .catch(() => false),
  );
  members[0].send(
    JSON.stringify({
      type: "chat:send",
      text: "时间戳与弹幕边界测试",
    }),
  );
  await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript(
        "Boolean(document.querySelector('.chat-message .chat-timestamp'))",
      )
      .catch(() => false),
  );
  await mainWindow.webContents.executeJavaScript(`(() => {
    const log = document.querySelector("#chat-log");
    if (!log) return;
    // Disable scroll anchoring while synthetic history is inserted so the
    // smoke test models a user who has deliberately scrolled to the top.
    log.style.overflowAnchor = "none";
    for (let index = 0; index < 36; index += 1) {
      const filler = document.createElement("div");
      filler.className = "chat-history-smoke-filler";
      filler.style.height = "20px";
      filler.textContent = "历史消息";
      log.prepend(filler);
    }
    void log.scrollHeight;
    log.scrollTop = 0;
  })()`);
  members[0].send(
    JSON.stringify({
      type: "chat:send",
      text: "阅读历史时不应强制滚底",
    }),
  );
  await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript(
        "!document.querySelector('#chat-jump-latest')?.hidden",
      )
      .catch(() => false),
  );
  const result = await mainWindow.webContents.executeJavaScript(`(async () => {
    const chat = document.querySelector(".chat-card");
    const sidebar = document.querySelector(".room-sidebar");
    const danmakuLayer = document.querySelector("#stage-danmaku");
    const remoteToggle = [...document.querySelectorAll("[data-participant-toggle]")][0];
    const before = document.querySelectorAll(".participant-volume-control").length;
    remoteToggle?.click();
    const chatRect = chat?.getBoundingClientRect();
    const sidebarRect = sidebar?.getBoundingClientRect();
    const danmakuRect = danmakuLayer?.getBoundingClientRect();
     const stage = document.querySelector("#player-stage");
     const stageRect = stage?.getBoundingClientRect();
     const lobby = document.querySelector(".channel-lobby");
     const lobbyStars = document.querySelector(".lobby-light-field");
     const lobbyStarFrameBefore = Number(lobbyStars?.dataset.starFrame || 0);
     const lobbyRect = lobby?.getBoundingClientRect();
     lobby?.dispatchEvent(new PointerEvent("pointermove", {
       bubbles: true,
       clientX: (lobbyRect?.left || 0) + (lobbyRect?.width || 0) * 0.65,
       clientY: (lobbyRect?.top || 0) + (lobbyRect?.height || 0) * 0.4,
     }));
     await new Promise((resolve) => requestAnimationFrame(() =>
       requestAnimationFrame(resolve)
     ));
     const lobbyStarFrameAfter = Number(lobbyStars?.dataset.starFrame || 0);
     const danmakuStyle = danmakuLayer
      ? getComputedStyle(danmakuLayer)
      : undefined;
    const danmakuItems = [...document.querySelectorAll(".danmaku")];
    const danmakuTopPositions = danmakuItems
      .map((item) => Math.round(item.getBoundingClientRect().top))
      .sort((left, right) => left - right);
    const chatInput = document.querySelector("#chat-input");
    const chatInputRect = chatInput?.getBoundingClientRect();
    chatInput?.focus();
     const chatInputStyle = chatInput
       ? getComputedStyle(chatInput)
       : undefined;
     const chatEmoji = document.querySelector("#chat-emoji-toggle");
     const chatSend = document.querySelector(".chat-send-btn");
     const chatEmojiRect = chatEmoji?.getBoundingClientRect();
     const chatSendRect = chatSend?.getBoundingClientRect();
     const voiceSettingsButton =
       document.querySelector("#voice-settings-toggle");
     const voiceSettingsPanel =
       document.querySelector("#voice-device-panel");
     const muteButton = document.querySelector("#mute-button");
     const muteIcon = muteButton?.querySelector("svg");
     const danmakuButton = document.querySelector("#dock-danmaku");
     if (danmakuButton?.getAttribute("aria-pressed") !== "true") {
       danmakuButton?.click();
     }
     voiceSettingsButton?.click();
     const voiceSettingsAnimated =
       voiceSettingsPanel?.dataset.presence === "entering" &&
       voiceSettingsPanel.getAnimations().length > 0;
     await new Promise((resolve) => setTimeout(resolve, 420));
     const voiceSettingsRect = voiceSettingsPanel?.getBoundingClientRect();
     const voiceSettingsOpen = Boolean(
       voiceSettingsPanel &&
       !voiceSettingsPanel.hidden &&
       voiceSettingsPanel.classList.contains("voice-settings-visible") &&
       getComputedStyle(voiceSettingsPanel).visibility === "visible" &&
       voiceSettingsRect &&
       voiceSettingsRect.height > 100
     );
     voiceSettingsButton?.click();
     await new Promise((resolve) => setTimeout(resolve, 420));
    const movieVolume = document.querySelector("#dock-volume");
    if (movieVolume) {
      movieVolume.value = "0.37";
      movieVolume.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const processAudioStatus =
      await window.roomDesktop?.getProcessAudioStatus();
    const chatLog = document.querySelector("#chat-log");
    const jumpLatest = document.querySelector("#chat-jump-latest");
    const chatScrollPreserved = (chatLog?.scrollTop || 0) < 10;
    const chatUnreadText =
      document.querySelector("#chat-unread-count")?.textContent || "";
    jumpLatest?.click();
    const chatJumpedToBottom = chatLog
      ? chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight <= 36
      : false;
    return {
      participants: document.querySelectorAll(".participant-row").length,
      volumeControlsBeforeClick: before,
      volumeControlsAfterClick: document.querySelectorAll(".participant-volume-control").length,
      moderationButtons: document.querySelectorAll("[data-moderation-action]").length,
      chatHeight: Math.round(chatRect?.height || 0),
      chatBottom: Math.round(chatRect?.bottom || 0),
      sidebarBottom: Math.round(sidebarRect?.bottom || 0),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      timestampCount: document.querySelectorAll(".chat-message .chat-timestamp").length,
      timestampText: document.querySelector(".chat-message .chat-timestamp")?.textContent,
      chatScrollPreserved,
      chatUnreadText,
      chatJumpedToBottom,
      chatScrollTop: chatLog?.scrollTop,
      chatScrollHeight: chatLog?.scrollHeight,
      chatClientHeight: chatLog?.clientHeight,
      localDanmakuCount: document.querySelectorAll(".danmaku").length,
      appFocused: document.hasFocus(),
      danmakuTopPositions,
      danmakuRounded:
        danmakuItems.length > 0
          ? Number.parseFloat(getComputedStyle(danmakuItems[0]).borderRadius) >= 12
          : false,
      danmakuPosition: danmakuStyle?.position,
      danmakuZIndex: Number(danmakuStyle?.zIndex),
      danmakuViewportWidth: Math.round(danmakuRect?.width || 0),
      danmakuViewportTop: Math.round(danmakuRect?.top || 0),
      danmakuViewportBottom: Math.round(
        innerHeight - (danmakuRect?.bottom || 0),
      ),
      danmakuViewportRight: Math.round(
        innerWidth - (danmakuRect?.right || 0),
      ),
      danmakuStageTopDelta: Math.round(
        (danmakuRect?.top || 0) - (stageRect?.top || 0),
      ),
      danmakuStageBottomDelta: Math.round(
        (danmakuRect?.bottom || 0) - (stageRect?.bottom || 0),
      ),
      movieVolumeControl: Boolean(document.querySelector("#movie-volume-control")),
      movieVolumePersisted: localStorage.getItem("synced:movie-volume"),
      movieVolumeValue: document.querySelector("#movie-volume-value")?.textContent,
      embyViewerTimeline: Boolean(document.querySelector("#stage-progress")),
      playbackDockInsideStage:
        stage?.contains(document.querySelector("#stage-dock")) === true,
      playbackProgressInsideStage:
        stage?.contains(document.querySelector("#stage-progress")) === true,
      legacyFullscreenControlsAbsent:
        !document.querySelector(
          "#fullscreen-controls, #fullscreen-fit, #exit-fullscreen",
        ),
      unifiedFullscreenActions:
        Boolean(document.querySelector("#dock-more-menu #dock-smart-crop")) &&
        Boolean(document.querySelector("#stage-dock #dock-fullscreen")),
      pictureInPictureControl: Boolean(
        document.querySelector("#dock-pip svg"),
      ),
      pictureInPictureInMoreMenu: Boolean(
        document.querySelector("#dock-more-menu #dock-pip"),
      ),
      pictureInPictureLabel:
        document.querySelector("#dock-pip")?.getAttribute("aria-label"),
      pictureInPictureState:
        document.querySelector("#dock-pip .mini-window-state")?.textContent,
      pictureInPictureInitiallyChecked:
        document.querySelector("#dock-pip")?.getAttribute("aria-checked"),
      pictureInPictureInitiallyVisible:
        !document.querySelector("#dock-pip")?.hidden,
      pictureInPictureInitiallyDisabled:
        document.querySelector("#dock-pip")?.disabled === true,
      documentedDockControls: [
        "#dock-danmaku",
        "#dock-chat",
      ].every((selector) => {
        const control = document.querySelector(selector);
        return Boolean(
          control?.getAttribute("title") &&
            control?.getAttribute("data-tooltip"),
        );
      }),
      obsoletePanelToggleAbsent:
        !document.querySelector("#panel-toggle"),
      danmakuIconClear:
        Boolean(danmakuButton?.querySelector(".lucide-message-square-text")),
      danmakuActiveVisible:
        danmakuButton?.getAttribute("aria-pressed") === "true" &&
        getComputedStyle(danmakuButton).backgroundColor !==
          "rgba(0, 0, 0, 0)",
       chatInputWidth: Math.round(chatInputRect?.width || 0),
       chatInputHeight: Math.round(chatInputRect?.height || 0),
       chatInputOutline: chatInputStyle?.outlineStyle,
       chatInputRadius: Number.parseFloat(chatInputStyle?.borderRadius || "0"),
       chatComposerAligned:
         Boolean(chatInputRect && chatEmojiRect && chatSendRect) &&
         chatInputRect.right <= chatEmojiRect.left + 1 &&
         chatEmojiRect.right <= chatSendRect.left + 1,
       chatEmojiWidth: Math.round(chatEmojiRect?.width || 0),
       voiceSettingsAnimated,
       voiceSettingsOpen,
       voiceSettingsClosed:
         voiceSettingsPanel?.hidden === true &&
         voiceSettingsButton?.getAttribute("aria-expanded") === "false",
       voiceSettingsInsideCard:
         Boolean(voiceSettingsPanel) &&
         document.querySelector(".voice-card")?.contains(voiceSettingsPanel),
       muteIconPresent:
         Boolean(muteIcon) &&
         muteIcon.classList.contains("lucide-mic-off"),
       muteButtonWidth:
         Math.round(muteButton?.getBoundingClientRect().width || 0),
       muteIconWidth:
         Math.round(muteIcon?.getBoundingClientRect().width || 0),
       lobbyInteractive:
         lobby?.classList.contains("interactive-card") === true,
       lobbyPointerLight:
         lobby?.style.getPropertyValue("--pointer-opacity") === "1",
      lobbyStarsPresent:
         lobbyStars instanceof HTMLCanvasElement &&
         Number(lobbyStars?.dataset.starCount || 0) >= 18 &&
         Number(lobbyStars?.dataset.starCount || 0) < 80,
       lobbyStarsMoving:
         lobbyStarFrameAfter > lobbyStarFrameBefore,
       obsoleteLobbyDotsAbsent:
         document.querySelectorAll(".lobby-light-field > i").length === 0,
       windowsBroadcastCopyAbsent:
         !document.querySelector(".session-header")?.textContent
           ?.includes("任意 Windows 成员可放映"),
       obsoleteStageBadgesAbsent:
        !document.querySelector("#local-stage-badge") &&
        !document.querySelector("#audio-route-badge"),
      semanticDockGroups: [
        ".dock-transport",
        ".dock-audio",
        ".dock-social",
        ".dock-view",
      ].every((selector) => Boolean(document.querySelector(selector))),
      obsoleteVoiceDiagnosticsAbsent:
        !document.querySelector("#voice-quality"),
      pictureInPictureWindowBridge:
        typeof window.roomDesktop?.setMiniWindowEnabled === "function" &&
        typeof window.roomDesktop?.restoreFromPictureInPicture === "function" &&
        typeof window.roomDesktop?.onMainWindowRestored === "function",
      processAudioDiagnosticsBridge:
        typeof window.roomDesktop?.startProcessAudio === "function" &&
        typeof window.roomDesktop?.stopProcessAudio === "function" &&
        typeof window.roomDesktop?.getProcessAudioStatus === "function" &&
        typeof window.roomDesktop?.onProcessAudioData === "function" &&
        typeof window.roomDesktop?.onProcessAudioStatus === "function",
      processAudioIdleStatus: processAudioStatus && {
        active: processAudioStatus.active,
        starting: processAudioStatus.starting,
        captureId: processAudioStatus.captureId,
      },
      pictureInPictureSupported:
        document.pictureInPictureEnabled === true &&
        typeof document.querySelector("#channel-video")?.requestPictureInPicture === "function",
    };
  })()`);
  const screenshotPath = path.join(os.tmpdir(), "synced-sidebar-smoke.png");
  fs.writeFileSync(screenshotPath, await mainWindow.webContents.capturePage().then((image) => image.toPNG()));
  const voiceSettingsScreenshotPath = path.join(
    os.tmpdir(),
    "synced-voice-settings-smoke.png",
  );
  await mainWindow.webContents.executeJavaScript(`(async () => {
    const toggle = document.querySelector("#voice-settings-toggle");
    if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
  })()`);
  fs.writeFileSync(
    voiceSettingsScreenshotPath,
    await mainWindow.webContents.capturePage().then((image) => image.toPNG()),
  );
  await mainWindow.webContents.executeJavaScript(`(async () => {
    const toggle = document.querySelector("#voice-settings-toggle");
    if (toggle?.getAttribute("aria-expanded") === "true") toggle?.click();
    await new Promise((resolve) => setTimeout(resolve, 420));
  })()`);
  const lobbyPanelLayout =
    await mainWindow.webContents.executeJavaScript(`(async () => {
       const body = document.body;
       const stage = document.querySelector("#player-stage");
       const toggle = document.querySelector("#session-companion");
       body.classList.remove("mode-theater", "mode-immersive", "panel-collapsed");
       body.classList.add("mode-lobby", "is-lobby", "panel-open");
      await new Promise((resolve) => setTimeout(resolve, 420));
      const expandedWidth = stage?.getBoundingClientRect().width || 0;
      toggle?.click();
      await new Promise((resolve) => setTimeout(resolve, 420));
       const collapsedWidth = stage?.getBoundingClientRect().width || 0;
       const collapsed = body.classList.contains("panel-collapsed");
       const collapsedAria =
         toggle?.getAttribute("aria-expanded") === "false" &&
         toggle?.getAttribute("aria-pressed") === "false";
       toggle?.click();
       await new Promise((resolve) => setTimeout(resolve, 420));
       const reopened =
         !body.classList.contains("panel-collapsed") &&
         toggle?.getAttribute("aria-expanded") === "true" &&
         toggle?.getAttribute("aria-pressed") === "true";
       return {
         expandedWidth,
         collapsedWidth,
         collapsed,
         collapsedAria,
         reopened,
       };
    })()`);
  const theaterPanelLayout =
    await mainWindow.webContents.executeJavaScript(`(async () => {
       const body = document.body;
       const stage = document.querySelector("#player-stage");
       const dock = document.querySelector("#stage-dock");
       const toggle = document.querySelector("#session-companion");
      body.classList.remove("mode-lobby", "mode-immersive", "panel-collapsed");
      body.classList.add("mode-theater", "panel-open");
      if (dock) dock.hidden = false;
      await new Promise((resolve) => setTimeout(resolve, 420));
      const expandedWidth = stage?.getBoundingClientRect().width || 0;
      const expandedStageRect = stage?.getBoundingClientRect();
      const expandedDockRect = dock?.getBoundingClientRect();
      const expandedDockCenterDelta =
        (expandedDockRect?.left || 0) +
        (expandedDockRect?.width || 0) / 2 -
        ((expandedStageRect?.left || 0) +
          (expandedStageRect?.width || 0) / 2);
      toggle?.click();
      await new Promise((resolve) => setTimeout(resolve, 420));
      const collapsedWidth = stage?.getBoundingClientRect().width || 0;
      const collapsedStageRect = stage?.getBoundingClientRect();
      const collapsedDockRect = dock?.getBoundingClientRect();
      const collapsedDockCenterDelta =
        (collapsedDockRect?.left || 0) +
        (collapsedDockRect?.width || 0) / 2 -
        ((collapsedStageRect?.left || 0) +
          (collapsedStageRect?.width || 0) / 2);
      const collapsed = body.classList.contains("panel-collapsed");
      toggle?.click();
      await new Promise((resolve) => setTimeout(resolve, 420));
      if (dock) dock.hidden = true;
      body.classList.remove("mode-theater");
      body.classList.add("mode-lobby", "is-lobby");
      return {
        expandedWidth,
        collapsedWidth,
        collapsed,
        expandedDockCenterDelta,
        collapsedDockCenterDelta,
      };
    })()`);
  mainWindow.setIgnoreMouseEvents(true);
  const dockAutoHidden =
    await mainWindow.webContents.executeJavaScript(`(async () => {
      const body = document.body;
      const dock = document.querySelector("#stage-dock");
      const hud = document.querySelector("#hud-bar");
      body.classList.remove("mode-lobby", "mode-immersive", "is-lobby");
      body.classList.add("mode-theater");
      if (dock) {
        dock.hidden = false;
        dock.style.pointerEvents = "none";
      }
      document.activeElement?.blur();
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true })
      );
      await new Promise((resolve) => setTimeout(resolve, 3400));
      const result = {
        dockHidden: dock?.classList.contains("is-hidden") === true,
        dockGlassReleased:
          dock?.classList.contains("material-released") === true,
        hudHidden: hud?.classList.contains("is-hidden") === true,
        hudGlassReleased:
          hud?.classList.contains("material-released") === true,
      };
      if (dock) {
        dock.style.pointerEvents = "";
        dock.hidden = true;
        dock.classList.remove("is-hidden", "material-released");
      }
      hud?.classList.remove("is-hidden", "material-released");
      body.classList.remove("mode-theater");
      body.classList.add("mode-lobby", "is-lobby");
      return result;
    })()`);
  mainWindow.setIgnoreMouseEvents(false);
  const fullscreenLayout = await mainWindow.webContents.executeJavaScript(`(async () => {
    const stage = document.querySelector("#player-stage");
    const dock = document.querySelector("#stage-dock");
    const progress = document.querySelector("#stage-progress");
    if (!stage || !dock || !progress) {
      return { error: "unified fullscreen controls are missing" };
    }
    dock.hidden = false;
    progress.hidden = false;
    dock.classList.remove("is-hidden", "material-released");
    progress.classList.remove("is-hidden");
    document.body.classList.remove(
      "immersive-player",
      "fullscreen-controls-hidden",
    );
    await stage.requestFullscreen();
    document.body.classList.add("fullscreen-controls-hidden");
    const hiddenBeforePointerMove =
      document.body.classList.contains("fullscreen-controls-hidden");
    stage.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    const revealedByPointerMove =
      !document.body.classList.contains("fullscreen-controls-hidden");
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    const dockRect = dock.getBoundingClientRect();
    const progressRect = progress.getBoundingClientRect();
    const dockStyle = getComputedStyle(dock);
    const progressStyle = getComputedStyle(progress);
    const moreButton = document.querySelector("#dock-more");
    if (moreButton?.getAttribute("aria-expanded") !== "true") {
      moreButton?.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 420));
    const moreMenu = document.querySelector("#dock-more-menu");
    const moreMenuRect = moreMenu?.getBoundingClientRect();
    const moreMenuStyle = moreMenu
      ? getComputedStyle(moreMenu)
      : undefined;
    return {
      fullscreenElementIsStage: document.fullscreenElement === stage,
      hiddenBeforePointerMove,
      revealedByPointerMove,
      dockInsideStage: stage.contains(dock),
      progressInsideStage: stage.contains(progress),
      legacyControlsAbsent:
        !document.querySelector(
          "#fullscreen-controls, #fullscreen-fit, #exit-fullscreen",
        ),
      smartCropInMoreMenu: Boolean(
        document.querySelector("#dock-more-menu #dock-smart-crop"),
      ),
      moreMenuOpen:
        moreMenu?.hidden === false &&
        moreButton?.getAttribute("aria-expanded") === "true",
      moreMenuInsideFullscreen:
        Boolean(moreMenu) && stage.contains(moreMenu),
      moreMenuVisible:
        moreMenuStyle?.display !== "none" &&
        Number(moreMenuStyle?.opacity || "0") > 0.9,
      moreMenuWithinViewport:
        Boolean(moreMenuRect) &&
        moreMenuRect.left >= -1 &&
        moreMenuRect.top >= -1 &&
        moreMenuRect.right <= innerWidth + 1 &&
        moreMenuRect.bottom <= innerHeight + 1,
      fullscreenInDock: dock.contains(document.querySelector("#dock-fullscreen")),
      controlsVisible:
        dockStyle.display !== "none" &&
        Number(dockStyle.opacity) > 0.5 &&
        dockStyle.pointerEvents !== "none",
      progressVisible:
        progressStyle.display !== "none" &&
        Number(progressStyle.opacity) > 0.5,
      dockCenterDelta:
        dockRect.left + dockRect.width / 2 - innerWidth / 2,
      dockBottom: innerHeight - dockRect.bottom,
      progressAboveDock: progressRect.bottom <= dockRect.top + 1,
    };
  })()`, true);
  const fullscreenScreenshotPath = path.join(
    os.tmpdir(),
    "synced-fullscreen-controls-smoke.png",
  );
  fs.writeFileSync(
    fullscreenScreenshotPath,
    await mainWindow.webContents.capturePage().then((image) => image.toPNG()),
  );
  await mainWindow.webContents.executeJavaScript(`(async () => {
    const moreButton = document.querySelector("#dock-more");
    if (moreButton?.getAttribute("aria-expanded") === "true") {
      moreButton.click();
      await new Promise((resolve) => setTimeout(resolve, 420));
    }
    moreButton?.blur();
  })()`);
  // Start the idle window after capturePage; Electron may synthesize a pointer
  // update while capturing the visible window and legitimately reset the timer.
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector("#player-stage")?.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true })
    )`,
  );
  // Keep the physical cursor from injecting a real movement while the
  // deterministic idle timeout is under test.
  mainWindow.setIgnoreMouseEvents(true);
  await new Promise((resolve) => setTimeout(resolve, 3_400));
  mainWindow.setIgnoreMouseEvents(false);
  const fullscreenAutoHidden =
    await mainWindow.webContents.executeJavaScript(`(async () => {
      const stage = document.querySelector("#player-stage");
      const dock = document.querySelector("#stage-dock");
      const progress = document.querySelector("#stage-progress");
      const dockStyle = dock ? getComputedStyle(dock) : undefined;
      const progressStyle = progress ? getComputedStyle(progress) : undefined;
      const result = {
        bodyHidden:
          document.body.classList.contains("fullscreen-controls-hidden"),
        fullscreenElementWasStage: document.fullscreenElement === stage,
        dockOpacity: Number(dockStyle?.opacity || "1"),
        dockPointerEvents: dockStyle?.pointerEvents || "",
        progressOpacity: Number(progressStyle?.opacity || "1"),
        progressPointerEvents: progressStyle?.pointerEvents || "",
      };
      if (document.fullscreenElement) await document.exitFullscreen();
      if (dock) {
        dock.hidden = true;
        dock.classList.remove("is-hidden", "material-released");
      }
      if (progress) {
        progress.hidden = true;
        progress.classList.remove("is-hidden");
      }
      document.body.classList.remove(
        "immersive-player",
        "fullscreen-controls-hidden",
      );
      return result;
    })()`, true);
  await mainWindow.webContents.executeJavaScript(`(() => {
    window.__miniWindowRestoreEvents = 0;
    window.__removeMiniWindowRestoreListener =
      window.roomDesktop.onMainWindowRestored(() => {
        window.__miniWindowRestoreEvents += 1;
      });
  })()`);
  await mainWindow.webContents.executeJavaScript(`(async () => {
      const video = document.querySelector("#channel-video");
      const button = document.querySelector("#dock-pip");
      if (!video || !button) return false;
      if (!window.__miniWindowTestStream) {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d");
        const draw = () => {
          context.fillStyle = "#181d2a";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#53e0da";
          context.fillRect(32, 32, 180, 92);
        };
        draw();
        window.__miniWindowTestTimer = setInterval(draw, 40);
        window.__miniWindowTestStream = canvas.captureStream(25);
        video.srcObject = window.__miniWindowTestStream;
        video.muted = true;
        video.hidden = false;
        await video.play();
        button.click();
      }
      return true;
    })()`);
  let lastMiniWindowVideoState;
  const miniWindowVideoReady = await waitFor(async () => {
    lastMiniWindowVideoState =
      await mainWindow.webContents.executeJavaScript(`(() => {
        const video = document.querySelector("#channel-video");
        const button = document.querySelector("#dock-pip");
        return {
          readyState: video?.readyState,
          hidden: video?.hidden,
          hasStream: Boolean(video?.srcObject),
          disabled: button?.disabled,
          checked: button?.getAttribute("aria-checked"),
          state: button?.querySelector(".mini-window-state")?.textContent,
          ready:
            Boolean(video) &&
            Boolean(button) &&
        video.readyState >= HTMLMediaElement.HAVE_METADATA &&
        button.getAttribute("aria-checked") === "true" &&
            button.querySelector(".mini-window-state")?.textContent === "开",
        };
      })()`);
    return lastMiniWindowVideoState.ready;
  }).catch((error) => {
    throw new Error(
      `${error.message}: ${JSON.stringify(lastMiniWindowVideoState)}`,
    );
  });
  const miniWindowOnScreenshotPath = path.join(
    os.tmpdir(),
    "synced-mini-window-on-smoke.png",
  );
  fs.writeFileSync(
    miniWindowOnScreenshotPath,
    await mainWindow.webContents
      .capturePage()
      .then((image) => image.toPNG()),
  );
  mainWindow.minimize();
  await waitFor(() => mainWindow.isMinimized());
  const miniWindowEnteredOnMinimize = await waitFor(() =>
    mainWindow.webContents.executeJavaScript(
      "document.pictureInPictureElement?.id === 'channel-video'",
    ),
  );
  mainWindow.restore();
  await waitFor(() => !mainWindow.isMinimized());
  const miniWindowExitedOnRestore = await waitFor(() =>
    mainWindow.webContents.executeJavaScript(
      "document.pictureInPictureElement === null",
    ),
  );
  const miniWindowStateAfterRestore =
    await mainWindow.webContents.executeJavaScript(`(() => {
      const button = document.querySelector("#dock-pip");
      return {
        checked: button?.getAttribute("aria-checked"),
        state: button?.querySelector(".mini-window-state")?.textContent,
        disabled: button?.disabled,
        pictureInPictureActive: Boolean(document.pictureInPictureElement),
        stored: localStorage.getItem("synced:mini-window-enabled"),
      };
    })()`);
  const miniWindowDisabledState =
    await mainWindow.webContents.executeJavaScript(`(async () => {
      const button = document.querySelector("#dock-pip");
      await new Promise((resolve) => setTimeout(resolve, 100));
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        checked: button?.getAttribute("aria-checked"),
        state: button?.querySelector(".mini-window-state")?.textContent,
        disabled: button?.disabled,
        pictureInPictureActive: Boolean(document.pictureInPictureElement),
        stored: localStorage.getItem("synced:mini-window-enabled"),
      };
    })()`);
  mainWindow.minimize();
  await waitFor(() => mainWindow.isMinimized());
  const miniWindowStayedClosedWhenDisabled =
    await mainWindow.webContents.executeJavaScript(
      "document.pictureInPictureElement === null",
    );
  mainWindow.restore();
  await waitFor(() => !mainWindow.isMinimized());
  const miniWindowRestoreEvents = await waitFor(() =>
    mainWindow.webContents.executeJavaScript(
      "window.__miniWindowRestoreEvents || 0",
    ),
  );
  await mainWindow.webContents.executeJavaScript(
    `(() => {
      window.__removeMiniWindowRestoreListener?.();
      clearInterval(window.__miniWindowTestTimer);
      window.__miniWindowTestStream?.getTracks().forEach((track) => track.stop());
      delete window.__miniWindowTestTimer;
      delete window.__miniWindowTestStream;
    })()`,
  );
  const mobileScreenshotPath = path.join(
    os.tmpdir(),
    "synced-mobile-375x812-smoke.png",
  );
  mainWindow.setMinimumSize(320, 480);
  mainWindow.setContentSize(375, 812);
  let mobileLayout;
  let mobileInlineAfterToggleLayout;
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    mobileLayout = await mainWindow.webContents.executeJavaScript(`(async () => {
      document.body.classList.add("native-android");
      await new Promise((resolve) => setTimeout(resolve, 420));
      const shell = document.querySelector(".session-shell");
      if (shell) shell.scrollTop = 0;
      const rail = document.querySelector(".session-rail");
      const stage = document.querySelector("#player-stage");
      const header = document.querySelector(".session-header");
      const panel = document.querySelector(".companion-panel");
      const panelSection = panel?.querySelector("section");
      const chat = document.querySelector("#chat-panel");
      const membersPanel = document.querySelector("#member-panel");
      const dock = document.querySelector("#stage-dock");
      if (dock) {
        dock.hidden = false;
        dock.classList.remove("is-hidden", "material-released");
      }
      document.body.classList.remove("fullscreen-controls-hidden");
      const fullscreen = document.querySelector("#dock-fullscreen");
      if (fullscreen) fullscreen.disabled = false;
      const dockChat = document.querySelector("#dock-chat");
      dockChat?.click();
      await new Promise((resolve) => setTimeout(resolve, 240));
      const quickChat = document.querySelector("#dock-chat-composer");
      const quickChatInput = document.querySelector("#dock-chat-input");
      const quickChatSend = document.querySelector("#dock-chat-send");
      const quickChatClose = document.querySelector("#dock-chat-close");
      const headerIdentity = header?.querySelector(":scope > div:first-child");
      const profileButton = document.querySelector("#session-profile");
      const shellRect = shell?.getBoundingClientRect();
      const railRect = rail?.getBoundingClientRect();
      const stageRect = stage?.getBoundingClientRect();
      const headerRect = header?.getBoundingClientRect();
      const headerIdentityRect = headerIdentity?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      const chatRect = chat?.getBoundingClientRect();
      const membersRect = membersPanel?.getBoundingClientRect();
      const dockRect = dock?.getBoundingClientRect();
      const fullscreenRect = fullscreen?.getBoundingClientRect();
      const quickChatRect = quickChat?.getBoundingClientRect();
      const quickChatInputRect = quickChatInput?.getBoundingClientRect();
      const quickChatSendRect = quickChatSend?.getBoundingClientRect();
      const quickChatCloseRect = quickChatClose?.getBoundingClientRect();
      const stageStyle = stage ? getComputedStyle(stage) : undefined;
      const panelStyle = panel ? getComputedStyle(panel) : undefined;
      const dockStyle = dock ? getComputedStyle(dock) : undefined;
      const fullscreenStyle = fullscreen
        ? getComputedStyle(fullscreen)
        : undefined;
      const quickChatStyle = quickChat
        ? getComputedStyle(quickChat)
        : undefined;
      const quickChatActiveElementId = document.activeElement?.id || "";
      return {
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        outerWidth,
        screenWidth: screen.width,
        devicePixelRatio,
        visualViewportWidth: visualViewport?.width || 0,
        media599: matchMedia("(max-width: 599px)").matches,
        scrollWidth: document.documentElement.scrollWidth,
        shellWidth: shellRect?.width || 0,
        shellScrollHeight: shell?.scrollHeight || 0,
        shellOverflowY: shell ? getComputedStyle(shell).overflowY : "",
        railPosition: rail ? getComputedStyle(rail).position : "",
        railHeight: railRect?.height || 0,
        railBottom: railRect ? innerHeight - railRect.bottom : 999,
        stageWidth: stageRect?.width || 0,
        stageLeft: stageRect?.left || 0,
        stageHeight: stageRect?.height || 0,
        stageTop: stageRect?.top || 0,
        stagePosition: stage ? getComputedStyle(stage).position : "",
        stageComputedHeight: stageStyle?.height || "",
        stageMaxHeight: stageStyle?.maxHeight || "",
        stageMinHeight: stageStyle?.minHeight || "",
        stageAspectRatio: stageStyle?.aspectRatio || "",
        headerHeight: headerRect?.height || 0,
        headerLeft: headerRect?.left || 0,
        headerWidth: headerRect?.width || 0,
        headerIdentityLeft: headerIdentityRect?.left || 0,
        bodyClasses: document.body.className,
        panelWidth: panelRect?.width || 0,
        panelLeft: panelRect?.left || 0,
        panelPosition: panelStyle?.position || "",
        panelTransform: panelStyle?.transform || "",
        panelOverflow: panelStyle?.overflow || "",
        panelSectionVisibility: panelSection
          ? getComputedStyle(panelSection).visibility
          : "",
        chatVisibility: chat ? getComputedStyle(chat).visibility : "",
        membersVisibility: membersPanel
          ? getComputedStyle(membersPanel).visibility
          : "",
        chatTop: chatRect?.top || 0,
        chatBottom: chatRect?.bottom || 0,
        membersTop: membersRect?.top || 0,
        stageBottom: stageRect?.bottom || 0,
        chatBeforeMembers:
          Boolean(chat && membersPanel) &&
          Boolean(
            chat.compareDocumentPosition(membersPanel) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        obsoletePanelToggleAbsent:
          !document.querySelector("#panel-toggle"),
        dockOverflowX: dockStyle?.overflowX || "",
        dockClientWidth: dock?.clientWidth || 0,
        dockScrollWidth: dock?.scrollWidth || 0,
        dockLeft: dockRect?.left || 0,
        dockRight: dockRect?.right || 0,
        fullscreenLeft: fullscreenRect?.left || 0,
        fullscreenRight: fullscreenRect?.right || 0,
        fullscreenWidth: fullscreenRect?.width || 0,
        fullscreenHeight: fullscreenRect?.height || 0,
        fullscreenDisplay: fullscreenStyle?.display || "",
        fullscreenOpacity: Number(fullscreenStyle?.opacity || "0"),
        fullscreenPointerEvents: fullscreenStyle?.pointerEvents || "",
        quickChatInsideStage:
          Boolean(stage && quickChat) && stage.contains(quickChat),
        quickChatHidden: quickChat?.hidden !== false,
        quickChatExpanded: dockChat?.getAttribute("aria-expanded"),
        quickChatOpacity: Number(quickChatStyle?.opacity || "0"),
        quickChatPointerEvents: quickChatStyle?.pointerEvents || "",
        quickChatLeft: quickChatRect?.left || 0,
        quickChatRight: quickChatRect?.right || 0,
        quickChatBottom: quickChatRect?.bottom || 0,
        quickChatAboveDock:
          Boolean(quickChatRect && dockRect) &&
          quickChatRect.bottom <= dockRect.top + 1,
        quickChatInputFocused:
          quickChatActiveElementId === (quickChatInput?.id || ""),
        quickChatInputHeight: quickChatInputRect?.height || 0,
        quickChatSendHeight: quickChatSendRect?.height || 0,
        quickChatCloseWidth: quickChatCloseRect?.width || 0,
        quickChatCloseHeight: quickChatCloseRect?.height || 0,
        lowPriorityDockControlsHidden: [
          "#dock-rewind",
          "#dock-forward",
          "#dock-quality",
          "#dock-emby-settings",
          "#dock-smart-crop",
          "#dock-pip",
        ].every((selector) => {
          const control = document.querySelector(selector);
          return !control || getComputedStyle(control).display === "none";
        }),
        touchTargetHeight: profileButton?.getBoundingClientRect().height || 0,
      };
    })()`);
    mobileInlineAfterToggleLayout =
      await mainWindow.webContents.executeJavaScript(`(async () => {
        const toggle = document.querySelector("#session-companion");
        toggle?.click();
        await new Promise((resolve) => setTimeout(resolve, 420));
        const panel = document.querySelector(".companion-panel");
        const panelSection = panel?.querySelector("section");
        const chat = document.querySelector("#chat-panel");
        const members = document.querySelector("#member-panel");
        const scrim = document.querySelector("#companion-scrim");
        const rect = panel?.getBoundingClientRect();
        const style = panel ? getComputedStyle(panel) : undefined;
        return {
          bodyClasses: document.body.className,
          toggleExpanded: toggle?.getAttribute("aria-expanded"),
          panelPosition: style?.position || "",
          panelTransform: style?.transform || "",
          panelPointerEvents: style?.pointerEvents || "",
          panelWidth: rect?.width || 0,
          panelHeight: rect?.height || 0,
          panelLeft: rect?.left || 0,
          panelBottomGap: rect ? innerHeight - rect.bottom : 999,
          panelSectionVisibility: panelSection
            ? getComputedStyle(panelSection).visibility
            : "",
          chatVisibility: chat ? getComputedStyle(chat).visibility : "",
          membersVisibility: members ? getComputedStyle(members).visibility : "",
          scrimAbsent: !scrim,
        };
      })()`);
    fs.writeFileSync(
      mobileScreenshotPath,
      await mainWindow.webContents.capturePage().then((image) => image.toPNG()),
    );
    await mainWindow.webContents.executeJavaScript(
      "document.body.classList.remove('native-android')",
    );
  } finally {
    mainWindow.setMinimumSize(920, 650);
    mainWindow.setSize(1440, 900);
  }
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('#leave-room')?.click()",
  );
  await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript("Boolean(document.querySelector('#choose-host'))")
      .catch(() => false),
  );
  members.forEach((socket) => socket.close());
  await signalServer.close();
  if (
    setupLayout.cardWidth < 360 ||
    !setupLayout.legacySplitCopyAbsent ||
    setupLayout.fieldMetrics.length !== 2 ||
    setupLayout.fieldMetrics.some(
      (field) =>
        field.height < field.inputHeight + 20 ||
        field.captionBottom > field.inputTop,
    ) ||
    setupLayout.buttonGap < 0 ||
    setupLayout.railEmptyDisplay !== "none" ||
    setupLayout.horizontalOverflow > 1 ||
    !inviteLayout.open ||
    inviteLayout.left < 0 ||
    inviteLayout.right > inviteLayout.viewportWidth + 1 ||
    inviteLayout.top < 0 ||
    inviteLayout.bottom > inviteLayout.viewportHeight + 1 ||
    Math.abs(inviteLayout.centerDelta) > 2 ||
    !inviteLayout.opaqueSurface ||
    !inviteLayout.closeInsideHeader ||
    !inviteLayout.contentBelowHeader ||
    !inviteLayout.codeAndQrAligned ||
    !inviteLayout.actionsBelowContent ||
    result.participants !== 3 ||
    result.volumeControlsBeforeClick !== 0 ||
    result.volumeControlsAfterClick !== 1 ||
    result.moderationButtons < 2 ||
    result.chatHeight < 280 ||
    result.chatBottom > result.viewportHeight ||
    result.timestampCount < 1 ||
    !result.chatScrollPreserved ||
    !result.chatUnreadText ||
    !result.chatJumpedToBottom ||
    !/^\d{2}:\d{2}$/.test(result.timestampText || "") ||
    // While the app is focused, its full viewport is the visible no-broadcast
    // danmaku surface. The protected native overlay takes over only after the
    // user switches to another program.
    !result.appFocused ||
    result.localDanmakuCount < 1 ||
    !result.danmakuRounded ||
    (result.danmakuTopPositions.length > 1 &&
      result.danmakuTopPositions.some(
        (top, index, positions) =>
          index > 0 && top - positions[index - 1] < 40,
      )) ||
    result.danmakuPosition !== "fixed" ||
    result.danmakuZIndex < 2 ||
    Math.abs(result.danmakuViewportWidth - result.viewportWidth) > 2 ||
    Math.abs(result.danmakuViewportRight) > 2 ||
    Math.abs(result.danmakuViewportTop) > 2 ||
    Math.abs(result.danmakuViewportBottom) > 2 ||
    !result.movieVolumeControl ||
    result.movieVolumePersisted !== "0.35" ||
    result.movieVolumeValue !== "35%" ||
    !result.embyViewerTimeline ||
    !result.playbackDockInsideStage ||
    !result.playbackProgressInsideStage ||
    !result.legacyFullscreenControlsAbsent ||
    !result.unifiedFullscreenActions ||
    !result.pictureInPictureControl ||
    !result.documentedDockControls ||
    !result.obsoletePanelToggleAbsent ||
    !result.danmakuIconClear ||
    !result.danmakuActiveVisible ||
    result.chatInputOutline !== "none" ||
    result.chatInputRadius < 8 ||
    result.chatInputWidth < 180 ||
    result.chatInputHeight < 44 ||
    !result.chatComposerAligned ||
    result.chatEmojiWidth < 44 ||
    !result.voiceSettingsAnimated ||
    !result.voiceSettingsOpen ||
    !result.voiceSettingsClosed ||
    !result.voiceSettingsInsideCard ||
    !result.muteIconPresent ||
    result.muteButtonWidth < 44 ||
    result.muteIconWidth < 18 ||
    !result.lobbyInteractive ||
    !result.lobbyPointerLight ||
    !result.lobbyStarsPresent ||
    !result.lobbyStarsMoving ||
    !result.obsoleteLobbyDotsAbsent ||
    !result.windowsBroadcastCopyAbsent ||
    !result.obsoleteStageBadgesAbsent ||
    !result.semanticDockGroups ||
    !result.obsoleteVoiceDiagnosticsAbsent ||
    !result.pictureInPictureInMoreMenu ||
    !result.pictureInPictureLabel?.includes("小窗模式") ||
    result.pictureInPictureState !== "关" ||
    result.pictureInPictureInitiallyChecked !== "false" ||
    !result.pictureInPictureInitiallyVisible ||
    result.pictureInPictureInitiallyDisabled ||
    !result.pictureInPictureWindowBridge ||
    !result.processAudioDiagnosticsBridge ||
    result.processAudioIdleStatus?.active !== false ||
    result.processAudioIdleStatus?.starting !== false ||
    !result.pictureInPictureSupported ||
    !miniWindowVideoReady ||
    !miniWindowEnteredOnMinimize ||
    !miniWindowExitedOnRestore ||
    miniWindowStateAfterRestore.checked !== "true" ||
    miniWindowStateAfterRestore.state !== "开" ||
    miniWindowDisabledState.checked !== "false" ||
    miniWindowDisabledState.state !== "关" ||
    !miniWindowStayedClosedWhenDisabled ||
    Boolean(fullscreenLayout.error) ||
    !fullscreenLayout.fullscreenElementIsStage ||
    !fullscreenLayout.hiddenBeforePointerMove ||
    !fullscreenLayout.revealedByPointerMove ||
    !fullscreenLayout.dockInsideStage ||
    !fullscreenLayout.progressInsideStage ||
    !fullscreenLayout.legacyControlsAbsent ||
    !fullscreenLayout.smartCropInMoreMenu ||
    !fullscreenLayout.moreMenuOpen ||
    !fullscreenLayout.moreMenuInsideFullscreen ||
    !fullscreenLayout.moreMenuVisible ||
    !fullscreenLayout.moreMenuWithinViewport ||
    !fullscreenLayout.fullscreenInDock ||
    !fullscreenLayout.controlsVisible ||
    !fullscreenLayout.progressVisible ||
    Math.abs(fullscreenLayout.dockCenterDelta) > 3 ||
    fullscreenLayout.dockBottom > 40 ||
    !fullscreenLayout.progressAboveDock ||
    miniWindowRestoreEvents < 2 ||
    !fullscreenAutoHidden.bodyHidden ||
    !fullscreenAutoHidden.fullscreenElementWasStage ||
    fullscreenAutoHidden.dockOpacity > 0.05 ||
    fullscreenAutoHidden.dockPointerEvents !== "none" ||
    fullscreenAutoHidden.progressOpacity > 0.05 ||
    fullscreenAutoHidden.progressPointerEvents !== "none" ||
    !lobbyPanelLayout.collapsed ||
    !lobbyPanelLayout.collapsedAria ||
    !lobbyPanelLayout.reopened ||
    lobbyPanelLayout.collapsedWidth - lobbyPanelLayout.expandedWidth < 240 ||
    !theaterPanelLayout.collapsed ||
    theaterPanelLayout.collapsedWidth - theaterPanelLayout.expandedWidth < 240 ||
    Math.abs(theaterPanelLayout.expandedDockCenterDelta) > 3 ||
    Math.abs(theaterPanelLayout.collapsedDockCenterDelta) > 3 ||
    !dockAutoHidden.dockHidden ||
    !dockAutoHidden.dockGlassReleased ||
    !dockAutoHidden.hudHidden ||
    !dockAutoHidden.hudGlassReleased ||
    mobileLayout.viewportWidth < 374 ||
    mobileLayout.viewportWidth > 377 ||
    mobileLayout.viewportHeight !== 812 ||
    !mobileLayout.media599 ||
    mobileLayout.scrollWidth > 377 ||
    Math.abs(mobileLayout.shellWidth - mobileLayout.viewportWidth) > 2 ||
    mobileLayout.shellScrollHeight + 1 < mobileLayout.viewportHeight ||
    mobileLayout.shellOverflowY !== "auto" ||
    mobileLayout.railPosition !== "fixed" ||
    mobileLayout.railHeight < 52 ||
    Math.abs(mobileLayout.railBottom) > 2 ||
    Math.abs(mobileLayout.stageWidth - mobileLayout.viewportWidth) > 2 ||
    Math.abs(mobileLayout.stageLeft) > 2 ||
    Math.abs(
      mobileLayout.stageHeight - (mobileLayout.viewportWidth * 9) / 16,
    ) > 2 ||
    mobileLayout.stageAspectRatio !== "16 / 9" ||
    mobileLayout.stagePosition !== "relative" ||
    Math.abs(mobileLayout.stageTop) > 2 ||
    mobileLayout.headerHeight < 56 ||
    mobileLayout.headerHeight > 72 ||
    Math.abs(mobileLayout.headerLeft) > 2 ||
    Math.abs(mobileLayout.headerWidth - mobileLayout.viewportWidth) > 2 ||
    mobileLayout.headerIdentityLeft < 0 ||
    Math.abs(mobileLayout.panelWidth - mobileLayout.viewportWidth) > 2 ||
    Math.abs(mobileLayout.panelLeft) > 2 ||
    !mobileLayout.bodyClasses.includes("panel-inline") ||
    !mobileLayout.bodyClasses.includes("panel-open") ||
    mobileLayout.bodyClasses.includes("panel-mobile-sheet") ||
    mobileLayout.bodyClasses.includes("panel-collapsed") ||
    mobileLayout.panelPosition !== "static" ||
    mobileLayout.panelTransform !== "none" ||
    mobileLayout.panelSectionVisibility !== "visible" ||
    mobileLayout.chatVisibility !== "visible" ||
    mobileLayout.membersVisibility !== "visible" ||
    !mobileLayout.chatBeforeMembers ||
    !mobileLayout.obsoletePanelToggleAbsent ||
    mobileLayout.chatTop < mobileLayout.stageBottom - 1 ||
    mobileLayout.membersTop < mobileLayout.chatBottom - 1 ||
    mobileLayout.dockOverflowX !== "auto" ||
    mobileLayout.dockLeft < -1 ||
    mobileLayout.dockRight > mobileLayout.viewportWidth + 1 ||
    mobileLayout.fullscreenLeft < -1 ||
    mobileLayout.fullscreenRight > mobileLayout.viewportWidth + 1 ||
    mobileLayout.fullscreenWidth < 44 ||
    mobileLayout.fullscreenHeight < 44 ||
    mobileLayout.fullscreenDisplay === "none" ||
    mobileLayout.fullscreenOpacity < 0.9 ||
    mobileLayout.fullscreenPointerEvents === "none" ||
    !mobileLayout.quickChatInsideStage ||
    mobileLayout.quickChatHidden ||
    mobileLayout.quickChatExpanded !== "true" ||
    mobileLayout.quickChatOpacity < 0.9 ||
    mobileLayout.quickChatPointerEvents === "none" ||
    mobileLayout.quickChatLeft < -1 ||
    mobileLayout.quickChatRight > mobileLayout.viewportWidth + 1 ||
    mobileLayout.quickChatBottom > mobileLayout.stageBottom + 1 ||
    !mobileLayout.quickChatAboveDock ||
    !mobileLayout.quickChatInputFocused ||
    mobileLayout.quickChatInputHeight < 43 ||
    mobileLayout.quickChatSendHeight < 43 ||
    mobileLayout.quickChatCloseWidth < 43 ||
    mobileLayout.quickChatCloseHeight < 43 ||
    mobileLayout.lowPriorityDockControlsHidden ||
    mobileLayout.touchTargetHeight < 43 ||
    !mobileInlineAfterToggleLayout.bodyClasses.includes("panel-inline") ||
    !mobileInlineAfterToggleLayout.bodyClasses.includes("panel-open") ||
    mobileInlineAfterToggleLayout.bodyClasses.includes("panel-collapsed") ||
    mobileInlineAfterToggleLayout.bodyClasses.includes("panel-mobile-sheet") ||
    mobileInlineAfterToggleLayout.toggleExpanded !== "true" ||
    mobileInlineAfterToggleLayout.panelPosition !== "static" ||
    mobileInlineAfterToggleLayout.panelTransform !== "none" ||
    mobileInlineAfterToggleLayout.panelPointerEvents === "none" ||
    Math.abs(
      mobileInlineAfterToggleLayout.panelWidth - mobileLayout.viewportWidth,
    ) > 2 ||
    Math.abs(mobileInlineAfterToggleLayout.panelLeft) > 2 ||
    mobileInlineAfterToggleLayout.panelHeight < 600 ||
    mobileInlineAfterToggleLayout.panelSectionVisibility !== "visible" ||
    mobileInlineAfterToggleLayout.chatVisibility !== "visible" ||
    mobileInlineAfterToggleLayout.membersVisibility !== "visible" ||
    !mobileInlineAfterToggleLayout.scrimAbsent
  ) {
    throw new Error(
      `sidebar validation failed: ${JSON.stringify({
         setupLayout,
         inviteLayout,
        result,
        fullscreenLayout,
        fullscreenAutoHidden,
        lobbyPanelLayout,
        theaterPanelLayout,
        dockAutoHidden,
        mobileLayout,
        mobileInlineAfterToggleLayout,
        miniWindowRestoreEvents,
        miniWindowVideoReady,
        miniWindowEnteredOnMinimize,
        miniWindowExitedOnRestore,
        miniWindowStateAfterRestore,
        miniWindowDisabledState,
        miniWindowStayedClosedWhenDisabled,
      })}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      room,
       setupLayout,
       setupScreenshotPath,
       inviteLayout,
       inviteScreenshotPath,
      screenshotPath,
      voiceSettingsScreenshotPath,
      fullscreenScreenshotPath,
      fullscreenLayout,
      fullscreenAutoHidden,
      lobbyPanelLayout,
      theaterPanelLayout,
      dockAutoHidden,
      mobileScreenshotPath,
      mobileLayout,
      mobileInlineAfterToggleLayout,
      miniWindowRestoreEvents,
      miniWindowOnScreenshotPath,
      miniWindowVideoReady,
      miniWindowEnteredOnMinimize,
      miniWindowExitedOnRestore,
      miniWindowStateAfterRestore,
      miniWindowDisabledState,
      miniWindowStayedClosedWhenDisabled,
      ...result,
    })}\n`,
  );
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    app.exit(1);
  });
