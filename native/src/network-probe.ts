import {
  type SignalClient,
  type SignalEnvelope,
} from "./rtc";
import { SignalClient as LiveSignalClient } from "./rtc";
import type {
  NetworkReport,
  NetworkType,
} from "./network-quality";
import {
  NETWORK_PROBE_CHUNK_BYTES,
  NETWORK_PROBE_MAX_CHUNKS,
  NETWORK_PROBE_V2_CHUNK_BYTES,
  NETWORK_PROBE_V2_MAX_CHUNKS,
} from "./probe-constants";

const LATENCY_SAMPLES = 5;
export {
  NETWORK_PROBE_CHUNK_BYTES,
  NETWORK_PROBE_V2_CHUNK_BYTES,
} from "./probe-constants";
const PROBE_TIMEOUT_MS = 8_000;
const CACHE_MAX_AGE_MS = 60_000;

type NetworkProbeVersion = 1 | 2;

const PROBE_PROFILES: Record<
  NetworkProbeVersion,
  { chunkBytes: number; chunks: number }
> = {
  1: {
    chunkBytes: NETWORK_PROBE_CHUNK_BYTES,
    chunks: NETWORK_PROBE_MAX_CHUNKS,
  },
  2: {
    chunkBytes: NETWORK_PROBE_V2_CHUNK_BYTES,
    chunks: NETWORK_PROBE_V2_MAX_CHUNKS,
  },
};

export function selectNetworkProbeVersion(
  serverVersions?: ReadonlyArray<number>,
): NetworkProbeVersion {
  if (serverVersions?.some((version) => Number(version) === 2)) return 2;
  return 1;
}

interface ProbeResult {
  payloadBytes: number;
  receivedAt: number;
}

interface CachedProbe {
  cacheKey: string;
  report: NetworkReport;
}

const cachedProbes = new Map<string, CachedProbe>();
const warmProbePromises = new Map<
  string,
  Promise<NetworkReport | undefined>
>();

export type IceRouteCandidateType = "direct" | "relay" | "unknown";

export function iceRouteCandidateType(
  candidate: string,
): IceRouteCandidateType {
  if (/\btyp\s+relay\b/iu.test(candidate)) return "relay";
  if (/\btyp\s+(?:host|srflx|prflx)\b/iu.test(candidate)) return "direct";
  return "unknown";
}

function filteredIceServers(
  iceServers: RTCIceServer[],
  kind: "direct" | "relay",
): RTCIceServer[] {
  const pattern =
    kind === "relay" ? /^turns?:/iu : /^stuns?:/iu;
  return iceServers.flatMap((server) => {
    const urls = (
      Array.isArray(server.urls) ? server.urls : [server.urls]
    ).filter((url): url is string => pattern.test(String(url || "")));
    return urls.length ? [{ ...server, urls }] : [];
  });
}

function gatherIceRoute(
  iceServers: RTCIceServer[],
  kind: "direct" | "relay",
  abortSignal?: AbortSignal,
  cellular = false,
): Promise<boolean | undefined> {
  const servers = filteredIceServers(iceServers, kind);
  if (!servers.length || typeof RTCPeerConnection === "undefined") {
    return Promise.resolve(undefined);
  }
  return new Promise<boolean | undefined>((resolve) => {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({
        iceServers: servers,
        iceTransportPolicy: kind === "relay" ? "relay" : "all",
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let timeout: number | undefined;
    const finish = (value: boolean | undefined): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
      pc.close();
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);
    timeout = window.setTimeout(
      () => finish(false),
      cellular
        ? kind === "relay"
          ? 7_000
          : 6_000
        : kind === "relay"
          ? 4_000
          : 3_000,
    );
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    pc.addEventListener("icecandidate", (event) => {
      if (!event.candidate) {
        finish(false);
        return;
      }
      const route = iceRouteCandidateType(event.candidate.candidate);
      if (
        (kind === "relay" && route === "relay") ||
        (kind === "direct" && route === "direct")
      ) {
        finish(true);
      }
    });
    try {
      pc.createDataChannel("synced-network-check", {
        ordered: false,
        maxRetransmits: 0,
      });
      void pc
        .createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}

export async function probeIceCandidateGatherability(
  iceServers: RTCIceServer[],
  abortSignal?: AbortSignal,
  options: { networkType?: NetworkType } = {},
): Promise<{
  directCandidateGatherable?: boolean;
  turnCandidateGatherable?: boolean;
}> {
  const [directCandidateGatherable, turnCandidateGatherable] =
    await Promise.all([
    gatherIceRoute(
      iceServers,
      "direct",
      abortSignal,
      options.networkType === "cellular",
    ),
    gatherIceRoute(
      iceServers,
      "relay",
      abortSignal,
      options.networkType === "cellular",
    ),
    ]);
  return {
    ...(directCandidateGatherable === undefined
      ? {}
      : { directCandidateGatherable }),
    ...(turnCandidateGatherable === undefined
      ? {}
      : { turnCandidateGatherable }),
  };
}

function probeId(): string {
  return (
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}-${crypto
      .getRandomValues(new Uint32Array(4))
      .join("-")}`
  );
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function connectionProfile(): {
  networkType: NetworkType;
  metered: boolean;
} {
  const connection = (
    navigator as Navigator & {
      connection?: {
        type?: string;
        effectiveType?: string;
        saveData?: boolean;
      };
    }
  ).connection;
  const declared = String(connection?.type || "").toLowerCase();
  const networkType: NetworkType =
    declared === "ethernet"
      ? "ethernet"
      : declared === "wifi"
        ? "wifi"
        : declared === "cellular"
          ? "cellular"
          : "unknown";
  return {
    networkType,
    metered: Boolean(connection?.saveData),
  };
}

function waitForProbeBatch(
  signal: SignalClient,
  expected: {
    probeId: string;
    phase: "latency" | "upload" | "download";
    total: number;
    probeVersion: NetworkProbeVersion;
  },
  abortSignal?: AbortSignal,
): Promise<Map<number, ProbeResult>> {
  return new Promise<Map<number, ProbeResult>>((resolve, reject) => {
    const received = new Map<number, ProbeResult>();
    let timeout: number | undefined;
    const cleanup = (): void => {
      signal.removeEventListener("message", onMessage);
      abortSignal?.removeEventListener("abort", onAbort);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => fail(new DOMException("测速已取消", "AbortError"));
    const onMessage = (event: Event): void => {
      const message = (event as CustomEvent<SignalEnvelope>).detail;
      if (
        message.type !== "network:probe-result" ||
        message.probeId !== expected.probeId ||
        message.phase !== expected.phase
      ) {
        return;
      }
      if (
        expected.probeVersion === 2 &&
        Number(message.probeVersion) !== 2
      ) {
        return;
      }
      const sequence = Number(message.sequence);
      if (
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        sequence >= expected.total ||
        Number(message.total) !== expected.total ||
        received.has(sequence)
      ) {
        return;
      }
      received.set(sequence, {
        payloadBytes: new TextEncoder().encode(
          String(message.payload || ""),
        ).byteLength,
        receivedAt: performance.now(),
      });
      if (received.size === expected.total) {
        cleanup();
        resolve(received);
      }
    };
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("message", onMessage);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timeout = window.setTimeout(
      () => fail(new Error("网络测速超时")),
      PROBE_TIMEOUT_MS,
    );
  });
}

function waitForProbeSequence(
  signal: SignalClient,
  expected: {
    probeId: string;
    phase: "latency";
    sequence: number;
    total: number;
    probeVersion: NetworkProbeVersion;
  },
  abortSignal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timeout: number | undefined;
    const cleanup = (): void => {
      signal.removeEventListener("message", onMessage);
      abortSignal?.removeEventListener("abort", onAbort);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void =>
      fail(new DOMException("测速已取消", "AbortError"));
    const onMessage = (event: Event): void => {
      const message = (event as CustomEvent<SignalEnvelope>).detail;
      if (
        message.type !== "network:probe-result" ||
        message.probeId !== expected.probeId ||
        message.phase !== expected.phase ||
        Number(message.sequence) !== expected.sequence ||
        Number(message.total) !== expected.total
      ) {
        return;
      }
      if (
        expected.probeVersion === 2 &&
        Number(message.probeVersion) !== 2
      ) {
        return;
      }
      cleanup();
      resolve();
    };
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("message", onMessage);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timeout = window.setTimeout(
      () => fail(new Error("网络测速超时")),
      PROBE_TIMEOUT_MS,
    );
  });
}

function createProbeResponseAbort(source?: AbortSignal): {
  signal: AbortSignal;
  abort: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (source?.aborted) {
    forwardAbort();
  } else {
    source?.addEventListener("abort", forwardAbort, { once: true });
  }
  return {
    signal: controller.signal,
    abort: forwardAbort,
    dispose: () => source?.removeEventListener("abort", forwardAbort),
  };
}

async function latencyProbe(
  signal: SignalClient,
  id: string,
  probeVersion: NetworkProbeVersion,
  abortSignal?: AbortSignal,
): Promise<number[]> {
  const samples: number[] = [];
  for (let sequence = 0; sequence < LATENCY_SAMPLES; sequence += 1) {
    const responseAbort = createProbeResponseAbort(abortSignal);
    const response = waitForProbeSequence(
      signal,
      {
        probeId: id,
        phase: "latency",
        sequence,
        total: LATENCY_SAMPLES,
        probeVersion,
      },
      responseAbort.signal,
    );
    const startedAt = performance.now();
    try {
      signal.send({
        type: "network:probe",
        probeId: id,
        phase: "latency",
        sequence,
        total: LATENCY_SAMPLES,
        ...(probeVersion === 2 ? { probeVersion } : {}),
      });
      await response;
      samples.push(performance.now() - startedAt);
    } catch (error) {
      responseAbort.abort();
      await response.catch(() => undefined);
      throw error;
    } finally {
      responseAbort.dispose();
    }
  }
  return samples;
}

async function throughputProbe(
  signal: SignalClient,
  id: string,
  phase: "upload" | "download",
  probeVersion: NetworkProbeVersion,
  abortSignal?: AbortSignal,
): Promise<number> {
  const profile = PROBE_PROFILES[probeVersion];
  const responseAbort = createProbeResponseAbort(abortSignal);
  const response = waitForProbeBatch(
    signal,
    {
      probeId: id,
      phase,
      total: profile.chunks,
      probeVersion,
    },
    responseAbort.signal,
  );
  const payload =
    phase === "upload"
      ? "s".repeat(profile.chunkBytes)
      : undefined;
  const startedAt = performance.now();
  try {
    for (let sequence = 0; sequence < profile.chunks; sequence += 1) {
      signal.send({
        type: "network:probe",
        probeId: id,
        phase,
        sequence,
        total: profile.chunks,
        payload,
        ...(probeVersion === 2
          ? {
              probeVersion,
              ...(phase === "download"
                ? { payloadBytes: profile.chunkBytes }
                : {}),
            }
          : {}),
      });
    }
    const results = await response;
    // The interval already starts immediately before payload transmission.
    // Subtracting a separately measured RTT can drive this toward zero on
    // cellular paths and inflate the result by orders of magnitude.
    const elapsedMs = Math.max(1, performance.now() - startedAt);
    const transferredBytes =
      phase === "upload"
        ? profile.chunkBytes * profile.chunks
        : [...results.values()].reduce(
            (total, result) => total + result.payloadBytes,
            0,
          );
    return Math.max(
      1,
      Math.round((transferredBytes * 8) / elapsedMs),
    );
  } catch (error) {
    responseAbort.abort();
    await response.catch(() => undefined);
    throw error;
  } finally {
    responseAbort.dispose();
  }
}

export async function runSignalNetworkProbe(
  signal: SignalClient,
  abortSignal?: AbortSignal,
  serverVersions?: ReadonlyArray<number>,
): Promise<NetworkReport> {
  if (!signal.connected) {
    throw new Error("信令服务器尚未连接");
  }
  const probeVersion = selectNetworkProbeVersion(
    serverVersions ?? signal.supportedNetworkProbeVersions,
  );
  const id = probeId();
  const rtts = await latencyProbe(
    signal,
    id,
    probeVersion,
    abortSignal,
  );
  const signalRttMs = median(rtts);
  const jitterMs = median(
    rtts.map((sample) => Math.abs(sample - signalRttMs)),
  );
  const uploadKbps = await throughputProbe(
    signal,
    id,
    "upload",
    probeVersion,
    abortSignal,
  );
  const downloadKbps = await throughputProbe(
    signal,
    id,
    "download",
    probeVersion,
    abortSignal,
  );
  return {
    probeVersion,
    sampleId: id,
    uploadKbps: Math.min(2_000_000, uploadKbps),
    downloadKbps: Math.min(2_000_000, downloadKbps),
    signalRttMs: Math.max(1, Math.min(10_000, Math.round(signalRttMs))),
    jitterMs: Math.max(0, Math.min(10_000, Math.round(jitterMs))),
    ...connectionProfile(),
    measuredAt: Date.now(),
  };
}

function networkProbeCacheKey(signalUrl: string, cacheScope = ""): string {
  return `${signalUrl}#${encodeURIComponent(cacheScope || "global")}`;
}

export function cachedNetworkProbe(
  signalUrl: string,
  cacheScope = "",
): NetworkReport | undefined {
  const cached = cachedProbes.get(
    networkProbeCacheKey(signalUrl, cacheScope),
  );
  if (
    !cached ||
    Date.now() - cached.report.measuredAt > CACHE_MAX_AGE_MS
  ) {
    return undefined;
  }
  return cached.report;
}

function rememberProbe(
  signalUrl: string,
  report: NetworkReport,
  cacheScope = "",
): NetworkReport {
  const cacheKey = networkProbeCacheKey(signalUrl, cacheScope);
  cachedProbes.set(cacheKey, { cacheKey, report });
  return report;
}

function waitForProbeNegotiation(
  signal: SignalClient,
  timeoutMs = 750,
): Promise<ReadonlyArray<number> | undefined> {
  if (signal.supportedNetworkProbeVersions !== undefined) {
    return Promise.resolve(signal.supportedNetworkProbeVersions);
  }
  return new Promise((resolve) => {
    let timer: number | undefined;
    const finish = (versions?: ReadonlyArray<number>): void => {
      signal.removeEventListener("message", onMessage);
      if (timer !== undefined) window.clearTimeout(timer);
      resolve(versions);
    };
    const onMessage = (event: Event): void => {
      const message = (event as CustomEvent<SignalEnvelope>).detail;
      if (message.type !== "server:hello") return;
      finish(message.networkProbe?.versions);
    };
    signal.addEventListener("message", onMessage);
    timer = window.setTimeout(() => finish(undefined), timeoutMs);
  });
}

export function warmNetworkProbe(
  signalUrl: string,
  cacheScope = "",
): Promise<NetworkReport | undefined> {
  const cacheKey = networkProbeCacheKey(signalUrl, cacheScope);
  const cached = cachedNetworkProbe(signalUrl, cacheScope);
  if (cached) return Promise.resolve(cached);
  const existing = warmProbePromises.get(cacheKey);
  if (existing) return existing;
  const promise = (async () => {
    const signal = new LiveSignalClient();
    try {
      await signal.connect(signalUrl);
      const serverVersions = await waitForProbeNegotiation(signal);
      return rememberProbe(
        signalUrl,
        await runSignalNetworkProbe(signal, undefined, serverVersions),
        cacheScope,
      );
    } catch {
      return undefined;
    } finally {
      signal.close();
      warmProbePromises.delete(cacheKey);
    }
  })();
  warmProbePromises.set(cacheKey, promise);
  return promise;
}

export async function ensureNetworkProbe(
  signalUrl: string,
  signal: SignalClient,
  options: {
    force?: boolean;
    abortSignal?: AbortSignal;
    cacheResult?: boolean;
    cacheScope?: string;
    serverVersions?: ReadonlyArray<number>;
  } = {},
): Promise<NetworkReport | undefined> {
  if (!options.force) {
    const cacheKey = networkProbeCacheKey(
      signalUrl,
      options.cacheScope,
    );
    const cached = cachedNetworkProbe(signalUrl, options.cacheScope);
    if (cached) return cached;
    const warming = warmProbePromises.get(cacheKey);
    if (warming) {
      const warmed = await warming;
      if (warmed) return warmed;
    }
  }
  try {
    const report = await runSignalNetworkProbe(
      signal,
      options.abortSignal,
      options.serverVersions,
    );
    return options.cacheResult === false
      ? report
      : rememberProbe(signalUrl, report, options.cacheScope);
  } catch {
    return undefined;
  }
}
