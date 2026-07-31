# Native 架构治理路线图

> 状态：执行中
> 适用范围：Windows Electron、Android、Renderer、Signal/Relay、媒体辅助进程
> 原则：P0/P1 的安全与可靠性修复不等待架构重写；P2 项目必须以可测量的退出条件逐步替换旧路径。

## 已落地的第一阶段基础

- `ResourceBudgetMonitor` 统一采集温度、电量、充电、省电模式、CPU 核数和可用内存，并约束 GPU enhancement、DeepFilter、深预取、producer 数量和 P2P fallback。
- `protocol-policy.json` 已作为 Node 与 TypeScript 的协议上限来源；后续继续生成 Android/Electron 常量和测试夹具。
- 语音在 4–8 人时使用独立 SFU，未配置 SFU 的部署最多允许 3 人 mesh，避免无界 `O(n²)` 连接。
- Windows 进程音频改为 20 ms 固定 block、有界丢旧队列、独立 writer、MessagePort 与主进程/Renderer 水位反馈。
- 网络诊断开始区分 physical、default-routed、VPN 和 socket-selected path，并保留 IPv6/overlay 地址的隐私属性。

## 里程碑 A：统一预算与准入（DEBT-01、05、06）

### A1 ResourceBudgetActor

把现有 `ResourceBudgetMonitor` 提升为房间级 actor，统一输入：

- CPU、GPU、内存高水位、温度、电量和省电模式；
- 上行带宽、硬件编码 session、TURN allocation；
- 当前 screen/Emby/voice producer、prefetch、MSE 与 GPU enhancement 成本。

所有昂贵操作在启动前申请 lease：original/480p producer、P2P fallback、长距离 seek、深预取、语音 TURN、GPU enhancement。lease 必须有 owner、成本、deadline、释放和抢占规则。

### A2 HardwareEncoderScheduler

按 NVIDIA/Intel/AMD、codec、分辨率和并行 session 建模；启动 producer 前预留 session，失败时回收并降级到低成本 rendition，不允许多个模块各自盲启编码器。

退出条件：

- 任何 producer 或 fallback 都不能绕过 admission API；
- 压测中并发编码 session 不超过设备探测上限；
- critical thermal/low-battery 后 5 秒内释放非必要 lease；
- 每次拒绝/抢占都有结构化 reason code。

## 里程碑 B：拆分业务编排与媒体执行面（DEBT-02、03、04）

### B1 拆分 `channel-session.ts`

按职责迁移到以下 actor，保留一个薄的 composition root：

- `RoomStateActor`
- `SignalLifecycleActor`
- `ScreenPublisherActor`
- `ScreenViewerActor`
- `EmbyControlActor`
- `EmbyDataPlaneActor`
- `FailoverActor`
- `PlaybackClockActor`
- `ResourceBudgetActor`

迁移按状态所有权分批进行，禁止复制同一计时器或 desired state。每个 actor 提供 `start/applyDesiredState/stop`，所有晚到结果必须校验 generation。

### B2 分离 Signal 与 Relay

WebSocket/heartbeat/SDP/ICE 留在 signal 进程；测速、HMAC/SHA、manifest rewrite、Range、磁盘 LRU 和大上传迁到 relay worker/独立进程。两者只交换有界控制消息，relay 饱和不得阻塞 signal loop。

### B3 DynamicProducerController

替换固定 readrate。DirectPlay/remux、硬件转码、软件转码分别设启动水位、追赶速率、暂停/恢复和资源成本，并接受 ResourceBudgetActor 的动态 lease。

退出条件：

- `channel-session.ts` 不再直接拥有媒体模块内部计时器；
- relay 清理/大上传压测下 signal heartbeat p99 不超过基线 1.2 倍；
- producer 策略可在不重建房间的情况下按预算降级或恢复。

## 里程碑 C：低拷贝数据面与增量清单（DEBT-07、08）

优先顺序：

1. audio helper → main → renderer：升级现有 MessagePort/有界 block 为 `SharedArrayBuffer` ring（不可用时保留有界 MessagePort fallback）。
2. FFmpeg stdout → main：固定 slab pool，并把解析与磁盘写入 worker。
3. main → renderer：媒体 payload 使用 transferable 或 shared ring，不走逐包 IPC。
4. HTTPS fetch → cache → MSE：避免同一 segment 在 fetch、CacheStorage 和 append 前重复实体化。
5. P2P packetizer：复用固定 block，限制生产者/消费者水位。

manifest 协议升级为：

```text
baseRevision
addedSegments
removedPrefix
removedSuffix
renditionStateChange
ended
```

若 `baseRevision` 不匹配，客户端请求一次完整快照；增量包和快照使用同一完整性校验。

退出条件：

- 每条媒体路径都有 copy-count、queue depth、drop count；
- 正常播放期间不再产生每包 Electron IPC；
- 慢消费者只丢有界旧数据，不阻塞采集/编码实时线程；
- 长房间 manifest 内存随滑动窗口上限稳定，不随总时长增长。

## 里程碑 D：路径专属遥测与 SLO（DEBT-09、11）

分别建模，不再合并成一个“网络质量”：

- signal WebSocket RTT；
- SFU selected pair/RTT/loss/available bitrate；
- P2P selected pair、direct/TURN、RTT/loss；
- TURN allocation 与 relay RTT；
- CMAF fetch throughput、TTFB、HTTP status。

统一事件 schema 至少覆盖：

- time-to-first-frame、rebuffer ratio；
- decoded FPS、dropped frames、ABR switches；
- fallback latency、MSE rebuild count；
- relay 404/409/5xx、P2P/SFU route；
- memory high-water、producer CPU/GPU；
- resource admission、queue overrun 和 dropped blocks。

退出条件：

- ABR/failover 决策只能读取对应媒体路径 telemetry；
- dashboard 可按 room、viewer、route 和 rendition 过滤；
- 发布门禁包含 TTFF、rebuffer、fallback latency 和 crash-free session SLO。

## 里程碑 E：安全状态与统一协议策略（DEBT-10、12）

敏感状态统一进入平台安全存储：

- owner token、resume token；
- Emby account；
- 最近自建服务器的敏感部分；
- 可关联身份的诊断标识。

`protocol-policy.json` 扩展为唯一策略源，生成或导入：

- TypeScript/Node；
- Electron/C# helper；
- Android Java；
- server validation 与测试 fixtures。

统一的项目包括 payload、segment、上传、缓存、码率、尺寸、FPS、参与人数、队列容量和 deadline。代码中出现未登记的魔法上限时 CI 失败。

退出条件：

- 明文 token/account 不进入 localStorage、日志、崩溃报告或邀请文本；
- 100/250 Mbps、64/96 MiB、30/120 FPS 等边界均有明确语义和单一来源；
- 所有语言实现通过同一 policy conformance suite。

## 发布顺序与门禁

1. A：预算/准入先覆盖新功能和高风险 producer。
2. B：按 actor 迁移，保持 wire protocol 向后兼容。
3. C：逐路径低拷贝，任何新通道必须先有有界退化策略。
4. D：SLO 数据稳定后，才允许自动资源抢占和更激进 ABR。
5. E：安全存储迁移与 protocol generation 可与 A–D 并行，但旧格式删除必须经过一个稳定版本的兼容窗口。

每个里程碑必须具备单元测试、故障注入、长时运行、弱网、VPN/IPv6、低电量/热压和真实设备验证记录；只完成接口骨架不算关闭债务。
