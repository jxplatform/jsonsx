# Changelog

## [1.0.0](https://github.com/jxsuite/jx/compare/compiler-v0.35.0...compiler-v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

- hosts switch to the extension model; migrate all projects to content sections

### Features

- **auth:** Better Auth extension — sessions, permissions, auth-gated data ([bf47228](https://github.com/jxsuite/jx/commit/bf472285581afbfe7b650b5d52578078359655fa))
- **connector:** dynamic data tables extension — Kysely core, /_jx/data mount, db push ([3085ab4](https://github.com/jxsuite/jx/commit/3085ab4d29c2c0c9f0b3a3007aadbd17da1994d4))
- hosts switch to the extension model; migrate all projects to content sections ([c40b45c](https://github.com/jxsuite/jx/commit/c40b45c2c1ac2052cba4467d9353de22f4c0f060))
- **markup:** shared markup-conversion core package; sever studio/import from parser ([a075e74](https://github.com/jxsuite/jx/commit/a075e74a6c45e91b1d1c7c1a6007e2e344fbb341))
- **studio:** descriptor-contributed settings + fetched project schemas ([60f1465](https://github.com/jxsuite/jx/commit/60f1465cdc18c07c7d172372f4df2d67dee1ca88))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/create bumped to 1.0.0
    - @jxsuite/runtime bumped to 1.0.0
    - @jxsuite/schema bumped to 1.0.0
  - devDependencies
    - @jxsuite/connector bumped to 0.2.0
    - @jxsuite/parser bumped to 1.0.0

## [0.35.0](https://github.com/jxsuite/jx/compare/compiler-v0.34.1...compiler-v0.35.0) (2026-07-07)

### Features

- **schema:** build.deploy tracking block; fix stale adapter enum ([2c14856](https://github.com/jxsuite/jx/commit/2c148561f4f9329cb3e23d5d5fa3dc330fe121c5))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/parser bumped to 0.35.1
    - @jxsuite/runtime bumped to 0.34.2
    - @jxsuite/schema bumped to 0.35.0

## [0.34.1](https://github.com/jxsuite/jx/compare/compiler-v0.34.0...compiler-v0.34.1) (2026-07-06)

### Bug Fixes

- **compiler:** proper handling of default content ([9970382](https://github.com/jxsuite/jx/commit/997038254e8247b963d22631117fb3639cdc1f6d))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/parser bumped to 0.35.0
    - @jxsuite/runtime bumped to 0.34.1
