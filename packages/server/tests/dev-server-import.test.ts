/**
 * The dev server's /__studio/import-site mount: destination containment via assertAccessible and
 * the relative-root translation of the done line. The import pipeline is mocked.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const importSite = mock(
  (options: Record<string, unknown>, onProgress?: (e: Record<string, unknown>) => void) => {
    const outDir = options.outDir as string;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "project.json"), JSON.stringify({ name: "Imported" }));
    onProgress?.({ phase: "emit", message: "Wrote 1 file" });
    return Promise.resolve({ outDir, pages: [], fileCount: 1, verify: null, warnings: [] });
  },
);
void mock.module("@jxsuite/import/run", () => ({ importSite }));

const { createDevServer } = await import("../src/server");

const FIXTURES = resolve(import.meta.dir, "_dev_server_import_fixtures");

let server: { port: number | undefined; stop: () => void };
let base: string;

beforeAll(async () => {
  rmSync(FIXTURES, { force: true, recursive: true });
  mkdirSync(FIXTURES, { recursive: true });
  server = await createDevServer({ port: 0, root: FIXTURES, watch: false });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
  rmSync(FIXTURES, { force: true, recursive: true });
});

describe("dev server import-site mount", () => {
  test("imports into a root-relative directory and reports a relative root", async () => {
    const res = await fetch(`${base}/__studio/import-site`, {
      body: JSON.stringify({ directory: "imported-site", url: "https://clone.example/" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");

    const text = await res.text();
    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const done = lines.at(-1)!;
    expect(done.type).toBe("done");
    // The dev server reports project roots relative to its own root.
    expect(done.root).toBe("imported-site");
    expect(done.config).toEqual({ name: "Imported" });

    const opts = importSite.mock.calls.at(-1)?.[0] as { outDir: string };
    expect(opts.outDir).toBe(resolve(FIXTURES, "imported-site"));
  });

  test("rejects a destination outside the server root", async () => {
    const res = await fetch(`${base}/__studio/import-site`, {
      body: JSON.stringify({ directory: "../escape", url: "https://clone.example/" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("outside");
  });
});
