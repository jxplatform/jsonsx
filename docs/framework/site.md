---
title: "Site architecture"
description: "How a Jx site is laid out on disk: pages, layouts, components, content collections, public assets, and the project.json that ties them together."
spec:
  - site-architecture.md#2
---

# Site architecture

> **Studio manages this structure for you.** [The Library](/docs/studio/projects/browse) maps to `pages/`, `components/`, and `content/`; the [content-type builder](/docs/studio/projects/content-types) writes the `content` section; [Project settings](/docs/studio/projects/settings) edits `project.json`. This section documents the on-disk layout for reference.

A Jx site is a folder of plain JSON and Markdown files with a conventional layout. Only `project.json` and `pages/` are required; everything else is optional and additive.

## Project anatomy

```text
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
├── data/                  # Static data files
├── public/                # Static assets (copied verbatim)
└── dist/                  # Build output (generated)
```

| Directory     | Purpose                                                        | Required  |
| ------------- | -------------------------------------------------------------- | --------- |
| `pages/`      | File-based routing. Each page file becomes a route.            | **Yes**   |
| `layouts/`    | Layout components, referenced by pages via `$layout`.          | No        |
| `components/` | Reusable components, referenced via `$ref` or `$elements`.     | No        |
| `content/`    | Content collections with schema validation.                    | No        |
| `data/`       | Static data files loaded at build time. No schema enforcement. | No        |
| `public/`     | Static assets copied verbatim to `dist/`. No processing.       | No        |
| `dist/`       | Build output. Ignored by git.                                  | Generated |

Files and directories whose names start with `_` inside `pages/` are excluded from routing, so components can live next to the pages that use them (`pages/blog/_blog-card.json`).

## Configuration

`project.json` at the project root is the only required configuration file. It names the site, sets the default layout and language, declares global `<head>` entries, breakpoints, and design tokens, and holds the `content`, `redirects`, `copy`, and `build` sections, plus any section an enabled extension contributes: `connections` and `data` for databases, `auth` for visitor accounts, `search` for the build-time search index. Site-level `state` and `$defs` cascade into every page. See [project.json](/docs/framework/site/project-json).

## Routing

Every file in `pages/` becomes a route automatically: `pages/about.json` serves `/about`, `pages/blog/[slug].json` is a dynamic route with a `slug` parameter, and `pages/docs/[...path].json` catches everything under `/docs/`. Dynamic pages declare the concrete paths they generate with `$paths`, usually by pointing at a content collection. See [Routing](/docs/framework/site/routing).

## Layouts

Layouts are ordinary Jx documents that provide the shared page shell: navigation, footer, and the `<slot>` elements where page content lands. Pages opt in with `$layout`, or inherit the site default. Named slots, nesting, and state merging follow the same rules as custom elements. See [Layouts](/docs/framework/site/layouts).

## Content collections

The `content` section of `project.json` turns folders of Markdown, JSON, or CSV files into typed, queryable collections with JSON Schema validation. Pages query them with `ContentCollection` and `ContentEntry` state entries, and schema `$ref`s link entries across collections. See [Content collections](/docs/framework/site/content-collections) and [Relationships](/docs/framework/site/relationships).

## Markdown pages and content

Markdown is a first-class authoring format: content entries and even whole pages (`pages/index.md`) can be written in Jx Markdown, with frontmatter for metadata and directives for embedding components. See [Jx Markdown](/docs/framework/site/jx-markdown).

## SEO and metadata

Pages declare `<head>` entries with `$head`, merged in a fixed order with layout- and site-level entries; titles, canonical URLs, sitemaps, and structured data are handled at build time. See [SEO and metadata](/docs/framework/site/seo).

## Images

Images referenced from pages and content are optimized during the build, resized to multiple widths and re-encoded to modern formats, configured by the `images` section of `project.json`. See [Images](/docs/framework/site/images).

## Redirects

The `redirects` map in `project.json` declares old-URL-to-new-URL rules, including `:param` patterns and per-rule HTTP status codes. See [Redirects](/docs/framework/site/redirects).

## Databases, accounts, and server functions

Not everything a site shows has to be a file. With the `@jxsuite/connector` extension enabled, `connections` names the databases the site talks to and `data` declares the tables inside them, served over `/_jx/data`; with `@jxsuite/auth`, the `auth` section gives visitors accounts and sessions at `/_jx/auth` and unlocks the table permission rules that depend on knowing who is asking. Separately, any `state` entry marked `timing: "server"` compiles into its own route at `/_jx/server/<export>`, so secrets and privileged calls stay off the client. The connection-backed sections require a server-capable `build.adapter`, and the build stops without one; server functions need somewhere to run for the same reason. See [Databases](/docs/studio/data), [Auth and secrets](/docs/studio/data/auth-and-secrets), and [Timing](/docs/framework/concepts/timing).

## Building and deploying

`bunx jx build` discovers routes, compiles each page, and emits static HTML, CSS, and minimal JS into `dist/`, deployable to any static host. With `build.adapter` set, the same command also bundles the site's server tier, meaning `timing: "server"` functions and extension mounts such as `/_jx/data` and `/_jx/auth`, into one self-contained worker. Pages are prerendered either way; the worker only answers `/_jx/*` and, on some adapters, serves the static files. See [the build pipeline](/docs/framework/build) and [Deployment](/docs/framework/site/deployment); Studio itself never runs this step; it [commits and pushes your source](/docs/studio/publish), and your host builds on push.
