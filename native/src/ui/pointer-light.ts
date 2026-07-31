export function bindLocalPointerLight(
  root: ParentNode,
  signal: AbortSignal,
): void {
  if (
    !matchMedia("(hover: hover) and (pointer: fine)").matches ||
    document.documentElement.dataset.motion === "reduced"
  ) {
    return;
  }

  let frame = 0;
  let pending:
    | { card: HTMLElement; x: number; y: number }
    | undefined;

  root.querySelectorAll<HTMLElement>(".interactive-card").forEach((card) => {
    card.addEventListener(
      "pointermove",
      (event) => {
        const bounds = card.getBoundingClientRect();
        pending = {
          card,
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        };
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (!pending) return;
          pending.card.style.setProperty("--pointer-x", `${pending.x}px`);
          pending.card.style.setProperty("--pointer-y", `${pending.y}px`);
          pending.card.style.setProperty("--pointer-opacity", "1");
        });
      },
      { passive: true, signal },
    );
    card.addEventListener(
      "pointerleave",
      () => {
        card.style.setProperty("--pointer-opacity", "0");
      },
      { signal },
    );
  });

  signal.addEventListener(
    "abort",
    () => {
      if (frame) cancelAnimationFrame(frame);
    },
    { once: true },
  );
}
