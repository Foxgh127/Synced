export type AdaptiveDirection = "down" | "up";

export interface AdaptiveNetworkSample {
  connectionState?: RTCPeerConnectionState;
  packetLossRatio?: number;
  jitter?: number;
  freezeDurationDelta?: number;
  framesDroppedRatio?: number;
  averageDecodeTime?: number;
  frameRate?: number;
}

export interface AdaptiveQualityDecision {
  changed: boolean;
  direction?: AdaptiveDirection;
  requestedHeight?: number;
  reason?: string;
}

const REDUCED_HEIGHTS = [1440, 1200, 1080, 720, 480, 360] as const;
const POOR_SCORE_TO_DEGRADE = 5;
const STABLE_SAMPLES_TO_UPGRADE = 5;
const DEGRADE_COOLDOWN_MS = 4_000;
const UPGRADE_COOLDOWN_MS = 5_000;

function buildHeightLadder(
  sourceHeight: number,
  ceilingHeight: number,
): Array<number | undefined> {
  const source = Math.max(1, Math.round(sourceHeight));
  const ceiling =
    ceilingHeight > 0 ? Math.min(source, Math.round(ceilingHeight)) : source;
  const best = ceiling < source ? ceiling : undefined;
  const ladder: Array<number | undefined> = [best];
  for (const height of REDUCED_HEIGHTS) {
    if (height < ceiling && height < source && !ladder.includes(height)) {
      ladder.push(height);
    }
  }
  return ladder;
}

/**
 * A hysteretic controller sampled once per second by the playback session.
 * It ignores short Wi-Fi stalls, steps through a 1200p intermediate rung,
 * and recovers after five stable samples instead of holding reduced quality
 * long after the path has recovered.
 */
export class AdaptivePlaybackController {
  private ladder: Array<number | undefined> = [undefined];
  private level = 0;
  private poorScore = 0;
  private stableSamples = 0;
  private lastChangeAt = Number.NEGATIVE_INFINITY;

  configure(
    sourceHeight: number,
    ceilingHeight = 0,
    preserveCurrent = false,
  ): void {
    const previous = this.requestedHeight;
    this.ladder = buildHeightLadder(sourceHeight, ceilingHeight);
    this.level = 0;
    if (preserveCurrent && previous !== undefined) {
      const exact = this.ladder.indexOf(previous);
      if (exact >= 0) {
        this.level = exact;
      } else {
        const compatible = this.ladder.findIndex(
          (height) => height !== undefined && height <= previous,
        );
        this.level = compatible >= 0 ? compatible : this.ladder.length - 1;
      }
    }
    if (!preserveCurrent) {
      this.lastChangeAt = Number.NEGATIVE_INFINITY;
    }
    this.resetSamples();
  }

  get requestedHeight(): number | undefined {
    return this.ladder[this.level];
  }

  get reduced(): boolean {
    return this.level > 0;
  }

  get levelCount(): number {
    return this.ladder.length;
  }

  resetSamples(): void {
    this.poorScore = 0;
    this.stableSamples = 0;
  }

  forceDegrade(reason = "首帧持续未到达"): AdaptiveQualityDecision {
    if (this.level >= this.ladder.length - 1) {
      return {
        changed: false,
        requestedHeight: this.requestedHeight,
      };
    }
    this.level += 1;
    this.lastChangeAt = Date.now();
    this.resetSamples();
    return {
      changed: true,
      direction: "down",
      requestedHeight: this.requestedHeight,
      reason,
    };
  }

  observe(
    sample: AdaptiveNetworkSample,
    now = Date.now(),
  ): AdaptiveQualityDecision {
    const loss = sample.packetLossRatio;
    const jitter = sample.jitter;
    const freeze = sample.freezeDurationDelta;
    const dropped = sample.framesDroppedRatio;
    const decodeLoad =
      sample.averageDecodeTime !== undefined &&
      sample.frameRate !== undefined &&
      sample.frameRate > 0
        ? sample.averageDecodeTime * sample.frameRate
        : undefined;
    const disconnected =
      sample.connectionState === "disconnected" ||
      sample.connectionState === "failed";
    const severe =
      sample.connectionState === "failed" ||
      (loss !== undefined && loss >= 0.12) ||
      (jitter !== undefined && jitter >= 0.18) ||
      (freeze !== undefined && freeze >= 0.5) ||
      (dropped !== undefined && dropped >= 0.18) ||
      (decodeLoad !== undefined && decodeLoad >= 0.9);
    const poor =
      disconnected ||
      (loss !== undefined && loss >= 0.035) ||
      (jitter !== undefined && jitter >= 0.08) ||
      (freeze !== undefined && freeze >= 0.18) ||
      (dropped !== undefined && dropped >= 0.06) ||
      (decodeLoad !== undefined && decodeLoad >= 0.65);
    const stable =
      sample.connectionState === "connected" &&
      (loss === undefined || loss <= 0.01) &&
      (jitter === undefined || jitter <= 0.04) &&
      (freeze === undefined || freeze <= 0.04) &&
      (dropped === undefined || dropped <= 0.015) &&
      (decodeLoad === undefined || decodeLoad <= 0.45);

    if (poor) {
      this.poorScore += severe ? 2 : 1;
      this.stableSamples = 0;
    } else if (stable) {
      this.poorScore = Math.max(0, this.poorScore - 1);
      this.stableSamples += 1;
    } else {
      this.poorScore = Math.max(0, this.poorScore - 1);
      // Neutral samples are weak recovery evidence. Count them at half speed
      // so a mildly lossy but otherwise stable path can eventually recover.
      this.stableSamples += 0.5;
    }

    if (
      this.poorScore >= POOR_SCORE_TO_DEGRADE &&
      this.level < this.ladder.length - 1 &&
      now - this.lastChangeAt >= DEGRADE_COOLDOWN_MS
    ) {
      this.level += 1;
      this.lastChangeAt = now;
      this.resetSamples();
      return {
        changed: true,
        direction: "down",
        requestedHeight: this.requestedHeight,
        reason:
          dropped !== undefined && dropped >= 0.06
            ? "接收设备解码压力过高"
            : severe
              ? "网络出现明显波动"
              : "持续丢包或抖动",
      };
    }

    if (
      this.stableSamples >= STABLE_SAMPLES_TO_UPGRADE &&
      this.level > 0 &&
      now - this.lastChangeAt >= UPGRADE_COOLDOWN_MS
    ) {
      this.level -= 1;
      this.lastChangeAt = now;
      this.resetSamples();
      return {
        changed: true,
        direction: "up",
        requestedHeight: this.requestedHeight,
        reason: "网络已经持续稳定",
      };
    }

    return {
      changed: false,
      requestedHeight: this.requestedHeight,
    };
  }
}
