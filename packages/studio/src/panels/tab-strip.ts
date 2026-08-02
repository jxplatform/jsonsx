/// <reference lib="dom" />
/**
 * Tab strip — renders open tabs above the canvas area.
 *
 * Uses the reactive workspace model: reads from workspace.tabOrder, workspace.tabs,
 * workspace.activeTabId. Clicks call activateTab/closeTab from workspace.js.
 *
 * Two things the strip owes the author, both of which it used to withhold:
 *
 * - **A label that identifies the document.** A realistic Jx session has four tabs whose basename is
 *   `index.md`, so the label is the shortest unique path suffix — and for a page, its ROUTE, which
 *   is the name the author actually thinks in (`/blog/[slug]`, not a fourth `index.md`).
 * - **A way to reach a tab that is off-screen.** The horizontal scrollbar is hidden by design and the
 *   wheel handler below is a mouse affordance, so a trackpad user with fifteen files open had no
 *   way at all. The overflow chevron lists every tab currently out of view.
 */

import { html, render as litRender, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { repeat } from "lit-html/directives/repeat.js";
import { effect, effectScope } from "../reactivity";
import { activateTab, closeTab, workspace } from "../workspace/workspace";
import { gridTabLabel } from "../grid/grid-source";
import type { Tab } from "../tabs/tab";
import { renderPopover, showConfirmDialog } from "../ui/layers";
import { collabState } from "../collab/collab-state";
import { rectOf } from "../utils/geometry";
import type { EffectScope } from "@vue/reactivity";

let _host: HTMLElement | null = null;

let _scope: EffectScope | null = null;

let _lastActiveId: string | null = null;

/** Whether the strip currently overflows — decides the chevron. Measured after each render. */
let _overflowing = false;

let _overflowHandle: { dismiss: () => void } | null = null;

/**
 * Mount the tab strip into the given host element.
 *
 * @param {HTMLElement} host
 */
export function mount(host: HTMLElement) {
  _host = host;
  _lastActiveId = null;
  _overflowing = false;
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      void workspace.tabOrder;
      void workspace.activeTabId;
      for (const tab of workspace.tabs.values()) {
        void tab.doc.dirty;
        void tab.documentPath;
        void tab.session.openedFrom;
      }
      render();
    });
  });
}

export function unmount() {
  dismissOverflowMenu();
  _scope?.stop();
  _scope = null;
  _host = null;
}

function render() {
  if (!_host) {
    return;
  }

  if (workspace.tabOrder.length === 0) {
    _lastActiveId = null;
    _overflowing = false;
    litRender(nothing, _host);
    return;
  }

  const labels = tabLabels();

  litRender(
    html`
      <div class="tab-strip-row">
        <div class="tab-strip" @wheel=${onWheel}>
          ${repeat(
            workspace.tabOrder,
            (id) => id,
            (id) => {
              const tab = workspace.tabs.get(id);
              if (!tab) {
                return nothing;
              }
              const isActive = id === workspace.activeTabId;
              const isDirty = tab.doc.dirty;
              const label = labels.get(id) ?? "Untitled";
              const origin = tab.session.openedFrom;
              return html`
                <div
                  class=${classMap({ active: isActive, "tab-strip-tab": true })}
                  @click=${() => activateTab(id)}
                  @auxclick=${(e: MouseEvent) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      void requestClose(id);
                    }
                  }}
                  title=${tabTooltip(tab)}
                >
                  ${
                    origin
                      ? html`<span class="tab-strip-origin" aria-hidden="true">↳</span>`
                      : nothing
                  }
                  <span class="tab-strip-label">${label}</span>
                  ${isDirty ? html`<span class="tab-strip-dirty">●</span>` : nothing}
                  <button
                    class="tab-strip-close"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      void requestClose(id);
                    }}
                  >
                    ×
                  </button>
                </div>
              `;
            },
          )}
        </div>
        ${
          _overflowing
            ? // ONE accessible name (§10): the glyph is hidden, so `title` is both the tooltip and
              // The name — `title` + a matching `aria-label` would announce it twice.
              html`<button
                class="tab-strip-overflow"
                title="Show hidden tabs"
                @click=${(e: MouseEvent) => openOverflowMenu(e, labels)}
              >
                <span aria-hidden="true">⌄</span>
              </button>`
            : nothing
        }
      </div>
    `,
    _host,
  );

  if (workspace.activeTabId !== _lastActiveId) {
    _lastActiveId = workspace.activeTabId;
    _host
      .querySelector(".tab-strip-tab.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  syncOverflow();
}

/**
 * Re-measure the strip and re-render once if the chevron's presence changed.
 *
 * Measurement can only happen after lit has written the DOM, so this runs at the tail of `render()`
 * and guards its own re-entry on the boolean actually flipping — the chevron cannot oscillate.
 */
function syncOverflow() {
  const strip = _host?.querySelector(".tab-strip") as HTMLElement | null;
  if (!strip) {
    return;
  }
  const overflowing = strip.scrollWidth > strip.clientWidth;
  if (overflowing !== _overflowing) {
    _overflowing = overflowing;
    render();
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

/** Tab ids whose chip is wholly or partly outside the strip's scroll viewport. */
export function hiddenTabIds(): string[] {
  const strip = _host?.querySelector(".tab-strip") as HTMLElement | null;
  if (!strip) {
    return [];
  }
  const left = strip.scrollLeft;
  const right = left + strip.clientWidth;
  const hidden: string[] = [];
  const chips = [...strip.querySelectorAll(".tab-strip-tab")] as HTMLElement[];
  for (const [index, chip] of chips.entries()) {
    const id = workspace.tabOrder[index];
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
 * @param {Map<string, string>} labels
 */
function openOverflowMenu(e: MouseEvent, labels: Map<string, string>) {
  e.stopPropagation();
  dismissOverflowMenu();
  const hidden = hiddenTabIds();
  const ids = hidden.length > 0 ? hidden : [...workspace.tabOrder];
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
            ?selected=${id === workspace.activeTabId}
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

/** Labels for the tabs currently open, keyed by tab id. */
function tabLabels(): Map<string, string> {
  return computeTabLabels(
    workspace.tabOrder.flatMap((id) => {
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
  return origin?.documentPath ? `${base}\nOpened from ${origin.documentPath}` : base;
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
