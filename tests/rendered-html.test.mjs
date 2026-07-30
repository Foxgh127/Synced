import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://synced.test/", {
      headers: {
        accept: "text/html",
        host: "synced.test",
        "x-forwarded-host": "synced.test",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the branded entry page and metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*lang="zh-CN"/i);
  assert.match(html, /<title>同频｜一键分享，同频观影<\/title>/i);
  assert.match(html, /同频/);
  assert.match(html, /一键分享，同频观影/);
  assert.match(html, /https:\/\/synced\.test\/og\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("keeps the VDO wrapper focused and secure by default", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /https:\/\/vdo\.ninja/);
  assert.match(page, /screensharequality:\s*"4k"/);
  assert.match(page, /screensharecontenthint:\s*"motion"/);
  assert.match(page, /systemaudio:\s*"include"/);
  assert.match(page, /displaysurface:\s*"window"/);
  assert.match(page, /selfbrowsersurface:\s*"exclude"/);
  assert.match(page, /crypto\.getRandomValues/);
  assert.match(page, /event\.origin !== VDO_ORIGIN/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML|eval\(/);

  assert.match(layout, /generateMetadata/);
  assert.match(layout, /x-forwarded-host/);
  assert.doesNotMatch(layout, /codex-preview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
});
