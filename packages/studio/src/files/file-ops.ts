/// <reference lib="dom" />
/**
 * File Operations — open, save, export documents.
 *
 * All functions read/write directly from/to `activeTab.value` (the reactive tab).
 */

import { unified } from "unified";
import remarkStringify from "remark-stringify";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import { stringify as stringifyYaml } from "yaml";
import { jxToMd, jxDocToMd } from "../markdown/md-convert";
import { locateDocument } from "../services/code-services";
import { statusMessage } from "../panels/statusbar";
import { getPlatform } from "../platform";
import { activeTab, openTab } from "../workspace/workspace";
import { isEditing, stopEditing } from "../editor/inline-edit";

import type { JxElement, JxMutableNode } from "@jxsuite/schema/types";

/** Open a file via the File System Access API (or fallback input). */
export async function openFile() {
  try {
    if ("showOpenFilePicker" in window) {
      const [handle] = await (
        window as unknown as { showOpenFilePicker: Function }
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
  } catch (e) {
    if ((e as Error).name !== "AbortError") statusMessage(`Error: ${(e as Error).message}`);
  }
}

/**
 * Parse a markdown string into document + frontmatter (pure — no side effects).
 *
 * @param {string} source Markdown text
 * @returns {Promise<{ document: JxMutableNode; frontmatter: Record<string, unknown> }>}
 */
export async function loadMarkdown(source: string) {
  const { transpileJxMarkdown } = await import("@jxsuite/parser/transpile");
  const doc = transpileJxMarkdown(source) as JxMutableNode;

  const isComponent = doc.tagName && String(doc.tagName).includes("-");

  if (isComponent) {
    return { document: doc, frontmatter: {} };
  }

  // Content markdown — children form the root-level document body
  const children = doc.children ?? [];
  if (children.length === 0) children.push({ tagName: "p", children: [] });

  const documentKeys = new Set(["state", "imports"]);
  const contentDoc: Record<string, unknown> = { children };

  const frontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === "children") continue;
    if (documentKeys.has(key)) {
      contentDoc[key] = value;
    } else {
      frontmatter[key] = value;
    }
  }

  return { document: contentDoc, frontmatter };
}

/** Save the current document back to its source location. */
export async function saveFile() {
  if (isEditing()) stopEditing();
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
  } catch (e) {
    if ((e as Error).name !== "AbortError") statusMessage(`Save error: ${(e as Error).message}`);
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
      const handle = await (
        window as unknown as { showSaveFilePicker: Function }
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
  } catch (e) {
    if ((e as Error).name !== "AbortError") statusMessage(`Export error: ${(e as Error).message}`);
  }
}

/**
 * Serialize the current document to its output format (JSON or Markdown).
 *
 * @param {import("../tabs/tab.js").Tab} tab
 * @returns {string}
 */
export function serializeDocument(tab: import("../tabs/tab.js").Tab) {
  if (tab.doc.sourceFormat === "md") {
    const fm = tab.doc.content?.frontmatter || {};
    const doc = tab.doc.document;
    const fullDoc = { ...fm, ...doc, children: doc.children ?? [] };
    return jxDocToMd(/** @type {JxMutableNode} */ (fullDoc));
  }
  if (tab.doc.mode === "content") {
    const mdast = jxToMd(tab.doc.document as JxElement);
    const md = unified()
      .use(remarkGfm)
      .use(remarkDirective)
      .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*" })
      .stringify(mdast as unknown as import("mdast").Root);
    const fm = tab.doc.content?.frontmatter;
    const hasFrontmatter = fm && Object.keys(fm).length > 0;
    return hasFrontmatter ? `---\n${stringifyYaml(fm).trim()}\n---\n\n${md}` : md;
  }
  return JSON.stringify(tab.doc.document, null, 2);
}
