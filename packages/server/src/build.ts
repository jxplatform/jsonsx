/** Build.js — Configurable Bun.build pipeline */

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
export async function buildAll(
  builds: { entrypoints: string[]; outdir: string; match?: Function | RegExp; label?: string }[],
) {
  for (const entry of builds) {
    const { match: _match, label, ...opts } = entry;
    const result = await Bun.build({
      target: "browser",
      format: "esm",
      sourcemap: "linked",
      ...opts,
    });
    if (!result.success) result.logs.forEach((l) => console.error(l));
    else console.log(`Built → ${entry.outdir}/${label ?? "bundle"}.js`);
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
export async function rebuild(
  builds: { entrypoints: string[]; outdir: string; match?: Function | RegExp; label?: string }[],
  changedFile: string,
) {
  const rebuilt = [];
  let ok = true;
  for (const entry of builds) {
    if (!entry.match) continue;
    const matches =
      typeof entry.match === "function"
        ? entry.match(changedFile)
        : entry.match instanceof RegExp
          ? entry.match.test(changedFile)
          : false;
    if (!matches) continue;
    const { match: _match, label, ...opts } = entry;
    const result = await Bun.build({
      target: "browser",
      format: "esm",
      sourcemap: "linked",
      ...opts,
    });
    if (result.success) {
      rebuilt.push(label ?? entry.outdir);
      console.log(`Rebuilt  → ${entry.outdir}/${label ?? "bundle"}.js  (${changedFile} changed)`);
    } else {
      result.logs.forEach((l) => console.error(l));
      ok = false;
    }
  }
  return { rebuilt, success: ok };
}
