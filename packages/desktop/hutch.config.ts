/**
 * Hutch owns the workspace side of an Electrobun 2 project: which Electrobun release this app is
 * built against, and the task names that reach its CLI. Application and distribution settings stay
 * in electrobun.config.ts — see the responsibility table in Electrobun's "Project Ownership and the
 * Devkit" guide.
 *
 * The pin must be an exact version. Hutch verifies that release's platform core archive, caches it
 * under ~/.hutch, and copies its SDKs into this package's generated `.hutch/devkit` sysroot (which
 * tsconfig.json extends, and which is where `electrobun/*` imports resolve from — there is no
 * `electrobun` npm dependency any more).
 *
 * There is deliberately NO `install` task. This package is a member of the jx Bun workspace, so the
 * root `bun install` owns the dependency graph and lockfile; `hutch pm` is never invoked and must
 * not be, or it would resolve packages/desktop as if it were a standalone project. `packageManager`
 * only names the tool a task would use, and is independent of `build.mainProcess`.
 */
const config = {
  electrobun: {
    version: "2.0.1-beta.12",
  },
  packageManager: "bun",
  scripts: {
    build: ["hutch", "electrobun", "build", "--env=production"],
    dev: ["hutch", "electrobun", "dev"],
  },
};

export default config;
