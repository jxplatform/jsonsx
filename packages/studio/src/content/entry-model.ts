/**
 * The content-entry model — which collection an entry belongs to, and what a NEW one contains. Pure
 * over its inputs (the project config it reads, the schema it is handed), so the seeding rules can
 * be asserted without a DOM, a platform or a tab.
 *
 * **Two facts this module exists to stop being restated.**
 *
 * 1. **A new entry is seeded, not blank.** `library-pane.ts`'s collection branch created the file
 *    through the shared creation flow with no extension and no body, so a new `blog` entry landed
 *    as `content/blog/untitled` — no `.md`, therefore matched by no format, therefore not an entry
 *    of the collection it was created in, and its required fields were absent rather than empty.
 *    {@link seedEntry} answers with the schema's own defaults, and every REQUIRED property that
 *    declares none gets a typed empty, because "present and blank" is a valid entry the author can
 *    fill in and "absent" is a validation failure they did not cause.
 * 2. **Where the entry files are** is `collectionInfo`'s answer, imported rather than recomputed.
 *    Three copies of "which collection owns this path, and what extension do its entries carry"
 *    already exist (`utils/studio-utils.ts`'s `findContentTypeSchema`, `grid/sources/content-
 *    source.ts`'s `collectionInfo`, `browse/library-model.ts`'s `contentTypeFor`); this module adds
 *    no fourth and calls the two that are exported.
 *
 * **The draft axis is NOT here.** `content/draft-state.ts` owns what a draft is and whether drafts
 * are listed, because this module imports `content-source.ts` and the grid source must be able to
 * ask what a draft is — the reverse edge would be a cycle, and `import/no-cycle` is an error here.
 */

import { collectionInfo } from "../grid/sources/content-source";
import { projectState } from "../store";
import { findContentTypeSchema } from "../utils/studio-utils";
import type { ContentSectionEntry } from "../types";
import type { ContentTypeSchema, ContentTypeSchemaField } from "@jxsuite/schema/types";

// ─── Collections ─────────────────────────────────────────────────────────────

/** One content collection, as the entry surfaces need it. */
export interface EntryCollection {
  name: string;
  /** Source directory, project-relative and without a trailing slash. */
  dir: string;
  /** The extension a new entry of this collection is written with (`.md`, `.json`, …). */
  ext: string;
  schema: ContentTypeSchema | null;
  def: ContentSectionEntry;
}

/** Every content type the project declares, in declaration order. */
export function collectionNames(): string[] {
  return Object.keys((projectState?.projectConfig?.content ?? {}) as Record<string, unknown>);
}

/**
 * The collection named `name`, or null when the project declares no such directory-backed type.
 *
 * A collection whose `source` names a FILE (a CSV catalogue) has no per-entry files, so it has no
 * entry editor and no New Entry — `collectionInfo` still answers for it, and this rejects it here
 * rather than letting a caller compose `products/catalog.csv/untitled.csv`.
 */
export function entryCollection(name: string): EntryCollection | null {
  const info = collectionInfo(name);
  if (!info) {
    return null;
  }
  if (/\.[a-z\d]+$/i.test(info.dir)) {
    return null;
  }
  return {
    def: info.def,
    dir: info.dir,
    ext: info.ext,
    name: info.name,
    schema: info.def.schema ?? null,
  };
}

/** The collections a New Entry can be created in — directory-backed types only. */
export function entryCollections(): EntryCollection[] {
  return collectionNames()
    .map((name) => entryCollection(name))
    .filter((collection): collection is EntryCollection => collection !== null);
}

/**
 * The collection a document path belongs to, or null.
 *
 * Delegates to `findContentTypeSchema`, which is the matcher the frontmatter surfaces already use —
 * including its Windows backslash normalisation and its file-source (CSV) branch. A path that
 * matches a type with no `schema` is NOT a match there, and that is the right answer here too: an
 * entry editor over a collection that declares no shape has no form to draw.
 */
export function collectionOfPath(path: string | null): EntryCollection | null {
  const matched = findContentTypeSchema(path ?? null, projectState?.projectConfig);
  return matched ? entryCollection(matched.name) : null;
}

// ─── Seeding a new entry ─────────────────────────────────────────────────────

/** Deep copy of a schema `default`, so two entries seeded from one schema never share an object. */
function cloneDefault(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/**
 * The empty value of a declared type — what a REQUIRED property with no `default` is seeded with.
 *
 * A reference (`$ref` to another collection) seeds as `""`: it is required, so the key must exist,
 * and picking an arbitrary entry of the target collection on the author's behalf would be inventing
 * a relationship they never stated.
 */
function emptyForField(field: ContentTypeSchemaField): unknown {
  if (typeof field.$ref === "string") {
    return "";
  }
  switch (field.type) {
    case "boolean": {
      return false;
    }
    case "integer":
    case "number": {
      return 0;
    }
    case "array": {
      return [];
    }
    case "object": {
      return seedEntry(field as ContentTypeSchema);
    }
    default: {
      return "";
    }
  }
}

/**
 * The frontmatter a new entry of this schema starts life with.
 *
 * Two rules, and nothing else:
 *
 * - A property that declares a `default` gets it (cloned);
 * - A property listed in `required` that declares no default gets its type's empty value.
 *
 * An optional property with no default is **omitted**. Seeding every declared field would write the
 * author's file full of keys they never asked for, and "the schema mentions it" is not a reason for
 * it to exist on disk — the form still draws a row for it, because the form draws the SCHEMA.
 */
export function seedEntry(schema: ContentTypeSchema | null | undefined): Record<string, unknown> {
  const properties = schema?.properties;
  if (!properties) {
    return {};
  }
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const seed: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(properties)) {
    if (field.default !== undefined) {
      seed[name] = cloneDefault(field.default);
    } else if (required.has(name)) {
      seed[name] = emptyForField(field);
    }
  }
  return seed;
}

/**
 * Required properties this record leaves absent — what a caller checks before claiming an entry is
 * valid. `seedEntry`'s whole promise is that this is empty for a freshly seeded entry.
 */
export function missingRequired(
  schema: ContentTypeSchema | null | undefined,
  value: Record<string, unknown>,
): string[] {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return required.filter((name) => value[name] === undefined);
}
