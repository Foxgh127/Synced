const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const VIEWPORTS = [
  [320, 568],
  [360, 800],
  [412, 915],
  [600, 960],
  [768, 1024],
  [1024, 768],
  [1280, 720],
  [1366, 768],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
];
const WINDOWS_DPI_FACTORS = [1, 1.25, 1.5, 1.75, 2];
const SCREENSHOT_DPI_VIEWPORT = [1366, 768];
const OUTPUT_DIRECTORY =
  process.env.SYNCED_DESIGN_MATRIX_OUTPUT ||
  path.join(os.tmpdir(), "synced-design-matrix");
const INDEX_PATH = path.join(
  __dirname,
  "..",
  "dist-renderer",
  "index.html",
);
const PRELOAD_PATH = path.join(__dirname, "..", "electron", "preload.cjs");

app.commandLine.appendSwitch("force-color-profile", "srgb");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDesignLab(window, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await window.webContents
      .executeJavaScript(
        `Boolean(
          document.querySelector(".design-lab") &&
          document.fonts.status === "loaded"
        )`,
      )
      .catch(() => false);
    if (ready) return;
    await delay(80);
  }
  throw new Error("Design Lab did not become ready");
}

async function waitForSelector(window, selector, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await window.webContents
      .executeJavaScript(
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      )
      .catch(() => false);
    if (ready) return;
    await delay(80);
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function settleLayout(window) {
  await window.webContents.executeJavaScript(
    `new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )`,
  );
  await delay(40);
}

async function resetScroll(window) {
  await window.webContents.executeJavaScript(`(() => {
    const scroller = document.scrollingElement;
    if (scroller) scroller.scrollTop = 0;
  })()`);
  await settleLayout(window);
}

async function setViewport(window, width, height, zoomFactor) {
  window.webContents.setZoomFactor(zoomFactor);
  window.setContentSize(width, height, false);
  await settleLayout(window);
}

async function inspectLayout(window) {
  return window.webContents.executeJavaScript(`(() => {
    const documentElement = document.documentElement;
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const outliers = [...document.body.querySelectorAll("*")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector:
            element.id
              ? "#" + element.id
              : element.classList.length
                ? element.tagName.toLowerCase() + "." +
                  [...element.classList].slice(0, 2).join(".")
                : element.tagName.toLowerCase(),
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
        };
      })
      .filter(({ left, right }) => left < -1 || right > innerWidth + 1)
      .slice(0, 12);
    const undersizedControls = [
      ...document.querySelectorAll(
        "button, input:not([type='checkbox']):not([type='radio']), select, [role='button']",
      ),
    ]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector:
            element.id
              ? "#" + element.id
              : element.classList.length
                ? element.tagName.toLowerCase() + "." +
                  [...element.classList].slice(0, 2).join(".")
                : element.tagName.toLowerCase(),
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        };
      })
      .filter(({ width, height }) => width < 43 || height < 43)
      .slice(0, 12);
    return {
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
      },
      document: {
        clientWidth: documentElement.clientWidth,
        scrollWidth: documentElement.scrollWidth,
        scrollHeight: documentElement.scrollHeight,
      },
      horizontalOverflow:
        documentElement.scrollWidth - documentElement.clientWidth,
      outliers,
      undersizedControls,
      uiVersion: documentElement.dataset.uiVersion,
      effectsQuality: documentElement.dataset.effectsQuality,
    };
  })()`);
}

async function capture(window, filename) {
  const image = await window.webContents.capturePage();
  const size = image.getSize();
  const buffer = image.toPNG();
  if (size.width <= 0 || size.height <= 0 || buffer.byteLength < 1_024) {
    throw new Error(`Empty screenshot: ${filename}`);
  }
  fs.writeFileSync(path.join(OUTPUT_DIRECTORY, filename), buffer);
  return { ...size, bytes: buffer.byteLength };
}

async function captureSection(window, selector, filename) {
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({
      block: "start",
      behavior: "instant",
    })`,
  );
  await settleLayout(window);
  return capture(window, filename);
}

async function applyPreferences(window, preferences) {
  await window.webContents.executeJavaScript(`(() => {
    const controls = ${JSON.stringify(preferences)};
    for (const [selector, value] of Object.entries(controls)) {
      const control = document.querySelector(selector);
      if (!control) throw new Error("Missing preference control: " + selector);
      if (control instanceof HTMLInputElement && control.type === "checkbox") {
        control.checked = Boolean(value);
      } else {
        control.value = String(value);
      }
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }
  })()`);
  await settleLayout(window);
}

async function main() {
  if (!fs.existsSync(INDEX_PATH)) {
    throw new Error("Build the renderer before running the design matrix");
  }
  fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  await app.whenReady();
  ipcMain.on("channel-owner:load", (event) => {
    event.returnValue = undefined;
  });
  ipcMain.on("channel-owner:save", (event) => {
    event.returnValue = true;
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    useContentSize: true,
    show: false,
    backgroundColor: "#05070b",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  window.setMinimumSize(1, 1);
  await window.loadFile(INDEX_PATH, {
    query: { "design-lab": "1" },
  });
  await waitForDesignLab(window);

  const report = {
    generatedAt: new Date().toISOString(),
    outputDirectory: OUTPUT_DIRECTORY,
    measurements: [],
    screenshots: [],
  };
  const failures = [];

  for (const [width, height] of VIEWPORTS) {
    for (const zoomFactor of WINDOWS_DPI_FACTORS) {
      await setViewport(window, width, height, zoomFactor);
      await resetScroll(window);
      const metrics = await inspectLayout(window);
      const label = `${width}x${height}@${zoomFactor}`;
      report.measurements.push({ label, metrics });
      if (metrics.horizontalOverflow > 1 || metrics.outliers.length > 0) {
        failures.push(
          `${label}: horizontal overflow ${metrics.horizontalOverflow}px; ` +
            `outliers ${JSON.stringify(metrics.outliers)}`,
        );
      }
      if (metrics.undersizedControls.length > 0) {
        failures.push(
          `${label}: controls below 44px ${JSON.stringify(
            metrics.undersizedControls,
          )}`,
        );
      }
    }

    await setViewport(window, width, height, 1);
    await resetScroll(window);
    report.screenshots.push({
      label: `${width}x${height}@1`,
      image: await capture(window, `viewport-${width}x${height}.png`),
    });
  }

  for (const zoomFactor of WINDOWS_DPI_FACTORS.slice(1)) {
    const [width, height] = SCREENSHOT_DPI_VIEWPORT;
    await setViewport(window, width, height, zoomFactor);
    await resetScroll(window);
    report.screenshots.push({
      label: `${width}x${height}@${zoomFactor}`,
      image: await capture(
        window,
        `dpi-${Math.round(zoomFactor * 100)}-${width}x${height}.png`,
      ),
    });
  }

  await setViewport(window, 1280, 900, 1);
  for (const [selector, filename] of [
    ["#lab-state-title", "states-interaction.png"],
    ["#lab-feedback-title", "states-feedback.png"],
    ["#lab-validation-title", "states-validation.png"],
  ]) {
    report.screenshots.push({
      label: selector,
      image: await captureSection(window, selector, filename),
    });
  }

  for (const [name, preferences] of [
    [
      "reduced-motion",
      {
        "#lab-motion": "reduced",
        "#lab-transparency": "auto",
        "#lab-high-contrast": false,
      },
    ],
    [
      "reduced-transparency",
      {
        "#lab-motion": "full",
        "#lab-transparency": "reduced",
        "#lab-high-contrast": false,
      },
    ],
    [
      "high-contrast",
      {
        "#lab-motion": "full",
        "#lab-transparency": "auto",
        "#lab-high-contrast": true,
      },
    ],
  ]) {
    await applyPreferences(window, preferences);
    await resetScroll(window);
    report.screenshots.push({
      label: name,
      image: await capture(window, `preference-${name}.png`),
    });
  }

  await window.webContents.executeJavaScript(
    "localStorage.removeItem('synced:appearance-v3')",
  );
  await window.loadFile(INDEX_PATH);
  await waitForSelector(window, "#choose-host");
  for (const [width, height] of [
    [320, 568],
    [1280, 800],
  ]) {
    await setViewport(window, width, height, 1);
    await resetScroll(window);
    const homeMetrics = await inspectLayout(window);
    const homeLabel = `home-${width}x${height}`;
    report.measurements.push({ label: homeLabel, metrics: homeMetrics });
    if (
      homeMetrics.horizontalOverflow > 1 ||
      homeMetrics.outliers.length > 0 ||
      homeMetrics.undersizedControls.length > 0
    ) {
      failures.push(`${homeLabel}: ${JSON.stringify(homeMetrics)}`);
    }
    report.screenshots.push({
      label: homeLabel,
      image: await capture(window, `${homeLabel}.png`),
    });

    await window.webContents.executeJavaScript(
      "document.querySelector('#choose-host')?.click()",
    );
    await waitForSelector(window, "#start-share");
    await delay(320);
    const createMetrics = await inspectLayout(window);
    const createLabel = `create-${width}x${height}`;
    report.measurements.push({ label: createLabel, metrics: createMetrics });
    if (
      createMetrics.horizontalOverflow > 1 ||
      createMetrics.outliers.length > 0 ||
      createMetrics.undersizedControls.length > 0
    ) {
      failures.push(`${createLabel}: ${JSON.stringify(createMetrics)}`);
    }
    report.screenshots.push({
      label: createLabel,
      image: await capture(window, `${createLabel}.png`),
    });

    await window.webContents.executeJavaScript(
      "document.querySelector('[data-back-home]')?.click()",
    );
    await waitForSelector(window, "#choose-viewer");
    await window.webContents.executeJavaScript(
      "document.querySelector('#choose-viewer')?.click()",
    );
    await waitForSelector(window, "#join-room");
    await delay(320);
    const joinMetrics = await inspectLayout(window);
    const joinLabel = `join-${width}x${height}`;
    report.measurements.push({ label: joinLabel, metrics: joinMetrics });
    if (
      joinMetrics.horizontalOverflow > 1 ||
      joinMetrics.outliers.length > 0 ||
      joinMetrics.undersizedControls.length > 0
    ) {
      failures.push(`${joinLabel}: ${JSON.stringify(joinMetrics)}`);
    }
    report.screenshots.push({
      label: joinLabel,
      image: await capture(window, `${joinLabel}.png`),
    });

    await window.webContents.executeJavaScript(
      "document.querySelector('[data-back-home]')?.click()",
    );
    await waitForSelector(window, "#choose-host");
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIRECTORY, "report.json"),
    JSON.stringify(report, null, 2),
  );
  window.destroy();
  await app.quit();

  if (failures.length > 0) {
    throw new Error(
      `Design matrix failed:\n${failures.slice(0, 20).join("\n")}`,
    );
  }
  process.stdout.write(
    `Design matrix passed: ${report.measurements.length} layout checks, ` +
      `${report.screenshots.length} screenshots\n${OUTPUT_DIRECTORY}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
