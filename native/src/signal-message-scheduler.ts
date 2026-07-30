export interface SchedulableSignalMessage {
  type: string;
  from?: string;
  viewerId?: string;
  broadcasterId?: string;
  participantId?: string;
  target?: string;
  sessionId?: string;
  attempt?: number;
}

type MessageHandler<T> = (
  message: T,
  signal: AbortSignal,
) => void | Promise<void>;

export interface SignalMessageSchedulerOptions<T> {
  handle: MessageHandler<T>;
  onError: (error: unknown, message: T) => void;
  timeoutMs?: number | ((message: T) => number);
}

const LATEST_ONLY_TYPES = new Set([
  "quality:request",
  "network:advice",
  "broadcast:capabilities",
  "participant:updated",
]);

const LIFECYCLE_TYPES = new Set([
  "server:hello",
  "channel:joined",
  "broadcast:granted",
  "broadcast:started",
  "broadcast:stopped",
  "moderation:kicked",
  "error",
]);

/**
 * WebSocket delivery order is preserved only where it is semantically
 * required. SDP/ICE runs in a queue scoped to one peer negotiation, mutable
 * state is coalesced to its latest value, and independent room events run
 * without waiting for unrelated media operations.
 */
export class SignalMessageScheduler<
  T extends SchedulableSignalMessage,
> {
  private readonly serialTails = new Map<string, Promise<void>>();
  private readonly latest = new Map<string, T>();
  private readonly latestWorkers = new Map<string, number>();
  private readonly activeControllers = new Set<AbortController>();
  private generation = 0;
  private closed = false;

  constructor(private readonly options: SignalMessageSchedulerOptions<T>) {}

  dispatch(message: T): void {
    if (this.closed) return;
    const generation = this.generation;
    if (message.type === "signal" || message.type === "media:ice-restart") {
      this.enqueueSerial(this.peerKey(message), message, generation);
      return;
    }
    if (LATEST_ONLY_TYPES.has(message.type)) {
      const key = this.latestKey(message);
      this.latest.set(key, message);
      if (this.latestWorkers.get(key) !== generation) {
        this.latestWorkers.set(key, generation);
        void this.drainLatest(key, generation);
      }
      return;
    }
    if (LIFECYCLE_TYPES.has(message.type)) {
      this.enqueueSerial("room-lifecycle", message, generation);
      return;
    }
    void this.run(message, generation);
  }

  reset(): void {
    this.generation += 1;
    for (const controller of this.activeControllers) {
      controller.abort(
        new DOMException("Signal scheduler generation replaced", "AbortError"),
      );
    }
    this.activeControllers.clear();
    this.latest.clear();
    this.latestWorkers.clear();
    this.serialTails.clear();
  }

  close(): void {
    this.closed = true;
    this.reset();
  }

  private enqueueSerial(key: string, message: T, generation: number): void {
    const previous = this.serialTails.get(key) || Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.run(message, generation))
      .finally(() => {
        if (this.serialTails.get(key) === operation) {
          this.serialTails.delete(key);
        }
      });
    this.serialTails.set(key, operation);
  }

  private async drainLatest(key: string, generation: number): Promise<void> {
    try {
      while (
        !this.closed &&
        generation === this.generation &&
        this.latest.has(key)
      ) {
        const message = this.latest.get(key)!;
        this.latest.delete(key);
        await this.run(message, generation);
      }
    } finally {
      if (this.latestWorkers.get(key) === generation) {
        this.latestWorkers.delete(key);
      }
      if (
        !this.closed &&
        generation === this.generation &&
        this.latest.has(key) &&
        !this.latestWorkers.has(key)
      ) {
        this.latestWorkers.set(key, generation);
        void this.drainLatest(key, generation);
      }
    }
  }

  private async run(message: T, generation: number): Promise<void> {
    if (this.closed || generation !== this.generation) return;
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const configuredTimeout =
      typeof this.options.timeoutMs === "function"
        ? this.options.timeoutMs(message)
        : this.options.timeoutMs;
    const timeoutMs = Math.max(
      1_000,
      Math.min(60_000, Number(configuredTimeout) || 20_000),
    );
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = globalThis.setTimeout(() => {
          const error = new DOMException(
            `Signal handler timed out after ${timeoutMs} ms`,
            "TimeoutError",
          );
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      await Promise.race([
        Promise.resolve(this.options.handle(message, controller.signal)),
        deadline,
      ]);
    } catch (error) {
      if (!this.closed && generation === this.generation) {
        this.options.onError(error, message);
      }
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      controller.abort(
        new DOMException("Signal handler completed", "AbortError"),
      );
      this.activeControllers.delete(controller);
    }
  }

  private peerKey(message: T): string {
    return [
      "peer",
      message.from ||
        message.viewerId ||
        message.broadcasterId ||
        message.participantId ||
        message.target ||
        "broadcaster",
      message.sessionId || "session",
      Number(message.attempt) || 1,
    ].join(":");
  }

  private latestKey(message: T): string {
    return [
      "latest",
      message.type,
      message.viewerId ||
        message.participantId ||
        message.broadcasterId ||
        message.from ||
        "room",
    ].join(":");
  }
}
