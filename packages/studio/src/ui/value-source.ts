/**
 * Value Source — the one vocabulary for "how is this value produced", and the derivation that says
 * which productions a given document position actually permits (plan §6.3).
 *
 * Six controls used to answer that question in six dialects: `abc / $ref / ${} / fx` on the dynamic
 * slot, `inline / $expression / ref` on the Events tab, `lit / $ref / expr` on every expression
 * operand, and `Static value / route param / Custom…` in the schema-driven forms. They are the same
 * four rungs of the Rule of Least Power ladder (spec §2.2) wearing four costumes, and a user who
 * learned one learned none of the others. {@link VALUE_SOURCE_LABELS} is the single vocabulary;
 * every surface that offers the choice spells it the same way.
 *
 * **The rungs are derived, not declared.** Each call site used to hand-write the array of rungs it
 * believed legal — four arrays, none of which included `expression`, so the `fx` rung the UI drew
 * was unreachable from every Properties and Style field. {@link deriveSlotCaps} walks the real
 * subschema from `@jxsuite/schema/defs` instead, so the rungs on offer are exactly the shapes the
 * document schema (and therefore `jx validate` and the compiler) accepts at that position:
 *
 * - An attribute, a component prop or an element property → fixed / from-data / mixed-text;
 * - A CSS declaration → fixed / mixed-text, because `JxStyle` has no `$ref` branch at all;
 * - An event handler → from-data / formula / inline-function, and never a fixed value;
 * - A repeater's filter or sort, and a `$switch` discriminant → from-data and nothing else, because
 *   `ArrayNamespace` and `SwitchDef` declare a `RefObject` there and no other branch.
 *
 * The walker imports the _source_ def modules rather than the generated `schema.json`, which is
 * half a megabyte of webref data that `services/monaco-lazy.ts` deliberately keeps out of the cold
 * start. The one position the generator synthesises rather than declares — the `on*` handler
 * property — is mirrored here as {@link EVENT_HANDLER_SCHEMA} and pinned to the generated schema by
 * a test, so the mirror cannot drift in silence.
 */

import {
  arrayNamespaceSchema,
  attributesObjectSchema,
  elementPropertyValueSchema,
  expressionEntrySchema,
  functionDefSchema,
  propsObjectSchema,
  refObjectSchema,
  stringOrRefSchema,
  styleObjectSchema,
  switchDefSchema,
} from "@jxsuite/schema/defs";
import { isFunctionDef, isRef, isTemplateString } from "@jxsuite/schema/guards";

/** A rung of the value ladder — one way a document position can produce its value. */
export type SlotMode = "literal" | "ref" | "template" | "expression" | "function";

/** Ladder order, least powerful first (spec §2.2). Every rung list is sorted by this. */
export const SLOT_MODE_ORDER: SlotMode[] = ["literal", "ref", "template", "expression", "function"];

/**
 * The user-facing name of each rung — the whole point of §6.3. `ref` keeps its ellipsis because
 * choosing it opens a picker rather than committing a value.
 */
export const VALUE_SOURCE_LABELS: Record<SlotMode, string> = {
  expression: "Formula",
  function: "Inline function",
  literal: "Fixed value",
  ref: "From data…",
  template: "Mixed text",
};

/** One line of plain language per rung, shown beside its name in the picker. */
export const VALUE_SOURCE_HINTS: Record<SlotMode, string> = {
  expression: "Computed from other values, built up operator by operator.",
  function: "Code that runs when this fires.",
  literal: "A value you type here, the same every time.",
  ref: "The current value of a signal, picked from a list.",
  template: "Text with ${…} placeholders that fill in from signals.",
};

/** Detect which rung of the ladder a raw document value occupies. */
export function slotMode(value: unknown): SlotMode {
  if (isRef(value)) {
    return "ref";
  }
  if (isFunctionDef(value)) {
    return "function";
  }
  if (isTemplateString(value)) {
    return "template";
  }
  if (value && typeof value === "object" && "$expression" in value) {
    return "expression";
  }
  return "literal";
}

// ─── Schema walk ────────────────────────────────────────────────────────────

type SchemaNode = Record<string, unknown>;

/**
 * The `on*` property shape that `@jxsuite/schema`'s generator synthesises for every EventHandler
 * IDL attribute (`buildEventHandlerProperties`). It is the only slot position with no declared
 * module in `defs/`; `tests/value-source.test.ts` asserts it still equals the generated one.
 */
export const EVENT_HANDLER_SCHEMA = {
  oneOf: [
    { $ref: "#/$defs/RefObject" },
    { $ref: "#/$defs/ExpressionEntry" },
    { $ref: "#/$defs/FunctionDef" },
  ],
} as const;

/** The `$defs` a slot position can actually reach. Anything else is a bug, not a silent no-rung. */
const REACHABLE_DEFS: Record<string, SchemaNode> = {
  ExpressionEntry: expressionEntrySchema as unknown as SchemaNode,
  FunctionDef: functionDefSchema as unknown as SchemaNode,
  RefObject: refObjectSchema as unknown as SchemaNode,
  StyleObject: styleObjectSchema as unknown as SchemaNode,
};

/** A `{ $ref: … }` binding object: `required: ["$ref"]` with a `$ref` property. */
function isRefObjectSchema(node: SchemaNode): boolean {
  const { required } = node;
  return (
    Array.isArray(required) &&
    required.includes("$ref") &&
    Boolean((node.properties as SchemaNode | undefined)?.$ref)
  );
}

/** A `{ $expression: … }` entry. */
function isExpressionEntrySchema(node: SchemaNode): boolean {
  const { required } = node;
  return Array.isArray(required) && required.includes("$expression");
}

/** A `$prototype: "Function"` declaration. */
function isFunctionDefSchema(node: SchemaNode): boolean {
  const proto = (node.properties as SchemaNode | undefined)?.$prototype as SchemaNode | undefined;
  return proto?.const === "Function";
}

/**
 * A string branch that will accept `${…}`. A pattern/enum/const-constrained string will not — a
 * `TagName` or a `#/state/…` pointer is a string, but not a place a template may be typed.
 */
function isFreeStringSchema(node: SchemaNode): boolean {
  return (
    node.type === "string" &&
    node.pattern === undefined &&
    node.enum === undefined &&
    node.const === undefined
  );
}

const SCALAR_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

interface WalkState {
  found: Set<SlotMode>;
  /** Pointers the walk could not resolve — surfaced so a schema move fails loudly. */
  unresolved: Set<string>;
  seen: Set<SchemaNode>;
}

function walk(node: unknown, state: WalkState): void {
  if (!node || typeof node !== "object") {
    return;
  }
  const schema = node as SchemaNode;
  if (state.seen.has(schema)) {
    return;
  }
  state.seen.add(schema);

  const pointer = typeof schema.$ref === "string" ? schema.$ref : undefined;
  if (pointer !== undefined && Object.keys(schema).length === 1) {
    const name = pointer.startsWith("#/$defs/") ? pointer.slice("#/$defs/".length) : pointer;
    const target = REACHABLE_DEFS[name];
    if (target) {
      walk(target, state);
    } else {
      state.unresolved.add(pointer);
    }
    return;
  }

  /* Recognise a rung BEFORE descending: a RefObject's own `$ref` property is a pointer string,
     not another rung, and an ExpressionEntry's body is the expression grammar, not a ladder. */
  if (isRefObjectSchema(schema)) {
    state.found.add("ref");
    return;
  }
  if (isExpressionEntrySchema(schema)) {
    state.found.add("expression");
    return;
  }
  if (isFunctionDefSchema(schema)) {
    state.found.add("function");
    return;
  }

  let composed = false;
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      composed = true;
      for (const branch of branches) {
        walk(branch, state);
      }
    }
  }
  if (composed) {
    return;
  }

  if (isFreeStringSchema(schema)) {
    state.found.add("literal");
    state.found.add("template");
    return;
  }
  if (schema.enum !== undefined || schema.const !== undefined) {
    state.found.add("literal");
    return;
  }
  if (typeof schema.type === "string" && SCALAR_TYPES.has(schema.type)) {
    state.found.add("literal");
  }
}

/** Result of a derivation, including the pointers it could not follow. */
export interface DerivedCaps {
  caps: SlotMode[];
  unresolved: string[];
}

/** Derive the rungs a subschema permits, and report any pointer the walk could not follow. */
export function deriveSlotCapsDetailed(schema: unknown): DerivedCaps {
  const state: WalkState = { found: new Set(), seen: new Set(), unresolved: new Set() };
  walk(schema, state);
  return {
    caps: SLOT_MODE_ORDER.filter((m) => state.found.has(m)),
    unresolved: [...state.unresolved].toSorted(),
  };
}

/** Derive the rungs a subschema permits, in ladder order. */
export function deriveSlotCaps(schema: unknown): SlotMode[] {
  return deriveSlotCapsDetailed(schema).caps;
}

// ─── Named positions ────────────────────────────────────────────────────────

/**
 * The document positions a bindable slot can occupy. A panel names the position it is editing; the
 * rungs follow from the schema, so a panel can no longer offer a rung the compiler would reject —
 * nor withhold one it would accept.
 */
export const SLOT_POSITION_SCHEMAS = {
  /** `attributes: { … }` — `AttributesObject.additionalProperties`. */
  attribute: attributesObjectSchema.additionalProperties,
  /** `$props: { … }` — `PropsObject.additionalProperties`. */
  componentProp: propsObjectSchema.additionalProperties,
  /** An unlisted element property — `ElementDef.additionalProperties`. */
  elementProperty: elementPropertyValueSchema,
  /** An `on*` handler — the generator's synthesised property shape. */
  eventHandler: EVENT_HANDLER_SCHEMA,
  /** A repeater's `filter` — `ArrayNamespace.properties.filter`. */
  repeaterFilter: arrayNamespaceSchema.properties.filter,
  /** A repeater's `items` — `ArrayNamespace.properties.items`. */
  repeaterItems: arrayNamespaceSchema.properties.items,
  /** A repeater's `sort` — `ArrayNamespace.properties.sort`. */
  repeaterSort: arrayNamespaceSchema.properties.sort,
  /** A declaration inside `style: { … }` — `StyleObject.additionalProperties`. */
  styleProperty: styleObjectSchema.additionalProperties,
  /** A `$switch` discriminant — `SwitchDef`, which is a `$ref` and nothing else. */
  switchDiscriminant: switchDefSchema,
  /** A declared string-valued element property (`textContent`, `href`, …) — `StringOrRef`. */
  textProperty: stringOrRefSchema,
} as const;

/** Name of a document position a bindable slot can occupy. */
export type SlotPosition = keyof typeof SLOT_POSITION_SCHEMAS;

/**
 * Where a slot's rungs come from. A named {@link SlotPosition} for every position the document
 * schema declares; a schema handed in directly for the one that cannot be named ahead of time — a
 * field in an extension's own config form, whose schema arrives at runtime from the extension.
 *
 * There is deliberately no third form. A caller may not state which rungs it wants: the rungs are
 * derived from a schema or they are not derived at all.
 */
export type SlotCapsSource = SlotPosition | { schema: unknown };

const capsCache = new Map<SlotPosition, SlotMode[]>();

/** The rungs legal at a named document position, derived once and cached. */
export function capsForPosition(position: SlotPosition): SlotMode[] {
  const hit = capsCache.get(position);
  if (hit) {
    return hit;
  }
  const derived = deriveSlotCaps(SLOT_POSITION_SCHEMAS[position]);
  capsCache.set(position, derived);
  return derived;
}

/** The rungs on offer for a {@link SlotCapsSource} — a named position, or a schema handed in. */
export function slotCaps(source: SlotCapsSource): SlotMode[] {
  return typeof source === "string" ? capsForPosition(source) : deriveSlotCaps(source.schema);
}

/**
 * The schema of one field in an extension's config form, as something the derivation can walk.
 *
 * Two things a plugin's own fragment does not say, and the form must. An untyped field accepts
 * anything, which for a form control means the free string its widget already draws. And every
 * config value additionally accepts a reactive `$ref` — a data source resolves the pointers in its
 * own config at runtime — which no plugin schema declares because it is not the plugin's to
 * declare. Both are stated here, once, rather than assumed at each form.
 */
export function configFieldSchema(field: unknown): { anyOf: unknown[] } {
  const declared = deriveSlotCaps(field).length > 0 ? field : { type: "string" };
  return { anyOf: [declared, { $ref: "#/$defs/RefObject" }] };
}

/** Test hook: drop the derivation cache. */
export function resetCapsCache(): void {
  capsCache.clear();
}
