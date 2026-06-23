/**
 * Version.ts — build-time metadata for the About screen.
 *
 * The constants below are replaced at bundle time by scripts/build.ts via Bun's `define`. They're
 * read through `typeof` guards so the module stays safe under `bun test`, where the defines are
 * absent and the fallbacks apply.
 */

declare const __JX_VERSION__: string;
declare const __JX_BUILD_DATE__: string;
declare const __JX_GIT_COMMIT__: string;

export const APP_NAME = "Jx Studio";

/*
 * The `typeof` guards are deliberate: the identifiers are `declare const` placeholders that
 * only exist after Bun's build-time `define` substitution. Under `bun test` they're never
 * bound, so a direct `=== undefined` comparison would throw a ReferenceError.
 */

// oxlint-disable-next-line unicorn/no-typeof-undefined -- guards undeclared build-time define
export const VERSION = typeof __JX_VERSION__ === "undefined" ? "dev" : __JX_VERSION__;

// oxlint-disable-next-line unicorn/no-typeof-undefined -- guards undeclared build-time define
export const BUILD_DATE = typeof __JX_BUILD_DATE__ === "undefined" ? "" : __JX_BUILD_DATE__;

// oxlint-disable-next-line unicorn/no-typeof-undefined -- guards undeclared build-time define
export const GIT_COMMIT = typeof __JX_GIT_COMMIT__ === "undefined" ? "unknown" : __JX_GIT_COMMIT__;

export const LINKS = {
  github: "https://github.com/jxsuite/jx",
  docs: "https://github.com/jxsuite/jx#readme",
  license: "https://github.com/jxsuite/jx/blob/main/LICENSE",
} as const;
