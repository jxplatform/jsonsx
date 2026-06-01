import { describe, test, expect } from "bun:test";
import { join, resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const FIXTURES = resolve(import.meta.dir, "_activate_fixtures");

// Write a small valid PNG (1x1 transparent pixel)
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
    "Nl7pcQAAAABJRU5ErkJggg==",
  "base64",
);

function ensureFixtures() {
  mkdirSync(join(FIXTURES, "sites/demo/public"), { recursive: true });
  mkdirSync(join(FIXTURES, "root-public"), { recursive: true });
  writeFileSync(join(FIXTURES, "sites/demo/project.json"), JSON.stringify({ name: "demo" }));
  writeFileSync(join(FIXTURES, "sites/demo/public/image.png"), PNG_1x1);
  writeFileSync(join(FIXTURES, "root-public/root-file.txt"), "hello from root");
}

/**
 * Run the activate integration test in a subprocess to avoid globalThis.fetch mock pollution from
 * other test files running in the same process.
 */
describe("/__studio/activate + static file serving", () => {
  test("activate endpoint controls project-relative static file resolution", async () => {
    ensureFixtures();
    try {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
const { createDevServer } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/server.js").replaceAll("\\", "/"))});
const { join } = await import("node:path");
const fwd = (p) => p.replaceAll("\\\\", "/");

const FIXTURES = ${JSON.stringify(FIXTURES)};
const server = await createDevServer({ root: FIXTURES, port: 0, builds: [], watch: false, studio: true });
const base = "http://localhost:" + server.port;
const errors = [];

// Test 1: static file at repo root resolves normally
let res = await fetch(base + "/root-public/root-file.txt");
if (res.status !== 200) errors.push("repo root file: expected 200, got " + res.status);
let text = await res.text();
if (text !== "hello from root") errors.push("repo root file content: " + text);

// Test 2: project-relative path 404s before activation
res = await fetch(base + "/public/image.png");
if (res.status !== 404) errors.push("pre-activate: expected 404, got " + res.status);

// Test 3: POST /__studio/activate sets active project root
res = await fetch(base + "/__studio/activate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ root: "sites/demo" }),
});
if (res.status !== 200) errors.push("activate: expected 200, got " + res.status);
let body = await res.json();
const expectedActiveRoot = join(FIXTURES, "sites/demo");
if (fwd(body.root) !== fwd(expectedActiveRoot)) errors.push("activate root: " + JSON.stringify(body));

// Test 4: project-relative path resolves after activation
res = await fetch(base + "/public/image.png");
if (res.status !== 200) errors.push("post-activate: expected 200, got " + res.status);
else {
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf[0] !== 0x89 || buf[1] !== 0x50) errors.push("png magic bytes wrong");
}

// Test 5: repo-root files still resolve after activation
res = await fetch(base + "/root-public/root-file.txt");
if (res.status !== 200) errors.push("repo root after activate: expected 200, got " + res.status);

// Test 6: resolveSiteContext returns absolute relPath for ?open= flow
const absPath = join(FIXTURES, "sites/demo/project.json");
res = await fetch(base + "/__studio/resolve-site?path=" + encodeURIComponent(absPath));
if (res.status !== 200) errors.push("resolve-site: expected 200, got " + res.status);
else {
  body = await res.json();
  const expectedPath = join(FIXTURES, "sites/demo");
  if (body.relPath !== fwd(expectedPath)) errors.push("resolve-site relPath: " + body.relPath + " (expected " + fwd(expectedPath) + ")");
}

// Test 7: deactivation resets resolution
await fetch(base + "/__studio/activate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ root: "" }),
});
res = await fetch(base + "/public/image.png");
if (res.status !== 404) errors.push("post-deactivate: expected 404, got " + res.status);

server.stop();

if (errors.length) {
  console.error("FAILURES:\\n" + errors.join("\\n"));
  process.exit(1);
} else {
  console.log("ALL_PASS");
  process.exit(0);
}
`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const result = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (result !== 0) {
        throw new Error(`Subprocess failed:\n${stdout}\n${stderr}`);
      }
      expect(stdout).toContain("ALL_PASS");
    } finally {
      rmSync(FIXTURES, { recursive: true, force: true });
    }
  });
});
