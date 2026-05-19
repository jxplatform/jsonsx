# `@jxsuite/compiler`

> Static HTML compiler, custom element emitter, and site builder for Jx.

## Overview

The compiler transforms Jx `.json` documents into optimized production artifacts. It erases all Jx abstractions at build time — the output is plain HTML/CSS/JS with no JSON and no Jx-specific code shipped to browsers.

## Installation

```bash
bun add @jxsuite/compiler
```

## CLI

```bash
# Build a site from project.json
jx build [project-root] [--verbose] [--no-clean]
```

## API

```js
import { compile } from "@jxsuite/compiler";

const { html, files } = await compile("./counter.json", {
  title: "My App",
  projectStyle: null,
});
```

## Compilation routes

The compiler auto-detects the appropriate output target:

| Route | Condition | Output |
|-------|-----------|--------|
| 0 — Class | Input is `.class.json` | ES class module |
| 1 — Static | No dynamic bindings | Plain HTML/CSS, zero JS |
| 2 — Custom element | Root `tagName` contains a hyphen | `HTMLElement` subclass + lit-html |
| 3 — Dynamic page | Dynamic, standard `tagName` | Pre-rendered HTML + reactive JS |
| 4 — Server | Has `timing: "server"` entries | Hono server handler |

## Site builder

```js
import { buildSite } from "@jxsuite/compiler/site";

const result = await buildSite("./my-site", { verbose: true, clean: true });
// { routes: 12, files: 36, errors: [] }
```

`buildSite` reads `project.json`, resolves all pages/layouts/components, runs each through the compiler, and writes the output to `build.outDir` (default `./dist`).

## Exports

| Export | Description |
|--------|-------------|
| `compile(src, opts)` | Compile a single Jx document |
| `compileClient(doc, opts)` | Dynamic page with reactive hydration |
| `compileElement(doc, opts)` | Custom element module |
| `compileServer(src, opts)` | Hono server handler |
| `compileSiteServer(entries)` | Site-wide server bundle |
| `isDynamic(doc)` | Detect whether a document needs JS |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@jxsuite/parser` | Markdown transpilation |
| `@jxsuite/runtime` | Shared utilities |
| `sharp` | Image optimization |
| `unified` / `remark-*` | Markdown processing |

## License

MIT
