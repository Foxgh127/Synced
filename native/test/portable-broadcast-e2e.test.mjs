import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  DEFAULT_MAX_VIDEO_BITRATE_BPS,
  SAFE_MAX_VIDEO_BITRATE_BPS,
  buildAndroidDeepLinkArgs,
  buildHealthConfig,
  findUiNode,
  mobileNetworkDetected,
  receiverHealthIssues,
  receiverObservationExpression,
  senderHealthIssues,
  senderObservationExpression,
  summarizeReceiverObservation,
  summarizeSenderObservation,
} = require("../scripts/portable-broadcast-e2e-utils.cjs");

function healthyObservation() {
  return {
    samples: [0, 1, 2, 3].map((index) => ({
      at: index * 1_000,
      video: {
        bytesReceived: index * 900_000,
        packetsReceived: index * 300,
        packetsLost: index === 3 ? 2 : 0,
        framesDecoded: index * 30,
        freezeCount: 0,
        totalFreezesDuration: 0,
        jitterBufferDelay: index * 0.12,
        jitterBufferEmittedCount: index * 30 || 1,
        estimatedPlayoutTimestamp: 10_000 + index * 1_000,
      },
      audio: {
        bytesReceived: index * 32_000,
        packetsReceived: index * 50,
        packetsLost: 0,
        totalAudioEnergy: index * 0.4,
        jitterBufferDelay: index * 0.06,
        jitterBufferEmittedCount: index * 50 || 1,
        estimatedPlayoutTimestamp: 9_980 + index * 1_000,
      },
      route: {
        state: "succeeded",
        selected: true,
        currentRoundTripTime: 0.08,
        localCandidateType: "relay",
        remoteCandidateType: "relay",
        localProtocol: "udp",
      },
      frame: {
        averageLuma: 72,
        brightRatio: 0.7,
        darkRatio: 0.1,
        nearBlack: false,
      },
    })),
    mediaElement: {
      paused: false,
      muted: false,
      readyState: 4,
      videoWidth: 1920,
      videoHeight: 1080,
    },
    tracks: { video: 1, audio: 1 },
    errors: [],
  };
}

test("portable E2E bitrate ceiling is configurable but never exceeds 100 Mbps", () => {
  const defaults = buildHealthConfig({});
  assert.equal(
    defaults.maxVideoBitrateBps,
    DEFAULT_MAX_VIDEO_BITRATE_BPS,
  );
  assert.equal(defaults.maxAvSkewMs, 3_000);

  const configured = buildHealthConfig({
    YIQIKAN_E2E_MAX_VIDEO_BITRATE_MBPS: "24",
    YIQIKAN_E2E_MIN_VIDEO_BITRATE_BPS: "3000000",
  });
  assert.equal(configured.maxVideoBitrateBps, 24_000_000);
  assert.equal(configured.minVideoBitrateBps, 3_000_000);

  assert.throws(
    () =>
      buildHealthConfig({
        YIQIKAN_E2E_MAX_VIDEO_BITRATE_BPS: String(
          SAFE_MAX_VIDEO_BITRATE_BPS + 1,
        ),
      }),
    /100000000/,
  );
  assert.throws(
    () =>
      buildHealthConfig({
        YIQIKAN_E2E_MAX_VIDEO_BITRATE_MBPS: "20",
        YIQIKAN_E2E_MIN_VIDEO_BITRATE_MBPS: "24",
      }),
    /不能大于/,
  );
});

test("Android deep link protects its query string from the remote adb shell", () => {
  const invite =
    "synced://join?room=23456789&signal=wss%3A%2F%2Fsynced.com.cn%2Fsignal";
  const args = buildAndroidDeepLinkArgs(invite);
  assert.equal(args.at(-2), `'${invite}'`);
  assert.equal(args.at(-1), "com.yiqikan.room");
});

test("receiver health summary covers video, audible audio, loss, A/V skew and ICE", () => {
  const config = buildHealthConfig({});
  const summary = summarizeReceiverObservation(healthyObservation());
  assert.equal(summary.videoFramesDelta, 90);
  assert.equal(summary.decodedFps, 30);
  assert.equal(summary.audioEnergyDelta, 1.2000000000000002);
  assert.equal(summary.nearBlackRatio, 0);
  assert.equal(summary.maxAvSkewMs, 20);
  assert.equal(summary.maxRttMs, 80);
  assert.equal(summary.selectedIceRoute.localCandidateType, "relay");
  assert.deepEqual(receiverHealthIssues(summary, config), []);
});

test("receiver health accepts muted Android video when dedicated movie audio is live", () => {
  const observation = healthyObservation();
  observation.mediaElement = {
    ...observation.mediaElement,
    muted: true,
  };
  observation.videoElement = {
    ...observation.mediaElement,
    exists: true,
    trackCount: 1,
    liveTrackCount: 1,
    trackState: "live",
    trackMuted: false,
  };
  observation.dedicatedAudioElement = {
    exists: true,
    hasSrcObject: true,
    paused: false,
    muted: false,
    volume: 1,
    readyState: 4,
    trackCount: 1,
    liveTrackCount: 1,
    trackState: "live",
    trackMuted: false,
  };
  observation.audioPlayback = {
    ...observation.dedicatedAudioElement,
    path: "dedicated",
  };
  observation.tracks = {
    video: 1,
    audio: 1,
    videoAudio: 1,
    dedicatedAudio: 1,
    videoState: "live",
    audioState: "live",
    audioMuted: false,
  };

  const summary = summarizeReceiverObservation(observation);
  assert.equal(summary.videoElement.muted, true);
  assert.equal(summary.audioElement.hasSrcObject, true);
  assert.equal(summary.audioPlayback.path, "dedicated");
  assert.deepEqual(
    receiverHealthIssues(summary, buildHealthConfig({})),
    [],
  );
});

test("receiver health validates dedicated audio element playout and live srcObject track", () => {
  const observation = healthyObservation();
  observation.mediaElement = {
    ...observation.mediaElement,
    muted: true,
  };
  observation.videoElement = {
    ...observation.mediaElement,
    exists: true,
    trackCount: 1,
    liveTrackCount: 1,
    trackState: "live",
  };
  observation.dedicatedAudioElement = {
    exists: true,
    hasSrcObject: false,
    paused: true,
    muted: true,
    volume: 0,
    readyState: 0,
    trackCount: 0,
    liveTrackCount: 0,
    trackState: "ended",
    trackMuted: true,
  };
  observation.audioPlayback = {
    ...observation.dedicatedAudioElement,
    path: "dedicated",
  };

  const issues = receiverHealthIssues(
    summarizeReceiverObservation(observation),
    buildHealthConfig({}),
  );
  assert.ok(issues.some((issue) => issue.includes("声音处于暂停")));
  assert.ok(issues.some((issue) => issue.includes("声音被静音")));
  assert.ok(issues.some((issue) => issue.includes("音量为零")));
  assert.ok(issues.some((issue) => issue.includes("声音尚无可播放")));
  assert.ok(issues.some((issue) => issue.includes("声音播放轨数量")));
  assert.ok(issues.some((issue) => issue.includes("媒体流")));
  assert.equal(
    issues.some((issue) => issue.includes("观看端视频被静音")),
    false,
  );
});

test("receiver health keeps legacy video-element audio fallback compatible", () => {
  const observation = healthyObservation();
  assert.equal(
    summarizeReceiverObservation(observation).audioPlayback.path,
    "video",
  );
  assert.deepEqual(
    receiverHealthIssues(
      summarizeReceiverObservation(observation),
      buildHealthConfig({}),
    ),
    [],
  );

  observation.mediaElement.muted = true;
  const issues = receiverHealthIssues(
    summarizeReceiverObservation(observation),
    buildHealthConfig({}),
  );
  assert.ok(issues.some((issue) => issue.includes("声音被静音")));
});

test("receiver health rejects black, stalled, silent and unselected media", () => {
  const observation = healthyObservation();
  for (const sample of observation.samples) {
    sample.video.bytesReceived = 0;
    sample.video.framesDecoded = 0;
    sample.video.packetsLost = 40;
    sample.audio.bytesReceived = 0;
    sample.audio.totalAudioEnergy = 0;
    sample.video.estimatedPlayoutTimestamp = 15_000;
    sample.audio.estimatedPlayoutTimestamp = 10_000;
    sample.route = undefined;
    sample.frame = {
      averageLuma: 0,
      brightRatio: 0,
      darkRatio: 1,
      nearBlack: true,
    };
  }
  const summary = summarizeReceiverObservation(observation);
  const issues = receiverHealthIssues(summary, buildHealthConfig({}));
  assert.ok(issues.some((issue) => issue.includes("视频 RTP")));
  assert.ok(issues.some((issue) => issue.includes("解码帧")));
  assert.ok(issues.some((issue) => issue.includes("音频 RTP")));
  assert.ok(issues.some((issue) => issue.includes("声音能量")));
  assert.ok(issues.some((issue) => issue.includes("近黑画面")));
  assert.ok(issues.some((issue) => issue.includes("时间戳偏差")));
  assert.ok(issues.some((issue) => issue.includes("ICE")));
});

test("receiver observation expression samples pixels and selected ICE stats", () => {
  const expression = receiverObservationExpression({
    durationMs: 5_000,
    sampleIntervalMs: 500,
  });
  assert.match(expression, /drawImage\(videoElement/);
  assert.match(expression, /estimatedPlayoutTimestamp/);
  assert.match(expression, /selectedCandidatePairId/);
  assert.match(expression, /totalAudioEnergy/);
  assert.match(expression, /#channel-movie-audio/);
  assert.match(expression, /path: 'dedicated'/);
  assert.match(expression, /dedicatedAudioElement/);
  assert.match(expression, /liveTrackCount/);
});

test("mobile network diagnostics recognize Android cellular transports", () => {
  assert.equal(
    mobileNetworkDetected(
      "NetworkCapabilities: TRANSPORT_CELLULAR&NET_CAPABILITY_VALIDATED",
    ),
    true,
  );
  assert.equal(
    mobileNetworkDetected("type: WIFI state: CONNECTED TRANSPORT_WIFI"),
    false,
  );
});

test("secure release fallback summarizes host RTP and Android loss reports", () => {
  const observation = {
    samples: [0, 1, 2, 3].map((index) => ({
      at: index * 1_000,
      connectionState: "connected",
      iceConnectionState: "connected",
      video: {
        bytesSent: index * 800_000,
        framesEncoded: index * 30,
      },
      audio: {
        bytesSent: index * 32_000,
        totalAudioEnergy: index * 0.5,
      },
      remoteVideo: { fractionLost: 0.01, roundTripTime: 0.09 },
      remoteAudio: { fractionLost: 0, roundTripTime: 0.08 },
      route: {
        state: "succeeded",
        selected: true,
        currentRoundTripTime: 0.085,
        localCandidateType: "host",
        remoteCandidateType: "relay",
      },
    })),
    errors: [],
  };
  const summary = summarizeSenderObservation(observation);
  assert.equal(summary.videoFramesDelta, 90);
  assert.equal(summary.encodedFps, 30);
  assert.equal(summary.maxPacketLossRatio, 0.01);
  assert.equal(summary.maxRttMs, 90);
  assert.deepEqual(
    senderHealthIssues(summary, buildHealthConfig({})),
    [],
  );
  const expression = senderObservationExpression({
    durationMs: 4_000,
    sampleIntervalMs: 500,
  });
  assert.match(expression, /remote-inbound-rtp/);
  assert.match(expression, /totalAudioEnergy/);
});

test("uiautomator bounds locate release fullscreen controls without WebView CDP", () => {
  const xml =
    '<hierarchy rotation="0"><node text="全屏" resource-id="dock-fullscreen" class="android.widget.Button" bounds="[900,2100][1100,2300]"></node></hierarchy>';
  assert.deepEqual(findUiNode(xml, "dock-fullscreen"), {
    left: 900,
    top: 2100,
    right: 1100,
    bottom: 2300,
    width: 200,
    height: 200,
    centerX: 1000,
    centerY: 2200,
    text: "全屏",
  });
  assert.equal(findUiNode(xml, "missing"), undefined);
});
