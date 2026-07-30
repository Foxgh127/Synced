process.env.SYNCED_E2E = "1";

const { app, BrowserWindow, screen } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

require("../electron/main.cjs");

async function waitFor(read, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("desktop danmaku smoke test timed out");
}

async function main() {
  await app.whenReady();
  const serverModuleUrl = pathToFileURL(
    path.join(__dirname, "..", "server", "index.mjs"),
  ).href;
  const { createSignalServer } = await import(serverModuleUrl);
  const signalServer = createSignalServer();
  const address = await signalServer.listen(0, "127.0.0.1");
  const signalUrl = `ws://127.0.0.1:${address.port}/signal`;
  const mainWindow = await waitFor(() =>
    BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.isDestroyed() &&
        !candidate.webContents.getURL().endsWith("/overlay.html"),
    ),
  );
  await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript("Boolean(window.roomDesktop)")
      .catch(() => false),
  );
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('#choose-host')?.click()",
  );
  await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript("Boolean(document.querySelector('#start-share'))")
      .catch(() => false),
  );
  await mainWindow.webContents.executeJavaScript(`(() => {
    document.querySelector("#host-signal-url").value = ${JSON.stringify(signalUrl)};
    document.querySelector("#start-share")?.click();
  })()`);
  const joinedWithoutVoice = await waitFor(() =>
    mainWindow.webContents
      .executeJavaScript(`(() => {
        const voice = document.querySelector("#voice-button");
        const stage = document.querySelector("#channel-empty");
        const desktopState =
          document.querySelector("#danmaku-surface-state")?.textContent || "";
        const signalState =
          document.querySelector("#hud-signal-text")?.textContent || "";
        return voice &&
          stage &&
          signalState.includes("已连接") &&
          desktopState.includes("光影交织，共此时光")
          ? {
              voiceActive: voice.classList.contains("connected"),
              desktopState
            }
          : null;
      })()`)
      .catch(() => null),
  );

  await mainWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector("#chat-input");
    const form = document.querySelector("#chat-form");
    input.value = "我在 B 点，需要支援";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  })()`);

  const overlay = await waitFor(() =>
    BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.isDestroyed() &&
        candidate.webContents.getURL().endsWith("/overlay.html"),
    ),
  );
  const rendered = await waitFor(() =>
    overlay.webContents
      .executeJavaScript(`(() => {
        const message = document.querySelector(".message");
        return message ? {
          count: document.querySelectorAll(".message").length,
          text: message.textContent,
          pointerEvents: getComputedStyle(document.body).pointerEvents
        } : null;
      })()`)
      .catch(() => null),
  );
  const displayBounds = screen.getDisplayMatching(mainWindow.getBounds()).bounds;
  const overlayBounds = overlay.getBounds();
  const boundsMatch =
    Math.abs(overlayBounds.x - displayBounds.x) <= 1 &&
    Math.abs(overlayBounds.y - displayBounds.y) <= 1 &&
    Math.abs(overlayBounds.width - displayBounds.width) <= 1 &&
    Math.abs(overlayBounds.height - displayBounds.height) <= 1;

  await mainWindow.webContents.executeJavaScript(
    "window.roomDesktop.setDesktopDanmakuActive(false)",
  );
  await waitFor(() => !overlay.isVisible());
  const cleared = await overlay.webContents.executeJavaScript(
    "document.querySelectorAll('.message').length",
  );

  const result = {
    visibleAcrossDisplay: boundsMatch,
    displayBounds,
    overlayBounds,
    clickThrough: rendered.pointerEvents === "none",
    message: rendered.text,
    voiceInactive: joinedWithoutVoice.voiceActive === false,
    automaticModeLabel: joinedWithoutVoice.desktopState,
    hiddenAfterBroadcastStarts: !overlay.isVisible(),
    cleared,
  };
  if (
    !boundsMatch ||
    rendered.count !== 1 ||
    rendered.pointerEvents !== "none" ||
    !rendered.text.includes("我在 B 点，需要支援") ||
    joinedWithoutVoice.voiceActive ||
    !joinedWithoutVoice.desktopState.includes("光影交织，共此时光") ||
    overlay.isVisible() ||
    cleared !== 0
  ) {
    throw new Error(`desktop danmaku validation failed: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  await signalServer.close();
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    app.exit(1);
  });
