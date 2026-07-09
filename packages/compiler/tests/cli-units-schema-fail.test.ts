/**
 * Cli-units-schema-fail.test.ts — `jx schema` failure footprint
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { runEntry, setWriteProjectSchemas } from "./_cli-harness.ts";

describe("jx cli — schema failure", () => {
  it("reports the error and exits 1", async () => {
    setWriteProjectSchemas(() => Promise.reject(new Error("no manifest for @acme/broken")));
    const result = await runEntry("cli", ["schema", "/tmp/jx-cli-schema-broken"]);
    expect(result.exited).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain(
      "Schema generation failed: no manifest for @acme/broken",
    );
  });
});
