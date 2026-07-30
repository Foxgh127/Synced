import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { once } from "node:events";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const { createCdp } = require("../scripts/portable-emby-field-test.cjs");
const script = readFileSync(
  new URL("../scripts/portable-emby-field-test.cjs", import.meta.url),
  "utf8",
);

test("real portable Emby field test is pinned to 2.8.1 and observes playback", () => {
  assert.match(script, /EXPECTED_VERSION = "2\.8\.1"/u);
  assert.match(script, /Math\.max\(\s*30_000/u);
  assert.match(script, /getVideoPlaybackQuality/u);
  assert.match(script, /readyStateMin/u);
  assert.match(script, /bufferedAheadMedian/u);
  assert.match(script, /decodedFramesDelta/u);
  assert.match(script, /unhandledRejections/u);
  assert.match(script, /Page\.captureScreenshot/u);
  assert.match(script, /startClickRetries < 2/u);
  assert.match(script, /SYNCED_E2E_VISIBLE: "1"/u);
  assert.match(script, /optimizeForSpeed: true/u);
  assert.match(script, /captureLauncherWindow/u);
  assert.match(script, /CopyFromScreen/u);
  assert.match(script, /postStopSearch/u);
  assert.match(script, /searchProbe/u);
});

test("the field harness never treats the hidden default stop label as an owned broadcast", () => {
  assert.match(
    script,
    /!action\.hidden[\s\S]*action\.classList\.contains\("active"\)/u,
  );
  assert.doesNotMatch(
    script,
    /document\.querySelector\('#broadcast-action'\)\?\.textContent\?\.includes\('停止放映'\)/u,
  );
  assert.doesNotMatch(script, /textContent\?\.includes\("停止放映"\)/u);
  assert.match(
    script,
    /await trustedClick\("#stage-start-broadcast, #broadcast-action"\)/u,
  );
});

test("real portable Emby field report has explicit skip/failure classifications", () => {
  assert.match(script, /saved-account-missing/u);
  assert.match(script, /external-media-library-unavailable/u);
  assert.match(script, /external-media-playback-start-failed/u);
  assert.match(script, /playback-continuity-threshold-failed/u);
  assert.match(script, /outcome === "failed" \? 1 : 0/u);
});

test("CDP commands have a hard timeout and release pending requests", async (t) => {
  const server = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  t.after(() => server.close());
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", () => {
      // Deliberately leave every fake CDP request unanswered.
    });
  });
  const address = server.address();
  const cdp = createCdp(`ws://127.0.0.1:${address.port}`, {
    connectTimeoutMs: 500,
    commandTimeoutMs: 250,
  });
  await cdp.ready;
  await assert.rejects(
    cdp.send("Runtime.evaluate", { expression: "new Promise(() => {})" }),
    (error) => error?.code === "cdp-command-timeout",
  );
  assert.equal(cdp.pendingCount, 0);
  await cdp.shutdown(250);
  assert.equal(cdp.pendingCount, 0);
});

test("renderer hangs are classified without serializing raw CDP failures", () => {
  assert.match(script, /renderer-unresponsive/u);
  assert.match(script, /portable-cdp-connect-timeout/u);
  assert.match(script, /clearTimeout\(waiter\.timer\)/u);
  assert.match(script, /socket\.terminate\(\)/u);
  assert.match(script, /"taskkill\.exe"/u);
  assert.doesNotMatch(script, /error\.(?:message|stack)/u);
});

test("real portable Emby field test does not inspect or report private fields", () => {
  for (const forbidden of [
    /safeStorage/u,
    /emby-accounts\.v1\.json/u,
    /document\.body\.innerText/u,
    /document\.documentElement\.innerHTML/u,
    /currentSrc/u,
    /video\.src/u,
    /emby-account-name/u,
    /emby-account-detail/u,
    /emby-saved-note/u,
    /emby-password/u,
    /emby-username/u,
    /host-signal-url/u,
    /\.textContent\s*[,}]/u,
  ]) {
    assert.doesNotMatch(script, forbidden);
  }
  assert.match(script, /credentialStorageRead: false/u);
  assert.match(script, /mediaTitlesRead: false/u);
  assert.match(script, /mediaUrlsRead: false/u);
});
