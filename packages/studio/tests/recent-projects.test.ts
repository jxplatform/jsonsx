/**
 * Tests for src/recent-projects.ts — localStorage-backed recent project/file tracking.
 *
 * Date.now is mocked with a monotonic counter so ordering and cap assertions are deterministic.
 */
import { installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  addRecentProject,
  clearRecentProjects,
  getRecentFiles,
  getRecentProjects,
  hydrateRecentProjects,
  removeRecentProject,
  trackRecentFile,
} from "../src/recent-projects";
import type { RecentProjectEntry, StudioPlatform } from "../src/types";

const PROJECTS_KEY = "jx-studio-recent-projects";
const FILES_KEY = "jx-studio-recent-files";

/** Drop any platform a prior test registered so backend()/hasPlatform() default to localStorage. */
function clearPlatform() {
  delete (globalThis as { __jxPlatform?: StudioPlatform }).__jxPlatform;
}

let now = 1_000_000;
let nowSpy: ReturnType<typeof spyOn<DateConstructor, "now">>;

beforeEach(() => {
  clearPlatform();
  localStorage.clear();
  now = 1_000_000;
  nowSpy = spyOn(Date, "now").mockImplementation(() => {
    now += 1000;
    return now;
  });
});

afterEach(() => {
  nowSpy.mockRestore();
  localStorage.clear();
  clearPlatform();
});

describe("getRecentProjects", () => {
  test("returns [] when nothing is stored", () => {
    expect(getRecentProjects()).toEqual([]);
  });

  test("returns [] when stored JSON is corrupt", () => {
    localStorage.setItem(PROJECTS_KEY, "{not json");
    expect(getRecentProjects()).toEqual([]);
  });

  test("sorts stored entries by timestamp descending", () => {
    localStorage.setItem(
      PROJECTS_KEY,
      JSON.stringify([
        { name: "oldest", root: "/a", timestamp: 1 },
        { name: "newest", root: "/b", timestamp: 30 },
        { name: "middle", root: "/c", timestamp: 20 },
      ]),
    );
    expect(getRecentProjects().map((p) => p.name)).toEqual(["newest", "middle", "oldest"]);
  });
});

describe("addRecentProject", () => {
  test("adds an entry with name, root, and timestamp", () => {
    addRecentProject("Demo", "/projects/demo");
    const projects = getRecentProjects();
    expect(projects.length).toBe(1);
    expect(projects[0]!.name).toBe("Demo");
    expect(projects[0]!.root).toBe("/projects/demo");
    expect(typeof projects[0]!.timestamp).toBe("number");
  });

  test("most recently added project comes first", () => {
    addRecentProject("First", "/p/first");
    addRecentProject("Second", "/p/second");
    expect(getRecentProjects().map((p) => p.name)).toEqual(["Second", "First"]);
  });

  test("re-adding the same root dedupes and refreshes name and timestamp", () => {
    addRecentProject("Old Name", "/p/demo");
    addRecentProject("Other", "/p/other");
    addRecentProject("New Name", "/p/demo");
    const projects = getRecentProjects();
    expect(projects.length).toBe(2);
    expect(projects[0]!.name).toBe("New Name");
    expect(projects[0]!.root).toBe("/p/demo");
    expect(projects[1]!.name).toBe("Other");
  });

  test("caps the list at 8 entries, dropping the oldest", () => {
    for (let i = 1; i <= 10; i++) {
      addRecentProject(`p${i}`, `/p/${i}`);
    }
    const projects = getRecentProjects();
    expect(projects.length).toBe(8);
    expect(projects[0]!.name).toBe("p10");
    expect(projects[7]!.name).toBe("p3");
    expect(projects.some((p) => p.name === "p1" || p.name === "p2")).toBe(false);
  });
});

describe("removeRecentProject", () => {
  test("drops the matching entry and leaves the rest", () => {
    addRecentProject("First", "/p/first");
    addRecentProject("Second", "/p/second");
    removeRecentProject("/p/first");
    expect(getRecentProjects().map((p) => p.name)).toEqual(["Second"]);
  });

  test("is a no-op when the root is not present", () => {
    addRecentProject("Only", "/p/only");
    removeRecentProject("/p/missing");
    expect(getRecentProjects().map((p) => p.name)).toEqual(["Only"]);
  });
});

describe("clearRecentProjects", () => {
  test("removes all stored projects but leaves recent files alone", () => {
    addRecentProject("Demo", "/p/demo");
    trackRecentFile({ name: "index.json", path: "/p/demo/index.json" });
    clearRecentProjects();
    expect(getRecentProjects()).toEqual([]);
    expect(getRecentFiles().length).toBe(1);
  });

  test("is a no-op when nothing is stored", () => {
    clearRecentProjects();
    expect(getRecentProjects()).toEqual([]);
  });
});

describe("backend-persisted store (desktop/chromium)", () => {
  /** Install a mock platform whose recent-projects methods read/write an in-memory array. */
  function installBackend(seed: RecentProjectEntry[] = []) {
    let store = [...seed];
    const overrides: Partial<StudioPlatform> = {
      getRecentProjects: async () => [...store],
      saveRecentProjects: async (projects) => {
        store = [...projects];
      },
    };
    installMockPlatform(overrides);
    return {
      get: () => store,
    };
  }

  test("hydrate loads the list from the backend into the synchronous cache", async () => {
    installBackend([{ name: "Seeded", root: "/p/seeded", timestamp: 5 }]);
    await hydrateRecentProjects();
    expect(getRecentProjects().map((p) => p.name)).toEqual(["Seeded"]);
  });

  test("hydrate falls back to an empty list when the backend rejects", async () => {
    installMockPlatform({
      getRecentProjects: async () => {
        throw new Error("backend down");
      },
      saveRecentProjects: async () => {},
    });
    await hydrateRecentProjects();
    expect(getRecentProjects()).toEqual([]);
  });

  test("addRecentProject writes through to the backend, not localStorage", async () => {
    const backend = installBackend();
    await hydrateRecentProjects();
    addRecentProject("Demo", "/p/demo");
    expect(backend.get().map((p) => p.root)).toEqual(["/p/demo"]);
    expect(localStorage.getItem(PROJECTS_KEY)).toBeNull();
    expect(getRecentProjects().map((p) => p.name)).toEqual(["Demo"]);
  });

  test("removeRecentProject and clearRecentProjects persist through the backend", async () => {
    const backend = installBackend();
    await hydrateRecentProjects();
    addRecentProject("First", "/p/first");
    addRecentProject("Second", "/p/second");
    removeRecentProject("/p/first");
    expect(backend.get().map((p) => p.root)).toEqual(["/p/second"]);
    clearRecentProjects();
    expect(backend.get()).toEqual([]);
    expect(getRecentProjects()).toEqual([]);
  });
});

describe("getRecentFiles", () => {
  test("returns [] when nothing is stored", () => {
    expect(getRecentFiles()).toEqual([]);
  });

  test("returns [] when stored JSON is corrupt", () => {
    localStorage.setItem(FILES_KEY, "[broken");
    expect(getRecentFiles()).toEqual([]);
  });

  test("sorts stored entries by timestamp descending", () => {
    localStorage.setItem(
      FILES_KEY,
      JSON.stringify([
        { name: "a.json", path: "/a.json", timestamp: 5 },
        { name: "c.json", path: "/c.json", timestamp: 50 },
        { name: "b.json", path: "/b.json", timestamp: 25 },
      ]),
    );
    expect(getRecentFiles().map((f) => f.name)).toEqual(["c.json", "b.json", "a.json"]);
  });
});

describe("trackRecentFile", () => {
  test("adds an entry with path, name, and timestamp", () => {
    trackRecentFile({ name: "page.json", path: "/site/page.json" });
    const files = getRecentFiles();
    expect(files.length).toBe(1);
    expect(files[0]!.path).toBe("/site/page.json");
    expect(files[0]!.name).toBe("page.json");
    expect(typeof files[0]!.timestamp).toBe("number");
  });

  test("re-tracking the same path dedupes and moves it to the front", () => {
    trackRecentFile({ name: "a.json", path: "/a.json" });
    trackRecentFile({ name: "b.json", path: "/b.json" });
    trackRecentFile({ name: "a.json", path: "/a.json" });
    const files = getRecentFiles();
    expect(files.length).toBe(2);
    expect(files.map((f) => f.path)).toEqual(["/a.json", "/b.json"]);
  });

  test("caps the list at 10 entries, dropping the oldest", () => {
    for (let i = 1; i <= 12; i++) {
      trackRecentFile({ name: `f${i}.json`, path: `/f/${i}.json` });
    }
    const files = getRecentFiles();
    expect(files.length).toBe(10);
    expect(files[0]!.name).toBe("f12.json");
    expect(files[9]!.name).toBe("f3.json");
  });

  test("recent files do not interfere with recent projects storage", () => {
    trackRecentFile({ name: "x.json", path: "/x.json" });
    expect(getRecentProjects()).toEqual([]);
  });
});
