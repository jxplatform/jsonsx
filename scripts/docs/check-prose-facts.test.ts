/**
 * The differ's job is to be trusted on the losses, so the tests that matter are the ones proving it
 * does not cry wolf: a rewrite that reflows a paragraph, unbolds a link, or splits a sentence must
 * come back clean, or the report gets skimmed and the one real loss in it is skimmed too.
 */

import { describe, expect, test } from "bun:test";
import { compare, factsOf, lost } from "./check-prose-facts.ts";

const before = `---
title: "A page"
---

# A page

Click **Save** to write the file — :kbd[⌘S] does the same. See [the guide](/docs/a/b).

\`\`\`json
{ "a": 1 }
\`\`\`

A build never reads the machine clock. All 3 retries share one budget.

![A screenshot of the panel](../images/x.png)
`;

describe("factsOf", () => {
  test("collects fences, targets, keys, code, bold and numbers", () => {
    const f = factsOf(before);
    expect(f.fences).toHaveLength(1);
    expect(f.targets).toEqual(["/docs/a/b", "../images/x.png"]);
    expect(f.keys).toEqual([":kbd[⌘S]"]);
    expect(f.bold).toEqual(["Save"]);
    expect(f.images).toEqual(["../images/x.png"]);
    expect(f.numbers).toEqual(["3"]);
    expect(f.modality).toEqual(["never", "all"]);
  });

  test("a number inside a fence is not a claim in the prose", () => {
    expect(factsOf('```\n{ "port": 3000 }\n```').numbers).toEqual([]);
  });

  test("a number inside a code span is not a threshold in the prose", () => {
    expect(factsOf("The default is `port 3000` here.").numbers).toEqual([]);
  });
});

describe("lost", () => {
  test("counts as a multiset, so one of two duplicates going is a loss", () => {
    expect(lost(["a", "a", "b"], ["a", "b"])).toEqual(["a"]);
  });

  test("returns nothing when everything survives out of order", () => {
    expect(lost(["a", "b"], ["b", "x", "a"])).toEqual([]);
  });
});

describe("compare blocks on a loss", () => {
  const cases: [string, string][] = [
    ["a deleted code fence", before.replace(/```json\n\{ "a": 1 \}\n```/, "")],
    ["a deleted link", before.replace("See [the guide](/docs/a/b).", "See the guide.")],
    ["a deleted keystroke", before.replace(":kbd[⌘S]", "the shortcut")],
    [
      "a deleted image",
      before.replace(/!\[A screenshot of the panel\]\(\.\.\/images\/x\.png\)/, ""),
    ],
  ];
  for (const [name, after] of cases) {
    test(name, () => {
      expect(compare("docs/a.md", before, after).blocking).not.toEqual([]);
    });
  }

  test("an edited fence counts as a loss, because a prose pass does not touch code", () => {
    const after = before.replace('{ "a": 1 }', '{ "a": 2 }');
    expect(compare("docs/a.md", before, after).blocking).not.toEqual([]);
  });
});

describe("compare stays quiet on a real rewrite", () => {
  test("splitting a sentence at its dash loses nothing", () => {
    const after = before.replace(
      "Click **Save** to write the file — :kbd[⌘S] does the same.",
      "Click **Save** to write the file. :kbd[⌘S] does the same.",
    );
    const report = compare("docs/a.md", before, after);
    expect(report.blocking).toEqual([]);
    expect(report.advisory).toEqual([]);
  });

  test("reflowing a paragraph onto one line loses nothing", () => {
    const after = before.replace(
      "A build never reads the machine clock. All 3 retries share one budget.",
      "A build never reads the machine clock.\nAll 3 retries share one budget.",
    );
    expect(compare("docs/a.md", before, after).blocking).toEqual([]);
  });

  test("adding a Related section is a gain, not a loss", () => {
    const after = `${before}\n## Related\n\n- [More](/docs/c/d)\n`;
    const report = compare("docs/a.md", before, after);
    expect(report.blocking).toEqual([]);
    expect(report.advisory.join(" ")).toContain("added");
  });
});

describe("compare reports the soft deltas a person must judge", () => {
  test("a softened contract word, which nothing else would notice", () => {
    const after = before.replace("never reads", "usually does not read");
    const report = compare("docs/a.md", before, after);
    expect(report.blocking).toEqual([]);
    expect(report.advisory.join(" ")).toContain('modality word gone: "never"');
  });

  test("a changed threshold", () => {
    const after = before.replace("All 3 retries", "All 5 retries");
    expect(compare("docs/a.md", before, after).advisory.join(" ")).toContain('number gone: "3"');
  });

  test("an unbolded UI label", () => {
    const after = before.replace("**Save**", "Save");
    expect(compare("docs/a.md", before, after).advisory.join(" ")).toContain(
      'bold label gone: "Save"',
    );
  });

  test("a page that grew by more than a fifth", () => {
    const after = `${before}\n${"Another sentence of orientation. ".repeat(20)}`;
    expect(compare("docs/a.md", before, after).advisory.join(" ")).toContain("word count +");
  });
});
