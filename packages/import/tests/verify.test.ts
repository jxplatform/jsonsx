import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { routeToUrlPath, serveDirectory, verifyProject } from "../src/verify.ts";

describe("verify - routeToUrlPath", () => {
  it("pages/index.json → /", () => {
    expect(routeToUrlPath("pages/index.json")).toBe("/");
  });

  it("pages/about.json → /about", () => {
    expect(routeToUrlPath("pages/about.json")).toBe("/about");
  });

  it("pages/blog/post-1.json → /blog/post-1", () => {
    expect(routeToUrlPath("pages/blog/post-1.json")).toBe("/blog/post-1");
  });

  it("pages/blog/index.json → /blog", () => {
    expect(routeToUrlPath("pages/blog/index.json")).toBe("/blog");
  });

  it("pages/docs/getting-started/install.json → /docs/getting-started/install", () => {
    expect(routeToUrlPath("pages/docs/getting-started/install.json")).toBe(
      "/docs/getting-started/install",
    );
  });
});

describe("verify - serveDirectory", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync("/tmp/jx-import-verify-test-");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves index.html at /", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<html><body>Hello</body></html>");
    const { server, baseUrl } = serveDirectory(tmpDir);
    try {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Hello");
    } finally {
      server.stop();
    }
  });

  it("serves .html files with correct content type", async () => {
    writeFileSync(join(tmpDir, "about.html"), "<html><body>About</body></html>");
    const { server, baseUrl } = serveDirectory(tmpDir);
    try {
      const res = await fetch(`${baseUrl}/about.html`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    } finally {
      server.stop();
    }
  });

  it("serves .css files with correct content type", async () => {
    writeFileSync(join(tmpDir, "styles.css"), "body { color: red; }");
    const { server, baseUrl } = serveDirectory(tmpDir);
    try {
      const res = await fetch(`${baseUrl}/styles.css`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/css");
    } finally {
      server.stop();
    }
  });

  it("serves .js files with correct content type", async () => {
    writeFileSync(join(tmpDir, "app.js"), "console.log('hi');");
    const { server, baseUrl } = serveDirectory(tmpDir);
    try {
      const res = await fetch(`${baseUrl}/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/javascript");
    } finally {
      server.stop();
    }
  });

  it("returns 404 for nonexistent files", async () => {
    const { server, baseUrl } = serveDirectory(tmpDir);
    try {
      const res = await fetch(`${baseUrl}/nonexistent`);
      expect(res.status).toBe(404);
    } finally {
      server.stop();
    }
  });

  it("maps /foo to /foo/index.html when no extension", async () => {
    mkdirSync(join(tmpDir, "blog"), { recursive: true });
    writeFileSync(join(tmpDir, "blog/index.html"), "<html><body>Blog</body></html>");
    const { server, baseUrl } = serveDirectory(tmpDir);
    try {
      const res = await fetch(`${baseUrl}/blog`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Blog");
    } finally {
      server.stop();
    }
  });
});

describe("verify - verifyProject (build-failure path)", () => {
  it("handles nonexistent project directory gracefully", async () => {
    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // Minimal PNG header (will fail parsing but that's fine — build fails first)
    const result = await verifyProject({
      projectDir: "/tmp/nonexistent-jx-verify-dir-12345",
      pages: new Map([
        ["pages/index.json", { sourceUrl: "https://example.com", screenshot: dummyPng }],
      ]),
      onProgress: () => {},
    });

    expect(result.averageFidelity).toBe(0);
    expect(result.pages.length).toBe(1);
    expect(result.pages[0].error).toBeTruthy();
    expect(result.pages[0].error).toMatch(/build|not found|missing/i);
  });
});
