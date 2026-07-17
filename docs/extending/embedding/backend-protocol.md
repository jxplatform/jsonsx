---
title: "The backend protocol"
description: "The Studio Backend Protocol contract — core vs optional routes, transport freedom, versioning, the error shape, and behaviors implementers must match."
spec:
  - desktop.md#5 # backend API contract
code:
  - packages/protocol/src/routes.ts
  - packages/protocol/src/types.ts
  - packages/protocol/README.md
---

# The backend protocol

The Studio Backend Protocol is the wire contract every Jx Studio backend implements. It lives in one package, `@jxsuite/protocol`, with two entrypoints: `@jxsuite/protocol/types` holds the request/response shapes (`DirEntry`, `GitStatusResult`, `StarterInfo`, and friends — environment-agnostic, importable in browsers, Bun, and Workers alike), and `@jxsuite/protocol/routes` holds `STUDIO_ROUTES`, the canonical endpoint table. If you're serving the protocol over HTTP, this page plus the [route reference](/docs/extending/reference/studio-routes) is your specification; if you're [writing a platform adapter](/docs/extending/embedding/platform-adapter) instead, these are still the semantics your adapter must preserve.

## What exactly is the contract

The **sub-path, method, and body shapes are the contract** — the transport and path prefix are not. The dev server serves the literal `/__studio/*` routes; the desktop app dispatches the same operations over typed RPC / WebSocket JSON-RPC; cloud platforms serve them over HTTP behind a session gateway prefix. All three answer the same shapes for the same sub-paths, so Studio can't tell them apart.

Each entry in `STUDIO_ROUTES` carries its method, path, a one-line contract summary, and — for optional routes — what Studio does without it:

```ts
// packages/protocol/src/routes.ts
export interface StudioRoute {
  path: string;
  method: StudioRouteMethod;
  /** True when a backend may omit the route (its PAL member is optional). */
  optional: boolean;
  /** One-line contract summary. */
  summary: string;
  /** What Studio does when an optional route is absent. */
  degradation?: string;
}
```

The full table is generated into the [protocol route reference](/docs/extending/reference/studio-routes) — consult it there rather than re-reading the source.

## Core vs optional

Optional routes back optional `StudioPlatform` members. Omitting one is not an error: Studio degrades exactly as the entry's `degradation` describes — the starter picker empties, the Projects catalogue hides, the Publish panel explains git-push publishing instead, and so on. `coreRouteNames()` and `optionalRouteNames()` split the table programmatically, so a conformance test for a new backend can iterate `STUDIO_ROUTES` and assert that every core route answers.

The core set is what a minimal backend must serve: project session and probing (`activate`, `project`, `project-info`, `resolve-site`, `create-project`), the filesystem CRUD family, component discovery, package listing, the git suite, and the AI proxy pair (`ai/chat`, `ai/models`). Everything else — collab, starters, the data surface, secrets, Cloudflare publishing — is optional.

## Versioning

`STUDIO_PROTOCOL_VERSION` (currently `1`) bumps whenever any route's request or response shape changes incompatibly. The types are published as TypeScript source on the monorepo's release train; the package's only runtime dependency is `@jxsuite/schema`.

## The error shape

Every failure is an `ErrorBody` with a meaningful HTTP status:

```ts
// packages/protocol/src/types.ts
export interface ErrorBody {
  error: string;
  /** Machine-readable discriminator (e.g. "remote_moved", "cf_not_connected"). */
  code?: string;
  detail?: unknown;
}
```

`error` is the human-readable message; `code` is the machine-readable discriminator Studio switches on — `pull_conflict`, `remote_moved`, `cf_not_connected`, `needs_installation_access`. Return the right `code` and Studio shows its purpose-built recovery UI instead of a generic error toast.

## Behaviors implementers must match

Route shapes alone don't capture everything. These semantics are part of the contract:

- **`git/commit`** commits the staged files if any are staged, otherwise all dirty files. Cloud backends may make commit+push atomic and treat `git/push` as a sync check (`ahead` stays 0).
- **`git/pull`** returns `409 { code: "pull_conflict", conflicts: [paths] }` when local dirty files overlap remote changes; a clean pull fast-forwards.
- **`format`** dispatches `{ format, action: "parse" | "serialize", source? | doc?, options? }` through the project's format registry. Without it, only `.json` documents open.
- **`ai/chat`** accepts `{ messages, tools, systemPrompt, model }` and streams the normalized `StreamEvent` SSE defined by `@jxsuite/ai/streaming-client`. `ai/models` returns `AiModelsResponse`; report `configured: true` when the backend holds credentials (Studio then unlocks the assistant without a locally stored key) and `managed: true` when the platform brokers them.
- **`collab`** is a WebSocket upgrade speaking the `@jxsuite/collab` wire envelope — one socket per project, documents multiplexed by path. A plain GET (no Upgrade) answers `{ collab: true, version }` as the capability probe.
- **`cf/proxy`** is an allowlisted Cloudflare API passthrough (accounts and Pages projects/deployments only). The backend injects credentials — a header-borne user token on the dev server, a vaulted OAuth token on cloud — and stateless implementations must never persist them.
- **The data routes** (`data/connections`, `data/rows`, `data/push`, …) intentionally bypass table permission rules — they are the owner console, and the backend boundary (loopback/token locally, collaboration permission on cloud) is the gate. The secrets routes carry env-var **names only**, never values. See [connectors](/docs/extending/extensions/connectors) and the [extension security model](/docs/extending/extensions/security).

## Related

- [Protocol route reference](/docs/extending/reference/studio-routes) — the generated table: every route, method, summary, and degradation
- [Dev server internals](/docs/extending/embedding/dev-server) — the reference implementation of these routes
- [Writing a platform adapter](/docs/extending/embedding/platform-adapter) — the in-page interface these routes back
