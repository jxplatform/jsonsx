/** The usage path: no arguments prints the flag reference and exits 1. */
import { describe, expect, test } from "bun:test";

const logs: string[] = [];
console.log = (...args: unknown[]) => {
  logs.push(args.join(" "));
};

process.exit = ((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as never;

process.argv = [process.argv[0] ?? "bun", "cli.ts"];

const cliEntry = "../src/cli";

describe("jx-import CLI without arguments", () => {
  test("prints usage and exits with code 1", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(import(cliEntry)).rejects.toThrow("process.exit(1)");
    expect(logs.join("\n")).toContain("Usage: jx-import <url>");
  });
});
