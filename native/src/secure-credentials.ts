import { Capacitor, registerPlugin } from "@capacitor/core";

export interface SecureChannelOwnership {
  room: string;
  ownerToken: string;
}

interface SecureCredentialsPlugin {
  loadChannelOwnership(): Promise<
    | {
        found: true;
        room: string;
        ownerToken: string;
      }
    | { found: false }
  >;
  saveChannelOwnership(
    ownership: SecureChannelOwnership,
  ): Promise<{ saved: boolean }>;
}

const SecureCredentials =
  registerPlugin<SecureCredentialsPlugin>("SecureCredentials");

function isAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function loadSecureChannelOwnership():
  Promise<SecureChannelOwnership | undefined> {
  if (!isAndroid()) return undefined;
  try {
    const result = await SecureCredentials.loadChannelOwnership();
    if (
      result.found === true &&
      /^[23456789A-HJ-NP-Z]{8}$/u.test(result.room) &&
      /^[A-Za-z0-9_-]{43}$/u.test(result.ownerToken)
    ) {
      return {
        room: result.room,
        ownerToken: result.ownerToken,
      };
    }
  } catch {
    // A missing/invalidated device key rotates the credential below instead
    // of falling back to plaintext browser storage.
  }
  return undefined;
}

export async function saveSecureChannelOwnership(
  ownership: SecureChannelOwnership,
): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    return (
      await SecureCredentials.saveChannelOwnership(ownership)
    ).saved === true;
  } catch {
    return false;
  }
}
