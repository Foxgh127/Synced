export interface CaptureVideoHealthSample {
  sourceChanged?: boolean;
  thumbnailActivity?: number;
  framesEncoded?: number;
  encoderPresent?: boolean;
  trackMuted?: boolean;
}

export interface CaptureVideoHealthDecision {
  recover: boolean;
  reason?: "source-changed" | "encoder-stalled" | "near-black" | "track-muted";
  attempts: number;
}

const MAX_RECOVERIES = 3;
const MIN_RECOVERY_COOLDOWN_MS = 8_000;
const STABLE_RESET_MS = 30_000;

export class CaptureVideoHealthController {
  private lastFramesEncoded?: number;
  private stalledSamples = 0;
  private darkSamples = 0;
  private sawActiveThumbnail = false;
  private stableSince?: number;
  private recoveryAttempts = 0;
  private cooldownUntil = 0;

  reset(): void {
    this.lastFramesEncoded = undefined;
    this.stalledSamples = 0;
    this.darkSamples = 0;
    this.sawActiveThumbnail = false;
    this.stableSince = undefined;
    this.recoveryAttempts = 0;
    this.cooldownUntil = 0;
  }

  claim(
    reason: CaptureVideoHealthDecision["reason"],
    now = Date.now(),
  ): CaptureVideoHealthDecision {
    if (
      !reason ||
      this.recoveryAttempts >= MAX_RECOVERIES ||
      now < this.cooldownUntil
    ) {
      return {
        recover: false,
        attempts: this.recoveryAttempts,
      };
    }
    this.recoveryAttempts += 1;
    this.cooldownUntil =
      now +
      Math.max(
        MIN_RECOVERY_COOLDOWN_MS,
        this.recoveryAttempts * 5_000,
      );
    this.stalledSamples = 0;
    this.darkSamples = 0;
    this.stableSince = undefined;
    return {
      recover: true,
      reason,
      attempts: this.recoveryAttempts,
    };
  }

  observe(
    sample: CaptureVideoHealthSample,
    now = Date.now(),
  ): CaptureVideoHealthDecision {
    const activity = Number(sample.thumbnailActivity);
    const activeThumbnail =
      Number.isFinite(activity) && activity >= 0.02;
    const nearBlack =
      Number.isFinite(activity) && activity <= 0.005;
    if (activeThumbnail) {
      this.sawActiveThumbnail = true;
      this.darkSamples = 0;
    } else if (
      nearBlack &&
      this.sawActiveThumbnail &&
      !sample.trackMuted
    ) {
      this.darkSamples += 1;
    } else if (!nearBlack) {
      this.darkSamples = 0;
    }

    const frames = Number(sample.framesEncoded);
    const encoderPresent =
      sample.encoderPresent === true &&
      Number.isFinite(frames) &&
      frames >= 0;
    let encoderProgressed = false;
    if (encoderPresent) {
      if (this.lastFramesEncoded !== undefined) {
        // Sender replacement/renegotiation can reset the cumulative counter.
        // Any change proves the encoder is alive; only equality is a stall.
        encoderProgressed = frames !== this.lastFramesEncoded;
        this.stalledSamples = encoderProgressed
          ? 0
          : this.stalledSamples + 1;
      }
      this.lastFramesEncoded = frames;
    } else {
      this.lastFramesEncoded = undefined;
      this.stalledSamples = 0;
    }

    if (
      activeThumbnail &&
      (!encoderPresent || encoderProgressed)
    ) {
      this.stableSince ??= now;
      if (now - this.stableSince >= STABLE_RESET_MS) {
        this.recoveryAttempts = 0;
      }
    } else {
      this.stableSince = undefined;
    }

    const reason = sample.sourceChanged
      ? "source-changed"
      : this.stalledSamples >= 2
        ? "encoder-stalled"
        : this.darkSamples >= 4
          ? "near-black"
          : undefined;
    return this.claim(reason, now);
  }
}
