/**
 * Tests for src/content/draft-state.ts — what a draft is, and the shared "including drafts"
 * perspective.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { effect, effectScope } from "../src/reactivity";
import {
  DRAFT_FIELD,
  DRAFT_MEANING,
  applyDraftFilter,
  draftView,
  hasDraftAxis,
  includingDrafts,
  isDraftEntry,
  schemaDeclaresDraft,
  setIncludeDrafts,
} from "../src/content/draft-state";
import type { ContentTypeSchema } from "@jxsuite/schema/types";

const BLOG_SCHEMA: ContentTypeSchema = {
  properties: {
    draft: { type: "boolean", default: false },
    title: { type: "string" },
  },
};

beforeEach(() => {
  setIncludeDrafts(false);
});

describe("what a draft is", () => {
  test("a draft is the literal true, never a truthy string", () => {
    expect(isDraftEntry({ [DRAFT_FIELD]: true })).toBe(true);
    expect(isDraftEntry({ [DRAFT_FIELD]: "yes" })).toBe(false);
    expect(isDraftEntry({ [DRAFT_FIELD]: false })).toBe(false);
    expect(isDraftEntry({})).toBe(false);
    expect(isDraftEntry(null)).toBe(false);
  });

  test("the axis exists when the schema declares it, or when the entry carries it anyway", () => {
    expect(schemaDeclaresDraft(BLOG_SCHEMA)).toBe(true);
    expect(schemaDeclaresDraft({ properties: { draft: { type: "string" } } })).toBe(false);
    expect(hasDraftAxis(null, { draft: true })).toBe(true);
    expect(hasDraftAxis(null, {})).toBe(false);
  });

  test("the pill's sentence does not promise the build excludes drafts", () => {
    // The compiler has no draft filtering (site/site-build.ts); a badge saying otherwise would be
    // A confident lie about what shipping does.
    expect(DRAFT_MEANING).not.toContain("Excluded");
    expect(DRAFT_MEANING).toContain("does not exclude them yet");
  });

  test("the filter drops drafts, and returns the input untouched when including them", () => {
    const rows = [{ fm: { draft: true } }, { fm: {} }, { fm: { draft: false } }];
    expect(applyDraftFilter(rows, (r) => r.fm, false)).toHaveLength(2);
    expect(applyDraftFilter(rows, (r) => r.fm, true)).toBe(rows);
  });
});

describe("the perspective", () => {
  test("hides drafts by default", () => {
    expect(includingDrafts()).toBe(false);
  });

  test("is a setter, so running it twice lands in the same place", () => {
    setIncludeDrafts(true);
    expect(includingDrafts()).toBe(true);
    setIncludeDrafts(true);
    expect(includingDrafts()).toBe(true);
    setIncludeDrafts(false);
    expect(includingDrafts()).toBe(false);
  });

  test("is reactive, which is what lets every list share it", () => {
    const seen: boolean[] = [];
    const scope = effectScope();
    scope.run(() => {
      effect(() => seen.push(draftView.includeDrafts));
    });
    setIncludeDrafts(true);
    scope.stop();
    setIncludeDrafts(false);
    expect(seen).toEqual([false, true]);
  });
});
