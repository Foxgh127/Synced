import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const projectRoot = path.resolve(".");
const executable = path.join(projectRoot, "vendor", "ffmpeg", "ffmpeg.exe");
const archiveUrl =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-24-13-32/ffmpeg-n8.1.2-31-g8c9502e9b0-win64-lgpl-8.1.zip";
const archiveSha256 =
  "972c57498dff104fff2d53b8b0cb3641f45b8ff1e7cc1b00257c9e34435fe853";

if (existsSync(executable)) {
  process.exit(0);
}
if (process.platform !== "win32") {
  throw new Error("FFmpeg 自动准备目前仅支持 Windows 构建环境");
}

const temporaryRoot = path.join(
  projectRoot,
  `.tmp-ffmpeg-${process.pid}-${Date.now()}`,
);
const archive = path.join(temporaryRoot, "ffmpeg-runtime.zip");
const extracted = path.join(temporaryRoot, "extracted");
mkdirSync(extracted, { recursive: true });

function findFile(root, fileName) {
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

try {
  console.log("FFmpeg runtime is missing; downloading the pinned LGPL build…");
  const response = await fetch(archiveUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`FFmpeg 下载失败：HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(archive));
  const digest = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  if (digest !== archiveSha256) {
    throw new Error(`FFmpeg 压缩包校验失败：${digest}`);
  }

  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const expanded = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "& { param([string] $ArchivePath, [string] $DestinationPath) Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -Force }",
      archive,
      extracted,
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (expanded.error || expanded.status !== 0) {
    throw expanded.error || new Error("FFmpeg 压缩包解压失败");
  }
  const downloadedExecutable = findFile(extracted, "ffmpeg.exe");
  if (!downloadedExecutable) {
    throw new Error("FFmpeg 压缩包中缺少 ffmpeg.exe");
  }
  mkdirSync(path.dirname(executable), { recursive: true });
  copyFileSync(downloadedExecutable, executable);
  console.log("Pinned FFmpeg runtime is ready.");
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  if (resolvedTemporaryRoot.startsWith(`${projectRoot}${path.sep}.tmp-ffmpeg-`)) {
    rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
  }
}
