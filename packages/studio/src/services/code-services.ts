/** OXC code services (server-backed) */

import { getPlatform } from "../platform";
import { isJsonObject, paramNames } from "@jxsuite/schema/guards";
import { projectState } from "../state";
import { getNodeAtPath } from "../store";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { JxPath } from "../state";
import type { JxFunctionDef, JxMutableNode } from "@jxsuite/schema/types";
import type { editor } from "monaco-editor";

export interface OxLintDiagnostic {
  severity: string;
  message: string;
  help?: string;
  code?: string;
  url?: string;
  labels?: { span: { line: number; column: number; length?: number } }[];
}

/**
 * @param {string} action
 * @param {unknown} payload
 */
export async function codeService(action: string, payload: unknown) {
  const platform = getPlatform();
  if (!platform.codeService) {
    return null;
  }
  return platform.codeService(action, payload);
}

/**
 * Ask the server to locate a document by filename within the project root.
 *
 * @param {string} name
 */
export async function locateDocument(name: string) {
  const platform = getPlatform();
  if (!platform.locateFile) {
    return null;
  }
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
export async function fetchPluginSchema(
  def: { $src?: string; $prototype?: string },
  state: { documentPath?: string },
) {
  const importedPath = def.$prototype
    ? projectState?.projectConfig?.imports?.[def.$prototype]
    : null;
  const src = def.$src || importedPath;
  if (!src || !def.$prototype) {
    return null;
  }
  const cacheKey = `${src}::${def.$prototype}`;
  if (pluginSchemaCache.has(cacheKey)) {
    return pluginSchemaCache.get(cacheKey);
  }

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
 * @param {import("monaco-editor").editor.IStandaloneCodeEditor} editor
 * @param {OxLintDiagnostic[]} diagnostics
 */
export function setLintMarkers(
  editor: editor.IStandaloneCodeEditor,
  diagnostics: OxLintDiagnostic[],
) {
  const model = editor.getModel();
  if (!model) {
    return;
  }
  const markers = diagnostics
    .map((d) => {
      const label = d.labels?.[0];
      if (!label) {
        return null;
      }
      const { line, column, length } = label.span;
      return {
        code: d.url ? { target: monaco.Uri.parse(d.url), value: d.code } : d.code,
        endColumn: column + (length || 1),
        endLineNumber: line,
        message: d.message + (d.help ? `\n${d.help}` : ""),
        severity:
          d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        source: "oxlint",
        startColumn: column,
        startLineNumber: line,
      };
    })
    .filter(Boolean);
  monaco.editor.setModelMarkers(model, "oxlint", markers as editor.IMarkerData[]);
}

/**
 * @param {{ type: string; defName?: string; path?: JxPath; eventKey?: string }} editing
 * @param {JxMutableNode | null | undefined} document
 */
export function getFunctionArgs(
  editing: { type: string; defName?: string; path?: JxPath; eventKey?: string },
  document: JxMutableNode | null | undefined,
): string[] {
  // Read parameters off any object-shaped def (covers legacy entries without $prototype).
  const fromDef = (def: unknown): string[] | null => {
    if (!isJsonObject(def)) {
      return null;
    }
    const params = def.parameters;
    if (!Array.isArray(params) || params.length === 0) {
      return null;
    }
    return paramNames(params as JxFunctionDef["parameters"]);
  };
  if (editing.type === "def") {
    const args = editing.defName ? fromDef(document?.state?.[editing.defName]) : null;
    if (args) {
      return args;
    }
  } else if (editing.type === "event") {
    if (!document || !editing.path) {
      return ["state", "event"];
    }
    const node = getNodeAtPath(document, editing.path);
    const args = node && editing.eventKey ? fromDef(node[editing.eventKey]) : null;
    if (args) {
      return args;
    }
  }
  return ["state", "event"];
}
