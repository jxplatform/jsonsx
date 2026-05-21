/**
 * File tree management — project loading, file tree rendering, and file CRUD.
 *
 * Functions that mutate state accept a context object with callbacks, following the same pattern as
 * file-ops.js.
 */

import { html, render as litRender, nothing } from "lit-html";
import { unified } from "unified";
import remarkStringify from "remark-stringify";
import remarkDirective from "remark-directive";
import { stringify as stringifyYaml } from "yaml";
import { jxToMd } from "../markdown/md-convert.js";
import { createState, projectState, setProjectState } from "../store.js";
import { getPlatform } from "../platform.js";
import { statusMessage } from "../panels/statusbar.js";
import { loadComponentRegistry } from "./components.js";
import { workspace, openTab, activateTab } from "../workspace/workspace.js";
import { loadMarkdown } from "./file-ops.js";

// ─── File icon map ────────────────────────────────────────────────────────────

const fileIconMap = /** @type {Record<string, import("lit-html").TemplateResult>} */ ({
  "sp-icon-folder-open": html`<sp-icon-folder-open></sp-icon-folder-open>`,
  "sp-icon-folder": html`<sp-icon-folder></sp-icon-folder>`,
  "sp-icon-file-code": html`<sp-icon-file-code></sp-icon-file-code>`,
  "sp-icon-file-txt": html`<sp-icon-file-txt></sp-icon-file-txt>`,
  "sp-icon-image": html`<sp-icon-image></sp-icon-image>`,
  "sp-icon-document": html`<sp-icon-document></sp-icon-document>`,
});

// ─── File management ──────────────────────────────────────────────────────────

async function loadDirectory(/** @type {string} */ dirPath) {
  if (!projectState) return;
  try {
    const platform = getPlatform();
    const entries = await platform.listDirectory(dirPath);
    projectState.dirs.set(dirPath, entries);
  } catch {
    projectState.dirs.set(dirPath, []);
  }
}

/** Probe the dev server for a root project and populate projectState. */
export async function loadProject() {
  try {
    const platform = getPlatform();
    const result = await platform.probeRootProject();
    if (!result) return;
    const { meta, info } = result;

    setProjectState({
      root: meta.root,
      name: info.isSiteProject ? info.projectConfig?.name || meta.name : meta.name,
      projectRoot: ".",
      isSiteProject: info.isSiteProject,
      projectConfig: info.isSiteProject ? info.projectConfig : null,
      projectDirs: info.directories || [],
      dirs: new Map(),
      expanded: new Set(),
      selectedPath: null,
      searchQuery: "",
    });

    if (info.isSiteProject) {
      await loadDirectory(".");
      await loadComponentRegistry();
    }
    // If not a site project (monorepo) — show welcome prompt, don't load tree
  } catch {
    // Not on dev server — project features disabled
  }
}

// ─── Open Project (PAL-based) ─────────────────────────────────────────────

/**
 * Open a project via the platform adapter.
 *
 * @param {{
 *   S: any;
 *   commit: (s: any) => void;
 *   renderActivityBar: () => void;
 *   renderLeftPanel: () => void;
 * }} ctx
 */
export async function openProject({ S, commit, renderActivityBar, renderLeftPanel }) {
  try {
    const platform = getPlatform();
    const result = await platform.openProject();
    if (!result) return; // User cancelled

    const { config, handle } = result;

    setProjectState({
      ...projectState,
      projectRoot: handle.root,
      isSiteProject: true,
      projectConfig: config,
      name: config.name || handle.name,
      dirs: new Map(),
      expanded: new Set(),
      selectedPath: null,
      searchQuery: "",
    });

    await loadDirectory(".");
    await loadComponentRegistry();

    // Auto-expand key directories and populate projectDirs for Browse view
    const conventionalDirs = [
      "pages",
      "layouts",
      "components",
      "content",
      "data",
      "public",
      "styles",
    ];
    const entries = projectState.dirs.get(".") || [];
    const foundDirs = [];
    for (const e of entries) {
      if (e.type === "directory" && conventionalDirs.includes(e.name)) {
        foundDirs.push(e.name);
        projectState.expanded.add(e.path || e.name);
        await loadDirectory(e.path || e.name);
      }
    }
    projectState.projectDirs = foundDirs;

    commit({ ...S, ui: { ...S.ui, leftTab: "files" } });
    renderActivityBar();
    renderLeftPanel();
    statusMessage(`Opened project: ${projectState.name}`);
  } catch (/** @type {any} */ e) {
    statusMessage(`Error: ${e.message}`);
  }
}

// ─── File tree templates ──────────────────────────────────────────────────────

function fileTypeIconTpl(/** @type {string} */ name, /** @type {string} */ type) {
  let tag;
  if (type === "directory") {
    tag = projectState?.expanded?.has(name) ? "sp-icon-folder-open" : "sp-icon-folder";
  } else {
    const ext = name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "json":
        tag = "sp-icon-file-code";
        break;
      case "md":
        tag = "sp-icon-file-txt";
        break;
      case "js":
      case "ts":
        tag = "sp-icon-file-code";
        break;
      case "css":
        tag = "sp-icon-file-code";
        break;
      case "png":
      case "jpg":
      case "jpeg":
      case "svg":
      case "webp":
      case "gif":
        tag = "sp-icon-image";
        break;
      default:
        tag = "sp-icon-document";
        break;
    }
  }
  return fileIconMap[tag] || fileIconMap["sp-icon-document"];
}

/**
 * Render the file tree template for the left panel.
 *
 * @param {{
 *   openProject: () => void;
 *   openFileFromTree: (path: string) => void;
 *   renderLeftPanel: () => void;
 * }} ctx
 */
export function renderFilesTemplate({
  openProject: openProjectFn,
  openFileFromTree: openFileFn,
  renderLeftPanel,
}) {
  if (!projectState) {
    return html`<div class="file-tree-empty">No project loaded</div>`;
  }

  // No project selected in a monorepo — show welcome prompt
  if (!projectState.isSiteProject && projectState.projectRoot === ".") {
    return html`<div class="file-tree-empty">
      <p style="margin:0 0 12px">Open a project folder to get started.</p>
      <sp-button variant="accent" size="s" @click=${openProjectFn}>Open Project</sp-button>
    </div>`;
  }

  return html`
    ${projectState.isSiteProject
      ? html`
          <div class="project-header">
            <span class="project-name"
              >${projectState.projectConfig?.name || projectState.name}</span
            >
          </div>
        `
      : nothing}
    <div class="files-toolbar">
      <sp-action-group size="xs" compact quiet>
        <sp-action-button
          size="xs"
          label="New File"
          @click=${() => createNewFile(".", renderLeftPanel)}
        >
          <sp-icon-add slot="icon"></sp-icon-add>
        </sp-action-button>
        <sp-action-button
          size="xs"
          label="Refresh"
          @click=${async () => {
            projectState.dirs.clear();
            await loadDirectory(".");
            for (const dir of projectState.expanded) await loadDirectory(dir);
            renderLeftPanel();
          }}
        >
          <sp-icon-refresh slot="icon"></sp-icon-refresh>
        </sp-action-button>
      </sp-action-group>
      <sp-search
        size="s"
        quiet
        placeholder="Filter files…"
        value=${projectState.searchQuery}
        @input=${(/** @type {Event} */ e) => {
          projectState.searchQuery = /** @type {HTMLInputElement} */ (e.target).value;
          renderLeftPanel();
        }}
        @submit=${(/** @type {Event} */ e) => e.preventDefault()}
      ></sp-search>
    </div>
    <div class="file-tree" role="tree" aria-label="Project files">
      ${renderTreeLevelTemplate(".", 0, { openFileFn, renderLeftPanel })}
    </div>
  `;
}

/** @returns {import("lit-html").TemplateResult | import("lit-html").TemplateResult[]} */
function renderTreeLevelTemplate(
  /** @type {string} */ dirPath,
  /** @type {number} */ depth,
  /** @type {{ openFileFn: (path: string) => void; renderLeftPanel: () => void }} */ ctx,
) {
  const entries = projectState.dirs.get(dirPath);
  if (!entries) {
    loadDirectory(dirPath).then(() => ctx.renderLeftPanel());
    return html`<div
      class="file-tree-item"
      style="padding-left:${8 + depth * 16}px;color:var(--fg-dim);font-style:italic"
    >
      Loading…
    </div>`;
  }

  const sorted = [...entries].sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });

  const query = projectState.searchQuery.toLowerCase();
  const filtered = query
    ? sorted.filter((e) => e.type === "directory" || e.name.toLowerCase().includes(query))
    : sorted;

  return filtered.map((entry) => {
    const isDir = entry.type === "directory";
    const isExpanded = projectState.expanded.has(entry.path);
    const isSelected = projectState.selectedPath === entry.path;

    return html`
      <div
        class="file-tree-item${isSelected ? " selected" : ""}"
        style="padding-left:${8 + depth * 16}px"
        role="treeitem"
        aria-level=${depth + 1}
        tabindex="-1"
        data-path=${entry.path}
        data-type=${entry.type}
        aria-expanded=${isDir ? String(isExpanded) : nothing}
        @click=${async (/** @type {MouseEvent} */ e) => {
          e.stopPropagation();
          if (isDir) {
            if (isExpanded) projectState.expanded.delete(entry.path);
            else {
              projectState.expanded.add(entry.path);
              if (!projectState.dirs.has(entry.path)) await loadDirectory(entry.path);
            }
            ctx.renderLeftPanel();
          } else {
            ctx.openFileFn(entry.path);
          }
        }}
        @contextmenu=${(/** @type {MouseEvent} */ e) => {
          e.preventDefault();
          e.stopPropagation();
          showFileContextMenu(e, entry, ctx);
        }}
      >
        ${isDir
          ? html`<span class="file-tree-toggle">${isExpanded ? "\u25bc" : "\u25b6"}</span>`
          : html`<span class="file-tree-toggle empty"> </span>`}
        <span class="file-tree-icon">${fileTypeIconTpl(entry.path, entry.type)}</span>
        <span class="file-tree-name">${entry.name}</span>
      </div>
      ${isDir && isExpanded
        ? html`<div role="group">${renderTreeLevelTemplate(entry.path, depth + 1, ctx)}</div>`
        : nothing}
    `;
  });
}

export function setupTreeKeyboard(/** @type {HTMLElement} */ tree) {
  tree.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    const items = /** @type {HTMLElement[]} */ ([...tree.querySelectorAll(".file-tree-item")]);
    const focused = /** @type {HTMLElement | null} */ (tree.querySelector(".file-tree-item:focus"));
    if (!focused || items.length === 0) return;

    const idx = items.indexOf(focused);
    let handled = true;

    switch (e.key) {
      case "ArrowDown":
        if (idx < items.length - 1) items[idx + 1].focus();
        break;
      case "ArrowUp":
        if (idx > 0) items[idx - 1].focus();
        break;
      case "ArrowRight":
        if (focused.dataset.type === "directory") {
          const path = /** @type {string} */ (focused.dataset.path);
          if (!projectState.expanded.has(path)) {
            projectState.expanded.add(path);
            loadDirectory(path).then(() => {
              const panel = tree.closest(".panel-body");
              if (panel)
                /** @type {HTMLElement | null} */ (
                  panel.querySelector(".file-tree-item:focus")
                )?.click();
            });
          }
        }
        break;
      case "ArrowLeft":
        if (focused.dataset.type === "directory") {
          const path = focused.dataset.path;
          if (projectState.expanded.has(path)) {
            projectState.expanded.delete(path);
            // renderLeftPanel will be called by the caller who sets up keyboard
          }
        }
        break;
      case "Enter":
        focused.click();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  });

  // Set first item focusable
  const first = tree.querySelector(".file-tree-item");
  if (first) first.setAttribute("tabindex", "0");
}

// ─── Context menu ─────────────────────────────────────────────────────────────

/** @type {HTMLElement | null} */
let fileContextPopover = null;

function showFileContextMenu(
  /** @type {MouseEvent} */ e,
  /** @type {{ name: string; path: string; type: string }} */ entry,
  /** @type {{ openFileFn: (path: string) => void; renderLeftPanel: () => void }} */ ctx,
) {
  if (fileContextPopover) {
    fileContextPopover.remove();
    fileContextPopover = null;
  }

  const isDir = entry.type === "directory";
  fileContextPopover = document.createElement("div");

  const tpl = html`
    <sp-popover
      placement="right-start"
      open
      style="position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:9999"
    >
      <sp-menu style="min-width:160px">
        ${!isDir
          ? html`<sp-menu-item
              @click=${() => {
                closeFileContextMenu();
                ctx.openFileFn(entry.path);
              }}
              >Open</sp-menu-item
            >`
          : nothing}
        ${isDir
          ? html`<sp-menu-item
              @click=${() => {
                closeFileContextMenu();
                createNewFile(entry.path, ctx.renderLeftPanel);
              }}
              >New File…</sp-menu-item
            >`
          : nothing}
        <sp-menu-divider></sp-menu-divider>
        <sp-menu-item
          @click=${() => {
            closeFileContextMenu();
            renameFile(entry, ctx.renderLeftPanel);
          }}
          >Rename…</sp-menu-item
        >
        <sp-menu-item
          style="color:var(--danger)"
          @click=${() => {
            closeFileContextMenu();
            deleteFile(entry, ctx.renderLeftPanel);
          }}
          >Delete</sp-menu-item
        >
      </sp-menu>
    </sp-popover>
  `;

  litRender(tpl, fileContextPopover);
  document.body.appendChild(fileContextPopover);

  const closeHandler = (/** @type {MouseEvent} */ ev) => {
    if (!fileContextPopover?.contains(/** @type {Node} */ (ev.target))) {
      closeFileContextMenu();
      document.removeEventListener("mousedown", closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closeHandler, true), 0);
}

function closeFileContextMenu() {
  if (fileContextPopover) {
    fileContextPopover.remove();
    fileContextPopover = null;
  }
}

// ─── File CRUD ────────────────────────────────────────────────────────────────

async function createNewFile(dirPath = ".", /** @type {() => void} */ renderLeftPanel) {
  const name = prompt("File name:", "untitled.json");
  if (!name) return;
  const path = dirPath === "." ? name : `${dirPath}/${name}`;
  const content = name.endsWith(".md")
    ? "---\ntitle: Untitled\n---\n\n"
    : JSON.stringify({ tagName: "div", children: [] }, null, 2);
  try {
    const platform = getPlatform();
    await platform.writeFile(path, content);
    await loadDirectory(dirPath);
    renderLeftPanel();
    statusMessage(`Created ${path}`);
  } catch (/** @type {any} */ e) {
    statusMessage(`Error: ${e.message}`);
  }
}

async function renameFile(
  /** @type {{ name: string; path: string; type: string }} */ entry,
  /** @type {() => void} */ renderLeftPanel,
) {
  const newName = prompt("New name:", entry.name);
  if (!newName || newName === entry.name) return;
  const entryPath = entry.path.replaceAll("\\", "/");
  const parentDir = entryPath.includes("/")
    ? entryPath.substring(0, entryPath.lastIndexOf("/"))
    : ".";
  const newPath = parentDir === "." ? newName : `${parentDir}/${newName}`;
  try {
    const platform = getPlatform();
    await platform.renameFile(entry.path, newPath);
    await loadDirectory(parentDir);
    if (projectState.selectedPath === entry.path) {
      projectState.selectedPath = newPath;
    }
    renderLeftPanel();
    statusMessage(`Renamed to ${newName}`);
  } catch (/** @type {any} */ e) {
    statusMessage(`Error: ${e.message}`);
  }
}

async function deleteFile(
  /** @type {{ name: string; path: string; type: string }} */ entry,
  /** @type {() => void} */ renderLeftPanel,
) {
  if (!confirm(`Delete "${entry.name}"?`)) return;
  try {
    const platform = getPlatform();
    await platform.deleteFile(entry.path);
    const delPath = entry.path.replaceAll("\\", "/");
    const parentDir = delPath.includes("/") ? delPath.substring(0, delPath.lastIndexOf("/")) : ".";
    await loadDirectory(parentDir);
    if (projectState.selectedPath === entry.path) {
      projectState.selectedPath = null;
    }
    renderLeftPanel();
    statusMessage(`Deleted ${entry.name}`);
  } catch (/** @type {any} */ e) {
    statusMessage(`Error: ${e.message}`);
  }
}

// ─── Open file from tree ──────────────────────────────────────────────────────

/**
 * Open a file from the file tree — auto-saves current dirty doc, then loads the new one.
 *
 * @param {{
 *   S: any;
 *   commit: (s: any) => void;
 *   render: () => void;
 *   loadMarkdown: (source: string, handle: any) => void;
 * }} ctx
 * @param {string} path
 */
export async function openFileFromTree(ctx, path) {
  const platform = getPlatform();
  // Auto-save current dirty document
  if (ctx.S.dirty && ctx.S.documentPath) {
    try {
      const isContent = ctx.S.mode === "content";
      let output;
      if (isContent) {
        const mdast = jxToMd(ctx.S.document);
        const md = unified()
          .use(remarkDirective)
          .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*" })
          .stringify(mdast);
        const fm = ctx.S.content?.frontmatter;
        const hasFrontmatter = fm && Object.keys(fm).length > 0;
        output = hasFrontmatter ? `---\n${stringifyYaml(fm).trim()}\n---\n\n${md}` : md;
      } else {
        output = JSON.stringify(ctx.S.document, null, 2);
      }
      await platform.writeFile(ctx.S.documentPath, output);
    } catch (/** @type {any} */ e) {
      statusMessage(`Save error: ${e.message}`);
    }
  }

  // Fetch the file
  try {
    const content = await platform.readFile(path);
    if (!content) return;

    if (path.endsWith(".md")) {
      await ctx.loadMarkdown(content, null);
      ctx.S.documentPath = path;
      ctx.S.dirty = false;
      ctx.commit(ctx.S);
    } else {
      const doc = JSON.parse(content);
      const newS = createState(doc);
      newS.documentPath = path;
      newS.dirty = false;
      ctx.commit(newS);
    }

    // Update tree selection
    projectState.selectedPath = path;

    ctx.render();
    statusMessage(`Opened ${path}`);
  } catch (/** @type {any} */ e) {
    statusMessage(`Error: ${e.message}`);
  }
}

/**
 * Open a file from the tree into a tab. Activates existing tab if already open.
 *
 * @param {string} path
 */
export async function openFileInTab(path) {
  for (const [id, tab] of workspace.tabs.entries()) {
    if (tab.documentPath === path) {
      activateTab(id);
      projectState.selectedPath = path;
      return;
    }
  }

  const platform = getPlatform();
  try {
    const content = await platform.readFile(path);
    if (!content) return;

    let document, frontmatter;
    if (path.endsWith(".md")) {
      const state = await loadMarkdown(content, null);
      document = state.document;
      frontmatter = state.content?.frontmatter;
    } else {
      document = JSON.parse(content);
    }

    const id = path;
    openTab({ id, documentPath: path, document, frontmatter });
    projectState.selectedPath = path;
    statusMessage(`Opened ${path.split("/").pop()}`);
  } catch (/** @type {any} */ e) {
    statusMessage(`Error: ${e.message}`);
  }
}
