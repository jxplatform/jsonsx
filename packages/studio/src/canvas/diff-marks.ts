/**
 * The two-sided change map behind the diff artboards' red/green marks.
 *
 * **Why this is not `diffDocs`.** `diffDocs` answers a different question: it emits a REPLAY
 * SCRIPT, a list of ops that turn `a` into `b` when applied in order. Its removals are emitted
 * descending against `a`'s indices, its inserts ascend against `b`'s final indices, and its
 * recursion carries the `b`-side index — so every path it hands out is a post-splice coordinate
 * valid only in `b`. The Original artboard needs `a`-side paths, and the stepper needs the two
 * sides PAIRED so that "change 3 of 12" names the same change on both boards. Recovering either
 * from an op list means re-running the matcher, which would be a second definition of "the same
 * node".
 *
 * So this walks the two trees together, carrying `aPath` and `bPath` at once, and aligns each
 * `children` array through `matchChildren` — the same LCS pairing `diffDocs` uses, exported from
 * `@jxsuite/collab/diff-core` for exactly this. The import is static and costs no yjs: that is what
 * the `diff-core` split bought.
 *
 * **Three rules the walk encodes, each because of what the canvas can actually stamp.**
 *
 * 1. A change to a node's own keys marks THAT node, once, however many keys moved. `textContent` is a
 *    key, so the ordinary "someone edited this paragraph" case marks the paragraph — the element
 *    that carries `data-jx-path`.
 * 2. A bare string child is not an element and is never stamped (`makeStamper` returns early for
 *    anything that is not an `HTMLElement`), so a change to one is attributed to its PARENT. The
 *    alternative is a mark addressed to a node the frame cannot resolve, which is a change the
 *    count promises and the artboard never shows.
 * 3. A root-level key change — `state`, `$head`, a `$props` default — emits NO mark, because the
 *    root's stamped element is the whole page and tinting it says "everything changed". Those keys
 *    are reported in {@link ChangeMap.rootKeys} instead, for the header to state in words.
 *
 * Reorders of identical siblings come back as a removal plus an addition rather than a "moved"
 * pair, and that is deliberate: the matcher genuinely cannot tell a move from a delete-plus-insert
 * of an equal value, so a "moved" mark would be a claim the data does not support. It is also what
 * `git diff` prints for a moved block.
 */

import { deepEqual, matchChildren } from "@jxsuite/collab/diff-core";
import type { JxMutableNode, JxPath } from "@jxsuite/schema/types";

/** What happened to a node. `modified` means the node survived and its own content changed. */
export type ChangeKind = "added" | "removed" | "modified";

/** One node to tint, in one artboard's coordinate space. */
export interface ChangeMark {
  path: JxPath;
  kind: ChangeKind;
}

/**
 * One entry in the stepper's list, naming the change on BOTH boards where both have it.
 *
 * A removal has no `currentPath` and an addition no `originalPath` — the pair of artboards is what
 * shows that, with a tinted block on one side and space beside it on the other.
 */
export interface ChangeStep {
  kind: ChangeKind;
  originalPath: JxPath | null;
  currentPath: JxPath | null;
}

export interface ChangeMap {
  /** `removed` and `modified`, addressed in the ORIGINAL document. */
  original: ChangeMark[];
  /** `added` and `modified`, addressed in the CURRENT document. */
  current: ChangeMark[];
  /** Every change in document reading order — the stepper's list. */
  steps: ChangeStep[];
  /** Root-level keys that changed. Stated in words; never tinted (rule 3 above). */
  rootKeys: string[];
  /** A sibling group was too large to align, so its changes are splices rather than pairs. */
  degraded: boolean;
}

export interface ChangeMapOptions {
  /**
   * Largest `a.length * b.length` this will align before giving up on a sibling group.
   *
   * The LCS table is the only unbounded cost in the walk, and a generated listing page falsifies
   * `lcsPairs`'s "typically < 200" assumption. Over budget the group degrades to plain removals and
   * additions — still correct marks, just not paired — and {@link ChangeMap.degraded} says so.
   */
  maxCells?: number;
}

const DEFAULT_MAX_CELLS = 250_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ChangeWalker {
  readonly original: ChangeMark[] = [];
  readonly current: ChangeMark[] = [];
  readonly steps: ChangeStep[] = [];
  readonly rootKeys: string[] = [];
  degraded = false;

  private readonly maxCells: number;
  /* Rule 2 attributes a string child's change to its parent, so one parent with three edited text
     children would otherwise be marked three times — and the stepper would offer three stops that
     all reveal the same element. Deduped on (kind, path) rather than on path alone: a node whose
     children were spliced can legitimately be both an addition target and a modification. */
  private readonly seen = new Set<string>();

  constructor(maxCells: number) {
    this.maxCells = maxCells;
  }

  private emit(kind: ChangeKind, aPath: JxPath | null, bPath: JxPath | null): void {
    const key = `${kind}:${aPath ? JSON.stringify(aPath) : ""}:${bPath ? JSON.stringify(bPath) : ""}`;
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    if (aPath && kind !== "added") {
      this.original.push({ kind, path: aPath });
    }
    if (bPath && kind !== "removed") {
      this.current.push({ kind, path: bPath });
    }
    this.steps.push({ currentPath: bPath, kind, originalPath: aPath });
  }

  diffNode(
    aPath: JxPath,
    bPath: JxPath,
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): void {
    const isRoot = aPath.length === 0 && bPath.length === 0;
    let ownChanged = false;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key === "children" || deepEqual(a[key], b[key])) {
        continue;
      }
      if (isRoot) {
        // Rule 3: reported, never tinted. The root's element is the whole page.
        if (!this.rootKeys.includes(key)) {
          this.rootKeys.push(key);
        }
      } else {
        ownChanged = true;
      }
    }
    if (ownChanged) {
      this.emit("modified", aPath, bPath);
    }

    const ca = a["children"];
    const cb = b["children"];
    if (Array.isArray(ca) && Array.isArray(cb)) {
      this.diffChildren(aPath, bPath, ca, cb);
    } else if (!deepEqual(ca, cb) && !isRoot) {
      /* Mapped-array children, or one side having none at all. There is no per-child alignment to
         make here, so the owning node carries it — the same call `diffDocs` makes when it replaces
         `children` wholesale rather than splicing. */
      this.emit("modified", aPath, bPath);
    }
  }

  private diffChildren(
    aPath: JxPath,
    bPath: JxPath,
    ca: readonly unknown[],
    cb: readonly unknown[],
  ): void {
    if (ca.length * cb.length > this.maxCells) {
      this.degraded = true;
    }
    const matches = matchChildren(ca, cb, { maxCells: this.maxCells });
    let i = 0;
    let j = 0;
    /* ONE merged pass, ascending on both sides at once, which is what puts `steps` in reading order
       for both artboards simultaneously. Matches never cross, so draining the gap before each match
       cannot emit a path out of order on either side. */
    for (const match of matches) {
      for (; i < match.aIndex; i++) {
        this.emitChild("removed", aPath, bPath, ca[i], i, null);
      }
      for (; j < match.bIndex; j++) {
        this.emitChild("added", aPath, bPath, cb[j], null, j);
      }
      if (!match.identical) {
        const aItem = ca[match.aIndex];
        const bItem = cb[match.bIndex];
        if (isPlainObject(aItem) && isPlainObject(bItem)) {
          this.diffNode(
            [...aPath, "children", match.aIndex],
            [...bPath, "children", match.bIndex],
            aItem,
            bItem,
          );
        } else if (!deepEqual(aItem, bItem)) {
          // Rule 2: at least one side is a bare string, which is never a stamped element.
          this.emit("modified", aPath, bPath);
        }
      }
      i = match.aIndex + 1;
      j = match.bIndex + 1;
    }
    for (; i < ca.length; i++) {
      this.emitChild("removed", aPath, bPath, ca[i], i, null);
    }
    for (; j < cb.length; j++) {
      this.emitChild("added", aPath, bPath, cb[j], null, j);
    }
  }

  /** A spliced child: marked at its own path when it is an element, at its parent's when it is not. */
  private emitChild(
    kind: "added" | "removed",
    aPath: JxPath,
    bPath: JxPath,
    item: unknown,
    aIndex: number | null,
    bIndex: number | null,
  ): void {
    if (!isPlainObject(item)) {
      this.emit("modified", aPath, bPath);
      return;
    }
    this.emit(
      kind,
      aIndex === null ? null : [...aPath, "children", aIndex],
      bIndex === null ? null : [...bPath, "children", bIndex],
    );
  }
}

/**
 * Every node that differs between `a` and `b`, in both documents' coordinates.
 *
 * Never throws for size and never answers null: a partial set of marks is still correct for the
 * nodes it names, which is the opposite of `diffDocs`'s bargain (a partial op list would corrupt a
 * document, so it returns null past its cap). {@link ChangeMap.degraded} is how a caller tells the
 * reader that a group was too big to pair up.
 */
export function buildChangeMap(
  a: JxMutableNode,
  b: JxMutableNode,
  opts: ChangeMapOptions = {},
): ChangeMap {
  const walker = new ChangeWalker(opts.maxCells ?? DEFAULT_MAX_CELLS);
  walker.diffNode([], [], a as Record<string, unknown>, b as Record<string, unknown>);
  return {
    current: walker.current,
    degraded: walker.degraded,
    original: walker.original,
    rootKeys: walker.rootKeys,
    steps: walker.steps,
  };
}
