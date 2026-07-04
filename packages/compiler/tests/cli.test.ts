import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../bin/jx.js");
const FIXTURE_SITE = resolve(import.meta.dir, "../../../examples");

describe("jx cli", () => {
  test("runs under bun", async () => {
    const proc = Bun.spawn(["bun", "run", CLI_PATH, "build", FIXTURE_SITE], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(stderr).not.toContain("Cannot find module");
    expect(exitCode).toBe(0);
  });

  test("prints help with --help", async () => {
    const proc = Bun.spawn(["bun", "run", CLI_PATH, "--help"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: jx <command>");
  });
});
