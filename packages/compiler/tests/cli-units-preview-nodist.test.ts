/**
 * Cli-units-preview-nodist.test.ts — jx preview failure footprint (no build output)
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { previewCalls, runEntry } from "./_cli-harness.ts";

describe("jx cli — preview without a build", () => {
  it("errors with a jx build hint and exits 1", async () => {
    previewCalls.length = 0;
    const result = await runEntry("cli", ["preview", "/tmp/jx-no-dist-here"]);
    expect(result.exited).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("run `jx build` first");
    expect(previewCalls).toHaveLength(0);
  });
});
