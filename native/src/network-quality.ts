import {
  FRAME_RATE_OPTIONS,
  isFrameRateOption,
  isResolutionKey,
  type FrameRateOption,
  type ResolutionKey,
} from "./config";
import { MAX_PARTICIPANTS_PER_ROOM } from "./probe-constants";

export type NetworkConfidence = "low" | "medium" | "high";
export type NetworkRouteMode =
  | "sfu-preferred"
  | "p2p-preferred"
  | "balanced"
  | "relay-preferred";
export type NetworkType = "ethernet" | "wifi" | "cellular" | "unknown";

export interface NetworkReport {
  probeVersion: 1 | 2;
  sampleId: string;
  uploadKbps: number;
  downloadKbps: number;
  signalRttMs: number;
  jitterMs?: number;
  networkType: NetworkType;
  metered: boolean;
  measuredAt: number;
  directCandidateGatherable?: boolean;
  turnCandidateGatherable?: boolean;
}

export interface NetworkAdvice {
  revision: number;
  participantCount: number;
  measuredCount: number;
  confidence: NetworkConfidence;
  perViewerBudgetBps: number;
  recommendedResolution: ResolutionKey;
  maxFrameRateByResolution: Record<ResolutionKey, FrameRateOption>;
  routeMode: NetworkRouteMode;
  reason: string;
  publisherAdvice?: {
    participantId?: string;
    budgetBps: number;
    fanoutCount: number;
    sfuPublisherActive: boolean;
  };
  generatedAt?: number;
  validUntil?: number;
}

const FALLBACK_FRAME_RATE_BY_RESOLUTION: Record<
  ResolutionKey,
  FrameRateOption
> = {
  original: 30,
  ultra: 30,
  high: 30,
  standard: 30,
  smooth: 30,
};

export function fallbackNetworkAdvice(
  participantCount = 1,
): NetworkAdvice {
  return {
    revision: 0,
    participantCount: Math.max(1, Math.round(participantCount)),
    measuredCount: 0,
    confidence: "low",
    perViewerBudgetBps: 10_000_000,
    recommendedResolution: "high",
    maxFrameRateByResolution: {
      ...FALLBACK_FRAME_RATE_BY_RESOLUTION,
    },
    routeMode: "balanced",
    reason: "正在汇总房间网络，先以稳定的 1080p 为默认值",
  };
}

function finiteInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

export function sanitizeNetworkAdvice(
  value: unknown,
  previousRevision = -1,
): NetworkAdvice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const revision = finiteInteger(raw.revision, 0, Number.MAX_SAFE_INTEGER);
  const participantCount = finiteInteger(
    raw.participantCount,
    1,
    MAX_PARTICIPANTS_PER_ROOM,
  );
  const measuredCount = finiteInteger(
    raw.measuredCount,
    0,
    MAX_PARTICIPANTS_PER_ROOM,
  );
  const perViewerBudgetBps = finiteInteger(
    raw.perViewerBudgetBps,
    0,
    2_000_000_000,
  );
  const generatedAt =
    raw.generatedAt === undefined
      ? undefined
      : finiteInteger(raw.generatedAt, 0, Number.MAX_SAFE_INTEGER);
  const validUntil =
    raw.validUntil === undefined
      ? undefined
      : finiteInteger(raw.validUntil, 0, Number.MAX_SAFE_INTEGER);
  if (
    revision === undefined ||
    revision <= previousRevision ||
    participantCount === undefined ||
    measuredCount === undefined ||
    perViewerBudgetBps === undefined ||
    (raw.generatedAt !== undefined && generatedAt === undefined) ||
    (raw.validUntil !== undefined &&
      (validUntil === undefined || validUntil <= Date.now())) ||
    !isResolutionKey(String(raw.recommendedResolution || ""))
  ) {
    return undefined;
  }
  const confidence =
    raw.confidence === "high" || raw.confidence === "medium"
      ? raw.confidence
      : raw.confidence === "low"
        ? "low"
        : undefined;
  const routeMode =
    raw.routeMode === "sfu-preferred" ||
    raw.routeMode === "p2p-preferred" ||
    raw.routeMode === "relay-preferred" ||
    raw.routeMode === "balanced"
      ? raw.routeMode
      : undefined;
  if (!confidence || !routeMode) return undefined;
  const rawFrameRates =
    raw.maxFrameRateByResolution &&
    typeof raw.maxFrameRateByResolution === "object"
      ? (raw.maxFrameRateByResolution as Record<string, unknown>)
      : {};
  const frameRates = {
    ...FALLBACK_FRAME_RATE_BY_RESOLUTION,
  };
  for (const resolution of Object.keys(
    frameRates,
  ) as ResolutionKey[]) {
    const option = Number(rawFrameRates[resolution]);
    if (isFrameRateOption(option)) {
      frameRates[resolution] = option;
    }
  }
  const rawPublisherAdvice =
    raw.publisherAdvice &&
    typeof raw.publisherAdvice === "object" &&
    !Array.isArray(raw.publisherAdvice)
      ? (raw.publisherAdvice as Record<string, unknown>)
      : undefined;
  const publisherBudgetBps = rawPublisherAdvice
    ? finiteInteger(
        rawPublisherAdvice.budgetBps,
        0,
        2_000_000_000,
      )
    : undefined;
  const publisherFanoutCount = rawPublisherAdvice
    ? finiteInteger(
        rawPublisherAdvice.fanoutCount,
        1,
        MAX_PARTICIPANTS_PER_ROOM,
      )
    : undefined;
  return {
    revision,
    participantCount,
    measuredCount,
    confidence,
    perViewerBudgetBps,
    recommendedResolution: raw.recommendedResolution as ResolutionKey,
    maxFrameRateByResolution: frameRates,
    routeMode,
    reason: String(raw.reason || "已根据房间网络更新建议").slice(0, 160),
    ...(publisherBudgetBps === undefined ||
    publisherFanoutCount === undefined
      ? {}
      : {
          publisherAdvice: {
            ...(typeof rawPublisherAdvice?.participantId === "string"
              ? {
                  participantId: rawPublisherAdvice.participantId.slice(
                    0,
                    64,
                  ),
                }
              : {}),
            budgetBps: publisherBudgetBps,
            fanoutCount: publisherFanoutCount,
            sfuPublisherActive:
              rawPublisherAdvice?.sfuPublisherActive === true,
          },
        }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...(validUntil === undefined ? {} : { validUntil }),
  };
}

export function frameRateForResolution(
  resolution: ResolutionKey,
  advice: NetworkAdvice | undefined,
): FrameRateOption {
  const requested =
    advice?.maxFrameRateByResolution[resolution] ??
    FALLBACK_FRAME_RATE_BY_RESOLUTION[resolution];
  if (isFrameRateOption(requested)) return requested;
  return FRAME_RATE_OPTIONS[0];
}

export function selectResolutionAndFrameRate(input: {
  resolution: ResolutionKey;
  resolutionLockedByUser?: boolean;
  currentFrameRate: FrameRateOption;
  frameRateLockedByUser: boolean;
  advice?: NetworkAdvice;
}): {
  resolution: ResolutionKey;
  frameRate: FrameRateOption;
} {
  return {
    resolution:
      !input.resolutionLockedByUser &&
      input.advice &&
      input.advice.confidence !== "low"
        ? input.advice.recommendedResolution
        : input.resolution,
    frameRate: input.frameRateLockedByUser
      ? input.currentFrameRate
      : frameRateForResolution(
          !input.resolutionLockedByUser &&
            input.advice &&
            input.advice.confidence !== "low"
            ? input.advice.recommendedResolution
            : input.resolution,
          input.advice,
        ),
  };
}

export function formatNetworkRate(kbps: number | undefined): string {
  if (!Number.isFinite(kbps) || Number(kbps) <= 0) return "待检测";
  const mbps = Number(kbps) / 1_000;
  return `${mbps >= 100 ? Math.round(mbps) : mbps.toFixed(1)} Mbps`;
}

export function networkConfidenceLabel(
  confidence: NetworkConfidence,
): string {
  return confidence === "high"
    ? "高置信度"
    : confidence === "medium"
      ? "中等置信度"
      : "检测中";
}

export function networkRouteLabel(mode: NetworkRouteMode): string {
  return mode === "sfu-preferred"
    ? "服务器 SFU 优先 · P2P 故障兜底"
    : mode === "p2p-preferred"
      ? "优先直连 · 云端自动兜底"
      : mode === "relay-preferred"
        ? "复杂网络 · 云端中转优先准备"
        : "智能线路 · 按真实 ICE 结果选择";
}
