import { describe, expect, test } from "bun:test";
import { classifyRenderNode, parseJxPath, serializeJxPath } from "../src/canvas/path-mapping";
import type { PathMapCtx } from "../src/canvas/path-mapping";

const plain: PathMapCtx = {
  arrayPaths: new Set(),
  canvasMode: "design",
  layoutWrapped: false,
  pageContentOffset: null,
  pageContentPrefix: null,
};

describe("serializeJxPath / parseJxPath", () => {
  test("round-trips, preserving string-vs-number segments", () => {
    const path = ["children", 0, "map", 2];
    const s = serializeJxPath(path);
    expect(s).toBe('["children",0,"map",2]');
    expect(parseJxPath(s)).toEqual(path);
  });
});

describe("classifyRenderNode", () => {
  test("passes non-layout, non-repeater paths through unchanged", () => {
    expect(classifyRenderNode(["children", 1], { tagName: "p" }, plain)).toEqual({
      kind: "path",
      path: ["children", 1],
    });
  });

  test("flags layout-originated nodes only when layout-wrapped, carrying their origin", () => {
    const ctx = { ...plain, layoutWrapped: true };
    const marker = { $__layout: { file: "layouts/base.json", path: ["children", 0] } };
    expect(classifyRenderNode(["children", 0], marker, ctx)).toEqual({
      chrome: true,
      kind: "layout",
      layoutFile: "layouts/base.json",
      layoutPath: ["children", 0],
    });
    // Not layout-wrapped → the $__layout marker is ignored.
    expect(classifyRenderNode(["children", 0], marker, plain)).toEqual({
      kind: "path",
      path: ["children", 0],
    });
  });

  test("a legacy boolean marker still classifies, with an empty origin", () => {
    // The marker was a bare `true` before it carried an origin; degrade to "layout, unaddressable"
    // Rather than mistaking the node for page content and stamping it with a page path.
    const ctx = { ...plain, layoutWrapped: true };
    expect(classifyRenderNode(["children", 0], { $__layout: true }, ctx)).toEqual({
      chrome: true,
      kind: "layout",
      layoutFile: "",
      layoutPath: [],
    });
  });

  test("the nodes on the way down to the page content are NOT chrome", () => {
    // Dimming/freezing them would dim and freeze the page itself: they wrap it.
    const ctx: PathMapCtx = {
      ...plain,
      layoutWrapped: true,
      pageContentPrefix: ["children", 1, "children"],
    };
    const marker = (path: (string | number)[]) => ({ $__layout: { file: "l.json", path } });
    // The layout root and the <main> that holds the slot.
    expect(classifyRenderNode([], marker([]), ctx)).toMatchObject({ chrome: false });
    expect(classifyRenderNode(["children", 1], marker(["children", 1]), ctx)).toMatchObject({
      chrome: false,
    });
    // A sibling header, and a layout <noscript> sitting BEFORE the slot inside <main>.
    expect(classifyRenderNode(["children", 0], marker(["children", 0]), ctx)).toMatchObject({
      chrome: true,
    });
    expect(classifyRenderNode(["children", 1, "children", 0], marker(["c"]), ctx)).toMatchObject({
      chrome: true,
    });
  });

  test("with no page content distributed, only the root escapes chrome", () => {
    const ctx = { ...plain, layoutWrapped: true };
    const marker = { $__layout: { file: "l.json", path: [] } };
    expect(classifyRenderNode([], marker, ctx)).toMatchObject({ chrome: false });
    expect(classifyRenderNode(["children", 0], marker, ctx)).toMatchObject({ chrome: true });
  });

  test("strips the layout prefix and subtracts the page-content offset", () => {
    const ctx: PathMapCtx = {
      ...plain,
      layoutWrapped: true,
      pageContentOffset: 1,
      pageContentPrefix: ["children", 0, "children"],
    };
    // Render path under the layout prefix, container index 2 → page child index 2 - 1 = 1.
    expect(classifyRenderNode(["children", 0, "children", 2, "children", 3], {}, ctx)).toEqual({
      kind: "path",
      path: ["children", 1, "children", 3],
    });
  });

  test("collapses a repeater-perimeter template hop to a map segment", () => {
    const ctx: PathMapCtx = { ...plain, arrayPaths: new Set(["children/2"]) };
    // [...P, "children", 0, ...rest] with P = ["children", 2] → [...P, "map", ...rest].
    expect(classifyRenderNode(["children", 2, "children", 0, "children", 1], {}, ctx)).toEqual({
      kind: "path",
      path: ["children", 2, "map", "children", 1],
    });
  });

  test("repeater remap only applies in design/edit mode", () => {
    const ctx: PathMapCtx = {
      ...plain,
      canvasMode: "preview",
      arrayPaths: new Set(["children/2"]),
    };
    expect(classifyRenderNode(["children", 2, "children", 0], {}, ctx)).toEqual({
      kind: "path",
      path: ["children", 2, "children", 0],
    });
  });
});
