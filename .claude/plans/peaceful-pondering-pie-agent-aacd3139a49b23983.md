# Migration Plan: Jx Studio Legacy State to @vue/reactivity

## Summary

Remove the old `createState()`/`S`/`update()`/`render()`/`registerRenderer()` system from studio.js and store.js. All state reads go through `activeTab.value.doc.*` / `activeTab.value.session.*`. All mutations go through direct reactive assignment (session) or `transactDoc()` (document). All rendering is driven by `effect()` auto-tracking.

---

## Phase 0: Bridge Fix (Unblock Canvas Immediately)

**Goal:** Canvas renders again using the reactive tab data WITHOUT removing old code yet.

**What:**

- In `canvas-render.js`, change `renderCanvas()` to read from `activeTab.value` instead of `_ctx.getState()`:
  ```js
  const tab = activeTab.value;
  if (!tab) return;
  const doc = tab.doc.document;
  const ui = tab.session.ui;
  const canvas = tab.session.canvas;
  ```
- Add a canvas render `effect()` in studio.js (or a new `canvas/canvas-effect.js`) that watches `activeTab.value?.doc.document` and `activeTab.value?.session.ui` and calls `renderCanvas()` when they change.
- Keep `_ctx.getState()` wiring in place as fallback (dead path) — removal happens later.

**Files touched:** `canvas/canvas-render.js`, `studio.js` (add effect)

**Verification:** Open a file via tab → canvas shows the document.

---

## Phase 1: Convert Canvas Helpers to Reactive Reads

**Goal:** `canvas-utils.js` and `canvas-helpers.js` stop importing `getState` from store.

**What:**

- `effectiveZoom()` → read `activeTab.value.session.ui.zoom`
- `getActivePanel()` → read `activeTab.value.session.ui.activeMedia`
- `canvas-utils.js` functions that call `getState()` → accept tab as param or read `activeTab.value`

**Files touched:** `canvas/canvas-utils.js`, `canvas/canvas-helpers.js`

---

## Phase 2: Convert Panel Renderers to Effects

Each panel already has a `render()` function. Wrap each in an `effect()` within an `effectScope()`, reading reactive deps directly from `activeTab.value`. Follow the toolbar.js pattern.

**Order (by dependency/complexity):**

1. `panels/block-action-bar.js` (7 getState calls — high value)
2. `panels/properties-panel.js` (5 calls)
3. `panels/style-panel.js` (6 calls)
4. `panels/layers-panel.js` (3 calls)
5. `panels/elements-panel.js` (3 calls)
6. `panels/editors.js` (4 calls)
7. `panels/panel-events.js` (5 calls — event handlers, not render)
8. `panels/dnd.js` (2 calls)
9. `panels/style-inputs.js` (1 call)
10. `panels/stylebook-panel.js` (2 calls)
11. `panels/events-panel.js`
12. `panels/signals-panel.js`
13. `panels/activity-bar.js`

**Pattern for each:**

```js
// Before:
export function render() {
  const S = getState();
  litRender(template(S), rootEl);
}

// After:
export function mount(rootEl, ctx) {
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (!tab) return;
      // read what you need (auto-tracks)
      litRender(template(tab), rootEl);
    });
  });
}
```

**For event-handler modules (panel-events, dnd):** These don't render — they read state to make decisions. Replace `getState()` calls with `activeTab.value` reads inline. Since they run in response to user events (not effects), just read the ref at call time.

---

## Phase 3: Convert Editor Modules

**Files:** `editor/shortcuts.js`, `editor/component-inline-edit.js`, `editor/content-inline-edit.js`, `editor/context-menu.js`, `editor/convert-to-component.js`, `editor/insertion-helper.js`

**Pattern:** These are imperative (respond to user actions). Replace:

- `getState()` → `activeTab.value.doc.document` / `activeTab.value.session.*`
- `update(S)` (after doc mutation) → `transactDoc(activeTab.value, (t) => { /* mutate t.doc.document */ })`
- `updateSession({ selection: x })` → `activeTab.value.session.selection = x`

**Undo/redo:** Already handled by `transactDoc` → `tab.history`. The shortcuts module calls `undo(activeTab.value)` / `redo(activeTab.value)` from `tabs/transact.js`.

---

## Phase 4: Replace Middleware with Effects

**Autosave:**

```js
// In studio.js or a new autosave.js:
effect(() => {
  const tab = activeTab.value;
  if (!tab?.doc.dirty || !tab.fileHandle) return;
  // schedule debounced save
});
```

**Post-render hooks (pseudo-preview):**

```js
effect(() => {
  const tab = activeTab.value;
  if (!tab) return;
  void tab.doc.document; // track doc changes
  void tab.session.selection;
  updateForcedPseudoPreview();
});
```

**Pending inline edit (canvas ready → trigger edit):**

```js
effect(() => {
  const tab = activeTab.value;
  if (!tab) return;
  if (tab.session.canvas.status === "ready" && tab.session.ui.pendingInlineEdit) {
    // trigger inline edit, then clear pendingInlineEdit
  }
});
```

---

## Phase 5: Remove `_update` / `_updateSession` Bridge in studio.js

**What:**

- Delete `setUpdateFn(...)` call and the `_update` function body in studio.js
- Delete `setUpdateSessionFn(...)` call and the `_updateSession` function body
- Delete `setGetStateFn`, `setGetDocFn`, `setGetSessionFn` calls
- Delete local `S`, `doc`, `session` variables
- Delete `fromFlat`/`toFlat` usage

**Prerequisite:** All consumers of `getState()`, `update()`, `updateSession()`, `updateUi()`, `updateCanvas()` have been converted in Phases 0–4.

---

## Phase 6: Clean Up store.js

**Remove exports:**

- `getState`, `setGetStateFn`, `update`, `setUpdateFn`
- `updateSession`, `setUpdateSessionFn`, `updateUi`, `updateCanvas`
- `getDoc`, `setGetDocFn`, `getSession`, `setGetSessionFn`
- `render`, `renderOnly`, `registerRenderer`
- `addUpdateMiddleware`, `runUpdateMiddleware`
- `addPostRenderHook`, `runPostRenderHooks`
- `createState`, `toFlat`, `fromFlat` (re-exports from state.js)

**Keep exports:**

- DOM refs (`canvasWrap`, `leftPanel`, `rightPanel`, `toolbarEl`, `statusbarEl`, `activityBar`)
- `$`, `_$$` query helpers
- `canvasPanels`, `elToPath`
- Constants (`VOID_ELEMENTS`, `COMMON_SELECTORS`, `isNestedSelector`)
- Utilities (`stripEventHandlers`, `debouncedStyleCommit`, `cancelStyleDebounce`)
- Tree utilities re-exported from state.js (`selectNode`, `hoverNode`, `getNodeAtPath`, `flattenTree`, `nodeLabel`, `pathKey`, `pathsEqual`, `parentElementPath`, `childIndex`, `isAncestor`, `projectState`, `setProjectState`, `updateFrontmatter`, `pushDocument`, `popDocument`)

**Remove from state.js:**

- `createState`, `toFlat`, `fromFlat`

---

## Phase 7: Move `canvasMode` Into Reactive State

`canvasMode` is currently a local mutable string in studio.js passed via ctx closures. Move it to `workspace.ui.canvasMode` (workspace-level, since it applies regardless of active tab). This collapses the `getCanvasMode`/`setCanvasMode` ctx-passing pattern.

---

## Key Conversion Patterns

### Reading state (before → after)

```
getState().document       → activeTab.value.doc.document
getState().selection      → activeTab.value.session.selection
getState().ui.zoom        → activeTab.value.session.ui.zoom
getState().canvas.status  → activeTab.value.session.canvas.status
getState().dirty          → activeTab.value.doc.dirty
getState().documentPath   → activeTab.value.documentPath
getState().mode           → activeTab.value.doc.mode
```

### Mutating document (before → after)

```js
// Before:
S.document.children[0].tagName = "span";
update(S);

// After:
transactDoc(activeTab.value, (t) => {
  t.doc.document.children[0].tagName = "span";
});
```

### Mutating session (before → after)

```js
// Before:
updateSession({ selection: newPath });
updateUi("zoom", 2);
updateCanvas({ status: "ready" });

// After:
activeTab.value.session.selection = newPath;
activeTab.value.session.ui.zoom = 2;
activeTab.value.session.canvas.status = "ready";
```

### Triggering re-render (before → after)

```
// Before: explicit render() / renderOnly("canvas", "overlays")
// After: automatic — effects re-run when their tracked dependencies change
```

---

## Risk Mitigation

1. **Each phase is independently shippable** — the bridge in `_update`/`_updateSession` syncs reactive→flat, so old consumers still work while new ones are converted.
2. **Test after each file conversion** — open file, select element, edit property, undo, switch tabs.
3. **canvas-live-render.js** receives `doc` as a parameter from `renderCanvas()` — no state import to change, just pass `activeTab.value.doc.document` from the caller.
4. **`canvasPanels` array** stays as-is — it's a shared mutable container populated during render, not state.
5. **The toolbar.js pattern is proven** — it still uses `getState()` inside its template for convenience during migration. Modules can read from `activeTab.value` AND still call `getState()` as a fallback while both systems exist. Phase 5 removal enforces full cutover.
6. **Effect batching** — Vue's reactivity batches synchronous effect re-runs within a microtask. Multiple mutations in one synchronous block only trigger one effect re-run per effect.
