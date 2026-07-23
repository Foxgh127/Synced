"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const VDO_ORIGIN = "https://vdo.ninja";
const STREAM_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

type HostStatus = "idle" | "preparing" | "sharing" | "error";
type ViewerStatus = "waiting" | "connected" | "offline";

type DetailedStateItem = {
  streamID?: string;
  localStream?: boolean;
  localstream?: boolean;
  videoTrack?: boolean;
  audioTrack?: boolean;
  videoVisible?: boolean;
};

function createStreamId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `yk${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function buildPublisherUrl(streamId: string) {
  const url = new URL(VDO_ORIGIN);
  const params: Record<string, string> = {
    push: streamId,
    screenshare: "1",
    autostart: "1",
    cleanoutput: "1",
    language: "cn",
    screensharequality: "4k",
    screensharefps: "30",
    screensharecontenthint: "motion",
    screensharestereo: "3",
    screenshareaec: "0",
    screenshareautogain: "0",
    screensharedenoise: "0",
    systemaudio: "include",
    displaysurface: "window",
    selfbrowsersurface: "exclude",
    surfaceswitching: "include",
    ovb: "30000",
    mvb: "40000",
  };

  Object.entries(params).forEach(([key, value]) =>
    url.searchParams.set(key, value),
  );
  return url.toString();
}

function buildViewerUrl(streamId: string) {
  const url = new URL(VDO_ORIGIN);
  const params: Record<string, string> = {
    view: streamId,
    cleanoutput: "1",
    autoplay: "1",
    language: "cn",
    screensharestereo: "2",
    screensharebitrate: "30000",
    allowscreenvideo: "1",
    allowscreenaudio: "1",
    sharperscreen: "1",
    scale: "100",
    volume: "1",
  };

  Object.entries(params).forEach(([key, value]) =>
    url.searchParams.set(key, value),
  );
  return url.toString();
}

function Brand() {
  return (
    <div className="brand" aria-label="一起看">
      <span className="brand-mark" aria-hidden="true" />
      <span>一起看</span>
    </div>
  );
}

function BroadcastVisual() {
  return (
    <div className="broadcast-visual" aria-hidden="true">
      <div className="broadcast-rings">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="screen-illustration">
        <div className="screen-bar">
          <i />
          <i />
          <i />
        </div>
        <div className="screen-view">
          <div className="broadcast-core">
            <span className="play-mark" />
          </div>
          <div className="signal-line">
            {Array.from({ length: 9 }).map((_, index) => (
              <span key={index} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="route-loading" role="status" aria-live="polite">
      <span className="loading-orbit" aria-hidden="true" />
      <span>正在准备放映室…</span>
    </div>
  );
}

export default function Home() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hasStartedRef = useRef(false);
  const statusRef = useRef<HostStatus>("idle");

  const [routeReady, setRouteReady] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [invalidViewerLink, setInvalidViewerLink] = useState(false);
  const [viewerStatus, setViewerStatus] =
    useState<ViewerStatus>("waiting");
  const [soundEnabled, setSoundEnabled] = useState(false);

  const [hostStatus, setHostStatus] = useState<HostStatus>("idle");
  const [streamId, setStreamId] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState("");
  const [audioAvailable, setAudioAvailable] = useState<boolean | null>(
    null,
  );
  const [pickerSlow, setPickerSlow] = useState(false);
  const [frameNonce, setFrameNonce] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("watch");
    if (value) {
      if (STREAM_ID_PATTERN.test(value)) {
        setViewerId(value);
      } else {
        setInvalidViewerLink(true);
      }
    }
    setRouteReady(true);
  }, []);

  useEffect(() => {
    statusRef.current = hostStatus;
  }, [hostStatus]);

  const publisherSrc = useMemo(
    () => (streamId ? buildPublisherUrl(streamId) : ""),
    [streamId],
  );
  const viewerSrc = useMemo(
    () => (viewerId ? buildViewerUrl(viewerId) : ""),
    [viewerId],
  );

  const requestDetailedState = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      {
        getDetailedState: true,
        cib: viewerId ? "viewer-state" : "host-state",
      },
      VDO_ORIGIN,
    );
  }, [viewerId]);

  useEffect(() => {
    if (!publisherSrc && !viewerSrc) return;
    const interval = window.setInterval(requestDetailedState, 1600);
    return () => window.clearInterval(interval);
  }, [publisherSrc, viewerSrc, requestDetailedState]);

  useEffect(() => {
    if (hostStatus !== "preparing") {
      setPickerSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setPickerSlow(true), 12000);
    return () => window.clearTimeout(timer);
  }, [hostStatus, frameNonce]);

  useEffect(() => {
    const receiveVdoMessage = (event: MessageEvent) => {
      if (
        event.origin !== VDO_ORIGIN ||
        event.source !== frameRef.current?.contentWindow ||
        !event.data ||
        typeof event.data !== "object"
      ) {
        return;
      }

      const data = event.data as Record<string, unknown>;

      if (viewerId) {
        if (
          data.action === "guest-connected" ||
          "video-connected" in data ||
          "guest-connected" in data
        ) {
          setViewerStatus("connected");
        }

        if (
          data.action === "guest-disconnected" ||
          "video-disconnected" in data ||
          "guest-disconnected" in data
        ) {
          setViewerStatus("offline");
        }
      }

      if (!data.detailedState || typeof data.detailedState !== "object") {
        return;
      }

      const items = Object.values(
        data.detailedState as Record<string, DetailedStateItem>,
      );

      if (viewerId) {
        const remote = items.find(
          (item) =>
            !item.localStream &&
            !item.localstream &&
            (item.streamID === viewerId || item.videoVisible),
        );
        if (remote) setViewerStatus("connected");
        return;
      }

      const local = items.find(
        (item) => item.localStream || item.localstream,
      );

      if (local?.videoTrack) {
        hasStartedRef.current = true;
        setHostStatus("sharing");
        setAudioAvailable(Boolean(local.audioTrack));
        setPickerSlow(false);
      } else if (
        hasStartedRef.current &&
        statusRef.current === "sharing"
      ) {
        setNotice("窗口分享已停止");
        setHostStatus("idle");
        setStreamId(null);
        setShareUrl("");
        setAudioAvailable(null);
        hasStartedRef.current = false;
      }
    };

    window.addEventListener("message", receiveVdoMessage);
    return () => window.removeEventListener("message", receiveVdoMessage);
  }, [viewerId]);

  const beginSharing = useCallback(() => {
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== "function"
    ) {
      setHostStatus("error");
      return;
    }

    const nextId = createStreamId();
    const nextUrl = new URL(window.location.href);
    nextUrl.search = "";
    nextUrl.hash = "";
    nextUrl.searchParams.set("watch", nextId);

    hasStartedRef.current = false;
    setNotice("");
    setCopyState("idle");
    setAudioAvailable(null);
    setPickerSlow(false);
    setStreamId(nextId);
    setShareUrl(nextUrl.toString());
    setHostStatus("preparing");
    setFrameNonce((value) => value + 1);
  }, []);

  const retrySharing = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      { close: true },
      VDO_ORIGIN,
    );
    setStreamId(null);
    window.setTimeout(beginSharing, 350);
  }, [beginSharing]);

  const stopSharing = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      { close: true },
      VDO_ORIGIN,
    );
    hasStartedRef.current = false;
    setHostStatus("idle");
    setStreamId(null);
    setShareUrl("");
    setAudioAvailable(null);
    setPickerSlow(false);
    setNotice("分享已安全结束");
  }, []);

  const copyShareLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2200);
    } catch {
      setCopyState("failed");
    }
  }, [shareUrl]);

  const openViewer = useCallback(() => {
    if (shareUrl) {
      window.open(shareUrl, "_blank", "noopener,noreferrer");
    }
  }, [shareUrl]);

  const enableViewerSound = useCallback(() => {
    const target = frameRef.current?.contentWindow;
    target?.postMessage({ speaker: true }, VDO_ORIGIN);
    target?.postMessage({ mute: false }, VDO_ORIGIN);
    target?.postMessage({ volume: 1 }, VDO_ORIGIN);
    setSoundEnabled(true);
  }, []);

  const enterFullscreen = useCallback(async () => {
    try {
      await frameRef.current?.requestFullscreen();
    } catch {
      // Fullscreen can be rejected by browser policy; the inline player remains usable.
    }
  }, []);

  if (!routeReady) return <LoadingScreen />;

  if (invalidViewerLink) {
    return (
      <main className="page">
        <section className="app-shell compact-shell">
          <Brand />
          <div className="empty-state">
            <span className="status-pill status-pill-warning">
              链接无法识别
            </span>
            <h1>这个观看链接不完整</h1>
            <p>请让分享者重新复制完整链接，再发给你一次。</p>
            <a className="primary-action anchor-action" href="/">
              返回首页
            </a>
          </div>
          <p className="footer-note">底层连接由 VDO.Ninja 提供</p>
        </section>
      </main>
    );
  }

  if (viewerId) {
    return (
      <main className="viewer-page">
        <section className="viewer-shell" aria-labelledby="viewer-title">
          <header className="viewer-header">
            <Brand />
            <div className="viewer-header-actions">
              <span
                className={`connection-state connection-${viewerStatus}`}
                role="status"
                aria-live="polite"
              >
                <i aria-hidden="true" />
                {viewerStatus === "connected"
                  ? "直播已连接"
                  : viewerStatus === "offline"
                    ? "分享已结束"
                    : "正在等待画面"}
              </span>
              <button
                className={`soft-button ${soundEnabled ? "is-active" : ""}`}
                type="button"
                onClick={enableViewerSound}
              >
                <span className="sound-icon" aria-hidden="true" />
                {soundEnabled ? "声音已开启" : "开启声音"}
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="全屏观看"
                title="全屏观看"
                onClick={enterFullscreen}
              >
                <span className="fullscreen-icon" aria-hidden="true" />
              </button>
            </div>
          </header>

          <div className="viewer-stage">
            <iframe
              ref={frameRef}
              className="vdo-frame viewer-frame"
              src={viewerSrc}
              title="一起看电影直播画面"
              allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
              allowFullScreen
              referrerPolicy="no-referrer"
              onLoad={requestDetailedState}
            />
            {viewerStatus !== "connected" && (
              <div className="viewer-waiting" aria-hidden="true">
                <div className="waiting-rings">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="waiting-play" />
              </div>
            )}
          </div>

          <footer className="viewer-footer">
            <div>
              <h1 id="viewer-title">好友放映室</h1>
              <p>
                {viewerStatus === "connected"
                  ? "画面已接通。建议佩戴耳机并进入全屏。"
                  : viewerStatus === "offline"
                    ? "分享者已经停止共享，可以关闭此页面。"
                    : "保持页面打开，分享开始后会自动出现画面。"}
              </p>
            </div>
            <span>链接是进入放映室的钥匙，请勿公开转发</span>
          </footer>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <section
        className={`app-shell host-${hostStatus}`}
        aria-labelledby="hero-title"
      >
        <header className="shell-header">
          <Brand />
          {hostStatus !== "idle" && hostStatus !== "error" && (
            <span
              className={`connection-state ${
                hostStatus === "sharing"
                  ? "connection-connected"
                  : "connection-waiting"
              }`}
              role="status"
              aria-live="polite"
            >
              <i aria-hidden="true" />
              {hostStatus === "sharing" ? "正在分享" : "等待选择窗口"}
            </span>
          )}
        </header>

        {hostStatus === "idle" && (
          <div className="hero">
            <div className="hero-copy">
              {notice && (
                <div className="inline-notice" role="status">
                  <span aria-hidden="true">✓</span>
                  {notice}
                </div>
              )}
              <h1 id="hero-title">一键分享，一起看电影</h1>
              <p className="support">
                选择一个窗口，我们会自动请求共享画面与声音，并生成观看链接。
              </p>
              <button
                className="primary-action"
                type="button"
                onClick={beginSharing}
              >
                开始分享
                <span className="button-arrow" aria-hidden="true" />
              </button>
              <ul className="trust" aria-label="产品特点">
                <li>无需安装</li>
                <li>高清低延迟</li>
                <li>链接即看</li>
              </ul>
            </div>
            <BroadcastVisual />
          </div>
        )}

        {hostStatus === "error" && (
          <div className="empty-state">
            <span className="status-pill status-pill-warning">
              当前浏览器不支持
            </span>
            <h1 id="hero-title">请换用最新版 Chrome 或 Edge</h1>
            <p>
              屏幕分享需要安全连接和支持窗口捕获的现代浏览器。
            </p>
            <button
              className="primary-action"
              type="button"
              onClick={() => setHostStatus("idle")}
            >
              返回
            </button>
          </div>
        )}

        {(hostStatus === "preparing" || hostStatus === "sharing") && (
          <div className="sharing-layout">
            <section className="sharing-copy">
              {hostStatus === "preparing" ? (
                <>
                  <span className="status-pill">
                    <i className="pulse-dot" aria-hidden="true" />
                    正在唤起窗口选择器
                  </span>
                  <h1 id="hero-title">选择电影窗口</h1>
                  <p className="support">
                    选择 PotPlayer、VLC 或浏览器标签页，并确认“分享音频”已开启。
                  </p>
                  <ol className="steps">
                    <li>
                      <span>1</span>
                      选择正在播放电影的窗口
                    </li>
                    <li>
                      <span>2</span>
                      保持共享音频选项开启
                    </li>
                    <li>
                      <span>3</span>
                      分享期间不要最小化播放器
                    </li>
                  </ol>
                  {pickerSlow && (
                    <div className="capture-help" role="status">
                      <p>没有看到选择器，或刚才点了取消？</p>
                      <button type="button" onClick={retrySharing}>
                        重新选择窗口
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <span className="status-pill status-pill-live">
                    <i aria-hidden="true" />
                    直播中
                  </span>
                  <h1 id="hero-title">电影正在分享</h1>
                  <p className="support">
                    把下面的链接发给朋友，他们打开后即可观看。
                  </p>

                  <div className="link-card">
                    <div className="link-card-copy">
                      <span>观看链接</span>
                      <strong title={shareUrl}>{shareUrl}</strong>
                    </div>
                    <button
                      className="copy-button"
                      type="button"
                      onClick={copyShareLink}
                    >
                      <span className="copy-icon" aria-hidden="true" />
                      {copyState === "copied"
                        ? "已复制"
                        : copyState === "failed"
                          ? "复制失败"
                          : "复制链接"}
                    </button>
                  </div>

                  <div className="stream-facts">
                    <div
                      className={`fact ${
                        audioAvailable ? "fact-good" : "fact-warning"
                      }`}
                    >
                      <span
                        className="audio-status-icon"
                        aria-hidden="true"
                      />
                      <div>
                        <strong>
                          {audioAvailable
                            ? "电影声音已共享"
                            : "未检测到共享音频"}
                        </strong>
                        <small>
                          {audioAvailable
                            ? "立体声高质量模式"
                            : "可结束后重试，并勾选分享音频"}
                        </small>
                      </div>
                    </div>
                    <div className="fact">
                      <span
                        className="quality-status-icon"
                        aria-hidden="true"
                      >
                        4K
                      </span>
                      <div>
                        <strong>优先 4K · 30 FPS</strong>
                        <small>实际画质会根据网络自动调整</small>
                      </div>
                    </div>
                  </div>

                  <div className="sharing-actions">
                    <button
                      className="soft-button"
                      type="button"
                      onClick={openViewer}
                    >
                      打开观看页
                    </button>
                    <button
                      className="danger-button"
                      type="button"
                      onClick={stopSharing}
                    >
                      <span aria-hidden="true" />
                      停止分享
                    </button>
                  </div>
                </>
              )}
            </section>

            <section
              className="preview-card"
              aria-label={
                hostStatus === "sharing" ? "当前分享预览" : "分享准备区"
              }
            >
              <div className="preview-bar">
                <div aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
                <span>
                  {hostStatus === "sharing" ? "分享预览" : "正在准备"}
                </span>
              </div>
              <div className="preview-viewport">
                <iframe
                  key={frameNonce}
                  ref={frameRef}
                  className="vdo-frame publisher-frame"
                  src={publisherSrc}
                  title="VDO.Ninja 窗口分享"
                  allow="autoplay; fullscreen; picture-in-picture; display-capture *; microphone *; camera *; encrypted-media"
                  allowFullScreen
                  referrerPolicy="no-referrer"
                  onLoad={requestDetailedState}
                />
                {hostStatus === "preparing" && (
                  <div className="capture-overlay" aria-hidden="true">
                    <div className="capture-orbit">
                      <span />
                      <span />
                      <span />
                    </div>
                    <p>请在浏览器弹窗中选择电影窗口</p>
                  </div>
                )}
              </div>
              <div className="preview-footer">
                <span>
                  <i
                    className={
                      hostStatus === "sharing"
                        ? "dot-live"
                        : "dot-waiting"
                    }
                    aria-hidden="true"
                  />
                  {hostStatus === "sharing"
                    ? "端到端低延迟传输"
                    : "等待浏览器授权"}
                </span>
                <span>VDO.Ninja</span>
              </div>
            </section>
          </div>
        )}

        <footer className="shell-footer">
          <p className="footer-note">
            建议使用 Windows 11 与最新版 Chrome / Edge
          </p>
          <p className="powered-note">
            底层连接由 VDO.Ninja 提供 · 分享链接请仅发送给可信好友
          </p>
        </footer>
      </section>
    </main>
  );
}
