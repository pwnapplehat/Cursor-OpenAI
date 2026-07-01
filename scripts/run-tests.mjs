#!/usr/bin/env node
/**
 * Cross-platform test runner launcher.
 *
 * `node --test test/**\/*.test.ts` looks portable but isn't: it relies on
 * *something* expanding that glob before Node sees it, and what actually
 * does the expanding differs by platform/shell/Node version. Confirmed by
 * real testing (not assumption): it silently resolves correctly on this
 * project's Windows dev machine (a newer Node release apparently matches the
 * literal pattern itself), but fails outright on Linux - `sh`/`dash`
 * (npm's default script-shell there) doesn't do `**` recursive expansion the
 * way bash with `shopt -s globstar` does, and older Node's `--test` doesn't
 * do its own glob matching for a literal unexpanded argument either. This
 * broke both of this project's own GitHub Actions CI runs on ubuntu-latest.
 *
 * Fix: never depend on shell glob expansion or Node-version-specific
 * behavior for this. Walk the `test/` directory ourselves in plain Node
 * (works identically on every OS/shell/Node version back to 18), collect
 * every `*.test.ts` file, and pass the fully-resolved list straight to
 * `node --test`.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(projectRoot, "test");

function findTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      found.push(...findTestFiles(fullPath));
    } else if (entry.endsWith(".test.ts")) {
      found.push(fullPath);
    }
  }
  return found;
}

const testFiles = findTestFiles(testDir).sort();

if (testFiles.length === 0) {
  console.error(`No *.test.ts files found under ${testDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
  stdio: "inherit",
  cwd: projectRoot,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
