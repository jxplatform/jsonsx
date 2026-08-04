/**
 * Studio shell (C7): the ?project= bootstrap branch of src/studio.ts with an absolute site path.
 *
 * Covers: site-context resolution, platform activation, project-state population, conventional
 * directory expansion, and the project.json → pages/index.json home-page redirect.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { bootStudio, waitFor } from "./studio-shell-fixture";
import { activeTab } from "../src/workspace/workspace";
import { requireProjectState } from "../src/store";

const SITE = "/abs/site";

let resolvedWith: string | null = null;

const { platform, state } = await bootStudio({
  overrides: {
    listDirectory: (async (dir: string) => {
      if (dir === ".") {
        return [
          { name: "pages", path: "pages", type: "directory" },
          { name: "node_modules", path: "node_modules", type: "directory" },
          { name: "project.json", path: "project.json", type: "file" },
        ];
      }
      if (dir === "pages") {
        return [{ name: "index.json", path: "pages/index.json", type: "file" }];
      }
      return [];
    }) as any,
    resolveSiteContext: (async (path: string) => {
      resolvedWith = path;
      return {
        fileRelPath: "project.json",
        projectConfig: { name: "SiteProj" },
        sitePath: SITE,
      };
    }) as any,
  },
  seedFiles: {
    "pages/index.json": JSON.stringify({ children: [], tagName: "main" }),
    "project.json": JSON.stringify({ name: "SiteProj" }),
  },
  url: `http://localhost/?project=${SITE}`,
});

await waitFor(() => activeTab.value?.id === "pages/index.json");

describe("?project= bootstrap (site project)", () => {
  test("activates the platform with the resolved site root", () => {
    expect(platform.projectRoot).toBe(SITE);
    expect(state.calls.some((c) => c[0] === "activate")).toBe(true);
    expect(resolvedWith).toBe(SITE);
  });

  test("populates project state from the site context", () => {
    const ps = requireProjectState() as any;
    expect(ps.name).toBe("SiteProj");
    expect(ps.isSiteProject).toBe(true);
    expect(ps.root).toBe(SITE);
    expect(ps.projectConfig).toEqual({ name: "SiteProj" });
  });

  test("expands only conventional directories into the tree", () => {
    const ps = requireProjectState() as any;
    expect(ps.projectDirs).toEqual(["pages"]);
    expect(ps.expanded.has("pages")).toBe(true);
    expect(ps.dirs.get(".")).toHaveLength(3);
    expect(ps.dirs.get("pages")).toHaveLength(1);
    expect(ps.expanded.has("node_modules")).toBe(false);
  });

  test("redirects project.json to the home page and opens it in a tab", () => {
    expect(activeTab.value?.id).toBe("pages/index.json");
    expect(activeTab.value?.documentPath).toBe("pages/index.json");
    expect((activeTab.value!.doc.document as any).tagName).toBe("main");
    // The redirect means the stylebook default for project.json must NOT kick in.
    expect(activeTab.value?.session.ui.canvasMode).not.toBe("stylebook");
  });
});
