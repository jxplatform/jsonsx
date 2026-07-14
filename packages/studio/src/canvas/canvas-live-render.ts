/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Canvas live render — extracted from studio.js (Phase 4p). Async runtime rendering pipeline that
 * builds live canvas DOM using @jxsuite/runtime. Handles element registration, scope building, path
 * mapping ($map remapping), site-level style injection, and $head element injection.
 */

import { projectState, stripEventHandlers } from "../store";
import { activeTab } from "../workspace/workspace";
import { toRaw } from "../reactivity";
import {
  distributePageIntoLayout,
  getEffectiveElements,
  getEffectiveHead,
  getEffectiveImports,
  getEffectiveLayoutPath,
  getEffectiveMedia,
  resolveLayoutDoc,
} from "../site-context";
import { canvasBaseOrigin } from "./canvas-origin";
import { componentRegistry, computeRelativePath } from "../files/components";
import { prepareForEditMode } from "../utils/edit-display";
import {
  paramBoundStateKeys,
  resolveParamBoundState,
  substitutePreviewParams,
} from "../page-params";

import type { JxElement, JxMutableNode } from "@jxsuite/schema/types";
import type { ComponentEntry } from "../files/components.js";
import type { WireMapperCtx } from "./iframe-protocol";

let _ctx: { getCanvasMode: () => string } | null = null;

/**
 * Walk the merged document tree to find where page children were distributed into the layout slot.
 * Returns the `prefix` path to the container whose children hold the page content (first container
 * with a non-$__layout child), plus the `offset` — the index of the first page-content child within
 * that container's children array. The offset is non-zero when the layout places sibling nodes
 * (e.g. a `<noscript>`) before the `<slot>`, which shifts every page child's render index relative
 * to its page-document index. The path mapper subtracts this offset so canvas paths line up with
 * the page document (and thus the layers panel).
 *
 * @param {JxMutableNode} node
 * @param {(string | number)[]} [path]
 * @returns {{ prefix: (string | number)[]; offset: number } | null}
 */
function findPageContentPrefix(
  node: JxMutableNode,
  path: (string | number)[] = [],
): { prefix: (string | number)[]; offset: number } | null {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (Array.isArray(node.children)) {
    const firstPageIdx = node.children.findIndex(
      (child) => child && typeof child === "object" && !child.$__layout,
    );
    if (firstPageIdx !== -1) {
      return { offset: firstPageIdx, prefix: [...path, "children"] };
    }
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child && typeof child === "object" && child.$__layout) {
        const found = findPageContentPrefix(child, [...path, "children", i]);
        if (found) {
          return found;
        }
      }
    }
  }
  return null;
}

/**
 * Recursively mark all nodes in a layout doc tree with $__layout: true so we can identify which
 * rendered DOM elements came from the layout vs page content.
 */
function markLayoutNodes(node: JxMutableNode) {
  if (!node || typeof node !== "object") {
    return;
  }
  node.$__layout = true;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (typeof child === "string") {
        continue;
      }
      markLayoutNodes(child);
    }
  }
  if (node.$elements) {
    for (const el of node.$elements) {
      if (typeof el !== "string") {
        markLayoutNodes(el as JxMutableNode);
      }
    }
  }
}

/**
 * Initialize the canvas live render module.
 *
 * @param {{
 *   getCanvasMode: () => string;
 * }} ctx
 */
export function initCanvasLiveRender(ctx: { getCanvasMode: () => string }) {
  _ctx = ctx;
}

/**
 * Resolve a document into the form the iframe canvas renders: layout-distributed, edit-transformed,
 * with components/imports/$media/$head merged in, plus the path-mapper context and site style. This
 * is the "parent resolves, iframe renders" split — the realm-specific work (defineElement,
 * injecting $head/site-style into the DOM, buildScope/renderNode) happens inside the iframe from
 * this result.
 */
export async function resolveCanvasDocument(doc: JxMutableNode): Promise<{
  renderDoc: JxMutableNode;
  docBase: string | undefined;
  mapperCtx: WireMapperCtx;
  siteStyle: Record<string, unknown> | null;
}> {
  const tab = activeTab.value;
  const S = { documentPath: tab?.documentPath, mode: tab?.doc.mode };
  const canvasMode = _ctx!.getCanvasMode();

  let renderDoc =
    canvasMode === "preview"
      ? structuredClone(toRaw(doc))
      : prepareForEditMode(stripEventHandlers(doc));

  let layoutWrapped = false;
  const isPage =
    S.documentPath &&
    projectState?.isSiteProject &&
    (S.documentPath.startsWith("pages/") || S.documentPath.startsWith("./pages/"));
  let pageContentPrefix: (string | number)[] | null = null;
  let pageContentOffset = 0;

  // Layout wrapping obeys the tab-bar's "show layout elements" toggle (default on); with it off,
  // The page renders alone — the unwrapped path is identical to a non-layout page.
  if (isPage && tab?.session.ui.showLayout !== false) {
    const layoutPath = getEffectiveLayoutPath(doc.$layout);
    if (layoutPath) {
      const layoutDoc = (await resolveLayoutDoc(layoutPath)) as JxMutableNode | null;
      if (layoutDoc) {
        markLayoutNodes(layoutDoc);
        const pageForSlots = canvasMode === "preview" ? structuredClone(toRaw(doc)) : renderDoc;
        const merged = distributePageIntoLayout(layoutDoc, pageForSlots);
        renderDoc =
          canvasMode === "preview" ? merged : prepareForEditMode(stripEventHandlers(merged));
        layoutWrapped = true;
        const pageContent = findPageContentPrefix(merged);
        pageContentPrefix = pageContent?.prefix ?? null;
        pageContentOffset = pageContent?.offset ?? 0;
      }
    }
  }

  const root = projectState?.projectRoot || "";
  const docPrefix = root ? `${root}/` : "";
  const docBase = S.documentPath
    ? `${canvasBaseOrigin()}/${docPrefix}${S.documentPath}`
    : undefined;

  // Substitute chosen dynamic route params ({$ref: "#/$params/x"} → literal), inject state.$page,
  // And bake the substituted class-prototype state entries via the backend resolver — in every
  // Mode, so ContentEntry state is real data for preview templates AND the design/edit data
  // Explorer. Pure rebuild: renderDoc shares node references with the tab's source document
  // (posted as shadowDoc), whose $refs must survive for editing/serialization.
  if (isPage && tab) {
    const { previewParams } = tab.session.ui;
    if (previewParams && Object.keys(previewParams).length > 0) {
      const boundKeys = paramBoundStateKeys(
        (doc as { state?: Record<string, unknown> }).state ?? null,
      );
      renderDoc = substitutePreviewParams(renderDoc, previewParams, S.documentPath);
      await resolveParamBoundState(renderDoc, boundKeys, docBase);
    }
  }

  const arrayPaths = new Set<string>();
  if (canvasMode === "design" || canvasMode === "edit") {
    (function findArrayPaths(node: JxMutableNode, path: (string | number)[]) {
      if (!node || typeof node !== "object") {
        return;
      }
      if ((node as unknown as { $prototype?: string }).$prototype === "Array") {
        arrayPaths.add(path.join("/"));
        const mapDef = (node as JxMutableNode).map;
        if (mapDef && typeof mapDef === "object") {
          findArrayPaths(mapDef, [...path, "map"]);
        }
        return;
      }
      if (Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          if (typeof child === "string") {
            continue;
          }
          findArrayPaths(child!, [...path, "children", i]);
        }
      } else if (
        node.children &&
        typeof node.children === "object" &&
        (node.children as unknown as { $prototype?: string }).$prototype === "Array"
      ) {
        findArrayPaths(node.children as JxMutableNode, [...path, "children"]);
      }
      if (node.$switch && node.cases) {
        for (const [k, v] of Object.entries(node.cases)) {
          findArrayPaths(v, [...path, "cases", k]);
        }
      }
    })(doc, []);
  }

  // Component auto-discovery (content mode, wrapped layout, or a layout opened on its own) —
  // Mirrors the legacy render path. A directly-opened layout is neither a page (so it never
  // Sets layoutWrapped) nor content mode (a plain .json file skips the mode-setting parse),
  // So it needs its own gate; scoping to layouts/ avoids the single-component-edit path, where
  // The doc's own root tag would otherwise inject a $ref to itself.
  const isLayoutDoc =
    S.documentPath != null &&
    (S.documentPath.startsWith("layouts/") || S.documentPath.startsWith("./layouts/"));
  const effectiveElements = getEffectiveElements(renderDoc.$elements as (JxElement | string)[]);
  if ((S.mode === "content" || layoutWrapped || isLayoutDoc) && componentRegistry.length > 0) {
    const existingRefs = new Set(
      effectiveElements.map((e: JxElement | string) => (typeof e === "string" ? e : e?.$ref)),
    );
    const collectTags = (node: JxMutableNode): Set<string> => {
      const tags = new Set<string>();
      if (!node || typeof node !== "object") {
        return tags;
      }
      if (node.tagName) {
        tags.add(node.tagName);
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          if (typeof child !== "string") {
            for (const t of collectTags(child)) {
              tags.add(t);
            }
          }
        }
      }
      return tags;
    };
    for (const tag of collectTags(renderDoc)) {
      const comp = componentRegistry.find((c: ComponentEntry) => c.tagName === tag);
      if (comp && comp.source !== "npm" && comp.path) {
        const relPath = computeRelativePath(S.documentPath ?? null, comp.path);
        if (!existingRefs.has(relPath)) {
          effectiveElements.push({ $ref: relPath });
          existingRefs.add(relPath);
        }
      }
    }
  }
  if (effectiveElements.length > 0) {
    renderDoc.$elements = effectiveElements as (string | JxMutableNode | { $ref: string })[];
  }
  renderDoc.imports = getEffectiveImports(renderDoc.imports);
  // The effective-media/head getters return the merged value or undefined. Optional properties
  // Cannot be assigned undefined under exactOptionalPropertyTypes, so clear them by deleting the key
  // When the getter yields nothing.
  const media = getEffectiveMedia(renderDoc.$media);
  if (media === undefined) {
    delete renderDoc.$media;
  } else {
    renderDoc.$media = media as NonNullable<JxMutableNode["$media"]>;
  }
  const head = getEffectiveHead(renderDoc.$head);
  if (head === undefined) {
    delete renderDoc.$head;
  } else {
    renderDoc.$head = head as NonNullable<JxMutableNode["$head"]>;
  }

  return {
    docBase,
    mapperCtx: {
      arrayPaths: [...arrayPaths],
      canvasMode,
      layoutWrapped,
      pageContentOffset,
      pageContentPrefix,
    },
    renderDoc,
    siteStyle: (projectState?.projectConfig?.style as Record<string, unknown>) ?? null,
  };
}
