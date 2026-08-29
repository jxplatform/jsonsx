/**
 * The dev server under a subpath deployment (issue 235).
 *
 * A project whose `url` carries a path is SERVED from that path, and the build now emits every URL
 * under it. A preview that only answered the bare path would therefore exercise URLs the deployed
 * site never uses — the class of bug that is only found in production.
 *
 * The base is stripped once at the edge rather than moving the dev root, so both spellings work:
 * `/` is unchanged for everyone who never sets a `url` path, and the based URL a build emits
 * resolves to the same file. A real server is started in-process and driven with real fetch, like
 * `hardening.test.ts` — the whole point is what an HTTP request sees.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDevServer } from "../src/server.ts";
import { projectSiteBase } from "../src/resolve.ts";

const FIXTURES = resolve(import.meta.dir, "_base_path_fixtures");
const ROOT = join(FIXTURES, "project");

let server: Awaited<ReturnType<typeof createDevServer>>;
let origin = "";

beforeAll(async () => {
  rmSync(FIXTURES, { force: true, recursive: true });
  mkdirSync(join(ROOT, "assets"), { recursive: true });
  writeFileSync(
    join(ROOT, "project.json"),
    JSON.stringify({ name: "probe", url: "https://example.pages.dev/m/probe/" }),
  );
  writeFileSync(join(ROOT, "index.html"), "<html>home</html>");
  writeFileSync(join(ROOT, "assets", "app.js"), "export const x = 1;");
  server = await createDevServer({ builds: [], port: 0, root: ROOT, studio: false, watch: false });
  origin = `http://127.0.0.1:${(server as { port: number }).port}`;
});

afterAll(() => {
  (server as { stop?: () => void }).stop?.();
  rmSync(FIXTURES, { force: true, recursive: true });
});

const body = (path: string) => fetch(origin + path).then((r) => r.text());
const status = (path: string) => fetch(origin + path).then((r) => r.status);

describe("projectSiteBase", () => {
  test("reads the deployment path back off the project's own url", async () => {
    expect(await projectSiteBase(ROOT)).toBe("/m/probe");
  });

  test("a directory with no project.json has no base", async () => {
    expect(await projectSiteBase(FIXTURES)).toBe("");
  });
});

describe("the dev server answers both spellings", () => {
  test("the bare path still works, exactly as before", async () => {
    // The deployment Jx documents is a site at its own origin root, and nothing about it changes.
    expect(await body("/")).toContain("home");
    expect(await body("/assets/app.js")).toContain("export const x = 1;");
  });

  test("the based path resolves to the same files the build's URLs name", async () => {
    /* This is the assertion the issue is about: `jx build` emits `/m/probe/assets/app.js`, and a
       preview that 404s on it is a preview of a different site. */
    expect(await body("/m/probe/")).toContain("home");
    expect(await body("/m/probe/assets/app.js")).toContain("export const x = 1;");
  });

  test("the base with no trailing slash is the index, not a miss", async () => {
    expect(await body("/m/probe")).toContain("home");
  });

  test("a path that merely shares a prefix with the base is not stripped", async () => {
    // The boundary is a segment. `/m/probefile` is not under `/m/probe`, and treating it as one
    // Would serve a file nobody asked for.
    expect(await status("/m/probefile")).toBe(404);
  });

  test("a file that does not exist is still a miss under the base", async () => {
    expect(await status("/m/probe/assets/missing.js")).toBe(404);
  });
});
