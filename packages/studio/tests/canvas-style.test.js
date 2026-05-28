import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import { applyStyle } from "@jxsuite/runtime";
import { friendlyNameToVar, varDisplayName } from "../src/utils/studio-utils.js";

// ─── CSS custom properties on inline styles ─────────────────────────────────

describe("CSS custom properties on inline styles", () => {
  test("setProperty sets custom properties retrievable via getPropertyValue", () => {
    const el = document.createElement("div");
    el.style.setProperty("--font-humanist", "Avenir, Montserrat, sans-serif");
    expect(el.style.getPropertyValue("--font-humanist")).toBe("Avenir, Montserrat, sans-serif");
  });

  test("regular properties still work via bracket assignment", () => {
    const el = document.createElement("div");
    /** @type {any} */ (el.style).color = "blue";
    expect(el.style.color).toBe("blue");
  });

  test("custom properties and regular properties coexist", () => {
    const el = document.createElement("div");
    /** @type {any} */ (el.style).padding = "2rem";
    el.style.setProperty("--font-geometric", "Avenir, sans-serif");

    expect(/** @type {any} */ (el.style).padding).toBe("2rem");
    expect(el.style.getPropertyValue("--font-geometric")).toBe("Avenir, sans-serif");
  });
});

// ─── Runtime applyStyle with custom properties ──────────────────────────────

describe("applyStyle with CSS custom properties", () => {
  test("sets custom properties retrievable via getPropertyValue", () => {
    const el = document.createElement("div");
    applyStyle(el, { "--my-color": "red", "--spacing": "8px" });
    expect(el.style.getPropertyValue("--my-color")).toBe("red");
    expect(el.style.getPropertyValue("--spacing")).toBe("8px");
  });

  test("custom properties and regular properties coexist", () => {
    const el = document.createElement("div");
    applyStyle(el, { color: "blue", "--accent": "green", fontSize: "14px" });
    expect(el.style.color).toBe("blue");
    expect(el.style.fontSize).toBe("14px");
    expect(el.style.getPropertyValue("--accent")).toBe("green");
  });

  test("font stack variable set on parent is accessible", () => {
    const parent = document.createElement("div");
    const child = document.createElement("h1");
    parent.appendChild(child);
    document.body.appendChild(parent);

    applyStyle(parent, {
      "--font-geometric-humanist": "Avenir, Montserrat, Corbel, sans-serif",
    });
    applyStyle(child, { fontFamily: "var(--font-geometric-humanist)" });

    // The variable is set on the parent
    expect(parent.style.getPropertyValue("--font-geometric-humanist")).toBe(
      "Avenir, Montserrat, Corbel, sans-serif",
    );
    // The child references it via var()
    expect(child.style.fontFamily).toBe("var(--font-geometric-humanist)");

    parent.remove();
  });
});

// ─── Font stack selection roundtrip ─────────────────────────────────────────
// Simulates the full flow: preset selection → variable creation → assignment

describe("Font stack selection roundtrip", () => {
  /** @type {{ title: string; value: string }[]} */
  const PRESETS = [
    { title: "System UI", value: "system-ui, sans-serif" },
    {
      title: "Geometric Humanist",
      value: "Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif",
    },
    {
      title: "Classical Humanist",
      value: "Optima, Candara, 'Noto Sans', source-sans-pro, sans-serif",
    },
  ];

  /**
   * Simulates handleFontPresetSelection: creates CSS variable on root and returns the var()
   * reference for the element.
   */
  function simulatePresetSelection(
    /** @type {{ title: string; value: string }} */ preset,
    /** @type {Record<string, string>} */ rootStyle,
  ) {
    const varName = friendlyNameToVar(preset.title, "--font-");
    if (!rootStyle[varName]) {
      rootStyle[varName] = preset.value;
    }
    return `var(${varName})`;
  }

  /**
   * Simulates handleFontSelection: matches display text against presets and font vars, returns the
   * value that would be set on the element.
   */
  function simulateComboboxChange(
    /** @type {string} */ displayText,
    /** @type {{ title: string; value: string }[]} */ presets,
    /** @type {Record<string, string>} */ rootStyle,
  ) {
    // Match against preset titles (sp-combobox returns display text)
    const preset = presets.find((p) => p.title === displayText);
    if (preset) {
      return simulatePresetSelection(preset, rootStyle);
    }
    // Match against existing font var display names
    const fontVars = Object.entries(rootStyle)
      .filter(([k]) => k.startsWith("--font"))
      .map(([k, v]) => ({ name: k, value: v }));
    const matchedVar = fontVars.find((fv) => varDisplayName(fv.name, "--font-") === displayText);
    if (matchedVar) {
      return `var(${matchedVar.name})`;
    }
    // Plain font family string
    return displayText;
  }

  test("selecting a preset creates variable and returns var() reference", () => {
    /** @type {Record<string, string>} */
    const rootStyle = {};
    const result = simulateComboboxChange("Geometric Humanist", PRESETS, rootStyle);

    // Should create the CSS variable on the root
    expect(rootStyle["--font-geometric-humanist"]).toBe(
      "Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif",
    );
    // Should return var() reference for the element
    expect(result).toBe("var(--font-geometric-humanist)");
  });

  test("selecting preset does NOT duplicate existing variable", () => {
    /** @type {Record<string, string>} */
    const rootStyle = {
      "--font-geometric-humanist":
        "Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif",
    };
    const result = simulateComboboxChange("Geometric Humanist", PRESETS, rootStyle);

    expect(result).toBe("var(--font-geometric-humanist)");
    // Still only one entry
    expect(Object.keys(rootStyle).length).toBe(1);
  });

  test("selecting an existing font var returns var() reference", () => {
    /** @type {Record<string, string>} */
    const rootStyle = {
      "--font-geometric-humanist": "Avenir, Montserrat, sans-serif",
    };
    // User selects display name of an existing var (not a preset match)
    const result = simulateComboboxChange("Geometric Humanist", [], rootStyle);

    expect(result).toBe("var(--font-geometric-humanist)");
  });

  test("typing plain text passes through without var() wrapping", () => {
    /** @type {Record<string, string>} */
    const rootStyle = {};
    const result = simulateComboboxChange("serif", PRESETS, rootStyle);

    expect(result).toBe("serif");
    // No variable created
    expect(Object.keys(rootStyle).length).toBe(0);
  });

  test("typing 'Arial, sans-serif' passes through as-is", () => {
    /** @type {Record<string, string>} */
    const rootStyle = {};
    const result = simulateComboboxChange("Arial, sans-serif", PRESETS, rootStyle);

    expect(result).toBe("Arial, sans-serif");
  });

  test("full roundtrip: preset → DOM variable → child var() reference", () => {
    /** @type {Record<string, string>} */
    const rootStyle = {};
    const elementValue = simulateComboboxChange("Geometric Humanist", PRESETS, rootStyle);

    // Apply to DOM elements
    const parent = document.createElement("div");
    const child = document.createElement("h1");
    parent.appendChild(child);
    document.body.appendChild(parent);

    // Apply root style (including the new CSS variable)
    for (const [prop, val] of Object.entries(rootStyle)) {
      parent.style.setProperty(prop, val);
    }
    // Apply element style
    /** @type {any} */ (child.style).fontFamily = elementValue;

    // Verify the variable is set on parent
    expect(parent.style.getPropertyValue("--font-geometric-humanist")).toBe(
      "Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif",
    );
    // Verify the child references it
    expect(child.style.fontFamily).toBe("var(--font-geometric-humanist)");

    parent.remove();
  });

  test("multiple presets create separate variables", () => {
    /** @type {Record<string, string>} */
    const rootStyle = {};
    simulateComboboxChange("System UI", PRESETS, rootStyle);
    simulateComboboxChange("Classical Humanist", PRESETS, rootStyle);

    expect(rootStyle["--font-system-ui"]).toBe("system-ui, sans-serif");
    expect(rootStyle["--font-classical-humanist"]).toBe(
      "Optima, Candara, 'Noto Sans', source-sans-pro, sans-serif",
    );
    expect(Object.keys(rootStyle).length).toBe(2);
  });
});

// ─── Font option grouping ───────────────────────────────────────────────────
// Tests the renderFontOptions grouping logic: local vars first, divider, then
// unadded presets.

describe("Font option grouping", () => {
  /** @type {{ title: string; value: string }[]} */
  const PRESETS = [
    { title: "System UI", value: "system-ui, sans-serif" },
    { title: "Geometric Humanist", value: "Avenir, Montserrat, sans-serif" },
    { title: "Classical Humanist", value: "Optima, Candara, sans-serif" },
  ];

  /**
   * Simulates renderFontOptions grouping logic. Returns { localVars: string[], unaddedPresets:
   * string[] }
   */
  function simulateGrouping(
    /** @type {{ name: string; value: string }[]} */ fontVars,
    /** @type {{ title: string; value: string }[]} */ presets,
  ) {
    const unaddedPresets = presets.filter((p) => {
      const varName = friendlyNameToVar(p.title, "--font-");
      return !fontVars.some((fv) => fv.name === varName);
    });
    return {
      localVars: fontVars.map((fv) => fv.name),
      unaddedPresets: unaddedPresets.map((p) => p.title),
    };
  }

  test("no local vars shows all presets", () => {
    const { localVars, unaddedPresets } = simulateGrouping([], PRESETS);
    expect(localVars).toEqual([]);
    expect(unaddedPresets).toEqual(["System UI", "Geometric Humanist", "Classical Humanist"]);
  });

  test("local vars listed first, unadded presets after", () => {
    const fontVars = [{ name: "--font-system-ui", value: "system-ui, sans-serif" }];
    const { localVars, unaddedPresets } = simulateGrouping(fontVars, PRESETS);
    expect(localVars).toEqual(["--font-system-ui"]);
    expect(unaddedPresets).toEqual(["Geometric Humanist", "Classical Humanist"]);
  });

  test("preset already added as local var is excluded from presets section", () => {
    const fontVars = [
      { name: "--font-geometric-humanist", value: "Avenir, Montserrat, sans-serif" },
      { name: "--font-classical-humanist", value: "Optima, Candara, sans-serif" },
    ];
    const { localVars, unaddedPresets } = simulateGrouping(fontVars, PRESETS);
    expect(localVars).toEqual(["--font-geometric-humanist", "--font-classical-humanist"]);
    expect(unaddedPresets).toEqual(["System UI"]);
  });

  test("all presets added as local vars leaves no unadded presets", () => {
    const fontVars = PRESETS.map((p) => ({
      name: friendlyNameToVar(p.title, "--font-"),
      value: p.value,
    }));
    const { localVars, unaddedPresets } = simulateGrouping(fontVars, PRESETS);
    expect(localVars.length).toBe(3);
    expect(unaddedPresets).toEqual([]);
  });
});

// ─── buildFontOptions format ───────────────────────────────────────────────
// Tests the options array format used by jx-styled-combobox.

describe("buildFontOptions format for jx-styled-combobox", () => {
  /** @type {{ title: string; value: string }[]} */
  const PRESETS = [
    { title: "System UI", value: "system-ui, sans-serif" },
    { title: "Geometric Humanist", value: "Avenir, Montserrat, sans-serif" },
  ];

  /**
   * Mirrors buildFontOptions from studio.js — produces the options array consumed by
   * jx-styled-combobox.
   *
   * @param {{ name: string; value: string }[]} fontVars
   * @param {{ title: string; value: string }[]} presets
   */
  function buildFontOptions(fontVars, presets) {
    /** @type {any[]} */
    const opts = fontVars.map((fv) => ({
      value: fv.name,
      label: varDisplayName(fv.name, "--font-"),
      style: `font-family: ${fv.value}`,
    }));
    const unadded = presets.filter(
      (p) => !fontVars.some((fv) => fv.name === friendlyNameToVar(p.title, "--font-")),
    );
    if (unadded.length > 0 && opts.length > 0) opts.push({ divider: true });
    for (const p of unadded) {
      opts.push({
        value: "__preset__:" + p.title,
        label: p.title,
        style: `font-family: ${p.value}`,
      });
    }
    return opts;
  }

  test("no local vars produces preset options only (no divider)", () => {
    const opts = buildFontOptions([], PRESETS);
    expect(opts.length).toBe(2);
    expect(opts[0]).toEqual({
      value: "__preset__:System UI",
      label: "System UI",
      style: "font-family: system-ui, sans-serif",
    });
    expect(opts.every((/** @type {any} */ o) => !o.divider)).toBe(true);
  });

  test("local vars + presets produces divider between groups", () => {
    const fontVars = [{ name: "--font-custom", value: "Georgia, serif" }];
    const opts = buildFontOptions(fontVars, PRESETS);
    // local var + divider + 2 presets = 4
    expect(opts.length).toBe(4);
    expect(opts[0].value).toBe("--font-custom");
    expect(opts[0].label).toBe("Custom");
    expect(opts[0].style).toBe("font-family: Georgia, serif");
    expect(opts[1]).toEqual({ divider: true });
    expect(opts[2].value).toBe("__preset__:System UI");
  });

  test("preset already added as local var is excluded from presets", () => {
    const fontVars = [{ name: "--font-system-ui", value: "system-ui, sans-serif" }];
    const opts = buildFontOptions(fontVars, PRESETS);
    // local var + divider + 1 remaining preset = 3
    expect(opts.length).toBe(3);
    expect(opts[0].value).toBe("--font-system-ui");
    expect(opts[2].value).toBe("__preset__:Geometric Humanist");
  });

  test("all presets added as local vars produces no divider or presets", () => {
    const fontVars = PRESETS.map((p) => ({
      name: friendlyNameToVar(p.title, "--font-"),
      value: p.value,
    }));
    const opts = buildFontOptions(fontVars, PRESETS);
    expect(opts.length).toBe(2);
    expect(opts.every((/** @type {any} */ o) => !o.divider)).toBe(true);
    expect(opts[0].value).toBe("--font-system-ui");
    expect(opts[1].value).toBe("--font-geometric-humanist");
  });

  test("each option has value, label, and style properties", () => {
    const opts = buildFontOptions([], PRESETS);
    for (const opt of opts) {
      if (/** @type {any} */ (opt).divider) continue;
      expect(typeof (/** @type {any} */ (opt).value)).toBe("string");
      expect(typeof (/** @type {any} */ (opt).label)).toBe("string");
      expect(typeof (/** @type {any} */ (opt).style)).toBe("string");
      expect(/** @type {any} */ (opt).style).toMatch(/^font-family: /);
    }
  });
});

// ─── Menu @change value handling ────────────────────────────────────────────
// jx-styled-combobox dispatches @change with the option's value attribute.
// These tests verify the handleFontSelection logic that processes those values.

describe("Menu @change value-attribute handling", () => {
  /** @type {{ title: string; value: string }[]} */
  const PRESETS = [
    { title: "System UI", value: "system-ui, sans-serif" },
    { title: "Geometric Humanist", value: "Avenir, Montserrat, sans-serif" },
  ];

  /**
   * Simulates handleFontSelection receiving a value attribute from sp-menu change event (not
   * display text like sp-combobox).
   */
  function simulateMenuChange(
    /** @type {string} */ val,
    /** @type {{ title: string; value: string }[]} */ presets,
    /** @type {Record<string, string>} */ rootStyle,
  ) {
    if (!val) return "";
    // __preset__: prefix (from sp-menu-item value attribute)
    if (val.startsWith("__preset__:")) {
      const title = val.slice("__preset__:".length);
      const preset = presets.find((p) => p.title === title);
      if (preset) {
        const varName = friendlyNameToVar(preset.title, "--font-");
        if (!rootStyle[varName]) rootStyle[varName] = preset.value;
        return `var(${varName})`;
      }
      return "";
    }
    // CSS variable name (from sp-menu-item for existing font vars)
    if (val.startsWith("--")) {
      return `var(${val})`;
    }
    // Display text match (fallback for combobox text input)
    const preset = presets.find((p) => p.title === val);
    if (preset) {
      const varName = friendlyNameToVar(preset.title, "--font-");
      if (!rootStyle[varName]) rootStyle[varName] = preset.value;
      return `var(${varName})`;
    }
    return val;
  }

  test("__preset__: prefixed value creates variable and returns var()", () => {
    /** @type {Record<string, string>} */
    const rootStyle = {};
    const result = simulateMenuChange("__preset__:Geometric Humanist", PRESETS, rootStyle);

    expect(result).toBe("var(--font-geometric-humanist)");
    expect(rootStyle["--font-geometric-humanist"]).toBe("Avenir, Montserrat, sans-serif");
  });

  test("-- prefixed value (existing font var) returns var() directly", () => {
    /** @type {Record<string, string>} */
    const rootStyle = {};
    const result = simulateMenuChange("--font-system-ui", PRESETS, rootStyle);

    expect(result).toBe("var(--font-system-ui)");
    expect(Object.keys(rootStyle).length).toBe(0); // no new variable created
  });

  test("display text fallback still matches presets", () => {
    /** @type {Record<string, string>} */
    const rootStyle = {};
    const result = simulateMenuChange("System UI", PRESETS, rootStyle);

    expect(result).toBe("var(--font-system-ui)");
    expect(rootStyle["--font-system-ui"]).toBe("system-ui, sans-serif");
  });

  test("plain text passes through as-is", () => {
    /** @type {Record<string, string>} */
    const rootStyle = {};
    const result = simulateMenuChange("Georgia, serif", PRESETS, rootStyle);

    expect(result).toBe("Georgia, serif");
  });
});
