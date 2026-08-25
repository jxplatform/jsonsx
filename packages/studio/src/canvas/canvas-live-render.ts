/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Canvas live render — extracted from studio.js (Phase 4p). Async runtime rendering pipeline that
 * builds live canvas DOM using @jxsuite/runtime. Handles element registration, scope building, path
 * mapping ($map remapping), site-level style injection, and $head element injection.
 */

import { projectState, stripEventHandlers } from "../store";
import { displayTagName } from "@jxsuite/schema/guards";
import { canvasModeOfTab } from "./canvas-surface";
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
import { documentBase } from "./canvas-origin";
import { componentRegistry, computeRelativePath } from "../files/components";
import { prepareForEditMode } from "../utils/edit-display";
import {
  paramBoundStateKeys,
  resolveParamBoundState,
  substitutePreviewParams,
} from "../page-params";
import { isComponentDoc, substitutePreviewProps } from "../component-props";
import { assetContextFor, rewriteAssetRefs } from "./asset-refs";

import type { JxElement, JxMutableNode, JxPath } from "@jxsuite/schema/types";
import type { ComponentEntry } from "../files/components.js";
import type { LayoutMarker } from "./path-mapping";
import type { Tab } from "../tabs/tab";
import type { WireMapperCtx } from "./iframe-protocol";

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
 * Recursively mark every node of a layout doc tree with its ORIGIN — `$__layout: { file, path }` —
 * so the renderer can both tell layout nodes apart from page content and say which node of which
 * file each one is. The marker used to be a bare `true`, which made a layout node identifiable but
 * unaddressable: the canvas could tell you had clicked something it could not edit, but not what
 * you had clicked or where to go to edit it. `path` is the node's own path inside `file`, so the
 * editor can open the layout with that node selected. See {@link LayoutMarker}.
 */
export function markLayoutNodes(node: JxMutableNode, file: string, path: JxPath = []) {
  if (!node || typeof node !== "object") {
    return;
  }
  node.$__layout = { file, path } satisfies LayoutMarker;
  if (Array.isArray(node.children)) {
    for (const [i, child] of node.children.entries()) {
      if (typeof child === "string") {
        continue;
      }
      markLayoutNodes(child, file, [...path, "children", i]);
    }
  }
  if (Array.isArray(node.$elements)) {
    for (const [i, el] of node.$elements.entries()) {
      if (typeof el !== "string") {
        markLayoutNodes(el as JxMutableNode, file, [...path, "$elements", i]);
      }
    }
  }
}

/**
 * Resolve a document into the form the iframe canvas renders: layout-distributed, edit-transformed,
 * with components/imports/$media/$head merged in, plus the path-mapper context and site style. This
 * is the "parent resolves, iframe renders" split — the realm-specific work (defineElement,
 * injecting $head/site-style into the DOM, buildScope/renderNode) happens inside the iframe from
 * this result.
 *
 * **`tab` is the tab the render is FOR, and it is a parameter because it is not "the active tab".**
 * This function opened with `const tab = activeTab.value` and took its mode from an injected
 * `getCanvasMode()` — the focused pane's, one layer down — which threw away everything the caller
 * had already resolved correctly: `canvas-render.ts` picks the document with
 * `tabOfPane(surface.paneId)` and threads that tab's id through `mountIframeCanvas` →
 * `preparePassRender`. Six values came from the wrong tab whenever the pane being drawn was not the
 * focused one: `documentPath` (hence `docBase` and the `isPage` test), `showLayout`,
 * `previewParams`, `previewProps`, and the composed `canvasMode`.
 *
 * The mode is the one with teeth. `mountIframeCanvas` ends with `setHostPreview(state, message.mode
 * === "preview")`, so a side pane in Edit whose neighbour was in Preview got a PREVIEW frame — no
 * overlay, no editing messages honoured — and a pane being previewed beside an editing one got an
 * editable frame for a document nobody was editing. `canvasModeOfTab(tab)` is the same composition
 * every other gate reads, applied to the tab that is actually being drawn.
 *
 * @param {JxMutableNode} doc
 * @param {Tab | null} tab — the tab whose document and view settings this render is of.
 */
export async function resolveCanvasDocument(
  doc: JxMutableNode,
  tab: Tab | null,
): Promise<{
  renderDoc: JxMutableNode;
  docBase: string | undefined;
  mapperCtx: WireMapperCtx;
  siteStyle: Record<string, unknown> | null;
}> {
  const S = { documentPath: tab?.documentPath, mode: tab?.doc.mode };
  const canvasMode = canvasModeOfTab(tab);

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
        // The SAME normalization resolveLayoutDoc reads the file with, so the marker's `file` is a
        // Path the editor can hand straight to navigateToComponent when the author asks to open it.
        markLayoutNodes(layoutDoc, layoutPath.replace(/^\.\//, ""));
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

  const docBase = S.documentPath
    ? new URL(S.documentPath, documentBase(projectState?.projectRoot)).href
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

  // Component definition docs (non-page): seed chosen test-prop values into the render doc's state
  // So a non-instantiated component previews with real data — templates, dataScope snapshots, and
  // Live/snapshot expression previews all see the values (M6, the previewParams mirror). Pure
  // Rebuild for the same reason as substitutePreviewParams above.
  if (!isPage && tab && isComponentDoc(renderDoc)) {
    const { previewProps } = tab.session.ui;
    if (previewProps && Object.keys(previewProps).length > 0) {
      renderDoc = substitutePreviewProps(renderDoc, previewProps);
    }
  }

  // A content entry references its media relative to ITSELF; the built site serves those files from
  // The content type's asset mount. Studio opens the entry standalone, so the collection loader that
  // Normally performs that mapping never runs — do it here, on the RENDER doc only, so the canvas
  // Previews the URL production serves while the source doc keeps the authored relative ref.
  renderDoc = rewriteAssetRefs(renderDoc, assetContextFor(S.documentPath));

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
        tags.add(displayTagName(node.tagName));
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
