// Fails when a package source file never appears in coverage data, i.e. no
// Test imports it. Bun's coverage only counts files loaded during the run, so
// CoverageThreshold alone cannot catch a source file shipped with zero tests.
//
// Usage: bun scripts/check-coverage-manifest.ts packages/<pkg>
// Expects <pkg>/coverage/lcov.info from `bun test --coverage` (lcov reporter
// Is enabled in each package's bunfig.toml).
//
// ── Why a missing file gets a second question, not a verdict ──────────────────
//
// The gate's sentence ("no test imports them") is an INFERENCE from an absence,
// And on 20-21 Aug 2026 that inference was wrong. Bun 1.4.0 (+34cbb9a40) left
// `src/editor/convert-to-repeater.ts` out of the studio lcov on CI, in a run
// Whose log shows all fourteen of that file's tests passing against the real
// Implementation — opening its dialog, creating state defs, committing its
// Transaction. A mock cannot do those things, so the module was loaded, was
// Executed, and was still absent from both the lcov and the coverage table.
//
// That drop has since been reduced to a rule, and the rule has nothing to do
// With CI (jxsuite/jx#240). A source file M is omitted from BOTH the lcov and
// The table when a test file A that fires TWO OR MORE un-awaited `import("M")`
// Calls, from separate tests, runs BEFORE a test file B that imports M for real
// — and B's tests still pass against the real M throughout. One fire is not
// Enough; two is. It reproduces in five files with no jx code in them.
//
// It read as CI-only because the lever is `readdir` order and nothing else.
// `bun test` 1.4.0 IGNORES the order of its file arguments and re-scans the
// Test directory, so the "replay of CI's exact file order" that this comment
// Used to cite as ruling order out never replayed an order at all. The same
// Clone flips between recording and not when either file is rewritten, which is
// Also why a static import from the test did not move it.
//
// The trigger is gone from this repo — `tests/commands-defaults.test.ts` doubles
// The converter, which its two siblings already did — so nothing here should be
// Rescued today. The adjudication stays anyway, because the next such defect
// Will announce itself the same way: as an absence that means the opposite of
// What it says.
//
// So when a file is missing, ask the smaller question that has a definite
// Answer: re-run coverage over just the tests that name it. A file no test
// Exercises stays absent (nothing loads it) and still fails the gate — that is
// The regression this script exists to catch, and it is untouched. A file the
// Suite did run comes back with real counts, and those counts are then held to
// The same per-file `coverageThreshold` the workspace's bunfig applies, so a
// Rescued file is still gated on its coverage rather than waved through.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

// Files exempt from the every-source-file-is-tested rule: pure type
// Declarations (erased at runtime, never produce coverage rows) and tiny
// Side-effect entry shims with no testable logic.
export const ALLOWLIST = new Set([
  "src/types.ts",
  "src/init.ts",
  "src/chromium/init.ts",
  // Desktop RPC schema: interfaces/type aliases only, no runtime exports.
  "src/rpc-schema.ts",
  // Collab provider contract: interfaces/type aliases only, no runtime exports.
  "src/provider.ts",
]);

/** Per-file totals as lcov records them: `FNF`/`FNH` for functions, `LF`/`LH` for lines. */
export interface FileTotals {
  functionsFound: number;
  functionsHit: number;
  linesFound: number;
  linesHit: number;
}

/** The ratio form of {@link FileTotals}, which is what a `coverageThreshold` is expressed in. */
export interface Ratios {
  functions: number;
  lines: number;
}

/**
 * Workspace-relative path of an `SF:` line, or undefined when it names nothing this job owns.
 *
 * `SF:` paths are relative to the cwd the run used (the workspace) but may be absolute; both
 * spellings are normalised here. Synthetic modules (data: URLs) and anything outside the workspace
 * — a sibling package, a repo-level script — are dropped, because they belong to whichever job owns
 * them.
 */
function recordPath(line: string, pkgDir: string): string | undefined {
  if (!line.startsWith("SF:")) {
    return undefined;
  }
  const path = line.slice(3).trim();
  if (path.includes(":") && !isAbsolute(path)) {
    return undefined;
  }
  const rel = isAbsolute(path) ? relative(pkgDir, path) : path;
  if (rel.startsWith("..")) {
    return undefined;
  }
  // Normalize to forward slashes so comparisons hold on Windows, where both
  // `relative()` and Bun.Glob yield backslash-separated paths but the ALLOWLIST
  // (and SF: entries from a POSIX-built lcov) use forward slashes.
  return rel.replaceAll("\\", "/");
}

/** Workspace-relative paths of every file lcov has a record for. */
export function coveredFiles(lcov: string, pkgDir: string): Set<string> {
  const covered = new Set<string>();
  for (const line of lcov.split("\n")) {
    const rel = recordPath(line, pkgDir);
    if (rel !== undefined) {
      covered.add(rel);
    }
  }
  return covered;
}

/** The counts lcov recorded for one workspace-relative file, or undefined if it has no record. */
export function fileTotals(lcov: string, pkgDir: string, file: string): FileTotals | undefined {
  let inFile = false;
  let totals: FileTotals | undefined;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      inFile = recordPath(line, pkgDir) === file;
      if (inFile) {
        totals ??= { functionsFound: 0, functionsHit: 0, linesFound: 0, linesHit: 0 };
      }
      continue;
    }
    if (!inFile || !totals) {
      continue;
    }
    const [key, value] = line.split(":");
    const count = Number(value);
    if (Number.isNaN(count)) {
      continue;
    }
    if (key === "FNF") {
      totals.functionsFound = count;
    } else if (key === "FNH") {
      totals.functionsHit = count;
    } else if (key === "LF") {
      totals.linesFound = count;
    } else if (key === "LH") {
      totals.linesHit = count;
    }
  }
  return totals;
}

/**
 * Every source file the every-file-is-tested rule applies to.
 *
 * Source layout: packages use src/**; @jxsuite/create keeps its sources at the Package root
 * (index.ts, generate.ts).
 */
export function sourceFiles(pkgDir: string): string[] {
  const hasSrc = existsSync(join(pkgDir, "src"));
  const glob = new Bun.Glob(hasSrc ? "src/**/*.ts" : "*.ts");
  const files: string[] = [];
  for (const rawFile of glob.scanSync({ cwd: pkgDir })) {
    const file = rawFile.replaceAll("\\", "/");
    if (file.endsWith(".d.ts") || ALLOWLIST.has(file)) {
      continue;
    }
    files.push(file);
  }
  return files.toSorted();
}

/**
 * Test files whose text names `sourceFile`, as the specifier an import of it would carry.
 *
 * The needle is the module path without its extension (`src/editor/convert-to-repeater`), which is
 * A suffix of every relative specifier that reaches it (`../src/editor/convert-to-repeater`,
 * `../../src/editor/convert-to-repeater.js`) and is specific enough that a file called `index.ts`
 * does not drag in the whole suite. Naming a module is not the same as loading it — a file that
 * Only `mock.module()`s this path matches too, and contributes nothing to the re-run's coverage,
 * Which is exactly right: the re-run answers "did anything LOAD it", not "who mentions it".
 */
export function testsNaming(pkgDir: string, sourceFile: string): string[] {
  const needle = sourceFile.replace(/\.ts$/, "");
  const found: string[] = [];
  for (const rawFile of new Bun.Glob("**/*.test.ts").scanSync({ cwd: pkgDir })) {
    const file = rawFile.replaceAll("\\", "/");
    if (file.includes("node_modules/")) {
      continue;
    }
    if (readFileSync(join(pkgDir, file), "utf8").includes(needle)) {
      found.push(file);
    }
  }
  return found.toSorted();
}

/**
 * Re-run coverage over `testFiles` alone and return the lcov it produces.
 *
 * The exit status is deliberately ignored: a partial run trips the workspace's aggregate
 * `coverageThreshold` and exits non-zero while still writing a complete report, and the report is
 * The only thing this asks for.
 */
export async function focusedCoverage(pkgDir: string, testFiles: string[]): Promise<string> {
  if (testFiles.length === 0) {
    return "";
  }
  const dir = mkdtempSync(join(tmpdir(), "jx-coverage-recheck-"));
  try {
    await Bun.spawn(
      [
        process.execPath,
        "test",
        "--isolate",
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${dir}`,
        ...testFiles,
      ],
      { cwd: pkgDir, stderr: "ignore", stdout: "ignore" },
    ).exited;
    const lcov = join(dir, "lcov.info");
    return existsSync(lcov) ? await Bun.file(lcov).text() : "";
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/** The workspace's own per-file coverage bar, as Bun reads it from that workspace's bunfig. */
export function coverageThreshold(pkgDir: string): Partial<Ratios> {
  const bunfig = join(pkgDir, "bunfig.toml");
  if (!existsSync(bunfig)) {
    return {};
  }
  try {
    const parsed = Bun.TOML.parse(readFileSync(bunfig, "utf8")) as {
      test?: { coverageThreshold?: number | Partial<Ratios> };
    };
    const threshold = parsed.test?.coverageThreshold;
    if (typeof threshold === "number") {
      return { functions: threshold, lines: threshold };
    }
    return threshold ?? {};
  } catch {
    return {};
  }
}

export type Verdict =
  | { file: string; kind: "absent"; tests: string[] }
  | { file: string; kind: "below"; ratios: Ratios; tests: string[] }
  | { file: string; kind: "rescued"; ratios: Ratios; tests: string[] };

/** True when `ratios` clears every bar the workspace declares. */
export function clears(ratios: Ratios, bar: Partial<Ratios>): boolean {
  return (
    (bar.lines === undefined || ratios.lines >= bar.lines) &&
    (bar.functions === undefined || ratios.functions >= bar.functions)
  );
}

/** Counts for `file` from a re-run over `tests`, or undefined if that run did not record it. */
export async function totalsFor(
  pkgDir: string,
  tests: string[],
  file: string,
): Promise<FileTotals | undefined> {
  const lcov = await focusedCoverage(pkgDir, tests);
  const totals = lcov ? fileTotals(lcov, pkgDir, file) : undefined;
  return totals && totals.linesFound > 0 ? totals : undefined;
}

/**
 * Decide what a file missing from the main report really is, by re-running the tests that name it.
 *
 * `absent` — nothing loaded it, which is the regression this gate exists to catch. `rescued` — the
 * suite does exercise it and clears the bar; the main report simply lost it. `below` — it is
 * exercised but under the workspace's threshold, which is still a failure.
 */
export async function adjudicate(pkgDir: string, file: string): Promise<Verdict> {
  const tests = testsNaming(pkgDir, file);
  let totals = await totalsFor(pkgDir, tests, file);
  if (!totals && tests.length > 1) {
    // The defect this path exists for is a property of a LARGE run — 425 test contexts, two of
    // Which load the file. A combined re-run is already a far smaller question than that, but if
    // It somehow cannot see the file either, ask the smallest question there is: one test file at
    // A time. Only reached when the gate is failing anyway, so the extra spawns cost nothing real.
    for (const test of tests) {
      totals = await totalsFor(pkgDir, [test], file);
      if (totals) {
        break;
      }
    }
  }
  if (!totals) {
    return { file, kind: "absent", tests };
  }
  const ratios = {
    functions: totals.functionsFound === 0 ? 1 : totals.functionsHit / totals.functionsFound,
    lines: totals.linesHit / totals.linesFound,
  };
  return clears(ratios, coverageThreshold(pkgDir))
    ? { file, kind: "rescued", ratios, tests }
    : { file, kind: "below", ratios, tests };
}

const percent = (ratio: number) => `${(ratio * 100).toFixed(2)}%`;

async function main() {
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

  const covered = coveredFiles(await Bun.file(lcovPath).text(), pkgDir);
  const missing = sourceFiles(pkgDir).filter((file) => !covered.has(file));

  if (missing.length === 0) {
    const hasSrc = existsSync(join(pkgDir, "src"));
    console.log(`${pkgArg}: all ${hasSrc ? "src" : "root"} source files appear in coverage data.`);
    return;
  }

  console.error(
    `${pkgArg}: ${missing.length} source file(s) absent from the run's coverage data. ` +
      `Re-running the tests that name each one, to tell "never tested" from "Bun lost the record".`,
  );
  const verdicts: Verdict[] = [];
  for (const file of missing) {
    verdicts.push(await adjudicate(pkgDir, file));
  }

  for (const verdict of verdicts) {
    if (verdict.kind !== "rescued") {
      continue;
    }
    console.error(
      `\n⚠️  ${verdict.file} IS exercised: ${percent(verdict.ratios.lines)} of lines and ` +
        `${percent(verdict.ratios.functions)} of functions, under ${verdict.tests.length} test ` +
        `file(s) that name it (e.g. ${verdict.tests[0]}). It is missing from the full run's ` +
        `report because Bun dropped the record, not because it is untested — see the note at the ` +
        `top of scripts/check-coverage-manifest.ts.`,
    );
  }

  const failures = verdicts.filter((verdict) => verdict.kind !== "rescued");
  if (failures.length === 0) {
    console.log(
      `\n${pkgArg}: every source file is exercised — ${verdicts.length} of them provable only on ` +
        `the re-run.`,
    );
    return;
  }

  console.error(`\n❌ ${failures.length} source file(s) are genuinely not covered:\n`);
  for (const failure of failures) {
    if (failure.kind === "below") {
      console.error(
        `  ${failure.file} — exercised, but ${percent(failure.ratios.lines)} lines / ` +
          `${percent(failure.ratios.functions)} functions is under this workspace's threshold.`,
      );
      continue;
    }
    console.error(
      failure.tests.length === 0
        ? `  ${failure.file} — no test file even names it.`
        : `  ${failure.file} — named by ${failure.tests.length} test file(s) ` +
            `(${failure.tests.map((test) => basename(test)).join(", ")}), but none of them load it.`,
    );
  }
  console.error(`\nNew source files must ship with tests in the same PR (CLAUDE.md).`);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
