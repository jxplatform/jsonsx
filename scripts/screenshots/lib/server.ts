/**
 * Dev-server lifecycle for the screenshot runner.
 *
 * The runner SPAWNS ITS OWN server. It used to adopt whatever answered on the manifest URL, which
 * made every capture a photograph of whatever `packages/studio/dist` that server happened to have
 * been started with — a bundle nobody in the run could name. `bun server.js` rebuilds the studio
 * bundles at startup, so a server the runner started is by construction serving the working tree.
 *
 * Reuse survives as `--reuse-server`, for tuning shot definitions against an editor's live server.
 * It is opt-in, it is announced, and it is gated on {@link assertBundleFresh} — because a reused
 * server is exactly the case where the bundle can be older than the source.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface DevServer {
  dispose: () => Promise<void>;
  spawned: boolean;
  url: string;
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
      `packages/studio/dist/studio.js is ${behind}s older than ${newest.file.slice(repoRoot.length + 1)} — ` +
        `the server is serving a stale bundle. Restart it (drop --reuse-server, or run \`bun run build\` in packages/studio).`,
    );
  }
}

export async function ensureDevServer(
  opts: { repoRoot: string; reuse?: boolean; studioPath: string; url: string },
  log: (line: string) => void = console.log,
): Promise<DevServer> {
  const probeUrl = `${opts.url}${opts.studioPath}`;
  const answering = await probe(probeUrl);

  if (answering) {
    if (!opts.reuse) {
      throw new Error(
        `a server is already answering at ${opts.url} and the runner cannot know which bundle it was started with. ` +
          `Stop it and let the runner spawn its own, or pass --reuse-server to photograph that one deliberately.`,
      );
    }
    log(`[server] REUSING the running dev server at ${opts.url} (--reuse-server)`);
    await assertBundleFresh(opts.repoRoot);
    return { dispose: async () => {}, spawned: false, url: opts.url };
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
      log(`[server] ready at ${opts.url}`);
      // The server builds the studio bundles as it boots; assert the result rather than assume it.
      await assertBundleFresh(opts.repoRoot);
      return {
        dispose: async () => {
          proc.kill();
          await proc.exited;
        },
        spawned: true,
        url: opts.url,
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
