/**
 * Refs.ts — pure document reference engine, shared by the rename refactor and the usage query.
 *
 * One structure-aware walk, two directions. {@link walkDocRefs} dispatches by JSON key and hands
 * every reference-bearing string to a visitor; whatever the visitor returns is written back, so a
 * visitor that always returns `null` is a pure reader. Three passes are built on it:
 *
 * - `rewriteDocRefs` — recompute every file-path reference across a rename (Pillar B).
 * - `rewriteTagName` — rename a custom-element tag wherever it is used (Pillar C).
 * - `countTagUses` — the same tag walk, counting instead of writing (the usage query).
 *
 * The walk dispatches by JSON key rather than searching strings, and mutates the passed document in
 * place — callers parse a fresh object per file, so this is safe. Precision comes from
 * `rewriteRef`'s resolve-and-compare gate in paths.ts: a reference is only rewritten (or counted as
 * a usage) when it actually resolves to the file in question.
 *
 * **A reference is not always a value.** Three of the four visit helpers offer a value under a
 * container-plus-position; {@link visitKeys} offers a map's KEYS, because `project.json`'s `copy`
 * map names the files it copies there. Everything downstream is unchanged — a key is renamed by the
 * same visitor returning the same kind of string — but the fourth shape had to exist before the
 * walk could see the reference at all (issue 242).
 *
 * The visitor seam is what stops the read side from being a second, drifting copy of the key list.
 * A new reference-bearing key added below is a key the usage count sees on the same commit.
 *
 * @docs studio/projects/pages-layouts-components
 */

import { classifyRef, looksLikeFileRef, rewriteRef } from "./paths.ts";
import type { RemapCtx } from "./paths.ts";

/** A single reference rewrite, for the rename report. */
export interface RefChange {
  refType: string;
  from: string;
  to: string;
}

export interface RewriteResult {
  doc: unknown;
  changes: RefChange[];
}

/**
 * One visit of a reference-bearing string.
 *
 * @param value — the raw authored reference, exactly as written.
 * @param refType — which key carried it (`$ref`, `$layout`, `attr`, `imports`, `$elements`, `url`,
 *   `source`, `copy` for a map KEY naming a copied file, or `path` for a value matched by shape
 *   rather than by key name).
 * @param rootRelativeBare — whether a bare value resolves against the project root (`$layout`,
 *   `copy`).
 * @returns A replacement string to write back, or `null` to leave the document untouched.
 */
export type RefVisitor = (
  value: string,
  refType: string,
  rootRelativeBare: boolean,
) => string | null;

/** Matches `url(...)` targets inside a CSS string value, capturing the optional quote. */
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/**
 * Keys whose string values are PROSE, and are therefore never offered to the shape fallback.
 *
 * A page that writes "see layouts/base.json" in its body text names a file without referencing it,
 * and rewriting that sentence during a rename would be vandalism. Almost every such string is
 * already excluded by the whitespace test in `looksLikeFileRef`; these two keys are where a
 * single-token one is plausible, and a whole-repo survey of file-shaped string values found
 * non-reference hits under no other key.
 */
const PROSE_KEYS = new Set(["textContent", "innerHTML"]);

/** Offer a scalar string reference under `key` to the visitor, writing back any replacement. */
function visitScalar(
  container: Record<string, unknown>,
  key: string,
  refType: string,
  visit: RefVisitor,
  rootRelativeBare: boolean,
): void {
  const value = container[key];
  if (typeof value !== "string") {
    return;
  }
  const out = visit(value, refType, rootRelativeBare);
  if (out !== null) {
    container[key] = out;
  }
}

/**
 * Offer every KEY of a map to the visitor, renaming in place and preserving insertion order.
 *
 * The fourth visit helper, and the only one whose reference is not a value. `project.json`'s `copy`
 * map names its sources in its keys (`{"assets/brochure.pdf": "brochure.pdf"}`), so a walk that
 * only ever offered values could not see them at all — renaming a copied file reported zero
 * references and rewrote nothing (issue 242).
 *
 * Order is preserved by rebuilding rather than by deleting one key and re-adding it: a plain
 * `delete` + set moves the renamed entry to the end, which is a diff on a file nobody edited. When
 * a rename collides with an existing key the later entry wins, exactly as an authored duplicate
 * would.
 */
function visitKeys(
  container: Record<string, unknown>,
  refType: string,
  visit: RefVisitor,
  rootRelativeBare: boolean,
): void {
  const entries = Object.entries(container);
  const renamed = entries.map(([key, value]): [string, unknown] => {
    const out = visit(key, refType, rootRelativeBare);
    return [out === null ? key : out, value];
  });
  if (renamed.every(([key], i) => key === entries[i]![0])) {
    return;
  }
  for (const [key] of entries) {
    delete container[key];
  }
  for (const [key, value] of renamed) {
    container[key] = value;
  }
}

/** Offer a string array member (e.g. an `$elements` entry) to the visitor. */
function visitIndexed(arr: unknown[], index: number, refType: string, visit: RefVisitor): void {
  const value = arr[index];
  if (typeof value !== "string") {
    return;
  }
  const out = visit(value, refType, false);
  if (out !== null) {
    arr[index] = out;
  }
}

/** Offer every `url(...)` target inside a CSS string to the visitor. */
function visitUrls(value: string, visit: RefVisitor): string {
  return value.replaceAll(URL_RE, (match, quote: string, inner: string) => {
    const out = visit(inner.trim(), "url", false);
    return out === null ? match : `url(${quote}${out}${quote})`;
  });
}

/** Walk a `style` value tree, visiting `url(...)` in every string it contains. */
function walkStyle(node: unknown, visit: RefVisitor): void {
  if (Array.isArray(node)) {
    const arr = node as unknown[];
    for (let i = 0; i < arr.length; i += 1) {
      const item = arr[i];
      if (typeof item === "string") {
        const out = visitUrls(item, visit);
        if (out !== item) {
          arr[i] = out;
        }
      } else {
        walkStyle(item, visit);
      }
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === "string") {
      const out = visitUrls(value, visit);
      if (out !== value) {
        obj[key] = out;
      }
    } else {
      walkStyle(value, visit);
    }
  }
}

/**
 * Recursive document walk dispatching each reference-bearing key to `visit`.
 *
 * This is the single definition of "what counts as a reference" in a Jx document. Mutates `doc`
 * only where the visitor asks it to.
 */
export function walkDocRefs(node: unknown, visit: RefVisitor): void {
  if (Array.isArray(node)) {
    for (const item of node as unknown[]) {
      walkDocRefs(item, visit);
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    switch (key) {
      case "$ref": {
        // File-path $ref only; state-scope refs (#/…, $map/…) are filtered by classifyRef.
        visitScalar(obj, key, "$ref", visit, false);
        break;
      }
      case "$layout": {
        visitScalar(obj, key, "$layout", visit, true);
        break;
      }
      case "$src":
      case "$implementation": {
        visitScalar(obj, key, key, visit, false);
        break;
      }
      case "src":
      case "href": {
        visitScalar(obj, key, "attr", visit, false);
        break;
      }
      case "imports": {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const imp = value as Record<string, unknown>;
          for (const name of Object.keys(imp)) {
            visitScalar(imp, name, "imports", visit, false);
          }
        }
        break;
      }
      case "$elements": {
        if (Array.isArray(value)) {
          const els = value as unknown[];
          for (let i = 0; i < els.length; i += 1) {
            if (typeof els[i] === "string") {
              visitIndexed(els, i, "$elements", visit);
            } else {
              walkDocRefs(els[i], visit);
            }
          }
        } else {
          walkDocRefs(value, visit);
        }
        break;
      }
      case "style": {
        walkStyle(value, visit);
        break;
      }
      case "copy": {
        /*
         * `project.json`'s declarative copy map (site-architecture.md §5). Its KEYS are project
         * files and its VALUES are destinations inside `outDir` — a directory the project does not
         * contain and a rename can never move. So the key is visited and the value deliberately is
         * not: offering the value to the shape fallback, which is what happened before, meant
         * renaming a file at the project root could rewrite an unrelated copy DESTINATION that
         * merely shared its name.
         */
        if (value && typeof value === "object" && !Array.isArray(value)) {
          visitKeys(value as Record<string, unknown>, "copy", visit, true);
        }
        break;
      }
      case "source": {
        /*
         * A content collection's source (site-architecture.md §6), which may name a single file
         * (`./content/listings.csv`) or a DIRECTORY (`./content/posts/`).
         *
         * Named rather than left to the shape fallback because a directory has no extension, and
         * the extension test is exactly what keeps that fallback from admitting every route and
         * bare word. Here the key is known and the value's shape is not diagnostic, so the value is
         * offered unconditionally and precision stays where it always was — the caller's
         * resolve-and-compare gate, which only matches a value resolving to the file or directory
         * in question. A remote `https://…` source is filtered by `classifyRef` before that.
         */
        visitScalar(obj, key, "source", visit, false);
        break;
      }
      /*
       * Everything else, by SHAPE.
       *
       * The cases above are the keys that carry a reference BY NAME, and for years that list was
       * taken to be the whole of it. It is not: the commonest media reference in a real project is
       * a schema-typed component prop (`$props.bg`, `attributes["props.image"]`), and beside it sit
       * a content entry's frontmatter (`cover:`), a prop schema's `default`, `project.json`'s
       * `defaults.layout`, `poster`, `srcset` and `$head` meta `content`. Measured across the
       * committed starters, 73 of 101 files under `public/` were used and reported zero.
       *
       * Naming those keys one at a time would be the same mistake with a longer list — the next
       * extension to define a media-typed prop would reopen it. So an unrecognised string is
       * offered whenever it is SHAPED like a file, and precision stays where it already was: the
       * caller's resolve-and-compare gate, which only counts a value that resolves to the exact
       * file in question.
       */
      default: {
        if (typeof value === "string") {
          if (!PROSE_KEYS.has(key) && looksLikeFileRef(value)) {
            visitScalar(obj, key, "path", visit, false);
          }
        } else if (Array.isArray(value)) {
          const arr = value as unknown[];
          for (let i = 0; i < arr.length; i += 1) {
            const item = arr[i];
            if (typeof item === "string") {
              if (!PROSE_KEYS.has(key) && looksLikeFileRef(item)) {
                visitIndexed(arr, i, "path", visit);
              }
            } else {
              walkDocRefs(item, visit);
            }
          }
        } else {
          walkDocRefs(value, visit);
        }
      }
    }
  }
}

/** Rewrite every file-path reference in `doc` for a rename described by `ctx`. Mutates `doc`. */
export function rewriteDocRefs(doc: unknown, ctx: RemapCtx): RewriteResult {
  const changes: RefChange[] = [];
  walkDocRefs(doc, (value, refType, rootRelativeBare) => {
    const cls = classifyRef(value);
    if (cls.kind !== "path") {
      return null;
    }
    const out = rewriteRef(cls, ctx, rootRelativeBare);
    if (out === null) {
      return null;
    }
    changes.push({ from: value, refType, to: out });
    return out;
  });
  return { changes, doc };
}

/**
 * Recursive tag walk. With `newTag` set, every `tagName === oldTag` is rewritten; with `newTag`
 * null, they are only counted — the read side of the same traversal.
 */
function walkTags(
  node: unknown,
  oldTag: string,
  newTag: string | null,
  counter: { n: number },
): void {
  if (Array.isArray(node)) {
    for (const item of node as unknown[]) {
      walkTags(item, oldTag, newTag, counter);
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.tagName === oldTag) {
    if (newTag !== null) {
      obj.tagName = newTag;
    }
    counter.n += 1;
  }
  for (const key of Object.keys(obj)) {
    walkTags(obj[key], oldTag, newTag, counter);
  }
}

/**
 * Rename a custom-element tag throughout `doc` — instance nodes (`<old-tag>`), mapped-list
 * `map.tagName`, and the component definition file's own root `tagName`. File references (`$ref`,
 * `$elements`, `cases`) are intentionally left to `rewriteDocRefs`, so the two passes compose.
 * Mutates `doc`.
 */
export function rewriteTagName(
  doc: unknown,
  oldTag: string,
  newTag: string,
): { doc: unknown; count: number } {
  const counter = { n: 0 };
  if (oldTag !== newTag) {
    walkTags(doc, oldTag, newTag, counter);
  }
  return { count: counter.n, doc };
}

/**
 * How many nodes in `doc` carry `tagName === tag`. Read-only; `doc` is never touched.
 *
 * A component's OWN definition file answers 1 for its root node, which is why the usage query skips
 * the definition file rather than subtracting one — a component may legitimately nest itself.
 */
export function countTagUses(doc: unknown, tag: string): number {
  const counter = { n: 0 };
  walkTags(doc, tag, null, counter);
  return counter.n;
}
