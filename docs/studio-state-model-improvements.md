# Studio State Model — Scale Improvements

**Status:** Filed (not started)
**Date:** 2026-06-22
**Owner:** Gideon
**Priority:** Medium — not blocking the cloner (≤3k-node pages work fine today), but needed before
large-page editing becomes a real use case.
**Branch:** TBD (separate from `feat/ai-assistant-stack-b`)

---

## 1. Problem

Every `transactDoc` mutation deep-clones the entire document via `jsonClone` (= `JSON.parse(JSON.stringify)`)
to push a history snapshot. `undo` does a full `structuredClone`. Measured on real captured pages:

| Document size                      | `jsonClone` per mutation | `structuredClone` per undo | History @ 100 snapshots |
| ---------------------------------- | ------------------------ | -------------------------- | ----------------------- |
| ~2.5k nodes (typical landing page) | ~9 ms                    | ~10 ms                     | ~30 MB                  |
| ~20k nodes (worst-case Wikipedia)  | **73 ms**                | **79 ms**                  | **~230 MB**             |

The layers panel (`renderLayersTemplate`) also re-flattens the whole tree into lit-html rows every
rerender — at 20k nodes that's ~35k rows when fully expanded.

At ≤3k nodes everything is imperceptible. At 20k nodes, 73 ms per keystroke is visible jank and
230 MB of retained clones pressures memory. The cloner's `--max-nodes-per-page` cap (default ~5k)
keeps imported sites in the safe zone, but these are worth fixing independently.

---

## 2. Two improvements (either alone removes the worst-case jank)

### 2.1 Structural-sharing history

**What:** Instead of `jsonClone(entireDoc)` on every mutation, snapshot only the mutated path.
The in-place mutation already shares untouched subtrees (the shallow spread `{ ...raw }` is ~0 ms).

**How:** `transactDoc` already knows the mutation path (callers like `mutateSetProperty`,
`mutateAddChild` operate on a specific `JxPath`). Record a `{ path, before, after }` delta instead
of a full clone. `undo` replays the inverse delta; `redo` replays the forward delta.

**Files:** `packages/studio/src/tabs/transact.ts` (the `jsonClone` + history push), all callers
that pass mutation functions.

**Risk:** Medium — the current model is dead simple (full clone = always correct). Structural
sharing requires every mutation path to be captured accurately. The existing test suite
(`transact.test.ts`, `ai-loop.test.js`) covers the mutation surface.

**Expected gain:** ~0 ms per mutation (from 73 ms), history memory proportional to _changed_ nodes
not total tree size.

### 2.2 Virtualized layers panel

**What:** Render only visible rows in the layers panel instead of the full flattened tree.

**How:** The `flattenTree` → `for (const { node, path, depth } of rows)` loop in
`renderLayersTemplate` (`packages/studio/src/panels/layers-panel.ts:112`) already produces an array
with known heights (fixed row height). Replace the lit-html loop with a virtual-scroll container
that renders only the viewport slice (~30–50 rows) plus a small overscan buffer.

**Files:** `packages/studio/src/panels/layers-panel.ts`.

**Risk:** Low — the collapse/expand logic already works on the flat array; virtualization just
changes which slice gets templated. Drag-and-drop (Pragmatic DnD) needs the drop indicators to
work within the virtual viewport, but the library supports this.

**Expected gain:** Layers rerender goes from O(n) rows to O(viewport) regardless of document size.

### 2.3 Quick win — collapse-by-default for large imports

**What:** When opening an imported page with >N nodes (e.g., 1,000), auto-collapse all layers
below depth 2 on first load.

**Files:** `packages/studio/src/panels/layers-panel.ts` (the `_layersCollapsed` Set initialization).

**Risk:** Minimal — existing collapse machinery, just a different initial state.

---

## 3. Recommendation

Ship **2.3** (quick win) alongside the cloner in Phase 0 — it's a few lines and immediately
improves the experience for any imported page.

Tackle **2.1** or **2.2** when large-page editing becomes a real requirement. Either alone is
sufficient; 2.2 is lower-risk, 2.1 has higher payoff.
