import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  modulePromise ??= build({
    entryPoints: [path.resolve("src/network-probe.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  }).then(({ outputFiles }) =>
    import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
    ),
  );
  return modulePromise;
}

test("probe chunks stay inside Web Crypto and signal-server limits", async () => {
  const {
    NETWORK_PROBE_CHUNK_BYTES,
    NETWORK_PROBE_V2_CHUNK_BYTES,
    iceRouteCandidateType,
    selectNetworkProbeVersion,
  } =
    await loadModule();
  assert.equal(NETWORK_PROBE_CHUNK_BYTES, 32 * 1024);
  assert.equal(NETWORK_PROBE_V2_CHUNK_BYTES, 64 * 1024);
  assert.ok(NETWORK_PROBE_CHUNK_BYTES <= 65_536);
  assert.equal(selectNetworkProbeVersion([1, 2]), 2);
  assert.equal(selectNetworkProbeVersion([1]), 1);
  assert.equal(selectNetworkProbeVersion(undefined), 1);
  assert.equal(
    iceRouteCandidateType(
      "candidate:1 1 udp 2122260223 192.0.2.3 54000 typ srflx",
    ),
    "direct",
  );
  assert.equal(
    iceRouteCandidateType(
      "candidate:2 1 udp 1677734911 203.0.113.9 3478 typ relay",
    ),
    "relay",
  );
});

test("negotiates v2 with a control-channel-safe 128 KiB ceiling", async () => {
  const { NETWORK_PROBE_V2_CHUNK_BYTES, runSignalNetworkProbe } =
    await loadModule();
  globalThis.window ??= globalThis;
  globalThis.CustomEvent ??= class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  };
  class FakeSignal extends EventTarget {
    connected = true;
    sent = [];

    send(message) {
      this.sent.push(message);
      queueMicrotask(() => {
        this.dispatchEvent(
          new CustomEvent("message", {
            detail: {
              type: "network:probe-result",
              probeId: message.probeId,
              phase: message.phase,
              sequence: message.sequence,
              total: message.total,
              probeVersion: message.probeVersion,
              payload:
                message.phase === "download"
                  ? "d".repeat(message.payloadBytes)
                  : undefined,
            },
          }),
        );
      });
    }
  }
  const signal = new FakeSignal();
  const report = await runSignalNetworkProbe(
    signal,
    undefined,
    [1, 2],
  );
  assert.equal(report.probeVersion, 2);
  const upload = signal.sent.filter((message) => message.phase === "upload");
  const download = signal.sent.filter(
    (message) => message.phase === "download",
  );
  assert.equal(upload.length, 2);
  assert.equal(download.length, 2);
  assert.ok(upload.every((message) => message.probeVersion === 2));
  assert.ok(
    upload.every(
      (message) =>
        new TextEncoder().encode(message.payload).byteLength ===
        NETWORK_PROBE_V2_CHUNK_BYTES,
    ),
  );
  assert.ok(
    download.every(
      (message) =>
        message.probeVersion === 2 &&
        message.payloadBytes === NETWORK_PROBE_V2_CHUNK_BYTES,
    ),
  );
});

test("signal probe measures bounded latency, upload and download", async () => {
  const { NETWORK_PROBE_CHUNK_BYTES, runSignalNetworkProbe } =
    await loadModule();
  globalThis.window ??= globalThis;
  globalThis.CustomEvent ??= class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  };
  class FakeSignal extends EventTarget {
    connected = true;
    sent = [];

    send(message) {
      this.sent.push(message);
      queueMicrotask(() => {
        this.dispatchEvent(
          new CustomEvent("message", {
            detail: {
              type: "network:probe-result",
              probeId: message.probeId,
              phase: message.phase,
              sequence: message.sequence,
              total: message.total,
              payload:
                message.phase === "download"
                  ? "d".repeat(NETWORK_PROBE_CHUNK_BYTES)
                  : undefined,
            },
          }),
        );
      });
    }
  }
  const signal = new FakeSignal();
  const report = await runSignalNetworkProbe(signal);
  assert.equal(report.probeVersion, 1);
  assert.ok(report.signalRttMs >= 1);
  assert.ok(report.uploadKbps > 0);
  assert.ok(report.downloadKbps > 0);
  const uploadMessages = signal.sent.filter(
    (message) => message.phase === "upload",
  );
  const downloadMessages = signal.sent.filter(
    (message) => message.phase === "download",
  );
  assert.equal(uploadMessages.length, 2);
  assert.equal(downloadMessages.length, 2);
  assert.ok(
    uploadMessages.every(
      (message) =>
        new TextEncoder().encode(message.payload).byteLength <=
        NETWORK_PROBE_CHUNK_BYTES,
    ),
  );
});

test("a send-side disconnect immediately removes pending probe listeners", async () => {
  const { runSignalNetworkProbe } = await loadModule();
  globalThis.window ??= globalThis;
  class DisconnectingSignal extends EventTarget {
    connected = true;
    activeMessageListeners = new Set();

    addEventListener(type, listener, options) {
      super.addEventListener(type, listener, options);
      if (type === "message") this.activeMessageListeners.add(listener);
    }

    removeEventListener(type, listener, options) {
      super.removeEventListener(type, listener, options);
      if (type === "message") this.activeMessageListeners.delete(listener);
    }

    send() {
      throw new Error("信令服务器尚未连接");
    }
  }
  const signal = new DisconnectingSignal();

  await assert.rejects(
    runSignalNetworkProbe(signal),
    /信令服务器尚未连接/,
  );
  assert.equal(signal.activeMessageListeners.size, 0);
});
