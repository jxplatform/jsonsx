/// <reference lib="dom" />
/**
 * Formula palette — a command-palette overlay for browsing/searching the formula catalog (spec
 * §19.9). Clones the quick-search pattern: a plain overlay div (no nested sp-overlay), a search
 * field, grouped results, and keyboard navigation. Picking an entry calls `onPick` with it; the
 * caller decides what to insert.
 */

import { html, render as litRender, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { live } from "lit-html/directives/live.js";
import { ref } from "lit-html/directives/ref.js";
import { getLayerSlot } from "./layers";
import { rectOf } from "../utils/geometry";

import type { FormulaCatalogEntry } from "./formula-catalog";

export interface FormulaPaletteOpts {
  entries: FormulaCatalogEntry[];
  onPick: (entry: FormulaCatalogEntry) => void;
  /** Optional anchor element the panel is positioned under; centered when absent. */
  anchor?: HTMLElement | null;
}

let _open = false;
let _opts: FormulaPaletteOpts | null = null;
let _query = "";
let _selectedIndex = 0;

function getContainer() {
  return getLayerSlot("popover", "formula-palette");
}

export function openFormulaPalette(opts: FormulaPaletteOpts) {
  _open = true;
  _opts = opts;
  _query = "";
  _selectedIndex = 0;
  renderOverlay();
}

export function closeFormulaPalette() {
  _open = false;
  _opts = null;
  renderOverlay();
}

/** Entries matching the current query (label, name, group, or description substring). */
function filteredEntries(): FormulaCatalogEntry[] {
  const entries = _opts?.entries ?? [];
  const needle = _query.trim().toLowerCase();
  if (!needle) {
    return entries;
  }
  return entries.filter(
    (e) =>
      e.label.toLowerCase().includes(needle) ||
      e.name.toLowerCase().includes(needle) ||
      e.group.toLowerCase().includes(needle) ||
      e.description.toLowerCase().includes(needle),
  );
}

/** Group entries for display, preserving first-seen group order. */
function groupedEntries(entries: FormulaCatalogEntry[]): [string, FormulaCatalogEntry[]][] {
  const groups = new Map<string, FormulaCatalogEntry[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.group);
    if (bucket) {
      bucket.push(entry);
    } else {
      groups.set(entry.group, [entry]);
    }
  }
  return [...groups.entries()];
}

function pickEntry(entry: FormulaCatalogEntry) {
  const opts = _opts;
  closeFormulaPalette();
  opts?.onPick(entry);
}

function onInput(e: Event) {
  _query = (e.target as HTMLInputElement).value;
  _selectedIndex = 0;
  renderOverlay();
}

function onKeydown(e: KeyboardEvent) {
  const entries = filteredEntries();
  switch (e.key) {
    case "ArrowDown": {
      e.preventDefault();
      _selectedIndex = Math.min(_selectedIndex + 1, entries.length - 1);
      renderOverlay();
      break;
    }
    case "ArrowUp": {
      e.preventDefault();
      _selectedIndex = Math.max(_selectedIndex - 1, 0);
      renderOverlay();
      break;
    }
    case "Enter": {
      e.preventDefault();
      if (entries[_selectedIndex]) {
        pickEntry(entries[_selectedIndex]!);
      }
      break;
    }
    case "Escape": {
      e.preventDefault();
      closeFormulaPalette();
      break;
    }
    default: {
      break;
    }
  }
}

/** Inline position style for the panel when anchored to an element. */
function panelStyle(): string {
  const anchor = _opts?.anchor;
  if (!anchor) {
    return "";
  }
  const rect = rectOf(anchor);
  if (!rect || (rect.top === 0 && rect.left === 0 && rect.width === 0)) {
    return "";
  }
  const left = Math.max(8, Math.min(rect.left, (globalThis.innerWidth || 1200) - 568));
  return `position:fixed;left:${left}px;top:${rect.bottom + 4}px;margin:0`;
}

function renderOverlay() {
  const container = getContainer();
  if (!_open) {
    litRender(nothing, container);
    return;
  }

  const entries = filteredEntries();
  const groups = groupedEntries(entries);
  const hasQuery = _query.trim().length > 0;

  const tpl = html`
    <div class="quick-search-overlay formula-palette-overlay" @click=${closeFormulaPalette}>
      <div
        class="quick-search-panel formula-palette"
        style=${panelStyle()}
        @click=${(e: Event) => e.stopPropagation()}
      >
        <input
          class="quick-search-input formula-palette-input"
          type="text"
          placeholder="Search formulas, operators, globals…"
          .value=${live(_query)}
          @input=${onInput}
          @keydown=${onKeydown}
          ${ref((el) => {
            if (el) {
              requestAnimationFrame(() => (el as HTMLInputElement).focus());
            }
          })}
        />
        <div class="quick-search-results">
          ${
            entries.length === 0
              ? html`<div class="quick-search-empty">
                  ${hasQuery ? "No results" : "No entries available"}
                </div>`
              : nothing
          }
          ${groups.map(
            ([group, groupEntries]) => html`
              <div class="quick-search-section-label">${group}</div>
              ${groupEntries.map((entry) => {
                const index = entries.indexOf(entry);
                return html`
                  <div
                    class=${classMap({
                      "quick-search-item": true,
                      selected: index === _selectedIndex,
                    })}
                    @click=${() => pickEntry(entry)}
                    @mouseenter=${() => {
                      _selectedIndex = index;
                      renderOverlay();
                    }}
                  >
                    <span
                      class="quick-search-name"
                      style="font-family:var(--spectrum-code-font-family, monospace)"
                      >${entry.label}</span
                    >
                    <span class="quick-search-path" title=${entry.description}
                      >${entry.description}</span
                    >
                    <span class="quick-search-badge">${entry.kind}</span>
                  </div>
                `;
              })}
            `,
          )}
        </div>
      </div>
    </div>
  `;

  litRender(tpl, container);
}
