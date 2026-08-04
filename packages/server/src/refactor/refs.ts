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
 * The visitor seam is what stops the read side from being a second, drifting copy of the key list.
 * A new reference-bearing key added below is a key the usage count sees on the same commit.
 */

import { classifyRef, rewriteRef } from "./paths.ts";
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
 * @param refType — which key carried it (`$ref`, `$layout`, `attr`, `imports`, `$elements`, `url`).
 * @param rootRelativeBare — whether a bare value resolves against the project root (`$layout`).
 * @returns A replacement string to write back, or `null` to leave the document untouched.
 */
export type RefVisitor = (
  value: string,
  refType: string,
  rootRelativeBare: boolean,
) => string | null;

/** Matches `url(...)` targets inside a CSS string value, capturing the optional quote. */
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

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
      default: {
        walkDocRefs(value, visit);
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
