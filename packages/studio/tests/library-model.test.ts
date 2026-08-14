/**
 * Tests for src/browse/library-model.ts — the scan, the categories, and the two derived axes.
 *
 * The load-bearing one is "a directory it could not read is reported, not swallowed". That single
 * `catch {}` in the predecessor is why an HTTP 500 and an empty project rendered the same sentence,
 * and why a reader could not tell a broken dev server from a new site.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { resetStudioState } from "./harness";
import {
  LIBRARY_CATEGORIES,
  LIBRARY_CATEGORY_KEYS,
  LIBRARY_LAYOUTS,
  LIBRARY_LAYOUT_LABELS,
  PREVIEW_LAYOUTS,
  categoryFor,
  contentTypeFor,
  filterLibrary,
  groupByCategory,
  groupByDate,
  isLibraryLayout,
  libraryCategory,
  libraryDate,
  scanLibrary,
  uploadDirForCategory,
} from "../src/browse/library-model";
import type { LibraryFile } from "../src/browse/library-model";
import type { DirEntry } from "../src/types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function file(name: string, path: string, extra: Partial<DirEntry> = {}): DirEntry {
  return { name, path, type: "file", ...extra };
}
function dir(name: string, path: string): DirEntry {
  return { name, path, type: "directory" };
}

const TREE: Record<string, DirEntry[]> = {
  components: [file("button.json", "components/button.json")],
  content: [dir("posts", "content/posts")],
  "content/posts": [
    file("2024-01-02-hello.md", "content/posts/2024-01-02-hello.md", { size: 2048 }),
    file("draft.md", "content/posts/draft.md"),
  ],
  pages: [
    file("index.json", "pages/index.json", { modified: "2024-03-04T10:00:00.000Z", size: 120 }),
    dir("node_modules", "pages/node_modules"),
  ],
  public: [file("logo.png", "public/logo.png")],
};

function listDirectory(tree: Record<string, DirEntry[]> = TREE) {
  return (path: string) => {
    const entries = tree[path];
    if (!entries) {
      return Promise.reject(new Error(`ENOENT: ${path}`));
    }
    return Promise.resolve(entries);
  };
}

beforeEach(() => {
  resetStudioState({
    projectConfig: {
      content: { drafts: {}, posts: { source: "./content/posts/" } },
    },
    projectDirs: ["pages", "content", "components", "public"],
  });
});

// ─── Categories ──────────────────────────────────────────────────────────────

describe("categories", () => {
  test("media wins over the directory it happens to sit in", () => {
    expect(categoryFor("pages/hero.png", ".png")).toBe("Media");
  });

  test("maps every conventional directory, and admits when it cannot", () => {
    expect(categoryFor("pages/a.json", ".json")).toBe("Pages");
    expect(categoryFor("layouts/a.json", ".json")).toBe("Layouts");
    expect(categoryFor("components/a.json", ".json")).toBe("Components");
    expect(categoryFor("content/a.md", ".md")).toBe("Content");
    expect(categoryFor("public/a.txt", ".txt")).toBe("Media");
    expect(categoryFor("data/a.json", ".json")).toBe("Content");
    expect(categoryFor("styles/a.json", ".json")).toBe("Components");
    expect(categoryFor("scripts/a.sh", ".sh")).toBe("Other");
  });

  test("the content type of a path comes from project.json, capitalized", () => {
    expect(contentTypeFor("content/posts/hello.md")).toBe("Posts");
    expect(contentTypeFor("content/other/hello.md")).toBeNull();
  });

  test("a collection with no source declares no paths", () => {
    expect(contentTypeFor("drafts/x.md")).toBeNull();
  });

  test("only All has no upload destination — and that is why it has to ask", () => {
    const withoutDir = LIBRARY_CATEGORIES.filter((c) => c.dir === undefined).map((c) => c.key);
    expect(withoutDir).toEqual(["all"]);
    expect(uploadDirForCategory("all")).toBeUndefined();
    expect(uploadDirForCategory("media")).toBe("public");
    expect(uploadDirForCategory("nonsense")).toBeUndefined();
  });

  test("the declared key list is what a command's enum refuses against", () => {
    expect(LIBRARY_CATEGORY_KEYS).toEqual(LIBRARY_CATEGORIES.map((c) => c.key));
    expect(libraryCategory("pages")?.label).toBe("Pages");
    expect(libraryCategory("gone")).toBeUndefined();
  });
});

// ─── The scan ────────────────────────────────────────────────────────────────

describe("scanLibrary", () => {
  test("walks nested directories and types every file it finds", async () => {
    const scan = await scanLibrary(["pages", "content", "components", "public"], {
      listDirectory: listDirectory(),
    });
    expect(scan.failures).toEqual([]);
    expect(scan.files.map((f) => f.path)).toEqual([
      "components/button.json",
      "content/posts/2024-01-02-hello.md",
      "content/posts/draft.md",
      "pages/index.json",
      "public/logo.png",
    ]);
    const post = scan.files.find((f) => f.name === "draft.md")!;
    expect(post.category).toBe("Content");
    expect(post.type).toBe("Posts");
  });

  test("carries size and modification time through when the platform reports them", async () => {
    const scan = await scanLibrary(["pages"], { listDirectory: listDirectory() });
    expect(scan.files[0]).toMatchObject({
      modified: "2024-03-04T10:00:00.000Z",
      size: 120,
    });
  });

  test("REPORTS a directory it could not read instead of contributing nothing", async () => {
    const scan = await scanLibrary(["pages", "missing"], { listDirectory: listDirectory() });
    expect(scan.files.length).toBe(1);
    expect(scan.failures).toEqual([{ dir: "missing", error: "ENOENT: missing" }]);
  });

  test("a failure at depth names the directory that failed, not its root", async () => {
    const tree: Record<string, DirEntry[]> = {
      content: [dir("posts", "content/posts")],
    };
    const scan = await scanLibrary(["content"], { listDirectory: listDirectory(tree) });
    expect(scan.failures.map((f) => f.dir)).toEqual(["content/posts"]);
  });

  test("never rejects — a half-scan is a real answer the caller must be able to render", async () => {
    const scan = await scanLibrary(["nope"], {
      listDirectory: () => Promise.reject(new Error("boom")),
    });
    expect(scan.files).toEqual([]);
    expect(scan.failures.length).toBe(1);
  });

  test("does not walk node_modules and friends", async () => {
    const asked: string[] = [];
    await scanLibrary(["pages"], {
      listDirectory: (path: string) => {
        asked.push(path);
        return listDirectory()(path);
      },
    });
    expect(asked).toEqual(["pages"]);
  });

  test("a file with no extension still gets a type", async () => {
    const tree: Record<string, DirEntry[]> = { misc: [file("Makefile", "misc/Makefile")] };
    const scan = await scanLibrary(["misc"], { listDirectory: listDirectory(tree) });
    expect(scan.files[0]!.type).toBe("file");
  });

  test("a content file outside every declared collection falls back to its extension", async () => {
    const tree: Record<string, DirEntry[]> = { content: [file("note.md", "content/note.md")] };
    const scan = await scanLibrary(["content"], { listDirectory: listDirectory(tree) });
    expect(scan.files[0]!.type).toBe(".md");
  });
});

// ─── Filtering ───────────────────────────────────────────────────────────────

describe("filterLibrary", () => {
  const files: LibraryFile[] = [
    { category: "Pages", ext: ".json", name: "index.json", path: "pages/index.json", type: "." },
    { category: "Media", ext: ".png", name: "logo.png", path: "public/logo.png", type: ".png" },
  ];

  test("all + empty query is the identity, and does not copy the array", () => {
    expect(filterLibrary(files, { category: "all", query: "" })).toBe(files);
  });

  test("filters by category label, not by key", () => {
    expect(filterLibrary(files, { category: "media", query: "" }).map((f) => f.name)).toEqual([
      "logo.png",
    ]);
  });

  test("matches the query against name AND path, case-insensitively", () => {
    expect(filterLibrary(files, { category: "all", query: "PUBLIC" }).length).toBe(1);
    expect(filterLibrary(files, { category: "all", query: "  index " }).length).toBe(1);
  });

  test("an unknown category filters nothing rather than everything", () => {
    expect(filterLibrary(files, { category: "gone", query: "" }).length).toBe(2);
  });
});

// ─── Layouts ─────────────────────────────────────────────────────────────────

describe("layouts", () => {
  test("every layout has a label, and only the two visual ones draw previews", () => {
    for (const layout of LIBRARY_LAYOUTS) {
      expect(LIBRARY_LAYOUT_LABELS[layout]).toBeTruthy();
    }
    expect([...PREVIEW_LAYOUTS].toSorted()).toEqual(["cards", "media"]);
  });

  test("isLibraryLayout is the guard the setter refuses through", () => {
    expect(isLibraryLayout("board")).toBe(true);
    expect(isLibraryLayout("gallery")).toBe(false);
  });
});

// ─── Derived axes ────────────────────────────────────────────────────────────

describe("libraryDate", () => {
  const base: LibraryFile = {
    category: "Content",
    ext: ".md",
    name: "post.md",
    path: "content/post.md",
    type: "Posts",
  };

  test("the authored date in the filename wins over the filesystem's mtime", () => {
    expect(
      libraryDate({
        ...base,
        modified: "2020-01-01T00:00:00.000Z",
        name: "2024-01-02-hello.md",
      }),
    ).toBe("2024-01-02");
  });

  test("falls back to the modification time", () => {
    expect(libraryDate({ ...base, modified: "2024-05-06T12:00:00.000Z" })).toBe("2024-05-06");
  });

  test("a file with neither is undated — it is NOT parked on today", () => {
    expect(libraryDate(base)).toBeNull();
    expect(libraryDate({ ...base, modified: "not a date" })).toBeNull();
  });
});

describe("grouping", () => {
  const files: LibraryFile[] = [
    { category: "Content", ext: ".md", name: "2024-01-02-a.md", path: "c/a.md", type: "Posts" },
    { category: "Content", ext: ".md", name: "2024-03-04-b.md", path: "c/b.md", type: "Posts" },
    { category: "Content", ext: ".md", name: "2024-01-02-c.md", path: "c/c.md", type: "Posts" },
    { category: "Pages", ext: ".json", name: "index.json", path: "pages/index.json", type: "." },
  ];

  test("days come back newest first, with the undated set apart", () => {
    const { days, undated } = groupByDate(files);
    expect(days.map((d) => d.date)).toEqual(["2024-03-04", "2024-01-02"]);
    expect(days[1]!.files.length).toBe(2);
    expect(undated.map((f) => f.name)).toEqual(["index.json"]);
  });

  test("board columns follow the Library's own category order, unknown ones last", () => {
    const withOther: LibraryFile[] = [
      ...files,
      { category: "Other", ext: ".sh", name: "x.sh", path: "bin/x.sh", type: ".sh" },
      { category: "Media", ext: ".png", name: "l.png", path: "public/l.png", type: ".png" },
    ];
    expect(groupByCategory(withOther).map((g) => g.group)).toEqual([
      "Pages",
      "Content",
      "Media",
      "Other",
    ]);
  });

  test("two unordered groups sort by name rather than arbitrarily", () => {
    const odd: LibraryFile[] = [
      { category: "Zebra", ext: "", name: "z", path: "z", type: "" },
      { category: "Alpha", ext: "", name: "a", path: "a", type: "" },
    ];
    expect(groupByCategory(odd).map((g) => g.group)).toEqual(["Alpha", "Zebra"]);
  });
});
