/**
 * Cli-units-build-noclean.test.ts — jx build default-root/--no-clean footprint
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { buildSiteCalls, runEntry, setBuildSite } from "./_cli-harness.ts";

describe("jx cli — build flag handling", () => {
  it("defaults the root to cwd and honors --no-clean", async () => {
    buildSiteCalls.length = 0;
    setBuildSite(() => Promise.resolve({ errors: [], files: 1, routes: 1 }));
    const result = await runEntry("cli", ["build", "--no-clean"]);
    expect(result.exited).toBe(false);
    expect(buildSiteCalls[0]?.root).toBe(resolve("."));
    expect(buildSiteCalls[0]?.opts).toEqual({ clean: false, verbose: false });
    expect(result.logs.join("\n")).toContain("Done: 1 routes → 1 files");
  });
});
