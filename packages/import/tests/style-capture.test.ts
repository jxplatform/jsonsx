/**
 * Style-capture tests — the in-browser callbacks normally run inside puppeteer's page.evaluate().
 * Here a fake Page executes them in-process against happy-dom globals, so the real DOM walk,
 * UA-default probing, media-query discovery, and custom-property extraction all run for real.
 */

import { describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Page } from "puppeteer-core";

GlobalRegistrator.register({ url: "https://example.com/" });

// Browsers give CSSStyleDeclaration a Symbol.iterator but happy-dom does not, and the
// `for (const name of rule.style)` loop in collectCustomProps needs it — patch it in.
const styleDeclarationProto = Object.getPrototypeOf(
  document.createElement("div").style,
) as CSSStyleDeclaration;
if (!(Symbol.iterator in styleDeclarationProto)) {
  Object.defineProperty(styleDeclarationProto, Symbol.iterator, {
    *value(this: CSSStyleDeclaration) {
      for (let i = 0; i < this.length; i += 1) {
        yield this[i];
      }
    },
    configurable: true,
    writable: true,
  });
}

const { captureStyles, captureStylesAtWidth, STYLE_ALLOWLIST } =
  await import("../src/style-capture.ts");

function makeFakePage(): { page: Page; viewports: { width: number; height: number }[] } {
  const viewports: { width: number; height: number }[] = [];
  const page = {
    evaluate: (fn: (...fnArgs: unknown[]) => unknown, ...args: unknown[]) =>
      Promise.resolve(fn(...args)),
    setViewport(vp: { width: number; height: number }) {
      viewports.push(vp);
      return Promise.resolve();
    },
  } as unknown as Page;
  return { page, viewports };
}

function setDom(headHtml: string, bodyHtml: string): void {
  document.head.innerHTML = headHtml;
  document.body.innerHTML = bodyHtml;
}

const STYLED_HEAD = `<style>
  html { background-color: rgb(9, 9, 18); }
  body { color: rgb(20, 20, 20); }
  :root { --brand: #ff0000; --spacing: 12px; --derived: var(--brand); }
  .hero { display: flex; padding-top: 10px; }
  @media (max-width: 600px) { .hero { display: block; } }
  @media (max-width: 600px) { .other { color: blue; } }
  @supports (display: grid) { @media (min-width: 900px) { .wide { color: red; } } }
</style>`;

const STYLED_BODY = `<div class="hero"><span>hi</span><b>bold</b></div><p>text</p>`;

describe("captureStyles", () => {
  it("walks the DOM depth-first with stable child-index paths", async () => {
    setDom(STYLED_HEAD, STYLED_BODY);
    const { page } = makeFakePage();
    const result = await captureStyles(page);

    expect(result.elements.map((e) => e.path)).toEqual([[0], [0, 0], [0, 1], [1]]);
    expect(result.elements.map((e) => e.tagName)).toEqual(["div", "span", "b", "p"]);

    const hero = result.elements[0]!;
    expect(hero.styles["display"]).toBe("flex");
    expect(hero.styles["padding-top"]).toBe("10px");
    // Inherited color from body
    expect(hero.styles["color"]).toBe("rgb(20, 20, 20)");
  });

  it("collects UA-default baselines for every tag seen", async () => {
    setDom(STYLED_HEAD, STYLED_BODY);
    const { page } = makeFakePage();
    const result = await captureStyles(page);

    expect(Object.keys(result.uaDefaults).toSorted()).toEqual(["b", "div", "p", "span"]);
    // A plain probe <div> is display:block by UA default, unlike the flex .hero
    expect(result.uaDefaults["div"]!["display"]).toBe("block");
  });

  it("discovers media queries, recursing into @supports and deduplicating", async () => {
    setDom(STYLED_HEAD, STYLED_BODY);
    const { page } = makeFakePage();
    const result = await captureStyles(page);

    expect(result.mediaQueries).toEqual(["(max-width: 600px)", "(min-width: 900px)"]);
  });

  it("extracts custom properties, skipping var() references", async () => {
    setDom(STYLED_HEAD, STYLED_BODY);
    const { page } = makeFakePage();
    const result = await captureStyles(page);

    expect(result.customProperties["--brand"]).toBe("#ff0000");
    expect(result.customProperties["--spacing"]).toBe("12px");
    expect(result.customProperties["--derived"]).toBeUndefined();
  });

  it("captures document styles from body, falling back to html", async () => {
    setDom(STYLED_HEAD, STYLED_BODY);
    const { page } = makeFakePage();
    const result = await captureStyles(page);

    // The color set on body wins; background-color is only set on html
    expect(result.documentStyles["color"]).toBe("rgb(20, 20, 20)");
    expect(result.documentStyles["background-color"]).toBe("rgb(9, 9, 18)");
  });

  it("returns empty results for an empty unstyled page", async () => {
    setDom("", "");
    const { page } = makeFakePage();
    const result = await captureStyles(page);

    expect(result.elements).toEqual([]);
    expect(result.uaDefaults).toEqual({});
    expect(result.mediaQueries).toEqual([]);
    expect(result.customProperties).toEqual({});
  });

  it("skips stylesheets whose cssRules are inaccessible (cross-origin)", async () => {
    setDom(STYLED_HEAD, STYLED_BODY);
    const realSheets = [...document.styleSheets];
    const crossOriginSheet = {
      href: "https://cdn.example.com/styles.css",
      get cssRules(): CSSRuleList {
        throw new Error("SecurityError: cross-origin");
      },
    };
    Object.defineProperty(document, "styleSheets", {
      get: () => [...realSheets, crossOriginSheet],
      configurable: true,
    });

    try {
      const { page } = makeFakePage();
      const result = await captureStyles(page);
      // Accessible sheet still contributes; inaccessible one is skipped silently
      expect(result.mediaQueries).toContain("(max-width: 600px)");
      expect(result.customProperties["--brand"]).toBe("#ff0000");
    } finally {
      Reflect.deleteProperty(document, "styleSheets");
    }
  });
});

describe("captureStylesAtWidth", () => {
  it("sets the viewport, waits for reflow, and re-walks element styles", async () => {
    setDom(STYLED_HEAD, STYLED_BODY);
    const { page, viewports } = makeFakePage();
    const elements = await captureStylesAtWidth(page, 375);

    expect(viewports).toEqual([{ width: 375, height: 900 }]);
    expect(elements.map((e) => e.path)).toEqual([[0], [0, 0], [0, 1], [1]]);
    expect(elements[0]!.tagName).toBe("div");
    expect(elements[0]!.styles["display"]).toBe("flex");
  });

  it("returns no elements for an empty body", async () => {
    setDom("", "");
    const { page } = makeFakePage();
    const elements = await captureStylesAtWidth(page, 768);
    expect(elements).toEqual([]);
  });
});

describe("STYLE_ALLOWLIST", () => {
  it("includes the core layout and typography properties", () => {
    expect(STYLE_ALLOWLIST).toContain("display");
    expect(STYLE_ALLOWLIST).toContain("font-family");
    expect(STYLE_ALLOWLIST).toContain("background-color");
  });
});

describe("stripped tags and the path contract with to-jx", () => {
  /*
   * `apply-styles.ts` resolves a captured path against the tree `to-jx.ts` produced, so the walk
   * and the strip set must agree. They did not: `capture.ts` removes only script/noscript from the
   * live DOM while `to-jx.ts` also drops iframe/object/embed/link/meta/style, and every element
   * after such a sibling shifted by one. On a real WordPress import that left 64% of the page's
   * elements with no style at all.
   */
  const MIXED_BODY = `<style>.a{color:red}</style><div id="first"></div><iframe></iframe><div id="second"><span></span><link rel="x"><b></b></div>`;

  it("skips stripped tags without consuming a child index", async () => {
    setDom("", MIXED_BODY);
    const { page } = makeFakePage();
    const result = await captureStyles(page);

    expect(result.elements.map((e) => e.tagName)).toEqual(["div", "div", "span", "b"]);
    // <b> is [1,1] because the <link> before it is stripped from the tree too.
    expect(result.elements.map((e) => e.path)).toEqual([[0], [1], [1, 0], [1, 1]]);
  });

  it("agrees with convertToJx's own tree indices", async () => {
    setDom("", MIXED_BODY);
    const { page } = makeFakePage();
    const result = await captureStyles(page);
    const { convertToJx } = await import("../src/to-jx.ts");
    const { document: tree } = convertToJx(MIXED_BODY);

    /* Element-only indexing, exactly as `apply-styles.ts` walks it: a text child never consumes
       an index on either side. */
    function at(path: number[]): string {
      let node = tree;
      for (const index of path) {
        const kids = (node.children as unknown[]).filter((c) => typeof c !== "string");
        node = kids[index] as typeof tree;
      }
      return String(node.tagName);
    }
    for (const element of result.elements) {
      expect(at(element.path)).toBe(element.tagName);
    }
  });

  it("applies the same skip at every breakpoint re-capture", async () => {
    setDom("", MIXED_BODY);
    const { page } = makeFakePage();
    const elements = await captureStylesAtWidth(page, 600);

    expect(elements.map((e) => e.tagName)).toEqual(["div", "div", "span", "b"]);
    expect(elements.map((e) => e.path)).toEqual([[0], [1], [1, 0], [1, 1]]);
  });
});

describe("UA-default probe sandbox", () => {
  /*
   * The sandbox used to carry `visibility:hidden;pointer-events:none`. Both are INHERITED and both
   * are on the allowlist, so every probe inherited them and they became each tag's "UA default":
   * a real `visibility:hidden` was then dropped as a no-op, and the mirror values were emitted on
   * ~5,300 nodes each, making them the two most common declarations in the imported project.
   */
  it("does not inherit an allowlisted property into the probes", async () => {
    setDom(STYLED_HEAD, STYLED_BODY);
    const { page } = makeFakePage();
    const result = await captureStyles(page);

    for (const tag of Object.keys(result.uaDefaults)) {
      expect(result.uaDefaults[tag]!["visibility"]).not.toBe("hidden");
      expect(result.uaDefaults[tag]!["pointer-events"]).not.toBe("none");
    }
  });

  it("keeps a real hidden element distinguishable from the baseline", async () => {
    setDom(
      `<style>.gone { visibility: hidden; pointer-events: none; }</style>`,
      `<div class="gone"></div>`,
    );
    const { page } = makeFakePage();
    const result = await captureStyles(page);

    const node = result.elements[0]!;
    expect(node.styles["visibility"]).toBe("hidden");
    expect(result.uaDefaults["div"]!["visibility"]).not.toBe(node.styles["visibility"]);
  });
});
