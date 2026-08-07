/**
 * Tests for src/browse/library-commands.ts — the Library's verbs, run for real.
 *
 * `tests/project-gap-commands.test.ts` checks the RECORDS (ids, placement, refusals). This file
 * checks that running each one reaches the state it names, because the point of P7.1's registry
 * work is that the palette, a chord, `__jxAutomation` and the assistant all get the same behaviour
 * the toolbar button has — the Manage view's category filter and view switch were buttons and
 * nothing else, and the screenshot pipeline had to press them through an XPath on their labels.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CommandContext } from "../src/commands/context";
import type { CommandRegistry } from "../src/commands/registry";
import type { DirEntry } from "../src/types";

const created: string[] = [];

void mock.module("../src/files/files.js", () => ({
  createFileIn: (request: { dir: string }) => {
    created.push(request.dir);
    return Promise.resolve(`${request.dir}/created.md`);
  },
  loadDirectory: () => Promise.resolve(),
  openFileInTab: () => Promise.resolve(),
}));

const { LIBRARY_LAYOUTS } = await import("../src/browse/library-model");
const { libraryCommands, registerLibraryCommands } = await import("../src/browse/library-commands");
const { libraryView, detachLibraryPane, invalidateLibrary, librarySource } =
  await import("../src/browse/library-pane");
const { createCommandRegistry } = await import("../src/commands/registry");
const { makeContext } = await import("../src/commands/context");
const { closeAllTabs, workspace } = await import("../src/workspace/workspace");

let ctx: CommandContext;
let registry: CommandRegistry;
let listed: string[];

beforeEach(() => {
  created.length = 0;
  listed = [];
  installMockPlatform({
    listDirectory: (path: string) => {
      listed.push(path);
      const entries: DirEntry[] = [{ name: "a.md", path: `${path}/a.md`, type: "file" }];
      return Promise.resolve(entries);
    },
  });
  resetStudioState({
    projectConfig: { content: { posts: { source: "./content/posts" } } },
    projectDirs: ["pages"],
  });
  closeAllTabs();
  detachLibraryPane("primary");
  invalidateLibrary();
  libraryView.category = "all";
  libraryView.layout = "cards";
  libraryView.query = "";
  ctx = makeContext({ project: { isSite: true, open: true } });
  registry = createCommandRegistry({ getContext: () => ctx });
  registerLibraryCommands(registry);
});

describe("running the verbs", () => {
  test("library.open opens the Library tab", async () => {
    await registry.run("library.open");
    expect(workspace.tabs.has("grid://library")).toBe(true);
  });

  test("library.setCategory reaches the state the button reaches", async () => {
    await registry.run("library.setCategory", { category: "media" });
    expect(libraryView.category).toBe("media");
  });

  test("library.setLayout names each of the five arrangements", async () => {
    for (const layout of LIBRARY_LAYOUTS) {
      await registry.run("library.setLayout", { layout });
      expect(libraryView.layout).toBe(layout);
    }
  });

  test("library.setSearch sets the filter, and an omitted query CLEARS it", async () => {
    await registry.run("library.setSearch", { query: "hero" });
    expect(libraryView.query).toBe("hero");
    await registry.run("library.setSearch");
    expect(libraryView.query).toBe("");
  });

  test("library.refresh re-reads the project", async () => {
    await registry.run("library.refresh");
    expect(listed).toEqual(["pages"]);
    await registry.run("library.refresh");
    expect(listed).toEqual(["pages", "pages"]);
    expect(librarySource().files().length).toBe(1);
  });

  test("library.newEntry creates in the folder its kind belongs to", async () => {
    await registry.run("library.newEntry", { type: "page" });
    await flush();
    expect(created).toEqual(["pages"]);
  });

  test("library.newEntry accepts a collection this project declares", async () => {
    await registry.run("library.newEntry", { type: "collection:posts" });
    await flush();
    expect(created).toEqual(["content/posts"]);
  });
});

describe("the records", () => {
  test("every one is project-level and offered to the assistant", () => {
    for (const command of libraryCommands()) {
      expect(command.level).toBe("project");
      expect(command.aiTool?.name).toBeTruthy();
      expect(command.category).toBe("Project");
    }
  });

  test("every one is hidden with no project open", () => {
    ctx = makeContext();
    for (const command of libraryCommands()) {
      expect([command.id, registry.isVisible(command.id)]).toEqual([command.id, false]);
    }
  });

  test("only library.open renders outside the palette", () => {
    for (const command of libraryCommands()) {
      const menus = command.menus ?? [];
      expect([command.id, menus.includes("commandbar/overflow")]).toEqual([
        command.id,
        command.id === "library.open",
      ]);
    }
  });
});
