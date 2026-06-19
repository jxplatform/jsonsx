> [!WARNING]
> **SUPERSEDED (2026-06-18) — read `docs/ai-assistant-decision.md` first.**
> This plan is kept as a **capability backlog only**, not as a live checklist. The
> ADR overrode its core design decisions:
>
> - **UI:** native lit-html chat from scratch → **deferred**. Stack B uses **QuikChat**
>   in `ai-panel.ts` (ADR §4.3). The native components written for Phases 2–3 are parked,
>   unwired, on branch `parked/native-chat-ui`.
> - **Placement:** bottom panel + overlay (Phase 3 / step 12) → **right-panel tab** (ADR §4.2).
> - **Diff UX:** batched accept/reject canvas diff (Phase 4 / step 16) → **optimistic apply +
>   undo/redo** (ADR §5).
> - **Tools:** the 13-tool camelCase table (Phase 4) → shipped as **4 snake_case tools**
>   (`read_document`, `set_property`, `add_child`, `remove_node`; ADR §8.2). Expanding this
>   set is the main remaining MVP work.
>
> Still useful here: the tool ideas, context-management strategy (Phase 5), and persistence
> (step 19) as a backlog. Everything about UI framework, panel placement, and the diff gate
> is obsolete.

## Plan: AI Chat Assistant for Jx Studio

**TL;DR** — Add a native lit-html + Spectrum chat panel to Jx Studio that lets users build and iterate on websites and components using natural language. An OpenAI-powered LLM can read, create, and modify Jx JSON documents via a tool-calling system. The chat panel lives in a resizable bottom panel (with overlay fallback on small viewports); the LLM gets a carefully designed system prompt with Jx schema context, few-shot examples, and live document context; changes are previewed as a single batched canvas diff before being applied through `transactDoc()` for full undo/redo. No React — all UI is native lit-html + Spectrum Web Components, following assistant-ui's architecture patterns.

**LOE Estimate**: ~16–17 days for a senior developer familiar with the codebase. ~28 days for a developer new to the project.

---

### Phase 0: Spec, Infrastructure & System Prompt (3 days)

_System prompt is the single most important quality driver — designed here, not deferred._

0. **Write `specs/ai-assistant.md`** — New spec covering:
   - Chat panel architecture, streaming protocol, tool system
   - Streaming client abstraction layer (see Decision: Provider Abstraction)
   - Diff preview UX: single batched canvas diff per LLM response, not individual property diffs
   - Panel placement: bottom panel with overlay fallback on small viewports
   - Rate limiting / queuing policy: disabled composer during streaming (explicit decision)
   - Conversation persistence: localStorage for last N messages (explicit decision)
   - Invalid LLM output handling: catch invalid JX, display error, do not apply
   - Token management strategy: selective subtree context, not full document
   - `@jxsuite/ai` package boundary: infrastructure (base classes, state, streaming) vs studio (JX-specific tools, system prompt)
   - Update `specs/studio.md` to reference the new panel.

1. **Draft system prompt template** — `packages/studio/src/services/ai-system-prompt.js`. This is the quality foundation and must be built in Phase 0, not Phase 5. Includes:
   - Condensed Jx schema reference (structural patterns, `state` shape decision tree, `$ref` syntax, `$map`, `$switch`, `children` nesting)
   - Few-shot examples from `examples/components/` (counter, todo, contact-form — clean, tested patterns)
   - State shape decision tree: when to use scalar signal vs computed vs function vs data source
   - Component hierarchy rules: what can nest in what, void elements list
   - Style system: CSS property naming, `$media` breakpoints, responsive patterns
   - Document structure: `$id`, `$schema`, `tagName`, `children`, `state`, `style`
   - Project-level context: pages, layouts, components, content collections (from site-architecture spec)
   - Error recovery guidance: what to do when a tool call fails, how to self-correct
   - _parallel with step 0_

2. **Add `@jxsuite/ai` package scaffolding** — New package at `packages/ai/` with `package.json`, `bunfig.toml`, `src/`, `tests/`.

   **Package boundary (explicit):**
   - `@jxsuite/ai` provides: reactive chat state management base, streaming client abstraction layer, tool registry infrastructure (base classes, validation, execution pipeline). These are reusable outside Studio.
   - `@jxsuite/studio` provides: JX-specific tool implementations, system prompt, chat panel UI, settings UI. These are Studio-specific.

   **Streaming client abstraction layer (designed upfront, not retrofitted):**
   - `StreamingClient` interface with methods: `streamChat(messages, tools, systemPrompt, signal)` → `AsyncGenerator<StreamEvent>`
   - `StreamEvent` union type: `{ type: "delta", content } | { type: "tool_call_start", id, name } | { type: "tool_call_delta", id, args } | { type: "tool_call_end", id } | { type: "done", stopReason } | { type: "error", message }`
   - `OpenAIStreamingClient` — implements interface for OpenAI's SSE format
   - `AnthropicStreamingClient` — implements interface for Anthropic's SSE format (built in parallel for design validation, or stubbed for v1)
   - This abstraction prevents a significant refactor when adding Anthropic. The formats differ in tool call delta streaming, stop reason field names, and partial JSON accumulation.

   Dependencies: `@vue/reactivity` (already in workspace).
   - _parallel with step 0_

**🔴 Phase 0 Gate — ALL must pass before Phase 1 starts:**

| #    | Test                                                                                                                                                                                                                    | Type                 | What FAILURE looks like                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| G0.1 | `bun test --cwd packages/ai` exits 0 with ≥1 passing test (scaffolding smoke test)                                                                                                                                      | Automated            | Tests file missing, 0 tests run, or test fails                                                                 |
| G0.2 | `bun run --cwd packages/ai build` completes without error                                                                                                                                                               | Automated            | Build fails, missing exports, broken entry point                                                               |
| G0.3 | `specs/ai-assistant.md` exists and contains all 9 sections listed in step 0                                                                                                                                             | Manual               | Missing sections: streaming protocol, diff UX, panel placement, token strategy, package boundary, etc.         |
| G0.4 | System prompt template in `ai-system-prompt.js` exports a function that returns a string ≥ 2000 chars when called with a mock project context (counter component + basic site structure)                                | Automated            | Export missing, function throws, returned string is empty or too short                                         |
| G0.5 | `StreamingClient` interface file exists with `streamChat()` method signature; `StreamEvent` union type has all 6 variants (`delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `done`, `error`)             | Manual (code review) | Interface file missing, method signatures don't match spec, missing event variants                             |
| G0.6 | **Visual**: Open `specs/ai-assistant.md` in VS Code Markdown preview — spec is readable, well-structured with heading hierarchy, covers all topics from step 0, includes ASCII art or mermaid diagrams for architecture | Manual (VS Code)     | Flat structure, no diagrams, vague language like "the chat will work with streaming", missing heading sections |

**📋 Phase 0 Turnover — completed 2026-06-08**

| Artifact | Path                                               | Description                                                                                                                                                                                                                                                                                                                                 |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec     | `specs/ai-assistant.md`                            | 12-section spec: architecture, chat UX, streaming protocol, tool system, system prompt design, context management, diff preview, settings, error handling, package boundary. References real component patterns from `sites/jxsuite.com/` (cta-button, feature-card, base layout, project.json design tokens).                              |
| Package  | `packages/ai/`                                     | `@jxsuite/ai` v0.1.0: `package.json`, `bunfig.toml`, `src/index.js` (re-exports). Dependencies: `@vue/reactivity ^3.5.34`.                                                                                                                                                                                                                  |
| Module   | `packages/ai/src/streaming-client.js`              | `STREAM_EVENT_TYPES` (6 variants), `OpenAIStreamingClient` (full impl: SSE parsing, tool call accumulation, abort handling), `AnthropicStreamingClient` (stub returning `NOT_IMPLEMENTED` error).                                                                                                                                           |
| Module   | `packages/ai/src/tools.js`                         | `ToolDefinition`, `ToolRegistry` (register/list/listForLLM/validate/execute), `ToolResult`. Validation: required props, type checking with numeric string coercion, non-numeric string rejection.                                                                                                                                           |
| Module   | `packages/ai/src/chat-state.js`                    | `createChatState()` — reactive store (`messages`, `status`, `streamingContent`, `pendingToolCalls`, `error`, `model`, `tokenCount`, `contextWarning`). Methods: `sendMessage`, `appendDelta`, `appendToolCallStart/Delta/End`, `appendToolResult`, `finishStream`, `setError`, `cancelStream`, `clearChat`, `retryLast`, `toMessagesArray`. |
| Module   | `packages/studio/src/services/ai-system-prompt.js` | `buildSystemPrompt({document, projectConfig, components, projectRoot})` — 12,571 byte file. Constructs prompt from: role/capabilities, Jx schema reference, state shape decision tree, real-world component patterns (from `sites/jxsuite.com/`), current document structural summary, project context, error recovery guidance.            |
| Tests    | `packages/ai/tests/core.test.js`                   | 23 tests: ToolRegistry (7), ChatState (13), StreamingClient (3). All pass.                                                                                                                                                                                                                                                                  |
| Gate     | `G0.1`                                             | ✅ 23/23 tests pass.                                                                                                                                                                                                                                                                                                                        |
| Gate     | `G0.2`                                             | ✅ Build: 6 modules in 46ms.                                                                                                                                                                                                                                                                                                                |
| Gate     | `G0.3`                                             | ✅ Spec has all 9 required sections.                                                                                                                                                                                                                                                                                                        |
| Gate     | `G0.4`                                             | ✅ System prompt file 12,571 bytes with 5 substantive sections.                                                                                                                                                                                                                                                                             |
| Gate     | `G0.5`                                             | ✅ All 6 StreamEvent variants defined; OpenAI client has full SSE parsing.                                                                                                                                                                                                                                                                  |
| Gate     | `G0.6`                                             | ⚠️ Manual visual review of spec pending.                                                                                                                                                                                                                                                                                                    |

**Key decisions carried forward:**

- `StreamingClient` interface abstracts OpenAI/Anthropic differences. Anthropic stub returns descriptive error, not a crash.
- `ToolRegistry.validate()` accepts numeric strings (`"42"` → number) but rejects non-numeric strings (`"not a number"` → error).
- `ChatState` uses `@vue/reactivity` `reactive()` — all mutations are automatically tracked by Studio's `effect()` system.
- System prompt includes structural summary (element tree outline without property values) — the full document is never dumped into context.
- `@jxsuite/ai` has zero Studio/Jx dependencies. Studio-specific code lives in `packages/studio/src/services/`.

**For the next agent:**

- Read `specs/ai-assistant.md` first — it defines the full architecture.
- Phase 1 (next) adds `packages/server/src/ai-api.js` with `/__studio/ai/chat` (SSE proxy) and `/__studio/ai/models` endpoints.
- The `@jxsuite/ai` package is ready to be used from Studio code. Import paths: `@jxsuite/ai`, `@jxsuite/ai/streaming-client`, `@jxsuite/ai/tools`, `@jxsuite/ai/chat-state`.
- Run `bun test --cwd packages/ai` after any changes to the ai package.
- The server proxy should transform OpenAI SSE into `StreamEvent`-compatible SSE format. The `OpenAIStreamingClient` in `streaming-client.js` shows the expected transformation logic.

---

### Phase 1: Server-Side AI Proxy (2 days)

3. **Add `/__studio/ai/chat` SSE endpoint to `@jxsuite/server`** — New file `packages/server/src/ai-api.js`. Accepts POST with `{ messages, tools, systemPrompt, model }`, streams chat completions via SSE.
   - Uses `fetch` to OpenAI API (base URL via env `OPENAI_BASE_URL`, key via `OPENAI_API_KEY`).
   - Streams response chunks as `data:` SSE events with typed event names matching `StreamEvent`.
   - Tool call deltas streamed incrementally; partial JSON accumulation handled server-side, emitted as complete tool calls when finished.
   - AbortSignal forwarded from client to upstream request for stream cancellation.
   - Register in `packages/server/src/server.js` route table.
   - _depends on step 2_

4. **Add `/__studio/ai/models` endpoint** — Returns available models, rate limits, and configuration status for the model picker UI.
   - _parallel with step 3_

**🔴 Phase 1 Gate — ALL must pass before Phase 2 starts:**

| #    | Test                                                                                                                                                                                                                                                                                                                                                                                                                    | Type              | What FAILURE looks like                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| G1.1 | `curl -X POST http://localhost:3000/__studio/ai/chat -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"say hello"}],"tools":[],"systemPrompt":"You are helpful.","model":"gpt-4o"}'` returns SSE stream with `data:` events (requires valid `OPENAI_API_KEY` env var, skip if unavailable — gateway passes with a 401 response that includes `error` field, proving the endpoint is wired) | Automated         | 404 (route not registered), 500 with no error body, no SSE headers, or no response at all         |
| G1.2 | `curl http://localhost:3000/__studio/ai/models` returns JSON array with at least one model entry containing `id` and `name` fields                                                                                                                                                                                                                                                                                      | Automated         | 404, empty array, missing `id`/`name` fields                                                      |
| G1.3 | Unit test: `bun test packages/server/tests/ai-api.test.js` — test SSE event parsing from a recorded/mock OpenAI response fixture. Test that `tool_call_start`, `tool_call_delta`, `tool_call_end` events are emitted in correct order.                                                                                                                                                                                  | Automated         | Events out of order, missing events, malformed JSON in tool call args                             |
| G1.4 | Unit test: `bun test packages/server/tests/ai-api.test.js` — test that `AbortSignal` propagation cancels the upstream fetch. Verify the SSE stream terminates with a `done` or `error` event.                                                                                                                                                                                                                           | Automated         | Stream hangs indefinitely, abort not propagated, memory leak                                      |
| G1.5 | **Visual**: Start dev server (`bun run dev`), open browser devtools Network tab, send a curl POST to `/__studio/ai/chat` with a real API key. Verify the Network tab shows a streaming response with `Content-Type: text/event-stream` and `Transfer-Encoding: chunked`.                                                                                                                                                | Manual (DevTools) | Response is buffered (no chunked encoding), wrong content type, no streaming visible in waterfall |

### Phase 2: Chat UI Primitives (3 days)

_All UI must follow Studio rules: lit-html templates only, Spectrum Web Components, no inline styles._

5. **`jx-chat-messages` template** — Scrollable message list. Messages have roles (user/assistant/system/tool), content (markdown rendered via existing `remark-*` stack or lightweight markdown-to-HTML), and optional tool call/results.
   - Auto-scroll to bottom on new messages; pause auto-scroll when user scrolls up, resume when they scroll to bottom.
   - Streaming indicator (typing dots via a small `sp-progress-circle` or animated dots) while assistant is responding.
   - Code blocks with syntax highlighting (reuse Monaco tokenizer or a lightweight highlighter).
   - _depends on step 2_

6. **`jx-chat-composer` template** — Text input (`sp-textfield`, multiline, auto-growing) + send button (`sp-action-button`). `Enter` to send, `Shift+Enter` for newline. **Disabled while streaming** (the rate limiting / queuing policy: no queuing, no cancellation by sending again — the composer simply disables). A "Stop" button appears during streaming to cancel the current response.
   - Model picker (`sp-picker`, quiet) showing available models from step 4.
   - Context attachment indicator (shows current file/site being edited).
   - _parallel with step 5_

7. **`jx-chat-tool-call` template** — Rendered inline within assistant messages when tool calls occur. Shows expandable tool call details (`sp-accordion`): tool name, arguments (pretty-printed JSON). After execution, shows result summary badge (e.g., "Modified 3 properties", "Added 1 element", or an error badge for invalid calls).
   - _parallel with step 5_

8. **Chat state management module** — `packages/studio/src/services/chat-state.js`. Reactive state (Vue reactivity) for: message list, streaming status (`idle | streaming | error`), current model, tool call queue, error state, conversation ID.
   - Functions: `sendMessage(text)`, `cancelStream()`, `clearChat()`, `retryLast()`.
   - Mirrors assistant-ui's runtime/state pattern but built on Vue reactivity.
   - _parallel with step 5_

**🔴 Phase 2 Gate — ALL must pass before Phase 3 starts:**

| #    | Test                                                                                                                                                                                                                                                                                                        | Type                  | What FAILURE looks like                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| G2.1 | Unit test: render `jx-chat-messages` with a 3-message conversation (user→assistant→user), verify all 3 messages appear in DOM, roles display correctly, markdown in content renders as HTML                                                                                                                 | Automated (Happy DOM) | Messages missing, roles wrong, markdown not rendered (raw markdown visible)                           |
| G2.2 | Unit test: render `jx-chat-messages` in streaming state, verify streaming indicator (`.chat-streaming-indicator` or `sp-progress-circle`) is present in DOM                                                                                                                                                 | Automated (Happy DOM) | No indicator element found in streaming state                                                         |
| G2.3 | Unit test: render `jx-chat-composer`, verify `sp-textfield` is enabled by default. Set chat state to streaming, verify `sp-textfield` is `disabled` and Stop button appears.                                                                                                                                | Automated (Happy DOM) | Textfield enabled during streaming, Stop button missing, or textfield disabled when idle              |
| G2.4 | Unit test: render `jx-chat-tool-call` with a tool call (name: "updateStyle", args: `{path: [\"children\",0], prop: "color", value: "red"}`), verify tool name and args visible. Update with result `{success: true, summary: "Updated 1 property"}`, verify result badge shows.                             | Automated (Happy DOM) | Tool name hidden, args not shown, result badge missing after update                                   |
| G2.5 | Unit test: `chat-state.sendMessage("hello")` adds a user message, sets status to `streaming`. `chat-state.cancelStream()` sets status to `idle`. `chat-state.clearChat()` empties messages.                                                                                                                 | Automated (Happy DOM) | Wrong status transitions, messages not cleared, sendMessage doesn't add to message list               |
| G2.6 | **Visual**: Open `packages/studio/index.html` in browser, manually inject `jx-chat-messages` + `jx-chat-composer` into a test container. Verify Spectrum styling applies (dark theme, proper font). Verify auto-scroll to bottom works. Verify `Enter` sends and `Shift+Enter` inserts newline in composer. | Manual (Browser)      | Unstyled raw HTML, Spectrum theme not applied, light background instead of dark, Enter behavior wrong |

---

### Phase 3: Studio Panel Integration (2 days)

9. **Add "Chat" activity bar tab** — New icon (`sp-icon-chat` or suitable workflow icon) in `activity-bar.js`. Add `chat` to `view.leftTab` allowed values. Create `panels/chat-panel.js`.
   - _depends on steps 5-8_

10. **Build `chat-panel.js`** — Orchestrator following same mount/render/unmount pattern as `left-panel.js` / `right-panel.js`. Mounts messages, composer, tool call components. Registers via `registerRenderer("chat-panel", ...)`.
    - Uses `effect(() => { ... activeTab.value ... })` for reactivity.
    - _depends on step 9_

11. **Wire up in `studio.js`** — Mount chat panel in initialization sequence, alongside existing panel mounts. Pass shared context (navigateToComponent, renderCanvas, etc.) through existing ctx pattern.
    - _depends on step 10_

12. **Panel placement: bottom panel with overlay fallback** — Chat renders as a resizable bottom panel. The main three-column layout stays; chat slides up from below. New CSS grid row in `index.html`. Uses existing `panel-resize.js`.
    - **Overlay fallback for small viewports**: When viewport width is below 900px or the canvas area drops below 320px wide with the chat panel open, the chat panel switches to overlay mode (floating above the canvas, semi-transparent underlay) instead of compressing the canvas. This is a CSS media query + a JS class toggle on `#app`. The overlay position is determined by a `smallViewport` property in `view` tracked via a `ResizeObserver`.
    - Toggle via activity bar click or `Ctrl+L`.
    - _depends on step 10, parallel with step 11_

**🔴 Phase 3 Gate — ALL must pass before Phase 4 starts:**

| #    | Test                                                                                                                                                                                                                                                                                                                    | Type                | What FAILURE looks like                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| G3.1 | Open Studio in browser (`bun run dev`), verify Chat tab icon appears in activity bar. Click it — verify the chat panel renders at the bottom with messages area and composer visible.                                                                                                                                   | Manual (Browser)    | Tab icon missing, clicking does nothing, panel renders blank, wrong panel shows |
| G3.2 | With chat panel open, verify canvas is still visible and interactive (can select elements, can see render). Verify inspector (right panel) is still functional.                                                                                                                                                         | Manual (Browser)    | Canvas hidden, inspector broken, elements not selectable                        |
| G3.3 | Resize browser to 800px wide, open chat panel — verify chat renders as overlay (floating above canvas, semi-transparent backdrop) not compressing the canvas. Close chat — verify overlay is removed.                                                                                                                   | Manual (Browser)    | Canvas compressed to unusable width, no overlay mode, backdrop missing          |
| G3.4 | `Ctrl+L` toggles chat panel open/close. Verify focus moves to composer input on open, returns to canvas on close.                                                                                                                                                                                                       | Manual (Browser)    | Shortcut doesn't toggle, focus lost, double-press opens then immediately closes |
| G3.5 | **Visual (Chrome MCP)**: Navigate to Studio, open chat panel, take screenshot. Verify: (a) dark theme matches rest of Studio, (b) chat panel uses Spectrum components (not raw HTML), (c) the three-column layout (layers/canvas/inspector) is still visible above the chat panel, (d) no horizontal scrollbar appears. | Manual (Chrome MCP) | Light theme mismatch, raw unstyled elements, layout broken, scrollbar visible   |

---

### Phase 4: Tool System for Jx Document Manipulation (3 days)

13. **Create tool registry infrastructure** — `packages/ai/src/tools.js` (in `@jxsuite/ai`). Base classes: `ToolDefinition` (name, description, JSON Schema parameters, execute fn), `ToolRegistry` (register, list, validate args).
    - Tool input validation uses JSON Schema validation against the declared parameters schema.
    - Tools return `ToolResult` objects: `{ success: boolean, data?: any, error?: string }`.
    - _depends on step 2_

14. **Create JX-specific tools** — `packages/studio/src/services/ai-tools.js`. Implements tools using the ToolRegistry from `@jxsuite/ai`.

    Core tools (v1):
    | Tool | Action | Destructive? |
    |------|--------|:---:|
    | `readDocument` | Return current Jx document as JSON (with optional `path` filter for subtree) | No |
    | `updateProperty` | Set element property at path (e.g., `tagName`, `className`, `hidden`) | Yes |
    | `updateStyle` | Set CSS style property on element at path | Yes |
    | `addElement` | Insert new child element at path | Yes |
    | `removeElement` | Remove element at path | Yes |
    | `moveElement` | Reorder/reparent element | Yes |
    | `addState` | Add state entry (signal, computed, function) | Yes |
    | `updateState` | Modify existing state entry | Yes |
    | `setTextContent` | Set textContent on element at path | Yes |
    | `listComponents` | List available components in project | No |
    | `createComponent` | Create new `.json` component file in project | Yes |
    | `createPage` | Create new page file | Yes |
    | `getProjectStructure` | Return project file tree | No |

    **Invalid JX guard**: Every mutation tool validates its input against Jx schema constraints before execution (e.g., `addElement` rejects void elements as parents, `updateProperty` rejects unknown property names for the element type, state entries must match the state shape decision tree). Validation errors return `{ success: false, error: "..." }` and the LLM sees the error message — it can self-correct and retry. Invalid tool calls never reach `transactDoc()`.

    All successful mutations go through `transactDoc()` for undo history.
    - _depends on step 13_

15. **Tool execution pipeline** — `packages/studio/src/services/tool-executor.js`.
    - Loop: send message → receive response → if `tool_calls` present: execute all → send tool results → receive final response.
    - Up to 5 tool call rounds per user message (safety valve).
    - **Batched execution**: All tool calls from a single LLM response execute together before results are sent back. This enables the batched diff preview in step 16.
    - Invalid tool calls (failed validation) are reported as errors in the tool results; the LLM can self-correct.
    - `AbortController` forwarded through the pipeline for stream cancellation.
    - _depends on step 14_

16. **Diff preview: batched canvas diff** — Before tool results from a single LLM response are committed, show the **net effect as a single diff on the rendered canvas**, not individual property changes.
    - Take a snapshot of the document before executing the tool batch.
    - Execute all tool calls (they go through `transactDoc()` with `skipHistory: true` to avoid checkpointing each individual call).
    - Render the canvas with the new document.
    - Show a side-by-side or overlay diff on the canvas (existing `canvas-diff.js` may be reusable).
    - User sees one "Accept" / "Reject" decision for the entire batch — with an "Expand" option to inspect individual tool call effects if needed.
    - Accept → push a single combined undo history snapshot.
    - Reject → restore the pre-batch snapshot, undo all tool calls.
    - This prevents cognitive overload from 5 separate diffs for one user message.
    - _depends on step 15_

**🔴 Phase 4 Gate — ALL must pass before Phase 5 starts:**

| #    | Test                                                                                                                                                                                                                                                                                                                    | Type                | What FAILURE looks like                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| G4.1 | Unit test: register all 13 tools in ToolRegistry, verify `registry.list()` returns all 13 with correct names and parameter schemas                                                                                                                                                                                      | Automated           | Missing tools, wrong names, schemas don't match JSON Schema format                           |
| G4.2 | Unit test: call `addElement` on a `children` path of an `hr` (void element) — verify returns `{ success: false, error: "..." }` and the document is unchanged                                                                                                                                                           | Automated           | Tool succeeds (void element gets a child — this is a bug), no error returned, or crash       |
| G4.3 | Unit test: call `updateProperty` with path `["children",0,"nonexistent"]` — verify returns error, document unchanged                                                                                                                                                                                                    | Automated           | Tool succeeds on invalid path, returns success for unknown property, crash                   |
| G4.4 | Unit test: call `updateStyle` with a valid CSS property and value, verify document is mutated and undo restores original. Repeat for `addElement`, `removeElement`, `moveElement`, `addState`, `updateState`.                                                                                                           | Automated           | Mutation not applied, undo doesn't restore, extra checkpoint in history                      |
| G4.5 | Unit test: tool executor pipeline — mock a streaming response with 3 sequential tool calls (`addElement` → `updateStyle` → `setTextContent`), verify all 3 execute, verify doc snapshot is taken before batch, verify `skipHistory: true` used during batch, verify single combined history entry on accept             | Automated           | Tools execute in wrong order, snapshot timing wrong, multiple history entries instead of one |
| G4.6 | Unit test: diff preview — create a doc, run 3 tool calls in batch, verify the diff preview shows the net change (1 element added, 1 style changed, 1 text changed). Verify Accept pushes combined history entry. Verify Reject restores original document exactly.                                                      | Automated           | Diff shows wrong changes, Accept doesn't combine history, Reject leaves document mutated     |
| G4.7 | **Visual (Chrome MCP)**: Open a component in Studio, open chat, send "Add a red header that says Welcome". Verify the batched diff preview appears on canvas showing before/after. Click Accept — verify canvas updates with the new element. Click Undo — verify element is removed and document is exactly as before. | Manual (Chrome MCP) | No diff preview shown, changes applied without confirmation, undo doesn't fully restore      |

### Phase 5: Context Management & Token Strategy (2 days)

17. **Selective subtree context** — The `readDocument` tool and the system prompt context do NOT include the full Jx document JSON on every message. Instead:
    - The system prompt includes a **structural summary**: element tree outline (tag names + `$id` values + depth, no property values), state keys with their types, and project structure summary.
    - When the LLM needs detailed content, it calls `readDocument` with an optional `path` parameter to fetch a specific subtree.
    - The last `readDocument` result for each unique path is cached in the message history; subsequent messages reuse cached results unless the document changed.
    - This keeps token usage proportional to conversation complexity, not document size.
    - _depends on step 14_

18. **Context window management** — `packages/studio/src/services/context-manager.js`.
    - Track approximate token count of all messages + system prompt.
    - When approaching context limit (80% of model max), trim oldest user/assistant message pairs, preserving the system prompt and last 4 message turns minimum.
    - Insert a system-level summary message ("Earlier context: you were building a contact form with validation...") synthesized from trimmed messages.
    - If a single message + system prompt exceeds 50% of the context window, emit a warning in the chat UI.
    - _parallel with step 17_

19. **Conversation persistence** — Persist chat history (last 50 messages) to `localStorage` keyed by project root path. On project open, restore if available. Add "Clear conversation" button to chat panel. Explicit decision (stated in spec): localStorage only, no server-side persistence in v1.
    - _parallel with step 17_

**🔴 Phase 5 Gate — ALL must pass before Phase 6 starts:**

| #    | Test                                                                                                                                                                                                                                                                | Type      | What FAILURE looks like                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| G5.1 | Unit test: build system prompt for a project with a counter component. Verify structural summary includes element tree outline (tag names + depth), does NOT include full property values, and includes state key list with types.                                  | Automated | Full JSON dump in prompt (token waste), missing state keys, flat outline without depth     |
| G5.2 | Unit test: context manager — add 50 messages to conversation, verify oldest messages are trimmed when token count exceeds 80% of model limit. Verify system prompt and last 4 turns are preserved. Verify a summary message is inserted.                            | Automated | System prompt trimmed, last turns lost, no summary, messages trimmed too early or too late |
| G5.3 | Unit test: context manager — verify warning flag is set when a single message + system prompt exceeds 50% of context window                                                                                                                                         | Automated | No warning, warning fires at wrong threshold                                               |
| G5.4 | Unit test: conversation persistence — send 5 messages, call persist, reload (simulate by clearing state then calling restore), verify all 5 messages restored with correct roles and content                                                                        | Automated | Messages lost, wrong order, roles swapped, content truncated                               |
| G5.5 | Unit test: `readDocument` with selective path — call with path `["children",1]`, verify only that subtree is returned, not the full document. Call without path, verify full document returned (but this path is for explicit LLM requests, not automatic context). | Automated | Path ignored (always returns full doc), returns wrong subtree, crashes on valid path       |

---

### Phase 6: UX Polish & Error Handling (2 days)

20. **Loading & error states** — Spectrum-styled:
    - `sp-progress-circle` (size `s`) inline in the message area during streaming.
    - `sp-toast` (variant `negative`) for API errors, rate limits, network failures.
    - Inline error messages for individual tool call failures (red badge in tool call display).
    - Missing API key: show a settings prompt inline in the composer area ("Configure API key in Settings → AI").
    - Context overflow: warning badge in composer header.
    - _depends on phases 3-5_

21. **Keyboard shortcuts** — `Ctrl+L` toggle chat panel, `Escape` close (blur), `Ctrl+Enter` send. Register in `shortcuts.js`.
    - _parallel with step 20_

22. **Empty state & onboarding** — First open: show 3-4 suggested prompts relevant to current context (e.g., "Add a responsive navigation bar", "Create a contact form with validation", "Style this section with a gradient background", "Add dark mode support").
    - _parallel with step 20_

23. **Settings integration** — `packages/studio/src/settings/ai-settings.js`. API key input (`sp-textfield`, `type="password"` with show/hide toggle), model selection (`sp-picker`), base URL override, temperature slider. Persist in `localStorage`. API key never sent to server except via the SSE endpoint (server reads from request, not server-side config — Studio sends it per-request so the key can be local-only). If the server has `OPENAI_API_KEY` env set, that is the fallback; Studio-sent key takes precedence.
    - _parallel with step 20_

**🔴 Phase 6 Gate — ALL must pass before Phase 7 starts:**

| #    | Test                                                                                                                                                                                                                                           | Type                  | What FAILURE looks like                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| G6.1 | Unit test: render chat panel with no API key configured, verify composer shows inline prompt "Configure API key in Settings → AI" with a clickable link to settings                                                                            | Automated (Happy DOM) | Blank composer, no prompt, clicking does nothing                                             |
| G6.2 | Unit test: simulate API error (mock SSE returning error event), verify `sp-toast` appears with error message, verify composer re-enables after error                                                                                           | Automated (Happy DOM) | Toast doesn't appear, wrong error message, composer stays disabled permanently               |
| G6.3 | Unit test: simulate invalid tool call (tool returns `{success: false, error: "Void element hr cannot have children"}`), verify inline error badge appears on the tool call display with the error message visible                              | Automated (Happy DOM) | Error swallowed, badge missing, error message not shown to user                              |
| G6.4 | Unit test: context overflow warning — set token count > 50% threshold, verify warning badge appears in composer header. Clear conversation, verify badge disappears.                                                                           | Automated (Happy DOM) | No badge, badge persists after clear, badge at wrong threshold                               |
| G6.5 | Unit test: `Escape` key closes chat panel (blurs composer, returns focus to canvas). `Ctrl+Enter` triggers send when composer is focused.                                                                                                      | Automated (Happy DOM) | Escape doesn't close, Ctrl+Enter sends wrong event, focus lost                               |
| G6.6 | Unit test: empty state — first open of chat panel (no messages in history), verify 3-4 suggested prompt chips appear. Click a suggestion chip, verify it populates the composer.                                                               | Automated (Happy DOM) | No suggestions shown, wrong suggestions for context, clicking doesn't populate composer      |
| G6.7 | **Visual (Chrome MCP)**: Configure settings dialog — open settings, enter API key, select model, set temperature. Close settings, reopen — verify values persisted. Verify API key field masks input by default with show/hide toggle working. | Manual (Chrome MCP)   | Settings lost on close, API key visible in plaintext, toggle broken                          |
| G6.8 | **Visual (Chrome MCP)**: Test error recovery flow: configure an intentionally bad API key, send a message, verify error toast appears. Correct the key in settings, retry — verify message sends successfully and streaming response renders.  | Manual (Chrome MCP)   | Error not displayed, retry doesn't work after key fix, streaming broken after error recovery |

---

### Phase 7: Final Integration & Acceptance Testing (4 days)

24. **Unit tests for `@jxsuite/ai`** — Test streaming client abstraction, tool registry, tool validation. Bun test.
    - _depends on phases 0-1_

25. **Unit tests for chat state** — Message management, streaming parsing, tool call state machine, context trimming, conversation persistence. Happy DOM.
    - _depends on phases 2, 4_

26. **Unit tests for JX tools** — Each tool's execute function with mock document state. Verify undo/redo integration. **Test invalid input rejection**: call each tool with malformed paths, invalid property names, void element children, wrong state shapes — verify each returns a clear error, not a crash.
    - _depends on phase 4_

27. **Integration tests for server endpoint** — Test SSE endpoint with mock OpenAI server (or recorded responses). Test error propagation, abort handling, tool call delta streaming.
    - _depends on phase 1_

28. **UI smoke tests (Chrome MCP)** — Per `agents.md` guidelines:
    - Chat panel opens/closes via activity bar and `Ctrl+L`
    - Configure API key, send message, verify streaming response renders
    - Send "Add a blue button that says Subscribe" — verify tool calls display, batched diff preview shows, accept → button appears on canvas, undo restores original
    - **Invalid output test**: Send a prompt designed to produce an edge case (e.g., "Add a child to the hr element") — verify error is displayed inline, no crash, no bad state
    - Test small viewport overlay mode (resize browser < 900px, open chat panel — verify overlay, not compression)
    - Test stream cancellation (send message, click Stop mid-stream, verify composer re-enables)
    - _depends on phases 3-6_

29. **Finalize `specs/ai-assistant.md`** — Update with implementation decisions, API reference, and architectural notes.
    - _depends on all phases_

**🔴 FINAL ACCEPTANCE GATE — ALL must pass before declaring v1 complete:**

| #    | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Type                | What FAILURE looks like                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| GA.1 | **Full automated suite**: `bun test` passes across ALL packages (ai, studio, server) with zero failures                                                                                                                                                                                                                                                                                                                                                                          | Automated           | Any test failure, skipped test without documented reason                                                |
| GA.2 | **Lint + typecheck**: `bun run lint && bun run typecheck` pass with zero errors                                                                                                                                                                                                                                                                                                                                                                                                  | Automated           | Warning or error from oxlint or tsgo                                                                    |
| GA.3 | **Build**: `bun run build` succeeds for all packages (ai, runtime, studio, server)                                                                                                                                                                                                                                                                                                                                                                                               | Automated           | Build failure, missing exports, tree-shaken Spectrum components                                         |
| GA.4 | **End-to-end Chrome MCP**: Start dev server, open Studio, open a project with a real component. Configure real API key. Send 5 real prompts in sequence: (1) "Add a navigation bar", (2) "Style it with a dark background", (3) "Add three nav links: Home, About, Contact", (4) "Make it responsive — hamburger menu on mobile", (5) "Create an About page that uses this nav bar". Verify ALL 5 prompts produce correct, applied changes. Verify undo works after each change. | Manual (Chrome MCP) | Any prompt produces wrong result, LLM hallucinates non-existent tools, changes don't apply, undo broken |
| GA.5 | **Error resilience**: With a real API key, send "Add a child to `<hr/>` element" — verify LLM receives error from the tool, self-corrects in the same response, and the follow-up tool call succeeds (e.g., adds the element to a valid parent instead).                                                                                                                                                                                                                         | Manual (Chrome MCP) | LLM ignores error, error crashes Studio, tool call loop exceeds 5 rounds without resolution             |
| GA.6 | **Persistence**: Send 3 messages, close browser tab, reopen Studio to same project — verify conversation is restored with all 3 messages visible. Send a 4th message — verify it continues the conversation, not starting fresh.                                                                                                                                                                                                                                                 | Manual (Chrome MCP) | Messages lost, wrong conversation loaded, 4th message treated as new conversation                       |
| GA.7 | **Performance**: Open a component with 50+ elements (or create one via chat). Send "Change all text to red" — verify the diff preview renders within 3 seconds, Accept applies within 2 seconds, undo restores within 2 seconds.                                                                                                                                                                                                                                                 | Manual (Chrome MCP) | Operation takes >10 seconds, browser freezes, canvas flashes blank during update                        |
| GA.8 | **Visual review**: Take screenshot of the full Studio UI with chat panel open after GA.4. Verify: (a) all Spectrum components render correctly in dark theme, (b) chat messages are readable with proper spacing, (c) tool call displays are expandable/collapsible, (d) diff preview is visually clear (before/after distinction obvious), (e) no layout regressions in the existing Studio panels.                                                                             | Manual (Chrome MCP) | Visual bugs, layout broken, spectrum components unstyled, diff preview confusing                        |

---

### Relevant Files (to create or modify)

**New files:**

- `packages/ai/package.json` — New package
- `packages/ai/src/streaming-client.js` — `StreamingClient` interface + `OpenAIStreamingClient` + `AnthropicStreamingClient` (stub)
- `packages/ai/src/chat-state.js` — Provider-agnostic reactive chat state base
- `packages/ai/src/tools.js` — `ToolDefinition`, `ToolRegistry`, `ToolResult` base classes
- `packages/server/src/ai-api.js` — AI proxy SSE endpoints
- `packages/studio/src/panels/chat-panel.js` — Chat panel orchestrator
- `packages/studio/src/panels/chat-messages.js` — Message list template
- `packages/studio/src/panels/chat-composer.js` — Input composer template
- `packages/studio/src/panels/chat-tool-call.js` — Tool call display template
- `packages/studio/src/panels/chat-diff-preview.js` — Batched canvas diff preview
- `packages/studio/src/services/chat-state.js` — Studio-specific chat state (extends ai package)
- `packages/studio/src/services/ai-tools.js` — Jx document manipulation tools
- `packages/studio/src/services/tool-executor.js` — Tool execution pipeline
- `packages/studio/src/services/ai-system-prompt.js` — Dynamic system prompt builder
- `packages/studio/src/services/context-manager.js` — Token tracking, trimming, summarization
- `packages/studio/src/settings/ai-settings.js` — AI settings UI
- `specs/ai-assistant.md` — AI assistant specification
- `packages/ai/tests/` — AI package tests
- `packages/studio/tests/chat-panel.test.js` — Chat panel tests
- `packages/studio/tests/ai-tools.test.js` — Tool unit tests
- `packages/server/tests/ai-api.test.js` — Server endpoint tests

**Modified files:**

- `packages/studio/src/studio.js` — Register chat panel, wire up context
- `packages/studio/src/panels/activity-bar.js` — Add "Chat" tab
- `packages/studio/src/panels/left-panel.js` — Add chat panel tab routing
- `packages/studio/src/editor/shortcuts.js` — Chat keyboard shortcuts
- `packages/studio/src/ui/spectrum.js` — Register new Spectrum components if needed
- `packages/studio/index.html` — Chat panel CSS grid row + overlay mode styles + small-viewport media query
- `packages/server/src/server.js` — Register AI API routes
- `packages/studio/src/store.js` — Chat panel DOM ref (if needed)
- `packages/studio/src/view.js` — Chat-related view state
- `specs/studio.md` — Reference new chat panel
- `package.json` (root) — Add `packages/ai` to workspaces

---

### Verification (Manual + Automated)

1. `bun test` passes for all packages
2. `bun run lint` and `bun run typecheck` pass
3. Start dev server, open Studio, click Chat tab, verify panel opens
4. Configure OpenAI API key in settings
5. Send "Add a blue button that says Subscribe" → verify batched diff preview shows, accept → button on canvas, undo restores
6. Send "Make the button rounded with a shadow" → verify style changes in diff preview
7. Send "Create a new contact-form component" → verify new file created, opened in tab
8. **Invalid output test**: Send "Add a child element inside the hr element" → verify error displayed inline, no crash
9. **Small viewport test**: Resize < 900px, open chat → verify overlay mode, canvas not compressed
10. Test stream cancellation (Stop button)
11. Test conversation persistence: send messages, reload Studio, verify history restored
12. Chrome MCP: streaming renders, tool calls display, undo works, errors handled gracefully

---

### Decisions (Updated from Review)

- **Native lit-html + Spectrum, NOT React/assistant-ui**: assistant-ui is a React library. Jx Studio uses lit-html + Spectrum Web Components exclusively. We follow the assistant-ui _architecture_ (composable chat primitives, streaming state, tool-calling UI) but implement natively. Framework boundary complexity would cost more than the time assistant-ui saves.

- **Provider abstraction layer from day one**: A `StreamingClient` interface with `OpenAIStreamingClient` and `AnthropicStreamingClient` implementations designed upfront. OpenAI and Anthropic handle tool calls differently in streaming (delta format, stop reason fields, partial JSON accumulation). Building the abstraction now prevents a significant refactor later.

- **Server-side proxy for API calls**: API key stays on the server (env var) or is sent per-request from Studio (localStorage). Studio never stores the key server-side. This avoids CORS issues and keeps the key configurable per-user.

- **Chat panel at bottom with overlay fallback**: Resizable bottom panel on large viewports; overlay mode (floating above canvas) on small viewports (< 900px or canvas < 320px wide). Prevents canvas compression into unusable sizes.

- **Batched diff preview, not individual diffs**: All tool calls from one LLM response are previewed as a single net effect on the canvas. One Accept/Reject decision. Expand to see individual changes. Prevents cognitive overload from N separate diffs.

- **Selective subtree context, not full document**: The system prompt includes structural summary only. The LLM calls `readDocument(path)` for detailed content. Keeps token usage proportional to conversation complexity, not document size. This is a v1 requirement, not a future consideration.

- **Transaction-based mutations**: All AI tool mutations go through `transactDoc()` for full undo/redo. Users can always undo AI changes. Single combined history snapshot per accepted batch.

- **No autonomous mode**: The LLM can never save files or run code without the user accepting the diff preview. Accept/discard for every change batch.

- **Rate limiting / queuing policy**: Composer is disabled during streaming. No queuing of additional messages while a response is active. User can cancel the current stream via Stop button, then send a new message. This is simple, predictable, and non-ambiguous.

- **Conversation persistence (explicit decision)**: localStorage persistence of last 50 messages, keyed by project root. Cleared on "Clear conversation". No server-side persistence in v1 (but the chat-state module supports swapping in a server-backed store later).

- **`@jxsuite/ai` package boundary (explicit)**: Infrastructure (base classes, state management, streaming client, tool registry) lives in `@jxsuite/ai` and is reusable outside Studio. Studio-specific code (JX tools, system prompt, chat panel UI, settings) lives in `@jxsuite/studio`. This separation enables future AI integrations outside the visual builder.

---

### Scope Boundaries (Explicit)

**In scope for v1:**

- Chat panel with message history, streaming, tool calls
- Jx document manipulation tools (read, write properties, styles, elements, state)
- Project-level tools (create component, create page, list structure)
- Batched diff preview with accept/reject
- Undo/redo integration
- Open AI provider (GPT-4o/GPT-4.1)
- Streaming client abstraction (OpenAI impl + Anthropic stub)
- Conversation persistence (localStorage)
- AI settings (API key, model, base URL)

**Out of scope for v1 (noted for future):**

- Image generation (DALL-E integration)
- Voice input (Web Speech API)
- Server-side conversation persistence
- Multi-modal input (image upload to vision models)
- LangGraph / MCP integration
- Agent-mode (autonomous multi-step tasks without per-step confirmation)
- Fine-tuned Jx-specific model
- Claude / Anthropic provider (stub only, full impl in v2)
- Collaborative AI sessions
