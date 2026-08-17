import { describe, expect, test } from "bun:test";
import { normalizeMarkdown } from "./normalize-markdown.ts";

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
