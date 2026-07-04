---
title: "Site Architecture — Jx Suite"
description: "File-based routing, layouts, content collections, and static site generation in Jx."
---

# Site Architecture

> **Studio manages this structure for you** — Manage maps to `pages/`, `components/`, and `content/`; the content-type builder writes `contentTypes`; the New Project deploy picker sets the adapter. This page documents the on-disk layout for reference.

Jx sites follow a conventional directory structure for file-based routing, shared layouts, content collections, and static site generation.

## Project Structure

```
my-site/
├── project.json           # Site configuration (required)
├── pages/                 # File-based routing (required)
│   ├── index.json         # → /
│   ├── about.json         # → /about
│   └── blog/
│       ├── index.json     # → /blog
│       └── [slug].json    # → /blog/:slug (dynamic)
├── layouts/               # Shared page shells
│   └── base.json
├── components/            # Reusable Jx components
├── content/               # Content collections
│   └── blog/
│       └── hello-world.md
├── public/                # Static assets (copied verbatim)
└── dist/                  # Build output (generated)
```

## File-Based Routing

Every `.json` file in `pages/` becomes a route automatically:

| File                        | URL           |
| --------------------------- | ------------- |
| `pages/index.json`          | `/`           |
| `pages/about.json`          | `/about`      |
| `pages/blog/[slug].json`    | `/blog/:slug` |
| `pages/docs/[...path].json` | `/docs/*`     |

## Layouts

Layouts use HTML `<slot>` elements to mark where page content is injected. Components are
registered via `$elements` (paths relative to the layout file) and used by tag name:

```json
{
  "$elements": [
    { "$ref": "../components/site-header.json" },
    { "$ref": "../components/site-footer.json" }
  ],
  "tagName": "html",
  "children": [
    {
      "tagName": "body",
      "children": [
        { "tagName": "site-header" },
        {
          "tagName": "main",
          "children": [{ "tagName": "slot" }]
        },
        { "tagName": "site-footer" }
      ]
    }
  ]
}
```

Pages declare their layout with `$layout` — the path is resolved from the **project root**:

```json
{
  "$layout": "./layouts/base.json",
  "children": [{ "tagName": "h1", "textContent": "About Us" }]
}
```

## Content Collections

Define collections in the `contentTypes` block of your `project.json`, with JSON Schema validation. (In Studio, the content-type builder writes this for you.)

```json
{
  "contentTypes": {
    "blog": {
      "source": "./content/blog/",
      "format": "Markdown",
      "schema": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "pubDate": { "type": "string", "format": "date" }
        },
        "required": ["title", "pubDate"]
      }
    }
  }
}
```

Query collections in pages via `$prototype`:

```json
{
  "state": {
    "posts": {
      "$prototype": "ContentCollection",
      "contentType": "blog",
      "sort": { "field": "pubDate", "order": "desc" }
    }
  }
}
```

## Build Pipeline

```
project.json → Discover pages/ → Resolve routes → Compile each page → Emit dist/
```

Run it with `bunx jx build`. All output is static HTML, CSS, and minimal JS in `dist/` — deploy to any static host, no server runtime required. Studio doesn't run this step: it commits and pushes your source, and your host (or CI) builds on push. See [Git & publish](/docs/git-publish).

## Deployment adapters

Set an adapter in `project.json` (Studio's New Project dialog picks it for you) to package the build for your target:

| Adapter        | Target                                               |
| -------------- | ---------------------------------------------------- |
| **Static**     | Plain `dist/` HTML/CSS/JS for any static host or CDN |
| **Cloudflare** | Cloudflare Pages                                     |
| **Node**       | A Node server bundle                                 |
| **Bun**        | A Bun server bundle                                  |

Switching hosts means switching the adapter — your source never changes.
