# `@jxsuite/studio` Specification

## Visual Builder for Jx Documents

**Version:** 0.9.8-draft
**Status:** Partial
**Updated:** 2026-08-11
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

Four-column layout:

| Column    | Content                                                 |
| --------- | ------------------------------------------------------- |
| Rail      | Navigator rail — panel buttons, grouped by level        |
| Navigator | One panel at a time (Files, Outline, Source Control, …) |
| Center    | Canvas (live preview) + Command Bar                     |
| Inspector | Four tabs: Content · Style · Logic · Assistant          |

**There is no assistant column.** The AI chat is the Inspector dock's fourth tab, so it shares that
dock's cell and its width: showing it costs zero additional pixels, and the two docks are the only
things that carry a width, a collapse flag and a resize handle. Two states that a separate column
made expressible — "assistant open over a collapsed inspector", and "assistant open at 0px" — are
unreachable by construction rather than by a rule.

Each dock's collapsed state and width persist to `localStorage` under one record, written by one
writer, and are adopted at boot in both directions, so a remembered "open" reopens a dock against a
closed default. A stale `chat` entry from an older build is ignored, not resurrected.

An AI provider key is an application-level setting configured once, so it is not edited from the
assistant at all: it lives in **Preferences › Assistant** (§15). With no provider connected, the tab
still renders a chat inviting a conversation, with one line and the action that fixes it beneath —
it is never replaced by a credentials form.

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

**Preview does not edit, and it scrolls for real.** Preview is the fidelity view, so every editing
affordance is gated off it: a click selects nothing, no hover or selection box is drawn, the
insertion "+" is withheld, the canvas context menu gives way to the browser's own, nothing may be
dropped onto it, and the destructive keyboard chords (duplicate, cut, paste, Delete, Backspace,
Enter) are refused. A selection carried in from an editable mode survives in the model — returning
restores it — but is not actionable while Preview is shown. Both realms enforce this: the frame
withholds the messages, and the host refuses them, because the canvas bundle ships prebuilt and
neither side may assume the other's build is current.

Preview also renders on its own surface rather than the pan/zoom artboard. Editable modes grow the
canvas iframe to its full content height so the parent overlay can reach every node, and pan a
transform in place of scrolling; both are incompatible with fidelity, because a frame that is as
tall as its document never scrolls, so `position: sticky`, scroll-driven animation and
`IntersectionObserver` reveals can never fire. Preview therefore mounts ONE frame at the pane's own
size, which scrolls its own document. It has no zoom control and no pan.

**Source is batched, so every way out of it settles first.** Parsing the buffer back into the
document is debounced, which means at any instant the editor may hold text the document has not
received. Leaving the mode, changing tab, switching pane, closing the tab and quitting all commit
that text before they proceed — a teardown that merely cancelled the pending parse would discard the
author's last keystrokes, and cancel it silently, because `dirty` had never been set. Text that
cannot be parsed stays in the buffer and still counts as unsaved: the author is never made to choose
between a broken document and the line they were writing. The same rule governs the Logic tab's
function editor (§16.3), for the same reason and through the same mechanism.

**Following a link in Preview leaves the canvas.** Editable modes de-link anchors — the runtime stamps
`href` onto `data-jx-href`, so a click selects the element instead of navigating. Preview keeps them
live, where a click would navigate the canvas iframe and destroy the render along with the editing
session. So Preview intercepts the click and the shell opens the target in a **real browser tab**,
resolved against the CANVAS's origin (the project's own), not the editor shell's — which may sit on an
unrelated deep path. In-page fragments are left to the browser, since scrolling the previewed page is
what Preview is for.

Only `http`, `https`, `mailto` and `tel` targets are followed. The shell is the opener, so handing a
`javascript:` or `data:` URL to a new window would execute it in the EDITOR's origin.

That browser tab is also the honest place to verify a project: routing, project JavaScript, server
functions and live data all behave there exactly as they will on the built site, none of which the
canvas promises. The shell exposes an override for this so a host can redirect it (the desktop app
wants the user's own browser rather than a chrome-less webview); the default is a new tab.

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

**Entering a pan/zoom mode fits the artboard.** Design and Stylebook apply a fit on the mode
transition, capped at 100% so a narrow artboard is never magnified, and skipped when the pane has no
measurable width (fitting an unlaid-out pane would land on the 5% floor). Without it a 1280px
artboard opened at 100% in a ~700px pane and was cut off mid-word. The fit is a default, not a
policy: any zoom the author sets by hand — the tab bar's −/+/100%/Fit controls, Ctrl+scroll, or the
zoom chords — is recorded against that tab's document for the session, and re-entering the mode
restores it instead of re-fitting. Preview takes no part in any of this (§4.2).

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

Vertical tab strip for switching panel views, drawn from the panel registry in two labelled
groups. A panel's `level` decides its group, so the rail says what a panel writes to before you open
it: **Project** panels change the project, **Document** panels change the open document.

| Group    | Tab            | Id         | Icon            | Panel                                      |
| -------- | -------------- | ---------- | --------------- | ------------------------------------------ |
| Project  | Files          | `files`    | `folder`        | Project file tree                          |
| Project  | Source Control | `git`      | `git-branch`    | Git source control                         |
| Document | Outline        | `layers`   | `layers`        | Document structure tree                    |
| Document | Page           | `page`     | `view-all-tags` | Page meta, head entries and route params   |
| Document | Data           | `data`     | `data`          | State definitions AND what they resolve to |
| Document | Packages       | `packages` | `box`           | Imported components and packages           |

Two more panels are registered `rail: false` — **Search** (`search`, project level) and **Insert**
(`insert`, document level, the HTML element palette and the project's component library). They have
records, regions and `panel.focus.<id>` commands like any other panel; what they give up is a rail
button, because the group is a glance and a glance does not scale.

**A rail-less panel is a panel you have to already know about.** That is an acceptable price for a
surface with another door — Insert is reachable from the canvas and the palette — and not an
acceptable one for a surface that is the only way to do something. The State panel was rail-less for
one release and its editor was the only place a state variable or a component property could be
declared; the answer was to merge it into Data (§5.6), not to leave it findable by search.

### 5.2 Layers Panel

Flattened tree of all elements in the document with indentation representing nesting depth. Each row shows element tag name, label, a grab affordance on hover, and — for the selected row — move controls and a delete button.

**Drag and Drop** — The entire layer row is draggable via Atlassian Pragmatic Drag and Drop. Users can grab any part of the row to drag; a grip glyph appears on hover to advertise it. Drop indicators show reorder (above/below) and reparent (make-child) targets.

**Move Action Buttons** — The row carrying the **primary** selection carries contextual move buttons.
They stay single-target under a multiple selection (§6.7): moving several non-sibling nodes one slot
has no single meaning, and each step is arithmetic against a parent the previous step renumbered. Selection rather than hover, because the buttons are Spectrum custom elements and building five of them for every visible row made the panel's render cost scale with document size; a click on a row both selects it and reveals its actions. The grab affordance is a plain glyph and therefore stays on every row.

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

**§5.3 and §5.4 are one panel — Insert (`insert`).** They were two rail tabs listing two kinds of
thing you drag onto the canvas, and the question a user has ("what can I put here?") does not
distinguish them. The sections stay separate because the two catalogues have different sources and
different rules; the surface does not.

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

### 5.6 Data Panel

One list of the open document's state entries: **how each is defined, and what it resolved to.**

Each row carries the category badge, the entry name and one summary slot. The slot shows the
definition hint until the canvas reports a scope, and what the entry resolved to once it has —
because a panel opened before the canvas has rendered knows nothing about any entry, and labelling
the whole list "pending" there would be a fact about the panel dressed up as a fact about the data.
A 240px Navigator does not fit both summaries beside the name without eliding all three.

**An entry that cannot hold a value never gets the value slot.** A function, and an expression whose
operator is an assignment, are things the page _does_; they are absent from the resolved scope for
that reason, and labelling them `pending` reads as "still loading" for something that will never
load. Those rows keep their definition hint permanently.

Expanding a row opens the entry's editor — name, type, prototype fields, expression or function
body — with the resolved value rendered underneath it as a tree. Expansion is recorded per tab
(`ui.dataRows`), and any number of rows may be open at once: comparing two entries means seeing
both, and coming back to a tab means finding it as you left it.

**Every truncation marker in the tree is a control.** The tree caps arrays at 20 entries, objects at
30 keys and nesting at 5 levels; each cap ends in a button that raises that one marker's limit by
50, recorded per tab alongside the expansions (`ui.dataLimits`). Inert "… 40 more" text is the panel
saying it has the answer and will not show it, in the surface a reader opens _because_ item 40 is
the surprising one. A limit never lowers itself, and raising one does not lengthen any other list.

**Refresh reports the render it started, not a timer.** Automatic `Request` entries are suppressed
while authoring — a full render re-resolves every entry, so editing would refetch constantly — so
re-firing them is a verb. The button arms the fetches, marks the tab refreshing, and stays that way
until the canvas posts the resolved scope (or fails to render). Repainting on a fixed delay instead
reported "done" over the old values for anything slower than the delay, which is a Refresh that
visibly did nothing.

**Renaming is collision-checked, and every refusal says so.** An empty name or a name the document
already defines leaves the document untouched and prints the reason under the field
(`role="alert"`); an accepted rename carries the open row with it, so the editor being typed in is
still the one on screen when the list repaints. A silent refusal here is worse than none: the field
shows the new name, the document keeps the old one, and only the canvas can say which won.

`data.expandRow` is the row verb — `{ name }` to open, `{ name, expanded: false }` to close, and a
refusal listing the entries the document defines when the name is not one of them. It replaced a
second verb that opened exactly one editor, from the second panel that listed the same names.

## 6. Inspector (Right Panel)

Four **text-labelled** tabs, in this order: **Content · Style · Logic · Assistant**. The tab ids
(`properties`, `style`, `events`, `assistant`) are the values `view.setRightTab` accepts and the
values `⌘⇧1`–`⌘⇧4` address, so the strip, the keymap and the automation surface cannot disagree
about which tabs exist. Icon-only tabs are gone: a dock the author reads all day states its own
names.

Every tab renders under a header naming the tab and **what it is pointed at** — the selected node,
or the document when nothing is selected, or "no document" when nothing is open.

The tab selection is per-document (`session.ui.rightTab`), so the tab you were on returns with the
file. With no document open there is nowhere per-document to keep it, and the Assistant is usable in
exactly that state (the New Project hand-off sends a brief before any document exists), so the
selection falls back to a single window-level value rather than being refused. An undeclared stored
id coerces to Content.

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

Each prop's value source is chosen from the shared ladder (§6.6) rather than a cycle button, and each
prop row carries a provenance chip (§6.7) distinguishing a value set here from the component's own
default — the same vocabulary the Style tab uses, because it is the same question asked of a second
cascade.

### 6.2 Style Sidebar (Metadata-Driven)

**The Target Line states the compound target before you type.** A style edit is addressed by a tuple
— element, breakpoint, selector, colour-scheme variant — that the panel has always computed
internally as its per-field key, and never showed. It is now one sentence at the top of the tab,
region `inspector/target`, each segment a control:

```text
⌖  h1 · Base · Dark variant · :hover                   [ this element ]
```

The segments are the element, the breakpoint, the colour-scheme variant when there is one, and the
selector last. A scheme variant appears **only at Base**: scheme × breakpoint compound blocks are
not supported (`spec.md` §9.5's pure-query limitation), so at a breakpoint the line reads
`⌖ h1 · @md · :hover`.

The trailing **scope chip** states the blast radius: _this element_, _all `<h1>` in this document_,
or _all `<h1>` in this project_. The project case renders as a warning band with a count of affected
files and a way to list them, and where the count cannot be answered it says **unknown** — never a
confident zero. This is what makes Stylebook safe: entering it used to convert every subsequent edit
from "this element" to "every element of this tag" with one line of after-the-fact text as the only
signal.

The Target Line **replaces** the breakpoint tab strip, the selector picker and the scheme badge.
The breakpoint and scheme axes are selected on the pane context bar (§3.2 ⑦), whose definition site
is Project Settings › Contexts (§16); the Style tab does not own a third selector and therefore
cannot disagree with the one the canvas is rendering under.

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

#### The breakpoint and scheme axes

Neither is chosen here. Both are selected on the pane context bar (§3.2 ⑦) and defined in Project
Settings › Contexts (§16); the Target Line's segments **state** the resolved value and route to that
definition site. While a scheme is forced, Base-context reads and commits target that scheme's
`@--name` block through the same media-style mutations, and base values are reported by the
provenance chip as inherited **from Base** rather than as a placeholder indistinguishable from the
CSS initial value.

#### Nested Selector Context

Nested CSS selectors (`:hover`, `:focus`, `:active`, `& childTag`) are editable as separate style
contexts, and the active one is the Target Line's last segment. Naming a new selector opens a prompt
dialog (`studio-ui-guidelines.md` §8.7) with validation; accepting it **points the tab at that
selector without writing anything** — the rule is created by the first property set, so an abandoned
selector leaves no empty rule behind.

#### Property Filter

One control: a search input filtering CSS properties by name or label (case-insensitive substring),
which force-opens matching sections and hides empty ones. There is deliberately **no second control
isolating properties that have values** — that is what the provenance tally on each collapsed
section header now says, continuously, without the author having to toggle a mode to find out.

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

### 6.6 The value-source ladder

Six vocabularies asked "how is this value produced" in six different words — the dynamic-slot ring,
the events picker, the expression operand picker, the schema-form source select. They are one
vocabulary now, and the provenance chip **is** the control:

| Rung            | Means                     |
| --------------- | ------------------------- |
| **Fixed value** | a literal                 |
| **From data…**  | a `$ref` to a state entry |
| **Mixed text**  | a `${…}` template         |
| **Formula**     | an `$expression`          |

Three rules the ladder must keep:

1.  **Any rung is one action away.** The control opens a picker; it does not cycle. A ring forced
    `$ref → literal` to pass through `${}`, which is an edit the author did not ask for.
2.  **Which rungs exist is derived from what the schema permits**, never from a hand-written list.
    Hand-written lists are how the `Formula` rung came to be drawn on fields where `$expression` was
    not legal and reachable on none.
3.  **Switching rungs remembers the representation it left**, so a switch is never destructive, and
    typing a `${…}` literal does not swap the widget underneath the author mid-keystroke.
4.  **A position may seed its own rung.** The generic `Formula` seed is a bare `??` node, which is a
    sensible start almost everywhere and an INVALID document wherever the schema narrows which
    operators the position takes — clicking the chip would write something that fails its own
    validator. A position that narrows supplies the seed instead.

**An element's `tagName` is one of these positions**, and is the ladder's own argument made twice
over. Its rungs derive to **Fixed value** and **Formula** and no `Mixed text`: `TagName` carries a
`pattern`, so the derivation refuses a template rung — and a `${…}` in tag position is precisely
what that pattern exists to reject (`specs/schema.md` §3.1). It also narrows the operators to `?:`
and `switch`, which is what rule 4 is for. Before it joined the ladder the row was a hand-written
control, and it did both things rule 2 warns about: it rendered `[object Object]` for a value it did
not expect, and its one text input would have replaced an author's whole expression on the first
keystroke.

### 6.7 Provenance, and multiple selection

**Every field label carries a four-state chip**, and an inherited value NAMES its donor:

| State         | Behaviour                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| **Set here**  | click clears it                                                                                            |
| **Inherited** | names the donor — "from Base", "from site tokens", "from the component default" — and clicking jumps there |
| **Default**   | renders nothing; absence is the ghost state                                                                |
| **Bound**     | names the signal or formula, and clicking opens it                                                         |

The inheritance walk already knew the donor and discarded it, leaving inherited values rendered as
an input placeholder — visually identical to the CSS initial value. Collapsed section headers carry
the same states as a tally, which is why there is no separate "show only active properties" toggle:
that toggle existed only because provenance was invisible.

**`session.selection` is a `JxPath[]`.** `[]` means nothing is selected — it is no longer a legal
spelling of the root path, which is `[[]]`. The first entry is the range anchor and the last is the
**primary**; every surface that addresses a single node resolves it through one function, so at
`length === 1` each receives exactly what a single-path field handed it. Multi-selection cases are
additions beside that path, never a rewrite of it.

Three consequences are normative:

1.  **A structural command over a selection is ONE transaction and therefore one undo step.** Splices
    are applied in descending document order, so no step renumbers a coordinate a later step needs,
    and paths contained by another selected path are dropped rather than spliced twice.
2.  **A value that differs across the selection renders as Mixed**, in the same chip vocabulary,
    rather than showing the primary's value as though it were everyone's.
3.  **A selection is replaced, never mutated in place.** Effects track the set, not the array
    identity; an in-place push would move the selection without repainting the panel drawing it.

## 7. Project Styles

### 7.1 Overview

The project's design tokens and element defaults, edited as a **document** (§17) with the live
canvas beside them: every HTML element and project component rendered under the project's root
styles, so tuning a token shows the page changing rather than describing it.

**The user-facing name is Project Styles; `"stylebook"` remains the wire value.** It is a member of
`CANVAS_MODES` and therefore of the `ParentToIframe` union, so renaming it would require the studio
bundle and `dist/iframe-entry.js` rebuilt in lockstep. The id and the name are different things, and
the code says which is which. Tokens are pickable as chips from any Style field, and a colour scheme
is declared as a row in Contexts (§16) rather than by a control that exists only here.

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

The site-settings design-token editor is scheme-aware for color tokens: each color row carries a per-scheme override field writing into the project style's scheme block. Declaring a scheme is not done here — the token editor links to Project Settings › Contexts (§16), which is the single definition site for breakpoints and colour schemes, and which is why adding one no longer costs the author their element selection. Token edits push to live page canvases as an in-place site-style sheet replace (no re-render).

Stylebook's own compound target is stated by the Target Line (§6.2), whose scope chip is what tells
the author, before the first keystroke, that an edit here lands on every element of a tag rather
than on one.

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

**IME composition suspends every commit.** A composition is a multi-keystroke transaction the browser
owns: the DOM holds provisional text and the input engine holds a selection tied to it. So between
`compositionstart` and `compositionend` the idle tick is cancelled and not re-armed, an explicit flush
is a no-op, and exactly one commit runs when the composition ends. Committing inside one would capture
half-formed text and — because a commit restores the selection — cancel the composition outright. The
editing host exposes its composition state so nothing else rewrites the editable subtree mid-input
either.

#### 8.2.8 Accessibility

The editable region carries `role="textbox"`, `aria-multiline="true"` and a label, added and removed
with `contenteditable` itself. A bare `contenteditable` div announces as an unlabelled group, and the
canvas lives in a cross-origin iframe, so a screen reader traversing in has no surrounding context to
infer the region's purpose from.

This describes the REGION only. Per-block landmarks and a keyboard-reachable block action bar
(§4.4) are not yet implemented.

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

#### Consequences, stated before the action

> **Status: Implemented.** A destructive dialog states **what it breaks**, not only whether it can be undone. Deleting a component used on seven pages must not look like deleting an unused one.

Every delete and rename confirmation carries the reference count from `findReferences` (§9.6 of
UX-REDESIGN-PLAN; the PAL member in `desktop.md` §3.1), resolved **before** the dialog opens — a
sentence that becomes true after the user has already confirmed is the same defect as no sentence.

| Action     | The sentence states                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| **Delete** | How many references in how many files stop resolving, and that those files themselves survive unchanged |
| **Rename** | How many references will be **rewritten automatically** by the refactor pass, so nothing else changes   |

Three states, three different sentences, and they are never collapsed:

- **Counted** — the number, with the wording above.
- **Uncountable** (the query failed) — the dialog says the references could not be counted and that
  this is not the same as "unused". It never renders 0.
- **Unsupported** (`capability.findReferences` is false, i.e. the backend has no
  `/__studio/references` route) — the dialog carries **no** consequence line at all, rather than one
  that implies a count it does not have.

The same query backs the inspector's **Used on N pages** line for a selected component instance and
the `selection.findUsages` command; all three read one cache, invalidated by the filesystem rather
than by a timer, so they cannot disagree.

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
| `Cmd+Shift+O` / `Ctrl+Shift+O` | Open in Browser (§10.1)                       |
| `Cmd+0` / `Cmd+=` / `Cmd+-`    | Zoom reset / in / out                         |

**Whether a caret is active is a bridge fact, not a local one.** The editing session runs inside the
canvas iframe, so the shell cannot see the caret in its own realm — it derives `caret.active` from
the session messages the bridge already carries (`editStart` opens it, `selectionChanged` proves it
is still live, `editEnd` closes it), and treats a frame that has left the document as having no
caret, since a frame torn down mid-session never posts `editEnd`. Reading a shell-local editing flag
instead is what let the element-level clipboard handlers steal `Cmd+C` / `Cmd+X` / `Cmd+V` from a
live caret: copying a phrase copied the whole block, and cutting mid-sentence deleted the paragraph.

**With a caret in the canvas** — the caret owns the editing and navigation keys, and the clipboard:

| Shortcut                               | Action                                                         |
| -------------------------------------- | -------------------------------------------------------------- |
| Click                                  | Place the caret at the clicked character, and select the block |
| Arrows, Home/End, word and line motion | Move the caret, across block boundaries                        |
| `Shift` + motion, or drag              | Extend the selection, across block boundaries                  |
| `Enter`                                | Split the block                                                |
| `Shift+Enter`                          | Line break within the block                                    |
| `Backspace` at a block start           | Join onto the previous block                                   |
| `Delete` at a block end                | Pull the next block up                                         |
| `Cmd+C` / `Cmd+X` / `Cmd+V`            | Copy / cut / paste the TEXT selection, never the block         |
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

### 10.1 Open in Browser

Studio closes the loop from "I changed something" to "I looked at the real page": **Open in Browser**
(toolbar, beside Save; `Cmd+Shift+O`) hands the active page's BUILT output to the user's own browser
through the same seam Preview link clicks use (`canvas/preview-navigate.ts`, §4.2), so on desktop it
reaches the real browser rather than a webview.

The URL is the canvas origin (the server already serving the project) plus the compiler's output
path for the document's route — `dist/<route>/index.html`, or `dist/<route>.html` under
`build.trailingSlash: "never"`. The action is never hidden: when a page cannot be resolved it renders
**disabled with the reason in its tooltip**, one of —

| Condition                       | Reason                                                            |
| ------------------------------- | ----------------------------------------------------------------- |
| No open document                | Open a page to view it in a browser.                              |
| Project is not a site           | This project does not build a site.                               |
| Document is not under `pages/`  | Only pages have a route — `<path>` is not under pages/.           |
| Catch-all route (`[...rest]`)   | Catch-all routes match many pages — open a generated one instead. |
| Dynamic route with unset params | Pick a value for `:<param>` to open one of this route's pages.    |
| Canvas origin is not `http(s)`  | No local server is serving this project yet.                      |

Invoked by chord while blocked, the reason goes to the status bar instead of opening nothing.

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

**Both build paths share one contract.** The release build (`scripts/build.ts`) and the repo dev
server's watcher (`server.js` → `@jxsuite/server`'s `builds`) spread the same options from
`scripts/build-config.ts`. They diverged once, and the failure mode is instructive: the watcher had its
own inline config with no de-duplication and no splitting, and because it overwrites `dist/` on the
next keystroke, a developer never saw the built output at all — `bun run dev` served 18.8 MB while
`bun run build` produced 3.3 MB. A `@jxsuite/server` build entry forwards every unrecognised key to
`Bun.build`, which is what makes one shared contract possible.

**Nothing may fetch Monaco at startup, including via a dynamic import.** `import()` defers evaluation,
not payload: an `import()` that RUNS during activation still puts the editor on the critical path.
Per-project JSON schemas arrive at project activation and used to be applied that way; they are now
held (`services/monaco-lazy`) and registered when an editor is first created.

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

---

## 13. Command Registry and Context Keys

**Status:** Partial — the registry, the keymap and the CI checks ship; the surfaces are being ported onto them.

Every capability Studio has is one **command record**. The Command Bar, the palette, the Navigator
rail, the context menus, the block action bar, the keymap, `__jxAutomation` and the assistant's tool
surface are **renderings** of those records. A rendering may choose _whether_ to show a command; it
may never decide what it is called, when it is available, or what it does. A second hand-maintained
list of actions is a defect.

Rendering rules — which surfaces admit which levels, the chrome budget, and what every invoking
surface must print — live in [studio-ui-guidelines.md §12](studio-ui-guidelines.md).

### 13.1 The record

`packages/studio/src/commands/registry.ts`:

| Field         | Type                                | Meaning                                                                                                                             |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `string`                            | `<namespace>.<verb>` — `selection.duplicate`, `document.reopenClosed`. The address automation and the palette use.                  |
| `title`       | `string`                            | Imperative human name. The **only** place the action is named.                                                                      |
| `category`    | `Category`                          | Groups palette rows: File, Edit, Selection, Insert, View, Document, Project, Source Control, Publish, Assistant, Collaborate, Help. |
| `level`       | `Level`                             | **Required.** What the command acts on (§13.2). Checked against every declared placement.                                           |
| `keyScope`    | `KeyScope`                          | Where the chord is live (§13.3). Defaults to `global`. Deliberately **not** the same field as `level`.                              |
| `icon`        | `string`                            | Icon KEY, resolved through a map — never a bare tag. See §13.5.                                                                     |
| `when`        | `(ctx) => boolean`                  | Hide entirely. Default: always visible.                                                                                             |
| `enablement`  | `(ctx) => boolean`                  | Show but disable. Defaults to always-enabled once `when` holds.                                                                     |
| `requires`    | `string`                            | ONE sentence — "an element selection". The disabled tooltip, the palette subtitle and the agent's refusal are all this string.      |
| `keybinding`  | `string \| string[]`                | Canonical chords (§13.3). User overrides layer on top.                                                                              |
| `args`        | JSON Schema                         | The palette's argument prompt AND the AI tool's parameters — one schema, two consumers.                                             |
| `menus`       | `Placement[]`                       | Surfaces the command renders in. Defaults to `["palette"]`.                                                                         |
| `group`       | `string`                            | Menu ordering key: `"1_clipboard"`, `"3_structure"`, `"9_danger"`.                                                                  |
| `undo`        | `"document" \| "project" \| "none"` | How the effect is undone — shown to the user before an agent runs it.                                                               |
| `destructive` | `boolean`                           | Derives the danger styling wherever the command renders.                                                                            |
| `aiTool`      | `{ name, description }`             | Opt-in projection to the assistant. The human's gate and the agent's gate stay ONE predicate.                                       |
| `run`         | `(ctx, args) => void \| Promise`    | The implementation.                                                                                                                 |

**`when` and `enablement` are plain predicates, not a string expression language.** They are closures
over the reactive context record (§13.4) — the same shape the AI tool gate already ships — so they
recompute for free and need no tokenizer, parser or evaluator. A serialisable grammar would buy
serialisability that nothing in Studio consumes.

Three things fail **at registration**, loudly, rather than degrading into a surface disagreement:

1. A duplicate `id` — the second definition site the design exists to prevent.
2. A chord already claimed in the same `keyScope` (§13.3).
3. A `menus` placement the level × placement matrix does not admit.

The registry has no module-level singleton: the bootstrap creates one and passes it down, so tests,
the CI checks and a second window each get their own, and the context arrives by injection.

**A command defines itself beside its implementation.** The record, the chord and the `run` are one
thing; a shared "all the commands" module would recreate the second definition site by another name.

### 13.2 Level — the containment vocabulary

`level` answers **what the command acts on**, and it governs placement.

| Level         | Acts on                                      | Examples                                 |
| ------------- | -------------------------------------------- | ---------------------------------------- |
| `application` | The editor itself, with or without a project | Toggle a dock, Zen, open the palette     |
| `project`     | The open project's files and settings        | Open Project…, Commit, a file-row action |
| `document`    | One open document                            | Save, Undo, Close Document, Next Tab     |
| `selection`   | The current node selection or its content    | Duplicate, Delete, Bold, Select Parent   |

The rule that settles contested cases: **file a command by the level of the state it _writes_, not
the state it _reads_.** Insert reads the project's component registry and writes the document tree,
so it is `document`. A Library action reads documents and writes project files, so it is `project`.

There is deliberately **no `range` level.** Bold, Italic, Code and Link act on a text range inside
the selected node, so their level is `selection` — what they act on is the selection's content —
while their `keyScope` is `caret`. A fifth level would demand a fifth region, and there is none.

### 13.3 KeyScope and chords

`keyScope` answers **where the chord is live**, and it is orthogonal to `level`:

`global` · `canvas` · `caret` · `grid` · `code` · `dock` · `palette`

Resolution walks a **scope stack**, narrowest first — `caret > grid/code engine > focused dock >
global`. A chord bound in a narrower scope shadows the same chord in a wider one; that shadowing is
the mechanism, not an accident, and it is why the two fields are separate. A chord whose command's
`when` is false is **not a hit**: the key falls through to the browser rather than being swallowed by
an action that is not there.

Chords normalise to one canonical string — modifiers in the fixed order `mod+ctrl+alt+shift`, key
lowercased — so `"Cmd+Shift+P"`, `"meta+shift+p"` and `"mod+shift+P"` are the same chord. `mod` is ⌘
on macOS and Ctrl elsewhere. **One function formats a chord for display** (`⌘⇧P` on macOS,
`Ctrl+Shift+P` elsewhere); no template may hardcode a glyph, or Windows and Linux users are shown
shortcuts they do not have.

Because `mod` absorbs the platform's primary modifier, a physical **Ctrl+Tab** normalises to
`ctrl+tab` on macOS and `mod+tab` elsewhere. A command that wants that one gesture on every platform
declares both spellings; each is unreachable on the other platform, so it binds one gesture, not two.

### 13.4 Context keys

One reactive record (`commands/context.ts`), derived from the reactive `shell` record, `workspace`
and `activeTab`. Predicates read it; nothing writes to it from a predicate.

| Group        | Keys                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `project`    | `open`, `isSite`, `isRepo`                                                                                                     |
| `git`        | `ahead`, `behind`, `dirtyCount`                                                                                                |
| `document`   | `open`, `dirty`, `mode`, `canUndo`, `canRedo`                                                                                  |
| `editor`     | `kind` — `canvas` \| `grid` \| `code` \| `diff` \| `library` \| `config` \| `none`                                             |
| `canvas`     | `view` — `edit` \| `design` \| `preview`                                                                                       |
| `pane`       | `count`, `derived`                                                                                                             |
| `selection`  | `count`, `kind`, `isRoot`, `isComponentInstance`, `isLayoutNode`                                                               |
| `caret`      | `active` (§10)                                                                                                                 |
| `focus`      | `region` — `rail` \| `navigator` \| `pane` \| `inspector` \| `dock` \| `status` \| `palette`                                   |
| `modal`      | `open`                                                                                                                         |
| `collab`     | `attached`, `readOnly`, `sourceCanonical`                                                                                      |
| `ai`         | `configured`, `streaming`                                                                                                      |
| `capability` | One boolean per PAL member: `gitClone`, `importSite`, `openProjectInNewWindow`, `dataRows`, `windowControls`, `findReferences` |

**`capability.*` replaces scattered platform branching.** A cloud/desktop/dev-server difference
becomes one `when` clause on one record instead of an `if (platform.x)` in every template that
touches the feature.

**Project-level keys are never sourced from the focused document.** Git status is a property of the
project, so it lives on the `shell` record (§3): sourcing it from `activeTab` made the rail's Source
Control badge vanish when the last tab closed, and let two tabs disagree about the branch.

### 13.5 Enforcement

| Check                             | What it fails on                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `scripts/check-command-levels.ts` | A `menus` placement the level × placement matrix does not admit                           |
| `scripts/check-chrome-budget.ts`  | More than five `commandbar/primary` commands, or more than four tabs in a dock            |
| `scripts/check-shot-contract.ts`  | A script naming an id nothing declares, a `toggle*` id, or a selector where an id belongs |
| `scripts/check-icons.ts`          | An icon that reaches no DOM, in either of the two ways one can                            |

All four run in CI, and `createCommandRegistry` applies the placement check again at registration so
a violation cannot reach a running app either.

**An icon is checked because nothing else can see it — and there are TWO key spaces, which fail
differently.** A TAG written in a template (`<sp-icon-x>`) resolves through `customElements`, and an
element the browser has never heard of is an `HTMLUnknownElement`: no shadow root, no content, no
warning, an empty box the size of the missing glyph. The type checker is silent (the tag is a string
in a template), and happy-dom is as content to render nothing as Chrome is, so a test asserting the
element is present passes. Eleven shipped that way. Three named elements Spectrum has no such thing
as — `sp-icon-rail-left-open`/`-close`, written by symmetry with the right-hand pair, which exists.

A KEY on a record (`icon: "sp-icon-x"`) is **not a tag**. It resolves through a map, and never
reaches `customElements` at all. A panel record's key goes to `activity-bar.ts`'s `tabIcon()`, whose
tail is `return fn ? fn(size) : nothing`: a key with no row is not a missing element, it is zero
nodes, and registering the element does nothing because the tag is never constructed.

**Conflating the two is not hypothetical.** Both spaces are spelled `sp-icon-*`, and one of the
map's own rows — `sp-icon-git-branch` — is not a Spectrum element but a hand-drawn inline `<svg>`,
because the workflow set ships no Git family. Reading that key as a tag says a working, pixel-perfect
glyph is broken; "correcting" it to a real Spectrum name replaced it with a key nothing resolved, and
a checker that asked only about registration passed the result. So keys are checked against their
resolver, and the resolver that is enforced is the one whose miss is SILENT: `commandIcon()` falls
back to the command's title and degrades visibly, `tabIcon()` falls back to nothing. A dead ROW is
checked too — the orphan left behind by that regression was still being exercised by a test, which is
how the suite went on proving a glyph rendered while the shipped panel pointed elsewhere.

**The scripting surface is a rendering, and these three rules are what make that true.**
`window.__jxAutomation` (installed only under `?automation=1`) exposes `run(id, args)`, `seed(id,
args)` and a read-only `probe`, and nothing else.

**1. The projection rule.** `__jxAutomation.run` **is** `registry.run`, behind an `isScriptable`
filter derived from the records themselves. There is no second action table: a hand-maintained
parallel list of what the app can do is a second definition site, which this section already calls a
defect. `probe.state()` returns the whole context record of §13.4 rather than a bespoke subset, and
`probe.commands()` is the same records with their gates already evaluated. An id the registry does
not declare **throws** — a silently skipped step leaves the app in a state its caller did not ask
for, and every consumer of that state then believes a lie.

**2. The idempotence rule.** A scriptable id names a STATE, never a delta. `run()` refuses
`/\.toggle[A-Z]/` at runtime and names the setter the id should have been. This is a correctness
property of the registry, not a convenience: `view.toggleAssistant` cannot say which state it ends
in, so a caller that cannot observe the current one is guessing — which is exactly how flipping the
assistant's default silently inverted 23 scripted steps, and exactly the bug an agent hits when it
calls the same id. `enablement` refusing is a failure, not a no-op: `run()` throws
`CommandUnavailableError` carrying the record's own `requires` sentence.

**3. The Remote Rule.** _A seed may only write state whose real writer is a network or IPC boundary.
It stands in for a remote, never for a user._ `seed.assistant` (the model stream), `seed.collab` (the
awareness socket), `seed.publish` (the Pages API), `seed.git` (the platform's git routes) and
`seed.projectList` (the recent-projects store) qualify; each declares the boundary it replaces.
Refused outright, and named in the refusal: `setStatus`, `setActivity`, `setRightTab`, `setZoom`,
`select` and `openSettings` — a user does all six, so a **command** does all six. Staging the status
bar in particular is not a fixture but a false report; a surface that needs a calm shell needs the
app to BE calm.

Three further refusals follow from the same three rules. **No method that accepts a selector** — if
a caller cannot say it in command ids, region ids and `JxPath`s, it cannot say it. **No write that
bypasses the transaction log** — automation mutates documents by running the commands a user runs.
**No compatibility shim**: a branch that exists to keep an external caller's verb working is that
caller's coupling living inside the product.

**"Settled" is a predicate, not a sleep** (`packages/studio/src/services/idle.ts`). `probe.idle()`
resolves once four subsystems have been quiet for two consecutive animation frames — no renderer
mid-paint (`store.ts`), no panel scheduler holding a frame or withholding a render
(`panel-scheduler.ts`), no unacked canvas generation or patch **per host** and no outstanding
font/animation/image-retry reported by the frame itself (`iframe-host.ts`, folding the
`{kind: "idle"}` message the canvas posts at its own rAF-quiet), and no in-flight platform call
(counted once, at `getPlatform()`, so every PAL method and every adapter is covered). **It rejects
with a `blockedBy` array naming each outstanding item**, and that rejection is the point: a sleep
cannot fail, so a subsystem that is slow answers "+500 ms" and the caller proceeds against state that
is still moving.

`probe.pointAt({ path })` and `probe.revealPath(path)` answer in **top-document coordinates**: the
app composes the iframe offset, the panzoom transform and the edit-zoom scale itself, because those
are its own arithmetic and a caller outside the app can only guess at them.

---

## 14. Tabs and Document Identity

**Status:** Partial — the identity model and the strip ship; per-pane tab strips and preview tabs are pending.

### 14.1 A tab's id IS its document

A file-backed tab is keyed by its path. Everything downstream believes that key: opening a file
looks for a tab with a matching path and activates it rather than opening a second one; the strip
uses the id as its list key; the collaboration session is keyed off it.

Consequently **a tab's document may never be swapped out from under its id.** Drilling into a
component opens a **real tab** of its own. It used to rewrite `documentPath` in place and leave `id`
alone, which broke the dedupe — re-opening the original page then called through with an id already
in the map, overwriting the entry without disposing the old tab's effect scope and pushing a second
copy of the id into the tab order: duplicate list keys and a leaked scope.

Opening an id that is already open **replaces** the tab in place — the previous one is disposed and
its position in the strip is reused. The id can never appear twice.

### 14.2 The drill-in relationship

The new tab records `openedFrom` — the id and path of the document the author drilled in from. It is
a **relationship, not a navigation stack**: nothing pops it, nothing restores from it, and closing
the parent leaves the child perfectly usable. The strip renders it as a `↳` marker and names the
origin in the tab's tooltip.

### 14.3 Sub-documents: withdrawn

**There is no per-tab document stack.** This section used to specify one — a stack of frames, each
snapshotting the parent's document coordinates and its whole UI context, restored on pop — reserved
for the two things that have no file of their own: `$map` templates and function bodies.

Both cases went elsewhere, and once they had, nothing was left that could push a frame. A function
body opens in the Bottom dock's Logic tab (§16.3), where the page it belongs to stays on screen
behind it — which is better than restoring you to a page you were never taken away from. A `$map`
template is a subtree of its parent document, selected in place on the canvas like any other node,
so it was never a document to descend into. Anything with a file of its own opens a **tab** (§14.1),
under the `openedFrom` relationship §14.2 is careful to say is not a navigation stack.

The machinery was nonetheless built, unit-tested and kept for six months. The push function had
**zero callers** the entire time, so `documentStack` was permanently empty and every consumer of it
was unreachable: the pop, the jump-to-level, a `Leave Sub-document` command in the palette, a
breadcrumb in the pane context bar, and a guard that detached the collaboration session while
"drilled in". A green test suite reported all of it working, because a unit test imports the module
it tests and cannot see that nothing else does.

The rule that generalises: **a stack needs a push, and the push is the part to specify.** A
restore-from-frame contract that nothing enters is not a partially-shipped feature — it is a shape
in the codebase that reads like one.

### 14.4 The tab strip

| Behaviour        | Rule                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Label            | The shortest **unique** path suffix among the open tabs. A page labels by its **route** (`/blog/[slug]`), because a realistic session has four files named `index.md`. A tab with no path uses its own name (a grid tab's table, otherwise "Untitled"). |
| Widening         | Only the tabs that actually collide grow a segment; one collision does not put a directory on every tab.                                                                                                                                                |
| Overflow         | A chevron at the strip's fixed right edge lists the tabs currently out of view and activates the chosen one. The scrollbar is hidden by design and the wheel is a mouse-only affordance, so the chevron is the pointer-independent route.               |
| Activation       | Activating a tab points the **file tree** at its document — the tree and the strip never disagree about where you are — and promotes it in the MRU order.                                                                                               |
| Dirty            | A dot; closing a dirty tab asks before it discards — see §14.7. `⌘W` and the tab's `×` are one implementation, because two copies of that prompt drifted apart once already.                                                                            |
| `⌃Tab` / `⌃⇧Tab` | Cycle the **MRU** order, not the strip order (§14.5).                                                                                                                                                                                                   |
| `⌘⇧T`            | Reopen the most recently closed document (§14.6).                                                                                                                                                                                                       |

### 14.5 MRU cycling

Tabs carry a most-recently-used order alongside their left-to-right order, because "the tab I was
just in" is rarely the one to the left. Closing the active tab lands on the most recently used
survivor, not the rightmost.

`⌃Tab` freezes a snapshot of the MRU order for the duration of a cycle and walks it **without
reordering**. Without the snapshot the first press would promote the tab it landed on and the second
would come straight back — the shortcut would only ever toggle between two tabs. The cycle ends when
the modifier is released (the tab the author settled on becomes the most recent) or at the next
ordinary activation.

### 14.6 Reopen closed

Closing a **file-backed** tab records its path on a bounded, newest-first stack; `⌘⇧T` pops the stack
and re-reads the file. A virtual tab with no path is not recorded — there is nothing to re-read, and
offering to reopen it would be a lie. The command renders disabled, with its reason, until something
has been closed.

### 14.7 Closing over unsaved work

Three answers, because there are three things the author might mean: **Save · Close Without Saving ·
Cancel** (`showSaveDiscardDialog`, `studio-ui-guidelines.md` §8.7, whose table assigns that dialog to
unsaved-work decisions). `⌘W` and the tab's `×` ask it through one implementation.

**The close is conditional on the write, never concurrent with it.** A save that fails leaves the tab
open, still dirty, with the reason in Problems. This is the reason `saveFile` returns a boolean
rather than reporting and swallowing: reporting is right for `⌘S`, where the tab stays open either
way, and useless where the answer decides whether the work survives.

**A dialog may not offer an answer the app cannot honour.** A read-only collaborator's local edits
reach nothing — the mirror and the record publish are both gated on write permission, while the
document still marks itself dirty — so `saveFile` refuses those tabs outright rather than falling
back to writing the shared room's file to disk behind its owner. The prompt therefore has **two**
answers there, headlined _Changes Cannot Be Saved_: **Close Without Saving · Keep Editing**. Three
answers when only two are real is the same dishonesty as one when there are three, and it is worse
on the one dialog whose whole job is to be trusted about losing work.

The rule generalises past this dialog: **before a surface writes, it establishes that it may.** The
Bottom dock made that concrete by raising the rate at which the Logic editor is torn down and
repainted — a debounce armed over a disposed editor reads `""` from it, and a repaint that re-syncs
the buffer from the document discards whatever is being typed. Both were data loss, both were
invisible to a green suite, and both are one question asked too late.

## 15. Application Preferences

**Status:** Partial — Appearance, Assistant, Accounts and a read-only Keyboard sheet ship; Editor
behaviour, rebinding and Updates/About are pending.

`project.json` configures a **project** and is edited as a project document (`⌘⇧,`, command id
`settings.open`). **Preferences** (`⌘,`, command id `app.preferences`) configures the
**application** and follows the author between projects. The two are different surfaces because they have different lifetimes; conflating them is
why Studio had nowhere to put the chrome theme, the provider key, or the credentials it holds.

Preferences is a focus-managed dialog over the overlay contract in `studio-ui-guidelines.md` §8.7.
It does not suspend the app, and it is reachable with **no project open** — a first run needs it
exactly there. Re-opening it while it is up selects the named section rather than stacking a second
sheet.

| Section    | Contents                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| Appearance | The chrome theme (`shell.theme`, also settable by `view.setTheme`)                                         |
| Assistant  | The AI provider key, model and endpoint, plus the keyless managed-connect path where a platform offers one |
| Accounts   | Every credential Studio holds — GitHub, the AI provider, Cloudflare — listed with a Disconnect each        |
| Keyboard   | Read-only, **generated** from the command registry                                                         |

Two rules the sections must keep:

1.  **An account row never prints the secret it describes.** It reports that something is stored and
    what it is for. Disconnecting is idempotent, and revoking one account never touches another.
2.  **The Keyboard sheet is generated, never authored.** It is the same projection
    (`shortcutReference()`) that produces `docs/studio/interface/shortcuts.md`, so the in-app sheet
    cannot drift from the app or from the documentation, and a command contributed by an extension
    appears in it without anyone editing a list. One row per **binding**, not per command; a
    chordless command is not listed, because there is nothing to press. Per the screenshot contract
    there is deliberately **no screenshot** of it.

Saving or revoking a credential announces itself, so surfaces that gate on one (the Assistant tab's
setup notice) repaint without Preferences having to know they exist.

---

## 16. Feedback, Problems and Progress

**Status:** Implemented — the notification substrate, the Bottom dock and all three of its tabs
(Problems, Logic, Activity), and the inline field slot.

Studio's predecessor had one feedback surface: a 24px status bar carrying 78 outcomes — successes
and failures alike — in identical 11px grey text, destroyed after 3000ms. Nothing persisted, nothing
could be acted on, and 158 of 240 `catch` blocks reached no surface at all. This section replaces
that with **three lifetimes, chosen by the action the outcome requires.**

### 16.1 The three tiers

| Tier        | Lives                    | For                         | Where                                  |
| ----------- | ------------------------ | --------------------------- | -------------------------------------- |
| **Toast**   | seconds, then retires    | reversible, needs no action | `overlay.toasts`, the fourth layer     |
| **Problem** | until it is fixed        | must be fixed               | Bottom dock ⑪, count in the status bar |
| **Inline**  | as long as the bad value | a value the user just typed | at its own control                     |

`notify(severity, message, options)` is the only sanctioned entry point; `severity` is one of
`success | info | warn | error`. The tier is **derived** from the severity — `error` defaults to a
Problem, everything else to a toast — and `options.tier` overrides it, so a warning that must be
fixed says so at its call site. A lint bans raw status writes outside `notify`, and bans bare empty
`catch` blocks in `src/`, because a wide shallow change without a mechanical guard regrows.

Three rules hold across all three tiers:

1.  **Recovery is a command id, not a closure.** `options.action` names a registered command, so the
    button is rendered from the registry — with the command's own title, its keyboard chord and its
    `requires` sentence when it is disabled. An unregistered id renders **no button**, which is what
    lets a call site name a capability that lands a phase later without shipping a dead control.
2.  **A record carries where it came from.** `source` (the subsystem) and `path` (the file) are what
    make a Problem clickable and what let `clearProblems(match)` retire a whole class of them when
    the underlying file is fixed.
3.  **A repeat is not a new row.** `options.key` dedupes, so a failing watcher does not produce a
    thousand identical Problems.

### 16.2 The status bar carries ambient state only

Three fields in scope order — **project ‖ document ‖ selection** — every item a command, the save
state worded rather than a coloured dot. It reports the _effective_ view, so it cannot say one thing
while the pane context bar says another. **No transient message is ever written to it.** That
separation is the point: state that is true until something changes it, and outcomes that happened
at a moment, are different things and had been sharing one 24px strip.

### 16.3 The Bottom dock

`⌘J`, under the **pane grid** rather than the window, so it never steals width from the side docks —
and never covers the canvas, which is the one region that must not disappear. Three tabs, under a
documented cap of four: **Problems · Logic · Activity**. It opens **collapsed**: an empty Problems
list must not spend 220px of canvas to say nothing.

**No Bottom-dock tab has a rail button, Problems included.** It had one — the fourth slot in the
rail's PROJECT group, with the count as its badge — and it was wrong on two counts. Mechanically,
every other rail button opens a panel at the SIDE, so one that opened a dock along the BOTTOM
needed a per-dock branch in `toggleRailPanel`, in `isRailPanelShowing` and in `focusPanel`: three
branches so that one button of eight behaved like the other seven, and a control pointing left at
something that appears below. And as a matter of what the shell SAYS: permanent navigation is a
product's statement of what it is for, and a standing, first-class entry named Problems tells a
new user to expect them before they have any. The count is not hidden — it sits in the status bar
beside the branch and the deploy step, which is where ambient project state already lives, and it
appears the moment the count is non-zero. Clicking it runs `view.setBottomTab { tab: "problems" }`,
the same single door Diff, Logic and Activity are reached by. There is no `panel.focus.problems`,
because the ⌘1–8 roster follows the rail.

**Logic is why the dock exists.** The function editor and the formula workspace were canvas
takeovers; here the page whose values they compute keeps rendering behind them. Because a takeover
reveals itself by definition and a dock tab does not, opening a target reveals the dock on Logic —
**once per target**, so closing the dock over an open formula keeps it closed. The tab joins the
strip while there is something in it and leaves when the editor's own **Close** clears it; nothing
short of that closes it, so collapsing the dock or leaving the document and returning keeps your
place. Nothing else may draw a second exit beside that Close.

**The fourth slot is free, and Diff is not waiting for it.** Diff was reserved here behind a
permanently-false predicate for four phases, on the strength of an argument against its own
reservation: `diff` is an editor **kind**, a pane hosts it at pane size, and folding it into a 240px
dock would be a downgrade. What it lacked was a pane to open into, and §18 shipped one. A
reservation whose capability arrived somewhere better is not a reservation — it is an id in
`view.setBottomTab`'s enum that can only ever select a hidden tab.

`view.setBottomDock {open}` and `view.setBottomTab {tab}` are the idempotent setters; the toggle is
defined in terms of them. The region id `dock.bottom` resolves **only while the dock is open**, so
keyboard region cycling never lands in a collapsed dock and a capture can never crop one.

### 16.4 Activity, and what may still block

Any long operation opens an Activity entry: a title, a status line, an ordered step list, a
streaming log, and **Cancel** when the caller supplies one. An entry outlives the operation, so a
failure is inspectable after the fact instead of only while a modal is up.

`fail()` does not render an error view of its own — it raises a Problem carrying the log as detail.
This is the inversion the section exists for: the progress modal used to be the **only** surface in
Studio with a real error view, and it was reachable from four call sites.

**Blocking is retained for dependency installation only**, and even there the modal offers _Run in
the background_ and a real Cancel. Every blocking operation also leaves an Activity entry, so
dismissing the modal never discards the account of what happened. Project open — which chained a
blocking spinner, a transient status line and a confirm-plus-spinner, none cancellable — is one
Activity entry with steps.

Running activities are a quiescence source: `probe.idle()` (§13.5) counts an open entry as
not-idle, so automation cannot photograph a half-finished operation.

### 16.5 Inline errors, and the withheld render

A field's own error is rendered by the shared field row, so every consumer inherits it from one
edit. Host-supplied diagnostics (`jx-validate`, Monaco markers) **win over** the intrinsic schema
check, and a form the user has not touched paints nothing — marking every required field red on
first render is this section backwards.

Two write policies coexist deliberately, and each surface states which it uses: a form that builds a
**candidate** validates before applying, so a refusal leaves the old value standing; a form that
mutates project state in place can only **report**, because a pre-write check there would delay
persisting what the user can already see rather than prevent anything.

Panels defer a render while one of their own fields has focus — finishing the author's sentence
beats being current — and that deferral is now visible rather than silent. A panel showing state
from before the last edit is correct; a panel showing it with no indication is indistinguishable
from a panel that has stopped working.

---

## 17. Project Documents (Settings and Styles)

**Status:** Partial — `project.json` is a document under the transaction log and both surfaces
render from it; the formatting-preserving writer described in §17.2 is not built.

Project configuration used to be edited through a modal by **29 fire-and-forget call sites across
eight files**, twenty-one of which dropped a rejected write on the floor — `void
saveProjectConfig()`, or an `await` inside an un-awaited click handler. It was the app's
highest-consequence silent-failure path, and it wrote the file that defines the project.

### 17.1 Configuration is a document

`project.json` is a **Tab**, which is what makes the rest true rather than aspirational: it gets
undo, the dirty flag, ⌘S and the history delegate from the same machinery every document uses. Two
surfaces render it — **Project Settings** (sections as inner nav: Overview, Contexts, Site head,
Definitions, Content types, Packages, Extensions, Deploy, Raw JSON) and **Project Styles** (§7) —
and both edit one object.

Three rules follow, and they are the section's whole content:

1.  **One chokepoint.** Every configuration write goes through a single commit path: one
    serialization, one error path. A rejected write raises a **Problem** (§16) naming the file; it
    is never dropped.
2.  **`registerSettingsSection` survives.** An extension contributes a section, and a section that
    fails to load reports to Problems rather than leaving a blank pane.
3.  **`project.json` is excluded from collaboration replication.** No session attaches to a tab whose
    `documentPath` is `project.json`, so no history delegate is registered over it. Its edits arrive
    from surfaces that are not the canvas, and its value configures the local editor's formats,
    extensions, schemas and style cascade — a shared document would let one author's configuration
    reconfigure another's editor mid-keystroke, and would let the source-canonical freeze pause
    configuration edits that contain no text. `specs/collab.md` states the same exclusion.

### 17.2 A no-op edit writes nothing

The committed `project.json` files in a repository are formatted by whatever formatter the project
uses, not by `JSON.stringify`. Re-serializing a parsed config therefore does **not** reproduce the
bytes on disk — short arrays get expanded, authored line breaks are lost — so a writer that compares
bytes would rewrite the entire file's indentation on the first settings edit, and every settings
edit would arrive as a whole-file diff that hides what actually changed.

**The commit compares semantically and writes nothing when nothing changed.** That is
formatting-independent, and it is what makes a settings edit reviewable.

A real one-field edit still re-serializes the whole file, so it still reformats. Preserving the
author's formatting through a genuine edit needs a key-span splice over the original text and is
**not built**; until it is, a configuration edit is a whole-file diff, and this section says so
rather than implying otherwise.

### 17.3 What the surfaces may assume

A settings surface renders from the configuration document and commits through the chokepoint. It
may not keep its own copy of the config object: two objects is how an edit gets silently reverted
by whichever writer runs second. A surface that needs to reject a value validates it and reports
inline (§16), rather than writing and hoping.

---

## 18. Panes

**Status:** Implemented — the pane grid, two live Canvas panes, per-pane canvas state, the jump bar,
the dock takeovers and derived panes.

### 18.1 A pane is where a document is shown

Two panes at most, and the cap is enforced in code rather than by convention — `splitRight` is the
only pane creator and refuses past the maximum. **Both panes draw a live Canvas**, and a split is a
move: the tab crosses as it is.

**There is one cap now, and it is on the number of panes.** A second cap used to sit beside it,
naming the editor kinds a pane other than the primary could host — Code, Diff, Config, Entry, Grid,
Library, the cheap ones — because a second live host was unaffordable while the shell had one stage
to hand between panes and one app-wide render generation to invalidate. Neither is true any longer,
so the kind cap has nothing left to protect and every predicate that read it is deleted, including
the one that flipped a splitting Design tab to Code on its way across. `MAX_PANES` stays at two
because two is a measured budget, not a placeholder: each host is a real `@jxsuite/runtime` render,
an `iframe-channel` connection and a structured clone, all on one main thread.

Three rules govern the lifecycle, and each of them was a defect first:

1.  **A pane is complete before it is published.** Focus moves last. Publishing a pane's id before
    its tab left every `activeTab` reader — the jump bar, the Inspector, the toolbar — printing
    "no document" over a stage that was drawing one.
2.  **A pane is never observable without existing.** Closing one hands the survivor its tabs and
    the focus while both are still in the grid, and only then removes it. The window between
    "focused" and "present" emptied the stage and nothing repainted it, because the render effects
    key on the active _tab_ and the tab had not changed.
3.  **A pane with nothing in it is a hole in the grid**, so every path that empties one collapses
    it. Closing the last tab had this rule; splitting the last tab back to the primary did not, and
    three keystrokes reached a shell with no stage, no tab strip and no jump bar while two
    documents were open.

### 18.2 What a second pane costs, and what it does not

Parent-side render preparation happens **once per pass**, not once per host: the document is
resolved and serialized once and fanned out to every live host, so that cost is flat in the number
of hosts rather than linear. Param-bound state used to make one backend round trip **per host** for
the same data; it makes one.

**What no fan-out removes:** each frame lays out its own viewport, and same-origin frames share the
renderer's main thread, so N hosts remain N `@jxsuite/runtime` renders and N structured clones.
That is the real budget for a second live Canvas, and it is why the cap exists at all.

**A pane owns its canvas state.** The mounted artboards, the canvas mode, the previous mode that
decides a teardown, and the escalation target are all per pane. A patch escalates the pane showing
the document, not every pane — and "is this tab patchable" asks whether _a pane is displaying it_,
not whether the keyboard is in that pane, which is the more truthful question and happens also to
be the correct one.

**Anything a host reports resolves through the host, not through focus.** A canvas message names
its own tab; reading `activeTab` instead wrote the clicked breakpoint, the selection and the
resolved data scope to whichever document happened to be focused. With one stage that was invisible.
With two it is a data bug, so the resolution is by host everywhere, including the artboard header
that lives on the parent side.

### 18.3 The grid draws a cell per pane

There is no stage handover. The shell used to own one of each pane-scoped surface — one tab strip,
one jump bar, one context bar, one stage — as flat rows of the **application** grid, which is to say
application rows that only ever described the primary pane, handed to whichever pane took focus. The
pane grid draws **one cell per pane**, each holding that pane's own four surfaces, and every pane
registers its own canvas surface when its cell is built and releases it when the cell is disposed.
Nothing changes hands, so no pane is ever left describing DOM it does not own.

**The grid is a keyed template, and the key is load-bearing.** A cell is identified by its pane id,
so an unchanged cell's DOM is moved rather than rebuilt. That is not a preference: re-parenting an
`<iframe>` reloads it, dropping its channel, its document and every acknowledged panel. Expressing
the reconciler declaratively turns a rule the previous imperative version could only ask for in a
comment into a property of the rendering.

**A split is a side-by-side.** Two documents, both live, both editable, each with its own strip,
address, context bar and stage, and a splitter between them whose ratio is layout state. Every
string a reader sees may now say so — and the converse obligation held for as long as it was false,
which is why `pane.splitRight` spent a release refusing to promise "beside the canvas".

**Clicking into a pane focuses it.** For most of this section's life `focusPane` had exactly one
call site — the tab strip — so a click on a pane's canvas, its context bar or its editor left the
keyboard in the other pane, and the unfocused pane was not a rare state but the state you were in
the moment you clicked into one. A cell focuses its pane on pointerdown; a frame reports the same
through the protocol, because a click inside a cross-origin document does not reach the parent.

**Nothing drawn for a pane may resolve the focus.** This is the rule the whole section reduces to,
and it was violated in every module that had been written when there was one stage — the Document
Header card mutating the focused document, the zoom axis writing the focused tab's scale, a render
posting the focused tab's colour scheme into whichever pane it was drawing, a host asking the focus
whether to restore a caret it owed. Each was correct while "the focused pane" and "this pane" named
the same thing. `scripts/check-pane-singletons.ts` enforces it: a function whose parameters name a
pane may not read the focus in its body, one hop into a helper that does not name its own subject.
A rule over a list of field names could not see any of this, which is why it parses.

**A surface that caches "am I mounted?" in a module outlives the DOM it mounted into.** Every such
fast path must also ask whether the mode changed, or it returns on the strength of an editor whose
container was thrown away one frame earlier.

### 18.4 Derived panes

A derived pane is chosen by a **standing rule** rather than by a document: show me the Code of
whatever that pane is showing, or its diff, or the layout it uses, or the definition of the
component under its selection, or the same page at one named breakpoint. The rule re-resolves when
its inputs change, and **Pin** ends the following and leaves an ordinary tab.

**A preset is one of three mechanisms, and which one is decided by the document, not by taste.**

1.  **A projection** — Code and Diff. The same document in a different view, which needs a second
    `Tab` because `session.ui` is per-tab: the two panes disagree about mode, scroll and zoom while
    agreeing about content. So a projection shares the source's document and history _by reference_
    and carries its own session, and its id names the lens as well as the document.
2.  **A follow** — Layout and Component definition. These are _different documents_, and a second
    id over one file would be two documents, two undo stacks, two collaboration rooms and a race to
    save. §14.1 read in the other direction. So the pane opens the ordinary path-keyed tab and the
    rule only decides _which_.
3.  **Neither** — "the same page at ⟨breakpoint⟩" is one artboard of the design board the pane
    already draws. It was specified as a preset and is a filter.

**§14.1 holds, and is stronger for this.** A projection's id names the document _and_ the lens, and
neither is ever reassigned: following is dispose-and-open, never mutation, which is exactly the
discipline the rule was written after the drill-in failure to enforce. What a projection does
endanger is the other half — _opening a file finds the tab that already has it_ — because two ids
now reach one document. That is preserved by four exclusions stated once: a derived id is never a
dedupe target, never a reopen record, never a collaboration key, and never counted among the
documents a close-all would lose.

**A pane may hold a derivation or tabs of its own, never both.** A projection borrows the pane, so a
gesture that puts a document there — a split, a compare, a drill-in — releases the rule rather than
stacking on it. The author asked for a document to be somewhere; the projection had nothing to lose.

**A preset that cannot be supplied is not offered**, and one that stops resolving says so on the
stage rather than leaving the pane blank. A pane showing a rule that has gone quiet still names the
document it holds and offers the verb that ends the follow — the alternative is a pane with no
chrome, no exit and no explanation, which is the shape §16 exists to refuse.

---

## Changelog

- **0.9.8-draft** (2026-08-11) — Project Settings carries ⌘⇧,, the other half of the pair §5.3 declares.
- **0.9.7-draft** (2026-08-11) — Data rows: truncation markers are controls, Refresh reports the render rather than a timer, and an entry that cannot hold a value keeps its definition summary.
- **0.9.6-draft** (2026-08-11) — The Activity Bar names the panels that ship, in their two rail groups; the Data panel is one list of definitions and the values they resolve to (§5.6), taking over the State panel's editor.
- **0.9.5-draft** (2026-08-11) — §6.6 the value-source ladder gains a fourth rule — a position whose schema narrows which operators it admits seeds its own Formula rung, because the generic bare-?? seed is an invalid document there; an element's tagName joins the ladder, deriving to Fixed value + Formula with no template rung because TagName carries a pattern.
- **0.9.4-draft** (2026-08-09) — §16.3 Problems leaves the Navigator rail — no Bottom-dock tab has a rail button, the count lives in the status bar and runs view.setBottomTab, and panel.focus.problems is gone with the ⌘1-8 roster that follows the rail; §16.1 restates where a Problem is surfaced.
- **0.9.3-draft** (2026-08-09) — §13.5 corrects check-icons — an icon key on a record is resolved through a map, not registered as a tag, and the two spaces fail differently; the previous text asserted the opposite and licensed a fix that replaced a working hand-drawn glyph with a key nothing resolved.
- **0.9.2-draft** (2026-08-08) — §13.5 adds scripts/check-icons.ts — an sp-icon-* tag no element registers, or a registered element Spectrum does not ship, is now a red PR; the command record's icon field described accurately as a tag name rather than a key into a map.
- **0.9.1-draft** (2026-08-08) — §18.4 derived panes ship — a pane chosen by a standing rule rather than a document; a preset is a projection (Code, Diff — one document, two sessions), a follow (Layout, Component definition — genuinely different documents) or a filter (a breakpoint of the board already drawn); §14.1 holds because following is dispose-and-open, with four exclusions keeping one document to one tab; a pane holds a derivation or tabs, never both.
- **0.9.0-draft** (2026-08-07) — §18 Panes rewritten for two live panes — the grid draws a keyed cell per pane and the stage handover is deleted; the editor-kind cap on the side pane is gone and a split is a real side-by-side; clicking into a pane focuses it; nothing drawn for a pane may resolve the focus, enforced by check-pane-singletons; §18.4 derived panes named as not built.
- **0.8.0-draft** (2026-08-07) — Sub-documents withdrawn (§14.3) — the stack had no push, so nothing could enter it; §14.7 closing over unsaved work, and §4.2 source is batched so every exit settles first; the Bottom dock is three tabs and Diff is a pane editor kind (§16.3); §18 Panes — the two-pane cap as one predicate, one stage handed between panes, and no pane zoom until there is a grid to zoom.
- **0.7.0-draft** (2026-08-06) — §18 Panes — the two-pane cap as one predicate, the three lifecycle rules each defect taught, what a second pane costs and what no fan-out removes, and the single stage handed between panes.
- **0.6.0-draft** (2026-08-05) — §7 Stylebook becomes Project Styles (name only — "stylebook" stays the wire value) and §17 Project Documents: project.json as a Tab under the transaction log, one write chokepoint, a no-op edit that writes nothing, and the collab exclusion.
- **0.5.2-draft** (2026-08-05) — §5.2 the move buttons follow the primary selection and stay single-target under a multiple selection.
- **0.5.1-draft** (2026-08-05) — §6.2 corrects the Target Line illustration — the selector is the last segment and a scheme variant appears only at Base — and retires the breakpoint-tabs, inline-selector-picker and Active-toggle subsections the Target Line replaced.
- **0.5.0-draft** (2026-08-04) — §6.2 the Target Line and its scope chip; §6.6 the one value-source ladder; §6.7 provenance chips naming the donor, and selection as a JxPath[] with Mixed values and one transaction per batch; §7.4 scheme declaration moves to Contexts.
- **0.4.4-draft** (2026-08-04) — §16 Feedback, Problems and Progress — the three notification tiers, the Bottom dock, Activity, and the status bar as ambient state only.
- **0.4.3-draft** (2026-08-03) — §9.1.1: destructive confirmations state the reference count — what a delete breaks, what a rename rewrites, and the three states (counted / uncountable / unsupported) that are never collapsed.
- **0.4.2-draft** (2026-08-03) — The Inspector's fourth tab (§3.1, §6): the assistant is Content · Style · Logic · Assistant, not a fifth column; two docks, one persisted record. Application Preferences (§15) — Appearance, Assistant, Accounts (listed and revocable) and a registry-generated Keyboard sheet.
- **0.4.1-draft** (2026-08-02) — Automation surface is a projection of the command registry (§13.5): the projection, idempotence and Remote rules; probe.idle() as a failing predicate; pointAt in top-document coordinates.
- **0.4.0-draft** (2026-08-02) — Command Registry and Context Keys (§13); Tabs and Document Identity (§14) — drill-in opens a real tab, labels disambiguate by route.
- **0.3.8-draft** (2026-08-02) — Layout chrome is selectable and inert to the caret; Preview gates editing and scrolls for real; Design opens fitted; caret.active is a bridge fact; Open in Browser (Cmd+Shift+O); assistant column defaults closed.
- **0.3.7-draft** (2026-07-29) — Share one bundler contract between the release build and the dev-server watcher; nothing may fetch Monaco at startup; restrict preview navigation to http/https/mailto/tel.
- **0.3.6-draft** (2026-07-28) — Preview link clicks open the target in a real browser tab instead of navigating the canvas iframe away.
- **0.3.5-draft** (2026-07-28) — IME composition suspends canvas commits; the editable region gets textbox/aria-multiline/label (§8.2.8).
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

_`@jxsuite/studio` Specification v0.9.8-draft_
