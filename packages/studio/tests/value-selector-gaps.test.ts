import "./harness";
import { afterEach, describe, expect, test } from "bun:test";
import { JxValueSelector } from "../src/ui/value-selector";

// Register the element once (spectrum.ts normally does this; tests register directly to avoid
// Importing the whole spectrum bundle).
if (!customElements.get("jx-value-selector")) {
  customElements.define("jx-value-selector", JxValueSelector);
}

const OPTIONS = [
  { label: "Italic", style: "font-style: italic", value: "italic" },
  { label: "Normal", value: "normal" },
  { divider: true as const },
  { label: "Oblique", style: "font-style: oblique", value: "oblique" },
];

const mounted: JxValueSelector[] = [];

async function mountSelector(props: Partial<JxValueSelector> = {}): Promise<JxValueSelector> {
  const el = document.createElement("jx-value-selector") as JxValueSelector;
  el.options = OPTIONS as JxValueSelector["options"];
  Object.assign(el, props);
  document.body.append(el);
  mounted.push(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()!.remove();
  }
});

// ─── Construction & render root ──────────────────────────────────────────────

describe("jx-value-selector construction", () => {
  test("defaults: empty value/placeholder, size s, unique menu id", async () => {
    const a = await mountSelector();
    const b = await mountSelector();
    expect(a.value).toBe("");
    expect(a.placeholder).toBe("");
    expect(a.size).toBe("s");
    expect(a._menuId.startsWith("jx-combo-")).toBe(true);
    expect(a._menuId).not.toBe(b._menuId);
  });

  test("renders into light DOM (no shadow root)", async () => {
    const el = await mountSelector();
    expect(el.shadowRoot).toBeNull();
    expect(el.querySelector(".jx-combobox-group")).toBeTruthy();
  });
});

// ─── Mode selection ──────────────────────────────────────────────────────────

describe("jx-value-selector render modes", () => {
  test("empty value renders the combobox group with textfield, button and overlay", async () => {
    const el = await mountSelector({ placeholder: "normal" });
    const group = el.querySelector(".jx-combobox-group")!;
    expect(group.getAttribute("id")).toBe(el._menuId);
    const tf = el.querySelector("sp-textfield")!;
    expect(tf.getAttribute("placeholder")).toBe("normal");
    expect(el.querySelector("sp-picker-button")).toBeTruthy();
    expect(el.querySelector("sp-overlay")!.getAttribute("trigger")).toBe(`${el._menuId}@click`);
    expect(el.querySelector("sp-picker")).toBeNull();
  });

  test("matching value renders picker mode with the selected option's style", async () => {
    const el = await mountSelector({ value: "italic" });
    const picker = el.querySelector("sp-picker.jx-combobox-picker")!;
    expect(picker).toBeTruthy();
    expect(picker.getAttribute("style")).toBe("font-style: italic");
    expect(el.querySelector(".jx-combobox-group")).toBeNull();
  });

  test("matching option without a style renders an empty style", async () => {
    const el = await mountSelector({ value: "normal" });
    expect(el.querySelector("sp-picker")!.getAttribute("style") ?? "").toBe("");
  });

  test("non-matching value renders combobox mode with the value in the textfield", async () => {
    const el = await mountSelector({ value: "900" });
    expect(el.querySelector("sp-picker")).toBeNull();
    const tf = el.querySelector("sp-textfield")!;
    expect((tf as unknown as { value: string }).value).toBe("900");
  });

  test("menu items include dividers and per-option styles in both modes", async () => {
    const el = await mountSelector({ value: "italic" });
    const items = [...el.querySelectorAll("sp-menu-item")];
    expect(items.map((i) => i.getAttribute("value"))).toEqual(["italic", "normal", "oblique"]);
    expect(items[0]!.getAttribute("style")).toBe("font-style: italic");
    expect(items[1]!.getAttribute("style") ?? "").toBe("");
    expect(el.querySelectorAll("sp-menu-divider").length).toBe(1);
  });

  test("changing value across the option boundary swaps modes", async () => {
    const el = await mountSelector({ value: "italic" });
    expect(el.querySelector("sp-picker")).toBeTruthy();
    el.value = "letter-spacing: 2px";
    await el.updateComplete;
    expect(el.querySelector("sp-picker")).toBeNull();
    expect(el.querySelector(".jx-combobox-group")).toBeTruthy();
    el.value = "oblique";
    await el.updateComplete;
    expect(el.querySelector("sp-picker")).toBeTruthy();
  });
});

// ─── Event handlers ──────────────────────────────────────────────────────────

describe("jx-value-selector events", () => {
  test("picker change updates value and re-dispatches a composed change event", async () => {
    const el = await mountSelector({ value: "italic" });
    const events: Event[] = [];
    el.addEventListener("change", (e) => events.push(e));
    const picker = el.querySelector("sp-picker")!;
    (picker as unknown as { value: string }).value = "oblique";
    picker.dispatchEvent(new Event("change", { bubbles: false }));
    expect(el.value).toBe("oblique");
    expect(events.length).toBe(1);
    expect(events[0]!.bubbles).toBe(true);
    expect(events[0]!.composed).toBe(true);
  });

  test("menu change with an empty value is ignored", async () => {
    const el = await mountSelector({ value: "" });
    const events: Event[] = [];
    el.addEventListener("change", (e) => events.push(e));
    const menu = el.querySelector("sp-menu")!;
    (menu as unknown as { value: string }).value = "";
    menu.dispatchEvent(new Event("change", { bubbles: false }));
    expect(el.value).toBe("");
    expect(events.length).toBe(0);
  });

  test("menu change with a value updates and flips to picker mode", async () => {
    const el = await mountSelector({ value: "" });
    const events: Event[] = [];
    el.addEventListener("change", (e) => events.push(e));
    const menu = el.querySelector("sp-menu")!;
    (menu as unknown as { value: string }).value = "normal";
    menu.dispatchEvent(new Event("change", { bubbles: false }));
    expect(el.value).toBe("normal");
    expect(events.length).toBe(1);
    await el.updateComplete;
    expect(el.querySelector("sp-picker.jx-combobox-picker")).toBeTruthy();
  });

  test("textfield input updates value and dispatches an input event", async () => {
    const el = await mountSelector({ value: "" });
    const events: Event[] = [];
    el.addEventListener("input", (e) => events.push(e));
    const tf = el.querySelector("sp-textfield")!;
    (tf as unknown as { value: string }).value = "small-caps";
    tf.dispatchEvent(new Event("input", { bubbles: false }));
    expect(el.value).toBe("small-caps");
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("input");
  });
});

// ─── Popover width sync ──────────────────────────────────────────────────────

describe("jx-value-selector popover width", () => {
  test("sp-opened sizes the popover to the trigger group width", async () => {
    const el = await mountSelector({ value: "" });
    const group = el.querySelector(".jx-combobox-group") as HTMLElement;
    Object.defineProperty(group, "offsetWidth", { value: 240 });
    const overlay = el.querySelector("sp-overlay")!;
    overlay.dispatchEvent(new Event("sp-opened", { bubbles: false }));
    const popover = el.querySelector("sp-popover") as HTMLElement;
    expect(popover.style.minWidth).toBe("240px");
  });

  test("zero-width trigger leaves the popover width untouched", async () => {
    const el = await mountSelector({ value: "" });
    const overlay = el.querySelector("sp-overlay")!;
    overlay.dispatchEvent(new Event("sp-opened", { bubbles: false }));
    const popover = el.querySelector("sp-popover") as HTMLElement;
    expect(popover.style.minWidth).toBe("");
  });
});
