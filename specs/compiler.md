# `@jxsuite/compiler` Specification

## Static HTML Compiler, Custom Element Emitter, and Island Detector

**Version:** 2.0.0-draft
**Status:** Partial
**Updated:** 2026-07-22
**License:** MIT

---

## 1. Overview

The Jx compiler transforms `.json` component files into optimized production artifacts. It erases all Jx abstractions at build time — no JSON, no runtime, and no Jx code ships to production. The compiler auto-detects the appropriate output target based on document analysis.

**Production dependencies:** `@vue/reactivity` (~7 kB gzip) + `lit-html` (~3 kB gzip).

---

## 2. Compilation Routes

The compiler inspects each input document and routes to the appropriate compilation target:

| Route              | Condition                               | Output                                 | Status          |
| ------------------ | --------------------------------------- | -------------------------------------- | --------------- |
| 0 — Class          | Input is `.class.json`                  | ES class module                        | **Implemented** |
| 1 — Static         | `isDynamic()` returns false             | Plain HTML/CSS, zero JS                | **Implemented** |
| 2 — Custom Element | Root `tagName` contains hyphen          | `class extends HTMLElement` + lit-html | **Implemented** |
| 3 — Dynamic Page   | `isDynamic()` returns true, no hyphen   | Pre-rendered HTML + reactive JS        | **Implemented** |
| 4 — Server         | Document has `timing: "server"` entries | Hono server handler file               | **Implemented** |

### 2.1 Static Detection (`isDynamic`)

A node is static if it and all descendants satisfy:

- No `state` entries that produce signals or functions
- No `${}` template strings in any property value
- No `$prototype` namespaces
- No `$switch` nodes
- No `$prototype: "Array"` children
- No `$ref` bindings on element properties

Static detection is a single recursive tree walk — no code execution required.

> **Status: Implemented.** `isDynamic()` in `shared.js` performs complete recursive analysis.

### 2.2 Text Node Children

Bare strings and numbers in `children` arrays compile to text nodes in all three output tiers. All three compilation targets (`compile-element.js`, `compile-static.js`, `compile-client.js`) handle `typeof def === "string"` children. Template strings (`"${...}"`) in text node children are reactive in the client tier.

---

## 3. Output Tiers

| Component surface                        | Compiler output                                 |
| ---------------------------------------- | ----------------------------------------------- |
| Fully static subtree                     | Plain HTML, zero JS                             |
| Naked value with `${}` in document       | HTML + `effect()` only                          |
| Template string signal                   | HTML + `computed()` + `effect()`                |
| `$prototype: "Function"`                 | HTML + function + handler wiring                |
| External class with `timing: "compiler"` | HTML with baked response data                   |
| External class with `timing: "client"`   | HTML + runtime hydration                        |
| Server function (`timing: "server"`)     | HTML + client fetch + generated server handler  |
| Custom element (hyphenated `tagName`)    | `class extends HTMLElement` + lit-html template |
| Pure type definition (`$defs`)           | No output                                       |

---

## 4. Custom Element Compilation

### 4.1 Output Structure

For each custom element, the compiler emits a self-contained ES module:

1. Imports for `@vue/reactivity` and `lit-html`
2. Imports for `$elements` dependencies (sub-component registrations)
3. Imports for Function-def `$src` sidecars — in site builds, bundleable
   specifiers (`npm:…`, `./relative`) are rewritten to their `/assets/`
   bundle URL (spec.md §5.3 "Compiled-site delivery")
4. `class extends HTMLElement` with reactive state and lit-html template
5. Static CSS extracted to a `<style>` block
6. `customElements.define()` registration call

Lifecycle conformance (spec.md §16.4): `connectedCallback` invokes
`state.onMount(state)` on a microtask after the first render, and
`disconnectedCallback` invokes `state.onUnmount(state)` — the same contract as
the runtime's interpreted elements.

### 4.2 Example

**Input** (`user-card.json`):

```json
{
  "tagName": "user-card",
  "state": {
    "username": "Guest",
    "status": "online",
    "displayStatus": "${state.status === 'online' ? 'Available' : 'Away'}",
    "setAway": {
      "$prototype": "Function",
      "body": "state.status = 'away'"
    }
  },
  "style": { "display": "block", "padding": "1em" },
  "children": [
    { "tagName": "h3", "textContent": "${state.username}" },
    {
      "tagName": "button",
      "textContent": "Set Away",
      "onclick": { "$ref": "#/state/setAway" }
    }
  ]
}
```

**Output** (`user-card.js`):

```js
import { reactive, computed, effect } from "@vue/reactivity";
import { render, html } from "lit-html";

class UserCard extends HTMLElement {
  #dispose = null;

  constructor() {
    super();
    this.state = reactive({
      username: "Guest",
      status: "online",
    });
    this.state.displayStatus = computed(() =>
      this.state.status === "online" ? "Available" : "Away",
    );
    this.state.setAway = (state) => {
      state.status = "away";
    };
  }

  template() {
    const s = this.state;
    return html`
      <h3>${s.username}</h3>
      <button @click="${() => s.setAway(s)}">Set Away</button>
    `;
  }

  connectedCallback() {
    for (const key of Object.keys(this.state)) {
      if (key in this && this[key] !== undefined) {
        this.state[key] = this[key];
      }
    }
    this.#dispose = effect(() => render(this.template(), this));
  }

  disconnectedCallback() {
    if (this.#dispose) {
      this.#dispose();
      this.#dispose = null;
    }
  }
}

customElements.define("user-card", UserCard);
```

### 4.3 lit-html Binding Syntax

| Jx                                         | lit-html                    | What it does               |
| ------------------------------------------ | --------------------------- | -------------------------- |
| `"textContent": "${state.name}"`           | `${s.name}`                 | Reactive text              |
| `"onclick": { "$ref": "#/state/fn" }`      | `@click="${() => s.fn(s)}"` | Event listener             |
| `"$props": { "items": { "$ref": "..." } }` | `.items="${s.items}"`       | JS property (by reference) |
| `"hidden": "${state.loading}"`             | `?hidden="${s.loading}"`    | Boolean attribute          |
| `"className": "${state.cls}"`              | `class="${s.cls}"`          | Attribute binding          |
| `"style": { "color": "${state.c}" }`       | `style="color: ${s.c}"`     | Inline style               |

The `.property` syntax is the key enabler for the property-first interface.

### 4.4 Property Bridge

`connectedCallback` merges JS properties set before connection into reactive state:

```js
connectedCallback() {
  for (const key of Object.keys(this.state)) {
    if (key in this && this[key] !== undefined) {
      this.state[key] = this[key];
    }
  }
  this.#dispose = effect(() => render(this.template(), this));
}
```

### 4.5 Nested CSS

```json
{ "style": { "display": "block", ":hover": { "backgroundColor": "#f0f0f0" } } }
```

Emits:

```css
user-card {
  display: block;
}
user-card:hover {
  background-color: #f0f0f0;
}
```

### 4.6 `$elements` Dependencies

```js
import "./variant-card.js";
import "./variant-attribute.js";
```

Registered before the parent's `customElements.define()`.

### 4.7 Mapped Array Compilation

```js
template() {
  const s = this.state;
  return html`
    ${s.options.map((item, index) => html`
      <button-selector-choice .option="${item}"></button-selector-choice>
    `)}
  `;
}
```

### 4.8 `$switch` Compilation

```js
${s.currentRoute === 'home' ? html`<div>Home page</div>` : ''}
${s.currentRoute === 'about' ? html`<div>About page</div>` : ''}
```

> **Status: Implemented.** `compile-element.js` produces complete lit-html custom element modules.

---

## 5. `.class.json` Compilation

### 5.1 Overview

`.class.json` files are JSON Schema 2020-12 documents that define class structures. The compiler transforms them into standard ES class modules.

### 5.2 Document Format

```json
{
  "$schema": "https://jxsuite.com/schema/v1/class",
  "$id": "MarkdownCollection",
  "description": "Globs and parses markdown files into a collection",
  "$defs": {
    "parameters": {
      "src": {
        "type": "string",
        "description": "Glob pattern for markdown files"
      },
      "sortBy": { "type": "string", "default": "date" },
      "sortOrder": {
        "type": "string",
        "default": "desc",
        "enum": ["asc", "desc"]
      },
      "limit": { "type": "integer" }
    },
    "fields": {
      "files": { "type": "array", "items": { "$ref": "#/$defs/fields/file" } },
      "resolved": { "type": "boolean", "default": false }
    },
    "constructor": {
      "body": "Object.assign(this, config)"
    },
    "methods": {
      "resolve": {
        "async": true,
        "body": "..."
      }
    }
  },
  "$implementation": "./md.js"
}
```

### 5.3 `$defs` Object Categories

| Category      | Purpose                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `parameters`  | Constructor parameter properties (config object fields)                 |
| `fields`      | Instance fields (private if `#`-prefixed)                               |
| `constructor` | Constructor body and super args                                         |
| `methods`     | Instance methods and accessors (`get`/`set` prefix or `accessor: true`) |
| `returnTypes` | Named return type schemas for tooling                                   |

### 5.4 The `$implementation` Key

Links the schema to its JavaScript implementation:

```json
"$implementation": "./md.js"
```

When present, the runtime/server follows this reference to import the actual class. When absent, the compiler generates an ES class from the schema.

### 5.5 Compilation Output

The compiler emits:

- Private fields (`#name`)
- Static fields and methods
- Constructor with `super()` support
- Getters/setters (accessor methods)
- Async method detection
- `extends` clause from `$ref` or string

### 5.6 Detection and Routing

A file is a `.class.json` document when:

- File extension is `.class.json`, OR
- Root object has `$defs` with `constructor` or `methods` or `fields`, AND no `tagName`

> **Status: Implemented.** `compile-class.js` handles full `.class.json` → ES class compilation.

---

## 6. Server Compilation

### 6.1 `timing: "server"` Entries

For each `timing: "server"` entry, the compiler emits two artifacts:

1. **Client-side:** A `POST /_jx/server/$export` fetch call that stores the JSON response in a signal. If any `arguments` value is reactive, the fetch is wrapped in an effect.
2. **Server-side:** A Hono handler file that imports the `$export` from `$src` and exposes it at `/_jx/server/$export`.

### 6.2 Per-Route Server Handler (`compileServer`)

Generates a standalone Hono app for a single document's server entries. Used when no `build.adapter` is set:

```js
import { Hono } from "hono";
import { fetchMetrics } from "./dashboard.server";

const app = new Hono();

app.post("/_jx/server/fetchMetrics", async (c) => {
  const args = await c.req.json().catch(() => ({}));
  try {
    return c.json(await fetchMetrics(args, c.env));
  } catch (e) {
    return c.json({ ok: false, error: e?.message ?? "Server error" }, 500);
  }
});

export default app;
```

### 6.3 Site-Wide Server Bundling (`compileSiteServer`)

When `build.adapter` is set in `project.json`, the site build collects all `timing: "server"` entries across every component and page, deduplicates by export name, and emits a single Hono worker via `compileSiteServer()` — `dist/worker.js`, or `dist/_worker.js` ([Pages advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)) plus a `dist/_routes.json` limiting invocation to `/_jx/*` for `"cloudflare-pages"`. Per-route `_server.js` files are not generated in this mode. A `"cloudflare-pages"` site with zero server entries emits no worker at all.

The function signature for server entries is `(args, env)` — the second parameter receives the platform's environment bindings (e.g., Cloudflare `env` with KV, D1, email, etc.). Old functions that accept only `(args)` are unaffected since the extra parameter is ignored.

```js
compileSiteServer(entries, { adapter, baseUrl });
```

| Parameter | Type                       | Default         | Description                                       |
| --------- | -------------------------- | --------------- | ------------------------------------------------- |
| `entries` | `Array<{exportName, src}>` | —               | Pre-collected server entries from all components  |
| `adapter` | `string \| null`           | `null`          | Deployment adapter; adds platform-specific output |
| `baseUrl` | `string`                   | `"/_jx/server"` | Base path prefix for all server endpoints         |

Adapter-specific behavior:

| Adapter                                      | Extra Output                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `"cloudflare-workers"`, `"cloudflare-pages"` | `app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))` fallback for static assets |
| `"node"`, `"bun"`, `null`                    | No extra output                                                                 |

Example generated worker for a Cloudflare adapter:

```js
// Generated by @jxsuite/compiler — do not edit manually
import { Hono } from "hono";
import { sendContactEmail } from "./components/contact.server";

const app = new Hono();

app.post("/_jx/server/sendContactEmail", async (c) => {
  const args = await c.req.json().catch(() => ({}));
  try {
    return c.json(await sendContactEmail(args, c.env));
  } catch (e) {
    return c.json({ ok: false, error: e?.message ?? "Server error" }, 500);
  }
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
```

> **Status: Implemented.** `compile-server.js` exports `compileServer` (per-route) and `compileSiteServer` (site-wide). `site-build` orchestrates entry collection and worker generation when `build.adapter` is set. Server source files are copied into `dist/components/` so the worker's relative imports resolve.

---

## 7. Image Optimization

The compiler includes a build-time image optimization pipeline that generates responsive variants, converts formats, and injects performance attributes into `<img>` nodes. The pipeline is implemented across three modules:

- `image-optimizer.js` — variant generation via Sharp
- `image-transform.js` — document tree mutation
- `image-cache.js` — persistent cache for skipping redundant re-encoding

### 7.1 Configuration

Image optimization is configured via `project.json` under the `images` key. All properties have defaults and are optional:

```json
{
  "images": {
    "optimize": true,
    "widths": [320, 640, 960, 1280, 1920],
    "formats": ["webp", "avif"],
    "quality": { "webp": 80, "avif": 65, "jpeg": 80, "png": 80 },
    "sizes": "(max-width: 768px) 100vw, 50vw",
    "lazyLoad": true
  }
}
```

| Property        | Type       | Default                                     | Description                                                                              |
| --------------- | ---------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `optimize`      | `boolean`  | `true`                                      | Master switch for all image processing                                                   |
| `widths`        | `number[]` | `[320, 640, 960, 1280, 1920]`               | Pixel widths for responsive `srcset` variants                                            |
| `formats`       | `string[]` | `["webp", "avif"]`                          | Output formats (also supports `"jpeg"`, `"png"`)                                         |
| `quality`       | `object`   | `{ webp: 80, avif: 65, jpeg: 80, png: 80 }` | Per-format compression quality (0–100)                                                   |
| `sizes`         | `string`   | `"(max-width: 768px) 100vw, 50vw"`          | Default CSS `sizes` attribute for responsive layout hints                                |
| `lazyLoad`      | `boolean`  | `true`                                      | Adds `loading="lazy"` and `decoding="async"` to `<img>` tags                             |
| `service`       | `string`   | `"build"`                                   | `"build"` = Sharp at build time; `"cloudflare"` = `/cdn-cgi/image` transform URLs (§7.6) |
| `remoteDomains` | `string[]` | `[]`                                        | Allowlisted https hostnames optimized via transform URLs (`service: "cloudflare"` only)  |

### 7.2 Document Transformation (`transformImageNodes`)

During page compilation, `transformImageNodes()` walks the document tree and mutates eligible `<img>` nodes. For each image:

1. **Process** — `processImage()` reads the source via Sharp, filters `widths` to ≤ the original width (always including the original), and generates one variant per width × format combination. Variants are written to `dist/images/_optimized/{stem}-{width}-{hash}.{format}`.
2. **Inject attributes** — The `<img>` node is mutated in-place:
   - `srcset` — responsive variant list with widths (e.g., `hero-320-a1b2.avif 320w, hero-640-a1b2.avif 640w`)
   - `sizes` — from config, unless the node already has one
   - `width` and `height` — original image dimensions (prevents CLS)
   - `loading="lazy"` and `decoding="async"` — when `lazyLoad: true`, unless `loading="eager"` is already set

Up to 4 variants are processed concurrently per image.

### 7.3 Eligibility

**Processed:**

- Static `src` paths (strings, not `${...}` template expressions)
- Local paths (relative or `/`-prefixed) that exist on disk (resolved from `public/` or project root)
- Raster formats: `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`, `.tiff`

**Skipped:**

- External URLs (`http://`, `https://`, `//`, `data:`)
- SVGs (`.svg`) and animated GIFs (`.gif`)
- Dynamic `src` containing `${...}` template expressions
- Images with `data-no-optimize` attribute

### 7.4 Per-Image Overrides

Individual `<img>` nodes can override global settings via attributes:

```json
{
  "tagName": "img",
  "attributes": {
    "src": "/images/hero.jpg",
    "sizes": "(max-width: 640px) 80vw, 40vw",
    "loading": "eager",
    "data-no-optimize": true
  }
}
```

- `sizes` — overrides the global config value for this image
- `loading="eager"` — prevents `loading="lazy"` injection (for above-the-fold images)
- `data-no-optimize` — skips optimization entirely

### 7.5 Caching (`image-cache.js`)

Processed images are cached to `.cache/images/manifest.json` to avoid redundant re-encoding across builds.

- **Cache key:** `{contentHash}:{configHash}` — MD5 of source file contents + MD5 of optimization config (`widths`, `formats`, `quality`)
- **Invalidation:** Source file changes, config changes, or missing variant files in `dist/`
- **Persistence:** Cache survives `dist/` cleanup — only variant files are regenerated
- **Pruning:** After an error-free build, entries whose key was never resolved during the build are removed at save time and their variant files deleted (a file shared with a surviving entry is kept), so a persisted cache — and the `dist/` copy made from it — stays bounded to images in use

### 7.6 Cloudflare Images Service

When `images.service` is `"cloudflare"`, the Sharp variant pipeline is skipped entirely. Image optimization becomes pure markup — no code is generated or deployed:

- `transformImageNodes()` rewrites eligible `<img>` srcsets to Cloudflare [transform-via-URL](https://developers.cloudflare.com/images/transform-images/transform-via-url/) entries, one per configured width ≤ the original width:
  `/cdn-cgi/image/width=<w>,quality=<q>,fit=scale-down,format=auto/<src>?v=<contentHash8>`
  `format=auto` lets Cloudflare negotiate AVIF/WebP per browser; `quality` is the config's `quality.webp` value. The original `src` is preserved as fallback. Sharp is used only for a header-only dimension read (memoized per build).
- Remote https sources from `images.remoteDomains` hostnames get the same treatment with the full URL as the transform source — every configured width is emitted (dimensions unknown; `fit=scale-down` prevents upscaling) and no `v` hash is appended.
- These URLs are served by Cloudflare's zone-level Image Transformations feature, which must be enabled in the dashboard; they do not resolve on `*.pages.dev` / `*.workers.dev` preview hosts. The build prints a reminder.

### 7.7 Build Integration

In `site-build`, the pipeline integrates at step 6 (per-route compilation):

1. Cache loaded if `projectConfig.images.optimize === true` and `images.service` is `"build"`; in `"cloudflare"` mode a per-build dimension memo is used instead
2. For each page, `transformImageNodes()` is called with the cache (or memo), config, project root, and output directory
3. Cache saved to disk after all routes are compiled (`"build"` mode only); stale entries are pruned first when every route compiled without errors

> **Status: Implemented.** `image-optimizer.js`, `image-transform.js`, `image-cache.js`, and `compile-image-endpoint.js` provide the full pipeline. Requires Sharp as a project dependency.

---

## 8. Static Page Compilation

### 8.1 Fully Static Output

When `isDynamic()` returns false for an entire document, the compiler emits plain HTML/CSS with zero JavaScript.

### 8.2 CSS Extraction

All static `style` definitions are extracted into a single `<style>` block in `<head>`.

> **Status: Implemented.** `compile-static.js` handles zero-JS output.

---

## 9. Dynamic Page Compilation

### 9.1 Pre-rendered HTML + Reactive JS

For dynamic documents that are not custom elements, the compiler emits:

- Pre-rendered HTML from static portions
- `@vue/reactivity` bootstrapper for dynamic state
- `effect()` bindings for reactive properties

> **Status: Implemented.** `compile-client.js` handles dynamic page compilation.

---

## 10. Pending Features

| Feature                              | Description                                                       | Status                                                                           |
| ------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `timing: "compiler"`                 | Bake fetch responses into HTML at build time                      | **Pending**                                                                      |
| Island serialization                 | `<script type="application/Jx+json">` hydration islands           | **Pending**                                                                      |
| Bundle manifest                      | Exact dependency manifest from JSON analysis                      | **Partial** (imports collected but no standalone manifest file)                  |
| Multi-page build                     | Orchestrate compilation across all pages in a site project        | **Pending**                                                                      |
| Layout resolution                    | Resolve `$layout` and `<slot>` insertion during compilation       | **Implemented** via `site-build`                                                 |
| `$head` merge                        | Merge site + layout + page `<head>` entries with deduplication    | **Implemented** via `head-merger.js`                                             |
| `$paths` expansion                   | Generate one page per content entry for dynamic routes            | **Implemented** via `pages-discovery.js`                                         |
| `ContentCollection` / `ContentEntry` | New `$prototype` values for querying content at build time        | **Implemented** via `content-loader.js`                                          |
| Sitemap generation                   | Auto-generate `sitemap.xml` from route table                      | **Pending**                                                                      |
| Image optimization                   | Format conversion, responsive sizes, lazy loading, caching        | **Implemented** via `image-optimizer.js`, `image-transform.js`, `image-cache.js` |
| Site-wide server bundling            | `build.adapter` collects all server entries into `dist/worker.js` | **Implemented** — Cloudflare adapter with asset fallback                         |
| Platform-specific files              | Emit `_redirects` (Netlify), `vercel.json`, etc.                  | **Pending** (redirects partially via `generateRedirects`)                        |

See the [Site Architecture Specification](site-architecture.md) for the full multi-page compilation and routing design.

---

## 11. Shared Utilities

### `isDynamic(def)` — Recursive static detection

### `isSchemaOnly(def)` — Shape 2b detection (pure type definitions)

### `buildInitialScope(state)` — Static scope for compile-time pre-rendering

### `compileStyles(def)` — CSS extraction from component tree

Project-level emission order is: base `:root` (custom properties) and `body` (direct
properties) rules first, then conditional `@`-blocks, so equal-specificity overrides win by
source order. Inside a project-level `@`-block, custom properties land on `:root`, direct
properties on `body`, and selector-keyed sub-objects on their own selector. Blocks keyed by a
pure `prefers-color-scheme` query dual-emit per the forced-scheme contract (spec §9.5): a
media-guarded copy (`:where(:root:not([data-color-scheme]))`) plus an unconditional forced
copy (`:root:where([data-color-scheme="…"])`), both specificity-neutral via `:where()`.
When any `$media` value is a pure scheme query, `compileStyles` also emits the `color-scheme`
declaration triplet on `:root` (suppressed when the author sets `colorScheme` in project
style), and the compilation targets inject the pre-paint scheme-restore `<script>`
(`colorSchemePrePaintScript()`) into `<head>` ahead of all style blocks — the site pipeline
does this via the merged head (`prePaintScheme: false` disables the target-level copy).

### `collectServerEntries(doc)` — Find all `timing: "server"` entries

### `buildRoute(exportName, baseUrl)` — Emit a single Hono POST route with try/catch and `c.env` passing

### `transformImageNodes(doc, cache, config, projectRoot, outDir)` — Walk document tree, optimize eligible `<img>` nodes, inject `srcset`/`sizes`/`width`/`height`/`loading`

### `processImage(srcPath, config, outDir)` — Generate responsive variants for a single image via Sharp

> **Status: Implemented.** Shared utilities in `shared.js`; image pipeline in `image-optimizer.js`, `image-transform.js`, `image-cache.js`.

---

## 12. Sidecar Bundling

The site build bundles Function-def `$src` modules for the browser
(`packages/compiler/src/site/bundler.ts`; behavior contract in spec.md §5.3
"Compiled-site delivery"):

- **Collection**: during page/component/island emission, every bundleable
  `$src` specifier (`npm:<pkg>[/subpath]`, `./relative` — `.ts` allowed) is
  rewritten to its deterministic `/assets/<slug>.js` URL and registered;
  lowered defs contribute additional specifiers via `$bundle`
  (extensions.md §8.3). Relative specifiers resolve against their declaring
  document's directory and key on the project-relative resolved path; two
  distinct entries colliding on one slug is a build error. Non-Function
  `$src` (`.class.json` descriptors) and absolute/URL specifiers are never
  touched.
- **Bundling** runs once after routes, components, and the worker are
  generated: one self-contained ESM bundle per unique specifier, with
  `@vue/reactivity` and `lit-html` left external (the page importmap provides
  them). `timing: "compiler"` code is never bundled.
- **The server target**: when `build.adapter` is set, the generated worker
  entry (§6) is bundled self-contained through the same backend —
  `workerBundleOptions(adapter)` maps cloudflare adapters to
  `workerd`/`worker` resolution conditions with `cloudflare:*`/`node:*`
  external (nodejs_compat provides builtins), and node/bun to platform-native
  bundling. Extension mounts, connectors, hono, and user server modules are
  inlined, so `dist/` deploys and runs without `node_modules` — verified by
  importing the bundled worker from an empty directory in tests. The former
  copy of server sources into `dist/components/` is gone.
- **Backends**: `Bun.build` when the build runs under Bun; esbuild
  (dynamically imported, a `@jxsuite/compiler` dependency) under plain Node.
  Options are minimal and identical (`format: esm`, browser target, no
  minify). `JX_BUNDLER=esbuild` forces the fallback. Byte-level output may
  differ between backends — a repo tracking `dist/` should build with one
  backend consistently.

> **Status: Implemented** via `site-build` steps 6d (bundling) and 6e
> (extension `emit`, extensions.md §8.4).

---

## Appendix A — Production Dependency Stack

| Package           | Size (gzip) | Purpose                                |
| ----------------- | ----------- | -------------------------------------- |
| `@vue/reactivity` | ~7 kB       | `reactive()`, `computed()`, `effect()` |
| `lit-html`        | ~3 kB       | `html`, `render()`                     |
| **Total**         | **~10 kB**  |                                        |

## Changelog

- **2.0.0-draft** (2026-07-22) — Baseline: spec versioning + changelog introduced.

---

_`@jxsuite/compiler` Specification v2.0.0-draft_
