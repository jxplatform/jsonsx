---
title: "How compilation works"
description: "What jx build does (route discovery, static detection, the output tiers) and why most Jx pages ship zero JavaScript."
spec:
  - compiler.md#2 # compilation routes
  - compiler.md#2.1 # static detection (isDynamic)
  - compiler.md#3 # output tiers
  - compiler.md#8.2 # CSS extraction
  - compiler.md#8.1 # fully static output, runtime-only reads left unresolved
  - compiler.md#9.1 # pre-rendered HTML + reactive JS
  - compiler.md#4.1 # element module output structure
code:
  - packages/compiler/src/site/site-build.ts
  - packages/compiler/src/site/client-runtime.ts
  - packages/compiler/src/site/bundler.ts
  - packages/compiler/src/site/pages-discovery.ts
  - packages/compiler/src/targets/compile-static.ts
  - packages/compiler/src/targets/compile-client.ts
  - packages/compiler/src/shared.ts
---

# How compilation works

`jx build` turns a Jx project (JSON documents in `pages/`, `layouts/`, and `components/`) into a production site in `dist/`. The compiler erases the Jx abstractions at build time: no JSON documents, no interpreter, and no framework code ship to production. A page only gets JavaScript when the compiler can prove it needs some, and the proof runs in one direction: everything is static until something dynamic is found.

The only client-side dependencies a page can end up with are `@vue/reactivity` (7.8 kB gzip) and `lit-html` (3.3 kB gzip), loaded through an import map, and only on pages that need them. Both are served from your own site, under `/assets/`.

## What `jx build` does

Running `jx build` (see [CLI commands](/docs/framework/build/cli)) orchestrates one pipeline:

1. **Load `project.json`** and register the extensions it declares (`extensions`), which contribute file formats such as Markdown pages.
2. **Discover routes** by scanning `pages/`: `pages/index.json` → `/`, `pages/about.json` → `/about`, `pages/blog/[slug].json` → `/blog/:slug`, `pages/docs/[...path].json` → catch-all. Files starting with `_` are not routed. `.json` pages are native; other extensions (like `.md`) route through a format registered by an enabled extension.
3. **Expand dynamic routes**: a `[param]` page's `$paths` definition produces one concrete route per entry.
4. **Compile each route**: resolve its layout, merge `$head` from site + layout + page, inject the read-only `$site`/`$page` context, resolve build-time data, transform images for responsive output, then hand the assembled document to the compiler.
5. **Emit `dist/`**: one `index.html` per route (with `build.trailingSlash: "always"`, the default), compiled component modules and CSS under `dist/components/`, `public/` copied verbatim, plus `sitemap.xml` (when `url` is set in `project.json`), `_redirects`, and a bundled server worker when `build.adapter` is set (`worker.js`, or `_worker.js` + `_routes.json` for Cloudflare Pages).

The build finishes with a summary (`Done: 12 routes → 34 files`) and exits non-zero if any route failed.

## Static detection

The routing decision is a single recursive tree walk (`isDynamic()`) that never executes your code. A document compiles to plain HTML unless the walk finds one of:

- a `state` entry that exists at runtime (a plain value, a `$prototype` entry, or anything with a `default`)
- a `${…}` template string in a property, style, or attribute value
- a `$ref` binding on an element property
- a `$switch` node
- a mapped array (`$prototype: "Array"`)
- any child that is itself dynamic

Three kinds of state are exempt because they are resolved during the build and then removed:

- the injected `$site` and `$page` context (read-only, never reactive)
- entries with `timing: "compiler"` (resolved at build time and baked into the HTML)
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

The same applies to `timing: "compiler"` data and to content collections: template strings over build-time values are evaluated against the resolved data, mapped arrays over resolved content are unrolled into repeated markup, and the now-spent state entries are stripped. What reaches `isDynamic()` afterwards is a plain tree, so a blog index that lists every post can still be a zero-JS page.

## The output tiers

### Fully static

When nothing dynamic survives the build-time resolution, the page is plain HTML with its CSS in the head: zero JavaScript, no import map, no module scripts. This is the default outcome, not an optimization you opt into.

### Islands in a static shell

A dynamic subtree inside an otherwise-static document doesn't drag the whole page into the client tier. The compiler cuts the subtree out, compiles it to a small custom-element module, and leaves a placeholder tag in the HTML:

```html
<jx-island-0></jx-island-0>
<script type="module" src="./_islands/jx-island-0.js"></script>
```

The module upgrades the element in place. Components you author with a hyphenated `tagName` (say `site-counter`) work the same way: the page HTML stays static, and `dist/components/site-counter.js` loads only on pages that use the element. The import map added to those pages resolves `@vue/reactivity` and `lit-html` for the island modules.

## Where the runtime comes from

Those two modules are bundled into your `dist/` at build time and the import map points at them:

```html
<script type="importmap">
  {
    "imports": {
      "@vue/reactivity": "/assets/vue-reactivity.js",
      "@vue/reactivity/": "/assets/@vue/reactivity/",
      "lit-html": "/assets/lit-html.js",
      "lit-html/": "/assets/lit-html/"
    }
  }
</script>
```

They come from `@jxsuite/compiler`'s own dependencies, not your project's, so you don't have to install anything. The runtime always matches the compiler that produced the page.

Which pages get a map is decided per page, and what the build writes is read back out of the pages it just wrote: every path any emitted map names is bundled into `dist/`, and a site whose pages are all static writes no `dist/assets/` at all. That direction matters, because the alternative is a build that promises a module it never produced: a page 404ing on its runtime and rendering blank while the build reports success, which passes every structural check there is.

The page also emits a `modulepreload` hint for each of them, and for each component module it loads:

```html
<link rel="modulepreload" href="/assets/vue-reactivity.js" />
<link rel="modulepreload" href="/components/site-counter.js" />
```

An import map says where a bare specifier lives; it does not ask for it. Without the hints the browser only discovers `/assets/vue-reactivity.js` after fetching **and parsing** a component module: three round trips deep on a slow connection, one after another. The hints name only what the page actually loads.

The trailing-slash entries cover package _subpaths_. A component or a `$src` sidecar rarely imports only `lit-html`. It imports `lit-html/directives/class-map.js` too, and an import map with only exact keys cannot resolve that. The build scans its own output for those imports, bundles each one it finds to `/assets/lit-html/…`, and repeats until nothing new turns up; which subpaths exist is a property of the third-party code your pages use, so the set is discovered rather than listed. Each one shares the single copy of the package core the exact key already points at, because two copies of lit on one page break in ways a size budget would not notice.

:::doc-note
They used to load from `https://esm.sh`. Self-hosting removes a third party from the load path of every interactive page, and it's what makes a `default-src 'self'` Content-Security-Policy possible at all. The old argument for a shared CDN was a shared browser cache, and that stopped being true when browsers began partitioning the HTTP cache by site.
:::

### Dynamic pages

When the page document itself is dynamic (it declares live `state`, binds `$ref`s, or uses runtime template strings), the compiler still pre-renders the full HTML, marks bound elements with `data-bind` attributes, and emits one small module that wires reactivity onto the existing DOM: reactive state, `computed()` for derived values, `effect()` per binding, and event handler hookup. There is no client-side re-render of the initial view; the JS only maintains what changes.

Two more outputs sit alongside these tiers: `.class.json` documents compile to ES class modules, and `timing: "server"` entries generate server handlers, either a per-route `_server.js` or a single site-wide worker when `build.adapter` is set.

Across all three tiers the emitter indents nested children so the generated HTML stays readable, except inside `pre`, `textarea`, and the rest of the tags browsers render with `white-space: pre`. There, and everywhere below them (`white-space` inherits), children are concatenated with no separator, because indentation between elements would be content rather than formatting. This is what keeps a syntax-highlighted code block, one `<span>` per token, rendering as the code you wrote.

## CSS extraction

Style never ships as JavaScript. During compilation, every static `style` definition (the project-level `style` from `project.json`, the layout's, the page's, and each node's) is extracted into a single `<style>` block in the page `<head>`, with `$media` breakpoint names expanded to real media queries. Styles found in component slot content are collected into the same block. See [Styling](/docs/framework/concepts/styling) for the authoring model.

**Component CSS is inlined into that block too**, after the page's own rules so the cascade is unchanged, and no `<link rel="stylesheet">` is emitted for it. A stylesheet link per component is a render-blocking request per component. jxsuite.com's home page had eleven of them, 22 kB in total, for sheets averaging 2 kB each: the whole of its critical request chain, spent on round trips rather than bytes.

The sidecars are still written to `dist/components/<tag>.css` for anything that references them directly, and a component in [shadow mode](/docs/framework/concepts/elements) is unaffected: its sheet is linked from inside the declarative shadow root, where it belongs.

:::doc-note
The trade is deliberate. Inlined CSS repeats on every page instead of caching across navigations. It is small, it compresses against the markup around it, and on a phone a round trip costs more than the bytes do.
:::

## What prerendering will and won't bake

Every page is prerendered: the compiler evaluates `${state.…}` against the build-time scope and writes the result into the HTML. That is what makes a page's content visible to crawlers and to readers with no JavaScript. But baking a template **replaces** it (the binding is gone, not stale), so the compiler bakes only what it can prove will never change:

- **A constant bakes.** `{"tagline": {"type": "string", "default": "Ship JSON"}}` read as `${state.tagline}` becomes text in the HTML, with no JavaScript behind it.
- **An entry a handler writes to stays bound.** If any handler in the document assigns to `state.saved` (`=`, `+=`, `++`, or an in-place `push`/`splice`/`sort`), every template reading it keeps its binding, even though the entry has a perfectly ordinary build-time value.
- **A computed over changing state stays bound.** A `$prototype: "Function"` whose body returns is evaluated at build time, so a computed is left unresolved too when it reads a written entry, a `$src` value, or a `Request`, however many steps removed.
- **An array a computed still reads stays in client state.** Expanding an array into a list at build time no longer drops it: if a computed or a template still reads `state.rows` at runtime, the array ships with the island. Mark it `timing: "compiler"` to say the data really is build-time only.

:::doc-note
One case the compiler cannot see: a handler loaded through `$src` lives in a JavaScript file the build does not open, so a state entry written **only** from there is still treated as a constant and baked. Declare a writer for it in the document if a binding over it goes dead.
:::

## Why is my page shipping JavaScript?

Work the static-detection list backwards:

- **Live `state` on the page document**, even `{"count": 0}`, makes the page dynamic. If the data never changes after the build, move it to `timing: "compiler"` or reference `$site`/`$page` context instead.
- **A `${…}` template string** whose inputs exist only at runtime keeps its binding alive. Templates over build-time data compile away.
- **`$switch`, `$ref` bindings, and mapped arrays** over runtime state need the client tier; mapped arrays over build-resolved content do not.
- **Interactive components** cost their own module on the pages that use them. The rest of the page stays static.

## Related

- [CLI commands](/docs/framework/build/cli): `jx build` flags and the rest of the CLI
- [The dev server](/docs/framework/build/dev-server): the development-time counterpart
- [Site architecture](/docs/framework/site): the directory layout the build consumes
- [Reactivity](/docs/framework/concepts/reactivity): what the dynamic tier compiles from
- [Components](/docs/framework/concepts/components): the component model behind islands
