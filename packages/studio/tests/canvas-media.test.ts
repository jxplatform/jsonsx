import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import {
  parseMediaEntries,
  activeBreakpointsForWidth,
  applyCanvasStyle,
  applyOverridesToCanvas,
} from "../src/utils/canvas-media";

// ─── parseMediaEntries ──────────────────────────────────────────────────────

describe("parseMediaEntries", () => {
  test("returns defaults for null/undefined input", () => {
    expect(parseMediaEntries(null)).toEqual({
      sizeBreakpoints: [],
      featureQueries: [],
      baseWidth: 320,
    });
    expect(parseMediaEntries(undefined)).toEqual({
      sizeBreakpoints: [],
      featureQueries: [],
      baseWidth: 320,
    });
  });

  test("extracts base width from -- entry", () => {
    const result = parseMediaEntries({ "--": "1280px" });
    expect(result.baseWidth).toBe(1280);
    expect(result.sizeBreakpoints).toEqual([]);
  });

  test("classifies max-width entries as size breakpoints", () => {
    const result = parseMediaEntries({
      "--": "1280px",
      "--lg": "(max-width: 1024px)",
      "--md": "(max-width: 768px)",
      "--sm": "(max-width: 640px)",
    });
    expect(result.baseWidth).toBe(1280);
    expect(result.sizeBreakpoints).toHaveLength(3);
    expect(result.sizeBreakpoints[0]).toEqual({
      name: "--lg",
      query: "(max-width: 1024px)",
      width: 1024,
      type: "max",
    });
    expect(result.sizeBreakpoints[1]).toEqual({
      name: "--md",
      query: "(max-width: 768px)",
      width: 768,
      type: "max",
    });
    expect(result.sizeBreakpoints[2]).toEqual({
      name: "--sm",
      query: "(max-width: 640px)",
      width: 640,
      type: "max",
    });
  });

  test("classifies min-width entries as size breakpoints", () => {
    const result = parseMediaEntries({
      "--": "320px",
      "--md": "(min-width: 768px)",
      "--lg": "(min-width: 1024px)",
    });
    expect(result.sizeBreakpoints).toHaveLength(2);
    expect(result.sizeBreakpoints[0].name).toBe("--md");
    expect(result.sizeBreakpoints[0].type).toBe("min");
    expect(result.sizeBreakpoints[1].name).toBe("--lg");
  });

  test("sorts max-width breakpoints from largest to smallest", () => {
    const result = parseMediaEntries({
      "--sm": "(max-width: 640px)",
      "--lg": "(max-width: 1024px)",
      "--md": "(max-width: 768px)",
    });
    expect(result.sizeBreakpoints.map((b) => b.name)).toEqual(["--lg", "--md", "--sm"]);
  });

  test("sorts min-width breakpoints from smallest to largest", () => {
    const result = parseMediaEntries({
      "--lg": "(min-width: 1024px)",
      "--md": "(min-width: 768px)",
    });
    expect(result.sizeBreakpoints.map((b) => b.name)).toEqual(["--md", "--lg"]);
  });

  test("classifies non-size queries as feature queries", () => {
    const result = parseMediaEntries({
      "--": "1280px",
      "--dark": "(prefers-color-scheme: dark)",
      "--md": "(max-width: 768px)",
    });
    expect(result.featureQueries).toEqual([
      { name: "--dark", query: "(prefers-color-scheme: dark)" },
    ]);
    expect(result.sizeBreakpoints).toHaveLength(1);
  });

  test("handles fractional pixel values", () => {
    const result = parseMediaEntries({ "--xs": "(max-width: 479.5px)" });
    expect(result.sizeBreakpoints[0].width).toBe(479.5);
  });
});

// ─── activeBreakpointsForWidth ────────────────────────────────────────────────

describe("activeBreakpointsForWidth", () => {
  const maxWidthBreakpoints = [
    { name: "--lg", query: "(max-width: 1024px)", width: 1024, type: "max" },
    { name: "--md", query: "(max-width: 768px)", width: 768, type: "max" },
    { name: "--sm", query: "(max-width: 640px)", width: 640, type: "max" },
  ];

  test("no breakpoints active at base width (wider than all)", () => {
    const active = activeBreakpointsForWidth(maxWidthBreakpoints, 1280);
    expect(active.size).toBe(0);
  });

  test("lg active at 1024px (exact match)", () => {
    const active = activeBreakpointsForWidth(maxWidthBreakpoints, 1024);
    expect(active.has("--lg")).toBe(true);
    expect(active.has("--md")).toBe(false);
    expect(active.has("--sm")).toBe(false);
  });

  test("lg and md active at 768px", () => {
    const active = activeBreakpointsForWidth(maxWidthBreakpoints, 768);
    expect(active.has("--lg")).toBe(true);
    expect(active.has("--md")).toBe(true);
    expect(active.has("--sm")).toBe(false);
  });

  test("all breakpoints active at 640px (smallest)", () => {
    const active = activeBreakpointsForWidth(maxWidthBreakpoints, 640);
    expect(active.has("--lg")).toBe(true);
    expect(active.has("--md")).toBe(true);
    expect(active.has("--sm")).toBe(true);
  });

  test("all breakpoints active below smallest", () => {
    const active = activeBreakpointsForWidth(maxWidthBreakpoints, 320);
    expect(active.size).toBe(3);
  });

  test("min-width breakpoints activate at or above threshold", () => {
    const minWidthBreakpoints = [
      { name: "--md", query: "(min-width: 768px)", width: 768, type: "min" },
      { name: "--lg", query: "(min-width: 1024px)", width: 1024, type: "min" },
    ];
    expect(activeBreakpointsForWidth(minWidthBreakpoints, 320).size).toBe(0);
    expect(activeBreakpointsForWidth(minWidthBreakpoints, 768).has("--md")).toBe(true);
    expect(activeBreakpointsForWidth(minWidthBreakpoints, 768).has("--lg")).toBe(false);
    expect(activeBreakpointsForWidth(minWidthBreakpoints, 1024).size).toBe(2);
  });

  test("returns empty set for empty breakpoints array", () => {
    const active = activeBreakpointsForWidth([], 1024);
    expect(active.size).toBe(0);
  });
});

// ─── applyCanvasStyle ─────────────────────────────────────────────────────────

describe("applyCanvasStyle", () => {
  test("applies base styles to element", () => {
    const el = document.createElement("div");
    applyCanvasStyle(el, { display: "grid", gap: "2rem" }, new Set(), {});
    expect(el.style.display).toBe("grid");
    expect(el.style.gap).toBe("2rem");
  });

  test("applies CSS custom properties via setProperty", () => {
    const el = document.createElement("div");
    applyCanvasStyle(el, { "--color": "red", "--spacing": "8px" }, new Set(), {});
    expect(el.style.getPropertyValue("--color")).toBe("red");
    expect(el.style.getPropertyValue("--spacing")).toBe("8px");
  });

  test("applies media override when breakpoint is active", () => {
    const el = document.createElement("div");
    const style = {
      gridTemplateColumns: "1fr 1fr 1fr",
      "@--md": { gridTemplateColumns: "1fr" },
    };
    applyCanvasStyle(el, style, new Set(["--md"]), {});
    expect(el.style.gridTemplateColumns).toBe("1fr");
  });

  test("does NOT apply media override when breakpoint is inactive", () => {
    const el = document.createElement("div");
    const style = {
      gridTemplateColumns: "1fr 1fr 1fr",
      "@--md": { gridTemplateColumns: "1fr" },
    };
    applyCanvasStyle(el, style, new Set(), {});
    expect(el.style.gridTemplateColumns).toBe("1fr 1fr 1fr");
  });

  test("applies feature toggle override", () => {
    const el = document.createElement("div");
    const style = {
      backgroundColor: "white",
      "@--dark": { backgroundColor: "black" },
    };
    applyCanvasStyle(el, style, new Set(), { "--dark": true });
    expect(el.style.backgroundColor).toBe("black");
  });

  test("does NOT apply feature toggle when toggle is off", () => {
    const el = document.createElement("div");
    const style = {
      backgroundColor: "white",
      "@--dark": { backgroundColor: "black" },
    };
    applyCanvasStyle(el, style, new Set(), { "--dark": false });
    expect(el.style.backgroundColor).toBe("white");
  });

  test("media override beats base style (last-write-wins)", () => {
    const el = document.createElement("div");
    const style = {
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: "2rem",
      "@--md": { gridTemplateColumns: "1fr" },
      "@--sm": { gap: "1rem" },
    };
    applyCanvasStyle(el, style, new Set(["--md", "--sm"]), {});
    expect(el.style.gridTemplateColumns).toBe("1fr");
    expect(el.style.gap).toBe("1rem");
    expect(el.style.display).toBe("grid");
  });

  test("skips null/undefined style defs gracefully", () => {
    const el = document.createElement("div");
    applyCanvasStyle(el, /** @type {any} */ null, new Set(), {});
    applyCanvasStyle(el, /** @type {any} */ undefined, new Set(), {});
    expect(el.style.length).toBe(0);
  });

  test("ignores @-- key (base width marker)", () => {
    const el = document.createElement("div");
    const style = {
      color: "red",
      "@--": { color: "blue" },
    };
    applyCanvasStyle(el, style, new Set(["--"]), {});
    expect(el.style.color).toBe("red");
  });
});

// ─── applyOverridesToCanvas ───────────────────────────────────────────────────

describe("applyOverridesToCanvas", () => {
  test("applies override properties to matching data-jx elements", () => {
    const canvas = document.createElement("div");
    const child = document.createElement("div");
    child.setAttribute("data-jx", "jx-abc12");
    child.style.gridTemplateColumns = "1fr 1fr 1fr";
    canvas.appendChild(child);

    const overrides = new Map();
    overrides.set("jx-abc12", new Map([["grid-template-columns", "1fr"]]));

    applyOverridesToCanvas(canvas, overrides);
    expect(child.style.getPropertyValue("grid-template-columns")).toBe("1fr");
  });

  test("applies overrides to multiple elements with same data-jx", () => {
    const canvas = document.createElement("div");
    const el1 = document.createElement("div");
    const el2 = document.createElement("div");
    el1.setAttribute("data-jx", "jx-same1");
    el2.setAttribute("data-jx", "jx-same1");
    canvas.appendChild(el1);
    canvas.appendChild(el2);

    const overrides = new Map();
    overrides.set("jx-same1", new Map([["color", "red"]]));

    applyOverridesToCanvas(canvas, overrides);
    expect(el1.style.color).toBe("red");
    expect(el2.style.color).toBe("red");
  });

  test("does not affect elements without matching data-jx", () => {
    const canvas = document.createElement("div");
    const el = document.createElement("div");
    el.setAttribute("data-jx", "jx-other");
    el.style.color = "blue";
    canvas.appendChild(el);

    const overrides = new Map();
    overrides.set("jx-nomatch", new Map([["color", "red"]]));

    applyOverridesToCanvas(canvas, overrides);
    expect(el.style.color).toBe("blue");
  });

  test("applies multiple properties from one override entry", () => {
    const canvas = document.createElement("div");
    const el = document.createElement("div");
    el.setAttribute("data-jx", "jx-multi");
    canvas.appendChild(el);

    const overrides = new Map();
    overrides.set(
      "jx-multi",
      new Map([
        ["grid-template-columns", "1fr"],
        ["gap", "1rem"],
        ["padding", "0.5rem"],
      ]),
    );

    applyOverridesToCanvas(canvas, overrides);
    expect(el.style.getPropertyValue("grid-template-columns")).toBe("1fr");
    expect(el.style.getPropertyValue("gap")).toBe("1rem");
    expect(el.style.getPropertyValue("padding")).toBe("0.5rem");
  });

  test("handles empty overrides map gracefully", () => {
    const canvas = document.createElement("div");
    const el = document.createElement("div");
    el.setAttribute("data-jx", "jx-test1");
    el.style.color = "blue";
    canvas.appendChild(el);

    applyOverridesToCanvas(canvas, new Map());
    expect(el.style.color).toBe("blue");
  });

  test("scopes to elements within canvasEl only", () => {
    const canvas = document.createElement("div");
    const outside = document.createElement("div");
    outside.setAttribute("data-jx", "jx-out1");
    outside.style.color = "blue";
    document.body.appendChild(outside);

    const overrides = new Map();
    overrides.set("jx-out1", new Map([["color", "red"]]));

    applyOverridesToCanvas(canvas, overrides);
    expect(outside.style.color).toBe("blue");

    outside.remove();
  });
});

// ─── Integration: parseMediaEntries + activeBreakpointsForWidth ────────────────

describe("parseMediaEntries + activeBreakpointsForWidth integration", () => {
  const burntRockMedia = {
    "--": "1280px",
    "--lg": "(max-width: 1024px)",
    "--md": "(max-width: 768px)",
    "--sm": "(max-width: 640px)",
  };

  test("base canvas (1280px) has no active breakpoints", () => {
    const { sizeBreakpoints, baseWidth } = parseMediaEntries(burntRockMedia);
    expect(baseWidth).toBe(1280);
    const active = activeBreakpointsForWidth(sizeBreakpoints, 1280);
    expect(active.size).toBe(0);
  });

  test("Lg canvas (1024px) activates --lg only", () => {
    const { sizeBreakpoints } = parseMediaEntries(burntRockMedia);
    const active = activeBreakpointsForWidth(sizeBreakpoints, 1024);
    expect(active.has("--lg")).toBe(true);
    expect(active.has("--md")).toBe(false);
    expect(active.has("--sm")).toBe(false);
  });

  test("Md canvas (768px) activates --lg and --md", () => {
    const { sizeBreakpoints } = parseMediaEntries(burntRockMedia);
    const active = activeBreakpointsForWidth(sizeBreakpoints, 768);
    expect(active.has("--lg")).toBe(true);
    expect(active.has("--md")).toBe(true);
    expect(active.has("--sm")).toBe(false);
  });

  test("Sm canvas (640px) activates all breakpoints", () => {
    const { sizeBreakpoints } = parseMediaEntries(burntRockMedia);
    const active = activeBreakpointsForWidth(sizeBreakpoints, 640);
    expect(active.has("--lg")).toBe(true);
    expect(active.has("--md")).toBe(true);
    expect(active.has("--sm")).toBe(true);
  });

  test("services grid renders 3 columns on Base, 1 column on Md", () => {
    const { sizeBreakpoints } = parseMediaEntries(burntRockMedia);
    const servicesStyle = {
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: "2rem",
      "@--md": { gridTemplateColumns: "1fr" },
    };

    // Base canvas
    const baseEl = document.createElement("div");
    const baseActive = activeBreakpointsForWidth(sizeBreakpoints, 1280);
    applyCanvasStyle(baseEl, servicesStyle, baseActive, {});
    expect(baseEl.style.gridTemplateColumns).toBe("1fr 1fr 1fr");

    // Md canvas
    const mdEl = document.createElement("div");
    const mdActive = activeBreakpointsForWidth(sizeBreakpoints, 768);
    applyCanvasStyle(mdEl, servicesStyle, mdActive, {});
    expect(mdEl.style.gridTemplateColumns).toBe("1fr");

    // Sm canvas (inherits --md since sm <= md threshold)
    const smEl = document.createElement("div");
    const smActive = activeBreakpointsForWidth(sizeBreakpoints, 640);
    applyCanvasStyle(smEl, servicesStyle, smActive, {});
    expect(smEl.style.gridTemplateColumns).toBe("1fr");
  });
});
