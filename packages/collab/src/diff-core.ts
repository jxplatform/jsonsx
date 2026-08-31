/**
 * The structural differ's pure half: alignment, equality, and `diffDocs`.
 *
 * `diffDocs(a, b)` produces JxDocOps that transform document `a` into `b` when replayed
 * sequentially (property invariant: `apply(clone(a), diffDocs(a, b)) ≡ b`). The collab bridge uses
 * it wherever no op-log exists — whole-document bypass writes (Monaco parse-flush, navigation,
 * reload), un-instrumented transactions, and inbound Y transactions too gnarly for the fast event
 * path.
 *
 * Children alignment: an LCS over strong keys (full-content hashes) pins unchanged nodes as
 * anchors; the gaps between anchors align by a second LCS over weak signatures (tagName +
 * id/$props.key) whose pairs diff recursively. Unmatched items become splices. Reorders of
 * identical siblings therefore degrade to remove+insert — exactly what the Y move mapping does, so
 * no fidelity is lost relative to the wire.
 *
 * **This file has no runtime imports, and that is its reason for existing.** It was the top of
 * `./diff.ts`, which value-imports `./schema.ts` for `replaceYStructure` alone — and `schema.ts`
 * imports yjs. So every consumer of the alignment logic paid for yjs, which put the studio's diff
 * highlighting (`canvas/diff-marks.ts`) behind a lazy import for a computation that never touches a
 * Y type. `diff.ts` re-exports everything here, so nothing that already imported it changed.
 *
 * {@link matchChildren} is exported for that studio caller: `diffDocs` emits a REPLAY SCRIPT whose
 * paths are post-splice coordinates valid only in `b`, and a side-by-side comparison needs both
 * sides' coordinates and the pairing between them. That is what a `ChildMatch` is, and re-deriving
 * it would mean a second definition of "the same node".
 */

import type { JxMutableNode, JxPath } from "@jxsuite/schema/types";
import type { JxDocOp } from "./ops.ts";

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

/**
 * Longest common subsequence over key arrays; returns strictly-increasing index pairs.
 *
 * `maxCells` bounds the DP TABLE, which is the only unbounded cost in this file. The comment below
 * assumes "typically < 200" children, which a generated listing page falsifies. Over budget this
 * answers "no common subsequence", so the caller degrades that group to plain removals and
 * insertions instead of allocating an n*m table. Unbounded by default, so `diffDocs` is unchanged.
 */
function lcsPairs(
  aKeys: readonly string[],
  bKeys: readonly string[],
  maxCells = Number.POSITIVE_INFINITY,
): [number, number][] {
  const n = aKeys.length;
  const m = bKeys.length;
  if (n === 0 || m === 0 || n * m > maxCells) {
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

/** One aligned pair of children, carrying BOTH sides' indices. */
export interface ChildMatch {
  aIndex: number;
  bIndex: number;
  /** Strong matches are byte-identical — no recursion needed. */
  identical: boolean;
}

/** How much DP table {@link matchChildren} may allocate for one pair of children arrays. */
export interface MatchOptions {
  /** Skip the LCS and degrade to splices when `a.length * b.length` exceeds this. */
  maxCells?: number;
}

/**
 * Anchor by strong LCS, then align each gap by weak LCS. Matches never cross.
 *
 * Exported because both sides' indices are exactly what a side-by-side comparison needs, and
 * {@link diffDocs} throws half of them away: its ops are a replay script addressed in `b`, so a
 * removal names an index in `a` that the very next splice invalidates. Re-deriving the pairing from
 * that output would mean a second definition of "the same node", which is the drift this export
 * exists to prevent.
 */
export function matchChildren(
  a: readonly unknown[],
  b: readonly unknown[],
  opts: MatchOptions = {},
): ChildMatch[] {
  const maxCells = opts.maxCells ?? Number.POSITIVE_INFINITY;
  const anchors = lcsPairs(
    a.map((item) => strongKey(item)),
    b.map((item) => strongKey(item)),
    maxCells,
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
      maxCells,
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
