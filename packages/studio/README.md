# `@jxsuite/studio`

> Visual builder for Jx documents.

## Overview

Jx Studio is a browser-based visual IDE for Jx applications. It renders a live canvas via `@jxsuite/runtime`, provides a layer tree for structural editing, an inspector for property/style/state management, and a Monaco-powered code editor for function bodies. The UI is built with [Adobe Spectrum Web Components](https://opensource.adobe.com/spectrum-web-components/).

At the site level, Studio acts as a CMS — providing a project explorer, content collection browser, schema-driven entry editors, and media management.

## Development usage

Studio is served by `@jxsuite/server` during development:

```bash
bun run dev   # starts dev server + Studio at http://localhost:3000
```

## Architecture

Three-column layout:

| Column | Content |
|--------|---------|
| Left | Activity bar + panel (layers, files, content, settings) |
| Center | Canvas (live preview) + toolbar |
| Right | Inspector (properties, style, state, code) |

### Data flow

```
.json file → Studio state (immutable) → Canvas (runtime render)
                    ↓
            Inspector panels → mutation → new state → write .json
```

### State model

Immutable state tree with 100-entry undo/redo history. All mutations produce a new state object. Key operations:

| Operation | Description |
|-----------|-------------|
| `selectNode(path)` | Select element by path |
| `insertNode(path, def)` | Add child element |
| `removeNode(path)` | Delete element |
| `moveNode(from, to)` | Reorder or reparent |
| `updateProperty(path, key, value)` | Set element property |
| `updateStyle(path, prop, value)` | Set style property |
| `updateDef(key, value)` | Update state entry |
| `pushDocument(doc)` / `popDocument()` | Navigate into/out of sub-components |
| `undo()` / `redo()` | History navigation |

### Platform Abstraction Layer (PAL)

Studio is backend-agnostic. Platform bindings (filesystem access, native dialogs, Git, package management) are injected at startup via `registerPlatform()`. Three targets share a single codebase:

| Target | Backend |
|--------|---------|
| Desktop (Electrobun) | `@jxsuite/desktop` Bun process |
| Dev mode (Chrome) | `@jxsuite/server` (localhost) |
| SaaS | Cloud API (future) |

## API

```js
import { createStudio } from "@jxsuite/studio";
import { registerPlatform } from "@jxsuite/studio/platform.js";

registerPlatform(myPlatform);
createStudio(document.getElementById("root"));
```

## Design principles

1. **JSON is the source of truth** — Studio reads and writes `.json` files directly.
2. **Canvas is the runtime** — Preview renders via `@jxsuite/runtime`, pixel-identical to production.
3. **Zero lock-in** — Studio edits produce standard Jx files that any editor can open.
4. **Self-hosting** — Studio is itself a Jx application.

## License

MIT
