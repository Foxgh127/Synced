const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const WebSocket = require("ws");

const projectRoot = path.join(__dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const portable =
  process.env.SYNCED_PORTABLE_EXE ||
  path.join(
    projectRoot,
    "release",
    "windows-dist",
    `Synced-${packageJson.version}-portable.exe`,
  );
const profile = path.join(
  os.tmpdir(),
  `synced-portable-smoke-${process.pid}-${Date.now()}`,
);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("无法分配调试端口"));
      });
    });
  });
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(1_000, () =>
      request.destroy(new Error("CDP 请求超时")),
    );
    request.once("error", reject);
  });
}

async function waitForDebugger(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [version, targets] = await Promise.all([
        requestJson(`http://127.0.0.1:${port}/json/version`),
        requestJson(`http://127.0.0.1:${port}/json/list`),
      ]);
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          typeof target.webSocketDebuggerUrl === "string",
      );
      if (page && version.webSocketDebuggerUrl) {
        return {
          browserUrl: version.webSocketDebuggerUrl,
          pageUrl: page.webSocketDebuggerUrl,
        };
      }
    } catch {
      // Portable extraction and Electron startup are still in progress.
    }
    await delay(250);
  }
  throw new Error("便携版在 45 秒内没有开放渲染器调试端口");
}

function cdpCommand(webSocketUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`${method} 超时`));
    }, 8_000);
    socket.once("open", () => {
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
    socket.once("message", (payload) => {
      const message = JSON.parse(payload.toString());
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function waitForRenderer(webSocketUrl, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    const evaluation = await cdpCommand(
      webSocketUrl,
      "Runtime.evaluate",
      {
        expression: `(() => ({
          readyState: document.readyState,
          title: document.title,
          uiVersion: document.documentElement.dataset.uiVersion || "",
          hasAppFrame: Boolean(document.querySelector(".app-frame")),
          hasPrimaryAction: Boolean(
            document.querySelector("#choose-host, #host-form, #viewer-form")
          ),
          horizontalOverflow: Math.max(
            0,
            document.documentElement.scrollWidth -
              document.documentElement.clientWidth
          )
        }))()`,
        returnByValue: true,
      },
    );
    state = evaluation.result?.value;
    if (
      state?.readyState === "complete" &&
      state.uiVersion === "luminous-3" &&
      state.hasAppFrame &&
      state.hasPrimaryAction
    ) {
      return state;
    }
    await delay(100);
  }
  return state;
}

function terminateTree(child) {
  if (!child || child.exitCode !== null) return;
  spawnSync(
    "taskkill.exe",
    ["/PID", String(child.pid), "/T", "/F"],
    { stdio: "ignore", windowsHide: true },
  );
}

function cleanupProfile() {
  const resolved = path.resolve(profile);
  if (
    path.dirname(resolved) === path.resolve(os.tmpdir()) &&
    path.basename(resolved).startsWith("synced-portable-smoke-")
  ) {
    fs.rmSync(resolved, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 150,
    });
  }
}

async function main() {
  if (!fs.existsSync(portable)) {
    throw new Error(`便携包不存在：${portable}`);
  }
  const port = await findOpenPort();
  const child = spawn(
    portable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--disable-gpu",
    ],
    {
      env: {
        ...process.env,
        SYNCED_SKIP_FIREWALL_REPAIR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let browserUrl;
  try {
    const debuggerUrls = await waitForDebugger(port);
    browserUrl = debuggerUrls.browserUrl;
    const state = await waitForRenderer(debuggerUrls.pageUrl);
    if (
      !state ||
      state.readyState !== "complete" ||
      state.uiVersion !== "luminous-3" ||
      !state.hasAppFrame ||
      !state.hasPrimaryAction ||
      state.horizontalOverflow > 1
    ) {
      throw new Error(`便携版渲染状态不合格：${JSON.stringify(state)}`);
    }
    console.log(
      JSON.stringify({
        ok: true,
        portable,
        version: packageJson.version,
        state,
      }),
    );
  } catch (error) {
    const details = Buffer.concat(stderr).toString("utf8").trim();
    if (details) console.error(details.slice(-4_000));
    throw error;
  } finally {
    if (browserUrl) {
      await cdpCommand(browserUrl, "Browser.close").catch(() => undefined);
    }
    if (!(await waitForExit(child, 8_000))) terminateTree(child);
    cleanupProfile();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
