# @jxsuite/protocol

The **Studio Backend Protocol**: the wire types and canonical route table that
every Jx Studio backend implements. Jx Studio is backend-agnostic — the editor
talks to whatever registered a `StudioPlatform` adapter (see
`@jxsuite/studio/platform`), and every adapter ultimately speaks the contract
defined here. This package is the single source of truth for that contract:

- `@jxsuite/protocol/types` — the request/response shapes (`DirEntry`,
  `GitStatusResult`, `StarterInfo`, `AiModelsResponse`, `CfConnection`, …).
  Environment-agnostic: no DOM, no node — importable in browsers, Bun, and
  Cloudflare Workers alike.
- `@jxsuite/protocol/routes` — `STUDIO_ROUTES`, the canonical endpoint table
  with methods, one-line contract summaries, and per-route optionality.

## Who implements this

| Backend                         | Transport                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@jxsuite/server` (dev server)  | The literal `/__studio/*` HTTP routes — the reference implementation                                      |
| Desktop (Electrobun / Chromium) | Typed RPC / WebSocket JSON-RPC dispatching into the same handlers                                         |
| Cloud platforms                 | HTTP behind a session gateway (e.g. `/api/v1/p/:owner/:repo/:branch/studio/*`), same sub-paths and shapes |

A backend is free to change the transport and path prefix; the **sub-path,
method, and body shapes are the contract**. `STUDIO_PROTOCOL_VERSION` bumps
when any shape changes incompatibly.

## Core vs optional

Optional routes back optional `StudioPlatform` members. Omitting one is not an
error — Studio degrades exactly as each entry's `degradation` describes (the
starter picker empties, the Projects catalogue hides, the Publish panel
explains git-push publishing, and so on). `coreRouteNames()` /
`optionalRouteNames()` split the table programmatically; a conformance test
for a new backend can iterate `STUDIO_ROUTES` and assert every core route is
served.

Highlights an implementer should know:

- **`git/commit`** commits the staged files if any are staged, otherwise all
  dirty files. Cloud backends may make commit+push atomic and treat
  `git/push` as a sync check (`ahead` stays 0).
- **`git/pull`** returns `409 { code: "pull_conflict", conflicts: [paths] }`
  when local dirty files overlap remote changes.
- **`format`** dispatches `{ format, action: "parse" | "serialize", source? |
doc?, options? }` through the project's format registry; without it only
  `.json` documents open.
- **`ai/chat`** accepts `{ messages, tools, systemPrompt, model }` and streams
  the normalized `StreamEvent` SSE defined by `@jxsuite/ai/streaming-client`.
  `ai/models` returns `AiModelsResponse`; report `configured: true` when the
  backend holds credentials (Studio then unlocks the assistant without a
  locally stored key) and `managed: true` when the platform brokers them.
- **`cf/proxy`** is an allowlisted Cloudflare API passthrough (accounts and
  Pages projects/deployments only). Credentials are injected by the backend —
  a header-borne user token on the dev server, a vaulted OAuth token on cloud
  platforms — and must never be persisted by stateless implementations.
- **Errors** are `{ error, code?, detail? }` (`ErrorBody`) with a meaningful
  HTTP status; `code` is the machine-readable discriminator Studio switches
  on (e.g. `remote_moved`, `cf_not_connected`, `needs_installation_access`).

## Versioning

The types are published as TypeScript source (like every `@jxsuite` package)
and follow the monorepo's release train. Within the monorepo, packages depend
on it via `workspace:^`.
