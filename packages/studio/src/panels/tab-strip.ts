/// <reference lib="dom" />
/**
 * Tab strip — one strip PER PANE, above each pane's editor.
 *
 * A tab belongs to a pane and the pane is what splits (§4.3), so the strip is a rendering of
 * `Pane.tabOrder` / `Pane.activeTabId`, not of a workspace-wide list. The host for each pane is
 * addressed by REGION id — `pane.primary/tabs`, `pane.secondary/tabs` — rather than by element id,
 * so the shell can move or rename the divs without touching this file.
 *
 * Five things the strip owes the author:
 *
 * - **A label that identifies the document.** A realistic Jx session has four tabs whose basename is
 *   `index.md`, so the label is the shortest unique path suffix — and for a page, its ROUTE, which
 *   is the name the author actually thinks in (`/blog/[slug]`, not a fourth `index.md`).
 * - **A way to reach a tab that is off-screen.** The horizontal scrollbar is hidden by design and the
 *   wheel handler below is a mouse affordance, so a trackpad user with fifteen files open had no
 *   way at all. The overflow chevron lists every tab currently out of view.
 * - **A pin**, so the four documents you keep coming back to hold the head of the strip and no
 *   preview open can take their slot.
 * - **Drag reorder**, clamped so a drag can never interleave a pinned tab with an unpinned one.
 * - **Preview tabs.** A single click from the tree or the palette opens ITALIC and replaceable. This
 *   is worth more in Jx than in VS Code, because the palette's `@`/`#` modes make browsing cheap
 *   and browsing must not litter. Committing — an edit, a pin, a double-click — makes the tab
 *   permanent.
 */

import { html, render as litRender, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { repeat } from "lit-html/directives/repeat.js";
import { effect, effectScope } from "../reactivity";
import {
  activateTab,
  closeTab,
  focusPane,
  moveTab,
  promoteDirtyPreviewTabs,
  promoteTab,
  setTabPinned,
  workspace,
} from "../workspace/workspace";
import { gridTabLabel } from "../grid/grid-source";
import type { Pane } from "../workspace/workspace";
import type { Tab } from "../tabs/tab";
import { renderPopover, showConfirmDialog } from "../ui/layers";
import { collabState } from "../collab/collab-state";
import { rectOf } from "../utils/geometry";
import { resolveRegion } from "../ui/regions";
import type { EffectScope } from "@vue/reactivity";

/**
 * The primary pane's host, as handed over by the shell's bootstrap.
 *
 * Every OTHER pane's host is resolved by region id at render time, because a pane can appear and
 * disappear between renders and there is nothing to hand over when it does.
 */
let _primaryHost: HTMLElement | null = null;

let _scope: EffectScope | null = null;

/** Last-rendered active tab per pane — decides when to scroll a chip into view. */
const _lastActive = new Map<string, string | null>();

/** Whether each pane's strip overflows — decides its chevron. Measured after each render. */
const _overflowing = new Map<string, boolean>();

let _overflowHandle: { dismiss: () => void } | null = null;

/** The tab id currently being dragged, or null. */
let _dragging: string | null = null;

/** Region id of a pane's tab strip. `ui/regions.ts` owns the grammar; this is one call site. */
export function paneStripRegion(paneId: string): string {
  return `pane.${paneId}/tabs`;
}

/**
 * Where a pane's strip renders.
 *
 * The primary falls back to the host the shell passed in, because that div is stamped
 * `pane.primary/tabs` by `stampShellRegions()` only once the DOM is up — and the tests mount a
 * detached node.
 */
function hostFor(pane: Pane): HTMLElement | null {
  return resolveRegion(paneStripRegion(pane.id)) ?? (pane.id === "primary" ? _primaryHost : null);
}

/**
 * Mount the tab strips. `host` is the PRIMARY pane's strip host.
 *
 * @param {HTMLElement} host
 */
export function mount(host: HTMLElement) {
  _primaryHost = host;
  _lastActive.clear();
  _overflowing.clear();
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      void workspace.activePaneId;
      for (const pane of workspace.panes) {
        void pane.id;
        void pane.tabOrder;
        void pane.activeTabId;
      }
      for (const tab of workspace.tabs.values()) {
        void tab.doc.dirty;
        void tab.documentPath;
        void tab.pinned;
        void tab.preview;
        void tab.session.openedFrom;
      }
      // An edit is a commitment: a preview tab with unsaved changes is no longer disposable, and
      // The dirty flags this effect already tracks are exactly the signal.
      promoteDirtyPreviewTabs();
      render();
    });
  });
}

export function unmount() {
  dismissOverflowMenu();
  _scope?.stop();
  _scope = null;
  _primaryHost = null;
  _dragging = null;
  _lastActive.clear();
  _overflowing.clear();
}

function render() {
  const seen = new Set<string>();
  for (const pane of workspace.panes) {
    seen.add(pane.id);
    renderPane(pane);
  }
  // A pane that has gone away leaves a host behind only when the shell keeps the div; blank it so
  // No strip outlives its pane.
  const stalePanes = [..._lastActive.keys()].filter((paneId) => !seen.has(paneId));
  for (const paneId of stalePanes) {
    _lastActive.delete(paneId);
    _overflowing.delete(paneId);
    const stale = resolveRegion(paneStripRegion(paneId));
    if (stale) {
      litRender(nothing, stale);
    }
  }
}

function renderPane(pane: Pane) {
  const host = hostFor(pane);
  if (!host) {
    return;
  }

  if (pane.tabOrder.length === 0) {
    _lastActive.set(pane.id, null);
    _overflowing.set(pane.id, false);
    litRender(nothing, host);
    return;
  }

  const labels = tabLabels(pane);
  const focused = pane.id === workspace.activePaneId;

  litRender(
    html`
      <div
        class=${classMap({ focused, "tab-strip-row": true })}
        @mousedown=${() => focusPane(pane.id)}
      >
        <div class="tab-strip" @wheel=${onWheel}>
          ${repeat(
            pane.tabOrder,
            (id) => id,
            (id, index) => tabChip(pane, id, index, labels),
          )}
        </div>
        ${
          _overflowing.get(pane.id) === true
            ? // ONE accessible name (§10): the glyph is hidden, so `title` is both the tooltip and
              // The name — `title` + a matching `aria-label` would announce it twice.
              html`<button
                class="tab-strip-overflow"
                title="Show hidden tabs"
                @click=${(e: MouseEvent) => openOverflowMenu(e, pane, labels)}
              >
                <span aria-hidden="true">⌄</span>
              </button>`
            : nothing
        }
      </div>
    `,
    host,
  );

  if (pane.activeTabId !== _lastActive.get(pane.id)) {
    _lastActive.set(pane.id, pane.activeTabId);
    host.querySelector(".tab-strip-tab.active")?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }

  syncOverflow(pane, host);
}

/**
 * One chip.
 *
 * @param {Pane} pane
 * @param {string} id
 * @param {number} index — the chip's slot in the pane's order, which is the drop target index
 * @param {Map<string, string>} labels
 */
function tabChip(pane: Pane, id: string, index: number, labels: Map<string, string>) {
  const tab = workspace.tabs.get(id);
  if (!tab) {
    return nothing;
  }
  const isActive = id === pane.activeTabId;
  const label = labels.get(id) ?? "Untitled";
  const origin = tab.session.openedFrom;
  return html`
    <div
      class=${classMap({
        active: isActive,
        dragging: _dragging === id,
        pinned: tab.pinned,
        preview: tab.preview,
        "tab-strip-tab": true,
      })}
      draggable="true"
      @click=${() => activateTab(id)}
      @dblclick=${() => promoteTab(id)}
      @dragstart=${(e: DragEvent) => onDragStart(e, id)}
      @dragend=${() => onDragEnd()}
      @dragover=${(e: DragEvent) => e.preventDefault()}
      @drop=${(e: DragEvent) => onDrop(e, pane, index)}
      @auxclick=${(e: MouseEvent) => {
        if (e.button === 1) {
          e.preventDefault();
          void requestClose(id);
        }
      }}
      title=${tabTooltip(tab)}
    >
      ${origin ? html`<span class="tab-strip-origin" aria-hidden="true">↳</span>` : nothing}
      <span class="tab-strip-label">${label}</span>
      ${tab.doc.dirty ? html`<span class="tab-strip-dirty">●</span>` : nothing}
      <button
        class="tab-strip-pin"
        title=${tab.pinned ? "Unpin" : "Pin"}
        @click=${(e: Event) => {
          e.stopPropagation();
          setTabPinned(id, !tab.pinned);
        }}
      >
        <span aria-hidden="true">${tab.pinned ? "◉" : "◎"}</span>
      </button>
      <button
        class="tab-strip-close"
        title="Close"
        @click=${(e: Event) => {
          e.stopPropagation();
          void requestClose(id);
        }}
      >
        ×
      </button>
    </div>
  `;
}

// ─── Drag reorder ─────────────────────────────────────────────────────────────

function onDragStart(e: DragEvent, id: string) {
  _dragging = id;
  e.dataTransfer?.setData("text/plain", id);
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
  }
  // The ghost is chrome state, not model state, so no effect fires for it.
  render();
}

function onDragEnd() {
  _dragging = null;
  render();
}

/**
 * Drop onto the chip at `index`. The model clamps the destination into the region the dragged tab's
 * pinned state allows, so this only has to say where the pointer was.
 */
function onDrop(e: DragEvent, pane: Pane, index: number) {
  e.preventDefault();
  const id = _dragging ?? e.dataTransfer?.getData("text/plain") ?? null;
  _dragging = null;
  if (!id || !pane.tabOrder.includes(id)) {
    return;
  }
  moveTab(id, index);
}

/**
 * Re-measure a pane's strip and re-render once if the chevron's presence changed.
 *
 * Measurement can only happen after lit has written the DOM, so this runs at the tail of
 * `renderPane()` and guards its own re-entry on the boolean actually flipping — the chevron cannot
 * oscillate.
 */
function syncOverflow(pane: Pane, host: HTMLElement) {
  const strip = host.querySelector(".tab-strip") as HTMLElement | null;
  if (!strip) {
    return;
  }
  const overflowing = strip.scrollWidth > strip.clientWidth;
  if (overflowing !== (_overflowing.get(pane.id) === true)) {
    _overflowing.set(pane.id, overflowing);
    renderPane(pane);
  }
}

/**
 * Scroll the strip horizontally from wheel motion so overflowed tabs stay reachable — a plain mouse
 * wheel only emits deltaY, which does nothing in an overflow-x container. The scrollbar is hidden
 * by design; the overflow chevron is the pointer-independent route to the same tabs.
 *
 * @param {WheelEvent} e
 */
function onWheel(e: WheelEvent) {
  if (e.ctrlKey) {
    return;
  }
  const el = e.currentTarget as HTMLElement;
  if (el.scrollWidth <= el.clientWidth) {
    return;
  }
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!delta) {
    return;
  }
  e.preventDefault();
  el.scrollLeft += delta;
}

// ─── Overflow menu ────────────────────────────────────────────────────────────

/**
 * Tab ids whose chip is wholly or partly outside a pane strip's scroll viewport.
 *
 * @param {string} [paneId] — defaults to the focused pane
 */
export function hiddenTabIds(paneId: string = workspace.activePaneId): string[] {
  const pane = workspace.panes.find((candidate) => candidate.id === paneId);
  const host = pane ? hostFor(pane) : null;
  const strip = host?.querySelector(".tab-strip") as HTMLElement | null;
  if (!pane || !strip) {
    return [];
  }
  const left = strip.scrollLeft;
  const right = left + strip.clientWidth;
  const hidden: string[] = [];
  const chips = [...strip.querySelectorAll(".tab-strip-tab")] as HTMLElement[];
  for (const [index, chip] of chips.entries()) {
    const id = pane.tabOrder[index];
    if (id && (chip.offsetLeft < left || chip.offsetLeft + chip.offsetWidth > right)) {
      hidden.push(id);
    }
  }
  return hidden;
}

export function dismissOverflowMenu() {
  _overflowHandle?.dismiss();
  _overflowHandle = null;
}

/**
 * List the off-screen tabs. Falls back to every tab when nothing measures as hidden, because an
 * empty menu is a dead control and happy-dom (plus any zero-height layout) measures everything at
 * 0.
 *
 * @param {MouseEvent} e
 * @param {Pane} pane
 * @param {Map<string, string>} labels
 */
function openOverflowMenu(e: MouseEvent, pane: Pane, labels: Map<string, string>) {
  e.stopPropagation();
  dismissOverflowMenu();
  const hidden = hiddenTabIds(pane.id);
  const ids = hidden.length > 0 ? hidden : [...pane.tabOrder];
  const anchor = rectOf(e.currentTarget as HTMLElement);
  _overflowHandle = renderPopover(
    html`<sp-popover
      open
      style="position:fixed;z-index:10000;right:${Math.max(
        4,
        window.innerWidth - anchor.right,
      )}px;top:${anchor.bottom}px"
    >
      <sp-menu>
        ${ids.map(
          (id) => html`<sp-menu-item
            ?selected=${id === pane.activeTabId}
            @click=${() => {
              dismissOverflowMenu();
              activateTab(id);
            }}
            >${labels.get(id) ?? "Untitled"}</sp-menu-item
          >`,
        )}
      </sp-menu>
    </sp-popover>`,
    {
      dismissOnOutsideClick: true,
      onDismiss: () => {
        _overflowHandle = null;
      },
    },
  );
}

// ─── Labels ───────────────────────────────────────────────────────────────────

/** One tab as the labeller sees it. */
export interface LabelInput {
  id: string;
  documentPath: string | null;
  /** What to show when there is no path at all (a virtual grid tab, an untitled document). */
  fallback: string;
}

/**
 * A page's route, or null when the path is not a page.
 *
 * `pages/blog/[slug].md` → `/blog/[slug]`, `pages/about/index.md` → `/about`, `pages/index.md` →
 * `/`. The route is what the author named the thing; the file name is an implementation detail of
 * the router, and it is the same word (`index`) for every section of the site.
 *
 * @param {string} path
 * @returns {string | null}
 */
export function pageRoute(path: string): string | null {
  const normalized = path.replace(/^\.\//, "");
  if (!normalized.startsWith("pages/")) {
    return null;
  }
  const withoutExt = normalized.slice("pages/".length).replace(/\.[^./]+$/, "");
  const segments = withoutExt.split("/").filter((segment) => segment !== "");
  if (segments.at(-1) === "index") {
    segments.pop();
  }
  return `/${segments.join("/")}`;
}

/**
 * Give every tab the shortest path suffix that tells it apart from the others.
 *
 * Pages label by route and are exempt from the widening loop — two distinct files cannot produce
 * one route. Everything else starts at its basename and grows one leading segment at a time, but
 * only within the group that actually collides, so one pair of `index.json` files does not push a
 * path onto every other tab in the strip.
 *
 * @param {LabelInput[]} inputs
 * @returns {Map<string, string>} Tab id → label
 */
export function computeTabLabels(inputs: LabelInput[]): Map<string, string> {
  interface Entry {
    id: string;
    parts: string[];
    depth: number;
    label: string;
    fixed: boolean;
  }
  const entries: Entry[] = inputs.map((input) => {
    const path = input.documentPath;
    if (!path) {
      return { depth: 0, fixed: true, id: input.id, label: input.fallback, parts: [] };
    }
    const route = pageRoute(path);
    if (route !== null) {
      return { depth: 0, fixed: true, id: input.id, label: route, parts: [] };
    }
    const parts = path.split("/").filter((segment) => segment !== "" && segment !== ".");
    return {
      depth: 1,
      fixed: false,
      id: input.id,
      label: parts.slice(-1).join("/") || path,
      parts,
    };
  });

  // Each pass widens exactly the entries that still collide. It terminates because every pass
  // Either widens at least one entry (bounded by its segment count) or changes nothing.
  for (;;) {
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
      const group = groups.get(entry.label);
      if (group) {
        group.push(entry);
      } else {
        groups.set(entry.label, [entry]);
      }
    }
    let widened = false;
    for (const group of groups.values()) {
      if (group.length < 2) {
        continue;
      }
      for (const entry of group) {
        if (entry.fixed || entry.depth >= entry.parts.length) {
          continue;
        }
        entry.depth += 1;
        entry.label = entry.parts.slice(-entry.depth).join("/");
        widened = true;
      }
    }
    if (!widened) {
      break;
    }
  }

  return new Map(entries.map((entry) => [entry.id, entry.label]));
}

/**
 * Labels for the tabs in one pane, keyed by tab id.
 *
 * Disambiguation is per-pane on purpose: the strip is what has to be readable, and widening a label
 * because a tab in the OTHER pane collides with it would make one strip harder to read to solve a
 * problem nobody can see.
 *
 * @param {Pane} pane
 */
function tabLabels(pane: Pane): Map<string, string> {
  return computeTabLabels(
    pane.tabOrder.flatMap((id) => {
      const tab = workspace.tabs.get(id);
      return tab
        ? [
            {
              documentPath: tab.documentPath,
              fallback: gridTabLabel(tab.id) ?? "Untitled",
              id,
            },
          ]
        : [];
    }),
  );
}

/**
 * The hover text: the full path, plus the document this tab was drilled in from.
 *
 * @param {Tab} tab
 * @returns {string}
 */
function tabTooltip(tab: Tab): string {
  const base = tab.documentPath || gridTabLabel(tab.id) || "Untitled";
  const origin = tab.session.openedFrom;
  const withOrigin = origin?.documentPath ? `${base}\nOpened from ${origin.documentPath}` : base;
  return tab.preview ? `${withOrigin}\nPreview — double-click to keep open` : withOrigin;
}

/**
 * The label a single tab shows. Exported for the close-confirmation copy, which names one tab with
 * no strip to disambiguate it against.
 *
 * @param {Tab} tab
 * @returns {string}
 */
export function tabLabel(tab: Tab): string {
  const path = tab.documentPath;
  if (!path) {
    return gridTabLabel(tab.id) ?? "Untitled";
  }
  return pageRoute(path) ?? path.split("/").at(-1) ?? path;
}

/**
 * True when closing this tab would lose unsaved work the user must be warned about: the tab is
 * dirty AND either it is not co-edited, or this client is the last active collaborator on the doc
 * (no other peer is focused on its path). When peers remain, the shared session lives on and the
 * edits are still on the server, so closing is safe.
 *
 * @param {Tab} tab
 */
export function shouldWarnOnClose(tab: Tab): boolean {
  if (!tab.doc.dirty) {
    return false;
  }
  const state = collabState(tab);
  if (!state.active) {
    return true;
  }
  const peersHere = state.peers.filter((p) => p.state?.focusedPath === tab.documentPath);
  return peersHere.length === 0;
}

/**
 * Close a tab, prompting if closing would lose unsaved work.
 *
 * @param {string} id
 */
async function requestClose(id: string) {
  const tab = workspace.tabs.get(id);
  if (!tab) {
    return;
  }
  if (shouldWarnOnClose(tab)) {
    const confirmed = await showConfirmDialog(
      "Unsaved Changes",
      `"${tabLabel(tab)}" has unsaved changes. Close without saving?`,
      { confirmLabel: "Close", destructive: true },
    );
    if (!confirmed) {
      return;
    }
  }
  closeTab(id);
}
