/// <reference lib="dom" />
/**
 * File Operations — open, save, export documents, and confirm the destructive ones.
 *
 * All functions read/write directly from/to `activeTab.value` (the reactive tab). `.json` is the
 * native document format; every other extension dispatches through the project's format registry
 * (parse to open, serialize to save).
 *
 * {@link confirmFileDelete} and {@link renamePromptMessage} live here because a delete and a rename
 * are the same question asked twice — "what does this break?" — and the answer was missing from
 * both. Every surface that removes or moves a file routes its confirmation through them, so no
 * caller can ship a destructive dialog that grades only by reversibility again.
 *
 * @docs studio/projects/pages-layouts-components
 */

import { html, nothing } from "lit-html";
import { loadUsages, usageWarning } from "../services/references";
import { showConfirmDialog } from "../ui/layers";
import { locateDocument } from "../services/code-services";
import { errorMessage } from "@jxsuite/schema/parse";
import { noteDocumentSaved } from "../panels/statusbar";
import { notify } from "../services/notify";
import { validateComponentSlots } from "../services/cem-export";
import { getPlatform } from "../platform";
import { getGridController } from "../grid/grid-controller";
import { activeTab, openTab } from "../workspace/workspace";
import { collabSave } from "../collab/collab-session";
import { flushCanvasEdits } from "../canvas/iframe-host";
import {
  defaultContentFormat,
  formatByName,
  formatForPath,
  formatParse,
  formatSerialize,
  getFormats,
  loadFormats,
  noFormatError,
  splitFormatDocument,
} from "../format/format-host";
import type { StudioFormat } from "../format/format-host";
import type { Tab } from "../tabs/tab.js";

/**
 * Parse a format-class source string into document + frontmatter + mode per the format's
 * $studio.documentMode hints.
 *
 * @param {StudioFormat} format
 * @param {string} source
 */
export async function parseFormatSource(format: StudioFormat, source: string) {
  const doc = await formatParse(format.name, source);
  return splitFormatDocument(format, doc);
}

/**
 * Parse a source string for a file path, dispatching by extension through the format registry.
 * Returns null for `.json` (native — callers JSON.parse) and throws when no format class claims the
 * extension.
 *
 * @param {string} path
 * @param {string} source
 */
export async function parseSourceForPath(path: string, source: string) {
  await loadFormats();
  const format = formatForPath(path);
  if (!format || !format.capabilities.parse) {
    throw noFormatError(path);
  }
  const result = await parseFormatSource(format, source);
  return { ...result, format };
}

/** Open a file via the File System Access API (or fallback input). */
export async function openFile() {
  try {
    await loadFormats();
    const formats = getFormats();
    const pickerTypes = [
      {
        accept: { "application/json": [".json"] },
        description: "Jx Component",
      },
      ...formats
        .filter((f) => f.capabilities.parse)
        .map((f) => ({
          accept: { [f.mediaType ?? "text/plain"]: f.extensions },
          description: f.name,
        })),
    ];
    const acceptExts = [".json", ...formats.flatMap((f) => f.extensions)].join(",");

    const handleSource = async (
      name: string,
      text: string,
      handle: FileSystemFileHandle | null = null,
    ) => {
      const documentPath = handle ? await locateDocument(name) : null;
      const format = formatForPath(name);
      if (format) {
        const { document, frontmatter } = await parseFormatSource(format, text);
        openTab({
          document,
          documentPath,
          fileHandle: handle,
          frontmatter,
          id: name,
          sourceFormat: format.name,
        });
      } else if (name.endsWith(".json")) {
        const document = JSON.parse(text) as Record<string, unknown>;
        openTab({ document, documentPath, fileHandle: handle, id: name });
      } else {
        throw noFormatError(name);
      }
      // Opening a file is stated permanently by the tab strip and the status bar's DOCUMENT
      // Field; it does not need a message that erases itself.
    };

    if ("showOpenFilePicker" in window) {
      const [handle] = await (
        window as unknown as {
          showOpenFilePicker: (options?: unknown) => Promise<FileSystemFileHandle[]>;
        }
      ).showOpenFilePicker({ types: pickerTypes });
      const file = await handle!.getFile();
      await handleSource(handle!.name, await file.text(), handle!);
    } else {
      // Fallback: file input
      const input = document.createElement("input");
      input.type = "file";
      input.accept = acceptExts;
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) {
          return;
        }
        await handleSource(file.name, await file.text());
      });
      input.click();
    }
  } catch (error) {
    // A cancelled file picker is not a failure — the user withdrew the request.
    if (!(error instanceof Error && error.name === "AbortError")) {
      notify.error("Could not open the file.", {
        detail: errorMessage(error),
        source: "Open File",
      });
    }
  }
}

/**
 * Record a successful write, and raise the slot-validation warning component documents can carry.
 *
 * The success half no longer notifies at ALL. "Saved" is ambient state: the status bar's DOCUMENT
 * field says "Saved 2m ago" for as long as it is true, which is strictly more information than a
 * message that said it once and erased itself — and it is the field a reader looks at to ask the
 * question in the first place.
 *
 * The warning half became a PROBLEM. A component whose slots do not line up is a thing to fix, and
 * it was previously shown for six seconds in the same grey as the word "Saved".
 */
function reportSaved(tab: Tab) {
  noteDocumentSaved(tab.documentPath);
  const doc = tab.doc.document;
  const warning =
    typeof doc.tagName === "string" && doc.tagName.includes("-")
      ? validateComponentSlots(doc)
      : null;
  if (warning) {
    notify.warn(warning, {
      key: `slots:${tab.documentPath ?? tab.id}`,
      ...(tab.documentPath === null ? {} : { path: tab.documentPath }),
      source: "Components",
      tier: "problem",
    });
  }
}

/** Save the current document back to its source location. */
export async function saveFile() {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  // Text reaches the document on an idle tick, so the words still sitting in the caret's block have
  // To be committed before anything serializes it. This used to be `if (isEditing()) stopEditing()`,
  // Which was dead: editing lives in the canvas IFRAME, and `isEditing()` here reads the parent
  // Realm's copy of that module, where a session never starts. Saving mid-sentence silently wrote
  // The file without the sentence.
  await flushCanvasEdits(tab.id);
  // Grid tabs batch-save through their controller (per-source commit semantics, not a doc write).
  const grid = getGridController(tab);
  if (grid) {
    await grid.save();
    return;
  }
  try {
    // A co-edited tab persists through its provider (a direct file write would reset the room).
    if (await collabSave(tab)) {
      reportSaved(tab);
      return;
    }
    const output = await serializeDocument(tab);

    if (tab.documentPath) {
      const platform = getPlatform();
      await platform.writeFile(tab.documentPath, output);
      tab.doc.dirty = false;
      reportSaved(tab);
    } else if (tab.fileHandle && "createWritable" in tab.fileHandle) {
      const writable =
        await /**
         * @type {{
         *   createWritable: () => Promise<{
         *     write: (s: string) => Promise<void>;
         *     close: () => Promise<void>;
         *   }>;
         * }}
         */ tab.fileHandle.createWritable();
      await writable.write(output);
      await writable.close();
      tab.doc.dirty = false;
      reportSaved(tab);
    } else {
      notify.warn("This document has no save target — use Export.", { key: "save.noTarget" });
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      notify.error(`Could not save ${tab.documentPath ?? tab.id}.`, {
        action: "file.save",
        detail: errorMessage(error),
        key: `save:${tab.documentPath ?? tab.id}`,
        ...(tab.documentPath === null ? {} : { path: tab.documentPath }),
        source: "Save",
      });
    }
  }
}

/** The output format for a tab: its source format, or the default content format. */
function tabFormat(tab: Tab): StudioFormat | undefined {
  return (
    formatByName(tab.doc.sourceFormat) ??
    (tab.doc.mode === "content" ? defaultContentFormat() : undefined)
  );
}

/** Export the current document to a new location (Save As / download). */
export async function exportFile() {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  try {
    await loadFormats();
    const format = tabFormat(tab);
    const output = await serializeDocument(tab);
    const mimeType = format ? (format.mediaType ?? "text/plain") : "application/json";
    const ext = format ? format.extensions[0] : ".json";
    const description = format ? format.name : "Jx Component";
    const fallbackName = format ? `content${ext}` : "component.json";

    if ("showSaveFilePicker" in window) {
      const suggestedName = tab.documentPath ? tab.documentPath.split("/").pop() : fallbackName;
      const handle = await (
        window as unknown as {
          showSaveFilePicker: (options?: unknown) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker({
        suggestedName,
        types: [{ accept: { [mimeType]: [ext] }, description }],
      });
      const writable = await handle.createWritable();
      await writable.write(output);
      await writable.close();
      tab.doc.dirty = false;
      reportSaved(tab);
      notify.success(`Exported as ${handle.name}.`);
    } else {
      // Fallback: download
      const blob = new Blob([output], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fallbackName;
      a.click();
      URL.revokeObjectURL(url);
      tab.doc.dirty = false;
      reportSaved(tab);
      notify.success(`Downloaded ${fallbackName}.`);
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      notify.error("Could not export the document.", {
        detail: errorMessage(error),
        source: "Export",
      });
    }
  }
}

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

// ─── Destructive confirmations ───────────────────────────────────────────────

/**
 * The reference sentence a destructive dialog carries, or `nothing` when the host cannot count.
 *
 * The query is awaited BEFORE the dialog opens rather than rendered into it and filled in later: a
 * confirm button that becomes truthful two frames after the user has already pressed it is the same
 * defect as not counting at all.
 *
 * @param path — the file about to be deleted or renamed.
 * @param verb — which way the references go. A rename repairs them; a delete breaks them.
 */
async function usageLine(path: string, verb: "delete" | "rename") {
  const sentence = usageWarning(await loadUsages({ path }), verb);
  return sentence === null ? nothing : html`<p class="dialog-consequence">${sentence}</p>`;
}

/**
 * Confirm deleting a file, stating what it breaks and what survives.
 *
 * @param file — its display name and project-relative path.
 * @returns Whether the user confirmed.
 */
export async function confirmFileDelete(file: { name: string; path: string }): Promise<boolean> {
  const consequence = await usageLine(file.path, "delete");
  // `showDialog`'s generic widens to unknown through the confirm wrapper; the dialog only ever
  // Resolves true/false, and Boolean() is the narrowing that says so without a cast.
  return Boolean(
    await showConfirmDialog(
      "Delete File",
      html`<span>Delete <strong>${file.name}</strong>? This cannot be undone.</span>${consequence}`,
      { confirmLabel: "Delete", destructive: true },
    ),
  );
}

/**
 * The explanatory copy above a rename field — where the file's references go when it moves.
 *
 * A rename is not a delete and must not read like one: the refactor pass rewrites every reference
 * it finds, so the honest sentence is "N references will be updated automatically", and the count
 * is there to say how much work is silently being done on the user's behalf.
 *
 * @param path — the file about to be renamed.
 */
export async function renamePromptMessage(path: string) {
  const consequence = await usageLine(path, "rename");
  return consequence === nothing ? undefined : html`${consequence}`;
}
