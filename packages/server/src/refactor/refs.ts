/**
 * Refs.ts — pure document reference engine for rename-refactoring.
 *
 * Two passes, both operating on a parsed (JSON) document tree with no filesystem access: -
 * `rewriteDocRefs` — recompute every file-path reference across a rename (Pillar B). -
 * `rewriteTagName` — rename a custom-element tag wherever it is used (Pillar C).
 *
 * The walk is structure-aware (it dispatches by JSON key), not a blind string search, and mutates
 * the passed document in place — callers parse a fresh object per file, so this is safe. Precision
 * comes from `rewriteRef`'s resolve-and-compare gate in paths.ts: a reference is only rewritten
 * when it actually resolves to the renamed file.
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

/** Matches `url(...)` targets inside a CSS string value, capturing the optional quote. */
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** Recompute a scalar string reference under `key`, recording any change. */
function rewriteScalar(
  container: Record<string, unknown>,
  key: string,
  refType: string,
  ctx: RemapCtx,
  changes: RefChange[],
  rootRelativeBare: boolean,
): void {
  const value = container[key];
  const cls = classifyRef(value);
  if (cls.kind !== "path") {
    return;
  }
  const out = rewriteRef(cls, ctx, rootRelativeBare);
  if (out !== null) {
    changes.push({ from: value as string, refType, to: out });
    container[key] = out;
  }
}

/** Recompute a string array member (e.g. an `$elements` entry), recording any change. */
function rewriteIndexed(
  arr: unknown[],
  index: number,
  refType: string,
  ctx: RemapCtx,
  changes: RefChange[],
): void {
  const value = arr[index];
  const cls = classifyRef(value);
  if (cls.kind !== "path") {
    return;
  }
  const out = rewriteRef(cls, ctx, false);
  if (out !== null) {
    changes.push({ from: value as string, refType, to: out });
    arr[index] = out;
  }
}

/** Rewrite every `url(...)` target inside a CSS string. */
function rewriteUrls(value: string, ctx: RemapCtx, changes: RefChange[]): string {
  return value.replaceAll(URL_RE, (match, quote: string, inner: string) => {
    const cls = classifyRef(inner.trim());
    if (cls.kind !== "path") {
      return match;
    }
    const out = rewriteRef(cls, ctx, false);
    if (out === null) {
      return match;
    }
    changes.push({ from: inner.trim(), refType: "url", to: out });
    return `url(${quote}${out}${quote})`;
  });
}

/** Walk a `style` value tree, rewriting `url(...)` in every string it contains. */
function walkStyle(node: unknown, ctx: RemapCtx, changes: RefChange[]): void {
  if (Array.isArray(node)) {
    const arr = node as unknown[];
    for (let i = 0; i < arr.length; i += 1) {
      const item = arr[i];
      if (typeof item === "string") {
        const out = rewriteUrls(item, ctx, changes);
        if (out !== item) {
          arr[i] = out;
        }
      } else {
        walkStyle(item, ctx, changes);
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
      const out = rewriteUrls(value, ctx, changes);
      if (out !== value) {
        obj[key] = out;
      }
    } else {
      walkStyle(value, ctx, changes);
    }
  }
}

/** Recursive document walk dispatching each reference-bearing key. */
function walk(node: unknown, ctx: RemapCtx, changes: RefChange[]): void {
  if (Array.isArray(node)) {
    for (const item of node as unknown[]) {
      walk(item, ctx, changes);
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
        rewriteScalar(obj, key, "$ref", ctx, changes, false);
        break;
      }
      case "$layout": {
        rewriteScalar(obj, key, "$layout", ctx, changes, true);
        break;
      }
      case "$src":
      case "$implementation": {
        rewriteScalar(obj, key, key, ctx, changes, false);
        break;
      }
      case "src":
      case "href": {
        rewriteScalar(obj, key, "attr", ctx, changes, false);
        break;
      }
      case "imports": {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const imp = value as Record<string, unknown>;
          for (const name of Object.keys(imp)) {
            rewriteScalar(imp, name, "imports", ctx, changes, false);
          }
        }
        break;
      }
      case "$elements": {
        if (Array.isArray(value)) {
          const els = value as unknown[];
          for (let i = 0; i < els.length; i += 1) {
            if (typeof els[i] === "string") {
              rewriteIndexed(els, i, "$elements", ctx, changes);
            } else {
              walk(els[i], ctx, changes);
            }
          }
        } else {
          walk(value, ctx, changes);
        }
        break;
      }
      case "style": {
        walkStyle(value, ctx, changes);
        break;
      }
      default: {
        walk(value, ctx, changes);
      }
    }
  }
}

/** Rewrite every file-path reference in `doc` for a rename described by `ctx`. Mutates `doc`. */
export function rewriteDocRefs(doc: unknown, ctx: RemapCtx): RewriteResult {
  const changes: RefChange[] = [];
  walk(doc, ctx, changes);
  return { changes, doc };
}

/** Recursive walk setting `tagName: newTag` wherever it currently equals `oldTag`. */
function walkTags(node: unknown, oldTag: string, newTag: string, counter: { n: number }): void {
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
    obj.tagName = newTag;
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
