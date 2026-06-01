import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { renderFieldRow } from "./field-row.js";

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
  { label: "Array methods", ops: ["push", "pop", "shift", "unshift", "splice"] },
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
function operatorInfo(op) {
  if (UNARY_OPS.has(op))
    return {
      needsValue: false,
      needsInitial: false,
      targetMustBeRef: false,
      spliceArray: false,
      valueIsNode: false,
    };
  if (BINARY_OPS.has(op))
    return {
      needsValue: true,
      needsInitial: false,
      targetMustBeRef: false,
      spliceArray: false,
      valueIsNode: false,
    };
  if (ASSIGN_OPS.has(op))
    return {
      needsValue: true,
      needsInitial: false,
      targetMustBeRef: true,
      spliceArray: false,
      valueIsNode: false,
    };
  if (NO_ARG_OPS.has(op))
    return {
      needsValue: false,
      needsInitial: false,
      targetMustBeRef: true,
      spliceArray: false,
      valueIsNode: false,
    };
  if (ONE_ARG_OPS.has(op))
    return {
      needsValue: true,
      needsInitial: false,
      targetMustBeRef: true,
      spliceArray: false,
      valueIsNode: false,
    };
  if (op === "splice")
    return {
      needsValue: true,
      needsInitial: false,
      targetMustBeRef: true,
      spliceArray: true,
      valueIsNode: false,
    };
  if (op === "reduce")
    return {
      needsValue: true,
      needsInitial: true,
      targetMustBeRef: true,
      spliceArray: false,
      valueIsNode: true,
    };
  if (op === "map" || op === "filter")
    return {
      needsValue: true,
      needsInitial: false,
      targetMustBeRef: true,
      spliceArray: false,
      valueIsNode: true,
    };
  return {
    needsValue: false,
    needsInitial: false,
    targetMustBeRef: false,
    spliceArray: false,
    valueIsNode: false,
  };
}

// ─── Operand Mode Detection ─────────────────────────────────────────────────

/**
 * @param {any} operand
 * @returns {"ref" | "expression" | "literal"}
 */
function operandMode(operand) {
  if (operand && typeof operand === "object") {
    if ("$ref" in operand) return "ref";
    if ("operator" in operand) return "expression";
  }
  return "literal";
}

/**
 * @param {string} mode
 * @returns {any}
 */
function defaultForMode(mode) {
  if (mode === "ref") return { $ref: "" };
  if (mode === "expression") return { operator: "!", target: null };
  return null;
}

// ─── Literal Type Detection ─────────────────────────────────────────────────

/**
 * @param {any} val
 * @returns {"string" | "number" | "boolean" | "null"}
 */
function literalType(val) {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean") return "boolean";
  if (typeof val === "number") return "number";
  return "string";
}

/**
 * @param {string} type
 * @returns {any}
 */
function defaultForLiteralType(type) {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "null") return null;
  return "";
}

// ─── Hint (one-line summary for signal rows) ────────────────────────────────

/**
 * @param {any} node
 * @returns {string}
 */
export function expressionHint(node) {
  if (!node || !node.operator) return "$expression";
  const op = node.operator;
  const targetLabel = node.target?.$ref
    ? node.target.$ref.replace("#/state/", "")
    : node.target?.operator
      ? `(${node.target.operator}…)`
      : String(node.target ?? "?");

  if (ASSIGN_OPS.has(op) || ONE_ARG_OPS.has(op)) return `${op} ${targetLabel}`;
  if (NO_ARG_OPS.has(op)) return `${op}(${targetLabel})`;
  if (op === "splice") return `splice(${targetLabel})`;
  if (op === "reduce" || op === "map" || op === "filter") return `${op}(${targetLabel})`;
  if (UNARY_OPS.has(op)) return `${op}${targetLabel}`;
  return `${targetLabel} ${op} …`;
}

// ─── Ref Picker ─────────────────────────────────────────────────────────────

/**
 * @param {string} refVal
 * @param {(newRef: string) => void} onRefChange
 * @param {{ stateDefs: string[]; allowEventRef: boolean }} opts
 * @returns {import("lit-html").TemplateResult}
 */
function renderRefPicker(refVal, onRefChange, opts) {
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
      @change=${(/** @type {Event} */ e) => {
        const val = /** @type {HTMLInputElement} */ (e.target).value;
        if (val === "__custom__") return;
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
 * @param {any} operand
 * @param {(newVal: any) => void} onChange
 * @returns {import("lit-html").TemplateResult}
 */
function renderLiteralEditor(operand, onChange) {
  const type = literalType(operand);
  return html`
    <div style="display:flex;gap:4px;align-items:center;flex:1">
      <sp-picker
        size="s"
        style="min-width:56px"
        .value=${live(type)}
        @change=${(/** @type {Event} */ e) => {
          const newType = /** @type {HTMLInputElement} */ (e.target).value;
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
            @input=${(/** @type {Event} */ e) =>
              onChange(/** @type {HTMLInputElement} */ (e.target).value)}
          ></sp-textfield>`
        : type === "number"
          ? html`<sp-number-field
              size="s"
              style="flex:1"
              .value=${live(Number(operand ?? 0))}
              @change=${(/** @type {Event} */ e) =>
                onChange(Number(/** @type {HTMLInputElement} */ (e.target).value))}
            ></sp-number-field>`
          : type === "boolean"
            ? html`<sp-checkbox
                size="s"
                ?checked=${!!operand}
                @change=${(/** @type {Event} */ e) =>
                  onChange(/** @type {HTMLInputElement} */ (e.target).checked)}
                >true</sp-checkbox
              >`
            : html`<span style="font-size:12px;color:var(--spectrum-global-color-gray-600)"
                >null</span
              >`}
    </div>
  `;
}

// ─── Operand Editor ─────────────────────────────────────────────────────────

/**
 * @param {any} operand
 * @param {(newOperand: any) => void} onChange
 * @param {{
 *   stateDefs: string[];
 *   allowEventRef: boolean;
 *   depth: number;
 *   mustBeRef?: boolean;
 * }} opts
 * @returns {import("lit-html").TemplateResult}
 */
function renderOperandEditor(operand, onChange, opts) {
  if (opts.mustBeRef) {
    const refVal = operand?.$ref ?? "";
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
        @change=${(/** @type {Event} */ e) => {
          const newMode = /** @type {HTMLInputElement} */ (e.target).value;
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
          ? renderRefPicker(operand?.$ref ?? "", (r) => onChange({ $ref: r }), opts)
          : renderExpressionEditor(operand, onChange, { ...opts, depth: opts.depth + 1 })}
    </div>
  `;
}

// ─── Splice Args Editor ─────────────────────────────────────────────────────

/**
 * @param {any[]} args
 * @param {(newArgs: any[]) => void} onChange
 * @param {{ stateDefs: string[]; allowEventRef: boolean; depth: number }} opts
 * @returns {import("lit-html").TemplateResult}
 */
function renderSpliceArgsEditor(args, onChange, opts) {
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
            <span style="font-size:10px;color:var(--spectrum-global-color-gray-600);min-width:30px">
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
 * @param {any} node
 * @param {(node: any) => void} onChange
 * @param {{
 *   stateDefs: string[];
 *   allowEventRef: boolean;
 *   depth?: number;
 * }} opts
 * @returns {import("lit-html").TemplateResult}
 */
export function renderExpressionEditor(node, onChange, opts) {
  const depth = opts.depth ?? 0;
  const safeNode = node && typeof node === "object" ? node : { operator: "=", target: null };
  const op = safeNode.operator || "=";
  const info = operatorInfo(op);

  const nestStyle =
    depth > 0
      ? "border-left:2px solid var(--spectrum-global-color-gray-300);margin-left:8px;padding-left:8px;"
      : "";

  return html`
    <div class="expression-editor" style=${nestStyle}>
      ${renderFieldRow({
        prop: "operator",
        label: "Operator",
        hasValue: false,
        widget: html`
          <sp-picker
            size="s"
            .value=${live(op)}
            @change=${(/** @type {Event} */ e) => {
              const newOp = /** @type {HTMLInputElement} */ (e.target).value;
              const newInfo = operatorInfo(newOp);
              /** @type {any} */
              const updated = { operator: newOp, target: safeNode.target };
              if (newInfo.targetMustBeRef && operandMode(safeNode.target) !== "ref") {
                updated.target = { $ref: "" };
              }
              if (newInfo.needsValue) {
                if (newInfo.valueIsNode) {
                  updated.value = safeNode.value?.operator
                    ? safeNode.value
                    : { operator: "!", target: null };
                } else if (newInfo.spliceArray) {
                  updated.value = Array.isArray(safeNode.value) ? safeNode.value : [null];
                } else {
                  updated.value = safeNode.value ?? null;
                }
              }
              if (newInfo.needsInitial) updated.initial = safeNode.initial ?? 0;
              onChange(updated);
            }}
          >
            ${_operatorMenuCache}
          </sp-picker>
        `,
      })}
      ${renderFieldRow({
        prop: "target",
        label: "Target",
        hasValue: false,
        widget: renderOperandEditor(safeNode.target, (t) => onChange({ ...safeNode, target: t }), {
          ...opts,
          depth,
          mustBeRef: info.targetMustBeRef,
        }),
      })}
      ${info.needsValue && !info.valueIsNode && !info.spliceArray
        ? renderFieldRow({
            prop: "value",
            label: "Value",
            hasValue: false,
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
                prop: "value",
                label: "Per-item",
                hasValue: false,
                widget: nothing,
              })}
              ${renderExpressionEditor(
                safeNode.value?.operator ? safeNode.value : { operator: "!", target: null },
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
                prop: "value",
                label: "Args",
                hasValue: false,
                widget: nothing,
              })}
              ${renderSpliceArgsEditor(safeNode.value, (v) => onChange({ ...safeNode, value: v }), {
                ...opts,
                depth,
              })}
            </div>
          `
        : nothing}
      ${info.needsInitial
        ? renderFieldRow({
            prop: "initial",
            label: "Initial",
            hasValue: false,
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
