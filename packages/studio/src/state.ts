/**
 * Document paths, the tree walk over them, and the project record.
 *
 * A `JxPath` addresses one node from the document root: `[]` is the root itself, `["children", 0]`
 * its first child, `["children", 0, "children", 2]` that child's third. Every module that points at
 * a node — selection, hover, the layers tree, a patch — spells it this way, which is why the
 * comparison and ancestry predicates live here rather than beside any one of them.
 *
 * The editable document and its history belong to a TAB (`tabs/tab.ts`) and its session lives on
 * the workspace; nothing here holds mutable document state. The one exception is `projectState`,
 * which outlives every document because it describes the folder they all come from.
 */

import type { ProjectState } from "./types";
import { isRef } from "@jxsuite/schema/guards";
import type { JxMutableNode } from "@jxsuite/schema/types";

export type JxPath = (string | number)[];

// ─── Path utilities ───────────────────────────────────────────────────────────

/**
 * Walk the document tree and return the node at the given path.
 *
 * @param {JxMutableNode} doc
 * @param {JxPath} path
 * @returns {JxMutableNode}
 */
export function getNodeAtPath(doc: JxMutableNode, path: JxPath) {
  let node = doc;
  for (const key of path) {
    if (node == null) {
      return undefined as unknown as JxMutableNode;
    }
    // Paths address nodes by construction; non-node leaves surface as undefined above.
    node = node[key] as JxMutableNode;
  }
  return node;
}

/**
 * The node's children when they are a static array (the edit-mode invariant); an empty array for
 * mapped-array or absent children.
 *
 * @param {JxMutableNode | null | undefined} node
 * @returns {(JxMutableNode | string)[]}
 */
export function childList(node: JxMutableNode | null | undefined): (JxMutableNode | string)[] {
  return Array.isArray(node?.children) ? node.children : [];
}

/**
 * Normalize a document in place to the canonical array-member form: a legacy whole-children
 * repeater (`children: { $prototype: "Array", … }`) becomes a single member of a children array
 * (`children: [{ $prototype: "Array", … }]`). Recurses through children, repeater templates, and
 * `$switch` cases. Runs once when a document is loaded into a tab so every in-studio doc — and its
 * history checkpoints — uses the member form before any mutation.
 *
 * @param {unknown} node
 * @returns {unknown} The same node (mutated)
 */
export function normalizeArrayChildren(node: unknown): unknown {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      normalizeArrayChildren(child);
    }
    return node;
  }
  const n = node as JxMutableNode;
  const { children } = n;
  if (
    children &&
    typeof children === "object" &&
    !Array.isArray(children) &&
    (children as JxMutableNode).$prototype === "Array"
  ) {
    n.children = [children as JxMutableNode];
  }
  if (Array.isArray(n.children)) {
    for (const child of n.children) {
      normalizeArrayChildren(child);
    }
  }
  if (n.$prototype === "Array" && n.map && typeof n.map === "object") {
    normalizeArrayChildren(n.map);
  }
  if (n.cases && typeof n.cases === "object") {
    for (const caseDef of Object.values(n.cases)) {
      normalizeArrayChildren(caseDef);
    }
  }
  return node;
}

/**
 * Return the path to the parent element (strips trailing 'children' + index).
 *
 * @param {JxPath} path
 * @returns {JxPath | null}
 */
export function parentElementPath(path: JxPath) {
  return path.length >= 2 ? path.slice(0, -2) : null;
}

/**
 * Return the child index (last segment of the path).
 *
 * @param {JxPath} path
 * @returns {string | number}
 */
export function childIndex(path: JxPath) {
  return path.at(-1);
}

/**
 * Serialize a path to a string key for Map lookups.
 *
 * @param {JxPath} path
 * @returns {string}
 */
export function pathKey(path: JxPath) {
  return path.join("/");
}

/**
 * Compare two paths for equality.
 *
 * @param {JxPath | null} a
 * @param {JxPath | null} b
 * @returns {boolean}
 */
export function pathsEqual(a: JxPath | null, b: JxPath | null) {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  return a.every((v, i) => v === b[i]);
}

/**
 * Returns true if `path` is an ancestor of (or equal to) `descendant`.
 *
 * @param {JxPath} path
 * @param {JxPath} descendant
 * @returns {boolean}
 */
export function isAncestor(path: JxPath, descendant: JxPath) {
  if (path.length > descendant.length) {
    return false;
  }
  return path.every((v, i) => v === descendant[i]);
}

// ─── Tree flattening (for layer panel) ────────────────────────────────────────

/**
 * Flatten a Jx document into an array of { node, path, depth, nodeType } rows. Walks static
 * children arrays, $map templates, and $switch cases.
 *
 * NodeType: 'element' (default) | 'map' | 'case' | 'case-ref'
 *
 * @param {JxMutableNode | string | number | boolean} doc
 * @param {JxPath} [path]
 * @param {number} [depth]
 * @returns {{
 *   node: JxMutableNode | string | number | boolean;
 *   path: JxPath;
 *   depth: number;
 *   nodeType: string;
 * }[]}
 */
export interface FlatRow {
  node: JxMutableNode | string | number | boolean;
  path: JxPath;
  depth: number;
  nodeType: string;
}

export function flattenTree(
  doc: JxMutableNode | string | number | boolean,
  path: JxPath = [],
  depth = 0,
): FlatRow[] {
  const rows: FlatRow[] = [];
  collectRows(doc, path, depth, rows, false);
  return rows;
}

/**
 * Pre-order walk that appends into `out`.
 *
 * Appending beats returning-and-spreading: `rows.push(...flattenTree(child))` copied every
 * descendant row once per ancestor level (O(n·depth) copies) and passed the whole subtree as
 * argument list, which throws `RangeError: too many arguments` on a large enough tree.
 *
 * `skipSelf` omits the node's own row and emits only its descendants — the `$switch` case branch
 * needs that, having already emitted a `case` row with its own nodeType.
 */
function collectRows(
  doc: JxMutableNode | string | number | boolean,
  path: JxPath,
  depth: number,
  out: FlatRow[],
  skipSelf: boolean,
): void {
  // Text node children: bare primitives get a "text" row
  if (typeof doc === "string" || typeof doc === "number" || typeof doc === "boolean") {
    if (!skipSelf) {
      out.push({ depth, node: doc, nodeType: "text", path });
    }
    return;
  }

  // Array pseudo-element (repeater): a first-class node at its own path. Emit the "map" row, then
  // Recurse into its single template at `[...path, "map"]`. This is reached both when the array is
  // A member of a children array (path `[…, "children", i]`) and the legacy whole-children form
  // (path `[…, "children"]`).
  if ((doc as JxMutableNode).$prototype === "Array") {
    if (!skipSelf) {
      out.push({ depth, node: doc, nodeType: "map", path });
    }
    const mapDef = (doc as JxMutableNode).map;
    if (mapDef && typeof mapDef === "object") {
      collectRows(mapDef as JxMutableNode, [...path, "map"], depth + 1, out, false);
    }
    return;
  }

  if (!skipSelf) {
    out.push({ depth, node: doc, nodeType: "element", path });
  }

  // Custom component instances without user-authored children are atomic in the layer tree
  if (doc.$props && (doc.tagName || "").includes("-") && !Array.isArray(doc.children)) {
    return;
  }

  const { children } = doc;

  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const childPath = [...path, "children", i];
      collectRows(children[i]!, childPath, depth + 1, out, false);
    }
  } else if (
    children &&
    typeof children === "object" &&
    (children as JxMutableNode).$prototype === "Array"
  ) {
    // Legacy whole-children repeater: the array occupies the children slot itself.
    collectRows(children as JxMutableNode, [...path, "children"], depth + 1, out, false);
  }

  // $switch — emit each case as a virtual child
  if (doc.$switch && doc.cases && typeof doc.cases === "object") {
    for (const [caseName, caseDef] of Object.entries(doc.cases)) {
      const casePath = [...path, "cases", caseName];
      if (caseDef && typeof caseDef === "object" && (caseDef as JxMutableNode).$ref) {
        out.push({
          depth: depth + 1,
          node: caseDef as JxMutableNode,
          nodeType: "case-ref",
          path: casePath,
        });
      } else if (caseDef && typeof caseDef === "object") {
        out.push({
          depth: depth + 1,
          node: caseDef as JxMutableNode,
          nodeType: "case",
          path: casePath,
        });
        // Recurse into case children — skipSelf, because the "case" row above already stands in for
        // The case node itself (with its own nodeType).
        collectRows(caseDef as JxMutableNode, casePath, depth + 2, out, true);
      }
    }
  }
}

/**
 * Get a display label for a node (for layers + overlays).
 *
 * @param {JxMutableNode | null} node
 * @returns {string}
 */
export function nodeLabel(node: JxMutableNode | null) {
  if (!node) {
    return "?";
  }
  // $map container (Repeater)
  if (node.$prototype === "Array") {
    const { items } = node;
    const ref = (isRef(items) ? items.$ref : undefined) || "items";
    return `Repeater → ${ref}`;
  }
  if (node.$title) {
    return node.$title;
  }
  if (node.$id) {
    return node.$id;
  }
  if (node.tagName === "slot") {
    const name = node.attributes?.name;
    return typeof name === "string" && name.trim() ? `slot: ${name.trim()}` : "slot";
  }
  const tag = node.tagName ?? "div";
  const suffix = node.$switch ? " ⇆" : "";
  if (typeof node.textContent === "string" && node.textContent.length > 0) {
    return `${tag} — ${node.textContent.slice(0, 24)}${suffix}`;
  }
  return tag + suffix;
}

// ─── Project state (persists across document switches) ────────────────────────
//
// Shape: { root, name, projectRoot, isSiteProject, projectConfig,
//          Dirs: Map<string, DirEntry[]>, expanded: Set<string>,
//          SelectedPath: string|null, searchQuery: string }
// DirEntry: { name, path, type: "file"|"directory", size, modified }

export let projectState: ProjectState | null = null;

/** @param {ProjectState | null} ps */
export function setProjectState(ps: ProjectState | null) {
  projectState = ps;
}

/**
 * Return the current project state, asserting it is non-null. Only call when a project is known to
 * be loaded.
 *
 * @returns {ProjectState}
 */
export function requireProjectState() {
  return projectState as ProjectState;
}
