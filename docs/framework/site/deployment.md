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

Without an adapter (the **Static** choice in Studio), the build is just `dist/` — HTML, CSS, JS, and assets for any static host or CDN. Setting `build.adapter` additionally packages the site's server tier — state entries with `timing: "server"`, plus the server mounts of enabled extensions — into a single deployable worker:

| Adapter                | Extra output                                                              |
| ---------------------- | ------------------------------------------------------------------------- |
| _(none / static)_      | Nothing — plain `dist/`                                                   |
| `"cloudflare-workers"` | `dist/worker.js`, a Hono server that also serves the static assets        |
| `"cloudflare-pages"`   | `dist/_worker.js` + `dist/_routes.json`, only when there is a server tier |
| `"node"` / `"bun"`     | `dist/worker.js`, a Hono server for that runtime                          |

### What the worker serves

Three route families, and nothing else:

| Route                  | Served by                                                       |
| ---------------------- | --------------------------------------------------------------- |
| `/_jx/auth/*`          | The auth extension — sign-up, sign-in, sign-out, session lookup |
| `/_jx/data/*`          | The connector extension — table CRUD                            |
| `/_jx/server/<export>` | One route per `timing: "server"` state entry                    |

**Pages are never rendered per request.** Every route is prerendered at build time and served as static HTML; the worker answers the `/_jx/*` API surface and falls through to the assets for everything else. Interactivity arrives by hydration, so a page that shows signed-in content ships its signed-out state in the HTML and swaps once the session resolves in the browser — see [Auth and secrets](/docs/studio/data/auth-and-secrets).

Details worth knowing:

- Server functions are collected from every component and page, deduplicated by export name, and bundled once — there are no per-route server files when an adapter is set.
- The worker is **self-contained**: hono, extension mounts, database connectors, and your server modules are inlined at build time, so `dist/` deploys and runs with no `node_modules` and no deploy-time bundling step.
- On Cloudflare Pages, `_routes.json` limits worker invocation to `/_jx/*`, so static assets are served without waking the worker. A Pages site with no server functions and no mounts gets no worker at all — the deployment stays purely static.
- A project with dynamic sections (a non-empty `data`/`connections` or `auth` section, served by extension mounts) **must** set a server-capable adapter. On static the build stops with an error naming the offending sections, since a static site has nothing to serve live data with.
- Switching hosts means switching the adapter — your source never changes.

## Hooking up a host

The recipe is the same everywhere: build command `bunx jx build`, publish directory `dist`. [Other hosts](/docs/studio/publish/other-hosts) walks through Netlify and GitHub Pages, and [Cloudflare Pages](/docs/studio/publish/cloudflare) is built into Studio's publish flow.

## Related

- [The build pipeline](/docs/framework/build) — what happens between source and `dist/`
- [Redirects](/docs/framework/site/redirects) — the `_redirects` file in the output
- [SEO and metadata](/docs/framework/site/seo) — `sitemap.xml` and `robots.txt` generation
- [Databases](/docs/studio/data) — the tables behind `/_jx/data`, and why they need an adapter
- [Timing](/docs/framework/concepts/timing) — how a `timing: "server"` entry becomes a `/_jx/server/` route
