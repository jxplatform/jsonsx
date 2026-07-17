---
title: "Embedding overview"
description: "How Jx Studio runs on any backend: the platform-adapter layer, the wire protocol behind it, and how to choose an integration path for your host."
spec:
  - desktop.md#1 # deployment targets
  - desktop.md#2 # design constraints
  - desktop.md#3 # platform abstraction layer
code:
  - packages/studio/src/platform.ts
  - packages/protocol/src/routes.ts
---

# Embedding overview

Jx Studio is one web app that runs against whatever backend hosts it. The `@jxsuite/studio` package contains all UI logic and imports no platform-specific modules — the same codebase ships as the desktop app, as the dev-mode editor in Chrome, and as a cloud editor in a plain browser. Everything environment-specific — file I/O, project loading, git, component discovery — is injected at startup. If you're building a backend or host for Studio, this page maps the layers and helps you pick where to plug in.

## The two layers

Studio's backend abstraction has two layers, and you implement exactly one of them:

- **The platform adapter (PAL)** — an in-page JavaScript object implementing the `StudioPlatform` interface, registered via `registerPlatform()` before Studio boots. Every Studio operation calls the current adapter; nothing in Studio fetches a backend URL directly.
- **The backend protocol** — the wire contract behind the adapters, defined once in `@jxsuite/protocol`: a canonical route table plus the request/response types. The sub-path, method, and body shapes are the contract; the transport and path prefix are free.

Every adapter ultimately speaks the protocol. The stock adapters differ only in transport: one speaks literal HTTP, one speaks native RPC, one speaks HTTP behind a session gateway.

## Who implements what today

| Host                                     | Platform adapter                                                     | Transport                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Dev server (`@jxsuite/server`)           | `packages/studio/src/platforms/devserver.ts` — registered by default | The literal `/__studio/*` HTTP routes — the protocol's reference implementation                           |
| Desktop (ElectroBun / Chromium app-mode) | `packages/desktop/src/platform.ts`                                   | Typed RPC / WebSocket JSON-RPC into the same handlers, behind a loopback-only, token-gated project server |
| Cloud platforms                          | `packages/studio/src/platforms/cloud.ts`                             | HTTP behind a session gateway (`/api/v1/p/:owner/:repo/:branch/studio/*`), same sub-paths and shapes      |

## Choosing your integration path

**Serve the HTTP protocol** when your backend can expose HTTP endpoints. Implement the protocol's core routes at `/__studio/*` (or an equivalent prefix) and reuse the stock dev-server adapter unchanged — Studio registers it automatically when no other platform is present. Your backend can be written in any language; a conformance check is just iterating the route table and asserting every core route answers. This is the least code and the path most hosted backends take. Start at [the backend protocol](/docs/extending/embedding/backend-protocol).

**Implement `StudioPlatform` in-page** when the transport isn't plain HTTP — a native RPC bridge like the desktop app's, a session gateway with its own path scheme and auth like the cloud adapter's — or when you need to own the client-side pieces the protocol can't cover. Project opening is the clearest example: it's inherently a client concern (a native file dialog on desktop, `showDirectoryPicker()` in Chrome, a project list on cloud), so it lives in the adapter, not on the wire. Start at [writing a platform adapter](/docs/extending/embedding/platform-adapter).

Either way, the semantics come from `@jxsuite/protocol` — an in-page adapter should behave exactly as the corresponding routes describe, because Studio can't tell the difference.

## Partial backends are fine

You don't have to implement everything. Optional protocol routes back optional `StudioPlatform` members; Studio checks for their presence and degrades exactly as each route's `degradation` entry describes — the starter picker empties, the Projects catalogue hides, realtime co-editing falls back to solo file-level saves, and so on. The [protocol route reference](/docs/extending/reference/studio-routes) lists every route with its optionality and degradation.

## Related

- [Writing a platform adapter](/docs/extending/embedding/platform-adapter) — the `StudioPlatform` interface, registration, and the two real adapters
- [The backend protocol](/docs/extending/embedding/backend-protocol) — contract semantics, versioning, errors, and required behaviors
- [Dev server internals](/docs/extending/embedding/dev-server) — how the reference implementation is put together
- [Protocol route reference](/docs/extending/reference/studio-routes) — the generated route table
