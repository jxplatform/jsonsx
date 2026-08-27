/**
 * The jx-import CLI happy path: flags map onto importSite options and the summary prints. The
 * orchestrator is mocked; the entry runs at import time (see create/index.ts for the pattern).
 */
import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const importSite = mock(
  (
    _opts: Record<string, unknown>,
    onProgress?: (e: { phase: string; message: string }) => void,
  ) => {
    onProgress?.({ phase: "emit", message: "Wrote 5 files" });
    return Promise.resolve({
      outDir: resolve("clone-out"),
      pages: [{ route: "pages/index.json", title: "Cloned", nodeCount: 42 }],
      fileCount: 5,
      verify: {
        averageFidelity: 96.3,
        buildErrors: [],
        minFidelity: 25,
        pages: [{ consoleErrors: 0, failedRequests: 2, fidelity: 96.3, route: "pages/index.json" }],
        passed: true,
        reportDir: "/tmp/rep",
      },
      warnings: [],
    });
  },
);
void mock.module("../src/run.ts", () => ({ importSite }));

const logs: string[] = [];
console.log = (...args: unknown[]) => {
  logs.push(args.join(" "));
};

process.env.OPENAI_API_KEY = "sk-cli-test";
process.env.OPENAI_BASE_URL = "http://llm.local/v1";
process.argv = [
  process.argv[0] ?? "bun",
  "cli.ts",
  "https://clone.example/",
  "--out",
  "clone-out",
  "--depth",
  "1",
  "--max-pages",
  "7",
  "--no-scroll",
  "--no-robots",
  "--min-instances",
  "3",
  "--ai-components",
  "--ai-model",
  "test-model",
  "--verify",
  "--verify-threshold",
  "0.3",
  "--min-fidelity",
  "40",
];

const cliEntry = "../src/cli";
const cliModule = (await import(cliEntry)) as { ready?: Promise<unknown> };
await cliModule.ready;

describe("jx-import CLI", () => {
  test("maps flags onto importSite options", () => {
    expect(importSite).toHaveBeenCalledTimes(1);
    const opts = importSite.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.url).toBe("https://clone.example/");
    expect(opts.outDir).toBe(resolve("clone-out"));
    expect(opts.maxDepth).toBe(1);
    expect(opts.maxPages).toBe(7);
    expect(opts.scroll).toBe(false);
    expect(opts.respectRobots).toBe(false);
    expect(opts.styles).toBe(true);
    expect(opts.assets).toBe(true);
    expect(opts.componentize).toEqual({ minInstances: 3, minDepth: 2 });
    expect(opts.ai).toEqual({
      apiKey: "sk-cli-test",
      baseUrl: "http://llm.local/v1",
      model: "test-model",
    });
    /*
     * `--verify-threshold` is pixelmatch's per-pixel COLOUR tolerance and moves the score;
     * `--min-fidelity` is the bar that decides the exit code. Conflating them is what let a run
     * scoring 8% exit 0 (issue #232).
     */
    expect(opts.verify).toEqual({ threshold: 0.3, minFidelity: 40, fullPage: true });
  });

  test("prints the page summary, fidelity, and Studio handoff", () => {
    const output = logs.join("\n");
    expect(output).toContain('pages/index.json — "Cloned" (42 nodes)');
    expect(output).toContain("Average fidelity: 96.3%");
    // What a percentage cannot say — read this before wondering why a page scores badly.
    expect(output).toContain("pages/index.json: 2 failed request(s)");
    expect(output).toContain("Done! Open in Studio:");
  });
});
