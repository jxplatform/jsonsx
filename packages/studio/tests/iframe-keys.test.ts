/**
 * In-iframe keyboard forwarding — decides which keystrokes belong to the editor's global shortcuts,
 * flattens them for the bridge, and forwards them (preventing the browser default) so studio
 * shortcuts keep working when focus is inside the canvas iframe.
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { serializeKey, shouldForwardKey, startKeyForwarding } from "../src/canvas/iframe-keys";
import { beginIframeDrag, clearIframeDrag, isDragActive } from "../src/canvas/iframe-drop";
import type { IframeToParent } from "../src/canvas/iframe-protocol";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

describe("shouldForwardKey", () => {
  test("forwards Ctrl/Cmd combos", () => {
    expect(shouldForwardKey(key({ ctrlKey: true, key: "z" }))).toBe(true);
    expect(shouldForwardKey(key({ key: "s", metaKey: true }))).toBe(true);
    expect(shouldForwardKey(key({ ctrlKey: true, key: "d", shiftKey: true }))).toBe(true);
  });

  test("forwards the bare editing/navigation keys", () => {
    for (const k of [
      "Delete",
      "Backspace",
      "Escape",
      "Enter",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
    ]) {
      expect(shouldForwardKey(key({ key: k }))).toBe(true);
    }
  });

  test("ignores plain character keys (so typing is untouched)", () => {
    expect(shouldForwardKey(key({ key: "a" }))).toBe(false);
    expect(shouldForwardKey(key({ key: "X" }))).toBe(false);
    expect(shouldForwardKey(key({ key: " " }))).toBe(false);
  });
});

describe("serializeKey", () => {
  test("flattens the modifier + key fields", () => {
    expect(serializeKey(key({ code: "KeyZ", ctrlKey: true, key: "z", shiftKey: true }))).toEqual({
      altKey: false,
      code: "KeyZ",
      ctrlKey: true,
      key: "z",
      metaKey: false,
      shiftKey: true,
    });
  });
});

describe("startKeyForwarding", () => {
  test("forwards a global shortcut and prevents its default", () => {
    const posts: IframeToParent[] = [];
    const stop = startKeyForwarding(
      { post: (m: IframeToParent) => posts.push(m) } as never,
      document,
    );
    const e = key({ ctrlKey: true, key: "z" });
    document.body.dispatchEvent(e);

    expect(posts).toEqual([
      {
        event: {
          altKey: false,
          code: "",
          ctrlKey: true,
          key: "z",
          metaKey: false,
          shiftKey: false,
        },
        kind: "forwardKey",
      },
    ]);
    expect(e.defaultPrevented).toBe(true);
    stop();
  });

  test("does not forward plain typing keys", () => {
    const posts: IframeToParent[] = [];
    const stop = startKeyForwarding(
      { post: (m: IframeToParent) => posts.push(m) } as never,
      document,
    );
    document.body.dispatchEvent(key({ key: "a" }));
    expect(posts).toEqual([]);
    stop();
  });

  test("leaves keystrokes alone while an editable element is focused", () => {
    const posts: IframeToParent[] = [];
    const stop = startKeyForwarding(
      { post: (m: IframeToParent) => posts.push(m) } as never,
      document,
    );
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(key({ key: "Backspace" })); // Target is the input.
    expect(posts).toEqual([]);
    input.remove();
    stop();
  });

  test("teardown removes the listener", () => {
    const posts: IframeToParent[] = [];
    const stop = startKeyForwarding(
      { post: (m: IframeToParent) => posts.push(m) } as never,
      document,
    );
    stop();
    document.body.dispatchEvent(key({ ctrlKey: true, key: "s" }));
    expect(posts).toEqual([]);
  });
});

describe("Escape guard during a flow-3 drag (cancel single-source)", () => {
  afterEach(() => {
    clearIframeDrag();
  });

  test("Escape during an iframe-originated drag cancels LOCALLY and does NOT forward", () => {
    const posts: IframeToParent[] = [];
    let cancelled = 0;
    // Mark a flow-3 drag active with its local cancel hook (what the entry installs).
    beginIframeDrag(() => {
      cancelled += 1;
    });
    const stop = startKeyForwarding(
      { post: (m: IframeToParent) => posts.push(m) } as never,
      document,
    );
    const e = key({ key: "Escape" });
    document.body.dispatchEvent(e);
    // Local cancel ran; nothing forwarded (single source — no double-fire with the parent).
    expect(cancelled).toBe(1);
    expect(isDragActive()).toBe(false);
    expect(posts.find((p) => p.kind === "forwardKey")).toBeUndefined();
    expect(e.defaultPrevented).toBe(true);
    stop();
  });

  test("Escape with no active drag forwards normally", () => {
    const posts: IframeToParent[] = [];
    const stop = startKeyForwarding(
      { post: (m: IframeToParent) => posts.push(m) } as never,
      document,
    );
    document.body.dispatchEvent(key({ key: "Escape" }));
    expect(posts.find((p) => p.kind === "forwardKey")).toBeTruthy();
    stop();
  });
});
