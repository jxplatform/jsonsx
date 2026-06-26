# AI assistant eval harness

A Karpathy-`autoresearch`-style self-improvement loop for the Jx Studio AI document assistant.
The **model is held fixed**; what we iterate on is the _scaffolding_ — the system prompt
([ai-system-prompt.js](../src/services/ai-system-prompt.js)), the tool schemas + validation-error
translations ([ai-tools.js](../src/services/ai-tools.js)), and the few-shot examples. A stable
golden-task suite is the benchmark; every scaffolding change is measured against it.

It exercises the **real** production loop (`runAgentLoop` + `@jxsuite/ai` + `ai-tools`), swapping
only the fake test client for a real OpenAI-compatible client and adding graders + a scoreboard.

## Layout

```
evals/
  tasks/*.json        golden tasks (one isolated, unambiguous spec each)
  runner.js           drive the real loop headlessly per task; pass@k / pass^k
  render-critic.js    PRIMARY grader — shadow-render the result with @jxsuite/runtime
  schema-grader.js    baseline grader — reuse validateDoc() (ajv)
  scoreboard.js       aggregate → results.json + transcripts + report.md (+ regression diff)
  cli.js              `bun run eval` entrypoint
  runs/               local-only run artifacts (gitignored)
  tests/              grader/runner unit tests (scripted client, no network)
```

## Run

```bash
# Whole suite, k=3 trials per task (default):
OPENAI_API_KEY=sk-… bun run eval

# One task, single trial (smoke):
OPENAI_API_KEY=sk-… bun run eval --tasks add-nav-to-header --k 1
```

`OPENAI_BASE_URL` and `OPENAI_MODEL` (default `gpt-4o`) are optional, mirroring the server proxy
config in [packages/server/src/ai-api.js](../../server/src/ai-api.js). The CLI exits non-zero if any
task regresses vs the previous run (CI gate). Each run writes `runs/<stamp>/report.md` plus one
`transcripts/<task>-<trial>.md` per trial — **read these**; you can't trust a grader you haven't
watched (Anthropic, _Demystifying evals_).

## Grading

- **Render critic (primary):** mounts the produced document with the real runtime under happy-dom
  and fails on thrown errors or `console.error`/`warn` (unresolved `$ref`/`$prototype`, broken
  bindings). Error strings are written as actionable "Sensor" messages so they can later feed the
  live loop.
- **Schema grader (baseline):** the same `validateDoc()` the loop already self-corrects against.

A trial passes when the render critic passes. `intent[]` on each task documents the human success
criteria — used today when reading transcripts; the hook for a future LLM-as-judge grader.

## The improvement loop (`/eval-improve` — propose, human approves)

1. `bun run eval` → note the baseline mean pass-rate; collect failing `transcripts/`.
2. Have an agent read the failures **and only the scaffolding** (system prompt, tool schemas +
   `translateValidationError`, few-shot examples) and draft a diff to **one** of them — Karpathy's
   "edit one file" discipline keeps experiments comparable.
3. Review and merge the diff.
4. Re-run `bun run eval`. **Keep** the change only if the mean pass-rate improves and `regressed` is
   empty; otherwise **discard**. The report records the per-task `Δrate`.

The model never changes — only the scaffolding — which is what makes two runs comparable.

## Out of scope (this phase)

Runtime UX sensors in the live assistant, LLM-as-judge grading, token accounting (the streaming
client doesn't yet surface usage), and fully-autonomous overnight self-editing. The render-critic
error format is intentionally LLM-ready so a later phase can wire it into the live loop or an
automated proposer.
