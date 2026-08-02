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

describe("view", () => {
  test("holds renderer outputs — editor instances, DOM refs and cleanup arrays", () => {
    expect(view.monacoEditor).toBeNull();
    expect(view.panzoomWrap).toBeNull();
    expect(view.centerObserver).toBeNull();
    expect(view.dndCleanups).toBeArray();
    expect(view.canvasDndCleanups).toBeArray();
    expect(view.canvasEventCleanups).toBeArray();
    expect(view.elementsCollapsed).toBeInstanceOf(Set);
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
