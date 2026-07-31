import { HOME_SIGNAL_URL, normalizeSignalUrl } from "../config";
import { isNativeAndroid } from "../immersive";
import {
  effectsQuality,
  type AmbientPreference,
  type EffectsPreference,
  type MotionPreference,
  type TransparencyPreference,
} from "./effects-quality";
import { dialogController } from "./dialog-controller";
import { hydrateIcons } from "./icons";

interface SettingsControllerOptions {
  onOpenDesignLab: () => void;
  notify: (
    message: string,
    type?: "info" | "warn" | "danger" | boolean,
  ) => void;
}

const CATEGORIES = [
  ["appearance", "外观"],
  ["playback", "播放"],
  ["voice", "连麦"],
  ["network", "网络"],
  ["emby", "Emby"],
  ["advanced", "高级"],
  ["about", "关于"],
] as const;

function selectOptions(
  options: ReadonlyArray<readonly [string, string]>,
  selected: string,
): string {
  return options
    .map(
      ([value, label]) =>
        `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`,
    )
    .join("");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character] || character,
  );
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error(message)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export class SettingsController {
  private dialog?: HTMLDialogElement;
  private controller?: AbortController;
  private embyRequestGeneration = 0;

  constructor(private readonly options: SettingsControllerOptions) {}

  async open(
    opener?: HTMLElement,
    category: (typeof CATEGORIES)[number][0] = "appearance",
  ): Promise<void> {
    this.ensureDialog();
    if (!this.dialog) return;
    this.selectTab(category);
    await dialogController.open(this.dialog, opener);
  }

  private ensureDialog(): void {
    if (this.dialog?.isConnected) return;
    const appearance = effectsQuality.current;
    const dialog = document.createElement("dialog");
    dialog.className = "settings-dialog";
    dialog.setAttribute("aria-labelledby", "settings-title");
    dialog.innerHTML = `
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置分类" role="tablist">
          ${CATEGORIES.map(
            ([key, label], index) => `
              <button class="btn btn-ghost" type="button" role="tab"
                id="settings-tab-${key}" data-settings-tab="${key}"
                aria-selected="${index === 0}"
                aria-controls="settings-panel-${key}">${label}</button>`,
          ).join("")}
        </nav>
        <main class="settings-content">
          <header class="dialog-header">
            <div>
              <span class="eyebrow">PREFERENCES</span>
              <h2 id="settings-title">设置</h2>
            </div>
            <button class="btn btn-ghost btn-icon" type="button"
              data-dialog-close aria-label="关闭设置"><i data-lucide="x"></i></button>
          </header>
          <section class="settings-section" id="settings-panel-appearance"
            role="tabpanel" aria-labelledby="settings-tab-appearance">
            <div class="setting-row">
              <span><strong>动态效果</strong><small>系统会结合温度、电量和设备性能自动降级。</small></span>
              <select id="setting-effects" aria-label="动态效果">
                ${selectOptions(
                  [
                    ["auto", "自动"],
                    ["full", "完整"],
                    ["balanced", "平衡"],
                    ["minimal", "精简"],
                  ],
                  appearance.effects,
                )}
              </select>
            </div>
            <div class="setting-row">
              <span><strong>沉浸光感</strong><small>仅在视频容器外低频采样，不覆盖画面。</small></span>
              <select id="setting-ambient" aria-label="沉浸光感">
                ${selectOptions(
                  [
                    ["auto", "自动"],
                    ["on", "开启"],
                    ["off", "关闭"],
                  ],
                  appearance.ambient,
                )}
              </select>
            </div>
            <div class="setting-row">
              <span><strong>透明材质</strong><small>降低透明度后所有玻璃面板使用实体表面。</small></span>
              <select id="setting-transparency" aria-label="透明材质">
                ${selectOptions(
                  [
                    ["auto", "自动"],
                    ["reduced", "降低透明度"],
                  ],
                  appearance.transparency,
                )}
              </select>
            </div>
            <div class="setting-row">
              <span><strong>动效</strong><small>减少动态仍保留短淡化和必要状态反馈。</small></span>
              <select id="setting-motion" aria-label="动效">
                ${selectOptions(
                  [
                    ["system", "跟随系统"],
                    ["full", "完整"],
                    ["reduced", "减少"],
                  ],
                  appearance.motion,
                )}
              </select>
            </div>
            <div class="setting-row">
              <span><strong>界面缩放</strong><small>调整桌面界面的整体阅读尺寸。</small></span>
              <select id="setting-scale" aria-label="界面缩放">
                ${selectOptions(
                  [
                    ["0.9", "90%"],
                    ["1", "100%"],
                    ["1.1", "110%"],
                    ["1.25", "125%"],
                  ],
                  localStorage.getItem("synced:ui-scale") || "1",
                )}
              </select>
            </div>
            <div class="setting-row">
              <span><strong>弹幕强度</strong><small>控制同时出现的弹幕密度，不影响聊天历史。</small></span>
              <select id="setting-danmaku-density" aria-label="弹幕强度">
                ${selectOptions(
                  [
                    ["low", "低"],
                    ["balanced", "平衡"],
                    ["high", "高"],
                  ],
                  localStorage.getItem("synced:danmaku-density") ||
                    "balanced",
                )}
              </select>
            </div>
            <label class="setting-row">
              <span><strong>高对比度</strong><small>增强文字、边缘和焦点状态的区分。</small></span>
              <input id="setting-high-contrast" type="checkbox" ${appearance.highContrast ? "checked" : ""} />
            </label>
          </section>
          <section class="settings-section" id="settings-panel-playback"
            role="tabpanel" aria-labelledby="settings-tab-playback" hidden>
            <div class="setting-row"><span><strong>默认全屏显示</strong><small>智能铺满会稳定检测黑边并保留字幕安全区。</small></span>
              <select data-storage-setting="synced:fullscreen-fit">
                ${selectOptions(
                  [
                    ["smart", "智能铺满"],
                    ["contain", "完整画面"],
                    ["cover", "铺满屏幕"],
                  ],
                  localStorage.getItem("synced:fullscreen-fit") ||
                    (isNativeAndroid() ? "contain" : "smart"),
                )}
              </select>
            </div>
            <div class="setting-row"><span><strong>GPU 清晰增强</strong><small>仅在资源预算允许且低分辨率内容需要放大时启用。</small></span>
              <select data-storage-setting="synced:video-enhancement">
                ${selectOptions(
                  [
                    ["auto", "自动"],
                    ["off", "关闭"],
                  ],
                  localStorage.getItem("synced:video-enhancement") || "auto",
                )}
              </select>
            </div>
          </section>
          <section class="settings-section" id="settings-panel-voice"
            role="tabpanel" aria-labelledby="settings-tab-voice" hidden>
            <div class="setting-row"><span><strong>默认降噪</strong><small>强力模式会在资源紧张时自动降级。</small></span>
              <select data-storage-setting="synced:voice-noise-mode">
                ${selectOptions(
                  [
                    ["natural", "自然降噪"],
                    ["clear", "清晰人声"],
                    ["strong", "强力消噪"],
                  ],
                  localStorage.getItem("synced:voice-noise-mode") || "clear",
                )}
              </select>
            </div>
          </section>
          <section class="settings-section" id="settings-panel-network"
            role="tabpanel" aria-labelledby="settings-tab-network" hidden>
            <label class="field">
              <span>信令服务器${isNativeAndroid() ? "（Android 仅支持 wss://）" : ""}</span>
              <input id="setting-signal-url" value="${escapeHtml(localStorage.getItem("synced:signal") || HOME_SIGNAL_URL)}" spellcheck="false" />
              <small class="field-help">仅连接你信任的自建服务器；陌生邀请会再次要求授权。</small>
            </label>
            <button id="setting-save-network" class="btn btn-secondary" type="button">保存网络设置</button>
          </section>
          <section class="settings-section" id="settings-panel-emby"
            role="tabpanel" aria-labelledby="settings-tab-emby" hidden>
            ${
              window.roomDesktop
                ? `
                  <header class="settings-section-heading">
                    <div>
                      <h3>Emby 账户与线路</h3>
                      <p>登录令牌使用 Windows 安全存储；密码只用于本次登录。</p>
                    </div>
                    <button id="refresh-emby-settings" class="btn btn-ghost" type="button">
                      <i data-lucide="refresh-cw"></i>刷新
                    </button>
                  </header>
                  <form id="settings-emby-login" class="settings-emby-login">
                    <label class="field">
                      <span>服务器地址</span>
                      <input id="settings-emby-server" type="url"
                             placeholder="https://media.example.com:8920"
                             autocomplete="url" required />
                    </label>
                    <label class="field">
                      <span>用户名</span>
                      <input id="settings-emby-user" type="text"
                             autocomplete="username" maxlength="128" required />
                    </label>
                    <label class="field">
                      <span>密码</span>
                      <input id="settings-emby-password" type="password"
                             autocomplete="current-password" maxlength="1024" />
                    </label>
                    <label class="setting-inline-check">
                      <input id="settings-emby-http" type="checkbox" />
                      <span>仅对此可信局域网服务器允许 HTTP</span>
                    </label>
                    <button class="btn btn-primary" type="submit">添加并验证账户</button>
                  </form>
                  <p id="settings-emby-status" class="settings-status" aria-live="polite"></p>
                  <div id="settings-emby-accounts" class="settings-emby-accounts">
                    <div class="settings-loading">正在读取账户…</div>
                  </div>
                `
                : `<p>Emby 高清放映及安全账户存储仅在 Windows 客户端提供。</p>`
            }
          </section>
          <section class="settings-section" id="settings-panel-advanced"
            role="tabpanel" aria-labelledby="settings-tab-advanced" hidden>
            <div class="setting-row">
              <span><strong>Design Lab</strong><small>查看所有材质、组件状态、焦点和降级模式。</small></span>
              <button id="open-design-lab" class="btn btn-secondary" type="button">打开</button>
            </div>
            <div class="setting-row">
              <span><strong>UI 版本</strong><small>当前启用 Synced Luminous Theater UI 3.0。</small></span>
              <output class="mono">luminous-3</output>
            </div>
          </section>
          <section class="settings-section" id="settings-panel-about"
            role="tabpanel" aria-labelledby="settings-tab-about" hidden>
            <h3>同频 Native ${escapeHtml(__APP_VERSION__)}</h3>
            <p>深黑内容层承载影片，空间卡片承载信息，玻璃材质只承载控制。</p>
          </section>
        </main>
      </div>
    `;
    document.body.append(dialog);
    this.dialog = dialog;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    dialogController.bind(dialog);
    hydrateIcons(dialog);

    dialog
      .querySelectorAll<HTMLButtonElement>("[data-settings-tab]")
      .forEach((tab) => {
        tab.addEventListener(
          "click",
          () => this.selectTab(tab.dataset.settingsTab || "appearance"),
          { signal },
        );
        tab.addEventListener(
          "keydown",
          (event) => {
            if (
              !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(
                event.key,
              )
            ) {
              return;
            }
            const tabs = [
              ...dialog.querySelectorAll<HTMLButtonElement>(
                "[data-settings-tab]",
              ),
            ];
            const current = tabs.indexOf(tab);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : current +
                    (event.key === "ArrowDown" ||
                    event.key === "ArrowRight"
                      ? 1
                      : -1);
            const target =
              tabs[(next + tabs.length) % tabs.length];
            event.preventDefault();
            this.selectTab(target.dataset.settingsTab || "appearance");
            target.focus();
          },
          { signal },
        );
      });

    const bindAppearance = <T extends string>(
      selector: string,
      key: "effects" | "ambient" | "transparency" | "motion",
    ): void => {
      dialog
        .querySelector<HTMLSelectElement>(selector)
        ?.addEventListener(
          "change",
          (event) => {
            const value = (event.currentTarget as HTMLSelectElement).value as T;
            effectsQuality.update({ [key]: value });
          },
          { signal },
        );
    };
    bindAppearance<EffectsPreference>("#setting-effects", "effects");
    bindAppearance<AmbientPreference>("#setting-ambient", "ambient");
    bindAppearance<TransparencyPreference>(
      "#setting-transparency",
      "transparency",
    );
    bindAppearance<MotionPreference>("#setting-motion", "motion");
    dialog
      .querySelector<HTMLInputElement>("#setting-high-contrast")
      ?.addEventListener(
        "change",
        (event) =>
          effectsQuality.update({
            highContrast: (event.currentTarget as HTMLInputElement).checked,
          }),
        { signal },
      );
    dialog
      .querySelector<HTMLSelectElement>("#setting-scale")
      ?.addEventListener(
        "change",
        (event) => {
          const scale = (event.currentTarget as HTMLSelectElement).value;
          localStorage.setItem("synced:ui-scale", scale);
          document.documentElement.style.setProperty("--ui-scale", scale);
        },
        { signal },
      );
    dialog
      .querySelector<HTMLSelectElement>("#setting-danmaku-density")
      ?.addEventListener(
        "change",
        (event) =>
          localStorage.setItem(
            "synced:danmaku-density",
            (event.currentTarget as HTMLSelectElement).value,
          ),
        { signal },
      );
    dialog
      .querySelectorAll<HTMLSelectElement>("[data-storage-setting]")
      .forEach((select) => {
        select.addEventListener(
          "change",
          () => {
            const key = select.dataset.storageSetting;
            if (key) localStorage.setItem(key, select.value);
          },
          { signal },
        );
      });
    dialog
      .querySelector<HTMLButtonElement>("#setting-save-network")
      ?.addEventListener(
        "click",
        () => {
          const input =
            dialog.querySelector<HTMLInputElement>("#setting-signal-url");
          if (!input) return;
          try {
            const normalized = normalizeSignalUrl(input.value, {
              allowInsecure: !isNativeAndroid(),
            });
            localStorage.setItem("synced:signal", normalized);
            input.value = normalized;
            this.options.notify("网络设置已保存");
          } catch (error) {
            input.setAttribute("aria-invalid", "true");
            this.options.notify(
              error instanceof Error ? error.message : "服务器地址无效",
              "danger",
            );
          }
        },
        { signal },
      );
    dialog
      .querySelector<HTMLFormElement>("#settings-emby-login")
      ?.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          void this.addEmbyAccount();
        },
        { signal },
      );
    dialog
      .querySelector<HTMLButtonElement>("#refresh-emby-settings")
      ?.addEventListener(
        "click",
        () => void this.refreshEmbyAccounts(),
        { signal },
      );
    dialog
      .querySelector<HTMLElement>("#settings-emby-accounts")
      ?.addEventListener(
        "click",
        (event) => void this.handleEmbyAccountAction(event),
        { signal },
      );
    dialog
      .querySelector<HTMLButtonElement>("#open-design-lab")
      ?.addEventListener(
        "click",
        () => {
          void dialogController.close(dialog).then(() =>
            this.options.onOpenDesignLab(),
          );
        },
        { signal },
      );
  }

  private setEmbyStatus(message: string, danger = false): void {
    const status =
      this.dialog?.querySelector<HTMLElement>("#settings-emby-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = danger ? "danger" : "info";
  }

  private async addEmbyAccount(): Promise<void> {
    if (!this.dialog || !window.roomDesktop) return;
    const form =
      this.dialog.querySelector<HTMLFormElement>("#settings-emby-login");
    const server =
      this.dialog.querySelector<HTMLInputElement>("#settings-emby-server");
    const username =
      this.dialog.querySelector<HTMLInputElement>("#settings-emby-user");
    const password =
      this.dialog.querySelector<HTMLInputElement>(
        "#settings-emby-password",
      );
    const allowHttp =
      this.dialog.querySelector<HTMLInputElement>("#settings-emby-http");
    const submit = form?.querySelector<HTMLButtonElement>(
      "button[type='submit']",
    );
    if (!form || !server || !username || !password || !submit) return;
    if (!form.reportValidity()) return;
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
    this.setEmbyStatus("正在验证服务器与账户…");
    try {
      await withDeadline(
        window.roomDesktop.embyLogin({
          serverUrl: server.value.trim(),
          serverUrls: [server.value.trim()],
          username: username.value.trim(),
          password: password.value,
          allowInsecure: allowHttp?.checked === true,
        }),
        30_000,
        "Emby 登录验证超时，请检查服务器线路",
      );
      password.value = "";
      this.options.notify("Emby 账户已添加并安全保存");
      await this.refreshEmbyAccounts();
    } catch (error) {
      this.setEmbyStatus(
        error instanceof Error ? error.message : "Emby 登录失败",
        true,
      );
    } finally {
      if (submit.isConnected) {
        submit.disabled = false;
        submit.removeAttribute("aria-busy");
      }
    }
  }

  private async refreshEmbyAccounts(): Promise<void> {
    if (!this.dialog || !window.roomDesktop) return;
    const generation = ++this.embyRequestGeneration;
    const container =
      this.dialog.querySelector<HTMLElement>("#settings-emby-accounts");
    if (!container) return;
    container.setAttribute("aria-busy", "true");
    try {
      const state = await withDeadline(
        window.roomDesktop.embyAccounts(),
        8_000,
        "读取 Emby 账户超时",
      );
      if (
        generation !== this.embyRequestGeneration ||
        !container.isConnected
      ) {
        return;
      }
      if (!state.accounts.length) {
        container.innerHTML =
          `<div class="settings-empty">还没有保存的 Emby 账户。</div>`;
        this.setEmbyStatus(
          state.persistence === "encrypted"
            ? "Windows 安全存储可用"
            : "当前为仅会话存储，退出应用后令牌不会保留",
        );
        return;
      }
      container.innerHTML = state.accounts
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
        .map((account) => {
          const active = state.activeAccountId === account.id;
          const endpoints =
            account.server.endpoints?.map((endpoint) => endpoint.url) ||
            [account.server.address];
          return `
            <article class="settings-emby-account${active ? " is-active" : ""}"
                     data-emby-account="${escapeHtml(account.id)}">
              <header>
                <div>
                  <strong>${escapeHtml(account.server.name)}</strong>
                  <span>${escapeHtml(account.user.name)}${active ? " · 当前使用" : ""}</span>
                </div>
                <span class="status-badge" data-tone="${active ? "success" : "neutral"}">
                  ${active ? "已连接" : "已保存"}
                </span>
              </header>
              <label class="field">
                <span>服务器线路（每行一个，按顺序故障转移）</span>
                <textarea data-emby-routes rows="${Math.max(2, Math.min(5, endpoints.length))}">${escapeHtml(endpoints.join("\n"))}</textarea>
              </label>
              <label class="setting-inline-check">
                <input type="checkbox" data-emby-allow-http ${account.server.insecure ? "checked" : ""} />
                <span>仅对此可信局域网服务器允许 HTTP</span>
              </label>
              <div class="settings-emby-actions">
                ${
                  active
                    ? ""
                    : `<button class="btn btn-secondary" type="button"
                               data-emby-action="activate">设为当前</button>`
                }
                <button class="btn btn-secondary" type="button"
                        data-emby-action="routes">验证并保存线路</button>
                <button class="btn btn-danger" type="button"
                        data-emby-action="remove">移除账户</button>
              </div>
            </article>
          `;
        })
        .join("");
      this.setEmbyStatus(
        state.persistence === "encrypted"
          ? `${state.accounts.length} 个账户 · 令牌由 Windows 安全存储保护`
          : `${state.accounts.length} 个账户 · 当前仅会话保存`,
      );
    } catch (error) {
      if (generation !== this.embyRequestGeneration) return;
      container.innerHTML =
        `<div class="settings-empty">无法读取账户，请重试。</div>`;
      this.setEmbyStatus(
        error instanceof Error ? error.message : "读取 Emby 账户失败",
        true,
      );
    } finally {
      if (container.isConnected) container.removeAttribute("aria-busy");
    }
  }

  private async handleEmbyAccountAction(event: Event): Promise<void> {
    if (!this.dialog || !window.roomDesktop) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("[data-emby-action]");
    const card = target.closest<HTMLElement>("[data-emby-account]");
    if (!button || !card || button.disabled) return;
    const accountId = card.dataset.embyAccount || "";
    if (!accountId) return;
    const action = button.dataset.embyAction;
    if (action === "remove") {
      const confirmationDeadline = Number(button.dataset.confirmUntil || 0);
      if (Date.now() > confirmationDeadline) {
        button.dataset.confirmUntil = String(Date.now() + 5_000);
        button.textContent = "再次点击确认移除";
        this.setEmbyStatus("再次点击可确认移除；5 秒后自动取消");
        return;
      }
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      if (action === "activate") {
        await withDeadline(
          window.roomDesktop.embyActivateAccount(accountId),
          15_000,
          "切换 Emby 账户超时",
        );
        this.options.notify("已切换 Emby 账户");
      } else if (action === "routes") {
        const routes = (
          card.querySelector<HTMLTextAreaElement>("[data-emby-routes]")
            ?.value || ""
        )
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean);
        if (!routes.length) throw new Error("请至少保留一条服务器线路");
        await withDeadline(
          window.roomDesktop.embyUpdateEndpoints(accountId, {
            serverUrls: routes,
            allowInsecure:
              card.querySelector<HTMLInputElement>("[data-emby-allow-http]")
                ?.checked === true,
          }),
          30_000,
          "验证备用线路超时，原线路未更改",
        );
        this.options.notify("Emby 线路已验证并保存");
      } else if (action === "remove") {
        await withDeadline(
          window.roomDesktop.embyActivateAccount(accountId),
          15_000,
          "准备移除 Emby 账户超时",
        );
        await withDeadline(
          window.roomDesktop.embyLogout(),
          10_000,
          "移除 Emby 账户超时",
        );
        this.options.notify("Emby 账户及令牌已移除");
      }
      await this.refreshEmbyAccounts();
    } catch (error) {
      this.setEmbyStatus(
        error instanceof Error ? error.message : "Emby 账户操作失败",
        true,
      );
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        if (action === "remove") {
          delete button.dataset.confirmUntil;
          button.textContent = "移除账户";
        }
      }
    }
  }

  private selectTab(key: string): void {
    if (!this.dialog) return;
    this.dialog
      .querySelectorAll<HTMLButtonElement>("[data-settings-tab]")
      .forEach((tab) => {
        const selected = tab.dataset.settingsTab === key;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      });
    this.dialog
      .querySelectorAll<HTMLElement>("[id^='settings-panel-']")
      .forEach((panel) => {
        panel.hidden = panel.id !== `settings-panel-${key}`;
      });
    if (key === "emby") {
      void this.refreshEmbyAccounts();
    }
  }

  destroy(): void {
    this.embyRequestGeneration += 1;
    this.controller?.abort();
    if (this.dialog) dialogController.dismiss(this.dialog);
    this.dialog?.remove();
    this.dialog = undefined;
  }
}

export function applySavedUiScale(): void {
  const saved = Number(localStorage.getItem("synced:ui-scale") || "1");
  const scale = [0.9, 1, 1.1, 1.25].includes(saved) ? saved : 1;
  document.documentElement.style.setProperty("--ui-scale", String(scale));
}
