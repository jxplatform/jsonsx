import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { activeBreakpointsForWidth, parseMediaEntries } from "../src/utils/canvas-media";

// ─── parseMediaEntries ──────────────────────────────────────────────────────

describe("parseMediaEntries", () => {
  test("returns defaults for null/undefined input", () => {
    expect(parseMediaEntries(null)).toEqual({
      baseWidth: 320,
      featureQueries: [],
      sizeBreakpoints: [],
    });
    expect(parseMediaEntries()).toEqual({
      baseWidth: 320,
      featureQueries: [],
      sizeBreakpoints: [],
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
      type: "max",
      width: 1024,
    });
    expect(result.sizeBreakpoints[1]).toEqual({
      name: "--md",
      query: "(max-width: 768px)",
      type: "max",
      width: 768,
    });
    expect(result.sizeBreakpoints[2]).toEqual({
      name: "--sm",
      query: "(max-width: 640px)",
      type: "max",
      width: 640,
    });
  });

  test("classifies min-width entries as size breakpoints", () => {
    const result = parseMediaEntries({
      "--": "320px",
      "--lg": "(min-width: 1024px)",
      "--md": "(min-width: 768px)",
    });
    expect(result.sizeBreakpoints).toHaveLength(2);
    expect(result.sizeBreakpoints[0]!.name).toBe("--md");
    expect(result.sizeBreakpoints[0]!.type).toBe("min");
    expect(result.sizeBreakpoints[1]!.name).toBe("--lg");
  });

  test("sorts max-width breakpoints from largest to smallest", () => {
    const result = parseMediaEntries({
      "--lg": "(max-width: 1024px)",
      "--md": "(max-width: 768px)",
      "--sm": "(max-width: 640px)",
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
    expect(result.sizeBreakpoints[0]!.width).toBe(479.5);
  });
});

// ─── activeBreakpointsForWidth ────────────────────────────────────────────────

describe("activeBreakpointsForWidth", () => {
  const maxWidthBreakpoints = [
    { name: "--lg", query: "(max-width: 1024px)", type: "max", width: 1024 },
    { name: "--md", query: "(max-width: 768px)", type: "max", width: 768 },
    { name: "--sm", query: "(max-width: 640px)", type: "max", width: 640 },
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
      { name: "--md", query: "(min-width: 768px)", type: "min", width: 768 },
      { name: "--lg", query: "(min-width: 1024px)", type: "min", width: 1024 },
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
});
