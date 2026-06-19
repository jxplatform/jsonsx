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
