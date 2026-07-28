# `@jxsuite/studio` Specification

## Visual Builder for Jx Documents

**Version:** 0.3.4-draft
**Status:** Partial
**Updated:** 2026-07-28
**License:** MIT

---

## 1. Overview

Jx Studio is a visual IDE for the development and management of local-first, statically compiled applications and websites which are composed and deployed via the Jx schema and pipeline. It renders a live canvas via the Jx runtime, provides a layer tree for structural editing, an inspector for property/style/state management, and a code editor for function bodies. The UI is built with Adobe Spectrum Web Components.

At the component level, Studio is a visual builder for individual Jx files. At the site level, it is a content management system — providing a project explorer, content collection browser, schema-driven entry editors, media management, SEO tooling, and redirect management. The full site-level architecture is specified in the companion [Site Architecture Specification](site-architecture.md).

---

## 2. Design Principles

1. **JSON is the source of truth** — Studio reads and writes `.json` files. No proprietary intermediate format.
2. **Canvas is the runtime** — The preview canvas renders via `@jxsuite/runtime`, showing exactly what users will see.
3. **Zero lock-in** — Studio edits produce standard Jx files. Any editor can open them.
4. **Self-hosting** — Studio is itself a Jx application served by `@jxsuite/server`.
5. **Developer-first** — Keyboard shortcuts, undo/redo, and code editing are first-class.

---

## 3. Architecture

### 3.1 Layout

Three-column layout:

| Column | Content                                    |
| ------ | ------------------------------------------ |
| Left   | Activity bar + panel (layers, files, etc.) |
| Center | Canvas (live preview) + Toolbar            |
| Right  | Inspector (properties, style, state, code) |

### 3.2 Data Flow

```
.json file → Studio state (immutable) → Canvas (runtime render)
                    ↓
            Inspector panels → mutation → new state → write .json
```

### 3.3 State Model

Immutable state with undo/redo history (100 entries). All mutations produce a new state object — no in-place edits.

**Key state operations** (from `state.js`):

| Operation                                         | Description                         |
| ------------------------------------------------- | ----------------------------------- |
| `createState(doc)`                                | Initialize from JSON document       |
| `selectNode(path)`                                | Select element by path              |
| `hoverNode(path)`                                 | Hover highlight                     |
| `undo()` / `redo()`                               | History navigation                  |
| `insertNode(path, def)`                           | Add child element                   |
| `removeNode(path)`                                | Delete element                      |
| `duplicateNode(path)`                             | Clone element                       |
| `moveNode(fromPath, toPath)`                      | Reorder/reparent                    |
| `updateProperty(path, key, value)`                | Set element property                |
| `updateStyle(path, prop, value)`                  | Set style property                  |
| `updateAttribute(path, key, value)`               | Set HTML attribute                  |
| `addDef(key, value)`                              | Add state entry                     |
| `removeDef(key)`                                  | Remove state entry                  |
| `updateDef(key, value)`                           | Update state entry                  |
| `renameDef(oldKey, newKey)`                       | Rename state entry                  |
| `updateMediaStyle(path, breakpoint, prop, value)` | Responsive style                    |
| `updateNestedStyle(path, selector, prop, value)`  | Nested CSS selector style           |
| `addSwitchCase(path, key)`                        | Add `$switch` case                  |
| `removeSwitchCase(path, key)`                     | Remove `$switch` case               |
| `pushDocument(doc)` / `popDocument()`             | Navigate into/out of sub-components |
| `projectState` / `setProjectState`                | File management state               |

### 3.4 Platform Abstraction Layer (PAL)

Studio uses a platform abstraction (`platform.js`) to decouple UI from backend:

| Method                   | Description                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `listFiles(dir)`         | List directory contents                                                                                    |
| `readFile(path)`         | Read file content                                                                                          |
| `writeFile(path, c)`     | Write file content                                                                                         |
| `deleteFile(path)`       | Delete file                                                                                                |
| `renameFile(old,new)`    | Rename/move file                                                                                           |
| `discoverComponents()`   | Scan project for custom elements                                                                           |
| `openProject()`          | Open project picker (unless `openProjectPicker: "repo-list"` routes it through Studio's repository picker) |
| `probeRootProject()`     | Auto-detect project at startup                                                                             |
| `createDestination`      | Whether New Project collects a folder (`"path"`) or a repository (`"repo"`) — see specs/desktop.md §4.5    |
| `createProject(opts)`    | Scaffold a project at the user-chosen `opts.destination`; never defaults a location                        |
| `pickDirectory?()`       | Native folder picker behind the modal's **Browse…** button (desktop only)                                  |
| `fetchProjectSchemas?()` | The active project's generated entry documents, PRE-BUNDLED (extensions.md §5.2) — drives §4.2.1           |

Three platform targets:

- **DevServer** (`platforms/devserver.js`) — Wraps `/__studio/*` fetch calls for Chrome-based development.
- **Desktop** (`@jxsuite/desktop`) — ElectroBun app with RPC to Bun process for native file I/O.
- **Cloud** (`platforms/cloud.js`) — Hosted sessions over the platform's session API; the backend
  composes per-project schemas in-Worker (extensions.md §5.5), so §4.2.1 holds there too.

Registration: `registerPlatform(impl)` at startup, `getPlatform()` for access.

### 3.5 Project Open

Studio supports opening projects via URL query parameter with absolute system paths:

```
http://localhost:3000/packages/studio/index.html?open=~/Development/jx/sites/jxsuite.com/project.json
```

The `?open=` path must point to a `project.json` file. On startup, Studio checks for this parameter, resolves the path via the PAL, and loads the project. This enables direct-linking to projects from terminals, scripts, and documentation.

### 3.6 Site Context

When a site project is loaded (via `?open=`, `openProject()`, or `probeRootProject()`), Studio resolves `project.json` and establishes a **site context** that applies globally to every file edited within that project:

| Inherited from `project.json` | Effect in Studio                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `$media` breakpoints          | Media tabs, responsive presets, and canvas panel widths reflect the site's breakpoints — not the individual file's |
| `style` (custom properties)   | Global CSS custom properties and stylesheet rules are applied to the canvas, stylebook, and component previews     |
| Component definitions         | The Components panel shows only components defined in the current project's `components/` and `$elements`          |
| `$head`                       | Global fonts, viewport, and other head entries are applied to canvas rendering                                     |
| `state`                       | Site-wide state entries are available (read-only) in the state explorer                                            |

When navigating between components, pages, and layouts within a project, the site context persists. Individual file `$media`, `$style`, and `$elements` merge on top of (not replace) site-level definitions. This ensures the canvas always shows what the file will look like in the context of the full site.

---

## 4. Canvas

### 4.1 Rendering

The canvas renders the current document using `@jxsuite/runtime`. It shows exactly what the component looks like at runtime — no simulation or approximation. When a site context is active (§3.6), the canvas applies the site's global styles, CSS custom properties, and media breakpoints so that every file is rendered in its true site context.

**Live data belongs to preview.** Edit and design mode suppress two classes of side effect that a full render would otherwise repeat: `timing: "server"` function resolution, and automatic (non-`manual`) `$prototype: "Request"` state entries. A full render re-resolves every `state` entry, so without the second gate an ordinary authoring action that escalates to a full render issued an HTTP request each time. Gated requests leave their state entry at its pre-fetch value — the same value bindings observe before any fetch resolves. Preview mode lifts both gates.

**Escalation to a full render** is the fallback when an edit cannot be applied surgically, and it is expensive: it re-runs the runtime, rebuilding every binding effect and reloading any embedded iframe. Structural splices (insert / remove / move) therefore escalate only on conditions that can actually break them — a `$switch` case or repeater-template path, an `innerHTML` parent, a missing children array, or an **immediate** parent that is a component instance (whose children may be rendered by the component rather than as light DOM). A component _ancestor_ is not a reason to escalate: these ops locate their target by its stamped path, and the one index-sensitive step reads the immediate parent's own children. This matters for real content, where markdown class-directive pages place every editable block inside a component.

Site style is injected into the canvas as a real stylesheet (custom properties in a `:root` rule, direct properties in a `body` rule, conditional `@--name` blocks resolved and — for scheme queries — dual-emitted per spec.md §9.5), never as inline root properties, so forced-scheme override selectors can win the cascade.

**Color-scheme preview.** When the effective `$media` declares a pure `prefers-color-scheme` query, the tab bar shows an Auto/Light/Dark control (one per tab; available in edit, design, and stylebook modes). Light/Dark force the scheme by setting `data-color-scheme` on the canvas iframe's root element — a patch-free document-level attribute flip that never re-renders; Auto removes the attribute and follows the OS. Scheme queries no longer render as generic feature toggles. The same tri-state also selects which scheme layer style-sidebar edits target (§6.2).

**Content-entry media.** A content entry references its media relative to ITSELF (`./images/hero.png`), and the built site serves those files from the content type's asset mount (`site-architecture.md` §9.3). Studio opens an entry as a standalone document, so the collection loader that normally performs that mapping never runs — the canvas would otherwise resolve the authored path against `canvas.html`. The render document is therefore mapped onto the mount before it is posted to the iframe, in every mode, so the canvas previews the URL production serves.

The mapping is render-only: the tab's source document keeps the authored relative reference, so serialization and the properties panel are unaffected. Parent-realm previews of the same values — the media picker's thumbnail — apply it too, since panel chrome would otherwise resolve them against `index.html`. Eligibility and URL math are shared with the loader; the browser cannot perform the loader's existence check, so a reference to a missing file maps optimistically and fails at the mount URL instead.

### 4.2 Modes

| Mode      | Description                                         |
| --------- | --------------------------------------------------- |
| Design    | Fluid document editing, with structural overlays    |
| Content   | Fluid document editing, for format-backed documents |
| Stylebook | Design token management and component gallery       |
| Preview   | Clean preview without editing chrome                |
| Source    | Raw JSON/code view                                  |

Design and Content are both **editable modes** and behave identically for text: the canvas carries a
live caret (§8.2). They differ only in what the document is — Content mode opens a format-backed
document (`.md` via its format class, §8.1), Design mode a native `.json` one.

#### 4.2.1 Source-mode schema validation

Source mode validates JSON against the ACTIVE project's generated entry documents
(extensions.md §5.2), fetched pre-bundled through `fetchProjectSchemas` (§3.4) on project
activation, after a `project.json` write, and on `extensions` changes. The bundled core schemas are
the offline fallback, and the same payload feeds the AI assistant's schema gate (ai.md §3.1) — one
fetch, so the two surfaces can never judge a file by different rules.

Resolution is entirely offline: Monaco's schema-request service stays disabled, and the schemas are
registered as inline objects. Each registers under BOTH its canonical `https://jxsuite.com/…` URI
(with the `pages|layouts|components|elements` fileMatch globs) and the `file:///project.schema.json`
/ `file:///document.schema.json` id that a file's own relative `$schema` resolves to — an
in-document `$schema` overrides fileMatch entirely, so without the second registration a bound file
resolves to an empty schema and is not validated at all. Models mount at
`file:///<project-relative-path>` so those pointers resolve against the file's own directory; the
two generated entry documents mount under a reserved prefix instead, because a model URI equal to a
registered id un-registers that schema when the model is disposed.

Monaco's web workers are resolved relative to the studio bundle's own URL. No worker means no
language service and therefore no diagnostics at all — silently — so each host must ship
`workers/*.worker.js` beside the bundle it serves.

### 4.3 Pan, Zoom, and Centering

The design canvas supports pan and zoom:

- **Pan**: Middle-click drag or Space+drag
- **Zoom**: Ctrl+scroll wheel, pinch gesture, or toolbar controls
- **Fit to view**: Intelligent centering of documents on load and window resize
- **Responsive presets**: Width presets matching `$media` breakpoints

### 4.4 Block Action Bar

Unified floating action bar (Gutenberg-style) attached to the selected element:

| Control           | Description                                          |
| ----------------- | ---------------------------------------------------- |
| Parent selector   | Navigate up to parent element (back icon)            |
| Tag indicator     | Shows tag name or `$id`                              |
| Drag handle       | The ONLY canvas drag source (§8.2.4)                 |
| Move up/down      | Reorder within parent                                |
| Inline formatting | Bold/italic/code/link, for blocks that accept markup |

The bar has ONE shape. The formatting group is present whenever the selected block can carry inline
markup — that is, whenever its element metadata declares `$inlineActions`. It is not gated on an
editing session, because there is none (§8.2).

Formatting applies to a range, so the buttons are disabled for a collapsed caret and for a block
selected without a caret at all (from the layers panel, or by a structural edit moving the
selection). Component instances and prop-bound blocks have no group: a component tag declares no
inline actions, and prop-bound text is a single plain string.

---

## 5. Left Panel

### 5.1 Activity Bar

Vertical tab strip for switching panel views:

| Tab            | Icon       | Panel                   |
| -------------- | ---------- | ----------------------- |
| Files          | folder     | Project file tree       |
| Layers         | layers     | Document structure tree |
| Components     | box        | Component library       |
| Elements       | view-grid  | HTML element palette    |
| State          | brackets   | State definitions       |
| Data           | data       | Data connections        |
| Head           | web-page   | Page meta and head      |
| Source Control | git-branch | Git source control      |

### 5.2 Layers Panel

Flattened tree of all elements in the document with indentation representing nesting depth. Each row shows element tag name, label, a grab affordance on hover, and — for the selected row — move controls and a delete button.

**Drag and Drop** — The entire layer row is draggable via Atlassian Pragmatic Drag and Drop. Users can grab any part of the row to drag; a grip glyph appears on hover to advertise it. Drop indicators show reorder (above/below) and reparent (make-child) targets.

**Move Action Buttons** — The **selected** non-root element row carries contextual move buttons. Selection rather than hover, because the buttons are Spectrum custom elements and building five of them for every visible row made the panel's render cost scale with document size; a click on a row both selects it and reveals its actions. The grab affordance is a plain glyph and therefore stays on every row.

| Button | Icon          | Action                                             | Shown when                                        |
| ------ | ------------- | -------------------------------------------------- | ------------------------------------------------- |
| Up     | `arrow-up`    | Move up among siblings                             | Not the first child                               |
| Down   | `arrow-down`  | Move down among siblings                           | Not the last child                                |
| In     | `arrow-right` | Nest into the previous sibling (become last child) | Previous sibling exists and is not a void element |
| Out    | `arrow-left`  | Un-nest from parent (place after parent)           | Has a grandparent (not already at root level)     |
| Delete | `close`       | Remove element from document                       | Always (non-root elements)                        |

Only applicable buttons render for each row's position in the tree. Clicking a move button updates the document, re-renders the layers panel, and tracks the selection to the node's new position.

**Rendering cost** — The flattened row list is produced by a single pre-order walk that appends into one accumulator, and "is an ancestor collapsed?" is answered by a running depth comparison over that pre-order sequence rather than by re-deriving each row's ancestor keys. Both exist so panel render time scales with the number of rows, not with rows × depth.

**Text Node Rows** — Bare string children appear as display-only rows with a "text" badge and truncated preview (max 40 characters). These rows do not support selection, drag, or action buttons.

### 5.3 Elements Panel

HTML element palette organized by category using Spectrum accordions (`sp-accordion` with `allow-multiple`). Each element displays as a full-width card with:

- **Live preview**: Actual DOM element rendered at natural browser sizes
- **Tag label**: Element tag name below the preview

Categories: Layout, Typography, Media, Form, Interactive, Semantic, Table.

Elements are drag-and-drop sources for inserting into the canvas.

### 5.4 Components Panel

Project component library discovered via the platform (`discoverComponents()`), scoped to the current site project. When a site context is active, only components from the project's `components/` directory and explicit `$elements` imports are shown — no components from other projects leak into the palette. Each component displays as a full-width card with:

- **Live preview**: Component rendered via `defineElement(url)` + `document.createElement(tagName)` through the runtime — real component instances, not placeholders
- **Tag label**: Component tag name below the preview

Components are drag-and-drop sources for inserting into the canvas.

### 5.5 Source Control Panel

Git-integrated source control panel providing commit, staging, branch management, and sync operations without leaving the studio. All git operations are performed server-side via `Bun.spawn(["git", ...])` and exposed through the PAL.

#### Layout (top to bottom)

1. **Toolbar** — Branch picker (`sp-picker`, quiet) + action button group (Fetch, Pull, Push, Refresh)
2. **Sync indicator** — Shows commits ahead/behind remote when applicable
3. **Commit area** — Multi-line text field with `Ctrl+Enter` to commit + Commit button
4. **Staged Changes** — Section with file list and per-file Unstage button; section header has Unstage All button
5. **Changes** — Section with unstaged/untracked files; per-file Stage and Discard buttons; section header has Stage All button

#### File Rows

Each file row displays:

- **File name** — basename of the changed file
- **Directory** — parent path in subdued text
- **Action buttons** — hover-revealed Stage (+), Unstage (−), Discard (↩) buttons
- **Status badge** — single-character badge with color coding:

| Badge | Color  | Meaning   |
| ----- | ------ | --------- |
| M     | Yellow | Modified  |
| A     | Green  | Added     |
| D     | Red    | Deleted   |
| R     | Blue   | Renamed   |
| U     | Green  | Untracked |

#### Branch Management

The branch picker lists all local branches and includes a "+ New branch..." option that opens a New Branch dialog (`showPromptDialog`, studio-ui-guidelines.md §8.7) and creates + checks out the branch on confirm. Cloning a repository asks for its URL through the same dialog.

#### Server Endpoints

| Endpoint                      | Method | Purpose                          |
| ----------------------------- | ------ | -------------------------------- |
| `/__studio/git/status`        | GET    | Branch info + changed files list |
| `/__studio/git/branches`      | GET    | List local branches              |
| `/__studio/git/log`           | GET    | Recent commit history            |
| `/__studio/git/stage`         | POST   | Stage files                      |
| `/__studio/git/unstage`       | POST   | Unstage files                    |
| `/__studio/git/commit`        | POST   | Create commit with message       |
| `/__studio/git/push`          | POST   | Push to remote                   |
| `/__studio/git/pull`          | POST   | Pull from remote                 |
| `/__studio/git/fetch`         | POST   | Fetch from remote                |
| `/__studio/git/checkout`      | POST   | Switch branch                    |
| `/__studio/git/create-branch` | POST   | Create and checkout new branch   |
| `/__studio/git/diff`          | GET    | File diff                        |
| `/__studio/git/discard`       | POST   | Discard unstaged changes         |

#### Auto-refresh

Status is fetched on tab activation and after every git operation. A 30-second polling interval refreshes status while the tab is active.

#### PAL Methods

All git operations are exposed as PAL methods (`gitStatus()`, `gitCommit(message)`, `gitPush()`, etc.) so the desktop platform can implement them via native RPC instead of HTTP.

---

## 6. Inspector (Right Panel)

### 6.1 Property Panel

Displays and edits element properties (`tagName`, `className`, `textContent`, etc.) with auto-generated controls based on property type.

#### Component Props Widget Selection

When a Jx component is selected, the property panel renders its declared `state` entries as form controls. Widget selection priority:

1. `format` → format-specific control (see table)
2. `type === "boolean"` → checkbox
3. `type === "number"` → number field
4. `type` has enum/union → combobox (`jx-value-selector`)
5. Fallback → text field

| `format`  | Control                                                          |
| --------- | ---------------------------------------------------------------- |
| `"image"` | `renderMediaPicker()` — thumbnail + upload + file browser (§9.3) |
| `"date"`  | Text field with `placeholder="YYYY-MM-DD"`                       |
| `"color"` | Color picker (reuses style panel `renderColorSelector`)          |

Each prop also supports dynamic values via the shared dynamic-slot mode button beside its label (caps: literal / `$ref` / `${}` template). Cycling to `$ref` replaces the widget with a signal picker listing available `state` entries; each mode's former value is remembered for the session, so cycling back restores it.

### 6.2 Style Sidebar (Metadata-Driven)

Organized, metadata-driven style sections. Metadata loaded from `css-meta.json` (JSON Schema definitions for each CSS property).

#### Sections

| Section     | Properties                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Layout      | `display`, `flexDirection`, `flexWrap`, `alignItems`, `justifyContent`, `gap`, `gridTemplateColumns`, `gridTemplateRows` |
| Spacing     | `margin*`, `padding*`                                                                                                    |
| Positioning | `position`, `top`, `right`, `bottom`, `left`, `zIndex`                                                                   |
| Typography  | `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `textAlign`, `color`, `textDecoration`                             |
| Background  | `backgroundColor`, `backgroundImage`, `backgroundSize`, `backgroundPosition`                                             |
| Border      | `border*`, `borderRadius`, `outline`                                                                                     |
| Effects     | `opacity`, `boxShadow`, `transform`, `transition`, `cursor`, `overflow`                                                  |
| Other       | Unlisted properties                                                                                                      |

#### Input Types

| Schema pattern       | Control              |
| -------------------- | -------------------- |
| `"type": "string"`   | Text field           |
| `"enum": [...]`      | Select dropdown      |
| Number with unit     | Number + unit picker |
| Color values         | Color picker         |
| Shorthand properties | Expandable group     |

#### Color Picker

Inline color editing via Spectrum color components (`sp-color-area`, `sp-color-slider`, `sp-swatch`, `sp-textfield`). Features:

- Swatch button opens popover with color area + hue slider + hex text field
- All three controls stay in sync — area, slider, and text field update each other in real time
- Hex values always `#`-prefixed for valid CSS
- Right panel swatch and field update live during color picking (bypasses focus-guard optimization in `_update`)

#### Font Family (Combobox with Modern Font Stacks)

The `fontFamily` property uses the `jx-styled-combobox` component — a dual-mode control that automatically switches between text input (combobox) and predefined selection (picker) modes based on whether the current value matches a known option.

**Modern Font Stacks:** Preset font stacks from `css-meta.json` (e.g. "Geometric Humanist", "Classical Humanist") are listed as dropdown options. These are not literal font names — they are aliases for multi-font fallback stacks.

**Styled font options:** Every font option renders in its own typeface via inline `font-family` styles on each menu item. This gives users a live preview of each font before selecting. In picker mode, the picker element itself displays the current font style.

**Option grouping:**

1. **Local project font variables** — `--font-*` custom properties already defined in the document root style appear first
2. **Divider** — separates local from global
3. **Global presets** — Unadded modern font stack presets from `css-meta.json`. Presets already instantiated as local variables are excluded from this section.

**Selection flow:**

1. User selects a preset (e.g. "Geometric Humanist") from the dropdown
2. The system creates a CSS custom property on the document root style (e.g. `--font-geometric-humanist: "Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif"`)
3. The selected element's `fontFamily` is set to `var(--font-geometric-humanist)`
4. If the variable already exists in the document root, step 2 is skipped

**Existing font variables:** Variables already defined in the document root (`--font-*`) appear at the top of the dropdown. Selecting one assigns `var(--name)` without creating a new variable.

**Free-text entry:** Typing a plain font family string (e.g. "serif", "Arial, sans-serif") sets the value directly — no `var()` wrapping.

**Mode switching:** When the current value matches a dropdown option (e.g. a `--font-*` variable name), the component renders as a native `sp-picker`. Selecting "—" clears the value and returns to combobox mode.

#### `jx-styled-combobox` Component

A custom LitElement (no shadow DOM) used across all dual-mode style inputs. Replaces the former `sp-combobox` (which stripped inline styling) and the ad-hoc manual overlay pattern.

**Properties:**

- `value` (String) — current value
- `placeholder` (String) — placeholder text for combobox mode
- `size` (String) — Spectrum sizing token (e.g. `"s"`)
- `options` (Array) — `[{ value, label, style? }, { divider: true }, ...]`

**Events:** `change` (on menu selection), `input` (on textfield typing)

**Modes:**

- **Picker mode** (`value` matches an option) — renders `sp-picker` with styled items + "—" clear option
- **Combobox mode** (`value` is empty/custom) — renders `sp-textfield` + `sp-picker-button` + `sp-overlay` + `sp-popover` + `sp-menu` with styled items

**Width matching:** The combobox popover width matches the trigger width via `@sp-opened` handler, replicating `sp-picker`'s internal `containerStyles` behavior.

**Used by:** `renderKeywordInput` (fontWeight, fontStyle, fontVariant, textTransform, textDecoration), `renderComboboxInput` (fontFamily), `renderSelectInput` (enum properties).

#### Conditional Display (`$show`)

Properties conditionally appear based on other property values (e.g. flex properties when `display: flex`).

#### Media Breakpoint Tabs

Tabs for each `$media` breakpoint, allowing responsive style editing per breakpoint. The media tabs and pseudo-selector share a single compact toolbar row — tabs on the left, selector picker on the right (quiet `sp-picker`).

Color-scheme variants add **no extra tabs**: the tab-bar Auto/Light/Dark control (§4.1) is the one scheme switch per tab. While a scheme with a matching declared scheme query is forced, Base-context reads and commits target that scheme's `@--name` block through the same media-style mutations, a "… variant" badge beside the tabs marks the active layer, and base values show through as inherited placeholders. Size-breakpoint tabs stay breakpoint-scoped regardless of the toggle — scheme × breakpoint compound blocks are not supported (spec.md §9.5's pure-query limitation).

#### Nested Selector Context

Nested CSS selectors (`:hover`, `:focus`, `:active`, `& childTag`) are editable as separate style contexts. The selector picker is inline in the media tabs toolbar bar, right-aligned. The Relative Styling section's "+ Add" affordance opens an Add Nested Selector dialog (`showPromptDialog`, studio-ui-guidelines.md §8.7) and creates an empty rule for the entered selector.

#### Property Filter Bar

Below the media/selector toolbar, a filter bar provides two controls:

1. **Search input** — Text field for filtering CSS properties by name or label (case-insensitive substring match). When active, only matching properties are shown and their sections are force-opened; empty sections are hidden.
2. **Active toggle** — Button that isolates only properties with set values, providing a focused view of applied styles. When active, sections without set properties are hidden.

### 6.3 State Editor

Add, remove, rename, and edit `state` entries. All four shapes supported:

- Naked values — inline editing
- Typed values — type constraints displayed
- Template strings — expression editing
- Functions — opens code editor

### 6.4 Code Editor

Monaco-powered editor for function `body` strings. Integrated with server code services:

- **Format** — via `oxfmt`
- **Minify** — via `Bun.Transpiler`
- **Lint** — via `oxlint` with diagnostic display

### 6.5 CEM Annotations Editor

For custom element definitions:

| Panel                 | Description                             | Status          |
| --------------------- | --------------------------------------- | --------------- |
| Parameters editor     | Edit CEM parameter objects on functions | **Implemented** |
| Emits editor          | Declare events dispatched by functions  | **Implemented** |
| Observed attributes   | Manage `observedAttributes` array       | **Implemented** |
| CSS custom properties | Declare `--custom-property` interfaces  | **Pending**     |
| CSS parts             | Declare `::part()` styling hooks        | **Pending**     |

---

## 7. Stylebook Mode

### 7.1 Overview

Design token management and component gallery. Renders all HTML elements and project components with the document's root styles applied, enabling visual design system development.

### 7.2 Canvas

Elements rendered as full-width cards with live DOM previews. Components rendered via the runtime (`defineElement` + `createElement`). Root document styles (`$style`) applied to all elements for consistent theming.

### 7.3 Layers Panel (Nested Tree)

The stylebook layers panel displays a hierarchical tree of elements. Entries with children (e.g. `ul > li`, `table > thead > tr > td`) show their descendants as indented rows, deduplicated by tag. Selecting a child element:

- Sets `activeSelector` to `& childTag` for nested style editing
- Scrolls the canvas to the parent card and highlights the child element
- Opens the style inspector for the nested selector

Selection works from both the layers panel (click row) and the canvas (click element directly). Canvas click-to-select registers all descendant DOM elements in `stylebookElToTag` during canvas build.

### 7.4 Style Editing

Editing styles in stylebook mode writes nested CSS rules (`& tag`) to the document's root `$style` object. Media breakpoint tabs allow responsive token editing. Scheme-layer routing applies here exactly as in the style sidebar (§6.2): a forced scheme routes edits into the corresponding `@--name` block, which the live `styleUpdate` path re-applies through the runtime's dual emission.

The site-settings design-token editor is scheme-aware for color tokens: each color row carries a per-scheme override field writing into the project style's scheme block, and an "Enable dark scheme" affordance declares the `--dark` scheme query in `$media` for projects that have none — the opt-in that lights up every scheme control in Studio. Token edits push to live page canvases as an in-place site-style sheet replace (no re-render).

---

## 8. Content / Format Mode

### 8.1 Format-Class Dispatch

The studio holds no format knowledge: `.json` is native, and every other extension dispatches through the project's **format registry** (see `specs/extensions.md`), built from the project-level `imports` map and fetched via the PAL (`listFormats`). Opening a format file invokes the class's `parse` capability; saving invokes `serialize` (`formatAction` → `POST /__studio/format` on the dev server, RPC on desktop). The format's `$studio` block drives the control surface:

- `modes` — which editor modes the tab offers
- `documentMode` — content vs component classification (e.g. promote to component when frontmatter `tagName` matches `.+-.+`)
- `newFileTemplate` — initial source for new files
- `elements` — the element allowlist + nesting constraints, interpreted generically by `createNestingValidator` (`src/format/constraints.ts`)

### 8.2 Fluid Document Editing

The canvas carries a **live caret**. There is no editing session to enter and no modal state: a caret
inside a block _is_ the edit. Clicking anywhere in text places the caret at the clicked character;
the arrow keys, Home/End and word motion move it through the whole document, across block
boundaries; and a selection may span any number of blocks.

This is achieved by making the canvas render container a single `contenteditable`, rather than
toggling `contenteditable` on one block at a time. The browser then owns caret placement,
line-wrap-aware vertical motion, word and line motion, IME composition, and cross-block selection —
none of which the studio implements.

Component instances are `contenteditable="false"` islands: the caret treats each as one atomic unit
and never enters its internals. Prop-bound text inside a component (§8.2.5) is the exception.

Text reaches the document on a **~500 ms typing pause** and whenever the caret leaves a block. Any
operation that reads the document as authoritative — chiefly saving — first flushes what the caret
has typed but not yet committed.

#### 8.2.1 The `beforeinput` chokepoint

The browser may edit text; it may not restructure the document. Every `beforeinput` is classified:

| Intent                                            | Handling                             |
| ------------------------------------------------- | ------------------------------------ |
| Text insertion or deletion within one block       | Applied natively                     |
| IME composition                                   | Applied natively — never intercepted |
| `Enter`                                           | Prevented; block split (§8.2.2)      |
| Backspace at a block start, Delete at a block end | Prevented; block merge (§8.2.3)      |
| Any edit spanning two blocks                      | Prevented; range collapse (§8.2.3)   |
| Native formatting, native history, text drag      | Prevented; the studio owns these     |

A structural intent with no handler is **suppressed**, never delegated back to the browser: an
unimplemented operation must leave the document untouched rather than let the engine restructure the
DOM behind the model.

A **collapsed selection outranks `getTargetRanges()`**. For a boundary Backspace the browser reports
the range it would delete — reaching out of the block and into the previous one, because joining
them is how it implements the keystroke. The caret says what the author meant; the target range says
what the browser would have done about it.

#### 8.2.2 Which tags hold a caret

A tag holds a caret when its element vocabulary says it accepts inline children. This is DERIVED,
never a hand-maintained list, from two sources resolved PER TAG:

1. **The document's format class** (`$studio.elements`, §8.1) for the tags it declares:
   `nesting[tag].inline === true` holds a caret; a container (`inline: false`, or an `only: [...]`
   rule) does not; and a tag in the format's `inline` list is markup within a block, never a block.
2. **The studio's element metadata** for every tag the format does not mention — HTML reaching the
   canvas through a directive, and native documents, which have no format class at all. The rule is
   the same: a non-empty `$inlineChildren` declaration.

Per-tag resolution rather than a union, because the format's verdict must be able to say NO. Under
Markdown a `blockquote` holds paragraphs, so the caret belongs in the `<p>` inside it; and an `<a>`
is inline, so clicking a link puts the caret in the enclosing paragraph rather than making the link
itself the edited block.

`pre` is excluded throughout: its content is preformatted code, where whitespace is significant and
the inline-markup path does not apply.

The format's verdicts are computed per render and cross to the canvas frame with it, because the
answer belongs to the document, not to the frame.

#### 8.2.3 Caret positions

A caret position is a **block path plus a character offset into that block's rendered text**. The
offset counts rendered characters, not DOM child indices, so it is agnostic to inline markup: in
`<p>a<strong>bc</strong>d</p>` offset 3 sits between "c" and "d" however the bold run is nested.

Expressed this way a caret survives the DOM underneath it being rebuilt, which is what lets a
surgical patch — including a co-author's edit — land without moving the author's cursor.

#### 8.2.4 Structural edits

- **Split** — `Enter` divides the block at the caret; the caret lands at the start of the new block.
- **Merge** — Backspace at a block's start and Delete at its end are the same join from either side.
  The earlier block survives, keeps its own tag, and the caret lands at the seam. A container the
  removal empties is pruned.
- **Range collapse** — a selection spanning blocks collapses to a merge with both ends clipped: the
  first block keeps what precedes the selection, the last keeps what follows, and every block
  between is removed. Typing over the selection inserts at the join.

Document order for "the previous block" comes from the **rendered DOM**, not the document tree: a
range or a boundary may cross list items, table cells and nested containers, none of which is a flat
index walk.

#### 8.2.5 Dragging

Reordering on the canvas is initiated **only** from the block action bar's drag handle (§4.4).
Pressing and dragging within text selects text. Native drag inside the editable region is
suppressed.

#### 8.2.6 Prop-bound text

Text inside a component instance that is an invertible prop binding opens a nested, plaintext-only
editing host on press. It commits to the instance's `$props`, and takes no rich formatting, split or
slash menu.

#### 8.2.7 Serialization

**Text node output**: When inline editing produces mixed content (text + inline formatting elements), text runs are represented as bare strings in the `children` array — not as `{ tagName: "span", textContent: ... }` wrapper elements.

**Normalization rules** (applied on every commit via `normalizeChildren`):

1. **Adjacent text merge**: Adjacent bare strings are always joined. `["hello ", "world", { "tagName": "em", ... }]` → `["hello world", { "tagName": "em", ... }]`
2. **All-text fold**: If all children are bare strings (no element siblings), they collapse into a single `textContent` property on the parent — the simpler representation.

### 8.3 Format File Loading

The studio loads any registered format file (e.g. `.md` with the `Markdown` class imported), converts it to Jx for visual editing via the class's `parse` capability, and saves back through its `serialize` capability. Projects without format imports handle only `.json`.

---

## 9. File Management

### 9.1 Project State

The studio tracks:

- Project root directory
- Expanded directory tree state
- Selected file path
- Component discovery results

### 9.1.1 Create, Rename, Delete

Every name the user supplies is collected through the Spectrum dialogs in §8.7 of
studio-ui-guidelines.md — no native browser prompts:

| Action                                                        | Dialog                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Files panel **New File** (toolbar and directory context menu) | New File — pre-filled `untitled.json`, extension preserved on retype, scoped to the target directory |
| Files / Browse **Rename**                                     | Rename — pre-filled with the current name                                                            |
| Browse **New ›** _entity_                                     | New _Type_ — pre-filled `untitled`, slugified into the type's directory                              |
| Files / Browse **Delete**                                     | Confirmation dialog                                                                                  |

Blank input is rejected in place: the dialog stays open with negative help text rather than closing.

### 9.2 Server Integration

All file operations go through the Platform Abstraction Layer, which maps to `@jxsuite/server` Studio API endpoints:

- List directories with glob patterns
- Read/write/delete/rename files
- Discover custom element components
- Path traversal protection
- Git operations (status, staging, commit, push/pull/fetch, branch management) via `/__studio/git/*` endpoints

### 9.3 Media Upload

> **Status: Implemented.** Adding media to a project is a direct gesture from wherever the author already is. Every surface funnels through one upload core (`packages/studio/src/files/media-upload.ts`); they differ only in how the destination directory is chosen.

#### Surfaces

| Surface                                            | Gesture                                         | Destination                                                                                       |
| -------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Image field (`format: "image"`, `$input: "media"`) | **Upload** button beside the path field         | Context-aware (below); the field takes the new ref                                                |
| Canvas                                             | Drop files from the OS                          | Context-aware                                                                                     |
| Files tree                                         | Drop on a row, or **Upload Files…** in its menu | The row's directory (a file row targets its parent); the tree background targets the project root |
| Manage view                                        | Drop anywhere, or the **Upload** button         | The active category's own directory; "All" falls back to context-aware                            |

#### Destination and references

Without an explicit directory, an upload follows the active document: one inside a content collection co-locates its media in `content/<collection>/images/`, everything else lands in `public/`. The reference written into the document follows `site-architecture.md` §9.3 — `public/` contents are referenced from the site root (`/hero.jpg`), a content asset relative to its own entry (`./images/hero.jpg`), anything else relative to the project root.

An upload **never overwrites**: a colliding name gains a `-1`, `-2`, … suffix before its extension, resolved against a single listing of the destination (so a multi-file batch does not collide with itself either). A file that fails to upload is reported and skipped; the rest of the batch still lands.

#### Canvas drop semantics

The canvas iframe owns the gesture — Chromium delivers a native drag to the frame under the cursor, so the parent never sees it start. The iframe accepts the drag, computes GEOMETRY (the node under the cursor and where an insert would land) and posts it; the parent decides SEMANTICS, because that needs the component registry and the mutation pipeline.

| Drop lands on                                                | Result                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| An `<img>` or `<source>` (image file only)                   | Its `src` is replaced in place (a surgical `set-attr` patch) |
| A `<video>` (image file only)                                | Its `poster` is replaced                                     |
| A component instance with exactly one `format: "image"` prop | That `$prop` is replaced                                     |
| Anything else                                                | A new element is inserted at the resolved position           |
| The canvas gutter (outside the rendered page)                | A new element is appended to the document root               |

An ambiguous component (two or more image props) falls through to an insert rather than guessing. Inserted elements follow the file's kind: `image` → `<img>`, `video` → `<video controls>`, `audio` → `<audio controls>`, anything else → an `<a href>` labelled with the filename. A multi-file drop keeps its order. While a file drag hovers, exactly one affordance draws — a solid highlight over the image that would be replaced, or the usual insert indicator.

#### Transport

`StudioPlatform.uploadFile` accepts `string | File | Blob | ArrayBuffer`. The HTTP platforms (dev server, cloud) post the binary body directly; the RPC platforms (electrobun, chromium) JSON-serialize their params, so they base64-encode binary before the call and the backend decodes it. A `string` payload is already base64 and passes through untouched.

---

## 10. Keyboard Shortcuts

**Document commands** (available wherever focus is, including with a caret in the canvas):

| Shortcut                       | Action                                        |
| ------------------------------ | --------------------------------------------- |
| `Cmd+S` / `Ctrl+S`             | Save (flushes the caret's pending text first) |
| `Cmd+Z` / `Ctrl+Z`             | Undo                                          |
| `Cmd+Shift+Z` / `Ctrl+Shift+Z` | Redo                                          |
| `Cmd+D` / `Ctrl+D`             | Duplicate selected node                       |
| `Cmd+0` / `Cmd+=` / `Cmd+-`    | Zoom reset / in / out                         |

**With a caret in the canvas** — the caret owns the editing and navigation keys:

| Shortcut                               | Action                                                         |
| -------------------------------------- | -------------------------------------------------------------- |
| Click                                  | Place the caret at the clicked character, and select the block |
| Arrows, Home/End, word and line motion | Move the caret, across block boundaries                        |
| `Shift` + motion, or drag              | Extend the selection, across block boundaries                  |
| `Enter`                                | Split the block                                                |
| `Shift+Enter`                          | Line break within the block                                    |
| `Backspace` at a block start           | Join onto the previous block                                   |
| `Delete` at a block end                | Pull the next block up                                         |
| `Cmd+B` / `Cmd+I` / `` Cmd+` ``        | Bold / italic / code                                           |
| `/`                                    | Slash menu (at a block start or after a space)                 |
| `Escape`                               | Dismiss the caret                                              |

**With a block selected but no caret** (from the layers panel, or after a structural edit):

| Shortcut               | Action                   |
| ---------------------- | ------------------------ |
| `Delete` / `Backspace` | Delete the selected node |
| Arrows                 | Structural navigation    |
| `Escape`               | Deselect                 |

**Canvas viewport:**

| Shortcut              | Action      |
| --------------------- | ----------- |
| `Space` + drag        | Pan canvas  |
| `Ctrl+scroll` / pinch | Zoom canvas |

---

## 11. Dependencies

| Package                             | Purpose                                |
| ----------------------------------- | -------------------------------------- |
| `@jxsuite/runtime`                  | Canvas rendering                       |
| `@atlaskit/pragmatic-drag-and-drop` | Layer tree drag-and-drop               |
| `lit-html`                          | Studio UI template rendering           |
| `monaco-editor`                     | Code editor (loaded on demand — §11.1) |
| `yaml`                              | YAML frontmatter parsing               |
| `unified` / `remark-*`              | Markdown conversion pipeline           |
| `@spectrum-web-components/*` (15+)  | Adobe Spectrum UI components           |

### 11.1 Bundle Layout

The studio ships **two entry bundles** — the editor shell (`dist/studio.js`) and the slim canvas-iframe bundle (`dist/iframe-entry.js`) — built in separate single-entry passes so each lands flat at `dist/<name>.js`. Four consumers address those paths literally (`index.html`, `canvas.html`, the desktop asset staging, and the cloud platform's asset build), so entry names are a contract and are never hashed.

The build **code-splits**. Everything reached only through a dynamic `import()` — Monaco and its language contributions, the Yjs collab stack, the JSON-Schema validator, drag-and-drop adapters — lands in content-hashed files under `dist/chunks/`, addressed by the entry relative to its own URL. That directory therefore ships and is copied wholesale, with its emitted names intact.

**Monaco is never on the startup path.** It is roughly two thirds of the editor's code and most sessions never open a code view, so `services/monaco-lazy` loads the editor API and its worker/language registration together, memoized, on first use by source mode, the function editor, or the formula workspace. Nothing in the eager import graph may reference `monaco-editor` — including indirectly, via a module whose own top-level imports pull it in (the reason the model-URI helper lives apart from the Monaco setup module).

---

## 12. Pending Features

| Feature                      | Description                                                    | Status                                                                              |
| ---------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| CSS custom properties panel  | Declare `--custom-property` interfaces for CEM                 | **Pending**                                                                         |
| CSS parts panel              | Declare `::part()` styling hooks for CEM                       | **Pending**                                                                         |
| Full CEM document export     | Generate complete Custom Elements Manifest JSON                | **Pending**                                                                         |
| Component library management | Browse, install, and manage component packages                 | **Pending**                                                                         |
| Content collection browser   | Table/card/calendar views for content entries                  | **Pending**                                                                         |
| Content entry editor         | Schema-driven forms for Markdown frontmatter, JSON, CSV        | **Pending**                                                                         |
| Media browser                | Grid/list view of project media with upload and usage tracking | **Partial** — upload ships on four surfaces (§9.3); usage tracking is still pending |
| SEO panel                    | Title/description/OG preview with schema.org editor            | **Pending**                                                                         |
| Redirect editor              | CRUD table for site redirect rules                             | **Pending**                                                                         |

See the [Site Architecture Specification](site-architecture.md) for full design details on content management UI.

## Changelog

- **0.3.4-draft** (2026-07-28) — Document the two-entry code-split bundle layout and the on-demand Monaco load (§11.1).
- **0.3.3-draft** (2026-07-28) — Layer-row actions follow selection rather than hover; edit/design gate automatic Request fetches; structural splices escalate on the immediate parent only.
- **0.3.2-draft** (2026-07-28) — Canvas maps a content entry's entry-relative media onto its asset mount (§4.1) so the preview matches the built site; render-only, source doc untouched.
- **0.3.1-draft** (2026-07-28) — Media upload across four surfaces (§9.3): image-field Upload button, canvas file drop with replace-vs-insert, Files-tree and Manage destinations; collision-safe naming; binary uploadFile on every platform.
- **0.3.0-draft** (2026-07-27) — Derive the caret's editable tag set from the document's element vocabulary (§8.2.2): the format class decides per tag and can say no, so a Markdown blockquote holds paragraphs and a link is markup within a block; subsections after it renumber (nothing referenced them).
- **0.2.0-draft** (2026-07-26) — Fluid document editing: the canvas carries a live caret (§8.2), one block action bar (§4.4), both editable modes behave identically for text (§4.2), and a rewritten keyboard contract (§10).
- **0.1.29-draft** (2026-07-26) — File create/rename/delete naming dialogs (§9.1.1); branch, clone, and nested-selector flows now open Spectrum dialogs instead of native prompts.
- **0.1.28-draft** (2026-07-25) — The Cloud platform target composes per-project schemas server-side (§3.4).
- **0.1.27-draft** (2026-07-25) — Source-mode schema validation contract: per-project entry documents, offline $schema-id registration, worker self-location (§4.2.1); fetchProjectSchemas in the PAL table (§3.4).
- **0.1.26-draft** (2026-07-25) — PAL table records the destination members: createDestination, createProject's user-chosen destination, and pickDirectory.
- **0.1.25-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.24-draft** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.1.23-draft** (2026-07-17) — Scheme-variant editing — token overrides, scheme-layer routing, live feedback (`49f0c525`).
- **0.1.22-draft** (2026-07-17) — Color-scheme canvas preview — Auto/Light/Dark tab-bar control (`ccdc1d3e`).
- **0.1.21-draft** (2026-07-17) — Consolidated field mode switcher (`0a135ed1`).
- **0.1.20-draft** (2026-06-10) — Consolidate markdown and csv handling to the parser package (`8b1ba6da`).
- **0.1.19-draft** (2026-05-25) — Allow nested global styles (`1159d585`).
- **0.1.18-draft** (2026-05-20) — "format" on fields for image fields (`02f87d29`).
- **0.1.17-draft** (2026-05-20) — Run formatter (`8ba47930`).
- **0.1.16-draft** (2026-05-15) — Git sidebar (`79663844`).
- **0.1.15-draft** (2026-04-23) — Include global styling (`d8d25640`).
- **0.1.14-draft** (2026-04-23) — Site build (`ffe60ddc`).
- **0.1.13-draft** (2026-04-23) — Compiler cli + published site (`4607ebbc`).
- **0.1.12-draft** (2026-04-22) — Consolidate project config schema and rename as such (`e3523dbf`).
- **0.1.11-draft** (2026-04-22) — External web component support (`a9d0fbe4`).
- **0.1.10-draft** (2026-04-22) — Init new site (`f33d319b`).
- **0.1.9-draft** (2026-04-20) — Text nodes support (`4d45eeb7`).
- **0.1.8-draft** (2026-04-20) — Better project-level scoping (`0cba233c`).
- **0.1.7-draft** (2026-04-18) — Dedicated combo/picker component for style preview (`d8d07921`).
- **0.1.6-draft** (2026-04-18) — Fix the test path handling on windows (`26ea0d70`).
- **0.1.5-draft** (2026-04-17) — Update studio specs (`d0e5475a`).
- **0.1.4-draft** (2026-04-17) — Reorganize code tree (`d5ee04c4`).
- **0.1.3-draft** (2026-04-16) — Landing site + working exports + release-it + linting (`a8409b5f`).
- **0.1.2-draft** (2026-04-15) — Rebrand to Jx / Jx Platform (`abc63f2d`).
- **0.1.1-draft** (2026-04-10) — Finalize vision for site architecture (`da594993`).
- **0.1.0-draft** (2026-04-10) — Consolidate specs (`80ca313f`).

---

_`@jxsuite/studio` Specification v0.3.4-draft_
