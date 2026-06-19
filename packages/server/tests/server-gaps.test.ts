import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDevServer, resolveNpmPath } from "../src/server";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const FIXTURES = resolve(import.meta.dir, "_server_gaps_fixtures");

function setupFixtures() {
  rmSync(FIXTURES, { force: true, recursive: true });
  mkdirSync(FIXTURES, { recursive: true });

  // Static files at server root
  writeFileSync(join(FIXTURES, "hello.txt"), "hello root");
  writeFileSync(join(FIXTURES, "page.html"), "<html><body><p>hi</p></body></html>");

  // Build entrypoint
  mkdirSync(join(FIXTURES, "src"), { recursive: true });
  writeFileSync(join(FIXTURES, "src", "entry.js"), "export const built = 42;");
  mkdirSync(join(FIXTURES, "dist"), { recursive: true });

  // Studio project for /__studio/activate fallbacks
  mkdirSync(join(FIXTURES, "proj", "public"), { recursive: true });
  writeFileSync(join(FIXTURES, "proj", "data.txt"), "project data");
  writeFileSync(join(FIXTURES, "proj", "public", "pub.txt"), "public data");

  // Npm packages for bare-specifier bundling
  mkdirSync(join(FIXTURES, "node_modules", "tinypkg"), { recursive: true });
  writeFileSync(
    join(FIXTURES, "node_modules", "tinypkg", "package.json"),
    JSON.stringify({ module: "./index.js", name: "tinypkg" }),
  );
  writeFileSync(join(FIXTURES, "node_modules", "tinypkg", "index.js"), "export const tiny = true;");

  // Package whose entry cannot be bundled (unresolvable import)
  mkdirSync(join(FIXTURES, "node_modules", "badpkg"), { recursive: true });
  writeFileSync(
    join(FIXTURES, "node_modules", "badpkg", "package.json"),
    JSON.stringify({ main: "./index.js", name: "badpkg" }),
  );
  writeFileSync(
    join(FIXTURES, "node_modules", "badpkg", "index.js"),
    'import x from "totally-unresolvable-module-xyz"; export default x;',
  );

  // Scoped package directory without package.json
  mkdirSync(join(FIXTURES, "node_modules", "@scope", "nopkg"), { recursive: true });

  // Package with customElements manifest-relative subpaths
  mkdirSync(join(FIXTURES, "node_modules", "cempkg", "dist", "widgets"), { recursive: true });
  writeFileSync(
    join(FIXTURES, "node_modules", "cempkg", "package.json"),
    JSON.stringify({ customElements: "dist/custom-elements.json", name: "cempkg" }),
  );
  writeFileSync(
    join(FIXTURES, "node_modules", "cempkg", "dist", "widgets", "w.js"),
    "export const w = 1;",
  );

  // Package with a subpath that exists on disk but not in exports
  mkdirSync(join(FIXTURES, "node_modules", "directpkg"), { recursive: true });
  writeFileSync(
    join(FIXTURES, "node_modules", "directpkg", "package.json"),
    JSON.stringify({ exports: { ".": "./main.js" }, name: "directpkg" }),
  );
  writeFileSync(join(FIXTURES, "node_modules", "directpkg", "main.js"), "export const m = 1;");
  writeFileSync(join(FIXTURES, "node_modules", "directpkg", "extra.js"), "export const e = 2;");

  // Package with invalid package.json
  mkdirSync(join(FIXTURES, "node_modules", "brokenpkg"), { recursive: true });
  writeFileSync(join(FIXTURES, "node_modules", "brokenpkg", "package.json"), "{not json!");
  writeFileSync(join(FIXTURES, "node_modules", "brokenpkg", "sub.js"), "export const s = 3;");

  // Package whose subpath is mapped through package.json "exports" to a real file
  mkdirSync(join(FIXTURES, "node_modules", "exportspkg", "lib"), { recursive: true });
  writeFileSync(
    join(FIXTURES, "node_modules", "exportspkg", "package.json"),
    JSON.stringify({ exports: { "./sub": "./lib/real.js" }, name: "exportspkg" }),
  );
  writeFileSync(
    join(FIXTURES, "node_modules", "exportspkg", "lib", "real.js"),
    "export const r = 1;",
  );
}

// ─── resolveNpmPath edge cases ───────────────────────────────────────────────

describe("resolveNpmPath — gaps", () => {
  beforeAll(() => setupFixtures());

  test("returns null for scoped package without package.json", () => {
    expect(resolveNpmPath(FIXTURES, "/@scope/nopkg/file.js")).toBeNull();
  });

  test("resolves subpath via direct path when exports has no entry", () => {
    const result = resolveNpmPath(FIXTURES, "/directpkg/extra.js");
    expect(result).toBe(join(FIXTURES, "node_modules", "directpkg", "extra.js"));
  });

  test("resolves subpath through a package.json exports string mapping", () => {
    const result = resolveNpmPath(FIXTURES, "/exportspkg/sub");
    expect(result).toBe(join(FIXTURES, "node_modules", "exportspkg", "lib", "real.js"));
  });

  test("resolves subpath relative to customElements manifest dir", () => {
    const result = resolveNpmPath(FIXTURES, "/cempkg/widgets/w.js");
    expect(result).toBe(join(FIXTURES, "node_modules", "cempkg", "dist", "widgets", "w.js"));
  });

  test("returns null for missing subpath in cem package", () => {
    expect(resolveNpmPath(FIXTURES, "/cempkg/widgets/missing.js")).toBeNull();
  });

  test("falls back to direct path when package.json is invalid JSON", () => {
    const result = resolveNpmPath(FIXTURES, "/brokenpkg/sub.js");
    expect(result).toBe(join(FIXTURES, "node_modules", "brokenpkg", "sub.js"));
  });

  test("returns null for bare package with invalid package.json", () => {
    expect(resolveNpmPath(FIXTURES, "/brokenpkg")).toBeNull();
  });

  test("returns null for bare package whose entry file is missing", () => {
    mkdirSync(join(FIXTURES, "node_modules", "ghost"), { recursive: true });
    writeFileSync(
      join(FIXTURES, "node_modules", "ghost", "package.json"),
      JSON.stringify({ main: "./missing.js", name: "ghost" }),
    );
    expect(resolveNpmPath(FIXTURES, "/ghost")).toBeNull();
  });
});

// ─── createDevServer ─────────────────────────────────────────────────────────

describe("createDevServer", () => {
  test("throws when root is missing", async () => {
    // @ts-expect-error — intentionally invalid options
    const promise = createDevServer({});
    // oxlint-disable-next-line typescript/await-thenable -- Bun's expect().rejects.toThrow() is typed as void but must be awaited at runtime
    await expect(promise).rejects.toThrow("root is required");
  });

  describe("with watch disabled", () => {
    let server: { port: number | undefined; stop: () => void };
    let base: string;

    beforeAll(async () => {
      setupFixtures();
      server = await createDevServer({
        builds: [
          {
            entrypoints: [join(FIXTURES, "src", "entry.js")],
            label: "app",
            match: /src/,
            outdir: join(FIXTURES, "dist"),
          },
        ],
        middleware: (_req, url) => (url.pathname === "/mw" ? new Response("mw-hit") : null),
        port: 0,
        root: FIXTURES,
        watch: false,
      });
      base = `http://localhost:${server.port}`;
    });

    afterAll(() => {
      server.stop();
      rmSync(FIXTURES, { force: true, recursive: true });
    });

    test("runs the build pipeline on startup", async () => {
      const res = await fetch(`${base}/dist/entry.js`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("42");
    });

    test("serves static files from root", async () => {
      const res = await fetch(`${base}/hello.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello root");
    });

    test("serves html without SSE injection when watch is off", async () => {
      const res = await fetch(`${base}/page.html`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("EventSource");
    });

    test("returns 404 for missing files", async () => {
      const res = await fetch(`${base}/nope.txt`);
      expect(res.status).toBe(404);
    });

    test("returns 404 for /__reload when watch is off", async () => {
      const res = await fetch(`${base}/__reload`);
      expect(res.status).toBe(404);
    });

    test("custom middleware can answer requests", async () => {
      const res = await fetch(`${base}/mw`);
      expect(await res.text()).toBe("mw-hit");
    });

    test("routes POST /__jx_resolve__ to handleResolve", async () => {
      const res = await fetch(`${base}/__jx_resolve__`, {
        body: JSON.stringify({}),
        method: "POST",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Missing $src");
    });

    test("routes POST /__jx_server__ to handleServerFunction", async () => {
      const res = await fetch(`${base}/__jx_server__`, {
        body: JSON.stringify({}),
        method: "POST",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Missing $src or $export");
    });

    test("activate sets the project root for static fallback", async () => {
      // Before activation, project-relative paths 404
      let res = await fetch(`${base}/data.txt`);
      expect(res.status).toBe(404);

      res = await fetch(`${base}/__studio/activate`, {
        body: JSON.stringify({ root: "proj" }),
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.root).toBe(join(FIXTURES, "proj"));

      // Project-relative file resolution
      res = await fetch(`${base}/data.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("project data");

      // Public/ fallback mirrors production
      res = await fetch(`${base}/pub.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("public data");
    });

    test("serves absolute filesystem paths under the active project", async () => {
      const abs = join(FIXTURES, "proj", "data.txt");
      const res = await fetch(`${base}/${abs}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("project data");
    });

    test("routes /__studio/code/* to handleCodeApi", async () => {
      const res = await fetch(`${base}/__studio/code/format`, {
        body: JSON.stringify({ code: "const x=1" }),
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { code: string };
      expect(typeof body.code).toBe("string");
    });

    test("routes other /__studio/* paths to handleStudioApi", async () => {
      const res = await fetch(`${base}/__studio/sites`);
      expect(res.status).toBe(200);
      const sites = await res.json();
      expect(Array.isArray(sites)).toBe(true);
    });

    test("unknown /__studio/* path falls through to a 404", async () => {
      const res = await fetch(`${base}/__studio/this-endpoint-does-not-exist`);
      expect(res.status).toBe(404);
    });

    test("bundles npm bare specifiers on demand and caches them", async () => {
      let res = await fetch(`${base}/tinypkg`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("javascript");
      const text = await res.text();
      expect(text).toContain("tiny");

      // Second request hits the bundle cache
      res = await fetch(`${base}/tinypkg`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(text);
    });

    test("returns 404 when bundling fails", async () => {
      const res = await fetch(`${base}/badpkg`);
      expect(res.status).toBe(404);
    });

    test("deactivation resets project root", async () => {
      let res = await fetch(`${base}/__studio/activate`, {
        body: JSON.stringify({ root: "" }),
        method: "POST",
      });
      const payload = await res.json();
      expect(payload.root).toBeNull();
      res = await fetch(`${base}/data.txt`);
      expect(res.status).toBe(404);
    });
  });

  describe("with watch enabled", () => {
    const WATCH_ROOT = resolve(import.meta.dir, "_server_gaps_watch");
    let server: { port: number | undefined; stop: () => void };
    let base: string;

    beforeAll(async () => {
      rmSync(WATCH_ROOT, { force: true, recursive: true });
      mkdirSync(WATCH_ROOT, { recursive: true });
      writeFileSync(join(WATCH_ROOT, "index.html"), "<html><body>home</body></html>");
      server = await createDevServer({
        port: 0,
        root: WATCH_ROOT,
        studio: false,
        watch: { debounce: 10, reloadOnAnyChange: true },
      });
      base = `http://localhost:${server.port}`;
    });

    afterAll(() => {
      server.stop();
      rmSync(WATCH_ROOT, { force: true, recursive: true });
    });

    test("serves SSE stream at /__reload and broadcasts on change", async () => {
      const controller = new AbortController();
      const resPromise = fetch(`${base}/__reload`, { signal: controller.signal });
      // Touch a file repeatedly until the watcher broadcasts the reload event
      const interval = setInterval(() => {
        writeFileSync(join(WATCH_ROOT, "trigger.txt"), `change-${Date.now()}`);
      }, 100);
      try {
        const res = await resPromise;
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("text/event-stream");
        const reader = (res.body as ReadableStream).getReader();
        const { value } = await reader.read();
        expect(new TextDecoder().decode(value)).toContain("data: reload");
        void reader.cancel();
      } finally {
        clearInterval(interval);
        controller.abort();
      }
    });

    test("injects SSE reload script into html responses", async () => {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("EventSource");
      expect(html).toContain("/__reload");
    });

    test("studio endpoints are disabled when studio: false", async () => {
      const res = await fetch(`${base}/__studio/activate`, {
        body: JSON.stringify({ root: "" }),
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });
});
