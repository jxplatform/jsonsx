/**
 * In-iframe keyboard forwarding — decides which keystrokes belong to the editor's global shortcuts,
 * flattens them for the bridge, and forwards them (preventing the browser default) so studio
 * shortcuts keep working when focus is inside the canvas iframe.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { serializeKey, shouldForwardKey, startKeyForwarding } from "../src/canvas/iframe-keys";
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

describe("shouldForwardKey — with a caret in the canvas", () => {
  /** A keydown whose target is inside the canvas editing host. */
  function inEditable(init: KeyboardEventInit): KeyboardEvent {
    const host = document.createElement("div");
    host.contentEditable = "true";
    const p = document.createElement("p");
    host.append(p);
    document.body.append(host);
    const e = key(init);
    p.dispatchEvent(e);
    return e;
  }

  test("app chords STILL forward while the caret is in text", () => {
    // The canvas is a persistent contenteditable, so gating purely on "target is editable" would
    // Mean ⌘S/⌘Z never reached the parent while writing — which is exactly the save-loses-your-
    // Last-word bug.
    expect(shouldForwardKey(inEditable({ key: "s", metaKey: true }))).toBe(true);
    expect(shouldForwardKey(inEditable({ ctrlKey: true, key: "z" }))).toBe(true);
    expect(shouldForwardKey(inEditable({ key: "d", metaKey: true }))).toBe(true);
  });

  test("the inline-formatting chords stay with the editing engine", () => {
    for (const k of ["b", "i", "u", "`"]) {
      expect(shouldForwardKey(inEditable({ key: k, metaKey: true }))).toBe(false);
    }
    // Case-insensitively — a shifted chord is the same command.
    expect(shouldForwardKey(inEditable({ key: "B", metaKey: true, shiftKey: true }))).toBe(false);
  });

  test("bare editing keys belong to the caret, not to structural selection", () => {
    for (const k of ["Backspace", "Delete", "Enter", "ArrowUp", "ArrowLeft"]) {
      expect(shouldForwardKey(inEditable({ key: k }))).toBe(false);
    }
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
