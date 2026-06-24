/// <reference lib="dom" />
import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { isJsonObject, isRef } from "@jxsuite/schema/guards";
import { renderFieldRow } from "./field-row";

import type { JxExpressionNode, JxExpressionOperand } from "@jxsuite/schema/types";
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
]);
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/="]);
const NO_ARG_OPS = new Set(["pop", "shift"]);
const ONE_ARG_OPS = new Set(["push", "unshift"]);

const OPERATOR_GROUPS = [
  { label: "Assignment", ops: ["=", "+=", "-=", "*=", "/="] },
  { label: "Unary", ops: ["!", "-"] },
  { label: "Arithmetic", ops: ["+", "-", "*", "/", "%"] },
  { label: "Comparison", ops: ["===", "!==", "<", "<=", ">", ">="] },
  { label: "Logical", ops: ["&&", "||"] },
  {
    label: "Array methods",
    ops: ["push", "pop", "shift", "unshift", "splice"],
  },
  { label: "Aggregate", ops: ["reduce", "map", "filter"] },
];

/**
 * @param {string} op
 * @returns {{
 *   needsValue: boolean;
 *   needsInitial: boolean;
 *   targetMustBeRef: boolean;
 *   spliceArray: boolean;
 *   valueIsNode: boolean;
 * }}
 */
function operatorInfo(op: string) {
  if (UNARY_OPS.has(op)) {
    return {
      needsInitial: false,
      needsValue: false,
      spliceArray: false,
      targetMustBeRef: false,
      valueIsNode: false,
    };
  }
  if (BINARY_OPS.has(op)) {
    return {
      needsInitial: false,
      needsValue: true,
      spliceArray: false,
      targetMustBeRef: false,
      valueIsNode: false,
    };
  }
  if (ASSIGN_OPS.has(op)) {
    return {
      needsInitial: false,
      needsValue: true,
      spliceArray: false,
      targetMustBeRef: true,
      valueIsNode: false,
    };
  }
  if (NO_ARG_OPS.has(op)) {
    return {
      needsInitial: false,
      needsValue: false,
      spliceArray: false,
      targetMustBeRef: true,
      valueIsNode: false,
    };
  }
  if (ONE_ARG_OPS.has(op)) {
    return {
      needsInitial: false,
      needsValue: true,
      spliceArray: false,
      targetMustBeRef: true,
      valueIsNode: false,
    };
  }
  if (op === "splice") {
    return {
      needsInitial: false,
      needsValue: true,
      spliceArray: true,
      targetMustBeRef: true,
      valueIsNode: false,
    };
  }
  if (op === "reduce") {
    return {
      needsInitial: true,
      needsValue: true,
      spliceArray: false,
      targetMustBeRef: true,
      valueIsNode: true,
    };
  }
  if (op === "map" || op === "filter") {
    return {
      needsInitial: false,
      needsValue: true,
      spliceArray: false,
      targetMustBeRef: true,
      valueIsNode: true,
    };
  }
  return {
    needsInitial: false,
    needsValue: false,
    spliceArray: false,
    targetMustBeRef: false,
    valueIsNode: false,
  };
}

// ─── Operand Mode Detection ─────────────────────────────────────────────────

/**
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
  if (op === "reduce" || op === "map" || op === "filter") {
    return `${op}(${targetLabel})`;
  }
  if (UNARY_OPS.has(op)) {
    return `${op}${targetLabel}`;
  }
  return `${targetLabel} ${op} …`;
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

  return html`
    <sp-picker
      size="s"
      style="flex:1"
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
      ${stateRefs.length > 0
        ? stateRefs.map(
            (r) => html`<sp-menu-item value=${r}>${r.replace("#/state/", "")}</sp-menu-item>`,
          )
        : html`<sp-menu-item disabled>No state defined</sp-menu-item>`}
      ${eventRefs.length > 0
        ? html`
            <sp-menu-divider></sp-menu-divider>
            ${eventRefs.map((r) => html`<sp-menu-item value=${r}>${r}</sp-menu-item>`)}
          `
        : nothing}
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
    <div style="display:flex;gap:4px;align-items:center;flex:1">
      <sp-picker
        size="s"
        style="min-width:56px"
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
      ${type === "string"
        ? html`<sp-textfield
            size="s"
            style="flex:1"
            .value=${live(String(operand ?? ""))}
            @input=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
          ></sp-textfield>`
        : type === "number"
          ? html`<sp-number-field
              size="s"
              style="flex:1"
              .value=${live(Number(operand ?? 0))}
              @change=${(e: Event) => onChange(Number((e.target as HTMLInputElement).value))}
            ></sp-number-field>`
          : type === "boolean"
            ? html`<sp-checkbox
                size="s"
                ?checked=${Boolean(operand)}
                @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
                >true</sp-checkbox
              >`
            : html`<span
                style="font-size:var(--spectrum-font-size-75, 12px);color:var(--spectrum-gray-600, #808080)"
                >null</span
              >`}
    </div>
  `;
}

// ─── Operand Editor ─────────────────────────────────────────────────────────

/**
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
function renderOperandEditor(
  operand: unknown,
  onChange: (newOperand: unknown) => void,
  opts: {
    stateDefs: string[];
    allowEventRef: boolean;
    depth: number;
    mustBeRef?: boolean;
  },
): TemplateResult {
  if (opts.mustBeRef) {
    const refVal = ((operand as Record<string, unknown> | null)?.$ref as string) ?? "";
    return html`
      <div style="flex:1">${renderRefPicker(refVal, (r) => onChange({ $ref: r }), opts)}</div>
    `;
  }

  const mode = operandMode(operand);
  return html`
    <div style="display:flex;gap:4px;align-items:flex-start;flex:1">
      <sp-picker
        size="s"
        style="min-width:60px"
        .value=${live(mode)}
        @change=${(e: Event) => {
          const newMode = (e.target as HTMLInputElement).value;
          onChange(defaultForMode(newMode));
        }}
      >
        <sp-menu-item value="literal">lit</sp-menu-item>
        <sp-menu-item value="ref">$ref</sp-menu-item>
        <sp-menu-item value="expression">expr</sp-menu-item>
      </sp-picker>
      ${mode === "literal"
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
            })}
    </div>
  `;
}

// ─── Splice Args Editor ─────────────────────────────────────────────────────

/**
 * @param {unknown[]} args
 * @param {(newArgs: unknown[]) => void} onChange
 * @param {{ stateDefs: string[]; allowEventRef: boolean; depth: number }} opts
 * @returns {import("lit-html").TemplateResult}
 */
function renderSpliceArgsEditor(
  args: unknown[],
  onChange: (newArgs: unknown[]) => void,
  opts: { stateDefs: string[]; allowEventRef: boolean; depth: number },
): TemplateResult {
  const safeArgs = Array.isArray(args) ? args : [];
  const labels = ["start", "del", "item"];

  return html`
    <div class="array-object-field">
      ${safeArgs.map(
        (arg, idx) => html`
          <div
            class="array-object-row"
            style="display:flex;gap:4px;align-items:center;margin-bottom:4px"
          >
            <span style="font-size:10px;color:var(--spectrum-gray-600, #808080);min-width:30px">
              ${labels[idx] ?? "item"}
            </span>
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

/**
 * @param {unknown} node
 * @param {(node: unknown) => void} onChange
 * @param {{
 *   stateDefs: string[];
 *   allowEventRef: boolean;
 *   depth?: number;
 * }} opts
 * @returns {import("lit-html").TemplateResult}
 */
export function renderExpressionEditor(
  node: unknown,
  onChange: (node: unknown) => void,
  opts: { stateDefs: string[]; allowEventRef: boolean; depth?: number },
): TemplateResult {
  const depth = opts.depth ?? 0;
  const safeNode: Record<string, unknown> =
    node && typeof node === "object"
      ? (node as Record<string, unknown>)
      : { operator: "=", target: null };
  const op = (safeNode.operator as string) || "=";
  const info = operatorInfo(op);

  const nestStyle =
    depth > 0
      ? "border-left:2px solid var(--spectrum-gray-300, #3c3c3c);margin-left:8px;padding-left:8px;"
      : "";

  return html`
    <div class="expression-editor" style=${nestStyle}>
      ${renderFieldRow({
        hasValue: false,
        label: "Operator",
        prop: "operator",
        widget: html`
          <sp-picker
            size="s"
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
                  updated.value = val?.operator ? safeNode.value : { operator: "!", target: null };
                } else if (newInfo.spliceArray) {
                  updated.value = Array.isArray(safeNode.value) ? safeNode.value : [null];
                } else {
                  updated.value = safeNode.value ?? null;
                }
              }
              if (newInfo.needsInitial) {
                updated.initial = safeNode.initial ?? 0;
              }
              onChange(updated);
            }}
          >
            ${_operatorMenuCache}
          </sp-picker>
        `,
      })}
      ${renderFieldRow({
        hasValue: false,
        label: "Target",
        prop: "target",
        widget: renderOperandEditor(safeNode.target, (t) => onChange({ ...safeNode, target: t }), {
          ...opts,
          depth,
          mustBeRef: info.targetMustBeRef,
        }),
      })}
      ${info.needsValue && !info.valueIsNode && !info.spliceArray
        ? renderFieldRow({
            hasValue: false,
            label: "Value",
            prop: "value",
            widget: renderOperandEditor(
              safeNode.value,
              (v) => onChange({ ...safeNode, value: v }),
              { ...opts, depth, mustBeRef: false },
            ),
          })
        : nothing}
      ${info.needsValue && info.valueIsNode
        ? html`
            <div style="margin-top:4px">
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
                { ...opts, depth: depth + 1 },
              )}
            </div>
          `
        : nothing}
      ${info.spliceArray
        ? html`
            <div style="margin-top:4px">
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
        : nothing}
      ${info.needsInitial
        ? renderFieldRow({
            hasValue: false,
            label: "Initial",
            prop: "initial",
            widget: renderOperandEditor(
              safeNode.initial,
              (v) => onChange({ ...safeNode, initial: v }),
              { ...opts, depth, mustBeRef: false },
            ),
          })
        : nothing}
    </div>
  `;
}
