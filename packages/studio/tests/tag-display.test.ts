/**
 * No surface renders a chosen tag as `[object Object]`.
 *
 * `tagName` may be a literal name or a `TagExpression`. Every place the tag reaches a human has to
 * go through `displayTagName`, and three rounds of fixing them one at a time is what motivated this
 * file: `nodeLabel` was fixed and the Outline still showed the object, because the Outline draws a
 * separate tag BADGE and `outlineLabel` never returns a tag at all. Fixing a surface and asserting
 * "that was the last one" is what this replaces.
 *
 * The guard is a SOURCE SWEEP rather than a render of every panel, because the failure is a missing
 * call, not a wrong pixel — and a sweep covers the surfaces nobody thought to render in a test.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { displayTagName } from "@jxsuite/schema/guards";

const SRC = join(import.meta.dir, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    return entry.endsWith(".ts") ? [full] : [];
  });
}

/*
 * Receivers whose `tagName` is a plain `string` BY TYPE, so a raw read is correct there and the
 * sweep must not nag about it. Each is a different kind of thing from a document node:
 *   comp/c      — ComponentEntry, a registered component's ROOT name
 *   entry       — JxHeadEntry, a `<head>` tag
 *   layout/     — LayoutSelection, the studio's own chrome-selection record
 *   selection   — the same
 *   el/element/targetEl/icon — a DOM Element, where `tagName` is the browser's
 *   query/target — UsageQuery, whose `tagName` is a component ROOT name being searched for
 */
const STATIC_RECEIVERS =
  /\b(comp|c|entry|layout|selection|el|element|targetEl|icon|source_|doc|query|target)\.tagName\b/;

/** Already display-safe, or not a render at all. */
const SAFE = [
  /displayTagName|tagNameCandidates/, // Goes through the helper.
  /!\w+\.tagName/, // A truthiness test, not a value that reaches a human.
];

describe("a chosen tag never reaches a human as an object", () => {
  test("displayTagName is what turns one into text", () => {
    const chosen = {
      $expression: { initial: "div", operator: "?:" as const, target: {}, value: "a" },
    };
    expect(displayTagName(chosen)).toBe("a|div");
    expect(String(chosen)).toBe("[object Object]");
  });

  test("no source file interpolates a document node's tagName raw", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        // A tag read that lands in a STRING — a template hole, or a `||`/`??` fallback feeding one.
        const risky = /\$\{[^}]*\.tagName|\.tagName\s*(\|\||\?\?)/.test(line);
        if (!risky || STATIC_RECEIVERS.test(line) || SAFE.some((re) => re.test(line))) {
          continue;
        }
        offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
