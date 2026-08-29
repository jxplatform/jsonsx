# Jx Site Architecture Specification

## File-Based Routing, Content Collections, Layouts, and Static Site Generation

**Version:** 0.6.5-draft
**Status:** Partial
**Updated:** 2026-08-29
**License:** MIT

---

## Table of Contents

1. [Vision](#1-vision)
2. [Project Structure](#2-project-structure)
3. [Site Configuration](#3-site-configuration)
4. [File-Based Routing](#4-file-based-routing)
5. [Layouts](#5-layouts)
6. [Content Collections](#6-content-collections)
7. [Data Management in Studio](#7-data-management-in-studio)
8. [SEO & Metadata](#8-seo--metadata)
9. [Media Management](#9-media-management)
10. [Inheritance Model](#10-inheritance-model)
11. [Redirect & Rewrite Management](#11-redirect--rewrite-management)
12. [Multi-Page Compilation](#12-multi-page-compilation)
13. [Internationalization](#13-internationalization)
14. [Deployment](#14-deployment)
15. [Application Tier](#15-application-tier)
16. [Standards Alignment](#16-standards-alignment)

---

## 1. Vision

Jx Studio is a visual IDE for the development and management of local-first, statically compiled applications and websites which are composed and deployed via the Jx schema and pipeline.

"Statically compiled" describes how pages are produced, not a ceiling on what a project may be. Every page is prerendered at build time — that never changes — but a project may also carry signed-in users, application data, and server-side logic, served by a generated worker deployed alongside those pages (§14.1, §15).

### 1.1 Design Principles

1. **File-based is canonical.** The filesystem is the source of truth for the project itself. Every page, component, layout, and content entry has a location on disk — no CMS backend and no proprietary store holds what an author edits. Studio is a filesystem editor with a visual canvas. Application data (accounts, sessions, rows an end user creates) is a separate concern living in a database the project connects to, declared in `project.json` by identifier and env-var name only (§15).

2. **Convention over configuration.** Sensible defaults derived from well-known prior art (Astro, Next.js, Eleventy). A `pages/` directory means file-based routing. A `content/` directory means content collections. A `layouts/` directory means shared page shells. Zero configuration required — but overridable.

3. **Static-first, with a real server tier.** All page output is static HTML/CSS/JS: the compiler prerenders every page at build time, and interactivity hydrates as islands in the browser. There is no per-request page rendering. **No server runtime ships by default** — the worker is opt-in via `build.adapter`, and a project that leaves it unset deploys as plain static files. Setting an adapter emits a worker serving `/_jx/*` alongside the same prerendered pages: a single Hono app carrying the site's server entries, deduplicated by export name, plus registry-driven extension mounts (§14.1). With no adapter, a page's own `timing: "server"` entries still compile to a per-route `_server.js` written beside that page, but nothing site-wide is produced.

4. **JSON all the way down.** Site configuration is JSON. Page templates are JSON. Content schemas are JSON Schema. Layouts are JSON. The only non-JSON files are content entries (Markdown, CSV, media) and user-authored JavaScript sidecar functions. This makes the entire project machine-readable and Studio-editable.

5. **Local-first.** No hosted Jx service sits between an author and their project. The dev server runs on localhost and the build writes to a `dist/` folder on disk; nothing in that loop requires an account or a hosted service. (A project that connects to a remote database does reach that database in development too — only connectors declaring a local stand-in, D1 among them, are served from disk instead; §15.4.) Deployment is a file upload to any host — static files alone for a purely static project, those same files plus the generated worker when the project has a server tier (§14). A project that connects to a database points at one the author controls; `project.json` records its name, never its credentials (§15).

### 1.2 What This Spec Covers

This spec defines everything that sits _above_ the component model: how components compose into pages, how pages compose into sites, how content enters the system, how a site grows into an application with accounts and data, and how Studio manages all of it. It answers:

- How to compose a new site with Jx
- How to define datatypes and content collections
- How to manage (add/edit/delete) data in Studio
- How templates (Jx) and datasets (Markdown, CSV, media) correlate on the filesystem
- How to bake SEO metadata into pages
- How to manage redirects, rewrites, and other CMS concerns
- How to manage media assets
- How the inheritance model works (global styles, variables, `<head>` tags, application-wide state)
- How a project builds and deploys, and what each adapter emits
- Where the application tier fits: signed-in users, application data, and server functions (§15)

Content collections (§6) and the application tier (§15) are deliberately different things. A collection is authored content, read at build time and baked into the prerendered page. An application table is end-user data, read and written at request time over `/_jx/data`. Both are declared in committed files — a collection's schema and a table's schema both sit in `project.json` — and both appear in Studio. What differs is where the entries live: a collection's are files in the repository, a table's rows are in the connected database.

Two neighboring specs carry the detail this one only points at: `extensions.md` §11–§13 defines the server-mount, connector, and secrets contracts that `@jxsuite/auth` and `@jxsuite/connector` implement, and `server.md` defines the dev server that stands in for the generated worker locally.

---

## 2. Project Structure

A Jx site project follows a conventional directory layout. Only `project.json` and `pages/` are required — everything else is optional and additive.

```
my-site/
├── project.json                    # Site configuration (required)
├── pages/                       # File-based routing (required)
│   ├── index.json               # → /
│   ├── about.json               # → /about
│   ├── blog/
│   │   ├── index.json           # → /blog
│   │   └── [slug].json          # → /blog/:slug (dynamic)
│   └── docs/
│       └── [...path].json       # → /docs/* (catch-all)
├── layouts/                     # Shared page shells
│   ├── base.json                # Root layout: <html>, <head>, <body>
│   ├── blog-post.json           # Blog-specific layout
│   └── docs.json                # Documentation layout with sidebar
├── components/                  # Reusable Jx components
│   ├── header.json
│   ├── footer.json
│   └── nav.json
├── content/                     # Content collections (see project.json `content`)
│   ├── blog/                    # "blog" content type
│   │   ├── hello-world.md
│   │   ├── second-post.md
│   │   └── images/
│   │       └── hero.jpg
│   ├── authors/                 # "authors" collection
│   │   └── authors.json
│   └── products/                # "products" collection
│       └── catalog.csv
├── data/                        # Static data files (not collections)
│   └── navigation.json
├── public/                      # Static assets (copied verbatim)
│   ├── favicon.svg
│   ├── robots.txt
│   └── fonts/
├── styles/                      # Shared style partials
│   └── tokens.json              # Design token definitions
└── dist/                        # Build output (generated)
```

### 2.1 Directory Conventions

| Directory     | Purpose                                                        | Required  |
| ------------- | -------------------------------------------------------------- | --------- |
| `pages/`      | File-based routing. Each `.json` file becomes a route.         | **Yes**   |
| `layouts/`    | Layout components. Referenced by pages via `$layout`.          | No        |
| `components/` | Reusable components. Referenced via `$ref` or `$elements`.     | No        |
| `content/`    | Content collections with schema validation.                    | No        |
| `data/`       | Static data files loaded at build time. No schema enforcement. | No        |
| `public/`     | Static assets copied verbatim to `dist/`. No processing.       | No        |
| `styles/`     | Shared style fragments and design tokens.                      | No        |
| `dist/`       | Build output. Ignored by git.                                  | Generated |

### 2.2 Component Co-location

Components may be co-located with their pages. Files prefixed with `_` in the `pages/` directory are excluded from routing (following Astro's convention):

```
pages/
├── blog/
│   ├── index.json               # → /blog (routed)
│   ├── [slug].json              # → /blog/:slug (routed)
│   └── _blog-card.json          # Not routed — local component
```

---

## 3. Site Configuration

The `project.json` file at the project root defines site-wide settings. It is the only required configuration file.

```json
{
  "$schema": "https://jxsuite.com/schema/project/v1",
  "name": "My Site",
  "url": "https://example.com",

  "defaults": {
    "layout": "./layouts/base.json",
    "lang": "en",
    "charset": "utf-8"
  },

  "$head": [
    {
      "tagName": "meta",
      "name": "viewport",
      "content": "width=device-width, initial-scale=1"
    },
    { "tagName": "link", "rel": "icon", "href": "/favicon.svg" },
    { "tagName": "link", "rel": "stylesheet", "href": "/fonts/inter.css" }
  ],

  "$media": {
    "--sm": "(min-width: 640px)",
    "--md": "(min-width: 768px)",
    "--lg": "(min-width: 1024px)",
    "--xl": "(min-width: 1280px)",
    "--dark": "(prefers-color-scheme: dark)"
  },

  "style": {
    "--color-primary": "#3b82f6",
    "--color-surface": "#ffffff",
    "--font-sans": "Inter, system-ui, sans-serif",
    "--font-mono": "JetBrains Mono, monospace",
    "@--dark": {
      "--color-surface": "#0f172a"
    }
  },

  "state": {
    "siteName": "My Site",
    "socialLinks": [
      { "label": "GitHub", "url": "https://github.com/example" },
      { "label": "Twitter", "url": "https://twitter.com/example" }
    ]
  },

  "extensions": ["@jxsuite/parser"],

  "redirects": {
    "/old-blog": "/blog",
    "/legacy/post/:slug": { "destination": "/blog/:slug", "status": 301 }
  },

  "build": {
    "outDir": "./dist",
    "trailingSlash": "always",
    "adapter": "cloudflare-pages"
  }
}
```

### 3.1 Configuration Properties

| Property           | Type     | Description                                                                                               |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------- |
| `name`             | `string` | Site name, used in default `<title>` and meta tags                                                        |
| `url`              | `string` | Production URL, used for canonical URLs and sitemap generation                                            |
| `defaults.layout`  | `string` | Default layout applied to all pages that don't specify `$layout`                                          |
| `defaults.lang`    | `string` | Default `<html lang>` attribute                                                                           |
| `defaults.charset` | `string` | Default charset (always `utf-8`)                                                                          |
| `$head`            | `array`  | Global `<head>` elements injected into every page                                                         |
| `$media`           | `object` | Named media query breakpoints, available to all components                                                |
| `style`            | `object` | Root-level CSS custom properties and global styles                                                        |
| `state`            | `object` | Site-wide state accessible to all pages and components                                                    |
| `redirects`        | `object` | Static redirect rules (see §11)                                                                           |
| `imports`          | `object` | Import map: `$prototype` name → `.class.json` path (see spec §12.4)                                       |
| `extensions`       | `array`  | Extension packages (bare npm names or relative paths) providing formats, connectors, and project sections |
| `content`          | `object` | Content type definitions: name → `source`/`format`/`schema` (see §6)                                      |
| `copy`             | `object` | Declarative file copy map: source path (project-root relative) → destination path (relative to `outDir`)  |
| `$defs`            | `object` | Global type definitions available to all pages                                                            |
| `$elements`        | `array`  | Global custom element dependencies (`$ref` objects or npm specifier strings)                              |
| `build`            | `object` | Build output configuration (see §14)                                                                      |
| `images`           | `object` | Image optimization settings (see §9.2)                                                                    |

### 3.2 Inheritance

Site-level declarations cascade to all pages:

- `$head` entries are prepended to every page's `<head>`
- `$media` breakpoints are available in every component's style objects
- `style` properties prefixed with `--` are compiled to `:root {}` automatically — including inside conditional `@--name` blocks (spec §9.5); element selectors use nested objects
- `state` entries are available to every page (read-only from the page's perspective)
- `imports` entries cascade to all pages; page-level entries take precedence on collision

Pages may override any inherited value. A page declaring its own `$head` entries appends to (does not replace) the site-level `$head`. A page may shadow a site-level `state` entry with its own.

**The cascade is why editing this file is editing every page.** A bare tag key in `style` compiles
to a global rule — `h1 { … }`, not a scoped one — and components render into light DOM, so it
applies inside every component instance too. Studio states that blast radius before the first
keystroke rather than after the fact (`studio.md` §6.2), and edits `project.json` as a document
under undo (`studio.md` §17), because a file whose every property reaches every route is the last
place a silent write belongs.

---

## 4. File-Based Routing

Inspired by Astro and Next.js, every `.json` file in the `pages/` directory automatically becomes a route. No routing configuration is needed.

> **Standards note:** All URL pattern syntax in this specification (`:param`, `*`, optional `?`, regexp groups) conforms to the [WHATWG URLPattern Standard](https://urlpattern.spec.whatwg.org/), which is included in the [WinterTC Minimum Common API](https://min-common-api.proposal.wintertc.org/). Compilers SHOULD validate patterns using `new URLPattern({ pathname: pattern })` at build time.

### 4.1 Static Routes

The file path determines the URL path:

| File                              | URL                     |
| --------------------------------- | ----------------------- |
| `pages/index.json`                | `/`                     |
| `pages/about.json`                | `/about`                |
| `pages/about/index.json`          | `/about`                |
| `pages/blog/index.json`           | `/blog`                 |
| `pages/blog/first-post.json`      | `/blog/first-post`      |
| `pages/docs/getting-started.json` | `/docs/getting-started` |

### 4.2 Dynamic Routes

Bracket syntax in filenames creates parameterized routes:

| File                         | URL Pattern      | Example                     |
| ---------------------------- | ---------------- | --------------------------- |
| `pages/blog/[slug].json`     | `/blog/:slug`    | `/blog/hello-world`         |
| `pages/[category]/[id].json` | `/:category/:id` | `/products/42`              |
| `pages/docs/[...path].json`  | `/docs/*`        | `/docs/api/runtime/install` |

Dynamic route parameters are resolved at build time by querying content collections or providing explicit path sets.

### 4.3 Dynamic Route Resolution

A dynamic page must declare which paths it generates. This is done via a top-level `$paths` property:

```json
{
  "$layout": "./layouts/blog-post.json",
  "$paths": {
    "contentType": "blog",
    "param": "slug",
    "field": "id"
  },
  "state": {
    "post": {
      "$prototype": "ContentEntry",
      "contentType": "blog",
      "id": { "$ref": "#/$params/slug" }
    }
  },
  "children": [
    {
      "tagName": "h1",
      "textContent": "${state.post.data.title}"
    },
    {
      "tagName": "article",
      "children": "${state.post.$children ?? []}"
    }
  ]
}
```

**`$paths` shapes:**

```json
// From a content collection — one page per entry
{ "contentType": "blog", "param": "slug", "field": "id" }

// Explicit list
{ "values": ["en", "fr", "de"], "param": "lang" }

// From a data file
{ "$ref": "./data/products.json", "param": "id", "field": "sku" }
```

The compiler iterates `$paths` at build time, injecting each set of parameters into `$params` and compiling one HTML page per entry.

### 4.4 Route Priority

When multiple routes could match a URL, priority follows Astro's rules:

1. Static routes over dynamic routes (`/about` beats `/[slug]`)
2. Named parameters over rest/catch-all (`/[slug]` beats `/[...path]`)
3. More specific paths over less specific (`/blog/[slug]` beats `/[...path]`)
4. Files prefixed with `_` are excluded from routing entirely

### 4.5 Route Params at Runtime

Inside a dynamic page, route parameters surface in two places:

```json
{
  "state": {
    "post": {
      "$prototype": "ContentEntry",
      "contentType": "blog",
      "id": { "$ref": "#/$params/slug" }
    }
  }
}
```

1. **State references** — `{ "$ref": "#/$params/<name>" }` inside a state entry resolves to the parameter value at build time (e.g. a `ContentEntry` id, as above).
2. **`$page.params`** — the compiler injects the resolved parameters into page state as `$page.params`, alongside `$page.url` and `$page.title` (§5.5).

There is no bare `${$params.…}` template binding. Parameters are resolved at compile time — each expanded route is compiled with its own literal values, so nothing param-related ships to the browser.

---

## 5. Layouts

Layouts are Jx documents that provide a shared page shell — the `<html>`, `<head>`, `<body>`, navigation, footer, and any other chrome common across pages.

### 5.1 Layout Documents

A layout is a standard Jx file that uses HTML `<slot>` elements — the same mechanism already implemented for custom elements — to indicate where page content is injected:

```json
{
  "tagName": "html",
  "lang": "${$page.lang ?? 'en'}",
  "children": [
    {
      "tagName": "head",
      "children": [
        { "tagName": "meta", "charset": "utf-8" },
        {
          "tagName": "meta",
          "name": "viewport",
          "content": "width=device-width, initial-scale=1"
        },
        { "tagName": "title", "textContent": "${$page.title ?? $site.name}" }
      ]
    },
    {
      "tagName": "body",
      "children": [
        { "$ref": "../components/header.json" },
        {
          "tagName": "main",
          "children": [{ "tagName": "slot" }]
        },
        { "$ref": "../components/footer.json" }
      ]
    }
  ]
}
```

### 5.2 Referencing Layouts from Pages

Pages declare their layout via `$layout`:

```json
{
  "$layout": "./layouts/base.json",
  "$head": [
    { "tagName": "title", "textContent": "About Us" },
    {
      "tagName": "meta",
      "name": "description",
      "content": "Learn about our company"
    }
  ],
  "children": [
    {
      "tagName": "section",
      "children": [
        { "tagName": "h1", "textContent": "About Us" },
        { "tagName": "p", "textContent": "We build things." }
      ]
    }
  ]
}
```

The page's `children` are injected at the layout's `<slot>` position via the same `distributeSlots()` algorithm already implemented for custom elements — just run at compile time instead of DOM time. The page's `$head` entries merge with the layout's and site's head entries.

`$layout` paths — like `defaults.layout` — are resolved against the **project root**, not the referencing file. The same `"./layouts/base.json"` works from a page at any directory depth.

If a page omits `$layout`, it uses the default layout from `project.json`. If `$layout` is explicitly set to `false`, no layout wraps the page (useful for standalone pages like landing pages or embeds).

### 5.3 Named Slots

Layouts may define multiple named slots for structured page regions, using the standard HTML `<slot>` element with `name` attribute — identical to how custom element slots already work:

```json
{
  "tagName": "body",
  "children": [
    { "$ref": "../components/header.json" },
    {
      "tagName": "aside",
      "children": [{ "tagName": "slot", "attributes": { "name": "sidebar" } }]
    },
    {
      "tagName": "main",
      "children": [{ "tagName": "slot" }]
    },
    { "$ref": "../components/footer.json" }
  ]
}
```

Pages target named slots via the standard `slot` attribute — the same mechanism consumers already use with custom elements:

```json
{
  "$layout": "./layouts/docs.json",
  "children": [
    {
      "tagName": "nav",
      "attributes": { "slot": "sidebar" },
      "children": [{ "tagName": "a", "href": "/docs/intro", "textContent": "Intro" }]
    },
    {
      "tagName": "article",
      "children": [{ "tagName": "h1", "textContent": "Documentation" }]
    }
  ]
}
```

Children without a `slot` attribute go into the default (unnamed) slot. Fallback content is supported: children of the `<slot>` element are displayed when no matching content is provided — per the HTML spec.

### 5.4 Layout Nesting

Layouts can reference other layouts, enabling composition:

```json
{
  "$layout": "./layouts/base.json",
  "children": [
    {
      "tagName": "div",
      "className": "blog-wrapper",
      "children": [
        {
          "tagName": "aside",
          "children": [{ "tagName": "slot", "attributes": { "name": "sidebar" } }]
        },
        {
          "tagName": "article",
          "children": [{ "tagName": "slot" }]
        }
      ]
    }
  ]
}
```

This allows `blog-post.json` layout to wrap within `base.json`, providing blog-specific chrome while inheriting the site shell.

### 5.5 Layout Props

Layouts receive page metadata via the `$page` context object:

| Property            | Source                                                          | Description                   |
| ------------------- | --------------------------------------------------------------- | ----------------------------- |
| `$page.title`       | Page's `$head` title or explicit `title` field                  | Page title                    |
| `$page.description` | Page's `$head` meta description                                 | Meta description              |
| `$page.url`         | Computed from file path                                         | Page URL path                 |
| `$page.locale`      | `$lang`, else the route's locale, else the site default (§13.4) | BCP 47 language tag           |
| `$page.dir`         | Derived from `$page.locale`'s script (§13.4)                    | `ltr` or `rtl`                |
| `$page.alternates`  | The page's translation set (§13.5)                              | `{code, url, dir, current}[]` |
| `$page.$head`       | Page's `$head` array                                            | Page-specific head entries    |
| `$page.frontmatter` | Content entry frontmatter (for content pages)                   | All frontmatter fields        |

The `$site` context provides site-level data:

| Property              | Source                        | Description                     |
| --------------------- | ----------------------------- | ------------------------------- |
| `$site.name`          | `project.json` `name`         | Site name                       |
| `$site.url`           | `project.json` `url`          | Production URL                  |
| `$site.state`         | `project.json` `state`        | Site-wide state                 |
| `$site.$head`         | `project.json` `$head`        | Global head entries             |
| `$site.locales`       | `i18n.locales`, canonicalized | Declared locales, default first |
| `$site.defaultLocale` | `i18n.defaultLocale`          | The locale `/` serves           |

---

## 6. Content Collections

Content collections are the data layer for content-driven sites. They bring structure, schema validation, and queryability to plain Markdown, JSON, CSV, and other data files.

### 6.1 Defining Collections

Collections are defined in the `content` key of `project.json`. Each key names a content type:

```json
{
  "$schema": "https://jxsuite.com/schema/project/v1",
  "content": {
    "blog": {
      "source": "./content/blog/",
      "format": "Markdown",
      "schema": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "description": { "type": "string" },
          "pubDate": { "type": "string", "format": "date" },
          "updatedDate": { "type": "string", "format": "date" },
          "author": { "$ref": "#/content/authors" },
          "tags": {
            "type": "array",
            "items": { "type": "string" }
          },
          "draft": { "type": "boolean", "default": false },
          "heroImage": { "type": "string", "format": "uri-reference" }
        },
        "required": ["title", "pubDate"]
      }
    },

    "authors": {
      "source": "./content/authors/",
      "format": "json",
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "bio": { "type": "string" },
          "avatar": { "type": "string", "format": "uri-reference" },
          "links": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": { "type": "string" },
                "url": { "type": "string", "format": "uri" }
              }
            }
          }
        },
        "required": ["name"]
      }
    },

    "products": {
      "source": "./content/products/catalog.csv",
      "schema": {
        "type": "object",
        "properties": {
          "sku": { "type": "string" },
          "name": { "type": "string" },
          "price": { "type": "number" },
          "category": { "type": "string" }
        },
        "required": ["sku", "name", "price"]
      }
    }
  }
}
```

A collection whose `source` is a **directory** also publishes that directory at `/content/<type>` — the collection's asset mount ([extensions.md §8.5](./extensions.md)). Files sitting beside the entries (images, downloads) therefore have a stable site URL even when the source lives outside the project, and entries address them relative to themselves. See §9.3.

### 6.2 Collection Shapes

`format` values are **format class names** provided by enabled extensions (§6.5) — `"json"` is the only native built-in. There is no YAML format class.

| Format     | File Type                 | Entry ID                               | Notes                                                        |
| ---------- | ------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `Markdown` | Markdown with frontmatter | Filename (path-based for nested files) | Body parsed to Jx tree (`$children`); from `@jxsuite/parser` |
| `json`     | JSON objects              | `id` field or filename                 | Native built-in — direct data access                         |
| `Csv`      | CSV rows                  | Row index or ID column                 | From `@jxsuite/parser`; supports remote (`https`) sources    |

### 6.3 Schema Validation

Collection schemas are standard JSON Schema. The `@jxsuite/schema` package already generates JSON Schema from web platform IDL — the same infrastructure validates content entries.

At build time:

- Every content entry is validated against its collection schema as it loads
- Missing required fields log a **warning** keyed by content type and entry id (e.g. `"blog/hello-world" missing required field "title"`); the build continues
- Type mismatches warn with the expected vs actual type — these are console warnings, not compile errors, and no line numbers are reported
- The `$ref` between collections (e.g., `author` referencing the `authors` collection) is resolved at load time; ids that match no entry in the target collection log a warning and are **left unresolved** in the entry data

In Studio:

- Schema drives form generation for content editing (see §7)
- Autocomplete and inline validation in the content editor

### 6.4 Querying Collections in Pages

Pages access collection data via state entries with `$prototype: "ContentCollection"` or `$prototype: "ContentEntry"`:

```json
{
  "state": {
    "posts": {
      "$prototype": "ContentCollection",
      "contentType": "blog",
      "filter": { "draft": false },
      "sort": { "field": "pubDate", "order": "desc" },
      "limit": 10
    }
  },
  "children": [
    {
      "tagName": "ul",
      "children": {
        "$prototype": "Array",
        "of": { "$ref": "#/state/posts" },
        "map": {
          "tagName": "li",
          "children": [
            {
              "tagName": "a",
              "href": "/blog/${item.id}",
              "textContent": "${item.data.title}"
            },
            {
              "tagName": "time",
              "textContent": "${item.data.pubDate}"
            }
          ]
        }
      }
    }
  ]
}
```

#### Entry Access

```json
{
  "state": {
    "post": {
      "$prototype": "ContentEntry",
      "contentType": "blog",
      "id": { "$ref": "#/$params/slug" }
    }
  }
}
```

A `ContentEntry` resolves to:

```json
{
  "id": "hello-world",
  "data": {
    "title": "Hello World",
    "pubDate": "2024-01-15",
    "tags": ["intro"]
  },
  "body": "# Hello\n\nThis is my first post.",
  "$children": [
    { "tagName": "h1", "textContent": "Hello" },
    { "tagName": "p", "textContent": "This is my first post." }
  ]
}
```

#### Collection References

The `$ref` syntax in schemas creates cross-collection links. Relationship pointers use the `#/content/<type>` prefix:

```json
{
  "author": { "$ref": "#/content/authors" }
}
```

In a Markdown frontmatter:

```yaml
---
title: My Post
author: jane-doe
---
```

The value `"jane-doe"` is resolved at build time to the matching entry in the `authors` collection by its `id`. Templates can then access `state.post.data.author.data.name`. An id that matches no entry is left as the bare string, with a build warning (§6.3).

### 6.5 Filesystem Correlation

The filesystem structure directly mirrors the logical model:

```
content/                         # Schemas live in project.json `content`
├── blog/                        # "blog" collection
│   ├── hello-world.md           # Entry: id = "hello-world"
│   ├── second-post.md           # Entry: id = "second-post"
│   └── images/                  # Co-located media for blog posts
│       ├── hello-hero.jpg       # Referenced as "./content/blog/images/hello-hero.jpg"
│       └── second-hero.png
├── authors/                     # "authors" collection
│   └── authors.json             # All author entries in one file
└── products/                    # "products" collection
    └── catalog.csv              # All product entries in one file
```

**Key rules:**

- One directory per collection (named after the collection)
- `format` names a **format class** from the project `imports` map (e.g. `"Markdown"`, `"Csv"`) — see specs/extensions.md. `"json"` is the only built-in. When omitted, the format is derived from the source file extension via the format registry; directory sources require an explicit `format`.
- Remote `http(s)` sources require an explicit `format` whose class declares `"remote": true` (e.g. `Csv`). There is no implicit remote format.
- For directory-based collections, the format class's `discover` capability lists entry files; each file is one entry
- Discovery is **recursive**: a document in a subdirectory of the source (`content/blog/2026/hello.md`) is an entry of that collection, while a co-located media file in the same subdirectory is not — an entry is a file whose extension the collection's format claims
- For file-based collections (single CSV or JSON file as `source`), one file contains many entries
- Media can be co-located next to content entries
- The collection directory name matches the key in the `content` section of `project.json`

---

### 6.7 Syndication feeds

> **Status: Implemented.** Provided by `@jxsuite/feed`, a first-party extension rather than a
> compiler built-in: a feed is derived from a content collection, and hard-coding the compiler to
> one extension's section is the coupling `extensions.md` §1 exists to prevent.

A `feed` section names a collection and the URL prefix its entries are served under:

```json
{
  "feed": {
    "blog": {
      "collection": "posts",
      "basePath": "/blog/",
      "title": "Example Blog",
      "archive": true
    }
  }
}
```

**Atom (RFC 4287) and JSON Feed 1.1. RSS 2.0 is deliberately not offered** — it has no standards
body, its `<guid>` semantics were never settled, and every reader handles Atom. The omission is a
decision rather than an oversight, which is why it is written down.

**Dates come from the entry, never the build.** The `date` and `updated` frontmatter fields are
already normalized to RFC 3339 by the parser (`parser.md` §9.3); an entry with no authored date
falls back to `_meta.mtime`. The feed-level `<updated>` is the newest **item** — a feed stamped with
the build time re-notifies every subscriber on every deploy.

**RFC 5005.** With `archive: true`, entries beyond `pageSize` are written to
`/feed/archive/<n>.xml`, linked by `prev-archive` and `next-archive`, each pointing back at the
subscription document with `rel="current"`. Archives are chunked **from the oldest end**, so
archive 1 keeps its contents as entries are added and only the newest archive changes — RFC 5005 §2
asks that a published archive not change. When a feed holds its entire history it says so with
`<fh:complete/>`, and only then: a document trimmed by `pageSize` is not complete even with no
archives, and claiming otherwise would be believed.

**Discovery.** The `<link rel="alternate">` tags come from the `head` capability
(`extensions.md` §8.6), not from `emit` — emitters run after every page is written and cannot reach
a `<head>`. Both formats' links survive the merge because §8.3 keys a link on its `type` as well as
its `rel` and `href`.

**A localized collection is several feeds, not one.** When the named collection's `source` carries
`{locale}` (§13.3), each language is published in its own URL space — `/feed.xml` and
`/fr-ca/feed.xml` — holding only that language's entries, at that language's item URLs, and saying
what it carries: `xml:lang` on the Atom feed element, which RFC 4287 §2 makes every child inherit,
and JSON Feed's `language` member. One feed mixing three languages is worse than it sounds: a reader
subscribes in theirs and receives every post three times, twice in a language they do not read.

Discovery advertises **all** of them, each with `hreflang`. The `head` capability runs before
routing and cannot know which locale its page is in — one link per language, and the client picks,
which is what `hreflang` on an `alternate` link is for.

## 7. Data Management in Studio

Studio extends from a component editor to a full content management interface.

### 7.1 Project Explorer (Implemented)

The left panel includes a file tree (`Files` tab) that displays the project directory structure. When a site project is detected (i.e., `project.json` exists), the tree auto-expands conventional directories.

Additionally, the **Browse** canvas mode provides a full-screen project file table with category filtering (All, Pages, Layouts, Components, Content, Media), text search, and click-to-open. Files are categorized by directory path, with media extensions (`.jpg`, `.png`, `.svg`, `.webp`, etc.) always classified as "Media" regardless of location.

```
┌─────────────────────────────────────────────────────────────────┐
│ [All] [Pages] [Layouts] [Components] [Content] [Media]  🔍     │
├───────────────┬────────────┬───────┬────────────────────────────┤
│ Name          │ Category   │ Type  │ Path                       │
├───────────────┼────────────┼───────┼────────────────────────────┤
│ index.json    │ Pages      │ .json │ pages/index.json           │
│ about.json    │ Pages      │ .json │ pages/about.json           │
│ header.json   │ Components │ .json │ components/header.json     │
│ hello.md      │ Content    │ .md   │ content/blog/hello.md      │
│ hero.jpg      │ Media      │ .jpg  │ content/blog/images/hero…  │
└───────────────┴────────────┴───────┴────────────────────────────┘
```

### 7.2 Content Collection Browser

The **Library** is the collection browser — an editor kind over a `GridSource`, so a collection is
the same kind of thing as a data table and is windowed by the same primitive.

| Layout       | Status          | Description                                                               |
| ------------ | --------------- | ------------------------------------------------------------------------- |
| **Table**    | **Implemented** | Name, Category, Type, Path. Filterable by category and search.            |
| **Cards**    | **Implemented** | Hero image, title and summary, with previews mounted only while on screen |
| **Calendar** | **Implemented** | Date-sorted, for date-bearing collections                                 |
| **Board**    | **Implemented** | Grouped by a chosen field                                                 |
| **Media**    | **Implemented** | Thumbnails, for the asset categories                                      |

**Views are windowed, and the window is the contract.** Rendering a live runtime instance per card
does not survive a real project: the measured case is 300 pages in one category, where the whole
list is 300 cards and 1,830 DOM nodes against a window's 40 and 270. Previews are mounted by an
`IntersectionObserver` and held in an LRU whose cap must exceed one window's worth — a cap smaller
than the window thrashes against itself and re-renders continuously.

The layout is selectable per collection and remembered, along with the filter, sort, columns and
grouping, as a **saved view**.

### 7.3 Markdown WYSIWYG Editing (Implemented)

Markdown files (`.md`) open in **content mode** — a centered column WYSIWYG canvas where headings, paragraphs, lists, and other block elements are directly editable:

- **Inline rich text:** Click any text block to edit. `Cmd+B` (bold), `Cmd+I` (italic), `Cmd+\`` (code), plus toolbar buttons for `strong`, `em`, `del`, `sub`, `sup`, `u`.
- **Slash commands:** Type `/` in any block to insert headings, paragraphs, lists, blockquotes, images, tables, code blocks, horizontal rules, etc.
- **Bidirectional MD ↔ Jx conversion:** Markdown AST (`remark-parse`) converts to the Jx tree for canvas rendering; on save, the tree converts back to Markdown (`remark-stringify`) with frontmatter preserved.
- **Frontmatter round-trip:** YAML frontmatter is parsed on load (`S.content.frontmatter`) and serialized back on save. Currently stored but not editable via a UI form (see §7.4).

### 7.4 Content Entry Editor

#### Frontmatter Form

> **Status: Implemented.** A content entry belonging to a collection with a schema opens the **entry
> editor**, a schema-driven form over the same widget mapping the inspector uses.

**One editor, two storage shapes.** Where an entry's fields LIVE depends on its format and nothing
else: a Markdown entry keeps them in frontmatter, a JSON entry _is_ the document. The editor reads
and writes whichever the format declares — forking the editor per format is how a JSON entry came to
render a blank form and discard every edit while reporting success.

| JSON Schema Type                     | Widget                                        |
| ------------------------------------ | --------------------------------------------- |
| `string`                             | Text input                                    |
| `string` + `format: "date"`          | Date picker                                   |
| `string` + `format: "uri-reference"` | File picker (opens media browser)             |
| `string` + `enum`                    | Select dropdown                               |
| `number`                             | Number input                                  |
| `boolean`                            | Toggle switch                                 |
| `array` of `string`                  | Tag input (chip editor)                       |
| `array` of `object`                  | Repeatable field group                        |
| `object`                             | Nested form group                             |
| `$ref` to collection                 | Entry picker (dropdown of collection entries) |

#### JSON Data Entry Editing

> **Status: Implemented.** A JSON entry opens the same form as a Markdown one, generated from the
> collection's schema. Its fields are the document's own properties — see the storage-shape rule
> above.

#### CSV Editing

> **Status: Implemented**, though not as this section imagined it. A `.csv` entry opens as a
> **`GridSource`** rather than a bespoke `<sp-table>`, so it inherits the table, the edit buffer,
> undo and the import path that every other tabular surface uses. Column types still derive from the
> schema.

### 7.5 Content CRUD Operations

| Operation       | Status          | Action                                                                                                                                                                    |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create**      | **Implemented** | Collection-scoped **New Entry**, seeded from the content type's schema defaults so the entry is valid the moment it exists. One creation flow, shared with the file tree. |
| **Read**        | **Implemented** | The Library lists a collection; opening an entry gives the WYSIWYG canvas (Markdown) or the entry editor (JSON).                                                          |
| **Update**      | **Implemented** | The entry editor edits an entry's fields for both storage shapes — Markdown frontmatter and the JSON document itself.                                                     |
| **Delete**      | **Implemented** | Context menu → Delete, behind a confirmation that states the reference count (§9.4).                                                                                      |
| **Rename/Move** | **Implemented** | Context menu → Rename. Updates the filename, and therefore the entry id and slug.                                                                                         |

### 7.6 Draft Workflow

Entries with `"draft": true` (a conventional boolean field in the schema):

- Shown with a "Draft" badge in the collection browser, **and on the pane tab of an open entry** —
  the failure this guards against is publishing something the author believed was private, and that
  belief is formed while editing, not while browsing
- Excluded from production builds by default
- Included in dev server builds for preview
- A column and a filter in the Library, with an explicit "including drafts" perspective rather than
  a hidden default

---

## 8. SEO & Metadata

Every page compiles with proper SEO metadata. The system is declarative — no imperative code required.

### 8.1 Page-Level `$head`

Pages declare metadata via `$head`. The compiler resolves these into `<head>` elements:

```json
{
  "$head": [
    { "tagName": "title", "textContent": "My Blog Post — My Site" },
    {
      "tagName": "meta",
      "name": "description",
      "content": "A great blog post about things"
    },
    { "tagName": "meta", "property": "og:title", "content": "My Blog Post" },
    {
      "tagName": "meta",
      "property": "og:description",
      "content": "A great blog post about things"
    },
    {
      "tagName": "meta",
      "property": "og:image",
      "content": "https://example.com/blog/images/hero.jpg"
    },
    { "tagName": "meta", "property": "og:type", "content": "article" },
    {
      "tagName": "meta",
      "name": "twitter:card",
      "content": "summary_large_image"
    },
    {
      "tagName": "link",
      "rel": "canonical",
      "href": "https://example.com/blog/my-post"
    }
  ]
}
```

### 8.2 Templated Metadata

Metadata values support template strings referencing state, `$site`, and `$page`:

```json
{
  "$head": [
    {
      "tagName": "title",
      "textContent": "${state.post.data.title} — ${$site.name}"
    },
    {
      "tagName": "meta",
      "name": "description",
      "content": "${state.post.data.description}"
    },
    {
      "tagName": "link",
      "rel": "canonical",
      "href": "${$site.url}/blog/${$page.params.slug}"
    }
  ]
}
```

For content-driven pages, metadata comes directly from the content entry's frontmatter — no duplication.

### 8.3 Head Merge Order

The compiler assembles `<head>` content from three sources, in order:

1. **Site-level** (`project.json` `$head`) — global meta tags, fonts, icons
2. **Layout-level** (layout's `<head>` children) — charset, viewport, structural tags
3. **Page-level** (page's `$head`) — page-specific title, description, OG tags

Later entries can override earlier entries. If both site and page define a `<title>`, the page's wins.

Deduplication is by `tagName` plus the attribute that identifies the element: `name` for a `<meta name>`, `property` for a `<meta property>`, and for a `<link>`, `rel` **plus `href` plus whichever of `hreflang`, `type`, `media` or `sizes` is present**. That last part is not pedantry — `rel` and `href` alone are not identity, and the cases where they collide are ones a real site needs: `hreflang="x-default"` conventionally points at the same href as the default locale's alternate, and an RSS and an Atom feed are both `rel="alternate"` differing only in `type`.

An auto-injected entry loses to an author-supplied one under the same key, including the canonical link.

**`rel` values are checked against the IANA Link Relation Types registry.** A misspelled relation —
`stylshet`, `canonicial`, `alternative` — is well-formed HTML that renders, passes every other check
in this build, and does nothing at all: the stylesheet never loads, the canonical never
consolidates. There is no runtime symptom, so the build says so instead.

It is a **warning, never an error**, and reported once per distinct value across the whole build
rather than once per page — the mistake that matters lives in the site or layout `$head` and is
therefore on every page. Three things are deliberately not reported: registered relations
(`link-relations.ts` snapshots the registry CSV and names the date it was taken), `shortcut` (the
legacy spelling in `rel="shortcut icon"`, which the HTML Standard handles explicitly), and any
absolute URI, which is RFC 8288 §2.1.2's extension mechanism and the one way to express a relation
the registry does not carry. The snapshot going stale therefore costs one line of noise, not a
broken build.

### 8.4 Automatic SEO

The compiler automatically generates certain tags if not explicitly declared:

| Auto-generated                   | Condition                                                                |
| -------------------------------- | ------------------------------------------------------------------------ |
| `<meta charset>`                 | Always (from `defaults.charset`)                                         |
| `<meta name="viewport">`         | Always, unless the author supplies one                                   |
| `<title>`                        | Always — page title, falling back to the site `name`                     |
| `<link rel="canonical">`         | When `url` is set, from `$site.url` + page path                          |
| `<meta property="og:url">`       | With the canonical; an author-supplied value wins                        |
| `<meta property="og:site_name">` | From `$site.name`; an author-supplied value wins                         |
| `<html lang>`                    | From the page's `$lang`, else `defaults.lang`                            |
| `<html dir>`                     | From the page's `$dir`, else `defaults.dir`; omitted when neither is set |
| `sitemap.xml` entry              | Every page, when `url` is set (§8.4.1)                                   |

#### 8.4.1 Sitemap & `robots.txt`

When `url` is set in `project.json`, the build emits `dist/sitemap.xml` from the route table — one `<url>` entry per compiled page, each with a `<loc>` (absolute, built from `url` + the route via `new URL(route, url)`, so it is identical to the page's `<link rel="canonical">`) and a `<lastmod>` — the page source file's modification time as a **full RFC 3339 timestamp**. The W3C Datetime profile sitemaps.org cites admits both that and a bare `YYYY-MM-DD`; the date-only form threw away any way to tell two edits on one day apart.

- **Requires `url`.** Absolute `<loc>` values cannot be built without it; if `url` is absent the sitemap is skipped with a build warning.
- **Per-page opt-out.** A page sets `$sitemap: false` at its root to be excluded (e.g. thank-you pages, or drafts while build-time draft filtering is still pending). Every other page is included.
- **Disable entirely.** Set `build.sitemap: false` (§14.1.1).
- **Dynamic routes** are listed by their expanded concrete URLs, each dated by **the entry it was generated from** rather than by the template. A route's `sourcePath` is the `[slug]` file that rendered it, and a template is edited far more often than the posts beneath it — so dating by the template made an entire archive announce itself as changed whenever the template moved, which is the opposite of what `<lastmod>` is for. A `resolvePaths` result therefore carries the entry's `_meta` (`parser.md` §9.3) beside its route parameters; `_meta` is reserved, is never a route parameter, and is stripped before URL substitution. A route with no entry behind it — an authored page, or a `$paths` shape describing only parameter values — still uses its own file's modification time, which for those is the right answer.
- **`<loc>` form** follows the canonical URL exactly and is not re-normalized for `build.trailingSlash`, keeping sitemap and canonical URLs in agreement.
- **`robots.txt`.** After the `public/` copy, a `Sitemap: <url>/sitemap.xml` line is appended to `dist/robots.txt` (creating a minimal `robots.txt` if none was provided). An existing `Sitemap:` line is left untouched.

Redirect sources are not pages and never appear in the sitemap.

### 8.5 Structured Data (JSON-LD)

> **Status: Implemented.** A head entry's `textContent` may be an object; the compiler serializes
> it to JSON inside the tag, and template strings **inside** the object resolve against the same
> scope as everywhere else — a structured-data block that cannot reference the page it describes
> would not be much use. The interpreting runtime serializes it identically, so a dev preview and a
> built page agree.

Pages may include JSON-LD for rich search results:

```json
{
  "$head": [
    {
      "tagName": "script",
      "type": "application/ld+json",
      "textContent": {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": "${state.post.data.title}",
        "datePublished": "${state.post.data.pubDate}",
        "author": {
          "@type": "Person",
          "name": "${state.post.data.author.data.name}"
        }
      }
    }
  ]
}
```

The compiler serializes the `textContent` object to a JSON string within the `<script>` tag, resolving template expressions first.

### 8.6 Studio SEO Panel

> **Status: Implemented.** The previews live in a **modal**, `Search appearance`, rather than an
> inspector tab: they describe the document rather than a selection, and a rendered SERP row is a
> picture you study at width, not a field you fill in beside four others. They began as a
> disclosure inside the Document Header card and outgrew it — the card's job is the handful of
> values you type while writing.

**The preview shows the MERGED `$head`** (§8.3), not the page's own entries — a page appends to the
site's head rather than replacing it, so a preview of the page's half would misreport every title
that inherits. Values the page did not author are marked as inherited, naming the donor, in the same
provenance vocabulary the inspector uses for style and props.

**There is no score.** Counters and named warnings only. A number out of 100 invites optimising the
number, and the number is not the thing.

**Two doors and a command.** The surface is opened by `document.openSeo` — a document-level command
in the palette, with an `aiTool` projection — and projected onto two buttons: one at the foot of the
Document Header card, one beside the Page panel's `Page` heading. Neither surface owns it. Two
buttons because they are two moments: while writing the page, and while working on its head
material.

For any page or content entry it shows:

- **Title preview:** Shows how the title will appear in Google search results (truncated to ~60 chars)
- **Description preview:** Shows the meta description (truncated to ~155 chars)
- **OG preview:** Renders a social media card preview (Facebook/Twitter)
- **Schema.org editor:** Form-based JSON-LD editor for structured data
- **Warnings:** Missing title, missing description, description too long, missing OG image

The editable fields sit **below** the previews and the warnings, grouped by the preview each group
feeds — `Search result` (description, viewport, icon) and `Social card` (the Open Graph four).
Ungrouped they collide: Open Graph carries its own `Title`, `Description` and `Image`, so one flat
column gave `Description` two meanings. Every field commits live, and the previews redraw with it.

### 8.7 Bare Specifiers in `$head` and `$elements`

> **Status: Implemented.** `rewriteNpmAsset` in `site-build.ts`; the copy step runs beside sidecar
> bundling. Resolution runs on all three `$head` levels and both `$elements` levels — see "Every
> level" below, which is a correction rather than an addition — package subpaths resolve through an
> import-map prefix key, and an npm `$elements` set is bundled as one self-contained module.

A `$head` entry may name a file inside an installed package by bare specifier rather than by URL —
`"@shoelace-style/shoelace/dist/themes/light.css"`. The build **resolves it against the project
root and copies the file into `/assets/`** under a flattened, hash-free name derived from the
specifier: `/assets/shoelace-style-shoelace-dist-themes-light.css`. The extension is preserved,
because both the browser and the host dispatch on it.

`$elements` entries name modules rather than files, so they are **bundled** through the same path a
Function-def `$src` takes (`spec.md` §12) and land at the same kind of URL. Bundling rather than
copying is what makes the package's own bare imports resolvable: the emitted import map carries two
entries, and a component package imports far more than that.

**Every level, not just the project's.** Both keys are legal on the project, on a layout and on a
page, and resolution applies wherever they are written. This is stated because it did not hold: the
`$head` pass ran over `projectConfig.$head` alone and the `$elements` pass read the layout alone, so
the identical declaration written on a **page** was silently skipped — its stylesheet shipped as a
bare specifier the browser resolved against the page URL, and its component modules were never
imported at all. The page rendered unknown elements with nothing in the build log, because a
dropped entry produced no output to be wrong.

**A page whose only components come from npm still gets an import map.** The map is what makes the
two external runtime modules resolvable, and it was emitted only alongside Jx component scripts —
so a page with npm elements and no Jx components got modules that immediately failed on
`Failed to resolve module specifier "lit-html"`.

Copies and bundles share one output directory, so they share one namespace. Two different files
that flatten to the same name is a **build error** naming both, never a last-writer-wins overwrite.

**A package subpath resolves through a prefix key.** A `$src` sidecar may import a _subpath_ of a
runtime module — `lit-html/directives/class-map.js` — and a package-name external covers the
package's subpaths as well, so the specifier survives into the bundle. The import map therefore
carries a `/`-suffixed prefix entry beside each exact one (`"lit-html/": "/assets/lit-html/"`), and
the build writes the subpaths it finds referenced in the emitted assets. The set is **discovered
from the output**, never enumerated: which subpaths exist is a property of the third-party code a
page happens to use.

**The subpath is bundled; only the core is external.** That the package-name external covers
subpaths is what makes the specifier survive into a page's bundle, and it is also the trap when the
build comes to satisfy it: listing the package in `external` externalises the subpath ENTRY too, so
the emitted asset is a re-export of the very specifier the prefix key points back at it —
`export * from "lit-html/directives/class-map.js"` served AS
`/assets/lit-html/directives/class-map.js`. A self-referential module has an empty namespace, so
every page using a directive failed on an undefined import while the build reported success. The
externals are therefore decided per import by a hook that can see the **importer**: the entry's own
import resolves and is bundled, and everything reached through it that belongs to a runtime package
stays external.

**The core is reached through a stub, so a page gets one copy.** A package imports its own core by
RELATIVE path from inside itself (`../lit-html.js`), and a bundler keeps an external's specifier
exactly as the source wrote it — a rewritten one is not honoured. The shared copy is therefore
reached by emitting a stub at the place that relative path lands in the OUTPUT tree, re-exporting
the bare specifier the import map already resolves. Two copies of lit on a page is a documented
breakage, not a size regression, and a text assertion about the emitted file cannot tell the two
apart: the guarantee is proved by loading the asset and reading its exports.

Discovery runs to closure rather than once, because bundling one subpath can reveal the next — a
directive importing another directive stays external and is found on the following pass. A graph
deeper than the pass budget is a build error rather than a silent truncation: at that depth the
likelier explanation is a cycle in the scan than a real dependency chain.

**An npm `$elements` set is bundled as ONE self-contained module**, with nothing external. Two
measurements decided this. Bundling each specifier separately against an external framework
produced output that threw before defining anything: Bun's codegen for `export *` from an external
emits a re-export against a namespace it never imports, and a component package re-exporting its
framework is exactly that shape. Inlining per specifier fixes the codegen and gives each component
its own framework copy — seven of them on the demo that motivated this. Bundling the set as one
entry gives one copy, no external and no import map: 190kb against 462kb, and correct instead of
broken.

An unresolvable specifier is a build error too. It was previously rewritten to
`/node_modules/<specifier>`, which the dev server happens to serve and which nothing copies into
`dist/` — so the page worked while it was being written and lost the file on deploy. A missing
dependency now fails the build that would have shipped it.

---

## 9. Media Management

### 9.1 Media Organization

Media files live in two locations:

| Location                            | Purpose                                     | Processing                                                      |
| ----------------------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| `public/`                           | Global static assets (favicon, fonts, PDFs) | Copied verbatim to `dist/`                                      |
| `content/*/images/` (or co-located) | Collection-specific media                   | Optimized at build time; published at `/content/<type>/` (§9.3) |

### 9.2 Image Optimization

The compiler includes a build-time image optimization pipeline powered by [Sharp](https://sharp.pixelplumbing.com/). When enabled, it generates responsive image variants, converts formats, and adds performance attributes automatically.

#### 9.2.1 Configuration

Image optimization is configured in `project.json` under the `images` key. All properties have sensible defaults:

```json
{
  "images": {
    "optimize": true,
    "widths": [320, 640, 960, 1280, 1920],
    "formats": ["webp", "avif"],
    "quality": { "webp": 80, "avif": 65, "jpeg": 80, "png": 80 },
    "sizes": "(max-width: 768px) 100vw, 50vw",
    "lazyLoad": true,
    "picture": true,
    "service": "build"
  }
}
```

| Property        | Type       | Default                                     | Description                                                                                                         |
| --------------- | ---------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `optimize`      | `boolean`  | `true`                                      | Master switch — set to `false` to disable all image processing                                                      |
| `widths`        | `number[]` | `[320, 640, 960, 1280, 1920]`               | Pixel widths for responsive `srcset` variants                                                                       |
| `formats`       | `string[]` | `["webp", "avif"]`                          | Output formats (also supports `"jpeg"`, `"png"`) — `"build"` service only                                           |
| `quality`       | `object`   | `{ webp: 80, avif: 65, jpeg: 80, png: 80 }` | Per-format compression quality (0–100); the `"cloudflare"` service uses the `webp` value as its single quality      |
| `sizes`         | `string`   | `"(max-width: 768px) 100vw, 50vw"`          | Default CSS `sizes` attribute for responsive hints                                                                  |
| `lazyLoad`      | `boolean`  | `true`                                      | Adds `loading="lazy"` and `decoding="async"` to `<img>` tags (§9.2.7) — independent of `optimize`                   |
| `picture`       | `boolean`  | `true`                                      | Wrap a multi-format image in a `<picture>`, one `<source>` per format (§9.2.2)                                      |
| `service`       | `string`   | `"build"`                                   | `"build"` = Sharp at build time; `"cloudflare"` = `/cdn-cgi/image` transform URLs served by Cloudflare (see §9.2.6) |
| `remoteDomains` | `string[]` | `[]`                                        | Hostnames whose remote (https) images get transform srcsets — `"cloudflare"` service only (see §9.2.6)              |

#### 9.2.2 Build-Time Behavior

When `optimize: true`, the compiler processes every `<img>` node during page compilation:

1. **Width filtering** — Only generates variants at widths ≤ the source image's natural width. The original width is always included as a breakpoint.
2. **Format conversion** — Each width × format combination produces an optimized variant via Sharp.
3. **Output path** — Variants are written to `dist/images/_optimized/{stem}-{width}-{hash}.{format}` (e.g., `hero-640-a1b2c3d4.webp`).
4. **Markup** — one of two shapes, decided by how many formats produced variants:
   - **One format** — the `<img>` gains `srcset` (e.g. `hero-320-a1b2.webp 320w, hero-640-a1b2.webp 640w, …`) and `sizes` from config, unless the node already specifies one.
   - **Two or more** — the `<img>` is wrapped in a `<picture>` carrying one `<source type="image/…">` per format, best compression first, and the `<img>` keeps the original `src` with **no** `srcset`. This is not cosmetic: `srcset` alone carries no format information, so a browser that cannot decode AVIF still selects an AVIF candidate from a mixed list and fails to render it. `<source type>` is the only markup that lets it decline. Set `picture: false` to keep the bare `<img>` and accept that.
5. **Dimensions** — `width` and `height` are the original image's intrinsic dimensions (prevents layout shift). Skipped when the author already sets either attribute, and for remote sources or images whose dimensions cannot be read. They are injected even when no variant applies, since layout shift is not conditional on optimization.

Loading attributes are decided separately — see §9.2.7. Up to 4 variants are processed concurrently per image.

#### 9.2.3 Which Images Are Processed

The optimizer processes `<img>` nodes with:

- Static `src` paths (strings, not `${...}` template expressions)
- Local paths (relative or `/`-prefixed) that exist on disk
- Raster formats: `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`, `.tiff`

**Skipped automatically:**

- External URLs (`http://`, `https://`, `//`, `data:`)
- SVGs (`.svg`) and animated GIFs (`.gif`)
- Dynamic `src` containing `${...}` template expressions
- Images with `data-no-optimize` attribute

#### 9.2.4 Per-Image Overrides

Individual `<img>` nodes can override global defaults:

```json
{
  "tagName": "img",
  "attributes": {
    "src": "/images/hero.jpg",
    "alt": "Hero image",
    "sizes": "(max-width: 640px) 80vw, 40vw",
    "fetchpriority": "high",
    "data-no-optimize": true
  }
}
```

- `sizes` — overrides the global `sizes` value for this image
- `loading="eager"` — prevents `loading="lazy"` from being added (for above-the-fold images)
- `fetchpriority="high"` — marks this image as the largest contentful paint: it is fetched at high priority and never lazy-loaded (§9.2.7)
- `data-no-optimize` — skips optimization entirely for this image

#### 9.2.5 Caching

The optimizer caches processed images to avoid redundant re-encoding on subsequent builds:

- **Cache location:** `.cache/images/manifest.json`
- **Cache key:** `{contentHash}:{configHash}` — MD5 of the source file contents combined with MD5 of the optimization config (`widths`, `formats`, `quality`)
- **Invalidation:** A cache entry is invalidated when the source image changes (new content hash), the optimization config changes (new config hash), or the output variant files are missing from `dist/`
- **Persistence:** The cache file survives `dist/` cleanup — only the variant files are regenerated
- **Pruning:** After a build in which every route compiled without errors, entries not resolved during the build are removed and their variant files deleted (files shared with a surviving entry are kept), so a persisted cache — and the `dist/images/_optimized/` copy made from it — only contains images the current build uses

The `.cache/` directory should be added to `.gitignore` but can optionally be committed for CI build speed.

#### 9.2.6 Cloudflare Images Service

Setting `"service": "cloudflare"` replaces the build-time Sharp pipeline with Cloudflare [transform-via-URL](https://developers.cloudflare.com/images/transform-images/transform-via-url/) markup — no code is deployed and no bindings are required, so it works with any adapter as long as the site is served through a Cloudflare zone:

- **No variants are generated at build time** — Sharp is only used to read original image dimensions (for `width`/`height` attributes), and `.cache/images/` / `dist/images/_optimized/` are not used.
- **srcset rewriting** — eligible `<img>` nodes (same skip rules as §9.2.3) get a `srcset` of transform URLs, one per configured width ≤ the original width:
  `/cdn-cgi/image/width=640,quality=80,fit=scale-down,format=auto/images/hero.png?v=<hash8> 640w, ...`
  `format=auto` makes Cloudflare negotiate AVIF/WebP per browser; the single `quality` comes from `quality.webp`. The `v` param is an 8-char content hash for cache busting. The original `src` is left untouched as a fallback.
- **Remote sources** — https URLs whose hostname is in `images.remoteDomains` get the same treatment with the full URL as the transform source (every configured width is emitted since original dimensions are unknown; `fit=scale-down` prevents upscaling). The zone must allow resizing from the remote origin (Images → Transformations → Sources).
- **Zone requirement** — Image Transformations must be enabled for the zone (Cloudflare dashboard → Images → Transformations). The build prints a reminder. These URLs do **not** resolve on `*.pages.dev` / `*.workers.dev` preview hosts — only on the production custom domain; previews fall back to the untouched `src` originals.

#### 9.2.7 Loading Attributes

> **Status: Implemented.** `img-loading.ts`, applied by both halves of `image-transform.ts`.

`loading` and `decoding` are decided **once**, by `images.lazyLoad`, for every `<img>` in the
project — including images the optimizer skipped and images in projects with `optimize: false`.
Declining to generate variants for an image says nothing about when the browser should fetch it.

The compiler adds `loading="lazy"` and `decoding="async"` unless one of three things is true:

| Condition                | Result                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `lazyLoad: false`        | Nothing is added anywhere                                                                                      |
| The author set `loading` | Left exactly as written, `eager` or `lazy`                                                                     |
| `fetchpriority="high"`   | Nothing is added — a high-priority lazy image is a contradiction the browser resolves by ignoring the priority |

A document compiled on its own — outside a project, with no `images` config to read — gets no
loading attributes at all. The setting is the project's, and inventing a default for a document
that never declared one is how the previous behaviour reached the LCP image in the first place.

**The compiler does not guess which image is the LCP.** That depends on the viewport, not the
document, so there is no correct static answer; `fetchpriority="high"` is how the author gives one.
Before this contract the static emitter added `loading="lazy"` to every `<img>` that lacked one —
outside `images.optimize`, outside the pipeline, and therefore to the LCP image as well, which is
the one image on a page that must never be lazy.

### 9.3 Referencing Media

In Jx documents:

```json
{
  "tagName": "img",
  "src": "./content/blog/images/hero.jpg",
  "alt": "A hero image"
}
```

The compiler resolves image `src` paths against the **project root**, not the referring file: root-relative paths (`/…`) resolve into the `public/` directory, and relative paths resolve from the project root (e.g. `./content/blog/images/hero.jpg`).

#### Content-relative media

Content entries are the exception, and they resolve against **themselves**. A markdown entry references media the way any markdown editor expects — relative to the file:

```markdown
![Alt text](./images/diagram.png)
```

```yaml
heroImage: ./images/hero.jpg
```

When the collection is loaded, such a reference is rewritten to the collection's asset mount (§6.1): `content/blog/images/diagram.png` becomes `/content/blog/images/diagram.png`, which the site build copies into `dist/` and the dev server serves from the original file. The result is content that renders both in a markdown editor and on the built site — including collections whose `source` points outside the project, where no project-root path could reach the file at all.

The rewrite is deliberately conservative. A value is remapped only when it:

- appears as an element `src`/`poster`, or in a frontmatter field the collection schema declares `"format": "uri-reference"`;
- is relative — not `/…`, not `scheme:…`, not `#…`, and carries no `${…}` template;
- resolves against the entry's own directory to a **file that exists**, inside the collection directory.

Anything else is left exactly as authored, so existing project-root-relative paths keep their meaning. A relative `src` that resolves to nothing is reported as a warning naming the entry. The raw markdown `body` is never rewritten — it is the round-trip source Studio writes back to disk — and `href` links are out of scope: links between entries are routes, not assets.

#### Editors that open an entry standalone

The rewrite above runs when a **collection** is loaded. An editor that opens a single entry as a document — Studio's canvas does — never triggers it, and would render the authored path against the editor's own document URL instead of the entry's. Such an editor MUST apply the same mapping to whatever it renders, so the preview shows the URL the built site serves. Two rules bound it:

- Map the **render** representation only. The authored relative reference is what round-trips to disk; rewriting the source would break both the markdown-editor property above and serialization.
- Use the same containment math (`assetUrlFor`) and the same eligibility rules, so a preview can never claim a URL the build would not produce.

A browser-hosted editor cannot perform the existence check, so it maps optimistically: a reference to a missing file resolves to its mount URL and 404s there rather than 404ing against the editor's document. Both are broken; the mount URL is the failure the build would also report.

#### Editors whose host does not serve the site URL space

The mapping above assumes the editor's own origin answers a site URL — that `/hero.jpg` reaches `public/hero.jpg` because something on that origin serves the published site. A local editing server is that thing; a multi-tenant editor origin is not, and there a site URL reaches the editor's own application shell instead. Behind a single-page-app fallback it reaches it at **HTTP 200**, so the failure is silent: the image renders broken and nothing is logged.

Such an editor MUST NOT emit site URLs at all. It MUST resolve every authored reference to the **project file** it names and address that file by path, under a base its host serves:

- A content-relative reference resolves against the entry's own directory, which is already a project path — `content/blog/images/hero.jpg`. **The mount detour disappears**: a mount publishes a file at a site URL, and this editor is not using site URLs.
- A site-absolute reference is resolved the way a **build** resolves it — `public/…` first, then a mount's directory — never the way a local editing server does, whose extra project-root lane is a compatibility affordance and not part of this contract. An editor with no filesystem cannot probe, so it must take the build's answer: the preview's job is to agree with the deployed site.
- A reference that names no project file — an absolute URL, a `data:` URI, a template — is left exactly as authored.

An editor that declares this and gives no base has said its site URLs are wrong without saying what is right, and MUST leave every reference untouched rather than invent one.

#### Tools that ask about a reference, rather than render one

A usage count and a rename refactor resolve the same authored references a renderer does, in the opposite direction: given a FILE, which documents name it? That is the same lane math read backwards, and it belongs to the engine that answers the question — not to each host that asks it. A host-side workaround (querying every authored spelling of a file and unioning the answers) can make a COUNT come out right, and cannot make a rewrite come out right at all, because the rewrite happens inside the engine.

So the contract binds the engine, both ways:

- A rooted reference resolves through every lane the host serves, and a match against **any** of them is a usage. Where two lanes both name an existing file the reference is genuinely ambiguous, and a warning shown before a destructive action counts both.
- A rewritten rooted reference is re-emitted through the lanes a **build** publishes, falling back to the project-root lane only for a file no build would publish. A `public/` file must come back as `/hero.jpg`, never `/public/hero.jpg`: the second resolves on a local editing server and 404s on the deployed site, which is the failure mode this section exists to prevent.
- A reference the engine counts but **cannot** write — a content source with a parser and no serializer, a document that fails to parse — is NAMED in the report rather than dropped. A rename that reports success while leaving a reference pointing at a moved file is worse than one that never claimed to fix it, because the claim is what stops the author looking.

Which keys carry a reference is not a fixed list. The document shapes that carry one grow with every extension that defines a media-typed prop, so an engine that enumerates key names is wrong by construction the next time one is added; what it can rely on is that a reference is a string SHAPED like a file, and that precision comes from resolving it and comparing against the file in question.

Only statically referenced files are copied into the build. A `src` computed at runtime belongs in `public/`.

### 9.4 Studio Media Browser

> **Status: Partial.** Upload, browsing, metadata and the referenced-file warning ship. Usage is
> COMPUTED but not browsable — see the list at the end of this section, which contradicted this
> marker for as long as both existed. The full Studio-side contract is `studio.md` §9.3 — this
> section states only what it means for the media on disk.

**A preview resolves in the same space the canvas does.** Panel chrome — a media-picker thumbnail,
the social card in a search-appearance preview — renders in the editor's own document, not the
canvas, so a reference resolved for one and not the other breaks in exactly the places nobody
photographs. The two take different things and must not be confused: a preview of what the AUTHOR
WROTE resolves as §9.3 describes, while a preview of a FILE the browser is listing starts from the
path and asks where that file publishes. `public/hero.jpg` is written `/hero.jpg` — a string that
shares not one segment with it — so a preview built by prefixing a file path with a slash names a
URL the site does not publish.

**Usage is asked about the FILE, once.** A content-relative `./images/` reference previews at its
asset-mount URL while the source keeps the authored form, so a media surface holds at least three
names for one file and could ask under any of them. It asks under the file: §9.3 binds the engine to
resolve every authored spelling, so a host that enumerated the spellings itself would be a second
implementation of that rule — and the half that can fix a count but never a rewrite. Under-counting
is what makes a delete look safe when it is not, so a delete states its reference count, and where
the count cannot be answered it says **unknown**, never zero.

Studio adds media to a project from four places: the Upload button on any image field, a file
dropped on the canvas, a file dropped on the Files tree, and the Library's drop zone — which names
its destination before the drop rather than choosing one for you. All of them write through the same core, which decides:

- **Destination** — a document inside a content collection co-locates its media in `content/<collection>/images/` (§9.1); everything else lands in `public/`. The Files tree and the Manage view name their destination explicitly instead.
- **Reference** — written per §9.3: `public/` contents from the site root (`/hero.jpg`), a content asset relative to its own entry (`./images/hero.jpg`) so the collection loader rewrites it to the asset mount, anything else relative to the project root.
- **Collisions** — an upload never overwrites. A colliding name gains a `-1`, `-2`, … suffix before its extension.

Uploaded images are ordinary project files and go through the build's optimization pipeline (§9.2) exactly like hand-placed ones.

Shipped:

- **Grid/list view** of all media in the project (thumbnail grid as default, table as alternative)
- **Upload** — drag-and-drop or a file picker, on all four surfaces above
- **Preview** — thumbnails for images, in both the picker and the Manage view
- **Metadata** — dimensions and file size, as a row caption in the media picker
  (`files/media-meta.ts`: `1200 × 800 · 84 KB`). Both halves come from work already done — the size
  from the directory listing that built the list, the pixels from the thumbnail once the browser has
  decoded it — so a caption never costs a second download
- **Delete** — the confirmation states the reference count, computed on the authored ref, and says
  **unknown** rather than zero when a lane cannot be counted (`files/file-ops.ts`)
- **Viewing** — clicking a media file in the Files tree or the Library opens it in a tab of its own
  (`studio.md` §4.2's Media mode). It shows the asset at full size — an image, a video or audio with
  controls, a font as a specimen, a PDF embedded — with its kind and dimensions, the site URL a
  document would reference it by, and the list of documents that do. Before it, opening a media file
  was not merely unsupported: it produced an error telling the author to add a format class to
  `project.json`, which is not advice about a PNG.
- **Usage tracking as a surface** — the Media view is that reader. The query already shipped and was
  already correct; what was missing was anywhere to see it outside the delete confirmation, so the
  answer to "which pages use this image?" arrived at the one moment the author had already decided.
  A failed count still reads **unknown**, never zero.

---

## 10. Inheritance Model

This section defines exactly what cascades from site → layout → page → component, and how global vs local scope works.

### 10.1 Cascade Hierarchy

```
project.json
  └── layout.json
        └── page.json
              └── component.json (via $ref or $elements)
```

| Scope Level   | Inherits From          | What Cascades                                                                         |
| ------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| **Component** | Nothing (encapsulated) | Own `state`, own `style`. Receives `$props` explicitly.                               |
| **Page**      | Site + Layout          | Site `state` (read-only), site `$media`, site CSS custom properties, layout structure |
| **Layout**    | Site                   | Site `state`, site `$media`, site CSS custom properties, site `$head`                 |
| **Site**      | Nothing (root)         | Defines global `$media`, global CSS custom properties, global `$head`, global `state` |

### 10.2 What Inherits Automatically

These cascade without explicit import:

1. **CSS Custom Properties** — Defined as `--`-prefixed keys in `project.json` `style`, they are compiled to `:root {}` and cascade through the DOM naturally. Every component can reference `var(--color-primary)` without importing anything.

2. **Named media breakpoints** — `$media` from `project.json` is available in every component's style objects. A component can use `"@--md": { ... }` without knowing where `--md` was defined.

3. **`<head>` entries** — Site-level `$head` entries (fonts, viewport, icons) are included in every page automatically.

4. **Language** — `defaults.lang` from `project.json` sets `<html lang>` on every page.

5. **Global stylesheet rules** — Root-level `style` rules from `project.json` (custom properties compiled to `:root`, element selectors as nested objects) are applied to all pages and cascaded into all rendered contexts including Studio's canvas and stylebook.

### 10.3 Component Scoping

Components are scoped to the site project. When a site context is active:

- Only components in the project's `components/` directory are discoverable
- Explicit `$elements` imports in individual files add to (not replace) the project set
- Components from other projects or global scope do not appear in the palette or autocomplete
- The `imports` map in `project.json` defines project-wide `$prototype` resolutions

This ensures that each site is a self-contained unit — moving between components, pages, and layouts within a project always sees the same component registry.

### 10.4 What Requires Explicit Access

These require deliberate reference:

1. **Site state** — Available in pages/layouts as `$site.state.foo`, not as bare `state.foo`. This prevents naming collisions and makes the data source clear.

2. **Data files** — Static data from `data/` must be explicitly loaded via `$ref`:

   ```json
   {
     "state": {
       "nav": { "$ref": "../data/navigation.json" }
     }
   }
   ```

3. **Content collections** — Collection data requires explicit `$prototype: "ContentCollection"` or `$prototype: "ContentEntry"` declarations.

4. **Cross-component state** — Components receive external data only through `$props`. No implicit scope leaking.

### 10.6 Studio Runtime Behavior

Studio must fully enforce the site-based paradigm at edit time, not just build time. When a site project is open:

- **Canvas rendering** applies the site's global styles (`project.json` `style`) and CSS custom properties so every file preview is accurate
- **Media breakpoint tabs** reflect the site's `$media` definitions, not the individual file's — ensuring consistent responsive editing across all project files
- **Component palette** is scoped to the project (§10.3)
- **Stylebook mode** applies site-level design tokens when rendering element and component previews
- **Navigation between files** (components, pages, layouts) preserves the site context — opening a component file does not lose the site's media, styles, or component registry

Individual file `$media`, `$style`, and `$elements` merge on top of site-level definitions (file takes precedence on conflict), matching the cascade behavior at build time.

### 10.7 CSS Cascade

The global stylesheet is emitted in this order:

1. Site-level `:root` custom properties (from `--`-prefixed keys in `style`) and `body` direct
   properties
2. Site-level conditional (`@--dark`, `@--md`, etc.) overrides — custom properties on `:root`,
   direct properties on `body`; scheme-query blocks dual-emitted as a media-guarded copy plus a
   forced `data-color-scheme` copy (spec §9.5)
3. The `color-scheme` declaration triplet, when a scheme query is declared
4. Layout-level styles
5. Page-level styles
6. Component-level styles (scoped by tag-name prefix and generated `.<tagName>-<n>` classes — there is no shadow DOM; `spec.md` §16.6)

This follows the natural CSS cascade — more specific sources override less specific ones, and
base rules always precede their conditional overrides so equal-specificity variants win by
source order. When a scheme query is declared, the pre-paint scheme-restore `<script>` is
injected into the merged `<head>` immediately after the charset/viewport defaults — ahead of
every style block.

---

## 11. Redirect & Rewrite Management

> **Standards note:** Redirect pattern strings use [URLPattern pathname syntax](https://urlpattern.spec.whatwg.org/#pattern-strings) (`:param` named groups, `*` wildcards). Patterns are passed through to the `_redirects` file verbatim — the compiler does not validate them.

### 11.1 Static Redirects

Defined in `project.json`:

```json
{
  "redirects": {
    "/old-page": "/new-page",
    "/blog/:slug": "/posts/:slug",
    "/legacy/*": { "destination": "/archive/*", "status": 301 }
  }
}
```

The compiler emits two outputs:

- **HTML meta-refresh pages** — a literal (pattern-free) source compiles to an HTML file with a `<meta http-equiv="refresh">` tag, **for the statuses that have an HTML equivalent** (§11.3). A literal source that collides with a compiled page logs a build **warning** (the redirect file overwrites the page — remove one or the other).
- **`_redirects` file** — every rule (literal and pattern) is written to `dist/_redirects` in the Netlify/Cloudflare format. Sources containing `:param` or `*` cannot be expressed as static HTML, so they appear **only** here, for platforms that process it.

No `vercel.json` or other platform-specific redirect map is generated.

### 11.2 Dynamic Parameters

Redirect rules support `:param` and `*` wildcard syntax:

```json
{
  "/blog/:year/:slug": "/posts/:slug",
  "/docs/v1/*": "/docs/v2/*"
}
```

### 11.3 Status Codes and Rewrites

A rule is either a **redirect**, carrying an RFC 9110 §15.4 redirection status, or a **rewrite**,
which is a different thing wearing a status code's clothes.

```json
{
  "/moved-permanently": { "destination": "/new-location", "status": 301 },
  "/temporary-redirect": { "destination": "/other-page", "status": 302 },
  "/method-preserving": { "destination": "/new-endpoint", "status": 308 },
  "/api/*": { "destination": "https://api.example.com/*", "rewrite": true }
}
```

A bare string is a 301. An unrecognised status is a **build error naming the rule**, not a value
written through to the host.

| Status | Means                           | HTML fallback                                      |
| ------ | ------------------------------- | -------------------------------------------------- |
| `301`  | Permanent                       | yes, with `<link rel="canonical">`                 |
| `302`  | Temporary                       | yes, with `<meta name="robots" content="noindex">` |
| `303`  | See other, with GET             | yes, with `noindex`                                |
| `307`  | Temporary, **method preserved** | **no**                                             |
| `308`  | Permanent, **method preserved** | **no**                                             |

**Why the fallback is not universal.** An HTML meta-refresh is a _client-side_ redirect: the browser
fetches the source, then navigates. That is a fair stand-in for a 301 on a host that ignores
`_redirects`, and a misrepresentation of a 307 or 308, which exist precisely to preserve the request
method and body — a meta-refresh silently converts a POST into a GET. A canonical link is likewise
correct only for 301: on a temporary redirect it asserts the permanence the status denies, so 302
and 303 get `noindex` instead.

**A rewrite is not status 200.** It serves the destination's content _at_ the source URL, with no
redirect at all; the `200` that reaches `_redirects` is the host's convention for saying so. It is
written `{ "destination": …, "rewrite": true }`, and it gets **no** HTML file — a file at the source
URL shadows the rewrite on hosts that honour `_redirects` and turns it into a redirect on the hosts
that do not, which is wrong in both directions.

### 11.4 Studio Redirect Editor

> **Status: Implemented.** Redirects are edited as a `GridSource`, so they get the same table,
> the same undo and the same import path as any other tabular data.

Three validations run over the rule set, each reporting as a Problem naming the rule, because none
of them is visible by reading the file:

- **Chains** — a redirect whose target is itself a redirect, costing a second round trip.
- **Loops** — a cycle, which is a broken page rather than a slow one.
- **Shadows** — a rule for a path a real route already serves, which is dead configuration the
  author will never find by inspection.

Studio provides redirect management as a document:

- Table of all redirects with source, destination, and status columns
- Add/edit/delete with inline editing
- Validation: warns about redirect chains, loops, and conflicts with existing pages
- Import: paste from `_redirects` format or CSV

---

## 12. Multi-Page Compilation

The compiler currently processes one document at a time. Site-level builds require orchestrating compilation across all pages.

### 12.1 Build Pipeline

```
project.json
    ↓
Discover pages/         → route table
Discover content/       → content index
Resolve $paths          → expand dynamic routes
    ↓
Compile components/     → element modules + CSS
Collect server entries  → from componentDefs (if adapter set)
    ↓
For each route:
    Load page.json
    Resolve $layout     → wrap in layout
    Resolve $head       → merge site + layout + page heads
    Resolve state       → inject content entries, site state
    Transform images    → generate responsive variants, inject srcset/sizes
                          (images.service "cloudflare": no variants — srcset
                           uses /cdn-cgi/image transform URLs)
    Compile             → existing compiler routes (static/dynamic/custom-element)
    ↓
Bundle server entries   → dist/worker.js, or dist/_worker.js + _routes.json for
                          cloudflare-pages (if adapter set, else per-route _server.js).
                          The worker is bundled SELF-CONTAINED per adapter (compiler.md
                          §12): hono, extension mounts, connectors, and user server
                          modules are inlined — dist deploys without node_modules.
                          Cloudflare resolves with workerd/worker conditions and keeps
                          cloudflare:*/node:* external (nodejs_compat); node/bun bundle
                          platform-native.
    ↓
Bundle client sidecars  → dist/assets/<slug>.js — one self-contained ESM bundle per
                          bundleable Function `$src` specifier (npm:…, ./relative;
                          spec.md §5.3) collected from pages, components, islands,
                          and lowered-def $bundle hints (extensions.md §8.3).
                          Backend: Bun.build under Bun, esbuild under Node.
    ↓
Extension emit          → section-owner classes with an `emit` capability write
                          derived assets (search indexes, feeds) via the host
                          (extensions.md §8.4); shadowed by same-named public/ files
    ↓
Copy mounted assets     → files the compiled HTML/CSS reference under an extension
                          asset mount (extensions.md §8.5), copied to their URL path;
                          unreferenced siblings and entry files stay out of dist/
    ↓
Emit dist/
    ├── index.html
    ├── about/index.html
    ├── blog/hello-world/index.html
    ├── assets/
    │   └── jxsuite-search-client.js    (bundled $src sidecars)
    ├── components/
    │   ├── site-header.js
    │   └── site-header.css
    ├── content/
    │   └── blog/images/hero.jpg        (referenced collection media)
    ├── images/
    │   └── _optimized/         (responsive image variants)
    ├── sitemap.xml
    └── _redirects
dist/worker.js              (inside dist/, if adapter set)
```

### 12.2 Build Commands

```bash
# Development
jx dev                   # Build, then serve with live reload (rebuilds before each reload)

# Production build
jx build                 # Full static site build

# Preview production build
jx preview               # Serve an already-built dist/ (default port 4173)

# Tooling
jx schema                # Generate project.schema.json + document.schema.json from extensions
jx validate              # Validate project.json against its generated schema
jx db push               # Sync the data section's tables to their connections (additive-only)
```

`jx build`, `jx preview`, `jx schema`, `jx validate`, and `jx db push` run inside the `jx` CLI itself (`@jxsuite/compiler`). `jx dev` resolves the project's `@jxsuite/server/dev` entry and spawns it under **Bun** — the dev server builds the site up front, serves the built pages from `dist/` ahead of the static-source fallback, and rebuilds before each live-reload broadcast so the browser always reloads into fresh output. It requires `@jxsuite/server` in the project's dependencies and Bun on the PATH. `jx preview` is a plain static file server over `dist/`. Both accept `--port` (defaults: 3000 for dev, 4173 for preview).

### 12.3 Incremental Builds

> **Status: Pending.** No dependency graph exists. `jx build` and the dev server's pre-reload
> rebuild are both FULL builds, so the paragraph below describes an intended design rather than
> shipped behaviour. It is fast enough that nothing has forced the issue yet; the cost is that it
> scales with the project rather than with the edit.

The build system tracks dependencies between files. When a content entry changes, only pages that reference that collection are recompiled. When a layout changes, all pages using that layout are recompiled. When `project.json` changes, everything is recompiled.

### 12.4 Asset Pipeline

Static assets are emitted per component, with page styles inlined:

- **CSS:** Page and layout styles are inlined into each page's `<style>` block, and so is the CSS of every light-DOM component the page uses — appended after the page block, so the cascade matches the `<link>` order it replaces (compiler.md §8.2). Each compiled component still ships its own `dist/components/<tag>.css` for anything that references it directly. A shadow-mode component's sheet is linked from inside its declarative shadow root instead
- **JS:** Each interactive component ships its own module (`dist/components/<tag>.js`), loaded via `<script type="module">` only by pages that use it; fully static components ship no script. A page "uses" a component when its tag appears in the prerendered HTML **or** in one of the page's island modules — an island builds its markup in the browser, so a component it renders needs its module even when the component is fully static, because no prerendered markup exists for that instance
- **Preload hints:** A page emits `<link rel="modulepreload">` in `<head>` for every component module it loads and every client-runtime asset its import map names. An import map declares where a bare specifier lives; it does not ask for it. Without the hints `/assets/vue-reactivity.js` is discovered only after a component module has been fetched **and parsed** — a three-deep request chain on the critical path, where every hop is a round trip. The hints name only what **this** page loads, never the build-wide set, and never a module reached through a dynamic `import()` (spec.md §5.3 `$lazy`), which by definition is not part of the first visit
- **Images:** Optimized variants are written to `dist/images/_optimized/` with content-hash-suffixed filenames for caching
- **Fonts:** Copied verbatim from `public/`

---

## 13. Internationalization

> **Status: Partial.** §13.1–§13.5 and §13.7 ship: tags are validated and canonicalized, a route's
> prefix decides its locale, a `{locale}` collection source expands over the declared locales, each
> page carries the `lang` and `dir` that follow, and translations advertise one another in `<head>`
> and in the sitemap. §13.6 is the only part that is not whole, and it is bounded rather than
> unbuilt: a site with `build.adapter` set negotiates `Accept-Language`, and adapter-less static
> output has no request to negotiate against.
>
> This marker previously said negotiation was absent and `{locale}` collections unread. Both had
> shipped — §13.6 and §13.3 each said so — so the parent contradicted two of its own subsections.
> A summary marker that restates what its children already record is a second source of truth, and
> this one drifted; it now names the boundary and defers the rest to the sections that own it.
>
> **Jx is not a translation system**, and this section will not become one. There is no message
> catalogue, no `t()` and no fallback chain. A locale is a property of a _route_; what the route
> serves is whatever the author put in that directory.
>
> That decision is recorded here and nowhere else, deliberately. Unicode MessageFormat 2.0 is the
> format a reversal would adopt — it is stable in CLDR and it is what `Intl.MessageFormat` will be
> when TC39 finishes with it — but it is part of UTS #35, which this specification already cites
> as `Borrowed` (§16), and a standard may not be cited in one place and rejected in another
> (`standards.md` §8). So there is no row to write: the decision lives in this paragraph, and
> reversing it means designing the section that would own it first.

### 13.1 Locale-Based Routing

For multi-language sites, pages are organized by locale prefix:

```
pages/
├── en/
│   ├── index.json         # → /en/
│   ├── about.json         # → /en/about
│   └── blog/
│       └── [slug].json    # → /en/blog/:slug
├── fr/
│   ├── index.json         # → /fr/
│   ├── about.json         # → /fr/about
│   └── blog/
│       └── [slug].json    # → /fr/blog/:slug
└── index.json             # → / (redirect to default locale)
```

### 13.2 Configuration

```json
{
  "i18n": {
    "defaultLocale": "en",
    "locales": ["en", "fr", "de"],
    "routing": "prefix-except-default"
  }
}
```

`"prefix-except-default"` means:

- `/about` → English (default, no prefix)
- `/fr/about` → French
- `/de/about` → German

**Tags are BCP 47 and a malformed one is a build error.** `en_US`, `en--US` and `e` are rejected by
the RFC 5646 grammar; `EN-us` is accepted and canonicalized to `en-US`. That case matters, because
the same tag is compared as a string in a route table, written into `<html lang>` and later into an
`hreflang` attribute — so there is one spelling of it, applied everywhere.

The check is **well-formedness, not registry membership**: `zz` and `xx-YY` are well-formed tags for
languages that do not exist, and Jx does not ship a copy of the IANA registry to say otherwise.

**Matching is on the first path segment, compared canonically.** A project declaring `fr-ca` is
served from `pages/fr-ca/`; `pages/fr/` does **not** match it. Silently that would be invisible —
every page under it would become the default locale and claim the wrong language — so a directory
naming the _primary language_ of a declared locale is a build warning that names both spellings.
The warning is scoped that narrowly on purpose: any two-to-eight-letter segment is a well-formed
language tag, so warning on "looks like a tag" would fire on `/docs/` and `/api/`.

A `defaultLocale` absent from `locales` joins the list rather than being rejected — the pages under
it exist either way, and no reading of that config is the one the author meant.

**Studio edits this block through `studio.md` §20.5**, and resolves it with this section's own
resolver rather than a second implementation of it — which is why the resolver lives in
`@jxsuite/schema/locale`, reachable from a package that cannot import the compiler.

**`prefix-always` is checked.** The mode is a promise that every URL names its language, and a page
outside the locale tree breaks it silently: it builds, it serves, and `localeOfRoute` calls it the
default locale — so a site that declared "no unprefixed URLs" ships them anyway, and the only reader
who finds out is a visitor who lands on one and sees the wrong language with no way to switch. The
build now names every such route, once, with the whole list.

It is a warning rather than an error, because the author may mean it — a landing page with no
translations, a machine-readable endpoint — and failing a build over a page that works would be the
compiler overruling a decision it cannot see the reason for. `/` is never reported: under
`prefix-always` the site root is the one URL that exists to send a visitor somewhere else, and
§13.6 is what it is for.

### 13.3 Content Localization

Content collections can be organized by locale:

```
content/
├── blog/
│   ├── en/
│   │   ├── hello-world.md
│   │   └── second-post.md
│   └── fr/
│       ├── bonjour-monde.md
│       └── deuxieme-article.md
```

The collection config can specify locale awareness:

```json
{
  "blog": {
    "source": "./blog/{locale}/",
    "schema": { "...": "..." }
  }
}
```

> **Status: Implemented.** `extensions/parser/src/content-loader.ts` expands `{locale}` over the
> declared locales, stamps each entry with the locale its directory named, and scopes route
> expansion to it.

**One content type, N directories — not N content types.** That distinction is what keeps a
translated post the same post: it keeps one schema, one set of relationship targets, and one name in
`$paths`, and differs only in which directory it was read from.

Each entry carries the locale it was loaded for in `_meta.locale`, and that is load-bearing rather
than informational. **Two translations of one post share an id** — `blog/en/hello.md` and
`blog/fr/hello.md` are both `hello` — so a `[slug]` route expanding the whole collection would emit
each URL twice and let the second overwrite the first. The route's own locale prefix scopes the
expansion, so `/fr/blog/:slug` expands the French entries and no others. A collection whose entries
carry no locale is untouched by this, whatever the route's locale happens to be.

**A `ContentEntry` lookup is scoped the same way.** Two translations share an id, so an unscoped
lookup answers with whichever language loaded first: under `/fr-ca/…` that is the English copy,
rendered on a page whose `<html lang>` and every `hreflang` say French. The route carries the locale
it serves and the lookup reads it, exactly as route expansion does. A collection whose entries carry
no locale is untouched — it is not in one language, and filtering it by the route's would empty it.

**The directory is matched case-insensitively.** Two writers name it: an author who declared `fr-CA`
most likely typed `fr-CA/`, while Studio creates the lowercase form, because a locale directory
becomes a URL segment and the site's own URLs are lowercase. Reading one spelling only would make a
translation somebody just created invisible to the build — the directory there, the entries there,
and the collection loading none of them, with nothing to report. The canonical spelling wins where
both exist, and a locale nobody has written yet reports against the tag that was declared.

Asset mounts expand with the source: each locale directory publishes at `/content/<type>/<locale>`,
so a French post's `./hero.png` and its English translation's cannot collide at one URL.

A `{locale}` source in a project that declares no `i18n` locales loads nothing, with a warning
naming the reason — there is no list to expand over, and reading the path literally is what made the
old behavior invisible.

### 13.4 Language and Direction on the Page

> **Status: Implemented.** `i18n.ts` and `locale.ts`, applied through `injectHead` and
> `injectContext`.

Every page carries the language its route implies:

| The page has             | `<html lang>` is           |
| ------------------------ | -------------------------- |
| its own `$lang`          | that tag                   |
| a declared locale prefix | that locale, canonicalized |
| neither                  | `defaults.lang`, else `en` |

An explicit `$lang` wins over the route because a page really can be a French translation living at
`/en/a-propos/`, and an author who writes that down means it. Note what §13.4 does **not** claim:
`prefix-always` is accepted and canonicalized by §13.2, but nothing enforces it — a page outside the
locale tree still builds and is served as the default locale. Enforcement belongs with the routing
work in §13.2, not here.

**`dir` is derived, and only appears when it is not the default.** The direction comes from the
_script_, obtained by maximizing the tag through CLDR likely-subtags (UTS #35) and testing it
against the ISO 15924 right-to-left set (UAX #9). It is deliberately not `Intl.Locale`'s own
`getTextInfo()`, which answers from the language's CLDR entry and gets two ordinary cases wrong:
`dv` (Dhivehi, written in Thaana) where an ICU build lacks its data, and `az-Arab` — Azerbaijani
deliberately written in the Arabic script — because that language's default script is Latin. Both
are right-to-left.

`dir="ltr"` is never written. It is HTML's default for every element, so emitting it on every page
of a left-to-right site is noise that carries no information. An explicit `$dir` or `defaults.dir`
is emitted verbatim, including `auto`.

**The locale is readable from a template** as `$page.locale`, with `$page.dir` beside it, and the
project's list as `$site.locales` / `$site.defaultLocale`. It lives on `$page` rather than as a
top-level `$locale` because that is what it is — a property of the route, not a third ambient
namespace beside `$site` and `$page` — and because `$page.locale` is the _resolved_ answer, after a
document's own `$lang` has had its say, rather than the prefix.

### 13.5 Alternate Discovery

> **Status: Implemented.** `localeAlternates()` in `i18n.ts`, emitted through `mergeHead` and
> `generateSitemap`.

A translated site that does not say so is three unrelated sites to anything but a reader. Each page
in a translation set therefore advertises the whole set, in `<head>`:

```html
<link href="https://example.com/about/" hreflang="en" rel="alternate" />
<link href="https://example.com/fr-ca/about/" hreflang="fr-CA" rel="alternate" />
<link href="https://example.com/about/" hreflang="x-default" rel="alternate" />
```

and again as `xhtml:link` inside the page's `<url>` entry in `sitemap.xml`, under a
`xmlns:xhtml` declaration the document carries only when some entry uses it.

**A translation set is a directory layout, unless a page says otherwise.** Two routes are
translations when they share a path with the locale prefix removed: `/fr-ca/about/` and `/about/`
share `about`. That derivation is right whenever the paths are parallel, and it is the whole mapping
for most sites.

A **localized slug** is the case it cannot reach. `/fr-ca/a-propos/` shares nothing with `/about/`,
and translating a URL is ordinary practice rather than an edge case — the words in a path are read
by the same person who reads the page. A document therefore declares its own identity:

```json
{ "$translationKey": "about", "title": "À propos" }
```

at `pages/fr-ca/a-propos.json`. `$translationKey` overrides the derived key exactly as `$lang`
overrides the derived locale (§13.4), and it is the **only** new key this needs: the grouping is
already keyed, so `hreflang`, `x-default`, the sitemap and `$page.alternates` all follow from it
with nothing else changed. Leading and trailing slashes are trimmed, so the key can be written the
way the URL reads.

It is read in a **pre-pass**, before the first page compiles, because a page's alternates depend on
the whole route table — a document cannot tell the build what its key is while it is being
compiled. Pages that do not mention the key are not parsed twice for it.

**Two routes claiming one language is a contradiction, and the build says so.** A set names one URL
per language, so one of the two is dropped from it either way. What differs is whether the author
asserted it:

- **Declared on both** — a build error. `$translationKey` is a promise written down twice, and
  silently advertising one of the two URLs as _the_ page in that language is a wrong answer nobody
  downstream can detect.
- **Derived** — a warning. Parallel paths that happen to meet (`pages/about.json` beside
  `pages/en/about.json` under `prefix-except-default`) may be a deliberate alias, and failing a
  build over pages that work would be the compiler overruling a decision it cannot see.

A `$paths` template that declares a key is the declared case by construction: every route it expands
to claims the same one, and the error names them.

**A key may name its route's own parameters**, written `${slug}`, and that is what makes a
collection's localized URLs work. One `[slug]` template expands to one route per entry, so a fixed
key would claim a single identity for the whole collection — every entry the translation of every
other, which the duplicate rule above reports rather than serves. `pages/fr-ca/expositions/[slug].json`
declaring `"exhibitions/${slug}"` pairs each French post with the English one, because two
translations of an entry share an id (§13.3) and the id is what the parameter carries.

A parameter with no value is left as written rather than blanked, so the duplicate it produces is
reported against a key that still says `${slug}` — which names what is wrong instead of describing
a collection that collapsed.

Four rules follow from what the annotation means rather than from convenience:

- **Every member lists every member, itself included.** That reciprocity is the specified
  behaviour and the thing validators check for.
- **A page with no translations gets nothing.** A lone `hreflang` pointing at itself is noise; the
  annotation describes a set.
- **`x-default` names the default locale's URL**, and is omitted when the set has no default-locale
  member — inventing one would advertise a URL that does not exist.
- **A duplicate locale within a set is dropped rather than emitted twice.** Two routes claiming one
  translation is a contradiction, and a single-valued annotation is the better failure.

An author-supplied alternate for the same `hreflang` wins, like every other auto-injected entry
(§8.4). This whole section depends on the §8.3 dedup key: these links share `rel="alternate"` and
differ only in `hreflang`, and `x-default` conventionally shares its `href` with the default
locale's entry, so a key of `rel` + `href` alone collapsed the set into one link.

**The same set is readable from the page**, as `$page.alternates`: an array of
`{ code, label, url, dir, current }`, ordered by tag, which maps straight into a language switcher
through the ordinary `{"$prototype": "Array"}` form. A switcher is the one part of a multilingual site the
framework cannot write for the author, and without this the only way to build one is a hardcoded
list of URLs — which goes stale the moment a page gains or loses a translation, silently, in the
one place a reader would have used it.

Three differences from the `<head>` annotation above, each following from who reads it:

- **URLs are site-absolute, not absolute.** A switcher is an internal link, and it has to work in a
  project that has not configured `url` yet — which is every project in development. The `<head>`
  form must be absolute because a crawler may have arrived at the page by any URL.
- **A page with no translations gets itself**, where `<head>` gets nothing. A lone `hreflang`
  pointing at itself is noise to a crawler; a template asking "which languages is this page in"
  wants the honest answer, and dropping the page itself would leave a switcher unable to mark where
  the reader is.
- **`x-default` is absent.** It names no language a reader could choose.

`current` marks the member this route **is**, taken from the route rather than from `$page.locale`,
because a document whose `$lang` disagrees with its directory (§13.4) is still served from that
directory.

`label` is the locale's **autonym** — its name in its own language, from CLDR — because that is what
a reader scans a switcher for: a menu reading "French" is unreadable to exactly the person it exists
for. It is resolved into the array rather than left to `Intl/displayName` (§13.7) because a switcher
is a mapped array, and a map template interpolates scope values rather than evaluating expressions;
without the field the only label available is one the author typed, which is the hand-kept table
CLDR exists to replace.

Both readings are derived from one grouping, so they cannot come to disagree about which pages are
translations of one another — a disagreement that would otherwise be invisible, because only a
machine ever reads one of them.

**Negotiation is not this.** Discovery tells a crawler the set exists; §13.6 is what sends a
visitor to their own language.

### 13.6 Locale Negotiation

> **Status: Partial.** `locale-negotiation.ts` implements RFC 4647 Lookup and emits it into the
> generated worker, so a site with `build.adapter` set negotiates. Adapter-less static output
> cannot, permanently — see below.

**Which deployments can negotiate, and which cannot.** Negotiation needs a request, and adapter-less
static output has no runtime that sees one: `dist/` is files, and the preview server is a pure file
mapper. That is a property of the output shape, not missing work, and it is stated here rather than
tracked as a gap so nobody sets out to close it. A site with `build.adapter` set gets a generated
worker, the worker sees the request, and negotiation runs there.

**A static `prefix-always` site is told about its root.** The two facts above compose into one
deployment that is simply broken: `prefix-always` puts every page under a locale, negotiation is
what answers `/`, and an adapter-less build has no runtime to negotiate with — so the site's front
door is a 404 and nothing else in the build says so. The `prefix-always` check in §13.2 deliberately
never reports `/`, because under an adapter it is handled; this is the one shape where it is not, so
the build names it, once, with the locale a visitor would have been sent to.

A warning and not a generated redirect. Which URL the root should serve is a deployment decision —
a redirect, a language-choice page, a rewrite at the CDN — and emitting one would be the compiler
overruling a choice it cannot see the reason for.

**The bare `/` only.** A visitor who asked for `/fr/about/` has expressed a preference far stronger
than a header, and overriding it would make a shared link mean different things to different people.
Under `prefix-except-default` the default locale owns `/`, so a negotiation landing there continues
down the ordinary chain rather than redirecting to itself; under `prefix-always` nothing lives at
`/` and the redirect is what makes the root work at all. The implementation is middleware for
exactly that reason: one of its two outcomes is "carry on".

**The algorithm is RFC 4647 Lookup, not Filtering.** Filtering returns every matching tag, which is
right for a content-negotiation menu and wrong for "which page do I send this person to". Lookup
truncates progressively — `de-CH-1901`, then `de-CH`, then `de` — dropping a single-character
subtag together with the one before it, since a lone `u` or `x` is an extension singleton and never
a tag. Ranges are ordered by RFC 9110 §12.5.4 quality; `q=0` is a **refusal** and the range is
dropped rather than ranked last. `*` selects the site's own default. The answer is always one of
the declared locales.

**`Vary: Accept-Language` is emitted on every `/` response**, redirect or not, and it is not
optional. Without it any cache in front of the site stores the first visitor's answer and serves it
to everyone — a site stuck in one language for every later reader, and invisible to the author,
whose own browser was that first visitor. The redirect is **302**: its target depends on the
request, so a permanent status would let a cache pin one reader's language for all of them. A
`Content-Language` names the choice that was made.

**Never from an IP address.** Where someone is has never been what they read.

---

### 13.7 Formatting Numbers, Dates and Text

> **Status: Implemented.**

A document formats through **blessed `Intl` helpers**, listed once in `packages/schema/src/intl.ts`
and read by the runtime interpreter, the compiler's emitter and the `call` operator's JSON-Schema
description. The list lived in those places separately before, and the schema description — a prose
sentence naming three helpers, checked by nothing — is what made a single source necessary.

| Helper                    | Wraps                     | For                                                  |
| ------------------------- | ------------------------- | ---------------------------------------------------- |
| `Intl/formatNumber`       | `Intl.NumberFormat`       | grouping, decimals, currency, percent, units         |
| `Intl/formatDate`         | `Intl.DateTimeFormat`     | dates and times                                      |
| `Intl/formatRelativeTime` | `Intl.RelativeTimeFormat` | "3 days ago"                                         |
| `Intl/formatList`         | `Intl.ListFormat`         | "a, b, and c", rather than a hand-written comma join |
| `Intl/plural`             | `Intl.PluralRules`        | which plural form a number takes                     |
| `Intl/compare`            | `Intl.Collator`           | sorting strings                                      |
| `Intl/displayName`        | `Intl.DisplayNames`       | the name of a language, region, script or currency   |
| `Intl/segment`            | `Intl.Segmenter`          | graphemes, words and sentences                       |

**They are helpers because ECMA-402's formatters are constructors.** `new` is not in the expression
grammar and should not be; each helper wraps construct-then-format, which is the shape an author
wants anyway.

**A helper that is given no locale uses the page's own**, and `Intl/formatDate` with no `timeZone`
uses `UTC`. Never the host's, in either case. `new Intl.NumberFormat(undefined)` reads the build
machine's locale, so the same document emits `1,234.5` on one machine and `1.234,5` on another and a
site's output stops being a function of its input. The time zone is the worse of the two: a locale
changes how a date reads, a zone can change **which day it is** — `2026-08-16T02:00Z` is the 16th in
UTC and the 15th in New York.

`$page.locale` (§13.4) is the default because it has the same property the fixed one was chosen for
— it is a function of the route and the document, not of the machine — and because the alternative
is worse than it looks: a page under `/fr/` that formats a number without naming a locale used to
render it in English, on a page whose `<html lang>` and every `hreflang` on it said French. That
defect is invisible to whoever built the site in their own language and obvious to every reader of
the other one. An explicit locale still wins; a scope with **no page** — a component's own state, or
the runtime evaluated standalone — keeps `en-US`, which is what the fixed default now exists for.

**`compare` is the one worth saying out loud.** `<` and `Array.sort()` order by UTF-16 code unit,
which puts `Zebra` before `apple` and sorts every accented word after `z`. A sorted list built any
other way is wrong in every language with an accent.

**`DurationFormat` is deliberately absent.** Its baseline support is not universal, and a blessed
global that throws on a browser Jx claims to support is worse than one that does not exist: the
author writes a formula that works on their machine and fails on a visitor's.

**What is not built.** There is no `i18n.timeZone` key: an unread config key is the exact defect
§13.2 records `i18n` itself having had for months, and unlike a locale a time zone is not derivable
from anything the route already says. A **component's** own scope has no `$page`, so a formula
inside a custom element formats in `en-US` unless the locale is passed to it — the component
boundary is the state boundary (§10.4), and reaching across it for one value would make `$page`
ambient in a way nothing else is.

## 14. Deployment

> **Status: Partial.** The adapters, their worker output and the response-header file all ship.
> What does not is `vercel.json`, which is deliberate — there is no Vercel adapter, and the file
> belongs at the repository root rather than inside `build.outDir` (Appendix C).

### 14.1 Output Targets

The build output is standard static files deployable anywhere. When `build.adapter` is set, the compiler additionally generates platform-specific files:

| Provider               | Extra Output                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_               | Just `dist/` with HTML/CSS/JS/assets                                                                                                                      |
| `"cloudflare-workers"` | `dist/worker.js` (Hono server with asset fallback), `_redirects`                                                                                          |
| `"cloudflare-pages"`   | `dist/_worker.js` (advanced-mode Hono server) + `dist/_routes.json`, unless the site has neither server entries nor active extension mounts; `_redirects` |
| `"node"` / `"bun"`     | `dist/worker.js` (Hono server, no asset fallback)                                                                                                         |

Configured in `project.json`:

```json
{
  "build": {
    "adapter": "cloudflare-pages"
  }
}
```

#### 14.1.1 `build.adapter` Properties

| Property        | Type             | Default       | Description                                                                                                                                   |
| --------------- | ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `outDir`        | `string`         | `"./dist"`    | Output directory for static assets                                                                                                            |
| `format`        | `string`         | `"directory"` | **Reserved; currently unused.** Accepted for forward compatibility with single-file output — the build emits per-route directories regardless |
| `trailingSlash` | `string`         | `"always"`    | `"always"` or `"never"`                                                                                                                       |
| `sitemap`       | `boolean`        | `true`        | Generate `sitemap.xml` from the route table (requires `url`; §8.4.1)                                                                          |
| `adapter`       | `string \| null` | `null`        | Deployment adapter: `"cloudflare-workers"`, `"cloudflare-pages"`, `"node"`, `"bun"`                                                           |

Worker generation is gated on `adapter` alone — not on the project having server functions or extension mounts. When `adapter` is set, the compiler:

1. Collects `timing: "server"` entries from the project's components
2. Deduplicates by export name
3. Skips per-route `_server.js` generation. Because that per-route path is the only one that reads a page's own server entries, a `timing: "server"` entry declared directly on a page is not served once an adapter is set — declare server functions on a component. **This is a known gap, not a design intent**: the site-wide collector in step 1 walks `componentDefs` only, so a page-level entry is dropped silently, with no build warning. Until the collector also walks page documents, a page-level server function is a build-time footgun.
4. Collects the active extension server mounts (§15.1) and registers each under its `basePath` in `order`
5. Emits a single Hono worker via `compileSiteServer()` — `dist/worker.js`, or `dist/_worker.js` for `"cloudflare-pages"` ([advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/), the only Functions convention that lives inside the build output; the root-level `functions/` directory convention is not used). For Pages, a `dist/_routes.json` limiting worker invocation to `/_jx/*` is emitted alongside, so static assets are served without invoking the worker.
6. Adds the Cloudflare asset fallback (`app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))`) for both Cloudflare adapters

`"cloudflare-pages"` is the one adapter that can decline: with no server entries _and_ no active mounts, no worker and no `_routes.json` are emitted and the deployment stays purely static. The other adapters emit their worker unconditionally — with nothing to serve, it carries only the asset fallback (`"cloudflare-workers"`) or no routes at all (`"node"` / `"bun"`). The generated worker is a build artifact inside `dist/` and is excluded by the standard `dist/` gitignore rule.

#### 14.1.2 Cloudflare Image Transformation

When `images.service` is `"cloudflare"` (§9.2.6), no additional adapter output is generated — image optimization is pure markup (`/cdn-cgi/image` transform URLs) served by Cloudflare's zone-level Image Transformations feature, which must be enabled in the dashboard (Images → Transformations).

### 14.2 Build Artifacts

```
dist/
├── index.html                   # Static HTML page (page styles inlined in <style>)
├── about/
│   └── index.html
├── blog/
│   ├── index.html
│   ├── hello-world/
│   │   └── index.html
│   └── second-post/
│       └── index.html
├── components/                  # Per-component modules + styles
│   ├── site-header.js
│   ├── site-header.css
│   ├── cta-button.js
│   └── cta-button.css
├── images/
│   └── _optimized/              # Responsive image variants (content-hashed)
│       ├── hero-320-a1b2c3d4.webp
│       ├── hero-640-a1b2c3d4.webp
│       ├── hero-320-a1b2c3d4.avif
│       └── hero-640-a1b2c3d4.avif
├── sitemap.xml                  # Auto-generated from the route table (when url is set)
├── robots.txt                   # From public/, with a Sitemap: line appended
├── favicon.svg                  # Copied from public/
├── _headers                     # Response headers (§14.3)
├── _redirects                   # Platform-specific
├── .nojekyll                    # Stops GitHub Pages' Jekyll eating every _-prefixed path
└── worker.js                    # Server worker (whenever adapter is set; on cloudflare-pages it is
                                 # named _worker.js, paired with _routes.json, and skipped entirely
                                 # when there are no server entries and no active mounts)
```

Page and layout styles are inlined into each page's `<style>` block — there is no site-wide bundled stylesheet and no hashed `_assets/` directory. Pages reference the components they use via `<link rel="stylesheet" href="/components/<tag>.css">` and `<script type="module" src="/components/<tag>.js">` (the script is omitted for fully static components).

---

### 14.3 Response Headers (`_headers`)

Cacheability is something only the build can decide: it chose the filenames, so it is the only party
that knows which of them embed a content hash. Left unsaid, every host applies its own default to
output whose lifetime it cannot see. The build therefore writes `dist/_headers`.

```
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Frame-Options: SAMEORIGIN
  Cache-Control: public, max-age=0, must-revalidate

/images/_optimized/*
  Cache-Control: public, max-age=31536000, immutable
```

Two cache rules, and the reasoning is the whole design.

- **`/*` revalidates.** HTML at `/about/`, `/components/*.js`, `/assets/*.js`, `sitemap.xml` — none
  of their URLs change when their content does, so the only correct default is to check. The ETag
  makes checking cheap.
- **`/images/_optimized/*` is immutable** (RFC 8246). It is the one content-addressed output: the
  filename embeds a digest of the source bytes, so a changed image is a changed URL.
- **`/components/*` and `/assets/*` are deliberately excluded**, and a test asserts it. They are
  named after the tag or specifier they contain, so editing a component reuses the URL. Marking
  either immutable is a year-long cache-poisoning bug visible only to visitors who came before the
  edit. Content-hashing those filenames is the prerequisite, not a config flag.

**Which hosts read it.** `_headers` is a Cloudflare/Netlify convention, not a web standard.
**Cloudflare Pages, Cloudflare Workers assets and Netlify** read it; **GitHub Pages and most other
plain static hosts ignore it entirely** and serve their own `Cache-Control` — 10 minutes, in GitHub
Pages' case, applied to everything including the content-addressed images the file marks immutable
for a year. The build cannot know where a `dist/` is going, so it says what it can:

- Under the `node` or `bun` adapter, which serves no static assets at all, the build warns that the
  file is documentation rather than configuration — apply the headers at the reverse proxy.
- With no adapter and a `public/CNAME` — GitHub Pages' custom-domain marker, and nothing else's —
  the build warns that the file will be ignored.
- Otherwise a verbose-only note names the hosts that read it.

The warnings exist because the failure is silent in the worst way: the build writes a caching policy,
reports success, and the site ships with none.

**Ordering.** The file is written _after_ the `public/` copy, like the `robots.txt` edit — but it
**prepends** rather than appends. On both Cloudflare Pages and Netlify a later matching rule wins
for a duplicate header name, so a hand-authored `public/_headers` has to come last to override, and
it is concatenated verbatim below a banner. It is not merged structurally: both platforms carry
removal (`! Header-Name`) and conditional (`Language=`, `Country=`) extensions that a parser would
silently drop.

**Configuration** lives under `build.headers` — `enabled`, `cache` (`"auto"` or `"off"`),
`security.{contentTypeOptions, frameOptions, referrerPolicy, permissionsPolicy, hsts, csp}`, and
`rules` for verbatim stanzas. **HSTS is off by default**: a wrong `max-age` locks an apex domain to
HTTPS for that long and the mistake is invisible until a certificate lapses. `preload` without
`includeSubDomains` is a build error, because the preload list will not accept the header without it
and emitting one anyway produces something that looks submitted and is not.

#### 14.3.1 Content-Security-Policy

> **Status: Implemented.** `csp.ts`, emitted through `buildHeaderRules`. Off by default.

A static site cannot use nonces — a nonce must be fresh per response, and these responses are files
— so hashes are the only route to a strict `script-src`. That works here because the inline scripts
Jx emits are **constants**: the colour-scheme pre-paint script is one fixed IIFE, and the import map
is the same object on every page of a build. A handful of hashes covers a whole site, which is what
makes the policy fit in the `/*` stanza; a per-page policy would exhaust Cloudflare Pages' ~100-rule
budget on any real site.

Sources are collected by **scanning finished HTML** — the exact bytes about to be written — rather
than by asking each emission site what it emitted. Seven places can put a `<script>` on a page, and
a hash that does not match the shipped bytes is worse than no policy at all.

The emitted policy for a site with no third-party content:

```
Content-Security-Policy: base-uri 'self'; default-src 'self'; font-src 'self'; form-action 'self';
  frame-ancestors 'self'; frame-src 'self'; img-src 'self' data:; object-src 'none';
  script-src 'self' 'sha256-…' 'sha256-…'; style-src 'self' 'unsafe-inline'
```

Four decisions in that line:

- **`script-src` is strict.** Compiled output contains no `eval` and no `new Function` (a committed
  test asserts it), and event handlers are bound as listeners rather than emitted as `onclick=`
  attributes — so there is nothing for `'unsafe-inline'` or `'unsafe-eval'` to be needed for. Since
  §12 the runtime is same-origin too, so `'self'` plus the constant hashes is the whole directive.
- **`style-src` keeps `'unsafe-inline'`, and this is a divergence, not an oversight.** Every page
  carries a generated `<style>` block whose content is per-page, so hashing them would put one hash
  per page into a site-wide header; per-element `style=` attributes have no hash form at all. The
  two cannot be half-done: a hash and `'unsafe-inline'` in the same directive cancel, so a partial
  set of hashes would turn working pages blank. Hoisting inline attributes into the generated
  stylesheet is the reachable end state and is not this section's work.
- **A data block is never hashed.** `<script type="application/ld+json">` is not executed, CSP does
  not check it, and a hash for it would authorize nothing.
- **`frame-ancestors` is `'self'`**, matching the `X-Frame-Options: SAMEORIGIN` emitted beside it.
  Two headers disagreeing about framing is a worse outcome than either answer alone.

**Off by default**, unlike every other header in this section. Those describe the response; this one
governs code the build cannot see — a third-party script that loads a second script, a widget that
opens a frame. `csp: true` enforces, `"report-only"` observes, and an object form takes `mode`,
`reportUri` (which emits `report-to`, `report-uri` **and** the `Reporting-Endpoints` header the
first of those requires) and `directives` for wholesale replacement or removal of any computed
directive.

**Per adapter.** Cloudflare Pages, Cloudflare Workers assets and Netlify read the file. The `node`
and `bun` adapters serve no static assets at all, so for them it is documentation of what a reverse
proxy must send — the build says so with a warning rather than skipping the file.

### 14.4 `.nojekyll`

Written unconditionally. GitHub Pages runs Jekyll, which excludes every `_`-prefixed path — which is
`_headers`, `_redirects`, `_worker.js`, `_routes.json` and `_islands/`. One empty file closes the
whole class of "works locally, half-broken on Pages", which is why it is not an adapter option.

### 14.5 Installability and Disclosure Output

> **Status: Implemented.** `well-known.ts`, written after the `public/` copy in step 7d.1.

Two files a site is expected to publish and nothing generated. Both are pure functions of
`project.json` plus what the build already knows, which is the argument for generating them rather
than leaving them in `public/`: an author copying either between projects also copies the values
that were right for the other one.

**`manifest.webmanifest`** (W3C Web App Manifest) is emitted when the `manifest` section is present
— absence means no manifest, because a manifest is a claim that a site is meant to be installed and
most are not. `name` falls back to the project's own and `start_url` to `/`; camelCase config maps
onto the standard's `snake_case` keys, and a key the project did not set is absent rather than
null. `<link rel="manifest">` and, when a theme colour is set, `<meta name="theme-color">` join the
site-level `$head` below the author's own entries.

Icons at 192px and 512px are the installability criterion, and their absence is a **warning**, not
an error: the manifest is still valid and still supplies the name and colour a browser shows, so
refusing to emit it would be a worse trade than saying so.

**`.well-known/security.txt`** (RFC 9116) is emitted when `securityTxt` is present. `.well-known`
only — §3 makes it canonical, and a second copy at the root is a second thing to forget to update.
`preferredLanguages` runs through the same BCP 47 canonicalization as `i18n.locales` (§13.2): one
implementation for the repo.

**`Expires` is required and a past value is a build error.** §2.5.5 requires it, it is the field
everyone forgets, and an expired file is worse than a missing one — it advertises a reporting
channel while telling the reporter not to trust what it says. A missing `Contact` (§2.5.3) fails for
the same reason.

**Clearsigning is not implemented** and does not need to be. It requires a private key at build
time, which a build cannot have; a hand-placed `public/.well-known/security.txt` is copied before
this step and is kept rather than overwritten, so shipping a signed file costs zero code. The same
shadowing applies to the manifest.

### 14.6 Service Worker

> **Status: Implemented.** `service-worker.ts`, written in step 7d.2. **Off by default.**

A service worker is unlike every other output in this section: it is **sticky**. It survives
redeploys, it keeps running against a site that has moved on, and the visitors it breaks are
precisely the ones who came back. Nothing else the build emits can do that, which is why it is off
by default and why most of the contract below is about getting rid of one.

**`serviceWorker: false` is not the same as omitting the key**, and this is the load-bearing
distinction. Absence means "never had one" and emits nothing. `false` means "had one, remove it"
and emits a **tombstone** at the same URL: a worker whose only job is to unregister itself, delete
every cache it made, and reload its clients onto the live site. Deleting the file instead would
leave every previous visitor running the old worker forever — a 404 at that URL is not an
instruction to stop, and there is no other channel to reach them through.

**HTML is always network-first.** The cache is a fallback for a failed request, never a substitute
for one. A cache-first worker serves a stale page indefinitely and the author's next deploy cannot
reach the visitor to fix it. The single exception is `/images/_optimized/*`, which is the build's
only content-addressed output (§14.3) — its filename embeds a digest, so a cached hit can never be
wrong. `/components/*` and `/assets/*` are deliberately **not** cache-first for the same reason
they are not `immutable`: they are named after what they contain, not after their content.

**A precache URL that this build did not produce is a build error.** `cache.addAll()` is
all-or-nothing, so one unreachable entry rejects the install and the worker never activates — with
no error anywhere the author would look. The symptom is "the service worker does nothing", which is
how it presented the first time this was run against a browser. The emitted worker also fetches
precache entries individually rather than through `addAll()`, covering what the build cannot see.

An `offlineFallback` is added to `precache` if it is not already there, with a warning: a page that
was never cached cannot be served when the network is gone, which is the only moment it exists for.

**The cache name rotates on a configuration change, not on every build.** HTML is network-first and
images are content-addressed, so a content-only deploy needs no rotation, and rotating anyway would
discard a warm cache on every deploy for nothing.

The registration script is inline, byte-identical on every page, and therefore one hash in a strict
`script-src` (§14.3.1). It registers on `load` rather than immediately — a worker competing with
the page's own resources makes the first visit slower, and that is the visit that matters. It is
emitted only when a worker exists: registering a tombstone from the page trying to shed it would be
self-defeating.

---

## 15. Application Tier

Sections 1–14 describe a project's static surface: pages prerendered from files on disk. That surface is not the ceiling. A Jx project may also have signed-in users, application data, and server-side logic — the **application tier** — and this section is the map of where those pieces live and what they change about the build. It is an orientation section: the normative contracts are in `extensions.md` §11–§13 (server mounts, connectors, secrets), `spec.md` §11.4 (`timing: "server"`), and §14.1 above (adapter output).

> **Status: Implemented.** Server functions compile to worker routes (`compileSiteServer()`) or, with no adapter, per-route handlers (`compileServer()`), and are proxied in development by `server.md` §3.3. `@jxsuite/auth` and `@jxsuite/connector` ship as extensions declaring `server` mounts; the build wires them into the generated worker.

### 15.1 The Three Mechanisms

| Mechanism            | Declared as                                                            | Serves                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server functions** | a `state` entry with `timing: "server"` on a component (spec.md §11.4) | `POST /_jx/server/<export>` — the named export runs on the server, called as `(args, env)`                                                      |
| **Authentication**   | the `auth` section of `project.json`, from `@jxsuite/auth`             | `/_jx/auth/*` — Better Auth sessions, email/password and social sign-in, roles, and the system tables `user`/`session`/`account`/`verification` |
| **Application data** | the `data` section of `project.json`, from `@jxsuite/connector`        | `/_jx/data/*` — CRUD over rows in a connected database (Cloudflare D1, Supabase, SQLite); wire contract in extensions.md §11                    |

All three land in the **same** generated worker (§14.1). Extension mounts are registry-driven: the compiler collects every class carrying a `server` block that is _active_ — one owning no project section, or one whose section is present and non-empty in `project.json` — imports its mount module, and registers it under its `basePath` in `order`. No extension name is hardcoded in the compiler. Auth mounts first and publishes `ctx.auth` on the shared server context; the data mount consumes it to enforce per-table permission rules, and fails closed when it is absent.

Two scoping rules are easy to trip over. First, `@jxsuite/connector` also contributes a `connections` section, naming the databases a `data` table binds to — but `Connections` carries no `server` block, so it is configuration rather than a mount: it serves no routes, and a project that declares connections while leaving `data` and `auth` empty has no active mounts at all. Second, only component-declared server functions reach the generated worker; an entry declared directly on a page is served by the per-route `_server.js` path, which the build skips as soon as an adapter is set (§14.1).

### 15.2 Configuration Surface

Extensions contribute their own `project.json` sections through schema composition (extensions.md §5), so `auth`, `connections`, and `data` appear in the generated project schema — and in Studio's project settings (extensions.md §9) — only when the extension is enabled. They sit alongside the sections in §3.1 and follow the same rule as the rest of the file: **committed config carries identifiers and env-var _names_ only**. `secretEnv: "BETTER_AUTH_SECRET"` and `urlEnv: "SUPABASE_DB_URL"` name a variable; the value lives in `.dev.vars` locally (git-ignored) and in the host's secret store in production. See extensions.md §13.

Table schemas declared under `data` are synced to their connection by `jx db push` (§12.2), which is **additive-only** — it creates missing tables and columns and never drops or rewrites existing ones. Sections may contribute their own push steps (extensions.md §11.1); the auth extension's Better Auth system tables arrive that way.

### 15.3 Prerendering Still Holds

The application tier does **not** introduce per-request page rendering. Every page is still prerendered by the build exactly as §12.1 describes, and the worker serves `/_jx/*` plus (on the Cloudflare adapters) the static asset fallback — never HTML assembled per request.

The consequence to design around is that build-time and browser-time see different session state. `Session` resolves to `{ userId, role?, user }` or `null`, and is **always `null` outside a browser**. A prerendered page therefore ships its signed-out view; the signed-in view appears when the island hydrates and the session resolves against `/_jx/auth`. Anything that must never reach an unauthenticated reader belongs behind `/_jx/data` permission rules or a server function — not behind a conditional in the page, since both branches ship to the browser in the emitted markup or element module.

Reads and form actions against `data` tables lower at build time (extensions.md §8.3): table queries and single-entry lookups become core `Request` defs, and insert/update/delete actions become inline `Function` handlers that call the wire contract. No connector code ships to the browser.

### 15.4 Consequences for the Build

A project with an **active extension mount** — a non-empty `auth` or `data` section — **requires a server-capable adapter**. `build.adapter` must be `"cloudflare-workers"`, `"cloudflare-pages"`, `"node"`, or `"bun"`; with no adapter (a purely static build) the build **fails** with an error naming the offending sections, because a static deployment cannot serve them.

Nothing else forces that error. Server functions do not: a project whose only server tier is `timing: "server"` state builds fine with no adapter, its entries compiling to per-route `_server.js` files (§14.1). Neither does a `connections` section on its own, since `Connections` is not a mount (§15.1). And the converse of the rule does _not_ hold: whether a worker is emitted turns on `build.adapter`, not on the project using any of the three mechanisms. With an adapter set and nothing to serve, the build still writes a worker — except under `"cloudflare-pages"`, the one adapter that skips it when there are neither server entries nor active mounts (§14.1).

The tier does not change the shape of publishing. There is no `jx deploy` command (§12.2 lists the full CLI surface); the build writes `dist/` — including the worker when one is generated — and publishing is git-push-driven, with the host running the build and serving the output.

Locally, `jx dev` (server.md) stands in for the worker: it dispatches to the same mount handlers directly, merges `.dev.vars` over `process.env` when constructing mount environments, and substitutes a local SQLite file for any connector declaring `local: "sqlite"`. That stand-in is narrow: of the shipped connectors only Cloudflare D1 declares it, so a D1-backed project's auth and data run entirely on the machine, while a connection to a hosted service (Supabase, say) needs the real endpoint reachable and its `urlEnv` set in `.dev.vars`.

---

## 16. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). Feed generation is not cited: no numbered section owes it yet, and it is tracked as a roadmap item in Appendix C.

| Standard                                                                                  | Class         | Binds             | Evidence                                                                                                                                                                | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RFC 4287](https://www.rfc-editor.org/rfc/rfc4287)                                        | **Subset**    | §6.7              | extensions/feed/src/atom.ts, extensions/feed/tests/feed.test.ts                                                                                                         | Feed and entry documents carry the required `id`, `title` and `updated`, plus `self` and `alternate` links, and `xml:lang` on the feed element (§2) when the feed is one language of a localized collection. Not implemented: `<category>`, `<contributor>`, `<rights>`, and Atom's own paging — RFC 5005 covers the last of those.                                                                                                                                                                                                                                                                                 |
| [JSON Feed 1.1](https://www.jsonfeed.org/version/1.1/)                                    | **Subset**    | §6.7              | extensions/feed/src/json-feed.ts, extensions/feed/tests/feed.test.ts                                                                                                    | Feed identity, `language` — the locale of the collection directory the entries came from, when there is one — and per-item content, dates and authors. Attachments, tags, `banner_image` and hubs are not emitted; `next_url` is available but archives are offered in Atom alone rather than mixing two pagination conventions in one feed.                                                                                                                                                                                                                                                                        |
| [RFC 5005](https://www.rfc-editor.org/rfc/rfc5005)                                        | **Subset**    | §6.7              | extensions/feed/src/feed.ts, extensions/feed/tests/feed.test.ts                                                                                                         | The archived-feeds flavour (§2) plus `<fh:complete/>` (§4), which is the one designed for static hosting. Paged feeds (§3) are not offered: they are explicitly unstable for subscription, which is the only thing a static site publishes.                                                                                                                                                                                                                                                                                                                                                                         |
| [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)                                        | **Adopted**   | §8.4.1            | packages/compiler/src/site/site-build.ts                                                                                                                                | A minimal `robots.txt` is created when none was provided, and an existing one is appended to rather than replaced. The `Sitemap:` line the build adds is a sitemaps.org extension, not part of this standard.                                                                                                                                                                                                                                                                                                                                                                                                       |
| [Sitemaps 0.9](https://www.sitemaps.org/protocol.html)                                    | **Subset**    | §8.4.1, §13.5     | packages/compiler/src/site/site-build.ts, packages/compiler/src/site/pages-discovery.ts, packages/compiler/tests/sitemap-lastmod.test.ts                                | `<loc>`, a full RFC 3339 `<lastmod>` — taken from the content entry a generated route came from, not from the template that rendered it — and `xhtml:link` alternates for translated pages. Absent: `<changefreq>` and `<priority>`, both advisory and widely ignored, and the sitemap index, which is for sites past the 50,000-URL limit.                                                                                                                                                                                                                                                                         |
| [WHATWG URLPattern](https://urlpattern.spec.whatwg.org/)                                  | **Subset**    | §11.1             | packages/compiler/src/site/site-build.ts                                                                                                                                | Pattern strings are passed through to `_redirects` verbatim; the compiler neither parses nor validates them, so a malformed pattern is a deploy-time failure rather than a build-time one.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)                                        | **Subset**    | §11.3, §13.6      | packages/compiler/src/site/site-build.ts, packages/compiler/src/site/locale-negotiation.ts                                                                              | All five §15.4 redirection statuses are accepted and validated — 301, 302, 303, 307 and 308 — so a redirect can preserve a request method. A rewrite is modelled as `{destination, rewrite: true}` rather than as status `200`, which was never a redirection status but the host's own convention for serving another URL's content in place. Not implemented: content negotiation, `Retry-After` on 503, or any conditional-request handling — a static host owns those. Also §12.5.4 `Accept-Language`, parsed for locale negotiation: quality order, and `q=0` read as a refusal rather than a weak preference. |
| [RFC 8288](https://www.rfc-editor.org/rfc/rfc8288)                                        | **Subset**    | §8.1, §8.3, §13.5 | packages/site/src/head-merger.ts, packages/compiler/src/site/link-relations.ts, packages/site/tests/head-merger.test.ts, packages/compiler/tests/link-relations.test.ts | Link identity accounts for the target attributes — `rel`, `href`, and whichever of `hreflang`, `type`, `media` or `sizes` distinguishes two links sharing the first two. That is what lets a set of `alternate` links coexist. Relation types are checked against a snapshot of the IANA registry, with RFC 8288 §2.1.2 extension URIs accepted; unregistered values warn once per build. Absent: the header form of `Link:` — Jx expresses every relation in HTML.                                                                                                                                                 |
| [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/)                                           | **Subset**    | §8.5              | packages/site/src/head-merger.ts, packages/site/tests/head-merger.test.ts                                                                                               | An object `textContent` is serialized into the tag and templates inside it resolve, so a document can carry structured data that references itself. Jx does not process the JSON-LD — no context expansion, no compaction, no framing; it is emitted for the consumer to interpret.                                                                                                                                                                                                                                                                                                                                 |
| [BCP 47](https://www.rfc-editor.org/info/bcp47)                                           | **Subset**    | §13.2, §13.4      | packages/schema/src/locale.ts, packages/schema/tests/locale.test.ts, packages/compiler/src/site/i18n.ts                                                                 | Tags are parsed against the RFC 5646 grammar and canonicalized (`EN-us` → `en-US`) through `Intl.Locale`; a malformed tag fails the build. Well-formedness only — the IANA registry is not consulted, so `zz` and `xx-YY` are accepted for languages that do not exist.                                                                                                                                                                                                                                                                                                                                             |
| [RFC 4647](https://www.rfc-editor.org/rfc/rfc4647)                                        | **Subset**    | §13.6             | packages/compiler/src/site/locale-negotiation.ts, packages/compiler/tests/locale-negotiation.test.ts, packages/compiler/tests/locale-worker.test.ts                     | §3.4 Lookup, run against `i18n.locales` in the generated worker: progressive truncation, singleton subtags removed with their parent, RFC 9110 §12.5.4 quality order, `q=0` honoured as a refusal. Absent: §3.3 Filtering, which returns a set and cannot answer "which page". Adapter-less static output negotiates nothing and permanently cannot — there is no runtime that sees a request (§13.6).                                                                                                                                                                                                              |
| [ECMA-402](https://ecma-international.org/publications-and-standards/standards/ecma-402/) | **Subset**    | §13.4, §13.7      | packages/schema/src/intl.ts, packages/schema/src/locale.ts, packages/schema/tests/intl.test.ts, packages/runtime/tests/expression.test.ts                               | `Intl.Locale` supplies tag parsing, canonical case and likely-subtags maximization. The formatting half is now reachable from a document: eight blessed helpers wrap the ECMA-402 constructors as pure calls, and each defaults to the **page's** locale and a **fixed** time zone rather than the host's, so a build's output is a function of its input. `DurationFormat` is deliberately not offered — its baseline support is not universal, and a blessed global that throws on a supported browser is worse than its absence.                                                                                 |
| [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111)                                        | **Adopted**   | §14.3             | packages/compiler/src/site/headers-emitter.ts, packages/compiler/tests/headers-emitter.test.ts                                                                          | Every output declares its cacheability: `must-revalidate` for anything whose URL does not change with its content, and a year for the one output whose URL does.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [RFC 8246](https://www.rfc-editor.org/rfc/rfc8246)                                        | **Adopted**   | §14.3             | packages/compiler/src/site/headers-emitter.ts, packages/compiler/tests/headers-emitter.test.ts                                                                          | `immutable` is emitted for `/images/_optimized/*` alone. A test asserts no other path can acquire it, because every other filename is reused when its content changes.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [RFC 6797](https://www.rfc-editor.org/rfc/rfc6797)                                        | **Subset**    | §14.3             | packages/compiler/src/site/headers-emitter.ts                                                                                                                           | Off by default and opt-in per project, with `max-age`, `includeSubDomains` and `preload`. `preload` without `includeSubDomains` is refused rather than emitted, since the preload list would reject it.                                                                                                                                                                                                                                                                                                                                                                                                             |
| [Referrer Policy](https://www.w3.org/TR/referrer-policy/)                                 | **Adopted**   | §14.3             | packages/compiler/src/site/headers-emitter.ts                                                                                                                           | `strict-origin-when-cross-origin` by default; any policy token from the standard, or `false` to omit the header.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [Service Workers](https://www.w3.org/TR/service-workers/)                                 | **Subset**    | §14.6             | packages/compiler/src/site/service-worker.ts, packages/compiler/tests/service-worker.test.ts                                                                            | Install/activate/fetch with a network-first strategy, precaching, an offline fallback, and a tombstone that unregisters a previously deployed worker. Not offered: push, background sync, periodic sync, or navigation preload — every one of them is a capability rather than a caching decision, and none is derivable from a static build's own output.                                                                                                                                                                                                                                                          |
| [Web Application Manifest](https://www.w3.org/TR/appmanifest/)                            | **Subset**    | §14.5             | packages/compiler/src/site/well-known.ts, packages/compiler/tests/well-known.test.ts                                                                                    | Identity, presentation and icons: `name`, `short_name`, `start_url`, `scope`, `display`, `orientation`, colours, `lang`/`dir`, `categories`. Not offered: `shortcuts`, `share_target`, `file_handlers`, `protocol_handlers`, `screenshots` and the other members that describe an app's integration with an OS rather than a site's identity.                                                                                                                                                                                                                                                                       |
| [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)                                        | **Subset**    | §14.5             | packages/compiler/src/site/well-known.ts, packages/compiler/tests/well-known.test.ts                                                                                    | Every field the standard defines, at the canonical `.well-known` location, with `Expires` (§2.5.5) and `Contact` (§2.5.3) enforced as build errors. Clearsigning (§2.3) is not implemented — it needs a private key at build time — but a hand-placed `public/.well-known/security.txt` shadows the generated file, which is how a signed one ships.                                                                                                                                                                                                                                                                |
| [RFC 8615](https://www.rfc-editor.org/rfc/rfc8615)                                        | **Adopted**   | §14.5             | packages/compiler/src/site/well-known.ts                                                                                                                                | The `/.well-known/` prefix is used as the registry defines it and nothing else is placed there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [WHATWG HTML](https://html.spec.whatwg.org/)                                              | **Subset**    | §9.2              | packages/compiler/src/site/image-transform.ts, packages/compiler/src/site/img-loading.ts, packages/compiler/tests/img-loading.test.ts                                   | Responsive images: `srcset` with `w` descriptors, `sizes`, `<picture>` with one `<source type>` per format, and the `loading`/`decoding`/`fetchpriority` interaction. Art direction is not offered — no `media` on a source, and no `x` descriptors — because both are per-image authoring decisions a build-time pass cannot infer.                                                                                                                                                                                                                                                                                |
| [CSP Level 3](https://www.w3.org/TR/CSP3/)                                                | **Divergent** | §14.3.1           | packages/compiler/src/site/csp.ts, packages/compiler/tests/csp.test.ts, packages/compiler/tests/site-build.test.ts                                                      | `script-src` is strict — `'self'` plus a hash per constant inline script, no `'unsafe-inline'` and no `'unsafe-eval'`, verified in a browser against a real build. `style-src` keeps `'unsafe-inline'`: per-page `<style>` blocks and per-element `style=` attributes have no site-wide hash, and a partial set would cancel the keyword and blank the page. Off by default, because a policy governs code the build cannot see.                                                                                                                                                                                    |
| [UAX #9](https://www.unicode.org/reports/tr9/)                                            | **Subset**    | §13.4             | packages/schema/src/locale.ts, packages/schema/tests/locale.test.ts                                                                                                     | The `<html dir>` half: a tag's script decides direction, tested against the ISO 15924 right-to-left set, and `dir` is emitted only when it is not the default. The algorithm itself — bidi resolution within a run of text — belongs to the browser; Jx neither implements nor overrides it, and emits no `bdi`, `bdo` or isolate controls of its own.                                                                                                                                                                                                                                                              |
| [UTS #35](https://www.unicode.org/reports/tr35/)                                          | **Borrowed**  | §13.4             | packages/schema/src/locale.ts                                                                                                                                           | CLDR likely-subtags, reached through `Intl.Locale.maximize()`, is what turns `dv` into `dv-Thaa-MV` and therefore what makes the direction answer right. No other CLDR data is consumed and none is bundled.                                                                                                                                                                                                                                                                                                                                                                                                        |
| [Permissions Policy](https://www.w3.org/TR/permissions-policy/)                           | **Subset**    | §14.3             | packages/compiler/src/site/headers-emitter.ts                                                                                                                           | A default deny-list for camera, microphone and geolocation is emitted, and the whole header is author-replaceable. The structured-field grammar is passed through rather than parsed.                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Appendix: Element Annotations

Jx elements support `$title` and `$description` as developer-facing annotation metadata. These are inspired by JSON Schema's annotation keywords and are never compiled to HTML output.

| Property       | Type     | Purpose                                                   |
| -------------- | -------- | --------------------------------------------------------- |
| `$title`       | `string` | Human-friendly label. Displayed in studio layers panel.   |
| `$description` | `string` | Extended description. Reserved for future studio tooltip. |

**Behavior:**

- Both are `$`-prefixed, signaling they are JX-specific metadata (not DOM properties)
- Neither appears in compiled HTML or is applied to the DOM at runtime
- `$title` takes priority over `$id` and `textContent` as the layer label in Jx Studio
- In the studio layers panel, double-click a layer item to edit `$title` inline
- The context menu provides a "Set Title" action for the same purpose

**Markdown remark directive mapping:**

- `$title` → `--title` attribute on the directive
- `$description` → `--description` attribute on the directive

**Example:**

```json
{
  "tagName": "section",
  "$title": "Hero Section",
  "$description": "Main landing page hero with CTA button",
  "children": [...]
}
```

## Appendix A: New Keywords Summary

This spec introduces the following new reserved keywords:

| Keyword             | Context             | Purpose                                          |
| ------------------- | ------------------- | ------------------------------------------------ |
| `$layout`           | Page root           | Specifies the layout wrapping this page          |
| `$paths`            | Page root           | Dynamic route parameter generation               |
| `$params`           | State `$ref` target | Route parameters (`#/$params/<name>`, read-only) |
| `$page`             | Template string     | Page metadata context                            |
| `$site`             | Template string     | Site metadata context                            |
| `$head`             | Page/site root      | `<head>` element declarations                    |
| `$sitemap`          | Page root           | Set `false` to exclude from `sitemap.xml`        |
| `$translationKey`   | Page root           | This page's identity across languages (§13.5)    |
| `ContentCollection` | `$prototype` value  | Collection query                                 |
| `ContentEntry`      | `$prototype` value  | Single entry access                              |

**Reused existing primitives (no new keywords needed):**

| Mechanism             | Existing Primitive                     | Site-Level Use                                   |
| --------------------- | -------------------------------------- | ------------------------------------------------ |
| Layout slot injection | `{ "tagName": "slot" }`                | Marks where page content goes in a layout        |
| Named slot targeting  | `{ "attributes": { "slot": "name" } }` | Pages target specific layout regions             |
| Slot fallback content | Children of `<slot>` element           | Default content when no page content is provided |

## Appendix B: Mapping to Existing Primitives

This spec builds on existing Jx primitives wherever possible:

| New Concept        | Built On                                                                                |
| ------------------ | --------------------------------------------------------------------------------------- |
| Layouts            | Standard Jx documents + HTML `<slot>` element (already implemented for custom elements) |
| Named layout slots | Standard `slot` attribute targeting (already implemented)                               |
| Content query      | `$prototype` (same pattern as `Array`, `URL`, etc.)                                     |
| Dynamic routes     | `$ref` + compiler-time resolution                                                       |
| Site state         | Standard `state` with scope prefix                                                      |
| Media breakpoints  | Existing `$media` (already implemented)                                                 |
| SEO metadata       | Standard element definitions (existing `tagName`, `name`, `content`)                    |
| Redirects          | Compiler output (new, but no runtime concept)                                           |
| File-based routing | Convention only (no new language feature)                                               |

## Appendix C: Implementation Roadmap

### Phase 1: Foundation

- [x] `project.json` schema and loader
- [x] File-based routing discovery (`pages/` scanner)
- [x] Layout system (`$layout`, `<slot>` distribution at compile time)
- [x] `$head` merge pipeline (site + layout + page)
- [x] Multi-page build orchestration
- [x] `$page` and `$site` context injection

### Phase 2: Content

- [x] Content collection loader (Markdown, JSON, CSV)
- [x] `project.json` `content` schema validation
- [x] `ContentCollection` and `ContentEntry` prototypes
- [x] `$paths` dynamic route expansion
- [x] Collection reference resolution (`$ref` between collections)
- [x] Studio: Project file tree (left panel `Files` tab)
- [x] Studio: Browse canvas mode (table view with category filters, search, media detection)
- [x] Studio: Markdown WYSIWYG editing (content mode, inline rich text, slash commands)
- [x] Studio: Markdown frontmatter round-trip (parse on load, serialize on save)

### Phase 3: Studio Content Management

- [ ] Studio: Frontmatter form editor (schema-driven sidebar for markdown content entries)
- [ ] Studio: JSON data entry editor (form-based editing for JSON collection entries)
- [ ] Studio: CSV table editor (inline sp-table editor for CSV entries)
- [ ] Studio: Content CRUD (create new entry, delete, rename/move)
- [ ] Studio: Media browser (thumbnail grid, upload, file picker integration)
- [ ] Studio: SEO panel (title/description preview, OG card preview, JSON-LD editor)
- [ ] Studio: Redirect editor (table UI for managing project.json redirects)

### Phase 4: Build Pipeline

- [x] Image optimization pipeline (WebP/AVIF, responsive srcset, lazy loading, caching)
- [x] Sitemap generation (`sitemap.xml` from route table; `<lastmod>`, `robots.txt` reference, `$sitemap: false` opt-out, `build.sitemap` toggle)
- [ ] Incremental builds (dependency tracking, selective recompilation)
- [x] Platform adapters — `build.adapter` for site-wide server bundling (Cloudflare implemented)
- [x] Platform-specific file generation — `_headers` (§14.3) and `.nojekyll` (§14.4). `vercel.json` is **declined**: there is no Vercel adapter, and the file belongs at the repository root rather than inside `build.outDir`.

### Phase 5: Advanced

- [ ] Internationalization routing (locale prefix, default locale handling)
- [ ] Content localization (per-locale content directories)
- [ ] Pagination helpers
- [x] Atom and JSON Feed generation — `@jxsuite/feed` (§6.7), via the `emit` and `head` capabilities (extensions.md §8.4, §8.6). RSS 2.0 is **declined**: no standards body, and every reader handles Atom.
- [x] Search index generation — via the extension `emit` capability (extensions.md §8.4)

## Changelog

- **0.6.5-draft** (2026-08-29) — A media usage query asks about the file once; enumerating a file's authored spellings host-side is the engine's job, not a media surface's.
- **0.6.4-draft** (2026-08-27) — Record that collection discovery is recursive, so a subdirectory holds entries as well as co-located media.
- **0.6.3-draft** (2026-08-27) — Reference resolution through the asset lanes is the refactor engine's contract, in both directions: a rooted ref is counted through every lane, rewritten through the lanes a build publishes, and named in the report when it cannot be written.
- **0.6.2-draft** (2026-08-27) — Routing, layout, context and head-merge move to @jxsuite/site; standards evidence follows.
- **0.6.1-draft** (2026-08-27) — media files open in a viewer, which is the reader the usage query was missing (§9.4).
- **0.6.0-draft** (2026-08-26) — §12.4: component CSS inlined and modulepreload hints emitted; §14.3: name the hosts that read _headers, and warn when one will not.
- **0.5.18-draft** (2026-08-26) — Standards evidence follows head-merger to @jxsuite/schema.
- **0.5.17-draft** (2026-08-25) — §9.3: an editor whose host does not serve the site URL space MUST resolve references to the project files they name; §9.4: a parent-realm preview resolves in the same space, and an authored reference is not a file path.
- **0.5.16-draft** (2026-08-19) — §13.5: a translation key may name its route's parameters, so a collection's URLs can be localized; §13.3: a ContentEntry lookup is scoped to the route's language and a locale directory is matched case-insensitively; §6.7: a localized collection publishes one feed per language.
- **0.5.15-draft** (2026-08-18) — §13.5: a document declares its identity across languages with $translationKey, so a localized slug is a translation; two routes claiming one language are reported, as an error when declared.
- **0.5.14-draft** (2026-08-18) — §13.5 exposes the translation set to the page as $page.alternates, with each locale's autonym; §13.7 defaults a helper's locale to the page's own; §13.6 reports a prefix-always root no static deployment can answer.
- **0.5.13-draft** (2026-08-18) — §8.7: the subpath entry is bundled rather than externalised, and the shared core is reached through an emitted stub — a self-referential asset broke every page using a directive.
- **0.5.12-draft** (2026-08-18) — §8.7: subpaths resolve through a prefix key and an npm $elements set bundles as one self-contained module.
- **0.5.11-draft** (2026-08-18) — §8.7: bare specifiers resolve on page and layout too, npm-only pages get an import map, and the package-subpath gap is recorded.
- **0.5.10-draft** (2026-08-18) — §13: correct a status marker that contradicted §13.3 and §13.6 — {locale} expansion and Accept-Language negotiation both ship.
- **0.5.9-draft** (2026-08-16) — §13.7 blessed Intl helpers — one shared list, five new helpers, and a fixed en-US/UTC default so a build's output is a function of its input. Closes gap:locale-formatting.
- **0.5.8-draft** (2026-08-16) — §13.3 {locale} sources expand and scope route expansion; §13.6 Accept-Language negotiation in the generated worker; prefix-always is checked; gap:locale-lookup closed.
- **0.5.7-draft** (2026-08-16) — §8.4.1 a generated route's lastmod comes from the entry it was generated from; gap:sitemap-fields closed.
- **0.5.6-draft** (2026-08-16) — §8.3 link relations are checked against the IANA registry, warning once per build; gap:link-relation-validation closed.
- **0.5.5-draft** (2026-08-16) — §16: the RFC 9110 row states the five statuses B1 shipped instead of the two that predated it.
- **0.5.4-draft** (2026-08-16) — Optional service worker with a tombstone contract: off by default, network-first HTML, precache validated against the build's own output (§14.6).
- **0.5.3-draft** (2026-08-16) — Cascade layer 6 describes the scoping that exists — there is no shadow DOM.
- **0.5.2-draft** (2026-08-15) — Generate manifest.webmanifest and .well-known/security.txt (§14.5).
- **0.5.1-draft** (2026-08-15) — hreflang alternates in <head> and sitemap xhtml:link for translated pages (§13, §13.5).
- **0.5.0-draft** (2026-08-15) — i18n: BCP 47 validation and canonicalization, route prefixes resolve to locales, per-page lang and script-derived dir, $page.locale (§13, §13.2, §13.4).
- **0.4.1-draft** (2026-08-15) — Emit a Content-Security-Policy derived from the built pages: strict script-src from constant inline-script hashes, style-src divergence recorded (§14.3.1).
- **0.4.0-draft** (2026-08-15) — Responsive images: <picture> per format, one owner for loading attributes, fetchpriority honoured, lazyLoad independent of optimize (§9.2, §9.2.7).
- **0.3.3-draft** (2026-08-15) — $head bare specifiers copy into /assets/ and $elements bundle there; an unresolvable one is a build error (§8.7).
- **0.3.2-draft** (2026-08-15) — §8.4.1 <lastmod> is a full RFC 3339 timestamp; the per-template lastmod wart is named rather than implied.
- **0.3.1-draft** (2026-08-15) — Add §6.7 syndication feeds: Atom and JSON Feed via @jxsuite/feed, RFC 5005 archives, RSS declined.
- **0.3.0-draft** (2026-08-15) — §8.3 link identity includes hreflang/type/media/sizes; §8.5 JSON-LD objects serialize; §8.4 lang and dir come from the page.
- **0.2.1-draft** (2026-08-15) — Add §14.3 response headers and §14.4 .nojekyll; §14's header gap is closed and vercel.json is declined.
- **0.2.0-draft** (2026-08-15) — §11.3 separates redirects from rewrites: an RFC 9110 status enum, a per-status HTML-fallback policy, and no file for a rewrite.
- **0.1.45-draft** (2026-08-15) — Add §16 Standards Alignment; §8.5 marked Pending — the JSON-LD object form is unimplemented — and §14 Partial: no _headers or .nojekyll is emitted.
- **0.1.44-draft** (2026-08-12) — Header status corrected from Pending to Partial — all seven marked sections were Implemented while the header claimed nothing was; §9.4's marker and its own Still-planned list contradicted each other (metadata and the delete warning ship; browsable usage does not); §12.3 and §13 marked Pending, having no dependency graph and no reader of the i18n config respectively.
- **0.1.43-draft** (2026-08-11) — Studio SEO previews move from a Document Header disclosure into the Search appearance modal (document.openSeo), reachable from the card, the Page panel and the palette; fields grouped by the preview each feeds.
- **0.1.42-draft** (2026-08-06) — §7.2 the Library and its window contract, §7.5 the CRUD table corrected — rename, delete and CSV editing already shipped and were listed Pending, §7.6 the draft pill, §8.6 merged-$head previews with no score, §9.4 usage keyed on the authored ref, §11.4 redirects as a GridSource with chain, loop and shadow validation.
- **0.1.41-draft** (2026-08-05) — §3.2 names the consequence of the cascade — every property reaches every route, which is why Studio states the blast radius and edits the file under undo.
- **0.1.40-draft** (2026-07-30) — A page uses a component when its tag appears in the prerendered HTML or in one of the page's island modules (§12.4).
- **0.1.39-draft** (2026-07-28) — §9.3: editors that open a collection entry standalone must apply the mount rewrite to their render representation only, with the browser-side existence-check divergence stated.
- **0.1.38-draft** (2026-07-28) — Media browser (§9.4) is Partial: upload ships on four Studio surfaces with content-collection destinations and collision-safe naming; metadata and usage tracking still pending.
- **0.1.37-draft** (2026-07-24) — Document the application tier and correct the static-only framing: §1 vision, §1.1 principles 1/3/5, §1.2 coverage, §14.1/§14.2 adapter output (worker generation is gated on build.adapter alone), and new §15 Application Tier covering server functions, auth, and data mounts.
- **0.1.36-draft** (2026-07-23) — Note the mounted-asset copy step in the build pipeline (§12.1).
- **0.1.35-draft** (2026-07-23) — Content entries address media relative to themselves; collections publish their directory at /content/<type> (§9.3).
- **0.1.34-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.33-draft** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.1.32-draft** (2026-07-17) — Forced color-scheme contract — dual emission, color-scheme triplet, pre-paint script (`e629684d`).
- **0.1.31-draft** (2026-07-17) — Bundle the site worker self-contained per adapter (`4096ba12`).
- **0.1.30-draft** (2026-07-17) — Sidecar bundling, extension emit capability, heading anchors (`07e28bc3`).
- **0.1.29-draft** (2026-07-17) — Image pruning for persistent site build cache + github ci cache (`b45096ed`).
- **0.1.28-draft** (2026-07-17) — Align spec.md, site-architecture, desktop, server, extensions with reality (`c61ba567`).
- **0.1.27-draft** (2026-06-25) — Sitemap generation (`948c7a67`).
- **0.1.26-draft** (2026-06-10) — Update site architecture to reflect new changes (`c0bdba08`).
- **0.1.25-draft** (2026-06-10) — Use cloudflare cgi for image optimization (`96228874`).
- **0.1.24-draft** (2026-06-10) — Consolidate markdown and csv handling to the parser package (`8b1ba6da`).
- **0.1.23-draft** (2026-06-03) — Use `.cache` isntead of `.jx-cache` to support cloudflare build cache (`1103d2d6`).
- **0.1.22-draft** (2026-06-01) — Remove old glob-based content type references (`6bcbfdaf`).
- **0.1.21-draft** (2026-05-28) — Separate directory + format for content type defs (`c43186ac`).
- **0.1.20-draft** (2026-05-25) — Element annotations (title/description) (`c9137e50`).
- **0.1.19-draft** (2026-05-25) — Allow nested global styles (`1159d585`).
- **0.1.18-draft** (2026-05-20) — Run formatter (`8ba47930`).
- **0.1.17-draft** (2026-05-19) — Reflect new content type transition (`6eb3d2b6`).
- **0.1.16-draft** (2026-05-18) — Always emit worker.js for cloudflare (`3dd37c2d`).
- **0.1.15-draft** (2026-05-18) — Remove unused 'rendered' property from JSON and CSV entries (`7478a87c`).
- **0.1.14-draft** (2026-05-15) — Image optimization specs (`7d2ee67f`).
- **0.1.13-draft** (2026-05-15) — Provider-sepcific Site-Wide Bundling (`51cb5cf6`).
- **0.1.12-draft** (2026-05-04) — Longhand/shorthand property input sync (`05c7da35`).
- **0.1.11-draft** (2026-04-29) — Update site architecture progress (`3305a8f0`).
- **0.1.10-draft** (2026-04-29) — Project browser (`11c1fe7c`).
- **0.1.9-draft** (2026-04-23) — Site build (`ffe60ddc`).
- **0.1.8-draft** (2026-04-23) — Compiler cli + published site (`4607ebbc`).
- **0.1.7-draft** (2026-04-22) — Consolidate project config schema and rename as such (`e3523dbf`).
- **0.1.6-draft** (2026-04-20) — Better project-level scoping (`0cba233c`).
- **0.1.5-draft** (2026-04-16) — Landing site + working exports + release-it + linting (`a8409b5f`).
- **0.1.4-draft** (2026-04-15) — Rebrand to Jx / Jx Platform (`abc63f2d`).
- **0.1.3-draft** (2026-04-15) — Importmap support (`c1b329d4`).
- **0.1.2-draft** (2026-04-10) — WinterTC server-side conventions (`60eba6dd`).
- **0.1.1-draft** (2026-04-10) — Site architecture update (`86d1c515`).
- **0.1.0-draft** (2026-04-10) — Enhanced font picker (`9d388a32`).
