const { app, BrowserWindow } = require("electron");
const path = require("node:path");

async function main() {
  await app.whenReady();
  const overlay = new BrowserWindow({
    width: 960,
    height: 540,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "electron", "overlay-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await overlay.loadFile(
      path.join(__dirname, "..", "electron", "overlay.html"),
    );
    overlay.webContents.send("overlay:danmaku", {
      nickname: "朋友",
      text: "<img src=x onerror=alert(1)> HDR 测试",
      mine: false,
    });
    overlay.webContents.send("overlay:danmaku", {
      nickname: "我",
      text: "第二条弹幕保持垂直间距",
      mine: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const result = await overlay.webContents.executeJavaScript(`(() => {
      const items = [...document.querySelectorAll(".message")];
      const item = items[0];
      const topPositions = items
        .map((entry) => Math.round(entry.getBoundingClientRect().top))
        .sort((left, right) => left - right);
      return {
        count: items.length,
        text: item?.textContent,
        htmlImages: item?.querySelectorAll("img").length || 0,
        animation: item ? getComputedStyle(item).animationName : "",
        borderRadius: item
          ? Number.parseFloat(getComputedStyle(item).borderRadius)
          : 0,
        topPositions,
        pointerEvents: getComputedStyle(document.body).pointerEvents
      };
    })()`);
    if (
      result.count !== 2 ||
      result.htmlImages !== 0 ||
      result.animation !== "fly" ||
      result.borderRadius < 16 ||
      result.topPositions[1] - result.topPositions[0] < 48 ||
      result.pointerEvents !== "none"
    ) {
      throw new Error(`overlay validation failed: ${JSON.stringify(result)}`);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } finally {
    overlay.destroy();
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    app.exit(1);
  });
