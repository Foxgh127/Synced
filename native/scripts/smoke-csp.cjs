"use strict";

const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const CSP_VIOLATION =
  /content security policy|refused to apply inline style|applying inline style/iu;

function consoleMessage(args) {
  const detail =
    args.length === 1 && typeof args[0] === "object"
      ? args[0]
      : { message: args[1] };
  return String(detail?.message || "");
}

async function run() {
  await app.whenReady();
  const violations = [];
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.on("console-message", (_event, ...args) => {
    const message = consoleMessage(args);
    if (CSP_VIOLATION.test(message)) {
      violations.push(message);
    }
  });

  try {
    await window.loadFile(
      path.join(__dirname, "..", "dist-renderer", "index.html"),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const inlinePropertyWorks = await window.webContents.executeJavaScript(`(() => {
      const probe = document.createElement("div");
      probe.style.position = "fixed";
      probe.style.width = "7px";
      document.body.appendChild(probe);
      const worked = getComputedStyle(probe).width === "7px";
      probe.remove();
      return worked;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!inlinePropertyWorks) {
      throw new Error("CSP blocked element.style property updates");
    }
    if (violations.length > 0) {
      throw new Error(
        `renderer emitted ${violations.length} CSP violation(s): ${violations[0]}`,
      );
    }
    process.stdout.write("CSP smoke passed.\n");
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(`CSP smoke failed: ${error.stack || error}\n`);
    app.exit(1);
  });
