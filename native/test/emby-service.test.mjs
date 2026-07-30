import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  browserDirectAudioCompatible,
  browserDirectVideoCompatible,
  buildDeviceProfile,
  chooseSource,
  decodeSubtitleBuffer,
  embyApiBaseCandidates,
  embyReadAheadProfile,
  EmbyLoopbackProxy,
  EmbyService,
  FragmentedMp4Parser,
  detectMp4Mime,
  isHlsManifestResponse,
  normalizeServerUrl,
  qualityProfile,
  rewriteManifest,
  terminateChildProcess,
} = require("../electron/emby-service.cjs");

test("read-ahead grows faster for efficient remux while bounding 4K and CPU fallback bursts", () => {
  assert.deepEqual(embyReadAheadProfile(8_000_000, false), {
    readRate: 1.35,
    initialBurstSeconds: 12,
    catchupRate: 1.55,
  });
  assert.deepEqual(embyReadAheadProfile(46_000_000, false), {
    readRate: 1.16,
    initialBurstSeconds: 6,
    catchupRate: 1.3,
  });
  assert.deepEqual(embyReadAheadProfile(46_000_000, true), {
    readRate: 1.08,
    initialBurstSeconds: 4,
    catchupRate: 1.16,
  });
});

const ffmpeg = path.resolve("vendor/ffmpeg/ffmpeg.exe");

function box(type, payload = Buffer.alloc(0)) {
  const result = Buffer.alloc(8 + payload.length);
  result.writeUInt32BE(result.length, 0);
  result.write(type, 4, 4, "ascii");
  payload.copy(result, 8);
  return result;
}

function fullBox(type, flags, body = Buffer.alloc(0), version = 0) {
  const payload = Buffer.alloc(4 + body.length);
  payload[0] = version;
  payload.writeUIntBE(flags, 1, 3);
  body.copy(payload, 4);
  return box(type, payload);
}

function boxToEof(type, payload = Buffer.alloc(0)) {
  const result = Buffer.alloc(8 + payload.length);
  result.writeUInt32BE(0, 0);
  result.write(type, 4, 4, "ascii");
  payload.copy(result, 8);
  return result;
}

function sampleTrack(handler, entries) {
  const hdlrBody = Buffer.alloc(12);
  hdlrBody.write(handler, 4, 4, "ascii");
  const entryCount = Buffer.alloc(4);
  entryCount.writeUInt32BE(entries.length, 0);
  return box(
    "trak",
    box(
      "mdia",
      Buffer.concat([
        fullBox("hdlr", 0, hdlrBody),
        box(
          "minf",
          box(
            "stbl",
            fullBox("stsd", 0, Buffer.concat([entryCount, ...entries])),
          ),
        ),
      ]),
    ),
  );
}

function timelineTrack(handler, trackId, timescale) {
  const tkhdBody = Buffer.alloc(16);
  tkhdBody.writeUInt32BE(trackId, 8);
  const mdhdBody = Buffer.alloc(16);
  mdhdBody.writeUInt32BE(timescale, 8);
  const hdlrBody = Buffer.alloc(12);
  hdlrBody.write(handler, 4, 4, "ascii");
  return box(
    "trak",
    Buffer.concat([
      fullBox("tkhd", 0, tkhdBody),
      box(
        "mdia",
        Buffer.concat([
          fullBox("mdhd", 0, mdhdBody),
          fullBox("hdlr", 0, hdlrBody),
        ]),
      ),
    ]),
  );
}

function timelineFragment(entries, payload) {
  const trafs = entries.map(({ trackId, decodeTime }) => {
    const tfhdBody = Buffer.alloc(4);
    tfhdBody.writeUInt32BE(trackId, 0);
    const tfdtBody = Buffer.alloc(4);
    tfdtBody.writeUInt32BE(decodeTime, 0);
    return box(
      "traf",
      Buffer.concat([
        fullBox("tfhd", 0, tfhdBody),
        fullBox("tfdt", 0, tfdtBody),
      ]),
    );
  });
  return Buffer.concat([
    box("moof", Buffer.concat(trafs)),
    box("mdat", Buffer.from(payload)),
  ]);
}

function testChildBoxes(buffer, start = 8) {
  const boxes = [];
  for (let offset = start; offset + 8 <= buffer.length; ) {
    const size = buffer.readUInt32BE(offset);
    if (size < 8 || offset + size > buffer.length) break;
    boxes.push({
      type: buffer.toString("ascii", offset + 4, offset + 8),
      data: buffer.subarray(offset, offset + size),
    });
    offset += size;
  }
  return boxes;
}

function fragmentTfdtMs(fragment, trackId, timescale) {
  const moof = testChildBoxes(fragment, 0).find(
    ({ type }) => type === "moof",
  )?.data;
  assert.ok(moof, "fragment contains moof");
  for (const { type, data: traf } of testChildBoxes(moof)) {
    if (type !== "traf") continue;
    const children = testChildBoxes(traf);
    const tfhd = children.find((child) => child.type === "tfhd")?.data;
    if (!tfhd || tfhd.readUInt32BE(12) !== trackId) continue;
    const tfdt = children.find((child) => child.type === "tfdt")?.data;
    assert.ok(tfdt, `track ${trackId} contains tfdt`);
    return (tfdt.readUInt32BE(12) / timescale) * 1_000;
  }
  assert.fail(`track ${trackId} was not found`);
}

function videoSampleEntry(type, configType, configPayload) {
  return box(
    type,
    Buffer.concat([
      Buffer.alloc(78),
      box(configType, Buffer.from(configPayload)),
    ]),
  );
}

test("rejects credential-bearing and unapproved insecure Emby addresses", () => {
  assert.throws(
    () => normalizeServerUrl("file:///nas/emby", true),
    /HTTP 或 HTTPS/,
  );
  assert.throws(
    () => normalizeServerUrl("http://user:password@nas.local", true),
    /不要把用户名或密码写在服务器地址/,
  );
  assert.throws(
    () => normalizeServerUrl("http://nas.local"),
    /未加密 HTTP/,
  );
  assert.equal(
    normalizeServerUrl("https://nas.local/emby/").toString(),
    "https://nas.local/emby",
  );
  assert.deepEqual(
    embyApiBaseCandidates(new URL("https://nas.local/web/index.html")).map(
      (value) => value.toString(),
    ),
    ["https://nas.local/emby", "https://nas.local/"],
  );
});

test("restores a validated encrypted-account session without exposing its token", () => {
  const service = new EmbyService({
    version: "2.0.1",
    deviceId: "restored-device-id",
  });
  const login = service.restoreSession({
    serverUrl: "https://media.example:8920/emby",
    token: "main-process-secret",
    userId: "restored-user",
    username: "Viewer",
    serverName: "Home Media",
    serverVersion: "4.9.0",
    insecure: false,
  });
  assert.deepEqual(login.user, { id: "restored-user", name: "Viewer" });
  assert.deepEqual(
    {
      id: login.server.id,
      name: login.server.name,
      version: login.server.version,
      address: login.server.address,
      insecure: login.server.insecure,
    },
    {
      id: undefined,
      name: "Home Media",
      version: "4.9.0",
      address: "https://media.example:8920/emby",
      insecure: false,
    },
  );
  assert.match(login.server.activeEndpointId, /^[a-f0-9]{16}$/);
  assert.deepEqual(login.server.endpoints, [
    {
      id: login.server.activeEndpointId,
      label: "主线路",
      url: "https://media.example:8920/emby",
      priority: 0,
      active: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(login), /main-process-secret/);
  assert.equal(service.exportSession().token, "main-process-secret");
  assert.throws(
    () =>
      service.restoreSession({
        serverUrl: "https://media.example",
        userId: "restored-user",
        username: "Viewer",
      }),
    /登录信息无效/,
  );
});

test("discovers the official /emby API base and paginates resumable items", async () => {
  let itemQuery;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const json = (value) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/emby/Users/AuthenticateByName") {
      json({
        AccessToken: "official-base-token",
        User: { Id: "user-official", Name: "Viewer" },
      });
    } else if (url.pathname === "/emby/System/Info") {
      json({ ServerName: "Official Path", Version: "4.9.0" });
    } else if (url.pathname === "/emby/Users/user-official/Items") {
      itemQuery = url.searchParams;
      json({
        TotalRecordCount: 81,
        Items: [
          {
            Id: "episode-61",
            Name: "继续播放",
            Type: "Episode",
            SeriesId: "series-1",
            SeriesPrimaryImageTag: "poster-tag",
            RunTimeTicks: 18_000_000_000,
            UserData: {
              PlaybackPositionTicks: 6_000_000_000,
              PlayedPercentage: 33.3,
            },
          },
        ],
      });
    } else if (url.pathname === "/emby/Sessions/Logout") {
      response.writeHead(204).end();
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const service = new EmbyService({
    version: "1.0.0",
    deviceId: "official-path-device",
    ffmpegPath: ffmpeg,
  });
  try {
    const login = await service.login({
      serverUrl: `http://127.0.0.1:${address.port}/web/index.html`,
      username: "Viewer",
      password: "",
      allowInsecure: true,
    });
    assert.match(login.server.address, /\/emby$/);
    const result = await service.listItems({
      startIndex: 60,
      limit: 30,
      filters: ["IsResumable"],
      sortBy: "DatePlayed,DateCreated",
      sortOrder: "Descending",
    });
    assert.equal(itemQuery.get("StartIndex"), "60");
    assert.equal(itemQuery.get("Limit"), "30");
    assert.equal(itemQuery.get("Filters"), "IsResumable");
    assert.equal(itemQuery.get("SortBy"), "DatePlayed,DateCreated");
    assert.equal(itemQuery.get("EnableUserData"), "true");
    assert.equal(result.items[0].imageItemId, "series-1");
    assert.equal(result.items[0].playbackPositionTicks, 6_000_000_000);
    assert.equal(result.items[0].playedPercentage, 33.3);
  } finally {
    await service.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an Emby response body that stalls after headers still times out and releases the request", async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/stall") {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write('{"Items":');
      return;
    }
    if (url.pathname === "/ok") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"Items":[]}');
      return;
    }
    response.writeHead(204).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const service = new EmbyService({
    version: "2.6.0",
    deviceId: "stalled-body-device",
  });
  service.restoreSession({
    serverUrl: `http://127.0.0.1:${address.port}`,
    token: "stalled-body-token",
    userId: "stalled-body-user",
    username: "Viewer",
    insecure: true,
  });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      service.requestJson("/stall", { totalTimeoutMs: 1_000 }),
      /连接 Emby 超时/u,
    );
    assert.ok(
      Date.now() - startedAt < 3_000,
      "the body deadline must cover reader.read(), not only response headers",
    );
    assert.deepEqual(
      await service.requestJson("/ok", { totalTimeoutMs: 1_000 }),
      { Items: [] },
      "a timed-out body must not poison the following request",
    );
  } finally {
    await service.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a recent authenticated route success skips the redundant playback preflight", async () => {
  let publicProbes = 0;
  let playbackRequests = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/warm") {
      response.end('{"ok":true}');
      return;
    }
    if (url.pathname === "/System/Info/Public") {
      publicProbes += 1;
      response.end('{"Id":"recent-route-server"}');
      return;
    }
    if (url.pathname === "/Items/movie/PlaybackInfo") {
      playbackRequests += 1;
      response.end(
        JSON.stringify({
          PlaySessionId: "recent-route-session",
          MediaSources: [],
        }),
      );
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const service = new EmbyService({
    version: "2.8.0",
    deviceId: "recent-route-device",
  });
  service.restoreSession({
    serverUrl: `http://127.0.0.1:${address.port}`,
    endpoints: [
      { url: `http://127.0.0.1:${address.port}`, label: "主线路" },
      { url: "http://127.0.0.1:1", label: "备用线路" },
    ],
    token: "recent-route-token",
    userId: "recent-route-user",
    username: "Viewer",
    insecure: true,
  });
  try {
    assert.deepEqual(
      await service.requestJson("/warm", { totalTimeoutMs: 1_000 }),
      { ok: true },
    );
    await service.playbackInfo({
      itemId: "movie",
      quality: "1080p-8",
    });
    assert.equal(publicProbes, 0);
    assert.equal(playbackRequests, 1);
  } finally {
    await service.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("verified Emby backup routes fail over on 5xx but never on 401", async () => {
  let primaryItemsMode = "503";
  let primaryItemRequests = 0;
  let backupItemRequests = 0;
  let primaryPostRequests = 0;
  let backupPostRequests = 0;
  let primaryPublicMode = "200";
  let backupProbeToken;
  const primary = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const json = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/emby/System/Info/Public") {
      json(
        primaryPublicMode === "503" ? 503 : 200,
        primaryPublicMode === "503"
          ? { Message: "primary probe unavailable" }
          : { Id: "same-server-id" },
      );
    } else if (url.pathname === "/emby/Users/AuthenticateByName") {
      json(200, {
        AccessToken: "route-secret",
        User: { Id: "user-routes", Name: "Viewer" },
      });
    } else if (url.pathname === "/emby/System/Info") {
      json(200, {
        Id: "same-server-id",
        ServerName: "Route Server",
        Version: "4.9.0",
      });
    } else if (url.pathname === "/emby/System/Info/Public") {
      json(200, { Id: "same-server-id" });
    } else if (url.pathname === "/emby/Items/movie-post/PlaybackInfo") {
      primaryPostRequests += 1;
      json(503, { Message: "do not replay this POST" });
    } else if (url.pathname === "/emby/Users/user-routes/Items") {
      primaryItemRequests += 1;
      if (primaryItemsMode === "401") {
        json(401, { Message: "expired" });
      } else {
        json(503, { Message: "primary unavailable" });
      }
    } else if (url.pathname === "/emby/Sessions/Logout") {
      response.writeHead(204).end();
    } else {
      response.writeHead(404).end();
    }
  });
  const backup = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const json = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/emby/System/Info/Public") {
      backupProbeToken = request.headers["x-emby-token"];
      json(200, { Id: "same-server-id" });
    } else if (url.pathname === "/emby/Items/movie-post/PlaybackInfo") {
      backupPostRequests += 1;
      json(200, { MediaSources: [] });
    } else if (url.pathname === "/emby/Users/user-routes/Items") {
      backupItemRequests += 1;
      assert.equal(request.headers["x-emby-token"], "route-secret");
      json(200, {
        TotalRecordCount: 1,
        Items: [{ Id: "movie-backup", Name: "备用线路影片", Type: "Movie" }],
      });
    } else if (url.pathname === "/emby/Sessions/Logout") {
      response.writeHead(204).end();
    } else {
      response.writeHead(404).end();
    }
  });
  await Promise.all([
    new Promise((resolve) => primary.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => backup.listen(0, "127.0.0.1", resolve)),
  ]);
  const primaryAddress = primary.address();
  const backupAddress = backup.address();
  const service = new EmbyService({
    version: "2.4.0",
    deviceId: "route-device",
    ffmpegPath: ffmpeg,
  });
  try {
    await service.login({
      serverUrls: [
        `http://127.0.0.1:${primaryAddress.port}/emby`,
        `http://127.0.0.1:${backupAddress.port}/emby`,
      ],
      username: "Viewer",
      password: "",
      allowInsecure: true,
    });
    const primarySession = service.exportSession();
    assert.equal(backupProbeToken, undefined);

    const postService = new EmbyService({
      version: "2.4.0",
      deviceId: "route-device-post",
      ffmpegPath: ffmpeg,
    });
    postService.restoreSession(primarySession);
    await assert.rejects(
      postService.requestJson("/Items/movie-post/PlaybackInfo", {
        method: "POST",
        body: "{}",
      }),
      /503|do not replay|无法连接 Emby/u,
    );
    assert.equal(primaryPostRequests, 1);
    assert.equal(
      backupPostRequests,
      0,
      "non-idempotent POST requests must never be replayed on a backup",
    );
    await postService.destroy();

    primaryPublicMode = "503";
    const routedPlaybackService = new EmbyService({
      version: "2.4.0",
      deviceId: "route-device-safe-probe",
      ffmpegPath: ffmpeg,
    });
    routedPlaybackService.restoreSession(primarySession);
    const routedPlayback = await routedPlaybackService.playbackInfo({
      itemId: "movie-post",
      quality: "1080p-8",
    });
    assert.deepEqual(routedPlayback.mediaSources, []);
    assert.equal(
      primaryPostRequests,
      1,
      "the stateful POST must not be sent to the failed primary",
    );
    assert.equal(backupPostRequests, 1);
    assert.match(
      routedPlaybackService.exportSession().serverUrl,
      new RegExp(`:${backupAddress.port}/emby$`),
    );
    await routedPlaybackService.destroy();

    const result = await service.listItems({ limit: 20 });
    assert.equal(result.items[0].id, "movie-backup");
    assert.equal(primaryItemRequests, 1);
    assert.equal(backupItemRequests, 1);
    assert.match(
      service.exportSession().serverUrl,
      new RegExp(`:${backupAddress.port}/emby$`),
    );
    service.pipeline = {};
    await assert.rejects(
      service.updateEndpoints({
        serverUrls: [
          `http://127.0.0.1:${primaryAddress.port}/emby`,
          `http://127.0.0.1:${backupAddress.port}/emby`,
        ],
        allowInsecure: true,
      }),
      /放映期间不能修改 Emby 线路/u,
    );
    service.pipeline = undefined;

    primaryItemsMode = "401";
    const authFailureService = new EmbyService({
      version: "2.4.0",
      deviceId: "route-device-auth",
      ffmpegPath: ffmpeg,
    });
    authFailureService.restoreSession(primarySession);
    await assert.rejects(
      authFailureService.listItems({ limit: 20 }),
      /401|expired|无法连接 Emby/u,
    );
    assert.equal(primaryItemRequests, 2);
    assert.equal(
      backupItemRequests,
      1,
      "authentication failures must not send the token to another route",
    );
  } finally {
    await service.logout().catch(() => undefined);
    await Promise.all([
      new Promise((resolve) => primary.close(resolve)),
      new Promise((resolve) => backup.close(resolve)),
    ]);
  }
});

test("rejects an Emby backup that belongs to another Server Id before sending a token", async () => {
  let foreignToken;
  const primary = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/emby/Users/AuthenticateByName") {
      response.end(
        JSON.stringify({
          AccessToken: "primary-only-token",
          User: { Id: "user-primary", Name: "Viewer" },
        }),
      );
    } else if (url.pathname === "/emby/System/Info") {
      response.end(JSON.stringify({ Id: "primary-server-id" }));
    } else if (url.pathname === "/emby/Sessions/Logout") {
      response.writeHead(204).end();
    } else {
      response.writeHead(404).end();
    }
  });
  const foreign = http.createServer((request, response) => {
    foreignToken = request.headers["x-emby-token"];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ Id: "foreign-server-id" }));
  });
  await Promise.all([
    new Promise((resolve) => primary.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve)),
  ]);
  const service = new EmbyService({
    version: "2.4.0",
    deviceId: "route-mismatch-device",
    ffmpegPath: ffmpeg,
  });
  try {
    await assert.rejects(
      service.login({
        serverUrls: [
          `http://127.0.0.1:${primary.address().port}/emby`,
          `http://127.0.0.1:${foreign.address().port}/emby`,
        ],
        username: "Viewer",
        password: "",
        allowInsecure: true,
      }),
      /另一台 Emby 服务器/u,
    );
    assert.equal(foreignToken, undefined);
    assert.throws(() => service.exportSession(), /请先登录 Emby/u);
  } finally {
    await service.logout().catch(() => undefined);
    await Promise.all([
      new Promise((resolve) => primary.close(resolve)),
      new Promise((resolve) => foreign.close(resolve)),
    ]);
  }
});

test("decodes BOM-marked legacy subtitle text", () => {
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("中文字幕", "utf16le"),
  ]);
  assert.equal(decodeSubtitleBuffer(bytes), "中文字幕");
});

test("never follows a password-bearing login redirect to another origin", async () => {
  let leakedRequests = 0;
  const foreign = http.createServer((_request, response) => {
    leakedRequests += 1;
    response.writeHead(500).end();
  });
  await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const foreignAddress = foreign.address();
  const origin = http.createServer((_request, response) => {
    response.writeHead(307, {
      location: `http://127.0.0.1:${foreignAddress.port}/capture`,
    });
    response.end();
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  const service = new EmbyService({
    version: "1.0.0",
    deviceId: "test-device",
    ffmpegPath: ffmpeg,
  });
  try {
    await assert.rejects(
      service.login({
        serverUrl: `http://127.0.0.1:${originAddress.port}`,
        username: "Readonly",
        password: "must-not-leak",
        allowInsecure: true,
      }),
      /拒绝把 Emby 认证请求重定向/,
    );
    assert.equal(leakedRequests, 0);
  } finally {
    await service.destroy();
    await new Promise((resolve) => origin.close(resolve));
    await new Promise((resolve) => foreign.close(resolve));
  }
});

test("rewrites HLS media and key URIs through the token-hiding loopback proxy", () => {
  const rewritten = rewriteManifest(
    [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="/keys/key.bin"',
      "segment-1.ts",
      "https://cdn.example/segment-2.ts",
    ].join("\n"),
    "http://127.0.0.1:40000",
    "/secret",
    "https://nas.local/emby/hls/master.m3u8",
  );
  assert.match(rewritten, /127\.0\.0\.1:40000\/secret\/__url\//);
  assert.doesNotMatch(rewritten, /cdn\.example/);
});

test("recognizes and rewrites .m3u8 manifests with a generic content type", async () => {
  assert.equal(
    isHlsManifestResponse(
      "application/octet-stream",
      "https://nas.local/emby/master.m3u8?token=hidden",
    ),
    true,
  );
  const upstream = http.createServer((request, response) => {
    if (request.url.startsWith("/hls/master.m3u8")) {
      const manifest =
        "#EXTM3U\n#EXTINF:2,\nsegment-1.ts\n#EXTINF:2,\nhttp://169.254.169.254/latest/meta-data\n";
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": Buffer.byteLength(manifest),
      });
      response.end(manifest);
      return;
    }
    if (request.url.startsWith("/hls/segment-1.ts")) {
      response.writeHead(200, { "content-type": "video/mp2t" });
      response.end("segment-data");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  const upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;
  const proxy = new EmbyLoopbackProxy({
    serverUrl: new URL(upstreamOrigin),
    token: "host-only-token",
    userId: "user",
    username: "Readonly",
    deviceId: "device",
    version: "1.0.0",
  });
  try {
    await proxy.start();
    const response = await fetch(proxy.urlFor("/hls/master.m3u8"));
    const rewritten = await response.text();
    assert.match(rewritten, new RegExp(`${proxy.origin.replaceAll(".", "\\.")}/`));
    assert.doesNotMatch(rewritten, new RegExp(`${upstreamAddress.port}`));
    assert.doesNotMatch(rewritten, /169\.254\.169\.254/);
    const segmentUrls = rewritten
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"));
    assert.equal(
      await (await fetch(segmentUrls[0])).text(),
      "segment-data",
    );
    assert.equal((await fetch(segmentUrls[1])).status, 404);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("blocks private cross-origin media redirects and never leaks Emby credentials", async () => {
  const token = "origin-scoped-token";
  let originSawToken = false;
  let cdnSawToken = false;
  let cdnSawAuthorization = false;
  const cdn = http.createServer((request, response) => {
    cdnSawToken = Boolean(request.headers["x-emby-token"]);
    cdnSawAuthorization = Boolean(request.headers["x-emby-authorization"]);
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": 4,
    });
    response.end("safe");
  });
  await new Promise((resolve) => cdn.listen(0, "127.0.0.1", resolve));
  const cdnAddress = cdn.address();
  const origin = http.createServer((request, response) => {
    originSawToken = request.headers["x-emby-token"] === token;
    response.writeHead(307, {
      location: `http://127.0.0.1:${cdnAddress.port}/media`,
    });
    response.end();
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  const proxy = new EmbyLoopbackProxy({
    serverUrl: new URL(`http://127.0.0.1:${originAddress.port}`),
    token,
    userId: "user",
    username: "Readonly",
    deviceId: "device",
    version: "1.0.0",
  });
  try {
    await proxy.start();
    const response = await fetch(proxy.urlFor("/stream"));
    assert.equal(response.status, 502);
    assert.equal(originSawToken, true);
    assert.equal(cdnSawToken, false);
    assert.equal(cdnSawAuthorization, false);
  } finally {
    await proxy.close();
    await new Promise((resolve) => origin.close(resolve));
    await new Promise((resolve) => cdn.close(resolve));
  }
});

test("blocks deprecated IPv6 site-local media targets", () => {
  const proxy = new EmbyLoopbackProxy({
    serverUrl: new URL("https://emby.example"),
    token: "site-local-boundary-token",
    userId: "user",
    username: "Readonly",
    deviceId: "device",
    version: "2.8.0",
  });
  assert.match(proxy.urlFor("http://[fec0::1]/private-media"), /\/__blocked$/);
  assert.match(proxy.urlFor("http://[feff::1]/private-media"), /\/__blocked$/);
});

test("parses init data and complete moof+mdat fragments across arbitrary chunks", () => {
  const tkhdBody = Buffer.alloc(16);
  tkhdBody.writeUInt32BE(1, 8);
  const mdhdBody = Buffer.alloc(16);
  mdhdBody.writeUInt32BE(90_000, 8);
  const hdlrBody = Buffer.alloc(12);
  hdlrBody.write("vide", 4, 4, "ascii");
  const tfhdBody = Buffer.alloc(8);
  tfhdBody.writeUInt32BE(1, 0);
  tfhdBody.writeUInt32BE(0, 4);
  const tfdtBody = Buffer.alloc(4);
  tfdtBody.writeUInt32BE(180_000, 0);
  const stream = Buffer.concat([
    box("ftyp", Buffer.from("isom")),
    box(
      "moov",
      box(
        "trak",
        Buffer.concat([
          fullBox("tkhd", 0, tkhdBody),
          box(
            "mdia",
            Buffer.concat([
              fullBox("mdhd", 0, mdhdBody),
              fullBox("hdlr", 0, hdlrBody),
            ]),
          ),
        ]),
      ),
    ),
    box(
      "moof",
      box(
        "traf",
        Buffer.concat([
          fullBox("tfhd", 0x20, tfhdBody),
          fullBox("tfdt", 0, tfdtBody),
        ]),
      ),
    ),
    box("mdat", Buffer.from("payload-one")),
    box("moof"),
    box("mdat", Buffer.from("payload-two")),
  ]);
  const parser = new FragmentedMp4Parser();
  const events = [];
  parser.on("init", (data) => events.push(["init", data]));
  parser.on("fragment", (fragment) => events.push(["fragment", fragment]));
  for (let offset = 0; offset < stream.length; offset += 11) {
    parser.push(stream.subarray(offset, offset + 11));
  }
  assert.equal(events[0][0], "init");
  assert.equal(events.filter(([type]) => type === "fragment").length, 2);
  assert.ok(events[1][1].data.includes(Buffer.from("moof")));
  assert.ok(events[1][1].data.includes(Buffer.from("mdat")));
  assert.equal(events[1][1].mediaTimeMs, 2_000);
  assert.equal(events[1][1].keyframe, true);
});

test("repairs an audio-only tfdt jump inside muxed fMP4 fragments", () => {
  const videoTrackId = 1;
  const audioTrackId = 2;
  const videoTimescale = 90_000;
  const audioTimescale = 48_000;
  const fragments = [
    timelineFragment(
      [
        { trackId: videoTrackId, decodeTime: 0 },
        { trackId: audioTrackId, decodeTime: 0 },
      ],
      "fragment-one",
    ),
    timelineFragment(
      [
        { trackId: videoTrackId, decodeTime: 67_500 },
        { trackId: audioTrackId, decodeTime: 36_000 },
      ],
      "fragment-two",
    ),
    timelineFragment(
      [
        { trackId: videoTrackId, decodeTime: 135_000 },
        { trackId: audioTrackId, decodeTime: 2_400_000 },
      ],
      "fragment-three",
    ),
    timelineFragment(
      [
        { trackId: videoTrackId, decodeTime: 202_500 },
        { trackId: audioTrackId, decodeTime: 2_436_000 },
      ],
      "fragment-four",
    ),
  ];
  const parser = new FragmentedMp4Parser();
  const completed = [];
  parser.on("fragment", (fragment) => completed.push(fragment));
  parser.push(
    Buffer.concat([
      box("ftyp", Buffer.from("isom")),
      box(
        "moov",
        Buffer.concat([
          timelineTrack("vide", videoTrackId, videoTimescale),
          timelineTrack("soun", audioTrackId, audioTimescale),
        ]),
      ),
      ...fragments,
    ]),
  );

  assert.equal(completed.length, 4);
  assert.deepEqual(completed[0].timelineRepairs, []);
  assert.deepEqual(completed[1].timelineRepairs, []);
  assert.deepEqual(completed[2].timelineRepairs, [
    {
      sequence: 3,
      trackId: audioTrackId,
      trackType: "soun",
      rawTimeMs: 50_000,
      timelineTimeMs: 1_500,
      timestampOffsetMs: -48_500,
    },
  ]);
  assert.deepEqual(completed[3].timelineRepairs, []);
  assert.equal(
    fragmentTfdtMs(completed[2].data, audioTrackId, audioTimescale),
    1_500,
  );
  assert.equal(
    fragmentTfdtMs(completed[3].data, audioTrackId, audioTimescale),
    2_250,
  );
  assert.equal(
    fragmentTfdtMs(completed[3].data, videoTrackId, videoTimescale),
    2_250,
  );
});

test("drops an orphaned moof before pairing the next moof with mdat", () => {
  const parser = new FragmentedMp4Parser();
  const warnings = [];
  const fragments = [];
  parser.on("warning", (warning) => warnings.push(warning));
  parser.on("fragment", (fragment) => fragments.push(fragment));
  parser.push(
    Buffer.concat([
      box("ftyp", Buffer.from("isom")),
      box("moov"),
      box("moof", box("free", Buffer.from("orphan"))),
      box("moof", box("free", Buffer.from("current"))),
      box("mdat", Buffer.from("payload")),
    ]),
  );
  assert.deepEqual(warnings.map(({ code }) => code), ["orphaned-moof"]);
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].data.includes(Buffer.from("orphan")), false);
  assert.equal(fragments[0].data.includes(Buffer.from("current")), true);
  assert.equal(fragments[0].data.includes(Buffer.from("payload")), true);
});

test("waits for EOF before consuming a size-zero mdat split across pushes", () => {
  const parser = new FragmentedMp4Parser();
  const fragments = [];
  parser.on("fragment", (fragment) => fragments.push(fragment));
  const stream = Buffer.concat([
    box("ftyp", Buffer.from("isom")),
    box("moov"),
    box("moof"),
    boxToEof("mdat", Buffer.from("to-eof-payload")),
  ]);
  const splitAt = stream.length - 5;
  parser.push(stream.subarray(0, splitAt));
  assert.equal(fragments.length, 0);
  parser.push(stream.subarray(splitAt));
  assert.equal(fragments.length, 0);
  parser.finish();
  assert.equal(fragments.length, 1);
  assert.equal(
    fragments[0].data.includes(Buffer.from("to-eof-payload")),
    true,
  );
});

test("detects codecs only through structured stsd sample entries", () => {
  const avcInit = Buffer.concat([
    box("ftyp", Buffer.from("isom")),
    box(
      "moov",
      Buffer.concat([
        box("udta", Buffer.from("misleading hvc1 and mp4a comment")),
        sampleTrack("vide", [
          videoSampleEntry("avc1", "avcC", [1, 0x42, 0xe0, 0x1e]),
        ]),
      ]),
    ),
  ]);
  assert.equal(
    detectMp4Mime(avcInit, "hevc", true),
    'video/mp4; codecs="avc1.42E01E"',
  );

  const hevcInit = Buffer.concat([
    box("ftyp", Buffer.from("isom")),
    box(
      "moov",
      Buffer.concat([
        box("udta", Buffer.from("misleading avcC bytes")),
        sampleTrack("vide", [
          videoSampleEntry("hvc1", "hvcC", [1, 1, 0, 0]),
        ]),
        sampleTrack("soun", [box("mp4a", Buffer.alloc(28))]),
      ]),
    ),
  ]);
  assert.equal(
    detectMp4Mime(hevcInit, "h264", true),
    'video/mp4; codecs="hvc1.1.6.L120.B0, mp4a.40.2"',
  );
});

test("stopStream terminates FFmpeg without waiting for hanging playback telemetry", async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4321;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this.signals = [];
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }

    kill(signal) {
      this.killed = true;
      this.signals.push(signal);
      setImmediate(() => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
      });
      return true;
    }
  }

  const events = [];
  const child = new FakeChild();
  let telemetryPipeline;
  let proxyClosed = false;
  const service = new EmbyService({
    ffmpegPath: ffmpeg,
    sendEvent: (event) => events.push(event),
  });
  service.pipeline = {
    id: "pipeline-stop",
    child,
    proxy: {
      async close() {
        proxyClosed = true;
      },
    },
    plan: { public: {} },
    stopping: false,
    stopReported: false,
    lastPositionTicks: 123,
  };
  service.reportPlayback = () => {
    telemetryPipeline = service.pipeline?.id;
    return new Promise(() => {});
  };

  let timeout;
  try {
    await Promise.race([
      service.stopStream("test-stop"),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("stopStream waited for telemetry")),
          250,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }

  assert.equal(telemetryPipeline, "pipeline-stop");
  assert.equal(service.pipeline, undefined);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(proxyClosed, true);
  assert.deepEqual(
    events.map(({ type, pipelineId }) => [type, pipelineId]),
    [["stopped", "pipeline-stop"]],
  );
});

test("late renderer teardown cannot stop or pause a replacement pipeline", async () => {
  const service = new EmbyService();
  const stdout = {
    pauseCalls: 0,
    resumeCalls: 0,
    pause() {
      this.pauseCalls += 1;
    },
    resume() {
      this.resumeCalls += 1;
    },
  };
  const replacement = {
    id: "pipeline-replacement",
    paused: false,
    stopping: false,
    child: { stdout },
  };
  service.pipeline = replacement;
  service.streamGeneration = 7;

  service.setFlowPaused(true, "pipeline-stale");
  await service.stopStream("late-renderer-stop", {
    expectedPipelineId: "pipeline-stale",
  });

  assert.equal(service.pipeline, replacement);
  assert.equal(service.streamGeneration, 7);
  assert.equal(replacement.paused, false);
  assert.equal(stdout.pauseCalls, 0);
  assert.equal(stdout.resumeCalls, 0);
});

test("a stop during delayed planning prevents a late FFmpeg pipeline", async () => {
  const service = new EmbyService({
    version: "2.4.0",
    deviceId: "cancel-delayed-start",
    ffmpegPath: ffmpeg,
  });
  let releasePlan;
  let planningStarted;
  const enteredPlanning = new Promise((resolve) => {
    planningStarted = resolve;
  });
  service.buildPlan = async () => {
    planningStarted();
    return new Promise((resolve) => {
      releasePlan = resolve;
    });
  };
  const starting = service.startStream({
    itemId: "delayed-item",
    quality: "1080p-8",
  });
  await enteredPlanning;
  await service.stopStream("start-timeout");
  releasePlan({});
  await assert.rejects(starting, /已被停止或替代/u);
  assert.equal(service.pipeline, undefined);
});

test("an FFmpeg pipeline that never emits init is terminated by the startup watchdog", async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 9123;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this.stdout = Object.assign(new EventEmitter(), {
        pause() {},
        resume() {},
      });
      this.stderr = new EventEmitter();
    }

    kill(signal) {
      if (this.killed) return true;
      this.killed = true;
      this.signalCode = signal;
      setImmediate(() => {
        this.emit("exit", null, signal);
        this.emit("close", null, signal);
      });
      return true;
    }
  }

  const child = new FakeChild();
  const events = [];
  const service = new EmbyService({
    version: "2.6.0",
    deviceId: "init-watchdog-device",
    streamInitTimeoutMs: 500,
    spawnProcess: () => child,
    sendEvent: (event) => events.push(event),
  });
  service.restoreSession({
    serverUrl: "http://127.0.0.1:65534",
    token: "init-watchdog-token",
    userId: "init-watchdog-user",
    username: "Viewer",
    insecure: true,
  });
  service.buildPlan = async () => ({
    internal: {
      upstreamPath: "/Videos/movie/stream",
      source: {},
      video: { Index: 0 },
      audio: undefined,
      subtitle: undefined,
    },
    public: {
      itemId: "movie",
      mediaSourceId: "source",
      playSessionId: "play-session",
      method: "DirectPlay",
      quality: "original",
      videoCodec: "h264",
      audioCodec: undefined,
      localAudioTranscode: false,
      subtitleMode: "none",
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
      startTimeTicks: 0,
    },
  });
  service.reportPlayback = async () => undefined;
  try {
    await service.startStream({ itemId: "movie", quality: "original" });
    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      (!events.some((event) => event.type === "error") || service.pipeline)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(
      events.find((event) => event.type === "error")?.message || "",
      /初始化超时/u,
    );
    assert.equal(service.pipeline, undefined);
    assert.equal(child.killed, true);
  } finally {
    await service.destroy();
  }
});

test("force-terminates an unresponsive FFmpeg process tree on Windows", async () => {
  class FakeChild extends EventEmitter {
    constructor(pid) {
      super();
      this.pid = pid;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this.signals = [];
    }

    kill(signal) {
      this.killed = true;
      this.signals.push(signal);
      return true;
    }
  }

  const child = new FakeChild(4321);
  const calls = [];
  const exited = await terminateChildProcess(child, {
    platform: "win32",
    gracefulTimeoutMs: 5,
    forceCommandTimeoutMs: 50,
    forceWaitMs: 50,
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const killer = new FakeChild(9876);
      setImmediate(() => {
        child.signalCode = "SIGKILL";
        child.emit("exit", null, "SIGKILL");
        killer.exitCode = 0;
        killer.emit("exit", 0, null);
      });
      return killer;
    },
  });
  assert.equal(exited, true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(calls[0].command, "taskkill");
  assert.deepEqual(calls[0].args, ["/PID", "4321", "/T", "/F"]);
  assert.equal(calls[0].options.windowsHide, true);
});

test("uses SIGKILL after the graceful timeout on non-Windows systems", async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  const signals = [];
  child.kill = (signal) => {
    child.killed = true;
    signals.push(signal);
    if (signal === "SIGKILL") {
      setImmediate(() => {
        child.signalCode = "SIGKILL";
        child.emit("exit", null, "SIGKILL");
      });
    }
    return true;
  };
  assert.equal(
    await terminateChildProcess(child, {
      platform: "linux",
      gracefulTimeoutMs: 5,
      forceWaitMs: 50,
    }),
    true,
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("uses the requested total-send quality ceilings", () => {
  assert.equal(qualityProfile("4k-18").maxBitrate, 18_000_000);
  assert.equal(qualityProfile("1440p-18").maxHeight, 1440);
  assert.equal(qualityProfile("1440p-18").maxWidth, 2560);
  assert.equal(qualityProfile("1440p-18").maxBitrate, 18_000_000);
  assert.equal(qualityProfile("1080p-8").maxHeight, 1080);
  assert.equal(qualityProfile("unknown").key, "1080p-12");
  assert.equal(qualityProfile("480p-2.5").maxBitrate, 2_500_000);
  assert.equal(qualityProfile("360p-1.2").maxBitrate, 1_200_000);
  assert.equal(qualityProfile("360p-1.2").maxHeight, 360);
  const profile = buildDeviceProfile(qualityProfile("4k-18"), true);
  assert.match(profile.DirectPlayProfiles[0].VideoCodec, /hevc/);
  assert.equal(profile.TranscodingProfiles[0].Protocol, "hls");
  assert.equal(profile.TranscodingProfiles[0].Container, "mp4");
  const compatibilityProfile = buildDeviceProfile(
    qualityProfile("1080p-8"),
    false,
    true,
  );
  assert.equal(compatibilityProfile.TranscodingProfiles[0].Container, "ts");
  assert.equal(profile.MaxStreamingBitrate, 18_000_000);
  assert.ok(
    profile.CodecProfiles[0].Conditions.some(
      (condition) =>
        condition.Property === "VideoBitDepth" && condition.Value === "8",
    ),
  );
  assert.ok(
    profile.CodecProfiles[0].Conditions.some(
      (condition) =>
        condition.Property === "VideoFramerate" &&
        condition.Value === "30",
    ),
  );
  const highFrameProfile = buildDeviceProfile(
    qualityProfile("1080p-12"),
    false,
    false,
    60,
  );
  assert.ok(
    highFrameProfile.CodecProfiles[0].Conditions.some(
      (condition) =>
        condition.Property === "VideoFramerate" &&
        condition.Value === "60",
    ),
  );
  for (const format of ["pgs", "pgssub", "dvdsub", "dvbsub", "vobsub"]) {
    assert.ok(
      profile.SubtitleProfiles.some(
        (subtitle) =>
          subtitle.Format === format && subtitle.Method === "Encode",
      ),
      `${format} must request Emby burn-in`,
    );
  }
});

test("rejects browser-incompatible AVC profiles before DirectPlay", () => {
  assert.equal(
    browserDirectVideoCompatible(
      { BitDepth: 10, Profile: "High 10", PixelFormat: "yuv420p10le" },
      "h264",
      false,
    ),
    false,
  );
  assert.equal(
    browserDirectVideoCompatible(
      { BitDepth: 8, Profile: "High", PixelFormat: "yuv420p" },
      "h264",
      false,
    ),
    true,
  );
  assert.equal(
    browserDirectVideoCompatible(
      { BitDepth: 10, Profile: "Main 10", PixelFormat: "yuv420p10le" },
      "hevc",
      true,
    ),
    true,
  );
  assert.equal(
    browserDirectVideoCompatible(
      { BitDepth: 10, Profile: "Main 4:2:2 10", PixelFormat: "yuv422p10le" },
      "hevc",
      true,
    ),
    false,
  );
});

test("normalizes HE-AAC and multichannel audio while preserving AAC-LC stereo", () => {
  assert.equal(
    browserDirectAudioCompatible(
      { Codec: "aac", Profile: "LC", Channels: 2 },
      "aac",
    ),
    true,
  );
  assert.equal(
    browserDirectAudioCompatible(
      { Codec: "aac", Profile: "HE-AAC", Channels: 2 },
      "aac",
    ),
    false,
  );
  assert.equal(
    browserDirectAudioCompatible(
      { Codec: "aac", Profile: "LC", Channels: 6 },
      "aac",
    ),
    false,
  );
  assert.equal(
    browserDirectAudioCompatible(
      { Codec: "flac", Channels: 2 },
      "flac",
    ),
    false,
  );
});

test("chooses Direct Stream, HEVC Direct Play, or one normalized Emby transcode without local video encoding", () => {
  const options = {
    itemId: "movie",
    userId: "user",
    deviceId: "device",
  };
  const mkvDts = {
    MediaSources: [
      {
        Id: "mkv",
        Bitrate: 20_000_000,
        SupportsDirectStream: true,
        DirectStreamUrl: "/Videos/movie/stream.mp4",
        MediaStreams: [
          { Index: 0, Type: "Video", Codec: "h264" },
          { Index: 1, Type: "Audio", Codec: "dts", IsDefault: true },
        ],
      },
    ],
  };
  const directStream = chooseSource(
    mkvDts,
    options,
    qualityProfile("original"),
  );
  assert.equal(directStream.method, "DirectStream");
  assert.equal(directStream.videoCodec, "h264");
  assert.equal(directStream.localAudioTranscode, true);

  const hevc = {
    MediaSources: [
      {
        Id: "hevc",
        Bitrate: 15_000_000,
        SupportsDirectPlay: true,
        TranscodingUrl: "/Videos/movie/master.m3u8",
        MediaStreams: [
          { Index: 0, Type: "Video", Codec: "hevc" },
          { Index: 1, Type: "Audio", Codec: "aac", IsDefault: true },
        ],
      },
    ],
  };
  assert.equal(
    chooseSource(
      hevc,
      { ...options, allowHevc: true },
      qualityProfile("original"),
    ).method,
    "DirectPlay",
  );
  assert.equal(
    chooseSource(
      hevc,
      { ...options, allowHevc: true, forceVideoTranscode: true },
      qualityProfile("original"),
    ).method,
    "Transcode",
  );
  const transcoded = chooseSource(
    hevc,
    options,
    qualityProfile("1080p-8"),
  );
  assert.equal(transcoded.method, "Transcode");
  assert.equal(transcoded.videoCodec, "h264");
  assert.equal(transcoded.audioCodec, "aac");
  assert.equal(
    transcoded.localAudioTranscode,
    true,
    "server transcodes are normalized to AAC-LC stereo for Android WebView",
  );

  const pgs = {
    MediaSources: [
      {
        Id: "bluray",
        Bitrate: 14_000_000,
        SupportsDirectPlay: true,
        TranscodingUrl: "/Videos/movie/master.m3u8",
        MediaStreams: [
          { Index: 0, Type: "Video", Codec: "h264" },
          { Index: 1, Type: "Audio", Codec: "aac", IsDefault: true },
          { Index: 2, Type: "Subtitle", Codec: "pgssub" },
        ],
      },
    ],
  };
  const burned = chooseSource(
    pgs,
    { ...options, subtitleStreamIndex: 2 },
    qualityProfile("original"),
  );
  assert.equal(burned.method, "Transcode");
  assert.equal(burned.subtitleMode, "burn-in");
});

test("caps direct playback at the requested source-aware frame rate", () => {
  const playback = {
    MediaSources: [
      {
        Id: "sixty-fps",
        Bitrate: 8_000_000,
        SupportsDirectPlay: true,
        TranscodingUrl: "/Videos/movie/master.m3u8",
        MediaStreams: [
          {
            Index: 0,
            Type: "Video",
            Codec: "h264",
            RealFrameRate: 60,
          },
          {
            Index: 1,
            Type: "Audio",
            Codec: "aac",
            Channels: 2,
            IsDefault: true,
          },
        ],
      },
    ],
  };
  const options = {
    itemId: "movie",
    userId: "user",
    deviceId: "device",
  };
  assert.equal(
    chooseSource(
      playback,
      { ...options, frameRate: 60 },
      qualityProfile("original"),
    ).method,
    "DirectPlay",
  );
  assert.equal(
    chooseSource(
      playback,
      { ...options, frameRate: 24 },
      qualityProfile("original"),
    ).method,
    "Transcode",
  );
});

test("falls back to a bounded authenticated local transcode when Emby returns no transcode URL", () => {
  const options = {
    itemId: "movie/with unsafe separators",
    mediaSourceId: "source",
    userId: "user",
    deviceId: "device",
  };
  const noServerTranscode = {
    MediaSources: [
      {
        Id: "source",
        Bitrate: 46_000_000,
        SupportsDirectPlay: true,
        SupportsDirectStream: false,
        MediaStreams: [
          {
            Index: 0,
            Type: "Video",
            Codec: "hevc",
            Width: 3_840,
            Height: 2_160,
            BitDepth: 10,
          },
          {
            Index: 1,
            Type: "Audio",
            Codec: "truehd",
            Channels: 8,
            IsDefault: true,
          },
        ],
      },
    ],
  };
  const quality = qualityProfile("480p-2.5");

  assert.throws(
    () => chooseSource(noServerTranscode, options, quality),
    /没有返回 480P/u,
    "the first negotiation may still request a server-side compatibility transcode",
  );
  const local = chooseSource(
    noServerTranscode,
    {
      ...options,
      forceVideoTranscode: true,
      allowLocalVideoTranscode: true,
    },
    quality,
  );
  assert.equal(local.method, "Transcode");
  assert.equal(local.localVideoTranscode, true);
  assert.equal(local.localAudioTranscode, true);
  assert.equal(local.videoCodec, "h264");
  assert.equal(local.audioCodec, "aac");
  assert.equal(local.upstreamPreservesSourceIndexes, true);
  assert.match(local.upstreamPath, /^\/Videos\/movie%2Fwith%20unsafe%20separators\/stream\?/u);
  assert.doesNotMatch(local.upstreamPath, /token|api_?key/u);
});

test("uses an already compatible source instead of needlessly encoding a safe low-bitrate fallback", () => {
  const direct = chooseSource(
    {
      MediaSources: [
        {
          Id: "safe-source",
          Bitrate: 1_100_000,
          SupportsDirectPlay: true,
          MediaStreams: [
            {
              Index: 0,
              Type: "Video",
              Codec: "h264",
              Width: 640,
              Height: 360,
              BitDepth: 8,
            },
            {
              Index: 1,
              Type: "Audio",
              Codec: "aac",
              Profile: "LC",
              Channels: 2,
            },
          ],
        },
      ],
    },
    {
      itemId: "movie",
      userId: "user",
      deviceId: "device",
      forceVideoTranscode: true,
      allowLocalVideoTranscode: true,
    },
    qualityProfile("480p-2.5"),
  );

  assert.equal(direct.method, "DirectPlay");
  assert.equal(direct.localVideoTranscode, false);
  assert.equal(direct.localAudioTranscode, false);
  assert.equal(direct.upstreamPreservesSourceIndexes, true);
});

test("buildPlan retries Emby once, then selects local H.264/AAC within the chosen ceiling", async () => {
  const service = new EmbyService();
  service.restoreSession({
    serverUrl: "http://127.0.0.1:8096",
    token: "test-token",
    userId: "user",
    username: "tester",
    insecure: true,
  });
  const calls = [];
  service.rawPlaybackInfo = async (input) => {
    calls.push({ ...input });
    return {
      quality: qualityProfile(input.quality),
      data: {
        PlaySessionId: "play-session",
        MediaSources: [
          {
            Id: "source",
            Bitrate: 46_000_000,
            RunTimeTicks: 600_000_000,
            SupportsDirectPlay: true,
            MediaStreams: [
              {
                Index: 0,
                Type: "Video",
                Codec: "hevc",
                Width: 3_840,
                Height: 2_160,
                BitDepth: 10,
              },
              {
                Index: 1,
                Type: "Audio",
                Codec: "truehd",
                Channels: 8,
                IsDefault: true,
              },
            ],
          },
        ],
      },
    };
  };

  const plan = await service.buildPlan({
    itemId: "movie",
    quality: "480p-2.5",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].forceVideoTranscode, true);
  assert.equal(calls[1].preferMpegTs, true);
  assert.equal(plan.public.method, "Transcode");
  assert.equal(plan.public.localVideoTranscode, true);
  assert.equal(plan.public.localAudioTranscode, true);
  assert.equal(plan.public.videoCodec, "h264");
  assert.equal(plan.public.audioCodec, "aac");
  assert.equal(plan.public.width, 854);
  assert.equal(plan.public.height, 480);
  assert.equal(plan.public.frameRate, 30);
  assert.equal(plan.public.bitrate, 2_500_000);
  assert.ok(plan.internal.localEncoding.videoBitrate < 2_500_000);
  assert.ok(
    plan.internal.localEncoding.videoBitrate +
      plan.internal.localEncoding.audioBitrate <
      2_500_000,
  );

  const cappedOriginal = await service.buildPlan({
    itemId: "movie",
    quality: "original",
  });
  assert.equal(cappedOriginal.public.localVideoTranscode, true);
  assert.equal(cappedOriginal.public.width, 1_920);
  assert.equal(cappedOriginal.public.height, 1_080);
  assert.equal(cappedOriginal.public.bitrate, 12_000_000);
});

test("local fallback FFmpeg arguments encode H.264/AAC without exposing Emby credentials", async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 7312;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this.stdout = Object.assign(new EventEmitter(), {
        pause() {},
        resume() {},
      });
      this.stderr = new EventEmitter();
    }

    kill(signal) {
      if (this.killed) return true;
      this.killed = true;
      this.signalCode = signal;
      setImmediate(() => {
        this.emit("exit", null, signal);
        this.emit("close", null, signal);
      });
      return true;
    }
  }

  const token = "must-never-reach-ffmpeg";
  let spawned;
  const child = new FakeChild();
  const service = new EmbyService({
    ffmpegPath: ffmpeg,
    spawnProcess(command, args, options) {
      spawned = { command, args, options };
      return child;
    },
  });
  service.restoreSession({
    serverUrl: "http://127.0.0.1:8096",
    token,
    userId: "user",
    username: "tester",
    insecure: true,
  });
  service.reportPlayback = async () => undefined;
  service.buildPlan = async () => ({
    internal: {
      upstreamPath:
        "/Videos/movie/stream?Static=true&MediaSourceId=source&UserId=user",
      source: {},
      video: { Index: 0 },
      audio: { Index: 1 },
      subtitle: undefined,
      localVideoTranscode: true,
      upstreamPreservesSourceIndexes: true,
      localEncoding: {
        maxBitrate: 2_500_000,
        maxWidth: 854,
        maxHeight: 480,
        videoBitrate: 2_200_000,
        audioBitrate: 200_000,
        frameRate: 23.976,
      },
    },
    public: {
      itemId: "movie",
      mediaSourceId: "source",
      playSessionId: "play-session",
      method: "Transcode",
      quality: qualityProfile("480p-2.5"),
      videoCodec: "h264",
      audioCodec: "aac",
      localVideoTranscode: true,
      localAudioTranscode: true,
      subtitleMode: "none",
      width: 854,
      height: 480,
      frameRate: 23.976,
      bitrate: 2_500_000,
      startTimeTicks: 10_000_000,
    },
  });

  try {
    await service.startStream({
      itemId: "movie",
      quality: "480p-2.5",
      frameRate: 24,
    });
    const joined = spawned.args.join(" ");
    assert.equal(spawned.command, ffmpeg);
    assert.doesNotMatch(joined, new RegExp(token));
    assert.match(joined, /-ss 1\.000 -i http:\/\/127\.0\.0\.1:/u);
    assert.match(joined, /-map 0:0 -map 0:1/u);
    assert.match(joined, /-c:v libopenh264/u);
    assert.match(joined, /scale=.*854.*480/u);
    assert.match(joined, /fps=23\.976/u);
    assert.match(joined, /-profile:v high/u);
    assert.match(joined, /-b:v 2200000/u);
    assert.match(joined, /-maxrate 2200000/u);
    assert.match(joined, /-bufsize 4400000/u);
    assert.match(joined, /-c:a aac .* -b:a 200000 -ac 2/u);
    assert.doesNotMatch(joined, /-c:v copy/u);
    assert.doesNotMatch(joined, /https?:\/\/[^ ]*emby-token/iu);
  } finally {
    await service.stopStream("test-complete");
    service.session = undefined;
  }
});

test("retries image subtitles with forced Emby video transcoding", async () => {
  const service = new EmbyService();
  service.restoreSession({
    serverUrl: "http://127.0.0.1:8096",
    token: "test-token",
    userId: "user",
    username: "tester",
    insecure: true,
  });
  const calls = [];
  service.rawPlaybackInfo = async (input) => {
    calls.push({ ...input });
    return {
      quality: qualityProfile("original"),
      data: {
        PlaySessionId: "play-session",
        MediaSources: [
          {
            Id: "bluray",
            Bitrate: 14_000_000,
            RunTimeTicks: 60_000_000,
            SupportsDirectPlay: true,
            TranscodingUrl: input.forceVideoTranscode
              ? "/Videos/movie/master.m3u8"
              : undefined,
            MediaStreams: [
              {
                Index: 0,
                Type: "Video",
                Codec: "h264",
                Width: 1920,
                Height: 1080,
              },
              { Index: 1, Type: "Audio", Codec: "aac", IsDefault: true },
              {
                Index: 2,
                Type: "Subtitle",
                Codec: "pgssub",
                IsTextSubtitleStream: false,
              },
            ],
          },
        ],
      },
    };
  };

  const plan = await service.buildPlan({
    itemId: "movie",
    mediaSourceId: "bluray",
    quality: "original",
    subtitleStreamIndex: 2,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].forceVideoTranscode, true);
  assert.equal(calls[1].preferMpegTs, true);
  assert.equal(plan.public.method, "Transcode");
  assert.equal(plan.public.subtitleMode, "burn-in");
});

test("logs in, browses, remuxes one authenticated stream, and never exposes the token", async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "yiqikan-emby-"));
  const source = path.join(temporary, "source.mp4");
  const token = "host-only-secret-token";
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "4",
      "-c:v",
      "libopenh264",
      "-b:v",
      "900k",
      "-g",
      "240",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-pix_fmt",
      "yuv420p",
      source,
      "-y",
    ],
    { windowsHide: true },
  );

  const received = [];
  const mediaRequests = [];
  const playbackAutoOpen = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const json = (value) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/Users/AuthenticateByName") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        assert.equal(JSON.parse(body).Pw, "temporary-password");
        json({
          AccessToken: token,
          User: { Id: "user-1", Name: "Readonly" },
        });
      });
      return;
    }
    if (url.pathname !== "/System/Info/Public") {
      if (request.headers["x-emby-token"]) {
        received.push(request.headers["x-emby-token"]);
      }
    }
    if (url.pathname === "/System/Info") {
      json({ ServerName: "Mock Emby", Version: "4.8.0" });
    } else if (url.pathname === "/Users/user-1/Views") {
      json({ Items: [{ Id: "movies", Name: "Movies", Type: "CollectionFolder" }] });
    } else if (url.pathname === "/Users/user-1/Items") {
      json({
        TotalRecordCount: 1,
        Items: [
          {
            Id: "movie-1",
            Name: "Fixture Movie",
            Type: "Movie",
            RunTimeTicks: 40_000_000,
          },
        ],
      });
    } else if (url.pathname === "/Items/movie-1/PlaybackInfo") {
      playbackAutoOpen.push(url.searchParams.get("AutoOpenLiveStream"));
      json({
        PlaySessionId: "play-session-1",
        MediaSources: [
          {
            Id: "source-1",
            Name: "MP4",
            Container: "mp4",
            // Report a bitrate above the 480p ceiling so the same fixture can
            // exercise the local video-transcode fallback below.
            Bitrate: 3_100_000,
            RunTimeTicks: 40_000_000,
            SupportsDirectPlay: true,
            SupportsDirectStream: true,
            MediaStreams: [
              {
                Index: 0,
                Type: "Video",
                Codec: "h264",
                Width: 640,
                Height: 360,
                BitRate: 900_000,
              },
              {
                Index: 1,
                Type: "Audio",
                Codec: "aac",
                Channels: 2,
                BitRate: 128_000,
                IsDefault: true,
              },
            ],
          },
        ],
      });
    } else if (url.pathname === "/Videos/movie-1/stream") {
      const size = statSync(source).size;
      const rangeMatch = /^bytes=(\d+)-(\d*)$/i.exec(
        String(request.headers.range || ""),
      );
      const start = rangeMatch ? Number(rangeMatch[1]) : 0;
      const end =
        rangeMatch && rangeMatch[2]
          ? Math.min(Number(rangeMatch[2]), size - 1)
          : size - 1;
      mediaRequests.push({
        method: request.method,
        range: request.headers.range || "",
        start,
        end,
      });
      response.writeHead(rangeMatch ? 206 : 200, {
        "content-type": "video/mp4",
        "content-length": end - start + 1,
        ...(rangeMatch
          ? { "content-range": `bytes ${start}-${end}/${size}` }
          : {}),
        "accept-ranges": "bytes",
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        createReadStream(source, { start, end }).pipe(response);
      }
    } else if (
      [
        "/Sessions/Playing",
        "/Sessions/Playing/Progress",
        "/Sessions/Playing/Stopped",
        "/Sessions/Logout",
      ].includes(url.pathname)
    ) {
      response.writeHead(204).end();
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const events = [];
  const service = new EmbyService({
    version: "1.0.0",
    deviceId: "test-device-123456",
    ffmpegPath: ffmpeg,
    sendEvent: (event) => events.push(event),
  });
  try {
    const login = await service.login({
      serverUrl: `http://127.0.0.1:${address.port}`,
      username: "Readonly",
      password: "temporary-password",
      allowInsecure: true,
    });
    assert.equal(login.server.name, "Mock Emby");
    assert.equal((await service.listViews())[0].name, "Movies");
    assert.equal((await service.listItems()).items[0].name, "Fixture Movie");
    await service.playbackInfo({
      itemId: "movie-1",
      quality: "original",
    });
    assert.equal(
      playbackAutoOpen.at(-1),
      "false",
      "library preview must not allocate an Emby live/transcode session",
    );
    const proxyProbe = new EmbyLoopbackProxy(service.session);
    await proxyProbe.start();
    const proxied = Buffer.from(
      await (
        await fetch(proxyProbe.urlFor("/Videos/movie-1/stream?Static=true"))
      ).arrayBuffer(),
    );
    await proxyProbe.close();
    assert.deepEqual(proxied, readFileSync(source));
    const safeFallback = await service.buildPlan({
      itemId: "movie-1",
      quality: "1080p-8",
    });
    assert.equal(safeFallback.public.method, "DirectPlay");
    assert.equal(safeFallback.public.localVideoTranscode, false);
    const started = await service.startStream({
      itemId: "movie-1",
      quality: "original",
      startTimeTicks: 5_000_000,
    });
    assert.equal(started.plan.method, "DirectPlay");
    assert.doesNotMatch(
      service.pipeline.child.spawnargs.join(" "),
      new RegExp(token),
    );
    assert.doesNotMatch(
      service.pipeline.child.spawnargs.join(" "),
      /frag_keyframe/,
    );
    assert.match(
      service.pipeline.child.spawnargs.join(" "),
      /-frag_duration 750000/,
    );
    assert.match(
      service.pipeline.child.spawnargs.join(" "),
      /-frag_size 1500000/,
    );
    assert.match(
      service.pipeline.child.spawnargs.join(" "),
      /-readrate 1\.35 -readrate_initial_burst 12 -readrate_catchup 1\.55/,
    );
    assert.doesNotMatch(
      service.pipeline.child.spawnargs.join(" "),
      /-output_ts_offset/,
    );
    assert.equal(
      playbackAutoOpen.at(-1),
      "true",
      "the actual stream start opens the negotiated media session",
    );
    const deadline = Date.now() + 12_000;
    while (
      Date.now() < deadline &&
      events.filter((event) => event.type === "fragment").length < 3
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const init = events.find((event) => event.type === "init");
    const fragments = events.filter((event) => event.type === "fragment");
    const fragment = fragments[0];
    assert.ok(
      init?.data?.length > 500,
      JSON.stringify(
        {
          events: events.map(({ type, message, reason, data }) => ({
            type,
            message,
            reason,
            bytes: data?.length,
          })),
          mediaRequests,
        },
      ),
    );
    assert.match(init.mimeType, /avc1/i);
    assert.ok(
      fragments.length >= 3,
      "four seconds of media should be split into several transport fragments",
    );
    assert.ok(fragment?.data?.length > 1_000);
    assert.ok(
      fragments.every((event) => event.data.length < 2 * 1024 * 1024),
      "sub-second muxing keeps real-time DataChannel fragments bounded",
    );
    assert.ok(Number.isFinite(fragment.mediaTimeMs));
    assert.equal(fragment.keyframe, true);
    assert.deepEqual([...new Set(received)], [token]);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(token));
    await service.stopStream("test-complete");

    events.length = 0;
    const localStarted = await service.startStream({
      itemId: "movie-1",
      quality: "480p-2.5",
    });
    assert.equal(localStarted.plan.method, "Transcode");
    assert.equal(localStarted.plan.localVideoTranscode, true);
    const localArgs = service.pipeline.child.spawnargs.join(" ");
    assert.match(localArgs, /-c:v libopenh264/u);
    assert.match(localArgs, /-maxrate 2200000/u);
    assert.match(localArgs, /-c:a aac/u);
    assert.doesNotMatch(localArgs, new RegExp(token));
    const localDeadline = Date.now() + 12_000;
    while (
      Date.now() < localDeadline &&
      !events.some((event) => event.type === "fragment")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const localInit = events.find((event) => event.type === "init");
    const localFragment = events.find((event) => event.type === "fragment");
    assert.ok(
      localInit?.data?.length > 500,
      JSON.stringify(
        events.map(({ type, message, reason, data }) => ({
          type,
          message,
          reason,
          bytes: data?.length,
        })),
      ),
    );
    assert.match(localInit.mimeType, /avc1/i);
    assert.ok(localFragment?.data?.length > 1_000);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(token));
    await service.stopStream("local-fallback-complete");
  } finally {
    await service.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(temporary, { recursive: true, force: true });
  }
});
