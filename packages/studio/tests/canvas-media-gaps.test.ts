/**
 * Canvas media — gap coverage for collectMediaOverrides (stylesheet scanning for active @media
 * rules) and the custom-property branch of applyCanvasStyle's media overrides.
 *
 * Happy-dom's CSSStyleDeclaration/CSSRuleList are not iterable, so this file builds rule objects on
 * the real CSSMediaRule/CSSStyleRule prototypes (instanceof-compatible) with iterable style lists,
 * plus a real-stylesheet integration test behind local iterator polyfills.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { applyCanvasStyle, collectMediaOverrides } from "../src/utils/canvas-media";

// ─── Local fixtures (extra helpers built here; harness has no CSSOM support) ──

function fakeStyleRule(selectorText: string, props: Record<string, string>): CSSStyleRule {
  const rule = Object.create(CSSStyleRule.prototype) as CSSStyleRule;
  const style = Object.keys(props);
  Object.defineProperty(style, "getPropertyValue", {
    value: (p: string) => props[p] ?? "",
  });
  Object.defineProperty(rule, "selectorText", { value: selectorText });
  Object.defineProperty(rule, "style", { value: style });
  return rule;
}

function fakeMediaRule(conditionText: string, rules: unknown[]): CSSMediaRule {
  const rule = Object.create(CSSMediaRule.prototype) as CSSMediaRule;
  Object.defineProperty(rule, "conditionText", { value: conditionText });
  Object.defineProperty(rule, "cssRules", { value: rules });
  return rule;
}

function fakeSheet(rules: unknown[] | null): CSSStyleSheet {
  return { cssRules: rules } as unknown as CSSStyleSheet;
}

const MQ = "(min-width: 640px)";

describe("collectMediaOverrides", () => {
  test("returns empty map when no breakpoints are active", () => {
    const sheet = fakeSheet([
      fakeMediaRule(MQ, [fakeStyleRule('[data-jx="u1"]', { color: "red" })]),
    ]);
    expect(collectMediaOverrides([sheet], new Set()).size).toBe(0);
  });

  test("skips sheets whose cssRules getter throws (cross-origin)", () => {
    const blocked = {
      get cssRules(): CSSRuleList {
        throw new DOMException("blocked");
      },
    } as unknown as CSSStyleSheet;
    const good = fakeSheet([
      fakeMediaRule(MQ, [fakeStyleRule('[data-jx="u1"]', { color: "red" })]),
    ]);
    const overrides = collectMediaOverrides([blocked, good], new Set([MQ]));
    expect(overrides.get("u1")?.get("color")).toBe("red");
  });

  test("skips sheets with null cssRules", () => {
    expect(collectMediaOverrides([fakeSheet(null)], new Set([MQ])).size).toBe(0);
  });

  test("skips non-media rules and inactive media conditions", () => {
    const sheet = fakeSheet([
      fakeStyleRule('[data-jx="u1"]', { color: "red" }), // Top-level style rule, not media
      fakeMediaRule("(min-width: 1024px)", [fakeStyleRule('[data-jx="u1"]', { color: "blue" })]),
    ]);
    expect(collectMediaOverrides([sheet], new Set([MQ])).size).toBe(0);
  });

  test("skips selectors without a data-jx attribute and non-style rules inside media", () => {
    const sheet = fakeSheet([
      fakeMediaRule(MQ, [
        fakeStyleRule(".plain-class", { color: "red" }),
        { conditionText: "nested" }, // Not a CSSStyleRule
      ]),
    ]);
    expect(collectMediaOverrides([sheet], new Set([MQ])).size).toBe(0);
  });

  test("collects declarations per data-jx uid", () => {
    const sheet = fakeSheet([
      fakeMediaRule(MQ, [
        fakeStyleRule('[data-jx="u1"]', { color: "red", "margin-top": "4px" }),
        fakeStyleRule('[data-jx="u2"]', { display: "none" }),
      ]),
    ]);
    const overrides = collectMediaOverrides([sheet], new Set([MQ]));
    expect(overrides.size).toBe(2);
    expect(overrides.get("u1")?.get("color")).toBe("red");
    expect(overrides.get("u1")?.get("margin-top")).toBe("4px");
    expect(overrides.get("u2")?.get("display")).toBe("none");
  });

  test("merges rules for the same uid across sheets and media blocks", () => {
    const sheetA = fakeSheet([
      fakeMediaRule(MQ, [fakeStyleRule('[data-jx="u1"]', { color: "red" })]),
    ]);
    const sheetB = fakeSheet([
      fakeMediaRule(MQ, [fakeStyleRule('[data-jx="u1"]', { padding: "8px" })]),
    ]);
    const overrides = collectMediaOverrides([sheetA, sheetB], new Set([MQ]));
    expect(overrides.size).toBe(1);
    expect(overrides.get("u1")?.get("color")).toBe("red");
    expect(overrides.get("u1")?.get("padding")).toBe("8px");
  });

  test("reads rules from a real happy-dom stylesheet", () => {
    // Happy-dom parses @media rules but its rule/style lists lack Symbol.iterator — polyfill
    // Locally so the production for-of loops can walk them.
    const styleListProto = CSSStyleDeclaration.prototype as unknown as Record<symbol, unknown>;
    styleListProto[Symbol.iterator] ??= function* iterateStyleDeclaration(
      this: CSSStyleDeclaration,
    ) {
      for (let i = 0; i < this.length; i++) {
        yield this.item(i);
      }
    };
    const el = document.createElement("style");
    el.textContent = `@media ${MQ} { [data-jx="real1"] { color: red; margin-top: 4px; } }`;
    document.head.append(el);
    try {
      const sheet = document.styleSheets[0] as CSSStyleSheet;
      const rules = sheet.cssRules as unknown as Record<symbol, unknown> & { length: number };
      rules[Symbol.iterator] ??= function* iterateSheetRules(this: CSSRuleList) {
        for (let i = 0; i < this.length; i++) {
          yield this[i];
        }
      };
      const media = sheet.cssRules[0] as CSSMediaRule;
      const inner = media.cssRules as unknown as Record<symbol, unknown> & { length: number };
      inner[Symbol.iterator] ??= function* iterateMediaRules(this: CSSRuleList) {
        for (let i = 0; i < this.length; i++) {
          yield this[i];
        }
      };
      const overrides = collectMediaOverrides([sheet], new Set([MQ]));
      expect(overrides.get("real1")?.get("color")).toBe("red");
      expect(overrides.get("real1")?.get("margin-top")).toBe("4px");
    } finally {
      el.remove();
    }
  });
});

describe("applyCanvasStyle media overrides", () => {
  test("applies custom properties from active media blocks via setProperty", () => {
    const el = document.createElement("div");
    applyCanvasStyle(
      el,
      {
        "@sm": { "--accent": "#f00", padding: "8px" },
        color: "blue",
      } as never,
      new Set(["sm"]),
      {},
    );
    expect(el.style.color).toBe("blue");
    expect(el.style.getPropertyValue("--accent")).toBe("#f00");
    expect(el.style.padding).toBe("8px");
  });

  test("applies feature-toggle overrides and skips inactive/base entries", () => {
    const el = document.createElement("div");
    applyCanvasStyle(
      el,
      {
        "@--": { color: "black" },
        "@dark": { color: "white" },
        "@lg": { color: "green" },
      } as never,
      new Set(),
      { dark: true },
    );
    expect(el.style.color).toBe("white");
  });
});
