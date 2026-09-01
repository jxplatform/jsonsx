/**
 * The stylesheet engine: sheet roles, interning, teardown, and the cascade properties it rests on.
 *
 * `runtime.test.ts` asserts what one style object becomes; this file asserts the machinery around
 * that — which sheet a rule lands in, when it is shared, when it is removed, and what happens on a
 * host that cannot construct a stylesheet at all. The cascade assertions at the end are standing
 * guards rather than tests of new code: the design depends on adopted sheets cascading after the
 * document's own, and on Jx emitting no layer, and neither is something this repository controls.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { beforeEach, describe, expect, test } from "bun:test";
import { reactive } from "@vue/reactivity";

try {
  GlobalRegistrator.register();
} catch {
  /* Already registered */
}

const {
  applyStyle,
  documentStyleText,
  reapplyStyle,
  releaseElementStyles,
  resetDocumentStyles,
  runScoped,
} = await import("../src/runtime.ts");
const { elementCSS } = await import("./style-text.ts");

/** A fresh element in the document, since a rule only matters against something it can match. */
function div(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

beforeEach(() => {
  resetDocumentStyles();
  document.body.replaceChildren();
});

describe("the shared sheet interns rule sets and refcounts them", () => {
  test("a second element with the same style adds no rules", () => {
    const a = div();
    const b = div();
    applyStyle(a, { ":hover": { color: "blue" }, color: "red" });
    const after = documentStyleText();
    applyStyle(b, { ":hover": { color: "blue" }, color: "red" });
    expect({ css: documentStyleText(), same: a.dataset.jx === b.dataset.jx }).toEqual({
      css: after,
      same: true,
    });
  });

  test("a different style is a different handle and its own rules", () => {
    const a = div();
    const b = div();
    applyStyle(a, { color: "red" });
    applyStyle(b, { color: "blue" });
    expect(a.dataset.jx === b.dataset.jx).toBe(false);
    expect(documentStyleText().split("\n").length).toBe(2);
  });

  test("the rules survive until the LAST holder releases them", () => {
    const a = div();
    const b = div();
    applyStyle(a, { color: "red" });
    applyStyle(b, { color: "red" });
    releaseElementStyles(a);
    expect(documentStyleText()).toBe(`[data-jx="${b.dataset.jx}"] { color: red }`);
    releaseElementStyles(b);
    expect(documentStyleText()).toBe("");
  });

  test("releasing an element that has no rules is a no-op", () => {
    expect(() => releaseElementStyles(div())).not.toThrow();
  });

  test("a declaration-body at-rule is hoisted once, not once per element", () => {
    /* Its name is document-global — `@position-try --flip` is referenced by
       `position-try-fallbacks` from anywhere — so two elements that declare it want one copy. */
    const a = div();
    const b = div();
    const style = { "@font-face": { fontFamily: "Jx", src: "url(/a.woff2)" } };
    applyStyle(a, style);
    applyStyle(b, style);
    const rule = "@font-face { font-family: Jx; src: url(/a.woff2) }";
    expect(documentStyleText()).toBe(rule);
    releaseElementStyles(a);
    expect(documentStyleText()).toBe(rule);
    releaseElementStyles(b);
    expect(documentStyleText()).toBe("");
  });

  test("an element whose style is nothing BUT a hoisted at-rule gets no handle", () => {
    const el = div();
    applyStyle(el, { "@property --x": { inherits: "false", syntax: "'<length>'" } });
    expect(el.dataset.jx).toBeUndefined();
    expect(documentStyleText()).toContain("@property --x {");
  });
});

describe("the scratch sheet takes the live-edit path", () => {
  test("reapplyStyle rewrites in place instead of accumulating rule sets", () => {
    const el = div();
    reapplyStyle(el, { color: "red" });
    for (const color of ["blue", "green", "rebeccapurple"]) {
      reapplyStyle(el, { color });
    }
    expect(documentStyleText()).toBe(`[data-jx="${el.dataset.jx}"] { color: rebeccapurple }`);
  });

  test("two elements can be under edit at once", () => {
    const a = div();
    const b = div();
    reapplyStyle(a, { color: "red" });
    reapplyStyle(b, { color: "blue" });
    expect(documentStyleText().split("\n")).toEqual([
      `[data-jx="${a.dataset.jx}"] { color: red }`,
      `[data-jx="${b.dataset.jx}"] { color: blue }`,
    ]);
    releaseElementStyles(a);
    expect(documentStyleText()).toBe(`[data-jx="${b.dataset.jx}"] { color: blue }`);
  });

  test("an edited element is NOT interned, so an identical neighbour keeps its own rules", () => {
    const a = div();
    const b = div();
    reapplyStyle(a, { color: "red" });
    applyStyle(b, { color: "red" });
    releaseElementStyles(b);
    // The interned copy went; the scratch copy is the edited element's own and stays.
    expect(documentStyleText()).toBe(`[data-jx="${a.dataset.jx}"] { color: red }`);
  });
});

describe("teardown", () => {
  test("a disposed render scope releases the rules it made", () => {
    // A mapped array discards a generation this way, and Studio disposes a replaced subtree.
    const el = div();
    const { stop } = runScoped(() => applyStyle(el, { color: "red" }));
    expect(documentStyleText()).not.toBe("");
    stop();
    expect({ css: documentStyleText(), uid: el.dataset.jx }).toEqual({ css: "", uid: undefined });
  });

  test("an older scope disposing does not undo a newer reapplyStyle", () => {
    const el = div();
    const { stop } = runScoped(() => applyStyle(el, { color: "red" }));
    reapplyStyle(el, { color: "blue" });
    stop();
    expect(elementCSS(el)).toBe(`[data-jx="${el.dataset.jx}"] { color: blue }`);
  });

  test("a reactive element's effects stop with it", async () => {
    const state = reactive({ c: "red" });
    const el = div();
    applyStyle(el, { color: "${state.c}" }, {}, state);
    expect(el.style.cssText).toContain("red");
    releaseElementStyles(el);
    state.c = "blue";
    await Promise.resolve();
    // The inline variable went with the rule that read it, and nothing is still writing to it.
    expect(el.style.cssText).toBe("");
  });

  test("resetDocumentStyles drops the sheets and orphans the entries pointing into them", () => {
    const el = div();
    applyStyle(el, { color: "red" });
    resetDocumentStyles();
    expect(documentStyleText()).toBe("");
    /* The element `WeakMap` cannot be enumerated to be cleared, so a surviving element's release
       has to notice the state was replaced rather than hand `deleteRule` a stale index. */
    expect(() => releaseElementStyles(el)).not.toThrow();
    applyStyle(el, { color: "blue" });
    expect(documentStyleText()).toBe(`[data-jx="${el.dataset.jx}"] { color: blue }`);
  });

  test("resetDocumentStyles on a document that never had rules is a no-op", () => {
    resetDocumentStyles();
    expect(() => resetDocumentStyles()).not.toThrow();
  });

  test("a scratch owner is dropped by the reset too", () => {
    const el = div();
    reapplyStyle(el, { color: "red" });
    resetDocumentStyles();
    expect({ css: documentStyleText(), uid: el.dataset.jx }).toEqual({ css: "", uid: undefined });
  });
});

describe("a $ref style value", () => {
  test("is resolved as a value, not read as a nested selector", async () => {
    /* It used to be neither: an object-valued key that did not start with `@` was a nested block,
       so `{ color: { $ref } }` emitted `[data-jx="…"] color { $ref: #/state/tint }` — a rule for
       an element named `color`, carrying a declaration named `$ref`. */
    const state = reactive({ tint: "red" });
    const el = div();
    applyStyle(el, { color: { $ref: "#/state/tint" } } as never, {}, state);
    expect(elementCSS(el)).toBe(`[data-jx="${el.dataset.jx}"] { color: var(--jx-r0-0) }`);
    expect(getComputedStyle(el).color).toBe("red");
    state.tint = "blue";
    await Promise.resolve();
    expect(el.style.getPropertyValue("--jx-r0-0")).toBe("blue");
  });

  test("works inside a nested block, where a template used to reach the sheet literally", () => {
    const state = reactive({ tint: "red" });
    const el = div();
    applyStyle(el, { ":hover": { color: { $ref: "#/state/tint" } } } as never, {}, state);
    expect(elementCSS(el)).toBe(`[data-jx="${el.dataset.jx}"]:hover { color: var(--jx-r0-0) }`);
    expect(el.style.getPropertyValue("--jx-r0-0")).toBe("red");
  });
});

describe("rules the host cannot parse", () => {
  test("one unparseable rule does not take the rest of the set with it", () => {
    /* `insertRule` THROWS where a `<style>` element silently drops the offending rule and keeps
       going. The test DOM refuses `@position-try` outright, which makes it a convenient probe for
       a class of rule any given browser may not know yet. */
    const el = div();
    applyStyle(el, { "@position-try --flip": { insetBlockStart: "auto" }, color: "red" });
    expect(elementCSS(el)).toBe(`[data-jx="${el.dataset.jx}"] { color: red }`);
    expect(getComputedStyle(el).color).toBe("red");
  });
});

describe("the <style> fallback", () => {
  /**
   * A document that refuses to construct a stylesheet, which is what a host without constructable
   * stylesheets looks like from here. The engine has to reach a `<style>` element instead of
   * failing to style anything at all.
   */
  function noConstructable(): Document {
    const doc = document.implementation.createHTMLDocument("no-constructable");
    Object.defineProperty(doc, "defaultView", {
      configurable: true,
      value: { CSSStyleSheet: undefined },
    });
    return doc;
  }

  /** And one step further down: a `<style>` element that exposes no `sheet` to insert into. */
  function noCssom(): Document {
    const doc = noConstructable();
    const create = doc.createElement.bind(doc);
    Object.defineProperty(doc, "createElement", {
      configurable: true,
      value: (tagName: string) => {
        const el = create(tagName);
        if (tagName === "style") {
          Object.defineProperty(el, "sheet", { configurable: true, value: null });
        }
        return el;
      },
    });
    return doc;
  }

  test("a <style> element carries the rules when no sheet can be constructed", () => {
    const doc = noConstructable();
    const el = doc.createElement("div");
    doc.body.append(el);
    applyStyle(el, { ":hover": { color: "blue" }, color: "red" });
    expect(doc.head.querySelectorAll("style[data-jx-sheet]").length).toBe(1);
    expect(documentStyleText(doc).split("\n")).toEqual([
      `[data-jx="${el.dataset.jx}"] { color: red }`,
      `[data-jx="${el.dataset.jx}"]:hover { color: blue }`,
    ]);
  });

  test("with no CSSOM at all, the rules are written as the tag's text", () => {
    const doc = noCssom();
    const a = doc.createElement("div");
    const b = doc.createElement("div");
    doc.body.append(a, b);
    applyStyle(a, { color: "red" });
    applyStyle(b, { color: "blue" });
    const tag = doc.head.querySelector("style[data-jx-sheet]");
    expect(tag?.textContent).toBe(
      [
        `[data-jx="${a.dataset.jx}"] { color: red }`,
        `[data-jx="${b.dataset.jx}"] { color: blue }`,
      ].join("\n"),
    );
    releaseElementStyles(a);
    expect(tag?.textContent).toBe(`[data-jx="${b.dataset.jx}"] { color: blue }`);
    reapplyStyle(b, { color: "green" });
    expect(documentStyleText(doc)).toBe(`[data-jx="${b.dataset.jx}"] { color: green }`);
  });

  test("the fallback releases and rewrites like the real thing", () => {
    const doc = noConstructable();
    const a = doc.createElement("div");
    const b = doc.createElement("div");
    doc.body.append(a, b);
    applyStyle(a, { color: "red" });
    applyStyle(b, { color: "blue" });
    releaseElementStyles(a);
    expect(documentStyleText(doc)).toBe(`[data-jx="${b.dataset.jx}"] { color: blue }`);
    reapplyStyle(b, { color: "green" });
    expect(documentStyleText(doc)).toBe(`[data-jx="${b.dataset.jx}"] { color: green }`);
    resetDocumentStyles(doc);
    expect(doc.head.querySelector("style[data-jx-sheet]")).toBeNull();
  });

  test("each document gets its own sheets — a constructed one cannot be adopted twice", () => {
    const other = noConstructable();
    const here = div();
    const there = other.createElement("div");
    other.body.append(there);
    applyStyle(here, { color: "red" });
    applyStyle(there, { color: "blue" });
    expect(documentStyleText()).toBe(`[data-jx="${here.dataset.jx}"] { color: red }`);
    expect(documentStyleText(other)).toBe(`[data-jx="${there.dataset.jx}"] { color: blue }`);
  });
});

describe("the cascade premises the design rests on", () => {
  test("an adopted rule beats an equal-specificity rule in a document <style>", () => {
    /* Adopted sheets cascade AFTER the document's own, so this holds without any specificity
       trickery. It is what lets an element's own styles win against a page-level sheet that
       happens to name the same handle, and it is not something this repository controls. */
    const tag = document.createElement("style");
    tag.textContent = ".probe { color: rgb(1, 1, 1) }";
    document.head.append(tag);
    const el = document.createElement("div");
    applyStyle(el, { color: "rgb(2, 2, 2)" });
    const clone = document.createElement("div");
    clone.dataset.jx = el.dataset.jx as string;
    clone.classList.add("probe");
    document.body.append(clone);
    expect(getComputedStyle(clone).color).toBe("rgb(2, 2, 2)");
    tag.remove();
  });

  test("an unlayered rule beats a layered one, which is what the canvas UA emulation needs", () => {
    /* The canvas re-supplies a de-popovered element's lost UA rule inside `@layer jx-canvas-ua`,
       relying on the author's own declaration outranking it. That used to work because the base
       declaration was INLINE. It still works because an unlayered author rule beats a layered one
       at any specificity — the same direction, one origin down. */
    expect(documentStyleText()).not.toContain("@layer");
    const el = div();
    applyStyle(el, { "@(min-width: 1px)": { display: "grid" }, display: "flex" });
    expect(documentStyleText()).not.toContain("@layer");
  });
});
