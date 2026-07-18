/**
 * Covers the CLI default branch's non-fatal oxfmt handling in src/schema.ts: when the oxfmt
 * reformat of the generated `schemas/` fragments fails (e.g. a sandboxed/offline build such as `nix
 * build`, where oxfmt exits non-zero with no diagnostic output), the CLI must warn and finish
 * rather than throw — the JSON fragments are already written and valid.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ── Force the oxfmt spawn to fail with no diagnostic output ─────────────────────
// Empty stdout/stderr with no successful exit is the shape observed inside the Nix build sandbox
// (a signal here also exercises the signalCode detail branch); delegate every other spawn to the
// Real implementation.
const realSpawnSync = Bun.spawnSync;
Bun.spawnSync = ((cmd: unknown, opts: unknown) => {
  if (Array.isArray(cmd) && cmd[1] === "oxfmt") {
    return {
      exitCode: null,
      signalCode: "SIGSEGV",
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      success: false,
      resourceUsage: undefined,
      pid: 0,
    };
  }
  return (realSpawnSync as (c: unknown, o: unknown) => unknown)(cmd, opts);
}) as typeof Bun.spawnSync;

// ── Trigger the CLI default branch at import time ───────────────────────────────
const TMP = resolve(tmpdir(), `jx-schema-cli-format-test-${Date.now()}`);
mkdirSync(join(TMP, "src"), { recursive: true });

const cliMessages: string[] = [];
console.error = (...args: unknown[]) => {
  cliMessages.push(args.join(" "));
};

process.argv = [process.argv[0] ?? "bun", join(TMP, "src", "schema.ts")];

let threw: unknown = null;
const { ready } = await import("../src/schema");
// The CLI build runs in the exported `ready` promise (not a top-level await), so await it: Bun's
// Test runtime drops a dynamically-imported module's top-level-await continuation on Windows.
try {
  await ready;
} catch (error) {
  threw = error;
}

Bun.spawnSync = realSpawnSync;

// Snapshot the CLI's output before cleaning up the temp directory.
const wroteFragment = existsSync(join(TMP, "schemas", "project.core.schema.json"));
const wroteComponent = existsSync(join(TMP, "schema.json"));
rmSync(TMP, { force: true, recursive: true });

describe("CLI default branch — oxfmt failure is non-fatal", () => {
  test("does not throw when oxfmt fails", () => {
    expect(threw).toBeNull();
  });

  test("still writes the schema fragments", () => {
    expect(wroteFragment).toBe(true);
    expect(wroteComponent).toBe(true);
  });

  test("warns with the signal detail rather than failing the build", () => {
    const log = cliMessages.join("\n");
    expect(log).toContain("skipped oxfmt reformat");
    expect(log).toContain("SIGSEGV");
    // The build still completes and logs its generated file names.
    expect(log).toContain("Generated:");
  });
});
