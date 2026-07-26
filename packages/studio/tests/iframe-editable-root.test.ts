/**
 * The canvas editing host — activation derived from the caret, the `beforeinput` chokepoint, and
 * caret capture/restore in model coordinates.
 *
 * Driven directly through a fake deps bag rather than through the bridge, so each contract is
 * asserted in isolation. What happy-dom CANNOT model is asserted in the browser instead: caret
 * placement from a click point, line-wrap-aware Up/Down, and `getTargetRanges()` (absent here, so
 * the host falls back to the live selection — which is why every test places a caret first).
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import {
  captureDocSelection,
  restoreDocSelection,
  startEditableRoot,
} from "../src/canvas/iframe-editable-root";
import { beforeInput, caretAt, caretInto, selectAcross } from "./harness";
import type { EditableRootDeps, EditableRootHandle } from "../src/canvas/iframe-editable-root";
import type { DocPos, EditablePredicate } from "../src/canvas/iframe-position";

const EDITABLE: EditablePredicate = (el) => ["h2", "li", "p"].includes(el.tagName.toLowerCase());

interface Recorded {
  activated: { tag: string; path: unknown }[];
  deactivated: number;
  selectionChanges: number;
  props: string[];
  splits: number;
  mergeBackward: DocPos[];
  mergeForward: DocPos[];
  replaced: { from: DocPos; to: DocPos; text: string }[];
}

let live: EditableRootHandle | null = null;

/** Mount `html` in a container and wire an editing host over it with recording deps. */
function mount(html: string, overrides: Partial<EditableRootDeps> = {}) {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);

  const rec: Recorded = {
    activated: [],
    deactivated: 0,
    mergeBackward: [],
    mergeForward: [],
    props: [],
    replaced: [],
    selectionChanges: 0,
    splits: 0,
  };
  const root = startEditableRoot(container, {
    isEditableBlock: EDITABLE,
    onActivate: (el, path) => rec.activated.push({ path, tag: el.tagName.toLowerCase() }),
    onDeactivate: () => {
      rec.deactivated += 1;
    },
    onSelectionChange: () => {
      rec.selectionChanges += 1;
    },
    ...overrides,
  });
  live = root;
  return { container, rec, root };
}

afterEach(() => {
  live?.stop();
  live = null;
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

const TWO_BLOCKS = `<p data-jx-path='["children",0]'>First block</p><p data-jx-path='["children",1]'>Second</p>`;

describe("activation follows the caret", () => {
  test("a caret landing in a block activates it — there is no gesture to recognise", () => {
    const { container, rec } = mount(TWO_BLOCKS);
    caretInto(container.querySelector("p") as HTMLElement, 3);
    expect(rec.activated).toEqual([{ path: ["children", 0], tag: "p" }]);
    expect(rec.deactivated).toBe(0);
  });

  test("moving within the block reports a selection change, not a re-activation", () => {
    const { container, rec } = mount(TWO_BLOCKS);
    const p = container.querySelector("p") as HTMLElement;
    caretInto(p, 1);
    const before = rec.selectionChanges;
    caretInto(p, 5);
    expect(rec.activated).toHaveLength(1);
    expect(rec.deactivated).toBe(0);
    expect(rec.selectionChanges).toBeGreaterThan(before);
  });

  test("moving to another block releases the first BEFORE activating the second", () => {
    // Order is the contract: releasing is what commits, so it has to happen while the old block is
    // Still the active one.
    const order: string[] = [];
    const { container } = mount(TWO_BLOCKS, {
      onActivate: (_el, path) => order.push(`activate:${JSON.stringify(path)}`),
      onDeactivate: () => order.push("deactivate"),
    });
    const [first, second] = [...container.querySelectorAll("p")] as HTMLElement[];
    caretInto(first!, 2);
    caretInto(second!, 2);
    expect(order).toEqual(['activate:["children",0]', "deactivate", 'activate:["children",1]']);
  });

  test("a caret in canvas chrome releases the active block", () => {
    const { container, rec } = mount(`${TWO_BLOCKS}<div>chrome</div>`);
    caretInto(container.querySelector("p") as HTMLElement, 1);
    caretInto(container.querySelector("div") as HTMLElement);
    expect(rec.deactivated).toBe(1);
  });

  test("a caret outside the container releases the active block", () => {
    const { container, rec } = mount(TWO_BLOCKS);
    caretInto(container.querySelector("p") as HTMLElement, 1);
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.append(outside);
    caretInto(outside, 2);
    expect(rec.deactivated).toBe(1);
  });

  test("an ABSENT selection is transient and does NOT release the block", () => {
    // A re-render, a removeAllRanges, or the window losing focus all momentarily empty the
    // Selection. Committing and dropping the block there would lose the caret mid-typing.
    const { container, rec } = mount(TWO_BLOCKS);
    caretInto(container.querySelector("p") as HTMLElement, 1);
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(rec.deactivated).toBe(0);
  });

  test("no caret exists outside design/edit modes", () => {
    const { container, rec } = mount(TWO_BLOCKS, { getMode: () => "preview" });
    caretInto(container.querySelector("p") as HTMLElement, 1);
    expect(rec.activated).toHaveLength(0);
  });

  test("leaving edit mode with a live block releases it", () => {
    let mode = "edit";
    const { container, rec } = mount(TWO_BLOCKS, { getMode: () => mode });
    caretInto(container.querySelector("p") as HTMLElement, 1);
    mode = "preview";
    document.dispatchEvent(new Event("selectionchange"));
    expect(rec.deactivated).toBe(1);
  });

  test("stop() releases the active block", () => {
    const { container, rec, root } = mount(TWO_BLOCKS);
    caretInto(container.querySelector("p") as HTMLElement, 1);
    root.stop();
    live = null;
    expect(rec.deactivated).toBe(1);
  });
});

describe("prop-bound nested hosts", () => {
  const WITH_PROP = `<p data-jx-path='["children",0]'>Page</p><x-card data-jx-path='["children",1]' contenteditable="false"><span data-jx-bound-prop="title">Card</span></x-card>`;

  test("a pointerdown on a marker asks the bridge to open a nested host", () => {
    const { container, rec } = mount(WITH_PROP, {
      onPropActivate: (el) => {
        rec.props.push(el.dataset.jxBoundProp!);
        return true;
      },
    });
    const marker = container.querySelector("[data-jx-bound-prop]") as HTMLElement;
    marker.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(rec.props).toEqual(["title"]);
  });

  test("an adopted nested host is NOT torn down by its own first selectionchange", () => {
    // The marker has no `data-jx-path`, so a naive block lookup would find nothing and deactivate
    // The host the instant the caret arrived in it.
    const { container, rec } = mount(WITH_PROP, { onPropActivate: () => true });
    const marker = container.querySelector("[data-jx-bound-prop]") as HTMLElement;
    marker.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    caretInto(marker, 2);
    expect(rec.deactivated).toBe(0);
  });

  test("a REFUSED marker is not adopted, so the caret does not linger in it", () => {
    const { container, rec } = mount(WITH_PROP, { onPropActivate: () => false });
    const marker = container.querySelector("[data-jx-bound-prop]") as HTMLElement;
    marker.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    caretInto(marker, 2);
    expect(rec.activated).toHaveLength(0);
  });

  test("a pointerdown on ordinary page DOM never reaches the prop path", () => {
    const { container, rec } = mount(WITH_PROP, {
      onPropActivate: (el) => {
        rec.props.push(el.dataset.jxBoundProp!);
        return true;
      },
    });
    (container.querySelector("p") as HTMLElement).dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    expect(rec.props).toEqual([]);
  });

  test("leaving the nested host for a page block releases it", () => {
    const { container, rec } = mount(WITH_PROP, { onPropActivate: () => true });
    const marker = container.querySelector("[data-jx-bound-prop]") as HTMLElement;
    marker.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    caretInto(container.querySelector("p") as HTMLElement, 1);
    expect(rec.deactivated).toBe(1);
    expect(rec.activated).toEqual([{ path: ["children", 0], tag: "p" }]);
  });
});

describe("the beforeinput chokepoint", () => {
  test("ordinary typing runs natively", () => {
    const { container } = mount(TWO_BLOCKS);
    const p = container.querySelector("p") as HTMLElement;
    caretInto(p, 3);
    expect(beforeInput(p, "insertText", "x")).toBe(false);
  });

  test("Enter is prevented and routed to the split handler", () => {
    const { container, rec } = mount(TWO_BLOCKS, {
      onSplit: () => {
        rec.splits += 1;
        return true;
      },
    });
    const p = container.querySelector("p") as HTMLElement;
    caretInto(p, 3);
    expect(beforeInput(p, "insertParagraph")).toBe(true);
    expect(rec.splits).toBe(1);
  });

  test("Backspace at a block start routes to the merge handler with the position", () => {
    const { container, rec } = mount(TWO_BLOCKS, {
      onMergeBackward: (at) => {
        rec.mergeBackward.push(at);
        return true;
      },
    });
    const second = [...container.querySelectorAll("p")][1] as HTMLElement;
    caretInto(second, 0);
    expect(beforeInput(second, "deleteContentBackward")).toBe(true);
    expect(rec.mergeBackward).toEqual([{ offset: 0, path: ["children", 1] }]);
  });

  test("Delete at a block end routes to the forward-merge handler", () => {
    const { container, rec } = mount(TWO_BLOCKS, {
      onMergeForward: (at) => {
        rec.mergeForward.push(at);
        return true;
      },
    });
    const p = container.querySelector("p") as HTMLElement;
    caretInto(p, "First block".length);
    expect(beforeInput(p, "deleteContentForward")).toBe(true);
    expect(rec.mergeForward).toHaveLength(1);
  });

  test("a cross-block deletion routes to the range handler", () => {
    const { container, rec } = mount(TWO_BLOCKS, {
      onReplaceRange: (from, to, text) => {
        rec.replaced.push({ from, text, to });
        return true;
      },
    });
    const [first, second] = [...container.querySelectorAll("p")] as HTMLElement[];
    selectAcross(first!.firstChild!, 2, second!.firstChild!, 3);
    expect(beforeInput(first!, "deleteContentBackward")).toBe(true);
    expect(rec.replaced).toEqual([
      {
        from: { offset: 2, path: ["children", 0] },
        text: "",
        to: { offset: 3, path: ["children", 1] },
      },
    ]);
  });

  test("an ABSENT handler suppresses the action instead of letting the browser restructure", () => {
    // The load-bearing default: an unimplemented merge must leave the document untouched, never
    // Silently let contenteditable join two blocks behind the model's back.
    const { container, rec } = mount(TWO_BLOCKS); // No structural handlers wired.
    const second = [...container.querySelectorAll("p")][1] as HTMLElement;
    caretInto(second, 0);
    expect(beforeInput(second, "deleteContentBackward")).toBe(true);
    expect(rec.mergeBackward).toHaveLength(0);
  });

  test("a cross-block Enter is suppressed when there is no range handler to delete with", () => {
    const { container, rec } = mount(TWO_BLOCKS, {
      onSplit: () => {
        rec.splits += 1;
        return true;
      },
    });
    const [first, second] = [...container.querySelectorAll("p")] as HTMLElement[];
    selectAcross(first!.firstChild!, 2, second!.firstChild!, 3);
    expect(beforeInput(first!, "insertParagraph")).toBe(true);
    expect(rec.splits).toBe(0);
  });

  test("native formatting and history are refused", () => {
    const { container } = mount(TWO_BLOCKS);
    const p = container.querySelector("p") as HTMLElement;
    caretInto(p, 3);
    expect(beforeInput(p, "formatBold")).toBe(true);
    expect(beforeInput(p, "historyUndo")).toBe(true);
  });

  test("input with no resolvable position is refused", () => {
    const { container } = mount(`${TWO_BLOCKS}<div>chrome</div>`);
    const chrome = container.querySelector("div") as HTMLElement;
    caretInto(chrome);
    expect(beforeInput(chrome, "insertText", "x")).toBe(true);
  });

  test("beforeinput is inert outside design/edit modes", () => {
    const { container } = mount(TWO_BLOCKS, { getMode: () => "preview" });
    const p = container.querySelector("p") as HTMLElement;
    expect(beforeInput(p, "insertParagraph")).toBe(false);
  });
});

describe("drag suppression", () => {
  test("a dragstart inside the canvas is cancelled — reordering is the bar's handle", () => {
    const { container } = mount(TWO_BLOCKS);
    const p = container.querySelector("p") as HTMLElement;
    const e = new Event("dragstart", { bubbles: true, cancelable: true });
    p.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("caret capture and restore", () => {
  test("captureDocSelection returns both endpoints in document coordinates", () => {
    const { container } = mount(TWO_BLOCKS);
    const [first, second] = [...container.querySelectorAll("p")] as HTMLElement[];
    selectAcross(first!.firstChild!, 2, second!.firstChild!, 4);
    expect(captureDocSelection(container, EDITABLE)).toEqual({
      anchor: { offset: 2, path: ["children", 0] },
      head: { offset: 4, path: ["children", 1] },
    });
  });

  test("captureDocSelection returns null with no selection, or one outside the canvas", () => {
    const { container } = mount(TWO_BLOCKS);
    window.getSelection()!.removeAllRanges();
    expect(captureDocSelection(container, EDITABLE)).toBeNull();

    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.append(outside);
    caretInto(outside, 1);
    expect(captureDocSelection(container, EDITABLE)).toBeNull();
  });

  test("captureDocSelection returns null when an endpoint is not in an editable block", () => {
    const { container } = mount(`${TWO_BLOCKS}<div>chrome</div>`);
    caretInto(container.querySelector("div") as HTMLElement);
    expect(captureDocSelection(container, EDITABLE)).toBeNull();
  });

  test("a captured selection round-trips through restore", () => {
    const { container } = mount(TWO_BLOCKS);
    const [first, second] = [...container.querySelectorAll("p")] as HTMLElement[];
    selectAcross(first!.firstChild!, 2, second!.firstChild!, 4);
    const captured = captureDocSelection(container, EDITABLE)!;

    window.getSelection()!.removeAllRanges();
    expect(restoreDocSelection(container, captured)).toBe(true);
    expect(captureDocSelection(container, EDITABLE)).toEqual(captured);
  });

  test("restore fails when the anchor's block no longer renders", () => {
    const { container } = mount(TWO_BLOCKS);
    const gone = { anchor: { offset: 0, path: ["children", 9] }, head: { offset: 0, path: [] } };
    expect(restoreDocSelection(container, gone)).toBe(false);
  });

  test("placeCaret puts the caret in a block and activates it in the same call", () => {
    // Synchronous activation matters: `selectionchange` is dispatched as a task, so a caller that
    // Needs the block live before it returns (the parent's post-split enterEdit) cannot wait for it.
    const { container, rec } = mount(TWO_BLOCKS);
    expect(container).toBeTruthy();
    expect(live!.placeCaret({ offset: 3, path: ["children", 1] })).toBe(true);
    expect(rec.activated).toEqual([{ path: ["children", 1], tag: "p" }]);
  });

  test("placeCaret reports false for a path that is not rendered", () => {
    mount(TWO_BLOCKS);
    expect(live!.placeCaret({ offset: 0, path: ["children", 42] })).toBe(false);
  });

  test("the handle's capture/restore pair survives a re-render of the block's DOM", () => {
    const { container, rec } = mount(TWO_BLOCKS);
    const first = container.querySelector("p") as HTMLElement;
    caretInto(first, 5);
    const captured = live!.capture();
    expect(captured).toEqual({
      anchor: { offset: 5, path: ["children", 0] },
      head: { offset: 5, path: ["children", 0] },
    });

    // The patcher replaces the block's inner DOM, destroying the original text node.
    first.replaceChildren(document.createTextNode("First block"));
    expect(live!.restore(captured!)).toBe(true);
    expect(live!.capture()).toEqual(captured);
    expect(rec.deactivated).toBe(0);
  });

  test("sync() re-derives the active block after a programmatic selection move", () => {
    const { container, rec } = mount(TWO_BLOCKS);
    const second = [...container.querySelectorAll("p")][1] as HTMLElement;
    // Move the selection WITHOUT dispatching the event the browser would.
    caretAt(second.firstChild!, 2);
    rec.activated.length = 0;
    live!.sync();
    expect(rec.activated).toHaveLength(0); // Already active from the caretAt dispatch.
    expect(rec.deactivated).toBe(0);
  });
});
