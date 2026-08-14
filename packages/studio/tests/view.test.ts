/**
 * What is left of `view` after the split (src/view.ts): render OUTPUTS only.
 *
 * UI inputs — dock state, the Navigator tab, the layout selection — moved to the reactive `shell`
 * record and are covered by shell.test.ts. The assertion that matters here is the negative one:
 * `view` must not grow reactive state back, because the same object holds a Monaco instance, a live
 * ResizeObserver and detached DOM nodes.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { view } from "../src/view";
import { surfaceForPane } from "../src/canvas/surface-registry";

describe("view", () => {
  test("holds renderer outputs — editor instances, DOM refs and cleanup arrays", () => {
    expect(surfaceForPane("primary").monacoEditor).toBeNull();
    expect(surfaceForPane("primary").panzoomWrap).toBeNull();
    expect(surfaceForPane("primary").centerObserver).toBeNull();
    expect(view.dndCleanups).toBeArray();
    expect(view.elementsCollapsed).toBeInstanceOf(Set);
  });

  test("carries nothing that belongs to ONE STAGE", () => {
    /* The pan/zoom wrap, the centering observer, the pan offsets, the source Monaco and the render
       generation are fields of a `CanvasSurface`. They cannot be type errors here — `ViewState` has
       an index signature — so the guard is `scripts/check-pane-singletons.ts` and this is its
       assertion in the unit suite: the keys are GONE from the object, not merely unread. */
    for (const key of [
      "panzoomWrap",
      "centerObserver",
      "needsCenter",
      "panX",
      "panY",
      "monacoEditor",
      "renderGeneration",
      // And the four that were dead outright: written by no `src/` file, cleared on every render.
      "canvasDndCleanups",
      "canvasEventCleanups",
      "forcedStyleTag",
      "forcedAttrEl",
    ]) {
      expect(Object.hasOwn(view, key)).toBe(false);
    }
  });

  test("carries no UI inputs", () => {
    for (const key of [
      "leftTab",
      "leftPanelCollapsed",
      "rightPanelCollapsed",
      "chatPanelCollapsed",
      "layoutSelection",
    ]) {
      expect(Object.hasOwn(view, key)).toBe(false);
    }
  });
});
