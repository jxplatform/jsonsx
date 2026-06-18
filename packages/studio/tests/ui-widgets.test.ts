import {
  installMockPlatform,
  pointer,
  renderInto,
  resetStudioState,
  resetWorkspaceWithTab,
  setValue,
} from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { html } from "lit-html";
import * as storeActual from "../src/store";

// Make debounced style commits synchronous so @input handlers fire without real 400ms timers.
void mock.module("../src/store", () => ({
  ...storeActual,
  debouncedStyleCommit:
    <A extends unknown[]>(_prop: string, _ms: number, fn: (...args: A) => void) =>
    (...args: A) =>
      fn(...args),
}));

const { renderNumberInput, renderTextInput, widgetForType } = await import("../src/ui/widgets");
const { renderButtonGroup } = await import("../src/ui/button-group");
const { renderFieldRow } = await import("../src/ui/field-row");
const { icons } = await import("../src/ui/icons");

beforeEach(() => {
  resetStudioState();
  resetWorkspaceWithTab();
  installMockPlatform();
});

// ─── renderTextInput ─────────────────────────────────────────────────────────

describe("renderTextInput", () => {
  test("renders a textfield with placeholder and stringified value", async () => {
    const container = await renderInto(renderTextInput("width", 12, () => {}, "auto"));
    const field = container.querySelector("sp-textfield") as HTMLInputElement;
    expect(field.getAttribute("placeholder")).toBe("auto");
    expect(field.value).toBe("12");
  });

  test("nullish value renders empty; input commits the raw value", async () => {
    const seen: string[] = [];
    const container = await renderInto(renderTextInput("width", undefined, (v) => seen.push(v)));
    const field = container.querySelector("sp-textfield") as HTMLInputElement;
    expect(field.value).toBe("");
    setValue(field, "50%");
    expect(seen).toEqual(["50%"]);
  });
});

// ─── renderNumberInput ───────────────────────────────────────────────────────

describe("renderNumberInput", () => {
  test("applies min/max and a 0.1 step for unit-interval ranges", async () => {
    const container = await renderInto(
      renderNumberInput({ maximum: 1, minimum: 0 }, "opacity", 0.5, () => {}, "1"),
    );
    const field = container.querySelector("sp-number-field") as HTMLInputElement;
    expect(field.getAttribute("min")).toBe("0");
    expect(field.getAttribute("max")).toBe("1");
    expect(field.getAttribute("step")).toBe("0.1");
    expect(field.getAttribute("placeholder")).toBe("1");
    expect((field as unknown as { value: number }).value).toBe(0.5);
  });

  test("omits min/max/step when the entry has no bounds", async () => {
    const container = await renderInto(renderNumberInput({}, "zIndex", "", () => {}));
    const field = container.querySelector("sp-number-field") as HTMLElement;
    expect(field.hasAttribute("min")).toBe(false);
    expect(field.hasAttribute("max")).toBe(false);
    expect(field.hasAttribute("step")).toBe(false);
  });

  test("large maximum gets no fractional step", async () => {
    const container = await renderInto(renderNumberInput({ maximum: 100 }, "n", 3, () => {}));
    const field = container.querySelector("sp-number-field") as HTMLElement;
    expect(field.getAttribute("max")).toBe("100");
    expect(field.hasAttribute("step")).toBe(false);
  });

  test("change commits numbers; undefined and NaN clear the value", async () => {
    const seen: (string | number)[] = [];
    const container = await renderInto(renderNumberInput({}, "zIndex", 1, (v) => seen.push(v)));
    const field = container.querySelector("sp-number-field") as HTMLElement & {
      value: number | undefined;
    };

    field.value = 7;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.value = undefined;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.value = Number.NaN;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen).toEqual([7, "", ""]);
  });
});

// ─── widgetForType dispatcher ────────────────────────────────────────────────

describe("widgetForType", () => {
  test("button-group type renders the action-group combo", async () => {
    const container = await renderInto(
      widgetForType("button-group", { enum: ["row"] }, "flexDirection", "row", () => {}),
    );
    expect(container.querySelector(".button-group-combo")).not.toBeNull();
  });

  test("color type renders the color selector", async () => {
    const container = await renderInto(widgetForType("color", {}, "color", "red", () => {}));
    expect(container.querySelector(".style-input-color")).not.toBeNull();
  });

  test("number-unit type renders the unit selector", async () => {
    const container = await renderInto(
      widgetForType("number-unit", { $units: ["px", "%"] }, "width", "12px", () => {}),
    );
    expect(container.querySelector(".style-input-number-unit")).not.toBeNull();
    expect(container.querySelector("sp-picker-button")).not.toBeNull();
  });

  test("number type renders a number field", async () => {
    const container = await renderInto(widgetForType("number", {}, "zIndex", 2, () => {}));
    expect(container.querySelector("sp-number-field")).not.toBeNull();
  });

  test("media type renders the media picker", async () => {
    const container = await renderInto(widgetForType("media", {}, "src", "/a.png", () => {}));
    expect(container.querySelector(".media-picker")).not.toBeNull();
  });

  test("select and combobox use caller overrides when provided", async () => {
    const calls: string[] = [];
    const opts = {
      renderCombobox: (_e: Record<string, unknown>, prop: string) => {
        calls.push(`combobox:${prop}`);
        return html`<i class="custom-combobox"></i>`;
      },
      renderSelect: (_e: Record<string, unknown>, prop: string) => {
        calls.push(`select:${prop}`);
        return html`<i class="custom-select"></i>`;
      },
    };
    const sel = await renderInto(widgetForType("select", {}, "display", "", () => {}, opts));
    const combo = await renderInto(widgetForType("combobox", {}, "fontFamily", "", () => {}, opts));
    expect(sel.querySelector(".custom-select")).not.toBeNull();
    expect(combo.querySelector(".custom-combobox")).not.toBeNull();
    expect(calls).toEqual(["select:display", "combobox:fontFamily"]);
  });

  test("select and combobox fall back to text inputs without overrides", async () => {
    const sel = await renderInto(
      widgetForType("select", {}, "display", "block", () => {}, { placeholder: "inline" }),
    );
    const combo = await renderInto(widgetForType("combobox", {}, "fontFamily", "serif", () => {}));
    expect((sel.querySelector("sp-textfield") as HTMLInputElement).value).toBe("block");
    expect(sel.querySelector("sp-textfield")?.getAttribute("placeholder")).toBe("inline");
    expect((combo.querySelector("sp-textfield") as HTMLInputElement).value).toBe("serif");
  });

  test("unknown type falls back to a text input", async () => {
    const seen: (string | number)[] = [];
    const container = await renderInto(
      widgetForType("mystery", {}, "foo", "bar", (v) => seen.push(v)),
    );
    const field = container.querySelector("sp-textfield") as HTMLInputElement;
    setValue(field, "baz");
    expect(seen).toEqual(["baz"]);
  });
});

// ─── renderButtonGroup ───────────────────────────────────────────────────────

describe("renderButtonGroup", () => {
  test("renders a button per enum value with abbreviations and selection", async () => {
    const container = await renderInto(
      renderButtonGroup({ enum: ["row", "column"] }, "flexDirection", "column", () => {}),
    );
    const buttons = [...container.querySelectorAll("sp-action-button")];
    expect(buttons.map((b) => b.getAttribute("value"))).toEqual(["row", "column"]);
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["row", "col"]);
    expect(buttons[0]?.hasAttribute("selected")).toBe(false);
    expect(buttons[1]?.hasAttribute("selected")).toBe(true);
    expect(container.querySelector("sp-picker-button")).toBeNull();
  });

  test("clicking toggles: new value commits, re-clicking the current value clears", async () => {
    const seen: string[] = [];
    const container = await renderInto(
      renderButtonGroup({ enum: ["row", "column"] }, "flexDirection", "column", (v) =>
        seen.push(v),
      ),
    );
    const [rowBtn, colBtn] = [...container.querySelectorAll("sp-action-button")];
    pointer(rowBtn!, "click");
    pointer(colBtn!, "click");
    expect(seen).toEqual(["row", ""]);
  });

  test("maps $icons entries to icon templates and falls back to text for unknown icons", async () => {
    const container = await renderInto(
      renderButtonGroup(
        { $buttonValues: ["row", "column"], $icons: { column: "nope", row: "arrow-right" } },
        "flexDirection",
        "",
        () => {},
      ),
    );
    const [rowBtn, colBtn] = [...container.querySelectorAll("sp-action-button")];
    expect(rowBtn?.querySelector("sp-icon-arrow-right")).not.toBeNull();
    expect(colBtn?.querySelector("sp-icon-arrow-right")).toBeNull();
    expect(colBtn?.textContent?.trim()).toBe("col");
  });

  test("overflow picker lists only non-button enum values with labels", async () => {
    const container = await renderInto(
      renderButtonGroup(
        { $buttonValues: ["row", "column"], enum: ["row", "column", "dense", "row-reverse"] },
        "gridAutoFlow",
        "dense",
        () => {},
      ),
    );
    expect(container.querySelector(".has-overflow")).not.toBeNull();
    const pickerBtn = container.querySelector("sp-picker-button");
    expect(pickerBtn?.id).toBe("style-btngrp-gridAutoFlow");
    expect(pickerBtn?.classList.contains("has-selection")).toBe(true);

    const items = [...container.querySelectorAll("sp-menu-item")];
    expect(items.map((item) => item.getAttribute("value"))).toEqual([
      "__none__",
      "dense",
      "row-reverse",
    ]);
    expect(items.map((item) => item.textContent?.trim())).toEqual(["—", "Dense", "Row Reverse"]);
    expect(items[1]?.hasAttribute("selected")).toBe(true);
  });

  test("overflow menu change commits truthy values and ignores empty ones", async () => {
    const seen: string[] = [];
    const container = await renderInto(
      renderButtonGroup(
        { $buttonValues: ["row"], enum: ["row", "dense"] },
        "gridAutoFlow",
        "row",
        (v) => seen.push(v),
      ),
    );
    const menu = container.querySelector("sp-menu") as HTMLElement & { value: string };
    menu.value = "dense";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    menu.value = "";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen).toEqual(["dense"]);
  });

  test("no overflow when enum is not longer than $buttonValues or missing", async () => {
    const same = await renderInto(
      renderButtonGroup({ $buttonValues: ["a", "b"], enum: ["a", "b"] }, "p", "a", () => {}),
    );
    expect(same.querySelector("sp-picker-button")).toBeNull();
    const noEnum = await renderInto(
      renderButtonGroup({ $buttonValues: ["a"] }, "p", "a", () => {}),
    );
    expect(noEnum.querySelector("sp-picker-button")).toBeNull();
    const empty = await renderInto(renderButtonGroup({}, "p", undefined, () => {}));
    expect(empty.querySelectorAll("sp-action-button")).toHaveLength(0);
  });
});

// ─── renderFieldRow ──────────────────────────────────────────────────────────

describe("renderFieldRow", () => {
  test("renders label, widget slot, and data-prop", async () => {
    const container = await renderInto(
      renderFieldRow({
        hasValue: false,
        label: "Width",
        prop: "width",
        widget: html`<b class="the-widget"></b>`,
      }),
    );
    const row = container.querySelector(".style-row") as HTMLElement;
    expect(row.dataset.prop).toBe("width");
    expect(row.classList.contains("style-row--warning")).toBe(false);
    expect(row.querySelector("sp-field-label")?.textContent).toBe("Width");
    expect(row.querySelector("sp-field-label")?.getAttribute("title")).toBe("width");
    expect(row.querySelector(".the-widget")).not.toBeNull();
    expect(row.querySelector(".set-dot")).toBeNull();
  });

  test("set-dot appears only when hasValue and onClear are both present", async () => {
    const noClear = await renderInto(
      renderFieldRow({ hasValue: true, label: "W", prop: "w", widget: html`` }),
    );
    expect(noClear.querySelector(".set-dot")).toBeNull();

    let cleared = 0;
    const withClear = await renderInto(
      renderFieldRow({
        hasValue: true,
        label: "W",
        onClear: () => {
          cleared += 1;
        },
        prop: "w",
        widget: html``,
      }),
    );
    const dot = withClear.querySelector(".set-dot") as HTMLElement;
    expect(dot.getAttribute("title")).toBe("Clear w");

    let leaked = false;
    withClear.addEventListener("click", () => {
      leaked = true;
    });
    pointer(dot, "click");
    expect(cleared).toBe(1);
    expect(leaked).toBe(false); // StopPropagation
  });

  test("span 2 stretches across the grid and warning toggles the modifier class", async () => {
    const container = await renderInto(
      renderFieldRow({
        hasValue: false,
        label: "L",
        prop: "p",
        span: 2,
        warning: true,
        widget: html``,
      }),
    );
    const row = container.querySelector(".style-row") as HTMLElement;
    expect(row.getAttribute("style")).toContain("grid-column: 1 / -1");
    expect(row.classList.contains("style-row--warning")).toBe(true);
  });
});

// ─── icons map ───────────────────────────────────────────────────────────────

describe("icons", () => {
  test("every icon renders an sp-icon-* element slotted as icon", async () => {
    for (const [name, tpl] of Object.entries(icons)) {
      const container = await renderInto(html`${tpl}`);
      const el = container.querySelector('[slot="icon"]');
      expect(el, name).not.toBeNull();
      expect(el!.tagName.toLowerCase().startsWith("sp-icon-"), name).toBe(true);
    }
  });

  test("semantic spot checks for key mappings", async () => {
    const checks: [keyof typeof icons, string][] = [
      ["arrow-down", "sp-icon-arrow-down"],
      ["wrap-text", "sp-icon-flip-vertical"],
      ["align-stretch-v", "sp-icon-distribute-vertically"],
      ["justify-between", "sp-icon-distribute-space-horiz"],
      ["display-none", "sp-icon-visibility-off"],
    ];
    for (const [name, tag] of checks) {
      const container = await renderInto(html`${icons[name]}`);
      expect(container.querySelector(tag), name).not.toBeNull();
    }
  });
});
