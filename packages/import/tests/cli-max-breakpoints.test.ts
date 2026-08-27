/** `--max-breakpoints` is a count, clamped to something a project can actually hold. */
import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const importSite = mock((_opts: Record<string, unknown>) =>
  Promise.resolve({
    outDir: resolve("max-bp-out"),
    pages: [],
    fileCount: 3,
    verify: null,
    warnings: [],
  }),
);
void mock.module("../src/run.ts", () => ({ importSite }));

console.log = () => {};

process.argv = [
  process.argv[0] ?? "bun",
  "cli.ts",
  "https://clone.example/",
  "--out",
  "max-bp-out",
  "--no-crawl",
  "--max-breakpoints",
  "99",
];

const cliModule = (await import("../src/cli")) as { ready?: Promise<unknown> };
await cliModule.ready;

describe("jx-import --max-breakpoints", () => {
  test("clamps an oversized count and defaults the rounding to nearest", () => {
    const opts = importSite.mock.calls[0]?.[0] as { breakpoints?: unknown };
    expect(opts.breakpoints).toEqual({ count: 12, mode: "limit", rounding: "nearest" });
  });
});
