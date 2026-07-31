import { currentResourceBudget } from "../resource-budget";

function averageEdge(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  side: "left" | "right",
): string {
  const startX = side === "left" ? 0 : Math.floor(width * 0.75);
  const endX =
    side === "left" ? Math.ceil(width * 0.25) : width;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = startX; x < endX; x += 2) {
      const offset = (y * width + x) * 4;
      red += data[offset];
      green += data[offset + 1];
      blue += data[offset + 2];
      count += 1;
    }
  }
  const scale = count ? 1 / count : 0;
  return `rgba(${Math.round(red * scale)}, ${Math.round(green * scale)}, ${Math.round(blue * scale)}, 0.18)`;
}

export class AmbientLightController {
  private readonly canvas = document.createElement("canvas");
  private readonly context = this.canvas.getContext("2d", {
    willReadFrequently: true,
  });
  private timer?: number;
  private readonly controller = new AbortController();

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly host: HTMLElement,
  ) {
    this.canvas.width = 32;
    this.canvas.height = 18;
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) this.pause();
        else this.resume();
      },
      { signal: this.controller.signal },
    );
  }

  start(): void {
    this.resume();
  }

  pause(): void {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.host.style.setProperty("--ambient-opacity", "0");
  }

  private resume(): void {
    if (this.timer !== undefined || document.hidden) return;
    this.sample();
    this.timer = window.setInterval(() => this.sample(), 750);
  }

  private sample(): void {
    const budget = currentResourceBudget();
    const root = document.documentElement;
    const hdr =
      this.video.dataset.hdr === "true" ||
      matchMedia("(dynamic-range: high)").matches;
    if (
      !this.context ||
      this.video.hidden ||
      this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      root.dataset.ambient === "off" ||
      budget.pressure !== "normal" ||
      hdr
    ) {
      this.host.style.setProperty("--ambient-opacity", "0");
      return;
    }
    try {
      this.context.drawImage(this.video, 0, 0, 32, 18);
      const frame = this.context.getImageData(0, 0, 32, 18);
      this.host.style.setProperty(
        "--ambient-left",
        averageEdge(frame.data, 32, 18, "left"),
      );
      this.host.style.setProperty(
        "--ambient-right",
        averageEdge(frame.data, 32, 18, "right"),
      );
      this.host.style.setProperty("--ambient-opacity", "1");
    } catch {
      this.host.style.setProperty("--ambient-opacity", "0");
    }
  }

  destroy(): void {
    this.controller.abort();
    this.pause();
    this.host.style.removeProperty("--ambient-left");
    this.host.style.removeProperty("--ambient-right");
  }
}
