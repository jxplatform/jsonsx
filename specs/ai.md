# `@jxsuite/ai` Specification

## AI Assistant for Jx Studio

**Version:** 0.1.6-draft
**Status:** Partial
**Updated:** 2026-08-16
**License:** MIT

---

> **Status: Partial.** This is a stub spec for a shipped subsystem that grew ahead of its
> specification. It records the contract as implemented today; sections will be expanded as the
> subsystem stabilizes. The authoritative user documentation is
> [`docs/studio/ai.md`](../docs/studio/ai.md).

## 1. Overview

`@jxsuite/ai` is the assistant that edits a Jx project from natural-language instructions inside
Studio. It generates and edits pages and components on the canvas while the user watches. It ships
**no account and no hosted model**: the user connects their own provider, and Studio talks to it
through the dev/desktop server's AI proxy (`/__studio/ai/*`, see `@jxsuite/server` §4). The package
itself (`@jxsuite/ai`) has no Jx dependencies — it is a provider-agnostic streaming tool-call client
built on `@vue/reactivity`.

## 2. Provider Contract

- The client speaks the **OpenAI chat-completions** wire format (streaming SSE, tool calls).
- A **user-supplied key and base URL** are required; the server proxy attaches them per request and
  never persists them. The proxy refuses to forward a server-environment key to a user-supplied base
  URL, and blocks cloud-metadata/link-local hosts (see `@jxsuite/server` §4.2).
- Local and self-hosted OpenAI-compatible endpoints (e.g. LM Studio, Ollama's OpenAI shim) are
  supported by pointing the base URL at them.

> **Status: Partial.** The **Anthropic provider is not yet implemented** (planned; the client throws
> a clear "use OpenAI" error today — `packages/ai/src/streaming-client.ts`). Only the
> OpenAI-compatible path ships.

## 3. Tool Surface

The assistant is given a fixed set of document-editing tools (create/edit page and component,
inspect the tree, apply edits the canvas renders live). The tool schemas and the edit-application
path live in `packages/ai/src`. This section is a placeholder; the concrete tool list will be
enumerated here once it stabilizes.

### 3.0 The assistant is addressable by name

Every capability the chat surface offers is a command record in the `Assistant` category — Focus
Composer (`⌘⇧A`), New Chat, Chat History, Retry, Attach Selection and Stop — so each one is in the
palette, in the generated keyboard sheet, and rebindable, and the chat header's buttons RUN those
records rather than calling module functions beside them. They are `level: "application"`, including
Attach Selection: it READS the selection and WRITES a chip into the composer, and a record is filed
by the level of the state it writes.

Two context keys gate them and had no readers before: `ai.configured` (a provider is connected) and
`ai.streaming` (a turn is in flight, which is the only state in which Stop can act). None carries an
`aiTool` projection — the assistant does not get to end its own conversation.

### 3.1 Schema gate

Every tool that produces a document or `project.json` is gated on JSON-Schema validation, and
failures are returned to the model as tool errors so the agent loop self-corrects. Canvas mutations
validate AFTER applying (undo is the backstop, and only NEWLY introduced errors are reported);
disk writes validate BEFORE writing, because a disk write has no undo. `project.json` is gated
against the project entry document, not the document one.

The gate uses the ACTIVE project's generated entry documents — the same payload and the same single
fetch that drives the editor's diagnostics (studio.md §4.2.1), falling back to the bundled core
schemas. Validating the loop against core alone under-checks it: the entry documents are what close
the composition (`unevaluatedProperties: false`) and union in each enabled extension's shapes, so a
model can otherwise ship an extension section its own tool call called clean and the editor flags
the moment a human opens the file. The document-path convention the gate covers
(`pages|layouts|components|elements`) tracks the editor's fileMatch globs for the same reason.

### 3.2 The turn is accountable

An assistant that edits documents must be able to say what it changed, and the author must be able
to take it back. Three properties are normative.

**Every write is recorded, with whether it reached disk.** A tool that mutates the open document
goes through the transaction path and is therefore reachable by undo; a tool that writes a file
directly is not. That difference is a **fact recorded per write**, not a caveat in the system
prompt, and the turn's summary states it: _"Changed 2 files · 1 written to disk — undo cannot reach
it."_ **Restore to here** is offered only when every recorded change was transactional, and it
re-checks at the moment it is clicked, because the ledger is bounded and may have been trimmed.

**A tool chip states its outcome, not just its name.** The loop already had each call's result; the
renderer discarded it. A chip that cannot fail looks identical to one that did.

**Partial success is not failure.** Exhausting the tool-call budget after applying changes ends the
turn with an ordinary message describing what was applied. Rendering it as an error is wrong twice
over: it misreports the turn, and the error path _deletes the streaming message_, destroying the
only account of the edits that did land.

### 3.3 The batch follows the document, not the tab

A multi-tool turn may move between documents. The undo batch and the collaboration publish must be
re-anchored to the document each tool actually wrote — anchoring once, to whichever tab happened to
be active when the turn opened, silently files one document's edits under another's history.

## 4. Security & Trust

The assistant executes only through the same file/RPC surfaces a human uses, behind the server's
Origin/Host gate and path containment (`@jxsuite/server` §4.2). It has no independent network or
filesystem access beyond the connected provider endpoint.

## 5. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). The provider wire format is OpenAI's chat-completions API, which is a vendor de-facto format rather than a published standard, so it is described in §2 rather than cited here.

| Standard                                                                                                  | Class      | Binds | Evidence                                                           | Note                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ---------- | ----- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WHATWG HTML](https://html.spec.whatwg.org/)                                                              | **Subset** | §2    | packages/server/src/ai-api.ts                                      | Server-Sent Events only. The proxy emits `text/event-stream` frames discriminated by a `type` field in the JSON payload; it sends no `retry:` field and no event ids, so a dropped stream is not resumable.                                                                                                                                                                                                                      |
| [IANA IPv4 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv4-special-registry) | **Subset** | §4    | packages/server/src/ai-api.ts                                      | Only `169.254.0.0/16` is refused — the link-local range that contains the cloud metadata address. Loopback and private-use ranges are deliberately permitted, because self-hosted models run there.                                                                                                                                                                                                                              |
| [IANA IPv6 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv6-special-registry) | **Subset** | §4    | packages/server/src/ai-api.ts                                      | Only `fe80::/10` is refused, matching the IPv4 rule.                                                                                                                                                                                                                                                                                                                                                                             |
| [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)                                                        | **Subset** | §2    | packages/server/src/ai-api.ts, packages/ai/src/streaming-client.ts | The non-streaming failures are `application/problem+json`, keeping the upstream's own status rather than collapsing it. The mid-stream `error` frame **carries** a problem beside its existing `message`, because by the time it is written the response has begun with a 200 and no status can change. The model catalogue deliberately stays 200 with `upstreamError`: it is degraded success that still delivers a catalogue. |

## Changelog

- **0.1.6-draft** (2026-08-16) — §2 failures are problem documents and the mid-stream frame carries one; gap:ai-problem-details closed.
- **0.1.5-draft** (2026-08-15) — Add §5 Standards Alignment: SSE, the IANA special-purpose address registries the SSRF guard uses, and the problem+json gap.
- **0.1.4-draft** (2026-08-12) — The assistant's six capabilities are command records, gated on ai.configured and ai.streaming.
- **0.1.3-draft** (2026-08-04) — §3.2 the turn is accountable (per-write disk marking, Restore to here, chip outcomes, partial success) and §3.3 the batch follows the document, not the tab.
- **0.1.2-draft** (2026-07-25) — Schema gate (§3.1): tool-level validation against the active project's entry documents, before-write for disk writes and after-apply on canvas, project.json included.
- **0.1.1-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.0-draft** (2026-07-22) — Reconcile spec with shipped behavior; document the eval surface (`c8d1d580`).

---

_Jx `@jxsuite/ai` Specification v0.1.6-draft — a stub, subject to expansion._
