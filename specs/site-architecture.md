# Jx Site Architecture Specification

## File-Based Routing, Content Collections, Layouts, and Static Site Generation

**Version:** 0.3.3-draft
**Status:** Partial
**Updated:** 2026-08-15
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

| Property            | Source                                         | Description                |
| ------------------- | ---------------------------------------------- | -------------------------- |
| `$page.title`       | Page's `$head` title or explicit `title` field | Page title                 |
| `$page.description` | Page's `$head` meta description                | Meta description           |
| `$page.url`         | Computed from file path                        | Page URL path              |
| `$page.lang`        | Page-level or site default                     | Language code              |
| `$page.$head`       | Page's `$head` array                           | Page-specific head entries |
| `$page.frontmatter` | Content entry frontmatter (for content pages)  | All frontmatter fields     |

The `$site` context provides site-level data:

| Property      | Source                 | Description         |
| ------------- | ---------------------- | ------------------- |
| `$site.name`  | `project.json` `name`  | Site name           |
| `$site.url`   | `project.json` `url`   | Production URL      |
| `$site.state` | `project.json` `state` | Site-wide state     |
| `$site.$head` | `project.json` `$head` | Global head entries |

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
- **Dynamic routes** are listed by their expanded concrete URLs. Pages generated from a single template still share that template file's `<lastmod>`, which is wrong for a collection — every post looks edited whenever the template is. Entries now carry `_meta.mtime` (`parser.md` §9.3), so the data exists; routing it through `$paths` expansion to the route is the remaining work, tracked as `gap:sitemap-fields`.
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
> bundling.

A `$head` entry may name a file inside an installed package by bare specifier rather than by URL —
`"@shoelace-style/shoelace/dist/themes/light.css"`. The build **resolves it against the project
root and copies the file into `/assets/`** under a flattened, hash-free name derived from the
specifier: `/assets/shoelace-style-shoelace-dist-themes-light.css`. The extension is preserved,
because both the browser and the host dispatch on it.

`$elements` entries name modules rather than files, so they are **bundled** through the same path a
Function-def `$src` takes (`spec.md` §12) and land at the same kind of URL. Bundling rather than
copying is what makes the package's own bare imports resolvable: the emitted import map carries two
entries, and a component package imports far more than that.

Copies and bundles share one output directory, so they share one namespace. Two different files
that flatten to the same name is a **build error** naming both, never a last-writer-wins overwrite.

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
| `lazyLoad`      | `boolean`  | `true`                                      | Adds `loading="lazy"` and `decoding="async"` to `<img>` tags                                                        |
| `service`       | `string`   | `"build"`                                   | `"build"` = Sharp at build time; `"cloudflare"` = `/cdn-cgi/image` transform URLs served by Cloudflare (see §9.2.6) |
| `remoteDomains` | `string[]` | `[]`                                        | Hostnames whose remote (https) images get transform srcsets — `"cloudflare"` service only (see §9.2.6)              |

#### 9.2.2 Build-Time Behavior

When `optimize: true`, the compiler processes every `<img>` node during page compilation:

1. **Width filtering** — Only generates variants at widths ≤ the source image's natural width. The original width is always included as a breakpoint.
2. **Format conversion** — Each width × format combination produces an optimized variant via Sharp.
3. **Output path** — Variants are written to `dist/images/_optimized/{stem}-{width}-{hash}.{format}` (e.g., `hero-640-a1b2c3d4.webp`).
4. **Attribute injection** — The compiler mutates the `<img>` node to add:
   - `srcset` — responsive variant list (e.g., `hero-320-a1b2.avif 320w, hero-640-a1b2.avif 640w, ...`)
   - `sizes` — from config (unless the node already specifies one)
   - `width` and `height` — the original image's intrinsic dimensions (prevents layout shift). Skipped when the author already sets either attribute, and for remote sources or images whose dimensions cannot be read
   - `loading="lazy"` and `decoding="async"` — when `lazyLoad: true` (unless `loading="eager"` is already set)

Up to 4 variants are processed concurrently per image.

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
    "loading": "eager",
    "data-no-optimize": true
  }
}
```

- `sizes` — overrides the global `sizes` value for this image
- `loading="eager"` — prevents `loading="lazy"` from being added (for above-the-fold images)
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

Only statically referenced files are copied into the build. A `src` computed at runtime belongs in `public/`.

### 9.4 Studio Media Browser

> **Status: Partial.** Upload, browsing, metadata and the referenced-file warning ship. Usage is
> COMPUTED but not browsable — see the list at the end of this section, which contradicted this
> marker for as long as both existed. The full Studio-side contract is `studio.md` §9.3 — this
> section states only what it means for the media on disk.

**Usage is keyed on the AUTHORED reference, not the resolved one.** A content-relative `./images/`
reference previews at its asset-mount URL while the source keeps the authored form, so keying on
what the browser fetched would under-count every content-relative use — and an under-count is what
makes a delete look safe when it is not. A delete states its reference count, and where the count
cannot be answered it says **unknown**, never zero.

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

Still planned:

- **Usage tracking as a SURFACE.** The query ships (`files/media-usage.ts`) and is correct; what is
  missing is a reader other than the delete confirmation. No column, panel or field answers "which
  pages use this image?" until you try to remove it — so the answer arrives at the one moment the
  author has already decided.

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
6. Component-level styles (scoped to custom element shadow DOM or via class namespacing)

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

- **CSS:** Page and layout styles are inlined into each page's `<style>` block; each compiled component ships its own `dist/components/<tag>.css`, linked only by pages that use it
- **JS:** Each interactive component ships its own module (`dist/components/<tag>.js`), loaded via `<script type="module">` only by pages that use it; fully static components ship no script. A page "uses" a component when its tag appears in the prerendered HTML **or** in one of the page's island modules — an island builds its markup in the browser, so a component it renders needs its module even when the component is fully static, because no prerendered markup exists for that instance
- **Images:** Optimized variants are written to `dist/images/_optimized/` with content-hash-suffixed filenames for caching
- **Fonts:** Copied verbatim from `public/`

---

## 13. Internationalization

> **Status: Pending.** `project-schema.json` declares the `i18n` object, so a `project.json` may
> carry `defaultLocale`, `locales` and `routing` and will validate — and **nothing reads any of
> them.** No router, no build step and no Studio surface consults the key. A locale-prefixed
> directory works today only because `pages/en/about.json` is an ordinary route that happens to
> begin with `en`; none of the behaviour this section specifies follows from the config.

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

---

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

**Ordering.** The file is written _after_ the `public/` copy, like the `robots.txt` edit — but it
**prepends** rather than appends. On both Cloudflare Pages and Netlify a later matching rule wins
for a duplicate header name, so a hand-authored `public/_headers` has to come last to override, and
it is concatenated verbatim below a banner. It is not merged structurally: both platforms carry
removal (`! Header-Name`) and conditional (`Language=`, `Country=`) extensions that a parser would
silently drop.

**Configuration** lives under `build.headers` — `enabled`, `cache` (`"auto"` or `"off"`),
`security.{contentTypeOptions, frameOptions, referrerPolicy, permissionsPolicy, hsts}`, and `rules`
for verbatim stanzas. **HSTS is off by default**: a wrong `max-age` locks an apex domain to HTTPS for
that long and the mistake is invisible until a certificate lapses. `preload` without
`includeSubDomains` is a build error, because the preload list will not accept the header without it
and emitting one anyway produces something that looks submitted and is not.

**Per adapter.** Cloudflare Pages, Cloudflare Workers assets and Netlify read the file. The `node`
and `bun` adapters serve no static assets at all, so for them it is documentation of what a reverse
proxy must send — the build says so with a warning rather than skipping the file.

### 14.4 `.nojekyll`

Written unconditionally. GitHub Pages runs Jekyll, which excludes every `_`-prefixed path — which is
`_headers`, `_redirects`, `_worker.js`, `_routes.json` and `_islands/`. One empty file closes the
whole class of "works locally, half-broken on Pages", which is why it is not an adapter option.

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

| Standard                                                                                  | Class       | Binds      | Evidence                                                                                       | Note                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ----------- | ---------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RFC 4287](https://www.rfc-editor.org/rfc/rfc4287)                                        | **Subset**  | §6.7       | extensions/feed/src/atom.ts, extensions/feed/tests/feed.test.ts                                | Feed and entry documents carry the required `id`, `title` and `updated`, plus `self` and `alternate` links. Not implemented: `<category>`, `<contributor>`, `<rights>`, and Atom's own paging — RFC 5005 covers the last of those.                                                  |
| [JSON Feed 1.1](https://www.jsonfeed.org/version/1.1/)                                    | **Subset**  | §6.7       | extensions/feed/src/json-feed.ts, extensions/feed/tests/feed.test.ts                           | Feed identity, `language`, and per-item content, dates and authors. Attachments, tags, `banner_image` and hubs are not emitted; `next_url` is available but archives are offered in Atom alone rather than mixing two pagination conventions in one feed.                           |
| [RFC 5005](https://www.rfc-editor.org/rfc/rfc5005)                                        | **Subset**  | §6.7       | extensions/feed/src/feed.ts, extensions/feed/tests/feed.test.ts                                | The archived-feeds flavour (§2) plus `<fh:complete/>` (§4), which is the one designed for static hosting. Paged feeds (§3) are not offered: they are explicitly unstable for subscription, which is the only thing a static site publishes.                                         |
| [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)                                        | **Adopted** | §8.4.1     | packages/compiler/src/site/site-build.ts                                                       | A minimal `robots.txt` is created when none was provided, and an existing one is appended to rather than replaced. The `Sitemap:` line the build adds is a sitemaps.org extension, not part of this standard.                                                                       |
| [Sitemaps 0.9](https://www.sitemaps.org/protocol.html)                                    | **Subset**  | §8.4.1     | packages/compiler/src/site/site-build.ts, packages/compiler/tests/site-build.test.ts           | `gap:sitemap-fields` `<loc>` and a full RFC 3339 `<lastmod>`. No `<changefreq>` or `<priority>` — both are advisory and widely ignored — and no `xhtml:link` alternates, which §13 will need. A page generated from a template still reports the template's timestamp.              |
| [WHATWG URLPattern](https://urlpattern.spec.whatwg.org/)                                  | **Subset**  | §11.1      | packages/compiler/src/site/site-build.ts                                                       | Pattern strings are passed through to `_redirects` verbatim; the compiler neither parses nor validates them, so a malformed pattern is a deploy-time failure rather than a build-time one.                                                                                          |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)                                        | **Subset**  | §11.3      | packages/compiler/src/site/site-build.ts                                                       | `gap:redirect-status-codes` Only 301 and 302 are documented as redirects. 303, 307 and 308 are absent, so a redirect cannot preserve a request method. The `200` value listed alongside them is not a redirection status at all — it is the host's rewrite convention.              |
| [RFC 8288](https://www.rfc-editor.org/rfc/rfc8288)                                        | **Subset**  | §8.1, §8.3 | packages/compiler/src/site/head-merger.ts, packages/compiler/tests/head-merger.test.ts         | `gap:link-relation-validation` Link identity now accounts for the target attributes — `rel`, `href`, and whichever of `hreflang`, `type`, `media` or `sizes` distinguishes two links sharing the first two. `rel` values are still not checked against the IANA registry.           |
| [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/)                                           | **Subset**  | §8.5       | packages/compiler/src/site/head-merger.ts, packages/compiler/tests/head-merger.test.ts         | An object `textContent` is serialized into the tag and templates inside it resolve, so a document can carry structured data that references itself. Jx does not process the JSON-LD — no context expansion, no compaction, no framing; it is emitted for the consumer to interpret. |
| [BCP 47](https://www.rfc-editor.org/info/bcp47)                                           | **Pending** | §13        | —                                                                                              | `gap:site-locale-tags` `defaultLocale` and `locales` are declared and read by nothing, and no tag is validated or canonicalized.                                                                                                                                                    |
| [RFC 4647](https://www.rfc-editor.org/rfc/rfc4647)                                        | **Pending** | §13        | —                                                                                              | `gap:locale-lookup` Nothing selects a locale for a request. The routing modes §13.2 describes have no implementation, so the bare `/` cannot resolve to a visitor's language.                                                                                                       |
| [ECMA-402](https://ecma-international.org/publications-and-standards/standards/ecma-402/) | **Pending** | §13        | —                                                                                              | `gap:locale-formatting` No project locale reaches the formatting helpers, so a date or number formatted at build time uses the build machine's locale and the same source produces different output on different machines.                                                          |
| [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111)                                        | **Adopted** | §14.3      | packages/compiler/src/site/headers-emitter.ts, packages/compiler/tests/headers-emitter.test.ts | Every output declares its cacheability: `must-revalidate` for anything whose URL does not change with its content, and a year for the one output whose URL does.                                                                                                                    |
| [RFC 8246](https://www.rfc-editor.org/rfc/rfc8246)                                        | **Adopted** | §14.3      | packages/compiler/src/site/headers-emitter.ts, packages/compiler/tests/headers-emitter.test.ts | `immutable` is emitted for `/images/_optimized/*` alone. A test asserts no other path can acquire it, because every other filename is reused when its content changes.                                                                                                              |
| [RFC 6797](https://www.rfc-editor.org/rfc/rfc6797)                                        | **Subset**  | §14.3      | packages/compiler/src/site/headers-emitter.ts                                                  | Off by default and opt-in per project, with `max-age`, `includeSubDomains` and `preload`. `preload` without `includeSubDomains` is refused rather than emitted, since the preload list would reject it.                                                                             |
| [Referrer Policy](https://www.w3.org/TR/referrer-policy/)                                 | **Adopted** | §14.3      | packages/compiler/src/site/headers-emitter.ts                                                  | `strict-origin-when-cross-origin` by default; any policy token from the standard, or `false` to omit the header.                                                                                                                                                                    |
| [Permissions Policy](https://www.w3.org/TR/permissions-policy/)                           | **Subset**  | §14.3      | packages/compiler/src/site/headers-emitter.ts                                                  | A default deny-list for camera, microphone and geolocation is emitted, and the whole header is author-replaceable. The structured-field grammar is passed through rather than parsed.                                                                                               |

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
