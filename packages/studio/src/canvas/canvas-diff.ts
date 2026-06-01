/**
 * Canvas Diff — computes visual diff between original and current Jx documents.
 *
 * Compares two document trees recursively, marking nodes as added/removed/modified, and propagates
 * "modified" status up the tree for structural changes (children added/removed/reordered).
 */

type DiffStatus = "added" | "removed" | "modified";

interface DiffResult {
  byPath: Map<string, DiffStatus>;
  allPaths: Set<string>;
}

/**
 * Deep equality check for two values. Ignores function and ref properties.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    if (a.length !== bArr.length) return false;
    return a.every((v: unknown, i: number) => valuesEqual(v, bArr[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;

  const keysA = Object.keys(aObj).filter((k: string) => !k.startsWith("on") && k !== "$ref");
  const keysB = Object.keys(bObj).filter((k: string) => !k.startsWith("on") && k !== "$ref");

  if (keysA.length !== keysB.length) return false;
  if (!keysA.every((k: string) => keysB.includes(k))) return false;

  return keysA.every((k: string) => valuesEqual(aObj[k], bObj[k]));
}

/**
 * Filter element children from a node's children array.
 *
 * @param {JxMutableNode | undefined} node
 * @returns {JxMutableNode[]}
 */
function elementChildren(node: JxMutableNode | undefined) {
  if (!node?.children || !Array.isArray(node.children)) return [];
  return node.children.filter(
    (c: JxMutableNode | string) => c != null && typeof c === "object",
  ) as JxMutableNode[];
}

/**
 * Mark an entire subtree with a diff status.
 *
 * @param {JxMutableNode} node
 * @param {DiffStatus} status
 * @param {string} path
 * @param {Map<string, DiffStatus>} diffMap
 * @param {Set<string>} allPaths
 */
function markRecursive(
  node: JxMutableNode,
  status: DiffStatus,
  path: string,
  diffMap: Map<string, DiffStatus>,
  allPaths: Set<string>,
) {
  allPaths.add(path);
  diffMap.set(path, status);
  const children = elementChildren(node);
  for (let i = 0; i < children.length; i++) {
    const childPath = `${path}/children/${i}`;
    markRecursive(children[i], status, childPath, diffMap, allPaths);
  }
}

/**
 * Compute structural diff between original and current documents.
 *
 * @param {JxMutableNode | undefined} originalDoc - Original document (from git)
 * @param {JxMutableNode | undefined} currentDoc - Current document (in memory/on disk)
 * @returns {DiffResult}
 */
export function computeDocumentDiff(
  originalDoc: JxMutableNode | undefined,
  currentDoc: JxMutableNode | undefined,
): DiffResult {
  const diffMap: Map<string, DiffStatus> = new Map();
  const allPaths: Set<string> = new Set();

  /**
   * Walk both trees in parallel and mark differences.
   *
   * @param {JxMutableNode | undefined} origNode
   * @param {JxMutableNode | undefined} currNode
   * @param {string} path
   */
  const walk = (
    origNode: JxMutableNode | undefined,
    currNode: JxMutableNode | undefined,
    path: string = "",
  ) => {
    const pathKey = path || "/";
    allPaths.add(pathKey);

    // Both exist but differ
    if (origNode != null && currNode != null) {
      if (!valuesEqual(origNode, currNode)) {
        diffMap.set(pathKey, "modified");
      }

      // Walk children
      if (origNode.children && currNode.children) {
        const origChildren = elementChildren(origNode);
        const currChildren = elementChildren(currNode);

        for (let i = 0; i < Math.max(origChildren.length, currChildren.length); i++) {
          const childPath = pathKey === "/" ? `children/${i}` : `${pathKey}/children/${i}`;
          walk(origChildren[i], currChildren[i], childPath);
        }
      }
      return;
    }

    // In current only (added)
    if (currNode != null && origNode == null) {
      diffMap.set(pathKey, "added");
      const children = elementChildren(currNode);
      for (let i = 0; i < children.length; i++) {
        const childPath = pathKey === "/" ? `children/${i}` : `${pathKey}/children/${i}`;
        markRecursive(children[i], "added", childPath, diffMap, allPaths);
      }
      return;
    }

    // In original only (removed)
    if (origNode != null && currNode == null) {
      diffMap.set(pathKey, "removed");
      const children = elementChildren(origNode);
      for (let i = 0; i < children.length; i++) {
        const childPath = pathKey === "/" ? `children/${i}` : `${pathKey}/children/${i}`;
        markRecursive(children[i], "removed", childPath, diffMap, allPaths);
      }
      return;
    }
  };

  // Start comparison
  walk(originalDoc, currentDoc, "");

  // Propagate "modified" status to parents of added/removed children
  const propagateModified = () => {
    let changed = false;
    for (const [path, status] of diffMap.entries()) {
      if ((status === "added" || status === "removed") && path !== "/") {
        const parentPath = path.split("/").slice(0, -2).join("/") || "/";
        if (parentPath !== "/") {
          const parentStatus = diffMap.get(parentPath);
          if (
            parentStatus !== "modified" &&
            parentStatus !== "added" &&
            parentStatus !== "removed"
          ) {
            diffMap.set(parentPath, "modified");
            changed = true;
          }
        }
      }
    }
    return changed;
  };

  // Propagate upwards until no more changes
  while (propagateModified()) {}

  return { byPath: diffMap, allPaths };
}

/**
 * Clear diff highlighting from all elements in a canvas.
 *
 * @param {HTMLElement} canvas
 */
export function clearDiffHighlight(canvas: HTMLElement) {
  canvas
    .querySelectorAll(".element-diff-added, .element-diff-removed, .element-diff-modified")
    .forEach((el: Element) => {
      el.classList.remove("element-diff-added", "element-diff-removed", "element-diff-modified");
    });
}
