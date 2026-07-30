const { spawn } = require("node:child_process");
const path = require("node:path");

const electron = require("electron");
const smokeScript = path.join(__dirname, "smoke-public-turn.cjs");
const transports = (
  process.env.SYNCED_TURN_CONCURRENCY_TRANSPORTS ||
  "udp,udp,tcp,tcp"
)
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter((value) => value === "udp" || value === "tcp");
const benchmarkBytes = String(
  Math.max(
    0,
    Math.min(
      4 * 1024 * 1024,
      Math.trunc(
        Number(process.env.SYNCED_TURN_BENCH_BYTES) || 256 * 1024,
      ),
    ),
  ),
);
const timeoutMs = Math.max(
  15_000,
  Math.min(
    120_000,
    Number(process.env.SYNCED_TURN_CONCURRENCY_TIMEOUT_MS) || 60_000,
  ),
);

if (transports.length < 2 || transports.length > 8) {
  throw new Error("TURN concurrency smoke requires 2–8 UDP/TCP workers");
}

function runWorker(transport, index) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [smokeScript], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SYNCED_TURN_TRANSPORT: transport,
        SYNCED_TURN_BENCH_BYTES: benchmarkBytes,
      },
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) =>
      `${current}${chunk.toString("utf8")}`.slice(-256 * 1024);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`TURN worker ${index} (${transport}) timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `TURN worker ${index} (${transport}) exited ${code}: ${stderr || stdout}`,
          ),
        );
        return;
      }
      const match = stdout.match(/TURN_SMOKE_RESULT\s+(\{.+\})/u);
      if (!match) {
        reject(
          new Error(
            `TURN worker ${index} (${transport}) returned no result: ${stdout || stderr}`,
          ),
        );
        return;
      }
      if (/"(?:username|credential)"\s*:/iu.test(match[1])) {
        reject(new Error("TURN worker output exposed a temporary credential"));
        return;
      }
      try {
        resolve(JSON.parse(match[1]));
      } catch (error) {
        reject(error);
      }
    });
  });
}

Promise.all(
  transports.map((transport, index) => runWorker(transport, index + 1)),
)
  .then((results) => {
    process.stdout.write(
      `TURN_CONCURRENCY_RESULT ${JSON.stringify({
        ok: true,
        workers: results.length,
        benchmarkBytes: Number(benchmarkBytes),
        results: results.map((result) => ({
          transport: result.requestedTransport,
          megabitsPerSecond: result.benchmark?.megabitsPerSecond,
          pairs: result.pairs,
        })),
      })}\n`,
    );
  })
  .catch((error) => {
    process.stderr.write(
      `TURN_CONCURRENCY_FAILED ${
        error instanceof Error ? error.stack : error
      }\n`,
    );
    process.exitCode = 1;
  });
