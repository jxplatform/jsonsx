/**
 * Jx Declarative Expression Engine (spec §19)
 *
 * Shared module used by both runtime (evaluateExpression) and compiler (compileExpression).
 *
 * @module expression
 */

/** @typedef {{ operator: string; target: any; value?: any; initial?: any }} ExpressionNode */

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
export function isMutating(op) {
  return MUTATING_OPS.has(op);
}

// ─── Runtime Evaluation ──────────────────────────────────────────────────────

/**
 * Resolve an operand to its runtime value.
 *
 * @param {any} operand
 * @param {Record<string, any>} state
 * @param {Event | null} event
 * @param {{ acc?: any; item?: any; index?: number }} [iterCtx]
 * @returns {any}
 */
function resolveOperand(operand, state, event, iterCtx) {
  if (operand === null || operand === undefined) return operand;

  // Nested expression node
  if (typeof operand === "object" && !Array.isArray(operand) && "operator" in operand) {
    return evaluateExpression(operand, state, event, iterCtx);
  }

  // $ref pointer
  if (typeof operand === "object" && !Array.isArray(operand) && "$ref" in operand) {
    return resolveExprRef(operand.$ref, state, event, iterCtx);
  }

  // Array of operands (e.g., splice args)
  if (Array.isArray(operand)) {
    return operand.map((o) => resolveOperand(o, state, event, iterCtx));
  }

  // Literal
  return operand;
}

/**
 * Resolve a $ref string within expression context. Handles event#/, $reduce/acc, $map/, #/state/,
 * and other schemes.
 *
 * @param {string} ref
 * @param {Record<string, any>} state
 * @param {Event | null} event
 * @param {{ acc?: any; item?: any; index?: number }} [iterCtx]
 * @returns {any}
 */
function resolveExprRef(ref, state, event, iterCtx) {
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
    if (key === "item") base = iterCtx?.item ?? state.$map?.item ?? state["$map/item"];
    else if (key === "index") base = iterCtx?.index ?? state.$map?.index ?? state["$map/index"];
    else base = state.$map?.[key] ?? state["$map/" + key];
    return parts.length > 2 ? getPath(base, parts.slice(2).join("/")) : base;
  }
  if (ref.startsWith("#/state/")) {
    const sub = ref.slice("#/state/".length);
    const slash = sub.indexOf("/");
    if (slash < 0) return state[sub];
    return getPath(state[sub.slice(0, slash)], sub.slice(slash + 1));
  }
  if (ref.startsWith("parent#/")) return state[ref.slice("parent#/".length)];
  if (ref.startsWith("window#/")) return getPath(globalThis.window, ref.slice("window#/".length));
  if (ref.startsWith("document#/"))
    return getPath(globalThis.document, ref.slice("document#/".length));
  return state[ref] ?? null;
}

/**
 * Resolve a $ref to a writable location — returns { obj, key } for assignment.
 *
 * @param {string} ref
 * @param {Record<string, any>} state
 * @param {Event | null} event
 * @param {{ acc?: any; item?: any; index?: number }} [iterCtx]
 * @returns {{ obj: any; key: string }}
 */
function resolveWritableRef(ref, state, event, iterCtx) {
  if (ref.startsWith("$map/")) {
    const parts = ref.split("/");
    const key = parts[1];
    let base;
    if (key === "item") base = iterCtx?.item ?? state.$map?.item ?? state["$map/item"];
    else if (key === "index") base = iterCtx?.index ?? state.$map?.index ?? state["$map/index"];
    else base = state.$map?.[key] ?? state["$map/" + key];
    if (parts.length > 2) {
      const pathParts = parts.slice(2);
      const lastKey = pathParts.pop();
      const obj = pathParts.length > 0 ? getPath(base, pathParts.join("/")) : base;
      return { obj, key: /** @type {string} */ (lastKey) };
    }
    return { obj: state.$map ?? state, key: key === "item" ? "$map/item" : "$map/index" };
  }
  if (ref.startsWith("#/state/")) {
    const sub = ref.slice("#/state/".length);
    const slash = sub.indexOf("/");
    if (slash < 0) return { obj: state, key: sub };
    const parts = sub.split("/");
    const lastKey = parts.pop();
    let obj = state;
    for (const p of parts) obj = obj[p];
    return { obj, key: /** @type {string} */ (lastKey) };
  }
  return { obj: state, key: ref };
}

/**
 * Evaluate an expression node at runtime.
 *
 * @param {ExpressionNode} node
 * @param {Record<string, any>} state
 * @param {Event | null} event
 * @param {{ acc?: any; item?: any; index?: number }} [iterCtx]
 * @returns {any}
 */
export function evaluateExpression(node, state, event, iterCtx) {
  const { operator, target, value, initial } = node;

  if (!BLESSED_OPERATORS.has(operator)) {
    throw new Error(`$expression: unknown operator "${operator}"`);
  }

  // ─── Unary ───
  if (UNARY_OPS.has(operator) && !("value" in node)) {
    const operand = resolveOperand(target, state, event, iterCtx);
    if (operator === "!") return !operand;
    if (operator === "-") return -operand;
  }

  // ─── Binary (pure) ───
  if (BINARY_OPS.has(operator)) {
    const left = resolveOperand(target, state, event, iterCtx);
    const right = resolveOperand(value, state, event, iterCtx);
    switch (operator) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return left / right;
      case "%":
        return left % right;
      case "===":
        return left === right;
      case "!==":
        return left !== right;
      case "<":
        return left < right;
      case "<=":
        return left <= right;
      case ">":
        return left > right;
      case ">=":
        return left >= right;
      case "&&":
        return left && right;
      case "||":
        return left || right;
    }
  }

  // ─── Assignment ───
  if (ASSIGNMENT_OPS.has(operator)) {
    const rhs = resolveOperand(value, state, event, iterCtx);
    const { obj, key } = resolveWritableRef(target.$ref, state, event, iterCtx);
    switch (operator) {
      case "=":
        obj[key] = rhs;
        break;
      case "+=":
        obj[key] += rhs;
        break;
      case "-=":
        obj[key] -= rhs;
        break;
      case "*=":
        obj[key] *= rhs;
        break;
      case "/=":
        obj[key] /= rhs;
        break;
    }
    return;
  }

  // ─── Array methods ───
  if (ARRAY_METHOD_OPS.has(operator)) {
    const arr = resolveOperand(target, state, event, iterCtx);
    switch (operator) {
      case "push":
        return arr.push(resolveOperand(value, state, event, iterCtx));
      case "unshift":
        return arr.unshift(resolveOperand(value, state, event, iterCtx));
      case "pop":
        return arr.pop();
      case "shift":
        return arr.shift();
      case "splice": {
        const args = resolveOperand(value, state, event, iterCtx);
        return arr.splice(...args);
      }
    }
  }

  // ─── Aggregates (pure) ───
  if (AGGREGATE_OPS.has(operator)) {
    const arr = resolveOperand(target, state, event, iterCtx);
    if (operator === "reduce") {
      const seed = resolveOperand(initial, state, event, iterCtx);
      return arr.reduce(
        (/** @type {any} */ acc, /** @type {any} */ item, /** @type {number} */ index) => {
          return evaluateExpression(value, state, event, { acc, item, index });
        },
        seed,
      );
    }
    if (operator === "map") {
      return arr.map((/** @type {any} */ item, /** @type {number} */ index) => {
        return evaluateExpression(value, state, event, { ...iterCtx, item, index });
      });
    }
    if (operator === "filter") {
      return arr.filter((/** @type {any} */ item, /** @type {number} */ index) => {
        return evaluateExpression(value, state, event, { ...iterCtx, item, index });
      });
    }
  }
}

// ─── Compiler: Expression → JS Source ────────────────────────────────────────

/** @typedef {{ statePrefix?: string; eventParam?: string }} CompileOpts */

/**
 * Compile an operand to a JS source string.
 *
 * @param {any} operand
 * @param {CompileOpts} opts
 * @returns {string}
 */
function compileOperand(operand, opts) {
  if (operand === null) return "null";
  if (operand === undefined) return "undefined";

  // Nested expression node
  if (typeof operand === "object" && !Array.isArray(operand) && "operator" in operand) {
    return compileExpression(operand, opts);
  }

  // $ref pointer
  if (typeof operand === "object" && !Array.isArray(operand) && "$ref" in operand) {
    return compileRef(operand.$ref, opts);
  }

  // Array of operands
  if (Array.isArray(operand)) {
    return operand.map((o) => compileOperand(o, opts)).join(", ");
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
function compileRef(ref, opts) {
  const s = opts.statePrefix ?? "state";
  const e = opts.eventParam ?? "event";

  if (ref === "$reduce/acc") return "_acc";
  if (ref.startsWith("$reduce/")) return "_acc";

  if (ref.startsWith("event#/")) {
    const path = ref.slice("event#/".length);
    return `${e}.${path.replace(/\//g, ".")}`;
  }

  if (ref.startsWith("$map/")) {
    const parts = ref.split("/");
    const key = parts[1];
    if (key === "item") {
      return parts.length > 2 ? `_item.${parts.slice(2).join(".")}` : "_item";
    }
    if (key === "index") return "_index";
    return `_${key}`;
  }

  if (ref.startsWith("#/state/")) {
    const path = ref.slice("#/state/".length);
    return `${s}.${path.replace(/\//g, ".")}`;
  }

  if (ref.startsWith("parent#/")) return `${s}.${ref.slice("parent#/".length)}`;
  if (ref.startsWith("window#/"))
    return `window.${ref.slice("window#/".length).replace(/\//g, ".")}`;
  if (ref.startsWith("document#/"))
    return `document.${ref.slice("document#/".length).replace(/\//g, ".")}`;

  return `${s}.${ref}`;
}

/**
 * Compile a writable $ref target to its JS equivalent (for LHS of assignment).
 *
 * @param {any} target
 * @param {CompileOpts} opts
 * @returns {string}
 */
function compileTarget(target, opts) {
  if (typeof target === "object" && "$ref" in target) {
    return compileRef(target.$ref, opts);
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
export function compileExpression(node, opts = {}) {
  const { operator, target, value, initial } = node;

  // ─── Unary ───
  if (UNARY_OPS.has(operator) && !("value" in node)) {
    const operand = compileOperand(target, opts);
    if (operator === "!") return `!(${operand})`;
    if (operator === "-") return `-(${operand})`;
  }

  // ─── Binary (pure) ───
  if (BINARY_OPS.has(operator)) {
    const left = compileOperand(target, opts);
    const right = compileOperand(value, opts);
    return `(${left} ${operator} ${right})`;
  }

  // ─── Assignment ───
  if (ASSIGNMENT_OPS.has(operator)) {
    const lhs = compileTarget(target, opts);
    const rhs = compileOperand(value, opts);
    return `${lhs} ${operator} ${rhs}`;
  }

  // ─── Array methods ───
  if (ARRAY_METHOD_OPS.has(operator)) {
    const arr = compileTarget(target, opts);
    switch (operator) {
      case "push":
        return `${arr}.push(${compileOperand(value, opts)})`;
      case "unshift":
        return `${arr}.unshift(${compileOperand(value, opts)})`;
      case "pop":
        return `${arr}.pop()`;
      case "shift":
        return `${arr}.shift()`;
      case "splice": {
        const args = Array.isArray(value)
          ? value.map((o) => compileOperand(o, opts)).join(", ")
          : compileOperand(value, opts);
        return `${arr}.splice(${args})`;
      }
    }
  }

  // ─── Aggregates (pure) ───
  if (AGGREGATE_OPS.has(operator)) {
    const arr = compileOperand(target, opts);
    const itemExpr = compileExpression(value, opts);
    if (operator === "reduce") {
      const seed = compileOperand(initial, opts);
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

/**
 * @param {any} obj
 * @param {string} path
 * @returns {any}
 */
function getPath(obj, path) {
  return path.split(/[./]/).reduce((o, k) => /** @type {any} */ (o)?.[k], obj);
}
