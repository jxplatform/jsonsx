/// <reference lib="dom" />
/**
 * The Media viewer — a pane that SHOWS a file the studio has no document model for.
 *
 * Clicking an image in the Files tree used to end in a toast: `openFileInTab` reads every file as
 * text, finds no format class and no `.json`, and throws — so a PNG produced _"No format class
 * imported for public/hero.jpg — add one to project.json imports"_, advice that means nothing about
 * a binary asset. Video, audio, fonts and PDFs all failed the same way, and so did every tile in
 * the Library, which routes to the same function. There was no way at all to look at an asset the
 * project contains, which is exactly what somebody who has just imported a site needs to do.
 *
 * Almost nothing here is new. `files/media-paths.ts` already computes a src the parent realm can
 * load, `files/media-meta.ts` already holds size, modified time and — once an `<img>` has loaded —
 * pixel dimensions, and `files/media-usage.ts` already answers "which pages use this?" honestly.
 * That last one had, in `site-architecture.md` §9.4's own words, _no reader but the delete
 * confirmation_: you could only learn what an image was used for by trying to remove it. This is
 * the surface that query was waiting for.
 *
 * Read-only, deliberately. Rename, delete and reveal are the file tree's, and a second set of
 * buttons for them here would be a second place to keep them right.
 *
 * @docs studio/projects/media
 */

import { html, nothing, render as litRender } from "lit-html";
import { effect, effectScope } from "../reactivity";
import { paneRegion } from "../ui/regions";
import { mediaSiteUrl, previewFileSrc } from "../files/media-paths";
import { formatBytes, loadMediaMeta, peekMediaMeta, recordImageSize } from "../files/media-meta";
import { extensionOf, mediaKind } from "../files/media-upload";
import { loadMediaUsages, mediaUsageHeadline, peekMediaUsages } from "../files/media-usage";
import type { MediaMeta } from "../files/media-meta";
import type { UsageState } from "../services/references";
import type { Tab } from "../tabs/tab";
import type { CanvasSurface } from "../canvas/canvas-surface";

/** The `canvasMode` the media viewer draws under. */
export const MEDIA_MODE = "media";

/** Extensions the viewer renders as a font specimen rather than as a file it cannot show. */
const FONT_EXTENSIONS = new Set([".woff", ".woff2", ".ttf", ".otf"]);

/** The pangram the font specimen is set in — short, and every letter of the alphabet once. */
const SPECIMEN = "The quick brown fox jumps over the lazy dog";

/** Specimen sizes, largest first: enough to judge a display face and a body face in one look. */
const SPECIMEN_SIZES = [48, 32, 24, 18, 14];

// ─── Mounting ────────────────────────────────────────────────────────────────

interface ActiveMediaPane {
  paneId: string;
  tabId: string;
  wrap: HTMLElement;
  scope: { stop: () => void; run: <T>(fn: () => T) => T | undefined };
}

/**
 * The viewer mounted in each pane, keyed by pane id.
 *
 * Per pane rather than a singleton, for the reason `content/entry-editor.ts` documents: `media` is
 * a kind the side pane may host, so two panes can hold one at once and a shared slot would let the
 * second mount stop the first one's effect scope.
 */
const _active = new Map<string, ActiveMediaPane>();

function activeIn(paneId: string): ActiveMediaPane | null {
  return _active.get(paneId) ?? null;
}

/** Whether this tab's viewer is already mounted in this pane and still in the document. */
export function mediaPaneMounted(paneId: string, tab: Tab): boolean {
  const panel = activeIn(paneId);
  return panel !== null && panel.tabId === tab.id && panel.wrap.isConnected;
}

/** Tear one pane's viewer down (mode change, tab switch, project close). Idempotent. */
export function detachMediaPane(paneId: string): void {
  const panel = _active.get(paneId);
  if (!panel) {
    return;
  }
  panel.scope.stop();
  _active.delete(paneId);
}

// ─── Templates ───────────────────────────────────────────────────────────────

/**
 * The asset itself, in whatever element can show it.
 *
 * A file the browser cannot render is not a failure state — it is a font, or a zip, or a format
 * this build has never heard of — so the fallback says what the file IS rather than apologising.
 */
function assetTpl(path: string, src: string, redraw: () => void) {
  const ext = extensionOf(path);
  const kind = mediaKind({ name: path });

  if (FONT_EXTENSIONS.has(ext)) {
    /* A font is shown by being USED. The @font-face is scoped to a generated family name so two
       specimens open side by side cannot claim the same one. */
    const family = `jx-specimen-${path.replaceAll(/[^a-zA-Z0-9]/g, "-")}`;
    return html`
      <style>
        @font-face {
          font-family: "${family}";
          src: url("${src}");
        }
      </style>
      <div class="media-specimen" style="font-family: '${family}', system-ui, sans-serif">
        ${SPECIMEN_SIZES.map(
          (size) => html`<p class="media-specimen-line" style="font-size: ${size}px">
            ${SPECIMEN}
          </p>`,
        )}
      </div>
    `;
  }

  switch (kind) {
    case "image": {
      return html`<img
        class="media-image"
        src=${src}
        alt=""
        @load=${(e: Event) => {
          const img = e.target as HTMLImageElement;
          /* The only honest source of pixel dimensions in a browser is an image that has loaded,
             and this viewer is showing one at full size anyway. `recordImageSize` reports whether
             the number was new, so a repaint happens once rather than on every load event. */
          if (recordImageSize(path, img.naturalWidth, img.naturalHeight)) {
            redraw();
          }
        }}
      />`;
    }
    case "video": {
      return html`<video class="media-video" src=${src} controls></video>`;
    }
    case "audio": {
      return html`<audio class="media-audio" src=${src} controls></audio>`;
    }
    default: {
      return ext === ".pdf"
        ? html`<embed class="media-embed" src=${src} type="application/pdf" />`
        : html`<div class="media-unviewable">
            <p>Jx has no viewer for <code>${ext || "this file"}</code>.</p>
            <p class="media-note">The file is in the project and builds normally.</p>
          </div>`;
    }
  }
}

/** Kind, dimensions, size and modified time — each omitted rather than zeroed when unknown. */
function factsTpl(path: string, meta: MediaMeta | null) {
  const facts: string[] = [mediaKind({ name: path })];
  if (meta?.width != null && meta.height != null) {
    facts.push(`${meta.width} × ${meta.height}`);
  }
  if (meta?.bytes != null) {
    facts.push(formatBytes(meta.bytes));
  }
  if (meta?.modified) {
    facts.push(`modified ${meta.modified.slice(0, 10)}`);
  }
  return html`<p class="media-facts">${facts.join(" · ")}</p>`;
}

/**
 * The URL a document would reference this file by, with a copy button.
 *
 * The single most useful fact about an asset that is not the asset: `public/hero.jpg` is written
 * `/hero.jpg`, a string that shares not one path segment with the file, and getting it wrong is the
 * commonest way an image ends up missing from a page.
 */
function refTpl(path: string) {
  const ref = mediaSiteUrl(path);
  return html`
    <div class="media-ref">
      <code class="media-ref-value">${ref}</code>
      <sp-action-button
        size="s"
        quiet
        title="Copy the reference"
        @click=${() => {
          void navigator.clipboard?.writeText(ref);
        }}
        >Copy</sp-action-button
      >
    </div>
  `;
}

/** Which documents reference this file, or the honest reason there is no list. */
function usageTpl(usage: UsageState | null) {
  const headline = mediaUsageHeadline(usage);
  if (headline === null) {
    // The host has no reference index. A zero here would be a number nobody can stand behind.
    return nothing;
  }
  const files = usage?.status === "ready" ? usage.result.files : [];
  return html`
    <div class="media-usage">
      <h4 class="media-usage-title">Used by</h4>
      <p class="media-usage-headline">${headline}</p>
      ${
        files.length === 0
          ? nothing
          : html`<ul class="media-usage-list">
              ${files.map(
                (file) => html`<li>
                  <button
                    type="button"
                    class="media-usage-link"
                    @click=${() => {
                      void openDocument(file.path);
                    }}
                  >
                    ${file.path}
                  </button>
                  <span class="media-usage-count">${file.count}</span>
                </li>`,
              )}
            </ul>`
      }
    </div>
  `;
}

/**
 * Open a document that references this file.
 *
 * Dynamic, for the reason `content/entry-editor.ts` gives: `files/files.ts` reaches the platform,
 * the format registry and the packages layer, and a static edge would drag all of it in here.
 */
async function openDocument(path: string): Promise<void> {
  const { openFileInTab } = await import("../files/files");
  await openFileInTab(path);
}

// ─── Render ──────────────────────────────────────────────────────────────────

/**
 * Mount the media viewer into the pane.
 *
 * The same non-iframe-editor pattern as the grid, the Library, Project Settings and the Entry form:
 * it owns its own effect scope from here, so learning an image's dimensions repaints this panel and
 * nothing else.
 *
 * @param {CanvasSurface} surface
 * @param {Tab} tab
 */
export function renderMediaMode(surface: CanvasSurface, tab: Tab): void {
  const { paneId, wrap: canvasWrap } = surface;
  if (mediaPaneMounted(paneId, tab)) {
    return;
  }
  detachMediaPane(paneId);

  const scope = effectScope();
  const panel: ActiveMediaPane = { paneId, scope, tabId: tab.id, wrap: canvasWrap };
  _active.set(paneId, panel);

  const path = tab.documentPath ?? "";

  const redraw = () => {
    if (activeIn(paneId) === panel) {
      draw();
    }
  };

  const draw = () => {
    const meta = peekMediaMeta(path);
    const usage = peekMediaUsages(path);
    /* Asked on the first paint that finds it missing, never on every paint: both loaders cache and
       de-duplicate in flight, and both repaint through `redraw` when they land. */
    if (meta === null) {
      void loadMediaMeta(path).then(redraw);
    }
    if (usage === null || usage.status === "pending") {
      void loadMediaUsages(path).then(redraw);
    }

    litRender(
      html`
        <div class="media-viewer" data-jx-region=${paneRegion(paneId, "media")}>
          <div class="media-stage">${assetTpl(path, previewFileSrc(path), redraw)}</div>
          <div class="media-details">
            <h3 class="media-name">${path.split("/").pop()}</h3>
            ${factsTpl(path, meta)} ${refTpl(path)} ${usageTpl(usage)}
          </div>
        </div>
      `,
      canvasWrap,
    );
  };

  scope.run(() => {
    effect(() => {
      if (activeIn(paneId) !== panel) {
        return;
      }
      /* The tab's path is the whole of what this pane draws from — the file's bytes are the
         browser's problem, and its metadata repaints through `redraw`. Reading it here is what
         makes a rename repaint the viewer rather than leave it pointing at a name that is gone. */
      void tab.documentPath;
      draw();
    });
  });
}
