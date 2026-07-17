---
title: "SEO and metadata"
description: "Declare page metadata with $head, template it from state, and let the build merge heads and emit sitemap.xml and robots.txt."
spec:
  - site-architecture.md#8
code:
  - packages/compiler/src/site/head-merger.ts
  - packages/compiler/src/site/site-build.ts
---

# SEO and metadata

Every page's `<head>` is assembled declaratively at build time — no imperative code. Metadata comes from three places (`project.json`, the layout, the page), template strings pull values from state, and the build adds a sitemap and `robots.txt` on top.

## Page-level `$head`

A page declares metadata as an array of head elements under `$head`, and its title as a top-level `title` property:

```json
{
  "title": "My Blog Post — My Site",
  "$head": [
    {
      "tagName": "meta",
      "attributes": {
        "name": "description",
        "content": "A great blog post about things"
      }
    }
  ]
}
```

Each entry is `{ "tagName": ..., "attributes": ... }` — any head element works: `meta`, `link`, `script`, `style`. Use the `title` property rather than a `<title>` entry; the merge always writes the computed title last, so a literal `<title>` in `$head` is overridden.

## Templated metadata

`title` and `$head` attribute values support template strings, evaluated against the page's resolved state. Content-driven pages take their metadata straight from the content entry — no duplication. This is the docs page template on jxsuite.com:

```json
{
  "$paths": { "contentType": "docs", "param": "slug", "field": "id" },
  "title": "${state.page.data.title} — Jx Suite",
  "$head": [
    {
      "tagName": "meta",
      "attributes": {
        "name": "description",
        "content": "${state.page.data.description}"
      }
    }
  ]
}
```

The injected site and page context is available too: `${state.$site.name}`, `${state.$site.url}`, `${state.$page.url}`, and route params via `${state.$page.params.slug}`.

## Merge order

The build assembles each page's `<head>` from four layers, later entries winning:

1. **Built-in defaults** — `<meta charset>` and a standard viewport tag
2. **Site** — `$head` in `project.json` (favicon, fonts, global meta)
3. **Layout** — the layout document's `$head`
4. **Page** — the page's `$head`

Duplicates are detected by element identity, so a page-level entry replaces the site-level one rather than appearing twice:

| Element                     | Deduplication key       |
| --------------------------- | ----------------------- |
| `<title>`, `<meta charset>` | singleton               |
| `<meta name="...">`         | `name`                  |
| `<meta property="...">`     | `property` (Open Graph) |
| `<link rel="...">`          | `rel` + `href`          |
| `<script src="...">`        | `src`                   |

Two tags are added automatically: `<link rel="canonical">` (built from `url` in `project.json` plus the page route, when `url` is set) and the `<html lang>` attribute (from `defaults.lang`, `"en"` if unset).

## Sitemap

When `url` is set in `project.json`, the build emits `dist/sitemap.xml` from the route table — one `<url>` per compiled page, with:

- `<loc>` — absolute, built from `url` + the route, identical to the page's canonical URL
- `<lastmod>` — the page source file's modification date (`YYYY-MM-DD`)

Dynamic routes appear as their expanded concrete URLs; pages generated from one template share that template file's `<lastmod>`. Redirect sources are not pages and never appear.

To opt a single page out (a thank-you page, a draft), set `"$sitemap": false` at the page root. To disable the sitemap entirely, set `"build": { "sitemap": false }`. Without `url` the sitemap is skipped with a build warning — absolute `<loc>` values can't be built.

## robots.txt

After `public/` is copied into `dist/`, the build appends a `Sitemap: <url>/sitemap.xml` line to `dist/robots.txt`. If you shipped no `robots.txt`, a permissive default is created (`User-agent: *` / `Allow: /`); if yours already has a `Sitemap:` line, it is left untouched.

## Related

- [project.json](/docs/framework/site/project-json) — site-level `$head`, `url`, and `defaults`
- [Layouts](/docs/framework/site/layouts) — where layout-level head entries come from
- [Content collections](/docs/framework/site/content-collections) — the entry data that feeds templated metadata
