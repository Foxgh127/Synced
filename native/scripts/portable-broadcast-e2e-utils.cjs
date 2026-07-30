const SAFE_MAX_VIDEO_BITRATE_BPS = 100_000_000;
const DEFAULT_MAX_VIDEO_BITRATE_BPS = 32_000_000;

function finiteNumber(name, rawValue, fallback, minimum, maximum) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return fallback;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} 必须是 ${minimum}–${maximum} 之间的有限数字，当前为 ${rawValue}`,
    );
  }
  return value;
}

function bitrateFromEnvironment(environment, prefix, fallback) {
  const bitsValue = environment[`${prefix}_BPS`];
  const megabitsValue = environment[`${prefix}_MBPS`];
  if (
    bitsValue !== undefined &&
    bitsValue !== "" &&
    megabitsValue !== undefined &&
    megabitsValue !== ""
  ) {
    throw new Error(`${prefix}_BPS 与 ${prefix}_MBPS 不能同时设置`);
  }
  if (megabitsValue !== undefined && megabitsValue !== "") {
    return Math.round(
      finiteNumber(
        `${prefix}_MBPS`,
        megabitsValue,
        fallback / 1_000_000,
        0.3,
        SAFE_MAX_VIDEO_BITRATE_BPS / 1_000_000,
      ) * 1_000_000,
    );
  }
  return Math.round(
    finiteNumber(
      `${prefix}_BPS`,
      bitsValue,
      fallback,
      300_000,
      SAFE_MAX_VIDEO_BITRATE_BPS,
    ),
  );
}

function buildHealthConfig(environment = process.env) {
  const maxVideoBitrateBps = bitrateFromEnvironment(
    environment,
    "SYNCED_E2E_MAX_VIDEO_BITRATE",
    DEFAULT_MAX_VIDEO_BITRATE_BPS,
  );
  const minVideoBitrateBps = bitrateFromEnvironment(
    environment,
    "SYNCED_E2E_MIN_VIDEO_BITRATE",
    1_500_000,
  );
  if (minVideoBitrateBps > maxVideoBitrateBps) {
    throw new Error(
      "SYNCED_E2E_MIN_VIDEO_BITRATE 不能大于 SYNCED_E2E_MAX_VIDEO_BITRATE",
    );
  }
  return {
    maxVideoBitrateBps,
    minVideoBitrateBps,
    observationMs: Math.round(
      finiteNumber(
        "SYNCED_E2E_OBSERVATION_MS",
        environment.SYNCED_E2E_OBSERVATION_MS,
        12_000,
        4_000,
        60_000,
      ),
    ),
    reconnectObservationMs: Math.round(
      finiteNumber(
        "SYNCED_E2E_RECONNECT_OBSERVATION_MS",
        environment.SYNCED_E2E_RECONNECT_OBSERVATION_MS,
        8_000,
        4_000,
        60_000,
      ),
    ),
    sampleIntervalMs: Math.round(
      finiteNumber(
        "SYNCED_E2E_SAMPLE_INTERVAL_MS",
        environment.SYNCED_E2E_SAMPLE_INTERVAL_MS,
        1_000,
        250,
        5_000,
      ),
    ),
    maxAvSkewMs: finiteNumber(
      "SYNCED_E2E_MAX_AV_SKEW_MS",
      environment.SYNCED_E2E_MAX_AV_SKEW_MS,
      3_000,
      100,
      10_000,
    ),
    maxRttMs: finiteNumber(
      "SYNCED_E2E_MAX_RTT_MS",
      environment.SYNCED_E2E_MAX_RTT_MS,
      3_000,
      50,
      10_000,
    ),
    maxPacketLossRatio:
      finiteNumber(
        "SYNCED_E2E_MAX_PACKET_LOSS_PERCENT",
        environment.SYNCED_E2E_MAX_PACKET_LOSS_PERCENT,
        8,
        0,
        50,
      ) / 100,
    maxBlackRatio:
      finiteNumber(
        "SYNCED_E2E_MAX_BLACK_PERCENT",
        environment.SYNCED_E2E_MAX_BLACK_PERCENT,
        60,
        0,
        100,
      ) / 100,
    maxFrameStallMs: finiteNumber(
      "SYNCED_E2E_MAX_FRAME_STALL_MS",
      environment.SYNCED_E2E_MAX_FRAME_STALL_MS,
      3_000,
      500,
      15_000,
    ),
    maxFreezeRatio:
      finiteNumber(
        "SYNCED_E2E_MAX_FREEZE_PERCENT",
        environment.SYNCED_E2E_MAX_FREEZE_PERCENT,
        25,
        0,
        100,
      ) / 100,
    minDecodedFps: finiteNumber(
      "SYNCED_E2E_MIN_DECODED_FPS",
      environment.SYNCED_E2E_MIN_DECODED_FPS,
      5,
      0.1,
      120,
    ),
    requireAudibleAudio: environment.SYNCED_E2E_REQUIRE_AUDIO !== "0",
    hardTimeoutMs: Math.round(
      finiteNumber(
        "SYNCED_E2E_HARD_TIMEOUT_MS",
        environment.SYNCED_E2E_HARD_TIMEOUT_MS,
        240_000,
        60_000,
        900_000,
      ),
    ),
  };
}

function buildAndroidDeepLinkArgs(invite, packageName = "com.synced.room") {
  if (typeof invite !== "string" || !invite.trim()) {
    throw new Error("Android 深链不能为空");
  }
  if (typeof packageName !== "string" || !packageName.trim()) {
    throw new Error("Android 包名不能为空");
  }
  // `adb shell` joins argv into one remote shell command. Protect query-string
  // ampersands from that shell; these quotes are consumed remotely and are not
  // delivered as part of the URI to Activity Manager.
  const shellQuotedInvite = `'${invite.replaceAll("'", `'\\''`)}'`;
  return [
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-c",
    "android.intent.category.BROWSABLE",
    "-d",
    shellQuotedInvite,
    packageName,
  ];
}

function mobileNetworkDetected(diagnostic = "") {
  return [
    /\bTRANSPORT_CELLULAR\b/i,
    /\btype:\s*MOBILE\b/i,
    /\bMOBILE\b[^\r\n]*\bCONNECTED\b/i,
    /\bCELLULAR\b[^\r\n]*\bVALIDATED\b/i,
  ].some((pattern) => pattern.test(String(diagnostic)));
}

function delta(first, last, key) {
  const start = Number(first?.[key]);
  const end = Number(last?.[key]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return undefined;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function maximum(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? Math.max(...finite) : undefined;
}

function packetLoss(first, last) {
  const received = delta(first, last, "packetsReceived");
  const lost = delta(first, last, "packetsLost");
  if (received === undefined || lost === undefined) return undefined;
  const total = received + lost;
  return total > 0 ? lost / total : 0;
}

function longestFrameStall(samples) {
  let lastProgressAt = Number(samples[0]?.at || 0);
  let previousFrames = Number(samples[0]?.video?.framesDecoded || 0);
  let longest = 0;
  for (const sample of samples.slice(1)) {
    const at = Number(sample.at || lastProgressAt);
    const frames = Number(sample.video?.framesDecoded || 0);
    if (frames > previousFrames) {
      longest = Math.max(longest, at - lastProgressAt);
      lastProgressAt = at;
      previousFrames = frames;
    }
  }
  const finalAt = Number(samples.at(-1)?.at || lastProgressAt);
  return Math.max(longest, finalAt - lastProgressAt);
}

function summarizeReceiverObservation(observation = {}) {
  const samples = Array.isArray(observation.samples)
    ? observation.samples.filter((sample) => sample && typeof sample === "object")
    : [];
  const first = samples[0];
  const last = samples.at(-1);
  const durationMs =
    samples.length > 1
      ? Math.max(1, Number(last.at || 0) - Number(first.at || 0))
      : 0;
  const videoFramesDelta = delta(first?.video, last?.video, "framesDecoded");
  const videoBytesDelta = delta(first?.video, last?.video, "bytesReceived");
  const audioBytesDelta = delta(first?.audio, last?.audio, "bytesReceived");
  const audioEnergyDelta = delta(
    first?.audio,
    last?.audio,
    "totalAudioEnergy",
  );
  const freezeDurationDelta = delta(
    first?.video,
    last?.video,
    "totalFreezesDuration",
  );
  const validFrames = samples
    .map((sample) => sample.frame)
    .filter(
      (frame) =>
        frame &&
        !frame.error &&
        Number.isFinite(Number(frame.averageLuma)),
    );
  const blackFrames = validFrames.filter((frame) => frame.nearBlack);
  const avSkewSamples = samples
    .map((sample) => {
      const videoTimestamp = Number(sample.video?.estimatedPlayoutTimestamp);
      const audioTimestamp = Number(sample.audio?.estimatedPlayoutTimestamp);
      return Number.isFinite(videoTimestamp) && Number.isFinite(audioTimestamp)
        ? Math.abs(videoTimestamp - audioTimestamp)
        : undefined;
    })
    .filter((value) => value !== undefined);
  const videoJitterBufferMs = samples
    .map((sample) => {
      const delay = Number(sample.video?.jitterBufferDelay);
      const count = Number(sample.video?.jitterBufferEmittedCount);
      return Number.isFinite(delay) && Number.isFinite(count) && count > 0
        ? (delay / count) * 1_000
        : undefined;
    })
    .filter((value) => value !== undefined);
  const audioJitterBufferMs = samples
    .map((sample) => {
      const delay = Number(sample.audio?.jitterBufferDelay);
      const count = Number(sample.audio?.jitterBufferEmittedCount);
      return Number.isFinite(delay) && Number.isFinite(count) && count > 0
        ? (delay / count) * 1_000
        : undefined;
    })
    .filter((value) => value !== undefined);
  const rttMsSamples = samples
    .map((sample) => {
      const rtt = Number(sample.route?.currentRoundTripTime);
      return Number.isFinite(rtt) ? rtt * 1_000 : undefined;
    })
    .filter((value) => value !== undefined);
  const videoLossRatio = packetLoss(first?.video, last?.video);
  const audioLossRatio = packetLoss(first?.audio, last?.audio);
  const freezeRatio =
    freezeDurationDelta !== undefined && durationMs > 0
      ? (freezeDurationDelta * 1_000) / durationMs
      : undefined;
  const mediaElement = observation.mediaElement;
  const videoElement = observation.videoElement || mediaElement;
  const audioElement =
    observation.audioElement || observation.dedicatedAudioElement;
  const audioPlayback =
    observation.audioPlayback ||
    (mediaElement
      ? {
          path: "video",
          exists: true,
          hasSrcObject: Boolean(Number(observation.tracks?.audio || 0)),
          paused: mediaElement.paused,
          muted: mediaElement.muted,
          volume: mediaElement.volume,
          readyState: mediaElement.readyState,
          trackCount: Number(observation.tracks?.audio || 0),
          liveTrackCount: Number(observation.tracks?.audio || 0),
          trackState: observation.tracks?.audioState,
          trackMuted: observation.tracks?.audioMuted,
        }
      : undefined);
  return {
    sampleCount: samples.length,
    durationMs,
    videoFramesDelta,
    decodedFps:
      videoFramesDelta !== undefined && durationMs > 0
        ? videoFramesDelta / (durationMs / 1_000)
        : undefined,
    videoBytesDelta,
    audioBytesDelta,
    audioEnergyDelta,
    audioEnergySupported:
      Number.isFinite(Number(first?.audio?.totalAudioEnergy)) &&
      Number.isFinite(Number(last?.audio?.totalAudioEnergy)),
    videoLossRatio,
    audioLossRatio,
    maxPacketLossRatio: maximum([videoLossRatio, audioLossRatio]),
    freezeCountDelta: delta(first?.video, last?.video, "freezeCount"),
    freezeDurationDelta,
    freezeRatio,
    maxFrameStallMs: samples.length > 1 ? longestFrameStall(samples) : undefined,
    validFrameSamples: validFrames.length,
    healthyFrameSamples: validFrames.length - blackFrames.length,
    nearBlackSamples: blackFrames.length,
    nearBlackRatio: validFrames.length
      ? blackFrames.length / validFrames.length
      : undefined,
    averageLuma: average(
      validFrames.map((frame) => Number(frame.averageLuma)),
    ),
    maxAvSkewMs: maximum(avSkewSamples),
    averageAvSkewMs: average(avSkewSamples),
    maxRttMs: maximum(rttMsSamples),
    averageRttMs: average(rttMsSamples),
    averageVideoJitterBufferMs: average(videoJitterBufferMs),
    averageAudioJitterBufferMs: average(audioJitterBufferMs),
    selectedIceRoute: [...samples]
      .reverse()
      .find((sample) => sample.route)?.route,
    finalVideo: last?.video,
    finalAudio: last?.audio,
    // Keep mediaElement for reports produced by older clients. New reports
    // separate video rendering from Android's dedicated movie-audio playout.
    mediaElement,
    videoElement,
    audioElement,
    dedicatedAudioElement: audioElement,
    audioPlayback,
    tracks: observation.tracks,
    errors: Array.isArray(observation.errors) ? observation.errors : [],
  };
}

function receiverHealthIssues(summary, config) {
  const issues = [];
  if (summary.sampleCount < 3) {
    issues.push(`有效统计样本不足：${summary.sampleCount}`);
  }
  if (!Number.isFinite(summary.videoBytesDelta) || summary.videoBytesDelta <= 0) {
    issues.push("视频 RTP 字节未增长");
  }
  if (
    !Number.isFinite(summary.videoFramesDelta) ||
    summary.videoFramesDelta <= 0
  ) {
    issues.push("视频解码帧未增长");
  }
  if (
    Number.isFinite(summary.decodedFps) &&
    summary.decodedFps < config.minDecodedFps
  ) {
    issues.push(
      `解码帧率过低：${summary.decodedFps.toFixed(1)} < ${config.minDecodedFps}`,
    );
  }
  if (
    !Number.isFinite(summary.audioBytesDelta) ||
    summary.audioBytesDelta <= 0
  ) {
    issues.push("音频 RTP 字节未增长");
  }
  if (
    config.requireAudibleAudio &&
    summary.audioEnergySupported &&
    (!Number.isFinite(summary.audioEnergyDelta) ||
      summary.audioEnergyDelta <= 0)
  ) {
    issues.push("音频轨存在但没有可检测的声音能量");
  }
  if (summary.validFrameSamples < 3) {
    issues.push(`可分析画面样本不足：${summary.validFrameSamples}`);
  }
  if (
    Number.isFinite(summary.nearBlackRatio) &&
    summary.nearBlackRatio > config.maxBlackRatio
  ) {
    issues.push(
      `近黑画面比例过高：${(summary.nearBlackRatio * 100).toFixed(1)}%`,
    );
  }
  if (
    Number.isFinite(summary.maxFrameStallMs) &&
    summary.maxFrameStallMs > config.maxFrameStallMs
  ) {
    issues.push(`最长无新解码帧 ${Math.round(summary.maxFrameStallMs)} ms`);
  }
  if (
    Number.isFinite(summary.freezeRatio) &&
    summary.freezeRatio > config.maxFreezeRatio
  ) {
    issues.push(
      `冻结时长比例过高：${(summary.freezeRatio * 100).toFixed(1)}%`,
    );
  }
  if (
    Number.isFinite(summary.maxPacketLossRatio) &&
    summary.maxPacketLossRatio > config.maxPacketLossRatio
  ) {
    issues.push(
      `RTP 丢包率过高：${(summary.maxPacketLossRatio * 100).toFixed(2)}%`,
    );
  }
  if (
    Number.isFinite(summary.maxAvSkewMs) &&
    summary.maxAvSkewMs > config.maxAvSkewMs
  ) {
    issues.push(`音画时间戳偏差 ${Math.round(summary.maxAvSkewMs)} ms`);
  }
  if (
    Number.isFinite(summary.maxRttMs) &&
    summary.maxRttMs > config.maxRttMs
  ) {
    issues.push(`ICE 往返延迟 ${Math.round(summary.maxRttMs)} ms`);
  }
  if (
    !summary.selectedIceRoute ||
    (
      summary.selectedIceRoute.state !== "succeeded" &&
      !summary.selectedIceRoute.selected &&
      !summary.selectedIceRoute.nominated
    )
  ) {
    issues.push("未找到成功的 ICE 候选对");
  }
  const videoElement = summary.videoElement || summary.mediaElement;
  const audioPlayback = summary.audioPlayback;
  if (videoElement?.paused) issues.push("观看端视频处于暂停状态");
  if (Number(videoElement?.readyState || 0) < 2) {
    issues.push("观看端视频尚无可播放数据");
  }
  if (Number(videoElement?.videoWidth || 0) < 1) {
    issues.push("观看端视频尺寸为空");
  }
  if (!audioPlayback) {
    issues.push("观看端缺少声音播放路径");
  } else {
    if (audioPlayback.paused) issues.push("观看端声音处于暂停状态");
    if (audioPlayback.muted) issues.push("观看端声音被静音");
    if (
      Number.isFinite(Number(audioPlayback.volume)) &&
      Number(audioPlayback.volume) <= 0
    ) {
      issues.push("观看端声音音量为零");
    }
    const minimumAudioReadyState =
      audioPlayback.path === "dedicated" ? 1 : 2;
    if (
      Number(audioPlayback.readyState || 0) < minimumAudioReadyState
    ) {
      issues.push("观看端声音尚无可播放数据");
    }
    if (Number(audioPlayback.liveTrackCount || 0) !== 1) {
      issues.push(
        `声音播放轨数量异常：${audioPlayback.liveTrackCount || 0}`,
      );
    }
    if (
      audioPlayback.trackState &&
      audioPlayback.trackState !== "live"
    ) {
      issues.push(`声音播放轨状态异常：${audioPlayback.trackState}`);
    }
    if (audioPlayback.trackMuted) {
      issues.push("声音播放轨处于 muted 状态");
    }
    if (
      audioPlayback.path === "dedicated" &&
      (!audioPlayback.exists || !audioPlayback.hasSrcObject)
    ) {
      issues.push("Android 专用声音元素未绑定媒体流");
    }
  }
  if (Number(summary.tracks?.video || 0) !== 1) {
    issues.push(`视频轨数量异常：${summary.tracks?.video || 0}`);
  }
  if (Number(summary.tracks?.audio || 0) !== 1) {
    issues.push(`音频轨数量异常：${summary.tracks?.audio || 0}`);
  }
  if (summary.errors.length) {
    issues.push(`采样发生 ${summary.errors.length} 个错误`);
  }
  return issues;
}

function receiverObservationExpression({
  durationMs,
  sampleIntervalMs,
}) {
  return `(async () => {
    const durationMs = ${JSON.stringify(durationMs)};
    const sampleIntervalMs = ${JSON.stringify(sampleIntervalMs)};
    const videoElement = document.querySelector('#channel-video');
    const dedicatedAudioElement =
      document.querySelector('#channel-movie-audio');
    const stream = videoElement?.srcObject;
    const dedicatedAudioStream = dedicatedAudioElement?.srcObject;
    const mediaSnapshot = (element, mediaStream, kind) => {
      const tracks = kind === 'video'
        ? mediaStream?.getVideoTracks?.() || []
        : mediaStream?.getAudioTracks?.() || [];
      const liveTracks = tracks.filter((track) => track.readyState === 'live');
      return {
        exists: Boolean(element),
        hasSrcObject: Boolean(mediaStream),
        paused: element?.paused,
        muted: element?.muted,
        volume: Number.isFinite(Number(element?.volume))
          ? Number(element.volume)
          : undefined,
        readyState: Number.isFinite(Number(element?.readyState))
          ? Number(element.readyState)
          : undefined,
        videoWidth: kind === 'video' ? element?.videoWidth : undefined,
        videoHeight: kind === 'video' ? element?.videoHeight : undefined,
        trackCount: tracks.length,
        liveTrackCount: liveTracks.length,
        trackState: tracks[0]?.readyState,
        trackMuted: tracks[0]?.muted
      };
    };
    const currentPlaybackState = () => {
      const dedicated = mediaSnapshot(
        dedicatedAudioElement,
        dedicatedAudioElement?.srcObject,
        'audio'
      );
      if (dedicated.liveTrackCount > 0) {
        return { ...dedicated, path: 'dedicated' };
      }
      return {
        ...mediaSnapshot(videoElement, videoElement?.srcObject, 'audio'),
        path: 'video'
      };
    };
    const entries = [
      ...(window.__syncedRtcPeers || []),
      ...(window.__syncedE2eRtcPeers || [])
    ];
    const seen = new Set();
    const peers = entries
      .map((entry) => entry?.pc || entry)
      .filter((pc) => {
        if (!pc || seen.has(pc)) return false;
        seen.add(pc);
        return typeof pc.getStats === 'function';
      });
    const pc = [...peers].reverse().find((candidate) =>
      candidate.getReceivers?.().some((receiver) =>
        receiver.track?.kind === 'video' && receiver.track.readyState !== 'ended'
      )
    );
    if (!videoElement || !stream || !pc) {
      const videoState = mediaSnapshot(videoElement, stream, 'video');
      const dedicatedAudioState = mediaSnapshot(
        dedicatedAudioElement,
        dedicatedAudioStream,
        'audio'
      );
      const audioPlayback = currentPlaybackState();
      return {
        samples: [],
        errors: ['缺少视频元素、媒体流或接收端 PeerConnection'],
        mediaElement: videoState,
        videoElement: videoState,
        audioElement: dedicatedAudioState,
        dedicatedAudioElement: dedicatedAudioState,
        audioPlayback,
        tracks: {
          video: stream?.getVideoTracks?.().length || 0,
          audio: audioPlayback.liveTrackCount || 0,
          videoAudio: stream?.getAudioTracks?.().length || 0,
          dedicatedAudio:
            dedicatedAudioStream?.getAudioTracks?.().length || 0
        }
      };
    }
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    const context = canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true
    });
    const finite = (value) =>
      Number.isFinite(Number(value)) ? Number(value) : undefined;
    const compactRtp = (item) => item ? ({
      bytesReceived: finite(item.bytesReceived),
      packetsReceived: finite(item.packetsReceived),
      packetsLost: finite(item.packetsLost),
      framesDecoded: finite(item.framesDecoded),
      framesDropped: finite(item.framesDropped),
      framesPerSecond: finite(item.framesPerSecond),
      freezeCount: finite(item.freezeCount),
      totalFreezesDuration: finite(item.totalFreezesDuration),
      jitter: finite(item.jitter),
      jitterBufferDelay: finite(item.jitterBufferDelay),
      jitterBufferEmittedCount: finite(item.jitterBufferEmittedCount),
      estimatedPlayoutTimestamp: finite(item.estimatedPlayoutTimestamp),
      totalProcessingDelay: finite(item.totalProcessingDelay),
      totalAudioEnergy: finite(item.totalAudioEnergy),
      totalSamplesDuration: finite(item.totalSamplesDuration),
      concealedSamples: finite(item.concealedSamples),
      totalSamplesReceived: finite(item.totalSamplesReceived),
      codecId: item.codecId
    }) : undefined;
    const frameSample = () => {
      if (!context || videoElement.readyState < 2 || !videoElement.videoWidth) {
        return { error: '画面尚不可绘制' };
      }
      try {
        context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height
        ).data;
        let lumaTotal = 0;
        let brightPixels = 0;
        let darkPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const luma =
            pixels[index] * 0.2126 +
            pixels[index + 1] * 0.7152 +
            pixels[index + 2] * 0.0722;
          lumaTotal += luma;
          if (luma > 18) brightPixels += 1;
          if (luma < 10) darkPixels += 1;
        }
        const count = pixels.length / 4;
        const averageLuma = lumaTotal / count;
        const brightRatio = brightPixels / count;
        const darkRatio = darkPixels / count;
        return {
          averageLuma,
          brightRatio,
          darkRatio,
          nearBlack: averageLuma < 8 && brightRatio < 0.015
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error)
        };
      }
    };
    const samples = [];
    const errors = [];
    const startedAt = Date.now();
    while (Date.now() - startedAt <= durationMs) {
      try {
        const report = await Promise.race([
          pc.getStats(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('getStats timeout')), 2500)
          )
        ]);
        const stats = [...report.values()];
        const inboundVideo = stats.find((item) =>
          item.type === 'inbound-rtp' &&
          !item.isRemote &&
          (item.kind || item.mediaType) === 'video'
        );
        const inboundAudio = stats.find((item) =>
          item.type === 'inbound-rtp' &&
          !item.isRemote &&
          (item.kind || item.mediaType) === 'audio'
        );
        const transport = stats.find((item) =>
          item.type === 'transport' && item.selectedCandidatePairId
        );
        const selectedPair = stats.find((item) =>
          item.type === 'candidate-pair' &&
          (
            item.id === transport?.selectedCandidatePairId ||
            (item.state === 'succeeded' && (item.selected || item.nominated))
          )
        );
        const local = stats.find((item) => item.id === selectedPair?.localCandidateId);
        const remote = stats.find((item) => item.id === selectedPair?.remoteCandidateId);
        samples.push({
          at: Date.now(),
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          video: compactRtp(inboundVideo),
          audio: compactRtp(inboundAudio),
          route: selectedPair ? {
            state: selectedPair.state,
            nominated: selectedPair.nominated,
            selected: selectedPair.selected ||
              selectedPair.id === transport?.selectedCandidatePairId,
            currentRoundTripTime: finite(selectedPair.currentRoundTripTime),
            availableIncomingBitrate: finite(selectedPair.availableIncomingBitrate),
            bytesReceived: finite(selectedPair.bytesReceived),
            localCandidateType: local?.candidateType,
            localProtocol: local?.protocol,
            localNetworkType: local?.networkType,
            localAddress: local?.address || local?.ip,
            remoteCandidateType: remote?.candidateType,
            remoteProtocol: remote?.protocol,
            remoteAddress: remote?.address || remote?.ip
          } : undefined,
          frame: frameSample()
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      if (Date.now() - startedAt >= durationMs) break;
      await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
    }
    const videoState = mediaSnapshot(videoElement, stream, 'video');
    const dedicatedAudioState = mediaSnapshot(
      dedicatedAudioElement,
      dedicatedAudioElement?.srcObject,
      'audio'
    );
    const audioPlayback = currentPlaybackState();
    return {
      samples,
      errors,
      mediaElement: videoState,
      videoElement: videoState,
      audioElement: dedicatedAudioState,
      dedicatedAudioElement: dedicatedAudioState,
      audioPlayback,
      tracks: {
        video: stream.getVideoTracks?.().length || 0,
        audio: audioPlayback.liveTrackCount || 0,
        videoAudio: stream.getAudioTracks?.().length || 0,
        dedicatedAudio:
          dedicatedAudioElement?.srcObject?.getAudioTracks?.().length || 0,
        videoState: stream.getVideoTracks?.()[0]?.readyState,
        audioState: audioPlayback.trackState,
        audioMuted: audioPlayback.trackMuted,
        videoAudioState: stream.getAudioTracks?.()[0]?.readyState,
        videoAudioMuted: stream.getAudioTracks?.()[0]?.muted,
        dedicatedAudioState:
          dedicatedAudioElement?.srcObject?.getAudioTracks?.()[0]?.readyState,
        dedicatedAudioMuted:
          dedicatedAudioElement?.srcObject?.getAudioTracks?.()[0]?.muted
      }
    };
  })()`;
}

function senderObservationExpression({
  durationMs,
  sampleIntervalMs,
}) {
  return `(async () => {
    const durationMs = ${JSON.stringify(durationMs)};
    const sampleIntervalMs = ${JSON.stringify(sampleIntervalMs)};
    const entries = [
      ...(window.__syncedRtcPeers || []),
      ...(window.__syncedE2eRtcPeers || [])
    ];
    const seen = new Set();
    const pc = entries
      .map((entry) => entry?.pc || entry)
      .filter((candidate) => {
        if (!candidate || seen.has(candidate)) return false;
        seen.add(candidate);
        return typeof candidate.getStats === 'function';
      })
      .reverse()
      .find((candidate) =>
        candidate.getSenders?.().some((sender) =>
          sender.track?.kind === 'video' && sender.track.readyState !== 'ended'
        )
      );
    if (!pc) return { samples: [], errors: ['缺少发送端 PeerConnection'] };
    const finite = (value) =>
      Number.isFinite(Number(value)) ? Number(value) : undefined;
    const compactOutbound = (item) => item ? ({
      id: item.id,
      bytesSent: finite(item.bytesSent),
      packetsSent: finite(item.packetsSent),
      framesEncoded: finite(item.framesEncoded),
      framesSent: finite(item.framesSent),
      framesPerSecond: finite(item.framesPerSecond),
      totalEncodeTime: finite(item.totalEncodeTime),
      totalPacketSendDelay: finite(item.totalPacketSendDelay),
      totalAudioEnergy: finite(item.totalAudioEnergy),
      totalSamplesDuration: finite(item.totalSamplesDuration),
      qualityLimitationReason: item.qualityLimitationReason,
      remoteId: item.remoteId
    }) : undefined;
    const compactRemote = (item) => item ? ({
      packetsLost: finite(item.packetsLost),
      fractionLost: finite(item.fractionLost),
      jitter: finite(item.jitter),
      roundTripTime: finite(item.roundTripTime),
      totalRoundTripTime: finite(item.totalRoundTripTime),
      roundTripTimeMeasurements: finite(item.roundTripTimeMeasurements)
    }) : undefined;
    const samples = [];
    const errors = [];
    const startedAt = Date.now();
    while (Date.now() - startedAt <= durationMs) {
      try {
        const report = await Promise.race([
          pc.getStats(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('getStats timeout')), 2500)
          )
        ]);
        const stats = [...report.values()];
        const video = stats.find((item) =>
          item.type === 'outbound-rtp' &&
          !item.isRemote &&
          (item.kind || item.mediaType) === 'video'
        );
        const audio = stats.find((item) =>
          item.type === 'outbound-rtp' &&
          !item.isRemote &&
          (item.kind || item.mediaType) === 'audio'
        );
        const remoteVideo = stats.find((item) =>
          item.type === 'remote-inbound-rtp' &&
          (item.localId === video?.id ||
            (item.kind || item.mediaType) === 'video')
        );
        const remoteAudio = stats.find((item) =>
          item.type === 'remote-inbound-rtp' &&
          (item.localId === audio?.id ||
            (item.kind || item.mediaType) === 'audio')
        );
        const transport = stats.find((item) =>
          item.type === 'transport' && item.selectedCandidatePairId
        );
        const selectedPair = stats.find((item) =>
          item.type === 'candidate-pair' &&
          (
            item.id === transport?.selectedCandidatePairId ||
            (item.state === 'succeeded' && (item.selected || item.nominated))
          )
        );
        const local = stats.find((item) => item.id === selectedPair?.localCandidateId);
        const remote = stats.find((item) => item.id === selectedPair?.remoteCandidateId);
        samples.push({
          at: Date.now(),
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          video: compactOutbound(video),
          audio: compactOutbound(audio),
          remoteVideo: compactRemote(remoteVideo),
          remoteAudio: compactRemote(remoteAudio),
          route: selectedPair ? {
            state: selectedPair.state,
            nominated: selectedPair.nominated,
            selected: selectedPair.selected ||
              selectedPair.id === transport?.selectedCandidatePairId,
            currentRoundTripTime: finite(selectedPair.currentRoundTripTime),
            availableOutgoingBitrate: finite(selectedPair.availableOutgoingBitrate),
            localCandidateType: local?.candidateType,
            localProtocol: local?.protocol,
            localNetworkType: local?.networkType,
            remoteCandidateType: remote?.candidateType,
            remoteProtocol: remote?.protocol
          } : undefined
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      if (Date.now() - startedAt >= durationMs) break;
      await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
    }
    return { samples, errors };
  })()`;
}

function summarizeSenderObservation(observation = {}) {
  const samples = Array.isArray(observation.samples)
    ? observation.samples.filter((sample) => sample && typeof sample === "object")
    : [];
  const first = samples[0];
  const last = samples.at(-1);
  const durationMs =
    samples.length > 1
      ? Math.max(1, Number(last.at || 0) - Number(first.at || 0))
      : 0;
  const videoFramesDelta = delta(first?.video, last?.video, "framesEncoded");
  const lossSamples = samples.flatMap((sample) =>
    [sample.remoteVideo?.fractionLost, sample.remoteAudio?.fractionLost]
      .map(Number)
      .filter((value) => Number.isFinite(value) && value >= 0),
  );
  const rttMsSamples = samples.flatMap((sample) =>
    [
      Number(sample.route?.currentRoundTripTime),
      Number(sample.remoteVideo?.roundTripTime),
      Number(sample.remoteAudio?.roundTripTime),
    ]
      .filter((value) => Number.isFinite(value) && value >= 0)
      .map((value) => value * 1_000),
  );
  return {
    sampleCount: samples.length,
    durationMs,
    videoBytesDelta: delta(first?.video, last?.video, "bytesSent"),
    videoFramesDelta,
    encodedFps:
      videoFramesDelta !== undefined && durationMs > 0
        ? videoFramesDelta / (durationMs / 1_000)
        : undefined,
    audioBytesDelta: delta(first?.audio, last?.audio, "bytesSent"),
    audioEnergyDelta: delta(
      first?.audio,
      last?.audio,
      "totalAudioEnergy",
    ),
    audioEnergySupported:
      Number.isFinite(Number(first?.audio?.totalAudioEnergy)) &&
      Number.isFinite(Number(last?.audio?.totalAudioEnergy)),
    maxPacketLossRatio: maximum(lossSamples),
    maxRttMs: maximum(rttMsSamples),
    averageRttMs: average(rttMsSamples),
    maxFrameStallMs: samples.length > 1 ? longestFrameStall(
      samples.map((sample) => ({
        at: sample.at,
        video: { framesDecoded: sample.video?.framesEncoded },
      })),
    ) : undefined,
    selectedIceRoute: [...samples]
      .reverse()
      .find((sample) => sample.route)?.route,
    finalConnectionState: last?.connectionState,
    finalIceConnectionState: last?.iceConnectionState,
    finalVideo: last?.video,
    finalAudio: last?.audio,
    remoteVideo: last?.remoteVideo,
    remoteAudio: last?.remoteAudio,
    errors: Array.isArray(observation.errors) ? observation.errors : [],
  };
}

function senderHealthIssues(summary, config) {
  const issues = [];
  if (summary.sampleCount < 3) issues.push("发送端统计样本不足");
  if (!Number.isFinite(summary.videoBytesDelta) || summary.videoBytesDelta <= 0) {
    issues.push("视频 RTP 未持续发送");
  }
  if (
    !Number.isFinite(summary.videoFramesDelta) ||
    summary.videoFramesDelta <= 0
  ) {
    issues.push("视频编码帧未增长");
  }
  if (
    Number.isFinite(summary.encodedFps) &&
    summary.encodedFps < config.minDecodedFps
  ) {
    issues.push(`编码帧率过低：${summary.encodedFps.toFixed(1)}`);
  }
  if (!Number.isFinite(summary.audioBytesDelta) || summary.audioBytesDelta <= 0) {
    issues.push("音频 RTP 未持续发送");
  }
  if (
    config.requireAudibleAudio &&
    summary.audioEnergySupported &&
    (!Number.isFinite(summary.audioEnergyDelta) ||
      summary.audioEnergyDelta <= 0)
  ) {
    issues.push("窗口声音没有可检测的音频能量");
  }
  if (
    Number.isFinite(summary.maxPacketLossRatio) &&
    summary.maxPacketLossRatio > config.maxPacketLossRatio
  ) {
    issues.push(
      `接收端回报丢包率过高：${(summary.maxPacketLossRatio * 100).toFixed(2)}%`,
    );
  }
  if (
    Number.isFinite(summary.maxRttMs) &&
    summary.maxRttMs > config.maxRttMs
  ) {
    issues.push(`ICE 往返延迟 ${Math.round(summary.maxRttMs)} ms`);
  }
  if (
    Number.isFinite(summary.maxFrameStallMs) &&
    summary.maxFrameStallMs > config.maxFrameStallMs
  ) {
    issues.push(`发送端最长无新编码帧 ${Math.round(summary.maxFrameStallMs)} ms`);
  }
  if (
    !summary.selectedIceRoute ||
    (
      summary.selectedIceRoute.state !== "succeeded" &&
      !summary.selectedIceRoute.selected &&
      !summary.selectedIceRoute.nominated
    )
  ) {
    issues.push("发送端未找到成功的 ICE 候选对");
  }
  if (summary.finalConnectionState !== "connected") {
    issues.push(`发送端连接状态为 ${summary.finalConnectionState || "未知"}`);
  }
  if (summary.errors.length) {
    issues.push(`发送端采样发生 ${summary.errors.length} 个错误`);
  }
  return issues;
}

function findUiNode(xml, resourceId) {
  const escaped = String(resourceId).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const tag = String(xml).match(
    new RegExp(`<node\\b[^>]*\\bresource-id="${escaped}"[^>]*>`, "u"),
  )?.[0];
  if (!tag) return undefined;
  const bounds = tag.match(
    /\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u,
  );
  if (!bounds) return undefined;
  const left = Number(bounds[1]);
  const top = Number(bounds[2]);
  const right = Number(bounds[3]);
  const bottom = Number(bounds[4]);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    centerX: Math.round((left + right) / 2),
    centerY: Math.round((top + bottom) / 2),
    text: tag.match(/\btext="([^"]*)"/u)?.[1] || "",
  };
}

module.exports = {
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
};
