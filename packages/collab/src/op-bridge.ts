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
import {
  applyTextEdit,
  GRANULAR_OBJECT_KEYS,
  mergeYObject,
  resolveYPath,
  TEXT_KEYS,
  toYChild,
  toYChildren,
  toYObject,
  yValueToJson,
} from "./schema.ts";

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Write a node key, preserving CRDT identity wherever the schema stores it granularly.
 *
 * Studio's mutators record whole-value `set-key` ops — `mutateUpdateStyle` replaces the entire
 * style object, an inline-edit commit replaces the entire `textContent`. Writing those straight
 * through with `Y.Map.set` mints a fresh Y type each time and throws away whatever a peer
 * concurrently did to the old one, which is exactly how "two people typing in one paragraph" became
 * last-writer-wins.
 *
 * So a whole-value op is diffed down onto the existing structure: text through {@link applyTextEdit}
 * (character-level), granular objects through {@link mergeYObject} (per-property). Only a TYPE
 * change — string text becoming a `$ref`, an object becoming a scalar — falls back to replacement,
 * because then there is no shared structure left to preserve.
 */
function setNodeKey(node: Y.Map<unknown>, key: string, value: unknown): void {
  const existing = node.get(key);
  if (key === "children" && Array.isArray(value)) {
    node.set(key, toYChildren(value));
    return;
  }
  if (TEXT_KEYS.has(key) && typeof value === "string") {
    if (existing instanceof Y.Text) {
      applyTextEdit(existing, value);
    } else {
      node.set(key, new Y.Text(value));
    }
    return;
  }
  if (GRANULAR_OBJECT_KEYS.has(key) && isPlainObject(value)) {
    if (existing instanceof Y.Map) {
      mergeYObject(existing, value);
    } else {
      node.set(key, toYObject(value));
    }
    return;
  }
  node.set(key, cloneJson(value));
}

function applyOneOp(doc: Y.Doc, op: JxDocOp): void {
  switch (op.op) {
    case "set-key": {
      const node = requireNode(doc, op.path);
      if (op.value === undefined) {
        node.delete(op.key);
      } else {
        setNodeKey(node, op.key, op.value);
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
      // Text child → text child: edit the existing Y.Text in place. A delete+insert would replace the
      // Whole element and discard a peer's concurrent characters, which is the same clobber
      // `setNodeKey` avoids for `textContent` — bare-string children are the other half of prose.
      const existing = children.get(op.index);
      if (existing instanceof Y.Text && typeof op.node === "string") {
        applyTextEdit(existing, op.node);
        return;
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

/**
 * When `path` addresses a granular container (or something nested inside one), the node that owns
 * it and the key it sits under; otherwise null.
 *
 * The event path is relative to the structure map, so the first segment matching a granular key
 * marks the boundary: everything before it is the node path, and anything after it is interior
 * detail the op log does not model.
 *
 * `children`/index segments need no special handling: they are not granular keys, so the scan
 * passes over them and the returned node path keeps the full prefix — `["children", 0, "style"]`
 * resolves to the style of the node at `children/0`, not of the root.
 */
function granularOwner(path: JxPath): { nodePath: JxPath; key: string } | null {
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (typeof segment !== "string") {
      continue;
    }
    if (GRANULAR_OBJECT_KEYS.has(segment)) {
      return { key: segment, nodePath: path.slice(0, i) };
    }
    if (TEXT_KEYS.has(segment)) {
      return { key: segment, nodePath: path.slice(0, i) };
    }
  }
  return null;
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
    /*
     * A remote edit inside a granular container (a `Y.Text` for prose, a nested `Y.Map` for
     * style/attributes/$props) reports its event at the CONTAINER's path, not the node's. Studio's op
     * vocabulary addresses nodes, so those collapse back to one whole-value op for the owning key —
     * the same shape a local mutator would have produced. Granularity buys merge; it deliberately does
     * not leak into the op log, the canvas patcher, or the history ring.
     */
    const granular = granularOwner(path);
    if (granular) {
      const { doc } = event.target as { doc?: Y.Doc | null };
      if (!doc) {
        return null;
      }
      const container = resolveYPath(doc, [...granular.nodePath, granular.key]);
      if (container === undefined) {
        return null;
      }
      ops.push({
        key: granular.key,
        op: "set-key",
        path: granular.nodePath,
        value: yValueToJson(container),
      });
      continue;
    }
    if (event instanceof Y.YTextEvent) {
      // A bare-string child: the text IS the child, so it round-trips as a child replacement.
      const index = path.at(-1);
      if (path.at(-2) === "children" && typeof index === "number") {
        ops.push({
          index,
          node: (event.target as Y.Text).toString(),
          op: "set-child",
          parentPath: path.slice(0, -2),
        });
        continue;
      }
      return null;
    }
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
