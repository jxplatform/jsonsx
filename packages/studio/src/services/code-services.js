/** OXC code services (server-backed) */

import { getPlatform } from "../platform.js";
import { projectState } from "../state.js";
import { getNodeAtPath } from "../store.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

/**
 * @param {string} action
 * @param {unknown} payload
 */
export async function codeService(action, payload) {
  const platform = getPlatform();
  if (!platform.codeService) return null;
  return platform.codeService(action, payload);
}

/**
 * Ask the server to locate a document by filename within the project root.
 *
 * @param {string} name
 */
export async function locateDocument(name) {
  const platform = getPlatform();
  if (!platform.locateFile) return null;
  return platform.locateFile(name);
}

/** Cache of plugin schemas keyed by "$src::$prototype". */
export const pluginSchemaCache = new Map();

/**
 * Fetch and cache the schema for a $prototype module via the server. Works for both external
 * prototypes (with $src) and prototypes resolved from project.json imports.
 *
 * @param {{ $src?: string; $prototype?: string }} def
 * @param {{ documentPath?: string }} state
 */
export async function fetchPluginSchema(def, state) {
  const importedPath = def.$prototype
    ? projectState?.projectConfig?.imports?.[def.$prototype]
    : null;
  const src = def.$src || importedPath;
  if (!src || !def.$prototype) return null;
  const cacheKey = `${src}::${def.$prototype}`;
  if (pluginSchemaCache.has(cacheKey)) return pluginSchemaCache.get(cacheKey);

  try {
    const platform = getPlatform();
    if (!platform.fetchPluginSchema) {
      pluginSchemaCache.set(cacheKey, null);
      return null;
    }
    const base =
      !importedPath && state.documentPath ? `${location.origin}/${state.documentPath}` : undefined;
    const schema = await platform.fetchPluginSchema(src, def.$prototype, base);
    pluginSchemaCache.set(cacheKey, schema);
    return schema;
  } catch {
    pluginSchemaCache.set(cacheKey, null);
    return null;
  }
}

/**
 * @typedef {{
 *   severity: string;
 *   message: string;
 *   help?: string;
 *   code?: string;
 *   url?: string;
 *   labels?: { span: { line: number; column: number; length?: number } }[];
 * }} OxLintDiagnostic
 */

/**
 * @param {import("monaco-editor").editor.IStandaloneCodeEditor} editor
 * @param {OxLintDiagnostic[]} diagnostics
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
  monaco.editor.setModelMarkers(
    model,
    "oxlint",
    /** @type {import("monaco-editor").editor.IMarkerData[]} */ (markers),
  );
}

/**
 * @param {{ type: string; defName?: string; path?: JxPath; eventKey?: string }} editing
 * @param {JxMutableNode | null | undefined} document
 */
export function getFunctionArgs(editing, document) {
  if (editing.type === "def") {
    const defName = editing.defName;
    return (defName && document?.state?.[defName]?.parameters) || ["state", "event"];
  } else if (editing.type === "event") {
    if (!document || !editing.path) return ["state", "event"];
    const node = getNodeAtPath(document, editing.path);
    const eventKey = editing.eventKey;
    return (eventKey && node?.[eventKey]?.parameters) || ["state", "event"];
  }
  return ["state", "event"];
}
