/**
 * The styling gate (`scripts/check-styles.ts`) — the orphan-class rule in particular.
 *
 * Everything here runs against fixtures rather than the live tree: asserting "the studio has N
 * orphans" would turn every unrelated PR red, and the live-tree assertion is `bun run lint:styles`
 * anyway. What these tests pin down is the extraction logic, which is where the false positives
 * that get a gate switched off would come from.
 */
import "./harness";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_ORPHANS,
  FOCUS_RING_ALLOWANCES,
  checkFocusRings,
  collect,
  cssOfHtml,
  extractCssTemplates,
  extractDefinedClasses,
  extractEmittedClasses,
  extractRules,
  extractSelectorPreludes,
  extractStyleBlocks,
  countBareCatches,
  focusKey,
  normalizeSelector,
  report,
  scanBannedIdentifiers,
  scanHex,
  stackedClasses,
  extractUnderlayCards,
  stripCommentsAndStrings,
  templateLiterals,
} from "../scripts/check-styles";
import type { FocusRingAllowance, StyleCheckResult } from "../scripts/check-styles";

const names = (source: string): string[] => [...extractEmittedClasses(source).keys()].toSorted();

describe("extractEmittedClasses", () => {
  test("reads a literal class attribute, single or double quoted", () => {
    expect(names('html`<div class="row row--wide"></div>`')).toEqual(["row", "row--wide"]);
    expect(names("html`<div class='row'></div>`")).toEqual(["row"]);
  });

  test("drops a token that is partly interpolated, keeping its literal siblings", () => {
    expect(names('html`<div class="tab tab-${kind} active"></div>`')).toEqual(["active", "tab"]);
  });

  test("reads only value-position literals out of `class=${…}`", () => {
    // `"grid"` is the right-hand side of a comparison — nobody's class name.
    const src = 'html`<div class=${layout === "grid" ? "body--grid" : "body"}></div>`';
    expect(names(src)).toEqual(["body", "body--grid"]);
  });

  test("reads a literal behind && and ??", () => {
    expect(names('html`<i class=${bad && "is-error"}></i>`')).toEqual(["is-error"]);
    expect(names('html`<i class=${label ?? "untitled"}></i>`')).toEqual(["untitled"]);
  });

  test("skips a class held in a variable", () => {
    expect(names("html`<div class=${columnClass}></div>`")).toEqual([]);
  });

  test("skips an unquoted, non-interpolated attribute value", () => {
    expect(names("html`<div class=row></div>`")).toEqual([]);
  });

  test("reads classMap keys, quoted and bare", () => {
    const src = 'class=${classMap({ "layer-row": true, selected: isSelected })}';
    expect(names(src)).toEqual(["layer-row", "selected"]);
  });

  test("skips a computed classMap key", () => {
    expect(names("classMap({ [`tab-${kind}`]: true })")).toEqual([]);
  });

  test("reads classList.add and .remove arguments", () => {
    expect(names('el.classList.add("dragging", "is-ghost");')).toEqual(["dragging", "is-ghost"]);
    expect(names('el.classList.remove("drop-above", "drop-below");')).toEqual([
      "drop-above",
      "drop-below",
    ]);
  });

  test("reads only the first argument of classList.toggle", () => {
    // The second argument is the force condition — `"stale"` there is a state value, not a class.
    expect(names('el.classList.toggle("cell--stale", state === "stale");')).toEqual([
      "cell--stale",
    ]);
  });

  test("skips a classList argument held in a variable", () => {
    expect(names("el.classList.add(activeClass);")).toEqual([]);
  });

  test("reads className assignment and setAttribute", () => {
    expect(names('el.className = "jx-drag-ghost";')).toEqual(["jx-drag-ghost"]);
    expect(names('el.className += "is-open";')).toEqual(["is-open"]);
    expect(names('el.setAttribute("class", "overlay-box");')).toEqual(["overlay-box"]);
  });

  test("skips a className assigned from a variable", () => {
    expect(names("el.className = computed;")).toEqual([]);
  });

  test("keeps an escape sequence inside the value intact", () => {
    expect(names(String.raw`el.className = "a\-b";`)).toEqual([String.raw`a\-b`]);
  });

  test("records the line of the first emission and dedupes later ones", () => {
    const src = [
      "const a = 1;",
      "",
      'html`<div class="row"></div>`;',
      "",
      'html`<p class="row"></p>`;',
    ].join("\n");
    expect(extractEmittedClasses(src).get("row")).toBe(3);
  });

  test("survives an unterminated interpolation or argument list", () => {
    expect(names('html`<div class="a ${b')).toEqual(["a"]);
    expect(names('classMap({ "a-b": true')).toEqual(["a-b"]);
  });
});

describe("extractSelectorPreludes / extractDefinedClasses", () => {
  test("collects classes from nested at-rules", () => {
    const css = "@media (min-width: 40em) { .wide { gap: 4px } }";
    expect([...extractDefinedClasses(css)]).toEqual(["wide"]);
  });

  test("collects compound and combinator selectors", () => {
    const css = ".tab.active > .tab-label, .tab:hover .tab-label { color: red }";
    expect([...extractDefinedClasses(css)].toSorted()).toEqual(["active", "tab", "tab-label"]);
  });

  test("ignores dots inside declarations", () => {
    const css = ".hero { background: url(./bg.png); opacity: 0.5; transition: all .2s }";
    expect([...extractDefinedClasses(css)]).toEqual(["hero"]);
  });

  test("ignores commented-out rules", () => {
    expect([...extractDefinedClasses("/* .dead { color: red } */ .live { color: red }")]).toEqual([
      "live",
    ]);
  });

  test("drops the trailing text after the last brace", () => {
    expect(extractSelectorPreludes(".a { color: red } .b")).toEqual([".a "]);
  });
});

describe("extractStyleBlocks", () => {
  test("returns the body of every style element", () => {
    const html = '<head><style>.a{color:red}</style><style id="x">.b{color:red}</style></head>';
    expect(extractStyleBlocks(html)).toEqual([".a{color:red}", ".b{color:red}"]);
  });

  test("returns nothing for a document without styles", () => {
    expect(extractStyleBlocks("<head></head>")).toEqual([]);
  });
});

describe("cssOfHtml", () => {
  test("keeps the CSS where it was, so a finding can name the document's own line", () => {
    const html = ["<head>", "<style>", ".a { color: red }", "</style>", "</head>"].join("\n");
    const css = cssOfHtml(html);
    expect(css.split("\n")).toHaveLength(5);
    expect(extractRules(css)[0]).toMatchObject({ line: 3, selectors: [".a"] });
  });

  test("blanks markup rather than deleting it, across several blocks", () => {
    const html = '<b>x</b><style>.a{color:red}</style><i>y</i><style id="s">.b{color:red}</style>';
    const css = cssOfHtml(html);
    expect(css).not.toContain("<b>");
    expect(css).toHaveLength(html.length);
    expect(extractRules(css).flatMap((r) => r.selectors)).toEqual([".a", ".b"]);
  });

  test("a document with no styles yields no rules at all", () => {
    expect(extractRules(cssOfHtml("<head></head>"))).toEqual([]);
  });
});

// ─── The focus-ring rule ──────────────────────────────────────────────────────

describe("normalizeSelector", () => {
  test("collapses the whitespace a multi-line prelude carries", () => {
    expect(normalizeSelector("  .a\n  .b  ")).toBe(".a .b");
  });
});

describe("extractRules", () => {
  test("pairs a prelude with its declarations and its line", () => {
    const css = ["/* lead-in", "   spanning lines */", ".a,", ".b { color: red }"].join("\n");
    expect(extractRules(css)).toEqual([{ body: " color: red ", line: 3, selectors: [".a", ".b"] }]);
  });

  test("descends into at-rules and never reports one as a rule", () => {
    const rules = extractRules("@media print { .wide { gap: 4px } }");
    expect(rules.map((r) => r.selectors)).toEqual([[".wide"]]);
  });

  test("a statement at-rule does not glue itself to the next selector", () => {
    // `;` ends `@import` as surely as `}` ends a block; without that reset the prelude would read
    // `@import "x"; .a` and the rule would be discarded as an at-rule.
    expect(extractRules('@import "x";\n.a { color: red }').map((r) => r.selectors)).toEqual([
      [".a"],
    ]);
  });

  test("keeps a comma inside :not() out of the split", () => {
    expect(extractRules(".a:not(.b, .c) { color: red }")[0]?.selectors).toEqual([".a:not(.b, .c)"]);
  });

  test("ignores a commented-out rule and trailing text after the last brace", () => {
    expect(extractRules("/* .dead { outline: none } */ .live { color: red } .trailing")).toEqual([
      { body: " color: red ", line: 1, selectors: [".live"] },
    ]);
  });
});

describe("checkFocusRings", () => {
  const allow = (over: Partial<FocusRingAllowance> = {}): FocusRingAllowance[] => [
    {
      file: "styles/a.css",
      restoredBy: ".field:focus-visible",
      selector: ".field",
      ...over,
    },
  ];
  const paired = ".field { outline: none }\n.field:focus-visible { outline: 2px solid red }";

  test("an allowed suppression whose restore is present passes, and is reported as seen", () => {
    const { findings, suppressed } = checkFocusRings("styles/a.css", paired, allow());
    expect(findings).toEqual([]);
    expect(suppressed).toEqual([focusKey("styles/a.css", ".field")]);
  });

  test("a suppression nobody allowed fails at its own line", () => {
    const { findings } = checkFocusRings("styles/a.css", `\n${paired}`, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "styles/a.css", line: 2 });
    expect(findings[0]!.text).toContain("no allowance");
  });

  test("DELETING the restore fails the allowance — the rule a plain ban could not have", () => {
    const { findings } = checkFocusRings("styles/a.css", ".field { outline: none }", allow());
    expect(findings[0]!.text).toContain("no longer sets an outline");
  });

  test("a restore that has stopped drawing anything is no restore", () => {
    // The `:focus-visible` rule is still there and still named — it just puts nothing back, which
    // Is the same outcome as deleting it and looks, in a diff, like a tidy-up.
    const css = ".field { outline: none }\n.field:focus-visible { outline: 0 }";
    const { findings } = checkFocusRings("styles/a.css", css, allow());
    expect(findings[0]!.text).toContain("no longer sets an outline");
  });

  test("the restore must be keyboard-scoped, not merely somewhere else in the file", () => {
    const css = ".field { outline: none }\n.field:hover { outline: 2px solid red }";
    const { findings } = checkFocusRings(
      "styles/a.css",
      css,
      allow({ restoredBy: ".field:hover" }),
    );
    expect(findings[0]!.text).toContain("not a :focus-visible rule");
  });

  test("an allowance for another stylesheet does not cover this one", () => {
    const { findings } = checkFocusRings("styles/b.css", paired, allow());
    expect(findings[0]!.text).toContain("no allowance");
  });

  test("a grouped suppression is TWO suppressions, each needing its own restore", () => {
    // The shape the studio actually had: `.jx-grid-input, .jx-grid-select { outline: none }` with a
    // Restore for the picker alone, so the text cell was keyboard-focusable and showed nothing.
    const css = [
      ".one, .two { outline: none }",
      ".two:focus-visible { outline: 2px solid red }",
    ].join("\n");
    const allowances: FocusRingAllowance[] = [
      { file: "styles/a.css", restoredBy: ".one:focus-visible", selector: ".one" },
      { file: "styles/a.css", restoredBy: ".two:focus-visible", selector: ".two" },
    ];
    const { findings, suppressed } = checkFocusRings("styles/a.css", css, allowances);
    expect(suppressed).toHaveLength(2);
    expect(findings.map((f) => f.text.split(" —")[0])).toEqual([".one"]);
  });

  test("`outline: 0` is the same removal spelled shorter", () => {
    expect(checkFocusRings("styles/a.css", ".field { outline: 0 }", []).findings).toHaveLength(1);
  });

  test("!important does not smuggle a suppression past the rule", () => {
    const css = ".field { outline: none !important }";
    expect(checkFocusRings("styles/a.css", css, []).findings).toHaveLength(1);
  });

  test("outline-offset is a different property and is not read as a removal", () => {
    expect(checkFocusRings("styles/a.css", ".field { outline-offset: 0 }", []).findings).toEqual(
      [],
    );
  });

  test("whitespace in the allow-list entry is not load-bearing", () => {
    const css =
      ".wrap   .field {\n  outline: none;\n}\n.wrap .field:focus-visible { outline: 1px }";
    const allowances: FocusRingAllowance[] = [
      { file: "styles/a.css", restoredBy: ".wrap  .field:focus-visible", selector: ".wrap .field" },
    ];
    expect(checkFocusRings("styles/a.css", css, allowances).findings).toEqual([]);
  });

  test("the studio's own allow-list names a :focus-visible restore for every entry", () => {
    // Cheap, and it is the half of the entry a typo would otherwise disable silently: an entry
    // Whose `restoredBy` is not keyboard-scoped reports a DIFFERENT failure than the one meant.
    for (const allowance of FOCUS_RING_ALLOWANCES) {
      expect(allowance.restoredBy).toContain(":focus-visible");
      expect(allowance.file).toMatch(/\.css$|\.html$/);
    }
  });
});

describe("templateLiterals / extractCssTemplates", () => {
  test("collapses interpolations to a sentinel that never reads as a class token", () => {
    expect(templateLiterals("const a = `x-${y}-z`;")[0]).not.toContain("${");
  });

  test("keeps stylesheet templates and drops markup templates", () => {
    const src = [
      "const css = `.overlay-box { position: absolute; }`;",
      'const tpl = html`<div class="row">${label}</div>`;',
    ].join("\n");
    expect(extractCssTemplates(src)).toEqual([".overlay-box { position: absolute; }"]);
  });
});

describe("scanHex", () => {
  test("flags a raw hex", () => {
    const { errors } = scanHex("src/a.ts", "color: #123456;");
    expect(errors).toEqual([{ file: "src/a.ts", line: 1, text: "color: #123456;" }]);
  });

  test("allows a brand hex and a var() fallback", () => {
    expect(scanHex("src/a.ts", "color: #ff5f57;").errors).toEqual([]);
    expect(scanHex("src/a.ts", "color: var(--accent, #123456);").errors).toEqual([]);
  });

  test("allows any hex in a colour-data file", () => {
    expect(scanHex("src/ui/color-selector.ts", "#123456").errors).toEqual([]);
  });

  test("warns on px literals that have a Spectrum token", () => {
    const { warnings } = scanHex("src/a.ts", "font-size: 12px; border-radius: 4px;");
    expect(warnings).toHaveLength(2);
    expect(scanHex("src/a.ts", "font-size: 13px; border-radius: 7px;").warnings).toEqual([]);
  });
});

describe("collect", () => {
  let root: string;
  let result: StyleCheckResult;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "jx-check-styles-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "styles"), { recursive: true });
    writeFileSync(
      join(root, "styles", "x.css"),
      [
        ".styled { color: red }",
        ".paired { outline: none }",
        ".paired:focus-visible { outline: 2px solid red }",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "index.html"),
      [
        "<style>.kept { font-size: 12px } @media print { .nested { gap: 1px } }",
        ".shell-input { outline: none }</style>",
      ].join("\n"),
    );
    writeFileSync(join(root, "canvas.html"), "<style>.canvas-only { display: block }</style>");
    writeFileSync(
      join(root, "src", "a.css"),
      ".from-css { color: red }\n.bare-focus { outline: none }",
    );
    writeFileSync(
      join(root, "src", "inject.ts"),
      "const css = `.injected { position: absolute; }`;\n",
    );
    /* Two modal bodies, identical but for one declaration: the scrim paints at z-index 1, so the
       one with no z-index is under it — visible through the scrim, and unclickable. */
    writeFileSync(
      join(root, "styles", "modals.css"),
      ".lifted { position: fixed; z-index: 1000 }\n.sunken { position: fixed }",
    );
    writeFileSync(
      join(root, "src", "modals.ts"),
      [
        'html`<sp-underlay open></sp-underlay><div class="lifted">ok</div>`;',
        'html`<sp-underlay open></sp-underlay><div class="sunken">unclickable</div>`;',
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src", "app.ts"),
      [
        'html`<div class="kept nested canvas-only from-css injected"></div>`;',
        'html`<div class="orphan-one"></div>`;',
        'el.className = "orphan-two";',
        'el.classList.add("monaco-hover", "sp-picker", "tabulator-cell");',
        "el.style.color = '#123456';",
      ].join("\n"),
    );
    result = await collect(root);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("reports only classes that no stylesheet defines", () => {
    expect(result.allOrphans.map((o) => o.text)).toEqual(["orphan-one", "orphan-two"]);
  });

  test("credits definitions from index.html, canvas.html, .css files and injected CSS", () => {
    const orphaned = new Set(result.allOrphans.map((o) => o.text));
    for (const defined of ["kept", "nested", "canvas-only", "from-css", "injected"]) {
      expect(orphaned.has(defined)).toBe(false);
    }
  });

  test("ignores vendor classes whose stylesheet is bundled, not committed", () => {
    const orphaned = new Set(result.allOrphans.map((o) => o.text));
    for (const vendor of ["monaco-hover", "sp-picker", "tabulator-cell"]) {
      expect(orphaned.has(vendor)).toBe(false);
    }
  });

  test("points each orphan at its first emission site", () => {
    expect(result.allOrphans[0]).toEqual({ file: "src/app.ts", line: 2, text: "orphan-one" });
  });

  test("still runs the hex and px rules over html and ts", () => {
    expect(result.hexErrors.map((e) => e.file)).toEqual(["src/app.ts"]);
    expect(result.pxWarnings.map((w) => w.file)).toEqual(["index.html"]);
  });

  test("reports every allow-listed name that is no longer orphaned as stale", () => {
    // The fixture emits none of the studio's backlog, so all of it comes back stale — which is the
    // Ratchet: an entry that stops being an orphan has to be deleted from the list.
    expect(result.staleAllowed).toEqual([...ALLOWED_ORPHANS].toSorted());
  });

  test("excludes allow-listed names from the failing set", () => {
    const allowed = [...ALLOWED_ORPHANS][0]!;
    expect(result.orphans.some((o) => o.text === allowed)).toBe(false);
  });

  test("runs the focus-ring rule over html style blocks and over .css files alike", () => {
    expect(result.focusRings.map((f) => `${f.file}:${f.line}`)).toEqual([
      "index.html:2",
      "styles/x.css:2",
      "src/a.css:2",
    ]);
  });

  test("a correctly paired suppression still needs an entry — the list is closed", () => {
    // `styles/x.css` restores its own ring properly and is reported anyway. The entry is not
    // Bookkeeping for the check's benefit: it is the record that somebody decided a control may
    // Lose its pointer ring, which is the decision worth reviewing.
    const paired = result.focusRings.find((f) => f.file === "styles/x.css")!;
    expect(paired.text).toContain("no allowance");
  });

  test("reports a modal card that no rule lifts above its own underlay", () => {
    expect(result.underScrim.map((u) => `${u.file}:${u.line}`)).toEqual(["src/modals.ts:2"]);
    expect(result.underScrim[0]!.text).toContain(".sunken");
  });

  test("reports every allowance the tree no longer needs as stale — the same ratchet", () => {
    // The fixture contains none of the studio's six suppressions, so all six come back stale.
    expect(result.staleFocusRings).toEqual(
      FOCUS_RING_ALLOWANCES.map((a) => focusKey(a.file, a.selector)).toSorted(),
    );
  });
});

describe("report", () => {
  const empty: StyleCheckResult = {
    hexErrors: [],
    pxWarnings: [],
    orphans: [],
    staleAllowed: [],
    allOrphans: [],
    banned: [],
    silentCatches: [],
    focusRings: [],
    staleFocusRings: [],
    underScrim: [],
  };
  const finding = (text: string): { file: string; line: number; text: string } => ({
    file: "src/a.ts",
    line: 1,
    text,
  });
  const logs: string[] = [];
  const sink = (...args: unknown[]): void => {
    logs.push(args.join(" "));
  };
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeAll(() => {
    spies = [
      spyOn(console, "log").mockImplementation(sink),
      spyOn(console, "warn").mockImplementation(sink),
      spyOn(console, "error").mockImplementation(sink),
    ];
  });

  afterEach(() => {
    logs.length = 0;
  });

  afterAll(() => {
    for (const s of spies) {
      s.mockRestore();
    }
  });

  test("passes a clean result", () => {
    expect(report(empty)).toBe(0);
    expect(logs.join("\n")).toContain("no undefined classes");
  });

  test("passes with px nudges, truncating a long list", () => {
    const pxWarnings = Array.from({ length: 25 }, (_, i) => finding(`w${i}`));
    expect(report({ ...empty, pxWarnings })).toBe(0);
    expect(logs.join("\n")).toContain("…and 5 more");
    expect(logs.join("\n")).toContain("25 px token nudge(s)");
  });

  test("does not truncate a short px list", () => {
    expect(report({ ...empty, pxWarnings: [finding("w")] })).toBe(0);
    expect(logs.join("\n")).not.toContain("more");
  });

  test("fails on a hard-coded colour", () => {
    expect(report({ ...empty, hexErrors: [finding("#123456")] })).toBe(1);
    expect(logs.join("\n")).toContain("hard-coded colour(s)");
  });

  test("fails on a new orphan", () => {
    expect(report({ ...empty, orphans: [finding("brand-new")] })).toBe(1);
    expect(logs.join("\n")).toContain("brand-new");
  });

  test("fails on a stale allowlist entry", () => {
    expect(report({ ...empty, staleAllowed: ["already-styled"] })).toBe(1);
    expect(logs.join("\n")).toContain("stale ALLOWED_ORPHANS");
  });

  test("fails on a banned identifier, and says what to use instead", () => {
    expect(report({ ...empty, banned: [finding("statusMessage — use notify.error")] })).toBe(1);
    expect(logs.join("\n")).toContain("may not name");
    expect(logs.join("\n")).toContain("notify.error");
  });

  test("fails when a file grows a bare empty catch", () => {
    expect(report({ ...empty, silentCatches: [{ allowed: 0, file: "src/a.ts", found: 2 }] })).toBe(
      1,
    );
    expect(logs.join("\n")).toContain("2 bare empty catch(es), 0 allowed");
  });

  test("fails when a budget entry is stale — the ratchet only turns one way", () => {
    expect(report({ ...empty, silentCatches: [{ allowed: 3, file: "src/a.ts", found: 1 }] })).toBe(
      1,
    );
    expect(logs.join("\n")).toContain("lower its SILENT_CATCH_BUDGET entry from 3");
  });

  test("fails on an unpaired focus-ring suppression, naming the line", () => {
    expect(report({ ...empty, focusRings: [finding(".field — no allowance")] })).toBe(1);
    expect(logs.join("\n")).toContain("focus-ring problem(s)");
    expect(logs.join("\n")).toContain("src/a.ts:1");
  });

  test("fails on a stale focus-ring allowance", () => {
    expect(report({ ...empty, staleFocusRings: ["styles/a.css → .gone"] })).toBe(1);
    expect(logs.join("\n")).toContain("stale FOCUS_RING_ALLOWANCES");
  });

  test("says how many suppressions are still paired when everything is clean", () => {
    expect(report(empty)).toBe(0);
    expect(logs.join("\n")).toContain("focus-ring suppression(s) each paired");
  });
});

// ─── The silence rules ────────────────────────────────────────────────────────

describe("stripCommentsAndStrings", () => {
  test("blanks a line comment, keeping the line count", () => {
    const out = stripCommentsAndStrings("const a = 1; // statusMessage\nconst b = 2;");
    expect(out).not.toContain("statusMessage");
    expect(out.split("\n")).toHaveLength(2);
  });

  test("blanks a block comment across lines", () => {
    const out = stripCommentsAndStrings("/**\n * statusMessage was here\n */\nx();");
    expect(out).not.toContain("statusMessage");
    expect(out.split("\n")).toHaveLength(4);
  });

  test("blanks string bodies but keeps the quotes", () => {
    expect(stripCommentsAndStrings('const a = "statusMessage";')).not.toContain("statusMessage");
    expect(stripCommentsAndStrings("const a = 'x';")).toContain("'");
  });

  test("leaves code alone", () => {
    expect(stripCommentsAndStrings("statusMessage(1);")).toBe("statusMessage(1);");
  });
});

describe("scanBannedIdentifiers", () => {
  test("flags a call, naming the replacement", () => {
    const [found] = scanBannedIdentifiers("src/a.ts", 'statusMessage("hi");');
    expect(found).toMatchObject({ file: "src/a.ts", line: 1 });
    expect(found!.text).toContain("notify.success");
  });

  test("does not flag a longer identifier that merely contains it", () => {
    expect(scanBannedIdentifiers("src/a.ts", "setStatusMessageThing();")).toHaveLength(0);
  });

  test("reports the line the use is on", () => {
    const found = scanBannedIdentifiers("src/a.ts", "a();\nb();\nstatusMessage();");
    expect(found[0]!.line).toBe(3);
  });
});

describe("countBareCatches", () => {
  test("counts a catch with no body at all, bound or not", () => {
    expect(countBareCatches("try { a(); } catch {}")).toBe(1);
    expect(countBareCatches("try { a(); } catch (error) {}")).toBe(1);
  });

  test("a comment IS the answer — the rule asks which silences were chosen", () => {
    expect(countBareCatches("try { a(); } catch {\n  // intentionally ignored: no path\n}")).toBe(
      0,
    );
  });

  test("a catch that does something is not counted", () => {
    expect(countBareCatches("try { a(); } catch (error) { notify.error(String(error)); }")).toBe(0);
  });
});

describe("extractUnderlayCards", () => {
  test("takes the card beside the scrim, not the elements inside it", () => {
    const source = [
      "html`<sp-underlay open></sp-underlay>",
      '<div class="progress-modal"><div class="progress-head"><strong class="t"></strong></div></div>`;',
    ].join("\n");
    expect(extractUnderlayCards(source)).toEqual([{ classes: ["progress-modal"], line: 1 }]);
  });

  test("keeps every class on the card — any one of them may carry the z-index", () => {
    const source =
      'html`<sp-underlay open></sp-underlay><div class="new-project-modal add-repo"></div>`;';
    expect(extractUnderlayCards(source)[0]!.classes).toEqual(["new-project-modal", "add-repo"]);
  });

  test("a template with no underlay declares no card", () => {
    expect(extractUnderlayCards('html`<div class="plain"></div>`;')).toEqual([]);
  });

  test("an interpolated class token is not a name this rule can check", () => {
    const source = 'html`<sp-underlay open></sp-underlay><div class="card ${mode}"></div>`;';
    expect(extractUnderlayCards(source)[0]!.classes).toEqual(["card"]);
  });
});

describe("stackedClasses", () => {
  test("credits a positive z-index, in any rule that names the class", () => {
    expect([...stackedClasses(".a { z-index: 1000 }")]).toEqual(["a"]);
    expect([...stackedClasses(".b { position: fixed;\n  z-index: 3; }")]).toEqual(["b"]);
  });

  test("a token reference counts — the value is not this rule's business", () => {
    expect([...stackedClasses(".c { z-index: var(--layer-modal) }")]).toEqual(["c"]);
  });

  test("z-index: auto and 0 stack nothing — they are the defect", () => {
    expect([...stackedClasses(".d { z-index: auto }\n.e { z-index: 0 }")]).toEqual([]);
  });
});
