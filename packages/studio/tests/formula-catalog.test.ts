/**
 * Tests for src/ui/formula-catalog.ts — the metadata registry merging blessed operators, blessed
 * globals, and named formulas into the uniform catalog entry shape.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { BLESSED_GLOBALS, BLESSED_OPERATORS } from "@jxsuite/runtime/expression";
import { catalog as packagedCatalog, formulaEntries } from "@jxsuite/formulas";
import { isNamedFormulaDef } from "@jxsuite/schema/guards";
import {
  applyCatalogPick,
  calleeEntry,
  formulaCatalog,
  globalEntries,
  namedFormulaEntries,
  operatorEntries,
  packagedFormulaEntries,
} from "../src/ui/formula-catalog";
import type { JxStateDefinition } from "@jxsuite/schema/types";

// ─── Operator entries ─────────────────────────────────────────────────────────

describe("operatorEntries", () => {
  test("covers every blessed operator", () => {
    const names = new Set(operatorEntries().map((e) => e.name));
    for (const op of BLESSED_OPERATORS) {
      expect(names.has(op)).toBe(true);
    }
    expect(names.size).toBe(BLESSED_OPERATORS.size);
  });

  test("conditional, coalescing, switch, and call entries carry metadata", () => {
    const byName = new Map(operatorEntries().map((e) => [e.name, e]));
    const conditional = byName.get("?:")!;
    expect(conditional.kind).toBe("operator");
    expect(conditional.group).toBe("Conditional");
    expect(conditional.description).toContain("ECMA");
    expect(conditional.parameters.map((p) => p.name)).toEqual(["target", "value", "initial"]);

    const coalesce = byName.get("??")!;
    expect(coalesce.group).toBe("Logical");
    expect(coalesce.description).toContain("Nullish coalescing");

    const switchEntry = byName.get("switch")!;
    expect(switchEntry.group).toBe("Conditional");
    expect(switchEntry.description).toContain("switch");

    const call = byName.get("call")!;
    expect(call.group).toBe("Function");
    expect(call.description).toContain("Function.prototype.call");
  });

  test("insert factories produce the operator's default node shape", () => {
    const byName = new Map(operatorEntries().map((e) => [e.name, e]));
    expect(byName.get("?:")!.insert()).toEqual({
      initial: null,
      operator: "?:",
      target: null,
      value: null,
    });
    expect(byName.get("switch")!.insert()).toEqual({
      cases: {},
      default: null,
      operator: "switch",
      target: null,
    });
    expect(byName.get("call")!.insert()).toEqual({
      operator: "call",
      target: { $ref: "" },
      value: [],
    });
    expect(byName.get("splice")!.insert()).toEqual({
      operator: "splice",
      target: { $ref: "" },
      value: [null],
    });
    expect(byName.get("reduce")!.insert()).toEqual({
      initial: 0,
      operator: "reduce",
      target: { $ref: "" },
      value: { operator: "!", target: null },
    });
    expect(byName.get("=")!.insert()).toEqual({ operator: "=", target: { $ref: "" }, value: null });
    expect(byName.get("!")!.insert()).toEqual({ operator: "!", target: null });
    expect(byName.get("+")!.insert()).toEqual({ operator: "+", target: null, value: null });
  });
});

// ─── Global entries ───────────────────────────────────────────────────────────

describe("globalEntries", () => {
  test("derives one entry per blessed global with dotted labels and namespace groups", () => {
    const entries = globalEntries();
    expect(entries.length).toBe(BLESSED_GLOBALS.size);

    const max = entries.find((e) => e.name === "Math/max")!;
    expect(max.label).toBe("Math.max");
    expect(max.group).toBe("Math");
    expect(max.kind).toBe("global");
    expect(max.description).toContain("window#/Math/max");

    const bare = entries.find((e) => e.name === "isNaN")!;
    expect(bare.label).toBe("isNaN");
    expect(bare.group).toBe("globalThis");
  });

  test("insert produces a call node targeting the window#/ scheme", () => {
    const parse = globalEntries().find((e) => e.name === "JSON/parse")!;
    expect(parse.insert()).toEqual({
      operator: "call",
      target: { $ref: "window#/JSON/parse" },
      value: [],
    });
  });
});

// ─── Named formula entries ────────────────────────────────────────────────────

const STATE: Record<string, JxStateDefinition> = {
  count: { default: 0 },
  handler: { $prototype: "Function", body: "x()" },
  lineTotal: {
    $expression: {
      operator: "*",
      target: { $ref: "$args/price" },
      value: { $ref: "$args/qty" },
    },
    $title: "Line total",
    parameters: [
      { description: "Unit price", name: "price", type: { text: "number" } },
      { default: 1, name: "qty", type: { text: "number" } },
    ],
  },
  plainExpr: { $expression: { operator: "!", target: { $ref: "#/state/count" } } },
};

describe("namedFormulaEntries", () => {
  test("picks up parameterized expression entries only", () => {
    const entries = namedFormulaEntries(STATE);
    expect(entries.map((e) => e.name)).toEqual(["lineTotal"]);
    expect(entries[0]!.kind).toBe("formula");
    expect(entries[0]!.group).toBe("Formulas");
  });

  test("derives label, parameters, and description from the def", () => {
    const [entry] = namedFormulaEntries(STATE);
    expect(entry!.label).toBe("lineTotal");
    // Description falls back to $title when no description field is present
    expect(entry!.description).toBe("Line total");
    expect(entry!.parameters).toEqual([
      { description: "Unit price", name: "price", type: "number" },
      { default: 1, name: "qty", type: "number" },
    ]);
  });

  test("description field wins over $title; bare-string parameters are accepted", () => {
    const entries = namedFormulaEntries({
      greet: {
        $expression: { operator: "+", target: "Hello ", value: { $ref: "$args/name" } },
        $title: "ignored",
        description: "Greets a person.",
        parameters: ["name", ""],
      },
    });
    expect(entries[0]!.description).toBe("Greets a person.");
    expect(entries[0]!.parameters).toEqual([{ name: "name" }]);
  });

  test("insert produces a call node with defaults as seeded positional args", () => {
    const [entry] = namedFormulaEntries(STATE);
    expect(entry!.insert()).toEqual({
      operator: "call",
      target: { $ref: "#/state/lineTotal" },
      value: [null, 1],
    });
  });

  test("empty or absent state yields no entries", () => {
    expect(namedFormulaEntries({})).toEqual([]);
    expect(namedFormulaEntries(null)).toEqual([]);
    expect(namedFormulaEntries()).toEqual([]);
  });
});

// ─── Merged registry + callee resolution ──────────────────────────────────────

describe("formulaCatalog", () => {
  test("merges named formulas, packaged formulas, operators, and globals", () => {
    const entries = formulaCatalog(STATE);
    const kinds = new Set(entries.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["formula", "operator", "global"]));
    // STATE's `count` key shadows the packaged `count` formula — existing names never vendor.
    const shadowed = packagedCatalog.filter((f) => f.name in STATE).length;
    expect(shadowed).toBe(1);
    expect(entries.length).toBe(
      1 + (packagedCatalog.length - shadowed) + BLESSED_OPERATORS.size + BLESSED_GLOBALS.size,
    );
    // Named formulas lead the list (most specific first)
    expect(entries[0]!.name).toBe("lineTotal");
  });

  test("works without a state map", () => {
    const entries = formulaCatalog();
    expect(entries.length).toBe(
      packagedCatalog.length + BLESSED_OPERATORS.size + BLESSED_GLOBALS.size,
    );
  });
});

describe("calleeEntry", () => {
  test("resolves state formula refs and window#/ global refs", () => {
    expect(calleeEntry("#/state/lineTotal", STATE)?.label).toBe("lineTotal");
    expect(calleeEntry("window#/Math/max")?.label).toBe("Math.max");
  });

  test("returns undefined for unknown or unsupported refs", () => {
    expect(calleeEntry("#/state/count", STATE)).toBeUndefined();
    expect(calleeEntry("window#/Math/random")).toBeUndefined();
    expect(calleeEntry("$args/x", STATE)).toBeUndefined();
    expect(calleeEntry("", STATE)).toBeUndefined();
  });
});

describe("packagedFormulaEntries (@jxsuite/formulas copy-in)", () => {
  test("every packaged formula appears with an ensure payload and a call insert", () => {
    const entries = packagedFormulaEntries();
    expect(entries.length).toBe(packagedCatalog.length);
    const clamp = entries.find((e) => e.name === "clamp")!;
    expect(clamp.kind).toBe("formula");
    expect(clamp.group).toBe("Formulas library");
    expect(clamp.ensure!.name).toBe("clamp");
    expect(clamp.ensure!.def).toMatchObject({ parameters: expect.any(Array) });
    expect(clamp.insert()).toMatchObject({
      operator: "call",
      target: { $ref: "#/state/clamp" },
    });
  });

  test("formulas already vendored into state are skipped", () => {
    const entries = packagedFormulaEntries({
      clamp: { $expression: { operator: "??", target: null, value: 0 }, parameters: ["value"] },
    });
    expect(entries.some((e) => e.name === "clamp")).toBe(false);
    expect(entries.length).toBe(packagedCatalog.length - 1);
  });

  test("applyCatalogPick vendors the def before inserting the call node", () => {
    const entry = packagedFormulaEntries().find((e) => e.name === "sum");
    const inserted: [string, unknown][] = [];
    let node: unknown = null;
    applyCatalogPick(entry!, (n) => (node = n), {
      onInsertDef: (name, def) => inserted.push([name, def]),
      stateEntries: {},
    });
    expect(inserted).toEqual([["sum", entry!.ensure!.def]]);
    expect(node).toMatchObject({ operator: "call", target: { $ref: "#/state/sum" } });
  });

  test("applyCatalogPick skips vendoring when the def already exists", () => {
    const entry = packagedFormulaEntries().find((e) => e.name === "sum");
    const inserted: string[] = [];
    applyCatalogPick(entry!, () => {}, {
      onInsertDef: (name) => inserted.push(name),
      stateEntries: { sum: entry!.ensure!.def },
    });
    expect(inserted).toEqual([]);
  });

  test("plain operator picks never vendor", () => {
    const op = operatorEntries().find((e) => e.name === "??")!;
    const inserted: string[] = [];
    applyCatalogPick(op, () => {}, { onInsertDef: (name) => inserted.push(name) });
    expect(inserted).toEqual([]);
  });
});

describe("formulaEntries (@jxsuite/formulas state entries)", () => {
  test("returns one ready-to-merge state entry per catalog formula, keyed by name", () => {
    const entries = formulaEntries();
    expect(Object.keys(entries).toSorted()).toEqual(packagedCatalog.map((f) => f.name).toSorted());
    for (const formula of packagedCatalog) {
      expect(entries[formula.name]).toEqual({
        $description: formula.description,
        $expression: formula.expression,
        parameters: formula.parameters,
      });
    }
  });

  test("every entry passes the named-formula guard, so it is callable once merged", () => {
    for (const def of Object.values(formulaEntries())) {
      expect(isNamedFormulaDef(def)).toBe(true);
    }
  });
});
