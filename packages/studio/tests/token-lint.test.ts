import { describe, expect, it } from "bun:test";
import { flagHardcodedTokens, formatTokenHints } from "../src/services/token-lint";

const PROJECT_STYLE = {
  "--color-accent": "#3b82f6",
  "--color-bg-primary": "#0a0a0a",
  "--color-text-secondary": "#a1a1aa",
  "--radius": "8px",
  "--font-mono": "'JetBrains Mono', monospace",
  fontFamily: "system-ui",
};

describe("flagHardcodedTokens", () => {
  it("flags a hard-coded color that matches a token", () => {
    const doc = {
      tagName: "div",
      style: { color: "#3b82f6" },
    };
    const findings = flagHardcodedTokens(doc, PROJECT_STYLE);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.property).toBe("color");
    expect(findings[0]!.suggestedToken).toBe("--color-accent");
  });

  it("flags case-insensitively", () => {
    const doc = {
      tagName: "div",
      style: { backgroundColor: "#3B82F6" },
    };
    const findings = flagHardcodedTokens(doc, PROJECT_STYLE);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.suggestedToken).toBe("--color-accent");
  });

  it("returns no findings when values use var() references", () => {
    const doc = {
      tagName: "div",
      style: { color: "var(--color-accent)", borderRadius: "var(--radius)" },
    };
    const findings = flagHardcodedTokens(doc, PROJECT_STYLE);
    expect(findings).toHaveLength(0);
  });

  it("returns no findings for template expressions", () => {
    const doc = {
      tagName: "div",
      style: { color: "${state.isPrimary ? '#3b82f6' : '#fff'}" },
    };
    const findings = flagHardcodedTokens(doc, PROJECT_STYLE);
    expect(findings).toHaveLength(0);
  });

  it("scans nested children", () => {
    const doc = {
      tagName: "div",
      children: [
        {
          tagName: "h1",
          style: { borderRadius: "8px" },
          children: [{ tagName: "span", style: { color: "#a1a1aa" } }],
        },
      ],
    };
    const findings = flagHardcodedTokens(doc, PROJECT_STYLE);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.suggestedToken).toBe("--radius");
    expect(findings[1]!.suggestedToken).toBe("--color-text-secondary");
  });

  it("ignores non-token style keys (no -- prefix)", () => {
    const doc = {
      tagName: "div",
      style: { fontFamily: "system-ui" },
    };
    const findings = flagHardcodedTokens(doc, PROJECT_STYLE);
    expect(findings).toHaveLength(0);
  });

  it("ignores @breakpoint keys in style", () => {
    const doc = {
      tagName: "div",
      style: { "@--md": { gridTemplateColumns: "1fr" } },
    };
    const findings = flagHardcodedTokens(doc, PROJECT_STYLE);
    expect(findings).toHaveLength(0);
  });

  it("returns empty for null/undefined inputs", () => {
    expect(flagHardcodedTokens(null, PROJECT_STYLE)).toEqual([]);
    expect(flagHardcodedTokens({}, null)).toEqual([]);
  });
});

describe("formatTokenHints", () => {
  it("returns empty string for no findings", () => {
    expect(formatTokenHints([])).toBe("");
  });

  it("formats findings as a readable hint", () => {
    const findings = [
      { path: "div > h1", property: "color", value: "#3b82f6", suggestedToken: "--color-accent" },
    ];
    const result = formatTokenHints(findings);
    expect(result).toContain("var(--color-accent)");
    expect(result).toContain("#3b82f6");
  });
});
