import { Capacitor, registerPlugin } from "@capacitor/core";

export interface PlaybackControlState {
  brightness: number;
  volume: number;
}

interface PlaybackControlsPlugin {
  getState(): Promise<PlaybackControlState>;
  setBrightness(options: { value: number }): Promise<PlaybackControlState>;
  setPlaybackActive(options: {
    active: boolean;
    title?: string;
  }): Promise<{ active: boolean }>;
}

const PlaybackControls =
  registerPlugin<PlaybackControlsPlugin>("PlaybackControls");

export function hasNativePlaybackControls(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function getPlaybackControlState(
  appVolume = 1,
): Promise<PlaybackControlState> {
  const volume = Math.max(0, Math.min(1, appVolume));
  if (!hasNativePlaybackControls()) {
    return { brightness: 0.5, volume };
  }
  const state = await PlaybackControls.getState();
  return { ...state, volume };
}

export async function setPlaybackBrightness(
  value: number,
): Promise<PlaybackControlState> {
  const normalized = Math.max(0.02, Math.min(1, value));
  if (!hasNativePlaybackControls()) {
    return { brightness: normalized, volume: 1 };
  }
  return PlaybackControls.setBrightness({ value: normalized });
}

export async function setNativePlaybackActive(
  active: boolean,
  title?: string,
): Promise<void> {
  if (!hasNativePlaybackControls()) return;
  await PlaybackControls.setPlaybackActive({ active, title });
}
