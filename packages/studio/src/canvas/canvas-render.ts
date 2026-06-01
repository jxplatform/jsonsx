/**
 * Canvas render — extracted from studio.js (Phase 4o). Multi-mode canvas rendering orchestrator:
 * dispatches to manage/settings/source/edit/design/preview rendering paths.
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

import { canvasWrap, canvasPanels, updateCanvas } from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { loadMarkdown } from "../files/file-ops";
import { renderWelcome } from "../panels/welcome-screen";
import { projectState } from "../state";
import {
  canvasPanelTemplate,
  applyTransform,
  observeCenterUntilStable,
  renderZoomIndicator,
  resetZoomIndicator,
  updateActivePanelHeaders,
} from "./canvas-utils";
import { effectiveZoom, overlayBoxDescriptor } from "./canvas-helpers";
import {
  parseMediaEntries,
  activeBreakpointsForWidth,
  collectMediaOverrides,
  applyOverridesToCanvas,
} from "../utils/canvas-media";
import { getEffectiveMedia } from "../site-context";
import { renderCanvasLive } from "./canvas-live-render";
import { renderCanvasNode } from "../panels/preview-render";
import { registerPanelDnD } from "../panels/canvas-dnd";
import { registerPanelEvents } from "../panels/panel-events";
import { computeDocumentDiff } from "./canvas-diff";
import { updateForcedPseudoPreview } from "../panels/pseudo-preview";
import { findCanvasElement } from "./canvas-helpers";
import { enterComponentInlineEdit } from "../editor/component-inline-edit";
import { renderStylebookMode, refreshStylebookStyles } from "../panels/stylebook-panel";
import { dismissLinkPopover, dismissBlockActionBar } from "../panels/block-action-bar";
import { dismissContextMenu } from "../editor/context-menu";
import { dismissSlashMenu } from "../editor/slash-menu";
import { renderFunctionEditor } from "../panels/editors";
import { mediaDisplayName } from "../panels/shared";
import { statusMessage } from "../panels/statusbar";
import * as overlaysPanel from "../panels/overlays";

import type { CanvasPanel } from "../panels/canvas-dnd";

export interface GitDiffState {
  filePath: string;
  originalContent: string;
  currentContent: string;
  isMarkdown: boolean;
  fileStatus: string;
  originalDoc?: JxMutableNode | null;
  currentDoc?: JxMutableNode | null;
  original?: JxMutableNode | null;
}

interface CanvasRenderCtx {
  getCanvasMode: () => string;
  setCanvasMode: (mode: string) => void;
  openFileFromTree: (path: string) => void;
  exportFile: () => void;
  closeFunctionEditor: () => void;
  gitDiffState: GitDiffState | null;
  setGitDiffState: (state: GitDiffState | null) => void;
}

let _ctx: CanvasRenderCtx | null = null;

let _prevStylebookFilter = "";
let _prevStylebookCustomizedOnly = false;

/**
 * Initialize the canvas render module.
 *
 * @param {CanvasRenderCtx} ctx
 */
export function initCanvasRender(ctx: CanvasRenderCtx) {
  _ctx = ctx;
}

export function renderCanvas() {
  const tab = activeTab.value;
  if (!tab) {
    if (!projectState) {
      renderWelcome(canvasWrap);
    } else {
      canvasWrap.textContent = "";
    }
    return;
  }
  const ctx = _ctx as CanvasRenderCtx;
  const S = { document: tab.doc.document, ui: tab.session.ui, mode: tab.doc.mode };
  const canvasMode = ctx.getCanvasMode();

  // Advance render generation so stale async renders from the previous cycle bail out
  ++view.renderGeneration;

  // Detect whether this is a mode transition or a content-only re-render
  const modeChanged = canvasMode !== view.prevCanvasMode;

  // Only clear Lit's internal state on mode transitions (structural panel changes).
  // For content re-renders in the same mode, Lit's template diffing preserves
  // the panel structure. Bailed async renders can't corrupt the DOM because
  // renderCanvasLive uses atomic clear (innerHTML = "" right before appendChild).
  // @ts-ignore
  if (modeChanged && canvasWrap["_$litPart$"]) {
    canvasWrap.textContent = "";
    // @ts-ignore
    delete canvasWrap["_$litPart$"];
  }

  // Function editor mode: editing a function body in Monaco (JS)
  if (S.ui.editingFunction) {
    renderFunctionEditor(ctx.closeFunctionEditor);
    return;
  }

  // Dispose function editor if switching away
  if (view.functionEditor) {
    view.functionEditor.dispose();
    view.functionEditor = null;
  }

  // Source mode: update existing Monaco editor without recreating
  if (canvasMode === "source" && view.monacoEditor) {
    const filePath = tab.documentPath || "document.json";
    const isJs = filePath.endsWith(".js");
    const newVal = isJs ? S.document?.toString?.() || "" : JSON.stringify(S.document, null, 2);
    const currentVal = view.monacoEditor.getValue();
    if (currentVal !== newVal) {
      view.monacoEditor._ignoreNextChange = true;
      view.monacoEditor.setValue(newVal);
    }
    return;
  }

  // Stylebook fast-path: re-apply styles without rebuilding DOM
  if (canvasMode === "stylebook" && !modeChanged) {
    const curFilter = tab.session.ui.stylebookFilter || "";
    const curCustomized = !!tab.session.ui.stylebookCustomizedOnly;
    const filterChanged =
      curFilter !== _prevStylebookFilter || curCustomized !== _prevStylebookCustomizedOnly;
    if (!filterChanged) {
      refreshStylebookStyles();
      return;
    }
  }

  // Detect whether this is a mode transition or a content-only re-render
  view.prevCanvasMode = canvasMode;

  // DnD handlers are registered on inner canvas elements that get replaced on every
  // content render, so always clean them up.
  for (const fn of view.canvasDndCleanups) fn();
  view.canvasDndCleanups = [];

  // Panel event handlers (click, dblclick, etc.) capture closures over panel references.
  // Always re-register to keep closures fresh across document switches.
  for (const fn of view.canvasEventCleanups) fn();
  view.canvasEventCleanups = [];

  // Panel JS objects are cheap — always clear and repopulate from templates.
  // The actual DOM elements are preserved by Lit's diffing on content-only re-renders.
  canvasPanels.length = 0;

  if (modeChanged) {
    // Full teardown on mode transitions — new panel structure needed
    if (view.centerObserver) {
      view.centerObserver.disconnect();
      view.centerObserver = null;
    }

    // Dispose Monaco editor if switching away from source mode
    if (view.monacoEditor) {
      view.monacoEditor.getModel()?.dispose();
      view.monacoEditor.dispose();
      view.monacoEditor = null;
    }

    litRender(nothing, canvasWrap);
    view.panzoomWrap = null;
    // Reset inline style overrides from other modes
    canvasWrap.style.padding = "";
    canvasWrap.style.alignItems = "";
    canvasWrap.style.flexDirection = "";
    canvasWrap.style.display = "";
    canvasWrap.style.overflow = "";
    canvasWrap.style.overflow = "";

    // Clear zoom indicator (only re-rendered by design/preview/stylebook)
    resetZoomIndicator();

    // Dismiss open popovers/toolbars that are no longer relevant
    dismissBlockActionBar();
    dismissLinkPopover();
    dismissContextMenu();
    dismissSlashMenu();
  }

  // Stylebook mode: render element catalog with panzoom surface
  if (canvasMode === "stylebook") {
    _prevStylebookFilter = tab.session.ui.stylebookFilter || "";
    _prevStylebookCustomizedOnly = !!tab.session.ui.stylebookCustomizedOnly;
    renderStylebookMode({
      canvasPanelTemplate,
      applyTransform,
      observeCenterUntilStable,
      renderZoomIndicator,
      updateActivePanelHeaders,
      overlayBoxDescriptor,
      effectiveZoom,
    });
    return;
  }

  // Source mode: create Monaco editor instead of canvas
  if (canvasMode === "source") {
    canvasWrap.style.padding = "0";
    canvasWrap.style.display = "block";
    let editorContainer: HTMLDivElement | null = null;
    litRender(
      html`<div class="source-wrap">
        <div class="source-toolbar">
          <sp-action-button size="s" @click=${ctx.exportFile}>
            <sp-icon-export slot="icon"></sp-icon-export>
            Export
          </sp-action-button>
        </div>
        <div
          class="source-editor"
          ${ref((el) => {
            if (el) editorContainer = el as HTMLDivElement;
          })}
        ></div>
      </div>`,
      canvasWrap,
    );

    const filePath = tab.documentPath || "document.json";
    const lang = filePath.endsWith(".js") ? "javascript" : "json";
    const content =
      lang === "json" ? JSON.stringify(S.document, null, 2) : S.document?.toString?.() || "";
    const modelUri = monaco.Uri.parse("file:///" + filePath);
    const model = monaco.editor.createModel(content, lang, modelUri);
    view.monacoEditor = monaco.editor.create(editorContainer as unknown as HTMLElement, {
      model,
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      wordWrap: "on",
      tabSize: 2,
    });

    // Debounced sync back to state
    let debounce: ReturnType<typeof setTimeout> | undefined;
    view.monacoEditor.onDidChangeModelContent(() => {
      const editor = view.monacoEditor;
      if (!editor) return;
      if (editor._ignoreNextChange) {
        editor._ignoreNextChange = false;
        return;
      }
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const tab = activeTab.value;
        if (!tab) return;
        if (lang === "json") {
          try {
            tab.doc.document = JSON.parse(editor.getValue());
            tab.doc.dirty = true;
          } catch {
            // Invalid JSON — don't update state
          }
        } else {
          tab.doc.dirty = true;
        }
      }, 600);
    });
    return;
  }

  // Git diff mode — render original (left) and current (right) side-by-side on panzoom surface
  if (canvasMode === "git-diff") {
    if (!ctx.gitDiffState) {
      ctx.setCanvasMode("design");
      renderCanvas();
      return;
    }

    if (modeChanged) {
      canvasWrap.style.padding = "0";
      canvasWrap.style.overflow = "hidden";
    }

    const gitDiffState = ctx.gitDiffState;
    const panelWidth = 800;

    const { tpl: origTpl, panel: origPanel } = canvasPanelTemplate(
      "git-diff-original",
      "Original",
      false,
      panelWidth,
    );
    const { tpl: currTpl, panel: currPanel } = canvasPanelTemplate(
      "git-diff-current",
      "Current",
      false,
      panelWidth,
    );

    litRender(
      html`
        <div
          class="panzoom-wrap"
          style="transform-origin:0 0"
          ${ref((el) => {
            if (el) view.panzoomWrap = el as HTMLDivElement;
          })}
        >
          ${origTpl} ${currTpl}
        </div>
      `,
      canvasWrap,
    );

    canvasPanels.push(origPanel as unknown as CanvasPanel);
    canvasPanels.push(currPanel as unknown as CanvasPanel);

    /** @param {string} content */
    const parseContent = (content: string) => {
      if (gitDiffState.isMarkdown) {
        return loadMarkdown(content).then((r) => r.document);
      }
      return Promise.resolve().then(() => {
        try {
          return JSON.parse(content);
        } catch {
          return { tagName: "div", children: [{ tagName: "p", textContent: "Failed to parse" }] };
        }
      });
    };

    const featureToggles = S.ui.featureToggles;
    Promise.all([
      parseContent(gitDiffState.originalContent || ""),
      parseContent(gitDiffState.currentContent || ""),
    ]).then(([originalDoc, currentDoc]) => {
      renderCanvasIntoPanel(
        origPanel as unknown as CanvasPanel,
        new Set<string>(),
        featureToggles,
        originalDoc,
        gitDiffState,
      );
      renderCanvasIntoPanel(
        currPanel as unknown as CanvasPanel,
        new Set<string>(),
        featureToggles,
        currentDoc,
        gitDiffState,
      );
    });

    applyTransform();
    if (modeChanged) observeCenterUntilStable();
    renderZoomIndicator();
    return;
  }

  // Edit (content) mode — centered column, no panzoom, always 100%
  if (canvasMode === "edit") {
    if (modeChanged) {
      canvasWrap.style.padding = "0";
      canvasWrap.style.overflow = "hidden";

      // Remove zoom indicator left over from design/preview mode
      resetZoomIndicator();
    }

    const { baseWidth } = parseMediaEntries(getEffectiveMedia(S.document.$media));
    const { tpl: panelTpl, panel } = canvasPanelTemplate(null, null, true);
    const editTpl = html`
      <div
        class="content-edit-canvas"
        ${ref((el: Element | undefined) => {
          panel.scrollContainer = (el as HTMLElement) || null;
        })}
      >
        <div class="content-edit-column" style="max-width:${baseWidth}px">${panelTpl}</div>
      </div>
    `;
    litRender(editTpl, canvasWrap);
    canvasPanels.push(panel as unknown as CanvasPanel);
    renderCanvasIntoPanel(panel as unknown as CanvasPanel, new Set<string>(), S.ui.featureToggles);
    return;
  }

  // Normal canvas mode (design / preview) — set up panzoom surface
  if (modeChanged) {
    canvasWrap.style.padding = "0";
    canvasWrap.style.overflow = "hidden";
  }

  const {
    sizeBreakpoints,
    featureQueries: _featureQueries,
    baseWidth,
  } = parseMediaEntries(getEffectiveMedia(S.document.$media));
  const hasMedia = sizeBreakpoints.length > 0;
  const featureToggles = S.ui.featureToggles;

  // Create panzoom wrapper (the element that gets transformed)
  if (!hasMedia) {
    // Single panel — use baseWidth if a custom one is defined, otherwise full-width
    const effectiveMedia = getEffectiveMedia(S.document.$media);
    const hasBaseWidth = effectiveMedia && effectiveMedia["--"];
    const label = hasBaseWidth ? `${mediaDisplayName("--")} (${baseWidth}px)` : null;
    const { tpl: panelTpl, panel } = canvasPanelTemplate(
      hasBaseWidth ? "base" : null,
      label,
      !hasBaseWidth,
      hasBaseWidth ? baseWidth : undefined,
    );
    litRender(
      html`
        <div
          class="panzoom-wrap"
          style="transform-origin:0 0"
          ${ref((el) => {
            if (el) view.panzoomWrap = el as HTMLDivElement;
          })}
        >
          ${panelTpl}
        </div>
      `,
      canvasWrap,
    );
    canvasPanels.push(panel as unknown as CanvasPanel);
    renderCanvasIntoPanel(panel as unknown as CanvasPanel, new Set<string>(), featureToggles);
    applyTransform();
    if (modeChanged) {
      observeCenterUntilStable();
    }
    renderZoomIndicator();
    return;
  }

  // Build all panels: base first, then breakpoints in declared order (ascending for min-width,
  // descending for max-width — matching the direction of the design's media queries).
  const allPanelDefs = [
    {
      name: "base",
      displayName: mediaDisplayName("--"),
      width: baseWidth,
      activeSet: activeBreakpointsForWidth(sizeBreakpoints, baseWidth),
    },
  ];
  for (const bp of sizeBreakpoints) {
    allPanelDefs.push({
      name: bp.name,
      displayName: mediaDisplayName(bp.name),
      width: bp.width,
      activeSet: activeBreakpointsForWidth(sizeBreakpoints, bp.width),
    });
  }

  const panelEntries = allPanelDefs.map((def) => {
    const label = `${def.displayName} (${def.width}px)`;
    const { tpl, panel } = canvasPanelTemplate(def.name, label, false, def.width);
    return { tpl, panel, activeSet: def.activeSet };
  });

  litRender(
    html`
      <div
        class="panzoom-wrap"
        style="transform-origin:0 0"
        ${ref((el) => {
          if (el) view.panzoomWrap = el as HTMLDivElement;
        })}
      >
        ${panelEntries.map((e) => e.tpl)}
      </div>
    `,
    canvasWrap,
  );

  for (const { panel, activeSet } of panelEntries) {
    const p = panel as CanvasPanel;
    canvasPanels.push(p);
    renderCanvasIntoPanel(p, activeSet, featureToggles);
  }

  // Highlight active panel header
  updateActivePanelHeaders();

  // Apply current zoom + pan transform
  applyTransform();
  if (modeChanged) {
    observeCenterUntilStable();
  }

  // Floating zoom indicator
  renderZoomIndicator();
}

/**
 * Render document into a single canvas panel. Tries runtime rendering first, falls back to
 * structural preview.
 *
 * @param {CanvasPanel} panel
 * @param {Set<string>} activeBreakpoints
 * @param {Record<string, boolean>} featureToggles
 * @param {JxMutableNode | null} [docOverride] - Optional document to render (for diff mode). Uses
 *   active tab doc if not provided.
 * @param {GitDiffState | null} [gitDiffState] - Optional diff state. If provided, computes and
 *   applies diff highlighting.
 */
function renderCanvasIntoPanel(
  panel: CanvasPanel,
  activeBreakpoints: Set<string>,
  featureToggles: Record<string, boolean>,
  docOverride: JxMutableNode | null = null,
  gitDiffState: GitDiffState | null = null,
) {
  const gen = view.renderGeneration;
  const tab = activeTab.value;
  const docToRender = docOverride || (tab?.doc.document as JxMutableNode);
  const canvas = panel.canvas as HTMLElement;

  renderCanvasLive(gen, docToRender, canvas)
    .then((scope: Record<string, unknown> | null) => {
      // Skip post-render setup if a newer render has started
      if (gen !== view.renderGeneration) return;
      if (scope) {
        updateCanvas({ status: "ready", scope, error: null });
        applyCanvasMediaOverrides(canvas, activeBreakpoints);
        statusMessage("Runtime render OK", 1500);

        // Apply diff highlighting if in git-diff mode
        if (gitDiffState && docOverride) {
          // Determine which document is original and which is current
          const isOriginal = docOverride === (gitDiffState.originalDoc || gitDiffState.original);
          const _tab = activeTab.value;
          const origDoc = isOriginal ? docOverride : gitDiffState.currentDoc || _tab?.doc.document;
          const currDoc = isOriginal ? gitDiffState.currentDoc || _tab?.doc.document : docOverride;

          const { byPath: diffMap } = computeDocumentDiff(origDoc, currDoc);

          // Can't iterate WeakMap, so apply styling by walking the canvas
          const { elToPath } = scope;
          if (elToPath instanceof WeakMap) {
            applyDiffHighlightToCanvas(canvas, diffMap);
          }
        }
      } else {
        // Fallback to structural preview
        updateCanvas({ status: "ready", scope: null, error: null });
        canvas.innerHTML = "";
        renderCanvasNode(docToRender, [], canvas, activeBreakpoints, featureToggles);
      }
      try {
        registerPanelDnD(panel as unknown as CanvasPanel);
      } catch (e) {
        console.warn("registerPanelDnD failed:", (e as Error).message);
      }
      registerPanelEvents(panel as unknown as CanvasPanel);
      renderOverlays();
      updateForcedPseudoPreview();

      // Process pending inline edit when canvas becomes ready
      const currentTab = activeTab.value;
      if (currentTab?.session.ui?.pendingInlineEdit) {
        const { path, mediaName: mn } = currentTab.session.ui.pendingInlineEdit as InlineEditDef;
        currentTab.session.ui.pendingInlineEdit = null;
        const targetPanel = canvasPanels.find((p) => p.mediaName === mn) || canvasPanels[0];
        if (targetPanel) {
          const el = findCanvasElement(path, targetPanel.canvas);
          if (el) enterComponentInlineEdit(el, path);
        }
      }
    })
    .catch((err: unknown) => {
      if (gen !== view.renderGeneration) return;
      console.warn("renderCanvasLive rejected:", err instanceof Error ? err.message : err);
      updateCanvas({ status: "ready", scope: null, error: null });
      canvas.innerHTML = "";
      renderCanvasNode(docToRender, [], canvas, activeBreakpoints, featureToggles);
      try {
        registerPanelDnD(panel as unknown as CanvasPanel);
      } catch (e) {
        console.warn("registerPanelDnD failed:", (e as Error).message);
      }
      registerPanelEvents(panel as unknown as CanvasPanel);
      renderOverlays();
      updateForcedPseudoPreview();
    });
}

/**
 * Apply diff highlighting to canvas elements based on elToPath mapping. Walks the canvas DOM and
 * applies classes based on diff status.
 *
 * @param {HTMLElement} canvas
 * @param {Map<string, "added" | "removed" | "modified">} diffMap
 */
function applyDiffHighlightToCanvas(
  canvas: HTMLElement,
  diffMap: Map<string, "added" | "removed" | "modified">,
) {
  if (!diffMap || diffMap.size === 0) return;

  // Walk all elements in canvas and check their data attributes or other markers
  const walkCanvas = (el: HTMLElement, /** @type {string} */ path = "") => {
    const pathKey = path || "/";

    if (diffMap.has(pathKey)) {
      const status = diffMap.get(pathKey);
      if (status === "added") el.classList.add("element-diff-added");
      else if (status === "removed") el.classList.add("element-diff-removed");
      else if (status === "modified") el.classList.add("element-diff-modified");
    }

    // Check for child elements (heuristic: children array markers)
    let childIdx = 0;
    for (const child of el.children) {
      const childPath =
        pathKey === "/" ? `children/${childIdx}` : `${pathKey}/children/${childIdx}`;
      walkCanvas(child as HTMLElement, childPath);
      childIdx++;
    }
  };

  walkCanvas(canvas, "");
}

/**
 * Apply media query overrides as inline styles on matching canvas elements. Needed because the
 * runtime renders base styles as inline — @media CSS rules in the injected stylesheet can't win
 * against inline specificity.
 *
 * @param {Element} canvasEl
 * @param {Set<string>} activeBreakpoints
 */
function applyCanvasMediaOverrides(canvasEl: Element, activeBreakpoints: Set<string>) {
  if (!activeBreakpoints.size) return;
  const tab = activeTab.value;
  if (!tab) return;
  const docMedia = getEffectiveMedia(tab.doc.document.$media || {});
  // Build a set of CSS condition texts that match active breakpoints
  const activeConditions = new Set<string>();
  for (const name of activeBreakpoints) {
    if (docMedia[name]) activeConditions.add(docMedia[name]);
  }
  const overrides = collectMediaOverrides(document.styleSheets, activeConditions);
  applyOverridesToCanvas(canvasEl, overrides);
}

export function renderOverlays() {
  overlaysPanel.render();
}
