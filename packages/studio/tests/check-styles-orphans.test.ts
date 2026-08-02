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
  collect,
  extractCssTemplates,
  extractDefinedClasses,
  extractEmittedClasses,
  extractSelectorPreludes,
  extractStyleBlocks,
  report,
  scanHex,
  templateLiterals,
} from "../scripts/check-styles";
import type { StyleCheckResult } from "../scripts/check-styles";

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
    writeFileSync(
      join(root, "index.html"),
      "<style>.kept { font-size: 12px } @media print { .nested { gap: 1px } }</style>",
    );
    writeFileSync(join(root, "canvas.html"), "<style>.canvas-only { display: block }</style>");
    writeFileSync(join(root, "src", "a.css"), ".from-css { color: red }");
    writeFileSync(
      join(root, "src", "inject.ts"),
      "const css = `.injected { position: absolute; }`;\n",
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
});

describe("report", () => {
  const empty: StyleCheckResult = {
    hexErrors: [],
    pxWarnings: [],
    orphans: [],
    staleAllowed: [],
    allOrphans: [],
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
});
