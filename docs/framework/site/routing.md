---
title: "Routing"
description: "File-based routing in Jx sites: static routes, [param] dynamic routes, [...path] catch-alls, $paths expansion, priority, and route params at runtime."
spec:
  - site-architecture.md#4
code:
  - packages/compiler/src/site/pages-discovery.ts
---

# Routing

Every file in the `pages/` directory automatically becomes a route — there is no routing configuration. `.json` pages are native; other extensions become routable when an enabled extension claims them, which is how jxsuite.com serves `pages/index.md` as its front page (see [Jx Markdown](/docs/framework/site/jx-markdown)).

## Static routes

The file path determines the URL path:

| File                         | URL                |
| ---------------------------- | ------------------ |
| `pages/index.json`           | `/`                |
| `pages/about.json`           | `/about`           |
| `pages/about/index.json`     | `/about`           |
| `pages/blog/index.json`      | `/blog`            |
| `pages/blog/first-post.json` | `/blog/first-post` |

`index` files map to their parent directory, so `pages/about.json` and `pages/about/index.json` produce the same URL — use whichever keeps the folder tidy, but not both.

Files and directories whose names start with `_` are excluded from routing entirely. That's the convention for co-locating components next to the pages that use them: `pages/blog/_blog-card.json` is available for `$ref` but never becomes `/blog/_blog-card`.

## Dynamic routes

Bracket syntax in filenames creates parameterized routes:

| File                         | URL pattern      | Example match               |
| ---------------------------- | ---------------- | --------------------------- |
| `pages/blog/[slug].json`     | `/blog/:slug`    | `/blog/hello-world`         |
| `pages/[category]/[id].json` | `/:category/:id` | `/products/42`              |
| `pages/docs/[...path].json`  | `/docs/*`        | `/docs/api/runtime/install` |

`[param]` matches exactly one path segment. `[...param]` is a catch-all: it matches the whole remaining path, slashes included — one catch-all page can serve an entire subtree.

## Generating pages with $paths

A static build has to know every URL in advance, so a dynamic page declares which paths it generates with a top-level `$paths`. The most common shape drives the route from a [content collection](/docs/framework/site/content-collections) — this is (abbreviated) how the docs page you are reading is generated, from `pages/docs/[...slug].json`:

```json
{
  "$layout": "./layouts/docs.json",
  "$paths": { "contentType": "docs", "param": "slug" },
  "state": {
    "page": {
      "$prototype": "ContentEntry",
      "contentType": "docs",
      "id": { "$ref": "#/$params/slug" }
    }
  },
  "children": [{ "tagName": "article", "children": "${state.page.$children ?? []}" }]
}
```

The compiler iterates `$paths` at build time and emits one HTML page per entry, substituting each entry's value into the route pattern. A dynamic page without `$paths` generates nothing (the build warns and skips it).

`$paths` takes three shapes:

```json
{ "contentType": "blog", "param": "slug", "field": "id" }
```

One page per collection entry. `param` names the route parameter (default `slug`); `field` picks which entry field supplies the value (default `id`, the entry id).

```json
{ "values": ["en", "fr", "de"], "param": "lang" }
```

An explicit list of values.

```json
{ "$ref": "./data/products.json", "param": "id", "field": "sku" }
```

A JSON array file, one page per item, with `field` selecting the property to use.

For catch-all routes the parameter value may itself contain slashes: nested content entries get path-based ids (like `framework/site/routing`), so a single `[...slug]` page fans out into the whole tree of URLs.

:::doc-tip
Your project's generated `document.schema.json` validates `$paths` against exactly these shapes plus any your extensions contribute, so a misspelled key or a source belonging to an extension you have not enabled is flagged in the editor and by `jx validate` — rather than building zero pages and warning at the end of the log. Run [`jx schema`](/docs/framework/build/cli) after changing `extensions` to keep that set current.
:::

## Route priority

When several routes could match the same URL, the more specific one wins:

1. Static routes beat dynamic routes — `/about` beats `/[slug]`.
2. Named parameters beat catch-alls — `/blog/[slug]` beats `/blog/[...path]`.
3. More specific paths beat less specific ones — `/blog/[slug]` beats `/[...path]`.

## Params at runtime

Inside a dynamic page, the current route's parameters are addressable as `#/$params/<name>`. The usual pattern binds a parameter into a `ContentEntry` id, as in the example above:

```json
{ "id": { "$ref": "#/$params/slug" } }
```

Each generated page resolves the reference to its own concrete value — `/blog/hello-world` sees `slug` as `"hello-world"`. The compiler also injects a read-only `$page` state entry carrying `params`, `title`, and `url`, alongside the site-level `$site` context (see [project.json](/docs/framework/site/project-json)). In static builds all of this resolves at compile time; nothing route-related ships to the browser.

:::doc-tip
In Studio, opening a dynamic page shows a params picker on the context bar, under **resolving with**, so the canvas previews a real entry instead of a placeholder.
:::

## Related

- [Content collections](/docs/framework/site/content-collections) — the entries that drive `$paths`
- [Layouts](/docs/framework/site/layouts) — the shells dynamic pages render into
- [Deployment](/docs/framework/site/deployment) — how generated routes are served
