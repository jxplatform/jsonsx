/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * File tree management — project loading, file tree rendering, and file CRUD.
 *
 * Functions that mutate state accept a context object with callbacks, following the same pattern as
 * file-ops.js. Every name the user supplies (new file, rename) is collected with the Spectrum
 * prompt dialog from ui/layers.ts — never a native browser prompt (studio-ui-guidelines.md §8.7).
 *
 * **The tree is a flat list of rows, and the DOM holds a window onto it** ({@link FileRow},
 * `ui/virtual-window.ts`). It used to recurse a template per directory level, which is why it drew
 * every expanded row of every expanded directory — a `node_modules` expanded by accident is tens of
 * thousands of `sp-icon` custom elements, built synchronously, on every repaint. A recursion has no
 * row list to window, so the recursion moved into {@link collectFileRows}, which produces the rows
 * in display order and nothing else; the render is then a window over that array.
 *
 * Flattening costs the `role="group"` wrappers, and pays for them with `aria-level` +
 * `aria-posinset` / `aria-setsize` on every row — the same shape the Outline has always had, and
 * the only shape that stays TRUE when the tree draws eleven rows out of ten thousand.
 *
 * @docs studio/interface
 */

import { html, nothing } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { localeLabel, localeOfPath, resolveI18n } from "@jxsuite/schema/locale";
import { classMap } from "lit-html/directives/class-map.js";
import { ref } from "lit-html/directives/ref.js";
import { renderPopover, showPromptDialog } from "../ui/layers";
import { projectState, requireProjectState, setProjectState } from "../store";
import { getPlatform } from "../platform";
import { disarmPreviewOverlay } from "../preview/preview-overlay";
import { notify } from "../services/notify";
import { loadComponentRegistry } from "./components";
import { ensureDependenciesInstalled } from "../packages/ensure-deps";
import { maybePromptJxsuiteUpdate } from "../packages/jxsuite-update";
import { autoSyncProjectOnOpen } from "../packages/pull-package-sync";
import { markLocalMutation } from "./fs-events";
import { ensureIgnoreLayers, isIgnoredEntry, resetIgnoreCache } from "./gitignore";
import { SETTINGS } from "../services/settings/definitions";
import { readStoredSetting, setSetting } from "../services/settings/kernel";
import { registerPanel } from "../panels/panel-registry";
import { isImage, uploadAccept, uploadAssets } from "./media-upload";
import { isCollabPath } from "../collab/collab-state";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  activateTab,
  moveTabToPane,
  openTab,
  paneOfTab,
  receivingPane,
  renameTab,
  replaceAllTabs,
  setWorkspaceProject,
  workspace,
} from "../workspace/workspace";
import { openCsvGridTab, openPagesGrid } from "../grid/grid-open";
import { collectionDirs } from "../grid/sources/content-source";
import { activeRegistry } from "../commands/active-registry";
import { collectionOfPath } from "../content/entry-model";
import { confirmFileDelete, parseSourceForPath, renamePromptMessage } from "./file-ops";
import { invalidateUsages } from "../services/references";
import {
  documentExtensions,
  formatForPath,
  loadFormats,
  noFormatError,
  refreshExtensionUi,
  refreshFormats,
} from "../format/format-host";
import { markSessionRestored, persistedSession, resetProjectShell, setActivityTab } from "../shell";
import { restoreSession } from "../workspace/session";
import { cleanupGitPanel } from "../panels/git-panel";
import { addRecentProject, trackRecentFile } from "../recent-projects";
import {
  listWindow,
  measuredRowHeight,
  revealListRow,
  watchListWindow,
} from "../ui/virtual-window";
import type { TemplateResult } from "lit-html";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { ResolvedI18n } from "@jxsuite/schema/locale";
import type { DirEntry, RenameResult } from "../types";
import type { ListWindowWatch } from "../ui/virtual-window";
import { rectOf } from "../utils/geometry";
import { repeat } from "lit-html/directives/repeat.js";

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
    /* The `.gitignore` chain is fetched WITH the listing, not after it: `collectFileRows` reads the
       ignore rules synchronously while it builds rows, and a repaint that beat the rules would draw
       a `node_modules` and then take it away again. Concurrent, because neither needs the other. */
    const [entries] = await Promise.all([
      platform.listDirectory(dirPath),
      ensureIgnoreLayers(dirPath),
    ]);
    projectState.dirs.set(dirPath, entries);
  } catch {
    projectState.dirs.set(dirPath, []);
  }
}

/**
 * Whether the tree currently draws the files `.gitignore` masks.
 *
 * Read through the kernel on every render rather than cached in a module variable: the setting
 * roams, so another window can change it, and this one repaints on `onSettingsChanged`.
 */
export function showIgnoredFiles(): boolean {
  return readStoredSetting(SETTINGS.showIgnoredFiles) === "true";
}

/** Set whether the tree draws the files `.gitignore` masks. */
export function setShowIgnoredFiles(show: boolean): void {
  setSetting(SETTINGS.showIgnoredFiles, show ? "true" : "");
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
    resetIgnoreCache();

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
      await openLastSessionOrHome();
      void maybePromptJxsuiteUpdate(meta.root);
    }
    // If not a site project (monorepo) — show welcome prompt, don't load tree
  } catch {
    // Not on dev server — project features disabled
  }
}

// ─── Open Project (PAL-based) ─────────────────────────────────────────────

/**
 * Open a project via the platform adapter, into THIS window.
 *
 * Reports whether a project was actually opened: a cancelled picker and a failed open both leave
 * the window on the project it already had, and the caller announces the outcome — "Opening the
 * project…" over a dialog the user just dismissed is a report of something that did not happen.
 *
 * @param {{ renderLeftPanel: () => void }} ctx
 * @returns {Promise<boolean>} Whether the window changed project.
 */
export async function openProject({
  renderLeftPanel,
}: {
  renderLeftPanel: () => void;
}): Promise<boolean> {
  try {
    const platform = getPlatform();
    const result = await platform.openProject();
    if (!result) {
      return false;
    } // User cancelled

    const { config, handle } = result;

    replaceAllTabs({
      document: { children: [], tagName: "div" },
      id: "initial",
    });

    /* A different project means a different preview origin, and the published map is keyed by
       project-relative path — so carrying it across would let one project's `pages/index.json`
       stand in as the answer for another's. */
    disarmPreviewOverlay();
    refreshFormats();
    void loadFormats();
    refreshExtensionUi(platform);
    resetIgnoreCache();

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

    await openLastSessionOrHome();
    void maybePromptJxsuiteUpdate(requireProjectState().projectRoot);
    return true;
  } catch (error) {
    notify.error("Could not open the project.", {
      detail: errorMessage(error),
      source: "Open Project",
    });
    return false;
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

/**
 * Reopen the documents this project was last left with, or its home page if there are none.
 *
 * Plan §4.4, and P3's "Newly possible": **the session survives a relaunch.** Every one of the three
 * ways into a project — the `?project=` bootstrap, the PAL picker and a recent-project open — ended
 * at `openHomePage()`, so nine open documents, a split and the mode you were in were lost each
 * time. The per-project record's own interface said "session state grows into this shape".
 *
 * ONE function for all three, because the three used to be three calls to `openHomePage` and this
 * is exactly the kind of behaviour that lands on two of them.
 *
 * A path that no longer resolves is skipped, and a session that restores NOTHING falls through to
 * the home page rather than leaving an empty window: files move, and a stale record must not cost
 * you the one page a project can always show.
 *
 * @returns Whether a SESSION was restored — `false` means the home page was opened instead.
 */
export async function openLastSessionOrHome(): Promise<boolean> {
  // `workspace.projectRoot`, and NOT a root passed in: that is the key `persistProjectShell` writes
  // Under, and the three callers each know the project by a slightly different name — `meta.root`,
  // `projectState.projectRoot`, the recent-list entry. One reader of one field cannot disagree with
  // The writer; three callers passing three spellings silently restore nothing.
  const session = persistedSession(workspace.projectRoot);
  // Read first, THEN allow writes: the persist effect fires the moment `workspace.projectRoot` is
  // Set, and an empty workspace captured at that instant would overwrite the very record this line
  // Reads. See `markSessionRestored`.
  markSessionRestored(workspace.projectRoot);
  if (session) {
    const opened = await restoreSession(session, {
      ensureSecondPane: () => {
        receivingPane();
      },
      openFile: (path, paneId) => openFileInTab(path, { focus: false, paneId }),
    });
    if (opened > 0) {
      return true;
    }
  }
  await openHomePage();
  // Whether a SESSION was restored, which is not the same as whether anything opened: the
  // `?project=` boot needs to know if it should still run its own inline open, and a home page is
  // Not an answer to that question.
  return false;
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

  const showingIgnored = showIgnoredFiles();

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
            /* The rules go with the listings. Refresh is what an author reaches for after editing a
               `.gitignore` by hand, and a tree that came back still hiding by the old rules would
               read as the button not having worked. */
            resetIgnoreCache();
            await loadDirectory(".");
            for (const dir of requireProjectState().expanded) {
              await loadDirectory(dir);
            }
            renderLeftPanel();
          }}
        >
          <sp-icon-refresh slot="icon"></sp-icon-refresh>
        </sp-action-button>
        <sp-action-button
          size="xs"
          label=${showingIgnored ? "Hide ignored files" : "Show ignored files"}
          ?selected=${showingIgnored}
          @click=${() => {
            /* A repaint and nothing else: the ignored entries were never dropped from
               `projectState.dirs`, only from the rows built out of it. */
            setShowIgnoredFiles(!showingIgnored);
            renderLeftPanel();
          }}
        >
          ${
            showingIgnored
              ? html`<sp-icon-visibility slot="icon"></sp-icon-visibility>`
              : html`<sp-icon-visibility-off slot="icon"></sp-icon-visibility-off>`
          }
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
    <div
      class="file-tree"
      role="tree"
      aria-label="Project files"
      @keydown=${(e: KeyboardEvent) => {
        onFileTreeKeydown(e, e.currentTarget as HTMLElement);
      }}
      ${ref((el) => {
        if (el) {
          afterFileTreeRender(el as HTMLElement);
        }
      })}
    >
      ${fileTreeBodyTemplate({ openFileFn, renderLeftPanel })}
    </div>
  `;
}

// ─── The row model, and the window onto it ───────────────────────────────────

/**
 * One row the Files tree would draw, in display order.
 *
 * An expanded directory contributes its children immediately after its own row, so an index into
 * this array is what "the row below this one" MEANS for the keyboard — and it goes on meaning it
 * whether or not the row below happens to be painted.
 */
interface FileRow {
  /**
   * Lit's `repeat` key.
   *
   * Keyed, where the recursive form was positional: a windowed list re-uses its DOM nodes for
   * DIFFERENT rows as the window slides, so positional reuse would leave the keyboard focused on an
   * element that has since become another file. The prefix is what keeps a directory's own row and
   * the "Loading…" row underneath it apart — they name the same path.
   */
  key: string;
  path: string;
  name: string;
  type: string;
  depth: number;
  expanded: boolean;
  /** A placeholder for a directory whose listing has not arrived yet. Not a `treeitem`. */
  loading: boolean;
  /** 1-based position among this row's siblings (`aria-posinset`). */
  posInSet: number;
  /** How many siblings the row has, itself included (`aria-setsize`). */
  setSize: number;
  /**
   * The declared locale whose directory this row sits under, or absent.
   *
   * A chip, not a filter term: the tree's search still matches `entry.name` alone, because a query
   * that silently also matched a language would make "why is this file here" unanswerable from what
   * is on screen.
   */
  locale?: string | undefined;
}

/**
 * The declared height of one row — `styles/panels.css` `.file-tree-item { block-size: 24px }`.
 *
 * The first paint of a session windows by this constant, because nothing has been laid out yet to
 * measure; {@link fileRowHeight} measures a real row from then on and believes the measurement.
 */
export const FILE_ROW_HEIGHT = 24;

/** The rows the tree last built, in display order. */
let _fileRows: FileRow[] = [];
/** The `.file-tree` element, kept between renders so the next one can be windowed. */
let _fileList: HTMLElement | null = null;
/** The scroll watch that repaints the tree as its scroller moves. */
let _fileWatch: ListWindowWatch | null = null;
/** The Navigator repaint, captured per render so the scroll watch never holds a stale one. */
let _filesRerender: (() => void) | null = null;
/** A keyboard jump that had to scroll first, spent by the repaint it provoked. */
let _pendingFocusPath: string | null = null;

/** The height one row actually has; the declared constant until a row has been laid out. */
function fileRowHeight(): number {
  return measuredRowHeight(_fileList, ".file-tree-item", FILE_ROW_HEIGHT);
}

/**
 * Append one directory's rows, and every expanded child directory's rows after their own row.
 *
 * The listing side effect stays exactly where the recursive template had it: a directory nobody has
 * listed yet is fetched, and a placeholder holds its place until the repaint arrives.
 */
function collectFileRows(
  dirPath: string,
  depth: number,
  rows: FileRow[],
  ctx: { renderLeftPanel: () => void },
  i18n: ResolvedI18n | null,
): void {
  const entries = requireProjectState().dirs.get(dirPath);
  if (!entries) {
    void loadDirectory(dirPath).then(() => ctx.renderLeftPanel());
    rows.push({
      depth,
      expanded: false,
      key: `loading:${dirPath}`,
      loading: true,
      name: "Loading…",
      path: dirPath,
      posInSet: 1,
      setSize: 1,
      type: "file",
    });
    return;
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

  /* Ignored entries are dropped HERE and not at the listing, so `projectState.dirs` goes on
     mirroring the filesystem for everything else that reads it and the toggle is a repaint. An
     ignored directory contributes no row, so nothing ever recurses into one — which is also git's
     rule that a parent's exclusion cannot be undone from inside it. */
  const visible = showIgnoredFiles()
    ? sorted
    : sorted.filter((e) => !isIgnoredEntry(dirPath, e.path, e.type === "directory"));

  const query = requireProjectState().searchQuery.toLowerCase();
  const filtered = query
    ? visible.filter((e) => e.type === "directory" || e.name.toLowerCase().includes(query))
    : visible;

  for (const [index, entry] of filtered.entries()) {
    const isDir = entry.type === "directory";
    const isExpanded = isDir && requireProjectState().expanded.has(entry.path);
    rows.push({
      depth,
      expanded: isExpanded,
      key: entry.path,
      loading: false,
      name: entry.name,
      path: entry.path,
      locale: localeOfPath(entry.path, i18n) ?? undefined,
      posInSet: index + 1,
      setSize: filtered.length,
      type: entry.type,
    });
    if (isExpanded) {
      collectFileRows(entry.path, depth + 1, rows, ctx, i18n);
    }
  }
}

/** The model index of `path`, or -1. A "Loading…" row is keyed apart and never matches. */
function fileIndexOfPath(path: string | undefined): number {
  return path === undefined ? -1 : _fileRows.findIndex((row) => !row.loading && row.path === path);
}

/** The next focusable row from `index`, walking by `step`; -1 at the ends. */
function fileStep(index: number, step: 1 | -1): number {
  for (let i = index + step; i >= 0 && i < _fileRows.length; i += step) {
    if (!_fileRows[i]!.loading) {
      return i;
    }
  }
  return -1;
}

/**
 * Repaint the tree because its window changed.
 *
 * Deferred to a microtask so a scroll arriving mid-commit cannot re-enter the render producing the
 * rows, and skipped during a drag: `registerFileTreeDnD` holds pragmatic-dnd registrations on the
 * rows it can see, and re-rendering under an active drag would drop every one of them.
 */
function fileWindowChanged(): void {
  if (_fileList?.isConnected !== true || _fileList.querySelector(".file-tree-item.dragging")) {
    return;
  }
  queueMicrotask(() => _filesRerender?.());
}

/**
 * Adopt the rendered tree: remember it, keep it watching whatever scrolls it, and hand the keyboard
 * the row a jump asked for once that row exists.
 *
 * The first paint of a session draws every row, because nothing can be measured before it exists;
 * the watch's opening measurement is what asks for the second, windowed pass. Idempotent by
 * construction — `watchListWindow` hands back the same watch for the same element and scroller — so
 * calling it after every render costs a comparison.
 */
function adoptFileTree(tree: HTMLElement): void {
  _fileList = tree;
  _fileWatch = watchListWindow(_fileWatch, tree, {
    count: () => _fileRows.length,
    onChange: fileWindowChanged,
    rowHeight: fileRowHeight,
  });
  const wanted = _pendingFocusPath;
  if (wanted !== null) {
    // One shot: a focus request that outlived its own repaint is stale, and moving the keyboard
    // Later is worse than never having moved it.
    _pendingFocusPath = null;
    fileRowElement(tree, wanted)?.focus();
  }
}

/**
 * Adopt the tree once its rows are in the document.
 *
 * Deferred by a microtask on purpose, exactly as the Outline's `afterTreeRender` is: a `ref` on the
 * tree element commits BEFORE the child part holding the rows, so on a first render the callback
 * would otherwise measure an empty tree.
 */
function afterFileTreeRender(tree: HTMLElement): void {
  queueMicrotask(() => adoptFileTree(tree));
}

/** The rendered row for a path, or null when the window does not currently hold it. */
function fileRowElement(tree: HTMLElement, path: string): HTMLElement | null {
  return tree.querySelector<HTMLElement>(`.file-tree-item[data-path="${CSS.escape(path)}"]`);
}

/**
 * The tree's rows, windowed, with the scroll height of the rows it left out reserved either side.
 *
 * The two spacers are `aria-hidden` because a `role="tree"` owns `treeitem`s, and an empty div that
 * exists to be 4 000 pixels tall is not one.
 */
function fileTreeBodyTemplate(ctx: {
  openFileFn: (path: string) => void;
  renderLeftPanel: () => void;
}): TemplateResult {
  // The scroll watch outlives this call and must never repaint through a closure from an earlier
  // One — the Navigator's scheduler is the only thing that knows how to draw this panel.
  _filesRerender = ctx.renderLeftPanel;
  _fileRows = [];
  // Resolved once for the whole tree, not once per row: this function runs on EVERY repaint of the
  // Navigator, and `resolveI18n` canonicalizes every declared tag through `Intl.Locale`.
  const { i18n } = resolveI18n(projectState?.projectConfig ?? {});
  collectFileRows(".", 0, _fileRows, ctx, i18n);
  // Windowed against the PREVIOUS render's element, the only one that exists while this template is
  // Being built. There is none on the first paint, and `listWindow` then answers "all of them".
  const range = listWindow(_fileList, { count: _fileRows.length, rowHeight: fileRowHeight() });
  // The roving tab stop is decided from the MODEL — the first DRAWN row of a windowed tree is
  // Usually not the first row of the tree — and then clamped INTO the window, because a tab stop
  // That is not in the document is not a tab stop: a tree whose selected row has scrolled away
  // Would otherwise have no tabbable row at all, and Tab would skip the whole panel.
  const wanted = Math.max(0, fileIndexOfPath(requireProjectState().selectedPath ?? undefined));
  const tabStop = Math.min(Math.max(wanted, range.start), Math.max(range.start, range.end - 1));
  const slice = _fileRows
    .slice(range.start, range.end)
    .map((row, offset) => ({ row, tabStop: range.start + offset === tabStop }));
  return html`
    <div style="height:${range.padTop}px" aria-hidden="true"></div>
    ${repeat(
      slice,
      (entry) => entry.row.key,
      (entry) => fileRowTemplate(entry.row, entry.tabStop, ctx),
    )}
    <div style="height:${range.padBottom}px" aria-hidden="true"></div>
  `;
}

/** One row, drawn. */
function fileRowTemplate(
  row: FileRow,
  tabStop: boolean,
  ctx: { openFileFn: (path: string) => void; renderLeftPanel: () => void },
): TemplateResult {
  if (row.loading) {
    return html`<div
      class="file-tree-item"
      style="padding-left:${8 + row.depth * 16}px;color:var(--fg-dim);font-style:italic"
    >
      Loading…
    </div>`;
  }
  const isDir = row.type === "directory";
  return html`
    <div
      class=${classMap({
        "file-tree-item": true,
        selected: requireProjectState().selectedPath === row.path,
      })}
      style="padding-left:${8 + row.depth * 16}px"
      role="treeitem"
      aria-level=${row.depth + 1}
      aria-posinset=${row.posInSet}
      aria-setsize=${row.setSize}
      tabindex=${tabStop ? "0" : "-1"}
      data-path=${row.path}
      data-type=${row.type}
      aria-expanded=${isDir ? String(row.expanded) : nothing}
      @click=${async (e: MouseEvent) => {
        e.stopPropagation();
        if (isDir) {
          await toggleTreeDirectory(row.path);
          ctx.renderLeftPanel();
        } else {
          ctx.openFileFn(row.path);
        }
      }}
      @contextmenu=${(e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        showFileContextMenu(e, { name: row.name, path: row.path, type: row.type }, ctx);
      }}
    >
      ${
        isDir
          ? html`<span class="file-tree-toggle">${row.expanded ? "▼" : "▶"}</span>`
          : html`<span class="file-tree-toggle empty"> </span>`
      }
      <span class="file-tree-icon">${fileTypeIconTpl(row.path, row.type)}</span>
      <span class="file-tree-name">${row.name}</span>
      ${
        row.locale === undefined
          ? nothing
          : html`<span class="file-tree-locale">${localeLabel(row.locale)}</span>`
      }
    </div>
  `;
}

/** Expand or collapse one directory, listing it the first time it is opened. */
async function toggleTreeDirectory(path: string): Promise<void> {
  const state = requireProjectState();
  if (state.expanded.has(path)) {
    state.expanded.delete(path);
    return;
  }
  state.expanded.add(path);
  if (!state.dirs.has(path)) {
    await loadDirectory(path);
  }
}

/*
 * There is no setupTreeKeyboard here any more, and no WeakSet of trees that already have one.
 *
 * The panel's afterRender called it after every repaint and lit re-uses the `.file-tree` element
 * across all of them, so the unguarded `addEventListener` it replaced accumulated one listener per
 * render — after ten repaints a single Down keystroke walked ten rows. The WeakSet made that safe;
 * `@keydown` on the element the template already renders makes it impossible, because lit owns the
 * binding and swaps it rather than stacking it.
 */

/**
 * The tree's keyboard model: ↑↓ walk the rows, → expands, ← collapses, Enter opens.
 *
 * ↑ and ↓ step through the MODEL, not through the rendered rows. A DOM-indexed walk stopped dead at
 * the last row of the window — three rows past the bottom of the viewport, with thousands of files
 * still below it — because there was simply no next element to focus. When the step lands outside
 * the window the scroller moves instead, and the focus follows on the repaint ({@link
 * adoptFileTree}).
 */
function onFileTreeKeydown(e: KeyboardEvent, tree: HTMLElement): void {
  const focused = tree.querySelector(".file-tree-item:focus") as HTMLElement | null;
  if (!focused) {
    return;
  }
  let handled = true;

  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp": {
      const from = fileIndexOfPath(focused.dataset.path);
      focusFileRow(tree, fileStep(from, e.key === "ArrowDown" ? 1 : -1));
      break;
    }
    case "ArrowRight": {
      const path = collapsedDirectoryAt(focused);
      if (path !== null) {
        // The expansion repaints THROUGH the panel. It used to synthesise a click on the focused
        // Row to get a repaint, which ran that row's own toggle a second time and only did the
        // Right thing because the handler's captured `isExpanded` was already stale.
        void toggleTreeDirectory(path).then(() => _filesRerender?.());
      }
      break;
    }
    case "ArrowLeft": {
      const path = expandedDirectoryAt(focused);
      if (path !== null) {
        requireProjectState().expanded.delete(path);
        // It used to leave the repaint to "the caller who sets up keyboard", and there was no such
        // Caller: ← changed the state and left the children on screen until something else
        // Happened to redraw the panel.
        _filesRerender?.();
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
}

/** The row's directory path when it is a COLLAPSED directory — what → acts on, and nothing else. */
function collapsedDirectoryAt(row: HTMLElement): string | null {
  const { path, type } = row.dataset;
  return type === "directory" && path !== undefined && !requireProjectState().expanded.has(path)
    ? path
    : null;
}

/** The row's directory path when it is an EXPANDED directory — what ← acts on, and nothing else. */
function expandedDirectoryAt(row: HTMLElement): string | null {
  const { path, type } = row.dataset;
  return type === "directory" && path !== undefined && requireProjectState().expanded.has(path)
    ? path
    : null;
}

/** Move the keyboard to the model row at `index`, bringing it into the window if it is outside. */
function focusFileRow(tree: HTMLElement, index: number): void {
  const row = _fileRows[index];
  if (!row) {
    return;
  }
  const el = fileRowElement(tree, row.path);
  if (el) {
    el.focus();
    return;
  }
  if (revealListRow(_fileList, index, fileRowHeight())) {
    _pendingFocusPath = row.path;
    _filesRerender?.();
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
  input.accept = uploadAccept();
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
        ? {
            action: () => {
              void registry.run(command.id, args);
            },
            label: command.title,
          }
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

  let x = e.clientX;
  let y = e.clientY;

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

/**
 * What an open can say beyond the path. Every field defaults to today's answer.
 *
 * Deliberately one inline-typed `opts` object rather than a `paneId` parameter:
 * `scripts/check-pane-singletons.ts` rule 4 charges any function whose parameters NAME a pane for
 * reading the focus, one hop in — and {@link openFileInTab} legitimately falls back to the focused
 * pane when nobody names one. {@link openFileInPane} is the named sibling for readers who want the
 * pane in the signature; it is pane-scoped and reads no focus of its own.
 */
export interface OpenFileOpts {
  /** Which pane. Defaults to the focused one. */
  paneId?: string;
  /** Open as a disposable preview tab (§4.3) — browsing rather than committing. */
  preview?: boolean;
  /** False leaves the keyboard where it is. Defaults to true. */
  focus?: boolean;
}

/**
 * Bring an ALREADY-OPEN tab to where the caller asked for it.
 *
 * Three cases, and the third is the one a following pane depends on:
 *
 * | the tab is…                                      | behaviour                                      |
 * | ------------------------------------------------ | ---------------------------------------------- |
 * | in the requested pane (or no pane was requested) | activate it there, honouring `focus`           |
 * | elsewhere, and **not** its pane's active tab     | move it — one tab is one document in one strip |
 * | elsewhere, and **is** its pane's active tab      | **nothing.** You are already looking at it     |
 *
 * The third exists because moving it would oscillate: a derivation that re-resolves to the document
 * the author is editing would yank it out of their pane and into the assistant one, and the follow
 * would then re-resolve against whatever landed in its place.
 */
function revealOpenTab(tabId: string, opts: OpenFileOpts): void {
  const wanted = opts.paneId;
  const holder = paneOfTab(tabId);
  if (wanted !== undefined && holder && holder.id !== wanted) {
    if (holder.activeTabId === tabId) {
      return;
    }
    moveTabToPane(tabId, wanted);
  }
  activateTab(tabId, { focus: opts.focus !== false });
}

/**
 * Open a file from the tree into a tab. Activates the existing tab if it is already open.
 *
 * @param {string} path
 * @param {OpenFileOpts} [opts]
 */
export async function openFileInTab(path: string, opts: OpenFileOpts = {}) {
  const follows = opts.focus !== false;
  for (const [id, tab] of workspace.tabs.entries()) {
    if (tab.documentPath === path) {
      revealOpenTab(id, opts);
      // The tree's cursor answers "where is the author", so a side-open that deliberately left the
      // Keyboard behind must not move it.
      if (follows) {
        requireProjectState().selectedPath = path;
      }
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
      ...(opts.paneId !== undefined && { paneId: opts.paneId }),
      ...(opts.preview === true && { preview: true }),
      ...(opts.focus === false && { focus: false }),
    });
    if (follows) {
      requireProjectState().selectedPath = path;
    }
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
 * Open a file into a NAMED pane, browsing rather than committing, leaving the keyboard behind.
 *
 * The same body as {@link openFileInTab} with the three options a side-open always wants, given a
 * signature that says which pane in the first parameter. It is what "open it beside this" means
 * everywhere it is asked for — drilling into a component, following a layout, `pane.compareWith`.
 *
 * @param {string} paneId
 * @param {string} path
 */
export async function openFileInPane(paneId: string, path: string): Promise<void> {
  await openFileInTab(path, { focus: false, paneId, preview: true });
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
    afterRender: (ctx) => {
      ctx.deps.registerFileTreeDnD({ renderLeftPanel: ctx.rerender });
    },
  });
}
