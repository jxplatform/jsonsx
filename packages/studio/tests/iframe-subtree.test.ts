/**
 * In-iframe subtree renderer — renders a shadow-doc node into stamped DOM with the retained render
 * context, and disposes the effect scopes + scoped style tags of removed/replaced subtrees. Covers
 * the render path (including the layout-wrapped offset) and both disposal entry points directly.
 */
import "./with-dom.js";
import { beforeAll, describe, expect, test } from "bun:test";
import { applyStyle, buildScope } from "@jxsuite/runtime";
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
  test("stops the subtree's scope and hands its rule set back", () => {
    const el = renderSubtreeIframe(
      docOf({ tagName: "p", textContent: "x" }),
      ["children", 0],
      ctx,
    ) as HTMLElement;
    /* The runtime's own teardown API, not a `<style>` tag this test invents. Rule sets are shared
       between elements that style alike, so only a refcounted release is safe. */
    applyStyle(el, { color: "rebeccapurple" });
    expect(el.dataset.jx).toBeTruthy();

    disposeSubtree(el);
    expect(el.dataset.jx).toBeUndefined();
  });

  test("ignores elements it never rendered (no scope, no rules)", () => {
    const plain = document.createElement("div");
    plain.append(document.createElement("span"));
    expect(() => disposeSubtree(plain)).not.toThrow();
  });

  test("disposeAllSubtrees stops every tracked scope", () => {
    renderSubtreeIframe(docOf({ tagName: "p" }), ["children", 0], ctx);
    renderSubtreeIframe(docOf({ tagName: "span" }), ["children", 0], ctx);
    expect(() => disposeAllSubtrees()).not.toThrow();
  });

  test("disposal actually stops a live binding effect (runtime-instance scope ownership)", async () => {
    // The subtree's effects are created by the runtime's copy of @vue/reactivity; a studio-instance
    // EffectScope would collect nothing and disposal would silently leak them (they'd keep firing
    // Against detached DOM and pin it in memory). A bare string node skips prepareForEditMode, so a
    // Template child keeps its live binding even under the design-mode ctx.
    const liveCtx: IframeRenderCtx = {
      ...ctx,
      defs: await buildScope(
        { state: { msg: "one" } } as unknown as JxDocument,
        {},
        "http://localhost/",
      ),
    };
    const node = renderSubtreeIframe(docOf("${state.msg}"), ["children", 0], liveCtx);
    expect(node.textContent).toBe("one");

    // Live before disposal: the effect tracks the reactive defs.
    (liveCtx.defs as Record<string, unknown>).msg = "two";
    expect(node.textContent).toBe("two");

    // Dead after: further changes leave the detached text node untouched.
    disposeAllSubtrees();
    (liveCtx.defs as Record<string, unknown>).msg = "three";
    expect(node.textContent).toBe("two");
  });
});
