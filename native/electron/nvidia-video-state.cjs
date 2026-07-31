const fs = require("fs");
const path = require("path");

const MAX_LOG_BYTES = 768 * 1024;
const DEFAULT_CONFIRMATION_AGE_MS = 24 * 60 * 60 * 1000;

function parseNvidiaVsrState(
  text,
  {
    now = Date.now(),
    maxAgeMs = DEFAULT_CONFIRMATION_AGE_MS,
  } = {},
) {
  const pattern =
    /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}).*?VSR state fetched:\s*(\{[\s\S]*?^\})/gm;
  let latest;
  for (const match of String(text || "").matchAll(pattern)) {
    try {
      const state = JSON.parse(match[2]);
      const observedAt = new Date(match[1].replace(" ", "T")).getTime();
      if (
        typeof state?.isEnabled !== "boolean" ||
        !Number.isFinite(observedAt)
      ) {
        continue;
      }
      if (!latest || observedAt > latest.observedAt) {
        latest = {
          enabled: state.isEnabled,
          active:
            typeof state.isActive === "boolean" ? state.isActive : undefined,
          quality: Number.isFinite(state.quality)
            ? Number(state.quality)
            : undefined,
          observedAt,
        };
      }
    } catch {
      // NVIDIA can rotate the log while it is being read. Ignore an incomplete
      // trailing block and keep the last complete observation.
    }
  }
  if (!latest) {
    return { state: "unknown" };
  }
  const ageMs = now - latest.observedAt;
  if (ageMs < -5 * 60 * 1000 || ageMs > maxAgeMs) {
    return {
      state: "unknown",
      observedAt: latest.observedAt,
    };
  }
  return {
    state: latest.enabled ? "enabled" : "disabled",
    enabled: latest.enabled,
    active: latest.active,
    quality: latest.quality,
    observedAt: latest.observedAt,
  };
}

function readFileTail(filePath, maxBytes = MAX_LOG_BYTES) {
  const stat = fs.statSync(filePath);
  const byteLength = Math.min(stat.size, maxBytes);
  const buffer = Buffer.allocUnsafe(byteLength);
  const file = fs.openSync(filePath, "r");
  try {
    fs.readSync(file, buffer, 0, byteLength, stat.size - byteLength);
  } finally {
    fs.closeSync(file);
  }
  return buffer.toString("utf8");
}

function readNvidiaVsrState({
  localAppData = process.env.LOCALAPPDATA,
  now = Date.now(),
  maxAgeMs = DEFAULT_CONFIRMATION_AGE_MS,
} = {}) {
  if (!localAppData) return { state: "unknown" };
  const logDirectory = path.join(
    localAppData,
    "NVIDIA Corporation",
    "NVIDIA App",
  );
  const candidates = ["console.log", "console.log.bak"]
    .map((name) => path.join(logDirectory, name))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    });
  let latest = { state: "unknown" };
  for (const filePath of candidates) {
    try {
      const parsed = parseNvidiaVsrState(readFileTail(filePath), {
        now,
        maxAgeMs,
      });
      if (
        parsed.observedAt !== undefined &&
        (latest.observedAt === undefined ||
          parsed.observedAt > latest.observedAt)
      ) {
        latest = parsed;
      }
    } catch {
      // NVIDIA App is optional and may hold or rotate its log. An unreadable
      // status must select the deterministic GPU fallback, never fake RTX.
    }
  }
  return latest;
}

module.exports = {
  DEFAULT_CONFIRMATION_AGE_MS,
  parseNvidiaVsrState,
  readNvidiaVsrState,
};
