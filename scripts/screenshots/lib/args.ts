/**
 * Command-line surface of the screenshot runner.
 *
 * Its own module because `run.ts` executes a capture the moment it is imported, and the flags are
 * the one part of the runner that can be tested without a browser.
 */

import { resolve } from "node:path";

export interface RunOptions {
  /** Overwrite every image regardless of the visual-diff check (a wholesale re-baseline). */
  force: boolean;
  /** Visible browser, for tuning shot definitions interactively. */
  headed: boolean;
  manifestPath: string;
  /** Shot names to run; empty means all of them. */
  only: Set<string>;
  /**
   * Photograph a dev server the runner did not start.
   *
   * Off by default, and deliberately so: an adopted server is serving whatever
   * `packages/studio/dist` it happened to be started with, which is a bundle nobody in the run can
   * name. Interactive tuning against a live editor server is the one case where that trade is worth
   * making, so it is a flag someone types rather than a condition the runner discovers.
   */
  reuseServer: boolean;
}

const FLAGS = "--only, --headed, --force, --manifest, --reuse-server";

export function parseArgs(argv: string[], defaultManifest: string): RunOptions {
  const only = new Set<string>();
  let headed = false;
  let force = false;
  let reuseServer = false;
  let manifestPath = defaultManifest;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--only") {
      i += 1;
      const value = argv[i];
      if (!value) {
        throw new Error("--only requires a shot name");
      }
      for (const name of value.split(",")) {
        only.add(name.trim());
      }
    } else if (arg === "--headed") {
      headed = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--reuse-server") {
      reuseServer = true;
    } else if (arg === "--manifest") {
      i += 1;
      const value = argv[i];
      if (!value) {
        throw new Error("--manifest requires a path");
      }
      manifestPath = resolve(process.cwd(), value);
    } else {
      throw new Error(`unknown argument "${arg}" (expected ${FLAGS})`);
    }
  }
  return { force, headed, manifestPath, only, reuseServer };
}
