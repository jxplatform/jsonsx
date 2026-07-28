/// <reference lib="dom" />
/**
 * Manage view — project-level file browser with grid and table views.
 *
 * Displays pages, layouts, components, content, and media in a filterable grid or table. Grid view
 * shows live component/page/layout previews and image thumbnails. Includes a "New +" button with
 * type-aware entity creation (including content types from project.json).
 */

import { html, render as litRender, nothing } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { ref } from "lit-html/directives/ref.js";
import { repeat } from "lit-html/directives/repeat.js";
import { getPlatform } from "../platform";
import { projectState } from "../store";
import { yamlDefault } from "../settings/schema-field-ui";
import type { SchemaProperty } from "../settings/schema-field-ui";
import {
  MEDIA_EXTENSIONS,
  UPLOAD_ACCEPT,
  extensionOf as extOf,
  isImage,
  uploadAssets,
} from "../files/media-upload";
import { statusMessage } from "../panels/statusbar";
import { componentRegistry } from "../files/components";
import { rectOf } from "../utils/geometry";

import { renderPopover, showDialog, showPromptDialog } from "../ui/layers";
import { loopbackAssetSrc } from "../canvas/canvas-origin";
import { renderComponentPreview } from "../panels/component-preview";
import { buildScope, renderNode, setSkipServerFunctions } from "@jxsuite/runtime";
import { parseSourceForPath } from "../files/file-ops";
import {
  defaultContentFormat,
  documentExtensions,
  formatByName,
  formatForPath,
  loadFormats,
} from "../format/format-host";

import type { ComponentEntry } from "../files/components";
import type { ContentSectionEntry } from "../types";
import type { JxDocument } from "@jxsuite/schema/types";

// ─── Category definitions ────────────────────────────────────────────────────

const CATEGORIES = [
  { key: "all", label: "All" },
  { dir: "pages", key: "pages", label: "Pages" },
  { dir: "layouts", key: "layouts", label: "Layouts" },
  { dir: "components", key: "components", label: "Components" },
  { dir: "content", key: "content", label: "Content" },
  { dir: "public", key: "media", label: "Media" },
];

// ─── Module state ────────────────────────────────────────────────────────────

let activeCategory = "all";
let searchQuery = "";
let viewMode: "grid" | "table" = "grid";
let fileCache: {
  name: string;
  path: string;
  type: string;
  category: string;
  ext: string;
}[] = [];
let loading = false;
/** Track which projectDirs were used for the last load, so we re-scan when they change. */
let lastProjectDirsKey = "";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Map a file path to a display category. Media files override by extension. */
function categoryFor(dir: string, ext: string) {
  if (ext && MEDIA_EXTENSIONS.has(ext)) {
    return "Media";
  }
  if (dir.startsWith("pages")) {
    return "Pages";
  }
  if (dir.startsWith("layouts")) {
    return "Layouts";
  }
  if (dir.startsWith("components")) {
    return "Components";
  }
  if (dir.startsWith("content")) {
    return "Content";
  }
  if (dir.startsWith("public")) {
    return "Media";
  }
  if (dir.startsWith("data")) {
    return "Content";
  }
  if (dir.startsWith("styles")) {
    return "Components";
  }
  return "Other";
}

/**
 * Recursively collect all files under a directory.
 *
 * @param {string} dir
 * @param {ReturnType<typeof getPlatform>} platform
 * @returns {Promise<
 *   { name: string; path: string; type: string; category: string; ext: string }[]
 * >}
 */
async function collectFiles(
  dir: string,
  platform: ReturnType<typeof getPlatform>,
): Promise<{ name: string; path: string; type: string; category: string; ext: string }[]> {
  const results: {
    name: string;
    path: string;
    type: string;
    category: string;
    ext: string;
  }[] = [];
  try {
    const entries = await platform.listDirectory(dir);
    for (const entry of entries) {
      if (entry.type === "directory") {
        const sub = await collectFiles(entry.path, platform);
        results.push(...sub);
      } else {
        const ext = extOf(entry.name);
        const category = categoryFor(entry.path, ext);
        const type =
          category === "Content" ? contentTypeFor(entry.path) || ext || "file" : ext || "file";
        results.push({
          category,
          ext,
          name: entry.name,
          path: entry.path,
          type,
        });
      }
    }
  } catch {
    // Directory may not exist or be inaccessible
  }
  return results;
}

/**
 * Match a file path against the project `content` section's source directories to find its content
 * type name. Returns the content type name (capitalized) or null if no match.
 *
 * @param {string} filePath
 * @returns {string | null}
 */
function contentTypeFor(filePath: string) {
  const config = projectState?.projectConfig;
  const content = (config?.content ?? {}) as Record<string, ContentSectionEntry>;
  for (const [name, d] of Object.entries(content)) {
    if (!d.source) {
      continue;
    }
    const prefix = d.source.replace(/^\.\//, "").replace(/\/$/, "");
    if (filePath.startsWith(`${prefix}/`) || filePath === prefix) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  return null;
}

// ─── Data loading ────────────────────────────────────────────────────────────

async function loadFiles() {
  if (!projectState) {
    return;
  }
  loading = true;
  const platform = getPlatform();
  const dirs = projectState.projectDirs || [];
  lastProjectDirsKey = dirs.join(",");
  const all = await Promise.all(dirs.map((d: string) => collectFiles(d, platform)));
  fileCache = all.flat();
  fileCache.sort((a, b) => a.path.localeCompare(b.path));
  loading = false;
}

// ─── Filtering ───────────────────────────────────────────────────────────────

function filteredFiles() {
  let files = fileCache;
  if (activeCategory !== "all") {
    const cat = CATEGORIES.find((c) => c.key === activeCategory);
    if (cat && cat.label) {
      files = files.filter((f) => f.category === cat.label);
    }
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    files = files.filter(
      (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
    );
  }
  return files;
}

// ─── Entity types for "New +" button ────────────────────────────────────────

function getEntityTypes() {
  const pageExt = documentExtensions("page")[0] ?? ".json";
  const contentExt = defaultContentFormat()?.extensions[0] ?? ".json";
  return [
    { dir: "pages", ext: pageExt, key: "page", label: "Page" },
    { dir: "layouts", ext: ".json", key: "layout", label: "Layout" },
    { dir: "components", ext: ".json", key: "component", label: "Component" },
    { dir: "content", ext: contentExt, key: "content", label: "Content" },
  ];
}

/**
 * Build frontmatter YAML from a content type's schema properties.
 *
 * @param {string} contentTypeName
 * @returns {string}
 */
function buildFrontmatterYaml(contentTypeName: string) {
  const config = projectState?.projectConfig;
  const content = (config?.content ?? {}) as Record<string, ContentSectionEntry>;
  const col = content[contentTypeName];
  if (!col?.schema?.properties) {
    return "title: Untitled\n";
  }

  let yaml = "";
  const props = col.schema.properties as Record<string, SchemaProperty>;
  for (const [field, def] of Object.entries(props)) {
    yaml += `${field}: ${yamlDefault(def.type || "", def.format || "")}\n`;
  }
  return yaml || "title: Untitled\n";
}

/**
 * Get content-type-derived entity types from project config.
 *
 * @returns {{ key: string; label: string; dir: string; ext: string; contentTypeName: string }[]}
 */
function getContentTypeTypes() {
  const config = projectState?.projectConfig;
  const content = (config?.content ?? {}) as Record<string, ContentSectionEntry>;
  return Object.entries(content).map(([name, d]) => {
    const dir = d.source ? d.source.replace(/^\.\//, "").replace(/\/$/, "") : name;
    return {
      contentTypeName: name,
      dir,
      ext:
        d.format === "json"
          ? ".json"
          : (formatByName(d.format)?.extensions[0] ??
            defaultContentFormat()?.extensions[0] ??
            ".json"),
      key: `contentType:${name}`,
      label: name.charAt(0).toUpperCase() + name.slice(1),
    };
  });
}

/**
 * Handle creation of a new entity.
 *
 * @param {string} typeKey
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
async function handleNewEntity(
  typeKey: string,
  _container: HTMLElement,
  ctx: { openFile: (path: string) => void },
) {
  const isContentType = typeKey.startsWith("contentType:");
  const contentTypeName = isContentType ? typeKey.slice("contentType:".length) : null;
  await loadFormats();
  const allTypes = [...getEntityTypes(), ...getContentTypeTypes()];
  const typeInfo = allTypes.find((t) => t.key === typeKey);
  if (!typeInfo) {
    return;
  }

  const name = await showPromptDialog(`New ${typeInfo.label}`, {
    confirmLabel: "Create",
    message: `Creating in ${typeInfo.dir}/`,
    placeholder: "untitled",
    validate: (v) => (v.trim() ? "" : `Enter a ${typeInfo.label.toLowerCase()} name.`),
    value: "untitled",
  });
  if (!name) {
    return;
  }

  const slug = name
    .toLowerCase()
    .replaceAll(/\s+/g, "-")
    .replaceAll(/[^a-z0-9-]/g, "");
  const filePath = `${typeInfo.dir}/${slug}${typeInfo.ext}`;

  let content;
  const entityFormat = formatForPath(filePath);
  if (entityFormat) {
    content = contentTypeName
      ? `---\n${buildFrontmatterYaml(contentTypeName)}---\n\n`
      : (entityFormat.studio?.newFileTemplate ?? "");
  } else {
    content = JSON.stringify({ children: [], tagName: "div" }, null, "\t");
  }

  const platform = getPlatform();
  await platform.writeFile(filePath, content);
  invalidateBrowseCache();
  ctx.openFile(filePath);
}

// ─── Upload ─────────────────────────────────────────────────────────────────

/**
 * The directory a drop on the Manage view targets. The view filters by CATEGORY, not directory —
 * its cards are files, so there is no folder to drop "into". The active category's own directory is
 * the closest thing to a dropped location; "All" (and any category without one) falls back to the
 * active document's media directory.
 */
export function uploadDirForCategory(category: string): string | undefined {
  return CATEGORIES.find((c) => c.key === category)?.dir;
}

/**
 * Handle file uploads — writes binary files into the active category's directory.
 *
 * @param {FileList | File[]} files
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
async function handleUpload(
  files: FileList | File[],
  container: HTMLElement,
  ctx: { openFile: (path: string) => void },
) {
  const dir = uploadDirForCategory(activeCategory);
  await uploadAssets([...files], dir ? { dir } : {});
  void renderBrowse(container, ctx);
}

// ─── Context menu ───────────────────────────────────────────────────────────

let _browseCtxHandle: ReturnType<typeof renderPopover> | null = null;

function dismissBrowseContextMenu() {
  if (_browseCtxHandle) {
    _browseCtxHandle.dismiss();
    _browseCtxHandle = null;
  }
}

/**
 * @param {MouseEvent} e
 * @param {{ name: string; path: string; ext: string }} file
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
function showBrowseContextMenu(
  e: MouseEvent,
  file: { name: string; path: string; ext: string },
  container: HTMLElement,
  ctx: { openFile: (path: string) => void },
) {
  e.preventDefault();
  e.stopPropagation();
  dismissBrowseContextMenu();

  /** @type {{ label: string; action?: () => void; danger?: boolean }[]} */
  const items = [
    { action: () => ctx.openFile(file.path), label: "Open" },
    { label: "\u2014" },
    {
      action: () => browseRenameFile(file, container, ctx),
      label: "Rename\u2026",
    },
    {
      action: () => browseDuplicateFile(file, container, ctx),
      label: "Duplicate",
    },
    { label: "\u2014" },
    {
      action: () => browseDeleteFile(file, container, ctx),
      danger: true,
      label: "Delete",
    },
  ];

  let x = e.clientX,
    y = e.clientY;

  _browseCtxHandle = renderPopover(
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
          item.label === "\u2014"
            ? html`<sp-menu-divider></sp-menu-divider>`
            : html`<sp-menu-item
                style=${item.danger ? "color: var(--danger)" : ""}
                @click=${() => {
                  dismissBrowseContextMenu();
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
        _browseCtxHandle = null;
      },
    },
  );
}

/**
 * @param {{ name: string; path: string; ext: string }} file
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
async function browseRenameFile(
  file: { name: string; path: string; ext: string },
  container: HTMLElement,
  ctx: { openFile: (path: string) => void },
) {
  const newName = await showRenameDialog(file.name);
  if (!newName || newName === file.name) {
    return;
  }
  const filePath = file.path.replaceAll("\\", "/");
  const parentDir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ".";
  const newPath = parentDir === "." ? newName : `${parentDir}/${newName}`;
  try {
    const platform = getPlatform();
    await platform.renameFile(file.path, newPath);
    invalidateBrowseCache();
    void renderBrowse(container, ctx);
    statusMessage(`Renamed to ${newName}`);
  } catch (error) {
    statusMessage(`Error: ${errorMessage(error)}`);
  }
}

/**
 * @param {{ name: string; path: string; ext: string }} file
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
async function browseDuplicateFile(
  file: { name: string; path: string; ext: string },
  container: HTMLElement,
  ctx: { openFile: (path: string) => void },
) {
  const filePath = file.path.replaceAll("\\", "/");
  const parentDir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ".";
  const baseName = file.name.replace(/(\.[^.]+)$/, "");
  const ext = file.ext || "";
  const copyName = `${baseName}-copy${ext}`;
  const copyPath = parentDir === "." ? copyName : `${parentDir}/${copyName}`;
  try {
    const platform = getPlatform();
    const content = await platform.readFile(file.path);
    await platform.writeFile(copyPath, content);
    invalidateBrowseCache();
    void renderBrowse(container, ctx);
    statusMessage(`Duplicated as ${copyName}`);
  } catch (error) {
    statusMessage(`Error: ${errorMessage(error)}`);
  }
}

/**
 * @param {{ name: string; path: string; ext: string }} file
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
async function browseDeleteFile(
  file: { name: string; path: string; ext: string },
  container: HTMLElement,
  ctx: { openFile: (path: string) => void },
) {
  const confirmed = await showDeleteDialog(file.name);
  if (!confirmed) {
    return;
  }
  try {
    const platform = getPlatform();
    await platform.deleteFile(file.path);
    invalidateBrowseCache();
    void renderBrowse(container, ctx);
    statusMessage(`Deleted ${file.name}`);
  } catch (error) {
    statusMessage(`Error: ${errorMessage(error)}`);
  }
}

// ─── Spectrum dialogs ───────────────────────────────────────────────────────

/**
 * @param {string} currentName
 * @returns {Promise<string | null>}
 */
function showRenameDialog(currentName: string): Promise<string | null> {
  return showPromptDialog("Rename", {
    confirmLabel: "Rename",
    select: "stem",
    validate: (v) => (v.trim() ? "" : "Enter a file name."),
    value: currentName,
  });
}

/**
 * @param {string} fileName
 * @returns {Promise<boolean>}
 */
function showDeleteDialog(fileName: string) {
  return showDialog(
    (done) => html`
      <sp-dialog-wrapper
        open
        underlay
        headline="Delete File"
        confirm-label="Delete"
        cancel-label="Cancel"
        size="s"
        @confirm=${() => done(true)}
        @cancel=${() => done(false)}
        @close=${() => done(false)}
      >
        <p>Are you sure you want to delete <strong>${fileName}</strong>? This cannot be undone.</p>
      </sp-dialog-wrapper>
    `,
  );
}

// ─── Grid view helpers ──────────────────────────────────────────────────────

const _previewCache = new Map<string, HTMLElement>();

/**
 * Render a live preview for a page or layout file (JSON or Markdown).
 *
 * @param {string} filePath
 * @returns {Promise<HTMLElement | null>}
 */
async function renderDocPreview(filePath: string) {
  try {
    const platform = getPlatform();
    const content = await platform.readFile(filePath);
    setSkipServerFunctions(true);
    await loadFormats();
    let doc;
    if (formatForPath(filePath)) {
      const result = await parseSourceForPath(filePath, content);
      doc = result.document as JxDocument;
    } else {
      doc = JSON.parse(content) as JxDocument;
    }
    const scope = await buildScope(doc, {}, location.href);
    const el = renderNode(doc, scope);
    return el instanceof HTMLElement ? el : null;
  } catch {
    return null;
  }
}

/**
 * Load (or retrieve from cache) the preview for a card element.
 *
 * @param {Element} el — the .element-card-preview div
 * @param {{ path: string; category: string }} file
 */
async function loadPreview(el: Element, file: { path: string; category: string }) {
  // Already populated
  if (el.firstElementChild) {
    return;
  }

  // Component/doc previews instantiate a real runtime custom element that sets img.src verbatim to
  // A relative path — not a direct-parent lit literal, so it cannot be pre-rewritten via
  // LoopbackAssetSrc at this template layer. The desktop MutationObserver (plus activate()'s initial
  // Sweep) still recovers these; the brief stray views:// request is a known cosmetic residual we
  // Intentionally do NOT over-engineer with a per-component rewrite.
  let preview: HTMLElement | undefined = _previewCache.get(file.path);
  if (!preview) {
    try {
      const comp = componentRegistry.find((c: ComponentEntry) => c.path === file.path);
      preview = comp
        ? ((await renderComponentPreview(comp)) as HTMLElement | undefined)
        : ((await renderDocPreview(file.path)) as HTMLElement | undefined) || undefined;
      if (preview) {
        _previewCache.set(file.path, /** @type {HTMLElement} */ preview);
      }
    } catch {
      return;
    }
  }
  if (preview) {
    el.append(preview);
  }
}

/**
 * Render a single grid card.
 *
 * @param {{ name: string; path: string; type: string; category: string; ext: string }} file
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
function renderCard(
  file: {
    name: string;
    path: string;
    type: string;
    category: string;
    ext: string;
  },
  container: HTMLElement,
  ctx: { openFile: (path: string) => void },
) {
  const isImg = isImage(file.ext);
  const needsPreview =
    file.category === "Components" ||
    file.category === "Pages" ||
    file.category === "Layouts" ||
    file.category === "Content";

  return html`
    <div
      class="element-card"
      @click=${() => ctx.openFile(file.path)}
      @contextmenu=${(e: MouseEvent) => showBrowseContextMenu(e, file, container, ctx)}
    >
      <div
        class="element-card-preview"
        ${needsPreview
          ? ref((el: Element | undefined) => {
              if (el) {
                void loadPreview(el, file);
              }
            })
          : nothing}
      >
        ${isImg
          ? html`<img
              src=${loopbackAssetSrc(`/${file.path}`)}
              style="max-width:100%;max-height:100%;object-fit:contain"
            />`
          : needsPreview
            ? nothing
            : html`<sp-icon-document size="xl"></sp-icon-document>`}
      </div>
      <div class="element-card-label">${file.name}</div>
    </div>
  `;
}

// ─── Render ──────────────────────────────────────────────────────────────────

/**
 * Render the Browse view into the canvas area.
 *
 * @param {HTMLElement} container — the #canvas-wrap element
 * @param {{ openFile: (path: string) => void }} ctx — callbacks from studio.js
 */
export async function renderBrowse(
  container: HTMLElement,
  ctx: { openFile: (path: string) => void },
) {
  // Re-load when projectDirs changed (e.g. project opened after initial render)
  const currentKey = (projectState?.projectDirs || []).join(",");
  if ((fileCache.length === 0 && !loading) || currentKey !== lastProjectDirsKey) {
    await loadFiles();
  }

  const files = filteredFiles();

  const contentTypeTypes = getContentTypeTypes();

  const filterBar = html`
    <sp-action-group selects="single" size="s" compact>
      ${CATEGORIES.map(
        (cat) => html`
          <sp-action-button
            size="s"
            ?selected=${activeCategory === cat.key}
            @click=${() => {
              activeCategory = cat.key;
              void renderBrowse(container, ctx);
            }}
          >
            ${cat.label}
          </sp-action-button>
        `,
      )}
    </sp-action-group>
    <sp-search
      size="s"
      placeholder="Filter files..."
      .value=${searchQuery}
      @input=${(e: Event) => {
        searchQuery = (e.target as HTMLInputElement).value;
        void renderBrowse(container, ctx);
      }}
      @submit=${(e: Event) => e.preventDefault()}
    ></sp-search>
    <overlay-trigger placement="bottom-start" triggered-by="click">
      <sp-action-button size="s" slot="trigger">
        <sp-icon-add slot="icon"></sp-icon-add> New
      </sp-action-button>
      <sp-popover slot="click-content" tip>
        <sp-menu
          @change=${(e: Event) =>
            handleNewEntity((e.target as HTMLSelectElement).value, container, ctx)}
        >
          ${getEntityTypes().map(
            (t) => html`<sp-menu-item value=${t.key}>${t.label}</sp-menu-item>`,
          )}
          ${contentTypeTypes.length > 0
            ? html`<sp-menu-divider></sp-menu-divider> ${contentTypeTypes.map(
                  (t) => html`<sp-menu-item value=${t.key}>${t.label}</sp-menu-item>`,
                )}`
            : ""}
        </sp-menu>
      </sp-popover>
    </overlay-trigger>
    <sp-action-button
      size="s"
      @click=${() => {
        const input = container.querySelector(".browse-upload-input") as HTMLInputElement;
        if (input) {
          input.click();
        }
      }}
    >
      <sp-icon-upload slot="icon"></sp-icon-upload> Upload
    </sp-action-button>
    <input
      type="file"
      multiple
      accept=${UPLOAD_ACCEPT}
      class="browse-upload-input"
      style="display:none"
      @change=${(e: Event) => {
        const input = e.target as HTMLInputElement;
        if (input.files?.length) {
          void handleUpload(input.files, container, ctx);
        }
        input.value = "";
      }}
    />
    <div class="browse-view-switcher">
      <sp-action-button
        size="s"
        ?selected=${viewMode === "grid"}
        @click=${() => {
          viewMode = "grid";
          void renderBrowse(container, ctx);
        }}
        title="Grid view"
      >
        <sp-icon-view-grid slot="icon"></sp-icon-view-grid>
      </sp-action-button>
      <sp-action-button
        size="s"
        ?selected=${viewMode === "table"}
        @click=${() => {
          viewMode = "table";
          void renderBrowse(container, ctx);
        }}
        title="Table view"
      >
        <sp-icon-view-list slot="icon"></sp-icon-view-list>
      </sp-action-button>
    </div>
  `;

  const table = html`
    <sp-table size="m" quiet>
      <sp-table-head>
        <sp-table-head-cell>Name</sp-table-head-cell>
        <sp-table-head-cell>Category</sp-table-head-cell>
        <sp-table-head-cell>Type</sp-table-head-cell>
        <sp-table-head-cell>Path</sp-table-head-cell>
      </sp-table-head>
      <sp-table-body>
        ${files.length === 0
          ? html`<sp-table-row
              ><sp-table-cell
                >${loading ? "Loading..." : "No files found"}</sp-table-cell
              ></sp-table-row
            >`
          : repeat(
              files,
              (f) => f.path,
              (f) => html`
                <sp-table-row
                  value=${f.path}
                  class="browse-row"
                  style=${isImage(f.ext) ? "cursor:default" : ""}
                  @click=${isImage(f.ext) ? nothing : () => ctx.openFile(f.path)}
                  @contextmenu=${(e: MouseEvent) => showBrowseContextMenu(e, f, container, ctx)}
                >
                  <sp-table-cell class="browse-name-cell"
                    >${isImage(f.ext)
                      ? html`<img class="browse-thumb" src=${loopbackAssetSrc(`/${f.path}`)} />`
                      : nothing}${f.name}</sp-table-cell
                  >
                  <sp-table-cell>${f.category}</sp-table-cell>
                  <sp-table-cell>${f.type}</sp-table-cell>
                  <sp-table-cell class="browse-path-cell">${f.path}</sp-table-cell>
                </sp-table-row>
              `,
            )}
      </sp-table-body>
    </sp-table>
  `;

  const grid =
    files.length === 0
      ? html`<div class="browse-grid-empty">${loading ? "Loading..." : "No files found"}</div>`
      : html`<div class="browse-grid">
          ${repeat(
            files,
            (f) => f.path,
            (f) => renderCard(f, container, ctx),
          )}
        </div>`;

  const body = viewMode === "grid" ? grid : html`<div class="browse-table">${table}</div>`;

  const tpl = html`
    <div
      class="browse-view"
      @dragover=${(e: DragEvent) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.add("browse-drop-active");
      }}
      @dragleave=${(e: DragEvent) => {
        (e.currentTarget as HTMLElement).classList.remove("browse-drop-active");
      }}
      @drop=${(e: DragEvent) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.remove("browse-drop-active");
        const droppedFiles = e.dataTransfer?.files;
        if (droppedFiles?.length) {
          void handleUpload(droppedFiles, container, ctx);
        }
      }}
    >
      <div class="browse-filter-bar">${filterBar}</div>
      <div class="browse-body">${body}</div>
    </div>
  `;

  litRender(tpl, container);
}

/** Force a data reload on next render (e.g., after file creation/deletion). */
export function invalidateBrowseCache() {
  fileCache = [];
  _previewCache.clear();
}
