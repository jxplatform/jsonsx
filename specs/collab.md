# `@jxsuite/collab` Specification

## Real-Time Co-Editing for Jx Projects

**Version:** 0.1.0-draft
**Status:** Partial
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

These invariants are implemented in `packages/collab/src` (`envelope.ts`, `schema.ts`,
`provider.ts`); this section records them so a future change cannot quietly break them.

## 4. Enablement & Degradation

Collab is a capability the platform may or may not expose. When disabled, `/__studio/collab` answers
the probe negatively and the editor runs single-player. Enablement state and the seeding handshake
are part of the session lifecycle; a full state machine will be documented here as it settles.

## 5. Version Skew

There is currently **no cross-version migration story** for the document format a room carries; a
breaking change to the Jx document schema across a room's lifetime is out of scope for this draft and
tracked separately (see spec §3.2 on `$schema`).

---

_Jx `@jxsuite/collab` Specification v0.1.0-draft — a stub, subject to expansion._
