# AI Assistant — Premium Component Generation

**Status:** Phases 1–4 implemented, Phase 3 iteration ongoing
**Date:** 2026-06-21
**Owner:** Gideon + Claude
**Branch:** `feat/ai-assistant-stack-b`
**Depends on:** `docs/ai-assistant-decision.md` §13, `docs/ai-assistant-testing-plan.md` (L0–L6 green)

---

## 1. Purpose

The L0–L6 eval proved the assistant produces **structurally correct** Jx — schema-valid, renders,
self-corrects. It does **not** yet produce **premium** output: Linear/Stripe-grade spacing, type
rhythm, elevation, restraint, and consistent use of the project's design tokens. This plan turns
"correct" into "tasteful."

Per ADR §13 this is a **knowledge + context problem, not a tools problem.** `set_property` is fully
general and `add_child` takes a complete node, so the existing tools can already express any DOM +
any CSS. What's missing is (a) design knowledge in the system prompt, (b) the project's actual token
_values_ in context, and (c) high-quality few-shot targets. No new plumbing.

---

## 2. What "premium" means here

Concrete, checkable properties — not vibes:

| Dimension      | Amateur tell                               | Premium target                                                      |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| **Tokens**     | Hard-coded `#3b82f6`, `16px`               | `var(--color-accent)`, `var(--radius)` — references, never literals |
| **Spacing**    | Arbitrary `13px`, `7px`, inconsistent gaps | A rhythm — multiples of a base step (0.25/0.5/0.75/1/1.5/2/3rem)    |
| **Type scale** | Random font sizes, everything bold         | A scale (0.875 / 1 / 1.25 / 1.5 / 2 / 2.8rem); weight for hierarchy |
| **Color**      | Pure black/white, full-saturation accents  | Layered surfaces, muted secondary text, accent used sparingly       |
| **Elevation**  | Heavy borders, no depth                    | Subtle borders + restrained shadows; hover state shifts surface     |
| **Layout**     | Cramped or sprawling; no max-width         | Generous padding, `var(--max-width)` container, responsive `@--bp`  |
| **Restraint**  | Many colors, gradients, effects            | 2–3 colors, one accent, whitespace doing the work                   |

These map to the eval rubric in §6.

---

## 3. Current gaps (verified 2026-06-21)

Read against the live code:

1. **Token _values_ are never injected.** `buildProjectSummary()`
   ([ai-system-prompt.js:483](../packages/studio/src/services/ai-system-prompt.js#L483)) emits only
   token _names_, capped at 15: `Design tokens: --color-bg-primary, --color-accent, …`. The model
   cannot pick the right token without knowing `--color-accent` is blue and `--color-bg-surface` is
   a raised panel. **It must see name → value.**
2. **No design-knowledge section.** The prompt has schema, state, control-flow, and multi-page
   sections — nothing on spacing scale, type scale, elevation, or restraint.
3. **Few-shot examples are functional, not premium.** `REAL_WORLD_PATTERNS` shows _mechanics_
   (props, slots, `$media`) with minimal styling. They teach shape, not taste.
4. **`components` is never passed to the prompt.** `buildPrompt()`
   ([document-assistant.js:68](../packages/studio/src/services/document-assistant.js#L68)) omits
   the `components` arg, so the "Available components" line is always empty — the model can't reuse
   existing project components.
5. **`$media` example is stale.** The few-shot uses `max-width` breakpoints; jxsuite.com mixes a
   bare `"--": "1280px"` container token with `max-width` queries. Worth reconciling so the model
   doesn't copy a malformed breakpoint.

---

## 4. The eval problem (read before scoring)

**There is no automated aesthetic eval.** Schema validation (§6b) and the shadow-render critic
(§6c) catch _correctness_, not _taste_. A component can be schema-valid, render fine, and still look
amateur. This is called out in ADR §13 and it is the single most important constraint on this
workstream:

- **Aesthetic quality is human-in-the-loop.** Each iteration: generate → render in the browser →
  eyeball against §2 → screenshot → refine prompt/examples. The §10 polish-loop discipline from the
  testing plan applies (one change per iteration, attribution tracked).
- **Token-discipline IS automatable** and should be — a lint that flags hard-coded colors/sizes when
  a matching token exists (see §5 Phase 4). This catches the most common amateur tell cheaply.
- **A visual/LLM-judge critic is explicitly later** (Phase 5, optional). Do not block the prompt
  work on building it.

---

## 5. Phased plan

One PR per phase. Each phase is independently shippable and carries its own acceptance criteria.
Phases 1–2 are pure context-injection (cheap, high-leverage, no taste judgment needed). Phase 3 is
the iterative taste work. Phase 4 is the cheap automatable guardrail. Phase 5 is optional.

### Phase 1 — Inject token values + components into context (mechanical, do first)

The model can't use a design system it can't see. Fix the two context gaps before any prompt
wording.

- [x] `buildProjectSummary()`: emit token **name → value** pairs, grouped by prefix (color, font,
      other). 15-token cap removed — full list emitted.
- [x] `buildPrompt()` in `document-assistant.js`: passes `componentRegistry` from workspace. Each
      component listed as `<tag> — $id (path)`.
- [x] Inline instruction on the token list: "always use var(--token) — never hard-code…"
- **Files:** `ai-system-prompt.js` (`buildProjectSummary`), `document-assistant.js` (`buildPrompt`).
- **Acceptance:** With test-blank pointed at a token-rich `project.json`, the system prompt
  (logged via §14.5.4) contains token values and component names. A generation prompt produces
  `var(--…)` references, verified by reading the emitted JSON. No regression on L1–L6 deterministic
  tests.

### Phase 2 — Design-knowledge section in the system prompt

A new `DESIGN_PRINCIPLES` section, pushed after `REAL_WORLD_PATTERNS`. Concise, rule-shaped, not an
essay. Cover exactly the §2 dimensions:

- [x] **Spacing rhythm** — step scale (0.25–4rem); never arbitrary px.
- [x] **Type scale** — 0.875→3rem ladder; fontWeight for hierarchy; muted text tokens.
- [x] **Elevation** — layered surfaces, border tokens, accent sparingly.
- [x] **Layout** — generous padding, var(--max-width), @--md/@--sm responsive overrides.
- [x] **Restraint** — 2–3 colors, whitespace over decoration, no gratuitous effects.
- **Files:** `ai-system-prompt.js` (new section + push in `buildSystemPrompt`).
- **Acceptance:** Section is < ~40 lines (token budget discipline). Re-run a representative
  generation (L3.1 card) and confirm output uses the spacing/type scale and layered surfaces.
  Browser screenshot attached to the turnover. No L1–L6 regression.

### Phase 3 — Curated premium few-shot examples (the iterative taste work)

Replace/augment the functional examples with genuinely premium ones, sourced from jxsuite.com's
polished components (`stat-card`, `pillar-card`, `feature-card`, `cta-button`, `step-card`).

- [x] Picked `stat-card` (layered surface, token discipline, type hierarchy) and `step-card`
      (restraint, centered layout, circular badge). Both schema-valid. Replaced the functional
      `feature-card` example (which had hard-coded rgba).
- [x] Embedded with "Note:" annotations explaining _why_ each is good.
- [ ] Iterate per the §10 polish loop: generate → screenshot → compare to §2 → adjust ONE thing
      (an example, a principle line) → re-generate. Track attribution. (Ongoing — needs browser eval.)
- **Files:** `ai-system-prompt.js`.
- **Acceptance:** A blind comparison (same prompt, before/after this phase) shows the after output
  scoring higher on §2 across ≥3 dimensions, with screenshots in the turnover. This is judgment —
  capture the evidence so it's auditable (§3.2 of the testing plan applies).

### Phase 4 — Token-discipline lint (cheap automatable guardrail)

The one piece of aesthetics that _is_ checkable: did the model hard-code a value a token covers?

- [x] `flagHardcodedTokens(doc, projectStyle)` → `[{ path, property, value, suggestedToken }]`.
      Matches hex colors, px radii, font stacks via reverse index. Case-insensitive. Skips
      `var()` refs, template expressions, and `@--breakpoint` keys.
- [x] **Soft surfacing**: findings appended to `applyAndValidate` success summary. `projectStyle`
      threaded through `registerAiTools` → `applyAndValidate` → all 8 mutation tool calls.
- [x] 10 unit tests in `token-lint.test.js`: hard-coded match, case-insensitive, var() skip,
      template skip, nested children, @breakpoint skip, null inputs, formatTokenHints output.
- **Files:** new `packages/studio/src/services/token-lint.js`; wire into `applyAndValidate` /
  tool-result path in `ai-tools.js`; unit test in `tests/`.
- **Acceptance:** Unit test passes; a browser generation that hard-codes an accent color gets a
  hint and the model switches to the token on the next round.

### Phase 5 — Visual / LLM-judge critic (optional, deferred)

A later automated taste signal. Out of scope for the first PRs; listed so it isn't forgotten.

- [ ] Render the component detached, screenshot it, feed the image to a vision model with the §2
      rubric, return a score + specific critiques the agent loop can act on.
- **Acceptance:** A turnover documenting feasibility/cost, or a written deferral.

---

## 6. Eval rubric (aesthetic axes)

Scored **by a human in the browser** against §2. Target ≥4 on each before a phase is "done."
Mirrors the testing-plan rubric; evidence (screenshot + emitted JSON) required for any axis < 4.

| Axis             | 1 (Fail)                         | 3 (Passable)                   | 5 (Premium)                                  |
| ---------------- | -------------------------------- | ------------------------------ | -------------------------------------------- |
| **Token use**    | Hard-coded values throughout     | Mix of tokens and literals     | All colors/radii/fonts via `var(--token)`    |
| **Spacing/type** | Arbitrary, inconsistent          | Mostly on-scale                | Consistent rhythm + clear type hierarchy     |
| **Color/depth**  | Flat, harsh, over-saturated      | Acceptable contrast, flat      | Layered surfaces, muted text, sparing accent |
| **Layout**       | Cramped/sprawling, no responsive | Reasonable, partial responsive | Generous, max-width, full `@--bp` coverage   |
| **Restraint**    | Busy, many colors/effects        | Slightly over-decorated        | Clean, whitespace-led, 2–3 colors            |

---

## 7. Files in scope

| File                                                 | Phase(s) | Change                                                   |
| ---------------------------------------------------- | -------- | -------------------------------------------------------- |
| `packages/studio/src/services/ai-system-prompt.js`   | 1,2,3    | token values, design-knowledge section, premium few-shot |
| `packages/studio/src/services/document-assistant.js` | 1        | pass `components` into `buildPrompt`                     |
| `packages/studio/src/services/token-lint.js` (new)   | 4        | hard-coded-value detector                                |
| `packages/studio/src/services/ai-tools.js`           | 4        | surface token-lint findings in tool results              |
| `packages/studio/tests/`                             | 4        | token-lint unit test                                     |

---

## 8. Sequencing & discipline

1. **Phase 1 first** — no taste work pays off until the model can see the tokens.
2. **Phase 2** — gives the model the vocabulary.
3. **Phase 3** — the iterative loop; the actual quality lift. Slowest, human-gated.
4. **Phase 4** — lock in token discipline cheaply.
5. **Phase 5** — only if a recurring taste failure needs an automated signal.

**One change per iteration** (testing-plan §10.1) holds throughout Phase 3 — attribution is the
whole point. **Regression check** after every `ai-system-prompt.js` edit: re-run the deterministic
L0–L6 gate (`ai-loop`, `ai-tools`, `render-critic`, `context-manager`, schema) — a prompt tweak for
aesthetics can silently break a structural test.

---

## 9. Risks

| #   | Risk                                                             | Mitigation                                                                                   |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| R1  | Prompt bloat pushes out structural guidance / blows token budget | Keep design section < 40 lines; measure prompt size after each edit                          |
| R2  | Aesthetic scoring is subjective → unfalsifiable "improvements"   | Blind before/after screenshots; ≥3-dimension lift required (§5.3)                            |
| R3  | Token values vary per project → examples may not match           | Inject the _active_ project's tokens (Phase 1); keep examples token-referencing, not literal |
| R4  | Soft lint ignored by the model                                   | Escalate to hard-fail only if soft proves insufficient (Phase 4)                             |
| R5  | No automated taste eval → quality regresses silently later       | Phase 5 LLM-judge as the eventual backstop; until then, manual spot-checks on prompt changes |
