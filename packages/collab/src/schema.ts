/**
 * The shared Y.Doc schema for a Jx document, and the JSON ↔ Y mapping.
 *
 * Layout (all top-level types, created on demand): - `meta: Y.Map` — schemaVersion,
 * structureSeeded, canonical ("structure" | "source"), canonicalRev (representation-flip counter —
 * distinct from the provider's wire docEpoch), sourceFormat. - `frontmatter: Y.Map` — per-field
 * plain-JSON values (LWW per field). - `structure: Y.Map` — the root JxMutableNode. - `source:
 * Y.Text` — the serialized source. THE authoritative file content: providers persist
 * `getText("source").toString()` and never parse or serialize Jx documents themselves; the
 * structure tree is a Studio-side projection kept in sync by the bridge.
 *
 * **CRDT granularity is deliberately FINER than Studio's op-log granularity.** Every node is a
 * Y.Map; within it, "children" is a Y.Array, {@link TEXT_KEYS} are `Y.Text`,
 * {@link GRANULAR_OBJECT_KEYS} are nested Y.Maps, and everything else is a whole-JSON LWW value.
 *
 * The two granularities used to match, on the reasoning that mutators emit whole-value set-keys so
 * deeper Y types would add merge surface nothing targets. That reasoning was wrong: it conflated
 * what an EDIT addresses with what a MERGE must resolve. Two authors typing in one paragraph, or
 * setting `color` and `padding` on one element, produce whole-value ops that a whole-value CRDT can
 * only resolve by discarding one of them. The bridge therefore diffs a whole-value op down onto the
 * granular representation ({@link applyTextEdit}, {@link mergeYObject}) and {@link yValueToJson}
 * reassembles whole values on the way out — so `JxDocOp`, the canvas patcher and the history ring
 * are unchanged, while concurrent edits actually merge.
 *
 * Seeding contract: providers seed only `source` (from file bytes). Clients derive `structure` on
 * first sync via {@link seedStructure}, which is convergence-safe under concurrent seeders because
 * it only performs whole-key Y.Map sets (per-key LWW picks one seeder's subtrees wholesale) — never
 * array inserts, which would duplicate.
 */

import * as Y from "yjs";
import type { JxMutableNode, JxPath } from "@jxsuite/schema/types";

export const META_KEY = "meta";
export const FRONTMATTER_KEY = "frontmatter";
export const STRUCTURE_KEY = "structure";
export const SOURCE_KEY = "source";

/**
 * Bumped to 2 when prose moved to `Y.Text` and style/attributes/$props to nested `Y.Map`s.
 *
 * Written into `meta` at seed time and not currently validated on load. A room persisted under 1
 * still READS correctly ({@link yValueToJson} passes plain values through) and self-heals on the
 * first edit to a given key, since the bridge replaces a non-granular container. Two clients
 * running DIFFERENT versions in one room would disagree about merge granularity — see §5 of
 * specs/collab.md on version skew, which this does not attempt to solve.
 */
export const COLLAB_SCHEMA_VERSION = 2;

export function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(META_KEY);
}

export function frontmatterMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(FRONTMATTER_KEY);
}

export function structureMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(STRUCTURE_KEY);
}

export function sourceText(doc: Y.Doc): Y.Text {
  return doc.getText(SOURCE_KEY);
}

/** JSON round-trip clone (normalizes away proxies/undefined; matches the ops applier). */
function cloneJson<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON normalization is the point
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Node keys whose STRING value is stored as a `Y.Text` rather than an opaque string.
 *
 * This is the character-level-collaboration decision. Whole-paragraph last-writer-wins was never a
 * Yjs limitation — it was this schema storing prose as a plain LWW value, so two people typing in
 * one paragraph clobbered each other and only `source` (which the canvas does not edit) merged per
 * character.
 *
 * `innerHTML` is deliberately absent: it is an opaque markup blob, never caret-edited.
 */
export const TEXT_KEYS: ReadonlySet<string> = new Set(["textContent"]);

/**
 * Node keys stored as a nested `Y.Map` so concurrent edits to DIFFERENT properties both survive.
 *
 * `mutateUpdateStyle` and friends record a whole-object `set-key`, so writing the object as one LWW
 * value meant A's `color` and B's `padding` raced and one lost. Per-property merge fixes that
 * without touching the op vocabulary: {@link yValueToJson} reassembles the whole object on the way
 * out, so `JxDocOp`, the canvas patcher and the history ring keep seeing whole values.
 *
 * Declaration VALUES stay plain (a CSS value is never partially edited); only the key space is
 * granular. Nesting recurses, which covers `style`'s media (`@--sm`) and pseudo (`&:hover`)
 * blocks.
 */
export const GRANULAR_OBJECT_KEYS: ReadonlySet<string> = new Set(["style", "attributes", "$props"]);

/**
 * Rewrite a `Y.Text` to `next` with a minimal edit (common prefix/suffix trimmed).
 *
 * Minimal rather than replace-all for two reasons: the wire carries only the delta, and — the
 * load-bearing one — the surviving characters keep their identity, so a concurrent remote insert
 * inside the untouched region merges instead of being clobbered. Returns false when already equal.
 */
export function applyTextEdit(text: Y.Text, next: string): boolean {
  const current = text.toString();
  if (current === next) {
    return false;
  }
  let start = 0;
  const minLen = Math.min(current.length, next.length);
  while (start < minLen && current[start] === next[start]) {
    start += 1;
  }
  let endCurrent = current.length;
  let endNext = next.length;
  while (endCurrent > start && endNext > start && current[endCurrent - 1] === next[endNext - 1]) {
    endCurrent -= 1;
    endNext -= 1;
  }
  if (endCurrent > start) {
    text.delete(start, endCurrent - start);
  }
  if (endNext > start) {
    text.insert(start, next.slice(start, endNext));
  }
  return true;
}

/** A plain object becomes a Y.Map, recursing into nested objects; other values stay plain JSON. */
export function toYObject(value: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    map.set(key, isPlainObject(entry) ? toYObject(entry) : cloneJson(entry));
  }
  return map;
}

/**
 * Merge a plain object into an existing Y.Map per key: set changed keys, delete removed ones,
 * recurse into nested maps. Whole-value replacement would mint a new Y.Map and discard a peer's
 * concurrent edit to an untouched sibling property — the very thing granularity exists to prevent.
 */
export function mergeYObject(map: Y.Map<unknown>, value: Record<string, unknown>): void {
  // Detached key list: deleting from a Y.Map while iterating its live keys is unsafe.
  // oxlint-disable-next-line unicorn/no-useless-spread -- the copy is the point (mutation during iteration)
  for (const key of [...map.keys()]) {
    if (!(key in value) || value[key] === undefined) {
      map.delete(key);
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    const existing = map.get(key);
    if (isPlainObject(entry)) {
      if (existing instanceof Y.Map) {
        mergeYObject(existing, entry);
      } else {
        map.set(key, toYObject(entry));
      }
    } else if (!deepEqualJson(existing, entry)) {
      map.set(key, cloneJson(entry));
    }
  }
}

/** Structural equality over plain JSON, used to skip no-op key writes. */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a instanceof Y.Map || a instanceof Y.Array || a instanceof Y.Text) {
    return false;
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** A child value: a bare string becomes a Y.Text (per-character merge), a node becomes a Y.Map. */
export function toYChild(child: unknown): unknown {
  return typeof child === "string" ? new Y.Text(child) : toYNode(child);
}

/** A children array becomes a Y.Array of node Y.Maps and Y.Texts. */
export function toYChildren(children: readonly unknown[]): Y.Array<unknown> {
  const arr = new Y.Array<unknown>();
  arr.insert(
    0,
    children.map((child) => toYChild(child)),
  );
  return arr;
}

/**
 * A node object becomes a Y.Map. Nesting is no longer limited to `children`: text keys become
 * `Y.Text` and {@link GRANULAR_OBJECT_KEYS} become nested `Y.Map`s, so the CRDT merges at the
 * granularity edits actually happen at. Everything else stays a whole-JSON LWW value.
 */
export function toYNode(node: unknown): Y.Map<unknown> {
  if (!isPlainObject(node)) {
    throw new TypeError("collab-schema: a document node must be a plain object");
  }
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) {
      continue;
    }
    if (key === "children" && Array.isArray(value)) {
      map.set(key, toYChildren(value));
    } else if (TEXT_KEYS.has(key) && typeof value === "string") {
      map.set(key, new Y.Text(value));
    } else if (GRANULAR_OBJECT_KEYS.has(key) && isPlainObject(value)) {
      map.set(key, toYObject(value));
    } else {
      map.set(key, cloneJson(value));
    }
  }
  return map;
}

/** Convert any structure value (Y.Map, Y.Array, Y.Text, or plain leaf) back to JSON. */
export function yValueToJson(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      out[key] = yValueToJson(entry);
    }
    return out;
  }
  if (value instanceof Y.Array) {
    return value.toArray().map((entry) => yValueToJson(entry));
  }
  if (value instanceof Y.Text) {
    return value.toString();
  }
  return value;
}

/** The whole structure tree as a plain document (deep, detached copy). */
export function yDocToJson(doc: Y.Doc): JxMutableNode {
  return yValueToJson(structureMap(doc)) as JxMutableNode;
}

/**
 * Resolve a JxPath against the structure tree. Returns the Y value at the path (a node Y.Map, a
 * children Y.Array, a string child, or a plain leaf) or undefined when any segment is missing.
 */
export function resolveYPath(doc: Y.Doc, path: JxPath): unknown {
  let current: unknown = structureMap(doc);
  for (const segment of path) {
    if (current instanceof Y.Map) {
      current = current.get(String(segment));
    } else if (current instanceof Y.Array) {
      const index = typeof segment === "number" ? segment : Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current.get(index);
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Update the source Y.Text to `next` with a minimal edit (common prefix/suffix trimmed), so mirror
 * refreshes don't ship the whole document over the wire. Returns false when already identical.
 */
export function updateSourceText(doc: Y.Doc, next: string, origin?: unknown): boolean {
  const text = sourceText(doc);
  if (text.toString() === next) {
    return false;
  }
  doc.transact(() => {
    applyTextEdit(text, next);
  }, origin);
  return true;
}

/**
 * Populate the structure tree (and frontmatter/meta) from a parsed document — the client-side
 * first-sync step. Safe under concurrent seeders: every write is a whole-key Y.Map set, so two
 * racing seeds converge to one seeder's subtrees via per-key LWW with no duplication. No-op when
 * another seeder already won.
 */
export function seedStructure(
  doc: Y.Doc,
  document: JxMutableNode,
  opts: {
    frontmatter?: Record<string, unknown>;
    sourceFormat?: string | null;
    origin?: unknown;
  } = {},
): boolean {
  const meta = metaMap(doc);
  if (meta.get("structureSeeded") === true) {
    return false;
  }
  doc.transact(() => {
    const structure = structureMap(doc);
    for (const [key, value] of Object.entries(document)) {
      if (value === undefined) {
        continue;
      }
      if (key === "children" && Array.isArray(value)) {
        structure.set(key, toYChildren(value));
      } else {
        structure.set(key, cloneJson(value));
      }
    }
    const frontmatter = frontmatterMap(doc);
    for (const [key, value] of Object.entries(opts.frontmatter ?? {})) {
      if (value !== undefined) {
        frontmatter.set(key, cloneJson(value));
      }
    }
    meta.set("schemaVersion", COLLAB_SCHEMA_VERSION);
    meta.set("canonical", "structure");
    meta.set("canonicalRev", 0);
    meta.set("sourceFormat", opts.sourceFormat ?? null);
    meta.set("structureSeeded", true);
  }, opts.origin);
  return true;
}
