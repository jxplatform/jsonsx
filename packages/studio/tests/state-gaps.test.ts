/**
 * Gap coverage for src/state.ts: the doc/session slice helpers (toFlat/fromFlat) and
 * updateFrontmatter, which no other suite exercises directly.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { fromFlat, toFlat, updateFrontmatter } from "../src/state";
import type { StudioState } from "../src/state";

const baseState = (overrides: Record<string, unknown> = {}) =>
  ({
    canvas: { status: "idle" },
    content: { frontmatter: { title: "Post" } },
    dirty: false,
    document: { tagName: "div" },
    documentPath: "/project/index.json",
    documentStack: [],
    fileHandle: null,
    handlersSource: null,
    history: [],
    historyIndex: 0,
    hover: null,
    mode: "design",
    selection: [0],
    ui: { rightTab: "properties" },
    ...overrides,
  }) as unknown as StudioState;

describe("toFlat / fromFlat", () => {
  test("toFlat merges doc and session slices, session wins on overlap", () => {
    const flat = toFlat(
      { dirty: true, document: { tagName: "main" } } as Partial<StudioState>,
      { hover: null, selection: [1, 2] } as Partial<StudioState>,
    );
    expect(flat.dirty).toBe(true);
    expect((flat.document as { tagName: string }).tagName).toBe("main");
    expect(flat.selection).toEqual([1, 2]);
  });

  test("fromFlat splits a flat state into doc and session slices", () => {
    const S = baseState();
    const { doc, session } = fromFlat(S);
    expect(doc.document).toBe(S.document);
    expect(doc.documentPath).toBe("/project/index.json");
    expect(doc.history).toBe(S.history);
    expect(doc.mode).toBe("design");
    expect(session.selection).toEqual([0]);
    expect(session.ui).toBe(S.ui);
    expect(session.canvas).toBe(S.canvas);
    // Doc slice must not contain session keys and vice versa
    expect("selection" in doc).toBe(false);
    expect("document" in session).toBe(false);
  });

  test("toFlat(fromFlat(S)) round-trips every sliced field", () => {
    const S = baseState({ dirty: true, hover: [3] });
    const { doc, session } = fromFlat(S);
    const flat = toFlat(doc, session);
    expect(flat.document).toBe(S.document);
    expect(flat.dirty).toBe(true);
    expect(flat.hover).toEqual([3]);
    expect(flat.ui).toBe(S.ui);
  });
});

describe("updateFrontmatter", () => {
  test("sets a field and marks dirty without mutating the input", () => {
    const S = baseState();
    const next = updateFrontmatter(S, "author", "kevin");
    expect(next.content?.frontmatter).toEqual({ author: "kevin", title: "Post" });
    expect(next.dirty).toBe(true);
    expect(S.content?.frontmatter).toEqual({ title: "Post" });
    expect(S.dirty).toBe(false);
  });

  test.each([undefined, null, ""])("deletes the field when value is %p", (empty) => {
    const S = baseState();
    const next = updateFrontmatter(S, "title", empty);
    expect(next.content?.frontmatter).toEqual({});
  });

  test("works when content has no frontmatter object yet", () => {
    const S = baseState({ content: {} });
    const next = updateFrontmatter(S, "draft", true);
    expect(next.content?.frontmatter).toEqual({ draft: true });
  });
});
