/**
 * In-iframe surgical patcher — applies value-carrying forward ops to the iframe's shadow doc and
 * its live DOM. Verifies in-place style/text fidelity (matching the full edit-mode render), event
 * no-ops, shadow-doc folding, and that any op it can't apply surgically throws (so the caller
 * reports a `patchError` and the parent escalates to a full render).
 */
import "./with-dom.js";
import { beforeAll, describe, expect, test } from "bun:test";
import { buildScope } from "@jxsuite/runtime";
import { applyIframePatch } from "../src/canvas/iframe-patch";
import { serializeJxPath } from "../src/canvas/path-mapping";
import { getNodeAtPath } from "../src/state";
import type { IframeRenderCtx } from "../src/canvas/iframe-render";
import type { JxDocument, JxMutableNode } from "@jxsuite/schema/types";
import type { WireDocOp } from "../src/canvas/iframe-protocol";

// A render context for the subtree-render ops (insert / set-child / re-render). The scope is empty
// (the test nodes carry no `$ref`/state bindings) and the mapper is the unwrapped page-doc default.
let CTX: IframeRenderCtx;
beforeAll(async () => {
  CTX = {
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

/**
 * Build a container whose elements carry `data-jx-path` (as the iframe's full render stamps them)
 * for the given doc, plus the raw shadow doc the forward ops are recorded against. Only `children`
 * and top-level `textContent`/`style` are mirrored — enough to exercise the in-place patcher.
 */
function mount(doc: JxMutableNode): { container: HTMLElement; shadow: JxMutableNode } {
  const shadow = structuredClone(doc);
  const container = document.createElement("div");
  const root = document.createElement(doc.tagName as string);
  root.dataset.jxPath = serializeJxPath([]);
  for (const [i, kid] of ((doc.children as JxMutableNode[]) ?? []).entries()) {
    const el = document.createElement(kid.tagName as string);
    el.dataset.jxPath = serializeJxPath(["children", i]);
    if (typeof kid.textContent === "string") {
      el.textContent = kid.textContent;
    }
    if (kid.style && typeof kid.style === "object") {
      for (const [k, v] of Object.entries(kid.style)) {
        el.style.setProperty(k, String(v));
      }
    }
    root.append(el);
  }
  container.append(root);
  return { container, shadow };
}

function elAt(container: HTMLElement, path: (string | number)[]): HTMLElement {
  return container.querySelector(`[data-jx-path='${serializeJxPath(path)}']`) as HTMLElement;
}

const BASE: JxMutableNode = {
  children: [
    { style: { color: "red" }, tagName: "p", textContent: "hello" },
    { tagName: "span", textContent: "world" },
  ],
  tagName: "div",
} as unknown as JxMutableNode;

describe("applyIframePatch — set-style", () => {
  test("re-emits the node's style onto its element and folds the value into the shadow doc", () => {
    const { container, shadow } = mount(BASE);
    const op: WireDocOp = {
      key: "style",
      op: "set-key",
      path: ["children", 0],
      value: { color: "blue", fontWeight: "700" },
    };
    applyIframePatch(shadow, [op], container);

    const el = elAt(container, ["children", 0]);
    expect(el.style.color).toBe("blue");
    expect(el.style.fontWeight).toBe("700");
    // The previous inline color was cleared, not merged.
    expect((shadow.children as JxMutableNode[])[0]!.style).toEqual({
      color: "blue",
      fontWeight: "700",
    });
  });

  test("blanks template-string style values (edit-mode transform)", () => {
    const { container, shadow } = mount(BASE);
    const op: WireDocOp = {
      key: "style",
      op: "set-key",
      path: ["children", 0],
      value: { color: "${state.c}", fontSize: "12px" },
    };
    applyIframePatch(shadow, [op], container);

    const el = elAt(container, ["children", 0]);
    expect(el.style.color).toBe(""); // Template value blanked.
    expect(el.style.fontSize).toBe("12px");
  });

  test("clearing the style empties the element's inline style", () => {
    const { container, shadow } = mount(BASE);
    applyIframePatch(
      shadow,
      [{ key: "style", op: "set-key", path: ["children", 0], value: {} }],
      container,
    );
    expect(elAt(container, ["children", 0]).style.color).toBe("");
  });

  test("a non-object style value clears the element's inline style", () => {
    const { container, shadow } = mount(BASE);
    applyIframePatch(
      shadow,
      [{ key: "style", op: "set-key", path: ["children", 0], value: null }],
      container,
    );
    expect(elAt(container, ["children", 0]).style.color).toBe("");
  });
});

describe("applyIframePatch — set-text", () => {
  test("writes the node's display text and folds it into the shadow doc", () => {
    const { container, shadow } = mount(BASE);
    const op: WireDocOp = {
      key: "textContent",
      op: "set-key",
      path: ["children", 1],
      value: "updated",
    };
    applyIframePatch(shadow, [op], container);

    expect(elAt(container, ["children", 1]).textContent).toBe("updated");
    expect((shadow.children as JxMutableNode[])[1]!.textContent).toBe("updated");
  });

  test("renders a template string as a literal expression", () => {
    const { container, shadow } = mount(BASE);
    applyIframePatch(
      shadow,
      [{ key: "textContent", op: "set-key", path: ["children", 1], value: "Hi ${state.name}" }],
      container,
    );
    expect(elAt(container, ["children", 1]).textContent).toBe("Hi ❪ state.name ❫");
  });

  test("renders a null/undefined text value as empty string", () => {
    const { container, shadow } = mount(BASE);
    applyIframePatch(
      shadow,
      [{ key: "textContent", op: "set-key", path: ["children", 1], value: null }],
      container,
    );
    expect(elAt(container, ["children", 1]).textContent).toBe("");
  });

  test("stringifies a non-string, non-$ref text value", () => {
    const { container, shadow } = mount(BASE);
    applyIframePatch(
      shadow,
      [{ key: "textContent", op: "set-key", path: ["children", 1], value: 42 }],
      container,
    );
    expect(elAt(container, ["children", 1]).textContent).toBe("42");
  });

  test("renders a $ref binding as a display label", () => {
    const { container, shadow } = mount(BASE);
    applyIframePatch(
      shadow,
      [
        {
          key: "textContent",
          op: "set-key",
          path: ["children", 1],
          value: { $ref: "#/state/title" },
        },
      ],
      container,
    );
    expect(elAt(container, ["children", 1]).textContent).toBe("{title}");
  });

  test("toggles the empty-text placeholder class when text is cleared and restored", () => {
    const { container, shadow } = mount(BASE);
    // Clearing a <span>'s text adds the empty-text placeholder.
    applyIframePatch(
      shadow,
      [{ key: "textContent", op: "set-key", path: ["children", 1], value: "" }],
      container,
    );
    const el = elAt(container, ["children", 1]);
    expect(el.classList.contains("empty-text-placeholder")).toBe(true);

    // Restoring text removes it again.
    applyIframePatch(
      shadow,
      [{ key: "textContent", op: "set-key", path: ["children", 1], value: "back" }],
      container,
    );
    expect(el.classList.contains("empty-text-placeholder")).toBe(false);
    expect(el.textContent).toBe("back");
  });
});

describe("applyIframePatch — event bindings and escalation", () => {
  test("event-handler keys are a no-op (stripped from the edit render)", () => {
    const { container, shadow } = mount(BASE);
    expect(() =>
      applyIframePatch(
        shadow,
        [{ key: "onclick", op: "set-key", path: ["children", 0], value: "doThing()" }],
        container,
      ),
    ).not.toThrow();
    // The handler is folded into the shadow doc but never touches the DOM.
    expect((shadow.children as JxMutableNode[])[0]!.onclick).toBe("doThing()");
  });

  test("throws when a subtree-render op arrives without a render context (caller escalates)", () => {
    const { container, shadow } = mount(BASE);
    // A `set-key` on a key that needs re-rendering, but no ctx passed (e.g. patch before a render).
    expect(() =>
      applyIframePatch(
        shadow,
        [{ key: "attributes", op: "set-key", path: ["children", 0], value: { title: "x" } }],
        container,
      ),
    ).toThrow(/iframe-patch-no-render-ctx/);
  });

  test("throws when the target element is missing from the DOM (shadow has it, DOM doesn't)", () => {
    const { container, shadow } = mount(BASE);
    // Drop the element from the DOM while keeping the node in the shadow doc: the fold succeeds but
    // The DOM lookup fails — exactly the drift the patcher must escalate on.
    elAt(container, ["children", 1]).remove();
    expect(() =>
      applyIframePatch(
        shadow,
        [{ key: "textContent", op: "set-key", path: ["children", 1], value: "x" }],
        container,
      ),
    ).toThrow(/iframe-patch-element-not-found/);
  });

  test("throws when the op targets a path absent from the shadow doc", () => {
    const { container, shadow } = mount(BASE);
    expect(() =>
      applyIframePatch(
        shadow,
        [{ key: "textContent", op: "set-key", path: ["children", 9], value: "x" }],
        container,
      ),
    ).toThrow(/doc-op-node-not-found/);
  });
});

// ─── Structural ops (Phase 3b-1: remove / move — no subtree render) ──────────────

/** Mount a doc as DOM with `data-jx-path` stamped recursively (the iframe full render's shape). */
function mountTree(doc: JxMutableNode): { container: HTMLElement; shadow: JxMutableNode } {
  const shadow = structuredClone(doc);
  const container = document.createElement("div");
  const build = (node: JxMutableNode, path: (string | number)[]): HTMLElement => {
    const el = document.createElement(node.tagName as string);
    el.dataset.jxPath = serializeJxPath(path);
    if (typeof node.textContent === "string") {
      el.append(document.createTextNode(node.textContent));
    }
    const kids = node.children;
    if (Array.isArray(kids)) {
      for (const [i, k] of kids.entries()) {
        el.append(build(k as JxMutableNode, [...path, "children", i]));
      }
    }
    return el;
  };
  container.append(build(doc, []));
  return { container, shadow };
}

/** Every stamped element resolves to a same-tag node in the shadow doc → DOM and shadow agree. */
function expectConsistent(container: HTMLElement, shadow: JxMutableNode): void {
  for (const el of container.querySelectorAll<HTMLElement>("[data-jx-path]")) {
    const node = getNodeAtPath(shadow, JSON.parse(el.dataset.jxPath!)) as JxMutableNode | undefined;
    expect(node, `no shadow node for ${el.dataset.jxPath}`).toBeDefined();
    expect((node!.tagName as string).toLowerCase()).toBe(el.tagName.toLowerCase());
  }
}

const TREE: JxMutableNode = {
  children: [
    { tagName: "p", textContent: "a" },
    { tagName: "span", textContent: "b" },
    { children: [{ tagName: "em", textContent: "c" }], tagName: "div" },
  ],
  tagName: "div",
} as unknown as JxMutableNode;

function rootChildTags(container: HTMLElement): string[] {
  return [...container.firstElementChild!.children].map((c) => c.tagName.toLowerCase());
}

describe("applyIframePatch — remove-child", () => {
  test("removes the element and shifts later siblings' paths (and descendants) down", () => {
    const { container, shadow } = mountTree(TREE);
    applyIframePatch(shadow, [{ index: 0, op: "remove-child", parentPath: [] }], container);

    expect(container.querySelector("p")).toBeNull();
    expect(rootChildTags(container)).toEqual(["span", "div"]);
    expect(elAt(container, ["children", 0]).tagName.toLowerCase()).toBe("span");
    expect(elAt(container, ["children", 1]).tagName.toLowerCase()).toBe("div");
    // The descendant under the shifted div re-paths too.
    expect(elAt(container, ["children", 1, "children", 0]).tagName.toLowerCase()).toBe("em");
    expectConsistent(container, shadow);
  });
});

describe("applyIframePatch — move-child", () => {
  test("same-parent forward move re-paths the siblings between the slots", () => {
    const { container, shadow } = mountTree(TREE);
    applyIframePatch(
      shadow,
      [{ fromIndex: 0, fromParentPath: [], op: "move-child", toIndex: 1, toParentPath: [] }],
      container,
    );
    // Shadow folds to [span, p, div]; the DOM order and paths must match.
    expect(rootChildTags(container)).toEqual(["span", "p", "div"]);
    expect(elAt(container, ["children", 0]).tagName.toLowerCase()).toBe("span");
    expect(elAt(container, ["children", 1]).tagName.toLowerCase()).toBe("p");
    expect(elAt(container, ["children", 2]).tagName.toLowerCase()).toBe("div");
    expectConsistent(container, shadow);
  });

  test("same-parent backward move carries the moved subtree's descendants", () => {
    const { container, shadow } = mountTree(TREE);
    applyIframePatch(
      shadow,
      [{ fromIndex: 2, fromParentPath: [], op: "move-child", toIndex: 0, toParentPath: [] }],
      container,
    );
    // Shadow folds to [div, p, span].
    expect(rootChildTags(container)).toEqual(["div", "p", "span"]);
    expect(elAt(container, ["children", 0]).tagName.toLowerCase()).toBe("div");
    expect(elAt(container, ["children", 0, "children", 0]).tagName.toLowerCase()).toBe("em");
    expectConsistent(container, shadow);
  });

  test("cross-parent move reinserts the subtree under the destination and re-paths both", () => {
    const { container, shadow } = mountTree(TREE);
    // Move p (children/0) into the div (children/2, pre-mutation path) at index 0.
    applyIframePatch(
      shadow,
      [
        {
          fromIndex: 0,
          fromParentPath: [],
          op: "move-child",
          toIndex: 0,
          toParentPath: ["children", 2],
        },
      ],
      container,
    );
    // Shadow folds to [span, div[p, em]]; the div is now children/1.
    expect(rootChildTags(container)).toEqual(["span", "div"]);
    expect(elAt(container, ["children", 0]).tagName.toLowerCase()).toBe("span");
    expect(elAt(container, ["children", 1]).tagName.toLowerCase()).toBe("div");
    expect(elAt(container, ["children", 1, "children", 0]).tagName.toLowerCase()).toBe("p");
    expect(elAt(container, ["children", 1, "children", 1]).tagName.toLowerCase()).toBe("em");
    // DOM order inside the div: the moved p precedes the original em.
    expect(
      [...elAt(container, ["children", 1]).children].map((c) => c.tagName.toLowerCase()),
    ).toEqual(["p", "em"]);
    expectConsistent(container, shadow);
  });
});

// ─── Subtree-render ops (Phase 3b-2: insert / set-child / re-render) ─────────────

describe("applyIframePatch — subtree render", () => {
  test("insert-child renders the new node and splices it in, shifting siblings up", () => {
    const { container, shadow } = mountTree(TREE);
    applyIframePatch(
      shadow,
      [
        {
          index: 1,
          node: { tagName: "b", textContent: "NEW" },
          op: "insert-child",
          parentPath: [],
        },
      ],
      container,
      CTX,
    );
    expect(rootChildTags(container)).toEqual(["p", "b", "span", "div"]);
    const inserted = elAt(container, ["children", 1]);
    expect(inserted.tagName.toLowerCase()).toBe("b");
    expect(inserted.textContent).toBe("NEW");
    expect(inserted.dataset.jxPath).toBe(serializeJxPath(["children", 1]));
    expect(elAt(container, ["children", 2]).tagName.toLowerCase()).toBe("span");
    // The descendant under the shifted div re-paths to children/3.
    expect(elAt(container, ["children", 3, "children", 0]).tagName.toLowerCase()).toBe("em");
    expectConsistent(container, shadow);
  });

  test("set-child re-renders and replaces the node in place", () => {
    const { container, shadow } = mountTree(TREE);
    applyIframePatch(
      shadow,
      [
        {
          index: 0,
          node: { tagName: "h2", textContent: "Replaced" },
          op: "set-child",
          parentPath: [],
        },
      ],
      container,
      CTX,
    );
    expect(rootChildTags(container)).toEqual(["h2", "span", "div"]);
    const el = elAt(container, ["children", 0]);
    expect(el.tagName.toLowerCase()).toBe("h2");
    expect(el.textContent).toBe("Replaced");
    expectConsistent(container, shadow);
  });

  test("set-key on a non-style/text key re-renders the node's subtree", () => {
    const { container, shadow } = mountTree(TREE);
    applyIframePatch(
      shadow,
      [{ key: "attributes", op: "set-key", path: ["children", 0], value: { title: "hi" } }],
      container,
      CTX,
    );
    const el = elAt(container, ["children", 0]);
    expect(el.tagName.toLowerCase()).toBe("p"); // Same tag, re-rendered with the new attribute.
    expect(el.getAttribute("title")).toBe("hi");
    expect(el.textContent).toBe("a"); // Existing text preserved.
    expectConsistent(container, shadow);
  });

  test("inserting into an empty container clears its empty-container placeholder", () => {
    // A doc whose div child is empty (gets the placeholder class in mountTree-equivalent render).
    const doc: JxMutableNode = {
      children: [{ children: [], tagName: "div" }],
      tagName: "div",
    } as unknown as JxMutableNode;
    const { container, shadow } = mountTree(doc);
    const emptyDiv = elAt(container, ["children", 0]);
    emptyDiv.classList.add("empty-container-placeholder");

    applyIframePatch(
      shadow,
      [
        {
          index: 0,
          node: { tagName: "span", textContent: "x" },
          op: "insert-child",
          parentPath: ["children", 0],
        },
      ],
      container,
      CTX,
    );
    expect(emptyDiv.classList.contains("empty-container-placeholder")).toBe(false);
    expect(elAt(container, ["children", 0, "children", 0]).tagName.toLowerCase()).toBe("span");
    expectConsistent(container, shadow);
  });
});
