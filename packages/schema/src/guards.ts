/**
 * Type predicate guards for the Jx document model.
 *
 * These narrow `unknown`/union-typed values to precise domain types so call sites get real property
 * checking instead of casts. Every guard mirrors the runtime's actual detection logic (see
 * buildScope's five-shape algorithm in the runtime).
 */

import type {
  JsonObject,
  JsonValue,
  JxClassDef,
  JxElement,
  JxEventBinding,
  JxExpressionDef,
  JxFunctionDef,
  JxMappedArray,
  JxMutableNode,
  JxPrototypeDef,
  JxRef,
  JxServerFnDef,
  JxStateObject,
  JxStatement,
  JxStyle,
  JxTagExpression,
} from "../types";

// ─── JSON shape guards ──────────────────────────────────────────────────────────

/** A plain object: not null, not an array. The base check for all object-shaped defs. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Binding guards ─────────────────────────────────────────────────────────────

/** A `{ $ref: "#/..." }` JSON Pointer reference. */
export function isRef(value: unknown): value is JxRef {
  return isJsonObject(value) && typeof value.$ref === "string";
}

// ─── State definition guards (the five-shape algorithm) ────────────────────────

/** Shape 4: a function declaration — `{ $prototype: "Function", body | $src }`. */
export function isFunctionDef(value: unknown): value is JxFunctionDef {
  return isJsonObject(value) && value.$prototype === "Function";
}

/** Shape 5: a declarative expression entry — `{ $expression: { operator, target } }`. */
export function isExpressionDef(value: unknown): value is JxExpressionDef {
  return isJsonObject(value) && isJsonObject(value.$expression);
}

/**
 * Shape 5 with `parameters`: a named formula — a pure, reusable computation invoked via the `call`
 * operator rather than lowered to a computed value.
 */
export function isNamedFormulaDef(
  value: unknown,
): value is JxExpressionDef & { parameters: unknown[] } {
  return isExpressionDef(value) && Array.isArray(value.parameters) && value.parameters.length > 0;
}

/**
 * Shape 4 with a structured body: a Function entry whose `body` is a statement array (spec §20)
 * rather than opaque JS source.
 */
export function hasStructuredBody(
  value: unknown,
): value is JxFunctionDef & { body: JxStatement[] } {
  return isFunctionDef(value) && Array.isArray(value.body);
}

/** A non-Function `$prototype` instance (Request, Storage, ContentCollection, classes, …). */
export function isPrototypeDef(value: unknown): value is JxPrototypeDef {
  return (
    isJsonObject(value) && typeof value.$prototype === "string" && value.$prototype !== "Function"
  );
}

/** A `timing: "server"` function proxy (no `$prototype`, external `$src`/`$export`). */
export function isServerFnDef(value: unknown): value is JxServerFnDef {
  return (
    isJsonObject(value) &&
    value.timing === "server" &&
    typeof value.$src === "string" &&
    typeof value.$export === "string" &&
    !value.$prototype
  );
}

/** Shape 2: an expanded signal — an object carrying a `default` value. */
export function isExpandedSignal(value: unknown): value is JxStateObject & { default: JsonValue } {
  return isJsonObject(value) && !value.$prototype && !value.$expression && "default" in value;
}

/**
 * Schema-only keywords used to detect pure type definitions (Shape 2b). An object with ONLY these
 * keys and no `default` is a type def, not a signal.
 */
export const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "items",
  "properties",
  "required",
  "description",
  "title",
  "$comment",
]);

/** Shape 2b: a pure type definition — every key is a JSON Schema keyword. */
export function isSchemaOnlyDef(value: unknown): value is JxStateObject {
  if (!isJsonObject(value)) {
    return false;
  }
  for (const k of Object.keys(value)) {
    if (!SCHEMA_KEYWORDS.has(k)) {
      return false;
    }
  }
  return true;
}

/** True when an object carries at least one JSON Schema keyword. */
export function hasSchemaKeywords(value: unknown): value is JxStateObject {
  if (!isJsonObject(value)) {
    return false;
  }
  for (const k of Object.keys(value)) {
    if (SCHEMA_KEYWORDS.has(k)) {
      return true;
    }
  }
  return false;
}

// ─── Document structure guards ──────────────────────────────────────────────────

/** A mapped (repeater) children object — `{ $prototype: "Array", items, map }`. */
export function isMappedArray(value: unknown): value is JxMappedArray {
  return isJsonObject(value) && value.$prototype === "Array";
}

/**
 * Whether a node's `children` holds at least one mapped array — either as the bare whole-children
 * slot (legacy) or as a member of the children array. Used by renderers and the compiler to decide
 * if a children list needs inline repeater expansion.
 */
export function childrenContainArray(children?: unknown): boolean {
  if (isMappedArray(children)) {
    return true;
  }
  return Array.isArray(children) && children.some((c) => isMappedArray(c));
}

/** A .class.json schema-defined class document — `{ $prototype: "Class" }`. */
export function isClassDef(value: unknown): value is JxClassDef {
  return isJsonObject(value) && value.$prototype === "Class";
}

/** An element-shaped node object (vs. a bare string/number child). */
export function isNodeObject(value: unknown): value is JxMutableNode & JxElement {
  return isJsonObject(value);
}

/** A `${...}` template-expression string. */
export function isTemplateString(value?: unknown): value is string {
  return typeof value === "string" && value.includes("${");
}

/**
 * Whether a function `body` returns a value — the heuristic that classifies a `$prototype:
 * "Function"` as a computed value vs an event handler. Uses a word boundary so identifiers like
 * `returned` do not match. Shared by the runtime interpreter and the compiler so both agree on the
 * classification.
 *
 * A bare `return;` does not count. It is an early-exit guard, which is handler code — reading it as
 * a value return turned any handler with a guard clause into a `computed()`, so the binding that
 * invoked it found a value where it expected a function. The value has to follow on the same line,
 * because a newline after `return` is an ASI bare return.
 */
export function bodyReturnsValue(body: string): boolean {
  return /\breturn\b[^\S\n]*(?![;}\s]|$)/.test(body);
}

// ─── Style guards & accessors ───────────────────────────────────────────────────

/** A nested style object (selector/media block), as opposed to a scalar CSS value. */
export function isNestedStyle(value: string | number | JxStyle | undefined): value is JxStyle {
  return typeof value === "object" && value !== null;
}

/** Read a nested style block (`:hover`, `@--md`, `& > li`, …), if present. */
export function getNestedStyle(style: JxStyle | undefined, key: string): JxStyle | undefined {
  const value = style?.[key];
  return isNestedStyle(value) ? value : undefined;
}

/** Read a nested style block, creating an empty one in place when absent or scalar. */
export function ensureNestedStyle(style: JxStyle, key: string): JxStyle {
  const existing = style[key];
  if (isNestedStyle(existing)) {
    return existing;
  }
  const created: JxStyle = {};
  style[key] = created;
  return created;
}

// ─── Event binding guards ───────────────────────────────────────────────────────

/**
 * The value of an `on*` document key: a `$ref`, an inline function declaration, or a declarative
 * expression.
 */
export function isEventBinding(value: unknown): value is JxEventBinding {
  return isRef(value) || isFunctionDef(value) || isExpressionDef(value);
}

/** Read the event binding stored under an `on*` key of a node, if there is one. */
export function getEventBinding(
  node: JxMutableNode | JxElement,
  key: string,
): JxEventBinding | undefined {
  const value = node[key];
  return isEventBinding(value) ? value : undefined;
}

// ─── Parameter helpers ──────────────────────────────────────────────────────────

/** Resolve `parameters` entries (bare strings or CEM objects) to their names. */
export function paramNames(parameters: JxFunctionDef["parameters"]): string[] {
  if (!parameters) {
    return [];
  }
  return parameters.map((p) => (typeof p === "string" ? p : p.name));
}

/** Whether an element's `tagName` is a choice rather than a name. */
export function isTagExpression(tagName: unknown): tagName is { $expression: JxTagExpression } {
  return isJsonObject(tagName) && isJsonObject(tagName.$expression);
}

/**
 * Every tag an element could be, without evaluating anything.
 *
 * ONE implementation, shared by the runtime, the three compiler targets and the studio, because
 * four surfaces each writing their own enumeration is four chances to disagree about what an
 * element can be — and disagreeing about that is how the `${…}` tagName shipped a page whose SSR
 * markup and client render used different elements.
 *
 * A plain name yields itself, so every caller can treat the two forms alike.
 */
export function tagNameCandidates(tagName: unknown): string[] {
  if (typeof tagName === "string") {
    return [tagName];
  }
  if (!isTagExpression(tagName)) {
    return [];
  }
  const expression = tagName.$expression;
  if (expression.operator === "?:") {
    return [...new Set([expression.value, expression.initial])];
  }
  return [...new Set([...Object.values(expression.cases), expression.default])];
}

/**
 * The tag to show a human when the element could be several.
 *
 * The Outline draws one row per node and needs a label that is stable, short and honest: `a|div`
 * says "this is one element whose tag is chosen" without pretending to know which. Rendering the
 * first candidate would have been a quieter lie.
 */
export function displayTagName(tagName: unknown): string {
  return typeof tagName === "string" ? tagName : tagNameCandidates(tagName).join("|");
}
