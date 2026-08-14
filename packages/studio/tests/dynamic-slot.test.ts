import { pointer, renderInto } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { html } from "lit-html";
import {
  effectiveSlotMode,
  renderDynamicSlot,
  resetSlotModeMemory,
  setSlotMode,
  slotCaps,
  slotMode,
  switchSlotMode,
} from "../src/ui/dynamic-slot";
import type { DynamicSlotOpts } from "../src/ui/dynamic-slot";

describe("slotMode", () => {
  test("detects each rung of the ladder", () => {
    expect(slotMode("plain")).toBe("literal");
    expect(slotMode({ $ref: "#/state/x" })).toBe("ref");
    expect(slotMode("${state.x} items")).toBe("template");
    expect(slotMode({ $expression: { operator: "!", target: null } })).toBe("expression");
  });
});

describe("slotCaps", () => {
  test("a named position is derived from the document schema", () => {
    expect(slotCaps("styleProperty")).toEqual(["literal", "template"]);
    expect(slotCaps("attribute")).toEqual(["literal", "ref", "template"]);
  });

  test("a schema handed in directly is derived the same way", () => {
    expect(slotCaps({ schema: { type: "string" } })).toEqual(["literal", "template"]);
    expect(slotCaps({ schema: { $ref: "#/$defs/RefObject" } })).toEqual(["ref"]);
  });
});

describe("renderDynamicSlot", () => {
  const staticWidget = html`<input class="static-widget" />`;
  /* A position the document schema has no name for: a number that also accepts a binding or a
     formula. Handed in as a schema, because a caller may not state a rung list of its own. */
  const FIXED_REF_FORMULA = {
    schema: {
      oneOf: [
        { type: "number" },
        { $ref: "#/$defs/RefObject" },
        { $ref: "#/$defs/ExpressionEntry" },
      ],
    },
  };

  beforeEach(() => {
    resetSlotModeMemory();
  });

  async function renderSlot(opts: Partial<DynamicSlotOpts> & { value: unknown }) {
    const parts = renderDynamicSlot({
      caps: "repeaterItems",
      fieldKey: "test|0|field",
      onChange: () => {},
      staticWidget,
      stateDefs: [],
      ...opts,
    });
    return renderInto(html`${parts.widget}${parts.modeButton}`);
  }

  function chip(container: HTMLElement) {
    return container.querySelector(".dynamic-slot-mode")!;
  }

  function offered(container: HTMLElement): string[] {
    return [...container.querySelectorAll<HTMLElement>("sp-menu-item[data-mode]")].map(
      (i) => i.dataset.mode!,
    );
  }

  function choose(container: HTMLElement, mode: string) {
    pointer(container.querySelector(`sp-menu-item[data-mode="${mode}"]`)!, "click");
  }

  // ─── The chip states the source in plain language ──────────────────────────

  test("a fixed value renders the panel's static widget and says so", async () => {
    const container = await renderSlot({ stateDefs: ["count"], value: "hello" });
    expect(container.querySelector(".static-widget")).not.toBeNull();
    const btn = chip(container);
    expect(btn.textContent!.trim()).toBe("Fixed value");
    expect(btn.getAttribute("title")).toBe("Value source: Fixed value — click to change");
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  test("from-data renders the signal picker with state options", async () => {
    const container = await renderSlot({
      stateDefs: ["count", "title"],
      value: { $ref: "#/state/count" },
    });
    expect(container.querySelector(".static-widget")).toBeNull();
    const items = [...container.querySelectorAll("sp-picker sp-menu-item")].map((i) =>
      i.getAttribute("value"),
    );
    expect(items).toContain("#/state/count");
    expect(items).toContain("#/state/title");
    expect(chip(container).textContent!.trim()).toBe("From data…");
  });

  test("formula renders the expression editor", async () => {
    const container = await renderSlot({
      caps: FIXED_REF_FORMULA,
      stateDefs: ["count"],
      value: { $expression: { operator: "!", target: { $ref: "#/state/count" } } },
    });
    expect(container.querySelector(".expression-editor")).not.toBeNull();
    expect(chip(container).textContent!.trim()).toBe("Formula");
  });

  test("mixed text renders the raw template textfield", async () => {
    const container = await renderSlot({
      caps: "attribute",
      stateDefs: ["count"],
      value: "${state.count}",
    });
    expect(container.querySelector("sp-textfield")).not.toBeNull();
    expect(chip(container).textContent!.trim()).toBe("Mixed text");
  });

  // ─── Any rung is one action away ───────────────────────────────────────────

  test("the picker offers every permitted rung, current one selected", async () => {
    const container = await renderSlot({
      caps: "attribute",
      stateDefs: ["count"],
      value: "${state.count}",
    });
    expect(offered(container)).toEqual(["literal", "ref", "template"]);
    const items = [...container.querySelectorAll<HTMLElement>("sp-menu-item[data-mode]")];
    expect(items.map((i) => i.textContent!.trim().split("\n")[0]!.trim())).toEqual([
      "Fixed value",
      "From data…",
      "Mixed text",
    ]);
    expect(items.find((i) => i.hasAttribute("selected"))!.dataset.mode).toBe("template");
  });

  test("from-data reaches a fixed value directly, without passing through mixed text", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: "attribute",
      literalDefault: "declared default",
      onChange,
      stateDefs: ["count"],
      value: { $ref: "#/state/count" },
    });
    choose(container, "literal");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("declared default");
  });

  test("choosing from-data seeds the first signal", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({ onChange, stateDefs: ["count"], value: "hello" });
    choose(container, "ref");
    expect(onChange).toHaveBeenCalledWith({ $ref: "#/state/count" });
  });

  test("choosing the rung already in force is a no-op", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({ onChange, stateDefs: ["count"], value: "hello" });
    choose(container, "literal");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("the from-data rung is withheld when there is nothing to point at", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      caps: "attribute",
      onChange,
      value: "hello",
    });
    expect(offered(container)).toEqual(["literal", "template"]);
    choose(container, "template");
    expect(onChange).toHaveBeenCalledWith("${}");
  });

  test("the from-data rung stays available with extraSignals only", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      extraSignals: [{ label: "item", value: "$map/item" }],
      onChange,
      value: "hello",
    });
    choose(container, "ref");
    expect(onChange).toHaveBeenCalledWith({ $ref: "$map/item" });
  });

  test("a position with one usable rung renders a disabled chip and no picker", async () => {
    const container = await renderSlot({ value: "hello" });
    const btn = chip(container);
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("title")).toBe(
      "Value source: Fixed value (no other source available here)",
    );
    expect(container.querySelector("sp-overlay")).toBeNull();
  });

  test("a value on a rung the position forbids still gets a way off it", async () => {
    /* `SwitchDef` permits only a $ref, so a plain string left in a $switch sits on a rung that is
       not on offer. Counting rungs alone greyed the chip out — stranding the value exactly where
       it is illegal. */
    const container = await renderSlot({
      caps: "switchDiscriminant",
      stateDefs: ["route"],
      value: "home",
    });
    const btn = chip(container);
    expect(btn.textContent!.trim()).toBe("Fixed value");
    expect(btn.hasAttribute("disabled")).toBe(false);
    expect(offered(container)).toEqual(["ref"]);
  });

  test("a from-data rung may take a pointer outside its list when the caller allows it", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      allowCustomRef: true,
      caps: "attribute",
      onChange,
      stateDefs: ["count"],
      value: { $ref: "#/$params/slug" },
    });
    const combo = container.querySelector("jx-value-selector") as HTMLElement & {
      value: string;
      options: { value: string }[];
    };
    expect(combo).not.toBeNull();
    expect(combo.value).toBe("#/$params/slug");
    expect(combo.options.map((o) => o.value)).toEqual(["#/state/count"]);
    combo.value = "#/$context/anything";
    combo.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith({ $ref: "#/$context/anything" });
  });

  test("clearing the custom pointer clears the position", async () => {
    const onChange = mock(() => {});
    const container = await renderSlot({
      allowCustomRef: true,
      caps: "attribute",
      extraSignals: [{ label: "slug", value: "#/$params/slug" }],
      onChange,
      stateDefs: [],
      value: { $ref: "#/$params/slug" },
    });
    const combo = container.querySelector("jx-value-selector") as HTMLElement & { value: string };
    combo.value = "  ";
    combo.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0] as unknown[])[0]).toBeUndefined();
  });

  test("a style position derives its rungs and never offers from-data", async () => {
    const container = await renderSlot({
      caps: "styleProperty",
      stateDefs: ["count"],
      value: "12px",
    });
    expect(offered(container)).toEqual(["literal", "template"]);
  });

  // ─── Mode switches stash the previous representation ───────────────────────

  test("switching back to a former rung restores what was there", async () => {
    const first = mock(() => {});
    const c1 = await renderSlot({
      caps: "styleProperty",
      onChange: first,
      stateDefs: ["count"],
      value: "hello",
    });
    choose(c1, "template");
    expect(first).toHaveBeenCalledWith("${state.count}");

    const second = mock(() => {});
    const c2 = await renderSlot({
      caps: "styleProperty",
      literalDefault: "fallback",
      onChange: second,
      stateDefs: ["count"],
      value: "${state.count}",
    });
    choose(c2, "literal");
    expect(second).toHaveBeenCalledWith("hello");
  });

  test("memory is isolated per fieldKey", async () => {
    const first = mock(() => {});
    const c1 = await renderSlot({
      caps: "styleProperty",
      fieldKey: "test|0|a",
      onChange: first,
      value: "hello",
    });
    choose(c1, "template");

    const second = mock(() => {});
    const c2 = await renderSlot({
      caps: "styleProperty",
      fieldKey: "test|0|b",
      literalDefault: "fallback",
      onChange: second,
      value: "${state.x}",
    });
    choose(c2, "literal");
    expect(second).toHaveBeenCalledWith("fallback");
  });

  test("a cleared literal (undefined) is a restorable stash, beating literalDefault", async () => {
    const first = mock(() => {});
    const c1 = await renderSlot({
      caps: "styleProperty",
      onChange: first,
      value: undefined,
    });
    choose(c1, "template");

    const second = mock(() => {});
    const c2 = await renderSlot({
      caps: "styleProperty",
      literalDefault: "fallback",
      onChange: second,
      value: "${state.x}",
    });
    choose(c2, "literal");
    expect(second).toHaveBeenCalledTimes(1);
    expect((second.mock.calls[0] as unknown[])[0]).toBeUndefined();
  });
});

// ─── Typing does not swap the widget ─────────────────────────────────────────

describe("effectiveSlotMode", () => {
  beforeEach(() => {
    resetSlotModeMemory();
  });

  test("an untouched field follows the document value", () => {
    expect(effectiveSlotMode("f|1", "plain")).toBe("literal");
    expect(effectiveSlotMode("f|2", "${state.x}")).toBe("template");
    expect(effectiveSlotMode("f|3", { $ref: "#/state/x" })).toBe("ref");
  });

  test("typing ${ into a fixed-value field does not swap it to mixed text", () => {
    expect(effectiveSlotMode("f|typing", "hello")).toBe("literal");
    expect(effectiveSlotMode("f|typing", "hello ${")).toBe("literal");
    expect(effectiveSlotMode("f|typing", "hello ${state.x}")).toBe("literal");
  });

  test("deleting the placeholder does not swap a mixed-text field back either", () => {
    expect(effectiveSlotMode("f|mixed", "${state.x}")).toBe("template");
    expect(effectiveSlotMode("f|mixed", "")).toBe("template");
    expect(effectiveSlotMode("f|mixed", "plain words")).toBe("template");
  });

  test("a structural change — one a keystroke cannot make — still moves the rung", () => {
    expect(effectiveSlotMode("f|struct", "hello")).toBe("literal");
    expect(effectiveSlotMode("f|struct", { $ref: "#/state/x" })).toBe("ref");
    expect(effectiveSlotMode("f|struct", { $expression: { operator: "!", target: null } })).toBe(
      "expression",
    );
    expect(effectiveSlotMode("f|struct", "back to text")).toBe("literal");
  });

  test("an explicit choice wins over the value's own shape", () => {
    expect(effectiveSlotMode("f|chosen", "hello")).toBe("literal");
    setSlotMode("f|chosen", "template");
    expect(effectiveSlotMode("f|chosen", "hello")).toBe("template");
  });
});

// ─── The shared switch, used by the Logic tab too ────────────────────────────

describe("switchSlotMode", () => {
  beforeEach(() => {
    resetSlotModeMemory();
  });

  test("stashes the outgoing representation and returns the seed the first time", () => {
    const seed = { $expression: { operator: "=", target: null } };
    expect(switchSlotMode("ev|onclick", "function", "expression", { body: "x" }, seed)).toBe(seed);
  });

  test("returns the remembered representation on the way back", () => {
    const body = { $prototype: "Function", body: "state.count++", parameters: [] };
    switchSlotMode("ev|onclick", "function", "expression", body, {
      $expression: { operator: "=", target: null },
    });
    const back = switchSlotMode(
      "ev|onclick",
      "expression",
      "function",
      { $expression: { operator: "=", target: null } },
      { $prototype: "Function", body: "", parameters: [] },
    );
    expect(back).toEqual(body);
  });

  test("the stash is a clone, so later edits cannot reach back into it", () => {
    const body = { $prototype: "Function", body: "one", parameters: [] };
    switchSlotMode("ev|onblur", "function", "ref", body, { $ref: "" });
    body.body = "two";
    const back = switchSlotMode("ev|onblur", "ref", "function", { $ref: "" }, null);
    expect((back as { body: string }).body).toBe("one");
  });

  test("it records the rung, so the next render honours the switch", () => {
    switchSlotMode("f|rec", "literal", "template", "hello", "${}");
    expect(effectiveSlotMode("f|rec", "hello")).toBe("template");
  });
});
