export interface DesktopDanmakuContext {
  desktop: boolean;
  broadcasterId?: string;
}

export interface StageDanmakuContext extends DesktopDanmakuContext {
  enabled: boolean;
  appFocused?: boolean;
}

/**
 * Danmaku has two mutually exclusive presentation modes:
 *
 * - without a broadcast, a Windows member sees it across the desktop display;
 * - with a broadcast, it is attached to the local broadcast window or the
 *   in-app remote video surface.
 *
 * Voice membership is deliberately irrelevant. Chat and voice are independent
 * channel features, so requiring an active microphone session made messages
 * fall back into the empty in-app stage.
 */
export function shouldEnableDesktopDanmaku(
  context: DesktopDanmakuContext,
): boolean {
  return context.desktop && !context.broadcasterId;
}

/**
 * The channel stage is the fallback whenever the native desktop overlay is
 * not the active surface. This includes the broadcaster, who has to focus the
 * app while typing and therefore cannot see the foreground-window overlay.
 */
export function shouldRenderStageDanmaku(
  context: StageDanmakuContext,
): boolean {
  return (
    context.enabled &&
    (!shouldEnableDesktopDanmaku(context) || context.appFocused === true)
  );
}
