import { Capacitor, registerPlugin } from "@capacitor/core";

export interface PlaybackControlState {
  brightness: number;
  volume: number;
}

interface PlaybackControlsPlugin {
  getState(): Promise<PlaybackControlState>;
  setBrightness(options: { value: number }): Promise<PlaybackControlState>;
  setVolume(options: { value: number }): Promise<PlaybackControlState>;
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

export async function getPlaybackControlState(): Promise<PlaybackControlState> {
  if (!hasNativePlaybackControls()) {
    return { brightness: 0.5, volume: 1 };
  }
  return PlaybackControls.getState();
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

export async function setPlaybackVolume(
  value: number,
): Promise<PlaybackControlState> {
  const normalized = Math.max(0, Math.min(1, value));
  if (!hasNativePlaybackControls()) {
    return { brightness: 0.5, volume: normalized };
  }
  return PlaybackControls.setVolume({ value: normalized });
}

export async function setNativePlaybackActive(
  active: boolean,
  title?: string,
): Promise<void> {
  if (!hasNativePlaybackControls()) return;
  await PlaybackControls.setPlaybackActive({ active, title });
}
