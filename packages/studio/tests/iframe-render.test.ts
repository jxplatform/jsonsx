import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { setCanvasDelinkAnchors, setCanvasViewportTranspose } from "@jxsuite/runtime";
import {
  applySiteStyle,
  injectHead,
  makeStamper,
  registerElements,
  renderResolvedDocument,
} from "../src/canvas/iframe-render";
import type { PathMapCtx } from "../src/canvas/path-mapping";

const ctx: PathMapCtx = {
  arrayPaths: new Set(),
  canvasMode: "design",
  layoutWrapped: false,
  pageContentOffset: null,
  pageContentPrefix: null,
};

describe("renderResolvedDocument", () => {
  test("renders a resolved doc into the container and stamps data-jx-path", async () => {
    const container = document.createElement("div");
    const doc = {
      children: [
        { children: ["hi"], tagName: "p" },
        { attributes: { src: "/images/x.jpg" }, tagName: "img" },
      ],
      tagName: "div",
    };
    const handle = await renderResolvedDocument({
      container,
      doc: doc as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "design",
    });

    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe("DIV");
    expect(root.dataset.jxPath).toBe("[]");

    const p = root.querySelector("p") as HTMLElement;
    expect(p.textContent).toBe("hi");
    expect(p.dataset.jxPath).toBe('["children",0]');

    const img = root.querySelector("img") as HTMLElement;
    // The asset src is left verbatim — it resolves natively against the iframe's real origin
    // (no data: URL rewriting), which is the bug this migration fixes.
    expect(img.getAttribute("src")).toBe("/images/x.jpg");
    expect(img.dataset.jxPath).toBe('["children",1]');

    handle.dispose();
  });

  test("replaces previous content on re-render", async () => {
    const container = document.createElement("div");
    await renderResolvedDocument({
      container,
      doc: { children: ["one"], tagName: "section" } as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "design",
    });
    expect(container.querySelector("section")?.textContent).toBe("one");

    await renderResolvedDocument({
      container,
      doc: { children: ["two"], tagName: "article" } as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "preview",
    });
    expect(container.querySelector("section")).toBeNull();
    expect(container.querySelector("article")?.textContent).toBe("two");
  });
});

describe("canvas transpose + anchor de-link flags", () => {
  // CRITICAL: `setCanvasViewportTranspose` / `setCanvasDelinkAnchors` are GLOBAL module-level runtime
  // Flags. Reset BOTH to false after every test so they cannot leak into other studio tests.
  afterEach(() => {
    setCanvasViewportTranspose(false);
    setCanvasDelinkAnchors(false);
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  test("applySiteStyle transposes viewport units to container units", () => {
    setCanvasViewportTranspose(true);
    applySiteStyle({ "--hero-h": "50vw", minHeight: "100vh" });
    // Plain property goes on <body>, with vh → cqh.
    expect(document.body.style.minHeight).toContain("cqh");
    expect(document.body.style.minHeight).toBe("100cqh");
    // `--`-prefixed var goes on documentElement (:root), with vw → cqw.
    expect(document.documentElement.style.getPropertyValue("--hero-h")).toBe("50cqw");
  });

  test("applySiteStyle leaves viewport units untouched when the flag is off", () => {
    // Flag defaults to false here (reset in afterEach); no transpose should happen.
    applySiteStyle({ minHeight: "100vh" });
    expect(document.body.style.minHeight).toBe("100vh");
  });

  test("renderResolvedDocument de-links <a href> in edit mode but keeps it live in preview", async () => {
    const anchorDoc = {
      children: [{ attributes: { href: "/x" }, children: ["go"], tagName: "a" }],
      tagName: "div",
    };

    const editContainer = document.createElement("div");
    const editHandle = await renderResolvedDocument({
      container: editContainer,
      doc: anchorDoc as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "edit",
    });
    const editAnchor = editContainer.querySelector("a") as HTMLElement;
    // Design/edit: the target is stamped on `data-jx-href`, leaving the anchor inert (no real href).
    expect(editAnchor.getAttribute("href")).toBeNull();
    expect(editAnchor.dataset.jxHref).toBe("/x");
    editHandle.dispose();

    const previewContainer = document.createElement("div");
    const previewHandle = await renderResolvedDocument({
      container: previewContainer,
      doc: anchorDoc as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "preview",
    });
    const previewAnchor = previewContainer.querySelector("a") as HTMLElement;
    // Preview keeps a real, live link (no de-linking).
    expect(previewAnchor.getAttribute("href")).toBe("/x");
    expect(previewAnchor.dataset.jxHref).toBeUndefined();
    previewHandle.dispose();
  });
});

describe("makeStamper", () => {
  test("ignores non-element nodes", () => {
    const stamp = makeStamper(ctx);
    const text = document.createTextNode("x");
    expect(() => stamp(text, ["children", 0], "x")).not.toThrow();
  });

  test("marks layout nodes with data-jx-layout and no path", () => {
    const stamp = makeStamper({ ...ctx, layoutWrapped: true });
    const el = document.createElement("div");
    stamp(el, ["children", 0], { $__layout: true });
    expect(el.dataset.jxLayout).toBe("");
    expect(el.dataset.jxPath).toBeUndefined();
  });

  test("stamps data-jx-path on ordinary nodes", () => {
    const stamp = makeStamper(ctx);
    const el = document.createElement("div");
    stamp(el, ["children", 2], { tagName: "div" });
    expect(el.dataset.jxPath).toBe('["children",2]');
  });
});

describe("applySiteStyle", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  test("sets custom properties on :root and plain properties on <body>", () => {
    applySiteStyle({ "--brand": "#0f0", color: "red", margin: {} as unknown });
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#0f0");
    expect(document.body.style.color).toBe("red");
    // Nested object values (selector rules) are skipped.
    expect(document.body.style.margin).toBe("");
  });

  test("is a no-op for null/non-object", () => {
    expect(() => applySiteStyle(null)).not.toThrow();
    expect(document.documentElement.getAttribute("style")).toBeNull();
  });
});

describe("injectHead", () => {
  afterEach(() => {
    document.head.innerHTML = "";
  });

  test("injects link/meta, rewrites bare specifiers, skips inline scripts, and de-dupes", () => {
    const doc = {
      $head: [
        { attributes: { href: "/x.css", rel: "stylesheet" }, tagName: "link" },
        { attributes: { content: "bar", name: "foo" }, tagName: "meta" },
        { attributes: {}, tagName: "script", textContent: "alert(1)" },
        { attributes: { href: "pkg/y.css", rel: "stylesheet" }, tagName: "link" },
      ],
    };
    injectHead(doc as never);
    expect(document.head.querySelector('link[href="/x.css"]')).not.toBeNull();
    expect(document.head.querySelector('meta[name="foo"]')).not.toBeNull();
    expect(document.head.querySelector("script")).toBeNull(); // Inline script skipped.
    // Bare specifier rewritten under /node_modules/.
    expect(document.head.querySelector('link[href="/node_modules/pkg/y.css"]')).not.toBeNull();

    // Re-injecting the same head de-dupes by href/src (no duplicate /x.css link).
    injectHead(doc as never);
    expect(document.head.querySelectorAll('link[href="/x.css"]')).toHaveLength(1);
  });

  test("is a no-op when there is no $head array", () => {
    expect(() => injectHead({} as never)).not.toThrow();
    expect(document.head.children).toHaveLength(0);
  });
});

describe("registerElements", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("registers $ref/inline components, tolerates failures, and skips non-array $elements", async () => {
    // Reject all fetches so $ref resolution fails fast (exercises the catch path without a hang).
    globalThis.fetch = (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch;
    const doc = {
      $elements: [
        "nonexistent-pkg-xyz", // String → dynamic import (fails) → caught.
        { $ref: "comp.json" }, //  $ref → defineElement(fetch fails) → caught.
        { tagName: "x-inline-comp" }, // Inline def → defineElement registers it.
      ],
    };
    await registerElements(doc as never, "http://localhost:3000/page.json");
    expect(customElements.get("x-inline-comp")).toBeDefined();

    // Missing/non-array $elements is a no-op.
    expect(await registerElements({} as never, "http://localhost:3000/")).toBeUndefined();
  });
});
