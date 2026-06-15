/** Tests for src/panels/preview-render.ts — structural canvas preview renderer. */
import { resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { renderCanvasNode } from "../src/panels/preview-render";
import { elToPath } from "../src/store";
import type { JxMutableNode } from "@jxsuite/schema/types";

const NONE = new Set<string>();

function renderNode(
  node: unknown,
  opts: { breakpoints?: Set<string>; toggles?: Record<string, boolean> } = {},
) {
  const parent = document.createElement("div");
  const result = renderCanvasNode(
    node as JxMutableNode,
    [],
    parent,
    opts.breakpoints ?? NONE,
    opts.toggles ?? {},
  );
  return { parent, result };
}

beforeEach(() => {
  resetStudioState();
  resetWorkspaceWithTab({
    children: [],
    state: {
      computedTitle: { $compute: "x", arguments: [] },
      title: { default: "Hello Title" },
    },
    tagName: "div",
  } as unknown as JxMutableNode);
});

describe("renderCanvasNode primitives", () => {
  test("string becomes a text node", () => {
    const { parent, result } = renderNode("hello");
    expect(parent.textContent).toBe("hello");
    expect(result).toBeUndefined();
  });

  test("number and boolean become text nodes", () => {
    const parent = document.createElement("div");
    renderCanvasNode(42, [], parent, NONE, {});
    renderCanvasNode(true, [], parent, NONE, {});
    expect(parent.textContent).toBe("42true");
  });

  test("null and undefined render nothing", () => {
    const { parent } = renderNode(null);
    expect(parent.childNodes.length).toBe(0);
    const p2 = document.createElement("div");
    renderCanvasNode(undefined, [], p2, NONE, {});
    expect(p2.childNodes.length).toBe(0);
  });
});

describe("renderCanvasNode elements", () => {
  test("defaults to div when tagName missing and registers path", () => {
    const { parent, result } = renderNode({ textContent: "x" });
    const el = parent.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(result).toBe(el);
    expect(elToPath.get(el)).toEqual([]);
    expect(el.style.pointerEvents).toBe("none");
  });

  test("applies tagName, id, className and textContent", () => {
    const { parent } = renderNode({
      className: "hero big",
      id: "main-title",
      tagName: "h1",
      textContent: "Welcome",
    });
    const el = parent.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("H1");
    expect(el.id).toBe("main-title");
    expect(el.className).toBe("hero big");
    expect(el.textContent).toBe("Welcome");
  });

  test("resolves $ref textContent from state defaults with bound styling", () => {
    const { parent } = renderNode({
      tagName: "p",
      textContent: { $ref: "#/state/title" },
    });
    const el = parent.firstElementChild as HTMLElement;
    expect(el.textContent).toBe("Hello Title");
    expect(el.style.opacity).toBe("0.7");
    expect(el.style.fontStyle).toBe("italic");
    expect(el.title).toBe("Bound: #/state/title");
  });

  test("unresolvable $ref textContent falls back to label", () => {
    const { parent } = renderNode({
      tagName: "p",
      textContent: { $ref: "#/state/missing" },
    });
    const el = parent.firstElementChild as HTMLElement;
    expect(el.textContent).toBe("{missing}");
  });

  test("applies base style and active breakpoint overrides", () => {
    const { parent } = renderNode(
      {
        style: { "@md": { color: "blue" }, "@xl": { color: "green" }, color: "red" },
        tagName: "p",
        textContent: "x",
      },
      { breakpoints: new Set(["md"]) },
    );
    const el = parent.firstElementChild as HTMLElement;
    expect(el.style.color).toBe("blue");
  });

  test("sets plain attributes and resolves $ref attribute values", () => {
    const { parent } = renderNode({
      attributes: {
        "data-bound": { $ref: "#/state/title" },
        "data-plain": "yes",
      },
      tagName: "section",
      textContent: "x",
    });
    const el = parent.firstElementChild as HTMLElement;
    expect(el.dataset.plain).toBe("yes");
    expect(el.dataset.bound).toBe("Hello Title");
  });

  test("invalid attribute names are swallowed", () => {
    expect(() =>
      renderNode({
        attributes: { "in valid@": "x" },
        tagName: "div",
      }),
    ).not.toThrow();
  });
});

describe("renderCanvasNode children", () => {
  test("recurses array children with extended paths", () => {
    const { parent } = renderNode({
      children: [
        { tagName: "li", textContent: "one" },
        { tagName: "li", textContent: "two" },
      ],
      tagName: "ul",
    });
    const ul = parent.firstElementChild as HTMLElement;
    expect(ul.children.length).toBe(2);
    expect(elToPath.get(ul.children[0])).toEqual(["children", 0]);
    expect(elToPath.get(ul.children[1])).toEqual(["children", 1]);
    expect(ul.textContent).toBe("onetwo");
  });

  test("mapped-array children render template inside a repeater perimeter", () => {
    const { parent } = renderNode({
      children: {
        $prototype: "Array",
        map: { tagName: "li", textContent: "item" },
      },
      tagName: "ul",
    });
    const ul = parent.firstElementChild as HTMLElement;
    const wrapper = ul.firstElementChild as HTMLElement;
    expect(wrapper.className).toBe("repeater-perimeter");
    expect(elToPath.get(wrapper)).toEqual(["children"]);
    const li = wrapper.firstElementChild as HTMLElement;
    expect(li.tagName).toBe("LI");
    expect(elToPath.get(li)).toEqual(["children", "map"]);
  });

  test("array pseudo-element member renders as a perimeter at its own child index", () => {
    const { parent } = renderNode({
      children: [
        { tagName: "li", textContent: "header" },
        { $prototype: "Array", map: { tagName: "li", textContent: "item" } },
      ],
      tagName: "ul",
    });
    const ul = parent.firstElementChild as HTMLElement;
    expect(ul.children.length).toBe(2);
    expect(elToPath.get(ul.children[0])).toEqual(["children", 0]);
    const perimeter = ul.children[1] as HTMLElement;
    expect(perimeter.className).toBe("repeater-perimeter");
    expect(elToPath.get(perimeter)).toEqual(["children", 1]);
    expect(elToPath.get(perimeter.firstElementChild!)).toEqual(["children", 1, "map"]);
  });

  test("mapped-array without template renders no wrapper", () => {
    const { parent } = renderNode({
      children: { $prototype: "Array" },
      tagName: "ul",
    });
    const ul = parent.firstElementChild as HTMLElement;
    expect(ul.children.length).toBe(0);
  });

  test("$switch nodes render a case placeholder", () => {
    const { parent } = renderNode({
      $switch: "${page}",
      cases: { about: {}, home: {} },
      tagName: "div",
    });
    const el = parent.firstElementChild as HTMLElement;
    const placeholder = el.firstElementChild as HTMLElement;
    expect(placeholder.textContent).toBe("[$switch: about | home]");
    expect(placeholder.style.fontStyle).toBe("italic");
  });
});
