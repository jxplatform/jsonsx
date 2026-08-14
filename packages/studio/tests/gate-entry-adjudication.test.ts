/**
 * The gate scripts' `if (import.meta.main)` blocks — the lines CI runs and `bun test` never sees.
 *
 * Every other test of these scripts imports their pure functions, so the module evaluates with
 * `import.meta.main === false` and the entry block is dead in the runner. Nothing about it is
 * unreachable: `import.meta.main` is `import.meta.path === Bun.main`, `Bun.main` is writable, and a
 * stubbed `process.exit` keeps the block from killing the runner. Point `Bun.main` at the script,
 * import it, and the block runs in process with its exit code observable.
 *
 * This file must never statically import the scripts it drives — the first evaluation wins, and it
 * has to be the one with `Bun.main` already pointed at the file.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const STUDIO_SCRIPTS = join(import.meta.dir, "..", "scripts");
const REPO_SCRIPTS = join(import.meta.dir, "..", "..", "..", "scripts");

/** Evaluate `script` as the process entry point, collecting what it exits with and what it says. */
async function runEntry(
  script: string,
  argv: readonly string[] = [],
): Promise<{ codes: number[]; out: string }> {
  const codes: number[] = [];
  const said: string[] = [];
  const mutableProcess = process as unknown as {
    argv: string[];
    exit: (code?: number) => never;
  };
  const mutableBun = Bun as unknown as { main: string };
  const realExit = process.exit;
  const realArgv = process.argv;
  const realMain = Bun.main;
  const realLog = console.log;
  mutableProcess.exit = (code?: number): never => {
    codes.push(code ?? 0);
    throw new Error("process.exit");
  };
  mutableProcess.argv = [realArgv[0] as string, script, ...argv];
  mutableBun.main = script;
  console.log = (...parts: unknown[]): void => {
    said.push(parts.map(String).join(" "));
  };
  try {
    await import(script);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "process.exit") {
      throw error;
    }
  } finally {
    console.log = realLog;
    mutableProcess.exit = realExit;
    mutableProcess.argv = realArgv;
    mutableBun.main = realMain;
  }
  return { codes, out: said.join("\n") };
}

/**
 * The three live-tree scans glob and parse every source and style file in the workspace, which is
 * seconds of real work — `check-pane-singletons` alone took 5.04s under a loaded full-suite run and
 * timed out on the 5s default. They are given room rather than trimmed, because the thing being
 * asserted IS the gate's verdict over the whole tree; a scan narrowed to be fast would assert
 * less.
 */
const TREE_SCAN_TIMEOUT_MS = 60_000;

test(
  "check-icons' entry block reports the live tree and exits with report()'s code",
  async () => {
    const run = await runEntry(join(STUDIO_SCRIPTS, "check-icons.ts"));
    expect(run.codes).toEqual([0]);
    expect(run.out).toContain("✓ check-icons:");
    expect(run.out).toContain("panel key(s) resolved");
  },
  TREE_SCAN_TIMEOUT_MS,
);

test(
  "check-styles' entry block reports the live tree and exits with report()'s code",
  async () => {
    const run = await runEntry(join(STUDIO_SCRIPTS, "check-styles.ts"));
    expect(run.codes).toEqual([0]);
    expect(run.out).toContain("✓ check-styles: no hard-coded colours");
  },
  TREE_SCAN_TIMEOUT_MS,
);

test(
  "check-pane-singletons' entry block reports the live tree and exits with its code",
  async () => {
    const run = await runEntry(join(STUDIO_SCRIPTS, "check-pane-singletons.ts"));
    expect(run.codes).toEqual([0]);
    expect(run.out).toContain("✓ check-pane-singletons:");
  },
  TREE_SCAN_TIMEOUT_MS,
);

test("check-image-lock's entry block exits with the code main() derived from argv", async () => {
  const run = await runEntry(join(REPO_SCRIPTS, "check-image-lock.ts"), ["--wat"]);
  expect(run.codes).toEqual([2]);
});

test("check-shot-contract's entry block exits 1 on a manifest that violates the contract", async () => {
  const run = await runEntry(join(REPO_SCRIPTS, "check-shot-contract.ts"), [
    "--manifest",
    "scripts/screenshots/fixtures/contract/stale-ids.json",
    "--commands",
    "scripts/screenshots/fixtures/contract/commands.ts",
  ]);
  expect(run.codes).toEqual([1]);
});
