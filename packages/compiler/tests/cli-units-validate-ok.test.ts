/**
 * Cli-units-validate-ok.test.ts — `jx validate` success footprint
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { runEntry, setValidateProjectTree, validateProjectTreeCalls } from "./_cli-harness.ts";

describe("jx cli — validate success", () => {
  it("reports a valid project tree", async () => {
    validateProjectTreeCalls.length = 0;
    setValidateProjectTree(() => Promise.resolve({ checked: 7, issues: [], valid: true }));
    const result = await runEntry("cli", ["validate", "/tmp/jx-cli-validate-site"]);
    expect(result.exited).toBe(false);
    expect(validateProjectTreeCalls).toEqual([resolve("/tmp/jx-cli-validate-site")]);
    expect(result.logs.join("\n")).toContain("Project is valid (7 files checked");
  });
});
