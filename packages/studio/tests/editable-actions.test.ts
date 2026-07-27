import { describe, expect, test } from "bun:test";
import { classifyBeforeInput } from "../src/canvas/editable-actions";
import type { BeforeInputContext } from "../src/canvas/editable-actions";
import type { DocPos } from "../src/canvas/iframe-position";

// No DOM needed — the classifier is pure policy over resolved model coordinates.

const P0: DocPos = { offset: 0, path: ["children", 0] };
const P0_MID: DocPos = { offset: 3, path: ["children", 0] };
const P0_END: DocPos = { offset: 11, path: ["children", 0] };
const P1_MID: DocPos = { offset: 2, path: ["children", 1] };

/** A collapsed caret at `at`, with the boundary flags a caller would have computed for it. */
function at(
  inputType: string,
  pos: DocPos,
  flags: { atBlockStart?: boolean; atBlockEnd?: boolean; data?: string } = {},
): BeforeInputContext {
  return {
    atBlockEnd: flags.atBlockEnd ?? false,
    atBlockStart: flags.atBlockStart ?? false,
    data: flags.data ?? "",
    from: pos,
    inputType,
    to: pos,
  };
}

/** A non-collapsed range from `from` to `to`. */
function span(
  inputType: string,
  from: DocPos,
  to: DocPos,
  flags: { atBlockStart?: boolean; atBlockEnd?: boolean; data?: string } = {},
): BeforeInputContext {
  return {
    atBlockEnd: flags.atBlockEnd ?? false,
    atBlockStart: flags.atBlockStart ?? false,
    data: flags.data ?? "",
    from,
    inputType,
    to,
  };
}

describe("classifyBeforeInput — never intercepted", () => {
  test("IME composition runs natively (preventing it strands the candidate window)", () => {
    expect(classifyBeforeInput(at("insertCompositionText", P0_MID))).toEqual({ kind: "native" });
    expect(classifyBeforeInput(at("insertFromComposition", P0_MID))).toEqual({ kind: "native" });
  });

  test("composition wins even across a block boundary", () => {
    // The browser never composes across blocks, but the ordering guarantee is what matters: no
    // Later rule may reclassify a composition.
    expect(classifyBeforeInput(span("insertCompositionText", P0_MID, P1_MID))).toEqual({
      kind: "native",
    });
  });
});

describe("classifyBeforeInput — rejected", () => {
  test("native history is refused so transactDoc's op log stays authoritative", () => {
    expect(classifyBeforeInput(at("historyUndo", P0_MID))).toEqual({ kind: "reject" });
    expect(classifyBeforeInput(at("historyRedo", P0_MID))).toEqual({ kind: "reject" });
  });

  test("native formatting is refused so no foreign <b>/<font> reaches the source", () => {
    for (const t of ["formatBold", "formatItalic", "formatUnderline", "formatFontColor"]) {
      expect(classifyBeforeInput(at(t, P0_MID))).toEqual({ kind: "reject" });
    }
  });

  test("text drag-and-drop is refused — reordering is the block bar's drag handle", () => {
    expect(classifyBeforeInput(at("insertFromDrop", P0_MID))).toEqual({ kind: "reject" });
    expect(classifyBeforeInput(at("deleteByDrag", P0_MID))).toEqual({ kind: "reject" });
  });

  test("an unresolvable position is refused", () => {
    expect(
      classifyBeforeInput({
        atBlockEnd: false,
        atBlockStart: false,
        data: "x",
        from: null,
        inputType: "insertText",
        to: null,
      }),
    ).toEqual({ kind: "reject" });
    expect(
      classifyBeforeInput({
        atBlockEnd: false,
        atBlockStart: false,
        data: "x",
        from: P0_MID,
        inputType: "insertText",
        to: null,
      }),
    ).toEqual({ kind: "reject" });
  });

  test("an unrecognised inputType ACROSS blocks is refused rather than guessed at", () => {
    expect(classifyBeforeInput(span("insertHorizontalRule", P0_MID, P1_MID))).toEqual({
      kind: "reject",
    });
  });
});

describe("classifyBeforeInput — split", () => {
  test("Enter on a collapsed caret splits at the caret", () => {
    expect(classifyBeforeInput(at("insertParagraph", P0_MID))).toEqual({
      from: P0_MID,
      kind: "split",
      to: P0_MID,
    });
  });

  test("Enter over a selection carries the range so the executor deletes then splits", () => {
    expect(classifyBeforeInput(span("insertParagraph", P0_MID, P0_END))).toEqual({
      from: P0_MID,
      kind: "split",
      to: P0_END,
    });
  });

  test("Enter over a CROSS-BLOCK selection is still a split, not a range replace", () => {
    expect(classifyBeforeInput(span("insertParagraph", P0_MID, P1_MID))).toEqual({
      from: P0_MID,
      kind: "split",
      to: P1_MID,
    });
  });
});

describe("classifyBeforeInput — boundary merges", () => {
  test("Backspace at block start merges backward", () => {
    expect(classifyBeforeInput(at("deleteContentBackward", P0, { atBlockStart: true }))).toEqual({
      at: P0,
      kind: "mergeBackward",
    });
  });

  test("every backward granularity merges at the start — word, soft line, hard line", () => {
    for (const t of ["deleteWordBackward", "deleteSoftLineBackward", "deleteHardLineBackward"]) {
      expect(classifyBeforeInput(at(t, P0, { atBlockStart: true }))).toEqual({
        at: P0,
        kind: "mergeBackward",
      });
    }
  });

  test("Delete at block end merges forward", () => {
    expect(classifyBeforeInput(at("deleteContentForward", P0_END, { atBlockEnd: true }))).toEqual({
      at: P0_END,
      kind: "mergeForward",
    });
  });

  test("every forward granularity merges at the end", () => {
    for (const t of ["deleteWordForward", "deleteSoftLineForward", "deleteHardLineForward"]) {
      expect(classifyBeforeInput(at(t, P0_END, { atBlockEnd: true }))).toEqual({
        at: P0_END,
        kind: "mergeForward",
      });
    }
  });

  test("Backspace mid-block is native — there is text to eat", () => {
    expect(classifyBeforeInput(at("deleteContentBackward", P0_MID))).toEqual({ kind: "native" });
  });

  test("Delete mid-block is native", () => {
    expect(classifyBeforeInput(at("deleteContentForward", P0_MID))).toEqual({ kind: "native" });
  });

  test("Backspace over a SELECTION at a block start is a deletion, not a merge", () => {
    // The flag says the range starts at offset 0, but the selection is non-empty, so the user is
    // Deleting the selected text — merging would silently eat the previous block too.
    expect(
      classifyBeforeInput(span("deleteContentBackward", P0, P0_MID, { atBlockStart: true })),
    ).toEqual({ kind: "native" });
  });

  test("Delete over a selection ending at a block end is a deletion, not a merge", () => {
    expect(
      classifyBeforeInput(span("deleteContentForward", P0_MID, P0_END, { atBlockEnd: true })),
    ).toEqual({ kind: "native" });
  });
});

describe("classifyBeforeInput — cross-block ranges", () => {
  test("typing over a cross-block selection replaces the range with the typed text", () => {
    expect(classifyBeforeInput(span("insertText", P0_MID, P1_MID, { data: "x" }))).toEqual({
      from: P0_MID,
      kind: "replaceRange",
      text: "x",
      to: P1_MID,
    });
  });

  test("pasting across blocks replaces the range", () => {
    expect(classifyBeforeInput(span("insertFromPaste", P0_MID, P1_MID, { data: "hi" }))).toEqual({
      from: P0_MID,
      kind: "replaceRange",
      text: "hi",
      to: P1_MID,
    });
  });

  test("deleting across blocks replaces the range with nothing", () => {
    for (const t of ["deleteContentBackward", "deleteContentForward", "deleteByCut"]) {
      expect(classifyBeforeInput(span(t, P0_MID, P1_MID))).toEqual({
        from: P0_MID,
        kind: "replaceRange",
        text: "",
        to: P1_MID,
      });
    }
  });

  test("Shift+Enter across blocks collapses the range instead of inserting a stray <br>", () => {
    expect(classifyBeforeInput(span("insertLineBreak", P0_MID, P1_MID))).toEqual({
      from: P0_MID,
      kind: "replaceRange",
      text: "",
      to: P1_MID,
    });
  });

  test("a cross-block delete wins over the boundary-merge flags", () => {
    // The start flag is set (the range begins at offset 0) but the range spans blocks, so this is a
    // Range replace — a mergeBackward here would delete the wrong block.
    expect(
      classifyBeforeInput(span("deleteContentBackward", P0, P1_MID, { atBlockStart: true })),
    ).toEqual({ from: P0, kind: "replaceRange", text: "", to: P1_MID });
  });
});

describe("classifyBeforeInput — single-block natives", () => {
  test("ordinary typing is native", () => {
    expect(classifyBeforeInput(at("insertText", P0_MID, { data: "a" }))).toEqual({
      kind: "native",
    });
  });

  test("Shift+Enter inside a block is native", () => {
    expect(classifyBeforeInput(at("insertLineBreak", P0_MID))).toEqual({ kind: "native" });
  });

  test("spellcheck replacement and paste inside one block are native", () => {
    expect(classifyBeforeInput(at("insertReplacementText", P0_MID, { data: "fixed" }))).toEqual({
      kind: "native",
    });
    expect(classifyBeforeInput(at("insertFromPaste", P0_MID, { data: "p" }))).toEqual({
      kind: "native",
    });
  });

  test("cut inside one block is native", () => {
    expect(classifyBeforeInput(span("deleteByCut", P0, P0_MID))).toEqual({ kind: "native" });
  });

  test("an unknown inputType inside one block is allowed through", () => {
    // New engine behaviours are far more often ordinary text editing than structural surgery; the
    // MutationObserver net is what catches the exceptions.
    expect(classifyBeforeInput(at("insertSomethingNewIn2027", P0_MID))).toEqual({ kind: "native" });
  });
});
