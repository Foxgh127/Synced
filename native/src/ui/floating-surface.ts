import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
  type Placement,
} from "@floating-ui/dom";
import { FocusManager } from "./focus-manager";
import { PresenceController } from "./presence-controller";

interface FloatingSurfaceOptions {
  placement?: Placement;
  modal?: boolean;
  closeOnOutside?: boolean;
  matchReferenceWidth?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const openSurfaces: FloatingSurface[] = [];

function removeOpenSurface(surface: FloatingSurface): void {
  const index = openSurfaces.lastIndexOf(surface);
  if (index >= 0) openSurfaces.splice(index, 1);
}

export function closeTopmostFloatingSurface(): boolean {
  const surface = openSurfaces.at(-1);
  if (!surface) return false;
  void surface.close();
  return true;
}

export class FloatingSurface {
  private cleanupPosition?: () => void;
  private readonly focus = new FocusManager();
  private readonly abort = new AbortController();
  private openAbort?: AbortController;
  private readonly presence: PresenceController;
  private readonly originalParent: Node | null;
  private readonly originalNextSibling: Node | null;
  private opened = false;
  private operation = 0;

  constructor(
    private readonly reference: HTMLElement,
    private readonly surface: HTMLElement,
    private readonly options: FloatingSurfaceOptions = {},
  ) {
    this.originalParent = surface.parentNode;
    this.originalNextSibling = surface.nextSibling;
    document.body.append(surface);
    surface.dataset.floatingSurface = "";
    surface.classList.add("material-regular");
    this.presence = new PresenceController(surface, {
      enter: [
        { opacity: 0, transform: "translateY(-4px) scale(0.98)" },
        { opacity: 1, transform: "none" },
      ],
      exit: [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-2px) scale(0.99)" },
      ],
    });
  }

  async open(): Promise<void> {
    if (this.opened) return;
    const operation = ++this.operation;
    this.opened = true;
    removeOpenSurface(this);
    openSurfaces.push(this);
    this.syncMaterialBudget();
    this.openAbort?.abort();
    this.openAbort = new AbortController();
    document.addEventListener(
      "fullscreenchange",
      () => {
        this.syncPortalHost();
        void this.position();
      },
      { signal: this.openAbort.signal },
    );
    this.reference.setAttribute("aria-expanded", "true");
    this.syncPortalHost();
    this.surface.hidden = false;
    this.cleanupPosition = autoUpdate(
      this.reference,
      this.surface,
      () => void this.position(),
    );
    await this.position();
    if (
      !this.opened ||
      operation !== this.operation ||
      this.abort.signal.aborted
    ) {
      return;
    }
    const shown = await this.presence.show(this.abort.signal);
    if (
      !shown ||
      !this.opened ||
      operation !== this.operation ||
      this.abort.signal.aborted
    ) {
      return;
    }
    this.options.onOpenChange?.(true);
    if (this.options.modal) this.focus.trap(this.surface, this.reference);
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (
          openSurfaces.at(-1) === this &&
          this.options.closeOnOutside !== false &&
          event.target instanceof Node &&
          !this.surface.contains(event.target) &&
          !this.reference.contains(event.target)
        ) {
          void this.close();
        }
      },
      { capture: true, signal: this.openAbort.signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key === "Escape" &&
          openSurfaces.at(-1) === this
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void this.close();
        }
      },
      { signal: this.openAbort.signal },
    );
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    const operation = ++this.operation;
    this.opened = false;
    removeOpenSurface(this);
    this.syncMaterialBudget();
    this.openAbort?.abort();
    this.openAbort = undefined;
    this.reference.setAttribute("aria-expanded", "false");
    this.cleanupPosition?.();
    this.cleanupPosition = undefined;
    const hidden = await this.presence.hide();
    if (!hidden || operation !== this.operation || this.opened) return;
    if (this.options.modal) {
      this.focus.release(true);
    } else if (
      this.reference.isConnected &&
      (this.surface.contains(document.activeElement) ||
        document.activeElement === document.body)
    ) {
      this.reference.focus();
    }
    this.options.onOpenChange?.(false);
  }

  toggle(): Promise<void> {
    return this.opened ? this.close() : this.open();
  }

  async position(): Promise<void> {
    const { x, y, placement } = await computePosition(
      this.reference,
      this.surface,
      {
        strategy: "fixed",
        placement: this.options.placement || "bottom-end",
        middleware: [
          offset(8),
          flip({ padding: 12 }),
          shift({ padding: 12 }),
          size({
            padding: 12,
            apply: ({ availableHeight, rects, elements }) => {
              Object.assign(elements.floating.style, {
                maxHeight: `${Math.max(160, availableHeight)}px`,
                minWidth: this.options.matchReferenceWidth
                  ? `${rects.reference.width}px`
                  : "",
              });
            },
          }),
        ],
      },
    );
    Object.assign(this.surface.style, {
      position: "fixed",
      left: `${x}px`,
      top: `${y}px`,
      "--floating-transform-origin": placement.startsWith("top")
        ? "center bottom"
        : "center top",
    });
  }

  destroy(): void {
    this.operation += 1;
    this.opened = false;
    removeOpenSurface(this);
    this.syncMaterialBudget();
    this.abort.abort();
    this.openAbort?.abort();
    this.openAbort = undefined;
    this.cleanupPosition?.();
    this.cleanupPosition = undefined;
    this.presence.cancel();
    this.focus.release(false);
    if (this.originalParent instanceof Element && this.originalParent.isConnected) {
      this.originalParent.insertBefore(
        this.surface,
        this.originalNextSibling?.parentNode === this.originalParent
          ? this.originalNextSibling
          : null,
      );
    } else {
      this.surface.remove();
    }
  }

  private syncMaterialBudget(): void {
    document
      .querySelectorAll<HTMLElement>("[data-floating-surface]")
      .forEach((element) => delete element.dataset.floatingTop);
    const topmost = openSurfaces.at(-1);
    if (topmost) {
      document.documentElement.dataset.floatingOpen = "true";
      topmost.surface.dataset.floatingTop = "true";
    } else {
      delete document.documentElement.dataset.floatingOpen;
    }
  }

  private syncPortalHost(): void {
    const fullscreenElement = document.fullscreenElement;
    const host =
      fullscreenElement instanceof HTMLElement &&
      fullscreenElement.contains(this.reference)
        ? fullscreenElement
        : document.body;
    if (this.surface.parentElement !== host) {
      host.append(this.surface);
    }
  }
}
