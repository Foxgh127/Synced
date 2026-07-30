const { EventEmitter } = require("events");
const http = require("http");
const { Readable } = require("stream");
const { createHash, randomBytes, randomUUID } = require("crypto");
const { spawn } = require("child_process");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");

const EMBY_CLIENT = "Synced";
const EMBY_DEVICE = "Synced Desktop";
const REQUEST_TIMEOUT_MS = 20_000;
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
  const imageTag =
    item?.ImageTags?.Primary ||
    item?.SeriesPrimaryImageTag ||
    item?.ParentPrimaryImageTag;
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
    imageTag: imageTag ? cleanText(imageTag, 128) : undefined,
    imageItemId:
      cleanText(
        item?.PrimaryImageItemId ||
          (item?.SeriesPrimaryImageTag ? item?.SeriesId : "") ||
          item?.Id,
        128,
      ) || undefined,
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
    try {
      const timeout = requestTimeout();
      let upstreamResponse;
      let finalUrl = upstream;
      try {
        const fetched = await fetchWithScopedRedirects(upstream, {
          method: request.method,
          allowCrossOrigin: true,
          headersForUrl: (target) => {
            const headers = {
              Accept: request.headers.accept || "*/*",
              "User-Agent": `${EMBY_CLIENT}/${this.session.version}`,
            };
            if (request.headers.range) headers.Range = request.headers.range;
            if (target.origin === this.session.serverUrl.origin) {
              headers["X-Emby-Authorization"] = authHeader(
                this.session.deviceId,
                this.session.version,
              );
              headers["X-Emby-Token"] = this.session.token;
            }
            return headers;
          },
          signal: timeout.signal,
          validateUrl: (target, context) =>
            this.validateMediaTarget(target, context),
        });
        upstreamResponse = fetched.response;
        finalUrl = fetched.finalUrl;
      } finally {
        timeout.clear();
      }
      if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
        response.writeHead(upstreamResponse.status).end();
        return;
      }
      const contentType = upstreamResponse.headers.get("content-type") || "";
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
        const manifest = (
          await readResponseLimited(
            upstreamResponse,
            8 * 1024 * 1024,
            "Emby HLS 清单异常过大",
          )
        ).toString("utf8");
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
      response.writeHead(upstreamResponse.status, passHeaders);
      if (request.method === "HEAD" || !upstreamResponse.body) {
        response.end();
        return;
      }
      const readable = Readable.fromWeb(upstreamResponse.body);
      readable.on("error", () => {
        if (!response.destroyed) response.destroy();
      });
      response.on("close", () => {
        if (!readable.destroyed) readable.destroy();
      });
      readable.pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  }

  async close() {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
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
  if (!state.recentCadenceMs.length) return 750;
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

class FragmentedMp4Parser extends EventEmitter {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
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
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : Buffer.from(chunk);
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
    let offset = 0;
    while (offset < this.buffer.length) {
      const box = readBox(
        this.buffer,
        offset,
        sizeZeroExtendsToEnd,
      );
      if (!box) break;
      const payload = this.buffer.subarray(offset, offset + box.size);
      this.consume(box.type, Buffer.from(payload));
      offset += box.size;
    }
    if (offset) this.buffer = this.buffer.subarray(offset);
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

class EmbyService {
  constructor(options = {}) {
    this.version = cleanText(options.version || "2.8.1", 32);
    this.deviceId = cleanText(options.deviceId || randomUUID(), 128);
    this.ffmpegPath = resolveFfmpegPath(options);
    this.spawnProcess =
      typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
    this.sendEvent =
      typeof options.sendEvent === "function" ? options.sendEvent : () => {};
    this.streamInitTimeoutMs = Math.max(
      500,
      Math.min(
        60_000,
        Number(options.streamInitTimeoutMs) || STREAM_INIT_TIMEOUT_MS,
      ),
    );
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
          .filter((value) => ["IsResumable", "IsUnplayed", "IsPlayed"].includes(value))
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
    const proxy = new EmbyLoopbackProxy(this.requireSession());
    await proxy.start();
    if (generation !== this.streamGeneration) {
      await proxy.close().catch(() => undefined);
      throw new Error("Emby 启动请求已被停止或替代");
    }
    const pipelineId = randomUUID();
    const parser = new FragmentedMp4Parser();
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
      "-readrate",
      String(readAhead.readRate),
      "-readrate_initial_burst",
      String(readAhead.initialBurstSeconds),
      "-readrate_catchup",
      String(readAhead.catchupRate),
    ];
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
        "-c:v",
        "libopenh264",
        "-profile:v",
        "high",
        "-rc_mode",
        "bitrate",
        "-b:v",
        String(encoding.videoBitrate),
        "-maxrate",
        String(encoding.videoBitrate),
        "-bufsize",
        String(Math.min(36_000_000, encoding.videoBitrate * 2)),
        "-force_key_frames",
        "expr:gte(t,n_forced*2)",
        "-tag:v",
        "avc1",
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
      "+empty_moov+default_base_moof",
      "-frag_duration",
      "750000",
      "-min_frag_duration",
      "350000",
      // A duration boundary alone can still produce multi-megabyte 4K
      // fragments around large keyframes. Bound each IPC/MSE unit as well so
      // the renderer stays responsive during the startup burst.
      "-frag_size",
      "1500000",
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
    };
    this.pipeline = pipeline;
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
      });
    });
    parser.on(
      "fragment",
      ({ sequence, mediaTimeMs, keyframe, timelineRepairs, data }) => {
      if (this.pipeline !== pipeline) return;
      this.sendEvent({
        type: "fragment",
        pipelineId,
        sequence,
        timestampMs: Date.now(),
        mediaTimeMs: Number.isFinite(mediaTimeMs)
          ? mediaTimeMs
          : plan.public.startTimeTicks / 10_000 + (sequence - 1) * 1_500,
        keyframe: keyframe !== false,
        timelineRepairs,
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
      try {
        parser.push(chunk);
      } catch (error) {
        handleParserError(error);
      }
    });
    child.stdout.once("end", finishParser);
    child.stdout.once("close", finishParser);
    child.stderr.on("data", (chunk) => {
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
    });
    void this.subtitleText(input, plan)
      .catch((error) => ({
        supported: false,
        message: cleanText(error?.message || error, 500),
      }))
      .then((subtitle) => {
        if (subtitle && this.pipeline === pipeline) {
          this.sendEvent({
            type: "subtitle",
            pipelineId,
            subtitle,
          });
        }
      });
    return { pipelineId, plan: plan.public };
  }

  setFlowPaused(paused, expectedPipelineId) {
    const pipeline = this.pipeline;
    if (
      !pipeline ||
      (expectedPipelineId && pipeline.id !== expectedPipelineId) ||
      pipeline.stopping ||
      pipeline.paused === Boolean(paused)
    ) {
      return;
    }
    pipeline.paused = Boolean(paused);
    if (pipeline.paused) pipeline.child.stdout.pause();
    else pipeline.child.stdout.resume();
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
    const pipeline = this.pipeline;
    if (!pipeline) return;
    pipeline.stopping = true;
    clearTimeout(pipeline.initTimer);
    pipeline.initTimer = undefined;
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
    await Promise.allSettled([terminating, closingProxy]);
    this.sendEvent({
      type: "stopped",
      pipelineId: pipeline.id,
      reason: cleanText(reason, 64),
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
  normalizeServerUrl,
  qualityProfile,
  rewriteManifest,
  terminateChildProcess,
};
