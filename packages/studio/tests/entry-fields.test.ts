/**
 * Tests for src/content/entry-fields.ts — the one place that answers "which record holds this
 * entry's fields", and the mutation that writes it.
 *
 * The contract under test is a round trip, not a getter: whatever the form edits must be what
 * `files/file-ops.ts` serializes. A JSON entry keeps its fields in `doc.document` and is written
 * back as that object; a Markdown entry keeps them in `doc.content.frontmatter` and is written back
 * as a frontmatter block. Reading the wrong one is silent — the tab goes dirty, the edit survives
 * undo, and save writes the file it started with — so every case below asserts the serialized
 * text.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MARKDOWN_FORMAT, mockFormatAction, seedMarkdownFormat } from "./format-fixture";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import { serializeDocument } from "../src/files/file-ops";
import { transactDoc, undo } from "../src/tabs/transact";
import { commitEntryFields, entryFields, mutateEntryField } from "../src/content/entry-fields";
import type { StudioPlatform } from "../src/types";
import type { Tab } from "../src/tabs/tab";

/** A JSON entry as `files/files.ts` builds it: the parsed object IS the document, no frontmatter. */
function jsonEntry(document: Record<string, unknown>): Tab {
  closeAllTabs();
  return openTab({
    document,
    documentPath: "content/authors/ada.json",
    id: "content/authors/ada.json",
    sourceFormat: null,
  }) as unknown as Tab;
}

/** A Markdown entry as the format host splits it: frontmatter beside a body. */
function markdownEntry(frontmatter: Record<string, unknown>): Tab {
  closeAllTabs();
  return openTab({
    document: { children: [{ children: [], tagName: "p", textContent: "Hi" }] },
    documentPath: "content/blog/hello.md",
    frontmatter,
    id: "content/blog/hello.md",
    sourceFormat: "Markdown",
  }) as unknown as Tab;
}

beforeEach(() => {
  resetStudioState({ projectConfig: { name: "Demo" } });
  installMockPlatform(
    {
      formatAction: mockFormatAction,
      listFormats: async () => [MARKDOWN_FORMAT],
    } as Partial<StudioPlatform>,
    {},
  );
  seedMarkdownFormat();
  closeAllTabs();
});

afterEach(() => {
  closeAllTabs();
});

describe("which record holds the fields", () => {
  test("a JSON entry's fields ARE its document — the same object, not a copy of it", () => {
    const tab = jsonEntry({ bio: "Mathematician", name: "Ada Lovelace" });
    expect(entryFields(tab)).toBe(tab.doc.document as unknown as Record<string, unknown>);
    expect(entryFields(tab)).toMatchObject({ bio: "Mathematician", name: "Ada Lovelace" });
  });

  test("a Markdown entry's fields are its frontmatter", () => {
    const tab = markdownEntry({ pubDate: "2026-01-01", title: "Hello" });
    expect(entryFields(tab)).toBe(tab.doc.content.frontmatter);
    expect(entryFields(tab)).toMatchObject({ pubDate: "2026-01-01", title: "Hello" });
  });

  test("the answer tracks the serializer: a content-mode tab is frontmatter even with no format", () => {
    // `serializeDocument`'s middle rung — content mode with no serializing source format still
    // Writes a frontmatter block through the default content format, so the fields are there.
    const tab = jsonEntry({ name: "Ada Lovelace" });
    tab.doc.mode = "content";
    expect(entryFields(tab)).toBe(tab.doc.content.frontmatter);
  });
});

describe("mutateEntryField writes where save reads", () => {
  test("a JSON entry's field lands in the document and in the saved text", async () => {
    const tab = jsonEntry({ bio: "Mathematician", name: "Ada Lovelace" });
    transactDoc(tab, (t) => mutateEntryField(t, "name", "Ada Byron"));

    expect(tab.doc.document.name).toBe("Ada Byron");
    expect(tab.doc.content.frontmatter).toEqual({});
    expect(tab.doc.dirty).toBe(true);
    expect(JSON.parse(await serializeDocument(tab))).toEqual({
      bio: "Mathematician",
      name: "Ada Byron",
    });
  });

  test("a Markdown entry's field lands in frontmatter and in the saved text", async () => {
    const tab = markdownEntry({ title: "Hello" });
    transactDoc(tab, (t) => mutateEntryField(t, "title", "Renamed"));

    expect(tab.doc.content.frontmatter.title).toBe("Renamed");
    expect(tab.doc.document.title).toBeUndefined();
    expect(await serializeDocument(tab)).toContain("Renamed");
  });

  test("both stores remove a key on empty and null — one behaviour, two shapes", () => {
    const json = jsonEntry({ bio: "Mathematician", name: "Ada Lovelace" });
    transactDoc(json, (t) => mutateEntryField(t, "bio", ""));
    expect(Object.hasOwn(json.doc.document, "bio")).toBe(false);
    transactDoc(json, (t) => mutateEntryField(t, "name", null));
    expect(Object.hasOwn(json.doc.document, "name")).toBe(false);

    const md = markdownEntry({ subtitle: "x", title: "Hello" });
    transactDoc(md, (t) => mutateEntryField(t, "subtitle", ""));
    expect(Object.hasOwn(md.doc.content.frontmatter, "subtitle")).toBe(false);
  });

  test("a JSON entry's field change is undone — it is a real document op, not a lost write", async () => {
    const tab = jsonEntry({ name: "Ada Lovelace" });
    transactDoc(tab, (t) => mutateEntryField(t, "name", "Ada Byron"));
    transactDoc(tab, (t) => mutateEntryField(t, "bio", "Mathematician"));
    await flush();

    undo(tab);
    expect(Object.hasOwn(tab.doc.document, "bio")).toBe(false);
    undo(tab);
    expect(tab.doc.document.name).toBe("Ada Lovelace");
  });
});

describe("commitEntryFields", () => {
  test("a multi-key patch is ONE undo step, on either shape", () => {
    const json = jsonEntry({ name: "Ada Lovelace" });
    const before = json.history.snapshots.length;
    commitEntryFields(json, { bio: "Mathematician", name: "Ada Byron" });
    expect(json.doc.document).toMatchObject({ bio: "Mathematician", name: "Ada Byron" });
    expect(json.history.snapshots.length).toBe(before + 1);

    undo(json);
    expect(json.doc.document).toEqual({ name: "Ada Lovelace" });

    const md = markdownEntry({ title: "Hello" });
    commitEntryFields(md, { pubDate: "2026-01-01", title: "Renamed" });
    expect(md.doc.content.frontmatter).toMatchObject({
      pubDate: "2026-01-01",
      title: "Renamed",
    });
  });
});
