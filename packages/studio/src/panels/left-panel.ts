/// <reference lib="dom" />
/**
 * Left panel — orchestrator that delegates to per-tab render functions.
 *
 * Each sub-panel exports a render function that takes its dependencies as arguments and returns a
 * TemplateResult — the same pattern as imports-panel, signals-panel, etc. Only this orchestrator
 * uses mount/render/unmount because it owns the DOM root and error boundary.
 */

import { html, render as litRender, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { leftPanel, updateSession } from "../store";
import { effect, effectScope } from "../reactivity";
import { createPanelScheduler } from "./panel-scheduler";
import type { PanelScheduler } from "./panel-scheduler";
import { activeTab } from "../workspace/workspace";
import { shell } from "../shell";
import { mutateUpdateFrontmatter, transact } from "../tabs/transact";
import type { GitDiffState, JsonValue } from "../types";
import type { JxHeadEntry, JxMutableNode } from "@jxsuite/schema/types";

import { navigatorPanelRegion } from "../ui/regions";
import { openPageAction, renderEmptyState } from "./empty-state";
import { renderLayersTemplate } from "./layers-panel";
import { renderStylebookLayersTemplate } from "./stylebook-layers-panel";
import { renderElementsTemplate } from "./elements-panel";
import { selectStylebookTag, stylebookMeta } from "./stylebook-panel";
import type { renderImportsTemplate } from "./imports-panel";
import type { renderSignalsTemplate } from "./signals-panel";
import type { renderDataExplorerTemplate } from "./data-explorer";
import type { renderHeadTemplate } from "./head-panel";
import type { renderGitPanel } from "./git-panel";
import type { EffectScope } from "@vue/reactivity";

interface LeftPanelCtx {
  getCanvasMode: () => string;
  setCanvasMode: (mode: string) => void;
  // Renderers injected from studio.ts (dependency inversion avoids circular imports);
  // Typed against their implementations so call sites stay checked.
  renderImportsTemplate: typeof renderImportsTemplate;
  renderFilesTemplate: () => TemplateResult;
  renderSignalsTemplate: typeof renderSignalsTemplate;
  renderDataExplorerTemplate: typeof renderDataExplorerTemplate;
  renderHeadTemplate: typeof renderHeadTemplate;
  renderGitPanel: typeof renderGitPanel;
  renderCanvas: () => void;
  /** Canvas re-render that also lets automatic `Request` entries fetch (Data panel Refresh). */
  refreshData: () => void;
  defCategory: (def: unknown) => string;
  defBadgeLabel: (def: unknown) => string;
  navigateToComponent: (path: string) => void;
  webdata: Record<string, unknown>;
  defaultDef: (tag: string) => Record<string, unknown>;
  registerLayersDnD: () => void;
  registerElementsDnD: () => void;
  registerComponentsDnD: () => void;
  setupTreeKeyboard: (tree: HTMLElement) => void;
  registerFileTreeDnD: (ctx: { renderLeftPanel: () => void }) => void;
  setGitDiffState: (state: GitDiffState | null) => void;
  cloneRepository?: () => void;
}

let _ctx: LeftPanelCtx | null = null;

let _scope: EffectScope | null = null;

let _scheduler: PanelScheduler | null = null;

/**
 * Mount the left panel orchestrator.
 *
 * @param {LeftPanelCtx} ctx
 */
export function mount(ctx: LeftPanelCtx) {
  _ctx = ctx;
  _scheduler = createPanelScheduler({ render: _doRender, root: leftPanel });
  _scheduler.bindFocus();
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      // Shell state is tracked with no tab open — which panel is showing, and the project-level
      // State the project-level panels draw from. A document-less rail tab still repaints.
      void shell.leftTab;
      void shell.settingsTab;
      void shell.git.status;
      void shell.git.loading;
      void shell.git.error;
      void shell.git.subTab;
      void shell.git.logEntries;
      const tab = activeTab.value;
      if (tab) {
        // Track properties the left panel reads
        void tab.doc.document;
        void tab.doc.mode;
        void tab.session.selection;
      }
      render();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  _ctx = null;
  _scheduler?.unbind();
  _scheduler = null;
}

/**
 * Request a render. Coalesced and deferred while a text input in the panel is focused (so explicit
 * callers — renderOnly("leftPanel"), tab switches, etc. — can never clobber a field mid-edit).
 */
export function render() {
  _scheduler?.schedule();
}

/** Actual DOM paint, invoked by the scheduler. Includes a Lit-marker-corruption recovery retry. */
function _doRender() {
  if (!_ctx) {
    return;
  }
  try {
    _render();
  } catch (error) {
    console.error("left-panel render error:", error);
    try {
      leftPanel.textContent = "";
      // @ts-expect-error — clear Lit's internal state to recover from marker corruption
      delete leftPanel["_$litPart$"];
      _render();
    } catch (retryError) {
      console.error("left-panel retry failed:", retryError);
    }
  }

  if (shell.leftTab === "layers") {
    const sel = leftPanel.querySelector(".layer-row.selected");
    if (sel) {
      sel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
}

/**
 * What each document-level rail tab is for, said in the words of the thing it needs. A rail tab
 * with no document renders this instead of a bare `.panel-body` — the ring collapses to a sentence,
 * not to an empty box.
 */
const NO_DOCUMENT_COPY: Record<string, string> = {
  data: "Open a page to watch its data resolve while you edit.",
  head: "Open a page to edit its title, description and social preview.",
  imports: "Open a page to choose which components it can use.",
  layers: "Open a page to see the elements it is built from.",
  state: "Open a page to give it data — values it can read, compute or fetch.",
};

/**
 * The Navigator's one panel host.
 *
 * Every branch below renders through this, which is what makes `navigator/panel:<id>` **derived**:
 * the region is stamped once, from the same id the rail routes by, so all eight panels are
 * addressable without anyone authoring eight ids — and renaming a panel renames its region in the
 * same edit, instead of leaving a stale selector that photographs the wrong box.
 */
function panelBody(panelId: string, content: unknown): TemplateResult {
  return html`<div class="panel-body" data-jx-region=${navigatorPanelRegion(panelId)}>
    ${content}
  </div>`;
}

/** Overlay content-mode frontmatter title/$head onto the document for the head panel. */
function buildHeadDoc(doc: JxMutableNode, fm: Record<string, unknown>): JxMutableNode {
  const title = fm.title as string | undefined;
  const $head = fm.$head as JxHeadEntry[] | undefined;
  return {
    ...doc,
    ...(title !== undefined ? { title } : {}),
    ...($head !== undefined ? { $head } : {}),
  };
}

function _render() {
  const ctx = _ctx as LeftPanelCtx;
  const tab = shell.leftTab;

  // ── Project-level panels: render based on projectState, independent of active tab ──

  if (tab === "files") {
    litRender(panelBody(tab, ctx.renderFilesTemplate()), leftPanel);
    const tree = leftPanel.querySelector(".file-tree") as HTMLElement | null;
    if (tree) {
      ctx.setupTreeKeyboard(tree);
    }
    ctx.registerFileTreeDnD({ renderLeftPanel: render });
    return;
  }

  if (tab === "git") {
    litRender(panelBody(tab, ctx.renderGitPanel(ctx)), leftPanel);
    return;
  }

  if (tab === "blocks") {
    const content = renderElementsTemplate({
      defaultDef: ctx.defaultDef,
      rerender: render,
      webdata: ctx.webdata,
    } as Parameters<typeof renderElementsTemplate>[0]);
    litRender(panelBody(tab, content), leftPanel);
    ctx.registerElementsDnD();
    ctx.registerComponentsDnD();
    return;
  }

  // ── Document-level panels: require an active tab ──

  const aTab = activeTab.value;
  if (!aTab) {
    const message = NO_DOCUMENT_COPY[tab];
    const empty = message ? renderEmptyState({ actions: [openPageAction()], message }) : nothing;
    litRender(panelBody(tab, empty), leftPanel);
    return;
  }

  const S = /**
   * @type {{
   *   ui: unknown;
   *   document: JxMutableNode;
   *   mode: string;
   *   selection: JxPath | null;
   *   canvas: { scope?: object } | null;
   *   content?: { frontmatter?: Record<string, unknown> };
   *   documentPath?: string;
   * }}
   */ {
    canvas: aTab.session.canvas,
    content: aTab.doc.content,
    document: aTab.doc.document,
    documentPath: aTab.documentPath,
    mode: aTab.doc.mode,
    selection: aTab.session.selection,
    ui: aTab.session.ui,
  };

  /** @type {TemplateResult | typeof nothing} */
  let content;
  if (tab === "layers") {
    content =
      ctx.getCanvasMode() === "stylebook"
        ? renderStylebookLayersTemplate({
            selectStylebookTag,
            stylebookMeta,
          } as Parameters<typeof renderStylebookLayersTemplate>[0])
        : renderLayersTemplate({
            navigateToComponent: ctx.navigateToComponent,
            rerender: render,
          });
  } else if (tab === "imports") {
    content = ctx.renderImportsTemplate({
      applyMutation: (fn: (doc: JxMutableNode) => void) => {
        transact(activeTab.value, fn);
      },
      documentElements: S.document.$elements || [],
      documentPath: S.documentPath,
      renderLeftPanel: render,
    });
  } else if (tab === "state") {
    content = ctx.renderSignalsTemplate(S, {
      renderCanvas: ctx.renderCanvas,
      renderLeftPanel: render,
      updateSession,
    });
  } else if (tab === "data") {
    content = ctx.renderDataExplorerTemplate(S.document.state ?? {}, S.canvas?.scope ?? null, {
      defBadgeLabel: ctx.defBadgeLabel,
      defCategory: ctx.defCategory,
      refreshData: ctx.refreshData,
      renderCanvas: ctx.renderCanvas,
      renderLeftPanel: render,
    });
  } else if (tab === "head") {
    const isContent = S.mode === "content";
    const fm = S.content?.frontmatter ?? {};
    const headDoc = isContent ? buildHeadDoc(S.document, fm) : S.document;
    content = ctx.renderHeadTemplate({
      applyMutation: isContent
        ? (fn: (doc: JxMutableNode) => void) => {
            const tabNow = activeTab.value!;
            const fmNow = (tabNow.doc.content?.frontmatter ?? {}) as Record<string, unknown>;
            const fmHead = fmNow.$head as JxHeadEntry[] | undefined;
            const tmp: JxMutableNode = {
              ...(typeof fmNow.title === "string" ? { title: fmNow.title } : {}),
              ...(fmHead ? { $head: [...fmHead] } : {}),
            };
            fn(tmp);
            if (tmp.title !== fmNow.title) {
              mutateUpdateFrontmatter(tabNow, "title", tmp.title as JsonValue);
            }
            const newHead = tmp.$head && tmp.$head.length > 0 ? tmp.$head : undefined;
            // JxHeadEntry[] is JSON document content by construction.
            mutateUpdateFrontmatter(tabNow, "$head", newHead as JsonValue);
            render();
          }
        : (fn: (doc: JxMutableNode) => void) => {
            transact(activeTab.value, fn);
          },
      document: headDoc,
      renderLeftPanel: render,
    });
  } else {
    content = nothing;
  }

  litRender(panelBody(tab, content), leftPanel);

  // Post-render side effects
  if (tab === "layers" && ctx.getCanvasMode() !== "stylebook") {
    ctx.registerLayersDnD();
  }
}
