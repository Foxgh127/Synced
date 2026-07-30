export interface PixelFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface EmbeddedHorizontalBars {
  topRatio: number;
  bottomRatio: number;
}

export interface CenteredSmartCrop {
  scale: number;
  shiftY: 0;
}

function rowDarkRatio(frame: PixelFrame, row: number): number {
  const { data, width } = frame;
  const start = Math.max(0, Math.floor(width * 0.04));
  const end = Math.min(width, Math.ceil(width * 0.96));
  let dark = 0;
  let sampled = 0;
  for (let x = start; x < end; x += 2) {
    const offset = (row * width + x) * 4;
    const luminance =
      data[offset] * 0.2126 +
      data[offset + 1] * 0.7152 +
      data[offset + 2] * 0.0722;
    if (luminance <= 24) dark += 1;
    sampled += 1;
  }
  return sampled ? dark / sampled : 0;
}

function countDarkEdgeRows(
  frame: PixelFrame,
  edge: "top" | "bottom",
): number {
  const maximum = Math.max(1, Math.floor(frame.height * 0.36));
  let rows = 0;
  for (let offset = 0; offset < maximum; offset += 1) {
    const row = edge === "top" ? offset : frame.height - 1 - offset;
    if (rowDarkRatio(frame, row) < 0.84) break;
    rows += 1;
  }
  return rows;
}

function middleHasVisibleContent(
  frame: PixelFrame,
  topRows: number,
  bottomRows: number,
): boolean {
  const firstRow = Math.min(
    frame.height - 1,
    Math.max(topRows, Math.floor(frame.height * 0.25)),
  );
  const lastRow = Math.max(
    firstRow + 1,
    Math.min(
      frame.height,
      frame.height - bottomRows,
      Math.ceil(frame.height * 0.75),
    ),
  );
  let visible = 0;
  let sampled = 0;
  for (let y = firstRow; y < lastRow; y += 2) {
    for (let x = 2; x < frame.width - 2; x += 3) {
      const offset = (y * frame.width + x) * 4;
      const luminance =
        frame.data[offset] * 0.2126 +
        frame.data[offset + 1] * 0.7152 +
        frame.data[offset + 2] * 0.0722;
      if (luminance >= 36) visible += 1;
      sampled += 1;
    }
  }
  return sampled > 0 && visible / sampled >= 0.08;
}

/**
 * Detects letterbox bars baked into a captured player window. Requiring both
 * edges to be consistently dark avoids treating an ordinary dark scene as a
 * reason to crop the movie.
 */
export function measureEmbeddedHorizontalBars(
  frame: PixelFrame,
): EmbeddedHorizontalBars | undefined {
  if (
    frame.width < 16 ||
    frame.height < 16 ||
    frame.data.length < frame.width * frame.height * 4
  ) {
    return undefined;
  }
  const topRows = countDarkEdgeRows(frame, "top");
  const bottomRows = countDarkEdgeRows(frame, "bottom");
  const minimumEachEdge = Math.max(2, Math.floor(frame.height * 0.025));
  const detected =
    topRows >= minimumEachEdge &&
    bottomRows >= minimumEachEdge &&
    topRows + bottomRows >= Math.floor(frame.height * 0.12) &&
    middleHasVisibleContent(frame, topRows, bottomRows);
  if (!detected) return undefined;
  return {
    topRatio: topRows / frame.height,
    bottomRatio: bottomRows / frame.height,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

/**
 * Rejects transient dark scenes and subtitle flashes before a crop is used.
 * At least 60% of the samples must agree on both edges, and two agreeing
 * frames are always required.
 */
export function stableEmbeddedHorizontalBars(
  samples: EmbeddedHorizontalBars[],
  tolerance = 0.035,
): EmbeddedHorizontalBars | undefined {
  if (samples.length < 2) return undefined;
  const middleTop = median(samples.map((sample) => sample.topRatio));
  const middleBottom = median(samples.map((sample) => sample.bottomRatio));
  const agreeing = samples.filter(
    (sample) =>
      Math.abs(sample.topRatio - middleTop) <= tolerance &&
      Math.abs(sample.bottomRatio - middleBottom) <= tolerance,
  );
  if (agreeing.length < Math.max(2, Math.ceil(samples.length * 0.6))) {
    return undefined;
  }
  return {
    topRatio: median(agreeing.map((sample) => sample.topRatio)),
    bottomRatio: median(agreeing.map((sample) => sample.bottomRatio)),
  };
}

/**
 * Calculates a centered zoom that removes only stable, baked-in horizontal
 * bars. The smaller edge is authoritative, which guarantees that an
 * asymmetric title bar or subtitle area cannot pull the picture off-centre.
 */
export function calculateCenteredSmartCrop(options: {
  stageWidth: number;
  stageHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  bars?: EmbeddedHorizontalBars;
}): CenteredSmartCrop {
  const {
    stageWidth,
    stageHeight,
    sourceWidth,
    sourceHeight,
    bars,
  } = options;
  if (
    !bars ||
    stageWidth <= 0 ||
    stageHeight <= 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return { scale: 1, shiftY: 0 };
  }
  const stageRatio = stageWidth / stageHeight;
  const sourceRatio = sourceWidth / sourceHeight;
  const fillScale = stageRatio / sourceRatio;
  if (!Number.isFinite(fillScale) || fillScale <= 1.015) {
    return { scale: 1, shiftY: 0 };
  }

  const smallerBar = Math.min(bars.topRatio, bars.bottomRatio);
  if (!Number.isFinite(smallerBar) || smallerBar < 0.025) {
    return { scale: 1, shiftY: 0 };
  }
  // Preserve roughly one percent of the source as a subtitle/content safety
  // margin. The transform remains exactly centred even when the two detected
  // bars are not identical.
  const safeCropPerEdge = Math.max(0, smallerBar - 0.01);
  const safeScale = 1 / Math.max(0.2, 1 - 2 * safeCropPerEdge);
  const scale = Math.max(1, Math.min(1.6, fillScale, safeScale));
  return {
    scale: scale >= 1.02 ? scale : 1,
    shiftY: 0,
  };
}

export function hasEmbeddedHorizontalBars(frame: PixelFrame): boolean {
  return Boolean(measureEmbeddedHorizontalBars(frame));
}

export function exactSourceLabel(
  width: number,
  height: number,
  frameRate: number,
): string {
  return `原画 ${Math.round(width)}×${Math.round(height)} · ${Math.round(frameRate)} 帧`;
}
