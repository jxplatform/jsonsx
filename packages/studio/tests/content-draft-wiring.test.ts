/**
 * The draft perspective, END TO END — command → flag → collection listing → the open grid.
 *
 * This file exists because every part of this feature already had a passing unit test while the
 * feature did nothing. `applyDraftFilter` was tested and had no caller; `content.setIncludeDrafts`
 * was tested and set a flag no list read. A unit test cannot see that, because it imports the
 * module it is testing and therefore proves only that the module works when someone calls it.
 *
 * So every assertion below crosses at least one module boundary the app crosses: the command comes
 * out of the registry by id, the rows come out of the controller the grid tab renders, and nothing
 * reaches into `draftView` to set it.
 */
import { installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockFormatAction, seedMarkdownFormat } from "./format-fixture";
import { closeAllTabs, workspace } from "../src/workspace/workspace";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext } from "../src/commands/context";
import { draftView } from "../src/content/draft-state";
import type { CommandContext } from "../src/commands/context";
import type { CommandRegistry } from "../src/commands/registry";
import type { StudioPlatform } from "../src/types";

void mock.module("tabulator-tables", () => ({}));
void mock.module("tabulator-tables/dist/css/tabulator.min.css", () => ({}));

const { getGridController } = await import("../src/grid/grid-controller");
const { openCollectionGrid } = await import("../src/grid/grid-open");
const { registerContentCommands } = await import("../src/content/entry-commands");
const { PATH_FIELD } = await import("../src/grid/sources/content-source");

const DRAFT_MD = "---\ntitle: Draft post\ndraft: true\n---\n\nNot ready\n";
const LIVE_MD = "---\ntitle: Live post\ndraft: false\n---\n\nShipped\n";

const POSTS_SCHEMA = {
  properties: { draft: { type: "boolean" }, title: { type: "string" } },
  required: ["title"],
};

/** A project with one collection whose schema declares the draft axis, and one draft in it. */
function setup(schema: object | null = POSTS_SCHEMA) {
  installMockPlatform({ formatAction: mockFormatAction } as unknown as Partial<StudioPlatform>, {
    "content/posts/draft.md": DRAFT_MD,
    "content/posts/live.md": LIVE_MD,
  });
  resetStudioState({
    projectConfig: {
      content: { posts: { format: "Markdown", schema, source: "./content/posts/" } },
    },
  });
}

/** A registry holding the real content records over a project-is-open context. */
function contentRegistry(): CommandRegistry {
  const registry = createCommandRegistry({
    getContext: () => ({ ...emptyContext(), project: { open: true } }) as CommandContext,
  });
  registerContentCommands(registry);
  return registry;
}

beforeEach(() => {
  closeAllTabs();
  seedMarkdownFormat();
  draftView.includeDrafts = false;
});

describe("content.setIncludeDrafts reaches the collection listing", () => {
  test("the open collection grid gains and loses the draft row as the command runs", async () => {
    setup();
    const registry = contentRegistry();
    const tab = openCollectionGrid("posts");
    const controller = getGridController(tab)!;
    await controller.load();

    const titles = () => controller.state.rows.map((row) => row.cells.title).toSorted();
    expect(titles()).toEqual(["Live post"]);
    expect(controller.state.total).toBe(1);

    await registry.run("content.setIncludeDrafts", { include: true });
    expect(titles()).toEqual(["Draft post", "Live post"]);
    expect(controller.state.total).toBe(2);

    await registry.run("content.setIncludeDrafts", { include: false });
    expect(titles()).toEqual(["Live post"]);
  });

  test("the perspective is what filters — the entry file is never touched", async () => {
    setup();
    const registry = contentRegistry();
    const tab = openCollectionGrid("posts");
    const controller = getGridController(tab)!;
    await controller.load();
    expect(controller.state.rows).toHaveLength(1);

    await registry.run("content.setIncludeDrafts", { include: true });
    const draftRow = controller.state.rows.find((row) => row.cells.draft === true)!;
    expect(draftRow.cells[PATH_FIELD]).toBe("content/posts/draft.md");
    expect(draftRow.fingerprint).toBe(DRAFT_MD);
  });

  test("a grid opened while drafts are hidden still knows the collection has a Draft column", async () => {
    setup();
    const tab = openCollectionGrid("posts");
    const controller = getGridController(tab)!;
    await controller.load();

    // The hidden draft row is still loaded — only the LISTING is filtered — so the axis is known
    // And the column is drawn, which is the only thing on screen that explains the missing row.
    expect(controller.state.columns[1]!.field).toBe("draft");
    expect(controller.state.columns[1]!.title).toBe("Draft");
  });

  test("a grid on a collection with no draft axis is left entirely alone", async () => {
    installMockPlatform({ formatAction: mockFormatAction } as unknown as Partial<StudioPlatform>, {
      "content/notes/one.md": "---\ntitle: One\n---\n",
    });
    resetStudioState({
      projectConfig: {
        content: {
          notes: {
            format: "Markdown",
            schema: { properties: { title: { type: "string" } } },
            source: "./content/notes/",
          },
        },
      },
    });
    const registry = contentRegistry();
    const tab = openCollectionGrid("notes");
    const controller = getGridController(tab)!;
    await controller.load();

    expect(controller.state.columns.map((c) => c.field)).not.toContain("draft");
    const before = controller.state.rows.length;
    await registry.run("content.setIncludeDrafts", { include: true });
    expect(controller.state.rows).toHaveLength(before);
  });

  test("no open grid is not an error — the command still sets the perspective", async () => {
    setup();
    const registry = contentRegistry();
    expect(workspace.tabs.size).toBe(0);
    await registry.run("content.setIncludeDrafts", { include: true });
    expect(draftView.includeDrafts).toBe(true);
  });
});

describe("content.newEntry offers its collections to the palette", () => {
  test("the enum is derived when the prompt reads it, not when the record was built", async () => {
    const { paletteArgs } = await import("../src/panels/quick-search");
    // The record is built FIRST, with no project open — exactly what `studio.ts` does at boot.
    resetStudioState({ projectConfig: null });
    const registry = contentRegistry();
    const record = registry.get("content.newEntry")!;
    expect(paletteArgs(record)).toEqual({ choices: [], kind: "choice", name: "collection" });

    // …and the same record answers with the real collections once one is open.
    setup();
    expect(paletteArgs(record)).toEqual({
      choices: [{ label: "posts", value: "posts" }],
      kind: "choice",
      name: "collection",
    });
  });

  test("the palette will render the row, because its args are a promptable choice", () => {
    setup();
    const registry = contentRegistry();
    const record = registry.get("content.newEntry")!;
    expect(record.args).toBeDefined();
    // `quick-search.ts:506` drops any command whose args it cannot prompt for; an empty enum is
    // Still a choice, so what used to be broken was the CONTENT of the list, never its shape.
    expect(structuredClone(record.args)).toEqual({
      additionalProperties: false,
      properties: {
        collection: {
          description: "The content collection the entry is created in.",
          enum: ["posts"],
          type: "string",
        },
      },
      required: ["collection"],
      type: "object",
    });
  });
});
