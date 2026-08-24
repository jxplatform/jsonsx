/**
 * Hutch is Electrobun 2's build CLI. This file exists only to name the project's tasks; the
 * toolchain itself is selected by the `electrobun` devDependency in package.json — its version
 * resolves the paired Hutch, Cottontail and Electrobun set, so the whole toolchain rides the
 * workspace lockfile rather than a machine-wide install. (Electrobun 2.0.0 dropped the
 * `electrobun.version` pin that earlier betas required here.)
 *
 * There is deliberately NO `install` task. This package is a member of the jx Bun workspace, so the
 * root `bun install` owns the dependency graph and lockfile; `hutch install` would resolve
 * packages/desktop as a standalone project and write a competing hutch.lock.
 *
 * The package.json scripts call `electrobun ...` (the npm bin) rather than `hutch ...` so that a
 * stale machine-wide Hutch can never shadow the paired one.
 */
const config = {
  scripts: {
    build: ["electrobun", "build", "--env=stable"],
    dev: ["electrobun", "dev"],
  },
};

export default config;
