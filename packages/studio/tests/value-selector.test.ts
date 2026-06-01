import "./with-dom.js";
import { describe, test, expect } from "bun:test";

// ─── Unit tests for jx-value-selector logic ─────────────────────────────────
// Tests the component's core algorithms without importing Lit (avoids
// HappyDOM/Lit global conflicts when running alongside other test files).
// We replicate the class logic here to verify it in isolation.

/**
 * Replicates JxValueSelector._isPicker logic.
 *
 * @param {string} value
 * @param {any[]} options
 */
function isPicker(value: string, options: any[]) {
  return !!value && options.some((o) => !o.divider && o.value === value);
}

/**
 * Replicates JxValueSelector._selectedStyle logic.
 *
 * @param {string} value
 * @param {any[]} options
 */
function selectedStyle(value: string, options: any[]) {
  if (!isPicker(value, options)) return "";
  const opt = options.find((o) => !o.divider && o.value === value);
  return opt?.style || "";
}

const SAMPLE_OPTIONS: any[] = [
  { value: "bold", label: "Bold", style: "font-weight: bold" },
  { value: "normal", label: "Normal", style: "font-weight: normal" },
  { value: "lighter", label: "Lighter", style: "font-weight: lighter" },
];

const OPTIONS_WITH_DIVIDER: any[] = [
  { value: "--font-custom", label: "Custom", style: "font-family: Georgia" },
  { divider: true },
  { value: "__preset__:System UI", label: "System UI", style: "font-family: system-ui" },
];

// ─── Mode detection (isPicker) ─────────────────────────────────────────────

describe("jx-value-selector: isPicker logic", () => {
  test("returns false when value is empty", () => {
    expect(isPicker("", SAMPLE_OPTIONS)).toBe(false);
  });

  test("returns true when value matches an option", () => {
    expect(isPicker("bold", SAMPLE_OPTIONS)).toBe(true);
  });

  test("returns false when value does not match any option", () => {
    expect(isPicker("italic", SAMPLE_OPTIONS)).toBe(false);
  });

  test("ignores divider entries when matching", () => {
    expect(isPicker("--font-custom", OPTIONS_WITH_DIVIDER)).toBe(true);
  });

  test("divider value does not match", () => {
    expect(isPicker("true", [{ divider: true }])).toBe(false);
  });

  test("returns false with empty options array", () => {
    expect(isPicker("bold", [])).toBe(false);
  });
});

// ─── Selected style (selectedStyle) ────────────────────────────────────────

describe("jx-value-selector: selectedStyle logic", () => {
  test("returns style of matched option in picker mode", () => {
    expect(selectedStyle("bold", SAMPLE_OPTIONS)).toBe("font-weight: bold");
  });

  test("returns empty string in combobox mode", () => {
    expect(selectedStyle("italic", SAMPLE_OPTIONS)).toBe("");
  });

  test("returns empty string when value is empty", () => {
    expect(selectedStyle("", SAMPLE_OPTIONS)).toBe("");
  });

  test("returns empty string when option has no style", () => {
    expect(selectedStyle("x", [{ value: "x", label: "X" }])).toBe("");
  });
});

// ─── Mode transitions ──────────────────────────────────────────────────────

describe("jx-value-selector: mode transitions", () => {
  test("setting value to matching option switches to picker mode", () => {
    expect(isPicker("", SAMPLE_OPTIONS)).toBe(false);
    expect(isPicker("bold", SAMPLE_OPTIONS)).toBe(true);
  });

  test("setting value to non-matching switches to combobox mode", () => {
    expect(isPicker("bold", SAMPLE_OPTIONS)).toBe(true);
    expect(isPicker("900", SAMPLE_OPTIONS)).toBe(false);
  });

  test("clearing value switches to combobox mode", () => {
    expect(isPicker("bold", SAMPLE_OPTIONS)).toBe(true);
    expect(isPicker("", SAMPLE_OPTIONS)).toBe(false);
  });
});

// ─── Options with dividers ─────────────────────────────────────────────────

describe("jx-value-selector: options with dividers", () => {
  test("dividers are skipped in picker mode detection", () => {
    expect(isPicker("--font-custom", OPTIONS_WITH_DIVIDER)).toBe(true);
  });

  test("preset value after divider is selectable in picker mode", () => {
    expect(isPicker("__preset__:System UI", OPTIONS_WITH_DIVIDER)).toBe(true);
    expect(selectedStyle("__preset__:System UI", OPTIONS_WITH_DIVIDER)).toBe(
      "font-family: system-ui",
    );
  });
});

// ─── Picker mode does NOT include a clear option ───────────────────────────
// The component relies on the external "clear dot" indicator, not an
// internal "—" menu item. Verified by checking the source directly.

describe("jx-value-selector: no __none__ clear option", () => {
  test("picker render method does not reference __none__", async () => {
    const src = await Bun.file(new URL("../src/ui/value-selector.ts", import.meta.url)).text();
    // The render method should not contain __none__ anywhere
    // (it was removed; clearing is handled by the external dot indicator)
    expect(src).not.toContain("__none__");
  });

  test("picker render method adds jx-combobox-picker class", async () => {
    const src = await Bun.file(new URL("../src/ui/value-selector.ts", import.meta.url)).text();
    expect(src).toContain("jx-combobox-picker");
  });
});

// ─── Event handler behavior ────────────────────────────────────────────────
// Tests the handler functions' value normalization and event dispatch logic
// using minimal mock objects that mimic the component's state and behavior.

describe("jx-value-selector: event handler logic", () => {
  /**
   * Creates a mock component-like object with value, addEventListener, and dispatchEvent — enough
   * to test handler behavior without Lit.
   */
  function createMock(/** @type {string} */ value = "") {
    const dispatched: Event[] = [];
    return {
      value,
      /** @type {Event[]} */
      dispatched,
      /** @param {Event} e */
      dispatchEvent(e: Event) {
        dispatched.push(e);
        return true;
      },
    };
  }

  /**
   * Simulates _handlePickerChange: sets value, dispatches change.
   *
   * @param {ReturnType<typeof createMock>} ctx
   * @param {{ target: { value: string }; stopPropagation: () => void }} e
   */
  function pickerChange(
    ctx: ReturnType<typeof createMock>,
    e: { target: { value: string }; stopPropagation: () => void },
  ) {
    e.stopPropagation();
    ctx.value = e.target.value;
    ctx.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  /**
   * Simulates _handleMenuChange: ignores empty, sets value, dispatches change.
   *
   * @param {ReturnType<typeof createMock>} ctx
   * @param {{ target: { value: string }; stopPropagation: () => void }} e
   */
  function menuChange(
    ctx: ReturnType<typeof createMock>,
    e: { target: { value: string }; stopPropagation: () => void },
  ) {
    e.stopPropagation();
    if (!e.target.value) return;
    ctx.value = e.target.value;
    ctx.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  /**
   * Simulates _handleInput: sets value, dispatches input.
   *
   * @param {ReturnType<typeof createMock>} ctx
   * @param {{ target: { value: string }; stopPropagation: () => void }} e
   */
  function inputChange(
    ctx: ReturnType<typeof createMock>,
    e: { target: { value: string }; stopPropagation: () => void },
  ) {
    e.stopPropagation();
    ctx.value = e.target.value;
    ctx.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }

  /** @param {string} val */
  function mkEvent(val: string) {
    let stopped = false;
    return {
      target: { value: val },
      stopPropagation() {
        stopped = true;
      },
      get stopped() {
        return stopped;
      },
    };
  }

  test("picker change handler sets value directly", () => {
    const mock = createMock("bold");
    const e = mkEvent("normal");
    pickerChange(mock, e);

    expect(mock.value).toBe("normal");
    expect(mock.dispatched.length).toBe(1);
    expect(mock.dispatched[0].type).toBe("change");
    expect(e.stopped).toBe(true);
  });

  test("menu change handler ignores empty value", () => {
    const mock = createMock("bold");
    menuChange(mock, mkEvent(""));

    expect(mock.value).toBe("bold"); // unchanged
    expect(mock.dispatched.length).toBe(0);
  });

  test("menu change handler sets value for non-empty input", () => {
    const mock = createMock("");
    menuChange(mock, mkEvent("lighter"));

    expect(mock.value).toBe("lighter");
    expect(mock.dispatched.length).toBe(1);
  });

  test("input handler sets value and dispatches input event", () => {
    const mock = createMock("");
    inputChange(mock, mkEvent("Georgia, serif"));

    expect(mock.value).toBe("Georgia, serif");
    expect(mock.dispatched.length).toBe(1);
    expect(mock.dispatched[0].type).toBe("input");
  });

  test("all handlers call stopPropagation on the original event", () => {
    const e1 = mkEvent("normal");
    pickerChange(createMock("bold"), e1);

    const e2 = mkEvent("lighter");
    menuChange(createMock(""), e2);

    const e3 = mkEvent("test");
    inputChange(createMock(""), e3);

    expect(e1.stopped).toBe(true);
    expect(e2.stopped).toBe(true);
    expect(e3.stopped).toBe(true);
  });
});
