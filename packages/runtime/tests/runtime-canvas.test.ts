import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { describe, test, expect, afterEach } from "bun:test";
import { reactive } from "@vue/reactivity";
import {
  applyStyle,
  renderNode as _renderNode,
  setCanvasDelinkAnchors,
  setCanvasViewportTranspose,
  toCSSText,
  transposeCanvasUnits,
} from "../src/runtime";

try {
  GlobalRegistrator.register();
} catch {
  /* Already registered */
}

const renderNode: (...args: Parameters<typeof _renderNode>) => HTMLElement = _renderNode as any;

// Both flags are GLOBAL module state. Reset BOTH after every test.
afterEach(() => {
  setCanvasViewportTranspose(false);
  setCanvasDelinkAnchors(false);
});

// ─── transposeCanvasUnits ───────────────────────────────────────────────────────

describe("transposeCanvasUnits", () => {
  test("flag off (default) returns the value unchanged", () => {
    expect(transposeCanvasUnits("100vh")).toBe("100vh");
    expect(transposeCanvasUnits("50vw")).toBe("50vw");
    expect(transposeCanvasUnits("calc(100vh - 10px)")).toBe("calc(100vh - 10px)");
  });

  test("flag on transposes every viewport unit kind", () => {
    setCanvasViewportTranspose(true);
    expect(transposeCanvasUnits("100vh")).toBe("100cqh");
    expect(transposeCanvasUnits("100vw")).toBe("100cqw");
    expect(transposeCanvasUnits("10vmin")).toBe("10cqmin");
    expect(transposeCanvasUnits("10vmax")).toBe("10cqmax");
    expect(transposeCanvasUnits("3vi")).toBe("3cqi");
    expect(transposeCanvasUnits("4vb")).toBe("4cqb");
  });

  test("flag on transposes small/large/dynamic viewport prefixes", () => {
    setCanvasViewportTranspose(true);
    expect(transposeCanvasUnits("5svh")).toBe("5cqh");
    expect(transposeCanvasUnits("5lvh")).toBe("5cqh");
    expect(transposeCanvasUnits("5dvh")).toBe("5cqh");
    expect(transposeCanvasUnits("50svw")).toBe("50cqw");
  });

  test("flag on handles decimals and negatives", () => {
    setCanvasViewportTranspose(true);
    expect(transposeCanvasUnits("-2.5dvh")).toBe("-2.5cqh");
    expect(transposeCanvasUnits("2.5vh")).toBe("2.5cqh");
    expect(transposeCanvasUnits(".5vw")).toBe(".5cqw");
    expect(transposeCanvasUnits("-10vw")).toBe("-10cqw");
  });

  test("flag on transposes multiple units within one value (calc)", () => {
    setCanvasViewportTranspose(true);
    expect(transposeCanvasUnits("calc(100vh - 10px)")).toBe("calc(100cqh - 10px)");
    expect(transposeCanvasUnits("calc(50vw + 25vh)")).toBe("calc(50cqw + 25cqh)");
  });

  test("flag on lowercases the matched dimension letter (regex i-flag)", () => {
    setCanvasViewportTranspose(true);
    // Lowercase `v` passes the guard; the i-flag matches the uppercase dim.
    expect(transposeCanvasUnits("100vH")).toBe("100cqh");
    expect(transposeCanvasUnits("50vW")).toBe("50cqw");
  });

  test("flag on: an all-uppercase 'V' is a no-op (lowercase guard)", () => {
    setCanvasViewportTranspose(true);
    // The guard fires only on lowercase "v", so all-caps is left unchanged.
    expect(transposeCanvasUnits("100VH")).toBe("100VH");
  });

  test("flag on leaves a value with no 'v' untouched (no-op fast path)", () => {
    setCanvasViewportTranspose(true);
    expect(transposeCanvasUnits("10px")).toBe("10px");
    expect(transposeCanvasUnits("red")).toBe("red");
    expect(transposeCanvasUnits("1rem")).toBe("1rem");
  });
});

// ─── setCanvasViewportTranspose toggling ─────────────────────────────────────────

describe("setCanvasViewportTranspose", () => {
  test("returns undefined", () => {
    expect(setCanvasViewportTranspose(true)).toBeUndefined();
    expect(setCanvasViewportTranspose(false)).toBeUndefined();
  });

  test("toggles the transpose behavior on and back off", () => {
    expect(transposeCanvasUnits("100vh")).toBe("100vh");
    setCanvasViewportTranspose(true);
    expect(transposeCanvasUnits("100vh")).toBe("100cqh");
    setCanvasViewportTranspose(false);
    expect(transposeCanvasUnits("100vh")).toBe("100vh");
  });
});

// ─── toCSSText transposing ───────────────────────────────────────────────────────

describe("toCSSText viewport transpose", () => {
  test("flag off leaves viewport units in serialized CSS", () => {
    expect(toCSSText({ height: "100vh", width: "50vw" })).toBe("height: 100vh; width: 50vw");
  });

  test("flag on transposes viewport units in serialized CSS", () => {
    setCanvasViewportTranspose(true);
    expect(toCSSText({ height: "100vh", width: "50vw" })).toBe("height: 100cqh; width: 50cqw");
  });

  test("flag on transposes inside calc within serialized CSS", () => {
    setCanvasViewportTranspose(true);
    expect(toCSSText({ height: "calc(100vh - 2rem)" })).toBe("height: calc(100cqh - 2rem)");
  });
});

// ─── applyStyle inline transpose ─────────────────────────────────────────────────

describe("applyStyle viewport transpose", () => {
  test("flag off keeps the raw viewport unit on the inline style", () => {
    const el = document.createElement("div");
    applyStyle(el, { height: "100vh" });
    expect(el.style.height).toContain("vh");
    expect(el.style.height).not.toContain("cqh");
  });

  test("flag on transposes a custom property value to a container-query unit", () => {
    setCanvasViewportTranspose(true);
    const el = document.createElement("div");
    // Custom properties are stored verbatim, so the transpose is observable.
    applyStyle(el, { "--banner-height": "80vh" });
    expect(el.style.getPropertyValue("--banner-height")).toBe("80cqh");
  });

  test("flag on: the transposed standard-property value no longer carries 'vh'", () => {
    setCanvasViewportTranspose(true);
    const el = document.createElement("div");
    // Happy-dom drops the cq* unit on a standard property, but "vh" is gone.
    applyStyle(el, { height: "100vh" });
    expect(el.style.height).not.toContain("vh");
  });

  test("flag off vs on diverge for the same standard-property input", () => {
    const off = document.createElement("div");
    applyStyle(off, { height: "100vh" });
    setCanvasViewportTranspose(true);
    const on = document.createElement("div");
    applyStyle(on, { height: "100vh" });
    expect(off.style.height).not.toBe(on.style.height);
  });
});

// ─── applyAttributes anchor de-link ──────────────────────────────────────────────

describe("setCanvasDelinkAnchors", () => {
  test("returns undefined", () => {
    expect(setCanvasDelinkAnchors(true)).toBeUndefined();
    expect(setCanvasDelinkAnchors(false)).toBeUndefined();
  });
});

describe("applyAttributes anchor de-link", () => {
  test("flag off: an <a href> keeps a live href", () => {
    const el = renderNode(
      { attributes: { href: "https://example.com" }, tagName: "a" } as any,
      reactive({}),
    );
    expect(el.getAttribute("href")).toBe("https://example.com");
    expect(el.dataset.jxHref).toBeUndefined();
  });

  test("flag on: an <a href> is stamped on data-jx-href, href stays null", () => {
    setCanvasDelinkAnchors(true);
    const el = renderNode(
      { attributes: { href: "https://example.com" }, tagName: "a" } as any,
      reactive({}),
    );
    expect(el.dataset.jxHref).toBe("https://example.com");
    expect(el.getAttribute("href")).toBeNull();
  });

  test("flag on: an <area href> is also de-linked", () => {
    setCanvasDelinkAnchors(true);
    const el = renderNode({ attributes: { href: "/zone" }, tagName: "area" } as any, reactive({}));
    expect(el.dataset.jxHref).toBe("/zone");
    expect(el.getAttribute("href")).toBeNull();
  });

  test("flag on: a non-anchor element keeps its href untouched", () => {
    setCanvasDelinkAnchors(true);
    // A "link" element is neither A nor AREA, so canvasAttrName leaves it alone.
    const el = renderNode(
      { attributes: { href: "/styles.css" }, tagName: "link" } as any,
      reactive({}),
    );
    expect(el.getAttribute("href")).toBe("/styles.css");
    expect(el.dataset.jxHref).toBeUndefined();
  });

  test("flag on: a non-href attribute on an anchor is untouched", () => {
    setCanvasDelinkAnchors(true);
    const el = renderNode(
      { attributes: { href: "/page", target: "_blank" } as any, tagName: "a" } as any,
      reactive({}),
    );
    // The href is de-linked, but target is a normal attribute either way.
    expect(el.getAttribute("target")).toBe("_blank");
    expect(el.dataset.jxHref).toBe("/page");
  });

  test("de-link applies to a reactive ($ref) href too", async () => {
    setCanvasDelinkAnchors(true);
    const state = reactive({ url: "/first" });
    const el = renderNode(
      { attributes: { href: { $ref: "#/state/url" } }, tagName: "a" } as any,
      state,
    );
    expect(el.dataset.jxHref).toBe("/first");
    expect(el.getAttribute("href")).toBeNull();
    state.url = "/second";
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(el.dataset.jxHref).toBe("/second");
  });
});
