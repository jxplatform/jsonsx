/**
 * The canonical Jx document-op vocabulary and its pure applier. A `JxDocOp` is a value-carrying,
 * replayable mutation of a plain-JSON Jx document tree, addressed by `JxPath` (alternating
 * "children" / index segments for structure, plus node keys). Studio's transaction pipeline records
 * forward/inverse pairs of these for history replay; the collab bridge mirrors them into a shared
 * Y.Doc.
 *
 * This module is deliberately yjs-free and dependency-light: the slim canvas-iframe bundle imports
 * the applier for its non-reactive shadow doc, and it MUST stay byte-identical in behavior to the
 * parent's history replay — both sides import this one implementation.
 */

import type { JxMutableNode, JxPath } from "@jxsuite/schema/types";

/** Value-carrying document mutation, replayable in either direction. */
export type JxDocOp =
  /** Set (or delete, when value is undefined) a key on the node at path. */
  | { op: "set-key"; path: JxPath; key: string; value?: unknown }
  /** Insert a node at parentPath.children[index]. */
  | { op: "insert-child"; parentPath: JxPath; index: number; node: unknown }
  /** Remove parentPath.children[index]. */
  | { op: "remove-child"; parentPath: JxPath; index: number }
  /** Replace parentPath.children[index] with node. */
  | { op: "set-child"; parentPath: JxPath; index: number; node: unknown }
  /** Raw two-splice move: remove fromParent.children[fromIndex], insert at toParent[toIndex]. */
  | {
      op: "move-child";
      fromParentPath: JxPath;
      fromIndex: number;
      toParentPath: JxPath;
      toIndex: number;
    };

export interface JxDocOpPair {
  forward: JxDocOp;
  inverse: JxDocOp;
}

/** JSON round-trip clone — also normalizes away reactive proxies / functions / undefined. */
function jsonClone<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone throws on reactive proxies; JSON normalization is the point
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deep-clone a recorded value (undefined/null pass through; reactive proxies are read through). */
export function cloneValue<T>(v: T): T {
  return v === undefined || v === null ? v : (jsonClone(v as object) as T);
}

/**
 * Walk a plain document tree by path. Paths address nodes by construction; missing segments and
 * non-node leaves surface as undefined (typed as node for caller ergonomics, matching Studio's
 * historical helper).
 */
export function getNodeAtPath(doc: JxMutableNode, path: JxPath): JxMutableNode {
  let node = doc;
  for (const key of path) {
    if (node == null) {
      return undefined as unknown as JxMutableNode;
    }
    node = node[key] as JxMutableNode;
  }
  return node;
}

/** The node's children array, lazily created; throws if `node` is itself a children array or mapped. */
export function childArray(node: JxMutableNode): (JxMutableNode | string)[] {
  // Defense-in-depth: a path that resolves to a children array (rather than a node) would
  // Otherwise get a bogus `.children` property tacked on here, silently storing the insert where
  // Nothing renders. Callers must pass a node; fail loudly if they don't.
  if (Array.isArray(node)) {
    throw new TypeError("Cannot insert into a children array; parentPath must point at a node");
  }
  if (!node.children) {
    node.children = [];
  }
  if (!Array.isArray(node.children)) {
    throw new TypeError("Cannot insert into mapped-array children; edit the map template instead");
  }
  return node.children;
}

/**
 * Apply a replayable doc op to a bare document tree. Values/nodes are cloned in, so the tree never
 * aliases the op object. Throws (with a machine-readable reason) when a target path is missing.
 */
export function applyDocOpToDoc(doc: JxMutableNode, op: JxDocOp): void {
  switch (op.op) {
    case "set-key": {
      const node = getNodeAtPath(doc, op.path);
      if (!node) {
        throw new Error(`doc-op-node-not-found:${op.path.join("/")}`);
      }
      const target = node as Record<string, unknown>;
      if (op.value === undefined) {
        delete target[op.key];
      } else {
        target[op.key] = cloneValue(op.value);
      }
      return;
    }
    case "insert-child": {
      const parent = getNodeAtPath(doc, op.parentPath);
      childArray(parent).splice(op.index, 0, cloneValue(op.node) as JxMutableNode);
      return;
    }
    case "remove-child": {
      const parent = getNodeAtPath(doc, op.parentPath);
      childArray(parent).splice(op.index, 1);
      return;
    }
    case "set-child": {
      const parent = getNodeAtPath(doc, op.parentPath);
      childArray(parent).splice(op.index, 1, cloneValue(op.node) as JxMutableNode);
      return;
    }
    case "move-child": {
      const fromParent = getNodeAtPath(doc, op.fromParentPath);
      const toParent = getNodeAtPath(doc, op.toParentPath);
      const [node] = childArray(fromParent).splice(op.fromIndex, 1);
      childArray(toParent).splice(op.toIndex, 0, node!);
      return;
    }
    default: {
      throw new Error(`unknown-doc-op:${(op as JxDocOp).op}`);
    }
  }
}
