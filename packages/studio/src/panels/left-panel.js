/**
 * Left panel — orchestrator that delegates to per-tab render functions.
 *
 * Each sub-panel exports a render function that takes its dependencies as arguments and returns a
 * TemplateResult — the same pattern as imports-panel, signals-panel, etc. Only this orchestrator
 * uses mount/render/unmount because it owns the DOM root and error boundary.
 */

import { html, render as litRender, nothing } from "lit-html";
import {
  getState,
  leftPanel,
  updateSession,
  update,
  applyMutation,
  updateFrontmatter,
} from "../store.js";
import { ensureLitState } from "./shared.js";
import { renderLayersTemplate } from "./layers-panel.js";
import { renderStylebookLayersTemplate } from "./stylebook-layers-panel.js";
import { renderElementsTemplate } from "./elements-panel.js";
import { selectStylebookTag, stylebookMeta } from "./stylebook-panel.js";

/** @type {any} */
let _ctx = null;

/**
 * Mount the left panel orchestrator.
 *
 * @param {any} ctx — callbacks and references that avoid circular dependencies
 */
export function mount(ctx) {
  _ctx = ctx;
}

export function unmount() {
  _ctx = null;
}

export function render() {
  if (!_ctx) return;
  try {
    ensureLitState(leftPanel);
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
}

function _render() {
  const S = getState();
  const tab = S.ui.leftTab;

  /** @type {any} */
  let content;
  if (tab === "layers")
    content =
      _ctx.getCanvasMode() === "settings"
        ? renderStylebookLayersTemplate({
            selectStylebookTag,
            stylebookMeta,
          })
        : renderLayersTemplate({
            navigateToComponent: _ctx.navigateToComponent,
            rerender: render,
          });
  else if (tab === "imports")
    content = _ctx.renderImportsTemplate({
      renderLeftPanel: render,
      documentPath: S.documentPath,
      documentElements: S.document.$elements || [],
      applyMutation: (/** @type {any} */ fn) => {
        update(applyMutation(getState(), fn));
      },
    });
  else if (tab === "files") content = _ctx.renderFilesTemplate();
  else if (tab === "blocks")
    content = renderElementsTemplate({
      webdata: _ctx.webdata,
      defaultDef: _ctx.defaultDef,
      rerender: render,
    });
  else if (tab === "state")
    content = _ctx.renderSignalsTemplate(S, {
      renderLeftPanel: render,
      renderCanvas: _ctx.renderCanvas,
      updateSession,
    });
  else if (tab === "data")
    content = _ctx.renderDataExplorerTemplate(S.document.state, S.canvas?.scope ?? null, {
      renderCanvas: _ctx.renderCanvas,
      renderLeftPanel: render,
      defCategory: _ctx.defCategory,
      defBadgeLabel: _ctx.defBadgeLabel,
    });
  else if (tab === "head") {
    const isContent = S.mode === "content";
    const fm = S.content?.frontmatter ?? {};
    const headDoc = isContent ? { ...S.document, title: fm.title, $head: fm.$head } : S.document;
    content = _ctx.renderHeadTemplate({
      document: headDoc,
      applyMutation: isContent
        ? (/** @type {any} */ fn) => {
            const tmp = { title: fm.title, $head: fm.$head ? [...fm.$head] : undefined };
            fn(tmp);
            let s = getState();
            if (tmp.title !== fm.title) s = updateFrontmatter(s, "title", tmp.title);
            const newHead = tmp.$head && tmp.$head.length > 0 ? tmp.$head : undefined;
            s = updateFrontmatter(s, "$head", newHead);
            update(s);
          }
        : (/** @type {any} */ fn) => {
            update(applyMutation(getState(), fn));
          },
      renderLeftPanel: render,
    });
  } else if (tab === "git") content = _ctx.renderGitPanel(S, _ctx);
  else content = nothing;

  litRender(html`<div class="panel-body">${content}</div>`, /** @type {any} */ (leftPanel));

  // Post-render side effects
  if (tab === "layers" && _ctx.getCanvasMode() !== "settings") _ctx.registerLayersDnD();
  else if (tab === "imports") {
    /* no post-render DnD needed */
  } else if (tab === "blocks") {
    _ctx.registerElementsDnD();
    _ctx.registerComponentsDnD();
  } else if (tab === "files") {
    const tree = /** @type {any} */ (leftPanel)?.querySelector(".file-tree");
    if (tree) _ctx.setupTreeKeyboard(tree);
  }
}
