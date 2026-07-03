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

  test("flags layout-originated nodes only when layout-wrapped", () => {
    const ctx = { ...plain, layoutWrapped: true };
    expect(classifyRenderNode(["children", 0], { $__layout: true }, ctx)).toEqual({
      kind: "layout",
    });
    // Not layout-wrapped → the $__layout marker is ignored.
    expect(classifyRenderNode(["children", 0], { $__layout: true }, plain)).toEqual({
      kind: "path",
      path: ["children", 0],
    });
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
