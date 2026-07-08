/**
 * The two-way bridge between Studio's JxDocOp op-log and the shared Y.Doc structure tree.
 *
 * Outbound ({@link applyDocOpsToY}): forward ops recorded by a local transaction replay onto the Y
 * tree inside one Y transaction tagged with the caller's origin, so observers can tell local
 * mirroring from remote edits.
 *
 * Inbound ({@link yEventsToDocOps}): a remote transaction's Y events convert back into JxDocOps for
 * `applyExternalDocOps`. Only provably safe event shapes take this fast path (it keeps canvas
 * patches surgical); anything gnarlier returns null and the caller reconciles by diffing — the
 * correctness anchor.
 */

import * as Y from "yjs";
import type { JxPath } from "@jxsuite/schema/types";
import type { JxDocOp } from "./ops.ts";
import { resolveYPath, toYChildren, toYNode, yValueToJson } from "./schema.ts";

/** Origin of Y transactions produced by mirroring the local tab's ops. */
export const LOCAL_ORIGIN = "jx-local";
/** Origin of derived-representation writes (the elected reconciler's structure↔source mirrors). */
export const MIRROR_ORIGIN = "jx-mirror";
/** Origin of seeding/bootstrap writes. */
export const SEED_ORIGIN = "jx-seed";

/** Thrown when an op's path does not resolve in the Y tree; callers fall back to diffing. */
export class CollabPathError extends Error {
  constructor(path: JxPath) {
    super(`collab-path-unresolved:${path.join("/")}`);
    this.name = "CollabPathError";
  }
}

function requireNode(doc: Y.Doc, path: JxPath): Y.Map<unknown> {
  const target = resolveYPath(doc, path);
  if (!(target instanceof Y.Map)) {
    throw new CollabPathError(path);
  }
  return target;
}

function childrenOf(doc: Y.Doc, parentPath: JxPath, create: boolean): Y.Array<unknown> {
  const parent = requireNode(doc, parentPath);
  const children = parent.get("children");
  if (children instanceof Y.Array) {
    return children;
  }
  if (create && children === undefined) {
    const fresh = new Y.Array<unknown>();
    parent.set("children", fresh);
    return fresh;
  }
  throw new CollabPathError([...parentPath, "children"]);
}

/** JSON round-trip clone (matches the ops applier's normalization). */
function cloneJson<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON normalization is the point
  return JSON.parse(JSON.stringify(value)) as T;
}

function toYChild(node: unknown): unknown {
  return typeof node === "string" ? node : toYNode(node);
}

function applyOneOp(doc: Y.Doc, op: JxDocOp): void {
  switch (op.op) {
    case "set-key": {
      const node = requireNode(doc, op.path);
      if (op.value === undefined) {
        node.delete(op.key);
      } else if (op.key === "children" && Array.isArray(op.value)) {
        node.set(op.key, toYChildren(op.value));
      } else {
        node.set(op.key, cloneJson(op.value));
      }
      return;
    }
    case "insert-child": {
      const children = childrenOf(doc, op.parentPath, true);
      if (op.index < 0 || op.index > children.length) {
        throw new CollabPathError([...op.parentPath, "children", op.index]);
      }
      children.insert(op.index, [toYChild(op.node)]);
      return;
    }
    case "remove-child": {
      const children = childrenOf(doc, op.parentPath, false);
      if (op.index < 0 || op.index >= children.length) {
        throw new CollabPathError([...op.parentPath, "children", op.index]);
      }
      children.delete(op.index, 1);
      return;
    }
    case "set-child": {
      const children = childrenOf(doc, op.parentPath, false);
      if (op.index < 0 || op.index >= children.length) {
        throw new CollabPathError([...op.parentPath, "children", op.index]);
      }
      children.delete(op.index, 1);
      children.insert(op.index, [toYChild(op.node)]);
      return;
    }
    case "move-child": {
      // Y.Array has no native move: re-insert the node's current JSON at the target. A remote
      // Edit landing inside the moved subtree during the same round-trip is lost (documented v1
      // Limitation); convergence itself is unaffected. Both parent paths resolve BEFORE the
      // Removal splice — matching the plain applier's semantics — while toIndex is expressed in
      // Post-removal coordinates (the mutators pre-adjust same-parent moves).
      const from = childrenOf(doc, op.fromParentPath, false);
      const to = childrenOf(doc, op.toParentPath, true);
      if (op.fromIndex < 0 || op.fromIndex >= from.length) {
        throw new CollabPathError([...op.fromParentPath, "children", op.fromIndex]);
      }
      const json = yValueToJson(from.get(op.fromIndex));
      from.delete(op.fromIndex, 1);
      if (op.toIndex < 0 || op.toIndex > to.length) {
        throw new CollabPathError([...op.toParentPath, "children", op.toIndex]);
      }
      to.insert(op.toIndex, [toYChild(json)]);
      return;
    }
    default: {
      throw new Error(`unknown-doc-op:${(op as JxDocOp).op}`);
    }
  }
}

/**
 * Replay forward ops onto the Y structure tree in one transaction. Throws {@link CollabPathError}
 * when any op's path does not resolve — the transaction still commits the ops applied before the
 * failure, so callers catching it must reconcile by diff (which corrects any partial state).
 */
export function applyDocOpsToY(doc: Y.Doc, ops: readonly JxDocOp[], origin: unknown): void {
  doc.transact(() => {
    for (const op of ops) {
      applyOneOp(doc, op);
    }
  }, origin);
}

function isStructurePath(segments: readonly (string | number)[]): segments is JxPath {
  return segments.every((seg) => typeof seg === "string" || typeof seg === "number");
}

/**
 * Convert a remote transaction's deep events on the structure tree into JxDocOps (positions valid
 * at sequential apply time). Returns null when the shape is not provably safe to convert — multiple
 * overlapping events, more than one array event, or non-contiguous delete runs — and the caller
 * must reconcile by diffing instead.
 */
export function yEventsToDocOps(events: readonly Y.YEvent<never>[]): JxDocOp[] | null {
  if (events.length === 0) {
    return [];
  }
  const paths = events.map((event) => event.path);
  if (!paths.every((p) => isStructurePath(p))) {
    return null;
  }
  // Overlap guard: one event's target must not sit inside another's subtree — later paths would
  // Describe positions the earlier splice already shifted.
  for (let i = 0; i < paths.length; i++) {
    for (let j = 0; j < paths.length; j++) {
      if (i === j) {
        continue;
      }
      const a = paths[i]!;
      const b = paths[j]!;
      if (a.length <= b.length && a.every((seg, k) => seg === b[k])) {
        return null;
      }
    }
  }
  const arrayEvents = events.filter((event) => event instanceof Y.YArrayEvent).length;
  if (arrayEvents > 1) {
    return null;
  }

  const ops: JxDocOp[] = [];
  for (const event of events) {
    const path = event.path as JxPath;
    if (event instanceof Y.YMapEvent) {
      const target = event.target as Y.Map<unknown>;
      for (const [key, change] of event.changes.keys) {
        if (change.action === "delete") {
          ops.push({ key, op: "set-key", path });
        } else {
          ops.push({ key, op: "set-key", path, value: yValueToJson(target.get(key)) });
        }
      }
    } else if (event instanceof Y.YArrayEvent) {
      // The array event's path points at the children array; ops address its parent node.
      if (path.at(-1) !== "children") {
        return null;
      }
      const parentPath = path.slice(0, -1);
      let index = 0;
      for (const delta of event.changes.delta) {
        if (delta.retain !== undefined) {
          index += delta.retain;
        } else if (delta.delete !== undefined) {
          for (let i = 0; i < delta.delete; i++) {
            ops.push({ index, op: "remove-child", parentPath });
          }
        } else if (delta.insert !== undefined) {
          const items = Array.isArray(delta.insert) ? delta.insert : [delta.insert];
          for (const item of items) {
            ops.push({ index, node: yValueToJson(item), op: "insert-child", parentPath });
            index += 1;
          }
        }
      }
    } else {
      return null;
    }
  }
  return ops;
}
