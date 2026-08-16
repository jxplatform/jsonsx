import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertBundleFresh,
  ensureDevServer,
  forgetOverlays,
  materialiseGitFixture,
  normalizeServerUrl,
  overlayProject,
  WORK_DIR,
} from "./server";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** Run git in `cwd` and return stdout. The fixture tests assert on real repository state. */
async function run(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
  return out;
}

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
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(assertBundleFresh(root)).resolves.toBeUndefined();
  });

  test("names the source file the bundle is behind, so the report is actionable", async () => {
    const root = await fakeRepo({ bundleAgeMs: -30_000 });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(assertBundleFresh(root)).rejects.toThrow("stale bundle");
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(assertBundleFresh(root)).rejects.toThrow(
      "packages/studio/src/canvas/iframe-host.ts",
    );
  });

  test("a nested source file counts — freshness is against the whole tree, not the top level", async () => {
    const root = await fakeRepo({ bundleAgeMs: 30_000 });
    const nested = join(root, "packages/studio/src/canvas/deep/nested.ts");
    await mkdir(join(root, "packages/studio/src/canvas/deep"), { recursive: true });
    await writeFile(nested, "export const y = 2;\n");
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(assertBundleFresh(root)).rejects.toThrow("nested.ts");
  });

  test("a missing bundle is an error, not an implicit pass", async () => {
    const root = await fakeRepo({ bundleAgeMs: null });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(assertBundleFresh(root)).rejects.toThrow("does not exist");
  });
});

describe("ensureDevServer", () => {
  test("refuses to adopt a server it did not start unless reuse was asked for", async () => {
    // Serve on an ephemeral port so the probe succeeds without touching the repo's dev server.
    const served = Bun.serve({ fetch: () => new Response("ok"), port: 0 });
    try {
      const root = await fakeRepo({ bundleAgeMs: 30_000 });
      // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
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
      // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
      await expect(
        ensureDevServer({ repoRoot: stale, reuse: true, studioPath: "/", url }, () => {}),
      ).rejects.toThrow("stale bundle");
    } finally {
      await served.stop(true);
    }
  });
});

describe("normalizeServerUrl", () => {
  test("localhost becomes 127.0.0.1 — the dev server binds IPv4 only", () => {
    expect(normalizeServerUrl("http://localhost:3000")).toBe("http://127.0.0.1:3000");
    expect(normalizeServerUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });
});

/** A throwaway repo with one committed "starter" project inside it. */
async function repoWithProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jx-shot-overlay-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, "starter", rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

describe("overlayProject", () => {
  test("a shot opens a copy, and writing through it cannot reach the committed file", async () => {
    const root = await repoWithProject({
      "pages/index.md": "# Come for the coffee\n",
      "project.json": '{ "name": "Starter" }\n',
    });
    forgetOverlays();
    const overlay = await overlayProject(root, "starter");

    expect(overlay.root).toContain(WORK_DIR);
    expect(overlay.root).not.toBe(join(root, "starter"));
    expect(await Bun.file(join(overlay.root, "pages/index.md")).text()).toBe(
      "# Come for the coffee\n",
    );

    // What `slash-menu-shot` used to do to a committed starter, and then undo by hand.
    await writeFile(join(overlay.root, "pages/index.md"), "# Come hungry\n");
    expect(await Bun.file(join(root, "starter/pages/index.md")).text()).toBe(
      "# Come for the coffee\n",
    );
  });

  test("reset undoes a modification, a creation and a deletion", async () => {
    const root = await repoWithProject({
      "pages/index.md": "original\n",
      "pages/menu.md": "menu\n",
      "project.json": "{}\n",
    });
    forgetOverlays();
    const overlay = await overlayProject(root, "starter");

    await writeFile(join(overlay.root, "pages/index.md"), "edited by a step\n");
    await writeFile(join(overlay.root, "pages/new.md"), "created by a step\n");
    await rm(join(overlay.root, "pages/menu.md"));

    await overlay.reset();

    expect(await Bun.file(join(overlay.root, "pages/index.md")).text()).toBe("original\n");
    expect(await Bun.file(join(overlay.root, "pages/menu.md")).text()).toBe("menu\n");
    expect(existsSync(join(overlay.root, "pages/new.md"))).toBe(false);
  });

  test("the copy is memoised per project, so twenty shots share one materialisation", async () => {
    const root = await repoWithProject({ "project.json": "{}\n" });
    forgetOverlays();
    const first = await overlayProject(root, "starter");
    const second = await overlayProject(root, "starter");
    expect(second).toBe(first);
  });

  test("node_modules is symlinked, never copied — the shop starter's is 69 MB", async () => {
    const root = await repoWithProject({
      "node_modules/dep/index.js": "export const x = 1;\n",
      "project.json": "{}\n",
    });
    forgetOverlays();
    const overlay = await overlayProject(root, "starter");
    const linked = await lstat(join(overlay.root, "node_modules"));
    expect(linked.isSymbolicLink()).toBe(true);
  });

  test("a project that does not exist fails naming the path, not the symptom", async () => {
    const root = await repoWithProject({ "project.json": "{}\n" });
    forgetOverlays();
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(overlayProject(root, "packages/starters/sites/ghost")).rejects.toThrow(
      "does not exist",
    );
  });
});

describe("materialiseGitFixture", () => {
  test("builds a repository whose history and dirty set are the same on every machine", async () => {
    const root = await mkdtemp(join(tmpdir(), "jx-shot-fixture-"));
    roots.push(root);
    const source = join(REPO_ROOT, "scripts/screenshots/fixtures/repos/showcase");
    const dest = join(root, "showcase");
    await materialiseGitFixture(source, dest);

    /*
     * `%at` — the author date as epoch seconds — and not `--date=iso-strict`.
     *
     * The fixture pins each date as `…Z`, git stores it as an instant plus an offset, and
     * `iso-strict` renders a zero offset as `+00:00`. So an assertion written against the fixture's
     * own spelling never matched git's, and the test failed on the FORMAT while the thing it exists
     * to prove — that the instant is pinned — was correct all along. Epoch seconds have one
     * spelling in every git version; `toISOString` gives the readable form back.
     */
    const log = await run(dest, ["log", "--format=%s|%at|%an"]);
    const commits = log
      .trim()
      .split("\n")
      .map((row) => {
        const [subject, at, author] = row.split("|");
        const when = new Date(Number(at) * 1000).toISOString().replace(".000Z", "Z");
        return `${subject}|${when}|${author}`;
      });
    expect(commits).toEqual([
      "Add the listings page and its card|2026-01-14T16:42:00Z|Rae Okonjo",
      "Add the Showcase site skeleton|2026-01-12T09:14:00Z|Rae Okonjo",
    ]);

    const status = await run(dest, ["status", "--porcelain"]);
    expect(status.trimEnd().split("\n").toSorted()).toEqual([
      " D pages/about.md",
      " M pages/index.md",
      "?? components/sc-cta.json",
    ]);
  });

  test("rebuilding is the reset, so a shot may stage and commit inside the fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "jx-shot-fixture-reset-"));
    roots.push(root);
    const source = join(REPO_ROOT, "scripts/screenshots/fixtures/repos/showcase");
    const dest = join(root, "showcase");
    await materialiseGitFixture(source, dest);
    await run(dest, ["add", "-A"]);
    await run(dest, [
      "-c",
      "user.name=x",
      "-c",
      "user.email=x@y.z",
      "commit",
      "-m",
      "a shot did this",
    ]);
    const clean = await run(dest, ["status", "--porcelain"]);
    expect(clean.trim()).toBe("");

    await materialiseGitFixture(source, dest);
    const dirty = await run(dest, ["status", "--porcelain"]);
    expect(dirty.trim()).not.toBe("");
    expect(await run(dest, ["log", "--oneline"])).not.toContain("a shot did this");
  });
});
