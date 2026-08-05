import { renderInto, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as storeActual from "../src/store";
import type { JxMutableNode } from "@jxsuite/schema/types";

// Make debounced style commits synchronous so @input handlers fire without real 400ms timers.
void mock.module("../src/store", () => ({
  ...storeActual,
  debouncedStyleCommit:
    <A extends unknown[]>(_prop: string, _ms: number, fn: (...args: A) => void) =>
    (...args: A) =>
      fn(...args),
}));

const {
  buildFontOptions,
  renderComboboxInput,
  renderKeywordInput,
  renderSelectInput,
  widgetForType,
} = await import("../src/panels/style-inputs");
const { initCssData } = await import("../src/panels/style-utils");

interface SelectorEl extends HTMLElement {
  value: string;
  options: { value?: string; label?: string; style?: string; divider?: boolean }[];
}

function selector(container: HTMLElement): SelectorEl {
  const el = container.querySelector("jx-value-selector");
  expect(el).not.toBeNull();
  return el as SelectorEl;
}

function fire(el: HTMLElement, type: string, value?: string) {
  if (value !== undefined) {
    (el as HTMLInputElement).value = value;
  }
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

beforeEach(() => {
  resetStudioState();
  initCssData({
    cssProps: [
      ["display", "inline"],
      ["fontFamily", "ui-sans-serif"],
      ["opacity", "1"],
    ],
  });
  resetWorkspaceWithTab({
    children: [{ style: { fontFamily: "var(--font-body)" }, tagName: "p" }],
    style: { "--font-body": "Inter, sans-serif" },
    tagName: "div",
  } as unknown as JxMutableNode);
});

// ─── renderKeywordInput ──────────────────────────────────────────────────────

describe("renderKeywordInput", () => {
  test("builds labeled options and placeholder from the CSS initial map", async () => {
    const container = await renderInto(
      renderKeywordInput(["block", "inline-block"], "display", "block", () => {}),
    );
    const el = selector(container);
    expect(el.value).toBe("block");
    expect(el.getAttribute("placeholder")).toBe("inline");
    expect(el.options).toEqual([
      { label: "Block", style: "", value: "block" },
      { label: "Inline Block", style: "", value: "inline-block" },
    ]);
  });

  test("typography preview props embed css and font-family in option styles", async () => {
    const tab = resetWorkspaceWithTab({
      children: [{ style: { fontFamily: "Georgia, serif" }, tagName: "p" }],
      tagName: "div",
    } as unknown as JxMutableNode);
    tab.session.selection = [["children", 0]];
    const container = await renderInto(
      renderKeywordInput(["uppercase"], "textTransform", "", () => {}),
    );
    const el = selector(container);
    expect(el.options[0]!.style).toBe("text-transform: uppercase; font-family: Georgia, serif");
  });

  test("fontWeight previews without a selection omit font-family", async () => {
    const container = await renderInto(renderKeywordInput(["bold"], "fontWeight", "", () => {}));
    const el = selector(container);
    expect(el.options[0]!.style).toBe("font-weight: bold;");
  });

  test("change and input events both invoke onChange with the element value", async () => {
    const seen: string[] = [];
    const container = await renderInto(
      renderKeywordInput(["block"], "display", "", (v) => seen.push(v)),
    );
    const el = selector(container);
    fire(el, "change", "flex");
    fire(el, "input", "grid");
    expect(seen).toEqual(["flex", "grid"]);
  });
});

// ─── renderSelectInput ───────────────────────────────────────────────────────

describe("renderSelectInput", () => {
  test("uses entry.enum as options and stringifies the value", async () => {
    const container = await renderInto(
      renderSelectInput({ enum: ["row", "column"] }, "flexDirection", "row", () => {}),
    );
    const el = selector(container);
    expect(el.options.map((o) => o.value)).toEqual(["row", "column"]);
    expect(el.value).toBe("row");
  });

  test("non-array enum and undefined value yield empty options and value", async () => {
    const container = await renderInto(renderSelectInput({}, "flexDirection", undefined, () => {}));
    const el = selector(container);
    expect(el.options).toEqual([]);
    expect(el.value).toBe("");
  });
});

// ─── buildFontOptions ────────────────────────────────────────────────────────

describe("buildFontOptions", () => {
  const presets = [
    { title: "System Ui", value: "system-ui, sans-serif" },
    { title: "Body", value: "Inter, sans-serif" },
  ];

  test("font vars come first with display names and preview styles", () => {
    const opts = buildFontOptions([{ name: "--font-body", value: "Inter, sans-serif" }], []);
    expect(opts).toEqual([
      { label: "Body", style: "font-family: Inter, sans-serif", value: "--font-body" },
    ]);
  });

  test("divider separates existing vars from unadded presets", () => {
    const opts = buildFontOptions([{ name: "--font-body", value: "Inter, sans-serif" }], presets);
    expect(opts).toEqual([
      { label: "Body", style: "font-family: Inter, sans-serif", value: "--font-body" },
      { divider: true },
      {
        label: "System Ui",
        style: "font-family: system-ui, sans-serif",
        value: "__preset__:System Ui",
      },
    ]);
  });

  test("no divider when there are no font vars", () => {
    const opts = buildFontOptions([], presets);
    expect(opts.some((o) => "divider" in o)).toBe(false);
    expect(opts.map((o) => ("value" in o ? o.value : "|"))).toEqual([
      "__preset__:System Ui",
      "__preset__:Body",
    ]);
  });

  test("no divider when every preset is already a var", () => {
    const opts = buildFontOptions(
      [{ name: "--font-body", value: "Inter, sans-serif" }],
      [{ title: "Body", value: "Inter, sans-serif" }],
    );
    expect(opts).toHaveLength(1);
  });
});

// ─── renderComboboxInput ─────────────────────────────────────────────────────

describe("renderComboboxInput — fontFamily", () => {
  const entry = { presets: [{ title: "System Ui", value: "system-ui, sans-serif" }] };

  function fontTab() {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p" }],
      style: { "--font-body": "Inter, sans-serif" },
      tagName: "div",
    } as unknown as JxMutableNode);
    tab.session.selection = [["children", 0]];
    return tab;
  }

  test("var() value is unwrapped to the bare variable name", async () => {
    fontTab();
    const container = await renderInto(
      renderComboboxInput(entry, "fontFamily", "var(--font-body)", () => {}),
    );
    const el = selector(container);
    expect(el.value).toBe("--font-body");
    expect(el.getAttribute("placeholder")).toBe("ui-sans-serif");
    expect(el.options.map((o) => o.value)).toEqual([
      "--font-body",
      undefined,
      "__preset__:System Ui",
    ]);
  });

  test("selecting a bare --var wraps it in var()", async () => {
    fontTab();
    const seen: string[] = [];
    const container = await renderInto(
      renderComboboxInput(entry, "fontFamily", "", (v) => seen.push(v)),
    );
    fire(selector(container), "change", "--font-heading");
    expect(seen).toEqual(["var(--font-heading)"]);
  });

  test("selecting a preset creates the root font var and commits a var() reference", async () => {
    const tab = fontTab();
    const seen: string[] = [];
    const container = await renderInto(
      renderComboboxInput(entry, "fontFamily", "", (v) => seen.push(v)),
    );
    fire(selector(container), "change", "__preset__:System Ui");
    expect(seen).toEqual(["var(--font-system-ui)"]);
    expect(tab.doc.document.style?.["--font-system-ui"]).toBe("system-ui, sans-serif");
    expect(tab.doc.dirty).toBe(true);
  });

  test("preset selection does not overwrite an existing root var", async () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p" }],
      style: { "--font-system-ui": "custom-stack" },
      tagName: "div",
    } as unknown as JxMutableNode);
    const seen: string[] = [];
    const container = await renderInto(
      renderComboboxInput(entry, "fontFamily", "", (v) => seen.push(v)),
    );
    fire(selector(container), "change", "__preset__:System Ui");
    expect(seen).toEqual(["var(--font-system-ui)"]);
    expect(tab.doc.document.style?.["--font-system-ui"]).toBe("custom-stack");
  });

  test("unknown __preset__ value is ignored", async () => {
    fontTab();
    const seen: string[] = [];
    const container = await renderInto(
      renderComboboxInput(entry, "fontFamily", "", (v) => seen.push(v)),
    );
    fire(selector(container), "change", "__preset__:Nope");
    expect(seen).toEqual([]);
  });

  test("typing a preset title selects the preset", async () => {
    fontTab();
    const seen: string[] = [];
    const container = await renderInto(
      renderComboboxInput(entry, "fontFamily", "", (v) => seen.push(v)),
    );
    fire(selector(container), "change", "System Ui");
    expect(seen).toEqual(["var(--font-system-ui)"]);
  });

  test("typing a font var display name resolves to its var()", async () => {
    fontTab();
    const seen: string[] = [];
    const container = await renderInto(
      renderComboboxInput(entry, "fontFamily", "", (v) => seen.push(v)),
    );
    fire(selector(container), "change", "Body");
    expect(seen).toEqual(["var(--font-body)"]);
  });

  test("arbitrary text falls through unchanged; empty value is ignored", async () => {
    fontTab();
    const seen: string[] = [];
    const container = await renderInto(
      renderComboboxInput(entry, "fontFamily", "", (v) => seen.push(v)),
    );
    const el = selector(container);
    fire(el, "change", "Comic Sans MS");
    fire(el, "change", "");
    expect(seen).toEqual(["Comic Sans MS"]);
  });

  test("input event commits the raw value (debounced path)", async () => {
    fontTab();
    const seen: string[] = [];
    const container = await renderInto(
      renderComboboxInput(entry, "fontFamily", "", (v) => seen.push(v)),
    );
    fire(selector(container), "input", "Geo");
    expect(seen).toEqual(["Geo"]);
  });
});

describe("renderComboboxInput — examples and fallback", () => {
  test("examples entry renders a keyword input with those options", async () => {
    const container = await renderInto(
      renderComboboxInput({ examples: ["auto", "16/9"] }, "aspectRatio", "16/9", () => {}),
    );
    const el = selector(container);
    expect(el.options.map((o) => o.value)).toEqual(["auto", "16/9"]);
    expect(el.value).toBe("16/9");
  });

  test("entry without examples renders a plain textfield with initial-value placeholder", async () => {
    const seen: string[] = [];
    const container = await renderInto(
      renderComboboxInput({}, "opacity", undefined, (v) => seen.push(v)),
    );
    const field = container.querySelector("sp-textfield") as HTMLInputElement;
    expect(field).not.toBeNull();
    expect(field.getAttribute("placeholder")).toBe("1");
    fire(field, "input", "0.5");
    expect(seen).toEqual(["0.5"]);
  });
});

// ─── widgetForType ───────────────────────────────────────────────────────────

describe("widgetForType (style-aware)", () => {
  test("select type routes through renderSelectInput", async () => {
    const container = await renderInto(
      widgetForType("select", { enum: ["row"] }, "flexDirection", "row", () => {}),
    );
    expect(selector(container).options.map((o) => o.value)).toEqual(["row"]);
  });

  test("combobox type routes through renderComboboxInput", async () => {
    const container = await renderInto(
      widgetForType("combobox", { examples: ["auto"] }, "aspectRatio", "", () => {}),
    );
    expect(selector(container).options.map((o) => o.value)).toEqual(["auto"]);
  });

  test("text type uses explicit placeholder over the CSS initial map", async () => {
    const container = await renderInto(
      widgetForType("text", {}, "display", "", () => {}, { placeholder: "inherited-val" }),
    );
    const field = container.querySelector("sp-textfield");
    expect(field?.getAttribute("placeholder")).toBe("inherited-val");
  });

  test("text type falls back to CSS initial-value placeholder", async () => {
    const container = await renderInto(widgetForType("text", {}, "display", "", () => {}));
    const field = container.querySelector("sp-textfield");
    expect(field?.getAttribute("placeholder")).toBe("inline");
  });
});
