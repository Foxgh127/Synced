import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

function source(relativePath) {
  return readFileSync(path.resolve(relativePath), "utf8");
}

test("LiveKit SFU is the primary watch path and P2P remains a fallback", () => {
  const packageJson = JSON.parse(source("package.json"));
  const channel = source("src/channel-session.ts");
  const sfu = source("src/sfu.ts");

  assert.equal(packageJson.dependencies["livekit-client"], "2.21.0");
  const wrapperStart = channel.indexOf(
    "async function beginWatching(recreate = false)",
  );
  const sfuAttempt = channel.indexOf("beginSfuWatching()", wrapperStart);
  const p2pAttempt = channel.indexOf("beginP2PWatching(recreate)", wrapperStart);
  assert.ok(wrapperStart > 0);
  assert.ok(sfuAttempt > wrapperStart);
  assert.ok(p2pAttempt > sfuAttempt);
  assert.match(channel, /publishBroadcastToSfu\(\)/);
  assert.match(channel, /fallbackFromSfu\(/);
  assert.match(channel, /type:\s*"sfu:status"/);
  assert.match(channel, /type:\s*"broadcast:watch-ready"/);

  assert.match(sfu, /new Room\(/);
  assert.match(sfu, /localParticipant\.publishTrack\(/);
  assert.match(sfu, /localParticipant\.publishDataTrack\(/);
  assert.match(sfu, /destinationIdentities:\s*\[broadcasterId\]/);
  assert.match(sfu, /RoomEvent\.Disconnected/);
  assert.match(sfu, /maxPartialFrames:\s*256/);
});

test("signal and deployment never impose TURN or SFU bandwidth ceilings", () => {
  const signal = source("server/index.mjs");
  const compose = source("deployment/docker-compose.yml");
  const livekitEntrypoint = source("deployment/livekit-entrypoint.sh");
  const turnConfig = source("deployment/turnserver-relay.conf.example");

  assert.match(signal, /relayCapacityEnforced:\s*false/);
  assert.match(signal, /p2pFallbackViewerCount/);
  assert.match(signal, /const boundedBudgetBps = perViewerBudgetBps/);
  assert.doesNotMatch(signal, /DEFAULT_RELAY_(?:SESSION_)?CAPACITY_BPS/);
  assert.doesNotMatch(compose, /--max-bps=/);
  assert.doesNotMatch(compose, /--bps-capacity=/);
  assert.doesNotMatch(turnConfig, /^max-bps=/m);
  assert.doesNotMatch(turnConfig, /^bps-capacity=/m);
  assert.match(livekitEntrypoint, /bytes_per_sec: -1/);
  assert.match(livekitEntrypoint, /num_tracks: -1/);
});

test("SFU deployment exposes UDP, TCP, TURN, and reverse-proxied signaling", () => {
  const compose = source("deployment/docker-compose.yml");
  const livekitEntrypoint = source("deployment/livekit-entrypoint.sh");
  const nginx = source("deployment/nginx-synced-signal-location.conf");

  assert.match(compose, /network_mode:\s*host/);
  assert.match(compose, /livekit\/livekit-server:v1\.13\.4/);
  assert.match(livekitEntrypoint, /tcp_port: 7881/);
  assert.match(livekitEntrypoint, /udp_port: 7882/);
  assert.match(livekitEntrypoint, /turn_servers:/);
  assert.match(nginx, /location \^~ \/sfu\//);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:7880\//);
});

test("SFU lifecycle isolates viewer faults and replaces recovered screen tracks in place", () => {
  const channel = source("src/channel-session.ts");
  const broadcast = source("src/emby-broadcast.ts");
  const player = source("src/emby-player.ts");
  const sfu = source("src/sfu.ts");

  assert.match(
    player,
    /recoveryStrategy\?: "peer-resync" \| "transport-fallback"/,
  );
  assert.match(
    channel,
    /recoveryStrategy:\s*"transport-fallback"/,
  );
  assert.match(
    broadcast,
    /viewerId === "__sfu__"[\s\S]*?must never pause|viewerId === "__sfu__"[\s\S]*?return;/,
  );
  assert.match(sfu, /replacePublishedScreenTrack\(/);
  assert.match(sfu, /localTrack\.replaceTrack\(replacement/);
  assert.match(channel, /replacePublishedSfuScreenTrack\([\s\S]*?capture-video-recovered/);
  assert.match(channel, /replacePublishedSfuScreenTrack\([\s\S]*?process-audio-recovered/);
  assert.match(
    channel,
    /onParticipantDisconnected:[\s\S]*?identity === broadcasterId[\s\S]*?fallbackFromSfu/,
  );
  assert.match(
    sfu,
    /const mediaChannel = new SfuRtcDataChannel\(\s*SFU_EMBY_MEDIA_TRACK,\s*undefined,\s*fatal,\s*\)/,
  );
  assert.match(
    sfu,
    /const controlChannel = new SfuRtcDataChannel\(\s*SFU_EMBY_CONTROL_TRACK,\s*publishViewerControl,\s*fatal,\s*\)/,
  );
});

test("SFU readers and watch attempts are cancellation-safe", () => {
  const sfu = source("src/sfu.ts");

  assert.match(sfu, /watchAbortController\?: AbortController/);
  assert.match(sfu, /watchController\?\.abort\(\)/);
  assert.match(
    sfu,
    /const result = await reader\.read\(\);[\s\S]*?!active \|\| channel\.readyState !== "open"/,
  );
  assert.match(sfu, /this\.readers\.indexOf\(handle\)/);
  assert.match(sfu, /reader\.releaseLock\(\)/);
  assert.match(sfu, /pendingAccess\?: SfuAccess/);
  assert.match(
    sfu,
    /pendingAccess\?\.url === access\.url[\s\S]*?return this\.connect\(access, iceServers\)/,
  );
  assert.match(
    sfu,
    /RoomEvent\.Reconnecting[\s\S]{0,100}?this\.room !== room/,
  );
  assert.match(
    sfu,
    /RoomEvent\.Reconnected[\s\S]{0,100}?this\.room !== room/,
  );
  assert.match(
    sfu,
    /RoomEvent\.ParticipantDisconnected[\s\S]{0,140}?this\.room !== room/,
  );
  assert.match(
    sfu,
    /RoomEvent\.DataReceived[\s\S]{0,140}?this\.room !== room/,
  );
  assert.match(sfu, /const connecting = room\.connect/);
  assert.match(sfu, /stale SFU connection cleanup timed out/);
  assert.match(sfu, /late SFU connection cleanup timed out/);
  assert.match(
    sfu,
    /RoomEvent\.Disconnected[\s\S]*?this\.options\.onStateChange\?\.\("disconnected"\)[\s\S]*?this\.stopWatching\(\)[\s\S]*?this\.stopPublishing\(\)/,
  );
  assert.match(
    sfu,
    /async watchScreen[\s\S]*?catch \(error\)[\s\S]*?this\.watchAbortController === watchController[\s\S]*?await this\.stopWatching\(\)/,
  );
  assert.match(
    sfu,
    /async watchEmby[\s\S]*?catch \(error\)[\s\S]*?this\.watchAbortController === watchController[\s\S]*?await this\.stopWatching\(\)/,
  );
  assert.match(
    sfu,
    /const addTrack[\s\S]*?this\.room !== room[\s\S]*?this\.watchAbortController !== watchController/,
  );
});

test("SFU publication, data sends, and teardown are bounded and stale-safe", () => {
  const sfu = source("src/sfu.ts");
  const publishEmbyStart = sfu.indexOf("async publishEmby()");
  const mediaAssignment = sfu.indexOf(
    "this.localMediaTrack = mediaTrack",
    publishEmbyStart,
  );
  const controlPublication = sfu.indexOf(
    "const publishingControl",
    publishEmbyStart,
  );

  assert.match(sfu, /const SFU_DATA_SEND_TIMEOUT_MS = 5_000/);
  assert.match(sfu, /const SFU_PUBLISH_TIMEOUT_MS = 10_000/);
  assert.match(sfu, /const SFU_TEARDOWN_TIMEOUT_MS = 2_000/);
  assert.match(
    sfu,
    /this\.outbound!\(payload\),[\s\S]*?SFU_DATA_SEND_TIMEOUT_MS/,
  );
  assert.match(
    sfu,
    /\.catch\(\(error\) => \{[\s\S]{0,100}?this\.readyState !== "open"[\s\S]{0,100}?this\.failureCount \+= 1/,
  );
  assert.match(sfu, /private publicationGeneration = 0/);
  assert.match(sfu, /isCurrentPublication\(/);
  assert.match(sfu, /late SFU screen publication cleanup timed out/);
  assert.match(sfu, /late SFU Emby media cleanup timed out/);
  assert.match(sfu, /late SFU Emby control cleanup timed out/);
  assert.ok(mediaAssignment > publishEmbyStart);
  assert.ok(controlPublication > mediaAssignment);
  assert.match(
    sfu,
    /async stopPublishing\(\): Promise<void> \{[\s\S]*?publicationGeneration \+= 1;[\s\S]*?clearPublishedState\(\)/,
  );
  assert.match(
    sfu,
    /reader\.cancel\(\),[\s\S]*?SFU_TEARDOWN_TIMEOUT_MS/,
  );
  assert.match(
    sfu,
    /room\.disconnect\(false\),[\s\S]*?SFU_TEARDOWN_TIMEOUT_MS/,
  );
});

test("P2P fallback periodically returns to SFU and detects silent SFU media", () => {
  const channel = source("src/channel-session.ts");
  const player = source("src/emby-player.ts");

  assert.match(channel, /SFU_PRIMARY_RECOVERY_DELAYS_MS/);
  assert.match(channel, /scheduleSfuPrimaryRecovery\("runtime SFU viewer fallback"\)/);
  assert.match(channel, /recovered = await beginSfuWatching\(\)/);
  assert.match(channel, /recovered = await publishBroadcastToSfu\(\)/);
  assert.match(channel, /SFU_SCREEN_SILENCE_TIMEOUT_MS/);
  assert.match(channel, /sfu-screen-silent/);
  assert.match(channel, /sfuPublishPromise: Promise<boolean>/);
  assert.match(player, /EMBY_TRANSPORT_SILENCE_TIMEOUT_MS/);
  assert.match(player, /"transport-silent"/);
});

test("P2P peers are created only after an explicit fallback watch request", () => {
  const channel = source("src/channel-session.ts");
  const grantStart = channel.indexOf(
    'message.type === "broadcast:granted"',
  );
  const grantEnd = channel.indexOf(
    'message.type === "broadcast:started"',
    grantStart,
  );
  const viewerStart = channel.indexOf(
    'message.type === "viewer:joined"',
  );
  const viewerEnd = channel.indexOf(
    'message.type === "media:ready"',
    viewerStart,
  );

  assert.doesNotMatch(
    channel.slice(grantStart, grantEnd),
    /message\.viewerIds[\s\S]*?createOfferForViewer/,
  );
  assert.match(
    channel.slice(viewerStart, viewerEnd),
    /broadcasterId === selfId && message\.sessionId/,
  );
  assert.match(channel, /function forgetDepartedViewer/);
  assert.match(channel, /if \(!participants\.has\(viewerId\)\) forgetDepartedViewer/);
});

test("dynamic membership isolates late joins and departed viewer state", () => {
  const channel = source("src/channel-session.ts");
  const publicSmoke = source("scripts/smoke-public-sfu.cjs");
  const cleanupStart = channel.indexOf(
    "function forgetDepartedViewer(viewerId: string)",
  );
  const cleanupEnd = channel.indexOf(
    "async function applyOutboundPreference",
    cleanupStart,
  );
  const cleanup = channel.slice(cleanupStart, cleanupEnd);

  assert.ok(cleanupStart > 0);
  assert.match(cleanup, /embyBroadcast\?\.detachViewer\(viewerId\)/);
  assert.match(cleanup, /outboundPeers\.delete\(viewerId\)/);
  assert.match(cleanup, /peer\.pc\.close\(\)/);
  assert.match(cleanup, /failedVideoCodecsByViewer\.delete\(viewerId\)/);
  assert.match(cleanup, /receiverPreferences\.delete\(viewerId\)/);
  assert.match(cleanup, /embyPressureQualityByViewer\.delete\(viewerId\)/);
  assert.match(
    channel,
    /message\.type === "participant:left"[\s\S]*?forgetDepartedViewer\(message\.participantId\)/,
  );
  assert.match(
    channel,
    /const majorityHeight = heights\[Math\.floor\(heights\.length \/ 2\)\]/,
  );
  assert.match(publicSmoke, /lateViewerJoined:\s*true/);
  assert.match(publicSmoke, /viewerLeaveIsolated:\s*true/);
  assert.match(publicSmoke, /RoomEvent\.ParticipantDisconnected/);
  assert.match(publicSmoke, /synced-after-viewer-left/);
});
