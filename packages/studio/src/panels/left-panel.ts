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
import { createPanelScheduler, type PanelScheduler } from "./panel-scheduler";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { transact, mutateUpdateFrontmatter } from "../tabs/transact";
import type { GitDiffState, JsonValue } from "../types";

import { renderLayersTemplate } from "./layers-panel";
import { renderStylebookLayersTemplate } from "./stylebook-layers-panel";
import { renderElementsTemplate } from "./elements-panel";
import { selectStylebookTag, stylebookMeta } from "./stylebook-panel";

interface LeftPanelCtx {
  getCanvasMode: () => string;
  setCanvasMode: (mode: string) => void;
  renderImportsTemplate: (...args: any[]) => TemplateResult;
  renderFilesTemplate: (...args: any[]) => TemplateResult;
  renderSignalsTemplate: (...args: any[]) => TemplateResult;
  renderDataExplorerTemplate: (...args: any[]) => TemplateResult;
  renderHeadTemplate: (...args: any[]) => TemplateResult;
  renderGitPanel: (...args: any[]) => TemplateResult;
  renderCanvas: () => void;
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

let _scope: import("@vue/reactivity").EffectScope | null = null;

let _scheduler: PanelScheduler | null = null;

/**
 * Mount the left panel orchestrator.
 *
 * @param {LeftPanelCtx} ctx
 */
export function mount(ctx: LeftPanelCtx) {
  _ctx = ctx;
  _scheduler = createPanelScheduler({ root: leftPanel, render: _doRender });
  _scheduler.bindFocus();
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (tab) {
        // Track properties the left panel reads
        void tab.doc.document;
        void tab.doc.mode;
        void tab.session.selection;
        void tab.session.ui.settingsTab;
        void tab.session.ui.gitStatus;
        void tab.session.ui.gitLoading;
        void tab.session.ui.gitError;
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
  if (!_ctx) return;
  try {
    _render();
  } catch (e) {
    console.error("left-panel render error:", e);
    try {
      leftPanel.textContent = "";
      // @ts-ignore — clear Lit's internal state to recover from marker corruption
      delete leftPanel["_$litPart$"];
      _render();
    } catch (e2) {
      console.error("left-panel retry failed:", e2);
    }
  }

  if (view.leftTab === "layers") {
    const sel = leftPanel.querySelector(".layer-row.selected");
    if (sel) sel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function _render() {
  const ctx = _ctx as LeftPanelCtx;
  const tab = view.leftTab;

  // ── Project-level panels: render based on projectState, independent of active tab ──

  if (tab === "files") {
    litRender(html`<div class="panel-body">${ctx.renderFilesTemplate()}</div>`, leftPanel);
    const tree = leftPanel.querySelector(".file-tree") as HTMLElement | null;
    if (tree) ctx.setupTreeKeyboard(tree);
    ctx.registerFileTreeDnD({ renderLeftPanel: render });
    return;
  }

  if (tab === "git") {
    const aTab = activeTab.value;
    const S = aTab ? { ui: aTab.session.ui } : { ui: {} };
    litRender(html`<div class="panel-body">${ctx.renderGitPanel(S, ctx)}</div>`, leftPanel);
    return;
  }

  if (tab === "blocks") {
    const content = renderElementsTemplate({
      webdata: ctx.webdata,
      defaultDef: ctx.defaultDef,
      rerender: render,
    } as Parameters<typeof renderElementsTemplate>[0]);
    litRender(html`<div class="panel-body">${content}</div>`, leftPanel);
    ctx.registerElementsDnD();
    ctx.registerComponentsDnD();
    return;
  }

  // ── Document-level panels: require an active tab ──

  const aTab = activeTab.value;
  if (!aTab) {
    litRender(html`<div class="panel-body"></div>`, leftPanel);
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
   */ ({
    ui: aTab.session.ui,
    document: aTab.doc.document,
    mode: aTab.doc.mode,
    selection: aTab.session.selection,
    canvas: aTab.session.canvas,
    content: aTab.doc.content,
    documentPath: aTab.documentPath,
  });

  /** @type {TemplateResult | typeof nothing} */
  let content;
  if (tab === "layers")
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
  else if (tab === "imports")
    content = ctx.renderImportsTemplate({
      renderLeftPanel: render,
      documentPath: S.documentPath,
      documentElements: S.document.$elements || [],
      applyMutation: (fn: (doc: object) => void) => {
        transact(activeTab.value, fn);
      },
    });
  else if (tab === "state")
    content = ctx.renderSignalsTemplate(S, {
      renderLeftPanel: render,
      renderCanvas: ctx.renderCanvas,
      updateSession,
    });
  else if (tab === "data")
    content = ctx.renderDataExplorerTemplate(S.document.state, S.canvas?.scope ?? null, {
      renderCanvas: ctx.renderCanvas,
      renderLeftPanel: render,
      defCategory: ctx.defCategory,
      defBadgeLabel: ctx.defBadgeLabel,
    });
  else if (tab === "head") {
    const isContent = S.mode === "content";
    const fm = S.content?.frontmatter ?? {};
    const headDoc = isContent ? { ...S.document, title: fm.title, $head: fm.$head } : S.document;
    content = ctx.renderHeadTemplate({
      document: headDoc,
      applyMutation: isContent
        ? (fn: (doc: object) => void) => {
            const tab = activeTab.value!;
            const fm = (tab.doc.content?.frontmatter ?? {}) as Record<string, unknown>;
            const fmHead = fm.$head as unknown[] | undefined;
            const tmp = { title: fm.title, $head: fmHead ? [...fmHead] : undefined };
            fn(tmp);
            if (tmp.title !== fm.title)
              mutateUpdateFrontmatter(tab, "title", tmp.title as JsonValue);
            const newHead = tmp.$head && tmp.$head.length > 0 ? tmp.$head : undefined;
            mutateUpdateFrontmatter(tab, "$head", /** @type {JsonValue} */ (newHead));
            render();
          }
        : (fn: (doc: object) => void) => {
            transact(activeTab.value, fn);
          },
      renderLeftPanel: render,
    });
  } else content = nothing;

  litRender(html`<div class="panel-body">${content}</div>`, leftPanel);

  // Post-render side effects
  if (tab === "layers" && ctx.getCanvasMode() !== "stylebook") ctx.registerLayersDnD();
}
