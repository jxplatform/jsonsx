import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import {
  activeBlockAt,
  blockTextLength,
  domPositionAt,
  elementForPath,
  isAtBlockEnd,
  isAtBlockStart,
  offsetOf,
  samePath,
  toDocPos,
  toDomPosition,
} from "../src/canvas/iframe-position";
import type { EditablePredicate } from "../src/canvas/iframe-position";

// These are pure DOM traversals with no layout reads, so happy-dom exercises them faithfully — in
// Contrast to caret-from-point and line geometry, which are Chromium-only and verified via CDP.

/** The editable set used by most tests: the text blocks a caret may live in. */
const EDITABLE: EditablePredicate = (el) =>
  ["h1", "h2", "li", "p", "td"].includes(el.tagName.toLowerCase());

/** Build a container holding `html`, appended to the body so `contains`/`querySelector` behave. */
function mount(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("activeBlockAt", () => {
  test("finds the block from a text node inside nested inline markup", () => {
    const c = mount(`<p data-jx-path='["children",0]'>a<strong>bc</strong>d</p>`);
    const bold = c.querySelector("strong") as HTMLElement;
    const found = activeBlockAt(bold.firstChild, EDITABLE);
    expect(found?.path).toEqual(["children", 0]);
    expect(found?.el.tagName).toBe("P");
  });

  test("returns the element itself when it is already the block", () => {
    const c = mount(`<p data-jx-path='["children",0]'>hi</p>`);
    expect(activeBlockAt(c.querySelector("p"), EDITABLE)?.path).toEqual(["children", 0]);
  });

  test("skips stamped ancestors that are not editable blocks", () => {
    // The <div> carries a path but is not a text block; the walk must continue past it and, finding
    // No editable block, report none.
    const c = mount(`<div data-jx-path='["children",0]'><span>x</span></div>`);
    expect(activeBlockAt(c.querySelector("span"), EDITABLE)).toBeNull();
  });

  test("finds the NEAREST editable block when blocks nest (a loose list item's paragraph)", () => {
    // A loose markdown list renders <li><p>…</p></li>; both are editable, and the caret belongs to
    // The inner one.
    const c = mount(
      `<li data-jx-path='["children",0]'><p data-jx-path='["children",0,"children",0]'>x</p></li>`,
    );
    const para = c.querySelector("p") as HTMLElement;
    expect(activeBlockAt(para.firstChild, EDITABLE)?.path).toEqual(["children", 0, "children", 0]);
  });

  test("returns null for null and for detached chrome", () => {
    expect(activeBlockAt(null, EDITABLE)).toBeNull();
    expect(activeBlockAt(document.createElement("aside"), EDITABLE)).toBeNull();
  });

  test("STOPS at a component island instead of activating the page block around it", () => {
    // The load-bearing guard: without it a caret inside a component instance would walk out to the
    // Enclosing <li> and typing would replace the whole instance with the typed text.
    const c = mount(
      `<li data-jx-path='["children",0]'><x-card contenteditable="false"><h3>Inside</h3></x-card></li>`,
    );
    const h3 = c.querySelector("h3") as HTMLElement;
    expect(activeBlockAt(h3.firstChild, EDITABLE)).toBeNull();
  });

  test("stops at an unstamped custom element too (belt and braces)", () => {
    const c = mount(`<li data-jx-path='["children",0]'><x-card><h3>Inside</h3></x-card></li>`);
    const h3 = c.querySelector("h3") as HTMLElement;
    expect(activeBlockAt(h3.firstChild, EDITABLE)).toBeNull();
  });

  test("a component opened as its own document is NOT a barrier — its subtree is the document", () => {
    const c = mount(
      `<x-card data-jx-definition-root=""><p data-jx-path='["children",0]'>Body</p></x-card>`,
    );
    const para = c.querySelector("p") as HTMLElement;
    expect(activeBlockAt(para.firstChild, EDITABLE)?.path).toEqual(["children", 0]);
  });
});

describe("elementForPath", () => {
  test("round-trips a stamped path", () => {
    const c = mount(`<p data-jx-path='["children",2]'>x</p>`);
    expect(elementForPath(c, ["children", 2])?.textContent).toBe("x");
  });

  test("returns null for a path that is not rendered", () => {
    const c = mount(`<p data-jx-path='["children",0]'>x</p>`);
    expect(elementForPath(c, ["children", 99])).toBeNull();
  });

  test("distinguishes string-vs-number segments (map vs children)", () => {
    const c = mount(
      `<p data-jx-path='["children",0,"map",0]'>mapped</p><p data-jx-path='["children",0,"children",0]'>plain</p>`,
    );
    expect(elementForPath(c, ["children", 0, "map", 0])?.textContent).toBe("mapped");
    expect(elementForPath(c, ["children", 0, "children", 0])?.textContent).toBe("plain");
  });
});

describe("offsetOf / domPositionAt round-trip", () => {
  test("offset is measured in rendered characters, ignoring inline nesting", () => {
    const c = mount(`<p data-jx-path='["children",0]'>a<strong>bc</strong>d</p>`);
    const p = c.querySelector("p") as HTMLElement;
    expect(blockTextLength(p)).toBe(4);

    const bold = p.querySelector("strong") as HTMLElement;
    // Between "b" and "c" inside the bold run = character offset 2.
    expect(offsetOf(p, bold.firstChild as Text, 1)).toBe(2);
    // End of the trailing text node = 4.
    expect(offsetOf(p, p.lastChild as Text, 1)).toBe(4);
  });

  test("every offset round-trips back to an equivalent DOM position", () => {
    const c = mount(`<p data-jx-path='["children",0]'>a<strong>bc</strong>d</p>`);
    const p = c.querySelector("p") as HTMLElement;
    for (let i = 0; i <= 4; i++) {
      const dom = domPositionAt(p, i);
      expect(offsetOf(p, dom.node, dom.offset)).toBe(i);
    }
  });

  test("element-anchored positions resolve by the same rule as text-anchored ones", () => {
    const c = mount(`<p data-jx-path='["children",0]'>ab<br>cd</p>`);
    const p = c.querySelector("p") as HTMLElement;
    // Caret "at child index 2" — immediately after the <br>, which contributes no characters.
    expect(offsetOf(p, p, 2)).toBe(2);
  });

  test("offsets clamp into range instead of throwing", () => {
    const c = mount(`<p data-jx-path='["children",0]'>abc</p>`);
    const p = c.querySelector("p") as HTMLElement;
    expect(domPositionAt(p, 99)).toEqual({ node: p.firstChild as Text, offset: 3 });
    expect(domPositionAt(p, -5)).toEqual({ node: p.firstChild as Text, offset: 0 });
  });

  test("an empty block resolves to the element itself", () => {
    const c = mount(`<p data-jx-path='["children",0]'></p>`);
    const p = c.querySelector("p") as HTMLElement;
    expect(blockTextLength(p)).toBe(0);
    expect(domPositionAt(p, 0)).toEqual({ node: p, offset: 0 });
  });

  test("offsetOf returns null for a node outside the block", () => {
    const c = mount(`<p data-jx-path='["children",0]'>a</p><p data-jx-path='["children",1]'>b</p>`);
    const [first, second] = [...c.querySelectorAll("p")] as HTMLElement[];
    expect(offsetOf(first!, second!.firstChild as Text, 0)).toBeNull();
  });

  test("offsetOf returns null for an offset past the node's length", () => {
    const c = mount(`<p data-jx-path='["children",0]'>ab</p>`);
    const p = c.querySelector("p") as HTMLElement;
    expect(offsetOf(p, p.firstChild as Text, 99)).toBeNull();
  });
});

describe("toDocPos / toDomPosition", () => {
  test("a DOM caret converts to document coordinates and back", () => {
    const c = mount(`<p data-jx-path='["children",1]'>hello <em>world</em></p>`);
    const em = c.querySelector("em") as HTMLElement;

    const pos = toDocPos(em.firstChild, 2, EDITABLE);
    expect(pos).toEqual({ offset: 8, path: ["children", 1] });

    const back = toDomPosition(c, pos!);
    expect(back!.node.textContent).toBe("world");
    expect(back!.offset).toBe(2);
  });

  test("a position in a non-editable island does not resolve", () => {
    const c = mount(`<div data-jx-path='["children",0]'><span>inside</span></div>`);
    expect(toDocPos(c.querySelector("span")!.firstChild, 1, EDITABLE)).toBeNull();
  });

  test("toDocPos returns null for a null node", () => {
    expect(toDocPos(null, 0, EDITABLE)).toBeNull();
  });

  test("toDomPosition returns null when the path no longer renders", () => {
    const c = mount(`<p data-jx-path='["children",0]'>x</p>`);
    expect(toDomPosition(c, { offset: 0, path: ["children", 7] })).toBeNull();
  });

  test("a stale offset CLAMPS rather than dropping the caret", () => {
    // A remote edit shortened the block while the caret sat past the new end — the caret must land
    // At the new end, not be discarded (that would kick the user out of the block mid-collab).
    const c = mount(`<p data-jx-path='["children",0]'>hi</p>`);
    const back = toDomPosition(c, { offset: 40, path: ["children", 0] });
    expect(back).toEqual({ node: (c.querySelector("p") as HTMLElement).firstChild!, offset: 2 });
  });
});

describe("boundary predicates", () => {
  test("isAtBlockStart is true only at offset 0", () => {
    expect(isAtBlockStart({ offset: 0, path: [] })).toBe(true);
    expect(isAtBlockStart({ offset: 1, path: [] })).toBe(false);
  });

  test("isAtBlockEnd compares against the block's live text length", () => {
    const c = mount(`<p data-jx-path='["children",0]'>abc</p>`);
    const p = c.querySelector("p") as HTMLElement;
    expect(isAtBlockEnd(p, { offset: 3, path: ["children", 0] })).toBe(true);
    expect(isAtBlockEnd(p, { offset: 2, path: ["children", 0] })).toBe(false);
  });

  test("an empty block is simultaneously at its start and its end", () => {
    const c = mount(`<p data-jx-path='["children",0]'></p>`);
    const p = c.querySelector("p") as HTMLElement;
    const pos = { offset: 0, path: ["children", 0] };
    expect(isAtBlockStart(pos)).toBe(true);
    expect(isAtBlockEnd(p, pos)).toBe(true);
  });

  test("samePath compares paths structurally, not by reference", () => {
    expect(
      samePath({ offset: 0, path: ["children", 1] }, { offset: 9, path: ["children", 1] }),
    ).toBe(true);
    expect(
      samePath({ offset: 0, path: ["children", 1] }, { offset: 0, path: ["children", 2] }),
    ).toBe(false);
    // "map" and "children" segments must never collide.
    expect(
      samePath(
        { offset: 0, path: ["children", 0, "map", 0] },
        { offset: 0, path: ["children", 0, "children", 0] },
      ),
    ).toBe(false);
  });
});
