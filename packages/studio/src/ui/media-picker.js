/**
 * Media Picker — combobox-style widget for selecting project media files.
 *
 * Shows an editable text input for manual URL entry combined with a dropdown of available media
 * files from the project's public/ directory, with thumbnail previews for images.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { getPlatform } from "../platform.js";
import { debouncedStyleCommit } from "../store.js";

// ─── Media file cache ────────────────────────────────────────────────────────

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

const MEDIA_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".pdf",
]);

/** @type {{ path: string; name: string; isImage: boolean }[]} */
let mediaCache = [];
let mediaCacheLoaded = false;

/**
 * Recursively collect media files from a directory.
 *
 * @param {string} dir
 * @param {ReturnType<typeof getPlatform>} platform
 * @returns {Promise<{ path: string; name: string; isImage: boolean }[]>}
 */
async function collectMedia(dir, platform) {
  /** @type {{ path: string; name: string; isImage: boolean }[]} */
  const results = [];
  try {
    const entries = await platform.listDirectory(dir);
    for (const entry of entries) {
      if (entry.type === "directory") {
        const sub = await collectMedia(entry.path, platform);
        results.push(...sub);
      } else {
        const dot = entry.name.lastIndexOf(".");
        const ext = dot > 0 ? entry.name.slice(dot).toLowerCase() : "";
        if (MEDIA_EXTENSIONS.has(ext)) {
          results.push({
            path: `/${entry.path}`,
            name: entry.name,
            isImage: IMAGE_EXTENSIONS.has(ext),
          });
        }
      }
    }
  } catch {
    // Directory may not exist
  }
  return results;
}

async function loadMediaCache() {
  if (mediaCacheLoaded) return;
  const platform = getPlatform();
  mediaCache = await collectMedia("public", platform);
  // Strip "public/" prefix so paths match production (public/ contents served at root)
  for (const m of mediaCache) {
    m.path = m.path.replace(/^\/public\//, "/");
  }
  mediaCacheLoaded = true;
}

/** Force media cache reload (e.g. after upload). */
export function invalidateMediaCache() {
  mediaCache = [];
  mediaCacheLoaded = false;
}

// ─── Render ──────────────────────────────────────────────────────────────────

/**
 * Render the media picker widget for src-type attributes.
 *
 * @param {string} prop — attribute name (e.g. "src")
 * @param {any} value — current attribute value
 * @param {(val: any) => void} onCommit — commit callback
 * @returns {any}
 */
export function renderMediaPicker(prop, value, onCommit) {
  // Kick off async load (won't block render)
  loadMediaCache();

  const currentValue = value || "";
  const isImage = IMAGE_EXTENSIONS.has(
    currentValue.slice(currentValue.lastIndexOf(".")).toLowerCase(),
  );

  // Filter media options based on current input
  const query = currentValue.toLowerCase();
  const filtered = query
    ? mediaCache.filter(
        (m) => m.path.toLowerCase().includes(query) || m.name.toLowerCase().includes(query),
      )
    : mediaCache;

  // Limit displayed options
  const options = filtered.slice(0, 20);

  return html`
    <div class="media-picker">
      ${isImage && currentValue
        ? html`<img class="media-picker-thumb" src=${currentValue} alt="" />`
        : nothing}
      <sp-textfield
        size="s"
        placeholder="/image.jpg"
        .value=${live(currentValue)}
        @input=${debouncedStyleCommit(`media:${prop}`, 400, (/** @type {any} */ e) =>
          onCommit(e.target.value),
        )}
        @focus=${() => loadMediaCache()}
      ></sp-textfield>
      ${mediaCache.length > 0
        ? html`
            <overlay-trigger placement="bottom-end" triggered-by="click">
              <sp-action-button size="xs" quiet slot="trigger" title="Browse media">
                <sp-icon-image slot="icon"></sp-icon-image>
              </sp-action-button>
              <sp-popover slot="click-content" class="media-picker-popover">
                <sp-menu
                  @change=${(/** @type {any} */ e) => {
                    onCommit(e.target.value);
                  }}
                >
                  ${options.map(
                    (m) => html`
                      <sp-menu-item value=${m.path}>
                        ${m.isImage
                          ? html`<img
                              slot="icon"
                              src=${m.path}
                              alt=""
                              style="width:24px;height:24px;object-fit:cover;border-radius:2px"
                            />`
                          : nothing}
                        ${m.name}
                      </sp-menu-item>
                    `,
                  )}
                  ${filtered.length > 20
                    ? html`<sp-menu-item disabled>...${filtered.length - 20} more</sp-menu-item>`
                    : nothing}
                </sp-menu>
              </sp-popover>
            </overlay-trigger>
          `
        : nothing}
    </div>
  `;
}
