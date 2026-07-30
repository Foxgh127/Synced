const { app } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { AudioPacketDecoder } = require("../electron/audio-packet.cjs");

const helper =
  process.env.SYNCED_AUDIO_HELPER ||
  path.join(
    __dirname,
    "..",
    "audio-helper",
    "publish",
    "win-x64",
    "Synced.AudioCapture.exe",
  );

async function main() {
  await app.whenReady();
  const source = spawn(
    "python",
    [path.join(__dirname, "audio-smoke-source.py")],
    {
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let sourceOutput = "";
  let sourceError = "";
  source.stdout.on("data", (chunk) => {
    sourceOutput += chunk.toString("utf8");
  });
  source.stderr.on("data", (chunk) => {
    sourceError += chunk.toString("utf8");
  });
  const windowHandle = await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const match = sourceOutput.match(/HANDLE=(\d+)/);
      if (match) {
        clearInterval(timer);
        resolve(match[1]);
      } else if (source.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`测试音窗口意外退出：${sourceError}`));
      } else if (Date.now() - startedAt > 10_000) {
        clearInterval(timer);
        reject(new Error(`测试音窗口启动超时：${sourceError}`));
      }
    }, 100);
  });

  const child = spawn(helper, ["--capture-window", windowHandle], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  const packetDecoder = new AudioPacketDecoder(({ pcm }) => chunks.push(pcm));
  let stderr = "";
  child.stdout.on("data", (chunk) => packetDecoder.push(chunk));
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (stderr.includes('"type":"error"')) {
          clearInterval(timer);
          reject(new Error(stderr.trim()));
        } else if (
          stderr.includes('"type":"ready"') &&
          chunks.reduce((total, chunk) => total + chunk.length, 0) >= 192_000
        ) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - startedAt > 10_000) {
          clearInterval(timer);
          reject(new Error(`进程音频采集超时：${stderr.trim()}`));
        }
      }, 100);
    });
  } finally {
    child.kill();
    source.kill();
  }

  const pcm = Buffer.concat(chunks);
  let sumSquares = 0;
  let peak = 0;
  let sampleCount = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32_768;
    const absolute = Math.abs(sample);
    sumSquares += sample * sample;
    peak = Math.max(peak, absolute);
    sampleCount += 1;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, sampleCount));
  const result = {
    ok: rms >= 0.005 && peak >= 0.02,
    bytes: pcm.length,
    rms,
    peak,
    windowHandle,
    status: stderr
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((status) => status.type === "ready"),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(
      `PROCESS_AUDIO_SMOKE_FAILED ${error instanceof Error ? error.stack : error}\n`,
    );
    app.exit(1);
  });
