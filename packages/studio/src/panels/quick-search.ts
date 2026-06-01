import { html, render as litRender, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { live } from "lit-html/directives/live.js";
import { ref } from "lit-html/directives/ref.js";
import { getPlatform } from "../platform";
import { openFileInTab } from "../files/files";
import { getRecentFiles, trackRecentFile } from "../recent-projects";
import { getLayerSlot } from "../ui/layers";

let _open = false;
let _query = "";
/** @type {{ path: string; name?: string }[]} */
let _results: { path: string; name?: string }[] = [];
let _selectedIndex = 0;
let _debounceTimer = 0;

/** @returns {HTMLElement} */
function getContainer() {
  return getLayerSlot("popover", "quick-search");
}

export function initQuickSearch() {
  // No-op — container is now provided by the layer system
}

export function openQuickSearch() {
  _open = true;
  _query = "";
  _results = [];
  _selectedIndex = 0;
  renderOverlay();
}

export function closeQuickSearch() {
  _open = false;
  renderOverlay();
}

async function doSearch(query: string) {
  if (!query.trim()) {
    _results = [];
    _selectedIndex = 0;
    renderOverlay();
    return;
  }
  try {
    const platform = getPlatform();
    _results = await platform.searchFiles(query.trim().toLowerCase());
    _selectedIndex = 0;
    renderOverlay();
  } catch {
    _results = [];
    renderOverlay();
  }
}

function onInput(e: Event) {
  _query = (e.target as HTMLInputElement).value;
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => doSearch(_query), 150) as unknown as number;
  renderOverlay();
}

function onKeydown(e: KeyboardEvent) {
  const items = _query.trim() ? _results : getRecentFiles();
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      _selectedIndex = Math.min(_selectedIndex + 1, items.length - 1);
      renderOverlay();
      break;
    case "ArrowUp":
      e.preventDefault();
      _selectedIndex = Math.max(_selectedIndex - 1, 0);
      renderOverlay();
      break;
    case "Enter":
      e.preventDefault();
      if (items[_selectedIndex]) selectItem(items[_selectedIndex]);
      break;
    case "Escape":
      e.preventDefault();
      closeQuickSearch();
      break;
  }
}

function selectItem(item: { path: string; name?: string }) {
  closeQuickSearch();
  const path = item.path;
  trackRecentFile({ path, name: path.split("/").pop() || "" });
  openFileInTab(path);
}

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "json":
      return html`<sp-icon-file-code size="s"></sp-icon-file-code>`;
    case "md":
      return html`<sp-icon-file-txt size="s"></sp-icon-file-txt>`;
    default:
      return html`<sp-icon-document size="s"></sp-icon-document>`;
  }
}

function dirPart(path: string) {
  const parts = path.split("/");
  parts.pop();
  return parts.length ? parts.join("/") : "";
}

function renderOverlay() {
  const container = getContainer();
  if (!_open) {
    litRender(nothing, container);
    return;
  }

  const recentFiles = getRecentFiles();
  const showRecent = !_query.trim();
  const items = showRecent ? recentFiles : _results;

  const tpl = html`
    <div class="quick-search-overlay" @click=${closeQuickSearch}>
      <div class="quick-search-panel" @click=${(e: Event) => e.stopPropagation()}>
        <input
          class="quick-search-input"
          type="text"
          placeholder="Search project files…"
          .value=${live(_query)}
          @input=${onInput}
          @keydown=${onKeydown}
          ${ref((el) => {
            if (el) requestAnimationFrame(() => (el as HTMLInputElement).focus());
          })}
        />
        <div class="quick-search-results">
          ${items.length === 0 && _query.trim()
            ? html`<div class="quick-search-empty">No results</div>`
            : nothing}
          ${items.length === 0 && !_query.trim() && recentFiles.length === 0
            ? html`<div class="quick-search-empty">Type to search project files</div>`
            : nothing}
          ${showRecent && recentFiles.length
            ? html`<div class="quick-search-section-label">Recently opened</div>`
            : nothing}
          ${items.map(
            (item, i) => html`
              <div
                class=${classMap({ "quick-search-item": true, selected: i === _selectedIndex })}
                @click=${() => selectItem(item)}
                @mouseenter=${() => {
                  _selectedIndex = i;
                  renderOverlay();
                }}
              >
                <span class="quick-search-icon"
                  >${fileIcon(item.name || item.path.split("/").pop() || "")}</span
                >
                <span class="quick-search-name">${item.name || item.path.split("/").pop()}</span>
                <span class="quick-search-path">${dirPart(item.path)}</span>
                ${showRecent ? html`<span class="quick-search-badge">recent</span>` : nothing}
              </div>
            `,
          )}
        </div>
      </div>
    </div>
  `;

  litRender(tpl, container);
}
