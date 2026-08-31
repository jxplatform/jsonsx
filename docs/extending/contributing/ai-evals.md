---
title: "AI assistant evals"
description: "Run the AI assistant eval suite, read its transcripts, and use the render critic and regression gate when you change the assistant's scaffolding."
code:
  - packages/studio/evals/cli.ts
  - packages/studio/evals/runner.ts
  - packages/studio/evals/render-critic.ts
  - packages/studio/evals/schema-grader.ts
  - packages/studio/evals/scoreboard.ts
  - packages/studio/src/services/ai-system-prompt.ts
  - packages/studio/src/services/ai-tools.ts
---

# AI assistant evals

Studio's [AI assistant](/docs/studio/ai) is not one thing you can unit-test. It is a model you do not control wrapped in scaffolding you do: a system prompt, a set of tool schemas, the translations that turn a validation error back into an instruction the model can act on. Change any of that and the only honest question is whether the assistant got better, which a test suite cannot answer and a hunch should not.

`packages/studio/evals/` is the harness that answers it. Reach for it whenever you touch `ai-system-prompt.ts`, `ai-tools.ts`, or the few-shot examples.

## The invariant

**The model is held fixed; only the scaffolding is iterated.** That is the whole design. Because the model, the tasks, and the graders stay constant between runs, a difference in pass-rate is attributable to the diff you just made. Change two things at once (the prompt and the model, say) and the run tells you nothing.

The second half of the design is that the harness drives the **real** production loop: the actual `runAgentLoop`, the actual `@jxsuite/ai` tool registry, the actual system prompt built by `buildSystemPrompt`. The only substitution is the LLM client, where the fake test client is swapped for a real OpenAI-compatible one. There is no parallel "eval mode" implementation to keep in sync, so a scaffolding change is exercised exactly as users will meet it.

## Golden tasks

Each task in `evals/tasks/*.json` is one isolated, unambiguous specification:

```json
{
  "id": "counter-button",
  "prompt": "Add a button that increments a counter, and show the current count above it. Wire up the reactive state.",
  "tags": ["intent", "state", "binding"],
  "intent": [
    "declares numeric state for the count",
    "a button increments the count on click",
    "the count is shown via a ${...} template binding"
  ],
  "initialDoc": {
    "tagName": "counter-widget",
    "state": { "count": { "type": "integer", "default": 0 } },
    "children": []
  }
}
```

`initialDoc` is the document the assistant starts from. Every trial gets a fresh tab, so nothing leaks between runs. `intent` records the human success criteria: it is what you read transcripts against today, and the hook for a future LLM-as-judge grader. Keep the suite stable. Tasks are the benchmark, and a benchmark that moves with the code cannot measure it.

## Running it

```bash
# Whole suite, k=3 trials per task (the default)
OPENAI_API_KEY=sk-… bun run eval

# One task, single trial — a smoke check
OPENAI_API_KEY=sk-… bun run eval --tasks counter-button --k 1
```

`OPENAI_BASE_URL` and `OPENAI_MODEL` (default `gpt-4o`) are optional and mirror how the server proxy resolves its config. Without `OPENAI_API_KEY` the CLI exits `2` immediately, because the harness calls a real model by design.

Each run writes a timestamped directory under `evals/runs/`, which is gitignored:

- `report.md` is the human summary: mean pass-rate, pass@k and pass^k counts, and a per-task table with `Δrate` against the previous run.
- `results.json` holds the same numbers, machine-readable, minus the transcripts.
- `transcripts/<task>-<trial>.md` is one file per trial: the round and tool-call counts, both graders' verdicts, the final document, and the full message transcript.

**Read the transcripts.** A grader you have not watched is a grader you cannot trust, and the failure that matters is usually visible in the third assistant turn rather than in the summary row.

## The two graders

**Render critic: the primary signal.** It mounts the produced document with the real `@jxsuite/runtime` under happy-dom, the same render path the Studio canvas uses, and fails on anything the runtime surfaces: a thrown error during scope-building or node rendering, or a `console.error`/`console.warn`. In practice that means unresolved `$ref`s, missing `$prototype` classes, and broken bindings. Errors are phrased as actionable corrections ("→ Fix: a template binding references state that doesn't exist"), so the same output could later be fed back into the live loop.

**Schema grader: the baseline.** The same `validateDoc()` the agent loop already self-corrects against. It is free and deterministic, so it is reported alongside for context.

A trial passes on the **render critic**, not the schema grader. A document can be perfectly schema-valid and still render nothing useful, which is precisely the gap the critic exists to close.

## pass@k and pass^k

Models are non-deterministic, so a single trial per task measures luck. Each task runs `k` times (3 by default) and the scoreboard reports both:

- **pass@k** means at least one of the `k` trials passed. Capability: can the assistant do this at all?
- **pass^k** means all `k` trials passed. Reliability: can a user count on it?

`passRate` (passes ÷ k) sits between them and is what the mean and the `Δrate` column are computed from.

## The merge rule

1. Run `bun run eval` and note the baseline mean pass-rate; collect the failing transcripts.
2. Read the failures, then change **one** scaffolding file: the system prompt, the tool schemas plus `translateValidationError`, or the few-shot examples. One file per experiment keeps runs comparable.
3. Re-run. **Keep the change only if the mean pass-rate improves and `regressed` is empty.** Otherwise discard it.

The scoreboard computes `regressed` by diffing against the most recent prior run: any task that passed pass@k before and does not now. The CLI exits `1` when that list is non-empty, so the same command can gate CI.

:::doc-warning
Never tune the tasks to make a scaffolding change look good. If a task is genuinely ambiguous, fix the task in its own commit and re-baseline, but treat that as a change to the benchmark, not a result.
:::

## The headless rubric harness

`bun run eval:headless` runs a second harness at `packages/studio/tests/harness/`, which landed alongside the one above. It drives a catalog of prompts through the same production loop and scores them on rubric axes with evidence attached, running each test three times (`JX_AI_RUNS`) and reporting the **worst** run per axis so a borderline result cannot cherry-pick a lucky pass. It reads its key from `JX_AI_KEY`, falling back to `OPENAI_API_KEY`, and loads the repo-root `.env` regardless of the working directory. Use it for a qualitative read on assistant behavior; use `bun run eval` for the pass/fail number you gate on.

## Out of scope

The harness deliberately does not do runtime UX sensors in the live assistant, LLM-as-judge grading, token accounting (the streaming client does not surface usage yet), or autonomous self-editing. The render critic's error format is LLM-ready on purpose, so a later phase can wire it into the live loop.

It also cannot score a **project-level** tool call yet. Every golden task is document-shaped: an `initialDoc` plus the intent a grader reads off the resulting tree. A behavior like "asked for a blog, so it turned on the content extension" has no document to compare, and needs a task kind carrying a project fixture and a check over `project.json`. Until that exists, project-tier tools are covered by unit tests over the tool surface and the prompt, not by an eval.

## Related

- [AI assistant](/docs/studio/ai): what the harness is measuring, from the user's side
- [Working in the monorepo](/docs/extending/contributing/monorepo): the testing policy the rest of the repo follows
- [Working with agents](/docs/framework/agents): external agents on a Jx project, and the checks that hold them honest
