export {
  DANMAKU_LANE_GAP_PX,
  DANMAKU_SPEED_PX_S,
  DUR,
  EASE,
  EXIT_RATIO,
  IDLE_HIDE_MS,
  STAGGER_MAX_ITEMS,
  STAGGER_STEP_MS,
} from "./motion.generated";
import {
  EXIT_RATIO,
  STAGGER_MAX_ITEMS,
  STAGGER_STEP_MS,
} from "./motion.generated";

export function exitDuration(enter: number): number {
  return Math.round(enter * EXIT_RATIO);
}

export function staggerDelay(index: number): number {
  return Math.min(index, STAGGER_MAX_ITEMS) * STAGGER_STEP_MS;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Resolves after a transition of `ms` would have finished, collapsing to a
 * single frame when the user asked for reduced motion.
 */
export function afterMotion(ms: number): Promise<void> {
  const effective = prefersReducedMotion() ? 1 : ms;
  return new Promise((resolve) => {
    window.setTimeout(resolve, effective);
  });
}
