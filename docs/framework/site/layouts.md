---
title: "Layouts"
description: "Shared page shells in Jx sites: $layout, slot injection, named slots, layout nesting, and how layout and page state merge."
spec:
  - site-architecture.md#5
code:
  - packages/compiler/src/site/layout-resolver.ts
---

# Layouts

> **Studio writes this format for you.** Layouts appear alongside pages and components in [Pages, layouts, components](/docs/studio/projects/pages-layouts-components), and you edit them on the same canvas.

A layout is an ordinary Jx document that provides the shell shared across pages, such as navigation, a footer and wrappers, with HTML `<slot>` elements marking where page content is injected. It is the same slot mechanism [components](/docs/framework/concepts/components) use, run at compile time instead of DOM time.

## Layout documents

A minimal layout registers its chrome components via `$elements` (paths relative to the layout file) and places one default `<slot>`:

```json
{
  "$elements": [{ "$ref": "../components/site-header.json" }],
  "tagName": "html",
  "children": [
    {
      "tagName": "body",
      "children": [
        { "tagName": "site-header" },
        { "tagName": "main", "children": [{ "tagName": "slot" }] }
      ]
    }
  ]
}
```

A layout doesn't have to own `<html>`. jxsuite.com's docs layout is a flex `<div>` with a sidebar; the compiler still wraps the result in a full HTML document with the merged `<head>`.

## Declaring a layout

Pages opt in with a top-level `$layout`, resolved from the **project root** (not the page's folder):

```json
{
  "$layout": "./layouts/base.json",
  "children": [{ "tagName": "h1", "textContent": "About us" }]
}
```

- If a page omits `$layout`, the site default from `project.json` `defaults.layout` applies.
- `"$layout": false` renders the page with no layout at all, which suits standalone landing pages and embeds.

The page's `children` are distributed into the layout's `<slot>` positions when the page compiles.

## Named slots

Layouts can define several regions by naming their slots:

```json
{
  "tagName": "body",
  "children": [
    {
      "tagName": "aside",
      "children": [{ "tagName": "slot", "attributes": { "name": "sidebar" } }]
    },
    { "tagName": "main", "children": [{ "tagName": "slot" }] }
  ]
}
```

Pages target a named slot with the standard `slot` attribute; children without one go to the default slot:

```json
{
  "$layout": "./layouts/docs.json",
  "children": [
    {
      "tagName": "nav",
      "attributes": { "slot": "sidebar" },
      "children": [{ "tagName": "a", "href": "/docs/intro", "textContent": "Intro" }]
    },
    { "tagName": "article", "children": [{ "tagName": "h1", "textContent": "Documentation" }] }
  ]
}
```

Per the HTML spec, a `<slot>`'s own children are fallback content, and they render only when the page supplies nothing for that slot.

## Nesting

A layout may declare its own `$layout`, composing shells:

```json
{
  "$layout": "./layouts/base.json",
  "children": [
    {
      "tagName": "aside",
      "children": [{ "tagName": "slot", "attributes": { "name": "sidebar" } }]
    },
    { "tagName": "article", "children": [{ "tagName": "slot" }] }
  ]
}
```

Saved as `layouts/blog-post.json`, this wraps blog pages in blog chrome while inheriting the site shell from `base.json`. Inner layouts resolve first, so the page's content threads through every level.

## What merges

Compiling a page against its layout produces one document:

- **Children**: page children are distributed into the layout's slots.
- **State**: the layout's `state` is kept and the page's is merged over it; **the page wins** on any shared key. Layouts can carry state of their own; jxsuite.com's docs layout loads the sidebar nav with a `ContentEntry`.
- **`$media`, `style`, `attributes`**: merged the same way, page over layout.
- **`$head`**: merged site → layout → page, later entries winning for singletons like `<title>`; see [SEO and metadata](/docs/framework/site/seo).

Layouts also receive the compiler-injected contexts: `$page` (`title`, `url`, `params`) and `$site` (`name`, `url`, plus site state). See [project.json](/docs/framework/site/project-json).

## Related

- [Routing](/docs/framework/site/routing): which pages exist and how they resolve
- [Components](/docs/framework/concepts/components): the runtime slot mechanism layouts reuse
- [SEO and metadata](/docs/framework/site/seo): the `$head` merge in detail
