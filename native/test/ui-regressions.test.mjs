import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("form primitives do not size label.field containers", () => {
  const primitives = fs.readFileSync(
    new URL("../src/design/primitives.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(primitives, /(?:^|\n)\.field\s*\{/);
  assert.match(primitives, /:is\(input, textarea, select\)\.field\s*\{/);
});

test("trusted app invites auto-join while unknown signal hosts still ask", () => {
  const source = fs.readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function confirmExternalInvite");
  const end = source.indexOf("function channelInitial", start);
  const confirmInvite = source.slice(start, end);
  const trustedReturn = confirmInvite.indexOf(
    "if (!untrusted) return { room: parsed.room, signalUrl };",
  );
  const confirmation = confirmInvite.indexOf("window.confirm(message)");
  assert.ok(trustedReturn >= 0);
  assert.ok(confirmation > trustedReturn);
  assert.match(confirmInvite, /requiresSignalTrust\(signalUrl\)/);
});

test("Android consumes duplicate cold-start invite events only once", () => {
  const source = fs.readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("let recentInviteKey");
  const end = source.indexOf(
    "const appUrlListener = await App.addListener",
    start,
  );
  const openInvite = source.slice(start, end);
  assert.match(openInvite, /parseJoinLink\(url\)/);
  assert.match(openInvite, /now - recentInviteAt < 10_000/);
  assert.match(openInvite, /return recentInviteHandled/);
  assert.match(openInvite, /recentInviteHandled = Boolean\(invite\)/);
  assert.equal(
    (openInvite.match(/void renderViewer\(/g) || []).length,
    1,
  );
});

test("the source chooser closes before capture startup can block", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const prepareStart = source.indexOf(
    "async function prepareLocalBroadcast(sourceId: string)",
  );
  const prepareEnd = source.indexOf(
    "function renderBroadcastSources",
    prepareStart,
  );
  const prepare = source.slice(prepareStart, prepareEnd);
  const selectionIndex = prepare.indexOf(
    "window.roomDesktop.selectSource(sourceId)",
  );
  const closeIndex = prepare.indexOf(
    "closeBroadcastDialog()",
    selectionIndex,
  );
  const captureIndex = prepare.indexOf(
    "await captureSelectedWindow(selection.id, preset)",
  );
  assert.ok(selectionIndex >= 0);
  assert.ok(closeIndex > selectionIndex);
  assert.ok(captureIndex > closeIndex);

  const sourceListStart = source.indexOf(
    '.querySelectorAll<HTMLButtonElement>("[data-session-source]")',
  );
  const sourceClickIndex = source.indexOf(
    'button.addEventListener("click", async () => {',
    sourceListStart,
  );
  const immediateCloseIndex = source.indexOf(
    "closeBroadcastDialog()",
    sourceClickIndex,
  );
  const prepareCallIndex = source.indexOf(
    "await prepareLocalBroadcast(button.dataset.sessionSource!)",
    sourceClickIndex,
  );
  assert.ok(sourceClickIndex >= 0);
  assert.ok(immediateCloseIndex > sourceClickIndex);
  assert.ok(prepareCallIndex > immediateCloseIndex);
});

test("late screen and Emby startup results cannot revive a cancelled broadcast", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /let broadcastPreparationEpoch = 0/);
  assert.match(
    source,
    /async function performLocalBroadcastCleanup[\s\S]*?broadcastPreparationEpoch \+= 1/,
  );
  assert.match(
    source,
    /async function prepareLocalBroadcast[\s\S]*?requireCurrentBroadcast\(\);[\s\S]*?captureSelectedWindow[\s\S]*?requireCurrentBroadcast\(\)/,
  );
  assert.match(
    source,
    /async function prepareEmbyBroadcast[\s\S]*?controller\.start\([\s\S]*?requireCurrentBroadcast\(\)/,
  );
  assert.match(
    source,
    /void firewallPromise\.then\(\(firewall\) => \{[\s\S]*?broadcastStillCurrent\(\)/,
  );
});

test("a muted legacy capture track follows the recreated fullscreen window", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const recoveryStart = source.indexOf(
    "async function recoverFullscreenCapture",
  );
  const recoveryEnd = source.indexOf(
    "function friendlyCaptureError",
    recoveryStart,
  );
  const recovery = source.slice(recoveryStart, recoveryEnd);
  assert.match(recovery, /captureSelectedWindow\(sourceId,\s*preset\)/);
  assert.match(recovery, /sender\.replaceTrack\(replacementTrack\)/);
  assert.match(
    recovery,
    /replacementResults = await Promise\.allSettled\(replacements\);[\s\S]{0,2200}?applyOutboundPreference\(viewerId,\s*peer\)/,
  );
  assert.match(recovery, /mediaStream\.addTrack\(replacementTrack\)/);
  assert.match(source, /track\.addEventListener\("mute"/);
  assert.match(
    recovery,
    /normalizeCaptureWindowGeometry\(sourceHealth\)/,
  );
  assert.match(
    recovery,
    /captureWindowGeometryChanged\([\s\S]{0,120}?captureSourceGeometry,[\s\S]{0,120}?nextGeometry/,
  );
  const replacementReady = recovery.slice(
    recovery.indexOf('replacementTrack.contentHint = "motion"'),
    recovery.indexOf("const previousDisplayStream"),
  );
  assert.doesNotMatch(
    replacementReady,
    /replacementTrack\s*\.applyConstraints/,
  );
});

test("the source chooser refreshes once on open and otherwise only on request", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const openStart = source.indexOf(
    "async function openBroadcastDialog(): Promise<void>",
  );
  const openEnd = source.indexOf(
    "function applyBandwidthRecommendation",
    openStart,
  );
  const open = source.slice(openStart, openEnd);
  assert.match(open, /await loadBroadcastSources\(\)/);
  assert.doesNotMatch(open, /setInterval|setTimeout/);
  assert.doesNotMatch(source, /broadcastSourceRefreshTimer/);
  assert.match(
    source,
    /#refresh-session-sources[\s\S]*?loadBroadcastSources\(\)/,
  );
});

test("closed dialogs cannot remain visible and broadcast grant closes the chooser", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /dialog:not\(\[open\]\)\s*\{[\s\S]*?display:\s*none/,
  );
  const grantedStart = source.indexOf(
    'message.type === "broadcast:granted"',
  );
  const grantedEnd = source.indexOf(
    'message.type === "broadcast:started"',
    grantedStart,
  );
  assert.match(
    source.slice(grantedStart, grantedEnd),
    /closeBroadcastDialog\(\)/,
  );
});

test("desktop viewers leave a channel for the home screen", () => {
  const source = fs.readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  const viewerSessionStart = source.indexOf("await openChannelSession({", source.indexOf("async function joinRoom"));
  const viewerSessionEnd = source.indexOf("});", viewerSessionStart);
  assert.match(
    source.slice(viewerSessionStart, viewerSessionEnd),
    /onLeave:\s*desktop\s*\?\s*renderDesktopHome/,
  );
});

test("movie sessions prefer SFU and retain P2P/TURN as an automatic fallback", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /directOnly:\s*true/);
  const wrapperStart = source.indexOf(
    "async function beginWatching(recreate = false)",
  );
  assert.ok(source.indexOf("beginSfuWatching()", wrapperStart) > wrapperStart);
  assert.ok(
    source.indexOf("beginP2PWatching(recreate)", wrapperStart) >
      source.indexOf("beginSfuWatching()", wrapperStart),
  );
  assert.match(source, /stripUnsafeIceCandidates\(/);
  assert.match(source, /stats\.relayed\s*\?\s*"腾讯云中继"\s*:\s*"P2P 直连"/);
  assert.doesNotMatch(
    source,
    /检测到中继候选，已主动断开|只允许 P2P 直连/,
  );
});

test("ambiguous playback dock controls expose visible hover help", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  for (const id of ["dock-danmaku", "dock-chat"]) {
    const buttonStart = source.lastIndexOf("<button", source.indexOf(`id=\"${id}\"`));
    const buttonEnd = source.indexOf(">", buttonStart);
    const button = source.slice(buttonStart, buttonEnd);
    assert.match(button, /title=/);
    assert.match(button, /data-tooltip=/);
  }
});

test("lobby panel collapse is quiet, releases its column, and keeps only useful dock actions", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  const toggleStart = source.indexOf(
    'panelToggle?.addEventListener("click"',
  );
  const toggleEnd = source.indexOf("});", toggleStart);
  assert.doesNotMatch(source.slice(toggleStart, toggleEnd), /notify\(/);
  assert.doesNotMatch(source, /id="dock-members"/);
  assert.match(
    styles,
    /body\.mode-lobby\.panel-collapsed \.session-shell\s*\{[\s\S]*?grid-template-columns:\s*var\(--rail-w\)\s*minmax\(0,\s*1fr\)\s*0/,
  );
});

test("requested visual cues remain explicit after the UI refactor", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const companion = fs.readFileSync(
    new URL("../src/room-companion.ts", import.meta.url),
    "utf8",
  );
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /id="session-invite" class="btn btn-secondary"/,
  );
  assert.doesNotMatch(source, /检测到 \$\{network\.virtualInterfaces/);
  assert.match(companion, /participant\.microphoneDisabled \|\| participant\.microphoneMuted[\s\S]*?"muted"/);
  assert.match(
    styles,
    /\.participant-mic\.muted\s*\{[\s\S]*?color:\s*var\(--danger-text\)/,
  );
  assert.match(styles, /\.danmaku\s*\{[\s\S]*?font-size:\s*clamp\(16px,/);
});

test("the emoji picker respects the chat maxlength during scripted insertion", () => {
  const companion = fs.readFileSync(
    new URL("../src/room-companion.ts", import.meta.url),
    "utf8",
  );
  const handlerStart = companion.indexOf(
    'emojiPanel?.addEventListener("click"',
  );
  const handlerEnd = companion.indexOf(
    "// Close emoji panel when clicking outside",
    handlerStart,
  );
  const handler = companion.slice(handlerStart, handlerEnd);
  assert.ok(handlerStart >= 0);
  assert.ok(handlerEnd > handlerStart);
  assert.match(companion, /const CHAT_MAX_LENGTH = 120/);
  assert.match(
    companion,
    /id="chat-input" maxlength="\$\{CHAT_MAX_LENGTH\}"/,
  );
  assert.match(handler, /const selectionEnd\s*=/);
  assert.match(handler, /chatInput\.value\.slice\(selectionEnd\)/);
  assert.match(
    handler,
    /chatInput\.maxLength > 0 && candidate\.length > chatInput\.maxLength/,
  );
  assert.match(handler, /chatInput\.value = candidate/);
});

test("desktop companion is voice-first while mobile stays a visible chat-first document flow", () => {
  const companion = fs.readFileSync(
    new URL("../src/room-companion.ts", import.meta.url),
    "utf8",
  );
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  const chatIndex = companion.indexOf(
    '<section class="chat-card" id="chat-panel"',
  );
  const membersIndex = companion.indexOf(
    '<section class="voice-card" id="member-panel"',
  );
  assert.ok(chatIndex >= 0);
  assert.ok(membersIndex > chatIndex);
  assert.match(
    styles,
    /\.room-sidebar\s*>\s*\.voice-card\s*\{[\s\S]*?grid-row:\s*1;/,
  );
  assert.match(
    styles,
    /\.room-sidebar\s*>\s*\.chat-card\s*\{[\s\S]*?grid-row:\s*2;/,
  );

  const mobileStart = styles.indexOf(
    "/* Handsets use one vertical document flow",
  );
  const mobileEnd = styles.indexOf(
    "@media (prefers-reduced-motion: reduce)",
    mobileStart,
  );
  const mobile = styles.slice(mobileStart, mobileEnd);
  assert.ok(mobileStart >= 0);
  assert.ok(mobileEnd > mobileStart);
  assert.match(mobile, /\.session-shell\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(
    mobile,
    /body:not\(\.mode-immersive\) \.room-sidebar\.companion-panel\s*\{[\s\S]*?position:\s*static;[\s\S]*?flex-direction:\s*column;[\s\S]*?transform:\s*none;/,
  );
  assert.match(
    mobile,
    /\.room-sidebar\.companion-panel > \.panel-toggle\s*\{[\s\S]*?display:\s*none !important;/,
  );
  assert.match(
    mobile,
    /\.room-sidebar\.companion-panel > \.chat-card\s*\{[\s\S]*?order:\s*1;[\s\S]*?min-height:\s*340px;/,
  );
  assert.match(
    mobile,
    /\.room-sidebar\.companion-panel > \.voice-card\s*\{[\s\S]*?order:\s*2;[\s\S]*?min-height:\s*300px;/,
  );
});

test("the desktop playback HUD yields space to the stop action without overlapping it", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.channel-header-actions\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?overflow:\s*hidden;/,
  );
  assert.match(
    styles,
    /\.header-broadcast-action\s*\{[\s\S]*?flex:\s*none;[\s\S]*?min-width:\s*112px;/,
  );
  assert.match(
    styles,
    /\.hud-bar\s*\{[\s\S]*?flex:\s*1 1 520px;[\s\S]*?overflow:\s*hidden;/,
  );
  assert.match(
    styles,
    /#hud-media\s*\{[\s\S]*?flex:\s*1 1 180px;[\s\S]*?overflow:\s*hidden;/,
  );
  assert.match(source, /label\.title = text;/);
  assert.match(
    source,
    /setAttribute\("aria-label", `播放状态：\$\{text\}`\)/,
  );
});

test("the Emby progress rail previews pointer scrubbing and commits only on release", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const progressRatioAt");
  const end = source.indexOf(
    'video?.addEventListener("play"',
    start,
  );
  const scrub = source.slice(start, end);
  assert.match(scrub, /setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(
    scrub,
    /addEventListener\("pointerup",[\s\S]*finishProgressScrub\(event, true\)/,
  );
  assert.match(
    scrub,
    /addEventListener\("pointercancel",[\s\S]*finishProgressScrub\(event, false\)/,
  );
  assert.match(scrub, /seekToPercent\(progressScrubRatio \* 100\)/);
  assert.match(scrub, /suppressProgressClick/);
});

test("the idle playback HUD is content-sized while active playback remains flexible", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /class="hud-bar glass-a is-idle"[\s\S]*?data-playback-state="idle"[\s\S]*?aria-label="连接与播放状态，当前无放映"/,
  );
  assert.match(
    source,
    /const playbackState = awaitingBroadcastGrant[\s\S]*?hudBar\.dataset\.playbackState = playbackState;[\s\S]*?hudBar\.classList\.toggle\("is-idle", playbackState === "idle"\)/,
  );
  assert.match(
    styles,
    /\.hud-bar\.is-idle\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?max-width:\s*min\(430px, 100%\);[\s\S]*?flex:\s*0 1 auto;/,
  );
  assert.match(
    styles,
    /\.hud-bar\.is-idle #hud-media\s*\{[\s\S]*?flex:\s*0 1 auto;/,
  );
});

test("mobile dock keeps fullscreen visible and reserves a safe quick-chat card", () => {
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  const mobileStart = styles.indexOf(
    "/* Keep the essential five actions visible",
  );
  const mobileEnd = styles.indexOf(
    "@media (prefers-reduced-motion: reduce)",
    mobileStart,
  );
  const mobile = styles.slice(mobileStart, mobileEnd);
  for (const id of [
    "dock-rewind",
    "dock-forward",
    "dock-quality",
    "dock-emby-settings",
    "dock-smart-crop",
    "dock-pip",
  ]) {
    assert.match(mobile, new RegExp(`#${id}`));
  }
  assert.match(mobile, /\.dock\s*\{[\s\S]*?overflow:\s*visible;/);
  assert.match(
    mobile,
    /#dock-fullscreen\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/,
  );
  assert.match(
    styles,
    /\.dock-chat-composer\s*\{[\s\S]*?width:\s*min\([\s\S]*?360px,[\s\S]*?env\(safe-area-inset-left\)[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto\s*auto;/,
  );
  assert.match(
    styles,
    /\.dock-chat-composer\[hidden\]\s*\{[\s\S]*?display:\s*none;/,
  );
  assert.match(
    styles,
    /\.dock-chat-input\s*\{[\s\S]*?min-height:\s*44px;/,
  );
  assert.match(
    styles,
    /\.dock-chat-send\s*\{[\s\S]*?min-height:\s*44px;/,
  );
  assert.match(
    styles,
    /\.dock-chat-close\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/,
  );
});

test("all chat composers share RoomCompanion send validation", () => {
  const companion = fs.readFileSync(
    new URL("../src/room-companion.ts", import.meta.url),
    "utf8",
  );
  const methodStart = companion.indexOf("sendChat(rawText: string): boolean");
  const methodEnd = companion.indexOf("async destroy()", methodStart);
  const method = companion.slice(methodStart, methodEnd);
  const submitStart = companion.indexOf(
    '.querySelector<HTMLFormElement>("#chat-form")',
  );
  const submitEnd = companion.indexOf(
    "void this.refreshVoiceDevices()",
    submitStart,
  );
  const submit = companion.slice(submitStart, submitEnd);
  assert.ok(methodStart >= 0);
  assert.ok(methodEnd > methodStart);
  assert.match(method, /const text = rawText\.trim\(\)/);
  assert.match(method, /text\.length > CHAT_MAX_LENGTH/);
  assert.match(method, /this\.signal\.send\(\{ type: "chat:send", text \}\)/);
  assert.match(method, /弹幕发送失败，服务器连接可能已断开/);
  assert.match(submit, /this\.sendChat\(input\?\.value \|\| ""\)/);
  assert.doesNotMatch(submit, /this\.signal\.send/);
});

test("Emby UI exposes saved accounts, switching, and unified search", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /id="emby-saved-account-list"/);
  assert.match(source, /id="emby-account-switch"/);
  assert.match(source, /id="emby-add-account"/);
  assert.match(source, /\.embySearchAll\(commonQuery\)/);
  assert.match(source, /Windows 系统加密后保留在本机/);
});

test("Emby account recovery is bounded, race-safe, and always restores its start action", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const refreshStart = source.indexOf(
    "async function refreshEmbyAccounts",
  );
  const refreshEnd = source.indexOf(
    "async function activateEmbyAccount",
    refreshStart,
  );
  const refresh = source.slice(refreshStart, refreshEnd);
  assert.match(refresh, /\+\+embyAccountRefreshRequestId/);
  assert.match(refresh, /4_000/);
  assert.match(refresh, /登录凭证仍保留/);

  const addStart = source.indexOf("function beginAddingEmbyAccount");
  const addEnd = source.indexOf("async function loginEmby", addStart);
  assert.doesNotMatch(
    source.slice(addStart, addEnd),
    /embyLogin\s*=\s*undefined/,
  );

  const prepareStart = source.indexOf(
    "async function prepareEmbyBroadcast",
  );
  const prepareEnd = source.indexOf(
    "function hostControlsEmby",
    prepareStart,
  );
  const prepare = source.slice(prepareStart, prepareEnd);
  assert.match(prepare, /finally\s*\{[\s\S]*?restoreStartButton/);
  assert.match(prepare, /重试恢复 Emby 账户/);
});

test("Emby auto quality bounds incompatible HEVC/HDR sources and library searches", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const autoStart = source.indexOf("function automaticEmbyQuality");
  const autoEnd = source.indexOf("function budgetSafeQuality", autoStart);
  const automatic = source.slice(autoStart, autoEnd);
  assert.match(automatic, /embySourceCanUseOriginal\(source,\s*allowHevc\)/);
  assert.match(automatic, /return "1080p-12"/);
  assert.match(source, /"1440p-18"/);
  assert.doesNotMatch(automatic, /return "4k-(?:12|18)"/);
  const budgetEnd = source.indexOf("function updateEmbyBudget", autoEnd);
  const budgetSafe = source.slice(autoEnd, budgetEnd);
  assert.match(
    budgetSafe,
    /if \(requested === "auto"\) return automaticEmbyQuality\(allowHevc\)/,
  );
  assert.match(
    budgetSafe,
    /Network measurements are recommendations for Auto[\s\S]*?return requested/,
  );
  assert.doesNotMatch(
    budgetSafe,
    /embyQualityBitrate\(requested,\s*source\)\s*<=\s*available/,
  );
  assert.match(source, /原始媒体需要高负载兼容转换/);
  assert.match(
    source,
    /Math\.min\([\s\S]*?measuredHostMediaPerViewer[\s\S]*?roomMediaPerViewer/,
  );
  assert.match(source, /function embyUplinkCount[\s\S]*?sfuSession\.publishing/);
  assert.match(source, /服务器不设置带宽上限/);
  assert.doesNotMatch(source, /EMBY_TOTAL_UPLINK_BUDGET/);
  const browseStart = source.indexOf("async function loadEmbyItems");
  const browseEnd = source.indexOf("function selectedEmbyMediaSource", browseStart);
  assert.match(
    source.slice(browseStart, browseEnd),
    /boundedUiOperation\([\s\S]*?10_000/,
  );
});

test("Android screen sharing uses a dedicated self-healing movie audio element", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /id="channel-movie-audio"\s+autoplay\s+playsinline/);
  assert.match(
    source,
    /async function playNativeMovieAudio[\s\S]*?new MediaStream\(liveTracks\)[\s\S]*?await movieAudio\.play\(\)/,
  );
  assert.match(
    source,
    /video\.muted = nativeAndroid \? true : !soundEnabled/,
  );
  const volumeStart = source.indexOf("function applyMovieVolume");
  const volumeEnd = source.indexOf(
    "function updateEmbyViewerTimeline",
    volumeStart,
  );
  assert.match(
    source.slice(volumeStart, volumeEnd),
    /movieVolume <= 0 \|\|[\s\S]*?nativeAndroid && broadcastCapabilities\?\.mode !== "emby"/,
  );
  const capabilitiesStart = source.indexOf(
    "function setBroadcastCapabilities",
  );
  const capabilitiesEnd = source.indexOf(
    "function syncPlayerAspect",
    capabilitiesStart,
  );
  assert.match(
    source.slice(capabilitiesStart, capabilitiesEnd),
    /broadcastCapabilities[\s\S]*?broadcasterId !== selfId[\s\S]*?applyMovieVolume\(movieVolume, false\)/,
  );
  assert.match(source, /totalAudioEnergy/);
  assert.match(source, /totalSamplesDuration/);
});

test("Emby frame rate and shared viewer quality requests have a real debounced pipeline path", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /id="emby-frame-rate"/);
  assert.match(source, /id="emby-live-frame-rate"/);
  assert.match(
    source,
    /frameRate:\s*Math\.max\(1,\s*detail\.plan\.frameRate\)/,
  );
  assert.match(
    source,
    /function scheduleEmbyViewerPreference[\s\S]*?setPlaybackProfile[\s\S]*?}, 450\)/,
  );
  assert.match(
    source,
    /message\.type === "quality:request"[\s\S]*?scheduleEmbyViewerPreference/,
  );
  const sharedStart = source.indexOf("function sharedEmbyViewerPreference");
  const sharedEnd = source.indexOf("function embyViewerCount", sharedStart);
  const shared = source.slice(sharedStart, sharedEnd);
  assert.match(shared, /Math\.floor\(heights\.length \/ 2\)/);
  assert.doesNotMatch(shared, /Math\.min\(\.\.\.heights\)/);
  assert.match(
    source,
    /requiredAffectedViewers[\s\S]*?activePressures\.length < requiredAffectedViewers/,
  );
});

test("network probing follows channel membership instead of broadcast dialog clicks", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const dialogStart = source.indexOf("async function openBroadcastDialog");
  const dialogEnd = source.indexOf("function syncBroadcastQualityUi", dialogStart);
  assert.doesNotMatch(
    source.slice(dialogStart, dialogEnd),
    /refreshNetworkReport/,
  );
  assert.match(
    source,
    /message\.type === "participant:joined"[\s\S]*?previousParticipantCount[\s\S]*?scheduleMembershipNetworkProbe\(\)/,
  );
});

test("watch recovery is bounded and timer callbacks use safe signaling", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /MAX_WATCH_RECOVERY_CYCLES = 10/);
  assert.match(
    source,
    /watchRecoveryCycles >= MAX_WATCH_RECOVERY_CYCLES/,
  );
  assert.match(source, /watchAttempts === 1 \? 25_000 : 15_000/);
  assert.match(
    source,
    /connectionState === "connected"[\s\S]*?clearDisconnectGrace\(\)/,
  );
  assert.match(
    source,
    /function clearDisconnectGrace[\s\S]*?disconnectGraceTimer[\s\S]*?disconnectReplaceTimer/,
  );
  assert.match(source, /function safeSignalSend\(message: SignalEnvelope\)/);
  assert.doesNotMatch(source, /signal\?\.send\(/);
  assert.doesNotMatch(source, /\bsignal\.send\(/);
  assert.match(source, /replacementResults = await Promise\.allSettled/);
  assert.match(source, /capture-track-replace-partial-failure/);
  assert.match(source, /const MAX_PENDING_MEDIA_ICE_CANDIDATES = 64/);
  assert.match(source, /const MAX_PENDING_WATCHER_SIGNALS = 96/);
  assert.match(source, /function queuePendingMediaCandidate/);
  assert.match(source, /function queuePendingWatcherSignal/);
  assert.doesNotMatch(source, /watcherCandidates\.push\(/);
  assert.doesNotMatch(source, /peer\.candidates\.push\(/);
  assert.match(
    source,
    /receiverPreferences\.size === 0[\s\S]*?clearTimeout\(embyViewerPreferenceTimer\)/,
  );
});

test("stopping or failing a broadcast preserves the active Emby library session", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const cleanupStart = source.indexOf(
    "async function performLocalBroadcastCleanup()",
  );
  const cleanupEnd = source.indexOf(
    "async function stopBroadcast",
    cleanupStart,
  );
  const cleanup = source.slice(cleanupStart, cleanupEnd);
  assert.doesNotMatch(cleanup, /embyLogin\s*=\s*undefined/);
  assert.doesNotMatch(cleanup, /embySelectedItem\s*=\s*undefined/);
  assert.match(cleanup, /embyPlaybackInfo\s*=\s*undefined/);

  const logoutStart = source.indexOf("async function logoutEmby()");
  const logoutEnd = source.indexOf(
    "async function loadEmbyLibraries",
    logoutStart,
  );
  assert.match(
    source.slice(logoutStart, logoutEnd),
    /embyLogin\s*=\s*undefined/,
  );
});

test("a late failed Emby activation A cannot overwrite newer activation B", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function activateEmbyAccount");
  const end = source.indexOf("function beginAddingEmbyAccount", start);
  const activation = source.slice(start, end);
  assert.match(activation, /const activationRequestId\s*=\s*\+\+embyActivationRequestId/);
  assert.match(
    activation,
    /const account = await activation;[\s\S]*?if \(activationRequestId !== embyActivationRequestId\) return false;/,
  );
  assert.match(
    activation,
    /catch \(error\) \{\s*if \(activationRequestId !== embyActivationRequestId\) return false;/,
    "the stale A rejection must return before mutating B's status UI",
  );
});

test("optional network telemetry is gated for legacy signaling services", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /!signalFeatures\.has\("network-probe"\)[\s\S]*?!signalFeatures\.has\("network-report"\)/,
  );
  assert.match(
    source,
    /messageText === "不支持的操作"[\s\S]*?setSignalStatus\("connected", "已连接 · 兼容模式"\)/,
  );
});

test("successful broadcast recovery clears the reconnecting HUD state", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const statusStart = source.indexOf("function setStatus");
  const statusEnd = source.indexOf(
    "function clearSignalReconnectTimer",
    statusStart,
  );
  const statusRouter = source.slice(statusStart, statusEnd);
  assert.match(
    statusRouter,
    /tone === "ready"\s*\?\s*"connected"/,
    "ready recovery messages must render as connected, not reconnecting",
  );

  const grantStart = source.indexOf(
    'message.type === "broadcast:granted"',
  );
  const grantEnd = source.indexOf(
    'message.type === "broadcast:started"',
    grantStart,
  );
  const grantHandler = source.slice(grantStart, grantEnd);
  assert.match(
    grantHandler,
    /setSignalStatus\("connected", "已连接"\)/,
    "the server grant must clear the pending recovery label",
  );
});

test("nested Emby and network headers keep their component layout", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  const enhancements = fs.readFileSync(
    new URL("../src/styles-visual-enhancements.css", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /data-add-emby-endpoint class="ghost-button emby-endpoint-add"/,
  );
  assert.match(styles, /\.source-dialog\s*>\s*header\s*\{/);
  assert.match(styles, /\.source-dialog\s*>\s*header button\s*,/);
  assert.doesNotMatch(styles, /\.source-dialog header\s*\{/);
  assert.doesNotMatch(styles, /\.source-dialog header button\s*,/);
  assert.match(enhancements, /dialog\s*>\s*header\s*\{/);
  assert.doesNotMatch(enhancements, /(?:^|\n)dialog header\s*\{/);
  assert.match(
    styles,
    /\.broadcast-network-card\s*>\s*header\s*\{[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;/,
  );
  assert.match(
    styles,
    /\.emby-endpoint-editor\s*>\s*header \.emby-endpoint-add\s*\{[\s\S]*?width:\s*auto;[\s\S]*?white-space:\s*nowrap;/,
  );
});

test("Emby detail controls and danmaku input stay inside their surfaces", () => {
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.emby-item-popup-dialog\s*\{[\s\S]*?overflow-x:\s*hidden;/,
  );
  assert.match(
    styles,
    /\.emby-popup-options \.emby-stream-options\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
  );
  assert.match(
    styles,
    /\.emby-popup-options \.emby-stream-options select\s*\{[\s\S]*?min-width:\s*0;/,
  );
  assert.match(
    styles,
    /\.chat-form input\s*\{[\s\S]*?border:\s*1px solid rgba\(154,\s*173,\s*197,\s*0\.24\)/,
  );
  assert.match(
    styles,
    /\.chat-form input:focus\s*\{[\s\S]*?border-color:\s*rgba\(129,\s*140,\s*248,\s*0\.72\)/,
  );
});

test("playback chrome stays centered on the video and removes redundant badges", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /id="local-stage-badge"/);
  assert.doesNotMatch(source, /id="audio-route-badge"/);
  assert.doesNotMatch(source, /LIVE · 你的本地预览/);
  assert.match(source, /class="dock-cluster dock-transport"/);
  assert.match(source, /class="dock-cluster dock-audio"/);
  assert.match(source, /class="dock-cluster dock-social"/);
  assert.match(source, /class="dock-cluster dock-view"/);
  assert.match(
    styles,
    /\.dock\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*50%;/,
  );
  assert.match(
    styles,
    /\.progress-rail\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*50%;/,
  );
  assert.match(
    styles,
    /\.dock \.btn-icon\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/,
  );
});

test("broadcast mode transition is interruptible and obsolete source guidance is gone", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(source, /class="broadcast-mode-glider"/);
  assert.match(source, /data-active-mode="screen"/);
  assert.doesNotMatch(source, /id="hdr-display-summary"/);
  assert.doesNotMatch(source, /id="open-display-settings"/);
  assert.doesNotMatch(
    source,
    /选择正在播放影片的窗口；已最小化的窗口可能不会被 Windows 提供/,
  );
  assert.match(source, /for \(const animation of broadcastModeAnimations\) animation\.cancel\(\)/);
  assert.match(source, /prefers-reduced-motion:\s*reduce/);
  assert.match(source, /incoming\.animate\(/);
  assert.match(
    styles,
    /\.broadcast-mode-glider\s*\{[\s\S]*?transition:[\s\S]*?transform 440ms/,
  );
  assert.match(
    styles,
    /\.broadcast-mode-panel\s*\{[\s\S]*?overflow-y:\s*auto;/,
  );
});

test("danmaku composer reserves a readable field and 44px touch targets", () => {
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.chat-form\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto;/,
  );
  assert.match(
    styles,
    /\.chat-form input\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?padding:\s*0 44px 0 13px;/,
  );
  assert.match(
    styles,
    /\.chat-form\s*>\s*\.chat-emoji-btn\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/,
  );
  assert.match(
    styles,
    /\.chat-form\s*>\s*\.chat-send-btn\s*\{[\s\S]*?min-height:\s*44px;/,
  );
});

test("the cursor glow remains a compact local accent", () => {
  const main = fs.readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  const enhancements = fs.readFileSync(
    new URL("../src/styles-visual-enhancements.css", import.meta.url),
    "utf8",
  );
  assert.match(
    enhancements,
    /#cursor-glow\s*\{[\s\S]*?width:\s*220px;[\s\S]*?height:\s*220px;/,
  );
  assert.match(
    main,
    /translate\(\$\{cx - 110\}px,\s*\$\{cy - 110\}px\)/,
  );
});

test("server-provided Emby labels are escaped and strict CSP has no inline styles", () => {
  const session = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const music = fs.readFileSync(
    new URL("../src/channel-music.ts", import.meta.url),
    "utf8",
  );
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  const activeAudioStart = session.indexOf("liveAudio.innerHTML");
  const activeSubtitleStart = session.indexOf(
    "liveSub.innerHTML",
    activeAudioStart,
  );
  const activeSelectionEnd = session.indexOf(
    "function updateLiveEmbyQualityLabel",
    activeSubtitleStart,
  );
  assert.match(
    session.slice(activeAudioStart, activeSubtitleStart),
    /escapeHtml\([\s\S]*?s\.title/,
  );
  assert.match(
    session.slice(activeSubtitleStart, activeSelectionEnd),
    /escapeHtml\([\s\S]*?s\.title/,
  );
  assert.doesNotMatch(`${session}\n${music}`, /\sstyle=(?:"|')/);
  assert.match(session, /data-emby-progress="\$\{progress\}"/);
  assert.match(styles, /width:\s*var\(--emby-progress,\s*0%\)/);
  assert.match(music, /music-app-mark-\$\{preset\.key\}/);
});

test("every bottom-right notification leaves after five seconds", () => {
  const source = fs.readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /window\.setTimeout\(\(\)\s*=>\s*removeToast\(element\),\s*5_000\)/,
  );
  assert.doesNotMatch(source, /tone === "danger"\s*\?\s*0/);
});

test("the rail identity is static, the room moves to the top, and the profile renames", () => {
  const main = fs.readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  const session = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  assert.match(main, /class="rail-logo rail-identity" role="img"/);
  assert.doesNotMatch(main, /data-home-button/);
  assert.match(session, /id="session-room-identity"[\s\S]*?class="active-room-pill rail-current"/);
  assert.doesNotMatch(session, /id="session-home"/);
  assert.match(
    session,
    /id="session-profile"[\s\S]*?class="profile-orb profile-action"/,
  );
  assert.match(session, /type:\s*"participant:rename",\s*nickname/);
  assert.match(session, /saveNickname\(requested\)/);
});

test("Bluff opens from the channel-only game center in a sandboxed application view", () => {
  const game = fs.readFileSync(
    new URL("../src/embedded-game.ts", import.meta.url),
    "utf8",
  );
  const main = fs.readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  const session = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const electronMain = fs.readFileSync(
    new URL("../electron/main.cjs", import.meta.url),
    "utf8",
  );
  const preload = fs.readFileSync(
    new URL("../electron/preload.cjs", import.meta.url),
    "utf8",
  );
  assert.match(game, /https:\/\/bluff\.synced\.com\.cn\//);
  assert.match(game, /const GAME_NAME = "吹牛"/);
  assert.match(game, /data-game-button/);
  assert.match(game, /data-game-center/);
  assert.match(game, /data-game-launch="bluff"/);
  const railMarkup = game.slice(
    game.indexOf("export function embeddedGameRailButtonMarkup"),
    game.indexOf("function setGameStatus"),
  );
  assert.match(railMarkup, /<svg viewBox="0 0 24 24"/);
  assert.doesNotMatch(railMarkup, /bluffCardMark/);
  assert.doesNotMatch(main, /embeddedGameRailButtonMarkup/);
  assert.match(session, /embeddedGameRailButtonMarkup\(\)/);
  assert.doesNotMatch(game, /window\.open|<iframe|<webview/);
  assert.match(electronMain, /new WebContentsView\(/);
  assert.match(electronMain, /partition:\s*"persist:yiqikan-bluff"/);
  assert.match(electronMain, /contextIsolation:\s*true/);
  assert.match(electronMain, /nodeIntegration:\s*false/);
  assert.match(electronMain, /sandbox:\s*true/);
  assert.match(electronMain, /new URL\(value\)\.origin === GAME_ORIGIN/);
  assert.match(preload, /gameViewOpen:/);
  assert.match(preload, /gameViewHide:/);
});

test("channel music captures an app, mixes stereo audio, and auto-connects listeners", () => {
  const music = fs.readFileSync(
    new URL("../src/channel-music.ts", import.meta.url),
    "utf8",
  );
  const voice = fs.readFileSync(
    new URL("../src/voice.ts", import.meta.url),
    "utf8",
  );
  const session = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = fs.readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(music, /new ProcessAudioCapture\(\)/);
  assert.match(music, /setAccompanimentTrack/);
  assert.match(music, /data-music-more/);
  assert.match(music, /Windows 读取应用窗口超时/);
  assert.match(music, /source\.processName/);
  assert.match(music, /source\.executableName/);
  assert.match(music, /cloudmusic/);
  assert.match(
    music,
    /listSources\(\{\s*thumbnails:\s*false,\s*audioProcesses:\s*true,\s*\}\)/,
  );
  assert.match(
    styles,
    /\.music-source-popover\s*\{[\s\S]*?width:\s*min\(304px,[\s\S]*?backdrop-filter:\s*blur\(30px\)/,
  );
  assert.match(
    styles,
    /\.music-help\s*\{[\s\S]*?flex:\s*0 0 19px[\s\S]*?border-radius:\s*50%/,
  );
  assert.match(voice, /listenForSharedAudio/);
  assert.match(voice, /direction:\s*"recvonly"/);
  assert.match(voice, /source\.connect\(gain\)\.connect\(graph\.mixLimiter\)/);
  assert.match(session, /type:\s*"voice:music"/);
});

test("voice boost outputs directly instead of routing through a silent destination stream", () => {
  const voice = fs.readFileSync(
    new URL("../src/voice.ts", import.meta.url),
    "utf8",
  );
  const start = voice.indexOf(
    "private async enableBoostedPlayback",
  );
  const end = voice.indexOf(
    "private fallbackToDirectPlayback",
    start,
  );
  const boost = voice.slice(start, end);
  assert.match(
    boost,
    /source\.connect\(gain\)\.connect\(limiter\)\.connect\(context\.destination\)/,
  );
  assert.doesNotMatch(boost, /createMediaStreamDestination/);
  assert.match(boost, /audio\.muted = true/);
});

test("WebRTC operations and stats polling cannot wedge the signaling queue", () => {
  const session = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );

  assert.match(session, /const RTC_NEGOTIATION_TIMEOUT_MS = 8_000/);
  assert.match(session, /const RTC_CANDIDATE_TIMEOUT_MS = 2_000/);
  assert.match(session, /const RTC_STATS_TIMEOUT_MS = 2_500/);
  assert.match(session, /const RTC_TRACK_REPLACE_TIMEOUT_MS = 5_000/);
  assert.match(session, /function boundedRtcOperation/);
  assert.match(session, /viewerStatsPollRunning/);
  assert.match(session, /outboundStatsPollRunning/);
  assert.match(
    session,
    /readDataChannelStats[\s\S]*?watcherPc !== peer \|\| embyViewer !== player/,
  );
  assert.match(
    session,
    /readInboundVideoStats[\s\S]*?watcherPc !== peer \|\| sfuViewerActive/,
  );
  assert.match(
    session,
    /readOutboundVideoStats[\s\S]*?RTC_STATS_TIMEOUT_MS/,
  );
  assert.match(
    session,
    /sender\.replaceTrack\(replacementTrack\)[\s\S]*?RTC_TRACK_REPLACE_TIMEOUT_MS/,
  );
  assert.match(
    session,
    /peer\.pc\.createOffer\(\)[\s\S]*?创建 P2P offer 超时/,
  );
  assert.match(
    session,
    /peer\.pc\.getStats\(\)[\s\S]*?读取屏幕发送编码统计超时[\s\S]*?RTC_STATS_TIMEOUT_MS/,
  );
  assert.match(
    session,
    /首帧 WebRTC 诊断超时[\s\S]*?RTC_STATS_TIMEOUT_MS/,
  );
  assert.match(session, /desktopNetworkPollRunning/);
});
