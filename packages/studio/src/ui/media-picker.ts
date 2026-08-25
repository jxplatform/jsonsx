/// <reference lib="dom" />
/**
 * Media Picker — combobox-style widget for selecting or uploading project media files.
 *
 * Shows an editable text input for manual URL entry, an Upload button that adds a new file to the
 * project and assigns it, and a Browse dropdown of media already in the project's public/
 * directory, with thumbnail previews for images.
 *
 * **The browse list carries metadata, and it costs nothing.** Size comes from the directory listing
 * the widget already performs to enumerate the files (`seedMediaMeta`), and pixel dimensions come
 * from the thumbnails it already loads (`recordImageSize`) — measuring an image is a decode the
 * `<img>` has finished by the time `load` fires, so the caption is a read of work already done
 * rather than a second fetch per row. What is NOT here is a usage count: `findReferences` sweeps
 * every document in the project per query, and fifty of those to caption a dropdown is the wrong
 * trade. Usage is asked once, about one file, where it changes a decision — the delete confirmation
 * (`files/media-usage.ts`).
 *
 * @docs studio/projects/media
 */

import { html, render as litRender, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { ref } from "lit-html/directives/ref.js";
import { getPlatform } from "../platform";
import { debouncedStyleCommit, renderOnly } from "../store";
import { getLayerSlot, popoverLayerFor } from "./layers";
import type { LayerKind } from "./layers";
import { rectOf } from "../utils/geometry";
import { previewAssetSrc } from "../canvas/asset-refs";
import {
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  UPLOAD_ACCEPT,
  extensionOf,
  uploadAssets,
} from "../files/media-upload";
import {
  invalidateMediaMeta,
  mediaMetaSummary,
  peekMediaMeta,
  recordImageSize,
  seedMediaMeta,
} from "../files/media-meta";
import { mediaSiteUrl, previewFileSrc } from "../files/media-paths";

// ─── Media file cache ────────────────────────────────────────────────────────

/** One browsable media file: the ref a pick writes, and the file that ref names. */
interface MediaEntry {
  /** The value committed to the field — the site URL, which is the authored form. */
  path: string;
  /** Project-relative path on disk, the key everything in `media-meta` is stored under. */
  file: string;
  name: string;
  isImage: boolean;
}

let mediaCache: MediaEntry[] = [];
let mediaCacheLoaded = false;

/**
 * Recursively collect media files from a directory, seeding {@link seedMediaMeta} with the listing
 * on the way past — the size of every row is already in the response that enumerated it.
 */
async function collectMedia(
  dir: string,
  platform: ReturnType<typeof getPlatform>,
): Promise<MediaEntry[]> {
  const results: MediaEntry[] = [];
  try {
    const entries = await platform.listDirectory(dir);
    seedMediaMeta(entries);
    for (const entry of entries) {
      if (entry.type === "directory") {
        const sub = await collectMedia(entry.path, platform);
        results.push(...sub);
      } else {
        const ext = extensionOf(entry.name);
        if (MEDIA_EXTENSIONS.has(ext)) {
          results.push({
            file: entry.path,
            isImage: IMAGE_EXTENSIONS.has(ext),
            name: entry.name,
            // The site URL is what production serves and therefore what a document should say.
            // Media-paths holds the one definition of that mapping.
            path: mediaSiteUrl(entry.path),
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
  if (mediaCacheLoaded) {
    return;
  }
  const platform = getPlatform();
  mediaCache = await collectMedia("public", platform);
  mediaCacheLoaded = true;
  // Re-render the host panels so the browse popover has entries to show once the async listing
  // Resolves. Mirrors loadLayoutEntries()'s renderOnly() in head-panel.
  renderOnly("leftPanel", "rightPanel", "frontmatterPanel");
}

/**
 * Force media cache reload (e.g. after upload).
 *
 * The metadata cache goes with it, and for the same reason: both were derived from a listing that
 * is now out of date, and a size that survives the write it contradicts is worse than no size.
 */
export function invalidateMediaCache() {
  mediaCache = [];
  mediaCacheLoaded = false;
  invalidateMediaMeta();
}

// ─── Popover state ───────────────────────────────────────────────────────────

/** @type {((val: string) => void) | null} */
let _popoverOnCommit: ((val: string) => void) | null = null;

/** @type {HTMLElement | null} */
let _popoverAnchorEl: HTMLElement | null = null;
/**
 * Which layer the open popover is living in.
 *
 * Chosen from the anchor at open time and then REMEMBERED, because `getLayerSlot` keys its slots by
 * `${layer}:${id}`: dismissing through a different layer than the one that opened would clear an
 * empty slot and leave the real popover on screen.
 */
let _popoverLayer: LayerKind = "popover";

/** The open popover's slot — the one place that names the layer and the id together. */
function popoverSlot(): HTMLElement {
  return getLayerSlot(_popoverLayer, "media-picker");
}

/**
 * The popover's z-index, which depends on the company it is keeping.
 *
 * In `#layer-popover` it has the layer to itself and 30 is enough — that is what it has always
 * been, and every panel-hosted picker keeps rendering identically. Sharing a layer with a modal
 * body is different: those declare `z-index: 1000` (`.seo-modal`, `.about-modal`, `.settings-modal`
 * — the house shape), so a picker anchored inside one is a later sibling that still paints beneath
 * it. Beating that number is the whole point of moving layers in the first place.
 */
function popoverZIndex(): number {
  return _popoverLayer === "popover" ? 30 : 1001;
}

/** @type {HTMLInputElement | null} */
let _popoverFilterEl: HTMLInputElement | null = null;

let _popoverFilter = "";

function dismissMediaPickerPopover() {
  _popoverFilter = "";
  _popoverOnCommit = null;
  _popoverAnchorEl = null;
  _popoverFilterEl = null;
  document.removeEventListener("keydown", onPopoverKeydown, true);
  document.removeEventListener("mousedown", onPopoverOutsideClick, true);
  litRender(nothing, popoverSlot());
}

/** @param {KeyboardEvent} e */
function onPopoverKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    dismissMediaPickerPopover();
    e.preventDefault();
    e.stopPropagation();
  }
}

/** @param {MouseEvent} e */
function onPopoverOutsideClick(e: MouseEvent) {
  const host = popoverSlot();
  if (!host.contains(e.target as Node)) {
    dismissMediaPickerPopover();
  }
}

/** A repaint scheduled by a thumbnail that just reported its size, or 0 when none is pending. */
let _sizeRepaint = 0;

/**
 * Fold a loaded thumbnail's intrinsic size into the metadata cache and, if that was news, repaint
 * the popover once so the caption appears.
 *
 * The repaint is coalesced across a whole grid of images landing in the same frame, and it cannot
 * loop: re-rendering recreates the `<img>` elements, whose `load` fires again from cache, and
 * `recordImageSize` returns false the second time because the measurement has not changed.
 */
function noteImageSize(file: string, target: EventTarget | null) {
  const img = target as HTMLImageElement | null;
  if (!img || !recordImageSize(file, img.naturalWidth, img.naturalHeight) || _sizeRepaint !== 0) {
    return;
  }
  _sizeRepaint = requestAnimationFrame(() => {
    _sizeRepaint = 0;
    if (_popoverAnchorEl) {
      renderMediaPickerPopover();
    }
  });
}

function renderMediaPickerPopover() {
  const host = popoverSlot();
  const rect = _popoverAnchorEl ? rectOf(_popoverAnchorEl) : undefined;
  if (!rect) {
    return;
  }

  const query = _popoverFilter.toLowerCase();
  const filtered = query
    ? mediaCache.filter(
        (m) => m.path.toLowerCase().includes(query) || m.name.toLowerCase().includes(query),
      )
    : mediaCache;
  const options = filtered.slice(0, 50);

  // Compute initial position below the anchor
  let { left } = rect;
  let top = rect.bottom + 4;

  // Estimate popover dimensions for viewport clamping before first paint
  const estimatedWidth = 280;
  const estimatedHeight = Math.min(options.length * 36 + 48, 360);

  if (left + estimatedWidth > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - estimatedWidth - 8);
  }
  if (top + estimatedHeight > window.innerHeight - 8) {
    top = Math.max(8, rect.top - estimatedHeight - 4);
  }

  let _popoverEl: HTMLElement | null = null;

  litRender(
    html`
      <sp-popover
        open
        data-jx-region="overlay.menu:media-picker"
        ${ref((el) => {
          _popoverEl = (el as HTMLElement | undefined) || null;
        })}
        style="position:fixed;left:${left}px;top:${top}px;z-index:${popoverZIndex()};max-height:360px;overflow-y:auto;min-width:240px"
      >
        <input
          class="media-picker-filter"
          type="text"
          placeholder="Search images…"
          autocomplete="off"
          style="display:block;width:100%;box-sizing:border-box;padding:6px 10px;border:none;border-bottom:1px solid var(--border, #444);outline:none;font-size:13px;background:transparent;color:inherit"
          ${ref((el) => {
            _popoverFilterEl = (el as HTMLInputElement | null) || null;
          })}
          @input=${(e: Event) => {
            _popoverFilter = (e.target as HTMLInputElement).value;
            renderMediaPickerPopover();
          }}
          @click=${(e: MouseEvent) => e.stopPropagation()}
        />
        <sp-menu
          style="min-width:220px"
          @change=${(e: Event) => {
            _popoverOnCommit?.((e.target as HTMLInputElement).value);
            dismissMediaPickerPopover();
          }}
        >
          ${
            options.length > 0
              ? options.map((m) => {
                  const caption = mediaMetaSummary(peekMediaMeta(m.file));
                  return html`
                    <sp-menu-item value=${m.path}>
                      ${
                        m.isImage
                          ? html`<img
                              slot="icon"
                              src=${previewFileSrc(m.file)}
                              alt=""
                              style="width:24px;height:24px;object-fit:cover;border-radius:var(--spectrum-corner-radius-75, 2px)"
                              @load=${(e: Event) => noteImageSize(m.file, e.target)}
                            />`
                          : nothing
                      }
                      ${m.name}
                      ${caption ? html`<span slot="description">${caption}</span>` : nothing}
                    </sp-menu-item>
                  `;
                })
              : html`<sp-menu-item disabled>No matches</sp-menu-item>`
          }
          ${
            filtered.length > 50
              ? html`<sp-menu-item disabled>…${filtered.length - 50} more</sp-menu-item>`
              : nothing
          }
        </sp-menu>
      </sp-popover>
    `,
    host,
  );

  // Fine-tune position after render using actual measured dimensions
  requestAnimationFrame(() => {
    if (_popoverEl) {
      const popoverRect = rectOf(_popoverEl);
      let adjLeft = popoverRect.left;
      let adjTop = popoverRect.top;
      let needsAdjust = false;

      if (popoverRect.right > window.innerWidth - 4) {
        adjLeft = Math.max(4, window.innerWidth - popoverRect.width - 4);
        needsAdjust = true;
      }
      if (popoverRect.bottom > window.innerHeight - 4) {
        adjTop = Math.max(4, window.innerHeight - popoverRect.height - 4);
        needsAdjust = true;
      }
      if (popoverRect.left < 4) {
        adjLeft = 4;
        needsAdjust = true;
      }
      if (popoverRect.top < 4) {
        adjTop = 4;
        needsAdjust = true;
      }

      if (needsAdjust) {
        _popoverEl.style.left = `${adjLeft}px`;
        _popoverEl.style.top = `${adjTop}px`;
      }
    }

    if (_popoverFilterEl) {
      _popoverFilterEl.focus();
    }
  });
}

/**
 * @param {HTMLElement} anchorEl
 * @param {(val: string) => void} onCommit
 */
function showMediaPickerPopover(anchorEl: HTMLElement, onCommit: (val: string) => void) {
  dismissMediaPickerPopover();
  _popoverOnCommit = onCommit;
  _popoverAnchorEl = anchorEl;
  // Before the first render, so every later `popoverSlot()` agrees with where it was drawn.
  _popoverLayer = popoverLayerFor(anchorEl);
  _popoverFilter = "";
  renderMediaPickerPopover();
  document.addEventListener("keydown", onPopoverKeydown, true);
  requestAnimationFrame(() => {
    document.addEventListener("mousedown", onPopoverOutsideClick, true);
  });
}

// ─── Render ──────────────────────────────────────────────────────────────────

/**
 * Upload files chosen in a media field's file input and assign the first one to the field. Exported
 * for the unit tests — the hidden input is created on demand, so there is no other way to reach
 * it.
 *
 * @param {FileList | File[]} files
 * @param {(val: string) => void} onCommit
 */
export async function uploadAndAssign(
  files: FileList | File[],
  onCommit: (val: string) => void,
): Promise<void> {
  const uploaded = await uploadAssets([...files]);
  const [first] = uploaded;
  if (first) {
    onCommit(first.ref);
  }
}

/**
 * Open the OS file picker for a media field. The input is created per click and discarded after — a
 * persistent hidden input in the template would be recreated by lit on every panel re-render.
 *
 * @param {(val: string) => void} onCommit
 */
function pickAndUpload(onCommit: (val: string) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = UPLOAD_ACCEPT;
  input.addEventListener("change", () => {
    if (input.files?.length) {
      void uploadAndAssign(input.files, onCommit);
    }
  });
  input.click();
}

/**
 * Render the media picker widget for src-type attributes.
 *
 * @param {string} prop — attribute name (e.g. "src")
 * @param {string} value — current attribute value
 * @param {(val: string) => void} onCommit — commit callback
 * @returns {import("lit-html").TemplateResult}
 */
export function renderMediaPicker(prop: string, value: string, onCommit: (val: string) => void) {
  // Kick off async load (won't block render)
  void loadMediaCache();

  const currentValue = value || "";
  const isImage = IMAGE_EXTENSIONS.has(extensionOf(currentValue));

  return html`
    <div class="media-picker">
      ${
        isImage && currentValue
          ? html`<img class="media-picker-thumb" src=${previewAssetSrc(currentValue)} alt="" />`
          : nothing
      }
      <sp-textfield
        size="s"
        placeholder="/image.jpg"
        .value=${live(currentValue)}
        @input=${debouncedStyleCommit(`media:${prop}`, 400, (e: Event) =>
          onCommit((e.target as HTMLInputElement).value),
        )}
        @focus=${() => loadMediaCache()}
      ></sp-textfield>
      <sp-action-button
        class="media-picker-upload"
        size="xs"
        quiet
        title="Upload media"
        @click=${() => pickAndUpload(onCommit)}
      >
        <sp-icon-upload slot="icon"></sp-icon-upload>
      </sp-action-button>
      <!-- No data-jx-region here. The class IS the handle: ui/regions.ts derives
           inspector/field:PROP/browse by finding this button inside the Inspector's own
           [data-prop] row, so the id resolves to one element however many panes are drawing a
           media picker. The stamp claimed an inspector/... id on every picker the app renders,
           including the two the Document Header card draws inside each pane's STAGE. -->
      <sp-action-button
        class="media-picker-browse"
        size="xs"
        quiet
        title="Browse media"
        @click=${(e: MouseEvent) => {
          void loadMediaCache();
          showMediaPickerPopover(e.currentTarget as HTMLElement, onCommit);
        }}
      >
        <sp-icon-image slot="icon"></sp-icon-image>
      </sp-action-button>
    </div>
  `;
}
