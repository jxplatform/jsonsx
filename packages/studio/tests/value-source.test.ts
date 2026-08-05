import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  EVENT_HANDLER_SCHEMA,
  SLOT_MODE_ORDER,
  SLOT_POSITION_SCHEMAS,
  VALUE_SOURCE_HINTS,
  VALUE_SOURCE_LABELS,
  capsForPosition,
  configFieldSchema,
  deriveSlotCaps,
  deriveSlotCapsDetailed,
  resetCapsCache,
  slotCaps,
  slotMode,
} from "../src/ui/value-source";
import generatedSchema from "@jxsuite/schema/schema.json";

import type { SlotPosition } from "../src/ui/value-source";

// ─── The vocabulary ──────────────────────────────────────────────────────────

describe("value-source vocabulary", () => {
  test("every rung has a plain-language name and a one-line hint", () => {
    for (const mode of SLOT_MODE_ORDER) {
      expect(VALUE_SOURCE_LABELS[mode].length).toBeGreaterThan(0);
      expect(VALUE_SOURCE_HINTS[mode].length).toBeGreaterThan(0);
    }
  });

  test("the four §6.3 names replace abc / $ref / ${} / fx", () => {
    expect(VALUE_SOURCE_LABELS.literal).toBe("Fixed value");
    expect(VALUE_SOURCE_LABELS.ref).toBe("From data…");
    expect(VALUE_SOURCE_LABELS.template).toBe("Mixed text");
    expect(VALUE_SOURCE_LABELS.expression).toBe("Formula");
    expect(VALUE_SOURCE_LABELS.function).toBe("Inline function");
  });

  test("no label is an abbreviation or a piece of syntax", () => {
    for (const label of Object.values(VALUE_SOURCE_LABELS)) {
      expect(label).not.toContain("$");
      expect(label).not.toContain("{");
      expect(label[0]).toBe(label[0]!.toUpperCase());
    }
  });
});

// ─── slotMode ────────────────────────────────────────────────────────────────

describe("slotMode", () => {
  test("detects each rung of the ladder", () => {
    expect(slotMode("plain")).toBe("literal");
    expect(slotMode(42)).toBe("literal");
    expect(slotMode(null)).toBe("literal");
    expect(slotMode({ $ref: "#/state/x" })).toBe("ref");
    expect(slotMode("${state.x} items")).toBe("template");
    expect(slotMode({ $expression: { operator: "!", target: null } })).toBe("expression");
    expect(slotMode({ $prototype: "Function", body: "", parameters: [] })).toBe("function");
  });
});

// ─── The derivation ──────────────────────────────────────────────────────────

describe("deriveSlotCaps", () => {
  test("a free string permits a fixed value and a mixed-text template", () => {
    expect(deriveSlotCaps({ type: "string" })).toEqual(["literal", "template"]);
  });

  test("a constrained string permits only a fixed value", () => {
    expect(deriveSlotCaps({ pattern: "^#/state/", type: "string" })).toEqual(["literal"]);
    expect(deriveSlotCaps({ enum: ["ltr", "rtl"], type: "string" })).toEqual(["literal"]);
    expect(deriveSlotCaps({ const: "Function", type: "string" })).toEqual(["literal"]);
  });

  test("non-string scalars permit only a fixed value", () => {
    for (const type of ["number", "boolean", "null", "array", "object"]) {
      expect(deriveSlotCaps({ type })).toEqual(["literal"]);
    }
  });

  test("a $ref binding object is the from-data rung and is not descended into", () => {
    expect(deriveSlotCaps({ $ref: "#/$defs/RefObject" })).toEqual(["ref"]);
  });

  test("an ExpressionEntry is the formula rung, a FunctionDef the inline-function rung", () => {
    expect(deriveSlotCaps({ $ref: "#/$defs/ExpressionEntry" })).toEqual(["expression"]);
    expect(deriveSlotCaps({ $ref: "#/$defs/FunctionDef" })).toEqual(["function"]);
  });

  test("branches union, and the result is in ladder order", () => {
    expect(
      deriveSlotCaps({
        oneOf: [
          { $ref: "#/$defs/ExpressionEntry" },
          { type: "string" },
          { $ref: "#/$defs/RefObject" },
        ],
      }),
    ).toEqual(["literal", "ref", "template", "expression"]);
  });

  test("allOf and anyOf compose the same way as oneOf", () => {
    expect(deriveSlotCaps({ allOf: [{ type: "number" }] })).toEqual(["literal"]);
    expect(deriveSlotCaps({ anyOf: [{ type: "boolean" }] })).toEqual(["literal"]);
  });

  test("a non-schema yields no rungs at all", () => {
    expect(deriveSlotCaps(null)).toEqual([]);
    expect(deriveSlotCaps("nonsense")).toEqual([]);
    expect(deriveSlotCaps({ description: "no type here" })).toEqual([]);
  });

  test("a recursive schema terminates", () => {
    const recursive: Record<string, unknown> = { type: "object" };
    recursive.oneOf = [{ type: "string" }, recursive];
    expect(deriveSlotCaps(recursive)).toEqual(["literal", "template"]);
  });

  test("an unfollowable pointer is reported, never silently swallowed", () => {
    const { caps, unresolved } = deriveSlotCapsDetailed({
      oneOf: [{ $ref: "#/$defs/Nowhere" }, { $ref: "#/$defs/AlsoNowhere" }],
    });
    expect(caps).toEqual([]);
    expect(unresolved).toEqual(["#/$defs/AlsoNowhere", "#/$defs/Nowhere"]);
  });

  test("a pointer alongside sibling keywords is treated as a subschema, not a reference", () => {
    expect(deriveSlotCaps({ $ref: "#/$defs/Nowhere", type: "number" })).toEqual(["literal"]);
  });
});

// ─── The named positions ─────────────────────────────────────────────────────

describe("capsForPosition", () => {
  const expected: Record<SlotPosition, string[]> = {
    attribute: ["literal", "ref", "template"],
    componentProp: ["literal", "ref", "template"],
    elementProperty: ["literal", "ref", "template"],
    eventHandler: ["ref", "expression", "function"],
    repeaterFilter: ["ref"],
    repeaterItems: ["literal", "ref"],
    repeaterSort: ["ref"],
    styleProperty: ["literal", "template"],
    switchDiscriminant: ["ref"],
    textProperty: ["literal", "ref", "template"],
  };

  for (const [position, caps] of Object.entries(expected) as [SlotPosition, string[]][]) {
    test(`${position} permits ${caps.join(" / ")}`, () => {
      expect(capsForPosition(position)).toEqual(caps as never);
    });
  }

  test("no position's derivation leaves a pointer unfollowed", () => {
    for (const schema of Object.values(SLOT_POSITION_SCHEMAS)) {
      expect(deriveSlotCapsDetailed(schema).unresolved).toEqual([]);
    }
  });

  test("every position derives at least one rung — there is no invented floor", () => {
    /* `renderDynamicSlot` no longer falls back to fixed-value/from-data when a derivation comes
       back empty, so a position whose schema moved out from under it would draw a chip with
       nowhere to go. This is the check that says so first. */
    for (const position of Object.keys(SLOT_POSITION_SCHEMAS) as SlotPosition[]) {
      expect(capsForPosition(position).length).toBeGreaterThan(0);
    }
  });

  test("a repeater's filter and sort, and a $switch, are bindings and nothing else", () => {
    for (const position of ["repeaterFilter", "repeaterSort", "switchDiscriminant"] as const) {
      expect(capsForPosition(position)).toEqual(["ref"] as never);
    }
  });

  test("an event handler is never a fixed value, and a CSS declaration is never a signal", () => {
    expect(capsForPosition("eventHandler")).not.toContain("literal" as never);
    expect(capsForPosition("styleProperty")).not.toContain("ref" as never);
  });

  test("the derivation is cached and the cache is droppable", () => {
    const first = capsForPosition("attribute");
    expect(capsForPosition("attribute")).toBe(first);
    resetCapsCache();
    expect(capsForPosition("attribute")).not.toBe(first);
    expect(capsForPosition("attribute")).toEqual(first);
  });
});

// ─── Drift guard on the one mirrored fragment ────────────────────────────────

describe("EVENT_HANDLER_SCHEMA", () => {
  test("still equals the shape the schema generator synthesises for on* properties", () => {
    const generated = (
      generatedSchema as unknown as {
        $defs: { ElementDef: { properties: Record<string, unknown> } };
      }
    ).$defs.ElementDef.properties;
    const handlers = Object.keys(generated).filter((k) => k.startsWith("on"));
    expect(handlers.length).toBeGreaterThan(0);
    for (const name of handlers) {
      expect((generated[name] as { oneOf: unknown }).oneOf).toEqual(
        EVENT_HANDLER_SCHEMA.oneOf as never,
      );
    }
  });
});

// ─── Where the rungs come from ───────────────────────────────────────────────

describe("slotCaps", () => {
  test("a named position resolves through the cache; a schema is walked directly", () => {
    expect(slotCaps("eventHandler")).toBe(capsForPosition("eventHandler"));
    expect(slotCaps({ schema: { type: "string" } })).toEqual(["literal", "template"]);
  });
});

describe("configFieldSchema", () => {
  test("a declared field keeps its own rungs and gains the binding", () => {
    expect(deriveSlotCaps(configFieldSchema({ type: "string" }))).toEqual([
      "literal",
      "ref",
      "template",
    ]);
    expect(deriveSlotCaps(configFieldSchema({ enum: ["GET", "POST"], type: "string" }))).toEqual([
      "literal",
      "ref",
    ]);
  });

  test("an untyped field is the free string its widget already draws", () => {
    /* `{ name: {} }` is a legal plugin config field. Deriving nothing from it would leave the
       form offering From data… as the only way to fill in a plain textfield. */
    expect(deriveSlotCaps(configFieldSchema({}))).toEqual(["literal", "ref", "template"]);
    expect(deriveSlotCaps(configFieldSchema({ description: "just prose" }))).toEqual([
      "literal",
      "ref",
      "template",
    ]);
  });

  test("no config field is ever fixed-only — a data source resolves $ref in its own config", () => {
    expect(deriveSlotCaps(configFieldSchema({ type: "boolean" }))).toContain("ref");
    expect(deriveSlotCaps(configFieldSchema({ type: "integer" }))).toEqual(["literal", "ref"]);
  });
});
