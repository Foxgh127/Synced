import { App } from "@capacitor/app";
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
import { openChannelSession } from "./channel-session";
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

migrateStorageIdentity(localStorage);

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) {
  throw new Error("Missing application root");
}
const appRoot: HTMLDivElement = root;

const DEFAULT_SIGNAL_URL = HOME_SIGNAL_URL;
const isDesktop = Boolean(window.roomDesktop);
const signalUrlPolicy = { allowInsecure: !isNativeAndroid() } as const;

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

function getOrCreateToastContainer(): HTMLElement {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.setAttribute("aria-label", "通知");
    document.body.append(container);
  }
  return container;
}

function removeToast(element: Element | null): void {
  if (!element?.parentNode) return;
  const toastElement = element as HTMLElement;
  toastElement.classList.add("is-leaving");
  window.setTimeout(() => toastElement.remove(), 160);
}

function toast(
  message: string,
  type: ToastType | boolean = "info",
): void {
  const tone: ToastType =
    type === true ? "danger" : type === false ? "info" : type;
  const container = getOrCreateToastContainer();
  const element = document.createElement("div");
  element.className = `toast toast-${tone}`;
  element.setAttribute("role", tone === "danger" ? "alert" : "status");
  element.innerHTML = `
    <span class="toast-bar" aria-hidden="true"></span>
    <span class="toast-text">${escapeHtml(message)}</span>
    <button class="btn btn-ghost btn-icon btn-icon-sm toast-close" type="button" aria-label="关闭通知">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18"></path>
      </svg>
    </button>
  `;
  element
    .querySelector(".toast-close")
    ?.addEventListener("click", () => removeToast(element));
  container.append(element);
  const all = container.querySelectorAll(".toast");
  if (all.length > 3) removeToast(all[0]);
  window.setTimeout(() => removeToast(element), 5_000);
}

function confirmExternalInvite(
  inviteUrl: string,
): { room: string; signalUrl: string } | undefined {
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
  const message = [
    "⚠️ 注意：此邀请使用了陌生的信令服务器",
    "",
    `服务器：${describeSignalHost(signalUrl)}`,
    `频道：${parsed.room}`,
    "",
    "只接受你认识的人发来的邀请链接。",
    "加入后不会自动开启麦克风。",
  ].join("\n");
  const accepted = window.confirm(message);
  return accepted ? { room: parsed.room, signalUrl } : undefined;
}

function channelInitial(name: string): string {
  return Array.from(name)[0] || "频";
}

function recentMarkup(disabled = false): string {
  const recent = getRecentChannels();
  if (!recent.length) {
    return `<p class="recent-empty">加入过的频道会留在这里</p>`;
  }
  const actionHint = isDesktop ? "左键进入，右键删除" : "短按进入，长按删除";
  return recent
    .map(
      (channel) => `
        <button
          class="recent-channel"
          data-recent-room="${escapeHtml(channel.room)}"
          data-recent-name="${escapeHtml(channel.name)}"
          data-recent-signal="${escapeHtml(channel.signalUrl)}"
          data-recent-navigation-disabled="${disabled ? "true" : "false"}"
          aria-label="${escapeHtml(channel.name)}，${actionHint}"
          aria-disabled="${disabled ? "true" : "false"}"
          title="${escapeHtml(channel.name)} · ${actionHint}"
        >
          <span>${escapeHtml(channelInitial(channel.name))}</span>
          <b>${escapeHtml(channel.name)}</b>
          <small>${channel.room}</small>
        </button>
      `,
    )
    .join("");
}

function railMarkup(disabled = false): string {
  return `
    <aside class="channel-rail">
      <div class="rail-logo rail-identity" role="img" aria-label="同频">
        <img src="./brand-mark-dark.svg" width="26" height="26" alt="" aria-hidden="true" />
      </div>
      <div class="rail-divider"></div>
      <div class="recent-list" aria-label="最近加入的频道">
        ${recentMarkup(disabled)}
      </div>
      <button class="rail-add" data-join-button aria-label="加入新频道">＋</button>
      <div class="rail-spacer"></div>
      <div class="profile-orb" title="${escapeHtml(getNickname())}">
        ${escapeHtml(channelInitial(getNickname()))}
      </div>
    </aside>
  `;
}

function bindRailNavigation(): void {
  document.querySelector("[data-join-button]")?.addEventListener("click", () => {
    void renderViewer({ desktop: isDesktop });
  });
  bindRecentChannelInteractions();
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
  dialog.innerHTML = `
    <div class="delete-dialog-icon" aria-hidden="true">−</div>
    <span class="eyebrow">REMOVE FROM HISTORY</span>
    <h2>删除这个历史频道？</h2>
    <p><strong>${escapeHtml(name)}</strong><span>${escapeHtml(room)}</span></p>
    <small>只会从这台设备的历史记录中移除，不会关闭频道。</small>
    <div class="delete-dialog-actions">
      <button class="ghost-button" type="button" data-cancel-recent-delete>取消</button>
      <button class="delete-confirm-button" type="button" data-confirm-recent-delete>删除</button>
    </div>
  `;
  document.body.append(dialog);

  const closeDialog = (): void => {
    if (dialog.open) {
      dialog.close();
    }
    dialog.remove();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  dialog
    .querySelector("[data-cancel-recent-delete]")
    ?.addEventListener("click", closeDialog);
  dialog
    .querySelector("[data-confirm-recent-delete]")
    ?.addEventListener("click", () => {
      if (forgetRecentChannel(room)) {
        const list = button.closest<HTMLElement>(".recent-list");
        button.remove();
        if (list && !list.querySelector("[data-recent-room]")) {
          list.innerHTML = `<p class="recent-empty">加入过的频道会留在这里</p>`;
        }
        toast(`已从历史记录删除频道 ${room}`);
      }
      closeDialog();
    });
  dialog.showModal();
  dialog
    .querySelector<HTMLButtonElement>("[data-cancel-recent-delete]")
    ?.focus();
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
      void renderViewer({
        desktop: isDesktop,
        room: button.dataset.recentRoom,
        signalUrl: button.dataset.recentSignal,
        autoJoin: true,
      });
    });
  });
}

/* ─── Star field ─────────────────────────────────────────────────── */
let starCanvas: HTMLCanvasElement | null = null;
let starAnimId = 0;

function startStarField(): void {
  if (starCanvas) return;
  const canvas = document.createElement("canvas");
  canvas.id = "star-canvas";
  document.body.prepend(canvas);
  starCanvas = canvas;

  type Star = { x: number; y: number; r: number; a: number; da: number; speed: number };
  const stars: Star[] = [];
  const COUNT = 180;

  const resize = (): void => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resize();
  window.addEventListener("resize", resize, { passive: true });

  for (let i = 0; i < COUNT; i++) {
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.2 + 0.2,
      a: Math.random(),
      da: (Math.random() - 0.5) * 0.004,
      speed: Math.random() * 0.06 + 0.01,
    });
  }

  const draw = (): void => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      s.a = Math.max(0.05, Math.min(0.9, s.a + s.da));
      if (s.a <= 0.05 || s.a >= 0.9) s.da *= -1;
      s.y -= s.speed;
      if (s.y < -2) { s.y = canvas.height + 2; s.x = Math.random() * canvas.width; }
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${s.a.toFixed(2)})`;
      ctx.fill();
    }
    starAnimId = requestAnimationFrame(draw);
  };
  draw();
}

function stopStarField(): void {
  if (starAnimId) { cancelAnimationFrame(starAnimId); starAnimId = 0; }
  starCanvas?.remove();
  starCanvas = null;
}

/* ─── Cursor glow ────────────────────────────────────────────────── */
function startCursorGlow(): void {
  if (document.getElementById("cursor-glow")) return;
  const glow = document.createElement("div");
  glow.id = "cursor-glow";
  document.body.appendChild(glow);
  let raf = 0;
  let cx = -500, cy = -500;
  document.addEventListener("mousemove", (event) => {
    cx = event.clientX;
    cy = event.clientY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      glow.style.transform = `translate(${cx - 110}px, ${cy - 110}px)`;
    });
  }, { passive: true });
}

function logoMarkup(label: string): string {
  return `
    <div class="wordmark">
      <img class="wordmark-icon" src="./brand-mark.svg" width="28" height="28" alt="" aria-hidden="true" />
      <div><strong>同频</strong><small>${escapeHtml(label)}</small></div>
    </div>
  `;
}

function renderDesktopHome(): void {
  hideEmbeddedGame();
  startStarField();
  startCursorGlow();
  appRoot.innerHTML = `
    <div class="app-frame">
      ${railMarkup()}
      <main class="home-main">
        <header class="home-topbar">
          ${logoMarkup("朋友放映室")}
          <label class="profile-field">
            <span>我的昵称</span>
            <input id="home-nickname" maxlength="16" value="${escapeHtml(getNickname())}" />
          </label>
        </header>
        <section class="home-hero">
          <div class="hero-copy">
            <span class="eyebrow">PRIVATE WATCH PARTY</span>
            <h1>今晚，和朋友<br /><em>同频看点好的。</em></h1>
            <p>选择播放器窗口，影片声音只从该窗口的进程采集；朋友用房间码进入，就能看、聊、连麦。</p>
            <div class="hero-trust">
              <span>● 大陆服务器在线</span>
              <span>● 画面点对点直传</span>
              <span>● 最多 5 人</span>
            </div>
          </div>
          <div class="home-actions" aria-label="选择功能">
            <button id="choose-host" class="mode-card host-mode" data-desktop-role="host">
              <span class="mode-icon">▣</span>
              <small>我是放映者</small>
              <strong>开启我的频道</strong>
              <p>选择窗口 · 独立影片声 · 原画直传</p>
              <b>开始放映 →</b>
            </button>
            <button id="choose-viewer" class="mode-card viewer-mode" data-desktop-role="viewer">
              <span class="mode-icon">▶</span>
              <small>我是观看者</small>
              <strong>加入朋友频道</strong>
              <p>最近频道一键重进，也可输入房间码</p>
              <b>加入频道 →</b>
            </button>
          </div>
        </section>
        <footer class="home-footer">
          <span>服务器仅帮助设备相互找到</span>
          <span>影片不会上传或保存</span>
          <span>连麦约 128–160 kbps / 人</span>
        </footer>
      </main>
    </div>
  `;
  bindRailNavigation();
  document.querySelector<HTMLInputElement>("#home-nickname")?.addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    input.value = saveNickname(input.value);
    toast("昵称已保存");
  });
  document.querySelector("#choose-host")?.addEventListener("click", () => void renderHost());
  document.querySelector("#choose-viewer")?.addEventListener("click", () =>
    void renderViewer({ desktop: true }),
  );
}

async function renderHost(): Promise<void> {
  hideEmbeddedGame();
  stopStarField();
  startCursorGlow();
  if (!window.roomDesktop) {
    return;
  }
  let signalUrl = getSignalUrl();
  const hostOwnership = await getHostChannelOwnership();
  const roomCode = hostOwnership.room;
  let nickname = getNickname();
  let channelName = getChannelName();

  appRoot.innerHTML = `
    <div class="app-frame">
      ${railMarkup()}
      <main class="setup-main">
        <header class="setup-topbar">
          ${logoMarkup("设置放映")}
          <button class="ghost-button" data-back-home>返回首页</button>
        </header>
        <section class="setup-grid">
          <div class="setup-copy">
            <span class="eyebrow">YOUR CHANNEL · ${roomCode}</span>
            <h1>先进入频道，<br /><em>再决定谁来放映。</em></h1>
            <p>频道创建后，所有人可以先连麦和聊天；任意 Windows 成员都能点击“开始放映”并选择自己的播放器窗口。</p>
            <div class="privacy-callout">
              <span aria-hidden="true">◎</span>
              <div><strong>影片声与连麦声完全分轨</strong><small>需要 Windows 10 2004 或更高版本</small></div>
            </div>
          </div>
          <div class="setup-card">
            <label class="field">
              <span>频道名称</span>
              <input id="channel-name" maxlength="24" value="${escapeHtml(channelName)}" />
            </label>
            <label class="field">
              <span>你的昵称</span>
              <input id="host-nickname" maxlength="16" value="${escapeHtml(nickname)}" />
            </label>
            <button id="start-share" class="primary-button">
              <span aria-hidden="true">▣</span>
              <div><strong>创建并进入频道</strong><small>进入后再选择放映或观看</small></div>
              <b aria-hidden="true">→</b>
            </button>
            <details class="server-settings">
              <summary>服务器设置</summary>
              <label class="field">
                <span>信令服务器${isNativeAndroid() ? "（Android 仅支持 wss://）" : ""}</span>
                <input id="host-signal-url" value="${escapeHtml(signalUrl)}" />
              </label>
              <button id="save-host-server" type="button" class="ghost-button">保存服务器</button>
            </details>
          </div>
        </section>
      </main>
    </div>
  `;
  bindRailNavigation();
  document.querySelector("[data-back-home]")?.addEventListener("click", renderDesktopHome);
  document.querySelector("#save-host-server")?.addEventListener("click", () => {
    try {
      const input = document.querySelector<HTMLInputElement>("#host-signal-url");
      if (!input) return;
      signalUrl = saveSignalUrl(input.value);
      input.value = signalUrl;
      toast("服务器地址已保存");
    } catch (error) {
      toast(error instanceof Error ? error.message : "服务器地址无效", "danger");
    }
  });
  document.querySelector("#start-share")?.addEventListener("click", async () => {
    nickname = saveNickname(
      document.querySelector<HTMLInputElement>("#host-nickname")?.value || nickname,
    );
    channelName = saveChannelName(
      document.querySelector<HTMLInputElement>("#channel-name")?.value || channelName,
    );
    try {
      signalUrl = saveSignalUrl(
        document.querySelector<HTMLInputElement>("#host-signal-url")?.value || signalUrl,
      );
      await openChannelSession({
        root: appRoot,
        desktop: true,
        room: roomCode,
        signalUrl,
        nickname,
        channelName,
        createIfMissing: true,
        ownerToken: hostOwnership.ownerToken,
        notify: toast,
        onLeave: renderDesktopHome,
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : "无法进入频道", "danger");
    }
  });

}

interface ViewerOptions {
  desktop?: boolean;
  room?: string;
  signalUrl?: string;
  autoJoin?: boolean;
}

async function renderViewer(options: ViewerOptions = {}): Promise<void> {
  hideEmbeddedGame();
  stopStarField();
  startCursorGlow();
  const desktop = options.desktop === true;
  let signalUrl = options.signalUrl || getSignalUrl();
  let roomCode =
    options.room || new URLSearchParams(location.search).get("room")?.toUpperCase() || "";
  let nickname = getNickname();

  const querySignal = new URLSearchParams(location.search).get("signal");
  if (querySignal) {
    try {
      signalUrl = normalizeAppSignalUrl(querySignal);
    } catch {
      // Ignore malformed invitation data.
    }
  }

  appRoot.innerHTML = `
    <div class="app-frame">
      ${railMarkup()}
      <main class="join-main">
        <header class="setup-topbar">
          ${logoMarkup(desktop ? "Windows 观看端" : "Android 观看端")}
          ${desktop ? `<button class="ghost-button" data-back-home>返回首页</button>` : ""}
        </header>
        <section class="join-card">
          <div class="join-art" aria-hidden="true"><span>▶</span><i></i><i></i></div>
          <span class="eyebrow">JOIN A CHANNEL</span>
          <h1>朋友已经开场？<br /><em>马上加入。</em></h1>
          <p>输入 8 位频道码。加入成功后可以看电影、发弹幕，也可以选择加入连麦。</p>
          <div class="room-code-entry">
            <label class="field">
              <span>频道码</span>
              <input id="room-input" class="room-input" maxlength="8" value="${escapeHtml(roomCode)}" placeholder="例如 A7K9P2WX" autocomplete="one-time-code" />
            </label>
          </div>
          <label class="field">
            <span>你的昵称</span>
            <input id="viewer-nickname" maxlength="16" value="${escapeHtml(nickname)}" />
          </label>
          <button id="join-room" class="primary-button">
            <span aria-hidden="true">▶</span><div><strong>进入频道</strong><small>自动连接朋友的画面</small></div><b>→</b>
          </button>
          <details class="server-settings">
            <summary>服务器设置</summary>
            <label class="field"><span>信令服务器${isNativeAndroid() ? "（Android 仅支持 wss://）" : ""}</span><input id="viewer-signal-url" value="${escapeHtml(signalUrl)}" /></label>
          </details>
        </section>
      </main>
    </div>
  `;
  bindRailNavigation();
  document.querySelector("[data-back-home]")?.addEventListener("click", renderDesktopHome);
  const roomInput = document.querySelector<HTMLInputElement>("#room-input");
  roomInput?.addEventListener("input", () => {
    roomInput.value = roomInput.value.toUpperCase().replace(/[^23456789A-HJ-NP-Z]/g, "");
  });
  document.querySelector("#join-room")?.addEventListener("click", () => void joinRoom());
  if (options.autoJoin && roomCode.length === 8) {
    window.setTimeout(() => void joinRoom(), 120);
  }

  async function joinRoom(): Promise<void> {
    roomCode = document.querySelector<HTMLInputElement>("#room-input")?.value.trim().toUpperCase() || "";
    if (roomCode.length !== 8) {
      toast("请输入 8 位频道码", "danger");
      return;
    }
    nickname = saveNickname(
      document.querySelector<HTMLInputElement>("#viewer-nickname")?.value || nickname,
    );
    try {
      signalUrl = saveSignalUrl(
        document.querySelector<HTMLInputElement>("#viewer-signal-url")?.value || signalUrl,
      );
      const hostOwnership = desktop
        ? await getHostChannelOwnership()
        : undefined;
      const ownerToken =
        hostOwnership?.room === roomCode
          ? hostOwnership.ownerToken
          : undefined;
      await openChannelSession({
        root: appRoot,
        desktop,
        room: roomCode,
        signalUrl,
        nickname,
        createIfMissing: Boolean(ownerToken),
        ownerToken,
        notify: toast,
        onLeave: desktop
          ? renderDesktopHome
          : () => renderViewer({ desktop: false }),
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : "加入失败", "danger");
    }
  }
}

if (isDesktop) {
  renderDesktopHome();
  window.roomDesktop?.onOpenUrl((url) => {
    const invite = confirmExternalInvite(url);
    if (invite) {
      void renderViewer({
        desktop: true,
        room: invite.room,
        signalUrl: invite.signalUrl,
        autoJoin: true,
      });
    }
  });
} else {
  void (async () => {
    let recentInviteKey = "";
    let recentInviteAt = 0;
    let recentInviteHandled = false;
    const openInvite = (url?: string): boolean => {
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
        return recentInviteHandled;
      }
      const invite = confirmExternalInvite(url);
      recentInviteKey = inviteKey;
      recentInviteAt = now;
      recentInviteHandled = Boolean(invite);
      if (!invite) return false;
      void renderViewer({
        room: invite.room,
        signalUrl: invite.signalUrl,
        autoJoin: true,
      });
      return true;
    };
    const appUrlListener = await App.addListener("appUrlOpen", ({ url }) => {
      openInvite(url);
    });
    window.addEventListener("beforeunload", () => {
      void appUrlListener.remove();
    });
    const launch = await App.getLaunchUrl().catch(() => undefined);
    if (!openInvite(launch?.url)) {
      await renderViewer();
    }
  })();
}
