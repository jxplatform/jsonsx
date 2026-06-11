import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { html, render } from "lit-html";
import { UNIT_RE, renderUnitSelector } from "../src/ui/unit-selector";
import { cancelStyleDebounce } from "../src/store";

// Minimal css-meta entry for a size property (height-like)
const SIZE_ENTRY = {
  $keywords: ["auto", "max-content"],
  $units: ["px", "rem", "em", "%"],
};
// Entry with no units (unitless property)
const UNITLESS_ENTRY = { $keywords: [], $units: [] };

function mount(value?: string | number, placeholder = "", entry = SIZE_ENTRY, prop = "height") {
  const commits: string[] = [];
  const container = document.createElement("div");
  render(
    html`<div>${renderUnitSelector(entry, prop, value, (v) => commits.push(v), placeholder)}</div>`,
    container,
  );
  const tf = container.querySelector("sp-textfield") as HTMLElement & {
    value: string;
  };
  return { commits, container, tf };
}

function dispatch(el: HTMLElement, type: string, value?: string) {
  if (value !== undefined) {
    (el as unknown as { value: string }).value = value;
  }
  el.dispatchEvent(new Event(type, { bubbles: false }));
}

// ─── UNIT_RE ─────────────────────────────────────────────────────────────────

describe("UNIT_RE", () => {
  test("matches integer + unit", () => {
    const m = "500px".match(UNIT_RE)!;
    expect(m[1]).toBe("500");
    expect(m[2]).toBe("px");
  });

  test("matches decimal + unit", () => {
    const m = "1.5rem".match(UNIT_RE)!;
    expect(m[1]).toBe("1.5");
    expect(m[2]).toBe("rem");
  });

  test("matches percent", () => {
    const m = "100%".match(UNIT_RE)!;
    expect(m[1]).toBe("100");
    expect(m[2]).toBe("%");
  });

  test("matches unitless number (optional unit group is undefined)", () => {
    const m = "0".match(UNIT_RE)!;
    expect(m[1]).toBe("0");
    expect(m[2]).toBeUndefined();
  });

  test("matches negative value", () => {
    const m = "-10px".match(UNIT_RE)!;
    expect(m[1]).toBe("-10");
    expect(m[2]).toBe("px");
  });

  test("does not match keyword", () => {
    expect("auto".match(UNIT_RE)).toBeNull();
  });

  test("does not match value with space before unit", () => {
    expect("500 px".match(UNIT_RE)).toBeNull();
  });

  test("does not match unknown unit", () => {
    expect("500abc".match(UNIT_RE)).toBeNull();
  });
});

// ─── Placeholder parsing ──────────────────────────────────────────────────────

describe("renderUnitSelector — placeholder display", () => {
  test("placeholder '500px' renders as '500' (numeric part only)", () => {
    const { tf } = mount("", "500px");
    expect(tf.getAttribute("placeholder")).toBe("500");
  });

  test("placeholder '1.5rem' renders as '1.5'", () => {
    const { tf } = mount("", "1.5rem");
    expect(tf.getAttribute("placeholder")).toBe("1.5");
  });

  test("keyword placeholder 'auto' passes through unchanged", () => {
    const { tf } = mount("", "auto");
    expect(tf.getAttribute("placeholder")).toBe("auto");
  });

  test("empty placeholder falls back to '0'", () => {
    const { tf } = mount("", "");
    expect(tf.getAttribute("placeholder")).toBe("0");
  });

  test("set value '500px' shows parsed numeric value '500', not the placeholder", () => {
    const { tf } = mount("500px", "auto");
    // Live() sets the value property
    expect(tf.value).toBe("500");
    // Placeholder is still 'auto' (overridden by presence of value)
    expect(tf.getAttribute("placeholder")).toBe("auto");
  });
});

// ─── Value parsing into displayValue / currentUnit ───────────────────────────

describe("renderUnitSelector — value display", () => {
  test("value '500px' → textfield shows '500'", () => {
    const { tf } = mount("500px");
    expect(tf.value).toBe("500");
  });

  test("value '1.5rem' → textfield shows '1.5'", () => {
    const { tf } = mount("1.5rem");
    expect(tf.value).toBe("1.5");
  });

  test("keyword value 'auto' → textfield shows 'auto'", () => {
    const { tf } = mount("auto");
    expect(tf.value).toBe("auto");
  });

  test("empty value → textfield shows ''", () => {
    const { tf } = mount("");
    expect(tf.value).toBe("");
  });

  test("undefined value → textfield shows ''", () => {
    const { tf } = mount();
    expect(tf.value).toBe("");
  });
});

// ─── @change commit-on-blur ───────────────────────────────────────────────────

describe("renderUnitSelector — @change commits immediately", () => {
  test("change event with numeric value commits value + unit", () => {
    const { tf, commits } = mount("");
    dispatch(tf, "change", "500");
    expect(commits).toEqual(["500px"]);
  });

  test("change event with empty value commits empty string", () => {
    const { tf, commits } = mount("500px");
    dispatch(tf, "change", "");
    expect(commits).toEqual([""]);
  });

  test("change event with non-numeric value commits as-is", () => {
    const { tf, commits } = mount("");
    dispatch(tf, "change", "auto");
    expect(commits).toEqual(["auto"]);
  });

  test("change event picks up current unit from committed value", () => {
    // If the current value in doc is "200rem", currentUnit="rem"
    const { tf, commits } = mount("200rem");
    dispatch(tf, "change", "300");
    expect(commits).toEqual(["300rem"]);
  });

  test("change event on unitless entry commits bare number", () => {
    const { tf, commits } = mount("", "", UNITLESS_ENTRY, "opacity");
    dispatch(tf, "change", "0.5");
    expect(commits).toEqual(["0.5"]);
  });
});

// ─── @change cancels pending debounce ────────────────────────────────────────

describe("renderUnitSelector — @change cancels pending @input debounce", () => {
  test("change event fires before debounce: only one commit happens", async () => {
    const commits: string[] = [];
    const container = document.createElement("div");
    render(
      html`<div>
        ${renderUnitSelector(SIZE_ENTRY, "cancel-test", "", (v) => commits.push(v), "")}
      </div>`,
      container,
    );
    const tf = container.querySelector("sp-textfield") as HTMLElement & {
      value: string;
    };

    // Simulate user typing "500" (starts 400ms debounce)
    dispatch(tf, "input", "500");

    // Immediately simulate blur with the same value (change event cancels debounce)
    dispatch(tf, "change", "500");

    // Wait past the debounce window
    await new Promise((r) => {
      setTimeout(r, 450);
    });

    // Should have committed exactly once (from @change), not twice
    expect(commits).toEqual(["500px"]);
  });

  test("without @change, the input debounce would fire after blur; cancelStyleDebounce stops it", async () => {
    // Direct test of the underlying mechanism used by the @change handler
    const fired: number[] = [];
    const { debouncedStyleCommit } = await import("../src/store");
    const handler = debouncedStyleCommit("manual-cancel-test", 50, (_e: Event) => fired.push(1));
    // Simulate input event (start debounce)
    handler(new Event("input"));
    // Immediately cancel
    cancelStyleDebounce("manual-cancel-test");
    await new Promise((r) => {
      setTimeout(r, 100);
    });
    expect(fired).toHaveLength(0);
  });
});

// ─── @input debounce formatting ───────────────────────────────────────────────

describe("renderUnitSelector — @input debounce", () => {
  test("input event with numeric value debounces and commits with unit after delay", async () => {
    const { tf, commits } = mount("");
    dispatch(tf, "input", "200");
    await new Promise((r) => {
      setTimeout(r, 450);
    });
    expect(commits).toEqual(["200px"]);
  });

  test("rapid inputs only commit the last value", async () => {
    const { tf, commits } = mount("");
    dispatch(tf, "input", "1");
    dispatch(tf, "input", "10");
    dispatch(tf, "input", "100");
    await new Promise((r) => {
      setTimeout(r, 450);
    });
    expect(commits).toEqual(["100px"]);
  });

  test("input event with empty value debounces and commits empty string", async () => {
    const { tf, commits } = mount("500px");
    dispatch(tf, "input", "");
    await new Promise((r) => {
      setTimeout(r, 450);
    });
    expect(commits).toEqual([""]);
  });
});
