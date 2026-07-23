/**
 * Asset-mounts — host side of the extension `assets` capability (specs/extensions.md §8.5).
 *
 * A section-owner class publishes directories that may sit outside the project root (an external
 * content source's co-located images) at a stable site URL. The build resolves those URLs while
 * optimizing images, collects the ones its compiled output actually references, and copies just
 * those files into dist — the source directory itself is never mirrored, so entry files never leak
 * into the build output.
 *
 * @module asset-mounts
 * @docs framework/site/images
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  collectAssetUrls,
  normalizeAssetPrefix,
  resolveAssetUrl,
} from "@jxsuite/schema/asset-paths";
import type { AssetMount } from "@jxsuite/schema/asset-paths";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type { ProjectConfig } from "@jxsuite/schema/types";

/**
 * Gather every asset mount contributed by the project's extensions.
 *
 * Gating matches `emit` (extensions.md §8.4): a class owning a project section contributes only
 * when the project declares a non-empty value for that section. Mounts claiming the same URL prefix
 * for different directories are a configuration error — the first wins and the clash is reported.
 *
 * @param {ExtensionRegistry} registry - The project's extension registry
 * @param {ProjectConfig} projectConfig
 * @param {string} projectRoot - Absolute project root
 * @returns {Promise<{ mounts: AssetMount[]; errors: string[] }>}
 */
export async function loadAssetMounts(
  registry: ExtensionRegistry,
  projectConfig: ProjectConfig,
  projectRoot: string,
): Promise<{ mounts: AssetMount[]; errors: string[] }> {
  const mounts: AssetMount[] = [];
  const errors: string[] = [];
  const byPrefix = new Map<string, AssetMount>();

  for (const entry of registry.assetProviders()) {
    const sectionKey = entry.project?.key;
    const sectionValue = sectionKey
      ? (projectConfig as unknown as Record<string, unknown>)[sectionKey]
      : undefined;
    if (
      sectionKey &&
      (sectionValue == null ||
        (typeof sectionValue === "object" && Object.keys(sectionValue).length === 0))
    ) {
      continue;
    }
    try {
      const declared = (await entry.call("assets", sectionValue ?? null, {
        projectConfig,
        root: projectRoot,
      })) as AssetMount[] | null;
      for (const mount of declared ?? []) {
        if (!mount?.urlPrefix || !mount.dir) {
          continue;
        }
        const normalized: AssetMount = {
          dir: mount.dir,
          urlPrefix: normalizeAssetPrefix(mount.urlPrefix),
        };
        const prior = byPrefix.get(normalized.urlPrefix);
        if (prior) {
          if (prior.dir !== normalized.dir) {
            errors.push(
              `Asset mount conflict: "${normalized.urlPrefix}" is claimed by both ` +
                `"${prior.dir}" and "${normalized.dir}"`,
            );
          }
          continue;
        }
        byPrefix.set(normalized.urlPrefix, normalized);
        mounts.push(normalized);
      }
    } catch (error) {
      errors.push(`Error in ${entry.name}.assets: ${(error as Error).message}`);
    }
  }

  return { errors, mounts };
}

/**
 * Add every mounted URL referenced by a compiled artifact to `into`.
 *
 * @param {string} text - Compiled HTML or CSS
 * @param {readonly AssetMount[]} mounts
 * @param {Set<string>} into - Accumulator across the whole build
 */
export function collectAssetRefs(text: string, mounts: readonly AssetMount[], into: Set<string>) {
  if (mounts.length === 0 || !text) {
    return;
  }
  for (const url of collectAssetUrls(text, mounts)) {
    into.add(url);
  }
}

/**
 * Copy referenced mounted assets into the build output, each at its own URL path.
 *
 * @param {Iterable<string>} urls - Mounted URLs collected from the compiled output
 * @param {readonly AssetMount[]} mounts
 * @param {string} outDir - Absolute build output directory
 * @returns {{ copied: number; missing: string[] }} Files written, and URLs that resolved to nothing
 */
export function copyMountedAssets(
  urls: Iterable<string>,
  mounts: readonly AssetMount[],
  outDir: string,
): { copied: number; missing: string[] } {
  let copied = 0;
  const missing: string[] = [];

  for (const url of urls) {
    // The single containment gate is resolveAssetUrl: it decodes once and refuses `.`/`..`,
    // Empty segments, and undecodable input, so a surviving URL cannot escape either the mount
    // Directory it reads from or the outDir path it writes to.
    const source = resolveAssetUrl(mounts, url);
    if (!source || !existsSync(source)) {
      missing.push(url);
      continue;
    }
    const target = resolve(outDir, decodeURIComponent(url).replace(/^\//, ""));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
    copied += 1;
  }

  return { copied, missing };
}
