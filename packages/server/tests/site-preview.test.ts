// oxlint-disable typescript/await-thenable -- bun test .rejects is typed `void` but returns a real Promise; the await is required.
/**
 * The built site on its own origin — the three answers `View: Open in Browser` needs, plus the one
 * that made the second origin necessary.
 *
 * The first fix served the output as the LAST step of the editing server's chain, so it could only
 * fill a 404. That is a safe ordering and still the wrong shape: the two URL spaces do not merely
 * risk collision, they collide by construction. `/components/fetch-demo.js` is the formula module
 * in a project's sources and the custom-element definition in its output, and a reader on the
 * editor's origin got the formulas — measured in a real browser as a page that rendered, with
 * `customElements.get("fetch-demo")` null and nothing on it doing anything. No ordering fixes that;
 * one origin cannot hold two meanings for one path.
 *
 * Run in a subprocess for the reason `activate.test.ts` gives: other suites in this process mock
 * `globalThis.fetch`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sitePreviewOrigin, startSitePreview, stopSitePreviews } from "../src/site-preview.ts";

const FIXTURES = resolve(import.meta.dir, "_site_preview_fixtures");

function ensureFixtures() {
  rmSync(FIXTURES, { force: true, recursive: true });
  const site = join(FIXTURES, "site");
  mkdirSync(join(site, "dist", "blog", "hello"), { recursive: true });
  mkdirSync(join(site, "dist", "components"), { recursive: true });
  mkdirSync(join(site, "pages"), { recursive: true });
  mkdirSync(join(FIXTURES, "repo-only"), { recursive: true });
  writeFileSync(join(site, "project.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
  // What the compiler wrote, linking and loading root-absolutely, as a built page does.
  writeFileSync(
    join(site, "dist", "index.html"),
    '<html><link href="/components/demo.css" rel="stylesheet">' +
      '<script type="module" src="/components/demo.js"></script>' +
      '<a href="/blog/hello/">go</a></html>',
  );
  writeFileSync(join(site, "dist", "blog", "hello", "index.html"), "<html>hello</html>");
  writeFileSync(join(site, "dist", "components", "demo.css"), "body{color:red}");
  writeFileSync(join(site, "dist", "components", "demo.js"), "customElements.define('x-demo', C);");
  writeFileSync(join(site, "dist", "404.html"), "<html>the site's own 404</html>");
  /* The collision, in one pair of files: the same URL, a source module and a built module. The
     source is what the canvas reads; the built one is what the page needs. */
  mkdirSync(join(site, "components"), { recursive: true });
  writeFileSync(join(site, "components", "demo.js"), "export const formula = 1;");
  writeFileSync(join(site, "pages", "index.json"), '{"source":true}');
  mkdirSync(join(site, "dist", "pages"), { recursive: true });
  writeFileSync(join(site, "dist", "pages", "index.json"), '{"built":true}');
  writeFileSync(join(FIXTURES, "repo-only", "readme.txt"), "from the repo");
  // A site with SOURCES and no output — what every project looks like before anyone builds, and
  // The state `View: Open in Browser` used to open a 404 in.
  const unbuilt = join(FIXTURES, "unbuilt", "pages");
  mkdirSync(unbuilt, { recursive: true });
  writeFileSync(
    join(FIXTURES, "unbuilt", "project.json"),
    JSON.stringify({ name: "unbuilt", version: "1.0.0" }),
  );
  writeFileSync(
    join(unbuilt, "index.json"),
    JSON.stringify({ children: [{ tagName: "h1", textContent: "Fresh" }], title: "Unbuilt" }),
  );
}

describe("the built site over a live server", () => {
  test("is browsable at its own origin, and never mixed into the editor's", async () => {
    ensureFixtures();
    const serverPath = resolve(import.meta.dir, "../src/server.js").replaceAll("\\", "/");
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `
const { createDevServer } = await import(${JSON.stringify(serverPath)});
const { stopSitePreviews } = await import(${JSON.stringify(serverPath.replace("server.js", "site-preview.js"))});
const FIXTURES = ${JSON.stringify(FIXTURES)};
const server = await createDevServer({ root: FIXTURES, port: 0, builds: [], watch: false, studio: true });
const base = "http://localhost:" + server.port;
const errors = [];
const get = async (path) => fetch(base + path);

await fetch(base + "/__studio/activate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ root: "site" }),
});

// 1. The editor's origin serves the project's SOURCES and nothing of its output, at any position
//    in its chain. A built page arriving here is the bug this shape exists to make impossible.
let res = await get("/blog/hello/");
if (res.status !== 404) errors.push("editor origin served a built route: " + res.status);
res = await get("/components/demo.js");
if (!(await res.text()).includes("formula")) errors.push("editor origin: source module shadowed");

// 2. Building reports WHERE the result is browsable. The caller cannot know that port.
res = await fetch(base + "/__studio/build", { method: "POST" });
if (res.status !== 200) errors.push("build: expected 200, got " + res.status);
const build = await res.json();
if (!/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(build.url || "")) {
  errors.push("build url: " + JSON.stringify(build.url));
}
const site = build.url;
const siteGet = async (path) => fetch(site + path);

// 3. The page, at the route it will be published at — what used to be /dist/index.html.
res = await siteGet("/");
if (res.status !== 200) errors.push("home: expected 200, got " + res.status);

// 4. The stylesheet the page names root-absolutely — the "misses out on styles" report.
res = await siteGet("/components/demo.css");
if (res.status !== 200) errors.push("stylesheet: expected 200, got " + res.status);
else if ((await res.text()) !== "body{color:red}") errors.push("stylesheet body wrong");

// 5. And the module it loads at THAT SAME URL, which is a different file in the sources. This is
//    the whole reason for a second origin: here the path means the output, and only the output.
res = await siteGet("/components/demo.js");
const moduleBody = await res.text();
if (!moduleBody.includes("customElements.define")) errors.push("module: got " + moduleBody);
const moduleType = res.headers.get("content-type") || "";
if (!/javascript|ecmascript/i.test(moduleType)) errors.push("module MIME: " + moduleType);

// 6. The link on that page — the "navigation fails entirely" report. Both spellings.
for (const path of ["/blog/hello/", "/blog/hello"]) {
  res = await siteGet(path);
  if (res.status !== 200) errors.push(path + ": expected 200, got " + res.status);
  else if (!(await res.text()).includes("hello")) errors.push(path + ": wrong page");
}

// 7. A miss is the SITE's own 404 page, at 404 — what the static host will serve.
res = await siteGet("/nothing/here");
if (res.status !== 404) errors.push("miss: expected 404, got " + res.status);
else if (!(await res.text()).includes("the site's own 404")) errors.push("miss: not the site's 404");

// 8. Nothing about the editor's own URL space changed: its sources still win at their URLs and
//    the repository's files are still there.
res = await get("/pages/index.json");
const body = await res.text();
if (!body.includes("source")) errors.push("source file shadowed by output: " + body);
res = await get("/repo-only/readme.txt");
if (res.status !== 200) errors.push("repo file: expected 200, got " + res.status);

// 9. A project that has never been built: POST /__studio/build writes the output and the route
//    then answers. This is the other half of "as if published" — the reader sees what the author
//    is looking at, not what the last build left on disk.
await fetch(base + "/__studio/activate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ root: "unbuilt" }),
});
res = await fetch(base + "/__studio/build", { method: "POST" });
if (res.status !== 200) errors.push("unbuilt build: expected 200, got " + res.status);
const second = await res.json();
if (second.routes !== 1) errors.push("build routes: " + JSON.stringify(second));
if (second.errors.length !== 0) errors.push("build errors: " + JSON.stringify(second.errors));
if (second.url === site) errors.push("two projects shared one preview origin");
res = await fetch(second.url + "/");
if (res.status !== 200) errors.push("built route: expected 200, got " + res.status);
else if (!(await res.text()).includes("Fresh")) errors.push("built route served the wrong page");

// 10. A directory that is not a site project cannot be built, and says so.
await fetch(base + "/__studio/activate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ root: "repo-only" }),
});
res = await fetch(base + "/__studio/build", { method: "POST" });
if (res.status !== 400) errors.push("non-site build: expected 400, got " + res.status);

stopSitePreviews();
server.stop();
if (errors.length) {
  console.error("FAILURES:\\n" + errors.join("\\n"));
  process.exit(1);
}
console.log("ALL_PASS");
process.exit(0);
`,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(`${out}${err}`).toContain("ALL_PASS");
    rmSync(FIXTURES, { force: true, recursive: true });
  }, 30_000);
});

describe("startSitePreview", () => {
  const ROOT = resolve(import.meta.dir, "_site_preview_unit");
  const SITE = join(ROOT, "site");

  function unitFixtures() {
    rmSync(ROOT, { force: true, recursive: true });
    mkdirSync(join(SITE, "dist", "guide"), { recursive: true });
    mkdirSync(join(ROOT, "plain"), { recursive: true });
    writeFileSync(join(SITE, "project.json"), JSON.stringify({ name: "s", version: "1.0.0" }));
    writeFileSync(join(SITE, "dist", "index.html"), "<html>home</html>");
    writeFileSync(join(SITE, "dist", "guide", "index.html"), "<html>guide</html>");
  }

  afterAll(() => {
    stopSitePreviews();
    rmSync(ROOT, { force: true, recursive: true });
  });

  test("serves the built site, and only it", async () => {
    unitFixtures();
    const preview = startSitePreview(SITE);
    expect(preview).not.toBeNull();
    expect(preview!.origin).toBe(`http://127.0.0.1:${preview!.port}`);
    const home = await fetch(`${preview!.origin}/`);
    expect(await home.text()).toBe("<html>home</html>");
    const guide = await fetch(`${preview!.origin}/guide`);
    expect(await guide.text()).toBe("<html>guide</html>");
    // No 404.html here, so the server says so plainly rather than inventing a page.
    const miss = await fetch(`${preview!.origin}/nope`);
    expect(miss.status).toBe(404);
    /* Containment: the site's own sources sit one level up from the output. Encoded, because a
       plain `../` is normalised away by the client and would prove nothing about this server. */
    const traversal = await fetch(`${preview!.origin}/%2e%2e/project.json`);
    expect(traversal.status).toBe(404);
  });

  test("one server per project — ten opened pages are one port", () => {
    const first = startSitePreview(SITE);
    const second = startSitePreview(SITE);
    expect(second!.port).toBe(first!.port);
    expect(sitePreviewOrigin(SITE)).toBe(first!.origin);
  });

  test("a directory that builds no site gets no server", () => {
    expect(startSitePreview(join(ROOT, "plain"))).toBeNull();
    expect(sitePreviewOrigin(join(ROOT, "plain"))).toBeNull();
  });

  test("a malformed URL is a bad request, not a crash", async () => {
    const preview = startSitePreview(SITE)!;
    const res = await fetch(`${preview.origin}/%E0%A4%A`);
    expect(res.status).toBe(400);
  });

  test("stopping closes the port", async () => {
    const preview = startSitePreview(SITE)!;
    stopSitePreviews();
    expect(sitePreviewOrigin(SITE)).toBeNull();
    await expect(fetch(`${preview.origin}/`)).rejects.toThrow();
  });
});
