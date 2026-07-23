import { App } from "@capacitor/app";
import QRCode from "qrcode";
import "./styles.css";
import {
  QUALITY_PRESETS,
  buildJoinLink,
  createRoomCode,
  formatBitrate,
  normalizeSignalUrl,
  parseJoinLink,
  type QualityKey,
} from "./config";
import {
  SignalClient,
  createPeerConnection,
  preferVideoCodecs,
  readOutboundVideoStats,
  tuneOpus,
  tuneSenders,
  type OutboundSnapshot,
  type SignalEnvelope,
} from "./rtc";

const appRootElement = document.querySelector<HTMLDivElement>("#app");
if (!appRootElement) {
  throw new Error("Missing application root");
}
const appRoot: HTMLDivElement = appRootElement;

const DEFAULT_SIGNAL_URL = "ws://127.0.0.1:8787/signal";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getSavedSignalUrl(): string {
  return localStorage.getItem("yiqikan:signal") || DEFAULT_SIGNAL_URL;
}

function saveSignalUrl(value: string): string {
  const normalized = normalizeSignalUrl(value);
  localStorage.setItem("yiqikan:signal", normalized);
  return normalized;
}

function setToast(message: string, tone: "normal" | "error" = "normal"): void {
  const oldToast = document.querySelector(".toast");
  oldToast?.remove();
  const toast = document.createElement("div");
  toast.className = `toast ${tone === "error" ? "toast-error" : ""}`;
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 3_000);
}

function brandMarkup(role: string): string {
  return `
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><span></span></span>
        <div>
          <strong>一起看</strong>
          <small>${role}</small>
        </div>
      </div>
      <span class="privacy-pill"><i></i> 点对点加密传输</span>
    </header>
  `;
}

async function renderHost(): Promise<void> {
  let qualityKey: QualityKey =
    (localStorage.getItem("yiqikan:quality") as QualityKey | null) || "ultra";
  let signalUrl = getSavedSignalUrl();
  const networkInfo = await window.roomDesktop!.getNetworkInfo();
  let stream: MediaStream | undefined;
  let signal: SignalClient | undefined;
  let roomCode = "";
  let iceServers: RTCIceServer[] = [];
  let statsTimer: number | undefined;
  const peers = new Map<
    string,
    {
      pc: RTCPeerConnection;
      candidates: RTCIceCandidateInit[];
      snapshot?: OutboundSnapshot;
    }
  >();

  appRoot.innerHTML = `
    <main class="shell host-shell">
      ${brandMarkup("Windows 放映端")}
      <section class="hero-grid">
        <div class="hero-copy">
          <span class="eyebrow">WINDOW + SYSTEM AUDIO</span>
          <h1>今晚，<em>一起看。</em></h1>
          <p>选择一个播放窗口，系统声音与高清画面会同时发送给朋友。</p>
          <div class="quality-picker" role="radiogroup" aria-label="画质">
            ${Object.values(QUALITY_PRESETS)
              .map(
                (preset) => `
                  <button class="quality-option ${preset.key === qualityKey ? "active" : ""}" data-quality="${preset.key}">
                    <strong>${preset.label}</strong>
                    <span>${preset.detail}</span>
                  </button>
                `,
              )
              .join("")}
          </div>
          <button id="start-share" class="primary-action">
            <span class="action-icon">▶</span>
            <span><strong>开始分享</strong><small>选择要播放的窗口</small></span>
          </button>
          <button id="open-settings" class="text-button">服务器设置</button>
        </div>
        <div class="broadcast-art" aria-hidden="true">
          <div class="orbit orbit-one"></div>
          <div class="orbit orbit-two"></div>
          <div class="orbit orbit-three"></div>
          <div class="broadcast-core"><span>▶</span></div>
          <span class="signal-dot dot-one"></span>
          <span class="signal-dot dot-two"></span>
          <span class="signal-dot dot-three"></span>
        </div>
      </section>
      <footer class="trust-row">
        <span>✓ 原生窗口采集</span>
        <span>✓ Windows 系统声</span>
        <span>✓ 最高 4K / 45 Mbps</span>
      </footer>
    </main>
    <dialog id="source-dialog" class="glass-dialog">
      <div class="dialog-head">
        <div><span class="eyebrow">选择播放窗口</span><h2>你想分享哪个窗口？</h2></div>
        <button class="icon-button" data-close-dialog aria-label="关闭">×</button>
      </div>
      <div id="source-grid" class="source-grid">
        <div class="loading-card">正在读取窗口…</div>
      </div>
    </dialog>
    <dialog id="settings-dialog" class="glass-dialog settings-dialog">
      <div class="dialog-head">
        <div><span class="eyebrow">中国大陆连接</span><h2>信令服务器</h2></div>
        <button class="icon-button" data-close-settings aria-label="关闭">×</button>
      </div>
      <label class="field-label" for="signal-url">服务器地址</label>
      <input id="signal-url" class="field-input" value="${escapeHtml(signalUrl)}" placeholder="wss://你的域名/signal" />
      <p class="field-help">默认启用 EXE 内置服务器，适合同一 Wi‑Fi。异地观看请填写部署在腾讯云、阿里云或其他大陆可访问服务器上的地址。</p>
      <button id="save-settings" class="secondary-action">保存设置</button>
    </dialog>
  `;

  const sourceDialog = document.querySelector<HTMLDialogElement>("#source-dialog")!;
  const settingsDialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;

  document.querySelectorAll<HTMLButtonElement>("[data-quality]").forEach((button) => {
    button.addEventListener("click", () => {
      qualityKey = button.dataset.quality as QualityKey;
      localStorage.setItem("yiqikan:quality", qualityKey);
      document
        .querySelectorAll("[data-quality]")
        .forEach((item) => item.classList.toggle("active", item === button));
    });
  });

  document.querySelector("#open-settings")?.addEventListener("click", () => {
    settingsDialog.showModal();
  });
  document.querySelector("[data-close-settings]")?.addEventListener("click", () => {
    settingsDialog.close();
  });
  document.querySelector("#save-settings")?.addEventListener("click", () => {
    try {
      const input = document.querySelector<HTMLInputElement>("#signal-url")!;
      signalUrl = saveSignalUrl(input.value);
      input.value = signalUrl;
      settingsDialog.close();
      setToast("服务器地址已保存");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "服务器地址无效", "error");
    }
  });
  document.querySelector("[data-close-dialog]")?.addEventListener("click", () => {
    sourceDialog.close();
  });

  document.querySelector("#start-share")?.addEventListener("click", async () => {
    const sourceGrid = document.querySelector<HTMLDivElement>("#source-grid")!;
    sourceGrid.innerHTML = `<div class="loading-card">正在读取窗口…</div>`;
    sourceDialog.showModal();
    try {
      const sources = await window.roomDesktop!.listSources();
      if (!sources.length) {
        sourceGrid.innerHTML = `<div class="loading-card error-copy">没有发现可分享的窗口</div>`;
        return;
      }
      sourceGrid.innerHTML = sources
        .map(
          (source) => `
            <button class="source-card" data-source-id="${escapeHtml(source.id)}">
              <img src="${source.thumbnail}" alt="" />
              <span>${escapeHtml(source.name || "未命名窗口")}</span>
            </button>
          `,
        )
        .join("");
      sourceGrid.querySelectorAll<HTMLButtonElement>("[data-source-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          const sourceId = button.dataset.sourceId!;
          button.classList.add("selected");
          try {
            await window.roomDesktop!.selectSource(sourceId);
            sourceDialog.close();
            await startHostSession();
          } catch (error) {
            setToast(error instanceof Error ? error.message : "无法开始分享", "error");
            button.classList.remove("selected");
          }
        });
      });
    } catch (error) {
      sourceGrid.innerHTML = `<div class="loading-card error-copy">${escapeHtml(
        error instanceof Error ? error.message : "读取窗口失败",
      )}</div>`;
    }
  });

  async function startHostSession(): Promise<void> {
    const preset = QUALITY_PRESETS[qualityKey];
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width, max: preset.width },
        height: { ideal: preset.height, max: preset.height },
        frameRate: { ideal: preset.frameRate, max: preset.frameRate },
      },
      audio: true,
    });
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      throw new Error("没有获取到窗口画面");
    }
    videoTrack.contentHint = "motion";
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      stream = undefined;
      throw new Error("没有获取到系统声音，请确认 Windows 声音正在播放后重试");
    }
    stream.getAudioTracks().forEach((track) => {
      track.contentHint = "music";
    });
    videoTrack.addEventListener("ended", () => stopHostSession());
    await window.roomDesktop!.setCaptureActive(true);
    roomCode = createRoomCode();
    renderBroadcasting();
    await connectHostSignal();
  }

  function getInviteSignalUrl(): string {
    try {
      const url = new URL(signalUrl);
      const isLocal = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
      const lanAddress = networkInfo.lanAddresses[0];
      if (isLocal && networkInfo.localSignalReady && lanAddress) {
        url.hostname = lanAddress;
        return url.toString();
      }
    } catch {
      // signalUrl is normalized before this point.
    }
    return signalUrl;
  }

  async function connectHostSignal(): Promise<void> {
    signal = new SignalClient();
    signal.addEventListener("message", (event) => {
      void handleHostMessage((event as CustomEvent<SignalEnvelope>).detail);
    });
    signal.addEventListener("close", () => {
      setHostStatus("服务器连接已断开", "error");
    });
    try {
      await signal.connect(signalUrl);
      signal.send({ type: "host:create", room: roomCode });
    } catch (error) {
      setHostStatus(error instanceof Error ? error.message : "服务器连接失败", "error");
    }
  }

  async function handleHostMessage(message: SignalEnvelope): Promise<void> {
    if (message.type === "room:created") {
      iceServers = message.iceServers || [];
      setHostStatus("等待朋友加入", "ready");
      return;
    }
    if (message.type === "viewer:joined" && message.viewerId) {
      await createOfferForViewer(message.viewerId);
      updateViewerCount();
      return;
    }
    if (message.type === "viewer:left" && message.viewerId) {
      peers.get(message.viewerId)?.pc.close();
      peers.delete(message.viewerId);
      updateViewerCount();
      return;
    }
    if (message.type === "signal" && message.from && message.data) {
      await handleViewerSignal(message.from, message.data);
      return;
    }
    if (message.type === "error") {
      setHostStatus(message.message || "服务器返回错误", "error");
    }
  }

  async function createOfferForViewer(viewerId: string): Promise<void> {
    if (!stream || !signal) {
      return;
    }
    const pendingCandidates: RTCIceCandidateInit[] = [];
    const pc = createPeerConnection(iceServers, (candidate) => {
      signal?.send({ type: "signal", target: viewerId, data: candidate });
    });
    peers.set(viewerId, { pc, candidates: pendingCandidates });
    stream.getTracks().forEach((track) => pc.addTrack(track, stream!));
    preferVideoCodecs(pc, QUALITY_PRESETS[qualityKey].codecOrder);
    await tuneSenders(pc, QUALITY_PRESETS[qualityKey]);
    pc.addEventListener("connectionstatechange", () => {
      if (["failed", "closed"].includes(pc.connectionState)) {
        peers.delete(viewerId);
        updateViewerCount();
      }
    });
    const offer = tuneOpus(await pc.createOffer());
    await pc.setLocalDescription(offer);
    signal.send({ type: "signal", target: viewerId, data: pc.localDescription! });
  }

  async function handleViewerSignal(
    viewerId: string,
    data: RTCSessionDescriptionInit | RTCIceCandidateInit,
  ): Promise<void> {
    const peer = peers.get(viewerId);
    if (!peer) {
      return;
    }
    if ("type" in data && data.type) {
      await peer.pc.setRemoteDescription(data as RTCSessionDescriptionInit);
      for (const candidate of peer.candidates.splice(0)) {
        await peer.pc.addIceCandidate(candidate);
      }
      return;
    }
    const candidate = data as RTCIceCandidateInit;
    if (peer.pc.remoteDescription) {
      await peer.pc.addIceCandidate(candidate);
    } else {
      peer.candidates.push(candidate);
    }
  }

  function renderBroadcasting(): void {
    if (!stream) {
      return;
    }
    const inviteSignalUrl = getInviteSignalUrl();
    const joinLink = buildJoinLink(roomCode, inviteSignalUrl);
    appRoot.innerHTML = `
      <main class="shell session-shell">
        ${brandMarkup("正在放映")}
        <section class="session-grid">
          <div class="preview-panel">
            <video id="local-preview" autoplay muted playsinline></video>
            <div class="live-badge"><i></i> LIVE</div>
            <div class="preview-caption">本地预览 · 朋友看到的是同一画面</div>
          </div>
          <aside class="share-panel">
            <span class="eyebrow">邀请朋友</span>
            <h2>输入房间码即可观看</h2>
            <button id="copy-room" class="room-code" title="复制房间码">${roomCode}</button>
            <div class="qr-wrap"><img id="join-qr" alt="加入房间二维码" /></div>
            <div class="share-actions">
              <button id="copy-invite" class="secondary-action">复制邀请信息</button>
              <button id="stop-share" class="danger-action">停止分享</button>
            </div>
            <div class="status-card">
              <div><span>连接状态</span><strong id="host-status">正在连接服务器</strong></div>
              <div><span>观看人数</span><strong id="viewer-count">0 人</strong></div>
              <div><span>实际画质</span><strong id="actual-quality">等待连接</strong></div>
              <div><span>实际码率</span><strong id="actual-bitrate">等待数据</strong></div>
            </div>
          </aside>
        </section>
      </main>
    `;
    const preview = document.querySelector<HTMLVideoElement>("#local-preview")!;
    preview.srcObject = stream;
    void QRCode.toDataURL(joinLink, {
      width: 232,
      margin: 1,
      color: { dark: "#06101fff", light: "#eaf9ffff" },
    }).then((dataUrl) => {
      const image = document.querySelector<HTMLImageElement>("#join-qr");
      if (image) {
        image.src = dataUrl;
      }
    });
    document.querySelector("#copy-room")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(roomCode);
      setToast("房间码已复制");
    });
    document.querySelector("#copy-invite")?.addEventListener("click", async () => {
      const invite = `一起看房间：${roomCode}\n服务器：${inviteSignalUrl}\n安装 APP 后点击：${joinLink}`;
      await navigator.clipboard.writeText(invite);
      setToast("邀请信息已复制");
    });
    document.querySelector("#stop-share")?.addEventListener("click", () => {
      void stopHostSession();
    });
    statsTimer = window.setInterval(updateStats, 1_000);
  }

  function setHostStatus(text: string, tone: "ready" | "error"): void {
    const element = document.querySelector<HTMLElement>("#host-status");
    if (!element) {
      return;
    }
    element.textContent = text;
    element.dataset.tone = tone;
  }

  function updateViewerCount(): void {
    const element = document.querySelector<HTMLElement>("#viewer-count");
    if (element) {
      element.textContent = `${peers.size} 人`;
    }
  }

  async function updateStats(): Promise<void> {
    let totalBitrate = 0;
    let bestWidth = 0;
    let bestHeight = 0;
    let fps = 0;
    let codec = "";
    await Promise.all(
      Array.from(peers.values()).map(async (peer) => {
        const stats = await readOutboundVideoStats(peer.pc, peer.snapshot);
        peer.snapshot = stats.snapshot;
        totalBitrate += stats.bitrate;
        if ((stats.width || 0) * (stats.height || 0) > bestWidth * bestHeight) {
          bestWidth = stats.width || 0;
          bestHeight = stats.height || 0;
          fps = stats.framesPerSecond || 0;
          codec = stats.codec || "";
        }
      }),
    );
    const qualityElement = document.querySelector<HTMLElement>("#actual-quality");
    const bitrateElement = document.querySelector<HTMLElement>("#actual-bitrate");
    if (qualityElement) {
      qualityElement.textContent = bestWidth
        ? `${bestWidth}×${bestHeight} · ${Math.round(fps)}fps · ${codec}`
        : "等待朋友加入";
    }
    if (bitrateElement) {
      bitrateElement.textContent = peers.size ? formatBitrate(totalBitrate) : "等待数据";
    }
  }

  async function stopHostSession(): Promise<void> {
    if (statsTimer) {
      window.clearInterval(statsTimer);
    }
    peers.forEach(({ pc }) => pc.close());
    peers.clear();
    signal?.close();
    signal = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    await window.roomDesktop?.setCaptureActive(false);
    await renderHost();
  }
}

async function renderViewer(): Promise<void> {
  let signalUrl = getSavedSignalUrl();
  let roomCode = new URLSearchParams(location.search).get("room")?.toUpperCase() || "";
  let signal: SignalClient | undefined;
  let pc: RTCPeerConnection | undefined;
  let pendingCandidates: RTCIceCandidateInit[] = [];
  let pendingHostSignals: Array<RTCSessionDescriptionInit | RTCIceCandidateInit> = [];

  const querySignal = new URLSearchParams(location.search).get("signal");
  if (querySignal) {
    try {
      signalUrl = saveSignalUrl(querySignal);
    } catch {
      // Keep the previously saved server when a malformed link is opened.
    }
  }

  try {
    const launch = await App.getLaunchUrl();
    if (launch?.url) {
      const parsed = parseJoinLink(launch.url);
      roomCode = parsed.room || roomCode;
      if (parsed.signal) {
        signalUrl = saveSignalUrl(parsed.signal);
      }
    }
    await App.addListener("appUrlOpen", ({ url }) => {
      const parsed = parseJoinLink(url);
      if (parsed.room) {
        const roomInput = document.querySelector<HTMLInputElement>("#room-input");
        if (roomInput) {
          roomInput.value = parsed.room;
        }
      }
      if (parsed.signal) {
        try {
          signalUrl = saveSignalUrl(parsed.signal);
          const signalInput = document.querySelector<HTMLInputElement>("#viewer-signal-url");
          if (signalInput) {
            signalInput.value = signalUrl;
          }
        } catch {
          setToast("邀请中的服务器地址无效", "error");
        }
      }
    });
  } catch {
    // Capacitor App has a no-op web implementation outside Android.
  }

  appRoot.innerHTML = `
    <main class="shell viewer-shell">
      ${brandMarkup("Android 观看端")}
      <section class="viewer-hero">
        <div class="viewer-orb" aria-hidden="true"><span>▶</span></div>
        <span class="eyebrow">JOIN THE ROOM</span>
        <h1>输入房间码，<em>马上开场。</em></h1>
        <p>画面与电影原声会自动播放。建议连接 5GHz Wi‑Fi。</p>
        <label class="field-label" for="room-input">房间码</label>
        <input
          id="room-input"
          class="room-input"
          value="${escapeHtml(roomCode)}"
          maxlength="8"
          inputmode="text"
          autocomplete="one-time-code"
          placeholder="例如 A7K9P2WX"
        />
        <button id="join-room" class="primary-action viewer-action">
          <span class="action-icon">▶</span>
          <span><strong>进入放映室</strong><small>低延迟高清观看</small></span>
        </button>
        <details class="viewer-settings">
          <summary>服务器设置</summary>
          <label class="field-label" for="viewer-signal-url">信令服务器</label>
          <input id="viewer-signal-url" class="field-input" value="${escapeHtml(signalUrl)}" />
          <button id="save-viewer-settings" class="text-button">保存</button>
        </details>
      </section>
    </main>
  `;

  document.querySelector("#save-viewer-settings")?.addEventListener("click", () => {
    try {
      const input = document.querySelector<HTMLInputElement>("#viewer-signal-url")!;
      signalUrl = saveSignalUrl(input.value);
      input.value = signalUrl;
      setToast("服务器地址已保存");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "服务器地址无效", "error");
    }
  });

  document.querySelector("#room-input")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    input.value = input.value.toUpperCase().replace(/[^23456789A-HJ-NP-Z]/g, "");
  });

  document.querySelector("#join-room")?.addEventListener("click", async () => {
    const input = document.querySelector<HTMLInputElement>("#room-input")!;
    roomCode = input.value.trim().toUpperCase();
    if (roomCode.length !== 8) {
      setToast("请输入 8 位房间码", "error");
      return;
    }
    try {
      const signalInput = document.querySelector<HTMLInputElement>("#viewer-signal-url")!;
      signalUrl = saveSignalUrl(signalInput.value);
      renderPlayer();
      await connectViewer();
    } catch (error) {
      setViewerStatus(error instanceof Error ? error.message : "加入失败", "error");
    }
  });

  function renderPlayer(): void {
    appRoot.innerHTML = `
      <main class="player-shell">
        <video id="remote-video" autoplay playsinline></video>
        <div class="player-top">
          <div class="brand compact">
            <span class="brand-mark" aria-hidden="true"><span></span></span>
            <strong>一起看</strong>
          </div>
          <span id="viewer-status" class="player-status"><i></i> 正在连接</span>
        </div>
        <div class="player-bottom">
          <span>房间 ${roomCode}</span>
          <div>
            <button id="enable-sound" class="player-button">开启声音</button>
            <button id="fullscreen" class="player-button">全屏</button>
            <button id="leave-room" class="player-button danger">退出</button>
          </div>
        </div>
      </main>
    `;
    document.querySelector("#enable-sound")?.addEventListener("click", async () => {
      const video = document.querySelector<HTMLVideoElement>("#remote-video")!;
      video.muted = false;
      await video.play().catch(() => undefined);
      setToast("声音已开启");
    });
    document.querySelector("#fullscreen")?.addEventListener("click", async () => {
      const video = document.querySelector<HTMLVideoElement>("#remote-video")!;
      await video.requestFullscreen?.();
    });
    document.querySelector("#leave-room")?.addEventListener("click", () => {
      leaveViewer();
      void renderViewer();
    });
  }

  async function connectViewer(): Promise<void> {
    signal = new SignalClient();
    signal.addEventListener("message", (event) => {
      void handleViewerMessage((event as CustomEvent<SignalEnvelope>).detail);
    });
    signal.addEventListener("close", () => {
      setViewerStatus("服务器连接已断开", "error");
    });
    await signal.connect(signalUrl);
    signal.send({ type: "viewer:join", room: roomCode });
  }

  async function handleViewerMessage(message: SignalEnvelope): Promise<void> {
    if (message.type === "room:joined") {
      pc = createPeerConnection(message.iceServers || [], (candidate) => {
        signal?.send({ type: "signal", target: "host", data: candidate });
      });
      pc.addEventListener("track", (event) => {
        const video = document.querySelector<HTMLVideoElement>("#remote-video");
        if (!video) {
          return;
        }
        video.srcObject = event.streams[0] || new MediaStream([event.track]);
        video.muted = false;
        void video.play().catch(() => {
          setViewerStatus("请点击“开启声音”", "ready");
        });
      });
      pc.addEventListener("connectionstatechange", () => {
        if (!pc) {
          return;
        }
        if (pc.connectionState === "connected") {
          setViewerStatus("播放中", "ready");
        } else if (["failed", "disconnected"].includes(pc.connectionState)) {
          setViewerStatus("连接中断，正在等待恢复", "error");
        }
      });
      for (const pendingSignal of pendingHostSignals.splice(0)) {
        await handleHostSignal(pendingSignal);
      }
      return;
    }
    if (message.type === "signal" && message.data) {
      if (!pc) {
        pendingHostSignals.push(message.data);
        return;
      }
      await handleHostSignal(message.data);
      return;
    }
    if (message.type === "host:left") {
      setViewerStatus("放映已结束", "error");
      pc?.close();
      return;
    }
    if (message.type === "error") {
      setViewerStatus(message.message || "加入房间失败", "error");
    }
  }

  async function handleHostSignal(
    data: RTCSessionDescriptionInit | RTCIceCandidateInit,
  ): Promise<void> {
    if (!pc) {
      return;
    }
    if ("type" in data && data.type) {
      await pc.setRemoteDescription(data as RTCSessionDescriptionInit);
      for (const candidate of pendingCandidates.splice(0)) {
        await pc.addIceCandidate(candidate);
      }
      if (data.type === "offer") {
        const answer = tuneOpus(await pc.createAnswer());
        await pc.setLocalDescription(answer);
        signal?.send({ type: "signal", target: "host", data: pc.localDescription! });
      }
      return;
    }
    const candidate = data as RTCIceCandidateInit;
    if (pc.remoteDescription) {
      await pc.addIceCandidate(candidate);
    } else {
      pendingCandidates.push(candidate);
    }
  }

  function setViewerStatus(text: string, tone: "ready" | "error"): void {
    const element = document.querySelector<HTMLElement>("#viewer-status");
    if (!element) {
      setToast(text, tone === "error" ? "error" : "normal");
      return;
    }
    element.textContent = text;
    element.dataset.tone = tone;
  }

  function leaveViewer(): void {
    pc?.close();
    pc = undefined;
    signal?.close();
    signal = undefined;
    pendingCandidates = [];
    pendingHostSignals = [];
  }
}

if (window.roomDesktop) {
  void renderHost();
} else {
  void renderViewer();
}
