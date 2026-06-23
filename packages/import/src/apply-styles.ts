/**
 * Apply captured/diffed styles onto Jx tree nodes by matching tree paths. Walks the Jx tree in the
 * same depth-first element-index order as the browser DOM walk in style-capture.ts.
 */

import type { JxElement, JxStyle } from "@jxsuite/schema/types";
import type { DiffedStyle } from "./style-diff.ts";

/** Build a lookup from path key → style object for fast application. */
function buildStyleMap(diffed: DiffedStyle[]): Map<string, Record<string, string | number>> {
  const map = new Map<string, Record<string, string | number>>();
  for (const d of diffed) {
    map.set(d.path.join(","), d.style);
  }
  return map;
}

/**
 * Apply base styles and $media deltas to all nodes in the Jx tree.
 *
 * The tree is walked in the same depth-first element-child order as the browser capture, so path
 * indices align. String children (text nodes) are skipped in indexing, matching the browser's
 * Element.children behavior.
 */
export function applyStylesToTree(
  root: JxElement,
  baseStyles: DiffedStyle[],
  mediaDeltas?: Record<string, DiffedStyle[]>,
): void {
  const baseMap = buildStyleMap(baseStyles);
  const mediaMaps: Record<string, Map<string, Record<string, string | number>>> = {};
  if (mediaDeltas) {
    for (const [bpName, deltas] of Object.entries(mediaDeltas)) {
      mediaMaps[bpName] = buildStyleMap(deltas);
    }
  }

  // The root is a wrapper div (from to-jx.ts convertToJx), its children
  // Correspond to body's direct children. Walk those children.
  if (!root.children || !Array.isArray(root.children)) {
    return;
  }

  let childIdx = 0;
  for (const child of root.children) {
    if (typeof child === "string") {
      continue;
    }
    walkAndApply(child, [childIdx], baseMap, mediaMaps);
    childIdx += 1;
  }
}

function walkAndApply(
  node: JxElement,
  path: number[],
  baseMap: Map<string, Record<string, string | number>>,
  mediaMaps: Record<string, Map<string, Record<string, string | number>>>,
): void {
  const key = path.join(",");

  // Apply base styles
  const baseStyle = baseMap.get(key);
  if (baseStyle) {
    node.style = mergeStyle(node.style, baseStyle);
  }

  // Apply media-responsive deltas as @breakpointName nested objects
  for (const [bpName, deltaMap] of Object.entries(mediaMaps)) {
    const delta = deltaMap.get(key);
    if (delta && Object.keys(delta).length > 0) {
      if (!node.style) {
        node.style = {};
      }
      (node.style as Record<string, unknown>)[`@${bpName}`] = delta;
    }
  }

  // Recurse into element children (skip text nodes for indexing)
  if (!node.children || !Array.isArray(node.children)) {
    return;
  }

  let childIdx = 0;
  for (const child of node.children) {
    if (typeof child === "string") {
      continue;
    }
    walkAndApply(child, [...path, childIdx], baseMap, mediaMaps);
    childIdx += 1;
  }
}

function mergeStyle(
  existing: JxStyle | undefined,
  incoming: Record<string, string | number>,
): JxStyle {
  const merged: JxStyle = existing ? { ...existing } : {};
  for (const [prop, val] of Object.entries(incoming)) {
    merged[prop] = val;
  }
  return merged;
}
