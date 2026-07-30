import protocolPolicy from "../server/protocol-policy.json";
import type { FrameRateOption, ResolutionKey } from "./config";

export const QUALITY_RESOLUTION_ORDER =
  protocolPolicy.quality.resolutionOrder as ResolutionKey[];
export const QUALITY_FRAME_RATE_ORDER =
  protocolPolicy.quality.frameRateOrder as FrameRateOption[];
export const QUALITY_RECOMMENDATION_BASELINE_FRAME_RATE =
  protocolPolicy.quality
    .recommendationBaselineFrameRate as FrameRateOption;
export const QUALITY_BITRATE_BPS =
  protocolPolicy.quality.bitrateBps as Record<
    ResolutionKey,
    Record<FrameRateOption, number>
  >;

export function qualityBitrateBps(
  resolution: ResolutionKey,
  frameRate: FrameRateOption,
): number {
  return QUALITY_BITRATE_BPS[resolution][frameRate];
}
