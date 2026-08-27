/**
 * POST /__studio/preview — the route behind `View: Open in Browser`, live edition.
 *
 * `live-preview.test.ts` drives the origin itself against a real tree. This mocks it away, which is
 * what makes the judgements the ROUTE makes observable: which directory it previews, that it
 * refuses a directory that is not a site project, that it forwards the requested route to the
 * retarget, and — the one a caller acts on — that `reused` comes back untouched, because a caller
 * that ignores it gives the author two tabs on one project.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Preview {
  errors: string[];
  origin: string;
  port: number;
  routes: number;
}

const startCalls: string[] = [];
const navigateCalls: { route: string; root: string }[] = [];
let startResult: Preview = {
  errors: [],
  origin: "http://127.0.0.1:41234",
  port: 41_234,
  routes: 3,
};
let startFailure: string | null = null;
let navigateResult = false;

void mock.module("../src/live-preview.ts", () => ({
  clearLivePreviewOverlay: () => {},
  livePreviewClients: () => 0,
  livePreviewOrigin: () => startResult.origin,
  navigateLivePreview: (projectRoot: string, route: string) => {
    navigateCalls.push({ root: projectRoot, route });
    return Promise.resolve(navigateResult);
  },
  notifyLivePreviewChange: () => {},
  setLivePreviewOverlay: () => {},
  startLivePreview: (projectRoot: string) => {
    startCalls.push(projectRoot);
    return startFailure === null
      ? Promise.resolve(startResult)
      : Promise.reject(new Error(startFailure));
  },
  stopLivePreviews: () => {},
}));

const { handleStudioApi } = await import("../src/studio-api.ts");

const FIXTURES = resolve(import.meta.dir, "_studio_preview_route_fixtures");
/** A site project: it has a project.json, so it has routes to preview. */
const SITE = join(FIXTURES, "site");
/** A plain directory with no project.json. */
const PLAIN = join(FIXTURES, "plain");

async function callApi(body: unknown, root: string, activeProjectRoot: string | null) {
  const url = new URL("http://localhost/__studio/preview");
  const req = new Request(url, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    method: "POST",
  });
  const res = await handleStudioApi(req, url, root, activeProjectRoot);
  if (!res) {
    throw new Error("handleStudioApi returned null");
  }
  return res;
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
  startCalls.length = 0;
  navigateCalls.length = 0;
  startResult = { errors: [], origin: "http://127.0.0.1:41234", port: 41_234, routes: 3 };
  startFailure = null;
  navigateResult = false;
});

describe("which directory is previewed", () => {
  test("previews the ACTIVE project, not the server root", async () => {
    const res = await callApi({ route: "/" }, PLAIN, SITE);
    expect(res.status).toBe(200);
    expect(startCalls).toEqual([SITE]);
  });

  test("falls back to the server root when nothing is activated", async () => {
    const res = await callApi({ route: "/" }, SITE, null);
    expect(res.status).toBe(200);
    expect(startCalls).toEqual([SITE]);
  });

  test("a directory that is not a site project is refused, and nothing is started", async () => {
    const res = await callApi({ route: "/" }, PLAIN, null);
    expect(res.status).toBe(400);
    expect(startCalls).toEqual([]);
  });
});

describe("what it answers with", () => {
  test("the origin to open, the route count, and the mode", async () => {
    const res = await callApi({ route: "/" }, SITE, null);
    expect(await res.json()).toEqual({
      errors: [],
      files: 0,
      mode: "live",
      reused: false,
      routes: 3,
      url: "http://127.0.0.1:41234",
    });
  });

  test("`live`, always — this is never compiler output and must not read as it", async () => {
    const res = await callApi({ route: "/" }, SITE, null);
    const payload = await res.json();
    expect(payload.mode).toBe("live");
  });

  test("the overlay's own complaints reach the author", async () => {
    startResult = { ...startResult, errors: ["pages/huge.json is too large to preview unsaved."] };
    const res = await callApi({ route: "/" }, SITE, null);
    const payload = await res.json();
    expect(payload.errors).toEqual(["pages/huge.json is too large to preview unsaved."]);
  });

  test("a live preview writes nothing, so it counts no files", async () => {
    const res = await callApi({ route: "/" }, SITE, null);
    const payload = await res.json();
    expect(payload.files).toBe(0);
  });
});

describe("retargeting", () => {
  test("the requested route is what the open tab is pointed at", async () => {
    await callApi({ route: "/blog/hello/" }, SITE, null);
    expect(navigateCalls).toEqual([{ root: SITE, route: "/blog/hello/" }]);
  });

  test("`reused` comes back untouched, because the caller must not open a second tab", async () => {
    navigateResult = true;
    const res = await callApi({ route: "/blog/hello/" }, SITE, null);
    const payload = await res.json();
    expect(payload.reused).toBe(true);
  });

  test("with no route asked for, nothing is retargeted", async () => {
    const res = await callApi({}, SITE, null);
    const payload = await res.json();
    expect(navigateCalls).toEqual([]);
    expect(payload.reused).toBe(false);
  });
});

describe("failure", () => {
  test("a body that is not JSON is refused", async () => {
    const res = await callApi("{oops", SITE, null);
    expect(res.status).toBe(400);
    expect(startCalls).toEqual([]);
  });

  test("an origin that will not start is a named 500, not a silent nothing", async () => {
    startFailure = "port exhausted";
    const res = await callApi({ route: "/" }, SITE, null);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).toContain("port exhausted");
  });
});
