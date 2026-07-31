import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readStyles() {
  const entryUrl = new URL("../src/styles.css", import.meta.url);
  const entry = fs.readFileSync(entryUrl, "utf8");
  const imports = [...entry.matchAll(/@import\s+"([^"]+)"/g)].map(
    ([, path]) => fs.readFileSync(new URL(path, entryUrl), "utf8"),
  );
  return [entry, ...imports].join("\n");
}

test("form primitives do not size label.field containers", () => {
  const primitives = fs.readFileSync(
    new URL("../src/design/primitives.css", import.meta.url),
    "utf8",
  );
  const fieldGroup = primitives.slice(
    primitives.indexOf(".field,"),
    primitives.indexOf("}", primitives.indexOf(".field,")),
  );
  assert.doesNotMatch(
    fieldGroup,
    /^\s*(?:width|min-height|height)\s*:/m,
  );
  assert.match(primitives, /:is\(input, select, textarea\)\.field\s*,/);
  assert.match(
    primitives,
    /label:has\(> input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)\)/,
  );
  assert.match(
    primitives,
    /label > :is\(input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\), select, textarea\)/,
  );
});

test("screen-share receivers mask only legacy decoder padding", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = readStyles();
  const guardStart = source.indexOf("function syncDecoderEdgeGuard");
  const guardEnd = source.indexOf("\n  function", guardStart + 1);
  const guard = source.slice(guardStart, guardEnd);

  assert.ok(guardStart >= 0);
  assert.match(guard, /broadcastCapabilities\?\.mode === "screen"/);
  assert.match(guard, /localBroadcastMode === "screen"/);
  assert.match(guard, /decoderEdgeGuardPixels\(video\.videoWidth\)/);
  assert.match(guard, /guardPercent = \(inlineGuard \/ video\.videoWidth\) \* 100/);
  assert.match(guard, /classList\.toggle\("decoder-edge-guard", inlineGuard > 0\)/);
  assert.match(styles, /\.viewer-stage > video\.decoder-edge-guard/);
  assert.match(
    styles,
    /clip-path:\s*inset\([\s\S]*var\(--decoder-edge-guard-inline, 0%\)/,
  );
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
  const confirmation = confirmInvite.indexOf(
    "await requestSignalTrust(signalUrl, parsed.room)",
  );
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
  assert.match(
    openInvite,
    /return recentInvitePromise \|\| recentInviteHandled/,
  );
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
  const sourceListEnd = source.indexOf(
    "updateSelectedSourceSummary();",
    sourceListStart,
  );
  const sourceSelection = source.slice(sourceListStart, sourceListEnd);
  assert.match(
    sourceSelection,
    /selectedBroadcastSourceId = button\.dataset\.sessionSource \|\| ""/,
  );
  assert.doesNotMatch(sourceSelection, /prepareLocalBroadcast|closeBroadcastDialog/);

  const explicitStartIndex = source.indexOf(
    '.querySelector("#start-screen-broadcast")',
  );
  const explicitStart = source.slice(
    explicitStartIndex,
    source.indexOf(
      '.querySelectorAll<HTMLButtonElement>("[data-broadcast-mode]")',
      explicitStartIndex,
    ),
  );
  assert.ok(
    explicitStart.indexOf("closeBroadcastDialog()") <
      explicitStart.indexOf("await prepareLocalBroadcast(source.id)"),
  );
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
  const styles = readStyles();
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
  const viewerSessionStart = source.indexOf(
    "await openSession({",
    source.indexOf("async function joinRoom"),
  );
  const viewerSessionEnd = source.indexOf("});", viewerSessionStart);
  assert.match(
    source.slice(viewerSessionStart, viewerSessionEnd),
    /onLeave:[\s\S]*?if \(desktop\) renderDesktopHome\(\)/,
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
  const styles = readStyles();
  assert.doesNotMatch(source, /id="panel-toggle"/);
  assert.doesNotMatch(source, /id="dock-members"/);
  assert.match(
    source,
    /id="session-companion"[\s\S]*?aria-controls="room-companion-panel"[\s\S]*?aria-expanded="true"/,
  );
  assert.match(
    source,
    /document[\s\S]*?#session-companion[\s\S]*?addEventListener\("click"[\s\S]*?applyPanelState\(collapse\)/,
  );
  assert.doesNotMatch(source, /任意 Windows 成员可放映/);
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
  const styles = readStyles();
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
    "const deviceButton",
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

test("companion restores simultaneous members and danmaku cards", () => {
  const companion = fs.readFileSync(
    new URL("../src/room-companion.ts", import.meta.url),
    "utf8",
  );
  const styles = readStyles();
  assert.match(companion, /class="chat-card" id="chat-panel"/);
  assert.match(companion, /class="voice-card" id="member-panel"/);
  assert.doesNotMatch(companion, /role="tablist"|data-companion-tab/);
  assert.doesNotMatch(companion, /class="voice-control-bar"/);
  assert.match(
    styles,
    /\.room-sidebar\.companion-panel\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1\.7fr\) minmax\(220px,\s*1fr\)/,
  );
  assert.match(
    styles,
    /\.room-sidebar\.companion-panel > \.voice-card\s*\{[\s\S]*?grid-row:\s*1/,
  );
  assert.match(
    styles,
    /@media \(max-width:\s*899px\)[\s\S]*?position:\s*static;[\s\S]*?> \.chat-card\s*\{[\s\S]*?order:\s*1;[\s\S]*?> \.voice-card\s*\{[\s\S]*?order:\s*2;/,
  );
});

test("the desktop playback HUD yields space to the stop action without overlapping it", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = readStyles();
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
  const styles = readStyles();
  assert.match(
    source,
    /class="hud-bar session-status-line is-idle"[\s\S]*?data-playback-state="idle"[\s\S]*?aria-label="连接与播放状态，当前无放映"/,
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

test("mobile dock keeps every supported action touch-reachable", () => {
  const styles = readStyles();
  const mobileStart = styles.indexOf(
    "/* Every action exposed by runtime capability checks",
  );
  const mobileEnd = styles.indexOf(
    "@media (prefers-reduced-motion: reduce)",
    mobileStart,
  );
  const mobile = styles.slice(mobileStart, mobileEnd);
  assert.ok(mobileStart > 0);
  assert.doesNotMatch(
    mobile,
    /#dock-(?:rewind|forward|quality|emby-settings|smart-crop|pip)[\s\S]{0,120}?display:\s*none/,
  );
  assert.match(mobile, /\.dock\s*\{[\s\S]*?overflow-x:\s*auto;/);
  assert.match(mobile, /overflow-y:\s*hidden/);
  assert.match(mobile, /touch-action:\s*pan-x/);
  assert.match(
    mobile,
    /\.dock \.btn,[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;[\s\S]*?pointer-events:\s*auto;/,
  );
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
  const settings = fs.readFileSync(
    new URL("../src/ui/settings-controller.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /class="emby-library-nav"/);
  assert.match(source, /data-emby-nav-mode="favorite"/);
  assert.match(source, /id="emby-account-switch"/);
  assert.match(source, /id="emby-open-settings"/);
  assert.match(source, /\.embySearchAll\(commonQuery\)/);
  assert.match(settings, /id="settings-emby-accounts"/);
  assert.match(settings, /Windows 安全存储/);
  assert.match(settings, /data-emby-action="remove"/);
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

test("Emby auto quality follows source compatibility and never network probes", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const autoStart = source.indexOf("function automaticEmbyQuality");
  const autoEnd = source.indexOf("function budgetSafeQuality", autoStart);
  const automatic = source.slice(autoStart, autoEnd);
  assert.match(automatic, /embySourceCanUseOriginal\(source,\s*allowHevc\)/);
  assert.match(automatic, /return "1080p-12"/);
  assert.match(automatic, /height >= 2_160[\s\S]*?return "4k-18"/);
  assert.match(automatic, /height >= 1_440[\s\S]*?return "1440p-18"/);
  assert.doesNotMatch(automatic, /embyBudget\(|networkReport|networkAdvice|available/);
  const budgetEnd = source.indexOf("function updateEmbyBudget", autoEnd);
  const budgetSafe = source.slice(autoEnd, budgetEnd);
  assert.match(
    budgetSafe,
    /if \(requested === "auto"\) return automaticEmbyQuality\(allowHevc\)/,
  );
  assert.match(
    budgetSafe,
    /Network measurements are[\s\S]*?diagnostics only[\s\S]*?return requested/,
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

test("Emby viewer preferences stay per-viewer and cannot rebuild the host-selected stream", () => {
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
  const viewerPreferenceStart = source.indexOf(
    "function scheduleEmbyViewerPreference",
  );
  const viewerPreferenceEnd = source.indexOf(
    "function handleEmbyNetworkPressure",
    viewerPreferenceStart,
  );
  const viewerPreference = source.slice(
    viewerPreferenceStart,
    viewerPreferenceEnd,
  );
  assert.match(viewerPreference, /receiverPreferences\.set\(viewerId, preference\)/);
  assert.match(viewerPreference, /updateEmbySegmentRenditionDemand\(\)/);
  assert.doesNotMatch(viewerPreference, /setPlaybackProfile|setQuality/);
  assert.match(
    source,
    /message\.type === "quality:request"[\s\S]*?scheduleEmbyViewerPreference/,
  );
  assert.doesNotMatch(source, /sharedEmbyViewerPreference|pressureSafeEmbyQuality/);
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
  assert.doesNotMatch(source, /embyViewerPreferenceTimer/);
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
  const styles = readStyles();
  const enhancements = styles;
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
  const styles = readStyles();
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
    /\.emby-popup-options \.emby-stream-options select\s*\{[\s\S]*?appearance:\s*none;[\s\S]*?background:\s*var\(--surface-1\)/,
  );
  assert.match(
    styles,
    /#dock-danmaku\[aria-pressed="true"\]\s*\{[\s\S]*?background:\s*var\(--accent-bg\);[\s\S]*?color:\s*var\(--accent-text\)/,
  );
  assert.doesNotMatch(
    styles,
    /#dock-danmaku(?:\[aria-pressed="true"\])?::after/,
  );
  assert.match(
    styles,
    /\.room-sidebar\.companion-panel \.chat-form input\s*\{[\s\S]*?border:\s*1px solid var\(--stroke-default\)/,
  );
  assert.match(
    styles,
    /\.room-sidebar\.companion-panel \.chat-form input:focus\s*\{[\s\S]*?border-color:\s*var\(--accent-border\)/,
  );
});

test("Emby artwork, playback chrome, and modal states stay visually coherent", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const player = fs.readFileSync(
    new URL("../src/emby-player.ts", import.meta.url),
    "utf8",
  );
  const icons = fs.readFileSync(
    new URL("../src/ui/icons.ts", import.meta.url),
    "utf8",
  );
  const embyStyles = fs.readFileSync(
    new URL("../src/views/emby.css", import.meta.url),
    "utf8",
  );
  const legacyStyles = fs.readFileSync(
    new URL("../src/views/legacy.css", import.meta.url),
    "utf8",
  );
  const dialogStyles = fs.readFileSync(
    new URL("../src/components/dialog.css", import.meta.url),
    "utf8",
  );
  const dockStyles = fs.readFileSync(
    new URL("../src/components/dock.css", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /if \(!item\.imageTag \|\| !window\.roomDesktop\)/);
  assert.match(
    source,
    /image\.dataset\.imageState = "loading";\s*image\.hidden = false;\s*image\.src = dataUrl;/,
  );
  assert.match(
    embyStyles,
    /\.emby-popup-overview\s*\{[\s\S]*?max-width:\s*68ch;[\s\S]*?line-height:\s*1\.78;/,
  );
  assert.match(
    embyStyles,
    /\.emby-item-popup-dialog\s*\{[\s\S]*?width:\s*min\(760px,\s*82%\);/,
  );
  assert.match(
    embyStyles,
    /> input\[type="checkbox"\]\s*\{[\s\S]*?width:\s*20px;[\s\S]*?height:\s*20px;/,
  );
  assert.match(
    legacyStyles,
    /\.highlight-correction input\s*\{[\s\S]*?width:\s*46px;[\s\S]*?height:\s*26px;/,
  );
  assert.match(
    dialogStyles,
    /dialog\[open\]::backdrop\s*\{[\s\S]*?opacity:\s*1;/,
  );
  assert.match(source, /data-lucide="volume-x"/);
  assert.match(icons, /\bVolumeX\b/);
  assert.match(
    dockStyles,
    /#dock-mute\[aria-pressed="true"\] \.dock-volume-muted\s*\{[\s\S]*?display:\s*block;/,
  );
  assert.doesNotMatch(player, /this\.video\.controls = this\.host/);
  assert.match(player, /this\.video\.controls = false/);
});

test("playback chrome stays centered on the video and removes redundant badges", () => {
  const source = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = readStyles();
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
  const styles = readStyles();
  assert.match(source, /class="broadcast-mode-glider"/);
  assert.match(source, /data-active-mode="screen"/);
  assert.doesNotMatch(source, /id="hdr-display-summary"/);
  assert.doesNotMatch(source, /id="open-display-settings"/);
  assert.doesNotMatch(
    source,
    /选择正在播放影片的窗口；已最小化的窗口可能不会被 Windows 提供/,
  );
  assert.match(source, /broadcastModeAbort\?\.abort\(\)/);
  assert.match(source, /animateElement\(\s*incoming,/);
  assert.match(source, /signal:\s*broadcastModeAbort\.signal/);
  assert.doesNotMatch(source, /\{\s*height:\s*`\$\{previousHeight\}px`/);
  assert.match(
    styles,
    /\.broadcast-mode-glider[\s\S]*?transition:\s*transform var\(--dur-control\)/,
  );
  assert.match(
    styles,
    /\.broadcast-mode-panel\s*\{[\s\S]*?overflow-y:\s*auto;/,
  );
});

test("danmaku composer reserves a readable field and 44px touch targets", () => {
  const styles = readStyles();
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
  assert.match(
    styles,
    /\.room-sidebar\.companion-panel \.chat-form\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*var\(--control-min\)\s*auto;/,
  );
  assert.match(
    styles,
    /\.room-sidebar\.companion-panel \.chat-form > \.chat-emoji-btn\s*\{[\s\S]*?position:\s*static;[\s\S]*?grid-column:\s*2;/,
  );
  assert.match(
    styles,
    /\.room-sidebar\.companion-panel \.mute-btn\s*\{[\s\S]*?width:\s*var\(--control-min\);[\s\S]*?padding:\s*var\(--s-0\);/,
  );
});

test("the global cursor glow is removed in favor of card-local pointer state", () => {
  const main = fs.readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  const styles = readStyles();
  assert.doesNotMatch(styles, /#cursor-glow/);
  assert.doesNotMatch(main, /startCursorGlow|cursor-glow/);
  assert.match(main, /bindLocalPointerLight/);
  assert.match(styles, /--pointer-x/);
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
  const styles = readStyles();
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
  assert.match(
    session,
    /<progress class="emby-progress" max="100" value="\$\{progress\}"/,
  );
  assert.match(styles, /progress\.emby-progress::-webkit-progress-value/);
  assert.match(music, /music-app-mark-\$\{preset\.key\}/);
});

test("every bottom-right notification leaves after five seconds", () => {
  const source = fs.readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /window\.setTimeout\(\s*\(\) => void removeToast\(key, element\),\s*5_000/,
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
  assert.match(
    session,
    /safeSignalSend\(\{ type: "participant:rename", nickname \}\)/,
  );
  assert.match(session, /const nextNickname = saveNickname\(/);
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
  assert.match(railMarkup, /data-lucide="gamepad-2"/);
  assert.doesNotMatch(railMarkup, /bluffCardMark/);
  assert.doesNotMatch(main, /embeddedGameRailButtonMarkup/);
  assert.match(session, /embeddedGameRailButtonMarkup\(\)/);
  assert.doesNotMatch(game, /window\.open|<iframe|<webview/);
  assert.match(electronMain, /new WebContentsView\(/);
  assert.match(electronMain, /partition:\s*"persist:synced-bluff"/);
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
  const styles = readStyles();
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
    /\.music-source-popover\s*\{[\s\S]*?width:\s*min\(340px,/,
  );
  assert.match(music, /new FloatingSurface\(this\.button, popover/);
  assert.match(music, /music-source-popover material-regular/);
  assert.match(
    styles,
    /\.music-help,[\s\S]*?width:\s*var\(--control-min\);[\s\S]*?height:\s*var\(--control-min\)/,
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

test("HTTPS CMAF viewer stats and liveness remain independent from the control peer", () => {
  const session = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const statsStart = session.indexOf(
    "async function updateEmbyInboundStats",
  );
  const statsEnd = session.indexOf(
    "function updateSfuScreenLiveness",
    statsStart,
  );
  const stats = session.slice(statsStart, statsEnd);
  const abrBranch = stats.indexOf("if (abrDiagnostics?.active)");
  const legacyPeer = stats.indexOf("const peer = watcherPc");

  assert.ok(abrBranch >= 0);
  assert.ok(
    legacyPeer > abrBranch,
    "the HTTPS stats branch must run before the legacy WebRTC peer guard",
  );
  assert.match(stats, /"HTTPS 独立 ABR"/);
  assert.match(stats, /"emby-cmaf-viewer-sample"/);
  assert.match(stats, /estimatedThroughputBps/);
  assert.match(stats, /cacheHits/);
  assert.match(stats, /rangeRetries/);

  const livenessStart = session.indexOf(
    "function monitorViewerMediaLiveness",
  );
  const livenessEnd = session.indexOf(
    "function updateNativePlaybackActivity",
    livenessStart,
  );
  const liveness = session.slice(livenessStart, livenessEnd);
  assert.match(
    liveness,
    /mode === "emby" && Boolean\(embyAbrViewer\?\.diagnostics\.active\)/,
  );
  assert.match(liveness, /mediaTransport: independentHttpsMedia \? "https-cmaf"/);
  assert.match(liveness, /!independentHttpsMedia &&[\s\S]*?shouldRestartIce/);
});

test("user-selected screen and Emby quality is never overwritten by probes or stats", () => {
  const session = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const server = fs.readFileSync(
    new URL("../server/index.mjs", import.meta.url),
    "utf8",
  );
  const recommendationStart = session.indexOf(
    "function applyBandwidthRecommendation",
  );
  const recommendationEnd = session.indexOf(
    "function scheduleNetworkAdviceExpiry",
    recommendationStart,
  );
  const recommendation = session.slice(
    recommendationStart,
    recommendationEnd,
  );
  const preferenceStart = session.indexOf(
    "function currentSfuScreenPreference",
  );
  const preferenceEnd = session.indexOf(
    "function sendViewerQualityPreference",
    preferenceStart,
  );
  const preference = session.slice(preferenceStart, preferenceEnd);

  assert.match(recommendation, /仅供诊断，不会修改你的选择/);
  assert.doesNotMatch(recommendation, /resolutionKey\s*=|frameRate\s*=/);
  assert.doesNotMatch(session, /adaptivePlayback\.forceDegrade/);
  assert.doesNotMatch(session, /screen-startup-quality-down|自动降至/);
  assert.match(preference, /preferredHeight \|\| capabilities\.height/);
  assert.match(preference, /preferredFrameRate \|\| capabilities\.frameRate/);
  assert.match(
    session,
    /function effectiveEmbyViewerHeight\(\)[\s\S]{0,120}?return preferredHeight \|\| undefined/,
  );
  assert.doesNotMatch(session, /automaticEmbyViewerHeight|embyAdaptiveHeight/);
  const rampStart = session.indexOf("new VideoBitrateRampController");
  const rampEnd = session.indexOf("codecAttempt:", rampStart);
  const ramp = session.slice(rampStart, rampEnd);
  assert.doesNotMatch(ramp, /networkAdvice\.routeMode|2_000_000|3_000_000|4_000_000/);
  assert.doesNotMatch(
    session,
    /pressureSafeEmbyQuality|activeEmbyPressureCeiling|embyPressureQualityByViewer/,
  );
  assert.match(
    session,
    /setPreferredHeight\([\s\S]{0,140}?true,[\s\S]{0,100}?requestedHeight === undefined/,
  );
  assert.match(
    server,
    /const originalDemand =[\s\S]{0,220}?policy\.allowOriginalRendition !== false/,
  );
  assert.doesNotMatch(
    server.slice(
      server.indexOf("const originalDemand ="),
      server.indexOf("send(broadcaster.socket", server.indexOf("const originalDemand =")),
    ),
    /verifiedDownloadBps\s*>?=/,
  );
});

test("Emby transport recovery preserves an already attached MSE timeline", () => {
  const session = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const waitingStart = session.indexOf("function hasRenderableEmbyFrame");
  const waitingEnd = session.indexOf("function showLocalStage", waitingStart);
  const waiting = session.slice(waitingStart, waitingEnd);
  const p2pStart = session.indexOf("async function beginP2PWatching");
  const p2pEnd = session.indexOf("async function handleWatcherSignal", p2pStart);
  const p2p = session.slice(p2pStart, p2pEnd);

  assert.match(waiting, /preserveEmbyMediaSource/);
  assert.match(waiting, /embyViewer\?\.activeSession/);
  assert.match(waiting, /hasRenderableEmbyFrame\(\)/);
  assert.match(waiting, /video\.readyState >= 2/);
  assert.match(waiting, /confirmEmbyPlaybackReady\(\)/);
  assert.match(waiting, /clearSfuEmbyStartupDeadline\(\)/);
  assert.match(waiting, /keepEmbyFrameVisible[\s\S]*?showRemoteStage\(\)/);
  assert.match(
    waiting,
    /if \(!preserveEmbyMediaSource\)[\s\S]*?video\.removeAttribute\("src"\)/,
  );
  assert.match(p2p, /const preserveEmbyPlayback/);
  assert.match(p2p, /if \(!preserveLastFrame\) remoteFirstFrame = false/);
});

test("Android exposes recent channels and a complete touch-scrollable toolbar", () => {
  const main = fs.readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  const session = fs.readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const styles = readStyles();

  assert.match(main, /function mobileRecentJoinMarkup/);
  assert.match(main, /data-mobile-recent-room/);
  assert.match(main, /mobileRecentChannels[\s\S]*?最近加入/);
  assert.match(main, /\[data-mobile-recent-room\][\s\S]*?void joinRoom\(\)/);
  assert.match(styles, /\.mobile-recent-join-item\s*\{[\s\S]*?min-height:\s*68px/);
  assert.match(styles, /\.mobile-recent-join-item\s*\{[\s\S]*?touch-action:\s*manipulation/);
  assert.match(
    session,
    /if \(nativeAndroid && !isImmersivePlayback\(\)\)[\s\S]{0,260}?stageDock\.classList\.remove/,
  );
  const phoneDock = styles.slice(styles.indexOf("@media (max-width: 599px)"));
  assert.match(phoneDock, /\.dock\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.match(phoneDock, /touch-action:\s*pan-x/);
  assert.doesNotMatch(
    phoneDock.slice(0, phoneDock.indexOf(".dock {")),
    /#dock-quality|#dock-emby-settings/,
  );
});
