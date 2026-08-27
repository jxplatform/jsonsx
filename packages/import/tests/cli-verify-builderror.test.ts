/**
 * Build errors were recorded and not enforced (issue #232): `verifyProject` logged "Build completed
 * with N error(s)", wrote them into report.json, and carried on — and `importSite` did not surface
 * them either, so a project that did not compile still exited 0.
 */
import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const importSite = mock((_opts: Record<string, unknown>) =>
  Promise.resolve({
    outDir: resolve("clone-out"),
    pages: [{ route: "pages/index.json", title: "Cloned", nodeCount: 42 }],
    fileCount: 5,
    verify: {
      // High fidelity and still a failure: what did not build is not a clone of anything.
      averageFidelity: 98.4,
      buildErrors: ["Error compiling /about: unknown $ref"],
      minFidelity: 25,
      pages: [{ consoleErrors: 0, failedRequests: 0, fidelity: 98.4, route: "pages/index.json" }],
      passed: false,
      reportDir: "/tmp/rep",
    },
    warnings: [],
  }),
);
void mock.module("../src/run.ts", () => ({ importSite }));

const errors: string[] = [];
console.log = () => {};
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

describe("jx-import CLI when the project did not build", () => {
  test("exits non-zero and prints each build error", () => {
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    const output = errors.join("\n");
    expect(output).toContain("Build error: Error compiling /about: unknown $ref");
    expect(output).toContain("Verification FAILED");
    // The fidelity line would be a distraction here — the build is the finding.
    expect(output).not.toContain("below the");
  });
});
