/** Build.js — Configurable Bun.build pipeline */

import type { BuildConfig } from "bun";

/**
 * One watched build entry.
 *
 * `match` and `label` belong to the watcher; every other key is forwarded verbatim to `Bun.build`,
 * so a consumer can supply `plugins`, `splitting`, `naming`, `define` and the rest. That forwarding
 * was always the behaviour (the implementation spreads `...opts`) but was not in the type, so a
 * caller had no way to know it could keep a watched rebuild byte-identical to its release build —
 * and the repo's own dev server silently did not.
 */
export interface BuildEntry extends Partial<BuildConfig> {
  entrypoints: string[];
  outdir: string;
  match?: ((path: string) => boolean) | RegExp;
  label?: string;
}

/**
 * Build all entries with sensible defaults (browser target, ESM, linked sourcemaps).
 *
 * @param {{
 *   entrypoints: string[];
 *   outdir: string;
 *   match?: Function | RegExp;
 *   label?: string;
 * }[]} builds
 */
export async function buildAll(builds: BuildEntry[]) {
  for (const entry of builds) {
    const { match: _match, label, ...opts } = entry;
    const result = await Bun.build({
      format: "esm",
      sourcemap: "linked",
      target: "browser",
      ...opts,
    });
    if (!result.success) {
      for (const l of result.logs) {
        console.error(l);
      }
    } else {
      console.log(`Built → ${entry.outdir}/${label ?? "bundle"}.js`);
    }
  }
}

/**
 * Rebuild entries whose match function/regex matches the changed filename.
 *
 * @param {{
 *   entrypoints: string[];
 *   outdir: string;
 *   match?: Function | RegExp;
 *   label?: string;
 * }[]} builds
 * @param {string} changedFile
 * @returns {Promise<{ rebuilt: string[]; success: boolean }>}
 */
export async function rebuild(builds: BuildEntry[], changedFile: string) {
  const rebuilt = [];
  let ok = true;
  for (const entry of builds) {
    if (!entry.match) {
      continue;
    }
    const matches =
      typeof entry.match === "function"
        ? entry.match(changedFile)
        : entry.match instanceof RegExp
          ? entry.match.test(changedFile)
          : false;
    if (!matches) {
      continue;
    }
    const { match: _match, label, ...opts } = entry;
    const result = await Bun.build({
      format: "esm",
      sourcemap: "linked",
      target: "browser",
      ...opts,
    });
    if (result.success) {
      rebuilt.push(label ?? entry.outdir);
      console.log(`Rebuilt  → ${entry.outdir}/${label ?? "bundle"}.js  (${changedFile} changed)`);
    } else {
      for (const l of result.logs) {
        console.error(l);
      }
      ok = false;
    }
  }
  return { rebuilt, success: ok };
}
