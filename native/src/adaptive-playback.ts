export type AdaptiveDirection = "down" | "up";
export type ScreenContentMode = "detail" | "motion" | "balanced";
export type AdaptivePressure =
  | "healthy"
  | "network-limited"
  | "encoder-limited"
  | "decoder-limited"
  | "render-limited"
  | "transport-stalled"
  | "unknown";

export interface AdaptiveNetworkSample {
  connectionState?: RTCPeerConnectionState;
  packetLossRatio?: number;
  jitter?: number;
  freezeDurationDelta?: number;
  framesDroppedRatio?: number;
  averageDecodeTime?: number;
  frameRate?: number;
  availableBandwidthBps?: number;
  targetBitrateBps?: number;
  currentRoundTripTime?: number;
  baselineRoundTripTime?: number;
  bufferDebtSeconds?: number;
  transportProgressAgeMs?: number;
  renderFrameDuration?: number;
  qualityLimitationReason?: string;
}

export interface AdaptiveQualityDecision {
  changed: boolean;
  direction?: AdaptiveDirection;
  requestedHeight?: number;
  requestedFrameRate?: number;
  pressure: AdaptivePressure;
  reason?: string;
}

export interface AdaptivePlaybackOptions {
  contentMode?: ScreenContentMode;
  sourceFrameRate?: number;
  minimumUpgradeStableMs?: number;
  maximumUpgradeStableMs?: number;
}

interface QualityRung {
  height?: number;
  frameRate: number;
  targetBitrateBps: number;
}

const MIN_UPGRADE_STABLE_MS = 20_000;
const MAX_UPGRADE_STABLE_MS = 60_000;
const POST_UPGRADE_HOLD_MS = 20_000;
const NORMAL_DEGRADE_SCORE = 3;
const DEGRADE_COOLDOWN_MS = 1_500;
const UPGRADE_BANDWIDTH_HEADROOM = 1.5;

function monotonicNow(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : 0;
}

function boundedFrameRate(value: number | undefined, fallback = 30): number {
  return Math.max(1, Math.min(120, Math.round(value || fallback)));
}

function targetBitrate(height: number, frameRate: number): number {
  const pixelsAt30 = Math.max(1, height) ** 2 * (16 / 9) * 30;
  const reference =
    height >= 1_440
      ? 13_500_000
      : height >= 1_080
        ? 7_000_000
        : height >= 720
          ? 3_200_000
          : 1_500_000;
  const referencePixels = Math.max(1, height) ** 2 * (16 / 9) * 30;
  return Math.round(
    reference *
      Math.max(0.55, Math.min(2, pixelsAt30 / referencePixels)) *
      Math.max(0.5, Math.min(2, frameRate / 30)),
  );
}

function createRung(
  sourceHeight: number,
  height: number | undefined,
  frameRate: number,
): QualityRung {
  const effectiveHeight = height || sourceHeight;
  return {
    height,
    frameRate,
    targetBitrateBps: targetBitrate(effectiveHeight, frameRate),
  };
}

function buildQualityLadder(
  sourceHeight: number,
  ceilingHeight: number,
  sourceFrameRate: number,
  contentMode: ScreenContentMode,
): QualityRung[] {
  const source = Math.max(1, Math.round(sourceHeight));
  const ceiling =
    ceilingHeight > 0 ? Math.min(source, Math.round(ceilingHeight)) : source;
  const originalHeight = ceiling < source ? ceiling : undefined;
  const sourceRate = boundedFrameRate(sourceFrameRate);
  const candidates: Array<[number | undefined, number]> =
    contentMode === "detail"
      ? [
          [originalHeight, Math.min(sourceRate, 30)],
          [originalHeight, Math.min(sourceRate, 20)],
          [originalHeight, Math.min(sourceRate, 15)],
          [1_080, Math.min(sourceRate, 30)],
          [1_080, Math.min(sourceRate, 20)],
          [720, Math.min(sourceRate, 30)],
          [480, Math.min(sourceRate, 20)],
        ]
      : contentMode === "motion"
        ? [
            [originalHeight, Math.min(sourceRate, 30)],
            [1_080, Math.min(sourceRate, 30)],
            [720, Math.min(sourceRate, 30)],
            [720, Math.min(sourceRate, 24)],
            [480, Math.min(sourceRate, 24)],
          ]
        : [
            [originalHeight, Math.min(sourceRate, 30)],
            [1_080, Math.min(sourceRate, 30)],
            [720, Math.min(sourceRate, 30)],
            [480, Math.min(sourceRate, 24)],
          ];
  const ladder: QualityRung[] = [];
  for (const [candidateHeight, candidateFrameRate] of candidates) {
    const effectiveHeight = candidateHeight || ceiling;
    if (effectiveHeight > ceiling || effectiveHeight > source) continue;
    const height =
      candidateHeight === undefined || effectiveHeight === source
        ? undefined
        : effectiveHeight;
    if (
      ladder.some(
        (rung) =>
          (rung.height || source) === (height || source) &&
          rung.frameRate === candidateFrameRate,
      )
    ) {
      continue;
    }
    ladder.push(
      createRung(source, height, boundedFrameRate(candidateFrameRate)),
    );
  }
  return ladder.length
    ? ladder
    : [createRung(source, originalHeight, Math.min(sourceRate, 30))];
}

function classifyPressure(sample: AdaptiveNetworkSample): {
  pressure: AdaptivePressure;
  poor: boolean;
  severe: boolean;
  stable: boolean;
  reason?: string;
} {
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
  const renderLoad =
    sample.renderFrameDuration !== undefined &&
    sample.frameRate !== undefined &&
    sample.frameRate > 0
      ? sample.renderFrameDuration * sample.frameRate
      : undefined;
  const transportStalled =
    sample.connectionState === "failed" ||
    sample.connectionState === "disconnected" ||
    (sample.transportProgressAgeMs !== undefined &&
      sample.transportProgressAgeMs >= 3_000);
  const decoderLimited =
    (dropped !== undefined && dropped >= 0.06) ||
    (decodeLoad !== undefined && decodeLoad >= 0.65);
  const renderLimited = renderLoad !== undefined && renderLoad >= 0.72;
  const encoderLimited = ["cpu", "encoder"].includes(
    String(sample.qualityLimitationReason || "").toLowerCase(),
  );
  const bandwidthInsufficient =
    sample.availableBandwidthBps !== undefined &&
    sample.targetBitrateBps !== undefined &&
    sample.availableBandwidthBps < sample.targetBitrateBps * 1.08;
  const networkLimited =
    bandwidthInsufficient ||
    (loss !== undefined && loss >= 0.035) ||
    (jitter !== undefined && jitter >= 0.08) ||
    (freeze !== undefined && freeze >= 0.18) ||
    (sample.bufferDebtSeconds !== undefined &&
      sample.bufferDebtSeconds >= 0.75);
  const severe =
    sample.connectionState === "failed" ||
    (sample.transportProgressAgeMs !== undefined &&
      sample.transportProgressAgeMs >= 6_000) ||
    (loss !== undefined && loss >= 0.12) ||
    (jitter !== undefined && jitter >= 0.18) ||
    (freeze !== undefined && freeze >= 0.5) ||
    (dropped !== undefined && dropped >= 0.18) ||
    (decodeLoad !== undefined && decodeLoad >= 0.9) ||
    (renderLoad !== undefined && renderLoad >= 0.95) ||
    (sample.bufferDebtSeconds !== undefined &&
      sample.bufferDebtSeconds >= 2);
  const poor =
    transportStalled ||
    decoderLimited ||
    renderLimited ||
    encoderLimited ||
    networkLimited;
  const stable =
    sample.connectionState === "connected" &&
    (loss === undefined || loss <= 0.01) &&
    (jitter === undefined || jitter <= 0.04) &&
    (freeze === undefined || freeze <= 0.04) &&
    (dropped === undefined || dropped <= 0.015) &&
    (decodeLoad === undefined || decodeLoad <= 0.45) &&
    (renderLoad === undefined || renderLoad <= 0.5) &&
    (sample.bufferDebtSeconds === undefined ||
      sample.bufferDebtSeconds <= 0.1) &&
    !encoderLimited;

  if (transportStalled) {
    return {
      pressure: "transport-stalled",
      poor,
      severe,
      stable,
      reason: "媒体传输已停止推进",
    };
  }
  if (decoderLimited) {
    return {
      pressure: "decoder-limited",
      poor,
      severe,
      stable,
      reason: "接收设备解码压力过高",
    };
  }
  if (renderLimited) {
    return {
      pressure: "render-limited",
      poor,
      severe,
      stable,
      reason: "接收设备渲染压力过高",
    };
  }
  if (encoderLimited) {
    return {
      pressure: "encoder-limited",
      poor,
      severe,
      stable,
      reason: "放映端编码器持续过载",
    };
  }
  if (networkLimited) {
    return {
      pressure: "network-limited",
      poor,
      severe,
      stable,
      reason: severe ? "网络出现明显波动" : "持续丢包、抖动或带宽不足",
    };
  }
  return {
    pressure: stable ? "healthy" : "unknown",
    poor,
    severe,
    stable,
  };
}

/**
 * Per-viewer adaptive controller. Downgrades happen within 1–3 samples,
 * upgrades require 20–60 seconds of continuous stability, enough bandwidth
 * headroom, and an RTT close to the path baseline.
 */
export class AdaptivePlaybackController {
  private ladder: QualityRung[] = [
    { height: undefined, frameRate: 30, targetBitrateBps: 7_000_000 },
  ];
  private sourceHeight = 1;
  private level = 0;
  private poorScore = 0;
  private stableSince: number | undefined;
  private lastChangeAt = Number.NEGATIVE_INFINITY;
  private lastUpgradeAt = Number.NEGATIVE_INFINITY;
  private upgradeFailures = 0;
  private baselineRtt: number | undefined;
  private minimumUpgradeStableMs = MIN_UPGRADE_STABLE_MS;
  private maximumUpgradeStableMs = MAX_UPGRADE_STABLE_MS;
  private mode: ScreenContentMode = "balanced";
  private pressure: AdaptivePressure = "unknown";

  configure(
    sourceHeight: number,
    ceilingHeight = 0,
    preserveCurrent = false,
    options: AdaptivePlaybackOptions = {},
  ): void {
    const previousHeight = this.requestedHeight;
    const previousFrameRate = this.requestedFrameRate;
    this.sourceHeight = Math.max(1, Math.round(sourceHeight));
    this.mode = options.contentMode || this.mode;
    this.minimumUpgradeStableMs = Math.max(
      20_000,
      Number(options.minimumUpgradeStableMs) || MIN_UPGRADE_STABLE_MS,
    );
    this.maximumUpgradeStableMs = Math.max(
      this.minimumUpgradeStableMs,
      Math.min(
        120_000,
        Number(options.maximumUpgradeStableMs) || MAX_UPGRADE_STABLE_MS,
      ),
    );
    this.ladder = buildQualityLadder(
      this.sourceHeight,
      ceilingHeight,
      boundedFrameRate(options.sourceFrameRate),
      this.mode,
    );
    this.level = 0;
    if (preserveCurrent) {
      const exact = this.ladder.findIndex(
        (rung) =>
          rung.height === previousHeight &&
          rung.frameRate === previousFrameRate,
      );
      if (exact >= 0) {
        this.level = exact;
      } else if (previousHeight !== undefined) {
        const compatible = this.ladder.findIndex(
          (rung) =>
            (rung.height || this.sourceHeight) <= previousHeight,
        );
        this.level = compatible >= 0 ? compatible : this.ladder.length - 1;
      }
    }
    if (!preserveCurrent) {
      this.lastChangeAt = Number.NEGATIVE_INFINITY;
      this.lastUpgradeAt = Number.NEGATIVE_INFINITY;
      this.upgradeFailures = 0;
      this.baselineRtt = undefined;
    }
    this.resetSamples();
  }

  get requestedHeight(): number | undefined {
    return this.ladder[this.level]?.height;
  }

  get requestedFrameRate(): number | undefined {
    return this.ladder[this.level]?.frameRate;
  }

  get targetBitrateBps(): number {
    return this.ladder[this.level]?.targetBitrateBps || 0;
  }

  get contentMode(): ScreenContentMode {
    return this.mode;
  }

  get currentPressure(): AdaptivePressure {
    return this.pressure;
  }

  get reduced(): boolean {
    return this.level > 0;
  }

  get levelCount(): number {
    return this.ladder.length;
  }

  resetSamples(): void {
    this.poorScore = 0;
    this.stableSince = undefined;
  }

  forceDegrade(
    reason = "首帧持续未到达",
    now = monotonicNow(),
  ): AdaptiveQualityDecision {
    if (this.level >= this.ladder.length - 1) {
      return this.decision(false);
    }
    this.level += 1;
    this.lastChangeAt = now;
    this.pressure = "transport-stalled";
    this.resetSamples();
    return this.decision(true, "down", reason);
  }

  observe(
    sample: AdaptiveNetworkSample,
    now = monotonicNow(),
  ): AdaptiveQualityDecision {
    const classification = classifyPressure({
      ...sample,
      targetBitrateBps:
        sample.targetBitrateBps ?? this.targetBitrateBps,
    });
    this.pressure = classification.pressure;
    const sampleRtt = sample.currentRoundTripTime;
    if (
      sampleRtt !== undefined &&
      Number.isFinite(sampleRtt) &&
      sampleRtt >= 0 &&
      sample.connectionState === "connected"
    ) {
      this.baselineRtt =
        this.baselineRtt === undefined
          ? sampleRtt
          : Math.min(
              this.baselineRtt * 1.01,
              this.baselineRtt * 0.92 + sampleRtt * 0.08,
            );
    }

    if (classification.poor) {
      this.poorScore += classification.severe ? NORMAL_DEGRADE_SCORE : 1;
      this.stableSince = undefined;
    } else if (classification.stable) {
      this.poorScore = Math.max(0, this.poorScore - 1);
      this.stableSince ??= now;
    } else {
      this.poorScore = Math.max(0, this.poorScore - 0.5);
      this.stableSince = undefined;
    }

    const postUpgradeHold =
      now - this.lastUpgradeAt < POST_UPGRADE_HOLD_MS;
    if (
      this.poorScore >= NORMAL_DEGRADE_SCORE &&
      this.level < this.ladder.length - 1 &&
      now - this.lastChangeAt >= DEGRADE_COOLDOWN_MS &&
      (!postUpgradeHold || classification.severe)
    ) {
      if (postUpgradeHold) {
        this.upgradeFailures = Math.min(3, this.upgradeFailures + 1);
      }
      this.level += 1;
      this.lastChangeAt = now;
      this.resetSamples();
      return this.decision(
        true,
        "down",
        classification.reason || "持续媒体压力",
      );
    }

    const upgradeRung =
      this.level > 0 ? this.ladder[this.level - 1] : undefined;
    const requiredStableMs = Math.min(
      this.maximumUpgradeStableMs,
      this.minimumUpgradeStableMs * 2 ** this.upgradeFailures,
    );
    const stableMs =
      this.stableSince === undefined ? 0 : now - this.stableSince;
    const bandwidth = sample.availableBandwidthBps;
    const bandwidthReady =
      bandwidth === undefined
        ? stableMs >= this.maximumUpgradeStableMs
        : Boolean(
            upgradeRung &&
              bandwidth >=
                upgradeRung.targetBitrateBps * UPGRADE_BANDWIDTH_HEADROOM,
          );
    const baseline =
      sample.baselineRoundTripTime ?? this.baselineRtt;
    const rttReady =
      sampleRtt === undefined ||
      baseline === undefined ||
      sampleRtt <= Math.max(baseline * 1.35, baseline + 0.025);
    if (
      upgradeRung &&
      stableMs >= requiredStableMs &&
      bandwidthReady &&
      rttReady &&
      now - this.lastChangeAt >= POST_UPGRADE_HOLD_MS
    ) {
      this.level -= 1;
      this.lastChangeAt = now;
      this.lastUpgradeAt = now;
      this.resetSamples();
      if (this.level === 0) this.upgradeFailures = 0;
      return this.decision(true, "up", "网络已经持续稳定且带宽余量充足");
    }

    return this.decision(false);
  }

  private decision(
    changed: boolean,
    direction?: AdaptiveDirection,
    reason?: string,
  ): AdaptiveQualityDecision {
    return {
      changed,
      direction,
      requestedHeight: this.requestedHeight,
      requestedFrameRate: this.requestedFrameRate,
      pressure: this.pressure,
      reason,
    };
  }
}
