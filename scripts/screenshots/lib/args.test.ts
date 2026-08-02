import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseArgs } from "./args";

const DEFAULT = "/repo/scripts/screenshots/manifest.json";

describe("parseArgs", () => {
  test("with no flags, every shot runs against the default manifest and nothing is reused", () => {
    const opts = parseArgs([], DEFAULT);
    expect(opts).toEqual({
      force: false,
      headed: false,
      manifestPath: DEFAULT,
      only: new Set(),
      reuseServer: false,
    });
  });

  test("--only accumulates across repeats and comma-separated lists, trimming names", () => {
    const opts = parseArgs(["--only", "hero", "--only", " state-panel , stylebook "], DEFAULT);
    expect([...opts.only].toSorted()).toEqual(["hero", "state-panel", "stylebook"]);
  });

  test("--headed, --force and --reuse-server are independent switches", () => {
    const opts = parseArgs(["--headed", "--force", "--reuse-server"], DEFAULT);
    expect(opts.headed).toBe(true);
    expect(opts.force).toBe(true);
    expect(opts.reuseServer).toBe(true);
  });

  test("server reuse is OFF unless it is asked for by name", () => {
    // The whole point of the flag: adopting a server is a decision, never a discovery.
    expect(parseArgs(["--headed", "--force"], DEFAULT).reuseServer).toBe(false);
  });

  test("--manifest resolves against the working directory", () => {
    const opts = parseArgs(["--manifest", "tmp/m.json"], DEFAULT);
    expect(opts.manifestPath).toBe(resolve(process.cwd(), "tmp/m.json"));
  });

  test("a value-less --only or --manifest is an error, not a silent default", () => {
    expect(() => parseArgs(["--only"], DEFAULT)).toThrow("--only requires a shot name");
    expect(() => parseArgs(["--manifest"], DEFAULT)).toThrow("--manifest requires a path");
  });

  test("an unknown flag names itself and lists what is accepted", () => {
    expect(() => parseArgs(["--nope"], DEFAULT)).toThrow(
      /unknown argument "--nope".*--reuse-server/,
    );
  });
});
