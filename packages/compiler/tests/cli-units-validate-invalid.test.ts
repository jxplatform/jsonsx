/**
 * Cli-units-validate-invalid.test.ts — `jx validate` invalid-project footprint
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { runEntry, setValidateProjectFile } from "./_cli-harness.ts";

describe("jx cli — validate invalid project", () => {
  it("pretty-prints errors and exits 1", async () => {
    setValidateProjectFile(() =>
      Promise.resolve({
        errors: [
          { instancePath: "/content/posts", message: "must have required property 'source'" },
          { keyword: "unevaluatedProperties" },
        ],
        valid: false,
      }),
    );
    const result = await runEntry("cli", ["validate", "/tmp/jx-cli-validate-bad"]);
    expect(result.exited).toBe(true);
    expect(result.exitCode).toBe(1);
    const output = result.errors.join("\n");
    expect(output).toContain("project.json is INVALID");
    expect(output).toContain("/content/posts: must have required property 'source'");
    expect(output).toContain('/: {"keyword":"unevaluatedProperties"}');
  });
});
