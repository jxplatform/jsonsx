/**
 * Cli-units-build-throw.test.ts — jx build exception footprint + compile-cli src-only footprint
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { runCliCalls, runEntry, setBuildSite, setRunCli } from "./_cli-harness.ts";

describe("jx cli — buildSite throws", () => {
  it("exits 1 with the failure message", async () => {
    setBuildSite(() => Promise.reject(new Error("project.json not found")));
    const result = await runEntry("cli", ["build", "/tmp/jx-cli-site"]);
    expect(result.exited).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("Build failed: project.json not found");
  });
});

describe("jx-compile cli — src without out", () => {
  it("invokes runCli with src only", async () => {
    runCliCalls.length = 0;
    setRunCli(() => Promise.resolve());
    const result = await runEntry("compile-cli", ["only-src.json"]);
    expect(result.exited).toBe(false);
    expect(runCliCalls).toEqual([{ out: undefined, src: "only-src.json" }]);
  });
});
