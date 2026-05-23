---
title: Building a Blog with Jx
date: 2025-04-10
tags: [jx, blog, markdown]
published: true
author: Jane Smith
---

This guide walks through building a complete blog using Jx and `@jxsuite/md`.

## Project Structure

```
blog/
  blog.json          -- main layout component
  blog.js            -- client-side navigation handler
  content/
    posts/
      first-post.md
      second-post.md
```

## The Post Index

Use `MarkdownCollection` to load all posts as a sorted array:

```json
{
  "state": {
    "$posts": {
      "$prototype": "MarkdownCollection",
      "$src": "@jxsuite/md",
      "src": "./content/posts/*.md",
      "sortBy": "frontmatter.date",
      "sortOrder": "desc",
      "timing": "compiler"
    }
  }
}
```

## Rendering Individual Posts

Use `MarkdownFile` to parse a single post and inject its HTML body into your layout:

```json
{
  "$defs": {
    "$post": {
      "$prototype": "MarkdownFile",
      "$src": "@jxsuite/md",
      "src": "./content/posts/first-post.md",
      "timing": "compiler"
    }
  }
}
```

The `$body` property contains rendered HTML. Bind it to `innerHTML` of your article element.

## Frontmatter-Driven Layout

Every markdown file's YAML frontmatter is parsed and available as `frontmatter.*`:

- `frontmatter.title` -- used in `<h1>` and `<title>`
- `frontmatter.date` -- displayed in metadata
- `frontmatter.tags` -- drives tag filtering
- `frontmatter.author` -- byline

## Result

With `timing: "compiler"`, the entire blog compiles to static HTML with zero client-side JavaScript. Progressive enhancement is automatic.
