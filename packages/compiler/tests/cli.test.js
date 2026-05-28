import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/cli.js");
const FIXTURE_SITE = resolve(import.meta.dir, "../../../sites/jxsuite.com");

describe("jx cli", () => {
  test("runs under node (no Bun-specific APIs)", async () => {
    const proc = Bun.spawn(["node", CLI_PATH, "build", FIXTURE_SITE], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(stderr).not.toContain("Bun is not defined");
    expect(exitCode).toBe(0);
  });

  test("prints help with --help", async () => {
    const proc = Bun.spawn(["node", CLI_PATH, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: jx <command>");
  });
});
