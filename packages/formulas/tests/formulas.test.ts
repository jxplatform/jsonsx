import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { compileExpression, evaluateExpression } from "@jxsuite/runtime/expression";
import { catalog, formulaEntries } from "../src/index.ts";

import type { JxScope } from "@jxsuite/runtime/types";

try {
  GlobalRegistrator.register();
} catch {
  // Already registered
}

/** Invoke a catalog formula by name through the call operator against its state entry. */
function invoke(name: string, args: unknown[]): unknown {
  const state = formulaEntries() as unknown as JxScope;
  return evaluateExpression(
    { operator: "call", target: { $ref: `#/state/${name}` }, value: args as never },
    state,
    null,
  );
}

describe("catalog integrity", () => {
  test("15 formulas, each named, described, and parameterized", () => {
    expect(catalog.length).toBe(15);
    for (const formula of catalog) {
      expect(formula.name.length).toBeGreaterThan(0);
      expect(formula.description.length).toBeGreaterThan(10);
      expect(formula.parameters.length).toBeGreaterThan(0);
    }
  });

  test("formulaEntries produces named-formula state entries", () => {
    const entries = formulaEntries();
    expect(Object.keys(entries).length).toBe(15);
    expect(entries.clamp!.parameters!.length).toBe(3);
    expect(entries.clamp!.$expression.operator).toBe("call");
  });
});

describe("formula behavior (interpreted)", () => {
  const cases: [string, unknown[], unknown][] = [
    ["clamp", [15, 0, 10], 10],
    ["clamp", [-5, 0, 10], 0],
    ["clamp", [7, 0, 10], 7],
    ["sum", [[1, 2, 3, 4]], 10],
    ["sum", [[]], 0],
    ["average", [[2, 4, 6]], 4],
    ["average", [[]], 0],
    ["count", [[1, 2, 3]], 3],
    ["count", ["hello"], 5],
    ["count", [undefined], 0],
    ["min", [[5, 2, 9]], 2],
    ["max", [[5, 2, 9]], 9],
    ["first", [[7, 8]], 7],
    ["first", [[]], null],
    ["last", [[7, 8]], 8],
    ["isEmpty", [[]], true],
    ["isEmpty", [[1]], false],
    ["isEmpty", [""], true],
    ["isEmpty", [undefined], true],
    ["compact", [[0, 1, "", "a", null, 2]], [1, "a", 2]],
    ["percent", [1, 4], 25],
    ["percent", [1, 0], 0],
    ["roundTo", [1.23456, 2], 1.23],
    ["roundTo", [1.23456], 1],
    ["capitalize", ["ada"], "Ada"],
    ["truncate", ["hello world", 5], "hello…"],
    ["truncate", ["hi", 5], "hi"],
    ["initials", ["ada lovelace"], "AL"],
  ];

  for (const [name, args, expected] of cases) {
    test(`${name}(${JSON.stringify(args).slice(1, -1)}) → ${JSON.stringify(expected)}`, () => {
      expect(invoke(name, args)).toEqual(expected as never);
    });
  }
});

describe("formula bodies compile — compiled === interpreted", () => {
  const samples: Record<string, Record<string, unknown>> = {
    average: { values: [2, 4, 6] },
    capitalize: { text: "ada" },
    clamp: { max: 10, min: 0, value: 15 },
    initials: { name: "ada lovelace" },
    sum: { values: [1, 2, 3] },
    truncate: { length: 5, text: "hello world" },
  };

  for (const [name, args] of Object.entries(samples)) {
    test(name, () => {
      const formula = catalog.find((f) => f.name === name)!;
      const source = compileExpression(formula.expression);
      const fn = new Function("state", "_args", `return ${source}`);
      const interpreted = evaluateExpression(formula.expression, {}, null, { args } as never);
      expect(fn({}, args)).toEqual(interpreted as never);
    });
  }
});
