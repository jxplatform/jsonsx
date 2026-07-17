import { pointer, renderInto } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { html } from "lit-html";
import { renderDynamicSlot, resetSlotModeMemory, slotMode } from "../src/ui/dynamic-slot";
import type { DynamicSlotOpts } from "../src/ui/dynamic-slot";

describe("slotMode", () => {
  test("detects each rung of the ladder", () => {
    expect(slotMode("plain")).toBe("literal");
    expect(slotMode(42)).toBe("literal");
    expect(slotMode(null)).toBe("literal");
    expect(slotMode({ $ref: "#/state/x" })).toBe("ref");
    expect(slotMode("${state.x} items")).toBe("template");
    expect(slotMode({ $expression: { operator: "!", target: null } })).toBe("expression");
  });
});

describe("renderDynamicSlot", () => {
  const staticWidget = html`<input class="static-widget" />`;

  beforeEach(() => {
    resetSlotModeMemory();
  });

  async function renderSlot(opts: Partial<DynamicSlotOpts> & { value: unknown }) {
    const parts = renderDynamicSlot({
      caps: ["literal", "ref"],
      fieldKey: "test|0|field",
      onChange: () => {},
      staticWidget,
      stateDefs: [],
      ...opts,
    });
    return renderInto(html`${parts.widget}${parts.modeButton}`);
  }

  function modeButton(container: HTMLElement) {
    return container.querySelector(".dynamic-slot-mode")!;
  }

  test("literal mode renders the panel's static widget and the abc glyph", async () => {
    const container = await renderSlot({ stateDefs: ["count"], value: "hello" });
    expect(container.querySelector(".static-widget")).not.toBeNull();
    const btn = modeButton(container);
    expect(btn.textContent!.trim()).toBe("abc");
    expect(btn.getAttribute("title")).toBe("Field mode: static — click for signal binding");
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  test("ref mode renders the signal picker with state options", async () => {
    const container = await renderSlot({
      stateDefs: ["count", "title"],
      value: { $ref: "#/state/count" },
    });
    expect(container.querySelector(".static-widget")).toBeNull();
    const items = [...container.querySelectorAll("sp-menu-item")].map((i) =>
      i.getAttribute("value"),
    );
    expect(items).toContain("#/state/count");
    expect(items).toContain("#/state/title");
    expect(modeButton(container).textContent!.trim()).toBe("$ref");
  });

  test("expression mode renders the expression editor", async () => {
    const container = await renderSlot({
      caps: ["literal", "ref", "expression"],
      stateDefs: ["count"],
      value: { $expression: { operator: "!", target: { $ref: "#/state/count" } } },
    });
    expect(container.querySelector(".expression-editor")).not.toBeNull();
    expect(modeButton(container).textContent!.trim()).toBe("fx");
  });

  test("template mode renders the raw template textfield", async () => {
    const container = await renderSlot({
      caps: ["literal", "ref", "template"],
      stateDefs: ["count"],
      value: "${state.count}",
    });
    expect(container.querySelector("sp-textfield")).not.toBeNull();
    expect(modeButton(container).textContent!.trim()).toBe("${}");
  });

  test("clicking escalates literal → ref seeded with the first signal", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({ onChange, stateDefs: ["count"], value: "hello" });
    pointer(modeButton(container), "click");
    expect(onChange).toHaveBeenCalledWith({ $ref: "#/state/count" });
  });

  test("cycle wraps from the last capped mode back to literal", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: ["literal", "template"],
      literalDefault: "fallback",
      onChange,
      stateDefs: ["count"],
      value: "${state.count}",
    });
    pointer(modeButton(container), "click");
    expect(onChange).toHaveBeenCalledWith("fallback");
  });

  test("ref rung is skipped when no signals exist", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: ["literal", "ref", "template"],
      onChange,
      value: "hello",
    });
    const btn = modeButton(container);
    expect(btn.getAttribute("title")).toBe("Field mode: static — click for template literal");
    pointer(btn, "click");
    expect(onChange).toHaveBeenCalledWith("${}");
  });

  test("ref rung stays available with extraSignals only", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      extraSignals: [{ label: "item", value: "$map/item" }],
      onChange,
      value: "hello",
    });
    pointer(modeButton(container), "click");
    expect(onChange).toHaveBeenCalledWith({ $ref: "$map/item" });
  });

  test("a single effective mode renders a disabled button", async () => {
    const container = await renderSlot({ value: "hello" });
    const btn = modeButton(container);
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("title")).toBe("Field mode: static (no other modes available)");
  });

  test("cycling back to a former mode restores its remembered value", async () => {
    const first = mock(() => {});
    const c1 = await renderSlot({
      caps: ["literal", "template"],
      onChange: first,
      stateDefs: ["count"],
      value: "hello",
    });
    pointer(modeButton(c1), "click");
    expect(first).toHaveBeenCalledWith("${state.count}");

    // Re-render as if the template default was committed, then cycle back around.
    const second = mock(() => {});
    const c2 = await renderSlot({
      caps: ["literal", "template"],
      literalDefault: "fallback",
      onChange: second,
      stateDefs: ["count"],
      value: "${state.count}",
    });
    pointer(modeButton(c2), "click");
    expect(second).toHaveBeenCalledWith("hello");
  });

  test("memory is isolated per fieldKey", async () => {
    const first = mock(() => {});
    const c1 = await renderSlot({
      caps: ["literal", "template"],
      fieldKey: "test|0|a",
      onChange: first,
      value: "hello",
    });
    pointer(modeButton(c1), "click");

    const second = mock(() => {});
    const c2 = await renderSlot({
      caps: ["literal", "template"],
      fieldKey: "test|0|b",
      literalDefault: "fallback",
      onChange: second,
      value: "${state.x}",
    });
    pointer(modeButton(c2), "click");
    expect(second).toHaveBeenCalledWith("fallback");
  });

  test("a cleared literal (undefined) is a restorable stash, beating literalDefault", async () => {
    const first = mock(() => {});
    const c1 = await renderSlot({
      caps: ["literal", "template"],
      onChange: first,
      value: undefined,
    });
    pointer(modeButton(c1), "click");

    const second = mock(() => {});
    const c2 = await renderSlot({
      caps: ["literal", "template"],
      literalDefault: "fallback",
      onChange: second,
      value: "${state.x}",
    });
    pointer(modeButton(c2), "click");
    expect(second).toHaveBeenCalledTimes(1);
    expect((second.mock.calls[0] as unknown[])[0]).toBeUndefined();
  });
});
