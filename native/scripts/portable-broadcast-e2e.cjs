const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const sharp = require("sharp");
const WebSocket = require("ws");
const {
  buildAndroidDeepLinkArgs,
  buildHealthConfig,
  findUiNode,
  mobileNetworkDetected,
  receiverHealthIssues,
  receiverObservationExpression,
  senderHealthIssues,
  senderObservationExpression,
  summarizeReceiverObservation,
  summarizeSenderObservation,
} = require("./portable-broadcast-e2e-utils.cjs");

const projectRoot = path.join(__dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const healthConfig = buildHealthConfig();
const portable =
  process.env.SYNCED_PORTABLE_EXE ||
  path.join(
    projectRoot,
    "release",
    "windows-dist",
    `Synced-${packageJson.version}-portable.exe`,
  );
const sourceTitle =
  process.env.SYNCED_E2E_SOURCE_TITLE ||
  "Synced Native Process Audio Smoke";
const launchTestSource =
  process.env.SYNCED_E2E_USE_TEST_SOURCE === "1" ||
  (!process.env.SYNCED_E2E_SOURCE_TITLE &&
    process.env.SYNCED_E2E_USE_TEST_SOURCE !== "0");
const targetResolution = process.env.SYNCED_E2E_RESOLUTION || "高清";
const targetFrameRate = process.env.SYNCED_E2E_FRAME_RATE || "60";
const debugPort = Number(process.env.SYNCED_E2E_PORT || 9339);
const phoneE2e = process.env.SYNCED_E2E_PHONE === "1";
const switchPhoneNetwork =
  process.env.SYNCED_E2E_SWITCH_NETWORK === "1";
const phoneDebugPort = Number(process.env.SYNCED_PHONE_DEBUG_PORT || 9341);
const signalUrl =
  process.env.SYNCED_E2E_SIGNAL || "wss://synced.com.cn/signal";
const androidPackage =
  process.env.SYNCED_ANDROID_PACKAGE || "com.synced.room";
const adbSerial = process.env.SYNCED_ADB_SERIAL?.trim();
const liveChildren = new Set();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    request.once("error", reject);
    request.setTimeout(1_000, () => request.destroy(new Error("timeout")));
  });
}

function runCommand(file, args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    const errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${file} 执行超时`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(output).toString("utf8").trim();
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      if (code === 0) resolve(stdout);
      else reject(new Error(`${file} 退出 ${code}：${stderr || stdout}`));
    });
  });
}

function runCommandBuffer(file, args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    const errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${file} 执行超时`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(output);
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `${file} 退出 ${code}：${stderr || stdout.toString("utf8").trim()}`,
          ),
        );
    });
  });
}

function adb(args, timeoutMs) {
  return runCommand(
    "adb",
    adbSerial ? ["-s", adbSerial, ...args] : args,
    timeoutMs,
  );
}

function adbBuffer(args, timeoutMs) {
  return runCommandBuffer(
    "adb",
    adbSerial ? ["-s", adbSerial, ...args] : args,
    timeoutMs,
  );
}

async function readPhoneUi() {
  return adb(
    ["exec-out", "uiautomator", "dump", "/dev/tty"],
    15_000,
  );
}

async function phoneScreenFrame(stage) {
  const png = await adbBuffer(["exec-out", "screencap", "-p"], 15_000);
  const metadata = await sharp(png).metadata();
  const imageWidth = Number(metadata.width || 0);
  const imageHeight = Number(metadata.height || 0);
  if (!imageWidth || !imageHeight) throw new Error("Android 截屏尺寸为空");
  const left = Math.max(0, Math.min(imageWidth - 1, Number(stage?.left || 0)));
  const top = Math.max(0, Math.min(imageHeight - 1, Number(stage?.top || 0)));
  const width = Math.max(
    1,
    Math.min(imageWidth - left, Number(stage?.width || imageWidth)),
  );
  const height = Math.max(
    1,
    Math.min(imageHeight - top, Number(stage?.height || imageHeight)),
  );
  const { data, info } = await sharp(png)
    .extract({ left, top, width, height })
    .resize(64, 36, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let lumaTotal = 0;
  let brightPixels = 0;
  const count = info.width * info.height;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const luma =
      data[offset] * 0.2126 +
      data[offset + 1] * 0.7152 +
      data[offset + 2] * 0.0722;
    lumaTotal += luma;
    if (luma > 18) brightPixels += 1;
  }
  const averageLuma = lumaTotal / count;
  const brightRatio = brightPixels / count;
  return {
    averageLuma,
    brightRatio,
    nearBlack: averageLuma < 8 && brightRatio < 0.015,
    sourceWidth: imageWidth,
    sourceHeight: imageHeight,
  };
}

async function samplePhoneScreen(stage, durationMs, intervalMs) {
  const samples = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt <= durationMs) {
    samples.push({ at: Date.now(), ...(await phoneScreenFrame(stage)) });
    if (Date.now() - startedAt >= durationMs) break;
    await delay(intervalMs);
  }
  const nearBlackSamples = samples.filter((sample) => sample.nearBlack).length;
  return {
    sampleCount: samples.length,
    nearBlackSamples,
    nearBlackRatio: samples.length ? nearBlackSamples / samples.length : 1,
    averageLuma: samples.length
      ? samples.reduce((sum, sample) => sum + sample.averageLuma, 0) /
        samples.length
      : 0,
    samples,
  };
}

async function waitForPage(timeoutMs = 45_000) {
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
      // The portable launcher may still be extracting on its first run.
    }
    await delay(200);
  }
  throw new Error("便携版调试页面启动超时");
}

function createCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  socket.on("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("便携版调试连接已经关闭"));
    }
    pending.clear();
  });
  socket.on("error", (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  });
  return {
    socket,
    ready: new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    send(method, params = {}, timeoutMs = 15_000) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} 执行超时`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
  };
}

function rtcProbeScript(repairLegacySdp = false) {
  return `(() => {
    if (window.__syncedE2eRtcProbeInstalled) return true;
    if (${repairLegacySdp ? "true" : "false"}) {
      const nativeSend = window.WebSocket?.prototype?.send;
      if (nativeSend && !window.__syncedE2eWebSocketRepair) {
        window.WebSocket.prototype.send = function(payload) {
          let outgoing = payload;
          try {
            const message = JSON.parse(String(payload));
            if (
              message?.type === 'signal' &&
              message?.data?.sdp &&
              !message.data.type
            ) {
              message.data.type =
                message.target === 'host' || message.target === 'broadcaster'
                  ? 'answer'
                  : 'offer';
              outgoing = JSON.stringify(message);
            }
          } catch {
            // Preserve non-JSON WebSocket traffic unchanged.
          }
          return nativeSend.call(this, outgoing);
        };
        window.__syncedE2eWebSocketRepair = true;
      }
    }
    const NativePeerConnection = window.RTCPeerConnection;
    if (!NativePeerConnection) return false;
    const peers = [];
    class ProbedPeerConnection extends NativePeerConnection {
      constructor(...args) {
        super(...args);
        const record = {
          pc: this,
          config: args[0],
          createdAt: Date.now(),
          localCandidates: [],
          errors: [],
          states: []
        };
        peers.push(record);
        const updateState = () => {
          record.states.push({
            at: Date.now(),
            connection: this.connectionState,
            ice: this.iceConnectionState,
            gathering: this.iceGatheringState,
            signaling: this.signalingState
          });
        };
        for (const eventName of [
          'connectionstatechange',
          'iceconnectionstatechange',
          'icegatheringstatechange',
          'signalingstatechange'
        ]) this.addEventListener(eventName, updateState);
        this.addEventListener('icecandidate', (event) => {
          if (event.candidate) {
            record.localCandidates.push(event.candidate.candidate);
          }
        });
        this.addEventListener('icecandidateerror', (event) => {
          record.errors.push({
            code: event.errorCode,
            text: event.errorText,
            url: event.url,
            address: event.address,
            port: event.port
          });
        });
        updateState();
      }
    }
    window.RTCPeerConnection = ProbedPeerConnection;
    window.__syncedE2eRtcPeers = peers;
    window.__syncedE2eRtcProbeInstalled = true;
    return true;
  })()`;
}

function rtcSnapshotExpression() {
  return `(async () => {
    const entries = [
      ...(window.__syncedRtcPeers || []),
      ...(window.__syncedE2eRtcPeers || [])
    ];
    return Promise.all(entries.map(async (entry, index) => {
      const pc = entry.pc;
      const report = await Promise.race([
        pc.getStats().catch(() => new Map()),
        new Promise((resolve) => setTimeout(() => resolve(new Map()), 1500))
      ]);
      const stats = [];
      report.forEach((item) => {
        if ([
          'candidate-pair',
          'local-candidate',
          'remote-candidate',
          'transport',
          'inbound-rtp',
          'outbound-rtp'
        ].includes(item.type)) {
          stats.push(Object.fromEntries(
            Object.entries(item).filter(([key]) => [
              'id', 'type', 'state', 'nominated', 'selected',
              'localCandidateId', 'remoteCandidateId', 'candidateType',
               'address', 'ip', 'port', 'protocol', 'networkType',
               'bytesSent', 'bytesReceived', 'packetsSent', 'packetsReceived',
               'packetsLost', 'framesEncoded', 'framesDecoded',
               'framesDropped', 'framesPerSecond', 'freezeCount',
               'totalFreezesDuration', 'jitter', 'jitterBufferDelay',
               'jitterBufferEmittedCount', 'estimatedPlayoutTimestamp',
               'totalAudioEnergy', 'totalSamplesDuration',
               'currentRoundTripTime', 'availableOutgoingBitrate',
               'availableIncomingBitrate', 'qualityLimitationReason',
               'selectedCandidatePairId', 'kind', 'mediaType'
             ].includes(key))
          ));
        }
      });
      return {
        index,
        createdAt: entry.createdAt,
        directOnly: entry.directOnly,
        localAddresses: entry.localAddresses,
        localCandidates: entry.localCandidates,
        errors: entry.errors,
        states: entry.states,
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        gathering: pc.iceGatheringState,
        signaling: pc.signalingState,
        localDescriptionCandidates: (pc.localDescription?.sdp || '')
          .split(/\\r?\\n/).filter((line) => /^a=candidate:/i.test(line)),
        remoteDescriptionCandidates: (pc.remoteDescription?.sdp || '')
          .split(/\\r?\\n/).filter((line) => /^a=candidate:/i.test(line)),
        stats
      };
    }));
  })()`;
}

function senderEncodingExpression() {
  return `(() => {
    const peers = window.__syncedRtcPeers || [];
    const outbound = [...peers].reverse().find((entry) =>
      entry.pc?.getSenders?.().some((sender) => sender.track?.kind === 'video')
    );
    const sender = outbound?.pc?.getSenders?.()
      .find((candidate) => candidate.track?.kind === 'video');
    const parameters = sender?.getParameters?.();
    return parameters ? {
      maxBitrate: parameters.encodings?.[0]?.maxBitrate,
      maxFramerate: parameters.encodings?.[0]?.maxFramerate,
      scaleResolutionDownBy: parameters.encodings?.[0]?.scaleResolutionDownBy,
      degradationPreference: parameters.degradationPreference
    } : undefined;
  })()`;
}

async function confirmMobileNetwork(timeoutMs = 25_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const connectivity = await adb(
      ["shell", "dumpsys", "connectivity"],
      30_000,
    ).catch(() => "");
    if (mobileNetworkDetected(connectivity)) return true;
    await delay(1_000);
  }
  return false;
}

async function secureAndroidReleaseE2e({
  room,
  evaluate,
  waitFor,
}) {
  const mediaStatus = await waitFor(
    `document.querySelector('#hud-media-text')?.textContent?.includes('已出画 1/1') && document.querySelector('#hud-media-text')?.textContent`,
    90_000,
  );
  let ui;
  let fullscreenButton;
  const controlStartedAt = Date.now();
  while (Date.now() - controlStartedAt < 30_000 && !fullscreenButton) {
    ui = await readPhoneUi();
    fullscreenButton = findUiNode(ui, "dock-fullscreen");
    if (!fullscreenButton) await delay(500);
  }
  if (!fullscreenButton) {
    throw new Error(
      `正式 APK 已出画，但 UIAutomator 找不到全屏按钮：${String(ui).slice(0, 1200)}`,
    );
  }
  await adb([
    "shell",
    "input",
    "tap",
    String(fullscreenButton.centerX),
    String(fullscreenButton.centerY),
  ]);
  let fullscreenUi;
  let stage;
  const fullscreenStartedAt = Date.now();
  while (Date.now() - fullscreenStartedAt < 15_000) {
    fullscreenUi = await readPhoneUi();
    stage = findUiNode(fullscreenUi, "player-stage");
    if (stage && stage.width > stage.height) break;
    await delay(500);
  }
  if (!stage || stage.width <= stage.height) {
    throw new Error("正式 APK 未进入横屏沉浸播放");
  }

  try {
    const [senderObservation, screenHealth] = await Promise.all([
      evaluate(
        senderObservationExpression({
          durationMs: healthConfig.observationMs,
          sampleIntervalMs: healthConfig.sampleIntervalMs,
        }),
        healthConfig.observationMs + 10_000,
      ),
      samplePhoneScreen(
        stage,
        healthConfig.observationMs,
        healthConfig.sampleIntervalMs,
      ),
    ]);
    const senderHealth = summarizeSenderObservation(senderObservation);
    const senderIssues = senderHealthIssues(senderHealth, healthConfig);
    if (screenHealth.nearBlackRatio > healthConfig.maxBlackRatio) {
      senderIssues.push(
        `Android 全屏近黑截图比例 ${(screenHealth.nearBlackRatio * 100).toFixed(1)}%`,
      );
    }
    if (screenHealth.sampleCount < 3) {
      senderIssues.push("Android 全屏截图样本不足");
    }
    if (senderIssues.length) {
      throw new Error(
        `正式 APK 放映质量不合格：${senderIssues.join("；")}\n` +
          `SENDER_HEALTH=${JSON.stringify(senderHealth)}\n` +
          `SCREEN_HEALTH=${JSON.stringify(screenHealth)}`,
      );
    }

    let networkSwitch;
    if (switchPhoneNetwork) {
      await adb(["shell", "svc", "data", "enable"]);
      await adb(["shell", "svc", "wifi", "disable"]);
      const switchedAt = Date.now();
      if (!(await confirmMobileNetwork())) {
        throw new Error("Android 未确认切换到移动数据网络");
      }
      let reconnectHealth;
      let reconnectIssues;
      const recoveryDeadline = Date.now() + 75_000;
      while (Date.now() < recoveryDeadline) {
        const reconnectObservation = await evaluate(
          senderObservationExpression({
            durationMs: healthConfig.reconnectObservationMs,
            sampleIntervalMs: healthConfig.sampleIntervalMs,
          }),
          healthConfig.reconnectObservationMs + 10_000,
        );
        reconnectHealth = summarizeSenderObservation(reconnectObservation);
        reconnectIssues = senderHealthIssues(reconnectHealth, healthConfig);
        if (!reconnectIssues.length) break;
        await delay(1_000);
      }
      if (reconnectIssues?.length) {
        throw new Error(
          `正式 APK 切换移动网络后未恢复：${reconnectIssues.join("；")}\n` +
            `RECONNECT_HEALTH=${JSON.stringify(reconnectHealth)}`,
        );
      }
      const reconnectScreenHealth = await samplePhoneScreen(
        stage,
        Math.min(healthConfig.reconnectObservationMs, 5_000),
        healthConfig.sampleIntervalMs,
      );
      if (
        reconnectScreenHealth.nearBlackRatio > healthConfig.maxBlackRatio
      ) {
        throw new Error(
          `Android 移动网络恢复后全屏近黑：${JSON.stringify(reconnectScreenHealth)}`,
        );
      }
      networkSwitch = {
        recovered: true,
        mobileConfirmed: true,
        elapsedMs: Date.now() - switchedAt,
        health: reconnectHealth,
        screenHealth: reconnectScreenHealth,
      };
    }
    const senderEncoding = await evaluate(senderEncodingExpression());
    if (
      !Number.isFinite(senderEncoding?.maxBitrate) ||
      senderEncoding.maxBitrate < healthConfig.minVideoBitrateBps ||
      senderEncoding.maxBitrate > healthConfig.maxVideoBitrateBps ||
      senderEncoding.maxFramerate !== Number(targetFrameRate) ||
      senderEncoding.scaleResolutionDownBy !== 1 ||
      senderEncoding.degradationPreference !== "maintain-resolution"
    ) {
      throw new Error(
        `正式 APK 对端的发送参数异常：${JSON.stringify({
          senderEncoding,
          bitrateBounds: {
            minimum: healthConfig.minVideoBitrateBps,
            maximum: healthConfig.maxVideoBitrateBps,
          },
        })}`,
      );
    }
    return {
      room,
      secureReleaseFallback: true,
      senderMediaStatus: mediaStatus,
      senderEncoding,
      bitrateBounds: {
        minimum: healthConfig.minVideoBitrateBps,
        maximum: healthConfig.maxVideoBitrateBps,
      },
      fullscreen: {
        immersive: true,
        stageWidth: stage.width,
        stageHeight: stage.height,
      },
      playbackHealth: senderHealth,
      screenHealth,
      networkSwitch,
      avSync: {
        measured: false,
        maximumAllowedMs: healthConfig.maxAvSkewMs,
        reason:
          "正式 APK 按安全要求关闭 WebView CDP；此轮以 Android media:ready、远端 RTCP、声音能量和真机截图验证，精确音画时间戳需 debug APK",
      },
    };
  } finally {
    await adb(["shell", "input", "keyevent", "4"]).catch(() => undefined);
  }
}

async function main() {
  if (!fs.existsSync(portable)) {
    throw new Error(`找不到便携版：${portable}`);
  }
  let source;
  if (launchTestSource) {
    source = spawn(
      "python",
      [path.join(__dirname, "audio-smoke-source.py")],
      { windowsHide: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    liveChildren.add(source);
    source.once("exit", () => liveChildren.delete(source));
    let sourceOutput = "";
    let sourceError = "";
    source.stdout.on("data", (chunk) => {
      sourceOutput += chunk.toString("utf8");
    });
    source.stderr.on("data", (chunk) => {
      sourceError += chunk.toString("utf8");
    });
    const sourceStartedAt = Date.now();
    while (!sourceOutput.includes("HANDLE=")) {
      if (source.exitCode !== null) {
        throw new Error(`测试播放器启动失败：${sourceError}`);
      }
      if (Date.now() - sourceStartedAt > 10_000) {
        throw new Error(`测试播放器启动超时：${sourceError}`);
      }
      await delay(100);
    }
  } else {
    process.stdout.write(
      `PORTABLE_BROADCAST_E2E_EXTERNAL_SOURCE ${JSON.stringify(sourceTitle)}\n`,
    );
  }

  const launchedAt = Date.now();
  let originalPhoneNetwork;
  if (phoneE2e) {
    const state = (await adb(["get-state"])).trim();
    if (state !== "device") {
      throw new Error(`Android 设备状态异常：${state || "未连接"}`);
    }
    originalPhoneNetwork = {
      wifi: (await adb([
        "shell",
        "settings",
        "get",
        "global",
        "wifi_on",
      ]).catch(() => "")).trim(),
      data: (await adb([
        "shell",
        "settings",
        "get",
        "global",
        "mobile_data",
      ]).catch(() => "")).trim(),
    };
  }
  const launcher = spawn(
    portable,
    [`--remote-debugging-port=${debugPort}`],
    {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SYNCED_E2E: "1",
        SYNCED_SKIP_FIREWALL_REPAIR: "1",
      },
    },
  );
  liveChildren.add(launcher);
  launcher.once("exit", () => liveChildren.delete(launcher));
  const page = await waitForPage();
  const startupMs = Date.now() - launchedAt;
  const cdp = createCdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");

  const evaluate = async (expression, timeoutMs = 15_000) => {
    const result = await cdp.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    }
    return result.result?.value;
  };
  await evaluate(rtcProbeScript());
  const waitFor = async (expression, timeoutMs = 20_000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = await evaluate(expression);
      if (value) return value;
      await delay(150);
    }
    throw new Error(`等待界面状态超时：${expression}`);
  };
  const trustedClick = async (selector, text) => {
    const point = await evaluate(`(() => {
      const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter((item) => {
          const style = getComputedStyle(item);
          const rect = item.getBoundingClientRect();
          return (
            !item.hidden &&
            !item.disabled &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        });
       const element = ${JSON.stringify(text)}
         ? candidates.find((item) => item.textContent?.includes(${JSON.stringify(text)}))
         : candidates[0];
       if (!element) return undefined;
       element.scrollIntoView({ block: 'center', inline: 'center' });
       const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!point) {
      throw new Error(`找不到可点击元素：${selector} ${text || ""}`);
    }
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  };

  try {
    await waitFor("Boolean(document.querySelector('#choose-host'))");
    await trustedClick("#choose-host");
    await waitFor("Boolean(document.querySelector('#start-share'))");
    await trustedClick("#start-share");
    await waitFor(
      "Boolean([...document.querySelectorAll('#broadcast-action, #stage-start-broadcast')].find((item) => !item.hidden && !item.disabled && item.getBoundingClientRect().width > 0))",
      30_000,
    );
    await trustedClick("#broadcast-action, #stage-start-broadcast");
    await waitFor("document.querySelector('#broadcast-dialog')?.open === true");
    const sourceVisibleExpression =
      `[...document.querySelectorAll('[data-session-source]')].some((item) => item.textContent?.includes(${JSON.stringify(sourceTitle)}))`;
    let sourceVisible = false;
    for (let attempt = 0; attempt < 3 && !sourceVisible; attempt += 1) {
      try {
        await waitFor(sourceVisibleExpression, 8_000);
        sourceVisible = true;
      } catch {
        await trustedClick("#refresh-session-sources").catch(() => undefined);
      }
    }
    if (!sourceVisible) {
      const sourceDiagnostic = await evaluate(`(async () => ({
        rendered: [...document.querySelectorAll('[data-session-source]')]
          .map((item) => item.textContent?.trim()),
        direct: await window.roomDesktop?.listSources?.()
          .then((items) => items.map((item) => ({
            id: item.id,
            name: item.name
          })))
          .catch((error) => ({ error: String(error) })),
        body: document.querySelector('#broadcast-dialog')?.innerText?.slice(0, 2400)
      }))()`);
      throw new Error(
        `找不到待分享窗口 ${JSON.stringify(sourceTitle)}：${JSON.stringify(sourceDiagnostic)}`,
      );
    }
    await trustedClick("[data-session-resolution]", targetResolution);
    await trustedClick("[data-session-frame-rate]", targetFrameRate);
    await trustedClick("[data-session-source]", sourceTitle);
    await waitFor(
      `document.querySelector('#broadcast-action')?.textContent?.includes('停止放映')`,
      35_000,
    );
    const result = await evaluate(`(() => {
      const video = document.querySelector('#channel-video');
      const stream = video?.srcObject;
      const videoTrack = stream?.getVideoTracks?.()[0];
      const audioTrack = stream?.getAudioTracks?.()[0];
      return {
        status: document.querySelector('#hud-signal-text')?.textContent,
        mediaStatus: document.querySelector('#hud-media-text')?.textContent,
        broadcastAction: document.querySelector('#broadcast-action')?.textContent,
        obsoleteStageBadgesAbsent:
          !document.querySelector('#local-stage-badge') &&
          !document.querySelector('#audio-route-badge'),
        videoTrack: videoTrack ? {
          readyState: videoTrack.readyState,
          muted: videoTrack.muted,
          settings: videoTrack.getSettings()
        } : null,
        audioTrack: audioTrack ? {
          readyState: audioTrack.readyState,
          muted: audioTrack.muted,
          settings: audioTrack.getSettings()
        } : null
      };
    })()`);
    if (
      !result.videoTrack ||
      result.videoTrack.readyState !== "live" ||
      !result.audioTrack ||
      result.audioTrack.readyState !== "live" ||
      !result.obsoleteStageBadgesAbsent
    ) {
      throw new Error(`便携版媒体轨不完整：${JSON.stringify(result)}`);
    }
    let phone;
    if (phoneE2e) {
      const room = await evaluate(`(() => {
        const text = document.querySelector('.channel-header small')?.textContent || '';
        return text.match(/频道\\s+([23456789A-HJ-NP-Z]{8})/)?.[1];
      })()`);
      if (!room) throw new Error("无法从便携版读取测试频道码");
      const invite = `synced://join?room=${room}&signal=${encodeURIComponent(signalUrl)}`;
      await adb([
        "shell",
        "am",
        "force-stop",
        androidPackage,
      ]);
      await adb(buildAndroidDeepLinkArgs(invite, androidPackage));

      let phonePage;
      const phoneStartedAt = Date.now();
      while (Date.now() - phoneStartedAt < 20_000 && !phonePage) {
        const pid = (await adb([
          "shell",
          "pidof",
          androidPackage,
        ]).catch(() => "")).trim();
        if (pid) {
          await adb([
            "forward",
            `tcp:${phoneDebugPort}`,
            `localabstract:webview_devtools_remote_${pid}`,
          ]).catch(() => undefined);
          try {
            const targets = await requestJson(
              `http://127.0.0.1:${phoneDebugPort}/json/list`,
            );
            phonePage = targets.find(
              (target) =>
                target.type === "page" &&
                typeof target.webSocketDebuggerUrl === "string",
            );
          } catch {
            // WebView debugging starts shortly after the native activity.
          }
        }
        if (!phonePage) await delay(250);
      }
      if (!phonePage) {
        await adb([
          "forward",
          "--remove",
          `tcp:${phoneDebugPort}`,
        ]).catch(() => undefined);
        phone = await secureAndroidReleaseE2e({
          room,
          evaluate,
          waitFor,
        });
      } else {
        const phoneCdp = createCdp(phonePage.webSocketDebuggerUrl);
        try {
        await phoneCdp.ready;
        await phoneCdp.send("Runtime.enable");
        const phoneEvaluate = async (
          expression,
          timeoutMs = 15_000,
        ) => {
          const evaluation = await phoneCdp.send(
            "Runtime.evaluate",
            {
              expression,
              awaitPromise: true,
              returnByValue: true,
            },
            timeoutMs,
          );
          if (evaluation.exceptionDetails) {
            throw new Error(
              evaluation.exceptionDetails.exception?.description ||
                evaluation.exceptionDetails.text,
            );
          }
          return evaluation.result?.value;
        };
        await phoneEvaluate(
          // Never repair signaling in the release E2E. This test must fail if
          // either packaged client drops the native SDP `type` field again.
          rtcProbeScript(),
        );
        let mediaStatus;
        try {
          mediaStatus = await waitFor(
            `document.querySelector('#hud-media-text')?.textContent?.includes('已出画 1/1') && document.querySelector('#hud-media-text')?.textContent`,
            90_000,
          );
        } catch (error) {
          const desktopRtc = await evaluate(rtcSnapshotExpression());
          const phoneRtc = await phoneEvaluate(rtcSnapshotExpression(), 20_000);
          const phoneState = await phoneEvaluate(`(() => ({
            body: document.body.innerText.slice(0, 2400),
            network: window.Capacitor?.Plugins?.NetworkBridge
              ? window.Capacitor.Plugins.NetworkBridge.getLocalAddresses()
              : undefined
          }))()`);
          throw new Error(
            `${error instanceof Error ? error.message : error}\n` +
              `DESKTOP_RTC=${JSON.stringify(desktopRtc)}\n` +
              `PHONE_RTC=${JSON.stringify(phoneRtc)}\n` +
              `PHONE_STATE=${JSON.stringify(phoneState)}`,
          );
        }
        const phoneEvaluation = await phoneEvaluate(`(() => {
          const video = document.querySelector('#channel-video');
          const dedicatedAudio =
            document.querySelector('#channel-movie-audio');
          const stream = video?.srcObject;
          const dedicatedAudioStream = dedicatedAudio?.srcObject;
          const dedicatedAudioTrack =
            dedicatedAudioStream?.getAudioTracks?.()
              .find((track) => track.readyState === 'live');
          const videoAudioTrack = stream?.getAudioTracks?.()
            .find((track) => track.readyState === 'live');
          const audioPlaybackElement = dedicatedAudioTrack
            ? dedicatedAudio
            : video;
          const audioPlaybackTrack = dedicatedAudioTrack || videoAudioTrack;
          const audioPlaybackPath = dedicatedAudioTrack
            ? 'dedicated'
            : 'video';
          return {
            status: document.querySelector('#hud-signal-text')?.textContent,
            mediaStatus: document.querySelector('#hud-media-text')?.textContent,
            paused: video?.paused,
            muted: video?.muted,
            volume: video?.volume,
            readyState: video?.readyState,
            videoWidth: video?.videoWidth,
            videoHeight: video?.videoHeight,
            videoTracks: stream?.getVideoTracks?.().length || 0,
            audioTracks: stream?.getAudioTracks?.().length || 0,
            videoElement: {
              exists: Boolean(video),
              paused: video?.paused,
              muted: video?.muted,
              volume: video?.volume,
              readyState: video?.readyState,
              videoWidth: video?.videoWidth,
              videoHeight: video?.videoHeight,
              trackCount: stream?.getVideoTracks?.().length || 0,
              liveTrackCount: stream?.getVideoTracks?.()
                .filter((track) => track.readyState === 'live').length || 0,
              trackState: stream?.getVideoTracks?.()[0]?.readyState,
              trackMuted: stream?.getVideoTracks?.()[0]?.muted
            },
            dedicatedAudioElement: {
              exists: Boolean(dedicatedAudio),
              hasSrcObject: Boolean(dedicatedAudioStream),
              paused: dedicatedAudio?.paused,
              muted: dedicatedAudio?.muted,
              volume: dedicatedAudio?.volume,
              readyState: dedicatedAudio?.readyState,
              trackCount:
                dedicatedAudioStream?.getAudioTracks?.().length || 0,
              liveTrackCount:
                dedicatedAudioStream?.getAudioTracks?.()
                  .filter((track) => track.readyState === 'live').length || 0,
              trackState:
                dedicatedAudioStream?.getAudioTracks?.()[0]?.readyState,
              trackMuted:
                dedicatedAudioStream?.getAudioTracks?.()[0]?.muted
            },
            audioPlayback: {
              path: audioPlaybackPath,
              exists: Boolean(audioPlaybackElement),
              hasSrcObject: Boolean(audioPlaybackElement?.srcObject),
              paused: audioPlaybackElement?.paused,
              muted: audioPlaybackElement?.muted,
              volume: audioPlaybackElement?.volume,
              readyState: audioPlaybackElement?.readyState,
              trackCount: audioPlaybackPath === 'dedicated'
                ? dedicatedAudioStream?.getAudioTracks?.().length || 0
                : stream?.getAudioTracks?.().length || 0,
              liveTrackCount: audioPlaybackTrack ? 1 : 0,
              trackState: audioPlaybackTrack?.readyState,
              trackMuted: audioPlaybackTrack?.muted
            },
            resolutionOptions: [...(document.querySelector('#viewer-resolution')?.options || [])]
              .map((option) => ({
                value: option.value,
                selected: option.selected,
                disabled: option.disabled
              })),
            frameRateOptions: [...(document.querySelector('#viewer-frame-rate')?.options || [])]
              .map((option) => ({
                value: option.value,
                selected: option.selected,
                disabled: option.disabled
              }))
          };
        })()`);
        const senderEncoding = await evaluate(senderEncodingExpression());

        await phoneEvaluate(`(async () => {
          document.querySelector('#dock-fullscreen')?.click();
          await new Promise((resolve) => setTimeout(resolve, 1400));
          return true;
        })()`, 5_000);
        let fullscreen;
        let playbackObservation;
        try {
          fullscreen = await phoneEvaluate(`(() => {
            const stage = document.querySelector('#player-stage');
            const rect = stage?.getBoundingClientRect();
            return {
              immersive: document.body.classList.contains('immersive-player'),
              innerWidth,
              innerHeight,
              stageWidth: rect?.width,
              stageHeight: rect?.height,
              fit: stage?.dataset.fullscreenFit,
              orientation: screen.orientation?.type
            };
          })()`);
          playbackObservation = await phoneEvaluate(
            receiverObservationExpression({
              durationMs: healthConfig.observationMs,
              sampleIntervalMs: healthConfig.sampleIntervalMs,
            }),
            healthConfig.observationMs + 10_000,
          );
        } finally {
          await phoneEvaluate(`(async () => {
            document.querySelector('#exit-fullscreen')?.click();
            await new Promise((resolve) => setTimeout(resolve, 250));
            return true;
          })()`, 5_000).catch(() => undefined);
        }
        const playbackHealth =
          summarizeReceiverObservation(playbackObservation);
        const playbackIssues = receiverHealthIssues(
          playbackHealth,
          healthConfig,
        );

        let networkSwitch;
        if (switchPhoneNetwork) {
          await adb(["shell", "svc", "data", "enable"]);
          await adb(["shell", "svc", "wifi", "disable"]);
          const switchedAt = Date.now();
          const mobileConfirmed = await confirmMobileNetwork();
          if (!mobileConfirmed) {
            throw new Error("Android 未确认切换到移动数据网络");
          }
          let recovered;
          let previousDecodedFrames;
          let previousAudioBytes;
          while (Date.now() - switchedAt < 75_000) {
            const snapshot = await phoneEvaluate(`(async () => {
              const entries = [
                ...(window.__syncedRtcPeers || []),
                ...(window.__syncedE2eRtcPeers || [])
              ];
              const latest = [...entries].reverse().find((entry) =>
                entry.pc?.getReceivers?.().some((receiver) =>
                  receiver.track?.kind === 'video' &&
                  receiver.track.readyState !== 'ended'
                )
              );
              const video = document.querySelector('#channel-video');
              const dedicatedAudio =
                document.querySelector('#channel-movie-audio');
              const videoStream = video?.srcObject;
              const dedicatedAudioStream = dedicatedAudio?.srcObject;
              const dedicatedAudioTrack =
                dedicatedAudioStream?.getAudioTracks?.()
                  .find((track) => track.readyState === 'live');
              const videoAudioTrack = videoStream?.getAudioTracks?.()
                .find((track) => track.readyState === 'live');
              const audioPlaybackElement = dedicatedAudioTrack
                ? dedicatedAudio
                : video;
              const audioPlaybackTrack =
                dedicatedAudioTrack || videoAudioTrack;
              const audioPlaybackPath = dedicatedAudioTrack
                ? 'dedicated'
                : 'video';
              const report = latest?.pc ? await latest.pc.getStats() : new Map();
              const stats = [...report.values()];
              const inbound = stats.find((item) =>
                item.type === 'inbound-rtp' &&
                !item.isRemote &&
                (item.kind || item.mediaType) === 'video'
              );
              const inboundAudio = stats.find((item) =>
                item.type === 'inbound-rtp' &&
                !item.isRemote &&
                (item.kind || item.mediaType) === 'audio'
              );
              return {
                peerCount: entries.length,
                connection: latest?.pc?.connectionState,
                ice: latest?.pc?.iceConnectionState,
                status: document.querySelector('#hud-signal-text')?.textContent,
                readyState: video?.readyState,
                paused: video?.paused,
                muted: video?.muted,
                width: video?.videoWidth,
                framesDecoded: Number(inbound?.framesDecoded || 0),
                audioBytesReceived:
                  Number(inboundAudio?.bytesReceived || 0),
                audioEnergy:
                  Number(inboundAudio?.totalAudioEnergy || 0),
                audioPlaybackPath,
                audioPaused: audioPlaybackElement?.paused,
                audioMuted: audioPlaybackElement?.muted,
                audioVolume: audioPlaybackElement?.volume,
                audioReadyState: audioPlaybackElement?.readyState,
                audioTrackState: audioPlaybackTrack?.readyState,
                audioTrackMuted: audioPlaybackTrack?.muted
              };
            })()`);
            const framesDecoded = Number(snapshot?.framesDecoded || 0);
            const audioBytesReceived =
              Number(snapshot?.audioBytesReceived || 0);
            const framesAdvanced =
              previousDecodedFrames !== undefined &&
              framesDecoded > previousDecodedFrames;
            const audioAdvanced =
              previousAudioBytes !== undefined &&
              audioBytesReceived > previousAudioBytes;
            previousDecodedFrames = framesDecoded;
            previousAudioBytes = audioBytesReceived;
            const minimumAudioReadyState =
              snapshot?.audioPlaybackPath === "dedicated" ? 1 : 2;
            if (
              snapshot?.connection === "connected" &&
              snapshot.readyState >= 2 &&
              snapshot.paused === false &&
              snapshot.width > 0 &&
              framesAdvanced &&
              audioAdvanced &&
              snapshot.audioPaused === false &&
              snapshot.audioMuted === false &&
              Number(snapshot.audioVolume || 0) > 0 &&
              Number(snapshot.audioReadyState || 0) >=
                minimumAudioReadyState &&
              snapshot.audioTrackState === "live" &&
              snapshot.audioTrackMuted !== true
            ) {
              recovered = snapshot;
              break;
            }
            await delay(500);
          }
          if (!recovered) {
            throw new Error(
              "Android 从 Wi-Fi 切换到移动网络后没有恢复实时解码",
            );
          }
          const reconnectObservation = await phoneEvaluate(
            receiverObservationExpression({
              durationMs: healthConfig.reconnectObservationMs,
              sampleIntervalMs: healthConfig.sampleIntervalMs,
            }),
            healthConfig.reconnectObservationMs + 10_000,
          );
          const reconnectHealth =
            summarizeReceiverObservation(reconnectObservation);
          const reconnectIssues = receiverHealthIssues(
            reconnectHealth,
            healthConfig,
          );
          if (reconnectIssues.length) {
            throw new Error(
              `Android 移动网络恢复质量不合格：${reconnectIssues.join("；")}\n` +
                `RECONNECT_HEALTH=${JSON.stringify(reconnectHealth)}`,
            );
          }
          networkSwitch = {
            recovered: true,
            mobileConfirmed,
            elapsedMs: Date.now() - switchedAt,
            ...recovered,
            health: reconnectHealth,
          };
        }
        const desktopRtc = await evaluate(rtcSnapshotExpression());
        phone = {
          room,
          senderMediaStatus: mediaStatus,
          senderEncoding,
          bitrateBounds: {
            minimum: healthConfig.minVideoBitrateBps,
            maximum: healthConfig.maxVideoBitrateBps,
          },
          fullscreen,
          playbackHealth,
          networkSwitch,
          desktopRtc,
          ...phoneEvaluation,
        };
        const videoPlayback = phone.videoElement || {
          paused: phone.paused,
          muted: phone.muted,
          volume: phone.volume,
          readyState: phone.readyState,
          videoWidth: phone.videoWidth,
          videoHeight: phone.videoHeight,
          trackCount: phone.videoTracks,
        };
        const audioPlayback = phone.audioPlayback || {
          path: "video",
          exists: true,
          hasSrcObject: Boolean(phone.audioTracks),
          paused: phone.paused,
          muted: phone.muted,
          volume: phone.volume,
          readyState: phone.readyState,
          trackCount: phone.audioTracks,
          liveTrackCount: phone.audioTracks,
        };
        const dedicatedAudioExpected =
          phone.dedicatedAudioElement?.exists === true;
        const minimumAudioReadyState =
          audioPlayback.path === "dedicated" ? 1 : 2;
        const structuralFailure =
          videoPlayback.paused ||
          videoPlayback.readyState < 2 ||
          videoPlayback.videoWidth < 1 ||
          videoPlayback.trackCount !== 1 ||
          !audioPlayback.exists ||
          !audioPlayback.hasSrcObject ||
          audioPlayback.paused ||
          audioPlayback.muted ||
          audioPlayback.volume !== 1 ||
          audioPlayback.readyState < minimumAudioReadyState ||
          audioPlayback.liveTrackCount !== 1 ||
          audioPlayback.trackState !== "live" ||
          audioPlayback.trackMuted === true ||
          (dedicatedAudioExpected &&
            audioPlayback.path !== "dedicated") ||
          (!dedicatedAudioExpected &&
            audioPlayback.path !== "video") ||
          !Number.isFinite(phone.senderEncoding?.maxBitrate) ||
          phone.senderEncoding.maxBitrate <
            healthConfig.minVideoBitrateBps ||
          phone.senderEncoding.maxBitrate >
            healthConfig.maxVideoBitrateBps ||
          phone.senderEncoding?.maxFramerate !== Number(targetFrameRate) ||
          phone.senderEncoding?.scaleResolutionDownBy !== 1 ||
          phone.senderEncoding?.degradationPreference !==
            "maintain-resolution" ||
          phone.resolutionOptions?.find((option) => option.value === "0")
            ?.selected !== true ||
          phone.frameRateOptions?.find((option) => option.value === "0")
            ?.selected !== true ||
          !phone.fullscreen?.immersive ||
          phone.fullscreen.innerWidth <= phone.fullscreen.innerHeight ||
          Math.abs(
            phone.fullscreen.stageWidth - phone.fullscreen.innerWidth,
          ) > 2 ||
          Math.abs(
            phone.fullscreen.stageHeight - phone.fullscreen.innerHeight,
          ) > 2;
        if (structuralFailure || playbackIssues.length) {
          throw new Error(
            `Android 放映质量验证失败：${[
              structuralFailure ? "结构或发送参数不符合预期" : undefined,
              ...playbackIssues,
            ]
              .filter(Boolean)
              .join("；")}\nPHONE=${JSON.stringify(phone)}`,
          );
        }
        } finally {
          phoneCdp.socket.close();
          await adb([
            "forward",
            "--remove",
            `tcp:${phoneDebugPort}`,
          ]).catch(() => undefined);
        }
      }
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        startupMs,
        sourceTitle,
        targetResolution,
        targetFrameRate,
        ...result,
        phone,
      })}\n`,
    );
  } finally {
    await Promise.race([
      cdp.send("Browser.close").catch(() => undefined),
      delay(1_000),
    ]);
    cdp.socket.close();
    await delay(500);
    if (launcher.exitCode === null) launcher.kill();
    if (source?.exitCode === null) source.kill();
    if (originalPhoneNetwork) {
      await adb([
        "shell",
        "svc",
        "wifi",
        originalPhoneNetwork.wifi === "0" ? "disable" : "enable",
      ]).catch(() => undefined);
      await adb([
        "shell",
        "svc",
        "data",
        originalPhoneNetwork.data === "0" ? "disable" : "enable",
      ]).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  for (const child of liveChildren) {
    if (child.exitCode === null) child.kill();
  }
  process.stderr.write(
    `PORTABLE_BROADCAST_E2E_FAILED ${
      error instanceof Error ? error.stack : error
    }\n`,
  );
  process.exitCode = 1;
});
