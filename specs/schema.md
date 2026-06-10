# `@jxsuite/schema` Specification

## JSON Schema 2020-12 Meta-Schema Generator

**Version:** 2.0.0-draft
**Status:** In Progress
**License:** MIT

---

## 1. Overview

`@jxsuite/schema` generates three Jx meta-schemas — JSON Schema 2020-12 documents that validate Jx source files:

1. **Component schema** (`schema.json`) — validates Jx component, page, and layout files
2. **Project schema** (`project-schema.json`) — validates `project.json` configuration files
3. **Class schema** (`class-schema.json`) — validates `.class.json` class definition files

The component schema is derived at generation time from web standards data (`@webref/css`, `@webref/elements`, `@webref/idl`), ensuring it stays current with browser capabilities. The project and class schemas are static.

---

## 2. Exports

| Export                    | Description                                                 |
| ------------------------- | ----------------------------------------------------------- |
| `generateSchema()`        | Returns the Jx component meta-schema as a JavaScript object |
| `generateProjectSchema()` | Returns the project.json schema as a JavaScript object      |
| `generateClassSchema()`   | Returns the .class.json schema as a JavaScript object       |
| `generateSchemaString()`  | Returns the component schema as a formatted JSON string     |
| `validateDocument(doc)`   | Validates a Jx document against the component schema        |

---

## 3. Schema Coverage

### 3.1 Component Schema (`schema.json`)

**`$id`:** `https://jxsuite.com/schema/v1`

Root-level fields: `$schema`, `$id`, `$defs`, `state`, `tagName`, `children`, `$media`, `$elements`, `$head`, `$layout`, `$paths`, `title`, `imports`, `observedAttributes`, `cases`, `style`, `attributes`.

- `tagName` is optional (pages with `$layout` may omit it)
- `tagName` enumeration: all standard HTML elements derived from `@webref/elements`
- `children`: array of element definitions and/or text nodes, or Array namespace (`$prototype: "Array"`)

#### `state` Entry Shapes

| Shape                                        | Schema Definition                                                     | Status          |
| -------------------------------------------- | --------------------------------------------------------------------- | --------------- |
| Naked value (scalar, array, object)          | `StateEntry.oneOf`                                                    | **Implemented** |
| Typed value (`TypedStateDef` with `default`) | `TypedStateDef` with `attribute`, `reflects`, `deprecated` CEM fields | **Implemented** |
| Computed (template string containing `${}`)  | String pattern match                                                  | **Implemented** |
| Function (`$prototype: "Function"`)          | `FunctionDef` with `body`, `parameters`, `$src`, `$export`, `emits`   | **Implemented** |
| External class (`$prototype: <ClassName>`)   | `ExternalClassDef` with all built-in prototypes                       | **Implemented** |

#### `$defs` Pure Type Definitions

`PureTypeDef` — requires `type`, forbids `default` and `$prototype`.

#### Built-in Prototypes

All 13 built-in prototypes with their specific configuration properties:

- `Request` — url, method, headers, body, debounce, manual, urlParams, timing
- `URLSearchParams` — default params
- `FormData` — default fields
- `LocalStorage` / `SessionStorage` — key, default value
- `Cookie` — name, maxAge, path, domain, secure, sameSite
- `IndexedDB` — database, version, store, indexes, keyPath
- `Array` — items, map, filter, sort
- `Set` / `Map` — default values
- `Blob` — parts, type
- `ReadableStream` — (stub)

#### Element Properties

- All standard HTML DOM properties derived from `@webref/idl`
- CSSOM camelCase style properties derived from `@webref/css`
- All `EventHandler` names (onclick, oninput, etc.) derived from IDL

#### CEM Annotations

| Annotation   | On              | Purpose                               |
| ------------ | --------------- | ------------------------------------- |
| `attribute`  | `TypedStateDef` | Maps state entry to an HTML attribute |
| `reflects`   | `TypedStateDef` | Attribute reflects property changes   |
| `deprecated` | `TypedStateDef` | Marks entry as deprecated             |
| `parameters` | `FunctionDef`   | CEM `Parameter` objects               |
| `emits`      | `FunctionDef`   | CEM `Event` objects                   |

### 3.2 Project Schema (`project-schema.json`)

**`$id`:** `https://jxsuite.com/schema/project/v1`

Validates `project.json` files with:

- `name`, `url` — project metadata
- `defaults` — default page settings (`layout`, `lang`, `charset`)
- `$head` — global `<head>` entries
- `$elements` — global custom element dependencies
- `imports` — global prototype-to-path import map
- `$media` — named media breakpoints
- `style` — global CSS styles
- `state` — site-wide reactive state
- `collections` — content collection definitions (`source`, `schema`, `$elements`)
- `redirects` — static redirect rules
- `build` — build configuration (`outDir`, `format`, `trailingSlash`, `adapter`)
- `i18n` — internationalization (`defaultLocale`, `locales`, `routing`)

### 3.3 Class Schema (`class-schema.json`)

**`$id`:** `https://jxsuite.com/schema/class/v1`

Validates `.class.json` files with:

- `$prototype: "Class"` (required), `title` (required)
- `extends` — base class (string or `$ref`)
- `$implementation` — path to JS module
- `$defs.parameters` — typed parameter schemas
- `$defs.returnTypes` — output type schemas
- `$defs.fields` — class fields with role, access, scope
- `$defs.constructor` — constructor definition
- `$defs.methods` — methods and accessors; capability roles `parse`, `serialize`, `discover`, `load` (with a `timing` array) mark static format capabilities (see specs/extensions.md)
- `format` — format-extension participation block (`extensions`, `mediaType`, `documentKinds`, `exportTarget`, `remote`)
- `$studio` — studio control-surface hints (modes, documentMode, newFileTemplate, element/nesting constraints)

---

## 4. Generation Pipeline

1. Load web standards data from `@webref/css`, `@webref/elements`, `@webref/idl`
2. Extract HTML tag names and their valid properties
3. Extract CSS properties and convert to CSSOM camelCase
4. Extract DOM event handler names
5. Compose all three schemas
6. Write to `schema.json`, `project-schema.json`, `class-schema.json`

The component schema is regenerated when web standards packages are updated. The project and class schemas are static.

---

## 5. Output

Three JSON Schema 2020-12 documents:

```json
{ "$schema": "https://jxsuite.com/schema/v1" }
```

```json
{ "$schema": "https://jxsuite.com/schema/project/v1" }
```

```json
{ "$schema": "https://jxsuite.com/schema/class/v1" }
```

---

## 6. Dependencies

| Package            | Purpose                       |
| ------------------ | ----------------------------- |
| `@webref/css`      | CSS property definitions      |
| `@webref/elements` | HTML element definitions      |
| `@webref/idl`      | Web IDL interface definitions |

---

_`@jxsuite/schema` Specification v2.0.0-draft_
