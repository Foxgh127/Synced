import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  deriveResourceBudget,
  rememberResourceBudget,
  type DeviceResourceState,
  type ResourceBudget,
} from "./resource-budget";

interface DeviceResourcePlugin {
  getState(): Promise<DeviceResourceState>;
}

interface BrowserBattery extends EventTarget {
  charging: boolean;
  level: number;
}

interface NavigatorWithResources extends Navigator {
  deviceMemory?: number;
  getBattery?: () => Promise<BrowserBattery>;
}

const DeviceResource =
  registerPlugin<DeviceResourcePlugin>("DeviceResource");
const RESOURCE_POLL_MS = 15_000;

export class ResourceBudgetMonitor extends EventTarget {
  private timer?: number;
  private battery?: BrowserBattery;
  private started = false;
  private destroyed = false;
  private _budget = deriveResourceBudget();
  private readonly handleBatteryChange = (): void => {
    void this.refresh();
  };

  get budget(): ResourceBudget {
    return { ...this._budget };
  }

  async start(): Promise<void> {
    if (this.destroyed || this.started) return;
    this.started = true;
    const navigatorWithResources = navigator as NavigatorWithResources;
    if (
      !(Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android")
    ) {
      const battery = await navigatorWithResources
        .getBattery?.()
        .catch(() => undefined);
      if (this.destroyed) return;
      this.battery = battery;
      this.battery?.addEventListener(
        "chargingchange",
        this.handleBatteryChange,
      );
      this.battery?.addEventListener("levelchange", this.handleBatteryChange);
    }
    await this.refresh();
    if (this.destroyed) return;
    this.timer = window.setInterval(
      () => void this.refresh(),
      RESOURCE_POLL_MS,
    );
  }

  async refresh(): Promise<ResourceBudget> {
    if (this.destroyed) return { ...this._budget };
    const navigatorWithResources = navigator as NavigatorWithResources;
    let state: DeviceResourceState = {
      batteryLevel: this.battery?.level,
      charging: this.battery?.charging,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigatorWithResources.deviceMemory,
    };
    if (
      Capacitor.isNativePlatform() &&
      Capacitor.getPlatform() === "android"
    ) {
      state = {
        ...state,
        ...(await DeviceResource.getState().catch(() => ({}))),
      };
    }
    if (this.destroyed) return { ...this._budget };
    const next = deriveResourceBudget(state);
    const changed = (
      Object.keys(next) as Array<keyof ResourceBudget>
    ).some((key) => next[key] !== this._budget[key]);
    this._budget = { ...next };
    rememberResourceBudget(next);
    if (changed) {
      this.dispatchEvent(
        new CustomEvent<ResourceBudget>("change", {
          detail: { ...next },
        }),
      );
    }
    return { ...next };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.battery?.removeEventListener(
      "chargingchange",
      this.handleBatteryChange,
    );
    this.battery?.removeEventListener(
      "levelchange",
      this.handleBatteryChange,
    );
    this.battery = undefined;
  }
}
