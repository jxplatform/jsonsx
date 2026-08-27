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

## Where the rules are specified

`specs/site-architecture.md` — routing §4, layouts §5, `$head` §8, context §10, i18n §13. The spec is
the source of truth; this package is its one implementation.

## Related

- `@jxsuite/schema` — document types, `parse`, `locale`. This package depends on it; the edge is
  one-way and must stay that way.
- `@jxsuite/runtime` — renders the document this package assembles.
- `@jxsuite/compiler` — the static build, which is one consumer rather than the owner.
