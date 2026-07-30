import {
  DANMAKU_LANE_GAP_PX,
  DANMAKU_SPEED_PX_S,
} from "./design/motion";

const laneFreeAt: number[] = [];
const MIN_LANE_PITCH_PX = 44;

function getLaneCount(containerHeight: number, lanePitch: number): number {
  return Math.max(
    4,
    Math.min(12, Math.floor(containerHeight * 0.58 / lanePitch)),
  );
}

export function resetDanmakuLanes(): void {
  laneFreeAt.length = 0;
}

export function pickLane(
  elementWidth: number,
  _containerWidth: number,
  containerHeight: number,
  lanePitch = MIN_LANE_PITCH_PX,
): number {
  const laneCount = getLaneCount(containerHeight, lanePitch);
  if (laneFreeAt.length > laneCount) laneFreeAt.length = laneCount;
  while (laneFreeAt.length < laneCount) laneFreeAt.push(0);

  const now = Date.now();
  const travelMs =
    ((elementWidth + DANMAKU_LANE_GAP_PX) / DANMAKU_SPEED_PX_S) * 1_000;
  let bestLane = 0;
  let bestFreeAt = Number.POSITIVE_INFINITY;
  for (let lane = 0; lane < laneCount; lane += 1) {
    const freeAt = laneFreeAt[lane] ?? 0;
    if (freeAt < bestFreeAt) {
      bestFreeAt = freeAt;
      bestLane = lane;
    }
  }
  if (bestFreeAt > now + 500) return -1;
  laneFreeAt[bestLane] = now + travelMs;
  return bestLane;
}

export function danmakuDuration(
  elementWidth: number,
  containerWidth: number,
): number {
  return (containerWidth + elementWidth) / DANMAKU_SPEED_PX_S;
}

export class DanmakuOverlay {
  private readonly frames = new Set<number>();
  private readonly cleanupTimers = new Set<number>();

  constructor(private readonly container: HTMLElement) {}

  add(nickname: string, text: string, mine: boolean): void {
    const item = document.createElement("span");
    item.className = `danmaku ${mine ? "mine" : ""}`;

    const author = document.createElement("strong");
    author.textContent = nickname;
    const content = document.createElement("span");
    content.textContent = text;
    item.append(author, content);
    this.container.append(item);

    const frame = window.requestAnimationFrame(() => {
      this.frames.delete(frame);
      if (!item.isConnected) return;
      const containerWidth = Math.max(1, this.container.clientWidth);
      const containerHeight = Math.max(
        136,
        this.container.clientHeight || window.innerHeight,
      );
      const elementWidth = Math.max(24, item.offsetWidth);
      const lanePitch = Math.max(
        MIN_LANE_PITCH_PX,
        Math.ceil(item.offsetHeight) + 10,
      );
      const lane = pickLane(
        elementWidth,
        containerWidth,
        containerHeight,
        lanePitch,
      );
      if (lane === -1) {
        item.remove();
        return;
      }

      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const durationSeconds = danmakuDuration(
        elementWidth,
        containerWidth,
      );
      item.style.setProperty("--lane", String(lane));
      item.style.top = `calc(8% + ${lane * lanePitch}px)`;
      item.style.animation = reducedMotion
        ? "danmaku-static-fade 4200ms linear forwards"
        : `danmaku-fly ${durationSeconds.toFixed(2)}s linear forwards`;

      const remove = (): void => {
        item.remove();
      };
      item.addEventListener("animationend", remove, { once: true });
      const timer = window.setTimeout(
        () => {
          this.cleanupTimers.delete(timer);
          remove();
        },
        reducedMotion ? 4_700 : durationSeconds * 1_000 + 500,
      );
      this.cleanupTimers.add(timer);
    });
    this.frames.add(frame);
  }

  clear(): void {
    for (const frame of this.frames) window.cancelAnimationFrame(frame);
    for (const timer of this.cleanupTimers) window.clearTimeout(timer);
    this.frames.clear();
    this.cleanupTimers.clear();
    resetDanmakuLanes();
    this.container.replaceChildren();
  }
}
