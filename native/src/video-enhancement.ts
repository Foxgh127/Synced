export type VideoEnhancementPreference = "auto" | "off";
export type VideoEnhancementPlaybackMode = "emby-viewer" | "off";
export type VideoEnhancementPressure =
  | "healthy"
  | "decoder-limited"
  | "render-limited"
  | "encoder-limited";
export type VideoEnhancementBackend =
  | "rtx-video"
  | "webgl2-spatial"
  | "none";

export type VideoEnhancementReason =
  | "active"
  | "preference-off"
  | "not-emby-viewer"
  | "backend-unavailable"
  | "source-not-ready"
  | "source-out-of-range"
  | "output-too-small"
  | "scale-too-small"
  | "hdr-unsupported"
  | "resource-pressure"
  | "render-budget"
  | "dropped-frames"
  | "cooldown";

export interface VideoEnhancementPolicyInput {
  preference: VideoEnhancementPreference;
  playbackMode: VideoEnhancementPlaybackMode;
  backendAvailable: boolean;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  hdr: boolean;
  hdrBackendSupported?: boolean;
  pressure: VideoEnhancementPressure;
  renderP95Ms?: number;
  droppedFrameRatio?: number;
  cooldownUntil?: number;
  now?: number;
}

export interface VideoEnhancementPolicyDecision {
  active: boolean;
  reason: VideoEnhancementReason;
  scale: number;
  sharpness: number;
}

export interface VideoEnhancementCapabilities {
  backends: Array<"webgl2-spatial" | "rtx-video">;
  maxPixels: number;
}

export interface VideoEnhancementHardwareInfo {
  deviceName: string;
  driverVersion: string;
  driverRelease?: number;
  activeGpuIsNvidia: boolean;
  rtxGpu: boolean;
  hardwareVideoDecode: boolean;
  videoDecodeStatus: string;
  rtxVideoSupported: boolean;
  rtxVideoDriverState: "enabled" | "disabled" | "unknown";
  rtxVideoDriverQuality?: number;
  onBatteryPower: boolean;
  error?: string;
}

export interface VideoEnhancementState
  extends VideoEnhancementPolicyDecision {
  backend: VideoEnhancementBackend;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  targetWidth: number;
  targetHeight: number;
  renderP95Ms?: number;
  droppedFrameRatio?: number;
}

export interface VideoEnhancementControllerOptions {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  stage: HTMLElement;
  subtitleLayer: HTMLElement;
  getFitMode?: () => "contain" | "cover" | "smart";
  onDiagnostic?: (event: string, detail: Record<string, unknown>) => void;
}

interface TimerQueryExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

const MAX_OUTPUT_PIXELS = 3_840 * 2_160;
const SOURCE_MIN_HEIGHT = 240;
const SOURCE_MAX_HEIGHT = 1_080;
const MIN_USEFUL_SCALE = 1.22;
const GPU_BUDGET_MS = 22;
const DROP_RATIO_LIMIT = 0.03;
const PRESSURE_COOLDOWN_MS = 30_000;
const METRIC_WINDOW = 90;

let detectedCapabilities: VideoEnhancementCapabilities | undefined;
let detectedHardwareInfo: VideoEnhancementHardwareInfo | undefined;

export function rememberVideoEnhancementHardwareInfo(
  info: VideoEnhancementHardwareInfo,
): void {
  detectedHardwareInfo = { ...info };
  detectedCapabilities = undefined;
}

export function percentile95(values: readonly number[]): number | undefined {
  const finite = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!finite.length) return undefined;
  return finite[Math.max(0, Math.ceil(finite.length * 0.95) - 1)];
}

export function evaluateVideoEnhancementPolicy(
  input: VideoEnhancementPolicyInput,
): VideoEnhancementPolicyDecision {
  const sourceWidth = Math.max(0, input.sourceWidth);
  const sourceHeight = Math.max(0, input.sourceHeight);
  const outputWidth = Math.max(0, input.outputWidth);
  const outputHeight = Math.max(0, input.outputHeight);
  const scale =
    sourceWidth > 0 && sourceHeight > 0
      ? Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight)
      : 0;
  const inactive = (
    reason: Exclude<VideoEnhancementReason, "active">,
  ): VideoEnhancementPolicyDecision => ({
    active: false,
    reason,
    scale,
    sharpness: 0,
  });

  if (input.preference === "off") return inactive("preference-off");
  if (input.playbackMode !== "emby-viewer") {
    return inactive("not-emby-viewer");
  }
  if (!input.backendAvailable) return inactive("backend-unavailable");
  if (!sourceWidth || !sourceHeight) return inactive("source-not-ready");
  if (
    sourceHeight < SOURCE_MIN_HEIGHT ||
    sourceHeight > SOURCE_MAX_HEIGHT
  ) {
    return inactive("source-out-of-range");
  }
  if (!outputWidth || !outputHeight) return inactive("output-too-small");
  if (scale < MIN_USEFUL_SCALE) return inactive("scale-too-small");
  if (input.hdr && input.hdrBackendSupported !== true) {
    return inactive("hdr-unsupported");
  }
  if (input.pressure !== "healthy") return inactive("resource-pressure");
  if (
    input.renderP95Ms !== undefined &&
    input.renderP95Ms > GPU_BUDGET_MS
  ) {
    return inactive("render-budget");
  }
  if (
    input.droppedFrameRatio !== undefined &&
    input.droppedFrameRatio > DROP_RATIO_LIMIT
  ) {
    return inactive("dropped-frames");
  }
  if ((input.cooldownUntil || 0) > (input.now ?? performance.now())) {
    return inactive("cooldown");
  }

  return {
    active: true,
    reason: "active",
    scale,
    // The WebGL fallback combines cubic reconstruction, artifact suppression,
    // directional edge recovery and contrast-adaptive sharpening. RTX Video
    // ignores this value because its trained driver model owns reconstruction.
    sharpness: Math.min(0.6, 0.28 + Math.max(0, scale - 1) * 0.08),
  };
}

export function detectVideoEnhancementCapabilities(): VideoEnhancementCapabilities {
  if (detectedCapabilities) return detectedCapabilities;
  const rtxVideoSupported =
    detectedHardwareInfo?.rtxVideoSupported === true &&
    detectedHardwareInfo.rtxVideoDriverState === "enabled";
  if (typeof document === "undefined") {
    return {
      backends: rtxVideoSupported ? ["rtx-video"] : [],
      maxPixels: rtxVideoSupported ? MAX_OUTPUT_PIXELS : 0,
    };
  }
  const probe = document.createElement("canvas");
  const gl = probe.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    desynchronized: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
    stencil: false,
  });
  if (!gl) {
    detectedCapabilities = {
      backends: rtxVideoSupported ? ["rtx-video"] : [],
      maxPixels: rtxVideoSupported ? MAX_OUTPUT_PIXELS : 0,
    };
    return detectedCapabilities;
  }
  const loseContext = gl.getExtension("WEBGL_lose_context");
  loseContext?.loseContext();
  detectedCapabilities = {
    backends: [
      "webgl2-spatial",
      ...(rtxVideoSupported ? (["rtx-video"] as const) : []),
    ],
    maxPixels: MAX_OUTPUT_PIXELS,
  };
  return detectedCapabilities;
}

function boundedOutputDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  let boundedWidth = Math.max(1, Math.round(width));
  let boundedHeight = Math.max(1, Math.round(height));
  const dimensionScale = Math.min(
    1,
    3_840 / boundedWidth,
    2_160 / boundedHeight,
    Math.sqrt(MAX_OUTPUT_PIXELS / (boundedWidth * boundedHeight)),
  );
  boundedWidth = Math.max(1, Math.round(boundedWidth * dimensionScale));
  boundedHeight = Math.max(1, Math.round(boundedHeight * dimensionScale));
  return { width: boundedWidth, height: boundedHeight };
}

export function target4kDimensions(
  viewportWidth: number,
  viewportHeight: number,
): { width: number; height: number } {
  const safeWidth =
    Number.isFinite(viewportWidth) && viewportWidth > 0
      ? viewportWidth
      : 16;
  const safeHeight =
    Number.isFinite(viewportHeight) && viewportHeight > 0
      ? viewportHeight
      : 9;
  const aspect = Math.max(0.25, Math.min(4, safeWidth / safeHeight));
  let width: number;
  let height: number;
  if (aspect >= 16 / 9) {
    width = 3_840;
    height = width / aspect;
  } else {
    height = 2_160;
    width = height * aspect;
  }
  // Video surfaces and hardware compositors behave best on even dimensions.
  return {
    width: Math.max(2, Math.round(width / 2) * 2),
    height: Math.max(2, Math.round(height / 2) * 2),
  };
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("无法创建视频增强着色器");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) || "未知着色器错误";
    gl.deleteShader(shader);
    throw new Error(detail);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(
    gl,
    gl.VERTEX_SHADER,
    `#version 300 es
      precision highp float;
      out vec2 v_uv;
      void main() {
        vec2 point = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        v_uv = point;
        gl_Position = vec4(point * 2.0 - 1.0, 0.0, 1.0);
      }`,
  );
  const fragment = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    `#version 300 es
      precision highp float;
      uniform sampler2D u_frame;
      uniform vec2 u_texel;
      uniform vec2 u_output_texel;
      uniform float u_sharpness;
      uniform float u_scale;
      in vec2 v_uv;
      out vec4 out_color;

      float luma(vec3 color) {
        return dot(color, vec3(0.2126, 0.7152, 0.0722));
      }

      float catmull_rom(float value) {
        float x = abs(value);
        if (x <= 1.0) {
          return 1.5 * x * x * x - 2.5 * x * x + 1.0;
        }
        if (x < 2.0) {
          return -0.5 * x * x * x + 2.5 * x * x - 4.0 * x + 2.0;
        }
        return 0.0;
      }

      vec3 cubic_reconstruct(vec2 uv) {
        vec2 source_size = 1.0 / u_texel;
        vec2 source_position = uv * source_size - 0.5;
        vec2 source_base = floor(source_position);
        vec2 fraction = fract(source_position);
        vec3 accumulated = vec3(0.0);
        float accumulated_weight = 0.0;
        for (int y = -1; y <= 2; y++) {
          for (int x = -1; x <= 2; x++) {
            float weight =
              catmull_rom(float(x) - fraction.x) *
              catmull_rom(float(y) - fraction.y);
            vec2 coordinate =
              (source_base + vec2(float(x), float(y)) + 0.5) * u_texel;
            accumulated += texture(u_frame, coordinate).rgb * weight;
            accumulated_weight += weight;
          }
        }
        return accumulated / max(accumulated_weight, 0.0001);
      }

      void main() {
        vec3 center = cubic_reconstruct(v_uv);
        vec3 north = texture(u_frame, v_uv - vec2(0.0, u_texel.y)).rgb;
        vec3 south = texture(u_frame, v_uv + vec2(0.0, u_texel.y)).rgb;
        vec3 east = texture(u_frame, v_uv + vec2(u_texel.x, 0.0)).rgb;
        vec3 west = texture(u_frame, v_uv - vec2(u_texel.x, 0.0)).rgb;
        vec3 north_east = texture(u_frame, v_uv + vec2(u_texel.x, -u_texel.y)).rgb;
        vec3 north_west = texture(u_frame, v_uv - u_texel).rgb;
        vec3 south_east = texture(u_frame, v_uv + u_texel).rgb;
        vec3 south_west = texture(u_frame, v_uv + vec2(-u_texel.x, u_texel.y)).rgb;

        float gradient_x =
          luma(north_east) + 2.0 * luma(east) + luma(south_east) -
          luma(north_west) - 2.0 * luma(west) - luma(south_west);
        float gradient_y =
          luma(south_west) + 2.0 * luma(south) + luma(south_east) -
          luma(north_west) - 2.0 * luma(north) - luma(north_east);
        float edge_strength =
          smoothstep(0.025, 0.32, length(vec2(gradient_x, gradient_y)));

        vec3 local_min = min(
          center,
          min(min(north, south), min(east, west))
        );
        vec3 local_max = max(
          center,
          max(max(north, south), max(east, west))
        );
        vec3 cross_average = (north + south + east + west) * 0.25;
        float local_range = luma(local_max) - luma(local_min);

        // Suppress codec block noise only in flat regions. Edges and texture
        // remain owned by the cubic and directional reconstruction.
        float flat_region = 1.0 - smoothstep(0.018, 0.11, local_range);
        float artifact_weight =
          flat_region * smoothstep(1.35, 3.0, u_scale) * 0.18;
        vec3 reconstructed = mix(center, cross_average, artifact_weight);

        vec2 gradient = vec2(gradient_x, gradient_y);
        vec2 tangent =
          length(gradient) > 0.0001
            ? normalize(vec2(-gradient.y, gradient.x))
            : vec2(1.0, 0.0);
        vec2 directional_step = tangent * max(u_output_texel, u_texel * 0.35);
        vec3 along_a = texture(u_frame, v_uv - directional_step).rgb;
        vec3 along_b = texture(u_frame, v_uv + directional_step).rgb;
        vec3 directional_detail =
          reconstructed - (along_a + along_b) * 0.5;
        reconstructed += directional_detail * edge_strength * 0.22;

        vec3 adaptive_detail = reconstructed - cross_average;
        float sharpening =
          u_sharpness * mix(0.48, 1.0, edge_strength) *
          (1.0 - flat_region * 0.35);
        vec3 sharpened = reconstructed + adaptive_detail * sharpening;

        // Anti-ringing clamp allows a tiny reconstruction headroom while
        // preventing bright/dark halos around subtitles and anime line art.
        vec3 bounded = clamp(
          sharpened,
          local_min - vec3(0.018),
          local_max + vec3(0.018)
        );
        float dither =
          fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453)
          - 0.5;
        out_color = vec4(clamp(bounded + dither / 1024.0, 0.0, 1.0), 1.0);
      }`,
  );
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error("无法创建视频增强程序");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(program) || "未知链接错误";
    gl.deleteProgram(program);
    throw new Error(detail);
  }
  return program;
}

function isHdrVideo(video: HTMLVideoElement): boolean {
  const frameConstructor = globalThis.VideoFrame;
  if (!frameConstructor || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return false;
  }
  try {
    const frame = new frameConstructor(video);
    const colorSpace = frame.colorSpace;
    const transfer = String(colorSpace.transfer || "").toLowerCase();
    const primaries = String(colorSpace.primaries || "").toLowerCase();
    frame.close();
    return (
      transfer.includes("pq") ||
      transfer.includes("hlg") ||
      transfer.includes("smpte2084") ||
      primaries.includes("bt2020")
    );
  } catch {
    return false;
  }
}

export class VideoEnhancementController extends EventTarget {
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly stage: HTMLElement;
  private readonly subtitleLayer: HTMLElement;
  private readonly getFitMode: () => "contain" | "cover" | "smart";
  private readonly onDiagnostic?: (
    event: string,
    detail: Record<string, unknown>,
  ) => void;
  private preference: VideoEnhancementPreference = "auto";
  private playbackMode: VideoEnhancementPlaybackMode = "off";
  private pressure: VideoEnhancementPressure = "healthy";
  private webglBackendAvailable =
    detectVideoEnhancementCapabilities().backends.includes(
      "webgl2-spatial",
    );
  private hardwareInfo?: VideoEnhancementHardwareInfo;
  private cooldownUntil = 0;
  private gl?: WebGL2RenderingContext;
  private program?: WebGLProgram;
  private texture?: WebGLTexture;
  private textureWidth = 0;
  private textureHeight = 0;
  private vertexArray?: WebGLVertexArrayObject;
  private timerExtension?: TimerQueryExtension;
  private timerQueries: WebGLQuery[] = [];
  private renderSamples: number[] = [];
  private droppedFrameRatio: number | undefined;
  private previousPlaybackQuality?: {
    total: number;
    dropped: number;
    at: number;
  };
  private resizeObserver?: ResizeObserver;
  private policyTimer?: number;
  private videoFrameCallback?: number;
  private animationFrame?: number;
  private active = false;
  private activeBackend: VideoEnhancementBackend = "none";
  private sharpness = 0;
  private destroyed = false;
  private lastSubtitleText = "";
  private lastDiagnosticAt = 0;
  private state: VideoEnhancementState = {
    active: false,
    reason: "not-emby-viewer",
    scale: 0,
    sharpness: 0,
    backend: "none",
    sourceWidth: 0,
    sourceHeight: 0,
    outputWidth: 0,
    outputHeight: 0,
    targetWidth: 3_840,
    targetHeight: 2_160,
  };

  private readonly handleVideoChange = (): void => {
    this.refresh();
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) {
      this.applyBackend("none");
    } else {
      this.refresh();
    }
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.releaseGraphics(false);
    this.webglBackendAvailable = false;
    if (this.activeBackend === "webgl2-spatial") {
      this.enterCooldown("resource-pressure");
    } else {
      this.refresh();
    }
    this.onDiagnostic?.("video-enhancement-context-lost", {});
  };

  private readonly handleContextRestored = (): void => {
    this.webglBackendAvailable = true;
    this.cooldownUntil = performance.now() + 5_000;
    this.refresh();
  };

  constructor(options: VideoEnhancementControllerOptions) {
    super();
    this.video = options.video;
    this.canvas = options.canvas;
    this.stage = options.stage;
    this.subtitleLayer = options.subtitleLayer;
    this.getFitMode = options.getFitMode || (() => "contain");
    this.onDiagnostic = options.onDiagnostic;
    this.canvas.hidden = true;
    this.subtitleLayer.hidden = true;
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.addEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );
    for (const event of [
      "loadeddata",
      "loadedmetadata",
      "resize",
      "playing",
      "emptied",
    ]) {
      this.video.addEventListener(event, this.handleVideoChange);
    }
    document.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.refresh());
      this.resizeObserver.observe(this.stage);
    }
    this.policyTimer = window.setInterval(() => this.refresh(), 2_000);
  }

  get currentState(): Readonly<VideoEnhancementState> {
    return this.state;
  }

  setHardwareInfo(info: VideoEnhancementHardwareInfo): void {
    const previous = this.hardwareInfo;
    this.hardwareInfo = { ...info };
    rememberVideoEnhancementHardwareInfo(info);
    if (
      previous?.rtxVideoSupported !== info.rtxVideoSupported ||
      previous?.rtxVideoDriverState !== info.rtxVideoDriverState ||
      previous?.onBatteryPower !== info.onBatteryPower ||
      previous?.deviceName !== info.deviceName ||
      previous?.driverVersion !== info.driverVersion
    ) {
      this.onDiagnostic?.("video-enhancement-hardware", {
        deviceName: info.deviceName,
        driverVersion: info.driverVersion,
        driverRelease: info.driverRelease,
        rtxGpu: info.rtxGpu,
        activeGpuIsNvidia: info.activeGpuIsNvidia,
        hardwareVideoDecode: info.hardwareVideoDecode,
        rtxVideoSupported: info.rtxVideoSupported,
        rtxVideoDriverState: info.rtxVideoDriverState,
        rtxVideoDriverQuality: info.rtxVideoDriverQuality,
        onBatteryPower: info.onBatteryPower,
      });
      this.cooldownUntil = 0;
      this.resetMetrics();
      this.refresh();
    }
  }

  setPreference(preference: VideoEnhancementPreference): void {
    if (this.preference === preference) return;
    this.preference = preference;
    this.cooldownUntil = 0;
    this.resetMetrics();
    this.refresh();
  }

  setPlaybackMode(mode: VideoEnhancementPlaybackMode): void {
    if (this.playbackMode === mode) return;
    this.playbackMode = mode;
    this.cooldownUntil = 0;
    this.resetMetrics();
    this.refresh();
  }

  setPressure(pressure: VideoEnhancementPressure): void {
    if (this.pressure === pressure) return;
    this.pressure = pressure;
    if (pressure !== "healthy") {
      this.enterCooldown("resource-pressure");
    } else {
      this.refresh();
    }
  }

  refresh(): void {
    if (this.destroyed) return;
    this.samplePlaybackQuality();
    const rect = this.stage.getBoundingClientRect();
    const pixelRatio = Math.max(
      1,
      Math.min(2.5, globalThis.devicePixelRatio || 1),
    );
    const displayOutput = boundedOutputDimensions(
      rect.width * pixelRatio,
      rect.height * pixelRatio,
    );
    const target4k = target4kDimensions(rect.width, rect.height);
    const renderP95Ms =
      this.renderSamples.length >= 30
        ? percentile95(this.renderSamples)
        : undefined;
    const hardware = this.hardwareInfo;
    const rtxReady = Boolean(
      hardware?.rtxVideoSupported &&
        hardware.rtxVideoDriverState === "enabled" &&
        !hardware.onBatteryPower,
    );
    const effectivePressure: VideoEnhancementPressure =
      hardware?.onBatteryPower === true ? "render-limited" : this.pressure;
    const commonPolicy = {
      preference: this.preference,
      playbackMode: this.playbackMode,
      sourceWidth: this.video.videoWidth,
      sourceHeight: this.video.videoHeight,
      hdr: isHdrVideo(this.video),
      pressure: effectivePressure,
      droppedFrameRatio: this.droppedFrameRatio,
      cooldownUntil: this.cooldownUntil,
    };
    const rtxDecision = evaluateVideoEnhancementPolicy({
      ...commonPolicy,
      backendAvailable: rtxReady,
      outputWidth: displayOutput.width,
      outputHeight: displayOutput.height,
      hdrBackendSupported: true,
    });
    const webglDecision = evaluateVideoEnhancementPolicy({
      ...commonPolicy,
      backendAvailable: this.webglBackendAvailable,
      outputWidth: target4k.width,
      outputHeight: target4k.height,
      hdrBackendSupported: false,
      renderP95Ms,
    });
    let decision = webglDecision;
    let desiredBackend: VideoEnhancementBackend = webglDecision.active
      ? "webgl2-spatial"
      : "none";
    let desiredOutput = target4k;

    // RTX Video runs inside Chromium's native D3D11 video-processor path and
    // keeps decoded frames on the GPU. It must win whenever the visible
    // viewport is actually being enlarged. When the viewport is too small to
    // trigger driver scaling, the 4K WebGL path remains useful as an internal
    // reconstruction target and is downsampled once by the compositor.
    if (rtxDecision.active) {
      decision = rtxDecision;
      desiredBackend = "rtx-video";
      desiredOutput = displayOutput;
    } else if (
      rtxReady &&
      rtxDecision.reason !== "scale-too-small" &&
      rtxDecision.reason !== "output-too-small"
    ) {
      decision = rtxDecision;
      desiredBackend = "none";
      desiredOutput = displayOutput;
    }

    if (
      decision.reason === "render-budget" ||
      decision.reason === "dropped-frames"
    ) {
      this.enterCooldown(decision.reason);
      return;
    }

    if (
      desiredBackend === "webgl2-spatial" &&
      decision.active &&
      !this.ensureGraphics()
    ) {
      this.webglBackendAvailable = false;
      this.applyBackend("none");
      this.commitState({
        ...decision,
        active: false,
        reason: "backend-unavailable",
        backend: "none",
        sourceWidth: this.video.videoWidth,
        sourceHeight: this.video.videoHeight,
        outputWidth: desiredOutput.width,
        outputHeight: desiredOutput.height,
        targetWidth: target4k.width,
        targetHeight: target4k.height,
        renderP95Ms,
        droppedFrameRatio: this.droppedFrameRatio,
      });
      return;
    }

    if (
      decision.active &&
      desiredBackend === "webgl2-spatial" &&
      (this.canvas.width !== desiredOutput.width ||
        this.canvas.height !== desiredOutput.height)
    ) {
      this.canvas.width = desiredOutput.width;
      this.canvas.height = desiredOutput.height;
    }
    this.sharpness = decision.sharpness;
    const visibleBackend =
      decision.active && !document.hidden ? desiredBackend : "none";
    this.applyBackend(visibleBackend);
    this.commitState({
      ...decision,
      active: visibleBackend !== "none",
      backend: visibleBackend,
      sourceWidth: this.video.videoWidth,
      sourceHeight: this.video.videoHeight,
      outputWidth: desiredOutput.width,
      outputHeight: desiredOutput.height,
      targetWidth: target4k.width,
      targetHeight: target4k.height,
      renderP95Ms,
      droppedFrameRatio: this.droppedFrameRatio,
    });
    this.reportMetrics();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.applyBackend("none");
    if (this.policyTimer !== undefined) {
      window.clearInterval(this.policyTimer);
      this.policyTimer = undefined;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    for (const event of [
      "loadeddata",
      "loadedmetadata",
      "resize",
      "playing",
      "emptied",
    ]) {
      this.video.removeEventListener(event, this.handleVideoChange);
    }
    this.canvas.removeEventListener(
      "webglcontextlost",
      this.handleContextLost,
    );
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );
    this.releaseGraphics(true);
    this.stage.classList.remove("video-enhancement-active");
    this.stage.classList.remove("video-enhancement-rtx-active");
    delete this.stage.dataset.videoEnhancementBackend;
    this.canvas.hidden = true;
    this.subtitleLayer.hidden = true;
  }

  private ensureGraphics(): boolean {
    if (this.gl && this.program && this.texture && this.vertexArray) {
      return true;
    }
    try {
      const gl = this.canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        desynchronized: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
        stencil: false,
      });
      if (!gl) return false;
      const program = createProgram(gl);
      const texture = gl.createTexture();
      const vertexArray = gl.createVertexArray();
      if (!texture || !vertexArray) {
        gl.deleteProgram(program);
        if (texture) gl.deleteTexture(texture);
        if (vertexArray) gl.deleteVertexArray(vertexArray);
        return false;
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.bindVertexArray(vertexArray);
      gl.useProgram(program);
      const frameLocation = gl.getUniformLocation(program, "u_frame");
      gl.uniform1i(frameLocation, 0);
      this.gl = gl;
      this.program = program;
      this.texture = texture;
      this.vertexArray = vertexArray;
      this.timerExtension =
        (gl.getExtension(
          "EXT_disjoint_timer_query_webgl2",
        ) as TimerQueryExtension | null) || undefined;
      this.onDiagnostic?.("video-enhancement-backend-ready", {
        backend: "webgl2-spatial",
        gpuTimer: Boolean(this.timerExtension),
      });
      return true;
    } catch (error) {
      this.onDiagnostic?.("video-enhancement-backend-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.releaseGraphics(true);
      return false;
    }
  }

  private releaseGraphics(deleteResources: boolean): void {
    const gl = this.gl;
    if (gl && deleteResources) {
      for (const query of this.timerQueries) gl.deleteQuery(query);
      if (this.texture) gl.deleteTexture(this.texture);
      if (this.vertexArray) gl.deleteVertexArray(this.vertexArray);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.timerQueries = [];
    this.timerExtension = undefined;
    this.texture = undefined;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.vertexArray = undefined;
    this.program = undefined;
    this.gl = undefined;
  }

  private applyBackend(backend: VideoEnhancementBackend): void {
    if (this.activeBackend === backend) {
      if (backend === "webgl2-spatial") this.renderFrame();
      return;
    }
    this.cancelFrame();
    this.stage.classList.remove(
      "video-enhancement-active",
      "video-enhancement-rtx-active",
    );
    this.canvas.hidden = true;
    this.subtitleLayer.hidden = true;
    this.lastSubtitleText = "";
    this.activeBackend = backend;
    this.active = backend !== "none";
    if (backend === "webgl2-spatial") {
      this.stage.dataset.videoEnhancementBackend = backend;
      // Draw the already-decoded frame immediately. This prevents a paused
      // movie from turning black while requestVideoFrameCallback waits for a
      // future presentation.
      this.renderFrame();
      this.scheduleFrame();
      return;
    }
    if (backend === "rtx-video") {
      // A WebGL canvas would force Chromium to copy the decoded frame out of
      // the native video overlay, preventing the NVIDIA D3D11 VP extension
      // from running. Tear it down and leave the <video> surface untouched.
      this.releaseGraphics(true);
      this.stage.dataset.videoEnhancementBackend = backend;
      this.stage.classList.add("video-enhancement-rtx-active");
      return;
    }
    delete this.stage.dataset.videoEnhancementBackend;
  }

  private scheduleFrame(): void {
    if (
      !this.active ||
      this.activeBackend !== "webgl2-spatial" ||
      this.destroyed
    ) {
      return;
    }
    if (typeof this.video.requestVideoFrameCallback === "function") {
      if (this.videoFrameCallback !== undefined) return;
      this.videoFrameCallback = this.video.requestVideoFrameCallback(() => {
        this.videoFrameCallback = undefined;
        this.renderFrame();
        this.scheduleFrame();
      });
      return;
    }
    if (this.animationFrame !== undefined) return;
    this.animationFrame = window.requestAnimationFrame(() => {
      this.animationFrame = undefined;
      this.renderFrame();
      this.scheduleFrame();
    });
  }

  private cancelFrame(): void {
    if (this.videoFrameCallback !== undefined) {
      this.video.cancelVideoFrameCallback(this.videoFrameCallback);
      this.videoFrameCallback = undefined;
    }
    if (this.animationFrame !== undefined) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = undefined;
    }
  }

  private renderFrame(): void {
    const gl = this.gl;
    const program = this.program;
    const texture = this.texture;
    const vertexArray = this.vertexArray;
    if (
      !this.active ||
      this.activeBackend !== "webgl2-spatial" ||
      !gl ||
      !program ||
      !texture ||
      !vertexArray ||
      this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !this.video.videoWidth ||
      !this.video.videoHeight
    ) {
      return;
    }
    this.pollTimerQueries();
    const startedAt = performance.now();
    let timerQuery: WebGLQuery | undefined;
    try {
      if (this.timerExtension && this.timerQueries.length < 6) {
        timerQuery = gl.createQuery() || undefined;
        if (timerQuery) {
          gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, timerQuery);
        }
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (
        this.textureWidth !== this.video.videoWidth ||
        this.textureHeight !== this.video.videoHeight
      ) {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          this.video,
        );
        this.textureWidth = this.video.videoWidth;
        this.textureHeight = this.video.videoHeight;
      } else {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          this.video,
        );
      }
      gl.useProgram(program);
      gl.bindVertexArray(vertexArray);
      gl.uniform2f(
        gl.getUniformLocation(program, "u_texel"),
        1 / this.video.videoWidth,
        1 / this.video.videoHeight,
      );
      gl.uniform2f(
        gl.getUniformLocation(program, "u_output_texel"),
        1 / this.canvas.width,
        1 / this.canvas.height,
      );
      gl.uniform1f(
        gl.getUniformLocation(program, "u_sharpness"),
        this.sharpness,
      );
      gl.uniform1f(
        gl.getUniformLocation(program, "u_scale"),
        Math.min(
          this.canvas.width / this.video.videoWidth,
          this.canvas.height / this.video.videoHeight,
        ),
      );
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 1);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.applyVideoViewport(gl);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (timerQuery && this.timerExtension) {
        gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
        this.timerQueries.push(timerQuery);
        timerQuery = undefined;
      }
      if (!this.timerExtension) {
        this.pushRenderSample(performance.now() - startedAt);
      }
      if (
        this.active &&
        this.activeBackend === "webgl2-spatial"
      ) {
        this.canvas.hidden = false;
        this.stage.classList.add("video-enhancement-active");
      }
      this.renderSubtitles();
    } catch (error) {
      if (timerQuery && this.timerExtension) {
        try {
          gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
        } catch {
          // The context may have been lost while uploading the frame.
        }
        gl.deleteQuery(timerQuery);
      }
      this.webglBackendAvailable = false;
      this.onDiagnostic?.("video-enhancement-render-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.enterCooldown("resource-pressure");
    }
  }

  private applyVideoViewport(gl: WebGL2RenderingContext): void {
    const sourceAspect = this.video.videoWidth / this.video.videoHeight;
    const outputAspect = this.canvas.width / this.canvas.height;
    const fitMode = this.getFitMode();
    const cover = fitMode === "cover";
    let width = this.canvas.width;
    let height = this.canvas.height;
    if ((sourceAspect > outputAspect) !== cover) {
      height = width / sourceAspect;
    } else {
      width = height * sourceAspect;
    }
    gl.viewport(
      Math.round((this.canvas.width - width) / 2),
      Math.round((this.canvas.height - height) / 2),
      Math.round(width),
      Math.round(height),
    );
  }

  private pollTimerQueries(): void {
    const gl = this.gl;
    const extension = this.timerExtension;
    if (!gl || !extension || !this.timerQueries.length) return;
    if (gl.getParameter(extension.GPU_DISJOINT_EXT) === true) {
      for (const query of this.timerQueries) gl.deleteQuery(query);
      this.timerQueries = [];
      return;
    }
    while (this.timerQueries.length) {
      const query = this.timerQueries[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const elapsedNanoseconds = Number(
        gl.getQueryParameter(query, gl.QUERY_RESULT),
      );
      this.timerQueries.shift();
      gl.deleteQuery(query);
      if (Number.isFinite(elapsedNanoseconds)) {
        this.pushRenderSample(elapsedNanoseconds / 1_000_000);
      }
    }
  }

  private pushRenderSample(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.renderSamples.push(durationMs);
    if (this.renderSamples.length > METRIC_WINDOW) {
      this.renderSamples.splice(0, this.renderSamples.length - METRIC_WINDOW);
    }
  }

  private samplePlaybackQuality(): void {
    if (typeof this.video.getVideoPlaybackQuality !== "function") return;
    const quality = this.video.getVideoPlaybackQuality();
    const now = performance.now();
    const previous = this.previousPlaybackQuality;
    if (
      previous &&
      now - previous.at >= 1_500 &&
      quality.totalVideoFrames >= previous.total &&
      quality.droppedVideoFrames >= previous.dropped
    ) {
      const totalDelta = quality.totalVideoFrames - previous.total;
      const droppedDelta = quality.droppedVideoFrames - previous.dropped;
      if (totalDelta >= 30) {
        this.droppedFrameRatio = droppedDelta / totalDelta;
      }
    }
    if (!previous || now - previous.at >= 1_500) {
      this.previousPlaybackQuality = {
        total: quality.totalVideoFrames,
        dropped: quality.droppedVideoFrames,
        at: now,
      };
    }
  }

  private renderSubtitles(): void {
    const lines: string[] = [];
    for (const track of Array.from(this.video.textTracks || [])) {
      if (track.mode === "disabled" || !track.activeCues) continue;
      for (const cue of Array.from(track.activeCues)) {
        const text = "text" in cue ? String(cue.text || "").trim() : "";
        if (text) lines.push(text.replace(/<[^>]+>/g, ""));
      }
    }
    const text = lines.join("\n");
    if (text === this.lastSubtitleText) return;
    this.lastSubtitleText = text;
    this.subtitleLayer.textContent = text;
    this.subtitleLayer.hidden = !text;
  }

  private enterCooldown(
    reason: "resource-pressure" | "render-budget" | "dropped-frames",
  ): void {
    const renderP95Ms = percentile95(this.renderSamples);
    this.cooldownUntil = performance.now() + PRESSURE_COOLDOWN_MS;
    const previousBackend = this.activeBackend;
    this.applyBackend("none");
    const rect = this.stage.getBoundingClientRect();
    const pixelRatio = Math.max(
      1,
      Math.min(2.5, globalThis.devicePixelRatio || 1),
    );
    const displayOutput = boundedOutputDimensions(
      rect.width * pixelRatio,
      rect.height * pixelRatio,
    );
    const target4k = target4kDimensions(rect.width, rect.height);
    const output =
      previousBackend === "rtx-video" ? displayOutput : target4k;
    this.commitState({
      active: false,
      reason,
      scale:
        this.video.videoWidth > 0 && this.video.videoHeight > 0
          ? Math.min(
              output.width / this.video.videoWidth,
              output.height / this.video.videoHeight,
            )
          : 0,
      sharpness: 0,
      backend: "none",
      sourceWidth: this.video.videoWidth,
      sourceHeight: this.video.videoHeight,
      outputWidth: output.width,
      outputHeight: output.height,
      targetWidth: target4k.width,
      targetHeight: target4k.height,
      renderP95Ms,
      droppedFrameRatio: this.droppedFrameRatio,
    });
    this.onDiagnostic?.("video-enhancement-auto-disabled", {
      reason,
      renderP95Ms,
      droppedFrameRatio: this.droppedFrameRatio,
      cooldownMs: PRESSURE_COOLDOWN_MS,
    });
    this.resetMetrics();
  }

  private resetMetrics(): void {
    this.renderSamples = [];
    this.droppedFrameRatio = undefined;
    this.previousPlaybackQuality = undefined;
  }

  private commitState(next: VideoEnhancementState): void {
    const changed =
      next.active !== this.state.active ||
      next.reason !== this.state.reason ||
      next.backend !== this.state.backend ||
      next.sourceWidth !== this.state.sourceWidth ||
      next.sourceHeight !== this.state.sourceHeight ||
      next.outputWidth !== this.state.outputWidth ||
      next.outputHeight !== this.state.outputHeight ||
      next.targetWidth !== this.state.targetWidth ||
      next.targetHeight !== this.state.targetHeight;
    this.state = next;
    if (changed) {
      this.dispatchEvent(
        new CustomEvent<VideoEnhancementState>("statechange", {
          detail: next,
        }),
      );
    }
  }

  private reportMetrics(): void {
    if (!this.active) return;
    const now = performance.now();
    if (now - this.lastDiagnosticAt < 5_000) return;
    this.lastDiagnosticAt = now;
    this.onDiagnostic?.("video-enhancement-metrics", {
      backend: this.activeBackend,
      source: `${this.video.videoWidth}x${this.video.videoHeight}`,
      output:
        this.activeBackend === "webgl2-spatial"
          ? `${this.canvas.width}x${this.canvas.height}`
          : `${this.state.outputWidth}x${this.state.outputHeight}`,
      target: `${this.state.targetWidth}x${this.state.targetHeight}`,
      renderP95Ms: percentile95(this.renderSamples),
      droppedFrameRatio: this.droppedFrameRatio,
    });
  }
}
