import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const sourcePath = path.join(projectRoot, "build", "icon.svg");
const checkOnly = process.argv.includes("--check");
const source = readFileSync(sourcePath, "utf8");

function sourceValue(name) {
  const value = source.match(new RegExp(`${name}="([^"]+)"`, "u"))?.[1];
  if (!value) {
    throw new Error(`品牌 SVG 缺少 ${name}`);
  }
  return value;
}

const background = sourceValue("data-brand-background");
const foreground = sourceValue("data-brand-foreground");
const markElement = source.match(
  /<path\s+id="synced-mark"[\s\S]*?\/>/u,
)?.[0];
if (!markElement) {
  throw new Error('品牌 SVG 缺少 id="synced-mark" 的路径');
}
const markPath = markElement.match(/\bd="([^"]+)"/u)?.[1];
const strokeWidth = markElement.match(/\bstroke-width="([^"]+)"/u)?.[1];
if (!markPath || !strokeWidth) {
  throw new Error("品牌路径缺少 d 或 stroke-width");
}

const outputs = new Map();
const androidResources = path.join(
  projectRoot,
  "android",
  "app",
  "src",
  "main",
  "res",
);

function setText(relativePath, value) {
  outputs.set(path.join(projectRoot, relativePath), Buffer.from(value, "utf8"));
}

function markSvg(color, title = "同频环播") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none">
  <title>${title}</title>
  <path d="${markPath}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

function tileSvg(shape = "rounded") {
  const backgroundShape =
    shape === "round"
      ? `<circle cx="32" cy="32" r="30" fill="${background}"/>`
      : `<rect x="2" y="2" width="60" height="60" rx="16" fill="${background}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64" fill="none">
  <title>同频</title>
  ${backgroundShape}
  <path d="${markPath}" stroke="${foreground}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

function adaptiveForegroundSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108" fill="none">
  <g transform="translate(18 18) scale(1.125)">
    <path d="${markPath}" stroke="${foreground}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
`;
}

function vectorDrawable(color, purpose) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from native/build/icon.svg by scripts/generate-brand-assets.mjs (${purpose}). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group
        android:translateX="18"
        android:translateY="18"
        android:scaleX="1.125"
        android:scaleY="1.125">
        <path
            android:fillColor="#00000000"
            android:pathData="${markPath}"
            android:strokeColor="${color}"
            android:strokeWidth="${strokeWidth}"
            android:strokeLineCap="round"
            android:strokeLineJoin="round" />
    </group>
</vector>
`;
}

function adaptiveIcon(includeMonochrome) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from native/build/icon.svg by scripts/generate-brand-assets.mjs. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />${
      includeMonochrome
        ? '\n    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />'
        : ""
    }
</adaptive-icon>
`;
}

setText("public/brand-mark.svg", markSvg(foreground));
setText("public/brand-mark-dark.svg", markSvg("#06070A"));
setText(
  "android/app/src/main/res/values/ic_launcher_background.xml",
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from native/build/icon.svg by scripts/generate-brand-assets.mjs. -->
<resources>
    <color name="ic_launcher_background">${background}</color>
</resources>
`,
);
setText(
  "android/app/src/main/res/drawable/ic_launcher_background.xml",
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from native/build/icon.svg by scripts/generate-brand-assets.mjs. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:fillColor="${background}" android:pathData="M0,0h108v108h-108z" />
</vector>
`,
);
setText(
  "android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml",
  vectorDrawable(foreground, "adaptive foreground"),
);
setText(
  "android/app/src/main/res/drawable/ic_launcher_monochrome.xml",
  vectorDrawable("#FFFFFFFF", "Android 13 monochrome"),
);
setText(
  "android/app/src/main/res/drawable/ic_stat_synced.xml",
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from native/build/icon.svg by scripts/generate-brand-assets.mjs (notification). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="64"
    android:viewportHeight="64">
    <path
        android:fillColor="#00000000"
        android:pathData="${markPath}"
        android:strokeColor="#FFFFFFFF"
        android:strokeWidth="6.5"
        android:strokeLineCap="round"
        android:strokeLineJoin="round" />
</vector>
`,
);
for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
  setText(
    `android/app/src/main/res/mipmap-anydpi-v26/${name}`,
    adaptiveIcon(false),
  );
  setText(
    `android/app/src/main/res/mipmap-anydpi-v33/${name}`,
    adaptiveIcon(true),
  );
}

const densityAssets = [
  ["mdpi", 48, 108],
  ["hdpi", 72, 162],
  ["xhdpi", 96, 216],
  ["xxhdpi", 144, 324],
  ["xxxhdpi", 192, 432],
];
for (const [density, legacySize, foregroundSize] of densityAssets) {
  const directory = path.join(androidResources, `mipmap-${density}`);
  outputs.set(
    path.join(directory, "ic_launcher.png"),
    await sharp(Buffer.from(tileSvg()))
      .resize(legacySize, legacySize)
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );
  outputs.set(
    path.join(directory, "ic_launcher_round.png"),
    await sharp(Buffer.from(tileSvg("round")))
      .resize(legacySize, legacySize)
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );
  outputs.set(
    path.join(directory, "ic_launcher_foreground.png"),
    await sharp(Buffer.from(adaptiveForegroundSvg()))
      .resize(foregroundSize, foregroundSize)
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoImages = await Promise.all(
  icoSizes.map((size) =>
    sharp(Buffer.from(source))
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toBuffer(),
  ),
);
const icoHeader = Buffer.alloc(6 + icoImages.length * 16);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(icoImages.length, 4);
let icoOffset = icoHeader.length;
for (let index = 0; index < icoImages.length; index += 1) {
  const entryOffset = 6 + index * 16;
  const size = icoSizes[index];
  const image = icoImages[index];
  icoHeader[entryOffset] = size === 256 ? 0 : size;
  icoHeader[entryOffset + 1] = size === 256 ? 0 : size;
  icoHeader[entryOffset + 2] = 0;
  icoHeader[entryOffset + 3] = 0;
  icoHeader.writeUInt16LE(1, entryOffset + 4);
  icoHeader.writeUInt16LE(32, entryOffset + 6);
  icoHeader.writeUInt32LE(image.length, entryOffset + 8);
  icoHeader.writeUInt32LE(icoOffset, entryOffset + 12);
  icoOffset += image.length;
}
outputs.set(
  path.join(projectRoot, "build", "icon.ico"),
  Buffer.concat([icoHeader, ...icoImages]),
);

const stale = [];
for (const [outputPath, expected] of outputs) {
  const matches =
    existsSync(outputPath) && readFileSync(outputPath).equals(expected);
  if (matches) continue;
  stale.push(path.relative(projectRoot, outputPath));
  if (!checkOnly) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, expected);
  }
}

if (checkOnly && stale.length) {
  throw new Error(
    `品牌资产未同步，请运行 npm run brand:generate：\n- ${stale.join("\n- ")}`,
  );
}
console.log(
  checkOnly
    ? `Brand assets verified (${outputs.size} files).`
    : `Brand assets generated (${outputs.size} files).`,
);
