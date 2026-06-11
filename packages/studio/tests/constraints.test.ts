/**
 * Generic nesting-validator tests — the editing constraints now come from the format class's
 * $studio.elements metadata, interpreted by createNestingValidator. Assertions ported from the old
 * hard-coded markdown allowlist tests.
 */
import { describe, expect, test } from "bun:test";
import { createNestingValidator } from "../src/format/constraints";
import { MARKDOWN_FORMAT } from "./format-fixture";

const v = createNestingValidator(MARKDOWN_FORMAT.studio?.elements);

describe("createNestingValidator from Markdown $studio.elements", () => {
  test("classifies block and inline tags", () => {
    for (const h of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
      expect(v.blockTags.has(h)).toBe(true);
    }
    for (const tag of ["p", "blockquote", "ul", "ol", "li", "pre", "hr", "table"]) {
      expect(v.blockTags.has(tag)).toBe(true);
    }
    for (const tag of ["em", "strong", "del", "code", "a", "img", "br"]) {
      expect(v.inlineTags.has(tag)).toBe(true);
    }
    expect(v.inlineTags.has("p")).toBe(false);
    expect(v.blockTags.has("div")).toBe(false);
    expect(v.allTags.size).toBe(v.blockTags.size + v.inlineTags.size);
  });

  test("void and text-only tags", () => {
    expect(v.isVoid("hr")).toBe(true);
    expect(v.isVoid("br")).toBe(true);
    expect(v.isVoid("img")).toBe(true);
    expect(v.isVoid("p")).toBe(false);
    expect(v.isTextOnly("code")).toBe(true);
    expect(v.isTextOnly("pre")).toBe(false);
  });

  test("root allows block elements and directives, not inline", () => {
    expect(v.isValidChild("_root", "p")).toBe(true);
    expect(v.isValidChild("_root", "h1")).toBe(true);
    expect(v.isValidChild("_root", "blockquote")).toBe(true);
    expect(v.isValidChild("_root", "em")).toBe(false);
    expect(v.isValidChild("_root", "strong")).toBe(false);
    expect(v.isValidChild("_root", "my-component")).toBe(true);
    expect(v.isValidChild("_root", "div")).toBe(true);
  });

  test("headings allow inline only", () => {
    expect(v.isValidChild("h1", "em")).toBe(true);
    expect(v.isValidChild("h1", "strong")).toBe(true);
    expect(v.isValidChild("h1", "a")).toBe(true);
    expect(v.isValidChild("h1", "p")).toBe(false);
    expect(v.isValidChild("h1", "ul")).toBe(false);
    expect(v.isValidChild("h1", "my-component")).toBe(false);
  });

  test("'only' lists are strict", () => {
    expect(v.isValidChild("ul", "li")).toBe(true);
    expect(v.isValidChild("ul", "p")).toBe(false);
    expect(v.isValidChild("ul", "em")).toBe(false);
    expect(v.isValidChild("ul", "div")).toBe(false);
    expect(v.isValidChild("pre", "code")).toBe(true);
    expect(v.isValidChild("pre", "p")).toBe(false);
    expect(v.isValidChild("table", "thead")).toBe(true);
    expect(v.isValidChild("table", "tbody")).toBe(true);
    expect(v.isValidChild("table", "tr")).toBe(false);
    expect(v.isValidChild("thead", "tr")).toBe(true);
    expect(v.isValidChild("thead", "td")).toBe(false);
    expect(v.isValidChild("tr", "th")).toBe(true);
    expect(v.isValidChild("tr", "td")).toBe(true);
    expect(v.isValidChild("tr", "p")).toBe(false);
  });

  test("list items accept block, inline, and directives", () => {
    expect(v.isValidChild("li", "p")).toBe(true);
    expect(v.isValidChild("li", "em")).toBe(true);
    expect(v.isValidChild("li", "my-widget")).toBe(true);
  });

  test("paragraphs allow inline and directives", () => {
    expect(v.isValidChild("p", "em")).toBe(true);
    expect(v.isValidChild("p", "my-component")).toBe(true);
    expect(v.isValidChild("p", "h1")).toBe(false);
  });

  test("unknown parents (directive components) allow anything", () => {
    expect(v.isValidChild("my-component", "p")).toBe(true);
    expect(v.isValidChild("my-component", "em")).toBe(true);
    expect(v.isValidChild("my-component", "div")).toBe(true);
  });

  test("empty metadata yields a permissive validator", () => {
    const empty = createNestingValidator();
    expect(empty.isValidChild("_root", "anything")).toBe(true);
    expect(empty.isVoid("hr")).toBe(false);
  });
});
