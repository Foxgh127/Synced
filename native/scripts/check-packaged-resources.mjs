import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(".");
const unpackedResources = path.join(
  projectRoot,
  "release",
  "windows-dist",
  "win-unpacked",
  "resources",
);
const sourceRoot = path.join(
  projectRoot,
  "public",
  "models",
  "deepfilternet3",
);
const packagedRoot = path.join(
  unpackedResources,
  "models",
  "deepfilternet3",
);
const requiredFiles = [
  "NOTICE.txt",
  path.join("v3", "pkg", "df_bg.wasm"),
  path.join("v3", "models", "DeepFilterNet3_onnx.tar.gz"),
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

if (!existsSync(path.join(unpackedResources, "app.asar"))) {
  fail("打包资源检查失败：缺少 win-unpacked/resources/app.asar");
}

for (const relativePath of requiredFiles) {
  const source = path.join(sourceRoot, relativePath);
  const packaged = path.join(packagedRoot, relativePath);
  if (
    !existsSync(source) ||
    !existsSync(packaged) ||
    statSync(source).size < 1 ||
    statSync(packaged).size !== statSync(source).size ||
    sha256(packaged) !== sha256(source)
  ) {
    fail(`打包资源检查失败：DeepFilterNet 文件缺失或损坏：${relativePath}`);
  }
}

console.log(
  "Packaged resource check passed: DeepFilterNet model is readable outside app.asar.",
);
