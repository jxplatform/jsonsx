/**
 * POST /__studio/build — the route behind `View: Open in Browser` — plus the read side of the
 * rename refactor when its sweep fails.
 *
 * `site-preview.test.ts` drives the same build route end to end, but it does so in a SUBPROCESS
 * (other suites in this process mock `globalThis.fetch`), so the route's own lines are never
 * executed by the in-process run. Here the compiler and the preview server are both mocked, which
 * is what makes the judgements the route actually makes observable: WHICH directory it builds, that
 * it never cleans the output out from under the pages being served, that a build which reported
 * errors is still a 200 with those errors in the payload, and that the origin the reply carries is
 * the preview server's rather than this server's.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface BuildOptions {
  clean?: boolean;
  verbose?: boolean;
}

interface BuildResult {
  errors: string[];
  files: number;
  routes: number;
}

const buildCalls: { options: BuildOptions; root: string }[] = [];
let buildResult: BuildResult = { errors: [], files: 0, routes: 0 };
let buildFailure: string | null = null;

void mock.module("@jxsuite/compiler/site", () => ({
  buildSite: (projectRoot: string, options: BuildOptions = {}) => {
    buildCalls.push({ options, root: projectRoot });
    return buildFailure === null
      ? Promise.resolve(buildResult)
      : Promise.reject(new Error(buildFailure));
  },
}));

const previewCalls: string[] = [];
let previewResult: { origin: string; port: number } | null = null;

void mock.module("../src/site-preview.ts", () => ({
  sitePreviewOrigin: () => previewResult?.origin ?? null,
  startSitePreview: (projectRoot: string) => {
    previewCalls.push(projectRoot);
    return previewResult;
  },
  stopSitePreviews: () => {},
}));

const findRefsCalls: { path: string | null; root: string; tagName: string | null }[] = [];
let findRefsResult: unknown = {};
let findRefsFailure: string | null = null;

void mock.module("../src/refactor/find-refs.ts", () => ({
  findReferences: (args: { path: string | null; root: string; tagName: string | null }) => {
    findRefsCalls.push({ path: args.path, root: args.root, tagName: args.tagName });
    return findRefsFailure === null
      ? Promise.resolve(findRefsResult)
      : Promise.reject(new Error(findRefsFailure));
  },
  invalidateReferenceCache: () => {},
}));

const { handleStudioApi } = await import("../src/studio-api.ts");

const FIXTURES = resolve(import.meta.dir, "_studio_build_route_fixtures");
/** A site project: it has a project.json, so it is buildable. */
const SITE = join(FIXTURES, "site");
/** A plain directory with no project.json — the "not a site project" case. */
const PLAIN = join(FIXTURES, "plain");

async function callApi(req: Request, url: URL, root: string, activeProjectRoot: string | null) {
  const res = await handleStudioApi(req, url, root, activeProjectRoot);
  if (!res) {
    throw new Error("handleStudioApi returned null");
  }
  return res;
}

function buildReq() {
  const url = new URL("http://localhost/__studio/build");
  return { req: new Request(url, { method: "POST" }), url };
}

beforeAll(() => {
  rmSync(FIXTURES, { force: true, recursive: true });
  mkdirSync(SITE, { recursive: true });
  mkdirSync(PLAIN, { recursive: true });
  writeFileSync(join(SITE, "project.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
  writeFileSync(join(PLAIN, "readme.txt"), "not a project");
});

afterAll(() => {
  rmSync(FIXTURES, { force: true, recursive: true });
});

beforeEach(() => {
  buildCalls.length = 0;
  previewCalls.length = 0;
  findRefsCalls.length = 0;
  buildResult = { errors: [], files: 0, routes: 0 };
  buildFailure = null;
  previewResult = { origin: "http://127.0.0.1:41234", port: 41_234 };
  findRefsResult = {};
  findRefsFailure = null;
});

describe("POST /__studio/build — which directory is built", () => {
  test("builds the ACTIVE project, not the server root", async () => {
    const { req, url } = buildReq();
    const res = await callApi(req, url, PLAIN, SITE);
    expect(res.status).toBe(200);
    expect(buildCalls.map((c) => c.root)).toEqual([SITE]);
    expect(previewCalls).toEqual([SITE]);
  });

  test("falls back to the server root when no project is active", async () => {
    const { req, url } = buildReq();
    const res = await callApi(req, url, SITE, null);
    expect(res.status).toBe(200);
    expect(buildCalls.map((c) => c.root)).toEqual([SITE]);
    expect(previewCalls).toEqual([SITE]);
  });

  test("refuses a directory with no project.json, without invoking the compiler", async () => {
    const { req, url } = buildReq();
    const res = await callApi(req, url, PLAIN, null);
    expect(res.status).toBe(400);
    // RFC 9457: the type is what a client keys on, `detail` is what a human reads.
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = (await res.json()) as { type: string; detail: string };
    expect(body.type).toBe("https://jxsuite.com/problems/invalid-request");
    expect(body.detail).toBe("Not a site project");
    expect(buildCalls).toEqual([]);
    expect(previewCalls).toEqual([]);
  });

  test("the active project decides even when the server root would have built", async () => {
    const { req, url } = buildReq();
    const res = await callApi(req, url, SITE, PLAIN);
    expect(res.status).toBe(400);
    // RFC 9457: the type is what a client keys on, `detail` is what a human reads.
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = (await res.json()) as { type: string; detail: string };
    expect(body.type).toBe("https://jxsuite.com/problems/invalid-request");
    expect(body.detail).toBe("Not a site project");
    expect(buildCalls).toEqual([]);
  });
});

describe("POST /__studio/build — the reply", () => {
  test("never wipes the output directory out from under the pages being served", async () => {
    const { req, url } = buildReq();
    await callApi(req, url, SITE, null);
    expect(buildCalls[0]?.options).toEqual({ clean: false, verbose: false });
  });

  test("reports build errors in the payload at 200, beside the counts and the origin", async () => {
    buildResult = { errors: ["pages/broken.json: unresolved $ref"], files: 7, routes: 4 };
    const { req, url } = buildReq();
    const res = await callApi(req, url, SITE, null);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as BuildResult & { url?: string };
    expect(payload.errors).toEqual(["pages/broken.json: unresolved $ref"]);
    expect(payload.files).toBe(7);
    expect(payload.routes).toBe(4);
    // The built site is served on the PREVIEW server's port, which the caller cannot guess.
    expect(payload.url).toBe("http://127.0.0.1:41234");
  });

  test("omits the origin when there is nothing built to serve", async () => {
    previewResult = null;
    buildResult = { errors: [], files: 2, routes: 1 };
    const { req, url } = buildReq();
    const res = await callApi(req, url, SITE, null);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as BuildResult & { url?: string };
    expect("url" in payload).toBe(false);
    expect(payload.routes).toBe(1);
  });

  test("a build that throws is a 500 carrying the compiler's message", async () => {
    buildFailure = "compiler exploded";
    const { req, url } = buildReq();
    const res = await callApi(req, url, SITE, null);
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toContain("compiler exploded");
    // The failure happened before there was anything to preview.
    expect(previewCalls).toEqual([]);
  });
});

describe("GET /__studio/references", () => {
  function refsReq(query: string) {
    const url = new URL(`http://localhost/__studio/references${query}`);
    return { req: new Request(url, { method: "GET" }), url };
  }

  test("answers with the walker's report for the queried tag", async () => {
    findRefsResult = { files: [{ count: 2, path: "pages/index.json" }], total: 2 };
    const { req, url } = refsReq("?tag=my-card");
    const res = await callApi(req, url, SITE, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [{ count: 2, path: "pages/index.json" }], total: 2 });
    expect(findRefsCalls).toEqual([{ path: null, root: SITE, tagName: "my-card" }]);
  });

  test("a failed sweep is a 500 carrying the message", async () => {
    findRefsFailure = "reference sweep exploded";
    const { req, url } = refsReq("?tag=my-card");
    const res = await callApi(req, url, SITE, null);
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toContain("reference sweep exploded");
  });
});
