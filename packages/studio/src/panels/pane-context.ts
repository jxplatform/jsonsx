/// <reference lib="dom" />
/**
 * The pane's own chrome — region ⑦ (context bar) and region ⑩ (the floating zoom pod).
 *
 * This replaces `#tab-bar`, which was a 28px band styled identically to the tab strip above it,
 * holding **five unrelated axes** with no labels on any of them: a document-stack breadcrumb
 * (navigation), a zoom widget (viewport), route params and component test props (document data), a
 * colour-scheme switch and feature toggles (rendering state), and Export (a mode action). Plan §3.2
 * ⑦ replaces them with three axes that each say what they are:
 *
 * - **Editor kind** — `Canvas ⌄`, offering only the kinds this document declares
 *   ({@link editorKindsOf}), so the control can never contain a permanently dead entry. A document
 *   with one kind renders the name as text rather than as a dropdown that cannot go anywhere.
 * - **Canvas view** — `Edit │ Design │ Preview` as ONE segmented control with three values
 *   ({@link canvasViewsFor}). Preview stops being a toggle on a different bar with different visual
 *   grammar that silently composed with a base mode the switcher still showed as selected.
 * - **Rendering context** — `md ⌄ Light ⌄`, folding the size breakpoint, the colour scheme, the
 *   feature queries and the layout show/hide switch into one popover, with the document data a
 *   render resolves against — route params, component test props — labelled "resolving with" beside
 *   it. Per §2 principle 5 this control **only selects**; its footer is "Manage contexts…", which
 *   routes to the definition site — Project Settings › Contexts (`settings/contexts-section.ts`),
 *   the one place a breakpoint, a colour scheme or a feature query is defined.
 *
 * **The bar is not a grid row.** It renders inside the pane's own cell (`#pane-chrome`, stacked
 * over `#canvas-wrap`), because a per-pane surface cannot be a row of the application grid — the
 * second pane would have no way to have one. The stage is offset by {@link PANE_CONTEXT_VAR} rather
 * than by a track, and the zoom pod floats bottom-right over the canvas exactly as §3.2 ⑩ asks.
 *
 * **The read-only banner rides with the bar.** `collab/presence-chips.ts` wrote the sentence a
 * read-only guest needs before their first keystroke (§7.4); the surface that owes it a home is
 * this one, because it is the per-pane, per-document chrome that sits directly above the editing
 * surface. It is stacked under the bar inside `.pc-band` and the offset is MEASURED from that band
 * ({@link applyPaneContextOffset}), so a two-line banner pushes the stage down instead of covering
 * the document it is warning you about.
 *
 * Module shape follows `tab-strip.ts`: mount(host, ctx) → effectScope/effect → render().
 */

import { html, render as litRender, nothing } from "lit-html";
import { projectState, updateUi } from "../store";
import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";
import {
  canvasViewOf,
  canvasViewsFor,
  fitToScreen,
  getFit,
  resetZoom,
  setCanvasView,
  setEditZoom,
  setFit,
  setUserZoom,
} from "../canvas/canvas-utils";
import { editorKindOf, editorKindsOf, modeForEditorKind } from "../tabs/tab";
import { collabState } from "../collab/collab-state";
import { readOnlyBannerTemplate } from "../collab/presence-chips";
import { activeRegistry } from "../commands/active-registry";
import { getEffectiveLayoutPath, getEffectiveMedia } from "../site-context";
import { isSchemeQuery } from "../utils/canvas-media";
import { dynamicRouteParams, loadParamValues, pagePathsDef } from "../page-params";
import { componentPropEntries, isComponentDoc } from "../component-props";
import { mediaDisplayName } from "./shared";
import type { CanvasView, FitMode } from "../canvas/canvas-utils";
import { EDITOR_KIND_LABELS } from "../commands/context";
import type { EditorKind } from "../commands/context";
import type { ParamValues } from "../page-params";
import type { Tab } from "../tabs/tab";
import type { DocumentStackEntry, FormulaEditDef, FunctionEditDef, JsonValue } from "../types";
import type { EffectScope } from "@vue/reactivity";
import type { TemplateResult } from "lit-html";

/**
 * The CSS variable the stage is offset by while a context bar is on screen.
 *
 * The bar overlays the pane cell, so something has to keep the canvas out from under it. A variable
 * written by one projection is the same shape `applyDockLayout()` uses for the dock widths — and it
 * means "no tab open" costs the welcome screen no dead band.
 */
export const PANE_CONTEXT_VAR = "--pane-context-h";

/** The bar's height. Declared here because the offset projection and the stylesheet must agree. */
const PANE_CONTEXT_HEIGHT = 28;

export interface PaneContextCtx {
  navigateBack: () => void;
  navigateToLevel: (level: number) => void;
  closeFunctionEditor: () => void;
  closeFormulaWorkspace: () => void;
  exportFile: () => void;
  /** The EFFECTIVE canvas mode, `ui.preview` composed in. */
  getCanvasMode: () => string;
  /** Writes the BASE mode. The editor-kind dropdown and the view control both land here. */
  setCanvasMode: (mode: string) => void;
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

let _ctx: PaneContextCtx | null = null;

let _scope: EffectScope | null = null;

/** Human names for the three Canvas views. */
const CANVAS_VIEW_LABELS: Readonly<Record<CanvasView, string>> = {
  design: "Design",
  edit: "Edit",
  preview: "Preview",
};

/** The colour-scheme segment's values, labels and tooltips. */
const SCHEMES = [
  ["auto", "Auto", "Follow the OS color scheme"],
  ["light", "Light", "Force the light scheme"],
  ["dark", "Dark", "Force the dark scheme"],
] as const;

/**
 * Mount the pane chrome into its host.
 *
 * @param {HTMLElement} host
 * @param {PaneContextCtx} ctx
 */
export function mount(host: HTMLElement, ctx: PaneContextCtx) {
  _host = host;
  _ctx = ctx;
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (tab) {
        // Read reactive properties to establish tracking — mirrors the toolbar's subset.
        void tab.doc.document;
        void tab.doc.document?.$layout;
        void tab.doc.mode;
        void tab.documentPath;
        void tab.capabilities.modes;
        void tab.session.documentStack.length;
        void tab.session.ui.activeMedia;
        void tab.session.ui.canvasMode;
        void tab.session.ui.editZoom;
        void tab.session.ui.editingFormula;
        void tab.session.ui.editingFunction;
        void tab.session.ui.featureToggles;
        void tab.session.ui.preview;
        void tab.session.ui.previewColorScheme;
        void tab.session.ui.previewParams;
        void tab.session.ui.previewProps;
        void tab.session.ui.showLayout;
        void tab.session.ui.zoom;
        // The read-only banner (§7.4) is part of this chrome, so its two facts are tracked here
        // Too: a peer downgrading you mid-session must make the sentence appear, not wait for the
        // Next zoom.
        void collabState(tab).active;
        void collabState(tab).readOnly;
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
  applyPaneContextOffset(0);
}

/**
 * Keep the stage clear of the pane's top band.
 *
 * One projection, one variable — the canvas is offset only by what is actually rendered, so the
 * welcome screen (no tab, no bar) does not open under a 28px gap nothing explains, and a read-only
 * banner does not sit on top of the document it is warning you about.
 *
 * @param {number} height Band height in px. `0` when the pane has no chrome.
 */
export function applyPaneContextOffset(height: number): void {
  document.documentElement.style.setProperty(PANE_CONTEXT_VAR, `${height}px`);
}

/**
 * How tall the top band came out — the bar plus whatever banners rode with it.
 *
 * MEASURED rather than summed, because the banner's height is its wrapped text and only layout
 * knows how many lines that is. `offsetHeight` is 0 in a DOM with no layout engine (every unit
 * test), so the bar's declared height is the floor: the offset is then exactly what it was before
 * banners existed, which is the honest answer when nothing has been laid out.
 */
function topBandHeight(): number {
  const band = _host?.querySelector<HTMLElement>(".pc-band");
  return Math.max(band?.offsetHeight ?? 0, PANE_CONTEXT_HEIGHT);
}

/**
 * Whether this tab's editor has any of the bar's three axes to offer.
 *
 * Project Settings has none: it declares one editor kind, no canvas view, and no rendering context
 * — and the one control the bar WOULD contribute, "Manage contexts…", routes to a section of the
 * very document on screen. A bar of three inert controls above the definition site they point at is
 * chrome that says nothing, so the stage takes the whole pane.
 *
 * @param {Tab} tab
 * @returns {boolean}
 */
function wantsContextBar(tab: Tab): boolean {
  return tab.session.ui.canvasMode !== "settings";
}

export function render() {
  if (!_host || !_ctx) {
    return;
  }
  try {
    const tab = activeTab.value;
    const show = Boolean(tab) && wantsContextBar(tab as Tab);
    litRender(show ? paneChromeTemplate(tab as Tab, _ctx) : nothing, _host);
    applyPaneContextOffset(show ? topBandHeight() : 0);
  } catch (error) {
    console.error("pane-context render error:", error);
  }
}

/** One labelled axis. The label is the point: five unlabelled controls is what this replaces. */
function axisTpl(label: string, control: TemplateResult): TemplateResult {
  return html`
    <div class="pc-axis">
      <span class="pc-axis-label">${label}</span>
      ${control}
    </div>
  `;
}

function paneChromeTemplate(tab: Tab, ctx: PaneContextCtx): TemplateResult {
  const { ui } = tab.session;
  const editing = ui.editingFunction as FunctionEditDef | null;
  const formulaEditing = ui.editingFormula as FormulaEditDef | null;
  // A full-screen canvas takeover (function editor or formula workspace) owns the stage: the axes
  // Describe a document that is not the one on screen, and the zoom pod has nothing to zoom.
  const takeover = Boolean(editing) || Boolean(formulaEditing);
  const kind = editorKindOf(tab);

  return html`
    <div class="pc-band">
      <div class="pane-context" data-jx-region="pane.primary/context">
        ${navTpl(tab, ctx, editing, formulaEditing)}
        <div class="pc-spacer"></div>
        ${
          takeover
            ? nothing
            : html`
                ${editorKindTpl(tab, ctx)} ${kind === "canvas" ? viewTpl(tab, ctx) : nothing}
                ${renderingContextTpl(tab, ctx)} ${exportTpl(ctx)}
              `
        }
      </div>
      ${readOnlyBannerTemplate(tab)}
    </div>
    ${takeover ? nothing : zoomPodTpl(tab, ctx)}
  `;
}

// ─── ⑥ The navigation context (a jump bar's ancestor) ────────────────────────
// Still a Back button plus a breadcrumb: §3.2 ⑥ turns each segment into a dropdown, and that is a
// Surface of its own, not a detail of this one. It stays here, above the axes, so the takeover
// Editors keep the only exit they have.

function navTpl(
  tab: Tab,
  ctx: PaneContextCtx,
  editing: FunctionEditDef | null,
  formulaEditing: FormulaEditDef | null,
): TemplateResult | typeof nothing {
  const docName =
    tab.documentPath?.split("/").pop() || (tab.doc.document?.tagName as string) || "document";
  if (editing) {
    const funcLabel = editing.type === "def" ? `ƒ ${editing.defName}` : `ƒ ${editing.eventKey}`;
    return crumbTpl("Close editor", ctx.closeFunctionEditor, docName, funcLabel);
  }
  if (formulaEditing) {
    const formulaLabel =
      formulaEditing.type === "def"
        ? `fx ${formulaEditing.defName}`
        : `fx ${formulaEditing.eventKey}`;
    return crumbTpl("Close formula workspace", ctx.closeFormulaWorkspace, docName, formulaLabel);
  }
  const stack = tab.session.documentStack;
  if (!stack || stack.length === 0) {
    return nothing;
  }
  return html`
    <div class="breadcrumb">
      <sp-action-button size="s" title="Return to parent document" @click=${ctx.navigateBack}>
        <sp-icon-back slot="icon"></sp-icon-back>
        Back
      </sp-action-button>
      ${stack.map(
        (frame: DocumentStackEntry, i: number) => html`
          <span class="breadcrumb-item clickable" @click=${() => ctx.navigateToLevel(i)}
            >${frame.documentPath?.split("/").pop() || "untitled"}</span
          >
          <span class="breadcrumb-sep"> › </span>
        `,
      )}
      <span class="breadcrumb-item current">${docName}</span>
    </div>
  `;
}

function crumbTpl(
  closeTitle: string,
  close: () => void,
  docName: string,
  leaf: string,
): TemplateResult {
  return html`
    <div class="breadcrumb">
      <sp-action-button size="s" title=${closeTitle} @click=${close}>
        <sp-icon-back slot="icon"></sp-icon-back>
        Back
      </sp-action-button>
      <span class="breadcrumb-item">${docName}</span>
      <span class="breadcrumb-sep"> › </span>
      <span class="breadcrumb-item current">${leaf}</span>
    </div>
  `;
}

// ─── Axis 1 · Editor kind ────────────────────────────────────────────────────

function editorKindTpl(tab: Tab, ctx: PaneContextCtx): TemplateResult {
  const kinds = editorKindsOf(tab);
  const current = editorKindOf(tab);
  if (kinds.length < 2) {
    // One kind is not a choice. Rendering it as a dropdown would be a control that cannot move —
    // Which is the defect this axis exists to remove, in miniature.
    return axisTpl("Editor", html`<span class="pc-static">${EDITOR_KIND_LABELS[current]}</span>`);
  }
  return axisTpl(
    "Editor",
    html`
      <sp-picker
        size="s"
        quiet
        class="pc-editor-kind"
        label="Editor"
        value=${current}
        @change=${(e: Event) => {
          const kind = (e.target as HTMLInputElement).value as EditorKind;
          const mode = modeForEditorKind(tab, kind);
          if (!mode) {
            return;
          }
          tab.session.ui.preview = false;
          ctx.setCanvasMode(mode);
        }}
      >
        ${kinds.map(
          (kind) => html`<sp-menu-item value=${kind}>${EDITOR_KIND_LABELS[kind]}</sp-menu-item>`,
        )}
      </sp-picker>
    `,
  );
}

// ─── Axis 2 · Canvas view ────────────────────────────────────────────────────

function viewTpl(tab: Tab, ctx: PaneContextCtx): TemplateResult | typeof nothing {
  const views = canvasViewsFor(tab);
  if (views.length === 0) {
    return nothing;
  }
  const current = canvasViewOf(tab);
  return axisTpl(
    "View",
    html`
      <sp-action-group compact size="s" class="pc-view" role="radiogroup" aria-label="Canvas view">
        ${views.map(
          (value) => html`
            <sp-action-button
              size="s"
              role="radio"
              aria-checked=${value === current ? "true" : "false"}
              ?selected=${value === current}
              title=${`Show this document in ${CANVAS_VIEW_LABELS[value]}`}
              @click=${() => setCanvasView(tab, value, ctx.setCanvasMode)}
            >
              ${CANVAS_VIEW_LABELS[value]}
            </sp-action-button>
          `,
        )}
      </sp-action-group>
    `,
  );
}

// ─── Axis 3 · Rendering context ──────────────────────────────────────────────

/** Whether the open document is a page of a site project — pages get route params, others props. */
function isPageDoc(tab: Tab): boolean {
  const path = tab.documentPath;
  return Boolean(
    path &&
    projectState?.isSiteProject &&
    (path.startsWith("pages/") || path.startsWith("./pages/")),
  );
}

function renderingContextTpl(tab: Tab, ctx: PaneContextCtx): TemplateResult {
  const { ui } = tab.session;
  const { featureQueries, sizeBreakpoints } = ctx.parseMediaEntries(
    getEffectiveMedia(tab.doc.document?.$media as Record<string, string> | undefined),
  );
  const schemeQueries = featureQueries.filter(({ query }) => isSchemeQuery(query));
  const plainQueries = featureQueries.filter(({ query }) => !isSchemeQuery(query));
  const scheme = (ui.previewColorScheme ?? "auto") as string;
  const activeMedia = (ui.activeMedia ?? null) as string | null;
  const sizeLabel = activeMedia ? mediaDisplayName(activeMedia) : "Base";
  const schemeLabel = SCHEMES.find(([value]) => value === scheme)?.[1] ?? "Auto";
  const summary = schemeQueries.length > 0 ? `${sizeLabel} · ${schemeLabel}` : sizeLabel;
  const hasLayout = isPageDoc(tab) && Boolean(getEffectiveLayoutPath(tab.doc.document?.$layout));
  const resolving = isPageDoc(tab) ? paramPickersTpl(tab) : propFieldsTpl(tab);

  return axisTpl(
    "Context",
    html`
      ${resolvingTpl(resolving)}
      <overlay-trigger placement="bottom-end" triggered-by="click">
        <sp-action-button
          slot="trigger"
          size="s"
          quiet
          class="pc-context-trigger"
          title="What this document is being rendered with"
        >
          ${summary} ⌄
        </sp-action-button>
        <sp-popover slot="click-content" tip class="pc-context-popover">
          <div class="pc-ctx">
            ${sizeGroupTpl(sizeBreakpoints, activeMedia)}
            ${
              schemeQueries.length > 0
                ? groupTpl(
                    "Color scheme",
                    html`
                      <sp-action-group compact size="s">
                        ${SCHEMES.map(
                          ([value, label, title]) => html`
                            <sp-action-button
                              size="s"
                              role="radio"
                              aria-checked=${scheme === value ? "true" : "false"}
                              title=${title}
                              ?selected=${scheme === value}
                              @click=${() => updateUi("previewColorScheme", value)}
                            >
                              ${label}
                            </sp-action-button>
                          `,
                        )}
                      </sp-action-group>
                    `,
                  )
                : nothing
            }
            ${
              plainQueries.length > 0
                ? groupTpl(
                    "Features",
                    html`
                      <sp-action-group compact size="s">
                        ${plainQueries.map(
                          ({ name, query }) => html`
                            <sp-action-button
                              size="s"
                              toggles
                              title=${query}
                              ?selected=${Boolean(ui.featureToggles[name])}
                              @click=${() => {
                                updateUi("featureToggles", {
                                  ...tab.session.ui.featureToggles,
                                  [name]: !tab.session.ui.featureToggles[name],
                                });
                              }}
                            >
                              ${mediaDisplayName(name)}
                            </sp-action-button>
                          `,
                        )}
                      </sp-action-group>
                    `,
                  )
                : nothing
            }
            ${
              hasLayout
                ? groupTpl(
                    "Layout",
                    html`
                      <sp-switch
                        size="s"
                        class="pc-layout-switch"
                        ?checked=${ui.showLayout !== false}
                        @change=${() => updateUi("showLayout", tab.session.ui.showLayout === false)}
                      >
                        Show layout elements
                      </sp-switch>
                    `,
                  )
                : nothing
            }
            <button
              class="pc-ctx-manage"
              type="button"
              title="Breakpoints, schemes and feature queries are defined in Project Settings › Contexts"
              @click=${() => {
                void activeRegistry()?.run("settings.open", { section: "contexts" });
              }}
            >
              Manage contexts…
            </button>
          </div>
        </sp-popover>
      </overlay-trigger>
    `,
  );
}

/**
 * `resolving with count 3` — the document DATA a render resolves against, on the bar.
 *
 * §4.2 folds these in behind the words "resolving with…", and the label is where that lands. The
 * VALUES stay on the bar rather than inside the popover, and the reason is the screenshot contract
 * doing its job as a design instrument (§13.1): behind a click, the one first-hour flow the docs
 * teach — typing a test prop on `start/first-component` — needs a second gesture to reach, and the
 * manifest's input budget may only ratchet down. A control that costs a picture an extra click
 * costs every reader one too.
 */
function resolvingTpl(body: TemplateResult | typeof nothing): TemplateResult | typeof nothing {
  if (body === nothing) {
    return nothing;
  }
  return html`
    <span class="pc-resolving">
      <span class="pc-resolving-label">resolving with</span>
      ${body}
    </span>
  `;
}

/** One labelled group inside the rendering-context popover. */
function groupTpl(label: string, body: TemplateResult): TemplateResult {
  return html`
    <div class="pc-ctx-group">
      <span class="pc-ctx-label">${label}</span>
      ${body}
    </div>
  `;
}

/**
 * The size segment: the base width plus every declared size breakpoint.
 *
 * It writes `ui.activeMedia`, the same field a canvas panel header click writes — one axis, one
 * field, two ways in. `null` is the base, which is why the list is not simply the breakpoints.
 */
function sizeGroupTpl(
  breakpoints: { name: string; width: number }[],
  activeMedia: string | null,
): TemplateResult {
  return groupTpl(
    "Size",
    html`
      <sp-action-group compact size="s" class="pc-sizes">
        <sp-action-button
          size="s"
          role="radio"
          aria-checked=${activeMedia === null ? "true" : "false"}
          title="The base rendering, with no breakpoint applied"
          ?selected=${activeMedia === null}
          @click=${() => updateUi("activeMedia", null)}
        >
          Base
        </sp-action-button>
        ${breakpoints.map(
          ({ name, width }) => html`
            <sp-action-button
              size="s"
              role="radio"
              aria-checked=${activeMedia === name ? "true" : "false"}
              title=${`${mediaDisplayName(name)} — ${width}px`}
              ?selected=${activeMedia === name}
              @click=${() => updateUi("activeMedia", name)}
            >
              ${mediaDisplayName(name)}
            </sp-action-button>
          `,
        )}
      </sp-action-group>
    `,
  );
}

// ─── The mode action ─────────────────────────────────────────────────────────
// Export is not an axis, and it is the one control in the old bar with nowhere to go yet: retiring
// It without a command name, a chord and a residue would be deletion, not consolidation (§2
// Principle 9). It stays in the Code view's trailing slot until the Code editor kind owns an action
// Strip of its own.

function exportTpl(ctx: PaneContextCtx): TemplateResult | typeof nothing {
  if (ctx.getCanvasMode() !== "source") {
    return nothing;
  }
  return html`
    <sp-action-button size="s" class="pc-export" @click=${ctx.exportFile}>
      <sp-icon-export slot="icon"></sp-icon-export>
      Export
    </sp-action-button>
  `;
}

// ─── ⑩ The floating zoom pod ─────────────────────────────────────────────────

/** The fit entries the pod offers, in menu order. `1` is "actual size", a numeric fit. */
const FIT_CHOICES: readonly { value: string; fit: FitMode; label: string }[] = [
  { fit: "page", label: "Fit page", value: "page" },
  { fit: "width", label: "Fit width", value: "width" },
  { fit: 1, label: "Actual size", value: "actual" },
  { fit: "none", label: "No fit", value: "none" },
];

/** Which entry the pod shows as chosen — a numeric fit reads as "actual size" only at 1. */
function fitChoiceValue(fit: FitMode): string {
  if (typeof fit === "number") {
    return fit === 1 ? "actual" : "";
  }
  return fit;
}

/**
 * Zoom and fit, floating over the canvas bottom-right.
 *
 * Two surfaces, one control: `edit` drives the content-reflow `editZoom`, while design / Stylebook
 * / git-diff render on the panzoom surface and drive `ui.zoom` — and only the panzoom surface has a
 * fit, because a fit is a statement about an artboard. Preview is deliberately absent: its frame is
 * a real viewport that scrolls its own document, so there is nothing to zoom.
 */
function zoomPodTpl(tab: Tab, ctx: PaneContextCtx): TemplateResult | typeof nothing {
  const mode = ctx.getCanvasMode();
  if (mode === "edit") {
    const editZoom = tab.session.ui.editZoom ?? 1;
    return podTpl(html`
      ${zoomButton("Zoom out (Ctrl+-)", "−", () =>
        setEditZoom((tab.session.ui.editZoom ?? 1) / 1.2),
      )}
      <sp-action-button
        size="s"
        class="pc-zoom-label"
        title="Reset to 100% (Ctrl+0)"
        @click=${() => setEditZoom(1)}
      >
        ${Math.round(editZoom * 100)}%
      </sp-action-button>
      ${zoomButton("Zoom in (Ctrl+=)", "+", () => setEditZoom((tab.session.ui.editZoom ?? 1) * 1.2))}
    `);
  }
  if (mode !== "design" && mode !== "stylebook" && mode !== "git-diff") {
    return nothing;
  }
  const zoom = tab.session.ui.zoom ?? 1;
  const chosen = fitChoiceValue(getFit());
  return podTpl(html`
    ${zoomButton("Zoom out (Ctrl+-)", "−", () => setUserZoom((tab.session.ui.zoom ?? 1) / 1.2))}
    <sp-action-button
      size="s"
      class="pc-zoom-label"
      title="Reset to 100% (Ctrl+0)"
      @click=${() => resetZoom()}
    >
      ${Math.round(zoom * 100)}%
    </sp-action-button>
    ${zoomButton("Zoom in (Ctrl+=)", "+", () => setUserZoom((tab.session.ui.zoom ?? 1) * 1.2))}
    <sp-picker
      size="s"
      quiet
      class="pc-fit"
      label="Fit"
      value=${chosen}
      title="How this document is framed"
      @change=${(e: Event) => {
        const { value } = e.target as HTMLInputElement;
        const choice = FIT_CHOICES.find((entry) => entry.value === value);
        if (!choice) {
          return;
        }
        // "Fit page" from the control may magnify a small artboard past life size; the fit APPLIED
        // On arrival never does. Same declared state, two caps — see fitToScreen's maxZoom.
        if (choice.fit === "page") {
          fitToScreen();
          return;
        }
        setFit(choice.fit);
      }}
    >
      ${FIT_CHOICES.map(
        ({ value, label }) => html`<sp-menu-item value=${value}>${label}</sp-menu-item>`,
      )}
    </sp-picker>
  `);
}

function podTpl(body: TemplateResult): TemplateResult {
  return html`
    <div class="pane-zoom" data-jx-region="pane.primary/zoom">
      <sp-action-group compact size="s">${body}</sp-action-group>
    </div>
  `;
}

function zoomButton(title: string, glyph: string, onClick: () => void): TemplateResult {
  return html`
    <sp-action-button size="s" title=${title} @click=${onClick}>${glyph}</sp-action-button>
  `;
}

// ─── Dynamic route-param pickers ─────────────────────────────────────────────
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
          class="pc-param"
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

// ─── Component test-prop fields ──────────────────────────────────────────────
// The previewParams mirror for component docs: one small field per prop entry (the doc's
// Plain-data state entries), committed on change so typing never re-renders the bar mid-edit. A
// Value parses as JSON when it can (numbers, booleans, arrays) and falls back to the raw string;
// Clearing a field removes the override so the prop returns to its authored default.

/**
 * @param {string} raw
 * @returns {JsonValue}
 */
function parsePropValue(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

/**
 * @param {Tab} tab
 * @returns {TemplateResult | typeof nothing}
 */
function propFieldsTpl(tab: Tab): TemplateResult | typeof nothing {
  const doc = tab.doc.document;
  if (!isComponentDoc(doc)) {
    return nothing;
  }
  const entries = componentPropEntries(doc);
  if (entries.length === 0) {
    return nothing;
  }
  const { previewProps } = tab.session.ui;
  const display = (v: JsonValue | undefined) =>
    v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return html`
    ${entries.map(
      ({ name }) => html`
        <sp-textfield
          size="s"
          quiet
          class="pc-prop"
          data-jx-region=${`pane.primary/prop:${name}`}
          placeholder=${name}
          title=${`Test value for ${name}`}
          .value=${display(previewProps?.[name])}
          @change=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            const next = { ...tab.session.ui.previewProps };
            if (raw === "") {
              delete next[name];
            } else {
              next[name] = parsePropValue(raw);
            }
            updateUi("previewProps", Object.keys(next).length > 0 ? next : null);
          }}
        ></sp-textfield>
      `,
    )}
  `;
}
