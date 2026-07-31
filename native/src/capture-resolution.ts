export interface CaptureResolutionSettings {
  width?: number;
  height?: number;
  screenPixelRatio?: number;
}

export interface PhysicalCaptureTarget {
  width: number;
  height: number;
  upgradeRequired: boolean;
  edgeGuardRequired: boolean;
  recreateRequired: boolean;
}

export interface CaptureWindowGeometry {
  width: number;
  height: number;
}

export interface CaptureWindowGeometrySample {
  width?: number;
  height?: number;
  visible?: boolean;
  minimized?: boolean;
}

export interface SafeVideoEncodingTarget {
  width: number;
  height: number;
  scaleResolutionDownBy: number;
  edgeGuardRequired: boolean;
}

const ENCODER_ROW_ALIGNMENT = 16;
const CHROMA_ALIGNMENT = 2;
const CAPTURE_TEXTURE_HEIGHT_ALIGNMENT = 8;
const MAX_SOURCE_AREA_JITTER = 0.2;
// Player chrome/control bars commonly change the client height by 40-60 px
// while the captured surface itself remains valid. Treat only a material
// aspect transition (such as windowed -> F11) as a new capture surface.
const MAX_SOURCE_ASPECT_JITTER = 0.08;

/**
 * Returns the symmetric inline crop needed when a legacy sender or SFU layer
 * still exposes a partial H.264 macroblock. New publications are aligned
 * before encoding; this is the final receiver/local-preview guard for streams
 * already negotiated at widths such as 854 or 1206.
 */
export function decoderEdgeGuardPixels(encodedWidthInput: number): number {
  const encodedWidth = Math.round(Number(encodedWidthInput));
  if (!Number.isFinite(encodedWidth) || encodedWidth < ENCODER_ROW_ALIGNMENT) {
    return 0;
  }
  const validRemainder = encodedWidth % ENCODER_ROW_ALIGNMENT;
  return validRemainder === 0
    ? 0
    : Math.min(
        ENCODER_ROW_ALIGNMENT / 2,
        Math.ceil((ENCODER_ROW_ALIGNMENT - validRemainder) / 2),
      );
}

function alignmentFloor(value: number, alignment: number): number {
  return Math.floor(value / alignment) * alignment;
}

/**
 * Keep the captured row width on a complete hardware texture stride and its
 * height on an 8-line texture boundary. Some Windows WGC + Chromium GPU paths
 * expose zeroed YUV padding in the local preview for heights such as 1866,
 * which appears as RGB(0, 136, 0) on the first and last displayed rows. The
 * WebRTC encoder crops that padding correctly, explaining why receivers can
 * remain clean while the broadcaster preview has green horizontal edges.
 *
 * H.264 represents ordinary 1920x1080 by cropping a padded bottom macroblock,
 * a universally supported path. Eight-line alignment deliberately preserves
 * ordinary 720p, 1080p, 1440p and 2160p while avoiding an unnecessary
 * 16-line crop. The exact-size capture request rescales the complete source by
 * at most seven rows; it does not cover or mask valid picture content.
 */
function alignedCaptureDimensions(
  fittedWidth: number,
  fittedHeight: number,
): CaptureWindowGeometry | undefined {
  const width = alignmentFloor(fittedWidth, ENCODER_ROW_ALIGNMENT);
  const height = alignmentFloor(
    fittedHeight,
    CAPTURE_TEXTURE_HEIGHT_ALIGNMENT,
  );
  if (
    width < ENCODER_ROW_ALIGNMENT ||
    height < CAPTURE_TEXTURE_HEIGHT_ALIGNMENT
  ) {
    return undefined;
  }
  return { width, height };
}

/**
 * Produces a sender scale whose encoded row width remains safe for Android
 * hardware decoders. Capture alignment alone is insufficient: scaling a
 * 3616x2160 fullscreen track to 720p with a plain height ratio yields an
 * approximately 1206px encoded row and exposes decoder padding as a green
 * edge. Deriving the scale from a 16-aligned output width keeps both the
 * original and every receiver-selected rung on a complete decoder stride.
 */
export function safeVideoEncodingTarget(
  sourceWidthInput: number,
  sourceHeightInput: number,
  requestedHeightInput?: number,
): SafeVideoEncodingTarget | undefined {
  const sourceWidth = Math.round(Number(sourceWidthInput));
  const sourceHeight = Math.round(Number(sourceHeightInput));
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth < ENCODER_ROW_ALIGNMENT ||
    sourceHeight < CHROMA_ALIGNMENT
  ) {
    return undefined;
  }
  const requestedHeight = Number.isFinite(Number(requestedHeightInput))
    ? Math.max(
        CHROMA_ALIGNMENT,
        Math.min(sourceHeight, Number(requestedHeightInput)),
      )
    : sourceHeight;
  const heightScale = Math.max(1, sourceHeight / requestedHeight);
  const desiredWidth = sourceWidth / heightScale;
  const width = alignmentFloor(desiredWidth, ENCODER_ROW_ALIGNMENT);
  if (width < ENCODER_ROW_ALIGNMENT) return undefined;

  // scaleResolutionDownBy is uniform. Anchor it to the safe row width, then
  // report the chroma-aligned height Chromium's encoder can expose.
  const scaleResolutionDownBy = Math.max(1, sourceWidth / width);
  const height = alignmentFloor(
    sourceHeight / scaleResolutionDownBy,
    CHROMA_ALIGNMENT,
  );
  if (height < CHROMA_ALIGNMENT) return undefined;
  return {
    width,
    height,
    scaleResolutionDownBy,
    edgeGuardRequired:
      desiredWidth - width >= 0.5 ||
      sourceHeight / scaleResolutionDownBy - height >= 0.5,
  };
}

export function normalizeCaptureWindowGeometry(
  sample: CaptureWindowGeometrySample | undefined,
): CaptureWindowGeometry | undefined {
  const width = Math.round(Number(sample?.width));
  const height = Math.round(Number(sample?.height));
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 160 ||
    height < 90 ||
    sample?.visible === false ||
    sample?.minimized === true
  ) {
    return undefined;
  }
  return { width, height };
}

/**
 * F11 commonly keeps the same HWND and capture source id while replacing the
 * browser client geometry. Ignore resize/DPI rounding noise, but treat a large
 * area jump or material aspect change as a new capture surface.
 */
export function captureWindowGeometryChanged(
  previous: CaptureWindowGeometry | undefined,
  next: CaptureWindowGeometry | undefined,
): boolean {
  if (!previous || !next) return false;
  const previousArea = previous.width * previous.height;
  const nextArea = next.width * next.height;
  const previousAspect = previous.width / previous.height;
  const nextAspect = next.width / next.height;
  return (
    Math.abs(nextArea / previousArea - 1) >= MAX_SOURCE_AREA_JITTER ||
    Math.abs(nextAspect / previousAspect - 1) >= MAX_SOURCE_ASPECT_JITTER
  );
}

/**
 * Chromium initially exposes Windows window-capture dimensions in logical
 * pixels on high-DPI displays. WebRTC then encodes that smaller raster unless
 * the physical-sized stream is requested when the track is created.
 */
export function physicalCaptureTarget(
  settings: CaptureResolutionSettings,
  maximumWidth: number,
  maximumHeight: number,
): PhysicalCaptureTarget | undefined {
  const logicalWidth = Number(settings.width);
  const logicalHeight = Number(settings.height);
  if (
    !Number.isFinite(logicalWidth) ||
    !Number.isFinite(logicalHeight) ||
    logicalWidth < 2 ||
    logicalHeight < 2
  ) {
    return undefined;
  }
  const scale = Number.isFinite(settings.screenPixelRatio)
    ? Math.max(1, Math.min(4, Number(settings.screenPixelRatio)))
    : 1;
  const physicalWidth = logicalWidth * scale;
  const physicalHeight = logicalHeight * scale;
  const fit = Math.min(
    1,
    Math.max(2, maximumWidth) / physicalWidth,
    Math.max(2, maximumHeight) / physicalHeight,
  );
  const fittedWidth = physicalWidth * fit;
  const fittedHeight = physicalHeight * fit;
  const target = alignedCaptureDimensions(fittedWidth, fittedHeight);
  if (!target) {
    return undefined;
  }
  const { width, height } = target;
  const upgradeRequired =
    scale > 1.01 &&
    (width >= logicalWidth * 1.1 || height >= logicalHeight * 1.1);
  const edgeGuardRequired =
    fittedWidth - width >= 0.5 || fittedHeight - height >= 0.5;
  return {
    width,
    height,
    upgradeRequired,
    edgeGuardRequired,
    recreateRequired: upgradeRequired || edgeGuardRequired,
  };
}
