process.env.SYNCED_E2E = "1";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

require("../electron/main.cjs");

async function waitFor(read, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("process audio bridge smoke test timed out");
}

async function main() {
  await app.whenReady();
  const source = spawn(
    "python",
    [path.join(__dirname, "audio-smoke-source.py")],
    {
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let sourceOutput = "";
  let sourceError = "";
  source.stdout.on("data", (chunk) => {
    sourceOutput += chunk.toString("utf8");
  });
  source.stderr.on("data", (chunk) => {
    sourceError += chunk.toString("utf8");
  });

  try {
    await waitFor(() => /HANDLE=(\d+)/.test(sourceOutput));
    const mainWindow = await waitFor(() =>
      BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.isDestroyed() &&
          !candidate.webContents.getURL().endsWith("/overlay.html"),
      ),
    );
    await waitFor(() =>
      mainWindow.webContents
        .executeJavaScript(
          "typeof window.roomDesktop?.getProcessAudioStatus === 'function'",
        )
        .catch(() => false),
    );
    const sourceId = await waitFor(() =>
      mainWindow.webContents
        .executeJavaScript(`(async () => {
          const sources = await window.roomDesktop.listSources();
          return sources.find(
            (source) => source.name === "Synced Native Process Audio Smoke",
          )?.id || "";
        })()`)
        .catch(() => ""),
    );
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      await window.roomDesktop.selectSource(${JSON.stringify(sourceId)});
      let bytes = 0;
      let samples = 0;
      let sumSquares = 0;
      let peak = 0;
      const bytesByCapture = {};
      const statuses = [];
      let resolveFlow;
      let rejectFlow;
      const flow = new Promise((resolve, reject) => {
        resolveFlow = resolve;
        rejectFlow = reject;
      });
      const timeout = setTimeout(
        () => rejectFlow(new Error("IPC 音频数据超时")),
        10_000,
      );
      const removeData = window.roomDesktop.onProcessAudioData((packet) => {
        bytes += packet.pcm.byteLength;
        bytesByCapture[packet.captureId] =
          (bytesByCapture[packet.captureId] || 0) + packet.pcm.byteLength;
        const view = new DataView(
          packet.pcm.buffer,
          packet.pcm.byteOffset,
          packet.pcm.byteLength,
        );
        for (let offset = 0; offset + 1 < view.byteLength; offset += 2) {
          const sample = view.getInt16(offset, true) / 32_768;
          sumSquares += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
          samples += 1;
        }
        if (bytes >= 192_000) resolveFlow();
      });
      const removeStatus = window.roomDesktop.onProcessAudioStatus((status) => {
        if (["ready", "flow", "error", "stopped"].includes(status.type)) {
          statuses.push(status);
        }
      });
      let started;
      let replacement;
      try {
        started = await window.roomDesktop.startProcessAudio();
        await flow;
        replacement = await window.roomDesktop.startProcessAudio();
        await new Promise((resolve, reject) => {
          const deadline = Date.now() + 10_000;
          const timer = setInterval(() => {
            if ((bytesByCapture[replacement.captureId] || 0) >= 96_000) {
              clearInterval(timer);
              resolve();
            } else if (Date.now() >= deadline) {
              clearInterval(timer);
              reject(new Error("替换采集会话没有收到 IPC 音频数据"));
            }
          }, 40);
        });
        // A late stop from the first renderer-side capture must not terminate
        // the replacement helper process.
        await window.roomDesktop.stopProcessAudio(started.captureId);
        const active = await window.roomDesktop.getProcessAudioStatus();
        await window.roomDesktop.stopProcessAudio(replacement.captureId);
        const stopped = await window.roomDesktop.getProcessAudioStatus();
        return {
          bytes,
          rms: Math.sqrt(sumSquares / Math.max(1, samples)),
          peak,
          started,
          replacement,
          active,
          stopped,
          statuses,
        };
      } finally {
        clearTimeout(timeout);
        removeData();
        removeStatus();
        if (replacement?.captureId || started?.captureId) {
          await window.roomDesktop
            .stopProcessAudio(
              replacement?.captureId || started.captureId,
            )
            .catch(() => undefined);
        }
      }
    })()`);
    const passed =
      result.bytes >= 288_000 &&
      result.rms >= 0.005 &&
      result.peak >= 0.02 &&
      result.started?.sampleRate === 48_000 &&
      result.started?.channels === 2 &&
      result.started?.bitsPerSample === 16 &&
      Number.isSafeInteger(result.started?.captureId) &&
      result.replacement?.captureId > result.started?.captureId &&
      result.active?.active === true &&
      result.active?.captureId === result.replacement?.captureId &&
      result.active?.packetCount > 0 &&
      result.active?.byteCount >= 96_000 &&
      result.stopped?.active === false &&
      result.statuses.some(
        (status) =>
          status.type === "flow" &&
          status.captureId === result.replacement.captureId,
      );
    if (!passed) {
      throw new Error(
        `process audio bridge validation failed: ${JSON.stringify(result)}`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode: "helper-main-preload-renderer",
        bytes: result.bytes,
        rms: result.rms,
        peak: result.peak,
        firstCaptureId: result.started.captureId,
        replacementCaptureId: result.replacement.captureId,
        staleStopPreservedReplacement: true,
        packetCount: result.active.packetCount,
      })}\n`,
    );
  } finally {
    if (!source.killed) source.kill();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(
      `PROCESS_AUDIO_BRIDGE_SMOKE_FAILED ${
        error instanceof Error ? error.stack : error
      }\n`,
    );
    app.exit(1);
  });
