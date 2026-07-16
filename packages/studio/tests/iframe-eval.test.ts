/**
 * In-iframe live expression evaluation (M6) — pure unit tests for the scope clone (live values,
 * named-formula callables kept, side-effecting functions dropped), the repeater `$map` context
 * binding from a shadow-doc context path, and the per-expression trace/error guarding.
 */
import { describe, expect, test } from "bun:test";
import { bindRepeaterContext, cloneLiveScope, evaluateLiveExprs } from "../src/canvas/iframe-eval";

describe("cloneLiveScope", () => {
  test("deep-clones plain data so mutations never reach the source", () => {
    const defs = { items: [1, 2], title: "Home" };
    const clone = cloneLiveScope(defs, null);
    expect(clone).toEqual({ items: [1, 2], title: "Home" });
    (clone.items as number[]).push(3);
    expect(defs.items).toEqual([1, 2]);
  });

  test("keeps named-formula callables by reference, drops other functions", () => {
    const lineTotal = (price: number, qty: number) => price * qty;
    const handler = () => "side effect";
    const defs = { handler, lineTotal };
    const rawState = {
      handler: { $prototype: "Function", body: "..." },
      lineTotal: { $expression: { operator: "*" }, parameters: ["price", "qty"] },
    };
    const clone = cloneLiveScope(defs, rawState);
    expect(clone.lineTotal).toBe(lineTotal);
    expect("handler" in clone).toBe(false);
  });

  test("a throwing getter maps its key to null instead of aborting the clone", () => {
    const defs = { ok: 1 };
    Object.defineProperty(defs, "boom", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    const clone = cloneLiveScope(defs as Record<string, unknown>, null);
    expect(clone.ok).toBe(1);
    expect(clone.boom).toBeNull();
  });
});

describe("bindRepeaterContext", () => {
  const SHADOW = {
    children: [
      {
        $prototype: "Array",
        items: { $ref: "#/state/products" },
        map: { children: [{ tagName: "h3" }], tagName: "li" },
      },
    ],
    state: { products: { $ref: "ignored-here" } },
    tagName: "ul",
  };

  test("binds the first item's $map context when the path enters a repeater template", () => {
    const scope = { products: [{ title: "First" }, { title: "Second" }] };
    const bound = bindRepeaterContext(scope, SHADOW, ["children", 0, "map", "children", 0]);
    expect(bound["$map/item"]).toEqual({ title: "First" });
    expect(bound["$map/index"]).toBe(0);
    expect((bound.$map as { item: unknown }).item).toEqual({ title: "First" });
    // The base scope is still reachable through the prototype chain.
    expect(bound.products).toEqual([{ title: "First" }, { title: "Second" }]);
  });

  test("a literal items array binds a CLONE of the first item (shadow doc stays pristine)", () => {
    const shadow = {
      children: [
        {
          $prototype: "Array",
          items: [{ n: 1 }],
          map: { tagName: "li" },
        },
      ],
      tagName: "ul",
    };
    const bound = bindRepeaterContext({}, shadow, ["children", 0, "map"]);
    expect(bound["$map/item"]).toEqual({ n: 1 });
    (bound["$map/item"] as { n: number }).n = 99;
    expect(shadow.children[0]!.items[0]!.n).toBe(1);
  });

  test("no repeater on the path / null path → the scope is returned unchanged", () => {
    const scope = { a: 1 };
    expect(bindRepeaterContext(scope, SHADOW, null)).toBe(scope);
    expect(bindRepeaterContext(scope, SHADOW, ["children", 0])).toBe(scope);
  });

  test("empty items leave the $map context unbound", () => {
    const bound = bindRepeaterContext({ products: [] }, SHADOW, ["children", 0, "map"]);
    expect(bound["$map/item"]).toBeUndefined();
  });
});

describe("evaluateLiveExprs", () => {
  test("evaluates each expression with per-node formatted trace values", () => {
    const results = evaluateLiveExprs(
      [{ id: "sum", node: { operator: "+", target: { $ref: "#/state/a" }, value: 2 } }],
      { a: 40 },
      null,
      null,
    );
    expect(results).toHaveLength(1);
    const values = new Map(results[0]!.values);
    expect(results[0]!.id).toBe("sum");
    expect(results[0]!.error).toBeUndefined();
    expect(values.get("")).toBe("42");
    expect(values.get("target")).toBe("40");
    expect(values.get("value")).toBe("2");
  });

  test("guards errors per expression — one failure never poisons the batch", () => {
    const results = evaluateLiveExprs(
      [
        { id: "bad", node: { operator: "bogus", target: 1 } },
        { id: "notExpr", node: { nope: true } },
        { id: "good", node: { operator: "+", target: 1, value: 1 } },
      ],
      {},
      null,
      null,
    );
    expect(results[0]!.error).toContain("unknown operator");
    expect(results[1]!.error).toBe("not an expression node");
    expect(results[2]!.error).toBeUndefined();
    expect(new Map(results[2]!.values).get("")).toBe("2");
  });

  test("mutating expressions run against a fresh clone — the live defs never change", () => {
    const defs = { cart: [1, 2] };
    const push = { operator: "push", target: { $ref: "#/state/cart" }, value: 3 };
    const first = evaluateLiveExprs([{ id: "p", node: push }], defs, null, null);
    const second = evaluateLiveExprs([{ id: "p", node: push }], defs, null, null);
    // Both evaluations saw the SAME pre-mutation state (push returns the new length: 3, not 4).
    expect(new Map(first[0]!.values).get("")).toBe("3");
    expect(new Map(second[0]!.values).get("")).toBe("3");
    expect(defs.cart).toEqual([1, 2]);
  });

  test("binds repeater context from the shadow doc so $map refs preview with real items", () => {
    const shadow = {
      children: [
        {
          $prototype: "Array",
          items: { $ref: "#/state/products" },
          map: { tagName: "li" },
        },
      ],
      tagName: "ul",
    };
    const results = evaluateLiveExprs(
      [{ id: "t", node: { operator: "??", target: { $ref: "$map/item/title" }, value: "?" } }],
      { products: [{ title: "Kubota U35" }] },
      shadow,
      ["children", 0, "map"],
    );
    expect(results[0]!.error).toBeUndefined();
    expect(new Map(results[0]!.values).get("")).toBe('"Kubota U35"');
  });

  test("a `call` to a named-formula callable works against the live scope", () => {
    const shadow = {
      state: {
        lineTotal: {
          $expression: { operator: "*" },
          parameters: ["price", "qty"],
        },
      },
      tagName: "div",
    };
    const defs = { lineTotal: (price: number, qty: number) => price * qty };
    const results = evaluateLiveExprs(
      [
        {
          id: "c",
          node: { operator: "call", target: { $ref: "#/state/lineTotal" }, value: [6, 7] },
        },
      ],
      defs,
      shadow,
      null,
    );
    expect(results[0]!.error).toBeUndefined();
    expect(new Map(results[0]!.values).get("")).toBe("42");
  });
});
