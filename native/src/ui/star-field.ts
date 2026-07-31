interface Star {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  twinklePerSecond: number;
  risePerSecond: number;
}

export interface StarFieldOptions {
  densityScale?: number;
  speedScale?: number;
}

function motionIsReduced(): boolean {
  return (
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.dataset.motion === "reduced"
  );
}

function viewportStarCount(): number {
  return window.innerWidth >= 1_440
    ? 72
    : window.innerWidth >= 700
      ? 48
      : 36;
}

export function bindStarField(
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
  options: StarFieldOptions = {},
): void {
  const context = canvas.getContext("2d");
  if (!context || signal.aborted) return;

  const densityScale = Math.max(0.25, options.densityScale ?? 1);
  const speedScale = Math.max(0.25, options.speedScale ?? 1);
  const stars: Star[] = [];
  const color =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--n-000")
      .trim() || "white";
  let width = 1;
  let height = 1;
  let animationFrame = 0;
  let lastFrameAt = 0;
  let frameCount = 0;

  const desiredCount = (): number => {
    const viewportArea = Math.max(
      1,
      window.innerWidth * window.innerHeight,
    );
    const localArea = Math.max(1, width * height);
    return Math.max(
      18,
      Math.round(
        viewportStarCount() *
          (localArea / viewportArea) *
          densityScale,
      ),
    );
  };

  const createStar = (placeAtBottom = false): Star => ({
    x: Math.random() * width,
    y: placeAtBottom ? height + Math.random() * 4 : Math.random() * height,
    radius: Math.random() * 0.8 + 0.25,
    alpha: Math.random() * 0.45 + 0.08,
    twinklePerSecond: (Math.random() - 0.5) * 0.1,
    risePerSecond: (Math.random() * 5.2 + 2.8) * speedScale,
  });

  const reconcileStars = (): void => {
    const target = desiredCount();
    while (stars.length < target) stars.push(createStar());
    if (stars.length > target) stars.length = target;
    canvas.dataset.starCount = String(stars.length);
  };

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, rect.width);
    const nextHeight = Math.max(1, rect.height);
    const widthRatio = nextWidth / width;
    const heightRatio = nextHeight / height;
    width = nextWidth;
    height = nextHeight;
    for (const star of stars) {
      star.x *= widthRatio;
      star.y *= heightRatio;
    }
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
    canvas.width = Math.max(1, Math.round(width * pixelRatio));
    canvas.height = Math.max(1, Math.round(height * pixelRatio));
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    reconcileStars();
  };

  const drawFrame = (now: number): void => {
    animationFrame = 0;
    if (signal.aborted || document.hidden) return;
    canvas.dataset.starFrame = String(++frameCount);
    const deltaSeconds = lastFrameAt
      ? Math.min(0.05, (now - lastFrameAt) / 1_000)
      : 0;
    lastFrameAt = now;
    context.clearRect(0, 0, width, height);
    context.fillStyle = color;
    for (const star of stars) {
      star.alpha = Math.max(
        0.06,
        Math.min(
          0.52,
          star.alpha + star.twinklePerSecond * deltaSeconds,
        ),
      );
      if (star.alpha <= 0.06 || star.alpha >= 0.52) {
        star.twinklePerSecond *= -1;
      }
      if (!motionIsReduced()) {
        star.y -= star.risePerSecond * deltaSeconds;
        if (star.y < -2) Object.assign(star, createStar(true));
      }
      context.beginPath();
      context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      context.globalAlpha = star.alpha;
      context.fill();
    }
    context.globalAlpha = 1;
    if (!motionIsReduced()) {
      animationFrame = requestAnimationFrame(drawFrame);
    }
  };

  const restart = (): void => {
    if (
      signal.aborted ||
      document.hidden ||
      animationFrame ||
      motionIsReduced()
    ) {
      return;
    }
    lastFrameAt = 0;
    animationFrame = requestAnimationFrame(drawFrame);
  };

  const resizeObserver = new ResizeObserver(() => {
    resize();
    if (motionIsReduced()) drawFrame(performance.now());
    else restart();
  });
  resizeObserver.observe(canvas);
  resize();
  animationFrame = requestAnimationFrame(drawFrame);
  document.addEventListener("visibilitychange", restart, { signal });
  document.addEventListener("synced:motion-preference-change", restart, {
    signal,
  });
  signal.addEventListener(
    "abort",
    () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      resizeObserver.disconnect();
    },
    { once: true },
  );
}
