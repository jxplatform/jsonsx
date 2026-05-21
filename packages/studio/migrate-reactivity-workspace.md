# Jx Studio: Migration to `@vue/reactivity` + Workspace Model

**Status:** Draft
**Scope:** `packages/studio/src/`
**Prerequisites:** Original refactor spec phases 1–6 are complete (error boundaries, doc/session split, view state lifted, panels componentized, Lit host hygiene, async-as-state).
**Goal:** Replace the bespoke `update()` / subscribe / middleware system with `@vue/reactivity`, and restructure state to support VS Code-style multi-tab editing within the next month.

---

## Background

Phases 1–6 of the prior refactor delivered:

- Error boundaries around renderers.
- A split between `doc` (history, persistence, autosave) and `session` (selection, hover, UI).
- View state in per-component view objects rather than module globals.
- Panels as componentized modules with `mount`/`unmount`/`render` and a subscription model.
- One-writer Lit host discipline.
- Async work modeled as state (`session.canvas.status`) rather than callback chains.

What remains is a custom reactivity layer: `update()`, `updateDoc()`/`updateSession()`, `subscribe()`, change-bitmasks passed to subscribers, and an ad-hoc post-render hook system. It works, but two pressures are now converging:

1. The compiled Jx output already uses `@vue/reactivity`. Studio shipping its own reactivity layer means two mental models, two sets of bugs, and a real footgun when Studio embeds compiled previews (reactive objects crossing runtime boundaries is undefined behavior unless the runtime is identical).

2. Multi-tab editing in the next month requires a state shape Studio doesn't have today — workspace state above per-tab doc/session, with tabs as independent reactive units that can be created, switched, and disposed without cross-contamination. The current `update()` dispatcher is structured around a single `S`; bolting tabs onto it works but compounds the existing complexity rather than reducing it.

This spec replaces the custom reactivity with `@vue/reactivity` and restructures state into a workspace/tabs hierarchy. The two changes are sequenced together because doing them separately means two large refactors instead of one, and because the workspace structure is easier to express on top of reactive primitives than on top of `update()`.

## Non-Goals

- **No change to `state.js` mutator semantics.** Pure functions that take a node and produce a mutation remain the underlying mechanism. What changes is how mutations are applied (in place on reactive objects, transactionally) and what triggers re-renders (Vue effects, not manual dispatch).
- **No change to the file format, runtime, or PAL.**
- **No change to user-visible behavior** except (a) tab strip UI, and (b) explicitly-listed multi-tab behaviors.
- **No adoption of Vue's component system.** `@vue/reactivity` is the standalone reactivity package; Lit-html remains the rendering layer.
- **No adoption of `@lit-labs/preact-signals` or similar bridges.** Direct Vue `effect()` calls drive Lit re-renders. Bridge libraries add a layer that isn't needed for this use case.

## Guiding Principles

1. **One reactivity runtime in the codebase.** `@vue/reactivity` is it.
2. **Tabs are isolation boundaries.** A bug, a leak, or a crash in one tab cannot affect another. `effectScope()` is the mechanism.
3. **Mutations are direct; effects are automatic.** No `update(newState)` calls; `session.ui.activeMedia = "md"` is the API. Effects re-run because they read what changed.
4. **History is per-tab and explicit.** Reactivity doesn't replace the snapshot model — undo/redo still operates on document snapshots, and the snapshot push is explicit.
5. **The workspace layer is real even on day one with one tab.** Don't add it later.

---

## State Architecture (Target)

```
workspace (reactive)
  ├─ projectRoot, projectConfig, componentRegistry
  ├─ fileTree (dirs, expanded, selectedPath, searchQuery)
  ├─ tabs: Map<tabId, Tab>
  ├─ activeTabId: string | null
  └─ ui (workspace-level: activity bar selection, etc.)

Tab (reactive, owned by an effectScope)
  ├─ id, documentPath, fileHandle
  ├─ scope: EffectScope
  ├─ doc (reactive)
  │   ├─ document
  │   ├─ content.frontmatter
  │   ├─ mode
  │   ├─ handlersSource
  │   └─ dirty
  ├─ session (reactive)
  │   ├─ selection, hover
  │   ├─ documentStack (component navigation, per-tab)
  │   ├─ ui (leftTab, rightTab, zoom, activeMedia, activeSelector,
  │   │      featureToggles, styleSections, inspectorSections,
  │   │      styleShorthands, editingFunction, stylebookSelection, etc.)
  │   └─ canvas (status, scope, error, pendingInlineEdit — from Phase 6)
  └─ history
      ├─ snapshots: Array<{ document, selection }>
      └─ index: number
```

Three reactive trees: `workspace`, and one `{ doc, session }` pair per tab. Each tab owns an `effectScope` that contains every effect that reads from that tab. Closing the tab disposes the scope; every effect dies cleanly.

`componentRegistry`, `projectConfig`, and other workspace-level data become reactive — when a user edits component B in one tab, file A's canvas in another tab reads from the updated registry and re-renders automatically. This is the "cross-tab interaction" mechanism: not message-passing, just shared reactive state.

---

## Phase A: Vendor and Wire `@vue/reactivity`

**Effort:** Half a day
**Risk:** Negligible
**Addresses:** Foundation for everything else.

### Change

Add `@vue/reactivity` as a dependency. Confirm bundler (Bun) handles ESM cleanly. Confirm the version matches what compiled Jx output uses — pin exact version, document the pin in the package.json with a comment explaining why exact-version matters.

Create `packages/studio/src/reactivity.js` as the single entry point through which the rest of the codebase imports Vue's reactivity primitives:

```js
export {
  reactive,
  ref,
  computed,
  readonly,
  shallowReactive,
  shallowRef,
  effect,
  effectScope,
  getCurrentScope,
  onScopeDispose,
  pauseTracking,
  resetTracking,
  toRaw,
  isReactive,
  isRef,
} from "@vue/reactivity";
```

This indirection is for grep-ability and for the (unlikely) future where you might want to wrap a primitive — it's not a leaky abstraction layer, it's just a single import surface.

### Acceptance

- `import { reactive, effect, effectScope } from "./reactivity.js"` works.
- Bundle size is documented; if it's a regression, that's noted.
- Version is pinned in `package.json` (exact, no caret).

---

## Phase B: Tab Primitive

**Effort:** 1 day
**Risk:** Low
**Addresses:** The unit of isolation. Everything else builds on this.

### Change

Create `packages/studio/src/tabs/tab.js` defining the `Tab` factory and lifecycle:

```js
import { reactive, effectScope } from "../reactivity.js";

export function createTab({ id, documentPath, fileHandle, document, frontmatter }) {
  const scope = effectScope();

  const tab = scope.run(() => ({
    id,
    documentPath,
    fileHandle,
    scope,
    doc: reactive({
      document,
      content: { frontmatter: frontmatter || {} },
      mode: documentPath?.endsWith(".md") ? "content" : "component",
      handlersSource: null,
      dirty: false,
    }),
    session: reactive({
      selection: null,
      hover: null,
      documentStack: [],
      ui: createDefaultUi(),
      canvas: { status: "idle", scope: null, error: null, pendingInlineEdit: null },
    }),
    history: reactive({
      snapshots: [{ document, selection: null }],
      index: 0,
    }),
  }));

  return tab;
}

export function disposeTab(tab) {
  tab.scope.stop();
}
```

`createDefaultUi()` returns the same shape `S.ui` has today.

### Why `effectScope` Is Central

Without scopes, every `effect()` created during a tab's lifetime would leak when the tab closes. With scopes, every effect created inside `scope.run(...)` is automatically registered to that scope, and `scope.stop()` disposes them all atomically.

This is the single most important reason to choose `@vue/reactivity` over `@preact/signals-core` for this use case. Multi-tab editing without scope-based cleanup is a memory leak waiting to happen, and rolling your own cleanup tracking is exactly the trap the original refactor spec warned against.

### Acceptance

- A `Tab` can be created, has reactive `doc`/`session`/`history`.
- `disposeTab(tab)` stops the scope; any effect created inside the tab's scope stops firing.
- A unit test creates a tab, registers an effect that increments a counter on `tab.doc.dirty` changes, disposes the tab, mutates `tab.doc.dirty`, asserts counter does not increment.

---

## Phase C: Workspace Primitive

**Effort:** 1 day
**Risk:** Low

### Change

Create `packages/studio/src/workspace/workspace.js`:

```js
import { reactive, computed } from "../reactivity.js";
import { createTab, disposeTab } from "../tabs/tab.js";

export const workspace = reactive({
  projectRoot: null,
  projectConfig: null,
  componentRegistry: [],
  fileTree: {
    dirs: new Map(),
    expanded: new Set(),
    selectedPath: null,
    searchQuery: "",
  },
  tabs: new Map(), // tabId → Tab
  tabOrder: [], // ordered tabIds for tab strip
  activeTabId: null,
  ui: {
    activityBar: "files", // workspace-level activity bar selection
  },
});

export const activeTab = computed(() =>
  workspace.activeTabId ? workspace.tabs.get(workspace.activeTabId) : null,
);

export function openTab(opts) {
  const tab = createTab(opts);
  workspace.tabs.set(tab.id, tab);
  workspace.tabOrder.push(tab.id);
  workspace.activeTabId = tab.id;
  return tab;
}

export function closeTab(tabId) {
  const tab = workspace.tabs.get(tabId);
  if (!tab) return;
  disposeTab(tab);
  workspace.tabs.delete(tabId);
  workspace.tabOrder = workspace.tabOrder.filter((id) => id !== tabId);
  if (workspace.activeTabId === tabId) {
    workspace.activeTabId = workspace.tabOrder[workspace.tabOrder.length - 1] || null;
  }
}

export function activateTab(tabId) {
  if (workspace.tabs.has(tabId)) workspace.activeTabId = tabId;
}
```

### Reactive Collections Caveat

Vue's `reactive()` on a `Map` or `Set` returns a reactive proxy with the same API, but **operations that look mutating must use the Map/Set methods, not direct property access.** `workspace.tabs.set(id, tab)` works; `workspace.tabs[id] = tab` does nothing useful. This is a small gotcha worth flagging in code review.

The `tabOrder` array reassignment (`workspace.tabOrder = workspace.tabOrder.filter(...)`) triggers reactivity correctly because the whole array is replaced — `.filter()` returns a new array. Mutating in place with `.splice()` also works but the reassignment is clearer.

### Acceptance

- `openTab`, `closeTab`, `activateTab` work; `activeTab.value` updates accordingly.
- Closing the active tab activates the most recently opened remaining tab (or null if none).
- An effect reading `activeTab.value?.doc.document` re-runs when the user switches tabs.

---

## Phase D: Mutation API on Reactive Trees

**Effort:** 2–3 days
**Risk:** Medium (touches every mutator)
**Addresses:** Replacing `applyMutation` and friends.

### Change

Today's mutators in `state.js` are pure: they take a state, return a new state with a cloned-and-mutated document. With reactive objects, mutations happen in place — but you still want the _snapshot-for-history_ behavior for document edits.

Restructure into two layers:

**Layer 1: in-place mutators** that operate on a tab's `doc.document`:

```js
// state/mutate.js — operates on the reactive document in place
export function mutateInsertNode(tab, parentPath, index, nodeDef) {
  const parent = getNodeAtPath(tab.doc.document, parentPath);
  if (!parent.children) parent.children = [];
  parent.children.splice(index, 0, structuredClone(nodeDef));
}
```

Note the `structuredClone` — incoming `nodeDef` may be a plain object that the caller mutates afterward, and we want the inserted copy isolated. Existing inserts of reactive proxies (e.g., copying between tabs) need to call `toRaw()` first.

**Layer 2: transactional doc mutations** that push history and mark dirty:

```js
// state/transact.js
export function transactDoc(tab, mutationFn, { skipHistory = false } = {}) {
  const before = structuredClone(toRaw(tab.doc.document));
  const beforeSelection = tab.session.selection ? [...tab.session.selection] : null;

  mutationFn(tab);

  if (!skipHistory) {
    const truncated = tab.history.snapshots.slice(0, tab.history.index + 1);
    truncated.push({
      document: structuredClone(toRaw(tab.doc.document)),
      selection: tab.session.selection ? [...tab.session.selection] : null,
    });
    if (truncated.length > HISTORY_LIMIT) truncated.shift();
    tab.history.snapshots = truncated;
    tab.history.index = truncated.length - 1;
  }

  tab.doc.dirty = true;
}
```

The mutator API stays familiar at the call site:

```js
// Old:
update(insertNode(S, parentPath, idx, nodeDef));

// New:
transactDoc(activeTab.value, (t) => mutateInsertNode(t, parentPath, idx, nodeDef));
```

A thin facade can preserve the old signatures during migration:

```js
// store.js (compat layer during migration)
export const insertNode = (tab, parentPath, idx, nodeDef) =>
  transactDoc(tab, (t) => mutateInsertNode(t, parentPath, idx, nodeDef));
```

### Session Mutations Are Just Assignments

```js
// Old:
S = { ...S, ui: { ...S.ui, activeMedia: "md" } };
renderRightPanel();

// New:
activeTab.value.session.ui.activeMedia = "md";
// no manual render call; effects re-run automatically
```

This is where the change pays off. The dozens of ad-hoc `S = { ...S, ui: ... }` mutations become direct assignments, and the corresponding panels re-render because their effects read `ui.activeMedia`.

### Undo/Redo

```js
export function undo(tab) {
  if (tab.history.index <= 0) return;
  tab.history.index--;
  const snap = tab.history.snapshots[tab.history.index];
  tab.doc.document = structuredClone(snap.document);
  tab.session.selection = snap.selection ? [...snap.selection] : null;
  tab.doc.dirty = true;
}
```

Note: `tab.doc.document = ...` replaces the whole document. Effects that read into the document tree will re-run because the root reference changed. Granular reactivity within the document tree (so that editing one node only re-renders panels that read that node) is a future optimization — not in scope for this spec.

### Acceptance

- Every mutator in today's `state.js` has an equivalent in the new layered structure.
- Doc mutations push history and mark dirty.
- Session mutations don't push history.
- A call-site change is mechanical: `update(insertNode(S, ...))` → `insertNode(activeTab.value, ...)`.

---

## Phase E: Renderers Become Effects

**Effort:** 2–3 days
**Risk:** Medium
**Addresses:** Replacing manual `subscribe()` from Phase 4 with Vue effects.

### Change

Each panel's `mount(rootEl, getState)` (from Phase 4) becomes `mount(rootEl)`. Instead of subscribing to state-change notifications, the panel creates an `effect()` inside its scope that reads from the active tab and re-renders.

```js
// panels/right/index.js
import { effect, effectScope } from "../../reactivity.js";
import { activeTab } from "../../workspace/workspace.js";
import { litRender } from "lit-html";
import { rightPanelTemplate } from "./template.js";

let scope = null;

export function mount(rootEl) {
  scope = effectScope();
  scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      try {
        litRender(rightPanelTemplate(tab), rootEl);
      } catch (e) {
        console.error("Right panel render failed:", e);
        litRender(errorTemplate(e), rootEl);
      }
    });
  });
}

export function unmount() {
  scope?.stop();
  scope = null;
}
```

Inside `rightPanelTemplate(tab)`, every property read from `tab.doc.*` or `tab.session.*` is automatically tracked. The template re-renders when any read property changes — and only then.

### Tab-Switch Semantics

When `activeTabId` changes, `activeTab.value` produces a new `Tab` object. The effect re-runs. The new tab's `doc` and `session` are read. Subsequent changes to the _old_ tab no longer trigger the panel's effect — the dependency tracking automatically dropped them. This is the key correctness property: switching tabs cleanly transfers panel subscriptions to the new tab's reactive trees.

### The Async Render Question

Lit's `litRender` is synchronous, but the panel may want to read from data that's loading. Today (post-Phase 6) you have `session.canvas.status` for the canvas. Other panels can do the same — read a status field, render a skeleton if loading.

Effects should not be `async`. If async work is needed, kick it off (`spawn`) outside the effect and have it write to reactive state; the effect re-runs when the state updates. This is the same pattern Phase 6 established for the canvas.

### Batching

Vue's reactivity batches synchronous effect re-runs within a microtask, so `tab.session.ui.activeMedia = "md"; tab.session.ui.zoom = 1.5;` triggers each subscribing effect once, not twice. Use `nextTick()` (from `@vue/runtime-core`) if you need to wait for the flush — but `@vue/reactivity` alone doesn't ship `nextTick`. The standalone equivalent is `Promise.resolve().then(...)` or `queueMicrotask`. Document this in `reactivity.js` for clarity.

### Acceptance

- Every panel from Phase 4 is converted from subscription-based to effect-based.
- A panel doesn't re-render when a property it doesn't read changes.
- Switching tabs causes all panels to re-render with the new tab's content; subsequent edits to the prior tab do not cause re-renders.
- A thrown error in a panel's render doesn't propagate to other panels (per-effect try/catch).

---

## Phase F: Migrate State Access

**Effort:** 3–4 days
**Risk:** Medium (largest grep-and-replace)
**Addresses:** Removing the last references to the old `S`, `update()`, `updateDoc()`, `updateSession()`, `subscribe()`.

### Change

Find-and-replace in tranches. The mechanical patterns:

| Old                               | New                                                     |
| --------------------------------- | ------------------------------------------------------- |
| `S.document`                      | `activeTab.value.doc.document`                          |
| `S.selection`                     | `activeTab.value.session.selection`                     |
| `S.ui.activeMedia`                | `activeTab.value.session.ui.activeMedia`                |
| `update(selectNode(S, path))`     | `activeTab.value.session.selection = path`              |
| `updateSession({ ui: { x: y } })` | `activeTab.value.session.ui.x = y`                      |
| `updateDoc(applyMutation(S, fn))` | `transactDoc(activeTab.value, t => fn(t.doc.document))` |
| `subscribe(fn)`                   | `effect(fn)` inside an `effectScope`                    |
| `S.fileHandle`                    | `activeTab.value.fileHandle`                            |
| `S.documentPath`                  | `activeTab.value.documentPath`                          |
| `S.dirty`                         | `activeTab.value.doc.dirty`                             |
| `S.mode`                          | `activeTab.value.doc.mode`                              |

Within an effect, accessing `activeTab.value` should be done once at the top and cached locally — repeated `.value` reads are cheap but verbose:

```js
effect(() => {
  const tab = activeTab.value;
  if (!tab) {
    renderEmpty();
    return;
  }
  // ...use tab.doc and tab.session...
});
```

A handful of patterns won't translate cleanly:

**`projectState`** becomes `workspace.projectRoot`, `workspace.projectConfig`, etc. The `setProjectState({ ... })` function becomes direct assignments on `workspace`. `projectState` itself goes away.

**The PAL (`getPlatform()`)** is unaffected — platform adapters are infrastructure, not state.

**Module-level constants** (`COMMON_SELECTORS`, `VOID_ELEMENTS`) are unchanged.

**File operations** (in `files/file-ops.js`) currently take a `ctx` with `S` and `commit`. Refactor to take a `Tab` directly. Most file ops operate on the active tab; pass `activeTab.value` from the call site.

### Migration Strategy

Do this per-panel and per-subsystem. The compatibility shims from Phase D let you migrate one module at a time while others still use the old API. Each module's PR includes: state access migration, effect-based rendering, removal of any subscribe/update calls.

Order: simplest panels first (statusbar, toolbar), then larger ones (left panel, right panel), then the canvas (largest, most coupled to view state), then file ops, then bootstrap.

### Acceptance

- `import { S } from "./store.js"` returns zero hits.
- `update(`, `updateDoc(`, `updateSession(`, `subscribe(` all return zero hits.
- The `store.js` file no longer exports a state container — it's just the re-export of `state.js` utilities and possibly the workspace/tab modules.

---

## Phase G: Tab Strip UI and Multi-Tab Behaviors

**Effort:** 2–3 days
**Risk:** Low (after the above, it's mostly UI)
**Addresses:** The user-visible multi-tab feature.

### Change

Add a tab strip component (`panels/tab-strip/`) that:

- Renders one tab per `workspace.tabOrder` entry.
- Highlights the active tab.
- Closes tabs on middle-click or close button (calls `closeTab(id)`).
- Switches tabs on click (calls `activateTab(id)`).
- Marks dirty tabs visually (read from `tab.doc.dirty`).
- Optionally supports drag-to-reorder.

Update file-tree click handler to open in a tab rather than replace the current document:

```js
function openFileFromTree(path) {
  // Check if already open
  for (const tab of workspace.tabs.values()) {
    if (tab.documentPath === path) {
      activateTab(tab.id);
      return;
    }
  }
  // Load and open new tab
  const content = await platform.readFile(path);
  const doc = JSON.parse(content);
  openTab({ id: nanoid(), documentPath: path, document: doc });
}
```

Multi-tab keyboard shortcuts: `Cmd+W` closes active tab, `Cmd+Tab` / `Cmd+Shift+Tab` switches tabs (or `Cmd+1..9` for direct selection — match the platform convention you prefer).

Bootstrap creates one initial tab from whatever was being opened before (the `?open=` parameter, or an empty doc). The "no tabs open" state shows a welcome panel or file picker rather than crashing.

### Dirty Tab Close Confirmation

If `tab.doc.dirty` is true and the tab is closed, show a confirmation dialog (or unsaved-changes indicator with a "discard" option). This is standard editor behavior.

### Cross-Tab Component Edits

After this phase, editing a component definition in one tab automatically updates instances in other tabs' canvases — `componentRegistry` is reactive on `workspace`, the canvas effects read from it, edits propagate. Verify this works without explicit refresh.

### Acceptance

- Multiple files can be open simultaneously; each has independent selection, undo, scroll position, mode.
- Closing a tab disposes its scope; memory is freed.
- Switching tabs is visually instant.
- Editing component B in tab 2 updates component B's instances in tab 1's canvas without manual refresh.
- Closing a dirty tab prompts for confirmation.

---

## Phase H: Cleanup and Hardening

**Effort:** 1 day
**Risk:** Low
**Addresses:** Removing dead code, tightening boundaries.

### Change

- Delete the original reactivity machinery: `setUpdateFn`, `setGetStateFn`, `registerRenderer`, `render()`, `renderOnly()`, `addUpdateMiddleware`, `runUpdateMiddleware`, `addPostRenderHook`, `runPostRenderHooks`, `subscribe()`. None should still be referenced.
- Delete the doc/session split helpers that were just thin wrappers around `update()`.
- Audit `effect()` call sites for ones that should be `effect()` with a cleanup, or that should be wrapped in `effectScope` for proper disposal.
- Add a lint rule (or comment in the README) noting: any `effect()` created outside a scope leaks. The convention is: all effects live inside a panel's mount scope or a tab's scope.
- Document the reactivity model in `docs/state.md`: what's reactive, what owns what, how tabs work, why scopes matter.

### Acceptance

- The custom reactivity dispatcher code is gone.
- All effects are scope-owned.
- Documentation exists for the new model.

---

## What Each Phase Delivers

| Phase                       | Lands                            | User-visible? | Reversible? |
| --------------------------- | -------------------------------- | ------------- | ----------- |
| A. Vendor `@vue/reactivity` | Dependency + import surface      | No            | Trivially   |
| B. Tab primitive            | `createTab` / `disposeTab`       | No            | Trivially   |
| C. Workspace primitive      | `workspace` + `activeTab`        | No            | Trivially   |
| D. Mutation API             | `transactDoc`, in-place mutators | No            | With effort |
| E. Renderers become effects | Each panel converted             | No            | Per-panel   |
| F. Migrate state access     | All `S` references gone          | No            | With effort |
| G. Tab strip + multi-tab UX | Tab strip, multi-tab editing     | **Yes**       | With effort |
| H. Cleanup                  | Dead code removed                | No            | Trivially   |

## Recommended Order

A → B → C strictly before D. D before E. E and F can interleave per-module. G after F is complete (or at least after the panels involved in multi-tab UX are migrated). H last.

Phase D introduces the compatibility shims that let E and F land incrementally. Without those shims, F has to land all at once, which is much riskier.

## Estimated Total

Roughly 11–17 working days of focused work. Multi-tab UX (Phase G) can land at day 11–14 if the prior phases stay on schedule, comfortably inside the one-month window.

---

## Risks and Mitigations

**Risk: Reactive `Map`/`Set` gotchas.** Vue's reactivity wraps collection methods but not bracket access. _Mitigation:_ prefer `.get()`/`.set()`/`.delete()` everywhere; add a brief style note in `reactivity.js`'s module comment.

**Risk: Effect re-runs more than expected.** A common bug is reading a property whose container changes frequently, causing thrash. _Mitigation:_ if a panel re-renders too often, log dependencies (`effect` accepts an `onTrack` option) and narrow reads. The `computed()` primitive is useful for memoizing derived values.

**Risk: `toRaw` foot-guns.** Mutators that take incoming data may receive reactive proxies. _Mitigation:_ `structuredClone(toRaw(value))` is the safe-deep-copy idiom; use it whenever copying data into the document tree.

**Risk: Memory leaks from effects outside scopes.** _Mitigation:_ the cleanup-phase audit (H) catches these. Convention: never call `effect()` at module top level; always inside `scope.run(...)`.

**Risk: Cross-tab interactions cause performance issues.** If 20 tabs are open and each reads `workspace.componentRegistry`, editing a component triggers 20 panel re-renders per tab. _Mitigation:_ fine as long as renders are cheap. If profiling shows a problem, narrow the dependency: have panels read only the component entries they actually use.

**Risk: Multi-tab Monaco.** Each Monaco editor instance is heavy. _Mitigation:_ one shared Monaco instance whose model is swapped on tab switch (VS Code's approach). Out of scope for this spec but acknowledged.

**Risk: The compiled Jx runtime and Studio use different `@vue/reactivity` versions.** Reactive objects from one runtime don't track in effects from the other; bugs are subtle and hard to debug. _Mitigation:_ exact-version pin, document the requirement, add a startup check that compares versions if Studio embeds compiled output.

**Risk: Phase F is slow.** Lots of mechanical work, each change tiny but additive. _Mitigation:_ the per-module migration discipline from Phase 4 + compatibility shims from Phase D make it survivable. Time-box it; if a particular subsystem (likely the canvas) takes longer than expected, ship the others first.

## Open Questions

1. **Should `history` be reactive?** It's read by the undo/redo buttons (to disable them when at the start/end of history). If reactive, the toolbar effect re-runs on every mutation. If non-reactive, the toolbar needs a different mechanism to know history changed. **Recommendation:** reactive but only the index field; `snapshots` can be a non-reactive array referenced from the reactive container. Or use `shallowReactive` on `history`. Profile before optimizing.

2. **Should tabs persist across browser refresh?** VS Code restores tabs on relaunch. Doing this requires serializing `workspace.tabs` (or the subset that maps to on-disk files) to localStorage or PAL-backed storage. **Recommendation:** out of scope for this spec; add later if desired. Trivial to add once the workspace model is in place.

3. **Should there be a "pinned tab" concept?** VS Code has it (pinned tabs survive "close all"). **Recommendation:** out of scope; can be a boolean on `Tab` later.

4. **What about split-pane editing (two tabs visible side-by-side)?** Significant additional UX work. **Recommendation:** out of scope; the workspace model accommodates it (two `activeTabId`s, one per pane) but the UI work is large.

5. **Does the compiled Jx runtime currently use `@vue/reactivity` in shadow DOM or main DOM?** Affects how Studio embeds previews. **Recommendation:** verify before Phase A; pin version accordingly.
