import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import {
  MD_BLOCK,
  MD_INLINE,
  MD_ALL,
  MD_VOID,
  MD_TEXT_ONLY,
  MD_NESTING,
  isValidChild,
} from "../src/markdown/md-allowlist.js";

// ─── Set membership ──────────────────────────────────────────────────────────

describe("MD_BLOCK", () => {
  test("contains all heading levels", () => {
    for (const h of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
      expect(MD_BLOCK.has(h)).toBe(true);
    }
  });

  test("contains list and table elements", () => {
    for (const tag of ["ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td"]) {
      expect(MD_BLOCK.has(tag)).toBe(true);
    }
  });

  test("contains p, blockquote, pre, hr", () => {
    for (const tag of ["p", "blockquote", "pre", "hr"]) {
      expect(MD_BLOCK.has(tag)).toBe(true);
    }
  });

  test("does not contain inline elements", () => {
    for (const tag of ["em", "strong", "a", "img"]) {
      expect(MD_BLOCK.has(tag)).toBe(false);
    }
  });
});

describe("MD_INLINE", () => {
  test("contains expected inline elements", () => {
    for (const tag of ["em", "strong", "del", "code", "a", "img", "br"]) {
      expect(MD_INLINE.has(tag)).toBe(true);
    }
  });

  test("does not contain block elements", () => {
    expect(MD_INLINE.has("p")).toBe(false);
    expect(MD_INLINE.has("h1")).toBe(false);
  });
});

describe("MD_ALL", () => {
  test("is union of MD_BLOCK and MD_INLINE", () => {
    for (const tag of MD_BLOCK) expect(MD_ALL.has(tag)).toBe(true);
    for (const tag of MD_INLINE) expect(MD_ALL.has(tag)).toBe(true);
    expect(MD_ALL.size).toBe(MD_BLOCK.size + MD_INLINE.size);
  });
});

describe("MD_VOID", () => {
  test("contains hr, br, img", () => {
    expect(MD_VOID.has("hr")).toBe(true);
    expect(MD_VOID.has("br")).toBe(true);
    expect(MD_VOID.has("img")).toBe(true);
  });

  test("does not contain non-void elements", () => {
    expect(MD_VOID.has("p")).toBe(false);
    expect(MD_VOID.has("a")).toBe(false);
  });
});

describe("MD_TEXT_ONLY", () => {
  test("contains code", () => {
    expect(MD_TEXT_ONLY.has("code")).toBe(true);
  });

  test("does not contain other elements", () => {
    expect(MD_TEXT_ONLY.has("p")).toBe(false);
    expect(MD_TEXT_ONLY.has("pre")).toBe(false);
  });
});

// ─── Nesting rules ──────────────────────────────────────────────────────────

describe("MD_NESTING", () => {
  test("_root allows blocks and directives but not inline", () => {
    const rule = MD_NESTING._root;
    expect(rule.block).toBe(true);
    expect(rule.inline).toBe(false);
    expect(rule.directive).toBe(true);
  });

  test("headings allow inline only", () => {
    for (const h of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
      expect(MD_NESTING[h].inline).toBe(true);
      expect(MD_NESTING[h].block).toBe(false);
      expect(MD_NESTING[h].directive).toBe(false);
    }
  });

  test("ul/ol only allow li", () => {
    expect(MD_NESTING.ul.only).toEqual(new Set(["li"]));
    expect(MD_NESTING.ol.only).toEqual(new Set(["li"]));
  });

  test("pre only allows code", () => {
    expect(MD_NESTING.pre.only).toEqual(new Set(["code"]));
  });

  test("table only allows thead/tbody", () => {
    expect(MD_NESTING.table.only).toEqual(new Set(["thead", "tbody"]));
  });
});

// ─── isValidChild ────────────────────────────────────────────────────────────

describe("isValidChild", () => {
  test("root accepts block elements", () => {
    expect(isValidChild("_root", "p")).toBe(true);
    expect(isValidChild("_root", "h1")).toBe(true);
    expect(isValidChild("_root", "blockquote")).toBe(true);
  });

  test("root rejects inline elements", () => {
    expect(isValidChild("_root", "em")).toBe(false);
    expect(isValidChild("_root", "strong")).toBe(false);
  });

  test("root accepts directives (non-markdown tags)", () => {
    expect(isValidChild("_root", "my-component")).toBe(true);
    expect(isValidChild("_root", "div")).toBe(true);
  });

  test("heading accepts inline, rejects block", () => {
    expect(isValidChild("h1", "em")).toBe(true);
    expect(isValidChild("h1", "strong")).toBe(true);
    expect(isValidChild("h1", "a")).toBe(true);
    expect(isValidChild("h1", "p")).toBe(false);
    expect(isValidChild("h1", "ul")).toBe(false);
  });

  test("heading rejects directives", () => {
    expect(isValidChild("h1", "my-component")).toBe(false);
  });

  test("ul only accepts li", () => {
    expect(isValidChild("ul", "li")).toBe(true);
    expect(isValidChild("ul", "p")).toBe(false);
    expect(isValidChild("ul", "em")).toBe(false);
    expect(isValidChild("ul", "div")).toBe(false);
  });

  test("li accepts block, inline, and directives", () => {
    expect(isValidChild("li", "p")).toBe(true);
    expect(isValidChild("li", "em")).toBe(true);
    expect(isValidChild("li", "my-widget")).toBe(true);
  });

  test("pre only accepts code", () => {
    expect(isValidChild("pre", "code")).toBe(true);
    expect(isValidChild("pre", "p")).toBe(false);
    expect(isValidChild("pre", "em")).toBe(false);
  });

  test("p accepts inline and directives, rejects block", () => {
    expect(isValidChild("p", "em")).toBe(true);
    expect(isValidChild("p", "my-component")).toBe(true);
    expect(isValidChild("p", "h1")).toBe(false);
  });

  test("unknown parent allows anything (directive components)", () => {
    expect(isValidChild("my-component", "p")).toBe(true);
    expect(isValidChild("my-component", "em")).toBe(true);
    expect(isValidChild("my-component", "div")).toBe(true);
  });

  test("table structure enforced", () => {
    expect(isValidChild("table", "thead")).toBe(true);
    expect(isValidChild("table", "tbody")).toBe(true);
    expect(isValidChild("table", "tr")).toBe(false);
    expect(isValidChild("thead", "tr")).toBe(true);
    expect(isValidChild("thead", "td")).toBe(false);
    expect(isValidChild("tr", "th")).toBe(true);
    expect(isValidChild("tr", "td")).toBe(true);
    expect(isValidChild("tr", "p")).toBe(false);
  });
});
