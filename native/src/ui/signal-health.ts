export type SignalHealthState = "checking" | "online" | "offline";

export interface SignalHealth {
  state: SignalHealthState;
  latencyMs?: number;
}

function healthUrl(signalUrl: string): string {
  const url = new URL(signalUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function probeSignalHealth(
  signalUrl: string,
  signal?: AbortSignal,
): Promise<SignalHealth> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4_000);
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const started = performance.now();
  try {
    const response = await fetch(healthUrl(signalUrl), {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    return response.ok
      ? {
          state: "online",
          latencyMs: Math.max(1, Math.round(performance.now() - started)),
        }
      : { state: "offline" };
  } catch {
    return { state: "offline" };
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
