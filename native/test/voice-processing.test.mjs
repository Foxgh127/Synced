import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  modulePromise ??= build({
    entryPoints: [path.resolve("src/voice-processing.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  }).then(({ outputFiles }) =>
    import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
    ),
  );
  return modulePromise;
}

test("custom voice processing disables stacked browser gain and suppression", async () => {
  const { buildVoiceCaptureConstraints } = await loadModule();
  const constraints = buildVoiceCaptureConstraints(true);

  assert.equal(constraints.echoCancellation, true);
  assert.equal(constraints.autoGainControl, false);
  assert.equal(constraints.googAutoGainControl, false);
  assert.equal(constraints.googAutoGainControl2, false);
  assert.equal(constraints.noiseSuppression, false);
  assert.equal(constraints.googNoiseSuppression, false);
  assert.equal(constraints.voiceIsolation, false);
  assert.equal(constraints.googHighpassFilter, false);
});

test("browser fallback keeps AEC and noise suppression without re-enabling AGC", async () => {
  const { buildVoiceCaptureConstraints } = await loadModule();
  const constraints = buildVoiceCaptureConstraints(false);

  assert.equal(constraints.echoCancellation, true);
  assert.equal(constraints.noiseSuppression, true);
  assert.equal(constraints.voiceIsolation, true);
  assert.equal(constraints.autoGainControl, false);
  assert.equal(constraints.googAutoGainControl2, false);
});

test("natural mode can preserve timbre while retaining AEC and fixed headroom", async () => {
  const { buildVoiceCaptureConstraints } = await loadModule();
  const constraints = buildVoiceCaptureConstraints(false, false);

  assert.equal(constraints.echoCancellation, true);
  assert.equal(constraints.noiseSuppression, false);
  assert.equal(constraints.googNoiseSuppression, false);
  assert.equal(constraints.voiceIsolation, false);
  assert.equal(constraints.autoGainControl, false);
});

test("noise presets are ordered and use three distinct processing algorithms", async () => {
  const {
    VOICE_CAPTURE_MODE_PROFILES,
    normalizeVoiceProcessingMode,
    voiceCaptureProfileForMode,
  } = await loadModule();

  assert.equal(normalizeVoiceProcessingMode("balanced"), "clear");
  assert.equal(normalizeVoiceProcessingMode("clear"), "clear");
  assert.equal(normalizeVoiceProcessingMode("strong"), "strong");
  assert.equal(normalizeVoiceProcessingMode("unknown"), "clear");
  assert.deepEqual(
    Object.keys(VOICE_CAPTURE_MODE_PROFILES),
    ["natural", "clear", "strong"],
  );

  const natural = voiceCaptureProfileForMode("natural");
  const clear = voiceCaptureProfileForMode("clear");
  const strong = voiceCaptureProfileForMode("strong");
  assert.equal(natural.algorithm, "platform-natural");
  assert.equal(clear.algorithm, "platform-voice-enhance");
  assert.equal(strong.algorithm, "deepfilternet3-deep");
  assert.ok(clear.presence.gainDb > natural.presence.gainDb);
  assert.ok(strong.presence.gainDb > clear.presence.gainDb);
  assert.ok(clear.compressor.ratio > natural.compressor.ratio);
  assert.ok(strong.compressor.ratio > clear.compressor.ratio);
  assert.ok(strong.attenuationLimitDb >= 30);
});

test("shared limiter retains safe standards-compliant headroom", async () => {
  const { VOICE_CAPTURE_AUDIO_PROFILE } = await loadModule();

  assert.deepEqual(VOICE_CAPTURE_AUDIO_PROFILE.limiter, {
    thresholdDb: -3,
    kneeDb: 0,
    ratio: 20,
    attackSeconds: 0.001,
    releaseSeconds: 0.08,
  });
});

test("recent unmute uses a shorter no-media recovery window", async () => {
  const {
    VOICE_PEER_MEDIA_STALL_MS,
    VOICE_RECENT_UNMUTE_MEDIA_STALL_MS,
    voicePeerMediaStallTimeout,
  } = await loadModule();

  assert.equal(VOICE_PEER_MEDIA_STALL_MS, 12_000);
  assert.equal(VOICE_RECENT_UNMUTE_MEDIA_STALL_MS, 5_000);
  assert.equal(voicePeerMediaStallTimeout(false), 12_000);
  assert.equal(voicePeerMediaStallTimeout(true), 5_000);
});

test("boosted playback never drives the limiter above 1.5x gain", async () => {
  const {
    MAX_BOOSTED_PLAYBACK_GAIN,
    boostedPlaybackGain,
  } = await loadModule();

  assert.equal(MAX_BOOSTED_PLAYBACK_GAIN, 1.5);
  assert.equal(boostedPlaybackGain(0.8), 0.8);
  assert.equal(boostedPlaybackGain(1.25), 1.25);
  assert.equal(boostedPlaybackGain(2), 1.5);
});

test("system playback loopback inputs are rejected from the voice microphone path", async () => {
  const { isSystemAudioLoopbackInput } = await loadModule();

  for (const label of [
    "Stereo Mix (Realtek(R) Audio)",
    "立体声混音 (Realtek High Definition Audio)",
    "What U Hear",
    "Wave Out Mix",
    "System Loopback",
    "系统回环",
    "VB-Audio Virtual Cable Output",
    "VoiceMeeter Output",
    "OBS Virtual Audio",
    "Remote Audio",
  ]) {
    assert.equal(isSystemAudioLoopbackInput(label), true, label);
  }
  assert.equal(isSystemAudioLoopbackInput("Microphone Array (Intel Smart Sound)"), false);
  assert.equal(isSystemAudioLoopbackInput("麦克风 (USB Audio Device)"), false);
});
