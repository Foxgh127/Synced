import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import type { SfuAccess } from "./sfu";
import protocolPolicy from "../server/protocol-policy.json";

export const SFU_VOICE_TRACK = "synced-voice";
const voicePolicy = protocolPolicy.voice;
const VOICE_SFU_CONNECT_TIMEOUT_MS = 12_000;
const VOICE_SFU_PUBLISH_TIMEOUT_MS = 8_000;
const VOICE_SFU_TEARDOWN_TIMEOUT_MS = 3_000;
const VOICE_SFU_REFRESH_WINDOW_MS = 5 * 60_000;

export interface VoiceSfuTrackEvent {
  participantId: string;
  track: MediaStreamTrack;
  stream: MediaStream;
}

export interface VoiceSfuSpeakingEvent {
  participantId: string;
  speaking: boolean;
  level: number;
}

function validAccess(value: SfuAccess | undefined): SfuAccess | undefined {
  if (
    !value ||
    typeof value.url !== "string" ||
    typeof value.room !== "string" ||
    typeof value.token !== "string"
  ) {
    return undefined;
  }
  try {
    const url = new URL(value.url);
    const localDevelopmentHost = new Set([
      "localhost",
      "127.0.0.1",
      "::1",
      "[::1]",
    ]).has(url.hostname.toLowerCase());
    if (
      url.protocol !== "wss:" &&
      !(url.protocol === "ws:" && localDevelopmentHost)
    ) {
      return undefined;
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^[A-Za-z0-9._~-]{1,256}$/u.test(value.room) ||
      value.token.length < 64 ||
      value.token.length > 4_096 ||
      value.token.split(".").length !== 3 ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() + 30_000
    ) {
      return undefined;
    }
    return { ...value, url: url.toString().replace(/\/$/u, "") };
  } catch {
    return undefined;
  }
}

async function deadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  let timeout: number | undefined;
  let abort: (() => void) | undefined;
  try {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException(message, "AbortError");
    }
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error(message)),
          timeoutMs,
        );
      }),
      new Promise<never>((_, reject) => {
        if (!signal) return;
        abort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException(message, "AbortError"),
          );
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export class VoiceSfuSession extends EventTarget {
  private room?: Room;
  private access?: SfuAccess;
  private publication?: LocalTrackPublication;
  private publicationProfile?: string;
  private readonly remoteTracks = new Map<string, MediaStreamTrack>();
  private readonly activeSpeakers = new Set<string>();
  private intentionalDisconnect = false;
  private sessionGeneration = 0;
  private publicationTail: Promise<void> = Promise.resolve();

  get connected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }

  async connect(
    input: SfuAccess | undefined,
    iceServers: RTCIceServer[] = [],
    signal?: AbortSignal,
  ): Promise<void> {
    const access = validAccess(input);
    if (!access) throw new Error("语音 SFU 凭据无效或已经过期");
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("语音 SFU 连接已取消", "AbortError");
    }
    if (
      this.connected &&
      this.access?.url === access.url &&
      this.access.room === access.room
    ) {
      if (
        this.access.expiresAt >
        Date.now() + VOICE_SFU_REFRESH_WINDOW_MS
      ) {
        return;
      }
      // LiveKit authenticates the WebSocket with the token used for the
      // existing connection. Reconnect with the refreshed token instead of
      // merely replacing the local metadata and leaving a stale session.
    }
    const generation = ++this.sessionGeneration;
    await this.disconnectCurrent();
    if (generation !== this.sessionGeneration || signal?.aborted) {
      throw signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("语音 SFU 会话已被替换", "AbortError");
    }
    this.intentionalDisconnect = false;
    this.access = access;
    const room = new Room({
      adaptiveStream: false,
      dynacast: true,
      disconnectOnPageLeave: true,
      stopLocalTrackOnUnpublish: false,
      publishDefaults: {
        dtx: true,
        red: true,
        forceStereo: false,
        audioPreset: {
          maxBitrate: voicePolicy.speechBitrateBps.onePeer,
          priority: "high",
        },
      },
    });
    this.room = room;
    room.on(
      RoomEvent.TrackSubscribed,
      (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (
          this.room !== room ||
          track.kind !== Track.Kind.Audio ||
          publication.trackName !== SFU_VOICE_TRACK
        ) {
          return;
        }
        const mediaTrack = track.mediaStreamTrack;
        this.remoteTracks.set(participant.identity, mediaTrack);
        this.dispatchEvent(
          new CustomEvent<VoiceSfuTrackEvent>("track", {
            detail: {
              participantId: participant.identity,
              track: mediaTrack,
              stream: new MediaStream([mediaTrack]),
            },
          }),
        );
      },
    );
    room.on(
      RoomEvent.TrackUnsubscribed,
      (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (
          publication.trackName === SFU_VOICE_TRACK &&
          this.remoteTracks.get(participant.identity) ===
            track.mediaStreamTrack
        ) {
          this.removeRemoteTrack(participant.identity);
        }
      },
    );
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.removeRemoteTrack(participant.identity);
      this.updateSpeaker(participant.identity, false, 0);
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (this.room !== room) return;
      const next = new Set(
        speakers
          .map((participant) => participant.identity)
          .filter((identity) => identity && identity !== room.localParticipant.identity),
      );
      for (const participantId of [...this.activeSpeakers]) {
        if (!next.has(participantId)) {
          this.updateSpeaker(participantId, false, 0);
        }
      }
      for (const participant of speakers) {
        if (
          participant.identity &&
          participant.identity !== room.localParticipant.identity
        ) {
          this.updateSpeaker(
            participant.identity,
            true,
            Number(participant.audioLevel) || 0,
          );
        }
      }
    });
    room.on(RoomEvent.Reconnecting, () => {
      if (this.room === room) this.emitState("reconnecting");
    });
    room.on(RoomEvent.Reconnected, () => {
      if (this.room === room) this.emitState("connected");
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room || this.intentionalDisconnect) return;
      this.clearRemoteTracks();
      this.emitState("disconnected");
    });
    const connecting = room.connect(access.url, access.token, {
      autoSubscribe: true,
      maxRetries: 2,
      peerConnectionTimeout: 8_000,
      websocketTimeout: 8_000,
      ...(iceServers.length
        ? {
            rtcConfig: {
              iceServers,
              iceCandidatePoolSize: 1,
            },
          }
        : {}),
    });
    try {
      await deadline(
        connecting,
        VOICE_SFU_CONNECT_TIMEOUT_MS,
        "连接语音 SFU 超时",
        signal,
      );
      if (
        this.room !== room ||
        generation !== this.sessionGeneration ||
        signal?.aborted
      ) {
        throw new DOMException("语音 SFU 会话已被替换", "AbortError");
      }
      this.emitState("connected");
    } catch (error) {
      if (
        this.room === room &&
        generation === this.sessionGeneration
      ) {
        this.intentionalDisconnect = true;
        this.room = undefined;
        this.access = undefined;
      }
      await deadline(
        room.disconnect(false),
        VOICE_SFU_TEARDOWN_TIMEOUT_MS,
        "清理语音 SFU 连接超时",
      ).catch(() => undefined);
      throw error;
    }
  }

  async publish(
    mediaTrack: MediaStreamTrack,
    bitrate = voicePolicy.speechBitrateBps.onePeer,
    music = false,
    signal?: AbortSignal,
  ): Promise<void> {
    const generation = this.sessionGeneration;
    const operation = this.publicationTail.then(() => {
      if (generation !== this.sessionGeneration) {
        throw new DOMException("语音 SFU 发布已被替换", "AbortError");
      }
      return this.publishNow(mediaTrack, bitrate, music, signal);
    });
    this.publicationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  private async publishNow(
    mediaTrack: MediaStreamTrack,
    bitrate: number,
    music: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const room = this.room;
    const generation = this.sessionGeneration;
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("语音 SFU 发布已取消", "AbortError");
    }
    if (!room || !this.connected) throw new Error("语音 SFU 尚未连接");
    if (mediaTrack.kind !== "audio" || mediaTrack.readyState !== "live") {
      throw new Error("语音 SFU 发送音轨不可用");
    }
    const normalizedBitrate = Math.max(
      voicePolicy.minimumAdaptiveBitrateBps,
      Math.min(voicePolicy.maximumAdaptiveBitrateBps, bitrate),
    );
    const profile = `${normalizedBitrate}:${music ? "music" : "speech"}`;
    const localTrack = this.publication?.track;
    if (localTrack && this.publicationProfile === profile) {
      if (localTrack.mediaStreamTrack !== mediaTrack) {
        try {
          await deadline(
            localTrack.replaceTrack(mediaTrack, false),
            VOICE_SFU_PUBLISH_TIMEOUT_MS,
            "替换语音 SFU 音轨超时",
            signal,
          );
        } catch (error) {
          // replaceTrack itself is not cancellable. Tear down the owning
          // room so a late completion cannot replace audio in a newer state.
          if (
            room === this.room &&
            generation === this.sessionGeneration
          ) {
            await this.disconnect();
          }
          throw error;
        }
      }
      if (
        room !== this.room ||
        generation !== this.sessionGeneration ||
        signal?.aborted
      ) {
        throw new DOMException("语音 SFU 发布已被替换", "AbortError");
      }
      return;
    }
    if (localTrack) {
      await this.unpublishNow();
    }
    if (
      room !== this.room ||
      generation !== this.sessionGeneration ||
      signal?.aborted
    ) {
      throw new DOMException("语音 SFU 发布已被替换", "AbortError");
    }
    const publishing = room.localParticipant.publishTrack(mediaTrack, {
      name: SFU_VOICE_TRACK,
      source: Track.Source.Microphone,
      dtx: !music,
      red: true,
      forceStereo: music,
      audioPreset: {
        maxBitrate: normalizedBitrate,
        priority: "high",
      },
    });
    let publication: LocalTrackPublication;
    try {
      publication = await deadline(
        publishing,
        VOICE_SFU_PUBLISH_TIMEOUT_MS,
        "发布语音 SFU 音轨超时",
        signal,
      );
    } catch (error) {
      void publishing
        .then((latePublication) => {
          const lateTrack = latePublication.track;
          return lateTrack
            ? room.localParticipant.unpublishTrack(lateTrack, false)
            : undefined;
        })
        .catch(() => undefined);
      throw error;
    }
    if (
      room !== this.room ||
      generation !== this.sessionGeneration ||
      signal?.aborted
    ) {
      const expiredTrack = publication.track;
      if (expiredTrack) {
        await deadline(
          room.localParticipant.unpublishTrack(expiredTrack, false),
          VOICE_SFU_TEARDOWN_TIMEOUT_MS,
          "清理过期语音 SFU 发布超时",
        ).catch(() => undefined);
      }
      throw new DOMException("语音 SFU 发布已被替换", "AbortError");
    }
    this.publication = publication;
    this.publicationProfile = profile;
  }

  async unpublish(): Promise<void> {
    const generation = this.sessionGeneration;
    const operation = this.publicationTail.then(() => {
      if (generation !== this.sessionGeneration) return;
      return this.unpublishNow();
    });
    this.publicationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  private async unpublishNow(): Promise<void> {
    const room = this.room;
    const publication = this.publication;
    this.publication = undefined;
    this.publicationProfile = undefined;
    const track = publication?.track;
    if (!track || !room) return;
    await deadline(
      room.localParticipant.unpublishTrack(track, false),
      VOICE_SFU_TEARDOWN_TIMEOUT_MS,
      "停止语音 SFU 发布超时",
    ).catch(() => undefined);
  }

  async disconnect(): Promise<void> {
    this.sessionGeneration += 1;
    await this.disconnectCurrent();
  }

  private async disconnectCurrent(): Promise<void> {
    const room = this.room;
    const publication = this.publication;
    this.intentionalDisconnect = true;
    this.room = undefined;
    this.access = undefined;
    this.publication = undefined;
    this.publicationProfile = undefined;
    this.clearRemoteTracks();
    const track = publication?.track;
    if (track && room) {
      await deadline(
        room.localParticipant.unpublishTrack(track, false),
        VOICE_SFU_TEARDOWN_TIMEOUT_MS,
        "停止语音 SFU 发布超时",
      ).catch(() => undefined);
    }
    if (room) {
      await deadline(
        room.disconnect(false),
        VOICE_SFU_TEARDOWN_TIMEOUT_MS,
        "断开语音 SFU 超时",
      ).catch(() => undefined);
    }
  }

  private removeRemoteTrack(participantId: string): void {
    if (!this.remoteTracks.delete(participantId)) return;
    this.dispatchEvent(
      new CustomEvent<string>("trackremoved", {
        detail: participantId,
      }),
    );
  }

  private clearRemoteTracks(): void {
    for (const participantId of [...this.remoteTracks.keys()]) {
      this.removeRemoteTrack(participantId);
    }
    for (const participantId of [...this.activeSpeakers]) {
      this.updateSpeaker(participantId, false, 0);
    }
  }

  private updateSpeaker(
    participantId: string,
    speaking: boolean,
    level: number,
  ): void {
    if (!participantId) return;
    if (speaking) this.activeSpeakers.add(participantId);
    else this.activeSpeakers.delete(participantId);
    this.dispatchEvent(
      new CustomEvent<VoiceSfuSpeakingEvent>("speaking", {
        detail: {
          participantId,
          speaking,
          level: Math.max(0, Math.min(1, level)),
        },
      }),
    );
  }

  private emitState(
    state: "connected" | "reconnecting" | "disconnected",
  ): void {
    this.dispatchEvent(
      new CustomEvent<typeof state>("statechange", { detail: state }),
    );
  }
}
