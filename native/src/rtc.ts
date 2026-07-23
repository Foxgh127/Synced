import type { QualityPreset } from "./config";

export interface SignalEnvelope {
  type: string;
  room?: string;
  viewerId?: string;
  target?: string;
  from?: string;
  data?: RTCSessionDescriptionInit | RTCIceCandidateInit;
  iceServers?: RTCIceServer[];
  message?: string;
}

export class SignalClient extends EventTarget {
  private socket?: WebSocket;

  async connect(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error("连接服务器超时"));
      }, 8_000);

      socket.addEventListener(
        "open",
        () => {
          window.clearTimeout(timeout);
          this.socket = socket;
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          window.clearTimeout(timeout);
          reject(new Error("无法连接信令服务器"));
        },
        { once: true },
      );
      socket.addEventListener("message", (event) => {
        try {
          const detail = JSON.parse(String(event.data)) as SignalEnvelope;
          this.dispatchEvent(new CustomEvent<SignalEnvelope>("message", { detail }));
        } catch {
          this.dispatchEvent(
            new CustomEvent<SignalEnvelope>("message", {
              detail: { type: "error", message: "服务器返回了无法识别的数据" },
            }),
          );
        }
      });
      socket.addEventListener("close", () => {
        this.dispatchEvent(new Event("close"));
      });
    });
  }

  send(message: SignalEnvelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("信令服务器尚未连接");
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}

export function createPeerConnection(
  iceServers: RTCIceServer[],
  onIceCandidate: (candidate: RTCIceCandidateInit) => void,
): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 4,
  });

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      onIceCandidate(event.candidate.toJSON());
    }
  });
  return pc;
}

export function preferVideoCodecs(pc: RTCPeerConnection, order: string[]): void {
  if (!("getCapabilities" in RTCRtpSender.prototype)) {
    return;
  }
  const capabilities = RTCRtpSender.getCapabilities("video");
  if (!capabilities) {
    return;
  }
  const ranked = [...capabilities.codecs].sort((a, b) => {
    const aRank = order.indexOf(a.mimeType);
    const bRank = order.indexOf(b.mimeType);
    return (aRank === -1 ? 999 : aRank) - (bRank === -1 ? 999 : bRank);
  });
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.sender.track?.kind === "video" && transceiver.setCodecPreferences) {
      transceiver.setCodecPreferences(ranked);
    }
  }
}

export async function tuneSenders(
  pc: RTCPeerConnection,
  preset: QualityPreset,
): Promise<void> {
  await Promise.all(
    pc.getSenders().map(async (sender) => {
      if (!sender.track) {
        return;
      }
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) {
        parameters.encodings = [{}];
      }
      const encoding = parameters.encodings[0] as RTCRtpEncodingParameters & {
        priority?: RTCPriorityType;
        networkPriority?: RTCPriorityType;
      };
      if (sender.track.kind === "video") {
        (
          parameters as RTCRtpSendParameters & {
            degradationPreference?: RTCDegradationPreference;
          }
        ).degradationPreference = "maintain-resolution";
        encoding.maxBitrate = preset.maxBitrate;
        encoding.maxFramerate = preset.frameRate;
        encoding.scaleResolutionDownBy = 1;
        encoding.priority = "high";
        encoding.networkPriority = "high";
      } else {
        encoding.maxBitrate = preset.audioBitrate;
        encoding.priority = "high";
      }
      try {
        await sender.setParameters(parameters);
      } catch (error) {
        console.warn("浏览器未接受全部发送参数，将使用兼容设置", error);
      }
    }),
  );
}

export function tuneOpus(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  if (!description.sdp) {
    return description;
  }
  const lines = description.sdp.split(/\r?\n/);
  const opusLine = lines.find((line) => /^a=rtpmap:\d+ opus\/48000\/2$/i.test(line));
  const payload = opusLine?.match(/^a=rtpmap:(\d+)/)?.[1];
  if (!payload) {
    return description;
  }
  const fmtpPrefix = `a=fmtp:${payload}`;
  const fmtpIndex = lines.findIndex((line) => line.startsWith(fmtpPrefix));
  const settings =
    "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000;usedtx=0";
  if (fmtpIndex >= 0) {
    const existing = lines[fmtpIndex].split(" ", 2)[1] || "";
    const keys = new Set(existing.split(";").map((part) => part.split("=")[0]));
    const additions = settings
      .split(";")
      .filter((part) => !keys.has(part.split("=")[0]))
      .join(";");
    lines[fmtpIndex] = additions
      ? `${lines[fmtpIndex]};${additions}`
      : lines[fmtpIndex];
  } else {
    lines.splice(lines.indexOf(opusLine) + 1, 0, `${fmtpPrefix} ${settings}`);
  }
  return { ...description, sdp: lines.join("\r\n") };
}

export interface OutboundSnapshot {
  bytes: number;
  timestamp: number;
}

export interface OutboundStats {
  bitrate: number;
  width?: number;
  height?: number;
  framesPerSecond?: number;
  codec?: string;
  snapshot?: OutboundSnapshot;
}

export async function readOutboundVideoStats(
  pc: RTCPeerConnection,
  previous?: OutboundSnapshot,
): Promise<OutboundStats> {
  const report = await pc.getStats();
  let result: OutboundStats = { bitrate: 0 };
  report.forEach((item) => {
    if (item.type !== "outbound-rtp" || item.kind !== "video" || item.isRemote) {
      return;
    }
    const snapshot = {
      bytes: Number(item.bytesSent || 0),
      timestamp: Number(item.timestamp || performance.now()),
    };
    let bitrate = 0;
    if (previous && snapshot.timestamp > previous.timestamp) {
      bitrate =
        ((snapshot.bytes - previous.bytes) * 8 * 1000) /
        (snapshot.timestamp - previous.timestamp);
    }
    const codecReport = item.codecId ? report.get(item.codecId) : undefined;
    result = {
      bitrate,
      width: item.frameWidth,
      height: item.frameHeight,
      framesPerSecond: item.framesPerSecond,
      codec: codecReport?.mimeType?.replace("video/", ""),
      snapshot,
    };
  });
  return result;
}
