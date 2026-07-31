import { ProcessAudioCapture } from "./process-audio";
import type { RoomCompanion } from "./room-companion";
import { FloatingSurface } from "./ui/floating-surface";
import { hydrateIcons } from "./ui/icons";

type Notify = (
  message: string,
  type?: boolean | "info" | "warn" | "danger",
) => void;

interface ChannelMusicOptions {
  notify: Notify;
  getCompanion: () => RoomCompanion | undefined;
  isProcessAudioBusy: () => boolean;
  onSharedStateChange?: (active: boolean) => void;
}

interface MusicPreset {
  key: string;
  name: string;
  mark: string;
  pattern: RegExp;
}

const MUSIC_PRESETS: MusicPreset[] = [
  {
    key: "netease",
    name: "网易云音乐",
    mark: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M15 5.5 A8 8 0 0 1 19 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    pattern: /网易云|cloud\s*music|cloudmusic|orpheus|netease/iu,
  },
  {
    key: "qqmusic",
    name: "QQ 音乐",
    mark: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 18 C5 18 3 15 3 12 C3 7 7 4 12 4 C17 4 21 7 21 12 C21 15 19 18 15 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9 18 L9 21 M15 18 L15 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>`,
    pattern: /qq\s*音乐|qqmusic/iu,
  },
  {
    key: "kugou",
    name: "酷狗音乐",
    mark: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 4 L6 20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M6 12 L16 6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M6 12 L16 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="17" cy="6" r="2" fill="currentColor"/><circle cx="17" cy="18" r="2" fill="currentColor"/></svg>`,
    pattern: /酷狗|kugou/iu,
  },
  {
    key: "qishui",
    name: "汽水音乐",
    mark: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 C12 3 8 7 8 12 C8 15.3 9.8 18 12 18 C14.2 18 16 15.3 16 12 C16 7 12 3 12 3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 14 Q12 16 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    pattern: /汽水|qishui|luna\s*music/iu,
  },
];

const MUSIC_SOURCE_CACHE_MS = 5_000;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function musicSourceIdentity(source: CaptureSource): string {
  return [
    source.name,
    source.processName,
    source.executableName,
  ]
    .filter(Boolean)
    .join(" ");
}

function storedMusicVolume(): number {
  const stored = localStorage.getItem("synced:music-volume");
  if (stored === null) return 0.7;
  const value = Number(stored);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.7;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer = 0;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    window.clearTimeout(timer);
  }
}

export function channelMusicRailButtonMarkup(): string {
  return `
    <button
      class="rail-music rail-tool"
      type="button"
      data-music-button
      aria-label="播放共享伴奏"
      aria-haspopup="dialog"
      aria-expanded="false"
    >
      <i data-lucide="music-2"></i>
      <span class="rail-tooltip">音乐<small>共享应用伴奏</small></span>
    </button>
  `;
}

export class ChannelMusicController {
  private button?: HTMLButtonElement;
  private popover?: HTMLElement;
  private surface?: FloatingSurface;
  private sources: CaptureSource[] = [];
  private capture?: ProcessAudioCapture;
  private activeSource?: CaptureSource;
  private volume = storedMusicVolume();
  private view: "presets" | "all" = "presets";
  private refreshSequence = 0;
  private sourcesLoadedAt = 0;
  private sourceRefreshInFlight?: Promise<CaptureSource[]>;
  private destroyed = false;
  private readonly abortController = new AbortController();

  constructor(private readonly options: ChannelMusicOptions) {}

  get active(): boolean {
    return Boolean(this.capture?.active && this.activeSource);
  }

  bind(scope: ParentNode = document): void {
    this.button =
      scope.querySelector<HTMLButtonElement>("[data-music-button]") ??
      undefined;
    this.button?.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        if (this.popover) void this.surface?.close();
        else void this.openPopover();
      },
      { signal: this.abortController.signal },
    );
    this.updateButton();
  }

  async stop(showNotice = true): Promise<void> {
    const capture = this.capture;
    const hadSource = Boolean(this.activeSource);
    this.capture = undefined;
    this.activeSource = undefined;
    this.options.getCompanion()?.clearAccompaniment();
    await capture?.stop().catch(() => undefined);
    if (hadSource) this.options.onSharedStateChange?.(false);
    if (showNotice && hadSource) {
      this.options.notify("共享伴奏已停止", "info");
    }
    this.updateButton();
    this.renderPopover();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortController.abort();
    this.closePopover();
    await this.stop(false);
  }

  private async openPopover(): Promise<void> {
    if (this.destroyed || !this.button) return;
    this.view = "presets";
    const popover = document.createElement("section");
    popover.className = "music-source-popover material-regular";
    popover.hidden = true;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "共享伴奏来源");
    this.popover = popover;
    this.surface = new FloatingSurface(this.button, popover, {
      placement: "right-start",
      closeOnOutside: true,
      onOpenChange: (open) => {
        if (!open && this.popover === popover) {
          this.closePopover();
        }
      },
    });
    this.updateButton();
    this.renderPopover(this.sourcesLoadedAt === 0);
    const opening = this.surface.open();
    const refreshing = this.refreshSources();
    await Promise.allSettled([opening, refreshing]);
    if (this.destroyed || this.popover !== popover) return;
  }

  private closePopover(): void {
    const popover = this.popover;
    this.popover = undefined;
    const surface = this.surface;
    this.surface = undefined;
    surface?.destroy();
    popover?.remove();
    this.updateButton();
  }

  private loadSources(): Promise<CaptureSource[]> {
    if (this.sourceRefreshInFlight) return this.sourceRefreshInFlight;
    const request = window.roomDesktop?.listSources({
      thumbnails: false,
      audioProcesses: true,
    });
    if (!request) {
      return Promise.reject(new Error("当前版本不支持应用声音采集"));
    }
    const pending = withTimeout(
      request,
      4_000,
      "Windows 读取应用窗口超时，请关闭菜单后重试",
    ).finally(() => {
      if (this.sourceRefreshInFlight === pending) {
        this.sourceRefreshInFlight = undefined;
      }
    });
    this.sourceRefreshInFlight = pending;
    return pending;
  }

  private async refreshSources(force = false): Promise<void> {
    if (
      !force &&
      this.sourcesLoadedAt > 0 &&
      Date.now() - this.sourcesLoadedAt < MUSIC_SOURCE_CACHE_MS
    ) {
      this.renderPopover();
      return;
    }
    const sequence = ++this.refreshSequence;
    try {
      const sources = await this.loadSources();
      if (this.destroyed || sequence !== this.refreshSequence) return;
      this.sources = sources;
      this.sourcesLoadedAt = Date.now();
      if (!this.popover) return;
      this.renderPopover();
    } catch (error) {
      if (sequence !== this.refreshSequence || !this.popover) return;
      this.popover.innerHTML = `
        <div class="music-popover-error">
          <strong>无法读取音频应用</strong>
          <span>${escapeHtml(error instanceof Error ? error.message : "读取窗口失败")}</span>
          <button type="button" data-music-refresh>重试</button>
        </div>
      `;
      this.bindPopoverActions();
      hydrateIcons(this.popover);
    }
  }

  private renderPopover(loading = false): void {
    const popover = this.popover;
    if (!popover) return;
    if (this.view === "all") {
      this.renderAllSources(popover, loading);
      return;
    }
    const presetRows = MUSIC_PRESETS.map((preset) => {
      const sourceIndex = this.sources.findIndex((source) =>
        preset.pattern.test(musicSourceIdentity(source)),
      );
      const source = sourceIndex >= 0 ? this.sources[sourceIndex] : undefined;
      const active = source?.id === this.activeSource?.id;
      return `
        <button
          class="music-source-row${active ? " active" : ""}${source ? "" : " unavailable"}"
          type="button"
          ${source ? `data-music-source-index="${sourceIndex}"` : "disabled"}
          title="${source ? escapeHtml(source.name) : `请先打开${preset.name}`}"
        >
          <span class="music-app-mark music-app-mark-${preset.key}">${preset.mark}</span>
          <span><strong>${preset.name}</strong><small>${source ? escapeHtml(source.name) : "未检测到已打开窗口"}</small></span>
          <i aria-hidden="true"></i>
        </button>
      `;
    }).join("");
    popover.innerHTML = `
      <div class="music-popover-heading">
        <div>
          <span>伴奏来源</span>
          <button class="music-help" type="button" aria-label="伴奏说明" title="采集所选应用的声音并混入频道音频；其他成员会以免麦克风权限的收听模式自动接入。关闭自己的麦克风不会停止伴奏。"><i data-lucide="circle-help"></i></button>
        </div>
        <button class="music-close" type="button" data-music-close aria-label="关闭伴奏菜单"><i data-lucide="x"></i></button>
      </div>
      <div class="music-source-list">
        ${presetRows}
      </div>
      <button class="music-more-sources" type="button" data-music-more>
        <span>更多音源</span><i data-lucide="chevron-right"></i>
      </button>
      <div class="music-volume-control">
        <span><b>伴奏音量</b><output>${Math.round(this.volume * 100)}%</output></span>
        <div>
          <i data-lucide="volume-2"></i>
          <input data-music-volume type="range" min="0" max="100" value="${Math.round(this.volume * 100)}" aria-label="伴奏发送音量" />
        </div>
      </div>
      ${
        this.activeSource
          ? `
            <div class="music-active-source">
              <span><i></i><b>正在共享</b><small>${escapeHtml(this.activeSource.name)}</small></span>
              <button type="button" data-music-stop>停止</button>
            </div>
          `
          : `<p class="music-popover-note">选择正在播放音乐的窗口。伴奏只发送应用声音，不会把桌面其他声音混进去。</p>`
      }
    `;
    this.bindPopoverActions();
    hydrateIcons(popover);
  }

  private renderAllSources(popover: HTMLElement, loading: boolean): void {
    const sourceRows = this.sources
      .map(
        (source, index) => `
          <button class="music-all-source${source.id === this.activeSource?.id ? " active" : ""}" type="button" data-music-source-index="${index}">
            ${
              source.appIcon
                ? `<img src="${source.appIcon}" alt="" />`
                : `<span><i data-lucide="music-2"></i></span>`
            }
            <b>${escapeHtml(source.name)}</b>
            <i aria-hidden="true"></i>
          </button>
        `,
      )
      .join("");
    popover.innerHTML = `
      <div class="music-popover-heading music-all-heading">
        <button type="button" data-music-back aria-label="返回常用音源"><i data-lucide="arrow-left"></i></button>
        <div><span>全部应用窗口</span><small>选择正在出声的播放器</small></div>
        <button type="button" data-music-refresh aria-label="刷新窗口"><i data-lucide="refresh-cw"></i></button>
      </div>
      <div class="music-all-source-list">
        ${
          loading
            ? `<div class="music-source-loading">正在读取窗口…</div>`
            : sourceRows ||
              `<div class="music-source-loading">没有找到其他窗口，请先打开音乐播放器</div>`
        }
      </div>
    `;
    this.bindPopoverActions();
    hydrateIcons(popover);
  }

  private bindPopoverActions(): void {
    const popover = this.popover;
    if (!popover) return;
    popover
      .querySelector<HTMLButtonElement>("[data-music-close]")
      ?.addEventListener("click", () => void this.surface?.close());
    popover
      .querySelector<HTMLButtonElement>("[data-music-more]")
      ?.addEventListener("click", () => {
        this.view = "all";
        this.renderPopover();
      });
    popover
      .querySelector<HTMLButtonElement>("[data-music-back]")
      ?.addEventListener("click", () => {
        this.view = "presets";
        this.renderPopover();
      });
    popover
      .querySelector<HTMLButtonElement>("[data-music-refresh]")
      ?.addEventListener("click", () => void this.refreshSources(true));
    popover
      .querySelector<HTMLButtonElement>("[data-music-stop]")
      ?.addEventListener("click", () => void this.stop());
    popover
      .querySelector<HTMLInputElement>("[data-music-volume]")
      ?.addEventListener("input", (event) => {
        const input = event.currentTarget as HTMLInputElement;
        this.volume = Math.min(1, Math.max(0, Number(input.value) / 100));
        localStorage.setItem("synced:music-volume", String(this.volume));
        this.options
          .getCompanion()
          ?.setAccompanimentVolume(this.volume);
        const output = input
          .closest(".music-volume-control")
          ?.querySelector<HTMLOutputElement>("output");
        if (output) output.value = `${Math.round(this.volume * 100)}%`;
      });
    popover
      .querySelectorAll<HTMLButtonElement>("[data-music-source-index]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const index = Number(button.dataset.musicSourceIndex);
          if (Number.isInteger(index)) void this.startSource(index);
        });
      });
  }

  private async startSource(index: number): Promise<void> {
    const source = this.sources[index];
    if (!source || this.destroyed) return;
    if (this.options.isProcessAudioBusy()) {
      this.options.notify(
        "普通屏幕放映正在采集窗口声音。请先停止放映，再启动共享伴奏；Emby 高清放映不受影响。",
        "warn",
      );
      return;
    }
    const buttons = this.popover?.querySelectorAll<HTMLButtonElement>(
      "[data-music-source-index]",
    );
    buttons?.forEach((button) => {
      button.disabled = true;
    });
    let pendingCapture: ProcessAudioCapture | undefined;
    try {
      await this.stop(false);
      const companion = this.options.getCompanion();
      if (!companion) throw new Error("频道语音尚未连接，请稍后重试");
      await companion.resumeVoice();
      await window.roomDesktop?.selectSource(source.id);
      const capture = new ProcessAudioCapture();
      pendingCapture = capture;
      capture.addEventListener("silence", () => {
        if (this.capture !== capture) return;
        this.options.notify(
          "暂未检测到伴奏声音，请确认音乐正在播放且应用没有静音。",
          "warn",
        );
      });
      capture.addEventListener("error", (event) => {
        if (this.capture !== capture) return;
        const message =
          (event as CustomEvent<string>).detail || "伴奏声音采集中断";
        void this.stop(false);
        this.options.notify(message, "danger");
      });
      const track = await capture.start();
      companion.setAccompanimentTrack(track, this.volume);
      this.capture = capture;
      pendingCapture = undefined;
      this.activeSource = source;
      this.options.onSharedStateChange?.(true);
      this.options.notify(
        `正在共享 ${source.name}；频道成员会自动接入收听`,
        "info",
      );
      this.updateButton();
      this.renderPopover();
    } catch (error) {
      await pendingCapture?.stop().catch(() => undefined);
      await this.capture?.stop().catch(() => undefined);
      this.capture = undefined;
      this.activeSource = undefined;
      this.options.notify(
        error instanceof Error ? error.message : "共享伴奏启动失败",
        "danger",
      );
      this.updateButton();
      this.renderPopover();
    } finally {
      this.popover
        ?.querySelectorAll<HTMLButtonElement>("[data-music-source-index]")
        .forEach((button) => {
          button.disabled = false;
        });
    }
  }

  private updateButton(): void {
    if (!this.button) return;
    const open = Boolean(this.popover);
    const active = this.active;
    this.button.classList.toggle("active", open || active);
    this.button.classList.toggle("playing", active);
    this.button.setAttribute("aria-expanded", String(open));
    this.button.setAttribute("aria-pressed", String(active));
    this.button.removeAttribute("title");
    this.button.setAttribute(
      "aria-label",
      active
        ? `正在共享：${this.activeSource?.name || "伴奏"}`
        : "播放共享伴奏",
    );
  }
}
