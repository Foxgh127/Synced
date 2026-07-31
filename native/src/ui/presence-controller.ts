import { animateElement, cancelElementMotion } from "./motion-controller";

export interface PresenceKeyframes {
  enter: Keyframe[];
  exit: Keyframe[];
  reducedEnter?: Keyframe[];
  reducedExit?: Keyframe[];
}

export class PresenceController {
  private generation = 0;

  constructor(
    private readonly element: HTMLElement,
    private readonly keyframes: PresenceKeyframes,
  ) {}

  async show(signal?: AbortSignal): Promise<boolean> {
    const generation = ++this.generation;
    cancelElementMotion(this.element, "presence");
    this.element.hidden = false;
    this.element.dataset.presence = "entering";
    const result = await animateElement(
      this.element,
      this.keyframes.enter,
      {
        kind: "panel",
        signal,
        id: "presence",
        reducedKeyframes:
          this.keyframes.reducedEnter ||
          [{ opacity: 0 }, { opacity: 1 }],
      },
    );
    if (generation !== this.generation || result === "cancelled") {
      return false;
    }
    this.element.dataset.presence = "present";
    return true;
  }

  async hide(signal?: AbortSignal): Promise<boolean> {
    const generation = ++this.generation;
    cancelElementMotion(this.element, "presence");
    this.element.dataset.presence = "leaving";
    const result = await animateElement(
      this.element,
      this.keyframes.exit,
      {
        kind: "panel",
        signal,
        id: "presence",
        reducedKeyframes:
          this.keyframes.reducedExit ||
          [{ opacity: 1 }, { opacity: 0 }],
      },
    );
    if (generation !== this.generation || result === "cancelled") {
      return false;
    }
    this.element.hidden = true;
    this.element.dataset.presence = "left";
    return true;
  }

  cancel(): void {
    this.generation += 1;
    cancelElementMotion(this.element, "presence");
  }
}
