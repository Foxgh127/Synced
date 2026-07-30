const WebSocket = require("ws");

async function main() {
  const endpoint = process.argv[2];
  const expression = process.argv[3];
  if (!endpoint || !expression) {
    throw new Error("usage: node scripts/cdp-eval.cjs <websocket-url> <expression>");
  }
  const socket = new WebSocket(endpoint);
  const timeout = setTimeout(() => {
    socket.terminate();
    process.stderr.write("CDP evaluation timed out\n");
    process.exitCode = 1;
  }, 10_000);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const id = 1;
  socket.send(
    JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
    }),
  );
  const response = await new Promise((resolve, reject) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id !== id) return;
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.once("error", reject);
  });
  clearTimeout(timeout);
  socket.close();
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "CDP expression failed",
    );
  }
  process.stdout.write(
    `${JSON.stringify(response.result?.value, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
