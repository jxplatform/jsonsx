import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRun } from "../scoreboard.js";

/** Build a minimal TaskResult-shaped object. */
function taskResult(id, passRate) {
  const pass = passRate >= 1;
  return {
    id,
    tags: ["unit"],
    k: 1,
    passAtK: passRate > 0,
    passHatK: passRate >= 1,
    passRate,
    trials: [
      {
        pass,
        rounds: 1,
        toolCalls: 1,
        loopError: null,
        render: { pass, errors: pass ? [] : ["boom"] },
        schema: { pass: true, errors: [] },
        finalDoc: { tagName: "div" },
        transcript: [{ role: "user", content: "x" }],
      },
    ],
  };
}

describe("scoreboard", () => {
  test("writes report.md, results.json, transcripts and detects a regression", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "jx-eval-"));

    // First run: task "a" passes.
    const first = writeRun([taskResult("a", 1)], { stamp: "20260101-000000", runsDir });
    expect(existsSync(join(first.outDir, "report.md"))).toBe(true);
    expect(existsSync(join(first.outDir, "results.json"))).toBe(true);
    expect(existsSync(join(first.outDir, "transcripts", "a-1.md"))).toBe(true);
    expect(first.regressed).toEqual([]);

    // Second run: task "a" now fails → flagged as a regression vs the previous run.
    const second = writeRun([taskResult("a", 0)], { stamp: "20260101-010000", runsDir });
    expect(second.regressed).toEqual(["a"]);

    const report = readFileSync(join(second.outDir, "report.md"), "utf8");
    expect(report).toContain("Regressions vs previous run");
    expect(report).toContain("| a |");
  });
});
