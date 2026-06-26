/// <reference lib="dom" />
/**
 * Editor panels — extracted from studio.js (Phase 4g). Monaco-based function editor (JS mode) and
 * completion provider for state scope variables.
 */

import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { isJsonObject } from "@jxsuite/schema/guards";
import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";

import { canvasPanels, canvasWrap, getNodeAtPath, renderOnly } from "../store";
import { activeTab } from "../workspace/workspace";
import { mutateUpdateDef, mutateUpdateProperty, transactDoc } from "../tabs/transact";
import { view } from "../view";
import { codeService, getFunctionArgs, setLintMarkers } from "../services/code-services";

import type { OxLintDiagnostic } from "../services/code-services";
import type { JxMutableNode, JxPrototypeDef } from "@jxsuite/schema/types";
import type { JxPath } from "../state";

type EditingTarget =
  | { type: "def"; defName: string }
  | { type: "event"; path: JxPath; eventKey: string };

/** @param {EditingTarget | null | undefined} editing */
function getFunctionBody(editing: EditingTarget | null | undefined) {
  const document = activeTab.value?.doc.document;
  // Read body off any object-shaped def (covers legacy entries without $prototype).
  const bodyOf = (def: unknown) =>
    isJsonObject(def) && typeof def.body === "string" ? def.body : "";
  if (editing?.type === "def") {
    return bodyOf(document?.state?.[editing.defName]);
  } else if (editing?.type === "event") {
    const node = getNodeAtPath(document!, editing.path);
    return node ? bodyOf(node[editing.eventKey]) : "";
  }
  return "";
}

export function renderFunctionEditor() {
  const editing = activeTab.value?.session.ui.editingFunction as EditingTarget | null | undefined;

  // If editor already exists and matches current target, just sync value
  if (view.functionEditor && view.functionEditor._editingTarget === JSON.stringify(editing)) {
    const body = getFunctionBody(editing);
    const currentVal = view.functionEditor.getValue();
    if (currentVal !== body) {
      view.functionEditor._ignoreNextChange = true;
      view.functionEditor.setValue(body);
    }
    return;
  }

  // Dispose previous editors
  if (view.functionEditor) {
    view.functionEditor.dispose();
    view.functionEditor = null;
  }
  if (view.monacoEditor) {
    view.monacoEditor.dispose();
    view.monacoEditor = null;
  }

  // Clean up canvas DnD and event handlers
  for (const fn of view.canvasDndCleanups) {
    fn();
  }
  view.canvasDndCleanups = [];
  for (const fn of view.canvasEventCleanups) {
    fn();
  }
  view.canvasEventCleanups = [];
  canvasPanels.length = 0;

  litRender(nothing, canvasWrap);
  canvasWrap.style.padding = "0";
  canvasWrap.style.flexDirection = "column";
  canvasWrap.style.alignItems = "stretch";

  // The tab bar renders the Back button + breadcrumb context for the function editor.
  let editorContainer: HTMLDivElement | null = null;
  litRender(
    html`<div class="source-wrap">
      <div
        class="source-editor"
        ${ref((el) => {
          if (el) {
            editorContainer = el as HTMLDivElement;
          }
        })}
      ></div>
    </div>`,
    canvasWrap,
  );

  const body = getFunctionBody(editing);
  const args = getFunctionArgs(
    editing as EditingTarget as EditingTarget,
    activeTab.value?.doc.document,
  );

  view.functionEditor = monaco.editor.create(editorContainer as unknown as HTMLElement, {
    automaticLayout: true,
    fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
    fontSize: 12,
    language: "javascript",
    lineNumbers: "on",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    tabSize: 2,
    theme: "vs-dark",
    value: body,
    wordWrap: "on",
  });
  view.functionEditor._editingTarget = JSON.stringify(editing);
  const editor = view.functionEditor;

  // Format on open — show pretty-printed code, then run initial lint
  void codeService("format", { args, code: body }).then((result) => {
    if (result?.code != null && view.functionEditor) {
      view.functionEditor._ignoreNextChange = true;
      view.functionEditor.setValue(result.code);
    }
  });
  void codeService("lint", { args, code: body }).then((result) => {
    if (result?.diagnostics && view.functionEditor) {
      setLintMarkers(view.functionEditor, result.diagnostics as OxLintDiagnostic[]);
    }
  });

  // Debounced sync back to state + lint on edit
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let syncDebounce: ReturnType<typeof setTimeout> | undefined;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let lintDebounce: ReturnType<typeof setTimeout> | undefined;
  let lintGen = 0;
  editor.onDidChangeModelContent(() => {
    if (editor._ignoreNextChange) {
      editor._ignoreNextChange = false;
      return;
    }

    clearTimeout(syncDebounce);
    syncDebounce = setTimeout(() => {
      const newBody = editor.getValue();
      const target = editing as EditingTarget;
      if (target.type === "def") {
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, target.defName, { body: newBody }));
      } else if (target.type === "event") {
        const node = getNodeAtPath(activeTab.value?.doc.document as JxMutableNode, target.path);
        const current = node?.[target.eventKey] || {};
        transactDoc(activeTab.value, (t) =>
          mutateUpdateProperty(t, target.path, target.eventKey, {
            ...current,
            $prototype: "Function",
            body: newBody,
          }),
        );
      }
      renderOnly("leftPanel");
    }, 500);

    clearTimeout(lintDebounce);
    lintDebounce = setTimeout(() => {
      const gen = (lintGen += 1);
      const currentCode = editor.getValue();
      void codeService("lint", { args, code: currentCode }).then((result) => {
        if (gen !== lintGen) {
          return;
        }
        if (result?.diagnostics && view.functionEditor) {
          setLintMarkers(view.functionEditor, result.diagnostics as OxLintDiagnostic[]);
        }
      });
    }, 750);
  });
}

// Register Monaco JS completion provider for state scope variables (once)
export function registerFunctionCompletions() {
  if (view._completionRegistered) {
    return;
  }
  view._completionRegistered = true;
  monaco.languages.registerCompletionItemProvider("javascript", {
    provideCompletionItems(model, position) {
      const defs = activeTab.value?.doc.document?.state || {};
      const word = model.getWordUntilPosition(position);
      const range = {
        endColumn: word.endColumn,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        startLineNumber: position.lineNumber,
      };

      const suggestions = Object.entries(defs).map(([key, def]) => {
        let kind = monaco.languages.CompletionItemKind.Variable;
        if (
          (def as JxPrototypeDef)?.$prototype === "Function" ||
          (def as Record<string, unknown>)?.$handler
        ) {
          kind = monaco.languages.CompletionItemKind.Function;
        } else if ((def as JxPrototypeDef)?.$prototype) {
          kind = monaco.languages.CompletionItemKind.Property;
        }
        return {
          insertText: `state.${key}`,
          kind,
          label: `state.${key}`,
          range,
        };
      });
      return { suggestions };
    },
    triggerCharacters: ["."],
  });
}
