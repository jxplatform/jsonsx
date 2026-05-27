# Jx Markdown Specification

Jx Markdown is a first-class authoring format for Jx components and content pages. It uses standard Markdown syntax enhanced with YAML frontmatter and [remark-directive](https://github.com/remarkjs/remark-directive) syntax to represent the full Jx component model.

Jx Markdown is primarily intended for content-heavy components. JSON remains the preferred format for technically complex components. The studio visual editor works transparently on both formats.

## Relationship to JSON

Markdown is a transpilation source — `.md` files compile to the same JSON document structure the runtime and compiler already consume. The transpiler (`transpileJxMarkdown`) produces a standard Jx JSON document from markdown source. Round-tripping is supported via `jxDocToMd`.

```
author.md → transpileJxMarkdown() → Jx JSON → compiler/runtime
                                        ↑
                                  jxDocToMd() ← studio editor
```

## Format Overview

A Jx Markdown file consists of:

1. **YAML frontmatter** — top-level document properties (`tagName`, `state`, `$media`, etc.)
2. **Directive body** — element tree using remark-directive syntax
3. **Standard markdown** — headings, paragraphs, lists, etc. (mapped to HTML elements)

### Minimal Example

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

## YAML Frontmatter

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

### Detection

A `.md` file is recognized as a Jx component (vs content markdown) when its frontmatter contains a `tagName` key whose value includes a hyphen. The `isJxMarkdown(source)` utility performs this check. However, detection does **not** gate the pipeline — all markdown goes through `transpileJxMarkdown()`. Content documents (no `tagName`) produce a Jx element tree that is wrapped in a `{ tagName: "div", $id: "content" }` root by the studio. This enables gradual enhancement: any `.md` file can add Jx schema at any point without changing how it is processed.

## Directive Syntax

Jx Markdown uses the three directive types defined by the [directive proposal](https://talk.commonmark.org/t/generic-directives-plugins-syntax/444):

### Container Directives

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

### Leaf Directives

Leaf directives are self-closing (no children).

```markdown
::hr

::input{type="text" placeholder="Enter name"}

::img{src="/photo.jpg" alt="A photo"}
```

### Text Directives

Inline directives within text.

```markdown
Click :a[here]{href="/about"} for details.
```

## Nesting Convention

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

## Attribute Conventions

### Standard Attributes

Directive attributes use the standard HTML-like syntax:

```markdown
::div{className="card" id="main-card"}
```

### `$`-Prefix Keywords

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

### `--` Annotation Keys

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

### Dot-Path Attributes

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

### HTML Attributes

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

## Style Attributes

Element styles are expressed as `style.*` dot-path attributes on the element directive. Root-level styles go in YAML frontmatter.

### Element Styles

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

### Root Styles (YAML Frontmatter)

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

### Pseudo-Classes in Style Attributes

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

Recognized pseudo-class names: `hover`, `focus`, `active`, `visited`, `disabled`, `checked`, `valid`, `invalid`, `required`, `empty`, `first-child`, `last-child`, `focus-within`, `focus-visible`, `placeholder`, `selection`, `before`, `after`.

### Media Queries in Style Attributes

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

## Array Children

Arrays (mapped lists) are encoded using `children.*` dot-path attributes on the parent container element:

```markdown
::::::todo-list{children.prototype="Array" children.items.ref="#/state/todos" children.map.component="todo-item" children.map.props.item.ref="$map/item" children.map.props.index.ref="$map/index"}
::::::
```

The `children.*` attributes expand to a `children` descriptor object (not an array). The transpiler detects this and preserves the object form, skipping the normal content-children array.

## Standard Markdown Mapping

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

## Limitations

1. **No runtime format** — `.md` always transpiles to JSON before compilation or rendering
2. **Attribute key restrictions** — `:`, `@`, and `$` cannot start directive attribute keys (use the conventions above)
3. **Complex state logic** — components with intricate `$prototype: Function` bodies or deeply nested state may be clearer in JSON
4. **No inline JavaScript** — event handler bodies and computed expressions live in YAML frontmatter `state` definitions, not in the directive body

## When to Use JSON vs Markdown

| Use Markdown                           | Use JSON                                   |
| -------------------------------------- | ------------------------------------------ |
| Content-heavy pages (blog posts, docs) | Complex interactive components             |
| Components with significant prose      | Components with many state functions       |
| Landing pages, marketing content       | Deeply nested element hierarchies          |
| Quick prototyping                      | Components with complex `$prototype` usage |

## Transpiler API

### `transpileJxMarkdown(source: string): object`

Converts a Jx Markdown string to a Jx JSON document. Available from both `@jxsuite/parser` (Node.js) and `@jxsuite/parser/transpile` (browser-safe).

### `isJxMarkdown(source: string): boolean`

Returns `true` if the markdown source is a Jx component (frontmatter has `tagName` with a hyphen).

### `expandDotPaths(attrs: Record<string, string>): Record<string, any>`

Expands flat dot-path attribute keys into nested objects with Jx `$`-prefix restoration.

### `expandStylePaths(attrs: Record<string, string>): Record<string, any>`

Like `expandDotPaths` but also maps CSS pseudo-class names to `:` prefix and `--` keys to `@` prefix. Used for top-level style attribute expansion.

### `applyStyleKeyMapping(styleObj: Record<string, any>): Record<string, any>`

Maps top-level keys of a style object: pseudo-class names get `:` prefix, `--` keys get `@` prefix. Used internally by `routeAttributes()` to transform `style.*` dot-path attributes after generic expansion.

### `collapseDotPaths(obj: Record<string, any>): Record<string, string>`

Inverse of `expandDotPaths` — flattens a nested object to dot-path attributes.

### `collapseStylePaths(styleObj: Record<string, any>): Record<string, string>`

Inverse of `expandStylePaths` — strips `:` and `@` prefixes before flattening.

### `jxDocToMd(doc: object): string`

Converts a Jx JSON document back to Jx Markdown source. Available in the studio via `md-convert.js`.
