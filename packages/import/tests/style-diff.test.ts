import { describe, test, expect } from "bun:test";
import { kebabToCamel, diffStyles, diffAllStyles, computeMediaDelta } from "../src/style-diff.ts";
import type { CapturedStyle } from "../src/style-capture.ts";

describe("kebabToCamel", () => {
  test("converts simple kebab-case", () => {
    expect(kebabToCamel("font-size")).toBe("fontSize");
    expect(kebabToCamel("background-color")).toBe("backgroundColor");
    expect(kebabToCamel("border-top-left-radius")).toBe("borderTopLeftRadius");
  });

  test("passes through single-word properties", () => {
    expect(kebabToCamel("color")).toBe("color");
    expect(kebabToCamel("display")).toBe("display");
    expect(kebabToCamel("opacity")).toBe("opacity");
  });

  test("handles vendor prefixes", () => {
    expect(kebabToCamel("-webkit-transform")).toBe("webkitTransform");
    expect(kebabToCamel("-moz-appearance")).toBe("mozAppearance");
    expect(kebabToCamel("-ms-overflow-style")).toBe("msOverflowStyle");
  });
});

describe("diffStyles", () => {
  test("removes properties that match UA defaults", () => {
    const captured = { display: "block", color: "rgb(255, 0, 0)", "font-size": "16px" };
    const defaults = { display: "block", color: "rgb(0, 0, 0)", "font-size": "16px" };
    const result = diffStyles(captured, defaults);

    expect(result).not.toHaveProperty("display");
    expect(result).not.toHaveProperty("fontSize");
    expect(result).toHaveProperty("color", "rgb(255, 0, 0)");
  });

  test("drops noise values for non-exempt properties", () => {
    const captured = { "z-index": "auto", top: "auto", "margin-top": "0px" };
    const defaults = {};
    const result = diffStyles(captured, defaults);

    expect(result).not.toHaveProperty("zIndex");
    expect(result).not.toHaveProperty("top");
    expect(result).not.toHaveProperty("marginTop");
  });

  test("keeps noise values for exempt properties", () => {
    const captured = { overflow: "hidden", display: "flex", "white-space": "nowrap" };
    const defaults = { overflow: "visible", display: "block", "white-space": "normal" };
    const result = diffStyles(captured, defaults);

    expect(result).toHaveProperty("overflow", "hidden");
    expect(result).toHaveProperty("display", "flex");
    expect(result).toHaveProperty("whiteSpace", "nowrap");
  });

  test("converts numeric-only values to numbers", () => {
    const captured = { opacity: "0.5", "z-index": "10" };
    const defaults = { opacity: "1" };
    const result = diffStyles(captured, defaults);

    expect(result.opacity).toBe(0.5);
  });

  test("returns empty object when all match defaults", () => {
    const captured = { display: "block", color: "rgb(0, 0, 0)" };
    const defaults = { display: "block", color: "rgb(0, 0, 0)" };
    const result = diffStyles(captured, defaults);

    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe("diffAllStyles", () => {
  test("filters out elements with no meaningful styles", () => {
    const elements: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { display: "block" } },
      { path: [0, 0], tagName: "p", styles: { color: "rgb(255, 0, 0)" } },
      { path: [0, 1], tagName: "p", styles: { display: "block" } },
    ];
    const uaDefaults = {
      div: { display: "block" },
      p: { display: "block", color: "rgb(0, 0, 0)" },
    };
    const result = diffAllStyles(elements, uaDefaults);

    expect(result).toHaveLength(1);
    expect(result[0]!.path).toEqual([0, 0]);
    expect(result[0]!.style.color).toBe("rgb(255, 0, 0)");
  });
});

describe("computeMediaDelta", () => {
  test("returns only properties that changed from base", () => {
    const base: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { "font-size": "24px", display: "flex" } },
    ];
    const bp: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { "font-size": "16px", display: "flex" } },
    ];
    const uaDefaults = { div: { "font-size": "16px", display: "block" } };
    const deltas = computeMediaDelta(base, bp, uaDefaults);

    // Font-size changed: base had "24px" (non-default), bp has "16px" (matches UA default,
    // So it's dropped from the diff). That means the bp diff is empty for font-size,
    // But the base diff had fontSize: "24px". The delta should show the difference.
    /* Base diffed = { fontSize: "24px", display: "flex" }; bp diffed = { display: "flex" }.
       `display` is unchanged, but `fontSize` REVERTED to the UA default at the breakpoint, so it
       vanished from the bp side rather than staying there with a new value. A revert is a change:
       it is emitted with the breakpoint's own raw value, which is what the element actually
       computes to there. */
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.style).toHaveProperty("fontSize", "16px");
    expect(deltas[0]!.style).not.toHaveProperty("display");
  });

  test("detects style additions at breakpoint", () => {
    const base: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { display: "flex", "flex-direction": "row" } },
    ];
    const bp: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { display: "flex", "flex-direction": "column" } },
    ];
    const uaDefaults = { div: {} };
    const deltas = computeMediaDelta(base, bp, uaDefaults);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.style).toHaveProperty("flexDirection", "column");
    expect(deltas[0]!.style).not.toHaveProperty("display");
  });

  test("handles elements only in base (removed at breakpoint)", () => {
    const base: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { display: "flex" } },
      { path: [0, 0], tagName: "span", styles: { color: "red" } },
    ];
    const bp: CapturedStyle[] = [{ path: [0], tagName: "div", styles: { display: "block" } }];
    const uaDefaults = { div: { display: "block" }, span: {} };
    const deltas = computeMediaDelta(base, bp, uaDefaults);

    /* The div went `flex` -> `block`, and `block` is the div's UA default, so the bp side filters
       to {}. That is the single most common responsive change there is (stack on mobile) and it
       must survive: the delta carries `display: block` from the raw capture. The span is absent at
       the breakpoint entirely and contributes nothing. */
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.path).toEqual([0]);
    expect(deltas[0]!.style).toHaveProperty("display", "block");
  });
});
