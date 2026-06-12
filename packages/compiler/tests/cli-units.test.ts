/**
 * Cli-units.test.ts — In-process tests for the jx CLI help path and compile-cli error path
 *
 * See _cli-harness.ts for why each scenario footprint lives in its own test file: module instances
 * are cached per process and Bun records coverage reliably only for plain single imports, so each
 * file exercises at most one footprint of src/cli.ts and one of src/compile-cli.ts.
 */

import { describe, expect, it } from "bun:test";
import { runEntry, setRunCli } from "./_cli-harness.ts";

describe("jx cli — help", () => {
  it("prints usage and exits 0 with no command", async () => {
    const result = await runEntry("cli", []);
    expect(result.exited).toBe(true);
    expect(result.exitCode).toBe(0);
    const output = result.logs.join("\n");
    expect(output).toContain("Usage: jx <command>");
    expect(output).toContain("build [root]");
    expect(output).toContain("--verbose");
    expect(output).toContain("--no-clean");
  });
});

describe("jx-compile cli — error path", () => {
  it("logs the error and exits 1 when runCli rejects", async () => {
    setRunCli(() => Promise.reject(new Error("compile exploded")));
    const result = await runEntry("compile-cli", ["bad.json"]);
    expect(result.exited).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("compile exploded");
  });
});
