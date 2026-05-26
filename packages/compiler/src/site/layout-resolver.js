/**
 * Layout-resolver.js — Layout loading and slot distribution at compile time
 *
 * Resolves $layout references, loads layout JSON files, and distributes page content into layout
 * <slot> elements. This is the compile-time equivalent of the runtime's distributeSlots()
 * algorithm.
 *
 * Per site-architecture spec §5:
 *
 * - Layouts are JSON files in the layouts/ directory
 * - Pages reference layouts via "$layout": "./layouts/base.json"
 * - The page's children are distributed into the layout's <slot> elements
 * - Named slots use attributes.slot on page children
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve a page's layout, wrapping the page content in the layout structure.
 *
 * @param {JxDocument} pageDoc - The raw page JSON document
 * @param {Record<string, unknown>} projectConfig - Site configuration (for defaults.layout)
 * @param {string} projectRoot - Project root directory
 * @returns {JxDocument} The merged document (layout wrapping page content)
 */
export function resolveLayout(pageDoc, projectConfig, projectRoot) {
  // Determine which layout to use
  const layoutRef =
    pageDoc.$layout ??
    /** @type {Record<string, unknown>} */ (projectConfig.defaults)?.layout ??
    null;

  if (!layoutRef) {
    // No layout — return page as-is
    return pageDoc;
  }

  // Load the layout file
  const layoutPath = resolve(projectRoot, /** @type {string} */ (layoutRef));
  if (!existsSync(layoutPath)) {
    throw new Error(`Layout not found: ${layoutRef} (resolved to ${layoutPath})`);
  }

  /** @type {JxDocument} */
  let layoutDoc;
  try {
    layoutDoc = JSON.parse(readFileSync(layoutPath, "utf8"));
  } catch (e) {
    const err = /** @type {Error} */ (e);
    throw new Error(`Invalid layout JSON at ${layoutPath}: ${err.message}`);
  }

  // Check for nested layouts (layout inheriting from another layout)
  if (layoutDoc.$layout) {
    layoutDoc = resolveLayout(layoutDoc, projectConfig, projectRoot);
  }

  // Distribute page children into layout slots
  const rawChildren = pageDoc.children ?? [];
  const pageChildren = /** @type {(JxElement | string)[]} */ (
    typeof rawChildren === "string" ? [rawChildren] : Array.isArray(rawChildren) ? rawChildren : []
  );
  const merged = deepClone(layoutDoc);

  distributeSlots(merged, pageChildren);

  // Merge page-level properties onto the resolved document
  // Page state extends layout state
  if (pageDoc.state) {
    merged.state = { ...merged.state, ...pageDoc.state };
  }

  // Page $media extends layout $media
  if (pageDoc.$media) {
    merged.$media = { ...merged.$media, ...pageDoc.$media };
  }

  // Page style extends layout style
  if (pageDoc.style) {
    merged.style = { ...merged.style, ...pageDoc.style };
  }

  // Page attributes extend layout attributes
  if (pageDoc.attributes) {
    merged.attributes = { ...merged.attributes, ...pageDoc.attributes };
  }

  // Preserve page-level metadata
  if (pageDoc.$head) merged._pageHead = pageDoc.$head;
  if (pageDoc.title) merged._pageTitle = pageDoc.title;

  // Remove $layout from merged doc (already resolved)
  delete merged.$layout;

  return merged;
}

/**
 * Distribute children into <slot> elements within a layout document tree. This is the compile-time
 * equivalent of the runtime's distributeSlots().
 *
 * Algorithm:
 *
 * 1. Find all <slot> elements in the layout tree
 * 2. For each child with attributes.slot, distribute to the matching named slot
 * 3. Remaining children go into the default (unnamed) slot
 * 4. Replace each <slot> element with its distributed children
 *
 * @param {JxElement} node - Layout document tree (mutated in place)
 * @param {(JxElement | string)[]} children - Page children to distribute
 */
function distributeSlots(node, children) {
  if (!node || typeof node !== "object") return;
  if (!Array.isArray(node.children)) return;

  // Collect named and default children
  /** @type {Map<string, (JxElement | string)[]>} */
  const named = new Map(); // slot name → children[]
  /** @type {(JxElement | string)[]} */
  const defaults = []; // children without a slot target

  for (const child of children) {
    if (child && typeof child === "object" && child.attributes?.slot) {
      const slotName = /** @type {string} */ (child.attributes.slot);
      if (!named.has(slotName)) named.set(slotName, []);
      /** @type {(JxElement | string)[]} */ (named.get(slotName)).push(child);
    } else {
      defaults.push(child);
    }
  }

  // Walk the tree and replace <slot> elements
  fillSlots(node, named, defaults);
}

/**
 * Recursively walk the tree and replace <slot> elements with distributed content.
 *
 * @param {JxElement} node
 * @param {Map<string, (JxElement | string)[]>} named
 * @param {(JxElement | string)[]} defaults
 */
function fillSlots(node, named, defaults) {
  if (!node || typeof node !== "object") return;
  if (!Array.isArray(node.children)) return;

  /** @type {(JxElement | string)[]} */
  const newChildren = [];

  for (const child of node.children) {
    if (child && typeof child === "object" && child.tagName === "slot") {
      const slotName = child.attributes?.name;

      if (slotName && named.has(/** @type {string} */ (slotName))) {
        // Named slot — replace with matching children
        newChildren.push(
          .../** @type {(JxElement | string)[]} */ (named.get(/** @type {string} */ (slotName))),
        );
        named.delete(/** @type {string} */ (slotName)); // consumed
      } else if (!slotName && defaults.length > 0) {
        // Default slot — replace with unassigned children
        newChildren.push(...defaults);
        // Don't clear defaults — only one default slot should exist,
        // but if there are multiple, the first one wins
      } else {
        // No matching content — keep slot's fallback children
        if (Array.isArray(child.children)) {
          newChildren.push(...child.children);
        }
      }
    } else {
      // Not a slot — recurse into it
      fillSlots(/** @type {JxElement} */ (child), named, defaults);
      newChildren.push(child);
    }
  }

  node.children = newChildren;
}

/**
 * Deep clone a JSON-serializable object.
 *
 * @param {JxDocument} obj
 * @returns {JxDocument}
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
