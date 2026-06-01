/**
 * Site context helpers - merge site-level definitions with file-level.
 *
 * When a project has a project.json, its $media and style cascade into every file. File-level
 * definitions merge on top (file wins on conflict).
 */

import { projectState, setProjectState, requireProjectState } from "./store";
import { getPlatform } from "./platform";

import type { JxElement, JxStyle, JxHeadEntry, ProjectConfig } from "@jxsuite/schema/types";

/**
 * Merge site $media with document $media. Document keys win on conflict.
 *
 * @param {Record<string, string> | undefined} docMedia - The current document's $media (may be
 *   undefined)
 * @returns {Record<string, string>}
 */
export function getEffectiveMedia(docMedia: Record<string, string> | undefined) {
  const siteMedia = projectState?.projectConfig?.$media;
  if (!siteMedia) return docMedia || {};
  if (!docMedia) return { ...siteMedia };
  return { ...siteMedia, ...docMedia };
}

/**
 * Merge site style with document style. Document keys win on conflict. Nested selector objects
 * (e.g. `& li`) are shallow-merged individually.
 *
 * @param {JxStyle | undefined} docStyle - The current document's style (may be undefined)
 * @returns {JxStyle}
 */
export function getEffectiveStyle(docStyle: JxStyle | undefined) {
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
      merged[k] = { ...(merged[k] as JxStyle), ...(v as JxStyle) };
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

/**
 * Merge site imports with document imports. Document keys win on conflict.
 *
 * @param {Record<string, string> | undefined} docImports - The current document's imports (may be
 *   undefined)
 * @returns {Record<string, string>}
 */
export function getEffectiveImports(docImports: Record<string, string> | undefined) {
  const siteImports = projectState?.projectConfig?.imports;
  if (!siteImports) return docImports || {};
  if (!docImports) return { ...siteImports };
  return { ...siteImports, ...docImports };
}

/**
 * Merge site $elements with document $elements. Union with dedup by $ref or string value.
 *
 * @param {(JxElement | string)[]} [docElements] - The current document's $elements (may be
 *   undefined)
 * @returns {(JxElement | string)[]}
 */
export function getEffectiveElements(docElements?: (JxElement | string)[]) {
  const siteElements = projectState?.projectConfig?.$elements;
  if (!siteElements?.length) return docElements || [];
  if (!docElements?.length) return [...siteElements];
  const seen: Set<string> = new Set();
  const merged: (JxElement | string)[] = [];
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
 * @param {JxHeadEntry[]} [docHead] - The current document's $head (may be undefined)
 * @returns {JxHeadEntry[]}
 */
export function getEffectiveHead(docHead?: JxHeadEntry[]) {
  const siteHead = projectState?.projectConfig?.$head;
  if (!siteHead?.length) return docHead || [];
  if (!docHead?.length) return [...siteHead];
  const seen: Set<string> = new Set();
  const merged: JxHeadEntry[] = [];
  for (const entry of [...siteHead, ...docHead]) {
    const key =
      String(entry?.attributes?.href || entry?.attributes?.src || "") || JSON.stringify(entry);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

// ─── Layout resolution ──────────────────────────────────────────────────────

const layoutCache: Map<string, JxMutableNode> = new Map();

export function invalidateLayoutCache() {
  layoutCache.clear();
}

/**
 * Determine the effective layout path for a document.
 *
 * @param {string | false | undefined} docLayout - The document's $layout value (string path, false,
 *   or undefined)
 * @returns {string | null} The layout path, or null if no layout applies
 */
export function getEffectiveLayoutPath(docLayout: string | false | undefined) {
  if (docLayout === false) return null;
  const defaultLayout = projectState?.projectConfig?.defaults?.layout;
  return docLayout || defaultLayout || null;
}

/**
 * Resolve a layout document by path. Fetches and caches the parsed JSON.
 *
 * @param {string} layoutPath - Relative path to the layout file (e.g., "./layouts/base.json")
 * @returns {Promise<JxMutableNode | null>} The parsed layout document, or null on failure
 */
export async function resolveLayoutDoc(layoutPath: string) {
  const normalized = layoutPath.replace(/^\.\//, "");
  if (layoutCache.has(normalized))
    return structuredClone(layoutCache.get(normalized) as JxMutableNode);

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
 * @param {JxMutableNode} layoutDoc - Deep-cloned layout document
 * @param {JxMutableNode} pageDoc - The page document
 * @returns {JxMutableNode} The merged document
 */
export function distributePageIntoLayout(layoutDoc: JxMutableNode, pageDoc: JxMutableNode) {
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
  node: JxMutableNode,
  named: Map<string, JxMutableNode[]>,
  defaults: (JxMutableNode | string)[],
) {
  if (!node || typeof node !== "object") return;
  if (!Array.isArray(node.children)) return;

  const newChildren: (JxMutableNode | string)[] = [];
  for (const child of node.children) {
    if (child && typeof child === "object" && child.tagName === "slot") {
      const slotName = child.attributes?.name;
      if (slotName && named.has(slotName)) {
        newChildren.push(...(named.get(slotName) as JxMutableNode[]));
        named.delete(slotName);
      } else if (!slotName && defaults.length > 0) {
        newChildren.push(...defaults);
      } else if (child.children) {
        newChildren.push(...child.children);
      }
    } else {
      if (typeof child !== "string") fillSlots(child, named, defaults);
      newChildren.push(child);
    }
  }
  node.children = newChildren as JxMutableNode[];
}

/**
 * Update the project's project.json with a partial patch and persist to disk.
 *
 * @param {Partial<ProjectConfig>} patch - Fields to merge into the current projectConfig
 */
export async function updateSiteConfig(patch: Partial<ProjectConfig>) {
  const platform = getPlatform();
  const config = {
    ...requireProjectState().projectConfig,
    ...patch,
  } as ProjectConfig;
  await platform.writeFile("project.json", JSON.stringify(config, null, 2));
  setProjectState({ ...requireProjectState(), projectConfig: config });
}
