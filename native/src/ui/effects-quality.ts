import { isNativeAndroid } from "../immersive";
import { ResourceBudgetMonitor } from "../resource-monitor";
import type { ResourcePressure } from "../resource-budget";

export type EffectsPreference = "auto" | "full" | "balanced" | "minimal";
export type EffectsQuality = "full" | "balanced" | "minimal";
export type MotionPreference = "system" | "full" | "reduced";
export type TransparencyPreference = "auto" | "reduced";
export type AmbientPreference = "auto" | "on" | "off";

export interface AppearancePreferences {
  effects: EffectsPreference;
  motion: MotionPreference;
  transparency: TransparencyPreference;
  ambient: AmbientPreference;
  highContrast: boolean;
}

const DEFAULTS: AppearancePreferences = {
  effects: "full",
  motion: "full",
  transparency: "auto",
  ambient: "on",
  highContrast: false,
};
const STORAGE_KEY = "synced:appearance-v3";
export const UI_VERSION = "luminous-3";
type GpuTier = "hardware" | "limited" | "software" | "unknown";

function detectGpuTier(): GpuTier {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2", { powerPreference: "low-power" }) ||
      canvas.getContext("webgl", { powerPreference: "low-power" });
    if (!gl) return "software";
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(
      debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
    ).toLocaleLowerCase("en-US");
    if (
      /swiftshader|llvmpipe|software rasterizer|microsoft basic/u.test(
        renderer,
      )
    ) {
      return "software";
    }
    if (/mali-4|mali-t|adreno \\(tm\\) [234]|powervr sgx/u.test(renderer)) {
      return "limited";
    }
    return renderer ? "hardware" : "unknown";
  } catch {
    return "unknown";
  }
}

function readPreferences(): AppearancePreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      ...DEFAULTS,
      highContrast: parsed.highContrast === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function deriveQuality(
  preference: EffectsPreference,
  pressure: ResourcePressure,
  gpuTier: GpuTier,
): EffectsQuality {
  if (pressure === "critical" || gpuTier === "software") return "minimal";
  if (preference === "minimal") return "minimal";
  if (
    pressure === "constrained" ||
    gpuTier === "limited" ||
    isNativeAndroid() ||
    document.hidden
  ) {
    return "balanced";
  }
  if (preference !== "auto") return preference;
  return "full";
}

export class EffectsQualityController extends EventTarget {
  private preferences = readPreferences();
  private readonly budget = new ResourceBudgetMonitor();
  private pressure: ResourcePressure = "normal";
  private readonly gpuTier = detectGpuTier();
  private readonly controller = new AbortController();
  private appliedReducedMotion?: boolean;
  private reducedMotion = matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  private reducedTransparency = matchMedia(
    "(prefers-reduced-transparency: reduce)",
  );

  get current(): AppearancePreferences {
    return { ...this.preferences };
  }

  async start(): Promise<void> {
    document.documentElement.dataset.uiVersion = UI_VERSION;
    // Apply the full visual profile synchronously so the home star field and
    // first view transition cannot miss their initialization window while
    // resource telemetry is still starting.
    this.apply();
    this.budget.addEventListener(
      "change",
      (event) => {
        this.pressure = (
          event as CustomEvent<{ pressure: ResourcePressure }>
        ).detail.pressure;
        this.apply();
      },
      { signal: this.controller.signal },
    );
    for (const media of [
      this.reducedMotion,
      this.reducedTransparency,
    ]) {
      media.addEventListener("change", () => this.apply(), {
        signal: this.controller.signal,
      });
    }
    document.addEventListener(
      "visibilitychange",
      () => this.apply(),
      { signal: this.controller.signal },
    );
    window.addEventListener(
      "focus",
      () => {
        document.documentElement.dataset.windowActive = "true";
      },
      { signal: this.controller.signal },
    );
    window.addEventListener(
      "blur",
      () => {
        document.documentElement.dataset.windowActive = "false";
      },
      { signal: this.controller.signal },
    );
    const current = await this.budget.start().then(
      () => this.budget.budget,
    );
    this.pressure = current.pressure;
    this.apply();
  }

  update(next: Partial<AppearancePreferences>): void {
    this.preferences = { ...this.preferences, ...next };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.preferences));
    this.apply();
  }

  private apply(): void {
    const root = document.documentElement;
    const quality = deriveQuality(
      this.preferences.effects,
      this.pressure,
      this.gpuTier,
    );
    const reduceMotion =
      this.reducedMotion.matches ||
      this.preferences.motion === "reduced";
    const reduceTransparency =
      this.preferences.transparency === "reduced" ||
      this.reducedTransparency.matches ||
      quality === "minimal";
    root.dataset.effectsQuality = quality;
    root.dataset.gpuTier = this.gpuTier;
    root.dataset.windowActive = String(
      document.hasFocus() && !document.hidden,
    );
    root.dataset.motion = reduceMotion ? "reduced" : "full";
    root.dataset.reduceTransparency = String(reduceTransparency);
    root.dataset.highContrast = String(
      this.preferences.highContrast,
    );
    root.dataset.ambient =
      this.preferences.ambient === "off" ||
      quality === "minimal" ||
      reduceMotion
        ? "off"
        : this.preferences.ambient;
    if (
      this.appliedReducedMotion !== undefined &&
      this.appliedReducedMotion !== reduceMotion
    ) {
      document.dispatchEvent(
        new CustomEvent("synced:motion-preference-change", {
          detail: { reduceMotion },
        }),
      );
    }
    this.appliedReducedMotion = reduceMotion;
    this.dispatchEvent(
      new CustomEvent("change", {
        detail: {
          preferences: this.current,
          quality,
          reduceMotion,
          reduceTransparency,
          pressure: this.pressure,
        },
      }),
    );
  }

  destroy(): void {
    this.controller.abort();
    this.budget.destroy();
  }
}

export const effectsQuality = new EffectsQualityController();
