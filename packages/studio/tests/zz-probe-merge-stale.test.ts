/** TEMPORARY probe — delete after use. */
import "./with-dom.js";
import { afterEach, expect, test } from "bun:test";
import { fakeChannelPair } from "../src/canvas/iframe-channel";
import { startIframeInlineEdit } from "../src/canvas/iframe-inline-edit";
import { getActivePath, isEditing, stopEditing } from "../src/editor/inline-edit";
import { patchDisturbsActiveEdit } from "../src/canvas/iframe-entry";
import { beforeInput, caretInto } from "./harness";
import type { IframeToParent, ParentToIframe } from "../src/canvas/iframe-protocol";
import type { JxDocOp } from "../src/tabs/patch-ops";

let teardown: (() => void) | undefined;

afterEach(() => {
  if (isEditing()) {
    stopEditing();
  }
  teardown?.();
  teardown = undefined;
  document.body.innerHTML = "";
});

test("merge leaves the session active and the disturb path commits at the stale path", () => {
  const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
  const fromIframe: IframeToParent[] = [];
  pair.parent.onMessage((m) => fromIframe.push(m));
  const container = document.createElement("div");
  document.body.append(container);
  teardown = startIframeInlineEdit(pair.iframe, container);

  const texts = ["First", "Second", "Third"];
  const els = texts.map((t, i) => {
    const p = document.createElement("p");
    p.dataset.jxPath = JSON.stringify(["children", i]);
    p.textContent = t;
    container.append(p);
    return p;
  });

  els[1]!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  caretInto(els[1]!, 0);
  pair.flush();
  console.log("entered: isEditing=", isEditing(), "activePath=", JSON.stringify(getActivePath()));

  const prevented = beforeInput(els[1]!, "deleteContentBackward");
  pair.flush();
  console.log(
    "prevented=",
    prevented,
    "merge posted=",
    fromIframe.some((m) => m.kind === "editMerge"),
  );

  console.log(
    "after merge: isEditing=",
    isEditing(),
    "activePath=",
    JSON.stringify(getActivePath()),
  );

  const ops: JxDocOp[] = [
    { key: "textContent", op: "set-key", path: ["children", 0], value: "FirstSecond" },
    { index: 1, op: "remove-child", parentPath: [] },
  ];
  console.log("patchDisturbsActiveEdit=", patchDisturbsActiveEdit(ops));

  fromIframe.length = 0;
  if (isEditing()) {
    stopEditing();
  }
  pair.flush();
  console.log("messages on disturb:", JSON.stringify(fromIframe));
  expect(true).toBe(true);
});
