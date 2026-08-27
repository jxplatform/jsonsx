/**
 * A tab's document, as the bytes a file would hold.
 *
 * Its own module because four callers need it and one of them is `file-ops` itself: the save path
 * writes what this returns, the source view shows it, the collab layer publishes it, and the live
 * preview overlay sends it. Leaving it in `file-ops` meant the overlay had to import the module
 * that imports the overlay, and the collab layer had already worked around the same shape by
 * injecting the function at boot. One home resolves both.
 *
 * That every one of them goes through this function is the point rather than an accident: what a
 * reader sees in a preview, what a peer sees in a session and what lands on disk are the same
 * bytes, so they cannot drift.
 */

import { getGridController } from "../grid/grid-controller";
import {
  defaultContentFormat,
  formatByName,
  formatSerialize,
  loadFormats,
} from "../format/format-host";
import type { Tab } from "../tabs/tab";

/**
 * Serialize the current document to its output format. Format tabs round-trip through the format
 * class's serialize capability; everything else is native JSON.
 *
 * @param {import("../tabs/tab.js").Tab} tab
 * @returns {Promise<string>}
 */
export async function serializeDocument(tab: Tab): Promise<string> {
  // Grid tabs serialize through their source (pending edits included) — e.g. the Monaco source
  // View of a CSV grid tab shows the live file text.
  const grid = getGridController(tab);
  const gridText = grid?.serializeForSource();
  if (gridText) {
    return gridText;
  }
  await loadFormats();
  const sourceFormat = formatByName(tab.doc.sourceFormat);
  if (sourceFormat?.capabilities.serialize) {
    const fm = tab.doc.content?.frontmatter || {};
    const doc = tab.doc.document;
    const fullDoc = { ...fm, ...doc, children: doc.children ?? [] };
    return formatSerialize(sourceFormat.name, fullDoc, { mode: "roundtrip" });
  }
  if (tab.doc.mode === "content") {
    const format = defaultContentFormat();
    if (format) {
      const fm = tab.doc.content?.frontmatter ?? {};
      const hasFrontmatter = Object.keys(fm).length > 0;
      const fullDoc = { ...fm, ...tab.doc.document };
      return formatSerialize(format.name, fullDoc, {
        frontmatter: hasFrontmatter,
        mode: "roundtrip",
      });
    }
  }
  return JSON.stringify(tab.doc.document, null, 2);
}
