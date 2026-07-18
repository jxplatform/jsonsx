---
title: "project.json"
description: "Every key in a Jx site's project.json — identity, defaults, head entries, style tokens, content types, redirects, build — and what cascades into pages."
spec:
  - site-architecture.md#3
  - site-architecture.md#10
code:
  - packages/compiler/src/site/context-injection.ts
---

# project.json

> **Studio writes this file for you** — [Project settings](/docs/studio/projects/settings) edits the identity, defaults, and build keys; the [content-type builder](/docs/studio/projects/content-types) writes `content`; the [design-token editor](/docs/studio/design/tokens) writes `style`.

`project.json` at the project root is the only required configuration file in a Jx site. A minimal real one (abbreviated from jxsuite.com):

```json
{
  "$schema": "./project.schema.json",
  "name": "Jx Suite",
  "url": "https://jxsuite.com",
  "defaults": { "layout": "./layouts/base.json", "lang": "en" },
  "build": { "outDir": "./dist", "trailingSlash": "always" },
  "extensions": ["@jxsuite/parser"]
}
```

## Key reference

| Key          | Type     | Purpose                                                                                  |
| ------------ | -------- | ---------------------------------------------------------------------------------------- |
| `name`       | `string` | Site name — the default `<title>` and `$site.name`                                       |
| `url`        | `string` | Production URL, used for canonical URLs and the sitemap                                  |
| `defaults`   | `object` | `layout`, `lang`, and `charset` applied to every page                                    |
| `$head`      | `array`  | Global `<head>` entries injected into every page                                         |
| `$media`     | `object` | Named breakpoints available in every style object                                        |
| `style`      | `object` | Design tokens (`--` keys) and global element rules                                       |
| `state`      | `object` | Site-wide state, merged read-only into every page                                        |
| `$defs`      | `object` | Shared JSON Schema type definitions for the whole project                                |
| `content`    | `object` | Content types — see [Content collections](/docs/framework/site/content-collections)      |
| `imports`    | `object` | `$prototype` name → class path, cascaded to all pages                                    |
| `extensions` | `array`  | Extension packages providing formats, sections, and classes                              |
| `redirects`  | `object` | Source path → destination — see [Redirects](/docs/framework/site/redirects)              |
| `copy`       | `object` | Extra source → destination file mappings copied into the build output                    |
| `build`      | `object` | `outDir`, `trailingSlash`, `adapter` — see [Deployment](/docs/framework/site/deployment) |
| `images`     | `object` | Image optimization settings — see [Images](/docs/framework/site/images)                  |

## Identity and defaults

`name` and `url` identify the site: `name` is the fallback `<title>` and is exposed to every page as `$site.name`; `url` anchors canonical URLs and sitemap entries. `defaults.layout` wraps every page that doesn't declare its own `$layout` (a page can opt out with `"$layout": false`), and `defaults.lang` sets `<html lang>` site-wide.

## Global head entries

`$head` entries are injected into every page's `<head>`, before layout- and page-level entries:

```json
{
  "$head": [
    { "tagName": "link", "attributes": { "rel": "icon", "href": "/favicon.svg" } },
    {
      "tagName": "meta",
      "attributes": { "name": "viewport", "content": "width=device-width, initial-scale=1" }
    }
  ]
}
```

A page's own `$head` appends to (and, for singletons like `<title>`, overrides) the site-level entries. The full merge order is covered in [SEO and metadata](/docs/framework/site/seo).

## Breakpoints and style tokens

`$media` names media queries once so every component can respond to `"@--md"` without redeclaring the query. `style` holds the global stylesheet: `--`-prefixed keys compile to `:root {}` custom properties, plain camelCase properties style the page root, and nested objects are element selectors applied site-wide. Declaring a scheme query like `"--dark": "(prefers-color-scheme: dark)"` additionally enables the visitor-forced [color-scheme contract](/docs/framework/concepts/color-schemes) — `@--dark` token overrides in `style` become the dark variant of the design.

```json
{
  "$media": { "--md": "(max-width: 768px)", "--sm": "(max-width: 640px)" },
  "style": {
    "--color-accent": "#3b82f6",
    "--radius": "8px",
    "fontFamily": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    "backgroundColor": "var(--color-bg-primary)",
    "table": { "width": "100%", "borderCollapse": "collapse" }
  }
}
```

Every component in the project can reference `var(--color-accent)` and use `"@--md": { … }` overrides without importing anything. See [Styling](/docs/framework/concepts/styling) for the style object format and [Design tokens](/docs/studio/design/tokens) for the Studio editor.

## Site state and shared types

`state` declares site-wide data. Every page receives it two ways: merged directly into the page's own `state` (the page wins when it declares the same key), and under the read-only `$site` entry — `$site.name`, `$site.url`, plus each site state key.

```json
{
  "state": {
    "siteName": "My Site",
    "socialLinks": [{ "label": "GitHub", "url": "https://github.com/example" }]
  }
}
```

`$defs` holds reusable [JSON Schema type definitions](/docs/framework/concepts/documents) — shapes for API responses, CMS payloads, or shared value types — that any document in the project can reference, the project-wide counterpart of a document's own `$defs`.

## Content types

The `content` section defines content collections — folders of Markdown, JSON, or CSV entries with a schema (abbreviated from jxsuite.com, which publishes these docs from the repo's `docs/` folder):

```json
{
  "content": {
    "docs": {
      "source": "../../docs",
      "format": "Markdown",
      "$elements": [{ "$ref": "./components/doc-note.json" }],
      "schema": { "type": "object", "required": ["title"] }
    }
  }
}
```

The keys and query prototypes are covered in [Content collections](/docs/framework/site/content-collections).

## Redirects

`redirects` maps old paths to new ones — a plain string for a 301, or an object to pick the status:

```json
{
  "redirects": {
    "/docs/get-studio": "/docs/start/install/",
    "/legacy/post/:slug": { "destination": "/blog/:slug", "status": 301 }
  }
}
```

Patterns and status codes are covered in [Redirects](/docs/framework/site/redirects).

## Copying extra files

`copy` maps files from anywhere in the repository into the build output — useful for publishing artifacts that live outside `public/`:

```json
{
  "copy": {
    "../../packages/schema/project-schema.json": "schema/project/v1/index.json"
  }
}
```

Sources resolve relative to the project root; destinations are paths inside `dist/`. The copies run after `public/` assets, so a mapping can overwrite a public file of the same name.

## Build

`build` controls output: `outDir` (default `./dist`), `trailingSlash`, an optional deployment `adapter`, and sitemap generation. See [the build pipeline](/docs/framework/build) and [Deployment](/docs/framework/site/deployment).

## Extensions and imports

`extensions` lists extension packages (bare package names or relative paths) that contribute format classes such as `Markdown` and `Csv`, project sections such as `content`, and `$prototype` classes. `imports` maps a `$prototype` name to a class file for all pages at once; a page-level `imports` entry wins on collision. See [Data prototypes](/docs/framework/concepts/data-prototypes) and [Dependencies and imports](/docs/studio/projects/dependencies).

## What documents inherit

Site-level declarations cascade into every page automatically — no imports needed:

- `$head` entries are prepended to every page's `<head>`.
- `$media` breakpoints and `style` tokens are available in every component.
- `defaults.lang` sets `<html lang>` everywhere.
- `state` merges into page state (page wins) and is exposed as `$site`.
- `imports` and `$elements` merge with page-level entries (page wins on collision).

Everything else is deliberate: files in `data/` load via an explicit [`$ref`](/docs/framework/concepts/references), collection data requires `ContentCollection` or `ContentEntry` declarations, and components receive outside data only through [`$props`](/docs/framework/concepts/props-and-scope) — scope never leaks across a component boundary.
