# Changelog

## [1.1.0](https://github.com/jxsuite/jx/compare/compiler-v1.0.0...compiler-v1.1.0) (2026-07-17)


### Features

* **compiler,server,create:** jx dev and jx preview — the scaffolded scripts now work ([c0ff0d9](https://github.com/jxsuite/jx/commit/c0ff0d9d36715886b3f819b8d7ceebd682593583))
* **docs,parser:** /docs platform — nested ids, nav sidebar, traceability, generated references ([6ecdcb5](https://github.com/jxsuite/jx/commit/6ecdcb505b7e61761369a12b76c51e27652df8e1))
* image pruning for persistent site build cache + github ci cache ([b45096e](https://github.com/jxsuite/jx/commit/b45096ede609ecb5d640143af4b777fcb7f661b8))
* **runtime,compiler:** named formulas — call operator, $args scheme, blessed globals ([24d516b](https://github.com/jxsuite/jx/commit/24d516bd3310fdd2630507b38d25a0a87d080e46))
* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))


### Bug Fixes

* **studio,compiler,parser,protocol,auth:** keep the promises the docs audit surfaced ([03ac07f](https://github.com/jxsuite/jx/commit/03ac07ff3a53c125587050a277b3dfa7b0ce86b6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/create bumped to 1.1.0
    * @jxsuite/runtime bumped to 1.1.0
    * @jxsuite/schema bumped to 1.1.0
  * devDependencies
    * @jxsuite/connector bumped to 0.3.0
    * @jxsuite/parser bumped to 1.1.0

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
