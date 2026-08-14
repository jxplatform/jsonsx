/**
 * Where the Windows packaging scripts (build-msi.ts, build-msix.ts) find Electrobun's runtime
 * binaries — launcher.exe, the native wrapper and WebView2/Dawn DLLs, process_helper.exe, the CEF
 * tree, and the zig-zstd decompressor they use to expand the build's .tar.zst payload.
 *
 * Electrobun 1.x shipped them inside the npm package, at `node_modules/electrobun/dist-win-x64`, so
 * both scripts read straight out of the dependency tree. Electrobun 2 has no runtime on npm at all:
 * the npm package is a thin Hutch bootstrap, and the runtime lives in the pinned release's platform
 * core archive, which Hutch verifies and unpacks into a global cache. So the old path does not
 * merely move — it stops existing, and reading it would silently produce an app with no launcher.
 *
 * The cache is laid out as `<hutch home>/products/electrobun/<version>/<os>-<arch>/`, and its
 * contents are a direct replacement for the old `dist-win-x64` directory. Note the OS token is
 * `windows`, not the `win` that Electrobun's own artifact prefixes and `ELECTROBUN_OS` use — hence
 * {@link HUTCH_TARGET}, which exists so that discrepancy is stated once instead of inlined twice.
 *
 * Hutch owns this cache and may relayout it, so {@link resolveWindowsRuntime} falls back to
 * searching the pinned version's directory for `launcher.exe` before giving up, and reports every
 * place it looked when it does.
 */
import { Glob } from "bun";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Runtime binaries that belong beside the app payload in `<buildDir>/bin`. */
export const WINDOWS_RUNTIME_FILES = [
  "launcher.exe",
  "libNativeWrapper.dll",
  "WebView2Loader.dll",
  "d3dcompiler_47.dll",
  "webgpu_dawn.dll",
  "process_helper.exe",
];

/** Hutch's platform token for this package's only Windows target. Not spelled `win-x64`. */
export const HUTCH_TARGET = "windows-x64";

/**
 * Hutch's home directory, honoring the same overrides its own npm bootstrap does (see
 * `npm/electrobun/bin/electrobun.cjs`): `HUTCH_HOME` first, then `DASH_HOME` — kept there as a
 * deprecated fallback for Dash Desktop and older setups — then `~/.hutch`.
 */
export function hutchHome(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env.HUTCH_HOME || env.DASH_HOME || join(home, ".hutch");
}

/** The cache directory Hutch unpacks one pinned Electrobun release's platform archive into. */
export function productDir(version: string, home: string = hutchHome()): string {
  return join(home, "products", "electrobun", version, HUTCH_TARGET);
}

/**
 * Locate the directory to source Windows runtime binaries from.
 *
 * @param version The exact Electrobun version pinned in hutch.config.ts.
 * @returns The runtime directory, or null with the list of places consulted — which callers must
 *   treat as fatal rather than packaging an app that cannot start.
 */
export function resolveWindowsRuntime(
  version: string,
  home: string = hutchHome(),
): { dir: string | null; searched: string[] } {
  const exact = productDir(version, home);
  if (existsSync(join(exact, "launcher.exe"))) {
    return { dir: exact, searched: [exact] };
  }

  // The pinned version is cached but not under the target name this file expects — Hutch relayed
  // Out the cache. Find the launcher rather than failing on a directory name.
  const versionRoot = dirname(exact);
  const searched = [exact, versionRoot];
  if (!existsSync(versionRoot)) {
    return { dir: null, searched };
  }
  const [hit] = [...new Glob("**/launcher.exe").scanSync({ cwd: versionRoot })];
  return { dir: hit ? dirname(resolve(versionRoot, hit)) : null, searched };
}

/** A human-readable account of where a failed {@link resolveWindowsRuntime} looked, for build logs. */
export function describeRuntimeSearch(searched: string[]): string {
  return [
    "Cannot find Electrobun's Windows runtime binaries. Looked in:",
    ...searched.map((path) => `  ${path}`),
    "Electrobun 2 ships no runtime on npm — Hutch caches it. Run `bun run --cwd packages/desktop",
    "sync` (or set HUTCH_HOME if the cache lives elsewhere) and rebuild.",
  ].join("\n");
}
