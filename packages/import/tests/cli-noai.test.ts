/** --ai-components without OPENAI_API_KEY fails fast. */
import { describe, expect, test } from "bun:test";

const errors: string[] = [];
console.error = (...args: unknown[]) => {
  errors.push(args.join(" "));
};

process.exit = ((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as never;

delete process.env.OPENAI_API_KEY;
process.argv = [process.argv[0] ?? "bun", "cli.ts", "https://clone.example/", "--ai-components"];

const cliEntry = "../src/cli";

describe("jx-import CLI --ai-components without a key", () => {
  test("prints an error and exits with code 1", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(import(cliEntry)).rejects.toThrow("process.exit(1)");
    expect(errors.join("\n")).toContain("requires OPENAI_API_KEY");
  });
});
