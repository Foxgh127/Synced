import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(".");
const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"),
);
const gradleSource = readFileSync(
  path.join(projectRoot, "android", "app", "build.gradle"),
  "utf8",
);
const variablesSource = readFileSync(
  path.join(projectRoot, "android", "variables.gradle"),
  "utf8",
);
const version = String(packageJson.version);
const gradleVersion = gradleSource.match(
  /\bversionName\s+["']([^"']+)["']/u,
)?.[1];
const gradleVersionCode = Number(
  gradleSource.match(/\bversionCode\s+(\d+)/u)?.[1],
);
const variablesVersion = variablesSource.match(
  /\bversionName\s*=\s*["']([^"']+)["']/u,
)?.[1];
const variablesVersionCode = Number(
  variablesSource.match(/\bversionCode\s*=\s*(\d+)/u)?.[1],
);

if (!/^\d+\.\d+\.\d+$/u.test(version)) {
  throw new Error(`package.json 版本号不是 x.y.z：${version}`);
}
if (
  gradleVersion !== version ||
  variablesVersion !== version ||
  String(packageLock.version) !== version ||
  String(packageLock.packages?.[""]?.version) !== version
) {
  throw new Error(
    `版本号不一致：package=${version}, lock=${packageLock.version}, Android=${gradleVersion}, variables=${variablesVersion}`,
  );
}
if (
  !Number.isSafeInteger(gradleVersionCode) ||
  gradleVersionCode < 1 ||
  variablesVersionCode !== gradleVersionCode
) {
  throw new Error(
    `Android versionCode 无效或不一致：app=${gradleVersionCode || "未设置"}, variables=${variablesVersionCode || "未设置"}`,
  );
}
for (const requiredPath of [
  path.join(projectRoot, "build", "cached-portable.nsi"),
  path.join(projectRoot, "build", "icon.ico"),
  path.join(projectRoot, "build", "installer.nsh"),
  path.join(projectRoot, "scripts", "build-portable.mjs"),
  path.join(projectRoot, "scripts", "ensure-ffmpeg-runtime.mjs"),
]) {
  if (!existsSync(requiredPath)) {
    throw new Error(
      `发布构建依赖缺失：${path.relative(projectRoot, requiredPath)}`,
    );
  }
}

console.log(
  `Version check passed: ${version} (Android versionCode ${gradleVersionCode}).`,
);
