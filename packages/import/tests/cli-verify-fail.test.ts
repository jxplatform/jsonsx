/**
 * A verify that cannot fail is a report, not a gate (issue #232).
 *
 * `--verify` built the project, served it, screenshotted it and pixel-diffed it — and then printed
 * `Done! Open in Studio:` and exited 0 whether the clone scored 95% or 8%. An 8%-fidelity import is
 * worse than a failed one, because the only way to notice it is to open the result and look.
 */
import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const importSite = mock((_opts: Record<string, unknown>) =>
  Promise.resolve({
    outDir: resolve("clone-out"),
    pages: [{ route: "pages/index.json", title: "Cloned", nodeCount: 42 }],
    fileCount: 5,
    verify: {
      averageFidelity: 8.17,
      buildErrors: [],
      minFidelity: 25,
      pages: [{ consoleErrors: 3, failedRequests: 15, fidelity: 8.17, route: "pages/index.json" }],
      passed: false,
      reportDir: "/tmp/rep",
    },
    warnings: [],
  }),
);
void mock.module("../src/run.ts", () => ({ importSite }));

const logs: string[] = [];
const errors: string[] = [];
console.log = (...args: unknown[]) => {
  logs.push(args.join(" "));
};
console.error = (...args: unknown[]) => {
  errors.push(args.join(" "));
};

process.argv = [
  process.argv[0] ?? "bun",
  "cli.ts",
  "https://clone.example/",
  "--out",
  "clone-out",
  "--no-crawl",
  "--verify",
];

const cliModule = (await import("../src/cli")) as { ready?: Promise<unknown> };
await cliModule.ready;

describe("jx-import CLI when verification does not meet the bar", () => {
  test("exits non-zero and names the bar it missed", () => {
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    const output = errors.join("\n");
    expect(output).toContain("Verification FAILED");
    expect(output).toContain("8.17% is below the 25% minimum");
    expect(output).toContain("/tmp/rep/report.json");
  });

  // The project is still on disk and still worth opening — it is the "Done!" claim that was wrong.
  test("does not print the Studio handoff", () => {
    expect(logs.join("\n")).not.toContain("Done! Open in Studio:");
  });

  test("defaults the bar to 25 when --min-fidelity is not given", () => {
    const opts = importSite.mock.calls[0]?.[0] as { verify: { minFidelity: number } };
    expect(opts.verify.minFidelity).toBe(25);
  });
});
