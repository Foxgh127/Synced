import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(".");
const appDirectory = path.join(
  projectRoot,
  "release",
  "windows-dist",
  "win-unpacked",
);
if (!existsSync(path.join(appDirectory, "同频.exe"))) {
  console.error("缺少 win-unpacked，请先运行 electron-builder --win dir --x64");
  process.exit(1);
}

const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const version = String(packageJson.version);
const outputFile = path.join(
  projectRoot,
  "release",
  "windows-dist",
  `Synced-${version}-portable.exe`,
);
const appIcon = path.join(projectRoot, "build", "icon.ico");
if (!existsSync(appIcon)) {
  console.error("缺少 Windows 应用图标：build/icon.ico");
  process.exit(1);
}
const appArchive = path.join(appDirectory, "resources", "app.asar");
const cacheId = `${version}-${createHash("sha256")
  .update(readFileSync(appArchive))
  .digest("hex")
  .slice(0, 12)}`;

function findFile(root, fileName) {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return candidate;
    }
    if (entry.isDirectory()) {
      const nested = findFile(candidate, fileName);
      if (nested) return nested;
    }
  }
  return undefined;
}

const cacheRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "electron-builder",
  "Cache",
);
const makeNsis =
  findFile(cacheRoot, "makensis.exe") ||
  findFile(path.join(projectRoot, "node_modules"), "makensis.exe");
if (!makeNsis) {
  console.error("找不到 electron-builder 自带的 makensis.exe");
  process.exit(1);
}

const result = spawnSync(
  makeNsis,
  [
    "/INPUTCHARSET",
    "UTF8",
    `/DAPP_DIR=${appDirectory}`,
    `/DOUTPUT_FILE=${outputFile}`,
    `/DAPP_ICON=${appIcon}`,
    `/DAPP_VERSION=${version}`,
    `/DAPP_FILE_VERSION=${version}.0`,
    `/DCACHE_ID=${cacheId}`,
    path.join(projectRoot, "build", "cached-portable.nsi"),
  ],
  { stdio: "inherit" },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const outputDirectory = path.dirname(outputFile);
for (const entry of readdirSync(outputDirectory, { withFileTypes: true })) {
  const candidate = path.join(outputDirectory, entry.name);
  if (candidate === outputFile) continue;
  if (
    entry.name === "win-unpacked" ||
    entry.name === "builder-debug.yml" ||
    /^(?:YiQiKan|Synced)-.*\.(?:exe|blockmap)$/i.test(entry.name)
  ) {
    try {
      rmSync(candidate, {
        recursive: entry.isDirectory(),
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EBUSY")
      ) {
        // Explorer, antivirus, or a running old portable build can retain a
        // handle to an obsolete artifact. The newly generated version is
        // already complete, so report the stale file without failing release.
        console.warn(`旧构建仍被占用，已保留：${candidate}`);
        continue;
      }
      throw error;
    }
  }
}
console.log(`Built latest portable package: ${outputFile}`);
