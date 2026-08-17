import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import {
  BLESSED_GLOBALS,
  BLESSED_OPERATORS,
  compileExpression,
  evaluateExpression,
  formulaFnName,
  isBlessedGlobal,
  isMutating,
} from "../src/expression.ts";
import type { ExpressionNode } from "../src/expression.ts";
import type { JxScope } from "../src/types.ts";

// Expression.ts has no import-time DOM side effects, so registering after import is safe.
try {
  GlobalRegistrator.register();
} catch {
  // Already registered
}

const ref = ($ref: string) => ({ $ref });

describe("isMutating / BLESSED_OPERATORS", () => {
  test("mutating ops are flagged", () => {
    for (const op of ["=", "+=", "-=", "*=", "/=", "push", "pop", "shift", "unshift", "splice"]) {
      expect(isMutating(op)).toBe(true);
    }
  });

  test("pure ops are not flagged", () => {
    for (const op of ["+", "-", "!", "===", "map", "filter", "reduce"]) {
      expect(isMutating(op)).toBe(false);
    }
  });

  test("blessed operator set contains all categories", () => {
    for (const op of [
      "=",
      "+=",
      "push",
      "splice",
      "!",
      "-",
      "+",
      "%",
      "&&",
      "||",
      "reduce",
      "map",
      "filter",
    ]) {
      expect(BLESSED_OPERATORS.has(op)).toBe(true);
    }
    expect(BLESSED_OPERATORS.has("typeof")).toBe(false);
  });
});

describe("evaluateExpression — errors", () => {
  test("unknown operator throws", () => {
    expect(() => evaluateExpression({ operator: "nope", target: 1 }, {}, null)).toThrow(
      '$expression: unknown operator "nope"',
    );
  });
});

describe("evaluateExpression — unary", () => {
  test("! negates truthiness", () => {
    expect(evaluateExpression({ operator: "!", target: true }, {}, null)).toBe(false);
    expect(evaluateExpression({ operator: "!", target: 0 }, {}, null)).toBe(true);
  });

  test("! of a state ref", () => {
    const state: JxScope = { open: false };
    expect(evaluateExpression({ operator: "!", target: ref("#/state/open") }, state, null)).toBe(
      true,
    );
  });

  test("- negates a number", () => {
    expect(evaluateExpression({ operator: "-", target: 5 }, {}, null)).toBe(-5);
  });

  test("! with a value present falls through to undefined", () => {
    // "!" is unary-only; supplying `value` skips the unary branch and no other matches.
    expect(evaluateExpression({ operator: "!", target: true, value: 1 }, {}, null)).toBeUndefined();
  });
});

describe("evaluateExpression — binary", () => {
  const cases: [string, unknown, unknown, unknown][] = [
    ["+", 2, 3, 5],
    ["+", "a", "b", "ab"],
    ["-", 7, 2, 5],
    ["*", 3, 4, 12],
    ["/", 10, 4, 2.5],
    ["%", 10, 3, 1],
    ["===", 1, 1, true],
    ["===", 1, "1", false],
    ["!==", 1, "1", true],
    ["!==", 2, 2, false],
    ["<", 1, 2, true],
    ["<", 2, 1, false],
    ["<=", 2, 2, true],
    [">", 3, 2, true],
    [">", 2, 3, false],
    [">=", 2, 3, false],
    [">=", 3, 3, true],
    ["&&", true, "yes", "yes"],
    ["&&", false, "yes", false],
    ["||", "", "fallback", "fallback"],
    ["||", "first", "second", "first"],
  ];

  for (const [operator, target, value, expected] of cases) {
    test(`${JSON.stringify(target)} ${operator} ${JSON.stringify(value)} -> ${JSON.stringify(
      expected,
    )}`, () => {
      expect(evaluateExpression({ operator, target, value } as ExpressionNode, {}, null)).toBe(
        expected as never,
      );
    });
  }

  test("binary - with value present is subtraction (not unary)", () => {
    expect(evaluateExpression({ operator: "-", target: 10, value: 4 }, {}, null)).toBe(6);
  });

  test("nested expression operands", () => {
    const node: ExpressionNode = {
      operator: "*",
      target: { operator: "+", target: 1, value: 2 },
      value: { operator: "-", target: 10, value: 6 },
    };
    expect(evaluateExpression(node, {}, null)).toBe(12);
  });

  test("missing value operand resolves to undefined (NaN arithmetic)", () => {
    expect(evaluateExpression({ operator: "+", target: 1 }, {}, null)).toBeNaN();
  });

  test("null operand passes through", () => {
    expect(evaluateExpression({ operator: "===", target: null, value: null }, {}, null)).toBe(true);
  });
});

describe("evaluateExpression — $ref resolution", () => {
  test("#/state/key reads top-level state", () => {
    expect(
      evaluateExpression(
        { operator: "+", target: ref("#/state/count"), value: 1 },
        { count: 41 },
        null,
      ),
    ).toBe(42);
  });

  test("#/state/a/b/c navigates a deep path", () => {
    const state: JxScope = { user: { profile: { age: 30 } } };
    expect(
      evaluateExpression(
        { operator: "+", target: ref("#/state/user/profile/age"), value: 1 },
        state,
        null,
      ),
    ).toBe(31);
  });

  test("bare ref reads state key, missing key yields null", () => {
    expect(
      evaluateExpression({ operator: "===", target: ref("x"), value: 9 }, { x: 9 }, null),
    ).toBe(true);
    expect(
      evaluateExpression({ operator: "===", target: ref("missing"), value: null }, {}, null),
    ).toBe(true);
  });

  test("parent#/key reads from state", () => {
    expect(
      evaluateExpression(
        { operator: "+", target: ref("parent#/total"), value: 0 },
        { total: 7 },
        null,
      ),
    ).toBe(7);
  });

  test("event#/path reads from the event object", () => {
    const event = { target: { value: "hello" } } as unknown as Event;
    expect(
      evaluateExpression(
        { operator: "+", target: ref("event#/target/value"), value: "!" },
        {},
        event,
      ),
    ).toBe("hello!");
  });

  test("window#/ and document#/ refs resolve against globals", () => {
    (globalThis.window as unknown as Record<string, unknown>).__exprTest = { n: 4 };
    globalThis.document.title = "expr-title";
    expect(
      evaluateExpression(
        { operator: "+", target: ref("window#/__exprTest/n"), value: 1 },
        {},
        null,
      ),
    ).toBe(5);
    expect(
      evaluateExpression(
        { operator: "===", target: ref("document#/title"), value: "expr-title" },
        {},
        null,
      ),
    ).toBe(true);
  });

  test("$map/item and $map/index from scope $map context", () => {
    const state: JxScope = { $map: { index: 2, item: { name: "ada" } } };
    expect(
      evaluateExpression({ operator: "+", target: ref("$map/item/name"), value: "!" }, state, null),
    ).toBe("ada!");
    expect(
      evaluateExpression({ operator: "+", target: ref("$map/index"), value: 1 }, state, null),
    ).toBe(3);
  });

  test("$map custom key from scope $map context, with deep path", () => {
    const state: JxScope = { $map: { row: { id: 9 } } };
    expect(
      evaluateExpression({ operator: "+", target: ref("$map/row/id"), value: 1 }, state, null),
    ).toBe(10);
  });

  test("$map fallback to flattened state keys when no $map object", () => {
    const state: JxScope = { "$map/index": 5, "$map/item": "flat", "$map/extra": "x" };
    expect(
      evaluateExpression({ operator: "+", target: ref("$map/item"), value: "" }, state, null),
    ).toBe("flat");
    expect(
      evaluateExpression({ operator: "+", target: ref("$map/index"), value: 0 }, state, null),
    ).toBe(5);
    expect(
      evaluateExpression({ operator: "+", target: ref("$map/extra"), value: "" }, state, null),
    ).toBe("x");
  });
});

describe("evaluateExpression — assignment", () => {
  test("= writes top-level state", () => {
    const state: JxScope = { count: 0 };
    const result = evaluateExpression(
      { operator: "=", target: ref("#/state/count"), value: 10 },
      state,
      null,
    );
    expect(result).toBeUndefined();
    expect(state.count).toBe(10);
  });

  test("= writes a deep state path", () => {
    const state: JxScope = { form: { user: { name: "old" } } };
    evaluateExpression(
      { operator: "=", target: ref("#/state/form/user/name"), value: "new" },
      state,
      null,
    );
    expect((state.form as { user: { name: string } }).user.name).toBe("new");
  });

  test("+= -= *= /= compound assignments", () => {
    const state: JxScope = { n: 10 };
    evaluateExpression({ operator: "+=", target: ref("#/state/n"), value: 5 }, state, null);
    expect(state.n).toBe(15);
    evaluateExpression({ operator: "-=", target: ref("#/state/n"), value: 3 }, state, null);
    expect(state.n).toBe(12);
    evaluateExpression({ operator: "*=", target: ref("#/state/n"), value: 2 }, state, null);
    expect(state.n).toBe(24);
    evaluateExpression({ operator: "/=", target: ref("#/state/n"), value: 4 }, state, null);
    expect(state.n).toBe(6);
  });

  test("= with rhs resolved from a ref", () => {
    const state: JxScope = { a: 1, b: 99 };
    evaluateExpression(
      { operator: "=", target: ref("#/state/a"), value: ref("#/state/b") },
      state,
      null,
    );
    expect(state.a).toBe(99);
  });

  test("= to a bare ref writes the state key directly", () => {
    const state: JxScope = {};
    evaluateExpression({ operator: "=", target: ref("plain"), value: 1 }, state, null);
    expect(state.plain).toBe(1);
  });

  test("= to $map/item deep path mutates the item", () => {
    const item = { done: false };
    const state: JxScope = { $map: { index: 0, item } };
    evaluateExpression({ operator: "=", target: ref("$map/item/done"), value: true }, state, null);
    expect(item.done).toBe(true);
  });

  test("= to $map/item nested path navigates before assignment", () => {
    const item = { meta: { tag: "a" } };
    const state: JxScope = { $map: { index: 0, item } };
    evaluateExpression(
      { operator: "=", target: ref("$map/item/meta/tag"), value: "b" },
      state,
      null,
    );
    expect(item.meta.tag).toBe("b");
  });

  test("= to $map/item without path writes the map context slot", () => {
    const map: Record<string, unknown> = { index: 0, item: "old" };
    const state: JxScope = { $map: map };
    evaluateExpression({ operator: "=", target: ref("$map/item"), value: "new" }, state, null);
    expect(map["$map/item"]).toBe("new");
  });

  test("= to a custom $map key deep path mutates the aliased object", () => {
    const row = { id: 1 };
    const state: JxScope = { $map: { row } };
    evaluateExpression({ operator: "=", target: ref("$map/row/id"), value: 2 }, state, null);
    expect(row.id).toBe(2);
  });

  test("= to $map/index without map context falls back to state", () => {
    const state: JxScope = {};
    evaluateExpression({ operator: "=", target: ref("$map/index"), value: 3 }, state, null);
    expect(state["$map/index"]).toBe(3);
  });
});

describe("evaluateExpression — array methods", () => {
  test("push returns new length and appends", () => {
    const state: JxScope = { items: [1, 2] };
    expect(
      evaluateExpression({ operator: "push", target: ref("#/state/items"), value: 3 }, state, null),
    ).toBe(3);
    expect(state.items).toEqual([1, 2, 3]);
  });

  test("unshift prepends", () => {
    const state: JxScope = { items: [2, 3] };
    expect(
      evaluateExpression(
        { operator: "unshift", target: ref("#/state/items"), value: 1 },
        state,
        null,
      ),
    ).toBe(3);
    expect(state.items).toEqual([1, 2, 3]);
  });

  test("pop removes and returns last element", () => {
    const state: JxScope = { items: [1, 2, 3] };
    expect(evaluateExpression({ operator: "pop", target: ref("#/state/items") }, state, null)).toBe(
      3,
    );
    expect(state.items).toEqual([1, 2]);
  });

  test("shift removes and returns first element", () => {
    const state: JxScope = { items: [1, 2, 3] };
    expect(
      evaluateExpression({ operator: "shift", target: ref("#/state/items") }, state, null),
    ).toBe(1);
    expect(state.items).toEqual([2, 3]);
  });

  test("splice with array args removes and inserts", () => {
    const state: JxScope = { items: ["a", "b", "c", "d"] };
    const removed = evaluateExpression(
      { operator: "splice", target: ref("#/state/items"), value: [1, 2, "x"] },
      state,
      null,
    );
    expect(removed).toEqual(["b", "c"]);
    expect(state.items).toEqual(["a", "x", "d"]);
  });

  test("splice args may contain refs", () => {
    const state: JxScope = { idx: 0, items: [1, 2, 3] };
    const removed = evaluateExpression(
      { operator: "splice", target: ref("#/state/items"), value: [ref("#/state/idx"), 1] },
      state,
      null,
    );
    expect(removed).toEqual([1]);
    expect(state.items).toEqual([2, 3]);
  });
});

describe("evaluateExpression — aggregates", () => {
  test("reduce sums with $reduce/acc and $map/item", () => {
    const state: JxScope = { nums: [1, 2, 3, 4] };
    const node: ExpressionNode = {
      initial: 0,
      operator: "reduce",
      target: ref("#/state/nums"),
      value: { operator: "+", target: ref("$reduce/acc"), value: ref("$map/item") },
    };
    expect(evaluateExpression(node, state, null)).toBe(10);
  });

  test("reduce supports named $reduce/<alias> refs and ref initial", () => {
    const state: JxScope = { nums: [5, 6], seed: 100 };
    const node: ExpressionNode = {
      initial: ref("#/state/seed"),
      operator: "reduce",
      target: ref("#/state/nums"),
      value: { operator: "+", target: ref("$reduce/total"), value: ref("$map/item") },
    };
    expect(evaluateExpression(node, state, null)).toBe(111);
  });

  test("map transforms items, exposing $map/index in iterCtx", () => {
    const state: JxScope = { nums: [10, 20] };
    const node: ExpressionNode = {
      operator: "map",
      target: ref("#/state/nums"),
      value: { operator: "+", target: ref("$map/item"), value: ref("$map/index") },
    };
    expect(evaluateExpression(node, state, null)).toEqual([10, 21]);
  });

  test("map over items with deep paths", () => {
    const state: JxScope = { rows: [{ v: 1 }, { v: 2 }] };
    const node: ExpressionNode = {
      operator: "map",
      target: ref("#/state/rows"),
      value: { operator: "*", target: ref("$map/item/v"), value: 10 },
    };
    expect(evaluateExpression(node, state, null)).toEqual([10, 20]);
  });

  test("filter keeps matching items", () => {
    const state: JxScope = { nums: [1, 2, 3, 4, 5] };
    const node: ExpressionNode = {
      operator: "filter",
      target: ref("#/state/nums"),
      value: { operator: ">", target: ref("$map/item"), value: 2 },
    };
    expect(evaluateExpression(node, state, null)).toEqual([3, 4, 5]);
  });

  test("iterCtx item/index take precedence over scope $map", () => {
    const state: JxScope = { $map: { index: 99, item: "scope" } };
    expect(
      evaluateExpression({ operator: "+", target: ref("$map/item"), value: "" }, state, null, {
        index: 1,
        item: "iter",
      }),
    ).toBe("iter");
    expect(
      evaluateExpression({ operator: "+", target: ref("$map/index"), value: 0 }, state, null, {
        index: 1,
        item: "iter",
      }),
    ).toBe(1);
  });
});

describe("compileExpression — unary and binary", () => {
  test("! compiles to negation", () => {
    expect(compileExpression({ operator: "!", target: ref("#/state/open") })).toBe("!(state.open)");
  });

  test("unary - compiles to numeric negation", () => {
    expect(compileExpression({ operator: "-", target: ref("count") })).toBe("-(state.count)");
  });

  test("binary operators compile to parenthesized expressions", () => {
    expect(compileExpression({ operator: "+", target: 1, value: 2 })).toBe("(1 + 2)");
    expect(compileExpression({ operator: "===", target: ref("#/state/a"), value: "x" })).toBe(
      '(state.a === "x")',
    );
    expect(compileExpression({ operator: "&&", target: true, value: false })).toBe(
      "(true && false)",
    );
  });

  test("- with value compiles as binary subtraction", () => {
    expect(compileExpression({ operator: "-", target: 5, value: 2 })).toBe("(5 - 2)");
  });

  test("nested expression operands compile recursively", () => {
    const node: ExpressionNode = {
      operator: "*",
      target: { operator: "+", target: 1, value: 2 },
      value: 3,
    };
    expect(compileExpression(node)).toBe("((1 + 2) * 3)");
  });

  test("null and undefined operands compile to literals", () => {
    expect(compileExpression({ operator: "===", target: ref("x"), value: null })).toBe(
      "(state.x === null)",
    );
    expect(compileExpression({ operator: "===", target: ref("x") })).toBe(
      "(state.x === undefined)",
    );
  });

  test("array operands compile to comma-joined items", () => {
    expect(compileExpression({ operator: "+", target: [1, ref("#/state/x")], value: 3 })).toBe(
      "(1, state.x + 3)",
    );
  });

  test("compiled binary evaluates correctly", () => {
    const source = compileExpression({
      operator: "+",
      target: ref("#/state/a"),
      value: ref("#/state/b"),
    });
    const fn = new Function("state", `return ${source}`);
    expect(fn({ a: 2, b: 3 })).toBe(5);
  });
});

describe("compileExpression — refs", () => {
  test("$reduce/acc and $reduce/<alias> compile to _acc", () => {
    expect(compileExpression({ operator: "+", target: ref("$reduce/acc"), value: 1 })).toBe(
      "(_acc + 1)",
    );
    expect(compileExpression({ operator: "+", target: ref("$reduce/sum"), value: 1 })).toBe(
      "(_acc + 1)",
    );
  });

  test("event#/ compiles to dotted event access", () => {
    expect(
      compileExpression({ operator: "+", target: ref("event#/target/value"), value: "" }),
    ).toBe('(event.target.value + "")');
  });

  test("event param name is configurable", () => {
    expect(
      compileExpression(
        { operator: "+", target: ref("event#/detail"), value: 0 },
        {
          eventParam: "ev",
        },
      ),
    ).toBe("(ev.detail + 0)");
  });

  test("$map/item, $map/item/path, $map/index, $map/custom", () => {
    expect(compileExpression({ operator: "+", target: ref("$map/item"), value: 1 })).toBe(
      "(_item + 1)",
    );
    expect(compileExpression({ operator: "+", target: ref("$map/item/a/b"), value: 1 })).toBe(
      "(_item.a.b + 1)",
    );
    expect(compileExpression({ operator: "+", target: ref("$map/index"), value: 1 })).toBe(
      "(_index + 1)",
    );
    expect(compileExpression({ operator: "+", target: ref("$map/row"), value: 1 })).toBe(
      "(_row + 1)",
    );
  });

  test("#/state/ paths compile with statePrefix option", () => {
    expect(
      compileExpression(
        { operator: "+", target: ref("#/state/a/b"), value: 1 },
        {
          statePrefix: "scope",
        },
      ),
    ).toBe("(scope.a.b + 1)");
  });

  test("parent#/, window#/, document#/ and bare refs", () => {
    expect(compileExpression({ operator: "!", target: ref("parent#/flag") })).toBe("!(state.flag)");
    expect(compileExpression({ operator: "!", target: ref("window#/location/href") })).toBe(
      "!(window.location.href)",
    );
    expect(compileExpression({ operator: "!", target: ref("document#/title") })).toBe(
      "!(document.title)",
    );
    expect(compileExpression({ operator: "!", target: ref("flag") })).toBe("!(state.flag)");
  });
});

describe("compileExpression — assignment", () => {
  test("simple and compound assignments", () => {
    expect(compileExpression({ operator: "=", target: ref("#/state/n"), value: 1 })).toBe(
      "state.n = 1",
    );
    expect(compileExpression({ operator: "+=", target: ref("#/state/n"), value: 2 })).toBe(
      "state.n += 2",
    );
    expect(compileExpression({ operator: "-=", target: ref("#/state/n"), value: 2 })).toBe(
      "state.n -= 2",
    );
    expect(compileExpression({ operator: "*=", target: ref("#/state/n"), value: 2 })).toBe(
      "state.n *= 2",
    );
    expect(compileExpression({ operator: "/=", target: ref("#/state/n"), value: 2 })).toBe(
      "state.n /= 2",
    );
  });

  test("assignment rhs may be an expression", () => {
    expect(
      compileExpression({
        operator: "=",
        target: ref("#/state/n"),
        value: { operator: "+", target: ref("#/state/n"), value: 1 },
      }),
    ).toBe("state.n = (state.n + 1)");
  });

  test("non-ref target falls back to operand compilation", () => {
    expect(compileExpression({ operator: "=", target: "lhs", value: 1 })).toBe('"lhs" = 1');
  });

  test("compiled assignment mutates state when executed", () => {
    const source = compileExpression({ operator: "+=", target: ref("#/state/n"), value: 5 });
    const state = { n: 1 };
    new Function("state", source)(state);
    expect(state.n).toBe(6);
  });
});

describe("compileExpression — array methods", () => {
  test("push / unshift / pop / shift", () => {
    expect(compileExpression({ operator: "push", target: ref("#/state/items"), value: 1 })).toBe(
      "state.items.push(1)",
    );
    expect(compileExpression({ operator: "unshift", target: ref("#/state/items"), value: 1 })).toBe(
      "state.items.unshift(1)",
    );
    expect(compileExpression({ operator: "pop", target: ref("#/state/items") })).toBe(
      "state.items.pop()",
    );
    expect(compileExpression({ operator: "shift", target: ref("#/state/items") })).toBe(
      "state.items.shift()",
    );
  });

  test("splice with array args", () => {
    expect(
      compileExpression({
        operator: "splice",
        target: ref("#/state/items"),
        value: [1, 2, ref("#/state/x")],
      }),
    ).toBe("state.items.splice(1, 2, state.x)");
  });

  test("splice with non-array value", () => {
    expect(compileExpression({ operator: "splice", target: ref("#/state/items"), value: 1 })).toBe(
      "state.items.splice(1)",
    );
  });
});

describe("compileExpression — aggregates", () => {
  test("reduce compiles with seed", () => {
    const node: ExpressionNode = {
      initial: 0,
      operator: "reduce",
      target: ref("#/state/nums"),
      value: { operator: "+", target: ref("$reduce/acc"), value: ref("$map/item") },
    };
    expect(compileExpression(node)).toBe(
      "state.nums.reduce((_acc, _item, _index) => (_acc + _item), 0)",
    );
  });

  test("map and filter compile to arrow callbacks", () => {
    const mapNode: ExpressionNode = {
      operator: "map",
      target: ref("#/state/nums"),
      value: { operator: "*", target: ref("$map/item"), value: 2 },
    };
    expect(compileExpression(mapNode)).toBe("state.nums.map((_item, _index) => (_item * 2))");

    const filterNode: ExpressionNode = {
      operator: "filter",
      target: ref("#/state/nums"),
      value: { operator: ">", target: ref("$map/index"), value: 0 },
    };
    expect(compileExpression(filterNode)).toBe(
      "state.nums.filter((_item, _index) => (_index > 0))",
    );
  });

  test("compiled aggregates evaluate correctly", () => {
    const node: ExpressionNode = {
      initial: 0,
      operator: "reduce",
      target: ref("#/state/nums"),
      value: { operator: "+", target: ref("$reduce/acc"), value: ref("$map/item") },
    };
    const fn = new Function("state", `return ${compileExpression(node)}`);
    expect(fn({ nums: [1, 2, 3] })).toBe(6);
  });
});

describe("compileExpression — fallthrough", () => {
  test("unhandled operator compiles to undefined", () => {
    expect(compileExpression({ operator: "typeof", target: 1 })).toBe("undefined");
  });

  test("unary operator with value present compiles to undefined", () => {
    expect(compileExpression({ operator: "!", target: 1, value: 2 })).toBe("undefined");
  });
});

describe("conditional operators — ?:, ??, switch", () => {
  test("blessed and pure", () => {
    for (const op of ["?:", "??", "switch"]) {
      expect(BLESSED_OPERATORS.has(op)).toBe(true);
      expect(isMutating(op)).toBe(false);
    }
  });

  test("?: selects consequent or alternate", () => {
    const node: ExpressionNode = {
      initial: "keep shopping",
      operator: "?:",
      target: { operator: ">", target: ref("#/state/count"), value: 10 },
      value: "cart full",
    };
    expect(evaluateExpression(node, { count: 11 }, null)).toBe("cart full");
    expect(evaluateExpression(node, { count: 3 }, null)).toBe("keep shopping");
  });

  test("?: chains else-if by nesting in initial", () => {
    const node: ExpressionNode = {
      initial: {
        initial: "low",
        operator: "?:",
        target: { operator: ">", target: ref("#/state/n"), value: 10 },
        value: "mid",
      },
      operator: "?:",
      target: { operator: ">", target: ref("#/state/n"), value: 100 },
      value: "high",
    };
    expect(evaluateExpression(node, { n: 500 }, null)).toBe("high");
    expect(evaluateExpression(node, { n: 50 }, null)).toBe("mid");
    expect(evaluateExpression(node, { n: 5 }, null)).toBe("low");
  });

  test("?? returns right only for nullish left", () => {
    expect(evaluateExpression({ operator: "??", target: null, value: "fallback" }, {}, null)).toBe(
      "fallback",
    );
    expect(evaluateExpression({ operator: "??", target: "", value: "fallback" }, {}, null)).toBe(
      "",
    );
    expect(evaluateExpression({ operator: "??", target: 0, value: 1 }, {}, null)).toBe(0);
    expect(
      evaluateExpression({ operator: "??", target: ref("#/state/missing"), value: "x" }, {}, null),
    ).toBe("x");
  });

  test("switch matches case by string form of discriminant", () => {
    const node: ExpressionNode = {
      cases: { error: ref("#/state/message"), loading: "please wait" },
      default: "ready",
      operator: "switch",
      target: ref("#/state/status"),
    };
    expect(evaluateExpression(node, { status: "loading" }, null)).toBe("please wait");
    expect(evaluateExpression(node, { message: "boom", status: "error" }, null)).toBe("boom");
    expect(evaluateExpression(node, { status: "done" }, null)).toBe("ready");
  });

  test("switch on a numeric discriminant matches its string key", () => {
    const node: ExpressionNode = {
      cases: { "1": "one", "2": "two" },
      operator: "switch",
      target: ref("#/state/n"),
    };
    expect(evaluateExpression(node, { n: 2 }, null)).toBe("two");
  });

  test("switch without default and no match yields undefined", () => {
    const node: ExpressionNode = { cases: { a: 1 }, operator: "switch", target: "z" };
    expect(evaluateExpression(node, {}, null)).toBeUndefined();
  });

  test("?: compiles to a ternary; compiled === interpreted", () => {
    const node: ExpressionNode = {
      initial: "no",
      operator: "?:",
      target: { operator: ">=", target: ref("#/state/n"), value: 5 },
      value: "yes",
    };
    const source = compileExpression(node);
    expect(source).toBe('((state.n >= 5) ? "yes" : "no")');
    const fn = new Function("state", `return ${source}`);
    for (const n of [3, 5, 9]) {
      expect(fn({ n })).toBe(evaluateExpression(node, { n }, null) as string);
    }
  });

  test("?? compiles as a parenthesized binary; compiled === interpreted", () => {
    const node: ExpressionNode = { operator: "??", target: ref("#/state/a"), value: "d" };
    const source = compileExpression(node);
    expect(source).toBe('(state.a ?? "d")');
    const fn = new Function("state", `return ${source}`);
    for (const a of [null, undefined, "", 0, "v"]) {
      expect(fn({ a })).toBe(evaluateExpression(node, { a } as JxScope, null) as string);
    }
  });

  test("switch compiles to a bound-discriminant chain; compiled === interpreted", () => {
    const node: ExpressionNode = {
      cases: { error: ref("#/state/message"), loading: "wait" },
      default: "ready",
      operator: "switch",
      target: ref("#/state/status"),
    };
    const source = compileExpression(node);
    expect(source).toBe(
      '((_d) => _d === "error" ? state.message : _d === "loading" ? "wait" : "ready")(String(state.status))',
    );
    const fn = new Function("state", `return ${source}`);
    for (const state of [
      { message: "boom", status: "error" },
      { status: "loading" },
      { status: "anything" },
    ]) {
      expect(fn(state)).toBe(evaluateExpression(node, state as JxScope, null) as string);
    }
  });

  test("switch without default compiles undefined fallback", () => {
    const source = compileExpression({ cases: { a: 1 }, operator: "switch", target: ref("x") });
    const fn = new Function("state", `return ${source}`);
    expect(fn({ x: "z" })).toBeUndefined();
    expect(fn({ x: "a" })).toBe(1);
  });
});

describe("evaluateExpression — trace reporting", () => {
  const collect = () => {
    const seen = new Map<string, unknown>();
    return {
      seen,
      trace: {
        report: (path: (string | number)[], value: unknown) => seen.set(path.join("/"), value),
      },
    };
  };

  test("reports the root and operand values", () => {
    const { seen, trace } = collect();
    const node: ExpressionNode = {
      operator: "+",
      target: ref("#/state/a"),
      value: { operator: "*", target: ref("#/state/b"), value: 2 },
    };
    expect(evaluateExpression(node, { a: 1, b: 3 }, null, undefined, trace)).toBe(7);
    expect(seen.get("")).toBe(7);
    expect(seen.get("target")).toBe(1);
    expect(seen.get("value")).toBe(6);
    expect(seen.get("value/target")).toBe(3);
  });

  test("?: reports BOTH branches under trace but returns the taken one", () => {
    const { seen, trace } = collect();
    const node: ExpressionNode = {
      initial: ref("#/state/no"),
      operator: "?:",
      target: true,
      value: ref("#/state/yes"),
    };
    expect(evaluateExpression(node, { no: "N", yes: "Y" }, null, undefined, trace)).toBe("Y");
    expect(seen.get("value")).toBe("Y");
    expect(seen.get("initial")).toBe("N");
  });

  test("switch reports every case and the default under trace", () => {
    const { seen, trace } = collect();
    const node: ExpressionNode = {
      cases: { a: ref("#/state/a"), b: ref("#/state/b") },
      default: ref("#/state/d"),
      operator: "switch",
      target: "b",
    };
    expect(evaluateExpression(node, { a: 1, b: 2, d: 3 }, null, undefined, trace)).toBe(2);
    expect(seen.get("cases/a")).toBe(1);
    expect(seen.get("cases/b")).toBe(2);
    expect(seen.get("default")).toBe(3);
  });

  test("aggregates report a first-iteration sample only", () => {
    const { seen, trace } = collect();
    const node: ExpressionNode = {
      operator: "map",
      target: ref("#/state/nums"),
      value: { operator: "*", target: ref("$map/item"), value: 10 },
    };
    expect(evaluateExpression(node, { nums: [1, 2, 3] }, null, undefined, trace)).toEqual([
      10, 20, 30,
    ]);
    expect(seen.get("target")).toEqual([1, 2, 3]);
    expect(seen.get("value")).toBe(10);
    expect(seen.get("value/target")).toBe(1);
  });

  test("assignment reports the written value; state still mutates", () => {
    const { seen, trace } = collect();
    const state: JxScope = { n: 1 };
    evaluateExpression(
      { operator: "=", target: ref("#/state/n"), value: 42 },
      state,
      null,
      undefined,
      trace,
    );
    expect(state.n).toBe(42);
    expect(seen.has("")).toBe(true);
  });

  test("reporting stops beyond MAX_REPORT_DEPTH but evaluation completes", () => {
    const { seen, trace } = collect();
    let node: ExpressionNode = { operator: "!", target: ref("#/state/flag") };
    for (let i = 0; i < 70; i++) {
      node = { operator: "!", target: node };
    }
    expect(evaluateExpression(node, { flag: true }, null, undefined, trace)).toBe(false);
    // 70 nested targets, reporting capped: strictly fewer reports than nodes.
    expect(seen.size).toBeGreaterThan(0);
    expect(seen.size).toBeLessThan(70);
  });

  test("production path (no trace) short-circuits ?: branches", () => {
    // The untaken branch references a missing deep path that would throw if resolved eagerly
    // Through a non-object; with plain refs it resolves to undefined — assert via a counter ref
    // On window instead.
    let touched = 0;
    Object.defineProperty(globalThis.window, "__traceProbe", {
      configurable: true,
      get() {
        touched += 1;
        return 1;
      },
    });
    const node: ExpressionNode = {
      initial: ref("window#/__traceProbe"),
      operator: "?:",
      target: true,
      value: "taken",
    };
    expect(evaluateExpression(node, {}, null)).toBe("taken");
    expect(touched).toBe(0);
    expect(evaluateExpression(node, {}, null, undefined, { report: () => {} })).toBe("taken");
    expect(touched).toBe(1);
  });
});

describe("call operator — named formulas and blessed globals", () => {
  const lineTotal = {
    $expression: {
      operator: "*",
      target: { $ref: "$args/price" },
      value: { $ref: "$args/qty" },
    },
    parameters: [{ name: "price" }, { name: "qty", default: 1 }],
  };

  test("call is blessed and pure", () => {
    expect(BLESSED_OPERATORS.has("call")).toBe(true);
    expect(isMutating("call")).toBe(false);
  });

  test("calls a named formula def with positional args mapped to parameters", () => {
    const state: JxScope = { lineTotal };
    const node: ExpressionNode = {
      operator: "call",
      target: ref("#/state/lineTotal"),
      value: [3, 4],
    };
    expect(evaluateExpression(node, state, null)).toBe(12);
  });

  test("omitted args fall back to CemParameter defaults", () => {
    const state: JxScope = { lineTotal };
    const node: ExpressionNode = {
      operator: "call",
      target: ref("#/state/lineTotal"),
      value: [5],
    };
    expect(evaluateExpression(node, state, null)).toBe(5);
  });

  test("$args supports deep paths", () => {
    const state: JxScope = {
      firstName: {
        $expression: { operator: "+", target: { $ref: "$args/user/name/first" }, value: "" },
        parameters: ["user"],
      },
    };
    const node: ExpressionNode = {
      operator: "call",
      target: ref("#/state/firstName"),
      value: [{ $ref: "#/state/person" }],
    };
    expect(evaluateExpression(node, { ...state, person: { name: { first: "Ada" } } }, null)).toBe(
      "Ada",
    );
  });

  test("calls a plain scope function with positional args", () => {
    const state: JxScope = { sum: (a: number, b: number) => a + b };
    const node: ExpressionNode = { operator: "call", target: ref("#/state/sum"), value: [2, 3] };
    expect(evaluateExpression(node, state, null)).toBe(5);
  });

  test("calls blessed globals through window#/", () => {
    expect(
      evaluateExpression(
        { operator: "call", target: ref("window#/Math/max"), value: [1, 9, 4] },
        {},
        null,
      ),
    ).toBe(9);
    expect(
      evaluateExpression(
        { operator: "call", target: ref("window#/JSON/stringify"), value: [[1, 2]] },
        {},
        null,
      ),
    ).toBe("[1,2]");
    expect(
      evaluateExpression(
        { operator: "call", target: ref("window#/Object/keys"), value: [ref("#/state/obj")] },
        { obj: { a: 1, b: 2 } },
        null,
      ),
    ).toEqual(["a", "b"]);
  });

  test("Intl helpers construct-then-format (spec §19.4c)", () => {
    expect(
      evaluateExpression(
        {
          operator: "call",
          target: ref("window#/Intl/formatNumber"),
          value: [1234.5, "en-US", { currency: "USD", style: "currency" }],
        },
        {},
        null,
      ),
    ).toBe("$1,234.50");
    expect(
      evaluateExpression(
        { operator: "call", target: ref("window#/Intl/formatNumber"), value: [1234.5, "en-US"] },
        {},
        null,
      ),
    ).toBe("1,234.5");
    expect(
      evaluateExpression(
        {
          operator: "call",
          target: ref("window#/Intl/formatDate"),
          value: ["2026-01-15T12:00:00Z", "en-US", { dateStyle: "medium", timeZone: "UTC" }],
        },
        {},
        null,
      ),
    ).toBe("Jan 15, 2026");
    expect(
      evaluateExpression(
        {
          operator: "call",
          target: ref("window#/Intl/formatRelativeTime"),
          value: [-3, "day", "en-US"],
        },
        {},
        null,
      ),
    ).toBe("3 days ago");
  });

  test("Intl helpers compile to inline construct-then-format JS", () => {
    const js = compileExpression({
      operator: "call",
      target: ref("window#/Intl/formatNumber"),
      value: [ref("#/state/total"), "en-US"],
    });
    // The `?? "en-US"` is the deterministic default: a formula that names no locale must not read
    // The host's, or the same document would render differently on two build machines.
    expect(js).toBe('new Intl.NumberFormat("en-US" ?? "en-US", undefined).format(state.total)');
    const fn = new Function("state", `return ${js}`) as (s: unknown) => string;
    expect(fn({ total: 1234.5 })).toBe("1,234.5");

    const dateJs = compileExpression({
      operator: "call",
      target: ref("window#/Intl/formatDate"),
      value: [ref("#/state/when"), "en-US", { dateStyle: "medium", timeZone: "UTC" }],
    });
    expect(dateJs).toContain("new Intl.DateTimeFormat(");
    const dateFn = new Function("state", `return ${dateJs}`) as (s: unknown) => string;
    expect(dateFn({ when: "2026-01-15T12:00:00Z" })).toBe("Jan 15, 2026");
  });

  test("a helper that names no locale or time zone still renders the same everywhere", () => {
    /*
     * The determinism contract. Without the defaults these compile to `new Intl.NumberFormat()`,
     * which reads the build machine's locale — and for a date, its time zone, which can move the
     * rendered day.
     */
    const numberJs = compileExpression({
      operator: "call",
      target: ref("window#/Intl/formatNumber"),
      value: [ref("#/state/total")],
    });
    expect(numberJs).toContain('"en-US"');
    const numberFn = new Function("state", `return ${numberJs}`) as (s: unknown) => string;
    expect(numberFn({ total: 1234.5 })).toBe("1,234.5");

    const dateJs = compileExpression({
      operator: "call",
      target: ref("window#/Intl/formatDate"),
      value: [ref("#/state/when")],
    });
    expect(dateJs).toContain('timeZone: "UTC"');
    const dateFn = new Function("state", `return ${dateJs}`) as (s: unknown) => string;
    // 02:00 UTC is the 15th in New York; UTC is what keeps the published HTML the same everywhere.
    expect(dateFn({ when: "2026-01-16T02:00:00Z" })).toBe("1/16/2026");
  });

  test("the new Intl helpers evaluate and compile to the same answer", () => {
    const cases: { node: Parameters<typeof compileExpression>[0]; expected: unknown }[] = [
      {
        expected: "a, b, and c",
        node: {
          operator: "call",
          target: ref("window#/Intl/formatList"),
          value: [ref("#/state/items"), "en-US"],
        },
      },
      {
        expected: "one",
        node: { operator: "call", target: ref("window#/Intl/plural"), value: [1, "en-US"] },
      },
      {
        expected: "German",
        node: {
          operator: "call",
          target: ref("window#/Intl/displayName"),
          value: ["de", "language", "en-US"],
        },
      },
      {
        expected: ["a", "b"],
        node: {
          operator: "call",
          target: ref("window#/Intl/segment"),
          value: ["ab", "grapheme", "en-US"],
        },
      },
    ];
    const scope = { items: ["a", "b", "c"] };
    for (const { node, expected } of cases) {
      expect(evaluateExpression(node, scope, null)).toEqual(expected);
      const js = compileExpression(node);
      const fn = new Function("state", `return ${js}`) as (s: unknown) => unknown;
      expect(fn(scope)).toEqual(expected);
    }
  });

  test("Intl/compare orders accented words the way a person would", () => {
    // `<` and sort() compare UTF-16 code units, which puts every accented word after "z".
    const node = {
      operator: "call" as const,
      target: ref("window#/Intl/compare"),
      value: ["école", "zoo", "fr"],
    };
    expect(evaluateExpression(node, {}, null)).toBeLessThan(0);
    const [accented, plain] = ["école", "zoo"];
    expect(accented! < plain!).toBe(false);
    expect(new Function(`return ${compileExpression(node)}`)()).toBeLessThan(0);
  });

  test("non-blessed globals are rejected at evaluation", () => {
    expect(isBlessedGlobal("window#/Math/max")).toBe(true);
    expect(isBlessedGlobal("window#/alert")).toBe(false);
    expect(BLESSED_GLOBALS.has("alert")).toBe(false);
    expect(() =>
      evaluateExpression(
        { operator: "call", target: ref("window#/alert"), value: ["hi"] },
        {},
        null,
      ),
    ).toThrow("not a blessed pure global");
  });

  test("non-callable target throws; non-ref target throws", () => {
    expect(() =>
      evaluateExpression({ operator: "call", target: ref("#/state/n"), value: [] }, { n: 5 }, null),
    ).toThrow("not callable");
    expect(() => evaluateExpression({ operator: "call", target: 42, value: [] }, {}, null)).toThrow(
      "must be a $ref pointer",
    );
  });

  test("unbounded formula recursion hits the call depth cap", () => {
    const state: JxScope = {
      loop: {
        $expression: { operator: "call", target: { $ref: "#/state/loop" }, value: [] },
        parameters: ["x"],
      },
    };
    expect(() =>
      evaluateExpression({ operator: "call", target: ref("#/state/loop"), value: [] }, state, null),
    ).toThrow("call depth exceeded");
  });

  test("compiles blessed global calls; compiled === interpreted", () => {
    const node: ExpressionNode = {
      operator: "call",
      target: ref("window#/Math/max"),
      value: [ref("#/state/a"), ref("#/state/b"), 0],
    };
    const source = compileExpression(node);
    expect(source).toBe("window.Math.max(state.a, state.b, 0)");
    const fn = new Function("state", `return ${source}`);
    expect(fn({ a: 3, b: 7 })).toBe(evaluateExpression(node, { a: 3, b: 7 } as JxScope, null));
  });

  test("compiles non-blessed global calls as a build error", () => {
    expect(() =>
      compileExpression({ operator: "call", target: ref("window#/fetch"), value: [] }),
    ).toThrow("not a blessed pure global");
  });

  test("compiles named-formula call sites against formulaParams", () => {
    const node: ExpressionNode = {
      operator: "call",
      target: ref("#/state/lineTotal"),
      value: [ref("$map/item/price"), 2],
    };
    const source = compileExpression(node, { formulaParams: { lineTotal: ["price", "qty"] } });
    expect(source).toBe('_fx_lineTotal(state, { "price": _item.price, "qty": 2 })');
  });

  test("emitted formula fn + call site round-trips to the interpreted result", () => {
    const bodySource = compileExpression(lineTotal.$expression as ExpressionNode, {
      formulaParams: { lineTotal: ["price", "qty"] },
    });
    const decl = `const ${formulaFnName("lineTotal")} = (state, _args) => ${bodySource};`;
    const callSource = compileExpression(
      { operator: "call", target: ref("#/state/lineTotal"), value: [3, 4] },
      { formulaParams: { lineTotal: ["price", "qty"] } },
    );
    const fn = new Function("state", `${decl} return ${callSource};`);
    expect(fn({})).toBe(12);
    expect(
      evaluateExpression(
        { operator: "call", target: ref("#/state/lineTotal"), value: [3, 4] },
        { lineTotal },
        null,
      ),
    ).toBe(12);
  });

  test("callee without formulaParams compiles to a direct scope call", () => {
    const source = compileExpression({
      operator: "call",
      target: ref("#/state/sum"),
      value: [1, 2],
    });
    expect(source).toBe("state.sum(1, 2)");
  });

  test("$args refs compile to _args member access", () => {
    expect(compileExpression({ operator: "+", target: ref("$args/price"), value: 1 })).toBe(
      "(_args.price + 1)",
    );
    expect(compileExpression({ operator: "+", target: ref("$args/user/name"), value: "" })).toBe(
      '(_args.user.name + "")',
    );
  });

  /*
   * `$args/` used to bracket every segment while every other ref form dotted every segment, and
   * only one of those two rules survives a segment that is not an identifier. Both branches are
   * pinned here because the dotted branch is the one that silently emitted a SyntaxError.
   */
  test("a segment that is not an identifier takes the bracket branch", () => {
    expect(compileExpression({ operator: "+", target: ref("$args/values/0"), value: 1 })).toBe(
      '(_args.values["0"] + 1)',
    );
    expect(compileExpression({ operator: "+", target: ref("#/state/items/0"), value: 1 })).toBe(
      '(state.items["0"] + 1)',
    );
    expect(compileExpression({ operator: "+", target: ref("#/state/user.name"), value: 1 })).toBe(
      '(state["user.name"] + 1)',
    );
    expect(compileExpression({ operator: "+", target: ref("#/state/a-b"), value: 1 })).toBe(
      '(state["a-b"] + 1)',
    );
  });
});

describe("pure standard-library method operators (spec §19.4d)", () => {
  test("blessed and pure", () => {
    for (const op of ["toUpperCase", "includes", "toSorted", "join", "slice", "toFixed"]) {
      expect(BLESSED_OPERATORS.has(op)).toBe(true);
      expect(isMutating(op)).toBe(false);
    }
    // The mutating originals stay excluded — change-by-copy names replace them.
    expect(BLESSED_OPERATORS.has("sort")).toBe(false);
    expect(BLESSED_OPERATORS.has("reverse")).toBe(false);
  });

  test("string methods evaluate against the receiver", () => {
    const state: JxScope = { name: "ada lovelace" };
    expect(
      evaluateExpression({ operator: "toUpperCase", target: ref("#/state/name") }, state, null),
    ).toBe("ADA LOVELACE");
    expect(
      evaluateExpression(
        { operator: "split", target: ref("#/state/name"), value: " " },
        state,
        null,
      ),
    ).toEqual(["ada", "lovelace"]);
    expect(
      evaluateExpression(
        { operator: "padStart", target: ref("#/state/name"), value: [15, "*"] },
        state,
        null,
      ),
    ).toBe("***ada lovelace");
  });

  test("array methods are change-by-copy — the receiver is untouched", () => {
    const state: JxScope = { scores: [3, 1, 2] };
    expect(
      evaluateExpression({ operator: "toSorted", target: ref("#/state/scores") }, state, null),
    ).toEqual([1, 2, 3]);
    expect(state.scores).toEqual([3, 1, 2]);
    expect(
      evaluateExpression(
        { operator: "join", target: ref("#/state/scores"), value: ", " },
        state,
        null,
      ),
    ).toBe("3, 1, 2");
    expect(
      evaluateExpression(
        { operator: "includes", target: ref("#/state/scores"), value: 2 },
        state,
        null,
      ),
    ).toBe(true);
  });

  test("number methods evaluate; missing receiver or method yields undefined", () => {
    expect(evaluateExpression({ operator: "toFixed", target: 1.23456, value: 2 }, {}, null)).toBe(
      "1.23",
    );
    expect(
      evaluateExpression({ operator: "toUpperCase", target: ref("#/state/nope") }, {}, null),
    ).toBeUndefined();
    expect(evaluateExpression({ operator: "toUpperCase", target: 42 }, {}, null)).toBeUndefined();
  });

  test("compiled === interpreted, including the null-safe cases", () => {
    const cases: ExpressionNode[] = [
      { operator: "toUpperCase", target: ref("#/state/name") },
      { operator: "split", target: ref("#/state/name"), value: " " },
      { operator: "toSorted", target: ref("#/state/scores") },
      { operator: "padStart", target: ref("#/state/name"), value: [15, "*"] },
      { operator: "toUpperCase", target: ref("#/state/missing") },
      { operator: "toFixed", target: 1.23456, value: 2 },
    ];
    const state = { name: "ada lovelace", scores: [3, 1, 2] };
    for (const node of cases) {
      const fn = new Function("state", `return ${compileExpression(node)}`);
      expect(fn(structuredClone(state))).toEqual(
        evaluateExpression(node, structuredClone(state) as JxScope, null) as never,
      );
    }
  });

  test("compiles to optional-chained method calls", () => {
    expect(compileExpression({ operator: "toUpperCase", target: ref("#/state/name") })).toBe(
      "(state.name)?.toUpperCase?.()",
    );
    expect(
      compileExpression({ operator: "padStart", target: ref("#/state/s"), value: [5, "0"] }),
    ).toBe('(state.s)?.padStart?.(5, "0")');
  });
});
