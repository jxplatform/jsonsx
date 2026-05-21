# Plan: Remove `getState()` Callers and Legacy Flat `S` State

## Executive Summary

This migration can be done **incrementally, file-by-file**, because `getState()` already synthesizes its return value from `activeTab.value`. Each caller can be rewritten to read directly from `activeTab.value` without affecting other callers. The final step removes the scaffolding (`getState`, `setGetStateFn`, flat `S`, `_update`, `_updateSession`) from store.js and studio.js.

---

## Phase 1: Simple Read-Only Callers (Low Risk, Parallel)

These files only call `getState()` to read fields. They never write back via `setState()`. Each can be migrated independently by replacing `getState()` with direct `activeTab.value` reads.

### Pattern

Replace:

```javascript
import { getState } from "../store.js";
// ...
const S = getState();
const doc = S.document;
```

With:

```javascript
import { activeTab } from "../workspace/workspace.js";
// ...
const tab = activeTab.value;
const doc = tab.doc.document;
```

Add an early return / guard: `if (!tab) return;` (or return `nothing` for lit templates).

### Files (in suggested order)

#### 1a. `panels/preview-render.js` (lines 35, 51)

- Reads: `getState().document.state`
- Replace with: `activeTab.value.doc.document.state`
- Trivial — pure rendering helper, no writes.

#### 1b. `panels/stylebook-layers-panel.js` (line 21)

- Reads: `S.document.style`, `S.ui.stylebookSelection`, `S.ui.stylebookTab`
- Replace with: `activeTab.value.doc.document.style`, `activeTab.value.session.ui.stylebookSelection`, etc.

#### 1c. `panels/pseudo-preview.js` (line 24)

- Reads: `S.ui.activeSelector`, `S.selection`, `S.document`
- Replace with direct tab reads.

#### 1d. `ui/color-selector.js` (lines 24, 49)

- Reads: `S.document.style`
- Replace with: `activeTab.value?.doc.document.style`
- Note: called inside LitElement methods — use `activeTab.value?.` with optional chaining.

#### 1e. `panels/style-utils.js` (lines 162, 184)

- `getFontVars()`: reads `S.document.style`
- `currentFontFamily()`: reads `S.selection`, `S.document`
- Replace both with activeTab reads.

#### 1f. `panels/style-inputs.js` (line 56)

- Reads: `S.document.style` (in `handleFontPresetSelection`)
- Replace with: `activeTab.value.doc.document.style`

#### 1g. `editor/component-inline-edit.js` (line 51)

- Reads: `S.document` via `getNodeAtPath(S.document, path)`
- Replace with: `getNodeAtPath(activeTab.value.doc.document, path)`

#### 1h. `editor/content-inline-edit.js` (line 47)

- Same pattern as above — reads `S.document` for `getNodeAtPath`.

#### 1i. `panels/canvas-dnd.js` (line 75)

- Reads: `S.document` to check node structure for drop targets.
- Replace with: `activeTab.value.doc.document`

#### 1j. `panels/dnd.js` (lines 254, 306)

- `applyDropInstruction`: reads `S.document` for `getNodeAtPath`
- Replace with direct tab read.

#### 1k. `panels/editors.js` (lines 17, 28, 126, 160)

- `getFunctionBody()`: reads `S.document.state`, `S.document` via getNodeAtPath
- `renderFunctionEditor()`: reads `S.ui.editingFunction`
- Replace all with activeTab reads.

#### 1l. `panels/stylebook-panel.js` (line 52)

- Reads: `S.ui.settingsTab`, `S.document.style`, `S.document.$media`, `S.ui.stylebookFilter`, `S.ui.stylebookCustomizedOnly`
- Replace with activeTab reads.

---

## Phase 2: Layers Panel and Elements Panel (Medium Risk)

#### 2a. `panels/layers-panel.js` (lines 29, 147, 210)

- Line 29: `const S = getState()` — reads `S.document`, `S.selection`, `S.mode`
- Line 147: `showContextMenu(e, path, getState(), ...)` — passes full S to context menu
- Line 210: `getNodeAtPath(getState().document, prevPath)` — reads document in click handler

**Strategy:**

- Line 29: Replace with `const tab = activeTab.value; const doc = tab.doc.document; const selection = tab.session.selection;`
- Line 147: The context menu function accepts `S` — we need to check if `showContextMenu` uses the full flat shape or can accept a partial. It reads `S.document`, `S.selection`, `S.clipboard`. Pass a synthesized object: `{ document: tab.doc.document, selection: tab.session.selection, clipboard: tab.session.clipboard }` — or refactor `showContextMenu` to accept individual args.
- Line 210: Simple — `getNodeAtPath(activeTab.value.doc.document, prevPath)`

#### 2b. `panels/elements-panel.js` (lines 16, 41, 108)

- Line 16: reads `S` for template rendering
- Line 41: `getState()` in click handler — reads `s.selection`, `s.document`
- Replace with activeTab reads.

---

## Phase 3: Panel Events (High Complexity)

`panels/panel-events.js` is the most complex caller — it uses both `_ctx.getState()` and `_ctx.setState()`.

### Current Usage Analysis

1. **Click handler (line 80)**: `const S = _ctx.getState()` — reads `S.document`, `S.ui`, `S.selection`, `S.mode`
   - Then: `_ctx.setState(withMedia)` — writes `{ ...S, ui: { ...S.ui, activeMedia: newMedia } }`

2. **Dblclick handler (line 151)**: reads `S.document`

3. **Contextmenu (line 190)**: reads `S.document`, passes S to `showContextMenu`

4. **Mousemove (line 223)**: reads `S.document`, `S.hover`, then calls `_ctx.setState(hoverNode(S, path))`

5. **Mouseleave (line 245)**: reads `S.hover`, calls `_ctx.setState(hoverNode(S, null))`

6. **Insertion helper mount (line 254)**: passes `getState` to insertion-helper.

### Migration Strategy

**Reads** — All `_ctx.getState()` reads map directly to `activeTab.value`:

- `S.document` → `activeTab.value.doc.document`
- `S.ui` → `activeTab.value.session.ui`
- `S.selection` → `activeTab.value.session.selection`
- `S.mode` → `activeTab.value.doc.mode`
- `S.hover` → `activeTab.value.session.hover`

**Writes** — The `_ctx.setState(newS)` calls need case-by-case replacement:

| Current Pattern                                                   | Replacement                                         |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| `_ctx.setState({ ...S, ui: { ...S.ui, activeMedia: newMedia } })` | `activeTab.value.session.ui.activeMedia = newMedia` |
| `_ctx.setState(hoverNode(S, path))`                               | `activeTab.value.session.hover = path`              |
| `_ctx.setState(hoverNode(S, null))`                               | `activeTab.value.session.hover = null`              |

The `hoverNode` function just returns `{ ...state, hover: path }` — it's a pure spreader. The reactive system already picks up direct writes to `tab.session.hover`.

**Insertion helper**: Currently receives `getState` in its context. It only reads `S.document` and `S.selection`. Change its context to pass a getter returning `activeTab.value` or just have it import `activeTab` directly.

**After migration**: Remove the `getState`/`setState` context properties from `initPanelEvents`. The ctx object shrinks to just `{ getCanvasMode, enterInlineEdit, navigateToComponent }`.

---

## Phase 4: Shortcuts (High Complexity)

`editor/shortcuts.js` receives a live `S` reference and a `setS` function via `getContext()`.

### Current Usage

- **Wheel zoom**: reads `S.ui.zoom`, calls `setS({ ...S, ui: { ...S.ui, zoom: newZoom } })`
- **Ctrl+0/+/-**: reads/writes `S.ui.zoom`
- **Ctrl+d**: reads `S.selection`
- **Ctrl+c/x/v**: passes `S` to `copyNode`/`cutNode`/`pasteNode`
- **Delete/Backspace**: reads `S.selection`
- **Enter**: reads `S.selection`
- **ArrowUp/Down/Left/Right**: reads `S.selection`, `S.document`

### Migration Strategy

**Zoom writes**: Replace `setS({ ...S, ui: { ...S.ui, zoom: newZoom } })` with:

```javascript
activeTab.value.session.ui.zoom = newZoom;
```

The zoom is already read by `initCanvasUtils` via `getZoom: () => S.ui.zoom` — that getter in studio.js also needs to change to read from `activeTab.value.session.ui.zoom`.

**Selection reads**: Replace `S.selection` with `activeTab.value.session.selection`.

**Document reads**: Replace `S.document` with `activeTab.value.doc.document`.

**Copy/Cut/Paste**: `copyNode(S)`, `cutNode(S)`, `pasteNode(S)` — these functions need to be audited. They likely read `S.selection`, `S.document`, `S.clipboard`. Refactor to accept `activeTab.value` or import `activeTab` directly.

**After migration**: The `getContext()` closure no longer needs `S` or `setS`. It shrinks to:

```javascript
initShortcuts(() => ({
  canvasMode,
  panX: view.panX,
  panY: view.panY,
  setPan: (x, y) => { ... },
  applyTransform,
  positionZoomIndicator,
  componentInlineEdit: view.componentInlineEdit,
  saveFile,
  openProject,
  enterEditOnPath(path) { ... },
}));
```

---

## Phase 5: Studio.js Internal Cleanup

After all external callers are migrated, clean up `studio.js`:

### 5a. Remove flat `S`, `doc`, `session` module-level variables

### 5b. Rewrite `navigateToComponent` and `navigateBack`

- Currently mutate `S` via `pushDocument`/`popDocument` (which return new flat state)
- Rewrite to operate on `activeTab.value` directly
- `pushDocument` / `popDocument` in state.js are pure functions that spread a new state. Replace with imperative mutations: push onto `tab.session.documentStack`, set `tab.doc.document`, etc.

### 5c. Rewrite `closeFunctionEditor`

- Reads `S.ui.editingFunction`, `S.document` — replace with activeTab reads (already partly done since it uses `transactDoc`).

### 5d. Remove `setUpdateFn` / `_update` registration

- The `_update` function syncs flat S → reactive tab. Once nothing calls `update(newState)`, remove it.
- Check: is `update()` from store.js called anywhere else? Any remaining callers must migrate to `transactDoc` or direct reactive writes.

### 5e. Remove `setUpdateSessionFn` / `_updateSession`

- `updateSession(patch)` in store.js already writes directly to the reactive tab. The `_updateSessionFn` callback maintains the shadow flat `S`. Once flat `S` is gone, the callback becomes unnecessary.
- BUT: `_updateSession` also handles `pendingInlineEdit` processing and runs `runPostRenderHooks`. These need to move to an effect or remain as post-write hooks.

### 5f. Rewrite `initCanvasUtils` zoom handling

- `getZoom: () => S.ui.zoom` → `getZoom: () => activeTab.value?.session.ui.zoom ?? 1`
- `setZoomDirect` — currently writes to both `session` local var and `activeTab`. Simplify to only write `activeTab.value.session.ui.zoom = zoom`.

### 5g. Rewrite autosave

- Currently reads `S.fileHandle`, `S.dirty`, `S.document`
- Replace with: `activeTab.value.fileHandle`, `activeTab.value.doc.dirty`, `activeTab.value.doc.document`
- The middleware pattern (`addUpdateMiddleware`) can be replaced with an effect that watches `tab.doc.dirty`.

### 5h. Handle `openProject` context

- Currently passes `S` and a `commit` function. Rewrite to have `openProject` work with `activeTab` directly.

---

## Phase 6: Store.js Cleanup

After studio.js is clean:

1. Remove `getState()` export
2. Remove `setGetStateFn()` export and `_getStateFn` variable
3. Remove `setUpdateFn()` export and `_updateFn` variable
4. Remove `update()` export
5. Remove `setUpdateSessionFn()` export
6. Simplify `updateSession()` — remove the `_updateSessionFn(patch)` call, keep only the direct reactive writes
7. Similarly simplify `updateUi()` and `updateCanvas()`
8. Remove `addUpdateMiddleware` / `runUpdateMiddleware` (replaced by effects)
9. Evaluate `addPostRenderHook` / `runPostRenderHooks` — these run after state changes. They can be replaced with effects watching the relevant reactive properties.

---

## Phase 7: State.js Cleanup

1. Remove `hoverNode()` — it's just `{ ...state, hover: path }`. After migration, callers write `tab.session.hover = path` directly.
2. Remove `toFlat()` / `fromFlat()` — no longer needed.
3. Evaluate `pushDocument` / `popDocument` — either keep as utility functions that accept a tab and mutate it, or inline their logic.

---

## Risk Mitigation

### Testing Strategy

- Run the full 1896-test suite after each phase.
- Phase 1 files are lowest risk — they only read, never write.
- Phase 3 (panel-events) and Phase 4 (shortcuts) are highest risk because they write state. Test canvas interactions (click-to-select, hover highlight, zoom, keyboard nav) manually after those phases.

### Reactive Canvas Effect

The effect in studio.js (lines 325-347) watches `activeTab.value` properties and triggers `renderCanvas()`. This will continue working correctly because:

- Direct writes to `tab.session.ui.*` and `tab.doc.document` trigger the reactive system
- The effect already reads from the reactive tab, not from flat `S`

### Post-Render Hooks

`runPostRenderHooks(prevDoc, prevSel)` currently fires after both `_update` and `_updateSession`. It drives:

- `updateForcedPseudoPreview()` — registered as a post-render hook

After migration, this needs to become an effect watching `tab.session.ui.activeSelector` and `tab.session.selection`. Or it can be called explicitly after the writes that affect it (selection changes, activeSelector changes).

### The `showContextMenu` Dependency

`showContextMenu(e, path, S, opts)` receives the full flat S object. It needs to be audited:

- If it only reads `S.document`, `S.selection`, `S.clipboard` — pass those fields explicitly or refactor to import `activeTab`.
- This is a prerequisite for Phase 2a and Phase 3.

---

## Execution Order Summary

| Phase | Files                        | Risk   | Prerequisite                           |
| ----- | ---------------------------- | ------ | -------------------------------------- |
| 1a-1l | 12 read-only callers         | Low    | None                                   |
| 2a-2b | layers-panel, elements-panel | Medium | Audit `showContextMenu`                |
| 3     | panel-events.js              | High   | Phase 1 complete (for confidence)      |
| 4     | shortcuts.js                 | High   | Audit `copyNode`/`cutNode`/`pasteNode` |
| 5     | studio.js internals          | High   | Phases 1-4 complete                    |
| 6     | store.js cleanup             | Medium | Phase 5 complete                       |
| 7     | state.js cleanup             | Low    | Phase 6 complete                       |

**Estimated total**: 7 phases, executable over 3-5 sessions. Phase 1 can be done in a single session (12 small changes). Phases 3-5 require careful testing between each sub-step.

---

## Answers to Specific Questions

**Q1: Incremental or big bang?**
Incremental, file-by-file. `getState()` is a compatibility shim reading from `activeTab.value` — removing one caller at a time is safe.

**Q2: Replacement pattern per caller?**
See Phase 1-2 above. Pattern: replace `getState()` with `activeTab.value`, map fields per the provided mapping table.

**Q3: What happens to `_update()` and `_updateSession()` in studio.js?**
They become unnecessary once no caller uses `update(newState)` or the flat `S`. The `_updateSession` logic for `pendingInlineEdit` moves to an effect. Post-render hooks become effects.

**Q4: What happens to `update()` in store.js after migration?**
Deleted. Any remaining callers of `update(newState)` must migrate to either `transactDoc` (for document changes) or direct reactive writes (for session changes).

**Q5: panel-events.js?**
See Phase 3. Reads become `activeTab.value.*`. Writes become direct property assignments. The `setState(hoverNode(S, path))` pattern becomes `activeTab.value.session.hover = path`. The ctx object shrinks.

**Q6: shortcuts.js?**
See Phase 4. The `S` / `setS` pattern is replaced by `activeTab.value` reads and direct writes. Zoom, selection, navigation all write directly to the reactive tab.

**Q7: Autosave?**
Moves from `addUpdateMiddleware` to an effect watching `activeTab.value.doc.dirty`. Reads from `activeTab.value` instead of `S`.

**Q8: Navigation (pushDocument/popDocument)?**
These pure functions return new flat state. They need to be rewritten as imperative mutations on `activeTab.value` — push to `tab.session.documentStack`, swap `tab.doc.document`, clear selection, etc. Alternatively, keep them as logic helpers that compute new values, then apply those values to the reactive tab.
