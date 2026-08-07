/// <reference lib="dom" />
/**
 * ⑪ · Logic — the formula workspace and the function editor, hosted by the Bottom dock.
 *
 * **What changed, and why it is the whole point.** Both of these surfaces used to TAKE OVER the
 * canvas: `TabUi.editingFormula` (this file) and `TabUi.editingFunction` (`panels/editors.ts`) each
 * cleared `canvasWrap`, dropped every canvas panel and drew themselves over the stage. So the one
 * artefact whose values you are authoring — the page — was the one thing you could not see while
 * authoring them, and the workspace's own data rail existed to paper over it: a frozen snapshot of
 * a scope, shown because the live thing had just been unmounted. Plan §12 P8.5: "no editor hides
 * the page it computes." They are a **tab of the Bottom dock** now (§3.2 ⑪), which sits under the
 * pane grid, so the page renders beside the formula and keeps rendering while you edit it.
 *
 * **A dock tab is not a reparented takeover.** The surface has to work at dock height, so the
 * header is one row, the chip pipeline and the result are single lines, the data rail is a narrow
 * column that scrolls rather than a 280px slab, and every measurement lives in `styles/panels.css`
 * instead of the inline `style=` attributes that kept seventeen `fw-*` classes on
 * `scripts/check-styles.ts`'s orphan list.
 *
 * **One target, two surfaces, one tab.** {@link logicTarget} is the single reader of the two
 * `TabUi` fields, and the function editor wins when both are set — the precedence `tabs/tab.ts` has
 * always documented, now stated in exactly one place. The tab's `when` is that same predicate, so
 * Logic exists only while something is open in it, and `panels/bottom-dock.ts` reveals the dock on
 * that tab when a target appears.
 *
 * **The close is real.** Both surfaces carry one, and closing is the only thing that clears the
 * target — leaving the dock, switching tabs and collapsing the dock all keep your place, because
 * the editor no longer owns a screen it would otherwise be stranded on.
 *
 * Every edit immutably replaces the selected sub-node within the root and writes the WHOLE root
 * node back through `transactDoc` — undo/redo and the canvas patch come free, and because the
 * canvas is still mounted the patch lands in a page you can watch.
 */

import { html } from "lit-html";
import { getEventBinding, isExpressionDef, isJsonObject } from "@jxsuite/schema/guards";

import { shallowRef } from "../reactivity";
import { getNodeAtPath, updateUi } from "../store";
import { activeTab } from "../workspace/workspace";
import { mutateAddDef, mutateUpdateDef, mutateUpdateProperty, transactDoc } from "../tabs/transact";
import { setBottomTab } from "../shell";
import { chipSummary, renderFormulaChips } from "../ui/formula-chips";
import { renderExpressionEditor } from "../ui/expression-editor";
import { applyCatalogPick, formulaCatalog } from "../ui/formula-catalog";
import { openFormulaPalette } from "../ui/formula-palette";
import { livePreviewExpression } from "../services/live-preview";
import { closeFunctionEditor, functionEditorTemplate, syncFunctionEditor } from "./editors";
import { registerPanel } from "./panel-registry";
import { renderEmptyState } from "./empty-state";
import { dataTypeLabel, renderDataTreeTemplate, unwrapSignal } from "./data-explorer";

import {
  argsSchema,
  pathArg,
  pathProperty,
  stringArg,
  stringProperty,
} from "../commands/command-args";

import type { JxNodeValue } from "../tabs/transact";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { PanelBody } from "./panel-registry";
import type { ExpressionPreview } from "../services/preview-eval";
import type { FormulaEditDef, FunctionEditDef, JsonValue } from "../types";
import type { Tab } from "../tabs/tab";
import type { JxStateDefinition } from "@jxsuite/schema/types";
import type { TemplateResult } from "lit-html";

type NodePath = (string | number)[];

/** What the Logic tab is showing: the Monaco function body, or the structured `$expression`. */
export type LogicTarget =
  | { surface: "function"; editing: FunctionEditDef }
  | { surface: "formula"; editing: FormulaEditDef };

/**
 * The Logic tab's target, or `null` when nothing is open in it.
 *
 * The ONE reader of `TabUi.editingFunction` / `TabUi.editingFormula`, and therefore the one place
 * their precedence is decided. Two surfaces used to answer that question separately — the canvas
 * render pipeline by branch order, the pane context bar by an `||` — which is two definition sites
 * for a rule neither of them stated.
 *
 * @param {Tab | null} [tab] The tab to read; defaults to the focused one.
 * @returns {LogicTarget | null}
 */
export function logicTarget(tab: Tab | null = activeTab.value): LogicTarget | null {
  const ui = tab?.session.ui;
  if (!ui) {
    return null;
  }
  if (ui.editingFunction) {
    return { editing: ui.editingFunction as FunctionEditDef, surface: "function" };
  }
  if (ui.editingFormula) {
    return { editing: ui.editingFormula as FormulaEditDef, surface: "formula" };
  }
  return null;
}

/**
 * Put the Logic tab on screen. Idempotent.
 *
 * `setBottomTab` is the shell's own "reveal" — it selects the tab AND opens the dock, for the same
 * reason `setActivityTab` does: "show me the formula" means the formula is on screen when the call
 * returns, not that a tab is selected inside a closed dock.
 */
export function revealLogicPanel(): void {
  setBottomTab("logic");
}

/**
 * Open something in the Logic tab and put it on screen. The one WRITER of the two `TabUi` fields
 * {@link logicTarget} reads, as that is its one reader.
 *
 * **One tab holds one target, so opening either surface clears the other.** `logicTarget` gives the
 * function editor precedence when both are set, which is the right tie-break for a state that
 * should never occur — and every opener used to create it. Four buttons and two commands each set
 * their own field and left the other alone, so "Open in formula workspace" on an `$expression`
 * while a Function body was open was a dead click: the dock went on showing the function, and the
 * target key had not changed so nothing revealed either. Writing both fields here means the fifth
 * opener inherits the rule instead of re-deciding it.
 *
 * **The reveal is the OTHER half, and it is a different event from the dock's.**
 * `panels/bottom-dock.ts` reveals when a target APPEARS or CHANGES, at most once per target — that
 * is what lets you close the dock over an open formula and have it stay closed (§16.3). Neither
 * half can do the other's job: an effect on the target cannot see "the user pressed the button
 * again" (same target, no change, no reveal — the dock stayed shut and the button did nothing), and
 * a gesture cannot cover a target that appears without one. So the gesture says so explicitly, and
 * this is what makes a call to it a gesture.
 *
 * @param {LogicTarget} target The surface to show and what it should be pointed at.
 */
export function openLogicTarget(target: LogicTarget): void {
  updateUi("editingFunction", target.surface === "function" ? target.editing : null);
  updateUi("editingFormula", target.surface === "formula" ? target.editing : null);
  revealLogicPanel();
}

function isExprNode(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value) && typeof value.operator === "string";
}

// ─── Document access ─────────────────────────────────────────────────────────

/** Read the workspace target's current root expression node from the document. */
export function formulaRoot(tab: Tab, editing: FormulaEditDef): Record<string, unknown> | null {
  const { document } = tab.doc;
  if (editing.type === "def" && editing.defName) {
    const def = document?.state?.[editing.defName];
    return isExpressionDef(def) ? (def.$expression as unknown as Record<string, unknown>) : null;
  }
  if (editing.type === "event" && editing.path && editing.eventKey) {
    const node = getNodeAtPath(document, editing.path);
    const binding = node ? getEventBinding(node, editing.eventKey) : undefined;
    return isExpressionDef(binding)
      ? (binding.$expression as unknown as Record<string, unknown>)
      : null;
  }
  return null;
}

/**
 * Resolve a chip selection to its editable node: the deepest expression-node prefix of `path` (head
 * chips target ref/literal operands; stale paths fall back toward the root).
 */
function resolveSelection(
  root: Record<string, unknown>,
  path: NodePath,
): { node: Record<string, unknown>; path: NodePath } {
  let current: unknown = root;
  let node: Record<string, unknown> = root;
  let nodePath: NodePath = [];
  for (const [i, seg] of path.entries()) {
    if (!current || typeof current !== "object") {
      break;
    }
    current = (current as Record<string, unknown>)[seg as keyof typeof current];
    if (isExprNode(current)) {
      node = current;
      nodePath = path.slice(0, i + 1);
    }
  }
  return { node, path: nodePath };
}

/** Immutably replace the value at `path` within `node` (object keys / array indexes). */
function replaceAtPath(node: unknown, path: NodePath, value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const [head, ...rest] = path as [string | number, ...NodePath];
  if (Array.isArray(node)) {
    const copy = [...(node as unknown[])];
    copy[Number(head)] = replaceAtPath(copy[Number(head)], rest, value);
    return copy;
  }
  const base: Record<string, unknown> = isJsonObject(node) ? node : {};
  return { ...base, [head]: replaceAtPath(base[head as string], rest, value) };
}

/** Write the whole updated root node back to the document position (one undo step). */
function writeRoot(tab: Tab, editing: FormulaEditDef, newRoot: unknown) {
  if (editing.type === "def" && editing.defName) {
    const { defName } = editing;
    transactDoc(tab, (t) => mutateUpdateDef(t, defName, { $expression: newRoot as JsonValue }));
  } else if (editing.type === "event" && editing.path && editing.eventKey) {
    const { eventKey, path } = editing;
    transactDoc(tab, (t) =>
      mutateUpdateProperty(t, path, eventKey, { $expression: newRoot } as JxNodeValue),
    );
  }
}

/** Close the workspace — clears `editingFormula`; the Logic tab leaves the strip with it. */
export function closeFormulaWorkspace() {
  updateUi("editingFormula", null);
}

// ─── The Logic tab ───────────────────────────────────────────────────────────

/**
 * The chip selection, keyed by the target it belongs to.
 *
 * Keyed rather than reset, because the reset used to happen INSIDE the render — and a render that
 * writes the state it reads is a reactive loop the moment the surface becomes an effect, which is
 * exactly what hosting it in the dock makes it. A selection whose key no longer matches simply does
 * not apply, so retargeting starts at the root with nothing written.
 */
const _selection = shallowRef<{ tab: Tab | null; key: string; path: NodePath }>({
  key: "",
  path: [],
  tab: null,
});

/**
 * The document position a selection belongs to. Paired with the tab OBJECT, never its id: a tab
 * that was closed and reopened at the same path is a different document, and inheriting a chip
 * selection into it is how you edit the wrong sub-node of a formula that merely looks the same.
 */
function selectionKey(editing: FormulaEditDef): string {
  return JSON.stringify(editing);
}

/**
 * Register the Bottom dock's Logic tab.
 *
 * Defined here and registered from `panels/bottom-dock.ts`, the same way Problems is defined beside
 * its notification store: the dock owns the strip, the surface owns the record.
 */
export function registerLogicPanel(): void {
  registerPanel({
    id: "logic",
    title: "Logic",
    level: "document",
    dock: "bottom",
    icon: "sp-icon-event",
    // No rail button: Logic has no steady state to badge. It exists while a formula or a function
    // Is open and leaves the strip when you close it, which is what `when` says below.
    rail: false,
    when: () => logicTarget() !== null,
    render: (ctx) => logicPanelBody(ctx.rerender),
    afterRender: (_ctx, host) => syncFunctionEditor(host),
  });
}

/**
 * What the Logic tab draws.
 *
 * @param {() => void} rerender The dock's repaint, handed to the live-preview refresh.
 * @returns {PanelBody}
 */
export function logicPanelBody(rerender: () => void): PanelBody {
  const tab = activeTab.value;
  const target = logicTarget(tab);
  if (!tab || !target) {
    return renderEmptyState({
      message: "Open a formula or a function to edit it here, beside the page it computes.",
    });
  }
  return target.surface === "function"
    ? functionPaneTemplate(target.editing)
    : workspaceTemplate(tab, target.editing, rerender);
}

/** The one header both surfaces wear: what is open, what kind it is, its verbs, and the close. */
function logicHeaderTemplate(
  glyph: string,
  name: string,
  kind: string,
  title: string,
  verbs: TemplateResult | null,
  close: () => void,
): TemplateResult {
  return html`
    <div class="fw-header">
      <span class="fw-title" title=${title}>${glyph} ${name}</span>
      <span class="fw-kind">${kind}</span>
      <div class="fw-header-gap"></div>
      ${verbs}
      <sp-action-button
        quiet
        size="s"
        class="fw-close"
        title="Close"
        @click=${() => {
          close();
        }}
      >
        <sp-icon-close slot="icon"></sp-icon-close>
        Close
      </sp-action-button>
    </div>
  `;
}

/** The Monaco function body, at dock height. The editor itself is mounted by `afterRender`. */
function functionPaneTemplate(editing: FunctionEditDef): TemplateResult {
  const name = editing.defName ?? editing.eventKey ?? "?";
  return html`
    <div class="formula-workspace formula-workspace--code">
      ${logicHeaderTemplate(
        "ƒ",
        name,
        editing.type === "def" ? "function body" : "event handler",
        editing.type === "def" ? `state/${name}` : name,
        null,
        () => void closeFunctionEditor(),
      )}
      ${functionEditorTemplate()}
    </div>
  `;
}

function workspaceTemplate(
  tab: Tab,
  editing: FormulaEditDef,
  rerender: () => void,
): TemplateResult {
  const stateEntries = (tab.doc.document?.state ?? {}) as Record<string, JxStateDefinition>;
  const name = (editing.type === "def" ? editing.defName : editing.eventKey) ?? "?";
  const root = formulaRoot(tab, editing);
  const kind = editing.type === "def" ? "state expression" : "event expression";
  const title = editing.type === "def" ? `state/${name}` : name;

  if (!root) {
    return html`
      <div class="formula-workspace">
        ${logicHeaderTemplate("fx", name, kind, title, null, closeFormulaWorkspace)}
        <div class="fw-body">
          ${renderEmptyState({ message: "No expression found at this document position." })}
        </div>
      </div>
    `;
  }

  const { scope } = tab.session.canvas;
  // Live-context evaluation in the canvas iframe with snapshot fallback (M6). The canvas is no
  // Longer unmounted while this surface is open — that is the entire point of the move — so the
  // Live path is the ORDINARY case now rather than the one that never happened. An event target's
  // Element path is the context, so repeater-template formulas bind the first item's $map scope.
  const preview = livePreviewExpression(
    tab,
    `formula:${JSON.stringify(editing)}`,
    root,
    editing.type === "event" ? (editing.path ?? null) : null,
    rerender,
  );
  const stored = _selection.value;
  const key = selectionKey(editing);
  const { node: selected, path: selectedPath } = resolveSelection(
    root,
    stored.tab === tab && stored.key === key ? stored.path : [],
  );
  const write = (next: unknown) => writeRoot(tab, editing, next);
  const writeSelected = (next: unknown) => write(replaceAtPath(root, selectedPath, next));
  const onChipSelect = (path: NodePath) => {
    _selection.value = { key, path, tab };
  };

  const catalogButton = html`
    <sp-action-button
      quiet
      size="s"
      class="fw-browse-catalog"
      title="Browse catalog"
      @click=${(e: Event) =>
        openFormulaPalette({
          anchor: e.currentTarget as HTMLElement,
          entries: formulaCatalog(stateEntries),
          onPick: (entry) =>
            applyCatalogPick(entry, writeSelected, {
              onInsertDef: (defName, def) =>
                transactDoc(activeTab.value, (t) =>
                  mutateAddDef(t, defName, def as Record<string, JsonValue>),
                ),
              stateEntries,
            }),
        })}
    >
      <sp-icon-brackets slot="icon"></sp-icon-brackets>
      Catalog
    </sp-action-button>
  `;

  return html`
    <div class="formula-workspace">
      ${logicHeaderTemplate("fx", name, kind, title, catalogButton, closeFormulaWorkspace)}
      <div class="fw-chips">${renderFormulaChips(root, onChipSelect, { preview })}</div>
      <div class="fw-body">
        <div class="fw-editor">
          <div class="fw-selected">
            Selected:
            <span class="fw-selected-node"
              >${selectedPath.length === 0 ? "root" : chipSummary(selected)}</span
            >
          </div>
          ${renderExpressionEditor(selected, writeSelected, {
            allowEventRef: editing.type === "event",
            depth: 1,
            path: selectedPath,
            preview,
            stateDefs: Object.keys(stateEntries),
            stateEntries,
          })}
        </div>
        ${dataRailTemplate(scope)}
      </div>
      ${resultTemplate(preview)}
    </div>
  `;
}

/** The live data context — a SECOND opinion now that the page itself is on screen, not the only one. */
function dataRailTemplate(scope: Record<string, unknown> | null | undefined): TemplateResult {
  const scopeEntries = scope ? Object.entries(scope) : [];
  return html`
    <div class="fw-context">
      <div class="fw-context-title">Data</div>
      ${
        scopeEntries.length === 0
          ? html`<div class="empty-state">No canvas data snapshot yet</div>`
          : scopeEntries.map(([name, value]) => {
              const unwrapped = unwrapSignal(value);
              return html`
                <div class="fw-context-entry">
                  <div class="fw-context-head">
                    <span class="fw-context-name">${name}</span>
                    <span class="fw-context-type">${dataTypeLabel(value)}</span>
                  </div>
                  <div class="data-tree">${renderDataTreeTemplate(unwrapped, 0, 4)}</div>
                </div>
              `;
            })
      }
    </div>
  `;
}

/** The root result, the evaluation error, or the honest "nothing has evaluated this yet". */
function resultTemplate(preview: ExpressionPreview | null): TemplateResult {
  if (preview?.error) {
    return html`<div class="fw-result fw-result--error">${preview.error}</div>`;
  }
  if (preview) {
    return html`
      <div class="fw-result">
        = ${preview.values.get("") ?? "undefined"}
        ${preview.mutating ? html`<span class="fw-result-note">(mutates target)</span>` : ""}
      </div>
    `;
  }
  return html`
    <div class="fw-result fw-result--pending">
      Preview unavailable — the canvas has not posted a data snapshot yet
    </div>
  `;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * The formula/function EDITOR verbs — open a state entry's body or an event binding in Logic.
 *
 * They live here rather than beside `panels/editors.ts`'s renderer because this module already owns
 * the other half of the same idea: `editingFormula` (the structured workspace) and
 * `editingFunction` (the code editor) are two surfaces of ONE dock tab, addressing the same two
 * document positions — a state entry by `defName`, or an element event binding by `path` +
 * `eventKey`.
 *
 * Both REFUSE a target the document does not hold. The predecessors wrote `ui.editingFunction`
 * straight from the automation hook with no check at all, so a renamed def opened an editor over
 * nothing and the shot photographed an empty takeover.
 *
 * @returns {AnyCommand[]}
 */
export function formulaEditorCommands(): AnyCommand[] {
  return [
    {
      args: argsSchema({
        defName: stringProperty("The state entry whose body to open in the code editor."),
      }),
      category: "Document",
      id: "formula.editDef",
      level: "document",
      menus: ["palette"],
      group: "5_data",
      requires: "an open document that defines state",
      when: (ctx) => ctx.document.open,
      run: (_commandCtx, args) => {
        const defName = stringArg("formula.editDef", args, "defName");
        const tab = activeTab.value;
        if (!tab) {
          throw new RangeError(`command "formula.editDef" needs an open document`);
        }
        const defs = tab.doc.document?.state ?? {};
        if (!(defName in defs)) {
          const defined = Object.keys(defs);
          throw new RangeError(
            `command "formula.editDef" argument "defName": "${defName}" is not a state entry ` +
              `this document defines — it defines: ` +
              `${defined.length > 0 ? defined.join(", ") : "nothing"}`,
          );
        }
        openLogicTarget({ editing: { defName, type: "def" }, surface: "function" });
      },
      title: "Edit Function",
    },
    {
      args: argsSchema({
        eventKey: stringProperty('The event binding, e.g. "onclick".'),
        path: pathProperty("The document path of the element that carries the binding."),
      }),
      category: "Document",
      id: "formula.editEvent",
      level: "document",
      menus: ["palette"],
      group: "5_data",
      requires: "an open document",
      when: (ctx) => ctx.document.open,
      run: (_commandCtx, args) => {
        const eventKey = stringArg("formula.editEvent", args, "eventKey");
        const path = pathArg("formula.editEvent", args, "path");
        const tab = activeTab.value;
        if (!tab) {
          throw new RangeError(`command "formula.editEvent" needs an open document`);
        }
        if (!getNodeAtPath(tab.doc.document, path)) {
          throw new RangeError(
            `command "formula.editEvent" argument "path": [${path.join(", ")}] addresses no ` +
              `node in ${tab.documentPath ?? "the open document"}`,
          );
        }
        openLogicTarget({ editing: { eventKey, path, type: "event" }, surface: "function" });
      },
      title: "Edit Event Handler",
    },
  ];
}

/**
 * Register the formula/function editor verbs.
 *
 * @param {CommandRegistry} registry
 */
export function registerFormulaEditorCommands(registry: CommandRegistry): void {
  registry.registerAll(formulaEditorCommands());
}
