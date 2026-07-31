const { EventEmitter } = require("events");
const http = require("http");
const { Readable } = require("stream");
const { createHash, randomBytes, randomUUID } = require("crypto");
const { spawn } = require("child_process");
const dns = require("dns").promises;
const fs = require("fs");
const fsp = fs.promises;
const net = require("net");
const path = require("path");
const { version: APP_VERSION } = require("../package.json");

const EMBY_CLIENT = "Synced";
const EMBY_DEVICE = "Synced Desktop";
const REQUEST_TIMEOUT_MS = 20_000;
const PROXY_BODY_IDLE_TIMEOUT_MS = 15_000;
const PROXY_CLOSE_TIMEOUT_MS = 2_500;
const PROXY_RANGE_RETRIES = 2;
const STREAM_INIT_TIMEOUT_MS = 22_000;
const ENDPOINT_PROBE_TIMEOUT_MS = 5_000;
const ENDPOINT_RECENT_SUCCESS_MS = 30_000;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_EMBY_ENDPOINTS = 8;
// The bundled software encoder is the last-resort compatibility path. Capping
// it at 1080p keeps playback responsive on ordinary two- and four-core hosts;
// Emby-provided transcodes and already-compatible direct streams are unaffected.
const MAX_LOCAL_TRANSCODE_BITRATE = 12_000_000;
const MAX_LOCAL_TRANSCODE_WIDTH = 1_920;
const MAX_LOCAL_TRANSCODE_HEIGHT = 1_080;
const RELAY_MEMORY_HIGH_WATER_BYTES = 128 * 1024 * 1024;
const RELAY_MEMORY_LOW_WATER_BYTES = 32 * 1024 * 1024;
const RELAY_MIN_DISK_BYTES = 64 * 1024 * 1024;
const RELAY_MAX_DISK_BYTES = 5 * 1024 * 1024 * 1024;
const RELAY_UPLOAD_CONCURRENCY = 3;
const RELAY_UPLOAD_IDLE_TIMEOUT_MS = 15_000;
const RELAY_UPLOAD_MAX_ATTEMPTS = 3;
const RELAY_FAILED_RETRY_DELAYS_MS = [
  1_000,
  2_000,
  4_000,
  8_000,
  15_000,
  30_000,
];
const RELAY_FAILED_RECORD_RETENTION_MS = 120_000;
const RELAY_FINAL_DRAIN_TIMEOUT_MS = 10_000;
const RELAY_UPLOAD_BUDGET_SHARE = 0.65;
const RELAY_MIN_VIABLE_UPLOAD_BPS = 128_000;
const AUXILIARY_RENDITION_IDLE_MS = 30_000;
const AUXILIARY_RETRY_MAX_MS = 30_000;
const CMAF_MAX_TOTAL_RENDITIONS = 3;
const CMAF_AUXILIARY_RENDITIONS = Object.freeze([
  Object.freeze({
    id: "original",
    quality: "original",
    forceVideoTranscode: false,
    defaultActive: false,
  }),
  Object.freeze({
    id: "1080p8",
    quality: "1080p-8",
    forceVideoTranscode: true,
    defaultActive: false,
  }),
  Object.freeze({
    id: "720p4",
    quality: "720p-4",
    forceVideoTranscode: true,
    defaultActive: true,
  }),
  Object.freeze({
    id: "480p18",
    quality: "480p-1.8",
    forceVideoTranscode: true,
    defaultActive: false,
  }),
]);

function cleanText(value, maxLength = 256) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeServerUrl(input, allowInsecure = false) {
  let parsed;
  try {
    parsed = new URL(cleanText(input, 2_048));
  } catch {
    throw new Error("Emby 服务器地址无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Emby 地址只允许使用 HTTP 或 HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("请不要把用户名或密码写在服务器地址中");
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new Error("此服务器使用未加密 HTTP；确认是可信局域网后勾选允许 HTTP");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed;
}

function endpointIdFor(serverUrl) {
  return createHash("sha256")
    .update(new URL(serverUrl).toString(), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function normalizeEndpointUrls(inputs, allowInsecure = false) {
  const values = Array.isArray(inputs) ? inputs : [inputs];
  const endpoints = [];
  for (const value of values.slice(0, MAX_EMBY_ENDPOINTS)) {
    const url = normalizeServerUrl(value, allowInsecure);
    if (endpoints.some((endpoint) => endpoint.url.toString() === url.toString())) {
      continue;
    }
    endpoints.push({
      id: endpointIdFor(url),
      url,
      label: endpoints.length ? `备用线路 ${endpoints.length}` : "主线路",
      priority: endpoints.length,
    });
  }
  if (!endpoints.length) throw new Error("请至少填写一条 Emby 服务器线路");
  return endpoints;
}

function embyApiBaseCandidates(input) {
  const entered = new URL(input);
  let basePath = entered.pathname.replace(/\/+$/, "");
  const webIndex = basePath.search(/\/web(?:\/|$)/i);
  if (webIndex >= 0) basePath = basePath.slice(0, webIndex);
  basePath = basePath.replace(/\/+$/, "");

  const paths = [];
  const add = (pathname) => {
    const normalized = `/${String(pathname || "").replace(/^\/+|\/+$/g, "")}`;
    const value = normalized === "/" ? "" : normalized;
    if (!paths.some((candidate) => candidate.toLowerCase() === value.toLowerCase())) {
      paths.push(value);
    }
  };
  if (/\/emby$/i.test(basePath)) {
    add(basePath);
    add(basePath.replace(/\/emby$/i, ""));
  } else {
    add(`${basePath}/emby`);
    add(basePath);
  }
  return paths.map((pathname) => {
    const candidate = new URL(entered);
    candidate.pathname = pathname;
    candidate.search = "";
    candidate.hash = "";
    return candidate;
  });
}

function authHeader(deviceId, version) {
  const escape = (value) => String(value).replaceAll('"', "");
  return `MediaBrowser Client="${escape(EMBY_CLIENT)}", Device="${escape(
    EMBY_DEVICE,
  )}", DeviceId="${escape(deviceId)}", Version="${escape(version)}"`;
}

function serverUrlFor(serverUrl, pathOrUrl) {
  const value = String(pathOrUrl || "");
  if (/^https?:\/\//i.test(value)) return new URL(value);
  const [rawPath, rawQuery = ""] = value.split("?", 2);
  const basePath = serverUrl.pathname.replace(/\/+$/, "");
  let pathname = `/${rawPath.replace(/^\/+/, "")}`;
  if (
    basePath &&
    basePath !== "/" &&
    pathname !== basePath &&
    !pathname.startsWith(`${basePath}/`)
  ) {
    pathname = `${basePath}${pathname}`;
  }
  return new URL(
    `${pathname}${rawQuery ? `?${rawQuery}` : ""}`,
    serverUrl.origin,
  );
}

function requestTimeout(timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(250, Number(timeoutMs) || REQUEST_TIMEOUT_MS),
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

const responseDeadlineCleanup = new WeakMap();

function bindResponseDeadline(response, timeout) {
  responseDeadlineCleanup.set(response, timeout.clear);
}

function releaseResponseDeadline(response) {
  const clear = responseDeadlineCleanup.get(response);
  if (!clear) return;
  responseDeadlineCleanup.delete(response);
  clear();
}

async function responseError(response) {
  let detail = "";
  try {
    detail = cleanText(
      (
        await readResponseLimited(
          response,
          64 * 1024,
          "Emby 错误响应异常过大",
        )
      ).toString("utf8"),
      500,
    );
  } catch {
    // The status code remains useful when the server closed the body early.
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error("Emby 登录已失效或此账户没有访问权限");
    error.status = response.status;
    return error;
  }
  const error = new Error(
    `Emby 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
  );
  error.status = response.status;
  return error;
}

async function readResponseLimited(response, maxBytes, tooLargeMessage) {
  let reader;
  try {
    const declared = Number(response.headers.get("content-length")) || 0;
    if (declared > maxBytes) throw new Error(tooLargeMessage);
    if (!response.body) return Buffer.alloc(0);
    reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(tooLargeMessage);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader?.releaseLock();
    releaseResponseDeadline(response);
  }
}

function decodeSubtitleBuffer(bytes, contentType = "") {
  const data = Buffer.from(bytes || []);
  if (!data.length) return "";
  const declared = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(
    String(contentType || ""),
  )?.[1];
  const candidates = [];
  if (data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    candidates.push("utf-8");
  } else if (data.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    candidates.push("utf-16le");
  } else if (data.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    candidates.push("utf-16be");
  }
  if (declared) candidates.push(declared);
  candidates.push("utf-8", "gb18030", "big5", "windows-1252");

  let best = "";
  let bestScore = Number.POSITIVE_INFINITY;
  for (const encoding of [...new Set(candidates.map((value) => value.toLowerCase()))]) {
    try {
      const decoded = new TextDecoder(encoding).decode(data).replace(/^\uFEFF/, "");
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
      const nulCount = (decoded.match(/\0/g) || []).length;
      const controlCount = (
        decoded.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || []
      ).length;
      const score = replacementCount * 20 + nulCount * 10 + controlCount;
      if (score < bestScore) {
        best = decoded;
        bestScore = score;
      }
      if (score === 0 && (declared || candidates[0] !== "utf-8")) break;
    } catch {
      // Unsupported charset labels are skipped in favour of the fallbacks.
    }
  }
  return best.replace(/\0/g, "");
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function fetchWithScopedRedirects(initialUrl, options = {}) {
  const initial = new URL(initialUrl);
  let current = initial;
  let method = String(options.method || "GET").toUpperCase();
  let body = options.body;
  const maxRedirects = Math.min(8, Math.max(0, options.maxRedirects ?? 5));
  for (let redirects = 0; ; redirects += 1) {
    await options.validateUrl?.(current, {
      initial,
      redirects,
    });
    const response = await fetch(current, {
      method,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : body,
      headers: options.headersForUrl?.(current) || options.headers,
      signal: options.signal,
      redirect: "manual",
    });
    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: current };
    }
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };
    if (redirects >= maxRedirects) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Emby 媒体地址重定向次数过多");
    }
    const next = new URL(location, current);
    if (!["http:", "https:"].includes(next.protocol)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Emby 返回了不安全的媒体重定向地址");
    }
    if (!options.allowCrossOrigin && next.origin !== initial.origin) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("拒绝把 Emby 认证请求重定向到其他服务器");
    }
    if (current.protocol === "https:" && next.protocol !== "https:") {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("拒绝把 HTTPS Emby 媒体降级到未加密 HTTP");
    }
    await response.body?.cancel().catch(() => undefined);
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        method === "POST")
    ) {
      method = "GET";
      body = undefined;
    }
    current = next;
  }
}

async function probeEmbyEndpoint(
  input,
  expectedServerId,
  deviceId,
  version,
  allowInsecure = false,
) {
  const entered = normalizeServerUrl(input, allowInsecure);
  const candidates = embyApiBaseCandidates(entered);
  let lastError;
  for (const candidate of candidates) {
    const timeout = requestTimeout(ENDPOINT_PROBE_TIMEOUT_MS);
    try {
      const { response } = await fetchWithScopedRedirects(
        serverUrlFor(candidate, "/System/Info/Public"),
        {
          headersForUrl: () => ({
            Accept: "application/json",
            "X-Emby-Authorization": authHeader(deviceId, version),
          }),
          signal: timeout.signal,
        },
      );
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!response.ok) throw await responseError(response);
      const info = JSON.parse(
        (
          await readResponseLimited(
            response,
            1024 * 1024,
            "Emby 服务器信息异常过大",
          )
        ).toString("utf8"),
      );
      const serverId = cleanText(info?.Id || info?.ServerId, 160);
      if (!serverId) throw new Error("此线路没有返回 Emby Server Id");
      if (expectedServerId && serverId !== expectedServerId) {
        throw new Error("备用线路连接到另一台 Emby 服务器，已拒绝保存");
      }
      return { url: candidate, serverId, info };
    } catch (error) {
      lastError =
        error?.name === "AbortError"
          ? new Error("验证 Emby 线路超时")
          : error;
    } finally {
      timeout.clear();
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("无法验证 Emby 服务器线路");
}

function safeItem(item, serverUrl) {
  const ownImageTag = cleanText(item?.ImageTags?.Primary, 128);
  const seriesImageTag = cleanText(item?.SeriesPrimaryImageTag, 128);
  const parentImageTag = cleanText(item?.ParentPrimaryImageTag, 128);
  const imageTag = ownImageTag || seriesImageTag || parentImageTag;
  const imageItemId = cleanText(
    item?.PrimaryImageItemId ||
      (ownImageTag ? item?.Id : "") ||
      (seriesImageTag ? item?.SeriesId : "") ||
      (parentImageTag ? item?.ParentId : "") ||
      item?.Id ||
      item?.SeriesId ||
      item?.ParentId,
    128,
  );
  const userData = item?.UserData || {};
  return {
    id: cleanText(item?.Id, 128),
    name: cleanText(item?.Name, 300),
    type: cleanText(item?.Type, 40),
    productionYear: Number(item?.ProductionYear) || undefined,
    seriesName: cleanText(item?.SeriesName, 300) || undefined,
    seasonName: cleanText(item?.SeasonName, 300) || undefined,
    indexNumber: Number(item?.IndexNumber) || undefined,
    parentIndexNumber: Number(item?.ParentIndexNumber) || undefined,
    runtimeTicks: Number(item?.RunTimeTicks) || undefined,
    overview: cleanText(item?.Overview, 2_000) || undefined,
    imageTag: imageTag || undefined,
    imageItemId: imageItemId || undefined,
    playbackPositionTicks:
      Math.max(0, Number(userData?.PlaybackPositionTicks) || 0) || undefined,
    playedPercentage: Number.isFinite(Number(userData?.PlayedPercentage))
      ? Math.max(0, Math.min(100, Number(userData.PlayedPercentage)))
      : undefined,
    played: userData?.Played === true,
    dateCreated: cleanText(item?.DateCreated, 64) || undefined,
    premiereDate: cleanText(item?.PremiereDate, 64) || undefined,
    officialRating: cleanText(item?.OfficialRating, 48) || undefined,
    communityRating: Number.isFinite(Number(item?.CommunityRating))
      ? Math.max(0, Math.min(10, Number(item.CommunityRating)))
      : undefined,
    genres: (Array.isArray(item?.Genres) ? item.Genres : [])
      .map((genre) => cleanText(genre, 80))
      .filter(Boolean)
      .slice(0, 12),
    studios: (Array.isArray(item?.Studios) ? item.Studios : [])
      .map((studio) => cleanText(studio?.Name || studio, 120))
      .filter(Boolean)
      .slice(0, 8),
    taglines: (Array.isArray(item?.Taglines) ? item.Taglines : [])
      .map((tagline) => cleanText(tagline, 240))
      .filter(Boolean)
      .slice(0, 3),
    serverOrigin: serverUrl.origin,
  };
}

function mediaStreams(source) {
  return Array.isArray(source?.MediaStreams) ? source.MediaStreams : [];
}

function streamSummary(stream) {
  const frameRate = Number(
    stream?.RealFrameRate ||
      stream?.AverageFrameRate ||
      stream?.FrameRate,
  );
  return {
    index: Number(stream?.Index),
    type: cleanText(stream?.Type, 24),
    codec: cleanText(stream?.Codec, 32).toLowerCase(),
    language: cleanText(stream?.Language, 24) || undefined,
    title: cleanText(stream?.DisplayTitle || stream?.Title, 160) || undefined,
    channels: Number(stream?.Channels) || undefined,
    width: Number(stream?.Width) || undefined,
    height: Number(stream?.Height) || undefined,
    frameRate:
      Number.isFinite(frameRate) && frameRate > 0 && frameRate <= 240
        ? frameRate
        : undefined,
    bitRate: Number(stream?.BitRate) || undefined,
    bitDepth: Number(stream?.BitDepth) || undefined,
    profile: cleanText(stream?.Profile, 48) || undefined,
    pixelFormat: cleanText(stream?.PixelFormat, 48) || undefined,
    isDefault: stream?.IsDefault === true,
    isForced: stream?.IsForced === true,
    isExternal: stream?.IsExternal === true,
    isText:
      stream?.IsTextSubtitleStream === true ||
      isTextSubtitleCodec(stream?.Codec),
    deliveryMethod: cleanText(stream?.DeliveryMethod, 32) || undefined,
    deliveryUrl: cleanText(stream?.DeliveryUrl, 2_048) || undefined,
  };
}

function browserDirectVideoCompatible(video, codec, allowHevc) {
  const normalizedCodec = cleanText(codec, 32).toLowerCase();
  const bitDepth = Number(video?.BitDepth) || 0;
  const profile = cleanText(video?.Profile, 64).toLowerCase();
  const pixelFormat = cleanText(video?.PixelFormat, 64).toLowerCase();
  const extendedChroma =
    /(?:4:?2:?2|4:?4:?4|yuv422|yuv444)/i.test(profile) ||
    /(?:yuv422|yuv444)/i.test(pixelFormat);
  if (normalizedCodec === "h264") {
    // Chromium does not support AVC High10/4:2:2/4:4:4 through MSE. Treating
    // those files as ordinary H.264 makes SourceBuffer fail asynchronously and
    // leaves the UI looking frozen.
    return (
      (!bitDepth || bitDepth <= 8) &&
      !/(?:high\s*10|high\s*4:?2:?2|high\s*4:?4:?4|hi10p)/i.test(profile) &&
      !/(?:p10|p12|10le|12le)/i.test(pixelFormat) &&
      !extendedChroma
    );
  }
  if (normalizedCodec === "hevc" && allowHevc === true) {
    return (
      (!bitDepth || bitDepth <= 10) &&
      !/(?:range\s*extension|rext)/i.test(profile) &&
      !extendedChroma
    );
  }
  return false;
}

const TEXT_SUBTITLE_CODECS = new Set([
  "ass",
  "dfxp",
  "microdvd",
  "mov_text",
  "sami",
  "smi",
  "srt",
  "ssa",
  "subrip",
  "ttml",
  "vtt",
  "webvtt",
]);

const IMAGE_SUBTITLE_CODECS = [
  "pgs",
  "pgssub",
  "hdmv_pgs_subtitle",
  "dvdsub",
  "dvbsub",
  "dvb_subtitle",
  "vobsub",
  "sub",
  "idx",
];

function isTextSubtitleCodec(codec) {
  return TEXT_SUBTITLE_CODECS.has(cleanText(codec, 32).toLowerCase());
}

function isImageSubtitleStream(stream) {
  return Boolean(
    stream &&
      stream?.IsTextSubtitleStream !== true &&
      !isTextSubtitleCodec(stream?.Codec),
  );
}

function qualityProfile(key) {
  const profiles = {
    original: {
      key: "original",
      label: "原始码率",
      maxBitrate: 100_000_000,
      maxWidth: 7680,
      maxHeight: 4320,
      forceTranscode: false,
    },
    "4k-18": {
      key: "4k-18",
      label: "4K · 18 Mbps",
      maxBitrate: 18_000_000,
      maxWidth: 3840,
      maxHeight: 2160,
      forceTranscode: true,
    },
    "4k-12": {
      key: "4k-12",
      label: "4K · 12 Mbps",
      maxBitrate: 12_000_000,
      maxWidth: 3840,
      maxHeight: 2160,
      forceTranscode: true,
    },
    "1440p-18": {
      key: "1440p-18",
      label: "2K · 18 Mbps",
      maxBitrate: 18_000_000,
      maxWidth: 2560,
      maxHeight: 1440,
      forceTranscode: true,
    },
    "1080p-12": {
      key: "1080p-12",
      label: "1080P · 12 Mbps",
      maxBitrate: 12_000_000,
      maxWidth: 1920,
      maxHeight: 1080,
      forceTranscode: true,
    },
    "1080p-8": {
      key: "1080p-8",
      label: "1080P · 8 Mbps",
      maxBitrate: 8_000_000,
      maxWidth: 1920,
      maxHeight: 1080,
      forceTranscode: true,
    },
    "720p-6": {
      key: "720p-6",
      label: "720P · 6 Mbps",
      maxBitrate: 6_000_000,
      maxWidth: 1280,
      maxHeight: 720,
      forceTranscode: true,
    },
    "720p-4": {
      key: "720p-4",
      label: "720P · 4 Mbps",
      maxBitrate: 4_000_000,
      maxWidth: 1280,
      maxHeight: 720,
      forceTranscode: true,
    },
    "480p-2.5": {
      key: "480p-2.5",
      label: "480P · 2.5 Mbps",
      maxBitrate: 2_500_000,
      maxWidth: 854,
      maxHeight: 480,
      forceTranscode: true,
    },
    "480p-1.8": {
      key: "480p-1.8",
      label: "480P · 1.8 Mbps",
      maxBitrate: 1_800_000,
      maxWidth: 854,
      maxHeight: 480,
      forceTranscode: true,
    },
    "360p-1.2": {
      key: "360p-1.2",
      label: "360P · 1.2 Mbps",
      maxBitrate: 1_200_000,
      maxWidth: 640,
      maxHeight: 360,
      forceTranscode: true,
    },
  };
  return profiles[key] || profiles["1080p-12"];
}

function normalizeEmbyFrameRate(value) {
  const frameRate = Number(value);
  return [24, 30, 60].includes(frameRate) ? frameRate : 30;
}

function embyReadAheadProfile(
  bitrate,
  localVideoTranscode = false,
) {
  const safeBitrate = Math.max(
    500_000,
    Math.min(100_000_000, Number(bitrate) || 8_000_000),
  );
  if (localVideoTranscode) {
    // OpenH264 fallback is CPU-bound on many 2-core hosts. Keep enough headroom
    // to build a reserve without making the encoder compete with the UI.
    if (safeBitrate >= 24_000_000) {
      return { readRate: 1.08, initialBurstSeconds: 4, catchupRate: 1.16 };
    }
    return { readRate: 1.16, initialBurstSeconds: 6, catchupRate: 1.28 };
  }
  if (safeBitrate >= 35_000_000) {
    return { readRate: 1.16, initialBurstSeconds: 6, catchupRate: 1.3 };
  }
  if (safeBitrate >= 15_000_000) {
    return { readRate: 1.24, initialBurstSeconds: 8, catchupRate: 1.42 };
  }
  return { readRate: 1.35, initialBurstSeconds: 12, catchupRate: 1.55 };
}

function sourceFrameRate(stream) {
  const frameRate = Number(
    stream?.RealFrameRate ||
      stream?.AverageFrameRate ||
      stream?.FrameRate,
  );
  return Number.isFinite(frameRate) && frameRate > 0 && frameRate <= 240
    ? frameRate
    : undefined;
}

function buildDeviceProfile(
  quality,
  allowHevc,
  preferMpegTs = false,
  frameRate = 30,
) {
  const maxFrameRate = normalizeEmbyFrameRate(frameRate);
  const videoCodecs = allowHevc ? "h264,hevc" : "h264";
  // Accept all common audio codecs for direct play — non-AAC audio is
  // transcoded locally by FFmpeg so the viewer always gets AAC.
  const allAudio = "aac,ac3,eac3,dts,truehd,flac,mp3,opus,vorbis,pcm_s16le,pcm_s24le";
  const fmp4HlsProfile = {
    Type: "Video",
    Context: "Streaming",
    Protocol: "hls",
    Container: "mp4",
    VideoCodec: "h264",
    AudioCodec: "aac",
    MaxAudioChannels: "2",
    MinSegments: "1",
    SegmentLength: "2",
    BreakOnNonKeyFrames: true,
  };
  const mpegTsHlsProfile = {
    Type: "Video",
    Context: "Streaming",
    Protocol: "hls",
    Container: "ts",
    VideoCodec: "h264",
    AudioCodec: "aac",
    MaxAudioChannels: "2",
    MinSegments: "1",
    SegmentLength: "2",
    BreakOnNonKeyFrames: true,
  };
  const progressiveProfile = {
    Type: "Video",
    Context: "Streaming",
    Protocol: "http",
    Container: "mp4",
    VideoCodec: "h264",
    AudioCodec: "aac",
    MaxAudioChannels: "2",
  };
  return {
    Name: "Synced P2P fMP4",
    MaxStreamingBitrate: quality.maxBitrate,
    MaxStaticBitrate: quality.maxBitrate,
    MusicStreamingTranscodingBitrate: 320_000,
    DirectPlayProfiles: [
      {
        Type: "Video",
        Container: "mp4,m4v,mkv,mov,ts,m2ts,avi,wmv,flv,webm",
        VideoCodec: videoCodecs,
        AudioCodec: allAudio,
      },
    ],
    TranscodingProfiles: preferMpegTs
      ? [mpegTsHlsProfile, progressiveProfile, fmp4HlsProfile]
      : [fmp4HlsProfile, mpegTsHlsProfile, progressiveProfile],
    CodecProfiles: [
      {
        Type: "Video",
        Codec: "h264",
        Conditions: [
          {
            Condition: "LessThanEqual",
            Property: "Width",
            Value: String(quality.maxWidth),
            IsRequired: false,
          },
          {
            Condition: "LessThanEqual",
            Property: "Height",
            Value: String(quality.maxHeight),
            IsRequired: false,
          },
          {
            Condition: "LessThanEqual",
            Property: "VideoBitDepth",
            Value: "8",
            IsRequired: false,
          },
          {
            Condition: "LessThanEqual",
            Property: "VideoFramerate",
            Value: String(maxFrameRate),
            IsRequired: false,
          },
        ],
      },
    ],
    SubtitleProfiles: [
      { Format: "vtt", Method: "External" },
      { Format: "webvtt", Method: "External" },
      { Format: "srt", Method: "External" },
      { Format: "subrip", Method: "External" },
      { Format: "ass", Method: "External" },
      { Format: "ssa", Method: "External" },
      { Format: "ttml", Method: "External" },
      { Format: "dfxp", Method: "External" },
      // Image subtitles cannot be sent as a browser text track. Advertising
      // Encode tells Emby to burn them into the transcoded video and is what
      // makes PlaybackInfo return a usable TranscodingUrl.
      ...IMAGE_SUBTITLE_CODECS.map((format) => ({
        Format: format,
        Method: "Encode",
      })),
    ],
    ResponseProfiles: [
      {
        Type: "Video",
        Container: "m4v",
        MimeType: "video/mp4",
      },
    ],
  };
}

function sourceVideoStream(source) {
  return mediaStreams(source).find((stream) => stream?.Type === "Video");
}

function sourceAudioStream(source, requestedIndex) {
  const audio = mediaStreams(source).filter(
    (stream) => stream?.Type === "Audio",
  );
  if (Number.isInteger(Number(requestedIndex))) {
    const selected = audio.find(
      (stream) => Number(stream?.Index) === Number(requestedIndex),
    );
    if (selected) return selected;
  }
  return audio.find((stream) => stream?.IsDefault) || audio[0];
}

function sourceSubtitleStream(source, requestedIndex) {
  if (!Number.isInteger(Number(requestedIndex))) return undefined;
  return mediaStreams(source).find(
    (stream) =>
      stream?.Type === "Subtitle" &&
      Number(stream?.Index) === Number(requestedIndex),
  );
}

function browserDirectAudioCompatible(audio, audioCodec) {
  if (!audio || !audioCodec) return true;
  if (audioCodec !== "aac") return false;
  const channels = Number(audio?.Channels) || 0;
  if (channels > 2) return false;
  const profile = cleanText(audio?.Profile, 64).toLowerCase();
  const codecTag = cleanText(
    audio?.CodecTagString || audio?.CodecTag || audio?.CodecProfile,
    64,
  ).toLowerCase();
  return !/(?:he[\s_-]?aac|aac[\s_-]?he|sbr|parametric stereo|\bps\b)/u.test(
    `${profile} ${codecTag}`,
  );
}

function selectedMediaSource(playbackInfo, requestedId) {
  const sources = Array.isArray(playbackInfo?.MediaSources)
    ? playbackInfo.MediaSources
    : [];
  const requested = cleanText(requestedId, 128);
  return sources.find((candidate) => candidate?.Id === requested) || sources[0];
}

function originalMediaPath(options, source) {
  return `/Videos/${encodeURIComponent(
    options.itemId,
  )}/stream?Static=true&MediaSourceId=${encodeURIComponent(
    source?.Id || "",
  )}&UserId=${encodeURIComponent(options.userId)}&DeviceId=${encodeURIComponent(
    options.deviceId,
  )}`;
}

function localTranscodeSettings(
  quality,
  hasAudio,
  requestedFrameRate = 30,
  inputFrameRate,
) {
  const maxBitrate = Math.max(
    800_000,
    Math.min(
      MAX_LOCAL_TRANSCODE_BITRATE,
      Number(quality?.maxBitrate) || 8_000_000,
    ),
  );
  const audioBitrate = hasAudio
    ? Math.min(
        256_000,
        Math.max(128_000, Math.floor((maxBitrate * 0.08) / 1_000) * 1_000),
      )
    : 0;
  // Leave room for the MP4 container and short bitrate-control excursions.
  // The advertised/selected ceiling is therefore never exceeded merely
  // because the Emby server declined to create its own transcode.
  const muxReserve = Math.min(128_000, Math.floor(maxBitrate * 0.04));
  const videoBitrate = Math.max(
    500_000,
    maxBitrate - audioBitrate - muxReserve,
  );
  return {
    maxBitrate,
    maxWidth: Math.max(
      2,
      Math.min(
        MAX_LOCAL_TRANSCODE_WIDTH,
        Number(quality?.maxWidth) || 1_920,
      ),
    ),
    maxHeight: Math.max(
      2,
      Math.min(
        MAX_LOCAL_TRANSCODE_HEIGHT,
        Number(quality?.maxHeight) || 1_080,
      ),
    ),
    videoBitrate,
    audioBitrate,
    frameRate: Math.max(
      1,
      Math.min(
        normalizeEmbyFrameRate(requestedFrameRate),
        Number(inputFrameRate) || normalizeEmbyFrameRate(requestedFrameRate),
      ),
    ),
  };
}

function chooseSource(playbackInfo, options, quality) {
  const sources = Array.isArray(playbackInfo?.MediaSources)
    ? playbackInfo.MediaSources
    : [];
  if (!sources.length) {
    throw new Error("Emby 没有为该项目返回可播放媒体源");
  }
  const source = selectedMediaSource(playbackInfo, options.mediaSourceId);
  const video = sourceVideoStream(source);
  const audio = sourceAudioStream(source, options.audioStreamIndex);
  const subtitle = sourceSubtitleStream(source, options.subtitleStreamIndex);
  const burnSubtitle = isImageSubtitleStream(subtitle);
  const videoCodec = cleanText(video?.Codec || source?.VideoCodec, 32).toLowerCase();
  const audioCodec = cleanText(audio?.Codec, 32).toLowerCase();
  const bitrate = Number(source?.Bitrate || video?.BitRate) || 0;
  const directVideoCompatible = browserDirectVideoCompatible(
    video,
    videoCodec,
    options.allowHevc,
  );
  // Preserve compatible AAC-LC stereo. Other codecs, known HE-AAC profiles
  // and multichannel tracks are normalized locally to AAC-LC stereo so the
  // same fMP4 can be decoded consistently by Electron and Android WebView.
  const directAudioCompatible = true;
  const copyAudioDirectly = browserDirectAudioCompatible(audio, audioCodec);
  const withinBudget = !bitrate || bitrate <= quality.maxBitrate * 1.03;
  const sourceWidth = Number(video?.Width) || 0;
  const sourceHeight = Number(video?.Height) || 0;
  const requestedFrameRate = normalizeEmbyFrameRate(options.frameRate);
  const inputFrameRate = sourceFrameRate(video);
  const withinResolution =
    (!sourceWidth || sourceWidth <= quality.maxWidth) &&
    (!sourceHeight || sourceHeight <= quality.maxHeight);
  const withinFrameRate =
    !inputFrameRate || inputFrameRate <= requestedFrameRate + 0.5;
  const safeDirectFallback =
    directVideoCompatible &&
    withinBudget &&
    withinResolution &&
    withinFrameRate;

  let method = "Transcode";
  let upstreamPath = cleanText(source?.TranscodingUrl, 8_192);
  let localVideoTranscode = false;
  let upstreamPreservesSourceIndexes = false;
  if (burnSubtitle) {
    if (!upstreamPath) {
      throw new Error("所选图片字幕需要 Emby 烧录，但服务器没有返回可用转码地址");
    }
  } else if (
    options.forceVideoTranscode !== true &&
    !quality.forceTranscode &&
    source?.SupportsDirectPlay &&
    directVideoCompatible &&
    directAudioCompatible &&
    withinBudget &&
    withinFrameRate
  ) {
    method = "DirectPlay";
    upstreamPath = originalMediaPath(options, source);
    upstreamPreservesSourceIndexes = true;
  } else if (
    options.forceVideoTranscode !== true &&
    !quality.forceTranscode &&
    source?.SupportsDirectStream &&
    directVideoCompatible &&
    withinBudget &&
    withinFrameRate &&
    source?.DirectStreamUrl
  ) {
    method = "DirectStream";
    upstreamPath = cleanText(source.DirectStreamUrl, 8_192);
  }
  if (!upstreamPath) {
    if (
      !quality.forceTranscode &&
      options.forceVideoTranscode !== true &&
      safeDirectFallback
    ) {
      method = "LocalRemux";
      upstreamPath = originalMediaPath(options, source);
      upstreamPreservesSourceIndexes = true;
    } else if (options.allowLocalVideoTranscode === true) {
      // Some Emby accounts are allowed to read media but are not allowed to
      // allocate a server-side transcode. A compatible source already inside
      // the selected ceiling can still be copied/remuxed safely. Otherwise the
      // authenticated original stream becomes input to the bundled FFmpeg,
      // which enforces the selected dimensions and bitrate locally.
      if (safeDirectFallback) {
        if (source?.SupportsDirectStream && source?.DirectStreamUrl) {
          method = "DirectStream";
          upstreamPath = cleanText(source.DirectStreamUrl, 8_192);
        } else {
          method = source?.SupportsDirectPlay ? "DirectPlay" : "LocalRemux";
          upstreamPath = originalMediaPath(options, source);
          upstreamPreservesSourceIndexes = true;
        }
      } else {
        method = "Transcode";
        upstreamPath = originalMediaPath(options, source);
        upstreamPreservesSourceIndexes = true;
        localVideoTranscode = true;
      }
    } else if (quality.forceTranscode) {
      throw new Error(
        `Emby 没有返回 ${quality.label} 转码地址`,
      );
    } else if (options.forceVideoTranscode === true) {
      throw new Error(
        "Emby 没有返回兼容 H.264 转码地址",
      );
    } else if (!directVideoCompatible) {
      throw new Error(
        `Emby 未能生成兼容转码地址；原视频编码为 ${videoCodec || "未知"}`,
      );
    } else {
      method = "LocalRemux";
      upstreamPath = originalMediaPath(options, source);
      upstreamPreservesSourceIndexes = true;
    }
  }
  return {
    source,
    video,
    audio,
    subtitle,
    subtitleMode: subtitle ? (burnSubtitle ? "burn-in" : "external") : "none",
    method,
    upstreamPath,
    localVideoTranscode,
    upstreamPreservesSourceIndexes,
    videoCodec:
      method === "Transcode" || localVideoTranscode
        ? "h264"
        : videoCodec || "h264",
    audioCodec:
      method === "Transcode" || localVideoTranscode
        ? "aac"
        : audioCodec || "aac",
    // Normalize every server-generated transcode as AAC-LC stereo locally.
    // Emby installations and reverse proxies occasionally advertise AAC
    // while returning HE-AAC or multichannel audio; Chromium desktop may
    // accept that stream while Android WebView remains silent.
    localAudioTranscode:
      Boolean(audio) &&
      (method === "Transcode" || localVideoTranscode || !copyAudioDirectly),
  };
}

function rewriteManifest(
  text,
  proxyOrigin,
  prefix,
  upstreamUrl,
  allowUrl = () => true,
) {
  const wrap = (raw) => {
    const value = raw.trim();
    if (!value || value.startsWith("#")) return raw;
    let resolved;
    try {
      resolved = new URL(value, upstreamUrl);
    } catch {
      return raw;
    }
    if (!allowUrl(resolved)) {
      return `${proxyOrigin}${prefix}/__blocked`;
    }
    const encoded = Buffer.from(resolved.toString(), "utf8").toString(
      "base64url",
    );
    return `${proxyOrigin}${prefix}/__url/${encoded}`;
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (!line.startsWith("#")) return wrap(line);
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
        return `URI="${wrap(uri)}"`;
      });
    })
    .join("\n");
}

function isPrivateMediaAddress(address) {
  const normalized = String(address || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!normalized) return true;
  if (normalized === "::" || normalized === "::1") return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateMediaAddress(mapped);
  if (net.isIP(normalized) === 6) {
    return (
      /^(?:fc|fd)/.test(normalized) ||
      /^fe[89ab]/.test(normalized) ||
      /^fe[c-f]/.test(normalized) ||
      /^ff/.test(normalized)
    );
  }
  if (net.isIP(normalized) !== 4) return false;
  const parts = normalized.split(".").map(Number);
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedMediaHostname(hostname) {
  const value = String(hostname || "").trim().toLowerCase();
  return (
    !value ||
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "metadata.google.internal" ||
    value.endsWith(".metadata.google.internal") ||
    isPrivateMediaAddress(value)
  );
}

async function assertPublicMediaTarget(target) {
  if (isBlockedMediaHostname(target.hostname)) {
    throw new Error("拒绝访问本机、私网或链路本地媒体地址");
  }
  const addresses = await dns.lookup(target.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((entry) => isPrivateMediaAddress(entry.address))
  ) {
    throw new Error("媒体 CDN 解析到了本机、私网或链路本地地址");
  }
}

function isHlsManifestResponse(contentType, ...urls) {
  if (/mpegurl|vnd\.apple\.mpegurl/i.test(String(contentType || ""))) {
    return true;
  }
  return urls.some((value) => {
    try {
      return /\.m3u8$/i.test(new URL(value).pathname);
    } catch {
      return false;
    }
  });
}

class EmbyLoopbackProxy {
  constructor(session) {
    this.session = session;
    this.secret = randomBytes(24).toString("base64url");
    this.server = undefined;
    this.origin = "";
    this.activeControllers = new Set();
    this.mediaCdnOrigins = new Set(
      (Array.isArray(session.mediaCdnOrigins)
        ? session.mediaCdnOrigins
        : []
      ).flatMap((value) => {
        try {
          return [new URL(value).origin];
        } catch {
          return [];
        }
      }),
    );
  }

  manifestAllows(target) {
    if (target.origin === this.session.serverUrl.origin) return true;
    if (
      !["http:", "https:"].includes(target.protocol) ||
      isBlockedMediaHostname(target.hostname)
    ) {
      return false;
    }
    this.mediaCdnOrigins.add(target.origin);
    return true;
  }

  async validateMediaTarget(target, context = {}) {
    if (target.origin === this.session.serverUrl.origin) return;
    if (
      context.redirects > 0 &&
      !isBlockedMediaHostname(target.hostname)
    ) {
      // A cross-origin destination explicitly returned by the authenticated
      // Emby/media CDN becomes part of this pipeline's ephemeral allowlist.
      this.mediaCdnOrigins.add(target.origin);
    }
    if (!this.mediaCdnOrigins.has(target.origin)) {
      throw new Error("媒体地址不在 Emby 或本次媒体 CDN 白名单中");
    }
    await assertPublicMediaTarget(target);
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  urlFor(upstream) {
    const resolved = serverUrlFor(this.session.serverUrl, upstream);
    for (const key of [...resolved.searchParams.keys()]) {
      if (/^(?:api_?key|access_?token|x-emby-token)$/i.test(key)) {
        resolved.searchParams.delete(key);
      }
    }
    if (resolved.origin === this.session.serverUrl.origin) {
      return `${this.origin}/${this.secret}${resolved.pathname}${resolved.search}`;
    }
    if (!this.manifestAllows(resolved)) {
      return `${this.origin}/${this.secret}/__blocked`;
    }
    const encoded = Buffer.from(resolved.toString(), "utf8").toString(
      "base64url",
    );
    return `${this.origin}/${this.secret}/__url/${encoded}`;
  }

  resolve(requestUrl) {
    const local = new URL(requestUrl, this.origin);
    const prefix = `/${this.secret}`;
    if (!local.pathname.startsWith(`${prefix}/`) && local.pathname !== prefix) {
      return undefined;
    }
    const encodedPrefix = `${prefix}/__url/`;
    if (local.pathname === `${prefix}/__blocked`) return undefined;
    if (local.pathname.startsWith(encodedPrefix)) {
      try {
        return new URL(
          Buffer.from(
            local.pathname.slice(encodedPrefix.length),
            "base64url",
          ).toString("utf8"),
        );
      } catch {
        return undefined;
      }
    }
    return new URL(
      `${local.pathname.slice(prefix.length) || "/"}${local.search}`,
      this.session.serverUrl,
    );
  }

  async handle(request, response) {
    if (!["GET", "HEAD"].includes(request.method || "")) {
      response.writeHead(405).end();
      return;
    }
    const upstream = this.resolve(request.url || "/");
    if (!upstream || !["http:", "https:"].includes(upstream.protocol)) {
      response.writeHead(404).end();
      return;
    }
    let activeController;
    let deliveredBytes = 0;
    let headersSent = false;
    const originalRange = String(request.headers.range || "");
    const parsedRange = originalRange.match(/^bytes=(\d+)-(\d*)$/i);
    const rangeStart = parsedRange ? Number(parsedRange[1]) : 0;
    const rangeEnd = parsedRange?.[2] ? Number(parsedRange[2]) : undefined;
    const abortActive = () => activeController?.abort();
    request.on("aborted", abortActive);
    response.on("close", abortActive);
    try {
      for (let attempt = 0; attempt <= PROXY_RANGE_RETRIES; attempt += 1) {
        const controller = new AbortController();
        activeController = controller;
        this.activeControllers.add(controller);
        const headerTimer = setTimeout(
          () => controller.abort(new Error("proxy response header timeout")),
          REQUEST_TIMEOUT_MS,
        );
        headerTimer.unref?.();
        let reader;
        try {
          const resumedRange =
            deliveredBytes > 0
              ? `bytes=${rangeStart + deliveredBytes}-${
                  rangeEnd === undefined ? "" : rangeEnd
                }`
              : originalRange;
          const fetched = await fetchWithScopedRedirects(upstream, {
            method: request.method,
            allowCrossOrigin: true,
            headersForUrl: (target) => {
              const headers = {
                Accept: request.headers.accept || "*/*",
                "User-Agent": `${EMBY_CLIENT}/${this.session.version}`,
              };
              if (resumedRange) headers.Range = resumedRange;
              if (target.origin === this.session.serverUrl.origin) {
                headers["X-Emby-Authorization"] = authHeader(
                  this.session.deviceId,
                  this.session.version,
                );
                headers["X-Emby-Token"] = this.session.token;
              }
              return headers;
            },
            signal: controller.signal,
            validateUrl: (target, context) =>
              this.validateMediaTarget(target, context),
          });
          clearTimeout(headerTimer);
          const upstreamResponse = fetched.response;
          const finalUrl = fetched.finalUrl;
          if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
            if (attempt < PROXY_RANGE_RETRIES && upstreamResponse.status >= 500) {
              continue;
            }
            if (!headersSent) {
              response.writeHead(upstreamResponse.status).end();
            } else {
              response.destroy();
            }
            return;
          }
          if (deliveredBytes > 0 && upstreamResponse.status !== 206) {
            throw new Error("上游不支持媒体 Range 续传");
          }
          const contentType =
            upstreamResponse.headers.get("content-type") || "";
          const passHeaders = {
            "content-type": contentType || "application/octet-stream",
            "cache-control": "no-store",
          };
          for (const name of [
            "content-length",
            "content-range",
            "accept-ranges",
            "last-modified",
          ]) {
            const value = upstreamResponse.headers.get(name);
            if (value) passHeaders[name] = value;
          }
          if (
            isHlsManifestResponse(contentType, upstream, finalUrl) &&
            request.method !== "HEAD"
          ) {
            const manifestBytes = await this.readBodyWithIdleTimeout(
              upstreamResponse.body,
              controller,
              8 * 1024 * 1024,
            );
            const manifest = manifestBytes.toString("utf8");
            const rewritten = rewriteManifest(
              manifest,
              this.origin,
              `/${this.secret}`,
              finalUrl,
              (target) => this.manifestAllows(target),
            );
            response.writeHead(upstreamResponse.status, {
              ...passHeaders,
              "content-length": Buffer.byteLength(rewritten),
            });
            response.end(rewritten);
            return;
          }
          if (request.method === "HEAD" || !upstreamResponse.body) {
            if (!headersSent) {
              response.writeHead(upstreamResponse.status, passHeaders);
            }
            response.end();
            return;
          }
          if (!headersSent) {
            response.writeHead(upstreamResponse.status, passHeaders);
            headersSent = true;
          }
          reader = upstreamResponse.body.getReader();
          while (!response.destroyed) {
            const result = await this.readWithIdleTimeout(
              reader,
              controller,
            );
            if (result.done) {
              response.end();
              return;
            }
            const chunk = result.value;
            deliveredBytes += chunk.byteLength;
            if (!response.write(chunk)) {
              await new Promise((resolve, reject) => {
                let drainTimer;
                const drained = () => {
                  cleanup();
                  resolve();
                };
                const closed = () => {
                  cleanup();
                  reject(new Error("下游媒体连接已关闭"));
                };
                const timedOut = () => {
                  const error = new Error("下游媒体连接 15 秒未恢复读取");
                  error.code = "EMBY_PROXY_DOWNSTREAM_IDLE";
                  controller.abort(error);
                  cleanup();
                  reject(error);
                };
                const cleanup = () => {
                  clearTimeout(drainTimer);
                  response.off("drain", drained);
                  response.off("close", closed);
                };
                response.once("drain", drained);
                response.once("close", closed);
                drainTimer = setTimeout(
                  timedOut,
                  PROXY_BODY_IDLE_TIMEOUT_MS,
                );
                drainTimer.unref?.();
              });
            }
          }
          return;
        } catch (error) {
          if (
            response.destroyed ||
            request.destroyed ||
            attempt >= PROXY_RANGE_RETRIES
          ) {
            throw error;
          }
          // Retrying from the exact delivered byte prevents duplicate media
          // after a half-open mobile/CDN connection. A manifest is still
          // buffered in full, so its retry naturally restarts from byte zero.
        } finally {
          clearTimeout(headerTimer);
          await reader?.cancel().catch(() => undefined);
          controller.abort();
          this.activeControllers.delete(controller);
        }
      }
    } catch {
      if (!response.headersSent) response.writeHead(502);
      if (!response.destroyed) response.end();
    } finally {
      request.off("aborted", abortActive);
      response.off("close", abortActive);
    }
  }

  async readWithIdleTimeout(reader, controller) {
    let timer;
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Emby 代理响应体 15 秒无数据");
            error.code = "EMBY_PROXY_BODY_IDLE";
            controller.abort(error);
            reject(error);
          }, PROXY_BODY_IDLE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async readBodyWithIdleTimeout(body, controller, maximumBytes) {
    if (!body) return Buffer.alloc(0);
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const result = await this.readWithIdleTimeout(reader, controller);
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maximumBytes) {
          throw new Error("Emby HLS 清单异常过大");
        }
        chunks.push(Buffer.from(result.value));
      }
      return Buffer.concat(chunks, total);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async close() {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    for (const controller of this.activeControllers) {
      controller.abort(new Error("Emby loopback proxy is closing"));
    }
    this.activeControllers.clear();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, PROXY_CLOSE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    server.closeAllConnections?.();
  }
}

function readBox(buffer, offset, sizeZeroExtendsToEnd = true) {
  if (buffer.length - offset < 8) return undefined;
  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  let headerSize = 8;
  if (size === 1) {
    if (buffer.length - offset < 16) return undefined;
    const bigSize = buffer.readBigUInt64BE(offset + 8);
    if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("媒体片段尺寸超过安全范围");
    }
    size = Number(bigSize);
    headerSize = 16;
  }
  if (size === 0) {
    if (!sizeZeroExtendsToEnd) return undefined;
    size = buffer.length - offset;
  }
  if (size < headerSize || size > 128 * 1024 * 1024) {
    throw new Error("收到无效的 MP4 box");
  }
  if (buffer.length - offset < size) return undefined;
  return { size, type, headerSize };
}

function childBoxes(buffer, start = 8, end = buffer.length) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    const box = readBox(buffer, offset);
    if (!box || offset + box.size > end) break;
    boxes.push({
      type: box.type,
      offset,
      size: box.size,
      data: buffer.subarray(offset, offset + box.size),
    });
    offset += box.size;
  }
  return boxes;
}

function firstChild(buffer, type) {
  return childBoxes(buffer).find((box) => box.type === type)?.data;
}

function parseTrackIdentity(trak) {
  const tkhd = firstChild(trak, "tkhd");
  const mdia = firstChild(trak, "mdia");
  const mdhd = mdia && firstChild(mdia, "mdhd");
  const hdlr = mdia && firstChild(mdia, "hdlr");
  if (!tkhd || !mdhd || !hdlr) return undefined;
  const tkhdVersion = tkhd[8];
  const trackIdOffset = tkhdVersion === 1 ? 28 : 20;
  const mdhdVersion = mdhd[8];
  const timescaleOffset = mdhdVersion === 1 ? 28 : 20;
  if (
    tkhd.length < trackIdOffset + 4 ||
    mdhd.length < timescaleOffset + 4 ||
    hdlr.length < 20
  ) {
    return undefined;
  }
  const trackId = tkhd.readUInt32BE(trackIdOffset);
  const timescale = mdhd.readUInt32BE(timescaleOffset);
  const handler = hdlr.toString("ascii", 16, 20);
  if (!trackId || !timescale) return undefined;
  return { trackId, timescale, handler };
}

function parseVideoTrack(init) {
  const moov = childBoxes(init, 0).find((box) => box.type === "moov")?.data;
  if (!moov) return undefined;
  for (const child of childBoxes(moov)) {
    if (child.type !== "trak") continue;
    const identity = parseTrackIdentity(child.data);
    if (identity?.handler === "vide") return identity;
  }
  return undefined;
}

function parseMp4Tracks(init) {
  const tracks = new Map();
  const moov = childBoxes(init, 0).find((box) => box.type === "moov")?.data;
  if (!moov) return tracks;
  for (const child of childBoxes(moov)) {
    if (child.type !== "trak") continue;
    const identity = parseTrackIdentity(child.data);
    if (identity) tracks.set(identity.trackId, identity);
  }
  return tracks;
}

function readTfdtTime(tfdt, timescale) {
  if (!tfdt || !timescale || tfdt.length < 16) return undefined;
  const version = tfdt[8];
  let units;
  if (version === 1) {
    if (tfdt.length < 20) return undefined;
    const value = tfdt.readBigUInt64BE(12);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    units = Number(value);
  } else {
    units = tfdt.readUInt32BE(12);
  }
  return {
    version,
    mediaTimeMs: (units / timescale) * 1_000,
  };
}

function writeTfdtTime(tfdt, version, timescale, mediaTimeMs) {
  const units = Math.max(
    0,
    Math.round((Number(mediaTimeMs) / 1_000) * timescale),
  );
  if (!Number.isSafeInteger(units)) return false;
  if (version === 1) {
    if (tfdt.length < 20) return false;
    tfdt.writeBigUInt64BE(BigInt(units), 12);
    return true;
  }
  if (units > 0xffffffff || tfdt.length < 16) return false;
  tfdt.writeUInt32BE(units, 12);
  return true;
}

function expectedTrackCadenceMs(state) {
  if (!state.recentCadenceMs.length) return 2_000;
  const sorted = [...state.recentCadenceMs].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Repairs each fMP4 track independently before the fragment reaches MSE.
 *
 * Server-generated transcodes can keep video `tfdt` continuous while the
 * audio `tfdt` jumps forward by 30-60 seconds (and vice versa). A single MSE
 * timestampOffset cannot repair that muxed-track skew: it moves both tracks
 * together and leaves a permanent buffered-range hole. Rewriting only the
 * discontinuous track's base decode time preserves stream copy and A/V sync.
 */
function repairFragmentTrackTimelines(
  fragment,
  tracks,
  timelineStates,
  sequence,
) {
  const repairs = [];
  if (!tracks?.size) return repairs;
  const moof = childBoxes(fragment, 0).find(
    (candidate) => candidate.type === "moof",
  )?.data;
  if (!moof) return repairs;
  for (const child of childBoxes(moof)) {
    if (child.type !== "traf") continue;
    const tfhd = firstChild(child.data, "tfhd");
    if (!tfhd || tfhd.length < 16) continue;
    const trackId = tfhd.readUInt32BE(12);
    const track = tracks.get(trackId);
    const tfdt = track && firstChild(child.data, "tfdt");
    const timing = track && readTfdtTime(tfdt, track.timescale);
    if (!track || !tfdt || !timing) continue;

    const rawTimeMs = timing.mediaTimeMs;
    const previous = timelineStates.get(trackId);
    if (!previous) {
      timelineStates.set(trackId, {
        previousSequence: sequence,
        previousRawTimeMs: rawTimeMs,
        previousTimelineTimeMs: rawTimeMs,
        timestampOffsetMs: 0,
        recentCadenceMs: [],
      });
      continue;
    }

    const sequenceDelta = Math.max(1, sequence - previous.previousSequence);
    const rawDelta = rawTimeMs - previous.previousRawTimeMs;
    const cadence = expectedTrackCadenceMs(previous);
    const expectedDelta = cadence * sequenceDelta;
    const discontinuityThreshold = Math.min(
      12_000,
      Math.max(2_500, expectedDelta * 4),
    );
    const discontinuity =
      rawDelta < -1 || rawDelta > discontinuityThreshold;
    let timelineTimeMs = rawTimeMs + previous.timestampOffsetMs;

    if (discontinuity) {
      timelineTimeMs = previous.previousTimelineTimeMs + expectedDelta;
      previous.timestampOffsetMs = timelineTimeMs - rawTimeMs;
      if (
        writeTfdtTime(
          tfdt,
          timing.version,
          track.timescale,
          timelineTimeMs,
        )
      ) {
        repairs.push({
          sequence,
          trackId,
          trackType: track.handler,
          rawTimeMs: Math.round(rawTimeMs * 1_000) / 1_000,
          timelineTimeMs: Math.round(timelineTimeMs * 1_000) / 1_000,
          timestampOffsetMs:
            Math.round(previous.timestampOffsetMs * 1_000) / 1_000,
        });
      }
    } else if (
      rawDelta >= 20 * sequenceDelta &&
      rawDelta <= 2_000 * sequenceDelta
    ) {
      previous.recentCadenceMs.push(rawDelta / sequenceDelta);
      if (previous.recentCadenceMs.length > 12) {
        previous.recentCadenceMs.shift();
      }
    }
    if (
      !discontinuity &&
      Math.abs(previous.timestampOffsetMs) > 0.001
    ) {
      // Once a track has crossed a discontinuity, every later raw tfdt still
      // needs the repaired offset even though its local cadence is healthy.
      writeTfdtTime(
        tfdt,
        timing.version,
        track.timescale,
        timelineTimeMs,
      );
    }

    previous.previousSequence = sequence;
    previous.previousRawTimeMs = rawTimeMs;
    previous.previousTimelineTimeMs = timelineTimeMs;
  }
  return repairs;
}

function fullBoxFlags(box) {
  if (box.length < 12) return 0;
  return box.readUIntBE(9, 3);
}

function parseTfhdDefaultFlags(tfhd) {
  const flags = fullBoxFlags(tfhd);
  let offset = 16;
  if (flags & 0x000001) offset += 8;
  if (flags & 0x000002) offset += 4;
  if (flags & 0x000008) offset += 4;
  if (flags & 0x000010) offset += 4;
  if (!(flags & 0x000020) || tfhd.length < offset + 4) return undefined;
  return tfhd.readUInt32BE(offset);
}

function parseTrunFirstSampleFlags(trun) {
  if (trun.length < 16) return undefined;
  const flags = fullBoxFlags(trun);
  let offset = 16;
  if (flags & 0x000001) offset += 4;
  if (flags & 0x000004) {
    if (trun.length < offset + 4) return undefined;
    return trun.readUInt32BE(offset);
  }
  if (flags & 0x000100) offset += 4;
  if (flags & 0x000200) offset += 4;
  if (!(flags & 0x000400) || trun.length < offset + 4) return undefined;
  return trun.readUInt32BE(offset);
}

function parseFragmentTiming(fragment, videoTrack) {
  if (!videoTrack) return {};
  const moof = childBoxes(fragment, 0).find(
    (box) => box.type === "moof",
  )?.data;
  if (!moof) return {};
  for (const child of childBoxes(moof)) {
    if (child.type !== "traf") continue;
    const tfhd = firstChild(child.data, "tfhd");
    if (!tfhd || tfhd.length < 16) continue;
    if (tfhd.readUInt32BE(12) !== videoTrack.trackId) continue;
    const tfdt = firstChild(child.data, "tfdt");
    let mediaTimeMs;
    if (tfdt) {
      const version = tfdt[8];
      const offset = 12;
      if (version === 1 && tfdt.length >= offset + 8) {
        const value = tfdt.readBigUInt64BE(offset);
        if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
          mediaTimeMs =
            (Number(value) / videoTrack.timescale) * 1_000;
        }
      } else if (tfdt.length >= offset + 4) {
        mediaTimeMs =
          (tfdt.readUInt32BE(offset) / videoTrack.timescale) * 1_000;
      }
    }
    const trun = firstChild(child.data, "trun");
    const sampleFlags =
      (trun && parseTrunFirstSampleFlags(trun)) ??
      parseTfhdDefaultFlags(tfhd);
    return {
      mediaTimeMs,
      keyframe:
        sampleFlags === undefined
          ? undefined
          : (sampleFlags & 0x00010000) === 0,
    };
  }
  return {};
}

class BufferRope {
  constructor() {
    this.chunks = [];
    this.head = 0;
    this.headOffset = 0;
    this.length = 0;
  }

  push(chunk) {
    const value = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (!value.length) return;
    this.chunks.push(value);
    this.length += value.length;
  }

  peek(size) {
    const requested = Math.min(this.length, Math.max(0, size));
    const first = this.chunks[this.head];
    if (first && first.length - this.headOffset >= requested) {
      return first.subarray(this.headOffset, this.headOffset + requested);
    }
    const output = Buffer.allocUnsafe(requested);
    this.copyInto(output, requested, false);
    return output;
  }

  read(size) {
    if (size < 0 || size > this.length) {
      throw new RangeError("BufferRope read exceeds available bytes");
    }
    const first = this.chunks[this.head];
    let output;
    if (first && first.length - this.headOffset >= size) {
      output = first.subarray(this.headOffset, this.headOffset + size);
      this.consume(size);
    } else {
      output = Buffer.allocUnsafe(size);
      this.copyInto(output, size, true);
    }
    return output;
  }

  copyInto(output, size, consume) {
    let index = this.head;
    let offset = this.headOffset;
    let written = 0;
    while (written < size) {
      const chunk = this.chunks[index];
      const available = Math.min(chunk.length - offset, size - written);
      chunk.copy(output, written, offset, offset + available);
      written += available;
      index += 1;
      offset = 0;
    }
    if (consume) this.consume(size);
  }

  consume(size) {
    let remaining = size;
    this.length -= size;
    while (remaining > 0) {
      const chunk = this.chunks[this.head];
      const available = chunk.length - this.headOffset;
      if (remaining < available) {
        this.headOffset += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        this.head += 1;
        this.headOffset = 0;
      }
    }
    if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }
    if (this.length === 0) {
      this.chunks.length = 0;
      this.head = 0;
      this.headOffset = 0;
    }
  }
}

class FragmentedMp4Parser extends EventEmitter {
  constructor() {
    super();
    this.buffer = new BufferRope();
    this.initBoxes = [];
    this.fragmentBoxes = [];
    this.initEmitted = false;
    this.sequence = 0;
    this.videoTrack = undefined;
    this.tracks = new Map();
    this.trackTimelineStates = new Map();
    this.finished = false;
  }

  push(chunk) {
    if (!chunk?.length) return;
    if (this.finished) throw new Error("MP4 解析器已经结束");
    this.buffer.push(chunk);
    this.drain(false);
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.drain(true);
    if (this.buffer.length) {
      throw new Error("MP4 流在 box 完整前结束");
    }
  }

  drain(sizeZeroExtendsToEnd) {
    while (this.buffer.length >= 8) {
      const header = this.buffer.peek(Math.min(16, this.buffer.length));
      let size = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let headerSize = 8;
      if (size === 1) {
        if (header.length < 16) break;
        const bigSize = header.readBigUInt64BE(8);
        if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("媒体片段尺寸超过安全范围");
        }
        size = Number(bigSize);
        headerSize = 16;
      } else if (size === 0) {
        if (!sizeZeroExtendsToEnd) break;
        size = this.buffer.length;
      }
      if (size < headerSize || size > 128 * 1024 * 1024) {
        throw new Error("收到无效的 MP4 box");
      }
      if (this.buffer.length < size) break;
      this.consume(type, this.buffer.read(size));
    }
    if (this.buffer.length > 128 * 1024 * 1024) {
      throw new Error("MP4 解析缓冲区异常增长");
    }
  }

  consume(type, box) {
    if (!this.initEmitted) {
      this.initBoxes.push(box);
      if (type === "moov") {
        this.initEmitted = true;
        const init = Buffer.concat(this.initBoxes);
        this.tracks = parseMp4Tracks(init);
        this.videoTrack =
          [...this.tracks.values()].find(
            (track) => track.handler === "vide",
          ) || parseVideoTrack(init);
        this.trackTimelineStates.clear();
        this.emit("init", init);
        this.initBoxes = [];
      }
      return;
    }
    if (
      type === "moof" &&
      this.fragmentBoxes.some(
        (candidate) => candidate.toString("ascii", 4, 8) === "moof",
      )
    ) {
      this.fragmentBoxes = [];
      this.emit("warning", {
        code: "orphaned-moof",
        message: "丢弃了未配对 mdat 的媒体片段",
      });
    }
    this.fragmentBoxes.push(box);
    if (type === "mdat") {
      this.sequence += 1;
      const data = Buffer.concat(this.fragmentBoxes);
      const timelineRepairs = repairFragmentTrackTimelines(
        data,
        this.tracks,
        this.trackTimelineStates,
        this.sequence,
      );
      const timing = parseFragmentTiming(data, this.videoTrack);
      this.emit("fragment", {
        sequence: this.sequence,
        mediaTimeMs: timing.mediaTimeMs,
        keyframe: timing.keyframe,
        timelineRepairs,
        data,
      });
      this.fragmentBoxes = [];
    }
  }
}

function trackSampleEntries(init, handlerType) {
  const moov = childBoxes(init, 0).find((box) => box.type === "moov")?.data;
  if (!moov) return [];
  const entries = [];
  for (const child of childBoxes(moov)) {
    if (child.type !== "trak") continue;
    const mdia = firstChild(child.data, "mdia");
    const hdlr = mdia && firstChild(mdia, "hdlr");
    if (
      !mdia ||
      !hdlr ||
      hdlr.length < 20 ||
      hdlr.toString("ascii", 16, 20) !== handlerType
    ) {
      continue;
    }
    const minf = firstChild(mdia, "minf");
    const stbl = minf && firstChild(minf, "stbl");
    const stsd = stbl && firstChild(stbl, "stsd");
    const stsdBox = stsd && readBox(stsd, 0);
    if (!stsd || !stsdBox || stsd.length < stsdBox.headerSize + 8) continue;
    entries.push(
      ...childBoxes(stsd, stsdBox.headerSize + 8, stsd.length),
    );
  }
  return entries;
}

function sampleEntryConfig(entry, configType, fixedHeaderBytes) {
  const entryBox = readBox(entry.data, 0);
  if (!entryBox) return undefined;
  const childStart = entryBox.headerSize + fixedHeaderBytes;
  if (childStart >= entry.data.length) return undefined;
  return childBoxes(entry.data, childStart).find(
    (box) => box.type === configType,
  )?.data;
}

function detectMp4Mime(init, fallbackVideoCodec = "h264", hasAudio = true) {
  let videoCodec =
    fallbackVideoCodec === "hevc"
      ? "hvc1.1.6.L120.B0"
      : "avc1.640028";
  const videoEntries = trackSampleEntries(init, "vide");
  const avcEntry = videoEntries.find((entry) =>
    ["avc1", "avc3"].includes(entry.type),
  );
  const hevcEntry = videoEntries.find((entry) =>
    ["hvc1", "hev1"].includes(entry.type),
  );
  if (avcEntry) {
    const avcConfig = sampleEntryConfig(avcEntry, "avcC", 78);
    const configBox = avcConfig && readBox(avcConfig, 0);
    const payloadOffset = configBox?.headerSize;
    if (
      payloadOffset !== undefined &&
      avcConfig.length >= payloadOffset + 4 &&
      avcConfig[payloadOffset] === 1
    ) {
      videoCodec = `${avcEntry.type}.${[
        avcConfig[payloadOffset + 1],
        avcConfig[payloadOffset + 2],
        avcConfig[payloadOffset + 3],
      ]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()}`;
    } else {
      videoCodec = `${avcEntry.type}.640028`;
    }
  } else if (hevcEntry) {
    // Only a real HEVC sample entry can select HEVC; metadata text is ignored.
    videoCodec = `${hevcEntry.type}.1.6.L120.B0`;
  }
  const codecs = [videoCodec];
  if (
    hasAudio &&
    trackSampleEntries(init, "soun").some((entry) => entry.type === "mp4a")
  ) {
    codecs.push("mp4a.40.2");
  }
  return `video/mp4; codecs="${codecs.join(", ")}"`;
}

function resolveFfmpegPath(options) {
  if (options.ffmpegPath) return options.ffmpegPath;
  if (options.packaged) {
    return path.join(options.resourcesPath, "ffmpeg", "ffmpeg.exe");
  }
  return path.resolve(__dirname, "..", "vendor", "ffmpeg", "ffmpeg.exe");
}

async function waitForChildExit(child, timeoutMs = 3_000) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      child.off("exit", onExit);
      child.off("close", onExit);
      child.off("error", onExit);
    };
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(exited);
    };
    const onExit = () => finish(true);
    timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
    child.once("error", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function terminateChildProcess(child, options = {}) {
  const platform = options.platform || process.platform;
  const spawnProcess = options.spawnProcess || spawn;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 3_000;
  const forceCommandTimeoutMs = options.forceCommandTimeoutMs ?? 1_000;
  const forceWaitMs = options.forceWaitMs ?? 750;
  if (child.exitCode !== null || child.signalCode !== null) return true;

  if (!child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Continue to the forced termination path.
    }
  }
  if (await waitForChildExit(child, gracefulTimeoutMs)) return true;

  if (platform === "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      const killer = spawnProcess(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );
      await waitForChildExit(killer, forceCommandTimeoutMs);
    } catch {
      // child.kill below remains a final fallback when taskkill cannot start.
    }
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the timeout and this call.
    }
  }
  if (await waitForChildExit(child, forceWaitMs)) return true;

  try {
    child.kill("SIGKILL");
  } catch {
    // Best effort: the child may already be gone.
  }
  return await waitForChildExit(child, Math.min(forceWaitMs, 500));
}

function normalizeSegmentRelayConfig(input) {
  if (!input || typeof input !== "object") return undefined;
  let baseUrl;
  try {
    baseUrl = new URL(cleanText(input.baseUrl, 2_048));
  } catch {
    return undefined;
  }
  const roomId = cleanText(input.roomId, 32).toUpperCase();
  const sessionId = cleanText(input.sessionId, 128);
  const assetId = cleanText(input.assetId, 64).toLowerCase();
  const token = cleanText(input.token, 2_048);
  const mediaVersion = Number(input.mediaVersion);
  const localHttp =
    baseUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname);
  if (
    !["https:", "http:"].includes(baseUrl.protocol) ||
    (baseUrl.protocol === "http:" && !localHttp) ||
    !/^\/media\/v\d+\/?$/i.test(baseUrl.pathname) ||
    !/^[23456789A-HJ-NP-Z]{8}$/.test(roomId) ||
    !/^[a-z0-9-]{8,128}$/i.test(sessionId) ||
    !/^[a-f0-9]{24,64}$/.test(assetId) ||
    !Number.isSafeInteger(mediaVersion) ||
    mediaVersion < 1 ||
    mediaVersion > 0xffffffff ||
    token.length < 64
  ) {
    return undefined;
  }
  baseUrl.username = "";
  baseUrl.password = "";
  baseUrl.hash = "";
  baseUrl.search = "";
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/`;
  return {
    baseUrl,
    token,
    roomId,
    sessionId,
    assetId,
    mediaVersion,
  };
}

function renditionIdForQuality(quality) {
  const key = cleanText(quality?.key || quality, 32).toLowerCase();
  if (key === "original") return "original";
  if (key === "1080p-8") return "1080p8";
  if (key === "720p-4") return "720p4";
  if (key === "480p-1.8") return "480p18";
  return `selected-${key.replace(/[^a-z0-9-]/g, "-")}`.slice(0, 32);
}

function segmentCacheBudget(rootDir, requested) {
  const explicit = Number(requested);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.min(
      RELAY_MAX_DISK_BYTES,
      Math.max(256 * 1024 * 1024, Math.floor(explicit)),
    );
  }
  try {
    fs.mkdirSync(rootDir, { recursive: true });
    const disk = fs.statfsSync(rootDir);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    return Math.min(
      RELAY_MAX_DISK_BYTES,
      Math.max(RELAY_MIN_DISK_BYTES, Math.floor(freeBytes * 0.04)),
    );
  } catch {
    return 2 * 1024 * 1024 * 1024;
  }
}

const hardwareEncoderProbeCache = new Map();

async function probeHardwareEncoder(ffmpegPath) {
  if (hardwareEncoderProbeCache.has(ffmpegPath)) {
    return hardwareEncoderProbeCache.get(ffmpegPath);
  }
  const operation = (async () => {
    for (const encoder of ["h264_nvenc", "h264_qsv", "h264_amf"]) {
      const supported = await new Promise((resolve) => {
        let child;
        try {
          child = spawn(
            ffmpegPath,
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-f",
              "lavfi",
              "-i",
              "color=size=128x72:rate=30:duration=0.1",
              "-frames:v",
              "1",
              "-c:v",
              encoder,
              "-f",
              "null",
              "-",
            ],
            {
              windowsHide: true,
              stdio: ["ignore", "ignore", "ignore"],
            },
          );
        } catch {
          resolve(false);
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // The probe may have exited between timer ticks.
          }
          resolve(false);
        }, 4_000);
        timer.unref?.();
        child.once("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
      });
      if (supported) return encoder;
    }
    return undefined;
  })();
  hardwareEncoderProbeCache.set(ffmpegPath, operation);
  return operation;
}

function appendH264EncoderArguments(
  args,
  encoder,
  encoding,
  frameRate,
) {
  const gopFrames = Math.max(24, Math.round(frameRate * 2));
  args.push("-c:v", encoder);
  if (encoder === "h264_nvenc") {
    args.push("-preset", "p4", "-tune", "hq", "-rc", "vbr");
  } else if (encoder === "h264_qsv") {
    args.push("-preset", "medium", "-look_ahead", "0");
  } else if (encoder === "h264_amf") {
    args.push("-quality", "quality", "-rc", "cbr");
  } else {
    args.push("-profile:v", "high", "-rc_mode", "bitrate");
  }
  args.push(
    "-b:v",
    String(encoding.videoBitrate),
    "-maxrate",
    String(encoding.videoBitrate),
    "-bufsize",
    String(Math.min(36_000_000, encoding.videoBitrate * 2)),
    "-g",
    String(gopFrames),
    "-keyint_min",
    String(gopFrames),
    "-sc_threshold",
    "0",
    "-force_key_frames",
    "expr:gte(t,n_forced*2)",
    "-tag:v",
    "avc1",
  );
}

class SegmentRelayHttpError extends Error {
  constructor(status, details, message) {
    super(message || `HTTPS 分片上传失败（${status}）`);
    this.name = "SegmentRelayHttpError";
    this.status = status;
    this.details = details;
  }
}

class CmafRelayCoordinator {
  constructor(config, options = {}) {
    this.config = config;
    this.token = config.token;
    this.sendEvent =
      typeof options.sendEvent === "function" ? options.sendEvent : () => {};
    this.rootDir = path.resolve(
      options.cacheDir ||
        path.join(process.cwd(), ".synced-emby-segment-cache"),
      config.sessionId,
      config.assetId,
      String(config.mediaVersion),
    );
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.maxDiskBytes = segmentCacheBudget(
      this.rootDir,
      options.maxDiskBytes,
    );
    this.renditions = new Map();
    this.records = new Map();
    this.failedRecords = new Set();
    this.activeUploads = 0;
    this.failedRetryTimer = undefined;
    this.retryRandom =
      typeof options.random === "function" ? options.random : Math.random;
    this.uploadBudgetBps = Number.POSITIVE_INFINITY;
    this.uploadBudgetTokens = Number.POSITIVE_INFINITY;
    this.uploadBudgetUpdatedAt = performance.now();
    this.memoryQueuedBytes = 0;
    this.diskBytes = 0;
    this.manifestDirty = false;
    this.manifestUploading = false;
    this.manifestRetryTimer = undefined;
    this.manifestRetryAttempts = 0;
    this.manifestRevision = 0;
    this.acknowledgedEvictionRevision = 0;
    this.serverTombstones = new Map();
    this.serverPressureUntil = 0;
    this.manifestEnded = false;
    this.manifestSubtitle = undefined;
    this.playbackAnchorTimeMs = undefined;
    this.closed = false;
    this.generation = 1;
    this.controller = new AbortController();
  }

  updateToken(token) {
    const next = cleanText(token, 2_048);
    if (next.length < 64 || next === this.token) return false;
    this.token = next;
    // Authentication refresh may unblock 401/403 failures immediately, but
    // the independent retry actor below remains responsible for ordinary
    // relay outages and never waits for a token rotation.
    this.retryFailedRecords(true);
    this.pumpUploads();
    this.scheduleManifest();
    return true;
  }

  registerProducer(renditionId, controls = {}) {
    const state = this.ensureRendition(renditionId);
    state.producerEpoch = Math.min(
      0xffffffff,
      Math.max(0, Number(state.producerEpoch) || 0) + 1,
    );
    state.sourceSequenceOffset = Math.max(
      0,
      Number(state.nextGlobalSequence) - 1,
    );
    state.lastSourceSequence = 0;
    state.previousRawTimeMs = undefined;
    state.previousTimelineTimeMs = undefined;
    state.timestampOffsetMs = 0;
    state.recentCadenceMs = [];
    state.initUploaded = false;
    state.initPath = "";
    state.initData = undefined;
    state.initRecoveryPending = false;
    state.ended = false;
    state.dormant = false;
    state.firstSegmentSequence = state.nextGlobalSequence;
    state.contiguousUploadedSequence = undefined;
    state.suffixRecoveryFrom = undefined;
    state.segments.clear();
    state.uploadedDescriptors.clear();
    state.descriptors.clear();
    for (const [key, record] of this.records) {
      if (
        record.renditionId !== state.id ||
        Number(record.epoch) >= state.producerEpoch
      ) {
        continue;
      }
      record.retired = true;
      record.failed = false;
      this.failedRecords.delete(record);
      this.records.delete(key);
      this.diskBytes = Math.max(0, this.diskBytes - record.bytes);
      void fsp.unlink(record.filePath).catch(() => undefined);
    }
    state.pause = typeof controls.pause === "function" ? controls.pause : () => {};
    state.resume =
      typeof controls.resume === "function" ? controls.resume : () => {};
    this.applyProducerPause(state);
    this.updatePressure();
  }

  unregisterProducer(renditionId) {
    const state = this.renditions.get(renditionId);
    if (!state) return;
    state.pause = () => {};
    state.resume = () => {};
  }

  deactivateProducer(renditionId) {
    const state = this.renditions.get(renditionId);
    if (!state) return;
    state.dormant = true;
    state.initUploaded = false;
    state.ended = false;
    this.scheduleManifest();
  }

  setRenditionDemandActive(renditionId, active) {
    const state = this.ensureRendition(renditionId);
    state.demandPaused = active !== true;
    this.applyProducerPause(state);
    this.scheduleManifest();
  }

  setUploadBudget(availableUploadBps) {
    const measured = Number(availableUploadBps);
    const now = performance.now();
    const previousBudgetBps = this.uploadBudgetBps;
    if (Number.isFinite(previousBudgetBps) && previousBudgetBps > 0) {
      const previousBurstBytes = (previousBudgetBps / 8) * 2;
      this.uploadBudgetTokens = Math.min(
        previousBurstBytes,
        this.uploadBudgetTokens +
          (Math.max(0, now - this.uploadBudgetUpdatedAt) *
            previousBudgetBps) /
            8_000,
      );
    }
    const requestedBudgetBps =
      Number.isFinite(measured) && measured >= 0
        ? measured * RELAY_UPLOAD_BUDGET_SHARE
        : Number.POSITIVE_INFINITY;
    this.uploadBudgetBps =
      Number.isFinite(requestedBudgetBps) &&
      requestedBudgetBps < RELAY_MIN_VIABLE_UPLOAD_BPS
        ? 0
        : requestedBudgetBps;
    if (Number.isFinite(this.uploadBudgetBps)) {
      const maximumBurstBytes = (this.uploadBudgetBps / 8) * 2;
      this.uploadBudgetTokens = Number.isFinite(previousBudgetBps)
        ? Math.min(maximumBurstBytes, Math.max(0, this.uploadBudgetTokens))
        : maximumBurstBytes;
    } else {
      this.uploadBudgetTokens = Number.POSITIVE_INFINITY;
    }
    this.uploadBudgetUpdatedAt = now;
    for (const state of this.renditions.values()) {
      state.budgetPaused = this.uploadBudgetBps === 0;
      this.applyProducerPause(state);
    }
    if (this.uploadBudgetBps > 0) {
      this.pumpUploads();
    }
    // Anchor, ended and rendition availability are tiny control state and
    // must remain publishable even while media upload is paused at zero.
    this.scheduleManifest();
    return this.uploadBudgetBps;
  }

  updatePlaybackAnchor(positionTicks) {
    const ticks = Number(positionTicks);
    if (!Number.isFinite(ticks) || ticks < 0 || this.closed) return false;
    const next = ticks / 10_000;
    const changed =
      this.playbackAnchorTimeMs === undefined ||
      Math.abs(next - this.playbackAnchorTimeMs) >= 250;
    this.playbackAnchorTimeMs = next;
    this.retireExpiredFailedRecords();
    this.updatePressure();
    this.pumpUploads();
    if (changed) this.scheduleManifest();
    return changed;
  }

  forwardWindowMs() {
    const totalBitrate = [...this.renditions.values()].reduce(
      (sum, state) =>
        sum +
        (state.dormant || state.demandPaused
          ? 0
          : Math.max(0, Number(state.plan?.bitrate) || 0)),
      0,
    );
    if (!totalBitrate) return 2 * 60 * 60_000;
    const totalBudgetedMs = Math.floor(
      ((this.maxDiskBytes * 8 * 0.72) / totalBitrate) * 1_000,
    );
    // Reserve one minute of the quota for the current/rewind window. On a
    // small volume, urgent playback wins over a nominal two-minute prefetch
    // floor; larger volumes naturally expand toward the two-hour ceiling.
    const forwardBudgetedMs = totalBudgetedMs - 60_000;
    const budgetedWindowMs = Math.min(
      2 * 60 * 60_000,
      Math.max(15_000, forwardBudgetedMs),
    );
    return Date.now() < this.serverPressureUntil
      ? Math.min(120_000, budgetedWindowMs)
      : budgetedWindowMs;
  }

  ensureRendition(renditionId) {
    const id = /^[a-z0-9][a-z0-9-]{0,31}$/i.test(String(renditionId || ""))
      ? String(renditionId).toLowerCase()
      : "selected";
    let state = this.renditions.get(id);
    if (!state) {
      state = {
        id,
        plan: undefined,
        mimeType: "",
        switchGroup: "",
        producerEpoch: 0,
        sourceSequenceOffset: 0,
        lastSourceSequence: 0,
        nextGlobalSequence: 1,
        initPath: "",
        initData: undefined,
        initRecoveryPending: false,
        initUploaded: false,
        segments: new Map(),
        uploadedDescriptors: new Map(),
        descriptors: new Map(),
        firstSegmentSequence: undefined,
        contiguousUploadedSequence: undefined,
        suffixRecoveryFrom: undefined,
        pending: [],
        pendingHead: 0,
        spooling: false,
        uploadQueue: [],
        uploadHead: 0,
        recoveryQueue: [],
        uploadActive: false,
        recentCadenceMs: [],
        previousRawTimeMs: undefined,
        previousTimelineTimeMs: undefined,
        timestampOffsetMs: 0,
        pause: () => {},
        resume: () => {},
        pressurePaused: false,
        demandPaused: false,
        budgetPaused: this.uploadBudgetBps === 0,
        producerPaused: false,
        ended: false,
        dormant: false,
      };
      this.renditions.set(id, state);
    }
    return state;
  }

  publishInit(renditionId, plan, mimeType, data, title) {
    if (this.closed) return;
    const state = this.ensureRendition(renditionId);
    if (state.producerEpoch < 1) {
      state.producerEpoch = 1;
      state.sourceSequenceOffset = Math.max(
        0,
        Number(state.nextGlobalSequence) - 1,
      );
    }
    state.plan = plan;
    state.mimeType = cleanText(mimeType, 180);
    state.switchGroup = `${state.mimeType
      .replace(/\s+/g, "")
      .replace(/level-id=[^,;"]+/gi, "")
      .slice(0, 96)}:${
        plan.method === "Transcode" || plan.localVideoTranscode
          ? "gop2"
          : "source-gop"
      }`;
    state.title = cleanText(title, 300) || "Emby 影片";
    state.initData = Buffer.isBuffer(data)
      ? Buffer.from(data)
      : Buffer.from(data);
    state.initPath = this.relativeMediaPath(
      state.id,
      `epochs/${state.producerEpoch}/init.mp4`,
    );
    this.enqueueSpool(state, {
      kind: "init",
      sequence: 0,
      epoch: state.producerEpoch,
      data,
      relativePath: state.initPath,
      contentType: "video/mp4",
      headers: {},
    });
  }

  publishFragment(renditionId, fragment) {
    if (this.closed) return;
    const state = this.ensureRendition(renditionId);
    if (!state.plan || !state.mimeType) return;
    const sourceSequence = Number(fragment.sequence);
    if (
      !Number.isSafeInteger(sourceSequence) ||
      sourceSequence < 1 ||
      sourceSequence <= state.lastSourceSequence
    ) {
      return;
    }
    const sequence = state.sourceSequenceOffset + sourceSequence;
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequence > 0xffffffff
    ) {
      this.sendEvent({
        type: "warning",
        code: "segment-sequence-exhausted",
        message: `${state.id} 档位的全局分片序号已耗尽`,
      });
      return;
    }
    state.lastSourceSequence = sourceSequence;
    state.nextGlobalSequence = Math.max(
      state.nextGlobalSequence,
      sequence + 1,
    );
    const rawTimeMs = Number(fragment.mediaTimeMs);
    let timelineTimeMs;
    if (
      state.previousRawTimeMs === undefined ||
      state.previousTimelineTimeMs === undefined
    ) {
      const startMs = Number(state.plan.startTimeTicks || 0) / 10_000;
      state.timestampOffsetMs = startMs - rawTimeMs;
      timelineTimeMs = startMs;
    } else {
      const rawDelta = rawTimeMs - state.previousRawTimeMs;
      const sorted = [...state.recentCadenceMs].sort((left, right) => left - right);
      const cadence = sorted.length
        ? sorted[Math.floor(sorted.length / 2)]
        : 2_000;
      if (rawDelta >= 100 && rawDelta <= 6_000) {
        state.recentCadenceMs.push(rawDelta);
        if (state.recentCadenceMs.length > 16) {
          state.recentCadenceMs.shift();
        }
        timelineTimeMs = rawTimeMs + state.timestampOffsetMs;
      } else {
        timelineTimeMs = state.previousTimelineTimeMs + cadence;
        state.timestampOffsetMs = timelineTimeMs - rawTimeMs;
      }
      const previous = state.descriptors.get(sequence - 1);
      if (previous) {
        previous.durationMs = Math.max(
          1,
          timelineTimeMs - previous.timelineTimeMs,
        );
        this.scheduleManifest();
      }
    }
    state.previousRawTimeMs = rawTimeMs;
    state.previousTimelineTimeMs = timelineTimeMs;
    state.firstSegmentSequence =
      state.firstSegmentSequence === undefined
        ? sequence
        : Math.min(state.firstSegmentSequence, sequence);
    const relativePath = this.relativeMediaPath(
      state.id,
      `segments/${sequence}.m4s`,
    );
    const descriptor = {
      sequence,
      mediaTimeMs: rawTimeMs,
      timelineTimeMs,
      durationMs: Math.max(
        1,
        state.recentCadenceMs.at(-1) || 2_000,
      ),
      keyframe: fragment.keyframe === true,
      bytes: fragment.data.length,
      path: relativePath,
    };
    state.descriptors.set(sequence, descriptor);
    this.enqueueSpool(state, {
      kind: "segment",
      sequence,
      epoch: state.producerEpoch,
      data: fragment.data,
      relativePath,
      contentType: "video/iso.segment",
      headers: {
        "x-synced-media-time-ms": String(rawTimeMs),
        "x-synced-timeline-time-ms": String(timelineTimeMs),
        "x-synced-duration-ms": String(
          Math.max(
            1,
            state.recentCadenceMs.at(-1) || 2_000,
          ),
        ),
        "x-synced-keyframe": String(fragment.keyframe === true),
        "x-synced-bitrate": String(
          Math.max(1, Number(state.plan.bitrate) || 1),
        ),
      },
      descriptor,
    });
  }

  markRenditionEnded(renditionId) {
    const state = this.renditions.get(renditionId);
    if (!state) return;
    state.ended = true;
    // The ended marker is published only after the spool and upload queues
    // drain. Publishing it here can make viewers stop polling before the last
    // moof/mdat pairs have reached the relay.
    this.scheduleManifest();
  }

  relativeMediaPath(renditionId, suffix) {
    const base = this.config.baseUrl.pathname;
    return (
      `${base}rooms/${this.config.roomId}/sessions/${this.config.sessionId}/` +
      `assets/${this.config.assetId}/` +
      `versions/${this.config.mediaVersion}/renditions/${renditionId}/${suffix}`
    );
  }

  manifestPath() {
    const base = this.config.baseUrl.pathname;
    return (
      `${base}rooms/${this.config.roomId}/sessions/${this.config.sessionId}/` +
      `assets/${this.config.assetId}/` +
      `versions/${this.config.mediaVersion}/manifest.json`
    );
  }

  subtitlePath() {
    const base = this.config.baseUrl.pathname;
    return (
      `${base}rooms/${this.config.roomId}/sessions/${this.config.sessionId}/` +
      `assets/${this.config.assetId}/` +
      `versions/${this.config.mediaVersion}/subtitle.vtt`
    );
  }

  publishSubtitle(subtitle) {
    const text = String(subtitle?.text || "");
    if (
      this.closed ||
      !text.trim() ||
      Buffer.byteLength(text) > 12 * 1024 * 1024
    ) {
      return;
    }
    const relativePath = this.subtitlePath();
    const body = Buffer.from(text, "utf8");
    const filePath = path.join(this.rootDir, "subtitle.vtt");
    void fsp
      .writeFile(filePath, body, { mode: 0o600 })
      .then(() =>
        this.uploadFile(
          new URL(relativePath, this.config.baseUrl),
          filePath,
          body.length,
          {
            "content-type": "text/vtt; charset=utf-8",
            "x-content-sha256": createHash("sha256")
              .update(body)
              .digest("hex"),
          },
        ),
      )
      .then(() => {
        this.manifestSubtitle = {
          path: relativePath,
          language: cleanText(subtitle.language, 24) || undefined,
          title: cleanText(subtitle.title, 160) || "字幕",
        };
        this.scheduleManifest();
      })
      .catch((error) => {
        this.sendEvent({
          type: "warning",
          code: "segment-subtitle-upload-failed",
          message: cleanText(error?.message || error, 500),
        });
      });
  }

  enqueueSpool(state, item) {
    const data = Buffer.isBuffer(item.data)
      ? item.data
      : Buffer.from(item.data);
    if (data.length > 32 * 1024 * 1024) {
      this.sendEvent({
        type: "warning",
        code: "segment-too-large",
        message: `${state.id} 分片超过 32 MiB，已拒绝进入缓存`,
      });
      return;
    }
    item.data = data;
    item.sha256 = createHash("sha256").update(data).digest("hex");
    if (item.descriptor) item.descriptor.sha256 = item.sha256;
    state.pending.push(item);
    this.memoryQueuedBytes += data.length;
    this.updatePressure();
    this.pumpSpool(state);
  }

  pumpSpool(state) {
    if (
      state.spooling ||
      this.closed ||
      state.pendingHead >= state.pending.length
    ) {
      return;
    }
    state.spooling = true;
    const generation = this.generation;
    void (async () => {
      while (
        !this.closed &&
        generation === this.generation &&
        state.pendingHead < state.pending.length
      ) {
        const item = state.pending[state.pendingHead++];
        const fileName =
          item.kind === "init"
            ? `init-${item.epoch}.mp4`
            : `${item.sequence}.m4s`;
        const directory =
          item.kind === "init"
            ? path.join(
                this.rootDir,
                state.id,
                "epochs",
                String(item.epoch),
              )
            : path.join(this.rootDir, state.id);
        const filePath = path.join(directory, fileName);
        const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
        try {
          if (
            Number(item.epoch) !== Number(state.producerEpoch)
          ) {
            continue;
          }
          await fsp.mkdir(directory, { recursive: true });
          await fsp.writeFile(temporaryPath, item.data, { mode: 0o600 });
          await fsp.rename(temporaryPath, filePath).catch(async (error) => {
            if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
              throw error;
            }
            await fsp.unlink(filePath).catch(() => undefined);
            await fsp.rename(temporaryPath, filePath);
          });
          const key =
            item.kind === "init"
              ? `${state.id}:init:${item.epoch}`
              : `${state.id}:${item.kind}:${item.sequence}`;
          const previous = this.records.get(key);
          if (previous) this.diskBytes -= previous.bytes;
          const record = {
            ...item,
            data: undefined,
            key,
            renditionId: state.id,
            filePath,
            bytes: item.data.length,
            uploaded: false,
            failed: false,
            retired: false,
            retryAttempts: 0,
            nextRetryAt: 0,
            cachedAt: Date.now(),
          };
          this.records.set(key, record);
          this.diskBytes += record.bytes;
          state.uploadQueue.push(record);
          if (
            item.kind === "init" &&
            Number(item.epoch) === Number(state.producerEpoch)
          ) {
            state.initRecoveryPending = false;
          }
          this.pumpUploads();
        } catch (error) {
          if (
            item.kind === "init" &&
            Number(item.epoch) === Number(state.producerEpoch)
          ) {
            state.initRecoveryPending = false;
          }
          await fsp.unlink(temporaryPath).catch(() => undefined);
          this.sendEvent({
            type: "warning",
            code: "segment-spool-failed",
            message: cleanText(error?.message || error, 500),
          });
        } finally {
          this.memoryQueuedBytes = Math.max(
            0,
            this.memoryQueuedBytes - item.data.length,
          );
          item.data = undefined;
          this.evictDisk();
          this.updatePressure();
        }
      }
      if (
        state.pendingHead > 512 &&
        state.pendingHead * 2 >= state.pending.length
      ) {
        state.pending = state.pending.slice(state.pendingHead);
        state.pendingHead = 0;
      }
    })().finally(() => {
      state.spooling = false;
      if (state.pendingHead < state.pending.length) this.pumpSpool(state);
    });
  }

  pumpUploads() {
    if (this.uploadBudgetBps === 0) return;
    this.retireExpiredFailedRecords();
    while (!this.closed && this.activeUploads < RELAY_UPLOAD_CONCURRENCY) {
      const now = Date.now();
      let selectedState;
      let record;
      let selectedFromRecovery = false;
      for (const state of this.renditions.values()) {
        if (state.uploadActive) continue;
        while (
          state.recoveryQueue.length &&
          (state.recoveryQueue[0].uploaded ||
            state.recoveryQueue[0].retired)
        ) {
          const completed = state.recoveryQueue.shift();
          if (completed) completed.recoveryQueued = false;
        }
        const recovery = state.recoveryQueue[0];
        if (recovery) {
          if (recovery.failed && recovery.nextRetryAt > now) continue;
          if (recovery.failed) {
            recovery.failed = false;
            this.failedRecords.delete(recovery);
          }
          selectedState = state;
          record = recovery;
          selectedFromRecovery = true;
          break;
        }
        while (state.uploadHead < state.uploadQueue.length) {
          const candidate = state.uploadQueue[state.uploadHead];
          if (candidate.uploaded || candidate.retired) {
            state.uploadHead += 1;
            continue;
          }
          if (candidate.failed && candidate.nextRetryAt > now) break;
          if (candidate.failed) {
            candidate.failed = false;
            this.failedRecords.delete(candidate);
          }
          selectedState = state;
          record = candidate;
          break;
        }
        if (record) break;
      }
      if (!record || !selectedState) {
        this.scheduleFailedRetry();
        break;
      }
      selectedState.uploadActive = true;
      this.activeUploads += 1;
      const recoveryProbe = record.retryAttempts > 0;
      void this.uploadRecord(record)
        .then(() => {
          record.retryAttempts = 0;
          record.nextRetryAt = 0;
          if (selectedFromRecovery) {
            if (selectedState.recoveryQueue[0] === record) {
              selectedState.recoveryQueue.shift();
            }
            record.recoveryQueued = false;
          } else {
            selectedState.uploadHead += 1;
          }
          if (recoveryProbe) this.retryFailedRecords(true);
        })
        .catch((error) => {
          this.markRecordFailed(record, error);
          this.sendEvent({
            type: "warning",
            code: "segment-relay-upload-failed",
            message: cleanText(error?.message || error, 500),
            renditionId: record.renditionId,
          });
        })
        .finally(() => {
          selectedState.uploadActive = false;
          this.activeUploads = Math.max(0, this.activeUploads - 1);
          if (
            selectedState.uploadHead > 1_024 &&
            selectedState.uploadHead * 2 >= selectedState.uploadQueue.length
          ) {
            selectedState.uploadQueue = selectedState.uploadQueue.slice(
              selectedState.uploadHead,
            );
            selectedState.uploadHead = 0;
          }
          this.evictDisk();
          this.updatePressure();
          this.pumpUploads();
        });
    }
  }

  recordInUrgentWindow(record) {
    if (record.kind === "init") return true;
    const timelineTimeMs = Number(record.descriptor?.timelineTimeMs);
    if (
      !Number.isFinite(timelineTimeMs) ||
      this.playbackAnchorTimeMs === undefined
    ) {
      return true;
    }
    return (
      timelineTimeMs >=
        this.playbackAnchorTimeMs - RELAY_FAILED_RECORD_RETENTION_MS &&
      timelineTimeMs <= this.playbackAnchorTimeMs + 120_000
    );
  }

  markRecordFailed(record, error) {
    if (record.retired || record.uploaded || this.closed) return;
    record.failed = true;
    record.retryAttempts = Math.min(
      1_000_000,
      Math.max(0, Number(record.retryAttempts) || 0) + 1,
    );
    const baseDelay =
      RELAY_FAILED_RETRY_DELAYS_MS[
        Math.min(
          RELAY_FAILED_RETRY_DELAYS_MS.length - 1,
          record.retryAttempts - 1,
        )
      ];
    const jitter = 0.8 + Math.max(0, Math.min(1, this.retryRandom())) * 0.4;
    const serverRetryDelay =
      error instanceof SegmentRelayHttpError && error.status === 507
        ? Math.max(0, this.serverPressureUntil - Date.now())
        : 0;
    record.nextRetryAt =
      Date.now() +
      Math.max(Math.round(baseDelay * jitter), serverRetryDelay);
    this.failedRecords.add(record);
    this.scheduleFailedRetry();
  }

  retryFailedRecords(urgentOnly = false) {
    const now = Date.now();
    for (const record of this.failedRecords) {
      if (
        record.retired ||
        record.uploaded ||
        (urgentOnly && !this.recordInUrgentWindow(record))
      ) {
        continue;
      }
      record.failed = false;
      record.nextRetryAt = now;
      this.failedRecords.delete(record);
    }
    this.scheduleFailedRetry();
  }

  scheduleFailedRetry() {
    if (this.closed) return;
    if (this.failedRetryTimer) {
      clearTimeout(this.failedRetryTimer);
      this.failedRetryTimer = undefined;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const record of this.failedRecords) {
      if (!record.retired && !record.uploaded) {
        earliest = Math.min(earliest, Number(record.nextRetryAt) || 0);
      }
    }
    if (!Number.isFinite(earliest)) return;
    this.failedRetryTimer = setTimeout(() => {
      this.failedRetryTimer = undefined;
      const now = Date.now();
      for (const record of this.failedRecords) {
        if (record.nextRetryAt > now || record.retired || record.uploaded) {
          continue;
        }
        record.failed = false;
        this.failedRecords.delete(record);
      }
      this.pumpUploads();
    }, Math.max(25, earliest - Date.now()));
    this.failedRetryTimer.unref?.();
  }

  retireExpiredFailedRecords() {
    if (this.playbackAnchorTimeMs === undefined) return;
    const cutoff =
      this.playbackAnchorTimeMs - RELAY_FAILED_RECORD_RETENTION_MS;
    for (const record of [...this.failedRecords]) {
      const endTimeMs =
        Number(record.descriptor?.timelineTimeMs) +
        Math.max(1, Number(record.descriptor?.durationMs) || 1);
      if (
        record.kind !== "segment" ||
        !Number.isFinite(endTimeMs) ||
        endTimeMs >= cutoff
      ) {
        continue;
      }
      record.retired = true;
      record.failed = false;
      this.failedRecords.delete(record);
      this.records.delete(record.key);
      this.diskBytes = Math.max(0, this.diskBytes - record.bytes);
      const state = this.renditions.get(record.renditionId);
      state?.descriptors.delete(record.sequence);
      state?.uploadedDescriptors.delete(record.sequence);
      state?.segments.delete(record.sequence);
      if (state) {
        // A retired failure was the serial upload head, so every later
        // segment is still unpublished. Start a fresh contiguous prefix
        // after the obsolete hole; otherwise one abandoned sequence would
        // suppress this rendition forever.
        state.firstSegmentSequence = record.sequence + 1;
        state.contiguousUploadedSequence = undefined;
        state.segments.clear();
        for (const sequence of state.uploadedDescriptors.keys()) {
          if (sequence < state.firstSegmentSequence) {
            state.uploadedDescriptors.delete(sequence);
          }
        }
      }
      void fsp.unlink(record.filePath).catch(() => undefined);
      this.scheduleManifest();
    }
  }

  publishContiguousSegments(state) {
    let next =
      state.contiguousUploadedSequence === undefined
        ? state.firstSegmentSequence
        : state.contiguousUploadedSequence + 1;
    if (!Number.isSafeInteger(next)) return;
    if (
      Number.isSafeInteger(state.suffixRecoveryFrom) &&
      !state.uploadedDescriptors.has(next)
    ) {
      const restart = [...state.uploadedDescriptors.entries()]
        .filter(
          ([sequence, descriptor]) =>
            sequence >= state.suffixRecoveryFrom &&
            descriptor?.keyframe === true,
        )
        .sort((left, right) => left[0] - right[0])[0];
      if (restart) {
        this.retireLocalPrefix(state, restart[0] - 1);
        state.firstSegmentSequence = restart[0];
        state.contiguousUploadedSequence = undefined;
        state.suffixRecoveryFrom = undefined;
        next = restart[0];
      }
    }
    while (state.uploadedDescriptors.has(next)) {
      const descriptor = state.uploadedDescriptors.get(next);
      state.uploadedDescriptors.delete(next);
      state.segments.set(next, descriptor);
      state.contiguousUploadedSequence = next;
      next += 1;
    }
  }

  async uploadRecord(record) {
    const url = new URL(record.relativePath, this.config.baseUrl);
    await this.uploadFile(url, record.filePath, record.bytes, {
      "content-type": record.contentType,
      "x-content-sha256": record.sha256,
      ...record.headers,
    });
    record.uploaded = true;
    const state = this.renditions.get(record.renditionId);
    if (!state) return;
    if (record.kind === "init") {
      if (record.epoch === state.producerEpoch) {
        state.initUploaded = true;
      }
    } else if (
      record.descriptor &&
      record.epoch === state.producerEpoch
    ) {
      state.uploadedDescriptors.set(record.sequence, record.descriptor);
      this.publishContiguousSegments(state);
    }
    this.scheduleManifest();
  }

  async waitForUploadBudget(bytes, signal) {
    if (!Number.isFinite(this.uploadBudgetBps)) return;
    if (this.uploadBudgetBps <= 0) {
      throw new Error("HTTPS 分片上传已等待可用上行预算");
    }
    const now = performance.now();
    const elapsedMs = Math.max(0, now - this.uploadBudgetUpdatedAt);
    const maximumBurstBytes = (this.uploadBudgetBps / 8) * 2;
    this.uploadBudgetTokens = Math.min(
      maximumBurstBytes,
      this.uploadBudgetTokens +
        (elapsedMs * this.uploadBudgetBps) / 8_000,
    );
    this.uploadBudgetUpdatedAt = now;
    this.uploadBudgetTokens -= Math.max(0, Number(bytes) || 0);
    if (this.uploadBudgetTokens >= 0) return;
    const waitMs = Math.min(
      30_000,
      (-this.uploadBudgetTokens * 8_000) / this.uploadBudgetBps,
    );
    await new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason || new Error("segment-upload-cancelled"));
        return;
      }
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(signal.reason || new Error("segment-upload-cancelled"));
      };
      timer = setTimeout(finish, Math.max(1, waitMs));
      timer.unref?.();
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  async uploadFile(
    url,
    filePath,
    bytes,
    headers,
    bypassMediaBudget = false,
  ) {
    let lastError;
    for (let attempt = 1; attempt <= RELAY_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      if (this.closed || this.controller.signal.aborted) {
        throw new Error("分片上传已取消");
      }
      const controller = new AbortController();
      const abort = () => controller.abort(this.controller.signal.reason);
      this.controller.signal.addEventListener("abort", abort, { once: true });
      const stream = fs.createReadStream(filePath);
      let idleTimer;
      const refreshIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => controller.abort("segment-upload-idle"),
          RELAY_UPLOAD_IDLE_TIMEOUT_MS,
        );
        idleTimer.unref?.();
      };
      refreshIdle();
      const monitoredBody = (async function* () {
        for await (const chunk of stream) {
          if (!bypassMediaBudget) {
            await this.waitForUploadBudget(
              chunk.byteLength,
              controller.signal,
            );
          }
          refreshIdle();
          yield chunk;
        }
      }).call(this);
      try {
        const response = await fetch(url, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-length": String(bytes),
            ...headers,
          },
          body: monitoredBody,
          duplex: "half",
          signal: controller.signal,
        });
        if (!response.ok) {
          let details;
          try {
            const contentType = String(
              response.headers.get("content-type") || "",
            );
            if (contentType.includes("application/json")) {
              details = await response.json();
            } else {
              await response.body?.cancel().catch(() => undefined);
            }
          } catch {
            details = undefined;
          }
          throw new SegmentRelayHttpError(
            response.status,
            details,
          );
        }
        if (
          response.headers.get("x-synced-storage-pressure") === "true"
        ) {
          const wasPressured = Date.now() < this.serverPressureUntil;
          this.serverPressureUntil = Date.now() + 60_000;
          if (!wasPressured) {
            this.sendEvent({
              type: "warning",
              code: "segment-relay-storage-pressure",
              message:
                "HTTPS 分片缓存空间紧张，已把发布前向窗口收敛到 120 秒",
            });
          }
          this.updatePressure();
        }
        const result = {
          etag: response.headers.get("etag") || undefined,
          manifestRevision: Number(
            response.headers.get("x-synced-manifest-revision"),
          ),
          evictionRevision: Number(
            response.headers.get("x-synced-eviction-revision"),
          ),
        };
        await response.body?.cancel().catch(() => undefined);
        return result;
      } catch (error) {
        lastError = error;
        stream.destroy();
        if (
          error instanceof SegmentRelayHttpError &&
          error.status === 507
        ) {
          this.noteServerStoragePressure(error.details);
          this.reconcileManifestConflict(error);
          break;
        }
        if (
          error instanceof SegmentRelayHttpError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 425, 429].includes(error.status)
        ) {
          break;
        }
        if (attempt < RELAY_UPLOAD_MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, 250 * 2 ** (attempt - 1)),
          );
        }
      } finally {
        clearTimeout(idleTimer);
        this.controller.signal.removeEventListener("abort", abort);
      }
    }
    throw lastError || new Error("HTTPS 分片上传失败");
  }

  noteServerStoragePressure(details) {
    const retryAfterMs = Math.max(
      15_000,
      Math.min(5 * 60_000, Number(details?.retryAfterMs) || 60_000),
    );
    const wasPressured = Date.now() < this.serverPressureUntil;
    this.serverPressureUntil = Math.max(
      this.serverPressureUntil,
      Date.now() + retryAfterMs,
    );
    if (!wasPressured) {
      this.sendEvent({
        type: "warning",
        code: "segment-relay-storage-pressure",
        message:
          "HTTPS 分片缓存已达到硬上限，发布已暂停并收敛到 120 秒前向窗口",
      });
    }
    this.updatePressure();
  }

  retireLocalPrefix(state, throughSequence) {
    const through = Number(throughSequence);
    if (!Number.isSafeInteger(through) || through < 1) return false;
    let changed = false;
    for (const collection of [
      state.descriptors,
      state.uploadedDescriptors,
      state.segments,
    ]) {
      for (const sequence of [...collection.keys()]) {
        if (sequence > through) continue;
        collection.delete(sequence);
        changed = true;
      }
    }
    state.firstSegmentSequence = Math.max(
      Number(state.firstSegmentSequence) || 1,
      through + 1,
    );
    if (
      state.contiguousUploadedSequence !== undefined &&
      state.contiguousUploadedSequence <= through
    ) {
      state.contiguousUploadedSequence = undefined;
    }
    for (const [key, record] of this.records) {
      if (
        record.renditionId !== state.id ||
        record.kind !== "segment" ||
        Number(record.sequence) > through
      ) {
        continue;
      }
      record.retired = true;
      record.failed = false;
      record.recoveryQueued = false;
      this.failedRecords.delete(record);
      this.records.delete(key);
      this.diskBytes = Math.max(0, this.diskBytes - record.bytes);
      void fsp.unlink(record.filePath).catch(() => undefined);
      changed = true;
    }
    return changed;
  }

  retireLocalSuffix(state, fromSequence) {
    const from = Number(fromSequence);
    if (!Number.isSafeInteger(from) || from < 1) return false;
    let changed = false;
    for (const collection of [
      state.descriptors,
      state.uploadedDescriptors,
      state.segments,
    ]) {
      for (const sequence of [...collection.keys()]) {
        if (sequence < from) continue;
        collection.delete(sequence);
        changed = true;
      }
    }
    if (
      state.contiguousUploadedSequence !== undefined &&
      state.contiguousUploadedSequence >= from
    ) {
      const retained = [...state.segments.keys()]
        .filter((sequence) => sequence < from)
        .sort((left, right) => left - right);
      state.contiguousUploadedSequence = retained.at(-1);
    }
    state.suffixRecoveryFrom =
      state.suffixRecoveryFrom === undefined
        ? from
        : Math.min(state.suffixRecoveryFrom, from);
    state.ended = false;
    for (const [key, record] of this.records) {
      if (
        record.renditionId !== state.id ||
        record.kind !== "segment" ||
        Number(record.sequence) < from
      ) {
        continue;
      }
      record.retired = true;
      record.failed = false;
      record.recoveryQueued = false;
      this.failedRecords.delete(record);
      this.records.delete(key);
      this.diskBytes = Math.max(0, this.diskBytes - record.bytes);
      void fsp.unlink(record.filePath).catch(() => undefined);
      changed = true;
    }
    state.recoveryQueue = state.recoveryQueue.filter(
      (record) => !record.retired,
    );
    return changed;
  }

  queueMissingRecord(state, record) {
    if (
      !record ||
      record.retired ||
      record.recoveryQueued ||
      !fs.existsSync(record.filePath)
    ) {
      return false;
    }
    record.uploaded = false;
    record.failed = false;
    record.retryAttempts = 0;
    record.nextRetryAt = 0;
    record.recoveryQueued = true;
    this.failedRecords.delete(record);
    state.recoveryQueue.push(record);
    state.recoveryQueue.sort(
      (left, right) =>
        Number(left.sequence) - Number(right.sequence),
    );
    return true;
  }

  reopenContiguousPrefixAt(state, missingSequence) {
    const sequence = Number(missingSequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) return;
    for (const [candidate, descriptor] of [...state.segments]) {
      if (candidate < sequence) continue;
      state.segments.delete(candidate);
      if (candidate !== sequence) {
        state.uploadedDescriptors.set(candidate, descriptor);
      }
    }
    state.uploadedDescriptors.delete(sequence);
    state.contiguousUploadedSequence =
      sequence > (Number(state.firstSegmentSequence) || sequence)
        ? sequence - 1
        : undefined;
  }

  reconcileManifestConflict(error) {
    if (
      !(error instanceof SegmentRelayHttpError) ||
      ![409, 507].includes(error.status) ||
      !error.details ||
      typeof error.details !== "object"
    ) {
      return false;
    }
    const details = error.details;
    if (error.status === 507) {
      this.noteServerStoragePressure(details);
    }
    const evictionRevision = Number(details.evictionRevision);
    const revision = Number(details.revision);
    if (Number.isSafeInteger(revision) && revision >= 0) {
      this.manifestRevision = Math.max(this.manifestRevision, revision);
    }
    let changed = false;
    const previousAcknowledgedEvictionRevision =
      this.acknowledgedEvictionRevision;
    if (
      Number.isSafeInteger(evictionRevision) &&
      evictionRevision >= this.acknowledgedEvictionRevision
    ) {
      this.acknowledgedEvictionRevision = evictionRevision;
      changed =
        evictionRevision > previousAcknowledgedEvictionRevision ||
        changed;
      for (const value of Array.isArray(details.tombstones)
        ? details.tombstones
        : []) {
        const renditionId = cleanText(
          value?.renditionId,
          32,
        ).toLowerCase();
        const throughSequence = Number(value?.throughSequence);
        const fromSequence = Number(value?.fromSequence);
        const hasThrough =
          Number.isSafeInteger(throughSequence) &&
          throughSequence >= 1;
        const hasFrom =
          Number.isSafeInteger(fromSequence) &&
          fromSequence >= 1;
        if (
          !/^[a-z0-9][a-z0-9-]{0,31}$/.test(renditionId) ||
          (!hasThrough && !hasFrom) ||
          (hasThrough && hasFrom && throughSequence >= fromSequence)
        ) {
          continue;
        }
        const prior = this.serverTombstones.get(renditionId);
        const incomingTombstoneRevision = Math.max(
          Number(value?.evictionRevision) || evictionRevision,
          0,
        );
        const newerTombstoneRevision =
          !prior ||
          incomingTombstoneRevision >
            Number(prior.evictionRevision || 0);
        const applyThrough =
          hasThrough &&
          (newerTombstoneRevision ||
            throughSequence >
              Number(prior?.throughSequence || 0));
        const applyFrom =
          hasFrom &&
          (newerTombstoneRevision ||
            fromSequence <
              Number(
                prior?.fromSequence ||
                  Number.MAX_SAFE_INTEGER,
              ));
        const next = {
          renditionId,
          ...(hasThrough || Number.isSafeInteger(prior?.throughSequence)
            ? {
                throughSequence: Math.max(
                  Number(prior?.throughSequence) || 0,
                  hasThrough ? throughSequence : 0,
                ),
              }
            : {}),
          ...(hasFrom || Number.isSafeInteger(prior?.fromSequence)
            ? {
                fromSequence: Math.min(
                  Number(prior?.fromSequence) ||
                    Number.MAX_SAFE_INTEGER,
                  hasFrom ? fromSequence : Number.MAX_SAFE_INTEGER,
                ),
              }
            : {}),
          evictionRevision: Math.max(
            incomingTombstoneRevision,
            Number(prior?.evictionRevision) || 0,
          ),
        };
        this.serverTombstones.set(renditionId, next);
        changed =
          !prior ||
          Number(next.throughSequence) >
            Number(prior.throughSequence || 0) ||
          Number(next.fromSequence || Number.MAX_SAFE_INTEGER) <
            Number(prior.fromSequence || Number.MAX_SAFE_INTEGER) ||
          next.evictionRevision >
            Number(prior.evictionRevision) ||
          changed;
        const state = this.renditions.get(renditionId);
        if (state) {
          if (
            applyThrough &&
            Number.isSafeInteger(next.throughSequence)
          ) {
            changed =
              this.retireLocalPrefix(state, next.throughSequence) ||
              changed;
          }
          if (
            applyFrom &&
            Number.isSafeInteger(next.fromSequence)
          ) {
            changed =
              this.retireLocalSuffix(state, next.fromSequence) ||
              changed;
          }
        }
      }
    }
    const missing = (Array.isArray(details.missing)
      ? details.missing
      : []
    ).sort(
      (left, right) =>
        Number(left?.sequence || 0) - Number(right?.sequence || 0),
    );
    for (const item of missing) {
      if (item.kind === "subtitle") {
        if (this.manifestSubtitle) {
          this.manifestSubtitle = undefined;
          changed = true;
        }
        continue;
      }
      const state = this.renditions.get(
        cleanText(item?.renditionId, 32).toLowerCase(),
      );
      if (!state) continue;
      if (item.kind === "init") {
        const epoch = Number(item.epoch || state.producerEpoch);
        const record = this.records.get(`${state.id}:init:${epoch}`);
        if (this.queueMissingRecord(state, record)) {
          state.initUploaded = false;
          changed = true;
        } else if (
          epoch === state.producerEpoch &&
          Buffer.isBuffer(state.initData) &&
          state.initData.length > 0 &&
          state.initPath &&
          !state.initRecoveryPending
        ) {
          state.initUploaded = false;
          state.initRecoveryPending = true;
          this.enqueueSpool(state, {
            kind: "init",
            sequence: 0,
            epoch,
            data: Buffer.from(state.initData),
            relativePath: state.initPath,
            contentType: "video/mp4",
            headers: {},
          });
          changed = true;
        }
        continue;
      }
      if (item.kind !== "segment") continue;
      const sequence = Number(item.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1) continue;
      const record = this.records.get(
        `${state.id}:segment:${sequence}`,
      );
      if (record && fs.existsSync(record.filePath)) {
        this.reopenContiguousPrefixAt(state, sequence);
        changed = this.queueMissingRecord(state, record) || changed;
      } else {
        // If the local spool has already retired the missing historical
        // object, advance the advertised prefix. This sacrifices only the
        // unavailable rewind tail and guarantees that anchor/ended updates
        // cannot remain wedged behind a permanent 409.
        changed = this.retireLocalPrefix(state, sequence) || changed;
      }
    }
    if (
      !changed &&
      ["manifest-revision-conflict", "storage-capacity-exceeded"].includes(
        details.code,
      )
    ) {
      changed = true;
    }
    if (!changed) return false;
    this.serverPressureUntil = Math.max(
      this.serverPressureUntil,
      Date.now() + 60_000,
    );
    this.sendEvent({
      type: "warning",
      code: "segment-manifest-reconciled",
      message:
        "已与 HTTPS 中继的淘汰版本重新同步，后续播放锚点将继续发布",
      evictionRevision: this.acknowledgedEvictionRevision,
    });
    if (error.status !== 507) this.pumpUploads();
    this.updatePressure();
    return true;
  }

  scheduleManifest() {
    this.manifestDirty = true;
    if (
      this.manifestUploading ||
      this.manifestRetryTimer ||
      this.closed
    ) {
      return;
    }
    this.manifestUploading = true;
    let failed = false;
    void this.flushManifest()
      .then(() => {
        this.manifestRetryAttempts = 0;
      })
      .catch((error) => {
        failed = true;
        this.manifestDirty = true;
        this.manifestRetryAttempts += 1;
        this.sendEvent({
          type: "warning",
          code: "segment-manifest-upload-failed",
          message: cleanText(error?.message || error, 500),
        });
        if (!this.closed && !this.manifestRetryTimer) {
          const retryMs =
            error instanceof SegmentRelayHttpError && error.status === 507
              ? Math.max(
                  1_000,
                  this.serverPressureUntil - Date.now(),
                )
              : Math.min(
                  15_000,
                  500 *
                    2 ** Math.min(5, this.manifestRetryAttempts - 1),
                );
          this.manifestRetryTimer = setTimeout(() => {
            this.manifestRetryTimer = undefined;
            this.scheduleManifest();
          }, retryMs);
          this.manifestRetryTimer.unref?.();
        }
      })
      .finally(() => {
        this.manifestUploading = false;
        if (
          this.manifestDirty &&
          !this.closed &&
          !failed &&
          !this.manifestRetryTimer
        ) {
          this.scheduleManifest();
        }
      });
  }

  async flushManifest() {
    while (this.manifestDirty && !this.closed) {
      this.manifestDirty = false;
      const ready = [...this.renditions.values()].filter(
        (state) => state.initUploaded && state.plan && !state.dormant,
      );
      if (!ready.length) continue;
      const primary = ready[0];
      const revision = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.manifestRevision + 1,
      );
      this.manifestRevision = revision;
      const anchorTimeMs =
        this.playbackAnchorTimeMs ??
        Number(primary.plan.startTimeTicks || 0) / 10_000;
      for (const state of ready) {
        for (const [sequence, descriptor] of state.descriptors) {
          if (descriptor.timelineTimeMs >= anchorTimeMs - 120_000) break;
          state.descriptors.delete(sequence);
          state.segments.delete(sequence);
        }
      }
      const buildManifest = (deepWindowMs) => ({
        protocol: "synced-cmaf-v1",
        segmentEncoding: "tuple-v1",
        roomId: this.config.roomId,
        sessionId: this.config.sessionId,
        assetId: this.config.assetId,
        mediaVersion: this.config.mediaVersion,
        revision,
        evictionRevision: this.acknowledgedEvictionRevision,
        acknowledgedEvictionRevision:
          this.acknowledgedEvictionRevision,
        tombstones: [...this.serverTombstones.values()].sort(
          (left, right) =>
            left.renditionId.localeCompare(right.renditionId),
        ),
        title: primary.title || "Emby 影片",
        startTimeTicks: Number(primary.plan.startTimeTicks) || 0,
        runtimeTicks: Number(primary.plan.runtimeTicks) || undefined,
        updatedAt: Date.now(),
        playbackTimeMs: anchorTimeMs,
        ended: this.manifestEnded,
        subtitle: this.manifestSubtitle,
        renditions: ready
          .map((state) => ({
            id: state.id,
            epoch: state.producerEpoch,
            label: cleanText(state.plan.quality?.label || state.id, 80),
            width: Number(state.plan.width) || 1,
            height: Number(state.plan.height) || 1,
            frameRate: Number(state.plan.frameRate) || 30,
            bitrate: Number(state.plan.bitrate) || 1,
            mimeType: state.mimeType,
            switchGroup: state.switchGroup,
            initPath: state.initPath,
            ended:
              (this.manifestEnded || state.ended) &&
              !state.spooling &&
              state.pendingHead >= state.pending.length &&
              !state.uploadActive &&
              state.recoveryQueue.length === 0 &&
              state.uploadHead >= state.uploadQueue.length,
            finalSequence:
              state.contiguousUploadedSequence === undefined
                ? undefined
                : state.contiguousUploadedSequence,
            finalTimelineEndMs: (() => {
              const finalSegment =
                state.contiguousUploadedSequence === undefined
                  ? undefined
                  : state.segments.get(state.contiguousUploadedSequence);
              return finalSegment
                ? finalSegment.timelineTimeMs +
                    Math.max(1, finalSegment.durationMs)
                : undefined;
            })(),
            segments: [...state.segments.values()]
              .filter(
                (segment) =>
                  segment.timelineTimeMs >= anchorTimeMs - 60_000 &&
                  segment.timelineTimeMs <= anchorTimeMs + deepWindowMs,
              )
              .sort(
                (left, right) =>
                  left.timelineTimeMs - right.timelineTimeMs ||
                  left.sequence - right.sequence,
              )
              .map((segment) => [
                segment.sequence,
                segment.mediaTimeMs,
                segment.timelineTimeMs,
                segment.durationMs,
                segment.keyframe ? 1 : 0,
                segment.bytes,
                segment.sha256,
              ]),
          }))
          .sort(
            (left, right) =>
              left.bitrate - right.bitrate || left.height - right.height,
          ),
      });
      // Publish a bounded sliding control window. Historical segments remain
      // in relay/cache storage without being reserialized on every revision.
      let deepWindowMs = Math.min(this.forwardWindowMs(), 15 * 60_000);
      let manifest = buildManifest(deepWindowMs);
      let body = Buffer.from(JSON.stringify(manifest));
      while (body.length > 480_000 && deepWindowMs > 60_000) {
        deepWindowMs = Math.max(60_000, Math.floor(deepWindowMs * 0.7));
        manifest = buildManifest(deepWindowMs);
        body = Buffer.from(JSON.stringify(manifest));
      }
      const filePath = path.join(this.rootDir, "manifest.json");
      await fsp.writeFile(filePath, body, { mode: 0o600 });
      try {
        const result = await this.uploadFile(
          new URL(this.manifestPath(), this.config.baseUrl),
          filePath,
          body.length,
          {
            "content-type": "application/json; charset=utf-8",
            "x-content-sha256": createHash("sha256")
              .update(body)
              .digest("hex"),
          },
          true,
        );
        if (
          Number.isSafeInteger(result?.evictionRevision) &&
          result.evictionRevision > this.acknowledgedEvictionRevision
        ) {
          this.manifestDirty = true;
        }
      } catch (error) {
        this.manifestDirty = true;
        if (this.reconcileManifestConflict(error)) {
          if (error instanceof SegmentRelayHttpError && error.status === 507) {
            throw error;
          }
          continue;
        }
        throw error;
      }
    }
  }

  evictDisk() {
    if (this.diskBytes <= this.maxDiskBytes) return;
    const targetBytes = this.maxDiskBytes * 0.85;
    for (const [key, record] of this.records) {
      if (this.diskBytes <= targetBytes) break;
      if (!record.uploaded || record.kind === "init") continue;
      this.records.delete(key);
      this.diskBytes = Math.max(0, this.diskBytes - record.bytes);
      void fsp.unlink(record.filePath).catch(() => undefined);
    }
  }

  applyProducerPause(state) {
    const shouldPause =
      state.pressurePaused === true ||
      state.demandPaused === true ||
      state.budgetPaused === true;
    if (shouldPause === state.producerPaused) return;
    state.producerPaused = shouldPause;
    if (shouldPause) state.pause();
    else state.resume();
  }

  updatePressure() {
    const storagePressured =
      Date.now() < this.serverPressureUntil ||
      this.memoryQueuedBytes >= RELAY_MEMORY_HIGH_WATER_BYTES ||
      this.diskBytes >= this.maxDiskBytes;
    const storageRecovered =
      Date.now() >= this.serverPressureUntil &&
      this.memoryQueuedBytes <= RELAY_MEMORY_LOW_WATER_BYTES &&
      this.diskBytes < this.maxDiskBytes * 0.9;
    const forwardWindowMs = this.forwardWindowMs();
    for (const state of this.renditions.values()) {
      const aheadMs =
        this.playbackAnchorTimeMs !== undefined &&
        state.previousTimelineTimeMs !== undefined
          ? state.previousTimelineTimeMs - this.playbackAnchorTimeMs
          : 0;
      const horizonPressured = aheadMs >= forwardWindowMs;
      const horizonRecovered = aheadMs <= forwardWindowMs * 0.9;
      if (
        (storagePressured || horizonPressured) &&
        !state.pressurePaused
      ) {
        state.pressurePaused = true;
      } else if (
        storageRecovered &&
        horizonRecovered &&
        state.pressurePaused
      ) {
        state.pressurePaused = false;
      }
      this.applyProducerPause(state);
    }
  }

  dataQueuesDrained() {
    return (
      this.activeUploads === 0 &&
      [...this.renditions.values()].every(
        (state) =>
          !state.spooling &&
          state.pendingHead >= state.pending.length &&
          state.recoveryQueue.length === 0 &&
          state.uploadHead >= state.uploadQueue.length,
      )
    );
  }

  async waitForFinalDrain(timeoutMs = RELAY_FINAL_DRAIN_TIMEOUT_MS) {
    const deadline = performance.now() + timeoutMs;
    while (!this.closed && performance.now() < deadline) {
      for (const state of this.renditions.values()) this.pumpSpool(state);
      this.pumpUploads();
      if (this.dataQueuesDrained()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.dataQueuesDrained();
  }

  async waitForManifestIdle(timeoutMs = 3_000) {
    const deadline = performance.now() + timeoutMs;
    while (
      !this.closed &&
      this.manifestUploading &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !this.manifestUploading;
  }

  async close(ended = false) {
    if (this.closed) return;
    if (this.manifestRetryTimer) {
      clearTimeout(this.manifestRetryTimer);
      this.manifestRetryTimer = undefined;
    }
    if (this.failedRetryTimer) {
      clearTimeout(this.failedRetryTimer);
      this.failedRetryTimer = undefined;
    }
    if (ended) {
      const drained = await this.waitForFinalDrain();
      await this.waitForManifestIdle();
      this.manifestEnded = true;
      this.manifestDirty = true;
      let finalManifestTimer;
      try {
        await Promise.race([
          this.flushManifest().catch((error) => {
            this.sendEvent({
              type: "warning",
              code: "segment-final-manifest-upload-failed",
              message: cleanText(error?.message || error, 500),
            });
          }),
          new Promise((resolve) => {
            finalManifestTimer = setTimeout(resolve, 3_000);
          }),
        ]);
      } finally {
        clearTimeout(finalManifestTimer);
      }
      if (!drained) {
        this.sendEvent({
          type: "warning",
          code: "segment-relay-final-drain-timeout",
          message: "分片尾部在 10 秒内未完成上传，已执行有界关闭",
        });
      }
    }
    this.closed = true;
    if (this.failedRetryTimer) {
      clearTimeout(this.failedRetryTimer);
      this.failedRetryTimer = undefined;
    }
    if (this.manifestRetryTimer) {
      clearTimeout(this.manifestRetryTimer);
      this.manifestRetryTimer = undefined;
    }
    this.generation += 1;
    this.controller.abort("relay-closed");
    for (const state of this.renditions.values()) {
      if (state.producerPaused) state.resume();
      state.producerPaused = false;
    }
  }
}

class EmbyService {
  constructor(options = {}) {
    this.version = cleanText(options.version || APP_VERSION, 32);
    this.deviceId = cleanText(options.deviceId || randomUUID(), 128);
    this.ffmpegPath = resolveFfmpegPath(options);
    this.spawnProcess =
      typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
    this.allowHardwareEncoding =
      options.allowHardwareEncoding !== false &&
      this.spawnProcess === spawn;
    this.sendEvent =
      typeof options.sendEvent === "function" ? options.sendEvent : () => {};
    this.cacheDir = cleanText(options.cacheDir, 4_096) || undefined;
    this.maxSegmentCacheBytes =
      Number(options.maxSegmentCacheBytes) || undefined;
    this.relayCoordinator = options.relayCoordinator;
    this.ownsRelayCoordinator = false;
    this.auxiliary = options.auxiliary === true;
    this.auxiliaryServices = new Map();
    this.auxiliaryStopPromises = new Map();
    this.auxiliaryRetryTimers = new Map();
    this.auxiliaryRetryAttempts = new Map();
    this.auxiliaryServiceFactory =
      typeof options.auxiliaryServiceFactory === "function"
        ? options.auxiliaryServiceFactory
        : (serviceOptions) => new EmbyService(serviceOptions);
    this.auxiliaryIdleTimers = new Map();
    this.auxiliaryDemand = new Set(
      CMAF_AUXILIARY_RENDITIONS.filter(
        (rendition) => rendition.defaultActive,
      ).map((rendition) => rendition.id),
    );
    this.auxiliarySourceInput = undefined;
    this.auxiliaryIdleMs = Math.max(
      1_000,
      Math.min(
        5 * 60_000,
        Number(options.auxiliaryIdleMs) || AUXILIARY_RENDITION_IDLE_MS,
      ),
    );
    this.streamInitTimeoutMs = Math.max(
      500,
      Math.min(
        60_000,
        Number(options.streamInitTimeoutMs) || STREAM_INIT_TIMEOUT_MS,
      ),
    );
    this.childServiceOptions = {
      version: this.version,
      deviceId: this.deviceId,
      ffmpegPath: this.ffmpegPath,
      spawnProcess: this.spawnProcess,
      streamInitTimeoutMs: this.streamInitTimeoutMs,
      cacheDir: this.cacheDir,
      maxSegmentCacheBytes: this.maxSegmentCacheBytes,
      allowHardwareEncoding: this.allowHardwareEncoding,
    };
    this.session = undefined;
    this.pipeline = undefined;
    this.streamGeneration = 0;
    this.imageCache = new Map();
    this.lastSuccessfulEndpointId = "";
    this.lastEndpointSuccessAt = 0;
  }

  requireSession() {
    if (!this.session?.token || !this.session?.userId) {
      throw new Error("请先登录 Emby");
    }
    return this.session;
  }

  endpointRecords() {
    const session = this.requireSession();
    const endpoints =
      Array.isArray(session.endpoints) && session.endpoints.length
        ? session.endpoints
        : [
            {
              id: endpointIdFor(session.serverUrl),
              url: session.serverUrl,
              label: "主线路",
              priority: 0,
            },
          ];
    return [...endpoints].sort(
      (left, right) =>
        (left.id === session.activeEndpointId ? -1 : 0) -
          (right.id === session.activeEndpointId ? -1 : 0) ||
        left.priority - right.priority,
    );
  }

  activateEndpoint(endpoint) {
    const session = this.requireSession();
    session.serverUrl = new URL(endpoint.url);
    session.activeEndpointId = endpoint.id;
    this.imageCache.clear();
    this.lastSuccessfulEndpointId = "";
    this.lastEndpointSuccessAt = 0;
  }

  loginResult() {
    const session = this.requireSession();
    return {
      user: { id: session.userId, name: session.username },
      server: {
        name: session.serverName || session.serverUrl.hostname,
        version: session.serverVersion || undefined,
        address: session.serverUrl.toString(),
        insecure: session.serverUrl.protocol === "http:",
        id: session.serverId || undefined,
        activeEndpointId: session.activeEndpointId,
        endpoints: this.endpointRecords()
          .sort((left, right) => left.priority - right.priority)
          .map((endpoint) => ({
            id: endpoint.id,
            url: endpoint.url.toString(),
            label: endpoint.label,
            priority: endpoint.priority,
            active: endpoint.id === session.activeEndpointId,
          })),
      },
    };
  }

  exportSession() {
    const session = this.requireSession();
    return {
      serverUrl: session.serverUrl.toString(),
      token: session.token,
      userId: session.userId,
      username: session.username,
      serverName: session.serverName || session.serverUrl.hostname,
      serverVersion: session.serverVersion || undefined,
      serverId: session.serverId || undefined,
      activeEndpointId: session.activeEndpointId,
      endpoints: this.endpointRecords()
        .sort((left, right) => left.priority - right.priority)
        .map((endpoint) => ({
          id: endpoint.id,
          url: endpoint.url.toString(),
          label: endpoint.label,
          priority: endpoint.priority,
        })),
      insecure: session.serverUrl.protocol === "http:",
    };
  }

  restoreSession(input = {}) {
    const endpointInputs =
      Array.isArray(input.endpoints) && input.endpoints.length
        ? input.endpoints.map((endpoint) => endpoint?.url)
        : [input.serverUrl];
    const endpoints = normalizeEndpointUrls(
      endpointInputs,
      input.insecure === true ||
        endpointInputs.some((value) => /^http:\/\//i.test(String(value || ""))),
    ).map((endpoint, index) => ({
      ...endpoint,
      label:
        cleanText(input.endpoints?.[index]?.label, 80) ||
        (index ? `备用线路 ${index}` : "主线路"),
      priority: index,
    }));
    const activeEndpoint =
      endpoints.find(
        (endpoint) =>
          endpoint.id === cleanText(input.activeEndpointId, 64),
      ) || endpoints[0];
    const serverUrl = activeEndpoint.url;
    const token = cleanText(input.token, 2_048);
    const userId = cleanText(input.userId, 128);
    const username = cleanText(input.username, 128);
    if (!token || !userId || !username) {
      throw new Error("本机保存的 Emby 登录信息无效");
    }
    this.session = {
      serverUrl,
      token,
      userId,
      username,
      endpoints,
      activeEndpointId: activeEndpoint.id,
      serverId: cleanText(input.serverId, 160) || undefined,
      serverName:
        cleanText(input.serverName, 160) || serverUrl.hostname,
      serverVersion: cleanText(input.serverVersion, 64) || undefined,
      deviceId: this.deviceId,
      version: this.version,
    };
    this.imageCache.clear();
    this.lastSuccessfulEndpointId = "";
    this.lastEndpointSuccessAt = 0;
    return this.loginResult();
  }

  async validateSession() {
    const session = this.requireSession();
    const user = await this.requestJson(
      `/Users/${encodeURIComponent(session.userId)}`,
      { totalTimeoutMs: 4_000 },
    );
    const returnedUserId = cleanText(user?.Id, 128);
    if (!returnedUserId || returnedUserId !== session.userId) {
      throw new Error("Emby 登录令牌已失效，请重新登录");
    }
    session.username =
      cleanText(user?.Name, 128) || session.username;
    // requestJson performs bounded endpoint failover and promotes the first
    // healthy route. Returning the refreshed login result makes an explicit
    // "reconnect" a real authenticated health check, not a local flag change.
    return this.loginResult();
  }

  async request(pathOrUrl, options = {}) {
    const session = this.requireSession();
    const absolute = /^https?:\/\//i.test(String(pathOrUrl || ""));
    const method = cleanText(options.method || "GET", 16).toUpperCase();
    const canFailOver =
      method === "GET" ||
      method === "HEAD" ||
      options.retryable === true;
    let endpoints = this.endpointRecords();
    if (absolute || this.pipeline || !canFailOver) {
      endpoints = endpoints.filter(
        (endpoint) => endpoint.id === session.activeEndpointId,
      );
    }
    const requestedTotalTimeout = Number(options.totalTimeoutMs);
    const totalTimeoutMs = Number.isFinite(requestedTotalTimeout)
      ? Math.max(1_000, Math.min(60_000, requestedTotalTimeout))
      : endpoints.length > 1
        ? 12_000
        : REQUEST_TIMEOUT_MS;
    const deadline = Date.now() + totalTimeoutMs;
    let lastError;
    for (let index = 0; index < endpoints.length; index += 1) {
      const endpoint = endpoints[index];
      const target = absolute
        ? new URL(String(pathOrUrl))
        : serverUrlFor(endpoint.url, pathOrUrl);
      if (target.origin !== endpoint.url.origin) {
        throw new Error("拒绝向 Emby 服务器以外的地址发送访问令牌");
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        lastError = new Error("连接 Emby 超时");
        break;
      }
      const timeout = requestTimeout(
        Math.min(
          remainingMs,
          endpoints.length > 1 ? 5_000 : REQUEST_TIMEOUT_MS,
        ),
      );
      let responseHandedOff = false;
      try {
        const fetched = await fetchWithScopedRedirects(target, {
          method,
          body: options.body,
          headersForUrl: () => ({
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Emby-Token": session.token,
            "X-Emby-Authorization": authHeader(this.deviceId, this.version),
            ...(options.headers || {}),
          }),
          signal: timeout.signal,
        });
        const response = fetched.response;
        if (
          response.status >= 500 &&
          index < endpoints.length - 1
        ) {
          lastError = await responseError(response);
          continue;
        }
        if (!response.ok) throw await responseError(response);
        if (endpoint.id !== session.activeEndpointId) {
          this.activateEndpoint(endpoint);
        }
        this.lastSuccessfulEndpointId = endpoint.id;
        this.lastEndpointSuccessAt = Date.now();
        if (options.discardBody === true) {
          await response.body?.cancel().catch(() => undefined);
          return response;
        }
        bindResponseDeadline(response, timeout);
        responseHandedOff = true;
        return response;
      } catch (error) {
        const retryable =
          error?.name === "AbortError" ||
          error?.status === undefined ||
          Number(error.status) >= 500;
        lastError =
          error?.name === "AbortError"
            ? new Error("连接 Emby 超时")
            : error;
        if (!retryable || index === endpoints.length - 1) break;
      } finally {
        if (!responseHandedOff) timeout.clear();
      }
    }
    throw new Error(
      `无法连接 Emby：${cleanText(lastError?.message || "所有线路均不可用", 300)}`,
    );
  }

  async requestJson(pathOrUrl, options = {}) {
    const response = await this.request(pathOrUrl, options);
    let bytes;
    try {
      bytes = await readResponseLimited(
        response,
        MAX_JSON_BYTES,
        "Emby 返回的数据异常过大",
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("连接 Emby 超时");
      }
      throw error;
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Emby 返回了无效的 JSON 数据");
    }
  }

  async login(input) {
    await this.logout();
    const enteredEndpoints = normalizeEndpointUrls(
      Array.isArray(input?.serverUrls) && input.serverUrls.length
        ? input.serverUrls
        : [input?.serverUrl],
      input?.allowInsecure === true,
    );
    const enteredServerUrl = enteredEndpoints[0].url;
    const username = cleanText(input?.username, 128);
    const password = String(input?.password || "");
    if (!username || password.length > 1_024) {
      throw new Error("请输入 Emby 用户名；无密码账户可以留空密码");
    }
    let authenticated;
    let serverUrl;
    const candidates = embyApiBaseCandidates(enteredServerUrl);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const timeout = requestTimeout();
      let response;
      try {
        const fetched = await fetchWithScopedRedirects(
          serverUrlFor(candidate, "/Users/AuthenticateByName"),
          {
            method: "POST",
            headersForUrl: () => ({
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-Emby-Authorization": authHeader(this.deviceId, this.version),
            }),
            body: JSON.stringify({ Username: username, Pw: password }),
            signal: timeout.signal,
          },
        );
        response = fetched.response;
      } catch (error) {
        if (error?.name === "AbortError") throw new Error("连接 Emby 超时");
        throw new Error(`无法连接 Emby：${cleanText(error?.message, 300)}`);
      } finally {
        timeout.clear();
      }
      if (!response.ok) {
        if (response.status === 404 && index < candidates.length - 1) {
          await response.body?.cancel().catch(() => undefined);
          continue;
        }
        throw await responseError(response);
      }
      try {
        const parsed = JSON.parse(
          (
            await readResponseLimited(
              response,
              1024 * 1024,
              "Emby 登录响应异常过大",
            )
          ).toString("utf8"),
        );
        if (
          cleanText(parsed?.AccessToken || parsed?.accessToken, 2_048) &&
          cleanText(parsed?.User?.Id, 128)
        ) {
          authenticated = parsed;
          serverUrl = candidate;
          break;
        }
      } catch (error) {
        if (/异常过大/.test(String(error?.message || ""))) throw error;
      }
      if (index === candidates.length - 1) {
        throw new Error("Emby 登录响应格式无效");
      }
    }
    if (!authenticated || !serverUrl) throw new Error("Emby 登录响应格式无效");
    const token = cleanText(
      authenticated?.AccessToken || authenticated?.accessToken,
      2_048,
    );
    const userId = cleanText(authenticated?.User?.Id, 128);
    if (!token || !userId) throw new Error("Emby 登录响应缺少访问令牌");
    this.session = {
      serverUrl,
      endpoints: [
        {
          id: endpointIdFor(serverUrl),
          url: serverUrl,
          label: "主线路",
          priority: 0,
        },
      ],
      activeEndpointId: endpointIdFor(serverUrl),
      token,
      userId,
      username: cleanText(authenticated?.User?.Name || username, 128),
      serverName: serverUrl.hostname,
      serverVersion: undefined,
      deviceId: this.deviceId,
      version: this.version,
    };
    let serverInfo = {};
    try {
      serverInfo = await this.requestJson("/System/Info");
    } catch {
      // Older or restricted Emby accounts may not expose System/Info.
    }
    this.session.serverName =
      cleanText(serverInfo?.ServerName, 160) || serverUrl.hostname;
    this.session.serverVersion =
      cleanText(serverInfo?.Version, 64) || undefined;
    this.session.serverId =
      cleanText(serverInfo?.Id || serverInfo?.ServerId, 160) || undefined;
    if (enteredEndpoints.length > 1) {
      try {
        if (!this.session.serverId) {
          const primaryInfo = await probeEmbyEndpoint(
            serverUrl,
            undefined,
            this.deviceId,
            this.version,
            serverUrl.protocol === "http:",
          );
          this.session.serverId = primaryInfo.serverId;
        }
        const endpoints = [this.session.endpoints[0]];
        for (const enteredEndpoint of enteredEndpoints.slice(1)) {
          const verified = await probeEmbyEndpoint(
            enteredEndpoint.url,
            this.session.serverId,
            this.deviceId,
            this.version,
            input?.allowInsecure === true,
          );
          if (
            endpoints.some(
              (endpoint) => endpoint.url.toString() === verified.url.toString(),
            )
          ) {
            continue;
          }
          endpoints.push({
            id: endpointIdFor(verified.url),
            url: verified.url,
            label: `备用线路 ${endpoints.length}`,
            priority: endpoints.length,
          });
        }
        this.session.endpoints = endpoints;
      } catch (error) {
        // Authentication succeeded on the primary route, but the requested
        // route set is not safe to retain. Revoke/discard that partial session
        // so callers can never continue with a login that was reported failed.
        await this.logout().catch(() => undefined);
        throw error;
      }
    }
    return this.loginResult();
  }

  async updateEndpoints(input = {}) {
    if (this.pipeline) {
      throw new Error("放映期间不能修改 Emby 线路，请先停止当前放映");
    }
    const session = this.requireSession();
    const enteredEndpoints = normalizeEndpointUrls(
      input.serverUrls,
      input.allowInsecure === true,
    );
    let serverId = session.serverId;
    if (!serverId) {
      const activeInfo = await probeEmbyEndpoint(
        session.serverUrl,
        undefined,
        this.deviceId,
        this.version,
        session.serverUrl.protocol === "http:",
      );
      serverId = activeInfo.serverId;
    }
    const verifiedEndpoints = [];
    for (const enteredEndpoint of enteredEndpoints) {
      const verified = await probeEmbyEndpoint(
        enteredEndpoint.url,
        serverId,
        this.deviceId,
        this.version,
        input.allowInsecure === true,
      );
      if (
        verifiedEndpoints.some(
          (endpoint) => endpoint.url.toString() === verified.url.toString(),
        )
      ) {
        continue;
      }
      verifiedEndpoints.push({
        id: endpointIdFor(verified.url),
        url: verified.url,
        label: verifiedEndpoints.length
          ? `备用线路 ${verifiedEndpoints.length}`
          : "主线路",
        priority: verifiedEndpoints.length,
      });
    }
    if (!verifiedEndpoints.length) {
      throw new Error("请至少保留一条可用的 Emby 线路");
    }
    const active =
      verifiedEndpoints.find(
        (endpoint) => endpoint.id === session.activeEndpointId,
      ) || verifiedEndpoints[0];
    session.serverId = serverId;
    session.endpoints = verifiedEndpoints;
    this.activateEndpoint(active);
    return this.loginResult();
  }

  async logout() {
    await this.stopStream("logout");
    if (this.session) {
      try {
        await this.request("/Sessions/Logout", {
          method: "POST",
          discardBody: true,
        });
      } catch {
        // The local token is discarded even if the server is offline.
      }
    }
    this.session = undefined;
    this.imageCache.clear();
    this.lastSuccessfulEndpointId = "";
    this.lastEndpointSuccessAt = 0;
  }

  async listViews() {
    const session = this.requireSession();
    const data = await this.requestJson(
      `/Users/${encodeURIComponent(session.userId)}/Views`,
      { totalTimeoutMs: 8_000 },
    );
    return (Array.isArray(data?.Items) ? data.Items : [])
      .filter((item) => item?.Id && item?.Name)
      .map((item) => safeItem(item, session.serverUrl));
  }

  async listItems(input = {}) {
    const session = this.requireSession();
    const query = new URLSearchParams({
      UserId: session.userId,
      Recursive: input.recursive === false ? "false" : "true",
      SortBy: "SortName,ProductionYear",
      SortOrder: "Ascending",
      Fields:
        "Overview,PrimaryImageAspectRatio,MediaSources,MediaStreams,Path,DateCreated,PremiereDate,OfficialRating,CommunityRating,Genres,Studios,Taglines",
      EnableImages: "true",
      EnableUserData: "true",
      ImageTypeLimit: "1",
      Limit: String(Math.min(500, Math.max(1, Number(input.limit) || 200))),
      StartIndex: String(
        Math.min(1_000_000, Math.max(0, Number(input.startIndex) || 0)),
      ),
    });
    const parentId = cleanText(input.parentId, 128);
    if (parentId) query.set("ParentId", parentId);
    const searchTerm = cleanText(input.searchTerm, 160);
    if (searchTerm) query.set("SearchTerm", searchTerm);
    const filters = Array.isArray(input.filters)
      ? input.filters
          .map((value) => cleanText(value, 32))
          .filter((value) =>
            ["IsResumable", "IsUnplayed", "IsPlayed", "IsFavorite"].includes(
              value,
            ),
          )
      : [];
    if (filters.length) query.set("Filters", filters.join(","));
    const allowedSort = new Set([
      "DateCreated",
      "DatePlayed",
      "PremiereDate",
      "ProductionYear",
      "SortName",
    ]);
    const sortBy = cleanText(input.sortBy, 80)
      .split(",")
      .map((value) => value.trim())
      .filter((value) => allowedSort.has(value));
    if (sortBy.length) query.set("SortBy", sortBy.join(","));
    if (input.sortOrder === "Descending") query.set("SortOrder", "Descending");
    const types = Array.isArray(input.includeItemTypes)
      ? input.includeItemTypes
          .map((value) => cleanText(value, 32))
          .filter((value) =>
            ["Movie", "Episode", "Series", "Season", "Video"].includes(value),
          )
      : ["Movie", "Episode", "Series", "Season", "Video"];
    query.set("IncludeItemTypes", types.join(","));
    const data = await this.requestJson(
      `/Users/${encodeURIComponent(session.userId)}/Items?${query}`,
      { totalTimeoutMs: 12_000 },
    );
    return {
      items: (Array.isArray(data?.Items) ? data.Items : []).map((item) =>
        safeItem(item, session.serverUrl),
      ),
      total: Number(data?.TotalRecordCount) || 0,
    };
  }

  async imageData(input) {
    const session = this.requireSession();
    const itemId = cleanText(input?.itemId, 128);
    const tag = cleanText(input?.tag, 128);
    if (!itemId) throw new Error("缺少 Emby 项目 ID");
    const key = `${itemId}:${tag}`;
    if (this.imageCache.has(key)) return this.imageCache.get(key);
    const query = new URLSearchParams({
      MaxWidth: "360",
      Quality: "84",
    });
    if (tag) query.set("Tag", tag);
    const response = await this.request(
      `/Items/${encodeURIComponent(itemId)}/Images/Primary?${query}`,
      {
        headers: { Accept: "image/*" },
        totalTimeoutMs: 10_000,
      },
    );
    const bytes = await readResponseLimited(
      response,
      4 * 1024 * 1024,
      "Emby 封面图片过大",
    );
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`;
    if (this.imageCache.size >= 120) {
      this.imageCache.delete(this.imageCache.keys().next().value);
    }
    this.imageCache.set(key, dataUrl);
    return dataUrl;
  }

  async rawPlaybackInfo(input = {}) {
    const session = this.requireSession();
    const itemId = cleanText(input.itemId, 128);
    if (!itemId) throw new Error("缺少 Emby 项目 ID");
    // Select a healthy, already verified endpoint with an idempotent request
    // before the stateful PlaybackInfo POST. This preserves automatic backup
    // routing without ever replaying AutoOpenLiveStream on another endpoint.
    const activeEndpointRecentlySucceeded =
      this.lastSuccessfulEndpointId === session.activeEndpointId &&
      Date.now() - this.lastEndpointSuccessAt <= ENDPOINT_RECENT_SUCCESS_MS;
    if (
      this.endpointRecords().length > 1 &&
      !activeEndpointRecentlySucceeded
    ) {
      await this.request("/System/Info/Public", {
        headers: { Accept: "application/json" },
        discardBody: true,
      });
    }
    const quality = qualityProfile(input.quality);
    const frameRate = normalizeEmbyFrameRate(input.frameRate);
    const forceVideoTranscode = input.forceVideoTranscode === true;
    const body = {
      UserId: session.userId,
      StartTimeTicks: Math.max(0, Number(input.startTimeTicks) || 0),
      MaxStreamingBitrate: quality.maxBitrate,
      MaxFramerate: frameRate,
      AudioStreamIndex: Number.isInteger(Number(input.audioStreamIndex))
        ? Number(input.audioStreamIndex)
        : undefined,
      SubtitleStreamIndex: Number.isInteger(Number(input.subtitleStreamIndex))
        ? Number(input.subtitleStreamIndex)
        : undefined,
      EnableDirectPlay: !quality.forceTranscode && !forceVideoTranscode,
      EnableDirectStream: !forceVideoTranscode,
      EnableTranscoding: true,
      AllowVideoStreamCopy: !forceVideoTranscode,
      AllowAudioStreamCopy: true,
      AlwaysBurnInSubtitleWhenTranscoding: false,
      EnableAutoStreamCopy: !forceVideoTranscode,
      TranscodingMaxAudioChannels: 2,
      MediaSourceId: cleanText(input.mediaSourceId, 128) || undefined,
      DeviceProfile: buildDeviceProfile(
        quality,
        input.allowHevc === true,
        input.preferMpegTs === true,
        frameRate,
      ),
    };
    const mediaSourceQuery = body.MediaSourceId
      ? `&MediaSourceId=${encodeURIComponent(body.MediaSourceId)}`
      : "";
    const autoOpenLiveStream = input.openLiveStream === true;
    const data = await this.requestJson(
      `/Items/${encodeURIComponent(
        itemId,
      )}/PlaybackInfo?UserId=${encodeURIComponent(
        session.userId,
      )}&StartTimeTicks=${body.StartTimeTicks}${mediaSourceQuery}&AutoOpenLiveStream=${autoOpenLiveStream ? "true" : "false"}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return { data, quality };
  }

  async playbackInfo(input = {}) {
    // Browsing a title must not allocate a live/transcode session. Repeated
    // preview requests used to leave orphaned Emby sessions and some servers
    // then rejected the real start request.
    const { data, quality } = await this.rawPlaybackInfo({
      ...input,
      openLiveStream: false,
    });
    const sources = Array.isArray(data?.MediaSources) ? data.MediaSources : [];
    return {
      playSessionId: cleanText(data?.PlaySessionId, 128),
      mediaSources: sources.map((source) => ({
        id: cleanText(source?.Id, 128),
        name: cleanText(source?.Name, 200) || "默认媒体源",
        container: cleanText(source?.Container, 32).toLowerCase(),
        bitrate: Number(source?.Bitrate) || undefined,
        runtimeTicks: Number(source?.RunTimeTicks) || undefined,
        supportsDirectPlay: source?.SupportsDirectPlay === true,
        supportsDirectStream: source?.SupportsDirectStream === true,
        supportsTranscoding: Boolean(source?.TranscodingUrl),
        streams: mediaStreams(source).map(streamSummary),
      })),
      quality,
    };
  }

  async buildPlan(input = {}) {
    const session = this.requireSession();
    const itemId = cleanText(input.itemId, 128);
    let { data: raw, quality } = await this.rawPlaybackInfo({
      ...input,
      openLiveStream: true,
    });
    let choice;
    try {
      choice = chooseSource(
        raw,
        {
          ...input,
          itemId,
          userId: session.userId,
          deviceId: session.deviceId,
        },
        quality,
      );
    } catch (initialError) {
      // Official web clients retry playback negotiation after a direct-play
      // or fMP4 route fails. Do the equivalent here with stream-copy disabled
      // and MPEG-TS HLS first; this covers older Emby builds, reverse proxies
      // that mishandle fMP4 manifests, and image subtitles that require burn-in.
      ({ data: raw, quality } = await this.rawPlaybackInfo({
        ...input,
        forceVideoTranscode: true,
        preferMpegTs: true,
        openLiveStream: true,
      }));
      try {
        choice = chooseSource(
          raw,
          {
            ...input,
            forceVideoTranscode: true,
            preferMpegTs: true,
            allowLocalVideoTranscode: true,
            itemId,
            userId: session.userId,
            deviceId: session.deviceId,
          },
          quality,
        );
      } catch (retryError) {
        throw new Error(
          `${cleanText(retryError?.message || retryError, 500)}（已自动尝试 fMP4、MPEG-TS HLS 和渐进式 MP4）`,
          { cause: initialError },
        );
      }
    }
    const video = streamSummary(choice.video);
    const audio = streamSummary(choice.audio);
    const requestedFrameRate = normalizeEmbyFrameRate(input.frameRate);
    const inputFrameRate = sourceFrameRate(choice.video);
    const outputFrameRate = Math.max(
      1,
      Math.min(requestedFrameRate, inputFrameRate || requestedFrameRate),
    );
    const localEncoding = choice.localVideoTranscode
      ? localTranscodeSettings(
          quality,
          Boolean(choice.audio),
          requestedFrameRate,
          inputFrameRate,
        )
      : undefined;
    const outputLimits = localEncoding || quality;
    const sourceWidth = Number(choice.video?.Width) || outputLimits.maxWidth;
    const sourceHeight = Number(choice.video?.Height) || outputLimits.maxHeight;
    const scale = Math.min(
      1,
      outputLimits.maxWidth / Math.max(1, sourceWidth),
      outputLimits.maxHeight / Math.max(1, sourceHeight),
    );
    const outputWidth = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
    const outputHeight = Math.max(
      2,
      Math.round((sourceHeight * scale) / 2) * 2,
    );
    return {
      internal: {
        upstreamPath: choice.upstreamPath,
        source: choice.source,
        video: choice.video,
        audio: choice.audio,
        subtitle: choice.subtitle,
        localVideoTranscode: choice.localVideoTranscode,
        upstreamPreservesSourceIndexes:
          choice.upstreamPreservesSourceIndexes,
        localEncoding,
      },
      public: {
        itemId,
        mediaSourceId: cleanText(choice.source?.Id, 128),
        playSessionId:
          cleanText(raw?.PlaySessionId, 128),
        method: choice.method,
        quality,
        video,
        audio,
        videoCodec: choice.videoCodec,
        audioCodec: choice.localAudioTranscode ? "aac" : choice.audioCodec,
        localVideoTranscode: choice.localVideoTranscode,
        localAudioTranscode: choice.localAudioTranscode,
        subtitleMode: choice.subtitleMode,
        width: outputWidth,
        height: outputHeight,
        frameRate: outputFrameRate,
        bitrate:
          localEncoding?.maxBitrate ||
          Math.min(
            Number(choice.source?.Bitrate) || quality.maxBitrate,
            quality.maxBitrate,
          ) ||
          quality.maxBitrate,
        runtimeTicks: Number(choice.source?.RunTimeTicks) || undefined,
        startTimeTicks: Math.max(0, Number(input.startTimeTicks) || 0),
      },
    };
  }

  async subtitleText(input, plan) {
    if (plan.public.subtitleMode === "burn-in") return undefined;
    const selected = Number(input.subtitleStreamIndex);
    if (!Number.isInteger(selected) || selected < 0) return undefined;
    const stream = mediaStreams(plan.internal.source).find(
      (candidate) =>
        candidate?.Type === "Subtitle" &&
        Number(candidate?.Index) === selected,
    );
    if (!stream) return undefined;
    const codec = cleanText(stream.Codec, 24).toLowerCase();
    if (
      stream?.IsTextSubtitleStream !== true &&
      !isTextSubtitleCodec(codec)
    ) {
      return {
        supported: false,
        codec,
        message: "所选字幕是图片字幕；请改选文本字幕或让 Emby 烧录转码",
      };
    }
    const sourceId = cleanText(plan.public.mediaSourceId, 128);
    const deliveryUrl = cleanText(stream.DeliveryUrl, 8_192);
    const path =
      deliveryUrl ||
      `/Videos/${encodeURIComponent(
        plan.public.itemId,
      )}/${encodeURIComponent(sourceId)}/Subtitles/${selected}/Stream.vtt`;
    const response = await this.request(path, {
      headers: { Accept: "text/vtt,text/plain,*/*" },
    });
    const bytes = await readResponseLimited(
      response,
      10 * 1024 * 1024,
      "字幕文件过大",
    );
    const text = decodeSubtitleBuffer(
      bytes,
      response.headers.get("content-type") || "",
    );
    return {
      supported: true,
      codec,
      language: cleanText(stream.Language, 24) || undefined,
      title: cleanText(stream.DisplayTitle || stream.Title, 160) || undefined,
      text,
    };
  }

  async startStream(input = {}) {
    const generation = ++this.streamGeneration;
    await this.stopStream("replaced", { preserveGeneration: true });
    const plan = await this.buildPlan(input);
    if (generation !== this.streamGeneration) {
      throw new Error("Emby 启动请求已被停止或替代");
    }
    const hardwareVideoEncoder =
      plan.internal.localVideoTranscode && this.allowHardwareEncoding
        ? await probeHardwareEncoder(this.ffmpegPath)
        : undefined;
    if (generation !== this.streamGeneration) {
      throw new Error("Emby 启动请求已被停止或替代");
    }
    if (plan.internal.localVideoTranscode) {
      plan.public.localVideoEncoder =
        hardwareVideoEncoder || "libopenh264";
    }
    const proxy = new EmbyLoopbackProxy(this.requireSession());
    await proxy.start();
    if (generation !== this.streamGeneration) {
      await proxy.close().catch(() => undefined);
      throw new Error("Emby 启动请求已被停止或替代");
    }
    const pipelineId = randomUUID();
    const parser = new FragmentedMp4Parser();
    const relayConfig = normalizeSegmentRelayConfig(input.segmentRelay);
    if (relayConfig && !this.relayCoordinator) {
      this.relayCoordinator = new CmafRelayCoordinator(relayConfig, {
        cacheDir: this.cacheDir,
        maxDiskBytes: this.maxSegmentCacheBytes,
        sendEvent: (event) =>
          this.sendEvent({
            ...event,
            pipelineId,
          }),
      });
      this.ownsRelayCoordinator = true;
    }
    const relayCoordinator = relayConfig
      ? this.relayCoordinator
      : undefined;
    if (relayCoordinator && !this.auxiliary) {
      relayCoordinator.updatePlaybackAnchor(plan.public.startTimeTicks);
    }
    // The host preview pipeline is paced by local MSE flow control. Deep
    // caching uses independent auxiliary producers so cache pressure can
    // never pause the host's urgent playback path.
    const relayProducer =
      relayCoordinator && this.auxiliary
        ? relayCoordinator
        : undefined;
    const renditionId =
      cleanText(input.renditionId, 32).toLowerCase() ||
      renditionIdForQuality(plan.public.quality);
    const startSeconds = plan.public.startTimeTicks / 10_000_000;
    const readAhead = embyReadAheadProfile(
      plan.public.bitrate,
      plan.internal.localVideoTranscode === true,
    );
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-nostdin",
      "-fflags",
      "+genpts+discardcorrupt",
    ];
    // Remux/direct producers are governed dynamically by the relay token
    // bucket, memory watermarks and disk pressure. A fixed -readrate made a
    // fast path incapable of building reserve. Only a CPU-bound local
    // transcode keeps the conservative encoder clock.
    if (plan.internal.localVideoTranscode === true) {
      args.push(
        "-readrate",
        String(readAhead.readRate),
        "-readrate_initial_burst",
        String(readAhead.initialBurstSeconds),
        "-readrate_catchup",
        String(readAhead.catchupRate),
      );
    }
    if (
      startSeconds > 0 &&
      (["DirectPlay", "LocalRemux"].includes(plan.public.method) ||
        plan.internal.localVideoTranscode === true)
    ) {
      args.push("-ss", startSeconds.toFixed(3));
    }
    const preservesSourceIndexes =
      plan.internal.upstreamPreservesSourceIndexes === true ||
      ["DirectPlay", "LocalRemux"].includes(plan.public.method);
    args.push(
      "-i",
      proxy.urlFor(plan.internal.upstreamPath),
      "-map",
      preservesSourceIndexes &&
      Number.isInteger(Number(plan.internal.video?.Index))
        ? `0:${Number(plan.internal.video.Index)}`
        : "0:v:0",
    );
    if (plan.internal.audio) {
      args.push(
        "-map",
        preservesSourceIndexes &&
        Number.isInteger(Number(plan.internal.audio?.Index))
          ? `0:${Number(plan.internal.audio.Index)}`
          : "0:a:0?",
      );
    }
    args.push("-sn", "-dn");
    if (plan.internal.localVideoTranscode) {
      const encoding =
        plan.internal.localEncoding ||
        localTranscodeSettings(
          plan.public.quality,
          Boolean(plan.internal.audio),
          plan.public.frameRate,
          plan.public.video?.frameRate,
        );
      // Keep source-derived fractional rates such as 23.976/29.97. Feeding
      // them back through the user-facing 24/30/60 normalizer would turn a
      // 23.976 fps film into 30 fps in the local fallback, despite the plan
      // correctly advertising the physical source ceiling.
      const rawEncodingFrameRate = Number(
        encoding.frameRate || plan.public.frameRate,
      );
      const encodingFrameRate = Number.isFinite(rawEncodingFrameRate)
        ? Math.max(1, Math.min(60, rawEncodingFrameRate))
        : normalizeEmbyFrameRate(plan.public.frameRate);
      args.push(
        "-vf",
        `scale=w='min(iw,${encoding.maxWidth})':h='min(ih,${encoding.maxHeight})':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${encodingFrameRate},setsar=1,format=yuv420p`,
      );
      appendH264EncoderArguments(
        args,
        hardwareVideoEncoder || "libopenh264",
        encoding,
        encodingFrameRate,
      );
    } else {
      args.push("-c:v", "copy");
      if (plan.public.videoCodec === "hevc") {
        args.push("-tag:v", "hvc1");
      } else {
        args.push("-tag:v", "avc1");
      }
    }
    if (plan.internal.audio) {
      if (plan.public.localAudioTranscode) {
        const localAudioBitrate =
          plan.internal.localEncoding?.audioBitrate || 256_000;
        args.push(
          "-c:a",
          "aac",
          "-profile:a",
          "aac_low",
          "-b:a",
          String(localAudioBitrate),
          "-ac",
          "2",
        );
      } else {
        args.push("-c:a", "copy");
      }
    }
    args.push(
      "-avoid_negative_ts",
      "make_zero",
      "-max_muxing_queue_size",
      "4096",
      "-max_interleave_delta",
      "0",
      "-movflags",
      "+empty_moov+default_base_moof+frag_keyframe",
      "-frag_duration",
      "2000000",
      "-min_frag_duration",
      "1000000",
      "-f",
      "mp4",
      "pipe:1",
    );
    let child;
    try {
      child = this.spawnProcess(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      await proxy.close().catch(() => undefined);
      throw new Error(
        `无法启动本地媒体组件：${cleanText(error?.message || error, 300)}`,
      );
    }
    const pipeline = {
      id: pipelineId,
      child,
      proxy,
      parser,
      plan,
      paused: false,
      stopping: false,
      stderr: "",
      startedAt: Date.now(),
      lastPositionTicks: plan.public.startTimeTicks,
      stopReported: false,
      initReceived: false,
      initTimer: undefined,
      lastParsedMediaTimeMs: undefined,
      lastParsedSequence: 0,
      lastEmittedMediaTimeMs: undefined,
      lastEmittedSequence: 0,
      recentFragmentCadenceMs: [],
      renditionId,
      relayCoordinator: relayProducer,
      relayPaused: false,
      progressWatchdog: undefined,
      lastProgressAt: Date.now(),
    };
    this.pipeline = pipeline;
    relayProducer?.registerProducer(renditionId, {
      pause: () => {
        if (this.pipeline !== pipeline || pipeline.stopping) return;
        pipeline.relayPaused = true;
        pipeline.child.stdout.pause();
      },
      resume: () => {
        if (this.pipeline !== pipeline || pipeline.stopping) return;
        pipeline.relayPaused = false;
        if (!pipeline.paused) pipeline.child.stdout.resume();
      },
    });
    pipeline.initTimer = setTimeout(() => {
      if (
        this.pipeline !== pipeline ||
        pipeline.stopping ||
        pipeline.initReceived
      ) {
        return;
      }
      const detail = pipeline.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-2)
        .join("；");
      this.sendEvent({
        type: "error",
        pipelineId,
        message: `Emby 媒体流初始化超时${
          detail ? `：${cleanText(detail, 500)}` : ""
        }`,
      });
      void this.stopStream("init-timeout");
    }, this.streamInitTimeoutMs);
    pipeline.initTimer.unref?.();
    parser.on("init", (data) => {
      if (this.pipeline !== pipeline) return;
      pipeline.initReceived = true;
      clearTimeout(pipeline.initTimer);
      pipeline.initTimer = undefined;
      const mimeType = detectMp4Mime(
        data,
        plan.public.videoCodec,
        Boolean(plan.internal.audio),
      );
      this.sendEvent({
        type: "init",
        pipelineId,
        data,
        mimeType,
        plan: plan.public,
        renditionId,
        auxiliary: this.auxiliary,
      });
      relayProducer?.publishInit(
        renditionId,
        plan.public,
        mimeType,
        data,
        cleanText(input.title, 300) || plan.public.itemId,
      );
    });
    parser.on(
      "fragment",
      ({ sequence, mediaTimeMs, keyframe, timelineRepairs, data }) => {
      if (this.pipeline !== pipeline) return;
      const parsedMediaTimeMs = Number.isFinite(mediaTimeMs)
        ? mediaTimeMs
        : undefined;
      if (
        parsedMediaTimeMs !== undefined &&
        pipeline.lastParsedMediaTimeMs !== undefined &&
        sequence > pipeline.lastParsedSequence
      ) {
        const cadence =
          (parsedMediaTimeMs - pipeline.lastParsedMediaTimeMs) /
          (sequence - pipeline.lastParsedSequence);
        if (cadence >= 100 && cadence <= 4_000) {
          pipeline.recentFragmentCadenceMs.push(cadence);
          if (pipeline.recentFragmentCadenceMs.length > 16) {
            pipeline.recentFragmentCadenceMs.shift();
          }
        }
      }
      if (parsedMediaTimeMs !== undefined) {
        pipeline.lastParsedMediaTimeMs = parsedMediaTimeMs;
        pipeline.lastParsedSequence = sequence;
      }
      const sortedCadence = [...pipeline.recentFragmentCadenceMs].sort(
        (left, right) => left - right,
      );
      const fallbackCadenceMs = sortedCadence.length
        ? sortedCadence[Math.floor(sortedCadence.length / 2)]
        : 2_000;
      const normalizedMediaTimeMs =
        parsedMediaTimeMs ??
        (pipeline.lastEmittedMediaTimeMs !== undefined
          ? pipeline.lastEmittedMediaTimeMs +
            Math.max(1, sequence - pipeline.lastEmittedSequence) *
              fallbackCadenceMs
          : plan.public.startTimeTicks / 10_000);
      pipeline.lastEmittedMediaTimeMs = normalizedMediaTimeMs;
      pipeline.lastEmittedSequence = sequence;
      this.sendEvent({
        type: "fragment",
        pipelineId,
        sequence,
        timestampMs: Date.now(),
        mediaTimeMs: normalizedMediaTimeMs,
        keyframe: keyframe === true,
        timelineRepairs,
        data,
        renditionId,
        auxiliary: this.auxiliary,
      });
      relayProducer?.publishFragment(renditionId, {
        sequence,
        mediaTimeMs: normalizedMediaTimeMs,
        keyframe: keyframe === true,
        data,
      });
      },
    );
    parser.on("warning", ({ code, message }) => {
      if (this.pipeline !== pipeline) return;
      this.sendEvent({
        type: "warning",
        pipelineId,
        code: cleanText(code, 64),
        message: cleanText(message, 500),
      });
    });
    let parserFailed = false;
    const handleParserError = (error) => {
      if (parserFailed || this.pipeline !== pipeline) return;
      parserFailed = true;
      this.sendEvent({
        type: "error",
        pipelineId,
        message: cleanText(error?.message || error, 500),
      });
      void this.stopStream("parser-error");
    };
    const finishParser = () => {
      if (parserFailed || this.pipeline !== pipeline) return;
      try {
        parser.finish();
      } catch (error) {
        handleParserError(error);
      }
    };
    child.stdout.on("data", (chunk) => {
      if (parserFailed || this.pipeline !== pipeline) return;
      pipeline.lastProgressAt = Date.now();
      try {
        parser.push(chunk);
      } catch (error) {
        handleParserError(error);
      }
    });
    child.stdout.once("end", finishParser);
    child.stdout.once("close", finishParser);
    child.stderr.on("data", (chunk) => {
      pipeline.lastProgressAt = Date.now();
      pipeline.stderr = `${pipeline.stderr}${chunk.toString("utf8")}`.slice(
        -12_000,
      );
    });
    child.once("error", (error) => {
      if (this.pipeline !== pipeline) return;
      this.sendEvent({
        type: "error",
        pipelineId,
        message: `无法启动本地媒体组件：${cleanText(error.message, 300)}`,
      });
      void this.stopStream("spawn-error");
    });
    child.once("close", (code) => {
      if (this.pipeline !== pipeline || pipeline.stopping) return;
      relayProducer?.markRenditionEnded(renditionId);
      const detail = pipeline.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join("；");
      this.sendEvent({
        type: code === 0 ? "ended" : "error",
        pipelineId,
        message:
          code === 0
            ? "媒体流已经播放完毕"
            : `媒体流处理异常退出（${code ?? "未知"}）${
                detail ? `：${cleanText(detail, 600)}` : ""
              }`,
      });
      void this.stopStream("exited");
    });
    this.sendEvent({
      type: "started",
      pipelineId,
      plan: plan.public,
      renditionId,
      auxiliary: this.auxiliary,
    });
    pipeline.progressWatchdog = setInterval(() => {
      if (
        this.pipeline !== pipeline ||
        pipeline.stopping ||
        pipeline.paused ||
        pipeline.relayPaused
      ) {
        return;
      }
      if (Date.now() - pipeline.lastProgressAt < 30_000) return;
      this.sendEvent({
        type: "error",
        pipelineId,
        renditionId,
        auxiliary: this.auxiliary,
        message: "FFmpeg/代理连续 30 秒没有媒体进度，已终止当前管线",
      });
      void this.stopStream("progress-timeout");
    }, 5_000);
    pipeline.progressWatchdog.unref?.();
    if (input.skipSubtitle !== true) void this.subtitleText(input, plan)
      .catch((error) => ({
        supported: false,
        message: cleanText(error?.message || error, 500),
      }))
      .then((subtitle) => {
        if (subtitle && this.pipeline === pipeline) {
          if (subtitle.supported && subtitle.text) {
            relayCoordinator?.publishSubtitle(subtitle);
          }
          this.sendEvent({
            type: "subtitle",
            pipelineId,
            subtitle,
          });
        }
      });
    if (
      relayCoordinator &&
      this.ownsRelayCoordinator &&
      input.singleRendition !== true
    ) {
      this.auxiliarySourceInput = { ...input };
      this.updateRenditionDemand();
    }
    return { pipelineId, plan: plan.public };
  }

  updateRenditionDemand(input = {}) {
    const coordinator = this.relayCoordinator;
    if (!coordinator || this.auxiliary) {
      return {
        updated: false,
        active: [],
        uploadBudgetBps: Number.POSITIVE_INFINITY,
      };
    }
    // Legacy renderers may still send a speed-test estimate here. It is not an
    // admission signal: the broadcaster's selected rendition is authoritative
    // and transport backpressure already bounds memory and disk queues.
    const uploadBudgetBps = coordinator.setUploadBudget(
      Number.POSITIVE_INFINITY,
    );
    const nextDemand = new Set(
      CMAF_AUXILIARY_RENDITIONS.filter(
        (rendition) => rendition.defaultActive,
      ).map((rendition) => rendition.id),
    );
    const requestedExtras = [
      ...(input.original === true ? ["original"] : []),
      ...(input.high === true ? ["1080p8"] : []),
      ...(input.low === true ? ["480p18"] : []),
    ];
    const maximumAuxiliaryRenditions =
      CMAF_MAX_TOTAL_RENDITIONS - 1;
    for (const renditionId of requestedExtras) {
      if (nextDemand.size >= maximumAuxiliaryRenditions) break;
      nextDemand.add(renditionId);
    }
    this.auxiliaryDemand = nextDemand;

    for (const rendition of CMAF_AUXILIARY_RENDITIONS) {
      const existingTimer = this.auxiliaryIdleTimers.get(rendition.id);
      if (nextDemand.has(rendition.id)) {
        if (existingTimer) clearTimeout(existingTimer);
        this.auxiliaryIdleTimers.delete(rendition.id);
        coordinator.setRenditionDemandActive(rendition.id, true);
        continue;
      }
      const retryTimer = this.auxiliaryRetryTimers.get(rendition.id);
      if (retryTimer) clearTimeout(retryTimer);
      this.auxiliaryRetryTimers.delete(rendition.id);
      this.auxiliaryRetryAttempts.delete(rendition.id);
      if (!this.auxiliaryServices.has(rendition.id) || existingTimer) {
        continue;
      }
      const timer = setTimeout(() => {
        this.auxiliaryIdleTimers.delete(rendition.id);
        const service = this.auxiliaryServices.get(rendition.id);
        if (
          this.auxiliaryDemand.has(rendition.id) ||
          !service ||
          this.relayCoordinator !== coordinator
        ) {
          return;
        }
        coordinator.setRenditionDemandActive(rendition.id, false);
        coordinator.deactivateProducer(rendition.id);
        void this.stopAuxiliaryRendition(
          rendition.id,
          service,
          "rendition-idle",
        );
      }, this.auxiliaryIdleMs);
      timer.unref?.();
      this.auxiliaryIdleTimers.set(rendition.id, timer);
    }
    if (this.auxiliarySourceInput) {
      void this.startAuxiliaryRenditions(
        this.auxiliarySourceInput,
        nextDemand,
      );
    }
    return {
      updated: true,
      active: [...nextDemand],
      uploadBudgetBps,
      pipelineId: this.pipeline?.id || "",
    };
  }

  async stopAuxiliaryRendition(renditionId, service, reason) {
    if (this.auxiliaryServices.get(renditionId) === service) {
      this.auxiliaryServices.delete(renditionId);
    }
    const existing = this.auxiliaryStopPromises.get(renditionId);
    if (existing) {
      await existing;
      return;
    }
    const stopping = service
      .stopStream(reason, { preserveGeneration: true })
      .catch(() => undefined)
      .finally(() => {
        if (this.auxiliaryStopPromises.get(renditionId) === stopping) {
          this.auxiliaryStopPromises.delete(renditionId);
        }
      });
    this.auxiliaryStopPromises.set(renditionId, stopping);
    await stopping;
  }

  scheduleAuxiliaryRetry(renditionId) {
    if (
      this.auxiliaryRetryTimers.has(renditionId) ||
      !this.auxiliaryDemand.has(renditionId) ||
      !this.auxiliarySourceInput ||
      !this.pipeline ||
      this.pipeline.stopping ||
      !this.relayCoordinator
    ) {
      return;
    }
    const attempts =
      (this.auxiliaryRetryAttempts.get(renditionId) || 0) + 1;
    this.auxiliaryRetryAttempts.set(renditionId, attempts);
    const delayMs = Math.min(
      AUXILIARY_RETRY_MAX_MS,
      500 * 2 ** Math.min(6, attempts - 1),
    );
    const timer = setTimeout(() => {
      this.auxiliaryRetryTimers.delete(renditionId);
      if (
        this.auxiliaryDemand.has(renditionId) &&
        this.auxiliarySourceInput
      ) {
        void this.startAuxiliaryRenditions(
          this.auxiliarySourceInput,
          new Set([renditionId]),
        );
      }
    }, delayMs);
    timer.unref?.();
    this.auxiliaryRetryTimers.set(renditionId, timer);
  }

  async startAuxiliaryRenditions(input, requestedRenditions) {
    const coordinator = this.relayCoordinator;
    if (!coordinator || this.auxiliary || this.pipeline?.stopping) return;
    const desired =
      requestedRenditions instanceof Set
        ? requestedRenditions
        : this.auxiliaryDemand;
    const specifications = CMAF_AUXILIARY_RENDITIONS.filter(
      (rendition) => desired.has(rendition.id),
    );
    for (const specification of specifications) {
      const pendingStop = this.auxiliaryStopPromises.get(
        specification.id,
      );
      if (pendingStop) await pendingStop;
      if (!this.pipeline || this.pipeline.stopping || this.relayCoordinator !== coordinator) {
        return;
      }
      if (!this.auxiliaryDemand.has(specification.id)) continue;
      if (this.auxiliaryServices.has(specification.id)) {
        coordinator.setRenditionDemandActive(specification.id, true);
        continue;
      }
      const service = this.auxiliaryServiceFactory({
        ...this.childServiceOptions,
        relayCoordinator: coordinator,
        auxiliary: true,
        sendEvent: (event) => {
          if (
            event.type === "stopped" &&
            this.auxiliaryServices.get(specification.id) === service
          ) {
            this.auxiliaryServices.delete(specification.id);
            coordinator.deactivateProducer(specification.id);
            if (
              this.auxiliaryDemand.has(specification.id) &&
              this.auxiliarySourceInput &&
              this.pipeline &&
              !this.pipeline.stopping &&
              this.relayCoordinator === coordinator
            ) {
              this.scheduleAuxiliaryRetry(specification.id);
            }
          }
          if (
            event.type === "init" ||
            event.type === "fragment" ||
            event.type === "started" ||
            event.type === "subtitle"
          ) {
            return;
          }
          this.sendEvent({
            ...event,
            renditionId: specification.id,
            auxiliary: true,
          });
        },
      });
      service.session = this.session;
      this.auxiliaryServices.set(specification.id, service);
      const currentPlaybackTicks = Number.isFinite(
        coordinator.playbackAnchorTimeMs,
      )
        ? Math.max(
            0,
            Math.round(coordinator.playbackAnchorTimeMs * 10_000),
          )
        : Number(input.startTimeTicks) || 0;
      void service
        .startStream({
          ...input,
          startTimeTicks: currentPlaybackTicks,
          quality: specification.quality,
          allowHevc:
            specification.id === "original" &&
            input.allowHevc === true,
          forceVideoTranscode: specification.forceVideoTranscode,
          renditionId: specification.id,
          singleRendition: true,
          skipSubtitle: true,
        })
        .then(() => {
          this.auxiliaryRetryAttempts.delete(specification.id);
        })
        .catch((error) => {
          if (this.auxiliaryServices.get(specification.id) === service) {
            this.auxiliaryServices.delete(specification.id);
          }
          coordinator.deactivateProducer(specification.id);
          this.sendEvent({
            type: "warning",
            pipelineId: this.pipeline?.id || "",
            code: "auxiliary-rendition-failed",
            message: `${specification.id} 档位启动失败：${cleanText(
              error?.message || error,
              420,
            )}`,
            renditionId: specification.id,
            auxiliary: true,
          });
          return service
            .stopStream("auxiliary-start-failed")
            .catch(() => undefined)
            .finally(() =>
              this.scheduleAuxiliaryRetry(specification.id),
            );
        });
    }
  }

  updateSegmentRelayAccess(input = {}) {
    const token = cleanText(input.token, 2_048);
    if (token.length < 64) return { updated: false };
    const updated = this.relayCoordinator?.updateToken(token) === true;
    for (const service of this.auxiliaryServices.values()) {
      service.relayCoordinator?.updateToken(token);
    }
    return {
      updated,
      pipelineId: this.pipeline?.id || "",
    };
  }

  setFlowPaused(paused, expectedPipelineId, generation = 0) {
    const pipeline = this.pipeline;
    const requestedPipelineId = cleanText(expectedPipelineId, 128);
    const requestedGeneration = Math.max(0, Number(generation) || 0);
    if (
      !pipeline ||
      (requestedPipelineId && pipeline.id !== requestedPipelineId)
    ) {
      return {
        pipelineId: pipeline?.id || requestedPipelineId || "",
        generation: requestedGeneration,
        actualPaused: Boolean(pipeline?.paused),
        applied: false,
      };
    }
    if (!pipeline.stopping && pipeline.paused !== Boolean(paused)) {
      pipeline.paused = Boolean(paused);
      if (pipeline.paused) pipeline.child.stdout.pause();
      else if (!pipeline.relayPaused) pipeline.child.stdout.resume();
    }
    return {
      pipelineId: pipeline.id,
      generation: requestedGeneration,
      actualPaused: Boolean(pipeline.paused),
      applied: !pipeline.stopping,
    };
  }

  getFlowState(expectedPipelineId) {
    const pipeline = this.pipeline;
    const expected = cleanText(expectedPipelineId, 128);
    return {
      pipelineId: pipeline?.id || expected || "",
      actualPaused: Boolean(pipeline?.paused),
      active: Boolean(
        pipeline &&
          !pipeline.stopping &&
          (!expected || pipeline.id === expected),
      ),
    };
  }

  async reportPlayback(input = {}) {
    const session = this.requireSession();
    const pipeline = this.pipeline;
    const plan = pipeline?.plan?.public;
    if (!plan) return;
    const action = ["start", "progress", "stop"].includes(input.action)
      ? input.action
      : "progress";
    const endpoint =
      action === "start"
        ? "/Sessions/Playing"
        : action === "stop"
          ? "/Sessions/Playing/Stopped"
          : "/Sessions/Playing/Progress";
    const body = {
      ItemId: plan.itemId,
      MediaSourceId: plan.mediaSourceId,
      PlaySessionId: plan.playSessionId,
      PositionTicks: Math.max(0, Number(input.positionTicks) || 0),
      IsPaused: input.isPaused === true,
      IsMuted: false,
      PlayMethod:
        plan.method === "DirectPlay"
          ? "DirectPlay"
          : plan.method === "DirectStream" || plan.method === "LocalRemux"
            ? "DirectStream"
            : "Transcode",
      EventName: cleanText(input.eventName, 64) || undefined,
      CanSeek: true,
    };
    pipeline.lastPositionTicks = body.PositionTicks;
    if (!this.auxiliary) {
      this.relayCoordinator?.updatePlaybackAnchor(body.PositionTicks);
    }
    let reported = false;
    try {
      await this.request(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
        discardBody: true,
      });
      reported = true;
    } catch {
      // Playback telemetry must never interrupt playback.
    }
    if (action === "stop" && reported) pipeline.stopReported = true;
    return { userId: session.userId };
  }

  async stopStream(reason = "stopped", options = {}) {
    const expectedPipelineId = cleanText(options.expectedPipelineId, 128);
    if (
      expectedPipelineId &&
      this.pipeline?.id !== expectedPipelineId
    ) {
      return;
    }
    if (options.preserveGeneration !== true) {
      this.streamGeneration += 1;
    }
    for (const timer of this.auxiliaryIdleTimers.values()) {
      clearTimeout(timer);
    }
    this.auxiliaryIdleTimers.clear();
    for (const timer of this.auxiliaryRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.auxiliaryRetryTimers.clear();
    this.auxiliaryRetryAttempts.clear();
    this.auxiliarySourceInput = undefined;
    const auxiliaryServices = [...this.auxiliaryServices.values()];
    this.auxiliaryServices.clear();
    const stoppingAuxiliaries = Promise.allSettled(
      [
        ...auxiliaryServices.map((service) =>
          service.stopStream(reason, { preserveGeneration: true }),
        ),
        ...this.auxiliaryStopPromises.values(),
      ],
    );
    this.auxiliaryStopPromises.clear();
    const pipeline = this.pipeline;
    if (!pipeline) {
      await stoppingAuxiliaries;
      if (this.ownsRelayCoordinator && this.relayCoordinator) {
        const coordinator = this.relayCoordinator;
        this.relayCoordinator = undefined;
        this.ownsRelayCoordinator = false;
        await coordinator.close(reason === "exited").catch(() => undefined);
      }
      return;
    }
    pipeline.stopping = true;
    clearTimeout(pipeline.initTimer);
    pipeline.initTimer = undefined;
    clearInterval(pipeline.progressWatchdog);
    pipeline.progressWatchdog = undefined;
    pipeline.relayCoordinator?.unregisterProducer(pipeline.renditionId);
    // reportPlayback captures the current pipeline synchronously before its
    // first await. Keep that request best-effort in the background so an
    // unreachable Emby server cannot leave FFmpeg alive for the 20 s HTTP
    // timeout or block the next seek/start.
    const stopReport = pipeline.stopReported
      ? Promise.resolve()
      : this.reportPlayback({
          action: "stop",
          positionTicks: pipeline.lastPositionTicks,
        }).catch(() => undefined);
    void stopReport;
    if (this.pipeline === pipeline) this.pipeline = undefined;
    pipeline.child.stdout?.removeAllListeners();
    pipeline.child.stderr?.removeAllListeners();
    // Both calls begin before either is awaited. Closing the loopback proxy
    // also interrupts a blocked FFmpeg input while its process tree is being
    // terminated.
    const terminating = terminateChildProcess(pipeline.child);
    const closingProxy = pipeline.proxy.close();
    await Promise.allSettled([
      terminating,
      closingProxy,
      stoppingAuxiliaries,
    ]);
    if (this.ownsRelayCoordinator && this.relayCoordinator) {
      const coordinator = this.relayCoordinator;
      this.relayCoordinator = undefined;
      this.ownsRelayCoordinator = false;
      await coordinator
        .close(reason === "exited" || reason === "ended")
        .catch(() => undefined);
    }
    this.sendEvent({
      type: "stopped",
      pipelineId: pipeline.id,
      reason: cleanText(reason, 64),
      renditionId: pipeline.renditionId,
      auxiliary: this.auxiliary,
    });
  }

  async destroy() {
    await this.logout();
  }
}

module.exports = {
  browserDirectVideoCompatible,
  buildDeviceProfile,
  browserDirectAudioCompatible,
  CmafRelayCoordinator,
  chooseSource,
  decodeSubtitleBuffer,
  embyApiBaseCandidates,
  embyReadAheadProfile,
  endpointIdFor,
  EmbyLoopbackProxy,
  EmbyService,
  FragmentedMp4Parser,
  detectMp4Mime,
  isHlsManifestResponse,
  normalizeEndpointUrls,
  normalizeEmbyFrameRate,
  normalizeSegmentRelayConfig,
  normalizeServerUrl,
  qualityProfile,
  renditionIdForQuality,
  rewriteManifest,
  terminateChildProcess,
};
