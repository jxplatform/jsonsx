/**
 * Cli-units-dev-fail.test.ts — jx dev failure footprint (resolution error → exit 1)
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { runDevCalls, runEntry, setRunDev } from "./_cli-harness.ts";

describe("jx cli — dev failure", () => {
  it("prints the resolution error and exits 1", async () => {
    runDevCalls.length = 0;
    setRunDev(() => {
      throw new Error("@jxsuite/server is not installed in /tmp/nope.");
    });
    const result = await runEntry("cli", ["dev", "/tmp/nope"]);
    expect(result.exited).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("@jxsuite/server is not installed");
  });
});
