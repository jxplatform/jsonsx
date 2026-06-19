/// <reference lib="dom" />
/**
 * Tab bar — a per-tab contextual action bar rendered between the tab strip and the edit content.
 * Standardizes Back/breadcrumb navigation, media feature toggles, and mode actions (Code-mode
 * Export) into a single bar shared identically by every edit mode.
 *
 * Follows the same module shape as tab-strip.ts: mount(host, ctx) → effectScope/effect → render().
 * The bar collapses (renders `nothing`, so `#tab-bar:empty` hides the row) when there is nothing
 * contextual to show.
 */

import { html, render as litRender, nothing } from "lit-html";
import { updateUi } from "../store";
import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";
import { getEffectiveMedia } from "../site-context";
import { mediaDisplayName } from "./shared";
import type { DocumentStackEntry, FunctionEditDef } from "../types";
import type { EffectScope } from "@vue/reactivity";
import type { TemplateResult } from "lit-html";

interface TabBarCtx {
  navigateBack: () => void;
  navigateToLevel: (level: number) => void;
  closeFunctionEditor: () => void;
  exportFile: () => void;
  getCanvasMode: () => string;
  parseMediaEntries: (media: Record<string, string> | null | undefined) => {
    sizeBreakpoints: {
      name: string;
      query: string;
      width: number;
      type: string;
    }[];
    featureQueries: { name: string; query: string }[];
    baseWidth: number;
  };
}

let _host: HTMLElement | null = null;

let _ctx: TabBarCtx | null = null;

let _scope: EffectScope | null = null;

/**
 * Mount the tab bar into the given host element.
 *
 * @param {HTMLElement} host
 * @param {TabBarCtx} ctx
 */
export function mount(host: HTMLElement, ctx: TabBarCtx) {
  _host = host;
  _ctx = ctx;
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (tab) {
        // Read reactive properties to establish tracking — mirrors the toolbar's subset
        void tab.doc.document;
        void tab.doc.mode;
        void tab.documentPath;
        void tab.session.documentStack.length;
        void tab.session.ui.canvasMode;
        void tab.session.ui.editingFunction;
        void tab.session.ui.featureToggles;
      }
      render();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  _host = null;
  _ctx = null;
}

export function render() {
  if (!_host || !_ctx) {
    return;
  }
  try {
    litRender(tabBarTemplate(_ctx), _host);
  } catch (error) {
    console.error("tab-bar render error:", error);
  }
}

function tabBarTemplate(ctx: TabBarCtx): TemplateResult | typeof nothing {
  const tab = activeTab.value;
  if (!tab) {
    return nothing;
  }

  const S = {
    document: tab.doc.document,
    documentPath: tab.documentPath,
    documentStack: tab.session.documentStack,
    ui: tab.session.ui,
  };
  const canvasMode = ctx.getCanvasMode();
  const editing = S.ui.editingFunction as FunctionEditDef | null;
  const hasStack = S.documentStack && S.documentStack.length > 0;

  // ── Left region: navigation context (function editor takes precedence over the stack) ──
  let navTpl: TemplateResult | typeof nothing = nothing;
  if (editing) {
    const docName = S.documentPath?.split("/").pop() || S.document?.tagName || "document";
    const funcLabel = editing.type === "def" ? `ƒ ${editing.defName}` : `ƒ ${editing.eventKey}`;
    navTpl = html`
      <div class="breadcrumb">
        <sp-action-button size="s" title="Close editor" @click=${ctx.closeFunctionEditor}>
          <sp-icon-back slot="icon"></sp-icon-back>
          Back
        </sp-action-button>
        <span class="breadcrumb-item">${docName}</span>
        <span class="breadcrumb-sep"> › </span>
        <span class="breadcrumb-item current">${funcLabel}</span>
      </div>
    `;
  } else if (hasStack) {
    navTpl = html`
      <div class="breadcrumb">
        <sp-action-button size="s" title="Return to parent document" @click=${ctx.navigateBack}>
          <sp-icon-back slot="icon"></sp-icon-back>
          Back
        </sp-action-button>
        ${S.documentStack.map(
          (frame: DocumentStackEntry, i: number) => html`
            <span class="breadcrumb-item clickable" @click=${() => ctx.navigateToLevel(i)}
              >${frame.documentPath?.split("/").pop() || "untitled"}</span
            >
            <span class="breadcrumb-sep"> › </span>
          `,
        )}
        <span class="breadcrumb-item current">
          ${S.documentPath?.split("/").pop() || S.document?.tagName || "document"}
        </span>
      </div>
    `;
  }

  // ── Right region: media feature toggles ──
  const { featureQueries } = ctx.parseMediaEntries(getEffectiveMedia(S.document?.$media));
  const togglesTpl =
    featureQueries.length > 0
      ? html`
          <sp-action-group compact size="s">
            ${featureQueries.map(
              ({ name, query }: { name: string; query: string }) => html`
                <sp-action-button
                  toggles
                  size="s"
                  title=${query}
                  ?selected=${Boolean(S.ui.featureToggles[name])}
                  @click=${() => {
                    const newToggles = {
                      ...S.ui.featureToggles,
                      [name]: !S.ui.featureToggles[name],
                    };
                    updateUi("featureToggles", newToggles);
                  }}
                >
                  ${mediaDisplayName(name)}
                </sp-action-button>
              `,
            )}
          </sp-action-group>
        `
      : nothing;

  // ── Right region: mode actions (Code-mode Export) ──
  const exportTpl =
    !editing && canvasMode === "source"
      ? html`
          <sp-action-button size="s" @click=${ctx.exportFile}>
            <sp-icon-export slot="icon"></sp-icon-export>
            Export
          </sp-action-button>
        `
      : nothing;

  // Collapse the bar entirely when there is nothing contextual to show.
  if (navTpl === nothing && togglesTpl === nothing && exportTpl === nothing) {
    return nothing;
  }

  return html`
    <div class="tab-bar">
      ${navTpl}
      <div class="tb-spacer"></div>
      ${togglesTpl} ${exportTpl}
    </div>
  `;
}
