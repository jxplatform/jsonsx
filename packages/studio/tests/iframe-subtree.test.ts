/**
 * In-iframe subtree renderer — renders a shadow-doc node into stamped DOM with the retained render
 * context, and disposes the effect scopes + scoped style tags of removed/replaced subtrees. Covers
 * the render path (including the layout-wrapped offset) and both disposal entry points directly.
 */
import "./with-dom.js";
import { beforeAll, describe, expect, test } from "bun:test";
import { buildScope, elementStyleTags } from "@jxsuite/runtime";
import {
  disposeAllSubtrees,
  disposeSubtree,
  renderSubtreeIframe,
} from "../src/canvas/iframe-subtree";
import type { IframeRenderCtx } from "../src/canvas/iframe-render";
import type { JxDocument, JxMutableNode } from "@jxsuite/schema/types";

let ctx: IframeRenderCtx;
beforeAll(async () => {
  ctx = {
    defs: await buildScope({} as JxDocument, {}, "http://localhost/"),
    docBase: "http://localhost/",
    mapperCtx: {
      arrayPaths: new Set(),
      canvasMode: "design",
      layoutWrapped: false,
      pageContentOffset: null,
      pageContentPrefix: null,
    },
    mode: "design",
  };
});

const docOf = (...children: unknown[]): JxMutableNode =>
  ({ children, tagName: "div" }) as unknown as JxMutableNode;

describe("renderSubtreeIframe", () => {
  test("renders a node into DOM stamped with its document path, descendants included", () => {
    const doc = docOf({ children: [{ tagName: "em", textContent: "x" }], tagName: "p" });
    const el = renderSubtreeIframe(doc, ["children", 0], ctx) as HTMLElement;
    expect(el.tagName.toLowerCase()).toBe("p");
    expect(el.dataset.jxPath).toBe('["children",0]');
    const em = el.querySelector("em") as HTMLElement;
    expect(em.dataset.jxPath).toBe('["children",0,"children",0]');
  });

  test("renders a bare string child as a text node", () => {
    const node = renderSubtreeIframe(docOf("just text"), ["children", 0], ctx);
    expect(node.textContent).toBe("just text");
  });

  test("throws when the path resolves to nothing", () => {
    expect(() => renderSubtreeIframe(docOf(), ["children", 5], ctx)).toThrow(
      /iframe-patch-node-not-found:children\/5/,
    );
  });

  test("re-applies the slot offset for a layout-wrapped render path", () => {
    const wrapped: IframeRenderCtx = {
      ...ctx,
      mapperCtx: {
        ...ctx.mapperCtx,
        layoutWrapped: true,
        pageContentOffset: 2,
        pageContentPrefix: ["children", 1],
      },
    };
    const doc = docOf({ tagName: "p", textContent: "x" });
    // The docPath children/0 renders at children/1/children/(0+2); the stamper maps it to children/0.
    const el = renderSubtreeIframe(doc, ["children", 0], wrapped) as HTMLElement;
    expect(el.dataset.jxPath).toBe('["children",0]');
  });
});

describe("disposeSubtree / disposeAllSubtrees", () => {
  test("stops the subtree's scope and removes its scoped style tag", () => {
    const el = renderSubtreeIframe(
      docOf({ tagName: "p", textContent: "x" }),
      ["children", 0],
      ctx,
    ) as HTMLElement;
    // Simulate a runtime-emitted scoped style tag for the rendered element.
    const tag = document.createElement("style");
    document.head.append(tag);
    elementStyleTags.set(el, tag);

    disposeSubtree(el);
    expect(tag.isConnected).toBe(false); // Style tag removed.
    expect(elementStyleTags.has(el)).toBe(false);
  });

  test("ignores elements it never rendered (no scope, no style tag)", () => {
    const plain = document.createElement("div");
    plain.append(document.createElement("span"));
    expect(() => disposeSubtree(plain)).not.toThrow();
  });

  test("disposeAllSubtrees stops every tracked scope", () => {
    renderSubtreeIframe(docOf({ tagName: "p" }), ["children", 0], ctx);
    renderSubtreeIframe(docOf({ tagName: "span" }), ["children", 0], ctx);
    expect(() => disposeAllSubtrees()).not.toThrow();
  });
});
