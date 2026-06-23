// Fails when a package source file never appears in coverage data, i.e. no
// Test imports it. Bun's coverage only counts files loaded during the run, so
// CoverageThreshold alone cannot catch a source file shipped with zero tests.
//
// Usage: bun scripts/check-coverage-manifest.ts packages/<pkg>
// Expects <pkg>/coverage/lcov.info from `bun test --coverage` (lcov reporter
// Is enabled in each package's bunfig.toml).
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

// Files exempt from the every-source-file-is-tested rule: pure type
// Declarations (erased at runtime, never produce coverage rows) and tiny
// Side-effect entry shims with no testable logic.
const ALLOWLIST = new Set([
  "src/types.ts",
  "src/init.ts",
  "src/chromium/init.ts",
  // Desktop RPC schema: interfaces/type aliases only, no runtime exports.
  "src/rpc-schema.ts",
]);

const pkgArg = process.argv.at(2);
if (!pkgArg) {
  console.error("Usage: bun scripts/check-coverage-manifest.ts packages/<pkg>");
  process.exit(2);
}

const pkgDir = resolve(pkgArg);
const lcovPath = join(pkgDir, "coverage", "lcov.info");
if (!existsSync(lcovPath)) {
  console.error(
    `No coverage data at ${lcovPath} — run \`bun test --isolate --coverage\` in ${pkgArg} first.`,
  );
  process.exit(2);
}

const lcov = await Bun.file(lcovPath).text();
const covered = new Set<string>();
for (const line of lcov.split("\n")) {
  if (!line.startsWith("SF:")) {
    continue;
  }
  const path = line.slice(3).trim();
  // Skip synthetic modules (data: URLs) and anything outside the package.
  if (path.includes(":") && !isAbsolute(path)) {
    continue;
  }
  const rel = isAbsolute(path) ? relative(pkgDir, path) : path;
  if (rel.startsWith("..")) {
    continue;
  }
  // Normalize to forward slashes so comparisons hold on Windows, where both
  // `relative()` and Bun.Glob yield backslash-separated paths but the ALLOWLIST
  // (and SF: entries from a POSIX-built lcov) use forward slashes.
  covered.add(rel.replaceAll("\\", "/"));
}

// Source layout: packages use src/**; @jxsuite/create keeps its sources at the
// Package root (index.ts, generate.ts).
const hasSrc = existsSync(join(pkgDir, "src"));
const glob = new Bun.Glob(hasSrc ? "src/**/*.ts" : "*.ts");
const missing: string[] = [];
for (const rawFile of glob.scanSync({ cwd: pkgDir })) {
  const file = rawFile.replaceAll("\\", "/");
  if (file.endsWith(".d.ts")) {
    continue;
  }
  if (ALLOWLIST.has(file)) {
    continue;
  }
  if (!covered.has(file)) {
    missing.push(file);
  }
}

if (missing.length > 0) {
  console.error(
    `${pkgArg}: ${missing.length} source file(s) absent from coverage data (no test imports them):`,
  );
  for (const file of missing.toSorted()) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}
console.log(`${pkgArg}: all ${hasSrc ? "src" : "root"} source files appear in coverage data.`);
