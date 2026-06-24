---
title: "Studio Overview — Jx Suite"
description: "Understand JX Studio's architecture, design principles, three-column layout, data flow, and how it fits into the JX ecosystem."
---

# Studio Overview

JX Studio is a visual IDE for the web. Design on a canvas. Inspect and edit properties. Write event handlers. Everything saves as plain JSON files — the same files your compiler reads, your git tracks, and your team reviews.

## Design Principles

### JSON is the source of truth

Studio reads and writes .json files. No proprietary intermediate format. Any editor can open them. Git diffs are readable. CI can validate them.

### Canvas is the runtime

The preview canvas renders via @jxsuite/runtime — the exact same engine that compiles your site. What you see is what ships.

### Zero lock-in

Studio edits produce standard Jx files. The compiler reads those same files. No export step. No proprietary format. Your content is yours.

### Self-hosting

Studio is itself a JX application served by @jxsuite/server. The visual builder is built with the same framework it helps you build.

### Developer-first

Keyboard shortcuts for everything. Undo/redo with full history. Code editing with Monaco. Git integration built in. Designed for people who build websites for a living.

## Three-Column Layout

Studio uses a three-column layout:

- **Left Column** — Activity bar switches between panels: Layers (tree view of elements), Files (project explorer), Imports (component registry), Source Control (git), Data Explorer, and Settings.
- **Center Column** — Canvas renders the live component preview. Toolbar above switches modes (Design, Stylebook, Preview, Source, Content), controls zoom, and manages media breakpoints.
- **Right Column** — Inspector shows tabs for Properties (tagName, className, textContent), Style (CSS properties panel), Signals (state entries), Events, and AI Assistant chat.

## Data Flow

```
.json file → Studio State → Canvas Render ⇄ Inspector
(source of truth)  (immutable + undo)  (@jxsuite/runtime)  (properties / style / state)
```

The inspector panels read from the immutable state and write mutations through `transactDoc()`. Each mutation is a discrete undoable step. The canvas re-renders automatically via Vue reactivity — no manual refresh needed.

When you save (`Ctrl+S`), the current state is serialized back to the .json file on disk. The compiler can then build from those same files — no export step, no format conversion.

---

**Next:** [Interface Walkthrough](/docs/studio-interface)
