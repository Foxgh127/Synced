import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/config.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    }).then(({ outputFiles }) =>
      import(
        `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
      ),
    );
  }
  return modulePromise;
}

test("migrates insecure legacy endpoints while preserving the secure standby", async () => {
  const { normalizeSignalUrl } = await loadModule();
  assert.equal(
    normalizeSignalUrl("ws://47.98.173.139:8787/signal"),
    "wss://synced.com.cn/signal",
  );
  assert.equal(
    normalizeSignalUrl("ws://47.98.173.139:443/signal"),
    "wss://synced.com.cn/signal",
  );
  assert.equal(
    normalizeSignalUrl("wss://47.98.173.139/signal"),
    "wss://47.98.173.139/signal",
  );
  assert.equal(
    normalizeSignalUrl("ws://synced.com.cn:8787/signal"),
    "wss://synced.com.cn/signal",
  );
});

test("does not rewrite a user-provided development server", async () => {
  const { normalizeSignalUrl } = await loadModule();
  assert.equal(
    normalizeSignalUrl("ws://192.168.1.8:8787"),
    "ws://192.168.1.8:8787/signal",
  );
});

test("rejects signalling URLs that embed credentials", async () => {
  const { normalizeSignalUrl, parseJoinLink } = await loadModule();
  assert.throws(
    () => normalizeSignalUrl("wss://operator:secret@signal.example.test"),
    /不能包含用户名或密码/,
  );
  assert.deepEqual(
    parseJoinLink(
      "synced://join?room=A7K9P2WX&signal=wss%3A%2F%2Foperator%3Asecret%40signal.example.test",
    ),
    {},
  );
});

test("accepts only canonical app invitations with a valid room and signal URL", async () => {
  const { buildJoinLink, parseJoinLink } = await loadModule();
  const invite = buildJoinLink(
    "A7K9P2WX",
    "wss://signal.example.test/signal",
  );
  assert.deepEqual(parseJoinLink(invite), {
    room: "A7K9P2WX",
    signal: "wss://signal.example.test/signal",
    needsSignalTrust: true,
  });
  assert.equal(invite.startsWith("synced://join?"), true);
  assert.deepEqual(
    parseJoinLink(
      "synced://join?room=A7K9P2WX&signal=wss://47.98.173.139/signal",
    ),
    {
      room: "A7K9P2WX",
      signal: "wss://47.98.173.139/signal",
      needsSignalTrust: false,
    },
  );
  assert.deepEqual(
    parseJoinLink(
      "https://attacker.example/?room=A7K9P2WX&signal=wss://attacker.example",
    ),
    {},
  );
  assert.deepEqual(
    parseJoinLink(
      "synced://join?room=INVALID1&signal=wss://signal.example.test",
    ),
    {},
  );
  assert.deepEqual(
    parseJoinLink(
      "synced://join?room=A7K9P2WX&signal=https://attacker.example",
    ),
    {},
  );
});
