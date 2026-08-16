# `@jxsuite/schema` Specification

## JSON Schema 2020-12 Meta-Schema Generator

**Version:** 0.4.7-draft
**Status:** Partial
**Updated:** 2026-08-16
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

| Export                       | Description                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `generateSchema()`           | Returns the Jx component meta-schema as a JavaScript object                                               |
| `generateProjectSchema()`    | Returns the project.json schema as a JavaScript object                                                    |
| `generateClassSchema()`      | Returns the .class.json schema as a JavaScript object                                                     |
| `generateSchemaString()`     | Returns the component schema as a formatted JSON string                                                   |
| `validateDocument(doc)`      | Validates a Jx document against the component schema                                                      |
| `validateClass(doc)`         | Validates a .class.json definition against the class schema                                               |
| `validateWithSchema(doc, s)` | Validates against an arbitrary self-contained 2020-12 schema (e.g. a bundled per-project document schema) |

---

## 3. Schema Coverage

### 3.1 Component Schema (`schema.json`)

**`$id`:** `https://jxsuite.com/schema/v1`

Root-level fields: `$schema`, `$id`, `$defs`, `state`, `tagName`, `children`, `$media`, `$elements`, `$head`, `$layout`, `$paths`, `$lang`, `$dir`, `$sitemap`, `title`, `imports`, `observedAttributes`, `cases`, `style`, `attributes`.

- `$lang` and `$dir` are page-level overrides of `defaults.lang` / `defaults.dir`, written onto `<html>` (site-architecture.md §8.4)
- **`$sitemap` was read by the build and declared nowhere**, so a page opting out of the sitemap failed `jx validate` against its own closed entry document
- **`HeadEntry.textContent` accepts an object** as well as a string: that is how a JSON-LD block is authored, and the compiler serializes it (site-architecture.md §8.5)
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
- Every `on*` handler accepts a `$ref` binding, an inline `$expression`, or an
  inline `FunctionDef` (`$prototype: "Function"` with `body` and
  `parameters`/legacy `arguments`)
- `StyleObject` is recursive: selector and at-rule groups nest to arbitrary
  depth (spec.md §9.2); the project-level `style` shares the same contract
- `ChildrenValue` accepts a `${…}` template string resolving at build time to
  an array of child definitions (spec.md §8.4), alongside the array and
  Array-namespace forms
- Element-level `$switch`/`cases`: the discriminant is a `StateRef`
  (`#/state/…`), and `cases` maps case values to element definitions or
  external component refs (spec.md §14.1). `SwitchNode` is admitted **as a
  child**, under `ChildrenValue`'s item alternatives — which are `anyOf`, not
  `oneOf`, because a switch child may also carry the `tagName` of its own
  container and would otherwise match two branches and be rejected for
  matching both. It was defined and referenced from nowhere until 2026-08-09,
  so every document with a `$switch` child failed validation while the
  compiler rendered it correctly.
- **`TagName` is a name, never an expression** — `pattern`
  `^[a-zA-Z][a-zA-Z0-9._-]*$`.
- **`ElementTagName` = `TagName` | `{ $expression: TagExpression }`**, wired into `ElementDef`
  alone. `TagExpression` is a closed two-branch def (`?:` and `switch`) whose every RESULT operand
  `$ref`s `TagName` — so the pattern above is kept rather than relocated, and the candidate set is
  readable straight out of the JSON without evaluating anything. The document root and
  `SwitchNode`'s container keep the bare `TagName`; `HeadEntry` declares its own. `default` and
  `initial` are required here, unlike the expression-level `switch`, because an element with no tag
  cannot exist. Resolved once, at element creation — see spec.md §19.6.
- **`$head` items are `HeadEntry`, not `ElementDef`.** They had been elements, which was harmless
  only while an element's tag was a plain name: the moment one could be chosen, a head tag could be
  too, and `head-merger.ts` splices it into the built page as `<${tag} …>`. This also un-orphaned
  `HeadEntry`, whose only inbound `$ref` had been its own recursive `children`. No position in the pipeline evaluates a
  `${…}` in tag position, and each consumer failed differently and silently
  when one was written: the runtime threw `InvalidCharacterError` from
  `createElement`, the compiler emitted a lit binding in tag position, and the
  static renderer re-resolved the emitted HTML against the _page_ scope — where
  a component's own `state` does not exist — so a built page collapsed to the
  fallback branch's tag carrying the other branch's attributes. Vary an element
  with `$switch`.
- **`ExternalClassDef` is one flat property set shared by every state
  `$prototype`**, so a property name it defines for a built-in constrains every
  extension class that declares the same name. `filter` and `sort` are
  therefore unions (reactive `$ref`, single object, ordered rule array) rather
  than the `$ref`-only shape the built-in `Array` prototype wants: both
  `@jxsuite/parser`'s ContentCollection and `@jxsuite/connector`'s TableQuery
  declare `filter` as a rule array, and the narrower core shape silently
  overrode the class's own declaration.

#### CEM Annotations

| Annotation   | On              | Purpose                               |
| ------------ | --------------- | ------------------------------------- |
| `attribute`  | `TypedStateDef` | Maps state entry to an HTML attribute |
| `reflects`   | `TypedStateDef` | Attribute reflects property changes   |
| `deprecated` | `TypedStateDef` | Marks entry as deprecated             |
| `parameters` | `FunctionDef`   | CEM `Parameter` objects               |
| `emits`      | `FunctionDef`   | CEM `Event` objects                   |

### 3.2 Project Schema (`project-schema.json`)

> **Status: Implemented.** Every declared key is described, and the language-tag keys carry a
> pattern, so `jx validate` and the build no longer disagree about the same value. See §7 for
> exactly how much of BCP 47 a `pattern` can carry.

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

**Language-tag keys carry a `pattern`.** `i18n.defaultLocale`, `i18n.locales[]` and
`securityTxt.preferredLanguages[]` are all BCP 47 tags, and all three are validated at author time
against `LANGUAGE_TAG_PATTERN` — one exported constant in `packages/schema/src/locale.ts`, so the
schema and the build read the same source.

The pattern is deliberately looser than the build's `Intl.Locale` parse, and the direction of that
inequality is the contract: **the pattern accepts every tag the build accepts**, so a project that
compiles can never fail `jx validate`. It catches the class of mistake an author makes — an
underscore for a hyphen, an empty subtag, a one-letter primary language — and leaves subtag ordering
and registry membership to the build, which is where a full RFC 5646 parse already lives. A test
asserts the inequality against a corpus rather than restating it as prose.

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
- `$defs.methods` — methods and accessors; the `role` enum covers `method`/`accessor` plus every static capability role hosts dispatch on (with a `timing` array): the format roles `parse`, `serialize`, `discover`, `load` and the admission-block roles `projectData`, `resolvePaths`, `lower`, `emit`, `mount`, `dialect`, `deploySchema`, `bindings`, `testConnection`. The enum is kept in lockstep with format-registry's `EXTENSION_CAPABILITIES` by the drift-guard test (`packages/schema/tests/class-schema-drift.test.ts`); see specs/extensions.md §8
- Admission blocks (specs/extensions.md §6): `format` (`extensions`, `mediaType`, `documentKinds`, `exportTarget`, `remote`), `project` (`key` required; `title`, `description`, `referenceable`), `server` (`basePath` required; `order`, `module`), and `connector` (`provider` + `kind` required; `local`, `serve`, `module`, open for provider extras)
- `$studio` — studio control-surface hints (modes, documentMode, newFileTemplate, element/nesting constraints)

### 3.4 I-JSON at the Parse Boundary

> **Status: Implemented.** `ijson.ts`, enforced by `parse.ts` for every document, project config
> and class definition.

`JSON.parse` accepts documents that mean something other than what they say, and RFC 7493 names the
two that matter here:

- **A repeated name** (§2.3). `JSON.parse` keeps the last and says nothing, so a document with two
  `state` keys — a bad merge, most often — loses the first one's contents silently.
- **An integer outside what a double holds** (§2.2). `9007199254740993` parses as
  `9007199254740992`, and the next serialization writes the wrong number back to disk.

Both are **parse failures**, not warnings. They are silent data loss, and neither has a reading
under which the author got what they wrote. The whole repository — 375 JSON documents — was already
clean when this landed, so the rule rejects mistakes rather than existing work.

This matters more in Jx than it would elsewhere. A Jx document does not stay JSON: it round-trips
through markdown frontmatter (`parser.md`) and through a Yjs CRDT (`collab.md`), and each crossing
rebuilds the object from the **parsed value**. Whatever `JSON.parse` discarded at the boundary is
discarded for good, and the file the author reopens is not the file they wrote.

Detection is a scan of the source text rather than a `JSON.parse` reviver, because by the time a
reviver runs the duplicate is already gone. **Fractions are never judged**: `0.1` is not exactly
representable either, so flagging them would flag most real documents while saying nothing about
whether the author's value survived.

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

## 7. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). `@webref/*` is a tooling package rather than a standard; what it carries are extracts of the specifications cited below.

| Standard                                                            | Class       | Binds  | Evidence                                                                                                                                                           | Note                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/schema) | **Adopted** | §3, §5 | packages/schema/src/schema.ts, packages/schema/tests/schema.test.ts                                                                                                | The emitted meta-schemas are conformant 2020-12, so any 2020-12 validator can check a Jx document as an instance. Jx is not a _dialect_: it declares no `$vocabulary`, and its reserved keywords are not JSON Schema vocabulary — a standards-only processor ignores them (spec.md §3.2).                                                                                                                |
| [RFC 7493](https://www.rfc-editor.org/rfc/rfc7493)                  | **Subset**  | §3.4   | packages/schema/src/ijson.ts, packages/schema/tests/ijson.test.ts, packages/schema/tests/parse.test.ts                                                             | The two constraints that are silent data loss: duplicate names (§2.3) and integers a double cannot hold (§2.2), both parse failures. Not enforced: the top-level-value and unpaired-surrogate rules, neither of which can lose an author's content the way these two do.                                                                                                                                 |
| [WHATWG HTML](https://html.spec.whatwg.org/)                        | **Subset**  | §3, §4 | packages/schema/src/schema.ts                                                                                                                                      | Only the element and IDL-attribute inventories are used, extracted via `@webref/elements` and `@webref/idl` to build the `tagName` enumeration, the DOM property set and the `EventHandler` names. Nothing else of the standard is implemented here.                                                                                                                                                     |
| [CSSOM](https://www.w3.org/TR/cssom-1/)                             | **Subset**  | §3, §4 | packages/schema/src/schema.ts                                                                                                                                      | Only the camelCase IDL attribute names for CSS properties are used, to type the `style` object. Neither the object model nor its serialization rules are implemented.                                                                                                                                                                                                                                    |
| [BCP 47](https://www.rfc-editor.org/info/bcp47)                     | **Subset**  | §3.2   | packages/schema/src/locale.ts, packages/schema/defs/project-config.schema.ts, packages/schema/tests/locale.test.ts, packages/schema/tests/validate-project.test.ts | `LANGUAGE_TAG_PATTERN` puts the separator and subtag-length rules into the schema, so `jx validate` refuses `en_US`, `en--US` and `e` exactly as the build does. Absent here: subtag ordering, the singleton rules, and registry membership — all of which stay with `Intl.Locale` at build time (`site-architecture.md` §13.2), and a test pins that the pattern accepts everything that parse accepts. |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)                  | **Subset**  | §3.2   | packages/schema/defs/project-config.schema.ts                                                                                                                      | `REDIRECT_STATUSES` enumerates the five §15.4 statuses a static host can express, and the compiler and the Studio grid both import it rather than declaring their own. A rewrite is a separate shape, not a sixth status — see site-architecture.md §11.3.                                                                                                                                               |

## Changelog

- **0.4.7-draft** (2026-08-16) — §3.2 language-tag keys carry a BCP 47 pattern, so author-time and build-time agree; gap:bcp47-locale-validation closed.
- **0.4.6-draft** (2026-08-16) — §3.2 and §7: BCP 47 validation exists in the build; the schema is the half that still lacks it.
- **0.4.5-draft** (2026-08-15) — I-JSON enforced at the parse boundary: duplicate names and unrepresentable integers are parse failures (§3.4).
- **0.4.4-draft** (2026-08-15) — The class method role enum gains head (extensions.md §8.6).
- **0.4.3-draft** (2026-08-15) — §3.1 records the root fields the 0.4.2 entry described.
- **0.4.2-draft** (2026-08-15) — Document $lang, $dir and the previously undeclared $sitemap; defaults.dir; HeadEntry.textContent admits an object.
- **0.4.1-draft** (2026-08-15) — build.headers declares the response-header output (site-architecture.md §14.3).
- **0.4.0-draft** (2026-08-15) — redirects admits the object form the compiler and Studio already write, with an RFC 9110 status enum and a distinct rewrite shape; §3.2's redirect defect is resolved.
- **0.3.2-draft** (2026-08-15) — Add §7 Standards Alignment; §3.2 marked Partial — redirects and i18n do not describe what the rest of the platform reads.
- **0.3.1-draft** (2026-08-10) — §3.1 ElementTagName admits a TagExpression on ElementDef alone — a closed two-branch def whose every result $refs TagName, so the pattern is kept and the candidates stay enumerable; $head items are pinned to HeadEntry so a head tag cannot become choosable.
- **0.3.0-draft** (2026-08-09) — §3.1 TagName gains a pattern — a tag name is a name, never an expression, because no consumer evaluates one and each failed differently and silently; SwitchNode is admitted as a child under ChildrenValue (anyOf, so a switch child may still carry its container tagName); ExternalClassDef.filter widened to a union like sort, since one flat property set is shared by every $prototype and was overriding extension classes' own declared parameters.
- **0.2.8-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.2.7-draft** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.2.6-draft** (2026-07-22) — Align specs and docs with the bundled-schema validation contract (`ae861ff6`).
- **0.2.5-draft** (2026-06-10) — Consolidate markdown and csv handling to the parser package (`8b1ba6da`).
- **0.2.4-draft** (2026-05-18) — Always emit worker.js for cloudflare (`3dd37c2d`).
- **0.2.3-draft** (2026-05-15) — Provider-sepcific Site-Wide Bundling (`51cb5cf6`).
- **0.2.2-draft** (2026-04-23) — Site build (`ffe60ddc`).
- **0.2.1-draft** (2026-04-23) — Compiler cli + published site (`4607ebbc`).
- **0.2.0-draft** (2026-04-22) — Consolidate project config schema and rename as such (`e3523dbf`).
- **0.1.3-draft** (2026-04-20) — Text nodes support (`4d45eeb7`).
- **0.1.2-draft** (2026-04-16) — Landing site + working exports + release-it + linting (`a8409b5f`).
- **0.1.1-draft** (2026-04-15) — Rebrand to Jx / Jx Platform (`abc63f2d`).
- **0.1.0-draft** (2026-04-10) — Consolidate specs (`80ca313f`).

---

_`@jxsuite/schema` Specification v0.4.7-draft_
