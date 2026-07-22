/**
 * Cli-units-validate-throw.test.ts — `jx validate` infrastructure-failure footprint
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { runEntry, setValidateProjectTree } from "./_cli-harness.ts";

describe("jx cli — validate infrastructure failure", () => {
  it("reports the thrown error and exits 1", async () => {
    setValidateProjectTree(() =>
      Promise.reject(new Error("project.schema.json not found in /tmp/x")),
    );
    const result = await runEntry("cli", ["validate", "/tmp/jx-cli-validate-throw"]);
    expect(result.exited).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain(
      "Validation failed: project.schema.json not found in /tmp/x",
    );
  });
});
