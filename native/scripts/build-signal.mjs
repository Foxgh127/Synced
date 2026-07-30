import { build } from "esbuild";

await build({
  entryPoints: ["server/index.mjs"],
  outfile: "release/server/yiqikan-signal.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

console.log("Built release/server/yiqikan-signal.mjs");
