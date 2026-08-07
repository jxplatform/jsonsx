/// <reference lib="dom" />
import { toRaw } from "../reactivity";
import { jsonClone } from "../utils/studio-utils";
import { childIndex, getNodeAtPath, parentElementPath, pathsEqual } from "../state";
import {
  cloneSelection,
  isSpliceablePath,
  primarySelection,
  pruneSelection,
  structuralBatch,
} from "./selection";
import { applyDocOpToDoc, childArray, cloneValue } from "./doc-op-apply";
import {
  beginRecording,
  endRecording,
  getPatchConsumer,
  recordDocOp,
  recordFmOp,
  recordPatch,
} from "./patch-ops";

import type { JxDocOp, JxDocOpPair, JxFmOp, TransactionRecord } from "./patch-ops";

import type { Tab } from "../tabs/tab";
import type { JxPath } from "../state";

import type { JsonValue } from "../types";
import type {
  JxAttributeValue,
  JxEventBinding,
  JxMutableNode,
  JxStateObject,
  JxStyle,
} from "@jxsuite/schema/types";
import { ensureNestedStyle, getNestedStyle, isEventBinding } from "@jxsuite/schema/guards";

const HISTORY_LIMIT = 100;

/** Every Nth history entry stores a full snapshot so states can be materialized by replay. */
const CHECKPOINT_INTERVAL = 20;

/** Opt-out flag for patch-based history (forces full-snapshot-per-edit legacy behavior). */
function patchHistoryEnabled() {
  try {
    return typeof localStorage === "undefined" || !localStorage.getItem("jx-legacy-history");
  } catch {
    return true;
  }
}

/** Forward/inverse pair for a single-key change on the node at path. */
function setKeyPair(path: JxPath, key: string, before: unknown, after: unknown): JxDocOpPair {
  return {
    forward: { key, op: "set-key", path, value: after },
    inverse: { key, op: "set-key", path, value: before },
  };
}

/**
 * Translate `path` into post-splice coordinates when it descends through `parentPath`'s children at
 * or beyond the spliced index: a removal (delta -1) at fromIndex shifts deeper paths down; an
 * insertion (delta +1, inclusive) shifts them up. Returns `path` unchanged when the splice doesn't
 * affect it. Used to express a move's inverse in post-mutation coordinates.
 */
function shiftPrefixedIndex(
  parentPath: JxPath,
  path: JxPath,
  spliceIndex: number,
  delta: number,
  inclusive: boolean,
): JxPath {
  const d = parentPath.length;
  const isProperPrefix = d < path.length && parentPath.every((seg, i) => seg === path[i]);
  if (!isProperPrefix || path[d] !== "children" || typeof path[d + 1] !== "number") {
    return path;
  }
  const idx = path[d + 1] as number;
  if (inclusive ? idx < spliceIndex : idx <= spliceIndex) {
    return path;
  }
  const shifted = [...path];
  shifted[d + 1] = idx + delta;
  return shifted;
}

/** Any value that can sit at a document node key (undefined/null/"" deletes it). */
export type JxNodeValue =
  | JsonValue
  | JxMutableNode
  | (JxMutableNode | string)[]
  | JxEventBinding
  | undefined;

// ─── Transactional layer ─────────────────────────────────────────────────────

/**
 * Where a transaction came from: a direct user/tool edit, the undo/redo machinery replaying
 * recorded ops, or a remote collaborator's ops applied locally. Observers use this to avoid
 * republishing what they themselves applied.
 */
export type TransactOrigin = "user" | "history" | "remote";

/**
 * Module-level hook invoked at the end of every transactDoc (after the canvas patch apply and the
 * dirty mark). Registered by the collab layer to mirror local edits into a shared document; at most
 * one observer exists. `record.docOps` may be empty for un-instrumented mutations — observers must
 * handle that (e.g. by diffing).
 */
export type TransactObserver = (
  tab: Tab,
  record: TransactionRecord,
  origin: TransactOrigin,
) => void;

let _transactObserver: TransactObserver | null = null;

export function setTransactObserver(fn: TransactObserver | null) {
  _transactObserver = fn;
}

/**
 * Module-level gate consulted at transactDoc entry: return a refusal reason to block the mutation
 * (the collab layer soft-freezes structural editing while a peer holds source-canonical), or null
 * to proceed. Remote-origin transactions always pass — they ARE the frozen representation's
 * mirror.
 */
export type TransactGate = (tab: Tab, origin: TransactOrigin) => string | null;

let _transactGate: TransactGate | null = null;

export function setTransactGate(fn: TransactGate | null) {
  _transactGate = fn;
}

/**
 * Undo a transaction that threw part-way through, using the pairs it managed to record.
 *
 * **Why the inverses are enough.** Every mutator records its op AFTER its splice or assignment
 * succeeds, so `record.docOps` describes exactly the changes that landed — no more, no less.
 * Replaying their inverses in reverse is the same replay `undo` performs on a committed entry, run
 * against a document that never got a history entry. A mutator that changed the document WITHOUT
 * recording is already broken for undo; this is no weaker a guarantee than the one history gives.
 *
 * The document root reference is replaced so every effect re-reads, and nothing is marked consumed
 * — the canvas takes the full-render path, because the patch ops recorded for the half-applied
 * state describe changes that no longer exist.
 */
function rollbackFailedTransaction(
  tab: Tab,
  record: TransactionRecord,
  selectionBefore: JxPath[],
  dirtyBefore: boolean,
) {
  for (let i = record.docOps.length - 1; i >= 0; i--) {
    applyDocOpToDoc(tab.doc.document, toRaw(record.docOps[i]!.inverse) as JxDocOp);
  }
  for (let i = record.fmOps.length - 1; i >= 0; i--) {
    const op = record.fmOps[i]!;
    applyFmState(tab, op.field, op.before);
  }
  tab.doc.document = { ...toRaw(tab.doc.document) };
  // Mutators repair the selection as they go (`pruneSelection`, "select the clone"); rolling their
  // Edits back and leaving the selection pointing at coordinates that no longer exist would be its
  // Own corruption.
  tab.session.selection = selectionBefore;
  // `mutateUpdateFrontmatter` marks the tab dirty itself, mid-mutation. Rolling its write back and
  // Leaving the mark standing would report unsaved changes that no longer exist; restoring the
  // Captured value is right in both directions, since nothing but this transaction could have
  // Moved it.
  tab.doc.dirty = dirtyBefore;
}

/**
 * Apply a document mutation transactionally: push to history and mark dirty. The mutationFn
 * receives the tab and should mutate tab.doc.document in place.
 *
 * **All of it or none of it.** A mutationFn that throws part-way — a batch whose third splice hits
 * a coordinate that is not one — used to leave the earlier splices standing in the live reactive
 * tree while the throw skipped the new document reference, the history entry, the dirty mark and
 * the collab observer: the document was changed on screen, unreachable by undo, and invisible to
 * Save. The exception now rolls the applied ops back ({@link rollbackFailedTransaction}) and only
 * then rethrows, so a failed transaction is indistinguishable from one that never ran.
 *
 * **AND IT SAYS WHETHER IT WROTE**, because {@link setTransactGate} made "returned normally" and
 * "changed the document" two different facts and nothing downstream could tell them apart. Under
 * the source-canonical freeze the dock's body commit is refused here — and its caller went on to
 * mark the buffer settled, so `tabBufferUnsaved`, `shouldWarnOnClose` and `hasUnsavedTabs` all
 * reported "nothing to lose" about text that only existed in the buffer. Every close then took it
 * with no prompt. A refusal is not an exception (it is an ordinary, expected state of the room), so
 * it is a return value: `false` means the document is exactly as it was.
 *
 * @param {Tab | null} tab
 * @param {(tab: Tab) => void} mutationFn
 * @param {{ skipHistory?: boolean; origin?: TransactOrigin }} [opts]
 * @returns {boolean} True when the mutation was applied; false when there was no tab, or the gate
 *   refused it.
 */
export function transactDoc(
  tab: Tab | null,
  mutationFn: (tab: Tab) => void,
  {
    skipHistory = false,
    origin = "user",
    coalesceKey = null,
  }: { skipHistory?: boolean; origin?: TransactOrigin; coalesceKey?: string | null } = {},
): boolean {
  if (!tab) {
    return false;
  }
  if (origin !== "remote" && _transactGate?.(tab, origin)) {
    return false;
  }
  const selectionBefore = cloneSelection(tab.session.selection);
  const dirtyBefore = tab.doc.dirty;
  beginRecording();
  let record: TransactionRecord;
  let failure: { error: unknown } | null = null;
  try {
    mutationFn(tab);
  } catch (error) {
    // Boxed rather than tested for truthiness: a mutation is free to throw a falsy value, and
    // "did it throw" must not become "was what it threw interesting".
    failure = { error };
  } finally {
    record = endRecording();
  }
  if (failure) {
    rollbackFailedTransaction(tab, record, selectionBefore, dirtyBefore);
    throw failure.error;
  }

  // Replace the document root reference so effects tracking tab.doc.document re-trigger.
  // Nested objects are shared — the mutation already modified them in place.
  const raw = toRaw(tab.doc.document);
  const newRef = { ...raw };

  // When the canvas patcher can apply this change surgically, mark the new root reference as
  // Consumed BEFORE assigning it — the canvas doc-effect runs synchronously on assignment and
  // Skips the full render for consumed references. Panels' own effects still fire as before.
  // Anything unrecorded or unclassifiable falls through to today's full-render path.
  const consumer = getPatchConsumer();
  const verdict =
    consumer === null
      ? { patchable: false, reason: "no-patch-consumer" }
      : record.ops.length === 0
        ? { patchable: false, reason: "unrecorded-mutation" }
        : consumer.classify(tab, record.ops);
  if (verdict.patchable) {
    consumer!.markConsumed(newRef);
  }

  tab.doc.document = newRef;

  if (verdict.patchable) {
    try {
      consumer!.apply(tab, record.ops, record);
    } catch (error) {
      consumer!.escalate(
        `patch-apply-failed: ${error instanceof Error ? error.message : String(error)}`,
        tab,
      );
    }
  }

  if (!skipHistory && !_batchTab) {
    pushHistoryEntry(tab, raw, record, selectionBefore, coalesceKey);
  }

  tab.doc.dirty = true;

  _transactObserver?.(tab, record, origin);
  return true;
}

/**
 * Append a history entry for a completed transaction. With patch-based history, entries carry
 * replayable forward/inverse ops and only periodic checkpoints store full document snapshots —
 * eliminating the whole-document clone per edit. Non-invertible or un-instrumented transactions
 * store a snapshot, which always keeps every state recoverable.
 *
 * @param {Tab} tab
 * @param {JxMutableNode} raw Post-mutation raw document
 * @param {TransactionRecord} record
 * @param {JxPath[]} selectionBefore
 */
function pushHistoryEntry(
  tab: Tab,
  raw: JxMutableNode,
  record: TransactionRecord,
  selectionBefore: JxPath[],
  coalesceKey: string | null = null,
) {
  const truncated = tab.history.snapshots.slice(0, tab.history.index + 1);
  const useOps =
    patchHistoryEnabled() &&
    record.invertible &&
    (record.docOps.length > 0 || record.fmOps.length > 0);

  // Successive commits to the same block are ONE undoable edit. Fold this transaction into the
  // Previous entry: its inverse already restores the state before the run began (undoing A→B then
  // B→C is C→A), so only the forward ops and the resulting document advance.
  const prev = truncated.at(-1);
  if (coalesceKey && useOps && prev && prev.coalesceKey === coalesceKey && prev.inverseOps) {
    prev.forwardOps = [...(prev.forwardOps ?? []), ...record.docOps.map((pair) => pair.forward)];
    // BOTH halves accumulate. Keeping only the run's first inverse would cover only the keys that
    // First commit happened to touch, so a later commit that changes the block's SHAPE — a plain
    // Block becoming rich, which clears `textContent` and writes `children` — would never be undone,
    // Leaving the node holding both keys at once. Undo replays inverses in reverse order, so
    // Appending yields "undo the last commit, then the one before it, …".
    prev.inverseOps = [...prev.inverseOps, ...record.docOps.map((pair) => pair.inverse)];
    prev.selection = cloneSelection(tab.session.selection);
    if (prev.document) {
      prev.document = jsonClone(raw);
    }
    tab.history.snapshots = truncated;
    tab.history.index = truncated.length - 1;
    return;
  }

  const needCheckpoint = !useOps || truncated.length % CHECKPOINT_INTERVAL === 0;
  truncated.push({
    document: needCheckpoint ? jsonClone(raw) : null,
    fmOps: useOps && record.fmOps.length > 0 ? record.fmOps : null,
    forwardOps: useOps ? record.docOps.map((p) => p.forward) : null,
    inverseOps: useOps ? record.docOps.map((p) => p.inverse) : null,
    coalesceKey,
    selection: cloneSelection(tab.session.selection),
    selectionBefore,
  });
  if (truncated.length > HISTORY_LIMIT) {
    // The new base entry must be a self-contained checkpoint before the old base is dropped.
    if (!truncated[1]!.document) {
      truncated[1]!.document = materializeState(truncated, 1);
    }
    truncated.shift();
  }
  tab.history.snapshots = truncated;
  tab.history.index = truncated.length - 1;
}

/**
 * Reconstruct the document at history state `target`: copy the nearest checkpoint at or before it,
 * then replay forward ops. Every entry holds either a snapshot or forward ops, so this always
 * succeeds.
 *
 * @param {HistorySnapshot[]} snapshots
 * @param {number} target
 * @returns {JxMutableNode}
 */
function materializeState(
  snapshots: { document: JxMutableNode | null; forwardOps?: JxDocOp[] | null }[],
  target: number,
): JxMutableNode {
  let base = target;
  while (base >= 0 && !snapshots[base]!.document) {
    base -= 1;
  }
  if (base < 0) {
    throw new Error("history-missing-checkpoint");
  }
  const doc = jsonClone(snapshots[base]!.document) as JxMutableNode;
  for (let i = base + 1; i <= target; i++) {
    for (const op of snapshots[i]!.forwardOps ?? []) {
      applyDocOpToDoc(doc, op);
    }
  }
  return doc;
}

/**
 * Convenience: transact with a mutation fn that receives the document directly.
 *
 * @param {Tab | null} tab
 * @param {(doc: JxMutableNode) => void} fn
 * @param {{ skipHistory?: boolean; origin?: TransactOrigin }} [opts]
 * @returns {boolean} Whatever {@link transactDoc} answered — whether the mutation was applied.
 */
export function transact(
  tab: Tab | null,
  fn: (doc: JxMutableNode) => void,
  opts?: { skipHistory?: boolean; origin?: TransactOrigin },
): boolean {
  return transactDoc(tab, (t) => fn(t.doc.document), opts);
}

/**
 * Apply externally-produced doc ops (a remote collaborator's edits) through the normal transaction
 * pipeline: the canvas patches surgically exactly as it does for undo/redo replay, panels' effects
 * fire, and — because the origin is "remote" — the transact observer will not republish them.
 * History is skipped; while a collab session is attached, undo is delegated (see
 * setHistoryDelegate) and local-only.
 *
 * @param {Tab} tab
 * @param {JxDocOp[]} ops
 */
export function applyExternalDocOps(tab: Tab, ops: JxDocOp[]) {
  transactDoc(
    tab,
    (t) => {
      for (const op of ops) {
        applyDocOp(t, op);
      }
    },
    { origin: "remote", skipHistory: true },
  );
}

// ─── Document-op application ─────────────────────────────────────────────────

/** Document-level keys whose changes require a full scope/panel rebuild on the canvas. */
const DOC_META_KEYS = new Set(["state", "$media", "$head", "$elements", "imports", "$layout"]);

/**
 * Apply a doc op to the live document AND record the matching canvas patch op, so undo/redo
 * transactions patch the canvas surgically like any other edit.
 *
 * @param {Tab} tab
 * @param {JxDocOp} op
 */
function applyDocOp(tab: Tab, op: JxDocOp) {
  const prev =
    op.op === "set-key" ? (getNodeAtPath(tab.doc.document, op.path)?.[op.key] as unknown) : null;
  applyDocOpToDoc(tab.doc.document, op);
  // The canvas lives in an iframe and can only be patched from VALUE-CARRYING ops (`record.docOps`),
  // Which is what crosses the bridge. Recording only the classification patch below left docOps
  // Empty on this path, so undo/redo posted an EMPTY patch: the document changed, the patch
  // Classified as applicable (suppressing the full render), and the canvas silently kept showing
  // The pre-undo content. Replaying an op IS a forward op — record it as one.
  //
  // History never reads the inverse here: undo/redo run with `skipHistory`, and the entry they
  // Replay already holds the pair. `markNonInvertible` would be wrong (it forces a whole-document
  // Checkpoint), so the op is paired with itself.
  recordDocOp({ forward: op, inverse: op });
  switch (op.op) {
    case "set-key": {
      if (DOC_META_KEYS.has(op.key)) {
        recordPatch({ key: op.key, op: "doc-meta" });
      } else if (op.key === "style") {
        recordPatch({ op: "set-style", path: op.path });
      } else if (op.key === "textContent") {
        recordPatch({ op: "set-text", path: op.path });
      } else if (op.key === "attributes" || op.key === "cases" || op.key === "$props") {
        recordPatch({ op: "replace", path: op.path });
      } else {
        const isEvent =
          op.key.startsWith("on") && (isEventBinding(op.value) || isEventBinding(prev));
        recordPatch({ isEvent, key: op.key, op: "set-prop", path: op.path });
      }
      return;
    }
    case "insert-child": {
      recordPatch({ index: op.index, op: "insert", parentPath: op.parentPath });
      return;
    }
    case "remove-child": {
      recordPatch({ op: "remove", path: [...op.parentPath, "children", op.index] });
      return;
    }
    case "set-child": {
      recordPatch({ op: "replace", path: [...op.parentPath, "children", op.index] });
      return;
    }
    case "move-child": {
      recordPatch({
        fromPath: [...op.fromParentPath, "children", op.fromIndex],
        op: "move",
        toIndex: op.toIndex,
        toParentPath: op.toParentPath,
      });
      break;
    }
    default: {
      break;
    }
  }
}

// ─── Batch (group multiple mutations into one undo step) ────────────────────

let _batchTab: Tab | null = null;

/** Module-level hook invoked when a batch closes (collab flushes its buffered ops as one step). */
export type BatchEndNotifier = (tab: Tab) => void;

let _batchEndNotifier: BatchEndNotifier | null = null;

export function setBatchEndNotifier(fn: BatchEndNotifier | null) {
  _batchEndNotifier = fn;
}

export function beginBatch(tab: Tab | null) {
  _batchTab = tab;
}

export function endBatch() {
  const tab = _batchTab;
  // A history delegate owns undo grouping while registered; the snapshot push would be dead weight.
  if (tab && !_historyDelegates.has(tab)) {
    const raw = toRaw(tab.doc.document);
    const snapshot = {
      document: jsonClone(raw),
      selection: cloneSelection(tab.session.selection),
    };
    const truncated = tab.history.snapshots.slice(0, tab.history.index + 1);
    truncated.push(snapshot);
    if (truncated.length > HISTORY_LIMIT) {
      truncated.shift();
    }
    tab.history.snapshots = truncated;
    tab.history.index = truncated.length - 1;
  }
  _batchTab = null;
  if (tab) {
    _batchEndNotifier?.(tab);
  }
}

export function isBatching(): boolean {
  return _batchTab !== null;
}

/**
 * Which tab the open batch belongs to, or `null` when none is open.
 *
 * The agent loop needs this to keep a batch honest across a tab change. A batch is opened against
 * one tab and closed against the same one — {@link endBatch} pushes ITS history snapshot and fires
 * the collab notifier for IT — so a loop whose tools moved to a second document has to close the
 * first batch and open a second, or the second document's edits get neither a history entry nor a
 * collab publish. Reading the batched tab is how the loop can tell.
 */
export function batchTab(): Tab | null {
  return _batchTab;
}

// ─── Undo / Redo ─────────────────────────────────────────────────────────────

/**
 * Per-tab replacement for the built-in op-log history. While a delegate is registered (a collab
 * session's Y.UndoManager), undo/redo route to it and the snapshot history is bypassed — keeping
 * this module free of any yjs knowledge.
 */
export interface HistoryDelegate {
  undo: (tab: Tab) => void;
  redo: (tab: Tab) => void;
  canUndo: (tab: Tab) => boolean;
  canRedo: (tab: Tab) => boolean;
}

const _historyDelegates = new WeakMap<Tab, HistoryDelegate>();

export function setHistoryDelegate(tab: Tab, delegate: HistoryDelegate | null) {
  if (delegate) {
    _historyDelegates.set(tab, delegate);
  } else {
    _historyDelegates.delete(tab);
  }
}

export function getHistoryDelegate(tab: Tab): HistoryDelegate | null {
  return _historyDelegates.get(tab) ?? null;
}

export function canUndo(tab: Tab): boolean {
  const delegate = _historyDelegates.get(tab);
  return delegate ? delegate.canUndo(tab) : tab.history.index > 0;
}

export function canRedo(tab: Tab): boolean {
  const delegate = _historyDelegates.get(tab);
  return delegate ? delegate.canRedo(tab) : tab.history.index < tab.history.snapshots.length - 1;
}

/** Restore a materialized snapshot state (full-render path). */
function restoreState(tab: Tab, index: number) {
  const { snapshots } = tab.history;
  tab.doc.document = materializeState(snapshots, index);
  const snap = snapshots[index]!;
  tab.session.selection = cloneSelection(toRaw(snap.selection));
}

/** Debug-flag assertion: ops-based undo/redo must land on the same state replay produces. */
function assertHistoryConsistency(tab: Tab, index: number) {
  try {
    if (typeof localStorage === "undefined" || !localStorage.getItem("jx-canvas-debug")) {
      return;
    }
  } catch {
    return;
  }
  const expected = JSON.stringify(materializeState(tab.history.snapshots, index));
  const actual = JSON.stringify(jsonClone(toRaw(tab.doc.document)));
  if (expected !== actual) {
    console.error("jx history: ops-based undo/redo diverged from checkpoint replay", {
      index,
    });
  }
}

/** @param {Tab} tab */
export function undo(tab: Tab) {
  const delegate = _historyDelegates.get(tab);
  if (delegate) {
    delegate.undo(tab);
    return;
  }
  if (tab.history.index <= 0) {
    return;
  }
  const entry = tab.history.snapshots[tab.history.index]!;
  const inverseOps = patchHistoryEnabled() ? entry.inverseOps : null;
  const fmOps = patchHistoryEnabled() ? entry.fmOps : null;
  if ((inverseOps && inverseOps.length > 0) || (fmOps && fmOps.length > 0)) {
    // Surgical path: apply inverse ops through the normal transaction pipeline (the canvas
    // Patches in place when it can), in reverse recording order.
    const applied = transactDoc(
      tab,
      (t) => {
        if (inverseOps) {
          for (let i = inverseOps.length - 1; i >= 0; i--) {
            applyDocOp(t, toRaw(inverseOps[i]) as JxDocOp);
          }
        }
        if (fmOps) {
          for (let i = fmOps.length - 1; i >= 0; i--) {
            const op = toRaw(fmOps[i]) as JxFmOp;
            applyFmState(t, op.field, op.before);
          }
        }
      },
      { origin: "history", skipHistory: true },
    );
    /* A REFUSED REPLAY IS NOT A STEP TAKEN. `"history"` is not `"remote"`, so the gate refuses this
       exactly as it refuses a direct edit — and everything below assumed the ops landed. Moving the
       index over a document that did not change desynchronises the log from the tree: the next redo
       replays a forward op onto a state it was never the inverse of, and `doc.dirty` claims an edit
       nobody made. Undo that cannot run is undo that does nothing, which is the honest answer. */
    if (!applied) {
      return;
    }
    tab.session.selection = cloneSelection(toRaw(entry.selectionBefore ?? []));
    tab.history.index -= 1;
    assertHistoryConsistency(tab, tab.history.index);
  } else {
    tab.history.index -= 1;
    restoreState(tab, tab.history.index);
  }
  tab.doc.dirty = true;
}

/** @param {Tab} tab */
export function redo(tab: Tab) {
  const delegate = _historyDelegates.get(tab);
  if (delegate) {
    delegate.redo(tab);
    return;
  }
  if (tab.history.index >= tab.history.snapshots.length - 1) {
    return;
  }
  const entry = tab.history.snapshots[tab.history.index + 1]!;
  const forwardOps = patchHistoryEnabled() ? entry.forwardOps : null;
  const fmOps = patchHistoryEnabled() ? entry.fmOps : null;
  if ((forwardOps && forwardOps.length > 0) || (fmOps && fmOps.length > 0)) {
    const applied = transactDoc(
      tab,
      (t) => {
        if (forwardOps) {
          for (const op of forwardOps) {
            applyDocOp(t, toRaw(op) as JxDocOp);
          }
        }
        if (fmOps) {
          for (const op of fmOps) {
            const raw = toRaw(op) as JxFmOp;
            applyFmState(t, raw.field, raw.after);
          }
        }
      },
      { origin: "history", skipHistory: true },
    );
    // Same as {@link undo}: a refused replay leaves the document alone, so the index must stay
    // Where it is or the log stops describing the tree.
    if (!applied) {
      return;
    }
    tab.session.selection = cloneSelection(toRaw(entry.selection));
    tab.history.index += 1;
    assertHistoryConsistency(tab, tab.history.index);
  } else {
    tab.history.index += 1;
    restoreState(tab, tab.history.index);
  }
  tab.doc.dirty = true;
}

// ─── In-place document mutators ──────────────────────────────────────────────

/**
 * @param {Tab} tab
 * @param {JxPath} parentPath
 * @param {number} index
 * @param {JxMutableNode} nodeDef
 */
export function mutateInsertNode(
  tab: Tab,
  parentPath: JxPath,
  index: number,
  nodeDef: JxMutableNode,
) {
  const parent = getNodeAtPath(tab.doc.document, parentPath);
  if (!parent) {
    return;
  }
  childArray(parent).splice(index, 0, structuredClone(nodeDef));
  recordPatch({ index, op: "insert", parentPath });
  recordDocOp({
    forward: { index, node: cloneValue(nodeDef), op: "insert-child", parentPath },
    inverse: { index, op: "remove-child", parentPath },
  });
}

/**
 * Remove the node at `path` from its parent's children array.
 *
 * The guard is {@link isSpliceablePath}, not `path.length < 2`: the shorter test admits the
 * Outline's map-template and `$switch`-case rows, whose `parentElementPath` is a children ARRAY
 * rather than a node — `.children.splice` on it throws, and the throw is what left a batch's
 * earlier removals applied and unrecorded.
 *
 * @param {Tab} tab
 * @param {JxPath} path
 */
export function mutateRemoveNode(tab: Tab, path: JxPath) {
  if (!path || !isSpliceablePath(path)) {
    return;
  }
  const elemPath = parentElementPath(path) as JxPath;
  const idx = childIndex(path) as number;
  const [removed] = (getNodeAtPath(tab.doc.document, elemPath).children as JxMutableNode[]).splice(
    idx,
    1,
  );
  recordPatch({ op: "remove", path });
  recordDocOp({
    forward: { index: idx, op: "remove-child", parentPath: elemPath },
    inverse: { index: idx, node: cloneValue(removed), op: "insert-child", parentPath: elemPath },
  });
  tab.session.selection = pruneSelection(tab.session.selection, path);
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 */
export function mutateDuplicateNode(tab: Tab, path: JxPath) {
  if (!path || !isSpliceablePath(path)) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) {
    return;
  }
  const elemPath = parentElementPath(path) as JxPath;
  const idx = childIndex(path) as number;
  const clone = structuredClone(toRaw(node));
  (getNodeAtPath(tab.doc.document, elemPath).children as JxMutableNode[]).splice(idx + 1, 0, clone);
  recordPatch({ index: idx + 1, op: "insert", parentPath: elemPath });
  recordDocOp({
    forward: { index: idx + 1, node: cloneValue(clone), op: "insert-child", parentPath: elemPath },
    inverse: { index: idx + 1, op: "remove-child", parentPath: elemPath },
  });
  tab.session.selection = [[...elemPath, "children", idx + 1]];
}

/**
 * Remove every selected node, in ONE transaction and therefore ONE undo step (§6.5).
 *
 * Three things make a batch different from a loop. `structuralBatch` drops paths contained by
 * another selected path — deleting a `<section>` and a paragraph inside it is one deletion — drops
 * paths that name no splice coordinate at all (the document element, a repeater's map template, a
 * `$switch` case, each of which the Outline offers as a ctrl-clickable row), and orders what
 * survives LAST-node-first, so each splice happens above coordinates no later step depends on. A
 * forward loop would delete `children/0` and then `children/1`, which by then is the node that used
 * to be `children/2`.
 *
 * Selection repair is `mutateRemoveNode`'s, applied once per removal: a path is dropped when the
 * node it addresses has gone. With a single path in, that is exactly the old behaviour — the
 * selection ends up empty.
 *
 * @param {Tab} tab
 * @param {readonly JxPath[]} paths
 */
export function mutateRemoveNodes(tab: Tab, paths: readonly JxPath[]) {
  for (const path of structuralBatch(paths)) {
    mutateRemoveNode(tab, path);
  }
}

/**
 * Duplicate every selected node in one transaction, selecting the clones.
 *
 * Same descending order, for the same reason: inserting a clone at `idx + 1` renumbers every later
 * sibling, so the batch starts at the last. The resulting selection is the clones in document
 * order, which means a duplicate-then-duplicate-again walks down the page the way repeating the
 * single-node command always did.
 *
 * @param {Tab} tab
 * @param {readonly JxPath[]} paths
 */
export function mutateDuplicateNodes(tab: Tab, paths: readonly JxPath[]) {
  let clones: JxPath[] = [];
  for (const path of structuralBatch(paths)) {
    const before = tab.session.selection;
    mutateDuplicateNode(tab, path);
    const made = primarySelection(tab.session.selection);
    // `mutateDuplicateNode` refuses a path that addresses nothing and leaves the selection alone;
    // Only a real insertion contributes a clone.
    if (!made || tab.session.selection === before) {
      continue;
    }
    // Descending order keeps the ORIGINALS valid, but not the clones already made: this insertion
    // Sits before them, so every one of their coordinates moved up by one. Translating them here
    // Is the difference between "the copies are selected" and "two of the originals are".
    const parentPath = parentElementPath(made) as JxPath;
    const spliceIndex = childIndex(made) as number;
    clones = clones.map((clone) => shiftPrefixedIndex(parentPath, clone, spliceIndex, 1, true));
    clones.unshift(made);
  }
  if (clones.length > 0) {
    tab.session.selection = clones;
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} wrapperTag
 */
export function mutateWrapNode(tab: Tab, path: JxPath, wrapperTag = "div") {
  if (!path || !isSpliceablePath(path)) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) {
    return;
  }
  const elemPath = parentElementPath(path) as JxPath;
  const idx = childIndex(path) as number;
  const wrapper = {
    children: [structuredClone(toRaw(node))],
    tagName: wrapperTag,
  };
  const original = cloneValue(node);
  (getNodeAtPath(tab.doc.document, elemPath).children as JxMutableNode[]).splice(idx, 1, wrapper);
  recordPatch({ op: "replace", path });
  recordDocOp({
    forward: { index: idx, node: cloneValue(wrapper), op: "set-child", parentPath: elemPath },
    inverse: { index: idx, node: original, op: "set-child", parentPath: elemPath },
  });
  tab.session.selection = [[...elemPath, "children", idx]];
}

/**
 * @param {Tab} tab
 * @param {JxPath} fromPath
 * @param {JxPath} toParentPath
 * @param {number} toIndex
 */
export function mutateMoveNode(tab: Tab, fromPath: JxPath, toParentPath: JxPath, toIndex: number) {
  const doc = tab.doc.document;
  const fromParentPath = parentElementPath(fromPath) as JxPath;
  const fromIdx = childIndex(fromPath) as number;
  if (!fromParentPath || typeof fromIdx !== "number") {
    return;
  }
  const fromParent = getNodeAtPath(doc, fromParentPath);
  const toParent = getNodeAtPath(doc, toParentPath);
  if (!fromParent || !Array.isArray(fromParent.children) || !toParent) {
    return;
  }
  const [node] = fromParent.children.splice(fromIdx, 1);
  if (node === undefined) {
    return;
  }
  let adjustedIndex = toIndex;
  if (fromParent === toParent && fromIdx < toIndex) {
    adjustedIndex -= 1;
  }
  childArray(toParent).splice(adjustedIndex, 0, node);
  recordPatch({ fromPath, op: "move", toIndex: adjustedIndex, toParentPath });
  recordDocOp({
    forward: {
      fromIndex: fromIdx,
      fromParentPath,
      op: "move-child",
      toIndex: adjustedIndex,
      toParentPath,
    },
    inverse: {
      fromIndex: adjustedIndex,
      // The inverse runs against the post-move document, so both parent paths are translated
      // Into post-move coordinates: the removal shifted paths under fromParent, the insertion
      // Shifted paths under toParent.
      fromParentPath: shiftPrefixedIndex(fromParentPath, toParentPath, fromIdx, -1, false),
      op: "move-child",
      toIndex: fromIdx,
      toParentPath: shiftPrefixedIndex(toParentPath, fromParentPath, adjustedIndex, 1, true),
    },
  });

  if (pathsEqual(primarySelection(tab.session.selection), fromPath)) {
    let idx = toIndex;
    if (
      fromParentPath.length === toParentPath.length &&
      fromParentPath.every((v, i) => v === toParentPath[i]) &&
      fromIdx < toIndex
    ) {
      idx = toIndex - 1;
    }
    tab.session.selection = [[...toParentPath, "children", idx]];
  }
}

/**
 * Set (or, for an empty value, delete) one property on the node `path` names.
 *
 * **A path that no longer resolves is a no-op, not a throw.** `getNodeAtPath` answers `undefined`
 * for a coordinate that has been deleted, and `node[key]` on that is `undefined is not an object` —
 * an exception thrown from inside a mutation, which {@link transactDoc} correctly rolls back and
 * rethrows into whatever asked for the edit. For a panel that is one stale click; for the dock's
 * debounced body commit it escaped through `commitBufferWrites` and out of the dock's
 * `afterRender`, aborting the repaint with the editor undisposed and its 500ms timer still armed.
 * Deletions arrive from collaborators and from the author's own undo while an editor is open, so a
 * stale path is an ordinary state of the document rather than a programming error, and the ordinary
 * answer is to change nothing. Callers that must distinguish "wrote" from "nothing to write to"
 * resolve the node themselves first — `panels/editors.ts`'s `bodyWriter` does exactly that.
 *
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} key
 * @param {JxNodeValue} value
 */
export function mutateUpdateProperty(tab: Tab, path: JxPath, key: string, value?: JxNodeValue) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) {
    return;
  }
  const prev = node[key];
  const before = cloneValue(prev);
  if (value === undefined || value === null || value === "") {
    delete node[key];
  } else {
    node[key] = value;
  }
  recordDocOp(setKeyPair(path, key, before, cloneValue(node[key])));
  if (key === "textContent") {
    recordPatch({ op: "set-text", path });
  } else if (key === "style") {
    recordPatch({ op: "set-style", path });
  } else {
    // Event-binding edits are invisible on the canvas (stripped in design/edit renders); the
    // Deleted-value case checks the previous value since the new one is gone.
    const bindingValue = value === undefined || value === null || value === "" ? prev : value;
    const isEvent = key.startsWith("on") && isEventBinding(bindingValue);
    recordPatch({ isEvent, key, op: "set-prop", path });
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateStyle(tab: Tab, path: JxPath, prop: string, value: string | undefined) {
  const node = getNodeAtPath(tab.doc.document, path);
  const styleBefore = cloneValue(node.style);
  if (!node.style) {
    node.style = {};
  }
  if (value === undefined || value === "") {
    delete node.style[prop];
  } else {
    node.style[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
  recordDocOp(setKeyPair(path, "style", styleBefore, cloneValue(node.style)));
  recordPatch({ op: "set-style", path });
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} attr
 * @param {JxAttributeValue | undefined} value — a literal, `$ref` binding, or `${}` template.
 */
export function mutateUpdateAttribute(
  tab: Tab,
  path: JxPath,
  attr: string,
  value?: JxAttributeValue | undefined,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  const attrsBefore = cloneValue(node.attributes);
  if (!node.attributes) {
    node.attributes = {};
  }
  if (value === undefined || value === "") {
    delete node.attributes[attr];
  } else {
    node.attributes[attr] = value;
  }
  if (Object.keys(node.attributes).length === 0) {
    delete node.attributes;
  }
  recordDocOp(setKeyPair(path, "attributes", attrsBefore, cloneValue(node.attributes)));
  recordPatch({ attr, op: "set-attr", path });
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} mediaName
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateMediaStyle(
  tab: Tab,
  path: JxPath,
  mediaName: string,
  prop: string,
  value: string | undefined,
) {
  if (!mediaName) {
    return mutateUpdateStyle(tab, path, prop, value);
  }
  const node = getNodeAtPath(tab.doc.document, path);
  const styleBefore = cloneValue(node.style);
  if (!node.style) {
    node.style = {};
  }
  const key = `@${mediaName}`;
  const media = ensureNestedStyle(node.style, key);
  if (value === undefined || value === "") {
    delete media[prop];
    if (Object.keys(media).length === 0) {
      delete node.style[key];
    }
  } else {
    media[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
  recordDocOp(setKeyPair(path, "style", styleBefore, cloneValue(node.style)));
  recordPatch({ op: "set-style", path });
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} selector
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateNestedStyle(
  tab: Tab,
  path: JxPath,
  selector: string,
  prop: string,
  value: string | undefined,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  const styleBefore = cloneValue(node.style);
  if (!node.style) {
    node.style = {};
  }
  const block = ensureNestedStyle(node.style, selector);
  if (value === undefined || value === "") {
    delete block[prop];
    if (Object.keys(block).length === 0) {
      delete node.style[selector];
    }
  } else {
    block[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
  recordDocOp(setKeyPair(path, "style", styleBefore, cloneValue(node.style)));
  recordPatch({ op: "set-style", path });
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} mediaName
 * @param {string} selector
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateMediaNestedStyle(
  tab: Tab,
  path: JxPath,
  mediaName: string,
  selector: string,
  prop: string,
  value: string | undefined,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  const styleBefore = cloneValue(node.style);
  if (!node.style) {
    node.style = {};
  }
  const key = `@${mediaName}`;
  const media = ensureNestedStyle(node.style, key);
  const block = ensureNestedStyle(media, selector);
  if (value === undefined || value === "") {
    delete block[prop];
    if (Object.keys(block).length === 0) {
      delete media[selector];
    }
    if (Object.keys(media).length === 0) {
      delete node.style[key];
    }
  } else {
    block[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
  recordDocOp(setKeyPair(path, "style", styleBefore, cloneValue(node.style)));
  recordPatch({ op: "set-style", path });
}

/**
 * Update a style property at a nested style path (e.g., ["table", "th"]). Creates intermediate
 * objects as needed.
 *
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string[]} stylePath
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateNestedStylePath(
  tab: Tab,
  path: JxPath,
  stylePath: string[],
  prop: string,
  value: string | undefined,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  const styleBefore = cloneValue(node.style);
  if (!node.style) {
    node.style = {};
  }
  let obj = node.style;
  for (const seg of stylePath) {
    obj = ensureNestedStyle(obj, seg);
  }
  if (value === undefined || value === "") {
    delete obj[prop];
    // Clean up empty parent objects
    let cur: JxStyle | undefined = node.style;
    for (let i = 0; i < stylePath.length && cur; i++) {
      const child = getNestedStyle(cur, stylePath[i]!);
      if (child && Object.keys(child).length === 0) {
        delete cur[stylePath[i]!];
        break;
      }
      cur = child;
    }
  } else {
    obj[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
  recordDocOp(setKeyPair(path, "style", styleBefore, cloneValue(node.style)));
  recordPatch({ op: "set-style", path });
}

/**
 * Update a style property at a nested style path within a media query.
 *
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} mediaName
 * @param {string[]} stylePath
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateMediaNestedStylePath(
  tab: Tab,
  path: JxPath,
  mediaName: string,
  stylePath: string[],
  prop: string,
  value: string | undefined,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  const styleBefore = cloneValue(node.style);
  if (!node.style) {
    node.style = {};
  }
  const key = `@${mediaName}`;
  const media = ensureNestedStyle(node.style, key);
  let obj = media;
  for (const seg of stylePath) {
    obj = ensureNestedStyle(obj, seg);
  }
  if (value === undefined || value === "") {
    delete obj[prop];
    let cur: JxStyle | undefined = media;
    for (let i = 0; i < stylePath.length && cur; i++) {
      const child = getNestedStyle(cur, stylePath[i]!);
      if (child && Object.keys(child).length === 0) {
        delete cur[stylePath[i]!];
        break;
      }
      cur = child;
    }
    if (Object.keys(media).length === 0) {
      delete node.style[key];
    }
  } else {
    obj[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
  recordDocOp(setKeyPair(path, "style", styleBefore, cloneValue(node.style)));
  recordPatch({ op: "set-style", path });
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {Record<string, string | undefined> | undefined} style
 */
export function mutateReplaceStyle(tab: Tab, path: JxPath, style: JxStyle | undefined) {
  const node = getNodeAtPath(tab.doc.document, path);
  const styleBefore = cloneValue(node.style);
  if (style && Object.keys(style).length > 0) {
    node.style = style;
  } else {
    delete node.style;
  }
  recordDocOp(setKeyPair(path, "style", styleBefore, cloneValue(node.style)));
  recordPatch({ op: "set-style", path });
}

/**
 * @param {Tab} tab
 * @param {string} name
 * @param {Record<string, JsonValue>} def
 */
export function mutateAddDef(tab: Tab, name: string, def: Record<string, JsonValue>) {
  const doc = tab.doc.document;
  const before = cloneValue(doc.state);
  if (!doc.state) {
    doc.state = {};
  }
  doc.state[name] = def;
  recordDocOp(setKeyPair([], "state", before, cloneValue(doc.state)));
  recordPatch({ key: "state", op: "doc-meta" });
}

/**
 * @param {Tab} tab
 * @param {string} name
 */
export function mutateRemoveDef(tab: Tab, name: string) {
  const doc = tab.doc.document;
  if (doc.state) {
    const before = cloneValue(doc.state);
    delete doc.state[name];
    if (Object.keys(doc.state).length === 0) {
      delete doc.state;
    }
    recordDocOp(setKeyPair([], "state", before, cloneValue(doc.state)));
    recordPatch({ key: "state", op: "doc-meta" });
  }
}

/**
 * @param {Tab} tab
 * @param {string} name
 * @param {Record<string, JsonValue>} updates
 */
export function mutateUpdateDef(tab: Tab, name: string, updates: Record<string, unknown>) {
  const doc = tab.doc.document;
  const stateBefore = cloneValue(doc.state);
  if (!doc.state) {
    doc.state = {};
  }
  const existing = doc.state[name];
  const entry: JxStateObject =
    existing == null
      ? {}
      : typeof existing !== "object" || Array.isArray(existing)
        ? { default: existing }
        : (existing as JxStateObject);
  doc.state[name] = entry;
  Object.assign(entry, updates);
  for (const k of Object.keys(entry)) {
    if (entry[k] === undefined || entry[k] === null) {
      delete entry[k];
    }
  }
  recordDocOp(setKeyPair([], "state", stateBefore, cloneValue(doc.state)));
  recordPatch({ key: "state", op: "doc-meta" });
}

/**
 * @param {Tab} tab
 * @param {string} oldName
 * @param {string} newName
 */
export function mutateRenameDef(tab: Tab, oldName: string, newName: string) {
  const doc = tab.doc.document;
  if (!doc.state || !doc.state[oldName]) {
    return;
  }
  const before = cloneValue(doc.state);
  doc.state[newName] = doc.state[oldName];
  delete doc.state[oldName];
  recordDocOp(setKeyPair([], "state", before, cloneValue(doc.state)));
  recordPatch({ key: "state", op: "doc-meta" });
}

/**
 * @param {Tab} tab
 * @param {string} name
 * @param {string | undefined} query
 */
export function mutateUpdateMedia(tab: Tab, name: string, query?: string | undefined) {
  const doc = tab.doc.document;
  const mediaBefore = cloneValue(doc.$media);
  if (!doc.$media) {
    doc.$media = {};
  }
  if (query === undefined || query === "") {
    delete doc.$media[name];
    if (Object.keys(doc.$media).length === 0) {
      delete doc.$media;
    }
  } else {
    doc.$media[name] = query;
  }
  recordDocOp(setKeyPair([], "$media", mediaBefore, cloneValue(doc.$media)));
  recordPatch({ key: "$media", op: "doc-meta" });
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} propName
 * @param {JsonValue} value
 */
export function mutateUpdateProp(tab: Tab, path: JxPath, propName: string, value: JsonValue) {
  const node = getNodeAtPath(tab.doc.document, path);
  const propsBefore = cloneValue(node.$props);
  if (!node.$props) {
    node.$props = {};
  }
  if (value === undefined || value === null || value === "") {
    delete node.$props[propName];
  } else {
    node.$props[propName] = value;
  }
  if (Object.keys(node.$props).length === 0) {
    delete node.$props;
  }
  recordDocOp(setKeyPair(path, "$props", propsBefore, cloneValue(node.$props)));
  recordPatch({ op: "replace", path });
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} caseName
 * @param {JxMutableNode} [caseDef]
 */
export function mutateAddSwitchCase(
  tab: Tab,
  path: JxPath,
  caseName: string,
  caseDef?: JxMutableNode,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  const before = cloneValue(node.cases);
  if (!node.cases) {
    node.cases = {};
  }
  node.cases[caseName] = caseDef || { tagName: "div", textContent: caseName };
  recordDocOp(setKeyPair(path, "cases", before, cloneValue(node.cases)));
  recordPatch({ op: "replace", path });
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} caseName
 */
export function mutateRemoveSwitchCase(tab: Tab, path: JxPath, caseName: string) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (node.cases) {
    const before = cloneValue(node.cases);
    delete node.cases[caseName];
    recordDocOp(setKeyPair(path, "cases", before, cloneValue(node.cases)));
    recordPatch({ op: "replace", path });
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} oldName
 * @param {string} newName
 */
export function mutateRenameSwitchCase(tab: Tab, path: JxPath, oldName: string, newName: string) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.cases || !node.cases[oldName]) {
    return;
  }
  const before = cloneValue(node.cases);
  node.cases[newName] = node.cases[oldName];
  delete node.cases[oldName];
  recordDocOp(setKeyPair(path, "cases", before, cloneValue(node.cases)));
  recordPatch({ op: "replace", path });
}

// ─── Frontmatter ─────────────────────────────────────────────────────────────

/**
 * Update a frontmatter field on a tab. Does not push document history.
 *
 * @param {Tab} tab
 * @param {string} field
 * @param {JsonValue} value
 */
export function mutateUpdateFrontmatter(tab: Tab, field: string, value?: JsonValue) {
  const fm = tab.doc.content.frontmatter;
  const before = Object.hasOwn(fm, field) ? cloneValue(fm[field]) : undefined;
  const deletes = value === undefined || value === null || value === "";
  if (deletes) {
    delete fm[field];
  } else {
    fm[field] = value;
  }
  const after = deletes ? undefined : cloneValue(value);
  recordFmOp({ after, before, field });
  tab.doc.dirty = true;
}

/**
 * Restore a frontmatter key to a recorded history state: `undefined` means the key was absent.
 * Unlike `mutateUpdateFrontmatter`, values like `""`/`false`/`null` are written verbatim (source
 * round-trips can put them there) and no fm op is recorded — history replay must not re-record.
 */
function applyFmState(tab: Tab, field: string, value: unknown) {
  if (value === undefined) {
    delete tab.doc.content.frontmatter[field];
  } else {
    tab.doc.content.frontmatter[field] = value;
  }
}
