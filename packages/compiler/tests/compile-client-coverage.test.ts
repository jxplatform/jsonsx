import { describe, expect, test } from "bun:test";
import { compileClient } from "../src/targets/compile-client";
import type { JxDocument } from "@jxsuite/schema/types";

const asDoc = (d: unknown) => d as JxDocument;
const compile = (doc: unknown) => compileClient(asDoc(doc), { title: "Test" }).files[0]!.content;

describe("compileClient — $expression state entries", () => {
  test("mutating $expression becomes an `on` handler, pure becomes a computed", () => {
    const js = compile({
      children: [{ tagName: "p", textContent: "${state.doubled}" }],
      state: {
        bump: { $expression: { operator: "+=", target: { $ref: "#/state/count" }, value: 1 } },
        count: 5,
        doubled: { $expression: { operator: "*", target: { $ref: "#/state/count" }, value: 2 } },
      },
      tagName: "div",
    });
    expect(js).toContain("bump");
    expect(js).toContain("doubled");
  });
});

describe("compileClient — $expression event handlers", () => {
  test("inline $expression on an event attribute compiles to a handler", () => {
    const js = compile({
      children: [
        {
          onclick: { $expression: { operator: "+=", target: { $ref: "#/state/count" }, value: 1 } },
          tagName: "button",
          textContent: "+",
        },
      ],
      state: { count: 0 },
      tagName: "div",
    });
    // The inline expression handler is emitted into the module's `on` table.
    expect(js).toContain("state.count += 1");
  });
});

describe("compileClient — client-rendered map templates", () => {
  test("map template with id, className, handlers, nested arrays and scalar children", () => {
    const js = compile({
      children: [
        {
          $prototype: "Array",
          items: { $ref: "#/state/items" },
          map: {
            children: [
              "plain",
              "${item}",
              42,
              true,
              { $prototype: "Array", items: { $ref: "#/state/sub" }, map: { tagName: "em" } },
              { tagName: "span", textContent: "${item}" },
            ],
            className: "row",
            id: "item-row",
            onclick: { $ref: "#/state/handler" },
            onkeydown: {
              $expression: { operator: "+=", target: { $ref: "#/state/count" }, value: 1 },
            },
            onmouseover: { $prototype: "Function", body: "state.count++" },
            tagName: "li",
          },
        },
        // Whole-children repeater nested inside a map template.
        {
          $prototype: "Array",
          items: { $ref: "#/state/groups" },
          map: {
            children: {
              $prototype: "Array",
              items: { $ref: "#/state/sub" },
              map: { tagName: "b" },
            },
            tagName: "ul",
          },
        },
        // Mapped array with no map template → empty lit template.
        { $prototype: "Array", items: { $ref: "#/state/empty" } },
      ],
      state: {
        count: 0,
        empty: [],
        groups: [],
        handler: { $prototype: "Function", body: "state.count++" },
        items: [],
        sub: [],
      },
      tagName: "div",
    });
    expect(js).toContain('id="item-row"');
    expect(js).toContain('class="row"');
    expect(js).toContain("@click");
    expect(js).toContain("@mouseover");
    expect(js).toContain("@keydown");
    // Scalar children rendered inline.
    expect(js).toContain("42");
    expect(js).toContain("plain");
  });
});

describe("compileClient — structured statement bodies (spec §20)", () => {
  test("named $expression formula becomes a positional scope callable", () => {
    const js = compile({
      children: [{ tagName: "p", textContent: "static" }],
      state: {
        count: 1,
        double: {
          $expression: { operator: "*", target: { $ref: "#/$args/n" }, value: 2 },
          parameters: ["n"],
        },
      },
      tagName: "div",
    });
    expect(js).toContain('state["double"] = (..._a) =>');
    expect(js).toContain('"n": _a[0]');
  });

  test("Function def with a statement-array body and no parameters becomes an on handler", () => {
    const js = compile({
      children: [{ tagName: "button", textContent: "+" }],
      state: {
        bump: {
          $prototype: "Function",
          body: [{ operator: "+=", target: { $ref: "#/state/count" }, value: 1 }],
        },
        count: 0,
      },
      tagName: "div",
    });
    expect(js).toContain("state.count += 1");
  });

  test("Function def with a statement-array body and parameters becomes a scope callable", () => {
    const js = compile({
      children: [{ tagName: "p", textContent: "static" }],
      state: {
        applyStep: {
          $prototype: "Function",
          body: [{ operator: "+=", target: { $ref: "#/state/count" }, value: 1 }],
          parameters: ["step"],
        },
        count: 0,
      },
      tagName: "div",
    });
    expect(js).toContain('state["applyStep"] = (..._a) =>');
    expect(js).toContain('"step": _a[0]');
  });

  test("inline event handler with a statement-array body compiles into the handler table", () => {
    const out = compileClient(
      asDoc({
        children: [
          {
            onclick: {
              $prototype: "Function",
              body: [{ operator: "-=", target: { $ref: "#/state/count" }, value: 2 }],
            },
            tagName: "button",
            textContent: "-",
          },
        ],
        state: { count: 10 },
        tagName: "div",
      }),
      { title: "Test" },
    );
    // The bind attribute lands in the HTML tree; the compiled body in the JS handler table.
    expect(out.html).toContain('@click="_h0"');
    expect(out.files[0]!.content).toContain("state.count -= 2");
  });

  test("map-template event handler with a statement-array body binds $map scope", () => {
    const js = compile({
      children: [
        {
          $prototype: "Array",
          items: { $ref: "#/state/items" },
          map: {
            onclick: {
              $prototype: "Function",
              body: [{ operator: "+=", target: { $ref: "#/state/clicks" }, value: 1 }],
            },
            tagName: "li",
            textContent: "${item}",
          },
        },
      ],
      state: { clicks: 0, items: ["a"] },
      tagName: "ul",
    });
    expect(js).toContain("state.$map = { item, index }");
    expect(js).toContain("state.clicks += 1");
  });

  test("unrecognized prototype defs fall through to plain reactive state", () => {
    const js = compile({
      children: [{ tagName: "p", textContent: "static" }],
      state: { posts: { $prototype: "ContentCollection", contentType: "posts" } },
      tagName: "div",
    });
    expect(js).toContain("ContentCollection");
  });
});

describe("compileClient — binding merge and scheme pre-paint", () => {
  test("multiple inline template bindings dedupe through the merge loop", () => {
    const js = compile({
      children: [
        { tagName: "p", textContent: "${state.count}" },
        { tagName: "span", textContent: "${state.count * 2}" },
      ],
      state: { count: 1 },
      tagName: "div",
    });
    expect(js).toContain("_t0");
    expect(js).toContain("_t1");
  });

  test("inline handlers merge alongside state-level handlers", () => {
    const js = compile({
      children: [
        {
          onclick: { $expression: { operator: "-=", target: { $ref: "#/state/count" }, value: 1 } },
          tagName: "button",
          textContent: "-",
        },
      ],
      state: {
        bump: { $expression: { operator: "+=", target: { $ref: "#/state/count" }, value: 1 } },
        count: 0,
      },
      tagName: "div",
    });
    // The state-level handler and the inline-discovered one coexist in the on table.
    expect(js).toContain("state.count += 1");
    expect(js).toContain("state.count -= 1");
  });

  test("a forced-scheme $media query injects the pre-paint script", () => {
    const withScheme = compileClient(
      asDoc({
        $media: { "--dark": "(prefers-color-scheme: dark)" },
        children: [{ tagName: "p", textContent: "hi" }],
        state: { count: 0 },
        tagName: "div",
      }),
      { title: "Test" },
    );
    const without = compileClient(
      asDoc({
        $media: { "--md": "(max-width: 768px)" },
        children: [{ tagName: "p", textContent: "hi" }],
        state: { count: 0 },
        tagName: "div",
      }),
      { title: "Test" },
    );
    expect(withScheme.html).toContain("<script>");
    expect(without.html.split("<script")).toHaveLength(withScheme.html.split("<script").length - 1);
  });
});

describe("compileClient — repeated $ref bindings", () => {
  test("two elements bound to the same state ref share one binding entry", () => {
    const js = compile({
      children: [
        { tagName: "p", textContent: { $ref: "#/state/count" } },
        { tagName: "span", textContent: { $ref: "#/state/count" } },
      ],
      state: { count: 7 },
      tagName: "div",
    });
    // One binding, referenced by both elements.
    expect(js.match(/count: \(\) => state\.count/g) ?? []).toHaveLength(1);
  });
});
