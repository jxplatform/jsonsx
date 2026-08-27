# `@jxsuite/site`

**What a Jx project's page at a route consists of** — routing, layout, `<head>`, context and site
style — as pure functions with their IO injected.

Every one of these rules has to be answered identically by four things that cannot share code any
other way: the compiler's static build, the Studio canvas, a Bun dev/desktop server, and a
Cloudflare Worker serving a live preview. They cannot import `@jxsuite/compiler` — its dependency
graph carries `sharp` and `esbuild`, so neither a browser bundle nor a Worker can load it — and a
route is exactly the kind of rule where a silent disagreement is a page that 404s in one surface and
renders in another.

So the rules live here, and this package has **no platform imports at all**: no `node:`, no DOM, no
filesystem. Where a rule genuinely needs to read something, the reader is a parameter
(`LayoutLoader`, `ImportRebaser`) and is simply absent where there are no directories.

| Module          | Answers                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `./routes`      | What URL a page file has (`pages/blog/[slug].md` → `/blog/:slug`), and which route a request matches. Pure string math, zero imports. |
| `./layout`      | What a page wrapped in its layout looks like — `$layout` resolution and `<slot>` distribution.                                        |
| `./context`     | What `$site.*` and `$page.*` hold before anything renders.                                                                            |
| `./head-merger` | How a site's, a layout's and a page's `$head` become one `<head>`, and how that `<head>` serializes.                                  |
| `./site-style`  | How `project.json`'s `style` becomes a stylesheet, including the dual-emitted colour-scheme selectors.                                |
| `./compose`     | All of the above, applied: a route and a working tree become one merged document plus its `<head>`.                                   |
| `./shell`       | That document as HTML — the page that hands itself to `@jxsuite/runtime` in the reader's browser.                                     |
| `./paths`       | What an origin serving a project as a site may hand out, as an allowlist that defaults closed.                                        |
| `./serve`       | The decision order a published site answers with: file, then route, then the host's own lane, then the project's own 404.             |

## Composing without a compiler

`compose` + `shell` are what let a page render at its real URL without `jx build`. The server settles
what it can — routing, layout, `<head>`, `$site`/`$page` — and the runtime assembles the DOM. Two
things the build does are deliberately skipped, and both are stated in `compose.ts`: `$paths` is not
expanded (a dynamic route matches on demand and takes its parameters from the URL), and `imports`
are not rebased (the source tree _is_ the served tree).

All IO is injected — `SiteIO`, `AssetIO`, `LayoutLoader`, `DocumentParser` — so the same code path
answers off a disk, out of a Durable Object's SQLite table, or over `fetch`. A host that has the
project's format registry passes a `DocumentParser` and `.md` pages render; one that does not omits
it and gets a named error rather than a blank page.

**Per-file exports, never a barrel.** Studio imports `./routes` into a browser bundle; a barrel
would drag every other module in behind it.

## Where the rules are specified

`specs/site-architecture.md` — routing §4, layouts §5, `$head` §8, context §10, i18n §13. The spec is
the source of truth; this package is its one implementation.

## Related

- `@jxsuite/schema` — document types, `parse`, `locale`. This package depends on it; the edge is
  one-way and must stay that way.
- `@jxsuite/runtime` — renders the document this package assembles.
- `@jxsuite/compiler` — the static build, which is one consumer rather than the owner.
