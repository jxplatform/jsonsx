/// <reference lib="dom" />
/**
 * Jx Declarative Expression Engine (spec §19)
 *
 * Shared module used by both runtime (evaluateExpression) and compiler (compileExpression).
 *
 * @module expression
 */

import type { JxExpressionNode, JxExpressionOperand } from "@jxsuite/schema/types";
import type { JxScope } from "./types.ts";

/** The runtime's expression node — the schema's expression model. */
export type ExpressionNode = JxExpressionNode;
export type ExpressionOperand = JxExpressionOperand;

/** The `$map` iteration context object stored in scope during mapped rendering. */
interface ScopeMapCtx {
  item?: unknown;
  index?: number;
  [key: string]: unknown;
}

/** View the scope's `$map` iteration context, if present. */
function scopeMap(state: JxScope): ScopeMapCtx | undefined {
  const map = state.$map;
  return map && typeof map === "object" ? (map as ScopeMapCtx) : undefined;
}

interface CompileOpts {
  statePrefix?: string;
  eventParam?: string;
}

const MUTATING_OPS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
]);
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
const ASSIGNMENT_OPS = new Set(["=", "+=", "-=", "*=", "/="]);
const ARRAY_METHOD_OPS = new Set(["push", "pop", "shift", "unshift", "splice"]);
const AGGREGATE_OPS = new Set(["reduce", "map", "filter"]);

export const BLESSED_OPERATORS = new Set([
  ...MUTATING_OPS,
  ...UNARY_OPS,
  ...BINARY_OPS,
  ...AGGREGATE_OPS,
]);

/**
 * @param {string} op
 * @returns {boolean}
 */
export function isMutating(op: string) {
  return MUTATING_OPS.has(op);
}

// ─── Runtime Evaluation ──────────────────────────────────────────────────────

interface IterCtx {
  acc?: unknown;
  item?: unknown;
  index?: number;
}

/** Resolve an operand to its runtime value. */
function resolveOperand(
  operand: unknown,
  state: JxScope,
  event: Event | null,
  iterCtx?: IterCtx,
): unknown {
  if (operand === null || operand === undefined) {
    return operand;
  }

  // Nested expression node
  if (typeof operand === "object" && !Array.isArray(operand) && "operator" in operand) {
    return evaluateExpression(operand as ExpressionNode, state, event, iterCtx);
  }

  // $ref pointer
  if (typeof operand === "object" && !Array.isArray(operand) && "$ref" in operand) {
    return resolveExprRef((operand as { $ref: string }).$ref, state, event, iterCtx);
  }

  // Array of operands (e.g., splice args)
  if (Array.isArray(operand)) {
    return operand.map((o: unknown) => resolveOperand(o, state, event, iterCtx));
  }

  // Literal
  return operand;
}

/** Resolve a $ref string within expression context. */
function resolveExprRef(ref: string, state: JxScope, event: Event | null, iterCtx?: IterCtx) {
  if (ref === "$reduce/acc") {
    return iterCtx?.acc;
  }
  if (ref.startsWith("$reduce/")) {
    return iterCtx?.acc;
  }
  if (ref.startsWith("event#/")) {
    const path = ref.slice("event#/".length);
    return getPath(event, path);
  }
  if (ref.startsWith("$map/")) {
    const parts = ref.split("/");
    const key = parts[1];
    let base;
    const map = scopeMap(state);
    if (key === "item") {
      base = iterCtx?.item ?? map?.item ?? state["$map/item"];
    } else if (key === "index") {
      base = iterCtx?.index ?? map?.index ?? state["$map/index"];
    } else {
      base = map?.[key] ?? state[`$map/${key}`];
    }
    return parts.length > 2 ? getPath(base, parts.slice(2).join("/")) : base;
  }
  if (ref.startsWith("#/state/")) {
    const sub = ref.slice("#/state/".length);
    const slash = sub.indexOf("/");
    if (slash === -1) {
      return state[sub];
    }
    return getPath(state[sub.slice(0, slash)], sub.slice(slash + 1));
  }
  if (ref.startsWith("parent#/")) {
    return state[ref.slice("parent#/".length)];
  }
  if (ref.startsWith("window#/")) {
    return getPath(globalThis.window, ref.slice("window#/".length));
  }
  if (ref.startsWith("document#/")) {
    return getPath(globalThis.document, ref.slice("document#/".length));
  }
  return state[ref] ?? null;
}

/** Resolve a $ref to a writable location — returns { obj, key } for assignment. */
function resolveWritableRef(
  ref: string,
  state: JxScope,
  event: Event | null,
  iterCtx?: IterCtx,
): { obj: JxScope; key: string } {
  if (ref.startsWith("$map/")) {
    const parts = ref.split("/");
    const key = parts[1];
    let base;
    const map = scopeMap(state);
    if (key === "item") {
      base = iterCtx?.item ?? map?.item ?? state["$map/item"];
    } else if (key === "index") {
      base = iterCtx?.index ?? map?.index ?? state["$map/index"];
    } else {
      base = map?.[key] ?? state[`$map/${key}`];
    }
    if (parts.length > 2) {
      const pathParts = parts.slice(2);
      const lastKey = pathParts.pop();
      const obj = pathParts.length > 0 ? getPath(base, pathParts.join("/")) : base;
      return { key: lastKey as string, obj: obj as JxScope };
    }
    return {
      key: key === "item" ? "$map/item" : "$map/index",
      obj: scopeMap(state) ?? state,
    };
  }
  if (ref.startsWith("#/state/")) {
    const sub = ref.slice("#/state/".length);
    const slash = sub.indexOf("/");
    if (slash === -1) {
      return { key: sub, obj: state };
    }
    const parts = sub.split("/");
    const lastKey = parts.pop();
    let obj = state;
    // Pointer paths address objects by construction (validated by the schema).
    for (const p of parts) {
      obj = obj[p] as JxScope;
    }
    return { key: lastKey as string, obj };
  }
  return { key: ref, obj: state };
}

/** Evaluate an expression node at runtime. */
export function evaluateExpression(
  node: ExpressionNode,
  state: JxScope,
  event: Event | null,
  iterCtx?: IterCtx,
): unknown {
  const { operator, target, value, initial } = node;

  if (!BLESSED_OPERATORS.has(operator)) {
    throw new Error(`$expression: unknown operator "${operator}"`);
  }

  // ─── Unary ───
  if (UNARY_OPS.has(operator) && !("value" in node)) {
    const operand: unknown = resolveOperand(target, state, event, iterCtx);
    if (operator === "!") {
      return !operand;
    }
    if (operator === "-") {
      return -(operand as number);
    }
  }

  // ─── Binary (pure) ───
  if (BINARY_OPS.has(operator)) {
    const left = resolveOperand(target, state, event, iterCtx) as number & string;
    const right = resolveOperand(value, state, event, iterCtx) as number & string;
    switch (operator) {
      case "+": {
        return left + right;
      }
      case "-": {
        return left - right;
      }
      case "*": {
        return left * right;
      }
      case "/": {
        return left / right;
      }
      case "%": {
        return left % right;
      }
      case "===": {
        return left === right;
      }
      case "!==": {
        return left !== right;
      }
      case "<": {
        return left < right;
      }
      case "<=": {
        return left <= right;
      }
      case ">": {
        return left > right;
      }
      case ">=": {
        return left >= right;
      }
      case "&&": {
        return left && right;
      }
      case "||": {
        return left || right;
      }
    }
  }

  // ─── Assignment ───
  if (ASSIGNMENT_OPS.has(operator)) {
    const rhs = resolveOperand(value, state, event, iterCtx) as number;
    const { obj, key } = resolveWritableRef(
      (target as { $ref: string }).$ref,
      state,
      event,
      iterCtx,
    );
    switch (operator) {
      case "=": {
        obj[key] = rhs;
        break;
      }
      case "+=": {
        obj[key] = (obj[key] as number) + rhs;
        break;
      }
      case "-=": {
        obj[key] = (obj[key] as number) - rhs;
        break;
      }
      case "*=": {
        obj[key] = (obj[key] as number) * rhs;
        break;
      }
      case "/=": {
        obj[key] = (obj[key] as number) / rhs;
        break;
      }
    }
    return;
  }

  // ─── Array methods ───
  if (ARRAY_METHOD_OPS.has(operator)) {
    const arr: unknown[] = resolveOperand(target, state, event, iterCtx) as unknown[];
    switch (operator) {
      case "push": {
        return arr.push(resolveOperand(value, state, event, iterCtx));
      }
      case "unshift": {
        return arr.unshift(resolveOperand(value, state, event, iterCtx));
      }
      case "pop": {
        return arr.pop();
      }
      case "shift": {
        return arr.shift();
      }
      case "splice": {
        const args: unknown[] = resolveOperand(value, state, event, iterCtx) as unknown[];
        return (arr.splice as (...a: unknown[]) => unknown[])(...args);
      }
    }
  }

  // ─── Aggregates (pure) ───
  if (AGGREGATE_OPS.has(operator)) {
    const arr: unknown[] = resolveOperand(target, state, event, iterCtx) as unknown[];
    if (operator === "reduce") {
      const seed: unknown = resolveOperand(initial, state, event, iterCtx);
      return arr.reduce(
        (acc: unknown, item: unknown, index: number) =>
          evaluateExpression(value as ExpressionNode, state, event, {
            acc,
            index,
            item,
          }),
        seed,
      );
    }
    if (operator === "map") {
      return arr.map((item: unknown, index: number) =>
        evaluateExpression(value as ExpressionNode, state, event, {
          ...iterCtx,
          index,
          item,
        }),
      );
    }
    if (operator === "filter") {
      return arr.filter((item: unknown, index: number) =>
        evaluateExpression(value as ExpressionNode, state, event, {
          ...iterCtx,
          index,
          item,
        }),
      );
    }
  }

  return undefined;
}

// ─── Compiler: Expression → JS Source ────────────────────────────────────────

/** Compile an operand to a JS source string. */
function compileOperand(operand: unknown, opts: CompileOpts): string {
  if (operand === null) {
    return "null";
  }
  if (operand === undefined) {
    return "undefined";
  }

  // Nested expression node
  if (typeof operand === "object" && !Array.isArray(operand) && "operator" in operand) {
    return compileExpression(operand as ExpressionNode, opts);
  }

  // $ref pointer
  if (typeof operand === "object" && !Array.isArray(operand) && "$ref" in operand) {
    return compileRef((operand as { $ref: string }).$ref, opts);
  }

  // Array of operands
  if (Array.isArray(operand)) {
    return operand.map((o: unknown) => compileOperand(o, opts)).join(", ");
  }

  // Literal
  return JSON.stringify(operand);
}

/**
 * Compile a $ref to its JS equivalent.
 *
 * @param {string} ref
 * @param {CompileOpts} opts
 * @returns {string}
 */
function compileRef(ref: string, opts: CompileOpts) {
  const s = opts.statePrefix ?? "state";
  const e = opts.eventParam ?? "event";

  if (ref === "$reduce/acc") {
    return "_acc";
  }
  if (ref.startsWith("$reduce/")) {
    return "_acc";
  }

  if (ref.startsWith("event#/")) {
    const path = ref.slice("event#/".length);
    return `${e}.${path.replaceAll("/", ".")}`;
  }

  if (ref.startsWith("$map/")) {
    const parts = ref.split("/");
    const key = parts[1];
    if (key === "item") {
      return parts.length > 2 ? `_item.${parts.slice(2).join(".")}` : "_item";
    }
    if (key === "index") {
      return "_index";
    }
    return `_${key}`;
  }

  if (ref.startsWith("#/state/")) {
    const path = ref.slice("#/state/".length);
    return `${s}.${path.replaceAll("/", ".")}`;
  }

  if (ref.startsWith("parent#/")) {
    return `${s}.${ref.slice("parent#/".length)}`;
  }
  if (ref.startsWith("window#/")) {
    return `window.${ref.slice("window#/".length).replaceAll("/", ".")}`;
  }
  if (ref.startsWith("document#/")) {
    return `document.${ref.slice("document#/".length).replaceAll("/", ".")}`;
  }

  return `${s}.${ref}`;
}

/** Compile a writable $ref target to its JS equivalent (for LHS of assignment). */
function compileTarget(target: unknown, opts: CompileOpts): string {
  if (typeof target === "object" && target !== null && "$ref" in target) {
    return compileRef((target as { $ref: string }).$ref, opts);
  }
  return compileOperand(target, opts);
}

/**
 * Compile an expression node to a JS source string. Returns a statement for mutating ops, a value
 * expression for pure ops.
 *
 * @param {ExpressionNode} node
 * @param {CompileOpts} [opts]
 * @returns {string}
 */
export function compileExpression(node: ExpressionNode, opts: CompileOpts = {}): string {
  const { operator, target, value, initial } = node;

  // ─── Unary ───
  if (UNARY_OPS.has(operator) && !("value" in node)) {
    const operand: string = compileOperand(target, opts);
    if (operator === "!") {
      return `!(${operand})`;
    }
    if (operator === "-") {
      return `-(${operand})`;
    }
  }

  // ─── Binary (pure) ───
  if (BINARY_OPS.has(operator)) {
    const left: string = compileOperand(target, opts);
    const right: string = compileOperand(value, opts);
    return `(${left} ${operator} ${right})`;
  }

  // ─── Assignment ───
  if (ASSIGNMENT_OPS.has(operator)) {
    const lhs: string = compileTarget(target, opts);
    const rhs: string = compileOperand(value, opts);
    return `${lhs} ${operator} ${rhs}`;
  }

  // ─── Array methods ───
  if (ARRAY_METHOD_OPS.has(operator)) {
    const arr: string = compileTarget(target, opts);
    switch (operator) {
      case "push": {
        return `${arr}.push(${compileOperand(value, opts)})`;
      }
      case "unshift": {
        return `${arr}.unshift(${compileOperand(value, opts)})`;
      }
      case "pop": {
        return `${arr}.pop()`;
      }
      case "shift": {
        return `${arr}.shift()`;
      }
      case "splice": {
        const args: string = Array.isArray(value)
          ? value.map((o: unknown) => compileOperand(o, opts)).join(", ")
          : compileOperand(value, opts);
        return `${arr}.splice(${args})`;
      }
    }
  }

  // ─── Aggregates (pure) ───
  if (AGGREGATE_OPS.has(operator)) {
    const arr: string = compileOperand(target, opts);
    const itemExpr: string = compileExpression(value as ExpressionNode, opts);
    if (operator === "reduce") {
      const seed: string = compileOperand(initial, opts);
      return `${arr}.reduce((_acc, _item, _index) => ${itemExpr}, ${seed})`;
    }
    if (operator === "map") {
      return `${arr}.map((_item, _index) => ${itemExpr})`;
    }
    if (operator === "filter") {
      return `${arr}.filter((_item, _index) => ${itemExpr})`;
    }
  }

  return "undefined";
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Resolve a dotted/slashed path on an object. */
function getPath(obj: unknown, path: string): unknown {
  return path.split(/[./]/).reduce((o, k) => (o as Record<string, unknown>)?.[k], obj);
}
