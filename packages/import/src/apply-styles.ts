/**
 * Apply captured/diffed styles onto Jx tree nodes by matching tree paths. Walks the Jx tree in the
 * same depth-first element-index order as the browser DOM walk in style-capture.ts.
 */

import type { JxElement, JxStyle } from "@jxsuite/schema/types";
import type { DiffedStyle } from "./style-diff.ts";
import { parseWidthQuery } from "./breakpoint-plan.ts";
import { dropDerivedGeometry } from "./derived-geometry.ts";

/** Build a lookup from path key → style object for fast application. */
function buildStyleMap(diffed: DiffedStyle[]): Map<string, Record<string, string | number>> {
  const map = new Map<string, Record<string, string | number>>();
  for (const d of diffed) {
    map.set(d.path.join(","), d.style);
  }
  return map;
}

/**
 * The order breakpoint keys must be WRITTEN in, so the cascade resolves the way the source site
 * did.
 *
 * A node's `@--name` keys become `@media` blocks at equal specificity, and equal specificity means
 * the LAST matching rule wins. So the order is not cosmetic: with `--767` written before `--1024`,
 * a 500px viewport matches both and takes the 1024 rule, which is the wrong one. Breakpoints are
 * planned and iterated ascending, so every multi-breakpoint node came out inverted.
 *
 * Correct order is per direction. `max-width` narrows downward, so the NARROWER query must come
 * last to win at narrow viewports: descending. `min-width` widens upward, so the WIDER query must
 * come last: ascending. A query neither shape (or one the planner could not read) keeps its
 * relative order at the end, where it cannot displace a rule that was understood.
 *
 * This is deliberately NOT the order `$media` itself is written in — `emit.ts` sorts that map
 * ascending for Studio's Contexts list, and a lookup table has no cascade to get wrong.
 */
export function orderBreakpointKeys(
  names: readonly string[],
  queries: Record<string, string> | undefined,
): string[] {
  const rank = (name: string): { band: number; width: number } => {
    const parsed = queries?.[name] === undefined ? null : parseWidthQuery(queries[name]!);
    if (!parsed) {
      return { band: 2, width: 0 };
    }
    return parsed.type === "max"
      ? { band: 0, width: -parsed.width }
      : { band: 1, width: parsed.width };
  };
  return names.toSorted((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra.band === rb.band ? ra.width - rb.width : ra.band - rb.band;
  });
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
  breakpointQueries?: Record<string, string>,
): void {
  const baseMap = buildStyleMap(baseStyles);
  const mediaMaps: [string, Map<string, Record<string, string | number>>][] = [];
  if (mediaDeltas) {
    for (const bpName of orderBreakpointKeys(Object.keys(mediaDeltas), breakpointQueries)) {
      mediaMaps.push([bpName, buildStyleMap(mediaDeltas[bpName]!)]);
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
  mediaMaps: readonly [string, Map<string, Record<string, string | number>>][],
): void {
  const key = path.join(",");

  /* Measured geometry is filtered against the NODE, because the question is structural: a
     block-level box in normal flow fills its container, so its measured width states a fact the
     layout already implies and pinning it is what stops the clone reflowing. The copy is per node
     because the same captured style object is shared between every instance of a component. */
  const baseStyle = baseMap.get(key);
  if (baseStyle) {
    const filtered = { ...baseStyle };
    dropDerivedGeometry(node, filtered);
    node.style = mergeStyle(node.style, filtered);
  }

  // Apply media-responsive deltas as @breakpointName nested objects
  for (const [bpName, deltaMap] of mediaMaps) {
    const delta = deltaMap.get(key);
    if (delta) {
      const filtered = { ...delta };
      dropDerivedGeometry(node, filtered, (node.style ?? {}) as Record<string, unknown>);
      if (Object.keys(filtered).length > 0) {
        if (!node.style) {
          node.style = {};
        }
        (node.style as Record<string, unknown>)[`@${bpName}`] = filtered;
      }
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
