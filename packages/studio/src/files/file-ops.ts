/// <reference lib="dom" />
/**
 * File Operations — open, save, export documents.
 *
 * All functions read/write directly from/to `activeTab.value` (the reactive tab). `.json` is the
 * native document format; every other extension dispatches through the project's format registry
 * (parse to open, serialize to save).
 */

import { locateDocument } from "../services/code-services";
import { errorMessage } from "@jxsuite/schema/parse";
import { statusMessage } from "../panels/statusbar";
import { getPlatform } from "../platform";
import { activeTab, openTab } from "../workspace/workspace";
import { isEditing, stopEditing } from "../editor/inline-edit";
import {
  defaultContentFormat,
  formatByName,
  formatForPath,
  formatParse,
  formatSerialize,
  getFormats,
  loadFormats,
  splitFormatDocument,
} from "../format/format-host";
import type { StudioFormat } from "../format/format-host";

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
    throw new Error(
      `No format class imported for "${path}" — add one to project.json imports ` +
        `(e.g. "Markdown": "@jxsuite/parser/Markdown.class.json")`,
    );
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
      } else {
        const document = JSON.parse(text);
        openTab({ document, documentPath, fileHandle: handle, id: name });
      }
      statusMessage(`Opened ${name}`);
    };

    if ("showOpenFilePicker" in window) {
      const [handle] = await (
        window as unknown as { showOpenFilePicker: Function }
      ).showOpenFilePicker({ types: pickerTypes });
      const file = await handle.getFile();
      await handleSource(handle.name, await file.text(), handle);
    } else {
      // Fallback: file input
      const input = document.createElement("input");
      input.type = "file";
      input.accept = acceptExts;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          return;
        }
        await handleSource(file.name, await file.text());
      };
      input.click();
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      statusMessage(`Error: ${errorMessage(error)}`);
    }
  }
}

/** Save the current document back to its source location. */
export async function saveFile() {
  if (isEditing()) {
    stopEditing();
  }
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  try {
    const output = await serializeDocument(tab);

    if (tab.documentPath) {
      const platform = getPlatform();
      await platform.writeFile(tab.documentPath, output);
      tab.doc.dirty = false;
      statusMessage("Saved");
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
      statusMessage("Saved");
    } else {
      statusMessage("No save target — use Export");
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      statusMessage(`Save error: ${errorMessage(error)}`);
    }
  }
}

/** The output format for a tab: its source format, or the default content format. */
function tabFormat(tab: import("../tabs/tab.js").Tab): StudioFormat | undefined {
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
        window as unknown as { showSaveFilePicker: Function }
      ).showSaveFilePicker({
        suggestedName,
        types: [{ accept: { [mimeType]: [ext] }, description }],
      });
      const writable = await handle.createWritable();
      await writable.write(output);
      await writable.close();
      tab.doc.dirty = false;
      statusMessage(`Exported as ${handle.name}`);
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
      statusMessage("Downloaded");
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      statusMessage(`Export error: ${errorMessage(error)}`);
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
export async function serializeDocument(tab: import("../tabs/tab.js").Tab): Promise<string> {
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
