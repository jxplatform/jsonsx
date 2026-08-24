import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { JxMutableNode } from "@jxsuite/schema/types";
import {
  commitActiveBlock,
  getActiveElement,
  handleSlashTrigger,
  getInlineActions,
  isEditableBlock,
  isEditing,
  isInlineElement,
  isInlineInContext,
  normalizeChildren,
  openSlashMenu,
  setSlashController,
  startEditing,
  stopEditing,
} from "../src/editor/inline-edit";
import { dismissSlashMenu, isSlashMenuOpen, showSlashMenu } from "../src/editor/slash-menu";

// Inline-edit no longer hard-imports the slash menu (so it can live in the slim iframe bundle);
// Wire the real one for the tests that exercise slash commands.
setSlashController({ dismiss: dismissSlashMenu, isOpen: isSlashMenuOpen, show: showSlashMenu });

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

  test("returns true for the text-bearing HTML blocks directives produce", () => {
    // With a document-wide caret, a tag missing here reads to the author as "this text is not
    // Editable" — clicking it simply does nothing.
    for (const tag of ["figcaption", "caption", "summary", "dt", "dd"]) {
      const el = document.createElement(tag);
      expect(isEditableBlock(el)).toBe(true);
    }
  });

  test("returns false for containers and for pre", () => {
    // `pre` is excluded on purpose: its whitespace and absent inline formatting need their own
    // Treatment, not the rich-text path.
    for (const tag of ["div", "img", "section", "ul", "ol", "table", "tr", "figure", "pre"]) {
      const el = document.createElement(tag);
      expect(isEditableBlock(el)).toBe(false);
    }
  });
});

describe("committing an anchor keeps its URL", () => {
  let el: HTMLElement;
  const commits: { children: unknown }[] = [];

  function editAndCommit(innerHTML: string) {
    el = document.createElement("p");
    el.innerHTML = innerHTML;
    document.body.append(el);
    startEditing(el, ["children", 0], {
      onCommit: (_p, children) => commits.push({ children }),
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    stopEditing();
    return commits.at(-1)!.children as { tagName: string; attributes?: { href: string } }[];
  }

  afterEach(() => {
    commits.length = 0;
    el?.remove();
  });

  test("reads the URL from data-jx-href on a DE-LINKED canvas anchor", () => {
    // Design/edit renders anchors de-linked (the runtime stamps the URL as `data-jx-href` so a
    // Click selects instead of navigating). Reading only `href` serialized every edited link as
    // `[text]()` — silently destroying the URL of any paragraph that contained one.
    const children = editAndCommit(`before <a data-jx-href="/spec">full spec</a> after`);
    const anchorNode = children.find((c) => typeof c === "object" && c.tagName === "a")!;
    expect(anchorNode.attributes).toEqual({ href: "/spec" });
  });

  test("still reads a plain href when the anchor is not de-linked", () => {
    const children = editAndCommit(`go <a href="/plain">there</a>`);
    const anchorNode = children.find((c) => typeof c === "object" && c.tagName === "a")!;
    expect(anchorNode.attributes).toEqual({ href: "/plain" });
  });

  test("an anchor with no URL at all commits without inventing one", () => {
    const children = editAndCommit(`an <a>anchor</a> here`);
    const anchorNode = children.find((c) => typeof c === "object" && c.tagName === "a")!;
    expect(anchorNode.attributes).toBeUndefined();
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

  test("startEditing marks the block active without making it its own editing host", () => {
    startEditing(el, path, {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });

    expect(isEditing()).toBe(true);
    expect(getActiveElement()).toBe(el);
    // The canvas CONTAINER is the contenteditable; a page block only carries the active marker, so
    // The caret can walk out of it into the next block natively.
    expect(el.dataset.jxActiveBlock).toBe("");
    expect(el.hasAttribute("contenteditable")).toBe(false);
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
    expect(el.dataset.jxActiveBlock).toBeUndefined();
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
    expect(el.dataset.jxActiveBlock).toBeUndefined();

    el2.remove();
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

// ─── Plain (prop-bound) sessions ─────────────────────────────────────────────

describe("plain (plaintext-only) sessions", () => {
  let el: HTMLElement;
  let commits: { path: unknown; children: unknown; textContent: string | null }[];
  let splitCount = 0;
  let endCount = 0;
  let slashShown = false;
  const path = ["children", 2];

  /** Put a real collapsed caret in `node` — openSlashMenu anchors to the live range. */
  const caretAtEnd = (node: HTMLElement) => {
    const range = document.createRange();
    range.setStart(node.firstChild ?? node, node.firstChild?.textContent?.length ?? 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const start = () => {
    startEditing(
      el,
      path,
      {
        onCommit: (p, children, textContent) => commits.push({ children, path: p, textContent }),
        onEnd: () => (endCount += 1),
        onInsert: () => {},
        onSplit: () => (splitCount += 1),
      },
      { plainText: true },
    );
  };

  beforeEach(() => {
    el = document.createElement("h3");
    el.textContent = "Local";
    document.body.append(el);
    commits = [];
    splitCount = 0;
    endCount = 0;
    slashShown = false;
    setSlashController({
      dismiss: () => {},
      isOpen: () => false,
      show: () => (slashShown = true),
    });
  });

  afterEach(() => {
    if (isEditing()) {
      stopEditing();
    }
    el.remove();
    setSlashController({ dismiss: dismissSlashMenu, isOpen: isSlashMenuOpen, show: showSlashMenu });
  });

  test("starts a plaintext-only session (or the contentEditable fallback)", () => {
    start();
    expect(isEditing()).toBe(true);
    expect(["plaintext-only", "true"]).toContain(el.contentEditable);
  });

  test("Enter commits textContent (children null) without splitting and ends the session", () => {
    start();
    el.textContent = "Regional";
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    expect(splitCount).toBe(0);
    expect(commits).toEqual([{ children: null, path, textContent: "Regional" }]);
    expect(endCount).toBe(1);
    expect(isEditing()).toBe(false);
  });

  test("Escape restores the original text and writes NOTHING", () => {
    /* It used to post the restored value and rely on the host to no-op it. The host compares
       against the STORED prop, and an unset prop's stored value is `undefined` while the marker
       renders the definition's default — so the "no-op" wrote `$props.<name> = "<default>"`, and
       cancelling an edit dirtied the tab, made an undo entry, and detached the instance from its
       definition. Cancel must not be a way to modify the document. */
    start();
    el.textContent = "half-typed junk";
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));

    expect(el.textContent).toBe("Local");
    expect(commits).toEqual([]);
    expect(isEditing()).toBe(false);
  });

  test("Escape AFTER an idle commit writes the original back", () => {
    // The other half, and why a bare "don't post when unchanged" rule is not enough: the tick has
    // Already put the typed text in the document, so cancelling has to undo it rather than go quiet.
    start();
    el.textContent = "typed";
    commitActiveBlock();
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));

    expect(el.textContent).toBe("Local");
    expect(commits).toEqual([
      { children: null, path, textContent: "typed" },
      { children: null, path, textContent: "Local" },
    ]);
  });

  test("a session that changes nothing writes nothing", () => {
    // A bare click on a component's text, then a click away. This is the whole finding: it used to
    // Bake the definition's default onto the instance.
    start();
    stopEditing();
    expect(commits).toEqual([]);
  });

  test("an idle tick that changes nothing writes nothing either", () => {
    start();
    commitActiveBlock();
    expect(commits).toEqual([]);
  });

  test("commit flattens newlines to spaces (directive attributes are single-line)", () => {
    start();
    el.textContent = "line one\nline two";
    stopEditing();
    expect(commits).toEqual([{ children: null, path, textContent: "line one line two" }]);
  });

  test("the slash menu never opens in a plain session", () => {
    /* This used to dispatch the "/" keydown on the BLOCK, where nothing listens for the gesture —
       the real trigger is a listener on the editing HOST (see the note in iframe-inline-edit.ts
       about the block-vs-host mismatch), so it passed against a menu that opened perfectly well.
       Calling the trigger directly tests the layer that actually decides. */
    start();
    caretAtEnd(el);
    handleSlashTrigger(new KeyboardEvent("keydown", { bubbles: true, key: "/" }));
    expect(slashShown).toBe(false);
  });

  test("openSlashMenu is refused outright in a plain session", () => {
    /* The guard is on the OPEN, not the trigger, so a programmatic open is covered too. It matters
       because the menu's precondition (`!insertFn`) does not catch this: enterPropEditAt passes
       `onInsert: () => {}`, and a no-op function is truthy. */
    start();
    caretAtEnd(el);
    openSlashMenu();
    expect(slashShown).toBe(false);
  });

  test("the menu still opens in an ordinary rich session", () => {
    // The guard must not have turned the slash gesture off everywhere.
    const rich = document.createElement("p");
    rich.textContent = "x";
    document.body.append(rich);
    startEditing(rich, path, {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    caretAtEnd(rich);
    openSlashMenu();
    expect(slashShown).toBe(true);
    stopEditing();
    rich.remove();
  });

  test("format shortcuts are inert (prevented) in a plain session", () => {
    start();
    const ev = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "b",
    });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(el.querySelector("strong")).toBeNull();
  });

  test("plain mode does not leak into the next (rich) session", () => {
    start();
    stopEditing();
    commits = [];

    const rich = document.createElement("p");
    rich.textContent = "rich";
    document.body.append(rich);
    startEditing(rich, ["children", 5], {
      onCommit: (p, children, textContent) => commits.push({ children, path: p, textContent }),
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    // The rich block never claims its own editing host — the leak worth guarding is a stale
    // `plaintext-only` from the previous prop-bound session.
    expect(rich.hasAttribute("contenteditable")).toBe(false);
    expect(rich.dataset.jxActiveBlock).toBe("");
    stopEditing();
    expect(commits).toEqual([{ children: null, path: ["children", 5], textContent: "rich" }]);
    rich.remove();
  });
});
