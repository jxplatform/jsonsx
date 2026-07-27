/**
 * Which tags can hold a text caret, derived from the document's element vocabulary rather than a
 * hand-maintained list.
 *
 * The interesting property is the LAYERING: the format class overrides per tag, and must be able to
 * say NO — a set union could only ever add.
 */
import { describe, expect, test } from "bun:test";
import { BUILTIN_EDITABLE_TAGS, isEditableTag } from "../src/editor/editable-tags";
import { formatEditableVerdicts } from "../src/format/constraints";

/** Markdown's declaration, trimmed to the tags these tests reason about. */
const MARKDOWN = {
  block: ["h1", "p", "blockquote", "ul", "li", "pre", "table", "tr", "td"],
  inline: ["em", "strong", "del", "code", "a", "img", "br"],
  nesting: {
    _root: { block: true, directive: true, inline: false },
    blockquote: { block: true, directive: true, inline: false },
    h1: { block: false, directive: false, inline: true },
    li: { block: true, directive: true, inline: true },
    p: { block: false, directive: true, inline: true },
    pre: { only: ["code"] },
    table: { only: ["thead", "tbody"] },
    td: { block: false, directive: false, inline: true },
    tr: { only: ["th", "td"] },
    ul: { only: ["li"] },
  },
};

describe("the studio's built-in vocabulary", () => {
  test("includes the text blocks and the HTML ones directives produce", () => {
    for (const tag of [
      "p",
      "h1",
      "h6",
      "li",
      "td",
      "th",
      "figcaption",
      "caption",
      "summary",
      "dt",
      "dd",
      "label",
    ]) {
      expect(BUILTIN_EDITABLE_TAGS.has(tag)).toBe(true);
    }
  });

  test("excludes containers, which declare no inline children", () => {
    for (const tag of ["div", "ul", "section", "article", "main"]) {
      expect(BUILTIN_EDITABLE_TAGS.has(tag)).toBe(false);
    }
  });

  test("excludes pre — preformatted code is not the inline-markup path", () => {
    expect(BUILTIN_EDITABLE_TAGS.has("pre")).toBe(false);
  });
});

describe("formatEditableVerdicts", () => {
  test("a tag that accepts inline children holds a caret", () => {
    const v = formatEditableVerdicts(MARKDOWN);
    expect(v.p).toBe(true);
    expect(v.h1).toBe(true);
    expect(v.td).toBe(true);
    expect(v.li).toBe(true);
  });

  test("a container that holds BLOCKS does not", () => {
    // Markdown's blockquote holds paragraphs, so the caret belongs in the <p> inside it.
    expect(formatEditableVerdicts(MARKDOWN).blockquote).toBe(false);
  });

  test("a container declared with `only` does not", () => {
    const v = formatEditableVerdicts(MARKDOWN);
    for (const tag of ["ul", "table", "tr", "pre"]) {
      expect(v[tag]).toBe(false);
    }
  });

  test("the format's inline tags are markup within a block, never a block", () => {
    // Without this, clicking a link would make the LINK the active block, and typing would commit
    // To the anchor's path rather than the paragraph's.
    const v = formatEditableVerdicts(MARKDOWN);
    expect(v.a).toBe(false);
    expect(v.strong).toBe(false);
    expect(v.code).toBe(false);
  });

  test("the document root is not an element and gets no verdict", () => {
    expect(formatEditableVerdicts(MARKDOWN)._root).toBeUndefined();
  });

  test("an absent or empty declaration yields no overrides", () => {
    expect(formatEditableVerdicts()).toEqual({});
    expect(formatEditableVerdicts({})).toEqual({});
  });
});

describe("isEditableTag — the two layers together", () => {
  const md = formatEditableVerdicts(MARKDOWN);

  test("with no format, the built-in vocabulary answers alone", () => {
    expect(isEditableTag("p", null)).toBe(true);
    expect(isEditableTag("div", null)).toBe(false);
    // A native .json document may hold inline text in a blockquote, and HTML allows it.
    expect(isEditableTag("blockquote", null)).toBe(true);
  });

  test("the format OVERRIDES the built-in answer, including to say no", () => {
    // The whole reason this is a per-tag lookup rather than a union.
    expect(isEditableTag("blockquote", null)).toBe(true);
    expect(isEditableTag("blockquote", md)).toBe(false);
    expect(isEditableTag("a", null)).toBe(true);
    expect(isEditableTag("a", md)).toBe(false);
  });

  test("a tag the format says nothing about falls back to the built-in vocabulary", () => {
    // Directive-produced HTML: markdown's declaration never mentions these.
    expect(md.figcaption).toBeUndefined();
    expect(isEditableTag("figcaption", md)).toBe(true);
    expect(isEditableTag("summary", md)).toBe(true);
    // …and a container is still refused on the way through.
    expect(isEditableTag("div", md)).toBe(false);
  });

  test("tag names are matched case-insensitively", () => {
    // `el.tagName` is upper-case in HTML documents.
    expect(isEditableTag("P", null)).toBe(true);
    expect(isEditableTag("BLOCKQUOTE", md)).toBe(false);
    expect(isEditableTag("FIGCAPTION", md)).toBe(true);
  });

  test("an unknown tag holds no caret", () => {
    expect(isEditableTag("x-card", md)).toBe(false);
    expect(isEditableTag("marquee", null)).toBe(false);
  });
});
