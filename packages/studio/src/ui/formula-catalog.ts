/**
 * Formula catalog — the metadata registry behind the formula palette, chip labels, and Monaco
 * completions (spec §19). Merges three sources into one uniform entry shape:
 *
 * 1. Blessed operators (hand-authored metadata for every member of `BLESSED_OPERATORS`),
 * 2. Blessed pure globals (derived programmatically from `BLESSED_GLOBALS`),
 * 3. Named formulas (derived from document state via `isNamedFormulaDef`).
 *
 * Pure data + factories — no DOM. Descriptions reference genuine ECMA semantics (naming law: no
 * token is invented).
 */

import { BLESSED_GLOBALS, BLESSED_OPERATORS } from "@jxsuite/runtime/expression";
import { isJsonObject, isNamedFormulaDef } from "@jxsuite/schema/guards";

import type {
  CemParameter,
  JxExpressionNode,
  JxExpressionOperand,
  JxStateDefinition,
} from "@jxsuite/schema/types";
import type { JsonValue } from "../types";

export interface FormulaParameterInfo {
  name: string;
  /** Display string for the parameter type (CEM `{ text }` or JSON Schema `type`). */
  type?: string;
  description?: string;
  default?: JsonValue;
}

export interface FormulaCatalogEntry {
  /** Stable identifier: operator token, global path ("Math/max"), or state key. */
  name: string;
  /** Display label: operator token, dotted global ("Math.max"), or state key. */
  label: string;
  /** Palette group heading; operator groups mirror the expression editor's. */
  group: string;
  kind: "operator" | "global" | "formula";
  description: string;
  parameters: FormulaParameterInfo[];
  /** Factory for a fresh default expression node inserting this entry. */
  insert: () => JxExpressionNode;
}

// ─── Blessed operators (hand-authored) ──────────────────────────────────────

interface OperatorMeta {
  group: string;
  description: string;
  parameters: FormulaParameterInfo[];
  insert: () => JxExpressionNode;
}

const REF_TARGET = { description: "Writable pointer the operation applies to", name: "target" };
const LEFT = { description: "Left operand", name: "target" };
const RIGHT = { description: "Right operand", name: "value" };

function assignMeta(op: string, verb: string): OperatorMeta {
  return {
    description: `${verb} assignment operator (ECMA \`${op}\`): stores the result at the target pointer.`,
    group: "Assignment",
    insert: () => ({ operator: op, target: { $ref: "" }, value: null }),
    parameters: [REF_TARGET, { description: "Value assigned to the target", name: "value" }],
  };
}

function binaryMeta(group: string, op: string, description: string): OperatorMeta {
  return {
    description,
    group,
    insert: () => ({ operator: op, target: null, value: null }),
    parameters: [LEFT, RIGHT],
  };
}

function arrayMeta(op: string, description: string, withValue: boolean): OperatorMeta {
  return {
    description,
    group: "Array methods",
    insert: () =>
      withValue
        ? { operator: op, target: { $ref: "" }, value: null }
        : { operator: op, target: { $ref: "" } },
    parameters: withValue
      ? [REF_TARGET, { description: "Element to add", name: "value" }]
      : [REF_TARGET],
  };
}

function aggregateMeta(op: string, description: string, withInitial: boolean): OperatorMeta {
  const node: JxExpressionNode = {
    operator: op,
    target: { $ref: "" },
    value: { operator: "!", target: null },
  };
  return {
    description,
    group: "Aggregate",
    insert: () => (withInitial ? { ...node, initial: 0 } : { ...node }),
    parameters: [
      { description: "Array pointer to iterate", name: "target" },
      { description: "Per-item expression ($map/item, $map/index)", name: "value" },
      ...(withInitial
        ? [{ description: "Initial accumulator ($reduce/acc)", name: "initial" }]
        : []),
    ],
  };
}

const OPERATOR_META: Record<string, OperatorMeta> = {
  "!": {
    description: "Logical NOT operator (ECMA `!`): coerces the operand to boolean and negates it.",
    group: "Unary",
    insert: () => ({ operator: "!", target: null }),
    parameters: [{ description: "Operand to negate", name: "target" }],
  },
  "!==": binaryMeta(
    "Comparison",
    "!==",
    "Strict inequality operator (ECMA `!==`): true when the operands differ without coercion.",
  ),
  "%": binaryMeta(
    "Arithmetic",
    "%",
    "Remainder operator (ECMA `%`): remainder of dividing the left operand by the right.",
  ),
  "&&": binaryMeta(
    "Logical",
    "&&",
    "Logical AND operator (ECMA `&&`): yields the right operand when the left is truthy.",
  ),
  "*": binaryMeta(
    "Arithmetic",
    "*",
    "Multiplication operator (ECMA `*`): numeric product of the operands.",
  ),
  "*=": assignMeta("*=", "Multiplication"),
  "+": binaryMeta(
    "Arithmetic",
    "+",
    "Addition operator (ECMA `+`): numeric addition, or string concatenation.",
  ),
  "+=": assignMeta("+=", "Addition"),
  "-": binaryMeta(
    "Arithmetic",
    "-",
    "Subtraction operator (ECMA `-`); with no value operand it is unary negation.",
  ),
  "-=": assignMeta("-=", "Subtraction"),
  "/": binaryMeta("Arithmetic", "/", "Division operator (ECMA `/`): quotient of the operands."),
  "/=": assignMeta("/=", "Division"),
  "<": binaryMeta(
    "Comparison",
    "<",
    "Less-than operator (ECMA `<`): relational comparison of the operands.",
  ),
  "<=": binaryMeta(
    "Comparison",
    "<=",
    "Less-than-or-equal operator (ECMA `<=`): relational comparison of the operands.",
  ),
  "=": assignMeta("=", "Simple"),
  "===": binaryMeta(
    "Comparison",
    "===",
    "Strict equality operator (ECMA `===`): true when the operands are equal without coercion.",
  ),
  ">": binaryMeta(
    "Comparison",
    ">",
    "Greater-than operator (ECMA `>`): relational comparison of the operands.",
  ),
  ">=": binaryMeta(
    "Comparison",
    ">=",
    "Greater-than-or-equal operator (ECMA `>=`): relational comparison of the operands.",
  ),
  "??": binaryMeta(
    "Logical",
    "??",
    "Nullish coalescing operator (ECMA `??`): yields the right operand when the left is null or undefined.",
  ),
  "?:": {
    description:
      "Conditional operator (ECMA `?:`): evaluates the test in target, yielding value when truthy, initial otherwise.",
    group: "Conditional",
    insert: () => ({ initial: null, operator: "?:", target: null, value: null }),
    parameters: [
      { description: "Test condition", name: "target" },
      { description: "Result when the test is truthy", name: "value" },
      { description: "Result when the test is falsy", name: "initial" },
    ],
  },
  "||": binaryMeta(
    "Logical",
    "||",
    "Logical OR operator (ECMA `||`): yields the right operand when the left is falsy.",
  ),
  call: {
    description:
      "Function.prototype.call (ECMA): invokes a named formula (#/state/…) or blessed pure global (window#/…) with positional arguments.",
    group: "Function",
    insert: () => ({ operator: "call", target: { $ref: "" }, value: [] }),
    parameters: [
      { description: "Callee pointer: #/state/<formula> or window#/<global>", name: "target" },
      { description: "Positional argument list", name: "value" },
    ],
  },
  filter: aggregateMeta(
    "filter",
    "Array.prototype.filter (ECMA): keeps elements whose per-item expression is truthy.",
    false,
  ),
  map: aggregateMeta(
    "map",
    "Array.prototype.map (ECMA): transforms each element via the per-item expression.",
    false,
  ),
  pop: arrayMeta(
    "pop",
    "Array.prototype.pop (ECMA): removes and returns the last element of the target array.",
    false,
  ),
  push: arrayMeta(
    "push",
    "Array.prototype.push (ECMA): appends the value to the target array.",
    true,
  ),
  reduce: aggregateMeta(
    "reduce",
    "Array.prototype.reduce (ECMA): folds the array into an accumulator via the per-item expression.",
    true,
  ),
  shift: arrayMeta(
    "shift",
    "Array.prototype.shift (ECMA): removes and returns the first element of the target array.",
    false,
  ),
  splice: {
    description:
      "Array.prototype.splice (ECMA): removes and/or inserts elements at an index of the target array.",
    group: "Array methods",
    insert: () => ({ operator: "splice", target: { $ref: "" }, value: [null] }),
    parameters: [
      REF_TARGET,
      { description: "Arguments: start, deleteCount, items…", name: "value" },
    ],
  },
  switch: {
    description:
      "Switch selection (ECMA `switch` semantics): matches the target's string form against case keys, falling back to default.",
    group: "Conditional",
    insert: () => ({ cases: {}, default: null, operator: "switch", target: null }),
    parameters: [
      { description: "Discriminant value", name: "target" },
      { description: "Matched value → result operand map", name: "cases" },
      { description: "Result when no case matches", name: "default" },
    ],
  },
  unshift: arrayMeta(
    "unshift",
    "Array.prototype.unshift (ECMA): prepends the value to the target array.",
    true,
  ),
};

/** Catalog entries for every blessed operator, in `BLESSED_OPERATORS` iteration order. */
export function operatorEntries(): FormulaCatalogEntry[] {
  const out: FormulaCatalogEntry[] = [];
  for (const op of BLESSED_OPERATORS) {
    const meta = OPERATOR_META[op];
    if (!meta) {
      continue;
    }
    out.push({
      description: meta.description,
      group: meta.group,
      insert: meta.insert,
      kind: "operator",
      label: op,
      name: op,
      parameters: meta.parameters,
    });
  }
  return out;
}

// ─── Blessed globals (derived) ──────────────────────────────────────────────

/** Catalog entries derived from `BLESSED_GLOBALS`; grouped by namespace (bare → globalThis). */
export function globalEntries(): FormulaCatalogEntry[] {
  const out: FormulaCatalogEntry[] = [];
  for (const name of BLESSED_GLOBALS) {
    const slash = name.indexOf("/");
    const group = slash === -1 ? "globalThis" : name.slice(0, slash);
    const label = name.replaceAll("/", ".");
    out.push({
      description: `${label} — blessed pure global from the ECMAScript standard library, invoked via the call operator (window#/${name}).`,
      group,
      insert: () => ({ operator: "call", target: { $ref: `window#/${name}` }, value: [] }),
      kind: "global",
      label,
      name,
      parameters: [],
    });
  }
  return out;
}

// ─── Named formulas (derived from document state) ───────────────────────────

/** Normalize a `(string | CemParameter)` parameter declaration to display metadata. */
function toParameterInfo(p: string | CemParameter): FormulaParameterInfo | null {
  if (typeof p === "string") {
    return p ? { name: p } : null;
  }
  if (!isJsonObject(p) || typeof p.name !== "string" || !p.name) {
    return null;
  }
  const info: FormulaParameterInfo = { name: p.name };
  const { type } = p;
  if (typeof type === "string") {
    info.type = type;
  } else if (isJsonObject(type)) {
    if (typeof type.text === "string") {
      info.type = type.text;
    } else if (typeof type.type === "string") {
      info.type = type.type;
    }
  }
  if (typeof p.description === "string") {
    info.description = p.description;
  }
  if ("default" in p && p.default !== undefined) {
    info.default = p.default as JsonValue;
  }
  return info;
}

/** Catalog entries for the document's named formulas (parameterized `$expression` entries). */
export function namedFormulaEntries(
  state?: Record<string, JxStateDefinition> | null,
): FormulaCatalogEntry[] {
  const out: FormulaCatalogEntry[] = [];
  for (const [key, def] of Object.entries(state ?? {})) {
    if (!isNamedFormulaDef(def)) {
      continue;
    }
    const parameters = (def.parameters as (string | CemParameter)[])
      .map((p) => toParameterInfo(p))
      .filter((p): p is FormulaParameterInfo => p !== null);
    const description =
      typeof def.description === "string" && def.description
        ? def.description
        : typeof def.$title === "string" && def.$title
          ? def.$title
          : `Named formula "${key}" from document state.`;
    out.push({
      description,
      group: "Formulas",
      insert: () => ({
        operator: "call",
        target: { $ref: `#/state/${key}` },
        value: parameters.map((p) => (p.default ?? null) as JxExpressionOperand),
      }),
      kind: "formula",
      label: key,
      name: key,
      parameters,
    });
  }
  return out;
}

// ─── Merged registry ────────────────────────────────────────────────────────

/** The full catalog: named formulas first (most specific), then operators, then globals. */
export function formulaCatalog(
  state?: Record<string, JxStateDefinition> | null,
): FormulaCatalogEntry[] {
  return [...namedFormulaEntries(state), ...operatorEntries(), ...globalEntries()];
}

/** Resolve a `call` callee pointer to its catalog entry, when resolvable. */
export function calleeEntry(
  ref: string,
  state?: Record<string, JxStateDefinition> | null,
): FormulaCatalogEntry | undefined {
  if (ref.startsWith("window#/")) {
    const name = ref.slice("window#/".length);
    return globalEntries().find((e) => e.name === name);
  }
  if (ref.startsWith("#/state/")) {
    const key = ref.slice("#/state/".length);
    return namedFormulaEntries(state).find((e) => e.name === key);
  }
  return undefined;
}
