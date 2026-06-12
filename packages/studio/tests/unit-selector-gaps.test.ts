import "./harness";
import { describe, expect, test } from "bun:test";
import { html, render } from "lit-html";
import { renderUnitSelector } from "../src/ui/unit-selector";

// ─── Local helpers ───────────────────────────────────────────────────────────

const SIZE_ENTRY = {
  $keywords: ["auto", "max-content"],
  $units: ["px", "rem", "em", "%"],
};

let propSeq = 0;

function mount(value: string | number | undefined, entry = SIZE_ENTRY, placeholder = "") {
  const commits: string[] = [];
  const container = document.createElement("div");
  // Unique prop per mount keeps debounce namespaces from colliding across tests.
  propSeq += 1;
  const prop = `gap-prop-${propSeq}`;
  render(
    html`<div>${renderUnitSelector(entry, prop, value, (v) => commits.push(v), placeholder)}</div>`,
    container,
  );
  return { commits, container };
}

function setAndDispatch(el: Element, type: string, value: string) {
  (el as unknown as { value: string }).value = value;
  el.dispatchEvent(new Event(type, { bubbles: false }));
}

// ─── displayValue fallback for unparseable values (lines 47-48) ──────────────

describe("renderUnitSelector — non-matching value display", () => {
  test("calc() expression displays as-is and is flagged as expression", () => {
    const { container } = mount("calc(100% - 10px)");
    const tf = container.querySelector("sp-textfield")!;
    expect((tf as unknown as { value: string }).value).toBe("calc(100% - 10px)");
    expect(container.querySelector(".input-group")!.classList.contains("is-expression")).toBe(true);
  });

  test("shorthand value with leading number displays its parsed numeric part", () => {
    const { container } = mount("10px 20px");
    const tf = container.querySelector("sp-textfield")!;
    expect((tf as unknown as { value: string }).value).toBe("10");
  });

  test("numeric value '500' is not flagged as expression", () => {
    const { container } = mount("500px");
    expect(container.querySelector(".input-group")!.classList.contains("is-expression")).toBe(
      false,
    );
  });

  test("keyword value is flagged as expression", () => {
    const { container } = mount("auto");
    expect(container.querySelector(".input-group")!.classList.contains("is-expression")).toBe(true);
  });
});

// ─── Picker button label (currentUnit derivation) ────────────────────────────

describe("renderUnitSelector — unit button label", () => {
  function unitLabel(container: HTMLElement): string {
    return container.querySelector("sp-picker-button span")!.textContent!.trim();
  }

  test("shows the value's unit when present", () => {
    const { container } = mount("10rem");
    expect(unitLabel(container)).toBe("rem");
  });

  test("falls back to the first unit for keywords", () => {
    const { container } = mount("auto");
    expect(unitLabel(container)).toBe("px");
  });

  test("falls back to the first unit when value is empty", () => {
    const { container } = mount("");
    expect(unitLabel(container)).toBe("px");
  });

  test("no unit button when entry has neither units nor keywords", () => {
    const { container } = mount("0.5", { $keywords: [], $units: [] });
    expect(container.querySelector("sp-picker-button")).toBeNull();
  });
});

// ─── Unit menu @change handler (lines 103-112) ───────────────────────────────

describe("renderUnitSelector — unit menu change", () => {
  test("choosing a unit re-commits the numeric part with the new unit", () => {
    const { container, commits } = mount("10px");
    setAndDispatch(container.querySelector("sp-menu")!, "change", "rem");
    expect(commits).toEqual(["10rem"]);
  });

  test("choosing a keyword commits the keyword directly", () => {
    const { container, commits } = mount("10px");
    setAndDispatch(container.querySelector("sp-menu")!, "change", "auto");
    expect(commits).toEqual(["auto"]);
  });

  test("choosing a unit with no current numeric part commits nothing", () => {
    const { container, commits } = mount("");
    setAndDispatch(container.querySelector("sp-menu")!, "change", "rem");
    expect(commits).toEqual([]);
  });

  test("choosing a unit while a keyword is set commits nothing", () => {
    const { container, commits } = mount("auto");
    setAndDispatch(container.querySelector("sp-menu")!, "change", "%");
    expect(commits).toEqual([]);
  });

  test("an unknown menu value commits nothing", () => {
    const { container, commits } = mount("10px");
    setAndDispatch(container.querySelector("sp-menu")!, "change", "bogus");
    expect(commits).toEqual([]);
  });

  test("menu lists units, a divider, then keywords", () => {
    const { container } = mount("10px");
    const menu = container.querySelector("sp-menu")!;
    const items = [...menu.querySelectorAll("sp-menu-item")].map((i) => i.getAttribute("value"));
    expect(items).toEqual(["px", "rem", "em", "%", "auto", "max-content"]);
    expect(menu.querySelector("sp-menu-divider")).toBeTruthy();
  });

  test("no divider when entry has units but no keywords", () => {
    const { container } = mount("10px", { $keywords: [], $units: ["px"] });
    expect(container.querySelector("sp-menu sp-menu-divider")).toBeNull();
  });

  test("numeric value on a units-less entry with keywords still renders the keyword menu", () => {
    const { container, commits } = mount("inherit", { $keywords: ["inherit"], $units: [] });
    const menu = container.querySelector("sp-menu")!;
    expect([...menu.querySelectorAll("sp-menu-item")].map((i) => i.getAttribute("value"))).toEqual([
      "inherit",
    ]);
    setAndDispatch(menu, "change", "inherit");
    expect(commits).toEqual(["inherit"]);
  });
});

// ─── Commit normalization on unitless entries ────────────────────────────────

describe("renderUnitSelector — unitless commit", () => {
  test("change commits a bare number when entry has no units", () => {
    const { container, commits } = mount("", { $keywords: [], $units: [] });
    setAndDispatch(container.querySelector("sp-textfield")!, "change", "1.25");
    expect(commits).toEqual(["1.25"]);
  });

  test("change with surrounding whitespace is trimmed before commit", () => {
    const { container, commits } = mount("");
    setAndDispatch(container.querySelector("sp-textfield")!, "change", "  42  ");
    expect(commits).toEqual(["42px"]);
  });
});
