import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(".");
const androidRoot = path.join(projectRoot, "android");
const localJdkRoot = path.join(projectRoot, ".toolchains", "jdk");
const signingProperties = path.join(
  os.homedir(),
  ".yiqikan",
  "signing",
  "keystore.properties",
);
const expectedPackage = "com.yiqikan.room";
const expectedCertificateSha256 =
  "ca5c8f711b2d91ce5e7bd0dbf762bd191d5e8d9bb9269a3dee53a0540721e0a5";
const expectedPermissions = [
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
  "android.permission.INTERNET",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.RECORD_AUDIO",
  `${expectedPackage}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
].sort();

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(signingProperties)) {
  fail(`缺少正式签名配置：${signingProperties}`);
}

const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"),
);
const version = String(packageJson.version);
const gradleSource = readFileSync(
  path.join(androidRoot, "app", "build.gradle"),
  "utf8",
);
const variablesSource = readFileSync(
  path.join(androidRoot, "variables.gradle"),
  "utf8",
);
const gradleVersion = gradleSource.match(
  /\bversionName\s+["']([^"']+)["']/u,
)?.[1];
const gradleVersionCode = gradleSource.match(
  /\bversionCode\s+(\d+)/u,
)?.[1];
const variablesVersion = variablesSource.match(
  /\bversionName\s*=\s*["']([^"']+)["']/u,
)?.[1];
const variablesVersionCode = variablesSource.match(
  /\bversionCode\s*=\s*(\d+)/u,
)?.[1];

if (!/^\d+\.\d+\.\d+$/u.test(version)) {
  fail(`package.json 版本号不是 x.y.z：${version}`);
}
if (
  gradleVersion !== version ||
  variablesVersion !== version ||
  String(packageLock.version) !== version ||
  String(packageLock.packages?.[""]?.version) !== version
) {
  fail(
    `版本号不一致：package=${version}, lock=${packageLock.version}, Android=${gradleVersion}, variables=${variablesVersion}`,
  );
}
if (
  !gradleVersionCode ||
  Number(gradleVersionCode) < 1 ||
  variablesVersionCode !== gradleVersionCode
) {
  fail(
    `Android versionCode 无效或不一致：app=${gradleVersionCode || "未设置"}, variables=${variablesVersionCode || "未设置"}`,
  );
}

function validJavaHome(candidate) {
  if (!candidate) return false;
  const executable = process.platform === "win32" ? "java.exe" : "java";
  return existsSync(path.join(candidate, "bin", executable));
}

function findJavaHome() {
  if (validJavaHome(process.env.JAVA_HOME)) {
    return process.env.JAVA_HOME;
  }
  if (!existsSync(localJdkRoot)) return undefined;
  return readdirSync(localJdkRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(localJdkRoot, entry.name))
    .find(validJavaHome);
}

function decodeGradlePath(value) {
  return value
    .trim()
    .replace(/\\:/gu, ":")
    .replace(/\\\\/gu, "\\");
}

function findAndroidSdk() {
  for (const candidate of [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
  ]) {
    if (candidate && existsSync(path.join(candidate, "build-tools"))) {
      return candidate;
    }
  }
  const localProperties = path.join(androidRoot, "local.properties");
  if (existsSync(localProperties)) {
    const configured = readFileSync(localProperties, "utf8").match(
      /^sdk\.dir=(.+)$/mu,
    )?.[1];
    if (configured) {
      const candidate = decodeGradlePath(configured);
      if (existsSync(path.join(candidate, "build-tools"))) {
        return candidate;
      }
    }
  }
  const bundled = path.join(projectRoot, ".toolchains", "android-sdk");
  return existsSync(path.join(bundled, "build-tools")) ? bundled : undefined;
}

function findBuildTools(androidSdk) {
  const buildToolsRoot = path.join(androidSdk, "build-tools");
  const aaptName = process.platform === "win32" ? "aapt.exe" : "aapt";
  const aapt2Name = process.platform === "win32" ? "aapt2.exe" : "aapt2";
  const candidates = readdirSync(buildToolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(buildToolsRoot, entry.name))
    .filter(
      (directory) =>
        existsSync(path.join(directory, aaptName)) &&
        existsSync(path.join(directory, aapt2Name)) &&
        existsSync(path.join(directory, "lib", "apksigner.jar")),
    )
    .sort((left, right) =>
      path.basename(right).localeCompare(path.basename(left), undefined, {
        numeric: true,
      }),
    );
  return candidates[0];
}

const javaHome = findJavaHome();
if (!javaHome) {
  fail("找不到 JDK；请设置 JAVA_HOME 或安装 native/.toolchains/jdk/");
}
const androidSdk = findAndroidSdk();
if (!androidSdk) {
  fail("找不到 Android SDK；请设置 ANDROID_SDK_ROOT 或 android/local.properties");
}
const buildTools = findBuildTools(androidSdk);
if (!buildTools) {
  fail("Android SDK 中缺少 aapt 或 apksigner");
}

const buildEnvironment = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_SDK_ROOT: androidSdk,
};
if (process.env.JAVA_HOME !== javaHome) {
  console.log(`Using bundled Android JDK: ${javaHome}`);
}

function run(command, args, cwd = projectRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: buildEnvironment,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runScript(command, args, cwd = projectRoot) {
  if (process.platform === "win32") {
    run(
      process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", command, ...args],
      cwd,
    );
    return;
  }
  run(command, args, cwd);
}

function runCaptured(command, args, cwd = projectRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: buildEnvironment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status ?? 1);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

runScript(process.platform === "win32" ? "npm.cmd" : "npm", [
  "run",
  "cap:sync",
]);
runScript(
  process.platform === "win32" ? "gradlew.bat" : "./gradlew",
  ["lintRelease", "assembleRelease"],
  androidRoot,
);

const sourceApk = path.join(
  androidRoot,
  "app",
  "build",
  "outputs",
  "apk",
  "release",
  "app-release.apk",
);
if (!existsSync(sourceApk)) {
  fail("正式签名 APK 未生成");
}

const javaExecutable = path.join(
  javaHome,
  "bin",
  process.platform === "win32" ? "java.exe" : "java",
);
const apksignerJar = path.join(buildTools, "lib", "apksigner.jar");
const aapt = path.join(
  buildTools,
  process.platform === "win32" ? "aapt.exe" : "aapt",
);
const aapt2 = path.join(
  buildTools,
  process.platform === "win32" ? "aapt2.exe" : "aapt2",
);
const signingReport = runCaptured(javaExecutable, [
  "-jar",
  apksignerJar,
  "verify",
  "--verbose",
  "--print-certs",
  sourceApk,
]);

for (const [label, pattern] of [
  ["APK Signature Scheme v2", /Verified using v2 scheme[^:]*:\s*true/iu],
  ["APK Signature Scheme v3", /Verified using v3 scheme[^:]*:\s*true/iu],
  ["单一签名者", /Number of signers:\s*1\b/iu],
]) {
  if (!pattern.test(signingReport)) {
    fail(`签名校验失败：${label}`);
  }
}
if (/Verified using v1 scheme[^:]*:\s*true/iu.test(signingReport)) {
  fail("签名校验失败：不应启用旧版 v1/JAR 签名");
}

const certificateSha256 = (
  signingReport.match(
    /Signer #1 certificate SHA-256 digest:\s*([0-9a-f:\s]+)/iu,
  )?.[1] || ""
)
  .replace(/[^0-9a-f]/giu, "")
  .toLowerCase();
if (certificateSha256 !== expectedCertificateSha256) {
  fail(
    `签名证书不匹配：${certificateSha256 || "未读取到证书指纹"}`,
  );
}
const signerDn =
  signingReport.match(/Signer #1 certificate DN:\s*(.+)$/imu)?.[1]?.trim() ||
  "unknown";

const badging = runCaptured(aapt, ["dump", "badging", sourceApk]);
const packageDetails = badging.match(
  /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/mu,
);
if (
  !packageDetails ||
  packageDetails[1] !== expectedPackage ||
  packageDetails[2] !== gradleVersionCode ||
  packageDetails[3] !== version
) {
  fail("APK 包名、versionCode 或 versionName 与发布配置不一致");
}
if (/^application-debuggable\b/mu.test(badging)) {
  fail("正式 APK 被错误地标记为 debuggable");
}

const permissionReport = runCaptured(aapt, [
  "dump",
  "permissions",
  sourceApk,
]);
const actualPermissions = [
  ...permissionReport.matchAll(
    /^uses-permission(?:-sdk-\d+)?: name='([^']+)'/gmu,
  ),
]
  .map((match) => match[1])
  .sort();
if (
  actualPermissions.length !== expectedPermissions.length ||
  actualPermissions.some(
    (permission, index) => permission !== expectedPermissions[index],
  )
) {
  fail(
    `APK 权限集合超出白名单：${actualPermissions.join(", ")}`,
  );
}

const manifestTree = runCaptured(aapt, [
  "dump",
  "xmltree",
  sourceApk,
  "AndroidManifest.xml",
]);
if (
  !/android:allowBackup[^=]*=\(type 0x12\)0x0/iu.test(manifestTree) ||
  !/android:usesCleartextTraffic[^=]*=\(type 0x12\)0x0/iu.test(
    manifestTree,
  ) ||
  /android:debuggable/iu.test(manifestTree)
) {
  fail("APK Manifest 安全属性校验失败");
}
const resourceTable = runCaptured(aapt2, [
  "dump",
  "resources",
  sourceApk,
]);
const compiledNetworkSecurityPath = resourceTable.match(
  /resource\s+0x[0-9a-f]+\s+xml\/network_security_config[\s\S]{0,240}?\(file\)\s+(\S+)\s+type=XML/iu,
)?.[1];
if (!compiledNetworkSecurityPath) {
  fail("APK 中缺少已编译的网络安全配置");
}
const networkSecurityTree = runCaptured(aapt2, [
  "dump",
  "xmltree",
  sourceApk,
  "--file",
  compiledNetworkSecurityPath,
]);
if (
  !/cleartextTrafficPermitted=false/iu.test(networkSecurityTree)
) {
  fail("APK 网络安全配置未禁止明文流量");
}

const outputDirectory = path.join(projectRoot, "release", "android");
mkdirSync(outputDirectory, { recursive: true });
for (const entry of readdirSync(outputDirectory, { withFileTypes: true })) {
  rmSync(path.join(outputDirectory, entry.name), {
    recursive: entry.isDirectory(),
    force: true,
  });
}
const outputApk = path.join(outputDirectory, `Synced-${version}.apk`);
copyFileSync(sourceApk, outputApk);
const apkSha256 = createHash("sha256")
  .update(readFileSync(outputApk))
  .digest("hex");
const apkBytes = statSync(outputApk).size;
const securityReport = [
  "同频 Android 发布安全校验",
  `生成时间：${new Date().toISOString()}`,
  `文件：${path.basename(outputApk)}`,
  `包名：${expectedPackage}`,
  `版本：${version} (${gradleVersionCode})`,
  `大小：${apkBytes} bytes`,
  `SHA-256：${apkSha256}`,
  `签名者：${signerDn}`,
  `签名证书 SHA-256：${certificateSha256}`,
  "签名方案：APK Signature Scheme v2 + v3",
  "调试标志：关闭",
  "任意明文网络：禁止",
  "应用备份：禁止",
  "发布检查：Android lintRelease 通过",
  "实际声明权限：",
  ...actualPermissions.map((permission) => `- ${permission}`),
  "",
  "说明：本报告校验发布包的来源、签名、版本、权限和关键安全属性；",
  "厂商云端的启发式/信誉判定仍可能需要提交误报申诉后更新。",
  "",
].join("\n");
const securityReportPath = path.join(
  outputDirectory,
  `Synced-${version}-security.txt`,
);
writeFileSync(securityReportPath, securityReport, "utf8");

console.log(`Built signed release APK: ${outputApk}`);
console.log(`Security report: ${securityReportPath}`);
