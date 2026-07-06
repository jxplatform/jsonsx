/** A non-http(s) URL is rejected before any work starts. */
import { describe, expect, test } from "bun:test";

const errors: string[] = [];
console.error = (...args: unknown[]) => {
  errors.push(args.join(" "));
};

process.exit = ((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as never;

process.argv = [process.argv[0] ?? "bun", "cli.ts", "ftp://nope.example"];

const cliEntry = "../src/cli";

describe("jx-import CLI with an invalid URL", () => {
  test("prints an error and exits with code 1", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(import(cliEntry)).rejects.toThrow("process.exit(1)");
    expect(errors.join("\n")).toContain("URL must start with http:// or https://");
  });
});
