/// <reference lib="dom" />
/**
 * Formula workspace — the full-screen structured editing surface for a single `$expression` (spec
 * §19.9, milestone M4). Takes over the canvas area exactly like the Monaco function editor
 * (renderFunctionEditor): `TabUi.editingFormula` identifies the document position being edited (a
 * state entry's `$expression` via defName, or an element event binding's via path + eventKey).
 *
 * Layout: the chip pipeline summarizes the whole tree with live value badges on top; the recursive
 * expression form edits the chip-selected sub-node in the main pane; a data rail mirrors the canvas
 * dataScope snapshot on the right; the footer reports the root result (or the evaluation error).
 *
 * Every edit immutably replaces the selected sub-node within the root and writes the WHOLE root
 * node back through transactDoc — undo/redo and canvas/panel refresh come free.
 */

import { html, render as litRender } from "lit-html";
import { getEventBinding, isExpressionDef, isJsonObject } from "@jxsuite/schema/guards";

import { canvasPanels, canvasWrap, getNodeAtPath, updateUi } from "../store";
import { activeTab } from "../workspace/workspace";
import { mutateUpdateDef, mutateUpdateProperty, transactDoc } from "../tabs/transact";
import { view } from "../view";
import { chipSummary, renderFormulaChips } from "../ui/formula-chips";
import { renderExpressionEditor } from "../ui/expression-editor";
import { formulaCatalog } from "../ui/formula-catalog";
import { openFormulaPalette } from "../ui/formula-palette";
import { livePreviewExpression } from "../services/live-preview";
import { dataTypeLabel, renderDataTreeTemplate, unwrapSignal } from "./data-explorer";

import type { JxNodeValue } from "../tabs/transact";
import type { FormulaEditDef, JsonValue } from "../types";
import type { Tab } from "../tabs/tab";
import type { JxStateDefinition } from "@jxsuite/schema/types";
import type { TemplateResult } from "lit-html";

type NodePath = (string | number)[];

// ─── Module state ────────────────────────────────────────────────────────────

/** Chip-selected sub-node path within the root expression (root = []). */
let _selectedPath: NodePath = [];

/** Serialized editing target — the selection resets when the workspace retargets. */
let _targetKey: string | null = null;

/** Owning tab of the current target — a same-looking target in another tab is a retarget. */
let _targetTab: Tab | null = null;

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
    const copy = [...node];
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
  renderFormulaWorkspace();
}

/** Close the workspace — clears `editingFormula`; the canvas re-renders its regular mode. */
export function closeFormulaWorkspace() {
  updateUi("editingFormula", null);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const PANE_BORDER = "1px solid var(--spectrum-gray-200, #323232)";

const MONO = "font-family:var(--spectrum-code-font-family, monospace)";

/**
 * Render the formula workspace into the canvas area. Mirrors renderFunctionEditor's takeover: the
 * canvas DnD/event handlers and panel registrations are cleared and canvasWrap becomes a stretched
 * column owned by this template.
 */
export function renderFormulaWorkspace() {
  const tab = activeTab.value;
  const editing = tab?.session.ui.editingFormula as FormulaEditDef | null | undefined;
  if (!tab || !editing) {
    return;
  }

  // Reset the chip selection when the workspace retargets.
  const targetKey = JSON.stringify(editing);
  if (targetKey !== _targetKey || tab !== _targetTab) {
    _targetKey = targetKey;
    _targetTab = tab;
    _selectedPath = [];
  }

  // Clean up canvas DnD and event handlers (the canvas surface is being replaced).
  for (const fn of view.canvasDndCleanups) {
    fn();
  }
  view.canvasDndCleanups = [];
  for (const fn of view.canvasEventCleanups) {
    fn();
  }
  view.canvasEventCleanups = [];
  canvasPanels.length = 0;

  // Eject foreign DOM (iframe canvas markup) plus any stale Lit part before the first render;
  // Subsequent renders diff in place so form focus survives re-renders.
  if (!canvasWrap.firstElementChild?.classList.contains("formula-workspace")) {
    canvasWrap.textContent = "";
    // @ts-expect-error -- _$litPart$ is Lit's private render-part marker, not in the DOM types
    delete canvasWrap["_$litPart$"];
  }
  canvasWrap.style.padding = "0";
  canvasWrap.style.flexDirection = "column";
  canvasWrap.style.alignItems = "stretch";

  litRender(workspaceTemplate(tab, editing), canvasWrap);
}

function workspaceTemplate(tab: Tab, editing: FormulaEditDef): TemplateResult {
  const stateEntries = (tab.doc.document?.state ?? {}) as Record<string, JxStateDefinition>;
  const title = (editing.type === "def" ? editing.defName : editing.eventKey) ?? "?";
  const root = formulaRoot(tab, editing);

  const closeButton = html`
    <sp-action-button
      quiet
      size="s"
      class="fw-close"
      title="Close formula workspace"
      @click=${closeFormulaWorkspace}
    >
      <sp-icon-close slot="icon"></sp-icon-close>
      Close
    </sp-action-button>
  `;

  if (!root) {
    return html`
      <div
        class="formula-workspace"
        style="display:flex;flex-direction:column;flex:1;min-height:0;gap:12px;padding:20px"
      >
        <div class="fw-header" style="display:flex;align-items:center;gap:8px">
          <span class="fw-title" style="${MONO};font-size:14px">fx ${title}</span>
          <div style="flex:1"></div>
          ${closeButton}
        </div>
        <div class="empty-state">No expression found at this document position.</div>
      </div>
    `;
  }

  const { scope } = tab.session.canvas;
  // Live-context evaluation in the canvas iframe with snapshot fallback (M6). While the workspace
  // Owns canvasWrap the iframe is usually unmounted (immediate snapshot); when a live host exists
  // (e.g. another panel's canvas), a landed result re-renders this workspace. An event target's
  // Element path is the context, so repeater-template formulas bind the first item's $map scope.
  const preview = livePreviewExpression(
    tab,
    `formula:${JSON.stringify(editing)}`,
    root,
    editing.type === "event" ? (editing.path ?? null) : null,
    () => renderFormulaWorkspace(),
  );
  const { node: selected, path: selectedPath } = resolveSelection(root, _selectedPath);
  const write = (next: unknown) => writeRoot(tab, editing, next);
  const writeSelected = (next: unknown) => write(replaceAtPath(root, selectedPath, next));
  const onChipSelect = (path: NodePath) => {
    _selectedPath = path;
    renderFormulaWorkspace();
  };

  // ── Header: target title, catalog browser (palette), Close ──
  const header = html`
    <div class="fw-header" style="display:flex;align-items:center;gap:8px;padding:14px 20px 6px">
      <span
        class="fw-title"
        style="${MONO};font-size:14px;color:var(--spectrum-gray-800, #d0d0d0)"
        title=${editing.type === "def" ? `state/${title}` : title}
        >fx ${title}</span
      >
      <span class="fw-kind" style="font-size:11px;color:var(--spectrum-gray-600, #808080)">
        ${editing.type === "def" ? "state expression" : "event expression"}
      </span>
      <div style="flex:1"></div>
      <sp-action-button
        quiet
        size="s"
        class="fw-browse-catalog"
        title="Browse catalog"
        @click=${(e: Event) =>
          openFormulaPalette({
            anchor: e.currentTarget as HTMLElement,
            entries: formulaCatalog(stateEntries),
            onPick: (entry) => writeSelected(entry.insert()),
          })}
      >
        <sp-icon-brackets slot="icon"></sp-icon-brackets>
        Catalog
      </sp-action-button>
      ${closeButton}
    </div>
  `;

  // ── Chip strip: the whole tree as chips with live badges; clicking selects the sub-node ──
  const chips = html`
    <div class="fw-chips" style="padding:2px 20px 10px;border-bottom:${PANE_BORDER}">
      ${renderFormulaChips(root, onChipSelect, { preview })}
    </div>
  `;

  // ── Main pane: the recursive expression form for the SELECTED sub-node ──
  const editor = html`
    <div class="fw-editor" style="flex:1;min-width:0;overflow:auto;padding:16px 20px">
      <div
        class="fw-selected"
        style="font-size:11px;color:var(--spectrum-gray-600, #808080);padding-bottom:8px"
      >
        Selected:
        <span style=${MONO}>${selectedPath.length === 0 ? "root" : chipSummary(selected)}</span>
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
  `;

  // ── Right rail: live data context (the canvas dataScope snapshot) ──
  const scopeEntries = scope ? Object.entries(scope) : [];
  const rail = html`
    <div
      class="fw-context"
      style="width:280px;flex-shrink:0;overflow:auto;border-left:${PANE_BORDER};padding:16px"
    >
      <div
        class="fw-context-title"
        style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--spectrum-gray-600, #808080);padding-bottom:8px"
      >
        Data
      </div>
      ${scopeEntries.length === 0
        ? html`<div class="empty-state">No canvas data snapshot yet</div>`
        : scopeEntries.map(([name, value]) => {
            const unwrapped = unwrapSignal(value);
            return html`
              <div class="fw-context-entry" style="margin-bottom:10px">
                <div style="display:flex;gap:6px;align-items:baseline">
                  <span
                    class="fw-context-name"
                    style="${MONO};font-size:12px;color:var(--spectrum-gray-800, #d0d0d0)"
                    >${name}</span
                  >
                  <span style="font-size:10px;color:var(--spectrum-gray-600, #808080)"
                    >${dataTypeLabel(value)}</span
                  >
                </div>
                <div class="data-tree">${renderDataTreeTemplate(unwrapped, 0, 4)}</div>
              </div>
            `;
          })}
    </div>
  `;

  // ── Footer: the root result badge, or the evaluation error ──
  const footer = preview?.error
    ? html`
        <div
          class="fw-result fw-result--error"
          style="${MONO};font-size:12px;padding:10px 20px;border-top:${PANE_BORDER};color:var(--spectrum-negative-content-color-default, #f76a63)"
        >
          ${preview.error}
        </div>
      `
    : preview
      ? html`
          <div
            class="fw-result"
            style="${MONO};font-size:12px;padding:10px 20px;border-top:${PANE_BORDER};color:var(--spectrum-seafoam-900, #35a690)"
          >
            = ${preview.values.get("") ?? "undefined"}
            ${preview.mutating
              ? html`<span style="color:var(--spectrum-gray-600, #808080)">(mutates target)</span>`
              : ""}
          </div>
        `
      : html`
          <div
            class="fw-result fw-result--pending"
            style="font-size:12px;padding:10px 20px;border-top:${PANE_BORDER};color:var(--spectrum-gray-600, #808080)"
          >
            Preview unavailable — the canvas has not posted a data snapshot yet
          </div>
        `;

  return html`
    <div
      class="formula-workspace"
      style="display:flex;flex-direction:column;flex:1;min-height:0;background:var(--spectrum-gray-75, #1d1d1d)"
    >
      ${header} ${chips}
      <div class="fw-body" style="display:flex;flex:1;min-height:0">${editor} ${rail}</div>
      ${footer}
    </div>
  `;
}
