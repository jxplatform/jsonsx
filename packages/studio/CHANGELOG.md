# Changelog

## [1.1.0](https://github.com/jxsuite/jx/compare/studio-v1.0.0...studio-v1.1.0) (2026-07-17)


### Features

* **formulas:** packaging, docs, and studio copy-in consumption ([f5df14f](https://github.com/jxsuite/jx/commit/f5df14f125b2fca2224cce68aa4674b3c7d9071a))
* **runtime,schema,formulas:** pure method operators and the composite formula catalog (spec §19.4d) ([58be3b1](https://github.com/jxsuite/jx/commit/58be3b1aac98ae50b7b1be543fa765c5c83adc46))
* **runtime,schema,studio:** blessed Intl helpers and object-literal expression operands ([e77a1f2](https://github.com/jxsuite/jx/commit/e77a1f233d28221a9e7b7209c234914d7988ef4d))
* **schema,runtime,studio:** structured function bodies and the statement editor (spec §20) ([1bc949a](https://github.com/jxsuite/jx/commit/1bc949ad6961513152066aee33d7a95f5a975fb2))
* **studio:** collection grids with rich cells — bulk frontmatter editing ([28dc589](https://github.com/jxsuite/jx/commit/28dc58950e1d2d7f44ed0d876f51a47dc22c189f))
* **studio:** consolidated field mode switcher ([0a135ed](https://github.com/jxsuite/jx/commit/0a135ed1a689d2c7fa6588833dc5c9da504a6a65))
* **studio:** dedicated zoom level on editor mode ([72ec8b7](https://github.com/jxsuite/jx/commit/72ec8b768f536e8c502d6fb6ec388f931f7af272))
* **studio:** dynamic-slot control and live expression value badges ([d7bd673](https://github.com/jxsuite/jx/commit/d7bd673b3fa1c07cf43b52902f3fa29616b234c8))
* **studio:** formula catalog, search palette, chip pipeline, fx everywhere ([c588391](https://github.com/jxsuite/jx/commit/c5883918d04565d25098d9a3c812b6f14ee7a16b))
* **studio:** full-screen formula workspace ([d6195eb](https://github.com/jxsuite/jx/commit/d6195eb160b5d07d86229fe532d444ab963a96d3))
* **studio:** grid polish — find & replace, column layout persistence ([fe5f223](https://github.com/jxsuite/jx/commit/fe5f2232c5ea007ceb1e3e59a1b4328f8dc9525f))
* **studio:** inline editing of component property bound text ([898dbcb](https://github.com/jxsuite/jx/commit/898dbcbff5a9db6e1f4369515bec1f52baa2fa70))
* **studio:** live-context expression previews and component test props ([8e502c2](https://github.com/jxsuite/jx/commit/8e502c236be9538eb1a2ca1f8f2caec2ae50bc6b))
* **studio:** pages + connector grid tabs; the modal data grid retires ([a341ab3](https://github.com/jxsuite/jx/commit/a341ab301ac6e03a9073517c7f49bce4e0eb9cd1))
* **studio:** persistent ai sidebar + project bootstrap capabilities ([3d6f9eb](https://github.com/jxsuite/jx/commit/3d6f9ebf40c88a34939b9ed525618931b700a25c))
* **studio:** properties panel for content type frontmatter/metadata ([2ef24f4](https://github.com/jxsuite/jx/commit/2ef24f4075653b2cee4ee361db0ad3fb6f733090))
* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))
* **studio:** wheel-scrollable tab strip + active-tab reveal ([09c5c3b](https://github.com/jxsuite/jx/commit/09c5c3bb500e8b1548b09e0996b73a130d8f2069))


### Bug Fixes

* **studio,compiler,parser,protocol,auth:** keep the promises the docs audit surfaced ([03ac07f](https://github.com/jxsuite/jx/commit/03ac07ff3a53c125587050a277b3dfa7b0ce86b6))
* **studio:** component registry regression ([ac3ff48](https://github.com/jxsuite/jx/commit/ac3ff48719ca476b0f33510664fb375e4a7fd11e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.4.0
    * @jxsuite/create bumped to 1.1.0
    * @jxsuite/formulas bumped to 0.0.2
    * @jxsuite/markup bumped to 0.3.0
    * @jxsuite/protocol bumped to 0.5.0
    * @jxsuite/runtime bumped to 1.1.0
    * @jxsuite/schema bumped to 1.1.0

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
