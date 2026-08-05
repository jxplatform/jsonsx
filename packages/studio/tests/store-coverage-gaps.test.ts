/**
 * Store gaps — renderer error guards in render()/renderOnly() and the hover/clipboard/canvas
 * branches of updateSession.
 */
import { resetWorkspaceWithTab } from "./harness";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { registerRenderer, render, renderOnly, updateSession } from "../src/store";
import { closeAllTabs } from "../src/workspace/workspace";
import type { JxMutableNode } from "@jxsuite/schema/types";

afterEach(() => {
  closeAllTabs();
});

describe("renderer error guards", () => {
  test("render() reports a throwing renderer and keeps going", () => {
    const order: string[] = [];
    registerRenderer("gap-throws", () => {
      order.push("throws");
      throw new Error("renderer exploded");
    });
    registerRenderer("gap-after", () => {
      order.push("after");
    });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render()).not.toThrow();
      expect(order).toEqual(["throws", "after"]);
      expect(
        error.mock.calls.some((c) => String(c[0]).includes('Renderer "gap-throws" failed')),
      ).toBe(true);
    } finally {
      error.mockRestore();
      // Neutralize the throwing renderer for any later render() in this process.
      registerRenderer("gap-throws", () => {});
    }
  });

  test("renderOnly() guards the named renderer the same way", () => {
    registerRenderer("gap-only-throws", () => {
      throw new Error("targeted renderer exploded");
    });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => renderOnly("gap-only-throws", "no-such-renderer")).not.toThrow();
      expect(
        error.mock.calls.some((c) => String(c[0]).includes('Renderer "gap-only-throws" failed')),
      ).toBe(true);
    } finally {
      error.mockRestore();
      registerRenderer("gap-only-throws", () => {});
    }
  });
});

describe("updateSession", () => {
  test("writes hover, clipboard, and canvas patches to the active tab", () => {
    const tab = resetWorkspaceWithTab();
    const clip = { tagName: "p", textContent: "copied" } as JxMutableNode;
    updateSession({
      canvas: { error: "boom", status: "error" },
      clipboard: clip,
      hover: ["children", 0],
      selection: [["children", 1]],
    });
    expect(tab.session.hover).toEqual(["children", 0]);
    expect(tab.session.selection).toEqual([["children", 1]]);
    expect(tab.session.clipboard).toEqual(clip);
    expect(tab.session.canvas.status).toBe("error");
    expect(tab.session.canvas.error).toBe("boom");
  });

  test("is a no-op without an active tab", () => {
    closeAllTabs();
    expect(() => updateSession({ hover: ["children", 0] })).not.toThrow();
  });
});
