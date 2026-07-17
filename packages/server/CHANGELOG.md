# Changelog

## [1.1.0](https://github.com/jxsuite/jx/compare/server-v1.0.0...server-v1.1.0) (2026-07-17)


### Features

* **compiler,server,create:** jx dev and jx preview — the scaffolded scripts now work ([c0ff0d9](https://github.com/jxsuite/jx/commit/c0ff0d9d36715886b3f819b8d7ceebd682593583))
* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.4.0
    * @jxsuite/compiler bumped to 1.1.0
    * @jxsuite/create bumped to 1.1.0
    * @jxsuite/import bumped to 0.37.0
    * @jxsuite/protocol bumped to 0.5.0
    * @jxsuite/runtime bumped to 1.1.0
    * @jxsuite/schema bumped to 1.1.0
    * @jxsuite/starters bumped to 1.1.0
  * devDependencies
    * @jxsuite/auth bumped to 0.3.0
    * @jxsuite/connector bumped to 0.3.0
    * @jxsuite/parser bumped to 1.1.0

## [1.0.0](https://github.com/jxsuite/jx/compare/server-v0.37.1...server-v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

- hosts switch to the extension model; migrate all projects to content sections

### Features

- **auth:** Better Auth extension — sessions, permissions, auth-gated data ([bf47228](https://github.com/jxsuite/jx/commit/bf472285581afbfe7b650b5d52578078359655fa))
- **connector:** dynamic data tables extension — Kysely core, /_jx/data mount, db push ([3085ab4](https://github.com/jxsuite/jx/commit/3085ab4d29c2c0c9f0b3a3007aadbd17da1994d4))
- hosts switch to the extension model; migrate all projects to content sections ([c40b45c](https://github.com/jxsuite/jx/commit/c40b45c2c1ac2052cba4467d9353de22f4c0f060))
- **studio:** data console — connections, schema push, secrets, data grid ([ea92f95](https://github.com/jxsuite/jx/commit/ea92f955cdfce5774a0ae72f01038e00c8d310ae))
- **studio:** descriptor-contributed settings + fetched project schemas ([60f1465](https://github.com/jxsuite/jx/commit/60f1465cdc18c07c7d172372f4df2d67dee1ca88))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.3.0
    - @jxsuite/compiler bumped to 1.0.0
    - @jxsuite/create bumped to 1.0.0
    - @jxsuite/import bumped to 0.36.0
    - @jxsuite/protocol bumped to 0.4.0
    - @jxsuite/runtime bumped to 1.0.0
    - @jxsuite/schema bumped to 1.0.0
    - @jxsuite/starters bumped to 1.0.0
  - devDependencies
    - @jxsuite/auth bumped to 0.2.0
    - @jxsuite/connector bumped to 0.2.0
    - @jxsuite/parser bumped to 1.0.0

## [0.37.1](https://github.com/jxsuite/jx/compare/server-v0.37.0...server-v0.37.1) (2026-07-08)

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.2.1

## [0.37.0](https://github.com/jxsuite/jx/compare/server-v0.36.0...server-v0.37.0) (2026-07-08)

### Features

- **collab:** the wire — ws client/room core, devserver endpoint, adapter members ([d9f4b42](https://github.com/jxsuite/jx/commit/d9f4b425ac1d31cd3d7f9b2892e05321de08a09d))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.2.0

## [0.36.0](https://github.com/jxsuite/jx/compare/server-v0.35.0...server-v0.36.0) (2026-07-07)

### Features

- **studio:** AI managed mode — unlock the assistant from proxy state ([9af169f](https://github.com/jxsuite/jx/commit/9af169f2eba24c067ef713184371a3abcd55819c))
- **studio:** one-click Cloudflare Pages publish surface ([4b84d21](https://github.com/jxsuite/jx/commit/4b84d21da4e5bcc991593caf533565ec6419146c))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/compiler bumped to 0.35.0
    - @jxsuite/create bumped to 0.36.0
    - @jxsuite/import bumped to 0.35.1
    - @jxsuite/parser bumped to 0.35.1
    - @jxsuite/runtime bumped to 0.34.2
    - @jxsuite/schema bumped to 0.35.0
    - @jxsuite/starters bumped to 0.35.1

## [0.35.0](https://github.com/jxsuite/jx/compare/server-v0.34.0...server-v0.35.0) (2026-07-06)

### Features

- site import package, ui + starter templates & wizard ([9c44e4a](https://github.com/jxsuite/jx/commit/9c44e4abe7e9d75c1129c179a419f5a390f86da9))
- **starters:** init starter sites ([1f883b5](https://github.com/jxsuite/jx/commit/1f883b526ea91ae935de76932283302d0720f104))

### Bug Fixes

- **studio:** proper handling of relative component references ([eb20e2f](https://github.com/jxsuite/jx/commit/eb20e2f5ad5b8c27888f3b52d2ca76a24c5afb19))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/compiler bumped to 0.34.1
    - @jxsuite/create bumped to 0.35.0
    - @jxsuite/import bumped to 0.35.0
    - @jxsuite/parser bumped to 0.35.0
    - @jxsuite/runtime bumped to 0.34.1
    - @jxsuite/starters bumped to 0.35.0
