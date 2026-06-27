/**
 * Pure document-op applier — folds a value-carrying {@link JxDocOp} into a bare (non-reactive)
 * document tree. Shared by two consumers that MUST stay byte-identical or undo/redo would drift
 * from live editing: history replay in the parent ({@link file://./transact.ts}) and the iframe
 * canvas's non-reactive shadow doc (the patch source-of-truth across the cross-origin bridge).
 *
 * Dependency-light on purpose: it pulls only the pure path helper from `../state` and clones values
 * with a local JSON round-trip, so the slim canvas-iframe bundle can import it without dragging in
 * the editor's reactive store / format host.
 */

import { getNodeAtPath } from "../state";
import type { JxDocOp } from "./patch-ops";
import type { JxMutableNode } from "@jxsuite/schema/types";

/** JSON round-trip clone — also normalizes away reactive proxies / functions / undefined. */
function jsonClone<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone throws on reactive proxies; JSON normalization is the point
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deep-clone a recorded value (undefined/null pass through; reactive proxies are read through). */
export function cloneValue<T>(v: T): T {
  return v === undefined || v === null ? v : (jsonClone(v as object) as T);
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
