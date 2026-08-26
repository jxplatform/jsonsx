/**
 * The rule this covers is load-bearing and its failure mode is silent, so the cases below are the
 * REAL commits — the five in this repository's history that would each have deleted a package from
 * its own release, and the near-misses that must stay allowed.
 *
 * See `commitlint.config.ts` for why an angle bracket in a commit subject has that effect.
 */

import { describe, expect, test } from "bun:test";

import { findAngleTags, findChangelogUnsafeParts } from "../commitlint.config.ts";
import { findUnsafeCommits, parseLog, report } from "./check-changelog-safety.ts";

describe("findAngleTags", () => {
  test("finds the tags that survive release-please's escape/decode round trip", () => {
    expect(findAngleTags("responsive images — <picture> per format")).toEqual(["<picture>"]);
    expect(findAngleTags("the shared ext/<name>/<kind>/v<n> shape")).toEqual([
      "<name>",
      "<kind>",
      "<n>",
    ]);
    expect(findAngleTags("real <th> table headers")).toEqual(["<th>"]);
    expect(findAngleTags("closes </details> early")).toEqual(["</details>"]);
    expect(findAngleTags('an <img src="x"> attribute')).toEqual(['<img src="x">']);
    expect(findAngleTags("a <!-- comment --> in a subject")).toEqual(["<!--"]);
  });

  test("a type parameter is unsafe too — `<string>` is an element to an HTML parser", () => {
    expect(findAngleTags("accept Array<string> for $paths")).toEqual(["<string>"]);
  });

  test("collapses duplicates so the message names each tag once", () => {
    expect(findAngleTags("<picture> then <picture> again")).toEqual(["<picture>"]);
  });

  test("leaves comparisons, arrows and prose alone", () => {
    expect(findAngleTags("handle a < b and b > a")).toEqual([]);
    expect(findAngleTags("rename foo -> bar")).toEqual([]);
    expect(findAngleTags("keep bundles <3 MB")).toEqual([]);
    expect(findAngleTags("the picture element, one owner for loading")).toEqual([]);
    expect(findAngleTags("")).toEqual([]);
    expect(findAngleTags(null)).toEqual([]);
  });
});

describe("findChangelogUnsafeParts", () => {
  test("flags the subject", () => {
    const parts = findChangelogUnsafeParts(
      "feat(compiler): responsive images — <picture> per format\n\nA body.\n",
    );
    expect(parts).toEqual([
      {
        part: "subject",
        tags: ["<picture>"],
        text: "feat(compiler): responsive images — <picture> per format",
      },
    ]);
  });

  test("flags a BREAKING CHANGE note, which release-please also copies verbatim", () => {
    const parts = findChangelogUnsafeParts(
      'feat(feed)!: drop the inert contentMode "none"\n\nA body.\n\n' +
        "BREAKING CHANGE: entries now always carry <summary>\ncontinued on the next line\n\ntrailer\n",
    );
    expect(parts.map((p) => p.part)).toEqual(["BREAKING CHANGE"]);
    expect(parts[0].tags).toEqual(["<summary>"]);
    expect(parts[0].text).toContain("continued on the next line");
  });

  test("ignores markup in an ordinary body — only the changelog-bound text matters", () => {
    expect(
      findChangelogUnsafeParts("fix(compiler): head identity\n\nBefore:\n\n    <head><title>x\n"),
    ).toEqual([]);
  });

  test("passes a clean commit", () => {
    expect(findChangelogUnsafeParts("chore: release main\n")).toEqual([]);
  });
});

describe("parseLog", () => {
  test("splits NUL-delimited sha/message pairs, trailing field included", () => {
    expect(parseLog("abc\0feat: one\n\0def\0fix: two\n\0")).toEqual([
      { sha: "abc", message: "feat: one\n" },
      { sha: "def", message: "fix: two\n" },
    ]);
  });

  test("an empty range yields no commits", () => {
    expect(parseLog("")).toEqual([]);
  });
});

describe("findUnsafeCommits and report", () => {
  const commits = [
    { sha: "14f920de7d5a", message: "feat(compiler): responsive images — <picture> per format\n" },
    { sha: "c4a614dae5e1", message: "fix: defects surfaced by fact-checking the READMEs\n" },
  ];

  test("returns only the offenders, with their subject", () => {
    const unsafe = findUnsafeCommits(commits);
    expect(unsafe.map((c) => c.sha)).toEqual(["14f920de7d5a"]);
    expect(unsafe[0].subject).toBe("feat(compiler): responsive images — <picture> per format");
  });

  test("the report names the sha, the subject and the tag", () => {
    const text = report(findUnsafeCommits(commits));
    expect(text).toContain("14f920de");
    expect(text).toContain("responsive images");
    expect(text).toContain("<picture>");
    expect(text).not.toContain("c4a614da");
  });

  test("nothing to report when every commit is clean", () => {
    expect(findUnsafeCommits([commits[1]])).toEqual([]);
    expect(report([])).toBe("");
  });
});
