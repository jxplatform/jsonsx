/**
 * Structural differ: `diffDocs(a, b)` produces JxDocOps that transform document `a` into `b` when
 * replayed sequentially (property invariant: `apply(clone(a), diffDocs(a, b)) ≡ b`). The collab
 * bridge uses it wherever no op-log exists — whole-document bypass writes (Monaco parse-flush,
 * navigation, reload), un-instrumented transactions, and inbound Y transactions too gnarly for the
 * fast event path.
 *
 * Children alignment: an LCS over strong keys (full-content hashes) pins unchanged nodes as
 * anchors; the gaps between anchors align by a second LCS over weak signatures (tagName +
 * id/$props.key) whose pairs diff recursively. Unmatched items become splices. Reorders of
 * identical siblings therefore degrade to remove+insert — exactly what the Y move mapping does, so
 * no fidelity is lost relative to the wire.
 */

import type { JxMutableNode, JxPath } from "@jxsuite/schema/types";
import type { JxDocOp } from "./ops.ts";
import { metaMap, structureMap, toYChildren } from "./schema.ts";
import type * as Y from "yjs";

export interface DiffOptions {
  /** Abort (return null) when the diff would exceed this many ops; caller hard-replaces instead. */
  maxOps?: number;
}

const DEFAULT_MAX_OPS = 500;

class MaxOpsExceededError extends Error {
  override name = "MaxOpsExceededError";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Order-insensitive for object keys, order-sensitive for arrays. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length && keysA.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function contentHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash, 33) + (text.codePointAt(i) ?? 0);
  }
  return hash.toString(36);
}

/** Full-content identity: equal strong keys mean "treat as the same unchanged child". */
function strongKey(item: unknown): string {
  return typeof item === "string" ? `s:${item}` : `n:${contentHash(JSON.stringify(item))}`;
}

/** Alignment identity: equal weak keys mean "same logical child, diff its contents". */
function weakKey(item: unknown): string {
  if (typeof item === "string") {
    return "s";
  }
  const node = item as Record<string, unknown>;
  const attrs = node["attributes"];
  const props = node["$props"];
  const id =
    (isPlainObject(attrs) ? attrs["id"] : undefined) ??
    (isPlainObject(props) ? props["key"] : undefined) ??
    "";
  return `w:${String(node["tagName"] ?? "")}:${String(id)}`;
}

/** Longest common subsequence over key arrays; returns strictly-increasing index pairs. */
function lcsPairs(aKeys: readonly string[], bKeys: readonly string[]): [number, number][] {
  const n = aKeys.length;
  const m = bKeys.length;
  if (n === 0 || m === 0) {
    return [];
  }
  // Classic DP table; children arrays are small (bounded by document size, typically < 200).
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        aKeys[i] === bKeys[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aKeys[i] === bKeys[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

interface ChildMatch {
  aIndex: number;
  bIndex: number;
  /** Strong matches are byte-identical — no recursion needed. */
  identical: boolean;
}

/** Anchor by strong LCS, then align each gap by weak LCS. Matches never cross. */
function matchChildren(a: readonly unknown[], b: readonly unknown[]): ChildMatch[] {
  const anchors = lcsPairs(
    a.map((item) => strongKey(item)),
    b.map((item) => strongKey(item)),
  );
  const matches: ChildMatch[] = [];
  let prevA = -1;
  let prevB = -1;
  const gaps: [number, number, number, number][] = [];
  for (const [ai, bi] of anchors) {
    gaps.push([prevA + 1, ai, prevB + 1, bi]);
    matches.push({ aIndex: ai, bIndex: bi, identical: true });
    prevA = ai;
    prevB = bi;
  }
  gaps.push([prevA + 1, a.length, prevB + 1, b.length]);
  for (const [aStart, aEnd, bStart, bEnd] of gaps) {
    const aGap = a.slice(aStart, aEnd);
    const bGap = b.slice(bStart, bEnd);
    for (const [gi, gj] of lcsPairs(
      aGap.map((item) => weakKey(item)),
      bGap.map((item) => weakKey(item)),
    )) {
      matches.push({ aIndex: aStart + gi, bIndex: bStart + gj, identical: false });
    }
  }
  return matches.toSorted((x, y) => x.aIndex - y.aIndex);
}

class Differ {
  private readonly ops: JxDocOp[] = [];
  private readonly maxOps: number;

  constructor(maxOps: number) {
    this.maxOps = maxOps;
  }

  result(): JxDocOp[] {
    return this.ops;
  }

  private push(op: JxDocOp): void {
    if (this.ops.length >= this.maxOps) {
      throw new MaxOpsExceededError();
    }
    this.ops.push(op);
  }

  diffNode(path: JxPath, a: Record<string, unknown>, b: Record<string, unknown>): void {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key === "children") {
        continue;
      }
      if (!(key in b)) {
        this.push({ key, op: "set-key", path });
      } else if (!deepEqual(a[key], b[key])) {
        this.push({ key, op: "set-key", path, value: b[key] });
      }
    }
    const ca = a["children"];
    const cb = b["children"];
    if (Array.isArray(ca) && Array.isArray(cb)) {
      this.diffChildren(path, ca, cb);
    } else if (!deepEqual(ca, cb)) {
      // Mapped-array children (or one side missing entirely) replace whole, like the mutators do.
      this.push({ key: "children", op: "set-key", path, value: cb });
    }
  }

  private diffChildren(path: JxPath, a: readonly unknown[], b: readonly unknown[]): void {
    const matches = matchChildren(a, b);
    const matchedA = new Set(matches.map((match) => match.aIndex));
    const byB = new Map(matches.map((match) => [match.bIndex, match]));

    // Removals first, in descending original index — each splice leaves lower indices intact.
    for (let i = a.length - 1; i >= 0; i--) {
      if (!matchedA.has(i)) {
        this.push({ index: i, op: "remove-child", parentPath: path });
      }
    }
    // Then walk b ascending: inserts land at their final index; matched pairs already sit there
    // (matches never cross), so recursion paths are valid as emitted.
    for (let i = 0; i < b.length; i++) {
      const match = byB.get(i);
      if (!match) {
        this.push({ index: i, node: b[i], op: "insert-child", parentPath: path });
        continue;
      }
      if (match.identical) {
        continue;
      }
      const aItem = a[match.aIndex];
      const bItem = b[i];
      if (isPlainObject(aItem) && isPlainObject(bItem)) {
        this.diffNode([...path, "children", i], aItem, bItem);
      } else if (!deepEqual(aItem, bItem)) {
        this.push({ index: i, node: bItem, op: "set-child", parentPath: path });
      }
    }
  }
}

/**
 * Ops that transform `a` into `b` when replayed sequentially, or null when the change is too large
 * to express surgically (caller should hard-replace and reset).
 */
export function diffDocs(
  a: JxMutableNode,
  b: JxMutableNode,
  opts: DiffOptions = {},
): JxDocOp[] | null {
  const differ = new Differ(opts.maxOps ?? DEFAULT_MAX_OPS);
  try {
    differ.diffNode([], a as Record<string, unknown>, b as Record<string, unknown>);
  } catch (error) {
    if (error instanceof MaxOpsExceededError) {
      return null;
    }
    throw error;
  }
  return differ.result();
}

/**
 * Hard-replace the structure tree with `document` (the diff-overflow escape hatch) and bump the
 * in-doc canonicalRev so stale mirror writes computed against the old tree are discarded.
 */
export function replaceYStructure(doc: Y.Doc, document: JxMutableNode, origin: unknown): void {
  doc.transact(() => {
    const structure = structureMap(doc);
    const next = document as Record<string, unknown>;
    // Detached copy: keys are deleted while iterating.
    const existingKeys = [...structure.keys()];
    for (const key of existingKeys) {
      if (!(key in next) || next[key] === undefined) {
        structure.delete(key);
      }
    }
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) {
        continue;
      }
      if (key === "children" && Array.isArray(value)) {
        structure.set(key, toYChildren(value));
      } else {
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON normalization is the point
        structure.set(key, JSON.parse(JSON.stringify(value)));
      }
    }
    const meta = metaMap(doc);
    meta.set("canonicalRev", Number(meta.get("canonicalRev") ?? 0) + 1);
  }, origin);
}
