/**
 * Grid canvas panel — the lit shell rendered into #canvas-wrap when a tab's canvasMode is "grid".
 *
 * Follows the stylebook/source pattern: canvas-render calls renderGridMode() on entry and
 * detachGridPanel() in its mode-change teardown. The shell (toolbar + host div) re-renders from a
 * panel-local effect that tracks the controller's reactive state, so the Save badge, row count, and
 * loading/error surfaces stay live without renderCanvas involvement. The Tabulator view is created
 * once per tab entry, after the controller has loaded columns, and destroyed on detach — all grid
 * data survives in the controller/buffer, so a rebuild on re-entry is cheap.
 */
import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { effect, effectScope } from "../reactivity";
import { renderPopover } from "../ui/layers";
import { statusMessage } from "../panels/statusbar";
import { rectOf } from "../utils/geometry";
import { createGridController, getGridController } from "./grid-controller";
import { createCsvFileSource } from "./sources/csv-file-source";
import { createGridView } from "./grid-view";
import { parseGridTabId } from "./grid-source";
import type { EffectScope } from "@vue/reactivity";
import type { GridController } from "./grid-controller";
import type { GridView } from "./grid-view";
import type { Tab } from "../tabs/tab";

interface ActiveGridPanel {
  tabId: string;
  scope: EffectScope;
  view: GridView | null;
  wrap: HTMLElement;
}

let active: ActiveGridPanel | null = null;

/** Destroy the live grid view/effects (canvas-render teardown + tab switches). */
export function detachGridPanel() {
  if (!active) {
    return;
  }
  active.view?.destroy();
  active.scope.stop();
  active = null;
}

/** Whether the grid panel is live for this tab (canvas-render fast-path guard). */
export function gridPanelMounted(tab: Tab): boolean {
  return active !== null && active.tabId === tab.id && active.wrap.isConnected;
}

function toolbarTpl(controller: GridController, getView: () => GridView | null) {
  const { state } = controller;
  const dirty = controller.buffer.dirtyCount();
  const sourceRef = parseGridTabId(controller.source.id);
  const lossyNote =
    sourceRef?.kind === "collection" || sourceRef?.kind === "pages"
      ? html`<span
          class="jx-grid-note"
          title="Saving re-serializes frontmatter; YAML comments and key order are not preserved."
        >
          rewrites frontmatter
        </span>`
      : nothing;

  return html`
    <div class="jx-grid-toolbar">
      <sp-button
        size="s"
        variant="accent"
        ?disabled=${dirty === 0 || state.saving}
        @click=${() => void controller.save()}
      >
        Save${dirty > 0 ? ` (${dirty})` : ""}
      </sp-button>
      <sp-action-button
        size="s"
        quiet
        title="Reload from source"
        ?disabled=${state.loading || state.saving}
        @click=${() => void controller.refresh()}
      >
        Refresh
      </sp-action-button>
      <sp-divider size="s" vertical></sp-divider>
      ${controller.source.capabilities.insert
        ? html`<sp-action-button
            size="s"
            quiet
            title="Add a row (saved on Save)"
            @click=${() => controller.addRow()}
          >
            Add Row
          </sp-action-button>`
        : nothing}
      ${controller.source.capabilities.delete
        ? html`<sp-action-button
            size="s"
            quiet
            title="Mark selected rows for deletion"
            @click=${() => controller.deleteRows(getView()?.getSelectedRowKeys() ?? [])}
          >
            Delete Rows
          </sp-action-button>`
        : nothing}
      <sp-action-button
        size="s"
        quiet
        title="Fill the selected range down from its first row (Ctrl/Cmd-D)"
        @click=${() => getView()?.fillDown()}
      >
        Fill Down
      </sp-action-button>
      <sp-action-button
        size="s"
        quiet
        title="Find & replace across text cells"
        @click=${(e: MouseEvent) => openReplacePopover(controller, e.currentTarget as HTMLElement)}
      >
        Replace
      </sp-action-button>
      <sp-search
        size="s"
        quiet
        placeholder="Filter rows"
        @input=${(e: Event) => getView()?.setSearch((e.target as HTMLInputElement).value)}
        @submit=${(e: Event) => e.preventDefault()}
      ></sp-search>
      <span class="jx-grid-spacer"></span>
      ${lossyNote} ${controller.source.capabilities.remotePaging ? pagerTpl(controller) : nothing}
      <span class="jx-grid-count">
        ${state.loading
          ? "Loading…"
          : state.error
            ? html`<span class="jx-grid-error-text">${state.error}</span>`
            : `${state.total} row${state.total === 1 ? "" : "s"}`}
      </span>
    </div>
  `;
}

/** Find & replace popover — buffers all replacements as one undo group. */
function openReplacePopover(controller: GridController, anchor: HTMLElement) {
  const rect = rectOf(anchor);
  let find = "";
  let replace = "";
  const handle = renderPopover(
    html`<sp-popover
      open
      class="jx-grid-replace-popover"
      style="position:fixed;z-index:10000;left:${Math.max(4, rect.left)}px;top:${rect.bottom + 4}px"
    >
      <div class="jx-grid-cell-popover-body">
        <div class="jx-grid-cell-popover-title">Find &amp; Replace</div>
        <input
          class="jx-grid-input"
          placeholder="Find…"
          @input=${(e: Event) => (find = (e.target as HTMLInputElement).value)}
        />
        <input
          class="jx-grid-input"
          placeholder="Replace with…"
          @input=${(e: Event) => (replace = (e.target as HTMLInputElement).value)}
        />
        <div class="jx-grid-cell-popover-actions">
          <sp-button
            size="s"
            variant="accent"
            @click=${() => {
              const changed = controller.replaceAll(find, replace);
              statusMessage(
                changed === 0
                  ? "No matches"
                  : `Replaced in ${changed} cell${changed === 1 ? "" : "s"} — save to apply`,
              );
              if (changed > 0) {
                handle.dismiss();
              }
            }}
          >
            Replace All
          </sp-button>
          <sp-button size="s" variant="secondary" @click=${() => handle.dismiss()}>
            Cancel
          </sp-button>
        </div>
      </div>
    </sp-popover>`,
    { dismissOnOutsideClick: true },
  );
}

/** Prev/Next pager for remote-paged sources (connector tables). */
function pagerTpl(controller: GridController) {
  const { state } = controller;
  const limit = state.query.limit ?? 50;
  const offset = state.query.offset ?? 0;
  const from = state.total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, state.total);
  return html`
    <sp-action-button
      size="s"
      quiet
      title="Previous page"
      ?disabled=${offset === 0 || state.loading}
      @click=${() =>
        void controller.setQuery({
          ...state.query,
          limit,
          offset: Math.max(0, offset - limit),
        })}
    >
      ‹ Prev
    </sp-action-button>
    <span class="jx-grid-count">${from}–${to}</span>
    <sp-action-button
      size="s"
      quiet
      title="Next page"
      ?disabled=${offset + limit >= state.total || state.loading}
      @click=${() => void controller.setQuery({ ...state.query, limit, offset: offset + limit })}
    >
      Next ›
    </sp-action-button>
  `;
}

function shellTpl(
  controller: GridController,
  getView: () => GridView | null,
  onHost: (el: HTMLElement | undefined) => void,
) {
  return html`
    <div class="jx-grid">
      ${toolbarTpl(controller, getView)}
      <div class="jx-grid-host" ${ref((el) => onHost(el as HTMLElement | undefined))}></div>
    </div>
  `;
}

/**
 * Render the grid surface for a tab into #canvas-wrap. Re-entrant: same-tab calls while the panel
 * is live are no-ops (the panel's own effect keeps it fresh).
 *
 * @param {HTMLElement} canvasWrap
 * @param {Tab} tab
 */
export function renderGridMode(canvasWrap: HTMLElement, tab: Tab) {
  if (gridPanelMounted(tab)) {
    return;
  }
  detachGridPanel();

  let controller = getGridController(tab);
  // CSV file tabs can reach grid mode through any open path (deep link, quick search, recents) —
  // Provision their controller lazily so every path works, not just openCsvGridTab.
  if (!controller && tab.documentPath?.toLowerCase().endsWith(".csv")) {
    controller = createGridController(tab, createCsvFileSource(tab.documentPath));
    void controller.load();
  }
  if (!controller) {
    litRender(html`<div class="jx-grid-missing">This tab has no grid source.</div>`, canvasWrap);
    return;
  }

  const scope = effectScope();
  const panel: ActiveGridPanel = { scope, tabId: tab.id, view: null, wrap: canvasWrap };
  active = panel;

  let hostEl: HTMLElement | null = null;
  const onHost = (el: HTMLElement | undefined) => {
    hostEl = el ?? null;
  };

  scope.run(() => {
    effect(() => {
      if (active !== panel) {
        return;
      }
      // Track everything the toolbar shows.
      void controller.state.loading;
      void controller.state.saving;
      void controller.state.error;
      void controller.state.total;
      void controller.state.query.offset;
      void controller.buffer.dirtyCount();

      litRender(
        shellTpl(controller, () => panel.view, onHost),
        canvasWrap,
      );

      // Create the engine once the columns exist and the host div is in the DOM.
      if (
        !panel.view &&
        !controller.state.loading &&
        controller.state.columns.length > 0 &&
        hostEl
      ) {
        panel.view = createGridView(hostEl, controller);
      }
    });
  });
}
