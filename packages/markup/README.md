# @jxsuite/markup

Browser-safe markup conversion utilities shared by the Jx core packages:

- `@jxsuite/markup/html-to-jx` — `htmlToJx(html)` converts an HTML string into
  an array of Jx tree nodes (`JxElement | string`), mapping attributes through
  `property-information` and inline `style` strings into style objects.
- `@jxsuite/markup/md-html` — `markdownToHtml(markdown)` renders untrusted
  markdown (GFM tables/strikethrough/task lists) to a **sanitized** HTML
  string: raw HTML is dropped, event handlers and `javascript:` URLs are
  stripped.

Both pipelines are DOM-free and node-free — no `node:*` imports — so they are
safe for any bundle target (Jx Studio, Cloudflare Workers, node/Bun CLIs).
The package root re-exports both functions.

```ts
import { htmlToJx, markdownToHtml } from "@jxsuite/markup";

htmlToJx('<p class="x">Hello</p>');
// → [{ tagName: "p", attributes: { class: "x" }, textContent: "Hello" }]

markdownToHtml("# Hi\n\n**bold**");
// → "<h1>Hi</h1>\n<p><strong>bold</strong></p>"
```

For markdown → Jx _document_ transpilation (frontmatter, directives, Jx
markdown), use `@jxsuite/parser` — this package deliberately stays a thin,
dependency-light conversion layer.

## Versioning

The types are published as TypeScript source (like every `@jxsuite` package)
and follow the monorepo's release train. Within the monorepo, packages depend
on it via `workspace:^`. Consumers install `@jxsuite/markup` and import its
`/html-to-jx` and `/md-html` entrypoints (or the root re-export); its only
`@jxsuite` runtime dependency is `@jxsuite/schema`.
