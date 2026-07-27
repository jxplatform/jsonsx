/**
 * Inline editing with NO slash controller wired.
 *
 * The engine takes its slash menu by injection so the slim canvas-iframe bundle does not have to
 * pull in lit-html and `ui/layers` (see the module docstring on `setSlashController`). That means
 * the default no-op controller is a real shipping code path — a realm that never injects one must
 * still edit, commit, and ignore the `/` trigger rather than throw.
 *
 * This file deliberately never calls `setSlashController`: the controller is module-global, so any
 * file that injects one can never exercise the default.
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import {
  getActiveElement,
  isEditing,
  isSlashActive,
  startEditing,
  stopEditing,
} from "../src/editor/inline-edit";
import { caretAt } from "./harness";

// The slash trigger defers its menu open to the next frame.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

let el: HTMLElement;
const commits: { textContent: string | null }[] = [];

function edit(text = "Hello") {
  el = document.createElement("p");
  el.textContent = text;
  document.body.append(el);
  startEditing(el, ["children", 0], {
    onCommit: (_p, _children, textContent) => commits.push({ textContent }),
    onEnd: () => {},
    onInsert: () => {},
    onSplit: () => {},
  });
}

afterEach(() => {
  if (isEditing()) {
    stopEditing();
  }
  commits.length = 0;
  document.body.innerHTML = "";
});

describe("the default (no-op) slash controller", () => {
  test("reports itself closed", () => {
    edit();
    expect(isSlashActive()).toBe(false);
  });

  test("a `/` at the start of a block is typed as an ordinary character, opening nothing", async () => {
    edit("");
    caretAt(el, 0);
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "/" }));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(isSlashActive()).toBe(false);
    expect(isEditing()).toBe(true);
    expect(getActiveElement()).toBe(el);
  });

  test("an input event with no menu open is inert", () => {
    edit();
    el.dispatchEvent(new Event("input", { bubbles: true }));
    expect(isEditing()).toBe(true);
  });

  test("stopEditing still commits and dismisses cleanly", () => {
    edit();
    el.textContent = "Edited";
    stopEditing();
    expect(commits).toEqual([{ textContent: "Edited" }]);
    expect(isEditing()).toBe(false);
  });
});
