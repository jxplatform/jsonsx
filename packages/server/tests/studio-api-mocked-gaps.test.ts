/**
 * Studio-api-mocked-gaps.test.ts — error-path coverage for handleStudioApi routes whose failures
 * cannot be provoked through the filesystem: the starter listing, the package-operation helpers,
 * and the post-rename refactor pass. Each dependency is mocked to throw; the routes must translate
 * the failure into their documented error responses.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

void mock.module("@jxsuite/starters", () => ({
  listStarters: () => {
    throw new Error("starter registry exploded");
  },
}));

void mock.module("../src/packages.ts", () => ({
  bunExecutable: () => "bun",
  dependenciesNeedInstall: () => false,
  installDependencies: () => Promise.reject(new Error("install exploded")),
  packageVersions: () => Promise.reject(new Error("versions exploded")),
  setPackageVersions: () => Promise.reject(new Error("set-versions exploded")),
}));

void mock.module("../src/refactor/apply.ts", () => ({
  applyRename: () => Promise.reject(new Error("refactor exploded")),
}));

const { handleStudioApi } = await import("../src/studio-api.ts");

const ROOT = resolve(import.meta.dir, "_studio_mocked_gaps_fixtures");

async function callApi(req: Request, url: URL) {
  const res = await handleStudioApi(req, url, ROOT, null);
  if (!res) {
    throw new Error("handleStudioApi returned null");
  }
  return res;
}

function getReq(pathAndQuery: string) {
  const url = new URL(`http://localhost${pathAndQuery}`);
  return { req: new Request(url, { method: "GET" }), url };
}

function jsonReq(path: string, method: string, body: unknown) {
  const url = new URL(`http://localhost${path}`);
  return { req: new Request(url, { body: JSON.stringify(body), method }), url };
}

beforeAll(() => {
  rmSync(ROOT, { force: true, recursive: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "widget.json"), JSON.stringify({ tagName: "my-widget" }));
});

afterAll(() => {
  rmSync(ROOT, { force: true, recursive: true });
});

describe("starters — listing failure", () => {
  test("returns 500 when the starter registry throws", async () => {
    const { req, url } = getReq("/__studio/starters");
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toContain("starter registry exploded");
  });
});

describe("package operations — helper failures", () => {
  test("install tolerates a missing body and returns 500 when the helper rejects", async () => {
    // No JSON body at all: the route's json().catch fallback kicks in before the helper rejects.
    const url = new URL("http://localhost/__studio/packages/install");
    const res = await callApi(new Request(url, { method: "POST" }), url);
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toContain("install exploded");
  });

  test("versions returns 500 when packageVersions rejects", async () => {
    const { req, url } = getReq("/__studio/packages/versions");
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toContain("versions exploded");
  });

  test("set-versions returns 500 when setPackageVersions rejects", async () => {
    const { req, url } = jsonReq("/__studio/packages/set-versions", "POST", {
      updates: [{ name: "x", version: "1.0.0" }],
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toContain("set-versions exploded");
  });
});

describe("rename — refactor pass failure", () => {
  test("a failed refactor pass is reported but never fails the completed move", async () => {
    const { req, url } = jsonReq("/__studio/file/rename", "POST", {
      from: "widget.json",
      to: "gadget.json",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { error: string; from: string; ok: boolean; to: string };
    expect(payload.ok).toBe(true);
    expect(payload.error).toContain("refactor exploded");
    expect(payload.from).toBe("widget.json");
    expect(payload.to).toBe("gadget.json");
  });
});
