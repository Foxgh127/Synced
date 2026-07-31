const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");

app.commandLine.appendSwitch("force-high-performance-gpu");

const root = path.resolve(__dirname, "..");
const enhancementBundle = buildSync({
  entryPoints: [path.join(root, "src", "video-enhancement.ts")],
  bundle: true,
  format: "iife",
  globalName: "SyncedVideoEnhancement",
  platform: "browser",
  write: false,
}).outputFiles[0].text;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1_000,
    height: 640,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`
        <!doctype html>
        <meta charset="utf-8">
        <style>
          html, body { margin: 0; background: #000; }
          #stage { position: relative; width: 960px; height: 540px; }
          #video, #enhanced { position: absolute; inset: 0; width: 100%; height: 100%; }
          #source { display: none; }
        </style>
        <div id="stage">
          <video id="video" muted playsinline></video>
          <canvas id="enhanced"></canvas>
          <div id="subtitles"></div>
        </div>
        <canvas id="source" width="640" height="360"></canvas>
      `)}`,
    );
    const result = await window.webContents.executeJavaScript(`(async () => {
      ${enhancementBundle}
      const source = document.querySelector("#source");
      const sourceContext = source.getContext("2d");
      const gradient = sourceContext.createLinearGradient(0, 0, 640, 360);
      gradient.addColorStop(0, "#101826");
      gradient.addColorStop(0.5, "#4fd1c5");
      gradient.addColorStop(1, "#7c5cff");
      sourceContext.fillStyle = gradient;
      sourceContext.fillRect(0, 0, 640, 360);
      sourceContext.fillStyle = "#fff";
      sourceContext.font = "700 54px sans-serif";
      sourceContext.fillText("4K", 274, 202);

      const stream = source.captureStream(5);
      const video = document.querySelector("#video");
      video.srcObject = stream;
      await video.play();
      if (!video.videoWidth) {
        await new Promise((resolve) =>
          video.addEventListener("loadedmetadata", resolve, { once: true })
        );
      }
      const canvas = document.querySelector("#enhanced");
      const controller = new SyncedVideoEnhancement.VideoEnhancementController({
        video,
        canvas,
        stage: document.querySelector("#stage"),
        subtitleLayer: document.querySelector("#subtitles"),
      });
      controller.setHardwareInfo({
        deviceName: "WebGL fallback smoke",
        driverVersion: "",
        activeGpuIsNvidia: false,
        rtxGpu: false,
        hardwareVideoDecode: true,
        videoDecodeStatus: "enabled",
        rtxVideoSupported: false,
        rtxVideoDriverState: "unknown",
        onBatteryPower: false,
      });
      controller.setPlaybackMode("emby-viewer");
      controller.refresh();
      const deadline = performance.now() + 8_000;
      while (!controller.currentState.active && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.refresh();
      }
      const state = { ...controller.currentState };
      const gl = canvas.getContext("webgl2");
      const glError = gl?.getError();
      const pixel = new Uint8Array(4);
      gl?.readPixels(
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      const sample = Array.from(pixel);
      controller.setHardwareInfo({
        deviceName: "NVIDIA GeForce RTX smoke GPU",
        driverVersion: "32.0.16.1074",
        driverRelease: 610,
        activeGpuIsNvidia: true,
        rtxGpu: true,
        hardwareVideoDecode: true,
        videoDecodeStatus: "enabled",
        rtxVideoSupported: true,
        rtxVideoDriverState: "enabled",
        rtxVideoDriverQuality: 4,
        onBatteryPower: false,
      });
      controller.refresh();
      const rtxState = { ...controller.currentState };
      const rtxCanvasHidden = canvas.hidden;
      const rtxStageActive =
        document.querySelector("#stage").classList.contains(
          "video-enhancement-rtx-active",
        );
      controller.destroy();
      for (const track of stream.getTracks()) track.stop();
      return {
        state,
        canvas: { width: canvas.width, height: canvas.height },
        glError,
        sample,
        rtxState,
        rtxCanvasHidden,
        rtxStageActive,
      };
    })()`);
    assert.equal(result.state.active, true);
    assert.equal(result.state.backend, "webgl2-spatial");
    assert.deepEqual(result.canvas, { width: 3_840, height: 2_160 });
    assert.equal(result.glError, 0);
    assert.equal(result.sample[3], 255);
    assert.equal(result.rtxState.active, true);
    assert.equal(result.rtxState.backend, "rtx-video");
    assert.equal(result.rtxCanvasHidden, true);
    assert.equal(result.rtxStageActive, true);
    console.log(`VIDEO_ENHANCEMENT_SMOKE ${JSON.stringify(result)}`);
    app.exit(0);
  } catch (error) {
    console.error("VIDEO_ENHANCEMENT_SMOKE_FAILED", error);
    app.exit(1);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
});
