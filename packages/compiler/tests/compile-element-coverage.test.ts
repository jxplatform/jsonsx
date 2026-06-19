import { describe, expect, test } from "bun:test";
import { compileElement } from "../src/compiler";
import type { JxDocument } from "@jxsuite/schema/types";

const asDoc = (d: unknown) => d as JxDocument;

describe("compileElement — coverage edge cases", () => {
  test("$switch element, $ref text/attrs, null/object children, rich mapped arrays", async () => {
    const result = await compileElement(
      asDoc({
        children: [
          // $switch with a static case and an external $ref case (the latter is skipped).
          {
            $switch: { $ref: "#/state/view" },
            cases: {
              a: { tagName: "span", textContent: "A view" },
              ext: { $ref: "./external.json" },
            },
            tagName: "div",
          },
          // TextContent as a $ref object.
          { tagName: "p", textContent: { $ref: "#/state/label" } },
          // Attribute as a $ref object.
          { attributes: { "data-id": { $ref: "#/state/label" } }, tagName: "section" },
          // Null child + bare string child.
          { children: [null, "text"], tagName: "article" },
          // Non-array, non-mapped children object.
          { children: { notArray: true }, tagName: "aside" },
          // Mapped array among siblings with $props, style and event handlers.
          {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              $props: { label: "static", value: { $ref: "$map/item" } },
              onclick: { $ref: "#/state/handler" },
              onkeydown: {
                $expression: { operator: "+=", target: { $ref: "#/state/n" }, value: 1 },
              },
              style: { color: "red" },
              tagName: "li",
              textContent: "${item}",
            },
          },
          // Whole-children mapped array with no map template.
          { children: { $prototype: "Array", items: { $ref: "#/state/empty" } }, tagName: "ul" },
        ],
        state: {
          empty: [],
          handler: { $prototype: "Function", body: "this.state.n++" },
          items: [],
          label: "L",
          n: 0,
          view: "a",
        },
        tagName: "test-elcov",
      }),
    );

    const { content } = result.files[0]!;
    expect(content).toContain("A view");
    expect(content).toContain("class TestElcov extends HTMLElement");
    // Switch renders a keyed template map.
    expect(content).toContain('"a":');
    // Mapped array map() expansion present.
    expect(content).toContain(".map(");
  });
});
