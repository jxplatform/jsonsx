import "./with-dom.js";
import { expect, test, describe } from "bun:test";
import {
  findTemplateExpressions,
  normalizeInlineContent,
  expandRangeToTemplateExpressions,
  isTagActiveInSelection,
  toggleInlineFormat,
} from "../src/editor/inline-format";

describe("findTemplateExpressions", () => {
  test("no expressions", () => {
    expect(findTemplateExpressions("hello world")).toEqual([]);
  });

  test("single expression", () => {
    expect(findTemplateExpressions("hello ${name} world")).toEqual([{ start: 6, end: 13 }]);
  });

  test("expression at start", () => {
    expect(findTemplateExpressions("${x} rest")).toEqual([{ start: 0, end: 4 }]);
  });

  test("expression at end", () => {
    expect(findTemplateExpressions("rest ${x}")).toEqual([{ start: 5, end: 9 }]);
  });

  test("multiple expressions", () => {
    expect(findTemplateExpressions("a ${b} c ${d} e")).toEqual([
      { start: 2, end: 6 },
      { start: 9, end: 13 },
    ]);
  });

  test("nested braces", () => {
    expect(findTemplateExpressions("${obj.map(x => {x})}")).toEqual([{ start: 0, end: 20 }]);
  });

  test("adjacent expressions", () => {
    expect(findTemplateExpressions("${a}${b}")).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
    ]);
  });

  test("dollar without brace is not an expression", () => {
    expect(findTemplateExpressions("$100 and ${x}")).toEqual([{ start: 9, end: 13 }]);
  });

  test("unclosed expression is ignored", () => {
    expect(findTemplateExpressions("${unclosed")).toEqual([]);
  });
});

// ─── expandRangeToTemplateExpressions ─────────────────────────────────────────

describe("expandRangeToTemplateExpressions", () => {
  test("expands start boundary into template expression", () => {
    const textNode = document.createTextNode("Hello ${name} world");
    const container = document.createElement("div");
    container.appendChild(textNode);
    document.body.appendChild(container);

    const range = document.createRange();
    range.setStart(textNode, 8); // inside ${name}
    range.setEnd(textNode, 19);

    expandRangeToTemplateExpressions(range);
    expect(range.startOffset).toBe(6);

    document.body.removeChild(container);
  });

  test("expands end boundary into template expression", () => {
    const textNode = document.createTextNode("Hello ${name} world");
    const container = document.createElement("div");
    container.appendChild(textNode);
    document.body.appendChild(container);

    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 10); // inside ${name}

    expandRangeToTemplateExpressions(range);
    expect(range.endOffset).toBe(13);

    document.body.removeChild(container);
  });

  test("does nothing when range is outside expressions", () => {
    const textNode = document.createTextNode("Hello ${name} world");
    const container = document.createElement("div");
    container.appendChild(textNode);
    document.body.appendChild(container);

    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);

    expandRangeToTemplateExpressions(range);
    expect(range.startOffset).toBe(0);
    expect(range.endOffset).toBe(5);

    document.body.removeChild(container);
  });

  test("handles non-text node containers", () => {
    const el = document.createElement("div");
    const child = document.createElement("span");
    el.appendChild(child);
    document.body.appendChild(el);

    const range = document.createRange();
    range.setStart(el, 0);
    range.setEnd(el, 1);

    expandRangeToTemplateExpressions(range);
    expect(range.startOffset).toBe(0);

    document.body.removeChild(el);
  });
});

// ─── normalizeInlineContent ───────────────────────────────────────────────────

describe("normalizeInlineContent", () => {
  test("handles null root", () => {
    normalizeInlineContent(null);
  });

  test("merges adjacent same-tag siblings", () => {
    const root = document.createElement("div");
    const s1 = document.createElement("strong");
    s1.textContent = "hello";
    const s2 = document.createElement("strong");
    s2.textContent = " world";
    root.appendChild(s1);
    root.appendChild(s2);

    normalizeInlineContent(root);
    expect(root.querySelectorAll("strong").length).toBe(1);
    expect((root.querySelector("strong") as Element).textContent).toBe("hello world");
  });

  test("collapses redundant nesting", () => {
    const root = document.createElement("div");
    const outer = document.createElement("em");
    const inner = document.createElement("em");
    inner.textContent = "italic";
    outer.appendChild(inner);
    root.appendChild(outer);

    normalizeInlineContent(root);
    const ems = root.querySelectorAll("em");
    expect(ems.length).toBe(1);
    expect(ems[0].textContent).toBe("italic");
  });

  test("removes empty inline elements", () => {
    const root = document.createElement("div");
    const empty = document.createElement("strong");
    root.appendChild(empty);
    root.appendChild(document.createTextNode("text"));

    normalizeInlineContent(root);
    expect(root.querySelectorAll("strong").length).toBe(0);
    expect(root.textContent).toBe("text");
  });

  test("lifts leading whitespace from inline wrappers", () => {
    const root = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = " bold";
    root.appendChild(strong);

    normalizeInlineContent(root);
    const s = root.querySelector("strong");
    if (s) {
      expect(s.textContent).toBe("bold");
    }
  });

  test("unwraps bare span elements", () => {
    const root = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = "plain";
    root.appendChild(span);

    normalizeInlineContent(root);
    expect(root.querySelectorAll("span").length).toBe(0);
    expect(root.textContent).toBe("plain");
  });

  test("keeps span with attributes", () => {
    const root = document.createElement("div");
    const span = document.createElement("span");
    span.className = "highlight";
    span.textContent = "styled";
    root.appendChild(span);

    normalizeInlineContent(root);
    expect(root.querySelectorAll("span").length).toBe(1);
  });

  test("does not merge different tags", () => {
    const root = document.createElement("div");
    const em = document.createElement("em");
    em.textContent = "italic";
    const strong = document.createElement("strong");
    strong.textContent = "bold";
    root.appendChild(em);
    root.appendChild(strong);

    normalizeInlineContent(root);
    expect(root.querySelectorAll("em").length).toBe(1);
    expect(root.querySelectorAll("strong").length).toBe(1);
  });
});

// ─── isTagActiveInSelection ───────────────────────────────────────────────────

describe("isTagActiveInSelection", () => {
  test("returns false when editableRoot is null", () => {
    expect(isTagActiveInSelection("strong", null)).toBe(false);
  });

  test("returns false when contentEditable is plaintext-only", () => {
    const el = document.createElement("div");
    el.contentEditable = "plaintext-only";
    expect(isTagActiveInSelection("strong", el)).toBe(false);
  });

  test("returns false when no selection exists", () => {
    const el = document.createElement("div");
    el.contentEditable = "true";
    document.body.appendChild(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    const result = isTagActiveInSelection("strong", el);
    expect(result).toBe(false);
    document.body.removeChild(el);
  });
});

// ─── toggleInlineFormat ───────────────────────────────────────────────────────

describe("toggleInlineFormat", () => {
  test("does nothing when editableRoot is null", () => {
    toggleInlineFormat("strong", null);
  });

  test("does nothing with collapsed selection", () => {
    const root = document.createElement("div");
    root.contentEditable = "true";
    root.textContent = "hello";
    document.body.appendChild(root);

    const range = document.createRange();
    range.setStart(root.firstChild as Node, 2);
    range.collapse(true);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);

    toggleInlineFormat("strong", root);
    expect(root.querySelectorAll("strong").length).toBe(0);

    document.body.removeChild(root);
  });

  test("wraps selected text in tag", () => {
    const root = document.createElement("div");
    root.contentEditable = "true";
    root.textContent = "hello world";
    document.body.appendChild(root);

    const range = document.createRange();
    range.setStart(root.firstChild as Node, 6);
    range.setEnd(root.firstChild as Node, 11);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);

    toggleInlineFormat("strong", root);

    expect(root.querySelector("strong")).not.toBeNull();
    expect((root.querySelector("strong") as Element).textContent).toBe("world");

    document.body.removeChild(root);
  });

  test("unwraps existing formatting", () => {
    const root = document.createElement("div");
    root.contentEditable = "true";
    const strong = document.createElement("strong");
    strong.textContent = "bold text";
    root.appendChild(strong);
    document.body.appendChild(root);

    const range = document.createRange();
    range.selectNodeContents(strong);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);

    toggleInlineFormat("strong", root);

    expect(root.querySelectorAll("strong").length).toBe(0);
    expect(root.textContent).toBe("bold text");

    document.body.removeChild(root);
  });

  test("does not act on selection outside root", () => {
    const root = document.createElement("div");
    root.contentEditable = "true";
    root.textContent = "inside";
    const outside = document.createElement("div");
    outside.textContent = "outside";
    document.body.appendChild(root);
    document.body.appendChild(outside);

    const range = document.createRange();
    range.selectNodeContents(outside);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);

    toggleInlineFormat("strong", root);
    expect(root.querySelectorAll("strong").length).toBe(0);

    document.body.removeChild(root);
    document.body.removeChild(outside);
  });
});
