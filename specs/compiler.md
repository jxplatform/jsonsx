# `@jxsuite/compiler` Specification

## Static HTML Compiler, Custom Element Emitter, and Island Detector

**Version:** 0.3.2-draft
**Status:** Partial
**Updated:** 2026-08-26
**License:** MIT

---

## 1. Overview

The Jx compiler transforms `.json` component files into optimized production artifacts. It erases all Jx abstractions at build time — no JSON, no runtime, and no Jx code ships to production. The compiler auto-detects the appropriate output target based on document analysis.

Pages are always prerendered at build time — there is no per-request page rendering — and interactive regions compile to custom elements that hydrate in place. Server output is gated on `build.adapter`: when it is set, every `timing: "server"` entry and every enabled extension server mount (authentication, data) is bundled into a single generated Hono worker serving `/_jx/*` alongside the static output (§6.3). With no adapter, no site worker is emitted at all: `timing: "server"` entries compile instead to a standalone per-page `_server.js` handler (§6.2). A mount has no such fallback, so a project with a non-empty `data` or `auth` section fails the build until an adapter is chosen (§6.3).

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

> **Status: Partial.** The tiers themselves are complete. One property of the emitted page is not:
> every tier emits an **inline** import map, and a project declaring a colour-scheme query also gets
> an inline pre-paint script, so no tier emits a Content-Security-Policy yet — though both inline
> blocks are now constants a hash can name. See §13. The page no longer loads anything from a third
> party: the import map resolves to `/assets/` (§12), and bare `$elements` and `$head` specifiers
> are bundled and copied there too (`site-architecture.md` §8.7).

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
   bundle URL (spec.md §5.3 "Compiled-site delivery"). The local binding is
   always the `state` key, so an entry whose `$export` names a different export
   is imported under an alias (`import { filterLeads as filtered }`)
4. `class extends HTMLElement` with reactive state and lit-html template
5. Static CSS extracted to a `<style>` block
6. `customElements.define()` registration call

Lifecycle conformance (spec.md §16.4): `connectedCallback` invokes
`state.onMount(state)` on a microtask after the first render, and
`disconnectedCallback` invokes `state.onUnmount(state)` — the same contract as
the runtime's interpreted elements.

`$prototype: "Request"` entries initialize to `null` and fetch from
`connectedCallback`, after the `$props`/property merge so a templated `url`
interpolates the values the parent passed in. Each fetch runs inside its own
`effect()`, so a reactive URL re-fetches when its inputs change; the runner joins the element's
effect registry and is stopped on `disconnectedCallback` (§4.4). A `manual` entry emits no fetch.
Handler parameters bind by name per spec.md §5.3 4d, and a bodyless `$src` entry
is emitted as a computed or a callable according to the same section's
classification rule.

The emitted module is named after the component's `tagName` — matching the
loader `<script>` and the CSS sidecar (site-architecture.md §12.4) — and
`$elements` import specifiers are derived from the dependency's tag for the same
reason.

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
import { reactive, computed, effect, stop } from "@vue/reactivity";
import { render, html } from "lit-html";

class UserCard extends HTMLElement {
  #effects = [];

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
    this.#effects.push(effect(() => render(this.template(), this)));
  }

  disconnectedCallback() {
    for (const _e of this.#effects) {
      stop(_e);
    }
    this.#effects.length = 0;
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

**Every row above lowers a `$ref` through the one tokenizer** (`@jxsuite/runtime/pointer`, spec.md §7.1), which decides each segment independently: a segment that is an ECMAScript identifier becomes `.name`, and any other segment becomes `["…"]`. So `#/state/user/name` is `s.user.name` while `#/state/items/0` is `s.items["0"]`. The same rule governs an emitted object-literal key, which is bare where it is an identifier and quoted where it is not.

The bracket branch is what makes the lowering total rather than a bet: a reference token may hold any character but `/` and `~` (RFC 6901 §3) and a state key is author data, so neither is guaranteed to be an identifier. This is a property of the emitted JavaScript only — `.` in generated member access says nothing about the pointer, where `/` is the sole separator.

Until 0.3.0 the compiler lowered a ref by replacing `/` with `.` and pasting the result, which emitted `s.items.0` — a syntax error — and `s.custom/path`, which parses as a division against an undeclared identifier. Neither failed the build: nothing between the string concatenation and the browser ever parsed the output. A target that emits JavaScript **must** produce source that parses for every ref the schema admits.

### 4.4 Property Bridge

`connectedCallback` takes props from three sources, in order — a `data-jx-props` payload, literal
`props.*` attributes, then JS properties set before connection — and registers the render effect:

```js
connectedCallback() {
  // …data-jx-props payload…
  const _pn = this.getAttributeNames().filter(n => n.startsWith('props.') && n.length > 6);
  for (const _n of _pn) {
    const _k = _n.slice(6);
    if (_k in this.state) {
      this.state[_k] = this.getAttribute(_n);
      this.removeAttribute(_n);
    }
  }
  for (const key of Object.keys(this.state)) {
    if (key in this && this[key] !== undefined) {
      this.state[key] = this[key];
    }
  }
  this.#effects.push(effect(() => render(this.template(), this)));
}
```

The `props.*` attribute form is how a JSON-authored instance and an island-rendered map body both
deliver props, and it mirrors the interpreted runtime; values are strings, and because HTML
lowercases attribute names a matching state key must be lowercase. A `$props` entry whose value is a
template string is emitted as a binding, not as quoted text.

**Effect teardown.** Every effect the element creates — render, dynamic host styles, Request
auto-fetch — is registered in one list and `stop()`ed in `disconnectedCallback`. Calling an
`@vue/reactivity` runner re-runs its effect rather than ending it, so teardown must use `stop()`.

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

The callback binds `item` and `index`, and — when the map's templates reference
it — `$map` as well, so the `${$map.item…}`/`${$map.index}` forms named in
spec.md §6.6 resolve against the same object the interpreter passes to its
template evaluator. Template rewriting applies throughout the map body, `id` and
`className` on descendants included.

A handler bound inside the map assigns that object to `state.$map` before
invoking, so bodies can read `state.$map.index`/`state.$map.item` per spec.md
§10.2. Handlers outside a map are emitted unchanged.

### 4.8 `$switch` Compilation

A `$switch` compiles to a case-keyed lookup over lit templates, matched on the discriminant's string
form (spec.md §14.1) with an empty template as the fallback:

```js
${{
  "home": html`<div>Home page</div>`,
  "about": html`<div>About page</div>`,
}[String(s.currentRoute)]}
```

**A shared subtree is hoisted, not repeated.** A branching construct — `$switch`, or a `tagName`
chosen at creation (spec.md §8.6) — writes one template per branch, so a subtree the authored
document names once was emitted once per branch into the bundle. Any subtree that would repeat is
lifted into a `const _cN = html`…`` declared inside `template()`, above the `return`, and the
branches reference it. The declaration is inside the method, not at module scope, so it is rebuilt
per render and reads the same state alias the template does. A map body gets its own declarations
inside its callback, because they close over that callback's `item`/`index`. Branches that emit
distinct subtrees are left inline, and a chosen `tagName` whose candidates disagree about being
preformatted is not hoisted, since `white-space` decides how the subtree itself is indented.

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

When `build.adapter` is set in `project.json`, the site build collects all `timing: "server"` entries across every component and page, deduplicates by export name, and emits a single Hono worker via `compileSiteServer()` — `dist/worker.js`, or `dist/_worker.js` ([Pages advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)) plus a `dist/_routes.json` limiting invocation to `/_jx/*` for `"cloudflare-pages"`. Per-route `_server.js` files are not generated in this mode. A `"cloudflare-pages"` site with no server entries **and** no active extension mounts emits no worker at all.

The function signature for server entries is `(args, env)` — the second parameter receives the platform's environment bindings (e.g., Cloudflare `env` with KV, D1, email, etc.). Old functions that accept only `(args)` are unaffected since the extra parameter is ignored.

```js
compileSiteServer(entries, { adapter, baseUrl, mounts, connectors });
```

| Parameter    | Type                                                   | Default         | Description                                                            |
| ------------ | ------------------------------------------------------ | --------------- | ---------------------------------------------------------------------- |
| `entries`    | `Array<{exportName, src}>`                             | —               | Pre-collected server entries from all components                       |
| `adapter`    | `string \| null`                                       | `null`          | Deployment adapter; adds platform-specific output                      |
| `baseUrl`    | `string`                                               | `"/_jx/server"` | Base path prefix for all server endpoints                              |
| `mounts`     | `Array<{className, module, basePath, order, options}>` | `[]`            | Extension server mounts to register (extensions.md §11)                |
| `connectors` | `Array<{provider, className, module}>`                 | `[]`            | Connector provider classes the mounts receive via `options.connectors` |

**Extension server mounts.** Classes carrying a `server` block ([extensions.md §11](./extensions.md)) — `@jxsuite/auth` at `/_jx/auth`, the connector data mount at `/_jx/data` — are emitted into the same worker: a static import per mount module and per connector provider class, one shared `ctx` object, `mount()` awaited at module init in ascending `order`, and `app.all()` wrappers for both `<basePath>/*` and the bare `<basePath>` registered **before** the `/_jx/server` routes and the asset fallthrough. Mount options are inlined as JSON — the project's section manifest, identifiers and env-var names only, never secret values (extensions.md §13). A mount is active when its class owns no project section, or when the project declares a non-empty value for its section key.

**Dynamic sections require a server-capable adapter.** A project with active extension mounts and no `build.adapter` fails the build with an error naming the offending sections: a static-only output cannot serve `/_jx/data` or `/_jx/auth`. Set `build.adapter` to `"cloudflare-workers"`, `"cloudflare-pages"`, `"node"`, or `"bun"`.

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
- Local paths (relative or `/`-prefixed) that exist on disk — resolved from an extension asset mount first ([extensions.md §8.5](./extensions.md)), then `public/` or the project root
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

**A boolean attribute is presence, not text.** An attribute whose value resolves to `false` is
omitted from the emitted HTML; one that resolves to `true` is emitted bare — `open`, never
`open="true"`. HTML reads a boolean attribute by presence alone, so stringifying the value inverted
it, and `<details open="false">` was an OPEN `<details>`. Absence has to be expressible at the
emitter because it cannot be expressed before it: a template that resolves to nothing falls back to
its own source text, which is what keeps an unresolvable binding alive for the client. A _string_
`"false"` is untouched — an enumerated attribute such as `aria-current` carries its value in the
text, and dropping it would be the same defect facing the other way.

**An empty expansion is not a collapse.** A repeater is expanded into static markup only when the
expansion actually produces nodes. When `items` resolves to an empty array at build time there is
nothing to prerender, so the repeater definition is kept for the client to bind — replacing it with
the empty expansion would discard the binding and the list could never populate. This holds for a
repeater in the whole-`children` position and for one among siblings. A repeater whose `items` cannot
be resolved at build time is likewise left in place, and a non-empty expansion still prerenders with
no JavaScript for the list.

**Runtime-only reads are left unresolved.** Prerender evaluates `${state.…}`
templates against the build-time scope, but a state entry whose value only exists
after hydration — a bodyless `$src` Function, a `$prototype: "Request"`, or a
template entry reading either — has no build-time value to substitute. Resolving
one anyway would replace the template in the emitted HTML with the placeholder's
text, destroying the client-side binding rather than merely getting it wrong, so
such a template is emitted unresolved for the client to populate. A read that
_calls_ the entry is unaffected: invoking a build-time callable, such as a named
formula (spec.md §19.4c), still evaluates during prerender.

**An entry a handler writes to is runtime-only.** A plain `{ "type": "string" }` entry holds a
perfectly ordinary build-time value, so nothing else distinguishes it from a constant — but if any
handler in the document assigns to it, baking `${state.x}` replaces the template and the element is
dead for the life of the page, not merely stale. Before the main pass the scope builder scans every
handler body in the document for writes to `state.x` — assignment (`=`, `+=`, `++`, …) and in-place
array mutation (`push`, `splice`, `sort`, …) alike — and marks each target runtime-only. A mutating
`$expression` contributes its `target` pointer the same way. The scan is narrow on purpose: an entry
nothing ever writes stays bakeable, so prerendered content survives for SEO.

**The mark is transitive, and order-independent.** A `$prototype: "Function"` whose body returns is
stored in the build scope as its already-evaluated _result_, so a template reading it sees an
ordinary value and would bake it. A computed that reads a runtime-only entry is therefore
runtime-only in turn, as is a template entry that reads one. The marks are propagated to a fixpoint
after the main pass, so declaration order does not decide the answer, and a computed over constants
alone still bakes.

> **Known limitation.** A `$src` handler's assignments live in a JS file the scope builder does not
> open, so an entry written only from there is still baked. Declaring the same entry's writer in the
> document, or reading the entry through a `Request`/`$src` value, restores the mark.

**An array is only stripped when nothing still reads it.** A build-time repeater expansion consumes
its `items`, after which the array would be dead weight in client state. But a map expansion is one
consumer, not the only one: the same array is routinely also read by a computed at runtime. An array
state entry is therefore dropped only when no surviving state definition and no surviving node in
the document still references it — as `${state.x}`, as a bare `state.x` in a handler or computed
body, or as a `#/state/x` pointer — iterated to a fixpoint, since rescuing one array can reveal a
read of another. An entry the author marked `timing: "compiler"` is exempt and is always stripped:
that declaration is the author saying the data is build-time only.

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

### 9.2 `$switch` on a Dynamic Page

A `$switch` node compiles to a render binding on its container element, mirroring the mapped-array
binding in the same target: the container carries `data-bind :render="_swN"`, and the module holds a
case-keyed lookup over lit templates matched on `String(discriminant)`, with an empty template as
the fallback. The discriminant may be a `#/state/…` pointer or a template string. An external `$ref`
case cannot be fetched at compile time and is skipped, exactly as in the static renderer.

The container is emitted **empty**, with the matched case supplied at hydration. lit's `render`
inserts into a container rather than replacing its existing children, so a prerendered branch would
survive alongside the rendered one — the same reason the mapped-array binding prerenders nothing.

> **Status: Implemented.** Previously `buildClientNode` had no `$switch` branch at all: the node
> fell through to the generic element path, which emitted a container and then looked for `children`
> to recurse into. `cases` is not `children`, so the subtree was never visited and the page compiled
> to an empty `<div>` with the content missing and no error — while the same node through the
> element target (§4.8) emitted every branch correctly.

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
- **The client runtime**: `@vue/reactivity` and `lit-html` are bundled from
  **this package's** dependencies into `/assets/vue-reactivity.js` and
  `/assets/lit-html.js`, and the emitted import map points there. They resolve
  from the compiler rather than the project because the compiler is what
  depends on those versions — a project that never installed them still gets
  the runtime its output was compiled against. If neither resolves, the map
  falls back to the CDN URLs with a warning, since a page with no runtime is
  worse than a page with a third-party one. Emitted once per build, and only
  when some page actually carries an import map.
- **Backends**: `Bun.build` when the build runs under Bun; esbuild
  (dynamically imported, a `@jxsuite/compiler` dependency) under plain Node.
  Options are minimal and identical (`format: esm`, browser target, no
  minify). Browser bundles define `process.env.NODE_ENV` as `"production"`:
  the substitution matters (a browser has no `process`) but the resolution
  matters more, because that value decides which `exports` condition a package
  offers. Bun reads it from the build's own `define` and assumes development
  without it, so the two backends were resolving different files —
  `lit-html`'s 31 kB development build under Bun against its 10 kB production
  build under esbuild. `JX_BUNDLER=esbuild` forces the fallback. Byte-level
  output may still differ between backends — a repo tracking `dist/` should
  build with one backend consistently.

> **Status: Implemented** via `site-build` steps 6d (bundling) and 6e
> (extension `emit`, extensions.md §8.4).

---

## 13. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). `lit-html` and `@vue/reactivity` are libraries rather than standards; Appendix A records them as dependencies.

| Standard                                                                                  | Class         | Binds  | Evidence                                                                                     | Note                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ------------- | ------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ECMA-262](https://ecma-international.org/publications-and-standards/standards/ecma-262/) | **Adopted**   | §4, §5 | packages/compiler/src/targets/compile-element.ts, packages/compiler/tests/no-eval.test.ts    | Emitted modules are plain ECMAScript modules containing no `new Function` and no `eval`, which is what lets compiled output run under a policy without `'unsafe-eval'` — asserted by a committed test.                                                                                                                                             |
| [WHATWG HTML](https://html.spec.whatwg.org/)                                              | **Subset**    | §3, §4 | packages/compiler/src/targets/compile-element.ts                                             | Custom elements are defined and rendered into the **light** DOM; `<slot>` is emulated by splicing saved children, and no shadow root is ever attached. Declarative Shadow DOM, `::part` and `ElementInternals` are therefore unavailable to a Jx component.                                                                                        |
| [CSP Level 3](https://www.w3.org/TR/CSP3/)                                                | **Subset**    | §3     | packages/compiler/tests/no-eval.test.ts, packages/compiler/src/site/csp.ts                   | What the tiers owe the policy: no `eval`, no `new Function`, and no `onclick=` attribute — handlers are bound as listeners — plus two inline blocks that are byte-identical across a build, so one hash each names them site-wide. The policy itself is assembled and emitted by the site build (`site-architecture.md` §14.3.1).                  |
| [Subresource Integrity](https://www.w3.org/TR/SRI/)                                       | **Divergent** | §12    | packages/compiler/src/site/client-runtime.ts, packages/compiler/tests/client-runtime.test.ts | The gap this standard existed to close is closed by **removal** rather than by attestation: the runtime is served from the site, so there is no cross-origin subresource left to hash. SRI would apply again only if a project overrode the import map back to a URL, and the build cannot compute an integrity value for a file it never fetched. |

## Appendix A — Production Dependency Stack

Served from the site under `/assets/` (§12), not from a CDN. Sizes are the bundles this build
actually emits — un-minified ESM, since `minify: false` — measured with `gzip -9`:

| Package           | Raw       | gzip        | Purpose                                |
| ----------------- | --------- | ----------- | -------------------------------------- |
| `@vue/reactivity` | 48.7 kB   | 11.1 kB     | `reactive()`, `computed()`, `effect()` |
| `lit-html`        | 10.6 kB   | 3.7 kB      | `html`, `render()`                     |
| **Total**         | **59 kB** | **14.8 kB** |                                        |

The previous figures here (~7 kB and ~3 kB, ~10 kB total) described neither of these files. They
are also the _un-minified_ sizes: the bundler does not minify, so a host that compresses on the fly
is doing the only size work in the pipeline.

## Changelog

- **0.3.2-draft** (2026-08-26) — Static output omits a false boolean attribute and emits a true one bare.
- **0.3.1-draft** (2026-08-18) — §4.3: separate the emitted-JavaScript accessor form from the pointer grammar it lowers.
- **0.3.0-draft** (2026-08-17) — §4.3: ref lowering goes through the shared tokenizer — identifier segments dot, all others bracket, so every emitted ref parses.
- **0.2.1-draft** (2026-08-15) — §3 Implemented — the tiers' inline blocks are hash-nameable and the site build emits the policy.
- **0.2.0-draft** (2026-08-15) — Client runtime is served from /assets/ instead of esm.sh; browser bundles resolve production export conditions under both backends (§3, §12).
- **0.1.28-draft** (2026-08-15) — §3: node_modules URLs resolved — bare $head/$elements specifiers land in /assets/.
- **0.1.27-draft** (2026-08-15) — Add §13 Standards Alignment; §3 marked Partial — inline scripts block a strict CSP and node_modules URLs 404 in production.
- **0.1.26-draft** (2026-08-14) — $switch compiles on dynamic pages (§9.2); branch subtrees hoisted out of $switch and chosen-tagName constructs (§4.8); prerender treats handler-written entries and computeds reading them as runtime-only, and keeps an array any surviving reader still references (§8.1).
- **0.1.25-draft** (2026-07-30) — Element modules: props.* attribute intake and $props template bindings, one effect registry stopped on disconnect, state.$map published for map handlers; prerender keeps a repeater whose build-time expansion is empty (§4.1, §4.2, §4.4, §4.7, §8.1).
- **0.1.24-draft** (2026-07-30) — Element modules: $export aliasing, Request auto-fetch on connect with effect teardown, $map bound in map callbacks, tagName-based output naming; prerender leaves runtime-only reads unresolved (§4.1, §4.7, §8.1).
- **0.1.23-draft** (2026-07-24) — §1 Overview: condition the generated Hono worker on build.adapter (per-page _server.js without one) and scope the static-build failure to active data/auth mounts; §6.3 document compileSiteServer's mounts/connectors parameters and extension mount emission.
- **0.1.22-draft** (2026-07-23) — Image src resolution consults extension asset mounts before public/ (§7.3).
- **0.1.21-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.20-draft** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.1.19-draft** (2026-07-17) — Forced color-scheme contract — dual emission, color-scheme triplet, pre-paint script (`e629684d`).
- **0.1.18-draft** (2026-07-17) — Bundle the site worker self-contained per adapter (`4096ba12`).
- **0.1.17-draft** (2026-07-17) — Sidecar bundling, extension emit capability, heading anchors (`07e28bc3`).
- **0.1.16-draft** (2026-07-17) — Image pruning for persistent site build cache + github ci cache (`b45096ed`).
- **0.1.15-draft** (2026-06-10) — Update site architecture to reflect new changes (`c0bdba08`).
- **0.1.14-draft** (2026-06-10) — Consolidate markdown and csv handling to the parser package (`8b1ba6da`).
- **0.1.13-draft** (2026-06-03) — Use `.cache` isntead of `.jx-cache` to support cloudflare build cache (`1103d2d6`).
- **0.1.12-draft** (2026-06-01) — Stronger typing (`fcbb5b5d`).
- **0.1.11-draft** (2026-06-01) — Convert to typescript (`e352e265`).
- **0.1.10-draft** (2026-05-20) — Run formatter (`8ba47930`).
- **0.1.9-draft** (2026-05-18) — Always emit worker.js for cloudflare (`3dd37c2d`).
- **0.1.8-draft** (2026-05-15) — Image optimization specs (`7d2ee67f`).
- **0.1.7-draft** (2026-05-15) — Provider-sepcific Site-Wide Bundling (`51cb5cf6`).
- **0.1.6-draft** (2026-04-23) — Rebrand to jxsuite (`2897a4e8`).
- **0.1.5-draft** (2026-04-22) — Consolidate project config schema and rename as such (`e3523dbf`).
- **0.1.4-draft** (2026-04-20) — Text nodes support (`4d45eeb7`).
- **0.1.3-draft** (2026-04-16) — Landing site + working exports + release-it + linting (`a8409b5f`).
- **0.1.2-draft** (2026-04-15) — Rebrand to Jx / Jx Platform (`abc63f2d`).
- **0.1.1-draft** (2026-04-10) — Finalize vision for site architecture (`da594993`).
- **0.1.0-draft** (2026-04-10) — Consolidate specs (`80ca313f`).

---

_`@jxsuite/compiler` Specification v0.3.2-draft_
