/**
 * The project server's import-site route: 404 when the option is absent, rpcToken + loopback
 * gating, and delegation to handleImportApi with the configured options (the import pipeline is
 * mocked — no browser runs).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

interface CapturedCall {
  options: Record<string, unknown>;
  onProgress: ((e: Record<string, unknown>) => void) | undefined;
}

const importCalls: CapturedCall[] = [];
const importSite = mock(
  (options: Record<string, unknown>, onProgress?: (e: Record<string, unknown>) => void) => {
    importCalls.push({ options, onProgress });
    const outDir = options.outDir as string;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "project.json"), JSON.stringify({ name: "Cloned" }));
    onProgress?.({ phase: "emit", message: "Wrote 1 file" });
    return Promise.resolve({ outDir, pages: [], fileCount: 1, verify: null, warnings: [] });
  },
);
void mock.module("@jxsuite/import/run", () => ({ importSite }));

const { createProjectServer } = await import("../src/project-server.ts");
type Handle = ReturnType<typeof createProjectServer>;

const ROOT = join(import.meta.dir, "_project_server_import_fixtures");
const STUDIO = join(ROOT, "_studio");
const DEST_PARENT = join(ROOT, "dests");

let withImport: Handle;
let withoutImport: Handle;

beforeAll(() => {
  rmSync(ROOT, { force: true, recursive: true });
  mkdirSync(STUDIO, { recursive: true });
  mkdirSync(DEST_PARENT, { recursive: true });
  writeFileSync(join(STUDIO, "index.html"), "<html>studio</html>");

  const session = { handlers: {}, projectRoot: null };
  withImport = createProjectServer({
    importApi: {
      chromePath: "/opt/chromium/bin/chromium",
      resolveDest: (dir: string) => {
        if (!isAbsolute(dir)) {
          throw new Error("directory must be an absolute path");
        }
        return dir;
      },
    },
    resolveSession: () => session,
    studioDir: STUDIO,
  });
  withoutImport = createProjectServer({
    resolveSession: () => session,
    studioDir: STUDIO,
  });
});

afterAll(() => {
  withImport.stop();
  withoutImport.stop();
  rmSync(ROOT, { force: true, recursive: true });
});

function importRequest(base: string, token: string | null, body?: unknown) {
  const url = token
    ? `${base}/__studio__/import-site?token=${encodeURIComponent(token)}`
    : `${base}/__studio__/import-site`;
  return fetch(url, {
    body: JSON.stringify(
      body ?? {
        url: "https://clone.example/",
        directory: join(DEST_PARENT, `dest-${importCalls.length}`),
      },
    ),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

describe("project-server import-site route", () => {
  test("404s when the server was created without importApi", async () => {
    const res = await importRequest(withoutImport.url, withoutImport.rpcToken);
    expect(res.status).toBe(404);
  });

  test("403s without the rpc token", async () => {
    const res = await importRequest(withImport.url, null);
    expect(res.status).toBe(403);
    expect(importSite).not.toHaveBeenCalled();
  });

  test("403s with a wrong token", async () => {
    const res = await importRequest(withImport.url, "wrong-token");
    expect(res.status).toBe(403);
  });

  test("403s a non-loopback Origin even with the right token", async () => {
    const res = await fetch(
      `${withImport.url}/__studio__/import-site?token=${withImport.rpcToken}`,
      {
        body: JSON.stringify({ url: "https://x.example", directory: "/tmp/x" }),
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        method: "POST",
      },
    );
    expect(res.status).toBe(403);
  });

  test("delegates a tokened request and streams to the done line", async () => {
    const dest = join(DEST_PARENT, "cloned");
    const res = await importRequest(withImport.url, withImport.rpcToken, {
      url: "https://clone.example/",
      directory: dest,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");

    const text = await res.text();
    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.at(-1)?.type).toBe("done");
    expect(lines.at(-1)?.root).toBe(dest);

    // The launcher's Chromium binary is threaded through to the pipeline.
    const opts = importCalls.at(-1)!.options;
    expect(opts.chromePath).toBe("/opt/chromium/bin/chromium");
    expect(opts.outDir).toBe(dest);
  });

  test("rejects a relative destination via the configured resolveDest", async () => {
    const res = await importRequest(withImport.url, withImport.rpcToken, {
      url: "https://clone.example/",
      directory: "relative/dest",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("absolute");
  });
});
