/**
 * A prose gate's failure mode is over-matching, so most of these tests are about what each rule
 * must NOT flag. The corpus is full of punctuation that looks like a violation and is not: a bare
 * em dash alone in a table cell is the value "none" written by `generators/studio-routes.ts`, an en
 * dash between two key names is a range, and the nineteen glyphs in the Studio pages are controls
 * the app draws rather than decoration. Every one of those is seeded here from the real tree.
 *
 * The RULE tests drive synthetic documents; the GOLDEN tests hold the committed tree to zero and
 * hold the budget map to being exactly the debt that is really there.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AllowEntry, ProseConfig, Rule } from "./check-prose.ts";
import { check, corpusFiles, hitsOf, isAllowed } from "./check-prose.ts";
import { maskCodeSpans, maskLine, segment, segmentJson } from "./lib/prose.ts";

const ROOT = resolve(import.meta.dir, "../..");
const config = JSON.parse(
  readFileSync(join(ROOT, "scripts/docs/prose.json"), "utf8"),
) as ProseConfig;

/** Rules seen to fire at least once, so a rule nobody has watched work cannot ship. */
const exercised = new Set<string>();

function ruleById(id: string): Rule {
  const rule = config.rules.find((r) => r.id === id);
  if (!rule) {
    throw new Error(`no rule ${id}`);
  }
  return rule;
}

function hits(id: string, markdown: string) {
  const found = hitsOf(ruleById(id), segment(markdown), "docs/x.md");
  if (found.length > 0) {
    exercised.add(id);
  }
  return found;
}

describe("the masker", () => {
  test("consumes balanced backtick runs, so a dash between two spans survives", () => {
    const line = "| a | The CI chain — generate, `git diff --exit-code -- docs`, then both |";
    expect(maskCodeSpans(line)).toContain("—");
  });

  test("a run of two backticks does not close a run of one, as CommonMark says", () => {
    // Real shape, from the shortcuts table: the span for the backtick key holds a backtick, so the
    // Span really does run on to the next SINGLE tick. Masking that far is the renderer's reading.
    const masked = maskCodeSpans("| `⌘`` | Code | `format.code` |");
    expect(masked).not.toContain("Code");
    expect(masked).toContain("format.code");
  });

  test("an unmatched backtick run is literal, not an opener", () => {
    expect(maskCodeSpans("a ` b")).toBe("a ` b");
  });

  test("a link's label survives and its target does not", () => {
    const masked = maskLine("See [the locale guide](/docs/framework/site/i18n) for more.");
    expect(masked).toContain("the locale guide");
    expect(masked).not.toContain("i18n");
  });

  test("masking preserves length, so reported columns stay true", () => {
    const line = "a `code` b [x](/y) c :kbd[⌘K] d";
    expect(maskLine(line)).toHaveLength(line.length);
  });
});

describe("the segmenter", () => {
  test("fenced code is not prose", () => {
    expect(segment("```md\nAn — in a fence\n```")).toEqual([]);
  });

  test("a tilde fence closes too", () => {
    expect(segment("~~~\nAn — here\n~~~")).toEqual([]);
  });

  test("directive markers are not sentences", () => {
    const ctxs = segment(":::doc-note\nReal prose.\n:::").map((s) => s.ctx);
    expect(ctxs).toEqual(["paragraph"]);
  });

  test("a table delimiter row carries no prose", () => {
    expect(segment("| a | b |\n| --- | --- |").filter((s) => s.ctx === "tableCell")).toHaveLength(
      2,
    );
  });

  test("frontmatter yields title and description, and nothing else", () => {
    const segs = segment('---\ntitle: "T"\ndescription: "D"\nspec:\n  - spec.md#1\n---\n\nBody.');
    expect(segs.filter((s) => s.ctx === "frontmatter").map((s) => s.raw)).toEqual(["T", "D"]);
  });

  test("the list marker is dropped, so a bullet is not read as a dash", () => {
    expect(segment("- an item").every((s) => !s.text.startsWith("-"))).toBe(true);
  });
});

describe("the JSON extractor", () => {
  // The marketing pages are Jx documents. Their copy is in `textContent` and `props.*`, sitting
  // Beside style values and `$ref` bindings that a prose rule must never see.
  const page = JSON.stringify({
    title: "Features",
    $head: [{ tagName: "meta", attributes: { content: "A page description." } }],
    children: [
      {
        tagName: "p",
        className: "lead-in",
        style: { fontSize: "clamp(1rem, 2vw, 1.5rem)" },
        textContent: "Real copy a reader sees.",
      },
      {
        tagName: "check-item",
        attributes: { "props.text": "A checked claim.", "props.href": "/docs/start" },
      },
      { tagName: "span", textContent: { $ref: "#/state/count" } },
    ],
  });

  test("reads textContent and the prose props", () => {
    expect(segmentJson(page).map((s) => s.raw)).toEqual([
      "Features",
      "Real copy a reader sees.",
      "A checked claim.",
    ]);
  });

  test("never reads a class, a style value, a href, or a $ref binding", () => {
    const raws = segmentJson(page)
      .map((s) => s.raw)
      .join(" ");
    for (const machinery of ["lead-in", "clamp", "/docs/start", "$ref", "#/state/count"]) {
      expect(raws).not.toContain(machinery);
    }
  });

  test("a span reports a line a person can find", () => {
    const hit = segmentJson(page).find((s) => s.raw === "A checked claim.");
    expect(hit?.line).toBeGreaterThan(0);
  });

  test("it would have caught the dashes the marketing pages used to carry", () => {
    const before = JSON.stringify({ children: [{ textContent: "Works offline — no cloud." }] });
    expect(segmentJson(before).filter((s) => s.text.includes("—"))).toHaveLength(1);
  });
});

describe("rules flag", () => {
  test("an em dash in a paragraph", () => {
    expect(hits("em-dash", "A sentence — with an aside — in it.")).toHaveLength(2);
  });

  test("an em dash in a table cell that also has words", () => {
    expect(hits("em-dash", "| a | needs a base — or it 404s |")).toHaveLength(1);
  });

  test("a curly quote", () => {
    expect(hits("curly-quote", "He said “yes”.")).toHaveLength(2);
  });

  test("a decorative emoji", () => {
    expect(hits("emoji", "Ship it 🚀")).toHaveLength(1);
  });

  test("negative parallelism", () => {
    expect(hits("neg-parallel", "It's not just a builder, it's a format.")).toHaveLength(1);
  });

  test("chatbot residue", () => {
    expect(hits("chatbot-residue", "I hope this helps!")).toHaveLength(1);
  });

  test("an essay-shaped heading", () => {
    expect(hits("stock-heading", "## Key takeaways")).toHaveLength(1);
  });

  test("stock AI vocabulary", () => {
    expect(hits("ai-vocab", "A comprehensive and seamless solution.")).toHaveLength(2);
  });

  test("an en dash used as punctuation", () => {
    expect(hits("en-dash", "The policy – announced today – applies.")).toHaveLength(2);
  });
});

describe("rules leave alone", () => {
  // Each case is real punctuation from this corpus that a naive rule would flag.
  const clean: [string, string, string][] = [
    ["a bare em dash alone in a table cell", "em-dash", "| `Array` | — | Mapped lists |"],
    ["an em dash inside a fence", "em-dash", "```\na — b\n```"],
    ["an em dash inside a code span", "em-dash", "Write `a — b` in the cell."],
    ["a hyphen", "em-dash", "A well-known trade-off."],
    ["a numeric range", "en-dash", "Per-format compression quality (0–100)"],
    ["a key range", "en-dash", "headings to `h1`–`h6`, paragraphs to `p`"],
    ["a step range", "en-dash", "comes from steps 1–3."],
    ["a straight quote", "curly-quote", 'He said "yes".'],
    ["an apostrophe", "curly-quote", "the project's total"],
    ["the app's own hex glyph", "emoji", "The **⬢ menu** holds the commands"],
    ["a close control", "emoji", "Click **✕** to dismiss it."],
    ["a direct negative claim", "neg-parallel", "The API is not thread-safe."],
    ["a real section heading", "stock-heading", "## Overview"],
    ["an introduction heading", "stock-heading", "## Introduction"],
    ["a hyphenated compound", "ai-vocab", "The bundler-robust specifier."],
    ["the eval test harness", "ai-vocab", "The harness runs each case twice."],
    ["a heading using a banned word's homograph", "ai-vocab", "## Landscapes"],
  ];
  for (const [name, id, markdown] of clean) {
    test(`${id}: ${name}`, () => {
      expect(hitsOf(ruleById(id), segment(markdown), "docs/x.md")).toEqual([]);
    });
  }
});

describe("allow entries", () => {
  const entry: AllowEntry = { file: "docs/x.md", id: "em-dash", reason: "r", text: "the reason" };

  test("a matching entry suppresses the hit and is marked used", () => {
    const used = new Set<AllowEntry>();
    const [hit] = hitsOf(
      ruleById("em-dash"),
      segment("A line — for the reason given."),
      "docs/x.md",
    );
    expect(isAllowed(hit!, [entry], used)).toBe(true);
    expect(used.has(entry)).toBe(true);
  });

  test("an entry matches text past the 100-character excerpt", () => {
    const long = `${"padding words ".repeat(9)}— and then the reason.`;
    const [hit] = hitsOf(ruleById("em-dash"), segment(long), "docs/x.md");
    expect(hit!.excerpt.includes("and then the reason")).toBe(false);
    expect(isAllowed(hit!, [{ ...entry, text: "and then the reason" }], new Set())).toBe(true);
  });

  test("an entry for a different file does not apply", () => {
    const [hit] = hitsOf(ruleById("em-dash"), segment("A — b the reason"), "docs/other.md");
    expect(isAllowed(hit!, [entry], new Set())).toBe(false);
  });
});

describe("budgets", () => {
  // The budget tier has no live rule any more: the corpus reached zero and `em-dash` became a ban.
  // The machinery stays tested against a fixture with a known count, so the next surface that needs
  // To carry debt (the marketing pages, the package READMEs) inherits something that works.
  const FIXTURE = "scripts/docs/_fixtures/budgeted.md";
  const rules: Rule[] = [{ hint: "h", id: "em-dash", regex: "—", tier: "budget" }];
  const cfg = (budgets: ProseConfig["budgets"]): ProseConfig => ({ allow: [], budgets, rules });

  test("a count above its budget fails", () => {
    const { violations } = check(cfg({ [FIXTURE]: { "em-dash": 1 } }), [FIXTURE]);
    expect(violations.join(" ")).toContain("exceeds its budget");
  });

  test("a count below its budget also fails, so the map only ratchets down", () => {
    const { violations } = check(cfg({ [FIXTURE]: { "em-dash": 9999 } }), [FIXTURE]);
    expect(violations.join(" ")).toContain("is below its budget");
  });

  test("a file with no entry is held to zero, which is what new prose gets", () => {
    const { violations } = check(cfg({}), [FIXTURE]);
    expect(violations.join(" ")).toContain("with no budget entry");
  });

  test("a budget naming a file outside the corpus is stale", () => {
    const { violations } = check(cfg({ "docs/gone.md": { "em-dash": 1 } }), []);
    expect(violations.join(" ")).toContain("not in the corpus");
  });

  test("a budget naming an unknown rule is stale", () => {
    const { violations } = check(cfg({ [FIXTURE]: { nope: 1 } }), [FIXTURE]);
    expect(violations.join(" ")).toContain('unknown rule "nope"');
  });

  test("staleness is not judged on a partial sweep, or every page check would report it", () => {
    const partial = check(
      {
        allow: [{ file: "docs/other.md", id: "em-dash", reason: "r", text: "x" }],
        budgets: {},
        rules,
      },
      [],
      false,
    );
    expect(partial.violations).toEqual([]);
  });
});

describe("the committed tree", () => {
  test("every file is clean against every rule", () => {
    expect(check(config, corpusFiles()).violations).toEqual([]);
  });

  test("the corpus excludes generated pages, which a generator would overwrite", () => {
    const files = corpusFiles();
    expect(files).not.toContain("docs/extending/reference/spec-changelog.md");
    expect(files).not.toContain("docs/studio/interface/commands.md");
    expect(files).toContain("docs/studio/interface/modes.md");
  });

  test("every budget names a real rule and a file in the corpus", () => {
    const ids = new Set(config.rules.map((r) => r.id));
    const files = new Set(corpusFiles());
    for (const [file, byRule] of Object.entries(config.budgets)) {
      expect(files.has(file)).toBe(true);
      for (const id of Object.keys(byRule)) {
        expect(ids.has(id)).toBe(true);
      }
    }
  });

  test("every allow entry carries a justification", () => {
    for (const entry of config.allow) {
      expect(entry.evidence ?? entry.reason).toBeDefined();
    }
  });

  test("nothing is budgeted any more, and the em dash is a ban", () => {
    // The terminal state the budget was built for: the map emptied, so the rule hardened.
    expect(config.budgets).toEqual({});
    expect(config.rules.find((r) => r.id === "em-dash")?.tier).toBe("ban");
    expect(config.rules.every((r) => r.tier === "ban")).toBe(true);
  });
});

afterAll(() => {
  // A rule nobody has seen fire is a rule nobody knows works.
  const declared = config.rules.map((r) => r.id);
  const never = declared.filter((id) => !exercised.has(id));
  if (never.length > 0) {
    throw new Error(`rule(s) never exercised by a test: ${never.join(", ")}`);
  }
});
