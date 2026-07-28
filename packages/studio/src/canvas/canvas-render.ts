/// <reference lib="dom" />
/**
 * Canvas render — extracted from studio.js (Phase 4o). Multi-mode canvas rendering orchestrator:
 * dispatches to manage/settings/source/edit/design/preview rendering paths.
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import type * as monaco from "monaco-editor";
import { loadedMonaco, loadMonaco } from "../services/monaco-lazy";

import { canvasPanels, canvasWrap, updateCanvas } from "../store";
import { activeTab } from "../workspace/workspace";
import { collabSourceContext } from "../collab/collab-session";
import { attachCursorStyles } from "../collab/monaco-cursors";
import type { AwarenessLike } from "../collab/monaco-cursors";
import { view } from "../view";
import { parseSourceForPath, serializeDocument } from "../files/file-ops";
import { detachGridPanel, gridPanelMounted, renderGridMode } from "../grid/grid-panel";
import { formatByName, formatForPath } from "../format/format-host";
import { modelUriFor } from "../services/model-uri";
import { renderWelcome } from "../panels/welcome-screen";
import { projectState } from "../state";
import {
  applyEditZoom,
  applyTransform,
  canvasPanelTemplate,
  observeCenterUntilStable,
  updateActivePanelHeaders,
} from "./canvas-utils";
import { parseMediaEntries } from "../utils/canvas-media";
import { getEffectiveMedia, getEffectiveStyle } from "../site-context";
import {
  commitActiveEditSession,
  mountIframeCanvas,
  postStyleUpdateToStylebookHosts,
} from "./iframe-host";
import {
  canvasPerf,
  SPAN_FULL_RENDER,
  SPAN_MOUNT_CANVAS,
  timeSpan,
  timeSpanAsync,
} from "./canvas-perf";
import { renderStylebookMode } from "../panels/stylebook-panel";
import { transposeStylebookStyle } from "../panels/stylebook-doc";
import { dismissBlockActionBar, dismissLinkPopover } from "../panels/block-action-bar";
import { dismissContextMenu } from "../editor/context-menu";
import { dismissSlashMenu } from "../editor/slash-menu";
import { renderFunctionEditor } from "../panels/editors";
import { renderFormulaWorkspace } from "../panels/formula-workspace";
import { mediaDisplayName } from "../panels/shared";
import { statusMessage } from "../panels/statusbar";
import * as overlaysPanel from "../panels/overlays";

import type { CanvasPanel, GitDiffState } from "../types";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../tabs/tab.js";

interface CanvasRenderCtx {
  getCanvasMode: () => string;
  setCanvasMode: (mode: string) => void;
  openFileFromTree: (path: string) => void;
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

/** Monaco language for the source view of a tab's document. */
function sourceLang(tab: Tab) {
  const format = formatByName(tab.doc.sourceFormat);
  if (format) {
    return format.mediaType?.split("/").pop() ?? "plaintext";
  }
  return (tab.documentPath || "").endsWith(".js") ? "javascript" : "json";
}

/**
 * The full source text for the source view. Format-class files serialize to their on-disk form
 * (e.g. frontmatter YAML plus the body for markdown), not just the JSON of the body tree.
 */
async function sourceContent(tab: Tab, lang: string) {
  if (formatByName(tab.doc.sourceFormat)) {
    return serializeDocument(tab);
  }
  if (lang === "javascript") {
    return tab.doc.document?.toString?.() || "";
  }
  return JSON.stringify(tab.doc.document, null, 2);
}

// Single-RAF scheduling; concurrent schedule requests within the same frame are deduped.
//
/* Two nested rAFs used to make the canvas render "yield to higher-priority panel paints first".
   Panels have since grown their own rAF scheduler (see panel-scheduler.ts), so the second frame
   bought nothing and put a hard ~32 ms floor under every escalated edit — canvas-patcher's
   escalateToFullRender routes through here. */
let _canvasRafId = 0;
export function scheduleCanvasRender() {
  if (_canvasRafId) {
    return;
  }
  _canvasRafId = requestAnimationFrame(() => {
    _canvasRafId = 0;
    try {
      renderCanvas();
    } catch (error) {
      console.error("renderCanvas error:", error);
    }
  });
}

/**
 * Eject canvasWrap's DOM and Lit render part together. Setting textContent/innerHTML removes the
 * comment nodes Lit uses as a ChildPart's markers; if the private `_$litPart$` reference is left
 * behind, the next litRender() reuses a part whose markers are detached from the DOM and throws
 * "This `ChildPart` has no `parentNode`…". Always eject the markers through this helper so the two
 * operations can never drift apart.
 */
function hardClearCanvasWrap() {
  canvasWrap.textContent = "";
  // @ts-expect-error -- _$litPart$ is Lit's private render-part marker, not in the DOM types
  delete canvasWrap["_$litPart$"];
}

/**
 * Tear the canvas all the way back down to a pristine state. Invoked whenever there is no active
 * tab (e.g. every tab was closed) so the canvas can never get wedged in a half-initialized state:
 * open editors and observers are disposed, outgoing panel scopes stopped, pending cleanups run, the
 * Lit render part is ejected cleanly, inline style overrides reset, and `prevCanvasMode` cleared so
 * the very next render is treated as a fresh mode transition and rebuilds the surface from
 * scratch.
 */
/** Live source-mode collab binding teardown (unbind + release the canonical lock). */
let sourceCollabCleanup: (() => void) | null = null;

function disposeSourceCollab(): void {
  sourceCollabCleanup?.();
  sourceCollabCleanup = null;
}

/**
 * Bind the Monaco editor to the shared source text via y-monaco: two-way character-level sync plus
 * remote in-buffer cursors/selections (decorated per-client; colors injected from the presence
 * palette by {@link attachCursorStyles}). y-monaco/yjs evaluation defers behind the dynamic import
 * until a code view actually binds. Returns the teardown.
 */
async function createSourceCollabBinding(
  model: monaco.editor.ITextModel,
  editor: monaco.editor.IStandaloneCodeEditor,
  ctx: NonNullable<ReturnType<typeof collabSourceContext>>,
): Promise<() => void> {
  const { MonacoBinding } = await import("y-monaco");
  type YText = ConstructorParameters<typeof MonacoBinding>[0];
  type BindingAwareness = ConstructorParameters<typeof MonacoBinding>[3];
  const binding = new MonacoBinding(
    ctx.text as YText,
    model,
    new Set([editor]),
    ctx.awareness as BindingAwareness,
  );
  const detachStyles = attachCursorStyles(ctx.awareness as unknown as AwarenessLike, document);
  return () => {
    detachStyles();
    binding.destroy();
    ctx.leave();
  };
}

function resetCanvasView() {
  if (view.functionEditor) {
    view.functionEditor.dispose();
    view.functionEditor = null;
  }
  detachGridPanel();
  disposeSourceCollab();
  if (view.monacoEditor) {
    view.monacoEditor.getModel()?.dispose();
    view.monacoEditor.dispose();
    view.monacoEditor = null;
  }
  if (view.centerObserver) {
    view.centerObserver.disconnect();
    view.centerObserver = null;
  }
  for (const fn of view.canvasDndCleanups) {
    fn();
  }
  view.canvasDndCleanups = [];
  for (const fn of view.canvasEventCleanups) {
    fn();
  }
  view.canvasEventCleanups = [];
  for (const p of canvasPanels) {
    p.renderScope?.stop();
    p.renderScope = null;
  }
  canvasPanels.length = 0;

  hardClearCanvasWrap();

  view.panzoomWrap = null;
  canvasWrap.style.padding = "";
  canvasWrap.style.alignItems = "";
  canvasWrap.style.flexDirection = "";
  canvasWrap.style.display = "";
  canvasWrap.style.overflow = "";
  dismissBlockActionBar();
  dismissLinkPopover();
  dismissContextMenu();
  dismissSlashMenu();
  view.prevCanvasMode = null;
}

/**
 * Mount the source-mode Monaco editor into an already-rendered container.
 *
 * Async because Monaco is loaded on demand (see services/monaco-lazy). The container is in the DOM
 * before this runs, and every continuation below re-checks `view.monacoEditor`, so a teardown or a
 * mode switch while the module loads is handled the same way a teardown mid-y-monaco-load already
 * was.
 */
async function mountSourceEditor(
  tab: Tab,
  editorContainer: Element,
  filePath: string,
  lang: string,
): Promise<void> {
  const monaco = await loadMonaco();
  const modelUri = monaco.Uri.parse(modelUriFor(filePath));
  const model = monaco.editor.createModel("", lang, modelUri);
  // Co-edited tabs bind the buffer to the shared Y.Text instead of a local serialization: the
  // Canonical lock flips to "source", peers co-type character-level, and the source reconciler
  // Parses back into the structure tree for everyone's canvas.
  const collabCtx = collabSourceContext(tab);
  if (collabCtx) {
    void collabCtx
      .enter()
      .then(async () => {
        const editor = view.monacoEditor;
        if (!editor || editor.getModel() !== model) {
          return;
        }
        const cleanup = await createSourceCollabBinding(model, editor, collabCtx);
        // The editor may have been torn down while y-monaco loaded — unbind immediately.
        if (view.monacoEditor !== editor || editor.getModel() !== model) {
          cleanup();
          return;
        }
        sourceCollabCleanup = cleanup;
        if (collabCtx.readOnly) {
          editor.updateOptions({ readOnly: true });
        }
      })
      .catch(() => {
        // Binding failures degrade to a read-only-ish local buffer; the session stays live.
      });
  } else {
    sourceContent(tab, lang)
      .then((content) => {
        const editor = view.monacoEditor;
        if (editor && editor.getModel() === model) {
          editor._ignoreNextChange = true;
          model.setValue(content);
        }
      })
      .catch(() => {
        // Serialization unavailable — leave the buffer empty rather than crash the render
      });
  }
  view.monacoEditor = monaco.editor.create(editorContainer as unknown as HTMLElement, {
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace",
    fontSize: 12,
    lineNumbers: "on",
    minimap: { enabled: false },
    model,
    scrollBeyondLastLine: false,
    tabSize: 2,
    theme: "vs-dark",
    wordWrap: "on",
  });

  // Debounced sync back to state (solo tabs only: co-edited buffers flow through the shared
  // Y.Text and the source reconciler's parse mirror instead of a whole-doc replace).
  if (collabCtx) {
    return;
  }
  let debounce: ReturnType<typeof setTimeout> | undefined;
  view.monacoEditor.onDidChangeModelContent(() => {
    const editor = view.monacoEditor;
    if (!editor) {
      return;
    }
    if (editor._ignoreNextChange) {
      editor._ignoreNextChange = false;
      return;
    }
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const tabNow = activeTab.value;
      if (!tabNow) {
        return;
      }
      if (formatByName(tabNow.doc.sourceFormat) && tabNow.documentPath) {
        try {
          // Parse the full source back into body + frontmatter (title, $head, etc.).
          const { document, frontmatter } = await parseSourceForPath(
            tabNow.documentPath,
            editor.getValue(),
          );
          tabNow.doc.document = document as JxMutableNode;
          tabNow.doc.content.frontmatter = frontmatter;
          tabNow.doc.dirty = true;
        } catch {
          // Unparseable source — don't update state
        }
      } else if (lang === "json") {
        try {
          tabNow.doc.document = JSON.parse(editor.getValue()) as JxMutableNode;
          tabNow.doc.dirty = true;
        } catch {
          // Invalid JSON — don't update state
        }
      } else {
        tabNow.doc.dirty = true;
      }
    }, 600);
  });
}

/**
 * Render the canvas surface for the active tab. Thin timing wrapper — {@link renderCanvasImpl} has
 * several early returns, so the span is closed by {@link timeSpan}'s `finally` rather than by
 * hand.
 */
export function renderCanvas() {
  timeSpan(SPAN_FULL_RENDER, renderCanvasImpl);
}

function renderCanvasImpl() {
  const tab = activeTab.value;
  if (!tab) {
    // No active tab — reset every piece of canvas view state so reopening a file can never inherit
    // A stale Lit part, a dead Monaco editor, or a mismatched prevCanvasMode (the toxic states that
    // Previously left the canvas unrenderable until a full reload).
    resetCanvasView();
    // Nothing is open. A dev-server root that is only a workspace/monorepo (no project.json) still
    // Populates projectState, but it is not an open project — the file tree prompts to open one and
    // The canvas must keep showing the welcome screen rather than going blank.
    if (!projectState?.isSiteProject) {
      renderWelcome(canvasWrap);
    }
    return;
  }
  const ctx = _ctx as CanvasRenderCtx;
  const S = {
    document: tab.doc.document,
    mode: tab.doc.mode,
    ui: tab.session.ui,
  };
  // Base mode drives the host surface (panel structure, panzoom vs centered column). The preview
  // Toggle changes only what the iframe renders — resolveCanvasDocument reads the effective mode
  // Via its own getCanvasMode. Flipping the toggle therefore re-renders panels in place (no
  // ModeChanged teardown, no pan reset).
  const { canvasMode } = S.ui;

  // Advance render generation so stale async renders from the previous cycle bail out
  view.renderGeneration += 1;
  canvasPerf.fullRenders += 1;

  // Detect whether this is a mode transition or a content-only re-render
  const modeChanged = canvasMode !== view.prevCanvasMode;

  // Only clear Lit's internal state on mode transitions (structural panel changes).
  // For content re-renders in the same mode, Lit's template diffing preserves
  // The panel structure. Bailed async renders can't corrupt the DOM because
  // RenderCanvasLive uses atomic clear (innerHTML = "" right before appendChild).
  // @ts-expect-error -- _$litPart$ is Lit's private render-part marker, not in the DOM types
  if (modeChanged && canvasWrap["_$litPart$"]) {
    hardClearCanvasWrap();
  }

  // Function editor mode: editing a function body in Monaco (JS)
  if (S.ui.editingFunction) {
    renderFunctionEditor();
    return;
  }

  // Dispose function editor if switching away
  if (view.functionEditor) {
    view.functionEditor.dispose();
    view.functionEditor = null;
  }

  // Formula workspace mode: full-screen structured editing of an $expression (the function editor
  // Takes precedence when both targets are set).
  if (S.ui.editingFormula) {
    renderFormulaWorkspace();
    return;
  }

  /* Source mode across a TAB switch: the buffer swap below reuses the existing model, and a model
     carries the file identity Monaco validates against — its URI is what the JSON language service
     resolves a document's relative `$schema` against, and its language id picks the tokenizer. Reuse
     it for another file and `project.json` gets checked as though it sat in the previous tab's
     folder (`./project.schema.json` → `file:///pages/project.schema.json`, unregistered, back to
     "No schema request service available"). Tear down instead and let the creation path below build
     a model with the right URI. */
  const loadedForSourceSwap = canvasMode === "source" && view.monacoEditor ? loadedMonaco() : null;
  if (loadedForSourceSwap && view.monacoEditor) {
    const expectedUri = loadedForSourceSwap.Uri.parse(
      modelUriFor(tab.documentPath || "document.json"),
    );
    if (view.monacoEditor.getModel()?.uri.toString() !== expectedUri.toString()) {
      disposeSourceCollab();
      view.monacoEditor.getModel()?.dispose();
      view.monacoEditor.dispose();
      view.monacoEditor = null;
    }
  }

  // Source mode: update existing Monaco editor without recreating. Don't replace the buffer while
  // The user is actively typing in it — that would reformat under the cursor (the source view is
  // The editing surface here, mirroring the panel draft-state behaviour).
  if (canvasMode === "source" && view.monacoEditor) {
    const editor = view.monacoEditor;
    sourceContent(tab, sourceLang(tab))
      .then((newVal) => {
        if (view.monacoEditor !== editor) {
          return;
        }
        if (!editor.hasTextFocus() && editor.getValue() !== newVal) {
          editor._ignoreNextChange = true;
          editor.setValue(newVal);
        }
      })
      .catch(() => {
        // Serialization unavailable (e.g. format service unreachable) — keep the current buffer
      });
    return;
  }

  // Grid fast-path: the grid panel runs its own effect scope (toolbar + engine stay live), so a
  // Same-tab re-render while the panel is mounted needs nothing from the canvas pipeline.
  if (canvasMode === "grid" && gridPanelMounted(tab)) {
    return;
  }

  // Stylebook fast-path: a style edit re-applies IN PLACE via the bridge (the iframe re-runs the
  // Runtime's style applier on the specimen root — real @media, no re-render, no iframe reload).
  // Filter/Customized changes fall through to the full rebuild (they change which specimens exist),
  // As does a zero-host post (no stylebook iframe live yet).
  if (canvasMode === "stylebook" && !modeChanged) {
    const curFilter = tab.session.ui.stylebookFilter || "";
    const curCustomized = Boolean(tab.session.ui.stylebookCustomizedOnly);
    const filterChanged =
      curFilter !== _prevStylebookFilter || curCustomized !== _prevStylebookCustomizedOnly;
    if (!filterChanged) {
      const style = transposeStylebookStyle(getEffectiveStyle(tab.doc.document?.style));
      if (postStyleUpdateToStylebookHosts(style as Record<string, unknown>) > 0) {
        return;
      }
    }
  }

  // Detect whether this is a mode transition or a content-only re-render
  view.prevCanvasMode = canvasMode;

  // Best-effort commit of a live inline-edit session BEFORE lit rebuilds the panel DOM. Covers
  // Keyboard-driven tab switches / mode changes where no parent pointerdown preceded the render —
  // The endEdit posts ahead of the new render on the FIFO channel, so the resulting editCommit
  // Still routes to the tab the session belonged to (the host's tabId flips only on renderComplete).
  commitActiveEditSession();

  // DnD handlers are registered on inner canvas elements that get replaced on every
  // Content render, so always clean them up.
  for (const fn of view.canvasDndCleanups) {
    fn();
  }
  view.canvasDndCleanups = [];

  // Panel event handlers (click, dblclick, etc.) capture closures over panel references.
  // Always re-register to keep closures fresh across document switches.
  for (const fn of view.canvasEventCleanups) {
    fn();
  }
  view.canvasEventCleanups = [];

  // Panel JS objects are cheap — always clear and repopulate from templates.
  // The actual DOM elements are preserved by Lit's diffing on content-only re-renders.
  // Stop each outgoing panel's render effect scope (and its surgical-subtree child scopes)
  // So render-time reactive effects don't accumulate across renders.
  for (const p of canvasPanels) {
    p.renderScope?.stop();
    p.renderScope = null;
  }
  canvasPanels.length = 0;

  if (modeChanged) {
    // Full teardown on mode transitions — new panel structure needed
    if (view.centerObserver) {
      view.centerObserver.disconnect();
      view.centerObserver = null;
    }

    // Destroy the grid panel if switching away from grid mode
    detachGridPanel();

    // Dispose Monaco editor if switching away from source mode
    disposeSourceCollab();
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

    // Dismiss open popovers/toolbars that are no longer relevant
    dismissBlockActionBar();
    dismissLinkPopover();
    dismissContextMenu();
    dismissSlashMenu();
  }

  // Stylebook mode: render element catalog with panzoom surface
  if (canvasMode === "stylebook") {
    _prevStylebookFilter = tab.session.ui.stylebookFilter || "";
    _prevStylebookCustomizedOnly = Boolean(tab.session.ui.stylebookCustomizedOnly);
    renderStylebookMode({
      applyTransform,
      canvasPanelTemplate,
      observeCenterUntilStable,
      updateActivePanelHeaders,
    });
    return;
  }

  // Grid mode: spreadsheet editor over the tab's grid source (mirrors the Monaco/stylebook
  // Non-iframe-editor pattern; the panel owns its own reactivity from here).
  if (canvasMode === "grid") {
    canvasWrap.style.padding = "0";
    canvasWrap.style.display = "block";
    renderGridMode(canvasWrap, tab);
    return;
  }

  // Source mode: create Monaco editor instead of canvas
  if (canvasMode === "source") {
    canvasWrap.style.padding = "0";
    canvasWrap.style.display = "block";
    let editorContainer: HTMLDivElement | null = null;
    litRender(
      html`<div class="source-wrap">
        <div
          class="source-editor"
          ${ref((el) => {
            if (el) {
              editorContainer = el as HTMLDivElement;
            }
          })}
        ></div>
      </div>`,
      canvasWrap,
    );

    const filePath = tab.documentPath || "document.json";
    const lang = sourceLang(tab);
    void mountSourceEditor(tab, editorContainer as unknown as Element, filePath, lang);
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

    const { gitDiffState } = ctx;
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
            if (el) {
              view.panzoomWrap = el as HTMLDivElement;
            }
          })}
        >
          ${origTpl} ${currTpl}
        </div>
      `,
      canvasWrap,
    );

    canvasPanels.push(origPanel as unknown as CanvasPanel, currPanel as unknown as CanvasPanel);

    /** @param {string} content */
    const parseContent = (content: string): Promise<JxMutableNode> => {
      const fmtPath = gitDiffState.filePath ?? "";
      if (formatForPath(fmtPath)) {
        return parseSourceForPath(fmtPath, content).then((r) => r.document);
      }
      return Promise.resolve().then(() => {
        try {
          return JSON.parse(content) as JxMutableNode;
        } catch {
          return {
            children: [{ tagName: "p", textContent: "Failed to parse" }],
            tagName: "div",
          };
        }
      });
    };

    const { featureToggles } = S.ui;
    void Promise.all([
      parseContent(gitDiffState.originalContent || ""),
      parseContent(gitDiffState.currentContent || ""),
    ]).then(([originalDoc, currentDoc]) => {
      renderCanvasIntoPanel(
        origPanel as unknown as CanvasPanel,
        featureToggles,
        originalDoc,
        gitDiffState,
      );
      renderCanvasIntoPanel(
        currPanel as unknown as CanvasPanel,
        featureToggles,
        currentDoc,
        gitDiffState,
      );
    });

    applyTransform();
    if (modeChanged) {
      observeCenterUntilStable();
    }
    return;
  }

  // Edit (content) mode — centered column, no panzoom; `ui.editZoom` reflows content at the zoomed
  // Effective width while the on-screen footprint stays fixed (browser-page-zoom semantics).
  if (canvasMode === "edit") {
    if (modeChanged) {
      canvasWrap.style.padding = "0";
      canvasWrap.style.overflow = "hidden";
    }

    const { baseWidth } = parseMediaEntries(getEffectiveMedia(S.document.$media));
    const { tpl: panelTpl, panel } = canvasPanelTemplate(null, null, true);
    // A component-definition doc (root tag is a custom element) is a fragment, not a page: it should
    // Hug its content rather than have the column fill+stretch to the viewport (dead scroll space).
    const rootTag = (S.document as { tagName?: unknown }).tagName;
    const isComponentDoc = typeof rootTag === "string" && rootTag.includes("-");
    const columnClass = isComponentDoc ? "content-edit-column is-component" : "content-edit-column";
    const editTpl = html`
      <div
        class="content-edit-canvas"
        ${ref((el: Element | undefined) => {
          panel.scrollContainer = (el as HTMLElement) || null;
        })}
      >
        <div class=${columnClass} style="max-width:${baseWidth}px">${panelTpl}</div>
      </div>
    `;
    litRender(editTpl, canvasWrap);
    canvasPanels.push(panel as unknown as CanvasPanel);
    renderCanvasIntoPanel(panel as unknown as CanvasPanel, S.ui.featureToggles);
    // The column must exist in the DOM before the zoom's live width measurement — so the zoom is
    // Applied after the render rather than baked into the template (the panel mounts fluid and is
    // Immediately re-fitted; the iframe hasn't painted yet, so nothing visibly jumps).
    applyEditZoom();
    return;
  }

  // Design mode (also hosts preview-toggle renders) — set up panzoom surface
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
  const { featureToggles } = S.ui;

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
            if (el) {
              view.panzoomWrap = el as HTMLDivElement;
            }
          })}
        >
          ${panelTpl}
        </div>
      `,
      canvasWrap,
    );
    canvasPanels.push(panel as unknown as CanvasPanel);
    renderCanvasIntoPanel(panel as unknown as CanvasPanel, featureToggles);
    applyTransform();
    if (modeChanged) {
      observeCenterUntilStable();
    }
    return;
  }

  // Build all panels: base first, then breakpoints in declared order (ascending for min-width,
  // Descending for max-width — matching the direction of the design's media queries).
  const allPanelDefs = [
    {
      displayName: mediaDisplayName("--"),
      name: "base",
      width: baseWidth,
    },
  ];
  for (const bp of sizeBreakpoints) {
    allPanelDefs.push({
      displayName: mediaDisplayName(bp.name),
      name: bp.name,
      width: bp.width,
    });
  }

  const panelEntries = allPanelDefs.map((def) => {
    const label = `${def.displayName} (${def.width}px)`;
    const { tpl, panel } = canvasPanelTemplate(def.name, label, false, def.width);
    return { panel, tpl };
  });

  litRender(
    html`
      <div
        class="panzoom-wrap"
        style="transform-origin:0 0"
        ${ref((el) => {
          if (el) {
            view.panzoomWrap = el as HTMLDivElement;
          }
        })}
      >
        ${panelEntries.map((e) => e.tpl)}
      </div>
    `,
    canvasWrap,
  );

  for (let i = 0; i < panelEntries.length; i++) {
    const { panel } = panelEntries[i]!;
    const p = panel as CanvasPanel;
    canvasPanels.push(p);
    if (i === 0) {
      renderCanvasIntoPanel(p, featureToggles);
    } else {
      setTimeout(() => renderCanvasIntoPanel(p, featureToggles), 0);
    }
  }

  // Highlight active panel header
  updateActivePanelHeaders();

  // Apply current zoom + pan transform
  applyTransform();
  if (modeChanged) {
    observeCenterUntilStable();
  }
}

/**
 * Render a document into a single canvas panel via the iframe canvas: the document renders inside a
 * same-runtime iframe served from the real origin (the iframe holds the render context, stamps
 * `data-jx-path`/`data-jx-layout`, and draws its own overlays). Git-diff/preview overrides render
 * but stay un-patchable (`ready` only flips for the real tab document).
 *
 * @param {CanvasPanel} panel
 * @param {Record<string, boolean>} _featureToggles - Accepted for call-site symmetry (the iframe
 *   render needs no structural-preview fallback); unused.
 * @param {JxMutableNode | null} [docOverride] - Optional document to render (for diff mode). Uses
 *   active tab doc if not provided.
 * @param {GitDiffState | null} [_gitDiffState] - Accepted for call-site symmetry; the iframe path
 *   does not apply parent-side diff highlighting.
 */
function renderCanvasIntoPanel(
  panel: CanvasPanel,
  _featureToggles: Record<string, boolean>,
  docOverride: JxMutableNode | null = null,
  _gitDiffState: GitDiffState | null = null,
) {
  const gen = view.renderGeneration;
  const tab = activeTab.value;
  const docToRender = docOverride || (tab?.doc.document as JxMutableNode);
  const canvas = panel.canvas as HTMLElement;

  canvasPerf.panelRenders += 1;
  panel.ready = false;

  // Overrides (git-diff docs) mount with a null tab identity: their iframes must never route doc
  // Mutations anywhere. The real doc carries its tab id so edit/drop messages route to THAT tab.
  void timeSpanAsync(SPAN_MOUNT_CANVAS, () =>
    mountIframeCanvas(
      gen,
      docToRender,
      canvas,
      panel._width,
      docOverride ? null : (tab?.id ?? null),
    ),
  )
    .then(() => {
      if (gen === view.renderGeneration) {
        // Mark the panel patchable once the real document is mounted (not a diff/preview override)
        // So classifyOps admits surgical patches; the iframe holds the render context, so this
        // Panel needs no parent-side render scope.
        panel.ready = !docOverride;
        updateCanvas({ error: null, scope: null, status: "ready" });
        statusMessage("Iframe render OK", 1500);
      }
    })
    .catch((error: unknown) => {
      console.warn("mountIframeCanvas failed:", error instanceof Error ? error.message : error);
    });
}

export function renderOverlays() {
  overlaysPanel.render();
}
