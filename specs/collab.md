# `@jxsuite/collab` Specification

## Real-Time Co-Editing for Jx Projects

**Version:** 0.2.5-draft\
**Status:** Partial\
**Updated:** 2026-08-20\
**License:** MIT

---

> **Status: Partial.** This is a stub spec for a shipped subsystem that grew ahead of its specification. It records the wire contract and the load-bearing invariants as implemented today; sections will be expanded as the protocol stabilizes.

## 1. Overview

`@jxsuite/collab` provides multi-participant, real-time co-editing of a Jx project. Documents are modeled as [Yjs](https://github.com/yjs/yjs) shared types; edits converge via CRDT merge, so concurrent editors do not clobber each other. The transport is a WebSocket route on the dev/desktop server (`/__studio/collab`), which also answers a capability probe when collab is disabled.

## 2. Wire Protocol

- **Transport:** a single WebSocket per project session. Sync and awareness frames use the standard `y-protocols` encodings (sync step 1/2, update, awareness).
- **Envelope:** frames are wrapped with an **epoch** tag. The epoch is the load-bearing invariant — see §3.
- **Awareness:** cursor/selection presence is carried out-of-band from document state via `y-protocols/awareness`, so presence churn never mutates the CRDT.
- **Subprotocol:** `jx.collab.v1` names the frame layout, negotiated on the handshake — see §2.1.
- **No compression.** `permessage-deflate` (RFC 7692) is not offered and not accepted, and the reasons are structural rather than a deferral: lib0-encoded Yjs updates are near-incompressible, the dominant frame volume is awareness cursors whose payload is smaller than a deflate block header, both transports are loopback or already compressed at the edge, and Bun allocates a zlib context per socket — a real per-connection cost on a server whose whole purpose is many concurrent sockets. Adopting it would cost memory to make the wire slightly larger.

### 2.1 Subprotocol Negotiation

The socket carries a **WebSocket subprotocol** (RFC 6455 §1.9, §4.2.2), and it names the **wire envelope**, not the package version: `jx.collab.v1` means "I speak the frame layout §2 describes".

**One token per envelope major.** The token is bumped when a peer's frame would be _mis-parsed_ — a field reordered, a type widened, a length prefix changed. It is **not** bumped for a new frame type, because both halves already skip a type they do not know: bumping there would refuse a room that would have worked.

**The capability probe is where the two sides agree.** `GET /__studio/collab` answers `{collab, protocols, version}`, and `protocols` is the negotiation input:

| The server advertises               | The client offers            | Because                                                                                 |
| ----------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| a token the client speaks           | that token                   | the handshake then echoes it, and both know the envelope matches                        |
| **no `protocols` at all**           | **nothing**                  | it predates negotiation and would echo nothing — see below                              |
| only tokens the client cannot parse | nothing; no socket is opened | a divergent-history merge is worse than no session, and here the reason can be reported |

**Why an unconditional offer would be a regression.** RFC 6455 §4.1 requires a client that offered subprotocols and received no echo to _fail the connection_, and browsers enforce it. A new Studio that always offered `jx.collab.v1` would therefore lose co-editing entirely against a server built before this shipped. The probe already existed, already returned a version the client discarded, and runs before the socket — it is the one place the client can learn what the server speaks without risking the handshake.

**A version in the `hello` control message is not an alternative.** `hello` arrives after the socket is up and after frames may already have been exchanged, which is too late to prevent the divergent-history merge §3 exists to prevent. Negotiation concludes before a byte of document state moves.

**An unanswered probe is not a refusal.** The cloud gateway ships separately from the Studio bundle, so a 404 or a network error on its probe means _older gateway_, and treating that as no-collab would take working co-editing away from every session pointed at one. It connects offering nothing, which is also the only handshake-safe answer to a server that would echo nothing.

## 3. Invariants (load-bearing)

- **Y history is never deleted or replaced without an epoch bump.** A frame carrying a stale epoch forces the receiving client to rebuild its `Y.Doc` from the current epoch rather than merge across a history discontinuity. This is what keeps a re-seeded or reset room from silently diverging.
- **Seeding is convergence-safe under concurrent seeders:** whole-key last-writer-wins on the seed `Y.Map`; the server seeds only `source`, clients derive `structure`. Two clients seeding the same empty room converge on one state.
- **CRDT granularity is finer than op granularity, and the bridge is what reconciles them.** Studio's mutators record whole-value ops (an inline commit replaces a whole `textContent`; a style edit replaces the whole `style` object). Storing those as whole values made concurrent edits last-writer-wins. The shared document therefore stores prose as `Y.Text` and `style`/`attributes`/`$props` as nested `Y.Map`s, and the op bridge diffs a whole-value op down onto that structure — never replacing a live container when the type is unchanged, because replacement orphans a peer's concurrent edit. Inbound, granular events collapse back to one whole-value op for the owning key. So the op log, the canvas patcher and the undo ring are unaffected while concurrent edits merge.
- **Undo is origin-scoped.** The `Y.UndoManager` delegate tracks only local-origin transactions, so undoing your own edit cannot revert a peer's concurrent edit to a sibling property.

These invariants are implemented in `packages/collab/src` (`envelope.ts`, `schema.ts`, `provider.ts`); this section records them so a future change cannot quietly break them.

### 3.1 Merge Granularity

| Document position                                               | Stored as             | Concurrent-edit outcome                                   |
| --------------------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| `textContent` (string), bare-string child                       | `Y.Text`              | Per character — both authors' insertions survive          |
| `style`, `attributes`, `$props` (and nested blocks)             | `Y.Map`, values plain | Per property — different properties both survive          |
| `children`                                                      | `Y.Array`             | Per element                                               |
| `tagName`, `$ref`, `$switch`, `cases`, `state`, everything else | Whole-JSON value      | Last writer wins (these are replaced wholesale by design) |
| `source`                                                        | `Y.Text`              | Per character (source-mode co-editing)                    |

A **type change** — text becoming a `$ref`, an object becoming a scalar — replaces the container, since no shared structure remains to preserve.

## 4. Enablement & Degradation

Collab is a capability the platform may or may not expose. When disabled, `/__studio/collab` answers the probe negatively and the editor runs single-player. Enablement state and the seeding handshake are part of the session lifecycle; a full state machine will be documented here as it settles.

A session is in exactly one of four states, and **only one of them is silent**:

| State         | Means                           | Shown as                           |
| ------------- | ------------------------------- | ---------------------------------- |
| `unavailable` | this build has no collaboration | nothing — there is nothing to say  |
| `detached`    | available, not joined           | **Solo**                           |
| `attached`    | joined                          | the peer chips                     |
| `failed`      | tried to join and could not     | **Not connected**, with the reason |

Collapsing `failed` into `detached` is the defect this table exists to prevent: a connection that died and a session nobody started look identical, so the author has no way to know whether to retry. An attach failure records its reason and reports it once.

Two further states must be _visible_ rather than inferred, because in both of them the editor stops responding the way it normally does:

- **A freeze** — a peer holding the document while editing source — carries a persistent indicator saying so, and saying explicitly that it is not an error. A three-second grey line is how a freeze became indistinguishable from a bug.
- **Read-only** carries a banner, not a silent refusal of every edit.

**Presence that has ended must stop being published.** A client's in-buffer text cursor lives in the awareness `selection` field, written only while a code view is bound; unbinding clears it. Left set, the field describes a person who is no longer there — every peer still in the code view keeps drawing that caret and name flag at the position it was abandoned at, for the rest of the session, and no event ever arrives to correct it. A stale cursor is worse than an absent one: it is a claim about where a collaborator is working, and it is false.

**Undo is scoped to your own edits and says so.** The scoping was always correct and entirely unstated, which is worse than not scoping it: an author who does not know it cannot predict what :kbd[⌘Z] will do, and the guess that it might take back a collaborator's work is the one that stops people using undo at all.

`project.json` is **excluded from replication.** No session is attached to a tab whose `documentPath` is `project.json`, and therefore no history delegate is registered over it. Its edits arrive from surfaces that are not the canvas, and its value configures the local editor's formats, extensions, schemas and style cascade — so a shared configuration document would let a peer's edit reconfigure another author's editor mid-keystroke, and would let the source-canonical freeze pause configuration edits that contain no text at all. A collaborator therefore does not see configuration changes live; they arrive with the file.

## 5. Version Skew

> **Status: Partial.** Wire-envelope skew is handled; document-format skew is still out of scope.

Two different things can be out of step, and conflating them hid the tractable one.

**Document-format skew** — a breaking change to the Jx document schema across a room's lifetime — is out of scope for this draft and tracked separately (see spec §3.2 on `$schema`).

**Wire-envelope skew is closed.** Two clients running different envelope versions disagree about merge granularity (§3.1), and the subprotocol negotiation in §2.1 is what keeps them out of the same room: an incompatible peer is turned away on the handshake, or — when the client can tell from the probe — never opens a socket at all, so the author is told why instead of watching a session fail silently. The failure mode this replaces was the worst kind: everything appeared to work, and the document diverged.

## 6. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). Yjs and `y-protocols` are libraries rather than published standards, so the encodings they define are described in §2 rather than cited here.

| Standard                                           | Class        | Binds    | Evidence                                                                                                                                           | Note                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455) | **Adopted**  | §2, §2.1 | packages/collab/src/negotiate.ts, packages/server/src/collab.ts, packages/collab/tests/negotiate.test.ts, packages/server/tests/collab-api.test.ts | The transport is used as specified, and subprotocol negotiation (§1.9, §4.2.2) now runs: the client offers `jx.collab.v1`, the server echoes it, and an offer the server cannot satisfy is refused rather than upgraded unversioned. A server advertising no protocols is offered none, because §4.1 fails a connection whose offer went unechoed. |
| [RFC 7692](https://www.rfc-editor.org/rfc/rfc7692) | **Rejected** | §2       | —                                                                                                                                                  | because: lib0-encoded Yjs updates are near-incompressible, the dominant frame volume is awareness cursors whose payload is smaller than a deflate block header, both transports are loopback or already compressed at the edge, and Bun allocates a zlib context per socket — a real cost for a server whose purpose is many concurrent sockets.   |

## Changelog

- **0.2.5-draft** (2026-08-20) — Presence that has ended must stop being published: a client leaving the code view clears its in-buffer text cursor, so peers stop drawing a caret for someone who is no longer there.
- **0.2.4-draft** (2026-08-16) — §2.1 subprotocol negotiation: jx.collab.v1 offered from the capability probe and echoed on the handshake; §5 wire-envelope skew closed; RFC 7692 non-adoption stated in §2.
- **0.2.3-draft** (2026-08-15) — Add §6 Standards Alignment; §5 separates wire-envelope skew from document-format skew and is marked Pending.
- **0.2.2-draft** (2026-08-05) — §4 project.json is excluded from replication, and why.
- **0.2.1-draft** (2026-08-04) — §4 the four session states, with failed distinguished from detached; freeze and read-only made visible; undo scoping stated in the UI.
- **0.2.0-draft** (2026-07-28) — Store prose as Y.Text and style/attributes/$props as nested Y.Maps so concurrent edits merge per character and per property; the op bridge diffs whole-value ops onto that structure.
- **0.1.1-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.0-draft** (2026-07-22) — Reconcile spec with shipped behavior; document the eval surface (`c8d1d580`).

---

_Jx `@jxsuite/collab` Specification v0.2.5-draft — a stub, subject to expansion._
