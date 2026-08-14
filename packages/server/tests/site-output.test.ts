/**
 * The built site, served at its own routes.
 *
 * A built page is written for its published origin: `dist/basics/counter/index.html` links to
 * `/basics/counter` and pulls `/components/fetch-demo.css`, both root-absolute. `View: Open in
 * Browser` used to hand the browser the FILE path (`/dist/basics/counter/index.html`), and the two
 * absolutes then did what they always do — the HTML arrived, every stylesheet 404'd against the
 * server root, and the first link left the site. Measured against the running dev server before the
 * fix: `/dist/index.html` 200, `/components/fetch-demo.css` 404, `/basics/counter` 404.
 *
 * So the page is opened at its ROUTE now, and these are the answers that has to produce.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetSiteOutput, serveSiteOutput, siteOutDir } from "../src/site-output.ts";

const ROOT = join(import.meta.dir, "_site_output_fixtures");
const SITE = join(ROOT, "site");
const MOVED = join(ROOT, "moved");
const NOT_A_SITE = join(ROOT, "plain");

beforeAll(() => {
  rmSync(ROOT, { force: true, recursive: true });
  // A site whose build wrote the two shapes `trailingSlash` produces, plus an asset.
  mkdirSync(join(SITE, "dist", "basics", "counter"), { recursive: true });
  mkdirSync(join(SITE, "dist", "components"), { recursive: true });
  writeFileSync(join(SITE, "project.json"), JSON.stringify({ name: "site", version: "1.0.0" }));
  writeFileSync(join(SITE, "dist", "index.html"), "<html>home</html>");
  writeFileSync(join(SITE, "dist", "basics", "counter", "index.html"), "<html>counter</html>");
  writeFileSync(join(SITE, "dist", "about.html"), "<html>about</html>");
  writeFileSync(join(SITE, "dist", "components", "demo.css"), "body{color:red}");
  // A source file with the same name as a built one, to pin that this module is not what chooses.
  writeFileSync(join(SITE, "index.html"), "<html>SOURCE</html>");

  // The same site with `build.outDir` moved — a documented setting, so the default may not be read.
  mkdirSync(join(MOVED, "out"), { recursive: true });
  writeFileSync(
    join(MOVED, "project.json"),
    JSON.stringify({ build: { outDir: "out" }, name: "moved", version: "1.0.0" }),
  );
  writeFileSync(join(MOVED, "out", "index.html"), "<html>moved-home</html>");

  mkdirSync(NOT_A_SITE, { recursive: true });
  writeFileSync(join(NOT_A_SITE, "readme.md"), "# not a site");
});

afterAll(() => {
  rmSync(ROOT, { force: true, recursive: true });
});

beforeEach(() => {
  resetSiteOutput();
});

describe("siteOutDir", () => {
  test("defaults to dist for a site project", () => {
    expect(siteOutDir(SITE)).toBe(join(SITE, "dist"));
  });

  test("reads build.outDir rather than assuming — a moved output is not a stale one", () => {
    expect(siteOutDir(MOVED)).toBe(join(MOVED, "out"));
  });

  test("a directory with no project.json is not a site", () => {
    expect(siteOutDir(NOT_A_SITE)).toBeNull();
  });

  test("an unparseable project.json declines rather than guessing", () => {
    const broken = join(ROOT, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "project.json"), "{ not json");
    expect(siteOutDir(broken)).toBeNull();
  });

  test("the answer is cached per root, and a config edit moves it", () => {
    const moving = join(ROOT, "moving");
    mkdirSync(moving, { recursive: true });
    writeFileSync(join(moving, "project.json"), JSON.stringify({ name: "m", version: "1.0.0" }));
    expect(siteOutDir(moving)).toBe(join(moving, "dist"));
    // The mtime guard is what picks this up; a same-millisecond write would legitimately not.
    const later = new Date(Date.now() + 2000);
    writeFileSync(
      join(moving, "project.json"),
      JSON.stringify({ build: { outDir: "public_html" }, name: "m", version: "1.0.0" }),
    );
    utimesSync(join(moving, "project.json"), later, later);
    expect(siteOutDir(moving)).toBe(join(moving, "public_html"));
  });
});

describe("serveSiteOutput", () => {
  test("a route serves its index.html — with or without the trailing slash", async () => {
    for (const path of ["/basics/counter", "/basics/counter/"]) {
      const res = await serveSiteOutput(path, SITE);
      expect(res, path).not.toBeNull();
      expect(await res!.text()).toBe("<html>counter</html>");
    }
  });

  test("the site root is the home page", async () => {
    const res = await serveSiteOutput("/", SITE);
    expect(await res!.text()).toBe("<html>home</html>");
  });

  test("an asset the page names root-absolutely resolves — the missing styles", async () => {
    const res = await serveSiteOutput("/components/demo.css", SITE);
    expect(await res!.text()).toBe("body{color:red}");
  });

  test("`<route>.html` answers too, which is what trailingSlash: never writes", async () => {
    const res = await serveSiteOutput("/about", SITE);
    expect(await res!.text()).toBe("<html>about</html>");
  });

  test("a route with no output is null, not an empty page", async () => {
    expect(await serveSiteOutput("/nothing/here", SITE)).toBeNull();
  });

  test("a project that has never been built declines", async () => {
    const unbuilt = join(ROOT, "unbuilt");
    mkdirSync(unbuilt, { recursive: true });
    writeFileSync(join(unbuilt, "project.json"), JSON.stringify({ name: "u", version: "1.0.0" }));
    expect(await serveSiteOutput("/", unbuilt)).toBeNull();
  });

  test("a non-site directory declines", async () => {
    expect(await serveSiteOutput("/readme.md", NOT_A_SITE)).toBeNull();
  });

  test("it cannot be walked out of the output directory", async () => {
    // The traversal the containment check exists for: `dist/../index.html` is the SOURCE file, and
    // A preview that could reach it could reach anything beside it.
    expect(await serveSiteOutput("/../index.html", SITE)).toBeNull();
    expect(await serveSiteOutput("/../../outside.txt", SITE)).toBeNull();
  });

  test("it serves from the declared outDir, not from `dist`", async () => {
    const res = await serveSiteOutput("/", MOVED);
    expect(await res!.text()).toBe("<html>moved-home</html>");
  });
});
