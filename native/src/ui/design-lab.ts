import { dialogController } from "./dialog-controller";
import {
  effectsQuality,
  type AppearancePreferences,
} from "./effects-quality";
import { hydrateIcons } from "./icons";

function selected(
  current: string,
  value: string,
): string {
  return current === value ? " selected" : "";
}

function preferenceControls(
  preferences: AppearancePreferences,
): string {
  return `
    <label class="field">
      <span>效果质量</span>
      <select id="lab-effects">
        <option value="auto"${selected(preferences.effects, "auto")}>自动</option>
        <option value="full"${selected(preferences.effects, "full")}>完整</option>
        <option value="balanced"${selected(preferences.effects, "balanced")}>平衡</option>
        <option value="minimal"${selected(preferences.effects, "minimal")}>精简</option>
      </select>
    </label>
    <label class="field">
      <span>动态效果</span>
      <select id="lab-motion">
        <option value="system"${selected(preferences.motion, "system")}>跟随系统</option>
        <option value="full"${selected(preferences.motion, "full")}>完整</option>
        <option value="reduced"${selected(preferences.motion, "reduced")}>减少动态</option>
      </select>
    </label>
    <label class="field">
      <span>透明度</span>
      <select id="lab-transparency">
        <option value="auto"${selected(preferences.transparency, "auto")}>自动</option>
        <option value="reduced"${selected(preferences.transparency, "reduced")}>降低透明度</option>
      </select>
    </label>
    <label class="field">
      <span>沉浸光感</span>
      <select id="lab-ambient">
        <option value="auto"${selected(preferences.ambient, "auto")}>自动</option>
        <option value="on"${selected(preferences.ambient, "on")}>开启</option>
        <option value="off"${selected(preferences.ambient, "off")}>关闭</option>
      </select>
    </label>
    <label class="lab-check">
      <input id="lab-high-contrast" type="checkbox"${preferences.highContrast ? " checked" : ""}>
      <span>应用内高对比度</span>
    </label>
  `;
}

function maximumMembersMarkup(): string {
  return Array.from({ length: 8 }, (_, index) => `
    <li>
      <span class="lab-avatar" aria-hidden="true">${index + 1}</span>
      <span><strong>成员 ${index + 1}</strong><small>${index === 0 ? "房主 · 正在说话" : "在线 · 麦克风已关闭"}</small></span>
      <i data-lucide="${index === 0 ? "mic" : "mic-off"}"></i>
    </li>
  `).join("");
}

export function renderDesignLab(
  root: HTMLDivElement,
  onBack: () => void,
): void {
  const preferences = effectsQuality.current;
  root.innerHTML = `
    <main class="design-lab" id="main-content">
      <header class="design-lab-header material-mica">
        <div class="cluster">
          <button id="design-lab-back" class="btn btn-ghost btn-icon"
            type="button" aria-label="返回首页"><i data-lucide="arrow-left"></i></button>
          <div><span class="eyebrow">DESIGN LAB</span><h1>光域组件实验室</h1></div>
        </div>
        <span class="mono">UI 3.0 · luminous-3</span>
      </header>

      <section class="design-lab-section" aria-labelledby="lab-material-title">
        <header><span class="eyebrow">MATERIALS</span><h2 id="lab-material-title">五层材质与 Smoke</h2></header>
        <div class="design-lab-grid design-lab-materials">
          <article class="design-lab-card material-canvas">
            <h3>L0 · 影院画布</h3><p>完全不透明的中性视频外围。</p>
          </article>
          <article class="design-lab-card material-mica">
            <h3>L1 · Mica Base</h3><p>窗口与页面的低对比基础材质。</p>
          </article>
          <article class="design-lab-card material-card">
            <h3>L2 · Standard Card</h3><p>信息、表单与设置的主要承载面。</p>
          </article>
          <article class="design-lab-card material-regular">
            <h3>L3 · Regular Glass</h3><p>导航、Popover 与临时控制。</p>
          </article>
          <article class="design-lab-card material-clear">
            <h3>L4 · Clear Glass</h3><p>仅用于视频上方的短时控制。</p>
          </article>
          <article class="design-lab-card lab-smoke-card">
            <span class="lab-smoke-preview material-smoke" aria-hidden="true"></span>
            <h3>L5 · Smoke</h3><p>只承托阻断式 Dialog，不承载内容。</p>
          </article>
        </div>
      </section>

      <section class="design-lab-section" aria-labelledby="lab-state-title">
        <header><span class="eyebrow">COMPONENT STATES</span><h2 id="lab-state-title">完整组件状态</h2></header>
        <div class="design-lab-grid">
          <article class="design-lab-card">
            <h3>按钮</h3>
            <div class="design-lab-states" aria-label="按钮状态预览">
              <button class="btn btn-primary" type="button">Enabled</button>
              <button class="btn btn-secondary" type="button" data-preview-state="hover">Hover</button>
              <button class="btn btn-secondary" type="button" data-preview-state="focused">Focused</button>
              <button class="btn btn-secondary" type="button" data-preview-state="pressed">Pressed</button>
              <button class="btn btn-subtle" type="button" aria-pressed="true" data-selected="true">
                <i data-lucide="check"></i>Selected
              </button>
              <button class="btn btn-secondary" type="button" draggable="true" data-state="dragged">Dragged</button>
              <button class="btn btn-primary" type="button" disabled>Disabled</button>
              <button class="btn btn-primary" type="button" data-state="loading" aria-busy="true">
                <span class="ui-spinner" aria-hidden="true"></span>Loading
              </button>
            </div>
          </article>

          <article class="design-lab-card">
            <h3>表单与长文本</h3>
            <label class="field"><span>频道名称</span><input value="今晚同频" /></label>
            <label class="field"><span>超长内容</span><input value="这是用于验证 200% 缩放和极长频道名称不会遮挡按钮或产生横向溢出的完整测试内容" /></label>
            <label class="field"><span>错误示例</span><input value="未知服务器" aria-invalid="true" aria-describedby="lab-error" /></label>
            <small class="field-error" id="lab-error" role="alert"><i data-lucide="circle-alert"></i>请检查服务器地址后重试。</small>
            <label class="field"><span>禁用输入</span><input value="当前不可编辑" disabled /></label>
          </article>

          <article class="design-lab-card">
            <h3>选择卡</h3>
            <div class="lab-selection-grid" role="listbox" aria-label="来源选择状态">
              <button class="lab-source-card media-card" type="button" role="option" aria-selected="false">
                <span class="skeleton lab-source-thumb" aria-hidden="true"></span>
                <span><strong>正在读取窗口</strong><small>Loading · 固定 16:9</small></span>
              </button>
              <button class="lab-source-card media-card" type="button" role="option" aria-selected="true" data-selected="true">
                <span class="lab-source-thumb material-canvas"><i data-lucide="monitor-play"></i></span>
                <span><strong>播放器 · 1920×1080</strong><small>系统音频可用</small></span>
                <i class="lab-selection-check" data-lucide="check"></i>
              </button>
            </div>
          </article>

          <article class="design-lab-card">
            <h3>Dialog、Popover 与 Toast</h3>
            <div class="design-lab-states">
              <button id="design-lab-dialog-open" class="btn btn-secondary" type="button">打开 Smoke Dialog</button>
              <span class="lab-popover material-regular"><i data-lucide="circle-help"></i>Popover 会自动翻转并回焦</span>
            </div>
            <div class="lab-toast" role="status" data-tone="success"><i data-lucide="check"></i><span>邀请链接已复制</span><button class="btn btn-ghost btn-icon" type="button" aria-label="关闭提示"><i data-lucide="x"></i></button></div>
          </article>
        </div>
      </section>

      <section class="design-lab-section" aria-labelledby="lab-feedback-title">
        <header><span class="eyebrow">FEEDBACK</span><h2 id="lab-feedback-title">业务反馈状态</h2></header>
        <ul class="lab-feedback-grid">
          <li data-state="idle"><i data-lucide="circle"></i><span><strong>默认</strong><small>等待操作</small></span></li>
          <li data-state="loading"><span class="ui-spinner" aria-hidden="true"></span><span><strong>加载中</strong><small>正在读取来源</small></span></li>
          <li data-state="empty"><i data-lucide="library"></i><span><strong>空状态</strong><small>暂时没有媒体</small></span></li>
          <li data-tone="success"><i data-lucide="check"></i><span><strong>成功</strong><small>频道已创建</small></span></li>
          <li data-tone="warning"><i data-lucide="circle-alert"></i><span><strong>警告</strong><small>网络波动</small></span></li>
          <li data-tone="danger"><i data-lucide="shield-alert"></i><span><strong>错误</strong><small>提供重试操作</small></span></li>
          <li data-state="offline"><i data-lucide="wifi-off"></i><span><strong>离线</strong><small>等待网络恢复</small></span></li>
          <li data-state="reconnecting"><i data-lucide="refresh-cw"></i><span><strong>重连中</strong><small>第 2 次尝试</small></span></li>
          <li data-state="permission-denied"><i data-lucide="shield-alert"></i><span><strong>权限被拒绝</strong><small>打开系统设置</small></span></li>
        </ul>
      </section>

      <section class="design-lab-section lab-validation-layout" aria-labelledby="lab-validation-title">
        <header><span class="eyebrow">VALIDATION</span><h2 id="lab-validation-title">最大列表与降级测试</h2></header>
        <article class="design-lab-card">
          <h3>协议上限 · 8 人</h3>
          <ul class="lab-member-list">${maximumMembersMarkup()}</ul>
        </article>
        <article class="design-lab-card">
          <h3>实时偏好</h3>
          <p>切换后立即作用于当前页面；运行中的动画会收敛到确定终态。</p>
          <div class="lab-preference-grid">${preferenceControls(preferences)}</div>
          <output id="lab-preference-status" aria-live="polite">触控目标 ≥ 44px · 焦点可见 · 无颜色单一信号</output>
        </article>
      </section>
    </main>

    <dialog id="design-lab-dialog" class="security-sheet">
      <div class="security-sheet-content material-regular">
        <span class="eyebrow">SMOKE + REGULAR GLASS</span>
        <h2>焦点已锁定在此面板</h2>
        <p>按 Escape 或关闭按钮后，焦点会返回触发控件。</p>
        <div class="dialog-actions">
          <button class="btn btn-primary" type="button" data-dialog-close>完成</button>
        </div>
      </div>
    </dialog>
  `;

  hydrateIcons(root);
  const dialog = root.querySelector<HTMLDialogElement>(
    "#design-lab-dialog",
  );
  const opener = root.querySelector<HTMLButtonElement>(
    "#design-lab-dialog-open",
  );
  if (dialog && opener) {
    dialogController.bind(dialog);
    opener.addEventListener("click", () => {
      void dialogController.open(dialog, opener);
    });
  }

  const preferenceStatus = root.querySelector<HTMLOutputElement>(
    "#lab-preference-status",
  );
  for (const [id, key] of [
    ["lab-effects", "effects"],
    ["lab-motion", "motion"],
    ["lab-transparency", "transparency"],
    ["lab-ambient", "ambient"],
  ] as const) {
    root.querySelector<HTMLSelectElement>(`#${id}`)?.addEventListener(
      "change",
      (event) => {
        effectsQuality.update({
          [key]: (event.currentTarget as HTMLSelectElement).value,
        } as Partial<AppearancePreferences>);
        if (preferenceStatus) {
          preferenceStatus.textContent = "偏好已应用到当前 Design Lab";
        }
      },
    );
  }
  root
    .querySelector<HTMLInputElement>("#lab-high-contrast")
    ?.addEventListener("change", (event) => {
      effectsQuality.update({
        highContrast: (event.currentTarget as HTMLInputElement).checked,
      });
      if (preferenceStatus) {
        preferenceStatus.textContent = "高对比度偏好已应用";
      }
    });
  root
    .querySelector("#design-lab-back")
    ?.addEventListener("click", onBack);
}
