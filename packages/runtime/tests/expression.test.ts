import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import {
  BLESSED_OPERATORS,
  compileExpression,
  evaluateExpression,
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
