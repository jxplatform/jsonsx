/**
 * The frame half of change highlighting: the injected stylesheet and the mark stamping.
 *
 * Exercised by importing the frame's modules directly, because `with-dom.ts` sets
 * `disableIframePageLoading` — there is no live frame in a test, and there does not need to be:
 * `applyDiffMarks` takes a container and reads stamped attributes off it.
 */

import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { applyDiffMarks, DIFF_MARK_STYLE_ID, syncDiffCss } from "../src/canvas/iframe-render";
import { serializeJxPath } from "../src/canvas/path-mapping";
import type { JxPath } from "../src/state";

/** A container whose elements carry the same `data-jx-path` stamps the real stamper writes. */
function stamped(paths: JxPath[]): HTMLElement {
  const root = document.createElement("div");
  for (const path of paths) {
    const el = document.createElement("p");
    el.dataset.jxPath = serializeJxPath(path);
    root.append(el);
  }
  return root;
}

const at = (root: HTMLElement, path: JxPath) =>
  root.querySelector<HTMLElement>(`[data-jx-path='${serializeJxPath(path)}']`);

afterEach(() => {
  document.head.querySelector(`#${DIFF_MARK_STYLE_ID}`)?.remove();
});

describe("syncDiffCss", () => {
  test("adds the sheet once and is idempotent", () => {
    syncDiffCss(document, true);
    syncDiffCss(document, true);
    expect(document.head.querySelectorAll(`#${DIFF_MARK_STYLE_ID}`)).toHaveLength(1);
  });

  test("removes it when the render carries no marks", () => {
    syncDiffCss(document, true);
    syncDiffCss(document, false);
    expect(document.head.querySelector(`#${DIFF_MARK_STYLE_ID}`)).toBeNull();
  });

  test("encodes each kind with a border style, not colour alone", () => {
    syncDiffCss(document, true);
    const css = document.head.querySelector(`#${DIFF_MARK_STYLE_ID}`)?.textContent ?? "";
    expect(css).toContain("border-left-style: solid");
    expect(css).toContain("border-left-style: double");
    expect(css).toContain("border-left-style: dashed");
    // The forced-colours block has to live in the frame: styles/forced-colors.css is chrome and
    // Never reaches this document.
    expect(css).toContain("forced-colors: active");
  });
});

describe("applyDiffMarks", () => {
  test("stamps each mark on the element its path names", () => {
    const root = stamped([
      ["children", 0],
      ["children", 1],
    ]);
    applyDiffMarks(root, [
      { kind: "added", path: ["children", 0] },
      { kind: "removed", path: ["children", 1] },
    ]);
    expect(at(root, ["children", 0])?.dataset.jxDiff).toBe("added");
    expect(at(root, ["children", 1])?.dataset.jxDiff).toBe("removed");
  });

  test("replaces the whole set, so a render with no marks clears the last one's", () => {
    const root = stamped([["children", 0]]);
    applyDiffMarks(root, [{ kind: "modified-after", path: ["children", 0] }]);
    applyDiffMarks(root, null);
    expect(at(root, ["children", 0])?.dataset.jxDiff).toBeUndefined();
  });

  test("an unresolvable mark climbs to the nearest stamped ancestor", () => {
    /* The case this exists for: a component's internals never pass through the stamper, and only
       the first expanded repeater row carries the template's collapsed path. Dropping the mark
       would make the artboard disagree with a count the toolbar states out loud. */
    const root = document.createElement("div");
    const section = document.createElement("section");
    section.dataset.jxPath = serializeJxPath(["children", 0]);
    root.append(section);
    applyDiffMarks(root, [{ kind: "modified-after", path: ["children", 0, "children", 3] }]);
    expect(section.dataset.jxDiffWithin).toBe("");
    expect(section.dataset.jxDiff).toBeUndefined();
  });

  test("a mark with no stamped ancestor at all is simply dropped", () => {
    const root = stamped([["children", 0]]);
    applyDiffMarks(root, [{ kind: "added", path: ["children", 9, "children", 1] }]);
    expect(root.querySelector("[data-jx-diff]")).toBeNull();
    expect(root.querySelector("[data-jx-diff-within]")).toBeNull();
  });

  test("climbing clears between renders too", () => {
    const root = document.createElement("div");
    const section = document.createElement("section");
    section.dataset.jxPath = serializeJxPath(["children", 0]);
    root.append(section);
    applyDiffMarks(root, [{ kind: "modified-after", path: ["children", 0, "children", 3] }]);
    applyDiffMarks(root, []);
    expect(section.dataset.jxDiffWithin).toBeUndefined();
  });
});
