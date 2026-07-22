/**
 * Dynamic-slot gaps — defaultForSlotMode's expression seed and the literal fallback default when no
 * per-mode memory exists.
 */
import { pointer, renderInto } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { html } from "lit-html";
import { renderDynamicSlot, resetSlotModeMemory } from "../src/ui/dynamic-slot";
import type { DynamicSlotOpts } from "../src/ui/dynamic-slot";

describe("mode-cycle defaults", () => {
  const staticWidget = html`<input class="static-widget" />`;

  beforeEach(() => {
    resetSlotModeMemory();
  });

  async function renderSlot(opts: Partial<DynamicSlotOpts> & { value: unknown }) {
    const parts = renderDynamicSlot({
      caps: ["literal", "ref"],
      fieldKey: "gaps|0|field",
      onChange: () => {},
      staticWidget,
      stateDefs: [],
      ...opts,
    });
    return renderInto(html`${parts.widget}${parts.modeButton}`);
  }

  test("escalating into expression mode seeds a ?? scaffold", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: ["literal", "expression"],
      onChange,
      value: "static text",
    });
    pointer(container.querySelector(".dynamic-slot-mode")!, "click");
    expect(onChange).toHaveBeenCalledWith({
      $expression: { operator: "??", target: null, value: null },
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
      caps: ["literal", "template"],
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
      caps: ["literal", "ref", "expression"],
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
    const items = [...container.querySelectorAll("sp-menu-item")].map((i) =>
      i.getAttribute("value"),
    );
    expect(items).toContain("$map/item");
  });

  test("leaving ref mode seeds the literal stash with the declared default", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      literalDefault: "declared default",
      onChange,
      stateDefs: ["count"],
      value: { $ref: "#/state/count" },
    });
    // Ref → literal: no literal stash exists yet, so the declared default is seeded and restored.
    pointer(container.querySelector(".dynamic-slot-mode")!, "click");
    expect(onChange).toHaveBeenCalledWith("declared default");
  });

  test("wrapping to literal without memory or a declared default clears the position", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: ["literal", "template"],
      onChange,
      stateDefs: ["count"],
      value: "${state.count}",
    });
    // Template → literal with no stash and no literalDefault: onChange(undefined) clears.
    pointer(container.querySelector(".dynamic-slot-mode")!, "click");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]).toEqual([undefined] as never);
  });
});
