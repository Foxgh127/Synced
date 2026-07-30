import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const DEEPFILTER_WORKLET_PATH =
  "/__synced-worklets/deepfilter-net3.js";
const PROCESS_AUDIO_WORKLET_PATH =
  "/__synced-worklets/process-audio.js";

function readProjectFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

function bundledAudioWorklets(): Plugin {
  const deepFilterModule = readProjectFile(
    "./node_modules/deepfilternet3-noise-filter/dist/index.esm.js",
  );
  const deepFilterLiteral = deepFilterModule.match(
    /var workletCode = ("(?:\\.|[^"\\])*");/,
  )?.[1];
  if (!deepFilterLiteral) {
    throw new Error(
      "deepfilternet3-noise-filter no longer exposes the expected bundled worklet",
    );
  }
  const deepFilterWorklet = JSON.parse(deepFilterLiteral) as string;
  const processAudioModule = readProjectFile("./src/process-audio.ts");
  const processAudioWorklet = processAudioModule.match(
    /export const PROCESS_AUDIO_WORKLET_SOURCE = `([\s\S]*?)`;\r?\n\r?\ninterface ProcessAudioClockSample/,
  )?.[1];
  if (!processAudioWorklet) {
    throw new Error(
      "process-audio.ts no longer exposes the expected bundled worklet",
    );
  }

  let serving = false;
  let deepFilterAssetReference = "";
  let processAudioAssetReference = "";
  const assetUrl = (
    developmentPath: string,
    reference: string,
  ): string =>
    serving
      ? JSON.stringify(developmentPath)
      : `import.meta.ROLLUP_FILE_URL_${reference}`;

  return {
    name: "synced-static-audio-worklets",
    enforce: "pre",
    configResolved(config) {
      serving = config.command === "serve";
    },
    configureServer(server) {
      const sources = new Map([
        [DEEPFILTER_WORKLET_PATH, deepFilterWorklet],
        [PROCESS_AUDIO_WORKLET_PATH, processAudioWorklet],
      ]);
      server.middlewares.use((request, response, next) => {
        const source = sources.get(
          new URL(request.url || "/", "http://localhost").pathname,
        );
        if (source === undefined) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader(
          "content-type",
          "text/javascript; charset=utf-8",
        );
        response.setHeader("cache-control", "no-store");
        response.end(source);
      });
    },
    buildStart() {
      if (serving) return;
      deepFilterAssetReference = this.emitFile({
        type: "asset",
        name: "deepfilter-net3-worklet.js",
        source: deepFilterWorklet,
      });
      processAudioAssetReference = this.emitFile({
        type: "asset",
        name: "process-audio-worklet.js",
        source: processAudioWorklet,
      });
    },
    transform(code, id) {
      const normalizedId = id.replaceAll("\\", "/").split("?")[0];
      if (
        normalizedId.endsWith(
          "/node_modules/deepfilternet3-noise-filter/dist/index.esm.js",
        )
      ) {
        const start = code.indexOf(
          "async function createWorkletModule(audioContext, workletCode) {",
        );
        const endMarker = "\n}\n\nconst WorkletMessageTypes";
        const end = code.indexOf(endMarker, start);
        if (start < 0 || end < 0) {
          throw new Error(
            "DeepFilterNet3 worklet loader changed unexpectedly",
          );
        }
        const replacement = `async function createWorkletModule(audioContext, _workletCode) {
    await audioContext.audioWorklet.addModule(${assetUrl(
      DEEPFILTER_WORKLET_PATH,
      deepFilterAssetReference,
    )});
}`;
        return {
          code: `${code.slice(0, start)}${replacement}${code.slice(end + 2)}`,
          map: null,
        };
      }
      if (normalizedId.endsWith("/src/process-audio.ts")) {
        const blobLoader = `const moduleUrl = URL.createObjectURL(
      new Blob([PROCESS_AUDIO_WORKLET_SOURCE], { type: "text/javascript" }),
    );`;
        if (!code.includes(blobLoader)) {
          throw new Error(
            "process-audio worklet loader changed unexpectedly",
          );
        }
        return {
          code: code.replace(
            blobLoader,
            `const moduleUrl = ${assetUrl(
              PROCESS_AUDIO_WORKLET_PATH,
              processAudioAssetReference,
            )};`,
          ),
          map: null,
        };
      }
      return undefined;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [bundledAudioWorklets()],
  optimizeDeps: {
    // The transform above replaces the dependency's blob: AudioWorklet loader
    // during development as well as production builds.
    exclude: ["deepfilternet3-noise-filter"],
  },
  css: {
    // Keep the native renderer independent from the repository root's Tailwind setup.
    postcss: {
      plugins: [],
    },
  },
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true,
    target: "chrome120",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
