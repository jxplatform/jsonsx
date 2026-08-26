---
title: "Redirects"
description: "Map old URLs to new ones in project.json: the redirects map, the five status codes, rewrites, and the files the build emits."
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
    "/temporary-redirect": { "destination": "/other-page", "status": 302 },
    "/api-endpoint": { "destination": "/v2/api-endpoint", "status": 308 }
  }
}
```

The string form defaults to `301` (permanent). The full set is `301`, `302`, `303`, `307` and `308`; anything else fails the build, naming the rule.

`307` and `308` are the ones to reach for when the URL might be POSTed to: they preserve the request method and body, where `301` and `302` historically allow a browser to turn a POST into a GET.

## Rewrites

A **rewrite** serves the destination's content _at_ the source URL, with no redirect at all — the visitor's address bar does not change:

```json
{
  "redirects": {
    "/api/*": { "destination": "https://api.example.com/*", "rewrite": true }
  }
}
```

This only works on hosts that process `_redirects` (Netlify, Cloudflare Pages). It is written as `rewrite: true` rather than as a status code, because a rewrite is not a redirect — the `200` you may have seen in other tools' config is that host's shorthand, and the build writes it for you.

## What the build emits

For a static source path, the build may also write an HTML page at that path (`/old-page` becomes `dist/old-page/index.html`) containing an instant meta refresh and a visible fallback link:

```html
<meta http-equiv="refresh" content="0;url=/new-page" /> <link rel="canonical" href="/new-page" />
```

**Which rules get one depends on the status**, because a meta refresh is a browser-side navigation and cannot mean everything a status code can:

| Status       | HTML fallback              | Why                                                                                                                                  |
| ------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `301`        | yes, with a canonical link | Permanent — a canonical link points crawlers at the destination                                                                      |
| `302`, `303` | yes, with `noindex`        | Temporary — a canonical link would claim a permanence the status denies                                                              |
| `307`, `308` | **no**                     | They exist to preserve the request method; a meta refresh would turn a POST into a GET                                               |
| rewrite      | **no**                     | A file at the source URL would shadow the rewrite on hosts that honour `_redirects`, and turn it into a redirect on hosts that don't |

It also writes a single `dist/_redirects` file — the Netlify/Cloudflare format, one rule per line:

```text
/old-page /new-page 301
/blog/:slug /posts/:slug 301
```

Pattern sources using `:param` or `*` wildcards go into `_redirects` only — a wildcard can't be expressed as files on disk, so no HTML fallback is emitted for them.

## Platform behavior

- **Netlify and Cloudflare Pages** read `_redirects` and answer with a true server-side redirect and your configured status code — including pattern rules. The HTML fallbacks are shadowed and harmless.
- **GitHub Pages and other plain static hosts** ignore `_redirects`; the meta-refresh HTML serves as the redirect. Static `301`, `302` and `303` sources work; pattern rules, `307`, `308` and rewrites don't.

Redirect sources are not pages: they never appear in the [sitemap](/docs/framework/site/seo), and the canonical link on each fallback page points crawlers at the destination.

:::doc-warning
A redirect source that collides with a real page overwrites it in `dist/`. The build warns when this happens, naming the source — but it is a warning, not an error, so read the build output. Studio's redirect editor reports the same collision as a Problem.
:::

## Related

- [Build output and adapters](/docs/framework/site/deployment) — where `_redirects` fits in the `dist/` contract
- [Routing](/docs/framework/site/routing) — how real pages claim their URLs
- [Other hosts](/docs/studio/publish/other-hosts) — per-host publishing recipes
