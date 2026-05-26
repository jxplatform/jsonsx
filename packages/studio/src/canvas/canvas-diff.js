/**
 * Canvas Diff — computes visual diff between original and current Jx documents.
 *
 * Compares two document trees recursively, marking nodes as added/removed/modified, and propagates
 * "modified" status up the tree for structural changes (children added/removed/reordered).
 */

/**
 * @typedef {JxMutableNode} JxNode
 *
 * @typedef {"added" | "removed" | "modified"} DiffStatus
 *
 * @typedef {{ byPath: Map<string, DiffStatus>; allPaths: Set<string> }} DiffResult
 */

/**
 * Deep equality check for two values. Ignores function and ref properties.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function valuesEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    const bArr = /** @type {unknown[]} */ (b);
    if (a.length !== bArr.length) return false;
    return a.every((/** @type {unknown} */ v, /** @type {number} */ i) => valuesEqual(v, bArr[i]));
  }

  const aObj = /** @type {Record<string, unknown>} */ (a);
  const bObj = /** @type {Record<string, unknown>} */ (b);

  const keysA = Object.keys(aObj).filter(
    (/** @type {string} */ k) => !k.startsWith("on") && k !== "$ref",
  );
  const keysB = Object.keys(bObj).filter(
    (/** @type {string} */ k) => !k.startsWith("on") && k !== "$ref",
  );

  if (keysA.length !== keysB.length) return false;
  if (!keysA.every((/** @type {string} */ k) => keysB.includes(k))) return false;

  return keysA.every((/** @type {string} */ k) => valuesEqual(aObj[k], bObj[k]));
}

/**
 * Filter element children from a node's children array.
 *
 * @param {JxMutableNode | undefined} node
 * @returns {JxMutableNode[]}
 */
function elementChildren(node) {
  if (!node?.children || !Array.isArray(node.children)) return [];
  return /** @type {JxMutableNode[]} */ (
    node.children.filter(
      (/** @type {JxMutableNode | string} */ c) => c != null && typeof c === "object",
    )
  );
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
function markRecursive(node, status, path, diffMap, allPaths) {
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
export function computeDocumentDiff(originalDoc, currentDoc) {
  /** @type {Map<string, DiffStatus>} */
  const diffMap = new Map();
  /** @type {Set<string>} */
  const allPaths = new Set();

  /**
   * Walk both trees in parallel and mark differences.
   *
   * @param {JxMutableNode | undefined} origNode
   * @param {JxMutableNode | undefined} currNode
   * @param {string} path
   */
  const walk = (origNode, currNode, path = "") => {
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
export function clearDiffHighlight(canvas) {
  canvas
    .querySelectorAll(".element-diff-added, .element-diff-removed, .element-diff-modified")
    .forEach((/** @type {Element} */ el) => {
      el.classList.remove("element-diff-added", "element-diff-removed", "element-diff-modified");
    });
}
