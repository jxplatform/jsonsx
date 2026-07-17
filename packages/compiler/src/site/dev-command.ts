/**
 * Dev command — `jx dev` resolves the project's @jxsuite/server dev entry and spawns it under Bun.
 *
 * The compiler cannot depend on @jxsuite/server (the server already depends on the compiler), and
 * the dev server is Bun-native while the jx bin runs under Node — so the command is pure resolution
 * + spawn: the entry module is resolved from the PROJECT's node_modules and executed with Bun.
 *
 * @module dev-command
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/**
 * Resolve the project's `@jxsuite/server/dev` entry module.
 *
 * @param {string} projectRoot - Absolute project root
 * @returns {string} Absolute path to the dev entry module
 * @throws {Error} With an install hint when the package is not present
 */
export function resolveDevEntry(projectRoot: string): string {
  try {
    const projectRequire = createRequire(join(projectRoot, "package.json"));
    return projectRequire.resolve("@jxsuite/server/dev");
  } catch {
    throw new Error(
      `@jxsuite/server is not installed in ${projectRoot}. ` +
        `Add it to devDependencies (e.g. \`bun add -d @jxsuite/server\`) and retry.`,
    );
  }
}

/** The slice of `process` runDev touches — injectable for tests. */
export interface ProcessLike {
  on: (event: string, handler: () => void) => unknown;
  exitCode?: number | string | undefined;
}

/**
 * Spawn the dev server under Bun with inherited stdio.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {number | undefined} port - Optional port override
 * @param {typeof spawn} [spawnImpl] - Injectable for tests
 * @param {ProcessLike} [proc] - Injectable for tests
 * @returns {ChildProcess} The spawned Bun process
 */
export function runDev(
  projectRoot: string,
  port: number | undefined,
  spawnImpl: typeof spawn = spawn,
  proc: ProcessLike = process as unknown as ProcessLike,
): ChildProcess {
  const entry = resolveDevEntry(projectRoot);
  const args = [entry, "--root", projectRoot];
  if (port !== undefined) {
    args.push("--port", String(port));
  }
  const child = spawnImpl("bun", args, { stdio: "inherit" });
  child.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      console.error(
        "The Jx dev server runs on Bun, which was not found on your PATH. " +
          "Install it from https://bun.sh and retry.",
      );
    } else {
      console.error(`Failed to start the dev server: ${error.message}`);
    }
    proc.exitCode = 1;
  });
  // Ctrl+C reaches the child through the shared process group; also mirror explicit kills.
  proc.on("SIGINT", () => {
    child.kill("SIGINT");
  });
  proc.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });
  child.on("exit", (code) => {
    proc.exitCode = code ?? 0;
  });
  return child;
}
