# Jx Markdown Specification

**Version:** 0.1.10-draft\
**Status:** Partial\
**Updated:** 2026-08-31\
**License:** MIT

---

Jx Markdown is a first-class authoring format for Jx components and content pages. It uses standard Markdown syntax enhanced with YAML frontmatter and [remark-directive](https://github.com/remarkjs/remark-directive) syntax to represent the full Jx component model.

Jx Markdown is primarily intended for content-heavy components. JSON remains the preferred format for technically complex components. The studio visual editor works transparently on both formats.

## 1. Relationship to JSON

Markdown is a transpilation source — `.md` files compile to the same JSON document structure the runtime and compiler already consume. The transpiler (`transpileJxMarkdown`, exposed as the `Markdown` format class's `parse` capability) produces a standard Jx JSON document from markdown source. Round-tripping is supported via `serializeJxMarkdown` (`@jxsuite/parser/serialize`, the `Markdown` class's `serialize` capability). Markdown support is opt-in: a project must import the `Markdown` format class (see specs/extensions.md) — there is no implicit `.md` handling in any host.

```
author.md → transpileJxMarkdown() → Jx JSON → compiler/runtime
                                        ↑
                            serializeJxMarkdown() ← studio editor / site export
```

## 2. Format Overview

A Jx Markdown file consists of:

1. **YAML frontmatter** — top-level document properties (`tagName`, `state`, `$media`, etc.)
2. **Directive body** — element tree using remark-directive syntax
3. **Standard markdown** — headings, paragraphs, lists, etc. (mapped to HTML elements)

### 2.1 Minimal Example

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

## 3. YAML Frontmatter

All top-level Jx document properties are declared in YAML frontmatter. The `$` prefix is preserved in YAML (unlike directive attributes — see below).

Supported frontmatter keys:

| Key                  | Description                                     |
| -------------------- | ----------------------------------------------- |
| `tagName`            | Custom element tag name (must contain a hyphen) |
| `$schema`            | JSON Schema reference                           |
| `$id`                | Document identifier                             |
| `state`              | Reactive state definitions                      |
| `$media`             | Media query responsive styles                   |
| `$defs`              | Reusable definitions                            |
| `$elements`          | Child element dependencies                      |
| `$layout`            | Layout template reference                       |
| `$paths`             | Dynamic route parameters (for pages)            |
| `$handlers`          | Companion JS file reference                     |
| `imports`            | Module imports                                  |
| `observedAttributes` | Custom element observed attributes              |

Any additional frontmatter keys are passed through to the document.

### 3.1 Detection

A `.md` file is recognized as a Jx component (vs content markdown) when its frontmatter contains a `tagName` key whose value includes a hyphen. The `isJxMarkdown(source)` utility performs this check. However, detection does **not** gate the pipeline — all markdown goes through `transpileJxMarkdown()`. Content documents (no `tagName`) produce a Jx element tree that is wrapped in a `{ tagName: "div", $id: "content" }` root by the studio. This enables gradual enhancement: any `.md` file can add Jx schema at any point without changing how it is processed.

## 4. Directive Syntax

Jx Markdown uses the three directive types defined by the [directive proposal](https://talk.commonmark.org/t/generic-directives-plugins-syntax/444):

### 4.1 Container Directives

Container directives wrap children. Outer containers use **more** colons, inner containers use **fewer**. Closing fences must match the opening colon count.

```markdown
::::section{className="hero"}
:::h1
Welcome
:::
:::p
Get started today.
:::
::::
```

### 4.2 Leaf Directives

Leaf directives are self-closing (no children).

```markdown
::hr

::input{type="text" placeholder="Enter name"}

::img{src="/photo.jpg" alt="A photo"}
```

### 4.3 Text Directives

Inline directives within text.

```markdown
Click :a[here]{href="/about"} for details.
```

## 5. Nesting Convention

Outer containers use **more** colons than inner ones. This is the standard remark-directive convention.

```markdown
::::::app
:::::header
::::nav
:::a{href="/"}
Home
:::
::::
:::::
::::::
```

The minimum is 3 colons for a container directive. Each nesting level reduces by one, with a floor of 2 (which becomes a leaf directive).

## 6. Attribute Conventions

### 6.1 Standard Attributes

Directive attributes use the standard HTML-like syntax:

```markdown
::div{className="card" id="main-card"}
```

### 6.2 `$`-Prefix Keywords

The `$` character cannot appear at the start of remark-directive attribute keys. The following Jx keywords are written **without** the `$` prefix in directive attributes, and the transpiler re-adds it:

| Markdown attribute | Jx property  |
| ------------------ | ------------ |
| `prototype`        | `$prototype` |
| `ref`              | `$ref`       |
| `component`        | `$component` |
| `props`            | `$props`     |
| `switch`           | `$switch`    |
| `elements`         | `$elements`  |

DOM properties like `src`, `id`, and `export` are **not** mapped — they pass through as-is.

```markdown
::children{prototype="Array" items.ref="#/state/items"}
```

### 6.3 `--` Annotation Keys

Element annotations use the `--` prefix in markdown directives to avoid collision with the HTML `title` attribute:

| Markdown attribute | Jx property    |
| ------------------ | -------------- |
| `--title`          | `$title`       |
| `--description`    | `$description` |

These are developer-facing metadata annotations, dropped during HTML compilation. `$title` is displayed as the element label in Jx Studio's layers panel.

```markdown
:::section{--title="Hero Section" --description="Primary landing area with CTA"}

# Welcome

:::
```

### 6.4 Dot-Path Attributes

Nested objects are encoded as dot-separated attribute keys:

```markdown
::::::todo-list{children.prototype="Array" children.items.ref="#/state/items" children.map.component="todo-item" children.map.props.item.ref="$map/item"}
::::::
```

This expands to:

```json
{
  "tagName": "todo-list",
  "children": {
    "$prototype": "Array",
    "items": { "$ref": "#/state/items" },
    "map": {
      "$component": "todo-item",
      "$props": { "item": { "$ref": "$map/item" } }
    }
  }
}
```

### 6.5 Prototype Directives (`:::Array`)

An array pseudo-element (repeater) has no `tagName`, so it serializes as a directive **named after its `$prototype`** — e.g. `:::Array`. The directive's attributes carry `items`/`filter`/`sort` (dot-path encoded), and its nested block content is the `map` template. On parse, the synthetic tagName is dropped and `$prototype` is restored. Because it is an ordinary block directive, a repeater can sit among sibling blocks:

```markdown
# Recent posts

:::Array{items.ref="#/state/posts"}
:li{children.0="${$map/item/title}"}
:::
```

Expands to:

```json
{
  "$prototype": "Array",
  "items": { "$ref": "#/state/posts" },
  "map": { "tagName": "li", "children": ["${$map/item/title}"] }
}
```

This is the canonical, round-trippable encoding. The older dot-path form (`children.prototype="Array" …` on the parent directive) is still accepted on parse for backward compatibility.

### 6.6 HTML Attributes

Attributes matching `aria-*`, `data-*`, or `slot` are routed to the `attributes` sub-object. All other attributes become top-level DOM properties.

```markdown
::div{className="card" data-testid="main" aria-label="Main card"}
```

Produces:

```json
{
  "tagName": "div",
  "className": "card",
  "attributes": {
    "data-testid": "main",
    "aria-label": "Main card"
  }
}
```

## 7. Style Attributes

Element styles are expressed as `style.*` dot-path attributes on the element directive. Root-level styles go in YAML frontmatter.

### 7.1 Element Styles

```markdown
::button{className="primary" style.backgroundColor="blue" style.color="white" style.padding="8px 16px"}
Click me
```

Produces:

```json
{
  "tagName": "button",
  "className": "primary",
  "style": {
    "backgroundColor": "blue",
    "color": "white",
    "padding": "8px 16px"
  }
}
```

### 7.2 Root Styles (YAML Frontmatter)

Root-level styles are declared in YAML frontmatter under the `style` key. YAML has no attribute-key restrictions, so `:hover`, `@--dark`, etc. are written directly:

```yaml
---
tagName: my-comp
style:
  fontFamily: "system-ui, sans-serif"
  maxWidth: 560px
  "@--dark":
    backgroundColor: "#1a1a1a"
    color: "#f0f0f0"
---
```

### 7.3 Pseudo-Classes in Style Attributes

The `:` character cannot start a remark-directive attribute key. CSS pseudo-class names are written **without** the `:` prefix inside `style.*` attributes, and the transpiler adds it:

```markdown
::button{style.backgroundColor="white" style.hover.backgroundColor="blue" style.hover.cursor="pointer" style.focus.outline="2px solid blue"}
```

Produces:

```json
{
  "tagName": "button",
  "style": {
    "backgroundColor": "white",
    ":hover": { "backgroundColor": "blue", "cursor": "pointer" },
    ":focus": { "outline": "2px solid blue" }
  }
}
```

Recognized pseudo-CLASS names: `hover`, `focus`, `active`, `visited`, `disabled`, `checked`, `valid`, `invalid`, `required`, `empty`, `first-child`, `last-child`, `focus-within`, `focus-visible`, `placeholder`, `selection`, `before`, `after`, `popover-open`, `open`, `modal`.

Recognized pseudo-ELEMENT names, which take **two** colons: `backdrop`. A separate set because the prefix differs, not because the concept does; `before` and `after` keep their one-colon spelling, which CSS still accepts and which every existing `.md` component is written with.

An unrecognized name is left unprefixed and is then read as a descendant TYPE selector — `style.popover-open.opacity=1` emitted `#panel popover-open { opacity: 1 }`, a rule matching nothing with nothing to say so. That is why the overlay states had to be named here: without them a popover authored in a `.md` component could not be styled open at all.

### 7.4 Media Queries in Style Attributes

The `@` character cannot start an attribute key. Media query keys starting with `--` are written without the `@` prefix:

```markdown
::div{style.backgroundColor="white" style.--dark.backgroundColor="#1a1a1a" style.--dark.color="#e0e0e0"}
```

Produces:

```json
{
  "tagName": "div",
  "style": {
    "backgroundColor": "white",
    "@--dark": { "backgroundColor": "#1a1a1a", "color": "#e0e0e0" }
  }
}
```

## 8. Array Children

Arrays (mapped lists) are encoded using `children.*` dot-path attributes on the parent container element:

```markdown
::::::todo-list{children.prototype="Array" children.items.ref="#/state/todos" children.map.component="todo-item" children.map.props.item.ref="$map/item" children.map.props.index.ref="$map/index"}
::::::
```

The `children.*` attributes expand to a `children` descriptor object (not an array). The transpiler detects this and preserves the object form, skipping the normal content-children array.

## 9. Standard Markdown Mapping

Standard markdown nodes map to Jx elements:

| Markdown       | Jx tagName                                   |
| -------------- | -------------------------------------------- |
| `# Heading`    | `h1`–`h6`                                    |
| Paragraph      | `p`                                          |
| `*emphasis*`   | `em`                                         |
| `**strong**`   | `strong`                                     |
| `~~delete~~`   | `del`                                        |
| `` `code` ``   | `code`                                       |
| `[link](url)`  | `a`                                          |
| `![alt](url)`  | `img`                                        |
| `> blockquote` | `blockquote`                                 |
| `- list`       | `ul` / `ol` + `li`                           |
| Fenced code    | `pre` > `code`                               |
| `---`          | `hr`                                         |
| Table          | `table` > `thead`/`tbody` > `tr` > `th`/`td` |

Fenced code with a known language tag is syntax-highlighted at compile time in the node-side markdown path (`processMarkdown`): the `code` element's text is replaced by token `span` children, each carrying its light and dark colors as `--shiki-light` / `--shiki-dark` CSS custom properties, and the `code` element gains a `shiki` class alongside `language-<lang>`. The page stylesheet chooses which variable paints (typically via the color-scheme contract, spec.md §9.5). Grammars: json, typescript, javascript, markdown, html, shellscript, css, yaml (plus their registered aliases — `ts`, `js`, `bash`, `sh`, `md`, `yml`, …). Unknown languages and bare fences keep plain `textContent`. The browser-safe transpile module (`@jxsuite/parser/transpile`) never highlights — Studio and other browser callers see plain fences.

## 10. Limitations

1. **No runtime format** — `.md` always transpiles to JSON before compilation or rendering
2. **Attribute key restrictions** — `:`, `@`, and `$` cannot start directive attribute keys (use the conventions above)
3. **Complex state logic** — components with intricate `$prototype: Function` bodies or deeply nested state may be clearer in JSON
4. **No inline JavaScript** — event handler bodies and computed expressions live in YAML frontmatter `state` definitions, not in the directive body

## 11. When to Use JSON vs Markdown

| Use Markdown                           | Use JSON                                   |
| -------------------------------------- | ------------------------------------------ |
| Content-heavy pages (blog posts, docs) | Complex interactive components             |
| Components with significant prose      | Components with many state functions       |
| Landing pages, marketing content       | Deeply nested element hierarchies          |
| Quick prototyping                      | Components with complex `$prototype` usage |

## 12. Transpiler API

### 12.1 `transpileJxMarkdown(source: string): object`

Converts a Jx Markdown string to a Jx JSON document. Available from both `@jxsuite/parser` (Node.js) and `@jxsuite/parser/transpile` (browser-safe).

### 12.2 `isJxMarkdown(source: string): boolean`

Returns `true` if the markdown source is a Jx component (frontmatter has `tagName` with a hyphen).

### 12.3 `expandDotPaths(attrs: Record<string, string>): Record<string, any>`

Expands flat dot-path attribute keys into nested objects with Jx `$`-prefix restoration.

### 12.4 `expandStylePaths(attrs: Record<string, string>): Record<string, any>`

Like `expandDotPaths` but also maps CSS pseudo-class names to `:` prefix and `--` keys to `@` prefix. Used for top-level style attribute expansion.

### 12.5 `applyStyleKeyMapping(styleObj: Record<string, any>): Record<string, any>`

Maps top-level keys of a style object: pseudo-class names get `:` prefix, `--` keys get `@` prefix. Used internally by `routeAttributes()` to transform `style.*` dot-path attributes after generic expansion.

### 12.6 `collapseDotPaths(obj: Record<string, any>): Record<string, string>`

Inverse of `expandDotPaths` — flattens a nested object to dot-path attributes.

### 12.7 `collapseStylePaths(styleObj: Record<string, any>): Record<string, string>`

Inverse of `expandStylePaths` — strips `:` and `@` prefixes before flattening.

### 12.8 `serializeJxMarkdown(doc: object, options?): string`

Converts a Jx JSON document back to markdown source (`@jxsuite/parser/serialize`). Two modes:

- `mode: "roundtrip"` (default) — lossless for everything it can express: YAML frontmatter from non-children doc keys, non-markdown elements emitted as directives with collapsed dot-path attributes. Inverse of `transpileJxMarkdown()`. It is not TOTAL: a `tagName` chosen at render time cannot be expressed at all and throws, naming the candidates it saw.
- `mode: "export"` — lossy clean GFM: Jx decoration stripped, wrapper tags unwrapped, custom elements inlined via injected `componentDefs`, template strings evaluated via injected hooks. Used by site builds for `.md` export sidecars.

This is the single Jx→markdown serializer — the studio and the compiler both dispatch to it through the `Markdown` format class.

## 13. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). `remark-directive` is a library rather than a standard; the directive syntax it implements is a CommonMark _proposal_ that was never accepted, which is why §4 is described rather than cited. The frontmatter media type is tracked against `parser.md` §3, where the format class that reads it lives.

| Standard                                           | Class      | Binds | Evidence                                                                      | Note                                                                                                                                                                                    |
| -------------------------------------------------- | ---------- | ----- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CommonMark](https://spec.commonmark.org/current/) | **Subset** | §9    | extensions/parser/src/transpile.ts, extensions/parser/tests/transpile.test.ts | The block and inline constructs §9 tabulates map to Jx nodes. §10 names what does not: a construct outside that table has no Jx representation and is dropped rather than approximated. |

## Changelog

- **0.1.10-draft** (2026-08-31) — popover-open, open and modal are recognized pseudo-classes; backdrop is a pseudo-element taking two colons.
- **0.1.9-draft** (2026-08-27) — 12.8: roundtrip serialization is lossless where expressible, not total.
- **0.1.8-draft** (2026-08-15) — Number the sections so they are addressable, and add §13 Standards Alignment.
- **0.1.7-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.6-draft** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.1.5-draft** (2026-07-17) — Build-time syntax highlighting for markdown code fences (`b2e7a561`).
- **0.1.4-draft** (2026-06-15) — Arrays as pseudo-element (`0b8b3070`).
- **0.1.3-draft** (2026-06-10) — Consolidate markdown and csv handling to the parser package (`8b1ba6da`).
- **0.1.2-draft** (2026-05-25) — Element annotations (title/description) (`c9137e50`).
- **0.1.1-draft** (2026-05-20) — Run formatter (`8ba47930`).
- **0.1.0-draft** (2026-05-11) — Jx markdown (`7b102340`).
