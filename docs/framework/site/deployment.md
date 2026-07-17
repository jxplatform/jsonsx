---
title: "Build output and adapters"
description: "What bunx jx build writes to dist/, how trailingSlash shapes URLs, and the deployment adapters for static hosts, Cloudflare, Node, and Bun."
spec:
  - site-architecture.md#14
code:
  - packages/compiler/src/site/site-build.ts
  - packages/compiler/src/cli.ts
---

# Build output and adapters

`bunx jx build` turns a project into an ordinary folder of web files. The output is standard static HTML, CSS, and JS — deployable anywhere — and an optional adapter adds the platform-specific pieces for hosts that run a server.

Run it from the project root (or pass the root as an argument). `--verbose` prints per-route progress; `--no-clean` skips wiping the output directory first. The other CLI commands are covered in [the jx CLI](/docs/framework/build/cli).

## The dist/ contract

Everything lands in one directory:

```
dist/
├── index.html                # One HTML file per route
├── about/index.html
├── blog/hello-world/index.html
├── components/               # Compiled component JS + CSS sidecars
├── images/_optimized/        # Responsive image variants
├── sitemap.xml               # When url is set in project.json
├── robots.txt                # From public/, with a Sitemap: line appended
├── _redirects                # From the redirects map
├── favicon.svg               # public/ is copied in verbatim
└── worker.js                 # Only with a server adapter (see below)
```

Pages only load JavaScript for components that actually need it — a fully static component ships as pre-rendered HTML and CSS with no script. Files from `public/` are copied verbatim, and the `copy` map in `project.json` can place additional files at chosen output paths.

## Build options

The `build` section of `project.json`:

| Property        | Default    | What it does                                                       |
| --------------- | ---------- | ------------------------------------------------------------------ |
| `outDir`        | `"./dist"` | Output directory                                                   |
| `trailingSlash` | `"always"` | URL shape: `"always"` or `"never"` (below)                         |
| `sitemap`       | `true`     | Set `false` to skip [sitemap generation](/docs/framework/site/seo) |
| `adapter`       | _(none)_   | `"cloudflare-workers"`, `"cloudflare-pages"`, `"node"`, or `"bun"` |

### trailingSlash

`"always"` (the default) writes every route as a directory index — `/about` becomes `dist/about/index.html`, so the canonical served URL is `/about/`. `"never"` writes flat files — `dist/about.html` — for hosts that serve extensionless or `.html` URLs. Pick whichever matches how your host serves files, and keep it stable: changing it changes every URL on the site.

## Adapters

Without an adapter (the **Static** choice in Studio), the build is just `dist/` — HTML, CSS, JS, and assets for any static host or CDN. Setting `build.adapter` additionally packages the site's server functions (state entries with `timing: "server"`) into a single deployable worker:

| Adapter                | Extra output                                                              |
| ---------------------- | ------------------------------------------------------------------------- |
| _(none / static)_      | Nothing — plain `dist/`                                                   |
| `"cloudflare-workers"` | `dist/worker.js`, a Hono server that also serves the static assets        |
| `"cloudflare-pages"`   | `dist/_worker.js` + `dist/_routes.json`, only when server functions exist |
| `"node"` / `"bun"`     | `dist/worker.js`, a Hono server for that runtime                          |

Details worth knowing:

- Server functions are collected from every component and page, deduplicated by export name, and bundled once — there are no per-route server files when an adapter is set.
- The worker is **self-contained**: hono, extension mounts, database connectors, and your server modules are inlined at build time, so `dist/` deploys and runs with no `node_modules` and no deploy-time bundling step.
- On Cloudflare Pages, `_routes.json` limits worker invocation to `/_jx/*`, so static assets are served without waking the worker. A Pages site with no server functions gets no worker at all — the deployment stays purely static.
- A project with dynamic sections (connection-backed tables served by extension mounts) **must** set a server-capable adapter; the build fails on static, since a static site can't serve live data.
- Switching hosts means switching the adapter — your source never changes.

## Hooking up a host

The recipe is the same everywhere: build command `bunx jx build`, publish directory `dist`. [Other hosts](/docs/studio/publish/other-hosts) walks through Netlify and GitHub Pages, and [Cloudflare Pages](/docs/studio/publish/cloudflare) is built into Studio's publish flow.

## Related

- [The build pipeline](/docs/framework/build) — what happens between source and `dist/`
- [Redirects](/docs/framework/site/redirects) — the `_redirects` file in the output
- [SEO and metadata](/docs/framework/site/seo) — `sitemap.xml` and `robots.txt` generation
