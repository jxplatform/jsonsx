import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  activeBreakpointsForWidth,
  isSchemeQuery,
  mediaForWidth,
  parseMediaEntries,
  schemeOfQuery,
  snapEditWidth,
} from "../src/utils/canvas-media";

// ─── Scheme-query classification ────────────────────────────────────────────

describe("isSchemeQuery / schemeOfQuery", () => {
  test("recognizes pure prefers-color-scheme queries", () => {
    expect(isSchemeQuery("(prefers-color-scheme: dark)")).toBe(true);
    expect(schemeOfQuery("(prefers-color-scheme: dark)")).toBe("dark");
    expect(schemeOfQuery("(prefers-color-scheme: light)")).toBe("light");
  });

  test("rejects compound and non-scheme queries", () => {
    expect(isSchemeQuery("(prefers-color-scheme: dark) and (min-width: 768px)")).toBe(false);
    expect(isSchemeQuery("(prefers-reduced-motion: reduce)")).toBe(false);
    expect(schemeOfQuery("(min-width: 768px)")).toBeNull();
  });
});

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

// ─── mediaForWidth ────────────────────────────────────────────────────────────

describe("mediaForWidth", () => {
  // What `packages/create/templates.ts` ships as DESKTOP_FIRST_MEDIA, and what all 12 starters use.
  const desktopFirst = [
    { name: "--lg", query: "(max-width: 1024px)", type: "max", width: 1024 },
    { name: "--md", query: "(max-width: 768px)", type: "max", width: 768 },
    { name: "--sm", query: "(max-width: 640px)", type: "max", width: 640 },
  ];
  // MOBILE_FIRST_MEDIA, in the order parseMediaEntries sorts `min` entries into.
  const mobileFirst = [
    { name: "--sm", query: "(min-width: 640px)", type: "min", width: 640 },
    { name: "--md", query: "(min-width: 768px)", type: "min", width: 768 },
    { name: "--lg", query: "(min-width: 1024px)", type: "min", width: 1024 },
  ];

  test("desktop-first: a width wider than every max-width query is Base", () => {
    expect(mediaForWidth(desktopFirst, 1200)).toBeNull();
    expect(mediaForWidth(desktopFirst, 1025)).toBeNull();
  });

  test("desktop-first: picks the NARROWEST matching band, not merely a matching one", () => {
    // 700 satisfies both --lg (≤1024) and --md (≤768); --md is the band being looked at.
    expect(mediaForWidth(desktopFirst, 700)).toBe("--md");
    expect(mediaForWidth(desktopFirst, 900)).toBe("--lg");
    expect(mediaForWidth(desktopFirst, 500)).toBe("--sm");
  });

  test("desktop-first: an exact declared width lands on that breakpoint", () => {
    expect(mediaForWidth(desktopFirst, 1024)).toBe("--lg");
    expect(mediaForWidth(desktopFirst, 768)).toBe("--md");
    expect(mediaForWidth(desktopFirst, 640)).toBe("--sm");
  });

  test("mobile-first: a width below every min-width query is Base", () => {
    expect(mediaForWidth(mobileFirst, 375)).toBeNull();
    expect(mediaForWidth(mobileFirst, 639)).toBeNull();
  });

  test("mobile-first: picks the WIDEST matching band", () => {
    // 900 satisfies --sm (≥640) and --md (≥768); --md is the band.
    expect(mediaForWidth(mobileFirst, 900)).toBe("--md");
    expect(mediaForWidth(mobileFirst, 1400)).toBe("--lg");
    expect(mediaForWidth(mobileFirst, 700)).toBe("--sm");
  });

  test("a mixed min/max project resolves by distance, not by the array's order", () => {
    /* `parseMediaEntries` decides its whole sort from the FIRST entry's `type`, so a project mixing
       the two shapes is ordered arbitrarily. Distance does not read the order at all: at 800 the
       `min: 768` entry is 32 away and the `max: 1024` one is 224, so the tighter band wins whichever
       way the array happens to be arranged. */
    const mixed = [
      { name: "--wide", query: "(max-width: 1024px)", type: "max", width: 1024 },
      { name: "--tablet", query: "(min-width: 768px)", type: "min", width: 768 },
    ];
    expect(mediaForWidth(mixed, 800)).toBe("--tablet");
    expect(mediaForWidth(mixed.toReversed(), 800)).toBe("--tablet");
  });

  test("a tie resolves to the narrower entry", () => {
    // 800 is 32px from both; the tighter constraint is the one an author is checking.
    const equidistant = [
      { name: "--upper", query: "(max-width: 832px)", type: "max", width: 832 },
      { name: "--lower", query: "(min-width: 768px)", type: "min", width: 768 },
    ];
    expect(mediaForWidth(equidistant, 800)).toBe("--lower");
    expect(mediaForWidth(equidistant.toReversed(), 800)).toBe("--lower");
  });

  test("a document declaring no size breakpoints is always Base", () => {
    expect(mediaForWidth([], 768)).toBeNull();
  });
});

// ─── snapEditWidth ────────────────────────────────────────────────────────────

describe("snapEditWidth", () => {
  const targets = [640, 768, 1024, 1200];

  test("pulls onto a target inside the tolerance", () => {
    expect(snapEditWidth(765, targets)).toBe(768);
    expect(snapEditWidth(774, targets)).toBe(768);
    expect(snapEditWidth(1200, targets)).toBe(1200);
  });

  test("leaves a width outside the tolerance exactly where it is", () => {
    expect(snapEditWidth(700, targets)).toBe(700);
    expect(snapEditWidth(777, targets)).toBe(777);
  });

  test("the tolerance is inclusive at its edge", () => {
    expect(snapEditWidth(776, targets)).toBe(768);
    expect(snapEditWidth(760, targets)).toBe(768);
  });

  test("picks the nearest target when two are in range", () => {
    expect(snapEditWidth(645, [640, 648])).toBe(648);
    expect(snapEditWidth(643, [640, 648])).toBe(640);
  });

  test("an explicit tolerance is honoured, and zero snaps only on an exact hit", () => {
    // 640 is 60px away and 768 is 68px; a wider tolerance still picks the NEAREST, not the first.
    expect(snapEditWidth(700, targets, 80)).toBe(640);
    expect(snapEditWidth(740, targets, 80)).toBe(768);
    expect(snapEditWidth(769, targets, 0)).toBe(769);
    expect(snapEditWidth(768, targets, 0)).toBe(768);
  });

  test("no targets is identity", () => {
    expect(snapEditWidth(742, [])).toBe(742);
  });
});
