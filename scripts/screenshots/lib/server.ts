/**
 * What the shot photographs, before the browser opens: the dev server, and the files under it.
 *
 * **The server.** The runner SPAWNS ITS OWN. It used to adopt whatever answered on the manifest
 * URL, which made every capture a photograph of whatever `packages/studio/dist` that server
 * happened to have been started with — a bundle nobody in the run could name. `bun server.js`
 * rebuilds the studio bundles at startup, so a server the runner started is by construction serving
 * the working tree. Reuse survives as `--reuse-server`, for tuning shot definitions against an
 * editor's live server: opt-in, announced, and gated on {@link assertBundleFresh}, because a reused
 * server is exactly the case where the bundle can be older than the source.
 *
 * **The files.** No shot opens a committed project. {@link overlayProject} materialises a
 * copy-on-write copy under `.cache/screenshots/` and the shot opens that, so a step that types into
 * a page cannot reach `packages/starters/**`. This deletes a real hazard rather than a theoretical
 * one: `slash-menu-shot` pressed Enter into a committed starter file and then ran a cleanup
 * "variant" to undo the damage — one crash away from corrupting a starter, and one of the two shots
 * red on main. With the overlay there is nothing to undo, and `variants`' cleanup role goes with
 * it.
 *
 * **The git fixture.** A project directory carrying `fixture.json` is materialised as a real git
 * repository with pinned author/committer dates and a stated dirty set
 * ({@link materialiseGitFixture}), so the `git-panel` shot stops photographing whatever the author
 * left uncommitted in this monorepo. A nested `.git` cannot itself be committed to a parent
 * repository, so the fixture ships as its plain working files plus a recipe, and the repository is
 * built at capture time.
 */

import { cp, mkdir, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface DevServer {
  dispose: () => Promise<void>;
  spawned: boolean;
  url: string;
}

/**
 * Where materialised projects live.
 *
 * Inside the repository, not `/tmp`, for two reasons that both bite: the dev server refuses to
 * activate a project root outside its own tree (`packages/server/src/server.ts`'s containment
 * rule), and `.cache/` is already in `.gitignore`, so nothing a shot writes can ever be staged.
 */
export const WORK_DIR = ".cache/screenshots";

/**
 * IPv6 is the failure this normalisation exists for.
 *
 * The dev server binds IPv4 only; `localhost` resolves to `::1` first on this host, so a manifest
 * that writes `http://localhost:3000` makes the runner's own probe time out and then report "dev
 * server did not answer" about a server that is answering perfectly.
 */
export function normalizeServerUrl(url: string): string {
  return url.replace("//localhost:", "//127.0.0.1:");
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The newest mtime under `dir`, in epoch ms, with the file that carried it. */
async function newestMtime(dir: string): Promise<{ file: string; mtimeMs: number }> {
  let newest = { file: dir, mtimeMs: 0 };
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await newestMtime(full);
      if (inner.mtimeMs > newest.mtimeMs) {
        newest = inner;
      }
      continue;
    }
    const info = await stat(full);
    if (info.mtimeMs > newest.mtimeMs) {
      newest = { file: full, mtimeMs: info.mtimeMs };
    }
  }
  return newest;
}

/**
 * Fail unless the served studio bundle is newer than every studio source file.
 *
 * This is the assertion that makes "which code is in this picture?" answerable. A stale bundle
 * produces a capture of software that no longer exists, and nothing downstream — not the visual
 * diff, not the lock, not a reviewer — can tell that from a real change.
 */
export async function assertBundleFresh(repoRoot: string): Promise<void> {
  const bundle = join(repoRoot, "packages/studio/dist/studio.js");
  const built = await stat(bundle).catch(() => null);
  if (!built) {
    throw new Error(
      `packages/studio/dist/studio.js does not exist — the dev server has not built the studio bundle.`,
    );
  }
  const newest = await newestMtime(join(repoRoot, "packages/studio/src"));
  if (newest.mtimeMs > built.mtimeMs) {
    const behind = Math.round((newest.mtimeMs - built.mtimeMs) / 1000);
    throw new Error(
      // Forward-slashed: the rest of the sentence names repo paths that way, and on Windows the
      // Slice hands back `packagesstudiosrc…`, which reads as a different repo.
      `packages/studio/dist/studio.js is ${behind}s older than ` +
        `${newest.file.slice(repoRoot.length + 1).replaceAll("\\", "/")} — ` +
        `the server is serving a stale bundle. Restart it (drop --reuse-server, or run \`bun run build\` in packages/studio).`,
    );
  }
}

export async function ensureDevServer(
  opts: { repoRoot: string; reuse?: boolean; studioPath: string; url: string },
  log: (line: string) => void = console.log,
): Promise<DevServer> {
  const url = normalizeServerUrl(opts.url);
  const probeUrl = `${url}${opts.studioPath}`;
  const answering = await probe(probeUrl);

  if (answering) {
    if (!opts.reuse) {
      throw new Error(
        `a server is already answering at ${url} and the runner cannot know which bundle it was started with. ` +
          `Stop it and let the runner spawn its own, or pass --reuse-server to photograph that one deliberately.`,
      );
    }
    log(`[server] REUSING the running dev server at ${url} (--reuse-server)`);
    await assertBundleFresh(opts.repoRoot);
    return { dispose: async () => {}, spawned: false, url };
  }

  log(`[server] starting bun server.js at ${opts.repoRoot}`);
  const proc = Bun.spawn(["bun", "server.js"], {
    cwd: opts.repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await probe(probeUrl)) {
      log(`[server] ready at ${url}`);
      // The server builds the studio bundles as it boots; assert the result rather than assume it.
      await assertBundleFresh(opts.repoRoot);
      return {
        dispose: async () => {
          proc.kill();
          await proc.exited;
        },
        spawned: true,
        url,
      };
    }
    if (proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`dev server exited early (code ${proc.exitCode}):\n${stderr}`);
    }
    await Bun.sleep(300);
  }
  proc.kill();
  throw new Error(`dev server did not answer at ${probeUrl} within 120s`);
}

// ─── The overlay: no shot ever opens a committed project ──────────────────────

/**
 * Directories never copied into an overlay.
 *
 * `node_modules` is symlinked instead (see {@link materialiseCopy}) — the `shop` starter's is 69 MB
 * and nothing a shot does writes to it. The rest are build output and git metadata: copying them
 * would make the overlay slower and, in `.git`'s case, make the copy look like a repository the
 * fixture recipe is about to build properly.
 */
const NEVER_COPIED = new Set([".cache", ".git", "dist", "node_modules"]);

/** One file as the overlay remembers it. Size plus mtime is enough to see a write. */
interface FileStamp {
  size: number;
  mtimeMs: number;
}

export interface ProjectOverlay {
  /** Absolute path of the writable copy the shot opens. */
  root: string;
  /** Absolute path of the committed original. */
  source: string;
  /** Put the copy back exactly as it was materialised. Called after every shot. */
  reset: () => Promise<void>;
}

/** Every file under `dir` with its stamp, keyed by path relative to `dir`. */
async function stampTree(dir: string, base = dir): Promise<Map<string, FileStamp>> {
  const stamps = new Map<string, FileStamp>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (NEVER_COPIED.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      for (const [rel, stamp] of await stampTree(full, base)) {
        stamps.set(rel, stamp);
      }
      continue;
    }
    const info = await stat(full);
    stamps.set(relative(base, full), { mtimeMs: info.mtimeMs, size: info.size });
  }
  return stamps;
}

/** A stable, readable directory name for a repo-relative project path. */
export function overlaySlug(project: string): string {
  return project.replaceAll(/[^\w.-]+/g, "-").replaceAll(/^-+|-+$/g, "");
}

/**
 * Copy a project tree, skipping {@link NEVER_COPIED}, SEAL IT AS ITS OWN REPOSITORY, and symlink
 * `node_modules` if it exists.
 *
 * The seal is not decoration — it is the fix for the single largest source of screenshot churn. The
 * overlay has to live inside this repository (see {@link WORK_DIR}: the dev server refuses a
 * project root outside its own tree), and a directory with no `.git` of its own makes git walk UP.
 * `packages/server/src/studio-api.ts` runs every `/__studio/git/*` command with `cwd` set to the
 * active project root, so `git status` answered for THE MONOREPO and the rail's badge rendered
 * `ctx.git.dirtyCount` of this working tree into the picture.
 *
 * That is a feedback loop, not just a leak: the runner writes each PNG as it goes, so the
 * monorepo's dirty count CLIMBS DURING THE RUN. Every shot photographed a different number, a run
 * that rewrote a different set of images moved the number again, and the badge alone accounted for
 * 11 of the 21 images the lane pushed across 24 consecutive `chore(screenshots)` commits.
 *
 * An empty repository at the overlay root stops the upward walk, so the answer is the overlay's own
 * state and nothing else. `main` is pinned because the branch name is rendered too, and
 * `init.defaultBranch` is a per-machine setting. The excludes are written BEFORE the commit so the
 * `node_modules` junction added below is never untracked — an untracked entry is a dirty entry, and
 * a dirty entry is the badge coming straight back.
 */
async function materialiseCopy(source: string, dest: string): Promise<void> {
  await rm(dest, { force: true, recursive: true });
  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest, {
    filter: (from) => {
      const rel = relative(source, from);
      return rel === "" || !rel.split(sep).some((segment) => NEVER_COPIED.has(segment));
    },
    recursive: true,
  });
  await sealOverlayRepo(dest);
  const modules = join(source, "node_modules");
  if (existsSync(modules)) {
    /* A junction, not a "dir" symlink. Windows refuses the latter with EPERM unless the process is
       elevated or Developer Mode is on, so every overlay — and therefore every screenshot run —
       failed there; a junction needs neither privilege and is what Bun makes for workspace links.
       The type argument is ignored on POSIX. */
    await symlink(modules, join(dest, "node_modules"), "junction");
  }
}

/**
 * Restore `dest` to the state `stamps` recorded, copying only what actually moved.
 *
 * Whole-tree re-copy would also work and would be two lines; this is a walk instead because most
 * shots write nothing at all, and a run that re-copies 3.7 MB sixty-one times to undo nothing is a
 * minute of I/O nobody asked for.
 */
async function restoreTree(
  source: string,
  dest: string,
  stamps: Map<string, FileStamp>,
): Promise<void> {
  const now = await stampTree(dest);
  for (const [rel, stamp] of now) {
    const original = stamps.get(rel);
    if (!original) {
      await unlink(join(dest, rel));
      continue;
    }
    if (original.size !== stamp.size || original.mtimeMs !== stamp.mtimeMs) {
      await cp(join(source, rel), join(dest, rel));
      const info = await stat(join(dest, rel));
      stamps.set(rel, { mtimeMs: info.mtimeMs, size: info.size });
    }
  }
  for (const [rel] of stamps) {
    if (now.has(rel)) {
      continue;
    }
    await mkdir(dirname(join(dest, rel)), { recursive: true });
    await cp(join(source, rel), join(dest, rel));
    const info = await stat(join(dest, rel));
    stamps.set(rel, { mtimeMs: info.mtimeMs, size: info.size });
  }
}

// ─── The git fixture ──────────────────────────────────────────────────────────

/** The recipe a fixture repository ships instead of a committed `.git`. */
export interface GitFixture {
  branch?: string;
  author?: { name: string; email: string };
  /** Applied in order; each overlays its own directory onto the tree and commits the result. */
  commits: { message: string; at: string; from: string }[];
  /** The uncommitted state the shot photographs. Stated, so it is the same on every machine. */
  dirty?: { from?: string; deleted?: string[] };
}

/** The file that turns a fixture directory into a git repository at capture time. */
export const FIXTURE_RECIPE = "fixture.json";

async function git(cwd: string, args: string[], at?: string): Promise<void> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (at) {
    env.GIT_AUTHOR_DATE = at;
    env.GIT_COMMITTER_DATE = at;
  }
  const proc = Bun.spawn(["git", ...args], { cwd, env, stderr: "pipe", stdout: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${code}): ${await new Response(proc.stderr).text()}`,
    );
  }
}

/**
 * Directories the overlay repository must never see.
 *
 * `node_modules` is a junction into the source tree, `dist` and `.cache` are build output a shot
 * can provoke. Any of them left untracked is one more dirty file, which is the badge this seal
 * exists to silence.
 */
const OVERLAY_EXCLUDES = [".cache", "dist", "node_modules", "*.log"];

/** The one date every overlay commit carries, so nothing derived from it can move between runs. */
const OVERLAY_EPOCH = "2026-01-01T00:00:00Z";

/**
 * Turn a freshly copied overlay into a self-contained repository with a CLEAN status.
 *
 * Clean rather than absent: `git status` has to answer, because the git panel and the rail badge
 * both render its answer, and "no repository at all" is a different picture from "a repository with
 * nothing to report". What matters is only that the answer comes from the overlay instead of from
 * whatever this monorepo happened to have dirty — see {@link materialiseCopy}.
 *
 * `--no-verify` because husky publishes `core.hooksPath` and a hook firing inside a screenshot run
 * would be someone else's lint failing a capture.
 */
async function sealOverlayRepo(dest: string): Promise<void> {
  await git(dest, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(dest, ".git", "info", "exclude"), `${OVERLAY_EXCLUDES.join("\n")}\n`);
  await git(dest, ["config", "user.name", "Jx Screenshots"]);
  await git(dest, ["config", "user.email", "screenshots@example.com"]);
  await git(dest, ["config", "commit.gpgsign", "false"]);
  await git(dest, ["add", "-A"]);
  await git(
    dest,
    ["commit", "--quiet", "--no-verify", "--allow-empty", "-m", "Project"],
    OVERLAY_EPOCH,
  );
}

/**
 * Build a real git repository from a fixture recipe, with every date pinned.
 *
 * Pinned because the panel renders relative timestamps: an unpinned repository makes "2 minutes
 * ago" the picture's content, and a picture whose content is the clock is a picture that is wrong
 * by the time it is committed. The pairing with `open.clock` is what makes the rendered string
 * constant.
 */
export async function materialiseGitFixture(source: string, dest: string): Promise<void> {
  const recipe = (await Bun.file(join(source, FIXTURE_RECIPE)).json()) as GitFixture;
  await rm(dest, { force: true, recursive: true });
  await mkdir(dest, { recursive: true });
  await git(dest, ["init", "--quiet", `--initial-branch=${recipe.branch ?? "main"}`]);
  const author = recipe.author ?? { email: "fixture@example.com", name: "Jx Fixture" };
  await git(dest, ["config", "user.name", author.name]);
  await git(dest, ["config", "user.email", author.email]);
  await git(dest, ["config", "commit.gpgsign", "false"]);

  for (const commit of recipe.commits) {
    await cp(join(source, commit.from), dest, { force: true, recursive: true });
    await git(dest, ["add", "-A"]);
    await git(dest, ["commit", "--quiet", "-m", commit.message], commit.at);
  }
  if (recipe.dirty?.from) {
    await cp(join(source, recipe.dirty.from), dest, { force: true, recursive: true });
  }
  for (const path of recipe.dirty?.deleted ?? []) {
    await rm(join(dest, path), { force: true });
  }
}

// ─── The one entry point ──────────────────────────────────────────────────────

/** Materialised once per project per run; every shot on that project shares the copy. */
const overlays = new Map<string, ProjectOverlay>();

/**
 * The writable project a shot opens.
 *
 * A directory carrying {@link FIXTURE_RECIPE} is built as a git repository and reset by rebuilding
 * it — a shot can stage, commit and branch inside a fixture repo, and none of that is a diff a
 * stamp walk would understand. Everything else is copied and reset file by file.
 */
export async function overlayProject(repoRoot: string, project: string): Promise<ProjectOverlay> {
  const cached = overlays.get(project);
  if (cached) {
    return cached;
  }
  const source = resolve(repoRoot, project);
  if (!existsSync(source)) {
    throw new Error(`shot project "${project}" does not exist at ${source}`);
  }
  const root = join(repoRoot, WORK_DIR, "projects", overlaySlug(project));
  const isFixtureRepo = existsSync(join(source, FIXTURE_RECIPE));

  let overlay: ProjectOverlay;
  if (isFixtureRepo) {
    await materialiseGitFixture(source, root);
    overlay = { reset: () => materialiseGitFixture(source, root), root, source };
  } else {
    await materialiseCopy(source, root);
    const stamps = await stampTree(root);
    overlay = { reset: () => restoreTree(source, root, stamps), root, source };
  }
  overlays.set(project, overlay);
  return overlay;
}

/** Drop the memo, so a second run in the same process re-materialises. Tests and `--only` reruns. */
export function forgetOverlays(): void {
  overlays.clear();
}
