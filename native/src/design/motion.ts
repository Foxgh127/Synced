/**
 * Motion constants mirrored from design/tokens.css.
 *
 * JavaScript needs these whenever a transition has to be awaited before the
 * next step (removing a node after its exit animation, staggering a list).
 * Keep the numbers in sync with the CSS custom properties by hand — reading
 * them back through getComputedStyle on every call forces a style flush.
 */

export const DUR = {
  /** Press feedback, colour swaps. */
  instant: 80,
  /** Hover, chips, tooltips, switches. */
  fast: 140,
  /** Popovers, dock reveal, command palette. */
  base: 220,
  /** Drawers, dialogs. */
  slow: 320,
  /** View/state transitions, fullscreen. */
  view: 440,
  /** Brand celebration and onboarding only. */
  brand: 720,
} as const;

export const EASE = {
  out: "cubic-bezier(0.16, 1, 0.30, 1)",
  in: "cubic-bezier(0.50, 0, 0.85, 0)",
  inout: "cubic-bezier(0.65, 0, 0.35, 1)",
  emphasis: "cubic-bezier(0.20, 0, 0, 1)",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;

/** Exits run faster than entrances; people tolerate leaving more than arriving. */
export const EXIT_RATIO = 0.7;

export function exitDuration(enter: number): number {
  return Math.round(enter * EXIT_RATIO);
}

/** Per-item delay for staggered list entrances. */
export const STAGGER_STEP_MS = 24;

/** Beyond this many items the stagger stops accumulating. */
export const STAGGER_MAX_ITEMS = 8;

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

/** Controls auto-hide delay for the HUD and dock while the pointer rests. */
export const IDLE_HIDE_MS = 3000;

/** Danmaku travel speed in CSS pixels per second, independent of text length. */
export const DANMAKU_SPEED_PX_S = 168;

/** Trailing gap kept behind each danmaku so a lane never visually collides. */
export const DANMAKU_LANE_GAP_PX = 48;
