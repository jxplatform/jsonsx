import { renderInto, resetStudioState, resetWorkspaceWithTab, setValue } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as storeActual from "../src/store";
import type { JxMutableNode } from "@jxsuite/schema/types";

// Make debounced style commits synchronous so @input handlers fire without real 400ms timers.
mock.module("../src/store", () => ({
  ...storeActual,
  debouncedStyleCommit:
    <A extends unknown[]>(_prop: string, _ms: number, fn: (...args: A) => void) =>
    (...args: A) =>
      fn(...args),
}));

const { JxColorPopover, isColorPopoverOpen, renderColorSelector } =
  await import("../src/ui/color-selector");

type ColorPopoverEl = InstanceType<typeof JxColorPopover>;

// Register the element once (spectrum.ts normally does this; tests register directly to avoid
// Importing the whole spectrum bundle).
if (!customElements.get("jx-color-popover")) {
  customElements.define("jx-color-popover", JxColorPopover);
}

const COLOR_DOC = {
  children: [{ tagName: "p" }],
  style: {
    "--color-accent": "#ff0000",
    "--color-bad": { nested: true },
    "--color-num": 42,
    "--color-primary-blue": "#0000ff",
    "--font-body": "Inter, sans-serif",
  },
  tagName: "div",
} as unknown as JxMutableNode;

const mounted: HTMLElement[] = [];

async function mountPopover(props: Partial<ColorPopoverEl> = {}): Promise<ColorPopoverEl> {
  const el = document.createElement("jx-color-popover") as ColorPopoverEl;
  Object.assign(el, props);
  document.body.append(el);
  mounted.push(el);
  await el.updateComplete;
  return el;
}

beforeEach(() => {
  resetStudioState();
  resetWorkspaceWithTab(COLOR_DOC);
});

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()!.remove();
  }
});

// ─── renderColorSelector — text mode ─────────────────────────────────────────

describe("renderColorSelector text mode", () => {
  test("renders swatch + textfield for a custom color value", async () => {
    const container = await renderInto(renderColorSelector("color", "red", () => {}));
    const root = container.querySelector(".style-input-color");
    expect(root?.id).toBe("color-trigger-color");
    expect(container.querySelector("sp-swatch")?.getAttribute("color")).toBe("red");
    expect(container.querySelector("sp-picker")).toBeNull();
    expect((container.querySelector("sp-textfield") as HTMLInputElement).value).toBe("red");
  });

  test("undefined value renders a transparent swatch", async () => {
    const container = await renderInto(renderColorSelector("color", undefined, () => {}));
    expect(container.querySelector("sp-swatch")?.getAttribute("color")).toBe("transparent");
  });

  test("var() reference to an undefined variable stays in text mode and shows transparent", async () => {
    const container = await renderInto(
      renderColorSelector("color", "var(--color-missing)", () => {}),
    );
    expect(container.querySelector("sp-picker")).toBeNull();
    expect(container.querySelector("sp-swatch")?.getAttribute("color")).toBe("transparent");
  });

  test("var() reference resolves through the effective style for the swatch", async () => {
    resetWorkspaceWithTab({
      style: { "--color-accent": "#ff0000", "--shade": "#222222" },
      tagName: "div",
    } as unknown as JxMutableNode);
    // --shade is defined but not a --color* var, so text mode resolves it for display.
    const container = await renderInto(renderColorSelector("color", "var(--shade)", () => {}));
    expect(container.querySelector("sp-picker")).toBeNull();
    expect(container.querySelector("sp-swatch")?.getAttribute("color")).toBe("#222222");
  });

  test("textfield input commits the trimmed value", async () => {
    const seen: string[] = [];
    const container = await renderInto(renderColorSelector("color", "", (v) => seen.push(v)));
    setValue(container.querySelector("sp-textfield") as HTMLInputElement, "  #00ff00  ");
    expect(seen).toEqual(["#00ff00"]);
  });

  test("color-change from the embedded popover commits the detail", async () => {
    const seen: string[] = [];
    const container = await renderInto(renderColorSelector("color", "", (v) => seen.push(v)));
    const popover = container.querySelector("jx-color-popover") as ColorPopoverEl;
    expect(popover.colorVars.map((cv) => cv.name)).toEqual([
      "--color-accent",
      "--color-num",
      "--color-primary-blue",
    ]);
    popover.dispatchEvent(new CustomEvent("color-change", { bubbles: true, detail: "#123456" }));
    expect(seen).toEqual(["#123456"]);
  });
});

// ─── renderColorSelector — picker mode ───────────────────────────────────────

describe("renderColorSelector picker mode", () => {
  test("matching var() switches to picker mode with title-cased labels", async () => {
    const container = await renderInto(
      renderColorSelector("color", "var(--color-primary-blue)", () => {}),
    );
    const picker = container.querySelector("sp-picker") as HTMLElement & { value: string };
    expect(picker).not.toBeNull();
    expect(picker.id).toBe("color-picker-color");
    expect(picker.value).toBe("var(--color-primary-blue)");
    expect(container.querySelector("sp-swatch")?.getAttribute("color")).toBe("#0000ff");
    expect(container.querySelector("sp-textfield")).toBeNull();

    const items = [...container.querySelectorAll("sp-picker sp-menu-item")];
    expect(items.map((item) => item.getAttribute("value"))).toEqual([
      "var(--color-accent)",
      "var(--color-num)",
      "var(--color-primary-blue)",
    ]);
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Accent",
      "Num",
      "Primary Blue",
    ]);
  });

  test("numeric custom-property values are stringified; non-scalars excluded", async () => {
    const container = await renderInto(renderColorSelector("color", "var(--color-num)", () => {}));
    expect(container.querySelector("sp-swatch")?.getAttribute("color")).toBe("42");
    const values = [...container.querySelectorAll("sp-picker sp-menu-item")].map((item) =>
      item.getAttribute("value"),
    );
    expect(values).not.toContain("var(--color-bad)");
  });

  test("changing the picker commits the new var() reference", async () => {
    const seen: string[] = [];
    const container = await renderInto(
      renderColorSelector("color", "var(--color-primary-blue)", (v) => seen.push(v)),
    );
    const picker = container.querySelector("sp-picker") as HTMLElement & { value: string };
    picker.value = "var(--color-accent)";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen).toEqual(["var(--color-accent)"]);
  });

  test("color-change from the picker-mode popover commits the detail", async () => {
    const seen: string[] = [];
    const container = await renderInto(
      renderColorSelector("color", "var(--color-accent)", (v) => seen.push(v)),
    );
    const popover = container.querySelector("jx-color-popover") as ColorPopoverEl;
    popover.dispatchEvent(new CustomEvent("color-change", { bubbles: true, detail: "blue" }));
    expect(seen).toEqual(["blue"]);
  });

  test("no document style means no color vars and text mode", async () => {
    resetWorkspaceWithTab({ tagName: "div" } as unknown as JxMutableNode);
    const container = await renderInto(
      renderColorSelector("color", "var(--color-accent)", () => {}),
    );
    expect(container.querySelector("sp-picker")).toBeNull();
    expect(container.querySelector("jx-color-popover")).not.toBeNull();
  });
});

// ─── JxColorPopover element ──────────────────────────────────────────────────

describe("JxColorPopover", () => {
  test("renders area, slider, textfield into light DOM (no shadow root)", async () => {
    const el = await mountPopover({ color: "#336699" });
    expect(el.shadowRoot).toBeNull();
    expect(el.querySelector("sp-color-area")).not.toBeNull();
    expect(el.querySelector("sp-color-slider")).not.toBeNull();
    expect((el.querySelector("sp-textfield") as HTMLInputElement).value).toBe("#336699");
    expect(el.querySelector("sp-swatch-group")).toBeNull();
  });

  test("displayColor derives from color across formats", async () => {
    const el = await mountPopover({ color: "" });
    expect(el.displayColor).toBe("#000000");

    el.color = "#ff0000";
    await el.updateComplete;
    expect(el.displayColor).toBe("#ff0000");

    el.color = "rgb(1, 2, 3)";
    await el.updateComplete;
    expect(el.displayColor).toBe("rgb(1, 2, 3)");

    el.color = "hsl(120, 50%, 50%)";
    await el.updateComplete;
    expect(el.displayColor).toBe("hsl(120, 50%, 50%)");

    el.color = "abc123";
    await el.updateComplete;
    expect(el.displayColor).toBe("#abc123");
  });

  test("var() color resolves via the active document; unresolved falls back to black", async () => {
    const el = await mountPopover({ color: "var(--color-accent)" });
    expect(el.displayColor).toBe("#ff0000");

    el.color = "var(--color-nope)";
    await el.updateComplete;
    expect(el.displayColor).toBe("#000000");
  });

  test("area and slider input normalize hex and emit color-change", async () => {
    const el = await mountPopover({ color: "" });
    const seen: string[] = [];
    el.addEventListener("color-change", (e) => seen.push((e as CustomEvent).detail));

    el._handleArea({ target: { color: "ff0000" } } as unknown as Event);
    expect(el.color).toBe("#ff0000");
    expect(el.displayColor).toBe("#ff0000");

    el._handleSlider({ target: { color: "rgb(9, 9, 9)" } } as unknown as Event);
    expect(el.color).toBe("rgb(9, 9, 9)");

    expect(seen).toEqual(["#ff0000", "rgb(9, 9, 9)"]);
  });

  test("text change emits the raw value; empty input is ignored", async () => {
    const el = await mountPopover({ color: "#ffffff" });
    const seen: string[] = [];
    el.addEventListener("color-change", (e) => seen.push((e as CustomEvent).detail));
    const field = el.querySelector("sp-textfield") as HTMLInputElement;

    field.value = "   ";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen).toEqual([]);

    field.value = "tomato";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen).toEqual(["tomato"]);
    expect(el.color).toBe("tomato");
  });

  test("clicking a token swatch emits a var() reference", async () => {
    const el = await mountPopover({
      color: "",
      colorVars: [{ name: "--color-accent", value: "#ff0000" }],
    });
    const seen: string[] = [];
    el.addEventListener("color-change", (e) => seen.push((e as CustomEvent).detail));
    const swatch = el.querySelector("sp-swatch-group sp-swatch") as HTMLElement;
    expect(swatch.getAttribute("color")).toBe("#ff0000");
    swatch.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seen).toEqual(["var(--color-accent)"]);
    expect(el.color).toBe("var(--color-accent)");
  });
});

// ─── isColorPopoverOpen ──────────────────────────────────────────────────────

describe("isColorPopoverOpen", () => {
  test("reflects presence of an open overlay inside a color input", () => {
    expect(isColorPopoverOpen()).toBe(false);
    const wrap = document.createElement("div");
    wrap.className = "style-input-color";
    const overlay = document.createElement("sp-overlay");
    wrap.append(overlay);
    document.body.append(wrap);
    expect(isColorPopoverOpen()).toBe(false);
    overlay.setAttribute("open", "");
    expect(isColorPopoverOpen()).toBe(true);
    wrap.remove();
    expect(isColorPopoverOpen()).toBe(false);
  });
});
