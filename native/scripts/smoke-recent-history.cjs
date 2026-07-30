const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temporaryUserData = fs.mkdtempSync(
  path.join(os.tmpdir(), "yiqikan-recent-history-"),
);
app.setPath("userData", temporaryUserData);

function withTimeout(promise, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        10_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function waitForLoad(window) {
  await new Promise((resolve, reject) => {
    window.webContents.once("did-finish-load", resolve);
    window.webContents.once("did-fail-load", (_event, code, description) => {
      reject(new Error(`renderer load failed (${code}): ${description}`));
    });
  });
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await withTimeout(
      window.loadFile(
        path.join(__dirname, "..", "dist-renderer", "index.html"),
      ),
      "initial renderer load",
    );
    await withTimeout(
      window.webContents.executeJavaScript(`localStorage.setItem(
        "yiqikan:recent-channels",
        JSON.stringify([{
          room: "TEST2345",
          name: "右键删除测试",
          signalUrl: "ws://47.98.173.139:8787/signal",
          lastJoinedAt: Date.now()
        }])
      )`),
      "history seed",
    );
    const reloaded = waitForLoad(window);
    window.webContents.reload();
    await withTimeout(reloaded, "renderer reload");

    const result = await withTimeout(
      window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector("[data-recent-room='TEST2345']");
      const openMenu = () => button?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2
      }));
      const count = () =>
        JSON.parse(localStorage.getItem("yiqikan:recent-channels") || "[]").length;

      openMenu();
      const openedByRightClick = Boolean(
        document.querySelector("[data-recent-delete-dialog]")
      );
      const unchangedBeforeChoice = count() === 1;
      document.querySelector("[data-cancel-recent-delete]")?.click();
      const cancelKeptHistory =
        count() === 1 &&
        !document.querySelector("[data-recent-delete-dialog]");

      openMenu();
      document.querySelector("[data-confirm-recent-delete]")?.click();
      return {
        openedByRightClick,
        unchangedBeforeChoice,
        cancelKeptHistory,
        confirmRemovedHistory:
          count() === 0 &&
          !document.querySelector("[data-recent-room='TEST2345']")
      };
    })()`),
      "right-click interaction",
    );

    if (Object.values(result).some((value) => value !== true)) {
      throw new Error(`recent history validation failed: ${JSON.stringify(result)}`);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } finally {
    window.destroy();
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    app.exit(1);
  });
