---
title: "Build output and adapters"
description: "What bunx jx build writes to dist/, how trailingSlash shapes URLs, and the deployment adapters for static hosts, Cloudflare, Node, and Bun."
spec:
  - site-architecture.md#14
code:
  - packages/compiler/src/site/site-build.ts
  - packages/compiler/src/site/headers-emitter.ts
  - packages/compiler/src/site/csp.ts
  - packages/compiler/src/site/well-known.ts
  - packages/compiler/src/site/service-worker.ts
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
├── _headers                  # Response headers (below)
├── .nojekyll                 # So GitHub Pages doesn't eat the _-prefixed files above
├── favicon.svg               # public/ is copied in verbatim
└── worker.js                 # Only with a server adapter (see below)
```

Pages only load JavaScript for components that actually need it — a fully static component ships as pre-rendered HTML and CSS with no script. Files from `public/` are copied verbatim, and the `copy` map in `project.json` can place additional files at chosen output paths.

## Response headers

The build writes `dist/_headers` because cacheability is something only the build can decide — it chose the filenames, so it is the only party that knows which of them contain a content hash:

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

Only the optimized images are cached forever, because their filenames embed a hash of the source — a changed image is a changed URL. **Your component JS and CSS are not**, deliberately: `components/site-header.js` keeps the same URL when you edit the component, so caching it forever would serve stale code to everyone who visited before the edit.

**Cloudflare Pages, Cloudflare Workers and Netlify** read this file. The `node` and `bun` adapters serve no static assets, so there it is a description of what the reverse proxy in front of them should send — the build says so when you use one.

To add your own rules, or turn parts off:

```json
{
  "build": {
    "headers": {
      "security": { "hsts": { "maxAge": 31536000, "includeSubDomains": true } },
      "rules": { "/downloads/*": { "X-Robots-Tag": "none" } }
    }
  }
}
```

Your own `public/_headers` still works: it is appended below the generated block, verbatim, and a later rule wins — so anything you write there overrides what the build set.

:::doc-warning
HSTS is off by default on purpose. `Strict-Transport-Security` tells browsers to refuse plain HTTP for your domain for `maxAge` seconds, and they remember it — so a wrong value locks the domain to HTTPS long after you notice. Turn it on once your certificate setup is settled.
:::

## Content-Security-Policy

Also off by default, and also on purpose. Turn it on with one line:

```json
{ "build": { "headers": { "security": { "csp": true } } } }
```

The build then derives the policy from the pages it just produced:

```
Content-Security-Policy: base-uri 'self'; default-src 'self'; font-src 'self'; form-action 'self';
  frame-ancestors 'self'; frame-src 'self'; img-src 'self' data:; object-src 'none';
  script-src 'self' 'sha256-…' 'sha256-…'; style-src 'self' 'unsafe-inline'
```

`script-src` is the strict part, and it costs you nothing: compiled Jx output contains no `eval` and no `new Function`, event handlers are attached as listeners rather than written as `onclick=` attributes, and the runtime is served from your own site. The only inline scripts on a page are the import map and the colour-scheme pre-paint script — both identical on every page, so two hashes cover the whole site.

If your pages load anything from another origin — an analytics script, Google Fonts, a YouTube embed — the build sees it in the finished HTML and adds that origin to the right directive. What it can't see is the second hop: a third-party script that loads _another_ script at runtime. That's the case to check.

:::doc-tip
Start with `"csp": "report-only"`. You get `Content-Security-Policy-Report-Only`, the browser reports what it _would_ have blocked in the console, and nothing on your site breaks while you look. Switch to `true` when the console is clean.
:::

### style-src is not strict

`style-src` keeps `'unsafe-inline'`, and will until the style pipeline changes. Every page carries a generated `<style>` block whose content differs per page, and per-element `style=` attributes have no hash form in CSP at all. Half-measures are worse than none here: a hash and `'unsafe-inline'` in the same directive cancel each other out, so adding a few style hashes would leave your pages unstyled.

### Overriding a directive

```json
{
  "build": {
    "headers": {
      "security": {
        "csp": {
          "mode": "enforce",
          "reportUri": "https://example.report-uri.com/r/d/csp/enforce",
          "directives": {
            "connect-src": "'self' https://api.example.com",
            "frame-src": false
          }
        }
      }
    }
  }
}
```

A string replaces a directive wholesale — restate the defaults you still want — and `false` removes it. `reportUri` emits `report-to`, the deprecated-but-widely-implemented `report-uri`, and the `Reporting-Endpoints` header that the first of those needs to mean anything.

## Manifest and security.txt

Two files a site is usually expected to publish. Both are generated from `project.json`, and both step aside if you put your own copy in `public/`.

### manifest.webmanifest

Declare a `manifest` section and the build writes `dist/manifest.webmanifest`, adds `<link rel="manifest">` to every page, and adds `<meta name="theme-color">` if you set one:

```json
{
  "manifest": {
    "shortName": "Acme",
    "themeColor": "#0b3d91",
    "backgroundColor": "#ffffff",
    "icons": [
      { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
      { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
    ]
  }
}
```

`name` falls back to your project name and `start_url` to `/`, so the shortest useful manifest is a `manifest` key with icons in it. There's no manifest at all unless you declare the section — it's a claim that your site is meant to be installed, and most aren't.

:::doc-tip
The 192px and 512px icons are what a browser wants before it will offer to install the site. Leave one out and the build warns; it still writes the manifest, which is useful on its own for the name and theme colour.
:::

### .well-known/security.txt

```json
{
  "securityTxt": {
    "contact": ["mailto:security@example.com"],
    "expires": "2027-01-01T00:00:00Z",
    "preferredLanguages": ["en", "fr-ca"],
    "policy": ["https://example.com/security-policy"]
  }
}
```

Written to `.well-known/security.txt` and nowhere else — [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116) §3 makes that the canonical spot, and a second copy at the root is a second thing to forget.

:::doc-warning
`expires` is required, and a date in the past **fails the build**. That's deliberate: an expired `security.txt` is worse than none at all, because it advertises a reporting channel while telling the reporter its information is stale. Pick a date you'll actually revisit.
:::

Want a clearsigned file? Put it at `public/.well-known/security.txt` and the build keeps yours. Signing needs a private key, which the build has no business holding.

## Service worker

Also off by default, and this one for a sharper reason than the rest: a service worker is **sticky**. It survives your next deploy, keeps running against a site that has moved on, and the people it breaks are the ones who came back.

```json
{
  "serviceWorker": {
    "precache": ["/", "/offline/"],
    "offlineFallback": "/offline/"
  }
}
```

That writes `dist/sw.js` and adds a small registration script to every page. What it does:

- **HTML is always network-first.** The cache is a fallback for a request that failed, never a substitute for one — otherwise a stale page outlives every attempt you make to fix it.
- **Only `/images/_optimized/*` is cache-first**, because it's the one output whose filename contains a hash of its own contents. A cached hit there can't be wrong. Your components and assets aren't cached first for the same reason they aren't marked `immutable`: editing one reuses its URL.
- **`offlineFallback` is served for a failed navigation.** If you forget to precache it, the build adds it and tells you — a page that was never cached can't be served offline.

:::doc-warning
Every URL in `precache` must be a page or file this build actually produces, and the build fails if one isn't. That's not pedantry: the browser's `cache.addAll()` is all-or-nothing, so a single typo'd URL stops the worker from installing **at all**, with no error anywhere you'd think to look. The symptom is "the service worker just doesn't do anything".
:::

### Turning it off

```json
{ "serviceWorker": false }
```

**Not by deleting the key.** This is the one setting where "remove the config" is the wrong move, and it's worth understanding why.

Once a visitor's browser registers a worker, it keeps running it. Removing `sw.js` from your deploy doesn't help — a 404 at that URL isn't an instruction to stop, it's just a failed update check. Every previous visitor stays on the old worker, serving whatever it cached, and you have no way to reach them.

So `"serviceWorker": false` writes a **tombstone** at the same URL: a worker whose only job is to unregister itself, delete its caches, and reload the tab onto your live site. The next time a returning visitor's browser checks for an update, they get it and they're free.

Leave `false` in place for as long as you think old visitors might come back. Deleting the key later stops emitting the tombstone.

## Build options

The `build` section of `project.json`:

| Property        | Default    | What it does                                                       |
| --------------- | ---------- | ------------------------------------------------------------------ |
| `outDir`        | `"./dist"` | Output directory                                                   |
| `trailingSlash` | `"always"` | URL shape: `"always"` or `"never"` (below)                         |
| `sitemap`       | `true`     | Set `false` to skip [sitemap generation](/docs/framework/site/seo) |
| `adapter`       | _(none)_   | `"cloudflare-workers"`, `"cloudflare-pages"`, `"node"`, or `"bun"` |
| `headers`       | _(on)_     | Response headers written to `_headers` (below)                     |

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
