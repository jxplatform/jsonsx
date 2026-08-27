/** `--max-breakpoints 0` is how a script spells "keep every breakpoint the site declares". */
import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const importSite = mock((_opts: Record<string, unknown>) =>
  Promise.resolve({
    outDir: resolve("all-bp-out"),
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
  "all-bp-out",
  "--no-crawl",
  "--max-breakpoints",
  "0",
];

const cliModule = (await import("../src/cli")) as { ready?: Promise<unknown> };
await cliModule.ready;

describe("jx-import --max-breakpoints 0", () => {
  test("keeps all of them", () => {
    const opts = importSite.mock.calls[0]?.[0] as { breakpoints?: unknown };
    expect(opts.breakpoints).toEqual({ mode: "all" });
  });
});
