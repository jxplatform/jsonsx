/**
 * Which tab a comparison lives in, and which files can have one at all.
 *
 * The rule this pins is §14.1: one path, one tab. A file the canvas can draw gets its ordinary
 * document tab, so leaving the comparison for Design reopens nothing; a file it cannot gets a stub
 * tab keyed by the same path, the way a media file does. Both are keyed by the path, which is what
 * stops the Source Control panel drawing one file's comparison on another file's tab.
 */

import "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const opened: unknown[] = [];
const activated: string[] = [];
const openedFiles: string[] = [];
const tabs = new Map<string, { documentPath: string; id: string }>();

void mock.module("../src/workspace/workspace.js", () => ({
  activateTab: (id: string) => activated.push(id),
  openTab: (spec: { id: string; documentPath: string }) => {
    opened.push(spec);
    const tab = { documentPath: spec.documentPath, id: spec.id };
    tabs.set(spec.id, tab);
    return tab;
  },
  workspace: { tabs },
}));

// Reached only through the dynamic import for a renderable file.
void mock.module("../src/files/files.js", () => ({
  openFileInTab: (path: string) => {
    openedFiles.push(path);
    const tab = { documentPath: path, id: path };
    tabs.set(path, tab);
    return Promise.resolve(tab);
  },
}));

const { canRenderComparison, comparisonRefusal, diffTabModes, openComparisonTab, openDiffTab } =
  await import("../src/panels/git-diff-open");

beforeEach(() => {
  opened.length = 0;
  activated.length = 0;
  openedFiles.length = 0;
  tabs.clear();
});

describe("canRenderComparison", () => {
  test("a .json document and a format-backed one have a visual half", () => {
    expect(canRenderComparison("pages/index.json")).toBe(true);
  });

  test("source and config files do not, which decides the VIEW and not whether the row opens", () => {
    expect(canRenderComparison("src/app.ts")).toBe(false);
    expect(canRenderComparison("styles/site.css")).toBe(false);
    expect(canRenderComparison(".gitignore")).toBe(false);
  });
});

describe("comparisonRefusal", () => {
  test("refuses a rename, because only the new path is in hand", () => {
    expect(comparisonRefusal("pages/new.json", "R")).toContain("renamed");
  });

  test("refuses a binary file, because a comparison of one is not text", () => {
    expect(comparisonRefusal("public/hero.png", "M")).toContain("not text");
  });

  test("allows every ordinary changed file", () => {
    expect(comparisonRefusal("src/app.ts", "M")).toBeNull();
    expect(comparisonRefusal("pages/index.json", "D")).toBeNull();
    expect(comparisonRefusal("notes.md", "U")).toBeNull();
  });
});

describe("openComparisonTab", () => {
  test("a renderable document gets its ORDINARY tab, not a stub", async () => {
    // So the author can leave the comparison for Design without reopening anything.
    const tab = await openComparisonTab("pages/index.json");
    expect(openedFiles).toEqual(["pages/index.json"]);
    expect(opened).toEqual([]);
    expect(tab?.id).toBe("pages/index.json");
  });

  test("a file the canvas cannot render gets a stub tab keyed by its path", async () => {
    const tab = await openComparisonTab("src/app.ts");
    expect(openedFiles).toEqual([]);
    expect(opened).toEqual([
      {
        capabilities: { modes: ["git-diff"] },
        document: { children: [], tagName: "div" },
        documentPath: "src/app.ts",
        id: "src/app.ts",
        sourceFormat: null,
      },
    ]);
    expect(tab?.id).toBe("src/app.ts");
  });

  test("an already-open file is activated rather than opened twice", async () => {
    tabs.set("src/app.ts", { documentPath: "src/app.ts", id: "src/app.ts" });
    const tab = await openComparisonTab("src/app.ts");
    expect(activated).toEqual(["src/app.ts"]);
    expect(opened).toEqual([]);
    expect(tab?.id).toBe("src/app.ts");
  });

  test("a renderable file already open resolves to that same tab", async () => {
    // `openFileInTab` answers void when it reveals a tab that was already open, so the lookup by
    // Path is what makes the answer the same either way.
    tabs.set("pages/index.json", { documentPath: "pages/index.json", id: "pages/index.json" });
    void mock.module("../src/files/files.js", () => ({
      // Void is what it answers when it REVEALS a tab that was already open.
      openFileInTab: () => Promise.resolve(),
    }));
    const { openComparisonTab: open } = await import("../src/panels/git-diff-open");
    const tab = await open("pages/index.json");
    expect(tab?.id).toBe("pages/index.json");
  });
});

describe("openDiffTab", () => {
  test("declares exactly one mode", () => {
    expect(diffTabModes()).toEqual(["git-diff"]);
  });

  test("is keyed by the path, so one path is one tab", () => {
    const first = openDiffTab("src/app.ts");
    const second = openDiffTab("src/app.ts");
    expect(first).toBe(second);
    expect(opened).toHaveLength(1);
  });
});
