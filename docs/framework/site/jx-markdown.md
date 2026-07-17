---
title: "Jx Markdown"
description: "Author Jx components and pages in Markdown: YAML frontmatter, directive syntax, attribute conventions, and when to choose Markdown over JSON."
spec:
  - jx-markdown.md
code:
  - extensions/parser/src/transpile.ts
  - extensions/parser/src/serialize.ts
---

# Jx Markdown

> **Studio writes this format for you.** The [writing surface](/docs/studio/editing/writing) and [frontmatter panel](/docs/studio/editing/frontmatter) edit `.md` files visually — this page documents the syntax for when you hand-edit one or read a diff.

A Jx Markdown file is a Markdown document that transpiles to the same JSON structure the compiler and runtime consume everywhere else. It combines three layers:

1. **YAML frontmatter** — top-level document properties (`tagName`, `state`, `style`, …)
2. **Directives** — explicit elements using [remark-directive](https://github.com/remarkjs/remark-directive) syntax
3. **Standard Markdown** — headings, paragraphs, lists, and links mapped to HTML elements

Markdown support is opt-in: the project must enable the parser extension in `project.json` (`"extensions": ["@jxsuite/parser"]`). There is no implicit `.md` handling without it.

## A minimal component

```markdown
---
tagName: my-greeting
state:
  name:
    type: string
    default: World
---

:::div

# Hello, ${state.name}!

:::
```

The frontmatter declares the document schema; the body declares the element tree. A `.md` file whose frontmatter has a `tagName` containing a hyphen is a component; a file without one is a content document (a blog post, a docs page) that produces a plain element tree. Any content file can add component schema later without changing how it's processed.

## Frontmatter

All top-level Jx document keys go in the YAML frontmatter, `$` prefixes included: `tagName`, `$id`, `state`, `$media`, `$defs`, `$elements`, `$layout`, `$paths`, `$handlers`, `imports`, `observedAttributes`. Any other keys pass through to the document unchanged — which is how pages set `title` or `$head`.

## Directives

Three directive forms cover the element tree:

**Container directives** wrap children. Outer containers use _more_ colons than inner ones (minimum three), and the closing fence matches the opening count:

```markdown
::::section{className="hero"}
:::h1
Welcome
:::
::::
```

**Leaf directives** (two colons) are self-closing:

```markdown
::img{src="/photo.jpg" alt="A photo"}
```

**Text directives** (one colon) sit inline within prose:

```markdown
Click :a[here]{href="/about"} for details.
```

The directive name is the element's `tagName` — any HTML tag or any registered custom element.

## Attributes

Attributes use the HTML-like `{key="value"}` syntax. Three characters can't start a directive attribute key — `$`, `:`, and `@` — so Jx defines drop-the-prefix conventions that the transpiler reverses:

| You write                                                      | The document gets                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `prototype`, `ref`, `component`, `props`, `switch`, `elements` | `$prototype`, `$ref`, `$component`, `$props`, `$switch`, `$elements`     |
| `--title`, `--description`                                     | `$title`, `$description` (element annotations, dropped from HTML output) |
| `style.hover.color` (see below)                                | `style[":hover"].color`                                                  |

DOM properties like `src`, `id`, and `export` are not mapped — they pass through as-is. Attributes matching `aria-*`, `data-*`, or `slot` route into the element's `attributes` object; everything else becomes a top-level DOM property.

Nested objects are written as dot-separated keys. Props on a component instance use `props.*`:

```markdown
:::pricing-card{props.plan="Pro" props.price.ref="#/state/proPrice"}
:::
```

which expands to:

```json
{
  "tagName": "pricing-card",
  "$props": {
    "plan": "Pro",
    "price": { "$ref": "#/state/proPrice" }
  }
}
```

## Style attributes

Element styles are `style.*` dot-path attributes. CSS pseudo-classes drop their `:` prefix and named media queries drop their `@` prefix — the transpiler restores both:

```markdown
::button{style.padding="8px 16px" style.hover.backgroundColor="blue" style.--dark.color="#f0f0f0"}
Click me
```

```json
{
  "tagName": "button",
  "style": {
    "padding": "8px 16px",
    ":hover": { "backgroundColor": "blue" },
    "@--dark": { "color": "#f0f0f0" }
  }
}
```

Root-level styles go in frontmatter under `style`, where YAML allows `:hover` and `@--dark` keys to be written directly.

## Repeaters

An [array repeater](/docs/studio/design/repeaters) has no `tagName`, so it serializes as a directive named after its `$prototype`, with the nested block as the `map` template:

```markdown
# Recent posts

:::Array{items.ref="#/state/posts"}
:li{children.0="${$map/item/title}"}
:::
```

## Standard Markdown

Plain Markdown maps to the elements you'd expect: headings to `h1`–`h6`, paragraphs to `p`, emphasis to `em`/`strong`, links to `a`, images to `img`, lists to `ul`/`ol` + `li`, fenced code to `pre` > `code`, tables to `table` structures. Mixing prose and directives in one file is the normal case, not a special one.

:::doc-note
These docs are themselves Jx Markdown: every aside like this one is a container directive (`:::doc-note`, `:::doc-tip`, `:::doc-warning`) rendered by a component the docs site registers via `$elements` on its content collection.
:::

## Markdown or JSON?

Both formats produce the same document, and Studio edits both transparently — so choose by what the file mostly contains:

| Prefer Markdown                        | Prefer JSON                                |
| -------------------------------------- | ------------------------------------------ |
| Content-heavy pages (blog posts, docs) | Complex interactive components             |
| Components with significant prose      | Components with many state functions       |
| Landing pages, marketing content       | Deeply nested element hierarchies          |
| Quick prototyping                      | Components with complex `$prototype` usage |

Two hard limits to know: there is no runtime `.md` format (files always transpile to JSON first), and event-handler bodies or computed expressions live in frontmatter `state` definitions — never inline in the directive body.

## Related

- [Content collections](/docs/framework/site/content-collections) — Markdown entries with validated frontmatter
- [Components](/docs/framework/concepts/components) — the JSON document model both formats produce
- [Writing](/docs/studio/editing/writing) — editing Markdown visually in Studio
