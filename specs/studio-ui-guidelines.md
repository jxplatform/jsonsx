# Jx Studio UI/UX Interface Guidelines

**Version:** 0.3.8
**Status:** Implemented
**Updated:** 2026-08-13
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

**The dot is the "set here" state of the provenance chip, not a separate affordance.** A field label
carries exactly one chip, in four states (`studio.md` §6.7): accent for set-here and clickable to
clear; amber for inherited, **naming the donor** and clickable to jump there; violet for bound,
naming the signal; and nothing at all for default, because absence is the ghost state and an
explicit "not set" badge on every unset row is noise on the majority of rows.

Three rules follow, and they are what stop the chip becoming decoration:

- **An inherited chip that does not name its donor is a bug.** "Inherited" alone is what an input
  placeholder already said, and a placeholder is visually identical to the CSS initial value.
- **A collapsed section header carries the same states as a tally**, which is why there is no
  separate "show only the properties that are set" toggle.
- **Where a value differs across a multiple selection the chip reads Mixed**, and the row must not
  offer a plain clear affordance as though the selection agreed.

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

### 4.6 A Row Wraps; It Never Overflows

Every form in the Inspector renders at a width the author chooses, and in two docks of very different
sizes. A field that leaves the panel is not a cosmetic problem: the control is unreachable, and the
author's only recourse is to widen a dock they may not have room to widen.

- **A row is a wrapping flex row**, and the wrap threshold is a `flex-basis`, never a fixed width. The
  same markup is then one line where there is room and a stack where there is not, without a second
  template or a media query.
- **`min-width: 0` on every flex child in the chain.** A flex item refuses to shrink below its
  min-content by default, and a Spectrum field is 192px wide (`--spectrum-field-width`) before it
  starts negotiating — one operand row of a mode picker, a type picker and a field therefore demands
  ~360px in a 280px dock and simply overflows. This one declaration is the difference.
- **A `flex` shorthand belongs in a row.** `.style-row` (§4.1) is `flex-direction: column`, so
  `flex: 1` on one of its children is permission to grow TALL, not wide — which is how a text field
  came to render 128px high beside a picker in the Logic tab. Widen a child of a `.style-row` with
  `width: 100%`; spend a basis only inside a container that is genuinely a row.
- **Long values ellipsize or wrap.** A `$ref` path, a formula and a component name are all
  author-supplied and unbounded; none of them may set the width of the form that contains them.

The rule is checkable without a browser — assert the structure that produces the layout, not computed
pixels, which happy-dom does not lay out — but the judgement is not. A change here is looked at in a
real browser at the narrowest dock the app allows and at a wide one.

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

**Selection is a list.** `session.selection` is a `JxPath[]`; `[]` means nothing is selected and the
root path is `[[]]`. The first entry is the range anchor, the last is the **primary**, and every
surface that addresses one node resolves it through a single shared function so that a
one-element selection is indistinguishable from the single-path field it replaced.

- **Shift extends from the anchor; Ctrl/Cmd accumulates.** A range is authored in the **Outline**,
  because a list of rows is where "everything between these two" has an unambiguous meaning.
  Accumulate works wherever an element can be clicked — the Outline and the **canvas** both toggle a
  node into the set. A marquee is a third gesture and is deliberately absent: a half-built marquee
  in the canvas hit test is worse than none.
- **A command that cannot express itself over several targets stays single-target and says so.**
  "Move six nodes up one slot" has no answer when they are not siblings; those verbs act on the
  primary rather than guessing.
- **A structural command over a selection is one transaction**, so the batch is one undo step, and
  it must not be able to leave the document partly mutated and unrecorded — an edit the author can
  see but cannot undo or save is worse than a refused edit.

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
- **It steps aside when the author leaves the canvas.** A pointerdown in parent chrome outside the
  canvas hides the bar; a selection change or a pointerdown back in the canvas brings it back. The
  bar is `position: fixed` and clamped into the window, so a bar that outlived the author's attention
  sat over the Document Header, the pane context bar and the docks — chrome the author was reaching
  for. Hiding it never clears the SELECTION: the Inspector's whole job is editing what is selected
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

**History covers project documents too.** `project.json` is a Tab (`studio.md` §17), so a settings
mistake is undone with the same chord as a document mistake. This is not a convenience: it is the
precondition for making configuration non-modal at all. A surface that can change the file defining
the project, with no undo behind it, is more dangerous the easier it is to reach — so recoverability
lands before, not after.

A batch of related edits is **one** entry, and a failed write leaves no entry at all: the document,
its frontmatter, the selection and the dirty flag are all restored. A change the author can see but
cannot undo or save is worse than a refused change.

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
- [ ] An empty region renders through `renderEmptyState()` (§11) — never a bare container, never a
      hand-written block, never a noun phrase like "No state defined"
- [ ] A control that invokes an action renders it from its command record (§12): the record's title
      as the accessible name, its chord formatted by the one formatter, its `requires` as the
      disabled tooltip — never a hand-maintained `{ label, action }` list

---

## 11. Empty States and Copy

**Status:** Implemented

Every region of the shell that can be empty renders through **one** pattern —
`renderEmptyState()` in `src/panels/empty-state.ts`. A region with no object to show never paints a
bare container, and it never hand-writes its own block: the copy rules below are inherited, not
re-decided per panel.

### 11.1 The three copy rules

1. **One sentence saying what the region is _for_** — never what is absent. "No state defined" is a
   dead end; "Data this page can read, compute or fetch lives here" tells the reader what the region
   would contain and why they might want one. The sentence is `spec.message`; an optional second
   sentence (`spec.detail`) says where the content comes from.

2. **The action that fills it, as a real button that does the thing.** `spec.actions` are
   `{ label, run }` records rendered as `sp-action-button`s. The label is imperative and names the
   outcome — "Add a value", not "Go to the Data panel". The single exception is a `compact:true`
   state sitting directly above its own add form: there, the form _is_ the action, and a button
   duplicating it would be a second definition site for one capability.

3. **One shared verb across equivalent surfaces.** Everything that needs a canvas selection says
   `clickAnythingTo(outcome)` — "Click anything on the canvas to ⟨style it / edit its content / wire
   it up⟩". Everything that needs an open document offers `openPageAction()`. Three panels that all
   want the same thing must not read as three different requirements.

`staleSelectionMessage()` is the fourth case, and it is the shape every "it's gone" message takes:
name what disappeared, then hand back the shared verb — "That element is no longer on the page.
Click anything on the canvas to pick another one."

### 11.2 Structure and styling

| Element                | Class                   | Notes                                                       |
| ---------------------- | ----------------------- | ----------------------------------------------------------- |
| Container              | `.empty-state`          | plus `.empty-state--teach`                                  |
| Inline (in-panel) form | `.empty-state--compact` | tighter, left-aligned; sits inside an otherwise full panel  |
| Sentence               | `.empty-state-message`  | required                                                    |
| Second sentence        | `.empty-state-detail`   | optional                                                    |
| Action row             | `.empty-state-actions`  | omitted entirely when there are no actions                  |
| Action                 | `.empty-state-action`   | `sp-action-button size="s"`; `?disabled` carries its reason |

Layout lives in `styles/panels.css`; no empty state carries a `style=` attribute.

### 11.3 Jargon

The empty state is where a new author meets the vocabulary, so it uses the plain word, with the
Jx term in apposition at most once: "Data this page can read (its **state**)". A panel title may be
a term of art; the sentence beneath it may not be a second one.

---

## 12. Command and Menu Rendering Rules

**Status:** Partial — the registry and the CI checks ship; the surfaces are being ported onto them.

Every capability Studio has is a **command record** (`specs/studio.md` §13). This section governs
how those records are _rendered_: where a record may appear, how many may appear at once, and what
every appearance must print.

### 12.1 The level × placement matrix

`level` states what a command acts on; a **placement** is a surface it declares itself into via
`menus`. Each placement admits a fixed set of levels. This table is the normative copy;
`packages/studio/src/commands/levels.ts` (`PLACEMENT_MATRIX`) mirrors it, and
`scripts/check-command-levels.ts` validates every registered command's `menus` against it in CI.

| Placement             | Admits levels                             | Why                                                                             |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `commandbar/primary`  | application, document                     | document only for Save / Undo / Redo / Open in Browser, by frequency; ≤5 total  |
| `commandbar/overflow` | application, project, document            | never selection — the Command Bar is not a selection surface                    |
| `statusbar/project`   | project                                   | the status bar's left field                                                     |
| `statusbar/document`  | document                                  | the status bar's centre field                                                   |
| `statusbar/selection` | selection                                 | the status bar's right field                                                    |
| `context/element`     | selection                                 | the canvas element menu acts on a selection                                     |
| `context/file`        | project                                   | a file row addresses the project's file set                                     |
| `context/layer`       | selection                                 | an outline row IS a selection                                                   |
| `context/tab`         | document                                  | a tab addresses one document                                                    |
| `context/pane`        | document                                  | a pane hosts one document                                                       |
| `blockbar`            | selection                                 | the floating bar owns selection-scoped verbs                                    |
| `blockbar/format`     | selection                                 | the bar's inline-format cluster — a range inside the selection is the selection |
| `outline/row`         | selection                                 | row actions act on the row's node                                               |
| `palette`             | application, project, document, selection | the level-agnostic surface; it groups its rows by level                         |
| `never`               | application, project, document, selection | keyboard- and API-only; there is no rendered surface to be misplaced in         |

`blockbar/format` is one surface with two budgets, and that is why it is a row rather than a note.
The bar's verb cluster is capped at five (`CHROME_BUDGET.commandbarPrimary`'s sibling), and the
inline-format vocabulary is eight — Bold, Italic, Underline, Strikethrough, Superscript, Subscript,
Code, Link — so sharing one cap would have pushed Bold behind a `⋮`. Same level, same region,
separate budget: the status bar's three single-level placements are the precedent.

Panel placements — the two Navigator rail groups (project above, document below), the Navigator dock
body, the Bottom dock (project and document, with the panel header stating which) and the Inspector
dock (selection) — belong to the same matrix. They admit **Panel** records rather than commands, and
they are `PANEL_PLACEMENT_MATRIX` in `levels.ts`, checked by `registerPanel()` at registration.

Three rules follow from the table and are not negotiable in review:

- **A record with no `menus` defaults to `["palette"]`**, which admits every level. A command has to
  opt _in_ to a region before it can be misplaced.
- **Mixed regions are mixed in the table, never by prose exemption.** The status bar is three
  separate single-level placements, not one "mixed" region.
- **A region that genuinely needs a second level gets a new row**, with its reason in the `note`
  field — not a comment excusing one command.

The check validates placement only. Whether a panel _reads_ state above its level is a separate
defect with a separate rule: a record declared `level:"project"` may not source its state from
`activeTab`, or its badge disappears when the last tab closes.

### 12.2 The chrome budget

Chrome is earned by frequency and capped by a build check
(`scripts/check-chrome-budget.ts`, thresholds in `src/commands/budget.ts`):

| Cap                                                | Limit |
| -------------------------------------------------- | ----- |
| Commands declaring `menus: ["commandbar/primary"]` | 5     |
| Tabs in any one dock or rail group                 | 4     |

Raising a cap is a design decision and happens in `budget.ts`, in one place, deliberately.

**Retiring a control costs three things**: (a) a discoverable command name, (b) a bindable chord, and
usually (c) a status-bar or context-menu residue. Retiring without all three is deletion, not
consolidation. Moving a command to `commandbar/overflow` satisfies (a) and (c) for free — it keeps
its name, its chord and its palette row.

Stripping labels is **not** a way to stay under the cap. A container query that hides every button's
text below a breakpoint converts a crowding problem into an anonymity problem: an unlabelled icon is
a control the reader must hover to identify.

### 12.3 Every invoking surface prints the name and the chord

Wherever a command is rendered — Command Bar button, palette row, context-menu item, block-action
button, rail entry — the surface prints:

| What                | From                     | Rule                                                                      |
| ------------------- | ------------------------ | ------------------------------------------------------------------------- |
| The name            | `Command.title`          | the accessible name, even when the control shows only an icon             |
| The chord           | `keymap.formatBinding()` | platform-formatted by ONE function — never a hardcoded `⌘P` in a template |
| The disabled reason | `Command.requires`       | the tooltip on a disabled control, the grey subtitle on a palette row     |

Consequences:

- **No unlabelled icon** without its command title as accessible name and its binding in the tooltip.
- **No context-menu row without its chord** when the command has one.
- **No surface renames a command.** A placement chooses _whether_ to show a record; it never chooses
  what it is called, when it is available, or what it does.
- **A control that cannot act renders disabled with `requires` in its tooltip**, never absent (§10)
  — and the palette shows unavailable commands greyed with the same sentence rather than hiding
  them, because "why can't I" is the question a palette is uniquely good at answering.
- **`destructive: true` derives the danger styling**, and `group` derives menu ordering
  (`"1_clipboard"`, `"3_structure"`, `"9_danger"`); neither is re-decided per menu.

### 12.4 One surface, one availability rule

**Every command in a family that acts on the same state declares the SAME precondition.** A family
is defined by what its `run` WRITES, not by its id namespace: five zoom verbs over one pan-zoom
surface, three publish verbs over one deploy provider, twenty-one element verbs over one document
tree.

Six families disagreed with themselves, and in every one the loose member was the one that wrote:

| Family             | The disagreement                                                                        | What the loose member did                                     |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `git.*`            | `createGithubRepository` had no `enablement`; `push` required a repo                    | Created a repository on GitHub, then failed to add the remote |
| `publish.*`        | The host-capability term appeared in one record of three                                | Pushed the branch, then failed to reach Cloudflare            |
| Element tree       | Delete/Duplicate required a canvas editor; the movers and the menu's writes did not     | Spliced elements into `project.json` from the Outline         |
| Dock tab selectors | `panel.focus.*` composed the panel's own `when`; the enum setters did not               | Persisted a tab whose panel is registered `when: () => false` |
| Inspector tabs     | `view.setRightTab` required a document; the `inspector.focus.*` chords required nothing | Reported success, moved focus, did not switch the tab         |
| `collab.*`         | Four required a document path; `showStatus` required only a tab                         | Reported on a session that cannot exist                       |

Two rules over one surface is not caution. The strict member's refusal is evidence that the state
is unsafe to write, and the loose member writes it anyway — so the disagreement converts a refusal
that protects into a refusal that merely annoys, while the damage goes through the other door.

**The agent counts as a surface.** `Command.aiTool` says "the human's gate and the agent's gate
stay one predicate", so an assistant tool that writes what a command writes is bound by the
command's rule — and binds to it by READING the same `CommandContext`, not by recomputing the same
test. Two predicates that agree today drift the first time either is edited. The assistant's
`document` tier asked only whether a tab was open, so with Project Settings focused the agent was
advertised `remove_node` and `move_node` and ran them against `project.json` while the person's
`delete_node` was refused; `remove_node`'s own guard stops at the document root, which is weaker
than `structurallyEditable`, so a repeater template was removable by the agent and not by the
person. Element-tree writers now sit in a `document-tree` tier whose predicate is the registry's
own `editor.kind === "canvas"`. Reads are not affected: the rule is about writing.

Corollaries:

- **An `enablement` never restates its own `when`.** The same rule written twice is two places to
  drift, and the drift is invisible because both spellings look deliberate.
- **A `requires` sentence names the gate it actually has.** `canvas.setFit` said "an open document"
  while refusing for the MODE, which sends the reader to open a document they already have open.
- **When a precondition depends on an ARGUMENT, refuse the argument.** `enablement` cannot see one,
  so a setter taking an enum checks the target's own predicate inside `run` and throws a
  `RangeError` naming the value — the shape `pane.derive` uses for a preset the document cannot
  support.

### 12.5 A second list of actions is a defect

If a surface maintains its own array of `{ label, action }` records for capabilities that already
exist, that array is the bug — not a shortcut around one. The symptom is always the same: two
surfaces disagree about one capability. `Cmd+W` refusing to close the last tab while the tab strip's
`×` closed it happily is the canonical example, and it is exactly what one record with one chord and
one `run` makes impossible.

## 13. Notification Tiers

**Status:** Partial — the three tiers and their surfaces ship; the Diff and Logic tabs of the Bottom
dock are declared and empty.

The normative contract is `specs/studio.md` §16. This section governs how those records are
_rendered_ — what each tier looks like, and the rules a reviewer applies when someone proposes a
fourth one.

### 13.1 Choosing a tier

The question is never "how bad is this?" — it is **what does the reader have to do?**

| The reader…                         | Tier    | Because                                                 |
| ----------------------------------- | ------- | ------------------------------------------------------- |
| needs to know, and can carry on     | toast   | it retires itself; nothing is owed                      |
| must fix something before moving on | Problem | it must outlive the frame the reader was not looking at |
| typed a value the app cannot accept | inline  | the value is on screen; nothing else is the right place |

Severity picks the default tier and the call site overrides it. Severity is not the tier: a warning
that must be fixed is a Problem, and an error the user cannot act on is a toast with a `detail`.

### 13.2 Rendering rules

- **Four toasts at most, newest at the bottom.** Beyond that the oldest retires early — a stack that
  grows without bound is a wall, and a wall is not read.
- **Success and info rest for 4s, warnings and errors for 8s.** A reader who has to decide gets
  twice as long as a reader who is being told.
- **One line of text, one glyph.** A toast is a sentence, not an illustration; anything longer
  belongs in `detail`, which is a Problem's second line.
- **The recovery button prints the command's own title.** Never a bespoke verb — the button and the
  palette row must be the same words, because they are the same command.
- **A Problem row states its source and its path**, and clicking it goes there. A Problem nobody can
  navigate from is a log line with better typography.
- **An inline error renders after the control, with `role="alert"`, and takes precedence over a
  warning state on the same row.** Where a row can carry several, it counts them from two up.

### 13.3 The rules that keep this from becoming a fourth surface

1.  **The status bar never carries an outcome.** It is ambient state. This is the single rule that
    the 78-call-site predecessor broke, and every regression here starts by breaking it again.
2.  **A modal is not a notification.** Blocking is reserved for an operation that cannot proceed
    while the author edits — in practice, dependency installation — and even then it offers to run
    in the background. Everything else reports and gets out of the way.
3.  **Nothing is announced twice.** An operation with an Activity entry does not also toast its
    completion; a failure raises exactly one Problem, deduped by `key`.
4.  **Timed surfaces declare themselves to `probe.idle()`.** A toast settling in is not idle; a toast
    at rest is. Without the second half of that sentence a screenshot run would wait forever on a
    toast that is deliberately being held open.

---

## Changelog

- **0.3.8** (2026-08-13) — A row wraps and never overflows (§4.6); the floating bar's visibility rule.
- **0.3.7** (2026-08-12) — blockbar/format joins the level × placement matrix, with its own chrome budget.
- **0.3.6** (2026-08-10) — §12.4 the agent counts as a surface — an assistant tool that writes what a command writes binds to the command's rule by reading the same CommandContext, not by recomputing it; the element-tree writers move to a document-tree tier gated on the registry's own editor.kind.
- **0.3.5** (2026-08-10) — §12 a command family over one surface declares ONE availability rule — six families disagreed with themselves, and in each the loose member was the one that wrote: git.createGithubRepository created a remote repository where its disabled peer git.push would not, publish.deploy pushed on a host with no Cloudflare API, the Outline's movers and the element menu's mutating rows spliced elements into project.json where Delete was correctly refused, view.setActivity persisted a gated-off panel, and the inspector.focus chords half-applied.
- **0.3.4** (2026-08-05) — §9.2 history covers project documents — a settings mistake undoes like a document mistake, and a failed write leaves no entry.
- **0.3.3** (2026-08-05) — §8.1 corrects where accumulate is authored — the canvas toggles a node into the selection too; only the marquee is absent.
- **0.3.2** (2026-08-04) — §4.2 the set dot is the provenance chip's set-here state, in four states with the donor named; §8.1 selection is a list, with the anchor/primary rule and the one-transaction requirement.
- **0.3.1** (2026-08-04) — §13 Notification Tiers — choosing a tier by the action required, the rendering rules, and the four rules that keep feedback from becoming a fourth surface.
- **0.3.0** (2026-08-02) — Empty States and Copy (§11); Command and Menu Rendering Rules incl. the level × placement matrix (§12).
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
