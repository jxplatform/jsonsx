/**
 * Tests for src/services/ai-project-tools.ts — the assistant's cross-file and bootstrap tools.
 *
 * Drives the tools through a real ToolRegistry against the harness's in-memory platform: path
 * traversal guards, listing exclusions/caps, read truncation, write pre-validation (schema +
 * render), open-tab reconciliation (dirty refusal / clean reload), project.json config sync, and
 * the create_project → adopt → re-key handoff (including the required destination — "location" on
 * path platforms, "owner" on repo platforms).
 */
import { installMockPlatform, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createToolRegistry } from "@jxsuite/ai";
import { registerProjectTools } from "../src/services/ai-project-tools";
import type { ProjectToolsCtx } from "../src/services/ai-project-tools";
import { closeAllTabs, setWorkspaceProject } from "../src/workspace/workspace";
import type { CreateProjectDestination, DirEntry } from "../src/types";

/** The shape of the `createProject` options the create_project tool sends to the platform. */
interface CreateOpts {
  name: string;
  directory: string;
  destination: CreateProjectDestination;
}

/** Directory listing over a plain path→content map that also understands the "." root. */
function listingFor(files: Record<string, string>) {
  return async (dir: string): Promise<DirEntry[]> => {
    const prefix = dir === "." || dir === "" ? "" : dir.endsWith("/") ? dir : `${dir}/`;
    const seen = new Map<string, DirEntry>();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      const rest = path.slice(prefix.length);
      const [head] = rest.split("/");
      if (!head || seen.has(head)) {
        continue;
      }
      seen.set(head, {
        name: head,
        path: prefix + head,
        type: rest.includes("/") ? "directory" : "file",
      } as DirEntry);
    }
    return [...seen.values()];
  };
}

function makeHarness(
  seedFiles: Record<string, string> = {},
  ctxOverrides: Partial<ProjectToolsCtx> = {},
  platformOverrides: Record<string, unknown> = {},
) {
  const { state } = installMockPlatform(
    { listDirectory: listingFor(seedFiles), ...platformOverrides } as never,
    seedFiles,
  );
  const registry = createToolRegistry();
  const ctx: ProjectToolsCtx = {
    adoptProject: async () => {},
    findOpenTab: () => null,
    getTab: () => null,
    reloadTab: async () => {},
    validate: async () => [],
    ...ctxOverrides,
  };
  registerProjectTools(registry, ctx);
  return { registry, state };
}

function writes(state: { calls: unknown[][] }) {
  return state.calls.filter(([name]) => name === "writeFile");
}

beforeEach(() => {
  closeAllTabs();
  setWorkspaceProject(null);
  globalThis.localStorage.clear();
});

describe("ai-project-tools — list_files", () => {
  test("walks recursively from the root, excluding build and dot directories", async () => {
    const { registry } = makeHarness({
      ".git/config": "x",
      "components/card.json": "{}",
      "node_modules/pkg/index.js": "x",
      "pages/about.json": "{}",
      "pages/index.json": "{}",
      "project.json": "{}",
    });
    const res = await registry.execute("list_files", {});
    expect(res.success).toBe(true);
    const { entries } = res.data as { entries: { path: string; type: string }[] };
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("pages/index.json");
    expect(paths).toContain("pages/about.json");
    expect(paths).toContain("components/card.json");
    expect(paths).toContain("project.json");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes(".git"))).toBe(false);
  });

  test("caps the listing and reports truncation", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 230; i++) {
      files[`data/f${i}.json`] = "{}";
    }
    const { registry } = makeHarness(files);
    const res = await registry.execute("list_files", { dir: "data" });
    const data = res.data as { entries: unknown[]; truncated: boolean };
    expect(data.entries.length).toBe(200);
    expect(data.truncated).toBe(true);
    expect(res.summary).toContain("truncated");
  });

  test("rejects traversal in dir", async () => {
    const { registry } = makeHarness();
    const res = await registry.execute("list_files", { dir: "../elsewhere" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Invalid path");
  });
});

describe("ai-project-tools — read_file", () => {
  test("reads a file and reports missing ones", async () => {
    const { registry } = makeHarness({ "pages/index.json": '{"tagName":"div"}' });
    const ok = await registry.execute("read_file", { path: "pages/index.json" });
    expect(ok.success).toBe(true);
    expect((ok.data as { content: string }).content).toContain("tagName");

    const missing = await registry.execute("read_file", { path: "pages/nope.json" });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("pages/nope.json");
  });

  test("truncates oversized files with a marker", async () => {
    const big = "a".repeat(48 * 1024 + 100);
    const { registry } = makeHarness({ "data/big.txt": big });
    const res = await registry.execute("read_file", { path: "data/big.txt" });
    expect(res.success).toBe(true);
    const data = res.data as { content: string; truncated: boolean };
    expect(data.truncated).toBe(true);
    expect(data.content).toContain("[truncated:");
    expect(data.content.length).toBeLessThan(big.length);
  });

  test("rejects absolute and parent-escaping paths", async () => {
    const { registry } = makeHarness();
    for (const path of ["/etc/passwd", "../secrets.txt", "~/.ssh/id_rsa", "C:/windows"]) {
      const res = await registry.execute("read_file", { path });
      expect(res.success).toBe(false);
      expect(res.error).toContain("Invalid path");
    }
  });
});

describe("ai-project-tools — write_file", () => {
  test("writes raw files and normalizes ./ prefixes", async () => {
    const { registry, state } = makeHarness();
    const res = await registry.execute("write_file", {
      content: "hello",
      path: "./data/notes.txt",
    });
    expect(res.success).toBe(true);
    expect(res.summary).toContain("not undoable");
    expect(writes(state)[0]![1]).toBe("data/notes.txt");
  });

  test("blocks Jx documents with schema errors before writing", async () => {
    const { registry, state } = makeHarness(
      {},
      { validate: async () => ["must have required property 'tagName'"] },
    );
    const res = await registry.execute("write_file", {
      content: JSON.stringify({ children: [] }),
      path: "pages/broken.json",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("schema errors");
    expect(res.error).toContain("nothing was written");
    expect(writes(state)).toHaveLength(0);
  });

  test("blocks Jx documents that fail the render check", async () => {
    const { registry, state } = makeHarness(
      {},
      { renderCheck: async () => ({ error: "boom in render", ok: false as const }) },
    );
    const res = await registry.execute("write_file", {
      content: JSON.stringify({ tagName: "div" }),
      path: "components/bad.json",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("fails to render");
    expect(writes(state)).toHaveLength(0);
  });

  test("validates doc-shaped JSON outside conventional dirs, but not plain data arrays", async () => {
    const validate = mock(async () => [] as string[]);
    const { registry, state } = makeHarness({}, { validate });
    await registry.execute("write_file", {
      content: JSON.stringify({ tagName: "div" }),
      path: "misc/widget.json",
    });
    expect(validate).toHaveBeenCalledTimes(1);

    validate.mockClear();
    await registry.execute("write_file", {
      content: JSON.stringify([1, 2, 3]),
      path: "data/list.json",
    });
    expect(validate).not.toHaveBeenCalled();
    expect(writes(state)).toHaveLength(2);
  });

  test("rejects invalid JSON for .json paths and oversized content", async () => {
    const { registry, state } = makeHarness();
    const bad = await registry.execute("write_file", {
      content: "{not json",
      path: "pages/x.json",
    });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain("not valid JSON");

    const huge = await registry.execute("write_file", {
      content: "x".repeat(256 * 1024 + 1),
      path: "data/huge.txt",
    });
    expect(huge.success).toBe(false);
    expect(huge.error).toContain("write cap");
    expect(writes(state)).toHaveLength(0);
  });

  test("refuses to overwrite a file open in a dirty tab", async () => {
    const tab = resetWorkspaceWithTab(undefined, { documentPath: "pages/index.json" });
    tab.doc.dirty = true;
    const { registry, state } = makeHarness(
      {},
      { findOpenTab: (p) => (p === "pages/index.json" ? tab : null) },
    );
    const res = await registry.execute("write_file", {
      content: JSON.stringify({ tagName: "div" }),
      path: "pages/index.json",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("unsaved changes");
    expect(writes(state)).toHaveLength(0);
  });

  test("writing over a clean open tab reloads it from disk", async () => {
    const tab = resetWorkspaceWithTab(undefined, { documentPath: "pages/index.json" });
    const reloadTab = mock(async (_p: string) => {});
    const { registry } = makeHarness(
      {},
      { findOpenTab: (p) => (p === "pages/index.json" ? tab : null), reloadTab },
    );
    const res = await registry.execute("write_file", {
      content: JSON.stringify({ tagName: "div" }),
      path: "pages/index.json",
    });
    expect(res.success).toBe(true);
    expect(res.summary).toContain("refreshed");
    expect(reloadTab).toHaveBeenCalledWith("pages/index.json");
  });

  test("a project.json write syncs the config through onProjectConfigWritten", async () => {
    const onProjectConfigWritten = mock((_c: object) => {});
    const { registry, state } = makeHarness({}, { onProjectConfigWritten });
    const res = await registry.execute("write_file", {
      content: JSON.stringify({ name: "Renamed Site" }),
      path: "project.json",
    });
    expect(res.success).toBe(true);
    expect(onProjectConfigWritten).toHaveBeenCalledWith({ name: "Renamed Site" });
    expect(writes(state)).toHaveLength(1);

    const bad = await registry.execute("write_file", {
      content: "nope{",
      path: "project.json",
    });
    expect(bad.success).toBe(false);
    expect(onProjectConfigWritten).toHaveBeenCalledTimes(1);
  });

  /* `tabs/project-config.ts` owns `project.json`, and an open `project.json` tab IS the
     configuration document — so adopting the write refreshes that tab. Re-reading the file on top
     of it would parse a SECOND configuration object and hand it to the same tab, which is the split
     the adoption just closed; the settings edit after such a reload used to persist the stale
     document back over the assistant's write. */
  test("a project.json write refreshes its open tab through the adoption, never a second parse", async () => {
    const tab = resetWorkspaceWithTab(undefined, { documentPath: "project.json" });
    const reloadTab = mock(async (_p: string) => {});
    const adopted: object[] = [];
    const { registry } = makeHarness(
      {},
      {
        findOpenTab: (p) => (p === "project.json" ? tab : null),
        onProjectConfigWritten: (config) => {
          adopted.push(config);
        },
        reloadTab,
      },
    );

    const res = await registry.execute("write_file", {
      content: JSON.stringify({ name: "Renamed Site" }),
      path: "project.json",
    });

    expect(res.success).toBe(true);
    expect(res.summary).toContain("refreshed");
    expect(adopted).toEqual([{ name: "Renamed Site" }]);
    expect(reloadTab).not.toHaveBeenCalled();
  });

  test("the adoption is awaited, so the tool never reports a write the app has not taken", async () => {
    let settled = false;
    const { registry } = makeHarness(
      {},
      {
        onProjectConfigWritten: async () => {
          await Promise.resolve();
          settled = true;
        },
      },
    );

    const res = await registry.execute("write_file", {
      content: JSON.stringify({ name: "Renamed Site" }),
      path: "project.json",
    });

    expect(res.success).toBe(true);
    expect(settled).toBe(true);
  });

  /* Project.json used to be exempt from the schema gate by construction — syntactically valid JSON
     was written straight to disk, and Monaco flagged it against the per-project entry document the
     moment a human opened the file. The gate has to block BEFORE the write: disk writes have no
     undo to lean on. */
  test("a schema-invalid project.json is refused before anything is written", async () => {
    const onProjectConfigWritten = mock((_c: object) => {});
    // Clean before, broken after: an error the model's own write introduced.
    const validateProject = mock(async (config: unknown) =>
      (config as { extensions?: unknown }).extensions === "nope"
        ? ["/extensions: must be object"]
        : [],
    );
    const { registry, state } = makeHarness({}, { onProjectConfigWritten, validateProject });

    const res = await registry.execute("write_file", {
      content: JSON.stringify({ extensions: "nope", name: "Demo" }),
      path: "project.json",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("project.json has schema errors");
    expect(res.error).toContain("must be object");
    expect(validateProject).toHaveBeenCalledWith({ extensions: "nope", name: "Demo" });
    expect(writes(state)).toHaveLength(0);
    expect(onProjectConfigWritten).not.toHaveBeenCalled();
  });

  /* A project whose config was written by something else — an importer, a hand edit, an extension
     that was later removed — must not refuse every write the model attempts. The model cannot fix
     a violation it did not introduce and cannot reach from the edit it was asked to make, so
     blaming it for one is a loop with no exit. Same subtraction `services/ai-tools.ts` performs on
     a document edit. */
  test("a violation the file already had does not refuse an unrelated write", async () => {
    const validateProject = mock(async (_c: unknown) => [
      "(root): must NOT have unevaluated properties (title)",
    ]);
    const { registry, state } = makeHarness({}, { validateProject });

    const res = await registry.execute("write_file", {
      content: JSON.stringify({ name: "Demo", url: "https://example.com" }),
      path: "project.json",
    });

    expect(res.success).toBe(true);
    expect(writes(state)).toHaveLength(1);
  });

  test("the document validator is never used for project.json", async () => {
    const validate = mock(async (_d: unknown) => ["/tagName: must be string"]);
    const validateProject = mock(async (_c: unknown) => []);
    const { registry, state } = makeHarness({}, { validate, validateProject });

    const res = await registry.execute("write_file", {
      content: JSON.stringify({ name: "Demo" }),
      path: "project.json",
    });

    expect(res.success).toBe(true);
    expect(validate).not.toHaveBeenCalled();
    // Twice: the file as it stands, then the file as this write would leave it. The first is what
    // Gets subtracted so the model is only blamed for what it introduced.
    expect(validateProject).toHaveBeenCalledTimes(2);
    expect(writes(state)).toHaveLength(1);
  });

  /* Kept in step with monaco-setup's DOCUMENT_FILE_MATCH — `elements/` was missing here, so an
     element document reached disk validated only by the structural sniff. */
  test("elements/*.json is gated like every other document folder", async () => {
    const validate = mock(async (_d: unknown) => ["/tagName: must be string"]);
    const { registry, state } = makeHarness({}, { validate });

    const res = await registry.execute("write_file", {
      content: JSON.stringify({ nothing: "doc-shaped" }),
      path: "elements/badge.json",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("schema errors");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(writes(state)).toHaveLength(0);
  });
});

describe("ai-project-tools — search_files", () => {
  test("returns matching paths through the platform search", async () => {
    const { registry } = makeHarness({
      "components/hero-banner.json": "{}",
      "pages/hero.json": "{}",
      "pages/index.json": "{}",
    });
    const res = await registry.execute("search_files", { query: "hero" });
    expect(res.success).toBe(true);
    const { paths } = res.data as { paths: string[] };
    expect(paths.toSorted()).toEqual(["components/hero-banner.json", "pages/hero.json"]);
  });

  test("propagates platform search failures", async () => {
    const { registry } = makeHarness(
      {},
      {},
      {
        searchFiles: async () => {
          throw new Error("backend gone");
        },
      },
    );
    const res = await registry.execute("search_files", { query: "x" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("backend gone");
  });
});

describe("ai-project-tools — create_project", () => {
  test("scaffolds, adopts, and fires onProjectAdopted once adoption is verified", async () => {
    const onProjectAdopted = mock((_root: string) => {});
    const adoptProject = mock(async (root: string) => {
      // Simulate openRecentProject succeeding: the workspace now holds the project.
      setWorkspaceProject(root, { name: "New Site" });
    });
    const createProject = mock(async (opts: CreateOpts) => ({
      config: { name: opts.name },
      root: `/abs/${opts.directory}`,
    }));
    const { registry } = makeHarness({}, { adoptProject, onProjectAdopted }, { createProject });

    const res = await registry.execute("create_project", {
      location: "/home/dev/Sites",
      name: "New Site!",
    });
    expect(res.success).toBe(true);
    expect(res.summary).toContain("opened it");
    // The directory slug derives from the name; the location becomes the path destination.
    expect(createProject.mock.calls[0]![0]!.directory).toBe("new-site");
    expect(createProject.mock.calls[0]![0]!.destination).toEqual({
      kind: "path",
      parent: "/home/dev/Sites",
    });
    expect(adoptProject).toHaveBeenCalledWith("/abs/new-site");
    expect(onProjectAdopted).toHaveBeenCalledWith("/abs/new-site");
  });

  test("initialises a git repository, before adopting", async () => {
    /* `specs/desktop.md` §4.5: "every source, including Import and Agent" initialises a repository.
       `initProjectRepo` had two call sites, both in the New Project modal, so a project the AGENT
       bootstrapped was not under version control and nothing said so. */
    const order: string[] = [];
    const adoptProject = mock(async (root: string) => {
      order.push("adopt");
      setWorkspaceProject(root, { name: "New Site" });
    });
    const createProject = mock(async (opts: CreateOpts) => ({
      config: { name: opts.name },
      root: `/abs/${opts.directory}`,
    }));
    const { registry, state } = makeHarness({}, { adoptProject }, { createProject });

    const res = await registry.execute("create_project", {
      location: "/home/dev/Sites",
      name: "New Site",
    });
    expect(res.success).toBe(true);

    const gitCalls = state.calls.filter(([name]) => name === "gitInit" || name === "activate");
    expect(gitCalls.map(([name]) => name)).toEqual(["activate", "gitInit"]);
    // `activate` is what binds the backend to the new root, so it must precede the open flow.
    expect(state.calls.findIndex(([name]) => name === "gitInit")).toBeGreaterThan(-1);
    expect(order).toEqual(["adopt"]);
  });

  test("a tree that is already a repository is not re-initialised", async () => {
    const createProject = mock(async (opts: CreateOpts) => ({
      config: { name: opts.name },
      root: `/abs/${opts.directory}`,
    }));
    const { registry, state } = makeHarness(
      {},
      { adoptProject: async (root) => setWorkspaceProject(root, { name: "New Site" }) },
      { createProject, gitStatus: async () => ({ files: [], isRepo: true }) },
    );

    await registry.execute("create_project", { location: "/home/dev/Sites", name: "New Site" });
    expect(state.calls.some(([name]) => name === "gitInit")).toBe(false);
  });

  test("a git failure is reported without failing the create", async () => {
    // A project that was written stays written — version control is a safety net, not a gate.
    const createProject = mock(async (opts: CreateOpts) => ({
      config: { name: opts.name },
      root: `/abs/${opts.directory}`,
    }));
    const { registry } = makeHarness(
      {},
      { adoptProject: async (root) => setWorkspaceProject(root, { name: "New Site" }) },
      {
        createProject,
        gitInit: async () => {
          throw new Error("git is not installed");
        },
      },
    );

    const res = await registry.execute("create_project", {
      location: "/home/dev/Sites",
      name: "New Site",
    });
    expect(res.success).toBe(true);
    expect(res.summary).toContain("opened it");
  });

  test("trailing slashes are trimmed off the location parent", async () => {
    const createProject = mock(async (opts: CreateOpts) => ({
      config: { name: opts.name },
      root: `/abs/${opts.directory}`,
    }));
    const { registry } = makeHarness({}, {}, { createProject });
    const res = await registry.execute("create_project", {
      location: "/home/dev/Sites/",
      name: "Trimmed",
    });
    expect(res.success).toBe(true);
    expect(createProject.mock.calls[0]![0]!.destination).toEqual({
      kind: "path",
      parent: "/home/dev/Sites",
    });
  });

  test("refuses without a location on a path platform, before touching the backend", async () => {
    const { registry, state } = makeHarness();
    const res = await registry.execute("create_project", { name: "Homeless" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("location");
    expect(state.calls.some(([name]) => name === "createProject")).toBe(false);
  });

  test("rejects a relative location", async () => {
    const { registry, state } = makeHarness();
    const res = await registry.execute("create_project", {
      location: "Sites/clients",
      name: "Relative",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("absolute path");
    expect(state.calls.some(([name]) => name === "createProject")).toBe(false);
  });

  test("refuses without an owner on a repo platform", async () => {
    const createProject = mock(async (opts: CreateOpts) => ({
      config: { name: opts.name },
      root: "owner/repo",
    }));
    const { registry } = makeHarness({}, {}, { createDestination: "repo", createProject });
    // "Location" is meaningless on the cloud — it must still demand an owner.
    const res = await registry.execute("create_project", {
      location: "/home/dev/Sites",
      name: "Cloudy",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("owner");
    expect(createProject).not.toHaveBeenCalled();
  });

  test("builds a private repo destination from the owner on a repo platform", async () => {
    const adoptProject = mock(async (root: string) => {
      setWorkspaceProject(root, { name: "Cloud Site" });
    });
    const createProject = mock(async (opts: CreateOpts) => ({
      config: { name: opts.name },
      root:
        opts.destination.kind === "repo"
          ? `${opts.destination.owner}/${opts.destination.repo}`
          : "?",
    }));
    const { registry } = makeHarness(
      {},
      { adoptProject },
      { createDestination: "repo", createProject },
    );
    const res = await registry.execute("create_project", { name: "Cloud Site!", owner: "acme" });
    expect(res.success).toBe(true);
    expect(createProject.mock.calls[0]![0]!.destination).toEqual({
      kind: "repo",
      owner: "acme",
      private: true,
      repo: "cloud-site",
    });
    expect(adoptProject).toHaveBeenCalledWith("acme/cloud-site");
  });

  test("honours an explicit public visibility on a repo platform", async () => {
    const createProject = mock(async (opts: CreateOpts) => ({
      config: { name: opts.name },
      root: "acme/public-site",
    }));
    const { registry } = makeHarness({}, {}, { createDestination: "repo", createProject });
    const res = await registry.execute("create_project", {
      name: "Public Site",
      owner: "acme",
      private: false,
    });
    expect(res.success).toBe(true);
    expect(createProject.mock.calls[0]![0]!.destination).toEqual({
      kind: "repo",
      owner: "acme",
      private: false,
      repo: "public-site",
    });
  });

  test("refuses while a project is already open", async () => {
    setWorkspaceProject("/already/open");
    const { registry, state } = makeHarness();
    const res = await registry.execute("create_project", { name: "Another" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("already open");
    expect(state.calls.some(([name]) => name === "createProject")).toBe(false);
  });

  test("reports creation without adoption when the workspace never picks up the root", async () => {
    const onProjectAdopted = mock((_root: string) => {});
    const { registry } = makeHarness(
      {},
      {
        // Resolves without error but the workspace root never changes (e.g. deduped window).
        adoptProject: async () => {},
        onProjectAdopted,
      },
      {
        createProject: async () => ({ config: {}, root: "/abs/elsewhere" }),
      },
    );
    const res = await registry.execute("create_project", {
      location: "/home/dev/Sites",
      name: "Ghost",
    });
    expect(res.success).toBe(true);
    expect(res.summary).toContain("not opened in this window");
    expect(onProjectAdopted).not.toHaveBeenCalled();
  });

  test("surfaces scaffolding errors and adoption failures", async () => {
    const failing = makeHarness(
      {},
      {},
      {
        createProject: async () => {
          throw new Error("directory exists");
        },
      },
    );
    const res = await failing.registry.execute("create_project", {
      location: "/home/dev/Sites",
      name: "Dup",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("directory exists");

    const adoptFail = makeHarness(
      {},
      {
        adoptProject: async () => {
          throw new Error("no adopter registered");
        },
      },
      { createProject: async () => ({ config: {}, root: "/abs/x" }) },
    );
    const res2 = await adoptFail.registry.execute("create_project", {
      location: "/home/dev/Sites",
      name: "Solo",
    });
    expect(res2.success).toBe(true);
    expect(res2.summary).toContain("no adopter registered");
  });
});

describe("ai-project-tools — list_starters", () => {
  test("returns an empty list when the platform has no starters", async () => {
    const { registry } = makeHarness();
    const res = await registry.execute("list_starters", {});
    expect(res.success).toBe(true);
    expect((res.data as { starters: unknown[] }).starters).toEqual([]);
  });

  test("lists platform starters when available", async () => {
    const { registry } = makeHarness(
      {},
      {},
      { listStarters: async () => [{ id: "blog", name: "Blog" }] },
    );
    const res = await registry.execute("list_starters", {});
    expect((res.data as { starters: { id: string }[] }).starters[0]!.id).toBe("blog");
  });
});
