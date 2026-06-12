/**
 * Cli-units-unknown.test.ts — jx unknown-command footprint
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { runEntry } from "./_cli-harness.ts";

describe("jx cli — unknown command", () => {
  it("exits 1 and names the unknown command", async () => {
    const result = await runEntry("cli", ["frobnicate"]);
    expect(result.exited).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("Unknown command: frobnicate");
    expect(result.errors.join("\n")).toContain('Run "jx --help" for usage.');
  });
});
