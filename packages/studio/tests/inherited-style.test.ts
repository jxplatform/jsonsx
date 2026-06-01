import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import { computeInheritedStyle } from "../src/utils/inherited-style";

// ─── Desktop-first cascade (max-width: Base → lg → md → sm) ─────────────────

describe("computeInheritedStyle — desktop-first", () => {
  const mediaNames = ["--lg", "--md", "--sm"];

  const style = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "2rem",
    "@--lg": { gap: "1.5rem" },
    "@--md": { gridTemplateColumns: "1fr" },
    "@--sm": { gap: "1rem" },
  };

  test("returns empty when activeTab is null (base view)", () => {
    expect(computeInheritedStyle(style, mediaNames, null)).toEqual({});
  });

  test("returns empty when mediaNames is empty", () => {
    expect(computeInheritedStyle(style, [], "--md")).toEqual({});
  });

  test("--lg inherits only base values", () => {
    const result = computeInheritedStyle(style, mediaNames, "--lg");
    expect(result).toEqual({
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "2rem",
    });
  });

  test("--md inherits base + --lg overrides", () => {
    const result = computeInheritedStyle(style, mediaNames, "--md");
    expect(result).toEqual({
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "1.5rem", // overridden by --lg
    });
  });

  test("--sm inherits base + --lg + --md overrides", () => {
    const result = computeInheritedStyle(style, mediaNames, "--sm");
    expect(result).toEqual({
      display: "grid",
      gridTemplateColumns: "1fr", // overridden by --md
      gap: "1.5rem", // overridden by --lg (--sm's own value not included)
    });
  });

  test("skips object-valued properties (nested selectors/media blocks)", () => {
    const styleWithNested = {
      color: "red",
      "@--md": { color: "blue" },
      ":hover": { color: "green" },
    };
    const result = computeInheritedStyle(styleWithNested, mediaNames, "--md");
    expect(result).toEqual({ color: "red" });
    // :hover is an object, so it should be skipped
  });
});

// ─── Mobile-first cascade (min-width: Base → sm → md → lg) ──────────────────

describe("computeInheritedStyle — mobile-first", () => {
  const mediaNames = ["--sm", "--md", "--lg"];

  const style = {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    "@--sm": { gap: "1.5rem" },
    "@--md": { flexDirection: "row", gap: "2rem" },
    "@--lg": { gap: "3rem" },
  };

  test("--sm inherits only base", () => {
    const result = computeInheritedStyle(style, mediaNames, "--sm");
    expect(result).toEqual({
      display: "flex",
      flexDirection: "column",
      gap: "1rem",
    });
  });

  test("--md inherits base + --sm overrides", () => {
    const result = computeInheritedStyle(style, mediaNames, "--md");
    expect(result).toEqual({
      display: "flex",
      flexDirection: "column",
      gap: "1.5rem", // from --sm
    });
  });

  test("--lg inherits base + --sm + --md overrides", () => {
    const result = computeInheritedStyle(style, mediaNames, "--lg");
    expect(result).toEqual({
      display: "flex",
      flexDirection: "row", // from --md
      gap: "2rem", // from --md
    });
  });
});

// ─── Selector inheritance within media ───────────────────────────────────────

describe("computeInheritedStyle — with activeSelector", () => {
  const mediaNames = ["--lg", "--md", "--sm"];

  const style = {
    color: "black",
    ":hover": { color: "blue", opacity: "0.8" },
    "@--lg": {
      ":hover": { opacity: "0.9" },
    },
    "@--md": {
      ":hover": { color: "red" },
    },
    "@--sm": {},
  };

  test("--lg with :hover inherits base :hover values", () => {
    const result = computeInheritedStyle(style, mediaNames, "--lg", ":hover");
    expect(result).toEqual({
      color: "blue",
      opacity: "0.8",
    });
  });

  test("--md with :hover inherits base :hover + --lg :hover overrides", () => {
    const result = computeInheritedStyle(style, mediaNames, "--md", ":hover");
    expect(result).toEqual({
      color: "blue",
      opacity: "0.9", // from --lg
    });
  });

  test("--sm with :hover inherits base + --lg + --md :hover overrides", () => {
    const result = computeInheritedStyle(style, mediaNames, "--sm", ":hover");
    expect(result).toEqual({
      color: "red", // from --md
      opacity: "0.9", // from --lg
    });
  });

  test("selector that doesn't exist in base returns empty for first tab", () => {
    const sparseStyle = {
      color: "black",
      "@--lg": { "::before": { content: "'→'" } },
      "@--md": {},
    };
    const result = computeInheritedStyle(sparseStyle, mediaNames, "--lg", "::before");
    expect(result).toEqual({});
  });

  test("selector that exists only in base inherits base values", () => {
    const result = computeInheritedStyle(style, mediaNames, "--sm", ":hover");
    expect(result.color).toBe("red");
    expect(result.opacity).toBe("0.9");
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("computeInheritedStyle — edge cases", () => {
  const mediaNames = ["--md"];

  test("style with no media blocks returns base for any tab", () => {
    const style = { color: "red", fontSize: "16px" };
    const result = computeInheritedStyle(style, mediaNames, "--md");
    expect(result).toEqual({ color: "red", fontSize: "16px" });
  });

  test("empty style returns empty object", () => {
    const result = computeInheritedStyle({}, mediaNames, "--md");
    expect(result).toEqual({});
  });

  test("media block with object values (nested selectors) are excluded", () => {
    const style = {
      padding: "1rem",
      "@--md": {
        padding: "2rem",
        ":hover": { padding: "3rem" }, // nested object
      },
    };
    // Viewing a hypothetical tab after --md
    const names = ["--md", "--sm"];
    const result = computeInheritedStyle(style, names, "--sm");
    expect(result).toEqual({ padding: "2rem" });
    // The :hover nested object is excluded
  });

  test("activeTab not in mediaNames returns only base values", () => {
    const style = { color: "red", "@--md": { color: "blue" } };
    const result = computeInheritedStyle(style, ["--md"], "--xl");
    // --xl not found in iteration, so all media blocks are layered
    expect(result).toEqual({ color: "blue" });
  });
});
