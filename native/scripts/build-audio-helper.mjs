import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const localSdk = path.resolve(".toolchains", "dotnet-sdk", "dotnet.exe");
const dotnet = existsSync(localSdk) ? localSdk : "dotnet";
const result = spawnSync(
  dotnet,
  [
    "publish",
    "audio-helper/Synced.AudioCapture.csproj",
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--self-contained",
    "true",
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:PublishTrimmed=true",
    "-p:TrimMode=partial",
    "-p:EnableCompressionInSingleFile=true",
    "-o",
    "audio-helper/publish/win-x64",
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error("无法启动 .NET SDK。请安装 .NET 9 SDK，或放到 native/.toolchains/dotnet-sdk。");
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
