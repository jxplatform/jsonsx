---
title: "Site Architecture — Jx Suite"
description: "File-based routing, layouts, content collections, and static site generation in Jx."
---

# Site Architecture

Jx sites follow a conventional directory structure for file-based routing, shared layouts, content collections, and static site generation.

## Project Structure

```
my-site/
├── site.json              # Site configuration (required)
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

Define collections in `content/content.config.json` with JSON Schema validation:

```json
{
  "contentTypes": {
    "blog": {
      "source": "./content/blog/",
      "format": "md",
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
site.json → Discover pages/ → Resolve routes → Compile each page → Emit dist/
```

All output is static HTML/CSS/JS. Deploy to any static host — Netlify, Vercel, Cloudflare Pages, or a plain web server. No server runtime required.

## Deployment

The build output supports platform-specific files:

| Platform         | Extra Output             |
| ---------------- | ------------------------ |
| Generic          | `dist/` with HTML/CSS/JS |
| Netlify          | `_redirects`, `_headers` |
| Vercel           | `vercel.json`            |
| Cloudflare Pages | `_redirects`, `_headers` |
| GitHub Pages     | `.nojekyll`, `404.html`  |
