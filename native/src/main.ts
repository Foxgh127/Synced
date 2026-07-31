import { App } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import "./styles.css";
import {
  forgetRecentChannel,
  getChannelName,
  getHostChannelOwnership,
  getNickname,
  getRecentChannels,
  saveChannelName,
  saveNickname,
} from "./channel-store";
import type { ChannelSessionOptions } from "./channel-session";
import {
  describeSignalHost,
  HOME_SIGNAL_URL,
  normalizeSignalUrl,
  parseJoinLink,
  requiresSignalTrust,
} from "./config";
import { hideEmbeddedGame } from "./embedded-game";
import { isNativeAndroid } from "./immersive";
import { migrateStorageIdentity } from "./storage-identity";
import { dialogController } from "./ui/dialog-controller";
import { renderDesignLab } from "./ui/design-lab";
import {
  applySavedUiScale,
  SettingsController,
} from "./ui/settings-controller";
import { effectsQuality } from "./ui/effects-quality";
import {
  closeTopmostFloatingSurface,
  FloatingSurface,
} from "./ui/floating-surface";
import { hydrateIcons } from "./ui/icons";
import {
  animateElement,
  cancelElementMotion,
} from "./ui/motion-controller";
import { bindLocalPointerLight } from "./ui/pointer-light";
import { scanQrCode } from "./ui/qr-scanner";
import { probeSignalHealth } from "./ui/signal-health";
import { bindStarField } from "./ui/star-field";
import { transitionView } from "./ui/view-transition";
import { rememberVideoEnhancementHardwareInfo } from "./video-enhancement";

migrateStorageIdentity(localStorage);

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) {
  throw new Error("Missing application root");
}
const appRoot: HTMLDivElement = root;

async function openSession(
  options: ChannelSessionOptions,
): Promise<void> {
  const { openChannelSession } = await import("./channel-session");
  options.operationSignal?.throwIfAborted();
  await openChannelSession(options);
}
applySavedUiScale();
void effectsQuality.start().catch(() => undefined);
document.documentElement.dataset.input = matchMedia(
  "(hover: none), (pointer: coarse)",
).matches
  ? "touch"
  : "pointer";

const DEFAULT_SIGNAL_URL = HOME_SIGNAL_URL;
const isDesktop = Boolean(window.roomDesktop);
if (isDesktop) {
  void window.roomDesktop
    ?.getVideoEnhancementInfo()
    .then(rememberVideoEnhancementHardwareInfo)
    .catch(() => undefined);
}
const signalUrlPolicy = { allowInsecure: !isNativeAndroid() } as const;
let viewAbortController = new AbortController();
let settingsController: SettingsController;
let appBackButtonHandle: PluginListenerHandle | undefined;

function resetViewLifecycle(): AbortSignal {
  viewAbortController.abort();
  viewAbortController = new AbortController();
  return viewAbortController.signal;
}

function navigate(
  render: () => void | Promise<void>,
  name: string,
): void {
  const signal = resetViewLifecycle();
  void transitionView(appRoot, render, { signal, name });
}

function normalizeAppSignalUrl(value: string): string {
  return normalizeSignalUrl(value, signalUrlPolicy);
}

if (isNativeAndroid()) {
  document.addEventListener("contextmenu", (event) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, [contenteditable='true']")
    ) {
      return;
    }
    event.preventDefault();
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getSignalUrl(): string {
  const saved = localStorage.getItem("synced:signal");
  if (!saved) return DEFAULT_SIGNAL_URL;
  try {
    return normalizeAppSignalUrl(saved);
  } catch {
    return DEFAULT_SIGNAL_URL;
  }
}

function saveSignalUrl(value: string): string {
  const normalized = normalizeAppSignalUrl(value);
  localStorage.setItem("synced:signal", normalized);
  return normalized;
}

type ToastType = "info" | "warn" | "danger";
interface ActiveToast {
  element: HTMLElement;
  count: number;
  timer: number;
}
const activeToasts = new Map<string, ActiveToast>();

function syncToastMaterialBudget(): void {
  const hasVisibleToast = Boolean(
    document.querySelector("#toast-container .toast"),
  );
  if (hasVisibleToast) {
    document.documentElement.dataset.toastVisible = "true";
  } else {
    delete document.documentElement.dataset.toastVisible;
  }
}

function getOrCreateToastContainer(): HTMLElement {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.setAttribute("aria-label", "通知");
    container.setAttribute("aria-live", "polite");
    document.body.append(container);
  }
  return container;
}

async function removeToast(
  key: string,
  element: HTMLElement,
): Promise<void> {
  if (!element.parentNode || element.dataset.presence === "leaving") return;
  element.dataset.presence = "leaving";
  const toastExitsDown = matchMedia("(max-width: 600px)").matches;
  const result = await animateElement(
    element,
    [
      { opacity: 1, transform: "none" },
      {
        opacity: 0,
        transform: toastExitsDown
          ? "translateY(8px)"
          : "translateX(8px)",
      },
    ],
    {
      kind: "micro",
      id: "toast-presence",
      reducedKeyframes: [{ opacity: 1 }, { opacity: 0 }],
    },
  );
  if (
    result !== "finished" ||
    element.dataset.presence !== "leaving"
  ) {
    return;
  }
  element.remove();
  const active = activeToasts.get(key);
  if (active?.element === element) activeToasts.delete(key);
  syncToastMaterialBudget();
}

function toast(
  message: string,
  type: ToastType | boolean = "info",
): void {
  const tone: ToastType =
    type === true ? "danger" : type === false ? "info" : type;
  const key = `${tone}:${message}`;
  const existing = activeToasts.get(key);
  if (existing?.element.isConnected) {
    cancelElementMotion(existing.element, "toast-presence");
    existing.element.dataset.presence = "present";
    existing.count += 1;
    const count = existing.element.querySelector<HTMLElement>(
      "[data-toast-count]",
    );
    if (count) {
      count.hidden = false;
      count.textContent = `×${existing.count}`;
    }
    window.clearTimeout(existing.timer);
    existing.timer = window.setTimeout(
      () => void removeToast(key, existing.element),
      5_000,
    );
    void animateElement(
      existing.element,
      [
        { transform: "scale(1)" },
        { transform: "scale(1.015)" },
        { transform: "scale(1)" },
      ],
      { kind: "micro", id: "toast-merge" },
    );
    return;
  }
  const container = getOrCreateToastContainer();
  const element = document.createElement("div");
  element.className = `toast toast-${tone} material-regular`;
  element.dataset.presence = "entering";
  element.setAttribute("role", tone === "danger" ? "alert" : "status");
  element.innerHTML = `
    <span class="toast-bar" aria-hidden="true"></span>
    <span class="toast-text">${escapeHtml(message)}</span>
    <span class="toast-count tnum" data-toast-count hidden></span>
    <button class="btn btn-ghost btn-icon btn-icon-sm toast-close" type="button" aria-label="关闭通知">
      <i data-lucide="x"></i>
    </button>
  `;
  element
    .querySelector(".toast-close")
    ?.addEventListener("click", () => void removeToast(key, element));
  container.append(element);
  syncToastMaterialBudget();
  hydrateIcons(element);
  const toastStartsBelow = matchMedia("(max-width: 600px)").matches;
  void animateElement(
    element,
    [
      {
        opacity: 0,
        transform: toastStartsBelow
          ? "translateY(12px)"
          : "translateX(10px)",
      },
      { opacity: 1, transform: "none" },
    ],
    {
      kind: "control",
      id: "toast-presence",
      reducedKeyframes: [{ opacity: 0 }, { opacity: 1 }],
    },
  ).then((result) => {
    if (
      result === "finished" &&
      element.dataset.presence === "entering"
    ) {
      element.dataset.presence = "present";
    }
  });
  const all = container.querySelectorAll(".toast");
  if (all.length > 3 && all[0] instanceof HTMLElement) {
    const oldest = [...activeToasts.entries()].find(
      ([, value]) => value.element === all[0],
    );
    if (oldest) void removeToast(oldest[0], oldest[1].element);
  }
  const timer = window.setTimeout(
    () => void removeToast(key, element),
    5_000,
  );
  activeToasts.set(key, { element, count: 1, timer });
}

async function requestSignalTrust(
  signalUrl: string,
  room: string,
  opener?: HTMLElement,
): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "security-sheet";
  dialog.setAttribute("aria-labelledby", "signal-trust-title");
  dialog.innerHTML = `
    <div class="security-sheet-content">
      <span class="eyebrow">UNFAMILIAR SERVER</span>
      <div class="cluster">
        <i data-lucide="shield-alert" aria-hidden="true"></i>
        <h2 id="signal-trust-title">确认使用陌生服务器</h2>
      </div>
      <p>这个邀请不会自动开启麦克风，但服务器可以看到你的频道连接元数据。只接受你认识的人提供的地址。</p>
      <div class="security-host">
        <strong>${escapeHtml(describeSignalHost(signalUrl))}</strong>
        <small>频道 ${escapeHtml(room)}</small>
      </div>
      <div class="dialog-actions">
        <button class="btn btn-secondary" type="button" data-trust-reject>取消</button>
        <button class="btn btn-primary" type="button" data-trust-accept>信任并继续</button>
      </div>
    </div>
  `;
  document.body.append(dialog);
  hydrateIcons(dialog);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = async (accepted: boolean): Promise<void> => {
      if (settled) return;
      settled = true;
      await dialogController.close(dialog);
      dialog.remove();
      resolve(accepted);
    };
    dialog
      .querySelector("[data-trust-reject]")
      ?.addEventListener("click", () => void finish(false));
    dialog
      .querySelector("[data-trust-accept]")
      ?.addEventListener("click", () => void finish(true));
    dialog.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        dialog.remove();
        resolve(false);
      }
    });
    void dialogController.open(dialog, opener);
  });
}

async function confirmExternalInvite(
  inviteUrl: string,
): Promise<{ room: string; signalUrl: string } | undefined> {
  const parsed = parseJoinLink(inviteUrl);
  if (!parsed.room) {
    toast("邀请链接无效或已损坏", "danger");
    return undefined;
  }
  let signalUrl: string;
  try {
    signalUrl = normalizeAppSignalUrl(parsed.signal || getSignalUrl());
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message
        : "邀请链接中的信令服务器地址无效",
      "danger",
    );
    return undefined;
  }
  const untrusted = requiresSignalTrust(signalUrl);
  // Opening a trusted app invite is already an explicit user gesture. A
  // native confirm() here can be dismissed while Android is still restoring
  // the WebView, leaving the user on an empty join screen even though the
  // deep link was valid. Trusted home/LAN links are safe to join directly
  // because joining never enables the microphone. Unknown signal hosts still
  // require an explicit trust decision.
  if (!untrusted) return { room: parsed.room, signalUrl };
  const accepted = await requestSignalTrust(signalUrl, parsed.room);
  return accepted ? { room: parsed.room, signalUrl } : undefined;
}

function channelInitial(name: string): string {
  return Array.from(name)[0] || "频";
}

function formatLastJoined(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "刚刚进入";
  if (elapsed < 3_600_000) {
    return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`;
  }
  if (elapsed < 86_400_000) {
    return `${Math.max(1, Math.floor(elapsed / 3_600_000))} 小时前`;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

function recentHomeMarkup(): string {
  const recent = getRecentChannels();
  if (!recent.length) {
    return `
      <div class="recent-empty-state material-card">
        <i data-lucide="users"></i>
        <div><strong>还没有最近频道</strong><p>创建或加入一次后，可以从这里快速回来。</p></div>
      </div>
    `;
  }
  return recent
    .slice(0, 6)
    .map(
      (channel) => `
        <article class="recent-channel-card interactive-card" data-recent-card="${escapeHtml(channel.room)}">
          <button class="recent-card-main" type="button"
            data-recent-room="${escapeHtml(channel.room)}"
            data-recent-name="${escapeHtml(channel.name)}"
            data-recent-signal="${escapeHtml(channel.signalUrl)}"
            data-recent-navigation-disabled="false"
            aria-label="进入频道 ${escapeHtml(channel.name)}，${channel.room}">
            <span class="recent-avatar">${escapeHtml(channelInitial(channel.name))}</span>
            <span class="recent-card-copy">
              <strong>${escapeHtml(channel.name)}</strong>
              <small><span class="mono">${escapeHtml(channel.room.slice(0, 4))} · ${escapeHtml(channel.room.slice(4))}</span> · ${formatLastJoined(channel.lastJoinedAt)}</small>
              <span class="recent-health" data-signal-health="${escapeHtml(channel.signalUrl)}">
                <i data-lucide="circle"></i><span>检查服务状态</span>
              </span>
            </span>
          </button>
          <button class="btn btn-ghost btn-icon recent-menu-trigger" type="button"
            data-recent-menu="${escapeHtml(channel.room)}"
            aria-label="${escapeHtml(channel.name)}的更多操作"
            aria-haspopup="menu" aria-expanded="false">
            <i data-lucide="ellipsis"></i>
          </button>
        </article>
      `,
    )
    .join("");
}

function mobileRecentJoinMarkup(): string {
  const recent = getRecentChannels().slice(0, 4);
  if (!recent.length) return "";
  return recent
    .map(
      (channel) => `
        <button class="mobile-recent-join-item" type="button"
                data-mobile-recent-room="${escapeHtml(channel.room)}"
                data-mobile-recent-signal="${escapeHtml(channel.signalUrl)}"
                aria-label="继续加入 ${escapeHtml(channel.name)}，频道 ${escapeHtml(displayRoomCode(channel.room))}">
          <span class="mobile-recent-avatar" aria-hidden="true">${escapeHtml(channelInitial(channel.name))}</span>
          <span class="mobile-recent-copy">
            <strong>${escapeHtml(channel.name)}</strong>
            <small><span class="tnum">${escapeHtml(displayRoomCode(channel.room))}</span> · ${escapeHtml(formatLastJoined(channel.lastJoinedAt))}</small>
          </span>
          <i data-lucide="chevron-right" aria-hidden="true"></i>
        </button>
      `,
    )
    .join("");
}

function railMarkup(): string {
  return `
    <aside class="channel-rail" aria-label="主导航">
      <div class="rail-logo rail-identity" role="img" aria-label="同频">
        <img src="./brand-mark-dark.svg" width="26" height="26" alt="" aria-hidden="true" />
      </div>
      <div class="rail-divider"></div>
      <button class="rail-add" data-join-button aria-label="加入新频道" data-tooltip="加入频道"><i data-lucide="plus"></i></button>
      <div class="rail-spacer"></div>
      <button class="profile-orb profile-action" type="button"
        data-profile-button aria-label="个人资料与设置，当前昵称 ${escapeHtml(getNickname())}"
        aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(getNickname())}">
        ${escapeHtml(channelInitial(getNickname()))}
      </button>
    </aside>
  `;
}

function homeProfileMarkup(): string {
  const nickname = getNickname();
  return `
    <div class="home-profile-dock" aria-label="个人资料">
      <button class="home-profile-rename profile-action" type="button"
        data-profile-button aria-label="修改昵称，当前昵称 ${escapeHtml(nickname)}"
        aria-haspopup="menu" aria-expanded="false" title="修改昵称">
        <span class="home-profile-avatar" data-profile-initial>${escapeHtml(channelInitial(nickname))}</span>
        <span class="home-profile-copy">
          <strong data-profile-name>${escapeHtml(nickname)}</strong>
          <small>点击改名</small>
        </span>
      </button>
      <button class="home-profile-settings" type="button"
        data-home-settings aria-label="打开设置" title="设置" data-tooltip="设置">
        <i data-lucide="settings"></i>
      </button>
    </div>
  `;
}

function bindRailNavigation(): void {
  document.querySelector("[data-join-button]")?.addEventListener("click", () => {
    navigate(() => renderViewer({ desktop: isDesktop }), "join");
  });
  bindRecentChannelInteractions();
  bindRecentMenus();
  bindProfilePopover();
  hydrateIcons(document);
}

function bindProfilePopover(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    "[data-profile-button]",
  );
  if (!trigger || document.querySelector("[data-profile-popover]")) return;
  const directSettings =
    document.querySelector<HTMLButtonElement>("[data-home-settings]");
  const popover = document.createElement("div");
  popover.className = "profile-popover";
  popover.dataset.profilePopover = "";
  popover.hidden = true;
  popover.setAttribute("role", "menu");
  popover.innerHTML = `
    <label class="field">
      <span>我的昵称</span>
      <input data-profile-nickname maxlength="16" value="${escapeHtml(getNickname())}" autocomplete="nickname" />
    </label>
    <div class="profile-popover-actions">
      <button class="btn btn-secondary" type="button" data-profile-save>
        <i data-lucide="check"></i><span>保存昵称</span>
      </button>
      ${
        directSettings
          ? ""
          : `<button class="btn btn-ghost" type="button" data-open-settings>
               <i data-lucide="settings"></i><span>设置</span>
             </button>`
      }
    </div>
  `;
  document.body.append(popover);
  hydrateIcons(popover);
  const floating = new FloatingSurface(trigger, popover, {
    placement: "top-start",
    closeOnOutside: true,
  });
  trigger.addEventListener("click", () => void floating.toggle(), {
    signal: viewAbortController.signal,
  });
  directSettings?.addEventListener(
    "click",
    () => {
      void floating.close().then(() =>
        settingsController.open(directSettings),
      );
    },
    { signal: viewAbortController.signal },
  );
  popover
    .querySelector("[data-profile-save]")
    ?.addEventListener(
      "click",
      () => {
        const input =
          popover.querySelector<HTMLInputElement>("[data-profile-nickname]");
        if (!input) return;
        input.value = saveNickname(input.value);
        const initial =
          trigger.querySelector<HTMLElement>("[data-profile-initial]");
        const name = trigger.querySelector<HTMLElement>("[data-profile-name]");
        if (initial) initial.textContent = channelInitial(input.value);
        if (name) name.textContent = input.value;
        if (!initial && !name) trigger.textContent = channelInitial(input.value);
        trigger.title = directSettings ? "修改昵称" : input.value;
        trigger.setAttribute(
          "aria-label",
          directSettings
            ? `修改昵称，当前昵称 ${input.value}`
            : `个人资料与设置，当前昵称 ${input.value}`,
        );
        toast("昵称已保存");
        void floating.close();
      },
      { signal: viewAbortController.signal },
    );
  popover
    .querySelector("[data-open-settings]")
    ?.addEventListener(
      "click",
      () => {
        void floating.close().then(() =>
          settingsController.open(trigger),
        );
      },
      { signal: viewAbortController.signal },
    );
  viewAbortController.signal.addEventListener(
    "abort",
    () => {
      floating.destroy();
      popover.remove();
    },
    { once: true },
  );
}

function bindRecentMenus(): void {
  document
    .querySelectorAll<HTMLButtonElement>("[data-recent-menu]")
    .forEach((trigger) => {
      const room = trigger.dataset.recentMenu;
      const card = room
        ? document.querySelector<HTMLElement>(
            `[data-recent-card="${CSS.escape(room)}"]`,
          )
        : undefined;
      if (!room || !card) return;
      const enter = card.querySelector<HTMLButtonElement>(
        "[data-recent-room]",
      );
      const menu = document.createElement("div");
      menu.className = "recent-menu";
      menu.hidden = true;
      menu.setAttribute("role", "menu");
      menu.innerHTML = `
        <button class="btn btn-ghost" type="button" role="menuitem" data-menu-enter>
          <i data-lucide="play"></i><span>进入频道</span>
        </button>
        <button class="btn btn-danger" type="button" role="menuitem" data-menu-delete>
          <i data-lucide="trash-2"></i><span>删除历史</span>
        </button>
      `;
      document.body.append(menu);
      hydrateIcons(menu);
      const floating = new FloatingSurface(trigger, menu, {
        placement: "bottom-end",
        closeOnOutside: true,
      });
      trigger.addEventListener(
        "click",
        () => void floating.toggle(),
        { signal: viewAbortController.signal },
      );
      menu
        .querySelector("[data-menu-enter]")
        ?.addEventListener(
          "click",
          () => {
            void floating.close();
            enter?.click();
          },
          { signal: viewAbortController.signal },
        );
      menu
        .querySelector("[data-menu-delete]")
        ?.addEventListener(
          "click",
          () => {
            void floating.close();
            if (enter) requestRecentChannelDeletion(enter);
          },
          { signal: viewAbortController.signal },
        );
      viewAbortController.signal.addEventListener(
        "abort",
        () => {
          floating.destroy();
          menu.remove();
        },
        { once: true },
      );
    });
}

function requestRecentChannelDeletion(
  button: HTMLButtonElement,
): void {
  if (document.querySelector("[data-recent-delete-dialog]")) {
    return;
  }
  const room = button.dataset.recentRoom;
  if (!room) {
    return;
  }
  const name = button.dataset.recentName || room;
  const dialog = document.createElement("dialog");
  dialog.className = "recent-delete-dialog";
  dialog.dataset.recentDeleteDialog = "";
  dialog.setAttribute("aria-labelledby", "recent-delete-title");
  dialog.innerHTML = `
    <div class="delete-dialog-icon" aria-hidden="true"><i data-lucide="trash-2"></i></div>
    <span class="eyebrow">REMOVE FROM HISTORY</span>
    <h2 id="recent-delete-title">删除这个历史频道？</h2>
    <p><strong>${escapeHtml(name)}</strong><span>${escapeHtml(room)}</span></p>
    <small>只会从这台设备的历史记录中移除，不会关闭频道。</small>
    <div class="delete-dialog-actions">
      <button class="btn btn-secondary" type="button" data-cancel-recent-delete>取消</button>
      <button class="btn btn-danger" type="button" data-confirm-recent-delete>删除</button>
    </div>
  `;
  document.body.append(dialog);
  hydrateIcons(dialog);

  const closeDialog = async (): Promise<void> => {
    await dialogController.close(dialog);
    dialog.remove();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void closeDialog();
  });
  dialog
    .querySelector("[data-cancel-recent-delete]")
    ?.addEventListener("click", () => void closeDialog());
  dialog
    .querySelector("[data-confirm-recent-delete]")
    ?.addEventListener("click", () => {
      if (forgetRecentChannel(room)) {
        document
          .querySelectorAll<HTMLElement>(
            `[data-recent-room="${CSS.escape(room)}"]`,
          )
          .forEach((entry) => {
            const card = entry.closest("[data-recent-card]");
            if (card) card.remove();
            else entry.remove();
          });
        toast(`已从历史记录删除频道 ${room}`);
      }
      void closeDialog();
    });
  void dialogController.open(dialog, button);
}

function bindRecentChannelInteractions(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-recent-room]").forEach((button) => {
    let longPressTimer: number | undefined;
    let suppressNextClick = false;
    let pointerStart = { x: 0, y: 0 };

    const cancelLongPress = (): void => {
      if (longPressTimer !== undefined) {
        window.clearTimeout(longPressTimer);
        longPressTimer = undefined;
      }
      button.classList.remove("is-long-pressing");
    };

    button.addEventListener("pointerdown", (event) => {
      if (isDesktop) {
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      cancelLongPress();
      pointerStart = { x: event.clientX, y: event.clientY };
      button.setPointerCapture?.(event.pointerId);
      button.classList.add("is-long-pressing");
      longPressTimer = window.setTimeout(() => {
        longPressTimer = undefined;
        suppressNextClick = true;
        button.classList.remove("is-long-pressing");
        const room = button.dataset.recentRoom;
        if (!room) {
          suppressNextClick = false;
          return;
        }
        navigator.vibrate?.(35);
        requestRecentChannelDeletion(button);
      }, 650);
    });
    button.addEventListener("pointermove", (event) => {
      if (
        Math.hypot(
          event.clientX - pointerStart.x,
          event.clientY - pointerStart.y,
        ) > 10
      ) {
        cancelLongPress();
      }
    });
    const finishLongPress = (): void => {
      cancelLongPress();
      if (suppressNextClick) {
        window.setTimeout(() => {
          suppressNextClick = false;
        });
      }
    };
    button.addEventListener("pointerup", finishLongPress);
    button.addEventListener("pointercancel", finishLongPress);
    button.addEventListener("lostpointercapture", cancelLongPress);
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (isDesktop) {
        requestRecentChannelDeletion(button);
      }
    });
    button.addEventListener("click", (event) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (button.dataset.recentNavigationDisabled === "true") {
        return;
      }
      navigate(
        () =>
          renderViewer({
            desktop: isDesktop,
            room: button.dataset.recentRoom,
            signalUrl: button.dataset.recentSignal,
            autoJoin: true,
          }),
        "recent-channel",
      );
    });
  });
}

/* ─── Star field ─────────────────────────────────────────────────── */
let starCanvas: HTMLCanvasElement | null = null;
let starController: AbortController | undefined;

function startStarField(): void {
  stopStarField();
  const canvas = document.createElement("canvas");
  canvas.id = "star-canvas";
  canvas.className = "star-field-canvas";
  canvas.dataset.decorativeMotion = "";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  starCanvas = canvas;
  const controller = new AbortController();
  starController = controller;
  bindStarField(canvas, controller.signal);
}

function stopStarField(): void {
  starController?.abort();
  starController = undefined;
  starCanvas?.remove();
  starCanvas = null;
}

function logoMarkup(label: string): string {
  return `
    <div class="wordmark">
      <img class="wordmark-icon" src="./brand-mark.svg" width="28" height="28" alt="" aria-hidden="true" />
      <div><strong>同频</strong><small>${escapeHtml(label)}</small></div>
    </div>
  `;
}

async function refreshSignalHealthBadges(
  signal: AbortSignal,
): Promise<void> {
  const elements = [
    ...document.querySelectorAll<HTMLElement>("[data-signal-health]"),
  ];
  const groups = new Map<string, HTMLElement[]>();
  for (const element of elements) {
    const url = element.dataset.signalHealth;
    if (!url) continue;
    groups.set(url, [...(groups.get(url) || []), element]);
  }
  await Promise.all(
    [...groups].map(async ([url, targets]) => {
      const health = await probeSignalHealth(url, signal);
      if (signal.aborted) return;
      for (const target of targets) {
        target.dataset.state = health.state;
        const label =
          target.querySelector<HTMLElement>("[data-health-label]") ||
          target.querySelector<HTMLElement>("span:last-child");
        if (label) {
          label.textContent =
            health.state === "online"
              ? `服务可用${health.latencyMs ? ` · ${health.latencyMs}ms` : ""}`
              : "暂时无法连接";
        }
      }
    }),
  );
}

function renderDesktopHome(): void {
  hideEmbeddedGame();
  stopStarField();
  appRoot.innerHTML = `
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <div class="app-frame home-frame">
      <main class="home-main" id="main-content" tabindex="-1">
        <header class="home-topbar">
          ${logoMarkup("朋友放映室")}
          <button class="home-service" type="button"
            data-signal-health="${escapeHtml(getSignalUrl())}"
            data-state="checking" aria-live="polite"
            aria-label="当前信令服务状态">
            <span class="status-symbol" aria-hidden="true"></span>
            <span data-health-label>正在检查服务</span>
          </button>
        </header>
        <section class="home-hero">
          <div class="hero-copy">
            <span class="eyebrow">PRIVATE WATCH PARTY</span>
            <h1>今晚，和朋友<br /><em>同频看点好的。</em></h1>
          </div>
          <div class="home-actions" aria-label="频道操作">
            <button id="choose-host" class="home-action-card interactive-card create-action" type="button">
              <span class="action-icon"><i data-lucide="plus"></i></span>
              <span class="stack">
                <small>建立一个新的私人空间</small>
                <strong>创建我的频道</strong>
                <p>先邀请朋友，再由任意 Windows 成员开始放映。</p>
              </span>
              <span class="icon-label">创建频道 <i data-lucide="user-plus"></i></span>
            </button>
            <button id="choose-viewer" class="home-action-card interactive-card join-action" type="button">
              <span class="action-icon"><i data-lucide="play"></i></span>
              <span class="stack">
                <small>使用房间码或邀请链接</small>
                <strong>加入朋友频道</strong>
                <p>自动同步成员、媒体线路、聊天与连麦状态。</p>
              </span>
              <span class="icon-label">加入频道 <i data-lucide="users"></i></span>
            </button>
          </div>
          <section class="recent-home-section" aria-labelledby="recent-heading">
            <div class="section-heading">
              <div><span class="eyebrow">QUICK JOIN</span><h2 id="recent-heading">快捷加入</h2></div>
              <small>仅保存在当前设备</small>
            </div>
            <div class="recent-home-grid">${recentHomeMarkup()}</div>
          </section>
        </section>
      </main>
      ${homeProfileMarkup()}
    </div>
  `;
  bindRailNavigation();
  hydrateIcons(appRoot);
  bindLocalPointerLight(appRoot, viewAbortController.signal);
  startStarField();
  void refreshSignalHealthBadges(viewAbortController.signal);
  document.querySelector("#choose-host")?.addEventListener("click", () =>
    navigate(() => renderHost(), "create-channel"),
  );
  document.querySelector("#choose-viewer")?.addEventListener("click", () =>
    navigate(() => renderViewer({ desktop: true }), "join-channel"),
  );
}

async function renderHost(): Promise<void> {
  hideEmbeddedGame();
  stopStarField();
  if (!window.roomDesktop) {
    return;
  }
  let signalUrl = getSignalUrl();
  const hostOwnership = await getHostChannelOwnership();
  const roomCode = hostOwnership.room;
  let nickname = getNickname();
  let channelName = getChannelName();

  appRoot.innerHTML = `
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <div class="app-frame">
      ${railMarkup()}
      <main class="setup-main" id="main-content" tabindex="-1">
        <header class="setup-topbar">
          ${logoMarkup("创建频道")}
          <button class="btn btn-ghost" type="button" data-back-home>
            <i data-lucide="arrow-left"></i><span>返回首页</span>
          </button>
        </header>
        <section class="single-task-shell">
          <div class="single-task-heading">
            <span class="eyebrow">CREATE A CHANNEL</span>
            <h1>创建今晚的同频空间</h1>
            <p>先进入频道并邀请朋友，之后任意 Windows 成员都可以开始放映。</p>
          </div>
          <form id="create-channel-form" class="setup-card setup-form material-card" novalidate>
            <label class="field">
              <span>频道名称</span>
              <input id="channel-name" maxlength="24" value="${escapeHtml(channelName)}"
                autocomplete="off" required aria-describedby="channel-name-help" />
              <small id="channel-name-help" class="field-help">会显示在邀请卡和频道大厅中。</small>
            </label>
            <label class="field">
              <span>你的昵称</span>
              <input id="host-nickname" maxlength="16" value="${escapeHtml(nickname)}"
                autocomplete="nickname" required />
            </label>
            <button id="start-share" class="btn btn-primary btn-lg form-primary-action"
              type="submit" data-state="idle">
              <span data-loading-label><i data-lucide="user-plus"></i>创建并进入频道</span>
            </button>
            <details class="advanced-settings">
              <summary><span class="icon-label"><i data-lucide="sliders-horizontal"></i>高级设置</span></summary>
              <div class="advanced-settings-content">
                <label class="field">
                  <span>信令服务器${isNativeAndroid() ? "（Android 仅支持 wss://）" : ""}</span>
                  <input id="host-signal-url" value="${escapeHtml(signalUrl)}" spellcheck="false" />
                  <small class="field-help">自建地址只有在你明确确认后才会使用。</small>
                </label>
                <output class="field-help" id="create-network-status" aria-live="polite">
                  频道码将在创建后显示为 ${escapeHtml(roomCode.slice(0, 4))} · ${escapeHtml(roomCode.slice(4))}
                </output>
              </div>
            </details>
          </form>
        </section>
      </main>
    </div>
  `;
  bindRailNavigation();
  hydrateIcons(appRoot);
  document.querySelector("[data-back-home]")?.addEventListener("click", () =>
    navigate(renderDesktopHome, "home"),
  );
  document
    .querySelector<HTMLInputElement>("#channel-name")
    ?.addEventListener("input", (event) => {
      channelName = saveChannelName(
        (event.currentTarget as HTMLInputElement).value,
      );
    });
  document
    .querySelector<HTMLFormElement>("#create-channel-form")
    ?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = document.querySelector<HTMLButtonElement>("#start-share");
    if (!submit || submit.disabled) return;
    nickname = saveNickname(
      document.querySelector<HTMLInputElement>("#host-nickname")?.value || nickname,
    );
    channelName = saveChannelName(
      document.querySelector<HTMLInputElement>("#channel-name")?.value || channelName,
    );
    try {
      const candidateSignal = normalizeAppSignalUrl(
        document.querySelector<HTMLInputElement>("#host-signal-url")?.value || signalUrl,
      );
      if (
        requiresSignalTrust(candidateSignal) &&
        !(await requestSignalTrust(candidateSignal, roomCode, submit))
      ) {
        return;
      }
      signalUrl = saveSignalUrl(candidateSignal);
      submit.disabled = true;
      submit.dataset.state = "loading";
      submit.setAttribute("aria-busy", "true");
      await openSession({
        root: appRoot,
        desktop: true,
        room: roomCode,
        signalUrl,
        nickname,
        channelName,
        createIfMissing: true,
        ownerToken: hostOwnership.ownerToken,
        notify: toast,
        onLeave: () => {
          resetViewLifecycle();
          renderDesktopHome();
        },
        showInviteOnStart: true,
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : "无法进入频道", "danger");
      submit.disabled = false;
      submit.dataset.state = "error";
      submit.removeAttribute("aria-busy");
    }
  }, { signal: viewAbortController.signal });
}

interface ViewerOptions {
  desktop?: boolean;
  room?: string;
  signalUrl?: string;
  autoJoin?: boolean;
}

function cleanRoomCode(value: string): string {
  const parsed = parseJoinLink(value.trim());
  const candidate = parsed.room || value;
  return candidate
    .toUpperCase()
    .replace(/[^23456789A-HJ-NP-Z]/g, "")
    .slice(0, 8);
}

function displayRoomCode(value: string): string {
  const room = cleanRoomCode(value);
  return room.length > 4
    ? `${room.slice(0, 4)} · ${room.slice(4)}`
    : room;
}

async function renderViewer(options: ViewerOptions = {}): Promise<void> {
  hideEmbeddedGame();
  stopStarField();
  const desktop = options.desktop === true;
  let signalUrl = options.signalUrl || getSignalUrl();
  let roomCode = cleanRoomCode(
    options.room ||
      new URLSearchParams(location.search).get("room") ||
      "",
  );
  let nickname = getNickname();
  let joinAbortController: AbortController | undefined;
  const mobileRecentChannels = desktop ? "" : mobileRecentJoinMarkup();

  const querySignal = new URLSearchParams(location.search).get("signal");
  if (querySignal) {
    try {
      signalUrl = normalizeAppSignalUrl(querySignal);
    } catch {
      // Ignore malformed invitation data.
    }
  }

  appRoot.innerHTML = `
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <div class="app-frame">
      ${railMarkup()}
      <main class="join-main" id="main-content" tabindex="-1">
        <header class="setup-topbar">
          ${logoMarkup(desktop ? "加入频道" : "移动观看")}
          ${desktop ? `<button class="btn btn-ghost" type="button" data-back-home><i data-lucide="arrow-left"></i><span>返回首页</span></button>` : ""}
        </header>
        <section class="single-task-shell">
          <div class="single-task-heading">
            <span class="eyebrow">JOIN A CHANNEL</span>
            <h1>加入朋友的频道</h1>
            <p>输入 8 位频道码、粘贴邀请链接，或从最近频道继续。</p>
          </div>
          ${
            mobileRecentChannels
              ? `<section class="mobile-recent-join" aria-labelledby="mobile-recent-heading">
                   <header><h2 id="mobile-recent-heading">最近加入</h2><small>仅保存在这台设备</small></header>
                   <div class="mobile-recent-join-list">${mobileRecentChannels}</div>
                 </section>`
              : ""
          }
          <form id="join-channel-form" class="join-card join-form material-card" novalidate>
            <div class="room-code-wrap">
            <label class="field">
              <span>频道码</span>
              <input id="room-input" class="room-code-input" maxlength="10"
                value="${escapeHtml(displayRoomCode(roomCode))}"
                placeholder="A7K9 · P2WX" autocomplete="one-time-code"
                autocapitalize="characters" spellcheck="false"
                aria-describedby="room-input-help room-input-error" />
              <small id="room-input-help" class="field-help">也可以直接粘贴完整邀请链接。</small>
              <small id="room-input-error" class="field-error" role="alert"></small>
            </label>
            </div>
            <div class="join-tools">
              ${
                isNativeAndroid()
                  ? `<button id="scan-room-qr" class="btn btn-secondary" type="button"><i data-lucide="scan-line"></i><span>扫描二维码</span></button>`
                  : ""
              }
              ${
                desktop && getRecentChannels().length
                  ? `<label class="field recent-select"><span>最近频道</span><select id="recent-room-select"><option value="">选择最近频道</option>${getRecentChannels()
                      .map(
                        (channel) =>
                          `<option value="${escapeHtml(channel.room)}" data-signal="${escapeHtml(channel.signalUrl)}">${escapeHtml(channel.name)} · ${escapeHtml(channel.room.slice(0, 4))} ${escapeHtml(channel.room.slice(4))}</option>`,
                      )
                      .join("")}</select></label>`
                  : ""
              }
            </div>
            <label class="field">
              <span>你的昵称</span>
              <input id="viewer-nickname" maxlength="16" value="${escapeHtml(nickname)}" autocomplete="nickname" required />
            </label>
            <button id="join-room" class="btn btn-primary btn-lg form-primary-action"
              type="submit" data-state="idle" ${roomCode.length === 8 ? "" : "disabled"}>
              <span data-loading-label><i data-lucide="play"></i>进入频道</span>
            </button>
            <section id="join-progress" class="connection-progress" aria-live="polite" hidden>
              <div class="connection-step" data-join-step="server" data-state="active"><i data-lucide="circle"></i><span>正在连接服务器</span></div>
              <div class="connection-step" data-join-step="room"><i data-lucide="circle"></i><span>正在加入频道</span></div>
              <div class="connection-step" data-join-step="members"><i data-lucide="circle"></i><span>正在同步成员</span></div>
              <div class="connection-step" data-join-step="media"><i data-lucide="circle"></i><span>正在准备媒体线路</span></div>
              <button id="cancel-join" class="btn btn-secondary" type="button">取消加入</button>
            </section>
            <details class="advanced-settings">
              <summary><span class="icon-label"><i data-lucide="sliders-horizontal"></i>高级设置</span></summary>
              <div class="advanced-settings-content">
                <label class="field">
                  <span>信令服务器${isNativeAndroid() ? "（Android 仅支持 wss://）" : ""}</span>
                  <input id="viewer-signal-url" value="${escapeHtml(signalUrl)}" spellcheck="false" />
                </label>
              </div>
            </details>
          </form>
        </section>
      </main>
    </div>
  `;
  bindRailNavigation();
  hydrateIcons(appRoot);
  document.querySelector("[data-back-home]")?.addEventListener("click", () =>
    navigate(renderDesktopHome, "home"),
  );
  const roomInput = document.querySelector<HTMLInputElement>("#room-input");
  const joinButton = document.querySelector<HTMLButtonElement>("#join-room");
  const applyInvitationText = (value: string): void => {
    const parsed = parseJoinLink(value);
    roomCode = cleanRoomCode(parsed.room || value);
    if (roomInput) {
      roomInput.value = displayRoomCode(roomCode);
      roomInput.removeAttribute("aria-invalid");
    }
    const error =
      document.querySelector<HTMLElement>("#room-input-error");
    if (error) error.textContent = "";
    joinButton?.toggleAttribute("disabled", roomCode.length !== 8);
    if (parsed.signal) {
      try {
        signalUrl = normalizeAppSignalUrl(parsed.signal);
        const signalInput =
          document.querySelector<HTMLInputElement>("#viewer-signal-url");
        if (signalInput) signalInput.value = signalUrl;
      } catch {
        toast("邀请中的服务器地址无效", "danger");
      }
    }
  };
  roomInput?.addEventListener("input", () =>
    applyInvitationText(roomInput.value),
  );
  roomInput?.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") || "";
    if (!text) return;
    event.preventDefault();
    applyInvitationText(text);
  });
  document
    .querySelector<HTMLSelectElement>("#recent-room-select")
    ?.addEventListener("change", (event) => {
      const select = event.currentTarget as HTMLSelectElement;
      const option = select.selectedOptions[0];
      applyInvitationText(option.value);
      if (option.dataset.signal) {
        signalUrl = option.dataset.signal;
        const input =
          document.querySelector<HTMLInputElement>("#viewer-signal-url");
        if (input) input.value = signalUrl;
      }
    });
  document
    .querySelectorAll<HTMLButtonElement>("[data-mobile-recent-room]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        applyInvitationText(button.dataset.mobileRecentRoom || "");
        if (button.dataset.mobileRecentSignal) {
          signalUrl = button.dataset.mobileRecentSignal;
          const input =
            document.querySelector<HTMLInputElement>("#viewer-signal-url");
          if (input) input.value = signalUrl;
        }
        void joinRoom();
      });
    });
  document
    .querySelector<HTMLButtonElement>("#scan-room-qr")
    ?.addEventListener("click", async (event) => {
      const scanned = await scanQrCode(
        event.currentTarget as HTMLButtonElement,
      );
      if (scanned) applyInvitationText(scanned);
    });
  document
    .querySelector<HTMLButtonElement>("#cancel-join")
    ?.addEventListener("click", () => {
      joinAbortController?.abort();
      if (desktop) navigate(renderDesktopHome, "home");
      else {
        resetViewLifecycle();
        void renderViewer({ desktop: false });
      }
    });
  document
    .querySelector<HTMLFormElement>("#join-channel-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      void joinRoom();
    });
  if (options.autoJoin && roomCode.length === 8) {
    requestAnimationFrame(() => void joinRoom());
  }

  async function joinRoom(): Promise<void> {
    roomCode = cleanRoomCode(roomInput?.value || roomCode);
    if (roomCode.length !== 8) {
      roomInput?.setAttribute("aria-invalid", "true");
      const error =
        document.querySelector<HTMLElement>("#room-input-error");
      if (error) error.textContent = "请输入完整的 8 位频道码。";
      roomInput?.focus();
      return;
    }
    nickname = saveNickname(
      document.querySelector<HTMLInputElement>("#viewer-nickname")?.value || nickname,
    );
    const progress =
      document.querySelector<HTMLElement>("#join-progress");
    const submit = document.querySelector<HTMLButtonElement>("#join-room");
    try {
      const candidateSignal = normalizeAppSignalUrl(
        document.querySelector<HTMLInputElement>("#viewer-signal-url")
          ?.value || signalUrl,
      );
      if (
        requiresSignalTrust(candidateSignal) &&
        !(await requestSignalTrust(candidateSignal, roomCode, submit ?? undefined))
      ) {
        return;
      }
      signalUrl = saveSignalUrl(candidateSignal);
      submit?.setAttribute("aria-busy", "true");
      if (submit) {
        submit.disabled = true;
        submit.dataset.state = "loading";
      }
      if (progress) progress.hidden = false;
      joinAbortController?.abort();
      joinAbortController = new AbortController();
      const hostOwnership = desktop
        ? await getHostChannelOwnership()
        : undefined;
      const ownerToken =
        hostOwnership?.room === roomCode
          ? hostOwnership.ownerToken
          : undefined;
      await openSession({
        root: appRoot,
        desktop,
        room: roomCode,
        signalUrl,
        nickname,
        createIfMissing: Boolean(ownerToken),
        ownerToken,
        notify: toast,
        onLeave: () => {
          resetViewLifecycle();
          if (desktop) renderDesktopHome();
          else void renderViewer({ desktop: false });
        },
        operationSignal: joinAbortController.signal,
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : "加入失败", "danger");
      if (submit?.isConnected) {
        submit.disabled = false;
        submit.dataset.state = "error";
        submit.removeAttribute("aria-busy");
      }
      if (progress?.isConnected) progress.hidden = true;
    }
  }
}

settingsController = new SettingsController({
  notify: toast,
});
if (isNativeAndroid()) {
  void App.addListener("backButton", () => {
    if (document.querySelector(".session-shell")) return;
    if (dialogController.closeTopmost()) return;
    if (closeTopmostFloatingSurface()) return;
    const backHome =
      document.querySelector<HTMLButtonElement>("[data-back-home]");
    if (backHome) {
      backHome.click();
      return;
    }
    void App.exitApp();
  }).then((handle) => {
    appBackButtonHandle = handle;
  });
}
document.addEventListener("synced:open-settings", (event) => {
  const detail = (
    event as CustomEvent<
      "appearance" | "network" | "emby" | "about"
    >
  ).detail;
  void settingsController.open(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined,
    detail || "appearance",
  );
});

window.addEventListener("beforeunload", () => {
  viewAbortController.abort();
  stopStarField();
  void appBackButtonHandle?.remove();
  appBackButtonHandle = undefined;
  settingsController.destroy();
  effectsQuality.destroy();
});

if (isDesktop) {
  resetViewLifecycle();
  if (new URLSearchParams(location.search).get("design-lab") === "1") {
    renderDesignLab(appRoot, () =>
      navigate(renderDesktopHome, "home"),
    );
  } else {
    renderDesktopHome();
  }
  window.roomDesktop?.onOpenUrl((url) => {
    void confirmExternalInvite(url).then((invite) => {
      if (!invite) return;
      navigate(
        () =>
          renderViewer({
            desktop: true,
            room: invite.room,
            signalUrl: invite.signalUrl,
            autoJoin: true,
          }),
        "deep-link",
      );
    });
  });
} else {
  void (async () => {
    let recentInviteKey = "";
    let recentInviteAt = 0;
    let recentInviteHandled = false;
    let recentInvitePromise: Promise<boolean> | undefined;
    const openInvite = async (url?: string): Promise<boolean> => {
      if (!url) return false;
      const parsedForKey = parseJoinLink(url);
      const inviteKey = parsedForKey.room
        ? `${parsedForKey.room}|${parsedForKey.signal || getSignalUrl()}`
        : url;
      const now = Date.now();
      // Capacitor can deliver one cold-start URI through both appUrlOpen and
      // getLaunchUrl(). Treat the duplicate as the same completed decision:
      // accepted links must not create two sessions, and a rejected unknown
      // host must not prompt twice. The short window still permits a later,
      // deliberate re-open of the same invitation.
      if (inviteKey === recentInviteKey && now - recentInviteAt < 10_000) {
        return recentInvitePromise || recentInviteHandled;
      }
      recentInviteKey = inviteKey;
      recentInviteAt = now;
      const operation = confirmExternalInvite(url).then((invite) => {
        recentInviteHandled = Boolean(invite);
        if (!invite) return false;
        resetViewLifecycle();
        void renderViewer({
          room: invite.room,
          signalUrl: invite.signalUrl,
          autoJoin: true,
        });
        return true;
      });
      recentInvitePromise = operation;
      try {
        return await operation;
      } finally {
        if (recentInvitePromise === operation) {
          recentInvitePromise = undefined;
        }
      }
    };
    const appUrlListener = await App.addListener("appUrlOpen", ({ url }) => {
      void openInvite(url);
    });
    window.addEventListener("beforeunload", () => {
      void appUrlListener.remove();
    });
    const launch = await App.getLaunchUrl().catch(() => undefined);
    if (!(await openInvite(launch?.url))) {
      resetViewLifecycle();
      await renderViewer();
    }
  })();
}
