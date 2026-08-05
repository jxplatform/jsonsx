/**
 * Tests for the Project Styles model — src/style/project-styles.ts and src/style/token-ref.ts.
 *
 * Two things are load-bearing here and both are asserted rather than assumed: the user-facing NAME
 * and the CANVAS_MODES wire value are separate constants that must not converge, and a context is
 * one vocabulary — a colour scheme and a breakpoint are two kinds of the same `@name` block, read
 * and written through one pair of functions.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { render } from "lit-html";
import { CANVAS_MODES } from "../src/canvas/iframe-protocol";
import {
  PROJECT_STYLES_TITLE,
  PROJECT_STYLES_VIEW,
  TOKEN_GROUPS,
  addableContexts,
  groupIdOfToken,
  groupTokens,
  listTokenContexts,
  listTokens,
  readTokenOverride,
  tokenLabel,
  tokenOverrides,
  writeTokenOverride,
} from "../src/style/project-styles";
import {
  renderTokenChip,
  resolveTokenValue,
  toTokenRef,
  tokenRefName,
} from "../src/style/token-ref";

import type { JxStyle } from "@jxsuite/schema/types";
import type { TokenContext } from "../src/style/project-styles";

/**
 * A value that is genuinely absent — written once so the lint rule against a bare `undefined`
 * argument does not push these tests into asserting `null` instead, which is a different case.
 */
const ABSENT = undefined;

const MEDIA = {
  "--": "1280px",
  "--dark": "(prefers-color-scheme: dark)",
  "--light": "(prefers-color-scheme: light)",
  "--md": "(min-width: 768px)",
  "--print": "print",
  "--sm": "(max-width: 600px)",
};

function contextNamed(name: string): TokenContext {
  const context = listTokenContexts(MEDIA).find((c) => c.name === name);
  if (!context) {
    throw new Error(`no declared context "${name}"`);
  }
  return context;
}

// ─── The name and the wire value ─────────────────────────────────────────────

describe("the name and the wire value", () => {
  test("the surface is named Project Styles and the canvas view it opens is not", () => {
    expect(PROJECT_STYLES_TITLE).toBe("Project Styles");
    expect(PROJECT_STYLES_VIEW).toBe("stylebook");
    expect(PROJECT_STYLES_TITLE).not.toBe(PROJECT_STYLES_VIEW as string);
  });

  test("the wire value is still a CANVAS_MODES member — renaming it is a protocol change", () => {
    /* `"stylebook"` is half of a ParentToIframe union: the studio bundle and dist/iframe-entry.js
       must agree on it, so it survives every rename of the surface above it (plan §9.4). */
    expect(CANVAS_MODES).toContain(PROJECT_STYLES_VIEW);
  });
});

// ─── Groups and labels ───────────────────────────────────────────────────────

describe("token groups", () => {
  test("a token is filed by its prefix", () => {
    expect(groupIdOfToken("--color-primary")).toBe("color");
    expect(groupIdOfToken("--font-body")).toBe("font");
    expect(groupIdOfToken("--size-gap")).toBe("size");
    expect(groupIdOfToken("--spacing-lg")).toBe("size");
    expect(groupIdOfToken("--radius-md")).toBe("size");
    expect(groupIdOfToken("--shadow-soft")).toBe("other");
  });

  test("a label is the friendly name the token was added under", () => {
    expect(tokenLabel("--color-primary-blue")).toBe("Primary Blue");
    expect(tokenLabel("--font-body")).toBe("Body");
    expect(tokenLabel("--size-gap")).toBe("Gap");
    // The size group's prefix does not match these, so the bare `--` strip answers instead.
    expect(tokenLabel("--spacing-lg")).toBe("Spacing Lg");
    expect(tokenLabel("--radius-md")).toBe("Radius Md");
    // `other` has no prefix to strip, so inventing a friendly name would be a guess.
    expect(tokenLabel("--shadow-soft")).toBe("--shadow-soft");
  });

  test("every group id has exactly one descriptor, in display order", () => {
    expect(TOKEN_GROUPS.map((g) => g.id)).toEqual(["color", "font", "size", "other"]);
  });
});

// ─── Listing ─────────────────────────────────────────────────────────────────

describe("listing tokens", () => {
  const style = {
    "--color-primary": "#007acc",
    "--radius-md": 8,
    "--size-gap": "16px",
    "@--sm": { "--size-gap": "8px" },
    color: "blue",
  } as unknown as JxStyle;

  test("only custom properties with scalar values are tokens", () => {
    expect(listTokens(style).map((t) => t.name)).toEqual([
      "--color-primary",
      "--radius-md",
      "--size-gap",
    ]);
  });

  test("a numeric value survives as a number", () => {
    expect(listTokens(style).find((t) => t.name === "--radius-md")?.value).toBe(8);
  });

  test("no style block is no tokens, not a crash", () => {
    expect(listTokens(null)).toEqual([]);
    expect(listTokens(ABSENT)).toEqual([]);
  });

  test("grouping keeps group order and puts every token in exactly one bucket", () => {
    const grouped = groupTokens(style);
    expect(grouped.map((g) => g.group.id)).toEqual(["color", "font", "size", "other"]);
    expect(grouped.map((g) => g.tokens.length)).toEqual([1, 0, 2, 0]);
  });
});

// ─── Contexts ────────────────────────────────────────────────────────────────

describe("rendering contexts", () => {
  test("schemes come first, then breakpoints, then any other feature query", () => {
    expect(listTokenContexts(MEDIA).map((c) => [c.name, c.kind, c.label])).toEqual([
      ["--dark", "scheme", "Dark"],
      ["--light", "scheme", "Light"],
      /* Breakpoint order is `parseMediaEntries`', which is the order the canvas lays its panels
         out in — the form must not invent a second one. */
      ["--md", "size", "@--md"],
      ["--sm", "size", "@--sm"],
      ["--print", "feature", "@--print"],
    ]);
  });

  test("the base width is not a context", () => {
    expect(listTokenContexts(MEDIA).some((c) => c.name === "--")).toBe(false);
  });

  test("a scheme context carries which scheme it is", () => {
    expect(contextNamed("--dark").scheme).toBe("dark");
    expect(contextNamed("--light").scheme).toBe("light");
    expect(contextNamed("--sm").scheme).toBeUndefined();
  });

  test("every context names the style key its overrides live under", () => {
    expect(contextNamed("--sm").key).toBe("@--sm");
  });

  test("no $media is no contexts", () => {
    expect(listTokenContexts(null)).toEqual([]);
    expect(listTokenContexts(ABSENT)).toEqual([]);
  });
});

// ─── Overrides ───────────────────────────────────────────────────────────────

describe("reading and writing an override", () => {
  const sm = contextNamed("--sm");

  test("an absent block, an absent key and a non-scalar value all read as no override", () => {
    expect(readTokenOverride({} as JxStyle, sm, "--size-gap")).toBeUndefined();
    expect(readTokenOverride({ "@--sm": {} } as unknown as JxStyle, sm, "--x")).toBeUndefined();
    expect(
      readTokenOverride({ "@--sm": "not a block" } as unknown as JxStyle, sm, "--x"),
    ).toBeUndefined();
    expect(
      readTokenOverride({ "@--sm": { "--x": { deep: 1 } } } as unknown as JxStyle, sm, "--x"),
    ).toBeUndefined();
  });

  test("writing creates the block on demand and reading finds it", () => {
    const style = {} as JxStyle;
    writeTokenOverride(style, sm, "--size-gap", "8px");
    expect(style["@--sm"]).toEqual({ "--size-gap": "8px" });
    expect(readTokenOverride(style, sm, "--size-gap")).toBe("8px");
  });

  test("clearing removes the key, and the block once it empties", () => {
    const style = { "@--sm": { "--a": "1", "--b": "2" } } as unknown as JxStyle;
    writeTokenOverride(style, sm, "--a", "");
    expect(style["@--sm"]).toEqual({ "--b": "2" });
    writeTokenOverride(style, sm, "--b", "");
    expect(style["@--sm"]).toBeUndefined();
  });

  test("clearing an override that never existed writes nothing at all", () => {
    const style = {} as JxStyle;
    writeTokenOverride(style, sm, "--a", "");
    expect(Object.keys(style)).toEqual([]);
  });

  test("overrides are reported in context order, and only where they exist", () => {
    const style = {
      "@--dark": { "--color-primary": "#111" },
      "@--sm": { "--color-primary": "#222" },
    } as unknown as JxStyle;
    expect(
      tokenOverrides(style, listTokenContexts(MEDIA), "--color-primary").map((o) => [
        o.context.name,
        o.value,
      ]),
    ).toEqual([
      ["--dark", "#111"],
      ["--sm", "#222"],
    ]);
  });

  test("the add affordance offers what is declared, unused, and not already on screen", () => {
    const style = { "@--dark": { "--color-primary": "#111" } } as unknown as JxStyle;
    const contexts = listTokenContexts(MEDIA);
    expect(addableContexts(style, contexts, "--color-primary").map((c) => c.name)).toEqual([
      "--light",
      "--md",
      "--sm",
      "--print",
    ]);
    // A colour token already shows both scheme rows, so the picker must not offer them again.
    const schemes = contexts.filter((c) => c.kind === "scheme");
    expect(addableContexts(style, contexts, "--color-primary", schemes).map((c) => c.name)).toEqual(
      ["--md", "--sm", "--print"],
    );
  });
});

// ─── Token references ────────────────────────────────────────────────────────

describe("token references", () => {
  test("a bare var() is a reference; anything around it is a value", () => {
    expect(tokenRefName("var(--color-brand)")).toBe("--color-brand");
    expect(tokenRefName("var( --color-brand )")).toBe("--color-brand");
    expect(tokenRefName("calc(var(--size-gap) * 2)")).toBeNull();
    expect(tokenRefName("var(--a, red)")).toBeNull();
    expect(tokenRefName("#3b82f6")).toBeNull();
    expect(tokenRefName(8)).toBeNull();
  });

  test("the reference form round-trips", () => {
    expect(tokenRefName(toTokenRef("--color-brand"))).toBe("--color-brand");
  });

  test("resolution follows a chain of aliases to the value at its end", () => {
    const style = {
      "--color-a": "var(--color-b)",
      "--color-b": "var(--color-c)",
      "--color-c": "#123456",
    } as unknown as JxStyle;
    expect(resolveTokenValue(style, "var(--color-a)")).toBe("#123456");
    expect(resolveTokenValue(style, "#abcdef")).toBe("#abcdef");
    expect(resolveTokenValue(style, 8)).toBe(8);
  });

  test("a reference that leaves the block, loops, or runs too deep resolves to nothing", () => {
    const missing = {} as JxStyle;
    expect(resolveTokenValue(missing, "var(--nope)")).toBeUndefined();
    expect(resolveTokenValue(null, "var(--nope)")).toBeUndefined();

    const loop = { "--a": "var(--b)", "--b": "var(--a)" } as unknown as JxStyle;
    expect(resolveTokenValue(loop, "var(--a)")).toBeUndefined();

    // Longer than the hop budget, without ever repeating a name.
    const chain: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) {
      chain[`--t${i}`] = `var(--t${i + 1})`;
    }
    chain["--t20"] = "#fff";
    expect(resolveTokenValue(chain as unknown as JxStyle, "var(--t0)")).toBeUndefined();

    // A block whose value is an object is not a value either.
    const nested = { "--a": { deep: 1 } } as unknown as JxStyle;
    expect(resolveTokenValue(nested, "var(--a)")).toBeUndefined();
  });

  test("nothing in, nothing out", () => {
    expect(resolveTokenValue({} as JxStyle, null)).toBeUndefined();
    expect(resolveTokenValue({} as JxStyle, ABSENT)).toBeUndefined();
  });
});

describe("the token chip", () => {
  function chip(...args: Parameters<typeof renderTokenChip>): HTMLElement {
    const host = document.createElement("div");
    render(renderTokenChip(...args), host);
    return host.querySelector(".style-token-chip") as HTMLElement;
  }

  test("it names the token and carries the full reference and its value in the title", () => {
    const el = chip("--color-brand", "#00aa55", { swatch: true });
    expect(el.querySelector(".style-token-chip-label")?.textContent?.trim()).toBe("Brand");
    expect(el.getAttribute("title")).toBe("var(--color-brand) → #00aa55");
    expect(el.querySelector(".style-token-chip-swatch")?.getAttribute("style")).toContain(
      "#00aa55",
    );
  });

  test("a swatch is only drawn when there is a resolved colour to draw", () => {
    expect(
      chip("--color-brand", ABSENT, { swatch: true }).querySelector(".style-token-chip-swatch"),
    ).toBeNull();
    expect(chip("--size-gap", "8px").querySelector(".style-token-chip-swatch")).toBeNull();
  });

  test("an unresolvable reference says so rather than showing an empty value", () => {
    expect(chip("--size-gap", ABSENT).getAttribute("title")).toBe("var(--size-gap) → unresolved");
  });
});
