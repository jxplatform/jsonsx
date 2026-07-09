/**
 * Cli-units-validate-ok.test.ts — `jx validate` success footprint
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { runEntry, setValidateProjectFile, validateProjectFileCalls } from "./_cli-harness.ts";

describe("jx cli — validate success", () => {
  it("reports a valid project.json", async () => {
    validateProjectFileCalls.length = 0;
    setValidateProjectFile(() => Promise.resolve({ errors: null, valid: true }));
    const result = await runEntry("cli", ["validate", "/tmp/jx-cli-validate-site"]);
    expect(result.exited).toBe(false);
    expect(validateProjectFileCalls).toEqual([resolve("/tmp/jx-cli-validate-site")]);
    expect(result.logs.join("\n")).toContain("project.json is valid");
  });
});
