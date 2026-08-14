/**
 * The three CI gate scripts, at the shapes their own suites never fed them.
 *
 * Everything here runs against fixtures, for the reason `check-styles-orphans.test.ts` gives: an
 * assertion about the live tree turns every unrelated PR red. What is pinned down is the handful of
 * paths a clean tree happens not to take — an escaped quote inside a string, a nested call inside a
 * `classMap`, a source file that grew a bare `catch`, a modal card left under its own scrim, an
 * icon registered for nobody, and an overload signature, which is a function declaration with no
 * body at all.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collect,
  extractEmittedClasses,
  report,
  scanBannedIdentifiers,
  stripCommentsAndStrings,
} from "../scripts/check-styles";
import type { StyleCheckResult } from "../scripts/check-styles";
import { iconProblems } from "../scripts/check-icons";
import { analyzeFocusScope } from "../scripts/check-pane-singletons";

/* ── check-styles: the source-text scanners ─────────────────────────────────── */

describe("stripCommentsAndStrings", () => {
  test("an escaped quote does not end the string — the name behind it stays prose", () => {
    // Reading `\"` as the closing quote spills the rest of the literal back out as CODE, and the
    // Banned-identifier rule then fires on a name that is only ever inside a string.
    const source = String.raw`const a = "x\"statusMessage\"y";`;
    const out = stripCommentsAndStrings(source);
    expect(out).toBe(`const a = "${" ".repeat(19)}";`);
    expect(out).toHaveLength(source.length);
    expect(scanBannedIdentifiers("src/a.ts", out)).toEqual([]);
  });

  test("a trailing backslash run does not swallow the code after the literal", () => {
    // `"a\\"` ends at its own closing quote: the second backslash is escaped, not an escaper.
    const out = stripCommentsAndStrings(String.raw`const sep = "a\\"; statusMessage();`);
    expect(out).toBe(`const sep = "${"   "}"; statusMessage();`);
    expect(scanBannedIdentifiers("src/a.ts", out)).toHaveLength(1);
  });

  test("back-to-back escapes each move the reader two characters, not one", () => {
    /* The two cases above pin how WIDE an escape is; this one pins that the reader RESUMES past it.
       `"\n\\"` is two escapes in a row, so a reader that inspects the character it just skipped
       sees the `\` of `\\`, treats it as an escaper of the closing quote, and runs the literal to
       the end of the line — blanking a real banned identifier along with it. */
    const source = String.raw`const p = "\n\\" + statusMessage;`;
    const out = stripCommentsAndStrings(source);
    expect(out).toBe(`const p = "${"    "}" + statusMessage;`);
    expect(out).toHaveLength(source.length);
    expect(scanBannedIdentifiers("src/a.ts", out)).toEqual([
      {
        file: "src/a.ts",
        line: 1,
        text: "statusMessage — use notify.success / notify.warn / notify.error from src/services/notify.ts",
      },
    ]);
  });
});

describe("extractEmittedClasses", () => {
  const names = (source: string): string[] => [...extractEmittedClasses(source).keys()].toSorted();

  test("a nested call inside classMap does not truncate the object", () => {
    // The inner `)` of `isOpen(row)` closes nothing: stopping there would end the classMap body
    // Mid-object and every key after the call would go uncollected — an orphan the gate never sees.
    const source = 'html`<li class=${classMap({ open: isOpen(row), "row-tail": true })}></li>`;';
    expect(names(source)).toEqual(["open", "row-tail"]);
  });

  test("a nested call inside classList.add does not truncate the argument list", () => {
    // Two rules at once: the argument span runs to the OUTER `)`, and the literal reader walks
    // Past `prefix(kind)` a character at a time rather than reading `p` as an opening quote.
    expect(names('el.classList.add(prefix(kind), "is-ghost");')).toEqual(["is-ghost"]);
  });
});

/* ── check-styles: the whole-tree walk and the reporter ─────────────────────── */

describe("collect", () => {
  let root: string;
  let result: StyleCheckResult;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "jx-gate-scripts-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<head></head>");
    writeFileSync(join(root, "canvas.html"), "<head></head>");
    writeFileSync(
      join(root, "src", "silent.ts"),
      [
        "export function probe() {",
        "  try { risky(); } catch {}",
        "  try { other(); } catch (error) {}",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src", "loud.ts"),
      "export function ok() {\n  try { risky(); } catch (error) { notify.error(String(error)); }\n}",
    );
    result = await collect(root);
  });

  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });

  test("a file that grew bare empty catches is reported with the count it actually has", () => {
    expect(result.silentCatches).toContainEqual({ allowed: 0, file: "src/silent.ts", found: 2 });
  });

  test("a file whose catches all do something is not in the list at all", () => {
    expect(result.silentCatches.map((c) => c.file)).not.toContain("src/loud.ts");
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
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("fails on a card left under its own scrim, naming the card and its line", () => {
    const underScrim = [
      { file: "src/panels/publish-panel.ts", line: 42, text: ".progress-modal is not stacked" },
    ];
    expect(report({ ...empty, underScrim })).toBe(1);
    const said = logs.join("\n");
    expect(said).toContain("1 modal card(s) opened under their own scrim");
    expect(said).toContain("src/panels/publish-panel.ts:42");
    expect(said).toContain(".progress-modal is not stacked");
  });

  test("the same result with the card lifted passes and says every card is stacked", () => {
    expect(report(empty)).toBe(0);
    expect(logs.join("\n")).toContain("every underlay-bearing card stacked above its scrim");
  });
});

/* ── check-icons ────────────────────────────────────────────────────────────── */

describe("iconProblems", () => {
  const base = {
    imported: new Map([["IconGhost", "real/IconGhost.js"]]),
    installed: (specifier: string) => specifier.startsWith("real/"),
    keys: new Map<string, string>(),
    registered: new Set<string>(),
    rows: new Set<string>(),
    tags: new Map<string, string[]>(),
  };

  test("a registration no template writes is a dead row, and the message says both fixes", () => {
    // Imported, installed, and drawn by nobody: the registry row is either stale or the tag is
    // Written by a Spectrum component's own shadow DOM — which is what UNWRITTEN is for.
    const [problem, ...rest] = iconProblems({ ...base, registered: new Set(["sp-icon-ghost"]) });
    expect(rest).toEqual([]);
    expect(problem).toContain("sp-icon-ghost is registered as an element");
    expect(problem).toContain("no template writes <sp-icon-ghost>");
    expect(problem).toContain("UNWRITTEN");
  });

  test("…and writing the tag anywhere silences it", () => {
    expect(
      iconProblems({
        ...base,
        registered: new Set(["sp-icon-ghost"]),
        tags: new Map([["sp-icon-ghost", ["panels/a.ts"]]]),
      }),
    ).toEqual([]);
  });
});

/* ── check-pane-singletons ──────────────────────────────────────────────────── */

describe("analyzeFocusScope", () => {
  test("an overload signature has no body, and the walk reads through it to the implementation", async () => {
    /* `topLevelFunctions` hands back BOTH declarations of an overloaded function, and the first of
       them has no body at all. The forwarder test has to say so rather than reach into `.body.kind`
       — and the implementation behind it is still a focus reader, so `drawStage` is still charged
       one hop for calling it. */
    const dir = await mkdtemp(join(tmpdir(), "jx-gate-overload-"));
    try {
      const file = join(dir, "overload.ts");
      await writeFile(
        file,
        [
          "export function focusedTabId(prefix: string): string;",
          "export function focusedTabId(prefix: number): string;",
          "export function focusedTabId(prefix: string | number): string {",
          "  return `${prefix}${activeTab.value?.id ?? ''}`;",
          "}",
          "export function drawStage(surface: CanvasSurface) {",
          "  return focusedTabId('x');",
          "}",
        ].join("\n"),
        "utf8",
      );
      const found = await analyzeFocusScope([file]);
      expect(found.get(file)).toEqual([{ line: 7, name: "focusedTabId()", via: "focusedTabId" }]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 30_000);
});
