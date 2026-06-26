import { describe, test, expect } from "bun:test";
import { analyzeMediaQueries } from "../src/media-extract.ts";

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
