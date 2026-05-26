/**
 * Canvas render — extracted from studio.js (Phase 4o). Multi-mode canvas rendering orchestrator:
 * dispatches to manage/settings/source/edit/design/preview rendering paths.
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

import { canvasWrap, canvasPanels, updateCanvas } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { view } from "../view.js";
import { loadMarkdown } from "../files/file-ops.js";
import {
  canvasPanelTemplate,
  applyTransform,
  observeCenterUntilStable,
  renderZoomIndicator,
  resetZoomIndicator,
  updateActivePanelHeaders,
} from "./canvas-utils.js";
import { effectiveZoom, overlayBoxDescriptor } from "./canvas-helpers.js";
import {
  parseMediaEntries,
  activeBreakpointsForWidth,
  collectMediaOverrides,
  applyOverridesToCanvas,
} from "../utils/canvas-media.js";
import { getEffectiveMedia } from "../site-context.js";
import { renderCanvasLive } from "./canvas-live-render.js";
import { renderCanvasNode } from "../panels/preview-render.js";
import { registerPanelDnD } from "../panels/canvas-dnd.js";
import { registerPanelEvents } from "../panels/panel-events.js";
import { computeDocumentDiff } from "./canvas-diff.js";
import { updateForcedPseudoPreview } from "../panels/pseudo-preview.js";
import { findCanvasElement } from "./canvas-helpers.js";
import { enterComponentInlineEdit } from "../editor/component-inline-edit.js";
import { renderStylebookMode, refreshStylebookStyles } from "../panels/stylebook-panel.js";
import { dismissLinkPopover, dismissBlockActionBar } from "../panels/block-action-bar.js";
import { dismissContextMenu } from "../editor/context-menu.js";
import { dismissSlashMenu } from "../editor/slash-menu.js";
import { renderFunctionEditor } from "../panels/editors.js";
import { mediaDisplayName } from "../panels/shared.js";
import { statusMessage } from "../panels/statusbar.js";
import * as overlaysPanel from "../panels/overlays.js";

/** @typedef {import("../panels/canvas-dnd.js").CanvasPanel} CanvasPanel */

/**
 * @typedef {{
 *   filePath: string;
 *   originalContent: string;
 *   currentContent: string;
 *   isMarkdown: boolean;
 *   fileStatus: string;
 *   originalDoc?: JxMutableNode | null;
 *   currentDoc?: JxMutableNode | null;
 *   original?: JxMutableNode | null;
 * }} GitDiffState
 */

/**
 * @typedef {{
 *   getCanvasMode: () => string;
 *   setCanvasMode: (mode: string) => void;
 *   openFileFromTree: (path: string) => void;
 *   exportFile: () => void;
 *   closeFunctionEditor: () => void;
 *   gitDiffState: GitDiffState | null;
 *   setGitDiffState: (state: GitDiffState | null) => void;
 * }} CanvasRenderCtx
 */

/** @type {CanvasRenderCtx | null} */
let _ctx = null;

let _prevStylebookFilter = "";
let _prevStylebookCustomizedOnly = false;

/**
 * Initialize the canvas render module.
 *
 * @param {CanvasRenderCtx} ctx
 */
export function initCanvasRender(ctx) {
  _ctx = ctx;
}

export function renderCanvas() {
  const tab = activeTab.value;
  if (!tab) return;
  const ctx = /** @type {CanvasRenderCtx} */ (_ctx);
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
    /** @type {HTMLDivElement | null} */
    let editorContainer = null;
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
            if (el) editorContainer = /** @type {HTMLDivElement} */ (el);
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
    view.monacoEditor = monaco.editor.create(
      /** @type {HTMLElement} */ (/** @type {unknown} */ (editorContainer)),
      {
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
      },
    );

    // Debounced sync back to state
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let debounce;
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
            if (el) view.panzoomWrap = /** @type {HTMLDivElement} */ (el);
          })}
        >
          ${origTpl} ${currTpl}
        </div>
      `,
      canvasWrap,
    );

    canvasPanels.push(/** @type {any} */ (origPanel));
    canvasPanels.push(/** @type {any} */ (currPanel));

    /** @param {string} content */
    const parseContent = (content) => {
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
        /** @type {any} */ (origPanel),
        new Set(),
        featureToggles,
        originalDoc,
        gitDiffState,
      );
      renderCanvasIntoPanel(
        /** @type {any} */ (currPanel),
        new Set(),
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
        ${ref((el) => {
          panel.scrollContainer = /** @type {HTMLElement | null} */ (el || null);
        })}
      >
        <div class="content-edit-column" style="max-width:${baseWidth}px">${panelTpl}</div>
      </div>
    `;
    litRender(editTpl, canvasWrap);
    canvasPanels.push(/** @type {any} */ (panel));
    renderCanvasIntoPanel(/** @type {any} */ (panel), new Set(), S.ui.featureToggles);
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
            if (el) view.panzoomWrap = /** @type {HTMLDivElement} */ (el);
          })}
        >
          ${panelTpl}
        </div>
      `,
      canvasWrap,
    );
    canvasPanels.push(/** @type {any} */ (panel));
    renderCanvasIntoPanel(/** @type {any} */ (panel), new Set(), featureToggles);
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
          if (el) view.panzoomWrap = /** @type {HTMLDivElement} */ (el);
        })}
      >
        ${panelEntries.map((e) => e.tpl)}
      </div>
    `,
    canvasWrap,
  );

  for (const { panel, activeSet } of panelEntries) {
    const p = /** @type {CanvasPanel} */ (panel);
    canvasPanels.push(/** @type {any} */ (p));
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
  panel,
  activeBreakpoints,
  featureToggles,
  docOverride = null,
  gitDiffState = null,
) {
  const gen = view.renderGeneration;
  const tab = activeTab.value;
  const docToRender = /** @type {JxMutableNode} */ (docOverride || tab?.doc.document);
  const canvas = /** @type {HTMLElement} */ (panel.canvas);

  renderCanvasLive(gen, docToRender, canvas)
    .then((/** @type {Record<string, unknown> | null} */ scope) => {
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
        registerPanelDnD(/** @type {any} */ (panel));
      } catch (/** @type {unknown} */ e) {
        console.warn("registerPanelDnD failed:", /** @type {Error} */ (e).message);
      }
      registerPanelEvents(/** @type {any} */ (panel));
      renderOverlays();
      updateForcedPseudoPreview();

      // Process pending inline edit when canvas becomes ready
      const currentTab = activeTab.value;
      if (currentTab?.session.ui?.pendingInlineEdit) {
        const { path, mediaName: mn } = /** @type {{ path: JxPath; mediaName: string }} */ (
          currentTab.session.ui.pendingInlineEdit
        );
        currentTab.session.ui.pendingInlineEdit = null;
        const targetPanel =
          canvasPanels.find((/** @type {any} */ p) => p.mediaName === mn) || canvasPanels[0];
        if (targetPanel) {
          const el = findCanvasElement(path, targetPanel.canvas);
          if (el) enterComponentInlineEdit(el, path);
        }
      }
    })
    .catch((/** @type {unknown} */ err) => {
      if (gen !== view.renderGeneration) return;
      console.warn("renderCanvasLive rejected:", err instanceof Error ? err.message : err);
      updateCanvas({ status: "ready", scope: null, error: null });
      canvas.innerHTML = "";
      renderCanvasNode(docToRender, [], canvas, activeBreakpoints, featureToggles);
      try {
        registerPanelDnD(/** @type {any} */ (panel));
      } catch (/** @type {unknown} */ e) {
        console.warn("registerPanelDnD failed:", /** @type {Error} */ (e).message);
      }
      registerPanelEvents(/** @type {any} */ (panel));
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
function applyDiffHighlightToCanvas(canvas, diffMap) {
  if (!diffMap || diffMap.size === 0) return;

  // Walk all elements in canvas and check their data attributes or other markers
  const walkCanvas = (/** @type {HTMLElement} */ el, /** @type {string} */ path = "") => {
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
      walkCanvas(/** @type {HTMLElement} */ (child), childPath);
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
function applyCanvasMediaOverrides(canvasEl, activeBreakpoints) {
  if (!activeBreakpoints.size) return;
  const tab = activeTab.value;
  if (!tab) return;
  const docMedia = getEffectiveMedia(tab.doc.document.$media || {});
  const validBreakpoints = new Set();
  for (const name of activeBreakpoints) {
    if (docMedia[name]) validBreakpoints.add(name);
  }
  const overrides = collectMediaOverrides(document.styleSheets, validBreakpoints);
  applyOverridesToCanvas(canvasEl, overrides);
}

export function renderOverlays() {
  overlaysPanel.render();
}
