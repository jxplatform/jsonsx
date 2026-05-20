# Jx Site Architecture Specification

## File-Based Routing, Content Collections, Layouts, and Static Site Generation

**Version:** 1.0.0-draft
**Status:** Proposed
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

---

## 1. Vision

Jx Studio is a visual IDE for the development and management of local-first, statically compiled applications and websites which are composed and deployed via the Jx schema and pipeline.

### 1.1 Design Principles

1. **File-based is canonical.** The filesystem is the source of truth. Every page, component, layout, and content entry has a location on disk. There is no database, no CMS backend, no proprietary store. Studio is a filesystem editor with a visual canvas.

2. **Convention over configuration.** Sensible defaults derived from well-known prior art (Astro, Next.js, Eleventy). A `pages/` directory means file-based routing. A `content/` directory means content collections. A `layouts/` directory means shared page shells. Zero configuration required — but overridable.

3. **Static-first.** All output is static HTML/CSS/JS. The compiler processes every page at build time. No server runtime ships by default. Server functions (`timing: "server"`) are an opt-in escape hatch, compiled to standalone handlers.

4. **JSON all the way down.** Site configuration is JSON. Page templates are JSON. Content schemas are JSON Schema. Layouts are JSON. The only non-JSON files are content entries (Markdown, CSV, media) and user-authored JavaScript sidecar functions. This makes the entire project machine-readable and Studio-editable.

5. **Local-first.** No cloud services required. The dev server runs on localhost. The build writes to a `dist/` folder. Deployment is a static file upload to any host.

### 1.2 What This Spec Covers

This spec defines everything that sits _above_ the component model: how components compose into pages, how pages compose into sites, how content enters the system, and how Studio manages all of it. It answers:

- How to compose a new site with Jx
- How to define datatypes and content collections
- How to manage (add/edit/delete) data in Studio
- How templates (Jx) and datasets (Markdown, CSV, media) correlate on the filesystem
- How to bake SEO metadata into pages
- How to manage redirects, rewrites, and other CMS concerns
- How to manage media assets
- How the inheritance model works (global styles, variables, `<head>` tags, application-wide state)

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
├── content/                     # Content collections
│   ├── project.json `collections`      # Collection schemas
│   ├── blog/                    # "blog" collection
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
    { "tagName": "meta", "name": "viewport", "content": "width=device-width, initial-scale=1" },
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
    ":root": {
      "--color-primary": "#3b82f6",
      "--color-surface": "#ffffff",
      "--font-sans": "Inter, system-ui, sans-serif",
      "--font-mono": "JetBrains Mono, monospace"
    },
    "@--dark": {
      ":root": {
        "--color-surface": "#0f172a"
      }
    }
  },

  "state": {
    "siteName": "My Site",
    "socialLinks": [
      { "label": "GitHub", "url": "https://github.com/example" },
      { "label": "Twitter", "url": "https://twitter.com/example" }
    ]
  },

  "imports": {
    "MarkdownCollection": "@jxsuite/parser",
    "MarkdownFile": "@jxsuite/parser"
  },

  "redirects": {
    "/old-blog": "/blog",
    "/legacy/post/:slug": { "destination": "/blog/:slug", "status": 301 }
  },

  "build": {
    "outDir": "./dist",
    "format": "directory",
    "trailingSlash": "always",
    "adapter": "cloudflare"
  }
}
```

### 3.1 Configuration Properties

| Property           | Type     | Description                                                         |
| ------------------ | -------- | ------------------------------------------------------------------- |
| `name`             | `string` | Site name, used in default `<title>` and meta tags                  |
| `url`              | `string` | Production URL, used for canonical URLs and sitemap generation      |
| `defaults.layout`  | `string` | Default layout applied to all pages that don't specify `$layout`    |
| `defaults.lang`    | `string` | Default `<html lang>` attribute                                     |
| `defaults.charset` | `string` | Default charset (always `utf-8`)                                    |
| `$head`            | `array`  | Global `<head>` elements injected into every page                   |
| `$media`           | `object` | Named media query breakpoints, available to all components          |
| `style`            | `object` | Root-level CSS custom properties and global styles                  |
| `state`            | `object` | Site-wide state accessible to all pages and components              |
| `redirects`        | `object` | Static redirect rules (see §11)                                     |
| `imports`          | `object` | Import map: `$prototype` name → `.class.json` path (see spec §12.4) |
| `build`            | `object` | Build output configuration (see §14)                                |
| `images`           | `object` | Image optimization settings (see §9.2)                              |

### 3.2 Inheritance

Site-level declarations cascade to all pages:

- `$head` entries are prepended to every page's `<head>`
- `$media` breakpoints are available in every component's style objects
- `style` rules on the root (`:root` selectors) produce global CSS custom properties
- `state` entries are available to every page (read-only from the page's perspective)
- `imports` entries cascade to all pages; page-level entries take precedence on collision

Pages may override any inherited value. A page declaring its own `$head` entries appends to (does not replace) the site-level `$head`. A page may shadow a site-level `state` entry with its own.

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

Inside a dynamic page, route parameters are available via `$params`:

```json
{
  "textContent": "Viewing post: ${$params.slug}"
}
```

`$params` is a read-only object injected by the compiler. In static builds, template strings referencing `$params` are resolved at compile time to literal values.

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
        { "tagName": "meta", "name": "viewport", "content": "width=device-width, initial-scale=1" },
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
  "$layout": "../layouts/base.json",
  "$head": [
    { "tagName": "title", "textContent": "About Us" },
    { "tagName": "meta", "name": "description", "content": "Learn about our company" }
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
  "$layout": "../layouts/docs.json",
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
  "$layout": "./base.json",
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

Collections are defined in `the `collections` key in project.json`:

```json
{
  "$schema": "https://jxsuite.com/schema/project/v1",
  "contentTypes": {
    "blog": {
      "source": "./blog/**/*.md",
      "schema": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "description": { "type": "string" },
          "pubDate": { "type": "string", "format": "date" },
          "updatedDate": { "type": "string", "format": "date" },
          "author": { "$ref": "#/collections/authors" },
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
      "source": "./authors/*.json",
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
      "source": "./products/catalog.csv",
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

### 6.2 Collection Shapes

| Source Pattern | File Type                 | Entry ID               | Notes                                |
| -------------- | ------------------------- | ---------------------- | ------------------------------------ |
| `**/*.md`      | Markdown with frontmatter | Filename (slugified)   | Body parsed to Jx tree (`$children`) |
| `**/*.json`    | JSON objects              | `id` field or filename | Direct data access                   |
| `*.csv`        | CSV rows                  | Row index or ID column | Parsed via built-in CSV parser       |
| `**/*.yaml`    | YAML documents            | `id` field or filename | Parsed via built-in YAML parser      |

### 6.3 Schema Validation

Collection schemas are standard JSON Schema. The `@jxsuite/schema` package already generates JSON Schema from web platform IDL — the same infrastructure validates content entries.

At build time:

- Every content entry is validated against its collection schema
- Missing required fields produce compile errors with file path and line number
- Type mismatches are reported with expected vs actual types
- The `$ref` between collections (e.g., `author` referencing `authors` collection) is resolved and validated

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
  "data": { "title": "Hello World", "pubDate": "2024-01-15", "tags": ["intro"] },
  "body": "# Hello\n\nThis is my first post.",
  "$children": [
    { "tagName": "h1", "textContent": "Hello" },
    { "tagName": "p", "textContent": "This is my first post." }
  ]
}
```

#### Collection References

The `$ref` syntax in schemas creates cross-collection links:

```json
{
  "author": { "$ref": "#/collections/authors" }
}
```

In a Markdown frontmatter:

```yaml
---
title: My Post
author: jane-doe
---
```

The value `"jane-doe"` is resolved at build time to the matching entry in the `authors` collection by its `id`. Templates can then access `state.post.data.author.data.name`.

### 6.5 Filesystem Correlation

The filesystem structure directly mirrors the logical model:

```
content/
├── project.json `collections`          # Schema definitions for all collections
├── blog/                        # "blog" collection
│   ├── hello-world.md           # Entry: id = "hello-world"
│   ├── second-post.md           # Entry: id = "second-post"
│   └── images/                  # Co-located media for blog posts
│       ├── hello-hero.jpg       # Referenced as "./images/hello-hero.jpg"
│       └── second-hero.png
├── authors/                     # "authors" collection
│   └── authors.json             # All author entries in one file
└── products/                    # "products" collection
    └── catalog.csv              # All product entries in one file
```

**Key rules:**

- One directory per collection (named after the collection)
- For glob-based collections (`**/*.md`), each file is one entry
- For file-based collections (`*.json`, `*.csv`), one file contains many entries
- Media can be co-located next to content entries
- The collection directory name matches the key in `project.json `collections``

---

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

The Browse view serves as the current collection browser. Future enhancements:

| View              | Status          | Description                                                                              |
| ----------------- | --------------- | ---------------------------------------------------------------------------------------- |
| **Table view**    | **Implemented** | File listing with Name, Category, Type, Path columns. Filterable by category and search. |
| **Card view**     | Planned         | Visual card layout with hero image, title, and summary. Good for blog posts.             |
| **Calendar view** | Planned         | Date-sorted timeline. Useful for date-based collections (blog, events).                  |

The view mode will be selectable per collection. Studio will remember the preference.

### 7.3 Markdown WYSIWYG Editing (Implemented)

Markdown files (`.md`) open in **content mode** — a centered column WYSIWYG canvas where headings, paragraphs, lists, and other block elements are directly editable:

- **Inline rich text:** Click any text block to edit. `Cmd+B` (bold), `Cmd+I` (italic), `Cmd+\`` (code), plus toolbar buttons for `strong`, `em`, `del`, `sub`, `sup`, `u`.
- **Slash commands:** Type `/` in any block to insert headings, paragraphs, lists, blockquotes, images, tables, code blocks, horizontal rules, etc.
- **Bidirectional MD ↔ Jx conversion:** Markdown AST (`remark-parse`) converts to the Jx tree for canvas rendering; on save, the tree converts back to Markdown (`remark-stringify`) with frontmatter preserved.
- **Frontmatter round-trip:** YAML frontmatter is parsed on load (`S.content.frontmatter`) and serialized back on save. Currently stored but not editable via a UI form (see §7.4).

### 7.4 Content Entry Editor

#### Frontmatter Form (Not Yet Implemented)

When a markdown content entry belongs to a collection with a defined schema, the **right panel** should render a schema-driven form for editing frontmatter fields. This reuses the existing `widgetForType()` / `inferInputType()` pattern already used for HTML attribute editing:

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

#### JSON Data Entry Editing (Not Yet Implemented)

JSON content entries (e.g., `authors/authors.json`) should open a form-based editor generated from the collection's JSON Schema, reusing the same widget mapping.

#### CSV Editing (Not Yet Implemented)

CSV content entries should render as an inline table editor using `<sp-table>` with column types derived from the schema.

### 7.5 Content CRUD Operations

| Operation       | Status          | Action                                                                                                                                                                              |
| --------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create**      | Planned         | "New Entry" button on collection. Creates a file with schema defaults. For Markdown, creates a file with frontmatter stub. Studio assigns a slug from the title or prompts for one. |
| **Read**        | **Implemented** | Browse view lists all content files; clicking opens in WYSIWYG (Markdown) or component editor (JSON).                                                                               |
| **Update**      | **Partial**     | Markdown body editable via WYSIWYG canvas. Frontmatter and JSON data forms not yet available.                                                                                       |
| **Delete**      | Planned         | Context menu → Delete. Confirms with dialog. Removes the file from disk.                                                                                                            |
| **Rename/Move** | Planned         | Context menu → Rename. Updates filename (and therefore entry ID/slug). Warns if other entries reference this ID.                                                                    |

### 7.6 Draft Workflow

Entries with `"draft": true` (a conventional boolean field in the schema):

- Shown with a "Draft" badge in the collection browser
- Excluded from production builds by default
- Included in dev server builds for preview
- Filterable in the collection browser

---

## 8. SEO & Metadata

Every page compiles with proper SEO metadata. The system is declarative — no imperative code required.

### 8.1 Page-Level `$head`

Pages declare metadata via `$head`. The compiler resolves these into `<head>` elements:

```json
{
  "$head": [
    { "tagName": "title", "textContent": "My Blog Post — My Site" },
    { "tagName": "meta", "name": "description", "content": "A great blog post about things" },
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
    { "tagName": "meta", "name": "twitter:card", "content": "summary_large_image" },
    { "tagName": "link", "rel": "canonical", "href": "https://example.com/blog/my-post" }
  ]
}
```

### 8.2 Templated Metadata

Metadata values support template strings referencing state and `$params`:

```json
{
  "$head": [
    { "tagName": "title", "textContent": "${state.post.data.title} — ${$site.name}" },
    { "tagName": "meta", "name": "description", "content": "${state.post.data.description}" },
    { "tagName": "link", "rel": "canonical", "href": "${$site.url}/blog/${$params.slug}" }
  ]
}
```

For content-driven pages, metadata comes directly from the content entry's frontmatter — no duplication.

### 8.3 Head Merge Order

The compiler assembles `<head>` content from three sources, in order:

1. **Site-level** (`project.json` `$head`) — global meta tags, fonts, icons
2. **Layout-level** (layout's `<head>` children) — charset, viewport, structural tags
3. **Page-level** (page's `$head`) — page-specific title, description, OG tags

Later entries can override earlier entries. If both site and page define a `<title>`, the page's wins. Deduplication is by `tagName` + identifying attribute (`name`, `property`, `rel`).

### 8.4 Automatic SEO

The compiler automatically generates certain tags if not explicitly declared:

| Auto-generated                   | Condition                                     |
| -------------------------------- | --------------------------------------------- |
| `<link rel="canonical">`         | Always, from `$site.url` + page path          |
| `<meta property="og:url">`       | Always, matches canonical                     |
| `<meta property="og:site_name">` | From `$site.name`                             |
| `<html lang>`                    | From page or site `lang`                      |
| Sitemap entry                    | All non-draft pages included in `sitemap.xml` |

### 8.5 Structured Data (JSON-LD)

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

> **Current status:** Not yet implemented. The compiler handles `$head` merge (§8.3) at build time, but Studio has no visual SEO editing UI.

The Studio inspector will include an "SEO" tab for any page or content entry:

- **Title preview:** Shows how the title will appear in Google search results (truncated to ~60 chars)
- **Description preview:** Shows the meta description (truncated to ~155 chars)
- **OG preview:** Renders a social media card preview (Facebook/Twitter)
- **Schema.org editor:** Form-based JSON-LD editor for structured data
- **Warnings:** Missing title, missing description, description too long, missing OG image

---

## 9. Media Management

### 9.1 Media Organization

Media files live in two locations:

| Location                            | Purpose                                     | Processing                 |
| ----------------------------------- | ------------------------------------------- | -------------------------- |
| `public/`                           | Global static assets (favicon, fonts, PDFs) | Copied verbatim to `dist/` |
| `content/*/images/` (or co-located) | Collection-specific media                   | Optimized at build time    |

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
    "lazyLoad": true
  }
}
```

| Property   | Type       | Default                                     | Description                                                    |
| ---------- | ---------- | ------------------------------------------- | -------------------------------------------------------------- |
| `optimize` | `boolean`  | `true`                                      | Master switch — set to `false` to disable all image processing |
| `widths`   | `number[]` | `[320, 640, 960, 1280, 1920]`               | Pixel widths for responsive `srcset` variants                  |
| `formats`  | `string[]` | `["webp", "avif"]`                          | Output formats (also supports `"jpeg"`, `"png"`)               |
| `quality`  | `object`   | `{ webp: 80, avif: 65, jpeg: 80, png: 80 }` | Per-format compression quality (0–100)                         |
| `sizes`    | `string`   | `"(max-width: 768px) 100vw, 50vw"`          | Default CSS `sizes` attribute for responsive hints             |
| `lazyLoad` | `boolean`  | `true`                                      | Adds `loading="lazy"` and `decoding="async"` to `<img>` tags   |

#### 9.2.2 Build-Time Behavior

When `optimize: true`, the compiler processes every `<img>` node during page compilation:

1. **Width filtering** — Only generates variants at widths ≤ the source image's natural width. The original width is always included as a breakpoint.
2. **Format conversion** — Each width × format combination produces an optimized variant via Sharp.
3. **Output path** — Variants are written to `dist/images/_optimized/{stem}-{width}-{hash}.{format}` (e.g., `hero-640-a1b2c3d4.webp`).
4. **Attribute injection** — The compiler mutates the `<img>` node to add:
   - `srcset` — responsive variant list (e.g., `hero-320-a1b2.avif 320w, hero-640-a1b2.avif 640w, ...`)
   - `sizes` — from config (unless the node already specifies one)
   - `width` and `height` — original image dimensions (prevents layout shift)
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

- **Cache location:** `.jx-cache/images/manifest.json`
- **Cache key:** `{contentHash}:{configHash}` — MD5 of the source file contents combined with MD5 of the optimization config (`widths`, `formats`, `quality`)
- **Invalidation:** A cache entry is invalidated when the source image changes (new content hash), the optimization config changes (new config hash), or the output variant files are missing from `dist/`
- **Persistence:** The cache file survives `dist/` cleanup — only the variant files are regenerated

The `.jx-cache/` directory should be added to `.gitignore` but can optionally be committed for CI build speed.

### 9.3 Referencing Media

In Jx documents:

```json
{
  "tagName": "img",
  "src": "../content/blog/images/hero.jpg",
  "alt": "A hero image"
}
```

In Markdown frontmatter:

```yaml
heroImage: ./images/hero.jpg
```

In Markdown body:

```markdown
![Alt text](./images/diagram.png)
```

All paths are relative to the referring file. The compiler resolves them to final output URLs.

### 9.4 Studio Media Browser

> **Current status:** The Browse view's "Media" category filter lists all media files by extension (regardless of directory). The features below are planned enhancements.

Studio will provide a media management panel accessible from:

- The file picker widget (when editing a `uri-reference` schema field)
- The Browse view's "Media" category (currently a flat table; planned upgrade to grid)

Planned features:

- **Grid/list view** of all media in the project (thumbnail grid as default, table as alternative)
- **Upload** — drag-and-drop files into the browser. Files are placed in the selected directory.
- **Preview** — thumbnail preview for images, video, audio players
- **Metadata** — file size, dimensions, format shown
- **Usage tracking** — shows which content entries and components reference each file
- **Delete** — warns if the file is referenced by content or components

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

1. **CSS Custom Properties** — Defined in `project.json` `style[":root"]`, they cascade through the DOM naturally. Every component can reference `var(--color-primary)` without importing anything.

2. **Named media breakpoints** — `$media` from `project.json` is available in every component's style objects. A component can use `"@--md": { ... }` without knowing where `--md` was defined.

3. **`<head>` entries** — Site-level `$head` entries (fonts, viewport, icons) are included in every page automatically.

4. **Language** — `defaults.lang` from `project.json` sets `<html lang>` on every page.

5. **Global stylesheet rules** — Root-level `style` rules from `project.json` (not just `:root` custom properties, but any global selectors) are applied to all pages and cascaded into all rendered contexts including Studio's canvas and stylebook.

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

1. Site-level `:root` custom properties
2. Site-level responsive (`@--dark`, etc.) overrides
3. Layout-level styles
4. Page-level styles
5. Component-level styles (scoped to custom element shadow DOM or via class namespacing)

This follows the natural CSS cascade — more specific sources override less specific ones.

---

## 11. Redirect & Rewrite Management

> **Standards note:** Redirect pattern strings use [URLPattern pathname syntax](https://urlpattern.spec.whatwg.org/#pattern-strings) (`:param` named groups, `*` wildcards, `?` optional modifiers). The compiler validates all patterns via `new URLPattern({ pathname: source })` at build time.

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

The compiler outputs redirect pages as HTML files with `<meta http-equiv="refresh">` tags, and also generates a redirect map file (`_redirects` for Netlify, `vercel.json` for Vercel, etc.) based on the build target.

### 11.2 Dynamic Parameters

Redirect rules support `:param` and `*` wildcard syntax:

```json
{
  "/blog/:year/:slug": "/posts/:slug",
  "/docs/v1/*": "/docs/v2/*"
}
```

### 11.3 Status Codes

```json
{
  "/moved-permanently": { "destination": "/new-location", "status": 301 },
  "/temporary-redirect": { "destination": "/other-page", "status": 302 },
  "/api/*": { "destination": "https://api.example.com/*", "status": 200 }
}
```

Status 200 redirects function as rewrites (proxy-style).

### 11.4 Studio Redirect Editor

> **Current status:** Not yet implemented. The compiler generates `_redirects` and HTML meta-refresh files from `project.json` redirect rules at build time, but Studio has no visual editor for managing them.

Studio will provide a dedicated redirect management UI under site settings:

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
    Compile             → existing compiler routes (static/dynamic/custom-element)
    ↓
Bundle server entries   → dist/worker.js (if adapter set, else per-route _server.js)
    ↓
Emit dist/
    ├── index.html
    ├── about/index.html
    ├── blog/hello-world/index.html
    ├── _assets/
    │   ├── styles.css
    │   └── client.js
    ├── images/
    │   └── _optimized/         (responsive image variants)
    ├── sitemap.xml
    └── _redirects
dist/worker.js              (inside dist/, if adapter set)
```

### 12.2 Build Commands

```bash
# Development
jx dev                   # Start dev server with live reload

# Production build
jx build                 # Full static site build

# Preview production build
jx preview               # Serve dist/ locally
```

These are thin wrappers around `@jxsuite/server` (dev) and a new `@jxsuite/build` entry point that will invoke the compiler in multi-page mode.

### 12.3 Incremental Builds

The build system tracks dependencies between files. When a content entry changes, only pages that reference that collection are recompiled. When a layout changes, all pages using that layout are recompiled. When `project.json` changes, everything is recompiled.

### 12.4 Asset Pipeline

Static assets are collected and deduplicated:

- **CSS:** All page and component styles are extracted, concatenated, and minified into one or more CSS files
- **JS:** Client-side reactive code is bundled per-page (code-splitting at page boundaries)
- **Images:** Optimized images are placed in `_assets/` with content-hash filenames for caching
- **Fonts:** Copied from `public/` or optimized (subset, convert to woff2)

---

## 13. Internationalization

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
    "source": "./blog/{locale}/**/*.md",
    "schema": { "...": "..." }
  }
}
```

---

## 14. Deployment

### 14.1 Output Targets

The build output is standard static files deployable anywhere. When `build.adapter` is set, the compiler additionally generates platform-specific files:

| Provider         | Extra Output                                                     |
| ---------------- | ---------------------------------------------------------------- |
| _(none)_         | Just `dist/` with HTML/CSS/JS/assets                             |
| `"cloudflare"`   | `dist/worker.js` (Hono server with asset fallback), `_redirects` |
| `"netlify"`      | `_redirects`, `_headers`                                         |
| `"vercel"`       | `vercel.json` with redirects/headers                             |
| `"github-pages"` | `.nojekyll`, 404.html                                            |

Configured in `project.json`:

```json
{
  "build": {
    "adapter": "cloudflare"
  }
}
```

#### 14.1.1 `build.adapter` Properties

| Property        | Type             | Default       | Description                                                                                      |
| --------------- | ---------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `outDir`        | `string`         | `"./dist"`    | Output directory for static assets                                                               |
| `format`        | `string`         | `"directory"` | URL format: `"directory"` (trailing slash) or `"file"`                                           |
| `trailingSlash` | `string`         | `"always"`    | `"always"` or `"never"`                                                                          |
| `adapter`       | `string \| null` | `null`        | Deployment adapter: `"cloudflare"`, `"netlify"`, `"vercel"`, `"github-pages"`, `"node"`, `"bun"` |

When `adapter` is set and the site contains `timing: "server"` entries, the compiler:

1. Collects all server entries from components and pages
2. Deduplicates by export name
3. Skips per-route `_server.js` generation
4. Emits a single `dist/worker.js` via `compileSiteServer()`
5. Adds adapter-specific boilerplate (e.g., Cloudflare asset fallback via `c.env.ASSETS.fetch()`)

The generated `dist/worker.js` is a build artifact inside `dist/` and is excluded by the standard `dist/` gitignore rule.

### 14.2 Build Artifacts

```
dist/
├── index.html                   # Static HTML page
├── about/
│   └── index.html
├── blog/
│   ├── index.html
│   ├── hello-world/
│   │   └── index.html
│   └── second-post/
│       └── index.html
├── _assets/
│   ├── style.a1b2c3.css         # Hashed for cache busting
│   ├── client.d4e5f6.js
│   └── images/
│       ├── hero.g7h8i9.webp
│       └── hero.g7h8i9.avif
├── images/
│   └── _optimized/              # Responsive image variants
│       ├── hero-320-a1b2c3d4.webp
│       ├── hero-640-a1b2c3d4.webp
│       ├── hero-320-a1b2c3d4.avif
│       └── hero-640-a1b2c3d4.avif
├── sitemap.xml                  # Auto-generated
├── robots.txt                   # Copied from public/
├── favicon.svg                  # Copied from public/
├── _redirects                   # Platform-specific
└── worker.js                    # Server worker (when adapter set + server entries exist)
```

---

## Appendix A: New Keywords Summary

This spec introduces the following new reserved keywords:

| Keyword             | Context            | Purpose                                 |
| ------------------- | ------------------ | --------------------------------------- |
| `$layout`           | Page root          | Specifies the layout wrapping this page |
| `$paths`            | Page root          | Dynamic route parameter generation      |
| `$params`           | Template string    | Route parameters (read-only)            |
| `$page`             | Template string    | Page metadata context                   |
| `$site`             | Template string    | Site metadata context                   |
| `$head`             | Page/site root     | `<head>` element declarations           |
| `ContentCollection` | `$prototype` value | Collection query                        |
| `ContentEntry`      | `$prototype` value | Single entry access                     |

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
- [x] `project.json` `collections` schema validation
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
- [ ] Sitemap generation (`sitemap.xml` from route table)
- [ ] Incremental builds (dependency tracking, selective recompilation)
- [x] Platform adapters — `build.adapter` for site-wide server bundling (Cloudflare implemented)
- [ ] Platform-specific file generation (Netlify `_headers`, Vercel `vercel.json`, GitHub Pages `.nojekyll`)

### Phase 5: Advanced

- [ ] Internationalization routing (locale prefix, default locale handling)
- [ ] Content localization (per-locale content directories)
- [ ] Pagination helpers
- [ ] RSS/Atom feed generation
- [ ] Search index generation
