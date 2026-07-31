type VoiceTrackConstraints = MediaTrackConstraints & {
  latency?: ConstrainDouble;
  voiceIsolation?: ConstrainBoolean;
  googEchoCancellation?: boolean;
  googEchoCancellation2?: boolean;
  googExperimentalEchoCancellation?: boolean;
  googAutoGainControl?: boolean;
  googAutoGainControl2?: boolean;
  googNoiseSuppression?: boolean;
  googHighpassFilter?: boolean;
};

export type VoiceProcessingMode = "natural" | "clear" | "strong";

const VOICE_LIMITER_PROFILE = {
  thresholdDb: -3,
  kneeDb: 0,
  // DynamicsCompressorNode.ratio has a standards-defined maximum of 20.
  // The additional 2 dB of headroom and Chromium's fixed look-ahead do the
  // transient protection instead of relying on an out-of-range value.
  ratio: 20,
  attackSeconds: 0.001,
  releaseSeconds: 0.08,
} as const;

/**
 * These are deliberately three different signal paths, not three labels for
 * one strength knob:
 * - natural: the platform AEC/NS followed by very gentle levelling;
 * - clear: platform voice isolation plus a restrained speech-presence lift;
 * - strong: DeepFilterNet3 with deeper attenuation and firmer dynamics.
 *
 * Keeping the profiles as data makes their ordering and mobile-cost trade-offs
 * reviewable and gives the capture graph one source of truth.
 */
export const VOICE_CAPTURE_MODE_PROFILES = {
  natural: {
    algorithm: "platform-natural",
    highPassFrequencyHz: 55,
    highPassQ: 0.707,
    inputGain: 0.9,
    presence: {
      frequencyHz: 2_400,
      gainDb: 0.4,
      q: 0.7,
    },
    compressor: {
      thresholdDb: -9,
      kneeDb: 10,
      ratio: 1.45,
      attackSeconds: 0.012,
      releaseSeconds: 0.18,
    },
    outputGain: 0.92,
  },
  clear: {
    algorithm: "platform-voice-enhance",
    highPassFrequencyHz: 75,
    highPassQ: 0.707,
    inputGain: 0.84,
    presence: {
      frequencyHz: 2_800,
      gainDb: 2.2,
      q: 0.9,
    },
    compressor: {
      thresholdDb: -16,
      kneeDb: 10,
      ratio: 2.4,
      attackSeconds: 0.006,
      releaseSeconds: 0.13,
    },
    outputGain: 0.9,
  },
  strong: {
    algorithm: "deepfilternet3-deep",
    attenuationLimitDb: 34,
    highPassFrequencyHz: 90,
    highPassQ: 0.707,
    inputGain: 0.76,
    presence: {
      frequencyHz: 3_000,
      gainDb: 2.8,
      q: 0.9,
    },
    compressor: {
      thresholdDb: -20,
      kneeDb: 8,
      ratio: 3.4,
      attackSeconds: 0.004,
      releaseSeconds: 0.16,
    },
    outputGain: 0.86,
  },
} as const;

export function normalizeVoiceProcessingMode(
  value: string | null | undefined,
): VoiceProcessingMode {
  if (value === "natural" || value === "strong" || value === "clear") {
    return value;
  }
  // 2.4 used "balanced" for what is now the clearer, more explicit preset.
  return "clear";
}

export function voiceCaptureProfileForMode(mode: VoiceProcessingMode) {
  return VOICE_CAPTURE_MODE_PROFILES[mode];
}

export const VOICE_CAPTURE_AUDIO_PROFILE = {
  limiter: VOICE_LIMITER_PROFILE,
} as const;

export const VOICE_PEER_MEDIA_STALL_MS = 12_000;
export const VOICE_RECENT_UNMUTE_MEDIA_STALL_MS = 5_000;
export const MAX_BOOSTED_PLAYBACK_GAIN = 1.5;

const SYSTEM_AUDIO_LOOPBACK_INPUT_PATTERN =
  /stereo mix|立体声混音|what u hear|wave out mix|loopback|回环|virtual audio|虚拟(?:音频|声卡)|vb-audio|voicemeeter|blackhole|soundflower|obs virtual|cable (?:input|output)|steam streaming|remote audio|远程音频/iu;

export function isSystemAudioLoopbackInput(label: string): boolean {
  return SYSTEM_AUDIO_LOOPBACK_INPUT_PATTERN.test(
    String(label || "").normalize("NFKC").trim(),
  );
}

export function voicePeerMediaStallTimeout(
  recentlyUnmuted: boolean,
): number {
  return recentlyUnmuted
    ? VOICE_RECENT_UNMUTE_MEDIA_STALL_MS
    : VOICE_PEER_MEDIA_STALL_MS;
}

export function boostedPlaybackGain(effectiveVolume: number): number {
  return Math.min(
    MAX_BOOSTED_PLAYBACK_GAIN,
    Math.max(0, effectiveVolume),
  );
}

export function buildVoiceCaptureConstraints(
  customNoiseSuppression: boolean,
  browserNoiseSuppression = true,
  browserVoiceIsolation = browserNoiseSuppression,
): VoiceTrackConstraints {
  const useBrowserNoiseSuppression =
    !customNoiseSuppression && browserNoiseSuppression;
  return {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
    sampleSize: { ideal: 16 },
    latency: { ideal: 0.02 },
    echoCancellation: true,
    noiseSuppression: useBrowserNoiseSuppression,
    // Hardware/Chromium AGC runs before Web Audio. Stacking it with a neural
    // suppressor and compressor clips close speech before our limiter can
    // recover it, and raises analogue hiss during pauses.
    autoGainControl: false,
    voiceIsolation:
      useBrowserNoiseSuppression && browserVoiceIsolation,
    googEchoCancellation: true,
    googEchoCancellation2: true,
    googExperimentalEchoCancellation: true,
    googAutoGainControl: false,
    googAutoGainControl2: false,
    googNoiseSuppression: useBrowserNoiseSuppression,
    // The capture graph owns the high-pass stage so it runs before neural
    // suppression and is applied exactly once.
    googHighpassFilter: false,
  };
}
