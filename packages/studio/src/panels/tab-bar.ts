/// <reference lib="dom" />
/**
 * Tab bar — a persistent per-tab settings bar rendered between the tab strip and the edit content.
 * Standardizes Back/breadcrumb navigation, the view settings cluster (preview toggle, layout
 * visibility, dynamic route-param pickers — shown in the edit/design base modes), media feature
 * toggles, and mode actions (Code-mode Export) into a single bar shared by every edit mode.
 *
 * Follows the same module shape as tab-strip.ts: mount(host, ctx) → effectScope/effect → render().
 * The bar renders `nothing` (so `#tab-bar:empty` hides the row) only when no tab is active.
 */

import { html, render as litRender, nothing } from "lit-html";
import { projectState, updateUi } from "../store";
import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";
import { applyTransform, fitToScreen, resetZoom, setEditZoom } from "../canvas/canvas-utils";
import { getEffectiveLayoutPath, getEffectiveMedia } from "../site-context";
import { dynamicRouteParams, loadParamValues, pagePathsDef } from "../page-params";
import { mediaDisplayName } from "./shared";
import type { ParamValues } from "../page-params";
import type { Tab } from "../tabs/tab";
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
        void tab.doc.document?.$layout;
        void tab.doc.mode;
        void tab.documentPath;
        void tab.session.documentStack.length;
        void tab.session.ui.canvasMode;
        void tab.session.ui.editZoom;
        void tab.session.ui.editingFunction;
        void tab.session.ui.featureToggles;
        void tab.session.ui.preview;
        void tab.session.ui.previewParams;
        void tab.session.ui.showLayout;
        void tab.session.ui.zoom;
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

  // ── Left region: zoom widget (every mode with a zoom concept) ──
  // Gates on the EFFECTIVE mode: edit drives the content-reflow `editZoom`, while design /
  // Stylebook / git-diff / preview all render on the panzoom surface and drive `ui.zoom` (with the
  // Panzoom-only fit-to-screen action).
  let zoomTpl: TemplateResult | typeof nothing = nothing;
  if (!editing && canvasMode === "edit") {
    const editZoom = S.ui.editZoom ?? 1;
    zoomTpl = html`
      <sp-action-group compact size="s" class="tb-zoom">
        <sp-action-button
          size="s"
          title="Zoom out (Ctrl+-)"
          @click=${() => setEditZoom((tab.session.ui.editZoom ?? 1) / 1.2)}
        >
          −
        </sp-action-button>
        <sp-action-button
          size="s"
          class="tb-zoom-label"
          title="Reset to 100% (Ctrl+0)"
          @click=${() => setEditZoom(1)}
        >
          ${Math.round(editZoom * 100)}%
        </sp-action-button>
        <sp-action-button
          size="s"
          title="Zoom in (Ctrl+=)"
          @click=${() => setEditZoom((tab.session.ui.editZoom ?? 1) * 1.2)}
        >
          +
        </sp-action-button>
      </sp-action-group>
    `;
  } else if (
    !editing &&
    (canvasMode === "design" ||
      canvasMode === "stylebook" ||
      canvasMode === "git-diff" ||
      canvasMode === "preview")
  ) {
    const zoom = S.ui.zoom ?? 1;
    const setPanZoom = (next: number) => {
      tab.session.ui.zoom = Math.min(5, Math.max(0.05, next));
      applyTransform();
    };
    zoomTpl = html`
      <sp-action-group compact size="s" class="tb-zoom">
        <sp-action-button
          size="s"
          title="Zoom out (Ctrl+-)"
          @click=${() => setPanZoom((tab.session.ui.zoom ?? 1) / 1.2)}
        >
          −
        </sp-action-button>
        <sp-action-button
          size="s"
          class="tb-zoom-label"
          title="Reset to 100% (Ctrl+0)"
          @click=${() => resetZoom()}
        >
          ${Math.round(zoom * 100)}%
        </sp-action-button>
        <sp-action-button
          size="s"
          title="Zoom in (Ctrl+=)"
          @click=${() => setPanZoom((tab.session.ui.zoom ?? 1) * 1.2)}
        >
          +
        </sp-action-button>
        <sp-action-button size="s" title="Fit to screen" @click=${() => fitToScreen()}>
          Fit
        </sp-action-button>
      </sp-action-group>
    `;
  }

  // ── Right region: view settings cluster (edit/design base modes only) ──
  // Gates on the BASE mode (not the effective mode): the cluster stays visible while the preview
  // Toggle is on so it can be toggled back off.
  const baseMode = S.ui.canvasMode;
  const isPage = Boolean(
    S.documentPath &&
    projectState?.isSiteProject &&
    (S.documentPath.startsWith("pages/") || S.documentPath.startsWith("./pages/")),
  );
  let settingsTpl: TemplateResult | typeof nothing = nothing;
  if (!editing && (baseMode === "edit" || baseMode === "design")) {
    const canPreview = tab.capabilities.modes.includes("preview");
    const hasLayout = isPage && Boolean(getEffectiveLayoutPath(S.document?.$layout));
    const pickersTpl = isPage ? paramPickersTpl(tab) : nothing;
    const previewTpl = canPreview
      ? html`
          <sp-action-button
            toggles
            size="s"
            title="Preview resolved values"
            ?selected=${Boolean(S.ui.preview)}
            @click=${() => updateUi("preview", !S.ui.preview)}
          >
            <sp-icon-preview slot="icon"></sp-icon-preview>
            Preview
          </sp-action-button>
        `
      : nothing;
    const layoutTpl = hasLayout
      ? html`
          <sp-action-button
            toggles
            size="s"
            title="Show layout elements"
            ?selected=${S.ui.showLayout !== false}
            @click=${() => updateUi("showLayout", S.ui.showLayout === false)}
          >
            Layout
          </sp-action-button>
        `
      : nothing;
    if (pickersTpl !== nothing || previewTpl !== nothing || layoutTpl !== nothing) {
      settingsTpl = html`
        ${pickersTpl}
        <sp-action-group compact size="s">${layoutTpl} ${previewTpl}</sp-action-group>
      `;
    }
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

  return html`
    <div class="tab-bar">
      ${navTpl} ${zoomTpl}
      <div class="tb-spacer"></div>
      ${settingsTpl} ${togglesTpl} ${exportTpl}
    </div>
  `;
}

// ── Dynamic route-param pickers ──────────────────────────────────────────────
// Candidate values load asynchronously (ContentCollection resolution / data-file read); the module
// Caches the last result per (documentPath, $paths) and re-renders when it lands — the same lazy
// Fill pattern as head-panel's loadLayoutEntries. When values arrive, any param without a chosen
// Value auto-selects the first candidate (matching the compiler, whose first expanded route is the
// First path entry).

let _paramValues: ParamValues | null = null;

let _paramValuesKey: string | null = null;

/**
 * @param {Tab} tab
 * @returns {ParamValues | null} — null while loading (or when the doc declares no params)
 */
function paramValuesFor(tab: Tab): ParamValues | null {
  const pathsDef = pagePathsDef({
    document: tab.doc.document,
    frontmatter: tab.doc.content.frontmatter,
  });
  if (!pathsDef && dynamicRouteParams(tab.documentPath).length === 0) {
    return null;
  }
  const key = `${tab.documentPath ?? ""}::${JSON.stringify(pathsDef)}`;
  if (_paramValuesKey === key) {
    return _paramValues;
  }
  _paramValuesKey = key;
  _paramValues = null;
  void loadParamValues(tab.documentPath, pathsDef).then((values) => {
    if (_paramValuesKey !== key || activeTab.value !== tab) {
      return;
    }
    _paramValues = values;
    autoSelectParams(tab, values);
    render();
  });
  return _paramValues;
}

/**
 * @param {Tab} tab
 * @param {ParamValues} values
 */
function autoSelectParams(tab: Tab, values: ParamValues) {
  const current = tab.session.ui.previewParams ?? {};
  const additions: Record<string, string> = {};
  for (const [name, list] of Object.entries(values)) {
    if (!current[name] && list.length > 0) {
      additions[name] = list[0]!;
    }
  }
  if (Object.keys(additions).length > 0) {
    updateUi("previewParams", { ...current, ...additions });
  }
}

/**
 * @param {Tab} tab
 * @returns {TemplateResult | typeof nothing}
 */
function paramPickersTpl(tab: Tab): TemplateResult | typeof nothing {
  const values = paramValuesFor(tab);
  const names = new Set(dynamicRouteParams(tab.documentPath));
  for (const name of Object.keys(values ?? {})) {
    names.add(name);
  }
  if (names.size === 0) {
    return nothing;
  }
  const { previewParams } = tab.session.ui;
  return html`
    ${[...names].map(
      (name) => html`
        <sp-picker
          size="s"
          quiet
          class="tab-bar-param"
          label=${name}
          title=${`Preview value for [${name}]`}
          value=${previewParams?.[name] ?? ""}
          @change=${(e: Event) => {
            const { value } = e.target as HTMLInputElement;
            updateUi("previewParams", { ...tab.session.ui.previewParams, [name]: value });
          }}
        >
          ${(values?.[name] ?? []).map(
            (v: string) => html`<sp-menu-item value=${v}>${v}</sp-menu-item>`,
          )}
        </sp-picker>
      `,
    )}
  `;
}
