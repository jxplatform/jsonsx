---
title: "SEO and metadata"
description: "Declare page metadata with $head, template it from state, and let the build merge heads and emit sitemap.xml and robots.txt."
spec:
  - site-architecture.md#8
code:
  - packages/site/src/head-merger.ts
  - packages/compiler/src/site/link-relations.ts
  - packages/compiler/src/site/site-build.ts
  - packages/schema/src/asset-paths.ts
---

# SEO and metadata

Every page's `<head>` is assembled declaratively at build time, with no imperative code. Metadata comes from three places (`project.json`, the layout, the page), template strings pull values from state, and the build adds a sitemap and `robots.txt` on top.

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

Each entry is `{ "tagName": ..., "attributes": ... }`, and any head element works: `meta`, `link`, `script`, `style`. Use the `title` property rather than a `<title>` entry; the merge always writes the computed title last, so a literal `<title>` in `$head` is overridden.

## Templated metadata

`title` and `$head` attribute values support template strings, evaluated against the page's resolved state. Content-driven pages take their metadata straight from the content entry, with no duplication. This is the docs page template on jxsuite.com:

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

1. **Built-in defaults**: `<meta charset>` and a standard viewport tag
2. **Site**: `$head` in `project.json` (favicon, fonts, global meta)
3. **Layout**: the layout document's `$head`
4. **Page**: the page's `$head`

Duplicates are detected by element identity, so a page-level entry replaces the site-level one rather than appearing twice:

| Element                     | Deduplication key                                  |
| --------------------------- | -------------------------------------------------- |
| `<title>`, `<meta charset>` | singleton                                          |
| `<meta name="...">`         | `name`                                             |
| `<meta property="...">`     | `property` (Open Graph)                            |
| `<link rel="...">`          | `rel` + `href` + `hreflang`/`type`/`media`/`sizes` |
| `<script src="...">`        | `src`                                              |

Links carry that fourth part because `rel` and `href` alone are not enough to tell two links apart: an RSS and an Atom feed are both `rel="alternate"` at different `type`s, and two favicon sizes share everything but `sizes`.

### A misspelled `rel` gets a warning

A `<link>` with a typo'd relation is a special kind of frustrating: it's still valid HTML, it still renders, and it does nothing.

```text
<link rel="stylshet"> — "stylshet" is not an IANA link relation, and a relation nobody
recognizes does nothing. Check the spelling, or use an absolute URI if it is an extension
relation (RFC 8288 §2.1.2).
```

You get one warning per distinct value, however many pages carry it, because the ones that matter live in the site or layout `$head`, so they're on every page.

It's a warning and never an error, and three things never trigger it: any relation in the [IANA registry](https://www.iana.org/assignments/link-relations/), the legacy `shortcut` in `rel="shortcut icon"`, and any absolute URI, which is how RFC 8288 says to write a relation the registry doesn't carry:

```json
{ "tagName": "link", "rel": "https://example.com/rel/pricing", "href": "/pricing/" }
```

Two tags are added automatically: `<link rel="canonical">` (built from `url` in `project.json` plus the page route, when `url` is set) and the `<html lang>` attribute. Both lose to one you write yourself.

`lang` comes from the page's `$lang` if it has one, otherwise `defaults.lang`, otherwise `"en"`. A page can also set `$dir` (or the site `defaults.dir`) for right-to-left content:

```json
{
  "$lang": "ar-EG",
  "$dir": "rtl"
}
```

`dir` is omitted entirely when neither is set. Nothing is guessed. On a site with [locales](/docs/framework/site/i18n) configured, both are derived from the route's language, and translated pages also gain `rel="alternate"` links pointing at each other.

## Package files in `$head`

A `$head` entry can point at a file inside an installed package by its bare specifier instead of a URL:

```json
{
  "$head": [
    {
      "tagName": "link",
      "attributes": {
        "rel": "stylesheet",
        "href": "@shoelace-style/shoelace/dist/themes/light.css"
      }
    }
  ]
}
```

The build resolves the specifier against your project root and copies the file into `/assets/`, rewriting the tag to point there. The name is derived from the specifier, so it is the same on every build:

```html
<link rel="stylesheet" href="/assets/shoelace-style-shoelace-dist-themes-light.css" />
```

`$elements` entries are handled the same way except that they are bundled instead of copied, because a component package imports its own dependencies and those imports have to be resolved before the browser sees them.

:::doc-note
If the package is not installed, the build fails and names the specifier. It does not emit a link and hope: a dead stylesheet URL looks identical to a working one until the site is deployed.
:::

## Structured data

A `<script type="application/ld+json">` entry takes an **object** as its `textContent`, and the build serializes it, so you do not write JSON inside a string:

```json
{
  "$head": [
    {
      "tagName": "script",
      "attributes": { "type": "application/ld+json" },
      "textContent": {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": "${state.post.data.title}",
        "author": { "@type": "Person", "name": "${$site.name}" }
      }
    }
  ]
}
```

Template strings resolve inside the object, at any depth, so the block can reference the page it describes. Jx emits the JSON-LD as written and does not process it: no context expansion, no validation against schema.org.

## Sitemap

When `url` is set in `project.json`, the build emits `dist/sitemap.xml` from the route table, one `<url>` per compiled page, with:

- `<loc>`: absolute, built from `url` + the route, identical to the page's canonical URL
- `<lastmod>`: a full timestamp (`2025-03-04T16:00:00Z`), taken from the page source file, or from the content entry when the page was generated from one

Dynamic routes appear as their expanded concrete URLs, each dated by **its own content entry** rather than by the `[slug]` template. That matters more than it sounds: you edit a template far more often than the posts under it, and dating by the template made every post in an archive announce itself as changed each time, the opposite of what `<lastmod>` is for. A route with no entry behind it (an authored page, or a `$paths` listing plain values) is still dated by its own file.

Redirect sources are not pages and never appear.

To opt a single page out (a thank-you page, a draft), set `"$sitemap": false` at the page root. To disable the sitemap entirely, set `"build": { "sitemap": false }`. Without `url` the sitemap is skipped with a build warning, because absolute `<loc>` values can't be built.

## robots.txt

After `public/` is copied into `dist/`, the build appends a `Sitemap: <url>/sitemap.xml` line to `dist/robots.txt`. If you shipped no `robots.txt`, a permissive default is created (`User-agent: *` / `Allow: /`); if yours already has a `Sitemap:` line, it is left untouched.

## Related

- [project.json](/docs/framework/site/project-json): site-level `$head`, `url`, and `defaults`
- [Layouts](/docs/framework/site/layouts): where layout-level head entries come from
- [Content collections](/docs/framework/site/content-collections): the entry data that feeds templated metadata
