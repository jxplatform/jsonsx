import type { JxElement } from "@jxsuite/schema/types";

export interface LayoutResult {
  /** The shared layout with a $slot placeholder where page-specific content goes. */
  layout: JxElement;
  /** Per-page trees with the shared header/footer removed. */
  strippedPages: Map<string, JxElement>;
}

/**
 * Hash a subtree by structure (tagName + child structure), ignoring text content and attribute
 * values. Used to detect structurally identical subtrees across pages.
 */
export function hashSubtree(node: JxElement | string): string {
  if (typeof node === "string") {
    return `#text`;
  }

  const tag = node.tagName ?? "div";
  const childHashes: string[] = [];

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      childHashes.push(hashSubtree(child as JxElement | string));
    }
  }

  if (node.textContent) {
    childHashes.push("#text");
  }

  return `<${tag}>${childHashes.join(",")}`;
}

/**
 * Compare two Jx trees for deep structural equality (tagName + children structure). Text content
 * and attribute values are compared exactly — this is for detecting truly identical
 * headers/footers, not fuzzy matches.
 */
export function treesEqual(a: JxElement | string, b: JxElement | string): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }
  if (typeof a === "string" || typeof b === "string") {
    return false;
  }

  if ((a.tagName ?? "div") !== (b.tagName ?? "div")) {
    return false;
  }
  if ((a.textContent ?? "") !== (b.textContent ?? "")) {
    return false;
  }

  const aChildren = Array.isArray(a.children) ? a.children : [];
  const bChildren = Array.isArray(b.children) ? b.children : [];

  if (aChildren.length !== bChildren.length) {
    return false;
  }

  for (let i = 0; i < aChildren.length; i++) {
    if (!treesEqual(aChildren[i] as JxElement | string, bChildren[i] as JxElement | string)) {
      return false;
    }
  }

  return true;
}

/**
 * Detect shared header/footer subtrees across multiple pages and extract them into a layout.
 *
 * Strategy: look at the top-level children of each page's root div. Children that appear
 * identically (by deep structural+content equality) at the same position from the start (header) or
 * end (footer) across ALL pages are candidates for the shared layout.
 *
 * Returns null if fewer than 2 pages or no shared subtrees found.
 */
export function detectLayout(pages: Map<string, JxElement>): LayoutResult | null {
  if (pages.size < 2) {
    return null;
  }

  const entries = [...pages.entries()];
  const allRoots = entries.map(([, doc]) =>
    Array.isArray(doc.children) ? (doc.children as (JxElement | string)[]) : [],
  );

  // Find shared prefix (header elements)
  let sharedPrefixLen = 0;
  const minLen = Math.min(...allRoots.map((c) => c.length));

  for (let i = 0; i < minLen; i++) {
    const reference = allRoots[0][i];
    const allMatch = allRoots.every((children) => treesEqual(children[i], reference));
    if (allMatch) {
      sharedPrefixLen = i + 1;
    } else {
      break;
    }
  }

  // Find shared suffix (footer elements), not overlapping with prefix
  let sharedSuffixLen = 0;
  for (let i = 0; i < minLen - sharedPrefixLen; i++) {
    const reference = allRoots[0][allRoots[0].length - 1 - i];
    const allMatch = allRoots.every((children) =>
      treesEqual(children[children.length - 1 - i], reference),
    );
    if (allMatch) {
      sharedSuffixLen = i + 1;
    } else {
      break;
    }
  }

  if (sharedPrefixLen === 0 && sharedSuffixLen === 0) {
    return null;
  }

  // Build layout: shared prefix + $slot + shared suffix
  const headerChildren = allRoots[0].slice(0, sharedPrefixLen);
  const footerChildren =
    sharedSuffixLen > 0 ? allRoots[0].slice(allRoots[0].length - sharedSuffixLen) : [];

  const slot: JxElement = {
    tagName: "slot",
    attributes: { name: "content" },
  };

  const layout: JxElement = {
    tagName: "div",
    children: [...(headerChildren as JxElement[]), slot, ...(footerChildren as JxElement[])],
  };

  // Strip shared elements from each page
  const strippedPages = new Map<string, JxElement>();
  for (const [route, doc] of entries) {
    const children = Array.isArray(doc.children) ? (doc.children as (JxElement | string)[]) : [];

    const endIdx = sharedSuffixLen > 0 ? children.length - sharedSuffixLen : children.length;
    const uniqueChildren = children.slice(sharedPrefixLen, endIdx);

    strippedPages.set(route, {
      ...doc,
      children: uniqueChildren as JxElement[],
      $layout: "layouts/base.json",
    });
  }

  return { layout, strippedPages };
}
