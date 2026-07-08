# @jxsuite/collab

Realtime co-editing for Jx Studio: the shared Y.Doc schema for a Jx document, the bridge between
Studio's transactional op-log and Yjs, a structural differ, the binary wire envelope every collab
backend speaks, and the provider contract Studio consumes through its Platform Abstraction Layer.

Everything here is environment-agnostic TypeScript (no DOM, no Node/Bun APIs): the same modules run
in the browser, in the `@jxsuite/server` dev server, and on Cloudflare Workers.

## The document model

One `Y.Doc` per open file:

| Root type            | Purpose                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `source: Y.Text`     | **The authoritative file content.** Providers persist `getText("source").toString()` — nothing else.                                        |
| `structure: Y.Map`   | The `JxMutableNode` tree, projected by Studio. Only `children` nests (`Y.Array`); every other key is a plain-JSON value merged whole (LWW). |
| `frontmatter: Y.Map` | Per-field plain-JSON values.                                                                                                                |
| `meta: Y.Map`        | `schemaVersion`, `structureSeeded`, `canonical`, `canonicalRev`, `sourceFormat`.                                                            |

The CRDT granularity deliberately equals Studio's op-log granularity: mutators emit whole-value
`set-key`s and children splices, so those are the only merge points.

**Seeding contract.** Providers seed only `source` from file bytes; they never parse or serialize
Jx documents. Clients derive `structure` on first sync via `seedStructure()`, which is safe under
concurrent seeders because it only performs whole-key `Y.Map` sets (per-key LWW keeps one seeder's
subtrees wholesale — never array inserts, which would duplicate). A client's `Y.Doc` must start
empty; never seed locally before the provider's sync completes.

## The op bridge

- `applyDocOpsToY(doc, ops, origin)` replays Studio's recorded forward `JxDocOp`s onto the Y tree
  in one origin-tagged transaction (`LOCAL_ORIGIN` for user edits, `MIRROR_ORIGIN` for derived
  writes, `SEED_ORIGIN` for bootstraps).
- `yEventsToDocOps(events)` converts a remote transaction's deep events back into `JxDocOp`s —
  call it **inside** the `observeDeep` callback. It returns `null` for shapes it cannot convert
  safely; reconcile by diffing instead.
- `diffDocs(a, b)` produces ops transforming `a` into `b` (invariant: `apply(clone(a), diff(a,b))
≡ b`); returns `null` past `maxOps`, in which case `replaceYStructure()` hard-replaces and bumps
  `meta.canonicalRev` so stale mirror writes are discarded.
- `applyDocOpToDoc` (in `./ops`, yjs-free) is the canonical plain-JSON applier shared with
  Studio's history replay and canvas shadow doc.

## The wire envelope (`./envelope`)

One WebSocket per project, multiplexing every open document (lib0 binary frames):

```
frame          := varUint frameType, body
0 DOC_SYNC     := varString path, varUint docEpoch, varUint8Array y-protocols sync body
1 AWARENESS    := varUint8Array y-protocols awareness update (project-scoped)
2 DOC_CLOSE    := varString path
3 CONTROL      := varString json    — hello | open | opened | doc-reset | flush | flush-ack | error
```

`docEpoch` is the server-owned lifetime counter of a doc's Y history. **Y history is never deleted
or replaced without an epoch bump**: out-of-band content replacement (git discard/pull/rename,
non-collab writes) bumps it and broadcasts `doc-reset`; clients destroy their `Y.Doc` and re-open.
Stale-epoch frames are dropped. This invariant is what prevents divergent-history duplicate-content
merges.

Session flow: connect → server sends `hello{login, name?, avatarUrl?, color, permission}` → client
sends `open{path}` per document → server ensures the room (loads persisted Y state or seeds
`source` from the file) → `opened{path, epoch}` → y-protocols sync handshake → updates flow.
Read-only sockets receive sync and may publish awareness, but their doc updates are dropped with
one `error{read-only}`.

## Awareness (`./awareness-types`)

One project-level `Awareness` per connection. State shape:
`{ user: {login, name?, avatarUrl?, color}, focusedPath, mode?, structuralSelection?, selection? }` —
file-tree presence (the plain `selection` field is y-monaco's in-buffer cursor)
and per-document cursor overlays both filter the same states. Identity comes from the server
`hello`; colors are deterministic (`colorForKey`).

## Provider contract (`./provider`, type-only)

`StudioPlatform.collab?: (docPath) => Promise<CollabHandle | null>` where a handle carries
`{doc, awareness, whenSynced, identity(), flush(), onStatus(), onReset(), destroy()}`. `onReset`
fires on a `doc-reset`: the handle is dead — destroy it and re-acquire.

## Versioning

Published to npm as `@jxsuite/collab` — TypeScript source, like every `@jxsuite`
package, following the monorepo's release train. Within the monorepo, other
packages (`@jxsuite/server`, `@jxsuite/studio`) depend on it via `workspace:^`.
