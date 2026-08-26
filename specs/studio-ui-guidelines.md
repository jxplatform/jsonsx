# Jx Studio UI/UX Interface Guidelines

**Version:** 0.3.15
**Status:** Implemented
**Updated:** 2026-08-26
**Applies to:** `packages/studio/`

---

## 1. Design System Foundation

Jx Studio builds on **Adobe Spectrum Web Components** (`@spectrum-web-components/*`) at `scale="medium"`. All UI chrome uses Spectrum components; the canvas renders content via the Jx runtime on a light background in **both** chrome themes — a document is a document, and does not follow the chrome.

The chrome ships two themes, `color="dark"` (the default the app boots in) and `color="light"`, chosen in Preferences → Appearance. Each is a Spectrum colour fragment, and **a theme named in `CHROME_THEMES` must have its fragment registered in `src/ui/spectrum.ts`**: `<sp-theme>` adopts the fragment registered under the `color` it is given and silently adopts none for a name it does not know, which leaves every `--spectrum-*` colour token undefined and the chrome unchanged. That is not a hypothetical — it is how Light shipped as a setting that did nothing.

### 1.1 Theme Tokens

Use CSS custom properties from `:root` — never hardcode color values.

> The **Fallback** column is checked against `styles/tokens.css` by `packages/studio/scripts/check-styles.ts`, and the check is why the values below are right. Seven of them had been wrong for months — this table named `#1e1e1e` for `--bg` where the app had shipped `#111111` since the brand ramp landed — so anyone designing against the documented palette was designing against one that no longer existed. A correction without a gate only resets the clock.
>
> Every token below is a reference to a Spectrum token, so it is the **declaration** that is the contract and the fallback that is merely checkable. The fallbacks are the dark ramp because dark is what the app boots in; under `color="light"` the same declarations resolve to the light ramp in `src/ui/jx-theme.ts` (`--bg` `#f4f4f5`, `--bg-panel` `#ffffff`, `--fg` `#27272a`, `--accent` `#2563eb`) with nothing in `tokens.css` branching on the theme. A token that has to be spelled twice, once per theme, is a token that belongs in the brand fragment instead.

| Token         | Purpose                           | Fallback                                                                |
| ------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `--bg`        | App background                    | `#111111`                                                               |
| `--bg-panel`  | Panel background                  | `#1a1a1a`                                                               |
| `--bg-input`  | Input field background            | `#1a1a1a`                                                               |
| `--border`    | Borders and separators            | `#222222`                                                               |
| `--fg`        | Primary text                      | `#e4e4e7`                                                               |
| `--fg-dim`    | Secondary text (labels, hints)    | `#a1a1aa`                                                               |
| `--accent`    | Interactive elements, focus rings | `#3b82f6`                                                               |
| `--accent-fg` | Text on accent backgrounds        | `#ffffff`                                                               |
| `--danger`    | Destructive actions, errors       | `#f44747`                                                               |
| `--success`   | Positive states                   | `#89d185`                                                               |
| `--warning`   | Caution states                    | `#c5a332`                                                               |
| `--radius`    | Standard border radius            | `3px`                                                                   |
| `--hover-bg`  | Hover overlay                     | `color-mix(in srgb, var(--spectrum-gray-900, #fafafa) 5%, transparent)` |

**Accent opacity variants** for backgrounds:

- `--accent-8` through `--accent-50` — use `color-mix(in srgb, var(--accent) N%, transparent)`

**Semantic tokens** for domain-specific highlighting:

| Token        | Purpose                               |
| ------------ | ------------------------------------- |
| `--tag`      | Element tag names (`#93c5fd`)         |
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

Studio defines exactly two custom elements, both `LitElement`, both registered from the manual
table in `src/ui/spectrum.ts` — there are no decorators anywhere in the package.

| Element             | Class             | File                       | Purpose                                                     |
| ------------------- | ----------------- | -------------------------- | ----------------------------------------------------------- |
| `jx-value-selector` | `JxValueSelector` | `src/ui/value-selector.ts` | Dual-mode picker/combobox: snaps to an option, or free-text |
| `jx-color-popover`  | `JxColorPopover`  | `src/ui/color-selector.ts` | Colour area, sliders and swatches, kept in sync             |

**`jx-value-selector` API:**

- Properties: `value`, `placeholder`, `size`, `.options` (array)
- Options format: `{ value, label, style? }` or `{ divider: true }`
- Events: `change` (selection), `input` (typing)
- Mode: auto-switches between `sp-picker` (value matches an option) and textfield-plus-dropdown

**Both render into the light DOM** — `createRenderRoot() { return this; }` — and every new element
must. Spectrum's theming reaches its descendants through `sp-theme`, and the whole 232 KB chrome
stylesheet under `styles/` is written against a light tree; a shadow root cuts both off. That is
also why `static styles` is not used here: the design system is one cascade, not per-component.

Everything else in the shell is a plain function returning a `lit-html` template, rendered by its
own module into its own root. A component class earns its keep when a surface owns local state that
no store should hold — which is what both of these do — and not otherwise.

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

> **Status: Partial.** Selection and the canvas caret are built. **Drag and drop has no
> non-dragging alternative**: the drag surface declares no roles, installs no keyboard path, and
> announces nothing, so every reordering and insertion it offers is unavailable without a pointer.
> The tree and layers panels are the counter-example — both carry full roving-tabindex keyboard
> navigation — which is why the gap is a gap rather than a house style. See §14.

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

#### Moving without dragging (WCAG 2.2 SC 2.5.7)

> **Status: Implemented.**

**Every move a drag performs is also reachable without one.** SC 2.5.7 asks that any function
operated by a dragging movement have a single-pointer alternative, and the alternative here is the
pair the editor already had: **cut** the node, select the destination, **paste**. Both are commands,
so both have a chord, a context-menu item and a palette entry; both run through the same document
mutation the drag does, and both report through `notify`, so a screen-reader user is told the move
happened.

Deliberately **not** an APG keyboard-drag mode. Building a grab/move/drop state machine would add a
mode with its own keys, its own escape semantics and its own announcements — a second way to do
something the editor can already do, and one more thing to keep correct. The cheaper answer is to
say plainly that cut and paste ARE the alternative, and to make sure they announce.

The block action bar's **Move up** / **Move down** cover the common same-parent case in one
keystroke, without a clipboard round trip.

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

### 8.4 Menus

Rendered with `sp-menu` inside `sp-overlay` / `sp-popover`, mounted through `renderPopover` (§8.7).
There are two triggers, and they are different contracts:

- **Right-click**, in the canvas or on a row. The menu appears at the pointer and is clamped into
  the viewport.
- **A menu button** — a control that opens a menu instead of running a command. It carries
  `aria-haspopup="menu"` and a live `aria-expanded`, and it prints no chord of its own, because the
  chords belong to the rows. The rail foot's ⚙ **Settings** is the worked example.

**A menu's rows come from a placement** (§12.1), never from an array beside the trigger (§12.5).
Dividers fall where the record's `group` changes — or, where a placement admits two levels, where
the **level** changes, which is the same boundary the Navigator rail draws between its own groups.

#### Submenus

A row may own a submenu. It is a second popover, and the levels form a stack:

- One submenu open at a time. Opening another, or entering a sibling row, closes the first.
- `ArrowRight` opens and moves in; `ArrowLeft` closes and returns focus to the parent row.
- `Escape` closes **one level** — the submenu if one is open, the whole menu otherwise. `Tab`
  dismisses everything.
- **Outside-click dismissal is one handler for the whole stack.** Per-popover dismissal treats a
  click in the submenu as outside the root, and removing the root's node means the submenu row's
  own `click` never arrives — so following a section silently does nothing.
- A submenu row is named by the **argument value** it passes, not by a reworded command title. That
  is state, so it does not violate §12.3.

> **A parent row that owns a submenu still runs its own command.** This is a deliberate deviation
> from the WAI-ARIA APG menu pattern, which gives such a row no action of its own, and it is why
> these menus are hand-rolled: Spectrum's stock `slot="submenu"` enforces the APG reading outright —
> `Menu.handlePointerBasedSelection` bails on `hasSubmenu` so the parent emits no `change`, and
> `MenuItem.handleSubmenuChange` reports the **parent's** value to the outer menu, which would break
> the deep link as well. Nothing is unreachable: Enter runs the row, ArrowRight reaches every child,
> `aria-haspopup` announces the popup, and every child has a second door of its own. Recorded again
> in §14.

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

**There is no root render, and no central dispatcher.** The description this section used to carry —
an `update()` that selectively re-renders three regions — has not matched the code for some time.
What actually runs is about thirty independent pairs, each a module-scope `effectScope` holding one
`effect()` that reads its own dependency list and calls one `litRender()` into its own host.

`store.ts` additionally keeps a name-to-callback registry — `registerRenderer` / `render()` /
`renderOnly(...)` — but it holds only seven entries, all registered from the bootstrap, and the
bootstrap calls it "compat during migration". Every surface added since (statusbar, toolbar, activity
bar, tab strip, jump bar, pane context, pane grid, bottom dock, the assistant, settings, library) is
driven by its own effect alone. `render()` coalesces nothing: two calls in one tick paint twice.

Three schedulers sit between an effect and its `litRender`, and each exists for a reason worth
knowing before adding a fourth:

- `panels/panel-scheduler.ts` coalesces to one animation frame **and withholds a repaint entirely
  while a text input inside the panel root has focus**, publishing `data-jx-stale` on the host while
  it does. Without it, a repaint mid-typing truncated or dropped characters.
- `panels/overlays.ts` coalesces on a microtask.
- `panels/ai-panel.ts` runs its own frame loop and deliberately BYPASSES the focus guard, so a
  streaming reply repaints while the composer is focused.

Re-render granularity is therefore per-surface, not per-app. Below that, per-pane canvas state lives
on the pane's `CanvasSurface`, and below THAT an edit usually causes no render at all — the canvas
patcher classifies the operation and posts it to the iframe instead (`studio.md` §4).

Module-local state (Sets, variables) persists across renders and does not need to go through the
state system.

### 9.4 Template Conventions

> **Status:** Implemented

The template is the only writer of what it renders. Both halves of that have been broken in shipped
code, so both are gated by `packages/studio/scripts/check-lit-conventions.ts`, which carries a
ratcheting backlog per rule and fails both ways — a new occurrence fails, and an entry left behind
after its site is fixed fails too.

| Convention                                             | Instead of                                        |
| ------------------------------------------------------ | ------------------------------------------------- |
| `createRef()` + `ref()` for a node this module renders | `querySelector` at call time                      |
| `@event=` on a node this module renders                | `addEventListener` after render                   |
| `classMap({ … })`                                      | a class attribute built by string concatenation   |
| `styleMap({ … })`, with **hyphenated** keys            | a `style` attribute built by string concatenation |
| `repeat(items, keyFn, tpl)` for a keyed collection     | `.map()` where children hold state or reorder     |
| `.value=${live(v)}` on a Spectrum control              | `value=${v}`                                      |
| `guard([id], …)` around a third-party mount            | relying on the template shape staying the same    |

**Spectrum controls bind their own state as a live property.** `sp-textfield`, `sp-picker`,
`sp-search`, `sp-switch`, `sp-checkbox` and `sp-accordion-item` all move `value` / `checked` / `open`
themselves when the reader touches them, and none of them reflects that back to the attribute. So an
attribute binding is committed once and then dirty-checked away on exactly the render that needed to
correct it — the control keeps a value the document does not have, silently. `live()` compares
against the live property instead.

**A module holds its own nodes.** A node found by selector is real only until the next render
replaces it, and with a second pane open the query can return the other pane's copy. `ref()` is how
you get a handle; `src/panels/target-line.ts` states the rule at its definition site. This does not
object to imperative USE — measuring, scrolling into view, moving focus — only to re-finding the
node each time instead of holding it.

**Hyphenated `styleMap` keys are load-bearing.** `check-styles.ts` finds `font-size:` and
`border-radius:` textually, so `styleMap({ fontSize: "12px" })` is invisible to the token nudge while
`styleMap({ "font-size": "12px" })` is not. Converting a literal class name to a computed one has the
mirror effect on the orphan rule.

**Where the rules stop.** `src/canvas/**` is imperative by design, not by neglect: the patcher exists
so that nothing re-renders on an edit, the overlay places boxes per pointer-move against measured
geometry, and the iframe modules run in a realm lit does not reach. Those modules are named in the
gate's `EXCLUDED` map with the reason, so the exemption is a statement rather than a gap.

**LitElement adoption is deferred, deliberately.** Four reasons, recorded so the question restarts
from them: shadow DOM is already excluded (§6.2), which removes most of what the component model
buys; `@vue/reactivity` owns the update model and is version-pinned to `@jxsuite/runtime`, so
`@lit/context` would sit beside it rather than replace it; `probe.idle()` — the predicate that
replaced 115 sleeps, and the foundation of the screenshot lane — would gain a second settling
condition it cannot see in every element's `updateComplete`; and every defect found in the last audit
of the template layer was fixed by a binding, a key or a ref.

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
- [ ] Spectrum controls bind the state they move themselves as `.value=${live(v)}` / `.checked=` /
      `.open=` — never as a plain attribute (§9.4; an attribute binding is dirty-checked away on the
      render that needed it)
- [ ] A node this module renders is held with `ref()`, not re-found with `querySelector` (§9.4)
- [ ] A list whose children hold state or can reorder uses `repeat()` with a real key — a canvas
      iframe, a `details` the reader opened, or a field mid-edit is not index-addressable (§9.4)
- [ ] A container handed to a third-party widget (Monaco, Tabulator) is `guard()`ed on the identity
      it belongs to, so no repaint can take it back (§9.4)
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
- [ ] A control that opens a MENU carries `aria-haspopup="menu"` and a live `aria-expanded`, prints
      no chord of its own, and draws its rows from a placement (§8.4, §12.1, §12.5)

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

| Placement             | Admits levels                             | Why                                                                                                                                                         |
| --------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commandbar/primary`  | application, document                     | document only for Save / Undo / Redo / Open in Browser, by frequency; ≤5 total                                                                              |
| `commandbar/overflow` | application, project, document            | never selection — the Command Bar is not a selection surface                                                                                                |
| `statusbar/project`   | project                                   | the status bar's left field                                                                                                                                 |
| `statusbar/document`  | document                                  | the status bar's centre field                                                                                                                               |
| `statusbar/selection` | selection                                 | the status bar's right field                                                                                                                                |
| `context/element`     | selection                                 | the canvas element menu acts on a selection                                                                                                                 |
| `context/file`        | project                                   | a file row addresses the project's file set                                                                                                                 |
| `context/layer`       | selection                                 | an outline row IS a selection                                                                                                                               |
| `context/tab`         | document                                  | a tab addresses one document                                                                                                                                |
| `context/pane`        | document                                  | a pane hosts one document                                                                                                                                   |
| `blockbar`            | selection                                 | the floating bar owns selection-scoped verbs                                                                                                                |
| `blockbar/format`     | selection                                 | the bar's inline-format cluster — a range inside the selection is the selection                                                                             |
| `outline/row`         | selection                                 | row actions act on the row's node                                                                                                                           |
| `settings/menu`       | application, project                      | the rail foot's gear menu — the settings family; a menu prints each row's own name, chord and gate, so it may host two levels as `commandbar/overflow` does |
| `palette`             | application, project, document, selection | the level-agnostic surface; it groups its rows by level                                                                                                     |
| `never`               | application, project, document, selection | keyboard- and API-only; there is no rendered surface to be misplaced in                                                                                     |

`blockbar/format` is one surface with two budgets, and that is why it is a row rather than a note.
The bar's verb cluster is capped at five (`CHROME_BUDGET.commandbarPrimary`'s sibling), and the
inline-format vocabulary is eight — Bold, Italic, Underline, Strikethrough, Superscript, Subscript,
Code, Link — so sharing one cap would have pushed Bold behind a `⋮`. Same level, same region,
separate budget: the status bar's three single-level placements are the precedent.

`settings/menu` is the second row admitting more than one level, and the reason is the same one
`commandbar/overflow` has: a **menu** prints each row's own name, chord and gate beside it, so
nothing about a row's level has to be inferred from where the control sits. A **pinned slot** cannot
do that — it has room for one thing and must lie about the rest by omission, which is why the rail's
foot held only application-level Preferences for a release while project configuration lived
elsewhere. The levels are still separated, in two places: the row admits exactly application and
project, and the menu draws a divider where the level changes. The rail's **pinned** groups stay
single-level, in `PANEL_PLACEMENT_MATRIX` — a panel is filed by what it writes, and there is no menu
to say so for it.

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
- **A row that owns a submenu still runs its own command.** The submenu is opened by hover,
  ArrowRight or the chevron — never by activating the row, which would leave the parent's own verb
  with no surface at all (§8.4).
- **A submenu row prints no chord.** The chord belongs to the command, and the parent already
  prints it; repeating it on every child would teach that each child has one of its own.

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

### 13.1a Every record is announced

> **Status: Implemented.**

**One live region, called from `notify()` itself.** WCAG 2.2 SC 4.1.3 asks that a status message be
programmatically determinable without receiving focus, and this app had one region — on the _toast_
host. Since `error` defaults to the **Problem** tier, that meant **a failure reached no live region
at all**: the app posted "Save failed", rendered it in a panel, and a screen-reader user was told
nothing.

A region inside the Problems panel would not have fixed it either. The panel lives in the Bottom
dock, and a region inside a hidden tab announces nothing — so the announcer belongs to no surface.
It is called where the record is created, which makes "posted" and "announced" the same event and
gives any future host the behaviour without having to remember.

Two regions, because politeness is not a style choice: an error is `assertive` and interrupts,
everything else is `polite` and waits. The attribute is read when a region is created rather than
when its text changes, so one region cannot serve both. The text is cleared and re-set on a later
turn, because a live region announces a _change_ — without that, a second identical failure would be
silent, which is the failure a reader would be least able to explain.

The message carries its `source` when it has one: a listener has none of the visual grouping the
panel's own column gives everyone else.

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

## 15. Documentation Screenshots

> **Status: Implemented.**

Every picture in `/docs` is captured by `scripts/screenshots/`, never taken by hand. The contract
governing what a shot may say lives in `scripts/screenshots/README.md`; this section records the one
thing that is a **standards** decision rather than a policy one.

**The pipeline drives the browser over [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/), not
CDP.** CDP is Chrome's own protocol and no standard describes it. Everything the pipeline asks of a
browser — viewport, media features, init scripts, navigation, evaluation, frame enumeration,
screenshots — is in BiDi, and the captured bytes are identical under both: the same shot captured
over each protocol, with everything else held equal, hashes the same. That equality was the
acceptance criterion, and it is what makes the switch a change of protocol rather than a change of
pictures.

**One thing did have to change, and it is the kind of difference worth writing down.** The pipeline
parked the pointer at `(-1, -1)` between shots so that nothing matched `:hover`. CDP accepted
off-canvas coordinates; **BiDi does not** — `input.performActions` refuses a move beyond the
viewport, and every shot failed the moment the pipeline spoke the standard's protocol. The pointer
now parks at the viewport's bottom-right corner, which has the property the negative coordinates
were chosen for and is a position the standard allows. A vendor protocol's tolerance is not a
contract; this is what depending on one looks like when you stop.

`JX_SHOTS_PROTOCOL=cdp` falls back, so a BiDi regression in a Chromium release costs one environment
variable rather than a revert.

## 14. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). Spectrum Web Components is a component library rather than a standard; §6 records which of its components are in use.

| Standard                                                                          | Class       | Binds            | Evidence                                                                                                                                                                                                                                              | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ----------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WAI-ARIA](https://www.w3.org/TR/wai-aria-1.2/)                                   | **Subset**  | §6, §8, §12      | packages/studio/src/files/files.ts, packages/studio/src/panels/layers-panel.ts, packages/studio/src/editor/context-menu.ts, packages/studio/src/panels/settings-menu.ts, packages/studio/src/panels/quick-search.ts, packages/studio/src/ui/layers.ts | `gap:apg-coverage` The tree, menu, toolbar and radiogroup patterns are implemented with their full state and keyboard contracts, and two more now are: the **combobox** (Quick Access carries `aria-controls`, `aria-activedescendant` and an `aria-expanded` that is false when nothing matched — it was the literal string `true`) and the **dialog** (`role`, `aria-modal` and a name off the wrapper's headline). The tab strips still carry no tab semantics, and the Tabulator data grid is virtualized — hand-authoring `role="grid"` over rows that do not exist in the DOM would make it worse, not better. One deviation from the menu pattern is deliberate and is recorded in §8.4: the rail foot's Settings menu gives a row that owns a submenu **an action of its own**, which the APG does not describe. It is the requirement rather than an oversight — the heading opens the surface and the submenu deep-links a section — and Spectrum's stock `slot="submenu"` forbids it outright, which is why that menu is hand-rolled. Nothing is unreachable: Enter runs the row, ArrowRight reaches every child, `aria-haspopup` announces the popup, and every child has a second door. |
| [Accessible Name and Description Computation](https://www.w3.org/TR/accname-1.2/) | **Adopted** | §10              | packages/studio/src/panels/problems-panel.ts                                                                                                                                                                                                          | §10's rule that a control carries exactly one accessible name — `title` and `aria-label` with the same string announce it twice — is this algorithm's precedence order restated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/)                                         | **Subset**  | §1.1, §8.2, §8.7 | packages/studio/src/services/announce.ts, packages/studio/styles/forced-colors.css, packages/studio/scripts/check-styles.ts, packages/studio/tests/announce.test.ts                                                                                   | `gap:wcag-conformance` No level is claimed, and conformance is not tested end to end — that needs a browser. Four criteria are met deliberately and checked: **SC 4.1.3** (Status Messages) — one live region, called from `notify()` itself, so a failure that lands in the Problems panel is still announced; **SC 2.5.7** (Dragging Movements) — cut/paste is the stated alternative to every drag; **SC 1.4.3/1.4.11** (Contrast) — a required-pairs table gated in `check-styles.ts`, with one entry on the debt list; **SC 1.4.1** — a `forced-colors` block redraws the selection and focus affordances Windows High Contrast deletes with `box-shadow`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [ATAG 2.0](https://www.w3.org/TR/ATAG20/)                                         | **Subset**  | §8, §13.1a       | packages/studio/src/services/announce.ts, packages/studio/src/services/a11y-report.ts                                                                                                                                                                 | Part A — the tool's own accessibility — is answered by §13.1a's live region and §8.2's keyboard alternative to every drag. Part B is `studio.md` §16.6: a check over the author's document, filing a Problem per finding with its WCAG criterion. Neither part claims a conformance level, which needs a browser.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/)                           | **Adopted** | §15              | scripts/screenshots/lib/browser.ts, scripts/screenshots/lib/browser.test.ts, scripts/screenshots/lib/shot.ts                                                                                                                                          | The documentation screenshot pipeline drives Chromium over the W3C protocol rather than CDP. Verified by capturing the same shot over each with everything else held equal and hashing the results: byte-identical. The one behavioural difference — BiDi refuses a pointer move outside the viewport, where CDP allowed `(-1, -1)` — is fixed in the pipeline rather than worked around, and §15 records it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Changelog

- **0.3.15** (2026-08-26) — §8.4 becomes Menus: menu-button triggers, submenus and the APG deviation; §12.1 gains the settings/menu placement.
- **0.3.14** (2026-08-22) — Template conventions (9.4) and the gate behind them; render orchestration described as it is; custom components corrected to the two that exist.
- **0.3.13** (2026-08-21) — Chrome ships two themes; a theme in CHROME_THEMES must have its Spectrum colour fragment registered, and the semantic token table documents the dark fallbacks with the light ramp resolved from the brand fragment.
- **0.3.12** (2026-08-16) — §15 the documentation screenshot pipeline drives Chromium over WebDriver BiDi rather than CDP — byte-identical captures, and the one behavioural difference (a pointer move outside the viewport) fixed rather than worked around.
- **0.3.11** (2026-08-16) — §14 ATAG is Subset: Part A is §13.1a and §8.2, Part B is studio.md §16.6.
- **0.3.10** (2026-08-16) — §1.1 the token table's fallbacks are corrected and gated against tokens.css; §8.2 cut/paste is the stated alternative to every drag (SC 2.5.7); §13.1a one live region, called from notify() itself, so a failure that lands in the Problems panel is announced.
- **0.3.9** (2026-08-15) — Add §14 Standards Alignment; §8 marked Partial — drag and drop has no non-dragging alternative (WCAG 2.2 SC 2.5.7).
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
