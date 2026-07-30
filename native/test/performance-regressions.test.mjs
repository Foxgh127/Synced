import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const rendererEntry = readFileSync(
  new URL("../src/main.ts", import.meta.url),
  "utf8",
);
const musicSource = readFileSync(
  new URL("../src/channel-music.ts", import.meta.url),
  "utf8",
);
const electronMain = readFileSync(
  new URL("../electron/main.cjs", import.meta.url),
  "utf8",
);

test("application startup does not run an eager network speed probe", () => {
  assert.doesNotMatch(rendererEntry, /warmNetworkProbe/);
});

test("music source UI paints first and reuses a short-lived source list", () => {
  const openStart = musicSource.indexOf("private async openPopover");
  const openEnd = musicSource.indexOf("private closePopover", openStart);
  const openPopover = musicSource.slice(openStart, openEnd);
  assert.ok(openStart >= 0);
  assert.ok(openPopover.indexOf("await waitForPopoverPaint()") >= 0);
  assert.ok(
    openPopover.indexOf("await this.refreshSources()") >
      openPopover.indexOf("await waitForPopoverPaint()"),
  );
  assert.match(musicSource, /const MUSIC_SOURCE_CACHE_MS = 5_000/);
  assert.match(musicSource, /sourceRefreshInFlight/);
  assert.match(musicSource, /this\.refreshSources\(true\)/);
});

test("lightweight music enumeration skips icons and all-window inspection", () => {
  assert.match(electronMain, /fetchWindowIcons:\s*withThumbnails/);
  assert.match(
    electronMain,
    /const processByHandle = lightweightAudioList\s*\?\s*new Map\(\)\s*:\s*await inspectWindowProcesses/,
  );
  assert.match(
    electronMain,
    /const knownMusicProcessesPromise = includeAudioProcesses[\s\S]{0,160}?inspectKnownMusicProcesses\(\)/,
  );
});

test("capture diagnostics are buffered and written asynchronously", () => {
  assert.doesNotMatch(electronMain, /fs\.appendFileSync\(/);
  assert.match(electronMain, /const DIAGNOSTIC_FLUSH_BYTES = 64 \* 1024/);
  assert.match(electronMain, /diagnosticBuffer\.push\(entry\)/);
  assert.match(electronMain, /fs\.promises\.appendFile\(/);
  assert.match(electronMain, /\.then\(\(\) => flushDiagnosticLog\(\)\)/);
});

test("portable firewall checks use an exact-path TTL and coalesce callers", () => {
  assert.match(electronMain, /const FIREWALL_SUCCESS_CACHE_MS = 10 \* 60_000/);
  assert.match(electronMain, /const FIREWALL_FAILURE_CACHE_MS = 15_000/);
  assert.match(
    electronMain,
    /const cacheKey = `\$\{executable\}\\0\$\{process\.env\.PORTABLE_EXECUTABLE_FILE\}`/,
  );
  assert.match(
    electronMain,
    /portableFirewallInFlight\?\.key === cacheKey[\s\S]{0,100}?portableFirewallInFlight\.promise/,
  );
  assert.match(
    electronMain,
    /const ruleNames = \["Synced P2P UDP v3"\]/,
  );
  assert.match(
    electronMain,
    /rule\.Profile -ne 'Private'[\s\S]*?Protocol -eq 'UDP'/,
  );
  assert.match(
    electronMain,
    /'profile=private','protocol=UDP','edge=no'/,
  );
});
