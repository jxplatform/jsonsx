# `@jxsuite/ai` Specification

## AI Assistant for Jx Studio

**Version:** 0.1.2-draft
**Status:** Partial
**Updated:** 2026-07-25
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

## 4. Security & Trust

The assistant executes only through the same file/RPC surfaces a human uses, behind the server's
Origin/Host gate and path containment (`@jxsuite/server` §4.2). It has no independent network or
filesystem access beyond the connected provider endpoint.

## Changelog

- **0.1.2-draft** (2026-07-25) — Schema gate (§3.1): tool-level validation against the active project's entry documents, before-write for disk writes and after-apply on canvas, project.json included.
- **0.1.1-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.0-draft** (2026-07-22) — Reconcile spec with shipped behavior; document the eval surface (`c8d1d580`).

---

_Jx `@jxsuite/ai` Specification v0.1.2-draft — a stub, subject to expansion._
