/**
 * The decision order a site origin answers with: file, then route, then the host's own lane, then
 * the project's own 404.
 *
 * Getting that order wrong is visible in both directions — a `pages/` document served as JSON
 * instead of rendered, or a `/favicon.svg` answered with someone's index page.
 */
import { describe, expect, test } from "bun:test";
import { serveSite, siteContext, siteHeaders } from "../src/serve.ts";
import type { AssetIO, ServeOptions } from "../src/serve.ts";
import type { SiteIO } from "../src/compose.ts";

const SHELL: ServeOptions = { shell: { base: "/", runtimeUrl: "/__jx_live__/runtime.js" } };
const PAGE = JSON.stringify({ children: ["Hello"], tagName: "main" });

function tree(files: Record<string, string>): { io: SiteIO; assets: AssetIO } {
  return {
    assets: {
      bytes: (path) =>
        Promise.resolve(path in files ? new TextEncoder().encode(files[path]) : null),
    },
    io: { paths: () => Object.keys(files), read: (path) => Promise.resolve(files[path] ?? null) },
  };
}

async function serve(files: Record<string, string>, pathname: string, options = SHELL) {
  const { io, assets } = tree(files);
  return serveSite(pathname, io, assets, await siteContext(io), options);
}

describe("siteHeaders", () => {
  test("a composed page is never cached — it is not revalidatable", () => {
    expect(siteHeaders("text/html")["Cache-Control"]).toBe("private, no-store");
  });

  test("a working copy is never indexed", () => {
    expect(siteHeaders("text/html")["X-Robots-Tag"]).toBe("noindex, nofollow");
  });

  test("the declared type is the served type, and sniffing is off", () => {
    const headers = siteHeaders("image/png");
    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("same-origin");
  });
});

describe("serveSite", () => {
  test("a file the tree really has beats a route", async () => {
    const res = await serve({ "public/robots.txt": "User-agent: *" }, "/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("User-agent: *");
  });

  test("a page route renders the shell", async () => {
    const res = await serve({ "pages/index.json": PAGE }, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain('id="jx-page-document"');
  });

  test("a page URL with the trailing slash build.trailingSlash writes renders", async () => {
    const res = await serve({ "pages/blog/hello.json": PAGE }, "/blog/hello/");
    expect(res.status).toBe(200);
  });

  test("a component the runtime asks for is served at its own project path", async () => {
    const res = await serve({ "components/card.json": "{}" }, "/components/card.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });

  test("the project's own 404 page is served, at 404", async () => {
    const res = await serve(
      { "pages/404.json": JSON.stringify({ children: ["Nothing here"], tagName: "main" }) },
      "/nope",
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("Nothing here");
  });

  test("a project with no 404 page gets a plain one", async () => {
    const res = await serve({ "pages/index.json": PAGE }, "/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  test("a path that is not one 404s without reading anything", async () => {
    const res = await serve({ "pages/index.json": PAGE }, "/../secrets");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  test("project.json is not servable, even though the composer reads it", async () => {
    const res = await serve({ "project.json": '{"name":"Acme"}' }, "/project.json");
    expect(res.status).toBe(404);
  });

  test("a compose failure is a page naming the reason, not an opaque 500", async () => {
    const res = await serve(
      {
        "pages/index.json": JSON.stringify({ $layout: "./layouts/gone.json", tagName: "main" }),
      },
      "/",
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Layout not found: ./layouts/gone.json");
  });

  test("the host's fallback runs after routes and before the 404", async () => {
    const seen: string[] = [];
    const res = await serve({ "pages/index.json": PAGE }, "/node_modules/x/index.js", {
      ...SHELL,
      fallback: (requestPath) => {
        seen.push(requestPath);
        return Promise.resolve(new Response("bundled", { status: 200 }));
      },
    });
    expect(seen).toEqual(["node_modules/x/index.js"]);
    expect(await res.text()).toBe("bundled");
  });

  test("a fallback that declines still reaches the project's own 404", async () => {
    const res = await serve(
      { "pages/404.json": JSON.stringify({ children: ["Nope"], tagName: "main" }) },
      "/missing",
      { ...SHELL, fallback: () => Promise.resolve(null) },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Nope");
  });

  test("a route wins over the fallback — the fallback is not consulted at all", async () => {
    let called = false;
    await serve({ "pages/index.json": PAGE }, "/", {
      ...SHELL,
      fallback: () => {
        called = true;
        return Promise.resolve(null);
      },
    });
    expect(called).toBe(false);
  });

  test("a non-ComposeError from the tree is not swallowed", async () => {
    const io: SiteIO = {
      paths: () => ["pages/index.json"],
      read: (path) => {
        if (path === "pages/index.json") {
          return Promise.reject(new TypeError("disk on fire"));
        }
        return Promise.resolve(null);
      },
    };
    const assets: AssetIO = { bytes: () => Promise.resolve(null) };
    const context = { config: {} as never, routes: [] as never };
    const seeded = await siteContext(tree({ "pages/index.json": PAGE }).io);
    const withRoutes = { ...context, routes: seeded.routes };
    await expect(serveSite("/", io, assets, withRoutes, SHELL)).rejects.toThrow("disk on fire");
  });
});
