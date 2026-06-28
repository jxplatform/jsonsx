/**
 * In-iframe inline editing — runs the contenteditable session inside the canvas iframe and posts
 * the serializable results to the parent. Verifies the dblclick trigger, editStart/editCommit
 * posting, `enterEdit` re-entry, the non-editable guard, and teardown.
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { startIframeInlineEdit } from "../src/canvas/iframe-inline-edit";
import { isEditing, stopEditing } from "../src/editor/inline-edit";
import { serializeJxPath } from "../src/canvas/path-mapping";
import type { IframeToParent, ParentToIframe } from "../src/canvas/iframe-protocol";

function fakeChannel() {
  const posts: IframeToParent[] = [];
  let handler: ((m: ParentToIframe) => void) | null = null;
  const channel = {
    dispose() {
      // Unused by these tests.
    },
    onMessage(h: (m: ParentToIframe) => void) {
      handler = h;
      return () => {
        handler = null;
      };
    },
    post(m: IframeToParent) {
      posts.push(m);
    },
  } as never;
  return { channel, deliver: (m: ParentToIframe) => handler?.(m), posts };
}

function editableContainer(tag = "p") {
  const container = document.createElement("div");
  const el = document.createElement(tag);
  el.dataset.jxPath = serializeJxPath(["children", 0]);
  el.textContent = "Hello";
  container.append(el);
  document.body.append(container);
  return { container, el };
}

const dblclick = (el: HTMLElement) =>
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

afterEach(() => {
  if (isEditing()) {
    stopEditing();
  }
  document.body.innerHTML = "";
});

describe("startIframeInlineEdit", () => {
  test("double-click on an editable element starts editing and posts editStart", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    expect(el.isContentEditable).toBe(true);
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 0] });
    stop();
  });

  test("committing the session posts editCommit with the serialized content", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    el.textContent = "Edited";
    stopEditing();

    expect(posts).toContainEqual({
      children: null,
      kind: "editCommit",
      path: ["children", 0],
      textContent: "Edited",
    });
    stop();
  });

  test("an enterEdit message re-enters editing on the given path", () => {
    const { channel, deliver, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    deliver({ kind: "enterEdit", path: ["children", 0] });
    expect(el.isContentEditable).toBe(true);
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 0] });
    stop();
  });

  test("double-click on a non-editable element does nothing", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer("div"); // <div> is not an editable block.
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    expect(posts).toEqual([]);
    expect(isEditing()).toBe(false);
    stop();
  });

  test("teardown removes the listener and stops an active session", () => {
    const { channel } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    expect(isEditing()).toBe(true);
    stop();
    expect(isEditing()).toBe(false);
  });
});
