import { animateElement } from "./motion-controller";

export async function transitionView(
  container: HTMLElement,
  update: () => void | Promise<void>,
  options: {
    signal?: AbortSignal;
    name?: string;
  } = {},
): Promise<void> {
  if (options.signal?.aborted) return;
  const reduced =
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.dataset.motion === "reduced";

  if (document.startViewTransition && !reduced) {
    const transition = document.startViewTransition(update);
    const abort = (): void => transition.skipTransition();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await transition.finished;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    return;
  }

  const exit = await animateElement(
    container,
    [
      { opacity: 1, transform: "scale(1)" },
      { opacity: 0, transform: "scale(0.995)" },
    ],
    {
      kind: "view",
      signal: options.signal,
      id: options.name || "view-transition",
      reducedKeyframes: [{ opacity: 1 }, { opacity: 0 }],
    },
  );
  if (exit === "cancelled" || options.signal?.aborted) return;
  await update();
  await animateElement(
    container,
    [
      { opacity: 0, transform: "scale(0.995)" },
      { opacity: 1, transform: "scale(1)" },
    ],
    {
      kind: "view",
      signal: options.signal,
      id: options.name || "view-transition",
      reducedKeyframes: [{ opacity: 0 }, { opacity: 1 }],
    },
  );
}
