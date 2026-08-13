/// <reference lib="dom" />
/**
 * The expression editor — one operator row plus an operand editor per slot, nested to any depth.
 *
 * **The layout is CSS, in `styles/inspector.css` (§ "The expression editor").** Every row here used
 * to be an inline `display:flex;…` attribute with a hard `min-width` on the pickers, and no rung of
 * that chain could set `min-width: 0` — so at Inspector width the operand controls refused to
 * shrink and Operator, Target and Value were clipped by the edge of the window. The editor is drawn
 * in the Inspector (~280px), in the Navigator, and in the Bottom dock's Logic tab (very wide), so
 * every row wraps to a stack rather than sizing itself in pixels.
 */
import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { PURE_METHOD_OPS } from "@jxsuite/runtime/expression";
import { isJsonObject, isRef } from "@jxsuite/schema/guards";
import { renderFieldRow } from "./field-row";
import { renderFormulaChips } from "./formula-chips";
import { applyCatalogPick, calleeEntry, formulaCatalog } from "./formula-catalog";
import { openFormulaPalette } from "./formula-palette";
import { VALUE_SOURCE_LABELS } from "./value-source";
import { renderEmptyState } from "../panels/empty-state";

import type {
  JxExpressionNode,
  JxExpressionOperand,
  JxStateDefinition,
} from "@jxsuite/schema/types";
import type { TemplateResult } from "lit-html";

// ─── Operator Categories ────────────────────────────────────────────────────

const UNARY_OPS = new Set(["!", "-"]);
const BINARY_OPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
  "&&",
  "||",
  "??",
]);
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/="]);

/**
 * Does this expression node DO something rather than compute something?
 *
 * An assignment writes a target and yields nothing worth reading; a `+` or a `filter` yields a
 * value. The Data panel needs the distinction to know whether a row has a value column at all —
 * labelling `setBeds0` "pending" reads as "still loading" for a thing that will never load.
 */
export function isActionExpression(node: unknown): boolean {
  const op = (node as { operator?: unknown } | null | undefined)?.operator;
  return typeof op === "string" && ASSIGN_OPS.has(op);
}
const NO_ARG_OPS = new Set(["pop", "shift"]);
const ONE_ARG_OPS = new Set(["push", "unshift"]);

const ZERO_ARG_METHOD_OPS = new Set([
  "flat",
  "normalize",
  "toLocaleLowerCase",
  "toLocaleString",
  "toLocaleUpperCase",
  "toLowerCase",
  "toReversed",
  "toSorted",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
]);

const OPERATOR_GROUPS = [
  { label: "Assignment", ops: ["=", "+=", "-=", "*=", "/="] },
  { label: "Unary", ops: ["!", "-"] },
  { label: "Arithmetic", ops: ["+", "-", "*", "/", "%"] },
  { label: "Comparison", ops: ["===", "!==", "<", "<=", ">", ">="] },
  { label: "Logical", ops: ["&&", "||", "??"] },
  { label: "Conditional", ops: ["?:", "switch"] },
  {
    label: "Array methods",
    ops: ["push", "pop", "shift", "unshift", "splice"],
  },
  {
    label: "Pure methods (String)",
    ops: [
      "toUpperCase",
      "toLowerCase",
      "trim",
      "trimStart",
      "trimEnd",
      "split",
      "startsWith",
      "endsWith",
      "padStart",
      "padEnd",
      "replaceAll",
      "repeat",
      "charAt",
      "normalize",
    ],
  },
  {
    label: "Pure methods (Array)",
    ops: [
      "includes",
      "indexOf",
      "lastIndexOf",
      "join",
      "slice",
      "concat",
      "at",
      "flat",
      "toSorted",
      "toReversed",
      "toSpliced",
      "with",
    ],
  },
  { label: "Pure methods (Number)", ops: ["toFixed", "toPrecision", "toLocaleString"] },
  { label: "Aggregate", ops: ["reduce", "map", "filter"] },
  { label: "Function", ops: ["call"] },
];

interface OperatorInfo {
  needsValue: boolean;
  needsInitial: boolean;
  targetMustBeRef: boolean;
  spliceArray: boolean;
  valueIsNode: boolean;
  switchCases: boolean;
  /** `call`: value is a positional-args array; target is the callee pointer. */
  callArgs: boolean;
}

const INFO_DEFAULTS: OperatorInfo = {
  callArgs: false,
  needsInitial: false,
  needsValue: false,
  spliceArray: false,
  switchCases: false,
  targetMustBeRef: false,
  valueIsNode: false,
};

/**
 * @param {string} op
 * @returns {OperatorInfo}
 */
function operatorInfo(op: string): OperatorInfo {
  if (UNARY_OPS.has(op)) {
    return { ...INFO_DEFAULTS };
  }
  if (op === "?:") {
    return { ...INFO_DEFAULTS, needsInitial: true, needsValue: true };
  }
  if (op === "switch") {
    return { ...INFO_DEFAULTS, switchCases: true };
  }
  if (op === "call") {
    return { ...INFO_DEFAULTS, callArgs: true, targetMustBeRef: true };
  }
  if (PURE_METHOD_OPS.has(op)) {
    // Receiver in target (any operand); zero-arg methods render no value row.
    return { ...INFO_DEFAULTS, needsValue: !ZERO_ARG_METHOD_OPS.has(op) };
  }
  if (BINARY_OPS.has(op)) {
    return { ...INFO_DEFAULTS, needsValue: true };
  }
  if (ASSIGN_OPS.has(op)) {
    return { ...INFO_DEFAULTS, needsValue: true, targetMustBeRef: true };
  }
  if (NO_ARG_OPS.has(op)) {
    return { ...INFO_DEFAULTS, targetMustBeRef: true };
  }
  if (ONE_ARG_OPS.has(op)) {
    return { ...INFO_DEFAULTS, needsValue: true, targetMustBeRef: true };
  }
  if (op === "splice") {
    return { ...INFO_DEFAULTS, needsValue: true, spliceArray: true, targetMustBeRef: true };
  }
  if (op === "reduce") {
    return {
      ...INFO_DEFAULTS,
      needsInitial: true,
      needsValue: true,
      targetMustBeRef: true,
      valueIsNode: true,
    };
  }
  if (op === "map" || op === "filter") {
    return { ...INFO_DEFAULTS, needsValue: true, targetMustBeRef: true, valueIsNode: true };
  }
  return { ...INFO_DEFAULTS };
}

// ─── Operand Mode Detection ─────────────────────────────────────────────────

/**
 * Which rung of the value ladder an operand occupies. The three answers are the same three the
 * Properties, Style and Logic tabs give, and they are spelled the same way — `ui/value-source.ts`
 * owns the words, so `lit / $ref / expr` is gone from the operand picker (plan §6.3).
 *
 * @param {unknown} operand
 * @returns {"ref" | "expression" | "literal"}
 */
function operandMode(operand: unknown) {
  if (operand && typeof operand === "object") {
    if ("$ref" in operand) {
      return "ref";
    }
    if ("operator" in operand) {
      return "expression";
    }
  }
  return "literal";
}

/** Positional-arg labels for a `call` node, from the callee's catalog entry when resolvable. */
function calleeParamLabels(
  target: unknown,
  state?: Record<string, JxStateDefinition> | null,
): string[] {
  const ref = isRef(target) ? target.$ref : "";
  const entry = ref ? calleeEntry(ref, state) : undefined;
  return entry?.kind === "formula" ? entry.parameters.map((p) => p.name) : [];
}

/**
 * @param {string} mode
 * @returns {JxExpressionOperand}
 */
function defaultForMode(mode: string): JxExpressionOperand {
  if (mode === "ref") {
    return { $ref: "" };
  }
  if (mode === "expression") {
    return { operator: "!", target: null };
  }
  return null;
}

// ─── Literal Type Detection ─────────────────────────────────────────────────

/**
 * @param {unknown} val
 * @returns {"string" | "number" | "boolean" | "null"}
 */
function literalType(val: unknown) {
  if (val === null || val === undefined) {
    return "null";
  }
  if (typeof val === "boolean") {
    return "boolean";
  }
  if (typeof val === "number") {
    return "number";
  }
  return "string";
}

/**
 * @param {string} type
 * @returns {JxExpressionOperand}
 */
function defaultForLiteralType(type: string): JxExpressionOperand {
  if (type === "number") {
    return 0;
  }
  if (type === "boolean") {
    return false;
  }
  if (type === "null") {
    return null;
  }
  return "";
}

// ─── Hint (one-line summary for signal rows) ────────────────────────────────

/**
 * @param {unknown} node
 * @returns {string}
 */
export function expressionHint(node: unknown) {
  if (!isJsonObject(node) || typeof node.operator !== "string") {
    return "$expression";
  }
  const expr = node as unknown as JxExpressionNode;
  const op = expr.operator;
  const { target } = expr;
  const targetLabel = isRef(target)
    ? target.$ref.replace("#/state/", "")
    : isJsonObject(target) && typeof target.operator === "string"
      ? `(${target.operator}…)`
      : String(target ?? "?");

  if (ASSIGN_OPS.has(op) || ONE_ARG_OPS.has(op)) {
    return `${op} ${targetLabel}`;
  }
  if (NO_ARG_OPS.has(op)) {
    return `${op}(${targetLabel})`;
  }
  if (op === "splice") {
    return `splice(${targetLabel})`;
  }
  if (op === "call") {
    return `${targetLabel.replace("window#/", "").replaceAll("/", ".")}(…)`;
  }
  if (op === "reduce" || op === "map" || op === "filter" || PURE_METHOD_OPS.has(op)) {
    return `${op}(${targetLabel})`;
  }
  if (op === "?:") {
    return `${targetLabel} ? … : …`;
  }
  if (op === "switch") {
    return `switch(${targetLabel})`;
  }
  if (UNARY_OPS.has(op)) {
    return `${op}${targetLabel}`;
  }
  return `${targetLabel} ${op} …`;
}

// ─── Live Value Badge (spec §19.9) ──────────────────────────────────────────

/** Preview data computed by services/preview-eval.ts — display strings keyed by node path. */
export interface EditorPreview {
  values: Map<string, string>;
  error: string | null;
  mutating: boolean;
}

function renderValueBadge(preview: EditorPreview | null | undefined, pathKey: string) {
  const text = preview?.values.get(pathKey);
  if (text === undefined) {
    return nothing;
  }
  return html`<span class="expr-live-badge" title=${text}>${text}</span>`;
}

// ─── Ref Picker ─────────────────────────────────────────────────────────────

/**
 * @param {string} refVal
 * @param {(newRef: string) => void} onRefChange
 * @param {{ stateDefs: string[]; allowEventRef: boolean }} opts
 * @returns {import("lit-html").TemplateResult}
 */
function renderRefPicker(
  refVal: string,
  onRefChange: (newRef: string) => void,
  opts: { stateDefs: string[]; allowEventRef: boolean },
) {
  const stateRefs = (opts.stateDefs || []).map((k) => `#/state/${k}`);
  const eventRefs = opts.allowEventRef ? ["event#/detail", "event#/target/value"] : [];
  const allRefs = [...stateRefs, ...eventRefs];
  const isCustom = refVal && !allRefs.includes(refVal);

  // Nothing to pick and nothing already picked: a picker whose only entry is a disabled "No state
  // Defined" is a dead end. Say what a binding is instead, in the shell's one empty-state voice.
  if (allRefs.length === 0 && !refVal) {
    return renderEmptyState({
      compact: true,
      detail: "Add one in the State panel and it shows up here.",
      message: "A binding points at a value this page holds.",
    });
  }

  return html`
    <sp-picker
      size="s"
      class="expr-ref"
      placeholder="Select…"
      .value=${live(isCustom ? "__custom__" : refVal || "")}
      @change=${(e: Event) => {
        const val = (e.target as HTMLInputElement).value;
        if (val === "__custom__") {
          return;
        }
        onRefChange(val);
      }}
    >
      ${stateRefs.map(
        (r) => html`<sp-menu-item value=${r}>${r.replace("#/state/", "")}</sp-menu-item>`,
      )}
      ${
        eventRefs.length > 0
          ? html`
              <sp-menu-divider></sp-menu-divider>
              ${eventRefs.map((r) => html`<sp-menu-item value=${r}>${r}</sp-menu-item>`)}
            `
          : nothing
      }
    </sp-picker>
  `;
}

// ─── Literal Editor ─────────────────────────────────────────────────────────

/**
 * @param {unknown} operand
 * @param {(newVal: JxExpressionOperand) => void} onChange
 * @returns {import("lit-html").TemplateResult}
 */
function renderLiteralEditor(operand: unknown, onChange: (newVal: JxExpressionOperand) => void) {
  const type = literalType(operand);
  return html`
    <div class="expr-literal">
      <sp-picker
        size="s"
        class="expr-literal-type"
        .value=${live(type)}
        @change=${(e: Event) => {
          const newType = (e.target as HTMLInputElement).value;
          onChange(defaultForLiteralType(newType));
        }}
      >
        <sp-menu-item value="string">str</sp-menu-item>
        <sp-menu-item value="number">num</sp-menu-item>
        <sp-menu-item value="boolean">bool</sp-menu-item>
        <sp-menu-item value="null">null</sp-menu-item>
      </sp-picker>
      ${
        type === "string"
          ? html`<sp-textfield
              size="s"
              class="expr-literal-value"
              .value=${live(String(operand ?? ""))}
              @input=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
            ></sp-textfield>`
          : type === "number"
            ? html`<sp-number-field
                size="s"
                class="expr-literal-value"
                .value=${live(Number(operand ?? 0))}
                @change=${(e: Event) => onChange(Number((e.target as HTMLInputElement).value))}
              ></sp-number-field>`
            : type === "boolean"
              ? html`<sp-checkbox
                  size="s"
                  class="expr-literal-bool"
                  ?checked=${Boolean(operand)}
                  @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
                  >true</sp-checkbox
                >`
              : html`<span class="expr-literal-null">null</span>`
      }
    </div>
  `;
}

// ─── Operand Editor ─────────────────────────────────────────────────────────

/**
 * Single-operand editor (mode picker + literal/ref/nested-expression widget). Exported for
 * statement-position operand slots (spec §20: `if` tests, `$switch` discriminants, `dispatchEvent`
 * detail).
 *
 * @param {unknown} operand
 * @param {(newOperand: unknown) => void} onChange
 * @param {{
 *   stateDefs: string[];
 *   allowEventRef: boolean;
 *   depth: number;
 *   mustBeRef?: boolean;
 * }} opts
 * @returns {import("lit-html").TemplateResult}
 */
export function renderOperandEditor(
  operand: unknown,
  onChange: (newOperand: unknown) => void,
  opts: {
    stateDefs: string[];
    allowEventRef: boolean;
    depth: number;
    mustBeRef?: boolean;
    preview?: EditorPreview | null;
    path?: (string | number)[];
    stateEntries?: Record<string, JxStateDefinition> | null;
  },
): TemplateResult {
  if (opts.mustBeRef) {
    const refVal = ((operand as Record<string, unknown> | null)?.$ref as string) ?? "";
    return html`
      <div class="expr-operand">${renderRefPicker(refVal, (r) => onChange({ $ref: r }), opts)}</div>
    `;
  }

  const mode = operandMode(operand);
  return html`
    <div class="expr-operand">
      <sp-picker
        size="s"
        class="expr-operand-mode"
        label="Value source"
        .value=${live(mode)}
        @change=${(e: Event) => {
          const newMode = (e.target as HTMLInputElement).value;
          onChange(defaultForMode(newMode));
        }}
      >
        <sp-menu-item value="literal">${VALUE_SOURCE_LABELS.literal}</sp-menu-item>
        <sp-menu-item value="ref">${VALUE_SOURCE_LABELS.ref}</sp-menu-item>
        <sp-menu-item value="expression">${VALUE_SOURCE_LABELS.expression}</sp-menu-item>
      </sp-picker>
      ${
        mode === "literal"
          ? renderLiteralEditor(operand, onChange)
          : mode === "ref"
            ? renderRefPicker(
                ((operand as Record<string, unknown> | null)?.$ref as string) ?? "",
                (r) => onChange({ $ref: r }),
                opts,
              )
            : renderExpressionEditor(operand, onChange, {
                ...opts,
                depth: opts.depth + 1,
              })
      }
    </div>
  `;
}

// ─── Positional Args Editor (splice / call) ─────────────────────────────────

/**
 * @param {unknown[]} args
 * @param {(newArgs: unknown[]) => void} onChange
 * @param {{ stateDefs: string[]; allowEventRef: boolean; depth: number }} opts
 * @param {{ labels?: string[]; fallbackLabel?: string }} [naming]
 * @returns {import("lit-html").TemplateResult}
 */
function renderSpliceArgsEditor(
  args: unknown[],
  onChange: (newArgs: unknown[]) => void,
  opts: { stateDefs: string[]; allowEventRef: boolean; depth: number },
  naming: { labels?: string[]; fallbackLabel?: string } = {},
): TemplateResult {
  const safeArgs = Array.isArray(args) ? args : [];
  const labels = naming.labels ?? ["start", "del", "item"];
  const fallbackLabel = naming.fallbackLabel ?? "item";

  return html`
    <div class="array-object-field">
      ${safeArgs.map(
        (arg, idx) => html`
          <div class="array-object-row">
            <span class="array-object-label">${labels[idx] ?? fallbackLabel}</span>
            ${renderOperandEditor(
              arg,
              (newArg) => {
                const updated = [...safeArgs];
                updated[idx] = newArg;
                onChange(updated);
              },
              { ...opts, mustBeRef: false },
            )}
            <sp-action-button
              quiet
              size="xs"
              @click=${() => {
                const updated = safeArgs.filter((_, i) => i !== idx);
                onChange(updated.length > 0 ? updated : [null]);
              }}
            >
              <sp-icon-delete slot="icon"></sp-icon-delete>
            </sp-action-button>
          </div>
        `,
      )}
      <sp-action-button quiet size="s" @click=${() => onChange([...safeArgs, null])}>
        + Add arg
      </sp-action-button>
    </div>
  `;
}

// ─── Operator Picker Menu ───────────────────────────────────────────────────

const _operatorMenuCache = OPERATOR_GROUPS.map(
  (group, i) => html`
    ${i > 0 ? html`<sp-menu-divider></sp-menu-divider>` : nothing}
    <sp-menu-group>
      <span slot="header">${group.label}</span>
      ${group.ops.map((op) => html`<sp-menu-item value=${op}>${op}</sp-menu-item>`)}
    </sp-menu-group>
  `,
);

// ─── Main Expression Editor ─────────────────────────────────────────────────

export interface ExpressionEditorOpts {
  stateDefs: string[];
  allowEventRef: boolean;
  depth?: number;
  preview?: EditorPreview | null;
  path?: (string | number)[];
  /** Full state defs map — resolves named-formula catalog entries (call labels, palette). */
  stateEntries?: Record<string, JxStateDefinition> | null;
  /** Chip-strip click hook (depth 0). No-op when absent. */
  onChipSelect?: (path: (string | number)[]) => void;
  /** Vendors a packaged formula's state entry into the document on catalog pick. */
  onInsertDef?: (name: string, def: JxStateDefinition) => void;
}

/**
 * @param {unknown} node
 * @param {(node: unknown) => void} onChange
 * @param {ExpressionEditorOpts} opts
 * @returns {import("lit-html").TemplateResult}
 */
export function renderExpressionEditor(
  node: unknown,
  onChange: (node: unknown) => void,
  opts: ExpressionEditorOpts,
): TemplateResult {
  const depth = opts.depth ?? 0;
  const safeNode: Record<string, unknown> =
    node && typeof node === "object"
      ? (node as Record<string, unknown>)
      : { operator: "=", target: null };
  const op = (safeNode.operator as string) || "=";
  const info = operatorInfo(op);
  const preview = opts.preview ?? null;
  const path = opts.path ?? [];
  const pathKey = path.join("/");
  const sub = (...segs: (string | number)[]) => [...path, ...segs].join("/");
  /** Wrap an operand widget with its live value badge. */
  const withBadge = (widget: unknown, key: string) =>
    html`<div class="expr-widget">${widget}${renderValueBadge(preview, key)}</div>`;

  // The root badge: pure roots show their result; mutating roots' effect shows on target/value.
  const rootBadge =
    depth === 0 && preview && !preview.mutating ? renderValueBadge(preview, pathKey) : nothing;

  return html`
    <div class=${depth > 0 ? "expression-editor expression-editor--nested" : "expression-editor"}>
      ${
        depth === 0
          ? renderFormulaChips(safeNode, opts.onChipSelect ?? (() => {}), { path, preview })
          : nothing
      }
      ${
        depth === 0 && preview?.error
          ? html`<div class="expr-error">${preview.error}</div>`
          : nothing
      }
      ${renderFieldRow({
        hasValue: false,
        label: "Operator",
        prop: "operator",
        widget: html`
          <div class="expr-widget">
            <sp-picker
              size="s"
              class="expr-operator"
              .value=${live(op)}
              @change=${(e: Event) => {
                const newOp = (e.target as HTMLInputElement).value;
                const newInfo = operatorInfo(newOp);
                const updated: Record<string, unknown> = {
                  operator: newOp,
                  target: safeNode.target,
                };
                if (newInfo.targetMustBeRef && operandMode(safeNode.target) !== "ref") {
                  updated.target = { $ref: "" };
                }
                if (newInfo.needsValue) {
                  if (newInfo.valueIsNode) {
                    const val = safeNode.value as Record<string, unknown> | null;
                    updated.value = val?.operator
                      ? safeNode.value
                      : { operator: "!", target: null };
                  } else if (newInfo.spliceArray) {
                    updated.value = Array.isArray(safeNode.value) ? safeNode.value : [null];
                  } else {
                    updated.value = safeNode.value ?? null;
                  }
                }
                if (newInfo.needsInitial) {
                  updated.initial = safeNode.initial ?? (newOp === "?:" ? null : 0);
                }
                if (newInfo.switchCases) {
                  updated.cases = isJsonObject(safeNode.cases) ? safeNode.cases : {};
                  if ("default" in safeNode) {
                    updated.default = safeNode.default;
                  }
                }
                if (newInfo.callArgs) {
                  updated.value = Array.isArray(safeNode.value) ? safeNode.value : [];
                }
                onChange(updated);
              }}
            >
              ${_operatorMenuCache}
            </sp-picker>
            <sp-action-button
              quiet
              size="s"
              class="expr-browse-catalog"
              title="Browse catalog"
              @click=${(e: Event) =>
                openFormulaPalette({
                  anchor: e.currentTarget as HTMLElement,
                  entries: formulaCatalog(opts.stateEntries),
                  onPick: (entry) =>
                    applyCatalogPick(entry, onChange, {
                      onInsertDef: opts.onInsertDef,
                      stateEntries: opts.stateEntries,
                    }),
                })}
            >
              <sp-icon-brackets slot="icon"></sp-icon-brackets>
            </sp-action-button>
            ${rootBadge}
          </div>
        `,
      })}
      ${renderFieldRow({
        hasValue: false,
        label: op === "?:" ? "If" : op === "switch" ? "On" : op === "call" ? "Callee" : "Target",
        prop: "target",
        widget: withBadge(
          renderOperandEditor(safeNode.target, (t) => onChange({ ...safeNode, target: t }), {
            ...opts,
            depth,
            mustBeRef: info.targetMustBeRef,
            path: [...path, "target"],
          }),
          sub("target"),
        ),
      })}
      ${
        info.needsValue && !info.valueIsNode && !info.spliceArray
          ? renderFieldRow({
              hasValue: false,
              label: op === "?:" ? "Then" : "Value",
              prop: "value",
              widget: withBadge(
                renderOperandEditor(safeNode.value, (v) => onChange({ ...safeNode, value: v }), {
                  ...opts,
                  depth,
                  mustBeRef: false,
                  path: [...path, "value"],
                }),
                sub("value"),
              ),
            })
          : nothing
      }
      ${
        info.needsValue && info.valueIsNode
          ? html`
              <div class="expr-subsection">
                ${renderFieldRow({
                  hasValue: false,
                  label: "Per-item",
                  prop: "value",
                  widget: nothing,
                })}
                ${renderExpressionEditor(
                  (safeNode.value as Record<string, unknown> | null)?.operator
                    ? safeNode.value
                    : { operator: "!", target: null },
                  (v) => onChange({ ...safeNode, value: v }),
                  { ...opts, depth: depth + 1, path: [...path, "value"] },
                )}
              </div>
            `
          : nothing
      }
      ${
        info.spliceArray
          ? html`
              <div class="expr-subsection">
                ${renderFieldRow({
                  hasValue: false,
                  label: "Args",
                  prop: "value",
                  widget: nothing,
                })}
                ${renderSpliceArgsEditor(
                  safeNode.value as unknown[],
                  (v) => onChange({ ...safeNode, value: v }),
                  {
                    ...opts,
                    depth,
                  },
                )}
              </div>
            `
          : nothing
      }
      ${
        info.callArgs
          ? html`
              <div class="expr-subsection">
                ${renderFieldRow({
                  hasValue: false,
                  label: "Args",
                  prop: "value",
                  widget: nothing,
                })}
                ${renderSpliceArgsEditor(
                  safeNode.value as unknown[],
                  (v) => onChange({ ...safeNode, value: v }),
                  { ...opts, depth },
                  {
                    fallbackLabel: "arg",
                    labels: calleeParamLabels(safeNode.target, opts.stateEntries),
                  },
                )}
              </div>
            `
          : nothing
      }
      ${
        info.switchCases
          ? renderSwitchCasesEditor(safeNode, onChange, { ...opts, depth, path }, withBadge)
          : nothing
      }
      ${
        info.needsInitial
          ? renderFieldRow({
              hasValue: false,
              label: op === "?:" ? "Else" : "Initial",
              prop: "initial",
              widget: withBadge(
                renderOperandEditor(
                  safeNode.initial,
                  (v) => onChange({ ...safeNode, initial: v }),
                  {
                    ...opts,
                    depth,
                    mustBeRef: false,
                    path: [...path, "initial"],
                  },
                ),
                sub("initial"),
              ),
            })
          : nothing
      }
    </div>
  `;
}

// ─── Switch Cases Editor ────────────────────────────────────────────────────

/**
 * Case rows for the `switch` operator: matched value → result operand, plus the default operand.
 * Mirrors the element-level `$switch`/`cases` model (spec §19.4b).
 */
function renderSwitchCasesEditor(
  safeNode: Record<string, unknown>,
  onChange: (node: unknown) => void,
  opts: {
    stateDefs: string[];
    allowEventRef: boolean;
    depth: number;
    preview?: EditorPreview | null;
    path: (string | number)[];
  },
  withBadge: (widget: unknown, key: string) => TemplateResult,
): TemplateResult {
  const cases = isJsonObject(safeNode.cases)
    ? (safeNode.cases as Record<string, unknown>)
    : ({} as Record<string, unknown>);
  const entries = Object.entries(cases);
  const setCases = (next: Record<string, unknown>) => onChange({ ...safeNode, cases: next });

  return html`
    <div class="switch-cases">
      ${entries.map(
        ([key, operand]) => html`
          <div class="switch-case-row">
            <sp-textfield
              size="s"
              class="switch-case-key"
              placeholder="value"
              .value=${live(key)}
              @change=${(e: Event) => {
                const newKey = (e.target as HTMLInputElement).value;
                if (newKey === key) {
                  return;
                }
                const next: Record<string, unknown> = {};
                for (const [k, v] of entries) {
                  next[k === key ? newKey : k] = v;
                }
                setCases(next);
              }}
            ></sp-textfield>
            ${withBadge(
              renderOperandEditor(operand, (v) => setCases({ ...cases, [key]: v }), {
                ...opts,
                mustBeRef: false,
                path: [...opts.path, "cases", key],
              }),
              [...opts.path, "cases", key].join("/"),
            )}
            <sp-action-button
              quiet
              size="xs"
              @click=${() => {
                const next = { ...cases };
                delete next[key];
                setCases(next);
              }}
            >
              <sp-icon-delete slot="icon"></sp-icon-delete>
            </sp-action-button>
          </div>
        `,
      )}
      <div class="switch-case-row">
        <span class="switch-case-key switch-case-default">default</span>
        ${withBadge(
          renderOperandEditor(safeNode.default, (v) => onChange({ ...safeNode, default: v }), {
            ...opts,
            mustBeRef: false,
            path: [...opts.path, "default"],
          }),
          [...opts.path, "default"].join("/"),
        )}
      </div>
      <sp-action-button
        quiet
        size="s"
        @click=${() => {
          let n = entries.length + 1;
          let key = `case ${n}`;
          while (Object.hasOwn(cases, key)) {
            n += 1;
            key = `case ${n}`;
          }
          setCases({ ...cases, [key]: null });
        }}
      >
        + Add case
      </sp-action-button>
    </div>
  `;
}
