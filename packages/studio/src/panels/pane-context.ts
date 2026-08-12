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
 * - **Editor kind** — `Canvas ⌄`, offering only the kinds this document declares AND its pane can
 *   host ({@link hostableKindsOf}), so the control can never contain a permanently dead entry. A
 *   document with one kind renders the name as text rather than as a dropdown that cannot go
 *   anywhere.
 * - **Canvas view** — `Edit │ Design` as a radio ({@link canvasBaseViewsFor}) with a **Preview**
 *   toggle beside it ({@link previewStateOf}), and none at all in a pane that may not host the
 *   Canvas. The two are drawn apart because they are two axes: preview is a flag over an edit or
 *   design base, so the radio marks the base throughout and the toggle says whether it is on.
 * - **Rendering context** — `md ⌄ Light ⌄`, folding the size breakpoint, the colour scheme, the
 *   feature queries and the layout show/hide switch into one popover. Per §2 principle 5 this
 *   control **only selects**; its footer is "Manage contexts…", which routes to the definition site
 *   — Project Settings › Contexts (`settings/contexts-section.ts`), the one place a breakpoint, a
 *   colour scheme or a feature query is defined.
 * - **Resolving with** — the document DATA a render resolves against: a page's route params, a
 *   component's test props. Its own popover beside the context one, headed "resolving with", with
 *   the fields in a vertical stack. A SECOND popover rather than a fourth group in the first,
 *   because these are values you type and everything in the rendering-context popover is something
 *   you pick — and because a row of text fields is what made the 28px band unreadable.
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
import { ref } from "lit-html/directives/ref.js";
import { projectState, updateUi } from "../store";
import { effect, effectScope } from "../reactivity";
import { PRIMARY_PANE, focusPane, workspace } from "../workspace/workspace";
import {
  activeMediaOfPane,
  canvasModeOfPane,
  canvasModeOfTab,
  derivationOfPane,
  surfaceForPane,
  tabOfPane,
} from "../canvas/canvas-surface";
import {
  DERIVE_PRESETS,
  PRESET_LABELS,
  declaredMedia,
  deriveRefusal,
  pinRefusal,
  presetRefusal,
} from "../workspace/pane-derive";
import { renderPopover } from "../ui/layers";
import { rectOf } from "../utils/geometry";
import { paneRegion } from "../ui/regions";
import {
  fitToScreen,
  getFit,
  resetZoom,
  canvasBaseViewOf,
  canvasBaseViewsFor,
  previewStateOf,
  setCanvasView,
  setEditZoom,
  setFit,
  setUserZoom,
  stageZoom,
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
import type { JsonValue } from "../types";
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
  exportFile: () => void;
  /*
   * There is no `getCanvasMode` here, and there cannot be one.
   *
   * It answered for the FOCUSED pane — `studio.ts` composes it from `workspace.activePaneId` — and
   * this bar is drawn once per pane, from `tabOfPane(paneId)`. One reader was left: `exportTpl`,
   * which is why entering Code in EITHER pane put an Export button in BOTH bars. Every mode
   * question this module asks is now asked of the pane it is drawing: `canvasModeOfTab(tab)` for
   * the tab's own effective mode, `canvasModeOfPane(paneId)` for the stage's.
   */
  /**
   * Write the BASE mode of the tab it is GIVEN. The editor-kind dropdown and the view control both
   * land here, and both are drawn per pane — so the tab is a parameter. It used to be `(mode:
   * string) => void`, resolving `activeTab.value` inside `studio.ts`, which made the side pane's
   * Editor picker a control over the primary's document.
   */
  setCanvasMode: (tab: Tab, mode: string) => void;
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

/**
 * Where each pane's chrome renders. One entry per drawn cell.
 *
 * A Map rather than a `let _host`, for the reason the whole grid exists: this bar states one pane's
 * editor kind, canvas view, rendering context and zoom, and two panes have two of each.
 * `panels/pane-grid.ts` attaches a cell's `.pane-chrome` as the cell is built.
 */
const _hosts = new Map<string, HTMLElement>();

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
 * Give a pane's chrome somewhere to paint, or take it away.
 *
 * Called by `panels/pane-grid.ts` as a cell is built and as it is disposed.
 *
 * @param {string} paneId
 * @param {HTMLElement | null} host
 */
export function attachPaneChromeHost(paneId: string, host: HTMLElement | null): void {
  const previous = _hosts.get(paneId);
  if (previous === host) {
    return;
  }
  if (previous) {
    litRender(nothing, previous);
    applyPaneContextOffset(0, previous);
  }
  if (host) {
    _hosts.set(paneId, host);
    renderPane(paneId, host);
  } else {
    _hosts.delete(paneId);
  }
}

/**
 * Mount the pane chrome. Idempotent.
 *
 * `host` is the PRIMARY pane's, the same bargain `panels/tab-strip.ts`'s `mount` makes: the
 * bootstrap holds the primary's cell, and every other pane's host arrives from the grid through
 * {@link attachPaneChromeHost}.
 *
 * @param {HTMLElement} host
 * @param {PaneContextCtx} ctx
 */
export function mount(host: HTMLElement, ctx: PaneContextCtx) {
  _ctx = ctx;
  attachPaneChromeHost(PRIMARY_PANE, host);
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      /* EVERY pane's tab. The bar states its own pane's editor kind, canvas view, rendering
         context and zoom, so the unfocused one has to repaint when ITS document moves — tracking
         `activeTab` alone left the side pane's bar frozen describing whatever it last drew. */
      for (const pane of workspace.panes) {
        /* NO DERIVATION READS HERE, and the reason is one rule rather than a tally. `render()`
           runs inside this effect and draws EVERY attached pane, so whatever a template here reads
           is ALREADY a dependency and restating it as a `void` line chooses nothing: `derived.kind`
           picks the bar's shape, `activeMediaOfPane` reads `kind`/`preset`/`media` for the Context
           axis, `zoomOf` reads `derived.zoom` for the pod, and {@link zoomPodTpl} asks
           `canvasModeOfPane`, which for a lens answers `derived.mode` and decides whether the pod
           is drawn at all — pinned by lens-chrome's "the pod is drawn from the LENS's mode".
           An earlier version of this comment listed `mode` among the fields no template reads,
           which was wrong about the fact and right about the deletion. `status` and `reason` really
           are unread here, so tracking them only repainted this bar for a change it does not draw.
           The stage is the surface that needs those two declared, because `renderCanvasImpl` runs
           in a rAF rather than in an effect — see `studio.ts`. */
        const tab = tabOfPane(pane.id);
        if (!tab) {
          continue;
        }
        // Read reactive properties to establish tracking — mirrors the toolbar's subset.
        void tab.doc.document;
        void tab.doc.document?.$layout;
        void tab.doc.mode;
        void tab.documentPath;
        void tab.capabilities.modes;
        void tab.session.ui.activeMedia;
        void tab.session.ui.canvasMode;
        void tab.session.ui.editZoom;
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
  for (const host of _hosts.values()) {
    applyPaneContextOffset(0, host);
  }
  _hosts.clear();
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
 * **On the PANE, not on `:root`**, for the reason `panels/jump-bar.ts` gives at the same seam: two
 * cells have two bands of different heights, and a single document-level number offsets both stages
 * by whichever pane painted last. A host outside a cell writes the root, which is what it meant
 * when the shell had one bar.
 *
 * @param {number} height Band height in px. `0` when the pane has no chrome.
 * @param {HTMLElement | null} [host] The bar's host. Its cell takes the variable when it has one.
 */
export function applyPaneContextOffset(height: number, host?: HTMLElement | null): void {
  const target = host?.closest<HTMLElement>(".pane") ?? document.documentElement;
  target.style.setProperty(PANE_CONTEXT_VAR, `${height}px`);
}

/**
 * How tall the top band came out — the bar plus whatever banners rode with it.
 *
 * MEASURED rather than summed, because the banner's height is its wrapped text and only layout
 * knows how many lines that is. `offsetHeight` is 0 in a DOM with no layout engine (every unit
 * test), so the bar's declared height is the floor: the offset is then exactly what it was before
 * banners existed, which is the honest answer when nothing has been laid out.
 */
function topBandHeight(host: HTMLElement): number {
  const band = host.querySelector<HTMLElement>(".pc-band");
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

/** Paint every attached pane's chrome. */
export function render() {
  for (const [paneId, host] of _hosts) {
    renderPane(paneId, host);
  }
}

/** Paint one pane's chrome into its own host, from its own tab. */
function renderPane(paneId: string, host: HTMLElement) {
  if (!_ctx) {
    return;
  }
  try {
    const tab = tabOfPane(paneId);
    const show = Boolean(tab) && wantsContextBar(tab as Tab);
    litRender(show ? paneChromeTemplate(tab as Tab, paneId, _ctx) : nothing, host);
    applyPaneContextOffset(show ? topBandHeight(host) : 0, host);
  } catch (error) {
    console.error("pane-context render error:", error);
  }
}

// ─── The preset menu · the first renderer of `context/pane` ──────────────────

/** The open preset menu, if any. One at a time, like every other menu in this shell. */
let _presetMenu: { dismiss: () => void } | null = null;

/** Close the preset menu, if it is open. Idempotent. */
export function dismissPresetMenu(): void {
  _presetMenu?.dismiss();
  _presetMenu = null;
}

/**
 * The `⟲` trigger, in the context bar's leading slot — the one that was empty.
 *
 * `.pc-spacer` existed to push the three axes right. It is where §18.4's preset menu goes because
 * the menu is about THIS PANE and the bar is the pane's own chrome; the alternative homes (the tab
 * strip, the jump bar) are about a document and an address respectively.
 */
function presetTriggerTpl(paneId: string): TemplateResult {
  return html`<button
    class="pc-derive-trigger"
    aria-haspopup="menu"
    title="Show something beside this pane"
    @click=${(event: MouseEvent) => {
      openPresetMenu(event, paneId);
    }}
  >
    <span aria-hidden="true">⟲</span>
  </button>`;
}

/**
 * Open the preset menu.
 *
 * **There is no `pane.showDerivePresets`.** §13.5, quoted verbatim in `canvas/canvas-render.ts`:
 * opening a menu to press an item names a CONTROL; the item is the command. Every row here runs
 * `pane.derive`, `pane.pin` or `pane.unsplit` with its own arguments, and the screenshot manifest
 * addresses those ids directly rather than driving this widget. Its region is
 * `overlay.menu:derive-presets`, which `ui/layers.ts` derives from the slot key — no budget is
 * spent.
 */
function openPresetMenu(event: MouseEvent, paneId: string): void {
  event.preventDefault();
  event.stopPropagation();
  dismissPresetMenu();
  const registry = activeRegistry();
  if (!registry) {
    return;
  }
  const anchor = rectOf(event.currentTarget as HTMLElement);
  const left = Math.round(Math.min(anchor.left, window.innerWidth - 4));
  const top = Math.round(anchor.bottom);
  const rows = presetRows(paneId);
  _presetMenu = renderPopover(
    html`<sp-popover open style="position:fixed;z-index:10000;left:${left}px;top:${top}px">
      <sp-menu role="menu" aria-label="Show beside this pane">
        ${rows.map(
          (row) => html`<sp-menu-item
            role="menuitem"
            ?disabled=${row.disabled !== null}
            title=${row.disabled ? `requires ${row.disabled}` : row.label}
            @click=${() => {
              dismissPresetMenu();
              if (row.disabled === null) {
                /* THE PANE THE MENU IS ABOUT, before the verb that resolves the focus runs.
                   See {@link PresetRow.pane}: all three of these commands take the focused pane as
                   their subject, and a pointer gesture on this pane has already focused it — but a
                   keyboard activation has not, because `panels/pane-grid.ts` focuses on
                   pointerdown. Without this line the secondary pane's menu derived from the
                   primary and its Unsplit closed the wrong pane, by keyboard only. */
                focusPane(row.pane);
                void registry.run(row.command, row.args);
              }
            }}
            >${row.label}</sp-menu-item
          >`,
        )}
      </sp-menu>
    </sp-popover>`,
    {
      dismissOnOutsideClick: true,
      onDismiss: () => {
        _presetMenu = null;
      },
      region: "derive-presets",
    },
  );
}

/** One row of the preset menu: a command, its arguments, and why it cannot run when it cannot. */
export interface PresetRow {
  label: string;
  command: string;
  args: Record<string, unknown>;
  /**
   * The pane this row is ABOUT — the one whose ⟲ opened the menu.
   *
   * The previous round made the row's ANSWER a pure function of the pane and left its ACTION
   * resolving the focus: every one of these three commands takes the focused pane as its subject
   * (`pane.derive`'s `activePane()`/`sidePane()`, `pane.unsplit`'s `workspace.activePaneId`), so a
   * row read off the secondary pane's menu derived from the primary. Reachable by keyboard and only
   * by keyboard, which is why it survived a browser pass: `panels/pane-grid.ts` focuses a pane on
   * POINTERDOWN, and a keyboard activation of a menu item fires `click` alone.
   *
   * Carried on the row rather than passed as a command argument. A pane id in `args` would make
   * "which pane" a public input of `pane.derive` — a third property on a record the palette already
   * cannot prompt for, and a value the AI tool would have to invent — to say something the focus
   * already says. The menu moves the focus to the pane it is a menu of, which is what a pointer
   * gesture on that pane does anyway, and all three verbs then agree with the row.
   */
  pane: string;
  /** The `requires` sentence, or null when the row can run. */
  disabled: string | null;
}

/**
 * The rows, built from the registry and from {@link presetRefusal} — one per projection, one per
 * declared breakpoint, then the two exits.
 *
 * Exported because it is the whole content of the menu and it is a pure function of the pane: the
 * widget is untestable in a DOM with no layout, and this is not.
 *
 * @param {string} paneId
 * @returns {PresetRow[]}
 */
export function presetRows(paneId: string): PresetRow[] {
  const registry = activeRegistry();
  const tab = tabOfPane(paneId);
  const derived = derivationOfPane(paneId);
  /* {@link deriveRefusal}, not `registry.disabledReason("pane.derive")`.
     The registry resolves its context from the FOCUS, so a menu built for a pane it was handed by
     name got the answer for whichever pane the keyboard happened to be in: the same pane's rows
     read "enabled" or "an open document in a pane that is not itself derived" depending on where
     the author had last clicked. `scripts/check-pane-singletons.ts` rule 4 could not see it — the
     focus read was a method call on a registry value, dispatched by a string id into a closure in
     another module. It counts `disabledReason` and `isEnabled` themselves as focus reads now,
     which names the shape without pretending to follow the dispatch. */
  const deriveReason = deriveRefusal(paneId);
  const rows: PresetRow[] = [];
  for (const preset of DERIVE_PRESETS) {
    if (preset === "breakpoint") {
      continue;
    }
    rows.push({
      args: { preset },
      command: "pane.derive",
      disabled: deriveReason ?? presetRefusal(preset, paneId, null),
      label: PRESET_LABELS[preset],
      pane: paneId,
    });
  }
  // "Same page at ⟨breakpoint⟩" — one row per breakpoint the document declares, because the item IS
  // The command and a submenu would be a second control between the author and it.
  for (const media of tab && !derived ? declaredMedia(tab) : []) {
    rows.push({
      /* BASE omits `media` rather than passing `""`. `optionalStringArg` refuses an empty string
         by design — "present but blank" is the shape that hides a missing value — so the base row
         has to say nothing rather than say nothing loudly. Caught by opening the menu in a real
         browser: every row ran, and the base one threw `expected a non-empty string, got ""`. */
      args: media === null ? { preset: "breakpoint" } : { media, preset: "breakpoint" },
      command: "pane.derive",
      disabled: deriveReason ?? presetRefusal("breakpoint", paneId, media),
      label: `${PRESET_LABELS.breakpoint} ${media ? mediaDisplayName(media) : "Base"}`,
      pane: paneId,
    });
  }
  /* The two exits, and the reason only ONE of them takes a pane.
     `pane.pin`'s subject is the grid's derived pane — the author reaches it from the palette while
     the keyboard is in the page they are editing — and {@link pinRefusal} answers about a named
     pane without reading the focus, so the menu can ask it about its own. `pane.unsplit`'s
     enablement is `workspace.panes.length > 1`, a fact about the grid with no pane in it at all;
     its `requires` is data on the record and the boolean is the same from anywhere. Its RUN is a
     focus read, like `pane.derive`'s — which is what {@link PresetRow.pane} is for. */
  const exits: [string, string | null][] = [
    ["pane.pin", pinRefusal(paneId)],
    [
      "pane.unsplit",
      workspace.panes.length > 1 ? null : (registry?.get("pane.unsplit")?.requires ?? null),
    ],
  ];
  for (const [id, disabled] of exits) {
    const command = registry?.get(id);
    if (command) {
      rows.push({ args: {}, command: id, disabled, label: command.title, pane: paneId });
    }
  }
  return rows;
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

/**
 * The bar, always the same three axes.
 *
 * There is no takeover branch. Opening a function body or a formula reveals the dock's Logic tab
 * (P8) and leaves the canvas standing underneath it, so the axes still describe the document on the
 * stage and the zoom pod still has something to zoom. Suppressing them while the dock was open
 * removed the controls for the very document the reader could still see.
 *
 * **There is no breadcrumb either.** The address is ⑥'s job — `panels/jump-bar.ts`, one row above —
 * and the Logic tab's own header carries the Close. This bar drew a second Back and a second trail
 * beside both of them.
 */
function paneChromeTemplate(tab: Tab, paneId: string, ctx: PaneContextCtx): TemplateResult {
  const kind = editorKindOf(tab);
  /* A LENS suppresses the two axes that WRITE. Editor kind and Canvas view both land in
     `ctx.setCanvasMode(tab, …)`, and that tab belongs to the pane beside this one — so a control
     drawn in the lens would flip the document the author is editing. The lens's own mode is the
     derivation, chosen when it was created and changed by re-deriving. The Context axis stays as
     a static summary for the same reason (it writes `updateUi(tab, …)`), and the zoom pod stays
     because zoom is the one view fact a lens genuinely owns. */
  const lens = derivationOfPane(paneId)?.kind === "lens";

  return html`
    <div class="pc-band">
      <div class="pane-context" data-jx-region=${paneRegion(paneId, "context")}>
        <div class="pc-spacer">
          ${
            /* …and NO ⟲ trigger in a lens. Every projection row in the menu it opens is permanently
               disabled from there (a derived pane cannot derive again) and the breakpoint rows are
               suppressed outright, leaving one live row — Unsplit — which the derivation chip's ✕
               in this pane's own strip already runs. A control that can do nothing from where it is
               drawn is the class this phase has deleted three times. A COMPANION keeps it: "Keep
               This Document" is live there and it is genuinely about that pane. The SPACER stays
               either way: it is what pushes the axes right, and dropping it would move the one
               control a lens does draw. */
            lens ? nothing : presetTriggerTpl(paneId)
          }
        </div>
        ${
          lens
            ? renderingSummaryTpl(paneId)
            : html`${editorKindTpl(tab, ctx)} ${kind === "canvas" ? viewTpl(tab, ctx) : nothing}
              ${renderingContextTpl(tab, paneId, ctx)} ${exportTpl(tab, ctx)}`
        }
      </div>
      ${lens ? nothing : readOnlyBannerTemplate(tab)}
    </div>
    ${zoomPodTpl(tab, paneId)}
  `;
}

/**
 * A lens's rendering context, stated rather than offered.
 *
 * Open question 1, answered "keep it, read-only": a lens drawn under different preview params than
 * the pane it is a lens OF would be lying about what it is a lens of, so the summary has to be on
 * screen — but the popover behind it writes the source tab's `session.ui`, which is the one thing a
 * lens must never do.
 */
function renderingSummaryTpl(paneId: string): TemplateResult {
  /* No `ctx.parseMediaEntries` here. It parsed the document's whole `$media` map, discarded the
     result through `void sizeBreakpoints` and printed the media NAME — a parse per lens-bar render
     for a value that was never read. `mediaDisplayName` is the only lookup this line needs. */
  /* {@link activeMediaOfPane}, and it exists for exactly this. `session.ui.activeMedia` is per-TAB
     and a lens shares its tab with the pane beside it, so this axis printed the breakpoint the
     SOURCE pane was on: the stage drew the Tablet artboard and the line under it said "Base". The
     docstring above says a lens drawn under different params "would be lying about what it is a
     lens of" — and it lied about the one axis the preset is named after. */
  const media = activeMediaOfPane(paneId);
  return axisTpl(
    "Context",
    html`<span class="pc-static">${media ? mediaDisplayName(media) : "Base"}</span>`,
  );
}

// ─── Axis 1 · Editor kind ────────────────────────────────────────────────────

function editorKindTpl(tab: Tab, ctx: PaneContextCtx): TemplateResult {
  /* What the DOCUMENT declares, and nothing else. This read `hostableKindsOf` — the declared kinds
     narrowed by what the tab's pane was allowed to host — so a page in the side pane was offered
     Code and not Design. The pane cap is gone; a control that cannot go anywhere is still the
     defect this axis exists to remove, and one declared kind still renders as text. */
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
          ctx.setCanvasMode(tab, mode);
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
  // Every pane draws a live Canvas, so this is no longer narrowed by WHERE the tab is — only by
  // What the document declares. A document with no Canvas view still draws no view group.
  const views = canvasBaseViewsFor(tab);
  if (views.length === 0) {
    return nothing;
  }
  const current = canvasBaseViewOf(tab);
  const preview = previewStateOf(tab);
  /*
   * TWO CONTROLS, because they are two axes.
   *
   * `Edit │ Design │ Preview` was one three-way radio, and it lied about the state it was showing:
   * preview is stored as a flag OVER an edit/design base, so while it was on the radio could not
   * say which mode you were previewing — or which one Escape would return you to. Now the radio
   * marks the base the whole time and the toggle sits beside it, pressed.
   */
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
      ${
        preview.available
          ? html`
              <sp-action-button
                size="s"
                class="pc-preview-toggle"
                toggles
                ?selected=${preview.on}
                aria-pressed=${preview.on ? "true" : "false"}
                title=${
                  preview.on
                    ? `Stop previewing — back to ${CANVAS_VIEW_LABELS[current ?? "edit"]}`
                    : "Preview: the page as it ships, with editing off"
                }
                @click=${() => {
                  setCanvasView(
                    tab,
                    preview.on ? (current ?? "edit") : "preview",
                    ctx.setCanvasMode,
                  );
                }}
              >
                ${CANVAS_VIEW_LABELS.preview}
              </sp-action-button>
            `
          : nothing
      }
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

function renderingContextTpl(tab: Tab, paneId: string, ctx: PaneContextCtx): TemplateResult {
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
  const resolving = isPageDoc(tab) ? paramPickersTpl(tab, paneId) : propFieldsTpl(tab, paneId);
  /* How many of those fields carry a value. The trigger has to say something true at a glance, the
     way the Context trigger says `Base · Auto` — a chevron with no reading is a control you have to
     open in order to learn whether it was worth opening. */
  const resolvingSet = isPageDoc(tab)
    ? Object.values(ui.previewParams ?? {}).filter((v) => v !== "" && v !== undefined).length
    : Object.keys(ui.previewProps ?? {}).length;

  return axisTpl(
    "Context",
    html`
      ${resolvingTpl(paneId, resolving, resolvingSet)}
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
            ${sizeGroupTpl(paneId, sizeBreakpoints, activeMedia)}
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
                              @click=${() =>
                                runContextCommand(paneId, "canvas.setColorScheme", {
                                  scheme: value,
                                })}
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
                                updateUi(tab, "featureToggles", {
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
                        @change=${() =>
                          runContextCommand(paneId, "canvas.setLayoutVisible", {
                            visible: tab.session.ui.showLayout === false,
                          })}
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
 * The document DATA a render resolves against — route params, component test props — in a popover.
 *
 * §4.2 folds these in behind the words "resolving with…", and this is where that lands: the phrase
 * is the popover's header and the fields are a vertical stack under it, the same shape as the
 * rendering-context popover beside it.
 *
 * They used to sit OPEN on the bar, and the argument for that was the screenshot contract (§13.1):
 * behind a click, the one first-hour flow the docs teach — typing a test prop on
 * `start/first-component` — costs a second gesture, and the manifest's input budget may only
 * ratchet down. The answer is not to keep n text fields on a 28px band that also carries the
 * editor, the view and the rendering context; it is that a transient surface opens by COMMAND (plan
 * §13.2), so the shot spends a `cmd` step rather than a selector and the input budget is untouched.
 * `canvas.setResolvingOpen` is that command, and it is the same door the pointer uses.
 *
 * @param {string} paneId
 * @param {TemplateResult | typeof nothing} body
 * @param {number} setCount — how many fields carry a value, for the trigger's summary
 */
function resolvingTpl(
  paneId: string,
  body: TemplateResult | typeof nothing,
  setCount: number,
): TemplateResult | typeof nothing {
  if (body === nothing) {
    return nothing;
  }
  return html`
    <overlay-trigger
      placement="bottom-end"
      triggered-by="click"
      ${ref((el: Element | undefined) => {
        if (el) {
          _resolvingTrigger.set(paneId, el as HTMLElement & { open?: string | undefined });
        }
      })}
    >
      <sp-action-button
        slot="trigger"
        size="s"
        quiet
        class="pc-resolving-trigger"
        title="The values this document is being rendered with"
      >
        ${setCount > 0 ? `${setCount} set` : "Defaults"} ⌄
      </sp-action-button>
      <sp-popover slot="click-content" tip class="pc-context-popover">
        <div class="pc-ctx">${groupTpl("resolving with", body as TemplateResult)}</div>
      </sp-popover>
    </overlay-trigger>
  `;
}

/**
 * Each pane's "resolving with" `overlay-trigger`, which IS the open state.
 *
 * No parallel `Set`. The overlay owns whether it is showing — it opens on a pointer click without
 * telling anyone first — so a second record of the same fact could only ever be the stale one. The
 * element's `open` property is what the pointer writes and what the command writes, and reading it
 * back is how anything else asks.
 */
const _resolvingTrigger = new Map<string, HTMLElement & { open?: string | undefined }>();

/** Whether this pane's resolving popover is open. Exported for the tests. */
export function isResolvingOpen(paneId: string): boolean {
  return _resolvingTrigger.get(paneId)?.open === "click";
}

/**
 * Open or close it.
 *
 * A named end state rather than a toggle, so `canvas.setResolvingOpen { open: false }` means the
 * same thing twice and a screenshot can photograph it (§13's R1).
 *
 * It writes the element and does NOT re-render the bar. `overlay-trigger` moves the popover into an
 * overlay portal while it is open and restores it on close; re-rendering this template in the
 * middle of that leaves the moved copy painted over the canvas with no way to dismiss it. The
 * overlay owns its own visibility — the only thing the bar redraws for is the trigger's summary,
 * and that changes when a VALUE changes, which already renders.
 */
export function setResolvingOpen(paneId: string, open: boolean): void {
  const trigger = _resolvingTrigger.get(paneId);
  if (trigger && isResolvingOpen(paneId) !== open) {
    trigger.open = open ? "click" : undefined;
  }
}

/** Forget the held triggers — a fresh window, and the tests. */
export function resetResolvingOpen(): void {
  _resolvingTrigger.clear();
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
/**
 * Run a rendering-context verb through the registry.
 *
 * These four controls wrote `session.ui` directly through `updateUi`, which is why none of the
 * three axes was a command: the popover WAS the capability, and the palette, the assistant and
 * `__jxAutomation` had no name for it. Going through the registry makes the control and the verb
 * one thing (§2, principle 1) and gets the breakpoint refusal for free.
 */
function runContextCommand(paneId: string, id: string, args: Record<string, unknown>): void {
  // THIS pane, named. The bar is drawn once per pane and the side bar's controls write the side
  // Pane's tab; a verb defaulting to the focused pane would have made the side bar edit the
  // Foreground document the moment its control became a command.
  void activeRegistry()?.run(id, { ...args, pane: paneId });
}

function sizeGroupTpl(
  paneId: string,
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
          @click=${() => runContextCommand(paneId, "canvas.setBreakpoint", { media: null })}
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
              @click=${() => runContextCommand(paneId, "canvas.setBreakpoint", { media: name })}
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

function exportTpl(tab: Tab, ctx: PaneContextCtx): TemplateResult | typeof nothing {
  /* THIS tab's effective mode. `ctx.getCanvasMode()` answered for the focused pane, so a document
     opened as Code in either pane put an Export button in the OTHER pane's bar as well — over a
     document that is not the one the button exports. */
  if (canvasModeOfTab(tab) !== "source") {
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
function zoomPodTpl(tab: Tab, paneId: string): TemplateResult | typeof nothing {
  /* THIS pane's mode. `ctx.getCanvasMode()` answers for the focused pane, so the unfocused pod
     offered an `editZoom` control over a stage drawing Design — and hid the fit that stage has. */
  const mode = canvasModeOfPane(paneId);
  /* And THIS pane's stage. Every zoom verb below takes a surface: without one they all defaulted to
     `activeCanvasSurface()`, so the side pane's `+` magnified the primary's document by a factor
     computed from the side pane's own zoom, and its "100%" button reset the primary. */
  const surface = surfaceForPane(paneId);
  if (mode === "edit") {
    const editZoom = tab.session.ui.editZoom ?? 1;
    return podTpl(
      paneId,
      html`
        ${zoomButton("Zoom out (Ctrl+-)", "−", () =>
          setEditZoom((tab.session.ui.editZoom ?? 1) / 1.2, surface),
        )}
        <sp-action-button
          size="s"
          class="pc-zoom-label"
          title="Reset to 100% (Ctrl+0)"
          @click=${() => setEditZoom(1, surface)}
        >
          ${Math.round(editZoom * 100)}%
        </sp-action-button>
        ${zoomButton("Zoom in (Ctrl+=)", "+", () =>
          setEditZoom((tab.session.ui.editZoom ?? 1) * 1.2, surface),
        )}
      `,
    );
  }
  if (mode !== "design" && mode !== "stylebook" && mode !== "git-diff") {
    return nothing;
  }
  const zoom = stageZoom(surface);
  const chosen = fitChoiceValue(getFit(surface));
  return podTpl(
    paneId,
    html`
      ${zoomButton("Zoom out (Ctrl+-)", "−", () => setUserZoom(stageZoom(surface) / 1.2, surface))}
      <sp-action-button
        size="s"
        class="pc-zoom-label"
        title="Reset to 100% (Ctrl+0)"
        @click=${() => resetZoom(surface)}
      >
        ${Math.round(zoom * 100)}%
      </sp-action-button>
      ${zoomButton("Zoom in (Ctrl+=)", "+", () => setUserZoom(stageZoom(surface) * 1.2, surface))}
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
            fitToScreen({ surface });
            return;
          }
          setFit(choice.fit, surface);
        }}
      >
        ${FIT_CHOICES.map(
          ({ value, label }) => html`<sp-menu-item value=${value}>${label}</sp-menu-item>`,
        )}
      </sp-picker>
    `,
  );
}

function podTpl(paneId: string, body: TemplateResult): TemplateResult {
  return html`
    <div class="pane-zoom" data-jx-region=${paneRegion(paneId, "zoom")}>
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

/**
 * Candidate values per `(documentPath, $paths)` key, and the keys whose load is in flight.
 *
 * **A Map, not one slot, and that is a livelock fix rather than a cache-size preference.** It was
 * `_paramValues` + `_paramValuesKey`, holding exactly ONE result, while {@link render} loops every
 * attached pane. Two panes on documents with different keys evicted each other on every pass: pane
 * A's render stored A's key and cleared the value, pane B's render in the same loop stored B's, and
 * whichever load landed found its key gone — or, once the "still shown somewhere" guard let it
 * through, stored its value and called `render()`, which re-issued both loads again. An unbounded
 * microtask chain: no rAF, no paint, no input. `⌘\` with two pages under dynamic routes was enough,
 * and the probe never returned.
 *
 * `_paramLoading` is what stops a re-render re-issuing a load that has not landed yet; the value
 * map is what stops one pane's answer erasing the other's.
 */
const _paramValues = new Map<string, ParamValues>();

const _paramLoading = new Set<string>();

/** Drop every cached candidate list — a project switch, and the tests. */
export function resetParamValues(): void {
  _paramValues.clear();
  _paramLoading.clear();
}

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
  const cached = _paramValues.get(key);
  if (cached) {
    return cached;
  }
  if (_paramLoading.has(key)) {
    return null;
  }
  _paramLoading.add(key);
  void loadParamValues(tab.documentPath, pathsDef).then((values) => {
    _paramLoading.delete(key);
    /* Still SHOWN somewhere, rather than still focused. The candidate values fill a picker in one
       pane's bar; a load that landed while the keyboard was in the other pane used to be discarded,
       leaving the picker permanently empty for whoever was not looking at it. */
    if (!workspace.panes.some((pane) => pane.activeTabId === tab.id)) {
      return;
    }
    _paramValues.set(key, values);
    autoSelectParams(tab, values);
    render();
  });
  return null;
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
    updateUi(tab, "previewParams", { ...current, ...additions });
  }
}

/**
 * @param {Tab} tab
 * @returns {TemplateResult | typeof nothing}
 */
function paramPickersTpl(tab: Tab, paneId: string): TemplateResult | typeof nothing {
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
            // Through the registry, like every control in the popover beside this one.
            runContextCommand(paneId, "canvas.setRouteParam", { name, value });
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
 * @param {string} paneId
 * @returns {TemplateResult | typeof nothing}
 */
function propFieldsTpl(tab: Tab, paneId: string): TemplateResult | typeof nothing {
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
          data-jx-region=${paneRegion(paneId, `prop:${name}`)}
          placeholder=${name}
          title=${`Test value for ${name}`}
          .value=${display(previewProps?.[name])}
          @change=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            // The command owns the write; this control owns only the parse, because "what a typed
            // String means" is a fact about a text field and not about the value.
            runContextCommand(paneId, "canvas.setTestProp", {
              name,
              value: raw === "" ? null : parsePropValue(raw),
            });
          }}
        ></sp-textfield>
      `,
    )}
  `;
}
