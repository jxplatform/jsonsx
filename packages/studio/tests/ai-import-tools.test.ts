/**
 * Src/services/ai-import-tools.ts — `import_site`, the assistant's other way to bootstrap a
 * project. A sibling of `create_project` with a different backend, and two refusals of its own: it
 * will not invent a destination the wizard already collected, and it will not run twice.
 */
import { clearSeededSettings, flush, installMockPlatform, seedSettings } from "./harness";
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
  breakpoints: { count: 3, mode: "limit" as const, rounding: "nearest" as const },
  depth: 1,
  directory: "/home/dev/Sites/example",
  maxPages: 20,
  minFidelity: 25,
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
  /** The early-adoption hook — fires the moment the destination is an openable project. */
  onReady: ((evt: { root: string }) => void) | undefined;
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
            onReady?: (evt: { root: string }) => void,
          ) =>
            new Promise((resolve, reject) => {
              captured = { onProgress, onReady, opts: o, reject, resolve, signal };
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
      breakpoints: { count: 3, mode: "limit" as const, rounding: "nearest" as const },
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

  /*
   * The fidelity bar (jxsuite/jx issue 232). The wizard's number is the user's own answer to "how
   * close is close enough", so the model inherits it and only overrides it when it was told to.
   */
  test("the brief's fidelity minimum is used when the model does not state one", async () => {
    setPendingImportBrief({ ...BRIEF, minFidelity: 60, verify: true });
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", { url: "https://example.com" });
    expect(captured!.opts.verifyMinFidelity).toBe(60);
    captured!.resolve({ config: {}, root: "/home/dev/Sites/example" });
    await running;
  });

  test("the model's fidelity minimum wins, clamped to a percentage", async () => {
    setPendingImportBrief({ ...BRIEF, minFidelity: 60, verify: true });
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", {
      minFidelity: 400,
      url: "https://example.com",
    });
    expect(captured!.opts.verifyMinFidelity).toBe(100);
    captured!.resolve({ config: {}, root: "/home/dev/Sites/example" });
    await running;
  });

  test("with no brief and no argument the bar is the same floor the CLI uses", async () => {
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/example",
      url: "https://example.com",
    });
    expect(captured!.opts.verifyMinFidelity).toBe(25);
    captured!.resolve({ config: {}, root: "/home/dev/Sites/example" });
    await running;
  });

  test("a run under the bar is reported as a result, not as a number to note", async () => {
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/example",
      minFidelity: 25,
      url: "https://example.com",
      verify: true,
    });
    captured!.resolve({
      config: {},
      result: {
        verify: {
          averageFidelity: 8.17,
          minFidelity: 25,
          pages: [{ failedRequests: 15, fidelity: 8.17, route: "pages/index.json" }],
          passed: false,
          reportDir: "/p/verify",
        },
      },
      root: "/home/dev/Sites/example",
    });

    const res = await running;
    expect(res.summary).toContain("below the 25% minimum");
    // And what a percentage cannot say — the reason it scored that badly.
    expect(res.summary).toContain("15 requests failed or 404'd");
    /* Still a success: the project is written and open, and destroying the flow over a fidelity
       number would be worse than reporting it. The CLI exits non-zero because it has no reader. */
    expect(res.success).toBe(true);
  });

  test("a run that clears the bar says nothing about it", async () => {
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
          averageFidelity: 96,
          minFidelity: 25,
          pages: [{ fidelity: 96, route: "pages/index.json" }],
          passed: true,
          reportDir: "/p/verify",
        },
      },
      root: "/home/dev/Sites/example",
    });

    const res = await running;
    expect(res.summary).not.toContain("minimum");
  });

  // A build error is its own finding; repeating it as a fidelity miss would be noise.
  test("a project that did not build reports the build error rather than the bar", async () => {
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
          averageFidelity: 98,
          buildErrors: ["Error compiling /about: unknown $ref"],
          minFidelity: 25,
          pages: [{ fidelity: 98, route: "pages/index.json" }],
          passed: false,
          reportDir: "/p/verify",
        },
      },
      root: "/home/dev/Sites/example",
    });

    const res = await running;
    expect(res.summary).toContain("did not build cleanly: Error compiling /about");
    expect(res.summary).not.toContain("below the");
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
    /* Nothing asked for a policy, so none is sent and the pipeline's own default applies. Sending
       one here would put a decision in the request that neither the model nor the user made. */
    expect(captured!.opts.breakpoints).toBeUndefined();
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

// ─── Opening the project while the crawl is still running ────────────────────

describe("import_site — the project opens before the run ends", () => {
  /*
   * A crawl takes minutes, and the tool used to spend all of them with the author on the welcome
   * screen: it adopted the project once `importSite` RESOLVED. The pipeline now says the moment the
   * destination holds an openable `project.json` — seconds in — and adoption happens there, so the
   * Files tree fills with pages, components and assets as they are written.
   */
  test("adopts on the ready signal, long before the run resolves", async () => {
    const adopt = landing();
    const { registry } = harness({ adoptProject: adopt });
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/early",
      url: "https://example.com/",
    });

    expect(adopt).not.toHaveBeenCalled();
    captured!.onReady!({ root: "/home/dev/Sites/early" });
    await flush();
    expect(adopt).toHaveBeenCalledWith("/home/dev/Sites/early");

    captured!.resolve({ config: {}, root: "/home/dev/Sites/early" });
    const res = await running;
    expect(res.success).toBe(true);
    // Adopted once. A second adoption at the end would tear down and rebuild every tab the author
    // Had opened while they watched.
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  test("a backend that never signals still opens the project at the end", async () => {
    // An older backend sends no `ready` line. That is not a broken backend; it is an older one.
    const adopt = landing();
    const { registry } = harness({ adoptProject: adopt });
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/late",
      url: "https://example.com/",
    });
    captured!.resolve({ config: {}, root: "/home/dev/Sites/late" });

    const res = await running;
    expect(res.success).toBe(true);
    expect(adopt).toHaveBeenCalledWith("/home/dev/Sites/late");
  });

  test("a repeated ready signal adopts once", async () => {
    const adopt = landing();
    const { registry } = harness({ adoptProject: adopt });
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/twice",
      url: "https://example.com/",
    });
    captured!.onReady!({ root: "/home/dev/Sites/twice" });
    captured!.onReady!({ root: "/home/dev/Sites/twice" });
    await flush();
    captured!.resolve({ config: {}, root: "/home/dev/Sites/twice" });
    await running;
    expect(adopt).toHaveBeenCalledTimes(1);
  });
});

// ─── Breakpoints ─────────────────────────────────────────────────────────────

describe("import_site — the breakpoint policy", () => {
  async function policyFor(args: Record<string, unknown>): Promise<unknown> {
    const { registry } = harness({ adoptProject: landing() });
    const running = registry.execute("import_site", {
      directory: "/home/dev/Sites/bp",
      url: "https://example.com/",
      ...args,
    });
    const policy = captured!.opts.breakpoints;
    captured!.resolve({ config: {}, root: "/home/dev/Sites/bp" });
    await running;
    return policy;
  }

  test("a count becomes a limit", async () => {
    expect(await policyFor({ maxBreakpoints: 4 })).toEqual({
      count: 4,
      mode: "limit",
      rounding: "nearest",
    });
  });

  test("zero is how a count says keep them all", async () => {
    expect(await policyFor({ maxBreakpoints: 0 })).toEqual({ mode: "all" });
  });

  test("a width list wins over a count, because it says more", async () => {
    expect(await policyFor({ breakpointWidths: [640, 1024], maxBreakpoints: 4 })).toEqual({
      mode: "explicit",
      rounding: "nearest",
      widths: [640, 1024],
    });
  });

  test("the rounding rule is carried when the model names one", async () => {
    expect(await policyFor({ breakpointRounding: "down", maxBreakpoints: 2 })).toEqual({
      count: 2,
      mode: "limit",
      rounding: "down",
    });
  });
});
