/**
 * Cli-units-build-ok.test.ts — jx build success footprint + compile-cli success footprint
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { buildSiteCalls, runCliCalls, runEntry, setBuildSite, setRunCli } from "./_cli-harness.ts";

describe("jx cli — successful build", () => {
  it("builds with a positional root and --verbose", async () => {
    buildSiteCalls.length = 0;
    setBuildSite(() => Promise.resolve({ errors: [], files: 5, routes: 3 }));
    const result = await runEntry("cli", ["build", "/tmp/jx-cli-site", "--verbose"]);
    expect(result.exited).toBe(false);
    expect(buildSiteCalls).toHaveLength(1);
    expect(buildSiteCalls[0]?.root).toBe(resolve("/tmp/jx-cli-site"));
    expect(buildSiteCalls[0]?.opts).toEqual({ clean: true, verbose: true });
    expect(result.logs.join("\n")).toContain("Building site from");
    expect(result.logs.join("\n")).toContain("Done: 3 routes → 5 files");
  });
});

describe("jx-compile cli — success", () => {
  it("invokes runCli with src and out", async () => {
    runCliCalls.length = 0;
    setRunCli(() => Promise.resolve());
    const result = await runEntry("compile-cli", ["input.json", "out.js"]);
    expect(result.exited).toBe(false);
    expect(runCliCalls).toEqual([{ out: "out.js", src: "input.json" }]);
  });
});
