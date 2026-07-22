# `@jxsuite/ai` Specification

## AI Assistant for Jx Studio

**Version:** 0.1.0-draft
**Status:** Partial
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

## 4. Security & Trust

The assistant executes only through the same file/RPC surfaces a human uses, behind the server's
Origin/Host gate and path containment (`@jxsuite/server` §4.2). It has no independent network or
filesystem access beyond the connected provider endpoint.

---

_Jx `@jxsuite/ai` Specification v0.1.0-draft — a stub, subject to expansion._
