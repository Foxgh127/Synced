import { DUR, EASE, exitDuration } from "../design/motion";
import { FocusManager } from "./focus-manager";
import { animateElement, cancelElementMotion } from "./motion-controller";

export class DialogController {
  private active?: HTMLDialogElement;
  private readonly focus = new FocusManager();
  private operation = 0;
  private readonly abort = new AbortController();

  constructor() {
    document.addEventListener(
      "cancel",
      (event) => {
        const dialog = event.target;
        if (!(dialog instanceof HTMLDialogElement)) return;
        event.preventDefault();
        void this.close(dialog);
      },
      { capture: true, signal: this.abort.signal },
    );
  }

  async open(
    dialog: HTMLDialogElement,
    opener?: HTMLElement,
  ): Promise<void> {
    if (
      this.active === dialog &&
      dialog.open &&
      dialog.dataset.presence !== "leaving"
    ) {
      return;
    }
    const operation = ++this.operation;
    if (this.active && this.active !== dialog) {
      await this.performClose(this.active, operation);
    }
    if (operation !== this.operation) return;
    this.active = dialog;
    document.body.dataset.modalOpen = "true";
    if (!dialog.open) dialog.showModal();
    dialog.dataset.presence = "entering";
    this.focus.trap(dialog, opener);
    cancelElementMotion(dialog, "dialog");
    const result = await animateElement(
      dialog,
      [
        { opacity: 0, transform: "translateY(10px) scale(0.985)" },
        { opacity: 1, transform: "none" },
      ],
      {
        kind: "panel",
        easing: EASE.out,
        id: "dialog",
        reducedKeyframes: [{ opacity: 0 }, { opacity: 1 }],
      },
    );
    if (
      result === "finished" &&
      operation === this.operation &&
      this.active === dialog
    ) {
      dialog.dataset.presence = "present";
    }
  }

  async close(dialog = this.active): Promise<void> {
    const operation = ++this.operation;
    await this.performClose(dialog, operation);
  }

  private async performClose(
    dialog: HTMLDialogElement | undefined,
    operation: number,
  ): Promise<void> {
    if (!dialog) return;
    if (!dialog.open) {
      if (this.active === dialog && operation === this.operation) {
        this.releaseActive(dialog, true);
      }
      return;
    }
    dialog.dataset.presence = "leaving";
    cancelElementMotion(dialog, "dialog");
    const result = await animateElement(
      dialog,
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(4px) scale(0.992)" },
      ],
      {
        kind: "panel",
        duration: exitDuration(DUR.slow),
        easing: EASE.in,
        id: "dialog",
        reducedKeyframes: [{ opacity: 1 }, { opacity: 0 }],
      },
    );
    if (result !== "finished" || operation !== this.operation) return;
    dialog.close();
    dialog.dataset.presence = "left";
    if (this.active === dialog) {
      this.releaseActive(dialog, true);
    }
  }

  dismiss(
    dialog = this.active,
    restoreFocus = true,
  ): void {
    if (!dialog) return;
    this.operation += 1;
    cancelElementMotion(dialog, "dialog");
    if (dialog.open) dialog.close();
    dialog.dataset.presence = "left";
    if (this.active === dialog) {
      this.releaseActive(dialog, restoreFocus);
    }
  }

  private releaseActive(
    dialog: HTMLDialogElement,
    restoreFocus: boolean,
  ): void {
    if (this.active !== dialog) return;
    this.active = undefined;
    delete document.body.dataset.modalOpen;
    this.focus.release(restoreFocus);
  }

  bind(
    dialog: HTMLDialogElement,
    closeSelector = "[data-dialog-close]",
  ): () => void {
    const controller = new AbortController();
    dialog.querySelectorAll<HTMLElement>(closeSelector).forEach((button) => {
      button.addEventListener(
        "click",
        () => void this.close(dialog),
        { signal: controller.signal },
      );
    });
    return () => controller.abort();
  }

  closeTopmost(): boolean {
    if (!this.active?.open) return false;
    void this.close(this.active);
    return true;
  }

  destroy(): void {
    this.abort.abort();
    this.dismiss(this.active, false);
  }
}

export const dialogController = new DialogController();
