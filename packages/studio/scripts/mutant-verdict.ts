/**
 * How the mutation gate reads a finished `bun test` child — the one judgement it must not guess.
 *
 * **Why this is its own module.** The gate's verdict used to be four lines inside `runMutant`, and
 * one of them was wrong in a way that made the whole gate red on `main` for weeks: a child killed
 * by `spawnSync` for exceeding `maxBuffer` comes back with `signal: "SIGTERM"`, which the gate read
 * as "the operator hit Ctrl-C" and reported as an interrupt. Nobody had pressed anything. Pulling
 * the judgement out here makes it a function with inputs, so a test can hand it each of the four
 * ways a run can end instead of the gate having to be run for real to find out.
 *
 * **The four endings, and why each is what it is.**
 *
 * 1. **Output overflow** (`error.code === "ENOBUFS"`). The child was killed mid-stream because it
 *    outran the buffer. This is checked FIRST, before the signal, because it arrives AS a `SIGTERM`
 *    — checking the signal first is exactly the bug this module exists to fix.
 * 2. **A real interrupt** (`SIGINT`/`SIGTERM` with no `ENOBUFS`). Ctrl-C, noticed through the child,
 *    which is the only place a synchronous gate can notice it.
 * 3. **Ran and failed.** Bun's own `N fail` count decides; the exit code only separates this from the
 *    next case.
 * 4. **Did not run.** Non-zero exit with zero reported failures: the mutant broke the module's load.
 *    That is not evidence a test asserts on the behaviour, so it is a problem, not a kill.
 *
 * **Why an overflow can still be a kill.** A failing `expect` on a happy-dom element prints the
 * ELEMENT, and inspecting one walks `parentNode` up to `window` and serializes the whole class
 * table — see {@link MAX_OUTPUT}. The evidence that a test NOTICED arrives in the first few lines
 * and the drowning comes after, so the captured head answers the question the flood would have. The
 * bar is deliberately narrow: a matcher failure (`error: expect(…)`) or a `(fail)` line, and
 * nothing else. A module that throws while loading also prints `error:`, and calling that a kill
 * would be the gate lying in the one direction it must not.
 */

/** The fields of a `node:child_process` `spawnSync` result this module reads. */
export interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | string | null;
  error?: { code?: string } | null;
  stdout?: string | null;
  stderr?: string | null;
}

/** What the gate does with one mutant's run. */
export interface Verdict {
  /** The named test file noticed the mutant. */
  killed: boolean;
  /** Set when the run cannot answer the question — a red gate asking for a human. */
  problem: string | null;
  /** The operator interrupted the gate; the caller stops and restores. */
  aborted: boolean;
}

/**
 * How much of a child's output to keep.
 *
 * Not a tuning knob — a bound on a stream that has none of its own. Measured on `canvas-render.ts ·
 * no Document Header in a lens`, whose kill is
 * `expect(lensWrap.querySelector(".doc-header-host")).toBeNull()` receiving an `HTMLDivElement`:
 * ONE failed assertion produced 67 MB in 288 seconds and was still going, `--bail=1` included.
 * There is no buffer size that holds that, so holding it is not this buffer's job — holding the
 * EVIDENCE is, and the evidence (the source frame, then `error: expect(…)`) is complete inside four
 * kilobytes.
 *
 * A megabyte is a wide margin over any run that ends normally — a mutant that kills twenty-seven
 * tests with ordinary diffs prints about a tenth of it — and it caps the drown at about twelve
 * seconds. The gate's previous 64 MB was chosen to make the CLASSIFICATION right, back when an
 * overflow was indistinguishable from an interrupt; now that {@link verdictOf} can tell them apart,
 * the size only has to be enough to read by.
 */
export const MAX_OUTPUT = 1024 * 1024;

/** Everything the child said, in the order a reader would see it. */
function outputOf(run: RunResult): string {
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

/** Was the child killed for outrunning `maxBuffer`, rather than by a signal somebody sent? */
function overflowed(run: RunResult): boolean {
  return run.error?.code === "ENOBUFS";
}

/**
 * Did a TEST fail here — as opposed to the file failing to load?
 *
 * Both markers mean a test body ran and a matcher said no. `error:` on its own does not: a module
 * that throws on import prints one too, and the gate counts that as unproven, not as a kill.
 */
function assertionFailed(out: string): boolean {
  return /^\s*error: expect\(/m.test(out) || /^\(fail\)/m.test(out);
}

/** Bun's own count, which is the gate's kill signal when the run finishes normally. */
function failCount(out: string): number {
  const match = /(\d+) fail/.exec(out);
  return match ? Number(match[1]) : 0;
}

/** Every failing test Bun named, so a broken file reports all of them and not just the last one. */
function failLines(out: string): string[] {
  return out.match(/^\(fail\).*$/gm) ?? [];
}

/**
 * Decide what one mutant's run proved.
 *
 * @param {RunResult} run The finished child.
 * @param {string} test The test file it was told to run, for the message.
 * @returns {Verdict}
 */
export function verdictOf(run: RunResult, test: string): Verdict {
  const out = outputOf(run);
  if (overflowed(run)) {
    if (assertionFailed(out)) {
      return { aborted: false, killed: true, problem: null };
    }
    return {
      aborted: false,
      killed: false,
      problem:
        `${test} outran the ${Math.round(MAX_OUTPUT / 1024)}KB output budget without a matcher ` +
        `ever failing, so what it proved is unknown: a test that noticed says \`error: expect(…)\` ` +
        `before the flood, and this said nothing:\n${out.split("\n").slice(0, 12).join("\n")}`,
    };
  }
  /* CTRL-C, noticed through the CHILD, which is the only place it can be noticed. There were
     `process.on("SIGINT", …)` handlers in the gate for two rounds and they could not run: `main`
     is synchronous from the first line to `process.exit`, `spawnSync` blocks the thread, and a
     signal handler is dispatched on an event-loop turn that never comes. So Ctrl-C was absorbed —
     the gate reported the interrupted mutant as unapplied and carried on with the next one. The
     signal reaches the whole foreground process group, so the CHILD dies of it and says so. */
  if (run.signal === "SIGINT" || run.signal === "SIGTERM") {
    return { aborted: true, killed: false, problem: null };
  }
  /* A test file that cannot even LOAD is not a kill — it proves the mutant is unloadable, not that
     anything asserts on the behaviour. Bun reports the failure count either way, so the count
     decides and the exit code only tells them apart. */
  const fails = failCount(out);
  if (run.status !== 0 && fails === 0) {
    return {
      aborted: false,
      killed: false,
      problem:
        `${test} did not RUN under the mutant (exit ${run.status}, 0 reported failures). A mutant ` +
        `that breaks the module's load is not evidence of a test:\n${out
          .split("\n")
          .slice(-12)
          .join("\n")}`,
    };
  }
  return { aborted: false, killed: fails > 0, problem: null };
}

/**
 * Say what is wrong with a baseline run, or nothing when the file is green.
 *
 * The message names EVERY failing test rather than the tail of the output. The tail is where the
 * summary lives, so a file with twenty-seven failures used to report one of them and the count —
 * which says a file is broken without saying how, and a gate that runs on a machine you do not have
 * needs to answer that in its own output.
 *
 * @param {RunResult} run The finished child.
 * @param {string} test The test file it was told to run.
 * @returns {string | null}
 */
export function baselineProblemOf(run: RunResult, test: string): string | null {
  if (run.status === 0) {
    return null;
  }
  const out = outputOf(run);
  const named = failLines(out);
  const detail = named.length > 0 ? named.join("\n") : out.split("\n").slice(-8).join("\n");
  const drowned = overflowed(run)
    ? `\n  (…and its output overran the ${Math.round(MAX_OUTPUT / 1024)}KB budget, so this list is ` +
      `everything Bun managed to name before it was cut off.)`
    : "";
  return (
    `${test} is not green BEFORE any mutant is applied, so every "kill" it reports is that ` +
    `failure and not the mutant:\n${detail}${drowned}`
  );
}
