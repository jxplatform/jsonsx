import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render as litRender } from "lit-html";

/** @type {any} */
let mockPlatform;

mock.module("../src/platform.js", () => ({
  getPlatform: () => mockPlatform,
  registerPlatform: () => {},
}));

mock.module("../src/workspace/workspace.js", () => ({
  activeTab: { value: null },
  openTab: () => {},
  closeTab: () => {},
}));

mock.module("../src/view.js", () => ({
  view: { leftTab: "git" },
}));

mock.module("../src/ui/layers.js", () => ({
  showDialog: async () => null,
}));

mock.module("../src/panels/statusbar.js", () => ({
  statusMessage: () => {},
}));

const { setProjectState } = /** @type {any} */ (await import("../src/state.js"));
const { renderGitPanel, platformSupportsClone } = await import("../src/panels/git-panel.js");

/** @param {any} templateResult */
function renderToString(templateResult) {
  const div = document.createElement("div");
  litRender(templateResult, div);
  return div.innerHTML;
}

describe("renderGitPanel — state rendering", () => {
  beforeEach(() => {
    setProjectState(null);
    mockPlatform = {
      gitStatus: async () => ({
        branch: "main",
        files: [],
        ahead: 0,
        behind: 0,
        isRepo: true,
        remotes: ["origin"],
      }),
      gitBranches: async () => ({ current: "main", branches: ["main"] }),
      gitLog: async () => [],
      gitClone: null,
    };
  });

  test("no project — shows 'Open a project' message", () => {
    setProjectState(null);
    const result = renderGitPanel({ ui: {} }, {});
    const output = renderToString(result);
    expect(output).toContain("Open a project");
  });

  test("no project with clone support — shows Clone button", () => {
    mockPlatform.gitClone = async () => ({ root: "/tmp/cloned" });
    setProjectState(null);
    const result = renderGitPanel({ ui: {} }, {});
    const output = renderToString(result);
    expect(output).toContain("Clone Git Repository");
  });

  test("no project without clone support — no Clone button", () => {
    mockPlatform.gitClone = null;
    setProjectState(null);
    const result = renderGitPanel({ ui: {} }, {});
    const output = renderToString(result);
    expect(output).not.toContain("Clone Git Repository");
  });

  test("project loaded, not a git repo — shows init + publish buttons", () => {
    setProjectState({ name: "test-project" });
    const ui = {
      gitStatus: { branch: "", files: [], ahead: 0, behind: 0, isRepo: false, remotes: [] },
    };
    const result = renderGitPanel({ ui }, {});
    const output = renderToString(result);
    expect(output).toContain("not yet a git repository");
    expect(output).toContain("Initialize Repository");
    expect(output).toContain("Publish to GitHub");
  });

  test("git repo with no remotes — shows 'Local only' sync bar with publish", () => {
    setProjectState({ name: "test-project" });
    const ui = {
      gitStatus: {
        branch: "main",
        files: [],
        ahead: 0,
        behind: 0,
        isRepo: true,
        remotes: [],
      },
      gitBranches: { current: "main", branches: ["main"] },
    };
    const result = renderGitPanel({ ui }, {});
    const output = renderToString(result);
    expect(output).toContain("Local only");
    expect(output).toContain("Publish to GitHub");
    expect(output).not.toContain("Up to date");
  });

  test("git repo with remote — shows normal sync bar without publish", () => {
    setProjectState({ name: "test-project" });
    const ui = {
      gitStatus: {
        branch: "main",
        files: [],
        ahead: 0,
        behind: 0,
        isRepo: true,
        remotes: ["origin"],
      },
      gitBranches: { current: "main", branches: ["main"] },
    };
    const result = renderGitPanel({ ui }, {});
    const output = renderToString(result);
    expect(output).toContain("Up to date");
    expect(output).not.toContain("Publish to GitHub");
    expect(output).not.toContain("Local only");
  });

  test("git repo with ahead/behind — shows sync counts", () => {
    setProjectState({ name: "test-project" });
    const ui = {
      gitStatus: {
        branch: "main",
        files: [],
        ahead: 3,
        behind: 1,
        isRepo: true,
        remotes: ["origin"],
      },
      gitBranches: { current: "main", branches: ["main"] },
    };
    const result = renderGitPanel({ ui }, {});
    const output = renderToString(result);
    expect(output).toContain("3 ahead");
    expect(output).toContain("1 behind");
  });

  test("git repo with changed files — shows file list", () => {
    setProjectState({ name: "test-project" });
    const ui = {
      gitStatus: {
        branch: "main",
        files: [
          { path: "src/index.js", status: "M", staged: false },
          { path: "src/util.js", status: "A", staged: true },
        ],
        ahead: 0,
        behind: 0,
        isRepo: true,
        remotes: ["origin"],
      },
      gitBranches: { current: "main", branches: ["main"] },
    };
    const result = renderGitPanel({ ui }, {});
    const output = renderToString(result);
    expect(output).toContain("index.js");
    expect(output).toContain("util.js");
    expect(output).toContain("Staged Changes");
  });

  test("loading state with no status yet — shows loading indicator", () => {
    setProjectState({ name: "test-project" });
    const ui = { gitStatus: null, gitLoading: true };
    const result = renderGitPanel({ ui }, {});
    const output = renderToString(result);
    expect(output).toContain("Loading");
  });
});

describe("platformSupportsClone", () => {
  test("returns true when platform has gitClone", () => {
    mockPlatform = { gitClone: async () => ({}) };
    expect(platformSupportsClone()).toBe(true);
  });

  test("returns false when platform lacks gitClone", () => {
    mockPlatform = {};
    expect(platformSupportsClone()).toBe(false);
  });
});
