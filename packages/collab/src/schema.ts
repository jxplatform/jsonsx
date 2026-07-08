/**
 * The shared Y.Doc schema for a Jx document, and the JSON ↔ Y mapping.
 *
 * Layout (all top-level types, created on demand): - `meta: Y.Map` — schemaVersion,
 * structureSeeded, canonical ("structure" | "source"), canonicalRev (representation-flip counter —
 * distinct from the provider's wire docEpoch), sourceFormat. - `frontmatter: Y.Map` — per-field
 * plain-JSON values (LWW per field). - `structure: Y.Map` — the root JxMutableNode. Every node is a
 * Y.Map whose ONLY nested Y container is "children" (a Y.Array of node Y.Maps and plain strings);
 * every other key holds a plain deep-JSON value merged whole (LWW). The CRDT granularity
 * deliberately equals Studio's op-log granularity — mutators emit whole-value set-keys and children
 * splices, so deeper Y types would add merge surface nothing can target. - `source: Y.Text` — the
 * serialized source. THE authoritative file content: providers persist
 * `getText("source").toString()` and never parse or serialize Jx documents themselves; the
 * structure tree is a Studio-side projection kept in sync by the bridge.
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

export const COLLAB_SCHEMA_VERSION = 1;

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

/** A children array becomes a Y.Array of node Y.Maps and plain strings. */
export function toYChildren(children: readonly unknown[]): Y.Array<unknown> {
  const arr = new Y.Array<unknown>();
  arr.insert(
    0,
    children.map((child) => (typeof child === "string" ? child : toYNode(child))),
  );
  return arr;
}

/** A node object becomes a Y.Map; only its "children" key nests further Y types. */
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
    } else {
      map.set(key, cloneJson(value));
    }
  }
  return map;
}

/** Convert any structure value (Y.Map node, Y.Array children, or plain leaf) back to JSON. */
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
  doc.transact(() => {
    if (endCurrent > start) {
      text.delete(start, endCurrent - start);
    }
    if (endNext > start) {
      text.insert(start, next.slice(start, endNext));
    }
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
