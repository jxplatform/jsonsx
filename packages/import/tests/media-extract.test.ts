import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { Page } from "puppeteer-core";
import type { CapturedStyle } from "../src/style-capture.ts";

const captureWidths: number[] = [];
let capturesByWidth = new Map<number, CapturedStyle[]>();

mock.module("../src/style-capture.ts", () => ({
  captureStylesAtWidth: (_page: Page, width: number): Promise<CapturedStyle[]> => {
    captureWidths.push(width);
    return Promise.resolve(capturesByWidth.get(width) ?? []);
  },
}));

const { analyzeMediaQueries, extractMedia } = await import("../src/media-extract.ts");

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
    capturesByWidth = new Map([
      [768, [{ path: [0], tagName: "div", styles: { width: "400px", display: "flex" } }]],
      [1024, base],
    ]);
    const { page, viewports } = makePage();

    const result = await extractMedia(page, base, uaDefaults, [
      "(max-width: 768px)",
      "(min-width: 1024px)",
    ]);

    expect(captureWidths).toEqual([768, 1024]);
    expect(result.breakpoints).toEqual({ "--768": "(max-width: 768px)" });
    expect(result.deltas["--768"]).toEqual([{ path: [0], style: { width: "400px" } }]);
    expect(result.deltas["--1024"]).toBeUndefined();
    expect(viewports).toEqual([{ width: 1440, height: 900 }]);
  });

  test("restores a custom original viewport width", async () => {
    const base: CapturedStyle[] = [
      { path: [0], tagName: "div", styles: { width: "600px", display: "flex" } },
    ];
    capturesByWidth = new Map([
      [480, [{ path: [0], tagName: "div", styles: { width: "300px", display: "flex" } }]],
    ]);
    const { page, viewports } = makePage();

    const result = await extractMedia(page, base, uaDefaults, ["(max-width: 480px)"], 1280);

    expect(result.breakpoints).toEqual({ "--480": "(max-width: 480px)" });
    expect(viewports).toEqual([{ width: 1280, height: 900 }]);
  });
});
