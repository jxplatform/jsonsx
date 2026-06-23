# AI Assistant — Headless Real-LLM Harness

**Status:** Active — L1–L5 green (18/18 C:5); L2.5 now passes via `add_child`+`move_node`
**Date:** 2026-06-22
**Owner:** Gideon
**Branch:** `feat/ai-assistant-stack-b`
**Relates to:** `docs/ai-assistant-testing-plan.md` (manual/browser eval), `specs/ai-assistant.md`

---

## 1. Why

The Stack B logic (agent loop, Jx tools, system prompt, context trimming) is **already
decoupled** from the browser — `runAgentLoop`, `registerAiTools`, and `context-manager` take
injected dependencies and touch no DOM/window/localStorage. The existing
[ai-loop.test.js](../packages/studio/tests/ai-loop.test.js) already builds the whole harness in
Node against a `fakeClient`.

The only gap between that test and a real eval is the **client**: swap `fakeClient` for
`createOpenAIStreamingClient` and feed the real `buildSystemPrompt()`. That gives us:

- **Fast, deterministic logic iteration** (temp 0, scripted prompts, no browser clicking) for the
  axes that are pure logic: Completeness, Efficiency, Recovery, and schema-Correctness.
- **A second consumer of the core** — which is exactly the SDK seam. Whatever we must stub to run
  headless _is_ the studio-coupling boundary.

The studio stays the place to validate the **browser-only** axes: rendered-DOM Correctness and
Undo/Redo. We do not move those.

---

## 2. What stays where

| Concern                                              | Headless harness              | Studio (manual) |
| ---------------------------------------------------- | ----------------------------- | --------------- |
| System prompt wording / few-shot (L0.5)              | ✅ primary                    | spot-check      |
| Tool error messages → self-correction (Recovery, L4) | ✅ primary                    | —               |
| Loop cap / round count (Efficiency)                  | ✅ primary                    | —               |
| Context trimming (L4+)                               | ✅ primary                    | —               |
| Schema-valid output (Correctness floor)              | ✅ via `validateDoc`          | —               |
| **Rendered-DOM Correctness (ceiling)**               | ❌ no canvas                  | ✅ primary      |
| **Undo/Redo**                                        | partial (`tab.history.index`) | ✅ primary      |
| Streaming display glitches                           | ❌                            | ✅ primary      |
| SSE proxy / model list (`ai-api.js`)                 | optional (proxy mode)         | ✅              |

---

## 3. Build steps (small, sequential)

**Progress (2026-06-20):** Steps 1–5 ✅ — built and smoke-tested offline end-to-end (scripted
client drives the real loop → scorer derives all five axes; undo/redo actually exercised). One
production tweak landed: `createOpenAIStreamingClient` now accepts an optional `temperature`
(forwarded only when defined, so reasoning models can omit it) — needed for the §3.2 determinism
requirement. Existing `ai-loop`/`@jxsuite/ai` tests still pass. Files under
`packages/studio/tests/harness/`: `real-llm.js`, `load-fixture.js`, `score.js`, `run-eval.js`; plus
`eval:headless` script in `packages/studio/package.json`. **Only the first real LLM round-trip is
pending a `JX_AI_KEY`** — run `JX_AI_KEY=… bun run eval:headless L1.1` from `packages/studio`.

**First live run (2026-06-20, gpt-5.4 @ temp 0):** harness works end-to-end. Found + fixed a latent
blocker — tools were sent with OpenAI `strict: true` but the Jx schemas aren't strict-compliant
(polymorphic `value`, optional params), so GPT-5.x rejected every request. Decoupled the registry's
internal `strict` (kept) from OpenAI's payload flag (now opt-in `llmStrict`, default off) in
`packages/ai/src/tools.js`. Completeness rescored from tool-name matching to **outcome assertions**
(`check(finalDoc)`) after a false negative on L1.1. Layer 1 (L1.1–L1.5) then all pass the logic axes.
Open findings: **L1.4 is a no-op** (fixture is already `textAlign:center` → false positive; change
prompt to right/left-align); **Efficiency caps at 3** for read→mutate→wrap (per §3.1 the mandatory
read shouldn't count as a cost — calibration TBD).

**Layers 2–3 seeded (2026-06-20, gpt-5.4 @ temp 0, 1 run each):** all pass the logic axes —
structural mutations (L2.1–L2.5: add/remove/list/wrap) and component-file creation (L3.1/L3.2/L3.4,
asserted on `ctx.writes` + `validateDoc`, one-shot at E:4). Required two harness additions: tests are
**self-contained** (each runs on a fresh fixture — L2.3 add-then-remove instead of "remove the one
you added"), and `check(doc, ctx)` now receives recorded file writes so Layer 3 asserts on the
written component. Finding: **L3.2 needed "component" in the prompt** — without it the model
reasonably added the form to the page instead of creating a file (same test-wording class as L1.4);
prompt aligned to its L3.1/L3.4 siblings.

**Full 3× validation + Layers 4–5 (2026-06-20, gpt-5.4 @ temp 0):** L1–L3 all stable at
worst-of-3 (C:5, R:3 floor, E:4 after the read-discount calibration, V:5\*, U:4–5\*). Calibration
fixes applied: L1.4 → "right-align" (was a no-op on the already-centered fixture); Efficiency now
discounts the mandatory `read_document` round (§3.1). A transient OpenAI `503` errored 1/3 runs of
L3.2 — harness scored the 2 good runs and flagged it, no score poisoning.

Layers 4–5 (1 run): L4.5 ✅, L5.1 ✅ (counter — needs only `state`, which the prompt teaches).
Failures, all one root cause: **the system prompt has zero coverage of `$map` (list rendering),
`$switch` (conditionals), or signals** — confirmed against the rendered prompt — yet Jx uses
`$map`/`$switch` heavily (41/21× in schema+examples). So the model can't produce them: **L5.2**
(todo/`$map`) flailed to the 5-round cap; **L5.3** (tabs/`$switch`) failed. This is the **first real
assistant fix** the harness has surfaced (all prior findings were test-definition slips); it matches
G2 and the §10 symptom table ("Model can't do X → ai-system-prompt.js"). Also **L4.1 is a weak
headless test** — setting `nonExistentProp` succeeds with no error (Jx accepts arbitrary props), so
it never provokes recovery; L4.5 covers genuine bad-path recovery and passed. **Next: add
`$map`/`$switch`/signal few-shot examples (from `examples/`) to `ai-system-prompt.js`, then
regression-check L1–L5.**

**Post-premium-components revalidation (2026-06-22, gpt-5.4 @ temp 0, 1 run each):** Full L1–L5
suite re-run after Phases 1–4 of the premium component plan landed (token injection, design
principles, premium few-shot, token lint). Fixes applied this session:

- `textOf()` in `doc-query.js` now walks string children (was skipping `["Hello World"]`-style text
  nodes → L1.1 false negative).
- Added full tab-switcher example to `CONTROL_FLOW_PATTERNS` in `ai-system-prompt.js` — shows
  onclick handlers + `$switch` + cases end-to-end. Fixed L5.3 (was hitting 5-round cap with invalid
  inline onclick objects).
- L2.5 prompt clarified ("the h1 should become a child of a new header tag"). Initially the model
  renamed the tag (`set_property tagName`) instead of wrapping, which read as a toolset gap.

Results (this session): **17/18 C:5** (L2.5 the lone miss). L5.2 and L5.3 now pass — the
`$map`/`$switch` coverage added in earlier sessions plus the new tab-switcher example resolved the
control-flow gap. 44/44 deterministic AI tests still green.

**L2.5 re-traced (2026-06-22, gpt-5.4 @ temp 0, 5 runs):** now **5/5 PASS, C:5** — the earlier
"renames the tag, needs `wrap_element`" call was wrong. Wrapping is expressible with the existing
toolset by **composing two tools**, and the model discovers it reliably: `read_document` →
`add_child` (empty `<header>` at index 0) → `move_node` (h1 into `["children",0,"children",0]`).
A 1/5 variant uses `add_child` (header already containing the h1) → `remove_node` (old h1). The
explicit second clause in the prompt steers the model off the `set_property(tagName)` rename and
onto the move path. No `wrap_element` tool is needed. Only sub-5 axis is **Efficiency 3** (4 rounds,
3 after the mandatory-read discount) — inherent to a 2-mutation op, not a defect.

### Harness layout

- `load-fixture.js` — copies `sites/test-blank/` to a temp dir; `saveFile` writes land there, never
  the real fixture (§10.3 guardrail). Returns `{ document, projectConfig, components, projectRoot,
saveFile, readWritten }`.
- `real-llm.js` — `buildRealHarness(fx)` wires the production loop; `runPrompt(h, text)` drives one turn.
- `score.js` — `scoreRun({ harness, rounds, expectTools })` → objective sub-signals + conservative
  suggested scores + evidence. Browser-only ceilings (Correctness ≥4, seamless Undo/Redo) returned
  as `N/A (browser)`; never claimed headless.
- `run-eval.js` — runs each test `JX_AI_RUNS` times (default 3), reports the **worst** run per axis,
  emits a turnover-shaped table. Filter by id: `bun run eval:headless L1.1 L1.3`. `JX_AI_JSON=1` for
  full per-run dump.

### Step 1 — Minimal harness module

`packages/studio/tests/harness/real-llm.js` — a thin factory that assembles the production pieces:

```js
import { createChatState, createToolRegistry, createOpenAIStreamingClient } from "@jxsuite/ai";
import { createTab } from "../../src/tabs/tab";
import { registerAiTools } from "../../src/services/ai-tools";
import { runAgentLoop } from "../../src/services/tool-executor";
import { buildSystemPrompt } from "../../src/services/ai-system-prompt";
import { validateDoc } from "../../src/services/jx-validate";

export function buildRealHarness({ document, projectConfig, components, projectRoot, saveFile }) {
  const tab = createTab({ document, id: "harness" });
  const chatState = createChatState({ model: process.env.JX_AI_MODEL ?? "gpt-4o" });
  const toolRegistry = createToolRegistry();
  registerAiTools(toolRegistry, { getTab: () => tab, validate: validateDoc, saveFile });
  const client = createOpenAIStreamingClient({
    baseUrl: process.env.JX_AI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.JX_AI_KEY,
    model: process.env.JX_AI_MODEL ?? "gpt-4o",
  });
  const systemPrompt = buildSystemPrompt({ document, projectConfig, components, projectRoot });
  return { tab, chatState, toolRegistry, client, systemPrompt };
}

export async function runPrompt(h, userText) {
  h.chatState.sendMessage(userText);
  await runAgentLoop({
    chatState: h.chatState,
    streamingClient: h.client,
    toolRegistry: h.toolRegistry,
    systemPrompt: h.systemPrompt,
  });
  return h.chatState;
}
```

Key points already verified against the code:

- `createOpenAIStreamingClient` bypasses the server proxy — no `bun run dev` needed.
- `registerAiTools` accepts `saveFile(relPath, content)` → wire to `fs.writeFile` for Layer 3.
- `buildSystemPrompt` takes `{ document, projectConfig, components, projectRoot }` — load these
  from `sites/test-blank/` so the eval matches the studio.

### Step 2 — Load the `test-blank` fixture

A loader that reads `sites/test-blank/{project.json, pages/index.json, layouts, components}` from
disk into the shapes `buildRealHarness` expects, plus a `saveFile` that writes back into a
**throwaway temp copy** of the site (never the real fixture — guardrail §10.3 of the testing plan).

### Step 3 — Scorer for the logic-only axes

A small assertion helper that derives, from `chatState.messages` + `tab` + `validateDoc`:

- **Completeness** — did the expected tool calls fire? (inspect `role:"tool"` + assistant tool calls)
- **Efficiency** — round count (= number of `streamChat` calls or assistant turns).
- **Recovery** — for L4 prompts, did a `{success:false}` result get followed by a corrected success?
- **Correctness (floor)** — `validateDoc(tab.doc.document)` returns no errors.
- **Undo (partial)** — `tab.history.index` advanced and reverts cleanly.

Leave rendered-DOM Correctness and full Undo/Redo to the studio; mark them `N/A (browser)` here.

### Step 4 — Driver: one test per testing-plan ID

A runner that takes a layer/ID, runs the prompt 2–3× (per §3.2 determinism), reports the worst
run, and emits a turnover-shaped row. Start with L1.1–L1.5 and the L0.5 probes (L1.1/L2.1/L3.1).

### Step 5 — Wire env + a `bun` script

`JX_AI_KEY` / `JX_AI_BASE_URL` / `JX_AI_MODEL` from env (not localStorage). Add e.g.
`bun run eval:headless` invoking the driver. Keep it out of the default `bun test` run so it
doesn't require a key in CI.

---

## 4. SDK fallout (free, once Steps 1–2 land)

Running headless forces the boundary into the open. The harness consumes exactly:
`{ getTab, validate, saveFile }` (tools) + `{ chatState, streamingClient, toolRegistry,
systemPrompt }` (loop). [document-assistant.js](../packages/studio/src/services/document-assistant.js)
is just the _studio_ implementation of that same contract (localStorage + workspace + platform).

The SDK is: that injected contract, documented, with two reference wirings — studio and headless.
No separate extraction project; lift persistence/doc-access out of `document-assistant.js` behind
the interface the harness already proves.

---

## 5. Decisions

1. **Client: direct.** Use `createOpenAIStreamingClient` for the iteration loop (pure logic, no
   `bun run dev`). Proxy (`createProxyStreamingClient`) stays an occasional integration check of
   `ai-api.js`.
2. **DOM: shim only.** The harness relies on `tests/with-dom.ts` and nothing more — tools touch
   `tab.doc.document`, a plain object, so no real DOM is needed.
3. **Model: GPT-5.4 native baseline, DeepSeek/Gemini as a robustness axis.**
   Decided after the 2026-06-20 web review (sources below). Model is a per-run env var, so swapping
   is free; the choice is only about which one we _tune against_.
   - **Tuning baseline — `gpt-5.4` on OpenAI's native endpoint** (`https://api.openai.com/v1`).
     `createOpenAIStreamingClient` was written against OpenAI's exact stream shape, so tool-call
     deltas parse with zero translation-layer ambiguity. Failures are then attributable to _our_
     logic, not the model fumbling or a compat shim mangling the stream. (GPT-5.5 reserved for a
     final ceiling spot-check.)
   - **Regression sweeps — `gpt-5.4-mini`** for the §10 "re-run every prior layer" checks: same
     family, much cheaper, behavior stays comparable to the baseline.
   - **Robustness axis (closes G4) — `deepseek-v4-pro` + optionally `gemini-3.5-flash`** via their
     OpenAI-compatible endpoints, once the logic is solid. Cheap cost fits full-suite repetition.
   - **Why not DeepSeek as the baseline:** V4 has an open bug where streamed tool calls arrive as
     plain text in `content` instead of `tool_calls` ~21% of the time
     ([DeepSeek-V3 #1244](https://github.com/deepseek-ai/DeepSeek-V3/issues/1244)) plus
     `reasoning_content` vs `reasoning_details` mismatches in OpenAI-compat tool loops. That noise
     would poison attribution — perfect to _measure_ on the robustness axis, disqualifying to _tune
     against_. Note `deepseek-chat`/`deepseek-reasoner` aliases deprecate 2026-07-24 → use the
     `deepseek-v4-*` IDs.

### Sources (2026-06-20 review)

- OpenAI lineup (GPT-5.5 / 5.4 / 5.4-mini): <https://openai.com/index/introducing-gpt-5-5/>,
  <https://devtk.ai/en/blog/openai-api-pricing-guide-2026/>
- Tool-calling leaderboard (Gemini 3.5 Flash 42.4, Claude Opus 4.8 41.9):
  <https://llm-stats.com/leaderboards/best-ai-for-tool-calling>
- DeepSeek V4 + streaming tool-call bug: <https://api-docs.deepseek.com/guides/function_calling>,
  <https://github.com/deepseek-ai/DeepSeek-V3/issues/1244>
- Gemini 3.5 Flash (OpenAI-compatible, $1.50/$9): <https://openrouter.ai/google/gemini-3.5-flash>
