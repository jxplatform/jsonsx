/**
 * Signals panel — pure helper coverage: defCategory, defBadgeLabel, defHint, isCustomElementDoc,
 * collectCssParts, resolveDefaultForCanvas, normParam, signalFieldRow.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { html, render } from "lit-html";
import {
  collectCssParts,
  defBadgeLabel,
  defCategory,
  defHint,
  isCustomElementDoc,
  normParam,
  resolveDefaultForCanvas,
  signalFieldRow,
} from "../src/panels/signals-panel";
import type { SignalDef } from "../src/panels/signals-panel";

// ─── defCategory ──────────────────────────────────────────────────────────────

describe("defCategory", () => {
  test("falsy def is state", () => {
    const missing: SignalDef | undefined = undefined;
    expect(defCategory(null)).toBe("state");
    expect(defCategory(missing)).toBe("state");
    expect(defCategory(0)).toBe("state");
  });

  test("$expression wins over everything", () => {
    expect(defCategory({ $expression: { operator: "=" }, $prototype: "Function" })).toBe(
      "expression",
    );
  });

  test("$handler and Function prototype are functions", () => {
    expect(defCategory({ $handler: "x" })).toBe("function");
    expect(defCategory({ $prototype: "Function", body: "" })).toBe("function");
  });

  test("$compute is computed", () => {
    expect(defCategory({ $compute: "$a + 1" })).toBe("computed");
  });

  test("other $prototype is data", () => {
    expect(defCategory({ $prototype: "Request" })).toBe("data");
    expect(defCategory({ $prototype: "LocalStorage" })).toBe("data");
  });

  test("plain object def is state", () => {
    expect(defCategory({ default: "x", type: "string" })).toBe("state");
  });
});

// ─── defBadgeLabel ────────────────────────────────────────────────────────────

describe("defBadgeLabel", () => {
  test("falsy def → S", () => {
    expect(defBadgeLabel(null)).toBe("S");
  });

  test("category badges", () => {
    expect(defBadgeLabel({ $expression: {} })).toBe("E");
    expect(defBadgeLabel({ $handler: "h" })).toBe("F");
    expect(defBadgeLabel({ $prototype: "Function" })).toBe("F");
    expect(defBadgeLabel({ $compute: "1" })).toBe("C");
    expect(defBadgeLabel({ $prototype: "Request" })).toBe("R");
    expect(defBadgeLabel({ default: 1 })).toBe("S");
  });
});

// ─── defHint ──────────────────────────────────────────────────────────────────

describe("defHint", () => {
  test("no def → empty string", () => {
    const missing: SignalDef | undefined = undefined;
    expect(defHint("x", null)).toBe("");
    expect(defHint("x", missing)).toBe("");
  });

  test("$expression delegates to expressionHint", () => {
    const def: SignalDef = {
      $expression: { operator: "=", target: { $ref: "#/state/$count" } },
    };
    expect(defHint("x", def)).toBe("= $count");
  });

  test("function with short body shows body", () => {
    expect(defHint("x", { $prototype: "Function", body: "return 1" })).toBe("return 1");
  });

  test("function with long body truncates to 20 chars", () => {
    const body = "a".repeat(30);
    expect(defHint("x", { $prototype: "Function", body })).toBe(`${"a".repeat(20)}...`);
  });

  test("function with $src shows source", () => {
    expect(defHint("x", { $prototype: "Function", $src: "./mod.js" })).toBe("./mod.js");
  });

  test("function without body or src", () => {
    expect(defHint("x", { $prototype: "Function" })).toBe("function");
  });

  test("legacy $handler", () => {
    expect(defHint("x", { $handler: "doThing" })).toBe("handler (legacy)");
  });

  test("computed shows = expression, truncated when long", () => {
    expect(defHint("x", { $compute: "$a + $b" })).toBe("=$a + $b");
    const long = "x".repeat(25);
    expect(defHint("x", { $compute: long })).toBe(`=${"x".repeat(20)}...`);
  });

  test("Request shows method and url, with defaults", () => {
    expect(defHint("x", { $prototype: "Request", method: "POST", url: "/api/items" })).toBe(
      "POST /api/items",
    );
    expect(defHint("x", { $prototype: "Request" })).toBe("GET ");
  });

  test("storage prototypes show key", () => {
    expect(defHint("x", { $prototype: "LocalStorage", key: "theme" })).toBe("theme");
    expect(defHint("x", { $prototype: "SessionStorage" })).toBe("");
  });

  test("IndexedDB shows database, Cookie shows name", () => {
    expect(defHint("x", { $prototype: "IndexedDB", database: "appdb" })).toBe("appdb");
    expect(defHint("x", { $prototype: "IndexedDB" })).toBe("");
    expect(defHint("x", { $prototype: "Cookie", name: "sid" })).toBe("sid");
    expect(defHint("x", { $prototype: "Cookie" })).toBe("");
  });

  test("generic $prototype falls back to its name", () => {
    expect(defHint("x", { $prototype: "ContentCollection" })).toBe("ContentCollection");
  });

  test("CEM attribute hint", () => {
    expect(defHint("x", { attribute: "open", type: "boolean" })).toBe("[open] boolean");
    expect(defHint("x", { attribute: "open" })).toBe("[open] ");
  });

  test("plain state shows type or empty", () => {
    expect(defHint("x", { type: "number" })).toBe("number");
    expect(defHint("x", {})).toBe("");
  });
});

// ─── isCustomElementDoc ───────────────────────────────────────────────────────

describe("isCustomElementDoc", () => {
  test("hyphenated tagName is a custom element", () => {
    expect(isCustomElementDoc({ document: { tagName: "my-card" } } as never)).toBe(true);
  });

  test("plain tag / missing tagName is not", () => {
    expect(isCustomElementDoc({ document: { tagName: "div" } } as never)).toBe(false);
    expect(isCustomElementDoc({ document: {} } as never)).toBe(false);
  });
});

// ─── collectCssParts ──────────────────────────────────────────────────────────

describe("collectCssParts", () => {
  test("collects part attributes recursively with tag names", () => {
    const tree = {
      attributes: { part: "base" },
      children: [
        { attributes: { part: "label" }, tagName: "span" },
        "text child",
        { children: [{ attributes: { part: "icon" }, tagName: "i" }], tagName: "div" },
      ],
      tagName: "my-button",
    };
    expect(collectCssParts(tree as never)).toEqual([
      { name: "base", tag: "my-button" },
      { name: "label", tag: "span" },
      { name: "icon", tag: "i" },
    ]);
  });

  test("node without tagName defaults tag to div", () => {
    expect(collectCssParts({ attributes: { part: "x" } } as never)).toEqual([
      { name: "x", tag: "div" },
    ]);
  });

  test("ignores empty / non-string part values and null nodes", () => {
    expect(collectCssParts(null)).toEqual([]);
    expect(collectCssParts({ attributes: { part: "" }, tagName: "div" } as never)).toEqual([]);
    expect(collectCssParts({ attributes: { part: 5 }, tagName: "div" } as never)).toEqual([]);
    expect(collectCssParts({ tagName: "div" } as never)).toEqual([]);
  });
});

// ─── resolveDefaultForCanvas ──────────────────────────────────────────────────

describe("resolveDefaultForCanvas", () => {
  test("non-ref values pass through", () => {
    expect(resolveDefaultForCanvas("hello", {})).toBe("hello");
    expect(resolveDefaultForCanvas(null, {})).toBe(null);
    expect(resolveDefaultForCanvas(0, {})).toBe(0);
    const obj = { a: 1 };
    expect(resolveDefaultForCanvas(obj, {})).toBe(obj);
  });

  test("unknown ref shape → {ref}", () => {
    expect(resolveDefaultForCanvas({ $ref: "other/path" }, {})).toBe("{other/path}");
  });

  test("missing def → {name}", () => {
    expect(resolveDefaultForCanvas({ $ref: "#/state/foo" }, {})).toBe("{foo}");
    expect(resolveDefaultForCanvas({ $ref: "#/state/foo" }, null)).toBe("{foo}");
  });

  test("$-prefixed ref resolves by full name", () => {
    expect(resolveDefaultForCanvas({ $ref: "$title" }, { $title: { default: "Hi" } })).toBe("Hi");
  });

  test("state def uses default — scalar, object, and missing", () => {
    expect(resolveDefaultForCanvas({ $ref: "#/state/n" }, { n: { default: 42 } })).toBe("42");
    expect(resolveDefaultForCanvas({ $ref: "#/state/o" }, { o: { default: { a: 1 } } })).toBe(
      '{"a":1}',
    );
    expect(resolveDefaultForCanvas({ $ref: "#/state/e" }, { e: { type: "string" } })).toBe("");
    expect(resolveDefaultForCanvas({ $ref: "#/state/z" }, { z: { default: null } })).toBe("");
  });

  test("naked primitive state entry resolves to empty view", () => {
    expect(resolveDefaultForCanvas({ $ref: "#/state/p" }, { p: 5 } as never)).toBe("");
  });

  test("computed def → ƒ(name)", () => {
    expect(resolveDefaultForCanvas({ $ref: "#/state/c" }, { c: { $compute: "$a" } })).toBe("ƒ(c)");
  });

  test("Request def → ⟳ url, falling back to fetch", () => {
    expect(
      resolveDefaultForCanvas({ $ref: "#/state/r" }, { r: { $prototype: "Request", url: "/x" } }),
    ).toBe("⟳ /x");
    expect(resolveDefaultForCanvas({ $ref: "#/state/r" }, { r: { $prototype: "Request" } })).toBe(
      "⟳ fetch",
    );
  });

  test("storage def uses default, key, or storage placeholder", () => {
    const defs = {
      a: { $prototype: "LocalStorage", default: "dark", key: "theme" },
      b: { $prototype: "SessionStorage", default: { x: 1 }, key: "s" },
      c: { $prototype: "LocalStorage", key: "theme" },
      d: { $prototype: "SessionStorage" },
    };
    expect(resolveDefaultForCanvas({ $ref: "#/state/a" }, defs)).toBe("dark");
    expect(resolveDefaultForCanvas({ $ref: "#/state/b" }, defs)).toBe('{"x":1}');
    expect(resolveDefaultForCanvas({ $ref: "#/state/c" }, defs)).toBe("[theme]");
    expect(resolveDefaultForCanvas({ $ref: "#/state/d" }, defs)).toBe("[storage]");
  });

  test("other prototypes → {Prototype}", () => {
    expect(resolveDefaultForCanvas({ $ref: "#/state/m" }, { m: { $prototype: "Map" } })).toBe(
      "{Map}",
    );
  });
});

// ─── normParam ────────────────────────────────────────────────────────────────

describe("normParam", () => {
  test("string becomes { name }", () => {
    expect(normParam("event")).toEqual({ name: "event" });
  });

  test("object passes through unchanged", () => {
    const p = { name: "x", optional: true };
    expect(normParam(p)).toBe(p);
  });
});

// ─── signalFieldRow ───────────────────────────────────────────────────────────

describe("signalFieldRow", () => {
  test("renders a field row with label and textfield value", () => {
    const container = document.createElement("div");
    render(html`${signalFieldRow("Name", "current", () => {})}`, container);
    const row = container.querySelector('[data-prop="Name"]');
    expect(row).not.toBeNull();
    const tf = row?.querySelector("sp-textfield") as { value?: string } | null;
    expect(tf).not.toBeNull();
    expect(tf?.value).toBe("current");
  });

  test("change event commits a new value", () => {
    const container = document.createElement("div");
    const seen: string[] = [];
    render(html`${signalFieldRow("Name", "old", (v) => seen.push(v))}`, container);
    const tf = container.querySelector("sp-textfield") as HTMLElement & { value: string };
    tf.value = "renamed";
    tf.dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen).toEqual(["renamed"]);
  });

  test("unchanged value does not call onChange", () => {
    const container = document.createElement("div");
    const seen: string[] = [];
    render(html`${signalFieldRow("Name", "same", (v) => seen.push(v))}`, container);
    const tf = container.querySelector("sp-textfield") as HTMLElement & { value: string };
    tf.value = "same";
    tf.dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen).toEqual([]);
  });
});
