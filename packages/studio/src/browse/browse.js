/**
 * Manage view — project-level file browser rendered as a Spectrum table.
 *
 * Displays pages, layouts, components, content, and media in a filterable table grid. Fills the
 * center canvas area as a parallel state to Edit/Design/Preview/Code/Settings. Includes a "New +"
 * button with type-aware entity creation (including content types from project.json).
 */

import { html, render as litRender } from "lit-html";
import { getPlatform } from "../platform.js";
import { projectState } from "../store.js";
import { yamlDefault } from "../settings/schema-field-ui.js";
import { invalidateMediaCache } from "../ui/media-picker.js";

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
        results.push({
          name: entry.name,
          path: entry.path,
          type: ext || "file",
          category: categoryFor(entry.path, ext),
          ext,
        });
      }
    }
  } catch {
    // Directory may not exist or be inaccessible
  }
  return results;
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
    const d = /** @type {any} */ (def);
    yaml += `${field}: ${yamlDefault(d.type, d.format)}\n`;
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
    const d = /** @type {any} */ (def);
    const dir = d.source ? d.source.replace(/^\.\//, "").split("/")[0] : name;
    return {
      key: `contentType:${name}`,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      dir,
      ext: ".md",
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
    <div class="browse-filter-bar">
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
        @input=${(/** @type {any} */ e) => {
          searchQuery = e.target.value;
          renderBrowse(container, ctx);
        }}
        @submit=${(/** @type {Event} */ e) => e.preventDefault()}
      ></sp-search>
      <overlay-trigger placement="bottom-start">
        <sp-action-button size="s" slot="trigger">
          <sp-icon-add slot="icon"></sp-icon-add> New
        </sp-action-button>
        <sp-popover slot="click-content" tip>
          <sp-menu
            @change=${(/** @type {any} */ e) => handleNewEntity(e.target.value, container, ctx)}
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
        @change=${(/** @type {any} */ e) => {
          if (e.target.files?.length) handleUpload(e.target.files, container, ctx);
          e.target.value = "";
        }}
      />
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
          : files.map(
              (f) => html`
                <sp-table-row
                  value=${f.path}
                  class="browse-row"
                  @click=${() => ctx.openFile(f.path)}
                >
                  <sp-table-cell class="browse-name-cell">${f.name}</sp-table-cell>
                  <sp-table-cell>${f.category}</sp-table-cell>
                  <sp-table-cell>${f.ext || "—"}</sp-table-cell>
                  <sp-table-cell class="browse-path-cell">${f.path}</sp-table-cell>
                </sp-table-row>
              `,
            )}
      </sp-table-body>
    </sp-table>
  `;

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
        const files = e.dataTransfer?.files;
        if (files?.length) handleUpload(files, container, ctx);
      }}
    >
      ${filterBar}
      <div class="browse-table">${table}</div>
    </div>
  `;

  litRender(tpl, container);
}

/** Force a data reload on next render (e.g., after file creation/deletion). */
export function invalidateBrowseCache() {
  fileCache = [];
}
