/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * File tree management — project loading, file tree rendering, and file CRUD.
 *
 * Functions that mutate state accept a context object with callbacks, following the same pattern as
 * file-ops.js. Every name the user supplies (new file, rename) is collected with the Spectrum
 * prompt dialog from ui/layers.ts — never a native browser prompt (studio-ui-guidelines.md §8.7).
 *
 * @docs studio/interface
 */

import { html, nothing } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { classMap } from "lit-html/directives/class-map.js";
import { ref } from "lit-html/directives/ref.js";
import { renderPopover, showConfirmDialog, showPromptDialog } from "../ui/layers";
import { createState, projectState, requireProjectState, setProjectState } from "../store";
import { getPlatform } from "../platform";
import { statusMessage } from "../panels/statusbar";
import { loadComponentRegistry } from "./components";
import { ensureDependenciesInstalled } from "../packages/ensure-deps";
import { maybePromptJxsuiteUpdate } from "../packages/jxsuite-update";
import { autoSyncProjectOnOpen } from "../packages/pull-package-sync";
import { markLocalMutation } from "./fs-events";
import { isCollabPath } from "../collab/collab-state";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  activateTab,
  openTab,
  renameTab,
  replaceAllTabs,
  setWorkspaceProject,
  workspace,
} from "../workspace/workspace";
import { openCollectionGrid, openCsvGridTab, openPagesGrid } from "../grid/grid-open";
import { collectionDirs } from "../grid/sources/content-source";
import { parseSourceForPath, serializeDocument } from "./file-ops";
import {
  documentExtensions,
  formatForPath,
  loadFormats,
  noFormatError,
  refreshExtensionUi,
  refreshFormats,
} from "../format/format-host";
import { view } from "../view";
import { addRecentProject, trackRecentFile } from "../recent-projects";
import type { TemplateResult } from "lit-html";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { StudioState } from "../state.js";
import type { Tab } from "../tabs/tab.js";
import type { DirEntry, RenameResult } from "../types";
import { rectOf } from "../utils/geometry";

// ─── File icon map ────────────────────────────────────────────────────────────

const fileIconMap = {
  "sp-icon-document": html`<sp-icon-document></sp-icon-document>`,
  "sp-icon-file-code": html`<sp-icon-file-code></sp-icon-file-code>`,
  "sp-icon-file-txt": html`<sp-icon-file-txt></sp-icon-file-txt>`,
  "sp-icon-folder": html`<sp-icon-folder></sp-icon-folder>`,
  "sp-icon-folder-open": html`<sp-icon-folder-open></sp-icon-folder-open>`,
  "sp-icon-image": html`<sp-icon-image></sp-icon-image>`,
} as Record<string, TemplateResult>;

// ─── File management ──────────────────────────────────────────────────────────

export async function loadDirectory(dirPath: string) {
  if (!projectState) {
    return;
  }
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
    if (!result) {
      return;
    }
    const { meta, info } = result;

    refreshFormats();
    void loadFormats();
    refreshExtensionUi(platform);

    setProjectState({
      dirs: new Map(),
      expanded: new Set(),
      isSiteProject: info.isSiteProject,
      name: info.isSiteProject ? info.projectConfig?.name || meta.name : meta.name,
      projectConfig: (info.isSiteProject ? info.projectConfig : null) || null,
      projectDirs: info.directories || [],
      projectRoot: ".",
      root: meta.root,
      searchQuery: "",
      selectedPath: null,
    });
    // Only a site project counts as an open project for the workspace (a bare monorepo root keeps
    // The assistant in bootstrap mode).
    if (info.isSiteProject) {
      setWorkspaceProject(meta.root || ".", info.projectConfig || null);
    }

    if (info.isSiteProject) {
      addRecentProject(requireProjectState().name, meta.root);
      await autoSyncProjectOnOpen();
      await ensureDependenciesInstalled();
      await loadDirectory(".");
      await loadComponentRegistry();
      await openHomePage();
      void maybePromptJxsuiteUpdate(meta.root);
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
 *   renderActivityBar: () => void;
 *   renderLeftPanel: () => void;
 * }} ctx
 */
export async function openProject({
  renderActivityBar,
  renderLeftPanel,
}: {
  renderActivityBar: () => void;
  renderLeftPanel: () => void;
}) {
  try {
    const platform = getPlatform();
    const result = await platform.openProject();
    if (!result) {
      return;
    } // User cancelled

    const { config, handle } = result;

    replaceAllTabs({
      document: { children: [], tagName: "div" },
      id: "initial",
    });

    refreshFormats();
    void loadFormats();
    refreshExtensionUi(platform);

    setProjectState({
      .../** @type {ProjectState} */ projectState,
      dirs: new Map(),
      expanded: new Set(),
      isSiteProject: true,
      name: config.name || handle.name,
      projectConfig: config,
      projectRoot: handle.root,
      searchQuery: "",
      selectedPath: null,
    });
    setWorkspaceProject(handle.root, config);

    await autoSyncProjectOnOpen();
    await ensureDependenciesInstalled();
    await loadDirectory(".");
    await loadComponentRegistry();

    // Auto-expand key directories and populate projectDirs for Browse view
    const conventionalDirs = new Set([
      "pages",
      "layouts",
      "components",
      "content",
      "data",
      "public",
      "styles",
    ]);
    const entries = requireProjectState().dirs.get(".") || [];
    const foundDirs = [];
    for (const e of entries) {
      if (e.type === "directory" && conventionalDirs.has(e.name)) {
        foundDirs.push(e.name);
        requireProjectState().expanded.add(e.path || e.name);
        await loadDirectory(e.path || e.name);
      }
    }
    requireProjectState().projectDirs = foundDirs;

    view.leftTab = "files";
    addRecentProject(requireProjectState().name, requireProjectState().projectRoot);
    renderActivityBar();
    renderLeftPanel();
    statusMessage(`Opened project: ${requireProjectState().name}`);

    await openHomePage();
    void maybePromptJxsuiteUpdate(requireProjectState().projectRoot);
  } catch (error) {
    statusMessage(`Error: ${errorMessage(error)}`);
  }
}

/**
 * The project's home page path (`pages/index.<page-ext>` or `pages/index.json`), or null if none.
 * Lists `pages/` once and matches by name — a directory read returns 200 with `[]` for a missing
 * dir, so this never provokes the console 404s a blind per-candidate read would.
 */
export async function findHomePage(): Promise<string | null> {
  await loadFormats();
  const exts = [...documentExtensions("page"), ".json"];
  let entries: DirEntry[];
  try {
    entries = await getPlatform().listDirectory("pages");
  } catch {
    return null;
  }
  const files = new Set(entries.filter((e) => e.type === "file").map((e) => e.name));
  for (const ext of exts) {
    if (files.has(`index${ext}`)) {
      return `pages/index${ext}`;
    }
  }
  return null;
}

export async function openHomePage() {
  const home = await findHomePage();
  if (home) {
    await openFileInTab(home);
  }
}

// ─── File tree templates ──────────────────────────────────────────────────────

function fileTypeIconTpl(name: string, type: string) {
  let tag;
  if (type === "directory") {
    tag = projectState?.expanded?.has(name) ? "sp-icon-folder-open" : "sp-icon-folder";
  } else {
    const ext = name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "json": {
        tag = "sp-icon-file-code";
        break;
      }
      case "md": {
        tag = "sp-icon-file-txt";
        break;
      }
      case "js":
      case "ts": {
        tag = "sp-icon-file-code";
        break;
      }
      case "css": {
        tag = "sp-icon-file-code";
        break;
      }
      case "png":
      case "jpg":
      case "jpeg":
      case "svg":
      case "webp":
      case "gif": {
        tag = "sp-icon-image";
        break;
      }
      default: {
        tag = "sp-icon-document";
        break;
      }
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
}: {
  openProject: () => void;
  openFileFromTree: (path: string) => void;
  renderLeftPanel: () => void;
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
            requireProjectState().dirs.clear();
            await loadDirectory(".");
            for (const dir of requireProjectState().expanded) {
              await loadDirectory(dir);
            }
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
        value=${requireProjectState().searchQuery}
        @input=${(e: Event) => {
          requireProjectState().searchQuery = (e.target as HTMLInputElement).value;
          renderLeftPanel();
        }}
        @submit=${(e: Event) => e.preventDefault()}
      ></sp-search>
    </div>
    <div class="file-tree" role="tree" aria-label="Project files">
      ${renderTreeLevelTemplate(".", 0, { openFileFn, renderLeftPanel })}
    </div>
  `;
}

/** @returns {import("lit-html").TemplateResult | import("lit-html").TemplateResult[]} */
function renderTreeLevelTemplate(
  dirPath: string,
  depth: number,
  ctx: { openFileFn: (path: string) => void; renderLeftPanel: () => void },
): TemplateResult | TemplateResult[] {
  const entries = requireProjectState().dirs.get(dirPath);
  if (!entries) {
    void loadDirectory(dirPath).then(() => ctx.renderLeftPanel());
    return html`<div
      class="file-tree-item"
      style="padding-left:${8 + depth * 16}px;color:var(--fg-dim);font-style:italic"
    >
      Loading…
    </div>`;
  }

  const sorted = [...entries].toSorted((a, b) => {
    if (a.type === "directory" && b.type !== "directory") {
      return -1;
    }
    if (a.type !== "directory" && b.type === "directory") {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });

  const query = requireProjectState().searchQuery.toLowerCase();
  const filtered = query
    ? sorted.filter((e) => e.type === "directory" || e.name.toLowerCase().includes(query))
    : sorted;

  return filtered.map((entry) => {
    const isDir = entry.type === "directory";
    const isExpanded = requireProjectState().expanded.has(entry.path);
    const isSelected = requireProjectState().selectedPath === entry.path;

    return html`
      <div
        class=${classMap({ "file-tree-item": true, selected: isSelected })}
        style="padding-left:${8 + depth * 16}px"
        role="treeitem"
        aria-level=${depth + 1}
        tabindex="-1"
        data-path=${entry.path}
        data-type=${entry.type}
        aria-expanded=${isDir ? String(isExpanded) : nothing}
        @click=${async (e: MouseEvent) => {
          e.stopPropagation();
          if (isDir) {
            if (isExpanded) {
              requireProjectState().expanded.delete(entry.path);
            } else {
              requireProjectState().expanded.add(entry.path);
              if (!requireProjectState().dirs.has(entry.path)) {
                await loadDirectory(entry.path);
              }
            }
            ctx.renderLeftPanel();
          } else {
            ctx.openFileFn(entry.path);
          }
        }}
        @contextmenu=${(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          showFileContextMenu(e, entry, ctx);
        }}
      >
        ${isDir
          ? html`<span class="file-tree-toggle">${isExpanded ? "\u25BC" : "\u25B6"}</span>`
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

export function setupTreeKeyboard(tree: HTMLElement) {
  tree.addEventListener("keydown", (e: KeyboardEvent) => {
    const items = [...tree.querySelectorAll(".file-tree-item")] as HTMLElement[];
    const focused = tree.querySelector(".file-tree-item:focus") as HTMLElement | null;
    if (!focused || items.length === 0) {
      return;
    }

    const idx = items.indexOf(focused);
    let handled = true;

    switch (e.key) {
      case "ArrowDown": {
        if (idx < items.length - 1) {
          items[idx + 1]!.focus();
        }
        break;
      }
      case "ArrowUp": {
        if (idx > 0) {
          items[idx - 1]!.focus();
        }
        break;
      }
      case "ArrowRight": {
        if (focused.dataset.type === "directory") {
          const path = focused.dataset.path as string;
          if (!requireProjectState().expanded.has(path)) {
            requireProjectState().expanded.add(path);
            void loadDirectory(path).then(() => {
              const panel = tree.closest(".panel-body");
              if (panel) {
                (panel.querySelector(".file-tree-item:focus") as HTMLElement | null)?.click();
              }
            });
          }
        }
        break;
      }
      case "ArrowLeft": {
        if (focused.dataset.type === "directory") {
          const path = focused.dataset.path as string;
          if (requireProjectState().expanded.has(path)) {
            requireProjectState().expanded.delete(path);
            // RenderLeftPanel will be called by the caller who sets up keyboard
          }
        }
        break;
      }
      case "Enter": {
        focused.click();
        break;
      }
      default: {
        handled = false;
      }
    }
    if (handled) {
      e.preventDefault();
    }
  });

  // Set first item focusable
  const first = tree.querySelector(".file-tree-item");
  if (first) {
    first.setAttribute("tabindex", "0");
  }
}

let _fileTreeDndCleanups: (() => void)[] = [];

/**
 * Register drag-and-drop on file tree items. Called after each file tree render.
 *
 * @param {{ renderLeftPanel: () => void }} ctx
 */
export function registerFileTreeDnD({ renderLeftPanel }: { renderLeftPanel: () => void }) {
  // Clean up previous registrations
  for (const fn of _fileTreeDndCleanups) {
    fn();
  }
  _fileTreeDndCleanups = [];

  requestAnimationFrame(() => {
    const tree = document.querySelector(".file-tree") as HTMLElement | null;
    if (!tree) {
      return;
    }

    const items = tree.querySelectorAll(".file-tree-item") as NodeListOf<HTMLElement>;

    for (const row of items) {
      const { path } = row.dataset;
      const { type } = row.dataset;
      if (!path) {
        continue;
      }

      const cleanups = [
        draggable({
          element: row,
          getInitialData() {
            return { entryType: type, path, type: "file-tree" };
          },
          onDragStart() {
            row.classList.add("dragging");
          },
          onDrop() {
            row.classList.remove("dragging");
          },
        }),
      ];

      if (type === "directory") {
        cleanups.push(
          dropTargetForElements({
            canDrop({ source }) {
              if (source.data.type !== "file-tree") {
                return false;
              }
              const srcPath = source.data.path as string;
              if (srcPath === path) {
                return false;
              }
              if (srcPath.startsWith(`${path}/`)) {
                return false;
              }
              const srcParent = parentDir(srcPath);
              if (srcParent === path) {
                return false;
              }
              return true;
            },
            element: row,
            getData() {
              return { targetDir: path, type: "file-tree-target" };
            },
            onDrag() {
              if (!row.classList.contains("drag-over")) {
                row.classList.add("drag-over");
              }
            },
            onDragEnter() {
              row.classList.add("drag-over");
            },
            onDragLeave() {
              row.classList.remove("drag-over");
            },
            onDrop() {
              row.classList.remove("drag-over");
            },
          }),
        );
      }

      _fileTreeDndCleanups.push(combine(...cleanups));
    }

    // Root-level drop target (move to project root)
    const rootCleanup = dropTargetForElements({
      canDrop({ source }) {
        if (source.data.type !== "file-tree") {
          return false;
        }
        const srcPath = source.data.path as string;
        return parentDir(srcPath) !== ".";
      },
      element: tree,
      getData() {
        return { targetDir: ".", type: "file-tree-target" };
      },
      onDragEnter() {
        tree.classList.add("drag-over-root");
      },
      onDragLeave() {
        tree.classList.remove("drag-over-root");
      },
      onDrop() {
        tree.classList.remove("drag-over-root");
      },
    });
    _fileTreeDndCleanups.push(rootCleanup);

    // Monitor for drop events
    const monitorCleanup = monitorForElements({
      onDrop({ source, location }) {
        const [target] = location.current.dropTargets;
        if (!target) {
          return;
        }
        if (source.data.type !== "file-tree") {
          return;
        }
        if (target.data.type !== "file-tree-target") {
          return;
        }

        const srcPath = source.data.path as string;
        const targetDirPath = target.data.targetDir as string;
        const fileName = srcPath.split("/").pop();
        const newPath = targetDirPath === "." ? fileName : `${targetDirPath}/${fileName}`;

        if (newPath === srcPath) {
          return;
        }

        void moveFileEntry(srcPath, newPath!, renderLeftPanel);
      },
    });
    _fileTreeDndCleanups.push(monitorCleanup);
  });
}

/**
 * Move a file/directory and update all affected state.
 *
 * @param {string} oldPath
 * @param {string} newPath
 * @param {() => void} renderLeftPanel
 */
async function moveFileEntry(oldPath: string, newPath: string, renderLeftPanel: () => void) {
  const platform = getPlatform();
  markLocalMutation(oldPath, newPath);
  try {
    const report = await platform.renameFile(oldPath, newPath);

    // Update open tabs referencing the moved path
    for (const [id] of workspace.tabs.entries()) {
      if (id === oldPath) {
        renameTab(oldPath, newPath, newPath);
      } else if (id.startsWith(`${oldPath}/`)) {
        const newTabPath = newPath + id.slice(oldPath.length);
        renameTab(id, newTabPath, newTabPath);
      }
    }

    // Refresh affected directories
    const oldParent = parentDir(oldPath);
    const newParent = parentDir(newPath);
    await loadDirectory(oldParent);
    if (newParent !== oldParent) {
      await loadDirectory(newParent);
    }

    // Auto-expand target directory
    if (newParent !== ".") {
      requireProjectState().expanded.add(newParent);
    }

    reloadRewrittenTabs(report, newPath);
    renderLeftPanel();
    statusMessage(`Moved to ${newPath}`);
  } catch (error) {
    statusMessage(`Error: ${errorMessage(error)}`);
  }
}

/** @param {string} path @returns {string} */
function parentDir(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "." : normalized.slice(0, lastSlash);
}

// ─── Context menu ─────────────────────────────────────────────────────────────

let _fileCtxHandle: ReturnType<typeof renderPopover> | null = null;

function dismissFileContextMenu() {
  if (_fileCtxHandle) {
    _fileCtxHandle.dismiss();
    _fileCtxHandle = null;
  }
}

function showFileContextMenu(
  e: MouseEvent,
  entry: { name: string; path: string; type: string },
  ctx: { openFileFn: (path: string) => void; renderLeftPanel: () => void },
) {
  e.preventDefault();
  dismissFileContextMenu();
  const isDir = entry.type === "directory";

  /** @type {{ label: string; action?: () => void; danger?: boolean }[]} */
  const items = [];

  if (!isDir) {
    items.push({ action: () => ctx.openFileFn(entry.path), label: "Open" });
  }
  if (isDir) {
    items.push({
      action: () => createNewFile(entry.path, ctx.renderLeftPanel),
      label: "New File\u2026",
    });
    // Directories backing a content collection get a bulk-edit affordance.
    const collection = collectionDirs().find(
      ({ dir }) => entry.path === dir || entry.path.endsWith(`/${dir}`),
    );
    if (collection) {
      items.push({
        action: () => {
          openCollectionGrid(collection.name);
        },
        label: "Edit Collection in Grid",
      });
    }
    if (entry.path === "pages" || entry.path.endsWith("/pages")) {
      items.push({
        action: () => {
          openPagesGrid();
        },
        label: "Edit Pages in Grid",
      });
    }
  }
  items.push(
    { label: "\u2014" },
    {
      action: () => renameFile(entry, ctx.renderLeftPanel),
      label: "Rename\u2026",
    },
    {
      action: () => deleteFile(entry, ctx.renderLeftPanel),
      danger: true,
      label: "Delete",
    },
  );

  let x = e.clientX,
    y = e.clientY;

  _fileCtxHandle = renderPopover(
    html`<sp-popover
      open
      style="position:fixed;z-index:10000;left:${x}px;top:${y}px"
      ${ref((el) => {
        if (!el) {
          return;
        }
        requestAnimationFrame(() => {
          const popover = el as HTMLElement;
          const menuRect = rectOf(popover);
          if (x + menuRect.width > window.innerWidth) {
            x = window.innerWidth - menuRect.width - 4;
          }
          if (y + menuRect.height > window.innerHeight) {
            y = window.innerHeight - menuRect.height - 4;
          }
          popover.style.left = `${x}px`;
          popover.style.top = `${y}px`;
        });
      })}
    >
      <sp-menu>
        ${items.map((item) =>
          item.label === "\u2014"
            ? html`<sp-menu-divider></sp-menu-divider>`
            : html`<sp-menu-item
                style=${item.danger ? "color: var(--danger)" : ""}
                @click=${() => {
                  dismissFileContextMenu();
                  void item.action?.();
                }}
                >${item.label}</sp-menu-item
              >`,
        )}
      </sp-menu>
    </sp-popover>`,
    {
      dismissOnOutsideClick: true,
      onDismiss: () => {
        _fileCtxHandle = null;
      },
    },
  );
}

// ─── File CRUD ────────────────────────────────────────────────────────────────

async function createNewFile(dirPath: string, renderLeftPanel: () => void) {
  const name = await showPromptDialog("New File", {
    confirmLabel: "Create",
    message: dirPath === "." ? "Creating in the project root." : `Creating in ${dirPath}/`,
    placeholder: "untitled.json",
    select: "stem",
    validate: (v) => (v.trim() ? "" : "Enter a file name."),
    value: "untitled.json",
  });
  if (!name) {
    return;
  }
  const path = dirPath === "." ? name : `${dirPath}/${name}`;
  markLocalMutation(path);
  await loadFormats();
  const format = formatForPath(name);
  const content =
    format?.studio?.newFileTemplate ??
    (format
      ? ""
      : JSON.stringify({ children: [{ children: [], tagName: "p" }], tagName: "div" }, null, 2));
  try {
    const platform = getPlatform();
    await platform.writeFile(path, content);
    await loadDirectory(dirPath);
    renderLeftPanel();
    statusMessage(`Created ${path}`);
  } catch (error) {
    statusMessage(`Error: ${errorMessage(error)}`);
  }
}

/** @param {string} currentName @returns {Promise<string | null>} */
function showRenameFileDialog(currentName: string): Promise<string | null> {
  return showPromptDialog("Rename", {
    confirmLabel: "Rename",
    select: "stem",
    validate: (v) => (v.trim() ? "" : "Enter a file name."),
    value: currentName,
  });
}

/** Build the status-bar message for a rename, summarising any reference/tag rewrites. */
function renameStatus(newName: string, report: RenameResult): string {
  const refs = report.references;
  const tagNote = report.tag ? `; tag → <${report.tag.to}> (${report.tag.refsUpdated})` : "";
  if (refs && refs.refsUpdated > 0) {
    return `Renamed to ${newName}; updated ${refs.refsUpdated} reference(s) in ${refs.filesChanged} file(s)${tagNote}`;
  }
  if (tagNote) {
    return `Renamed to ${newName}${tagNote}`;
  }
  return `Renamed to ${newName}`;
}

/** Reload any open tabs whose references the refactor rewrote (so the editor shows new paths). */
function reloadRewrittenTabs(report: RenameResult, skipPath: string): void {
  for (const f of report.references?.files ?? []) {
    if (f.path !== skipPath && workspace.tabs.has(f.path)) {
      void reloadFileInTab(f.path);
    }
  }
}

async function renameFile(
  entry: { name: string; path: string; type: string },
  renderLeftPanel: () => void,
) {
  const newName = await showRenameFileDialog(entry.name);
  if (!newName || newName === entry.name) {
    return;
  }
  const entryPath = entry.path.replaceAll("\\", "/");
  const parentDirPath = entryPath.includes("/")
    ? entryPath.slice(0, entryPath.lastIndexOf("/"))
    : ".";
  const newPath = parentDirPath === "." ? newName : `${parentDirPath}/${newName}`;
  markLocalMutation(entry.path, newPath);
  try {
    const platform = getPlatform();
    const report = await platform.renameFile(entry.path, newPath);
    await loadDirectory(parentDirPath);
    if (requireProjectState().selectedPath === entry.path) {
      requireProjectState().selectedPath = newPath;
    }
    if (workspace.tabs.has(entry.path)) {
      renameTab(entry.path, newPath, newPath);
    }
    reloadRewrittenTabs(report, newPath);
    renderLeftPanel();
    statusMessage(renameStatus(newName, report));
  } catch (error) {
    statusMessage(`Error: ${errorMessage(error)}`);
  }
}

async function deleteFile(
  entry: { name: string; path: string; type: string },
  renderLeftPanel: () => void,
) {
  const confirmed = await showConfirmDialog("Delete File", `Delete "${entry.name}"?`, {
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!confirmed) {
    return;
  }
  try {
    const platform = getPlatform();
    markLocalMutation(entry.path);
    await platform.deleteFile(entry.path);
    const delPath = entry.path.replaceAll("\\", "/");
    const parentDirPath = delPath.includes("/") ? delPath.slice(0, delPath.lastIndexOf("/")) : ".";
    await loadDirectory(parentDirPath);
    if (requireProjectState().selectedPath === entry.path) {
      requireProjectState().selectedPath = null;
    }
    renderLeftPanel();
    statusMessage(`Deleted ${entry.name}`);
  } catch (error) {
    statusMessage(`Error: ${errorMessage(error)}`);
  }
}

// ─── Open file from tree ──────────────────────────────────────────────────────

/**
 * Open a file from the file tree — auto-saves current dirty doc, then loads the new one.
 *
 * @param {{
 *   S: import("../state.js").StudioState;
 *   commit: (s: import("../state.js").StudioState) => void;
 *   render: () => void;
 *   loadMarkdown: (source: string, handle: unknown) => void;
 * }} ctx
 * @param {string} path
 */
export async function openFileFromTree(
  ctx: {
    S: StudioState;
    commit: (s: StudioState) => void;
    render: () => void;
    loadMarkdown: (source: string, handle: unknown) => void;
  },
  path: string,
) {
  const platform = getPlatform();
  await loadFormats();
  // Auto-save current dirty document
  if (ctx.S.dirty && ctx.S.documentPath) {
    try {
      const tabLike = {
        doc: {
          content: ctx.S.content,
          document: ctx.S.document,
          mode: ctx.S.mode,
          sourceFormat: formatForPath(ctx.S.documentPath)?.name ?? null,
        },
      } as unknown as Tab;
      const output = await serializeDocument(tabLike);
      await platform.writeFile(ctx.S.documentPath, output);
    } catch (error) {
      statusMessage(`Save error: ${errorMessage(error)}`);
    }
  }

  // Fetch the file
  try {
    const content = await platform.readFile(path);
    if (!content) {
      return;
    }

    if (formatForPath(path)) {
      ctx.loadMarkdown(content, null);
      ctx.S.documentPath = path;
      ctx.S.dirty = false;
      ctx.commit(ctx.S);
    } else if (path.endsWith(".json")) {
      const doc = JSON.parse(content) as JxMutableNode;
      const newS = createState(doc);
      newS.documentPath = path;
      newS.dirty = false;
      ctx.commit(newS);
    } else {
      throw noFormatError(path);
    }

    // Update tree selection
    requireProjectState().selectedPath = path;

    ctx.render();
    statusMessage(`Opened ${path}`);
  } catch (error) {
    statusMessage(`Error: ${errorMessage(error)}`);
  }
}

/**
 * Open a file from the tree into a tab. Activates existing tab if already open.
 *
 * @param {string} path
 */
export async function openFileInTab(path: string) {
  for (const [id, tab] of workspace.tabs.entries()) {
    if (tab.documentPath === path) {
      activateTab(id);
      requireProjectState().selectedPath = path;
      return;
    }
  }

  // CSV files open in the grid editor (source mode remains as the raw-text alternate).
  if (path.toLowerCase().endsWith(".csv")) {
    try {
      await openCsvGridTab(path);
      requireProjectState().selectedPath = path;
      trackRecentFile({
        name: path.split("/").pop() || path,
        path,
        root: requireProjectState().projectRoot,
      });
      statusMessage(`Opened ${path.split("/").pop()}`);
    } catch (error) {
      statusMessage(`Error: ${errorMessage(error)}`);
    }
    return;
  }

  const platform = getPlatform();
  try {
    const content = await platform.readFile(path);
    if (!content) {
      return;
    }

    await loadFormats();
    let document: Record<string, unknown>;
    let frontmatter: Record<string, unknown> | undefined;
    const format = formatForPath(path);
    if (format) {
      const result = await parseSourceForPath(path, content);
      ({ document } = result);
      ({ frontmatter } = result);
    } else if (path.endsWith(".json")) {
      document = JSON.parse(content) as Record<string, unknown>;
    } else {
      throw noFormatError(path);
    }

    const id = path;
    openTab({
      id,
      documentPath: path,
      document,
      ...(frontmatter != null && { frontmatter }),
      sourceFormat: format?.name ?? null,
    });
    requireProjectState().selectedPath = path;
    trackRecentFile({
      name: path.split("/").pop() || path,
      path,
      root: requireProjectState().projectRoot,
    });

    statusMessage(`Opened ${path.split("/").pop()}`);
  } catch (error) {
    statusMessage(`Error: ${errorMessage(error)}`);
  }
}

/**
 * Reload an already-open tab from disk without changing the active tab. Used to refresh after AI
 * assistant writes to a file.
 *
 * @param {string} path
 */
/** Reload an open tab from disk when an external change arrives — but only if it is not dirty. */
export function reloadCleanTab(path: string): void {
  // Co-edited docs never reload from disk: the shared Y.Doc is ahead of the provider's write-back
  // (Which is what produced this event), and genuine external changes arrive as a collab reset.
  if (isCollabPath(path)) {
    return;
  }
  for (const [, tab] of workspace.tabs.entries()) {
    if (tab.documentPath === path && !tab.doc.dirty) {
      void reloadFileInTab(path);
      return;
    }
  }
}

export async function reloadFileInTab(path: string) {
  for (const [, tab] of workspace.tabs.entries()) {
    if (tab.documentPath === path) {
      const platform = getPlatform();
      try {
        const content = await platform.readFile(path);
        if (!content) {
          return;
        }
        await loadFormats();
        if (formatForPath(path)) {
          const { document, frontmatter } = await parseSourceForPath(path, content);
          tab.doc.document = document;
          tab.doc.content.frontmatter = frontmatter;
        } else if (path.endsWith(".json")) {
          tab.doc.document = JSON.parse(content) as JxMutableNode;
        }
        tab.doc.dirty = false;
      } catch {}
      return;
    }
  }
}
