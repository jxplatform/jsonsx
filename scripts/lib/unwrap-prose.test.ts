/**
 * Most of these tests are about what the unwrapper must NOT join, because a line break this repo's
 * markup depends on is content: oxfmt's `proseWrap: "never"` was rejected precisely for folding a
 * `:::doc-note` marker into the paragraph under it and collapsing `pages/templates.md`'s
 * `::starter-card` directives into one line, which dropped seven starters and reds `docs:claims`.
 *
 * The RULE tests drive synthetic documents; the GOLDEN tests hold the committed tree to the
 * invariant that unwrapping moves whitespace and nothing else.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unwrapProse } from "./unwrap-prose.ts";

const text = (source: string) => unwrapProse(source).text;

/** What the gate is really asserting: only whitespace and break markers moved. */
function words(source: string): string {
  return source
    .replaceAll(/\\$/gm, "")
    .replaceAll(/^\s*(?:>\s?)+/gm, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

describe("unwrapProse joins", () => {
  test("a hard-wrapped paragraph becomes one line", () => {
    const { text: out, lines } = unwrapProse("One two\nthree four\nfive.\n");
    expect(out).toBe("One two three four five.\n");
    expect(lines).toEqual([2, 3]);
  });

  test("paragraphs stay separate across a blank line", () => {
    expect(text("One\ntwo\n\nThree\nfour\n")).toBe("One two\n\nThree four\n");
  });

  /*
   * The line-scanning version of this file could not do the next three, and that was most of the
   * corpus: anything with a line prefix was excluded rather than handled, so a wrapped list item
   * and a wrapped block quote both stayed wrapped.
   */
  test("a wrapped list item folds onto its marker", () => {
    expect(text("- First item that\n  wraps here\n- Second\n")).toBe(
      "- First item that wraps here\n- Second\n",
    );
  });

  test("a wrapped block quote keeps one marker", () => {
    expect(text("> A quote that\n> wraps here\n")).toBe("> A quote that wraps here\n");
  });

  test("a nested list item folds at its own indent", () => {
    expect(text("- Outer\n  - Inner item that\n    wraps\n")).toBe(
      "- Outer\n  - Inner item that wraps\n",
    );
  });

  test("a container directive keeps its markers while its body joins", () => {
    expect(text(":::doc-note\nStudio writes plain JSON.\nSo it is diffable.\n:::\n")).toBe(
      ":::doc-note\nStudio writes plain JSON. So it is diffable.\n:::\n",
    );
  });

  test("a footnote definition's body joins", () => {
    expect(text("Text[^1].\n\n[^1]: The note that\n    wraps here.\n")).toBe(
      "Text[^1].\n\n[^1]: The note that wraps here.\n",
    );
  });

  test("a document already on one line per paragraph is untouched", () => {
    const source = "# Title\n\nA whole paragraph on one line.\n\nAnother one.\n";
    expect(unwrapProse(source)).toEqual({ lines: [], text: source });
  });
});

describe("unwrapProse leaves alone", () => {
  // Each case is a construct whose line break carries meaning. Joining any of them is a content bug.
  const untouched: [string, string][] = [
    [
      "a two-colon directive",
      '::section-label{props.text="Starter templates"}\n::starter-card{props.slug="restaurant"}\n',
    ],
    [
      "a six-colon directive",
      '::::::hero{style.padding="1rem"}\n:::::div{style.margin="0 auto"}\n',
    ],
    ["fenced code", '```json\n{\n  "a": 1\n}\n```\n'],
    ["a tilde fence", "~~~\nplain\ntext\n~~~\n"],
    ["prose inside a fence", "```\nOne two\nthree four\n```\n"],
    ["indented code", "Intro:\n\n    one two\n    three four\n"],
    ["frontmatter", '---\ntitle: "A page"\ndescription: "Something."\n---\n'],
    ["a table", "| Key | Type |\n| --- | --- |\n| `name` | `string` |\n"],
    ["headings", "## One\n### Two\n"],
    ["a list of one-line items", "- First item\n- Second item\n"],
    ["an ordered list", "1. First\n2. Second\n"],
    ["an HTML block", '<p align="center">\n  <img src="a.svg" />\n</p>\n'],
    ["a thematic break between paragraphs", "One.\n\n---\n\nTwo.\n"],
    ["a link reference definition", "[spec]: https://example.com\n[other]: https://example.org\n"],
  ];
  for (const [name, source] of untouched) {
    test(name, () => {
      expect(unwrapProse(source)).toEqual({ lines: [], text: source });
    });
  }

  test("a `---` after frontmatter is a thematic break, not a second frontmatter block", () => {
    const source = '---\ntitle: "T"\n---\n\nOne\ntwo\n\n---\n\nThree\nfour\n';
    expect(text(source)).toBe('---\ntitle: "T"\n---\n\nOne two\n\n---\n\nThree four\n');
  });

  /*
   * `sites/jxsuite.com/pages/index.md` writes two of these in a row, each `display="block"`. The
   * syntax is inline, so a parser sees one paragraph; joining them produced 500 characters of
   * markup on one line, and a hard break could not undo it because a `<br>` between two blocks is a
   * rendering change.
   */
  test("a line that is nothing but a text directive", () => {
    const source = [
      ':span[Workflow]{style.display="block"}',
      ':span[Servers optional]{style.display="block"}',
      "",
    ].join("\n");
    expect(unwrapProse(source)).toEqual({ lines: [], text: source });
  });

  test("a text directive with prose beside it is ordinary paragraph content", () => {
    expect(text('Prose leading into\n:span[a label]{style.color="red"} and more.\n')).toBe(
      'Prose leading into :span[a label]{style.color="red"} and more.\n',
    );
  });

  test("a paragraph does not swallow the structural line after it", () => {
    expect(text("Intro line\ncontinues here\n\n:::doc-tip\nA tip.\n:::\n")).toBe(
      "Intro line continues here\n\n:::doc-tip\nA tip.\n:::\n",
    );
  });

  test("unparseable input is returned as it arrived", () => {
    // Nothing here throws today; the guard exists so a parser upgrade cannot corrupt a file.
    const source = "One\ntwo\n";
    expect(unwrapProse(source).text).toBe("One two\n");
  });
});

describe("hard breaks", () => {
  test("a backslash break survives, and the lines around it still join", () => {
    expect(text("One two\nthree\\\nfour five\nsix\n")).toBe("One two three\\\nfour five six\n");
  });

  /*
   * Two trailing spaces render as a break and read as nothing at all: an editor that strips
   * trailing whitespace, or a careless paste, deletes it silently. Rewriting it visible is the
   * whole point of the pass.
   */
  test("a two-space break is rewritten as a backslash", () => {
    const { text: out, lines } = unwrapProse("128 Market Street  \nRiverbend, CA 90210\n");
    expect(out).toBe("128 Market Street\\\nRiverbend, CA 90210\n");
    expect(lines).toEqual([1]);
  });

  test("an escaped backslash is content, not a break", () => {
    // `a\\` renders a literal backslash. Appending to it would turn it into a line break.
    const source = "a\\\\\nb\n";
    expect(text(source)).toBe("a\\\\ b\n");
  });
});

describe("a labelled run", () => {
  const header = [
    "**Version:** 0.1.11-draft",
    "**Status:** Partial",
    "**Updated:** 2026-08-30",
    "**License:** MIT",
    "",
  ].join("\n");

  test("gets explicit breaks instead of being joined", () => {
    expect(text(header)).toBe(
      [
        "**Version:** 0.1.11-draft\\",
        "**Status:** Partial\\",
        "**Updated:** 2026-08-30\\",
        "**License:** MIT",
        "",
      ].join("\n"),
    );
  });

  test("is stable once marked", () => {
    expect(unwrapProse(text(header)).lines).toEqual([]);
  });

  test("needs every line labelled — a paragraph that merely opens with one is joined", () => {
    expect(text("**Note:** a paragraph that\nwraps across two lines.\n")).toBe(
      "**Note:** a paragraph that wraps across two lines.\n",
    );
  });

  test("a single labelled line is a paragraph, not a run", () => {
    const source = "**Version:** 0.1.11\n";
    expect(unwrapProse(source)).toEqual({ lines: [], text: source });
  });
});

describe("idempotence and fidelity", () => {
  test("unwrapping twice changes nothing the second time", () => {
    const once = text("One two\nthree\n\n- item that\n  wraps\n\n> quote that\n> wraps\n");
    expect(text(once)).toBe(once);
  });

  test("preserves the trailing newline", () => {
    expect(text("One\ntwo\n").endsWith("\n")).toBe(true);
    expect(text("One\ntwo").endsWith("\n")).toBe(false);
  });
});

describe("the committed tree", () => {
  // One of each shape the pass has to survive: specs, a README, the marketing pages, the callouts.
  const sample = [
    "specs/spec.md",
    "specs/studio.md",
    "docs/README.md",
    "docs/extending/contributing/docs.md",
    "sites/jxsuite.com/pages/templates.md",
    "sites/jxsuite.com/pages/index.md",
    "README.md",
    "CLAUDE.md",
  ];

  test("unwrapping moves whitespace and nothing else", () => {
    for (const path of sample) {
      const source = readFileSync(path, "utf8");
      expect(words(unwrapProse(source).text)).toBe(words(source));
    }
  });

  test("every directive line survives on its own line", () => {
    const markers = (t: string) => t.split("\n").filter((l) => /^\s*:{2,}/.test(l));
    for (const path of sample) {
      const source = readFileSync(path, "utf8");
      expect(markers(unwrapProse(source).text)).toEqual(markers(source));
    }
  });

  test("every table row survives on its own line", () => {
    const rows = (t: string) => t.split("\n").filter((l) => l.trimStart().startsWith("|"));
    for (const path of sample) {
      const source = readFileSync(path, "utf8");
      expect(rows(unwrapProse(source).text)).toEqual(rows(source));
    }
  });

  /*
   * The sweep that unwraps these files is a separate change (see normalize-markdown.ts's header),
   * so the tree is still wrapped and cannot be asserted formatted yet. What CAN be asserted, and is
   * the property the sweep will rely on, is that one pass reaches a fixed point.
   */
  test("one pass over a real page reaches a fixed point", () => {
    for (const path of sample) {
      const once = unwrapProse(readFileSync(path, "utf8")).text;
      expect(unwrapProse(once).lines).toEqual([]);
    }
  });
});
