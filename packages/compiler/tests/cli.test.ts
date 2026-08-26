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

  /*
   * `bin/jx.js` carries a Node shebang, so `bunx jx build` — the command every deployment recipe
   * documents — runs under Node, not Bun. `resolveDir` defaulted to the Bun-only
   * `import.meta.dir`, which is `undefined` there, so resolution threw, the catch read it as
   * "cannot resolve", and the import map silently pointed at the esm.sh CDN. The runtime is
   * self-hosted precisely so a `default-src 'self'` policy is possible, so this has to be spawned
   * under Node to be tested at all: the other cases here run `bun run`, which bypasses the shebang.
   */
  test("runs under node without falling back to a CDN", async () => {
    const proc = Bun.spawn(["node", CLI_PATH, "build", FIXTURE_SITE], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
    expect(`${stdout}${stderr}`).not.toContain("Could not resolve");
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
