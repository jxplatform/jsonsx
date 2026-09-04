import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { Page } from "puppeteer-core";
import type { CapturedStyle } from "../src/style-capture.ts";

const captureWidths: number[] = [];
let capturesByWidth = new Map<number, CapturedStyle[]>();

void mock.module("../src/style-capture.ts", () => ({
  captureStylesAtWidth: (_page: Page, width: number): Promise<CapturedStyle[]> => {
    captureWidths.push(width);
    return Promise.resolve(capturesByWidth.get(width) ?? []);
  },
}));

const { analyzeMediaQueries, extractMedia, skippedWidthQueries } =
  await import("../src/media-extract.ts");

function makePage(): { page: Page; viewports: { width: number; height: number }[] } {
  const viewports: { width: number; height: number }[] = [];
  const page = {
    setViewport(viewport: { width: number; height: number }) {
      viewports.push(viewport);
      return Promise.resolve();
    },
  } as unknown as Page;
  return { page, viewports };
}

/**
 * Register both in-band samples for one breakpoint with the SAME styles - a value the site
 * authored, which does not move when the viewport does inside the band.
 */
function authored(testWidth: number, direction: "max" | "min", styles: CapturedStyle[]): void {
  capturesByWidth.set(testWidth, styles);
  capturesByWidth.set(testWidth + (direction === "min" ? 40 : -40), styles);
}

beforeEach(() => {
  captureWidths.length = 0;
  capturesByWidth = new Map();
});

describe("analyzeMediaQueries", () => {
  test("parses simple max-width queries", () => {
    const queries = ["(max-width: 768px)", "(max-width: 640px)"];
    const result = analyzeMediaQueries(queries);

    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("--640");
    expect(result[0]!.testWidth).toBe(640);
    expect(result[1]!.name).toBe("--768");
    expect(result[1]!.testWidth).toBe(768);
  });

  test("parses simple min-width queries", () => {
    const queries = ["(min-width: 1024px)", "(min-width: 768px)"];
    const result = analyzeMediaQueries(queries);

    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("--768");
    expect(result[1]!.name).toBe("--1024");
  });

  test("deduplicates same width", () => {
    const queries = ["(max-width: 768px)", "(min-width: 768px)"];
    const result = analyzeMediaQueries(queries);

    expect(result).toHaveLength(1);
    expect(result[0]!.testWidth).toBe(768);
  });

  test("skips complex / non-size queries", () => {
    const queries = [
      "(prefers-color-scheme: dark)",
      "(hover: hover)",
      "(orientation: landscape)",
      "(max-width: 640px)",
      "(min-width: 1024px) and (max-width: 1440px)",
    ];
    const result = analyzeMediaQueries(queries);

    expect(result).toHaveLength(1);
    expect(result[0]!.testWidth).toBe(640);
  });

  test("returns empty for no size queries", () => {
    const queries = ["(prefers-color-scheme: dark)", "(hover: hover)"];
    const result = analyzeMediaQueries(queries);

    expect(result).toHaveLength(0);
  });

  test("sorts by width ascending", () => {
    const queries = ["(max-width: 1200px)", "(max-width: 480px)", "(max-width: 768px)"];
    const result = analyzeMediaQueries(queries);

    expect(result.map((b) => b.testWidth)).toEqual([480, 768, 1200]);
  });
});

describe("skippedWidthQueries", () => {
  test("names the width queries the parser cannot read", () => {
    expect(
      skippedWidthQueries([
        "(max-width: 640px)",
        "(min-width: 48rem)",
        "(min-width: 1024px) and (max-width: 1440px)",
        "(width >= 768px)",
      ]),
    ).toEqual([
      "(min-width: 48rem)",
      "(min-width: 1024px) and (max-width: 1440px)",
      "(width >= 768px)",
    ]);
  });

  test("stays quiet about queries that are not about width at all", () => {
    expect(
      skippedWidthQueries(["(prefers-color-scheme: dark)", "(hover: hover)", "print"]),
    ).toEqual([]);
  });

  test("deduplicates", () => {
    expect(skippedWidthQueries(["(min-width: 48rem)", "(min-width: 48rem)"])).toHaveLength(1);
  });
});

describe("extractMedia", () => {
  const uaDefaults = { div: { display: "block" } };

  test("returns empty result without touching the page when no width queries exist", async () => {
    const { page, viewports } = makePage();

    const result = await extractMedia(page, [], uaDefaults, ["(hover: hover)"]);

    expect(result).toEqual({ breakpoints: {}, deltas: {} });
    expect(captureWidths).toHaveLength(0);
    expect(viewports).toHaveLength(0);
  });

  test("captures deltas per breakpoint and drops breakpoints with no changes", async () => {
    const base: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { width: "800px", display: "flex" } },
    ];
    authored(768, "max", [
      { path: [0], tagName: "div", styles: { width: "400px", display: "flex" } },
    ]);
    authored(1024, "min", base);
    const { page, viewports } = makePage();

    const result = await extractMedia(
      page,
      base,
      uaDefaults,
      ["(max-width: 768px)", "(min-width: 1024px)"],
      { policy: { mode: "all" } },
    );

    expect(captureWidths).toEqual([768, 728, 1024, 1064]);
    expect(result.breakpoints).toEqual({ "--768": "(max-width: 768px)" });
    expect(result.deltas["--768"]).toEqual([{ path: [0], style: { width: "400px" } }]);
    expect(result.deltas["--1024"]).toBeUndefined();
    expect(viewports).toEqual([{ width: 1440, height: 900 }]);
  });

  test("limits to three breakpoints by default, and captures only those", async () => {
    const base: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { width: "800px", display: "flex" } },
    ];
    const narrow = [{ path: [0], tagName: "div", styles: { width: "400px", display: "flex" } }];
    authored(520, "max", narrow);
    authored(782, "min", narrow);
    authored(1390, "min", narrow);
    const { page } = makePage();

    const result = await extractMedia(page, base, uaDefaults, [
      "(max-width: 520px)",
      "(min-width: 600px)",
      "(max-width: 767px)",
      "(max-width: 781px)",
      "(min-width: 782px)",
      "(min-width: 960px)",
      "(max-width: 1024px)",
      "(min-width: 1025px)",
      "(min-width: 1390px)",
    ]);

    // The narrowest, the middle one and the widest — and no viewport pass for the other six.
    expect(captureWidths).toEqual([520, 480, 782, 822, 1390, 1430]);
    expect(Object.keys(result.breakpoints)).toEqual(["--520", "--782", "--1390"]);
  });

  test("uses a caller-supplied plan verbatim, ignoring this page's own queries", async () => {
    const base: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { width: "800px", display: "flex" } },
    ];
    authored(900, "min", [
      { path: [0], tagName: "div", styles: { width: "500px", display: "flex" } },
    ]);
    const { page } = makePage();

    const result = await extractMedia(page, base, uaDefaults, ["(max-width: 480px)"], {
      plan: [{ name: "--wide", query: "(min-width: 900px)", testWidth: 900 }],
    });

    expect(captureWidths).toEqual([900, 940]);
    expect(result.breakpoints).toEqual({ "--wide": "(min-width: 900px)" });
  });

  test("restores a custom original viewport width", async () => {
    const base: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { width: "600px", display: "flex" } },
    ];
    authored(480, "max", [
      { path: [0], tagName: "div", styles: { width: "300px", display: "flex" } },
    ]);
    const { page, viewports } = makePage();

    const result = await extractMedia(page, base, uaDefaults, ["(max-width: 480px)"], {
      originalWidth: 1280,
    });

    expect(result.breakpoints).toEqual({ "--480": "(max-width: 480px)" });
    expect(viewports).toEqual([{ width: 1280, height: 900 }]);
  });
  test("drops a value that moves with the viewport inside its own band", async () => {
    /* The defect this exists for: `getComputedStyle` returns USED values, so a fluid element
       reports the pixels it happens to occupy. Diffing one sample against the base called that a
       responsive change, and two thirds of a real import's breakpoint declarations turned out to be
       the viewport's own width written back as the element's - pinning the layout it was meant to
       describe. Measured twice in the band, a resolved value disagrees with itself. */
    const base: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { width: "1440px", display: "flex" } },
    ];
    capturesByWidth.set(767, [
      { path: [0], tagName: "div", styles: { width: "767px", display: "flex" } },
    ]);
    capturesByWidth.set(727, [
      { path: [0], tagName: "div", styles: { width: "727px", display: "flex" } },
    ]);
    const { page } = makePage();

    const result = await extractMedia(page, base, uaDefaults, ["(max-width: 767px)"]);

    expect(result.breakpoints).toEqual({});
    expect(result.deltas["--767"]).toBeUndefined();
  });

  test("keeps real intent that sits beside a viewport-derived value", async () => {
    const base: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { width: "1440px", "flex-direction": "row" } },
    ];
    capturesByWidth.set(767, [
      { path: [0], tagName: "div", styles: { width: "767px", "flex-direction": "column" } },
    ]);
    capturesByWidth.set(727, [
      { path: [0], tagName: "div", styles: { width: "727px", "flex-direction": "column" } },
    ]);
    const { page } = makePage();

    const result = await extractMedia(page, base, uaDefaults, ["(max-width: 767px)"]);

    // The stacking survives; the measurement it was buried in does not.
    expect(result.deltas["--767"]).toEqual([{ path: [0], style: { flexDirection: "column" } }]);
  });

  test("samples upward inside a min-width band and downward inside a max-width band", async () => {
    const base: CapturedStyle[] = [{ path: [0], tagName: "div", styles: { display: "flex" } }];
    authored(600, "max", base);
    authored(900, "min", base);
    const { page } = makePage();

    await extractMedia(page, base, uaDefaults, ["(max-width: 600px)", "(min-width: 900px)"], {
      policy: { mode: "all" },
    });

    // Leaving the band would measure the very rules the breakpoint exists to distinguish itself from.
    expect(captureWidths).toEqual([600, 560, 900, 940]);
  });
});
