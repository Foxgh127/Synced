import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const retiredEnglishBrand = ["yi", "qi", "kan"].join("");
const retiredChineseBrand = ["一", "起", "看"].join("");

test("tracked paths and contents use only the 同频 / Synced identity", () => {
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const offenders = [];

  for (const relativePath of trackedFiles) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (!existsSync(absolutePath)) continue;
    if (relativePath.toLowerCase().includes(retiredEnglishBrand)) {
      offenders.push(`${relativePath}:path`);
      continue;
    }
    const contents = readFileSync(absolutePath, "utf8");
    if (
      contents.toLowerCase().includes(retiredEnglishBrand) ||
      contents.includes(retiredChineseBrand)
    ) {
      offenders.push(`${relativePath}:content`);
    }
  }

  assert.deepEqual(offenders, []);
});
