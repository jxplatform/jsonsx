/// <reference lib="dom" />
/**
 * Editor panels — extracted from studio.js (Phase 4g). Monaco-based function editor (JS mode) and
 * completion provider for state scope variables.
 */

import type * as monaco from "monaco-editor";
import { loadMonaco } from "../services/monaco-lazy";
import { isJsonObject } from "@jxsuite/schema/guards";
import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";

import { canvasPanels, canvasWrap, getNodeAtPath, renderOnly } from "../store";
import { activeTab } from "../workspace/workspace";
import { mutateUpdateDef, mutateUpdateProperty, transactDoc } from "../tabs/transact";
import { view } from "../view";
import { codeService, getFunctionArgs, setLintMarkers } from "../services/code-services";
import { globalEntries, namedFormulaEntries } from "../ui/formula-catalog";

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
    /** @type {EditingTarget} */ editing as EditingTarget,
    activeTab.value?.doc.document,
  );

  void mountFunctionEditor(editorContainer as unknown as HTMLElement, body, args, editing);
}

/**
 * Create the function-body editor once Monaco has loaded. The container is already in the DOM; a
 * teardown or mode switch during the load is caught by the `view.functionEditor` re-check in
 * `resetCanvasView`, which disposes whatever is current.
 */
async function mountFunctionEditor(
  editorContainer: HTMLElement,
  body: string,
  args: string[],
  editing: unknown,
): Promise<void> {
  const monacoNs = await loadMonaco();
  // Completions used to register at studio startup, which would now await the lazy load and undo it.
  // The editor is the only surface they serve, and the registration is idempotent.
  void registerFunctionCompletions();
  view.functionEditor = monacoNs.editor.create(editorContainer, {
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace",
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
export async function registerFunctionCompletions() {
  if (view._completionRegistered) {
    return;
  }
  view._completionRegistered = true;
  const monacoNs = await loadMonaco();
  monacoNs.languages.registerCompletionItemProvider("javascript", {
    provideCompletionItems(model, position) {
      if (!activeTab.value) {
        return { suggestions: [] };
      }
      const defs = activeTab.value.doc.document?.state || {};
      const word = model.getWordUntilPosition(position);
      const range = {
        endColumn: word.endColumn,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        startLineNumber: position.lineNumber,
      };

      // Named-formula catalog metadata enriches their completions with documentation.
      const formulaDocs = new Map(namedFormulaEntries(defs).map((e) => [e.name, e.description]));

      const suggestions: monaco.languages.CompletionItem[] = Object.entries(defs).map(
        ([key, def]) => {
          let kind = monacoNs.languages.CompletionItemKind.Variable;
          if (
            (def as JxPrototypeDef)?.$prototype === "Function" ||
            (def as Record<string, unknown>)?.$handler ||
            formulaDocs.has(key)
          ) {
            kind = monacoNs.languages.CompletionItemKind.Function;
          } else if ((def as JxPrototypeDef)?.$prototype) {
            kind = monacoNs.languages.CompletionItemKind.Property;
          }
          const item: monaco.languages.CompletionItem = {
            insertText: `state.${key}`,
            kind,
            label: `state.${key}`,
            range,
          };
          const documentation = formulaDocs.get(key);
          if (documentation) {
            item.documentation = documentation;
          }
          return item;
        },
      );

      // Blessed pure globals from the formula catalog (Math.*, JSON.*, Object.*, …).
      for (const entry of globalEntries()) {
        suggestions.push({
          documentation: entry.description,
          insertText: `window.${entry.label}`,
          kind: monacoNs.languages.CompletionItemKind.Function,
          label: entry.label,
          range,
        });
      }
      return { suggestions };
    },
    triggerCharacters: ["."],
  });
}
