# AI Assistant — Architecture Decision Record

**Status:** Accepted (2026-06-13)
**Date:** 2026-06-12
**Decision owner:** Gideon
**Supersedes the network/UX assumptions in:** `docs/ai-assistant-plan.md`, `specs/ai-assistant.md`

---

## 1. Why this doc exists

Two **independent** AI assistant implementations currently coexist in the tree. They were
built against different assumptions and do not agree on provider, mutation model, UI library,
or transport. Before writing more code we need to pick one canonical direction so the two
stop diverging.

This ADR records the conflict, the trade-offs, the decision, and the locked-in UX choices.

---

## 2. The two stacks

### Stack A — Claude Agent SDK (shipped, platform-abstracted)

| Aspect         | Detail                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| UI             | `packages/studio/src/panels/ai-panel.ts` — right-panel tab, **QuikChat** (vanilla, not React), `EventSource` SSE |
| Backend        | `packages/server/src/claude-session.ts` (`streamSession`), desktop `packages/desktop/src/ai.ts` `handleAiRoute`  |
| Transport      | `plat.aiStreamUrl(id)` — **routed through `getPlatform()`**, implemented for HTTP server _and_ Electrobun RPC    |
| Provider       | Anthropic Claude via Agent SDK                                                                                   |
| Mutation model | **File-level** — edits files on disk like Claude Code; not `.jx`-AST aware                                       |
| Loop           | **Native agentic loop** (plan → act → observe → repeat)                                                          |
| Undo/redo      | None integrated — writes files directly, bypasses `transactDoc()`                                                |
| Desktop-safe?  | ✅ yes — abstraction implemented in both shells                                                                  |

### Stack B — OpenAI tool-calling (the plan/spec, partially built)

| Aspect         | Detail                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| UI             | `specs/ai-assistant.md` calls for lit-html + Spectrum chat built from scratch (`chat-messages`, `chat-composer`) — **not yet built** |
| Infra          | `packages/ai/` — `chat-state.js`, `streaming-client.js`, `tools.js` (registry only, **no concrete tools**)                           |
| Backend        | `packages/server/src/ai-api.js` — SSE proxy at `/__studio/ai/chat` (built + tested)                                                  |
| Transport      | Raw `fetch('/__studio/ai/chat')` — **NOT in `StudioPlatform`**                                                                       |
| Provider       | OpenAI (GPT-4o/4.1); Anthropic client stubbed                                                                                        |
| Mutation model | **AST-level** — manipulates the in-memory `.jx` document via `transactDoc()`                                                         |
| Loop           | Specced (error-correction, cap 5 rounds, §10.2) — **orchestrator not built** (`tool-executor.js`, `context-manager.js` absent)       |
| Undo/redo      | ✅ free via `transactDoc()`                                                                                                          |
| Desktop-safe?  | ❌ no — proxy is HTTP-only; breaks in the Electrobun packaged build (webview → backend over RPC, no HTTP origin)                     |

---

## 3. The decision dimensions

1. **Product fit.** A layout builder needs _structured, reversible, canvas-visible_ edits to the
   `.jx` document. Stack B's `transactDoc()` AST model is the right abstraction; Stack A's
   file-level edits are a generic coding agent bolted into a panel.
2. **Undo/redo + optimistic apply.** This is a `transactDoc()` concept. Only Stack B can deliver
   the "auto-apply, then undo/redo" UX (see §5). Stack A writes files and has no Studio history hook.
3. **Desktop portability.** Studio ships as a desktop app (`packages/desktop`, Electrobun, MSIX
   release scripts). Anything not routed through `getPlatform()` works in web/dev/NixOS but **breaks
   in the packaged build**. Stack A already solves this; Stack B does not yet.
4. **Loop / self-improvement.** Stack A loops for free. Stack B's loop is designed but unbuilt.
5. **Sunk cost.** Stack B's proxy, infra package, and system prompt are built/tested. Stack A's
   panel mount, SSE plumbing, and platform abstraction are built and shipping.

---

## 4. Decision

**Adopt Stack B (OpenAI tool-calling on the `.jx` AST via `transactDoc()`) as the canonical
assistant**, because it is the only path that delivers structured, reversible, canvas-visible
edits with undo/redo.

**Port three things from Stack A instead of rebuilding them:**

1. **The `getPlatform()` backend abstraction.** Add an AI method to the `StudioPlatform` interface
   and implement it in both desktop platforms (`packages/desktop/src/platform.ts` via RPC and
   `chromium/platform.ts`). This is the fix that makes Stack B desktop-safe. Without it, Stack B
   is a web-only demo.
2. **The existing right-panel mount.** Keep `ai-panel.ts` as the mount point — do not build a new
   sidebar. The chat already lives where it should.
3. **(MVP shortcut) QuikChat as the chat renderer.** It is already integrated and is vanilla JS
   (not React), so it does not violate the "no React" constraint. Building lit-html chat from
   scratch (spec §11.3) is deferred — it buys polish, not capability.

**Keep Stack A alive as an optional "file/dev agent" mode**, not the default. It is genuinely useful
for repo-level operations the document assistant can't do. Do not delete shipped, working code; gate
it behind a mode toggle.

### What this means concretely

- Canonical assistant = `@jxsuite/ai` + `ai-api.js` + AST tools, mounted in the right panel.
- First real work: define the **concrete tools** (the registry is empty) + the **loop orchestrator**.
- Required, non-negotiable: the platform abstraction, or it won't ship on desktop.

---

## 5. Locked UX decision — optimistic apply + undo/redo

**Chosen:** AI changes **auto-apply to the live canvas immediately** via `transactDoc()`. If the user
dislikes the result, **undo/redo** (Ctrl+Z / Ctrl+Y, plus an in-chat Undo button) rolls it back through
Studio's native history.

**Rejected for MVP:** the batched canvas-diff "Accept/Reject" preview gate from `specs/ai-assistant.md`
§8. It is a large state-synchronization effort and adds friction. The spec's §8 should be updated to
reflect this.

**Why this works:** every AI mutation is one `transactDoc()` transaction, so undo/redo is free and
each AI edit is a discrete, reversible step in the same history stack as manual edits. Optimistic apply
also means the agent loop (§6) can _see_ the applied result on the next round.

---

## 6. Looping & self-improvement — status and plan

The user asked: _does our plan allow looping / self-improvement?_ Two different capabilities:

### 6a. Error-correction loop (MVP, in spec, NOT yet built)

Spec §10.2: a failed tool call returns `{success:false, error}`, fed back as a `tool` message; the
LLM retries, capped at **5 rounds**. Primitives exist (`appendToolResult`, `retryLast`); the **driver
that re-calls `streamChat()` after tool results does not exist**. This orchestrator
(`tool-executor.js` / `context-manager.js` in spec §11.2) is the first thing to build in Stack B.
Loop shape: `stream → collect tool calls → execute via transactDoc → append results/errors → re-stream
until no tool calls or cap hit`.

### 6b. Schema-validation eval signal (MVP — sourced from jx-harness)

The strongest near-term eval signal already exists in-process: `validateDocument(doc)` in
`packages/schema/src/schema.ts` returns `{ valid, errors }` via ajv against the same `schema.json`
the compiler uses. The standalone **`jx-harness`** project (`/home/gideon/Dev/jx-harness`) proves the
pattern — its `jx-validate.js` runs exactly this schema validation for external coding agents.

Wire `validateDocument` into the loop (6a): after each mutation, validate the affected subtree and
feed any ajv errors back as the tool result. This upgrades self-correction from "did the tool throw"
to "is the result schema-valid" — catching hyphen-less tagNames, string-vs-object styles, IDL-vs-
attribute mistakes, etc. Deterministic, cheap, and available now. **Validate the edited subtree (or
diff errors), not the whole document** — whole-doc validation surfaces pre-existing errors unrelated
to the AI's edit and is slower.

Two upstream cleanups this surfaces: `jx-harness` carries a runtime patch for a "PropsObject oneOf
overlap" bug in `schema.json` — fix it in `@jxsuite/schema` rather than duplicate the patch; and the
harness hardcodes a local repo path + `opensrc`, which should become a dependency on the published
`@jxsuite/schema`.

### 6c. Shadow-render critic (true Phase 2)

The remaining gap is _runtime_ errors schema validation can't catch (bad bindings, render-time
exceptions). The original `ai-assistant-plan.md` shadow-render + error-boundary idea covers this:
apply the change to an off-screen runtime instance, capture render errors, feed them back. Deferred to
Phase 2 — 6b covers most failure modes first.

**Summary:** the plan _allows_ looping (error-correction, capped). MVP wires the existing
`validateDocument` schema check into the loop (6b, shared with jx-harness); the shadow-render critic
(6c) is true Phase 2. Stack A already loops natively, one reason to keep it as a fallback agent mode.

### 6d. Shared core with jx-harness (open-source alignment)

`jx-harness` and the Studio assistant have the same core needs — authoring rules, schema validator,
golden examples. Keep them from diverging:

- **Validator:** both consume `@jxsuite/schema`'s `validateDocument` (Studio in-process; harness via
  the published package instead of a local path).
- **Rules:** `ai-system-prompt.js` should source its ruleset from the same canonical text as the
  harness `jx-rules.md` / `agent-configs/`, not a hand-rolled copy.
- **Examples:** the golden examples (`examples/components/*`, `examples/pages/blog/*`) double as
  few-shot for the system prompt.

---

## 7. Sign-off (resolved 2026-06-13)

- **Stack B is canonical; Stack A is demoted to an optional file/dev-agent mode** (not retired).
- **QuikChat for MVP** — lit-html chat from scratch is deferred.
- **Shadow-render critic (6b) is Phase 2**, not MVP.

---

## 8. Immediate next steps

1. ✅ **Done** — Added `aiChatUrl()` to `StudioPlatform` + all three adapters (devserver,
   Chromium, Electrobun). Electrobun's local AI `Bun.serve()` now also mounts
   `@jxsuite/server/ai-api`'s `handleAiApi` alongside the existing Claude session routes, so the
   Stack B proxy is reachable from every shell. `@jxsuite/server` gained an `./ai-api` export and
   `@jxsuite/studio` now depends on `@jxsuite/ai`.
2. ✅ **Done** — Defined the concrete AST tools (`read_document`, `set_property`, `add_child`,
   `remove_node`) in `packages/studio/src/services/ai-tools.js` (Studio-specific, per spec §11.2),
   built on the existing `mutate*` helpers in `tabs/transact.ts` — not in `packages/ai/src/tools.js`,
   which stays provider-agnostic infra only.
3. ✅ **Done** — Loop orchestrator (6a) — `packages/studio/src/services/tool-executor.js`
   (`runAgentLoop`, cap 5 rounds). Added `beginAssistantTurn` + `pushToolResultMessage` to
   `@jxsuite/ai`'s `chat-state.js` to support multi-round tool feedback.
4. ✅ **Done (from jx-harness)** — Wired schema validation into the tools as the eval signal (6b):
   `services/jx-validate.js` compiles `@jxsuite/schema` once and `services/ai-tools.js`
   `applyAndValidate` validates before/after each mutation, returning only newly-introduced ajv
   errors as a failed tool result so the loop self-corrects. Aligned the system-prompt tool names
   (`read_document`/`set_property`/`add_child`/`remove_node`) and added schema-error guidance.
5. ✅ **Done** — Repointed `ai-panel.ts` at Stack B via `services/document-assistant.js` (uses
   `createProxyStreamingClient` + `plat.aiChatUrl()`), with incremental QuikChat streaming, an
   Assistant/Dev-Agent mode toggle, and the Claude-auth gate scoped to dev-agent mode only.
6. ✅ **Done** — Updated `specs/ai-assistant.md` §8 to the optimistic-apply model (batched diff
   superseded) and the §1 overview to match.

**All six steps complete.** The MVP is implemented end-to-end: request → proxy stream → AST tools
applied optimistically with undo/redo → schema-validated self-correction loop.

> [!IMPORTANT]
> **"Complete" = the architecture skeleton is wired and tested, NOT that the assistant is
> feature-complete or bug-free.** The six steps above are done; the canonical stack is settled.
> Remaining work is _finishing the MVP on this skeleton_ — see §11. Do not re-open the
> architecture decision or revive the native-UI plan to address the gaps below.

---

## 9. Verification (2026-06-13)

- **Integration tests** (`packages/studio/tests/ai-loop.test.js`) drive the real `runAgentLoop` +
  `registerAiTools` + a real in-memory `tab` with a fake streaming client (no LLM): tool call
  mutates the live doc with one undoable transaction; an injected schema error is fed back and the
  model self-corrects; the 5-round cap trips with the right error. `jx-validate-smoke.test.js`
  exercises the **real** `@jxsuite/schema` validator: valid doc → `[]`, malformed `style` →
  `["/style: must be object"]`. 28 tests pass (5 new + 23 `@jxsuite/ai`); lint clean; typecheck at
  pre-existing baseline.
- **Bug caught & fixed by the smoke test:** the generated schema is JSON Schema **draft 2020-12**;
  `jx-validate.js` originally used the default `Ajv` (draft-07), which _throws_ on the 2020
  meta-schema ref — the exact issue jx-harness works around. Fixed to use `ajv/dist/2020.js` and to
  degrade to a no-op (never throw) if compilation fails.
- **Live proxy verified** on the dev server (`bun run dev`, port 3000): `GET /__studio/ai/models`
  returns the model list (`configured:false` with no key); `POST /__studio/ai/chat` returns the
  correct 401 with a key-missing message. The server-side wiring works in the running app.
- **Upstream follow-up:** `@jxsuite/schema`'s own `validateDocument` uses plain `Ajv` too and likely
  has the same draft-2020 latent bug — worth fixing there. Nothing in this feature depends on it.

---

## 10. Running the assistant locally

**Recommended (lightest): the browser/HTML dev path.** Studio is a web app; its default
`createDevServerPlatform()` adapter talks to `@jxsuite/server` over same-origin `/__studio/*`. So:

1. `bun run build:studio` (once, after code changes).
2. `bun run dev` — serves the repo (incl. Studio's built assets) and mounts the AI proxy on `:3000`.
3. Open `http://localhost:3000/packages/studio/index.html` in a normal browser tab.

Verified serving: `/packages/studio/index.html` → 200, `/packages/studio/dist/studio.js` → 200,
`/__studio/ai/models` → 200. This is lighter than the Chromium/Electrobun desktop shells and is the
preferred dev-test loop. (The desktop shells — `bun run desktop:chromium` on NixOS, `bun run desktop`
for Electrobun — remain the packaged paths.)

**API key (gap now closed).** The Assistant tab has a key gate: a `🔑` settings form (panel
`ai-panel.ts` + `services/ai-settings.js`) stores an OpenAI-compatible key in `localStorage` and sends
it as `X-Api-Key`. **Any OpenAI-compatible key/endpoint works** — an optional endpoint field sends
`X-Api-Base-URL` (local LLM, OpenRouter, Azure, Together, …); the proxy forwards to
`{baseUrl}/chat/completions`. The server `OPENAI_API_KEY` / `OPENAI_BASE_URL` env vars remain a
fallback when the client sends nothing.

Steps: open the Studio URL above → right panel **Assistant** tab → enter your key (+ optional
endpoint) in the gate → type a request → edits apply to the canvas, Ctrl+Z to undo.

---

## 11. Remaining MVP work (post-skeleton, 2026-06-18)

The §8 skeleton is done; these are the gaps that make the assistant feel incomplete in real use.
All are additive on Stack B — **no architecture change, no native-UI revival.**

1. **Streaming reactivity bug (refresh).** `packages/ai/src/chat-state.js` `beginAssistantTurn`
   keeps a reference to the **raw** placeholder message, then `appendDelta` writes
   `_streamingMessage.content` through that raw reference (line ~182). Because the write bypasses
   the Vue `reactive()` proxy, effects reading `messages[i].content` (e.g. `ai-panel.ts`
   `watchAssistant`) are never notified — the chat only updates on remount (tab switch). Fix:
   mutate through the proxy (re-read `store.messages[len-1]` after push) or render from
   `streamingContent`. Add a test that asserts live streaming notifies an effect.
2. **Tool coverage.** Only 4 tools ship (`read_document`, `set_property`, `add_child`,
   `remove_node`). The model proposes changes it cannot express → "fails to create some changes."
   Add (at least): `set_style`, `set_text`, `add_state`/`update_state`, `move_node`,
   `create_component`, `create_page`. Mine `ai-assistant-plan.md` Phase 4 for the shape (snake_case,
   `transactDoc()`-backed, schema-validated).
3. **Tool/validation error surfacing.** Failed tool results (`{success:false}`) should be visible
   in the panel, not silent, so users see why an edit didn't land.
4. **Context management.** `context-manager.js` does not exist; long conversations will overflow
   with no trimming/summarization. (Plan Phase 5 is the backlog reference.)
5. **Conversation persistence.** localStorage restore not built (plan step 19).
6. _Deferred, unchanged:_ shadow-render critic (§6c).

## 12. Parked work

The native lit-html chat components (`chat-messages.js`, `chat-composer.js`, `chat-tool-call.js`)
written against the superseded plan are **parked, unwired**, on branch `parked/native-chat-ui`.
They are not part of Stack B and must not be wired into `ai-panel.ts` without re-opening §4.3.
Reusable if native chat is ever revisited: the markdown renderer and composer keybindings.
