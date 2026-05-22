/**
 * Editor panels — extracted from studio.js (Phase 4g). Monaco-based function editor (JS mode) and
 * completion provider for state scope variables.
 */

import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";

import { renderOnly, canvasWrap, canvasPanels, getNodeAtPath } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { transactDoc, mutateUpdateDef, mutateUpdateProperty } from "../tabs/transact.js";
import { view } from "../view.js";
import { codeService, setLintMarkers, getFunctionArgs } from "../services/code-services.js";

function getFunctionBody(/** @type {any} */ editing) {
  const document = activeTab.value?.doc.document;
  if (editing.type === "def") {
    return document?.state?.[editing.defName]?.body || "";
  } else if (editing.type === "event") {
    const node = getNodeAtPath(document, editing.path);
    return node?.[editing.eventKey]?.body || "";
  }
  return "";
}

export function renderFunctionEditor() {
  const editing = activeTab.value?.session.ui.editingFunction;

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
  for (const fn of view.canvasDndCleanups) fn();
  view.canvasDndCleanups = [];
  for (const fn of view.canvasEventCleanups) fn();
  view.canvasEventCleanups = [];
  canvasPanels.length = 0;

  litRender(nothing, canvasWrap);
  canvasWrap.style.padding = "0";
  canvasWrap.style.flexDirection = "column";
  canvasWrap.style.alignItems = "stretch";

  // Toolbar breadcrumb handles context display — re-render it
  renderOnly("toolbar");

  // Editor container
  /** @type {HTMLDivElement | null} */
  let editorContainer = null;
  litRender(
    html`<div class="source-wrap">
      <div
        class="source-editor"
        ${ref((el) => {
          if (el) editorContainer = /** @type {HTMLDivElement} */ (el);
        })}
      ></div>
    </div>`,
    canvasWrap,
  );

  const body = getFunctionBody(editing);
  const args = getFunctionArgs(editing, activeTab.value?.doc.document);

  view.functionEditor = monaco.editor.create(/** @type {any} */ (editorContainer), {
    value: body,
    language: "javascript",
    theme: "vs-dark",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 12,
    fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    wordWrap: "on",
    tabSize: 2,
  });
  view.functionEditor._editingTarget = JSON.stringify(editing);

  // Format on open — show pretty-printed code, then run initial lint
  codeService("format", { code: body, args }).then((result) => {
    if (result?.code != null && view.functionEditor) {
      view.functionEditor._ignoreNextChange = true;
      view.functionEditor.setValue(result.code);
    }
  });
  codeService("lint", { code: body, args }).then((result) => {
    if (result?.diagnostics && view.functionEditor)
      setLintMarkers(view.functionEditor, result.diagnostics);
  });

  // Debounced sync back to state + lint on edit
  /** @type {any} */
  let syncDebounce;
  /** @type {any} */
  let lintDebounce;
  let lintGen = 0;
  view.functionEditor.onDidChangeModelContent(() => {
    if (view.functionEditor._ignoreNextChange) {
      view.functionEditor._ignoreNextChange = false;
      return;
    }

    clearTimeout(syncDebounce);
    syncDebounce = setTimeout(() => {
      const newBody = view.functionEditor.getValue();
      const ed = /** @type {any} */ (editing);
      if (ed.type === "def") {
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, ed.defName, { body: newBody }));
      } else if (ed.type === "event") {
        const node = getNodeAtPath(activeTab.value?.doc.document, ed.path);
        const current = node?.[ed.eventKey] || {};
        transactDoc(activeTab.value, (t) =>
          mutateUpdateProperty(t, ed.path, ed.eventKey, {
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
      const gen = ++lintGen;
      const currentCode = view.functionEditor.getValue();
      codeService("lint", { code: currentCode, args }).then((result) => {
        if (gen !== lintGen) return;
        if (result?.diagnostics && view.functionEditor)
          setLintMarkers(view.functionEditor, result.diagnostics);
      });
    }, 750);
  });
}

// Register Monaco JS completion provider for state scope variables (once)
export function registerFunctionCompletions() {
  if (view._completionRegistered) return;
  view._completionRegistered = true;
  monaco.languages.registerCompletionItemProvider("javascript", {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const defs = activeTab.value?.doc.document?.state || {};
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions = Object.entries(defs).map(([key, def]) => {
        let kind = monaco.languages.CompletionItemKind.Variable;
        if (
          /** @type {any} */ (def)?.$prototype === "Function" ||
          /** @type {any} */ (def)?.$handler
        )
          kind = monaco.languages.CompletionItemKind.Function;
        else if (/** @type {any} */ (def)?.$prototype)
          kind = monaco.languages.CompletionItemKind.Property;
        return {
          label: `state.${key}`,
          kind,
          insertText: `state.${key}`,
          range,
        };
      });
      return { suggestions };
    },
  });
}
