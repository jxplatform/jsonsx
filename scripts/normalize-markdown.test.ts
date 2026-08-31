import { describe, expect, test } from "bun:test";
import { formatMarkdown, isFormattable, normalizeMarkdown } from "./normalize-markdown.ts";

/**
 * The rules are narrow on purpose: an escape is removed only where Markdown never needed one. Most
 * of these tests are about what the normalizer must NOT touch, because a backslash that was written
 * deliberately is content, and silently eating it would be the same class of damage the script
 * exists to undo.
 */

const norm = (s: string) => normalizeMarkdown(s).text;

describe("escaped numbered headings", () => {
  /*
   * The one that cost twelve standards rows: `STANDARDS_HEADING` stopped matching, the section
   * became unfindable, and a parser that cannot find a section silently stops checking it.
   */
  test("unescapes the dot after a heading number", () => {
    expect(norm(String.raw`## 18\. Standards Alignment`)).toBe("## 18. Standards Alignment");
    expect(norm(String.raw`# 1\. Overview`)).toBe("# 1. Overview");
    expect(norm(String.raw`###### 21\. Evaluation Surface`)).toBe("###### 21. Evaluation Surface");
  });

  test("handles dotted and lettered section numbers", () => {
    expect(norm(String.raw`### 4.1\. Placement`)).toBe("### 4.1. Placement");
    expect(norm(String.raw`### 8a\. Variant`)).toBe("### 8a. Variant");
  });

  test("reports the lines it changed", () => {
    const result = normalizeMarkdown(
      ["intro", String.raw`## 2\. Two`, "body", String.raw`## 3\. Three`].join("\n"),
    );
    expect(result.lines).toEqual([2, 4]);
  });

  test("leaves a clean heading exactly as it is", () => {
    const src = "## 18. Standards Alignment\n\nBody.\n";
    expect(norm(src)).toBe(src);
    expect(normalizeMarkdown(src).lines).toEqual([]);
  });

  // Only the dot immediately after the number. A backslash later in the title is the author's.
  test("does not touch an escape elsewhere in the heading", () => {
    expect(norm(String.raw`## 3. A literal \* asterisk`)).toBe(
      String.raw`## 3. A literal \* asterisk`,
    );
  });

  test("does not touch an unnumbered heading", () => {
    expect(norm(String.raw`## Changelog\.`)).toBe(String.raw`## Changelog\.`);
  });
});

describe("escaped underscores inside a word", () => {
  test("unescapes between word characters", () => {
    expect(norm(String.raw`Runtime RESERVED\_KEYS includes both.`)).toBe(
      "Runtime RESERVED_KEYS includes both.",
    );
    expect(norm(String.raw`a\_b\_c`)).toBe("a_b_c");
  });

  /*
   * A leading or trailing `\_` may be load-bearing — `\_private` renders a literal underscore that
   * would otherwise open emphasis. Only the intra-word case is unambiguously redundant.
   */
  test("leaves a boundary underscore escape alone", () => {
    expect(norm(String.raw`\_private`)).toBe(String.raw`\_private`);
    expect(norm(String.raw`trailing\_`)).toBe(String.raw`trailing\_`);
  });
});

describe("fenced code is content, not markup", () => {
  test("never rewrites inside a fence", () => {
    const src = [
      "```md",
      String.raw`## 18\. Standards Alignment`,
      String.raw`RESERVED\_KEYS`,
      "```",
    ].join("\n");
    expect(norm(src)).toBe(src);
    expect(normalizeMarkdown(src).lines).toEqual([]);
  });

  test("resumes after the fence closes", () => {
    const src = ["```", String.raw`## 1\. inside`, "```", String.raw`## 2\. outside`].join("\n");
    expect(norm(src)).toBe(["```", String.raw`## 1\. inside`, "```", "## 2. outside"].join("\n"));
  });

  test("handles tilde fences and indented fences", () => {
    const src = ["~~~", String.raw`## 1\. inside`, "~~~"].join("\n");
    expect(norm(src)).toBe(src);
    expect(norm(["  ```", String.raw`## 1\. inside`, "  ```"].join("\n"))).toBe(
      ["  ```", String.raw`## 1\. inside`, "  ```"].join("\n"),
    );
  });
});

describe("idempotence and fidelity", () => {
  test("normalizing twice changes nothing the second time", () => {
    const once = norm(
      [String.raw`## 18\. Standards Alignment`, "", String.raw`RESERVED\_KEYS`, ""].join("\n"),
    );
    expect(norm(once)).toBe(once);
  });

  test("preserves trailing newline and line count", () => {
    const src = [String.raw`## 1\. A`, "", String.raw`## 2\. B`, ""].join("\n");
    const out = norm(src);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
  });

  /*
   * The limit worth stating in a test: the round trip that inserts these escapes ALSO flattens
   * `[id](url)` to bare text and `**bold**` to plain, and no normalizer can put a destroyed URL
   * back. That is why `check-standards.ts` reports the escape rather than only fixing it.
   */
  test("cannot recover a flattened link or bold — that is not its job", () => {
    const flattened = "| RFC 6901 | Borrowed | §7 |";
    expect(norm(flattened)).toBe(flattened);
  });
});

describe("formatMarkdown runs both rules", () => {
  test("unescapes and unwraps in one pass", () => {
    const result = formatMarkdown([String.raw`## 2\. Two`, "", "One two", "three.", ""].join("\n"));
    expect(result.text).toBe("## 2. Two\n\nOne two three.\n");
    expect(result.escaped).toEqual([1]);
    expect(result.wrapped).toEqual([4]);
  });

  /*
   * The escape pass runs first because `## 18\.` is a heading the unwrapper has to recognise as
   * one. Left escaped, the line is an ordinary paragraph and the text under it folds into it.
   */
  test("an escaped heading is a heading by the time the unwrapper sees it", () => {
    const source = [String.raw`## 18\. Standards`, "Body text.", ""].join("\n");
    expect(formatMarkdown(source).text).toBe("## 18. Standards\nBody text.\n");
  });

  /*
   * `--no-wrap`. The repo-wide sweep has not landed, so the gate and the pre-commit hook pass this
   * and rewrite nobody's line breaks. Deleting it from the two package.json strings is what turns
   * the rule on.
   */
  test("wrap: false leaves line breaks exactly as they were", () => {
    const source = [String.raw`## 2\. Two`, "", "One two", "three.", ""].join("\n");
    const result = formatMarkdown(source, { wrap: false });
    expect(result.text).toBe("## 2. Two\n\nOne two\nthree.\n");
    expect(result.escaped).toEqual([1]);
    expect(result.wrapped).toEqual([]);
  });
});

describe("isFormattable", () => {
  // Bytes that belong to something other than a formatter: a bot, a fixture, a pinned submodule.
  const skipped = [
    "CHANGELOG.md",
    "packages/formulas/CHANGELOG.md",
    "scripts/docs/_fixtures/cadenced.md",
    "packages/server/tests/_studio_fixtures/md-components/plain.md",
    "packages/desktop/tests/_fixtures_content/content/docs/advanced.md",
    "vendor/electrobun/package/README.md",
  ];
  for (const path of skipped) {
    test(`skips ${path}`, () => {
      expect(isFormattable(path)).toBe(false);
    });
  }

  const swept = ["README.md", "docs/README.md", "specs/spec.md", "packages/site/README.md"];
  for (const path of swept) {
    test(`sweeps ${path}`, () => {
      expect(isFormattable(path)).toBe(true);
    });
  }

  // A file merely NAMED changelog is prose, not release-please's output.
  test("only a real CHANGELOG.md is skipped", () => {
    expect(isFormattable("docs/extending/reference/spec-changelog.md")).toBe(true);
  });
});
