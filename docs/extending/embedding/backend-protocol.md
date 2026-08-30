---
title: "The backend protocol"
description: "The Studio Backend Protocol contract: core vs optional routes, transport freedom, versioning, the error shape, and behaviors implementers must match."
spec:
  - desktop.md#5 # backend API contract
code:
  - packages/protocol/src/routes.ts
  - packages/protocol/src/problem.ts
  - packages/protocol/src/problems.ts
  - packages/protocol/src/types.ts
  - packages/protocol/README.md
  - packages/ai/src/streaming-client.ts
---

# The backend protocol

The Studio Backend Protocol is the wire contract every Jx Studio backend implements. It lives in one package, `@jxsuite/protocol`, with two entrypoints. `@jxsuite/protocol/types` holds the request/response shapes (`DirEntry`, `GitStatusResult`, `StarterInfo`, and friends), which are environment-agnostic and importable in browsers, Bun, and Workers alike. `@jxsuite/protocol/routes` holds `STUDIO_ROUTES`, the canonical endpoint table. If you're serving the protocol over HTTP, this page plus the [route reference](/docs/extending/reference/studio-routes) is your specification; if you're [writing a platform adapter](/docs/extending/embedding/platform-adapter) instead, these are still the semantics your adapter must preserve.

## What exactly is the contract

The **sub-path, method, and body shapes are the contract**. The transport and path prefix are not. The dev server serves the literal `/__studio/*` routes; the desktop app dispatches the same operations over typed RPC / WebSocket JSON-RPC; cloud platforms serve them over HTTP behind a session gateway prefix. All three answer the same shapes for the same sub-paths, so Studio can't tell them apart.

Each entry in `STUDIO_ROUTES` carries its method, path, a one-line contract summary, and, for optional routes, what Studio does without it:

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

The full table is generated into the [protocol route reference](/docs/extending/reference/studio-routes). Consult it there rather than re-reading the source.

## Core vs optional

Optional routes back optional `StudioPlatform` members. Omitting one is not an error. Studio degrades exactly as the entry's `degradation` describes: the starter picker empties, the Projects catalogue hides, the Publish panel explains git-push publishing instead, and so on. `coreRouteNames()` and `optionalRouteNames()` split the table programmatically, so a conformance test for a new backend can iterate `STUDIO_ROUTES` and assert that every core route answers.

The core set is what a minimal backend must serve: project session and probing (`activate`, `project`, `project-info`, `resolve-site`, `create-project`), the filesystem CRUD family, component discovery, package listing, the git suite, and the AI proxy pair (`ai/chat`, `ai/models`). Everything else is optional: collab, starters, the data surface, secrets, Cloudflare publishing.

## Versioning

`STUDIO_PROTOCOL_VERSION` (currently `1`) bumps whenever any route's request or response shape changes incompatibly. The types are published as TypeScript source on the monorepo's release train; the package's only runtime dependency is `@jxsuite/schema`.

## The error shape

Every failure is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem document, sent as `application/problem+json`:

```json
{
  "type": "https://jxsuite.com/problems/conflict",
  "title": "The request conflicts with the current state",
  "status": 409,
  "detail": "Pull stopped: 2 file(s) changed on both sides.",
  "conflicts": ["src/app.json", "README.md"]
}
```

Four things are worth knowing before you implement one:

- **`type` is what Studio keys on**, and it's an absolute URI. The full list is in [Studio routes](/docs/extending/reference/studio-routes#failures), generated from the same table the reference backend answers from, so it can't drift.
- **`title` describes the _type_; `detail` describes _this_ failure.** Keep `title` identical across occurrences and put the specifics in `detail`. Swapping them is the standard's most common misuse, and it's what stops Studio grouping two instances of the same problem.
- **The status belongs to the type.** If you find yourself wanting to send one type at two statuses, it's two types.
- **Extension members carry anything else the type documents**: `conflicts` on a pull conflict, `installUrl` on a missing GitHub App installation. Studio's recovery UI reads them.

:::doc-note
`error` is emitted alongside `detail`, with the same value, for one release. It's the pre-RFC-9457 field name, kept so a client written against the older shape keeps working while it migrates. Don't write new readers against it.
:::

Three surfaces deliberately answer **200 with an error field instead**, and a conforming backend should too:

| Surface                   | Why                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Code services (`/code/*`) | A syntax error in the author's snippet is the _result_ of a lint, not a failed request         |
| AI model catalogue        | Degraded success: the catalogue is still delivered, from defaults                              |
| Mid-stream SSE frames     | The response began with a 200; nothing can change the status, so the frame _carries_ a problem |

## Behaviors implementers must match

Route shapes alone don't capture everything. These semantics are part of the contract:

- **`git/commit`** commits the staged files if any are staged, otherwise all dirty files. Cloud backends may make commit+push atomic and treat `git/push` as a sync check (`ahead` stays 0).
- **`git/pull`** returns `409 { code: "pull_conflict", conflicts: [paths] }` when local dirty files overlap remote changes; a clean pull fast-forwards.
- **`format`** dispatches `{ format, action: "parse" | "serialize", source? | doc?, options? }` through the project's format registry. Without it, only `.json` documents open.
- **`ai/chat`** accepts `{ messages, tools, systemPrompt, model }` and streams the normalized `StreamEvent` SSE defined by `@jxsuite/ai/streaming-client`. The union and its six members are exported, so implementers can import the type they are satisfying rather than reconstruct it. `ai/models` returns `AiModelsResponse`; report `configured: true` when the backend holds credentials (Studio then unlocks the assistant without a locally stored key) and `managed: true` when the platform brokers them. It is a capability probe, so it answers `200` in every credential state — a non-2xx makes the probe throw and withdraws the connect affordance from exactly the users who need it. Where a model's capabilities are known, report them per entry: `toolSupport: false` makes Studio warn that the chosen model will answer but never edit, and `contextWindow` replaces Studio's model-id prefix table, which recognizes only the families it was written for and budgets everything else at its default. A brokered backend distinguishes `cf_not_connected` (invite), `cf_reconnect_required` (the grant lapsed — explain and offer reconnection), `cf_account_required` (the grant is live but no account is chosen; offer a picker, since re-authorizing lands back here) and `cf_upstream_error`, which is reported **with** `configured: true` because a briefly unreachable provider is not a credential problem.
- **`collab`** is a WebSocket upgrade speaking the `@jxsuite/collab` wire envelope: one socket per project, documents multiplexed by path. A plain GET (no Upgrade) answers `{ collab: true, protocols, version }` as the capability probe.

  `protocols` lists the WebSocket subprotocols the backend speaks, currently `["jx.collab.v1"]`, and it is also the negotiation: Studio offers one of them as `Sec-WebSocket-Protocol` and the backend must echo the one it accepts. **A backend that lists none is offered none**, because [RFC 6455 §4.1](https://www.rfc-editor.org/rfc/rfc6455#section-4.1) makes a client whose offer went unechoed fail the connection. An older backend keeps working exactly as before. A backend that lists only tokens Studio cannot parse gets no socket at all, which is the point: two peers whose envelopes disagree would merge divergent histories.

- **`files`** answers in **stable path order**, both when listing a directory (`?dir=`) and when searching (`?glob=`). `readdir` and glob scans report in filesystem order, which varies with a directory's write history; Studio's collection grid inserts rows in listing order, so an unsorted listing reaches the user as a table that reshuffles itself between opens. Sort by codepoint rather than locale collation, so two backends and two machines agree.
- **`cf/proxy`** is an allowlisted Cloudflare API passthrough (accounts and Pages projects/deployments only). The backend injects credentials (a header-borne user token on the dev server, a vaulted OAuth token on cloud), and stateless implementations must never persist them.
- **The data routes** (`data/connections`, `data/rows`, `data/push`, …) intentionally bypass table permission rules. They are the owner console, and the backend boundary (loopback/token locally, collaboration permission on cloud) is the gate. The secrets routes carry env-var **names only**, never values. See [connectors](/docs/extending/extensions/connectors) and the [extension security model](/docs/extending/extensions/security).

## Related

- [Protocol route reference](/docs/extending/reference/studio-routes): the generated table of every route, method, summary, and degradation
- [Dev server internals](/docs/extending/embedding/dev-server): the reference implementation of these routes
- [Writing a platform adapter](/docs/extending/embedding/platform-adapter): the in-page interface these routes back
