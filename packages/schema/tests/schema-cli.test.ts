/**
 * Covers the CLI block's explicit-output branch of src/schema.ts: when argv[1] ends with
 * "schema.ts" and an output path is given, only the component schema is written there.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TMP = resolve(tmpdir(), `jx-schema-cli-out-test-${Date.now()}`);
mkdirSync(join(TMP, "src"), { recursive: true });

const cliMessages: string[] = [];
console.error = (...args: unknown[]) => {
  cliMessages.push(args.join(" "));
};

const OUT = join(TMP, "custom-out.json");
process.argv = [process.argv[0] ?? "bun", join(TMP, "src", "schema.ts"), OUT];

// The CLI build runs in the exported `ready` promise (not a top-level await), so await it: Bun's
// Test runtime drops a dynamically-imported module's top-level-await continuation on Windows.
const { ready } = await import("../src/schema");
await ready;

const outText = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
const wroteDefaultTriple = existsSync(join(TMP, "project-schema.json"));
rmSync(TMP, { force: true, recursive: true });

describe("CLI explicit output branch", () => {
  test("writes the component schema to the given path", () => {
    expect(outText).not.toBe("");
    const parsed = JSON.parse(outText);
    expect(parsed.$schema).toContain("json-schema.org");
    expect(parsed.$defs).toBeDefined();
  });

  test("does not write the default three-file set", () => {
    expect(wroteDefaultTriple).toBe(false);
  });

  test("logs the destination path", () => {
    expect(cliMessages.join("\n")).toContain(`Jx component schema written to ${OUT}`);
  });
});
