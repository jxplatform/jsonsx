/**
 * IME composition on the editable canvas.
 *
 * The canvas container is one `contenteditable`, so the browser owns composition — but this host
 * also runs a 500 ms idle commit that reads the DOM and then RESTORES the selection. Landing that
 * inside a composition captures half-formed text and cancels the composition, which is why typing
 * Japanese, Chinese, Korean or Vietnamese was broken. There was no composition handling at all
 * before.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { startEditableRoot } from "../src/canvas/iframe-editable-root";
import type { EditableRootHandle } from "../src/canvas/iframe-editable-root";

let container: HTMLElement;
let handle: EditableRootHandle | null = null;
const onCommitTick = mock(() => {});

/** Put the caret inside the block so the host has an active element (commits require one). */
function placeCaretInBlock() {
  const block = container.querySelector("p") as HTMLElement;
  const text = block.firstChild!;
  const range = document.createRange();
  range.setStart(text, 2);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  handle!.sync();
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

beforeEach(() => {
  onCommitTick.mockClear();
  document.body.innerHTML = `<div id="root"><p data-jx-path='["children",0]'>hello</p></div>`;
  container = document.querySelector("#root") as HTMLElement;
  container.contentEditable = "true";
  handle = startEditableRoot(container, {
    commitDelayMs: 10,
    isEditableBlock: (el) => el.tagName === "P",
    onActivate: () => {},
    onCommitTick,
    onDeactivate: () => {},
  });
});

afterEach(() => {
  handle?.stop();
  handle = null;
});

describe("composition suspends the idle commit", () => {
  test("no commit fires while a composition is open, however long it runs", async () => {
    placeCaretInBlock();
    container.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    // Keystrokes during composition arrive as `input`, which normally re-arms the tick.
    container.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(40);
    container.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(40);
    expect(handle!.isComposing()).toBe(true);
    expect(onCommitTick).not.toHaveBeenCalled();
  });

  test("a tick already armed before the composition does not fire inside it", async () => {
    placeCaretInBlock();
    container.dispatchEvent(new Event("input", { bubbles: true }));
    // Composition opens before the 10 ms tick would have fired.
    container.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    await wait(40);
    expect(onCommitTick).not.toHaveBeenCalled();
  });

  test("exactly one commit runs for the whole composed run", async () => {
    placeCaretInBlock();
    container.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    for (let i = 0; i < 5; i++) {
      container.dispatchEvent(new Event("input", { bubbles: true }));
    }
    container.dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(handle!.isComposing()).toBe(false);
    await wait(40);
    expect(onCommitTick).toHaveBeenCalledTimes(1);
  });

  test("ordinary typing is unaffected — the tick still fires", async () => {
    placeCaretInBlock();
    container.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(40);
    expect(onCommitTick).toHaveBeenCalledTimes(1);
  });
});

describe("flush", () => {
  test("does not commit mid-composition (it would cancel the composition)", async () => {
    placeCaretInBlock();
    container.dispatchEvent(new Event("input", { bubbles: true }));
    container.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    handle!.flush();
    expect(onCommitTick).not.toHaveBeenCalled();
    // And the composition's own end still commits it, so nothing is lost.
    container.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await wait(40);
    expect(onCommitTick).toHaveBeenCalledTimes(1);
  });

  test("commits a pending tick when no composition is open", () => {
    placeCaretInBlock();
    container.dispatchEvent(new Event("input", { bubbles: true }));
    handle!.flush();
    expect(onCommitTick).toHaveBeenCalledTimes(1);
  });
});

describe("teardown", () => {
  test("stop() detaches the composition listeners", () => {
    placeCaretInBlock();
    handle!.stop();
    container.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    // The handle is torn down; a stray composition event must not resurrect its state.
    expect(handle!.isComposing()).toBe(false);
  });
});
