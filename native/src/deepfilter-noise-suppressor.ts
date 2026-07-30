import { DeepFilterNet3Core } from "deepfilternet3-noise-filter";

const DEEPFILTER_SAMPLE_RATE = 48_000;
const DEFAULT_ATTENUATION_LIMIT_DB = 24;

export interface DeepFilterNoiseProcessor {
  readonly node: AudioWorkletNode;
  readonly name: "DeepFilterNet3";
  bypass(): void;
  dispose(): void;
}

function modelBaseUrl(): string {
  if (window.roomDesktop) {
    return "yiqikan-resource://app/models/deepfilternet3";
  }
  return new URL("models/deepfilternet3", document.baseURI).href.replace(
    /\/$/,
    "",
  );
}

/**
 * Creates the full-band DeepFilterNet3 processor used by the strong preset.
 *
 * The model and WASM runtime are bundled with the app. This intentionally
 * avoids a runtime dependency on a foreign CDN, which is unreliable for
 * viewers in mainland China.
 */
export async function createDeepFilterNoiseProcessor(
  context: AudioContext,
  attenuationLimitDb = DEFAULT_ATTENUATION_LIMIT_DB,
): Promise<DeepFilterNoiseProcessor> {
  if (Math.round(context.sampleRate) !== DEEPFILTER_SAMPLE_RATE) {
    throw new Error(
      `DeepFilterNet3 requires ${DEEPFILTER_SAMPLE_RATE} Hz audio; received ${context.sampleRate} Hz`,
    );
  }
  if (!context.audioWorklet || typeof AudioWorkletNode === "undefined") {
    throw new Error("当前设备不支持 AudioWorklet");
  }

  const processor = new DeepFilterNet3Core({
    sampleRate: DEEPFILTER_SAMPLE_RATE,
    noiseReductionLevel: Math.min(
      48,
      Math.max(6, attenuationLimitDb),
    ),
    assetConfig: {
      cdnUrl: modelBaseUrl(),
    },
  });
  try {
    await processor.initialize();
    const node = await processor.createAudioWorkletNode(context);
    return {
      node,
      name: "DeepFilterNet3",
      bypass() {
        // AudioWorkletNode emits `processorerror` when its processor throws and
        // is then permanently silent. VoiceMesh also keeps a parallel dry
        // path, but ask a still-responsive processor to bypass its model so a
        // recoverable model fault does not discard microphone samples.
        processor.setNoiseSuppressionEnabled(false);
      },
      dispose() {
        node.disconnect();
        processor.destroy();
      },
    };
  } catch (error) {
    processor.destroy();
    throw error;
  }
}
