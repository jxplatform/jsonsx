/**
 * Patch ops — typed descriptors of document mutations, recorded by the mutators in transact.ts
 * during a transaction. The canvas patcher consumes them to update the live canvas DOM surgically
 * instead of re-rendering everything. Ops carry paths, not values: consumers read the post-mutation
 * document as the single source of truth.
 */

// oxlint-disable-next-line unicorn/prefer-export-from -- JxDocOpPair is also used locally (TransactionRecord)
import type { JxDocOpPair } from "@jxsuite/collab/ops";
import type { JxPath } from "../state";
import type { Tab } from "./tab.js";

export type JxPatchOp =
  /** The node's style changed (any depth: base prop, @media block, nested selector). */
  | { op: "set-style"; path: JxPath }
  /** The node's textContent changed. */
  | { op: "set-text"; path: JxPath }
  /** A non-style, non-text node property changed (key = property name). */
  | { op: "set-prop"; path: JxPath; key: string; isEvent?: boolean }
  /** The node's attributes[attr] changed. */
  | { op: "set-attr"; path: JxPath; attr: string }
  /** A node was inserted at parentPath.children[index]. */
  | { op: "insert"; parentPath: JxPath; index: number }
  /** The node at path was removed. */
  | { op: "remove"; path: JxPath }
  /** The node moved between/within children arrays (indices are post-mutation document truth). */
  | { op: "move"; fromPath: JxPath; toParentPath: JxPath; toIndex: number }
  /** The node at path was structurally replaced (wrap, tagName change, $props edit). */
  | { op: "replace"; path: JxPath }
  /** A document-level key changed (state/$media/$head/$elements/imports/$layout) — escalates. */
  | { op: "doc-meta"; key: string };

/**
 * Value-carrying document mutation, replayable in either direction. Mutators record a
 * forward/inverse pair per change; history applies them for surgical undo/redo and for
 * materializing states from checkpoints — without whole-document snapshots per edit. The definition
 * is canonical in `@jxsuite/collab/ops` (the collab bridge mirrors the same ops into a shared
 * Y.Doc); re-exported here so studio call sites keep their import path.
 */
export type { JxDocOp } from "@jxsuite/collab/ops";
export type { JxDocOpPair };

/** Everything recorded during one transaction. */
export interface TransactionRecord {
  /** Canvas patch ops (path-only) for surgical DOM updates. */
  ops: JxPatchOp[];
  /** Replayable forward/inverse document ops for patch-based history. */
  docOps: JxDocOpPair[];
  /**
   * False when some mutation in the transaction could not produce a guaranteed-correct inverse
   * (e.g. a move whose parents' paths interact) — history falls back to a checkpoint snapshot.
   */
  invertible: boolean;
}

/**
 * The canvas-side consumer of patch batches. Registered by the canvas patcher at studio init;
 * absent in headless tests, where every transaction falls back to the full-render path.
 */
export interface PatchConsumer {
  /** Decide whether this batch can be applied surgically in the current canvas state. */
  classify: (tab: Tab, ops: JxPatchOp[]) => { patchable: boolean; reason: string };
  /** Mark a document root reference as surgically consumed (checked by the canvas doc-effect). */
  markConsumed: (docRef: object) => void;
  /**
   * Apply the batch to all ready canvas panels. Throws on any failure (caller escalates). `record`
   * carries the value-carrying `docOps` the iframe consumer posts across the frame boundary; the
   * legacy (parent-DOM) consumer ignores it and reads the post-mutation reactive doc instead.
   */
  apply: (tab: Tab, ops: JxPatchOp[], record?: TransactionRecord) => void;
  /** Schedule a full canvas render as the fallback path, recording the reason. */
  escalate: (reason: string) => void;
}

let _consumer: PatchConsumer | null = null;

export function setPatchConsumer(consumer: PatchConsumer | null) {
  _consumer = consumer;
}

export function getPatchConsumer(): PatchConsumer | null {
  return _consumer;
}

// ─── Recording ───────────────────────────────────────────────────────────────

let _recording: JxPatchOp[] | null = null;
let _docOps: JxDocOpPair[] | null = null;
let _invertible = true;

/** Begin recording patch ops for a transaction. */
export function beginRecording() {
  _recording = [];
  _docOps = [];
  _invertible = true;
}

/** Record a patch op describing an in-place mutation. No-op outside a transaction. */
export function recordPatch(op: JxPatchOp) {
  if (_recording) {
    _recording.push(op);
  }
}

/** Record a replayable forward/inverse document-op pair. No-op outside a transaction. */
export function recordDocOp(pair: JxDocOpPair) {
  if (_docOps) {
    _docOps.push(pair);
  }
}

/** Mark the current transaction as non-invertible — history stores a checkpoint instead. */
export function markNonInvertible() {
  _invertible = false;
}

/**
 * End recording and return everything recorded. An empty ops array means the mutation ran without
 * instrumentation (unknown change shape) — callers must treat that as not patchable.
 */
export function endRecording(): TransactionRecord {
  const record: TransactionRecord = {
    docOps: _docOps ?? [],
    invertible: _invertible,
    ops: _recording ?? [],
  };
  _recording = null;
  _docOps = null;
  _invertible = true;
  return record;
}
