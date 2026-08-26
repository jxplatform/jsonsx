# `@jxsuite/schema`

> JSON Schema 2020-12 meta-schema generator for Jx documents.

## Overview

`@jxsuite/schema` generates three validator schemas that cover every Jx source file type. The component schema is derived at generation time from web standards data, ensuring it stays current with browser capabilities.

## Installation

```bash
bun add @jxsuite/schema
```

## Generated schemas

| File                  | `$id`                                   | Validates                       |
| --------------------- | --------------------------------------- | ------------------------------- |
| `schema.json`         | `https://jxsuite.com/schema/v1`         | Components, pages, and layouts  |
| `project-schema.json` | `https://jxsuite.com/schema/project/v1` | `project.json` config files     |
| `class-schema.json`   | `https://jxsuite.com/schema/class/v1`   | `.class.json` class definitions |

## Regenerating schemas

```bash
bun run schema
```

This re-fetches the latest `@webref/css`, `@webref/elements`, and `@webref/idl` data and writes all three files.

## API

```js
import {
  generateSchema,
  generateProjectSchema,
  generateClassSchema,
  validateDocument,
} from "@jxsuite/schema";

const schema = await generateSchema(); // component meta-schema object
const valid = await validateDocument(doc); // validate a Jx document
```

## Component schema coverage

- **`tagName`**: all standard HTML element names from `@webref/elements`
- **Element properties**: all DOM IDL properties from `@webref/idl`
- **`style`**: all CSSOM camelCase properties from `@webref/css`
- **Event handlers**: all `EventHandler` names (`onclick`, `oninput`, …)
- **`state` shapes**: naked value, typed value, computed, function, external class
- **Built-in `$prototype` values**: `Request`, `LocalStorage`, `SessionStorage`, `Cookie`, `IndexedDB`, `Array`, `Set`, `Map`, `Blob`, `ReadableStream`, `URLSearchParams`, `FormData`

## VSCode / editor integration

Add the `$schema` field to any Jx file to get autocomplete and validation in any JSON Schema-aware editor:

```json
{ "$schema": "https://jxsuite.com/schema/v1" }
```

## Dependencies

| Package            | Purpose                       |
| ------------------ | ----------------------------- |
| `@webref/css`      | CSS property definitions      |
| `@webref/elements` | HTML element definitions      |
| `@webref/idl`      | Web IDL interface definitions |

## License

MIT
