/**
 * Src/services/ai-import-tools.ts — `import_site`, the assistant's other way to bootstrap a
 * project. A sibling of `create_project` with a different backend, and two refusals of its own: it
 * will not invent a destination the wizard already collected, and it will not run twice.
 */
import { clearSeededSettings, installMockPlatform, seedSettings } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createToolRegistry } from "@jxsuite/ai";
import { registerImportTools, resetImportGuard } from "../src/services/ai-import-tools";
import { clearPendingImportBrief, setPendingImportBrief } from "../src/services/import-seed";
import { importRun, resetImportRuns } from "../src/services/import-run";
import { beginToolCall, beginTurnSignal, endTurnSignal } from "../src/services/ai-turn-signal";
import { closeAllTabs, setWorkspaceProject } from "../src/workspace/workspace";
import type { ImportProgressEvent, ImportSiteOptions, ImportSiteSummary } from "../src/types";
import type { ImportBrief } from "../src/services/import-seed";

const BRIEF: ImportBrief = {
  aiComponents: true,
  depth: 1,
  directory: "/home/dev/Sites/example",
  maxPages: 20,
  model: "o3-import",
  name: "Example",
  prompt: "Modernise the typography",
  url: "https://example.com/",
  verify: false,
};

/** The captured call, so a test drives the stream by hand exactly as the import-tab tests do. */
let captured: {
  opts: ImportSiteOptions;
  onProgress: (evt: ImportProgressEvent) => void;
  resolve: (r: { root: string; config: object; result?: ImportSiteSummary }) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal | undefined;
} | null = null;

function harness(
  opts: {
    adoptProject?: (root: string) => Promise<void>;
    onProjectAdopted?: (root: string) => void;
    noBackend?: boolean;
  } = {},
) {
  const { state } = installMockPlatform(
    opts.noBackend
      ? ({} as never)
      : ({
          importSite: ((
            o: ImportSiteOptions,
            onProgress: (evt: ImportProgressEvent) => void,
            signal?: AbortSignal,
          ) =>
            new Promise((resolve, reject) => {
              captured = { onProgress, opts: o, reject, resolve, signal };
            })) as never,
        } as never),
  );
  const registry = createToolRegistry();
  registerImportTools(registry, {
    getTab: () => null,
    ...(opts.adoptProject ? { adoptProject: opts.adoptProject } : {}),
    ...(opts.onProjectAdopted ? { onProjectAdopted: opts.onProjectAdopted } : {}),
  });
  return { registry, state };
}

/** An adopter that lands, the way `openRecentProject` does on success. */
function landing() {
  return mock(async (root: string) => {
    setWorkspaceProject(root, { name: "Example" });
  });
}

beforeEach(() => {
  captured = null;
  closeAllTabs();
  setWorkspaceProject(null);
  clearSeededSettings();
  clearPendingImportBrief();
  resetImportRuns();
  resetImportGuard();
  endTurnSignal();
  beginToolCall("call_1");
});

afterEach(() => {
  setWorkspaceProject(null);
  resetImportRuns();
  resetImportGuard();
  endTurnSignal();
});

describe("import_site — refusals", () => {
  test("refuses while a project is already open", async () => {
    const { registry } = harness();
    setWorkspaceProject("/already/open", { name: "Open" });
    const res = await registry.execute("import_site", { url: "https://example.com" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("only for bootstrapping");
  });

  test("refuses on a platform with no import backend", async () => {
    const { registry } = harness({ noBackend: true });
    const res = await registry.execute("import_site", {
      directory: "/home/dev/Sites/x",
      url: "https://example.com",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("no site-import backend");
  });

  test("refuses a url that is not http(s)", async () => {
    const { registry } = harness();
    const bad = await registry.execute("import_site", { url: "not a url" });
    expect(bad.success).toBe(false);
    const ftp = await registry.execute("import_site", {
      directory: "/home/dev/Sites/x",
      url: "ftp://example.com",
    });
    expect(ftp.success).toBe(false);
    expect(ftp.error).toContain("http://");
  });

  test("refuses with no destination and no brief, naming what to do about it", async () => {
    const { registry } = harness();
    const res = await registry.execute("import_site", { url: "https://example.com" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Ask the user where");
  });

  test("refuses a relative or traversing destination", async () => {
    const { registry } = harness();
    const rel = await registry.execute("import_site", {
      directory: "sites/x",
      url: "https://example.com",
    });
    expect(rel.error).toContain("absolute path");

    const up = await registry.execute("import_site", {
      directory: "/home/dev/../../etc/x",
      url: "https://example.com",
    });
    expect(up.error).toContain('must not contain ".."');
  });

  test("refuses a destination that disagrees with the one the user chose", async () => {
    /* The wizard's Location field IS the user's answer to "where does this go". A model that
       disagrees is guessing at a decision already made in front of them. */
    setPendingImportBrief(BRIEF);
    const { registry } = harness();
    const res = await registry.execute("import_site", {
      directory: "/somewhere/else",
      url: "https://example.com",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("/home/dev/Sites/example");
  });

  test("refuses a second import in the same conversation", async () => {
    /* Not the same question as `workspace.projectRoot`: on desktop adoption may open the project in
       ANOTHER window, leaving this one's root empty — and the no-project tier would then advertise
       a second import over the top of the first. */
    const { registry } = harness();
    const first = registry.execute("import_site", {
      directory: "/home/dev/Sites/example",
      url: "https://example.com",
    });
    captured!.resolve({ config: {}, root: "/home/dev/Sites/example" });
    await first;

    const second = await registry.execute("import_site", {
      directory: "/home/dev/Sites/other",
      url: "https://other.example",
    });
    expect(second.success).toBe(false);
    expect(second.error).toContain("already been imported");
  });
});

describe("import_site — the run", () => {
  test("fills the request in from the brief and streams into the record", async () => {
    setPendingImportBrief(BRIEF);
    seedSettings({ "jx.ai.baseUrl": "http://llm.local/v1", "jx.ai.openaiKey": "sk-import" });
    const adoptProject = landing();
    const onProjectAdopted = mock((_root: string) => {});
    const { registry, state } = harness({ adoptProject, onProjectAdopted });

    // The url alone, exactly as the tool's description tells the model to call it.
    const running = registry.execute("import_site", { url: "https://example.com" });

    expect(captured!.opts).toMatchObject({
      aiComponents: true,
      apiKey: "sk-import",
      baseUrl: "http://llm.local/v1",
      depth: 1,
      directory: "/home/dev/Sites/example",
      maxPages: 20,
      model: "o3-import",
      name: "Example",
      url: "https://example.com/",
      verify: false,
    });

    captured!.onProgress({ current: 3, message: "Crawled 3 pages", phase: "crawl", total: 20 });
    expect(importRun("call_1")).toMatchObject({
      current: 3,
      message: "Crawled 3 pages",
      status: "running",
      total: 20,
    });
    captured!.onProgress({ message: "⚠ 2 assets failed to download", phase: "assets" });
    expect(importRun("call_1")!.warnings).toEqual(["2 assets failed to download"]);

    captured!.resolve({ config: {}, root: "/home/dev/Sites/example" });
    const res = await running;

    expect(res.success).toBe(true);
    expect(importRun("call_1")!.status).toBe("done");
    expect(adoptProject).toHaveBeenCalledWith("/home/dev/Sites/example");
    expect(onProjectAdopted).toHaveBeenCalledWith("/home/dev/Sites/example");
    // The git init every create path owes (specs/desktop.md §4.5), which used to live in the modal.
    expect(state.calls.some(([name]) => name === "gitInit")).toBe(true);
  });

  test("the summary reports what the run found, naming the weakest pages", async () => {
    /* Per page, because the average cannot name one: "84% average" is a fact nobody can act on,
       and "the pricing page renders at 61%" is a decision. */
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/example",
      url: "https://example.com",
      verify: true,
    });
    expect(captured!.opts.verify).toBe(true);
    captured!.resolve({
      config: {},
      result: {
        fileCount: 14,
        pages: [
          { nodeCount: 120, route: "pages/index.json", title: "Home" },
          { nodeCount: 80, route: "pages/pricing.json", title: "Pricing" },
        ],
        verify: {
          averageFidelity: 84,
          pages: [
            { fidelity: 98, route: "pages/index.json" },
            { fidelity: 74, route: "pages/about.json" },
            { fidelity: 61, route: "pages/pricing.json" },
          ],
          reportDir: "/p/verify",
        },
        warnings: [],
      },
      root: "/home/dev/Sites/example",
    });

    const res = await running;
    expect(res.summary).toContain("2 pages, 14 files");
    expect(res.summary).toContain("averaged 84%");
    // Weakest first, because that is the one worth interrupting a person for.
    expect(res.summary).toContain("pages/pricing.json at 61%, pages/about.json at 74%");
    // The page that rendered faithfully is not a finding.
    expect(res.summary).not.toContain("pages/index.json at 98%");
  });

  test("a run where every page rendered faithfully says so rather than listing none", async () => {
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/example",
      url: "https://example.com",
      verify: true,
    });
    captured!.resolve({
      config: {},
      result: {
        verify: {
          averageFidelity: 99,
          pages: [{ fidelity: 99, route: "pages/index.json" }],
          reportDir: "/p/verify",
        },
      },
      root: "/home/dev/Sites/example",
    });

    const res = await running;
    expect(res.summary).toContain("on every page");
  });

  test("the brief's verify choice is used when the model does not state one", async () => {
    setPendingImportBrief({ ...BRIEF, verify: true });
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", { url: "https://example.com" });
    expect(captured!.opts.verify).toBe(true);
    captured!.resolve({ config: {}, root: "/home/dev/Sites/example" });
    await running;
  });

  test("the summary names the warnings and points at what to do next", async () => {
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/example",
      url: "https://example.com",
    });
    captured!.onProgress({ message: "⚠ 2 assets failed to download", phase: "assets" });
    captured!.resolve({ config: {}, root: "/home/dev/Sites/example" });

    const res = await running;
    expect(res.summary).toContain("2 assets failed to download");
    expect(res.summary).toContain("ask the user");
    // It does NOT quote page or file counts — streamImport returns neither, and a number invented
    // From log prose is exactly how a confidently wrong summary happens.
    expect(res.summary).not.toMatch(/\d+ pages?,/);
  });

  test("a model-supplied destination is honoured when there is no brief", async () => {
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", {
      aiComponents: false,
      depth: 0,
      directory: "/home/dev/Sites/scratch",
      maxPages: 5,
      url: "https://example.com/page",
    });
    expect(captured!.opts).toMatchObject({
      aiComponents: false,
      depth: 0,
      directory: "/home/dev/Sites/scratch",
      maxPages: 5,
      name: "example.com",
    });
    captured!.resolve({ config: {}, root: "/home/dev/Sites/scratch" });
    await running;
  });

  test("depth and page count are clamped to the bounds the server clamps to", async () => {
    // Otherwise the model's numbers and the actual run diverge silently.
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", {
      depth: 99,
      directory: "/home/dev/Sites/x",
      maxPages: 5000,
      url: "https://example.com",
    });
    expect(captured!.opts).toMatchObject({ depth: 5, maxPages: 100 });
    captured!.resolve({ config: {}, root: "/home/dev/Sites/x" });
    await running;
  });

  test("a hard failure quotes the last steps, because depth 0 is the usual recovery", async () => {
    const { registry } = harness();
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/x",
      url: "https://example.com",
    });
    captured!.onProgress({ message: "Launching browser...", phase: "launch" });
    captured!.onProgress({ message: "Capturing https://example.com/", phase: "capture" });
    captured!.reject(new Error("Navigation timeout of 30000 ms exceeded"));

    const res = await running;
    expect(res.success).toBe(false);
    expect(res.error).toContain("Navigation timeout");
    expect(res.error).toContain("[capture] Capturing");
    expect(importRun("call_1")!.status).toBe("failed");
  });

  test("a stopped run does not adopt", async () => {
    const adoptProject = landing();
    const { registry } = harness({ adoptProject });
    const controller = new AbortController();
    beginTurnSignal(controller.signal);

    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/x",
      url: "https://example.com",
    });
    captured!.signal!.addEventListener("abort", () => {
      captured!.reject(new Error("aborted"));
    });
    controller.abort();

    const res = await running;
    expect(res.success).toBe(false);
    expect(res.error).toContain("stopped");
    expect(adoptProject).not.toHaveBeenCalled();
    expect(importRun("call_1")!.status).toBe("stopped");
  });

  test("a project that was written but not opened here says so instead of claiming it opened", async () => {
    // `openRecentProject` swallows its failures, so a resolved promise is not proof of adoption.
    const { registry } = harness({ adoptProject: mock(async () => {}) });
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/x",
      url: "https://example.com",
    });
    captured!.resolve({ config: {}, root: "/home/dev/Sites/x" });

    const res = await running;
    expect(res.success).toBe(true);
    expect(res.summary).toContain("not opened in this window");
    expect(res.summary).toContain("recent projects");
  });

  test("an adoption that threw reports its reason", async () => {
    const { registry } = harness({
      adoptProject: async () => {
        throw new Error("no such directory");
      },
    });
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/x",
      url: "https://example.com",
    });
    captured!.resolve({ config: {}, root: "/home/dev/Sites/x" });

    const res = await running;
    expect(res.summary).toContain("no such directory");
  });

  test("a successful run clears the brief, so a later call cannot reuse the destination", async () => {
    setPendingImportBrief(BRIEF);
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", { url: "https://example.com" });
    captured!.resolve({ config: {}, root: "/home/dev/Sites/example" });
    await running;

    const { pendingImportBrief } = await import("../src/services/import-seed");
    expect(pendingImportBrief()).toBeNull();
  });
});
