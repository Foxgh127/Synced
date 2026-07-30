import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function read(relativePath, encoding = null) {
  return readFile(path.join(projectRoot, relativePath), encoding);
}

function pngSize(buffer) {
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    "asset must be a PNG",
  );
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

test("brand assets are generated from the single synced-mark SVG", async () => {
  const master = await read("build/icon.svg", "utf8");
  const pathData = master.match(
    /<path\s+id="synced-mark"[\s\S]*?\bd="([^"]+)"/u,
  )?.[1];
  assert.ok(pathData, "master SVG must expose the synced-mark path");
  assert.match(master, /<title>同频环播<\/title>/u);

  const [lightMark, darkMark] = await Promise.all([
    read("public/brand-mark.svg", "utf8"),
    read("public/brand-mark-dark.svg", "utf8"),
  ]);
  assert.match(lightMark, new RegExp(`d="${pathData}"`, "u"));
  assert.match(darkMark, new RegExp(`d="${pathData}"`, "u"));
  assert.match(lightMark, /stroke="#A5B4FC"/u);
  assert.match(darkMark, /stroke="#06070A"/u);
});

test("Windows ICO contains every required square resolution", async () => {
  const ico = await read("build/icon.ico");
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);

  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = ico[entry] || 256;
    const height = ico[entry + 1] || 256;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(width, height);
    assert.equal(ico.readUInt16LE(entry + 4), 1);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    assert.deepEqual(pngSize(ico.subarray(offset, offset + length)), [
      width,
      height,
    ]);
    sizes.push(width);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
});

test("Android legacy, adaptive, round, monochrome and notification assets agree", async () => {
  const densities = [
    ["mdpi", 48, 108],
    ["hdpi", 72, 162],
    ["xhdpi", 96, 216],
    ["xxhdpi", 144, 324],
    ["xxxhdpi", 192, 432],
  ];
  for (const [density, launcherSize, foregroundSize] of densities) {
    const base = `android/app/src/main/res/mipmap-${density}`;
    assert.deepEqual(pngSize(await read(`${base}/ic_launcher.png`)), [
      launcherSize,
      launcherSize,
    ]);
    assert.deepEqual(pngSize(await read(`${base}/ic_launcher_round.png`)), [
      launcherSize,
      launcherSize,
    ]);
    assert.deepEqual(
      pngSize(await read(`${base}/ic_launcher_foreground.png`)),
      [foregroundSize, foregroundSize],
    );
  }

  const [adaptive26, adaptive33, monochrome, notification, service] =
    await Promise.all([
      read(
        "android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
        "utf8",
      ),
      read(
        "android/app/src/main/res/mipmap-anydpi-v33/ic_launcher.xml",
        "utf8",
      ),
      read(
        "android/app/src/main/res/drawable/ic_launcher_monochrome.xml",
        "utf8",
      ),
      read("android/app/src/main/res/drawable/ic_stat_synced.xml", "utf8"),
      read(
        "android/app/src/main/java/com/synced/room/PlaybackForegroundService.java",
        "utf8",
      ),
    ]);
  assert.match(adaptive26, /@drawable\/ic_launcher_foreground/u);
  assert.doesNotMatch(adaptive26, /<monochrome/u);
  assert.match(
    adaptive33,
    /<monochrome android:drawable="@drawable\/ic_launcher_monochrome"/u,
  );
  assert.match(monochrome, /android:strokeColor="#FFFFFFFF"/u);
  assert.match(notification, /android:width="24dp"/u);
  assert.match(service, /\.setSmallIcon\(R\.drawable\.ic_stat_synced\)/u);
  assert.doesNotMatch(service, /\.setSmallIcon\(R\.mipmap\./u);
});

test("runtime surfaces and Capacitor use the 同频 identity", async () => {
  const [main, capacitor] = await Promise.all([
    read("src/main.ts", "utf8"),
    read("capacitor.config.ts", "utf8"),
  ]);
  assert.match(main, /src="\.\/brand-mark\.svg"/u);
  assert.match(main, /src="\.\/brand-mark-dark\.svg"/u);
  assert.doesNotMatch(main, /beamGradId/u);
  assert.match(capacitor, /appName:\s*"同频"/u);
});
