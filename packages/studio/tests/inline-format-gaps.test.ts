import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import {
  isTagActiveInSelection,
  normalizeInlineContent,
  toggleInlineFormat,
} from "../src/editor/inline-format";

function mount(html: string) {
  const root = document.createElement("div");
  root.contentEditable = "true";
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function selectContents(root: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(root);
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isTagActiveInSelection — selection outside the editable root", () => {
  test("returns false when the anchor is not contained by the root", () => {
    const root = mount("text");
    const outside = document.createElement("div");
    outside.textContent = "outside";
    document.body.append(outside);

    const range = document.createRange();
    range.selectNodeContents(outside);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(isTagActiveInSelection("strong", root)).toBe(false);
  });
});

describe("toggleInlineFormat — no active range", () => {
  test("does nothing when the selection has no ranges", () => {
    const root = mount("hello");
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    toggleInlineFormat("strong", root);
    expect(root.querySelectorAll("strong").length).toBe(0);
  });
});

describe("wrapRangeInTag — whitespace handling", () => {
  test("trims and re-emits leading/trailing whitespace around the wrapper", () => {
    const root = mount("  world  ");
    selectContents(root);
    toggleInlineFormat("strong", root);
    const strong = root.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("world");
    // Surrounding whitespace stays outside the wrapper.
    expect(root.textContent).toBe("  world  ");
  });

  test("removes pure-whitespace edge text nodes and keeps inner element", () => {
    const root = mount(" <em>mid</em> ");
    selectContents(root);
    toggleInlineFormat("strong", root);
    const strong = root.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.querySelector("em")).not.toBeNull();
  });

  test("all-whitespace selection re-inserts the whitespace and bails", () => {
    const root = mount("   ");
    selectContents(root);
    toggleInlineFormat("strong", root);
    expect(root.querySelectorAll("strong").length).toBe(0);
    expect(root.textContent).toBe("   ");
  });

  test("element-bounded selection skips text-node whitespace trimming", () => {
    const root = mount("<em>x</em>more");
    selectContents(root);
    toggleInlineFormat("strong", root);
    const strong = root.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.querySelector("em")).not.toBeNull();
    expect(strong!.textContent).toBe("xmore");
  });
});

describe("findIntersectingElements — skips non-matching tags", () => {
  test("unwraps only the matching tag among mixed siblings", () => {
    const root = mount("<strong>bold</strong><em>ital</em>");
    const strong = root.querySelector("strong") as HTMLElement;
    const em = root.querySelector("em") as HTMLElement;
    const range = document.createRange();
    range.setStart(strong.firstChild as Node, 0);
    range.setEnd(em.firstChild as Node, 4);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);

    toggleInlineFormat("strong", root);
    expect(root.querySelectorAll("strong").length).toBe(0);
    // The non-matching <em> is left intact.
    expect(root.querySelector("em")).not.toBeNull();
  });
});

describe("normalizeInlineContent — lift edge whitespace", () => {
  test("lifts leading and trailing whitespace out of a format element", () => {
    const root = mount("<strong>  lead <em>x</em> trail  </strong>");
    normalizeInlineContent(root);
    const strong = root.querySelector("strong") as HTMLElement;
    expect(strong).not.toBeNull();
    // Inner edges no longer carry whitespace (it was lifted outside the element).
    expect(strong.firstChild?.textContent?.startsWith(" ")).toBe(false);
    expect(strong.lastChild?.textContent?.endsWith(" ")).toBe(false);
    // Text content is preserved overall.
    expect(root.textContent).toContain("lead");
    expect(root.textContent).toContain("trail");
  });
});
