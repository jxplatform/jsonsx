/**
 * `session.buildSite()` — the desktop half of `View: Open in Browser`.
 *
 * Two things have to be true of the reply, and the second is the one that bit us: it names the
 * counts, and it names the ORIGIN the result is browsable at. The origin is not this window's
 * project server, whose paths mean the project's SOURCES — a built page addresses its own output by
 * the same paths, so the reader on that origin gets the source file wherever both exist.
 */
import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

void mock.module("electrobun/main", () => ({
  BrowserWindow: class {},
  Electrobun: { start: () => {} },
  Utils: { openFileDialog: async () => [] },
}));

const compilerBuild = mock(async (..._args: unknown[]) => ({
  errors: [] as string[],
  files: 7,
  routes: 3,
}));
void mock.module("@jxsuite/compiler/site", () => ({ buildSite: compilerBuild }));

let previewOrigin: string | null = "http://127.0.0.1:4321";
const startSitePreview = mock((_root: string) =>
  previewOrigin ? { origin: previewOrigin, port: 4321 } : null,
);
void mock.module("@jxsuite/server/site-preview", () => ({ startSitePreview }));

const { createProjectSession } = await import("../src/project-session");

function withProject(): { root: string; session: ReturnType<typeof createProjectSession> } {
  const root = mkdtempSync(join(tmpdir(), "jx-build-site-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "project.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
  return { root, session: createProjectSession(root) };
}

describe("buildSite", () => {
  test("builds without cleaning, and names where the result is browsable", async () => {
    const { root, session } = withProject();
    try {
      expect(await session.buildSite()).toEqual({
        errors: [],
        files: 7,
        routes: 3,
        url: "http://127.0.0.1:4321",
      });
      // `clean: false` — the reader is on their way to a page, and wiping the output first would
      // Mean every asset 404s for as long as the build takes.
      expect(compilerBuild.mock.calls.at(-1)).toEqual([root, { clean: false, verbose: false }]);
      expect(startSitePreview.mock.calls.at(-1)).toEqual([root]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a build with no preview to serve says so by omission, not by inventing an origin", async () => {
    previewOrigin = null;
    const { root, session } = withProject();
    try {
      const result = await session.buildSite();
      expect(result.url).toBeUndefined();
      expect(result.routes).toBe(3);
    } finally {
      previewOrigin = "http://127.0.0.1:4321";
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("with no project open there is nothing to build", async () => {
    const session = createProjectSession(null);
    // oxlint-disable-next-line typescript/await-thenable -- .rejects is typed void, awaited at runtime
    await expect(session.buildSite()).rejects.toThrow("No project open");
  });
});
