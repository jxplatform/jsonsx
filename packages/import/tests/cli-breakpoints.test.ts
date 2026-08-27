/** `--breakpoints` names the widths the project keeps, and wins over any count. */
import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const importSite = mock((_opts: Record<string, unknown>) =>
  Promise.resolve({
    outDir: resolve("bp-out"),
    pages: [{ route: "pages/index.json", title: "Cloned", nodeCount: 1 }],
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
  "bp-out",
  "--no-crawl",
  "--breakpoints",
  " 640 , 1024,1440 ",
  "--breakpoint-rounding",
  "down",
  // Ignored: naming the widths says everything a count could have.
  "--max-breakpoints",
  "9",
];

const cliModule = (await import("../src/cli")) as { ready?: Promise<unknown> };
await cliModule.ready;

describe("jx-import --breakpoints", () => {
  test("passes an explicit policy, trimming and parsing the width list", () => {
    const opts = importSite.mock.calls[0]?.[0] as { breakpoints?: unknown };
    expect(opts.breakpoints).toEqual({
      mode: "explicit",
      rounding: "down",
      widths: [640, 1024, 1440],
    });
  });
});
