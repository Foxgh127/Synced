import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

function source(relativePath) {
  return readFileSync(path.resolve(relativePath), "utf8");
}

test("standby nginx exposes signalling only and overwrites untrusted XFF", () => {
  const nginx = source("deployment/nginx-synced-standby.conf");
  assert.match(nginx, /limit_conn_zone\s+\$binary_remote_addr/);
  assert.match(nginx, /limit_req_zone\s+\$binary_remote_addr/);
  assert.match(nginx, /limit_conn\s+synced_signal_connections\s+8;/);
  assert.match(
    nginx,
    /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/,
  );
  assert.match(nginx, /location = \/healthz/u);
  assert.match(nginx, /location = \/readyz/u);
  assert.match(nginx, /location = \/capabilities/u);
  assert.match(nginx, /location = \/iceservers/u);
  assert.doesNotMatch(nginx, /location \^~ \/sfu\//u);
  assert.doesNotMatch(nginx, /127\.0\.0\.1:7880/u);
  assert.doesNotMatch(nginx, /\$proxy_add_x_forwarded_for/);
});

test("Docker deployment keeps the TURN secret out of argv and environment", () => {
  const compose = source("deployment/docker-compose.yml");
  const entrypoint = source("deployment/coturn-entrypoint.sh");
  assert.match(compose, /TURN_SECRET_FILE:\s*"\/run\/secrets\/turn_secret"/);
  assert.match(compose, /secrets:\s*\n\s+turn_secret:/);
  assert.doesNotMatch(compose, /TURN_SECRET:\s/);
  assert.doesNotMatch(compose, /--static-auth-secret=/);
  assert.match(compose, /--user-quota=16/);
  assert.doesNotMatch(compose, /--max-bps=/);
  assert.doesNotMatch(compose, /--bps-capacity=/);
  assert.doesNotMatch(compose, /RELAY_(?:SESSION_)?CAPACITY_BPS:/);
  assert.match(compose, /--min-port=32768/);
  assert.match(compose, /--max-port=65535/);
  assert.match(compose, /--total-quota=1000/);
  assert.match(entrypoint, /umask 077/);
  assert.match(entrypoint, /exec turnserver -c "\$runtime_config"/);
  assert.match(compose, /--stale-nonce=600/);
  assert.match(compose, /--max-allocate-lifetime=7200/);
  assert.match(compose, /healthcheck:/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /image:\s*coturn\/coturn:4\.15\.0-r0/);
  assert.match(compose, /user:\s*"65534:65534"/);
  assert.match(compose, /cap_drop:\s*\n\s+- ALL/);
  assert.match(compose, /image:\s*livekit\/livekit-server:v1\.13\.4/);
  assert.match(compose, /LIVEKIT_API_SECRET_FILE:\s*"\/run\/secrets\/livekit_api_secret"/);
  const livekitEntrypoint = source("deployment/livekit-entrypoint.sh");
  assert.match(livekitEntrypoint, /bytes_per_sec: -1/);
  assert.match(livekitEntrypoint, /data_channel_max_buffered_amount: 0/);
  assert.match(livekitEntrypoint, /datachannel_data_track_target_latency: 0s/);
});

test("standby node has one signalling-only deployment surface", () => {
  const environment = source("deployment/synced-signal-hz.env.example");
  const nginx = source("deployment/nginx-synced-standby.conf");
  assert.match(
    environment,
    /^ICE_SERVERS_JSON='.*stun:43\.161\.195\.12:3478.*'$/m,
  );
  assert.doesNotMatch(environment, /stun:47\.98\.173\.139/);
  assert.match(environment, /^TURN_SECRET_FILE=\/etc\/synced-turn\.secret$/m);
  assert.match(
    environment,
    /^LIVEKIT_API_SECRET_FILE=\/etc\/synced-livekit\.secret$/m,
  );
  assert.match(environment, /^SFU_PUBLIC_URL=wss:\/\/synced\.com\.cn\/sfu$/m);
  assert.match(environment, /^MAX_VIEWERS_PER_ROOM=7$/m);
  assert.doesNotMatch(environment, /RELAY_(?:SESSION_)?CAPACITY_BPS/);
  assert.doesNotMatch(nginx, /\/sfu|:7880/);
  for (const removed of [
    "deployment/.env.low-bandwidth.example",
    "deployment/docker-compose.low-bandwidth.yml",
    "deployment/turnserver-stun.conf",
    "deployment/synced-stun-443.service",
    "deployment/synced-signal-443.service",
    "deployment/synced-signal-443.socket",
  ]) {
    assert.equal(existsSync(path.resolve(removed)), false, removed);
  }
});

test("systemd services can read their secret-bearing configuration safely", () => {
  const service = source("deployment/synced-signal.service");
  const signalEnvironment = source(
    "deployment/synced-signal.env.example",
  );
  const deploymentGuide = source("deployment/README.md");
  assert.match(service, /^User=synced$/m);
  assert.match(service, /^Group=synced$/m);
  assert.match(
    signalEnvironment,
    /^TURN_SECRET_FILE=\/etc\/synced-turn\.secret$/m,
  );
  assert.match(signalEnvironment, /^MAX_VIEWERS_PER_ROOM=7$/m);
  assert.match(signalEnvironment, /^SFU_ENABLED=true$/m);
  assert.match(
    signalEnvironment,
    /^LIVEKIT_API_SECRET_FILE=\/etc\/synced-livekit\.secret$/m,
  );
  assert.match(deploymentGuide, /SFU.*P2P/s);
});

test("systemd LiveKit deployment is hardened and has no media bandwidth ceiling", () => {
  const service = source("deployment/synced-livekit.service");
  const environment = source("deployment/synced-livekit.env.example");
  const entrypoint = source("deployment/livekit-entrypoint.sh");
  const nginx = source("deployment/nginx-synced-signal-location.conf");

  assert.match(service, /^User=synced$/m);
  assert.match(service, /^Group=synced$/m);
  assert.match(service, /^NoNewPrivileges=yes$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^Restart=always$/m);
  assert.match(
    service,
    /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK$/m,
  );
  assert.match(service, /^EnvironmentFile=\/etc\/synced-livekit\.env$/m);
  assert.match(environment, /^LIVEKIT_BINARY=\/usr\/local\/bin\/livekit-server$/m);
  assert.match(entrypoint, /LIVEKIT_BINARY:-\/livekit-server/);
  assert.match(entrypoint, /bytes_per_sec: -1/);
  assert.doesNotMatch(entrypoint, /max[_-]bps|bps[_-]capacity/i);
  assert.match(nginx, /location \^~ \/sfu\//);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:7880\//);
  assert.match(nginx, /location = \/iceservers/);
});

test("Android playback owns a media foreground service only while active", () => {
  const manifest = source("android/app/src/main/AndroidManifest.xml");
  const activity = source(
    "android/app/src/main/java/com/synced/room/MainActivity.java",
  );
  const plugin = source(
    "android/app/src/main/java/com/synced/room/PlaybackControlsPlugin.java",
  );
  assert.match(manifest, /FOREGROUND_SERVICE_MEDIA_PLAYBACK/);
  assert.match(manifest, /foregroundServiceType="mediaPlayback"/);
  assert.doesNotMatch(activity, /FLAG_KEEP_SCREEN_ON/);
  assert.match(plugin, /addFlags\(WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)/);
  assert.match(plugin, /clearFlags\(WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)/);
  assert.match(plugin, /startForegroundService/);
  assert.match(plugin, /stopService/);
});

test("Android keeps private app data out of cloud backup and device transfer", () => {
  const manifest = source("android/app/src/main/AndroidManifest.xml");
  const extractionRules = source(
    "android/app/src/main/res/xml/data_extraction_rules.xml",
  );
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(
    manifest,
    /android:dataExtractionRules="@xml\/data_extraction_rules"/,
  );
  assert.match(manifest, /android:fullBackupContent="false"/);
  assert.match(
    extractionRules,
    /<cloud-backup>[\s\S]*?<exclude domain="root" path="\." \/>/,
  );
  assert.match(
    extractionRules,
    /<device-transfer>[\s\S]*?<exclude domain="device_root" path="\." \/>/,
  );
});

test("Android built-in audio routes remain usable without Bluetooth permission", () => {
  const plugin = source(
    "android/app/src/main/java/com/synced/room/AudioRoutePlugin.java",
  );
  assert.match(
    plugin,
    /"default"\.equals\(requestedId\)[\s\S]*?"speaker"\.equals\(requestedId\)[\s\S]*?"earpiece"\.equals\(requestedId\)[\s\S]*?return false;/,
  );
  assert.match(plugin, /return deviceResult\(!needsBluetoothPermission\(\)\)/);
  assert.match(
    plugin,
    /legacyDevice\("speaker", "手机扬声器", "speaker"\)/,
  );
  assert.match(
    plugin,
    /legacyDevice\("earpiece", "手机听筒", "earpiece"\)/,
  );
  assert.match(
    plugin,
    /ContextCompat\.checkSelfPermission\([\s\S]*?Manifest\.permission\.BLUETOOTH_CONNECT/,
  );
  assert.doesNotMatch(plugin, /getPermissionState\("bluetoothConnect"\)/);
  assert.match(
    plugin,
    /outputMayRequireBluetoothPermission\(requestedId\)[\s\S]*?&&[\s\S]*?needsBluetoothPermission\(\)/,
  );
  assert.match(
    plugin,
    /public void setOutput\(PluginCall call\)[\s\S]*?try \{[\s\S]*?call\.reject\("切换音频输出失败", error\)/,
  );
});

test("CI and portable build inputs are present in a clean checkout", () => {
  const workflow = source("../.github/workflows/native-check.yml");
  assert.match(workflow, /npm run check/);
  for (const required of [
    "build/cached-portable.nsi",
    "build/installer.nsh",
    "scripts/build-portable.mjs",
    "scripts/ensure-ffmpeg-runtime.mjs",
  ]) {
    assert.doesNotThrow(() => source(required), required);
  }
});

test("release keeps only the current checksum manifest after artifacts validate", () => {
  const releaseBuilder = source("scripts/build-release.mjs");
  const writeIndex = releaseBuilder.indexOf("writeFileSync(checksumPath");
  const cleanupIndex = releaseBuilder.indexOf(
    "/^SHA256SUMS-.+\\.txt$/iu.test(entry.name)",
  );
  assert.ok(writeIndex >= 0, "current checksum manifest is written");
  assert.ok(
    cleanupIndex > writeIndex,
    "historical manifests are removed only after the current manifest exists",
  );
  assert.match(
    releaseBuilder,
    /entry\.name !== path\.basename\(checksumPath\)/,
  );
});

test("public signal diagnostics never print TURN credentials", () => {
  const publicCheck = source("scripts/check-public-signal.mjs");
  const turnSmoke = source("scripts/smoke-public-turn.cjs");
  const concurrencySmoke = source(
    "scripts/smoke-public-turn-concurrency.cjs",
  );
  assert.match(publicCheck, /summarizeIceServers\(created\.iceServers\)/);
  assert.doesNotMatch(
    publicCheck,
    /iceServers:\s*created\.iceServers/,
  );
  assert.match(publicCheck, /credentialTtlSeconds/);
  assert.match(publicCheck, /Never print the short-lived TURN username/);
  assert.match(
    turnSmoke,
    /iceServers:\s*transportIceServers\.map\(\(server\) => \(\{\s*urls:\s*server\.urls/su,
  );
  assert.doesNotMatch(
    turnSmoke,
    /iceServers:\s*transportIceServers,\s*benchmark/su,
  );
  assert.match(
    concurrencySmoke,
    /output exposed a temporary credential/,
  );
  assert.match(concurrencySmoke, /Promise\.all\(/);
});

test("v3 deployment has an atomic rollback and bounded low-memory service", () => {
  const deploy = source("deployment/deploy-signal-v3.sh");
  const service = source("deployment/synced-signal.service");
  assert.match(deploy, /node --check "\$source_bundle"/);
  assert.match(deploy, /mv -f "\$candidate" "\$live_bundle"/);
  assert.match(deploy, /body\.protocolVersion !== expectedProtocol/);
  assert.match(
    deploy,
    /if ! systemctl restart synced-signal\.service; then\s+rollback/u,
  );
  assert.match(deploy, /stat -c %u "\$live_bundle"/u);
  assert.match(deploy, /stat -c %g "\$live_bundle"/u);
  assert.match(deploy, /stat -c %a "\$live_bundle"/u);
  assert.doesNotMatch(deploy, /install -o root -g synced/u);
  assert.doesNotMatch(deploy, /install -d .*"\$install_root"/u);
  assert.match(deploy, /wait_for_health "health"/);
  assert.match(deploy, /rolling back/);
  assert.match(service, /NODE_OPTIONS=--max-old-space-size=160/);
  assert.match(service, /^MemoryHigh=192M$/m);
  assert.match(service, /^MemoryMax=256M$/m);
});

test("TURN migration removes bandwidth ceilings and rolls back", () => {
  const deploy = source("deployment/deploy-turn-capacity.sh");
  const turnConfig = source("deployment/turnserver-relay.conf.example");
  assert.match(deploy, /TURN_MAX_PORT:-65535/);
  assert.match(deploy, /TURN_MAX_ALLOCATE_LIFETIME:-7200/);
  assert.match(deploy, /validate_required_configuration/);
  assert.match(deploy, /upsert_one[\s\S]*?max-allocate-lifetime/);
  assert.match(deploy, /must contain a real, non-empty external-ip/);
  assert.match(deploy, /must contain non-empty TURN_URLS/);
  assert.match(deploy, /TURN_SECRET or TURN_SECRET_FILE/);
  assert.match(deploy, /remove_setting "\$turn_candidate" "max-bps"/);
  assert.match(deploy, /remove_setting "\$turn_candidate" "bps-capacity"/);
  assert.match(deploy, /remove_setting "\$signal_candidate" "RELAY_CAPACITY_BPS"/);
  assert.match(deploy, /remove_setting "\$signal_candidate" "RELAY_SESSION_CAPACITY_BPS"/);
  assert.match(deploy, /cp -a "\$turn_backup" "\$turn_config"/);
  assert.match(deploy, /cp -a "\$signal_backup" "\$signal_env"/);
  assert.match(deploy, /systemctl restart coturn\.service/);
  assert.match(deploy, /wait_for_signal/);
  assert.match(turnConfig, /^min-port=32768$/m);
  assert.match(turnConfig, /^max-port=65535$/m);
  assert.match(turnConfig, /^max-allocate-lifetime=7200$/m);
  assert.doesNotMatch(turnConfig, /^max-bps=/m);
  assert.doesNotMatch(turnConfig, /^bps-capacity=/m);
});

test("standby routing signs the primary TURN instead of relaying media", () => {
  const deploy = source("deployment/deploy-standby-routing.sh");
  assert.match(
    deploy,
    /default_ice_servers_json='\[\{"urls":\["stun:43\.161\.195\.12:3478"\]\}\]'/,
  );
  assert.doesNotMatch(deploy, /stun:47\.98\.173\.139/);
  assert.doesNotMatch(deploy, /\$\{ICE_SERVERS_JSON:-\[\{/);
  assert.match(
    deploy,
    /turn:43\.161\.195\.12:3478\?transport=udp,turn:43\.161\.195\.12:3478\?transport=tcp/,
  );
  assert.doesNotMatch(deploy, /RELAY_SESSION_CAPACITY_BPS:-/);
  assert.match(deploy, /cp -a "\$backup" "\$signal_env"/);
  assert.match(deploy, /wait_for_signal/);
});
