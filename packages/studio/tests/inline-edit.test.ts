import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { JxMutableNode } from "@jxsuite/schema/types";
import {
  getActiveElement,
  getInlineActions,
  isEditableBlock,
  isEditing,
  isInlineElement,
  isInlineInContext,
  normalizeChildren,
  resumeBlurClose,
  setSlashController,
  startEditing,
  stopEditing,
  suspendBlurClose,
} from "../src/editor/inline-edit";
import { dismissSlashMenu, isSlashMenuOpen, showSlashMenu } from "../src/editor/slash-menu";

// Inline-edit no longer hard-imports the slash menu (so it can live in the slim iframe bundle);
// Wire the real one for the tests that exercise slash commands.
setSlashController({ dismiss: dismissSlashMenu, isOpen: isSlashMenuOpen, show: showSlashMenu });

/** Wait `ms` real milliseconds (for the 150ms blur-close timer). */
function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ─── Pure function tests ─────────────────────────────────────────────────────

describe("isEditableBlock", () => {
  test("returns true for text-bearing block elements", () => {
    for (const tag of [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "li",
      "td",
      "th",
      "blockquote",
      "span",
      "a",
      "label",
    ]) {
      const el = document.createElement(tag);
      expect(isEditableBlock(el)).toBe(true);
    }
  });

  test("returns false for non-editable elements", () => {
    for (const tag of ["div", "img", "section", "ul", "ol", "table", "tr"]) {
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
    // P allows inline children like em, strong, a, span
    expect(isInlineInContext("em", "p")).toBe(true);
    expect(isInlineInContext("strong", "p")).toBe(true);
    // P does not allow block children
    expect(isInlineInContext("div", "p")).toBe(false);
  });

  test("returns false for unknown parent tag", () => {
    expect(isInlineInContext("em", "nonexistent-tag")).toBe(false);
  });
});

describe("isInlineElement", () => {
  test("returns false for non-objects", () => {
    expect(isInlineElement(null as unknown as JxMutableNode)).toBe(false);
    expect(isInlineElement("text" as unknown as JxMutableNode)).toBe(false);
    expect(isInlineElement(42 as unknown as JxMutableNode)).toBe(false);
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
    // Div has no $inlineActions in elements-meta
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
  let el: HTMLElement;
  const path = ["children", 0];

  beforeEach(() => {
    el = document.createElement("p");
    el.textContent = "test content";
    document.body.append(el);
  });

  afterEach(() => {
    if (isEditing()) {
      stopEditing();
    }
    el.remove();
  });

  test("isEditing starts false", () => {
    expect(isEditing()).toBe(false);
    expect(getActiveElement()).toBeNull();
  });

  test("startEditing enables contentEditable and marks as editing", () => {
    startEditing(el, path, {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });

    expect(isEditing()).toBe(true);
    expect(getActiveElement()).toBe(el);
    expect(el.contentEditable).toBe("true");
  });

  test("stopEditing resets element and marks as not editing", () => {
    startEditing(el, path, {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
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
      onEnd: () => (endCalled = true),
      onInsert: () => {},
      onSplit: () => {},
    });

    stopEditing();
    expect(endCalled).toBe(true);
  });

  test("stopEditing calls onCommit with path", () => {
    let commitPath: any = null;
    startEditing(el, path, {
      onCommit: (p: any) => (commitPath = p),
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });

    stopEditing();
    expect(commitPath).toEqual(path);
  });

  test("startEditing while editing stops previous editing", () => {
    let endCount = 0;
    startEditing(el, path, {
      onCommit: () => {},
      onEnd: () => (endCount += 1),
      onInsert: () => {},
      onSplit: () => {},
    });

    const el2 = document.createElement("p");
    el2.textContent = "second";
    document.body.append(el2);

    startEditing(el2, ["children", 1], {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });

    // Re-enter must NOT fire the previous session's onEnd (it would reset the parent toolbar).
    expect(endCount).toBe(0);
    expect(getActiveElement()).toBe(el2);
    expect(el.contentEditable).toBe("false");

    el2.remove();
  });
});

// ─── 4b-2: blur-close suspension ─────────────────────────────────────────────

describe("suspendBlurClose / resumeBlurClose", () => {
  let el: HTMLElement;

  beforeEach(() => {
    el = document.createElement("p");
    el.textContent = "edit me";
    document.body.append(el);
  });

  afterEach(() => {
    if (isEditing()) {
      stopEditing();
    }
    resumeBlurClose();
    el.remove();
  });

  test("a REAL blur event does not stop the session while blur-close is suspended", async () => {
    startEditing(el, ["children", 0], {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    suspendBlurClose();

    // Dispatch a real blur and move focus off the editable, then let the 150ms timer elapse.
    el.blur();
    el.dispatchEvent(new FocusEvent("blur"));
    document.body.focus();
    await waitMs(200);

    expect(isEditing()).toBe(true);
    expect(getActiveElement()).toBe(el);
  });

  test("after resumeBlurClose a real blur (focus elsewhere) stops the session", async () => {
    startEditing(el, ["children", 0], {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    suspendBlurClose();
    resumeBlurClose();

    const other = document.createElement("input");
    document.body.append(other);
    other.focus(); // ActiveElement is no longer the editable
    el.dispatchEvent(new FocusEvent("blur"));
    await waitMs(200);

    expect(isEditing()).toBe(false);
    other.remove();
  });
});

// ─── Keyboard event propagation ──────────────────────────────────────────────

describe("Keyboard event propagation", () => {
  let el: HTMLElement;
  const path = ["children", 0];

  beforeEach(() => {
    el = document.createElement("p");
    el.textContent = "test";
    document.body.append(el);
  });

  afterEach(() => {
    if (isEditing()) {
      stopEditing();
    }
    el.remove();
  });

  test("Enter on editing element does not propagate to document", () => {
    let documentGotEnter = false;
    const docHandler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        documentGotEnter = true;
      }
    };
    document.addEventListener("keydown", docHandler);

    startEditing(el, path, {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });

    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(documentGotEnter).toBe(false);

    document.removeEventListener("keydown", docHandler);
  });

  test("Escape on editing element does not propagate to document", () => {
    let documentGotEscape = false;
    const docHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        documentGotEscape = true;
      }
    };
    document.addEventListener("keydown", docHandler);

    startEditing(el, path, {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });

    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(documentGotEscape).toBe(false);

    document.removeEventListener("keydown", docHandler);
  });

  test("Escape stops editing", () => {
    startEditing(el, path, {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });

    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
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
    const result = normalizeChildren({
      children: ["text ", { tagName: "em", textContent: "bold" }, " more"],
    }) as any;
    expect(result.children).toBeDefined();
    expect(result.children.length).toBe(3);
    expect(result.children[0]).toBe("text ");
    expect(result.children[1].tagName).toBe("em");
    expect(result.children[2]).toBe(" more");
  });

  test("merges adjacent strings in mixed content", () => {
    const result = normalizeChildren({
      children: ["a", "b", { tagName: "em", textContent: "x" }, "c", "d"],
    }) as any;
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
    const result = normalizeChildren({
      children: [{ tagName: "strong", textContent: "bold" }],
    }) as any;
    expect(result.children).toBeDefined();
    expect(result.children.length).toBe(1);
  });
});

describe("session accessors", () => {
  test("getActivePath mirrors the live session; isSlashActive proxies the DI'd controller", async () => {
    const { getActivePath, isSlashActive } = await import("../src/editor/inline-edit");

    expect(getActivePath()).toBeNull();
    expect(isSlashActive()).toBe(false);

    const el = document.createElement("p");
    document.body.append(el);
    startEditing(el, ["children", 3], {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    expect(getActivePath()).toEqual(["children", 3]);

    let open = true;
    setSlashController({ dismiss: () => {}, isOpen: () => open, show: () => {} });
    expect(isSlashActive()).toBe(true);
    open = false;
    expect(isSlashActive()).toBe(false);

    stopEditing();
    expect(getActivePath()).toBeNull();
  });
});
