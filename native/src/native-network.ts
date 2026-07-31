import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";

interface NetworkBridgePlugin {
  getLocalAddresses(): Promise<NativeNetworkPath>;
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

export interface NativeNetworkDescriptor {
  id: string;
  role: string;
  transport: string;
  interfaceName: string;
  vpn: boolean;
  validated: boolean;
  metered: boolean;
  addresses: string[];
}

export interface NativeNetworkAddress {
  address: string;
  family: "ipv4" | "ipv6";
  interfaceName: string;
  networkId: string;
  defaultRouted: boolean;
  physical: boolean;
  tunnel: boolean;
  private: boolean;
  privacySensitive: boolean;
  publishable: boolean;
  directHintEligible: boolean;
}

export interface NativeSocketSelectedPath {
  selection: "system-default" | "process-bound";
  processBound: boolean;
  observed: boolean;
  basis: "system-default-route" | "process-network-binding";
  network?: NativeNetworkDescriptor;
}

export interface NativeNetworkPath {
  addresses: string[];
  allAddresses?: NativeNetworkAddress[];
  physicalNetwork?: NativeNetworkDescriptor;
  defaultRoutedNetwork?: NativeNetworkDescriptor;
  vpnActive?: boolean;
  socketSelectedPath?: NativeSocketSelectedPath;
  signature?: string;
}

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
  const path = await getNativeNetworkPath();
  return path?.addresses || [];
}

function validDirectHint(address: string): boolean {
  const normalized = String(address || "").trim().toLowerCase();
  return (
    /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(normalized) ||
    /^[0-9a-f:]{2,45}$/u.test(normalized)
  );
}

function diagnosticNetworkSummary(
  network: NativeNetworkDescriptor | undefined,
): Omit<NativeNetworkDescriptor, "addresses"> & {
  addressCount: number;
  addressFamilies: Array<"ipv4" | "ipv6">;
} | undefined {
  if (!network) return undefined;
  const { addresses, ...summary } = network;
  return {
    ...summary,
    addressCount: addresses.length,
    addressFamilies: [
      ...new Set(
        addresses.map((address) =>
          address.includes(":") ? ("ipv6" as const) : ("ipv4" as const),
        ),
      ),
    ],
  };
}

export async function getNativeNetworkPath():
  Promise<NativeNetworkPath | undefined> {
  if (
    !Capacitor.isNativePlatform() ||
    Capacitor.getPlatform() !== "android"
  ) {
    return undefined;
  }
  try {
    const result = await NetworkBridge.getLocalAddresses();
    const path = {
      ...result,
      addresses: [...new Set(result.addresses || [])].filter(
        validDirectHint,
      ),
      allAddresses: (result.allAddresses || []).filter(
        (entry) => validDirectHint(entry.address),
      ),
    };
    reportNativePlaybackDiagnostic("native-network-path", {
      physicalNetwork: diagnosticNetworkSummary(path.physicalNetwork),
      defaultRoutedNetwork: diagnosticNetworkSummary(
        path.defaultRoutedNetwork,
      ),
      vpnActive: path.vpnActive === true,
      socketSelectedPath: path.socketSelectedPath
        ? {
            ...path.socketSelectedPath,
            network: diagnosticNetworkSummary(
              path.socketSelectedPath.network,
            ),
          }
        : undefined,
      directAddressFamilies: [
        ...new Set(path.allAddresses.map((entry) => entry.family)),
      ],
      tunnelDirectHints: path.allAddresses.filter(
        (entry) => entry.tunnel && entry.publishable,
      ).length,
    });
    return path;
  } catch {
    return undefined;
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
