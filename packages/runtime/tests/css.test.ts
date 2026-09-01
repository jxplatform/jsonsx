/**
 * `@jxsuite/runtime/css` exists to be importable where the DOM runtime is not.
 *
 * Two things are asserted here. The first is the property that made it a subpath, and which no
 * behavioural test can see: that importing it costs nothing. A single `import` added to `css.ts` —
 * a helper from `./runtime.ts` — would put the renderer and `@vue/reactivity` back inside every
 * Worker that composes a stylesheet, and every behavioural test would still pass. The allowlist is
 * one entry long and `@jxsuite/schema/guards` is on it because that module imports nothing but
 * types; anything else has to justify itself here first.
 *
 * The second is `buildStyleRules`, which is the one place that decides what a Jx style object MEANS
 * as CSS. Three emitters used to answer that separately and each dropped a different nesting order,
 * so the composition cases below are the contract the runtime, the compiler and the site builder
 * are now all held to at once.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import * as css from "../src/css.ts";

const SOURCE = readFileSync(join(import.meta.dirname, "../src/css.ts"), "utf8");

/** The source with comments removed — `localStorage` and the DOM are named in prose throughout. */
const CODE = SOURCE.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");

describe("the module has no dependencies at all", () => {
  test("it imports nothing, from anywhere", () => {
    const imports = [
      ...CODE.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g),
    ].map((m) => m[1]);
    expect({
      imports,
      why: "this subpath exists so a Worker can compose a stylesheet without the DOM runtime",
    }).toEqual({
      imports: ["@jxsuite/schema/guards", "@jxsuite/schema/types"],
      why: "this subpath exists so a Worker can compose a stylesheet without the DOM runtime",
    });
  });

  test("it names no DOM or platform global", () => {
    // Pure string and regex math. A `document` here would throw in workerd rather than degrade.
    for (const global of ["document.", "window.", "navigator.", "localStorage", "process."]) {
      expect({ global, present: CODE.includes(global) }).toEqual({ global, present: false });
    }
  });
});

describe("the subpath carries what @jxsuite/site/site-style needs", () => {
  test("every export is present", () => {
    // A move that dropped one would surface as a build failure three packages away.
    expect(Object.keys(css).toSorted()).toEqual([
      "COLOR_SCHEME_ATTR",
      "COLOR_SCHEME_STORAGE_KEY",
      "buildStyleRules",
      "camelToKebab",
      "cssPropertyName",
      "cssRuleText",
      "hashCss",
      "isDeclarationAtRule",
      "isNestedSelectorKey",
      "pureSchemeOf",
      "resolveAtQuery",
      "resolveNestedSelector",
      "schemeSelectors",
      "transposeCanvasPopoverSelector",
    ]);
  });

  test("the root export still answers for every one of them", async () => {
    /* Moving these must not be a breaking change: the compiler and the studio both import
       camelToKebab from "@jxsuite/runtime", and canvas-media imports pureSchemeOf. */
    const root = (await import("../src/runtime.ts")) as Record<string, unknown>;
    for (const name of Object.keys(css)) {
      expect({ name, same: root[name] === (css as Record<string, unknown>)[name] }).toEqual({
        name,
        same: true,
      });
    }
  });
});

/** Rule texts only — the shape assertions below read better as a list of strings. */
const textsOf = (style: css.CssRule[]) => style.map((rule) => rule.text);

describe("buildStyleRules composes nesting and at-rules in both orders", () => {
  test("a base declaration and a state override are two rules, base first", () => {
    /* The defect this whole engine exists for: the base property used to be written INLINE and the
       `:hover` rule to a `<style>` tag, so the override could never win. As two rules in one sheet
       they are an ordinary equal-specificity pair and source order decides. */
    const rules = css.buildStyleRules(
      { ":hover": { backgroundColor: "#15164a" }, backgroundColor: "#6e0303", fontSize: "45px" },
      { scope: ".s" },
    );
    expect(textsOf(rules)).toEqual([
      ".s { background-color: #6e0303; font-size: 45px }",
      ".s:hover { background-color: #15164a }",
    ]);
  });

  test("selector then @media — the order the runtime used to drop", () => {
    const rules = css.buildStyleRules(
      { ":hover": { "@--md": { color: "blue" }, color: "red" } },
      { mediaQueries: { "--md": "(min-width: 40rem)" }, scope: ".s" },
    );
    expect(textsOf(rules)).toEqual([
      ".s:hover { color: red }",
      "@media (min-width: 40rem) { .s:hover { color: blue } }",
    ]);
  });

  test("@media then selector then pseudo — the order the compiler used to drop", () => {
    const rules = css.buildStyleRules(
      { "@(min-width: 40rem)": { li: { ":hover": { color: "blue" } } } },
      { scope: ".s" },
    );
    expect(textsOf(rules)).toEqual(["@media (min-width: 40rem) { .s li:hover { color: blue } }"]);
  });

  test("at-rules nest into each other to any depth", () => {
    const rules = css.buildStyleRules(
      { "@supports (display: grid)": { "@(min-width: 40rem)": { display: "grid" } } },
      { scope: ".s" },
    );
    expect(textsOf(rules)).toEqual([
      "@supports (display: grid) { @media (min-width: 40rem) { .s { display: grid } } }",
    ]);
  });
});

describe("buildStyleRules classifies what a rule points at", () => {
  test("compounding keys stay on the element; a descendant key does not", () => {
    const rules = css.buildStyleRules(
      { "& > li": { color: "b" }, ".wide": { color: "c" }, ":hover": { color: "a" } },
      { scope: ".s" },
    );
    expect(rules.map((r) => [r.selector, r.target])).toEqual([
      [".s > li", "descendant"],
      [".s.wide", "self"],
      [".s:hover", "self"],
    ]);
  });

  test("a declaration-body at-rule is unscoped and keeps no selector", () => {
    // `@position-try --flip { … }` IS the body; wrapping it in a selector makes the parser drop it.
    const rules = css.buildStyleRules(
      { "@position-try --flip": { insetBlockStart: "auto" } },
      { scope: ".s" },
    );
    expect(rules).toMatchObject([
      {
        selector: null,
        target: "unscoped",
        text: "@position-try --flip { inset-block-start: auto }",
      },
    ]);
  });

  test("a descendant classification survives further compounding", () => {
    const rules = css.buildStyleRules({ li: { ":hover": { color: "a" } } }, { scope: ".s" });
    expect(rules.map((r) => [r.selector, r.target])).toEqual([[".s li:hover", "descendant"]]);
  });
});

describe("buildStyleRules on values", () => {
  test("custom property names are never kebab-cased", () => {
    // `--fooBar` and `--foo-bar` are two different properties; renaming one orphans its `var()`.
    const rules = css.buildStyleRules({ "--fooBar": "1px", fontSize: "2rem" }, { scope: ".s" });
    expect(textsOf(rules)).toEqual([".s { --fooBar: 1px; font-size: 2rem }"]);
  });

  test("a $ref is a value, not a nested selector", () => {
    const seen: [string, unknown][] = [];
    const rules = css.buildStyleRules(
      { color: { $ref: "#/state/tint" } },
      {
        resolveValue: (property, value) => {
          seen.push([property, value]);
          return "var(--jx-r0)";
        },
        scope: ".s",
      },
    );
    expect({ rules: textsOf(rules), seen }).toEqual({
      rules: [".s { color: var(--jx-r0) }"],
      seen: [["color", { $ref: "#/state/tint" }]],
    });
  });

  test("with no resolver, a $ref and a template are dropped rather than emitted", () => {
    const rules = css.buildStyleRules(
      { color: { $ref: "#/state/tint" }, fontSize: "${state.size}", margin: "0" },
      { scope: ".s" },
    );
    expect(textsOf(rules)).toEqual([".s { margin: 0 }"]);
  });

  test("a template inside a nested block reaches the resolver too", () => {
    // Defect 4: `${…}` used to reach the sheet literally from anywhere but the top level.
    const rules = css.buildStyleRules(
      { ":hover": { color: "${state.tint}" } },
      { resolveValue: () => "var(--jx-r0)", scope: ".s" },
    );
    expect(textsOf(rules)).toEqual([".s:hover { color: var(--jx-r0) }"]);
  });

  test("the value transposer runs on every declaration, at every depth", () => {
    const rules = css.buildStyleRules(
      { "@(min-width: 1px)": { ":hover": { width: "50vw" } }, width: "10vw" },
      { scope: ".s", transposeValue: (value) => value.replace("vw", "cqw") },
    );
    expect(textsOf(rules)).toEqual([
      ".s { width: 10cqw }",
      "@media (min-width: 1px) { .s:hover { width: 50cqw } }",
    ]);
  });
});

describe("buildStyleRules on selectors", () => {
  test("the selector transposer can rewrite a rule or refuse it entirely", () => {
    const rules = css.buildStyleRules(
      { ":popover-open": { color: "a" }, "::backdrop": { color: "b" } },
      { scope: ".s", transposeSelector: css.transposeCanvasPopoverSelector },
    );
    expect(textsOf(rules)).toEqual([".s[data-jx-popover-open] { color: a }"]);
  });

  test("a scheme-pure query dual-emits, and the forced copy keeps recursing", () => {
    const rules = css.buildStyleRules(
      { "@(prefers-color-scheme: dark)": { "@--md": { color: "b" }, color: "a" } },
      { mediaQueries: { "--md": "(min-width: 40rem)" }, scope: ".s" },
    );
    expect(textsOf(rules)).toEqual([
      "@media (prefers-color-scheme: dark) { :where(:root:not([data-color-scheme])) .s { color: a } }",
      "@media (prefers-color-scheme: dark) { @media (min-width: 40rem) { :where(:root:not([data-color-scheme])) .s { color: b } } }",
      ':where(:root[data-color-scheme="dark"]) .s { color: a }',
      '@media (min-width: 40rem) { :where(:root[data-color-scheme="dark"]) .s { color: b } }',
    ]);
  });

  test("`@--` names no query and emits nothing", () => {
    // The canvas base-width block. Resolved, it would emit the invalid `@media --`.
    expect(css.buildStyleRules({ "@--": { width: "1280px" } }, { scope: ".s" })).toEqual([]);
  });

  test("no `&` ever reaches the output", () => {
    /* Jx flattens nesting itself. It has to: `.child` COMPOUNDS here where CSS Nesting would make
       it a descendant, so handing `&` to a parser would silently change what a style object means. */
    const rules = css.buildStyleRules(
      { "& .inner": { "&:hover": { color: "a" } } },
      { scope: ".s" },
    );
    expect(textsOf(rules).join("\n")).not.toContain("&");
  });

  test("a scalar under a selector key is an invalid shape and is dropped", () => {
    expect(css.buildStyleRules({ ":hover": "red", color: "blue" }, { scope: ".s" })).toMatchObject([
      { text: ".s { color: blue }" },
    ]);
  });
});

describe("hashCss keys a rule by what it says", () => {
  test("identical style objects produce identical keys", () => {
    const of = () => css.buildStyleRules({ ":hover": { color: "b" }, color: "a" }, { scope: ".s" });
    expect(of().map((r) => r.key)).toEqual(of().map((r) => r.key));
  });

  test("a changed value changes the key", () => {
    const [a] = css.buildStyleRules({ color: "a" }, { scope: ".s" });
    const [b] = css.buildStyleRules({ color: "b" }, { scope: ".s" });
    expect(a?.key === b?.key).toBe(false);
  });

  test("it stays base36 when the mix goes negative", () => {
    // `>>> 0` before `toString(36)`, or a hash lands as `-1x2y` and reads as two dashed idents.
    for (const input of ["a", "the-quick-brown-fox", ".s:hover { color: rebeccapurple }"]) {
      expect({ input, key: css.hashCss(input) }).toMatchObject({
        input,
        key: expect.stringMatching(/^[0-9a-z]+$/),
      });
    }
  });
});
