import { describe, test, expect } from "bun:test";
import { applyTokens } from "../src/css-tokens.ts";
import type { DiffedStyle } from "../src/style-diff.ts";

describe("applyTokens", () => {
  test("returns empty result when no custom properties exist", () => {
    const diffed: DiffedStyle[] = [{ path: [0], style: { color: "rgb(59, 130, 246)" } }];

    const result = applyTokens(diffed, {});

    expect(result.tokens).toEqual({});
    expect(result.replacements).toBe(0);
    expect(diffed[0]!.style.color).toBe("rgb(59, 130, 246)");
  });

  test("replaces matching values with var() refs and hoists used tokens", () => {
    const diffed: DiffedStyle[] = [
      { path: [0], style: { color: "rgb(59, 130, 246)", padding: "16px" } },
      { path: [0, 1], style: { backgroundColor: "rgb(59, 130, 246)" } },
    ];

    const result = applyTokens(diffed, {
      "--brand": "rgb(59, 130, 246)",
      "--space-4": "16px",
      "--unused": "rgb(0, 0, 0)",
    });

    expect(diffed[0]!.style.color).toBe("var(--brand)");
    expect(diffed[0]!.style.padding).toBe("var(--space-4)");
    expect(diffed[1]!.style.backgroundColor).toBe("var(--brand)");
    expect(result.replacements).toBe(3);
    expect(result.tokens).toEqual({
      "--brand": "rgb(59, 130, 246)",
      "--space-4": "16px",
    });
  });

  test("normalizes comma spacing, trailing semicolons, and extra whitespace", () => {
    const diffed: DiffedStyle[] = [
      { path: [0], style: { color: "rgb(1,  2,3)", borderColor: " rgb(4, 5, 6) " } },
    ];

    const result = applyTokens(diffed, {
      "--ink": "rgb(1, 2, 3);",
      "--line": "rgb(4,5,6)",
    });

    expect(diffed[0]!.style.color).toBe("var(--ink)");
    expect(diffed[0]!.style.borderColor).toBe("var(--line)");
    expect(result.replacements).toBe(2);
  });

  test("prefers shorter custom property names on value ties", () => {
    const diffed: DiffedStyle[] = [{ path: [0], style: { color: "#fff" } }];

    const result = applyTokens(diffed, {
      "--white-color-token": "#fff",
      "--w": "#fff",
    });

    expect(diffed[0]!.style.color).toBe("var(--w)");
    expect(result.tokens).toEqual({ "--w": "#fff" });
  });

  test("skips properties that are not token-eligible", () => {
    const diffed: DiffedStyle[] = [{ path: [0], style: { display: "flex" } }];

    const result = applyTokens(diffed, { "--layout": "flex" });

    expect(diffed[0]!.style.display).toBe("flex");
    expect(result.replacements).toBe(0);
  });

  test("skips non-string values and existing var() references", () => {
    const diffed: DiffedStyle[] = [
      { path: [0], style: { fontWeight: 700, color: "var(--already)" } },
    ];

    const result = applyTokens(diffed, { "--fw": "700", "--already": "#000" });

    expect(diffed[0]!.style.fontWeight).toBe(700);
    expect(diffed[0]!.style.color).toBe("var(--already)");
    expect(result.replacements).toBe(0);
    expect(result.tokens).toEqual({});
  });

  test("leaves values with no matching token untouched", () => {
    const diffed: DiffedStyle[] = [{ path: [0], style: { color: "rgb(9, 9, 9)" } }];

    const result = applyTokens(diffed, { "--brand": "rgb(59, 130, 246)" });

    expect(diffed[0]!.style.color).toBe("rgb(9, 9, 9)");
    expect(result.replacements).toBe(0);
  });

  test("sorts hoisted tokens alphabetically", () => {
    const diffed: DiffedStyle[] = [{ path: [0], style: { color: "#111", gap: "8px" } }];

    const result = applyTokens(diffed, { "--zeta": "#111", "--alpha": "8px" });

    expect(Object.keys(result.tokens)).toEqual(["--alpha", "--zeta"]);
  });
});
