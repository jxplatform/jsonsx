/// <reference lib="dom" />
/**
 * Canvas render — extracted from studio.js (Phase 4o). Multi-mode canvas rendering orchestrator:
 * dispatches to manage/settings/source/edit/design/preview rendering paths.
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import type * as monaco from "monaco-editor";
import { loadedMonaco, loadMonaco, mountStillWanted } from "../services/monaco-lazy";

import { getNodeAtPath, updateCanvas } from "../store";
import { activeTab, tabIsLive, workspace } from "../workspace/workspace";
import { canvasModeOfPane, moveCanvasStage, surfaceForPane, tabOfPane } from "./canvas-surface";
import type { CanvasSurface } from "./canvas-surface";
import { primarySelection, uniquePaths } from "../tabs/selection";
import {
  argsSchema,
  nullablePathArg,
  pathListArg,
  pathListProperty,
  pathProperty,
  stringArg,
  stringProperty,
} from "../commands/command-args";
import { collabSourceContext } from "../collab/collab-session";
import { attachCursorStyles } from "../collab/monaco-cursors";
import type { AwarenessLike } from "../collab/monaco-cursors";
import { view } from "../view";
import { shell } from "../shell";
import { parseSourceForPath, serializeDocument } from "../files/file-ops";
import { detachGridPanel, gridPanelMounted, renderGridMode } from "../grid/grid-panel";
import { detachLibraryPane, libraryPaneMounted, renderLibraryMode } from "../browse/library-pane";
import { detachEntryPane, entryPaneMounted, renderEntryMode } from "../content/entry-editor";
import {
  detachSettingsPane,
  renderSettingsPane,
  settingsPaneMounted,
} from "../panels/settings-pane";
import { formatByName, formatForPath } from "../format/format-host";
import {
  BUFFER_COMMIT,
  bufferIsLive,
  bufferMovedOn,
  bufferWrites,
  commitBufferWrites,
} from "../services/monaco-buffer";
import { modelUriFor } from "../services/model-uri";
import { renderWelcome } from "../panels/welcome-screen";
import {
  attachDocumentHeaderHost,
  documentHeaderHost,
  hasDocumentHeader,
} from "../panels/frontmatter-panel";
import { projectState } from "../state";
import {
  applyEditZoom,
  applyTransform,
  canvasPanelTemplate,
  fitOnCanvasEntry,
  observeCenterUntilStable,
  updateActivePanelHeaders,
} from "./canvas-utils";
import { parseMediaEntries } from "../utils/canvas-media";
import { getEffectiveMedia, getEffectiveStyle } from "../site-context";
import {
  adoptCanvasPreviewMode,
  commitActiveEditSession,
  getEditSnapshot,
  mountIframeCanvas,
  postApplyFormat,
  postStyleUpdateToStylebookHosts,
} from "./iframe-host";
import { findEnclosingRepeater } from "../editor/repeater-scope";
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
import { mediaDisplayName } from "../panels/shared";
import { notify } from "../services/notify";
import * as overlaysPanel from "../panels/overlays";

import type { TemplateResult } from "lit-html";
import type { CanvasPanel, GitDiffState } from "../types";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../tabs/tab.js";

interface CanvasRenderCtx {
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
/*
 * One pending frame PER PANE. A shared id would have let the pane that scheduled first swallow the
 * other pane's render for that frame — the dedupe has to be scoped to the surface it dedupes.
 */
const _canvasRafIds = new Map<string, number>();

/**
 * Schedule a full render of one pane's stage.
 *
 * @param {string} [paneId] — defaults to the focused pane
 */
export function scheduleCanvasRender(paneId: string = workspace.activePaneId) {
  if (_canvasRafIds.has(paneId)) {
    return;
  }
  _canvasRafIds.set(
    paneId,
    requestAnimationFrame(() => {
      _canvasRafIds.delete(paneId);
      try {
        renderCanvas(paneId);
      } catch (error) {
        console.error("renderCanvas error:", error);
      }
    }),
  );
}

/**
 * Hand the shell's single stage to a pane, and repaint it.
 *
 * The repaint is not a precaution, it is the other half of the handover. {@link moveCanvasStage}
 * releases what the losing pane mounted — the panel records, their render scopes and the mode it
 * last drew — so the instant the stage changes hands, the DOM standing in it belongs to a pane that
 * no longer owns it and no surface describes it.
 *
 * Nothing else schedules that render. Both canvas effects are keyed on `activeTab`, and the two
 * handovers that matter do not change which tab is active: `⌘\` moves the SAME tab into the new
 * pane, and `View: Unsplit` moves it back. Unsplit is where that showed — `#canvas-wrap` was left
 * empty, clicking the tab did not even count a full render, and only a reload brought the editor
 * back.
 *
 * @param {string} paneId
 * @param {HTMLElement} wrap
 */
export function handOverCanvasStage(paneId: string, wrap: HTMLElement): void {
  moveCanvasStage(paneId, wrap);
  scheduleCanvasRender(paneId);
}

/**
 * Eject a stage's DOM and Lit render part together. Setting textContent/innerHTML removes the
 * comment nodes Lit uses as a ChildPart's markers; if the private `_$litPart$` reference is left
 * behind, the next litRender() reuses a part whose markers are detached from the DOM and throws
 * "This `ChildPart` has no `parentNode`…". Always eject the markers through this helper so the two
 * operations can never drift apart.
 */
function hardClearCanvasWrap(canvasWrap: HTMLElement) {
  canvasWrap.textContent = "";
  // @ts-expect-error -- _$litPart$ is Lit's private render-part marker, not in the DOM types
  delete canvasWrap["_$litPart$"];
}

/**
 * Hand the Document Header card the node the stage just made for it.
 *
 * One stable callback, so Lit invokes it once per host element rather than on every render. The
 * `undefined` branch is Lit reporting a removal WITHOUT saying which node — and the two placements
 * share this callback, so an Edit→Design swap can report the outgoing host after the incoming one
 * has already been bound. Connectivity is the fact that settles it: only a host that really left
 * the document releases the card.
 */
const _bindDocHeaderHost = (el: Element | undefined) => {
  if (el) {
    attachDocumentHeaderHost(el as HTMLElement);
    return;
  }
  if (!documentHeaderHost()?.isConnected) {
    attachDocumentHeaderHost(null);
  }
};

/**
 * The stage's slot for the Document Header card.
 *
 * `in-column` is Edit: the card is a block of the artefact's own column and scrolls with it.
 * `pinned` is Design: the artboards are drawn under a pan/zoom transform, so the card sits above
 * the surface at 1:1 and keeps its own scroll.
 *
 * @param {"in-column" | "pinned"} placement
 * @returns {TemplateResult}
 */
function docHeaderSlot(placement: "in-column" | "pinned"): TemplateResult {
  return html`<div class="doc-header-host ${placement}" ${ref(_bindDocHeaderHost)}></div>`;
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

/*
 * There is no `view.functionEditor` teardown in here, and that is deliberate.
 *
 * Every other disposal below is a surface this module CREATED — the grid panel, the source-mode
 * Monaco and its collab binding, the centering observer. The function editor is not: the Bottom
 * dock's Logic tab creates it and `panels/editors.ts`'s `syncFunctionEditor` disposes it, from an
 * `afterRender` that `panels/bottom-dock.ts` runs for every registered tab whether or not it is
 * showing — precisely so a surface that outlives its own markup can release it. Losing the last tab
 * is one of the state changes that hook already covers.
 *
 * Reaching in from here was also wrong per PANE. `resetCanvasView` runs for a pane with no tab
 * while `view.functionEditor` is app-wide, so a stage-holding pane going empty disposed an editor
 * the dock was still showing for another pane's tab — and, having cleared the handle, left nothing
 * to rebuild it until the next dock repaint.
 */
/**
 * Drop the source-mode Monaco, its model, and the debounced work armed over it.
 *
 * The three sites below used to inline the same four lines, and the four lines were incomplete in
 * the same way at all three: they never cancelled the 600ms sync timer. That timer reads
 * `getValue()` off the editor it closes over, a disposed Monaco answers the empty string, and for a
 * format-backed document the callback then runs `parseSourceForPath(path, "")` and assigns the
 * result — **the page's body replaced with an empty parse, 600ms after the user left Code view,
 * with the tab marked dirty so the next ⌘S writes it to disk.** For a `.json` tab the same path
 * threw inside `JSON.parse("")` and was swallowed by the catch, which is luck rather than design
 * and is why only one of the two shapes was ever reported.
 *
 * One function, so there is one place for the teardown to be and no fourth site can omit it.
 *
 * **And it commits before it cancels.** Cancelling alone traded a dead buffer's `""` for the user's
 * last 600ms of typing, which is still lost work and is now silent: `doc.dirty` stays `false`, so
 * nothing says the edit went missing. {@link commitBufferWrites} runs the armed parse WHILE the
 * model is still attached — `getValue()` is read before its first `await` — and only then drops
 * what is left, so leaving Code view saves the edit instead of choosing which way to discard it.
 */
function disposeSourceEditor(): void {
  const editor = view.monacoEditor;
  if (!editor) {
    return;
  }
  commitBufferWrites(editor);
  editor.getModel()?.dispose();
  editor.dispose();
  view.monacoEditor = null;
}

function resetCanvasView(surface: CanvasSurface) {
  const canvasWrap = surface.wrap;
  detachGridPanel();
  detachLibraryPane();
  detachEntryPane();
  disposeSourceCollab();
  disposeSourceEditor();
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
  for (const p of surface.panels) {
    p.renderScope?.stop();
    p.renderScope = null;
  }
  surface.panels.length = 0;

  hardClearCanvasWrap(canvasWrap);

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
  surface.prevCanvasMode = null;
}

/**
 * Mount the source-mode Monaco editor into an already-rendered container.
 *
 * Async because Monaco is loaded on demand (see services/monaco-lazy). The container is in the DOM
 * before this runs, and every continuation below re-checks `view.monacoEditor`, so a teardown or a
 * mode switch while the module loads is handled the same way a teardown mid-y-monaco-load already
 * was.
 *
 * **The mount ITSELF owed the same re-check and did not make it.** This was the fourth Monaco mount
 * path and the only one with no post-await guard: `renderCanvasImpl` sets `surface.prevCanvasMode`
 * BEFORE it reaches here, so a second synchronous `renderCanvas()` inside the cold load sees
 * `modeChanged === false` and a still-null `view.monacoEditor`, skips the source fast path and
 * falls through to mount again. `store.ts`'s `render()`/`renderOnly()` coalesce nothing, so two
 * mounts is a plain sequence of two renders. {@link mountStillWanted} is asked before `createModel`
 * rather than after, because the duplicate is not just a wasted editor — the second `createModel`
 * claims a URI the first already registered, which real Monaco throws on.
 */
async function mountSourceEditor(
  tab: Tab,
  paneId: string,
  editorContainer: Element,
  filePath: string,
  lang: string,
): Promise<void> {
  const monaco = await loadMonaco();
  if (
    !mountStillWanted(
      editorContainer,
      view.monacoEditor,
      () => tabOfPane(paneId) === tab && canvasModeOfPane(paneId) === "source",
    )
  ) {
    return;
  }
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
        // The model identity says "this load is still for this buffer"; `bufferMovedOn` says "and
        // The buffer is still the empty one it was created as". Serializing a document is a round
        // Trip through the format host, and a user who starts typing into the empty box before it
        // Returns had their first words replaced by the file they were already looking at.
        if (editor && editor.getModel() === model && !bufferMovedOn(editor, "")) {
          editor._ignoreNextChange = true;
          model.setValue(content);
          // The buffer took the DOCUMENT's own text, so the two agree — stated, because clause 3 is
          // A fact each programmatic write owns rather than something a timer can be read for.
          editor._writes?.markSettled();
        }
      })
      .catch(() => {
        // Serialization unavailable — leave the buffer empty rather than crash the render
      });
  }
  // Typed as the surface `view` declares (the editor plus `_ignoreNextChange` / `_writes`), because
  // The instance is HELD here now rather than re-read off `view.monacoEditor` in every callback.
  const sourceEditor: NonNullable<typeof view.monacoEditor> = monaco.editor.create(
    editorContainer as unknown as HTMLElement,
    {
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
    },
  );
  view.monacoEditor = sourceEditor;

  // The debounce holder goes on the editor, not in this closure. A closure variable is reachable
  // Only from inside `mountSourceEditor`, which is why `disposeSourceEditor` had nothing to cancel
  // And a timer outlived every teardown; hanging it off the instance gives it the instance's
  // Lifetime. Installed before the collab early-return so the canceller exists either way.
  const writes = bufferWrites(sourceEditor);

  // Debounced sync back to state (solo tabs only: co-edited buffers flow through the shared
  // Y.Text and the source reconciler's parse mirror instead of a whole-doc replace).
  if (collabCtx) {
    return;
  }
  sourceEditor.onDidChangeModelContent(() => {
    // Identity, not existence: a change fired after this instance stopped being the mounted one has
    // Nothing to say, and asking `view.monacoEditor` for the editor instead of holding it is how
    // The callback below came to address a tab it was never mounted for.
    if (view.monacoEditor !== sourceEditor) {
      return;
    }
    if (sourceEditor._ignoreNextChange) {
      sourceEditor._ignoreNextChange = false;
      return;
    }
    // A keystroke: the buffer is ahead of the document until the commit lands.
    writes.markAhead();
    writes.arm(BUFFER_COMMIT, 600, async () => {
      /* `tab` is the tab this editor was MOUNTED for, captured above and never re-read. It used to
         be `activeTab.value` — whatever was focused when the timer fired — which is the same
         cross-document write the dock's commit had, surviving here only because the model-URI swap
         happens to dispose this editor on a source→source tab change. A coincidence in one caller
         is not a rule, and the tab still has to be OPEN: a closed tab is not in `workspace.tabs`,
         so a parse written into it is a parse nothing will ever read. */
      if (!tabIsLive(tab) || !bufferIsLive(sourceEditor)) {
        return;
      }
      if (formatByName(tab.doc.sourceFormat) && tab.documentPath) {
        try {
          // Parse the full source back into body + frontmatter (title, $head, etc.).
          const { document, frontmatter } = await parseSourceForPath(
            tab.documentPath,
            sourceEditor.getValue(),
          );
          tab.doc.document = document as JxMutableNode;
          tab.doc.content.frontmatter = frontmatter;
          tab.doc.dirty = true;
          writes.markSettled();
        } catch {
          // Unparseable source — don't update state. And do NOT settle: the buffer really is ahead
          // Of the document, so a repaint must go on refusing to overwrite the half-typed heading.
        }
      } else if (lang === "json") {
        try {
          tab.doc.document = JSON.parse(sourceEditor.getValue()) as JxMutableNode;
          tab.doc.dirty = true;
          writes.markSettled();
        } catch {
          // Invalid JSON — same: unparseable is a reason to keep the buffer, not to resync over it.
        }
      } else {
        // A language with no parse back (a handlers `.js` file): the tab is dirty because the
        // Buffer changed, and the DOCUMENT still has no representation of what it says. So this is
        // The one commit that leaves the buffer ahead on success — a re-sync here would replace the
        // Author's JavaScript with `String(document)`, which is not the same text and never was.
        tab.doc.dirty = true;
      }
    });
  });
}

/**
 * Render the canvas surface for the active tab. Thin timing wrapper — {@link renderCanvasImpl} has
 * several early returns, so the span is closed by {@link timeSpan}'s `finally` rather than by
 * hand.
 */
export function renderCanvas(paneId: string = workspace.activePaneId) {
  const surface = surfaceForPane(paneId);
  timeSpan(SPAN_FULL_RENDER, () => {
    renderCanvasImpl(surface);
  });
}

function renderCanvasImpl(surface: CanvasSurface) {
  /* Every read below is scoped to ONE pane. The stage, the panels it mounted and the mode it draws
     are the surface's; the document is whatever tab that pane is showing, which is `activeTab` only
     when the pane is the focused one. */
  const canvasWrap = surface.wrap;
  /* A pane with no stage renders nothing — it is not an error and it is not a fallback to some
     other pane's stage. Two schedulers can name a stage-less pane: a frame queued for a pane that
     lost the shell's single stage between the schedule and the rAF, and `escalateToFullRender` on
     a tab whose pane is not the one on screen. Both mean the same thing — there is no surface to
     repaint — and rendering "the canvas" instead is how one pane's escalation used to redraw the
     other. Left unguarded this threw on Lit's render part, which is what `⌘\` did. */
  if (!canvasWrap) {
    return;
  }
  const canvasPanels = surface.panels;
  const tab = tabOfPane(surface.paneId);
  if (!tab) {
    // No active tab — reset every piece of canvas view state so reopening a file can never inherit
    // A stale Lit part, a dead Monaco editor, or a mismatched prevCanvasMode (the toxic states that
    // Previously left the canvas unrenderable until a full reload).
    attachDocumentHeaderHost(null);
    resetCanvasView(surface);
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
  // The EFFECTIVE mode drives the host surface (panel structure, panzoom vs centered column vs the
  // Preview stage). Preview is its own surface — a real, viewport-sized iframe that scrolls its own
  // Document — so flipping the toggle IS a mode transition and rebuilds the surface, rather than
  // Re-rendering the previous mode's panels in place.
  const canvasMode = canvasModeOfPane(surface.paneId);

  /* The Document Header card (§3.2 ⑧) is drawn by the STAGE, not by a band above it. Two surfaces
     draw a page you can author: the centered Edit column, where the card goes INSIDE the document
     column and scrolls with the artefact, and the Design artboards, where it is pinned above the
     panzoom surface because a form drawn at the artboard's scale is a picture of a form, not a
     control. `hasDocumentHeader` is the only remaining predicate and it is a fact about the
     DOCUMENT — the one condition left, because the mode is the only other thing that decides
     whether a page is being authored. It used to carry two more clauses, suppressing the card while
     a function body or a formula was open on the grounds that those sub-editors took the whole
     stage. They open in the dock's Logic tab now (P8) and the page is still on screen behind it, so
     those clauses only DETACHED the visible card: it stopped re-rendering and quietly showed
     frontmatter from before the edit. */
  const wantsDocHeader =
    (canvasMode === "edit" || canvasMode === "design") && hasDocumentHeader(tab);
  if (!wantsDocHeader) {
    attachDocumentHeaderHost(null);
  }

  // Advance render generation so stale async renders from the previous cycle bail out
  view.renderGeneration += 1;
  canvasPerf.fullRenders += 1;

  // Detect whether this is a mode transition or a content-only re-render
  const modeChanged = canvasMode !== surface.prevCanvasMode;

  // Only clear Lit's internal state on mode transitions (structural panel changes).
  // For content re-renders in the same mode, Lit's template diffing preserves
  // The panel structure. Bailed async renders can't corrupt the DOM because
  // RenderCanvasLive uses atomic clear (innerHTML = "" right before appendChild).
  // @ts-expect-error -- _$litPart$ is Lit's private render-part marker, not in the DOM types
  if (modeChanged && canvasWrap["_$litPart$"]) {
    hardClearCanvasWrap(canvasWrap);
  }

  /* There are no `editingFunction` / `editingFormula` branches here, and that is the point.
     Both used to RETURN from this function, which is what made the logic editors a takeover: the
     stage kept whatever DOM it was last painted with and stopped tracking the document. P8 moved
     both into the dock's Logic tab, `panels/bottom-dock.ts` reveals it from its own effect, and
     `panels/editors.ts`'s `syncFunctionEditor` owns the Monaco instance from the panel's
     `afterRender` — including disposing it. Nothing about the canvas render depends on a logic
     target any more, so the page underneath the dock keeps rendering while you edit a formula. */

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
      disposeSourceEditor();
    }
  }

  /* THE FAST PATHS, and the one condition every one of them owes.
     Each says "the structure this mode needs is already standing on the stage, so there is nothing
     to build". None of them can see the stage: they ask a MODULE whether it mounted (`view
     .monacoEditor`, `gridPanelMounted`, …), and that answer outlives the DOM. `modeChanged` is
     exactly "the structure on this stage is not mine" — a real mode transition, or a surface whose
     `prevCanvasMode` was released because the stage changed hands — and the mode-transition clear
     ABOVE has already emptied the wrap by the time any of them is reached.
     Unguarded, this is what survived the Unsplit fix: the stage came back to the primary pane,
     `prevCanvasMode` was null, the wrap was cleared, and the source fast path then returned on the
     strength of a Monaco editor whose container had just been thrown away. An empty stage, a live
     editor nobody could see, and only a reload to get it back. */

  /* Source mode: update the existing Monaco editor without recreating it. Don't replace the buffer
     while it has moved on — that would reformat under the cursor (the source view is the editing
     surface here, mirroring the panel draft-state behaviour). This branch is where the rule was
     first written, as a bare `!editor.hasTextFocus()`; `services/monaco-buffer.ts` is where it
     lives now, and it gained the two clauses this spelling was missing — a buffer holding text the
     document has not been given (the user typed, then clicked away; or a `.js` buffer the document
     has no parse for at all) and an editor disposed inside the round trip. */
  if (canvasMode === "source" && view.monacoEditor && !modeChanged) {
    const editor = view.monacoEditor;
    sourceContent(tab, sourceLang(tab))
      .then((newVal) => {
        if (view.monacoEditor !== editor) {
          return;
        }
        if (!bufferMovedOn(editor) && editor.getValue() !== newVal) {
          editor._ignoreNextChange = true;
          editor.setValue(newVal);
          // Buffer and document agree again, by the document's text winning. Same declaration the
          // Dock's re-sync makes, for the same reason: clause 3 belongs to whoever writes.
          editor._writes?.markSettled();
        }
      })
      .catch(() => {
        // Serialization unavailable (e.g. format service unreachable) — keep the current buffer
      });
    return;
  }

  // Grid fast-path: the grid panel runs its own effect scope (toolbar + engine stay live), so a
  // Same-tab re-render while the panel is mounted needs nothing from the canvas pipeline.
  if (canvasMode === "grid" && gridPanelMounted(tab) && !modeChanged) {
    return;
  }

  // Library fast-path, same shape: the Library pane owns its own reactivity (view state, scan,
  // Window), so a same-tab re-render while it is mounted needs nothing from the canvas pipeline.
  if (canvasMode === "manage" && libraryPaneMounted(tab) && !modeChanged) {
    return;
  }

  // Entry fast-path, same shape: the entry form owns its own effect over the tab's frontmatter, so
  // A field commit repaints the form and nothing reaches the canvas pipeline.
  if (canvasMode === "entry" && entryPaneMounted(tab) && !modeChanged) {
    return;
  }

  // Settings fast-path, same shape: the Project Settings editor subscribes to the section registry
  // And to its own chosen section, so a mounted editor needs nothing from the canvas pipeline.
  if (canvasMode === "settings" && settingsPaneMounted(canvasWrap) && !modeChanged) {
    return;
  }

  // Stylebook fast-path: a style edit re-applies IN PLACE via the bridge (the iframe re-runs the
  // Runtime's style applier on the specimen root — real @media, no re-render, no iframe reload).
  // Filter/Customized changes fall through to the full rebuild (they change which specimens exist),
  // As does a zero-host post (no stylebook iframe live yet).
  if (canvasMode === "stylebook" && !modeChanged) {
    const curFilter = shell.stylebook.filter;
    const curCustomized = shell.stylebook.customizedOnly;
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
  surface.prevCanvasMode = canvasMode;

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

    // The Library holds an IntersectionObserver and an LRU of live runtime subtrees; leaving the
    // Mode without releasing them is exactly the unbounded retention P7.1 exists to remove.
    detachLibraryPane();

    // Same for the entry form, whose effect scope subscribes to the document's frontmatter
    detachEntryPane();

    // Same for the Project Settings editor, which holds a registry subscription
    detachSettingsPane();

    // Dispose Monaco editor if switching away from source mode
    disposeSourceCollab();
    disposeSourceEditor();

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
    _prevStylebookFilter = shell.stylebook.filter;
    _prevStylebookCustomizedOnly = shell.stylebook.customizedOnly;
    renderStylebookMode({
      applyTransform,
      canvasPanelTemplate,
      observeCenterUntilStable,
      updateActivePanelHeaders,
    });
    if (modeChanged) {
      fitOnCanvasEntry();
    }
    return;
  }

  /* Preview — the fidelity surface. One stage, one iframe, sized to the pane and scrolling its own
     document, with no panzoom-wrap: the pan transform is precisely what stopped `position:sticky`,
     scroll-driven animation and IntersectionObserver reveals from ever firing in the one mode whose
     job is to show the page as it ships. The host keeps the iframe at its CSS height for the same
     reason (see the `contentHeight` case in iframe-host.ts), and gates every editing affordance —
     hits, hover, the insertion "+", the Jx context menu and drops — off this render. */
  if (canvasMode === "preview") {
    if (modeChanged) {
      canvasWrap.style.padding = "0";
      canvasWrap.style.display = "block";
      canvasWrap.style.overflow = "hidden";
    }
    const { tpl: panelTpl, panel } = canvasPanelTemplate(null, null, true);
    litRender(html`<div class="preview-stage">${panelTpl}</div>`, canvasWrap);
    canvasPanels.push(panel as unknown as CanvasPanel);
    renderCanvasIntoPanel(surface, panel as unknown as CanvasPanel, S.ui.featureToggles);
    return;
  }

  /* Settings mode: the Project Settings document (plan §9.3). Same non-iframe-editor pattern as
     grid and stylebook — the panel owns its own reactivity from here — and the reason the seven
     settings screenshots now crop `pane.primary` instead of `overlay.dialog:settings` without one
     manifest step changing. */
  if (canvasMode === "settings") {
    canvasWrap.style.padding = "0";
    canvasWrap.style.display = "block";
    renderSettingsPane(canvasWrap);
    return;
  }

  /* Library mode: the project's own contents, over a GridSource, in one of five layouts
     (`browse/library-pane.ts`). `commands/context.ts` already mapped `manage` to the `library`
     editor kind — this is the surface that map was pointing at. */
  if (canvasMode === "manage") {
    canvasWrap.style.padding = "0";
    canvasWrap.style.display = "block";
    renderLibraryMode(canvasWrap, tab);
    return;
  }

  /* Entry mode: one content entry's fields, typed by its collection's schema
     (`content/entry-editor.ts`). Same non-iframe-editor pattern as the Library and Settings — and
     the reason `entry` is in `commands/context.ts`'s mode map, without which a form over a
     frontmatter record would have resolved into the CANVAS key scope. */
  if (canvasMode === "entry") {
    canvasWrap.style.padding = "0";
    canvasWrap.style.display = "block";
    renderEntryMode(canvasWrap, tab);
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
    void mountSourceEditor(
      tab,
      surface.paneId,
      editorContainer as unknown as Element,
      filePath,
      lang,
    );
    return;
  }

  // Git diff mode — render original (left) and current (right) side-by-side on panzoom surface
  if (canvasMode === "git-diff") {
    if (!ctx.gitDiffState) {
      ctx.setCanvasMode("design");
      renderCanvas(surface.paneId);
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
    // Both sides mount after an await, so the pass's generation is captured now — see the note on
    // `passGen` at the design-mode artboard loop.
    const diffGen = view.renderGeneration;
    void Promise.all([
      parseContent(gitDiffState.originalContent || ""),
      parseContent(gitDiffState.currentContent || ""),
    ]).then(([originalDoc, currentDoc]) => {
      renderCanvasIntoPanel(
        surface,
        origPanel as unknown as CanvasPanel,
        featureToggles,
        originalDoc,
        gitDiffState,
        diffGen,
      );
      renderCanvasIntoPanel(
        surface,
        currPanel as unknown as CanvasPanel,
        featureToggles,
        currentDoc,
        gitDiffState,
        diffGen,
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
        <div class=${columnClass} style="max-width:${baseWidth}px">
          ${wantsDocHeader ? docHeaderSlot("in-column") : nothing}${panelTpl}
        </div>
      </div>
    `;
    litRender(editTpl, canvasWrap);
    canvasPanels.push(panel as unknown as CanvasPanel);
    renderCanvasIntoPanel(surface, panel as unknown as CanvasPanel, S.ui.featureToggles);
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
  /* The stage stacks when it carries the card: header first, artboards below. Set on every render
     rather than on the transition, because whether a document HAS a header changes with the tab and
     not with the mode. `editors.ts` and `formula-workspace.ts` already claim the column this way —
     `#canvas-wrap` is a row by default and each surface states its own axis. */
  canvasWrap.style.flexDirection = wantsDocHeader ? "column" : "";
  canvasWrap.style.alignItems = wantsDocHeader ? "stretch" : "";
  const designHeaderTpl = wantsDocHeader ? docHeaderSlot("pinned") : nothing;

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
        ${designHeaderTpl}
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
    renderCanvasIntoPanel(surface, panel as unknown as CanvasPanel, featureToggles);
    applyTransform();
    if (modeChanged) {
      // Fit BEFORE centering: the fit picks the zoom, centerCanvas then places the artboard at that
      // Zoom (and top-aligns it, which beats fit's vertical centering for a page taller than the
      // Viewport).
      fitOnCanvasEntry();
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
      ${designHeaderTpl}
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

  /* Every artboard of this pass mounts under the generation the pass opened with, captured HERE
     rather than read inside each deferred callback. Two things depend on it. The iframe drops a
     render whose gen is older than the one it last accepted, so a pass that has been superseded
     while its artboards were still queued is discarded by the frame instead of posting a duplicate
     render under the NEW pass's number. And the host resolves the document once per generation
     (`preparePassRender`), which only fans out if the pass has one. */
  const passGen = view.renderGeneration;
  for (let i = 0; i < panelEntries.length; i++) {
    const { panel } = panelEntries[i]!;
    const p = panel as CanvasPanel;
    canvasPanels.push(p);
    if (i === 0) {
      renderCanvasIntoPanel(surface, p, featureToggles);
    } else {
      // Yield between artboards so the first one paints before the rest mount. They no longer pay
      // For the document — the pass already resolved it — but each is still a live iframe render.
      setTimeout(() => renderCanvasIntoPanel(surface, p, featureToggles, null, null, passGen), 0);
    }
  }

  // Highlight active panel header
  updateActivePanelHeaders();

  // Apply current zoom + pan transform
  applyTransform();
  if (modeChanged) {
    // See the single-panel path: fit picks the zoom, centerCanvas then places the artboards.
    fitOnCanvasEntry();
    observeCenterUntilStable();
  }
}

/**
 * Render a document into a single canvas panel via the iframe canvas: the document renders inside a
 * same-runtime iframe served from the real origin (the iframe holds the render context, stamps
 * `data-jx-path`/`data-jx-layout`, and draws its own overlays). Git-diff/preview overrides render
 * but stay un-patchable (`ready` only flips for the real tab document).
 *
 * @param {CanvasSurface} surface - The pane's stage this panel belongs to. The document rendered
 *   and the preview flag both come from THAT pane, never from "the active tab".
 * @param {CanvasPanel} panel
 * @param {Record<string, boolean>} _featureToggles - Accepted for call-site symmetry (the iframe
 *   render needs no structural-preview fallback); unused.
 * @param {JxMutableNode | null} [docOverride] - Optional document to render (for diff mode). Uses
 *   active tab doc if not provided.
 * @param {GitDiffState | null} [_gitDiffState] - Accepted for call-site symmetry; the iframe path
 *   does not apply parent-side diff highlighting.
 * @param {number | null} [passGen] - The generation of the render pass this panel belongs to.
 *   Passed explicitly by a DEFERRED mount, whose callback would otherwise read whatever generation
 *   is current when the timer fires — a later pass's number, stamped on an earlier pass's
 *   artboard.
 */
function renderCanvasIntoPanel(
  surface: CanvasSurface,
  panel: CanvasPanel,
  _featureToggles: Record<string, boolean>,
  docOverride: JxMutableNode | null = null,
  _gitDiffState: GitDiffState | null = null,
  passGen: number | null = null,
) {
  const gen = passGen ?? view.renderGeneration;
  const tab = tabOfPane(surface.paneId);
  const docToRender = docOverride || (tab?.doc.document as JxMutableNode);
  const canvas = panel.canvas as HTMLElement;

  canvasPerf.panelRenders += 1;
  panel.ready = false;

  // The host's frame box depends on whether this is a preview render, and mountIframeCanvas only
  // Learns that after it has awaited the resolved document — one await during which the iframe can
  // Post a contentHeight that the OUTGOING mode would answer. Declare it here, before the await,
  // Where it is already known: this is the mode whose surface was just built.
  adoptCanvasPreviewMode(canvas, canvasModeOfPane(surface.paneId) === "preview");

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
        // A successful render used to announce itself as "Iframe render OK" — a debug string
        // Shipped to end users and legible in a published docs screenshot. A render that worked is
        // The canvas you are looking at; it says so itself.
      }
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      notify.error("The canvas could not be mounted.", {
        detail,
        key: "canvas.mount",
        source: "Canvas",
      });
    });
}

export function renderOverlays() {
  overlaysPanel.render();
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** The root identifier a merge-tag token binds to — `state`, `item` or `index`, or `""`. */
function tokenRoot(token: string): string {
  return /^[A-Za-z_$][\w$]*/.exec(token)?.[0] ?? "";
}

/**
 * Refuse a `${…}` token the open document cannot resolve, naming what it could have been.
 *
 * The same rule `data.expandRow` applies to a row name, for the same reason: an unresolvable token
 * renders as EMPTY TEXT, so inserting one silently produces a document that looks bound and is not
 * — and a capture of it documents a binding that never existed.
 */
function refuseUnresolvableToken(token: string): void {
  const tab = activeTab.value;
  if (!tab) {
    throw new RangeError(`command "insert.data" needs an open document; no tab is active`);
  }
  const root = tokenRoot(token);
  const state = (tab.doc.document.state ?? {}) as Record<string, unknown>;
  if (root === "state") {
    const name = token.split(".")[1] ?? "";
    if (!(name in state)) {
      const defined = Object.keys(state);
      throw new RangeError(
        `command "insert.data" argument "token": "${token}" names no state entry — this ` +
          `document defines: ${defined.length > 0 ? defined.join(", ") : "nothing"}`,
      );
    }
    return;
  }
  if (root === "item" || root === "index") {
    // The repeater scope exists only INSIDE a `map` template, and the caret's own doc path is what
    // Says whether it does — the same question `panels/block-action-bar.ts` asks before it offers
    // These tokens at all.
    const path = getEditSnapshot().snapshot?.path ?? primarySelection(tab.session.selection);
    if (!findEnclosingRepeater(tab.doc.document, path)) {
      throw new RangeError(
        `command "insert.data" argument "token": "${token}" is a repeater-scope token, and the ` +
          `caret is not inside a repeater template`,
      );
    }
    return;
  }
  throw new RangeError(
    `command "insert.data" argument "token": "${token}" is not an insertable token — a token ` +
      `reads "state.<name>", "item", "item.<field>" or "index"`,
  );
}

/**
 * The two verbs that address what the canvas pane is pointing AT — the element, and the caret.
 *
 * Both are defined beside the surface that DRAWS them rather than beside the fields that store
 * them: every consumer of `session.selection` — the overlay boxes, the Outline's selected row, the
 * Inspector, the block action bar — is downstream of this module's render, and both verbs must
 * guarantee that what they accept is something those surfaces can actually draw.
 *
 * `selection.set`: `path: []` is the document ROOT and is a legal selection (`selector-menu-shot`
 * uses it). `null` clears the selection. Anything else is resolved against the open document and
 * REFUSED when it addresses nothing — a stale path used to select a hole, and every panel
 * downstream then rendered its empty state while the shot recorded that as the truth.
 *
 * `insert.data`: the capability has shipped since the merge-tag menu landed and has been reachable
 * from that menu ALONE — `panels/block-action-bar.ts` posts an `insertData` intent straight to the
 * canvas bridge, so the palette, the keyboard, the AI and `__jxAutomation` could not do the one
 * thing the whole Insert-data affordance exists for. The screenshot manifest reached it by clicking
 * the toolbar button and then a row of the menu it opens, which is the shape §13.5 refuses on
 * principle: opening a menu to press an item names a CONTROL; the item is the command.
 */
export function selectionCommands(): AnyCommand[] {
  return [
    {
      args: argsSchema({
        path: pathProperty(
          "The document path to select — an array of keys and indexes. [] is the document " +
            "root; null clears the selection.",
          true,
        ),
      }),
      category: "Selection",
      id: "selection.set",
      level: "document",
      menus: ["palette"],
      group: "2_navigate",
      requires: "an open document",
      when: (ctx) => ctx.document.open,
      aiTool: {
        description:
          "Select the element at a document path so the Inspector, the Outline and the canvas " +
          "overlay all address it. Pass null to clear the selection.",
        name: "select_node",
      },
      run: (_commandCtx, args) => {
        const path = nullablePathArg("selection.set", args, "path");
        const tab = activeTab.value;
        if (!tab) {
          throw new RangeError(`command "selection.set" needs an open document; no tab is active`);
        }
        if (path !== null && path.length > 0 && !getNodeAtPath(tab.doc.document, path)) {
          throw new RangeError(
            `command "selection.set" argument "path": [${path.join(", ")}] addresses no node in ` +
              `${tab.documentPath ?? "the open document"}`,
          );
        }
        tab.session.selection = path === null ? [] : [path];
      },
      title: "Select Element",
    },
    {
      args: argsSchema({
        paths: pathListProperty(
          "The document paths to select, in order — an array of paths. The LAST one becomes the " +
            "primary (what the Inspector edits); the first is the anchor a shift-range extends " +
            "from. [] selects nothing.",
        ),
      }),
      category: "Selection",
      id: "selection.setPaths",
      level: "document",
      menus: ["palette"],
      group: "2_navigate",
      requires: "an open document",
      when: (ctx) => ctx.document.open,
      aiTool: {
        description:
          "Select several elements at once so one decision — a style paste, a delete, a duplicate " +
          "— applies to all of them as a single undoable step. Pass [] to select nothing.",
        name: "select_nodes",
      },
      /**
       * The idempotent SET for the whole selection, beside `selection.set`'s single path.
       *
       * There is deliberately no `selection.add` or `selection.toggle`: an accumulate verb names a
       * DELTA against state the caller cannot observe, which is the same objection that bans a
       * `toggle*` id without a `set*` beside it (§13). Ctrl-clicking twice is a gesture; the
       * command is always "the selection is now exactly these". `selection.set { path }` survives
       * unchanged because selecting one node is what almost every caller — every screenshot step,
       * and the assistant — actually does.
       */
      run: (_commandCtx, args) => {
        const paths = pathListArg("selection.setPaths", args, "paths");
        const tab = activeTab.value;
        if (!tab) {
          throw new RangeError(
            `command "selection.setPaths" needs an open document; no tab is active`,
          );
        }
        for (const path of paths) {
          if (path.length > 0 && !getNodeAtPath(tab.doc.document, path)) {
            throw new RangeError(
              `command "selection.setPaths" argument "paths": [${path.join(", ")}] addresses no ` +
                `node in ${tab.documentPath ?? "the open document"}`,
            );
          }
        }
        // Deduplicated, so running the same list twice lands on the same anchor and the same
        // Primary — the property that makes it photographable.
        tab.session.selection = uniquePaths(paths);
      },
      title: "Select Elements",
    },
    {
      args: argsSchema({
        token: stringProperty(
          'The token to insert, without the ${…} wrapper — "state.<name>", "item", ' +
            '"item.<field>" or "index".',
        ),
      }),
      category: "Insert",
      id: "insert.data",
      level: "selection",
      keyScope: "caret",
      // NOT `blockbar`: the bar's Insert-data control opens a PICKER, and a picker cannot be the
      // Rendering of a record that requires a token. The record is what the picker's rows run.
      menus: ["palette"],
      group: "5_data",
      undo: "document",
      requires: "a live text caret in the canvas",
      when: (ctx) => ctx.caret.active,
      aiTool: {
        description:
          "Insert a live data placeholder at the text caret, binding that run of text to a state " +
          "entry or, inside a repeater template, to the current item.",
        name: "insert_data_token",
      },
      run: (_commandCtx, args) => {
        const token = stringArg("insert.data", args, "token");
        refuseUnresolvableToken(token);
        postApplyFormat({ command: "insertData", token });
      },
      title: "Insert Data",
    },
  ];
}

/**
 * Register the canvas pane's addressing verbs. Called from the bootstrap.
 *
 * @param {CommandRegistry} registry
 */
export function registerSelectionSetCommand(registry: CommandRegistry): void {
  registry.registerAll(selectionCommands());
}
