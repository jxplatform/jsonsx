import { installMockPlatform, resetStudioState } from "./harness";
import { describe, expect, mock, test } from "bun:test";
import {
  applyFsEvents,
  isRecentLocal,
  markLocalMutation,
  startFsSync,
} from "../src/files/fs-events";
import { invalidateUsages, loadUsages } from "../src/services/references";
import type { DirEntry, FsEvent } from "../src/types";

const entry = (path: string, type: "file" | "directory" = "file"): DirEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  type,
});

const sleep = (ms: number) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

describe("applyFsEvents", () => {
  test("adds new files to a loaded parent and dedupes echoes", () => {
    const dirs = new Map<string, DirEntry[]>([["pages", [entry("pages/a.json")]]]);
    const changed = applyFsEvents(dirs, new Set(), [
      { isDir: false, path: "pages/b.json", type: "add" },
      { isDir: false, path: "pages/a.json", type: "add" },
    ]);
    expect(dirs.get("pages")?.map((e) => e.path)).toEqual(["pages/a.json", "pages/b.json"]);
    expect([...changed]).toEqual(["pages"]);
  });

  test("ignores adds for an unloaded parent", () => {
    const dirs = new Map<string, DirEntry[]>();
    const changed = applyFsEvents(dirs, new Set(), [
      { isDir: false, path: "pages/x.json", type: "add" },
    ]);
    expect(changed.size).toBe(0);
    expect(dirs.has("pages")).toBe(false);
  });

  test("addDir splices into the loaded parent and seeds an empty list", () => {
    const dirs = new Map<string, DirEntry[]>([[".", [entry("pages", "directory")]]]);
    applyFsEvents(dirs, new Set(), [{ isDir: true, path: "widgets", type: "addDir" }]);
    expect(dirs.get(".")?.some((e) => e.path === "widgets")).toBe(true);
    expect(dirs.get("widgets")).toEqual([]);
  });

  test("unlink removes a tree entry", () => {
    const dirs = new Map<string, DirEntry[]>([
      ["pages", [entry("pages/a.json"), entry("pages/b.json")]],
    ]);
    const changed = applyFsEvents(dirs, new Set(), [
      { isDir: false, path: "pages/a.json", type: "unlink" },
    ]);
    expect(dirs.get("pages")?.map((e) => e.path)).toEqual(["pages/b.json"]);
    expect([...changed]).toEqual(["pages"]);
  });

  test("unlinkDir prunes nested dirs and expanded keys", () => {
    const dirs = new Map<string, DirEntry[]>([
      [".", [entry("sub", "directory")]],
      ["sub", [entry("sub/x.json")]],
      ["sub/deep", [entry("sub/deep/y.json")]],
    ]);
    const expanded = new Set(["sub", "sub/deep"]);
    applyFsEvents(dirs, expanded, [{ isDir: true, path: "sub", type: "unlinkDir" }]);
    expect(dirs.has("sub")).toBe(false);
    expect(dirs.has("sub/deep")).toBe(false);
    expect(dirs.get(".")?.some((e) => e.path === "sub")).toBe(false);
    expect(expanded.size).toBe(0);
  });

  test("change events touch no tree state", () => {
    const dirs = new Map<string, DirEntry[]>([["pages", [entry("pages/a.json")]]]);
    const changed = applyFsEvents(dirs, new Set(), [
      { isDir: false, path: "pages/a.json", type: "change" },
    ]);
    expect(changed.size).toBe(0);
    expect(dirs.get("pages")).toHaveLength(1);
  });
});

describe("markLocalMutation / isRecentLocal", () => {
  test("marks and detects recently mutated paths", () => {
    markLocalMutation("mark/x.json", "mark/y.json");
    expect(isRecentLocal("mark/x.json")).toBe(true);
    expect(isRecentLocal("mark/y.json")).toBe(true);
    expect(isRecentLocal("mark/z.json")).toBe(false);
  });
});

describe("startFsSync", () => {
  test("is a no-op when the platform has no watcher", () => {
    installMockPlatform();
    const stop = startFsSync({ renderLeftPanel: () => {} });
    expect(typeof stop).toBe("function");
    stop();
  });

  test("debounces a burst into one render and reloads on content change", async () => {
    let handler: (events: FsEvent[]) => void = () => {};
    installMockPlatform({
      subscribeFileEvents: (h) => {
        handler = h;
        return () => {};
      },
    });
    resetStudioState({ dirs: new Map([["burst", [entry("burst/a.json")]]]), expanded: new Set() });
    const renders: number[] = [];
    const changed: string[] = [];
    const stop = startFsSync({
      onContentChange: (p) => changed.push(p),
      renderLeftPanel: () => renders.push(1),
    });
    handler([{ isDir: false, path: "burst/b.json", type: "add" }]);
    handler([{ isDir: false, path: "burst/a.json", type: "change" }]);
    await sleep(70);
    expect(renders).toHaveLength(1);
    expect(changed).toEqual(["burst/a.json"]);
    stop();
  });

  test("drops the usage cache on any event, including the ones the tree suppresses", async () => {
    let handler: (events: FsEvent[]) => void = () => {};
    const findReferences = mock(async () => ({
      errors: [],
      files: [],
      filesReferencing: 0,
      path: "a.json",
      refsTotal: 0,
      tagName: null,
    }));
    installMockPlatform({
      findReferences: findReferences as never,
      subscribeFileEvents: (h) => {
        handler = h;
        return () => {};
      },
    });
    resetStudioState({ dirs: new Map(), expanded: new Set() });
    invalidateUsages();
    const stop = startFsSync({ renderLeftPanel: () => {} });

    await loadUsages({ path: "a.json" });
    await loadUsages({ path: "a.json" });
    expect(findReferences).toHaveBeenCalledTimes(1);

    // A LOCAL mutation: the tree ignores its echo (it already repainted), but the reference count
    // Must not — Studio's own write changes who refers to what as much as anyone else's.
    markLocalMutation("a.json");
    handler([{ isDir: false, path: "a.json", type: "change" }]);
    await loadUsages({ path: "a.json" });
    expect(findReferences).toHaveBeenCalledTimes(2);
    stop();
  });

  test("drops the derived caches on every event, echoes included", () => {
    let handler: (events: FsEvent[]) => void = () => {};
    installMockPlatform({
      subscribeFileEvents: (h) => {
        handler = h;
        return () => {};
      },
    });
    resetStudioState({ dirs: new Map(), expanded: new Set() });
    let drops = 0;
    const stop = startFsSync({
      invalidateDerivedCaches: () => {
        drops += 1;
      },
      renderLeftPanel: () => {},
    });

    // Same argument as the usage counts above, and the same placement — BEFORE the echo filter.
    // The page-route list, the layout picker and the `$paths` enumerations are all derived from
    // Which files exist, and Studio's own write changes that as much as anyone else's does.
    markLocalMutation("pages/new.md");
    handler([{ isDir: false, path: "pages/new.md", type: "add" }]);
    expect(drops).toBe(1);

    handler([{ isDir: false, path: "layouts/base.json", type: "unlink" }]);
    expect(drops).toBe(2);
    stop();
  });

  test("suppresses echoes of recent local mutations", async () => {
    let handler: (events: FsEvent[]) => void = () => {};
    installMockPlatform({
      subscribeFileEvents: (h) => {
        handler = h;
        return () => {};
      },
    });
    resetStudioState({ dirs: new Map([["sup", [entry("sup/a.json")]]]), expanded: new Set() });
    markLocalMutation("sup/local.json");
    const renders: number[] = [];
    const stop = startFsSync({ renderLeftPanel: () => renders.push(1) });
    handler([{ isDir: false, path: "sup/local.json", type: "add" }]);
    await sleep(70);
    expect(renders).toHaveLength(0);
    stop();
  });
});
