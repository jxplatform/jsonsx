/**
 * Manage view — project-level file browser with grid and table views.
 *
 * Displays pages, layouts, components, content, and media in a filterable grid or table. Grid view
 * shows live component/page/layout previews and image thumbnails. Includes a "New +" button with
 * type-aware entity creation (including content types from project.json).
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { repeat } from "lit-html/directives/repeat.js";
import { getPlatform } from "../platform.js";
import { projectState } from "../store.js";
import { yamlDefault } from "../settings/schema-field-ui.js";
import { invalidateMediaCache } from "../ui/media-picker.js";
import { statusMessage } from "../panels/statusbar.js";
import { componentRegistry } from "../files/components.js";

/** @typedef {import("../files/components.js").ComponentEntry} ComponentEntry */
import { showDialog, renderPopover } from "../ui/layers.js";
import { renderComponentPreview } from "../panels/stylebook-panel.js";
import { renderNode, buildScope, setSkipServerFunctions } from "@jxsuite/runtime";
import { loadMarkdown } from "../files/file-ops.js";

// ─── Category definitions ────────────────────────────────────────────────────

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "pages", label: "Pages", dir: "pages" },
  { key: "layouts", label: "Layouts", dir: "layouts" },
  { key: "components", label: "Components", dir: "components" },
  { key: "content", label: "Content", dir: "content" },
  { key: "media", label: "Media", dir: "public" },
];

const MEDIA_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".ico",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);

// ─── Module state ────────────────────────────────────────────────────────────

let activeCategory = "all";
let searchQuery = "";
/** @type {"grid" | "table"} */
let viewMode = "grid";
/** @type {{ name: string; path: string; type: string; category: string; ext: string }[]} */
let fileCache = [];
let loading = false;
/** Track which projectDirs were used for the last load, so we re-scan when they change. */
let lastProjectDirsKey = "";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** @param {string} name */
function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".ico",
]);

/** @param {string} ext */
function isImage(ext) {
  return IMAGE_EXTENSIONS.has(ext);
}

/** Map a file path to a display category. Media files override by extension. */
function categoryFor(/** @type {string} */ dir, /** @type {string} */ ext) {
  if (ext && MEDIA_EXTENSIONS.has(ext)) return "Media";
  if (dir.startsWith("pages")) return "Pages";
  if (dir.startsWith("layouts")) return "Layouts";
  if (dir.startsWith("components")) return "Components";
  if (dir.startsWith("content")) return "Content";
  if (dir.startsWith("public")) return "Media";
  if (dir.startsWith("data")) return "Content";
  if (dir.startsWith("styles")) return "Components";
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
async function collectFiles(dir, platform) {
  /** @type {{ name: string; path: string; type: string; category: string; ext: string }[]} */
  const results = [];
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
          name: entry.name,
          path: entry.path,
          type,
          category,
          ext,
        });
      }
    }
  } catch {
    // Directory may not exist or be inaccessible
  }
  return results;
}

/**
 * Match a file path against project contentTypes source globs to find its content type name.
 * Returns the content type name (capitalized) or null if no match.
 *
 * @param {string} filePath
 * @returns {string | null}
 */
function contentTypeFor(filePath) {
  const config = projectState?.projectConfig;
  if (!config?.contentTypes) return null;
  for (const [name, def] of Object.entries(config.contentTypes)) {
    const d = /** @type {ContentTypeDef} */ (def);
    if (!d.source) continue;
    const prefix = d.source.replace(/^\.\//, "").replace(/\/$/, "");
    if (filePath.startsWith(prefix + "/") || filePath === prefix) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  return null;
}

// ─── Data loading ────────────────────────────────────────────────────────────

async function loadFiles() {
  if (!projectState) return;
  loading = true;
  const platform = getPlatform();
  const dirs = projectState.projectDirs || [];
  lastProjectDirsKey = dirs.join(",");
  const all = await Promise.all(dirs.map((/** @type {string} */ d) => collectFiles(d, platform)));
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

const ENTITY_TYPES = [
  { key: "page", label: "Page", dir: "pages", ext: ".md" },
  { key: "layout", label: "Layout", dir: "layouts", ext: ".json" },
  { key: "component", label: "Component", dir: "components", ext: ".json" },
  { key: "content", label: "Content", dir: "content", ext: ".md" },
];

/**
 * Build frontmatter YAML from a content type's schema properties.
 *
 * @param {string} contentTypeName
 * @returns {string}
 */
function buildFrontmatterYaml(contentTypeName) {
  const config = projectState?.projectConfig;
  const col = config?.contentTypes?.[contentTypeName];
  if (!col?.schema?.properties) return "title: Untitled\n";

  let yaml = "";
  for (const [field, def] of Object.entries(col.schema.properties)) {
    const d = /** @type {{ type?: string; format?: string }} */ (def);
    yaml += `${field}: ${yamlDefault(d.type || "", d.format || "")}\n`;
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
  if (!config?.contentTypes) return [];
  return Object.entries(config.contentTypes).map(([name, def]) => {
    const d = /** @type {ContentTypeDef} */ (def);
    const dir = d.source ? d.source.replace(/^\.\//, "").replace(/\/$/, "") : name;
    return {
      key: `contentType:${name}`,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      dir,
      ext: `.${d.format || "md"}`,
      contentTypeName: name,
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
async function handleNewEntity(typeKey, container, ctx) {
  const isContentType = typeKey.startsWith("contentType:");
  const contentTypeName = isContentType ? typeKey.slice("contentType:".length) : null;
  const allTypes = [...ENTITY_TYPES, ...getContentTypeTypes()];
  const typeInfo = allTypes.find((t) => t.key === typeKey);
  if (!typeInfo) return;

  const name = prompt(`${typeInfo.label} name:`, "untitled");
  if (!name) return;

  const slug = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  const filePath = `${typeInfo.dir}/${slug}${typeInfo.ext}`;

  let content;
  if (typeInfo.ext === ".md") {
    const frontmatter = contentTypeName
      ? buildFrontmatterYaml(contentTypeName)
      : "title: Untitled\n";
    content = `---\n${frontmatter}---\n\n`;
  } else {
    content = JSON.stringify({ tagName: "div", children: [] }, null, "\t");
  }

  const platform = getPlatform();
  await platform.writeFile(filePath, content);
  invalidateBrowseCache();
  ctx.openFile(filePath);
}

// ─── Upload ─────────────────────────────────────────────────────────────────

const UPLOAD_ACCEPT = [
  "image/*",
  "video/*",
  "audio/*",
  ".pdf",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
].join(",");

/**
 * Handle file uploads — writes binary files to public/ directory.
 *
 * @param {FileList | File[]} files
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
async function handleUpload(files, container, ctx) {
  const platform = getPlatform();
  for (const file of files) {
    const destPath = `public/${file.name}`;
    await platform.uploadFile(destPath, file);
  }
  invalidateBrowseCache();
  invalidateMediaCache();
  renderBrowse(container, ctx);
}

// ─── Context menu ───────────────────────────────────────────────────────────

/** @type {ReturnType<typeof renderPopover> | null} */
let _browseCtxHandle = null;

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
function showBrowseContextMenu(e, file, container, ctx) {
  e.preventDefault();
  e.stopPropagation();
  dismissBrowseContextMenu();

  /** @type {{ label: string; action?: () => void; danger?: boolean }[]} */
  const items = [
    { label: "Open", action: () => ctx.openFile(file.path) },
    { label: "\u2014" },
    {
      label: "Rename\u2026",
      action: () => browseRenameFile(file, container, ctx),
    },
    {
      label: "Duplicate",
      action: () => browseDuplicateFile(file, container, ctx),
    },
    { label: "\u2014" },
    {
      label: "Delete",
      action: () => browseDeleteFile(file, container, ctx),
      danger: true,
    },
  ];

  let x = e.clientX,
    y = e.clientY;

  _browseCtxHandle = renderPopover(
    html`<sp-popover open style="position:fixed;left:${x}px;top:${y}px">
      <sp-menu>
        ${items.map((item) =>
          item.label === "\u2014"
            ? html`<sp-menu-divider></sp-menu-divider>`
            : html`<sp-menu-item
                style=${item.danger ? "color: var(--danger)" : ""}
                @click=${() => {
                  dismissBrowseContextMenu();
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
        _browseCtxHandle = null;
      },
      layer: "dialog",
    },
  );

  requestAnimationFrame(() => {
    const popover = /** @type {HTMLElement | null} */ (
      _browseCtxHandle?.host.querySelector("sp-popover")
    );
    if (!popover) return;
    const menuRect = popover.getBoundingClientRect();
    if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 4;
    if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 4;
    popover.style.left = `${x}px`;
    popover.style.top = `${y}px`;
  });
}

/**
 * @param {{ name: string; path: string; ext: string }} file
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
async function browseRenameFile(file, container, ctx) {
  const newName = await showRenameDialog(file.name);
  if (!newName || newName === file.name) return;
  const filePath = file.path.replaceAll("\\", "/");
  const parentDir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : ".";
  const newPath = parentDir === "." ? newName : `${parentDir}/${newName}`;
  try {
    const platform = getPlatform();
    await platform.renameFile(file.path, newPath);
    invalidateBrowseCache();
    renderBrowse(container, ctx);
    statusMessage(`Renamed to ${newName}`);
  } catch (/** @type {unknown} */ e) {
    statusMessage(`Error: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * @param {{ name: string; path: string; ext: string }} file
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
async function browseDuplicateFile(file, container, ctx) {
  const filePath = file.path.replaceAll("\\", "/");
  const parentDir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : ".";
  const baseName = file.name.replace(/(\.[^.]+)$/, "");
  const ext = file.ext || "";
  const copyName = `${baseName}-copy${ext}`;
  const copyPath = parentDir === "." ? copyName : `${parentDir}/${copyName}`;
  try {
    const platform = getPlatform();
    const content = await platform.readFile(file.path);
    await platform.writeFile(copyPath, content);
    invalidateBrowseCache();
    renderBrowse(container, ctx);
    statusMessage(`Duplicated as ${copyName}`);
  } catch (/** @type {unknown} */ e) {
    statusMessage(`Error: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * @param {{ name: string; path: string; ext: string }} file
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
async function browseDeleteFile(file, container, ctx) {
  const confirmed = await showDeleteDialog(file.name);
  if (!confirmed) return;
  try {
    const platform = getPlatform();
    await platform.deleteFile(file.path);
    invalidateBrowseCache();
    renderBrowse(container, ctx);
    statusMessage(`Deleted ${file.name}`);
  } catch (/** @type {unknown} */ e) {
    statusMessage(`Error: ${/** @type {Error} */ (e).message}`);
  }
}

// ─── Spectrum dialogs ───────────────────────────────────────────────────────

/**
 * @param {string} currentName
 * @returns {Promise<string | null>}
 */
function showRenameDialog(currentName) {
  let value = currentName;

  return showDialog((done) => {
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
          value=${value}
          @input=${(/** @type {Event} */ e) => {
            value = /** @type {HTMLInputElement} */ (e.target).value || "";
          }}
          @keydown=${(/** @type {KeyboardEvent} */ e) => {
            if (e.key === "Enter") confirm();
          }}
        ></sp-textfield>
      </sp-dialog-wrapper>
    `;

    requestAnimationFrame(() => {
      const layer = document.getElementById("layer-dialog");
      const tf = /** @type {HTMLElement | null} */ (layer?.querySelector("sp-textfield"));
      if (tf) {
        tf.focus();
        const input = tf.shadowRoot?.querySelector("input");
        if (input) input.select();
      }
    });

    return tpl;
  });
}

/**
 * @param {string} fileName
 * @returns {Promise<boolean>}
 */
function showDeleteDialog(fileName) {
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

/** @type {Map<string, HTMLElement>} */
const _previewCache = new Map();

/**
 * Render a live preview for a page or layout file (JSON or Markdown).
 *
 * @param {string} filePath
 * @returns {Promise<HTMLElement | null>}
 */
async function renderDocPreview(filePath) {
  try {
    const platform = getPlatform();
    const content = await platform.readFile(filePath);
    setSkipServerFunctions(true);
    let doc;
    if (filePath.endsWith(".md")) {
      const result = await loadMarkdown(content);
      doc = result.document;
    } else {
      doc = JSON.parse(content);
    }
    const scope = buildScope(doc.state || {});
    const el = renderNode(doc, scope);
    return /** @type {HTMLElement | null} */ (el);
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
async function loadPreview(el, file) {
  // Already populated
  if (el.firstElementChild) return;

  /** @type {HTMLElement | undefined} */
  let preview = _previewCache.get(file.path);
  if (!preview) {
    try {
      const comp = componentRegistry.find(
        (/** @type {ComponentEntry} */ c) => c.path === file.path,
      );
      if (comp) {
        preview = /** @type {HTMLElement | undefined} */ (await renderComponentPreview(comp));
      } else {
        preview = /** @type {HTMLElement | undefined} */ (await renderDocPreview(file.path)) ||
        undefined;
      }
      if (preview) _previewCache.set(file.path, /** @type {HTMLElement} */ (preview));
    } catch {
      return;
    }
  }
  if (preview) el.appendChild(preview);
}

/**
 * Render a single grid card.
 *
 * @param {{ name: string; path: string; type: string; category: string; ext: string }} file
 * @param {HTMLElement} container
 * @param {{ openFile: (path: string) => void }} ctx
 */
function renderCard(file, container, ctx) {
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
      @contextmenu=${(/** @type {MouseEvent} */ e) =>
        showBrowseContextMenu(e, file, container, ctx)}
    >
      <div
        class="element-card-preview"
        ${needsPreview
          ? ref((/** @type {Element | undefined} */ el) => {
              if (el) loadPreview(el, file);
            })
          : nothing}
      >
        ${isImg
          ? html`<img
              src="/${file.path}"
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
export async function renderBrowse(container, ctx) {
  // Re-load when projectDirs changed (e.g. project opened after initial render)
  const currentKey = (projectState?.projectDirs || []).join(",");
  if ((!fileCache.length && !loading) || currentKey !== lastProjectDirsKey) {
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
              renderBrowse(container, ctx);
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
      @input=${(/** @type {Event} */ e) => {
        searchQuery = /** @type {HTMLInputElement} */ (e.target).value;
        renderBrowse(container, ctx);
      }}
      @submit=${(/** @type {Event} */ e) => e.preventDefault()}
    ></sp-search>
    <overlay-trigger placement="bottom-start" triggered-by="click">
      <sp-action-button size="s" slot="trigger">
        <sp-icon-add slot="icon"></sp-icon-add> New
      </sp-action-button>
      <sp-popover slot="click-content" tip>
        <sp-menu
          @change=${(/** @type {Event} */ e) =>
            handleNewEntity(/** @type {HTMLSelectElement} */ (e.target).value, container, ctx)}
        >
          ${ENTITY_TYPES.map((t) => html`<sp-menu-item value=${t.key}>${t.label}</sp-menu-item>`)}
          ${contentTypeTypes.length
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
        const input = /** @type {HTMLInputElement} */ (
          container.querySelector(".browse-upload-input")
        );
        if (input) input.click();
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
      @change=${(/** @type {Event} */ e) => {
        const input = /** @type {HTMLInputElement} */ (e.target);
        if (input.files?.length) handleUpload(input.files, container, ctx);
        input.value = "";
      }}
    />
    <div class="browse-view-switcher">
      <sp-action-button
        size="s"
        ?selected=${viewMode === "grid"}
        @click=${() => {
          viewMode = "grid";
          renderBrowse(container, ctx);
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
          renderBrowse(container, ctx);
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
                  @contextmenu=${(/** @type {MouseEvent} */ e) =>
                    showBrowseContextMenu(e, f, container, ctx)}
                >
                  <sp-table-cell class="browse-name-cell"
                    >${isImage(f.ext)
                      ? html`<img class="browse-thumb" src="/${f.path}" />`
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
      @dragover=${(/** @type {DragEvent} */ e) => {
        e.preventDefault();
        /** @type {HTMLElement} */ (e.currentTarget).classList.add("browse-drop-active");
      }}
      @dragleave=${(/** @type {DragEvent} */ e) => {
        /** @type {HTMLElement} */ (e.currentTarget).classList.remove("browse-drop-active");
      }}
      @drop=${(/** @type {DragEvent} */ e) => {
        e.preventDefault();
        /** @type {HTMLElement} */ (e.currentTarget).classList.remove("browse-drop-active");
        const droppedFiles = e.dataTransfer?.files;
        if (droppedFiles?.length) handleUpload(droppedFiles, container, ctx);
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
