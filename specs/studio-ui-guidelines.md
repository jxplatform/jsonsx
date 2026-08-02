# Jx Studio UI/UX Interface Guidelines

**Version:** 0.2.3
**Status:** Implemented
**Updated:** 2026-08-02
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
┌──────────┬────────────┬────────────────────┬──────────────┬───────────────┐
│ Toolbar                                                                   │  36px
├──────────┴────────────┴────────────────────┴──────────────┴───────────────┤
│ Tab strip / context bar / frontmatter (full-width, each conditional)      │  auto
├──────────┬────────────┬────────────────────┬──────────────┬───────────────┤
│ Activity │   Left     │      Canvas        │   Right      │  Assistant    │  flex
│ Bar      │   Panel    │                    │   Panel      │  (collapsed   │
│ (48px)   │  (240px)   │       (1fr)        │   (280px)    │   by default) │
├──────────┴────────────┴────────────────────┴──────────────┴───────────────┤
│ Status bar                                                                │  24px
└───────────────────────────────────────────────────────────────────────────┘
```

- Panel widths: `--panel-w-left: 240px`, `--panel-w-right: 280px`, `--panel-w-chat: 320px`
- Activity bar: 48px wide, icon tabs (48x48px each)
- Toolbar height: 36px
- Status bar height: 24px — `role="status"` + `aria-live="polite"`, the app's one status channel
- A collapsed column sets its width variable to `0px` and `display: none`s the region and its resize
  handle. The assistant column starts collapsed; every column's state round-trips through
  `localStorage` in both directions (a remembered "open" must reopen a default-closed column)

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

Registered in `packages/studio/src/ui/spectrum.ts`:

**Layout:** `sp-theme`, `sp-tabs`, `sp-tab`, `sp-tab-panel`, `sp-divider`
**Inputs:** `sp-textfield`, `sp-number-field`, `sp-picker`, `sp-combobox`, `sp-checkbox`, `sp-switch`, `sp-field-label`, `sp-search`, `sp-help-text`
**Actions:** `sp-action-button`, `sp-action-group`, `sp-action-bar`, `sp-picker-button`
**Overlays:** `sp-overlay`, `sp-popover`, `sp-tooltip`
**Dialogs:** `sp-dialog`, `sp-dialog-wrapper`, `sp-underlay`
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

A canvas click does two things at once: it places the text caret at the clicked character and
selects that block. There is no separate gesture for "select" versus "edit".

- Canvas click resolves the target through its stamped `data-jx-path`
- Selection path format: `["children", 0, "children", 2]`
- Selection highlight: 2px solid accent outline
- Hover highlight: 1px dashed accent outline at reduced opacity
- A block may also be selected WITHOUT a caret (from the layers panel, or by a structural edit
  moving the selection); surfaces that act on a text range must handle that state

### 8.2 Drag and Drop

Uses `@atlaskit/pragmatic-drag-and-drop` for layer reordering and canvas element manipulation.

- Drag indicator: `.dragging` class (opacity 0.4)
- Drop target: `.drop-target` class (accent-15 background, dashed outline)
- Drop line: 2px tall accent bar between elements
- On the CANVAS, a drag may be initiated only from the block action bar's drag handle. Pressing and
  dragging within text selects text — the canvas is a writing surface first

#### External (OS) file drags

Files dragged in from the desktop are NOT pragmatic sources — they arrive as native `dragover`/
`drop` events and need their own handlers. Every such handler opens by testing
`dataTransfer.types.includes("Files")`, so an in-app pragmatic drag falls straight through.

- `dropEffect` is `"copy"` (never `"move"` — the file stays where it was)
- A handler that accepts the drag MUST `preventDefault()` on `dragover`, or the browser shows the
  "not allowed" cursor and swallows the drop
- Directory rows reuse the tree's own `.drag-over` / `.drag-over-root` highlight
- Row handlers `stopPropagation()`, so a drop on a row never also fires the container's handler
- On the CANVAS exactly one affordance draws at a time: `.canvas-replace-target` (a solid accent box
  over the image the drop would replace) or the usual `.canvas-drop-indicator` (where a new element
  would be inserted). They answer different questions; both at once would be ambiguous
- A drop inside the canvas is `preventDefault()`ed in the capture phase before the contenteditable
  root sees it, so the browser never inserts its own `blob:` image alongside the real mutation

### 8.3 The Canvas Caret

The canvas render container is a single `contenteditable`; individual blocks are not toggled in and
out of it. A caret inside a block IS the edit — there is no session to enter, and no modal state.

- The caret lands where the author clicked, never at the end of the block
- Motion, selection and IME are the browser's; the studio intercepts only structural intent
- Component instances are `contenteditable="false"` islands the caret treats as atomic
- The active block carries `data-jx-active-block` for affordances (the empty-block slash hint)
- Blur does NOT end anything: the parent's toolbar takes focus on every click, and the caret must
  survive that
- Escape dismisses the caret; text is committed, not discarded

### 8.4 Context Menus

Rendered with `sp-menu` inside `sp-overlay` / `sp-popover`. Triggered on right-click in the canvas.

### 8.5 Slash Menu

Block insertion menu triggered by typing `/` at a block start or after whitespace. Positioned
absolutely below the cursor. Filtered by typing after the slash.

### 8.6 Floating Action Bar

Fixed-position toolbar that follows the selected element:

- Shows element tag name, drag handle, and context actions
- ONE shape: the bar does not rearrange itself when the author starts typing. Controls that cannot
  act are disabled, not removed — a toolbar whose buttons move under the cursor is worse than one
  with a greyed button
- Z-index: 100
- Shadow: standard elevation shadow

### 8.7 Dialogs and Overlay Layers

Studio renders every transient surface into one of three fixed, full-viewport hosts declared in
`packages/studio/index.html` — `#layer-popover`, `#layer-modal`, `#layer-dialog` — bound once at boot
by `initLayers()`. Each host is `pointer-events: none`; individual slots re-enable pointer events, so
the layers never swallow canvas input.

`packages/studio/src/ui/layers.ts` is the only sanctioned way to open one:

| Helper                  | Resolves                               | Use for                                          |
| ----------------------- | -------------------------------------- | ------------------------------------------------ |
| `showDialog<T>`         | `T` (whatever `done()` is called with) | Bespoke dialog bodies (multi-field forms)        |
| `showConfirmDialog`     | `boolean`                              | Confirm / cancel, `destructive: true` for danger |
| `showSaveDiscardDialog` | `"save" \| "discard" \| "cancel"`      | Unsaved-work decisions                           |
| `showPromptDialog`      | `string \| null` (trimmed)             | Single-value text entry                          |
| `openModal`             | handle with `update()` / `close()`     | Persistent modals (New Project, About)           |
| `renderPopover`         | handle with `update()` / `dismiss()`   | Anchored popovers and context menus              |

**Native browser dialogs are not permitted.** `window.prompt()`, `window.confirm()`, and
`window.alert()` are unstyled, untranslatable, block the entire renderer, and are unavailable in
sandboxed contexts. The `no-alert` lint rule (oxlint `restriction` category, enabled repo-wide in
`.oxlintrc.json`) enforces this; suppressing it requires justification in the change set.

`showPromptDialog(headline, opts)` is the replacement for `window.prompt()`:

- `value` pre-fills the field; `select` controls what is highlighted on focus — `"all"`, `"stem"`
  (everything before the last dot, so renaming a file keeps its extension), or `"none"`.
- `validate(value)` returns `""` for valid input, or a message. A non-empty message renders as
  `sp-help-text[slot="negative-help-text"]`, marks the field `invalid`, and blocks confirmation
  without closing the dialog. The default rejects blank input.
- `message` renders explanatory copy above the field; `placeholder`, `confirmLabel`, and
  `cancelLabel` follow the usual Spectrum semantics.
- Confirming resolves the **trimmed** value; cancel, close, and dismissal all resolve `null`.
- <kbd>Enter</kbd> in the field confirms. The field takes focus on open, once — re-renders triggered
  by validation must not steal the caret back.

Dialog attributes are kebab-case on `sp-dialog-wrapper` (`confirm-label`, `cancel-label`,
`secondary-label`). The camelCase property names are not observed attributes; using them silently
renders a dialog with no buttons.

**Modal surfaces own the keyboard.** Studio opens `sp-dialog-wrapper` through its `open` attribute
rather than Spectrum's `sp-overlay` (this layer stack owns stacking), and the wrapper only manages
focus when an overlay drives it. The layer stack therefore does it, once: `showDialog` and
`openModal` are both thin wrappers over one internal slot helper, so no surface can ship without the
machinery and no body hand-rolls its own.

- On open the slot moves focus into itself — the first enabled focusable in the body, else the
  dialog wrapper's own cancel button (DialogWrapper renders cancel → secondary → confirm, so the
  first shadow button is the least destructive landing spot), else the slot itself, which carries
  `tabindex="-1"` so a body of static content (a progress spinner) still receives keys. A body that
  already claimed focus (`showPromptDialog`'s field) keeps it.
- On close the slot hands focus back to whatever held it before the surface opened.
- <kbd>Escape</kbd> is centralised on the slot. In `showDialog` it fires the wrapper's `close`
  event, so each helper's own `@close` binding decides what "dismissed" resolves to; a bespoke body
  with no `sp-dialog-wrapper` owns its own keys.

`openModal(template, opts)` adds the rest of the modal contract **at the wrapper**, never in the
body:

- `opts.label` is **required** and becomes `aria-label` on the slot, which is also the
  `role="dialog"` / `aria-modal="true"` element. A modal body must not declare its own `role` — the
  duplicate would nest one dialog inside another.
- <kbd>Tab</kbd> and <kbd>Shift</kbd>+<kbd>Tab</kbd> cycle the body's enabled focusables, wrapping at
  both ends; with nothing focusable the caret stays on the slot. Tabbing out of a surface the mouse
  cannot leave either would strand the keyboard behind the underlay. `showDialog` does **not** trap:
  its action buttons live in a shadow root a light-DOM cycle cannot enumerate, so a trap there would
  strand the caret on the body and never reach Cancel.
- <kbd>Escape</kbd> dismisses. `opts.onDismiss` overrides what that runs — pass the call site's own
  close function when it keeps bookkeeping (a module-level handle to clear); the default is the
  handle's `close()`. `opts.dismissible: false` opts out entirely, for a modal that must not vanish
  mid-flight.
- Dismissal `preventDefault`s and stops propagation, so the same keystroke does not ALSO clear the
  canvas selection behind the underlay.

`isModalOpen()` reports whether a surface with an underlay is up — a `showDialog` dialog, or an
`openModal` body that renders its own `sp-underlay`. It is derived from the live DOM, not a
registration counter, so the rule is simply _whatever blocks the mouse blocks the keyboard_: the
app-level keydown handlers (`editor/shortcuts.ts`, `panels/block-action-bar.ts`) return early while
it is true. Without that gate, <kbd>Delete</kbd>, <kbd>Enter</kbd>, ⌘S, ⌘W and ⌘Z keep driving the
document behind a surface the author cannot even click on.

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
- [ ] Text entry and confirmation go through `ui/layers.ts` (§8.7) — never `prompt()`, `confirm()`, or `alert()`
- [ ] `sp-dialog-wrapper` labels use kebab-case attributes (`confirm-label`, not `confirmLabel`)
- [ ] Every class emitted from TypeScript has a rule in `styles/*.css` — no `style=` attribute doing
      a stylesheet's job (`scripts/check-styles.ts` fails on orphans, and on allow-list entries that
      have since been styled)
- [ ] A control carries ONE accessible name. `title` and `aria-label` with the same string make
      screen readers announce it twice — pick the one the component actually uses
- [ ] A control that cannot act renders **disabled with the reason in its tooltip**, never absent
- [ ] `outline: none` is scoped to `:focus:not(:focus-visible)` and paired with a `:focus-visible`
      ring — suppressing the ring on plain `:focus` makes the control untraversable by keyboard

## Changelog

- **0.2.3** (2026-08-02) — One teaching empty-state pattern (new §11); focus-visible rings replace bare outline:none; settings writes surface failure at the control.
- **0.2.2** (2026-08-02) — openModal shares showDialog's focus machinery: role/label at the wrapper, focus trap, focus restore, centralised Escape (§8.7).
- **0.2.1** (2026-07-28) — Drag-and-drop conventions for external OS file drags (§8.2): copy dropEffect, the Files-type guard, tree highlights, and the canvas replace-vs-insert affordance.
- **0.2.0** (2026-07-26) — Canvas caret replaces the inline-edit session (§8.3); click selects and places the caret (§8.1); canvas drags start only from the bar handle (§8.2); single-shape action bar (§8.6).
- **0.1.8** (2026-07-26) — Modal surfaces own the keyboard: showDialog focus handoff, Escape dismissal, and the isModalOpen() shortcut gate (§8.7).
- **0.1.7** (2026-07-26) — Dialogs and overlay layers (§8.7): the ui/layers.ts contract, showPromptDialog as the replacement for window.prompt(), and a ban on native browser dialogs.
- **0.1.6** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.5** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.1.4** (2026-07-17) — Color-scheme canvas preview — Auto/Light/Dark tab-bar control (`ccdc1d3e`).
- **0.1.3** (2026-06-01) — Convert to typescript (`e352e265`).
- **0.1.2** (2026-04-22) — External web component support (`a9d0fbe4`).
- **0.1.1** (2026-04-22) — Init new site (`f33d319b`).
- **0.1.0** (2026-04-18) — Ui guidelines (`91f2b29e`).
