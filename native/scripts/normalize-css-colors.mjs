import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const sourceDirectory = new URL("./src/", root);
const tokenDirectory = new URL("./src/design/tokens/", root);
const paletteUrl = new URL("palette.json", tokenDirectory);
const supplementalUrl = new URL("supplemental.json", tokenDirectory);
const generatedTokenPath = fileURLToPath(
  new URL("./src/design/tokens.css", root),
);
const legacyStylePath = fileURLToPath(
  new URL("./src/views/legacy.css", root),
);
const check = process.argv.includes("--check");
const colorPattern =
  /#[0-9a-fA-F]{3,8}\b|(?:rgb|rgba|hsl|hsla)\(\s*[^()]*?\s*\)/g;
const wholeColorPattern =
  /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[^()]*?\s*\))$/;
const wholeVariablePattern = /^var\(--[a-z0-9-]+\)$/i;

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && path.endsWith(".css") ? [path] : [];
  });
}

function canonical(value) {
  if (value.startsWith("#")) return value.toLowerCase();
  const bracket = value.indexOf("(");
  const name = value.slice(0, bracket).toLowerCase();
  const parts = value
    .slice(bracket + 1, -1)
    .split(",")
    .map((part) => part.trim().replace(/^(-?)\./, "$10."));
  return `${name}(${parts.join(", ")})`;
}

function canonicalCssValue(value) {
  return value.trim().replace(/\s+/g, " ");
}

function readVariables(name) {
  return JSON.parse(
    readFileSync(new URL(name, tokenDirectory), "utf8"),
  ).variables;
}

let palette = {};
try {
  palette = readVariables("palette.json");
} catch {
  // The first migration creates the supplemental palette.
}
let supplemental = {};
try {
  supplemental = readVariables("supplemental.json");
} catch {
  // The first design normalization creates supplemental shape/effect tokens.
}

const knownByValue = new Map();
for (const name of [
  "global.json",
  "semantic.json",
  "component.json",
]) {
  for (const [token, value] of Object.entries(readVariables(name))) {
    if (typeof value === "string" && wholeColorPattern.test(value)) {
      knownByValue.set(canonical(value), token);
    }
  }
}
for (const [token, value] of Object.entries(palette)) {
  knownByValue.set(canonical(value), token);
}

const allNamedVariables = Object.assign(
  {},
  ...[
    "global.json",
    "semantic.json",
    "component.json",
  ].map(readVariables),
  supplemental,
);
const effectTokens = {
  radius: new Map(),
  shadow: new Map(),
  z: new Map(),
  blur: new Map(),
};
for (const [token, value] of Object.entries(allNamedVariables)) {
  if (typeof value !== "string") continue;
  const normalized = canonicalCssValue(value);
  if (/^(?:r-|radius)/.test(token)) {
    effectTokens.radius.set(normalized, token);
  }
  if (/^(?:e-|shadow|glass-top-highlight)/.test(token)) {
    effectTokens.shadow.set(normalized, token);
  }
  if (/^z-/.test(token)) effectTokens.z.set(normalized, token);
  if (/^blur-/.test(token)) effectTokens.blur.set(normalized, token);
}

function supplementalToken(kind, value) {
  const normalized = canonicalCssValue(value);
  const known = effectTokens[kind].get(normalized);
  if (known) return known;
  const digest = createHash("sha1")
    .update(`${kind}:${normalized}`)
    .digest("hex")
    .slice(0, 10);
  const token = `${kind}-${digest}`;
  effectTokens[kind].set(normalized, token);
  supplemental[token] = normalized;
  return token;
}

function splitCssList(value) {
  const entries = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries;
}

const prohibitedTransitionProperty =
  /^(?:all|width|height|min-width|max-width|min-height|max-height|top|right|bottom|left|inset|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|border-radius|box-shadow|backdrop-filter)\b/i;

function normalizeEffects(source) {
  let normalized = source.replace(
    /border-radius:\s*([^;{}]+);/g,
    (declaration, value) => {
      const clean = canonicalCssValue(value);
      if (
        clean === "inherit" ||
        wholeVariablePattern.test(clean)
      ) {
        return declaration;
      }
      return `border-radius: var(--${supplementalToken("radius", clean)});`;
    },
  );
  normalized = normalized.replace(
    /box-shadow:\s*([^;{}]+);/g,
    (declaration, value) => {
      const clean = canonicalCssValue(value);
      if (clean === "none" || wholeVariablePattern.test(clean)) {
        return declaration;
      }
      return `box-shadow: var(--${supplementalToken("shadow", clean)});`;
    },
  );
  normalized = normalized.replace(
    /z-index:\s*(-?(?:\d+)(?:\.\d+)?);/g,
    (_declaration, value) =>
      `z-index: var(--${supplementalToken("z", value)});`,
  );
  normalized = normalized.replace(
    /blur\(\s*([0-9.]+px)\s*\)/g,
    (_expression, value) =>
      `blur(var(--${supplementalToken("blur", value)}))`,
  );
  normalized = normalized.replace(
    /transition:\s*([^;{}]+);/g,
    (_declaration, value) => {
      const allowed = splitCssList(value)
        .map((entry) => canonicalCssValue(entry))
        .filter(
          (entry) =>
            entry && !prohibitedTransitionProperty.test(entry),
        );
      return allowed.length
        ? `transition: ${allowed.join(", ")};`
        : "transition: none;";
    },
  );
  return normalized;
}

const files = walk(fileURLToPath(sourceDirectory)).filter(
  (path) => resolve(path) !== resolve(generatedTokenPath),
);
const pending = new Map();
for (const path of files) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(colorPattern)) {
    const value = canonical(match[0]);
    if (knownByValue.has(value)) continue;
    const digest = createHash("sha1").update(value).digest("hex").slice(0, 10);
    const token = `palette-${digest}`;
    knownByValue.set(value, token);
    palette[token] = value;
  }
}

let changedFiles = 0;
for (const path of files) {
  const source = readFileSync(path, "utf8");
  let normalized = normalizeEffects(source);
  normalized = normalized.replace(colorPattern, (value) => {
    const token = knownByValue.get(canonical(value));
    return token ? `var(--${token})` : value;
  });
  if (resolve(path) === resolve(legacyStylePath)) {
    normalized = normalized.replace(
      /^\s*(?:-webkit-)?backdrop-filter\s*:[^;]+;\r?\n/gm,
      "",
    );
  }
  if (normalized === source) continue;
  changedFiles += 1;
  if (!check) writeFileSync(path, normalized, "utf8");
}

if (check && changedFiles > 0) {
  console.error(
    `${changedFiles} CSS files need design normalization; run npm run design:normalize-colors`,
  );
  process.exitCode = 1;
} else if (!check) {
  palette = Object.fromEntries(
    Object.entries(palette).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  writeFileSync(
    paletteUrl,
    `${JSON.stringify({ variables: palette }, null, 2)}\n`,
    "utf8",
  );
  supplemental = Object.fromEntries(
    Object.entries(supplemental).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  writeFileSync(
    supplementalUrl,
    `${JSON.stringify({ variables: supplemental }, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `normalized ${changedFiles} CSS files; palette has ${Object.keys(palette).length} colors and supplemental has ${Object.keys(supplemental).length} shape/effect tokens`,
  );
}
