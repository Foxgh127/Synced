import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/process-audio.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    }).then(({ outputFiles }) =>
      import(
        `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
      ),
    );
  }
  return modulePromise;
}

test("process-audio startup is cancellable and every IPC wait is bounded", () => {
  const source = readFileSync(path.resolve("src/process-audio.ts"), "utf8");

  assert.match(source, /operationGeneration = 0/);
  assert.match(source, /generation !== this\.operationGeneration/);
  assert.match(
    source,
    /bridge\.stopProcessAudio\(captureId\)[\s\S]*?窗口声音启动已取消/,
  );
  assert.match(source, /withProcessAudioTimeout\([\s\S]*?startProcessAudio\(\)/);
  assert.match(source, /withProcessAudioTimeout\([\s\S]*?stopProcessAudio\(captureId\)/);
  assert.match(
    source,
    /finally \{\s*this\.stallCheckPending = false;\s*\}/,
  );
});

test("audio worklet uses a bounded ring and drains backlog progressively", async () => {
  const { PROCESS_AUDIO_WORKLET_SOURCE } = await loadModule();
  let Processor;
  const sandbox = {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { onmessage: null, postMessage() {} };
      }
    },
    Float32Array,
    Math,
    Number,
    currentFrame: 0,
    currentTime: 0,
    registerProcessor(_name, implementation) {
      Processor = implementation;
    },
  };
  vm.runInNewContext(PROCESS_AUDIO_WORKLET_SOURCE, sandbox);
  const processor = new Processor();

  for (let packet = 0; packet < 100; packet += 1) {
    const left = new Float32Array(960).fill(0.25);
    const right = new Float32Array(960).fill(-0.25);
    processor.port.onmessage({
      data: {
        left,
        right,
        captureAgeSeconds: 0.02,
        devicePosition: packet * 960,
      },
    });
  }
  assert.ok(processor.queuedFrames > 95_000);

  sandbox.currentTime = 1;
  sandbox.currentFrame = 48_000;
  const leftOutput = new Float32Array(128);
  const rightOutput = new Float32Array(128);
  assert.equal(processor.process([], [[leftOutput, rightOutput]]), true);
  assert.ok(processor.queuedFrames > 94_000);
  assert.ok(processor.correctionRate > 1);
  assert.ok(processor.correctionRate <= 1.05);
  assert.ok(leftOutput.every(Number.isFinite));
  assert.doesNotMatch(PROCESS_AUDIO_WORKLET_SOURCE, /\.splice\(/);
});

test("invalid or frozen WASAPI timestamps fall back to bounded live packet age", async () => {
  const { ProcessAudioCaptureClock } = await loadModule();
  const clock = new ProcessAudioCaptureClock();
  const startedAt = 1_800_000_000_000;
  const first = clock.observe({
    capturedAtUnixMs: startedAt - 800,
    devicePosition: 0,
    frameCount: 960,
    sampleRate: 48_000,
    rendererNowUnixMs: startedAt,
  });
  assert.equal(first, 0.8);

  for (let packet = 1; packet <= 10_000; packet += 1) {
    const age = clock.observe({
      // Reproduces drivers that expose a positive but frozen QPC position.
      capturedAtUnixMs: startedAt - 800,
      devicePosition: packet * 960,
      frameCount: 960,
      sampleRate: 48_000,
      rendererNowUnixMs: startedAt + packet * 20,
    });
    assert.ok(age >= 0.01);
    assert.ok(age <= 0.12);
  }
});

test("audio worklet accepts packets after a WASAPI device-position reset", async () => {
  const { PROCESS_AUDIO_WORKLET_SOURCE } = await loadModule();
  let Processor;
  const sandbox = {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { onmessage: null, postMessage() {} };
      }
    },
    Float32Array,
    Math,
    Number,
    currentFrame: 0,
    currentTime: 0,
    registerProcessor(_name, implementation) {
      Processor = implementation;
    },
  };
  vm.runInNewContext(PROCESS_AUDIO_WORKLET_SOURCE, sandbox);
  const processor = new Processor();
  const left = new Float32Array(960).fill(0.2);
  const right = new Float32Array(960).fill(-0.2);
  processor.port.onmessage({
    data: {
      left,
      right,
      captureAgeSeconds: 0.02,
      devicePosition: 960_000,
    },
  });
  processor.port.onmessage({
    data: {
      left,
      right,
      captureAgeSeconds: 0.02,
      devicePosition: 0,
    },
  });
  assert.equal(processor.queuedFrames, 960);
  assert.equal(processor.lastDeviceEnd, 960);
  assert.ok(processor.clockReanchors >= 1);
});

test("audio worklet does not discard Chromium PCM when WASAPI device position is frozen at zero", async () => {
  const { PROCESS_AUDIO_WORKLET_SOURCE } = await loadModule();
  let Processor;
  const sandbox = {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { onmessage: null, postMessage() {} };
      }
    },
    Float32Array,
    Math,
    Number,
    currentFrame: 0,
    currentTime: 0,
    registerProcessor(_name, implementation) {
      Processor = implementation;
    },
  };
  vm.runInNewContext(PROCESS_AUDIO_WORKLET_SOURCE, sandbox);
  const processor = new Processor();

  for (let packet = 0; packet < 4; packet += 1) {
    processor.port.onmessage({
      data: {
        left: new Float32Array(960).fill(0.25),
        right: new Float32Array(960).fill(-0.25),
        captureAgeSeconds: 0.02,
        // Chromium process-loopback can return zero for every valid packet.
        devicePosition: 0,
      },
    });
  }

  assert.equal(processor.devicePositionFrozen, true);
  assert.equal(processor.queuedFrames, 3_840);
  processor.port.onmessage({
    data: {
      left: new Float32Array(960).fill(0.25),
      right: new Float32Array(960).fill(-0.25),
      captureAgeSeconds: 0.02,
      devicePosition: 960,
    },
  });
  assert.equal(processor.devicePositionFrozen, false);
  assert.equal(processor.queuedFrames, 4_800);
  const leftOutput = new Float32Array(128);
  const rightOutput = new Float32Array(128);
  assert.equal(
    processor.process([], [[leftOutput, rightOutput]]),
    true,
  );
  assert.ok(leftOutput.some((sample) => sample > 0.01));
  assert.ok(rightOutput.some((sample) => sample < -0.01));
});

test("audio worklet clock remains bounded during a ten-minute run and pause", async () => {
  const { PROCESS_AUDIO_WORKLET_SOURCE } = await loadModule();
  let Processor;
  const timing = [];
  const sandbox = {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          onmessage: null,
          postMessage(data) {
            timing.push({ ...data, at: sandbox.currentTime });
          },
        };
      }
    },
    Float32Array,
    Math,
    Number,
    currentFrame: 0,
    currentTime: 0,
    registerProcessor(_name, implementation) {
      Processor = implementation;
    },
  };
  vm.runInNewContext(PROCESS_AUDIO_WORKLET_SOURCE, sandbox);
  const processor = new Processor();
  const left = new Float32Array(960).fill(0.2);
  const right = new Float32Array(960).fill(-0.2);
  const leftOutput = new Float32Array(128);
  const rightOutput = new Float32Array(128);
  let devicePosition = 0;

  const renderQuantum = () => {
    processor.process([], [[leftOutput, rightOutput]]);
    sandbox.currentFrame += 128;
    sandbox.currentTime = sandbox.currentFrame / 48_000;
  };

  // 30,000 x 20 ms = ten minutes. Alternating seven/eight worklet quanta
  // advances exactly 960 renderer frames per packet on average.
  for (let packet = 0; packet < 30_000; packet += 1) {
    processor.port.onmessage({
      data: {
        left,
        right,
        captureAgeSeconds: 0.02,
        devicePosition,
      },
    });
    devicePosition += 960;
    const quantumCount = packet % 2 === 0 ? 7 : 8;
    for (let quantum = 0; quantum < quantumCount; quantum += 1) {
      renderQuantum();
    }

    if (packet === 10_000) {
      // A player may stop producing loopback packets while paused. Rendering
      // continues, then the device clock resumes without a stale anchor.
      for (let quantum = 0; quantum < 750; quantum += 1) {
        renderQuantum();
      }
    }
  }

  const settled = timing.filter(({ at }) => at > 210);
  assert.ok(settled.length > 300);
  assert.ok(
    settled.every(({ timingErrorMs }) => Math.abs(timingErrorMs) < 250),
    `unbounded timing error: ${Math.max(
      ...settled.map(({ timingErrorMs }) => Math.abs(timingErrorMs)),
    )} ms`,
  );
  assert.ok(
    settled.every(
      ({ correctionRate }) =>
        correctionRate >= 0.995 && correctionRate <= 1.05,
    ),
  );
  assert.ok(
    settled.slice(-60).some(({ correctionRate }) => correctionRate < 1.05),
    "correction must not remain pinned at 1.05 after recovery",
  );
});
