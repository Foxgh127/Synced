import {
  EmbyFragmentAssembler,
  type EmbyAssemblyAbandonment,
  type EmbyControlMessage,
  type EmbyTransportFragment,
} from "./emby-transport";

export interface EmbyPlayerSession {
  roomId: string;
  sessionId: string;
  mediaVersion: number;
  transportEpoch?: number;
  mimeType: string;
  plan: EmbyStreamPlan;
  title: string;
}

export interface EmbyMsePlayerOptions {
  video: HTMLVideoElement;
  host?: boolean;
  initialBufferSeconds?: number;
  targetBufferSeconds?: number;
  maxBufferSeconds?: number;
  deviceMemoryGb?: number;
  recoveryStrategy?: "peer-resync" | "transport-fallback";
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const MEBIBYTE = 1024 * 1024;
const BUFFER_TIME_EPSILON_SECONDS = 0.075;
const EMBY_REORDER_WAIT_MS = 1_200;
const EMBY_MAX_REORDER_FRAGMENTS = 64;
const EMBY_MAX_REORDER_BYTES = 32 * 1024 * 1024;
const EMBY_TRANSPORT_SILENCE_TIMEOUT_MS = 15_000;
// Keep a generous margin below the three-second product ceiling. Once the
// desired timestamp is 1.8 s ahead of available media, pause stale playback
// and request a fresh keyframe window instead of letting drift keep growing.
export const EMBY_MAX_SYNC_DRIFT_SECONDS = 1.8;

export interface EmbyAdaptiveBufferProfile {
  initialSeconds: number;
  targetSeconds: number;
  maxSeconds: number;
  memoryBudgetBytes: number;
}

export function planEmbyAdaptiveBufferProfile(
  input: {
    bitrate?: number;
    host?: boolean;
    deviceMemoryGb?: number;
    initialSeconds?: number;
    targetSeconds?: number;
    maxSeconds?: number;
  } = {},
): EmbyAdaptiveBufferProfile {
  const host = input.host === true;
  const deviceMemoryGb = finite(input.deviceMemoryGb, -1);
  let memoryBudgetMiB: number;
  if (deviceMemoryGb > 0 && deviceMemoryGb <= 2) {
    memoryBudgetMiB = host ? 128 : 96;
  } else if (deviceMemoryGb > 0 && deviceMemoryGb <= 4) {
    memoryBudgetMiB = host ? 224 : 160;
  } else if (deviceMemoryGb > 0 && deviceMemoryGb <= 8) {
    memoryBudgetMiB = host ? 320 : 224;
  } else if (deviceMemoryGb > 8) {
    memoryBudgetMiB = host ? 384 : 288;
  } else {
    // Chromium does not expose deviceMemory on every Android WebView. Keep
    // that unknown-device fallback below the desktop host budget so a 4K
    // original cannot silently create two unbounded, hundreds-of-MiB queues.
    memoryBudgetMiB = host ? 320 : 192;
  }
  const memoryBudgetBytes = memoryBudgetMiB * MEBIBYTE;
  const bitrate = Math.max(
    500_000,
    Math.min(100_000_000, finite(input.bitrate, 8_000_000)),
  );
  // SourceBuffer bookkeeping, MP4 box overhead and a fragment currently being
  // appended all live outside the raw media byte count. Reserve 18% instead
  // of sizing the timeline right up to the process memory budget.
  const capacitySeconds = Math.floor(
    (memoryBudgetBytes * 8 * 0.82) / bitrate,
  );
  const requestedInitial = Math.max(
    4,
    finite(input.initialSeconds, host ? 10 : 10),
  );
  const hardMax = Math.max(
    6,
    finite(input.maxSeconds, host ? 90 : 72),
  );
  const maxSeconds = Math.min(
    hardMax,
    Math.max(6, capacitySeconds),
  );
  const initialSeconds = Math.max(
    4,
    Math.min(requestedInitial, maxSeconds - 2),
  );
  const requestedTarget = Math.max(
    initialSeconds + 1,
    finite(input.targetSeconds, host ? 64 : 52),
  );
  const targetSeconds = Math.max(
    initialSeconds + 1,
    Math.min(requestedTarget, maxSeconds - 1),
  );
  return {
    initialSeconds,
    targetSeconds,
    maxSeconds,
    memoryBudgetBytes,
  };
}

export function shouldHardResyncEmbyPlayback(
  errorSeconds: number,
  targetBuffered: boolean,
): boolean {
  return (
    finite(errorSeconds) > EMBY_MAX_SYNC_DRIFT_SECONDS &&
    !targetBuffered
  );
}

export function planEmbyPlaybackCorrection(
  errorSeconds: number,
  paused: boolean,
  playbackRate: number,
): {
  action: "seek" | "rate" | "none";
  playbackRate: number;
  restoreAfterMs?: number;
} {
  const error = finite(errorSeconds);
  const baseRate = Math.max(0.1, finite(playbackRate, 1));
  // A playing host publishes state every 500 ms. Seeking for an ordinary
  // half-second scheduling difference makes Android MediaCodec flush on every
  // state packet and can permanently prevent the first frame from rendering.
  // Keep paused frames exact, but let bounded rate correction absorb normal
  // live playback drift and reserve decoder-flushing seeks for a real gap.
  if (
    Math.abs(error) >
    (paused ? 0.35 : EMBY_MAX_SYNC_DRIFT_SECONDS)
  ) {
    return { action: "seek", playbackRate: baseRate };
  }
  if (Math.abs(error) >= 0.1 && !paused) {
    return {
      action: "rate",
      playbackRate: baseRate * (error > 0 ? 1.04 : 0.96),
      restoreAfterMs: Math.min(
        8_000,
        Math.max(1_500, Math.abs(error) * 10_000),
      ),
    };
  }
  return { action: "none", playbackRate: baseRate };
}

export function evaluateEmbyBufferPolicy(
  aheadSeconds: number,
  behindSeconds: number,
  options: {
    initialSeconds?: number;
    targetSeconds?: number;
    maxSeconds?: number;
  } = {},
): {
  canStart: boolean;
  shouldTrim: boolean;
  pausedForFlow: boolean;
  urgent: boolean;
} {
  const ahead = Math.max(0, finite(aheadSeconds));
  const behind = Math.max(0, finite(behindSeconds));
  const initial = Math.max(1, finite(options.initialSeconds, 8));
  const target = Math.max(initial, finite(options.targetSeconds, 24));
  const maximum = Math.max(target, finite(options.maxSeconds, 32));
  return {
    canStart: ahead + BUFFER_TIME_EPSILON_SECONDS >= initial,
    shouldTrim: ahead > maximum || behind > target + 6,
    pausedForFlow: ahead >= maximum,
    urgent: ahead < 8,
  };
}

export function shouldReportEmbyBuffer(
  lastReportAt: number,
  now: number,
): boolean {
  return finite(now) - finite(lastReportAt) >= 500;
}

function formatVttTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const milliseconds = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(
    3,
    "0",
  )}`;
}

function fmtTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const remainingSeconds = Math.floor(safe % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(
        remainingSeconds,
      ).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function assTime(value: string): number {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/);
  if (!match) return 0;
  const fraction = Number(`0.${match[4] || "0"}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + fraction;
}

function subtitleTime(value: string): number {
  const text = value.trim();
  const milliseconds = text.match(/^([\d.]+)ms$/i);
  if (milliseconds) return Number(milliseconds[1]) / 1_000;
  const seconds = text.match(/^([\d.]+)s$/i);
  if (seconds) return Number(seconds[1]);
  return assTime(text);
}

function decodeSubtitleEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) =>
      String.fromCodePoint(Math.min(0x10ffff, Number(code) || 0)),
    )
    .replace(/&amp;/gi, "&");
}

function escapeCueText(value: string): string {
  return decodeSubtitleEntities(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeCueText(value: string): string {
  return escapeCueText(value.replace(/<[^>]*>/g, ""));
}

interface AssCueRendering {
  text: string;
  settings: string;
}

function stableAssClass(prefix: string, value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function renderAssCue(
  value: string,
  styles: Map<string, string>,
): AssCueRendering {
  const state: {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    classes: Map<string, string>;
    alignment?: number;
  } = {
    bold: false,
    italic: false,
    underline: false,
    classes: new Map(),
  };
  const openMarkup = (): string => {
    const classes = [...state.classes.values()];
    return [
      state.bold ? "<b>" : "",
      state.italic ? "<i>" : "",
      state.underline ? "<u>" : "",
      classes.length ? `<c.${classes.join(".")}>` : "",
    ].join("");
  };
  const closeMarkup = (): string =>
    [
      state.classes.size ? "</c>" : "",
      state.underline ? "</u>" : "",
      state.italic ? "</i>" : "",
      state.bold ? "</b>" : "",
    ].join("");
  const resetStyle = (): void => {
    state.bold = false;
    state.italic = false;
    state.underline = false;
    state.classes.clear();
    state.alignment = undefined;
  };
  let rendered = "";
  let markupOpen = false;
  for (const part of value.split(/(\{[^}]*\})/g)) {
    const override = part.match(/^\{([\s\S]*)\}$/);
    if (!override) {
      if (!markupOpen) {
        rendered += openMarkup();
        markupOpen = true;
      }
      rendered += escapeCueText(
        part.replace(/\\[Nn]/g, "\n").replace(/\\h/g, " "),
      );
      continue;
    }
    if (markupOpen) rendered += closeMarkup();
    markupOpen = false;
    const tags =
      /\\(1c|c|fs|fn|an|b(?=[+-]?\d)|i(?=[+-]?\d)|u(?=[+-]?\d)|r)([^\\}]*)/gi;
    for (const match of override[1].matchAll(tags)) {
      const tag = match[1].toLowerCase();
      const raw = match[2].trim();
      if (tag === "r") {
        resetStyle();
        continue;
      }
      if (tag === "b" || tag === "i" || tag === "u") {
        const enabled = Number.parseInt(raw, 10) !== 0;
        if (tag === "b") state.bold = enabled;
        if (tag === "i") state.italic = enabled;
        if (tag === "u") state.underline = enabled;
        continue;
      }
      if (tag === "an") {
        const alignment = Number.parseInt(raw, 10);
        if (alignment >= 1 && alignment <= 9) {
          state.alignment = alignment;
        }
        continue;
      }
      if (tag === "c" || tag === "1c") {
        state.classes.delete("color");
        const color = raw.match(/&H(?:[0-9a-f]{2})?([0-9a-f]{6})&?/i)?.[1];
        if (color) {
          const blue = color.slice(0, 2);
          const green = color.slice(2, 4);
          const red = color.slice(4, 6);
          const cssColor = `#${red}${green}${blue}`.toLowerCase();
          const className = `ass-color-${cssColor.slice(1)}`;
          styles.set(className, `color: ${cssColor};`);
          state.classes.set("color", className);
        }
        continue;
      }
      if (tag === "fs") {
        state.classes.delete("size");
        if (/^\d+(?:\.\d+)?$/.test(raw)) {
          const size = Math.round(
            Math.max(8, Math.min(72, Number.parseFloat(raw))),
          );
          const className = `ass-size-${size}`;
          styles.set(className, `font-size: ${size}px;`);
          state.classes.set("size", className);
        }
        continue;
      }
      if (tag === "fn") {
        state.classes.delete("font");
        const family = raw.replace(/\s+/g, " ").trim();
        if (
          family &&
          family.length <= 80 &&
          /^[\p{L}\p{N} _.-]+$/u.test(family)
        ) {
          const className = stableAssClass("ass-font", family);
          styles.set(
            className,
            `font-family: "${family.replaceAll('"', '\\"')}";`,
          );
          state.classes.set("font", className);
        }
      }
    }
  }
  if (markupOpen) rendered += closeMarkup();
  const horizontal = state.alignment
    ? ((state.alignment - 1) % 3)
    : 1;
  const vertical = state.alignment
    ? Math.floor((state.alignment - 1) / 3)
    : 0;
  const settings = state.alignment
    ? [
        `line:${vertical === 2 ? 10 : vertical === 1 ? 50 : 90}%`,
        `position:${horizontal === 0 ? 10 : horizontal === 1 ? 50 : 90}%`,
        `align:${horizontal === 0 ? "start" : horizontal === 1 ? "center" : "end"}`,
      ].join(" ")
    : "";
  return { text: rendered.trim(), settings };
}

function sanitizeWebVtt(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  let inCue = false;
  let ignoredBlock = false;
  return lines
    .map((line) => {
      if (/^(?:STYLE|REGION)(?:\s|$)/i.test(line)) {
        ignoredBlock = true;
        inCue = false;
        return "";
      }
      if (!line.trim()) {
        ignoredBlock = false;
        inCue = false;
        return "";
      }
      if (ignoredBlock) return "";
      if (line.includes("-->")) {
        inCue = true;
        return line;
      }
      return inCue ? safeCueText(line) : line;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function normalizeWebVtt(input: string): string {
  const text = String(input || "").replace(/^\uFEFF/, "").trim();
  if (!text) return "WEBVTT\n\n";
  if (/^WEBVTT(?:\s|$)/i.test(text)) return `${sanitizeWebVtt(text)}\n`;
  if (/<(?:\w+:)?tt(?:\s|>)/i.test(text)) {
    const cues: string[] = ["WEBVTT", ""];
    const paragraph =
      /<(?:\w+:)?p\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?p>/gi;
    for (const match of text.matchAll(paragraph)) {
      const begin = /\bbegin\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
      const end = /\bend\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
      const duration = /\bdur\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
      if (!begin || (!end && !duration)) continue;
      const startTime = subtitleTime(begin);
      const endTime = end
        ? subtitleTime(end)
        : startTime + subtitleTime(duration || "");
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
        continue;
      }
      const body = safeCueText(
        match[2].replace(/<(?:\w+:)?br\s*\/?>/gi, "\n"),
      ).trim();
      if (!body) continue;
      cues.push(
        `${formatVttTime(startTime)} --> ${formatVttTime(endTime)}`,
        body,
        "",
      );
    }
    return `${cues.join("\n")}\n`;
  }
  if (/^\s*\[(?:Script Info|Events)\]/im.test(text)) {
    const cues: string[] = [];
    const styles = new Map<string, string>();
    let dialogueFormat = [
      "layer",
      "start",
      "end",
      "style",
      "name",
      "marginl",
      "marginr",
      "marginv",
      "effect",
      "text",
    ];
    for (const line of text.split(/\r?\n/)) {
      const format = line.match(/^Format:\s*(.+)$/i);
      if (format) {
        dialogueFormat = format[1]
          .split(",")
          .map((part) => part.trim().toLowerCase());
        continue;
      }
      const dialogue = line.match(/^Dialogue:\s*(.+)$/i);
      if (!dialogue) continue;
      const values = dialogue[1].split(",");
      if (values.length > dialogueFormat.length) {
        values.splice(
          dialogueFormat.length - 1,
          values.length - dialogueFormat.length + 1,
          values.slice(dialogueFormat.length - 1).join(","),
        );
      }
      const fields = Object.fromEntries(
        dialogueFormat.map((name, index) => [name, values[index] || ""]),
      );
      const start = assTime(fields.start);
      const end = assTime(fields.end);
      if (end <= start) continue;
      const rendered = renderAssCue(fields.text, styles);
      if (!rendered.text) continue;
      cues.push(
        `${formatVttTime(start)} --> ${formatVttTime(end)}${
          rendered.settings ? ` ${rendered.settings}` : ""
        }`,
        rendered.text,
        "",
      );
    }
    const header = ["WEBVTT", ""];
    if (styles.size) {
      header.push(
        "STYLE",
        ...[...styles].map(
          ([className, declaration]) =>
            `::cue(.${className}) { ${declaration} }`,
        ),
        "",
      );
    }
    return `${[...header, ...cues].join("\n")}\n`;
  }
  const converted = text
    .replace(
      /(\d{1,2}:\d{2}:\d{2}),(\d{3})\s+-->\s+(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
      "$1.$2 --> $3.$4",
    )
    .replace(
      /(^|\n)\s*\d+\s*\n(?=\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->)/g,
      "$1",
    );
  return `${sanitizeWebVtt(`WEBVTT\n\n${converted}`)}\n`;
}

function compatibleMimeType(requested: string): string | undefined {
  // The codec string is derived from the actual fMP4 init segment. Claiming a
  // different, broadly supported AVC profile here does not make High10/4:2:2
  // samples decodable; Chromium accepts the SourceBuffer and then reports an
  // asynchronous append error, which used to leave the queue permanently
  // blocked. Only accept the exact stream we are about to append.
  return MediaSource.isTypeSupported(requested) ? requested : undefined;
}

export interface EmbyMseDiagnostics {
  configured: boolean;
  mimeType: string;
  mediaSourceState: "closed" | "open" | "ended" | "missing";
  sourceBufferAttached: boolean;
  sourceBufferUpdating: boolean;
  appendBusy: boolean;
  appendQueueItems: number;
  appendQueueBytes: number;
  pendingMediaItems: number;
  pendingMediaBytes: number;
  readyState: number;
  networkState: number;
  mediaErrorCode: number;
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  bufferedRanges: number;
  bufferedWindows: Array<{ start: number; end: number }>;
  bufferedAhead: number;
  sourceBufferTimestampOffset: number;
  lastMediaTimeMs: number;
  lastTimelineTimeMs: number;
  paused: boolean;
  seeking: boolean;
  started: boolean;
}

export class EmbyMsePlayer extends EventTarget {
  private readonly video: HTMLVideoElement;
  private readonly originalAutoplay: boolean;
  private readonly host: boolean;
  private initialBufferSeconds: number;
  private targetBufferSeconds: number;
  private maxBufferSeconds: number;
  private readonly requestedBufferProfile: {
    initialSeconds?: number;
    targetSeconds?: number;
    maxSeconds?: number;
    deviceMemoryGb?: number;
  };
  private session?: EmbyPlayerSession;
  private channel?: RTCDataChannel;
  private controlChannel?: RTCDataChannel;
  private assembler?: EmbyFragmentAssembler;
  private mediaSource?: MediaSource;
  private sourceBuffer?: SourceBuffer;
  private objectUrl?: string;
  private subtitleUrl?: string;
  private appendQueue: Uint8Array[] = [];
  private appendTimestampOffsets: Array<number | undefined> = [];
  private appendBusy = false;
  private pendingQuotaRecovery = false;
  private quotaRecoveryTimer?: number;
  private quotaRecoveryAttempts = 0;
  private started = false;
  private mediaReadySent = false;
  private lastStateVersion = 0;
  private clockOffsetMs = 0;
  private clockSamples = 0;
  private speedRestoreTimer?: number;
  private progressTimer?: number;
  private bufferTimer?: number;
  private syncTimer?: number;
  private syncRampTimer?: number;
  private initRequestTimer?: number;
  private mediaSourceOpenTimer?: number;
  private appendWatchdogTimer?: number;
  private mediaSourceGeneration = 0;
  private receivedInitKey = "";
  private pendingMediaFragments = new Map<number, EmbyTransportFragment>();
  private pendingMediaBytes = 0;
  private nextMediaSequence?: number;
  private lastDeliveredMediaSequence?: number;
  private lastMediaTimeMs = 0;
  private lastTimelineTimeMs = 0;
  private readonly missingFragmentRepairAttempts = new Map<number, number>();
  private mediaReorderTimer?: number;
  private invalidPacketCount = 0;
  private lastBufferReportAt = 0;
  private lastCatchUpRequestAt = 0;
  private lastTransportFallbackRequestAt = 0;
  private lastInboundActivityAt = 0;
  private transportFallbackRequested = false;
  private lastHardSeekAt = 0;
  private lastStartupAnchorAt = 0;
  private latestHostTarget = 0;
  private hostWantsPaused = true;
  private pendingCatchUpTarget?: number;
  private syncHeld = false;
  private awaitingResyncEpoch?: number;
  private awaitingMediaVersion?: number;
  private streamTransitionTimer?: number;
  private endRequested = false;
  private streamComplete = false;
  private endBoundary?: {
    transportEpoch: number;
    finalFragmentSeq: number;
  };
  private endBoundaryTimedOut = false;
  private endRepairTimer?: number;
  private endBoundaryTimer?: number;
  private destroyed = false;
  private readonly recoveryStrategy:
    | "peer-resync"
    | "transport-fallback";
  private readonly handleVideoTimeUpdate = () => this.inspectBuffer();
  private readonly handleVideoWaiting = () => this.inspectBuffer(true);
  private readonly handleVideoError = () => {
    this.emitError(
      this.video.error?.message || "本地播放器无法解码收到的媒体片段",
    );
  };

  constructor(options: EmbyMsePlayerOptions) {
    super();
    this.video = options.video;
    this.originalAutoplay = this.video.autoplay;
    // MSE playback must cross the explicit host/viewer buffer barrier. Native
    // autoplay can otherwise begin on the first fragment and outrun pause/
    // synchronization state while the remaining cache is still arriving.
    this.video.autoplay = false;
    this.host = options.host === true;
    this.recoveryStrategy =
      options.recoveryStrategy === "transport-fallback"
        ? "transport-fallback"
        : "peer-resync";
    this.requestedBufferProfile = {
      initialSeconds: options.initialBufferSeconds,
      targetSeconds: options.targetBufferSeconds,
      maxSeconds: options.maxBufferSeconds,
      deviceMemoryGb:
        options.deviceMemoryGb ??
        (typeof navigator === "undefined"
          ? undefined
          : Number(
              (navigator as Navigator & { deviceMemory?: number })
                .deviceMemory,
            )),
    };
    const initialProfile = planEmbyAdaptiveBufferProfile({
      host: this.host,
      ...this.requestedBufferProfile,
    });
    this.initialBufferSeconds = initialProfile.initialSeconds;
    this.targetBufferSeconds = initialProfile.targetSeconds;
    this.maxBufferSeconds = initialProfile.maxSeconds;
    this.video.addEventListener("timeupdate", this.handleVideoTimeUpdate);
    this.video.addEventListener("waiting", this.handleVideoWaiting);
    this.video.addEventListener("error", this.handleVideoError);
  }

  get activeSession(): EmbyPlayerSession | undefined {
    return this.session;
  }

  get currentTime(): number {
    return finite(this.video.currentTime);
  }

  get bufferedAhead(): number {
    const current = finite(this.video.currentTime);
    for (let index = 0; index < this.video.buffered.length; index += 1) {
      if (
        current >= this.video.buffered.start(index) - 0.08 &&
        current <= this.video.buffered.end(index) + 0.08
      ) {
        return Math.max(0, this.video.buffered.end(index) - current);
      }
    }
    if (this.video.buffered.length && current < this.video.buffered.start(0)) {
      return Math.max(0, this.video.buffered.end(0) - this.video.buffered.start(0));
    }
    return 0;
  }

  requestRecovery(): boolean {
    const session = this.session;
    if (!session || this.destroyed) return false;
    const targetTime = Math.max(
      0,
      finite(this.video.currentTime),
      finite(this.latestHostTarget),
    );
    this.requestCatchUp(targetTime, "playback-stall");
    this.inspectBuffer(true);
    if (
      this.started &&
      !this.hostWantsPaused &&
      this.bufferedAhead > 0.25
    ) {
      void this.video.play().catch(() => undefined);
    }
    return true;
  }

  private requestCatchUp(targetTime: number, reason: string): void {
    const session = this.session;
    if (!session || this.destroyed) return;
    const now = Date.now();
    this.lastCatchUpRequestAt = now;
    if (this.recoveryStrategy === "transport-fallback") {
      if (
        this.transportFallbackRequested ||
        now - this.lastTransportFallbackRequestAt < 1_200
      ) {
        return;
      }
      this.lastTransportFallbackRequestAt = now;
      this.transportFallbackRequested = true;
      this.dispatchEvent(
        new CustomEvent("recoveryneeded", {
          detail: {
            reason,
            targetTime: Math.max(0, finite(targetTime)),
            sessionId: session.sessionId,
            mediaVersion: session.mediaVersion,
            transportEpoch: session.transportEpoch ?? 0,
          },
        }),
      );
      return;
    }
    this.sendControl({
      type: "catch-up",
      sessionId: session.sessionId,
      mediaVersion: session.mediaVersion,
      transportEpoch: session.transportEpoch ?? 0,
      targetTime: Math.max(0, finite(targetTime)),
    });
    this.sendClockPing();
  }

  private handleAssemblyAbandonment(
    detail: EmbyAssemblyAbandonment,
  ): void {
    const session = this.session;
    if (
      !session ||
      detail.trackType !== "muxed" ||
      detail.mediaVersion !== session.mediaVersion ||
      detail.transportEpoch !== (session.transportEpoch ?? 0)
    ) {
      return;
    }
    if (Date.now() - this.lastCatchUpRequestAt < 1_200) return;
    this.requestCatchUp(
      Math.max(
        0,
        finite(this.video.currentTime),
        finite(this.latestHostTarget),
      ),
      `fragment-${detail.reason}`,
    );
  }

  get queuedAppendBytes(): number {
    return this.appendQueue.reduce((total, data) => total + data.byteLength, 0);
  }

  get bufferProfile(): EmbyAdaptiveBufferProfile {
    return planEmbyAdaptiveBufferProfile({
      bitrate: this.session?.plan.bitrate,
      host: this.host,
      ...this.requestedBufferProfile,
    });
  }

  get diagnostics(): EmbyMseDiagnostics {
    const bufferedWindows = Array.from(
      { length: finite(this.video.buffered?.length) },
      (_value, index) => ({
        start: finite(this.video.buffered.start(index)),
        end: finite(this.video.buffered.end(index)),
      }),
    );
    return {
      configured: Boolean(this.session && this.mediaSource),
      mimeType: this.session?.mimeType || "",
      mediaSourceState: this.mediaSource?.readyState || "missing",
      sourceBufferAttached: Boolean(this.sourceBuffer),
      sourceBufferUpdating: this.sourceBuffer?.updating === true,
      appendBusy: this.appendBusy,
      appendQueueItems: this.appendQueue.length,
      appendQueueBytes: this.queuedAppendBytes,
      pendingMediaItems: this.pendingMediaFragments.size,
      pendingMediaBytes: this.pendingMediaBytes,
      readyState: finite(this.video.readyState),
      networkState: finite(this.video.networkState),
      mediaErrorCode: finite(this.video.error?.code),
      videoWidth: finite(this.video.videoWidth),
      videoHeight: finite(this.video.videoHeight),
      currentTime: finite(this.video.currentTime),
      bufferedRanges: bufferedWindows.length,
      bufferedWindows,
      bufferedAhead: this.bufferedAhead,
      sourceBufferTimestampOffset: finite(
        this.sourceBuffer?.timestampOffset,
      ),
      lastMediaTimeMs: this.lastMediaTimeMs,
      lastTimelineTimeMs: this.lastTimelineTimeMs,
      paused: Boolean(this.video.paused),
      seeking: Boolean(this.video.seeking),
      started: this.started,
    };
  }

  configure(session: EmbyPlayerSession): void {
    if (this.destroyed) return;
    const normalizedSession: EmbyPlayerSession = {
      ...session,
      transportEpoch:
        Number.isSafeInteger(session.transportEpoch) &&
        Number(session.transportEpoch) >= 0
          ? Number(session.transportEpoch)
          : 0,
    };
    const bufferProfile = planEmbyAdaptiveBufferProfile({
      bitrate: normalizedSession.plan.bitrate,
      host: this.host,
      ...this.requestedBufferProfile,
    });
    this.initialBufferSeconds = bufferProfile.initialSeconds;
    this.targetBufferSeconds = bufferProfile.targetSeconds;
    this.maxBufferSeconds = bufferProfile.maxSeconds;
    const transportChanged =
      Boolean(this.session) &&
      this.session!.sessionId === normalizedSession.sessionId &&
      this.session!.mediaVersion === normalizedSession.mediaVersion &&
      (this.session!.transportEpoch ?? 0) !==
        normalizedSession.transportEpoch;
    const changed =
      !this.session ||
      this.session.sessionId !== normalizedSession.sessionId ||
      this.session.mediaVersion !== normalizedSession.mediaVersion ||
      this.session.mimeType !== normalizedSession.mimeType ||
      this.session.plan.itemId !== normalizedSession.plan.itemId ||
      this.session.plan.playSessionId !==
        normalizedSession.plan.playSessionId ||
      this.session.plan.startTimeTicks !==
        normalizedSession.plan.startTimeTicks;
    this.session = normalizedSession;
    this.lastStateVersion = 0;
    this.lastCatchUpRequestAt = 0;
    this.lastInboundActivityAt = Date.now();
    this.transportFallbackRequested = false;
    this.lastHardSeekAt = 0;
    this.lastStartupAnchorAt = 0;
    this.latestHostTarget = Math.max(
      0,
      finite(normalizedSession.plan.startTimeTicks) / 10_000_000,
    );
    this.hostWantsPaused = true;
    this.pendingCatchUpTarget = undefined;
    this.syncHeld = false;
    this.awaitingResyncEpoch = undefined;
    this.awaitingMediaVersion = undefined;
    this.clearStreamTransitionTimer();
    if (transportChanged) {
      this.resetPendingMediaReception(true);
      this.receivedInitKey = "";
    }
    if (!changed) return;
    this.receivedInitKey = "";
    this.resetMediaSource();
    const mimeType = compatibleMimeType(normalizedSession.mimeType);
    if (!mimeType) {
      this.emitError(
        `此设备不能直接解码该媒体格式：${normalizedSession.mimeType}。请让放映端选择兼容 H.264 模式。`,
      );
      return;
    }
    this.video.srcObject = null;
    this.video.controls = this.host;
    if (!this.host) this.startViewerProgress();
    this.video.hidden = false;
    this.mediaSource = new MediaSource();
    const mediaSource = this.mediaSource;
    const mediaSourceGeneration = this.mediaSourceGeneration;
    this.objectUrl = URL.createObjectURL(mediaSource);
    this.video.src = this.objectUrl;
    this.mediaSourceOpenTimer = window.setTimeout(() => {
      this.mediaSourceOpenTimer = undefined;
      if (
        this.destroyed ||
        this.mediaSourceGeneration !== mediaSourceGeneration ||
        this.mediaSource !== mediaSource ||
        mediaSource.readyState === "open"
      ) {
        return;
      }
      this.emitError("本地媒体缓冲未能打开，正在切换兼容播放线路");
    }, 8_000);
    mediaSource.addEventListener(
      "sourceopen",
      () => {
        if (
          this.destroyed ||
          this.mediaSourceGeneration !== mediaSourceGeneration ||
          this.mediaSource !== mediaSource ||
          mediaSource.readyState !== "open" ||
          !this.session ||
          this.session.sessionId !== normalizedSession.sessionId ||
          this.session.mediaVersion !== normalizedSession.mediaVersion ||
          this.session.mimeType !== normalizedSession.mimeType ||
          this.session.plan.itemId !== normalizedSession.plan.itemId ||
          this.session.plan.playSessionId !==
            normalizedSession.plan.playSessionId ||
          this.session.plan.startTimeTicks !==
            normalizedSession.plan.startTimeTicks
        ) {
          return;
        }
        if (this.mediaSourceOpenTimer !== undefined) {
          window.clearTimeout(this.mediaSourceOpenTimer);
          this.mediaSourceOpenTimer = undefined;
        }
        try {
          const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
          this.sourceBuffer = sourceBuffer;
          sourceBuffer.mode = "segments";
          // This is only the pre-fragment fallback. Each current sender also
          // carries a repaired absolute timeline and pumpAppendQueue applies
          // its precise offset before appending the corresponding fragment.
          // Legacy senders that omit that metadata retain this session offset.
          sourceBuffer.timestampOffset = Math.max(
            0,
            finite(normalizedSession.plan.startTimeTicks) / 10_000_000,
          );
          sourceBuffer.addEventListener("updateend", () => {
            if (this.sourceBuffer !== sourceBuffer) return;
            this.clearAppendWatchdog();
            this.appendBusy = false;
            if (this.pendingQuotaRecovery) {
              this.pendingQuotaRecovery = false;
              this.quotaRecoveryAttempts = 0;
            }
            this.pumpAppendQueue();
            this.inspectBuffer();
          });
          sourceBuffer.addEventListener("error", () => {
            if (this.sourceBuffer !== sourceBuffer) return;
            this.clearAppendWatchdog();
            this.appendBusy = false;
            this.emitError(
              "本地解码器拒绝了当前媒体片段，正在切换兼容 H.264 播放线路",
            );
          });
          sourceBuffer.addEventListener("abort", () => {
            if (this.sourceBuffer !== sourceBuffer) return;
            this.clearAppendWatchdog();
            this.appendBusy = false;
          });
          if (normalizedSession.plan.runtimeTicks) {
            this.mediaSource.duration =
              normalizedSession.plan.runtimeTicks / 10_000_000;
          }
          this.pumpAppendQueue();
        } catch (error) {
          this.emitError(
            error instanceof Error
              ? `无法创建本地媒体缓冲：${error.message}`
              : "无法创建本地媒体缓冲",
          );
        }
      },
      { once: true },
    );
    this.startTimers();
    this.dispatchEvent(
      new CustomEvent("session", { detail: { ...normalizedSession } }),
    );
  }

  attachChannel(channel: RTCDataChannel): void {
    this.detachChannel();
    this.channel = channel;
    this.clockOffsetMs = 0;
    this.clockSamples = 0;
    this.lastInboundActivityAt = Date.now();
    this.transportFallbackRequested = false;
    channel.binaryType = "arraybuffer";
    const handleMessage = (event: MessageEvent) => {
      try {
        if (typeof event.data === "string") {
          if (event.data.length <= 16 * 1024) {
            this.lastInboundActivityAt = Date.now();
            this.handleControlText(event.data);
          }
          return;
        }
        if (!this.assembler) return;
        if (event.data instanceof ArrayBuffer) {
          this.assembler.accept(event.data);
          this.lastInboundActivityAt = Date.now();
          this.invalidPacketCount = 0;
        } else if (event.data instanceof Blob) {
          void event.data
            .arrayBuffer()
            .then((data) => {
              try {
                this.assembler?.accept(data);
                this.lastInboundActivityAt = Date.now();
                this.invalidPacketCount = 0;
              } catch {
                this.noteInvalidPacket();
              }
            })
            .catch(() => this.noteInvalidPacket());
        } else if (ArrayBuffer.isView(event.data)) {
          this.assembler.accept(
            new Uint8Array(
              event.data.buffer,
              event.data.byteOffset,
              event.data.byteLength,
            ),
          );
          this.lastInboundActivityAt = Date.now();
          this.invalidPacketCount = 0;
        }
      } catch {
        this.noteInvalidPacket();
      }
    };
    const handleClose = () => {
      if (this.channel !== channel) return;
      if (!this.streamComplete) this.dispatchEvent(new Event("disconnected"));
    };
    (channel as RTCDataChannel & {
      __syncedEmbyMessage?: (event: MessageEvent) => void;
      __syncedEmbyClose?: () => void;
    }).__syncedEmbyMessage = handleMessage;
    (channel as RTCDataChannel & {
      __syncedEmbyClose?: () => void;
    }).__syncedEmbyClose = handleClose;
    channel.addEventListener("message", handleMessage);
    channel.addEventListener("close", handleClose);
    if (channel.readyState === "open") this.sendClockPing();
    else {
      const handleOpen = () => this.sendClockPing();
      (
        channel as RTCDataChannel & {
          __syncedEmbyOpen?: () => void;
        }
      ).__syncedEmbyOpen = handleOpen;
      channel.addEventListener("open", handleOpen, { once: true });
    }
  }

  attachControlChannel(channel: RTCDataChannel): void {
    this.detachControlChannel();
    this.controlChannel = channel;
    this.clockOffsetMs = 0;
    this.clockSamples = 0;
    this.lastInboundActivityAt = Date.now();
    this.transportFallbackRequested = false;
    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string" || event.data.length > 16 * 1024) {
        return;
      }
      this.lastInboundActivityAt = Date.now();
      this.handleControlText(event.data);
    };
    const handleClose = () => {
      if (this.controlChannel !== channel) return;
      if (!this.streamComplete) this.dispatchEvent(new Event("disconnected"));
    };
    const handleOpen = () => this.sendClockPing();
    (
      channel as RTCDataChannel & {
        __syncedEmbyControlMessage?: (event: MessageEvent) => void;
        __syncedEmbyControlClose?: () => void;
        __syncedEmbyControlOpen?: () => void;
      }
    ).__syncedEmbyControlMessage = handleMessage;
    (
      channel as RTCDataChannel & {
        __syncedEmbyControlClose?: () => void;
      }
    ).__syncedEmbyControlClose = handleClose;
    channel.addEventListener("message", handleMessage);
    channel.addEventListener("close", handleClose);
    if (channel.readyState === "open") {
      handleOpen();
    } else {
      (
        channel as RTCDataChannel & {
          __syncedEmbyControlOpen?: () => void;
        }
      ).__syncedEmbyControlOpen = handleOpen;
      channel.addEventListener("open", handleOpen, { once: true });
    }
  }

  appendInit(data: Uint8Array): void {
    const session = this.session;
    if (this.awaitingMediaVersion !== undefined && !this.host) return;
    if (session) {
      this.receivedInitKey = this.initKey(
        session.sessionId,
        session.mediaVersion,
        session.transportEpoch ?? 0,
      );
    }
    this.appendQueue.unshift(data.slice());
    this.appendTimestampOffsets.unshift(undefined);
    this.emitAppendQueueChange();
    this.pumpAppendQueue();
    this.flushPendingMedia(false);
    this.maybeEndStream();
  }

  appendFragment(fragment: EmbyTransportFragment): void {
    const fragmentEpoch = fragment.transportEpoch ?? 0;
    if (
      this.awaitingMediaVersion !== undefined ||
      !this.session ||
      fragment.sessionId !== this.session.sessionId ||
      fragment.mediaVersion !== this.session.mediaVersion ||
      fragmentEpoch !== (this.session.transportEpoch ?? 0)
    ) {
      return;
    }
    if (fragment.trackType === "muxed" && fragment.sequence === 0) {
      const initKey = this.initKey(
        fragment.sessionId,
        fragment.mediaVersion,
        fragmentEpoch,
      );
      if (this.receivedInitKey === initKey) return;
      if (this.initRequestTimer !== undefined) {
        window.clearTimeout(this.initRequestTimer);
        this.initRequestTimer = undefined;
      }
      this.appendInit(fragment.data);
      return;
    }
    const fragmentPlaybackTimeMs = Number.isFinite(fragment.timelineTimeMs)
      ? Number(fragment.timelineTimeMs)
      : Number(fragment.mediaTimeMs);
    if (
      fragment.trackType === "muxed" &&
      this.started &&
      fragmentPlaybackTimeMs <
        Math.max(0, finite(this.video.currentTime) * 1_000 - 8_000)
    ) {
      // A newly sought/restarted fMP4 pipeline begins its raw tfdt clock at
      // zero even when the movie is already tens of seconds in. Compare the
      // repaired movie clock, not that raw clock, or every fragment following
      // the startup burst is mistaken for a stale retransmission and dropped.
      return;
    }
    if (fragment.trackType === "subtitle") {
      this.applySubtitle(new TextDecoder().decode(fragment.data));
      return;
    }
    this.queuePendingMedia(fragment);
  }

  private initKey(
    sessionId: string,
    mediaVersion: number,
    transportEpoch: number,
  ): string {
    return `${sessionId}:${mediaVersion}:${transportEpoch}`;
  }

  private queuePendingMedia(fragment: EmbyTransportFragment): void {
    if (
      fragment.data.byteLength > EMBY_MAX_REORDER_BYTES ||
      this.pendingMediaFragments.has(fragment.sequence) ||
      (this.nextMediaSequence !== undefined &&
        fragment.sequence < this.nextMediaSequence)
    ) {
      return;
    }
    this.missingFragmentRepairAttempts.delete(fragment.sequence);
    this.pendingMediaFragments.set(fragment.sequence, fragment);
    this.pendingMediaBytes += fragment.data.byteLength;
    while (
      this.pendingMediaFragments.size > EMBY_MAX_REORDER_FRAGMENTS ||
      this.pendingMediaBytes > EMBY_MAX_REORDER_BYTES
    ) {
      const highestSequence = Math.max(
        ...this.pendingMediaFragments.keys(),
      );
      const removed = this.pendingMediaFragments.get(highestSequence);
      if (!removed) break;
      this.pendingMediaFragments.delete(highestSequence);
      this.pendingMediaBytes = Math.max(
        0,
        this.pendingMediaBytes - removed.data.byteLength,
      );
    }
    if (!this.hasCurrentInit()) return;
    this.flushPendingMedia(this.host);
  }

  private hasCurrentInit(): boolean {
    const session = this.session;
    return Boolean(
      session &&
      this.receivedInitKey ===
        this.initKey(
          session.sessionId,
          session.mediaVersion,
          session.transportEpoch ?? 0,
        ),
    );
  }

  private flushPendingMedia(forceGap: boolean): void {
    if (forceGap && this.mediaReorderTimer !== undefined) {
      window.clearTimeout(this.mediaReorderTimer);
      this.mediaReorderTimer = undefined;
    }
    if (!this.hasCurrentInit() || !this.pendingMediaFragments.size) return;
    if (this.nextMediaSequence === undefined) {
      if (!forceGap) {
        this.scheduleMediaReorder();
        return;
      }
      this.nextMediaSequence = Math.min(
        ...this.pendingMediaFragments.keys(),
      );
    }
    let appended = false;
    while (this.nextMediaSequence !== undefined) {
      let fragment = this.pendingMediaFragments.get(
        this.nextMediaSequence,
      );
      if (!fragment && forceGap && this.pendingMediaFragments.size) {
        const nextAvailableSequence = Math.min(
          ...this.pendingMediaFragments.keys(),
        );
        if (
          this.nextMediaSequence < nextAvailableSequence &&
          this.requestMissingFragment(this.nextMediaSequence)
        ) {
          this.scheduleMediaReorder();
          return;
        }
        this.missingFragmentRepairAttempts.delete(this.nextMediaSequence);
        this.nextMediaSequence = nextAvailableSequence;
        fragment = this.pendingMediaFragments.get(this.nextMediaSequence);
      }
      if (!fragment) break;
      this.pendingMediaFragments.delete(fragment.sequence);
      this.pendingMediaBytes = Math.max(
        0,
        this.pendingMediaBytes - fragment.data.byteLength,
      );
      this.appendQueue.push(fragment.data);
      this.appendTimestampOffsets.push(
        this.timestampOffsetForFragment(fragment),
      );
      this.nextMediaSequence = fragment.sequence + 1;
      this.lastDeliveredMediaSequence = Math.max(
        this.lastDeliveredMediaSequence ?? fragment.sequence,
        fragment.sequence,
      );
      appended = true;
      forceGap = false;
    }
    if (appended) {
      this.emitAppendQueueChange();
      this.pumpAppendQueue();
    }
    if (this.pendingMediaFragments.size) {
      this.scheduleMediaReorder();
    } else {
      this.stopEndRepairIfReached();
      this.maybeEndStream();
    }
  }

  private requestMissingFragment(fragmentSequence: number): boolean {
    const session = this.session;
    if (
      !session ||
      !Number.isSafeInteger(fragmentSequence) ||
      fragmentSequence < 1
    ) {
      return false;
    }
    const attempts =
      this.missingFragmentRepairAttempts.get(fragmentSequence) || 0;
    if (attempts >= 3) return false;
    this.missingFragmentRepairAttempts.set(fragmentSequence, attempts + 1);
    // A completely lost fragment never reaches the chunk assembler, so it
    // cannot know which chunks to request. Asking for the first 64 chunks is
    // enough to reconstruct normal fragments and gives the assembler the
    // advertised chunkCount needed to request any remaining tail chunks.
    this.sendControl({
      type: "need",
      sessionId: session.sessionId,
      mediaVersion: session.mediaVersion,
      transportEpoch: session.transportEpoch ?? 0,
      fragmentSeq: fragmentSequence,
      trackType: "muxed",
      missing: Array.from({ length: 64 }, (_value, index) => index),
    });
    return true;
  }

  private scheduleMediaReorder(): void {
    if (this.mediaReorderTimer !== undefined) return;
    this.mediaReorderTimer = window.setTimeout(() => {
      this.mediaReorderTimer = undefined;
      this.flushPendingMedia(true);
      this.maybeEndStream();
    }, EMBY_REORDER_WAIT_MS);
  }

  private resetPendingMediaReception(clearAppendQueue: boolean): void {
    if (this.mediaReorderTimer !== undefined) {
      window.clearTimeout(this.mediaReorderTimer);
      this.mediaReorderTimer = undefined;
    }
    this.pendingMediaFragments.clear();
    this.pendingMediaBytes = 0;
    this.nextMediaSequence = undefined;
    this.lastDeliveredMediaSequence = undefined;
    this.missingFragmentRepairAttempts.clear();
    if (clearAppendQueue) {
      const hadQueuedData = this.appendQueue.length > 0;
      this.appendQueue = [];
      this.appendTimestampOffsets = [];
      if (hadQueuedData) this.emitAppendQueueChange();
    }
  }

  private timestampOffsetForFragment(
    fragment: EmbyTransportFragment,
  ): number | undefined {
    if (
      !Number.isFinite(fragment.mediaTimeMs) ||
      !Number.isFinite(fragment.timelineTimeMs)
    ) {
      return undefined;
    }
    this.lastMediaTimeMs = Number(fragment.mediaTimeMs);
    this.lastTimelineTimeMs = Number(fragment.timelineTimeMs);
    return (this.lastTimelineTimeMs - this.lastMediaTimeMs) / 1_000;
  }

  applySubtitle(text: string): void {
    this.removeSubtitle();
    if (!text.trim()) return;
    if (text.length > 12 * 1024 * 1024) {
      this.emitError("Emby 字幕文件过大，已拒绝在播放器中加载");
      return;
    }
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = "Emby 字幕";
    track.srclang = "zh";
    track.default = true;
    this.subtitleUrl = URL.createObjectURL(
      new Blob([normalizeWebVtt(text)], { type: "text/vtt;charset=utf-8" }),
    );
    track.src = this.subtitleUrl;
    this.video.append(track);
    track.addEventListener(
      "load",
      () => {
        if (track.track) track.track.mode = "showing";
      },
      { once: true },
    );
  }

  handlePlaybackState(
    state: Extract<EmbyControlMessage, { type: "playback-state" }>,
  ): void {
    const session = this.session;
    if (
      !session ||
      this.awaitingMediaVersion !== undefined ||
      state.sessionId !== session.sessionId ||
      state.mediaVersion !== session.mediaVersion ||
      state.stateVersion <= this.lastStateVersion
    ) {
      return;
    }
    this.lastStateVersion = state.stateVersion;
    this.hostWantsPaused = state.paused;
    if (this.awaitingResyncEpoch !== undefined) {
      this.video.pause();
      return;
    }
    const hostNow = Date.now() + this.clockOffsetMs;
    const desired = state.paused
      ? state.currentTime
      : state.currentTime +
        ((hostNow - state.serverTimeMs) / 1_000) * state.playbackRate;
    this.latestHostTarget = Math.max(0, desired);
    // While the first buffer window is still filling, keep the decoder on one
    // stable timestamp. Chasing the advancing host clock here used to assign
    // currentTime every 500 ms, which maps to a continuous MediaCodec flush
    // loop on Huawei/older Android WebViews. inspectBuffer() starts from the
    // first cached keyframe once the startup barrier is actually satisfied;
    // the next state packet then performs at most one bounded correction.
    if (!this.started && !state.paused) {
      this.video.playbackRate = state.playbackRate;
      this.inspectBuffer(true);
      this.dispatchEvent(
        new CustomEvent("playbackstate", {
          detail: {
            paused: false,
            currentTime: Math.max(0, desired),
            playbackRate: state.playbackRate,
          },
        }),
      );
      return;
    }
    const error = desired - finite(this.video.currentTime);
    const targetBuffered = this.isTimeBuffered(Math.max(0, desired));
    const correction = planEmbyPlaybackCorrection(
      error,
      state.paused,
      state.playbackRate,
    );
    if (correction.action === "seek") {
      const target = Math.max(0, desired);
      if (
        state.paused ||
        target <= this.video.currentTime ||
        targetBuffered
      ) {
        const now = Date.now();
        if (
          Math.abs(target - finite(this.video.currentTime)) <= 0.08 ||
          now - this.lastHardSeekAt >= 1_500
        ) {
          this.lastHardSeekAt = now;
          this.video.currentTime = target;
          this.pendingCatchUpTarget = undefined;
          this.syncHeld = false;
        }
      } else {
        const now = Date.now();
        if (shouldHardResyncEmbyPlayback(error, targetBuffered)) {
          this.holdForCatchUp(target);
        }
        if (
          error > 1 &&
          now - this.lastCatchUpRequestAt >= 1_200
        ) {
          this.requestCatchUp(target, "sync-gap");
        }
        this.inspectBuffer(true);
      }
    } else if (correction.action === "rate") {
      this.video.playbackRate = correction.playbackRate;
      if (this.speedRestoreTimer !== undefined) {
        window.clearTimeout(this.speedRestoreTimer);
      }
      this.speedRestoreTimer = window.setTimeout(() => {
        this.speedRestoreTimer = undefined;
        this.video.playbackRate = state.playbackRate;
      }, correction.restoreAfterMs);
    } else {
      this.video.playbackRate = correction.playbackRate;
    }
    if (state.paused) {
      this.pendingCatchUpTarget = undefined;
      this.syncHeld = false;
      this.video.pause();
    } else if (
      !this.syncHeld &&
      this.bufferedAhead >= Math.min(2, this.initialBufferSeconds)
    ) {
      void this.video.play().catch(() => undefined);
    }
    this.dispatchEvent(
      new CustomEvent("playbackstate", {
        detail: {
          paused: state.paused,
          currentTime: Math.max(0, desired),
          playbackRate: state.playbackRate,
        },
      }),
    );
  }

  markEnded(boundary?: {
    transportEpoch: number;
    finalFragmentSeq: number;
  }): void {
    this.clearEndBoundary();
    if (boundary) {
      this.streamComplete = false;
      this.endBoundary = boundary;
      this.endBoundaryTimedOut = false;
      this.armEndBoundaryRepair();
    } else {
      // Legacy hosts did not advertise a final fragment boundary.
      this.streamComplete = true;
    }
    this.endRequested = true;
    this.flushPendingMedia(false);
    this.maybeEndStream();
  }

  private handleControlText(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof (parsed as { type?: unknown }).type !== "string" ||
      (parsed as { type: string }).type.length < 1 ||
      (parsed as { type: string }).type.length > 64
    ) {
      this.noteInvalidPacket();
      return;
    }
    const message = parsed as EmbyControlMessage;
    if (message.type === "session") {
      const plan = message.plan;
      const planFrameRate = Number(plan?.frameRate ?? 30);
      const transportEpoch =
        message.transportEpoch === undefined
          ? 0
          : Number(message.transportEpoch);
      if (
        this.awaitingMediaVersion !== undefined &&
        Number(message.mediaVersion) < this.awaitingMediaVersion
      ) {
        return;
      }
      if (
        !/^[a-z0-9_-]{1,32}$/i.test(String(message.roomId || "")) ||
        !/^[a-z0-9_-]{1,128}$/i.test(String(message.sessionId || "")) ||
        !Number.isSafeInteger(message.mediaVersion) ||
        message.mediaVersion < 1 ||
        !Number.isSafeInteger(transportEpoch) ||
        transportEpoch < 0 ||
        transportEpoch > 1_000_000_000 ||
        typeof message.mimeType !== "string" ||
        message.mimeType.length > 180 ||
        !/^video\/mp4;\s*codecs="[-a-z0-9., ]+"$/i.test(
          message.mimeType,
        ) ||
        !plan ||
        typeof plan !== "object" ||
        !["h264", "hevc"].includes(plan.videoCodec) ||
        plan.audioCodec !== "aac" ||
        !Number.isFinite(plan.width) ||
        plan.width < 1 ||
        plan.width > 7_680 ||
        !Number.isFinite(plan.height) ||
        plan.height < 1 ||
        plan.height > 4_320 ||
        !Number.isFinite(planFrameRate) ||
        planFrameRate < 1 ||
        planFrameRate > 60 ||
        !Number.isFinite(plan.bitrate) ||
        plan.bitrate < 1 ||
        plan.bitrate > 100_000_000 ||
        typeof message.title !== "string" ||
        message.title.length > 300
      ) {
        this.noteInvalidPacket();
        return;
      }
      const activeSession = this.session;
      if (
        activeSession?.sessionId === message.sessionId &&
        activeSession.mediaVersion === message.mediaVersion &&
        (activeSession.transportEpoch ?? 0) === transportEpoch &&
        activeSession.mimeType === message.mimeType
      ) {
        // SFU control is broadcast. A late subscriber asks the host to
        // repeat the session envelope for the room; existing viewers must
        // acknowledge it without rebuilding a healthy MediaSource.
        this.sendControl({
          type: "session-ready",
          sessionId: message.sessionId,
          mediaVersion: message.mediaVersion,
          transportEpoch,
        });
        return;
      }
      this.configure({
        roomId: message.roomId,
        sessionId: message.sessionId,
        mediaVersion: message.mediaVersion,
        transportEpoch,
        mimeType: message.mimeType,
        plan: { ...message.plan, frameRate: planFrameRate },
        title: message.title,
      });
      this.assembler?.reset();
      this.assembler = new EmbyFragmentAssembler(
        {
          roomId: message.roomId,
          sessionId: message.sessionId,
          mediaVersion: message.mediaVersion,
          transportEpoch,
        },
        (fragment) => this.appendFragment(fragment),
        (
          mediaVersion,
          fragmentSeq,
          trackType,
          missing,
          missingEpoch,
        ) => {
          this.sendControl({
            type: "need",
            sessionId: message.sessionId,
            mediaVersion,
            transportEpoch: missingEpoch,
            fragmentSeq,
            trackType,
            missing,
          });
        },
        (nextEpoch) =>
          this.advanceTransportEpochFromMedia(
            message.sessionId,
            message.mediaVersion,
            nextEpoch,
          ),
        (detail) => this.handleAssemblyAbandonment(detail),
      );
      this.sendControl({
        type: "session-ready",
        sessionId: message.sessionId,
        mediaVersion: message.mediaVersion,
        transportEpoch,
      });
      // The broadcaster sends the init segment immediately before cached
      // media. Request it only if that proactive copy did not arrive, which
      // avoids duplicate MP4 initialization segments under normal latency.
      this.armInitRequest();
      return;
    }
    if (message.type === "stream-transition") {
      const session = this.session;
      if (
        !session ||
        message.sessionId !== session.sessionId ||
        message.mediaVersion !== session.mediaVersion ||
        !Number.isSafeInteger(message.nextMediaVersion) ||
        message.nextMediaVersion <= session.mediaVersion ||
        message.nextMediaVersion > 1_000_000_000 ||
        !Number.isFinite(message.targetTime) ||
        message.targetTime < 0 ||
        message.targetTime > 30 * 24 * 60 * 60
      ) {
        return;
      }
      if (
        this.awaitingMediaVersion !== undefined &&
        message.nextMediaVersion < this.awaitingMediaVersion
      ) {
        return;
      }
      this.beginStreamTransition(
        message.nextMediaVersion,
        message.targetTime,
      );
      return;
    }
    if (message.type === "playback-state") {
      if (
        !Number.isSafeInteger(message.stateVersion) ||
        message.stateVersion < 1 ||
        !Number.isFinite(message.currentTime) ||
        message.currentTime < 0 ||
        message.currentTime > 30 * 24 * 60 * 60 ||
        !Number.isFinite(message.playbackRate) ||
        message.playbackRate < 0.25 ||
        message.playbackRate > 4 ||
        !Number.isFinite(message.serverTimeMs)
      ) {
        this.noteInvalidPacket();
        return;
      }
      this.handlePlaybackState(message);
      return;
    }
    if (message.type === "resync") {
      const session = this.session;
      const hasTransportEpoch = message.transportEpoch !== undefined;
      const transportEpoch = hasTransportEpoch
        ? Number(message.transportEpoch)
        : (session?.transportEpoch ?? 0);
      if (
        !session ||
        message.sessionId !== session.sessionId ||
        message.mediaVersion !== session.mediaVersion ||
        !Number.isSafeInteger(transportEpoch) ||
        transportEpoch < 0 ||
        transportEpoch > 1_000_000_000 ||
        !Number.isFinite(message.targetTime) ||
        message.targetTime < 0 ||
        message.targetTime > 30 * 24 * 60 * 60
      ) {
        this.noteInvalidPacket();
        return;
      }
      const currentEpoch = session.transportEpoch ?? 0;
      if (transportEpoch < currentEpoch) return;
      if (transportEpoch > currentEpoch) {
        if (!this.assembler?.advanceTransportEpoch(transportEpoch)) {
          this.noteInvalidPacket();
          return;
        }
        this.session = { ...session, transportEpoch };
        this.clearEndBoundary();
        this.endRequested = false;
        this.streamComplete = false;
        this.awaitingResyncEpoch = undefined;
        this.holdForCatchUp(message.targetTime, true);
      } else if (this.awaitingResyncEpoch === transportEpoch) {
        // Media on the unordered SCTP stream may beat the ordered control
        // stream. It has already advanced the epoch and cleared stale receive
        // queues, so only apply the authoritative target here.
        this.awaitingResyncEpoch = undefined;
        this.pendingCatchUpTarget = Math.max(0, message.targetTime);
        this.syncHeld = true;
        this.video.pause();
        this.inspectBuffer(true);
      } else {
        // If higher-epoch media crossed SCTP streams and arrived first, its
        // callback has already cleared stale queues. Preserve those fresh
        // fragments when the matching resync control arrives later.
        this.holdForCatchUp(
          message.targetTime,
          !hasTransportEpoch || !this.syncHeld,
        );
      }
      this.armInitRequest();
      return;
    }
    if (message.type === "sync-pong") {
      if (
        !Number.isFinite(message.clientTimeMs) ||
        !Number.isFinite(message.hostTimeMs)
      ) {
        this.noteInvalidPacket();
        return;
      }
      const now = Date.now();
      const roundTrip = now - message.clientTimeMs;
      if (roundTrip >= 0 && roundTrip < 5_000) {
        const sample =
          message.hostTimeMs - (message.clientTimeMs + roundTrip / 2);
        this.clockOffsetMs =
          this.clockSamples < 3
            ? (this.clockOffsetMs * this.clockSamples + sample) /
              (this.clockSamples + 1)
            : this.clockOffsetMs * 0.7 + sample * 0.3;
        this.clockSamples += 1;
      }
      return;
    }
    if (message.type === "stream-ended") {
      const session = this.session;
      if (
        session &&
        this.awaitingMediaVersion === undefined &&
        message.sessionId === session.sessionId &&
        message.mediaVersion === session.mediaVersion
      ) {
        const hasBoundary =
          message.transportEpoch !== undefined ||
          message.finalFragmentSeq !== undefined ||
          message.finalTrackType !== undefined;
        if (!hasBoundary) {
          this.markEnded();
          return;
        }
        const transportEpoch = Number(message.transportEpoch);
        const finalFragmentSeq = Number(message.finalFragmentSeq);
        if (
          !Number.isSafeInteger(transportEpoch) ||
          transportEpoch < 0 ||
          transportEpoch > 1_000_000_000 ||
          transportEpoch !== (session.transportEpoch ?? 0) ||
          !Number.isSafeInteger(finalFragmentSeq) ||
          finalFragmentSeq < 0 ||
          finalFragmentSeq > 10_000_000 ||
          (message.finalTrackType !== undefined &&
            message.finalTrackType !== "muxed")
        ) {
          return;
        }
        this.markEnded({ transportEpoch, finalFragmentSeq });
      }
      return;
    }
    if (message.type === "error") {
      if (
        typeof message.message === "string" &&
        message.message.length <= 600 &&
        (!message.sessionId ||
          message.sessionId === this.session?.sessionId) &&
        (!message.mediaVersion ||
          message.mediaVersion === this.session?.mediaVersion ||
          (this.awaitingMediaVersion !== undefined &&
            message.mediaVersion >= this.awaitingMediaVersion))
      ) {
        this.emitError(message.message);
      }
    }
  }

  private beginStreamTransition(
    nextMediaVersion: number,
    targetTime: number,
  ): void {
    this.awaitingMediaVersion = nextMediaVersion;
    this.pendingCatchUpTarget = Math.max(0, finite(targetTime));
    this.syncHeld = true;
    this.video.pause();
    this.clearEndBoundary();
    this.endRequested = false;
    this.streamComplete = false;
    this.assembler?.reset();
    // Do not tear down the RTC data channels or the currently displayed MSE
    // element. Keeping the paused last frame makes a seek/rebuild visually
    // continuous, while removing the assembler ensures late bytes from the
    // old mediaVersion/epoch cannot enter the replacement SourceBuffer.
    this.assembler = undefined;
    this.resetPendingMediaReception(true);
    this.receivedInitKey = "";
    if (this.initRequestTimer !== undefined) {
      window.clearTimeout(this.initRequestTimer);
      this.initRequestTimer = undefined;
    }
    this.clearStreamTransitionTimer();
    this.streamTransitionTimer = window.setTimeout(() => {
      this.streamTransitionTimer = undefined;
      if (
        this.destroyed ||
        this.awaitingMediaVersion !== nextMediaVersion
      ) {
        return;
      }
      this.emitError("Emby 跳转缓冲超时；数据通道仍保持连接，可再次拖动重试");
    }, 30_000);
  }

  private clearStreamTransitionTimer(): void {
    if (this.streamTransitionTimer === undefined) return;
    window.clearTimeout(this.streamTransitionTimer);
    this.streamTransitionTimer = undefined;
  }

  private advanceTransportEpochFromMedia(
    sessionId: string,
    mediaVersion: number,
    transportEpoch: number,
  ): boolean {
    const session = this.session;
    if (
      !session ||
      session.sessionId !== sessionId ||
      session.mediaVersion !== mediaVersion ||
      !Number.isSafeInteger(transportEpoch) ||
      transportEpoch <= (session.transportEpoch ?? 0) ||
      transportEpoch > 1_000_000_000
    ) {
      return false;
    }
    this.session = { ...session, transportEpoch };
    this.clearEndBoundary();
    this.endRequested = false;
    this.streamComplete = false;
    this.awaitingResyncEpoch = transportEpoch;
    this.pendingCatchUpTarget = undefined;
    this.syncHeld = true;
    this.video.pause();
    this.assembler?.reset();
    this.resetPendingMediaReception(true);
    this.receivedInitKey = "";
    this.armInitRequest();
    return true;
  }

  private armInitRequest(): void {
    if (this.initRequestTimer !== undefined) {
      window.clearTimeout(this.initRequestTimer);
    }
    this.initRequestTimer = window.setTimeout(() => {
      this.initRequestTimer = undefined;
      const session = this.session;
      if (!session) return;
      const transportEpoch = session.transportEpoch ?? 0;
      if (
        this.receivedInitKey ===
        this.initKey(
          session.sessionId,
          session.mediaVersion,
          transportEpoch,
        )
      ) {
        return;
      }
      this.sendControl({
        type: "init-request",
        sessionId: session.sessionId,
        mediaVersion: session.mediaVersion,
        transportEpoch,
      });
    }, 1_200);
  }

  private hasReachedEndBoundary(): boolean {
    const boundary = this.endBoundary;
    const session = this.session;
    if (
      !boundary ||
      !session ||
      boundary.transportEpoch !== (session.transportEpoch ?? 0)
    ) {
      return false;
    }
    return boundary.finalFragmentSeq === 0
      ? this.hasCurrentInit()
      : (this.lastDeliveredMediaSequence ?? -1) >=
          boundary.finalFragmentSeq;
  }

  private stopEndRepairIfReached(): void {
    if (!this.endBoundary || !this.hasReachedEndBoundary()) return;
    this.streamComplete = true;
    // The final muxed fragment is authoritative for this epoch. Any remaining
    // partial assembly belongs to an older skipped muxed fragment or subtitle
    // and must not strand endOfStream after its own silent expiry.
    this.assembler?.reset();
    if (this.endRepairTimer !== undefined) {
      window.clearTimeout(this.endRepairTimer);
      this.endRepairTimer = undefined;
    }
    if (this.endBoundaryTimer !== undefined) {
      window.clearTimeout(this.endBoundaryTimer);
      this.endBoundaryTimer = undefined;
    }
  }

  private armEndBoundaryRepair(): void {
    this.stopEndRepairIfReached();
    if (!this.endBoundary || this.streamComplete) return;
    const requestTail = (): void => {
      this.endRepairTimer = undefined;
      const boundary = this.endBoundary;
      const session = this.session;
      if (
        !boundary ||
        !session ||
        boundary.transportEpoch !== (session.transportEpoch ?? 0) ||
        this.hasReachedEndBoundary()
      ) {
        this.stopEndRepairIfReached();
        return;
      }
      if (boundary.finalFragmentSeq === 0) {
        this.sendControl({
          type: "init-request",
          sessionId: session.sessionId,
          mediaVersion: session.mediaVersion,
          transportEpoch: boundary.transportEpoch,
        });
      } else {
        this.sendControl({
          type: "need",
          sessionId: session.sessionId,
          mediaVersion: session.mediaVersion,
          transportEpoch: boundary.transportEpoch,
          fragmentSeq: boundary.finalFragmentSeq,
          trackType: "muxed",
          missing: Array.from({ length: 64 }, (_value, index) => index),
        });
      }
      this.endRepairTimer = window.setTimeout(requestTail, 1_200);
    };
    this.endRepairTimer = window.setTimeout(requestTail, 600);
    this.endBoundaryTimer = window.setTimeout(() => {
      this.endBoundaryTimer = undefined;
      if (this.hasReachedEndBoundary()) {
        this.stopEndRepairIfReached();
        this.maybeEndStream();
        return;
      }
      this.endBoundaryTimedOut = true;
      this.streamComplete = true;
      if (this.endRepairTimer !== undefined) {
        window.clearTimeout(this.endRepairTimer);
        this.endRepairTimer = undefined;
      }
      this.assembler?.reset();
      this.flushPendingMedia(true);
      this.maybeEndStream();
    }, 12_000);
  }

  private clearEndBoundary(): void {
    if (this.endRepairTimer !== undefined) {
      window.clearTimeout(this.endRepairTimer);
      this.endRepairTimer = undefined;
    }
    if (this.endBoundaryTimer !== undefined) {
      window.clearTimeout(this.endBoundaryTimer);
      this.endBoundaryTimer = undefined;
    }
    this.endBoundary = undefined;
    this.endBoundaryTimedOut = false;
  }

  private sendControl(message: EmbyControlMessage): void {
    const channel =
      this.controlChannel?.readyState === "open"
        ? this.controlChannel
        : this.channel;
    if (channel?.readyState === "open") {
      try {
        channel.send(JSON.stringify(message));
      } catch {
        // Reconnection establishes a new channel and resends session state.
      }
    }
  }

  private noteInvalidPacket(): void {
    this.invalidPacketCount += 1;
    if (this.invalidPacketCount < 8) return;
    this.emitError("收到连续损坏或越界的 Emby 媒体数据，已断开此播放通道");
    if (this.channel?.readyState !== "closed") this.channel?.close();
  }

  private sendClockPing(): void {
    this.sendControl({ type: "sync-ping", clientTimeMs: Date.now() });
  }

  private isTimeBuffered(seconds: number): boolean {
    for (let index = 0; index < this.video.buffered.length; index += 1) {
      if (
        seconds >= this.video.buffered.start(index) - 0.15 &&
        seconds <= this.video.buffered.end(index) + 0.15
      ) {
        return true;
      }
    }
    return false;
  }

  private holdForCatchUp(targetTime: number, forceReset = false): void {
    const firstHold = !this.syncHeld;
    this.pendingCatchUpTarget = Math.max(0, finite(targetTime));
    this.syncHeld = true;
    this.video.pause();
    if (!firstHold && !forceReset) return;
    this.assembler?.reset();
    this.resetPendingMediaReception(true);
    this.receivedInitKey = "";
    this.inspectBuffer(true);
  }

  private pumpAppendQueue(): void {
    if (
      this.appendBusy ||
      !this.sourceBuffer ||
      this.sourceBuffer.updating ||
      !this.appendQueue.length
    ) {
      this.maybeEndStream();
      return;
    }
    const next = this.appendQueue[0];
    const nextTimestampOffset = this.appendTimestampOffsets[0];
    try {
      this.appendBusy = true;
      if (
        Number.isFinite(nextTimestampOffset) &&
        Math.abs(
          finite(this.sourceBuffer.timestampOffset) -
            Number(nextTimestampOffset),
        ) > 0.0005
      ) {
        this.sourceBuffer.timestampOffset = Number(nextTimestampOffset);
      }
      // Init data is cloned on enqueue and media fragments are immutable IPC
      // payloads. SourceBuffer snapshots the BufferSource, so another full
      // JavaScript copy here only doubles the peak memory/GC cost for 4K.
      const appendable =
        next.buffer instanceof ArrayBuffer &&
        next.byteOffset === 0 &&
        next.byteLength === next.buffer.byteLength
          ? next.buffer
          : next.slice().buffer;
      this.sourceBuffer.appendBuffer(appendable);
      this.appendQueue.shift();
      this.appendTimestampOffsets.shift();
      this.quotaRecoveryAttempts = 0;
      this.emitAppendQueueChange();
      if (typeof this.sourceBuffer.addEventListener === "function") {
        this.armAppendWatchdog();
      }
    } catch (error) {
      this.clearAppendWatchdog();
      this.appendBusy = false;
      if (
        error instanceof DOMException &&
        error.name === "QuotaExceededError"
      ) {
        this.pendingQuotaRecovery = true;
        this.trimBehind(true);
        return;
      }
      this.appendQueue.shift();
      this.appendTimestampOffsets.shift();
      this.emitAppendQueueChange();
      this.emitError(
        error instanceof Error
          ? `追加媒体片段失败：${error.message}`
          : "追加媒体片段失败",
      );
      window.setTimeout(() => this.pumpAppendQueue(), 0);
    }
  }

  private armAppendWatchdog(): void {
    this.clearAppendWatchdog();
    this.appendWatchdogTimer = window.setTimeout(() => {
      this.appendWatchdogTimer = undefined;
      if (
        this.destroyed ||
        !this.appendBusy ||
        !this.sourceBuffer ||
        !this.session
      ) {
        return;
      }
      this.appendBusy = false;
      this.emitError(
        "本地媒体片段解码超时，正在切换兼容 H.264 播放线路",
      );
    }, 8_000);
  }

  private clearAppendWatchdog(): void {
    if (this.appendWatchdogTimer === undefined) return;
    window.clearTimeout(this.appendWatchdogTimer);
    this.appendWatchdogTimer = undefined;
  }

  private maybeEndStream(): void {
    if (
      this.endBoundary &&
      !this.endBoundaryTimedOut &&
      !this.hasReachedEndBoundary()
    ) {
      return;
    }
    this.stopEndRepairIfReached();
    if (
      !this.endRequested ||
      this.appendQueue.length ||
      this.pendingMediaFragments.size ||
      this.mediaReorderTimer !== undefined ||
      (this.endBoundary && this.assembler?.hasPending) ||
      this.appendBusy ||
      this.sourceBuffer?.updating ||
      this.mediaSource?.readyState !== "open"
    ) {
      return;
    }
    try {
      this.mediaSource.endOfStream();
      this.endRequested = false;
      this.clearEndBoundary();
    } catch {
      // A final updateend or MediaSource state transition will retry.
    }
  }

  private inspectBuffer(urgent = false): void {
    if (!this.session || !this.video.buffered.length) return;
    if (this.awaitingMediaVersion !== undefined) {
      this.video.pause();
      return;
    }
    if (this.awaitingResyncEpoch !== undefined) {
      this.video.pause();
      return;
    }
    const catchUpTarget = this.pendingCatchUpTarget;
    if (
      catchUpTarget !== undefined &&
      this.isTimeBuffered(catchUpTarget)
    ) {
      this.video.currentTime = catchUpTarget;
      this.pendingCatchUpTarget = undefined;
      this.syncHeld = false;
      if (!this.hostWantsPaused) {
        void this.video.play().catch(() => undefined);
      }
    }
    const firstStart = this.video.buffered.start(0);
    if (
      !this.started &&
      (this.video.currentTime < firstStart - 0.1 ||
        this.video.currentTime > this.video.buffered.end(0))
    ) {
      const now = Date.now();
      // Some Android decoders apply the initial seek asynchronously. Repeating
      // it on every 500 ms buffer inspection flushes the same decoder before
      // it can output a frame, so re-anchor only after a bounded grace period.
      if (now - this.lastStartupAnchorAt >= 2_000) {
        this.lastStartupAnchorAt = now;
        this.video.currentTime = firstStart;
      }
    }
    const ahead = this.bufferedAhead;
    const bufferedBehind = Math.max(
      0,
      this.video.currentTime - this.video.buffered.start(0),
    );
    const policy = evaluateEmbyBufferPolicy(ahead, bufferedBehind, {
      initialSeconds: this.initialBufferSeconds,
      targetSeconds: this.targetBufferSeconds,
      maxSeconds: this.maxBufferSeconds,
    });
    if (
      !this.started &&
      policy.canStart &&
      (this.host || !this.hostWantsPaused)
    ) {
      this.started = true;
      if (!this.host) void this.video.play().catch(() => undefined);
      this.dispatchEvent(new Event("ready"));
    }
    if (
      !this.mediaReadySent &&
      (ahead + BUFFER_TIME_EPSILON_SECONDS >= this.initialBufferSeconds ||
        this.streamComplete)
    ) {
      this.mediaReadySent = true;
      this.sendControl({
        type: "media-ready",
        sessionId: this.session.sessionId,
        mediaVersion: this.session.mediaVersion,
        transportEpoch: this.session.transportEpoch ?? 0,
      });
    }
    if (policy.shouldTrim) {
      this.trimBehind(false);
    }
    const now = Date.now();
    if (shouldReportEmbyBuffer(this.lastBufferReportAt, now)) {
      this.lastBufferReportAt = now;
      const detail = {
        aheadSeconds: ahead,
        initialSeconds: this.initialBufferSeconds,
        targetSeconds: this.targetBufferSeconds,
        pausedForFlow: policy.pausedForFlow,
      };
      this.dispatchEvent(new CustomEvent("buffer", { detail }));
      this.sendControl({
        type: "buffer-state",
        sessionId: this.session.sessionId,
        mediaVersion: this.session.mediaVersion,
        transportEpoch: this.session.transportEpoch ?? 0,
        aheadSeconds: ahead,
        urgent: urgent || policy.urgent,
      });
    }
  }

  private trimBehind(force: boolean): void {
    const sourceBuffer = this.sourceBuffer;
    if (!sourceBuffer) {
      this.pendingQuotaRecovery = false;
      return;
    }
    if (sourceBuffer.updating) {
      // updateend owns the next trim/pump decision.
      return;
    }
    if (!sourceBuffer.buffered.length) {
      if (this.pendingQuotaRecovery) this.scheduleQuotaRecovery();
      return;
    }
    const removeEnd = Math.max(0, this.video.currentTime - (force ? 8 : 30));
    const start = sourceBuffer.buffered.start(0);
    if (removeEnd <= start + 0.5) {
      // A deep forward buffer can reach the browser quota before enough media
      // exists behind currentTime to remove. Synchronous retries used to spin
      // the renderer and made seek/rebuild appear frozen.
      if (this.pendingQuotaRecovery) this.scheduleQuotaRecovery();
      return;
    }
    try {
      this.appendBusy = true;
      sourceBuffer.remove(start, removeEnd);
    } catch {
      this.appendBusy = false;
      if (this.pendingQuotaRecovery) this.scheduleQuotaRecovery();
    }
  }

  private scheduleQuotaRecovery(): void {
    this.appendBusy = false;
    if (this.quotaRecoveryTimer !== undefined || this.destroyed) return;
    this.quotaRecoveryAttempts += 1;
    const delay = Math.min(
      2_000,
      350 + this.quotaRecoveryAttempts * 100,
    );
    this.quotaRecoveryTimer = window.setTimeout(() => {
      this.quotaRecoveryTimer = undefined;
      if (this.destroyed || !this.sourceBuffer) return;
      this.pendingQuotaRecovery = false;
      this.pumpAppendQueue();
    }, delay);
  }

  private startTimers(): void {
    if (this.bufferTimer !== undefined) window.clearInterval(this.bufferTimer);
    if (this.syncTimer !== undefined) window.clearInterval(this.syncTimer);
    if (this.syncRampTimer !== undefined) window.clearTimeout(this.syncRampTimer);
    this.bufferTimer = window.setInterval(() => {
      this.inspectBuffer();
      this.inspectTransportLiveness();
    }, 500);
    if (!this.host) {
      this.syncTimer = window.setInterval(() => this.sendClockPing(), 2_000);
      this.syncRampTimer = window.setTimeout(() => {
        this.syncRampTimer = undefined;
        if (this.syncTimer !== undefined) window.clearInterval(this.syncTimer);
        this.syncTimer = window.setInterval(() => this.sendClockPing(), 5_000);
      }, 30_000);
    }
  }

  private inspectTransportLiveness(): void {
    if (
      this.host ||
      this.recoveryStrategy !== "transport-fallback" ||
      this.destroyed ||
      this.streamComplete ||
      !this.session ||
      this.transportFallbackRequested
    ) {
      return;
    }
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      // Chromium may suspend both rendering and timers in the background.
      // Give the transport a fresh observation window after visibility resumes.
      this.lastInboundActivityAt = Date.now();
      return;
    }
    const now = Date.now();
    if (!this.lastInboundActivityAt) {
      this.lastInboundActivityAt = now;
      return;
    }
    if (now - this.lastInboundActivityAt < EMBY_TRANSPORT_SILENCE_TIMEOUT_MS) {
      return;
    }
    this.requestCatchUp(
      Math.max(
        0,
        finite(this.video.currentTime),
        finite(this.latestHostTarget),
      ),
      "transport-silent",
    );
  }

  private emitError(message: string): void {
    this.dispatchEvent(
      new CustomEvent("error", {
        detail: String(message || "Emby 播放失败").slice(0, 600),
      }),
    );
  }

  private emitAppendQueueChange(): void {
    this.dispatchEvent(
      new CustomEvent("appendqueuechange", {
        detail: { queuedBytes: this.queuedAppendBytes },
      }),
    );
  }

  private detachChannel(): void {
    const channel = this.channel as
      | (RTCDataChannel & {
          __syncedEmbyMessage?: (event: MessageEvent) => void;
          __syncedEmbyClose?: () => void;
          __syncedEmbyOpen?: () => void;
        })
      | undefined;
    if (channel?.__syncedEmbyMessage) {
      channel.removeEventListener("message", channel.__syncedEmbyMessage);
      delete channel.__syncedEmbyMessage;
    }
    if (channel?.__syncedEmbyClose) {
      channel.removeEventListener("close", channel.__syncedEmbyClose);
      delete channel.__syncedEmbyClose;
    }
    if (channel?.__syncedEmbyOpen) {
      channel.removeEventListener("open", channel.__syncedEmbyOpen);
      delete channel.__syncedEmbyOpen;
    }
    this.channel = undefined;
  }

  private detachControlChannel(): void {
    const channel = this.controlChannel as
      | (RTCDataChannel & {
          __syncedEmbyControlMessage?: (event: MessageEvent) => void;
          __syncedEmbyControlClose?: () => void;
          __syncedEmbyControlOpen?: () => void;
        })
      | undefined;
    if (channel?.__syncedEmbyControlMessage) {
      channel.removeEventListener(
        "message",
        channel.__syncedEmbyControlMessage,
      );
      delete channel.__syncedEmbyControlMessage;
    }
    if (channel?.__syncedEmbyControlClose) {
      channel.removeEventListener(
        "close",
        channel.__syncedEmbyControlClose,
      );
      delete channel.__syncedEmbyControlClose;
    }
    if (channel?.__syncedEmbyControlOpen) {
      channel.removeEventListener(
        "open",
        channel.__syncedEmbyControlOpen,
      );
      delete channel.__syncedEmbyControlOpen;
    }
    this.controlChannel = undefined;
  }

  private removeSubtitle(): void {
    for (const track of this.video.querySelectorAll("track")) track.remove();
    if (this.subtitleUrl) URL.revokeObjectURL(this.subtitleUrl);
    this.subtitleUrl = undefined;
  }

  private startViewerProgress(): void {
    this.stopViewerProgress();
    const rail = document.getElementById("stage-progress");
    const fill = document.getElementById("progress-fill");
    const thumb = document.getElementById("progress-thumb");
    const timeElement = document.getElementById("dock-time");
    if (!rail || !fill) return;
    rail.removeAttribute("hidden");
    this.progressTimer = window.setInterval(() => {
      const duration = this.video.duration || 0;
      const current = this.video.currentTime || 0;
      if (duration <= 0) return;
      const percent = Math.max(
        0,
        Math.min(100, current / duration * 100),
      );
      fill.style.width = `${percent.toFixed(2)}%`;
      if (thumb) thumb.style.left = `${percent.toFixed(2)}%`;
      rail.setAttribute("aria-valuenow", percent.toFixed(1));
      if (timeElement) {
        timeElement.textContent = `${fmtTime(current)} / ${fmtTime(duration)}`;
      }
    }, 500);
  }

  private stopViewerProgress(): void {
    if (this.progressTimer !== undefined) {
      window.clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }
    if (!this.host) {
      document.getElementById("stage-progress")?.setAttribute("hidden", "");
    }
  }

  private resetMediaSource(): void {
    this.mediaSourceGeneration += 1;
    this.stopViewerProgress();
    if (this.quotaRecoveryTimer !== undefined) {
      window.clearTimeout(this.quotaRecoveryTimer);
      this.quotaRecoveryTimer = undefined;
    }
    this.quotaRecoveryAttempts = 0;
    if (this.mediaSourceOpenTimer !== undefined) {
      window.clearTimeout(this.mediaSourceOpenTimer);
      this.mediaSourceOpenTimer = undefined;
    }
    this.clearAppendWatchdog();
    if (this.initRequestTimer !== undefined) {
      window.clearTimeout(this.initRequestTimer);
      this.initRequestTimer = undefined;
    }
    this.assembler?.reset();
    this.assembler = undefined;
    this.resetPendingMediaReception(true);
    this.receivedInitKey = "";
    this.appendBusy = false;
    this.pendingQuotaRecovery = false;
    this.started = false;
    this.mediaReadySent = false;
    this.endRequested = false;
    this.streamComplete = false;
    this.clearEndBoundary();
    this.invalidPacketCount = 0;
    this.lastHardSeekAt = 0;
    this.lastStartupAnchorAt = 0;
    this.pendingCatchUpTarget = undefined;
    this.syncHeld = false;
    this.awaitingResyncEpoch = undefined;
    if (this.sourceBuffer) {
      try {
        if (this.sourceBuffer.updating) this.sourceBuffer.abort();
      } catch {
        // The MediaSource may already be closed.
      }
    }
    this.sourceBuffer = undefined;
    if (this.mediaSource?.readyState === "open") {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // A replaced stream can close asynchronously.
      }
    }
    this.mediaSource = undefined;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    this.removeSubtitle();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.detachChannel();
    this.detachControlChannel();
    if (this.bufferTimer !== undefined) window.clearInterval(this.bufferTimer);
    if (this.syncTimer !== undefined) window.clearInterval(this.syncTimer);
    if (this.syncRampTimer !== undefined) window.clearTimeout(this.syncRampTimer);
    if (this.speedRestoreTimer !== undefined) {
      window.clearTimeout(this.speedRestoreTimer);
    }
    this.clearStreamTransitionTimer();
    this.video.removeEventListener("timeupdate", this.handleVideoTimeUpdate);
    this.video.removeEventListener("waiting", this.handleVideoWaiting);
    this.video.removeEventListener("error", this.handleVideoError);
    this.stopViewerProgress();
    this.resetMediaSource();
    this.session = undefined;
    this.receivedInitKey = "";
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.controls = false;
    this.video.autoplay = this.originalAutoplay;
    this.video.load();
  }
}
