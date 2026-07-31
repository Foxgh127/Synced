const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusableElements(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.getClientRects().length > 0,
  );
}

export class FocusManager {
  private restoreTarget?: HTMLElement;
  private controller?: AbortController;

  trap(root: HTMLElement, opener?: HTMLElement): void {
    this.release(false);
    this.restoreTarget =
      opener ||
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined);
    const controller = new AbortController();
    this.controller = controller;
    root.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Tab") return;
        const focusable = focusableElements(root);
        if (!focusable.length) {
          event.preventDefault();
          root.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === last
        ) {
          event.preventDefault();
          first.focus();
        }
      },
      { signal: controller.signal },
    );
    queueMicrotask(() => {
      const target =
        root.querySelector<HTMLElement>("[autofocus]") ||
        focusableElements(root)[0] ||
        root;
      if (!root.hasAttribute("tabindex")) root.tabIndex = -1;
      target.focus();
    });
  }

  release(restore = true): void {
    this.controller?.abort();
    this.controller = undefined;
    if (restore && this.restoreTarget?.isConnected) {
      this.restoreTarget.focus();
    }
    this.restoreTarget = undefined;
  }
}
