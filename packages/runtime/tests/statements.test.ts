// oxlint-disable unicorn/no-thenable -- `then` is the JSON Schema conditional keyword in branch statements (spec §20), not a promise
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { compileStatements, runStatements } from "../src/statements.ts";

import type { JxStatement } from "@jxsuite/schema/types";
import type { JxScope } from "../src/types.ts";

try {
  GlobalRegistrator.register();
} catch {
  // Already registered
}

const ref = ($ref: string) => ({ $ref });

describe("runStatements — sequential execution", () => {
  test("statements execute in order against the scope", async () => {
    const state: JxScope = { cart: [1], count: 0 };
    await runStatements(
      [
        { operator: "push", target: ref("#/state/cart"), value: 2 },
        { operator: "=", target: ref("#/state/count"), value: ref("#/state/cart/length") },
      ],
      state,
      null,
    );
    expect(state.cart).toEqual([1, 2]);
    expect(state.count).toBe(2);
  });

  test("synchronous bodies complete before the returned promise settles", () => {
    const state: JxScope = { n: 0 };
    void runStatements([{ operator: "=", target: ref("#/state/n"), value: 1 }], state, null);
    // Async functions run synchronously until the first await.
    expect(state.n).toBe(1);
  });

  test("a thenable statement result is awaited before the next statement", async () => {
    const order: string[] = [];
    const state: JxScope = {
      later: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            order.push("async");
            resolve();
          }, 5);
        }),
      mark: () => order.push("sync"),
    };
    await runStatements(
      [
        { operator: "call", target: ref("#/state/later"), value: [] },
        { operator: "call", target: ref("#/state/mark"), value: [] },
      ],
      state,
      null,
    );
    expect(order).toEqual(["async", "sync"]);
  });
});

describe("runStatements — if / then / else", () => {
  const body: JxStatement[] = [
    {
      if: { operator: ">", target: ref("#/state/n"), value: 10 },
      then: [{ operator: "=", target: ref("#/state/label"), value: "big" }],
      else: [{ operator: "=", target: ref("#/state/label"), value: "small" }],
    },
  ];

  test("takes then on truthy test, else otherwise", async () => {
    const big: JxScope = { label: "", n: 11 };
    await runStatements(body, big, null);
    expect(big.label).toBe("big");

    const small: JxScope = { label: "", n: 3 };
    await runStatements(body, small, null);
    expect(small.label).toBe("small");
  });

  test("missing else is a no-op", async () => {
    const state: JxScope = { label: "unchanged", n: 3 };
    await runStatements(
      [
        {
          if: { operator: ">", target: ref("#/state/n"), value: 10 },
          then: [{ operator: "=", target: ref("#/state/label"), value: "big" }],
        },
      ],
      state,
      null,
    );
    expect(state.label).toBe("unchanged");
  });
});

describe("runStatements — $switch / cases", () => {
  const body: JxStatement[] = [
    {
      $switch: ref("#/state/status"),
      cases: {
        error: [{ operator: "=", target: ref("#/state/message"), value: "failed" }],
        ok: [{ operator: "=", target: ref("#/state/message"), value: "done" }],
      },
      default: [{ operator: "=", target: ref("#/state/message"), value: "unknown" }],
    },
  ];

  test("runs the matched case by string form, else default", async () => {
    const ok: JxScope = { message: "", status: "ok" };
    await runStatements(body, ok, null);
    expect(ok.message).toBe("done");

    const other: JxScope = { message: "", status: "pending" };
    await runStatements(body, other, null);
    expect(other.message).toBe("unknown");
  });
});

describe("runStatements — dispatchEvent", () => {
  test("dispatches a CustomEvent with CustomEventInit members on the target", async () => {
    const el = document.createElement("div");
    let seen: CustomEvent | null = null;
    el.addEventListener("cart-changed", (e) => {
      seen = e as CustomEvent;
    });
    await runStatements(
      [
        {
          bubbles: true,
          composed: true,
          detail: ref("#/state/cart"),
          dispatchEvent: "cart-changed",
        },
      ],
      { cart: [1, 2] },
      null,
      { target: el },
    );
    expect(seen).not.toBeNull();
    expect(seen!.detail).toEqual([1, 2]);
    expect(seen!.bubbles).toBe(true);
    expect(seen!.composed).toBe(true);
  });

  test("defaults the target to event.currentTarget; no target is a no-op", async () => {
    const el = document.createElement("button");
    let seen = false;
    el.addEventListener("done", () => {
      seen = true;
    });
    const event = { currentTarget: el } as unknown as Event;
    await runStatements([{ dispatchEvent: "done" }], {}, event);
    expect(seen).toBe(true);
    // Without event or target, nothing throws.
    await runStatements([{ dispatchEvent: "done" }], {}, null);
  });
});

describe("runStatements — $args", () => {
  test("args resolve through $args/ refs in the body", async () => {
    const state: JxScope = { cart: [] };
    await runStatements(
      [{ operator: "push", target: ref("#/state/cart"), value: ref("$args/item") }],
      state,
      null,
      { args: { item: "apple" } },
    );
    expect(state.cart).toEqual(["apple"]);
  });
});

describe("compileStatements — source shapes and equivalence", () => {
  test("expression statements compile with trailing semicolons", () => {
    const source = compileStatements([{ operator: "push", target: ref("#/state/cart"), value: 3 }]);
    expect(source).toBe("state.cart.push(3);");
  });

  test("if/else compiles to an ECMAScript if statement", () => {
    const source = compileStatements([
      {
        if: { operator: ">", target: ref("#/state/n"), value: 10 },
        then: [{ operator: "=", target: ref("#/state/label"), value: "big" }],
        else: [{ operator: "=", target: ref("#/state/label"), value: "small" }],
      },
    ]);
    expect(source).toContain("if ((state.n > 10)) {");
    expect(source).toContain('state.label = "big";');
    expect(source).toContain("} else {");
    expect(source).toContain('state.label = "small";');
  });

  test("$switch compiles to an ECMAScript switch over the string form", () => {
    const source = compileStatements([
      {
        $switch: ref("#/state/status"),
        cases: { ok: [{ operator: "=", target: ref("#/state/message"), value: "done" }] },
        default: [{ operator: "=", target: ref("#/state/message"), value: "unknown" }],
      },
    ]);
    expect(source).toContain("switch (String(state.status)) {");
    expect(source).toContain('case "ok": {');
    expect(source).toContain("break;");
    expect(source).toContain("default: {");
  });

  test("dispatchEvent compiles to a WHATWG dispatchEvent call", () => {
    const source = compileStatements(
      [{ bubbles: true, detail: ref("#/state/cart"), dispatchEvent: "cart-changed" }],
      { eventParam: "e" },
    );
    expect(source).toBe(
      '(e && e.currentTarget)?.dispatchEvent(new CustomEvent("cart-changed", { detail: state.cart, bubbles: true }));',
    );
  });

  test("dispatchTarget override is honored", () => {
    const source = compileStatements([{ dispatchEvent: "done" }], { dispatchTarget: "this" });
    expect(source).toBe('this?.dispatchEvent(new CustomEvent("done"));');
  });

  test("compiled === interpreted for a branching, mutating body", async () => {
    const body: JxStatement[] = [
      { operator: "push", target: ref("#/state/cart"), value: ref("$args/item") },
      {
        if: { operator: ">", target: ref("#/state/cart/length"), value: 2 },
        then: [{ operator: "=", target: ref("#/state/full"), value: true }],
        else: [{ operator: "=", target: ref("#/state/full"), value: false }],
      },
      {
        $switch: ref("#/state/cart/length"),
        cases: { "1": [{ operator: "=", target: ref("#/state/label"), value: "one" }] },
        default: [{ operator: "=", target: ref("#/state/label"), value: "many" }],
      },
    ];

    const interpreted: JxScope = { cart: ["a", "b"], full: false, label: "" };
    await runStatements(body, interpreted, null, { args: { item: "c" } });

    const compiled: JxScope = { cart: ["a", "b"], full: false, label: "" };
    const source = compileStatements(body, { eventParam: "e" });
    new Function("state", "e", "_args", source)(compiled, null, { item: "c" });

    expect(compiled).toEqual(interpreted);
    expect(interpreted.full).toBe(true);
    expect(interpreted.label).toBe("many");
  });
});
