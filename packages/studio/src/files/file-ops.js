/**
 * File Operations — open, save, export documents.
 *
 * All functions read/write directly from/to `activeTab.value` (the reactive tab).
 */

import { unified } from "unified";
import remarkStringify from "remark-stringify";
import remarkDirective from "remark-directive";
import { stringify as stringifyYaml } from "yaml";
import { jxToMd, jxDocToMd } from "../markdown/md-convert.js";
import { locateDocument } from "../services/code-services.js";
import { statusMessage } from "../panels/statusbar.js";
import { getPlatform } from "../platform.js";
import { activeTab, openTab } from "../workspace/workspace.js";

/** Open a file via the File System Access API (or fallback input). */
export async function openFile() {
  try {
    if ("showOpenFilePicker" in window) {
      const [handle] = await /** @type {{ showOpenFilePicker: Function }} */ (
        /** @type {unknown} */ (window)
      ).showOpenFilePicker({
        types: [
          { description: "Jx Component", accept: { "application/json": [".json"] } },
          { description: "Markdown Content", accept: { "text/markdown": [".md"] } },
        ],
      });
      const file = await handle.getFile();
      const text = await file.text();
      const documentPath = await locateDocument(handle.name);

      if (handle.name.endsWith(".md")) {
        const { document, frontmatter } = await loadMarkdown(text);
        openTab({
          id: handle.name,
          documentPath,
          fileHandle: handle,
          document,
          frontmatter,
          sourceFormat: "md",
        });
      } else {
        const document = JSON.parse(text);
        openTab({ id: handle.name, documentPath, fileHandle: handle, document });
      }

      statusMessage(`Opened ${handle.name}`);
    } else {
      // Fallback: file input
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,.md";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const text = await file.text();

        if (file.name.endsWith(".md")) {
          const { document, frontmatter } = await loadMarkdown(text);
          openTab({ id: file.name, document, frontmatter, sourceFormat: "md" });
        } else {
          const document = JSON.parse(text);
          openTab({ id: file.name, document });
        }

        statusMessage(`Opened ${file.name}`);
      };
      input.click();
    }
  } catch (/** @type {unknown} */ e) {
    if (/** @type {Error} */ (e).name !== "AbortError")
      statusMessage(`Error: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Parse a markdown string into document + frontmatter (pure — no side effects).
 *
 * @param {string} source Markdown text
 * @returns {Promise<{ document: JxMutableNode; frontmatter: Record<string, unknown> }>}
 */
export async function loadMarkdown(source) {
  const { transpileJxMarkdown } = await import("@jxsuite/parser/transpile");
  const doc = /** @type {JxMutableNode} */ (transpileJxMarkdown(source));

  const isComponent = doc.tagName && String(doc.tagName).includes("-");

  if (isComponent) {
    return { document: doc, frontmatter: {} };
  }

  // Content markdown — children form the root-level document body
  const contentDoc = { children: doc.children ?? [] };

  /** @type {Record<string, unknown>} */
  const frontmatter = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key !== "children") frontmatter[key] = value;
  }

  return { document: contentDoc, frontmatter };
}

/** Save the current document back to its source location. */
export async function saveFile() {
  const tab = activeTab.value;
  if (!tab) return;
  try {
    const output = serializeDocument(tab);

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
         */ (tab.fileHandle).createWritable();
      await writable.write(output);
      await writable.close();
      tab.doc.dirty = false;
      statusMessage("Saved");
    } else {
      statusMessage("No save target — use Export");
    }
  } catch (/** @type {unknown} */ e) {
    if (/** @type {Error} */ (e).name !== "AbortError")
      statusMessage(`Save error: ${/** @type {Error} */ (e).message}`);
  }
}

/** Export the current document to a new location (Save As / download). */
export async function exportFile() {
  const tab = activeTab.value;
  if (!tab) return;
  try {
    const isContent = tab.doc.mode === "content";
    const output = serializeDocument(tab);
    const mimeType = isContent ? "text/markdown" : "application/json";
    const ext = isContent ? ".md" : ".json";
    const description = isContent ? "Markdown Content" : "Jx Component";

    if ("showSaveFilePicker" in window) {
      const suggestedName = tab.documentPath
        ? tab.documentPath.split("/").pop()
        : isContent
          ? "content.md"
          : "component.json";
      const handle = await /** @type {{ showSaveFilePicker: Function }} */ (
        /** @type {unknown} */ (window)
      ).showSaveFilePicker({
        suggestedName,
        types: [{ description, accept: { [mimeType]: [ext] } }],
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
      a.download = isContent ? "content.md" : "component.json";
      a.click();
      URL.revokeObjectURL(url);
      tab.doc.dirty = false;
      statusMessage("Downloaded");
    }
  } catch (/** @type {unknown} */ e) {
    if (/** @type {Error} */ (e).name !== "AbortError")
      statusMessage(`Export error: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Serialize the current document to its output format (JSON or Markdown).
 *
 * @param {import("../tabs/tab.js").Tab} tab
 * @returns {string}
 */
export function serializeDocument(tab) {
  if (tab.doc.sourceFormat === "md") {
    const fm = tab.doc.content?.frontmatter || {};
    const fullDoc = { ...fm, children: tab.doc.document.children ?? [] };
    return jxDocToMd(/** @type {JxMutableNode} */ (fullDoc));
  }
  if (tab.doc.mode === "content") {
    const mdast = jxToMd(/** @type {JxElement} */ (tab.doc.document));
    const md = unified()
      .use(remarkDirective)
      .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*" })
      .stringify(/** @type {import("mdast").Root} */ (/** @type {unknown} */ (mdast)));
    const fm = tab.doc.content?.frontmatter;
    const hasFrontmatter = fm && Object.keys(fm).length > 0;
    return hasFrontmatter ? `---\n${stringifyYaml(fm).trim()}\n---\n\n${md}` : md;
  }
  return JSON.stringify(tab.doc.document, null, 2);
}
