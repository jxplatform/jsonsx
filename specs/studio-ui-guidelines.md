# Jx Studio UI/UX Interface Guidelines

**Version:** 1.0.0
**Status:** Active
**Applies to:** `packages/studio/`

---

## 1. Design System Foundation

Jx Studio builds on **Adobe Spectrum Web Components** (`@spectrum-web-components/*`) with a dark theme (`color="dark"`, `scale="medium"`). All UI chrome uses Spectrum components; the canvas renders content via the Jx runtime on a light background.

### 1.1 Theme Tokens

Use CSS custom properties from `:root` — never hardcode color values.

| Token         | Purpose                           | Fallback                 |
| ------------- | --------------------------------- | ------------------------ |
| `--bg`        | App background                    | `#1e1e1e`                |
| `--bg-panel`  | Panel background                  | `#252526`                |
| `--bg-input`  | Input field background            | `#3c3c3c`                |
| `--border`    | Borders and separators            | `#3c3c3c`                |
| `--fg`        | Primary text                      | `#cccccc`                |
| `--fg-dim`    | Secondary text (labels, hints)    | `#808080`                |
| `--accent`    | Interactive elements, focus rings | `#007acc`                |
| `--accent-fg` | Text on accent backgrounds        | `#ffffff`                |
| `--danger`    | Destructive actions, errors       | `#f44747`                |
| `--success`   | Positive states                   | `#89d185`                |
| `--warning`   | Caution states                    | `#c5a332`                |
| `--radius`    | Standard border radius            | `3px`                    |
| `--hover-bg`  | Hover overlay                     | `rgba(255,255,255,0.04)` |

**Accent opacity variants** for backgrounds:

- `--accent-8` through `--accent-50` — use `color-mix(in srgb, var(--accent) N%, transparent)`

**Semantic tokens** for domain-specific highlighting:

| Token        | Purpose                               |
| ------------ | ------------------------------------- |
| `--tag`      | Element tag names (`#569cd6`)         |
| `--signal`   | State signals (`#dcdcaa`)             |
| `--handler`  | Functions/handlers (`#c586c0`)        |
| `--map`      | Repeaters (`#5b4fc7`)                 |
| `--switch-c` | Switch conditionals (uses `--danger`) |

---

## 2. Typography

### 2.1 Font Stacks

| Context            | Font Stack                                                             |
| ------------------ | ---------------------------------------------------------------------- |
| UI chrome          | `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` |
| Code / identifiers | `"SF Mono", "Fira Code", monospace`                                    |
| Canvas content     | Georgia, serif (content mode only)                                     |

### 2.2 Type Scale

| Size     | Usage                                                               |
| -------- | ------------------------------------------------------------------- |
| **12px** | Base body text, main UI                                             |
| **11px** | Form labels (`sp-field-label`), breadcrumbs, accordion headers      |
| **10px** | Hints (`.style-row-label`), badges, data explorer, secondary labels |
| **9px**  | Layer toggle icons, micro indicators                                |

**Line height:** 1.5 (base), 1.7 (content mode)

### 2.3 Label Conventions

- **Title Case** for all form labels: "Font Family", "Default", "Description" — not "fontFamily", "default", "desc"
- Use `camelToLabel()` from `studio-utils.js` to convert prop names automatically
- Abbreviations stay uppercase: "URL", "CSS", "ID"
- Framework-internal keys ($src, $prototype) are displayed as friendly names: "Source", "Prototype", "Export"

---

## 3. Layout

### 3.1 Application Grid

```
┌──────────┬────────────┬────────────────────┬──────────────┐
│ Toolbar  │            │                    │              │  36px
├──────────┼────────────┼────────────────────┼──────────────┤
│ Activity │   Left     │      Canvas        │   Right      │  flex
│ Bar      │   Panel    │                    │   Panel      │
│ (48px)   │  (240px)   │       (1fr)        │   (280px)    │
├──────────┼────────────┼────────────────────┼──────────────┤
│ Status   │            │                    │              │  24px
└──────────┴────────────┴────────────────────┴──────────────┘
```

- Panel widths: `--panel-w-left: 240px`, `--panel-w-right: 280px`
- Activity bar: 48px wide, icon tabs (48x48px each)
- Toolbar height: 36px
- Status bar height: 24px

### 3.2 Panel Structure

Both left and right panels follow the same anatomy:

1. **Panel tabs** — `sp-tabs` at the top for switching views
2. **Panel body** — Scrollable content area (`overflow-y: auto`)
3. **Content sections** — Accordion items or flat lists depending on context

---

## 4. Form Patterns

### 4.1 Standard Form Row (Vertical Stacked)

The canonical form layout. Labels sit above full-width inputs.

```html
<div class="style-row">
  <div class="style-row-label">
    <sp-field-label size="s">Label Text</sp-field-label>
  </div>
  <sp-textfield size="s" .value="${value}" @input="${handler}"></sp-textfield>
</div>
```

**CSS:**

```css
.style-row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  padding: 2px 0;
}
.style-row-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--fg-dim);
}
.style-row > sp-textfield,
.style-row > sp-number-field,
.style-row > sp-picker,
.style-row > sp-combobox,
.style-row > textarea {
  width: 100%;
}
```

**Rules:**

- Always use `size="s"` on Spectrum inputs
- Labels use `sp-field-label` inside `.style-row-label` — never bare `<label>` elements
- Inputs take full width of the container
- Child/nested rows indent with `.style-row--child` (`padding-left: 16px`)

### 4.2 Set Dot (Clear Indicator)

When a property has an explicit value, show a small accent dot to the left of the label. Clicking it clears the value.

```html
<div class="style-row-label">
  <span class="set-dot" title="Clear ${prop}" @click="${onDelete}"></span>
  <sp-field-label size="s">${label}</sp-field-label>
</div>
```

**CSS:**

```css
.set-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  cursor: pointer;
  flex-shrink: 0;
}
.set-dot:hover {
  background: var(--danger);
}
```

- Use `.set-dot--section` (7x7px) for accordion heading indicators
- Only show when the property is explicitly set — absent means inherited/default

### 4.3 Input Components

| Component                                   | When to Use                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `sp-textfield`                              | Free-text string values                                                                          |
| `sp-number-field`                           | Numeric values with optional min/max/step                                                        |
| `sp-picker`                                 | Fixed option sets (enums)                                                                        |
| `sp-checkbox`                               | Boolean toggles                                                                                  |
| `sp-switch`                                 | On/off feature toggles                                                                           |
| `sp-action-group` (compact, toggle buttons) | Small mutually-exclusive mode sets in bar chrome (e.g. the Auto/Light/Dark color-scheme preview) |
| `jx-styled-combobox`                        | Hybrid: fixed options with styled preview + free-text fallback                                   |
| `textarea.field-input`                      | Multi-line text (code, JSON, expressions)                                                        |

### 4.4 Debounce Pattern

All text input handlers must debounce before committing to state. Standard delay: **400ms** (500ms for code/expression textareas).

**Shared utility** (preferred for style properties):

```javascript
import { debouncedStyleCommit } from "../store";

@input=${debouncedStyleCommit("prop:name", 400, (e) => onChange(e.target.value))}
```

**Local debounce** (for non-style contexts):

```javascript
let debounce;
@input=${(e) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => onChange(e.target.value), 400);
}}
```

### 4.5 Event Conventions

| Event     | Meaning                                | Timing    |
| --------- | -------------------------------------- | --------- |
| `@input`  | Value is changing (keystroke)          | Debounced |
| `@change` | Value committed (menu selection, blur) | Immediate |

For `sp-picker` and menu-based inputs, use `@change` directly — no debounce needed. For `sp-textfield` and `textarea`, always debounce `@input`.

---

## 5. Accordion Sections

### 5.1 Structure

Use Spectrum `sp-accordion` for collapsible sections in all panels.

```html
<sp-accordion allow-multiple size="s">
  <sp-accordion-item
    label="Section Title"
    ?open="${isOpen}"
    @sp-accordion-item-toggle="${toggleHandler}"
  >
    <!-- section content -->
  </sp-accordion-item>
</sp-accordion>
```

### 5.2 Styling

```css
.panel-class sp-accordion {
  border: none;
}
.panel-class sp-accordion-item {
  --spectrum-accordion-item-header-font-size: 11px;
}
```

### 5.3 State Tracking

Accordion open/closed state uses one of two patterns:

**Module-local Set** (for left panel sections that don't need persistence):

```javascript
const collapsed = new Set();
@sp-accordion-item-toggle=${() => {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  rerender();
}}
```

**State object** (for inspector sections that persist with the document):

```javascript
// Read: isSectionOpen(key) — returns boolean, defaults to true
// Write: toggleSection(key) — flips state and re-renders
```

---

## 6. Component Inventory

### 6.1 Spectrum Components in Use

Registered in `packages/studio/src/ui/spectrum.js`:

**Layout:** `sp-theme`, `sp-tabs`, `sp-tab`, `sp-tab-panel`, `sp-divider`
**Inputs:** `sp-textfield`, `sp-number-field`, `sp-picker`, `sp-combobox`, `sp-checkbox`, `sp-switch`, `sp-field-label`, `sp-search`
**Actions:** `sp-action-button`, `sp-action-group`, `sp-action-bar`, `sp-picker-button`
**Overlays:** `sp-overlay`, `sp-popover`, `sp-tooltip`
**Menus:** `sp-menu`, `sp-menu-item`, `sp-menu-divider`, `sp-menu-group`
**Data:** `sp-accordion`, `sp-accordion-item`, `sp-swatch`, `sp-swatch-group`
**Color:** `sp-color-area`, `sp-color-slider`, `sp-color-handle`
**Icons:** 58 `sp-icon-*` components (workflow set)

### 6.2 Custom Components

| Component            | File                           | Purpose                                          |
| -------------------- | ------------------------------ | ------------------------------------------------ |
| `jx-styled-combobox` | `src/ui/jx-styled-combobox.js` | Dual-mode picker/combobox with styled menu items |

**`jx-styled-combobox` API:**

- Properties: `value`, `placeholder`, `size`, `.options` (array)
- Options format: `{ value, label, style? }` or `{ divider: true }`
- Events: `change` (selection), `input` (typing)
- Mode: Auto-switches between `sp-picker` (value matches option) and textfield+dropdown (free-text)
- No shadow DOM — renders into light DOM via `createRenderRoot() { return this; }`

---

## 7. Spacing System

No formal spacing scale — use these established values consistently:

| Context          | Value     | Usage                                       |
| ---------------- | --------- | ------------------------------------------- |
| Form row gap     | `2px`     | Between label and input (`.style-row`)      |
| Form row padding | `2px 0`   | Vertical rhythm between rows                |
| Section padding  | `4px 8px` | Panel section content                       |
| Panel padding    | `8px`     | Panel body areas                            |
| Child indent     | `16px`    | Nested/sub-property rows                    |
| Component gap    | `4px`     | Within label containers, badge groups       |
| Horizontal gap   | `6px`     | Between inline items (signal rows, toolbar) |
| Canvas gap       | `24px`    | Between canvas panels                       |

---

## 8. Interactive Patterns

### 8.1 Selection

- Canvas click registers elements via `WeakMap<Element, Path>`
- Selection path format: `["children", 0, "children", 2]`
- Selection highlight: 2px solid accent outline
- Hover highlight: 1px dashed accent outline at reduced opacity

### 8.2 Drag and Drop

Uses `@atlaskit/pragmatic-drag-and-drop` for layer reordering and canvas element manipulation.

- Drag indicator: `.dragging` class (opacity 0.4)
- Drop target: `.drop-target` class (accent-15 background, dashed outline)
- Drop line: 2px tall accent bar between elements

### 8.3 Inline Editing

Canvas elements become editable via `contenteditable="true"`:

- Focus ring: 2px solid accent outline, 1px offset
- Minimum height: 1.5em (prevents collapse)
- Escape to cancel, blur to commit

### 8.4 Context Menus

Rendered with `sp-menu` inside `sp-overlay` / `sp-popover`. Triggered on right-click in the canvas.

### 8.5 Slash Menu

Block insertion menu triggered by typing `/` in content mode. Positioned absolutely below the cursor. Filtered by typing after the slash.

### 8.6 Floating Action Bar

Fixed-position toolbar that follows the selected element:

- Shows element tag name, drag handle, and context actions
- Z-index: 100
- Shadow: standard elevation shadow
- Auto-hides when no selection

---

## 9. State Management

### 9.1 Immutable State

All mutations produce a new state object. Never modify state in place.

```javascript
import { update } from "../store";

// Correct: produce new state via mutation helper
update(updateStyle(S, path, prop, value));

// Wrong: never mutate directly
S.document.children[0].style.color = "red";
```

### 9.2 History

- Linear undo/redo stack, max 100 entries
- Each entry snapshots `{ document, selection }`
- `undo()` / `redo()` from `state.js`

### 9.3 Render Orchestration

The `update()` function triggers selective re-renders based on what changed:

- Document changed → re-render canvas + left panel + right panel
- Selection changed → re-render left panel + right panel
- UI-only change → re-render affected panel only

Module-local state (Sets, variables) persists across renders and doesn't need to go through the state system.

---

## 10. Conventions Checklist

When building new UI in Studio, verify:

- [ ] Uses `.style-row` vertical layout (not `.field-row` horizontal)
- [ ] Labels are Title Case via `sp-field-label` inside `.style-row-label`
- [ ] Inputs use `size="s"` and take full container width
- [ ] Text inputs are debounced (400ms standard)
- [ ] Pickers commit on `@change` without debounce
- [ ] Collapsible sections use `sp-accordion` / `sp-accordion-item`
- [ ] Colors reference CSS custom properties, not hex values
- [ ] State mutations are immutable (produce new objects)
- [ ] Custom components use light DOM (`createRenderRoot() { return this; }`)
- [ ] Event handlers call `e.stopPropagation()` when wrapping Spectrum events in light DOM components
