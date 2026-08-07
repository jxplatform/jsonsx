/**
 * Grid canvas panel — the lit shell rendered into #canvas-wrap when a tab's canvasMode is "grid".
 *
 * Follows the stylebook/source pattern: canvas-render calls renderGridMode() on entry and
 * detachGridPanel() in its mode-change teardown. The shell (toolbar + host div) re-renders from a
 * panel-local effect that tracks the controller's reactive state, so the Save badge, row count, and
 * loading/error surfaces stay live without renderCanvas involvement. The Tabulator view is created
 * once per tab entry, after the controller has loaded columns, and destroyed on detach — all grid
 * data survives in the controller/buffer, so a rebuild on re-entry is cheap.
 *
 * **The panel owns the view state** (plan §12 P7.2). Saved views persist through `grid-layout.ts` —
 * one store, the grid id as its key, so "per collection" needs no code — and this module is what
 * drives them onto the four surfaces they touch: the engine (column order, width and visibility,
 * applied by a REBUILD, which is cheap because the data never leaves the controller), the
 * controller (sort and grouping, which are row order and belong to the data), and the toolbar's own
 * filter box. Applying a view is therefore one function with one order of operations, not five
 * controls that each half-remember what the others did.
 */
import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { effect, effectScope, reactive } from "../reactivity";
import { renderPopover, showConfirmDialog, showPromptDialog } from "../ui/layers";
import { notify } from "../services/notify";
import { rectOf } from "../utils/geometry";
import { activeTab, workspace } from "../workspace/workspace";
import { createGridController, getGridController } from "./grid-controller";
import { createCsvFileSource } from "./sources/csv-file-source";
import { createGridView } from "./grid-view";
import { parseGridTabId } from "./grid-source";
import {
  activeViewModified,
  activeViewName,
  applySavedView,
  deleteSavedView,
  listSavedViews,
  loadGridLayout,
  resetGridLayout,
  saveGridLayout,
  saveViewAs,
} from "./grid-layout";
import { argsSchema, stringArg, stringProperty } from "../commands/command-args";
import type { EffectScope } from "@vue/reactivity";
import type { GridController } from "./grid-controller";
import type { GridLayout, GridSortSpec } from "./grid-layout";
import type { GridView } from "./grid-view";
import type { Tab } from "../tabs/tab";
import type { CanvasSurface } from "../canvas/canvas-surface";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

interface ActiveGridPanel {
  /** The pane whose stage this grid is drawn on. */
  paneId: string;
  tabId: string;
  scope: EffectScope;
  view: GridView | null;
  wrap: HTMLElement;
  /**
   * Rebuild the engine over the same controller.
   *
   * Column order, width and visibility are read by `createGridView` from the saved layout, so this
   * is how a view change reaches them. Nothing is re-fetched: rows, edits, undo history and the
   * dirty flag all live in the controller, and the engine is a rendering of them.
   */
  remount: () => void;
  /** Apply a whole layout — sort, grouping, columns, filter — in one order of operations. */
  applyLayout: (layout: GridLayout | null) => void;
  /** Re-render the toolbar. `localStorage` is not reactive, so a view edit has to say so. */
  bump: () => void;
}

/**
 * The grid mounted in each pane, keyed by pane id.
 *
 * A module-level `let active` described a shell with one stage. With two, pane B mounting a grid
 * destroyed pane A's Tabulator view and effect scope out from under it — and `resetCanvasView`
 * calls `detachGridPanel` on every pane that empties, so a second grid was never required.
 */
const _active = new Map<string, ActiveGridPanel>();

/** The grid mounted in a pane, or null. */
function activeIn(paneId: string): ActiveGridPanel | null {
  return _active.get(paneId) ?? null;
}

/** Destroy one pane's grid view/effects (canvas-render teardown + tab switches). */
export function detachGridPanel(paneId: string) {
  const panel = _active.get(paneId);
  if (!panel) {
    return;
  }
  panel.view?.destroy();
  panel.scope.stop();
  _active.delete(paneId);
}

/** Whether the grid panel is live in this pane for this tab (canvas-render fast-path guard). */
export function gridPanelMounted(paneId: string, tab: Tab): boolean {
  const panel = activeIn(paneId);
  return panel !== null && panel.tabId === tab.id && panel.wrap.isConnected;
}

function toolbarTpl(controller: GridController, panel: ActiveGridPanel) {
  const getView = () => panel.view;
  const { state } = controller;
  const gridId = controller.source.id;
  const layout = loadGridLayout(gridId);
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
      ${
        controller.source.capabilities.insert
          ? html`<sp-action-button
              size="s"
              quiet
              title="Add a row (saved on Save)"
              @click=${() => controller.addRow()}
            >
              Add Row
            </sp-action-button>`
          : nothing
      }
      ${
        controller.source.capabilities.delete
          ? html`<sp-action-button
              size="s"
              quiet
              title="Mark selected rows for deletion"
              @click=${() => controller.deleteRows(getView()?.getSelectedRowKeys() ?? [])}
            >
              Delete Rows
            </sp-action-button>`
          : nothing
      }
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
      <sp-action-button
        size="s"
        quiet
        class="jx-grid-view-button"
        title="Saved views, columns, sort and grouping"
        @click=${(e: MouseEvent) => openViewPopover(controller, panel, e.currentTarget as HTMLElement)}
      >
        ${viewButtonLabel(gridId)}
      </sp-action-button>
      <sp-search
        size="s"
        quiet
        placeholder="Filter rows"
        .value=${layout?.filter ?? ""}
        @input=${(e: Event) => {
          const term = (e.target as HTMLInputElement).value;
          // The filter is part of the view, so it persists with the rest of it rather than
          // Evaporating on a tab switch and taking a saved view's meaning with it.
          saveGridLayout(gridId, { filter: term });
          getView()?.setSearch(term);
        }}
        @submit=${(e: Event) => e.preventDefault()}
      ></sp-search>
      <span class="jx-grid-spacer"></span>
      ${groupNoteTpl(controller)} ${lossyNote}
      ${controller.source.capabilities.remotePaging ? pagerTpl(controller) : nothing}
      <span class="jx-grid-count">
        ${
          state.loading
            ? "Loading…"
            : state.error
              ? html`<span class="jx-grid-error-text">${state.error}</span>`
              : `${state.total} row${state.total === 1 ? "" : "s"}`
        }
      </span>
    </div>
  `;
}

// ─── Saved views ──────────────────────────────────────────────────────────────

/**
 * The View button's label: the applied view's name, with a dot when the layout has since drifted.
 *
 * "View" alone when nothing is applied — the grid still remembers its columns, and claiming a name
 * for a layout the author never named would make Save-as look like a no-op.
 */
function viewButtonLabel(gridId: string): string {
  const name = activeViewName(gridId);
  if (!name) {
    return "View";
  }
  return activeViewModified(gridId) ? `${name} •` : name;
}

/** "Grouped by Status · 3 groups" — the grouping is invisible in the rows, so the toolbar says it. */
function groupNoteTpl(controller: GridController) {
  const field = controller.state.grouping;
  if (!field) {
    return nothing;
  }
  const title = controller.state.columns.find((column) => column.field === field)?.title ?? field;
  const count = controller.groups().length;
  return html`<span class="jx-grid-note" title="Rows are ordered so each group is contiguous.">
    Grouped by ${title} · ${count} group${count === 1 ? "" : "s"}
  </span>`;
}

/**
 * The View popover: saved views, then the four facets one of them is made of.
 *
 * One control rather than four, because the chrome budget is a cap on named things in the toolbar
 * (plan §2, principle 9) and these four are only ever adjusted together. Each edit writes the
 * working layout and applies immediately — there is no Apply button, so there is no state in which
 * the popover shows something the grid is not already doing.
 */
function openViewPopover(controller: GridController, panel: ActiveGridPanel, anchor: HTMLElement) {
  const rect = rectOf(anchor);
  const gridId = controller.source.id;
  // Opened empty and filled by `rerender()` below, because the body's handlers close over `handle`
  // And every one of them re-renders the popover in place rather than closing it.
  const handle = renderPopover(nothing as never, {
    dismissOnOutsideClick: true,
    region: "grid/views",
  });
  const rerender = () => handle.update(body());
  const close = () => handle.dismiss();

  /** Persist one facet, put it on screen, and refresh both the popover and the toolbar. */
  const change = (patch: GridLayout, apply: () => void) => {
    saveGridLayout(gridId, patch);
    apply();
    panel.bump();
    rerender();
  };

  function body() {
    const layout = loadGridLayout(gridId) ?? {};
    const views = listSavedViews(gridId);
    const activeName = activeViewName(gridId);
    const hidden = new Set(layout.hidden);
    const sort = layout.sort ?? null;
    const { columns } = controller.state;

    const setSort = (spec: GridSortSpec | null) =>
      change({ sort: spec }, () => void controller.setSort(spec));

    return html`<sp-popover
      open
      class="jx-grid-view-popover"
      style="position:fixed;z-index:10000;left:${Math.max(4, rect.left)}px;top:${rect.bottom + 4}px"
    >
      <div class="jx-grid-cell-popover-body">
        <div class="jx-grid-cell-popover-title">Saved views</div>
        ${
          views.length === 0
            ? html`<div class="jx-grid-view-empty">
                No saved views yet. Arrange the grid, then save it under a name.
              </div>`
            : views.map(
                (view) => html`<div class="jx-grid-view-row">
                  <button
                    class="jx-grid-view-name ${view.name === activeName ? "is-active" : ""}"
                    @click=${() => {
                      panel.applyLayout(applySavedView(gridId, view.name));
                      close();
                    }}
                  >
                    ${view.name}
                  </button>
                  <sp-action-button
                    size="s"
                    quiet
                    title="Delete this view"
                    @click=${async () => {
                      const confirmed = await showConfirmDialog(
                        "Delete View",
                        `Delete the saved view "${view.name}"? The grid keeps its current layout.`,
                        { confirmLabel: "Delete", destructive: true },
                      );
                      if (confirmed && deleteSavedView(gridId, view.name)) {
                        panel.bump();
                        rerender();
                      }
                    }}
                    >✕</sp-action-button
                  >
                </div>`,
              )
        }
        <div class="jx-grid-cell-popover-actions">
          <sp-button
            size="s"
            variant="accent"
            @click=${() => void promptSaveView(controller, panel, rerender)}
          >
            ${activeName ? "Save as…" : "Save view…"}
          </sp-button>
          <sp-button
            size="s"
            variant="secondary"
            title="Forget this grid's saved columns, sort, grouping and filter. Named views are kept."
            @click=${() => {
              resetGridLayout(gridId);
              panel.applyLayout(null);
              close();
            }}
          >
            Reset
          </sp-button>
        </div>

        <div class="jx-grid-cell-popover-title">Columns</div>
        ${columns.map(
          (column) => html`<label class="jx-grid-view-check">
            <input
              type="checkbox"
              .checked=${!hidden.has(column.field)}
              data-field=${column.field}
              @change=${(e: Event) => {
                const next = new Set(hidden);
                if ((e.target as HTMLInputElement).checked) {
                  next.delete(column.field);
                } else {
                  next.add(column.field);
                }
                change({ hidden: [...next] }, () => panel.remount());
              }}
            />
            ${column.title}
          </label>`,
        )}

        <div class="jx-grid-cell-popover-title">Sort</div>
        <select
          class="jx-grid-input jx-grid-sort-field"
          @change=${(e: Event) => {
            const field = (e.target as HTMLSelectElement).value;
            setSort(field === "" ? null : { dir: sort?.dir ?? "asc", field });
          }}
        >
          <option value="" ?selected=${!sort}>Source order</option>
          ${columns.map(
            (column) =>
              html`<option value=${column.field} ?selected=${sort?.field === column.field}>
                ${column.title}
              </option>`,
          )}
        </select>
        <select
          class="jx-grid-input jx-grid-sort-dir"
          ?disabled=${!sort}
          @change=${(e: Event) => {
            const dir = (e.target as HTMLSelectElement).value === "desc" ? "desc" : "asc";
            if (sort) {
              setSort({ dir, field: sort.field });
            }
          }}
        >
          <option value="asc" ?selected=${sort?.dir !== "desc"}>Ascending</option>
          <option value="desc" ?selected=${sort?.dir === "desc"}>Descending</option>
        </select>

        <div class="jx-grid-cell-popover-title">Group by</div>
        <select
          class="jx-grid-input jx-grid-group-field"
          @change=${(e: Event) => {
            const field = (e.target as HTMLSelectElement).value || null;
            change({ groupBy: field }, () => controller.setGrouping(field));
          }}
        >
          <option value="" ?selected=${!controller.state.grouping}>Ungrouped</option>
          ${columns.map(
            (column) =>
              html`<option
                value=${column.field}
                ?selected=${controller.state.grouping === column.field}
              >
                ${column.title}
              </option>`,
          )}
        </select>
      </div>
    </sp-popover>`;
  }

  rerender();
  // The button's label is derived from storage, and storage is ALSO written by the engine — a
  // Column drag or resize goes straight to `saveGridLayout` from `grid-view.ts`. Refreshing the
  // Toolbar as the control opens is what stops the drift dot lagging a resize by one interaction.
  panel.bump();
  return handle;
}

/**
 * Name the current layout.
 *
 * An existing name overwrites that view — the author who types it means "update this one", and a
 * confirmation for replacing something they can re-save in two clicks is chrome for its own sake. A
 * blank name is refused in the field, so the dialog never returns one.
 */
async function promptSaveView(
  controller: GridController,
  panel: ActiveGridPanel,
  rerender: () => void,
): Promise<string | null> {
  const gridId = controller.source.id;
  const name = await showPromptDialog("Save Grid View", {
    confirmLabel: "Save View",
    message: `Columns, sort, grouping and filter, saved for ${controller.source.label}.`,
    placeholder: "Recent drafts",
    validate: (candidate) => (candidate.trim() === "" ? "Name the view." : ""),
    value: activeViewName(gridId) ?? "",
  });
  if (name === null) {
    return null;
  }
  const saved = saveViewAs(gridId, name);
  if (!saved) {
    // Storage is off (privacy mode): the layout still works, it just cannot be remembered.
    notify.warn("Views cannot be saved — this browser has local storage disabled.", {
      key: "grid.saveView",
      source: "Data",
    });
    return null;
  }
  panel.bump();
  rerender();
  return saved.name;
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
              if (changed === 0) {
                notify.info("No matches.", { key: "grid.replaceAll" });
              } else {
                notify.success(
                  `Replaced in ${changed} cell${changed === 1 ? "" : "s"} — save to apply.`,
                  { action: "file.save", key: "grid.replaceAll" },
                );
              }
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
  panel: ActiveGridPanel,
  onHost: (el: HTMLElement | undefined) => void,
) {
  return html`
    <div class="jx-grid">
      ${toolbarTpl(controller, panel)}
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
export function renderGridMode(surface: CanvasSurface, tab: Tab) {
  const { paneId, wrap: canvasWrap } = surface;
  if (gridPanelMounted(paneId, tab)) {
    return;
  }
  detachGridPanel(paneId);

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
  // `localStorage` is not reactive and neither is the engine, so the toolbar needs something that
  // Is: a saved-view edit bumps this and the panel's one effect re-renders like any other change.
  const local = reactive({ views: 0 });
  const live = controller;
  let hostEl: HTMLElement | null = null;

  const panel: ActiveGridPanel = {
    applyLayout(layout) {
      void live.setSort(layout?.sort ?? null);
      live.setGrouping(layout?.groupBy ?? null);
      panel.remount();
      panel.view?.setSearch(layout?.filter ?? "");
      panel.bump();
    },
    bump() {
      local.views += 1;
    },
    remount() {
      panel.view?.destroy();
      panel.view = hostEl ? createGridView(hostEl, live) : null;
    },
    paneId,
    scope,
    tabId: tab.id,
    view: null,
    wrap: canvasWrap,
  };
  _active.set(paneId, panel);

  const onHost = (el: HTMLElement | undefined) => {
    hostEl = el ?? null;
  };

  // The stored sort, grouping and filter are applied ONCE, when the engine first exists. Re-running
  // Them on every render would fight the author: every ad-hoc header sort would be undone by the
  // Next repaint, which is the behaviour a saved view is supposed to replace, not impose.
  let restored = false;

  scope.run(() => {
    effect(() => {
      if (activeIn(paneId) !== panel) {
        return;
      }
      // Track everything the toolbar shows.
      void controller.state.loading;
      void controller.state.saving;
      void controller.state.error;
      void controller.state.total;
      void controller.state.query.offset;
      void controller.state.grouping;
      void controller.buffer.dirtyCount();
      void local.views;

      litRender(shellTpl(controller, panel, onHost), canvasWrap);

      // Create the engine once the columns exist and the host div is in the DOM.
      if (
        !panel.view &&
        !controller.state.loading &&
        controller.state.columns.length > 0 &&
        hostEl
      ) {
        panel.view = createGridView(hostEl, controller);
        if (!restored) {
          restored = true;
          const layout = loadGridLayout(controller.source.id);
          void controller.setSort(layout?.sort ?? null);
          controller.setGrouping(layout?.groupBy ?? null);
          panel.view.setSearch(layout?.filter ?? "");
        }
      }
    });
  });
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * The live grid surface, or null.
 *
 * Both halves are required: a controller says the active tab HAS a grid, and a mounted panel says
 * the grid is what is on screen. A view command that ran against a grid tab currently showing its
 * Monaco source mode would remount an engine into a host that is not there.
 */
function activeGridSurface(): { controller: GridController; panel: ActiveGridPanel } | null {
  const controller = getGridController(activeTab.value);
  const active = activeIn(workspace.activePaneId);
  if (!controller || !active || active.tabId !== controller.tab.id) {
    return null;
  }
  return { controller, panel: active };
}

/** The saved-view verbs. Every one of them is also a control in the View popover. */
function requireSurface(commandId: string) {
  const surface = activeGridSurface();
  if (!surface) {
    throw new Error(`command "${commandId}" needs a grid on screen`);
  }
  return surface;
}

/**
 * Saved views, as commands.
 *
 * A view is named, so it is addressable, so it belongs in the palette, on the `__jxAutomation`
 * surface and in front of the assistant — not only behind a popover the author has to find. The
 * refusals name what the grid actually holds, in the idiom of `collection.editInGrid`: an unknown
 * view lists the views that exist rather than doing nothing.
 *
 * @returns {AnyCommand[]}
 */
export function gridViewCommands(): AnyCommand[] {
  const viewNameArg = (commandId: string, args: unknown): { gridId: string; name: string } => {
    const { controller } = requireSurface(commandId);
    const gridId = controller.source.id;
    const name = stringArg(commandId, args as Record<string, unknown>, "name");
    const known = listSavedViews(gridId).map((view) => view.name);
    if (!known.includes(name)) {
      throw new RangeError(
        `command "${commandId}" argument "name": "${name}" is not a saved view of ` +
          `${controller.source.label} — it has: ${known.length > 0 ? known.join(", ") : "none"}`,
      );
    }
    return { gridId, name };
  };

  return [
    {
      category: "View",
      id: "grid.saveView",
      level: "document",
      menus: ["palette"],
      group: "5_data",
      requires: "a grid on screen",
      when: (ctx) => ctx.project.open,
      enablement: () => activeGridSurface() !== null,
      aiTool: {
        description:
          "Save the open grid's columns, sort, grouping and filter as a named view. Prompts for the name.",
        name: "save_grid_view",
      },
      run: async () => {
        const { controller, panel } = requireSurface("grid.saveView");
        await promptSaveView(controller, panel, () => {});
      },
      title: "Save Grid View…",
    },
    {
      args: argsSchema({ name: stringProperty("The saved view's name.") }),
      category: "View",
      id: "grid.applyView",
      level: "document",
      menus: ["palette"],
      group: "5_data",
      requires: "a grid on screen",
      when: (ctx) => ctx.project.open,
      enablement: () => activeGridSurface() !== null,
      aiTool: {
        description: "Apply a saved view to the open grid by name.",
        name: "apply_grid_view",
      },
      run: (_ctx, args) => {
        const { gridId, name } = viewNameArg("grid.applyView", args);
        const { panel } = requireSurface("grid.applyView");
        panel.applyLayout(applySavedView(gridId, name));
      },
      title: "Apply Grid View",
    },
    {
      args: argsSchema({ name: stringProperty("The saved view's name.") }),
      category: "View",
      id: "grid.deleteView",
      level: "document",
      menus: ["palette"],
      group: "5_data",
      requires: "a grid on screen",
      destructive: true,
      when: (ctx) => ctx.project.open,
      enablement: () => activeGridSurface() !== null,
      run: (_ctx, args) => {
        const { gridId, name } = viewNameArg("grid.deleteView", args);
        deleteSavedView(gridId, name);
        requireSurface("grid.deleteView").panel.bump();
      },
      title: "Delete Grid View",
    },
    {
      category: "View",
      id: "grid.resetView",
      level: "document",
      menus: ["palette"],
      group: "5_data",
      requires: "a grid on screen",
      when: (ctx) => ctx.project.open,
      enablement: () => activeGridSurface() !== null,
      run: () => {
        const { controller, panel } = requireSurface("grid.resetView");
        resetGridLayout(controller.source.id);
        panel.applyLayout(null);
      },
      title: "Reset Grid View",
    },
  ];
}

/**
 * Register the saved-view commands.
 *
 * @param {CommandRegistry} registry
 */
export function registerGridViewCommands(registry: CommandRegistry): void {
  registry.registerAll(gridViewCommands());
}
