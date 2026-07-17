---
title: "Framework"
description: "The Jx specification: a declarative DOM format using plain JSON with reactive state, web components, and standards alignment."
---

# Framework

> This is the conceptual foundation beneath [Jx Studio](/studio). You never have to read it to build with Studio — but if you want to know exactly what the format is, start here.

Jx is a schema and runtime for building reactive web applications using plain JSON. A Jx application is a tree of JSON objects whose structure mirrors the DOM API, whose reactivity is powered by `@vue/reactivity`, and whose behavior is declared in `state` entries.

## Core Premise

**Structure and state are data.** The shape of each `state` entry determines its type and behavior — no additional flags required in the common case.

A Jx component is a single `.json` file that is fully self-describing:

```json
{
  "$id": "Counter",
  "state": {
    "count": 0,
    "increment": {
      "$prototype": "Function",
      "body": "state.count++"
    }
  },
  "tagName": "my-counter",
  "children": [
    { "tagName": "span", "textContent": "${state.count}" },
    { "tagName": "button", "textContent": "+", "onclick": { "$ref": "#/state/increment" } }
  ]
}
```

## Design Principles

1. **DOM-First Design** — Property names mirror standard DOM element properties. `tagName`, `className`, `textContent`, `hidden`, `tabIndex` all map directly to their DOM equivalents.

2. **Rule of Least Power** — Declarative JSON over imperative JavaScript wherever possible. `$ref` bindings over template expressions. Template expressions over handler functions. Handler functions only when logic cannot be expressed otherwise.

3. **JSON as the Authoritative Format** — Documents are valid JSON. Fully serializable. No `this` ambiguity. Natively understood by visual builders, IDEs, validators, and bundlers.

4. **Explicit Over Implicit** — Signal scope does not leak across component boundaries. Every dependency must be explicitly declared as a `$prop`.

5. **Standards Alignment** — Where a web platform standard exists, Jx follows it: JSON Schema 2020-12, JSON Pointer (RFC 6901), Web Components v1, CSSOM camelCase.

## Document Format

Every Jx document has these top-level fields:

| Field      | Required    | Description                                          |
| ---------- | ----------- | ---------------------------------------------------- |
| `$schema`  | Recommended | URI identifying the Jx dialect version               |
| `$id`      | Recommended | Component identifier                                 |
| `$defs`    | Optional    | Pure JSON Schema type definitions (tooling only)     |
| `state`    | Optional    | Reactive state: signals, computed values, functions  |
| `tagName`  | Required    | HTML tag name for the root element                   |
| `children` | Optional    | Array of child element definitions and/or text nodes |

## Reserved Keywords

| Keyword      | Purpose                                                |
| ------------ | ------------------------------------------------------ |
| `$schema`    | Dialect identifier                                     |
| `$id`        | Component identifier                                   |
| `$defs`      | JSON Schema type definitions                           |
| `$ref`       | Reference pointer (JSON Pointer, RFC 6901)             |
| `$props`     | Explicit prop passing at component boundary            |
| `$prototype` | Constructor name — Web API, `"Function"`, or class     |
| `$src`       | External module specifier                              |
| `$switch`    | Dynamic component switching                            |
| `$map`       | Iteration context namespace                            |
| `$media`     | Named media breakpoint declarations                    |
| `$elements`  | Custom element dependency declarations                 |
| `timing`     | Execution timing: `"compiler"`, `"server"`, `"client"` |

For the complete specification, see the [full spec document](https://github.com/jxsuite/jx/blob/main/spec/spec.md).
