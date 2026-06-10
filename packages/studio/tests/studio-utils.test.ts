import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import {
  camelToKebab,
  camelToLabel,
  kebabToLabel,
  propLabel,
  attrLabel,
  abbreviateValue,
  inferInputType,
  friendlyNameToVar,
  varDisplayName,
} from "../src/utils/studio-utils";

// ─── camelToKebab ────────────────────────────────────────────────────────────

describe("camelToKebab", () => {
  test("single word unchanged", () => {
    expect(camelToKebab("color")).toBe("color");
  });

  test("converts camelCase", () => {
    expect(camelToKebab("backgroundColor")).toBe("background-color");
  });

  test("multiple humps", () => {
    expect(camelToKebab("marginTopLeft")).toBe("margin-top-left");
  });

  test("already kebab (no uppercase)", () => {
    expect(camelToKebab("font-size")).toBe("font-size");
  });

  test("single char prefix", () => {
    expect(camelToKebab("zIndex")).toBe("z-index");
  });
});

// ─── camelToLabel ────────────────────────────────────────────────────────────

describe("camelToLabel", () => {
  test("simple property", () => {
    expect(camelToLabel("color")).toBe("Color");
  });

  test("camelCase to spaced", () => {
    expect(camelToLabel("backgroundColor")).toBe("Background Color");
  });

  test("multiple humps", () => {
    expect(camelToLabel("marginTopLeft")).toBe("Margin Top Left");
  });

  test("single char prefix", () => {
    expect(camelToLabel("zIndex")).toBe("Z Index");
  });

  test("all lowercase", () => {
    expect(camelToLabel("display")).toBe("Display");
  });
});

// ─── kebabToLabel ────────────────────────────────────────────────────────────

describe("kebabToLabel", () => {
  test("simple value", () => {
    expect(kebabToLabel("auto")).toBe("Auto");
  });

  test("kebab-case", () => {
    expect(kebabToLabel("border-box")).toBe("Border Box");
  });

  test("multiple dashes", () => {
    expect(kebabToLabel("flex-start")).toBe("Flex Start");
  });

  test("three segments", () => {
    expect(kebabToLabel("inline-flex-box")).toBe("Inline Flex Box");
  });

  test("small-caps", () => {
    expect(kebabToLabel("small-caps")).toBe("Small Caps");
  });
});

// ─── propLabel ───────────────────────────────────────────────────────────────

describe("propLabel", () => {
  test("returns $label when present", () => {
    expect(propLabel({ $label: "Font Size" }, "fontSize")).toBe("Font Size");
  });

  test("falls back to camelToLabel", () => {
    expect(propLabel({}, "backgroundColor")).toBe("Background Color");
  });

  test("handles null entry", () => {
    expect(propLabel(null, "color")).toBe("Color");
  });
});

// ─── attrLabel ───────────────────────────────────────────────────────────────

describe("attrLabel", () => {
  test("returns $label when present", () => {
    expect(attrLabel({ $label: "ID" }, "id")).toBe("ID");
  });

  test("converts kebab-case attribute", () => {
    expect(attrLabel({}, "aria-label")).toBe("Aria Label");
  });

  test("converts kebab-case with multiple dashes", () => {
    expect(attrLabel(null, "data-custom-value")).toBe("Data Custom Value");
  });

  test("falls back to camelToLabel for non-kebab", () => {
    expect(attrLabel({}, "tabindex")).toBe("Tabindex");
  });

  test("handles entry with no $label and camelCase", () => {
    expect(attrLabel({}, "maxLength")).toBe("Max Length");
  });
});

// ─── abbreviateValue ─────────────────────────────────────────────────────────

describe("abbreviateValue", () => {
  test("known abbreviations", () => {
    expect(abbreviateValue("inline")).toBe("inl");
    expect(abbreviateValue("flex-start")).toBe("start");
    expect(abbreviateValue("space-between")).toBe("betw");
    expect(abbreviateValue("column")).toBe("col");
    expect(abbreviateValue("baseline")).toBe("base");
  });

  test("unknown values returned as-is", () => {
    expect(abbreviateValue("center")).toBe("center");
    expect(abbreviateValue("flex")).toBe("flex");
    expect(abbreviateValue("grid")).toBe("grid");
  });

  test("reverse variants", () => {
    expect(abbreviateValue("row-reverse")).toBe("row-r");
    expect(abbreviateValue("column-reverse")).toBe("col-r");
  });
});

// ─── inferInputType ──────────────────────────────────────────────────────────

describe("inferInputType", () => {
  test("shorthand", () => {
    expect(inferInputType({ $shorthand: true })).toBe("shorthand");
  });

  test("button-group", () => {
    expect(inferInputType({ $input: "button-group" })).toBe("button-group");
  });

  test("color", () => {
    expect(inferInputType({ format: "color" })).toBe("color");
  });

  test("number-unit", () => {
    expect(inferInputType({ $units: ["px", "rem"] })).toBe("number-unit");
  });

  test("number", () => {
    expect(inferInputType({ type: "number" })).toBe("number");
  });

  test("select (enum)", () => {
    expect(inferInputType({ enum: ["a", "b"] })).toBe("select");
  });

  test("combobox (examples)", () => {
    expect(inferInputType({ examples: ["serif", "sans-serif"] })).toBe("combobox");
  });

  test("combobox (presets)", () => {
    expect(inferInputType({ presets: [{ label: "A", value: "a" }] })).toBe("combobox");
  });

  test("text (default)", () => {
    expect(inferInputType({ type: "string" })).toBe("text");
  });

  test("priority: shorthand > button-group > color > number-unit", () => {
    // shorthand wins over everything
    expect(
      inferInputType({
        $shorthand: true,
        $input: "button-group",
        format: "color",
      }),
    ).toBe("shorthand");
    // button-group wins over color
    expect(inferInputType({ $input: "button-group", format: "color" })).toBe("button-group");
    // color wins over number-unit
    expect(inferInputType({ format: "color", $units: ["px"] })).toBe("color");
  });
});

// ─── friendlyNameToVar ──────────────────────────────────────────────────────

describe("friendlyNameToVar", () => {
  test("converts display name to CSS variable", () => {
    expect(friendlyNameToVar("Geometric Humanist", "--font-")).toBe("--font-geometric-humanist");
  });

  test("handles single word", () => {
    expect(friendlyNameToVar("Monospace", "--font-")).toBe("--font-monospace");
  });

  test("handles multiple spaces", () => {
    expect(friendlyNameToVar("Old  Style", "--font-")).toBe("--font-old-style");
  });

  test("strips special characters", () => {
    expect(friendlyNameToVar("Neo-Grotesque!", "--font-")).toBe("--font-neo-grotesque");
  });

  test("trims whitespace", () => {
    expect(friendlyNameToVar("  System UI  ", "--font-")).toBe("--font-system-ui");
  });

  test("returns empty string for empty input", () => {
    expect(friendlyNameToVar("", "--font-")).toBe("");
  });

  test("works with different prefixes", () => {
    expect(friendlyNameToVar("Primary Blue", "--color-")).toBe("--color-primary-blue");
  });
});

// ─── varDisplayName ─────────────────────────────────────────────────────────

describe("varDisplayName", () => {
  test("converts CSS variable back to display name", () => {
    expect(varDisplayName("--font-geometric-humanist", "--font-")).toBe("Geometric Humanist");
  });

  test("handles single word", () => {
    expect(varDisplayName("--font-monospace", "--font-")).toBe("Monospace");
  });

  test("roundtrips with friendlyNameToVar for single-cased names", () => {
    // varDisplayName uses Title Case (\b\w), so acronyms like "UI" become "Ui"
    // This is fine — preset matching uses title directly, not reconstructed names
    const names = ["Geometric Humanist", "Old Style", "Classical Humanist"];
    for (const name of names) {
      const varName = friendlyNameToVar(name, "--font-");
      expect(varDisplayName(varName, "--font-")).toBe(name);
    }
  });

  test("title-cases each word (acronyms become title case)", () => {
    // "System UI" → --font-system-ui → "System Ui"
    expect(varDisplayName("--font-system-ui", "--font-")).toBe("System Ui");
  });

  test("returns original if prefix doesn't match", () => {
    expect(varDisplayName("--color-blue", "--font-")).toBe("Color Blue");
  });
});
