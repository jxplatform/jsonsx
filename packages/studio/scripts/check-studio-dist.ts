/**
 * What the BUILD emitted, checked against what the package says it ships.
 *
 * `check-studio-package.ts` is source-only and runs everywhere; this one needs a real `bun run
 * build`, because the questions it asks are about emitted bytes. They are the questions that let
 * `dist/codicon.ttf` go missing for months: the build emitted a file, the shipped CSS referenced
 * it, and nothing compared the two.
 *
 * Four rules:
 *
 * 1. **Every required manifest entry exists.** The floor.
 * 2. **Every emitted file under `dist/` is accounted for** — matched by a manifest entry or by the
 *    exclude list. This is the codicon catcher: the next unhashed asset Monaco or Spectrum drops
 *    into `dist/` is a red X on the day it appears rather than a silent 404 in three
 *    distributions.
 * 3. **Every `url()` in emitted CSS resolves**, against its own file's directory. Codicon again, from
 *    the reference side: `dist/studio.css` says `./codicon.ttf` and three chunk stylesheets say
 *    `../codicon.ttf`, and both have to land on a real file.
 * 4. **Every emitted stylesheet is reachable** — named by an emitted JS or by a document. This
 *    surfaces something nobody had named: the chunk stylesheets are referenced by nothing at all.
 *    Carried on a ratcheting allow-list so the finding is recorded without blocking on deleting
 *    it.
 *
 * Run in the gated `studio-dist` CI job, after the build.
 */

import { Glob } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { STUDIO_ASSETS, STUDIO_WORKERS } from "../src/hosting/layout";

const PKG_DIR = resolve(import.meta.dir, "..");

export interface Finding {
  rule: string;
  detail: string;
}

/**
 * Emitted CSS that nothing loads.
 *
 * A shrinking backlog. Bun emits a stylesheet per chunk for CSS reached through a dynamic import,
 * but injects no link for it and no emitted JS names it — so about 687 KB of Monaco's CSS ships and
 * is never applied, while `dist/studio.css` carries the same rules and is. Recorded rather than
 * deleted here, because the fix is a build-configuration question and this is a gate.
 */
export const UNREACHABLE_CSS: readonly string[] = [
  "dist/chunks/javascript-*.css",
  "dist/chunks/jsonMode-*.css",
  "dist/chunks/monaco-setup-*.css",
  "dist/chunks/tsMode-*.css",
];

/** POSIX paths of everything emitted under `dist/`, relative to the package root. */
export function emittedFiles(distDir: string, pkgDir: string): string[] {
  if (!existsSync(distDir)) {
    return [];
  }
  return [...new Glob("**/*").scanSync(distDir)]
    .map((rel) =>
      posix.join(relative(pkgDir, distDir).replaceAll("\\", "/"), rel.replaceAll("\\", "/")),
    )
    .toSorted();
}

/** Does a manifest entry (a file, or a directory that ships wholesale) account for `path`? */
export function accountedFor(path: string): boolean {
  if (path.endsWith(".map")) {
    return true;
  }
  return STUDIO_ASSETS.some((a) => (a.dir ? path.startsWith(`${a.path}/`) : a.path === path));
}

export function unaccounted(emitted: readonly string[]): Finding[] {
  return emitted
    .filter((p) => !accountedFor(p))
    .map((p) => ({
      detail: `${p} is emitted but no manifest entry accounts for it — add it to STUDIO_ASSETS or to STUDIO_ASSET_EXCLUDE`,
      rule: "unaccounted",
    }));
}

/** Every `url(...)` in `css`, ignoring data uris and absolute urls. */
export function cssUrls(css: string): string[] {
  return [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]
    .map((m) => m[2]!.trim())
    .filter((u) => !/^(?:data:|https?:|\/\/|#)/.test(u))
    .map((u) => u.split(/[?#]/)[0]!)
    .filter(Boolean);
}

export function danglingUrls(pkgDir: string, cssFiles: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const rel of cssFiles) {
    for (const url of cssUrls(readFileSync(join(pkgDir, rel), "utf8"))) {
      const target = posix.normalize(posix.join(posix.dirname(rel), url));
      if (!existsSync(join(pkgDir, target))) {
        findings.push({
          detail: `${rel} references ${url}, which resolves to ${target} — and that file is not there`,
          rule: "dangling-url",
        });
      }
    }
  }
  return findings;
}

export function unreachableStylesheets(
  pkgDir: string,
  cssFiles: readonly string[],
  jsFiles: readonly string[],
): Finding[] {
  const allowed = UNREACHABLE_CSS.map((p) => new Glob(p));
  const bodies = jsFiles.map((f) => readFileSync(join(pkgDir, f), "utf8"));
  const documents = ["index.html", "canvas.html"]
    .filter((d) => existsSync(join(pkgDir, d)))
    .map((d) => readFileSync(join(pkgDir, d), "utf8"));
  return cssFiles
    .filter((rel) => {
      if (rel === "dist/studio.css" || allowed.some((g) => g.match(rel))) {
        return false;
      }
      const name = rel.split("/").pop()!;
      return ![...bodies, ...documents].some((body) => body.includes(name));
    })
    .map((rel) => ({
      detail: `${rel} is emitted but no emitted script and no document names it`,
      rule: "unreachable-css",
    }));
}

export function analyze(pkgDir = PKG_DIR): Finding[] {
  const distDir = join(pkgDir, "dist");
  const emitted = emittedFiles(distDir, pkgDir);
  if (emitted.length === 0) {
    return [{ detail: "dist/ is empty — run `bun run build` first", rule: "build" }];
  }
  const css = emitted.filter((p) => p.endsWith(".css"));
  const js = emitted.filter((p) => p.endsWith(".js"));

  const missing = STUDIO_ASSETS.filter((a) => a.required && !existsSync(join(pkgDir, a.path))).map(
    (a) => ({ detail: `${a.path} is required and absent — ${a.why}`, rule: "missing" }),
  );
  const workers = STUDIO_WORKERS.filter((w) => !existsSync(join(distDir, "workers", w))).map(
    (w) => ({ detail: `dist/workers/${w} is absent`, rule: "missing" }),
  );

  const staleAllowed = UNREACHABLE_CSS.filter(
    (pattern) => !css.some((rel) => new Glob(pattern).match(rel)),
  ).map((pattern) => ({
    detail: `UNREACHABLE_CSS allows ${pattern}, which nothing emits any more — delete the entry`,
    rule: "stale-allowlist",
  }));

  return [
    ...missing,
    ...workers,
    ...unaccounted(emitted),
    ...danglingUrls(pkgDir, css),
    ...unreachableStylesheets(pkgDir, css, js),
    ...staleAllowed,
  ];
}

if (import.meta.main) {
  const findings = analyze();
  if (findings.length > 0) {
    console.error("\nThe studio build and the manifest disagree:\n");
    for (const f of findings.toSorted((a, b) => a.rule.localeCompare(b.rule))) {
      console.error(`  [${f.rule}] ${f.detail}`);
    }
    process.exit(1);
  }
  const dist = emittedFiles(join(PKG_DIR, "dist"), PKG_DIR);
  const bytes = dist.reduce((n, p) => n + statSync(join(PKG_DIR, p)).size, 0);
  console.log(
    `✓ check-studio-dist: ${dist.length} emitted file(s), ${(bytes / 1e6).toFixed(1)} MB, all ` +
      `accounted for; every css url() resolves; ${UNREACHABLE_CSS.length} unreachable stylesheet ` +
      `pattern(s) on the backlog.`,
  );
  void dirname;
}
