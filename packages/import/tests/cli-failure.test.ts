/**
 * A pipeline failure surfaces as an error message and a non-zero exit code (via process.exitCode,
 * not process.exit, so the finally-cleanup in the orchestrator can run).
 */
import { describe, expect, mock, test } from "bun:test";

const importSite = mock((_opts: Record<string, unknown>) =>
  Promise.reject(new Error('Directory "/x" is not empty')),
);
void mock.module("../src/run.ts", () => ({ importSite }));

const errors: string[] = [];
console.error = (...args: unknown[]) => {
  errors.push(args.join(" "));
};
console.log = () => {};

process.argv = [process.argv[0] ?? "bun", "cli.ts", "https://clone.example/", "--no-crawl"];

const cliEntry = "../src/cli";
const cliModule = (await import(cliEntry)) as { ready?: Promise<unknown> };
await cliModule.ready;

describe("jx-import CLI on pipeline failure", () => {
  test("prints the error and sets a non-zero exit code", () => {
    expect(errors.join("\n")).toContain("is not empty");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    // Single-page default outDir derives from the hostname when --out is omitted.
    const opts = importSite.mock.calls[0]?.[0] as { maxDepth: number; outDir: string };
    expect(opts.maxDepth).toBe(0);
    expect(opts.outDir).toContain("jx-imports/clone.example");
  });
});
