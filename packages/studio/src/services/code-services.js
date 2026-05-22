/** OXC code services (server-backed) */

import { getPlatform } from "../platform.js";
import { getNodeAtPath } from "../store.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

/**
 * @param {any} action
 * @param {any} payload
 */
export async function codeService(action, payload) {
  const platform = getPlatform();
  if (!platform.codeService) return null;
  return platform.codeService(action, payload);
}

/**
 * Ask the server to locate a document by filename within the project root.
 *
 * @param {any} name
 */
export async function locateDocument(name) {
  const platform = getPlatform();
  if (!platform.locateFile) return null;
  return platform.locateFile(name);
}

/** Cache of plugin schemas keyed by "$src::$prototype". */
export const pluginSchemaCache = new Map();

/**
 * Fetch and cache the schema for an external $prototype + $src module via the server.
 *
 * @param {any} def
 * @param {any} state
 */
export async function fetchPluginSchema(def, state) {
  if (!def.$src || !def.$prototype) return null;
  const cacheKey = `${def.$src}::${def.$prototype}`;
  if (pluginSchemaCache.has(cacheKey)) return pluginSchemaCache.get(cacheKey);

  try {
    const platform = getPlatform();
    if (!platform.fetchPluginSchema) {
      pluginSchemaCache.set(cacheKey, null);
      return null;
    }
    const base = state.documentPath ? `${location.origin}/${state.documentPath}` : undefined;
    const schema = await platform.fetchPluginSchema(def.$src, def.$prototype, base);
    pluginSchemaCache.set(cacheKey, schema);
    return schema;
  } catch {
    pluginSchemaCache.set(cacheKey, null);
    return null;
  }
}

/**
 * @param {any} editor
 * @param {any[]} diagnostics
 */
export function setLintMarkers(editor, diagnostics) {
  const model = editor.getModel();
  if (!model) return;
  const markers = diagnostics
    .map((d) => {
      const label = d.labels?.[0];
      if (!label) return null;
      const { line, column, length } = label.span;
      return {
        severity:
          d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        message: d.message + (d.help ? `\n${d.help}` : ""),
        startLineNumber: line,
        startColumn: column,
        endLineNumber: line,
        endColumn: column + (length || 1),
        code: d.url ? { value: d.code, target: monaco.Uri.parse(d.url) } : d.code,
        source: "oxlint",
      };
    })
    .filter(Boolean);
  monaco.editor.setModelMarkers(model, "oxlint", /** @type {any} */ (markers));
}

/**
 * @param {any} editing
 * @param {any} document
 */
export function getFunctionArgs(editing, document) {
  if (editing.type === "def") {
    return document?.state?.[editing.defName]?.parameters || ["state", "event"];
  } else if (editing.type === "event") {
    const node = getNodeAtPath(document, editing.path);
    return node?.[editing.eventKey]?.parameters || ["state", "event"];
  }
  return ["state", "event"];
}
