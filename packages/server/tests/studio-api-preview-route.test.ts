/**
 * The two routes behind `View: Open in Browser`, live edition: POST /__studio/preview, which opens
 * the origin, and /__studio/preview/overlay, which carries the unsaved bytes to it.
 *
 * `live-preview.test.ts` drives the origin itself against a real tree. This mocks it away, which is
 * what makes the judgements the ROUTES make observable: which directory is previewed, that a
 * directory which is not a site project is refused, that the requested route reaches the retarget,
 * that `reused` comes back untouched — because a caller that ignores it gives the author two tabs
 * on one project — and, for the overlay, that a browser request becomes exactly the publish or the
 * retraction Studio asked for, against the same directory the preview itself runs from.
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
const overlaySets: { contents: string; path: string; root: string }[] = [];
const overlayClears: { path: string | undefined; root: string }[] = [];

void mock.module("../src/live-preview.ts", () => ({
  clearLivePreviewOverlay: (projectRoot: string, path?: string) => {
    overlayClears.push({ path, root: projectRoot });
  },
  livePreviewClients: () => 0,
  livePreviewOrigin: () => startResult.origin,
  navigateLivePreview: (projectRoot: string, route: string) => {
    navigateCalls.push({ root: projectRoot, route });
    return Promise.resolve(navigateResult);
  },
  notifyLivePreviewChange: () => {},
  setLivePreviewOverlay: (projectRoot: string, path: string, contents: string) => {
    overlaySets.push({ contents, path, root: projectRoot });
  },
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

async function callOverlay(
  method: "POST" | "DELETE",
  body: unknown,
  root: string,
  activeProjectRoot: string | null,
) {
  const url = new URL("http://localhost/__studio/preview/overlay");
  const req = new Request(url, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    method,
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
  overlaySets.length = 0;
  overlayClears.length = 0;
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

describe("the unsaved bytes", () => {
  test("a POST publishes one document, and answers with no content", async () => {
    const res = await callOverlay(
      "POST",
      { contents: '{"tagName":"main"}', path: "pages/index.json" },
      SITE,
      null,
    );
    expect(res.status).toBe(204);
    expect(overlaySets).toEqual([
      { contents: '{"tagName":"main"}', path: "pages/index.json", root: SITE },
    ]);
  });

  /*
   * The same directory the preview itself runs from. An overlay published against the server root
   * while the origin serves the active project would be bytes nothing ever reads.
   */
  test("publishes against the ACTIVE project, not the server root", async () => {
    await callOverlay("POST", { contents: "{}", path: "pages/index.json" }, PLAIN, SITE);
    expect(overlaySets.map((o) => o.root)).toEqual([SITE]);
  });

  test("with nothing activated, the server root is the project", async () => {
    await callOverlay("POST", { contents: "{}", path: "pages/index.json" }, SITE, null);
    expect(overlaySets.map((o) => o.root)).toEqual([SITE]);
  });

  test("a DELETE naming a document retracts exactly that one", async () => {
    const res = await callOverlay("DELETE", { path: "pages/index.json" }, SITE, null);
    expect(res.status).toBe(204);
    expect(overlayClears).toEqual([{ path: "pages/index.json", root: SITE }]);
  });

  // Naming none means every one of this project's — how Studio lets go of a project it is leaving.
  test("a DELETE naming no document retracts the whole project's", async () => {
    const res = await callOverlay("DELETE", {}, SITE, null);
    expect(res.status).toBe(204);
    expect(overlayClears).toEqual([{ path: undefined, root: SITE }]);
  });
});

describe("the unsaved bytes, refused", () => {
  /*
   * Half a publish is worse than none: a path with no contents would retract nothing and publish
   * nothing, leaving the reader on stale bytes with no error anywhere.
   */
  test("a POST missing either half is refused, and nothing is published", async () => {
    const noContents = await callOverlay("POST", { path: "pages/index.json" }, SITE, null);
    const noPath = await callOverlay("POST", { contents: "{}" }, SITE, null);

    expect(noContents.status).toBe(400);
    expect(noPath.status).toBe(400);
    expect(overlaySets).toEqual([]);
  });

  test("a body that is not JSON is refused, for either method", async () => {
    const posted = await callOverlay("POST", "{oops", SITE, null);
    const deleted = await callOverlay("DELETE", "{oops", SITE, null);

    expect(posted.status).toBe(400);
    expect(deleted.status).toBe(400);
    expect(overlaySets).toEqual([]);
    expect(overlayClears).toEqual([]);
  });

  /*
   * Publishing and retracting are the whole vocabulary. Any other method falls through to the rest
   * of the API rather than being answered here, which is what keeps this route from claiming a path
   * it has no meaning for.
   */
  test("a method that is neither is not this route's to answer", async () => {
    const url = new URL("http://localhost/__studio/preview/overlay");
    const req = new Request(url, { body: JSON.stringify({}), method: "PUT" });

    expect(await handleStudioApi(req, url, SITE, null)).toBeNull();
    expect(overlaySets).toEqual([]);
    expect(overlayClears).toEqual([]);
  });
});
