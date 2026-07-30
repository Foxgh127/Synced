import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let rtcModulePromise;

async function loadRtcModule() {
  if (!rtcModulePromise) {
    rtcModulePromise = build({
      entryPoints: [path.resolve("src/rtc.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    }).then(({ outputFiles }) => {
      const source = outputFiles[0].text;
      return import(
        `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
      );
    });
  }
  return rtcModulePromise;
}

function nativeLikeDescription(type = "offer") {
  const description = {};
  Object.defineProperty(description, "type", {
    configurable: true,
    enumerable: false,
    value: type,
  });
  Object.defineProperty(description, "sdp", {
    configurable: true,
    enumerable: false,
    value: [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 minptime=10",
      "a=candidate:1 1 UDP 2122260223 desktop.local 52100 typ host",
      "a=candidate:2 1 UDP 1677734911 47.98.173.139 3478 typ relay",
      "",
    ].join("\r\n"),
  });
  return description;
}

test("signal ingress rejects non-object and oversized JSON envelopes", async () => {
  const rtc = await loadRtcModule();
  for (const payload of [
    "null",
    "[]",
    "1",
    '"text"',
    JSON.stringify({}),
    JSON.stringify({ type: "" }),
    JSON.stringify({ type: "x".repeat(97) }),
  ]) {
    assert.equal(rtc.parseSignalEnvelope(payload), undefined);
  }
  assert.equal(
    rtc.parseSignalEnvelope(
      JSON.stringify({
        type: "channel:joined",
        clientId: "viewer-1",
      }),
    ).type,
    "channel:joined",
  );
  assert.equal(
    rtc.parseSignalEnvelope(
      " ".repeat(rtc.MAX_SIGNAL_MESSAGE_BYTES + 1),
    ),
    undefined,
  );
  assert.equal(
    rtc.parseSignalEnvelope(
      JSON.stringify({
        type: "chat",
        text: "界".repeat(90_000),
      }),
    ),
    undefined,
    "the limit is measured in UTF-8 bytes rather than UTF-16 code units",
  );
});

test("every SDP transform preserves non-enumerable native type and sdp", async () => {
  const rtc = await loadRtcModule();
  const description = nativeLikeDescription();
  const transformed = [
    rtc.serializableSessionDescription(description),
    rtc.exposeLocalIceDescription(description, ["192.168.1.6"]),
    rtc.stripDirectIceCandidates(description),
    rtc.stripUnsafeIceCandidates(description),
    rtc.stripRelayIceCandidates(description),
    rtc.tuneOpus(description),
    rtc.prioritizeAdvertisedH264Profiles(description),
    rtc.tuneMovieSdp(description, 12_000_000),
    rtc.tuneVoiceOpus(description),
  ];

  for (const result of transformed) {
    assert.equal(result.type, "offer");
    assert.equal(typeof result.sdp, "string");
    assert.equal(JSON.parse(JSON.stringify(result)).type, "offer");
  }
  assert.match(transformed[1].sdp, /192\.168\.1\.6/);
  assert.match(transformed[3].sdp, /\btyp relay\b/);
  assert.doesNotMatch(transformed[4].sdp, /\btyp relay\b/);
});

test("measures Emby DataChannel bitrate and selected P2P RTT", async () => {
  const rtc = await loadRtcModule();
  const report = new Map([
    [
      "data",
      {
        id: "data",
        type: "data-channel",
        label: "yiqikan-emby-v1",
        bytesReceived: 501_000,
        messagesReceived: 18,
        timestamp: 2_000,
      },
    ],
    [
      "pair",
      {
        id: "pair",
        type: "candidate-pair",
        state: "succeeded",
        selected: true,
        currentRoundTripTime: 0.042,
        localCandidateId: "local",
        remoteCandidateId: "remote",
      },
    ],
    [
      "local",
      {
        id: "local",
        type: "local-candidate",
        candidateType: "host",
        protocol: "udp",
      },
    ],
    [
      "remote",
      {
        id: "remote",
        type: "remote-candidate",
        candidateType: "srflx",
        protocol: "udp",
      },
    ],
  ]);
  const stats = await rtc.readDataChannelStats(
    { getStats: async () => report },
    "yiqikan-emby-v1",
    { bytes: 1_000, timestamp: 1_000 },
  );
  assert.equal(stats.bitrate, 4_000_000);
  assert.equal(stats.bytesReceived, 501_000);
  assert.equal(stats.messagesReceived, 18);
  assert.equal(stats.currentRoundTripTime, 0.042);
  assert.equal(stats.relayed, false);
  assert.equal(stats.transportProtocol, "udp/udp");
});

test("SDP transforms serialize descriptions even on their early-return paths", async () => {
  const rtc = await loadRtcModule();
  const noOpus = nativeLikeDescription("answer");
  Object.defineProperty(noOpus, "sdp", {
    configurable: true,
    enumerable: false,
    value: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
  });

  for (const result of [
    rtc.exposeLocalIceDescription(noOpus, []),
    rtc.tuneOpus(noOpus),
    rtc.tuneVoiceOpus(noOpus),
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      type: "answer",
      sdp: noOpus.sdp,
    });
  }
});

test("wildcard and privacy-masked host candidates use the physical LAN address", async () => {
  const rtc = await loadRtcModule();
  const description = nativeLikeDescription();
  Object.defineProperty(description, "sdp", {
    configurable: true,
    enumerable: false,
    value: [
      "v=0",
      "a=candidate:1 1 UDP 2122260223 phone.local 52001 typ host",
      "a=candidate:2 1 UDP 2122260222 0.0.0.0 52002 typ host",
      "a=candidate:3 1 UDP 2122260221 [::] 52003 typ host",
      "",
    ].join("\r\n"),
  });

  const exposed = rtc.exposeLocalIceDescription(description, ["192.168.1.3"]);
  assert.equal(exposed.type, "offer");
  assert.equal(exposed.sdp.match(/192\.168\.1\.3/g)?.length, 3);
  assert.doesNotMatch(exposed.sdp, /phone\.local|0\.0\.0\.0|\[::\]/);
});

test("keeps a public STUN mapping even when its related address is a TUN adapter", async () => {
  const rtc = await loadRtcModule();
  const mappedThroughTunnel = {
    candidate:
      "candidate:4 1 UDP 1686052607 203.0.113.20 41234 typ srflx raddr 198.18.0.1 rport 53000",
  };
  const tunnelHost = {
    candidate: "candidate:5 1 UDP 2122260223 198.18.0.1 53000 typ host",
  };
  const carrierGradeNatHost = {
    candidate: "candidate:6 1 UDP 2122260222 100.96.0.1 53001 typ host",
  };
  assert.equal(
    rtc.isUsableDirectIceCandidate(mappedThroughTunnel, "balanced"),
    true,
  );
  assert.equal(
    rtc.isUsableDirectIceCandidate(mappedThroughTunnel, "public"),
    true,
  );
  assert.equal(rtc.isUsableDirectIceCandidate(tunnelHost, "balanced"), false);
  assert.equal(
    rtc.isUsableDirectIceCandidate(carrierGradeNatHost, "balanced"),
    false,
  );
});

test("keeps a small ICE pool except on Huawei-family WebViews", async () => {
  const rtc = await loadRtcModule();
  assert.equal(rtc.shouldDisableIceCandidatePool("Chrome/140"), false);
  assert.equal(
    rtc.shouldDisableIceCandidatePool(
      "Mozilla/5.0 (Linux; Android 16; HUAWEI Pura)",
    ),
    true,
  );
  assert.equal(
    rtc.shouldDisableIceCandidatePool("Mozilla/5.0 HarmonyOS"),
    true,
  );
  assert.equal(rtc.shouldDisableIceCandidatePool("Chrome/140", true), true);
});

test("filters numeric host candidates that are not on a known physical adapter", async () => {
  const rtc = await loadRtcModule();
  const physicalHost = {
    candidate: "candidate:6 1 UDP 2122260223 192.168.1.8 53001 typ host",
  };
  const unlistedTunnelHost = {
    candidate: "candidate:7 1 UDP 2122260222 10.77.0.1 53002 typ host",
  };

  assert.equal(
    rtc.isUsableDirectIceCandidate(
      physicalHost,
      "balanced",
      ["192.168.1.8"],
    ),
    true,
  );
  assert.equal(
    rtc.isUsableDirectIceCandidate(
      unlistedTunnelHost,
      "balanced",
      ["192.168.1.8"],
    ),
    false,
  );
});

test("movie ICE keeps TURN fallback while rejecting virtual host candidates", async () => {
  const rtc = await loadRtcModule();
  const relay = {
    candidate:
      "candidate:8 1 UDP 1677734911 43.161.195.12 49160 typ relay",
  };
  const tunnelHost = {
    candidate: "candidate:9 1 UDP 2122260223 198.18.0.1 53003 typ host",
  };
  assert.equal(
    rtc.isUsableIceCandidate(relay, "balanced", ["192.168.1.8"]),
    true,
  );
  assert.equal(
    rtc.isUsableIceCandidate(tunnelHost, "balanced", ["192.168.1.8"]),
    false,
  );

  const description = {
    type: "offer",
    sdp: [
      "v=0",
      "a=candidate:8 1 UDP 1677734911 43.161.195.12 49160 typ relay",
      "a=candidate:9 1 UDP 2122260223 198.18.0.1 53003 typ host",
      "a=candidate:10 1 UDP 2122260222 192.168.1.8 53004 typ host",
      "",
    ].join("\r\n"),
  };
  const filtered = rtc.stripUnsafeIceCandidates(
    description,
    "balanced",
    ["192.168.1.8"],
  );
  assert.match(filtered.sdp, /\btyp relay\b/);
  assert.match(filtered.sdp, /192\.168\.1\.8/);
  assert.doesNotMatch(filtered.sdp, /198\.18\.0\.1/);
});

test("TURN-only voice fallback keeps credentials and removes direct servers", async () => {
  const rtc = await loadRtcModule();
  const servers = [
    { urls: ["stun:relay.example:3478"] },
    {
      urls: [
        "turn:relay.example:3478?transport=udp",
        "turn:relay.example:3478?transport=tcp",
      ],
      username: "room",
      credential: "secret",
    },
  ];

  assert.equal(rtc.hasTurnIceServer(servers), true);
  assert.deepEqual(rtc.selectPeerIceServers(servers, "relay"), [
    {
      urls: [
        "turn:relay.example:3478?transport=udp",
        "turn:relay.example:3478?transport=tcp",
      ],
      username: "room",
      credential: "secret",
    },
  ]);
  assert.deepEqual(rtc.selectPeerIceServers(servers, "direct"), [
    { urls: ["stun:relay.example:3478"] },
  ]);
});

test("relay-only peer construction enforces relay transport at the browser boundary", async () => {
  const rtc = await loadRtcModule();
  const originalPeerConnection = globalThis.RTCPeerConnection;
  class FakePeerConnection {
    constructor(configuration) {
      this.configuration = configuration;
      this.connectionState = "new";
      this.iceConnectionState = "new";
      this.iceGatheringState = "new";
      this.signalingState = "stable";
    }

    addEventListener() {}
  }
  globalThis.RTCPeerConnection = FakePeerConnection;
  try {
    const peer = rtc.createPeerConnection(
      [
        { urls: "stun:relay.example:3478" },
        {
          urls: "turn:relay.example:3478?transport=tcp",
          username: "room",
          credential: "secret",
        },
      ],
      () => {},
      { relayOnly: true },
    );
    assert.equal(peer.configuration.iceTransportPolicy, "relay");
    assert.deepEqual(peer.configuration.iceServers, [
      {
        urls: ["turn:relay.example:3478?transport=tcp"],
        username: "room",
        credential: "secret",
      },
    ]);
  } finally {
    if (originalPeerConnection === undefined) {
      delete globalThis.RTCPeerConnection;
    } else {
      globalThis.RTCPeerConnection = originalPeerConnection;
    }
  }
});

test("original quality scales its ceiling to the real captured pixels", async () => {
  const rtc = await loadRtcModule();
  assert.equal(
    rtc.sourceVideoBitrateCeiling(
      32_000_000,
      1920,
      1080,
      30,
    ),
    19_906_560,
  );
  assert.equal(
    rtc.sourceVideoBitrateCeiling(
      32_000_000,
      3840,
      2160,
      30,
    ),
    32_000_000,
  );
  assert.equal(rtc.receiverBitrateCeiling(1_800_000, 480, 1), 1_800_000);
});

test("movie SDP advertises a TIAS ceiling without removing RED or ULPFEC", async () => {
  const rtc = await loadRtcModule();
  const description = {
    type: "offer",
    sdp: [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "m=video 9 UDP/TLS/RTP/SAVPF 98 99 100",
      "c=IN IP4 0.0.0.0",
      "b=AS:1500",
      "a=rtpmap:98 VP9/90000",
      "a=rtpmap:99 red/90000",
      "a=rtpmap:100 ulpfec/90000",
      "",
    ].join("\r\n"),
  };

  const tuned = rtc.tuneMovieSdp(description, 18_000_000);
  assert.match(tuned.sdp, /m=video .* 99 100/);
  assert.match(tuned.sdp, /b=TIAS:18000000/);
  assert.doesNotMatch(tuned.sdp, /b=AS:/);
  assert.match(tuned.sdp, /a=rtpmap:99 red\/90000/);
  assert.match(tuned.sdp, /a=rtpmap:100 ulpfec\/90000/);
  assert.equal(rtc.videoTiasBitrate(tuned), 18_000_000);
});

test("video bitrate publishes the selected ceiling unless an explicit warm-up is requested", async () => {
  const rtc = await loadRtcModule();
  const ramp = new rtc.VideoBitrateRampController(32_000_000);
  const measuredRamp = new rtc.VideoBitrateRampController(
    32_000_000,
    10_000_000,
  );

  assert.equal(ramp.currentBitrate, 32_000_000);
  assert.equal(ramp.observe(40_000_000, "none"), undefined);
  assert.equal(measuredRamp.currentBitrate, 10_000_000);
  assert.equal(measuredRamp.observe(30_000_000, "none"), 11_500_000);
  assert.equal(measuredRamp.observe(40_000_000, "cpu"), undefined);
  assert.equal(measuredRamp.currentBitrate, 11_500_000);
  assert.equal(measuredRamp.observe(40_000_000, "bandwidth"), undefined);
  assert.equal(measuredRamp.currentBitrate, 11_500_000);
  assert.equal(measuredRamp.observe(40_000_000, "other"), undefined);
  assert.equal(measuredRamp.currentBitrate, 11_500_000);
  ramp.setTarget(6_000_000);
  assert.equal(ramp.currentBitrate, 6_000_000);
});

test("movie SDP prioritizes only H.264 High profiles the browser advertised", async () => {
  const rtc = await loadRtcModule();
  const description = {
    type: "offer",
    sdp: [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 98 96 97 102 103",
      "a=rtpmap:98 VP9/90000",
      "a=rtpmap:96 H264/90000",
      "a=fmtp:96 profile-level-id=42e01f;packetization-mode=1",
      "a=rtpmap:97 rtx/90000",
      "a=fmtp:97 apt=96",
      "a=rtpmap:102 H264/90000",
      "a=fmtp:102 profile-level-id=640032;packetization-mode=1",
      "a=rtpmap:103 rtx/90000",
      "a=fmtp:103 apt=102",
      "",
    ].join("\r\n"),
  };

  const tuned = rtc.tuneMovieSdp(description, 18_000_000);
  assert.match(
    tuned.sdp,
    /m=video 9 UDP\/TLS\/RTP\/SAVPF 98 102 97 96 103/,
  );
  assert.match(tuned.sdp, /profile-level-id=42e01f/);
  assert.match(tuned.sdp, /profile-level-id=640032/);
  assert.equal(
    rtc.advertisedH264ProfileRank(
      "profile-level-id=640032;packetization-mode=1",
    ),
    0,
  );
  assert.equal(
    rtc.advertisedH264ProfileRank(
      "profile-level-id=42e01f;packetization-mode=1",
    ),
    2,
  );
});

test("movie sender preserves the requested raster and honors a source-aware ceiling", async () => {
  const rtc = await loadRtcModule();
  let applied;
  const sender = {
    track: {
      kind: "video",
      getSettings: () => ({
        width: 2560,
        height: 1440,
        frameRate: 30,
      }),
    },
    getParameters: () => ({ encodings: [{}] }),
    setParameters: async (parameters) => {
      applied = parameters;
    },
  };
  const pc = { getSenders: () => [sender] };
  const preset = {
    width: 7680,
    height: 4320,
    frameRate: 30,
    maxBitrate: 32_000_000,
    audioBitrate: 256_000,
  };

  await rtc.tuneSenders(pc, preset, {
    videoBitrateCeiling: 10_000_000,
  });
  assert.equal(applied.degradationPreference, "maintain-resolution");
  assert.equal(applied.encodings[0].maxBitrate, 10_000_000);

  const result = await rtc.applyReceiverPreference(
    pc,
    preset,
    {},
    { videoBitrateCeiling: 10_000_000 },
  );
  assert.equal(applied.degradationPreference, "maintain-resolution");
  assert.equal(applied.encodings[0].scaleResolutionDownBy, 1);
  assert.equal(applied.encodings[0].maxBitrate, 10_000_000);
  assert.equal(result.targetBitrate, 32_000_000);
  assert.equal(result.sourceBitrateCeiling, 32_000_000);

  await rtc.applyReceiverPreference(pc, preset, {}, {
    videoBitrateCeiling: 10_000_000,
    degradationPreference: "maintain-framerate",
  });
  assert.equal(applied.degradationPreference, "maintain-framerate");
});

test("receiver scaling keeps Android decoder rows aligned after a Chrome F11 resize", async () => {
  const rtc = await loadRtcModule();
  let applied;
  const sender = {
    track: {
      kind: "video",
      getSettings: () => ({
        width: 3616,
        height: 2160,
        frameRate: 30,
      }),
    },
    getParameters: () => ({ encodings: [{}] }),
    setParameters: async (parameters) => {
      applied = parameters;
    },
  };
  const pc = { getSenders: () => [sender] };
  const preset = {
    width: 7680,
    height: 4320,
    frameRate: 30,
    maxBitrate: 32_000_000,
    audioBitrate: 256_000,
  };

  const result = await rtc.applyReceiverPreference(
    pc,
    preset,
    { height: 720, frameRate: 30 },
  );

  assert.ok(result);
  assert.equal(result.requestedHeight, 720);
  assert.equal(result.encodedWidth, 1200);
  assert.equal(result.encodedHeight, 716);
  assert.equal(result.encodedWidth % 16, 0);
  assert.equal(result.encodedHeight % 2, 0);
  assert.equal(
    applied.encodings[0].scaleResolutionDownBy,
    3616 / 1200,
  );
});

test("sender guard also protects original quality when WGC ignores the exact safe width", async () => {
  const rtc = await loadRtcModule();
  let applied;
  const sender = {
    track: {
      kind: "video",
      getSettings: () => ({
        width: 3618,
        height: 2160,
        frameRate: 24,
      }),
    },
    getParameters: () => ({ encodings: [{}] }),
    setParameters: async (parameters) => {
      applied = parameters;
    },
  };
  const pc = { getSenders: () => [sender] };
  const preset = {
    width: 7680,
    height: 4320,
    frameRate: 24,
    maxBitrate: 32_000_000,
    audioBitrate: 256_000,
  };

  await rtc.tuneSenders(pc, preset);
  assert.equal(
    applied.encodings[0].scaleResolutionDownBy,
    3618 / 3616,
  );
  const result = await rtc.applyReceiverPreference(pc, preset, {});
  assert.equal(result.encodedWidth, 3616);
  assert.equal(result.encodedHeight, 2158);
  assert.equal(result.encodedWidth % 16, 0);
});

test("movie receivers request enough jitter buffering for Wi-Fi recovery", async () => {
  const rtc = await loadRtcModule();
  const video = {
    track: { kind: "video" },
    jitterBufferTarget: null,
  };
  const audio = {
    track: { kind: "audio" },
    jitterBufferTarget: null,
  };
  const unsupported = { track: { kind: "video" } };
  const configured = rtc.configureMovieJitterBuffer({
    getReceivers: () => [video, audio, unsupported],
  });

  assert.equal(configured, 2);
  assert.equal(video.jitterBufferTarget, 300);
  assert.equal(audio.jitterBufferTarget, 300);
});

test("voice keeps full-band Opus and a modest anti-crackle jitter target", async () => {
  const rtc = await loadRtcModule();
  const tuned = rtc.tuneVoiceOpus(nativeLikeDescription());
  assert.match(tuned.sdp, /maxplaybackrate=48000/);
  assert.match(tuned.sdp, /maxaveragebitrate=320000/);
  assert.match(tuned.sdp, /stereo=1/);
  assert.match(tuned.sdp, /useinbandfec=1/);
  assert.match(tuned.sdp, /usedtx=0/);

  const receiver = {
    track: { kind: "audio" },
    jitterBufferTarget: null,
  };
  assert.equal(
    rtc.configureVoiceJitterBuffer({
      getReceivers: () => [receiver],
    }),
    1,
  );
  assert.equal(receiver.jitterBufferTarget, 90);
  assert.equal(rtc.voiceJitterBufferTarget(false), 90);
  assert.equal(rtc.voiceJitterBufferTarget(true), 125);
});

test("movie Opus uses one full-band 320 kbps parameter set", async () => {
  const rtc = await loadRtcModule();
  const tuned = rtc.tuneMovieOpus(nativeLikeDescription());
  assert.match(tuned.sdp, /maxplaybackrate=48000/);
  assert.match(tuned.sdp, /sprop-maxcapturerate=48000/);
  assert.match(tuned.sdp, /maxaveragebitrate=320000/);
  assert.equal((tuned.sdp.match(/maxaveragebitrate=/g) || []).length, 1);
});

test("voice jitter tuning also sets the supported playout-delay hint", async () => {
  const rtc = await loadRtcModule();
  const receiver = {
    track: { kind: "audio" },
    jitterBufferTarget: null,
    playoutDelayHint: null,
  };
  assert.equal(
    rtc.configureVoiceJitterBuffer(
      { getReceivers: () => [receiver] },
      rtc.voiceJitterBufferTarget(true),
    ),
    1,
  );
  assert.equal(receiver.jitterBufferTarget, 125);
  assert.equal(receiver.playoutDelayHint, 0.125);
});

test("codec preference keeps RED, ULPFEC, and RTX repair formats enabled", async () => {
  const rtc = await loadRtcModule();
  const originalSender = globalThis.RTCRtpSender;
  class FakeRtpSender {}
  FakeRtpSender.getCapabilities = () => ({
    codecs: [
      {
        mimeType: "video/H264",
        sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1",
      },
      { mimeType: "video/rtx" },
      { mimeType: "video/VP9" },
      { mimeType: "video/red" },
      { mimeType: "video/ulpfec" },
      {
        mimeType: "video/H264",
        sdpFmtpLine: "profile-level-id=640032;packetization-mode=1",
      },
      { mimeType: "video/VP8" },
    ],
    headerExtensions: [],
  });
  globalThis.RTCRtpSender = FakeRtpSender;
  let preferred;
  const pc = {
    getTransceivers: () => [
      {
        sender: { track: { kind: "video" } },
        setCodecPreferences: (codecs) => {
          preferred = codecs;
        },
      },
    ],
  };
  try {
    rtc.preferVideoCodecs(pc, [
      "video/VP9",
      "video/H264",
      "video/VP8",
    ]);
  } finally {
    if (originalSender === undefined) {
      delete globalThis.RTCRtpSender;
    } else {
      globalThis.RTCRtpSender = originalSender;
    }
  }

  assert.deepEqual(preferred.slice(0, 4).map((codec) => codec.mimeType), [
    "video/VP9",
    "video/H264",
    "video/H264",
    "video/VP8",
  ]);
  const h264 = preferred.filter((codec) => codec.mimeType === "video/H264");
  assert.match(h264[0].sdpFmtpLine, /profile-level-id=640032/);
  assert.match(h264[1].sdpFmtpLine, /profile-level-id=42e01f/);
  assert.ok(preferred.some((codec) => codec.mimeType === "video/red"));
  assert.ok(preferred.some((codec) => codec.mimeType === "video/ulpfec"));
  assert.ok(preferred.some((codec) => codec.mimeType === "video/rtx"));
});

test("a failed viewer codec is deferred on rebuild without disabling repair codecs", async () => {
  const rtc = await loadRtcModule();
  const reordered = rtc.deferFailedVideoCodecs(
    ["video/H264", "video/VP9", "video/VP8", "video/H264"],
    new Set(["VIDEO/H264"]),
  );
  assert.deepEqual(reordered, [
    "video/VP9",
    "video/VP8",
    "video/H264",
  ]);

  const originalSender = globalThis.RTCRtpSender;
  class FakeRtpSender {}
  FakeRtpSender.getCapabilities = () => ({
    codecs: [
      { mimeType: "video/H264" },
      { mimeType: "video/rtx" },
      { mimeType: "video/VP9" },
      { mimeType: "video/red" },
      { mimeType: "video/VP8" },
      { mimeType: "video/ulpfec" },
    ],
    headerExtensions: [],
  });
  globalThis.RTCRtpSender = FakeRtpSender;
  let preferred;
  let selected;
  try {
    selected = rtc.preferVideoCodecs(
      {
        getTransceivers: () => [
          {
            sender: { track: { kind: "video" } },
            setCodecPreferences: (codecs) => {
              preferred = codecs;
            },
          },
        ],
      },
      reordered,
    );
  } finally {
    if (originalSender === undefined) {
      delete globalThis.RTCRtpSender;
    } else {
      globalThis.RTCRtpSender = originalSender;
    }
  }

  assert.equal(selected, "video/VP9");
  assert.deepEqual(
    preferred
      .filter((codec) => !["video/rtx", "video/red", "video/ulpfec"].includes(codec.mimeType))
      .map((codec) => codec.mimeType),
    ["video/VP9", "video/VP8", "video/H264"],
  );
  assert.ok(preferred.some((codec) => codec.mimeType === "video/rtx"));
  assert.ok(preferred.some((codec) => codec.mimeType === "video/red"));
  assert.ok(preferred.some((codec) => codec.mimeType === "video/ulpfec"));
});

test("codec failure evidence requires received bytes, zero decoded frames, and the actual codec", async () => {
  const rtc = await loadRtcModule();
  assert.equal(
    rtc.inboundDecodeFailureCodec({
      bytesReceived: 0,
      framesDecoded: 0,
      codec: "VP9",
    }),
    undefined,
    "a connected one-way path with no inbound bytes is a network failure",
  );
  assert.equal(
    rtc.inboundDecodeFailureCodec({
      bytesReceived: 1_024,
      framesDecoded: 1,
      codec: "VP9",
    }),
    undefined,
  );
  assert.equal(
    rtc.inboundDecodeFailureCodec({
      bytesReceived: 1_024,
      framesDecoded: 0,
      codec: undefined,
    }),
    undefined,
    "a codec must come from inbound RTP stats rather than preference guessing",
  );
  const reportedCodec = rtc.inboundDecodeFailureCodec({
    bytesReceived: 1_024,
    framesDecoded: 0,
    codec: "VP9",
  });
  assert.equal(reportedCodec, "video/vp9");
  assert.equal(
    rtc.matchingVideoCodecFailure({
      reportedSessionId: "session-current",
      reportedAttempt: 2,
      reportedCodec,
      peerSessionId: "session-current",
      peerAttempt: 2,
      negotiatedCodec: "video/VP9",
    }),
    "video/vp9",
  );
  assert.equal(
    rtc.matchingVideoCodecFailure({
      reportedSessionId: "session-stale",
      reportedAttempt: 1,
      reportedCodec,
      peerSessionId: "session-current",
      peerAttempt: 2,
      negotiatedCodec: "video/VP9",
    }),
    undefined,
  );
  assert.equal(
    rtc.matchingVideoCodecFailure({
      reportedSessionId: "session-current",
      reportedAttempt: 2,
      reportedCodec,
      peerSessionId: "session-current",
      peerAttempt: 2,
      negotiatedCodec: "video/H264",
    }),
    undefined,
    "mismatched inbound/outbound negotiated codecs are stale evidence",
  );
  assert.deepEqual(
    rtc.deferFailedVideoCodecs(
      ["video/H264", "video/VP9", "video/VP8"],
      [reportedCodec],
    ),
    ["video/H264", "video/VP8", "video/VP9"],
    "the actual negotiated codec, not the original preference, is deferred",
  );
});

test("outbound stats expose the selected ICE path RTT", async () => {
  const rtc = await loadRtcModule();
  const report = new Map([
    [
      "outbound",
      {
        id: "outbound",
        type: "outbound-rtp",
        kind: "video",
        bytesSent: 1_000,
        timestamp: 2_000,
        transportId: "transport",
        codecId: "codec",
        qualityLimitationReason: "none",
      },
    ],
    ["codec", { id: "codec", type: "codec", mimeType: "video/VP9" }],
    [
      "transport",
      {
        id: "transport",
        type: "transport",
        selectedCandidatePairId: "pair",
      },
    ],
    [
      "pair",
      {
        id: "pair",
        type: "candidate-pair",
        state: "succeeded",
        selected: true,
        currentRoundTripTime: 0.123,
        availableOutgoingBitrate: 20_000_000,
      },
    ],
  ]);
  const stats = await rtc.readOutboundVideoStats({
    getStats: async () => report,
  });

  assert.equal(stats.currentRoundTripTime, 0.123);
  assert.equal(stats.availableOutgoingBitrate, 20_000_000);
});

test("outbound voice stats expose loss and bandwidth for adaptive Opus fallback", async () => {
  const rtc = await loadRtcModule();
  const report = new Map([
    [
      "outbound-audio",
      {
        id: "outbound-audio",
        type: "outbound-rtp",
        kind: "audio",
        bytesSent: 18_000,
        packetsSent: 180,
        timestamp: 2_000,
        transportId: "transport",
        remoteId: "remote-audio",
      },
    ],
    [
      "remote-audio",
      {
        id: "remote-audio",
        type: "remote-inbound-rtp",
        packetsLost: 12,
        fractionLost: 0.08,
        roundTripTime: 0.22,
      },
    ],
    [
      "transport",
      {
        id: "transport",
        type: "transport",
        selectedCandidatePairId: "pair",
      },
    ],
    [
      "pair",
      {
        id: "pair",
        type: "candidate-pair",
        state: "succeeded",
        selected: true,
        currentRoundTripTime: 0.18,
        availableOutgoingBitrate: 420_000,
      },
    ],
  ]);
  const stats = await rtc.readOutboundAudioStats(
    { getStats: async () => report },
    {
      bytes: 2_000,
      packetsSent: 20,
      remotePacketsLost: 1,
      timestamp: 1_000,
    },
  );
  assert.equal(stats.bitrate, 128_000);
  assert.equal(stats.packetLossRatio, 0.08);
  assert.equal(stats.currentRoundTripTime, 0.18);
  assert.equal(stats.availableOutgoingBitrate, 420_000);
});
