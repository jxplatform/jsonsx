/**
 * In-iframe surgical patcher — applies value-carrying forward ops to the iframe's shadow doc and
 * its live DOM. Verifies in-place style/text fidelity (matching the full edit-mode render), event
 * no-ops, shadow-doc folding, and that any op it can't apply surgically throws (so the caller
 * reports a `patchError` and the parent escalates to a full render).
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { applyIframePatch } from "../src/canvas/iframe-patch";
import { serializeJxPath } from "../src/canvas/path-mapping";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { WireDocOp } from "../src/canvas/iframe-protocol";

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

  test("throws on an unsupported set-key key so the caller escalates", () => {
    const { container, shadow } = mount(BASE);
    expect(() =>
      applyIframePatch(
        shadow,
        [{ key: "tagName", op: "set-key", path: ["children", 0], value: "h2" }],
        container,
      ),
    ).toThrow(/iframe-patch-unsupported-key:tagName/);
  });

  test("throws on a structural (non set-key) op so the caller escalates", () => {
    const { container, shadow } = mount(BASE);
    expect(() =>
      applyIframePatch(
        shadow,
        [{ index: 0, node: { tagName: "b" }, op: "insert-child", parentPath: [] }],
        container,
      ),
    ).toThrow(/iframe-patch-unsupported-op:insert-child/);
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
