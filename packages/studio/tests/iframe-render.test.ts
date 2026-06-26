import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { makeStamper, renderResolvedDocument } from "../src/canvas/iframe-render";
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
