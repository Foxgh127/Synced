import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  modulePromise ??= build({
    entryPoints: [path.resolve("src/emby-endpoint.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  }).then(({ outputFiles }) =>
    import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
    ),
  );
  return modulePromise;
}

test("pasted Emby URLs split into protocol, host, port and proxy path", async () => {
  const { parseEmbyEndpointInput } = await loadModule();
  assert.deepEqual(
    parseEmbyEndpointInput("https://media.example.cn:8443/emby/"),
    {
      protocol: "https",
      host: "media.example.cn",
      port: "8443",
      path: "/emby",
    },
  );
  assert.deepEqual(parseEmbyEndpointInput("nas.local"), {
    protocol: "https",
    host: "nas.local",
    port: "443",
    path: "",
  });
});

test("Emby endpoint composition supports IPv6 and normalizes default ports", async () => {
  const { composeEmbyEndpoint, parseEmbyEndpointInput } =
    await loadModule();
  assert.equal(
    composeEmbyEndpoint({
      protocol: "https",
      host: "2001:db8::4",
      port: "443",
      path: "emby",
    }),
    "https://[2001:db8::4]/emby",
  );
  assert.deepEqual(parseEmbyEndpointInput("http://[::1]:8096/emby"), {
    protocol: "http",
    host: "[::1]",
    port: "8096",
    path: "/emby",
  });
});

test("Emby endpoint parser rejects credentials, query strings and unsafe schemes", async () => {
  const { parseEmbyEndpointInput } = await loadModule();
  assert.throws(
    () => parseEmbyEndpointInput("https://user:pass@example.com"),
    /用户名或密码/u,
  );
  assert.throws(
    () => parseEmbyEndpointInput("https://example.com/emby?token=secret"),
    /查询参数/u,
  );
  assert.throws(
    () => parseEmbyEndpointInput("file:///etc/passwd"),
    /只支持 HTTP 或 HTTPS/u,
  );
});
