import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { computeInheritedSources, computeInheritedStyle } from "../src/utils/inherited-style";

// ─── Desktop-first cascade (max-width: Base → lg → md → sm) ─────────────────

describe("computeInheritedStyle — desktop-first", () => {
  const mediaNames = ["--lg", "--md", "--sm"];

  const style = {
    "@--lg": { gap: "1.5rem" },
    "@--md": { gridTemplateColumns: "1fr" },
    "@--sm": { gap: "1rem" },
    display: "grid",
    gap: "2rem",
    gridTemplateColumns: "1fr 1fr",
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
      gap: "2rem",
      gridTemplateColumns: "1fr 1fr",
    });
  });

  test("--md inherits base + --lg overrides", () => {
    const result = computeInheritedStyle(style, mediaNames, "--md");
    expect(result).toEqual({
      display: "grid",
      gap: "1.5rem", // Overridden by --lg
      gridTemplateColumns: "1fr 1fr",
    });
  });

  test("--sm inherits base + --lg + --md overrides", () => {
    const result = computeInheritedStyle(style, mediaNames, "--sm");
    expect(result).toEqual({
      display: "grid",
      gap: "1.5rem", // Overridden by --lg (--sm's own value not included)
      gridTemplateColumns: "1fr", // Overridden by --md
    });
  });

  test("skips object-valued properties (nested selectors/media blocks)", () => {
    const styleWithNested = {
      ":hover": { color: "green" },
      "@--md": { color: "blue" },
      color: "red",
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
    "@--lg": { gap: "3rem" },
    "@--md": { flexDirection: "row", gap: "2rem" },
    "@--sm": { gap: "1.5rem" },
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
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
      gap: "1.5rem", // From --sm
    });
  });

  test("--lg inherits base + --sm + --md overrides", () => {
    const result = computeInheritedStyle(style, mediaNames, "--lg");
    expect(result).toEqual({
      display: "flex",
      flexDirection: "row", // From --md
      gap: "2rem", // From --md
    });
  });
});

// ─── Selector inheritance within media ───────────────────────────────────────

describe("computeInheritedStyle — with activeSelector", () => {
  const mediaNames = ["--lg", "--md", "--sm"];

  const style = {
    ":hover": { color: "blue", opacity: "0.8" },
    "@--lg": {
      ":hover": { opacity: "0.9" },
    },
    "@--md": {
      ":hover": { color: "red" },
    },
    "@--sm": {},
    color: "black",
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
      opacity: "0.9", // From --lg
    });
  });

  test("--sm with :hover inherits base + --lg + --md :hover overrides", () => {
    const result = computeInheritedStyle(style, mediaNames, "--sm", ":hover");
    expect(result).toEqual({
      color: "red", // From --md
      opacity: "0.9", // From --lg
    });
  });

  test("selector that doesn't exist in base returns empty for first tab", () => {
    const sparseStyle = {
      "@--lg": { "::before": { content: "'→'" } },
      "@--md": {},
      color: "black",
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
      "@--md": {
        ":hover": { padding: "3rem" }, // Nested object
        padding: "2rem",
      },
      padding: "1rem",
    };
    // Viewing a hypothetical tab after --md
    const names = ["--md", "--sm"];
    const result = computeInheritedStyle(style, names, "--sm");
    expect(result).toEqual({ padding: "2rem" });
    // The :hover nested object is excluded
  });

  test("activeTab not in mediaNames returns only base values", () => {
    const style = { "@--md": { color: "blue" }, color: "red" };
    const result = computeInheritedStyle(style, ["--md"], "--xl");
    // --xl not found in iteration, so all media blocks are layered
    expect(result).toEqual({ color: "blue" });
  });
});

// ─── The donor the walk always knew ──────────────────────────────────────────

describe("computeInheritedSources — naming the donor", () => {
  const mediaNames = ["--lg", "--md", "--sm"];

  test("a base value reports a null donor; a breakpoint value reports its name", () => {
    const style = {
      "@--lg": { gap: "1.5rem" },
      display: "grid",
      gap: "2rem",
    };
    expect(computeInheritedSources(style, mediaNames, "--md")).toEqual({
      display: { donor: null, value: "grid" },
      gap: { donor: "--lg", value: "1.5rem" },
    });
  });

  test("the LAST donor before the active tab wins, as the cascade does", () => {
    const style = { "@--lg": { gap: "2rem" }, "@--md": { gap: "1rem" }, gap: "3rem" };
    expect(computeInheritedSources(style, mediaNames, "--sm").gap).toEqual({
      donor: "--md",
      value: "1rem",
    });
  });

  test("selector inheritance carries donors too", () => {
    const style = {
      "@--lg": { ":hover": { color: "green" } },
      ":hover": { color: "red" },
    };
    expect(computeInheritedSources(style, mediaNames, "--md", ":hover")).toEqual({
      color: { donor: "--lg", value: "green" },
    });
    expect(computeInheritedSources(style, mediaNames, "--lg", ":hover")).toEqual({
      color: { donor: null, value: "red" },
    });
  });

  test("nothing to inherit at the base tab, or with no breakpoints declared", () => {
    expect(computeInheritedSources({ gap: "1rem" }, mediaNames, null)).toEqual({});
    expect(computeInheritedSources({ gap: "1rem" }, [], "--md")).toEqual({});
  });

  test("computeInheritedStyle is exactly this, with the donors dropped", () => {
    const style = { "@--lg": { gap: "1.5rem" }, display: "grid", gap: "2rem" };
    expect(computeInheritedStyle(style, mediaNames, "--md")).toEqual({
      display: "grid",
      gap: "1.5rem",
    });
  });

  test("an explicitly undefined value becomes the empty string rather than vanishing", () => {
    const style = { gap: undefined } as unknown as Record<string, string>;
    expect(computeInheritedSources(style, mediaNames, "--md")).toEqual({
      gap: { donor: null, value: "" },
    });
  });
});
