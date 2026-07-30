export interface WatcherContinuityState {
  rejoined: boolean;
  previousSelfId?: string;
  nextSelfId?: string;
  previousBroadcasterId?: string;
  nextBroadcasterId?: string;
  peerState?: RTCPeerConnectionState;
  hasDecodedFrame: boolean;
}

export interface PlaybackLivenessState {
  mode: "screen" | "emby";
  now: number;
  peerState?: RTCPeerConnectionState;
  hostPaused?: boolean;
  transportProgressAt: number;
  presentationProgressAt: number;
  bufferedAhead?: number;
  recoveryStartedAt?: number;
}

export type PlaybackRecoveryAction = "none" | "repair" | "replace";

export interface EmbyPresentationSample {
  frameCounterAvailable: boolean;
  previousFrames?: number;
  currentFrames: number;
  previousTime: number;
  currentTime: number;
}

/**
 * Prefer frames actually presented by the decoder. MSE currentTime can jitter
 * or advance while a platform decoder is wedged, which previously made a
 * frozen Huawei decoder look healthy indefinitely.
 */
export function embyPresentationProgressed(
  sample: EmbyPresentationSample,
): boolean {
  if (sample.frameCounterAvailable) {
    return (
      Number.isFinite(sample.currentFrames) &&
      sample.currentFrames > Math.max(0, sample.previousFrames || 0)
    );
  }
  return (
    Number.isFinite(sample.currentTime) &&
    Number.isFinite(sample.previousTime) &&
    Math.abs(sample.currentTime - sample.previousTime) >= 0.12
  );
}

/**
 * Playback-state packets arrive frequently for clock synchronization. Only a
 * real pause/resume transition may refresh the liveness grace period.
 */
export function embyPauseStateChanged(state: {
  known: boolean;
  previousPaused: boolean;
  nextPaused: boolean;
}): boolean {
  return !state.known || state.previousPaused !== state.nextPaused;
}

/**
 * A repair is complete only when the clock which originally proved playback
 * was stuck is healthy again. Treating either RTP/DataChannel progress or a
 * rendered frame as success can permanently trap a live stream in the
 * repair-only phase: bytes keep arriving, the decoder stays frozen, and every
 * sample clears the replacement deadline before it can fire.
 */
export function playbackRecoveryCompleted(
  state: PlaybackLivenessState,
): boolean {
  if (!state.recoveryStartedAt) return false;
  const transportRecovered =
    state.transportProgressAt > state.recoveryStartedAt;
  const presentationRecovered =
    state.presentationProgressAt > state.recoveryStartedAt;
  if (state.mode === "screen") {
    return transportRecovered && presentationRecovered;
  }
  return (
    presentationRecovered &&
    (transportRecovered || (state.bufferedAhead || 0) >= 2.5)
  );
}

/**
 * A signaling reconnect is not a media failure. Keep an already decoded P2P
 * stream alive whenever the resumed channel identity and broadcaster still
 * match. A real route change can then prepare a replacement connection in the
 * background instead of clearing the visible video first.
 */
export function shouldPreserveActiveWatcher(
  state: WatcherContinuityState,
): boolean {
  return Boolean(
    state.rejoined &&
      state.previousSelfId &&
      state.previousSelfId === state.nextSelfId &&
      state.previousBroadcasterId &&
      state.previousBroadcasterId === state.nextBroadcasterId &&
      state.previousBroadcasterId !== state.previousSelfId &&
      state.peerState &&
      !["failed", "closed"].includes(state.peerState) &&
      state.hasDecodedFrame,
  );
}

/**
 * WebRTC can remain `connected` after the selected candidate pair or decoder
 * has stopped making progress. Connection-state listeners cannot see that
 * failure, so use independent transport and presentation clocks. Emby may
 * legitimately stop receiving while a large forward buffer drains, but an
 * unpaused player must keep presenting frames even while that happens.
 */
export function playbackRecoveryAction(
  state: PlaybackLivenessState,
): PlaybackRecoveryAction {
  if (
    state.peerState !== "connected" ||
    state.hostPaused ||
    state.now <= 0
  ) {
    return "none";
  }
  const transportAge = Math.max(0, state.now - state.transportProgressAt);
  const presentationAge = Math.max(
    0,
    state.now - state.presentationProgressAt,
  );
  // Screen sharing: tolerate up to 25 s without a new RTP packet and 30 s
  // without a rendered frame. These wider windows give an ICE restart (which
  // can take 8–12 s on TURN paths) enough time to complete before the
  // replacement phase fires — the previous 12 s / 8 s combination reliably
  // triggered a full connection rebuild while the restart was still in flight.
  // Emby: only track presentation progress; the DataChannel can buffer ahead
  // silently, so a 20 s frame freeze is the authoritative stall signal.
  const stalled =
    state.mode === "screen"
      ? transportAge >= 25_000 || presentationAge >= 30_000
      : presentationAge >= 20_000;
  if (!stalled) return "none";
  if (!state.recoveryStartedAt) return "repair";
  // Give the ICE restart 20 s to succeed. TURN paths on mobile LTE commonly
  // need 10–15 s; the old 8 s window guaranteed a replacement race condition.
  return state.now - state.recoveryStartedAt >= 20_000
    ? "replace"
    : "none";
}

/**
 * Emby can repair decoder/MSE holes from its fragment cache without replacing
 * a healthy ICE route. Restart ICE only when the data transport itself has
 * also stopped; renegotiating a busy TURN connection while bytes are flowing
 * creates the very stalls the recovery path is meant to remove.
 */
export function shouldRestartIceForPlaybackRepair(
  state: Pick<
    PlaybackLivenessState,
    "mode" | "now" | "peerState" | "transportProgressAt"
  >,
): boolean {
  if (state.mode === "screen") return true;
  if (state.peerState !== "connected") return true;
  // Only restart ICE when the DataChannel itself has gone quiet for 10 s.
  // The old 5 s threshold was shorter than typical SCTP retransmit cycles on
  // TURN paths, so it repeatedly tore down an otherwise-recovering channel.
  return Math.max(0, state.now - state.transportProgressAt) >= 10_000;
}

export function shouldReplaceWatcherForRouteAdvice(state: {
  peerState?: RTCPeerConnectionState;
  hasDecodedFrame: boolean;
}): boolean {
  // Route advice is a recommendation for the next negotiation, not evidence
  // that the selected ICE pair has failed. Never tear down decoded media just
  // because a periodic probe changed its preference.
  return (
    !state.hasDecodedFrame &&
    (state.peerState === "failed" || state.peerState === "closed")
  );
}
