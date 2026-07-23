# 一起看 Native

Windows 放映端使用 Electron 原生桌面采集，在用户选择窗口后由 Chromium
`desktopCapturer` 注入系统 loopback 音频。Android 端是轻量观看器。媒体通过
WebRTC 点对点传输，服务器只负责交换 SDP/ICE；遇到严格 NAT 时使用自建 coturn
中继。

## 当前产品边界

- Windows EXE：选择单个窗口、Windows 系统混音、1080p/2K/4K 三档、房间码、
  二维码、实时分辨率/帧率/码率。
- Android APK：房间码加入、硬件解码播放、声音和全屏。
- EXE 内置本地信令服务器；同一 Wi‑Fi 下无需另外部署服务器。
- 第一版不内置连麦，建议继续使用 OOPZ；这也避免电影声和语音回声互相干扰。
- 受 DRM 保护的视频或音频仍可能被系统阻止采集。

## 本地开发

```powershell
npm install
npm run dev:signal
```

另开一个终端：

```powershell
npm run start:electron
```

观看端可运行 `npm run dev:web`，打开页面并使用同一服务器和房间码。

## 构建

```powershell
npm run dist:win
npm run apk:debug
```

Windows 便携版输出到 `release/windows/`。Android 调试安装包输出到
`android/app/build/outputs/apk/debug/`。

## 中国大陆部署

部署目录提供信令服务与 coturn 的 Docker Compose 示例。测试阶段可以直接使用
大陆云主机公网 IP：

1. 放通 TCP `8787`、TCP/UDP `3478`、UDP `49160-49200`。
2. 复制 `.env.example` 为 `.env`，填写公网 IP 与随机 TURN secret。
3. 执行 `docker compose up -d --build`。
4. EXE 与 APK 的服务器地址填写 `ws://公网IP:8787/signal`。

正式分发建议使用已备案域名和 `wss://`，由 Caddy/Nginx 终止 TLS。若房间人数较多
或主播上行不足，应将点对点模式替换为同地域自建 LiveKit SFU。
