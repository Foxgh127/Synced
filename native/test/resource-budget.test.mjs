import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = build({
      entryPoints: [path.resolve("src/resource-budget.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    }).then(({ outputFiles }) =>
      import(
        `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
      ),
    );
  }
  return modulePromise;
}

test("normal devices keep the optional media budget enabled", async () => {
  const { deriveResourceBudget } = await loadModule();
  const budget = deriveResourceBudget({
    batteryLevel: 0.8,
    charging: true,
    thermalStatus: 0,
    hardwareConcurrency: 8,
    deviceMemoryGiB: 8,
  });
  assert.equal(budget.pressure, "normal");
  assert.equal(budget.allowGpuEnhancement, true);
  assert.equal(budget.allowDeepPrefetch, true);
  assert.equal(budget.allowNeuralVoiceProcessing, true);
  assert.equal(budget.maxConcurrentProducers, 3);
  assert.equal(budget.maxSfuLayers, 3);
});

test("moderate thermal, power-save and small devices constrain optional work", async () => {
  const { deriveResourceBudget } = await loadModule();
  for (const state of [
    { thermalStatus: 2, charging: true },
    { powerSaveMode: true, batteryLevel: 0.7 },
    { interactive: false },
    { hardwareConcurrency: 4, deviceMemoryGiB: 8 },
    { hardwareConcurrency: 8, deviceMemoryGiB: 4 },
  ]) {
    const budget = deriveResourceBudget(state);
    assert.equal(budget.pressure, "constrained");
    assert.equal(budget.allowGpuEnhancement, false);
    assert.equal(budget.allowDeepPrefetch, false);
    assert.equal(budget.allowNeuralVoiceProcessing, false);
    assert.equal(budget.maxSfuLayers, 2);
    assert.equal(budget.maxP2pFallbacks, 1);
  }
});

test("severe thermal or low battery rejects non-essential producers", async () => {
  const { deriveResourceBudget } = await loadModule();
  for (const state of [
    { thermalStatus: 3, charging: true },
    { batteryLevel: 0.08, charging: false },
    {
      batteryLevel: 0.14,
      charging: false,
      powerSaveMode: true,
    },
  ]) {
    const budget = deriveResourceBudget(state);
    assert.equal(budget.pressure, "critical");
    assert.equal(budget.allowGpuEnhancement, false);
    assert.equal(budget.allowDeepPrefetch, false);
    assert.equal(budget.allowNeuralVoiceProcessing, false);
    assert.equal(budget.maxConcurrentProducers, 2);
    assert.equal(budget.maxSfuLayers, 1);
    assert.equal(budget.maxP2pFallbacks, 0);
  }
});

test("the shared budget snapshot cannot be mutated by callers", async () => {
  const {
    currentResourceBudget,
    deriveResourceBudget,
    rememberResourceBudget,
  } = await loadModule();
  const critical = deriveResourceBudget({ thermalStatus: 4 });
  rememberResourceBudget(critical);
  critical.pressure = "normal";
  const snapshot = currentResourceBudget();
  snapshot.pressure = "normal";
  assert.equal(currentResourceBudget().pressure, "critical");
});

test("resource consumers receive only real budget changes", async () => {
  const {
    deriveResourceBudget,
    listenForResourceBudgetChanges,
    rememberResourceBudget,
  } = await loadModule();
  const observed = [];
  const remove = listenForResourceBudgetChanges((budget) => {
    observed.push(budget.pressure);
  });
  const normal = deriveResourceBudget({ batteryLevel: 0.9, charging: true });
  rememberResourceBudget(normal);
  rememberResourceBudget(normal);
  assert.deepEqual(observed, ["normal"]);
  remove();
  rememberResourceBudget(deriveResourceBudget({ thermalStatus: 4 }));
  assert.deepEqual(observed, ["normal"]);
});

test("the room budget controls real SFU and CMAF producer admission", () => {
  const channel = readFileSync(
    new URL("../src/channel-session.ts", import.meta.url),
    "utf8",
  );
  const sfu = readFileSync(
    new URL("../src/sfu.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    channel,
    /maxLayers: resourceBudget\.maxSfuLayers/,
  );
  assert.match(
    channel,
    /resourceBudget\.maxConcurrentProducers,[\s\S]{0,100}?broadcastCapabilities\?\.maxActiveRenditions/,
  );
  assert.match(channel, /layers=\$\{resourceBudget\.maxSfuLayers\}/);
  assert.match(sfu, /simulcast: maxLayers > 1/);
  assert.match(
    sfu,
    /candidateLayers\.slice\([\s\S]{0,100}?maxLayers - 1/,
  );
});
