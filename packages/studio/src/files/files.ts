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
import { renderPopover, showPromptDialog } from "../ui/layers";
import { createState, projectState, requireProjectState, setProjectState } from "../store";
import { getPlatform } from "../platform";
import { notify } from "../services/notify";
import { loadComponentRegistry } from "./components";
import { ensureDependenciesInstalled } from "../packages/ensure-deps";
import { maybePromptJxsuiteUpdate } from "../packages/jxsuite-update";
import { autoSyncProjectOnOpen } from "../packages/pull-package-sync";
import { markLocalMutation } from "./fs-events";
import { registerPanel } from "../panels/panel-registry";
import { UPLOAD_ACCEPT, isImage, uploadAssets } from "./media-upload";
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
import { openCsvGridTab, openPagesGrid } from "../grid/grid-open";
import { collectionDirs } from "../grid/sources/content-source";
import { activeRegistry } from "../commands/active-registry";
import { collectionOfPath } from "../content/entry-model";
import {
  confirmFileDelete,
  parseSourceForPath,
  renamePromptMessage,
  serializeDocument,
} from "./file-ops";
import { invalidateUsages } from "../services/references";
import {
  documentExtensions,
  formatForPath,
  loadFormats,
  noFormatError,
  refreshExtensionUi,
  refreshFormats,
} from "../format/format-host";
import { resetProjectShell, setActivityTab } from "../shell";
import { cleanupGitPanel } from "../panels/git-panel";
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
 * @param {{ renderLeftPanel: () => void }} ctx
 */
export async function openProject({ renderLeftPanel }: { renderLeftPanel: () => void }) {
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

    // Source control, the stylebook selection and the settings tab describe the project being
    // Left behind. The poll timer goes with them; the panel re-arms it on its next render.
    cleanupGitPanel();
    resetProjectShell();
    setActivityTab("files");
    addRecentProject(requireProjectState().name, requireProjectState().projectRoot);
    renderLeftPanel();
    // The project's name is permanent state in the status bar's PROJECT field now.

    await openHomePage();
    void maybePromptJxsuiteUpdate(requireProjectState().projectRoot);
  } catch (error) {
    notify.error("Could not open the project.", {
      detail: errorMessage(error),
      source: "Open Project",
    });
  }
}

/**
 * Give a freshly created project a git repository, so its first irreversible action is recoverable.
 *
 * Runs on the create/import path only, immediately after the backend has written the project — the
 * scaffold is not a repository and nothing else in Studio says so, while Delete and Rename are one
 * confirm click away. `activate` binds the backend to the new root first, because `gitInit` takes
 * no argument and would otherwise run against whichever project the window was serving.
 *
 * Never re-initialises, and never runs on repository-backed platforms (`createDestination: "repo"`
 * — a cloud project _is_ a GitHub repository, and its `gitInit` is a no-op by design).
 *
 * @param {string} root Absolute root of the project just created.
 * @returns {Promise<boolean>} Whether a repository was initialised.
 */
export async function initProjectRepo(root: string): Promise<boolean> {
  const platform = getPlatform();
  if (platform.createDestination !== "path") {
    return false;
  }
  try {
    await platform.activate(root);
    const status = await platform.gitStatus();
    if (status.isRepo) {
      return false;
    }
    await platform.gitInit();
    notify.success("Initialized a git repository for this project.");
    return true;
  } catch (error) {
    // Version control is a safety net, not a precondition — a project that was written stays
    // Written. Say so rather than failing the create the user just completed.
    notify.warn("Could not initialize a git repository — the project itself was written.", {
      detail: errorMessage(error),
      source: "Source Control",
    });
    return false;
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
      default: {
        // Every image extension the media layer knows about, so an uploaded .avif/.ico gets the
        // Same icon as a .png instead of falling through to the generic document glyph.
        tag = ext && isImage(ext) ? "sp-icon-image" : "sp-icon-document";
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
    ${
      projectState.isSiteProject
        ? html`
            <div class="project-header">
              <span class="project-name"
                >${projectState.projectConfig?.name || projectState.name}</span
              >
            </div>
          `
        : nothing
    }
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
        ${
          isDir
            ? html`<span class="file-tree-toggle">${isExpanded ? "\u25BC" : "\u25B6"}</span>`
            : html`<span class="file-tree-toggle empty"> </span>`
        }
        <span class="file-tree-icon">${fileTypeIconTpl(entry.path, entry.type)}</span>
        <span class="file-tree-name">${entry.name}</span>
      </div>
      ${
        isDir && isExpanded
          ? html`<div role="group">${renderTreeLevelTemplate(entry.path, depth + 1, ctx)}</div>`
          : nothing
      }
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

/** Whether a drag carries OS files (as opposed to a pragmatic in-app drag). */
export function isFileDrag(e: DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}

/**
 * Attach external-file drop handling to one tree row. Pragmatic-dnd only sees pragmatic sources, so
 * an OS file drag needs the native listeners; `dir` is where a drop lands (the row itself for a
 * directory, its parent for a file, `.` for the tree background).
 */
function registerFileDropTarget(
  element: HTMLElement,
  dir: string,
  activeClass: string,
  renderLeftPanel: () => void,
): () => void {
  const onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    element.classList.add(activeClass);
  };
  const onDragLeave = () => element.classList.remove(activeClass);
  const onDrop = (e: DragEvent) => {
    element.classList.remove(activeClass);
    const files = e.dataTransfer?.files;
    if (!files?.length) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    void uploadFilesToDir(files, dir, renderLeftPanel);
  };
  element.addEventListener("dragover", onDragOver);
  element.addEventListener("dragleave", onDragLeave);
  element.addEventListener("drop", onDrop);
  return () => {
    element.removeEventListener("dragover", onDragOver);
    element.removeEventListener("dragleave", onDragLeave);
    element.removeEventListener("drop", onDrop);
  };
}

/**
 * Upload files into `dir` and reveal them: expand the target directory so the new entries are
 * visible. The listing refresh itself runs in the shared post-upload handler.
 */
export async function uploadFilesToDir(
  files: FileList | File[],
  dir: string,
  renderLeftPanel: () => void,
): Promise<void> {
  const uploaded = await uploadAssets([...files], { dir });
  if (uploaded.length === 0) {
    return;
  }
  if (dir !== ".") {
    requireProjectState().expanded.add(dir);
  }
  renderLeftPanel();
}

/**
 * Open the OS file picker and upload the choice into `dir` (the tree's "Upload Files…" item). The
 * input is created per invocation and discarded after — the tree template is re-rendered often.
 */
export function pickAndUploadTo(dir: string, renderLeftPanel: () => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = UPLOAD_ACCEPT;
  input.addEventListener("change", () => {
    if (input.files?.length) {
      void uploadFilesToDir(input.files, dir, renderLeftPanel);
    }
  });
  input.click();
}

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
        // Files dropped from the OS land in the row's own directory; a file row targets its parent
        // So dropping next to a sibling puts the upload beside it.
        registerFileDropTarget(
          row,
          type === "directory" ? path : parentDir(path),
          "drag-over",
          renderLeftPanel,
        ),
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
    // The tree background is the project root's drop target for OS files. Row handlers
    // StopPropagation, so a drop on a row never also fires here.
    _fileTreeDndCleanups.push(
      rootCleanup,
      registerFileDropTarget(tree, ".", "drag-over-root", renderLeftPanel),
    );

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
    notify.success(`Moved to ${newPath}`);
  } catch (error) {
    notify.error(`Could not move ${oldPath}.`, {
      detail: errorMessage(error),
      path: oldPath,
      source: "Files",
    });
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

/** One row of the file menu. The divider is the em-dash label; `disabled` rows explain themselves. */
interface FileMenuItem {
  label: string;
  action?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** The `requires` sentence, printed under a disabled row. */
  reason?: string;
}

/**
 * A file row addresses ONE thing, and this is everything it can say about it — keyed by the
 * ARGUMENT NAME that asks for it.
 *
 * `menus: ["context/file"]` names a placement, and a placement nothing renders is the same defect
 * as a command nothing registers, one layer down: `content.openEntry` declared this menu and the
 * tree drew a hand-built list beside it, so the row simply never existed. Rendering the placement
 * is the fix, and it needs the one thing the element menu does not — an argument.
 * `content.openEntry` wants a `path`, `collection.editInGrid` wants a `name`, and only the row
 * knows either.
 *
 * A fact is stated ONLY when it is true of this row, and that is what decides whether a command
 * appears at all: `styles/main.css` is an entry of no collection, so it states no `path`, so "Open
 * Entry Form" is not offered on it. A command whose required arguments this row cannot answer is
 * skipped — never rendered into a refusal the author cannot act on.
 */
function fileRowFacts(entry: { path: string; type: string }): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  if (entry.type === "directory") {
    const collection = collectionDirs().find(
      ({ dir }) => entry.path === dir || entry.path.endsWith(`/${dir}`),
    );
    if (collection) {
      facts.name = collection.name;
    }
  } else if (collectionOfPath(entry.path)) {
    facts.path = entry.path;
  }
  return facts;
}

/**
 * The declared `context/file` commands this row can offer.
 *
 * Everything a row prints comes off the record — its title, its position (`forPlacement` sorts by
 * `group`), whether it is enabled and the sentence saying why not. Nothing here names a command, so
 * a new `context/file` record appears in the tree with no edit to this file.
 */
function placedFileItems(entry: { path: string; type: string }): FileMenuItem[] {
  const registry = activeRegistry();
  if (!registry) {
    return [];
  }
  const facts = fileRowFacts(entry);
  const items: FileMenuItem[] = [];
  for (const command of registry.forPlacement("context/file")) {
    const schema = command.args as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;
    if (!(schema?.required ?? []).every((key) => key in facts)) {
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const key of Object.keys(schema?.properties ?? {})) {
      if (key in facts) {
        args[key] = facts[key];
      }
    }
    const reason = registry.disabledReason(command.id);
    items.push(
      reason === undefined
        ? { action: () => void registry.run(command.id, args), label: command.title }
        : { disabled: true, label: command.title, reason },
    );
  }
  return items;
}

function showFileContextMenu(
  e: MouseEvent,
  entry: { name: string; path: string; type: string },
  ctx: { openFileFn: (path: string) => void; renderLeftPanel: () => void },
) {
  e.preventDefault();
  dismissFileContextMenu();
  const isDir = entry.type === "directory";

  const items: FileMenuItem[] = [];

  if (!isDir) {
    items.push({ action: () => ctx.openFileFn(entry.path), label: "Open" });
  }
  if (isDir) {
    items.push(
      {
        action: () => createNewFile(entry.path, ctx.renderLeftPanel),
        label: "New File\u2026",
      },
      {
        action: () => pickAndUploadTo(entry.path, ctx.renderLeftPanel),
        label: "Upload Files\u2026",
      },
    );
    if (entry.path === "pages" || entry.path.endsWith("/pages")) {
      // The one hand-built row left: no command declares "open the pages grid". `grid-open.ts`'s
      // `collection.editInGrid` has no pages sibling, so there is nothing here to render yet.
      items.push({
        action: () => {
          openPagesGrid();
        },
        label: "Edit Pages in Grid",
      });
    }
  }
  items.push(
    // The declared rows sit between what the TREE does to a file (open it, create in it, upload to
    // It) and what it does to the file's existence (rename, delete).
    ...placedFileItems(entry),
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
                ?disabled=${item.disabled === true}
                aria-disabled=${item.disabled === true ? "true" : "false"}
                @click=${() => {
                  if (item.disabled === true) {
                    return;
                  }
                  dismissFileContextMenu();
                  void item.action?.();
                }}
                >${item.label}${
                  // A disabled row says what it needs, the same sentence the palette and the agent
                  // Print — `requires`, off the record, never re-worded here.
                  item.reason ? html`<span slot="description">Needs ${item.reason}</span>` : nothing
                }</sp-menu-item
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

/** The default body for a path no format claims — a document, since that is what Jx authors. */
const BLANK_DOCUMENT = JSON.stringify(
  { children: [{ children: [], tagName: "p" }], tagName: "div" },
  null,
  2,
);

/**
 * One creation, named.
 *
 * `dir` is required and has no default. That is the whole point of the type: the Library used to
 * derive its destination from whichever CATEGORY filter happened to be active — and "All" derived
 * nothing, so a new page landed wherever the writer's fallback pointed. A creation flow that cannot
 * say where the file is going has no business asking for its name.
 */
export interface NewFileRequest {
  /** Destination directory, project-relative. `"."` is the project root. */
  dir: string;
  /** Dialog title — "New File", "New Page", "New Post". Defaults to "New File". */
  title?: string;
  /** Pre-filled value; its stem is selected so typing replaces the name and keeps the extension. */
  suggestedName?: string;
  /**
   * When set, the field asks for a DISPLAY NAME and this extension is appended to its slug — "My
   * First Post" becomes `my-first-post.md`. When absent, the field asks for a file name and takes
   * it verbatim, which is what the Files tree has always done.
   */
  ext?: string;
  /** Body to write. Defaults to the resolved format's `newFileTemplate`. */
  content?: string;
  /** Who is creating, for the Problem's `source` line. Defaults to "Files". */
  source?: string;
}

/**
 * Create one file, from the one flow both the Files tree and the Library use.
 *
 * Two behaviours the callers used to disagree about, settled here:
 *
 * - **A name that is already taken is refused in the FIELD**, not discovered afterwards. Both
 *   predecessors called `writeFile` straight onto the composed path, so creating `about.md` in a
 *   directory that had one silently replaced it — with no undo, because the file was never open.
 *   The destination is listed once before the prompt so `validate` can say so while it can still be
 *   fixed.
 * - **A failure is a Problem carrying the path**, not a toast that scrolls away, since the thing the
 *   author must do next is about that path.
 *
 * @returns The created path, or `null` when the author cancelled or the write failed.
 */
export async function createFileIn(request: NewFileRequest): Promise<string | null> {
  const { dir, ext, source = "Files" } = request;
  await loadFormats();

  // One listing, before the field opens: the names it must refuse are known while typing.
  let taken = new Set<string>();
  try {
    const listing = await getPlatform().listDirectory(dir);
    taken = new Set(listing.map((entry) => entry.name));
  } catch {
    // A directory that cannot be listed is usually one that does not exist yet — the write below
    // Is the authority on whether that is a problem, and it reports with the real reason.
  }

  const fileNameFor = (input: string) =>
    ext === undefined
      ? input.trim()
      : `${input
          .trim()
          .toLowerCase()
          .replaceAll(/\s+/g, "-")
          .replaceAll(/[^a-z\d-]/g, "")}${ext}`;

  const entered = await showPromptDialog(request.title ?? "New File", {
    confirmLabel: "Create",
    message: dir === "." ? "Creating in the project root." : `Creating in ${dir}/`,
    ...(request.suggestedName === undefined ? {} : { placeholder: request.suggestedName }),
    select: "stem",
    validate: (value) => {
      if (!value.trim()) {
        return ext === undefined ? "Enter a file name." : "Enter a name.";
      }
      const candidate = fileNameFor(value);
      if (!candidate || candidate === ext) {
        return "Enter at least one letter or number.";
      }
      return taken.has(candidate) ? `${candidate} already exists in ${dir}/.` : "";
    },
    value: request.suggestedName ?? "untitled.json",
  });
  if (!entered) {
    return null;
  }

  const fileName = fileNameFor(entered);
  const path = dir === "." ? fileName : `${dir}/${fileName}`;
  markLocalMutation(path);
  const format = formatForPath(fileName);
  const content =
    request.content ?? format?.studio?.newFileTemplate ?? (format ? "" : BLANK_DOCUMENT);
  try {
    await getPlatform().writeFile(path, content);
    await loadDirectory(dir);
    notify.success(`Created ${path}`);
    return path;
  } catch (error) {
    notify.error(`Could not create ${path}.`, {
      detail: errorMessage(error),
      path,
      source,
    });
    return null;
  }
}

async function createNewFile(dirPath: string, renderLeftPanel: () => void) {
  const created = await createFileIn({ dir: dirPath, suggestedName: "untitled.json" });
  if (created !== null) {
    renderLeftPanel();
  }
}

/**
 * The rename dialog, carrying what moves with the file.
 *
 * `renamePromptMessage` is awaited before the field opens, so the count is on screen when the name
 * is typed rather than after it is confirmed — the refactor pass is about to rewrite every one of
 * those references, and silently doing that much work was the previous behaviour.
 *
 * @param {string} currentName @param {string} path @returns {Promise<string | null>}
 */
async function showRenameFileDialog(currentName: string, path: string): Promise<string | null> {
  const message = await renamePromptMessage(path);
  return showPromptDialog("Rename", {
    confirmLabel: "Rename",
    ...(message === undefined ? {} : { message }),
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
  const newName = await showRenameFileDialog(entry.name, entry.path);
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
    // The refactor pass just rewrote references project-wide, and `markLocalMutation` suppresses
    // The watcher echo that would otherwise say so — hence the explicit drop.
    invalidateUsages();
    await loadDirectory(parentDirPath);
    if (requireProjectState().selectedPath === entry.path) {
      requireProjectState().selectedPath = newPath;
    }
    if (workspace.tabs.has(entry.path)) {
      renameTab(entry.path, newPath, newPath);
    }
    reloadRewrittenTabs(report, newPath);
    renderLeftPanel();
    notify.success(renameStatus(newName, report));
  } catch (error) {
    notify.error(`Could not rename ${entry.name}.`, {
      detail: errorMessage(error),
      path: entry.path,
      source: "Files",
    });
  }
}

async function deleteFile(
  entry: { name: string; path: string; type: string },
  renderLeftPanel: () => void,
) {
  const confirmed = await confirmFileDelete(entry);
  if (!confirmed) {
    return;
  }
  try {
    const platform = getPlatform();
    markLocalMutation(entry.path);
    await platform.deleteFile(entry.path);
    invalidateUsages();
    const delPath = entry.path.replaceAll("\\", "/");
    const parentDirPath = delPath.includes("/") ? delPath.slice(0, delPath.lastIndexOf("/")) : ".";
    await loadDirectory(parentDirPath);
    if (requireProjectState().selectedPath === entry.path) {
      requireProjectState().selectedPath = null;
    }
    renderLeftPanel();
    notify.success(`Deleted ${entry.name}`);
  } catch (error) {
    notify.error(`Could not delete ${entry.name}.`, {
      detail: errorMessage(error),
      path: entry.path,
      source: "Files",
    });
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
      notify.error(`Could not save ${ctx.S.documentPath}.`, {
        action: "file.save",
        detail: errorMessage(error),
        key: `save:${ctx.S.documentPath}`,
        path: ctx.S.documentPath,
        source: "Save",
      });
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
  } catch (error) {
    notify.error(`Could not open ${path}.`, {
      detail: errorMessage(error),
      path,
      source: "Open File",
    });
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
    } catch (error) {
      notify.error(`Could not open ${path}.`, {
        detail: errorMessage(error),
        path,
        source: "Open File",
      });
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
  } catch (error) {
    notify.error(`Could not open ${path}.`, {
      detail: errorMessage(error),
      path,
      source: "Open File",
    });
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
      } catch (error) {
        // A file that changed on disk and cannot be re-read leaves the open tab showing the OLD
        // Document with no indication that it is stale — the most expensive silence in this file.
        notify.error(`Could not reload ${path} after it changed on disk.`, {
          detail: errorMessage(error),
          key: `reload:${path}`,
          path,
          source: "Files",
        });
      }
      return;
    }
  }
}

/**
 * Contribute the Files panel.
 *
 * `level: "project"` because it WRITES project files — create, rename, delete, move. It reads the
 * focused document only to highlight a row, and principle 3 files a surface by what it writes.
 */
export function registerFilesPanel(): void {
  registerPanel({
    id: "files",
    title: "Files",
    level: "project",
    dock: "navigator",
    icon: "sp-icon-folder",
    render: (ctx) => ctx.deps.renderFilesTemplate(),
    afterRender: (ctx, host) => {
      const tree = host.querySelector(".file-tree") as HTMLElement | null;
      if (tree) {
        ctx.deps.setupTreeKeyboard(tree);
      }
      ctx.deps.registerFileTreeDnD({ renderLeftPanel: ctx.rerender });
    },
  });
}
