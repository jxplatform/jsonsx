/**
 * Dynamic-slot gaps — the seed each rung lands on when the field has no memory of it, and the
 * write-through of every rung's own widget.
 */
import { pointer, renderInto } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { html } from "lit-html";
import { renderDynamicSlot, resetSlotModeMemory } from "../src/ui/dynamic-slot";
import type { DynamicSlotOpts } from "../src/ui/dynamic-slot";

describe("rung seeds and widget write-through", () => {
  const staticWidget = html`<input class="static-widget" />`;

  beforeEach(() => {
    resetSlotModeMemory();
  });

  async function renderSlot(opts: Partial<DynamicSlotOpts> & { value: unknown }) {
    const parts = renderDynamicSlot({
      caps: "repeaterItems",
      fieldKey: "gaps|0|field",
      onChange: () => {},
      staticWidget,
      stateDefs: [],
      ...opts,
    });
    return renderInto(html`${parts.widget}${parts.modeButton}`);
  }

  function choose(container: HTMLElement, mode: string) {
    pointer(container.querySelector(`sp-menu-item[data-mode="${mode}"]`)!, "click");
  }

  test("choosing Formula seeds a ?? scaffold", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: { schema: { oneOf: [{ type: "string" }, { $ref: "#/$defs/ExpressionEntry" }] } },
      onChange,
      value: "static text",
    });
    choose(container, "expression");
    expect(onChange).toHaveBeenCalledWith({
      $expression: { operator: "??", target: null, value: null },
    });
  });

  test("choosing Inline function seeds an empty Function entry", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: { schema: { oneOf: [{ type: "number" }, { $ref: "#/$defs/FunctionDef" }] } },
      onChange,
      value: "static text",
    });
    choose(container, "function");
    expect(onChange).toHaveBeenCalledWith({
      $prototype: "Function",
      body: "",
      parameters: [],
    });
  });

  test("the ref picker's change commits a $ref (or clears on empty)", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      onChange,
      stateDefs: ["count"],
      value: { $ref: "#/state/count" },
    });
    const picker = container.querySelector("sp-picker") as HTMLElement & { value: string };
    picker.value = "#/state/count";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith({ $ref: "#/state/count" });
    picker.value = "";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith();
  });

  test("the template textfield's change commits the raw template string", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: "styleProperty",
      onChange,
      value: "${state.count}",
    });
    const field = container.querySelector("sp-textfield") as HTMLElement & { value: string };
    field.value = "${state.count} items";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("${state.count} items");
  });

  test("an expression-editor change re-wraps the node in $expression", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: {
        schema: {
          oneOf: [
            { type: "number" },
            { $ref: "#/$defs/RefObject" },
            { $ref: "#/$defs/ExpressionEntry" },
          ],
        },
      },
      onChange,
      stateDefs: ["count"],
      value: { $expression: { operator: "??", target: { $ref: "#/state/count" }, value: 1 } },
    });
    const picker = container.querySelector(".expression-editor sp-picker") as HTMLElement & {
      value: string;
    };
    picker.value = "!";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const [wrapped] = onChange.mock.calls[0]! as unknown as [{ $expression: { operator: string } }];
    expect(wrapped.$expression.operator).toBe("!");
  });

  test("ref mode lists extraSignals below a divider", async () => {
    const container = await renderSlot({
      extraSignals: [{ label: "item", value: "$map/item" }],
      stateDefs: ["count"],
      value: { $ref: "#/state/count" },
    });
    expect(container.querySelector("sp-menu-divider")).not.toBeNull();
    const items = [...container.querySelectorAll("sp-picker sp-menu-item")].map((i) =>
      i.getAttribute("value"),
    );
    expect(items).toContain("$map/item");
  });

  test("leaving from-data seeds the fixed-value stash with the declared default", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: "attribute",
      literalDefault: "declared default",
      onChange,
      stateDefs: ["count"],
      value: { $ref: "#/state/count" },
    });
    // Ref → mixed text → fixed value: the seed survives the detour the picker no longer forces.
    choose(container, "template");
    const back = await renderSlot({
      caps: "attribute",
      onChange,
      stateDefs: ["count"],
      value: "${state.count}",
    });
    choose(back, "literal");
    expect(onChange).toHaveBeenLastCalledWith("declared default");
  });

  test("landing on a fixed value with no memory and no declared default clears the position", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: "styleProperty",
      onChange,
      stateDefs: ["count"],
      value: "${state.count}",
    });
    choose(container, "literal");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]).toEqual([undefined] as never);
  });

  test("a schema that permits nothing offers nothing, and says so on the chip", async () => {
    /* No floor is invented here. A position whose schema yields no rung is a schema bug, and a
       chip that quietly offered two rungs anyway would hide it. */
    const container = await renderSlot({
      caps: { schema: { description: "not a schema at all" } },
      stateDefs: ["count"],
      value: "hello",
    });
    expect(container.querySelectorAll("sp-menu-item[data-mode]")).toHaveLength(0);
    expect(container.querySelector(".dynamic-slot-mode")!.hasAttribute("disabled")).toBe(true);
  });
});
