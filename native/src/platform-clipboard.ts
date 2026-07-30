import { Capacitor, registerPlugin } from "@capacitor/core";

interface NativeClipboardPlugin {
  write(options: { text: string }): Promise<{ ok: boolean }>;
}

const NativeClipboard =
  registerPlugin<NativeClipboardPlugin>("NativeClipboard");

function fallbackCopy(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("系统未允许复制");
  }
}

export async function copyText(text: string): Promise<void> {
  if (!text) {
    throw new Error("没有可复制的内容");
  }

  if (
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === "android"
  ) {
    const result = await NativeClipboard.write({ text });
    if (!result.ok) {
      throw new Error("手机剪贴板写入失败，请重试");
    }
    return;
  }

  if (window.roomDesktop) {
    await window.roomDesktop.writeClipboard(text);
    const verified = await window.roomDesktop.readClipboard();
    if (verified !== text) {
      throw new Error("电脑剪贴板写入失败，请重试");
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    fallbackCopy(text);
  }
}
