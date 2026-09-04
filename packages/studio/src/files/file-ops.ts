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
import { isMediaFile } from "./media-upload";
import { loadMediaUsages } from "./media-usage";
import { showConfirmDialog } from "../ui/layers";
import { locateDocument } from "../services/code-services";
import { errorMessage } from "@jxsuite/schema/parse";
import { noteDocumentSaved } from "../panels/statusbar";
import { notify } from "../services/notify";
import { validateComponentSlots } from "../services/cem-export";
import { reportPopoverProblems } from "../services/popover-report";
import { getPlatform } from "../platform";
import { getGridController } from "../grid/grid-controller";
import { activeTab, openTab } from "../workspace/workspace";
import { collabReadOnly, collabSave } from "../collab/collab-session";
import { flushCanvasEdits } from "../canvas/iframe-host";
import { flushPreviewOverlay } from "../preview/preview-overlay";
import { serializeDocument } from "./serialize-document";
import {
  defaultContentFormat,
  formatByName,
  formatForPath,
  formatParse,
  getFormats,
  loadFormats,
  noFormatError,
  splitFormatDocument,
} from "../format/format-host";
import type { StudioFormat } from "../format/format-host";
import type { Tab } from "../tabs/tab.js";
import { mediaTypeEssence } from "@jxsuite/schema/media-type";

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
          // The essence, not the declared type: a File System Access `accept` key is a bare
          // MIME type, and `text/markdown; variant=GFM` is not one.
          accept: { [mediaTypeEssence(f.mediaType) ?? "text/plain"]: f.extensions },
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
/**
 * Who else wants to know that a document reached disk.
 *
 * **By injection**, the idiom `setSurfaceTeardown` and `setDiffRepaint` already use. The one
 * listener today is source control: a comparison is two texts read once, so it does not notice a
 * save on its own, and the file an author is most likely to save is the one they are reviewing. A
 * direct import would put `panels/git-panel.ts` into this module's graph, which is a load error for
 * every suite that mocks the canvas host out from under it.
 */
let _onDocumentSaved: (path: string | null) => void = () => {};

/** Register the save listener. Called once, from the bootstrap. */
export function setDocumentSavedListener(listener: (path: string | null) => void): void {
  _onDocumentSaved = listener;
}

function reportSaved(tab: Tab) {
  noteDocumentSaved(tab.documentPath);
  _onDocumentSaved(tab.documentPath);
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
  /* Popover correctness, beside the slot check and for the same reason it is here: a successful
     save is the one chokepoint every edit passes through, whichever surface made it. A render-time
     lint would be the alternative and is the wrong shape — there is no render-lint pipeline, and a
     record re-filed every frame is exactly the noise `NotifyOptions.key` exists to prevent. */
  reportPopoverProblems(doc, tab.documentPath ?? undefined);
}

/**
 * Whether this tab holds a document {@link serializeDocument} can honestly produce bytes for.
 *
 * A media tab does not. `openMediaTab` gives it a STUB — `{ children: [], tagName: "div" }` — because
 * the tab model wants A DOCUMENT and a PNG is not one, and the viewer never reads it. Nothing
 * downstream knew that: `file.save` is gated on `documentOpen` alone (`commands/defaults.ts`), a media
 * tab satisfies it, and `serializeDocument`'s tail is `JSON.stringify(tab.doc.document)`. So the whole
 * of the ordinary save path ran and wrote `{"children":[],"tagName":"div"}` OVER the image, through
 * `writeFile`, with no dirty flag, no confirmation and nothing to undo. The bytes were simply gone.
 *
 * **Keyed on the FILE, not on the mode**, because the mode is not the hazard. An `.svg` in its
 * `source` alternate has the same stub behind it — `canvas-render.ts`'s `sourceContent` falls through
 * to the same `JSON.stringify` when no format class claims the path — so a guard reading
 * `canvasMode === "media"` would have left the one media type that offers a text editor still able to
 * overwrite itself with a placeholder it never showed anyone.
 */
function hasSerializableDocument(tab: Tab): boolean {
  return !isMediaFile(tab.documentPath ?? "");
}

/**
 * Save a document back to its source location. Defaults to the focused tab.
 *
 * Two things here are for the tab strip's Save-on-close, and both are what a caller that must
 * decide something afterwards needs:
 *
 * - `tab` is a PARAMETER. The × on a tab closes that tab, focused or not, and reading
 *   `activeTab.value` would have saved a different document than the one being closed.
 * - The return value says whether the work reached disk. Every failure in here is reported to the
 *   user and swallowed, which is right for ⌘S and useless to a caller that would otherwise close
 *   the tab on top of the failure.
 *
 * **A read-only collaborator has no save target, and that is a refusal rather than a fallback.**
 * Their edits never reached the Y-doc, so there is nothing for the provider to flush; and the local
 * file is the ROOM's file, so writing it here would fork the shared document behind the owner's
 * back. Both "saved" and "written anyway" are wrong answers, so the answer is `false` with the
 * reason said out loud.
 *
 * @returns Whether the document was persisted.
 */
export async function saveFile(tab: Tab | null = activeTab.value): Promise<boolean> {
  if (!tab) {
    return false;
  }
  // Text reaches the document on an idle tick, so the words still sitting in the caret's block have
  // To be committed before anything serializes it. This used to be `if (isEditing()) stopEditing()`,
  // Which was dead: editing lives in the canvas IFRAME, and `isEditing()` here reads the parent
  // Realm's copy of that module, where a session never starts. Saving mid-sentence silently wrote
  // The file without the sentence.
  await flushCanvasEdits(tab.id);
  /* THE REFUSAL COMES FIRST, and it used to come second.
     `ensureCollab` attaches a session to every tab with a `documentPath` except `project.json` —
     `.csv` included, and a `.csv` tab is exactly the kind `grid-panel.ts` provisions a controller
     for. So a read-only collaborator on a co-edited sheet took the grid branch above this line,
     `grid.save()` wrote the ROOM's file to disk behind the owner's back, and `!tab.doc.dirty`
     reported it as a save — the precise outcome the paragraph above says this function prevents.
     A refusal that any earlier branch can step in front of is not a refusal, so nothing may
     precede it except `flushCanvasEdits`, which commits the caret's block and writes nothing. */
  if (collabReadOnly(tab)) {
    notify.warn(
      `You have read access to this session — changes to ${tab.documentPath ?? "this document"} ` +
        `stay in your browser and cannot be saved.`,
      {
        action: "file.save",
        key: `save.readOnly:${tab.documentPath ?? tab.id}`,
        ...(tab.documentPath === null ? {} : { path: tab.documentPath }),
        source: "Collaboration",
      },
    );
    return false;
  }
  /* A media file has no document behind it (see {@link hasSerializableDocument}), and the refusal is
     said out loud rather than returned quietly: a ⌘S that does nothing at all is indistinguishable
     from one that worked. `warn` rather than `error` — nothing is broken and there is nothing to fix;
     the file is simply not the kind of thing Save writes. */
  if (!hasSerializableDocument(tab)) {
    notify.warn(
      `${tab.documentPath ?? "This file"} is a media file, so there is no document for Save to write.`,
      {
        key: `save.notADocument:${tab.documentPath ?? tab.id}`,
        ...(tab.documentPath === null ? {} : { path: tab.documentPath }),
        source: "Save",
      },
    );
    return false;
  }
  // Grid tabs batch-save through their controller (per-source commit semantics, not a doc write).
  const grid = getGridController(tab);
  if (grid) {
    await grid.save();
    // A batch commit keeps failed rows dirty and mirrors that onto the tab, so the buffer's own
    // Verdict is the answer — there is nothing more honest to report here.
    return !tab.doc.dirty;
  }
  try {
    // A co-edited tab persists through its provider (a direct file write would reset the room).
    if (await collabSave(tab)) {
      reportSaved(tab);
      return true;
    }
    const output = await serializeDocument(tab);

    if (tab.documentPath) {
      const platform = getPlatform();
      await platform.writeFile(tab.documentPath, output);
      tab.doc.dirty = false;
      /* Retract the unsaved bytes NOW rather than a debounce later. The write also reaches the
         backend's filesystem watcher, and a live preview coalesces both into one reload only if
         they arrive together — otherwise a save costs two. */
      void flushPreviewOverlay();
      reportSaved(tab);
      return true;
    }
    if (tab.fileHandle && "createWritable" in tab.fileHandle) {
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
      return true;
    }
    notify.warn("This document has no save target — use Export.", { key: "save.noTarget" });
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
  return false;
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
    const mimeType = format
      ? (mediaTypeEssence(format.mediaType) ?? "text/plain")
      : "application/json";
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

// ─── Destructive confirmations ───────────────────────────────────────────────

/**
 * The reference sentence a destructive dialog carries, or `nothing` when the host cannot count.
 *
 * The query is awaited BEFORE the dialog opens rather than rendered into it and filled in later: a
 * confirm button that becomes truthful two frames after the user has already pressed it is the same
 * defect as not counting at all.
 *
 * **A media file is asked about through the media index, and that is not a refinement.** The
 * generic sweep compares each authored reference's RESOLVED path to the path it was asked about,
 * and a media file's authored ref usually resolves somewhere else: `public/hero.jpg` is written
 * `/hero.jpg` and resolves to `hero.jpg`; an asset inside a collection whose `source` is not
 * already `content/<type>/` is addressed at its asset mount and resolves under that prefix. Asking
 * the generic index about the file on disk returns a confident zero for both, which is the one
 * answer a delete dialog must never invent. `media-usage.ts` asks every authored form and unions
 * the answers — and reports **unknown** when a lane cannot be counted, rather than totalling the
 * lanes that could.
 *
 * @param path — the file about to be deleted or renamed.
 * @param verb — which way the references go. A rename repairs them; a delete breaks them.
 */
async function usageLine(path: string, verb: "delete" | "rename" | "convert") {
  const state = isMediaFile(path) ? await loadMediaUsages(path) : await loadUsages({ path });
  const sentence = usageWarning(state, verb);
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
 * @param verb — `"rename"`, or `"convert"` when the bytes change with the name.
 */
export async function renamePromptMessage(path: string, verb: "rename" | "convert" = "rename") {
  const consequence = await usageLine(path, verb);
  return consequence === nothing ? undefined : html`${consequence}`;
}
