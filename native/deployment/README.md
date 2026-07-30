# 同频共同观看服务部署

## 目标架构

共同观看现在采用以下顺序：

1. `wss://synced.com.cn/signal` 负责频道状态、临时 TURN 凭据和 LiveKit JWT。
2. LiveKit SFU 是影片主链路。放映端只上传一份音视频或 Emby fMP4 数据，SFU
   负责向最多 7 位观众分发。
3. SFU 建连、发布或运行中断时，客户端才发送 `broadcast:watch-ready`，启用原有
   P2P/TURN 链路作为故障备用。
4. coturn 继续服务 P2P、连麦以及 SFU 的严格 NAT 客户端。

信令、coturn 和 LiveKit 都不配置静态带宽上限。码率由端点实测吞吐和 WebRTC
拥塞控制决定。不要重新加入 coturn 的 `max-bps`/`bps-capacity`，也不要在信令
环境中恢复 `RELAY_CAPACITY_BPS`/`RELAY_SESSION_CAPACITY_BPS`。

## Docker Compose（主节点）

准备环境和两个不同的密钥：

```bash
cd deployment
cp .env.example .env
mkdir -p secrets
openssl rand -hex 48 > secrets/turn_secret
openssl rand -hex 48 > secrets/livekit_api_secret
chmod 600 secrets/turn_secret secrets/livekit_api_secret
```

编辑 `.env`，至少确认：

```dotenv
PUBLIC_IP=43.161.195.12
TURN_REALM=synced.com.cn
TURN_URLS=turn:43.161.195.12:3478?transport=udp,turn:43.161.195.12:3478?transport=tcp
SFU_ENABLED=true
SFU_PUBLIC_URL=wss://synced.com.cn/sfu
LIVEKIT_API_KEY=yiqikan_sfu
```

启动并核验：

```bash
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 signal livekit coturn
curl -fsS http://127.0.0.1:8787/readyz
curl -fsS http://127.0.0.1:8787/capabilities
curl -fsS http://127.0.0.1:7880/
```

Compose 固定使用 `livekit/livekit-server:v1.13.4` 与
`coturn/coturn:4.15.0-r0`。LiveKit 使用 host networking；配置由只读 secret
在容器启动时生成，密钥不会出现在进程参数中。

## 反向代理与防火墙

主节点的 `nginx-yiqikan-signal-location.conf` 包含：

- `/signal` → `127.0.0.1:8787`
- `/sfu/` → `127.0.0.1:7880/`，保留 WebSocket upgrade
- `/iceservers` → 信令服务的受 Bearer token 保护的 TURN 刷新接口
- `/healthz`、`/readyz`、`/capabilities` → 信令健康检查

主节点需开放：

- TCP `80`、`443`：证书与 WSS/HTTPS
- TCP `7881`：LiveKit ICE/TCP
- UDP `7882`：LiveKit ICE/UDP mux
- TCP/UDP `3478`：coturn
- UDP `32768-65535`：coturn relay

端口 `7880`、`8787` 和 `6789` 只供本机反向代理/监控访问，不应直接暴露公网。
部署后从服务器外验证：

```bash
curl -fsS https://synced.com.cn/healthz
curl -fsS https://synced.com.cn/capabilities
```

客户端仓库中再运行：

```bash
npm run check:public
npm run check:public:security
npm run check:public:sfu
```

## 备用信令节点

杭州节点只运行 `yiqikan-signal.service`、Nginx 和证书续签。不要在该节点安装或
启动 coturn、STUN、LiveKit、媒体端口兼容代理或 Docker 媒体容器。

备用节点使用：

- `yiqikan-signal-hz.env.example`：8 人房间、腾讯云 STUN/TURN、腾讯云 LiveKit；
- `yiqikan-signal.service`：仅监听 `127.0.0.1:8787`；
- `nginx-yiqikan-standby.conf`：只暴露 `/signal`、`/iceservers` 和健康检查；
- `deploy-standby-routing.sh`：需要调整 ICE 路由时执行原子更新和回滚。

它仍需持有与腾讯云主节点相同的 TURN secret 和 LiveKit API secret，仅用于签发
主节点可验证的临时凭据/JWT；媒体不会经过杭州。公网仅开放 TCP `80/443`，不开放
UDP `443`、TCP/UDP `3478`、LiveKit 端口或 relay 端口范围。`MAX_CLIENTS=96`
只是信令连接容量，房间成员上限仍为 8 人。

当前客户端默认连接 `wss://synced.com.cn/signal`。运维人员需要验证或手动启用
备用节点时可使用 `wss://47.98.173.139/signal`；旧的明文
`ws://47.98.173.139:8787` 地址仍会迁移到腾讯云主入口。

## systemd 信令升级

信令协议仍为 v3。构建端运行：

```bash
npm run bundle:signal
```

将 `release/server/yiqikan-signal.mjs` 与 `deploy-signal-v3.sh` 传到服务器临时
目录，然后执行：

```bash
chmod 700 /tmp/deploy-signal-v3.sh
EXPECTED_SHA256='<发布清单中的哈希>' \
  /tmp/deploy-signal-v3.sh /tmp/yiqikan-signal.mjs
```

脚本会先执行语法检查、原子替换并验证 `/capabilities`。失败时恢复
`/opt/yiqikan/releases/` 中的上一份信令文件。

现有 systemd 主机还需把以下变量加入 `/etc/yiqikan-signal.env`：

```dotenv
MAX_VIEWERS_PER_ROOM=7
SFU_ENABLED=true
SFU_PUBLIC_URL=wss://synced.com.cn/sfu
LIVEKIT_API_KEY=yiqikan_sfu
LIVEKIT_API_SECRET_FILE=/etc/yiqikan-livekit.secret
```

`/etc/yiqikan-livekit.secret` 应为 `root:yiqikan 0640`，并与 LiveKit 服务配置
中的 API secret 完全一致。

主节点沿用 systemd 时，使用仓库中的 `yiqikan-livekit.service`、
`yiqikan-livekit.env.example`、`livekit-entrypoint.sh` 和
`nginx-yiqikan-signal-location.conf`。LiveKit 官方二进制固定为 v1.13.4；
下载 `livekit_1.13.4_linux_amd64.tar.gz` 后必须按官方 `checksums.txt` 校验，
再安装为 `/usr/local/bin/livekit-server`。部署文件位置如下：

```text
/opt/yiqikan/livekit-entrypoint.sh
/etc/yiqikan-livekit.env
/etc/yiqikan-livekit.secret
/etc/systemd/system/yiqikan-livekit.service
/etc/nginx/snippets/yiqikan-signal-location.conf
```

安装后先执行 `systemd-analyze verify` 和 `nginx -t`，再
`systemctl enable --now yiqikan-livekit.service`，确认 7880/TCP、7881/TCP
与 7882/UDP 均已监听。服务必须以 `yiqikan` 用户运行；API secret 与运行时
生成的 LiveKit YAML 均不得写入日志。

## 移除旧带宽限制

历史脚本名 `deploy-turn-capacity.sh` 为兼容旧运维命令而保留，但当前行为是：

- 备份 coturn 与信令配置；
- 删除 `max-bps`、`bps-capacity`；
- 删除信令中的两个 `RELAY_*_BPS` 变量；
- 在改动前校验 coturn 的公网地址、realm、REST secret，以及信令的
  `TURN_URLS` 和 TURN secret 文件均非空且可读；
- 将 `max-allocate-lifetime` 统一为 7200 秒；客户端仍会在临时凭据剩余
  约 30% 有效期时主动刷新 ICE 配置；
- 重启并检查 coturn UDP/TCP 监听与信令就绪状态；
- 从 `/readyz` 核验 8 人房间上限、SFU 状态及所有 relay 带宽上限均未启用；
- 任一步失败即回滚。

维护窗口执行：

```bash
chmod 700 /tmp/deploy-turn-capacity.sh
/tmp/deploy-turn-capacity.sh
```

## 压测与运行检查

本地信令压测：

```bash
node server/load-test.mjs --clients 32 --duration 20 --throughput-clients 2
```

压测工具默认拒绝远程目标。维护窗口确需压测公网节点时，显式设置
`YIQIKAN_LOADTEST_ALLOW_REMOTE=true` 并逐级增加连接数。

TURN 连通与可选吞吐检查：

```powershell
$env:YIQIKAN_TURN_TRANSPORT = "udp"
$env:YIQIKAN_TURN_BENCH_BYTES = "1048576"
npx electron scripts/smoke-public-turn.cjs
```

静态上限已经移除，但云主机公网带宽、跨境链路和客户端接入网仍是物理约束。
出现拥塞时应扩容或增加 SFU 节点，而不是关闭 WebRTC 拥塞控制。
