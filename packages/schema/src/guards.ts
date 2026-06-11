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
  JxStyle,
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

/** A .class.json schema-defined class document — `{ $prototype: "Class" }`. */
export function isClassDef(value: unknown): value is JxClassDef {
  return isJsonObject(value) && value.$prototype === "Class";
}

/** An element-shaped node object (vs. a bare string/number child). */
export function isNodeObject(value: unknown): value is JxMutableNode & JxElement {
  return isJsonObject(value);
}

/** A `${...}` template-expression string. */
export function isTemplateString(value: unknown): value is string {
  return typeof value === "string" && value.includes("${");
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
