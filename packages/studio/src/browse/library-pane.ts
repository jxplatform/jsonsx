/// <reference lib="dom" />
/**
 * The Library — an editor kind, drawn into the pane, over a {@link LibrarySource}.
 *
 * It replaces the Manage view, which was a full-screen MODAL over the whole shell. Everything that
 * was wrong with that follows from the modal: it could not be a tab, so it could not be one of two
 * panes, so it could not be open beside the page you were browsing FOR; it had no editor kind, so
 * the status bar and the pane context bar had nothing to say about it; and its own filter bar was
 * the only way to reach any of its state, so nothing it did was in the palette, on a chord, or
 * available to the assistant. `manage` was already in `commands/context.ts`'s `EDITOR_KIND_BY_MODE`
 * — the map just had nothing behind it.
 *
 * Four things this module is careful about:
 *
 * 1. **It never says "No files found" for two different reasons.** A scan that could not read a
 *    directory is INCOMPLETE, not empty; it raises a Problem carrying the directory and a Retry
 *    (`library.refresh`), and the surface says so. A filter that matched nothing says which
 *    filter.
 * 2. **The rendered item count is proportional to the viewport, not to the project.** See
 *    `../ui/virtual-window.ts` and `library-preview.ts`; the acceptance case is 300 pages in
 *    "All".
 * 3. **An upload has a named destination**, shown before the drop, asked for when the active category
 *    does not name one.
 * 4. **Creation is somebody else's flow.** A page, layout or component is `files.ts`'s creation, so a
 *    new page from the Library and a new file from the tree refuse a name that is already taken in
 *    exactly the same way; a collection entry is `content/entry-commands.ts`'s `createEntry`, so it
 *    arrives with the collection's extension and a body seeded from that collection's schema.
 *
 * @docs studio/projects/browse
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { effect, effectScope, reactive } from "../reactivity";
import { errorMessage } from "@jxsuite/schema/parse";
import { notify } from "../services/notify";
import { beginActivity } from "../panels/activity-panel";
import { renderPopover, showPromptDialog } from "../ui/layers";
import { rectOf } from "../utils/geometry";
import { getPlatform } from "../platform";
import { invalidateUsages } from "../services/references";
import { confirmFileDelete, renamePromptMessage } from "../files/file-ops";
import { createFileIn, openFileInTab } from "../files/files";
import { createEntry } from "../content/entry-commands";
import { entryCollections } from "../content/entry-model";
import { uploadAccept, uploadAssets } from "../files/media-upload";
import { localeLabel } from "@jxsuite/schema/locale";
import {
  LIBRARY_CATEGORIES,
  LIBRARY_LAYOUTS,
  LIBRARY_LAYOUT_LABELS,
  PREVIEW_LAYOUTS,
  filterLibrary,
  libraryCategory,
  libraryLocales,
  uploadDirForCategory,
} from "./library-model";
import { createLibrarySource, libraryColumns } from "./library-source";
import { createPreviewCache, createPreviewObserver, previewFor } from "./library-preview";
import { computeWindow } from "../ui/virtual-window";
import { paneRegion } from "../ui/regions";
import {
  LAYOUT_METRICS,
  boardTpl,
  calendarTpl,
  cardsTpl,
  columnsAt,
  mediaTpl,
  tableHeadTpl,
  tableRowsTpl,
} from "./library-layouts";
import type { ActivityHandle } from "../panels/activity-panel";
import type { EffectScope } from "@vue/reactivity";
import type { LibraryFile, LibraryLayout } from "./library-model";
import type { LibrarySource } from "./library-source";
import type { LayoutContext } from "./library-layouts";
import type { PreviewCache, PreviewObserver } from "./library-preview";
import type { WindowRange } from "../ui/virtual-window";
import type { Tab } from "../tabs/tab";
import type { CanvasSurface } from "../canvas/canvas-surface";

// ─── View state ──────────────────────────────────────────────────────────────

export interface LibraryViewState {
  category: string;
  layout: LibraryLayout;
  query: string;
  /**
   * The language facet: a canonical tag, or "" for every language.
   *
   * A tag rather than a label, because two locales can display the same autonym and only the tag
   * matches what {@link LibraryFile.locale} carries.
   */
  locale: string;
  /** Bumped to force a repaint from a non-reactive source (a scroll, a finished scan). */
  revision: number;
  /** A scan is running. Distinct from "scanned and empty", which is what the old view conflated. */
  loading: boolean;
}

/**
 * The Library's view state, reactive and module-scoped.
 *
 * Module-scoped rather than per-tab because there is one Library per window (its tab id carries no
 * category — see `grid-source.ts`), and because the commands that write it must be able to do so
 * whether or not the pane is currently mounted: `library.setCategory` run from the palette while
 * another tab is focused sets the state the Library opens into.
 */
export const libraryView: LibraryViewState = reactive({
  category: "all",
  layout: "cards",
  loading: false,
  locale: "",
  query: "",
  revision: 0,
});

/** The window's Library source. Built lazily; discarded by {@link invalidateLibrary}. */
let source: LibrarySource | null = null;

/**
 * Whether a scan has been STARTED for the current source.
 *
 * Distinct from `source.scanned()`, which only answers whether one SUCCEEDED. The pane's render
 * effect kicks the first scan off, so without this a scan that failed would be retried on the very
 * repaint its own failure caused — an infinite loop, and the reason a Retry has to be a command the
 * reader presses rather than something the surface does on its own behalf.
 */
let scanAttempted = false;

/** The source, creating it on first use. */
export function librarySource(): LibrarySource {
  source ??= createLibrarySource();
  return source;
}

/** Repaint whatever is mounted. */
function bump() {
  libraryView.revision += 1;
}

export function setLibraryCategory(key: string): void {
  libraryView.category = key;
  bump();
}

export function setLibraryLayout(layout: LibraryLayout): void {
  libraryView.layout = layout;
  bump();
}

export function setLibrarySearch(query: string): void {
  libraryView.query = query;
  bump();
}

/** Show one language, or `""` for all of them. A setter, so "" is a value and not an absence. */
export function setLibraryLocale(locale: string): void {
  libraryView.locale = locale;
  bump();
}

/**
 * Drop the scan and the rendered previews.
 *
 * Called by every surface that changes the project's file set — an upload, a creation, a rename, a
 * delete — so the Library is never showing a file that is gone.
 */
export function invalidateLibrary(): void {
  source = null;
  scanAttempted = false;
  for (const panel of _active.values()) {
    panel.cache.clear();
    panel.slots.clear();
  }
  bump();
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/** A scan slower than this earns an Activity row; a fast one must not litter the dock. */
export const SCAN_ACTIVITY_DELAY_MS = 600;

/** Deduplication key for the scan Problem, so a failing watcher is one row and not sixty. */
const SCAN_PROBLEM_KEY = "library.scan";

/**
 * Run the scan and report it honestly.
 *
 * No Cancel: `platform.listDirectory` has no abort, so a Cancel button here could only stop the
 * WAITING, not the work — and a button that does not do what it says is the failure the Activity
 * contract exists to end. The row is informational, and it only appears when the scan is slow
 * enough that its absence would look like a hang.
 */
async function loadLibrary(): Promise<void> {
  const current = librarySource();
  scanAttempted = true;
  libraryView.loading = true;
  bump();

  const slow: { handle: ActivityHandle | null } = { handle: null };
  const timer = setTimeout(() => {
    slow.handle = beginActivity({
      source: "Library",
      status: "Reading the project's directories…",
      title: "Scan project files",
    });
  }, SCAN_ACTIVITY_DELAY_MS);

  try {
    await current.rows();
    const failures = current.failures();
    if (failures.length > 0) {
      const detail = failures.map((f) => `${f.dir} — ${f.error}`).join("\n");
      const summary = `Could not read ${failures.length} project ${
        failures.length === 1 ? "directory" : "directories"
      } — this list is incomplete.`;
      // A Problem, not a toast: the list on screen is wrong until this is fixed, and the fix is a
      // Command the row can run.
      notify.error(summary, {
        action: "library.refresh",
        detail,
        key: SCAN_PROBLEM_KEY,
        path: failures[0]!.dir,
        source: "Library",
        tier: "problem",
      });
      slow.handle?.setStatus(summary);
    }
    slow.handle?.done(`${current.files().length} file(s)`);
  } catch (error) {
    // `scanLibrary` does not reject, so reaching here means the platform itself is gone.
    const message = "Could not scan the project's files.";
    if (slow.handle) {
      slow.handle.fail(message);
    } else {
      notify.error(message, {
        action: "library.refresh",
        detail: errorMessage(error),
        key: SCAN_PROBLEM_KEY,
        source: "Library",
        tier: "problem",
      });
    }
  } finally {
    clearTimeout(timer);
    libraryView.loading = false;
    bump();
  }
}

/** Re-scan from scratch — the Retry behind the Problem, and the toolbar's Refresh. */
export async function refreshLibrary(): Promise<void> {
  source = null;
  scanAttempted = false;
  for (const panel of _active.values()) {
    panel.cache.clear();
  }
  await loadLibrary();
}

// ─── The mounted pane ────────────────────────────────────────────────────────

interface ActiveLibraryPane {
  /** The pane whose stage this Library is drawn on. The map key, held on the record too. */
  paneId: string;
  tabId: string;
  scope: EffectScope;
  wrap: HTMLElement;
  cache: PreviewCache;
  observer: PreviewObserver;
  /** The scroller, once lit has created it. */
  scroller: HTMLElement | null;
  /** Slot elements awaiting a preview, keyed by the element itself. */
  pending: WeakMap<Element, LibraryFile>;
  /** The live preview slot for each path in the CURRENT window, so a resolved render finds it. */
  slots: Map<string, Element>;
  /**
   * Paths whose preview is being built right now.
   *
   * Without this a repaint mid-load asks for the same document again: lit hands a fresh `ref`
   * closure on every render, so the slot is re-registered before the first read has resolved, and a
   * scroll through a long list would read each document several times over.
   */
  pendingPaths: Set<string>;
}

/**
 * The Library mounted in each pane, keyed by pane id.
 *
 * ONE instance per pane, not per window. It was a module-level `let active`, which is a fact about
 * the shell having had one stage — and the failure it produced the moment two are drawn is not
 * cosmetic: pane B mounting a Library called `detachLibraryPane()`, destroying pane A's
 * `IntersectionObserver`, preview cache and effect scope while pane A's DOM was still on screen.
 * `canvas-render.ts`'s `resetCanvasView` calls the detach UNCONDITIONALLY on every empty pane, so
 * it did not even take a second Library to do it.
 */
const _active = new Map<string, ActiveLibraryPane>();

/** The Library mounted in a pane, or null. */
function activeIn(paneId: string): ActiveLibraryPane | null {
  return _active.get(paneId) ?? null;
}

/** Whether the Library is live in this pane for this tab — the canvas-render fast-path guard. */
export function libraryPaneMounted(paneId: string, tab: Tab): boolean {
  const panel = activeIn(paneId);
  return panel !== null && panel.tabId === tab.id && panel.wrap.isConnected;
}

/** Tear one pane's Library down (mode change, tab switch, project close). Idempotent. */
export function detachLibraryPane(paneId: string): void {
  const panel = _active.get(paneId);
  if (!panel) {
    return;
  }
  panel.observer.destroy();
  panel.cache.clear();
  panel.slots.clear();
  panel.pendingPaths.clear();
  panel.scope.stop();
  _active.delete(paneId);
}

// ─── Geometry ────────────────────────────────────────────────────────────────

/** The window for the current layout, or the whole list for a layout that does not window. */
function windowFor(panel: ActiveLibraryPane, layout: LibraryLayout, count: number): WindowRange {
  const metric = LAYOUT_METRICS[layout];
  const { scroller } = panel;
  if (!metric.windowed || !scroller) {
    return { end: count, padBottom: 0, padTop: 0, start: 0, totalRows: count };
  }
  return computeWindow({
    columns: columnsAt(layout, scroller.clientWidth),
    count,
    rowHeight: metric.rowHeight,
    scrollTop: scroller.scrollTop,
    viewportHeight: scroller.clientHeight,
  });
}

// ─── Previews ────────────────────────────────────────────────────────────────

/** Build a preview and attach it to whichever slot is currently showing that path. */
async function fillPreview(panel: ActiveLibraryPane, file: LibraryFile) {
  // Only ever entered once per path at a time: `mountPreview` is the sole caller and refuses to
  // Observe a slot whose path is already in flight.
  panel.pendingPaths.add(file.path);
  try {
    const rendered = await previewFor(file.path, panel.cache);
    if (!rendered || activeIn(panel.paneId) !== panel) {
      return;
    }
    const slot = panel.slots.get(file.path);
    if (slot?.isConnected && !slot.firstElementChild) {
      slot.append(rendered);
    }
  } finally {
    panel.pendingPaths.delete(file.path);
  }
}

/** The `ref` callback every previewable card carries. */
function mountPreview(panel: ActiveLibraryPane, element: Element | undefined, file: LibraryFile) {
  if (!element) {
    return;
  }
  panel.slots.set(file.path, element);
  // Read the cache BEFORE the "already filled" shortcut, because the read is what marks the entry
  // As recently used. Skipping it let a preview that was on screen — and therefore never touched —
  // Drift to the tail of the LRU, get evicted, get detached, and be re-rendered on the next
  // Repaint: the 300-page measurement showed 560 reads for 300 documents until this line moved.
  const cached = panel.cache.get(file.path);
  if (element.firstElementChild) {
    return;
  }
  if (cached) {
    element.append(cached);
    return;
  }
  if (panel.pendingPaths.has(file.path)) {
    return;
  }
  panel.pending.set(element, file);
  panel.observer.observe(element);
}

// ─── Context menu ────────────────────────────────────────────────────────────

let contextHandle: ReturnType<typeof renderPopover> | null = null;

function dismissLibraryContextMenu() {
  contextHandle?.dismiss();
  contextHandle = null;
}

interface MenuItem {
  label: string;
  action?: () => void | Promise<void>;
  danger?: boolean;
}

function showLibraryContextMenu(event: MouseEvent, file: LibraryFile) {
  event.preventDefault();
  event.stopPropagation();
  dismissLibraryContextMenu();

  const items: MenuItem[] = [
    {
      action: () => {
        void openFileInTab(file.path);
      },
      label: "Open",
    },
    { label: "—" },
    { action: () => renameLibraryFile(file), label: "Rename…" },
    { action: () => duplicateLibraryFile(file), label: "Duplicate" },
    { label: "—" },
    { action: () => deleteLibraryFile(file), danger: true, label: "Delete" },
  ];

  let x = event.clientX;
  let y = event.clientY;

  contextHandle = renderPopover(
    html`<sp-popover
      open
      style="position:fixed;left:${x}px;top:${y}px"
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
          item.label === "—"
            ? html`<sp-menu-divider></sp-menu-divider>`
            : html`<sp-menu-item
                style=${item.danger ? "color: var(--danger)" : ""}
                @click=${() => {
                  dismissLibraryContextMenu();
                  void item.action?.();
                }}
                >${item.label}</sp-menu-item
              >`,
        )}
      </sp-menu>
    </sp-popover>`,
    {
      dismissOnOutsideClick: true,
      layer: "dialog",
      onDismiss: () => {
        contextHandle = null;
      },
    },
  );
}

/**
 * The Library's rename dialog — the same copy, from the same helper, as the Files panel's.
 *
 * A rename here rewrites references exactly as one in the sidebar does, and two dialogs that
 * disagreed about that is the divergence the shared helper exists to prevent.
 */
async function renameLibraryFile(file: LibraryFile) {
  const message = await renamePromptMessage(file.path);
  const newName = await showPromptDialog("Rename", {
    confirmLabel: "Rename",
    ...(message === undefined ? {} : { message }),
    select: "stem",
    validate: (value) => (value.trim() ? "" : "Enter a file name."),
    value: file.name,
  });
  if (!newName || newName === file.name) {
    return;
  }
  const normalized = file.path.replaceAll("\\", "/");
  const parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : ".";
  const newPath = parent === "." ? newName : `${parent}/${newName}`;
  try {
    await getPlatform().renameFile(file.path, newPath);
    invalidateUsages();
    invalidateLibrary();
    await loadLibrary();
    notify.success(`Renamed to ${newName}`);
  } catch (error) {
    notify.error(`Could not rename ${file.name}.`, {
      detail: errorMessage(error),
      path: file.path,
      source: "Library",
    });
  }
}

async function duplicateLibraryFile(file: LibraryFile) {
  const normalized = file.path.replaceAll("\\", "/");
  const parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : ".";
  const stem = file.name.replace(/(\.[^.]+)$/, "");
  const copyName = `${stem}-copy${file.ext || ""}`;
  const copyPath = parent === "." ? copyName : `${parent}/${copyName}`;
  try {
    const platform = getPlatform();
    const content = await platform.readFile(file.path);
    await platform.writeFile(copyPath, content);
    invalidateLibrary();
    await loadLibrary();
    notify.success(`Duplicated as ${copyName}`);
  } catch (error) {
    notify.error(`Could not duplicate ${file.name}.`, {
      detail: errorMessage(error),
      path: file.path,
      source: "Library",
    });
  }
}

async function deleteLibraryFile(file: LibraryFile) {
  const confirmed = await confirmFileDelete(file);
  if (!confirmed) {
    return;
  }
  try {
    await getPlatform().deleteFile(file.path);
    invalidateUsages();
    invalidateLibrary();
    await loadLibrary();
    notify.success(`Deleted ${file.name}`);
  } catch (error) {
    notify.error(`Could not delete ${file.name}.`, {
      detail: errorMessage(error),
      path: file.path,
      source: "Library",
    });
  }
}

// ─── Creation ────────────────────────────────────────────────────────────────

/** What the New menu offers: the three document kinds, plus one row per creatable collection. */
export interface LibraryNewEntry {
  key: string;
  label: string;
  dir: string;
  /**
   * The content collection this row creates an entry IN, or undefined for a document kind.
   *
   * Present is the whole difference between the two creation paths below — a collection row is
   * `content/`'s job, because only that module knows the collection's extension and its schema.
   */
  collection?: string;
}

/**
 * The new-entity rows.
 *
 * Collections come from `content/entry-model.ts` rather than from `project.json` directly, so the
 * menu offers exactly the collections an entry can be created in. The predecessor read the raw
 * `content` map and derived a directory from the type NAME when `source` was absent, which produced
 * a row for a collection that has no entry directory at all and a row for a single-file (CSV)
 * catalogue, whose entries are rows and not files. Both created a file nothing would ever load.
 */
export function libraryNewEntries(): LibraryNewEntry[] {
  const rows: LibraryNewEntry[] = [
    { dir: "pages", key: "page", label: "Page" },
    { dir: "layouts", key: "layout", label: "Layout" },
    { dir: "components", key: "component", label: "Component" },
  ];
  for (const collection of entryCollections()) {
    rows.push({
      collection: collection.name,
      dir: collection.dir,
      key: `collection:${collection.name}`,
      label: collection.name.charAt(0).toUpperCase() + collection.name.slice(1),
    });
  }
  return rows;
}

/**
 * Create one entity and open it.
 *
 * Two paths, because a collection entry is not a blank document. A **collection** row goes through
 * `content/entry-commands.ts`'s `createEntry`, which supplies the collection's extension (so the
 * field asks for a display name and the file is actually matched by the collection it was created
 * in) and a body seeded from the collection's **schema defaults** — the entry is valid the moment
 * it exists, rather than a pile of absent required fields — and then opens it in the entry FORM,
 * which is the editor that collection's fields belong to. Both of those are the reason
 * `createEntry` is called rather than reimplemented; a second seeder here would drift from the one
 * the palette's `content.newEntry` uses within a release.
 *
 * A **document kind** keeps `files.ts`'s verbatim name field, deliberately: a page may be a `.md`
 * as easily as a `.json`, so the extension the author types is a real choice and forcing one here
 * would remove it. A collection's extension is not a choice — it is the collection's.
 */
export async function createLibraryEntry(key: string): Promise<string | null> {
  const entry = libraryNewEntries().find((row) => row.key === key);
  if (!entry) {
    return null;
  }
  const created =
    entry.collection === undefined
      ? await createFileIn({
          dir: entry.dir,
          source: "Library",
          suggestedName: "untitled",
          title: `New ${entry.label}`,
        })
      : await createEntry(entry.collection);
  if (created === null) {
    return null;
  }
  invalidateLibrary();
  await loadLibrary();
  // `createEntry` has already opened the entry form; opening the file again here would replace that
  // Editor with the generic one for the same tab.
  if (entry.collection === undefined) {
    void openFileInTab(created);
  }
  return created;
}

// ─── Upload ──────────────────────────────────────────────────────────────────

/**
 * Where an upload lands, and how the author was told.
 *
 * The active category's directory when it has one — printed on the drop zone, so the destination is
 * visible BEFORE the drop. "All" has none, and rather than falling back to a default nobody chose,
 * it asks. That fallback is exactly the surprise §7 names: the file arrives, the toast says it
 * worked, and it is in a directory the author never picked.
 */
export async function resolveUploadDir(): Promise<string | null> {
  const named = uploadDirForCategory(libraryView.category);
  if (named !== undefined) {
    return named;
  }
  const chosen = await showPromptDialog("Upload files", {
    confirmLabel: "Upload",
    message: "The All view has no folder of its own. Choose where these files land.",
    placeholder: "public",
    validate: (value) => (value.trim() ? "" : "Enter a folder."),
    value: "public",
  });
  return chosen === null ? null : chosen.trim().replace(/\/$/, "");
}

async function uploadIntoLibrary(files: FileList | File[]) {
  const dir = await resolveUploadDir();
  if (dir === null) {
    return;
  }
  await uploadAssets([...files], { dir });
  invalidateLibrary();
  await loadLibrary();
}

// ─── Templates ───────────────────────────────────────────────────────────────

/**
 * The language facet, drawn only where it can change the answer.
 *
 * Its options come from ALL scanned files, never from the filtered ones: a picker whose choices
 * collapse to the choice just made cannot be used to make another. One locale — or none — means
 * every file already agrees, and a permanently-selected chip is chrome that says nothing.
 */
function localeFilterTpl(files: readonly LibraryFile[]) {
  const locales = libraryLocales(files);
  if (locales.length < 2) {
    return nothing;
  }
  const value = libraryView.locale === "" ? "all" : libraryView.locale;
  return html`
    <sp-picker
      size="s"
      quiet
      class="library-locale-filter"
      label="All languages"
      .value=${value}
      @change=${(e: Event) => {
        const chosen = (e.target as HTMLElement & { value: string }).value;
        setLibraryLocale(chosen === "all" ? "" : chosen);
      }}
    >
      <sp-menu-item value="all">All languages</sp-menu-item>
      ${locales.map((tag) => html`<sp-menu-item value=${tag}>${localeLabel(tag)}</sp-menu-item>`)}
    </sp-picker>
  `;
}

function toolbarTpl(panel: ActiveLibraryPane, files: readonly LibraryFile[]) {
  const destination = uploadDirForCategory(libraryView.category);
  return html`
    <div class="library-toolbar">
      <sp-action-group selects="single" size="s" compact>
        ${LIBRARY_CATEGORIES.map(
          (category) => html`
            <sp-action-button
              size="s"
              ?selected=${libraryView.category === category.key}
              @click=${() => setLibraryCategory(category.key)}
            >
              ${category.label}
            </sp-action-button>
          `,
        )}
      </sp-action-group>
      ${localeFilterTpl(files)}
      <sp-search
        size="s"
        placeholder="Filter files…"
        .value=${libraryView.query}
        @input=${(e: Event) => setLibrarySearch((e.target as HTMLInputElement).value)}
        @submit=${(e: Event) => e.preventDefault()}
      ></sp-search>
      <overlay-trigger placement="bottom-start" triggered-by="click">
        <sp-action-button size="s" slot="trigger">
          <sp-icon-add slot="icon"></sp-icon-add> New
        </sp-action-button>
        <sp-popover slot="click-content" tip>
          <sp-menu
            @change=${(e: Event) => {
              void createLibraryEntry((e.target as HTMLSelectElement).value);
            }}
          >
            ${libraryNewEntries().map(
              (entry) =>
                html`<sp-menu-item value=${entry.key}
                  >${entry.label} — ${entry.dir}/</sp-menu-item
                >`,
            )}
          </sp-menu>
        </sp-popover>
      </overlay-trigger>
      <sp-action-button
        size="s"
        title=${destination === undefined ? "Upload — asks for a folder" : `Upload into ${destination}/`}
        @click=${() => {
          const input = panel.wrap.querySelector(
            ".library-upload-input",
          ) as HTMLInputElement | null;
          input?.click();
        }}
      >
        <sp-icon-upload slot="icon"></sp-icon-upload> Upload
      </sp-action-button>
      <input
        type="file"
        multiple
        accept=${uploadAccept()}
        class="library-upload-input"
        @change=${(e: Event) => {
          const input = e.target as HTMLInputElement;
          if (input.files?.length) {
            void uploadIntoLibrary(input.files);
          }
          input.value = "";
        }}
      />
      <span class="library-spacer"></span>
      <sp-action-group selects="single" size="s" compact class="library-layout-switch">
        ${LIBRARY_LAYOUTS.map(
          (layout) => html`
            <sp-action-button
              size="s"
              ?selected=${libraryView.layout === layout}
              title=${LIBRARY_LAYOUT_LABELS[layout]}
              @click=${() => setLibraryLayout(layout)}
            >
              ${LIBRARY_LAYOUT_LABELS[layout]}
            </sp-action-button>
          `,
        )}
      </sp-action-group>
    </div>
  `;
}

/**
 * The banner an INCOMPLETE listing carries.
 *
 * The Problem is the durable record; this is the same fact on the surface it is about, because a
 * reader looking at a short list needs to know it is short for a reason without going to the dock.
 */
function failureBannerTpl(current: LibrarySource) {
  const failures = current.failures();
  if (failures.length === 0) {
    return nothing;
  }
  return html`<div class="library-banner" role="status">
    <span>
      This list is incomplete — ${failures.length}
      ${failures.length === 1 ? "directory" : "directories"} could not be read
      (${failures[0]!.dir}${failures.length > 1 ? ", …" : ""}).
    </span>
    <sp-button
      size="s"
      variant="secondary"
      @click=${() => {
        void refreshLibrary();
      }}
      >Retry</sp-button
    >
  </div>`;
}

/**
 * The empty state, which is FOUR states and not one.
 *
 * The view this replaces printed "No files found" for every one of them, including the one where
 * the request had failed.
 */
function emptyTpl(current: LibrarySource, total: number) {
  if (libraryView.loading || !current.scanned()) {
    return html`<div class="library-empty">Scanning the project…</div>`;
  }
  if (current.failures().length > 0) {
    return html`<div class="library-empty">
      <p>Nothing to show, and the scan did not finish.</p>
      <p class="library-empty-detail">
        ${current.failures().length}
        ${current.failures().length === 1 ? "directory" : "directories"} could not be read, so this
        is not the same as an empty project.
      </p>
      <sp-button
        size="s"
        variant="accent"
        @click=${() => {
          void refreshLibrary();
        }}
        >Retry</sp-button
      >
    </div>`;
  }
  if (total === 0) {
    return html`<div class="library-empty">
      <p>This project has no files yet.</p>
      <p class="library-empty-detail">Use New to create a page, layout, component or entry.</p>
    </div>`;
  }
  const category = libraryCategory(libraryView.category);
  // Both facets in one clause, so a reader who filtered twice is told about both rather than being
  // Sent to clear one and find the list still empty.
  const scopes = [
    category && category.key !== "all" ? category.label : "",
    libraryView.locale === "" ? "" : localeLabel(libraryView.locale),
  ].filter((scope) => scope !== "");
  const where = scopes.length === 0 ? "" : ` in ${scopes.join(" and ")}`;
  const term = libraryView.query.trim();
  return html`<div class="library-empty">
    <p>
      No files match${term ? html` “${term}”` : nothing}${where}.
      <span class="library-empty-detail">${total} file(s) in the project.</span>
    </p>
    <sp-button
      size="s"
      variant="secondary"
      @click=${() => {
        setLibrarySearch("");
        setLibraryCategory("all");
        setLibraryLocale("");
      }}
    >
      Clear filters
    </sp-button>
  </div>`;
}

/** The body for one layout, windowed where the layout windows. */
function bodyTpl(panel: ActiveLibraryPane, files: readonly LibraryFile[], ctx: LayoutContext) {
  const { layout } = libraryView;
  const range = windowFor(panel, layout, files.length);
  const slice = files.slice(range.start, range.end);

  switch (layout) {
    case "board": {
      return boardTpl(files, ctx);
    }
    case "calendar": {
      return calendarTpl(files, ctx);
    }
    case "media": {
      return html`<div
        class="library-grid library-grid-media"
        style="padding-top:${range.padTop}px;padding-bottom:${range.padBottom}px"
      >
        ${mediaTpl(slice, ctx)}
      </div>`;
    }
    case "table": {
      return html`<div class="library-table" role="table">
        ${tableHeadTpl(ctx.columns)}
        <div style="height:${range.padTop}px"></div>
        ${tableRowsTpl(slice, ctx)}
        <div style="height:${range.padBottom}px"></div>
      </div>`;
    }
    default: {
      return html`<div
        class="library-grid library-grid-cards"
        style="padding-top:${range.padTop}px;padding-bottom:${range.padBottom}px"
      >
        ${cardsTpl(slice, ctx)}
      </div>`;
    }
  }
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Draw the Library into the pane. Re-entrant: a same-tab call while it is live is a no-op, because
 * the pane owns its own reactivity from here (the grid/settings/stylebook pattern).
 */
export function renderLibraryMode(surface: CanvasSurface, tab: Tab): void {
  const { paneId, wrap: canvasWrap } = surface;
  if (libraryPaneMounted(paneId, tab)) {
    return;
  }
  detachLibraryPane(paneId);

  const scope = effectScope();
  const panel: ActiveLibraryPane = {
    cache: createPreviewCache(),
    observer: createPreviewObserver(() => {
      /* Replaced immediately below — the observer needs the panel to exist first. */
    }),
    paneId,
    pending: new WeakMap(),
    pendingPaths: new Set(),
    scope,
    scroller: null,
    slots: new Map(),
    tabId: tab.id,
    wrap: canvasWrap,
  };
  panel.observer.destroy();
  panel.observer = createPreviewObserver((element) => {
    const file = panel.pending.get(element);
    if (file) {
      panel.pending.delete(element);
      void fillPreview(panel, file);
    }
  });
  _active.set(paneId, panel);

  const ctx: LayoutContext = {
    columns: libraryColumns(),
    contextMenu: (event, file) => showLibraryContextMenu(event, file),
    mountPreview: (element, file) => {
      if (PREVIEW_LAYOUTS.has(libraryView.layout)) {
        mountPreview(panel, element, file);
      }
    },
    openFile: (path) => {
      void openFileInTab(path);
    },
  };

  const onScroller = (element: Element | undefined) => {
    const next = (element as HTMLElement | undefined) ?? null;
    if (next === panel.scroller) {
      return;
    }
    panel.scroller = next;
    next?.addEventListener("scroll", () => bump(), { passive: true });
  };

  scope.run(() => {
    effect(() => {
      if (activeIn(paneId) !== panel) {
        return;
      }
      // Everything the pane draws from.
      void libraryView.revision;
      void libraryView.category;
      void libraryView.layout;
      void libraryView.query;
      void libraryView.locale;
      void libraryView.loading;

      const current = librarySource();
      const files = filterLibrary(current.files(), {
        category: libraryView.category,
        locale: libraryView.locale,
        query: libraryView.query,
      });
      const total = current.files().length;

      // The slot table describes the CURRENT window only; the `ref` callbacks below refill it as
      // Lit commits, and a stale entry would hand a resolved preview to a detached node.
      panel.slots.clear();

      litRender(
        html`
          <div class="library" data-jx-region=${paneRegion(paneId, "library")}>
            ${toolbarTpl(panel, current.files())} ${failureBannerTpl(current)}
            <div
              class="library-body"
              data-jx-region=${paneRegion(paneId, "library/dropZone")}
              ${ref(onScroller)}
              @dragover=${(e: DragEvent) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).classList.add("library-drop-active");
              }}
              @dragleave=${(e: DragEvent) => {
                (e.currentTarget as HTMLElement).classList.remove("library-drop-active");
              }}
              @drop=${(e: DragEvent) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).classList.remove("library-drop-active");
                const dropped = e.dataTransfer?.files;
                if (dropped?.length) {
                  void uploadIntoLibrary(dropped);
                }
              }}
            >
              ${files.length === 0 ? emptyTpl(current, total) : bodyTpl(panel, files, ctx)}
            </div>
          </div>
        `,
        canvasWrap,
      );

      // Lit has committed, so every card outside the new window is now detached. Hand those
      // Observations back HERE and nowhere else: this is the only moment the pane knows the window
      // Has moved, and the intersect callback cannot be the only release path — a card flicked past
      // Before it ever intersected is never reported, so it would be watched until the tab closed.
      panel.observer.releaseDetached();

      if (!scanAttempted && !libraryView.loading) {
        void loadLibrary();
      }
    });
  });
}
