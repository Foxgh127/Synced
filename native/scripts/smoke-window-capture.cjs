const {
  app,
  BrowserWindow,
  desktopCapturer,
  screen,
  session,
} = require("electron");
const path = require("node:path");

const SOURCE_TITLE = "Synced Window Capture Smoke Source";

async function main() {
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  await app.whenReady();

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) =>
      ["media", "display-capture"].includes(permission),
  );
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) =>
      callback(["media", "display-capture"].includes(permission)),
  );
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 },
      });
      callback({
        video: sources.find((source) => source.name === SOURCE_TITLE),
      });
    },
  );

  const sourceWindow = new BrowserWindow({
    title: SOURCE_TITLE,
    width: 1280,
    height: 720,
    show: true,
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false },
  });
  await sourceWindow.loadFile(
    path.join(__dirname, "smoke-window-source.html"),
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await sourceWindow.webContents.executeJavaScript(
      "window.videoReady === true",
    );
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const videoReady = await sourceWindow.webContents.executeJavaScript(
    "window.videoReady === true",
  );
  if (!videoReady) {
    throw new Error("GPU-decoded source video did not start");
  }
  const captureSources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 0, height: 0 },
  });
  const sourceId = captureSources.find(
    (source) => source.name === SOURCE_TITLE,
  )?.id;
  if (!sourceId) {
    throw new Error("capture source id was not available");
  }
  const sourceDisplay = screen.getDisplayMatching(sourceWindow.getBounds());
  const captureTargetWidth = Math.min(
    1920,
    Math.floor((sourceWindow.getBounds().width * sourceDisplay.scaleFactor) / 2) *
      2,
  );
  const captureTargetHeight = Math.min(
    1080,
    Math.floor(
      (sourceWindow.getBounds().height * sourceDisplay.scaleFactor) / 2,
    ) * 2,
  );
  const captureTargetBitrate = Math.min(
    10_000_000,
    Math.max(
      1_500_000,
      Math.round(captureTargetWidth * captureTargetHeight * 30 * 0.16),
    ),
  );

  const testWindow = new BrowserWindow({
    width: 640,
    height: 360,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await testWindow.loadFile(
    path.join(__dirname, "smoke-window-capture.html"),
  );

  try {
    const result = await testWindow.webContents.executeJavaScript(`(async () => {
      let capture = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: ${JSON.stringify(sourceId)},
            maxWidth: ${captureTargetWidth},
            maxHeight: ${captureTargetHeight},
            maxFrameRate: 30
          }
        },
        audio: false
      });
      let sourceTrack = capture.getVideoTracks()[0];
      if (!sourceTrack) throw new Error("missing captured video track");
      sourceTrack.contentHint = "motion";
      await sourceTrack.applyConstraints({
        width: { ideal: ${captureTargetWidth}, max: ${captureTargetWidth} },
        height: { ideal: ${captureTargetHeight}, max: ${captureTargetHeight} },
        frameRate: { ideal: 30, max: 30 }
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const logicalSettings = sourceTrack.getSettings();
      const scale = Number(logicalSettings.screenPixelRatio) || 1;
      const physicalWidth = Math.min(
        ${captureTargetWidth},
        Math.round((Number(logicalSettings.width) || 1) * scale)
      );
      const physicalHeight = Math.min(
        ${captureTargetHeight},
        Math.round((Number(logicalSettings.height) || 1) * scale)
      );
      if (scale > 1.01) {
        capture.getTracks().forEach((track) => track.stop());
        capture = await navigator.mediaDevices.getUserMedia({
          video: {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: ${JSON.stringify(sourceId)},
              minWidth: physicalWidth,
              maxWidth: physicalWidth,
              minHeight: physicalHeight,
              maxHeight: physicalHeight,
              minFrameRate: 30,
              maxFrameRate: 30
            }
          },
          audio: false
        });
        sourceTrack = capture.getVideoTracks()[0];
        sourceTrack.contentHint = "motion";
      }

      const sender = new RTCPeerConnection();
      const receiver = new RTCPeerConnection();
      sender.onicecandidate = (event) => {
        if (event.candidate) receiver.addIceCandidate(event.candidate);
      };
      receiver.onicecandidate = (event) => {
        if (event.candidate) sender.addIceCandidate(event.candidate);
      };

      const frameResult = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("decoded frame timeout")), 12000);
        receiver.ontrack = async (event) => {
          if (event.track.kind !== "video") return;
          const video = document.querySelector("#remote");
          video.srcObject = event.streams[0] || new MediaStream([event.track]);
          await video.play();
          video.requestVideoFrameCallback(async () => {
            // WGC may expose a low-resolution bootstrap frame before the
            // capture track has settled on the requested source dimensions.
            // Validate the steady-state settings used by the product.
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const canvas = document.querySelector("canvas");
            const context = canvas.getContext("2d", { willReadFrequently: true });
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixel = [...context.getImageData(40, 40, 1, 1).data];
            let colorSpace = {};
            try {
              const frame = new VideoFrame(video);
              colorSpace = {
                primaries: frame.colorSpace.primaries,
                transfer: frame.colorSpace.transfer,
                matrix: frame.colorSpace.matrix,
                fullRange: frame.colorSpace.fullRange
              };
              frame.close();
            } catch {}
            const inboundReport = await receiver.getStats();
            let inbound = {};
            inboundReport.forEach((item) => {
              if (
                item.type !== "inbound-rtp" ||
                (item.kind || item.mediaType) !== "video"
              ) {
                return;
              }
              const codec = item.codecId
                ? inboundReport.get(item.codecId)
                : undefined;
              inbound = {
                codec: codec?.mimeType,
                width: item.frameWidth,
                height: item.frameHeight,
                framesDecoded: item.framesDecoded,
                framesPerSecond: item.framesPerSecond,
                powerEfficientDecoder: item.powerEfficientDecoder
              };
            });
            const outboundReport = await sender.getStats();
            let outbound = {};
            outboundReport.forEach((item) => {
              if (
                item.type !== "outbound-rtp" ||
                (item.kind || item.mediaType) !== "video" ||
                item.isRemote
              ) {
                return;
              }
              const codec = item.codecId
                ? outboundReport.get(item.codecId)
                : undefined;
              outbound = {
                codec: codec?.mimeType,
                width: item.frameWidth,
                height: item.frameHeight,
                framesEncoded: item.framesEncoded,
                framesPerSecond: item.framesPerSecond,
                qualityLimitationReason: item.qualityLimitationReason,
                encoderImplementation: item.encoderImplementation,
                powerEfficientEncoder: item.powerEfficientEncoder
              };
            });
            clearTimeout(timeout);
            resolve({
              pixel,
              colorSpace,
              captureSettings: sourceTrack.getSettings(),
              receiverState: receiver.connectionState,
              inbound,
              outbound
            });
          });
        };
      });

      const videoSender = sender.addTrack(sourceTrack, capture);
      const transceiver = sender.getTransceivers().find(
        (candidate) => candidate.sender === videoSender
      );
      const codecCapabilities = RTCRtpSender.getCapabilities("video")?.codecs || [];
      const h264Rank = (codec) => {
        const profile = codec.sdpFmtpLine
          ?.match(/(?:^|;)\s*profile-level-id=([0-9a-f]{6})(?:;|$)/i)?.[1];
        const profileIdc = profile
          ? Number.parseInt(profile.slice(0, 2), 16)
          : 0;
        if ([0x64, 0x6e, 0x7a, 0xf4].includes(profileIdc)) return 0;
        if (profileIdc === 0x4d) return 1;
        if (profileIdc === 0x42) return 2;
        return 3;
      };
      const h264 = codecCapabilities
        .filter((codec) => codec.mimeType.toLowerCase() === "video/h264")
        .sort((left, right) => h264Rank(left) - h264Rank(right));
      const repair = codecCapabilities.filter((codec) =>
        ["video/rtx", "video/red", "video/ulpfec", "video/flexfec-03"]
          .includes(codec.mimeType.toLowerCase())
      );
      if (h264.length && transceiver?.setCodecPreferences) {
        transceiver.setCodecPreferences([...h264, ...repair]);
      }
      const parameters = videoSender.getParameters();
      parameters.encodings = parameters.encodings?.length
        ? parameters.encodings
        : [{}];
      parameters.encodings[0].maxBitrate = ${captureTargetBitrate};
      parameters.encodings[0].maxFramerate = 30;
      parameters.encodings[0].scaleResolutionDownBy = 1;
      parameters.encodings[0].priority = "high";
      parameters.encodings[0].networkPriority = "high";
      parameters.encodings[0].bitratePriority = 2;
      parameters.degradationPreference = "maintain-resolution";
      await videoSender.setParameters(parameters);
      const offer = await sender.createOffer();
      await sender.setLocalDescription(offer);
      await receiver.setRemoteDescription(sender.localDescription);
      const answer = await receiver.createAnswer();
      await receiver.setLocalDescription(answer);
      await sender.setRemoteDescription(receiver.localDescription);
      // Chromium can replace the encoding parameter object when the final
      // codec is instantiated. Match the product path and re-apply the full
      // quality ceiling after the answer.
      const finalParameters = videoSender.getParameters();
      finalParameters.encodings = finalParameters.encodings?.length
        ? finalParameters.encodings
        : [{}];
      finalParameters.encodings[0].maxBitrate = ${captureTargetBitrate};
      finalParameters.encodings[0].maxFramerate = 30;
      finalParameters.encodings[0].scaleResolutionDownBy = 1;
      finalParameters.encodings[0].priority = "high";
      finalParameters.encodings[0].networkPriority = "high";
      finalParameters.encodings[0].bitratePriority = 2;
      finalParameters.degradationPreference = "maintain-resolution";
      await videoSender.setParameters(finalParameters);
      const result = await frameResult;
      sender.close();
      receiver.close();
      capture.getTracks().forEach((track) => track.stop());
      return result;
    })()`);
    if (
      !Array.isArray(result.pixel) ||
      result.pixel.slice(0, 3).reduce((sum, value) => sum + value, 0) < 60 ||
      Number(result.captureSettings?.width) < captureTargetWidth * 0.94 ||
      Number(result.captureSettings?.height) < captureTargetHeight * 0.94 ||
      !/video\/H264/i.test(String(result.inbound?.codec || "")) ||
      Number(result.inbound?.width) < captureTargetWidth * 0.94 ||
      Number(result.inbound?.height) < captureTargetHeight * 0.94 ||
      Number(result.inbound?.framesDecoded) < 20 ||
      !/video\/H264/i.test(String(result.outbound?.codec || "")) ||
      Number(result.outbound?.width) < captureTargetWidth * 0.94 ||
      Number(result.outbound?.height) < captureTargetHeight * 0.94 ||
      Number(result.outbound?.framesEncoded) < 20
    ) {
      throw new Error(
        `window capture did not preserve physical source quality: ${JSON.stringify(result)}`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        gpuFeatureStatus: app.getGPUFeatureStatus(),
        captureTarget: {
          width: captureTargetWidth,
          height: captureTargetHeight,
          bitrate: captureTargetBitrate,
        },
        ...result
      })}\n`,
    );
  } finally {
    testWindow.destroy();
    sourceWindow.destroy();
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    app.exit(1);
  });
