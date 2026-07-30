export interface CaptureFrameRateSample {
  framesPerSecond?: number;
  qualityLimitationReason?: string;
}

export interface CaptureFrameRateDecision {
  changed: boolean;
  frameRate?: number;
}

const COMMON_CONTENT_FRAME_RATES = [24, 25, 30, 50, 60, 90, 120] as const;
const REQUIRED_STABLE_SAMPLES = 5;

/**
 * Detects a stable content cadence from encoder output without mistaking
 * bandwidth/CPU throttling for a 24/25 fps movie. A successful decision is
 * confirmed by the caller only after the capture track accepts the constraint.
 */
export class CaptureFrameRateController {
  private configuredFrameRate = 30;
  private candidate?: number;
  private candidateSamples = 0;
  private appliedFrameRate?: number;

  configure(frameRate: number): void {
    this.configuredFrameRate = Math.max(1, Math.round(frameRate));
    this.candidate = undefined;
    this.candidateSamples = 0;
    this.appliedFrameRate = undefined;
  }

  observe(sample: CaptureFrameRateSample): CaptureFrameRateDecision {
    // Outbound fps can also fall because the encoder or GCC is constrained.
    // Only an explicitly unconstrained sample is evidence of source cadence.
    if (sample.qualityLimitationReason !== "none") {
      this.resetCandidate();
      return { changed: false };
    }
    const measured = Number(sample.framesPerSecond);
    if (!Number.isFinite(measured) || measured <= 0) {
      this.resetCandidate();
      return { changed: false };
    }
    const cadence = COMMON_CONTENT_FRAME_RATES.reduce((nearest, current) =>
      Math.abs(current - measured) < Math.abs(nearest - measured)
        ? current
        : nearest,
    );
    const tolerance = Math.max(0.8, cadence * 0.04);
    if (
      Math.abs(cadence - measured) > tolerance ||
      cadence >= this.configuredFrameRate * 0.85 ||
      cadence === this.appliedFrameRate
    ) {
      this.resetCandidate();
      return { changed: false };
    }
    if (this.candidate === cadence) {
      this.candidateSamples += 1;
    } else {
      this.candidate = cadence;
      this.candidateSamples = 1;
    }
    if (this.candidateSamples < REQUIRED_STABLE_SAMPLES) {
      return { changed: false };
    }
    this.resetCandidate();
    return { changed: true, frameRate: cadence };
  }

  confirmApplied(frameRate: number): void {
    this.appliedFrameRate = Math.max(1, Math.round(frameRate));
    this.resetCandidate();
  }

  private resetCandidate(): void {
    this.candidate = undefined;
    this.candidateSamples = 0;
  }
}
