/**
 * File tree management — project loading, file tree rendering, and file CRUD.
 *
 * Functions that mutate state accept a context object with callbacks, following the same pattern as
 * file-ops.js.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { ref } from "lit-html/directives/ref.js";
import { unified } from "unified";
import remarkStringify from "remark-stringify";
import { renderPopover, showDialog, showConfirmDialog } from "../ui/layers";
import remarkDirective from "remark-directive";
import { stringify as stringifyYaml } from "yaml";
import { jxToMd } from "../markdown/md-convert";
import { createState, projectState, setProjectState, requireProjectState } from "../store";
import { getPlatform } from "../platform";
import { statusMessage } from "../panels/statusbar";
import { loadComponentRegistry } from "./components";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  workspace,
  openTab,
  activateTab,
  renameTab,
  replaceAllTabs,
  activeTab,
} from "../workspace/workspace";
import { loadMarkdown } from "./file-ops";
import { view } from "../view";
import { addRecentProject, trackRecentFile } from "../recent-projects";

// ─── File icon map ────────────────────────────────────────────────────────────

const fileIconMap = {
  "sp-icon-folder-open": html`<sp-icon-folder-open></sp-icon-folder-open>`,
  "sp-icon-folder": html`<sp-icon-folder></sp-icon-folder>`,
  "sp-icon-file-code": html`<sp-icon-file-code></sp-icon-file-code>`,
  "sp-icon-file-txt": html`<sp-icon-file-txt></sp-icon-file-txt>`,
  "sp-icon-image": html`<sp-icon-image></sp-icon-image>`,
  "sp-icon-document": html`<sp-icon-document></sp-icon-document>`,
} as Record<string, import("lit-html").TemplateResult>;

// ─── File management ──────────────────────────────────────────────────────────

export async function loadDirectory(dirPath: string) {
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
      projectConfig: (info.isSiteProject ? info.projectConfig : null) || null,
      projectDirs: info.directories || [],
      dirs: new Map(),
      expanded: new Set(),
      selectedPath: null,
      searchQuery: "",
    });

    if (info.isSiteProject) {
      await loadDirectory(".");
      await loadComponentRegistry();
      await openHomePage();
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
    if (!result) return; // User cancelled

    const { config, handle } = result;

    replaceAllTabs({ id: "initial", document: { tagName: "div", children: [] } });

    setProjectState({
      .../** @type {ProjectState} */ (projectState),
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
    const entries = requireProjectState().dirs.get(".") || [];
    const foundDirs = [];
    for (const e of entries) {
      if (e.type === "directory" && conventionalDirs.includes(e.name)) {
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
  } catch (e) {
    statusMessage(`Error: ${(e as Error).message}`);
  }
}

export async function openHomePage() {
  const platform = getPlatform();
  const candidates = ["pages/index.md", "pages/index.json"];
  for (const path of candidates) {
    try {
      await platform.readFile(path);
      await openFileInTab(path);
      return;
    } catch {}
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
            for (const dir of requireProjectState().expanded) await loadDirectory(dir);
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
): import("lit-html").TemplateResult | import("lit-html").TemplateResult[] {
  const entries = requireProjectState().dirs.get(dirPath);
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
            if (isExpanded) requireProjectState().expanded.delete(entry.path);
            else {
              requireProjectState().expanded.add(entry.path);
              if (!requireProjectState().dirs.has(entry.path)) await loadDirectory(entry.path);
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

export function setupTreeKeyboard(tree: HTMLElement) {
  tree.addEventListener("keydown", (e: KeyboardEvent) => {
    const items = [...tree.querySelectorAll(".file-tree-item")] as HTMLElement[];
    const focused = tree.querySelector(".file-tree-item:focus") as HTMLElement | null;
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
          const path = focused.dataset.path as string;
          if (!requireProjectState().expanded.has(path)) {
            requireProjectState().expanded.add(path);
            loadDirectory(path).then(() => {
              const panel = tree.closest(".panel-body");
              if (panel)
                (panel.querySelector(".file-tree-item:focus") as HTMLElement | null)?.click();
            });
          }
        }
        break;
      case "ArrowLeft":
        if (focused.dataset.type === "directory") {
          const path = focused.dataset.path as string;
          if (requireProjectState().expanded.has(path)) {
            requireProjectState().expanded.delete(path);
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

let _fileTreeDndCleanups: (() => void)[] = [];

/**
 * Register drag-and-drop on file tree items. Called after each file tree render.
 *
 * @param {{ renderLeftPanel: () => void }} ctx
 */
export function registerFileTreeDnD({ renderLeftPanel }: { renderLeftPanel: () => void }) {
  // Clean up previous registrations
  for (const fn of _fileTreeDndCleanups) fn();
  _fileTreeDndCleanups = [];

  requestAnimationFrame(() => {
    const tree = document.querySelector(".file-tree") as HTMLElement | null;
    if (!tree) return;

    const items = tree.querySelectorAll(".file-tree-item") as NodeListOf<HTMLElement>;

    items.forEach((row) => {
      const path = row.dataset.path;
      const type = row.dataset.type;
      if (!path) return;

      const cleanups = [
        draggable({
          element: row,
          getInitialData() {
            return { type: "file-tree", path, entryType: type };
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
            element: row,
            canDrop({ source }) {
              if (source.data.type !== "file-tree") return false;
              const srcPath = source.data.path as string;
              if (srcPath === path) return false;
              if (srcPath.startsWith(path + "/")) return false;
              const srcParent = parentDir(srcPath);
              if (srcParent === path) return false;
              return true;
            },
            onDragEnter() {
              row.classList.add("drag-over");
            },
            onDrag() {
              if (!row.classList.contains("drag-over")) row.classList.add("drag-over");
            },
            onDragLeave() {
              row.classList.remove("drag-over");
            },
            onDrop() {
              row.classList.remove("drag-over");
            },
            getData() {
              return { type: "file-tree-target", targetDir: path };
            },
          }),
        );
      }

      _fileTreeDndCleanups.push(combine(...cleanups));
    });

    // Root-level drop target (move to project root)
    const rootCleanup = dropTargetForElements({
      element: tree,
      canDrop({ source }) {
        if (source.data.type !== "file-tree") return false;
        const srcPath = source.data.path as string;
        return parentDir(srcPath) !== ".";
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
      getData() {
        return { type: "file-tree-target", targetDir: "." };
      },
    });
    _fileTreeDndCleanups.push(rootCleanup);

    // Monitor for drop events
    const monitorCleanup = monitorForElements({
      onDrop({ source, location }) {
        const target = location.current.dropTargets[0];
        if (!target) return;
        if (source.data.type !== "file-tree") return;
        if (target.data.type !== "file-tree-target") return;

        const srcPath = source.data.path as string;
        const targetDirPath = target.data.targetDir as string;
        const fileName = srcPath.split("/").pop();
        const newPath = targetDirPath === "." ? fileName : `${targetDirPath}/${fileName}`;

        if (newPath === srcPath) return;

        moveFileEntry(srcPath, newPath!, renderLeftPanel);
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
  try {
    await platform.renameFile(oldPath, newPath);

    // Update open tabs referencing the moved path
    for (const [id] of workspace.tabs.entries()) {
      if (id === oldPath) {
        renameTab(oldPath, newPath, newPath);
      } else if (id.startsWith(oldPath + "/")) {
        const newTabPath = newPath + id.slice(oldPath.length);
        renameTab(id, newTabPath, newTabPath);
      }
    }

    // Refresh affected directories
    const oldParent = parentDir(oldPath);
    const newParent = parentDir(newPath);
    await loadDirectory(oldParent);
    if (newParent !== oldParent) await loadDirectory(newParent);

    // Auto-expand target directory
    if (newParent !== ".") requireProjectState().expanded.add(newParent);

    renderLeftPanel();
    statusMessage(`Moved to ${newPath}`);
  } catch (e) {
    statusMessage(`Error: ${(e as Error).message}`);
  }
}

/** @param {string} path @returns {string} */
function parentDir(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "." : normalized.substring(0, lastSlash);
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
    items.push({ label: "Open", action: () => ctx.openFileFn(entry.path) });
  }
  if (isDir) {
    items.push({
      label: "New File\u2026",
      action: () => createNewFile(entry.path, ctx.renderLeftPanel),
    });
  }
  items.push({ label: "\u2014" });
  items.push({ label: "Rename\u2026", action: () => renameFile(entry, ctx.renderLeftPanel) });
  items.push({
    label: "Delete",
    action: () => deleteFile(entry, ctx.renderLeftPanel),
    danger: true,
  });

  let x = e.clientX,
    y = e.clientY;

  _fileCtxHandle = renderPopover(
    html`<sp-popover
      open
      style="position:fixed;z-index:10000;left:${x}px;top:${y}px"
      ${ref((el) => {
        if (!el) return;
        requestAnimationFrame(() => {
          const popover = el as HTMLElement;
          const menuRect = popover.getBoundingClientRect();
          if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 4;
          if (y + menuRect.height > window.innerHeight)
            y = window.innerHeight - menuRect.height - 4;
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
                  item.action?.();
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

async function createNewFile(dirPath = ".", renderLeftPanel: () => void) {
  const name = prompt("File name:", "untitled.json");
  if (!name) return;
  const path = dirPath === "." ? name : `${dirPath}/${name}`;
  const content = name.endsWith(".md")
    ? "---\ntitle: Untitled\n---\n\n"
    : JSON.stringify({ tagName: "div", children: [{ tagName: "p", children: [] }] }, null, 2);
  try {
    const platform = getPlatform();
    await platform.writeFile(path, content);
    await loadDirectory(dirPath);
    renderLeftPanel();
    statusMessage(`Created ${path}`);
  } catch (e) {
    statusMessage(`Error: ${(e as Error).message}`);
  }
}

/** @param {string} currentName @returns {Promise<string | null>} */
function showRenameFileDialog(currentName: string): Promise<string | null> {
  let value = currentName;
  return showDialog<string | null>((done) => {
    function confirm() {
      const trimmed = value.trim();
      if (!trimmed) return;
      done(trimmed);
    }
    const tpl = html`
      <sp-dialog-wrapper
        open
        underlay
        headline="Rename"
        confirm-label="Rename"
        cancel-label="Cancel"
        size="s"
        @confirm=${confirm}
        @cancel=${() => done(null)}
        @close=${() => done(null)}
      >
        <sp-textfield
          style="width:100%"
          value=${currentName}
          @input=${(e: Event) => {
            value = (e.target as HTMLInputElement).value || "";
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") confirm();
          }}
        ></sp-textfield>
      </sp-dialog-wrapper>
    `;
    requestAnimationFrame(() => {
      const layer = document.getElementById("layer-dialog");
      const tf = layer?.querySelector("sp-textfield") as HTMLElement | null;
      if (tf) {
        tf.focus();
        const input = tf.shadowRoot?.querySelector("input");
        if (input) input.select();
      }
    });
    return tpl;
  });
}

async function renameFile(
  entry: { name: string; path: string; type: string },
  renderLeftPanel: () => void,
) {
  const newName = await showRenameFileDialog(entry.name);
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
    if (requireProjectState().selectedPath === entry.path) {
      requireProjectState().selectedPath = newPath;
    }
    if (workspace.tabs.has(entry.path)) {
      renameTab(entry.path, newPath, newPath);
    }
    renderLeftPanel();
    statusMessage(`Renamed to ${newName}`);
  } catch (e) {
    statusMessage(`Error: ${(e as Error).message}`);
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
  if (!confirmed) return;
  try {
    const platform = getPlatform();
    await platform.deleteFile(entry.path);
    const delPath = entry.path.replaceAll("\\", "/");
    const parentDir = delPath.includes("/") ? delPath.substring(0, delPath.lastIndexOf("/")) : ".";
    await loadDirectory(parentDir);
    if (requireProjectState().selectedPath === entry.path) {
      requireProjectState().selectedPath = null;
    }
    renderLeftPanel();
    statusMessage(`Deleted ${entry.name}`);
  } catch (e) {
    statusMessage(`Error: ${(e as Error).message}`);
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
    S: import("../state.js").StudioState;
    commit: (s: import("../state.js").StudioState) => void;
    render: () => void;
    loadMarkdown: (source: string, handle: unknown) => void;
  },
  path: string,
) {
  const platform = getPlatform();
  // Auto-save current dirty document
  if (ctx.S.dirty && ctx.S.documentPath) {
    try {
      const isContent = ctx.S.mode === "content";
      let output;
      if (isContent) {
        const mdast = jxToMd(ctx.S.document as JxElement);
        const md = unified()
          .use(remarkDirective)
          .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*" })
          .stringify(mdast as unknown as import("mdast").Root);
        const fm = ctx.S.content?.frontmatter;
        const hasFrontmatter = fm && Object.keys(fm).length > 0;
        output = hasFrontmatter ? `---\n${stringifyYaml(fm).trim()}\n---\n\n${md}` : md;
      } else {
        output = JSON.stringify(ctx.S.document, null, 2);
      }
      await platform.writeFile(ctx.S.documentPath, output);
    } catch (e) {
      statusMessage(`Save error: ${(e as Error).message}`);
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
    requireProjectState().selectedPath = path;

    ctx.render();
    statusMessage(`Opened ${path}`);
  } catch (e) {
    statusMessage(`Error: ${(e as Error).message}`);
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

  const platform = getPlatform();
  try {
    const content = await platform.readFile(path);
    if (!content) return;

    let document, frontmatter;
    if (path.endsWith(".md")) {
      const result = await loadMarkdown(content);
      document = result.document;
      frontmatter = result.frontmatter;
    } else {
      document = JSON.parse(content);
    }

    const id = path;
    openTab({
      id,
      documentPath: path,
      document,
      frontmatter,
      sourceFormat: path.endsWith(".md") ? "md" : null,
    });
    requireProjectState().selectedPath = path;
    trackRecentFile({ path, name: path.split("/").pop() || path });

    if (path === "project.json") {
      const tab = activeTab.value;
      if (tab) tab.session.ui.canvasMode = "stylebook";
    }

    statusMessage(`Opened ${path.split("/").pop()}`);
  } catch (e) {
    statusMessage(`Error: ${(e as Error).message}`);
  }
}

/**
 * Reload an already-open tab from disk without changing the active tab. Used to refresh after AI
 * assistant writes to a file.
 *
 * @param {string} path
 */
export async function reloadFileInTab(path: string) {
  for (const [, tab] of workspace.tabs.entries()) {
    if (tab.documentPath === path) {
      const platform = getPlatform();
      try {
        const content = await platform.readFile(path);
        if (!content) return;
        if (path.endsWith(".md")) {
          const { document, frontmatter } = await loadMarkdown(content);
          tab.doc.document = document;
          tab.doc.content.frontmatter = frontmatter;
        } else {
          tab.doc.document = JSON.parse(content);
        }
        tab.doc.dirty = false;
      } catch {}
      return;
    }
  }
}
