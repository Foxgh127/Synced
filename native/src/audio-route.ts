import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";

export interface VoiceOutputDevice {
  id: string;
  label: string;
  kind: "speaker" | "earpiece" | "wired" | "bluetooth" | "usb" | "other";
}

interface AudioRouteResult {
  devices: VoiceOutputDevice[];
  selectedId: string;
}

interface AudioRoutePlugin {
  start(): Promise<AudioRouteResult>;
  listOutputs(): Promise<AudioRouteResult>;
  setOutput(options: { id: string }): Promise<AudioRouteResult>;
  requestBluetoothPermission(): Promise<void>;
  stop(): Promise<void>;
  addListener(
    eventName: "devicesChanged",
    listener: (result: AudioRouteResult) => void,
  ): Promise<PluginListenerHandle>;
}

const AudioRoute = registerPlugin<AudioRoutePlugin>("AudioRoute");

export function hasNativeAudioRoute(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function startNativeVoiceRoute(): Promise<AudioRouteResult | undefined> {
  if (!hasNativeAudioRoute()) return undefined;
  return AudioRoute.start();
}

export async function listNativeVoiceOutputs(): Promise<AudioRouteResult | undefined> {
  if (!hasNativeAudioRoute()) return undefined;
  return AudioRoute.listOutputs();
}

export async function setNativeVoiceOutput(
  id: string,
): Promise<AudioRouteResult | undefined> {
  if (!hasNativeAudioRoute()) return undefined;
  return AudioRoute.setOutput({ id });
}

export async function requestNativeVoiceBluetoothAccess(): Promise<void> {
  if (hasNativeAudioRoute()) {
    await AudioRoute.requestBluetoothPermission();
  }
}

export async function stopNativeVoiceRoute(): Promise<void> {
  if (hasNativeAudioRoute()) {
    await AudioRoute.stop();
  }
}

export async function addNativeVoiceDevicesListener(
  listener: () => void,
): Promise<PluginListenerHandle | undefined> {
  if (!hasNativeAudioRoute()) return undefined;
  return AudioRoute.addListener("devicesChanged", listener);
}
