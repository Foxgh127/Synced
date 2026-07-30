export const PROCESS_AUDIO_WORKLET_SOURCE = `
const SAMPLE_RATE_HZ = 48000;
const CAPACITY_FRAMES = SAMPLE_RATE_HZ * 2;
const START_FRAMES = Math.round(SAMPLE_RATE_HZ * 0.04);
const TARGET_LATENCY_SECONDS = 0.04;
const HIGH_WATER_FRAMES = Math.round(SAMPLE_RATE_HZ * 0.08);
const CLOCK_REANCHOR_SECONDS = 0.25;
const CLOCK_NUDGE_LIMIT_SECONDS = 0.0005;

class SyncedPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY_FRAMES);
    this.right = new Float32Array(CAPACITY_FRAMES);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.queuedFrames = 0;
    this.readFraction = 0;
    this.captureTimeAtRead = undefined;
    this.lastDeviceEnd = undefined;
    this.lastDevicePosition = undefined;
    this.devicePositionFrozen = false;
    this.started = false;
    this.correctionRate = 1;
    this.outputGain = 0;
    this.droppedFrames = 0;
    this.clockReanchors = 0;
    this.lastReportFrame = 0;
    this.port.onmessage = (event) => {
      if (event.data?.left && event.data?.right) {
        this.enqueue(event.data);
      }
    };
  }

  enqueue(data) {
    const left = data.left;
    const right = data.right;
    const frameCount = Math.min(left.length, right.length);
    let inputOffset = 0;
    let gapFrames = 0;
    let deviceClockReset = false;
    const devicePosition = Number(data.devicePosition);
    if (Number.isFinite(devicePosition) && devicePosition >= 0) {
      const repeatedDevicePosition =
        this.lastDevicePosition !== undefined &&
        devicePosition === this.lastDevicePosition;
      if (repeatedDevicePosition) {
        // Process-loopback drivers used by Chromium can return a valid PCM
        // packet stream while reporting devicePosition=0 forever. Treat that
        // clock as unavailable. Otherwise every packet after the first is
        // classified as a complete overlap and discarded, leaving the WebRTC
        // track alive but permanently silent.
        if (!this.devicePositionFrozen) {
          this.devicePositionFrozen = true;
          this.lastDeviceEnd = undefined;
          this.clockReanchors += 1;
        }
      } else if (
        this.devicePositionFrozen &&
        this.lastDevicePosition !== undefined &&
        devicePosition > this.lastDevicePosition
      ) {
        // Some drivers begin exposing a useful position after startup or
        // resume. Re-anchor without inventing a gap for the transition packet.
        this.devicePositionFrozen = false;
        this.lastDeviceEnd = undefined;
        this.clockReanchors += 1;
      }

      if (!this.devicePositionFrozen && this.lastDeviceEnd !== undefined) {
        const gap = Math.round(devicePosition - this.lastDeviceEnd);
        if (gap > 0) {
          gapFrames = Math.min(gap, SAMPLE_RATE_HZ / 4);
        } else if (gap < -SAMPLE_RATE_HZ / 4) {
          // Endpoint changes can reset the WASAPI device-position counter.
          // Treat this as a fresh clock epoch; otherwise every packet would be
          // discarded until the new counter caught up with the old session.
          this.readIndex = this.writeIndex;
          this.queuedFrames = 0;
          this.readFraction = 0;
          this.captureTimeAtRead = undefined;
          this.started = false;
          this.correctionRate = 1;
          this.lastDeviceEnd = devicePosition + frameCount;
          this.devicePositionFrozen = false;
          this.clockReanchors += 1;
          deviceClockReset = true;
        } else if (gap < 0) {
          inputOffset = Math.min(frameCount, -gap);
        }
      }
      if (!this.devicePositionFrozen && !deviceClockReset) {
        this.lastDeviceEnd = Math.max(
          this.lastDeviceEnd ?? 0,
          devicePosition + frameCount,
        );
      }
      this.lastDevicePosition = devicePosition;
    }

    const captureAgeSeconds = Math.max(
      0,
      Math.min(2, Number(data.captureAgeSeconds) || 0),
    );
    const observedPacketStart =
      currentTime -
      captureAgeSeconds +
      inputOffset / SAMPLE_RATE_HZ;
    if (this.queuedFrames === 0 || this.captureTimeAtRead === undefined) {
      this.captureTimeAtRead =
        observedPacketStart - gapFrames / SAMPLE_RATE_HZ;
      this.readFraction = 0;
    } else {
      const predictedPacketStart =
        this.captureTimeAtRead +
        (this.queuedFrames + gapFrames) / SAMPLE_RATE_HZ;
      const clockError = observedPacketStart - predictedPacketStart;
      if (
        Math.abs(clockError) >= CLOCK_REANCHOR_SECONDS &&
        this.queuedFrames <= HIGH_WATER_FRAMES
      ) {
        // A paused process-loopback source can stop delivering packets. Never
        // let the one residual interpolation frame preserve an obsolete clock
        // anchor when packets resume.
        this.captureTimeAtRead += clockError;
        this.clockReanchors += 1;
      } else if (Math.abs(clockError) < CLOCK_REANCHOR_SECONDS) {
        // Track small QPC/AudioContext clock-rate differences without letting
        // IPC scheduling jitter pull the playout clock around.
        this.captureTimeAtRead += Math.max(
          -CLOCK_NUDGE_LIMIT_SECONDS,
          Math.min(CLOCK_NUDGE_LIMIT_SECONDS, clockError * 0.025),
        );
      }
    }
    if (gapFrames > 0) {
      this.enqueueSilence(gapFrames);
    }
    for (let index = inputOffset; index < frameCount; index += 1) {
      this.enqueueFrame(left[index], right[index]);
    }
  }

  enqueueSilence(frameCount) {
    for (let index = 0; index < frameCount; index += 1) {
      this.enqueueFrame(0, 0);
    }
  }

  enqueueFrame(left, right) {
    if (this.queuedFrames >= CAPACITY_FRAMES - 1) {
      // A true ring buffer evicts only the single oldest frame required for
      // the incoming frame. Normal backlog is drained by interpolation below,
      // so there is no 100ms bulk splice or discontinuous timeline jump.
      this.readIndex = (this.readIndex + 1) % CAPACITY_FRAMES;
      this.queuedFrames -= 1;
      this.readFraction = 0;
      if (this.captureTimeAtRead !== undefined) {
        this.captureTimeAtRead += 1 / SAMPLE_RATE_HZ;
      }
      this.droppedFrames += 1;
    }
    this.left[this.writeIndex] = left;
    this.right[this.writeIndex] = right;
    this.writeIndex = (this.writeIndex + 1) % CAPACITY_FRAMES;
    this.queuedFrames += 1;
  }

  targetCorrectionRate(timingErrorSeconds) {
    const bufferedSeconds = this.queuedFrames / SAMPLE_RATE_HZ;
    if (
      this.queuedFrames > SAMPLE_RATE_HZ * 0.3
    ) {
      return 1.05;
    }
    if (
      this.queuedFrames > SAMPLE_RATE_HZ * 0.16
    ) {
      return 1.025;
    }
    if (
      this.queuedFrames > HIGH_WATER_FRAMES
    ) {
      return 1.01;
    }
    if (
      Math.abs(timingErrorSeconds) < CLOCK_REANCHOR_SECONDS &&
      timingErrorSeconds > 0.025 &&
      bufferedSeconds > 0.035
    ) {
      return 1.005;
    }
    if (
      bufferedSeconds < 0.022 ||
      (
        Math.abs(timingErrorSeconds) < CLOCK_REANCHOR_SECONDS &&
        timingErrorSeconds < -0.012
      )
    ) {
      return 0.995;
    }
    return 1;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const leftOutput = output[0];
    const rightOutput = output[1] || output[0];
    leftOutput.fill(0);
    rightOutput.fill(0);

    if (!this.started && this.queuedFrames >= START_FRAMES) {
      this.started = true;
      this.outputGain = 0;
    }
    let captureAge =
      this.captureTimeAtRead === undefined
        ? TARGET_LATENCY_SECONDS
        : currentTime - this.captureTimeAtRead;
    let timingError = captureAge - TARGET_LATENCY_SECONDS;
    if (
      this.captureTimeAtRead !== undefined &&
      Math.abs(timingError) >= CLOCK_REANCHOR_SECONDS &&
      this.queuedFrames <= HIGH_WATER_FRAMES
    ) {
      // QPC is optional for some process-loopback drivers and can be zero,
      // frozen, or reset after pause/resume. A shallow real queue proves the
      // samples are current, so re-anchor instead of trying to "catch up" a
      // fictitious minutes-long delay at a permanently pinned 1.05x rate.
      this.captureTimeAtRead = currentTime - TARGET_LATENCY_SECONDS;
      captureAge = TARGET_LATENCY_SECONDS;
      timingError = 0;
      this.clockReanchors += 1;
    }
    const targetRate = this.targetCorrectionRate(timingError);
    const rateDelta = Math.max(
      -0.002,
      Math.min(0.002, targetRate - this.correctionRate),
    );
    this.correctionRate += rateDelta;

    let outputOffset = 0;
    while (
      this.started &&
      outputOffset < leftOutput.length &&
      this.queuedFrames >= 2
    ) {
      const nextIndex = (this.readIndex + 1) % CAPACITY_FRAMES;
      const fraction = this.readFraction;
      const left =
        this.left[this.readIndex] * (1 - fraction) +
        this.left[nextIndex] * fraction;
      const right =
        this.right[this.readIndex] * (1 - fraction) +
        this.right[nextIndex] * fraction;
      this.outputGain = Math.min(1, this.outputGain + 1 / 64);
      leftOutput[outputOffset] = left * this.outputGain;
      rightOutput[outputOffset] = right * this.outputGain;
      outputOffset += 1;

      const advanced = this.readFraction + this.correctionRate;
      const wholeFrames = Math.floor(advanced);
      this.readFraction = advanced - wholeFrames;
      this.readIndex =
        (this.readIndex + wholeFrames) % CAPACITY_FRAMES;
      this.queuedFrames = Math.max(0, this.queuedFrames - wholeFrames);
      if (this.captureTimeAtRead !== undefined) {
        this.captureTimeAtRead += this.correctionRate / SAMPLE_RATE_HZ;
      }
    }

    if (outputOffset < leftOutput.length && this.started) {
      const fadeFrames = Math.min(64, outputOffset);
      for (let index = 0; index < fadeFrames; index += 1) {
        const position = outputOffset - fadeFrames + index;
        const gain = (fadeFrames - index - 1) / fadeFrames;
        leftOutput[position] *= gain;
        rightOutput[position] *= gain;
      }
      this.started = false;
      this.outputGain = 0;
      if (this.queuedFrames < 2) {
        this.readIndex = this.writeIndex;
        this.queuedFrames = 0;
        this.captureTimeAtRead = undefined;
        this.readFraction = 0;
        this.lastDeviceEnd = undefined;
        this.lastDevicePosition = undefined;
        this.devicePositionFrozen = false;
        this.correctionRate = 1;
      }
    }

    if (currentFrame - this.lastReportFrame >= SAMPLE_RATE_HZ) {
      this.lastReportFrame = currentFrame;
      this.port.postMessage({
        type: "timing",
        bufferedMs: (this.queuedFrames / SAMPLE_RATE_HZ) * 1000,
        timingErrorMs: timingError * 1000,
        correctionRate: this.correctionRate,
        droppedFrames: this.droppedFrames,
        clockReanchors: this.clockReanchors,
      });
      this.droppedFrames = 0;
      this.clockReanchors = 0;
    }
    return true;
  }
}
registerProcessor("synced-pcm-source", SyncedPcmProcessor);
`;

interface ProcessAudioClockSample {
  capturedAtUnixMs: number;
  devicePosition: number;
  frameCount: number;
  sampleRate: number;
  rendererNowUnixMs: number;
}

/**
 * Validates the optional WASAPI QPC timestamp against the independent device
 * frame clock. Some process-loopback drivers return zero or a frozen QPC
 * position; accepting it creates an ever-growing fictitious capture delay.
 */
export class ProcessAudioCaptureClock {
  private lastCapturedAtUnixMs?: number;
  private lastDevicePosition?: number;

  reset(): void {
    this.lastCapturedAtUnixMs = undefined;
    this.lastDevicePosition = undefined;
  }

  observe(sample: ProcessAudioClockSample): number {
    const sampleRate =
      Number.isFinite(sample.sampleRate) && sample.sampleRate > 0
        ? sample.sampleRate
        : 48_000;
    const frameCount =
      Number.isFinite(sample.frameCount) && sample.frameCount > 0
        ? sample.frameCount
        : Math.round(sampleRate * 0.02);
    const rawAgeMs =
      sample.rendererNowUnixMs - sample.capturedAtUnixMs;
    let timestampProgressionValid = true;
    if (
      this.lastCapturedAtUnixMs !== undefined &&
      this.lastDevicePosition !== undefined &&
      Number.isFinite(sample.devicePosition) &&
      sample.devicePosition >= this.lastDevicePosition
    ) {
      const deviceDeltaFrames =
        sample.devicePosition - this.lastDevicePosition;
      const expectedDeltaMs = (deviceDeltaFrames / sampleRate) * 1_000;
      const timestampDeltaMs =
        sample.capturedAtUnixMs - this.lastCapturedAtUnixMs;
      // Both values originate from the same WASAPI packet, so normal device
      // clock quantization is only a few milliseconds. A 20 ms tolerance
      // would accidentally accept the common "frozen QPC" failure for every
      // ordinary 20 ms packet.
      const toleranceMs = Math.max(4, expectedDeltaMs * 0.1);
      timestampProgressionValid =
        Number.isFinite(timestampDeltaMs) &&
        timestampDeltaMs >= 0 &&
        Math.abs(timestampDeltaMs - expectedDeltaMs) <= toleranceMs;
    }

    this.lastCapturedAtUnixMs = sample.capturedAtUnixMs;
    this.lastDevicePosition = sample.devicePosition;

    if (
      Number.isFinite(rawAgeMs) &&
      rawAgeMs >= -100 &&
      rawAgeMs <= 2_000 &&
      timestampProgressionValid
    ) {
      return Math.max(0, rawAgeMs / 1_000);
    }

    // Invalid QPC data must not poison the AudioContext clock. Packet duration
    // plus a small IPC allowance is a conservative live estimate; actual
    // renderer backlog remains visible in the worklet's bounded queue.
    const packetDurationSeconds = frameCount / sampleRate;
    return Math.max(0.01, Math.min(0.12, packetDurationSeconds + 0.012));
  }
}

async function withProcessAudioTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export class ProcessAudioCapture extends EventTarget {
  private static readonly STALL_CHECK_INTERVAL_MS = 2_000;
  private static readonly STALL_THRESHOLD_MS = 8_000;

  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private delay?: DelayNode;
  private destination?: MediaStreamAudioDestinationNode;
  private removeDataListener?: () => void;
  private removeStatusListener?: () => void;
  private carry = new Uint8Array();
  private started = false;
  private captureId?: number;
  private audioDetected = false;
  private failureReported = false;
  private pendingFailure?: string;
  private packetCount = 0;
  private receivedBytes = 0;
  private lastPacketAt = 0;
  private track?: MediaStreamTrack;
  private silenceTimer?: number;
  private stallTimer?: number;
  private stallWatchdogArmed = false;
  private stallCheckPending = false;
  private lastTimingDiagnosticAt = 0;
  private stopPromise?: Promise<void>;
  private starting = false;
  private operationGeneration = 0;
  private readonly captureClock = new ProcessAudioCaptureClock();

  get active(): boolean {
    return this.started;
  }

  get diagnostics(): {
    captureId?: number;
    active: boolean;
    audioDetected: boolean;
    packetCount: number;
    receivedBytes: number;
    lastPacketAt: number;
    contextState?: AudioContextState;
    trackState?: MediaStreamTrackState;
  } {
    return {
      captureId: this.captureId,
      active: this.started,
      audioDetected: this.audioDetected,
      packetCount: this.packetCount,
      receivedBytes: this.receivedBytes,
      lastPacketAt: this.lastPacketAt,
      contextState: this.context?.state,
      trackState: this.track?.readyState,
    };
  }

  async start(): Promise<MediaStreamTrack> {
    if (this.starting) {
      throw new Error("窗口声音正在启动");
    }
    const generation = ++this.operationGeneration;
    this.starting = true;
    try {
      return await this.performStart(generation);
    } finally {
      if (generation === this.operationGeneration) this.starting = false;
    }
  }

  private async performStart(generation: number): Promise<MediaStreamTrack> {
    const bridge = window.roomDesktop;
    if (!bridge) {
      throw new Error("当前环境不支持按窗口采集声音");
    }
    if (this.started) {
      throw new Error("窗口声音已经在采集");
    }

    const context = new AudioContext({
      sampleRate: 48_000,
      latencyHint: "interactive",
    });
    this.context = context;
    const moduleUrl = URL.createObjectURL(
      new Blob([PROCESS_AUDIO_WORKLET_SOURCE], { type: "text/javascript" }),
    );
    try {
      await withProcessAudioTimeout(
        context.audioWorklet.addModule(moduleUrl),
        5_000,
        "加载窗口声音处理模块超时",
      );
    } catch (error) {
      await context.close().catch(() => undefined);
      if (this.context === context) this.context = undefined;
      throw error;
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    if (generation !== this.operationGeneration) {
      await context.close().catch(() => undefined);
      throw new DOMException("窗口声音启动已取消", "AbortError");
    }

    const node = new AudioWorkletNode(context, "synced-pcm-source", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
    });
    node.addEventListener("processorerror", () => {
      this.reportFailure("影片声音处理线程异常中断");
    });
    const delay = context.createDelay(0.12);
    delay.delayTime.value = 0;
    const destination = context.createMediaStreamDestination();
    node.connect(delay);
    delay.connect(destination);
    node.port.onmessage = (event) => {
      if (event.data?.type !== "timing") return;
      const timingErrorMs = Number(event.data.timingErrorMs) || 0;
      // A DelayNode can correct audio that is slightly ahead. Audio that is
      // behind is caught up continuously by the worklet's interpolated read
      // rate, because negative delay is impossible.
      const desiredDelay = Math.max(
        0,
        Math.min(0.08, -timingErrorMs / 1000),
      );
      delay.delayTime.cancelScheduledValues(context.currentTime);
      delay.delayTime.setTargetAtTime(
        desiredDelay,
        context.currentTime,
        0.2,
      );
      this.dispatchEvent(
        new CustomEvent("timing", { detail: event.data }),
      );
      const now = performance.now();
      if (
        now - this.lastTimingDiagnosticAt >= 5_000 &&
        (Math.abs(timingErrorMs) >= 80 ||
          Number(event.data.droppedFrames) > 0 ||
          Number(event.data.clockReanchors) > 0)
      ) {
        this.lastTimingDiagnosticAt = now;
        window.roomDesktop?.reportDiagnostic("process-audio-timing", {
          bufferedMs: Number(event.data.bufferedMs) || 0,
          timingErrorMs,
          correctionRate: Number(event.data.correctionRate) || 1,
          droppedFrames: Number(event.data.droppedFrames) || 0,
          clockReanchors: Number(event.data.clockReanchors) || 0,
        });
      }
    };

    this.node = node;
    this.delay = delay;
    this.destination = destination;
    this.audioDetected = false;
    this.failureReported = false;
    this.pendingFailure = undefined;
    this.captureId = undefined;
    this.packetCount = 0;
    this.receivedBytes = 0;
    this.lastPacketAt = 0;
    this.captureClock.reset();
    this.stallWatchdogArmed = false;
    this.stallCheckPending = false;
    this.removeDataListener = bridge.onProcessAudioData((packet) =>
      this.pushPcm(packet),
    );
    this.removeStatusListener = bridge.onProcessAudioStatus((status) => {
      const statusCaptureId = Number(status.captureId);
      if (
        this.captureId !== undefined &&
        Number.isSafeInteger(statusCaptureId) &&
        statusCaptureId !== this.captureId
      ) {
        return;
      }
      if (status.type === "error" || status.type === "stopped") {
        const message =
          status.message ||
          (status.type === "stopped"
            ? "窗口声音采集进程已经停止"
            : "窗口声音采集中断");
        if (!this.started) {
          this.pendingFailure = message;
        } else {
          this.reportFailure(message);
        }
      }
    });

    try {
      await withProcessAudioTimeout(
        context.resume(),
        3_000,
        "音频设备初始化超时",
      );
      if (generation !== this.operationGeneration) {
        throw new DOMException("窗口声音启动已取消", "AbortError");
      }
      const status = await withProcessAudioTimeout(
        bridge.startProcessAudio(),
        10_000,
        "Windows 窗口声音采集启动超时",
      );
      const captureId = Number(status.captureId);
      if (generation !== this.operationGeneration) {
        if (Number.isSafeInteger(captureId) && captureId > 0) {
          await withProcessAudioTimeout(
            bridge.stopProcessAudio(captureId),
            3_000,
            "停止已取消的窗口声音采集超时",
          ).catch(() => undefined);
        }
        throw new DOMException("窗口声音启动已取消", "AbortError");
      }
      const sampleRate = Number(status.sampleRate);
      const channels = Number(status.channels);
      const bitsPerSample = Number(status.bitsPerSample);
      if (!Number.isSafeInteger(captureId) || captureId <= 0) {
        throw new Error("Windows 未返回有效的窗口声音采集会话");
      }
      this.captureId = captureId;
      if (
        sampleRate !== 48_000 ||
        channels !== 2 ||
        bitsPerSample !== 16
      ) {
        throw new Error(
          `窗口声音协议不兼容（收到 ${sampleRate || "?"} Hz / ${channels || "?"} 声道 / ${bitsPerSample || "?"} bit）`,
        );
      }
      if (this.pendingFailure) {
        throw new Error(this.pendingFailure);
      }
      this.started = true;
      window.roomDesktop?.reportDiagnostic("process-audio-renderer-ready", {
        captureId,
        sampleRate,
        channels,
        bitsPerSample,
        latencyMs: Number(status.latencyMs) || 0,
        contextState: context.state,
      });
      this.silenceTimer = window.setTimeout(() => {
        this.silenceTimer = undefined;
        if (!this.audioDetected && this.started) {
          this.dispatchEvent(new Event("silence"));
        }
      }, 4_000);
      const track = destination.stream.getAudioTracks()[0];
      if (!track) {
        throw new Error("无法创建影片声音轨道");
      }
      track.contentHint = "music";
      this.track = track;
      track.addEventListener("ended", () => {
        if (this.started) {
          this.reportFailure("影片声音轨道已经结束");
        }
      });
      this.stallTimer = window.setInterval(() => {
        void this.checkForStalledFlow();
      }, ProcessAudioCapture.STALL_CHECK_INTERVAL_MS);
      return track;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    const stopping = this.performStop();
    this.stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopPromise === stopping) {
        this.stopPromise = undefined;
      }
    }
  }

  private async performStop(): Promise<void> {
    const bridge = window.roomDesktop;
    const captureId = this.captureId;
    this.operationGeneration += 1;
    this.starting = false;
    this.started = false;
    this.audioDetected = false;
    this.failureReported = false;
    this.pendingFailure = undefined;
    if (this.silenceTimer) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = undefined;
    }
    if (this.stallTimer !== undefined) {
      window.clearInterval(this.stallTimer);
      this.stallTimer = undefined;
    }
    this.stallWatchdogArmed = false;
    this.stallCheckPending = false;
    this.removeDataListener?.();
    this.removeStatusListener?.();
    this.removeDataListener = undefined;
    this.removeStatusListener = undefined;
    this.carry = new Uint8Array();
    this.captureClock.reset();
    this.captureId = undefined;
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.node = undefined;
    this.delay?.disconnect();
    this.delay = undefined;
    this.destination?.stream.getTracks().forEach((track) => track.stop());
    this.destination = undefined;
    this.track = undefined;
    if (this.context && this.context.state !== "closed") {
      await withProcessAudioTimeout(
        this.context.close(),
        3_000,
        "关闭音频上下文超时",
      ).catch(() => undefined);
    }
    this.context = undefined;
    if (captureId !== undefined) {
      await withProcessAudioTimeout(
        Promise.resolve(bridge?.stopProcessAudio(captureId)),
        3_000,
        "停止 Windows 窗口声音采集超时",
      ).catch(() => undefined);
    }
  }

  private pushPcm(packet: ProcessAudioPacket): void {
    const chunk = packet.pcm;
    if (
      this.captureId !== undefined &&
      Number.isSafeInteger(packet.captureId) &&
      packet.captureId !== this.captureId
    ) {
      return;
    }
    if (!this.node || !chunk.byteLength) {
      return;
    }
    if (packet.sampleRate !== 48_000) {
      this.reportFailure(
        `Windows 返回了不兼容的采样率：${packet.sampleRate} Hz`,
      );
      return;
    }
    this.packetCount += 1;
    this.receivedBytes += chunk.byteLength;
    this.lastPacketAt = Date.now();
    if (this.context?.state === "suspended") {
      void this.context.resume().catch(() => undefined);
    }
    const combined = new Uint8Array(this.carry.byteLength + chunk.byteLength);
    combined.set(this.carry);
    combined.set(chunk, this.carry.byteLength);
    const usableBytes = combined.byteLength - (combined.byteLength % 4);
    if (!usableBytes) {
      this.carry = combined;
      return;
    }

    const view = new DataView(combined.buffer, combined.byteOffset, usableBytes);
    const frames = usableBytes / 4;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    let peak = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const offset = frame * 4;
      left[frame] = view.getInt16(offset, true) / 32_768;
      right[frame] = view.getInt16(offset + 2, true) / 32_768;
      peak = Math.max(peak, Math.abs(left[frame]), Math.abs(right[frame]));
    }
    if (peak >= 0.001) {
      // Only arm the no-packet watchdog after real programme audio has flowed.
      // Process-loopback legitimately stops producing packets while a movie is
      // paused or silent, so arming it at startup would create a restart loop.
      this.stallWatchdogArmed = true;
    }
    if (!this.audioDetected && peak >= 0.001) {
      this.audioDetected = true;
      if (this.silenceTimer) {
        window.clearTimeout(this.silenceTimer);
        this.silenceTimer = undefined;
      }
      this.dispatchEvent(
        new CustomEvent<number>("activity", { detail: peak }),
      );
    }
    this.carry = combined.slice(usableBytes);
    const nowUnixMs = performance.timeOrigin + performance.now();
    const captureAgeSeconds = this.captureClock.observe({
      capturedAtUnixMs: Number(packet.capturedAtUnixMs),
      devicePosition: Number(packet.devicePosition),
      frameCount: frames,
      sampleRate: packet.sampleRate,
      rendererNowUnixMs: nowUnixMs,
    });
    this.node.port.postMessage(
      {
        left,
        right,
        captureAgeSeconds,
        devicePosition: packet.devicePosition,
      },
      [left.buffer, right.buffer],
    );
  }

  private async checkForStalledFlow(): Promise<void> {
    if (
      !this.started ||
      this.failureReported ||
      !this.stallWatchdogArmed ||
      this.stallCheckPending ||
      !this.lastPacketAt
    ) {
      return;
    }
    const rendererPacketAgeMs = Date.now() - this.lastPacketAt;
    if (rendererPacketAgeMs < ProcessAudioCapture.STALL_THRESHOLD_MS) {
      return;
    }

    // Disarm before crossing the IPC boundary. If the selected player is
    // intentionally paused, recovery creates a fresh capture that will not arm
    // again until non-silent programme audio resumes.
    this.stallWatchdogArmed = false;
    this.stallCheckPending = true;
    let mainStatus: unknown;
    try {
      mainStatus = await withProcessAudioTimeout(
        Promise.resolve(window.roomDesktop?.getProcessAudioStatus()),
        2_000,
        "读取窗口声音采集状态超时",
      ).catch(() => undefined);
    } finally {
      this.stallCheckPending = false;
    }
    if (!this.started || this.failureReported) return;
    const latestPacketAgeMs = Date.now() - this.lastPacketAt;
    if (latestPacketAgeMs < ProcessAudioCapture.STALL_THRESHOLD_MS) {
      this.stallWatchdogArmed = true;
      return;
    }

    window.roomDesktop?.reportDiagnostic("process-audio-flow-stalled", {
      captureId: this.captureId,
      rendererPacketAgeMs: latestPacketAgeMs,
      rendererPacketCount: this.packetCount,
      mainStatus,
    });
    this.reportFailure(
      "影片声音数据已停止流动，正在重新连接 Windows 音频设备",
    );
  }

  private reportFailure(message: string): void {
    if (this.failureReported) return;
    if (!this.started) {
      this.pendingFailure = String(message || "窗口声音采集中断");
      return;
    }
    this.failureReported = true;
    this.started = false;
    if (this.silenceTimer) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = undefined;
    }
    if (this.stallTimer !== undefined) {
      window.clearInterval(this.stallTimer);
      this.stallTimer = undefined;
    }
    this.stallWatchdogArmed = false;
    window.roomDesktop?.reportDiagnostic("process-audio-renderer-failed", {
      ...this.diagnostics,
      message: String(message).slice(0, 300),
    });
    this.dispatchEvent(
      new CustomEvent<string>("error", {
        detail: String(message || "窗口声音采集中断"),
      }),
    );
  }
}
