import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { buildNestedSiteCSS } from "../src/canvas/nested-site-style";

describe("buildNestedSiteCSS", () => {
  test("returns empty string when no nested objects exist", () => {
    const style = { "--accent": "#3b82f6", color: "red", fontSize: "14px" };
    expect(buildNestedSiteCSS(style, "[data-jx-site]")).toBe("");
  });

  test("generates CSS for a single nested selector", () => {
    const style = {
      table: { borderCollapse: "collapse", width: "100%" },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site] table { border-collapse: collapse; width: 100% }");
  });

  test("generates deeply nested selectors (table > tbody > tr)", () => {
    const style = {
      table: {
        tbody: {
          tr: { borderBottom: "1px solid #222" },
        },
        width: "100%",
      },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site] table { width: 100% }");
    expect(css).toContain("[data-jx-site] table tbody tr { border-bottom: 1px solid #222 }");
  });

  test("handles pseudo-selectors (:hover, :first-child)", () => {
    const style = {
      table: {
        tbody: {
          tr: {
            ":first-child": { fontWeight: "700" },
            ":hover": { backgroundColor: "blue" },
            borderBottom: "1px solid #ccc",
          },
        },
      },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site] table tbody tr:hover { background-color: blue }");
    expect(css).toContain("[data-jx-site] table tbody tr:first-child { font-weight: 700 }");
  });

  test("handles & (ampersand) selectors", () => {
    const style = {
      "&.active": { fontWeight: "bold" },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site].active { font-weight: bold }");
  });

  test("handles attribute selectors", () => {
    const style = {
      "[disabled]": { opacity: "0.5" },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site][disabled] { opacity: 0.5 }");
  });

  test("handles class selectors", () => {
    const style = {
      ".highlight": { color: "yellow" },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site].highlight { color: yellow }");
  });

  test("skips flat properties (non-objects)", () => {
    const style = {
      "--custom": "blue",
      color: "red",
      margin: "0",
      table: { width: "100%" },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).not.toContain("color");
    expect(css).not.toContain("margin");
    expect(css).not.toContain("--custom");
    expect(css).toContain("[data-jx-site] table { width: 100% }");
  });

  test("converts camelCase to kebab-case", () => {
    const style = {
      table: {
        borderCollapse: "collapse",
        fontSize: "14px",
        textAlign: "left",
      },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("font-size: 14px");
    expect(css).toContain("text-align: left");
    expect(css).toContain("border-collapse: collapse");
  });

  test("handles real-world project.json table styles", () => {
    const style = {
      "--color-border": "#222222",
      fontFamily: "system-ui",
      table: {
        borderCollapse: "collapse",
        fontSize: "0.9375rem",
        tbody: {
          td: {
            ":first-child": { borderLeft: "none", fontWeight: "600" },
            ":last-child": { backgroundColor: "rgba(255, 255, 255, 0.97)" },
            padding: "1rem 1.25rem",
          },
          tr: {
            ":hover": { backgroundColor: "var(--color-bg-surface)" },
            borderBottom: "1px solid var(--color-border)",
          },
        },
        thead: {
          borderBottom: "1px solid var(--color-border)",
          fontWeight: "600",
          padding: "1rem 1.25rem",
        },
        width: "100%",
      },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");

    expect(css).toContain(
      "[data-jx-site] table { border-collapse: collapse; font-size: 0.9375rem; width: 100% }",
    );
    expect(css).toContain(
      "table thead { border-bottom: 1px solid var(--color-border); font-weight: 600; padding: 1rem 1.25rem }",
    );
    expect(css).toContain(
      "[data-jx-site] table tbody tr { border-bottom: 1px solid var(--color-border) }",
    );
    expect(css).toContain(
      "[data-jx-site] table tbody tr:hover { background-color: var(--color-bg-surface) }",
    );
    expect(css).toContain("[data-jx-site] table tbody td { padding: 1rem 1.25rem }");
    expect(css).toContain(
      "[data-jx-site] table tbody td:first-child { border-left: none; font-weight: 600 }",
    );
    expect(css).toContain(
      "[data-jx-site] table tbody td:last-child { background-color: rgba(255, 255, 255, 0.97) }",
    );
  });

  test("nested & within a descendant selector", () => {
    const style = {
      table: {
        tbody: {
          "&.striped": { background: "gray" },
        },
      },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site] table tbody.striped { background: gray }");
  });
});
