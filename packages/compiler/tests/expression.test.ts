import { describe, test, expect } from "bun:test";
import { compileExpression } from "@jxsuite/runtime/expression";
import { compileElement } from "../src/compiler";
import { buildInitialScope } from "../src/shared";

// ─── compileExpression unit tests ────────────────────────────────────────────

describe("compileExpression — unary operators", () => {
  test("! negation", () => {
    const node = { operator: "!", target: { $ref: "#/state/flag" } };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("!(s.flag)");
  });

  test("- negation", () => {
    const node = { operator: "-", target: { $ref: "#/state/count" } };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("-(s.count)");
  });
});

describe("compileExpression — binary operators", () => {
  test("addition", () => {
    const node = {
      operator: "+",
      target: { $ref: "#/state/a" },
      value: { $ref: "#/state/b" },
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("(s.a + s.b)");
  });

  test("comparison ===", () => {
    const node = {
      operator: "===",
      target: { $ref: "#/state/count" },
      value: 0,
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("(s.count === 0)");
  });

  test("nested binary", () => {
    const node = {
      operator: "+",
      target: { $ref: "#/state/a" },
      value: { operator: "*", target: { $ref: "#/state/b" }, value: 2 },
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("(s.a + (s.b * 2))");
  });

  test("logical &&", () => {
    const node = {
      operator: "&&",
      target: { $ref: "#/state/a" },
      value: { $ref: "#/state/b" },
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("(s.a && s.b)");
  });
});

describe("compileExpression — assignment operators", () => {
  test("simple =", () => {
    const node = { operator: "=", target: { $ref: "#/state/count" }, value: 0 };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("s.count = 0");
  });

  test("+= compound", () => {
    const node = {
      operator: "+=",
      target: { $ref: "#/state/count" },
      value: 1,
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("s.count += 1");
  });

  test("= with event# ref", () => {
    const node = {
      operator: "=",
      target: { $ref: "#/state/name" },
      value: { $ref: "event#/target/value" },
    };
    expect(compileExpression(node, { statePrefix: "s", eventParam: "e" })).toBe(
      "s.name = e.target.value",
    );
  });

  test("= toggle with nested !", () => {
    const node = {
      operator: "=",
      target: { $ref: "#/state/dark" },
      value: { operator: "!", target: { $ref: "#/state/dark" } },
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("s.dark = !(s.dark)");
  });
});

describe("compileExpression — array methods", () => {
  test("push", () => {
    const node = {
      operator: "push",
      target: { $ref: "#/state/items" },
      value: { $ref: "$map/item" },
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("s.items.push(_item)");
  });

  test("pop", () => {
    const node = { operator: "pop", target: { $ref: "#/state/items" } };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("s.items.pop()");
  });

  test("splice with array args", () => {
    const node = {
      operator: "splice",
      target: { $ref: "#/state/items" },
      value: [{ $ref: "$map/index" }, 1],
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("s.items.splice(_index, 1)");
  });

  test("unshift", () => {
    const node = {
      operator: "unshift",
      target: { $ref: "#/state/items" },
      value: "new",
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe('s.items.unshift("new")');
  });
});

describe("compileExpression — aggregates", () => {
  test("reduce: sum", () => {
    const node = {
      operator: "reduce",
      target: { $ref: "#/state/nums" },
      initial: 0,
      value: {
        operator: "+",
        target: { $ref: "$reduce/acc" },
        value: { $ref: "$map/item" },
      },
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe(
      "s.nums.reduce((_acc, _item, _index) => (_acc + _item), 0)",
    );
  });

  test("map: double", () => {
    const node = {
      operator: "map",
      target: { $ref: "#/state/nums" },
      value: { operator: "*", target: { $ref: "$map/item" }, value: 2 },
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe(
      "s.nums.map((_item, _index) => (_item * 2))",
    );
  });

  test("filter: keep > 0", () => {
    const node = {
      operator: "filter",
      target: { $ref: "#/state/items" },
      value: { operator: ">", target: { $ref: "$map/item" }, value: 0 },
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe(
      "s.items.filter((_item, _index) => (_item > 0))",
    );
  });

  test("reduce: cart total (nested multiply)", () => {
    const node = {
      operator: "reduce",
      target: { $ref: "#/state/cart" },
      initial: 0,
      value: {
        operator: "+",
        target: { $ref: "$reduce/acc" },
        value: {
          operator: "*",
          target: { $ref: "$map/item/price" },
          value: { $ref: "$map/item/qty" },
        },
      },
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe(
      "s.cart.reduce((_acc, _item, _index) => (_acc + (_item.price * _item.qty)), 0)",
    );
  });
});

describe("compileExpression — $ref schemes", () => {
  test("$map/item nested path", () => {
    const node = {
      operator: "+",
      target: { $ref: "$map/item/price" },
      value: 0,
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("(_item.price + 0)");
  });

  test("$map/index", () => {
    const node = { operator: "+", target: { $ref: "$map/index" }, value: 1 };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("(_index + 1)");
  });

  test("event# nested path", () => {
    const node = {
      operator: "=",
      target: { $ref: "#/state/x" },
      value: { $ref: "event#/detail/id" },
    };
    expect(compileExpression(node, { statePrefix: "s", eventParam: "ev" })).toBe(
      "s.x = ev.detail.id",
    );
  });

  test("window#", () => {
    const node = {
      operator: "+",
      target: { $ref: "window#/innerWidth" },
      value: 0,
    };
    expect(compileExpression(node, { statePrefix: "s" })).toBe("(window.innerWidth + 0)");
  });
});

// ─── compileElement integration ──────────────────────────────────────────────

describe("compileElement — $expression state entries", () => {
  test("mutating expression emits handler function", async () => {
    const result = await compileElement({
      tagName: "test-expr-handler",
      state: {
        count: 0,
        increment: {
          $expression: {
            operator: "+=",
            target: { $ref: "#/state/count" },
            value: 1,
          },
        },
      },
      children: [],
    });
    const content = result.files[0].content;
    expect(content).toContain("this.state.increment = (s, e) => { s.count += 1; };");
  });

  test("pure expression emits computed", async () => {
    const result = await compileElement({
      tagName: "test-expr-computed",
      state: {
        a: 3,
        b: 4,
        sum: {
          $expression: {
            operator: "+",
            target: { $ref: "#/state/a" },
            value: { $ref: "#/state/b" },
          },
        },
      },
      children: [],
    });
    const content = result.files[0].content;
    expect(content).toContain("this.state.sum = computed(() => (this.state.a + this.state.b));");
  });

  test("inline $expression on event emits @event handler", async () => {
    const result = await compileElement({
      tagName: "test-expr-inline",
      state: { count: 0 },
      children: [
        {
          tagName: "button",
          textContent: "Click",
          onclick: {
            $expression: {
              operator: "+=",
              target: { $ref: "#/state/count" },
              value: 1,
            },
          },
        },
      ],
    });
    const content = result.files[0].content;
    expect(content).toContain('@click="${(e) => { s.count += 1; }}"');
  });

  test("toggle expression compiles correctly", async () => {
    const result = await compileElement({
      tagName: "test-expr-toggle",
      state: {
        dark: false,
        toggleDark: {
          $expression: {
            operator: "=",
            target: { $ref: "#/state/dark" },
            value: { operator: "!", target: { $ref: "#/state/dark" } },
          },
        },
      },
      children: [],
    });
    const content = result.files[0].content;
    expect(content).toContain("this.state.toggleDark = (s, e) => { s.dark = !(s.dark); };");
  });

  test("reduce aggregate emits computed", async () => {
    const result = await compileElement({
      tagName: "test-expr-reduce",
      state: {
        nums: [1, 2, 3],
        total: {
          $expression: {
            operator: "reduce",
            target: { $ref: "#/state/nums" },
            initial: 0,
            value: {
              operator: "+",
              target: { $ref: "$reduce/acc" },
              value: { $ref: "$map/item" },
            },
          },
        },
      },
      children: [],
    });
    const content = result.files[0].content;
    expect(content).toContain(
      "this.state.total = computed(() => this.state.nums.reduce((_acc, _item, _index) => (_acc + _item), 0));",
    );
  });
});

// ─── buildInitialScope (static) ──────────────────────────────────────────────

describe("buildInitialScope — $expression", () => {
  test("pure expression evaluates at build time", () => {
    const scope = buildInitialScope({
      a: 3,
      b: 4,
      sum: {
        $expression: {
          operator: "+",
          target: { $ref: "#/state/a" },
          value: { $ref: "#/state/b" },
        },
      },
    });
    expect(scope.sum).toBe(7);
  });

  test("mutating expression becomes a function", () => {
    const scope = buildInitialScope({
      count: 0,
      increment: {
        $expression: {
          operator: "+=",
          target: { $ref: "#/state/count" },
          value: 1,
        },
      },
    });
    expect(typeof scope.increment).toBe("function");
    (scope as any).increment(scope, null);
    expect(scope.count).toBe(1);
  });

  test("$expression not treated as plain object", () => {
    const scope = buildInitialScope({
      toggle: {
        $expression: {
          operator: "=",
          target: { $ref: "#/state/on" },
          value: { operator: "!", target: { $ref: "#/state/on" } },
        },
      },
      on: false,
    });
    expect(typeof scope.toggle).toBe("function");
  });
});
