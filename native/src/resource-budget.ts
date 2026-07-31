export type ResourcePressure = "normal" | "constrained" | "critical";

export interface DeviceResourceState {
  batteryLevel?: number;
  charging?: boolean;
  powerSaveMode?: boolean;
  deviceIdleMode?: boolean;
  thermalStatus?: number;
  thermalState?: string;
  interactive?: boolean;
  hardwareConcurrency?: number;
  deviceMemoryGiB?: number;
}

export interface ResourceBudget {
  pressure: ResourcePressure;
  reason: string;
  allowGpuEnhancement: boolean;
  allowDeepPrefetch: boolean;
  allowNeuralVoiceProcessing: boolean;
  maxConcurrentProducers: number;
  maxSfuLayers: number;
  maxP2pFallbacks: number;
}

const NORMAL_BUDGET: ResourceBudget = {
  pressure: "normal",
  reason: "资源余量正常",
  allowGpuEnhancement: true,
  allowDeepPrefetch: true,
  allowNeuralVoiceProcessing: true,
  maxConcurrentProducers: 3,
  maxSfuLayers: 3,
  maxP2pFallbacks: 2,
};

function finiteRatio(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(0, Math.min(1, number))
    : undefined;
}

export function deriveResourceBudget(
  state: DeviceResourceState = {},
): ResourceBudget {
  const battery = finiteRatio(state.batteryLevel);
  const charging = state.charging === true;
  const thermal = Number(state.thermalStatus);
  const memory = Number(state.deviceMemoryGiB);
  const cores = Number(state.hardwareConcurrency);
  const critical =
    (Number.isFinite(thermal) && thermal >= 3) ||
    (!charging && battery !== undefined && battery <= 0.08) ||
    (state.powerSaveMode === true &&
      !charging &&
      battery !== undefined &&
      battery <= 0.15);
  if (critical) {
    return {
      pressure: "critical",
      reason:
        Number.isFinite(thermal) && thermal >= 3
          ? `设备温度压力：${state.thermalState || thermal}`
          : "低电量或省电模式",
      allowGpuEnhancement: false,
      allowDeepPrefetch: false,
      allowNeuralVoiceProcessing: false,
      // Keep the host preview plus one baseline CMAF rendition alive. All
      // optional renditions are denied under critical pressure.
      maxConcurrentProducers: 2,
      maxSfuLayers: 1,
      maxP2pFallbacks: 0,
    };
  }

  const constrained =
    (Number.isFinite(thermal) && thermal >= 2) ||
    state.powerSaveMode === true ||
    state.deviceIdleMode === true ||
    state.interactive === false ||
    (!charging && battery !== undefined && battery <= 0.25) ||
    (Number.isFinite(memory) && memory > 0 && memory <= 4) ||
    (Number.isFinite(cores) && cores > 0 && cores <= 4);
  if (constrained) {
    return {
      pressure: "constrained",
      reason:
        state.powerSaveMode === true
          ? "系统省电模式"
          : state.interactive === false
            ? "设备屏幕关闭或应用处于后台"
            : Number.isFinite(thermal) && thermal >= 2
              ? `设备温度偏高：${state.thermalState || thermal}`
              : "设备电量或计算资源有限",
      allowGpuEnhancement: false,
      allowDeepPrefetch: false,
      allowNeuralVoiceProcessing: false,
      maxConcurrentProducers: 2,
      maxSfuLayers: 2,
      maxP2pFallbacks: 1,
    };
  }
  return { ...NORMAL_BUDGET };
}

let latestBudget: ResourceBudget = { ...NORMAL_BUDGET };
const budgetListeners = new Set<(budget: ResourceBudget) => void>();

export function currentResourceBudget(): ResourceBudget {
  return { ...latestBudget };
}

export function rememberResourceBudget(budget: ResourceBudget): void {
  const changed = (
    Object.keys(budget) as Array<keyof ResourceBudget>
  ).some((key) => budget[key] !== latestBudget[key]);
  latestBudget = { ...budget };
  if (!changed) return;
  for (const listener of budgetListeners) {
    try {
      listener({ ...latestBudget });
    } catch {
      // One consumer must not stop resource arbitration for other modules.
    }
  }
}

export function listenForResourceBudgetChanges(
  listener: (budget: ResourceBudget) => void,
): () => void {
  budgetListeners.add(listener);
  return () => budgetListeners.delete(listener);
}
