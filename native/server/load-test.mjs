import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function percentile(values, ratio) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function waitFor(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("response timeout"));
    }, timeoutMs);
    const onMessage = (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const socket = new WebSocket(url, {
      perMessageDeflate: false,
      handshakeTimeout: 5_000,
    });
    socket.once("open", () => {
      resolve({
        socket,
        connectMs: performance.now() - startedAt,
      });
    });
    socket.once("error", reject);
  });
}

async function ping(socket, sequence) {
  const startedAt = performance.now();
  const response = waitFor(socket, (message) => message.type === "pong");
  socket.send(JSON.stringify({ type: "ping", sequence }));
  await response;
  return performance.now() - startedAt;
}

async function probe(socket, index) {
  const probeId = `loadtest-${Date.now().toString(36)}-${index}`;
  const latencyStartedAt = performance.now();
  const latencyResponse = waitFor(
    socket,
    (message) =>
      message.type === "network:probe-result" &&
      message.probeId === probeId &&
      message.phase === "latency",
  );
  socket.send(
    JSON.stringify({
      type: "network:probe",
      probeVersion: 2,
      probeId,
      phase: "latency",
      sequence: 0,
      total: 1,
    }),
  );
  await latencyResponse;
  const latencyMs = performance.now() - latencyStartedAt;

  const chunks = 4;
  const chunkBytes = 64 * 1024;
  const uploadResponses = Promise.all(
    Array.from({ length: chunks }, (_, sequence) =>
      waitFor(
        socket,
        (message) =>
          message.type === "network:probe-result" &&
          message.probeId === probeId &&
          message.phase === "upload" &&
          message.sequence === sequence,
      ),
    ),
  );
  const uploadStartedAt = performance.now();
  for (let sequence = 0; sequence < chunks; sequence += 1) {
    socket.send(
      JSON.stringify({
        type: "network:probe",
        probeVersion: 2,
        probeId,
        phase: "upload",
        sequence,
        total: chunks,
        payload: "u".repeat(chunkBytes),
      }),
    );
  }
  await uploadResponses;
  const uploadKbps = Math.round(
    (chunks * chunkBytes * 8) /
      Math.max(1, performance.now() - uploadStartedAt),
  );

  const downloadResponses = Promise.all(
    Array.from({ length: chunks }, (_, sequence) =>
      waitFor(
        socket,
        (message) =>
          message.type === "network:probe-result" &&
          message.probeId === probeId &&
          message.phase === "download" &&
          message.sequence === sequence,
      ),
    ),
  );
  const downloadStartedAt = performance.now();
  for (let sequence = 0; sequence < chunks; sequence += 1) {
    socket.send(
      JSON.stringify({
        type: "network:probe",
        probeVersion: 2,
        probeId,
        phase: "download",
        sequence,
        total: chunks,
        payloadBytes: chunkBytes,
      }),
    );
  }
  await downloadResponses;
  const downloadKbps = Math.round(
    (chunks * chunkBytes * 8) /
      Math.max(1, performance.now() - downloadStartedAt),
  );
  return { latencyMs, uploadKbps, downloadKbps };
}

function usage() {
  return [
    "YiQiKan signal v3 bounded load test",
    "",
    "node server/load-test.mjs [options]",
    "  --url ws://127.0.0.1:8787/signal",
    "  --clients 32              concurrent signaling sockets (1-128)",
    "  --duration 20             ping soak duration in seconds (2-300)",
    "  --throughput-clients 2    clients running a 512 KiB v2 probe (0-8)",
    "",
    "Remote targets require YIQIKAN_LOADTEST_ALLOW_REMOTE=true.",
  ].join("\n");
}

if (process.argv.includes("--help")) {
  console.log(usage());
  process.exit(0);
}

const url = new URL(argument("url", "ws://127.0.0.1:8787/signal"));
if (!["ws:", "wss:"].includes(url.protocol) || url.pathname !== "/signal") {
  throw new Error("--url must be a ws(s):// URL ending in /signal");
}
const localTarget = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
if (!localTarget && process.env.YIQIKAN_LOADTEST_ALLOW_REMOTE !== "true") {
  throw new Error(
    "Refusing a remote load test without YIQIKAN_LOADTEST_ALLOW_REMOTE=true",
  );
}

const clientCount = boundedInteger(argument("clients", "32"), 32, 1, 128);
const durationSeconds = boundedInteger(
  argument("duration", "20"),
  20,
  2,
  300,
);
const throughputClientCount = boundedInteger(
  argument("throughput-clients", "2"),
  2,
  0,
  Math.min(8, clientCount),
);
const sockets = [];
const connectTimes = [];
const pingTimes = [];
const failures = [];
const probes = [];

try {
  for (let index = 0; index < clientCount; index += 1) {
    try {
      const connected = await openSocket(url);
      sockets.push(connected.socket);
      connectTimes.push(connected.connectMs);
    } catch (error) {
      failures.push(`connect ${index}: ${error.message}`);
    }
  }
  await Promise.all(
    sockets.slice(0, throughputClientCount).map(async (socket, index) => {
      try {
        probes.push(await probe(socket, index));
      } catch (error) {
        failures.push(`probe ${index}: ${error.message}`);
      }
    }),
  );

  const deadline = Date.now() + durationSeconds * 1_000;
  let sequence = 0;
  while (Date.now() < deadline && sockets.length) {
    const samples = await Promise.allSettled(
      sockets.map((socket) => ping(socket, sequence)),
    );
    samples.forEach((sample, index) => {
      if (sample.status === "fulfilled") {
        pingTimes.push(sample.value);
      } else {
        failures.push(`ping ${sequence}/${index}: ${sample.reason?.message}`);
      }
    });
    sequence += 1;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
} finally {
  sockets.forEach((socket) => socket.close());
}

const report = {
  url: url.toString(),
  requestedClients: clientCount,
  connectedClients: sockets.length,
  durationSeconds,
  connectionMs: {
    p50: percentile(connectTimes, 0.5),
    p95: percentile(connectTimes, 0.95),
    maximum: percentile(connectTimes, 1),
  },
  pingMs: {
    samples: pingTimes.length,
    p50: percentile(pingTimes, 0.5),
    p95: percentile(pingTimes, 0.95),
    maximum: percentile(pingTimes, 1),
  },
  probes,
  failureCount: failures.length,
  failures: failures.slice(0, 20),
};
console.log(JSON.stringify(report, null, 2));
if (
  sockets.length !== clientCount ||
  failures.length > 0 ||
  (report.pingMs.p95 !== undefined && report.pingMs.p95 > 2_000)
) {
  process.exitCode = 1;
}
