---
title: "Redirects"
description: "Map old URLs to new ones in project.json: the redirects map, status codes, and the meta-refresh HTML and _redirects files the build emits."
spec:
  - site-architecture.md#11
code:
  - packages/compiler/src/site/site-build.ts
---

# Redirects

When a page moves, the old URL should keep working. Declare redirects once in `project.json` and the build emits them in two forms — an HTML fallback that works on any static host, and a `_redirects` file for hosts that do server-side redirects.

## The redirects map

`redirects` maps source paths to destinations. These are real entries from jxsuite.com:

```json
{
  "redirects": {
    "/docs/get-studio": "/docs/start/install/",
    "/docs/components": "/docs/framework/concepts/components/",
    "/docs/spec": "/docs/framework/"
  }
}
```

Each value is either a plain destination string, or an object when you need a specific status code:

```json
{
  "redirects": {
    "/old-page": "/new-page",
    "/moved-permanently": { "destination": "/new-location", "status": 301 },
    "/temporary-redirect": { "destination": "/other-page", "status": 302 }
  }
}
```

The string form defaults to `301` (permanent). Use `302` for temporary moves; on hosts that support rewrites, `200` serves the destination without redirecting.

## What the build emits

For every static source path, the build writes an HTML page at that path (`/old-page` becomes `dist/old-page/index.html`) containing an instant meta refresh, a canonical link to the destination, and a visible fallback link:

```html
<meta http-equiv="refresh" content="0;url=/new-page" /> <link rel="canonical" href="/new-page" />
```

It also writes a single `dist/_redirects` file — the Netlify/Cloudflare format, one rule per line:

```
/old-page /new-page 301
/blog/:slug /posts/:slug 301
```

Pattern sources using `:param` or `*` wildcards go into `_redirects` only — a wildcard can't be expressed as files on disk, so no HTML fallback is emitted for them.

## Platform behavior

- **Netlify and Cloudflare Pages** read `_redirects` and answer with a true server-side redirect and your configured status code — including pattern rules. The HTML fallbacks are shadowed and harmless.
- **GitHub Pages and other plain static hosts** ignore `_redirects`; the meta-refresh HTML serves as the redirect. Static sources work; pattern rules don't.

Redirect sources are not pages: they never appear in the [sitemap](/docs/framework/site/seo), and the canonical link on each fallback page points crawlers at the destination.

:::doc-warning
A redirect source that collides with a real page will overwrite it in `dist/` — the build does not currently warn about conflicts. Check the route table before pointing a redirect at an existing path.
:::

## Related

- [Build output and adapters](/docs/framework/site/deployment) — where `_redirects` fits in the `dist/` contract
- [Routing](/docs/framework/site/routing) — how real pages claim their URLs
- [Other hosts](/docs/studio/publish/other-hosts) — per-host publishing recipes
