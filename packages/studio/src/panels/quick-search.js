import { html, render as litRender, nothing } from "lit-html";
import { getPlatform } from "../platform.js";
import { openFileInTab } from "../files/files.js";
import { getRecentFiles, trackRecentFile } from "../recent-projects.js";

let _open = false;
let _query = "";
/** @type {any[]} */
let _results = [];
let _selectedIndex = 0;
let _debounceTimer = 0;

/** @type {HTMLElement | null} */
let _container = null;

export function initQuickSearch() {
  _container = document.createElement("div");
  _container.style.display = "contents";
  (document.querySelector("sp-theme") || document.body).appendChild(_container);
}

export function openQuickSearch() {
  _open = true;
  _query = "";
  _results = [];
  _selectedIndex = 0;
  renderOverlay();
  requestAnimationFrame(() => {
    const input = _container?.querySelector(".quick-search-input");
    if (input) /** @type {HTMLInputElement} */ (input).focus();
  });
}

export function closeQuickSearch() {
  _open = false;
  renderOverlay();
}

async function doSearch(/** @type {string} */ query) {
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

function onInput(/** @type {Event} */ e) {
  _query = /** @type {HTMLInputElement} */ (e.target).value;
  clearTimeout(_debounceTimer);
  _debounceTimer = /** @type {any} */ (setTimeout(() => doSearch(_query), 150));
  renderOverlay();
}

function onKeydown(/** @type {KeyboardEvent} */ e) {
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

function selectItem(/** @type {any} */ item) {
  closeQuickSearch();
  const path = item.path;
  trackRecentFile({ path, name: path.split("/").pop() });
  openFileInTab(path);
}

function fileIcon(/** @type {string} */ name) {
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

function dirPart(/** @type {string} */ path) {
  const parts = path.split("/");
  parts.pop();
  return parts.length ? parts.join("/") : "";
}

function renderOverlay() {
  if (!_container) return;
  if (!_open) {
    litRender(nothing, _container);
    return;
  }

  const recentFiles = getRecentFiles();
  const showRecent = !_query.trim();
  const items = showRecent ? recentFiles : _results;

  const tpl = html`
    <div class="quick-search-overlay" @click=${closeQuickSearch}>
      <div class="quick-search-panel" @click=${(/** @type {Event} */ e) => e.stopPropagation()}>
        <input
          class="quick-search-input"
          type="text"
          placeholder="Search project files…"
          .value=${_query}
          @input=${onInput}
          @keydown=${onKeydown}
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
                class="quick-search-item ${i === _selectedIndex ? "selected" : ""}"
                @click=${() => selectItem(item)}
                @mouseenter=${() => {
                  _selectedIndex = i;
                  renderOverlay();
                }}
              >
                <span class="quick-search-icon"
                  >${fileIcon(item.name || item.path.split("/").pop())}</span
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

  litRender(tpl, _container);
}
