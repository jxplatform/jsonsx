# `@jxsuite/ai` + Studio AI Assistant Specification

## LLM-Powered Chat Builder for Jx Documents

**Version:** 1.0.0-draft
**Status:** In Progress
**License:** MIT

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Chat Panel UX](#3-chat-panel-ux)
4. [Streaming Protocol](#4-streaming-protocol)
5. [Tool System](#5-tool-system)
6. [System Prompt Design](#6-system-prompt-design)
7. [Context Management](#7-context-management)
8. [Diff Preview UX](#8-diff-preview-ux)
9. [Settings & Configuration](#9-settings--configuration)
10. [Error Handling](#10-error-handling)
11. [Package Boundary](#11-package-boundary)
12. [Future Directions](#12-future-directions)

---

## 1. Overview

The Jx AI Assistant adds a chat interface to Jx Studio that enables users to build, modify, and iterate on Jx documents (components, pages, layouts) and site structures using natural language. An LLM (initially OpenAI GPT-4o/GPT-4.1) is given a tool-calling interface to read and manipulate Jx documents. Changes apply optimistically through `transactDoc()` for full undo/redo (see §8 and ADR `docs/ai-assistant-decision.md` §5).

### 1.1 Design Principles

1. **AI is an assistant, not an operator** — The LLM proposes changes; the user accepts or rejects them. No autonomous file saves or destructive operations without explicit user confirmation.
2. **Tool-first, not prompt-first** — The LLM manipulates documents through a typed tool interface, not by generating raw JSON. This gives us validation, undo, and error recovery for free.
3. **Canvas is the diff viewer** — Changes are previewed on the live canvas, not as textual diffs. Users see exactly what the result will look like.
4. **Context is selective** — The full Jx document is never dumped into the prompt. Structural summaries and on-demand `readDocument` calls keep token usage proportional to conversation complexity.
5. **Studio-native UI** — All chat UI uses lit-html templates and Spectrum Web Components. No React, no custom component frameworks.

### 1.2 Relationship to assistant-ui

We follow the [assistant-ui](https://github.com/assistant-ui/assistant-ui) architectural patterns — composable chat primitives, streaming state management, tool-calling UI, generative UI concepts — but implement natively with lit-html + Spectrum. assistant-ui is a React library; Jx Studio prohibits React. The architecture is the transferable asset, not the code.

---

## 2. Architecture

### 2.1 System Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    Jx Studio (Browser)                     │
│  ┌──────────┐  ┌──────────┐  ┌─────────────────────────┐ │
│  │ Chat UI   │  │ Canvas   │  │ Inspector / Layers / etc │ │
│  │ (lit-html │  │ (runtime │  │ (existing panels)       │ │
│  │ +Spectrum)│  │  render) │  │                         │ │
│  └─────┬─────┘  └────┬─────┘  └─────────────────────────┘ │
│        │              │                                    │
│  ┌─────┴──────────────┴──────────────────────────────────┐│
│  │              Studio Services                           ││
│  │  ┌─────────────┐ ┌──────────┐ ┌───────────────────┐  ││
│  │  │ chat-state   │ │ai-tools  │ │ tool-executor     │  ││
│  │  │ (reactive)   │ │(JX ops)  │ │ (pipeline)        │  ││
│  │  └──────┬───────┘ └────┬─────┘ └────────┬──────────┘  ││
│  │         │              │                │              ││
│  │  ┌──────┴──────────────┴────────────────┴──────────┐  ││
│  │  │  @jxsuite/ai (streaming client, tool registry)   │  ││
│  │  └──────────────────────┬──────────────────────────┘  ││
│  └─────────────────────────┼─────────────────────────────┘│
└────────────────────────────┼──────────────────────────────┘
                             │ SSE POST /__studio/ai/chat
                    ┌────────┴─────────┐
                    │  @jxsuite/server  │
                    │  ┌─────────────┐  │
                    │  │  ai-api.js   │  │
                    │  │  (proxy)     │  │
                    │  └──────┬──────┘  │
                    └─────────┼─────────┘
                              │ fetch (SSE)
                    ┌─────────┴─────────┐
                    │   OpenAI API       │
                    │   (GPT-4o)         │
                    └───────────────────┘
```

### 2.2 Data Flow

```
User types message
  → chat-state.sendMessage(text)
    → POST /__studio/ai/chat { messages, tools, systemPrompt, model }
      → Server proxies to OpenAI API (streaming)
        ← SSE events: delta, tool_call_start/delta/end, done, error
    → chat-state updates reactively
      → UI re-renders via effect()
        → Tool calls detected → tool-executor runs batch
          → Each tool validates → executes → transactDoc(skipHistory:true)
            → Canvas re-renders showing changes
              → Diff preview appears (Accept/Reject)
                → Accept → combined history snapshot
                → Reject → restore pre-batch snapshot
```

---

## 3. Chat Panel UX

### 3.1 Panel Placement

The chat panel is a **resizable bottom panel** in the Studio layout:

```
┌────────────────────────────────────────────────────┐
│  Activity Bar  │     Canvas + Toolbar    │ Inspector │
│  (Left)        │     (Center)           │ (Right)   │
│                │                         │           │
├────────────────┴─────────────────────────┴───────────┤
│  Chat Panel (resizable, collapsible)                  │
│  ┌──────────────────────────────────────────────────┐│
│  │ Messages area (scrollable)                        ││
│  │ [User]: Make a blue button                        ││
│  │ [Asst]: I'll add a blue button [✓ 3 changes]      ││
│  │ [Asst]: Done! Check the canvas preview.           ││
│  └──────────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────┬───────────┐│
│  │ Composer (multiline textfield)       │ [Send]    ││
│  └──────────────────────────────────────┴───────────┘│
└──────────────────────────────────────────────────────┘
```

### 3.2 Overlay Fallback

On small viewports (width < 900px or canvas < 320px wide with chat open), the chat panel switches to **overlay mode**:

- Floats above the canvas area with a semi-transparent `sp-underlay` backdrop.
- Dismissed by clicking the backdrop or pressing `Escape`.
- The canvas is not compressed — it stays at full width behind the overlay.
- Tracked via `ResizeObserver` setting `view.chatSmallViewport`.

### 3.3 Panel Behavior

- **Toggle**: Activity bar "Chat" tab or `Ctrl+L` shortcut.
- **Collapse/Expand**: Drag the resize handle between canvas and chat panel. Minimum height: 120px. Maximum: 50% of viewport.
- **State persists across tab switches**: The chat state (`chat-state.js`) is independent of the active document tab. Messages persist when switching between files.
- **Conversation per project**: Chat history is scoped to the project root. Switching projects starts a new conversation (or restores the persisted one for that project).

### 3.4 Activity Bar Integration

The Chat tab appears in the activity bar alongside existing tabs (Files, Layers, Components, Elements, State, Data, Head, Source Control). Icon: `sp-icon-chat` or suitable Spectrum workflow icon.

---

## 4. Streaming Protocol

### 4.1 `StreamingClient` Interface

Defined in `@jxsuite/ai`, this is the provider abstraction:

```js
/**
 * @typedef {'delta' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done' | 'error'} StreamEventType
 *
 * @typedef {{
 *   type: 'delta',
 *   content: string
 * } | {
 *   type: 'tool_call_start',
 *   id: string,
 *   name: string
 * } | {
 *   type: 'tool_call_delta',
 *   id: string,
 *   args: string  // partial JSON fragment
 * } | {
 *   type: 'tool_call_end',
 *   id: string
 * } | {
 *   type: 'done',
 *   stopReason: string
 * } | {
 *   type: 'error',
 *   message: string,
 *   code?: string
 * }} StreamEvent
 */

/**
 * @typedef {{
 *   streamChat(messages, tools, systemPrompt, signal): AsyncGenerator<StreamEvent>
 * }} StreamingClient
 */
```

### 4.2 OpenAI Implementation

`OpenAIStreamingClient` transforms OpenAI's SSE format into `StreamEvent`:

- `choices[0].delta.content` → `{ type: "delta", content }`
- `choices[0].delta.tool_calls[0]` (first appearance) → `{ type: "tool_call_start", id, name }`
- `choices[0].delta.tool_calls[0].function.arguments` (subsequent) → `{ type: "tool_call_delta", id, args }`
- Accumulation of partial JSON for tool arguments happens in the client.
- `choices[0].finish_reason === "tool_calls"` → `{ type: "done", stopReason: "tool_calls" }`
- `choices[0].finish_reason === "stop"` → `{ type: "done", stopReason: "stop" }`
- Non-2xx response or parse error → `{ type: "error", message }`

### 4.3 Anthropic Implementation (Stub)

`AnthropicStreamingClient` is designed in Phase 0 but stubbed for v1. Key differences from OpenAI:

- SSE event format: `event: content_block_delta`, `event: content_block_start`, etc.
- Tool calls use `content_block` model, not delta accumulation.
- Stop reason field: `stop_reason` (not `finish_reason`).
- Tool arguments are streamed as complete JSON objects per content block, not partial deltas.

### 4.4 Server Endpoint

`POST /__studio/ai/chat`

**Request:**

```json
{
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "...", "tool_calls": [...] },
    { "role": "tool", "tool_call_id": "...", "content": "..." }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "addElement",
        "description": "Insert a new child element at a given path.",
        "parameters": { "type": "object", "properties": { ... }, "required": [...] }
      }
    }
  ],
  "systemPrompt": "You are an expert Jx builder...",
  "model": "gpt-4o"
}
```

**Response:** `text/event-stream` with `data: {"type":"...", ...}\n\n` events.

The server is a thin proxy: validates the request shape, forwards to OpenAI, transforms the SSE stream, and pipes it back. API key from `OPENAI_API_KEY` env var or per-request `Authorization` header.

**Abort:** The request `AbortSignal` is forwarded to the upstream `fetch()`. When the client disconnects (user clicks Stop or closes panel), the upstream request is cancelled and resources are freed.

### 4.5 `/__studio/ai/models` Endpoint

`GET /__studio/ai/models`

Returns available models for the picker:

```json
{
  "models": [
    { "id": "gpt-4o", "name": "GPT-4o", "contextWindow": 128000 },
    { "id": "gpt-4.1", "name": "GPT-4.1", "contextWindow": 1000000 }
  ],
  "configured": true
}
```

---

## 5. Tool System

### 5.1 Tool Registry (`@jxsuite/ai`)

```js
class ToolDefinition {
  /** @type {string} */ name;
  /** @type {string} */ description;
  /** @type {object} */ parameters; // JSON Schema
  /** @type {(args: object) => Promise<ToolResult>} */ execute;
}

class ToolRegistry {
  register(tool: ToolDefinition): void;
  list(): ToolDefinition[];
  listForLLM(): object[]; // OpenAI function-calling format
  validate(toolName: string, args: object): { valid: boolean; errors?: string[] };
  execute(toolName: string, args: object): Promise<ToolResult>;
}

/** @typedef {{ success: boolean; data?: any; error?: string; summary?: string }} ToolResult */
```

### 5.2 JX-Specific Tools (`@jxsuite/studio`)

All tools operate on `activeTab.value.doc.document`. Tools access the active tab context through a shared registry context set during panel mount.

| Tool                  | Parameters                                 | Returns                  | Validation                                                      |
| --------------------- | ------------------------------------------ | ------------------------ | --------------------------------------------------------------- |
| `readDocument`        | `path?` (JSON path array)                  | Subtree or full document | Path must exist if specified                                    |
| `updateProperty`      | `path`, `key`, `value`                     | `{ summary }`            | path exists, key is valid for element type                      |
| `updateStyle`         | `path`, `prop`, `value`                    | `{ summary }`            | path exists, prop is valid CSS property                         |
| `addElement`          | `parentPath`, `element` (JxNode), `index?` | `{ path, summary }`      | parentPath exists, parent not void element, element shape valid |
| `removeElement`       | `path`                                     | `{ summary }`            | path exists, not root                                           |
| `moveElement`         | `fromPath`, `toParentPath`, `toIndex?`     | `{ summary }`            | fromPath exists, toParentPath exists and is not void            |
| `addState`            | `key`, `definition`                        | `{ summary }`            | key not already in state, definition matches state shape rules  |
| `updateState`         | `key`, `definition`                        | `{ summary }`            | key exists in state                                             |
| `setTextContent`      | `path`, `text`                             | `{ summary }`            | path exists                                                     |
| `listComponents`      | —                                          | `{ components }`         | —                                                               |
| `createComponent`     | `name`, `path?`                            | `{ path }`               | name valid (PascalCase), no existing file at path               |
| `createPage`          | `name`, `route`, `path?`                   | `{ path }`               | name valid, route valid URL path                                |
| `getProjectStructure` | —                                          | `{ tree }`               | —                                                               |

### 5.3 Invalid Input Guards

Every mutation tool validates inputs before touching the document:

- **Path validation**: Path must exist in the document tree (`getNodeAtPath()` returns non-null).
- **Void element guard**: `addElement` and `moveElement` reject void elements (`hr`, `br`, `img`, `input`, etc.) as parents. Error message: `"Void element <{tag}> cannot have children. Insert the element adjacent to it instead."`
- **Property validation**: `updateProperty` rejects keys that don't exist on the target element type (e.g., `src` on a `div` is invalid). Error message: `"<{tag}> does not support property '{key}'."`
- **State shape validation**: `addState` and `updateState` validate that the state definition matches the Jx state shape decision tree. Error message: `"Invalid state definition: {reason}."`
- **Type coercion warnings**: If `updateProperty` receives a string for a boolean property, it coerces and includes a warning: `"Coerced '{key}' from string to boolean."`

Failed validations return `ToolResult { success: false, error: "..." }`. The LLM receives the error message and can self-correct in the next tool call round.

### 5.4 Tool Execution Pipeline

```
1. User sends message
2. LLM responds (may include tool_calls)
3. If no tool_calls → display response, done
4. If tool_calls present:
   a. Snapshot document (JSON.stringify deep copy)
   b. Execute ALL tool_calls from this response as a batch
      - Each call: validate → execute → transactDoc(skipHistory:true)
      - Failed calls return error results (continue executing others)
   c. Send tool results back to LLM
   d. LLM may respond with more tool_calls or a text response
   e. Repeat up to 5 rounds max
5. When LLM finishes (no more tool_calls):
   a. Show batched diff preview on canvas
   b. User clicks Accept → push single combined undo snapshot
   c. User clicks Reject → restore pre-batch snapshot
```

---

## 6. System Prompt Design

The system prompt is constructed dynamically in `ai-system-prompt.js`. It is the single most important quality driver for the AI assistant.

### 6.1 Prompt Sections

1. **Role & Capabilities** — "You are an expert Jx builder assistant embedded in Jx Studio. You help users build websites, components, pages, and layouts using the Jx JSON schema. The live jxsuite.com marketing site is built entirely with Jx — component patterns below come from that production codebase at `sites/jxsuite.com/`."

2. **Jx Schema Reference** (condensed) — Structural patterns, `state` shape decision tree, `$ref` syntax, `$map`, `$switch`, `children` nesting rules, void elements list.

3. **Real-World Component Patterns** (from `sites/jxsuite.com/`) — Canonical patterns the LLM should emulate:

   _Simple component with props_ (`components/cta-button.json`):

   ```json
   {
     "tagName": "cta-button",
     "state": {
       "href": "/",
       "label": "Click",
       "variant": "primary",
       "isPrimary": "${state.variant === 'primary'}"
     },
     "children": [
       {
         "tagName": "a",
         "attributes": { "href": "${state.href}" },
         "style": {
           "backgroundColor": "${state.isPrimary ? 'var(--color-accent)' : 'transparent'}",
           "color": "${state.isPrimary ? 'white' : 'var(--color-text-secondary)'}"
         },
         "textContent": "${state.label}"
       }
     ]
   }
   ```

   Pattern: typed props, computed values (`isPrimary`), template expressions in styles, `$ref`-style attribute binding.

   _Card with configurable props_ (`components/feature-card.json`):

   ```json
   {
     "tagName": "feature-card",
     "state": { "icon": "", "iconBg": "rgba(59,130,246,0.1)", "title": "", "description": "" },
     "children": [
       {
         "tagName": "div",
         "textContent": "${state.icon}",
         "style": { "backgroundColor": "${state.iconBg}" }
       },
       { "tagName": "h3", "textContent": "${state.title}" },
       { "tagName": "p", "textContent": "${state.description}" }
     ]
   }
   ```

   Pattern: multi-prop cards with styled icon containers — common UI pattern.

   _Layout with slots_ (`layouts/base.json`):

   ```json
   {
     "tagName": "div",
     "$elements": [
       { "$ref": "../components/site-toolbar.json" },
       { "$ref": "../components/site-footer.json" }
     ],
     "children": [
       { "tagName": "site-toolbar" },
       { "tagName": "main", "children": [{ "tagName": "slot" }] },
       { "tagName": "site-footer" }
     ]
   }
   ```

   Pattern: `$elements` for component imports, `<slot>` for page content, toolbar->main->footer layout.

   _Site config_ (`project.json`):

   ```json
   {
     "name": "Jx Suite",
     "url": "https://jxsuite.com",
     "defaults": { "layout": "./layouts/base.json", "lang": "en" },
     "$media": {
       "--": "1280px",
       "--lg": "(max-width:1024px)",
       "--md": "(max-width:768px)",
       "--sm": "(max-width:640px)"
     },
     "style": {
       "--color-bg-primary": "#0a0a0a",
       "--color-accent": "#3b82f6",
       "--font-mono": "'JetBrains Mono', 'SF Mono', Consolas, monospace",
       "--radius": "8px",
       "--max-width": "1200px"
     },
     "$head": [
       { "tagName": "link", "attributes": { "rel": "icon", "href": "/favicon.svg" } },
       {
         "tagName": "meta",
         "attributes": { "name": "viewport", "content": "width=device-width, initial-scale=1" }
       }
     ]
   }
   ```

   Pattern: `$media` breakpoints, CSS custom properties (`--color-*`, `--font-*`, `--radius`), `$head` entries for meta/link tags, `defaults.layout`.

4. **State Shape Decision Tree** — When to use:
   - **Scalar signal**: `"count": 0` — simple reactive value
   - **Typed signal**: `"name": { "type": "string", "default": "" }` — typed with default
   - **Computed**: `"label": "${state.count} items"` — template expression
   - **Function**: `"handle": { "$prototype": "Function", "body": "..." }` — event handler
   - **Data source**: `"posts": { "$prototype": "Data", "$src": "..." }` — external data
5. **Component Hierarchy** — What elements can nest in what, void elements, semantic rules.
6. **Style System** — CSS property naming (camelCase in JSON), `$media` breakpoints, responsive patterns, note that CSS values are strings.
7. **Document Structure** — `$id`, `$schema`, `tagName`, `children`, `state`, `style`.
8. **Project Context** — Pages, layouts, components, content collections (injected dynamically).
9. **Tool Usage Guidelines** — How and when to use each tool, prefer `updateStyle` over rewriting elements, batch related changes.
10. **Error Recovery** — What to do when a tool call fails: read the error message, correct the arguments, retry.
11. **Few-Shot Examples** — 3-4 clean examples from `examples/components/` (counter, todo, contact-form) showing common patterns.

### 6.2 Structural Summary (Not Full Document)

The system prompt includes a **structural summary** of the current document, NOT the full JSON. This is the key token optimization:

```
Current document: Counter ($id: "Counter")
Element tree:
  my-counter (root, style: block, max-width:300px)
  ├── h1 (textContent: $ref→state/label)
  ├── p (textContent: template→${state.count})
  └── div (style: flex, gap:0.5rem)
      ├── button (textContent: "−", onclick: $ref→state/decrement)
      ├── button (textContent: "+", onclick: $ref→state/increment)
      └── button (textContent: "Reset", onclick: $ref→state/reset)
State keys: count (integer, default:0), label (Function), increment (Function), decrement (Function), reset (Function)
```

When the LLM needs detail on a specific subtree (e.g., to modify a deeply nested element), it calls `readDocument(path)`.

---

## 7. Context Management

### 7.1 Token Tracking

Approximate token count using heuristic: `tokenCount ≈ charCount / 4` (reasonable for English text). Tracked per-message and summed.

### 7.2 Trimming Strategy

When total tokens exceed 80% of the model's context window:

1. Preserve the system prompt (always).
2. Preserve the last 4 user/assistant message turns (minimum).
3. Trim the oldest user/assistant pairs from the middle.
4. Insert a synthesized summary message: `"Earlier in this conversation: {summary}. This context has been summarized to save space."`
5. If a single message + system prompt exceeds 50% of the context window, emit a warning in the UI: "⚠️ Document is very large. Consider editing a specific section."

### 7.3 Conversation Persistence

- **Storage**: `localStorage`, keyed by `jx-ai-chat-${projectRootPath}`.
- **Limit**: Last 50 messages (user and assistant roles only; tool messages reconstructed from tool_calls on restore).
- **Restore**: On project open, if cached conversation exists, restore it. Messages display with a "Restored from previous session" indicator.
- **Clear**: "Clear conversation" button in chat panel header. Confirms via `sp-dialog-wrapper`.
- **Not persisted**: Streaming state, pending tool calls, un-accepted diffs. On reload, these are lost.

---

## 8. Apply UX — Optimistic Apply + Undo/Redo

> **Superseded.** The original batched Accept/Reject diff preview (§8.1 below, retained for context)
> was rejected for the MVP in favour of optimistic apply. See ADR `docs/ai-assistant-decision.md` §5.

### 8.1 Optimistic apply (MVP)

Each tool call applies to the live canvas **immediately** through `transactDoc()`. There is no
Accept/Reject gate:

1. Every mutation tool (`set_property`, `add_child`, `remove_node`) is one `transactDoc()`
   transaction, so each AI edit is a discrete, reversible step in the **same** history stack as
   manual edits.
2. The canvas updates as the agent loop runs, so the model (and the user) see the applied result
   on the next round.
3. To undo an AI change the user uses native **Ctrl+Z / Ctrl+Y** (plus an in-chat Undo button) —
   no special AI-only revert path.
4. After each mutation the document is schema-validated (`@jxsuite/schema`, via
   `services/jx-validate.js`); newly introduced errors are returned to the model as a failed tool
   result so the loop self-corrects (ADR §6b).

This removes the batched-diff state-synchronization machinery (no before/after panes, no
pre-batch snapshot, no `chat-diff-preview.js`). A richer visual diff may return post-MVP.

### 8.2 Batched Canvas Diff (original design — superseded, kept for reference)

When the LLM completes a response that includes tool calls, the changes are previewed as a **single visual diff** on the canvas:

1. The canvas shows the "before" state (current document).
2. An overlay or side-by-side view shows the "after" state (document with tool changes applied).
3. A floating action bar appears: **[✓ Accept] [✗ Reject] [▼ Expand]**
4. **Expand** reveals individual tool call effects in an accordion.
5. **Accept** pushes a single combined undo history snapshot. Canvas updates to the "after" state permanently.
6. **Reject** restores the pre-batch snapshot. Canvas returns to the "before" state.

---

## 9. Settings & Configuration

### 9.1 AI Settings Panel

Located in Studio Settings (accessible from the existing settings infrastructure):

| Field       | Control                                          | Default    | Description                                               |
| ----------- | ------------------------------------------------ | ---------- | --------------------------------------------------------- |
| API Key     | `sp-textfield` (type=password, show/hide toggle) | `""`       | OpenAI API key. Stored in localStorage. Sent per-request. |
| Model       | `sp-picker`                                      | `"gpt-4o"` | Model to use. Options loaded from `/__studio/ai/models`.  |
| Base URL    | `sp-textfield`                                   | `""`       | Override for custom/proxied OpenAI-compatible endpoints.  |
| Temperature | `sp-slider` (0–2, step 0.1)                      | `0.7`      | Creativity vs determinism.                                |

### 9.2 API Key Flow

1. User enters key in settings → persisted to `localStorage`.
2. On each chat request, the key is sent as an `Authorization: Bearer {key}` header (or `X-Api-Key` header — exact mechanism TBD).
3. Server checks: if request has a key → use it. Otherwise → fall back to `OPENAI_API_KEY` env var.
4. If neither is available → server returns 401; Studio shows "Configure API key in Settings → AI" prompt in the composer.

---

## 10. Error Handling

### 10.1 Error Categories

| Error              | Detection                   | User Experience                                                                  |
| ------------------ | --------------------------- | -------------------------------------------------------------------------------- |
| Missing API key    | 401 from server             | Inline prompt in composer: "Configure API key in Settings → AI"                  |
| Invalid API key    | 401 from OpenAI             | `sp-toast` (negative): "API key is invalid. Check Settings → AI."                |
| Rate limit         | 429 from OpenAI             | `sp-toast`: "Rate limited. Retrying in {N} seconds..." + auto-retry with backoff |
| Network error      | fetch() rejection           | `sp-toast`: "Network error. Check your connection." + Retry button               |
| Invalid tool call  | Tool validation fails       | Inline error badge on tool call: "✗ Void element `<hr>` cannot have children"    |
| Context overflow   | Token count > 50% threshold | Warning badge in composer header: "⚠️ Large document"                            |
| Server error       | 5xx response                | `sp-toast`: "Server error. Please try again."                                    |
| Stream parse error | Malformed SSE data          | `sp-toast`: "Stream interrupted. Retry?"                                         |

### 10.2 LLM Self-Correction

When a tool call returns an error, the result is sent back to the LLM as a `tool` role message with the error text. The LLM can:

1. Read the error message.
2. Correct the tool arguments.
3. Re-issue the tool call with corrected parameters.

This happens within the same message round (up to 5 rounds). If the LLM fails to correct after 5 rounds, the pipeline stops and the user sees: "I wasn't able to complete this change. Here's what went wrong: {error}. You can try rephrasing your request."

---

## 11. Package Boundary

### 11.1 `@jxsuite/ai` (Infrastructure)

Reusable, provider-agnostic, no Studio or Jx dependencies:

- `streaming-client.js` — `StreamingClient` interface + `StreamEvent` types + `OpenAIStreamingClient` + `AnthropicStreamingClient` (stub)
- `tools.js` — `ToolDefinition`, `ToolRegistry`, `ToolResult` base classes
- `chat-state.js` — Reactive chat state management (messages, streaming, tool calls, errors)

**Dependencies:** `@vue/reactivity` only.

### 11.2 `@jxsuite/studio/services/` (JX-Specific)

Depends on `@jxsuite/ai`:

- `chat-state.js` — Studio-specific extensions (project scoping, persistence)
- `ai-tools.js` — JX document manipulation tools (registered in ToolRegistry)
- `tool-executor.js` — Tool execution pipeline (batch, snapshot, diff preview orchestration)
- `ai-system-prompt.js` — Dynamic system prompt builder (Jx schema + project context)
- `context-manager.js` — Token tracking, trimming, conversation persistence

### 11.3 `@jxsuite/studio/panels/` (UI)

Depends on Studio services:

- `chat-panel.js` — Chat panel orchestrator (mount/render/unmount)
- `chat-messages.js` — Message list template
- `chat-composer.js` — Input composer template
- `chat-tool-call.js` — Tool call display template
- `chat-diff-preview.js` — Batched canvas diff preview

### 11.4 Why This Boundary Matters

Separating infrastructure (`@jxsuite/ai`) from JX-specific code means:

- The AI package can be reused in a future CLI tool, Frappe integration, or WordPress plugin.
- The streaming client abstraction can be tested independently.
- The tool registry can be used for non-JX tools in other contexts.
- Studio-specific code is clearly scoped and doesn't leak into the reusable layer.

---

## 12. Future Directions

### 12.1 v1.x Candidates

- **Claude/Anthropic provider** — Full implementation of `AnthropicStreamingClient` (stub exists from Phase 0).
- **Image generation** — "Generate a hero image" tool using DALL-E or similar, saves to project `public/`.
- **Markdown content editing** — AI can edit content collection Markdown files, not just Jx JSON.

### 12.2 v2 Candidates

- **Agent mode** — Multi-step autonomous tasks (e.g., "Build a full blog with posts, categories, and RSS feed") without per-step confirmation. Requires trust calibration.
- **Voice input** — Web Speech API for dictating prompts.
- **Multi-modal** — Upload screenshots or design mockups as vision input.
- **LangGraph / MCP integration** — Connect to external agent frameworks.
- **Fine-tuned Jx model** — A GPT-4o fine-tune on Jx schema + examples for higher accuracy.
- **Collaborative AI sessions** — Multiple users in the same chat session.
- **Server-side conversation persistence** — Swap localStorage for a server-backed store (the `chat-state.js` module supports this via dependency injection).

---

## References

- [assistant-ui](https://github.com/assistant-ui/assistant-ui) — Architecture inspiration
- [OpenAI Streaming API](https://platform.openai.com/docs/api-reference/streaming)
- [Anthropic Streaming API](https://docs.anthropic.com/en/api/messages-streaming)
- `specs/studio.md` — Jx Studio specification
- `specs/studio-ui-guidelines.md` — Studio UI rules (lit-html, Spectrum, no inline styles)
- `specs/site-architecture.md` — Site-level project structure
- `specs/spec.md` — Jx document format specification
