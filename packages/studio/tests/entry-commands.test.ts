/**
 * Tests for src/content/entry-commands.ts — the content-entry verbs, the seeded creation flow, and
 * `openEntryEditor`'s reveal-then-switch behaviour in src/content/entry-editor.ts.
 */
import { flush, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { closeAllTabs, openTab, workspace } from "../src/workspace/workspace";

const notifications: { severity: string; message: string }[] = [];
const created: Record<string, unknown>[] = [];
const opened: string[] = [];
let createResult: string | null = "content/blog/first-post.json";

void mock.module("../src/services/notify", () => ({
  notify: {
    error: (message: string) => notifications.push({ message, severity: "error" }),
    info: (message: string) => notifications.push({ message, severity: "info" }),
    success: (message: string) => notifications.push({ message, severity: "success" }),
    warn: (message: string) => notifications.push({ message, severity: "warn" }),
  },
}));

/** The default files mock. Re-installed per test: one case below replaces it deliberately. */
function mockFiles(): void {
  void mock.module("../src/files/files", () => ({
    createFileIn: (request: Record<string, unknown>) => {
      created.push(request);
      return Promise.resolve(createResult);
    },
    openFileInTab: (path: string) => {
      opened.push(path);
      if (!workspace.tabs.has(path)) {
        openTab({ document: { children: [], tagName: "div" }, documentPath: path, id: path });
      }
      return Promise.resolve();
    },
  }));
}
mockFiles();

const { ENTRY_MODE, openEntryEditor } = await import("../src/content/entry-editor");
const { contentCommands, createEntry, registerContentCommands } =
  await import("../src/content/entry-commands");
const { draftView } = await import("../src/content/draft-state");
const { createCommandRegistry } = await import("../src/commands/registry");
const { makeContext } = await import("../src/commands/context");

/** A live registry over the records, so registration's own placement checks run too. */
function liveRegistry() {
  const registry = createCommandRegistry({
    getContext: () => makeContext({ document: { open: true }, project: { open: true } }),
  });
  registerContentCommands(registry);
  return registry;
}

const BLOG_SCHEMA = {
  properties: {
    draft: { default: false, type: "boolean" },
    pubDate: { format: "date", type: "string" },
    title: { type: "string" },
  },
  required: ["title"],
  type: "object",
};

function command(id: string) {
  const record = contentCommands().find((c) => c.id === id);
  if (!record) {
    throw new Error(`no command ${id}`);
  }
  return record;
}

beforeEach(() => {
  notifications.length = 0;
  created.length = 0;
  opened.length = 0;
  createResult = "content/blog/first-post.json";
  draftView.includeDrafts = false;
  mockFiles();
  closeAllTabs();
  resetStudioState({
    projectConfig: {
      content: {
        blog: { format: "json", schema: BLOG_SCHEMA, source: "./content/blog/" },
        products: { schema: {}, source: "./content/catalog.csv" },
      },
    },
  });
});

afterEach(() => {
  closeAllTabs();
});

describe("createEntry", () => {
  test("goes through the ONE creation flow, with the collection's extension and a seeded body", async () => {
    const path = await createEntry("blog");
    expect(path).toBe("content/blog/first-post.json");
    expect(created).toHaveLength(1);
    const request = created[0]!;
    expect(request.dir).toBe("content/blog");
    // The extension is what makes the file an entry of the collection it was created in — the
    // Predecessor wrote `content/blog/untitled`, matched by no format and therefore by no
    // Collection.
    expect(request.format).toEqual({ ext: ".json", kind: "fixed" });
    expect(request.source).toBe("Content");
    expect(JSON.parse(request.content as string)).toEqual({ draft: false, title: "" });
  });

  test("opens what it created in the entry editor", async () => {
    await createEntry("blog");
    expect(opened).toEqual(["content/blog/first-post.json"]);
    const tab = workspace.tabs.get("content/blog/first-post.json");
    expect(tab?.session.ui.canvasMode).toBe(ENTRY_MODE);
  });

  test("a cancelled name field creates nothing and opens nothing", async () => {
    createResult = null;
    expect(await createEntry("blog")).toBeNull();
    expect(opened).toEqual([]);
  });

  test("refuses a collection that is a single file, and says why", async () => {
    expect(await createEntry("products")).toBeNull();
    expect(created).toHaveLength(0);
    expect(notifications[0]?.severity).toBe("error");
    expect(notifications[0]?.message).toContain("products");
  });

  test("refuses a collection the project does not declare", async () => {
    expect(await createEntry("nope")).toBeNull();
    expect(notifications[0]?.message).toContain("nope");
  });

  /**
   * A localized collection's `dir` is `content/exhibitions/{locale}` — a path nobody has. Creating
   * there makes a directory literally named `{locale}`, which is what the palette's New Entry and
   * the `new_content_entry` tool did on the museum starter. There is no default locale to pick on
   * the author's behalf, because choosing one silently files the entry under a language.
   */
  test("refuses a localized collection with no directory, and names the gesture that works", async () => {
    resetStudioState({
      projectConfig: {
        content: {
          shows: { format: "json", schema: {}, source: "./content/shows/{locale}/" },
        },
        i18n: { locales: ["en", "fr"] },
      },
    });
    expect(await createEntry("shows")).toBeNull();
    expect(created).toHaveLength(0);
    expect(notifications[0]?.message).toContain("localized collection");
  });

  test("but honours a locale directory it is handed", async () => {
    resetStudioState({
      projectConfig: {
        content: {
          shows: { format: "json", schema: {}, source: "./content/shows/{locale}/" },
        },
        i18n: { locales: ["en", "fr"] },
      },
    });
    await createEntry("shows", { dir: "content/shows/fr" });
    expect(created[0]?.dir).toBe("content/shows/fr");
  });

  test("a destination outside the collection falls back to the collection's own", async () => {
    // Membership, not a string prefix: `collection.dir` may still be a `{locale}` template, and a
    // Prefix test against a template rejects every real directory it stands for.
    await createEntry("blog", { dir: "pages" });
    expect(created[0]?.dir).toBe("content/blog");
  });

  test("and a subdirectory of it is honoured", async () => {
    await createEntry("blog", { dir: "content/blog/2026" });
    expect(created[0]?.dir).toBe("content/blog/2026");
  });
});

describe("openEntryEditor", () => {
  test("reveals the file's existing tab and switches its editor, keeping the tab id", async () => {
    const path = "content/blog/hello.json";
    openTab({ document: { children: [], tagName: "div" }, documentPath: path, id: path });
    const before = workspace.tabs.get(path);
    const tab = await openEntryEditor(path);
    expect(tab).toBe(before as never);
    expect(tab?.session.ui.canvasMode).toBe(ENTRY_MODE);
    expect(tab?.capabilities.modes[0]).toBe(ENTRY_MODE);
    expect(tab?.session.ui.preview).toBe(false);
  });

  test("answers null when the file never became a tab", async () => {
    void mock.module("../src/files/files", () => ({
      createFileIn: () => Promise.resolve(null),
      openFileInTab: () => Promise.resolve(),
    }));
    const { openEntryEditor: freshOpen } = await import("../src/content/entry-editor");
    expect(await freshOpen("content/blog/never.json")).toBeNull();
  });
});

describe("the records", () => {
  test("every one is level-filed and reachable from the palette", () => {
    const ids = contentCommands().map((c) => c.id);
    expect(ids).toEqual([
      "content.newEntry",
      "content.openEntry",
      "content.setDraft",
      "content.setIncludeDrafts",
    ]);
    for (const record of contentCommands()) {
      expect(record.menus).toContain("palette");
      expect(record.requires ?? "").not.toBe("");
    }
  });

  test("no toggle: both booleans are set* verbs naming the state they reach", () => {
    for (const record of contentCommands()) {
      expect(record.id).not.toContain("toggle");
    }
    const args = command("content.setDraft").args as { required?: string[] };
    expect(args.required).toEqual(["draft"]);
  });

  test("New Entry's enum is the project's directory-backed collections only", () => {
    const args = command("content.newEntry").args as {
      properties: { collection: { enum: string[] } };
    };
    expect(args.properties.collection.enum).toEqual(["blog"]);
  });

  test("New Entry is disabled — with a reason — in a project that declares no collection", () => {
    resetStudioState({ projectConfig: { content: {} } });
    const record = command("content.newEntry");
    expect(record.enablement?.({} as never)).toBe(false);
    expect(record.requires).toContain("content collection");
  });

  test("setIncludeDrafts reaches the shared perspective, idempotently", async () => {
    const registry = liveRegistry();
    await registry.run("content.setIncludeDrafts", { include: true });
    expect(draftView.includeDrafts).toBe(true);
    await registry.run("content.setIncludeDrafts", { include: true });
    expect(draftView.includeDrafts).toBe(true);
    await registry.run("content.setIncludeDrafts", { include: false });
    expect(draftView.includeDrafts).toBe(false);
  });

  test("setDraft writes the flag on the active entry, in the store that entry saves from", async () => {
    // A JSON collection's entry is opened by `files/files.ts` as `document = JSON.parse(text)` with
    // No frontmatter at all — so the flag has to land on the document, which is what gets written.
    const path = "content/blog/hello.json";
    const tab = openTab({
      document: { title: "Hello" },
      documentPath: path,
      id: path,
      sourceFormat: null,
    });
    await flush();
    const registry = liveRegistry();
    expect(command("content.setDraft").enablement?.({} as never)).toBe(true);
    await registry.run("content.setDraft", { draft: true });
    expect(tab.doc.document.draft).toBe(true);
    expect(tab.doc.content.frontmatter.draft).toBeUndefined();
  });

  test("setDraft refuses when the active document is not an entry", async () => {
    openTab({
      document: { children: [], tagName: "div" },
      documentPath: "pages/index.json",
      id: "pages/index.json",
    });
    await flush();
    expect(command("content.setDraft").enablement?.({} as never)).toBe(false);
    // The registry refuses with the record's own `requires` sentence — the disabled button's
    // Tooltip, the palette's grey subtitle and the assistant's refusal are this one string.
    // The refusal is synchronous: an unavailable command never starts.
    expect(() => liveRegistry().run("content.setDraft", { draft: true })).toThrow(
      "a content entry open",
    );
    // And the run body refuses too, for the caller that reaches it without the gate.
    expect(() => command("content.setDraft").run({} as never, { draft: true } as never)).toThrow(
      "not a content entry",
    );
  });

  test("newEntry refuses an argument naming no collection", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(liveRegistry().run("content.newEntry", { collection: "nope" })).rejects.toThrow(
      /collection/,
    );
  });

  test("openEntry takes a project path and opens the form", async () => {
    await liveRegistry().run("content.openEntry", { path: "content/blog/hello.json" });
    expect(opened).toContain("content/blog/hello.json");
  });
});
