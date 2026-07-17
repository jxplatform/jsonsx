---
title: "How compilation works"
description: "What jx build does — route discovery, static detection, and the output tiers — and why most Jx pages ship zero JavaScript."
spec:
  - compiler.md#2 # compilation routes
  - compiler.md#2.1 # static detection (isDynamic)
  - compiler.md#3 # output tiers
  - compiler.md#8.2 # CSS extraction
  - compiler.md#9.1 # pre-rendered HTML + reactive JS
code:
  - packages/compiler/src/site/site-build.ts
  - packages/compiler/src/site/pages-discovery.ts
  - packages/compiler/src/targets/compile-static.ts
  - packages/compiler/src/targets/compile-client.ts
  - packages/compiler/src/shared.ts
---

# How compilation works

`jx build` turns a Jx project — JSON documents in `pages/`, `layouts/`, and `components/` — into a production site in `dist/`. The compiler erases the Jx abstractions at build time: no JSON documents, no interpreter, and no framework code ship to production. A page only gets JavaScript when the compiler can prove it needs some, and the proof runs in one direction — everything is static until something dynamic is found.

The only client-side dependencies a page can end up with are `@vue/reactivity` (~7 kB gzip) and `lit-html` (~3 kB gzip), loaded through an import map — and only on pages that need them.

## What `jx build` does

Running `jx build` (see [CLI commands](/docs/framework/build/cli)) orchestrates one pipeline:

1. **Load `project.json`** and register the extensions it declares (`extensions`), which contribute file formats such as Markdown pages.
2. **Discover routes** by scanning `pages/`: `pages/index.json` → `/`, `pages/about.json` → `/about`, `pages/blog/[slug].json` → `/blog/:slug`, `pages/docs/[...path].json` → catch-all. Files starting with `_` are not routed. `.json` pages are native; other extensions (like `.md`) route through a format registered by an enabled extension.
3. **Expand dynamic routes** — a `[param]` page's `$paths` definition produces one concrete route per entry.
4. **Compile each route**: resolve its layout, merge `$head` from site + layout + page, inject the read-only `$site`/`$page` context, resolve build-time data, transform images for responsive output, then hand the assembled document to the compiler.
5. **Emit `dist/`**: one `index.html` per route (with `build.trailingSlash: "always"`, the default), compiled component modules and CSS under `dist/components/`, `public/` copied verbatim, plus `sitemap.xml` (when `url` is set in `project.json`), `_redirects`, and — when `build.adapter` is set — a bundled server worker (`worker.js`, or `_worker.js` + `_routes.json` for Cloudflare Pages).

The build finishes with a summary (`Done: 12 routes → 34 files`) and exits non-zero if any route failed.

## Static detection

The routing decision is a single recursive tree walk — `isDynamic()` — that never executes your code. A document compiles to plain HTML unless the walk finds one of:

- a `state` entry that exists at runtime (a plain value, a `$prototype` entry, or anything with a `default`)
- a `${…}` template string in a property, style, or attribute value
- a `$ref` binding on an element property
- a `$switch` node
- a mapped array (`$prototype: "Array"`)
- any child that is itself dynamic

Three kinds of state are exempt because they are resolved during the build and then removed:

- the injected `$site` and `$page` context (read-only, never reactive)
- entries with `timing: "compiler"` — resolved at build time and baked into the HTML
- schema-only definitions (pure type information produces no output)

## What compiles away

Site and page context looks like state, but it is data the compiler already has. This heading:

```json
{
  "tagName": "h1",
  "textContent": "${state.$site.name} — ${state.$page.title}"
}
```

compiles to literal HTML with the template evaluated and gone:

```html
<h1>Acme Realty — About us</h1>
```

The same applies to `timing: "compiler"` data and to content collections: template strings over build-time values are evaluated against the resolved data, mapped arrays over resolved content are unrolled into repeated markup, and the now-spent state entries are stripped. What reaches `isDynamic()` afterwards is a plain tree — so a blog index that lists every post can still be a zero-JS page.

## The output tiers

### Fully static

When nothing dynamic survives the build-time resolution, the page is plain HTML with its CSS in the head — zero JavaScript, no import map, no module scripts. This is the default outcome, not an optimization you opt into.

### Islands in a static shell

A dynamic subtree inside an otherwise-static document doesn't drag the whole page into the client tier. The compiler cuts the subtree out, compiles it to a small custom-element module, and leaves a placeholder tag in the HTML:

```html
<jx-island-0></jx-island-0>
<script type="module" src="./_islands/jx-island-0.js"></script>
```

The module upgrades the element in place. Components you author with a hyphenated `tagName` (say `site-counter`) work the same way: the page HTML stays static, and `dist/components/site-counter.js` loads only on pages that use the element. The import map added to those pages resolves `@vue/reactivity` and `lit-html` for the island modules.

### Dynamic pages

When the page document itself is dynamic — it declares live `state`, binds `$ref`s, or uses runtime template strings — the compiler still pre-renders the full HTML, marks bound elements with `data-bind` attributes, and emits one small module that wires reactivity onto the existing DOM: reactive state, `computed()` for derived values, `effect()` per binding, and event handler hookup. There is no client-side re-render of the initial view; the JS only maintains what changes.

Two more outputs sit alongside these tiers: `.class.json` documents compile to ES class modules, and `timing: "server"` entries generate server handlers — a per-route `_server.js`, or a single site-wide worker when `build.adapter` is set.

## CSS extraction

Style never ships as JavaScript. During compilation, every static `style` definition — the project-level `style` from `project.json`, the layout's, the page's, and each node's — is extracted into a single `<style>` block in the page `<head>`, with `$media` breakpoint names expanded to real media queries. Components additionally emit a `dist/components/<tag>.css` sidecar, and styles found in component slot content are collected into the page's style block. See [Styling](/docs/framework/concepts/styling) for the authoring model.

## Why is my page shipping JavaScript?

Work the static-detection list backwards:

- **Live `state` on the page document** — even `{"count": 0}` — makes the page dynamic. If the data never changes after the build, move it to `timing: "compiler"` or reference `$site`/`$page` context instead.
- **A `${…}` template string** whose inputs exist only at runtime keeps its binding alive. Templates over build-time data compile away.
- **`$switch`, `$ref` bindings, and mapped arrays** over runtime state need the client tier; mapped arrays over build-resolved content do not.
- **Interactive components** cost their own module on the pages that use them — the rest of the page stays static.

## Related

- [CLI commands](/docs/framework/build/cli) — `jx build` flags and the rest of the CLI
- [The dev server](/docs/framework/build/dev-server) — the development-time counterpart
- [Site architecture](/docs/framework/site) — the directory layout the build consumes
- [Reactivity](/docs/framework/concepts/reactivity) — what the dynamic tier compiles from
- [Components](/docs/framework/concepts/components) — the component model behind islands
