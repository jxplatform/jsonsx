/**
 * Site context helpers - merge site-level definitions with file-level.
 *
 * When a project has a project.json, its $media and style cascade into every file. File-level
 * definitions merge on top (file wins on conflict).
 */

import { projectState, setProjectState } from "./store.js";
import { getPlatform } from "./platform.js";

/**
 * Merge site $media with document $media. Document keys win on conflict.
 *
 * @param {any} docMedia - The current document's $media (may be undefined)
 * @returns {any}
 */
export function getEffectiveMedia(docMedia) {
  const siteMedia = projectState?.projectConfig?.$media;
  if (!siteMedia) return docMedia || {};
  if (!docMedia) return { ...siteMedia };
  return { ...siteMedia, ...docMedia };
}

/**
 * Merge site style with document style. Document keys win on conflict. Nested selector objects
 * (e.g. `& li`) are shallow-merged individually.
 *
 * @param {any} docStyle - The current document's style (may be undefined)
 * @returns {any}
 */
export function getEffectiveStyle(docStyle) {
  const siteStyle = projectState?.projectConfig?.style;
  if (!siteStyle) return docStyle || {};
  if (!docStyle) return { ...siteStyle };
  const merged = { ...siteStyle };
  for (const [k, v] of Object.entries(docStyle)) {
    if (
      typeof v === "object" &&
      v !== null &&
      typeof merged[k] === "object" &&
      merged[k] !== null
    ) {
      merged[k] = { ...merged[k], ...v };
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

/**
 * Merge site imports with document imports. Document keys win on conflict.
 *
 * @param {any} docImports - The current document's imports (may be undefined)
 * @returns {any}
 */
export function getEffectiveImports(docImports) {
  const siteImports = projectState?.projectConfig?.imports;
  if (!siteImports) return docImports || {};
  if (!docImports) return { ...siteImports };
  return { ...siteImports, ...docImports };
}

/**
 * Merge site $elements with document $elements. Union with dedup by $ref or string value.
 *
 * @param {any[]} [docElements] - The current document's $elements (may be undefined)
 * @returns {any[]}
 */
export function getEffectiveElements(docElements) {
  const siteElements = projectState?.projectConfig?.$elements;
  if (!siteElements?.length) return docElements || [];
  if (!docElements?.length) return [...siteElements];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {any[]} */
  const merged = [];
  for (const entry of [...siteElements, ...docElements]) {
    const key = typeof entry === "string" ? entry : entry?.$ref;
    if (key && !seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

/**
 * Merge site $head with document $head. Union with dedup by href/src.
 *
 * @param {any[]} [docHead] - The current document's $head (may be undefined)
 * @returns {any[]}
 */
export function getEffectiveHead(docHead) {
  const siteHead = projectState?.projectConfig?.$head;
  if (!siteHead?.length) return docHead || [];
  if (!docHead?.length) return [...siteHead];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {any[]} */
  const merged = [];
  for (const entry of [...siteHead, ...docHead]) {
    const key = entry?.attributes?.href || entry?.attributes?.src || JSON.stringify(entry);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

// ─── Layout resolution ──────────────────────────────────────────────────────

/** @type {Map<string, any>} */
const layoutCache = new Map();

export function invalidateLayoutCache() {
  layoutCache.clear();
}

/**
 * Determine the effective layout path for a document.
 *
 * @param {any} docLayout - The document's $layout value (string path, false, or undefined)
 * @returns {string | null} The layout path, or null if no layout applies
 */
export function getEffectiveLayoutPath(docLayout) {
  if (docLayout === false) return null;
  const defaultLayout = projectState?.projectConfig?.defaults?.layout;
  return docLayout || defaultLayout || null;
}

/**
 * Resolve a layout document by path. Fetches and caches the parsed JSON.
 *
 * @param {string} layoutPath - Relative path to the layout file (e.g., "./layouts/base.json")
 * @returns {Promise<any | null>} The parsed layout document, or null on failure
 */
export async function resolveLayoutDoc(layoutPath) {
  const normalized = layoutPath.replace(/^\.\//, "");
  if (layoutCache.has(normalized)) return structuredClone(layoutCache.get(normalized));

  try {
    const platform = getPlatform();
    const content = await platform.readFile(normalized);
    const doc = JSON.parse(content);
    layoutCache.set(normalized, doc);
    return structuredClone(doc);
  } catch {
    return null;
  }
}

/**
 * Distribute page children into a layout document's <slot> elements. Returns the merged document
 * with page content injected into slots.
 *
 * @param {any} layoutDoc - Deep-cloned layout document
 * @param {any} pageDoc - The page document
 * @returns {any} The merged document
 */
export function distributePageIntoLayout(layoutDoc, pageDoc) {
  const pageChildren = pageDoc.children ?? [];
  const children = typeof pageChildren === "string" ? [pageChildren] : pageChildren;

  const named = new Map();
  const defaults = [];

  for (const child of children) {
    if (child && typeof child === "object" && child.attributes?.slot) {
      const slotName = child.attributes.slot;
      if (!named.has(slotName)) named.set(slotName, []);
      named.get(slotName).push(child);
    } else {
      defaults.push(child);
    }
  }

  fillSlots(layoutDoc, named, defaults);

  if (pageDoc.state) layoutDoc.state = { ...layoutDoc.state, ...pageDoc.state };
  if (pageDoc.$media) layoutDoc.$media = { ...layoutDoc.$media, ...pageDoc.$media };
  if (pageDoc.style) layoutDoc.style = { ...layoutDoc.style, ...pageDoc.style };
  if (pageDoc.attributes) layoutDoc.attributes = { ...layoutDoc.attributes, ...pageDoc.attributes };

  return layoutDoc;
}

function fillSlots(
  /** @type {any} */ node,
  /** @type {Map<string, any[]>} */ named,
  /** @type {any[]} */ defaults,
) {
  if (!node || typeof node !== "object") return;
  if (!Array.isArray(node.children)) return;

  const newChildren = [];
  for (const child of node.children) {
    if (child && typeof child === "object" && child.tagName === "slot") {
      const slotName = child.attributes?.name;
      if (slotName && named.has(slotName)) {
        newChildren.push(.../** @type {any[]} */ (named.get(slotName)));
        named.delete(slotName);
      } else if (!slotName && defaults.length > 0) {
        newChildren.push(...defaults);
      } else if (child.children) {
        newChildren.push(...child.children);
      }
    } else {
      fillSlots(child, named, defaults);
      newChildren.push(child);
    }
  }
  node.children = newChildren;
}

/**
 * Update the project's project.json with a partial patch and persist to disk.
 *
 * @param {Record<string, any>} patch - Fields to merge into the current projectConfig
 */
export async function updateSiteConfig(patch) {
  const platform = getPlatform();
  const config = { ...projectState.projectConfig, ...patch };
  await platform.writeFile("project.json", JSON.stringify(config, null, 2));
  setProjectState({ ...projectState, projectConfig: config });
}
