/**
 * Gap tests for src/editor/inline-edit.ts — rich-text commit conversion, formatting shortcuts,
 * paste/blur handling, and the slash-menu lifecycle (open/filter/select/dismiss).
 *
 * Inline-format is mocked so the ctrl+b/i/` shortcuts can be asserted directly;
 * normalizeInlineContent becomes a no-op, which leaves elementToJx output unchanged.
 */
import "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { JxMutableNode } from "@jxsuite/schema/types";

const toggleInlineFormat = mock((_tag: string, _el: unknown) => {});
void mock.module("../src/editor/inline-format.js", () => ({
  normalizeInlineContent: () => {},
  toggleInlineFormat,
}));

const {
  getActiveElement,
  isEditing,
  setSlashController,
  splitActiveBlock,
  startEditing,
  stopEditing,
} = await import("../src/editor/inline-edit");
const { dismissSlashMenu, isSlashMenuOpen, showSlashMenu } =
  await import("../src/editor/slash-menu");
// Inline-edit no longer hard-imports the slash menu (kept out of the slim iframe bundle) — wire the
// Real one here so the slash-command lifecycle tests drive it.
setSlashController({ dismiss: dismissSlashMenu, isOpen: isSlashMenuOpen, show: showSlashMenu });

// ─── Environment ──────────────────────────────────────────────────────────────

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

const execCommand = mock((_cmd: string, _ui?: boolean, _value?: string) => true);
(document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;

async function flush(turns = 2) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

interface CommitArgs {
  path: unknown;
  children: (JxMutableNode | string)[] | null;
  textContent: string | null;
}
interface InsertArgs {
  path: unknown;
  cmd: { tag: string };
  commitData: unknown;
}
interface SplitArgs {
  path: unknown;
  before: unknown;
  after: unknown;
}

let el: HTMLElement;
let commits: CommitArgs[];
let inserts: InsertArgs[];
let splits: SplitArgs[];
let endCount: number;

function edit(target: HTMLElement = el, path: (string | number)[] = ["children", 0]) {
  startEditing(target, path, {
    onCommit: (p, children, textContent) => commits.push({ children, path: p, textContent }),
    onEnd: () => {
      endCount += 1;
    },
    onInsert: (p, cmd, commitData) => inserts.push({ cmd, commitData, path: p }),
    onSplit: (p, before, after) => splits.push({ after, before, path: p }),
  });
}

function caretAt(node: Node, offset: number) {
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function keydown(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }),
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  el = document.createElement("p");
  el.textContent = "Hello";
  document.body.append(el);
  commits = [];
  inserts = [];
  splits = [];
  endCount = 0;
  toggleInlineFormat.mockClear();
  execCommand.mockClear();
});

afterEach(() => {
  if (isEditing()) {
    stopEditing();
  }
  dismissSlashMenu();
});

// ─── Commit conversion (elementToJx / domNodeToJx) ────────────────────────────

describe("commit conversion", () => {
  function commitWith(innerHTML: string) {
    edit();
    el.innerHTML = innerHTML;
    stopEditing();
    return commits[0];
  }

  test("empty element commits empty textContent", () => {
    const c = commitWith("");
    expect(c!.textContent).toBe("");
    expect(c!.children).toBeNull();
  });

  test("single text node commits as textContent", () => {
    const c = commitWith("plain words");
    expect(c!.textContent).toBe("plain words");
  });

  test("mixed content commits as children", () => {
    const c = commitWith("a<strong>x</strong>c");
    expect(c!.children).toEqual(["a", { tagName: "strong", textContent: "x" }, "c"]);
  });

  test("legacy formatting tags are mapped to semantic equivalents", () => {
    const c = commitWith("<b>b</b><i>i</i><s>s</s> t");
    expect(c!.children).toEqual([
      { tagName: "strong", textContent: "b" },
      { tagName: "em", textContent: "i" },
      { tagName: "del", textContent: "s" },
      " t",
    ]);
  });

  test("anchor href and title are preserved", () => {
    const c = commitWith('<a href="/docs" title="Docs">link</a> tail');
    const a = c!.children![0] as JxMutableNode;
    expect(a.tagName).toBe("a");
    expect(a.attributes).toEqual({ href: "/docs", title: "Docs" });
    expect(a.textContent).toBe("link");
  });

  test("code elements keep only their text", () => {
    const c = commitWith("<code>let <b>x</b></code> w");
    expect(c!.children![0]).toEqual({ tagName: "code", textContent: "let x" });
  });

  test("nested inline elements recurse into children", () => {
    const c = commitWith("<strong>a<em>b</em></strong>x");
    expect(c!.children![0]).toEqual({
      children: ["a", { tagName: "em", textContent: "b" }],
      tagName: "strong",
    });
  });

  test("empty inline element commits empty textContent", () => {
    const c = commitWith("<span></span>x");
    expect(c!.children![0]).toEqual({ tagName: "span", textContent: "" });
  });

  test("comment nodes are dropped and split text is merged", () => {
    const c = commitWith("x<!--note-->y");
    expect(c!.textContent).toBe("xy");
    expect(c!.children).toBeNull();
  });
});

// ─── Formatting shortcuts, paste, blur ────────────────────────────────────────

describe("editing interactions", () => {
  test("ctrl+b / ctrl+i / ctrl+` toggle inline formats", () => {
    edit();
    keydown(el, "b", { ctrlKey: true });
    keydown(el, "i", { ctrlKey: true });
    keydown(el, "`", { ctrlKey: true });
    expect(toggleInlineFormat.mock.calls.map((c) => c[0])).toEqual(["strong", "em", "code"]);
    expect(toggleInlineFormat.mock.calls[0]![1]).toBe(el);
  });

  test("other ctrl keys do not toggle formats", () => {
    edit();
    keydown(el, "k", { ctrlKey: true });
    expect(toggleInlineFormat).not.toHaveBeenCalled();
  });

  test("paste inserts plain text via execCommand", () => {
    edit();
    const e = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(e, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "pasted!" : "") },
    });
    el.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "pasted!");
  });

  test("a blur does NOT end the block — the editing host outlives focus changes", async () => {
    // The parent's format toolbar takes focus across the frame boundary on every click; tearing the
    // Block down on blur is what used to make the toolbar unusable.
    edit();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    el.dispatchEvent(new FocusEvent("blur"));
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    expect(isEditing()).toBe(true);
    expect(endCount).toBe(0);
    other.remove();
  });

  test("paste without clipboard data inserts an empty string", () => {
    edit();
    const e = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    el.dispatchEvent(e);
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "");
  });
});

// ─── Enter / split ────────────────────────────────────────────────────────────

// Enter reaches the engine through the editing host's `beforeinput` chokepoint, which calls
// SplitActiveBlock — the keydown path is gone.
describe("splitActiveBlock guards", () => {
  test("returns false with no active block", () => {
    expect(splitActiveBlock()).toBe(false);
    expect(splits).toHaveLength(0);
  });

  test("returns false when there is no live selection to split at", () => {
    edit();
    window.getSelection()?.removeAllRanges();
    expect(splitActiveBlock()).toBe(false);
    expect(splits).toHaveLength(0);
  });

  test("a split releases the block WITHOUT committing it", () => {
    // The split writes both halves itself; a commit racing it would re-apply the pre-split text
    // Over the first half.
    edit();
    caretAt(el.firstChild!, 2);
    expect(splitActiveBlock()).toBe(true);
    expect(commits).toHaveLength(0);
    expect(isEditing()).toBe(false);
    expect(endCount).toBe(1);
  });
});

describe("splitActiveBlock", () => {
  test("split passes before and after content and ends editing", async () => {
    edit();
    caretAt(el.firstChild!, 2);
    splitActiveBlock();
    expect(splits.length).toBe(1);
    expect(splits[0]!.path).toEqual(["children", 0]);
    expect(splits[0]!.before).toEqual({ textContent: "He" });
    expect(splits[0]!.after).toEqual({ textContent: "llo" });
    expect(isEditing()).toBe(false);
    expect(endCount).toBe(1);
    expect(getActiveElement()).toBeNull();
  });

  test("split before an inline element keeps it in the after fragment", () => {
    el.innerHTML = "ab<em>cd</em>";
    edit();
    caretAt(el.firstChild!, 2); // End of "ab"
    splitActiveBlock();
    expect(splits[0]!.before).toEqual({ textContent: "ab" });
    expect(splits[0]!.after).toEqual({
      children: [{ tagName: "em", textContent: "cd" }],
    });
  });

  test("a lone span in the after fragment unwraps to text", () => {
    el.innerHTML = "ab<span>cd</span>";
    edit();
    caretAt(el.firstChild!, 2);
    splitActiveBlock();
    expect(splits[0]!.after).toEqual({ textContent: "cd" });
  });

  test("shift+Enter does not split", () => {
    edit();
    keydown(el, "Enter", { shiftKey: true });
    expect(splits.length).toBe(0);
    expect(isEditing()).toBe(true);
  });
});

// ─── Slash menu lifecycle ─────────────────────────────────────────────────────

describe("slash menu", () => {
  test("/ at the start of an empty block opens the menu", async () => {
    el.textContent = "";
    edit();
    caretAt(el, 0);
    keydown(el, "/");
    await flush();
    expect(isSlashMenuOpen()).toBe(true);
  });

  test("/ after a space opens the menu", async () => {
    el.textContent = "word ";
    edit();
    caretAt(el.firstChild!, 5);
    keydown(el, "/");
    await flush();
    expect(isSlashMenuOpen()).toBe(true);
  });

  test("/ mid-word does not open the menu", async () => {
    edit();
    caretAt(el.firstChild!, 3);
    keydown(el, "/");
    await flush();
    expect(isSlashMenuOpen()).toBe(false);
  });

  test("typing after the slash filters the menu", async () => {
    el.textContent = "";
    edit();
    caretAt(el, 0);
    keydown(el, "/");
    await flush();

    el.textContent = "/he";
    caretAt(el.firstChild!, 3);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    const items = document.querySelectorAll("sp-menu-item");
    expect(items.length).toBe(3); // Heading 1/2/3
  });

  test("deleting back past the slash dismisses the menu", async () => {
    el.textContent = "";
    edit();
    caretAt(el, 0);
    keydown(el, "/");
    await flush();
    expect(isSlashMenuOpen()).toBe(true);

    el.textContent = "x";
    caretAt(el.firstChild!, 1);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    expect(isSlashMenuOpen()).toBe(false);
  });

  test("selecting a command strips the /filter text and reports commit data", async () => {
    el.textContent = "intro ";
    edit();
    caretAt(el.firstChild!, 6);
    keydown(el, "/");
    await flush();

    el.textContent = "intro /hea";
    caretAt(el.firstChild!, 10);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    expect(isSlashMenuOpen()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    expect(inserts.length).toBe(1);
    expect(inserts[0]!.cmd.tag).toBe("h1");
    expect(inserts[0]!.path).toEqual(["children", 0]);
    expect(inserts[0]!.commitData).toEqual({ textContent: "intro " });
    expect(el.textContent).toBe("intro ");
    expect(isEditing()).toBe(false);
    expect(endCount).toBe(1);
    expect(isSlashMenuOpen()).toBe(false);
  });

  test("Escape dismisses the menu but keeps editing active", async () => {
    el.textContent = "";
    edit();
    caretAt(el, 0);
    keydown(el, "/");
    await flush();

    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(isSlashMenuOpen()).toBe(false);
    expect(isEditing()).toBe(true);
  });
});
