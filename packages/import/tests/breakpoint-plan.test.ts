import { describe, test, expect } from "bun:test";
import {
  DEFAULT_BREAKPOINT_POLICY,
  MAX_BREAKPOINTS,
  analyzeMediaQueries,
  breakpointName,
  parseWidthQuery,
  planBreakpoints,
} from "../src/breakpoint-plan.ts";
import type { Breakpoint } from "../src/breakpoint-plan.ts";

/** The nine widths a real import produced, in the order a crawl happened to merge them. */
const REAL_WORLD = [767, 960, 1024, 1025, 1390, 781, 782, 600, 520];

function discovered(widths: readonly number[], type: "min" | "max" = "max"): Breakpoint[] {
  return widths.map((width) => ({
    name: breakpointName(width),
    query: `(${type}-width: ${width}px)`,
    testWidth: width,
  }));
}

function keptWidths(plan: { keep: Breakpoint[] }): number[] {
  return plan.keep.map((bp) => bp.testWidth);
}

describe("parseWidthQuery", () => {
  test("reads a single-clause px min-width or max-width", () => {
    expect(parseWidthQuery("(min-width: 768px)")).toEqual({ type: "min", width: 768 });
    expect(parseWidthQuery("  ( max-width : 640px ) ")).toEqual({ type: "max", width: 640 });
  });

  test("refuses everything it cannot read exactly", () => {
    for (const query of [
      "(min-width: 48rem)",
      "(min-width: 768px) and (max-width: 1024px)",
      "screen and (min-width: 768px)",
      "(width >= 768px)",
      "(prefers-color-scheme: dark)",
    ]) {
      expect(parseWidthQuery(query)).toBeNull();
    }
  });
});

describe("planBreakpoints", () => {
  test("an empty discovery plans nothing", () => {
    const plan = planBreakpoints([]);
    expect(plan.keep).toEqual([]);
    expect(plan.fold.size).toBe(0);
  });

  test('mode "all" keeps every width, sorted', () => {
    const plan = planBreakpoints(discovered(REAL_WORLD), { mode: "all" });
    expect(keptWidths(plan)).toEqual([520, 600, 767, 781, 782, 960, 1024, 1025, 1390]);
  });

  test("the default limits nine real-world breakpoints to three", () => {
    const plan = planBreakpoints(discovered(REAL_WORLD), DEFAULT_BREAKPOINT_POLICY);
    expect(keptWidths(plan)).toEqual([520, 782, 1390]);
  });

  test("every discarded width folds into a kept one, and a kept one folds to itself", () => {
    const plan = planBreakpoints(discovered(REAL_WORLD), DEFAULT_BREAKPOINT_POLICY);
    expect(plan.fold.size).toBe(REAL_WORLD.length);
    expect(plan.fold.get("--782")).toBe("--782");
    expect(plan.fold.get("--767")).toBe("--782");
    expect(plan.fold.get("--600")).toBe("--520");
    // 1024 is 242px from 782 and 366px from 1390 — "nearest" means nearest, not "the next one up".
    expect(plan.fold.get("--1024")).toBe("--782");
    for (const target of plan.fold.values()) {
      expect(keptWidths(plan)).toContain(Number(target.replace("--", "")));
    }
  });

  test("a limit of one takes the median, not the narrowest", () => {
    const plan = planBreakpoints(discovered([400, 800, 1200]), {
      count: 1,
      mode: "limit",
      rounding: "nearest",
    });
    expect(keptWidths(plan)).toEqual([800]);
  });

  test("a limit at or above the discovered count keeps everything", () => {
    const plan = planBreakpoints(discovered([400, 800]), {
      count: 5,
      mode: "limit",
      rounding: "nearest",
    });
    expect(keptWidths(plan)).toEqual([400, 800]);
  });

  test("a limit is clamped to something a project can hold", () => {
    const wide = discovered(Array.from({ length: 30 }, (_, i) => 200 + i * 50));
    const plan = planBreakpoints(wide, { count: 99, mode: "limit", rounding: "nearest" });
    expect(plan.keep.length).toBe(MAX_BREAKPOINTS);
  });

  test("a limit of zero or nonsense still keeps one", () => {
    const plan = planBreakpoints(discovered([400, 800, 1200]), {
      count: 0,
      mode: "limit",
      rounding: "nearest",
    });
    expect(plan.keep).toHaveLength(1);
  });

  describe("rounding decides where a discarded width goes", () => {
    const three = discovered([400, 800, 1200]);
    const policy = (rounding: "nearest" | "down" | "up") => ({
      count: 2 as const,
      mode: "limit" as const,
      rounding,
    });

    test("nearest picks the closest kept width", () => {
      // Keeps 400 and 1200; 800 is equidistant, and a tie goes to the narrower.
      expect(planBreakpoints(three, policy("nearest")).fold.get("--800")).toBe("--400");
    });

    test("down picks the widest kept width at or below it", () => {
      expect(planBreakpoints(three, policy("down")).fold.get("--800")).toBe("--400");
    });

    test("up picks the narrowest kept width at or above it", () => {
      expect(planBreakpoints(three, policy("up")).fold.get("--800")).toBe("--1200");
    });

    test("down below the whole range still lands somewhere", () => {
      const plan = planBreakpoints(discovered([800, 1200]), {
        count: 1,
        mode: "limit",
        rounding: "down",
      });
      // Keeps 800; 1200 has nothing at or below it but 800, and must not be dropped.
      expect(plan.fold.get("--1200")).toBe("--800");
    });

    test("up above the whole range still lands somewhere", () => {
      const plan = planBreakpoints(discovered([800, 1200]), {
        count: 1,
        mode: "limit",
        rounding: "up",
      });
      expect(plan.fold.get("--800")).toBe("--800");
      expect(plan.fold.get("--1200")).toBe("--800");
    });
  });

  describe('mode "explicit"', () => {
    test("names the widths the author asked for, backed by the declared width nearest each", () => {
      const plan = planBreakpoints(discovered(REAL_WORLD), {
        mode: "explicit",
        rounding: "nearest",
        widths: [640, 1024, 1440],
      });
      expect(plan.keep.map((bp) => bp.name)).toEqual(["--640", "--1024", "--1440"]);
      // The QUERY is the author's width; the capture happens where the site's rules actually flip.
      expect(plan.keep.map((bp) => bp.query)).toEqual([
        "(max-width: 640px)",
        "(max-width: 1024px)",
        "(max-width: 1440px)",
      ]);
      expect(keptWidths(plan)).toEqual([600, 1024, 1390]);
    });

    test("rounding down never picks a declared width above the request", () => {
      const plan = planBreakpoints(discovered([600, 900, 1200]), {
        mode: "explicit",
        rounding: "down",
        widths: [1000],
      });
      expect(keptWidths(plan)).toEqual([900]);
      expect(plan.keep[0]!.name).toBe("--1000");
    });

    test("two requests landing on one declared width collapse into one breakpoint", () => {
      const plan = planBreakpoints(discovered([800]), {
        mode: "explicit",
        rounding: "nearest",
        widths: [780, 820],
      });
      expect(plan.keep).toHaveLength(1);
      expect(plan.keep[0]!.name).toBe("--780");
    });

    test("widths outside the plausible range are not breakpoints", () => {
      const plan = planBreakpoints(discovered([800]), {
        mode: "explicit",
        rounding: "nearest",
        widths: [4, 99_999],
      });
      expect(plan.keep).toEqual([]);
      expect(plan.fold.size).toBe(0);
    });

    test("an unreadable declared query keeps its own text rather than being rewritten", () => {
      const plan = planBreakpoints(
        [{ name: "--800", query: "not a width query", testWidth: 800 }],
        { mode: "explicit", rounding: "nearest", widths: [768] },
      );
      expect(plan.keep[0]!.query).toBe("not a width query");
    });
  });

  test("the plan is independent of the order widths were discovered in", () => {
    const shuffled = planBreakpoints(discovered(REAL_WORLD), DEFAULT_BREAKPOINT_POLICY);
    const sorted = planBreakpoints(
      discovered(REAL_WORLD.toSorted((a, b) => a - b)),
      DEFAULT_BREAKPOINT_POLICY,
    );
    expect(keptWidths(shuffled)).toEqual(keptWidths(sorted));
  });
});

describe("analyzeMediaQueries + planBreakpoints together", () => {
  test("nine declared queries become three project breakpoints", () => {
    const queries = REAL_WORLD.map((w) => `(max-width: ${w}px)`);
    const plan = planBreakpoints(analyzeMediaQueries(queries));
    expect(plan.keep.map((bp) => bp.name)).toEqual(["--520", "--782", "--1390"]);
  });
});
