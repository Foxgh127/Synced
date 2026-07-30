import { Capacitor, registerPlugin } from "@capacitor/core";

interface ImmersiveModePlugin {
  enter(): Promise<void>;
  exit(): Promise<void>;
}

const ImmersiveMode = registerPlugin<ImmersiveModePlugin>("ImmersiveMode");

export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function enterImmersivePlayer(
  element: HTMLElement,
): Promise<void> {
  document.body.classList.add("immersive-player");
  try {
    if (isNativeAndroid()) {
      await ImmersiveMode.enter();
      if (!document.fullscreenElement) {
        await element.requestFullscreen?.().catch(() => undefined);
      }
    } else {
      if (!element.requestFullscreen) {
        throw new Error("当前环境不支持全屏播放");
      }
      if (!document.fullscreenElement) {
        await element.requestFullscreen();
      }
    }
  } catch (error) {
    document.body.classList.remove("immersive-player");
    if (isNativeAndroid()) {
      await ImmersiveMode.exit().catch(() => undefined);
    }
    throw error;
  }
}

export async function exitImmersivePlayer(): Promise<void> {
  document.body.classList.remove("immersive-player");
  if (document.fullscreenElement) {
    await document.exitFullscreen?.().catch(() => undefined);
  }
  if (isNativeAndroid()) {
    await ImmersiveMode.exit();
  }
}
