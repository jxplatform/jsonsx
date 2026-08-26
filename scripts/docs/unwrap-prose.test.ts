/**
 * Most of these tests are about what the unwrapper must NOT join, because a line break this repo's
 * markup depends on is content: `proseWrap: "never"` was rejected precisely for folding a
 * `:::doc-note` marker into the paragraph under it and collapsing `pages/templates.md`'s
 * `::starter-card` directives into one line, which dropped seven starters and reds `docs:claims`.
 *
 * The RULE tests drive synthetic documents; the GOLDEN tests hold the committed tree to the
 * invariant that unwrapping changes line breaks and nothing else.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unwrapProse } from "./unwrap-prose.ts";

/** What the gate is really asserting: only whitespace moved. */
function words(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

describe("unwrapProse joins", () => {
  test("a hard-wrapped paragraph becomes one line", () => {
    const { text, lines } = unwrapProse("One two\nthree four\nfive.\n");
    expect(text).toBe("One two three four five.\n");
    expect(lines).toEqual([2, 3]);
  });

  test("paragraphs stay separate across a blank line", () => {
    expect(unwrapProse("One\ntwo\n\nThree\nfour\n").text).toBe("One two\n\nThree four\n");
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
    ["frontmatter", '---\ntitle: "A page"\ndescription: "Something."\n---\n'],
    ["a table", "| Key | Type |\n| --- | --- |\n| `name` | `string` |\n"],
    ["headings", "## One\n### Two\n"],
    ["a list", "- First item\n- Second item\n"],
    ["an ordered list", "1. First\n2. Second\n"],
    [
      "a block quote",
      "> **Studio writes this format for you.**\n> This page documents the JSON.\n",
    ],
    ["an HTML block", "<!-- GENERATED -->\n<div>\n"],
    ["a thematic break between paragraphs", "One.\n\n---\n\nTwo.\n"],
    ["a link reference definition", "[spec]: https://example.com\n[other]: https://example.org\n"],
  ];
  for (const [name, source] of untouched) {
    test(name, () => {
      expect(unwrapProse(source)).toEqual({ lines: [], text: source });
    });
  }
  test("a container directive keeps its own lines while its body joins", () => {
    const { text } = unwrapProse(
      ":::doc-note\nStudio writes plain JSON.\nSo it is diffable.\n:::\n",
    );
    expect(text).toBe(":::doc-note\nStudio writes plain JSON. So it is diffable.\n:::\n");
  });

  test("a hard break written as a backslash", () => {
    const source = "Build websites visually.\\\nOwn every file.\n";
    expect(unwrapProse(source)).toEqual({ lines: [], text: source });
  });

  test("a hard break written as two trailing spaces", () => {
    const source = "Build websites visually.  \nOwn every file.\n";
    expect(unwrapProse(source)).toEqual({ lines: [], text: source });
  });

  test("a paragraph does not swallow the structural line after it", () => {
    const { text } = unwrapProse("Intro line\ncontinues here\n\n:::doc-tip\nA tip.\n:::\n");
    expect(text).toBe("Intro line continues here\n\n:::doc-tip\nA tip.\n:::\n");
  });

  test("a paragraph does not absorb a differently indented line", () => {
    const source = "Top level line\n    indented code-ish line\n";
    expect(unwrapProse(source)).toEqual({ lines: [], text: source });
  });

  test("a `---` after frontmatter is a thematic break, not a second frontmatter block", () => {
    const source = '---\ntitle: "T"\n---\n\nOne\ntwo\n\n---\n\nThree\nfour\n';
    expect(unwrapProse(source).text).toBe('---\ntitle: "T"\n---\n\nOne two\n\n---\n\nThree four\n');
  });
});

describe("the committed tree", () => {
  // The pages that motivated the pass, and the two constructs it must never damage.
  const sample = [
    "docs/README.md",
    "docs/extending/contributing/docs.md",
    "docs/studio/interface/modes.md",
    "docs/framework/concepts/reactivity.md",
    "sites/jxsuite.com/pages/templates.md",
    "sites/jxsuite.com/pages/index.md",
    "README.md",
  ];

  test("unwrapping moves whitespace and nothing else", () => {
    for (const path of sample) {
      const source = readFileSync(path, "utf8");
      expect(words(unwrapProse(source).text)).toBe(words(source));
    }
  });

  test("every `:::` directive line survives on its own line", () => {
    for (const path of sample) {
      const before = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => /^\s*:{2,}/.test(l));
      const after = unwrapProse(readFileSync(path, "utf8"))
        .text.split("\n")
        .filter((l) => /^\s*:{2,}/.test(l));
      expect(after).toEqual(before);
    }
  });

  test("every table row survives on its own line", () => {
    for (const path of sample) {
      const source = readFileSync(path, "utf8");
      const rows = (t: string) => t.split("\n").filter((l) => l.trimStart().startsWith("|"));
      expect(rows(unwrapProse(source).text)).toEqual(rows(source));
    }
  });
});
