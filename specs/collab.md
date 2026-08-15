# `@jxsuite/collab` Specification

## Real-Time Co-Editing for Jx Projects

**Version:** 0.2.3-draft
**Status:** Partial
**Updated:** 2026-08-15
**License:** MIT

---

> **Status: Partial.** This is a stub spec for a shipped subsystem that grew ahead of its
> specification. It records the wire contract and the load-bearing invariants as implemented today;
> sections will be expanded as the protocol stabilizes.

## 1. Overview

`@jxsuite/collab` provides multi-participant, real-time co-editing of a Jx project. Documents are
modeled as [Yjs](https://github.com/yjs/yjs) shared types; edits converge via CRDT merge, so
concurrent editors do not clobber each other. The transport is a WebSocket route on the dev/desktop
server (`/__studio/collab`), which also answers a capability probe when collab is disabled.

## 2. Wire Protocol

- **Transport:** a single WebSocket per project session. Sync and awareness frames use the standard
  `y-protocols` encodings (sync step 1/2, update, awareness).
- **Envelope:** frames are wrapped with an **epoch** tag. The epoch is the load-bearing invariant —
  see §3.
- **Awareness:** cursor/selection presence is carried out-of-band from document state via
  `y-protocols/awareness`, so presence churn never mutates the CRDT.

## 3. Invariants (load-bearing)

- **Y history is never deleted or replaced without an epoch bump.** A frame carrying a stale epoch
  forces the receiving client to rebuild its `Y.Doc` from the current epoch rather than merge across
  a history discontinuity. This is what keeps a re-seeded or reset room from silently diverging.
- **Seeding is convergence-safe under concurrent seeders:** whole-key last-writer-wins on the seed
  `Y.Map`; the server seeds only `source`, clients derive `structure`. Two clients seeding the same
  empty room converge on one state.
- **CRDT granularity is finer than op granularity, and the bridge is what reconciles them.** Studio's
  mutators record whole-value ops (an inline commit replaces a whole `textContent`; a style edit
  replaces the whole `style` object). Storing those as whole values made concurrent edits
  last-writer-wins. The shared document therefore stores prose as `Y.Text` and
  `style`/`attributes`/`$props` as nested `Y.Map`s, and the op bridge diffs a whole-value op down onto
  that structure — never replacing a live container when the type is unchanged, because replacement
  orphans a peer's concurrent edit. Inbound, granular events collapse back to one whole-value op for
  the owning key. So the op log, the canvas patcher and the undo ring are unaffected while concurrent
  edits merge.
- **Undo is origin-scoped.** The `Y.UndoManager` delegate tracks only local-origin transactions, so
  undoing your own edit cannot revert a peer's concurrent edit to a sibling property.

These invariants are implemented in `packages/collab/src` (`envelope.ts`, `schema.ts`,
`provider.ts`); this section records them so a future change cannot quietly break them.

### 3.1 Merge Granularity

| Document position                                               | Stored as             | Concurrent-edit outcome                                   |
| --------------------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| `textContent` (string), bare-string child                       | `Y.Text`              | Per character — both authors' insertions survive          |
| `style`, `attributes`, `$props` (and nested blocks)             | `Y.Map`, values plain | Per property — different properties both survive          |
| `children`                                                      | `Y.Array`             | Per element                                               |
| `tagName`, `$ref`, `$switch`, `cases`, `state`, everything else | Whole-JSON value      | Last writer wins (these are replaced wholesale by design) |
| `source`                                                        | `Y.Text`              | Per character (source-mode co-editing)                    |

A **type change** — text becoming a `$ref`, an object becoming a scalar — replaces the container, since
no shared structure remains to preserve.

## 4. Enablement & Degradation

Collab is a capability the platform may or may not expose. When disabled, `/__studio/collab` answers
the probe negatively and the editor runs single-player. Enablement state and the seeding handshake
are part of the session lifecycle; a full state machine will be documented here as it settles.

A session is in exactly one of four states, and **only one of them is silent**:

| State         | Means                           | Shown as                           |
| ------------- | ------------------------------- | ---------------------------------- |
| `unavailable` | this build has no collaboration | nothing — there is nothing to say  |
| `detached`    | available, not joined           | **Solo**                           |
| `attached`    | joined                          | the peer chips                     |
| `failed`      | tried to join and could not     | **Not connected**, with the reason |

Collapsing `failed` into `detached` is the defect this table exists to prevent: a connection that
died and a session nobody started look identical, so the author has no way to know whether to retry.
An attach failure records its reason and reports it once.

Two further states must be _visible_ rather than inferred, because in both of them the editor stops
responding the way it normally does:

- **A freeze** — a peer holding the document while editing source — carries a persistent indicator
  saying so, and saying explicitly that it is not an error. A three-second grey line is how a freeze
  became indistinguishable from a bug.
- **Read-only** carries a banner, not a silent refusal of every edit.

**Undo is scoped to your own edits and says so.** The scoping was always correct and entirely
unstated, which is worse than not scoping it: an author who does not know it cannot predict what
:kbd[⌘Z] will do, and the guess that it might take back a collaborator's work is the one that stops
people using undo at all.

`project.json` is **excluded from replication.** No session is attached to a tab whose
`documentPath` is `project.json`, and therefore no history delegate is registered over it. Its edits
arrive from surfaces that are not the canvas, and its value configures the local editor's formats,
extensions, schemas and style cascade — so a shared configuration document would let a peer's edit
reconfigure another author's editor mid-keystroke, and would let the source-canonical freeze pause
configuration edits that contain no text at all. A collaborator therefore does not see configuration
changes live; they arrive with the file.

## 5. Version Skew

> **Status: Pending.** Neither kind of skew is handled today.

Two different things can be out of step, and conflating them has hidden the tractable one.

**Document-format skew** — a breaking change to the Jx document schema across a room's lifetime — is
out of scope for this draft and tracked separately (see spec §3.2 on `$schema`).

**Wire-envelope skew** is not. Two clients running different envelope versions disagree about merge
granularity (§3.1) and can join the same room, because the WebSocket carries no subprotocol: the
client offers no `Sec-WebSocket-Protocol` and the server echoes none. The capability probe already
returns a version the client discards. RFC 6455 negotiation is the mechanism designed for exactly
this, and it fails the handshake rather than admitting a divergent peer.

## 6. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). Yjs and `y-protocols` are libraries rather than published standards, so the encodings they define are described in §2 rather than cited here.

| Standard                                           | Class        | Binds | Evidence                                                       | Note                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ------------ | ----- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455) | **Subset**   | §2    | packages/collab/src/envelope.ts, packages/server/src/collab.ts | `gap:collab-subprotocol` The transport is used as specified. Subprotocol negotiation (§1.9, §4.2.2) is not: no `Sec-WebSocket-Protocol` is offered or echoed, so two peers with incompatible envelopes can share a room — §5 records the consequence.                                                                                            |
| [RFC 7692](https://www.rfc-editor.org/rfc/rfc7692) | **Rejected** | §2    | —                                                              | because: lib0-encoded Yjs updates are near-incompressible, the dominant frame volume is awareness cursors whose payload is smaller than a deflate block header, both transports are loopback or already compressed at the edge, and Bun allocates a zlib context per socket — a real cost for a server whose purpose is many concurrent sockets. |

## Changelog

- **0.2.3-draft** (2026-08-15) — Add §6 Standards Alignment; §5 separates wire-envelope skew from document-format skew and is marked Pending.
- **0.2.2-draft** (2026-08-05) — §4 project.json is excluded from replication, and why.
- **0.2.1-draft** (2026-08-04) — §4 the four session states, with failed distinguished from detached; freeze and read-only made visible; undo scoping stated in the UI.
- **0.2.0-draft** (2026-07-28) — Store prose as Y.Text and style/attributes/$props as nested Y.Maps so concurrent edits merge per character and per property; the op bridge diffs whole-value ops onto that structure.
- **0.1.1-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.0-draft** (2026-07-22) — Reconcile spec with shipped behavior; document the eval surface (`c8d1d580`).

---

_Jx `@jxsuite/collab` Specification v0.2.3-draft — a stub, subject to expansion._
