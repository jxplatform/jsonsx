/**
 * Workaround for an upstream electrobun bug (present through 1.18.1).
 *
 * On Windows the electrobun CLI embeds the app icon into launcher.exe / bun.exe with
 * `require.resolve("rcedit/package.json")`. The published CLI is a Bun bundle in which that resolve
 * was inlined at publish time to the CI build machine's absolute path, so on any other machine it
 * throws and the step is silently skipped — the built exes keep electrobun's default icon:
 *
 * Warning: Failed to embed icon into launcher.exe: Cannot find module
 * 'D:\a\electrobun\electrobun\package\node_modules\rcedit\package.json' from '…\electrobun'
 *
 * This runs as electrobun's `postBuild` hook (after that failed step) and embeds the icon
 * ourselves. Because this script is not bundled, `rcedit` resolves at runtime from our own
 * node_modules, so the embedding succeeds. Intentionally non-fatal: a missing icon should never
 * break a dev or release build, only log a warning.
 *
 * Remove once electrobun ships a fix — see https://github.com/blackboardsh/electrobun.
 */
import { Glob } from "bun";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

// Electrobun exports these to every hook script (see runHook in its CLI).
const targetOS = process.env.ELECTROBUN_OS;
const buildDir = process.env.ELECTROBUN_BUILD_DIR;

// Only Windows PE files carry an embedded .ico. macOS (.icns) and Linux are handled elsewhere.
if (targetOS !== "win") {
  process.exit(0);
}

if (!buildDir) {
  console.warn("[embed-icon] ELECTROBUN_BUILD_DIR not set; skipping icon embed.");
  process.exit(0);
}

const iconPath = resolve(import.meta.dir, "..", "icon.ico");
if (!existsSync(iconPath)) {
  console.warn(`[embed-icon] icon not found at ${iconPath}; skipping.`);
  process.exit(0);
}

// Locate rcedit's bundled binary the way rcedit itself does, but resolved at runtime from our
// (unbundled) node_modules so the path is correct on this machine.
const require = createRequire(import.meta.url);
const rceditDir = dirname(require.resolve("rcedit/package.json"));
const rceditX64 = join(rceditDir, "bin", "rcedit-x64.exe");
const rceditExe = existsSync(rceditX64) ? rceditX64 : join(rceditDir, "bin", "rcedit.exe");

// Electrobun only icons launcher.exe + bun.exe, so match that.
// Glob keeps us independent of the bundle folder name (JxStudio / JxStudio-dev / JxStudio-canary).
const targets: string[] = [];
for (const exeName of ["launcher.exe", "bun.exe"]) {
  for (const rel of new Glob(`**/${exeName}`).scanSync({ cwd: buildDir })) {
    targets.push(join(buildDir, rel));
  }
}

if (targets.length === 0) {
  console.warn(`[embed-icon] no launcher.exe / bun.exe under ${buildDir}; skipping.`);
  process.exit(0);
}

let embedded = 0;
for (const exe of targets) {
  const proc = Bun.spawnSync([rceditExe, exe, "--set-icon", iconPath]);
  if (proc.exitCode === 0) {
    embedded += 1;
    console.log(`[embed-icon] embedded ${iconPath} → ${exe}`);
  } else {
    console.warn(
      `[embed-icon] failed to embed icon into ${exe}: ${new TextDecoder().decode(proc.stderr)}`,
    );
  }
}

console.log(`[embed-icon] done (${embedded}/${targets.length} exes).`);
