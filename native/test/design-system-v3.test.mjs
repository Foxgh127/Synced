import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(projectRoot, "src");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function walk(directory, extension) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(entryPath, extension);
      return entry.isFile() && entryPath.endsWith(extension)
        ? [entryPath]
        : [];
    });
}

const cssFiles = walk(sourceRoot, ".css");
const cssWithoutGeneratedTokens = cssFiles
  .filter((file) => !file.endsWith(path.join("design", "tokens.css")))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
const tsSource = walk(sourceRoot, ".ts")
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");

test("UI 3.0 cascade layers and split modules are deterministic", () => {
  const styles = read("src/styles.css");
  assert.match(
    styles,
    /^@layer reset, tokens, foundations, primitives, components, views, utilities, themes, overrides;/,
  );
  assert.doesNotMatch(styles, /styles-visual-enhancements/);
  assert.match(styles, /legacy\.css" layer\(foundations\)/);
  for (const file of [
    "src/design/reset.css",
    "src/design/foundations.css",
    "src/design/materials.css",
    "src/design/typography.css",
    "src/design/motion.css",
    "src/design/accessibility.css",
    "src/components/button.css",
    "src/components/dialog.css",
    "src/components/popover.css",
    "src/components/tabs.css",
    "src/components/toast.css",
    "src/components/dock.css",
    "src/components/sidebar.css",
    "src/components/media-card.css",
    "src/views/home.css",
    "src/views/join.css",
    "src/views/lobby.css",
    "src/views/theater.css",
    "src/views/companion.css",
    "src/views/broadcast.css",
    "src/views/emby.css",
    "src/views/settings.css",
    "src/views/design-lab.css",
  ]) {
    assert.equal(fs.existsSync(path.join(projectRoot, file)), true, file);
  }
});

test("colors, radii, shadows, blur and z-index stay tokenized", () => {
  assert.doesNotMatch(
    cssWithoutGeneratedTokens,
    /#[0-9a-f]{3,8}\b|(?:rgb|rgba|hsl|hsla)\(\s*[^()]*?\s*\)/i,
  );
  assert.doesNotMatch(
    cssWithoutGeneratedTokens,
    /border-radius:(?!\s*(?:var\(|inherit))\s*[^;]+;/i,
  );
  assert.doesNotMatch(
    cssWithoutGeneratedTokens,
    /box-shadow:(?!\s*(?:var\(|none))\s*[^;]+;/i,
  );
  assert.doesNotMatch(cssWithoutGeneratedTokens, /z-index:\s*-?\d/i);
  assert.doesNotMatch(
    cssWithoutGeneratedTokens,
    /blur\(\s*[0-9.]+px\s*\)/i,
  );
  const generator = read("scripts/generate-design-tokens.mjs");
  for (const tokenSource of [
    "global.json",
    "semantic.json",
    "component.json",
    "palette.json",
    "supplemental.json",
    "motion.json",
  ]) {
    assert.match(generator, new RegExp(tokenSource.replace(".", "\\.")));
  }
});

test("CSS transitions cannot regress to broad or layout/paint-heavy animation", () => {
  assert.doesNotMatch(cssWithoutGeneratedTokens, /transition:\s*all\b/i);
  const transitionValues = [
    ...cssWithoutGeneratedTokens.matchAll(/transition:\s*([^;{}]+);/g),
  ].map((match) => match[1]);
  for (const value of transitionValues) {
    assert.doesNotMatch(
      value,
      /(?:^|,)\s*(?:all|width|height|min-width|max-width|min-height|max-height|top|right|bottom|left|inset|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|border-radius|box-shadow|backdrop-filter)\b/i,
    );
  }
});

test("CSS keyframes stay on compositor-safe transform and opacity", () => {
  for (const match of cssWithoutGeneratedTokens.matchAll(
    /@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g,
  )) {
    const properties = [
      ...match[2].matchAll(/(?:^|[;{]\s*|\n\s*)([\w-]+)\s*:/g),
    ].map((property) => property[1]);
    assert.deepEqual(
      properties.filter(
        (property) => !["opacity", "transform"].includes(property),
      ),
      [],
      match[1],
    );
  }
});

test("the material budget has solid fallbacks and no legacy nested blur", () => {
  const materials = read("src/design/materials.css");
  const legacy = read("src/views/legacy.css");
  assert.match(materials, /\.material-canvas/);
  assert.match(materials, /\.material-mica/);
  assert.match(materials, /\.material-card/);
  assert.match(materials, /\.material-regular/);
  assert.match(materials, /\.material-clear/);
  assert.match(materials, /\.material-smoke/);
  assert.match(materials, /@supports not \(backdrop-filter:/);
  assert.match(materials, /\[data-presence="left"\][\s\S]*?backdrop-filter: none/);
  assert.match(
    materials,
    /:is\(\.material-regular, \.material-clear\)[\s\S]*?:is\(\.material-regular/,
  );
  assert.match(materials, /data-floating-open="true"/);
  assert.match(materials, /data-toast-visible="true"/);
  assert.match(materials, /body\[data-modal-open="true"\]/);
  assert.match(materials, /\.toast\.material-regular:not\(:last-child\)/);
  assert.match(
    read("src/ui/floating-surface.ts"),
    /dataset\.floatingTop = "true"/,
  );
  assert.match(read("src/main.ts"), /syncToastMaterialBudget/);
  assert.doesNotMatch(legacy, /(?:-webkit-)?backdrop-filter\s*:/);
  assert.doesNotMatch(legacy, /Visual enhancements —|Migrated visual rules/);
  for (const file of cssFiles.filter(
    (file) => !file.endsWith(path.join("design", "materials.css")),
  )) {
    assert.doesNotMatch(
      fs.readFileSync(file, "utf8"),
      /(?:-webkit-)?backdrop-filter:\s*blur\(/,
      file,
    );
  }
  assert.doesNotMatch(tsSource, /\bglass-[a-z]+\b/);
});

test("motion, presence, dialog and floating surfaces use cancelable latest-state control", () => {
  const motion = read("src/ui/motion-controller.ts");
  const effects = read("src/ui/effects-quality.ts");
  const presence = read("src/ui/presence-controller.ts");
  const dialog = read("src/ui/dialog-controller.ts");
  const floating = read("src/ui/floating-surface.ts");
  assert.match(motion, /runningAnimations = new Set<Animation>/);
  assert.match(motion, /animation\.finish\(\)/);
  assert.match(motion, /synced:motion-preference-change/);
  assert.match(effects, /synced:motion-preference-change/);
  assert.match(presence, /generation !== this\.generation/);
  assert.match(presence, /cancelElementMotion/);
  assert.match(dialog, /private active\?: HTMLDialogElement/);
  assert.match(dialog, /this\.active && this\.active !== dialog/);
  assert.match(dialog, /dismiss\(/);
  assert.match(dialog, /this\.focus\.trap\(dialog, opener\)/);
  for (const behavior of ["autoUpdate(", "flip(", "shift(", "size("]) {
    assert.equal(floating.includes(behavior), true, behavior);
  }
  assert.match(floating, /openSurfaces\.at\(-1\)/);
  assert.match(floating, /closeTopmostFloatingSurface/);
  assert.match(floating, /document\.body\.append\(surface\)/);
  assert.match(floating, /document\.fullscreenElement/);
  assert.match(floating, /fullscreenElement\.contains\(this\.reference\)/);
  assert.match(floating, /this\.syncPortalHost\(\)/);
  assert.match(floating, /private operation = 0/);
  assert.match(floating, /operation !== this\.operation/);
});

test("home, create, join and trust flows match the current product model", () => {
  const main = read("src/main.ts");
  const rail =
    main.match(
      /function railMarkup\(\): string \{[\s\S]*?\n\}\n\nfunction bindRailNavigation/,
    )?.[0] || "";
  assert.match(main, /创建频道/);
  assert.match(main, /加入频道/);
  assert.match(main, /QUICK JOIN/);
  assert.match(main, /快捷加入/);
  assert.match(main, /recentHomeMarkup\(\)/);
  assert.match(main, /class="app-frame home-frame"/);
  assert.match(main, /homeProfileMarkup\(\)/);
  const homeStart = main.indexOf("function renderDesktopHome");
  const homeEnd = main.indexOf("async function renderHost", homeStart);
  const home = main.slice(homeStart, homeEnd);
  assert.doesNotMatch(home, /railMarkup\(\)/);
  assert.doesNotMatch(main, /继续进入/);
  assert.doesNotMatch(main, /服务器不保存影片/);
  assert.doesNotMatch(main, /隐私与媒体线路/);
  assert.doesNotMatch(rail, /recent-channel|data-recent-room/);
  assert.match(main, /data-recent-menu/);
  assert.match(main, /data-profile-popover/);
  assert.match(main, /data-home-settings/);
  assert.match(main, /class="home-profile-rename profile-action"/);
  assert.match(main, /className = "security-sheet"/);
  assert.match(main, /scanQrCode/);
  assert.match(main, /parseJoinLink\(value\)/);
  assert.match(main, /joinAbortController\?\.abort\(\)/);
  assert.match(main, /await import\("\.\/channel-session"\)/);
  assert.doesNotMatch(main, /window\.(?:confirm|prompt)\(/);
});

test("player, Companion, source and Emby surfaces expose the required semantics", () => {
  const session = read("src/channel-session.ts");
  const companion = read("src/room-companion.ts");
  assert.match(
    session,
    /class="channel-empty channel-lobby interactive-card"/,
  );
  assert.match(session, /class="dock-cluster dock-transport"/);
  assert.match(session, /data-lucide="message-square-text"/);
  assert.match(session, /id="dock-shortcuts"/);
  assert.match(session, /playback-diagnostics-dialog/);
  assert.match(session, /AmbientLightController/);
  assert.match(session, /role="listbox"[\s\S]*?aria-label="可分享窗口"/);
  assert.match(session, /role="option"[\s\S]*?aria-selected=/);
  assert.match(session, /selected-source-summary/);
  assert.match(session, /broadcastModeAbort\?\.abort\(\)/);
  assert.match(session, /new VirtualGrid/);
  assert.match(session, /::view-transition|view-transition-name/);
  assert.match(companion, /class="chat-card" id="chat-panel"/);
  assert.match(companion, /class="voice-card" id="member-panel"/);
  assert.doesNotMatch(companion, /role="tablist"|data-companion-tab/);
  assert.doesNotMatch(companion, /voice-control-bar/);
  assert.match(companion, /chat-jump-latest/);
  assert.match(companion, /RECENT_EMOJI_KEY/);
  assert.match(companion, /is-grouped/);
  assert.match(companion, /new FloatingSurface\(emojiToggle/);
  assert.doesNotMatch(companion, /new FloatingSurface\(deviceButton/);
  assert.match(companion, /voice-settings-visible/);
  assert.match(companion, /new PresenceController\(devicePanel/);
  assert.match(companion, /deviceSettingsPresence\?\.show/);
  assert.match(companion, /deviceSettingsPresence\?\.hide/);
  assert.doesNotMatch(companion, /id="panel-toggle"|id="voice-quality"/);
  assert.match(companion, /MAX_ROOM_PARTICIPANTS = protocolPolicy\.maxParticipantsPerRoom/);
});

test("Android keeps Companion inline and Back closes the topmost transient surface", () => {
  const session = read("src/channel-session.ts");
  const companionStyles = read("src/views/companion.css");
  const main = read("src/main.ts");
  assert.match(session, /mobilePanelQuery = window\.matchMedia\("\(max-width: 899px\)"\)/);
  assert.match(session, /usesInlineCompanion/);
  assert.match(session, /targetElement\?\.scrollIntoView/);
  assert.match(session, /dialogController\.closeTopmost\(\)/);
  assert.match(session, /closeTopmostFloatingSurface\(\)/);
  assert.match(main, /App\.addListener\("backButton"/);
  assert.match(companionStyles, /@media \(max-width:\s*899px\)/);
  assert.match(companionStyles, /body:not\(\.mode-immersive\)[\s\S]*?position:\s*static/);
  assert.match(companionStyles, /> \.chat-card\s*\{[\s\S]*?order:\s*1/);
  assert.match(companionStyles, /> \.voice-card\s*\{[\s\S]*?order:\s*2/);
  assert.match(companionStyles, /safe-area-inset-bottom/);
  assert.doesNotMatch(session, /sheetDragFrame|usesMobileSheet|splitCompanionQuery/);
  assert.doesNotMatch(companionStyles, /panel-mobile-sheet/);
});

test("effects degrade using visibility, Android, GPU, memory, battery and thermal state", () => {
  const effects = read("src/ui/effects-quality.ts");
  const monitor = read("src/resource-monitor.ts");
  const budget = read("src/resource-budget.ts");
  for (const signal of [
    "document.hidden",
    "isNativeAndroid()",
    "gpuTier",
    "pressure",
  ]) {
    assert.equal(effects.includes(signal), true, signal);
  }
  assert.match(effects, /swiftshader|llvmpipe/);
  assert.match(monitor, /getBattery/);
  assert.match(budget, /thermalStatus/);
  assert.match(budget, /batteryLevel/);
  assert.match(budget, /powerSaveMode/);
  assert.match(budget, /deviceMemoryGiB/);
});

test("ambient light, stars and pointer lighting honor the performance budget", () => {
  const main = read("src/main.ts");
  const ambient = read("src/ui/ambient-light.ts");
  const pointer = read("src/ui/pointer-light.ts");
  const stars = read("src/ui/star-field.ts");
  assert.match(
    stars,
    /window\.innerWidth >= 1_440[\s\S]*?\? 72[\s\S]*?window\.innerWidth >= 700[\s\S]*?\? 48[\s\S]*?: 36/,
  );
  assert.match(stars, /Math\.min\(window\.devicePixelRatio \|\| 1, 1\.75\)/);
  assert.match(stars, /document\.hidden/);
  assert.match(stars, /risePerSecond: \(Math\.random\(\) \* 5\.2 \+ 2\.8\)/);
  assert.match(stars, /canvas\.dataset\.starFrame/);
  assert.match(main, /bindStarField\(canvas, controller\.signal\)/);
  assert.match(main, /starController\?\.abort\(\)/);
  assert.match(pointer, /pointer:\s*fine/);
  assert.match(pointer, /requestAnimationFrame/);
  assert.match(pointer, /querySelectorAll<HTMLElement>\("\.interactive-card"\)/);
  assert.doesNotMatch(main, /cursor-glow/);
  assert.match(ambient, /canvas\.width = 32/);
  assert.match(ambient, /canvas\.height = 18/);
  assert.match(ambient, /setInterval\(\(\) => this\.sample\(\), 750\)/);
  assert.match(ambient, /dynamic-range: high/);
  assert.match(ambient, /budget\.pressure !== "normal"/);
});

test("the accessibility matrix and Design Lab are first-class implementation surfaces", () => {
  const accessibility = read("src/design/accessibility.css");
  const reset = read("src/design/reset.css");
  const designLab = read("src/ui/design-lab.ts");
  const allViewCss = cssFiles
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  assert.match(accessibility, /prefers-reduced-motion/);
  assert.match(accessibility, /prefers-contrast:\s*more/);
  assert.match(accessibility, /forced-colors:\s*active/);
  assert.match(reset, /min-height:\s*var\(--control-min,\s*44px\)/);
  assert.match(allViewCss, /@container/);
  for (const state of [
    "Enabled",
    "Hover",
    "Focused",
    "Pressed",
    "Selected",
    "Dragged",
    "Disabled",
    "Loading",
    "空状态",
    "成功",
    "警告",
    "错误",
    "离线",
    "重连中",
    "权限被拒绝",
    "超长内容",
    "协议上限 · 8 人",
    "减少动态",
    "降低透明度",
    "高对比度",
  ]) {
    assert.equal(designLab.includes(state), true, state);
  }
});

test("all static UI glyphs use the curated Lucide registry", () => {
  const icons = read("src/ui/icons.ts");
  const iconNames = new Set(
    [...tsSource.matchAll(/data-lucide="([a-z0-9-]+)"/g)].map(
      (match) => match[1],
    ),
  );
  for (const iconName of iconNames) {
    const exportName = iconName
      .split("-")
      .map((part) =>
        /^[a-z]+$/i.test(part)
          ? part[0].toUpperCase() + part.slice(1)
          : part.toUpperCase(),
      )
      .join("")
      .replace("Ccw", "Ccw")
      .replace("Cw", "Cw");
    assert.match(icons, new RegExp(`\\b${exportName}\\b`), iconName);
  }
  assert.doesNotMatch(tsSource, />\s*[×＋]\s*<\/button>/);
  const nonBrandSvgSource = tsSource.replace(
    /const MUSIC_PRESETS:[^=]+=\s*\[[\s\S]*?\n\];/,
    "",
  );
  assert.doesNotMatch(nonBrandSvgSource, /<svg\b/);
});

test("race-prone UI flows converge without guessed animation delays", () => {
  const main = read("src/main.ts");
  const session = read("src/channel-session.ts");
  const music = read("src/channel-music.ts");
  assert.match(main, /id:\s*"toast-presence"/);
  assert.match(main, /element\.dataset\.presence !== "leaving"/);
  assert.match(main, /cancelElementMotion\(existing\.element, "toast-presence"\)/);
  assert.match(session, /broadcastModeAbort\?\.abort\(\)/);
  assert.match(session, /mobilePanelQuery\.addEventListener/);
  assert.doesNotMatch(session, /sheetDragFrame|resetSheetDrag/);
  assert.match(session, /dockChatPresence\.hide/);
  assert.doesNotMatch(session, /dockChatCloseTimer/);
  assert.match(music, /Promise\.allSettled\(\[opening, refreshing\]\)/);
});

test("source templates contain no inline style, native confirm, or prompt escape hatches", () => {
  assert.doesNotMatch(tsSource, /\sstyle="/);
  assert.doesNotMatch(tsSource, /window\.(?:confirm|prompt)\(/);
});
