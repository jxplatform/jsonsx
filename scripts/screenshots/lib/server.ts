/**
 * Dev-server lifecycle for the screenshot runner. Reuses an already-running `bun run dev` server
 * when one answers on the manifest URL; otherwise spawns `bun server.js` at the repo root and tears
 * it down on dispose. Never kills a server it didn't start.
 */

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

export async function ensureDevServer(
  opts: { repoRoot: string; studioPath: string; url: string },
  log: (line: string) => void = console.log,
): Promise<DevServer> {
  const probeUrl = `${opts.url}${opts.studioPath}`;
  if (await probe(probeUrl)) {
    log(`[server] reusing running dev server at ${opts.url}`);
    return { dispose: async () => {}, spawned: false, url: opts.url };
  }

  log(`[server] starting bun server.js at ${opts.repoRoot}`);
  const proc = Bun.spawn(["bun", "server.js"], {
    cwd: opts.repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await probe(probeUrl)) {
      log(`[server] ready at ${opts.url}`);
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
  throw new Error(`dev server did not answer at ${probeUrl} within 60s`);
}
