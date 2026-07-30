# 同频 / Synced Native

完整的系统架构、端到端媒体/连麦原理、全部目录与重要文件索引见
[`../PROJECT_GUIDE.md`](../PROJECT_GUIDE.md)。

Windows 桌面端先进入频道，再随时选择观看或接棒放映。普通模式由 Electron 选择窗口，
再由原生 Windows 音频助手按该窗口所属进程树采集声音；Emby 高清模式则由程序直接
读取服务器媒体流，全程不捕获屏幕。Android 端只能观看，但同样支持扫码、连麦、
频道聊天和画面弹幕。普通屏幕共享主链路使用腾讯云 LiveKit SFU：放映端发布显式
1440p/1080p/720p 层，SFU 按每位观看者独立转发；SFU 故障时自动回退有总上行预算的
WebRTC P2P，严格 NAT 下再使用腾讯云 TURN。Emby 则生成多档 GOP 对齐 CMAF，
通过带短期签名的 HTTPS 分片服务让每位观看者独立下载。信令服务处理频道状态、
临时 ICE/SFU/分片凭据与有界分片缓存，不保存聊天历史或 Emby 登录凭据。

## 当前产品边界

- Windows EXE：任意频道成员都可开始或停止放映；频道码通过仅保存在创建者设备上的
  256 位凭证的 SHA-256 指纹绑定创建者，知道频道码的人无法反推出频道主凭证；
  频道主离线时管理权不会自动落到“第一个/最后一个在线的人”；
  创建者回来后会恢复频道主身份；
  支持指定窗口、该窗口进程树
  独立声音、原画/高清/标清/流畅与 24/30/60/90/120 帧自由组合、频道码/二维码、实时码率、
  带宽不足提醒和自定义频道。
- Windows 放映端还可选择 **Emby 高清播放**：程序在 Electron 主进程中直接登录
  Emby、读取媒体库和 `PlaybackInfo`，不调用屏幕捕获，也不依赖 Hills Lite、mpv
  或其他外部播放器。可以保存多个服务器/账户并一键切换，输入关键词时会联合搜索
  全部已保存服务器。密码只用于一次登录且不会保存；访问令牌由 Windows 系统加密
  后保留在本机，使用时只在主进程解密，经随机本机回环代理提供给随包 FFmpeg，
  绝不进入渲染器、信令、房间状态、FFmpeg 参数或朋友设备。优先 Direct Play，
  其次 Direct Stream；客户端同时声明 fMP4 HLS、MPEG-TS HLS 和渐进式 MP4。
  首次协商或启动失败时会自动改用 MPEG-TS 兼容档并关闭视频流拷贝重试；需要兼容
  或限码时只让 Emby 服务器统一转码一次。
- Emby 媒体由本机 FFmpeg 生成共享时间轴、约 2 秒 GOP 对齐的 CMAF 分片。默认启动
  1080p8/720p4，original 与 480p18 根据观看端实际需求启停；空闲档位会真正停止，
  再次需要时从当前锚点以新 init epoch 和单调全局 segment 序号重建。所有辅助 producer 限速，
  共享上传最多使用测速后剩余上行的 65%。放映端磁盘 spool 按随机 `sessionId` 隔离，
  同档严格串行上传且清单只公开连续分片前缀；独立退避 actor 会在中继恢复后自动补传。
  清单使用 publisher/eviction revision 与前缀 tombstone 协调服务端 LRU；结构化 409
  会触发裁剪同步或本地补传，活跃会话的当前/未来分片不会在磁盘压力下被打洞。
  观看端以 Urgent/Warm/Prefetch 三队列独立 ABR 拉取，清单使用 ETag/304，Range/正文
  空闲超时会真正中止并重试，时间洞和 404 会刷新清单并从关键帧恢复。一级内存只保存即将追加的片段，
  二级磁盘缓存默认按可用空间 4%、最高 5 GiB，三级 SourceBuffer 只保留播放点附近；
  seek 和画质切换使用 generation/AbortController，且只从真实关键帧开始。正常情况下
  LiveKit/P2P 只承载控制面；HTTPS 连续失败三次时，仅故障观看端临时接收主播最近
  30–60 秒的部分可靠 P2P 媒体缓存；请求早于 `session-ready` 时由主播暂存，观看端在
  收到带 transport epoch 的 ACK 前按 500 ms/1 s/2 s 有界重发，三次恢复探测成功后
  热切回原 HTTPS ABR/MSE。
- Windows 观看端可启用实际的 WebGL2 GPU 空间增强（视频纹理缩放与保守锐化，
  无 GPU→CPU→GPU 回读）。它只用于远端 Emby 360p–1080p 放大到接近 2K/4K，
  字幕和弹幕在增强后合成；SR p95 超过 14 ms、解码丢帧、资源压力、上下文丢失或
  同机屏幕共享时自动关闭并冷却，频道自适应判定的 decoder/encoder/render 压力也会
  直接关闭增强并统一让出资源。能力握手只声明真实可用后端；仓库未捆绑需要
  NVIDIA 授权 SDK/运行时的 RTX Video 原生后端，也不会把普通锐化伪装成 RTX/DLSS。
- 成员入房即上报 MSE、H.264、HEVC 和 AAC 解码能力。默认统一使用兼容性最高的
  H.264/AAC；“允许 HEVC 直传”会显示本机与当前观众的检测结果，只有全员支持才可
  勾选。HEVC 是否可用取决于操作系统媒体栈、硬件和客户端容器支持，并非只看显卡型号；
  不确定时自动回退 H.264。DTS/TrueHD 等音频会在 Emby 或放映端仅
  转换一份 AAC，SRT/VTT/ASS/SSA 作为独立字幕传输；PGS 等图片字幕不会静默烧录，
  界面会要求改选文本字幕或由 Emby 服务器转码。
- 画面直接发送 Chromium/Windows Graphics Capture 的原始窗口轨，不再先画入
  Canvas。这样可避开硬件播放器黑屏，也让 Chromium 保留 HDR 色彩信息并在
  SDR 观看端执行色调映射，避免旧合成链路的高光过曝。Windows 高 DPI 缩放下会
  重新按物理像素创建捕获轨，避免 150% 缩放把 1080p 窗口实际发送成低分辨率画面。
- Android APK：输入频道码、扫描邀请二维码或邀请链接加入，支持硬件解码播放、
  横屏沉浸全屏、按观看者单独限制清晰度/帧率、声音、连麦和聊天。全屏使用与窗口
  状态相同的居中播放工具栏，统一控制弹幕、裁剪、画质、小窗与全屏；左侧上下滑动
  调亮度，右侧上下滑动调媒体音量。
- Windows 与 Android 全屏都沿用同一套播放工具栏与实时统计；鼠标或触摸后显示，
  停止操作 3 秒后自动隐藏，不再保留右上角裁剪和右下角全屏两套重复入口。
  “小窗模式”开关常驻全屏按钮旁边，
  用滑块和“开/关”文字明确显示当前状态；放映者和观看者都可开启。开启后点击
  Windows 最小化按钮才会显示当前放映画面的系统画中画，恢复主窗口时自动收起；
  关闭状态下最小化行为保持不变。
- 频道内侧栏提供“游戏”和“音乐”。“游戏”先进入本地游戏中心，目前内置沙盒加载
  **吹牛**，首页不会显示游戏入口；游戏页面禁用 Node.js、启用上下文隔离和沙盒，
  并限制为指定站点。“音乐”可从网易云音乐、QQ 音乐、酷狗音乐、汽水音乐或任意
  已打开的应用窗口选择伴奏，只采集该应用进程树的声音。伴奏以立体声混入频道音轨，
  其他成员会自动以免麦克风权限的只听模式接入；关闭自己的麦克风不会停止伴奏。
- 最多 8 人；所有人都可加入 48 kHz 全频 Opus 连麦。降噪按强度依次为“自然降噪”
  （平台保真处理）、“清晰人声”（语音隔离、人声频段增强与中等动态）和“强力消噪”
  （本地 DeepFilterNet3 AudioWorklet，断网也可加载）。三档使用不同的高通、增益
  与压缩参数，并共用 -3 dB 防爆音限幅。普通连麦按档位使用 224–256 kbps；
  共享伴奏时使用立体声 256–320 kbps、带内 FEC 和可变码率。即使
  全员经过 TURN 时仍受实际公网吞吐和 WebRTC 拥塞控制约束；可调连麦总音量以及
  每位朋友的独立音量。
- 频道界面提供成员列表、聊天记录和最近频道一键重进。观看者在播放器上看到弹幕；
  Windows 放映者无需盯着软件窗口，透明原生覆盖层会把同一条弹幕显示在原播放器
  窗口上；无人放映时，无论是否连麦，Windows 弹幕都会切换为当前显示器的全屏、
  点击穿透覆盖层，应用播放器内不再重复显示。这是与“有人放映”互斥的独立模式。
  弹幕不再烧录进视频轨，因此不会重新引入 Canvas 黑屏或破坏 HDR。
  聊天记录右下显示服务端时间戳，电影弹幕不附带时间；弹幕从画面最右边界外进入。
- 观看端只有在实际解码出第一帧后才报告成功；每轮协商带独立代次标识，迟到的
  SDP/ICE 不会污染新连接。首轮优先使用广泛具备硬件解码、并可在支持设备上硬件
  编码的 H.264，失败后再轮换 VP9 与 VP8，
  并提供手动重连，避免加入、放映和网络恢复同时发生时一直停在黑屏。
- 信令短暂重连不会再销毁仍然健康的 SFU/P2P 观看链路；接收端把网络、编码、
  解码、渲染与传输静默分别分类，严重压力在 1–2 秒内降档，连续稳定至少 20 秒且
  带宽达到下一档 1.5 倍后才升档。SFU 观看端直接调用逐订阅者的分辨率、帧率和
  quality API，不请求主播重建全局流；`getStats()` 超时只降低统计置信度，实际
  视频帧推进始终是更强的健康证据。电影接收端使用独立的约 180 ms 抖动目标，
  语音直连约 90 ms、
  中继约 125 ms；
  码率按真实捕获像素而不是“原画”8K 上限计算，1080p30 不再错误冲到 32 Mbps。
  稳定链路由发送端保持请求的物理分辨率；只有编码器连续报告 CPU 压力时，才临时
  切为帧率优先，压力稳定恢复 10 秒后自动回原画。
- 连麦默认把远端 WebRTC 音轨直接送到系统播放，避免 Android/WebView 中
  Web Audio 已显示播放却输出静音；超过 100% 的增益才启用 Web Audio，并在上下文
  被系统挂起时自动退回直放。麦克风、播放上下文、ICE 路径和“已连接但无 RTP”
  都有自动恢复。强降噪 AudioWorklet 异常时会立即交叉淡入独立直通支路，再后台
  回退到系统实时通话降噪；远端 mute/ended、音频元素卡住、Android 音频焦点和
  设备路由变化也会自动修复。
- EXE 只使用受 TLS 保护的公网信令，不包含或启动本地信令服务器。腾讯云是主信令，
  阿里云是唯一备用信令入口并提供同域 HTTPS CMAF 缓存；自动化测试使用独立的随机
  回环端口，不进入生产包。
- 窗口声音要求 Windows 10 2004（内部版本 19041）或更高版本。Windows API
  按进程树而不是窗口音频会话采集，因此同一播放器进程里的多个窗口可能共享声音；
  “同频”与其他连麦软件属于不同进程，不会被采入影片声。每次采集都有独立会话号，
  helper/IPC/AudioWorklet 任一层中断都会进入自动重建；已有观看连接优先直接替换音轨，
  缺少音频 sender 的连接会重新协商，不再静默退化为只有画面。
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
npm run release:all
npm run dist:portable
npm run apk:release
npm run apk:debug
npm run smoke:audio
npm run smoke:media
npm run smoke:emby
npm run smoke:emby-ui
```

Windows 构建需要 .NET 9 SDK；脚本会优先使用
`native/.toolchains/dotnet-sdk/dotnet.exe`，否则使用系统 `dotnet`。Android 构建
需要 JDK 21 与 Android SDK。

Windows 包内含固定 SHA-256 的 FFmpeg 8.1 LGPL 独立可执行文件，用于 Emby
解复用/重封装、GOP 对齐的多档生成与必要的音视频转换；优先探测 NVENC/QSV/AMF，
软件兜底只承诺有界的 720p/1080p。`npm run check` 会执行
`scripts/check-ffmpeg-runtime.mjs`，拒绝版本、哈希或许可配置不符的二进制；
来源和对应源码提交见 [`vendor/ffmpeg/README.md`](./vendor/ffmpeg/README.md)。

Windows 便携版输出到 `release/windows-dist/`。Android 调试安装包输出到
`android/app/build/outputs/apk/debug/`，正式签名 APK 与安全校验报告放在
`release/android/`。每次可交付更新都必须先同步提升 `package.json`、
Android `versionName/versionCode`，再运行 `npm run release:all`；脚本会同时生成
Windows 便携版、正式 APK、信令服务 bundle 和整套 SHA-256 清单，版本不一致、
Android Lint、签名证书、权限白名单或关键安全属性任一校验失败都会停止发布。

## 中国大陆部署

生产主节点位于腾讯云 `43.161.195.12`（`synced.com.cn`），运行信令、LiveKit
SFU、coturn、HTTPS CMAF 分片缓存与 Nginx。普通屏幕默认经 SFU 分发；SFU 故障
时才切换 P2P，需要中继时使用腾讯云 TURN。Emby 始终走 HTTPS 多档分片。阿里云
`47.98.173.139` 保留备用信令、独立有界 CMAF 分片缓存、Nginx 和证书续签，
但不运行 STUN、TURN 或 LiveKit：

1. 腾讯云开放 TCP `80/443/3478/7881`、UDP `3478/7882` 与 coturn relay
   端口范围；阿里云的信令和 CMAF 分片服务都只通过 TCP `80/443` 暴露。
2. 两台机器的 Node 信令都只监听 `127.0.0.1:8787`，由 Nginx 提供 WSS。
3. EXE 与 APK 默认连接 `wss://synced.com.cn/signal`。运维手动切换或验证时可使用
   `wss://47.98.173.139/signal`；旧明文阿里云地址仍会迁移到腾讯云。APK 禁止任意
   明文网络流量，代理或运营商也不能篡改信令内容。
4. 旧版 `host:create`/`viewer:join` 默认关闭，避免绕过创建者凭证抢占频道码。
5. Nginx 部署设置 `TRUST_PROXY=true`，服务端只接受来自本机反向代理的
   `X-Forwarded-For`，使每 IP 限流作用于真实用户；Docker 直连模式保持为 `false`。

首次从没有私有频道主凭证的旧版本升级时，应用会轮换一次频道码。之后频道码与
本机私有凭证稳定绑定；仅复制/扫码频道码不会泄露频道主身份。

域名和备用 IP 使用 Let’s Encrypt 短期受信任证书并由 Nginx 自动续签。腾讯云
coturn、LiveKit 和信令不设置静态带宽上限，吞吐由实际公网容量与 WebRTC 拥塞控制
决定。当前发布只生成 Windows 便携版和 Android APK，不生成安装版。便携版首次
放映时会申请一次管理员授权，用于添加稳定的程序级 TCP/UDP 入站规则；应用本身仍以
普通用户权限运行。

腾讯云公网 IP 的注册地域为香港；云主机峰值带宽并不保证中国大陆到香港的端到端
吞吐。影片因此优先使用 SFU 并保留 P2P 回退。若外部 TURN 吞吐基准持续偏低，应
扩容或迁移到更合适的线路，而不是继续抬高客户端码率。可设置
`SYNCED_TURN_BENCH_BYTES=1048576` 运行
`scripts/smoke-public-turn.cjs` 复测真实中继吞吐。

语音 TURN 的 UDP 与 TCP 必须分别从服务器外部验证。`TURN_TCP_ENABLED` 默认是
`true`；云安全组、主机防火墙和 coturn 必须同时放通 TCP `3478`，并用下面的
TCP 自检确认：

```powershell
$env:SYNCED_TURN_TRANSPORT = "tcp"
npx electron scripts/smoke-public-turn.cjs
```

若 TCP 自检失败却仍把 TCP URL 下发给客户端，屏蔽 UDP 的公司网/公共 Wi‑Fi 会
长时间尝试一个实际不可用的中继地址，表现为“已经加入连麦但没有声音”。
