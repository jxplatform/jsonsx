# Changelog

## [1.0.0](https://github.com/jxsuite/jx/compare/studio-v0.37.1...studio-v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

- hosts switch to the extension model; migrate all projects to content sections

### Features

- **auth:** Better Auth extension — sessions, permissions, auth-gated data ([bf47228](https://github.com/jxsuite/jx/commit/bf472285581afbfe7b650b5d52578078359655fa))
- **connector:** dynamic data tables extension — Kysely core, /_jx/data mount, db push ([3085ab4](https://github.com/jxsuite/jx/commit/3085ab4d29c2c0c9f0b3a3007aadbd17da1994d4))
- hosts switch to the extension model; migrate all projects to content sections ([c40b45c](https://github.com/jxsuite/jx/commit/c40b45c2c1ac2052cba4467d9353de22f4c0f060))
- **markup:** shared markup-conversion core package; sever studio/import from parser ([a075e74](https://github.com/jxsuite/jx/commit/a075e74a6c45e91b1d1c7c1a6007e2e344fbb341))
- **studio:** add/open existing repositories from the welcome screen ([4edc293](https://github.com/jxsuite/jx/commit/4edc293d439cf613060b4113b10973251785c3e7))
- **studio:** data console — connections, schema push, secrets, data grid ([ea92f95](https://github.com/jxsuite/jx/commit/ea92f955cdfce5774a0ae72f01038e00c8d310ae))
- **studio:** descriptor-contributed settings + fetched project schemas ([60f1465](https://github.com/jxsuite/jx/commit/60f1465cdc18c07c7d172372f4df2d67dee1ca88))
- **studio:** instant CF connect handshake + Connect-Cloudflare option in the AI gate ([f7de0a3](https://github.com/jxsuite/jx/commit/f7de0a3fecb2a375ff9984446243ac157fe10db9))
- **studio:** prompt for GitHub App installation from the project UI ([850f8cb](https://github.com/jxsuite/jx/commit/850f8cba4c40d2b3ecab425633a2ec49f966190e))
- **studio:** reusable schema-form engine, context resolver, settings registry ([4cb1d63](https://github.com/jxsuite/jx/commit/4cb1d63d70fc16535646897466e1a2fb1719157c))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.3.0
    - @jxsuite/create bumped to 1.0.0
    - @jxsuite/markup bumped to 0.2.0
    - @jxsuite/protocol bumped to 0.4.0
    - @jxsuite/runtime bumped to 1.0.0
    - @jxsuite/schema bumped to 1.0.0

## [0.37.1](https://github.com/jxsuite/jx/compare/studio-v0.37.0...studio-v0.37.1) (2026-07-08)

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.2.1
    - @jxsuite/protocol bumped to 0.3.1

## [0.37.0](https://github.com/jxsuite/jx/compare/studio-v0.36.0...studio-v0.37.0) (2026-07-08)

### Features

- **collab:** @jxsuite/collab — Y.Doc schema, op bridge, differ, wire envelope ([0166c38](https://github.com/jxsuite/jx/commit/0166c38f05b87bb96595a30ee1cbc31781e8cc82))
- **collab:** the wire — ws client/room core, devserver endpoint, adapter members ([d9f4b42](https://github.com/jxsuite/jx/commit/d9f4b425ac1d31cd3d7f9b2892e05321de08a09d))
- **studio:** adopt y-monaco for source co-editing ([63c2557](https://github.com/jxsuite/jx/commit/63c2557a1adab984b09bbc3e8f164b88b8dd0c68))
- **studio:** collab seams in the transact pipeline ([f9b6db6](https://github.com/jxsuite/jx/commit/f9b6db6e2ca01bbeaea2b461a27591f2fdd3965c))
- **studio:** CollabSession — realtime co-editing behind platform.collab ([6e56521](https://github.com/jxsuite/jx/commit/6e56521e06e871057762d19936d9832bdfbe9c67))
- **studio:** presence UX — chips, remote selection overlays, sync status ([d458d72](https://github.com/jxsuite/jx/commit/d458d7249c5de0424fe73c4e5090448de6526cd7))
- **studio:** source-mode co-editing under the canonical lock ([478d148](https://github.com/jxsuite/jx/commit/478d148105a8e7545197b83626876d85e5218019))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.2.0
    - @jxsuite/protocol bumped to 0.3.0

## [0.36.0](https://github.com/jxsuite/jx/compare/studio-v0.35.0...studio-v0.36.0) (2026-07-07)

### Features

- **protocol:** @jxsuite/protocol — the Studio Backend Protocol package ([e859f36](https://github.com/jxsuite/jx/commit/e859f36eecead91de37ff6ec9ea51e7d3ca0691c))
- **studio:** AI managed mode — unlock the assistant from proxy state ([9af169f](https://github.com/jxsuite/jx/commit/9af169f2eba24c067ef713184371a3abcd55819c))
- **studio:** cloud platform adapter — @jxsuite/studio/platforms/cloud ([4bfd5a0](https://github.com/jxsuite/jx/commit/4bfd5a0cedc301f7025a33e3a04bb2597b1d0f46))
- **studio:** one-click Cloudflare Pages publish surface ([4b84d21](https://github.com/jxsuite/jx/commit/4b84d21da4e5bcc991593caf533565ec6419146c))
- **studio:** platform project catalogue on the welcome screen ([18c6a43](https://github.com/jxsuite/jx/commit/18c6a43ab1c2a1fba282d023a93fe47810afc088))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/create bumped to 0.36.0
    - @jxsuite/parser bumped to 0.35.1
    - @jxsuite/protocol bumped to 0.2.0
    - @jxsuite/runtime bumped to 0.34.2
    - @jxsuite/schema bumped to 0.35.0

## [0.35.0](https://github.com/jxsuite/jx/compare/studio-v0.34.0...studio-v0.35.0) (2026-07-06)

### Features

- automated screenshot framework ([0f8c972](https://github.com/jxsuite/jx/commit/0f8c9721e97bdeeb5c883d86a0f175393718b71e))
- **desktop:** persistent cross-platform user settings ([352cf36](https://github.com/jxsuite/jx/commit/352cf3636d7d1a132d847db1b15703c6be9fa30a))
- site import package, ui + starter templates & wizard ([9c44e4a](https://github.com/jxsuite/jx/commit/9c44e4abe7e9d75c1129c179a419f5a390f86da9))
- **starters:** init starter sites ([1f883b5](https://github.com/jxsuite/jx/commit/1f883b526ea91ae935de76932283302d0720f104))
- **studio:** agentic ai history switcher, modern UI/UX ([2f1bd61](https://github.com/jxsuite/jx/commit/2f1bd61297d8b5ff9f60735b674e5f31eb50d039))
- **studio:** auto-sync and package conflict resolution ([5fb5fe4](https://github.com/jxsuite/jx/commit/5fb5fe42466a6f2bd9b6cabad2047daf18febf80))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/parser bumped to 0.35.0
    - @jxsuite/runtime bumped to 0.34.1
