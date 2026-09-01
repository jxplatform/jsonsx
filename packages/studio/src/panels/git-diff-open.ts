/**
 * Open a changed file as a comparison, whatever kind of file it is.
 *
 * The shape of `media/media-open.ts` and `grid/grid-open.ts`, and for the same reason those exist:
 * a real file tab keyed by its path, with a stub document, because the tab model wants A DOCUMENT
 * and a changed `.ts` is not one. The diff stage never reads it — it reads the two texts
 * `readGitDiff` returns and renders them, or hands them to Monaco.
 *
 * **The modes are set HERE rather than in `tabs/tab.ts`'s `inferModes`**, which is the division
 * media and CSV already live under: `inferModes` answers for DOCUMENTS, from the format registry,
 * and an opener answers for the files that are not.
 *
 * **A renderable document gets no new tab.** It opens or activates the ordinary path-keyed tab it
 * would have had anyway and takes `git-diff` as a mode, so §14.1 holds by construction: one path,
 * one tab, one document. Only a file that could not otherwise open at all gets a stub tab, and for
 * such a path there is no competing tab to collide with.
 *
 * **`openFileInTab` is deliberately NOT routed here.** Clicking `src/foo.ts` in the file tree still
 * says Studio has no editor for it, which is the truth about opening it as a document; only the
 * Source Control panel, asking the narrower question "show me what changed", gets a diff tab.
 * Widening the tree would drag the Library and session restore in with it.
 */

import { activateTab, openTab, workspace } from "../workspace/workspace";
import { formatForPath } from "../format/format-host";
import { isViewableMedia } from "../media/media-open";
import type { Tab } from "../tabs/tab";

/**
 * Placeholder document for a diff-only tab — the stage never reads it, and there is nothing to
 * save.
 */
const DIFF_STUB_DOCUMENT = { children: [], tagName: "div" };

/** `.json` files that configure a project rather than being documents of it. */
const NON_DOCUMENT_JSON = new Set([
  "bunfig.json",
  "jsconfig.json",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "wrangler.json",
]);

/**
 * Whether this path has a visual half: a document the canvas can draw from its text.
 *
 * The same test `onFileClick` used to REFUSE on, inverted into a decision about which view to open
 * in. A file with no format class and no `.json` extension is not undiffable; it is un-renderable,
 * and its comparison belongs in the Code view.
 */
export function canRenderComparison(path: string): boolean {
  /* NOT EVERY `.json` IS A DOCUMENT, and the visual half is meaningless for the ones that are not.
     `package.json`, `tsconfig.json` and the generated schema files are all `.json` and none of them
     has a `tagName`; offered a Visual view they draw whatever the runtime makes of an object with
     no tag, and the change map reports every top-level key as "document settings changed" — which
     is how a dependency bump came to be described as a settings change. */
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (NON_DOCUMENT_JSON.has(name) || name.endsWith(".schema.json")) {
    return false;
  }
  return path.endsWith(".json") || Boolean(formatForPath(path));
}

/**
 * Why this file's change cannot be opened as a comparison, or null when it can.
 *
 * Two refusals, and both are stated rather than silent — the whole complaint this work answers was
 * a panel whose rows did nothing when clicked.
 *
 * - **A rename** carries only its new path in `GitFileStatus`, so the old name is not in hand and
 *   there is nothing to compare against. Shown as a whole-file rewrite it would be a lie.
 * - **A binary file** has no text on either side. `readFile` would hand Monaco bytes to render as
 *   mojibake, and the visual half cannot parse a PNG into a document either. An image comparison is
 *   a real feature and a different one; this is the boundary, said out loud.
 *
 * @param {string} path
 * @param {string} fileStatus
 * @returns {string | null}
 */
export function comparisonRefusal(path: string, fileStatus: string): string | null {
  /* ABOVE THE PROJECT ROOT. `git status` reports paths relative to the cwd, so a project nested in
     a larger repository legitimately lists files outside itself — `../bun.lock`, a sibling package.
     Those are real changes and the panel is right to show them, but a comparison cannot be built:
     the server refuses a `..` in a git path outright, which is a traversal guard worth keeping.
     Refused here by name, rather than as a failed read after the click. */
  if (path.startsWith("../") || path.includes("/../")) {
    return `"${path}" is outside this project, so its comparison belongs to the project that owns it.`;
  }
  if (fileStatus === "R") {
    return `A renamed file's comparison needs both paths, and Studio does not model the old name yet.`;
  }
  if (isViewableMedia(path)) {
    return `"${path}" is an image or media file, and a comparison of one is not text.`;
  }
  return null;
}

/** The modes a diff-only tab offers. Exactly one: there is nothing else to do with the file here. */
export function diffTabModes(): string[] {
  return ["git-diff"];
}

/**
 * Open (or activate) a stub comparison tab for a file the canvas cannot render.
 *
 * @param {string} path - Project-relative path of the changed file
 * @returns {Tab}
 */
export function openDiffTab(path: string): Tab {
  const existing = workspace.tabs.get(path);
  if (existing) {
    activateTab(path);
    return existing;
  }
  return openTab({
    capabilities: { modes: diffTabModes() },
    document: structuredClone(DIFF_STUB_DOCUMENT),
    documentPath: path,
    id: path,
    sourceFormat: null,
  });
}

/**
 * THE tab a comparison belongs in, whatever kind of file it is over.
 *
 * One function because there is one rule, and the Source Control panel should not be the place it
 * is spelled out: a file the canvas can draw gets its ordinary document tab, so the author can
 * leave the comparison for Design without reopening anything; a file it cannot gets the stub tab
 * above. Both are keyed by the path, so §14.1 holds either way — one path, one tab.
 *
 * `files/files.ts` is imported dynamically because it imports `cleanupGitPanel` from
 * `panels/git-panel.ts`, which imports this module: a static edge back would close that cycle.
 * `openFileInTab` answers `void` when it reveals a tab that was already open, so the tab is
 * resolved from the workspace either way.
 *
 * Answers null when the file could not be opened at all, which the caller states rather than
 * silently leaving the stage on someone else's document.
 */
export async function openComparisonTab(path: string): Promise<Tab | null> {
  if (!canRenderComparison(path)) {
    return openDiffTab(path);
  }
  const files = await import("../files/files");
  const opened = await files.openFileInTab(path, {});
  return opened ?? [...workspace.tabs.values()].find((tab) => tab.documentPath === path) ?? null;
}
