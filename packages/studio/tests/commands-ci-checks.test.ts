/**
 * The two CI gates, run as CI runs them: `bun scripts/check-command-levels.ts` and `bun
 * scripts/check-chrome-budget.ts`.
 *
 * Spawned rather than imported, because the exit code IS the contract — a check that reports a
 * violation and exits 0 is worse than no check. The fixtures live in tests/fixtures/commands/.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const FIXTURES = "packages/studio/tests/fixtures/commands";

async function runCheck(script: string, args: string[] = []) {
  const proc = Bun.spawn([process.execPath, join("scripts", script), ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
}

describe("check-command-levels.ts", () => {
  test("passes on the shipped command set", async () => {
    const result = await runCheck("check-command-levels.ts");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("command-levels OK");
  });

  test("passes on a good fixture", async () => {
    const result = await runCheck("check-command-levels.ts", [
      "--source",
      `${FIXTURES}/good-set.ts`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("3 command(s)");
  });

  test("fails on a misplaced command, naming both violations and the reason", async () => {
    const result = await runCheck("check-command-levels.ts", [
      "--source",
      `${FIXTURES}/bad-levels.ts`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("selection.duplicate");
    expect(result.stderr).toContain("commandbar/primary");
    expect(result.stderr).toContain("project.settings");
    expect(result.stderr).toContain("admits only selection");
  });

  test("an over-budget set is still level-legal — the two checks are independent", async () => {
    const result = await runCheck("check-command-levels.ts", [
      "--source",
      `${FIXTURES}/over-budget.ts`,
    ]);
    expect(result.exitCode).toBe(0);
  });

  test("--source with no path is a usage error, not a silent pass", async () => {
    const result = await runCheck("check-command-levels.ts", ["--source"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  test("a source module without defaultCommandSet is a usage error", async () => {
    const result = await runCheck("check-command-levels.ts", [
      "--source",
      "packages/studio/src/commands/budget.ts",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("does not export defaultCommandSet()");
  });
});

describe("check-chrome-budget.ts", () => {
  test("passes on the shipped command set and the declared docks", async () => {
    const result = await runCheck("check-chrome-budget.ts");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("chrome-budget OK");
  });

  test("passes on a good fixture", async () => {
    const result = await runCheck("check-chrome-budget.ts", [
      "--source",
      `${FIXTURES}/good-set.ts`,
    ]);
    expect(result.exitCode).toBe(0);
  });

  test("fails on a sixth primary command and a fifth dock tab", async () => {
    const result = await runCheck("check-chrome-budget.ts", [
      "--source",
      `${FIXTURES}/over-budget.ts`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("6 commands declare");
    expect(result.stderr).toContain('dock "bottom" declares 5 tabs');
    // The message says what retiring a control costs, so consolidation does not become deletion.
    expect(result.stderr).toContain("keeps its name, its chord");
  });

  test("a misplaced set is still within budget — the two checks are independent", async () => {
    const result = await runCheck("check-chrome-budget.ts", [
      "--source",
      `${FIXTURES}/bad-levels.ts`,
    ]);
    expect(result.exitCode).toBe(0);
  });

  test("--source with no path is a usage error", async () => {
    const result = await runCheck("check-chrome-budget.ts", ["--source"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  test("a source module without defaultCommandSet is a usage error", async () => {
    const result = await runCheck("check-chrome-budget.ts", [
      "--source",
      "packages/studio/src/commands/budget.ts",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("does not export defaultCommandSet()");
  });
});
