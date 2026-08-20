/**
 * Electrobun postBuild hook: verify the staged bundle.
 *
 * Hook contract (unchanged across the Electrobun 2 migration): cwd = packages/desktop, env carries
 * ELECTROBUN_BUILD_DIR / ELECTROBUN_OS / ELECTROBUN_ARCH, and a non-zero exit fails the build. All
 * verification logic lives in verify-bundle.ts so it stays unit-testable; this runner only locates
 * the app dir. Runs under Hutch's runtime (Cottontail), so it stays on portable APIs.
 *
 * This used to chain embed-windows-icon.ts, which re-embedded icon.ico into launcher.exe and
 * bun.exe because Electrobun 1.18.1's own step resolved rcedit against a path baked into the
 * upstream CI machine and silently no-opped. Electrobun 2 embeds the configured `build.win.icon`
 * itself, so the workaround was deleted rather than left to run twice.
 */
import { Glob } from "bun";
import { dirname, resolve } from "node:path";
import { verifyBundle } from "./verify-bundle";

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
if (!buildDir) {
  console.error("[post-build] ELECTROBUN_BUILD_DIR not set; cannot verify bundle.");
  process.exit(1);
}

// MacOS: <App>.app/Contents/Resources/app/bun/index.js; Linux/Windows: <bundle>/app/bun/index.js.
// Glob keeps us independent of the bundle folder name (JxStudio / JxStudio-dev / JxStudio-canary).
const hits = [...new Glob("**/app/bun/index.js").scanSync({ cwd: buildDir })];
if (hits.length === 0) {
  console.error(`[post-build] no app/bun/index.js under ${buildDir}; bundle layout unexpected.`);
  process.exit(1);
}
const appDir = resolve(buildDir, dirname(dirname(hits[0]!)));

const missing = verifyBundle(appDir);
if (missing.length > 0) {
  console.error(`[post-build] bundle at ${appDir} missing ${missing.length} required path(s):`);
  for (const rel of missing) {
    console.error(`  ${rel}`);
  }
  process.exit(1);
}
console.log(`[post-build] bundle verified: ${appDir}`);
