/**
 * Mounts.ts — the asset mounts the refactor engine resolves rooted references through.
 *
 * A rooted reference (`/images/hero.jpg`) is a site URL, and an extension may claim a slice of that
 * URL space and serve it out of a directory of its own (specs/extensions.md §8.5). So "which file
 * does this URL name?" cannot be answered from the project root alone, and neither the read pass
 * nor the write pass can be correct without the mount list.
 *
 * **The engine loads them rather than taking them.** The format registry is passed in by every
 * caller because every caller already has one; nobody has a mount list, and there are four hosts
 * (two dev-server routes, the desktop project session, the cloud gateway). An option four hosts
 * each have to remember is an option three of them eventually do not — and a lane that silently
 * fails to resolve is precisely the defect this module exists to close (issue 239). `mounts` stays
 * available on both option types for a host that already has the list, and for tests.
 *
 * **Project-relative, filtered.** `loadAssetMounts` hands back whatever directory an extension
 * declared, which is normally absolute; `asset-paths.ts` documents its mount parameter as
 * project-relative. Rebasing here is that conversion, and a mount resolving OUTSIDE the project is
 * dropped: its files are not addressable by a project-relative path, so no rename can reach them
 * and no reference to them can be counted. `projectPathsForSiteUrl` declines the same case by
 * name.
 */

import { relative } from "node:path";
import { projectAssetMounts } from "../resolve.ts";
import { fwd } from "./scan.ts";
import type { AssetMount } from "@jxsuite/schema/asset-paths";

/**
 * Project-relative asset mounts for a project root, or an empty list when there is no project here.
 *
 * Not memoised on its own account: `projectAssetMounts` is already cached against `project.json`'s
 * mtime, and a second cache here would be a second thing to invalidate.
 *
 * @param {string} root - Absolute project root
 * @returns {Promise<AssetMount[]>} Mounts whose `dir` is relative to `root`
 */
export async function refactorMounts(root: string): Promise<AssetMount[]> {
  const declared = await projectAssetMounts(root);
  const out: AssetMount[] = [];
  for (const mount of declared) {
    const dir = fwd(relative(root, mount.dir));
    if (dir === "" || dir.startsWith("../") || /^[A-Za-z]:/.test(dir)) {
      continue;
    }
    out.push({ dir, urlPrefix: mount.urlPrefix });
  }
  return out;
}
