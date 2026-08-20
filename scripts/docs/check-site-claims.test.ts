/**
 * Tests for the starter-count half of the site-claims gate.
 *
 * This gate existed to catch a wrong starter count on a marketing page, and it did not: its pattern
 * put `[A-Za-z]+` in the number slot, so leftmost-match captured whatever word happened to sit
 * there. "one of twelve production-ready starter sites" captured "of", which is no number, so the
 * count was skipped in silence — and "one of thirteen starters", a CORRECT claim, captured "one"
 * and would have failed the build for claiming 1. Both directions are pinned below.
 *
 * The RULE tests drive synthetic strings; the GOLDEN tests hold the committed tree to the registry.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NUMBER_WORDS,
  starterCountViolations,
  starterCount,
  starterCountsIn,
  starterIds,
  targetFiles,
  templatesPageCardSlugs,
} from "./check-site-claims.ts";

describe("starterCountsIn", () => {
  test("reads the count that qualifies `starter`, not the preposition before it", () => {
    /*
     * The regression. The old pattern captured "of" here, so a wrong count rode through a merge
     * and sat on a published page with the gate reporting green.
     */
    expect(
      starterCountsIn("Start a new Jx project from one of twelve production-ready starter sites"),
    ).toEqual([12]);
  });

  test("reads a correct `one of N starters` as N, never as one", () => {
    /*
     * The other half of the same defect: without the number-word lookahead this true sentence
     * matches leftmost at "one" and fails the build for claiming a single starter.
     */
    expect(starterCountsIn("one of thirteen starters")).toEqual([13]);
    expect(starterCountsIn("Start from a blank project or one of 13 starters.")).toEqual([13]);
  });

  test("reads bare digits and leading number words across up to two adjectives", () => {
    expect(starterCountsIn("13 starters")).toEqual([13]);
    expect(starterCountsIn("Thirteen production-ready starter sites — plain JSON")).toEqual([13]);
  });

  test("sees through markdown emphasis", () => {
    expect(starterCountsIn("**13** starters")).toEqual([13]);
    expect(starterCountsIn("one of **twelve** production-ready starter sites")).toEqual([12]);
  });

  test("matches whole number words, so `sixteen` is not `six`", () => {
    expect(starterCountsIn("sixteen starters")).toEqual([16]);
  });

  test("reads no count from prose that merely mentions a starter", () => {
    expect(starterCountsIn("Studio scaffolds a clean starter you can build on.")).toEqual([]);
    expect(starterCountsIn("Nothing about a starter is special afterward")).toEqual([]);
    expect(starterCountsIn('::starter-card{props.image="/starters/restaurant.jpg"}')).toEqual([]);
  });

  test("stops at two intervening words — a documented limit, not a bug", () => {
    /*
     * A claim this far from its noun is not one the gate promises to catch, and widening the
     * window starts reading "the step-1 choice on the Starters tab" as a count.
     */
    expect(starterCountsIn("13 of the very best hand-made starter sites")).toEqual([]);
  });

  test("carries no lastIndex between calls", () => {
    // The pattern is module-level and /g; anything using .test() on it would alternate.
    expect(starterCountsIn("13 starters")).toEqual(starterCountsIn("13 starters"));
  });
});

describe("the committed tree", () => {
  test("registry.json is an array, which is what the count depends on", () => {
    /*
     * `Object.keys(...).length` was right only by accident of Object.keys on an array, while its
     * type said it was counting the keys of a Record.
     */
    const raw = readFileSync(
      resolve(import.meta.dir, "../../packages/starters/registry.json"),
      "utf8",
    );
    expect(Array.isArray(JSON.parse(raw))).toBe(true);
    expect(starterCount).toBe(starterIds.length);
  });

  test("NUMBER_WORDS can spell the current starter count", () => {
    // A count the vocabulary cannot express is one the reader returns null for and skips.
    expect(Object.values(NUMBER_WORDS)).toContain(starterCount);
  });

  test("every starter count on a scanned page equals the registry", () => {
    expect(starterCountViolations(targetFiles(), starterCount)).toEqual([]);
  });

  test("the templates page has exactly one card per starter, and no card outlives its starter", () => {
    /*
     * Set equality both ways, like scripts/screenshots/shot-paths.test.ts. The page duplicates
     * every starter's name, tagline, image and accent by hand, so a starter added without a card
     * is a bigger staleness surface than a wrong number — and nothing checked it. Order is not
     * asserted: the page groups by industry.
     */
    expect(new Set(templatesPageCardSlugs())).toEqual(new Set(starterIds));
  });
});
