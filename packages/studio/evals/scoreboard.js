/**
 * Scoreboard.js — aggregate eval results, persist artifacts, and diff against the previous run.
 *
 * Writes per-run: results.json (machine-readable), one transcript file per trial (you must be able
 * to *read* failures — Anthropic), and report.md (human summary + regression diff). Returns the
 * computed summary so the CLI can set a non-zero exit code on regression (CI gate).
 *
 * @license MIT
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_RUNS_DIR = join(import.meta.dir, "runs");

/** @typedef {Awaited<ReturnType<typeof import("./runner.js").runTask>>} TaskResult */

/** @param {TaskResult[]} taskResults */
function summarize(taskResults) {
  const n = taskResults.length || 1;
  return {
    tasks: taskResults.length,
    passAtK: taskResults.filter((t) => t.passAtK).length,
    passHatK: taskResults.filter((t) => t.passHatK).length,
    meanPassRate: taskResults.reduce((s, t) => s + t.passRate, 0) / n,
  };
}

/** Find the most recent prior run directory, if any. */
function previousRunDir(runsDir) {
  if (!existsSync(runsDir)) {
    return null;
  }
  const dirs = readdirSync(runsDir)
    .filter((d) => /^\d/.test(d))
    .toSorted();
  return dirs.length > 0 ? join(runsDir, dirs.at(-1)) : null;
}

/**
 * @param {TaskResult[]} taskResults
 * @param {{ stamp: string; runsDir?: string }} opts - `stamp` is a timestamp the CLI passes in.
 *   `runsDir` overrides the output root (used by tests).
 * @returns {{ outDir: string; summary: ReturnType<typeof summarize>; regressed: string[] }}
 */
export function writeRun(taskResults, { stamp, runsDir = DEFAULT_RUNS_DIR }) {
  const prevDir = previousRunDir(runsDir);
  const outDir = join(runsDir, stamp);
  mkdirSync(join(outDir, "transcripts"), { recursive: true });

  // Per-trial transcripts — the artifact you actually read to calibrate graders.
  for (const task of taskResults) {
    for (const [i, trial] of task.trials.entries()) {
      const lines = [
        `# ${task.id} — trial ${i + 1}/${task.k}  (${trial.pass ? "PASS" : "FAIL"})`,
        ``,
        `rounds=${trial.rounds} toolCalls=${trial.toolCalls} loopError=${trial.loopError ?? "none"}`,
        ``,
        `## render critic: ${trial.render.pass ? "pass" : "FAIL"}`,
        ...trial.render.errors.map((e) => `- ${e}`),
        ``,
        `## schema grader: ${trial.schema.pass ? "pass" : "FAIL"}`,
        ...trial.schema.errors.map((e) => `- ${e}`),
        ``,
        `## final document`,
        "```json",
        JSON.stringify(trial.finalDoc, null, 2),
        "```",
        ``,
        `## transcript`,
        "```json",
        JSON.stringify(trial.transcript, null, 2),
        "```",
      ];
      writeFileSync(join(outDir, "transcripts", `${task.id}-${i + 1}.md`), lines.join("\n"));
    }
  }

  const summary = summarize(taskResults);

  // Regression diff: which tasks passed (pass@k) before but fail now.
  /** @type {string[]} */
  const regressed = [];
  let prevByTask = {};
  if (prevDir && existsSync(join(prevDir, "results.json"))) {
    const prev = JSON.parse(readFileSync(join(prevDir, "results.json"), "utf8"));
    prevByTask = Object.fromEntries((prev.tasks ?? []).map((t) => [t.id, t]));
    for (const task of taskResults) {
      const before = prevByTask[task.id];
      if (before && before.passAtK && !task.passAtK) {
        regressed.push(task.id);
      }
    }
  }

  writeFileSync(
    join(outDir, "results.json"),
    JSON.stringify(
      { stamp, summary, regressed, tasks: taskResults.map((t) => stripTrialsForJson(t)) },
      null,
      2,
    ),
  );

  writeFileSync(
    join(outDir, "report.md"),
    renderReport({ stamp, summary, regressed, taskResults, prevByTask }),
  );

  return { outDir, summary, regressed };
}

/** Keep results.json compact: drop full transcripts (they live as separate files). */
function stripTrialsForJson(task) {
  return {
    id: task.id,
    tags: task.tags,
    k: task.k,
    passAtK: task.passAtK,
    passHatK: task.passHatK,
    passRate: task.passRate,
    trials: task.trials.map((t) => ({
      pass: t.pass,
      rounds: t.rounds,
      toolCalls: t.toolCalls,
      loopError: t.loopError,
      renderErrors: t.render.errors,
      schemaErrors: t.schema.errors,
    })),
  };
}

/** @returns {string} */
function renderReport({ stamp, summary, regressed, taskResults, prevByTask }) {
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const rows = taskResults.map((t) => {
    const before = prevByTask[t.id];
    const delta = before == null ? "—" : signDelta(t.passRate - before.passRate);
    return `| ${t.id} | ${t.passAtK ? "✅" : "❌"} | ${t.passHatK ? "✅" : "❌"} | ${pct(t.passRate)} | ${delta} | ${t.tags.join(", ")} |`;
  });
  return [
    `# AI assistant eval — ${stamp}`,
    ``,
    `**Mean pass-rate:** ${pct(summary.meanPassRate)} · ` +
      `**pass@k:** ${summary.passAtK}/${summary.tasks} · ` +
      `**pass^k:** ${summary.passHatK}/${summary.tasks}`,
    ``,
    regressed.length > 0
      ? `> ⚠️ **Regressions vs previous run:** ${regressed.join(", ")}`
      : `> ✅ No regressions vs previous run.`,
    ``,
    `| task | pass@k | pass^k | rate | Δrate | tags |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...rows,
    ``,
    `Transcripts: \`transcripts/<task>-<trial>.md\`.`,
  ].join("\n");
}

/** @param {number} d */
function signDelta(d) {
  if (Math.abs(d) < 1e-9) {
    return "±0";
  }
  const s = `${d > 0 ? "+" : ""}${(d * 100).toFixed(0)}%`;
  return d > 0 ? `🟢 ${s}` : `🔴 ${s}`;
}
