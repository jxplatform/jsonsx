/**
 * Build info this launcher can truthfully report to the About screen.
 *
 * The electrobun build composes the same answer from its own updater — it ships an update feed and
 * can say "Update ready (1.4.2)". This build has no feed: it is installed and replaced by the
 * system that packaged it (`nix build`, a distro package), so it reports **no** `updateStatus` at
 * all rather than an "Up to date" it has no way to have checked. An absent field is how the About
 * screen knows not to draw the row.
 */

import type { AppInfo } from "@jxsuite/protocol";
import pkg from "../../package.json" with { type: "json" };

/**
 * Which build this is, from the one thing that distinguishes them at runtime.
 *
 * The Nix wrapper pre-sets `JX_STUDIO_ASSETS` to a store path (specs/desktop.md §9.3); a developer
 * running `bun run desktop:chromium` from the repo does not. Nothing else in the process knows
 * whether it was packaged, and guessing from the path would break the first time someone packages
 * it a second way.
 */
export function releaseChannel(): string {
  return process.env.JX_STUDIO_ASSETS ? "system" : "development";
}

/** Version, channel and commit for the About screen. */
export function appInfo(): AppInfo {
  return {
    channel: releaseChannel(),
    /* The commit is stamped into the studio bundle at build time, not into this process, so the
       About screen already has a better answer than anything reachable from here — a `git` call in
       a Nix store path would name the store, not the release. */
    hash: process.env.JX_STUDIO_COMMIT || "unknown",
    version: (pkg as { version: string }).version,
  };
}
