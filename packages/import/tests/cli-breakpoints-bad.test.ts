/** `--breakpoints` with nothing usable in it is a typo, and is refused rather than ignored. */
import { describe, expect, mock, test } from "bun:test";

const importSite = mock(() => Promise.resolve({}));
void mock.module("../src/run.ts", () => ({ importSite }));

const errors: string[] = [];
console.log = () => {};
console.error = (...args: unknown[]) => {
  errors.push(args.join(" "));
};
process.exit = ((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as never;

process.argv = [
  process.argv[0] ?? "bun",
  "cli.ts",
  "https://clone.example/",
  "--breakpoints",
  "wide,huge,3",
];

describe("jx-import --breakpoints with no usable width", () => {
  test("names the range it wanted and exits 1", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(import("../src/cli")).rejects.toThrow("process.exit(1)");
    expect(errors.join("\n")).toContain("--breakpoints needs widths between 120 and 4000");
    expect(importSite).not.toHaveBeenCalled();
  });
});
