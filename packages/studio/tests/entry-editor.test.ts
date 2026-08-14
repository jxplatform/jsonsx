/**
 * Tests for src/content/entry-editor.ts — the Entry editor kind: what it draws for an entry, what
 * it draws for a document that is not one, how a field commit reaches the transaction log, and the
 * draft pill both the editor and the tab strip render.
 *
 * **Every fixture opens a real file through `files/files.ts`.** The predecessor built its tabs with
 * `openTab({ frontmatter })` for paths ending `.json` — handing the fixture a record the real open
 * path never produces, because nothing splits a frontmatter block off a JSON file. That fixture
 * passed while the editor drew a blank form over a JSON entry full of data and discarded every edit
 * at save time. A test that invents the state under test can only ever agree with itself.
 */
import { flush, installMockPlatform, resetStudioState, surfaceOf } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "lit-html";
import { MARKDOWN_FORMAT, mockFormatAction, seedMarkdownFormat } from "./format-fixture";
import { activeTab, closeAllTabs, workspace } from "../src/workspace/workspace";
import { openFileInTab } from "../src/files/files";
import { serializeDocument } from "../src/files/file-ops";
import { editorKindForMode } from "../src/commands/context";
import {
  ENTRY_MODE,
  detachEntryPane,
  entryDraftPill,
  entryPaneMounted,
  renderEntryMode,
  setEntryDraft,
} from "../src/content/entry-editor";
import type { StudioPlatform } from "../src/types";
import type { Tab } from "../src/tabs/tab";

const BLOG_SCHEMA = {
  properties: {
    author: { $ref: "#/content/authors" },
    draft: { default: false, type: "boolean" },
    // A dynamic enum: its choices come from the project config through the form's host context,
    // Which is the entry editor's `resolvePointer`.
    kind: { enum: { $ref: "#/$context/content" }, type: "string" },
    // An array-of-objects row set — its "+ Add" is the form's `rerender` hook.
    links: { items: { properties: { url: { type: "string" } }, type: "object" }, type: "array" },
    pubDate: { format: "date", type: "string" },
    title: { type: "string" },
  },
  required: ["title", "pubDate"],
  type: "object",
};

const AUTHOR_SCHEMA = {
  properties: {
    bio: { type: "string" },
    draft: { default: false, type: "boolean" },
    name: { type: "string" },
  },
  required: ["name"],
  type: "object",
};

/**
 * Two collections of the SAME shape in two storage formats — `authors` is JSON (the document is the
 * fields), `blog` is Markdown (frontmatter is the fields). Every behavioural claim below is made
 * against both, because the editor is one editor.
 */
function seedProject(): void {
  resetStudioState({
    isSiteProject: true,
    name: "Demo",
    projectConfig: {
      content: {
        authors: { format: "json", schema: AUTHOR_SCHEMA, source: "./content/authors/" },
        blog: { format: "Markdown", schema: BLOG_SCHEMA, source: "./content/blog/" },
      },
      name: "Demo",
    },
    projectRoot: "/demo",
  });
}

/** Register a platform holding these files, with the real Markdown format behind it. */
function seedFiles(files: Record<string, string>): void {
  installMockPlatform(
    {
      formatAction: mockFormatAction,
      listFormats: async () => [MARKDOWN_FORMAT],
    } as Partial<StudioPlatform>,
    files,
  );
  seedMarkdownFormat();
}

/**
 * Open a file the way Studio opens it — parse, frontmatter split (or not), tab.
 *
 * Closes first: `openFileInTab` reveals an existing tab for the path rather than re-reading it, so
 * a fixture that opens the same path twice with different content would silently get the first.
 */
async function openEntry(path: string, source: string): Promise<Tab> {
  closeAllTabs();
  seedFiles({ [path]: source });
  await openFileInTab(path);
  const tab = workspace.tabs.get(path);
  if (!tab) {
    throw new Error(`fixture did not open ${path}`);
  }
  return tab as unknown as Tab;
}

/** The reviewer's reproduction case, verbatim: a JSON entry that HAS its required field. */
function adaSource(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ bio: "Mathematician", name: "Ada Lovelace", ...extra });
}

const openAda = (extra?: Record<string, unknown>) =>
  openEntry("content/authors/ada.json", adaSource(extra));

/** A Markdown entry of the same shape — the other storage shape, same editor. */
function openPost(frontmatter = "title: Hello\npubDate: 2026-01-01\n"): Promise<Tab> {
  return openEntry("content/blog/hello.md", `---\n${frontmatter}---\n\n# Hello\n`);
}

async function mount(tab: Tab): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  renderEntryMode(surfaceOf(host), tab);
  await flush();
  return host;
}

function fieldValue(host: HTMLElement, prop: string): unknown {
  const el = host.querySelector(`[data-prop="${prop}"] sp-textfield`);
  return (el as unknown as { value?: unknown } | null)?.value;
}

function typeInto(host: HTMLElement, prop: string, value: string): void {
  const el = host.querySelector(`[data-prop="${prop}"] sp-textfield`) as HTMLElement & {
    value: string;
  };
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The form engine debounces text commits. */
const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 450);
  });

beforeEach(() => {
  closeAllTabs();
  seedProject();
  seedFiles({});
});

afterEach(() => {
  detachEntryPane("primary");
  document.body.replaceChildren();
  closeAllTabs();
});

describe("the mode is registered where every reader looks", () => {
  test('"entry" resolves to the entry editor kind, never the silent canvas default', () => {
    expect(editorKindForMode(ENTRY_MODE)).toBe("entry");
    // The failure this guards: an unmapped mode answers "canvas", which put ⌘V's element paste on
    // A configuration document in P6.
    expect(editorKindForMode("no-such-mode")).toBe("canvas");
  });
});

describe("the two storage shapes the real open path produces", () => {
  test("a JSON entry has NO frontmatter — its document is its fields", async () => {
    const tab = await openAda();
    expect(tab.doc.sourceFormat).toBeNull();
    expect(tab.doc.content.frontmatter).toEqual({});
    expect(tab.doc.document).toMatchObject({ bio: "Mathematician", name: "Ada Lovelace" });
  });

  test("a Markdown entry splits frontmatter from a body", async () => {
    const tab = await openPost();
    expect(tab.doc.sourceFormat).toBe("Markdown");
    expect(tab.doc.content.frontmatter).toMatchObject({ title: "Hello" });
    expect(Array.isArray(tab.doc.document.children)).toBe(true);
  });
});

describe("rendering", () => {
  test("a JSON entry's form is filled from the document, not from an empty frontmatter", async () => {
    const host = await mount(await openAda());
    expect(host.querySelector(".entry-editor-collection")?.textContent).toBe("authors");
    expect(fieldValue(host, "name")).toBe("Ada Lovelace");
    expect(fieldValue(host, "bio")).toBe("Mathematician");
  });

  test("a Markdown entry's form is filled from its frontmatter", async () => {
    const host = await mount(await openPost());
    expect(host.querySelector(".entry-editor-collection")?.textContent).toBe("blog");
    expect(fieldValue(host, "title")).toBe("Hello");
    expect(host.querySelectorAll(".entry-editor-fields .style-row").length).toBeGreaterThanOrEqual(
      4,
    );
  });

  test("a valid JSON entry is not accused of missing its required field", async () => {
    const present = await mount(await openAda());
    expect(present.textContent).not.toContain("Required — this entry does not have one.");

    detachEntryPane("primary");
    const absent = await mount(
      await openEntry("content/authors/nobody.json", JSON.stringify({ bio: "Anonymous" })),
    );
    expect(absent.textContent).toContain("Required — this entry does not have one.");
  });

  test("marks a required field the entry does not HAVE, and stays quiet about an empty one", async () => {
    const missing = await mount(await openPost("title: Hello\n"));
    expect(missing.textContent).toContain("Required — this entry does not have one.");

    detachEntryPane("primary");
    const seeded = await mount(await openPost('title: ""\npubDate: ""\n'));
    expect(seeded.textContent).not.toContain("Required — this entry does not have one.");
  });

  test("a document in no collection says so and offers the content types section", async () => {
    const host = await mount(await openEntry("pages/index.json", "{}"));
    expect(host.textContent).toContain("is not an entry of any content collection");
    expect(host.querySelector("sp-action-button")?.textContent).toContain("Content types");
    expect(host.querySelector(".entry-editor-fields")).toBeNull();
  });

  test("mounting is idempotent per tab and released by detach", async () => {
    const tab = await openAda();
    const host = await mount(tab);
    expect(entryPaneMounted("primary", tab)).toBe(true);
    renderEntryMode(surfaceOf(host), tab); // Second call is a no-op — the pane owns its own reactivity.
    expect(entryPaneMounted("primary", tab)).toBe(true);
    detachEntryPane("primary");
    expect(entryPaneMounted("primary", tab)).toBe(false);
    detachEntryPane("primary"); // Idempotent.
  });

  test("a dynamic enum resolves through the project config", async () => {
    const host = await mount(await openPost());
    const options = [...host.querySelectorAll("sp-picker sp-menu-item")].map((o) => o.textContent);
    // `#/$context/content` walks project.json — the same resolver every other form host uses.
    expect(options).toContain("authors");
    expect(options).toContain("blog");
  });

  test("the form can ask the pane for a second frame", async () => {
    const host = await mount(await openPost());
    const add = [...host.querySelectorAll("sp-action-button")].find((b) =>
      b.textContent?.includes("Add"),
    );
    expect(add).toBeDefined();
    add!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(host.querySelectorAll(".array-object-row")).toHaveLength(1);
  });
});

describe("a field edit reaches the file that gets saved", () => {
  test("a JSON entry's edit lands in the document and survives serialization", async () => {
    const tab = await openAda();
    const host = await mount(tab);
    typeInto(host, "name", "Ada Byron");
    await settle();

    expect(tab.doc.document.name).toBe("Ada Byron");
    expect(tab.doc.dirty).toBe(true);
    expect(tab.history.snapshots.length).toBeGreaterThan(1);
    // The whole defect in one assertion: ⌘S writes THIS, and it used to write the pre-edit file
    // Under a "Saved" toast.
    expect(JSON.parse(await serializeDocument(tab))).toEqual({
      bio: "Mathematician",
      name: "Ada Byron",
    });
  });

  test("a Markdown entry's edit lands in frontmatter and survives serialization", async () => {
    const tab = await openPost();
    const host = await mount(tab);
    typeInto(host, "title", "Renamed");
    await settle();

    expect(tab.doc.content.frontmatter.title).toBe("Renamed");
    expect(tab.doc.document.name).toBeUndefined();
    expect(tab.history.snapshots.length).toBeGreaterThan(1);
    expect(await serializeDocument(tab)).toContain("Renamed");
  });

  test("⌘Z takes a JSON entry's field back, because the edit is a document op", async () => {
    const { undo } = await import("../src/tabs/transact");
    const tab = await openAda();
    const host = await mount(tab);
    typeInto(host, "name", "Ada Byron");
    await settle();
    expect(tab.doc.document.name).toBe("Ada Byron");

    undo(tab);
    await flush();
    expect(tab.doc.document.name).toBe("Ada Lovelace");
  });

  test("a repaint follows a commit on either shape, without the canvas pipeline", async () => {
    const json = await openAda();
    const jsonHost = await mount(json);
    expect(jsonHost.querySelector(".entry-editor-note")).toBeNull();
    setEntryDraft(json, true);
    await flush();
    expect(jsonHost.querySelector(".entry-editor-note")?.textContent).toContain("Marked a draft");

    detachEntryPane("primary");
    const md = await openPost();
    const mdHost = await mount(md);
    expect(mdHost.querySelector(".entry-editor-note")).toBeNull();
    setEntryDraft(md, true);
    await flush();
    expect(mdHost.querySelector(".entry-editor-note")?.textContent).toContain("Marked a draft");
  });
});

describe("drafts", () => {
  test("the switch writes the flag into the entry's own store", async () => {
    const tab = await openAda();
    const host = await mount(tab);
    const toggle = host.querySelector(".entry-draft-switch") as
      | (HTMLElement & { checked: boolean })
      | null;
    expect(toggle).not.toBeNull();
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(tab.doc.document.draft).toBe(true);
    expect(tab.doc.content.frontmatter.draft).toBeUndefined();
    expect(tab.doc.dirty).toBe(true);
  });

  test("setEntryDraft is a setter: false is written, not deleted — in both stores", async () => {
    const json = await openAda({ draft: true });
    setEntryDraft(json, false);
    expect(json.doc.document.draft).toBe(false);
    setEntryDraft(json, false);
    expect(json.doc.document.draft).toBe(false);

    const md = await openPost("title: Hello\ndraft: true\n");
    setEntryDraft(md, false);
    expect(md.doc.content.frontmatter.draft).toBe(false);
  });

  test("the pill names both states, and appears on no document without the axis", async () => {
    const host = document.createElement("div");

    render(entryDraftPill(await openAda({ draft: true })), host);
    await flush();
    expect(host.querySelector(".entry-pill--draft")?.textContent).toBe("Draft");
    expect(host.querySelector(".entry-pill")?.getAttribute("title")).toContain("does not exclude");

    render(entryDraftPill(await openAda()), host);
    await flush();
    expect(host.querySelector(".entry-pill")?.textContent).toBe("Published");
    expect(host.querySelector(".entry-pill--draft")).toBeNull();

    render(entryDraftPill(await openEntry("pages/index.json", "{}")), host);
    await flush();
    expect(host.querySelector(".entry-pill")).toBeNull();
  });
});

describe("openEntryEditor over the real open path", () => {
  test("switches the file's own tab into the entry mode", async () => {
    const { openEntryEditor } = await import("../src/content/entry-editor");
    seedFiles({ "content/authors/ada.json": adaSource() });
    const tab = await openEntryEditor("content/authors/ada.json");
    expect(tab?.session.ui.canvasMode).toBe(ENTRY_MODE);
    expect(activeTab.value?.id).toBe("content/authors/ada.json");
  });
});
