/**
 * Live preview paths that need a seam mocked to reach: the format parser a Worker would not have,
 * the extension mounts, the server-function proxy, the runtime bundle's fallback build, and the
 * overlay budget.
 *
 * `live-preview.test.ts` drives the origin against a real tree and is where the behaviour lives.
 * These are the branches that only exist because a host CAN do something a hosted backend cannot,
 * plus the two failure shapes a reader would otherwise meet as a blank page.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/* The project's format registry. On a desktop backend this is real and markdown pages render; a
   Worker has no such thing and the composer reports the page by name instead. */
let parseImpl: ((text: string) => unknown) | null = null;
let registryFailure: string | null = null;
/* What the host asked the registry to be built FROM. Recorded rather than ignored: a stub that
   answers `.md` whatever it is handed cannot tell a host that passes the project's config from one
   that does not, and the extension list lives in that config — see
   `live-preview-markdown.test.ts`, which drives the real registry for the same reason. */
const registryCalls: { config: unknown; root: string }[] = [];

void mock.module("@jxsuite/compiler/format-host", () => ({
  buildProjectFormatRegistry: (root: string, config?: unknown) => {
    registryCalls.push({ config, root });
    if (registryFailure !== null) {
      return Promise.reject(new Error(registryFailure));
    }
    return Promise.resolve({
      byExtension: (ext: string) =>
        parseImpl && ext === ".md"
          ? { call: (_capability: string, text: string) => Promise.resolve(parseImpl!(text)) }
          : undefined,
    });
  },
}));

let mountResponse: Response | null = null;
const mountCalls: string[] = [];

void mock.module("../src/jx-mounts.ts", () => ({
  handleJxMounts: (_req: Request, url: URL) => {
    mountCalls.push(url.pathname);
    return Promise.resolve(mountResponse ? mountResponse.clone() : null);
  },
  resetJxMounts: () => {},
}));

const serverFunctionCalls: number[] = [];

void mock.module("../src/resolve.ts", () => ({
  handleResolve: () => new Response("resolved", { status: 200 }),
  handleServerFunction: () => {
    serverFunctionCalls.push(1);
    return new Response("ran", { status: 200 });
  },
  projectAssetMounts: () => Promise.resolve([]),
}));

const {
  clearLivePreviewOverlay,
  setLivePreviewOverlay,
  startLivePreview,
  stopLivePreviews,
  // eslint-disable-next-line unicorn/no-await-expression-member -- mock.module must precede this.
} = await import("../src/live-preview.ts");

const TMP = resolve(import.meta.dir, "__test-live-preview-gaps__");

function write(relPath: string, content: string | object) {
  const abs = resolve(TMP, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  write("project.json", { extensions: ["@jxsuite/parser"], name: "Gaps" });
  write("pages/index.md", "# Markdown page");
  write("public/logo.svg", "<svg/>");
});

beforeEach(() => {
  parseImpl = null;
  registryFailure = null;
  mountResponse = null;
  mountCalls.length = 0;
  serverFunctionCalls.length = 0;
  registryCalls.length = 0;
  clearLivePreviewOverlay(TMP);
});

afterAll(() => {
  stopLivePreviews();
  rmSync(TMP, { force: true, recursive: true });
});

describe("the format parser a hosted backend does not have", () => {
  test("with a parser, a markdown page renders", async () => {
    parseImpl = (text) => ({ children: [text.replace("# ", "")], tagName: "h1" });
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/`);
    const body = await response.text();
    expect(body).toContain('id="jx-page-document"');
    expect(body).toContain("Markdown page");
  });

  /*
   * The registry is a function of `project.json`'s `extensions`, so building it from the root alone
   * yields an EMPTY registry — which reads as "no parser for .md" and is really "no extensions at
   * all". That is the shape of a defect this file's own stub could not see.
   */
  test("the project's config is what the registry is built from, not the root alone", async () => {
    parseImpl = (text) => ({ children: [text.replace("# ", "")], tagName: "h1" });
    const { origin } = await startLivePreview(TMP);
    await fetch(`${origin}/`);

    expect(registryCalls.length).toBeGreaterThan(0);
    expect(registryCalls.at(-1)).toEqual({
      config: { extensions: ["@jxsuite/parser"], name: "Gaps" },
      root: TMP,
    });
  });

  test("with no parser for the extension, the page is named rather than left blank", async () => {
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("pages/index.md");
  });

  test("a registry that throws is a broken project, not a broken origin", async () => {
    // The whole preview must not go down because one format class fails to load.
    registryFailure = "extension failed to import";
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("could not be read as a page");
  });
});

describe("extension mounts", () => {
  test("a previewed page's data endpoint is dispatched", async () => {
    mountResponse = new Response('{"rows":[]}', { status: 200 });
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/_jx/data/rows`);
    expect(response.status).toBe(200);
    expect(mountCalls).toEqual(["/_jx/data/rows"]);
  });

  test("a mount that claims nothing falls through to the site's own answer", async () => {
    mountResponse = null;
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/_jx/nothing`);
    expect(mountCalls).toEqual(["/_jx/nothing"]);
    expect(response.status).toBe(404);
  });

  test("a cross-origin mount request is refused before dispatch", async () => {
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/_jx/data/rows`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(mountCalls).toEqual([]);
  });
});

describe("the resolver proxies", () => {
  /** The token the shell hands the runtime — the only thing that opens these routes. */
  async function tokenOf(origin: string): Promise<string> {
    parseImpl = (text) => ({ children: [text], tagName: "main" });
    const response = await fetch(`${origin}/`);
    const body = await response.text();
    return /setResolveToken\("([^"]+)"\)/.exec(body)![1]!;
  }

  test("a server function runs behind this origin's own token", async () => {
    const { origin } = await startLivePreview(TMP);
    const token = await tokenOf(origin);
    const response = await fetch(`${origin}/__jx_server__?token=${token}`, {
      body: "{}",
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(serverFunctionCalls).toHaveLength(1);
  });

  test("a $src resolution runs behind the same token", async () => {
    const { origin } = await startLivePreview(TMP);
    const token = await tokenOf(origin);
    const response = await fetch(`${origin}/__jx_resolve__?token=${token}`, {
      body: "{}",
      method: "POST",
    });
    expect(await response.text()).toBe("resolved");
  });

  test("another project's token does not open this one", async () => {
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/__jx_resolve__?token=${crypto.randomUUID()}`, {
      body: "{}",
      method: "POST",
    });
    expect(response.status).toBe(403);
  });
});

describe("the runtime bundle", () => {
  test("is read once and served from memory after that", async () => {
    const { origin } = await startLivePreview(TMP);
    const one = await fetch(`${origin}/__jx_live__/runtime.js`);
    const first = await one.text();
    const two = await fetch(`${origin}/__jx_live__/runtime.js`);
    const second = await two.text();
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(1000);
  });
});

describe("the overlay budget", () => {
  test("an overlay too large to hold is dropped, and SAID rather than silently forgotten", async () => {
    // Shown the saved bytes for a file the author is actively editing, with nothing to explain the
    // Difference, is the failure this reports its way out of.
    const big = "x".repeat(5 * 1024 * 1024);
    setLivePreviewOverlay(
      TMP,
      "pages/one.json",
      JSON.stringify({ children: [big], tagName: "main" }),
    );
    setLivePreviewOverlay(
      TMP,
      "pages/two.json",
      JSON.stringify({ children: [big], tagName: "main" }),
    );
    const preview = await startLivePreview(TMP);
    expect(preview.errors).toHaveLength(1);
    expect(preview.errors[0]).toContain("pages/one.json");
    expect(preview.errors[0]).toContain("shown as last saved");
  });

  test("the newest edit survives the eviction", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    setLivePreviewOverlay(
      TMP,
      "pages/one.json",
      JSON.stringify({ children: [big], tagName: "main" }),
    );
    setLivePreviewOverlay(
      TMP,
      "pages/two.json",
      JSON.stringify({ children: ["kept"], tagName: "main" }),
    );
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/two/`);
    expect(await response.text()).toContain("kept");
  });

  test("clearing everything clears what was dropped too", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    setLivePreviewOverlay(
      TMP,
      "pages/one.json",
      JSON.stringify({ children: [big], tagName: "main" }),
    );
    setLivePreviewOverlay(
      TMP,
      "pages/two.json",
      JSON.stringify({ children: [big], tagName: "main" }),
    );
    clearLivePreviewOverlay(TMP);
    const preview = await startLivePreview(TMP);
    expect(preview.errors).toEqual([]);
  });
});
