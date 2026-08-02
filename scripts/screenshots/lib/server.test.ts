import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBundleFresh, ensureDevServer } from "./server";

const roots: string[] = [];

/** A throwaway repo with a studio `src` tree and (optionally) a built bundle. */
async function fakeRepo(opts: { bundleAgeMs?: number | null } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jx-shot-server-"));
  roots.push(root);
  await mkdir(join(root, "packages/studio/src/canvas"), { recursive: true });
  await mkdir(join(root, "packages/studio/dist"), { recursive: true });
  const source = join(root, "packages/studio/src/canvas/iframe-host.ts");
  await writeFile(source, "export const x = 1;\n");
  const when = new Date(Date.now() - 60_000);
  await utimes(source, when, when);
  if (opts.bundleAgeMs !== null) {
    const bundle = join(root, "packages/studio/dist/studio.js");
    await writeFile(bundle, "// bundle\n");
    const built = new Date(Date.now() - 60_000 + (opts.bundleAgeMs ?? 30_000));
    await utimes(bundle, built, built);
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("assertBundleFresh", () => {
  test("passes when the bundle is newer than every studio source file", async () => {
    const root = await fakeRepo({ bundleAgeMs: 30_000 });
    await expect(assertBundleFresh(root)).resolves.toBeUndefined();
  });

  test("names the source file the bundle is behind, so the report is actionable", async () => {
    const root = await fakeRepo({ bundleAgeMs: -30_000 });
    await expect(assertBundleFresh(root)).rejects.toThrow("stale bundle");
    await expect(assertBundleFresh(root)).rejects.toThrow(
      "packages/studio/src/canvas/iframe-host.ts",
    );
  });

  test("a nested source file counts — freshness is against the whole tree, not the top level", async () => {
    const root = await fakeRepo({ bundleAgeMs: 30_000 });
    const nested = join(root, "packages/studio/src/canvas/deep/nested.ts");
    await mkdir(join(root, "packages/studio/src/canvas/deep"), { recursive: true });
    await writeFile(nested, "export const y = 2;\n");
    await expect(assertBundleFresh(root)).rejects.toThrow("nested.ts");
  });

  test("a missing bundle is an error, not an implicit pass", async () => {
    const root = await fakeRepo({ bundleAgeMs: null });
    await expect(assertBundleFresh(root)).rejects.toThrow("does not exist");
  });
});

describe("ensureDevServer", () => {
  test("refuses to adopt a server it did not start unless reuse was asked for", async () => {
    // Serve on an ephemeral port so the probe succeeds without touching the repo's dev server.
    const served = Bun.serve({ fetch: () => new Response("ok"), port: 0 });
    try {
      const root = await fakeRepo({ bundleAgeMs: 30_000 });
      await expect(
        ensureDevServer(
          { repoRoot: root, studioPath: "/", url: `http://127.0.0.1:${served.port}` },
          () => {},
        ),
      ).rejects.toThrow("cannot know which bundle it was started with");
    } finally {
      await served.stop(true);
    }
  });

  test("--reuse-server adopts the running server, but only after the freshness assertion", async () => {
    const served = Bun.serve({ fetch: () => new Response("ok"), port: 0 });
    try {
      const url = `http://127.0.0.1:${served.port}`;
      const fresh = await fakeRepo({ bundleAgeMs: 30_000 });
      const lines: string[] = [];
      const adopted = await ensureDevServer(
        { repoRoot: fresh, reuse: true, studioPath: "/", url },
        (line) => lines.push(line),
      );
      expect(adopted).toMatchObject({ spawned: false, url });
      expect(lines.join("\n")).toContain("REUSING");
      await adopted.dispose();

      // Same adoption, stale bundle: reuse is exactly the case the assertion exists for.
      const stale = await fakeRepo({ bundleAgeMs: -30_000 });
      await expect(
        ensureDevServer({ repoRoot: stale, reuse: true, studioPath: "/", url }, () => {}),
      ).rejects.toThrow("stale bundle");
    } finally {
      await served.stop(true);
    }
  });
});
