import { SignalClient, type RoomParticipant, type SignalEnvelope } from "./rtc";
import { isNativeAndroid } from "./immersive";
import protocolPolicy from "../server/protocol-policy.json";
import { dialogController } from "./ui/dialog-controller";
import { FloatingSurface } from "./ui/floating-surface";
import { hydrateIcons } from "./ui/icons";
import { animateElement } from "./ui/motion-controller";
import { PresenceController } from "./ui/presence-controller";
import {
  VoiceMesh,
  type VoiceDevices,
  type VoiceDevicesChange,
  type VoiceNoiseMode,
  type VoiceSpeakingChange,
  type VoiceState,
} from "./voice";

const CHAT_MAX_LENGTH = 120;
const MAX_ROOM_PARTICIPANTS = protocolPolicy.maxParticipantsPerRoom;
const RECENT_EMOJI_KEY = "synced:recent-emojis";

const EMOJI_GROUPS = [
  {
    label: "常用",
    emojis: ["😊", "😂", "🥰", "😍", "🤩", "🥺", "😭", "🤣", "😆", "😇", "🥳", "🤗", "🤔", "😴", "😎", "😏", "🙄", "😤", "😱", "😬"],
  },
  {
    label: "手势",
    emojis: ["👍", "👎", "👏", "🙏", "🤝", "🫶", "🙌", "👌", "✌️", "🤞", "💪", "👀", "🫂", "💋", "👋", "🤙", "🫡", "🤌", "☝️", "💯"],
  },
  {
    label: "光影",
    emojis: ["🎬", "🍿", "📺", "🎞️", "🎥", "🎭", "🎵", "🎶", "🎧", "✨", "🔥", "💫", "🌟", "⭐", "🌙", "🌈", "🌌", "🪄", "💡", "🎉"],
  },
  {
    label: "心意",
    emojis: ["❤️", "🩷", "🧡", "💛", "💚", "🩵", "💙", "💜", "🤍", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "🌹", "🌸", "🍀", "☕"],
  },
] as const;

function emojiPickerMarkup(): string {
  return `
    <section class="emoji-group emoji-recent-group" id="emoji-recent-group" aria-label="最近使用" hidden>
      <h3>最近</h3>
      <div class="emoji-grid" id="emoji-recent-grid"></div>
    </section>
    ${EMOJI_GROUPS.map(
    ({ label, emojis }) => `
      <section class="emoji-group" aria-label="${label}">
        <h3>${label}</h3>
        <div class="emoji-grid">
          ${emojis
            .map(
              (emoji) =>
                `<button type="button" class="emoji-item" data-emoji="${emoji}" aria-label="${emoji}">${emoji}</button>`,
            )
            .join("")}
        </div>
      </section>`,
  ).join("")}`;
}

export function roomSidebarMarkup(): string {
  return `
    <aside id="room-companion-panel" class="room-sidebar companion-panel" aria-label="频道成员与弹幕">
      <section class="chat-card" id="chat-panel" tabindex="-1">
        <div class="panel-heading compact-heading">
          <div>
            <span class="panel-kicker">实时弹幕</span>
            <h2>弹幕聊天</h2>
          </div>
          <span id="danmaku-surface-state" class="danmaku-surface-state" hidden>光影交织，共此时光</span>
        </div>
        <div class="chat-log-shell">
          <div id="chat-log" class="chat-log" role="log" aria-live="polite"></div>
          <button id="chat-jump-latest" class="chat-jump-latest chat-unread-badge" type="button" hidden>
            <i data-lucide="arrow-down"></i>回到最新 <span id="chat-unread-count"></span>
          </button>
        </div>
        <form id="chat-form" class="chat-form">
          <div id="chat-emoji-panel" class="chat-emoji-panel material-regular" hidden role="dialog" aria-label="表情选择">
            <header class="emoji-panel-header">
              <strong>选一个心情</strong>
              <span>最近使用会留在最前面</span>
            </header>
            <div class="emoji-groups">${emojiPickerMarkup()}</div>
          </div>
          <input id="chat-input" maxlength="${CHAT_MAX_LENGTH}" autocomplete="off" placeholder="发送弹幕…" aria-label="弹幕内容" />
          <button id="chat-emoji-toggle" class="chat-emoji-btn" type="button" aria-label="打开表情菜单" aria-controls="chat-emoji-panel" aria-expanded="false">
            <i data-lucide="smile"></i>
          </button>
          <button type="submit" class="chat-send-btn" aria-label="发送弹幕"><i data-lucide="send"></i><span>发送</span></button>
        </form>
      </section>
      <section class="voice-card" id="member-panel" tabindex="-1">
        <div class="voice-card-header">
          <div class="voice-card-title">
            <span class="voice-status-dot" id="voice-status-dot" aria-hidden="true"></span>
            <h2>连麦频道</h2>
          </div>
          <div class="voice-card-meta">
            <span id="member-count" class="member-count-badge tnum">1 / ${MAX_ROOM_PARTICIPANTS}</span>
            <button id="voice-settings-toggle" class="voice-settings-btn" type="button"
                    aria-label="打开连麦设备设置" aria-expanded="false"
                    aria-controls="voice-device-panel" title="连麦设置">
              <i data-lucide="settings"></i>
            </button>
          </div>
        </div>
        <div id="participant-list" class="participant-list"></div>
        <div class="voice-join-area">
          <button id="voice-button" class="voice-join-btn" type="button">
            <span class="voice-join-icon">
              <i data-lucide="mic"></i>
            </span>
            <span class="voice-join-label">加入连麦</span>
          </button>
          <button id="mute-button" class="mute-btn" type="button" disabled aria-label="静音">
            <i data-lucide="mic-off"></i>
          </button>
        </div>
        <div id="voice-device-panel" class="voice-device-panel material-regular" hidden
             role="dialog" aria-label="连麦设备设置">
          <header><strong>连麦设备</strong><small>更改只影响本次连麦</small></header>
          <label>
            <span>麦克风</span>
            <select id="voice-input-device" aria-label="选择麦克风">
              <option value="default">系统默认麦克风</option>
            </select>
          </label>
          <label>
            <span>扬声器</span>
            <select id="voice-output-device" aria-label="选择扬声器">
              <option value="default">系统默认扬声器</option>
            </select>
          </label>
          <label class="voice-noise-control">
            <span>降噪</span>
            <select id="voice-noise-mode" aria-label="选择麦克风降噪强度">
              <option value="natural">自然降噪 · 保留真实质感</option>
              <option value="clear">清晰人声 · 通话推荐</option>
              <option value="strong">强力消噪 · 高噪环境</option>
            </select>
          </label>
          <label class="voice-volume-control">
            <span>连麦音量 <b id="voice-volume-value">100%</b></span>
            <input id="voice-volume" type="range" min="0" max="200" value="100" aria-label="连麦总播放音量" />
          </label>
          <div class="voice-device-actions">
            <button id="test-voice-input" class="ghost-button" type="button">测试麦克风</button>
            <button id="refresh-voice-devices" class="device-refresh-button" type="button">
              <i data-lucide="refresh-cw"></i>刷新设备
            </button>
          </div>
        </div>
      </section>
      <div id="voice-audio" hidden></div>
    </aside>
  `;
}

export class RoomCompanion {
  private readonly participants = new Map<string, RoomParticipant>();
  private readonly speakingParticipants = new Set<string>();
  private readonly speakingLevels = new Map<string, number>();
  private readonly sharedAudioSenders = new Set<string>();
  private expandedParticipantId?: string;
  private readonly voice: VoiceMesh;
  private readonly uiAbortController = new AbortController();
  private emojiSurface?: FloatingSurface;
  private deviceSettingsPresence?: PresenceController;
  private microphoneTestAbort?: AbortController;
  private destroyed = false;
  private deviceRefreshSequence = 0;
  private chatUnreadCount = 0;
  private reportedVoiceActive: boolean | undefined;
  private readonly handleVoiceStateChange = (event: Event): void => {
    if (this.destroyed) return;
    this.renderVoiceState((event as CustomEvent<VoiceState>).detail);
  };
  private readonly handleVoicePlaybackError = (event: Event): void => {
    if (this.destroyed) return;
    this.notify((event as CustomEvent<string>).detail, true);
  };
  private readonly handleVoiceDevicesChange = (event: Event): void => {
    if (this.destroyed) return;
    this.deviceRefreshSequence += 1;
    const detail = (event as CustomEvent<VoiceDevicesChange>).detail;
    this.renderVoiceDevices(detail.devices);
    const refresh = document.querySelector<HTMLButtonElement>(
      "#refresh-voice-devices",
    );
    if (refresh) refresh.disabled = false;
    this.notifyDeviceFallback(detail);
    if (!detail.inputFallback && !detail.outputFallback) {
      this.notify("检测到音频设备变化，设备列表已自动刷新");
    }
  };
  private readonly handleVoiceDeviceError = (event: Event): void => {
    if (this.destroyed) return;
    this.notify((event as CustomEvent<string>).detail, true);
  };
  private readonly handleVoiceSpeakingChange = (event: Event): void => {
    if (this.destroyed) return;
    const detail = (event as CustomEvent<VoiceSpeakingChange>).detail;
    const participant = this.participants.get(detail.participantId);
    const speaking =
      detail.speaking &&
      Boolean(participant?.voiceActive) &&
      !participant?.microphoneMuted &&
      !participant?.microphoneDisabled;
    if (speaking) {
      this.speakingParticipants.add(detail.participantId);
      this.speakingLevels.set(detail.participantId, detail.level);
    } else {
      this.speakingParticipants.delete(detail.participantId);
      this.speakingLevels.delete(detail.participantId);
    }
    this.applyParticipantSpeaking(
      detail.participantId,
      speaking,
      detail.level,
    );
    this.reportParticipantVisualState();
  };

  constructor(
    private readonly signal: SignalClient,
    private readonly selfId: string,
    iceServers: RTCIceServer[],
    initialParticipants: RoomParticipant[],
    private readonly notify: (message: string, error?: boolean) => void,
    private readonly onDanmaku?: (
      nickname: string,
      text: string,
      mine: boolean,
    ) => void,
    private readonly onVoiceActiveChange?: (
      active: boolean,
      count: number,
    ) => void,
    private readonly onParticipantVisualStateChange?: (
      participants: RoomParticipant[],
      speakingLevels: ReadonlyMap<string, number>,
    ) => void,
  ) {
    for (const participant of initialParticipants) {
      this.participants.set(participant.id, participant);
    }
    const audioContainer = document.querySelector<HTMLElement>("#voice-audio");
    if (!audioContainer) {
      throw new Error("连麦界面尚未准备好");
    }
    this.voice = new VoiceMesh(signal, selfId, iceServers, audioContainer);
    this.voice.setMicrophoneDisabled(
      Boolean(this.participants.get(selfId)?.microphoneDisabled),
    );
    this.voice.addEventListener("statechange", this.handleVoiceStateChange);
    this.voice.addEventListener(
      "playbackerror",
      this.handleVoicePlaybackError,
    );
    this.voice.addEventListener(
      "connectionerror",
      this.handleVoicePlaybackError,
    );
    this.voice.addEventListener(
      "deviceschange",
      this.handleVoiceDevicesChange,
    );
    this.voice.addEventListener("deviceerror", this.handleVoiceDeviceError);
    this.voice.addEventListener(
      "speakingchange",
      this.handleVoiceSpeakingChange,
    );
    this.mount();
  }

  async handle(message: SignalEnvelope): Promise<boolean> {
    if (this.destroyed) {
      return false;
    }
    if (message.type === "participant:joined" && message.participant) {
      this.participants.set(message.participant.id, message.participant);
      this.renderParticipants();
      return true;
    }
    if (message.type === "participant:left" && message.participantId) {
      this.participants.delete(message.participantId);
      this.sharedAudioSenders.delete(message.participantId);
      if (!this.sharedAudioSenders.size) {
        await this.voice.stopSharedAudioListener();
      }
      this.speakingParticipants.delete(message.participantId);
      this.speakingLevels.delete(message.participantId);
      if (this.expandedParticipantId === message.participantId) {
        this.expandedParticipantId = undefined;
      }
      this.renderParticipants();
      return true;
    }
    if (
      message.type === "voice:music" &&
      message.senderId &&
      message.senderId !== this.selfId
    ) {
      if (message.active === true) {
        this.sharedAudioSenders.add(message.senderId);
        try {
          await this.voice.listenForSharedAudio();
          this.notify(
            `${message.nickname || "频道成员"}开始共享伴奏，已自动接入收听`,
          );
        } catch (error) {
          this.notify(
            error instanceof Error
              ? `共享伴奏接入失败：${error.message}`
              : "共享伴奏接入失败",
            true,
          );
        }
      } else {
        this.sharedAudioSenders.delete(message.senderId);
        if (!this.sharedAudioSenders.size) {
          await this.voice.stopSharedAudioListener();
        }
      }
      return true;
    }
    if (message.type === "participant:updated" && message.participant) {
      this.participants.set(message.participant.id, message.participant);
      if (
        !message.participant.voiceActive ||
        message.participant.microphoneMuted ||
        message.participant.microphoneDisabled
      ) {
        this.speakingParticipants.delete(message.participant.id);
        this.speakingLevels.delete(message.participant.id);
      }
      if (message.participant.id === this.selfId) {
        this.voice.setMicrophoneDisabled(
          Boolean(message.participant.microphoneDisabled),
        );
      }
      this.voice.syncActiveParticipants([...this.participants.values()]);
      this.renderParticipants();
      return true;
    }
    if (message.type === "broadcast:started" && message.broadcasterId) {
      for (const participant of this.participants.values()) {
        participant.broadcasting = participant.id === message.broadcasterId;
      }
      this.renderParticipants();
    }
    if (message.type === "broadcast:stopped") {
      for (const participant of this.participants.values()) {
        participant.broadcasting = false;
      }
      this.renderParticipants();
    }
    if (message.type === "voice:joined" && message.participant) {
      this.participants.set(message.participant.id, message.participant);
      this.renderParticipants();
    }
    if (message.type === "voice:left" && message.participantId) {
      this.speakingParticipants.delete(message.participantId);
      this.speakingLevels.delete(message.participantId);
      const participant = this.participants.get(message.participantId);
      if (participant) {
        participant.voiceActive = false;
        this.participants.set(participant.id, participant);
      }
      this.renderParticipants();
    }
    if (message.type === "moderation:microphone") {
      const disabled = message.disabled === true;
      this.voice.setMicrophoneDisabled(disabled);
      this.notify(
        disabled
          ? "频道主已关闭你的麦克风，你仍可听见大家说话"
          : "频道主已允许你开麦；需要时请点击“开启麦克风”",
        disabled,
      );
      return true;
    }
    if (message.type === "chat:message" && message.text && message.nickname) {
      const mine = message.senderId === this.selfId;
      this.appendChat(message.nickname, message.text, mine, message.sentAt);
      this.onDanmaku?.(message.nickname, message.text, mine);
      return true;
    }
    return this.voice.handle(message);
  }

  syncParticipants(nextParticipants: RoomParticipant[]): void {
    if (this.destroyed) return;
    this.participants.clear();
    for (const participant of nextParticipants) {
      this.participants.set(participant.id, participant);
    }
    for (const participantId of [...this.speakingParticipants]) {
      if (!this.participants.has(participantId)) {
        this.speakingParticipants.delete(participantId);
        this.speakingLevels.delete(participantId);
      }
    }
    const self = this.participants.get(this.selfId);
    this.voice.setMicrophoneDisabled(Boolean(self?.microphoneDisabled));
    this.voice.syncActiveParticipants(nextParticipants);
    this.renderParticipants();
  }

  sendChat(rawText: string): boolean {
    const text = rawText.trim();
    if (!text) return false;
    if (text.length > CHAT_MAX_LENGTH) {
      this.notify(`弹幕最多可输入 ${CHAT_MAX_LENGTH} 个字符`);
      return false;
    }
    try {
      this.signal.send({ type: "chat:send", text });
      return true;
    } catch {
      this.notify("弹幕发送失败，服务器连接可能已断开", true);
      return false;
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.reportedVoiceActive !== false) {
      this.reportedVoiceActive = false;
      this.onVoiceActiveChange?.(false, 0);
    }
    this.destroyed = true;
    this.uiAbortController.abort();
    this.emojiSurface?.destroy();
    this.deviceSettingsPresence?.cancel();
    this.microphoneTestAbort?.abort();
    this.voice.removeEventListener(
      "statechange",
      this.handleVoiceStateChange,
    );
    this.voice.removeEventListener(
      "playbackerror",
      this.handleVoicePlaybackError,
    );
    this.voice.removeEventListener(
      "connectionerror",
      this.handleVoicePlaybackError,
    );
    this.voice.removeEventListener(
      "deviceschange",
      this.handleVoiceDevicesChange,
    );
    this.voice.removeEventListener("deviceerror", this.handleVoiceDeviceError);
    this.voice.removeEventListener(
      "speakingchange",
      this.handleVoiceSpeakingChange,
    );
    await this.voice.destroy();
  }

  get voiceActive(): boolean {
    return this.voice.state.active;
  }

  async resumeVoice(): Promise<void> {
    if (
      this.destroyed ||
      (this.voice.state.active && !this.voice.state.listeningOnly)
    ) {
      return;
    }
    await this.voice.join();
    await this.refreshVoiceDevices();
    const self = this.participants.get(this.selfId);
    if (self) {
      self.voiceActive = true;
      this.renderParticipants();
    }
  }

  get accompanimentActive(): boolean {
    return this.voice.accompanimentActive;
  }

  setAccompanimentTrack(track: MediaStreamTrack, volume: number): void {
    if (this.destroyed) {
      throw new Error("频道语音已经关闭");
    }
    this.voice.setAccompanimentTrack(track, volume);
  }

  setAccompanimentVolume(volume: number): void {
    if (this.destroyed) return;
    this.voice.setAccompanimentVolume(volume);
  }

  clearAccompaniment(): void {
    if (this.destroyed) return;
    this.voice.clearAccompaniment();
  }

  setBroadcaster(participantId?: string): void {
    for (const participant of this.participants.values()) {
      participant.broadcasting = participant.id === participantId;
    }
    this.renderParticipants();
  }

  updateIceServers(iceServers: RTCIceServer[]): void {
    if (this.destroyed) return;
    this.voice.updateIceServers(iceServers);
  }

  private mount(): void {
    const listenerOptions = { signal: this.uiAbortController.signal };
    this.renderParticipants();
    this.renderVoiceState(this.voice.state);
    const chatLog = document.querySelector<HTMLElement>("#chat-log");
    chatLog?.addEventListener(
      "scroll",
      () => {
        if (this.isChatNearBottom(chatLog)) {
          this.clearChatUnread();
        }
      },
      listenerOptions,
    );
    document
      .querySelector<HTMLButtonElement>("#chat-jump-latest")
      ?.addEventListener(
        "click",
        () => {
          if (chatLog) chatLog.scrollTop = chatLog.scrollHeight;
          this.clearChatUnread();
        },
        listenerOptions,
      );
    const emojiToggle =
      document.querySelector<HTMLButtonElement>("#chat-emoji-toggle");
    const emojiPanel =
      document.querySelector<HTMLDivElement>("#chat-emoji-panel");
    const chatInput = document.querySelector<HTMLInputElement>("#chat-input");
    this.renderRecentEmojis();
    if (emojiToggle && emojiPanel) {
      this.emojiSurface = new FloatingSurface(emojiToggle, emojiPanel, {
        placement: "top-end",
        closeOnOutside: true,
      });
      emojiToggle.addEventListener(
        "click",
        () => void this.emojiSurface?.toggle(),
        listenerOptions,
      );
    }
    emojiPanel?.addEventListener("click", (event) => {
      const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(".emoji-item");
      if (!btn || !chatInput) return;
      const emoji = btn.dataset.emoji ?? "";
      const selectionStart =
        chatInput.selectionStart ?? chatInput.value.length;
      const selectionEnd = chatInput.selectionEnd ?? selectionStart;
      const candidate =
        chatInput.value.slice(0, selectionStart) +
        emoji +
        chatInput.value.slice(selectionEnd);
      if (chatInput.maxLength > 0 && candidate.length > chatInput.maxLength) {
        this.notify(`弹幕最多可输入 ${chatInput.maxLength} 个字符`);
        chatInput.focus();
        return;
      }
      chatInput.value = candidate;
      const nextPosition = selectionStart + emoji.length;
      chatInput.setSelectionRange(nextPosition, nextPosition);
      chatInput.focus();
      this.rememberEmoji(emoji);
      void this.emojiSurface?.close();
    }, listenerOptions);
    const deviceButton =
      document.querySelector<HTMLButtonElement>("#voice-settings-toggle");
    const devicePanel =
      document.querySelector<HTMLElement>("#voice-device-panel");
    if (deviceButton && devicePanel) {
      this.deviceSettingsPresence = new PresenceController(devicePanel, {
        enter: [
          {
            opacity: 0,
            transform: "translateY(-10px) scale(0.975)",
          },
          {
            opacity: 1,
            transform: "translateY(0) scale(1.012)",
            offset: 0.72,
          },
          { opacity: 1, transform: "none" },
        ],
        exit: [
          { opacity: 1, transform: "none" },
          {
            opacity: 0,
            transform: "translateY(-6px) scale(0.985)",
          },
        ],
      });
      let deviceSettingsOperation = 0;
      const setDevicePanelOpen = async (open: boolean): Promise<void> => {
        const operation = ++deviceSettingsOperation;
        deviceButton.classList.toggle("active", open);
        deviceButton.setAttribute("aria-expanded", String(open));
        deviceButton.setAttribute(
          "aria-label",
          open ? "关闭连麦设备设置" : "打开连麦设备设置",
        );
        if (open) {
          devicePanel.classList.add("voice-settings-visible");
          void this.refreshVoiceDevices();
          const shown = await this.deviceSettingsPresence?.show(
            this.uiAbortController.signal,
          );
          if (
            !shown ||
            operation !== deviceSettingsOperation ||
            this.destroyed
          ) {
            return;
          }
          devicePanel
            .querySelector<HTMLElement>("select, input, button")
            ?.focus();
          return;
        }
        const hidden = await this.deviceSettingsPresence?.hide(
          this.uiAbortController.signal,
        );
        if (
          !hidden ||
          operation !== deviceSettingsOperation ||
          this.destroyed
        ) {
          return;
        }
        devicePanel.classList.remove("voice-settings-visible");
      };
      deviceButton.addEventListener(
        "click",
        () => {
          void setDevicePanelOpen(
            deviceButton.getAttribute("aria-expanded") !== "true",
          );
        },
        listenerOptions,
      );
      document.addEventListener(
        "keydown",
        (event) => {
          if (
            event.key !== "Escape" ||
            deviceButton.getAttribute("aria-expanded") !== "true"
          ) {
            return;
          }
          void setDevicePanelOpen(false);
          deviceButton.focus();
        },
        listenerOptions,
      );
    }
    document
      .querySelector("#voice-button")
      ?.addEventListener(
        "click",
        async () => {
          const button =
            document.querySelector<HTMLButtonElement>("#voice-button");
          if (!button || button.disabled) {
            return;
          }
          button.disabled = true;
          try {
            if (
              this.voice.state.active &&
              !this.voice.state.listeningOnly
            ) {
              await this.voice.leave();
            } else {
              await this.voice.join();
              await this.refreshVoiceDevices();
              const self = this.participants.get(this.selfId);
              if (self) {
                self.voiceActive = true;
                this.renderParticipants();
              }
            }
          } catch (error) {
            this.notify(
              error instanceof Error ? error.message : "无法加入连麦",
              true,
            );
          } finally {
            button.disabled = false;
          }
        },
        listenerOptions,
      );
    document
      .querySelector("#mute-button")
      ?.addEventListener(
        "click",
        () => {
          this.voice.toggleMute();
        },
        listenerOptions,
      );
    document
      .querySelector<HTMLSelectElement>("#voice-input-device")
      ?.addEventListener(
        "change",
        async (event) => {
          const select = event.currentTarget as HTMLSelectElement;
          select.disabled = true;
          try {
            await this.voice.setInputDevice(select.value);
            await this.refreshVoiceDevices();
            this.notify("麦克风已切换");
          } catch (error) {
            this.notify(
              error instanceof Error ? error.message : "无法切换麦克风",
              true,
            );
            await this.refreshVoiceDevices();
          } finally {
            if (select.isConnected) select.disabled = false;
          }
        },
        listenerOptions,
      );
    document
      .querySelector<HTMLSelectElement>("#voice-output-device")
      ?.addEventListener(
        "change",
        async (event) => {
          const select = event.currentTarget as HTMLSelectElement;
          select.disabled = true;
          try {
            await this.voice.setOutputDevice(select.value);
            this.notify("连麦播放设备已切换");
          } catch (error) {
            this.notify(
              error instanceof Error ? error.message : "无法切换扬声器",
              true,
            );
            await this.refreshVoiceDevices();
          } finally {
            if (select.isConnected) select.disabled = false;
          }
        },
        listenerOptions,
      );
    document
      .querySelector<HTMLSelectElement>("#voice-noise-mode")
      ?.addEventListener(
        "change",
        async (event) => {
          const select = event.currentTarget as HTMLSelectElement;
          select.disabled = true;
          try {
            await this.voice.setNoiseMode(
              select.value as VoiceNoiseMode,
            );
            this.notify("麦克风降噪模式已切换");
          } catch (error) {
            this.notify(
              error instanceof Error ? error.message : "无法切换降噪模式",
              true,
            );
            select.value = this.voice.state.noiseMode;
          } finally {
            if (select.isConnected) select.disabled = false;
          }
        },
        listenerOptions,
      );
    document
      .querySelector<HTMLInputElement>("#voice-volume")
      ?.addEventListener(
        "input",
        (event) => {
          const value = Number(
            (event.currentTarget as HTMLInputElement).value,
          );
          this.voice.setVolume(value / 100);
        },
        listenerOptions,
      );
    document
      .querySelector("#participant-list")
      ?.addEventListener(
        "click",
        (event) => void this.handleParticipantClick(event),
        listenerOptions,
      );
    document
      .querySelector("#participant-list")
      ?.addEventListener(
        "input",
        (event) => {
          const input = event.target;
          if (
            !(input instanceof HTMLInputElement) ||
            !input.dataset.peerVolume
          ) {
            return;
          }
          const value = Math.min(200, Math.max(0, Number(input.value)));
          this.voice.setPeerVolume(input.dataset.peerVolume, value / 100);
          const valueLabel = input
            .closest(".participant-volume-control")
            ?.querySelector<HTMLElement>("[data-peer-volume-value]");
          if (valueLabel) {
            valueLabel.textContent = `${Math.round(value)}%`;
          }
        },
        listenerOptions,
      );
    document
      .querySelector("#refresh-voice-devices")
      ?.addEventListener(
        "click",
        () => void this.refreshVoiceDevices(true),
        listenerOptions,
      );
    document
      .querySelector("#test-voice-input")
      ?.addEventListener(
        "click",
        () => void this.testMicrophone(),
        listenerOptions,
      );
    document
      .querySelector<HTMLFormElement>("#chat-form")
      ?.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          const input =
            document.querySelector<HTMLInputElement>("#chat-input");
          if (this.sendChat(input?.value || "") && input) {
            input.value = "";
            if (!isNativeAndroid()) input.focus();
          }
        },
        listenerOptions,
      );
    void this.refreshVoiceDevices();
  }

  private renderParticipants(): void {
    const list = document.querySelector<HTMLElement>("#participant-list");
    if (!list) {
      return;
    }
    const existingRows = new Map(
      [...list.querySelectorAll<HTMLElement>(":scope > .participant-row")]
        .filter((row) => Boolean(row.dataset.participantId))
        .map((row) => [row.dataset.participantId as string, row]),
    );
    let insertionPoint = list.firstElementChild;
    const sorted = [...this.participants.values()].sort((left, right) => {
      if (left.role !== right.role) {
        return left.role === "host" ? -1 : 1;
      }
      return left.nickname.localeCompare(right.nickname, "zh-CN");
    });
    this.onVoiceActiveChange?.(
      this.voice.state.active,
      sorted.filter((participant) => participant.voiceActive).length,
    );
    const selfIsHost =
      this.participants.get(this.selfId)?.role === "host";
    for (const participant of sorted) {
      const speaking = this.speakingParticipants.has(participant.id);
      const speakingLevel = this.speakingLevels.get(participant.id) || 0;
      const canAdjustVolume =
        participant.id !== this.selfId && participant.voiceActive;
      const canModerate =
        selfIsHost && participant.id !== this.selfId;
      const canExpand = canAdjustVolume || canModerate;
      const expanded =
        canExpand && this.expandedParticipantId === participant.id;
      const structureKey = [
        canExpand,
        expanded,
        canAdjustVolume,
        canModerate,
        participant.broadcasting,
      ].join(":");
      const previousRow = existingRows.get(participant.id);
      let row = previousRow;
      if (!row || row.dataset.structureKey !== structureKey) {
        row = document.createElement("div");
        row.className = "participant-row";
        row.dataset.participantId = participant.id;
        row.dataset.structureKey = structureKey;
        const summary = document.createElement(
          canExpand ? "button" : "div",
        );
        summary.className = "participant-summary";
        if (summary instanceof HTMLButtonElement) {
          summary.type = "button";
          summary.dataset.participantToggle = participant.id;
        }
        const avatar = document.createElement("span");
        avatar.className = "participant-avatar";
        avatar.textContent = Array.from(participant.nickname)[0] || "友";
        const waveform = document.createElement("span");
        waveform.className = "voice-waveform";
        waveform.setAttribute("aria-hidden", "true");
        for (let b = 0; b < 4; b++) {
          waveform.appendChild(document.createElement("i"));
        }
        avatar.appendChild(waveform);
        const copy = document.createElement("span");
        copy.className = "participant-copy";
        const name = document.createElement("strong");
        const role = document.createElement("small");
        role.dataset.participantRole = participant.id;
        copy.append(name, role);
        const mic = document.createElement("span");
        mic.className = "participant-mic";
        mic.dataset.participantMic = participant.id;
        summary.append(avatar, copy, mic);
        if (canExpand) {
          const chevron = document.createElement("span");
          chevron.className = "participant-chevron";
          chevron.innerHTML = '<i data-lucide="chevron-down"></i>';
          chevron.setAttribute("aria-hidden", "true");
          summary.append(chevron);
        }
        row.append(summary);
        if (expanded) {
          const controls = document.createElement("div");
          controls.className = "participant-controls";
          if (canAdjustVolume) {
            const volumeControl = document.createElement("label");
            volumeControl.className = "participant-volume-control";
            const volumeCopy = document.createElement("span");
            volumeCopy.textContent = "个人音量";
            const volumeValue = document.createElement("b");
            volumeValue.dataset.peerVolumeValue = participant.id;
            volumeCopy.append(volumeValue);
            const volume = document.createElement("input");
            volume.type = "range";
            volume.min = "0";
            volume.max = "200";
            volume.step = "1";
            volume.dataset.peerVolume = participant.id;
            volume.setAttribute(
              "aria-label",
              `调整 ${participant.nickname} 的连麦音量`,
            );
            volumeControl.append(volumeCopy, volume);
            controls.append(volumeControl);
          }
          if (canModerate) {
            const moderation = document.createElement("div");
            moderation.className = "participant-moderation";
            const microphone = document.createElement("button");
            microphone.type = "button";
            microphone.dataset.moderationAction = "microphone";
            microphone.dataset.moderationTarget = participant.id;
            moderation.append(microphone);
            if (participant.broadcasting) {
              const stopBroadcast = document.createElement("button");
              stopBroadcast.type = "button";
              stopBroadcast.dataset.moderationAction = "stop-broadcast";
              stopBroadcast.dataset.moderationTarget = participant.id;
              stopBroadcast.textContent = "停止放映";
              moderation.append(stopBroadcast);
            }
            const kick = document.createElement("button");
            kick.type = "button";
            kick.className = "danger";
            kick.dataset.moderationAction = "kick";
            kick.dataset.moderationTarget = participant.id;
            kick.textContent = "移出频道";
            moderation.append(kick);
            controls.append(moderation);
          }
          row.append(controls);
        }
        hydrateIcons(row);
        if (previousRow) {
          if (insertionPoint === previousRow) {
            insertionPoint = row;
          }
          previousRow.replaceWith(row);
        } else {
          void animateElement(
            row,
            [
              { opacity: 0, transform: "translateY(6px)" },
              { opacity: 1, transform: "none" },
            ],
            {
              kind: "control",
              id: `participant-${participant.id}`,
              signal: this.uiAbortController.signal,
            },
          );
        }
      }
      this.updateParticipantRowState(
        row,
        participant,
        speaking,
        expanded,
        speakingLevel,
      );
      if (row !== insertionPoint) {
        list.insertBefore(row, insertionPoint);
      }
      insertionPoint = row.nextElementSibling;
      existingRows.delete(participant.id);
    }
    for (const staleRow of existingRows.values()) {
      staleRow.remove();
    }
    const count = document.querySelector<HTMLElement>("#member-count");
    if (count) {
      count.textContent = `${sorted.length} / ${MAX_ROOM_PARTICIPANTS}`;
    }
    this.reportParticipantVisualState();
  }

  private participantMicMarkup(
    speaking: boolean,
    disabled: boolean,
    muted: boolean,
    active: boolean,
  ): string {
    if (speaking) {
      return `<i data-lucide="mic"></i>`;
    }
    if (disabled || muted) {
      return `<i data-lucide="mic-off"></i>`;
    }
    if (active) {
      return `<i data-lucide="mic"></i>`;
    }
    return "";
  }

  private speakingLevelName(
    speaking: boolean,
    level: number,
  ): "off" | "low" | "medium" | "high" {
    if (!speaking) return "off";
    if (level >= 0.16) return "high";
    if (level >= 0.07) return "medium";
    return "low";
  }

  private reportParticipantVisualState(): void {
    this.onParticipantVisualStateChange?.(
      [...this.participants.values()],
      new Map(this.speakingLevels),
    );
  }

  private updateParticipantRowState(
    row: HTMLElement,
    participant: RoomParticipant,
    speaking: boolean,
    expanded: boolean,
    speakingLevel = 0,
  ): void {
    row.classList.toggle("is-speaking", speaking);
    row.classList.toggle("is-expanded", expanded);
    row.dataset.speakingLevel = this.speakingLevelName(
      speaking,
      speakingLevel,
    );
    const avatar = row.querySelector<HTMLElement>(".participant-avatar");
    if (avatar) {
      avatar.classList.toggle("voice-ready", participant.voiceActive);
      avatar.classList.toggle("is-speaking", speaking);
      const initial = avatar.firstChild;
      if (initial?.nodeType === Node.TEXT_NODE) {
        initial.textContent = Array.from(participant.nickname)[0] || "友";
      }
    }
    const name = row.querySelector<HTMLElement>(".participant-copy strong");
    if (name) name.textContent = participant.nickname;
    const role = row.querySelector<HTMLElement>("[data-participant-role]");
    if (role) {
      role.textContent = this.participantSubtitle(participant, speaking);
    }
    const summary = row.querySelector<HTMLElement>(".participant-summary");
    if (summary instanceof HTMLButtonElement) {
      summary.setAttribute("aria-expanded", String(expanded));
      summary.setAttribute(
        "aria-label",
        `${participant.nickname}，点击${expanded ? "收起" : "展开"}成员控制`,
      );
    }
    const mic = row.querySelector<HTMLElement>("[data-participant-mic]");
    if (mic) {
      const muted = Boolean(
        participant.microphoneDisabled || participant.microphoneMuted,
      );
      mic.classList.toggle("active", participant.voiceActive);
      mic.classList.toggle("muted", muted);
      mic.classList.toggle("is-speaking", speaking);
      const markup = this.participantMicMarkup(
        speaking,
        Boolean(participant.microphoneDisabled),
        Boolean(participant.microphoneMuted),
        participant.voiceActive,
      );
      const iconState = speaking
        ? "speaking"
        : muted
          ? "muted"
          : participant.voiceActive
            ? "active"
            : "off";
      if (mic.dataset.iconState !== iconState) {
        mic.dataset.iconState = iconState;
        mic.innerHTML = markup;
        hydrateIcons(mic);
      }
      mic.title = speaking
        ? `${participant.nickname} 正在说话`
        : participant.microphoneDisabled
          ? `${participant.nickname} 的麦克风已被频道主关闭`
          : participant.microphoneMuted
            ? `${participant.nickname} 已关闭麦克风`
            : participant.voiceActive
              ? `${participant.nickname} 已连麦`
              : "";
    }
    const peerVolume = this.voice.getPeerVolume(participant.id);
    const volume = row.querySelector<HTMLInputElement>(
      `[data-peer-volume="${CSS.escape(participant.id)}"]`,
    );
    if (volume && document.activeElement !== volume) {
      volume.value = String(Math.round(peerVolume * 100));
    }
    const volumeValue = row.querySelector<HTMLElement>(
      `[data-peer-volume-value="${CSS.escape(participant.id)}"]`,
    );
    if (volumeValue) {
      volumeValue.textContent = `${Math.round(peerVolume * 100)}%`;
    }
    const microphone = row.querySelector<HTMLButtonElement>(
      '[data-moderation-action="microphone"]',
    );
    if (microphone) {
      microphone.textContent = participant.microphoneDisabled
        ? "允许开麦"
        : "关闭麦克风";
    }
  }

  private async handleParticipantClick(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const moderation = target.closest<HTMLButtonElement>(
      "[data-moderation-action][data-moderation-target]",
    );
    if (moderation) {
      const participantId = moderation.dataset.moderationTarget || "";
      const participant = this.participants.get(participantId);
      if (!participant) return;
      const action = moderation.dataset.moderationAction;
      if (
        action === "kick" &&
        !(await this.confirmKick(participant))
      ) {
        return;
      }
      moderation.disabled = true;
      try {
        if (action === "microphone") {
          this.signal.send({
            type: "moderation:microphone",
            target: participantId,
            disabled: !participant.microphoneDisabled,
          });
        } else if (action === "stop-broadcast") {
          this.signal.send({
            type: "moderation:stop-broadcast",
            target: participantId,
          });
        } else if (action === "kick") {
          this.signal.send({
            type: "moderation:kick",
            target: participantId,
          });
        }
      } catch (error) {
        moderation.disabled = false;
        this.notify(
          error instanceof Error ? error.message : "成员管理操作失败",
          true,
        );
      }
      return;
    }
    const toggle = target.closest<HTMLButtonElement>(
      "[data-participant-toggle]",
    );
    if (!toggle) return;
    const participantId = toggle.dataset.participantToggle;
    this.expandedParticipantId =
      this.expandedParticipantId === participantId
        ? undefined
        : participantId;
    this.renderParticipants();
  }

  private async confirmKick(
    participant: RoomParticipant,
  ): Promise<boolean> {
    const dialog = document.createElement("dialog");
    dialog.className = "dialog dialog-confirm moderation-confirm-dialog";
    dialog.innerHTML = `
      <div class="dialog-header">
        <div>
          <span class="eyebrow">成员管理</span>
          <h2>移出 ${this.escapeHtml(participant.nickname)}？</h2>
        </div>
        <button class="btn btn-ghost btn-icon" type="button"
                data-moderation-cancel aria-label="关闭">
          <i data-lucide="x"></i>
        </button>
      </div>
      <p>对方会立即离开频道；之后仍可使用邀请再次加入。</p>
      <div class="dialog-actions">
        <button class="btn btn-secondary" type="button"
                data-moderation-cancel>取消</button>
        <button class="btn btn-danger" type="button"
                data-moderation-confirm>移出频道</button>
      </div>
    `;
    hydrateIcons(dialog);
    document.body.append(dialog);
    let accepted = false;
    const result = new Promise<boolean>((resolve) => {
      dialog.addEventListener(
        "close",
        () => {
          resolve(accepted);
          queueMicrotask(() => dialog.remove());
        },
        { once: true },
      );
      dialog
        .querySelectorAll<HTMLButtonElement>("[data-moderation-cancel]")
        .forEach((button) => {
          button.addEventListener(
            "click",
            () => void dialogController.close(dialog),
            { once: true },
          );
        });
      dialog
        .querySelector<HTMLButtonElement>("[data-moderation-confirm]")
        ?.addEventListener(
          "click",
          () => {
            accepted = true;
            void dialogController.close(dialog);
          },
          { once: true },
        );
    });
    await dialogController.open(
      dialog,
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined,
    );
    return result;
  }

  private escapeHtml(value: string): string {
    return value.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;",
        })[char] || char,
    );
  }

  private participantSubtitle(
    participant: RoomParticipant,
    speaking: boolean,
  ): string {
    if (speaking) {
      return participant.id === this.selfId ? "你 · 正在说话" : "正在说话";
    }
    if (participant.broadcasting) {
      return participant.id === this.selfId
        ? "你 · 正在放映"
        : "正在放映";
    }
    if (participant.microphoneDisabled) {
      return participant.id === this.selfId
        ? "你 · 麦克风已被频道主关闭"
        : "麦克风已关闭";
    }
    if (participant.microphoneMuted && participant.voiceActive) {
      return participant.id === this.selfId
        ? "你 · 麦克风已关闭"
        : "已关闭麦克风";
    }
    if (participant.id === this.selfId) return "你";
    if (participant.role === "host") return "频道主";
    return participant.voiceActive ? "已连麦" : "观看中";
  }

  private applyParticipantSpeaking(
    participantId: string,
    speaking: boolean,
    speakingLevel = 0,
  ): void {
    const participant = this.participants.get(participantId);
    const row = document.querySelector<HTMLElement>(
      `.participant-row[data-participant-id="${CSS.escape(participantId)}"]`,
    );
    if (!participant || !row) {
      this.renderParticipants();
      return;
    }
    row.classList.toggle("is-speaking", speaking);
    row.dataset.speakingLevel = this.speakingLevelName(
      speaking,
      speakingLevel,
    );
    row
      .querySelector(".participant-avatar")
      ?.classList.toggle("is-speaking", speaking);
    const role = row.querySelector<HTMLElement>("[data-participant-role]");
    if (role) {
      role.textContent = this.participantSubtitle(participant, speaking);
    }
    const mic = row.querySelector<HTMLElement>("[data-participant-mic]");
    if (mic) {
      mic.classList.toggle("is-speaking", speaking);
      const isMuted = Boolean(participant.microphoneDisabled || participant.microphoneMuted);
      mic.classList.toggle("muted", isMuted);
      const iconState = speaking
        ? "speaking"
        : isMuted
          ? "muted"
          : participant.voiceActive
            ? "active"
            : "off";
      if (mic.dataset.iconState !== iconState) {
        mic.dataset.iconState = iconState;
        mic.innerHTML = this.participantMicMarkup(
          speaking,
          Boolean(participant.microphoneDisabled),
          Boolean(participant.microphoneMuted),
          participant.voiceActive,
        );
        hydrateIcons(mic);
      }
      mic.title = speaking
        ? `${participant.nickname} 正在说话`
        : participant.microphoneDisabled
          ? `${participant.nickname} 的麦克风已被频道主关闭`
          : participant.microphoneMuted
            ? `${participant.nickname} 已关闭麦克风`
        : participant.voiceActive
          ? `${participant.nickname} 已连麦`
          : "";
    }
  }

  private renderVoiceState(state: VoiceState): void {
    const button = document.querySelector<HTMLButtonElement>("#voice-button");
    const mute = document.querySelector<HTMLButtonElement>("#mute-button");
    const companionPanel =
      document.querySelector<HTMLElement>("#room-companion-panel");
    const input = document.querySelector<HTMLSelectElement>(
      "#voice-input-device",
    );
    const output = document.querySelector<HTMLSelectElement>(
      "#voice-output-device",
    );
    const noiseMode = document.querySelector<HTMLSelectElement>(
      "#voice-noise-mode",
    );
    const volume = document.querySelector<HTMLInputElement>("#voice-volume");
    const volumeValue =
      document.querySelector<HTMLElement>("#voice-volume-value");
    if (button) {
      button.classList.toggle("connected", state.active);
      const label = button.querySelector<HTMLElement>(".voice-join-label");
      if (label) {
        label.textContent = state.listeningOnly
          ? "开启麦克风"
          : state.active
            ? "退出连麦"
            : "加入连麦";
      }
    }
    if (mute) {
      mute.disabled =
        !state.active || state.listeningOnly || state.microphoneDisabled;
      mute.classList.toggle("muted", state.muted);
      const muteSlash = mute.querySelector<SVGLineElement>(".mute-slash");
      if (muteSlash) {
        // Use CSS class instead of inline style to avoid CSP inline-style violation
        muteSlash.classList.toggle("mute-slash-visible", state.muted);
      }
      mute.setAttribute(
        "aria-label",
        state.microphoneDisabled
          ? "频道主已关闭你的麦克风"
          : state.muted
            ? "开启自己的麦克风"
            : "关闭自己的麦克风",
      );
    }
    if (companionPanel) {
      const transportLabel =
        state.transport === "sfu"
          ? "语音 SFU"
          : "≤3 人直连/中继";
      const suppressionLabel =
        state.noiseProcessorName === "DeepFilterNet3"
          ? "强力消噪 · DeepFilterNet3 深度滤波"
          : state.noiseSuppression
            ? state.noiseMode === "strong"
              ? "强力消噪 · 系统兼容降噪（模型安全回退）"
              : state.noiseMode === "clear"
                ? "清晰人声 · 语音隔离 + 动态人声增强"
                : "自然降噪 · 系统保真处理"
            : "直通保护 · 降噪处理器正在恢复";
      companionPanel.dataset.voiceQuality = state.active
        ? state.listeningOnly
          ? `正在收听共享伴奏 · 无需麦克风权限 · ${transportLabel} · ${state.connectedPeers ? `已连通 ${state.connectedPeers} 位好友` : "正在建立音频连接"}`
          : `${state.connectedPeers ? `已连通 ${state.connectedPeers} 位好友` : "等待好友加入连麦"} · ${
              suppressionLabel
            } · ${state.relayedPeers ? `${state.relayedPeers} 路服务器中继` : transportLabel} · ${state.echoCancellation ? "AEC 回声消除" : "建议佩戴耳机"} · ${state.autoGainControl ? "设备强制 AGC（已二次限幅）" : "固定输入余量 + 防爆音限幅"} · Opus 48 kHz · ${Math.round(state.bitrate / 1_000)} kbps`
        : "";
    }
    if (
      input &&
      [...input.options].some((option) => option.value === state.inputDeviceId)
    ) {
      input.value = state.inputDeviceId;
    }
    if (
      output &&
      [...output.options].some(
        (option) => option.value === state.outputDeviceId,
      )
    ) {
      output.value = state.outputDeviceId;
    }
    if (noiseMode) {
      noiseMode.value = state.noiseMode;
    }
    if (volume) volume.value = String(Math.round(state.volume * 100));
    if (volumeValue) {
      volumeValue.textContent = `${Math.round(state.volume * 100)}%`;
    }
    const self = this.participants.get(this.selfId);
    if (
      self &&
      (self.voiceActive !== state.active ||
        self.microphoneMuted !== state.muted ||
        self.microphoneDisabled !== state.microphoneDisabled)
    ) {
      self.voiceActive = state.active;
      self.microphoneMuted = state.active ? state.muted : false;
      self.microphoneDisabled = state.microphoneDisabled;
      this.renderParticipants();
    }
    if (this.reportedVoiceActive !== state.active) {
      this.reportedVoiceActive = state.active;
      this.onVoiceActiveChange?.(
        state.active,
        [...this.participants.values()].filter(
          (participant) => participant.voiceActive,
        ).length,
      );
    }
  }

  private async refreshVoiceDevices(showFeedback = false): Promise<void> {
    const input = document.querySelector<HTMLSelectElement>(
      "#voice-input-device",
    );
    const output = document.querySelector<HTMLSelectElement>(
      "#voice-output-device",
    );
    const refresh = document.querySelector<HTMLButtonElement>(
      "#refresh-voice-devices",
    );
    if (!input || !output) return;
    const refreshSequence = ++this.deviceRefreshSequence;
    let optionalAccessError: unknown;
    if (refresh) refresh.disabled = true;
    try {
      if (showFeedback) {
        await this.voice
          .requestOptionalOutputAccess()
          .catch((error) => {
            optionalAccessError = error;
          });
      }
      const result = await this.voice.refreshDevices();
      if (this.destroyed || refreshSequence !== this.deviceRefreshSequence) {
        return;
      }
      this.renderVoiceDevices(result.devices);
      this.notifyDeviceFallback(result);
      if (showFeedback && optionalAccessError) {
        this.notify(
          optionalAccessError instanceof Error
            ? optionalAccessError.message
            : "未获得蓝牙音频设备权限，仍可使用扬声器或有线耳机",
          true,
        );
      } else if (
        showFeedback &&
        !result.inputFallback &&
        !result.outputFallback
      ) {
        this.notify("音频设备列表已刷新");
      }
    } catch (error) {
      if (
        showFeedback &&
        !this.destroyed &&
        refreshSequence === this.deviceRefreshSequence
      ) {
        this.notify(
          error instanceof Error ? error.message : "无法读取音频设备",
          true,
        );
      }
    } finally {
      if (
        refresh?.isConnected &&
        refreshSequence === this.deviceRefreshSequence
      ) {
        refresh.disabled = false;
      }
    }
  }

  private renderVoiceDevices(devices: VoiceDevices): void {
    if (this.destroyed) return;
    const input = document.querySelector<HTMLSelectElement>(
      "#voice-input-device",
    );
    const output = document.querySelector<HTMLSelectElement>(
      "#voice-output-device",
    );
    if (!input || !output) return;
    const state = this.voice.state;
    input.replaceChildren(
      ...devices.inputs.map((device) => {
        const option = document.createElement("option");
        option.value = device.id;
        option.textContent = device.label;
        return option;
      }),
    );
    output.replaceChildren(
      ...devices.outputs.map((device) => {
        const option = document.createElement("option");
        option.value = device.id;
        option.textContent = device.label;
        return option;
      }),
    );
    input.value = devices.inputs.some(
      (device) => device.id === state.inputDeviceId,
    )
      ? state.inputDeviceId
      : "default";
    output.value = devices.outputs.some(
      (device) => device.id === state.outputDeviceId,
    )
      ? state.outputDeviceId
      : "default";
  }

  private notifyDeviceFallback(change: VoiceDevicesChange): void {
    if (this.destroyed) return;
    if (change.inputFallback && change.outputFallback) {
      this.notify(
        "原麦克风和扬声器已断开，已自动回退到系统默认设备",
        true,
      );
    } else if (change.inputFallback) {
      this.notify("原麦克风已断开，已自动切换到系统默认麦克风", true);
    } else if (change.outputFallback) {
      this.notify("原扬声器已断开，已自动切换到系统默认扬声器", true);
    }
  }

  private recentEmojis(): string[] {
    try {
      const stored = JSON.parse(
        localStorage.getItem(RECENT_EMOJI_KEY) || "[]",
      );
      return Array.isArray(stored)
        ? stored
            .map((value) => String(value))
            .filter(Boolean)
            .slice(0, 12)
        : [];
    } catch {
      return [];
    }
  }

  private rememberEmoji(emoji: string): void {
    if (!emoji) return;
    const recent = [
      emoji,
      ...this.recentEmojis().filter((value) => value !== emoji),
    ].slice(0, 12);
    localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(recent));
    this.renderRecentEmojis();
  }

  private renderRecentEmojis(): void {
    const group =
      document.querySelector<HTMLElement>("#emoji-recent-group");
    const grid = document.querySelector<HTMLElement>("#emoji-recent-grid");
    if (!group || !grid) return;
    const recent = this.recentEmojis();
    group.hidden = recent.length === 0;
    grid.replaceChildren(
      ...recent.map((emoji) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "emoji-item";
        button.dataset.emoji = emoji;
        button.setAttribute("aria-label", emoji);
        button.textContent = emoji;
        return button;
      }),
    );
  }

  private async testMicrophone(): Promise<void> {
    this.microphoneTestAbort?.abort();
    const controller = new AbortController();
    this.microphoneTestAbort = controller;
    const button =
      document.querySelector<HTMLButtonElement>("#test-voice-input");
    const selectedDevice =
      document.querySelector<HTMLSelectElement>("#voice-input-device")
        ?.value || "default";
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "正在监听…";
    }
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          ...(selectedDevice !== "default"
            ? { deviceId: { exact: selectedDevice } }
            : {}),
        },
        video: false,
      });
      if (controller.signal.aborted) return;
      context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const startedAt = performance.now();
      await new Promise<void>((resolve) => {
        const finish = (): void => resolve();
        controller.signal.addEventListener("abort", finish, { once: true });
        const sample = (): void => {
          if (
            controller.signal.aborted ||
            performance.now() - startedAt >= 4_000
          ) {
            finish();
            return;
          }
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) sum += value * value;
          const level = Math.min(1, Math.sqrt(sum / samples.length) * 8);
          button?.style.setProperty("--mic-test-level", String(level));
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      if (!controller.signal.aborted) {
        this.notify("麦克风测试完成");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.notify(
          error instanceof Error ? error.message : "无法测试麦克风",
          true,
        );
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      await context?.close().catch(() => undefined);
      if (button?.isConnected) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.style.removeProperty("--mic-test-level");
        button.textContent = "测试麦克风";
      }
      if (this.microphoneTestAbort === controller) {
        this.microphoneTestAbort = undefined;
      }
    }
  }

  private appendChat(
    nickname: string,
    text: string,
    mine: boolean,
    sentAt?: number,
  ): void {
    const log = document.querySelector<HTMLElement>("#chat-log");
    if (!log) {
      return;
    }
    const shouldFollowLatest = this.isChatNearBottom(log);
    log.querySelector(".chat-placeholder")?.remove();
    const timestampValue =
      Number.isFinite(sentAt) && Number(sentAt) > 0
        ? Number(sentAt)
        : Date.now();
    const previous =
      log.lastElementChild instanceof HTMLElement
        ? log.lastElementChild
        : undefined;
    const grouped = Boolean(
      previous?.matches(".chat-message") &&
        previous.dataset.author === nickname &&
        previous.classList.contains("mine") === mine &&
        timestampValue - Number(previous.dataset.sentAt || 0) <= 5 * 60_000,
    );
    const row = document.createElement("div");
    row.className =
      `chat-message ${mine ? "mine" : ""}${grouped ? " is-grouped" : ""}`;
    row.dataset.author = nickname;
    row.dataset.sentAt = String(timestampValue);
    const author = document.createElement("strong");
    author.textContent = mine ? "我" : nickname;
    if (grouped) author.classList.add("sr-only");
    const content = document.createElement("span");
    content.textContent = text;
    const timestamp = document.createElement("time");
    const date = new Date(timestampValue);
    timestamp.className = "chat-timestamp";
    timestamp.dateTime = date.toISOString();
    timestamp.textContent = date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    timestamp.title = date.toLocaleString("zh-CN", { hour12: false });
    row.append(author, content, timestamp);
    log.append(row);
    void animateElement(
      row,
      [
        { opacity: 0, transform: "translateY(5px)" },
        { opacity: 1, transform: "none" },
      ],
      {
        kind: "control",
        id: "chat-message",
        signal: this.uiAbortController.signal,
      },
    );
    while (log.querySelectorAll(".chat-message").length > 500) {
      log.firstElementChild?.remove();
    }
    if (shouldFollowLatest) {
      log.scrollTop = log.scrollHeight;
      this.clearChatUnread();
    } else {
      this.chatUnreadCount += 1;
      this.renderChatUnread();
    }
  }

  private isChatNearBottom(log: HTMLElement): boolean {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }

  private clearChatUnread(): void {
    if (!this.chatUnreadCount) {
      this.renderChatUnread();
      return;
    }
    this.chatUnreadCount = 0;
    this.renderChatUnread();
  }

  private renderChatUnread(): void {
    const button = document.querySelector<HTMLButtonElement>(
      "#chat-jump-latest",
    );
    const count = document.querySelector<HTMLElement>("#chat-unread-count");
    if (button) button.hidden = this.chatUnreadCount === 0;
    if (count) {
      count.textContent = this.chatUnreadCount
        ? `(${Math.min(99, this.chatUnreadCount)}${this.chatUnreadCount > 99 ? "+" : ""})`
        : "";
    }
  }

}
