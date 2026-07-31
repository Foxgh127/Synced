import { hydrateIcons } from "./ui/icons";

const GAME_NAME = "吹牛";
const GAME_URL = "https://bluff.synced.com.cn/";

interface GameViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type GameSurface = "closed" | "center" | "game";

let surface: GameSurface = "closed";
let gameShell: HTMLElement | undefined;
let gameCenter: HTMLElement | undefined;
let gameViewportPage: HTMLElement | undefined;
let gameViewport: HTMLElement | undefined;
let gameStatus: HTMLElement | undefined;
let gameTitle: HTMLElement | undefined;
let centerBackButton: HTMLButtonElement | undefined;
let reloadButton: HTMLButtonElement | undefined;
let resizeObserver: ResizeObserver | undefined;
let removeStateListener: (() => void) | undefined;
let boundsFrame: number | undefined;
let gameViewVisible = false;
let gameViewOpenPending = false;

function bluffCardMark(size: "rail" | "large" = "rail"): string {
  return `
    <span class="bluff-card-mark bluff-card-mark-${size}" aria-hidden="true">
      <i class="bluff-card-back"></i>
      <i class="bluff-card-face"><b>牛</b><em>♠</em></i>
    </span>
  `;
}

export function embeddedGameRailButtonMarkup(): string {
  return `
    <button
      class="rail-game rail-tool"
      type="button"
      data-game-button
      aria-label="打开游戏中心"
      aria-pressed="false"
    >
      <i data-lucide="gamepad-2"></i>
      <span class="rail-tooltip">游戏<small>频道内小游戏</small></span>
    </button>
  `;
}

function setGameStatus(
  state: "idle" | "loading" | "ready" | "error",
  message?: string,
): void {
  if (!gameStatus) return;
  gameStatus.dataset.state = state;
  gameStatus.textContent =
    message ||
    {
      idle: "游戏中心",
      loading: "正在载入游戏",
      ready: "应用内运行",
      error: "加载失败",
    }[state];
}

function updateRailButtons(): void {
  document
    .querySelectorAll<HTMLButtonElement>("[data-game-button]")
    .forEach((button) => {
      const open = surface !== "closed";
      button.classList.toggle("active", open);
      button.setAttribute("aria-pressed", String(open));
      button.removeAttribute("title");
    });
}

function updateShellSurface(): void {
  const inGame = surface === "game";
  if (gameCenter) gameCenter.hidden = inGame;
  if (gameViewportPage) gameViewportPage.hidden = !inGame;
  if (gameTitle) gameTitle.textContent = inGame ? GAME_NAME : "游戏中心";
  if (centerBackButton) centerBackButton.hidden = !inGame;
  if (reloadButton) reloadButton.hidden = !inGame;
  if (!inGame) setGameStatus("idle");
}

function viewportBounds(): GameViewBounds | undefined {
  if (
    surface !== "game" ||
    !gameViewport?.isConnected ||
    gameViewportPage?.hidden
  ) {
    return undefined;
  }
  const rect = gameViewport.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return undefined;
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function syncGameBounds(open = false): void {
  if (surface !== "game" || !window.roomDesktop) return;
  if (open) gameViewOpenPending = true;
  if (boundsFrame !== undefined) {
    window.cancelAnimationFrame(boundsFrame);
  }
  boundsFrame = window.requestAnimationFrame(() => {
    boundsFrame = undefined;
    const bounds = viewportBounds();
    if (!bounds) return;
    const shouldOpen = gameViewOpenPending || !gameViewVisible;
    gameViewOpenPending = false;
    if (shouldOpen) gameViewVisible = true;
    const action = shouldOpen
      ? window.roomDesktop?.gameViewOpen(bounds)
      : window.roomDesktop?.gameViewSetBounds(bounds);
    void action?.catch(() => {
      if (shouldOpen) gameViewVisible = false;
      setGameStatus("error", "游戏视图暂时不可用");
    });
  });
}

function showGameCenter(): void {
  const shell = ensureGameShell();
  surface = "center";
  shell.hidden = false;
  document.body.classList.add("embedded-game-open");
  updateShellSurface();
  updateRailButtons();
  gameViewVisible = false;
  gameViewOpenPending = false;
  void window.roomDesktop?.gameViewHide().catch(() => undefined);
}

function launchBluff(): void {
  if (!window.roomDesktop) return;
  const shell = ensureGameShell();
  surface = "game";
  shell.hidden = false;
  document.body.classList.add("embedded-game-open");
  updateShellSurface();
  updateRailButtons();
  setGameStatus("loading");
  syncGameBounds(true);
}

function ensureGameShell(): HTMLElement {
  const existing = document.getElementById("embedded-game-shell");
  if (existing) {
    gameShell = existing;
    gameCenter =
      existing.querySelector<HTMLElement>("[data-game-center]") ?? undefined;
    gameViewportPage =
      existing.querySelector<HTMLElement>("[data-game-page]") ?? undefined;
    gameViewport =
      existing.querySelector<HTMLElement>("[data-game-viewport]") ?? undefined;
    gameStatus =
      existing.querySelector<HTMLElement>("[data-game-status]") ?? undefined;
    gameTitle =
      existing.querySelector<HTMLElement>("[data-game-title]") ?? undefined;
    centerBackButton =
      existing.querySelector<HTMLButtonElement>("[data-game-center-back]") ??
      undefined;
    reloadButton =
      existing.querySelector<HTMLButtonElement>("[data-game-reload]") ??
      undefined;
    return existing;
  }

  const shell = document.createElement("section");
  shell.id = "embedded-game-shell";
  shell.className = "embedded-game-shell";
  shell.hidden = true;
  shell.setAttribute("aria-label", "频道游戏中心");
  shell.innerHTML = `
    <header class="embedded-game-header">
      <div class="embedded-game-identity">
        ${bluffCardMark()}
        <div>
          <strong data-game-title>游戏中心</strong>
          <span data-game-status data-state="idle">游戏中心</span>
        </div>
      </div>
      <div class="embedded-game-actions">
        <button type="button" data-game-center-back hidden aria-label="返回游戏中心" title="返回游戏中心">
          <i data-lucide="arrow-left"></i>
        </button>
        <button type="button" data-game-reload hidden aria-label="刷新游戏" title="刷新游戏">
          <i data-lucide="refresh-cw"></i>
        </button>
        <button type="button" data-game-close aria-label="返回频道" title="返回频道">
          <i data-lucide="x"></i>
        </button>
      </div>
    </header>
    <main class="game-center" data-game-center>
      <section class="game-center-hero">
        <span class="eyebrow">PLAY TOGETHER</span>
        <h1>游戏中心</h1>
        <p>留在频道里，和朋友边连麦边开一局。</p>
      </section>
      <section class="game-library" aria-label="可用游戏">
        <button class="game-library-card bluff-library-card" type="button" data-game-launch="bluff">
          <span class="bluff-card-art">${bluffCardMark("large")}</span>
          <span class="game-library-copy">
            <small>3–5 人 · 心理博弈</small>
            <strong>吹牛</strong>
            <span>价可以乱喊，筹码不会说谎。</span>
          </span>
          <span class="game-library-enter" aria-hidden="true">开始游戏 →</span>
        </button>
        <div class="game-library-coming" aria-label="更多游戏正在准备">
          <span>+</span>
          <strong>更多游戏</strong>
          <small>正在准备</small>
        </div>
      </section>
    </main>
    <div class="embedded-game-page" data-game-page hidden>
      <div class="embedded-game-viewport" data-game-viewport>
        <div class="embedded-game-loading" aria-hidden="true">
          ${bluffCardMark("large")}
          <strong>正在启动${GAME_NAME}</strong>
          <small>${GAME_URL.replace(/^https?:\/\//, "").replace(/\/$/, "")}</small>
        </div>
      </div>
    </div>
  `;
  document.body.append(shell);
  hydrateIcons(shell);
  gameShell = shell;
  gameCenter =
    shell.querySelector<HTMLElement>("[data-game-center]") ?? undefined;
  gameViewportPage =
    shell.querySelector<HTMLElement>("[data-game-page]") ?? undefined;
  gameViewport =
    shell.querySelector<HTMLElement>("[data-game-viewport]") ?? undefined;
  gameStatus =
    shell.querySelector<HTMLElement>("[data-game-status]") ?? undefined;
  gameTitle =
    shell.querySelector<HTMLElement>("[data-game-title]") ?? undefined;
  centerBackButton =
    shell.querySelector<HTMLButtonElement>("[data-game-center-back]") ??
    undefined;
  reloadButton =
    shell.querySelector<HTMLButtonElement>("[data-game-reload]") ?? undefined;

  shell
    .querySelector<HTMLButtonElement>("[data-game-close]")
    ?.addEventListener("click", hideEmbeddedGame);
  reloadButton?.addEventListener("click", () => {
    setGameStatus("loading");
    const action = window.roomDesktop?.gameViewReload();
    void action?.catch(() => {
      setGameStatus("error", "暂时无法刷新游戏");
    });
  });
  centerBackButton?.addEventListener("click", showGameCenter);
  shell
    .querySelector<HTMLButtonElement>('[data-game-launch="bluff"]')
    ?.addEventListener("click", launchBluff);

  resizeObserver = new ResizeObserver(() => syncGameBounds());
  if (gameViewport) resizeObserver.observe(gameViewport);
  removeStateListener = window.roomDesktop?.onGameViewState((state) => {
    if (surface !== "game") return;
    if (state.state === "loading") {
      setGameStatus("loading");
    } else if (state.state === "ready") {
      setGameStatus("ready");
    } else {
      setGameStatus("error", state.message || "游戏加载失败");
    }
  });
  return shell;
}

export async function showEmbeddedGame(): Promise<void> {
  if (!window.roomDesktop) return;
  showGameCenter();
}

export function hideEmbeddedGame(): void {
  surface = "closed";
  gameViewVisible = false;
  gameViewOpenPending = false;
  document.body.classList.remove("embedded-game-open");
  if (gameShell) gameShell.hidden = true;
  if (boundsFrame !== undefined) {
    window.cancelAnimationFrame(boundsFrame);
    boundsFrame = undefined;
  }
  updateRailButtons();
  const action = window.roomDesktop?.gameViewHide();
  void action?.catch(() => {
    // Renderer-only smoke harnesses do not install native view handlers.
  });
}

export function bindEmbeddedGameRail(scope: ParentNode = document): void {
  scope
    .querySelectorAll<HTMLButtonElement>("[data-game-button]")
    .forEach((button) => {
      if (button.dataset.gameBound === "true") return;
      button.dataset.gameBound = "true";
      button.addEventListener("click", () => {
        if (surface !== "closed") {
          hideEmbeddedGame();
        } else {
          void showEmbeddedGame();
        }
      });
    });
  updateRailButtons();
}

window.addEventListener("beforeunload", () => {
  resizeObserver?.disconnect();
  removeStateListener?.();
  removeStateListener = undefined;
});
