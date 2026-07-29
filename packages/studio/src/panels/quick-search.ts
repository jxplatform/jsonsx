/// <reference lib="dom" />
import { html, render as litRender, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { live } from "lit-html/directives/live.js";
import { ref } from "lit-html/directives/ref.js";
import { getPlatform } from "../platform";
import { projectState } from "../store";
import { documentExtensions, formatByExtension, loadFormats } from "../format/format-host";
import { openFileInTab } from "../files/files";
import { getRecentFiles, getRecentProjects, trackRecentFile } from "../recent-projects";
import { getLayerSlot } from "../ui/layers";

/**
 * A row in the Quick Access modal. With a project open the modal lists/searches that project's
 * files; with no project open it lists recent projects to re-open. The two never mix — the modal
 * only ever shows files from the current project.
 */
interface FileItem {
  kind: "file";
  path: string;
  name: string;
}
interface ProjectItem {
  kind: "project";
  root: string;
  name: string;
}
type QuickItem = FileItem | ProjectItem;

interface QuickCtx {
  openRecentProject: (root: string) => void | Promise<void>;
}

let _ctx: QuickCtx | null = null;
let _open = false;
let _query = "";
let _results: FileItem[] = [];
let _selectedIndex = 0;
let _debounceTimer = 0;

/** @returns {HTMLElement} */
function getContainer() {
  return getLayerSlot("popover", "quick-search");
}

/** @param {QuickCtx} [ctx] */
export function initQuickSearch(ctx?: QuickCtx) {
  _ctx = ctx ?? null;
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

/** The project root scoping the modal, or null when no project is open. */
function scopeRoot(): string | null {
  return projectState ? (projectState.projectRoot ?? null) : null;
}

/**
 * Resolve the rows to display for the current query/mode. File search is async (populates
 * `_results`); recent files and recent-project filtering are synchronous.
 */
function currentItems(): { items: QuickItem[]; showingRecent: boolean } {
  const q = _query.trim();
  if (!projectState) {
    // No project open → offer recent projects to re-open, filtered by the query.
    const needle = q.toLowerCase();
    const projects = getRecentProjects().filter(
      (p) =>
        !needle || p.name.toLowerCase().includes(needle) || p.root.toLowerCase().includes(needle),
    );
    return {
      items: projects.map((p) => ({ kind: "project", name: p.name, root: p.root })),
      showingRecent: !q,
    };
  }
  if (!q) {
    const recent = getRecentFiles(scopeRoot() ?? undefined);
    return {
      items: recent.map((f) => ({ kind: "file", name: f.name, path: f.path })),
      showingRecent: true,
    };
  }
  return { items: _results, showingRecent: false };
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
    await loadFormats();
    const hits = await platform.searchFiles(query.trim().toLowerCase(), documentExtensions());
    _results = hits.map((h) => ({
      kind: "file",
      name: h.name ?? h.path.split("/").pop() ?? "",
      path: h.path,
    }));
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
  // Only file search needs the backend (and debouncing); recent-project filtering is synchronous.
  if (projectState) {
    _debounceTimer = setTimeout(() => doSearch(_query), 150) as unknown as number;
  }
  _selectedIndex = 0;
  renderOverlay();
}

function onKeydown(e: KeyboardEvent) {
  const { items } = currentItems();
  switch (e.key) {
    case "ArrowDown": {
      e.preventDefault();
      _selectedIndex = Math.min(_selectedIndex + 1, items.length - 1);
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
      if (items[_selectedIndex]) {
        selectItem(items[_selectedIndex]!);
      }
      break;
    }
    case "Escape": {
      e.preventDefault();
      closeQuickSearch();
      break;
    }
    default: {
      break;
    }
  }
}

function selectItem(item: QuickItem) {
  closeQuickSearch();
  if (item.kind === "project") {
    void _ctx?.openRecentProject(item.root);
    return;
  }
  trackRecentFile({ name: item.name, path: item.path, root: scopeRoot() ?? "" });
  void openFileInTab(item.path);
}

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "json") {
    return html`<sp-icon-file-code size="s"></sp-icon-file-code>`;
  }
  if (ext && formatByExtension(ext)) {
    return html`<sp-icon-file-txt size="s"></sp-icon-file-txt>`;
  }
  return html`<sp-icon-document size="s"></sp-icon-document>`;
}

function dirPart(path: string) {
  const parts = path.split("/");
  parts.pop();
  return parts.length > 0 ? parts.join("/") : "";
}

/** Collapse a home-prefixed absolute path for compact display. */
function shortenPath(path: string) {
  if (path.startsWith("/home/")) {
    return `~/${path.split("/").slice(3).join("/")}`;
  }
  return path;
}

function renderOverlay() {
  const container = getContainer();
  if (!_open) {
    litRender(nothing, container);
    return;
  }

  const hasProject = projectState != null;
  const { items, showingRecent } = currentItems();
  const hasQuery = _query.trim().length > 0;

  const placeholder = hasProject ? "Search project files…" : "Open a recent project…";
  const sectionLabel = hasProject ? "Recently opened" : "Recent projects";
  const emptyHint = hasProject
    ? "Type to search project files"
    : "No recent projects — open one to get started";

  const tpl = html`
    <div class="quick-search-overlay" @click=${closeQuickSearch}>
      <div class="quick-search-panel" @click=${(e: Event) => e.stopPropagation()}>
        <input
          class="quick-search-input"
          type="text"
          placeholder=${placeholder}
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
            items.length === 0 && hasQuery
              ? html`<div class="quick-search-empty">No results</div>`
              : nothing
          }
          ${
            items.length === 0 && !hasQuery
              ? html`<div class="quick-search-empty">${emptyHint}</div>`
              : nothing
          }
          ${
            showingRecent && items.length > 0
              ? html`<div class="quick-search-section-label">${sectionLabel}</div>`
              : nothing
          }
          ${items.map((item, i) => {
            const icon =
              item.kind === "project"
                ? html`<sp-icon-folder-open size="s"></sp-icon-folder-open>`
                : fileIcon(item.name);
            const pathText = item.kind === "project" ? shortenPath(item.root) : dirPart(item.path);
            return html`
              <div
                class=${classMap({
                  "quick-search-item": true,
                  selected: i === _selectedIndex,
                })}
                @click=${() => selectItem(item)}
                @mouseenter=${() => {
                  _selectedIndex = i;
                  renderOverlay();
                }}
              >
                <span class="quick-search-icon">${icon}</span>
                <span class="quick-search-name">${item.name}</span>
                <span class="quick-search-path">${pathText}</span>
                ${showingRecent ? html`<span class="quick-search-badge">recent</span>` : nothing}
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;

  litRender(tpl, container);
}
