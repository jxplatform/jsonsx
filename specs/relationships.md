# Jx Relationships Specification

## References Between Named Entries Across Extension Sections

**Version:** 0.1.3-draft
**Status:** Partial
**Updated:** 2026-07-22
**License:** MIT

Companion to [extensions.md](./extensions.md) §5/§9. Defines the standard
field types for relationships between data — content entries, dynamic table
rows, and any future `referenceable` section — so a comment can belong to a
product, an author to a post, an order line to a product row.

---

## 1. The reference form

Relationship metadata lives **in the field's JSON Schema inside the section
value in `project.json`** — one source of truth read by content validation
and resolution, connector DDL, and studio pickers.

A reference names its target with a unified pointer over any section whose
owning class declares `project.referenceable: true`:

```
#/<sectionKey>/<entryName>
```

| Cardinality | Field schema                                                        | Example                                                              |
| ----------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| to-one      | `{ "$ref": "#/<sectionKey>/<name>" }`                               | `"author": { "$ref": "#/content/authors" }`                          |
| to-many     | `{ "type": "array", "items": { "$ref": "#/<sectionKey>/<name>" } }` | `"tags": { "type": "array", "items": { "$ref": "#/content/tags" } }` |

Cardinality is expressed JSON-Schema-natively: a bare `$ref` is to-one; an
array of refs is to-many. There is no separate relationship DSL.

The core schema publishes the shape as `$defs.RelationshipRef`
(`@jxsuite/schema/schemas/project.core.schema.json`) and includes it in the
default field-union resource
(`https://jxsuite.com/schema/project/fields/v2`); the generated per-project
entry schema re-embeds that resource with the effective union — which is how
relationship fields become valid everywhere field schemas recurse (content
frontmatter schemas, table column schemas) without any fragment knowing the
full union (extensions.md §5.3).

**Stored values** are entry identifiers: the target section's entry `id`
(string) for to-one, an array of ids for to-many.

---

## 2. Semantics matrix

Resolution behavior depends on the domains on each side. "content" means a
file-based section loaded at build/dev time (parser); "table" means a
connection-backed section served at request time (connector).

| From → To         | Storage                                                             | Resolution                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| content → content | id string / id array in frontmatter                                 | Load-time substitution inside the parser's `projectData`: the id (or each array element) is replaced with the referenced entry object. Applies identically at build, dev serve, and studio preview.                                        |
| table → content   | FK column stores the content entry id (`text`; no DB-level FK)      | Request-time: data routes accept `?include=<field,...>`; the mount resolves the entry from `_project.content`. v1 supports `include` for to-one only.                                                                                      |
| table → table     | FK column `<field>_id`; real FK constraint where the dialect allows | Request-time: `?include=` expands to-one via a join. To-many uses a junction table (§3).                                                                                                                                                   |
| content → table   | —                                                                   | **Disallowed statically.** Content is loaded at build time; table rows are live. Parser validation warns on `#/data/...` refs in content schemas. Model the association from the table side, or query dynamically with `TableQuery` state. |

---

## 3. Junction tables (table ↔ table to-many)

A to-many reference between tables is materialized by the connector's DDL
sync as an auto-managed junction table:

- **Name:** `${sourceTable}_${fieldName}`.
- **Columns:** `${sourceTable}_id`, `${targetTable}_id` (suffix `_2` on the
  target column for self-references), typed to match each table's id type.
- **Keys:** composite primary key over both columns; index on the target
  column.
- Managed additively like all connector DDL: created when missing, never
  dropped. **Renaming a to-many field orphans its junction table** (additive
  sync cannot see the rename); the old junction is reported as drift, not
  deleted.

---

## 4. Validation

- Reference fields must hold a string (to-one) or an array of strings
  (to-many); anything else fails entry validation.
- **Intra-section and content-to-content existence** is checked at load time
  by the parser (it holds all loaded sections): a dangling id is a validation
  error naming the field and target.
- **Table-side existence** (a row referencing a content entry or another row)
  is checked by the connector at write time.
- Cross-extension validation hooks beyond these are deferred.

---

## 5. Studio picker

The studio's field editor (`schema-field-ui`) exposes a `reference` field
type:

- **Target picker** enumerates the entries of every `referenceable`
  contribution, grouped by section label (from each extension's `project`
  block), and writes the chosen `#/<sectionKey>/<name>` pointer.
- **Cardinality toggle** (single / multiple) wraps or unwraps the
  `array`/`items` form.
- Value editors for reference fields present entry pickers populated from
  the resolved section data (`#/$context/<sectionKey>` enumeration).

## Changelog

- **0.1.3-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.2-draft** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.1.1-draft** (2026-07-08) — Shipped schema fragments + per-project schema emitters (`9e4a8936`).
- **0.1.0-draft** (2026-07-08) — Extensions v2 framework + docs (`3fb8795f`).

---

_Jx Relationships Specification v0.1.3-draft_
