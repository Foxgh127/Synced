import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(".");
const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const version = String(packageJson.version);

function runNpm(script) {
  const command =
    process.platform === "win32"
      ? process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe"
      : "npm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm.cmd", "run", script]
      : ["run", script];
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Fail before producing any EXE/APK when source versions, renderer behavior,
// native audio, Emby transport, voice, or danmaku integration has regressed.
runNpm("check");
runNpm("smoke:release");
runNpm("dist:portable");
runNpm("apk:release");
runNpm("bundle:signal");

const artifacts = [
  path.join(
    projectRoot,
    "release",
    "windows-dist",
    `Synced-${version}-portable.exe`,
  ),
  path.join(
    projectRoot,
    "release",
    "android",
    `Synced-${version}.apk`,
  ),
  path.join(
    projectRoot,
    "release",
    "android",
    `Synced-${version}-security.txt`,
  ),
  path.join(projectRoot, "release", "server", "yiqikan-signal.mjs"),
];
for (const artifact of artifacts) {
  if (!existsSync(artifact) || statSync(artifact).size < 1) {
    console.error(`发布产物缺失：${artifact}`);
    process.exit(1);
  }
}

const checksumLines = artifacts.map((artifact) => {
  const digest = createHash("sha256")
    .update(readFileSync(artifact))
    .digest("hex");
  return `${digest} *${path.relative(projectRoot, artifact).replaceAll("\\", "/")}`;
});
const checksumPath = path.join(
  projectRoot,
  "release",
  `SHA256SUMS-${version}.txt`,
);
writeFileSync(checksumPath, `${checksumLines.join("\n")}\n`, "utf8");

// Keep the delivery directory unambiguous: old checksum manifests describe
// artifacts that the release builders have already replaced or removed.
// Removing them only after every current artifact has passed validation means
// a failed build never destroys the last known-good release metadata.
for (const entry of readdirSync(path.join(projectRoot, "release"), {
  withFileTypes: true,
})) {
  if (
    entry.isFile() &&
    /^SHA256SUMS-.+\.txt$/iu.test(entry.name) &&
    entry.name !== path.basename(checksumPath)
  ) {
    rmSync(path.join(projectRoot, "release", entry.name), { force: true });
  }
}
console.log(`Complete ${version} release built: ${checksumPath}`);
