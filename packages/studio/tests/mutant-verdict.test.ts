/**
 * The mutation gate's reading of a finished child.
 *
 * These are the four endings a `bun test` run can have, handed to the judgement directly instead of
 * provoked for real — provoking the interesting one costs 288 seconds and 67 MB of happy-dom.
 */
import { describe, expect, test } from "bun:test";
import { baselineProblemOf, MAX_OUTPUT, verdictOf } from "../scripts/mutant-verdict";
import type { RunResult } from "../scripts/mutant-verdict";

/** A `spawnSync` result, with the shape of a normal completion unless a field says otherwise. */
function run(over: Partial<RunResult> = {}): RunResult {
  return { signal: null, status: 0, stderr: "", stdout: "", ...over };
}

/** What Bun writes when a matcher fails on a happy-dom element, cut where the buffer would cut. */
const DROWNED = `\ntests/canvas-render.test.ts:
2209 |       expect(lensWrap.querySelector('.doc-header-host')).toBeNull();
error: expect(received).toBeNull()

Received: HTMLDivElement {
${"  [Symbol(listeners)]: {\n".repeat(20)}`;

describe("verdictOf", () => {
  test("an OVERFLOW is not an interrupt, even though it arrives as one", () => {
    /* The whole reason this module exists. `spawnSync` kills a child that outruns `maxBuffer` with
       its `killSignal`, which is SIGTERM — so the signal check that used to come first read a
       flood of output as somebody pressing Ctrl-C, and the gate stopped with nobody at a keyboard.
       Verified against Bun 1.3.13: status null, signal SIGTERM, error.code ENOBUFS. */
    const verdict = verdictOf(
      run({ error: { code: "ENOBUFS" }, signal: "SIGTERM", status: null, stderr: DROWNED }),
      "tests/canvas-render.test.ts",
    );
    expect(verdict.aborted).toBe(false);
    expect(verdict.killed).toBe(true);
    expect(verdict.problem).toBeNull();
  });

  test("an overflow with no matcher failure is a PROBLEM, not a kill", () => {
    // The conservative direction: a module that throws while loading also floods, and calling that
    // A kill would credit the mutant to a test that never ran.
    const verdict = verdictOf(
      run({
        error: { code: "ENOBUFS" },
        signal: "SIGTERM",
        status: null,
        stderr: `error: Cannot find module "../src/gone"\n${"stack frame\n".repeat(40)}`,
      }),
      "tests/pane-derive.test.ts",
    );
    expect(verdict.killed).toBe(false);
    expect(verdict.aborted).toBe(false);
    expect(verdict.problem).toContain("without a matcher ever failing");
    expect(verdict.problem).toContain("tests/pane-derive.test.ts");
  });

  test("a `(fail)` line is evidence too, when the flood cut off the matcher line", () => {
    const verdict = verdictOf(
      run({
        error: { code: "ENOBUFS" },
        signal: "SIGTERM",
        status: null,
        stdout: "(fail) git-diff mode > format files parse diff content [2.00ms]\n",
      }),
      "tests/canvas-render.test.ts",
    );
    expect(verdict.killed).toBe(true);
  });

  test("a REAL interrupt still aborts", () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const verdict = verdictOf(run({ signal, status: null }), "tests/canvas-render.test.ts");
      expect(verdict.aborted).toBe(true);
      expect(verdict.killed).toBe(false);
    }
  });

  test("a run that finished counts Bun's own failures", () => {
    expect(
      verdictOf(run({ status: 1, stdout: " 62 pass\n 27 fail\n" }), "tests/a.test.ts").killed,
    ).toBe(true);
    expect(verdictOf(run({ stdout: " 89 pass\n 0 fail\n" }), "tests/a.test.ts").killed).toBe(false);
  });

  test("a non-zero exit with NO failures means the file never ran", () => {
    const verdict = verdictOf(
      run({ status: 1, stderr: 'error: Cannot find module "../src/gone"' }),
      "tests/a.test.ts",
    );
    expect(verdict.killed).toBe(false);
    expect(verdict.problem).toContain("did not RUN under the mutant");
  });
});

describe("baselineProblemOf", () => {
  test("a green baseline is no problem", () => {
    expect(baselineProblemOf(run(), "tests/a.test.ts")).toBeNull();
  });

  test("a red baseline names EVERY failing test, not the tail of the log", () => {
    /* The CI failure that prompted this: 27 tests failed and the report showed one of them and a
       count, because it printed the last eight lines and the summary lives there. A gate that runs
       on a machine the reader does not have has to answer "which ones" in its own output. */
    const lines = Array.from({ length: 27 }, (_, i) => `(fail) suite > case ${i} [1.00ms]`);
    const problem = baselineProblemOf(
      run({ status: 1, stdout: `${lines.join("\n")}\n 62 pass\n 27 fail\n` }),
      "tests/canvas-render.test.ts",
    );
    expect(problem).toContain("is not green BEFORE any mutant is applied");
    for (const line of lines) {
      expect(problem).toContain(line);
    }
  });

  test("with no named failures it falls back to the tail", () => {
    const problem = baselineProblemOf(
      run({ status: 1, stdout: "something went wrong\nand then stopped\n" }),
      "tests/a.test.ts",
    );
    expect(problem).toContain("and then stopped");
  });

  test("a drowned baseline says the list is truncated", () => {
    const problem = baselineProblemOf(
      run({ error: { code: "ENOBUFS" }, signal: "SIGTERM", status: null, stdout: "(fail) one" }),
      "tests/a.test.ts",
    );
    expect(problem).toContain("before it was cut off");
    expect(problem).toContain(`${Math.round(MAX_OUTPUT / 1024)}KB`);
  });
});
