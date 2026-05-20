# Jx Studio: Architecture Refactor Spec

**Status:** In Progress
**Scope:** `packages/studio/src/`
**Goal:** Eliminate cross-panel failure propagation, make state changes auditable, and isolate rendering side effects — without changing user-visible behavior or rewriting working subsystems.

## Implementation Status

| Phase                      | Status         | Notes                                              |
| -------------------------- | -------------- | -------------------------------------------------- |
| 1. Error Boundaries        | ✅ Complete    | All renderers wrapped in try/catch with retry      |
| 2. Doc/Session Split       | ✅ Complete    | updateSession/updateUi in use, no ad-hoc mutations |
| 3. Lift Transient State    | ✅ Complete    | All mutable view state in view.js                  |
| 4. Componentize Panels     | ✅ Complete    | studio.js: 714 lines (88.5% reduction)             |
| 5. Lit Host Hygiene        | ✅ Complete    | Single-writer hosts, no defensive catch/replace    |
| 6. Async as State          | ✅ Complete    | Canvas state machine, pendingInlineEdit in session |
| 7. Selective Subscriptions | ⬜ Not Started |                                                    |

### Phase 4 Detailed Status

**Container panels** (mount/render/unmount orchestrators):

- ✅ toolbar
- ✅ overlays
- ✅ right-panel
- ✅ statusbar
- ✅ activity-bar
- ✅ left-panel

**Sub-panels** (pure render functions returning TemplateResult):

- ✅ layers-panel
- ✅ stylebook-layers-panel
- ✅ elements-panel
- ✅ imports-panel
- ✅ signals-panel
- ✅ data-explorer-panel
- ✅ head-panel
- ✅ git-panel
- ✅ files (file-ops, file-tree)
- ✅ events-panel
- ✅ style-panel (style-utils, style-inputs)
- ✅ properties-panel (~760 lines extracted from studio.js)
- ✅ stylebook-panel (~680 lines extracted from studio.js)
- ✅ dnd (registerLayersDnD, registerComponentsDnD, registerElementsDnD, applyDropInstruction)
- ✅ editors (renderFunctionEditor, registerFunctionCompletions)
- ✅ block-action-bar (renderBlockActionBar, dismissLinkPopover, inline formatting)
- ✅ edit-display (prepareForEditMode, restoreTemplateExpressions, templateToEditDisplay)
- ✅ component-inline-edit (enterComponentInlineEdit, slash menu delegation)
- ✅ content-inline-edit (enterInlineEdit, rich-text editing bridge for edit/content mode)
- ✅ canvas-utils (canvasPanelTemplate, centerCanvas, applyTransform, fitToScreen, renderZoomIndicator, updateActivePanelHeaders)
- ✅ preview-render (renderCanvasNode — structural preview fallback)
- ✅ pseudo-preview (updateForcedPseudoPreview — pseudo-state CSS injection)
- ✅ canvas-dnd (registerPanelDnD, showCanvasDropIndicator, getCanvasDropInstruction)
- ✅ panel-events (registerPanelEvents — click/dblclick/contextmenu/mousemove/insertion helper)
- ✅ canvas-live-render (renderCanvasLive — async runtime rendering pipeline)
- ✅ canvas (all canvas rendering/interaction concerns extracted)

**studio.js line count:** ~714 (down from ~6,226 at start of Phase 4)

---

## Background: The Core Problem

The architecture works for most cases but exhibits several recurring failure modes rooted in **implicit global coupling through a mutable singleton**:

1. **Cross-panel failure propagation.** An error in one renderer (most commonly the canvas) can destroy unrelated UI because renderers run in sequence without isolation.

2. **Dual state-mutation paths.** The explicit `update()` dispatcher coexists with ad-hoc `S = { ...S, ui: { ... } }` mutations. The second path bypasses middleware, post-render hooks, and selective re-rendering. _(Fixed in Phase 2.)_

3. **Shared mutable substrate.** Renderers read and write module-scoped globals (`canvasPanels`, `elToPath`, `panzoomWrap`, `componentInlineEdit`, etc.) making them non-independent even though they're registered separately. _(Fixed in Phase 3.)_

4. **Async inside renderers.** `renderCanvasLive` is async; the rest of the system dances around it with `pendingInlineEdit` flags and `requestAnimationFrame` coordination, creating race conditions.

5. **Manual cleanup.** Parallel arrays of cleanup functions (`dndCleanups`, `canvasDndCleanups`, `canvasEventCleanups`, etc.) are easy to leak.

6. **Lit marker corruption.** Persistent Lit render hosts get their internal markers corrupted by adjacent code touching DOM Lit owns.

## Non-Goals

- **No CRDT adoption.** Revisit only if multiplayer becomes a concrete roadmap item.
- **No framework change.** Lit-html and vanilla JS stay.
- **No rewrite of `state.js`.** Its immutable mutator API is the strongest part of the codebase.
- **No change to file format, runtime, PAL, or metadata-driven inspector.**
- **No user-visible behavior change** unless explicitly noted.

## Guiding Principles

1. Each step ships independently and is reversible.
2. Persistent app state and ephemeral session state get different update paths.
3. Renderers are pure functions of state. Side effects live in components.
4. Components are isolation boundaries. A failure inside one cannot corrupt another.
5. Async is a state, not a procedure. Renderers run synchronously; async work produces state updates on completion.

---

## Phase 1: Error Boundaries Around Renderers ✅

**Effort:** ~1 hour | **Status:** Complete

In `store.js`, each registered renderer call is wrapped in `try/catch`. Failed renderers log to console but don't cascade to other panels. Panels also have internal retry logic (clear Lit state and re-render on corruption).

---

## Phase 2: Split `S` into `doc` and `session` ✅

**Effort:** 1–2 days | **Status:** Complete

State split into document state (goes in undo history, triggers autosave) and session state (selection, hover, UI preferences — never persisted, cheap to mutate). Two dispatchers: `update()` for document changes, `updateSession()` for session changes. All ad-hoc `S = { ...S, ui: ... }` mutations replaced with `updateSession`/`updateUi`.

---

## Phase 3: Lift Transient View State ✅

**Effort:** 1–2 days | **Status:** Complete

All mutable view state (`panzoomWrap`, `panX`, `panY`, `liveScope`, `stylebookElToTag`, `dndCleanups`, etc.) moved to `view.js`. Functions access it through the exported `view` object rather than module-scoped `let`s. Cross-module reads happen through exported accessors.

---

## Phase 4: Componentize the Panels 🔄

**Effort:** 3–5 days | **Status:** ~75% complete

Each major UI region becomes a self-contained module with `mount`/`render`/`unmount`. Sub-panels export pure render functions that receive dependencies as arguments and return `TemplateResult`.

### Pattern: Container Panel (orchestrator)

```js
export function mount(ctx) {
  _ctx = ctx;
  _unsub = subscribe(onChange);
}
export function unmount() {
  _unsub?.();
  _ctx = null;
}
export function render() {
  ensureLitState(root);
  litRender(template(), root);
}
```

### Pattern: Sub-panel (pure render function)

```js
export function renderFooTemplate(ctx) {
  const S = getState();
  // ... return html`...`;
}
```

### Extraction History

| Extraction                                                           | Lines Removed from studio.js | Date       |
| -------------------------------------------------------------------- | ---------------------------- | ---------- |
| Container panels (toolbar, overlays, etc.)                           | ~800                         | Phase 4a–c |
| properties-panel.js                                                  | ~1,300                       | Phase 4d   |
| stylebook-panel.js                                                   | ~1,005                       | Phase 4e   |
| dnd.js (+ shared.js defaultDef)                                      | ~430                         | Phase 4f   |
| editors.js (function editor + completions)                           | ~200                         | Phase 4g   |
| block-action-bar.js (action bar + inline formatting)                 | ~395                         | Phase 4h   |
| edit-display.js (edit-mode document transforms)                      | ~190                         | Phase 4i   |
| component-inline-edit.js (design-mode text editing)                  | ~295                         | Phase 4j   |
| content-inline-edit.js (rich-text editing bridge)                    | ~187                         | Phase 4k   |
| canvas-utils.js (panzoom, zoom indicator, panel template)            | ~273                         | Phase 4l   |
| preview-render.js, pseudo-preview.js, canvas-dnd.js, panel-events.js | ~503                         | Phase 4m   |
| canvas-helpers.js (shared canvas query/utility functions)            | ~105                         | Phase 4n   |
| canvas-render.js (multi-mode canvas rendering orchestrator)          | ~350                         | Phase 4o   |
| canvas-live-render.js (async runtime rendering pipeline)             | ~269                         | Phase 4p   |

### Remaining: Canvas Module

The canvas is the largest remaining block (~2,500+ lines) and the most complex — it owns panzoom, inline editing, mode switching (design/edit/content/preview/source/manage/settings dispatch), overlays, DnD, and the runtime rendering pipeline. Extracting it requires careful handling of:

- `applyTransform`, `observeCenterUntilStable`, `canvasPanelTemplate`, `overlayBoxDescriptor` — canvas infrastructure already passed as ctx to stylebook-panel
- `renderCanvasLive` — async, tightly coupled to inline editing
- Mode dispatchers — settings mode already extracted; source/manage modes are self-contained blocks
- DnD registration — `registerPanelDnD`, `registerLayersDnD`, `registerElementsDnD`, `registerComponentsDnD`

Suggested sub-extraction order:

1. Source mode (Monaco editor block)
2. Manage mode (file browser)
3. DnD registration functions
4. Canvas infrastructure (panzoom, panels, overlays)
5. Inline editing
6. Design/Edit/Content rendering (the core)

---

## Phase 5: Lit-html Host Hygiene ✅

**Effort:** Half a day after Phase 4 | **Status:** Complete

After Phase 4, persistent floating UI (`blockActionBarEl`, `linkPopoverHost`, `zoomIndicatorHost`) is owned by its respective module. Rules enforced:

1. Each persistent Lit host has exactly one writer. (`dismissBlockActionBar()` export replaces direct litRender from canvas-render.js.)
2. Forced-pseudo `<style>` injection uses a dedicated container in pseudo-preview.js (not `document.head`).
3. `contentEditable` toggling only affects runtime-rendered DOM (never Lit-owned DOM) — verified, no change needed.

Deleted the `try/catch/replaceWith` defensive code in `renderZoomIndicator` and `resetZoomIndicator`.

---

## Phase 6: Async as State ✅

**Effort:** 2–3 days | **Status:** Complete

Canvas async state is now a first-class part of session state:

```js
// session.canvas
{
  status: ("idle" | "loading" | "ready" | "error", scope, error);
}
// session.ui.pendingInlineEdit
null | { path, mediaName };
```

**Changes made:**

- `view.liveScope` → `session.canvas.scope` (updated via `updateCanvas()`)
- `view.pendingInlineEdit` → `session.ui.pendingInlineEdit` (set via `updateUi()`, consumed in session update handler)
- Duplicate processing consolidated: old post-render hook in studio.js + `.then()` in canvas-render.js → single processing point in session update handler when canvas becomes "ready"
- `left-panel.js` reads scope from `S.canvas?.scope` instead of `view.liveScope`
- Session update handler re-renders left panel on canvas state changes (for data-explorer)

---

## Phase 7 (Optional): Selective Subscriptions

**Effort:** 1–2 days | **Status:** Not started

Each panel declares which state slices it depends on. The dispatcher only notifies panels with relevant changes. Performance optimization — do it only if measurement shows it's needed.

---

## What Each Phase Delivers

| Phase                      | Lands                             | User-visible? | Reversible?              |
| -------------------------- | --------------------------------- | ------------- | ------------------------ |
| 1. Error boundaries        | Crash isolation between renderers | No            | Trivially                |
| 2. Doc/session split       | Routed state changes, no bypasses | No            | With effort              |
| 3. View state in objects   | No module-global view state       | No            | With effort              |
| 4. Componentize panels     | True isolation between panels     | No            | Each panel independently |
| 5. Lit host hygiene        | No marker corruption workarounds  | No            | Trivially                |
| 6. Async as state          | No race conditions on inline edit | No            | With effort              |
| 7. Selective subscriptions | Fewer wasted re-renders           | Maybe (perf)  | Trivially                |

## Recommended Order

Phases 1, 2, 3 are independent (all complete). Phase 4 benefits from Phase 3 (less to move). Phase 5 requires Phase 4. Phase 6 benefits from Phase 4. Phase 7 requires Phases 2 and 4.

**Sequence:** 1 → 2 → 3 → 4 → 5 → 6 → (7 if needed).

## What Not to Change

- **`state.js` mutator API.** Clean, immutable, well-factored. Foundation everything builds on.
- **Lit-html itself.** Right tool; problems are caused by code reaching around it.
- **Platform Abstraction Layer.** Clean boundary.
- **Metadata-driven inspector** (`css-meta`, `html-meta`, `stylebook-meta`). Sophisticated and correct.
- **File/panel split into separate modules.** Trajectory is good; just finish it.

## Out of Scope / Future Work

- **Multi-window / multi-tab editing.** Would motivate a real CRDT.
- **Plugin/extension API.** Same.
- **Web component refactor of panels.** Natural next step after Phase 4; turns each panel module into a real Lit element with shadow DOM. Defer unless style isolation or embeddability is needed.
- **Performance work on document mutators.** `structuredClone` on every edit is fine; revisit if profiling shows bottleneck on large documents.

## Open Questions

1. **Should `documentStack` live in doc or session?** Recommendation: session. Reload restores the file, not the navigation stack.
2. **Should `dirty` live in doc or session?** Recommendation: doc, because autosave middleware needs it.
3. **Should `history` survive document close?** Currently it doesn't. Keep that unless there's demand otherwise.
4. **Shared render scheduler?** Probably yes after Phase 4, but only if measurement shows multiple renders per frame. Phase 7 territory.
