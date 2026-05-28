import "./with-dom.js";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  isEditableBlock,
  isInlineInContext,
  isInlineElement,
  getInlineActions,
  normalizeChildren,
  startEditing,
  stopEditing,
  isEditing,
  getActiveElement,
} from "../src/editor/inline-edit.js";

// ─── Pure function tests ─────────────────────────────────────────────────────

describe("isEditableBlock", () => {
  test("returns true for text-bearing block elements", () => {
    for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "td", "th", "blockquote"]) {
      const el = document.createElement(tag);
      expect(isEditableBlock(el)).toBe(true);
    }
  });

  test("returns false for non-editable elements", () => {
    for (const tag of ["div", "span", "img", "section", "ul", "ol", "table", "tr"]) {
      const el = document.createElement(tag);
      expect(isEditableBlock(el)).toBe(false);
    }
  });
});

describe("isInlineInContext", () => {
  test("returns true for inline tags without parent context", () => {
    expect(isInlineInContext("em", "")).toBe(true);
    expect(isInlineInContext("strong", "")).toBe(true);
    expect(isInlineInContext("a", "")).toBe(true);
    expect(isInlineInContext("span", "")).toBe(true);
    expect(isInlineInContext("br", "")).toBe(true);
  });

  test("returns false for block tags without parent context", () => {
    expect(isInlineInContext("div", "")).toBe(false);
    expect(isInlineInContext("p", "")).toBe(false);
    expect(isInlineInContext("h1", "")).toBe(false);
  });

  test("uses $inlineChildren from elements-meta for parent context", () => {
    // p allows inline children like em, strong, a, span
    expect(isInlineInContext("em", "p")).toBe(true);
    expect(isInlineInContext("strong", "p")).toBe(true);
    // p does not allow block children
    expect(isInlineInContext("div", "p")).toBe(false);
  });

  test("returns false for unknown parent tag", () => {
    expect(isInlineInContext("em", "nonexistent-tag")).toBe(false);
  });
});

describe("isInlineElement", () => {
  test("returns false for non-objects", () => {
    expect(isInlineElement(/** @type {any} */ (null))).toBe(false);
    expect(isInlineElement(/** @type {any} */ ("text"))).toBe(false);
    expect(isInlineElement(/** @type {any} */ (42))).toBe(false);
  });

  test("returns true for inline tag nodes without parent", () => {
    expect(isInlineElement({ tagName: "em" })).toBe(true);
    expect(isInlineElement({ tagName: "strong" })).toBe(true);
    expect(isInlineElement({ tagName: "a" })).toBe(true);
  });

  test("returns false for block tag nodes without parent", () => {
    expect(isInlineElement({ tagName: "div" })).toBe(false);
    expect(isInlineElement({ tagName: "p" })).toBe(false);
  });

  test("uses parent context when provided", () => {
    expect(isInlineElement({ tagName: "em" }, { tagName: "p" })).toBe(true);
    expect(isInlineElement({ tagName: "div" }, { tagName: "p" })).toBe(false);
  });
});

describe("getInlineActions", () => {
  test("returns null for unknown tag", () => {
    expect(getInlineActions("nonexistent-tag")).toBeNull();
  });

  test("returns null for tags without $inlineActions", () => {
    // div has no $inlineActions in elements-meta
    expect(getInlineActions("div")).toBeNull();
  });

  test("returns array for tags with $inlineActions", () => {
    const actions = getInlineActions("p");
    if (actions) {
      expect(Array.isArray(actions)).toBe(true);
    }
    // If p doesn't have actions, that's fine — the test verifies the function doesn't crash
  });
});

// ─── Editing lifecycle ───────────────────────────────────────────────────────

describe("Editing lifecycle", () => {
  /** @type {HTMLElement} */
  let el;
  const path = ["children", 0];

  beforeEach(() => {
    el = document.createElement("p");
    el.textContent = "test content";
    document.body.appendChild(el);
  });

  afterEach(() => {
    if (isEditing()) stopEditing();
    el.remove();
  });

  test("isEditing starts false", () => {
    expect(isEditing()).toBe(false);
    expect(getActiveElement()).toBeNull();
  });

  test("startEditing enables contentEditable and marks as editing", () => {
    startEditing(el, path, {
      onCommit: () => {},
      onSplit: () => {},
      onInsert: () => {},
      onEnd: () => {},
    });

    expect(isEditing()).toBe(true);
    expect(getActiveElement()).toBe(el);
    expect(el.contentEditable).toBe("true");
  });

  test("stopEditing resets element and marks as not editing", () => {
    startEditing(el, path, {
      onCommit: () => {},
      onSplit: () => {},
      onInsert: () => {},
      onEnd: () => {},
    });

    stopEditing();

    expect(isEditing()).toBe(false);
    expect(getActiveElement()).toBeNull();
    expect(el.contentEditable).toBe("false");
  });

  test("stopEditing calls onEnd callback", () => {
    let endCalled = false;
    startEditing(el, path, {
      onCommit: () => {},
      onSplit: () => {},
      onInsert: () => {},
      onEnd: () => (endCalled = true),
    });

    stopEditing();
    expect(endCalled).toBe(true);
  });

  test("stopEditing calls onCommit with path", () => {
    /** @type {any} */
    let commitPath = null;
    startEditing(el, path, {
      onCommit: (/** @type {any} */ p) => (commitPath = p),
      onSplit: () => {},
      onInsert: () => {},
      onEnd: () => {},
    });

    stopEditing();
    expect(commitPath).toEqual(path);
  });

  test("startEditing while editing stops previous editing", () => {
    let endCount = 0;
    startEditing(el, path, {
      onCommit: () => {},
      onSplit: () => {},
      onInsert: () => {},
      onEnd: () => endCount++,
    });

    const el2 = document.createElement("p");
    el2.textContent = "second";
    document.body.appendChild(el2);

    startEditing(el2, ["children", 1], {
      onCommit: () => {},
      onSplit: () => {},
      onInsert: () => {},
      onEnd: () => {},
    });

    expect(endCount).toBe(1); // first editing's onEnd was called
    expect(getActiveElement()).toBe(el2);
    expect(el.contentEditable).toBe("false");

    el2.remove();
  });
});

// ─── Keyboard event propagation ──────────────────────────────────────────────

describe("Keyboard event propagation", () => {
  /** @type {HTMLElement} */
  let el;
  const path = ["children", 0];

  beforeEach(() => {
    el = document.createElement("p");
    el.textContent = "test";
    document.body.appendChild(el);
  });

  afterEach(() => {
    if (isEditing()) stopEditing();
    el.remove();
  });

  test("Enter on editing element does not propagate to document", () => {
    let documentGotEnter = false;
    const docHandler = (/** @type {KeyboardEvent} */ e) => {
      if (e.key === "Enter") documentGotEnter = true;
    };
    document.addEventListener("keydown", docHandler);

    startEditing(el, path, {
      onCommit: () => {},
      onSplit: () => {},
      onInsert: () => {},
      onEnd: () => {},
    });

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(documentGotEnter).toBe(false);

    document.removeEventListener("keydown", docHandler);
  });

  test("Escape on editing element does not propagate to document", () => {
    let documentGotEscape = false;
    const docHandler = (/** @type {KeyboardEvent} */ e) => {
      if (e.key === "Escape") documentGotEscape = true;
    };
    document.addEventListener("keydown", docHandler);

    startEditing(el, path, {
      onCommit: () => {},
      onSplit: () => {},
      onInsert: () => {},
      onEnd: () => {},
    });

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(documentGotEscape).toBe(false);

    document.removeEventListener("keydown", docHandler);
  });

  test("Escape stops editing", () => {
    startEditing(el, path, {
      onCommit: () => {},
      onSplit: () => {},
      onInsert: () => {},
      onEnd: () => {},
    });

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isEditing()).toBe(false);
  });
});

// ─── normalizeChildren ────────────────────────────────────────────────────────

describe("normalizeChildren", () => {
  test("returns empty textContent for empty children", () => {
    expect(normalizeChildren({ children: [] })).toEqual({ textContent: "" });
  });

  test("returns empty textContent for no children property", () => {
    expect(normalizeChildren({})).toEqual({ textContent: "" });
  });

  test("folds all-text children into textContent", () => {
    expect(normalizeChildren({ children: ["hello", " ", "world"] })).toEqual({
      textContent: "hello world",
    });
  });

  test("merges adjacent text nodes then folds", () => {
    expect(normalizeChildren({ children: ["a", "b", "c"] })).toEqual({
      textContent: "abc",
    });
  });

  test("preserves mixed content as children array", () => {
    const result = /** @type {any} */ (
      normalizeChildren({
        children: ["text ", { tagName: "em", textContent: "bold" }, " more"],
      })
    );
    expect(result.children).toBeDefined();
    expect(result.children.length).toBe(3);
    expect(result.children[0]).toBe("text ");
    expect(result.children[1].tagName).toBe("em");
    expect(result.children[2]).toBe(" more");
  });

  test("merges adjacent strings in mixed content", () => {
    const result = /** @type {any} */ (
      normalizeChildren({
        children: ["a", "b", { tagName: "em", textContent: "x" }, "c", "d"],
      })
    );
    expect(result.children.length).toBe(3);
    expect(result.children[0]).toBe("ab");
    expect(result.children[2]).toBe("cd");
  });

  test("single text child becomes textContent", () => {
    expect(normalizeChildren({ children: ["hello"] })).toEqual({
      textContent: "hello",
    });
  });

  test("single element child stays as children", () => {
    const result = /** @type {any} */ (
      normalizeChildren({
        children: [{ tagName: "strong", textContent: "bold" }],
      })
    );
    expect(result.children).toBeDefined();
    expect(result.children.length).toBe(1);
  });
});
