---
title: "Site Building in Studio — Jx Suite"
description: "Learn how to build complete sites in JX Studio: project structure, pages, layouts, slots, content collections, and the file-tree explorer."
---

# Site Building in Studio

> For the underlying architecture, see [Site Architecture](/docs/site-architecture).

A JX site is a collection of pages, layouts, components, and content — all stored as plain files in a git-tracked directory. Studio's file explorer and site tools make it easy to manage.

## Project Structure

Every JX site follows this directory structure. Each folder has a specific purpose:

```
my-site/
├── project.json        ← Site config: name, URL, design tokens, $media, $head
├── package.json        ← Dependencies (@jxsuite/compiler, @jxsuite/parser)
├── pages/              ← Site pages (*.json, *.md)
│   ├── index.json      ← Homepage
│   └── about.json      ← About page
├── layouts/            ← Page layouts (shell, docs layout, etc.)
│   ├── base.json       ← Default layout with toolbar + footer + slot
│   └── docs.json       ← Documentation layout with sidebar
├── components/         ← Reusable components
│   ├── header.json     ← Site header/navbar
│   ├── footer.json     ← Site footer
│   └── card.json       ← Content card component
├── content/            ← Content collections
│   ├── posts/          ← Blog posts (Markdown files)
│   └── products/       ← Product entries
└── public/             ← Static assets
    ├── favicon.svg
    └── images/
```

## project.json — Site Configuration

The project.json file is the central configuration for your entire site. It defines the site name, URL, design tokens, breakpoints, head elements, and more.

- **name & url** — Site name and production URL. Used by the compiler for SEO metadata, sitemaps, and canonical URLs. The URL is the base for all generated links.
- **style (Design Tokens)** — CSS custom properties that apply globally. Every component and page inherits these tokens. Also supports table styles, nested selectors, and pseudo-classes.
- **$media** — Responsive breakpoints used across the site. The `--` breakpoint is the default viewport width. Named breakpoints define media queries for responsive overrides.
- **$head** — Elements injected into every page's head: meta tags, link tags (favicon, fonts), viewport, generator tag. Each page can add its own `$head` entries that merge with these.
- **defaults** — Default layout for pages, default language (en), and other site-wide defaults. Pages can override these with their own `$layout` or `lang` fields.
- **imports** — Register format classes and plugins. Common imports: Markdown (for .md pages), MarkdownCollection (for content collections). Classes are discovered automatically.

## Layouts & Slots

Layouts are reusable page shells. They define the outer structure (header, footer, sidebar) and a slot element where the page content is inserted.

```json
// layouts/base.json
{
  "tagName": "div",
  "$elements": [
    { "$ref": "../components/header.json" },
    { "$ref": "../components/footer.json" }
  ],
  "children": [
    { "tagName": "site-header" },
    {
      "tagName": "main",
      "style": { "flex": "1" },
      "children": [{ "tagName": "slot" }]
    },
    { "tagName": "site-footer" }
  ]
}

// Any page using this layout:
{
  "title": "My Page",
  "$layout": "./layouts/base.json",
  "tagName": "div",
  "children": [ ... ]
}
```

The page's children replace the `slot` element in the layout.

## Content Collections

Content collections are folders of Markdown files that the compiler processes into pages. Each file in a collection becomes a route on your site. Frontmatter fields become page data.

Use content collections for blog posts, documentation articles, product listings, or any content that follows a repeating pattern. The MarkdownCollection class handles discovery, parsing, and routing automatically.

## Files Panel & Project Explorer

- **Open Files** — Click any .json or .md file to open it in the canvas. The file's content renders live. Make changes and save with Ctrl+S. The tab strip shows all open files.
- **Create Files & Folders** — Right-click any folder → New File or New Folder. Name your file with the appropriate extension. Components auto-register when placed in the components/ folder.
- **Site Context Inheritance** — When a project is open, all files inherit the site context: design tokens, breakpoints, global styles. The canvas shows exactly how each component renders within the full site.

---

**Next:** [Keyboard Shortcuts](/docs/studio-shortcuts)
