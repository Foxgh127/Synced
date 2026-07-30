import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";

interface NetworkBridgePlugin {
  getLocalAddresses(): Promise<{ addresses: string[]; signature?: string }>;
  reportDiagnostic(options: {
    event: string;
    detail: string;
  }): Promise<void>;
  addListener(
    eventName: "networkChanged",
    listener: (event: NativeNetworkChange) => void,
  ): Promise<PluginListenerHandle>;
}

const NetworkBridge = registerPlugin<NetworkBridgePlugin>("NetworkBridge");
let lastNativeNetworkSignature = "";

export interface NativeNetworkChange {
  connected: boolean;
  signature?: string;
}

export function reportNativePlaybackDiagnostic(
  event: string,
  detail: Record<string, unknown>,
): void {
  if (
    !Capacitor.isNativePlatform() ||
    Capacitor.getPlatform() !== "android"
  ) {
    return;
  }
  let serialized = "{}";
  try {
    serialized = JSON.stringify(detail).slice(0, 2_400);
  } catch {
    serialized = '{"error":"diagnostic serialization failed"}';
  }
  void NetworkBridge.reportDiagnostic({
    event: String(event || "playback").slice(0, 80),
    detail: serialized,
  }).catch(() => undefined);
}

export async function getNativeLocalAddresses(): Promise<string[]> {
  if (
    !Capacitor.isNativePlatform() ||
    Capacitor.getPlatform() !== "android"
  ) {
    return [];
  }
  try {
    const result = await NetworkBridge.getLocalAddresses();
    return [...new Set(result.addresses || [])].filter((address) =>
      /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address),
    );
  } catch {
    return [];
  }
}

export async function listenForNativeNetworkChanges(
  listener: (event: NativeNetworkChange) => void,
): Promise<PluginListenerHandle | undefined> {
  if (
    !Capacitor.isNativePlatform() ||
    Capacitor.getPlatform() !== "android"
  ) {
    return undefined;
  }
  return NetworkBridge.addListener("networkChanged", (event) => {
    const signature = event.signature || "";
    if (signature && signature === lastNativeNetworkSignature) return;
    if (signature) lastNativeNetworkSignature = signature;
    listener({
      connected: Boolean(event.connected),
      signature: signature || undefined,
    });
  });
}
