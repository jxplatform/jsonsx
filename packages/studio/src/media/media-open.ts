/**
 * Open a media file in the viewer.
 *
 * The shape of `grid/grid-open.ts`'s `openCsvGridTab`, and for the same reason: a real file tab
 * keyed by its path, with a stub document, because the tab model wants A DOCUMENT and this file is
 * not one. The viewer never reads it — it reads `tab.documentPath` and shows the bytes at that path
 * through an `<img>`, a `<video>` or a font specimen.
 *
 * `.svg` gets a `source` mode beside the viewer: it is the one media format that is also text, and
 * hand-editing one is an ordinary thing to want.
 *
 * The modes are set HERE rather than in `tabs/tab.ts`'s `inferModes`, which is the same division
 * CSV already lives under: `inferModes` answers for DOCUMENTS, from the format registry, and an
 * opener answers for the files that are not documents. Every media tab is created through this
 * function — `openFileInTab` routes to it, and session restore goes through `openFileInTab` — so
 * there is no path by which one is built without them.
 *
 * @docs studio/projects/media
 */

import { activateTab, openTab, workspace } from "../workspace/workspace";
import { extensionOf, isMediaFile } from "../files/media-upload";
import { MEDIA_MODE } from "./media-pane";
import type { Tab } from "../tabs/tab";

/** Placeholder document for a media tab — the viewer never reads it, and there is nothing to save. */
const MEDIA_STUB_DOCUMENT = { children: [], tagName: "div" };

/** Whether this path opens in the media viewer rather than through a document parse. */
export function isViewableMedia(path: string): boolean {
  return isMediaFile(path);
}

/** The modes a media tab offers. SVG is also text, so it keeps a source alternate. */
export function mediaTabModes(path: string): string[] {
  return extensionOf(path) === ".svg" ? [MEDIA_MODE, "source"] : [MEDIA_MODE];
}

/**
 * Open (or activate) a media file's viewer tab.
 *
 * @param {string} path - Project-relative path of the file
 * @returns {Tab}
 */
export function openMediaTab(path: string): Tab {
  const existing = workspace.tabs.get(path);
  if (existing) {
    activateTab(path);
    return existing;
  }
  return openTab({
    capabilities: { modes: mediaTabModes(path) },
    document: structuredClone(MEDIA_STUB_DOCUMENT),
    documentPath: path,
    id: path,
    sourceFormat: null,
  });
}
