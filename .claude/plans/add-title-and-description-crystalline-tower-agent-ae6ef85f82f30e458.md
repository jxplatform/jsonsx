# Implementation Plan: `title` and `description` as Annotation Keys

## Summary

Repurpose `title` from an HTML attribute mapping to a JSON Schema-style annotation key (like `$id`). Add `description` as a parallel annotation. Both are developer-only metadata dropped at compile time. The studio layers panel uses `title` as the preferred display label with inline editing support.

**Breaking Change**: `title` will no longer render as an HTML `title` attribute. Users must migrate to `attributes: { title: "..." }` for HTML tooltips.

---

## 1. Schema Changes (`packages/schema/schema.json`)

**File**: `/home/batonac/Development/jx/packages/schema/schema.json`

### 1a. Update `title` property on ElementDef (line 952)

Change the description and type. Currently it maps to `StringOrRef` (supporting reactive expressions). As an annotation, it should be a plain string only — no template expressions needed.

```json
"title": {
  "type": "string",
  "description": "Developer annotation label for this element. Displayed in studio layers panel. Not rendered to HTML output."
}
```

### 1b. Add `description` property to ElementDef (insert after `title`)

```json
"description": {
  "type": "string",
  "description": "Developer annotation describing this element's purpose. Not rendered to HTML output."
}
```

### 1c. Root document level

The root document object already has `$id`; `description` is not needed at root since it already participates as a JSON Schema keyword via the state system. No change needed at document level.

---

## 2. Runtime Changes (`packages/runtime/src/runtime.js`)

**File**: `/home/batonac/Development/jx/packages/runtime/src/runtime.js`

### 2a. Add `title` to RESERVED_KEYS (line 348-379)

Add `"title"` to the `RESERVED_KEYS` Set. This prevents the runtime from applying `title` to the DOM as a property/attribute.

`description` is already in RESERVED_KEYS (confirmed at line 366).

Insert `"title"` near `"description"` for logical grouping:

```js
export const RESERVED_KEYS = new Set([
  // ... existing entries ...
  "description",
  "title", // <-- ADD THIS
  // ...
]);
```

---

## 3. Compiler Changes (`packages/compiler/src/shared.js`)

**File**: `/home/batonac/Development/jx/packages/compiler/src/shared.js`

### 3a. Remove `title` from `buildAttrs()` (lines 383, 392)

Remove these two lines from `buildAttrs()`:

```js
// DELETE line 383: const title = resolveStaticValue(def.title, scope);
// DELETE line 392: if (title) out += ` title="${escapeHtml(title)}"`;
```

This ensures the static compiler also drops `title` (matching the runtime's RESERVED_KEYS behavior).

### 3b. Verify SCHEMA_KEYWORDS already includes both

Confirmed: `SCHEMA_KEYWORDS` (line 23-38) already has `"title"` and `"description"`. No change needed here — these are used for state type-definition detection, not element rendering.

---

## 4. Studio: `nodeLabel()` Update (`packages/studio/src/state.js`)

**File**: `/home/batonac/Development/jx/packages/studio/src/state.js`

### 4a. Add `title` as highest-priority label (after `$id`)

Update the `nodeLabel()` function (line 176-190) to check `node.title` after `node.$id` but before textContent:

```js
export function nodeLabel(node) {
  if (!node) return "?";
  if (node.$prototype === "Array") {
    const ref = node.items?.$ref || "items";
    return `Repeater -> ${ref}`;
  }
  if (node.$id) return node.$id;
  if (node.title) return node.title; // <-- ADD THIS LINE
  const tag = node.tagName ?? "div";
  const suffix = node.$switch ? " ⇆" : "";
  if (typeof node.textContent === "string" && node.textContent.length > 0) {
    return `${tag} — ${node.textContent.slice(0, 24)}${suffix}`;
  }
  return tag + suffix;
}
```

---

## 5. Studio: Layers Panel Inline Editing (`packages/studio/src/panels/layers-panel.js`)

**File**: `/home/batonac/Development/jx/packages/studio/src/panels/layers-panel.js`

### 5a. Add `@dblclick` handler to the layer label span

On the `.layer-label` span (currently line ~168), add a double-click handler that enters inline editing mode:

```js
@dblclick=${(e) => {
  e.stopPropagation();
  enterLayerTitleEdit(e.target, path, node, ctx);
}}
```

### 5b. Implement `enterLayerTitleEdit()` function

Create a new function in layers-panel.js (above `renderLayersTemplate`):

```js
/**
 * Enter inline-edit mode for a layer's title annotation.
 *
 * @param {HTMLElement} labelEl - The .layer-label span
 * @param {any} path - JxPath to the node
 * @param {any} node - The node object
 * @param {{ rerender: () => void }} ctx
 */
function enterLayerTitleEdit(labelEl, path, node, ctx) {
  const tab = activeTab.value;
  if (!tab) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "layer-title-input";
  input.value = node.title || "";
  input.placeholder = nodeLabel(node);

  labelEl.textContent = "";
  labelEl.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    const value = input.value.trim();
    transactDoc(tab, (t) => mutateUpdateProperty(t, path, "title", value || undefined));
    ctx.rerender();
  };

  input.addEventListener("blur", commit, { once: true });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      input.value = node.title || "";
      input.removeEventListener("blur", commit);
      ctx.rerender();
    }
  });
}
```

### 5c. Add CSS for `.layer-title-input`

Add minimal styling (in the studio's stylesheet or a `<style>` block):

```css
.layer-title-input {
  background: transparent;
  border: 1px solid var(--spectrum-global-color-blue-400);
  border-radius: 2px;
  color: inherit;
  font: inherit;
  font-size: inherit;
  padding: 0 2px;
  width: 100%;
  outline: none;
}
```

### 5d. Import `mutateUpdateProperty` from transact.js

Update the existing import line to include it:

```js
import {
  transactDoc,
  mutateMoveNode,
  mutateRemoveNode,
  mutateUpdateProperty,
} from "../tabs/transact";
```

### 5e. Export `enterLayerTitleEdit` for context menu use

Export the function so the context menu module can invoke it:

```js
export { enterLayerTitleEdit };
```

---

## 6. Studio: Context Menu "Set Title" Item (`packages/studio/src/editor/context-menu.js`)

**File**: `/home/batonac/Development/jx/packages/studio/src/editor/context-menu.js`

### 6a. Add "Set Title" menu item

Insert near the top of the element-specific items block (after "Copy" or before the first separator). The action triggers the inline edit in the layers panel:

```js
items.push({
  label: "Set Title",
  action: () => {
    const key = pathKey(path);
    const layerLabel = document.querySelector(`.layer-row[data-path="${key}"] .layer-label`);
    if (layerLabel) {
      enterLayerTitleEdit(layerLabel, path, node, ctx);
    }
  },
});
```

### 6b. Import dependencies

```js
import { enterLayerTitleEdit } from "../panels/layers-panel";
import { pathKey } from "../store"; // likely already imported
```

### 6c. Pass `ctx` through to `showContextMenu`

The context menu function signature currently takes `(e, path, opts)`. The `ctx` object with `rerender` needs to be available. Options:

- Add `rerender` to the opts parameter: `showContextMenu(e, path, { onEditComponent, rerender })`
- Or import a global rerender trigger from the view module

Looking at the call site in layers-panel.js (line 152), it already has access to `ctx`. The simplest approach is to add `rerender: ctx.rerender` to the opts passed:

```js
@contextmenu=${(e) => showContextMenu(e, path, {
  onEditComponent: ctx.navigateToComponent,
  rerender: ctx.rerender,
})}
```

---

## 7. Spec Updates

### 7a. Main spec (`specs/spec.md`)

**File**: `/home/batonac/Development/jx/specs/spec.md`

Add an "Annotations" subsection to the element properties documentation:

````markdown
### Annotations

Elements support two annotation properties that are purely for developer tooling and are **never rendered to HTML output**:

| Key           | Type   | Purpose                                                   |
| ------------- | ------ | --------------------------------------------------------- |
| `title`       | string | Display label in studio layers panel and tooling overlays |
| `description` | string | Developer documentation for the element's purpose         |

These follow JSON Schema annotation conventions. To set an HTML `title` attribute (browser tooltip), use the `attributes` object:

```json
{
  "tagName": "button",
  "title": "Submit Form Button",
  "attributes": { "title": "Click to submit" }
}
```
````

```

### 7b. Site docs (`sites/jxsuite.com/content/docs/spec.md`)

**File**: `/home/batonac/Development/jx/sites/jxsuite.com/content/docs/spec.md`

Mirror the same documentation. Add migration guidance for the breaking change.

---

## Sequencing & Dependencies

1. **Runtime** (add `title` to RESERVED_KEYS) — no dependencies
2. **Compiler** (remove `title` from `buildAttrs`) — no dependencies
3. **Schema** (update `title` description, add `description` to ElementDef) — no dependencies
4. Steps 1-3 can be done in parallel as a single atomic commit
5. **State/nodeLabel** — depends on step 1 conceptually but no code dep
6. **Layers panel inline edit** — depends on step 5, plus transact.js import
7. **Context menu** — depends on step 6 (needs the exported edit function)
8. **Spec** — can be done last or in parallel

---

## Potential Risks & Mitigations

1. **Breaking change for `title` as HTML tooltip**: Anyone using `title` on elements loses the tooltip. Mitigation: document migration path (`attributes: { title: "..." }`). Consider logging a one-time deprecation warning in dev mode.

2. **Inline edit UX edge cases**: Double-clicking could conflict with row selection click handler. Solution: use `stopPropagation()` on dblclick and only target the `.layer-label` span, not the full row.

3. **nodeLabel() callers**: 5 files use `nodeLabel` (statusbar, block-action-bar, layers-panel, store.js re-export, state.js definition). After adding `title` priority, all those places automatically benefit — no individual updates needed.

4. **$id vs title precedence**: `$id` remains highest priority since it has semantic meaning (component identity). `title` is second — this matches the intuition that `$id` is structural while `title` is descriptive.

5. **Context menu finding DOM element**: The "Set Title" action queries the DOM for the layers panel row. If the layers panel is collapsed/hidden, the element won't exist. Mitigation: fall back to a prompt/dialog or ensure layers panel is visible.

---

## Testing Considerations

- Unit test: `nodeLabel()` returns `title` when present, falls back correctly when absent
- Unit test: compiler `buildAttrs()` no longer outputs `title` attribute
- Unit test: runtime skips `title` in DOM property application
- Integration: studio layers panel shows title as label
- Integration: double-click enters edit, Enter commits, Escape cancels
- Regression: verify `attributes: { title: "..." }` still produces HTML tooltip
```
