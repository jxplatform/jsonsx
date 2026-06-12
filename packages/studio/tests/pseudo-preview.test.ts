/** Tests for src/panels/pseudo-preview.ts — forced pseudo-state preview. */
import { resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { updateForcedPseudoPreview } from "../src/panels/pseudo-preview";
import { canvasPanels, elToPath } from "../src/store";
import { view } from "../src/view";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { CanvasPanel } from "../src/types";

/** Build a canvas DOM mirroring `doc` (root div > p) and register it as the only panel. */
function installPanel(mediaName: string | null = null) {
  const canvas = document.createElement("div");
  const root = document.createElement("div");
  const p = document.createElement("p");
  p.textContent = "hi";
  root.append(p);
  canvas.append(root);
  elToPath.set(root, []);
  elToPath.set(p, ["children", 0]);
  canvasPanels.push({ canvas, mediaName } as unknown as CanvasPanel);
  return { canvas, p, root };
}

function makeDoc(style: Record<string, unknown>): JxMutableNode {
  return {
    children: [{ style, tagName: "p", textContent: "hi" }],
    tagName: "div",
  } as unknown as JxMutableNode;
}

beforeEach(() => {
  resetStudioState();
  canvasPanels.length = 0;
  view.forcedStyleTag = null;
  view.forcedAttrEl = null;
});

describe("updateForcedPseudoPreview", () => {
  test("applies forced styles for an active pseudo selector", () => {
    const tab = resetWorkspaceWithTab(
      makeDoc({ ":hover": { backgroundColor: "var(--x)", color: "blue" }, color: "red" }),
    );
    const { p } = installPanel();
    tab.session.selection = ["children", 0];
    tab.session.ui.activeSelector = ":hover";

    updateForcedPseudoPreview();

    expect(p.dataset.studioForced).toBe("1");
    expect(view.forcedAttrEl).toBe(p);
    expect(view.forcedStyleTag).not.toBeNull();
    const css = view.forcedStyleTag?.textContent ?? "";
    expect(css).toContain("[data-studio-forced]");
    expect(css).toContain("color: blue !important");
    expect(css).toContain("background-color: var(--x) !important");
    expect(view.forcedStyleTag?.isConnected).toBe(true);
  });

  test("uses the active media context when set", () => {
    const tab = resetWorkspaceWithTab(
      makeDoc({
        ":hover": { color: "blue" },
        "@md": { ":hover": { color: "green" } },
        color: "red",
      }),
    );
    const { p } = installPanel("md");
    tab.session.selection = ["children", 0];
    tab.session.ui.activeSelector = ":hover";
    tab.session.ui.activeMedia = "md";

    updateForcedPseudoPreview();

    expect(p.dataset.studioForced).toBe("1");
    expect(view.forcedStyleTag?.textContent).toContain("color: green !important");
    expect(view.forcedStyleTag?.textContent).not.toContain("blue");
  });

  test("active media without that pseudo block applies nothing", () => {
    const tab = resetWorkspaceWithTab(makeDoc({ ":hover": { color: "blue" }, color: "red" }));
    const { p } = installPanel("md");
    tab.session.selection = ["children", 0];
    tab.session.ui.activeSelector = ":hover";
    tab.session.ui.activeMedia = "md";

    updateForcedPseudoPreview();

    expect(view.forcedStyleTag).toBeNull();
    expect(p.dataset.studioForced).toBeUndefined();
  });

  test("clears previous forced state when selector is no longer a pseudo", () => {
    const tab = resetWorkspaceWithTab(makeDoc({ ":hover": { color: "blue" } }));
    const { p } = installPanel();
    tab.session.selection = ["children", 0];
    tab.session.ui.activeSelector = ":hover";
    updateForcedPseudoPreview();
    const tag = view.forcedStyleTag;
    expect(tag).not.toBeNull();

    tab.session.ui.activeSelector = null;
    updateForcedPseudoPreview();

    expect(view.forcedStyleTag).toBeNull();
    expect(view.forcedAttrEl).toBeNull();
    expect(tag?.isConnected).toBe(false);
    expect(p.dataset.studioForced).toBeUndefined();
  });

  test("ignores non-pseudo selectors", () => {
    const tab = resetWorkspaceWithTab(makeDoc({ ".active": { color: "blue" } }));
    installPanel();
    tab.session.selection = ["children", 0];
    tab.session.ui.activeSelector = ".active";
    updateForcedPseudoPreview();
    expect(view.forcedStyleTag).toBeNull();
  });

  test("no-op without a selection", () => {
    const tab = resetWorkspaceWithTab(makeDoc({ ":hover": { color: "blue" } }));
    installPanel();
    tab.session.selection = null;
    tab.session.ui.activeSelector = ":hover";
    updateForcedPseudoPreview();
    expect(view.forcedStyleTag).toBeNull();
  });

  test("no-op when there are no canvas panels", () => {
    const tab = resetWorkspaceWithTab(makeDoc({ ":hover": { color: "blue" } }));
    tab.session.selection = ["children", 0];
    tab.session.ui.activeSelector = ":hover";
    updateForcedPseudoPreview();
    expect(view.forcedStyleTag).toBeNull();
  });

  test("no-op when the selected element is missing from the canvas", () => {
    const tab = resetWorkspaceWithTab(makeDoc({ ":hover": { color: "blue" } }));
    installPanel();
    tab.session.selection = ["children", 5];
    tab.session.ui.activeSelector = ":hover";
    updateForcedPseudoPreview();
    expect(view.forcedStyleTag).toBeNull();
  });

  test("no-op when the node has no style", () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "hi" }],
      tagName: "div",
    } as unknown as JxMutableNode);
    installPanel();
    tab.session.selection = ["children", 0];
    tab.session.ui.activeSelector = ":hover";
    updateForcedPseudoPreview();
    expect(view.forcedStyleTag).toBeNull();
  });

  test("no-op when the pseudo block exists but has no scalar props", () => {
    const tab = resetWorkspaceWithTab(makeDoc({ ":hover": { nested: { color: "x" } } }));
    const { p } = installPanel();
    tab.session.selection = ["children", 0];
    tab.session.ui.activeSelector = ":hover";
    updateForcedPseudoPreview();
    expect(view.forcedStyleTag).toBeNull();
    expect(p.dataset.studioForced).toBeUndefined();
  });

  test("no-op when the selector has no rules at all", () => {
    const tab = resetWorkspaceWithTab(makeDoc({ color: "red" }));
    installPanel();
    tab.session.selection = ["children", 0];
    tab.session.ui.activeSelector = ":focus";
    updateForcedPseudoPreview();
    expect(view.forcedStyleTag).toBeNull();
  });
});
