import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainSource = readFileSync(
  new URL("../electron/main.cjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("Electron grants media permissions only to the main renderer", () => {
  assert.match(
    mainSource,
    /setPermissionCheckHandler\(\(webContents, permission\)[\s\S]*?isMainRenderer\(webContents\)/,
  );
  assert.match(
    mainSource,
    /setPermissionRequestHandler\(\(webContents, permission, callback\)[\s\S]*?isMainRenderer\(webContents\)/,
  );
  assert.match(
    mainSource,
    /setDisplayMediaRequestHandler\(async \(request, callback\)[\s\S]*?request\.frame !== mainWindow\.webContents\.mainFrame/,
  );
});

test("privileged IPC handlers authenticate their renderer", () => {
  const privilegedHandlers = [
    "capture:list-sources",
    "capture:select-source",
    "capture:get-source-health",
    "network:ensure-portable-firewall",
    "clipboard:write",
    "clipboard:read",
    "system:get-display-info",
    "system:open-display-settings",
    "capture:set-active",
    "game:view-open",
    "game:view-set-bounds",
    "game:view-reload",
    "game:view-back",
    "app:get-version",
    "app:get-network-info",
  ];

  for (const channel of privilegedHandlers) {
    const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      mainSource,
      new RegExp(
        `ipcMain\\.handle\\("${escaped}",[\\s\\S]{0,180}?assertMainRenderer\\(event\\)`,
      ),
      `${channel} must call assertMainRenderer`,
    );
  }

  assert.match(
    mainSource,
    /ipcMain\.on\("game:view-hide",[\s\S]{0,180}?assertMainRenderer\(event\)/,
    "game:view-hide must call assertMainRenderer",
  );
});

test("idle app and hidden game are not globally forced to render at full speed", () => {
  assert.doesNotMatch(mainSource, /disable-renderer-backgrounding/);
  assert.doesNotMatch(mainSource, /disable-background-timer-throttling/);
  assert.doesNotMatch(mainSource, /disable-backgrounding-occluded-windows/);
  assert.match(
    mainSource,
    /partition:\s*"persist:synced-bluff",[\s\S]{0,360}?backgroundThrottling:\s*true/,
  );
  assert.match(
    mainSource,
    /Voice, WebRTC decoding, and video Picture-in-Picture[\s\S]{0,180}?backgroundThrottling:\s*false/,
  );
});

test("music capture accepts only enumerated known process ids", () => {
  assert.match(mainSource, /--inspect-processes/);
  assert.match(mainSource, /--capture-process/);
  assert.match(
    mainSource,
    /processMatch[\s\S]{0,800}?inspectKnownMusicProcesses\(\)[\s\S]{0,800}?capture-process-selected/,
  );
});

test("desktop clients cannot start or package a local signal server", () => {
  assert.doesNotMatch(mainSource, /startLocalSignalServer/);
  assert.doesNotMatch(mainSource, /SYNCED_ENABLE_LOCAL_SIGNAL/);
  assert.doesNotMatch(mainSource, /createSignalServer/);
  assert.doesNotMatch(mainSource, /\.listen\(8787,\s*"0\.0\.0\.0"\)/);
  assert.ok(!packageJson.build.files.includes("server/**/*"));
});

test("application quit waits for Emby cleanup", () => {
  assert.match(
    mainSource,
    /app\.on\("before-quit", \(event\) => \{[\s\S]*?event\.preventDefault\(\)[\s\S]*?Promise\.allSettled\([\s\S]*?accountsToDestroy\?\.destroy\(\)[\s\S]*?shutdownComplete = true;[\s\S]*?app\.quit\(\)/,
  );
  assert.doesNotMatch(mainSource, /signalServerToClose/);
});
