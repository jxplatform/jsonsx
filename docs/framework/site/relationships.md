---
title: "Relationships"
description: "Link content entries to each other with #/content references: to-one and to-many fields, stored ids, and build-time resolution."
spec:
  - relationships.md#1
  - relationships.md#2
  - relationships.md#4
code:
  - extensions/parser/src/content-loader.ts
---

# Relationships

> **Studio writes this format for you.** The [content-type builder](/docs/studio/projects/content-types) creates reference fields visually — this page documents the schema they produce and how references resolve at build time.

A relationship links one content entry to another: a blog post to its author, a product to its tags. You declare it once, in the field's JSON Schema inside the `content` section of `project.json` — that single declaration drives validation, build-time resolution, and Studio's entry pickers.

## The reference form

A reference field's schema points at the target content type with a `#/content/<type>` pointer:

```json
{
  "content": {
    "authors": { "source": "./content/authors/", "format": "Markdown" },
    "blog": {
      "source": "./content/blog/",
      "format": "Markdown",
      "schema": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "author": { "$ref": "#/content/authors" }
        }
      }
    }
  }
}
```

Cardinality is expressed with plain JSON Schema — there is no separate relationship syntax:

| Cardinality | Field schema                                                 |
| ----------- | ------------------------------------------------------------ |
| To-one      | `{ "$ref": "#/content/authors" }`                            |
| To-many     | `{ "type": "array", "items": { "$ref": "#/content/tags" } }` |

## What entries store

Entries store the target's **entry id** — a string for to-one, an array of strings for to-many. For a Markdown collection the id is the entry's filename, so a post in `content/blog/` referencing `content/authors/jane-doe.md` looks like:

```yaml
---
title: My Post
author: jane-doe
tags: [intro, tooling]
---
```

Anything other than a string (or array of strings, for to-many) fails the field's validation.

## Resolution

References resolve when content loads — at build, in the dev server, and in Studio preview alike. The stored id is replaced in place with the full referenced entry, so by the time a page sees the data, `author` is no longer `"jane-doe"` but the whole author entry (`id`, `data`, body). Templates walk straight through:

```json
{ "tagName": "span", "textContent": "${state.post.data.author.data.name}" }
```

For a to-many field, each id in the array is replaced by its entry the same way.

An id that matches no entry in the target type is left untouched — the raw string stays in the data. Guard templates accordingly, or keep ids and filenames in sync.

## Beyond content

The same reference form generalizes: a pointer targets any project section whose extension declares it referenceable, as `#/<sectionKey>/<name>`. File-based content resolves at load time as described above; connection-backed table sections (from the connector extension) store the id in a column and resolve at request time instead. One direction is disallowed outright: a **content** schema cannot reference a **table** section — content is loaded once at build time while table rows are live, so model that association from the table side.

## Related

- [Content collections](/docs/framework/site/content-collections) — defining content types and their schemas
- [Content types in Studio](/docs/studio/projects/content-types) — building these schemas visually
- [References](/docs/framework/concepts/references) — `$ref` inside documents, a different mechanism
