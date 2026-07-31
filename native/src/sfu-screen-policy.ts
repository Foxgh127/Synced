export interface SfuScreenSubscriptionPreference {
  width?: number;
  height?: number;
  frameRate?: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

export interface SfuScreenSubscriptionTarget {
  width: number;
  height: number;
  frameRate: number;
  quality: "low" | "medium" | "high";
  emergency: boolean;
}

/**
 * Resolves a viewer-local LiveKit subscription request. A 1440p source maps
 * to high/medium/low at 1440p/1080p/720p, while 480p uses the separately
 * published emergency track so it remains available even if simulcast only
 * exposes three encodings.
 */
export function resolveSfuScreenSubscription(
  preference: SfuScreenSubscriptionPreference,
): SfuScreenSubscriptionTarget {
  const sourceWidth = Math.max(1, Math.round(preference.sourceWidth || 2_560));
  const sourceHeight = Math.max(
    1,
    Math.round(preference.sourceHeight || 1_440),
  );
  const requestedHeight = Math.max(
    1,
    Math.min(
      Math.round(preference.height || sourceHeight),
      sourceHeight,
    ),
  );
  const rawRequestedWidth =
    preference.width && preference.width > 0
      ? Math.min(Math.round(preference.width), sourceWidth)
      : Math.round((requestedHeight * sourceWidth) / sourceHeight);
  const requestedWidth =
    rawRequestedWidth >= 16
      ? Math.max(16, Math.floor(rawRequestedWidth / 16) * 16)
      : rawRequestedWidth;
  const emergency = requestedHeight <= 480;
  let quality: SfuScreenSubscriptionTarget["quality"] = "high";
  if (sourceHeight > 1_080) {
    if (requestedHeight <= 720) quality = "low";
    else if (requestedHeight <= 1_080) quality = "medium";
  } else if (sourceHeight > 720) {
    if (requestedHeight <= 480) quality = "low";
    else if (requestedHeight <= 720) quality = "medium";
  } else if (requestedHeight < sourceHeight) {
    quality = "low";
  }
  return {
    width: Math.max(1, requestedWidth),
    height: requestedHeight,
    frameRate: Math.max(
      1,
      Math.min(
        Math.round(
          preference.frameRate || (emergency ? 24 : 30),
        ),
        emergency ? 24 : 30,
      ),
    ),
    quality,
    emergency,
  };
}
