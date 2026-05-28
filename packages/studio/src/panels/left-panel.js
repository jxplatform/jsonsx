/**
 * Left panel — orchestrator that delegates to per-tab render functions.
 *
 * Each sub-panel exports a render function that takes its dependencies as arguments and returns a
 * TemplateResult — the same pattern as imports-panel, signals-panel, etc. Only this orchestrator
 * uses mount/render/unmount because it owns the DOM root and error boundary.
 */

import { html, render as litRender, nothing } from "lit-html";
import { leftPanel, updateSession } from "../store.js";
import { effect, effectScope } from "../reactivity.js";
import { activeTab } from "../workspace/workspace.js";
import { view } from "../view.js";
import { transact, mutateUpdateFrontmatter } from "../tabs/transact.js";

import { renderLayersTemplate } from "./layers-panel.js";
import { renderStylebookLayersTemplate } from "./stylebook-layers-panel.js";
import { renderElementsTemplate } from "./elements-panel.js";
import { selectStylebookTag, stylebookMeta } from "./stylebook-panel.js";

/** @typedef {import("lit-html").TemplateResult} TemplateResult */

/**
 * @typedef {{
 *   getCanvasMode: () => string;
 *   setCanvasMode: (mode: string) => void;
 *   renderImportsTemplate: Function;
 *   renderFilesTemplate: Function;
 *   renderSignalsTemplate: Function;
 *   renderDataExplorerTemplate: Function;
 *   renderHeadTemplate: Function;
 *   renderGitPanel: Function;
 *   renderCanvas: () => void;
 *   defCategory: (def: unknown) => string;
 *   defBadgeLabel: (def: unknown) => string;
 *   navigateToComponent: (path: string) => void;
 *   webdata: object;
 *   defaultDef: (tag: string) => object;
 *   registerLayersDnD: () => void;
 *   registerElementsDnD: () => void;
 *   registerComponentsDnD: () => void;
 *   setupTreeKeyboard: (tree: HTMLElement) => void;
 *   registerFileTreeDnD: (ctx: { renderLeftPanel: () => void }) => void;
 *   setGitDiffState: (state: import("../canvas/canvas-render.js").GitDiffState | null) => void;
 *   cloneRepository?: () => void;
 * }} LeftPanelCtx
 */

/** @type {LeftPanelCtx | null} */
let _ctx = null;

/** @type {import("@vue/reactivity").EffectScope | null} */
let _scope = null;

let _rendering = false;
let _scheduled = false;

/**
 * Mount the left panel orchestrator.
 *
 * @param {LeftPanelCtx} ctx
 */
export function mount(ctx) {
  _ctx = ctx;
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
}

export function render() {
  if (!_ctx) return;
  if (_rendering) return;
  if (!_scheduled) {
    _scheduled = true;
    queueMicrotask(_flush);
  }
}

function _flush() {
  _scheduled = false;
  if (!_ctx) return;
  if (_rendering) return;
  _rendering = true;
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
  } finally {
    _rendering = false;
  }

  if (view.leftTab === "layers") {
    const sel = leftPanel.querySelector(".layer-row.selected");
    if (sel) sel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function _render() {
  const ctx = /** @type {LeftPanelCtx} */ (_ctx);
  const tab = view.leftTab;

  // ── Project-level panels: render based on projectState, independent of active tab ──

  if (tab === "files") {
    litRender(html`<div class="panel-body">${ctx.renderFilesTemplate()}</div>`, leftPanel);
    const tree = /** @type {HTMLElement | null} */ (leftPanel.querySelector(".file-tree"));
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
    const content = renderElementsTemplate(
      /** @type {Parameters<typeof renderElementsTemplate>[0]} */ ({
        webdata: ctx.webdata,
        defaultDef: ctx.defaultDef,
        rerender: render,
      }),
    );
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
        ? renderStylebookLayersTemplate(
            /** @type {Parameters<typeof renderStylebookLayersTemplate>[0]} */ ({
              selectStylebookTag,
              stylebookMeta,
            }),
          )
        : renderLayersTemplate({
            navigateToComponent: ctx.navigateToComponent,
            rerender: render,
          });
  else if (tab === "imports")
    content = ctx.renderImportsTemplate({
      renderLeftPanel: render,
      documentPath: S.documentPath,
      documentElements: S.document.$elements || [],
      applyMutation: (/** @type {(doc: object) => void} */ fn) => {
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
        ? (/** @type {(doc: object) => void} */ fn) => {
            const tab = activeTab.value;
            const fm = /** @type {Record<string, unknown>} */ (tab.doc.content?.frontmatter ?? {});
            const fmHead = /** @type {unknown[] | undefined} */ (fm.$head);
            const tmp = { title: fm.title, $head: fmHead ? [...fmHead] : undefined };
            fn(tmp);
            if (tmp.title !== fm.title)
              mutateUpdateFrontmatter(tab, "title", /** @type {JsonValue} */ (tmp.title));
            const newHead = tmp.$head && tmp.$head.length > 0 ? tmp.$head : undefined;
            mutateUpdateFrontmatter(tab, "$head", /** @type {JsonValue} */ (newHead));
            render();
          }
        : (/** @type {(doc: object) => void} */ fn) => {
            transact(activeTab.value, fn);
          },
      renderLeftPanel: render,
    });
  } else content = nothing;

  litRender(html`<div class="panel-body">${content}</div>`, leftPanel);

  // Post-render side effects
  if (tab === "layers" && ctx.getCanvasMode() !== "stylebook") ctx.registerLayersDnD();
}
