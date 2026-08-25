import { installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { mockFormatAction, seedMarkdownFormat } from "./format-fixture";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import {
  collectionDirs,
  collectionInfo,
  createCollectionSource,
  createPagesSource,
  listCollectionEntryIds,
  PATH_FIELD,
} from "../src/grid/sources/content-source";
import { setIncludeDrafts } from "../src/content/draft-state";
import type { StudioPlatform } from "../src/types";

const HELLO_MD = `---
title: Hello
tags:
  - a
  - b
draft: false
---

Body text
`;

const WORLD_MD = `---
title: World
author: jane
extra: xyz
---

More body
`;

const POSTS_SCHEMA = {
  properties: {
    author: { $ref: "#/content/authors" },
    draft: { type: "boolean" },
    tags: { items: { type: "string" }, type: "array" },
    title: { type: "string" },
  },
  required: ["title"],
};

function setup(
  seedFiles: Record<string, string> = {},
  platformOverrides: Partial<StudioPlatform> = {},
) {
  const { state } = installMockPlatform(
    { formatAction: mockFormatAction, ...platformOverrides } as unknown as Partial<StudioPlatform>,
    {
      "content/posts/hello.md": HELLO_MD,
      "content/posts/world.md": WORLD_MD,
      ...seedFiles,
    },
  );
  resetStudioState({
    projectConfig: {
      content: {
        authors: { format: "Markdown", schema: {}, source: "./content/authors/" },
        posts: { format: "Markdown", schema: POSTS_SCHEMA, source: "./content/posts/" },
        products: { format: "Csv", schema: {}, source: "./data/products.csv" },
      },
    },
  });
  return state;
}

beforeEach(() => {
  closeAllTabs();
  seedMarkdownFormat();
  setIncludeDrafts(false);
});

describe("collection resolution", () => {
  test("collectionInfo resolves dir, extension, and def", () => {
    setup();
    const info = collectionInfo("posts")!;
    expect(info.dir).toBe("content/posts");
    expect(info.ext).toBe(".md");
    expect(collectionInfo("nope")).toBeNull();
  });

  test("collectionDirs lists directory-backed collections only", () => {
    setup();
    expect(collectionDirs()).toEqual([
      { dir: "content/authors", name: "authors" },
      { dir: "content/posts", name: "posts" },
    ]);
  });

  test("listCollectionEntryIds returns file stems", async () => {
    setup();
    expect(await listCollectionEntryIds("posts")).toEqual(["hello", "world"]);
    expect(await listCollectionEntryIds("missing")).toEqual([]);
  });
});

describe("load", () => {
  test("columns: path identity first, schema columns, then inferred extras", async () => {
    setup();
    const source = createCollectionSource("posts");
    const columns = await source.columns();
    expect(columns[0]!.field).toBe(PATH_FIELD);
    expect(columns[0]!.pk).toBeTrue();
    expect(columns[0]!.insertOnly).toBeTrue();
    expect(columns[0]!.editable).toBeFalse();

    const byField = new Map(columns.map((c) => [c.field, c]));
    expect(byField.get("title")!.required).toBeTrue();
    expect(byField.get("tags")!.kind).toBe("array");
    expect(byField.get("draft")!.kind).toBe("boolean");
    expect(byField.get("author")!.kind).toBe("reference");
    expect(byField.get("extra")!.kind).toBe("string"); // Inferred from data, not schema.
  });

  test("rows keyed by path with typed frontmatter cells and text fingerprints", async () => {
    setup();
    const source = createCollectionSource("posts");
    const { rows, total } = await source.rows();
    expect(total).toBe(2);
    const hello = rows.find((r) => r.key === "content/posts/hello.md")!;
    expect(hello.cells[PATH_FIELD]).toBe("content/posts/hello.md");
    expect(hello.cells.title).toBe("Hello");
    expect(hello.cells.tags).toEqual(["a", "b"]);
    expect(hello.cells.draft).toBe(false);
    expect(hello.fingerprint).toBe(HELLO_MD);
  });

  test("row order follows the sorted paths, not the order the reads finished", async () => {
    /*
     * The regression: `load()` populated its `entries` Map from inside `mapLimit`'s worker, so the
     * Map's insertion order — which is the order the grid renders — was the order eight concurrent
     * `readFile` calls happened to RESOLVE in. `hello.md` and `world.md` swapped places between
     * runs, and that alone rewrote `blog-grid.png` in 3 of the 21 images the screenshot lane pushed
     * across 24 commits.
     *
     * So the read that comes FIRST alphabetically is made to finish LAST here. Under the old code
     * that produced world-then-hello; the order must now be hello-then-world regardless.
     */
    const seen: string[] = [];
    setup({}, {
      readFile: async (path: string) => {
        seen.push(path);
        if (path.endsWith("hello.md")) {
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
          return HELLO_MD;
        }
        return WORLD_MD;
      },
    } as unknown as Partial<StudioPlatform>);

    const { rows } = await createCollectionSource("posts").rows();
    expect(rows.map((row) => row.key)).toEqual([
      "content/posts/hello.md",
      "content/posts/world.md",
    ]);
    // The delay has to have actually been exercised, or the test proves nothing.
    expect(seen).toContain("content/posts/hello.md");
  });

  test("an unknown collection surfaces as a load error", async () => {
    setup();
    const source = createCollectionSource("ghosts");
    expect(source.rows()).rejects.toThrow('No content collection named "ghosts"');
  });
});

describe("commit — cell edits", () => {
  test("rewrites only the touched file, preserving body and other keys", async () => {
    const state = setup();
    const source = createCollectionSource("posts");
    await source.rows();

    const result = await source.commit({
      cells: [
        {
          baseline: "Hello",
          field: "title",
          rowKey: "content/posts/hello.md",
          value: "Hey there",
        },
        { baseline: ["a", "b"], field: "tags", rowKey: "content/posts/hello.md", value: ["x"] },
      ],
      deletes: [],
      inserts: [],
    });
    expect(result.cells.every((c) => c.ok)).toBeTrue();

    const written = state.files.get("content/posts/hello.md")!;
    expect(written).toContain("title: Hey there");
    expect(written).toContain("- x");
    expect(written).toContain("Body text");
    expect(state.files.get("content/posts/world.md")).toBe(WORLD_MD); // Untouched.

    const { rows } = await source.rows();
    expect(rows.find((r) => r.key === "content/posts/hello.md")!.cells.title).toBe("Hey there");
  });

  test("clearing a cell removes the frontmatter key", async () => {
    const state = setup();
    const source = createCollectionSource("posts");
    await source.rows();
    const result = await source.commit({
      cells: [{ baseline: false, field: "draft", rowKey: "content/posts/hello.md", value: null }],
      deletes: [],
      inserts: [],
    });
    expect(result.cells[0]!.ok).toBeTrue();
    expect(state.files.get("content/posts/hello.md")).not.toContain("draft:");
  });

  test("a file changed on disk is skipped as stale and never clobbered", async () => {
    // A dedicated entry file: markLocalMutation's recent-write window is module state, so paths
    // Written by other tests in this file would mask the external change as our own echo.
    const state = setup({ "content/posts/stale-target.md": "---\ntitle: Original\n---\n" });
    const source = createCollectionSource("posts");
    await source.rows();
    state.files.set("content/posts/stale-target.md", "---\ntitle: External\n---\n");

    const result = await source.commit({
      cells: [
        {
          baseline: "Original",
          field: "title",
          rowKey: "content/posts/stale-target.md",
          value: "Mine",
        },
      ],
      deletes: [],
      inserts: [],
    });
    expect(result.cells[0]!.ok).toBeFalse();
    expect(result.cells[0]!.stale).toBeTrue();
    expect(state.files.get("content/posts/stale-target.md")).toBe("---\ntitle: External\n---\n");
  });

  test("a dirty open tab blocks that row; other rows still commit", async () => {
    const state = setup();
    const source = createCollectionSource("posts");
    await source.rows();
    const tab = openTab({
      document: { tagName: "div" },
      documentPath: "content/posts/hello.md",
      id: "content/posts/hello.md",
    });
    tab.doc.dirty = true;

    const result = await source.commit({
      cells: [
        { baseline: "Hello", field: "title", rowKey: "content/posts/hello.md", value: "Nope" },
        { baseline: "World", field: "title", rowKey: "content/posts/world.md", value: "Earth" },
      ],
      deletes: [],
      inserts: [],
    });
    const hello = result.cells.find((c) => c.rowKey === "content/posts/hello.md")!;
    const world = result.cells.find((c) => c.rowKey === "content/posts/world.md")!;
    expect(hello.ok).toBeFalse();
    expect(hello.error).toContain("unsaved changes");
    expect(world.ok).toBeTrue();
    expect(state.files.get("content/posts/hello.md")).toBe(HELLO_MD);
    expect(state.files.get("content/posts/world.md")).toContain("title: Earth");
  });
});

describe("commit — inserts and deletes", () => {
  test("inserts write a new entry file from the Path cell (dir and extension enforced)", async () => {
    const state = setup();
    const source = createCollectionSource("posts");
    await source.rows();

    const result = await source.commit({
      cells: [],
      deletes: [],
      inserts: [{ cells: { [PATH_FIELD]: "fresh", tags: ["new"], title: "Fresh" }, tempKey: "t1" }],
    });
    expect(result.inserts[0]).toEqual({
      newKey: "content/posts/fresh.md",
      ok: true,
      tempKey: "t1",
    });
    const written = state.files.get("content/posts/fresh.md")!;
    expect(written).toContain("title: Fresh");
    expect(written).toContain("- new");

    const { rows } = await source.rows();
    expect(rows.some((r) => r.key === "content/posts/fresh.md")).toBeTrue();
  });

  test("insert validation: missing path and duplicate paths fail", async () => {
    setup();
    const source = createCollectionSource("posts");
    await source.rows();
    const result = await source.commit({
      cells: [],
      deletes: [],
      inserts: [
        { cells: { title: "No path" }, tempKey: "t1" },
        { cells: { [PATH_FIELD]: "hello", title: "Dup" }, tempKey: "t2" },
      ],
    });
    expect(result.inserts[0]!.error).toContain("Path is required");
    expect(result.inserts[1]!.error).toContain("already exists");
  });

  test("deletes remove entry files, but never while a tab is open on them", async () => {
    const state = setup();
    const source = createCollectionSource("posts");
    await source.rows();
    openTab({
      document: { tagName: "div" },
      documentPath: "content/posts/world.md",
      id: "content/posts/world.md",
    });

    const result = await source.commit({
      cells: [],
      deletes: [{ rowKey: "content/posts/hello.md" }, { rowKey: "content/posts/world.md" }],
      inserts: [],
    });
    const hello = result.deletes.find((d) => d.rowKey === "content/posts/hello.md")!;
    const world = result.deletes.find((d) => d.rowKey === "content/posts/world.md")!;
    expect(hello.ok).toBeTrue();
    expect(state.files.has("content/posts/hello.md")).toBeFalse();
    expect(world.ok).toBeFalse();
    expect(world.error).toContain("close it first");
    expect(state.files.has("content/posts/world.md")).toBeTrue();
  });
});

describe("refresh and backing paths", () => {
  test("refresh picks up new and removed entries", async () => {
    const state = setup();
    const source = createCollectionSource("posts");
    const first = await source.rows();
    expect(first.total).toBe(2);

    state.files.set("content/posts/third.md", "---\ntitle: Third\n---\n");
    const cached = await source.rows();
    expect(cached.total).toBe(2); // Cached until refresh.
    await source.refresh!();
    const refreshed = await source.rows();
    expect(refreshed.total).toBe(3);
  });

  test("backingPaths maps every entry path to its row key", async () => {
    setup();
    const source = createCollectionSource("posts");
    await source.rows();
    const backing = source.backingPaths!();
    expect(backing.get("content/posts/hello.md")).toBe("content/posts/hello.md");
    expect(backing.size).toBe(2);
  });
});

describe("the draft perspective (§7.6)", () => {
  const DRAFTED_MD = "---\ntitle: Drafted\ndraft: true\n---\n\nNot ready\n";

  test("the Draft column sits immediately after Path, and is the schema's own column", async () => {
    setup();
    const columns = await createCollectionSource("posts").columns();
    expect(columns.map((c) => c.field).slice(0, 2)).toEqual([PATH_FIELD, "draft"]);
    // Moved, never duplicated: still the typed column `columnsFromSchema` built.
    expect(columns.filter((c) => c.field === "draft")).toHaveLength(1);
    expect(columns.find((c) => c.field === "draft")!.kind).toBe("boolean");
  });

  test("a collection with no draft axis gets no Draft column", async () => {
    setup();
    // `authors` declares `schema: {}` and none of its entries exist, so there is no axis at all.
    const columns = await createCollectionSource("authors").columns();
    expect(columns.map((c) => c.field)).not.toContain("draft");
  });

  test("an entry that carries `draft: true` without a schema saying so still gets the column", async () => {
    setup({ "content/authors/ada.md": DRAFTED_MD });
    const columns = await createCollectionSource("authors").columns();
    expect(columns.map((c) => c.field).slice(0, 2)).toEqual([PATH_FIELD, "draft"]);
  });

  test("drafts are hidden by default and listed when the perspective says so", async () => {
    setup({ "content/posts/drafted.md": DRAFTED_MD });
    const source = createCollectionSource("posts");

    const hidden = await source.rows();
    expect(hidden.rows.map((r) => r.key)).not.toContain("content/posts/drafted.md");
    expect(hidden.total).toBe(2);

    setIncludeDrafts(true);
    const shown = await source.rows();
    expect(shown.rows.map((r) => r.key)).toContain("content/posts/drafted.md");
    expect(shown.total).toBe(3);
  });

  test("the hidden entry is still LOADED — the filter is on the listing, not the read", async () => {
    setup({ "content/posts/drafted.md": DRAFTED_MD });
    const source = createCollectionSource("posts");
    await source.rows();
    // A row the listing hides is still committable and still backs a path, which is what lets the
    // Perspective flip back on without re-walking the directory.
    expect([...source.backingPaths!().keys()]).toContain("content/posts/drafted.md");
  });

  test("the pages tree is NOT draft-filtered — a page has no collection to explain the gap", async () => {
    setup({
      "pages/hidden.md": DRAFTED_MD,
      "pages/index.md": "---\ntitle: Home\n---\n",
    });
    const { rows } = await createPagesSource().rows();
    expect(rows.map((r) => r.key)).toEqual(["pages/hidden.md", "pages/index.md"]);
  });
});

describe("pages source", () => {
  test("lists format-class pages with inferred columns (title/description first)", async () => {
    setup({
      "pages/about.md": "---\ntitle: About\nlayout: base\ndescription: Who we are\n---\n\nBody\n",
      "pages/index.md": "---\ntitle: Home\ndraft: false\n---\n\nWelcome\n",
      "pages/nested/deep.md": "---\ntitle: Deep\n---\n",
      "pages/plain.json": "{}",
    });
    const source = createPagesSource();
    expect(source.id).toBe("grid://pages");
    const { rows, total } = await source.rows();
    expect(total).toBe(3); // .json pages are excluded.
    expect(rows.map((r) => r.key)).toEqual([
      "pages/about.md",
      "pages/index.md",
      "pages/nested/deep.md",
    ]);

    const columns = await source.columns();
    expect(columns[0]!.field).toBe(PATH_FIELD);
    expect(columns[1]!.field).toBe("title");
    expect(columns[2]!.field).toBe("description");
    expect(columns.find((c) => c.field === "draft")!.kind).toBe("boolean");
  });

  test("edits patch page frontmatter; inserts land under pages/ with a page extension", async () => {
    const state = setup({ "pages/index.md": "---\ntitle: Home\n---\n\nWelcome\n" });
    const source = createPagesSource();
    await source.rows();

    const edit = await source.commit({
      cells: [{ baseline: "Home", field: "title", rowKey: "pages/index.md", value: "Start" }],
      deletes: [],
      inserts: [],
    });
    expect(edit.cells[0]!.ok).toBeTrue();
    expect(state.files.get("pages/index.md")).toContain("title: Start");
    expect(state.files.get("pages/index.md")).toContain("Welcome");

    const insert = await source.commit({
      cells: [],
      deletes: [],
      inserts: [{ cells: { [PATH_FIELD]: "landing", title: "Landing" }, tempKey: "t1" }],
    });
    expect(insert.inserts[0]).toEqual({ newKey: "pages/landing.md", ok: true, tempKey: "t1" });
    expect(state.files.get("pages/landing.md")).toContain("title: Landing");
  });
});
