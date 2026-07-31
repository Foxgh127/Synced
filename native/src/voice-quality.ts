import protocolPolicy from "../server/protocol-policy.json";

const voicePolicy = protocolPolicy.voice;

/**
 * Full-band Opus remains intelligible at substantially lower rates than the
 * previous 224–320 kbps profile. Speech is mono; the higher music tier is only
 * used while accompaniment is actually active. This keeps TURN and mobile
 * uplink cost bounded as rooms grow.
 */
export function voiceBitrateForPeerCount(
  peerCount: number,
  music = false,
): number {
  if (music) {
    if (peerCount <= 1) return voicePolicy.musicBitrateBps.onePeer;
    if (peerCount === 2) return voicePolicy.musicBitrateBps.twoPeers;
    return voicePolicy.musicBitrateBps.manyPeers;
  }
  if (peerCount <= 1) return voicePolicy.speechBitrateBps.onePeer;
  if (peerCount === 2) return voicePolicy.speechBitrateBps.twoPeers;
  return voicePolicy.speechBitrateBps.manyPeers;
}

export const MIN_ADAPTIVE_VOICE_BITRATE =
  voicePolicy.minimumAdaptiveBitrateBps;
export const MAX_ADAPTIVE_VOICE_BITRATE =
  voicePolicy.maximumAdaptiveBitrateBps;
export const MAX_VOICE_MESH_PARTICIPANTS =
  voicePolicy.maxMeshParticipantsWithoutSfu;

export interface VoiceNetworkSample {
  availableOutgoingBitrate?: number;
  currentRoundTripTime?: number;
  packetLossRatio?: number;
}

function finite(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function clampVoiceBitrate(value: number): number {
  return Math.round(
    Math.max(
      MIN_ADAPTIVE_VOICE_BITRATE,
      Math.min(MAX_ADAPTIVE_VOICE_BITRATE, value),
    ),
  );
}

/**
 * Per-peer congestion fallback for the bounded full-band profiles above.
 *
 * Loss and a collapsed ICE bandwidth estimate reduce bitrate quickly, while
 * recovery requires several clean samples and climbs in 32 kbps steps. This
 * avoids the audible pumping caused by changing Opus parameters every health
 * tick.
 */
export class AdaptiveVoiceBitrateController {
  private bitrate: number;
  private poorSamples = 0;
  private stableSamples = 0;
  private lastChangeAt = Number.NEGATIVE_INFINITY;

  constructor(initialBitrate = 64_000) {
    this.bitrate = clampVoiceBitrate(initialBitrate);
  }

  get currentBitrate(): number {
    return this.bitrate;
  }

  reset(targetBitrate: number): number {
    this.bitrate = clampVoiceBitrate(targetBitrate);
    this.poorSamples = 0;
    this.stableSamples = 0;
    this.lastChangeAt = Number.NEGATIVE_INFINITY;
    return this.bitrate;
  }

  update(
    targetBitrate: number,
    sample: VoiceNetworkSample,
    nowMs = performance.now(),
  ): number {
    const target = clampVoiceBitrate(targetBitrate);
    this.bitrate = Math.min(this.bitrate, target);
    const available = finite(sample.availableOutgoingBitrate);
    const rtt = finite(sample.currentRoundTripTime);
    const loss = finite(sample.packetLossRatio);
    const severe =
      (loss !== undefined && loss >= 0.12) ||
      (rtt !== undefined && rtt >= 0.6) ||
      (available !== undefined && available < target * 1.05);
    const poor =
      severe ||
      (loss !== undefined && loss >= 0.045) ||
      (rtt !== undefined && rtt >= 0.32) ||
      (available !== undefined && available < target * 1.55);

    if (poor) {
      this.stableSamples = 0;
      this.poorSamples += severe ? 2 : 1;
      const changeCooldownMs = severe ? 1_500 : 4_000;
      if (
        this.poorSamples >= 2 &&
        nowMs - this.lastChangeAt >= changeCooldownMs
      ) {
        const bandwidthCeiling =
          available !== undefined ? available * 0.7 : this.bitrate;
        const reduction = severe
          ? this.bitrate * 0.72
          : this.bitrate * 0.84;
        const next = clampVoiceBitrate(
          Math.min(this.bitrate - 8_000, reduction, bandwidthCeiling),
        );
        if (next < this.bitrate) {
          this.bitrate = next;
          this.lastChangeAt = nowMs;
        }
        this.poorSamples = 0;
      }
      return this.bitrate;
    }

    this.poorSamples = 0;
    const stable =
      (loss === undefined || loss < 0.02) &&
      (rtt === undefined || rtt < 0.24) &&
      (available === undefined || available >= target * 1.8);
    this.stableSamples = stable ? this.stableSamples + 1 : 0;
    if (
      this.stableSamples >= 3 &&
      this.bitrate < target &&
      nowMs - this.lastChangeAt >= 8_000
    ) {
      this.bitrate = Math.min(target, this.bitrate + 8_000);
      this.lastChangeAt = nowMs;
      this.stableSamples = 0;
    }
    return this.bitrate;
  }
}
