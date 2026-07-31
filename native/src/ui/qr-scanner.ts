import type QrScannerType from "qr-scanner";
import { dialogController } from "./dialog-controller";
import { hydrateIcons } from "./icons";

export async function scanQrCode(
  opener?: HTMLElement,
): Promise<string | undefined> {
  const dialog = document.createElement("dialog");
  dialog.className = "qr-scanner-dialog";
  dialog.setAttribute("aria-labelledby", "qr-scanner-title");
  dialog.innerHTML = `
    <header class="dialog-header">
      <div><span class="eyebrow">SCAN INVITE</span><h2 id="qr-scanner-title">扫描频道二维码</h2></div>
      <button class="btn btn-ghost btn-icon" type="button" data-scan-close aria-label="关闭扫描"><i data-lucide="x"></i></button>
    </header>
    <video class="qr-scanner-video" playsinline muted aria-label="二维码相机预览"></video>
    <p id="qr-scanner-status" aria-live="polite">正在申请相机权限…</p>
  `;
  document.body.append(dialog);
  hydrateIcons(dialog);
  const video = dialog.querySelector<HTMLVideoElement>("video");
  const status = dialog.querySelector<HTMLElement>("#qr-scanner-status");
  if (!video || !status) {
    dialog.remove();
    return undefined;
  }

  let scanner: QrScannerType | undefined;
  let settled = false;
  const controller = new AbortController();
  let resolveResult: (value?: string) => void = () => undefined;
  const result = new Promise<string | undefined>((resolve) => {
    resolveResult = resolve;
  });
  const finish = async (value?: string): Promise<void> => {
    if (settled) return;
    settled = true;
    controller.abort();
    scanner?.stop();
    scanner?.destroy();
    if (dialog.open) await dialogController.close(dialog);
    dialog.remove();
    resolveResult(value);
  };
  dialog
    .querySelector("[data-scan-close]")
    ?.addEventListener("click", () => void finish(), {
      once: true,
      signal: controller.signal,
    });
  dialog.addEventListener(
    "close",
    () => void finish(),
    { once: true, signal: controller.signal },
  );

  await dialogController.open(dialog, opener);
  if (settled || !dialog.open) return result;
  try {
    const { default: QrScanner } = await import("qr-scanner");
    if (settled || !dialog.open) return result;
    scanner = new QrScanner(
      video,
      (scan) => void finish(scan.data),
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
        maxScansPerSecond: 8,
      },
    );
    await scanner.start();
    if (controller.signal.aborted) {
      scanner.stop();
      scanner.destroy();
      return result;
    }
    status.textContent = "将邀请二维码放入取景框";
  } catch (error) {
    if (!settled) {
      status.textContent =
        error instanceof Error
          ? `无法打开相机：${error.message}`
          : "无法打开相机，请检查相机权限";
      status.setAttribute("role", "alert");
    }
  }
  return result;
}
