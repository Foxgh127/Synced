import { DUR, EASE, prefersReducedMotion } from "../design/motion";

export type MotionKind =
  | "micro"
  | "control"
  | "panel"
  | "view"
  | "immersive"
  | "ambient";

export interface MotionOptions {
  kind?: MotionKind;
  duration?: number;
  easing?: string;
  signal?: AbortSignal;
  id?: string;
  reducedKeyframes?: Keyframe[];
  fill?: FillMode;
}

const activeAnimations = new WeakMap<
  Element,
  Map<string, Animation>
>();
const runningAnimations = new Set<Animation>();
let preferenceListenersReady = false;

function finishRunningAnimations(): void {
  for (const animation of runningAnimations) {
    try {
      animation.finish();
    } catch {
      animation.cancel();
    }
  }
}

function ensurePreferenceListeners(): void {
  if (preferenceListenersReady || typeof window === "undefined") return;
  preferenceListenersReady = true;
  window
    .matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", finishRunningAnimations);
  document.addEventListener(
    "synced:motion-preference-change",
    finishRunningAnimations,
  );
}

function durationFor(kind: MotionKind): number {
  switch (kind) {
    case "micro":
      return DUR.fast;
    case "control":
      return DUR.base;
    case "panel":
      return DUR.slow;
    case "view":
      return DUR.view;
    case "immersive":
      return DUR.immersive;
    case "ambient":
      return DUR.ambient;
  }
}

function shouldReduceMotion(): boolean {
  return (
    prefersReducedMotion() ||
    document.documentElement.dataset.motion === "reduced"
  );
}

function animationMap(element: Element): Map<string, Animation> {
  let map = activeAnimations.get(element);
  if (!map) {
    map = new Map();
    activeAnimations.set(element, map);
  }
  return map;
}

export function cancelElementMotion(
  element: Element,
  id?: string,
): void {
  const map = activeAnimations.get(element);
  if (!map) return;
  if (id) {
    map.get(id)?.cancel();
    map.delete(id);
  } else {
    for (const animation of map.values()) animation.cancel();
    map.clear();
  }
}

export async function animateElement(
  element: HTMLElement,
  keyframes: Keyframe[],
  options: MotionOptions = {},
): Promise<"finished" | "cancelled"> {
  ensurePreferenceListeners();
  const {
    kind = "control",
    duration,
    easing = EASE.out,
    signal,
    id = "default",
    reducedKeyframes = [{ opacity: 0 }, { opacity: 1 }],
    fill = "both",
  } = options;
  if (signal?.aborted) return "cancelled";

  const map = animationMap(element);
  map.get(id)?.cancel();
  const reduced = shouldReduceMotion();
  const animation = element.animate(
    reduced ? reducedKeyframes : keyframes,
    {
      duration: reduced
        ? Math.min(140, duration ?? durationFor(kind))
        : (duration ?? durationFor(kind)),
      easing,
      fill,
    },
  );
  map.set(id, animation);
  runningAnimations.add(animation);

  const abort = (): void => animation.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await animation.finished;
    return "finished";
  } catch {
    return "cancelled";
  } finally {
    signal?.removeEventListener("abort", abort);
    runningAnimations.delete(animation);
    if (map.get(id) === animation) map.delete(id);
  }
}

export class MotionController {
  private generation = 0;
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return (
      !this.controller.signal.aborted &&
      generation === this.generation
    );
  }

  cancelCurrent(): void {
    this.generation += 1;
  }

  destroy(): void {
    this.generation += 1;
    this.controller.abort();
  }
}
