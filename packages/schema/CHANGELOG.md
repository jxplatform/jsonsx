# Changelog

## [1.5.0](https://github.com/jxsuite/jx/compare/schema-v1.4.0...schema-v1.5.0) (2026-07-30)


### Features

* **schema:** make per-project schema composition host-agnostic ([4dddfa8](https://github.com/jxsuite/jx/commit/4dddfa8742bb43ddd8264d60b370d49aaa87bab1))
* **schema:** make per-project schema composition host-agnostic ([df337d8](https://github.com/jxsuite/jx/commit/df337d8b3f0c0da35cad16e76d52635f9f06d7c1))


### Bug Fixes

* **compiler:** close five adjacent element-target defects found while fixing [#106](https://github.com/jxsuite/jx/issues/106)-113 ([def35f6](https://github.com/jxsuite/jx/commit/def35f6e41f57524d637ba6331714e0fee6f9043))
* **schema:** make committed entry documents resolve in editors ([3281908](https://github.com/jxsuite/jx/commit/328190812bb9716de5618da9365b4e4e43cfe7f0))
* **schema:** validate $paths against the source union instead of any object ([b801a9b](https://github.com/jxsuite/jx/commit/b801a9b503d2b116044b9e1d9b2f9ede9d99d5b7))
* **studio,server,desktop:** dev server bypassed the build; Monaco still loaded at startup ([288fb73](https://github.com/jxsuite/jx/commit/288fb73a0aae78318f17a4d1a24a73e0a523104e))
* **studio:** keep the Data panel's Refresh able to fetch, and stop happy-dom loading canvas iframes ([08b149b](https://github.com/jxsuite/jx/commit/08b149b0273bcea8177b302b33e1a5bfb366779e))

## [1.4.0](https://github.com/jxsuite/jx/compare/schema-v1.3.0...schema-v1.4.0) (2026-07-24)


### Features

* support external/relative asset files ([368c909](https://github.com/jxsuite/jx/commit/368c9092214a2d589d20f7d2ddad03e698b76940))

## [1.3.0](https://github.com/jxsuite/jx/compare/schema-v1.2.0...schema-v1.3.0) (2026-07-22)


### Features

* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))


### Bug Fixes

* harden dev server and unify runtime/compiler evaluation ([47a1d4c](https://github.com/jxsuite/jx/commit/47a1d4c90f29c6389049f389c97389857f24f855))
* **schema:** cover admission blocks, capability roles, and the rendering grammar ([ee6ccc1](https://github.com/jxsuite/jx/commit/ee6ccc13f6dfb579f5913273d61e02c13a8c6ba1))

## [1.2.0](https://github.com/jxsuite/jx/compare/schema-v1.1.0...schema-v1.2.0) (2026-07-18)


### Features

* color scheme support ([0f380c6](https://github.com/jxsuite/jx/commit/0f380c61a16c7bf0061628d0c7ccac5e3e045f4a))
* **compiler:** sidecar bundling, extension emit capability, heading anchors ([07e28bc](https://github.com/jxsuite/jx/commit/07e28bc37f3d96ffdc2d42a7f3fa4d5ceb9eb3de))
* search package ([9262c68](https://github.com/jxsuite/jx/commit/9262c68e5797ed1c4c2b9103e0f73e676a30ef39))
* **styling:** forced color-scheme contract — dual emission, color-scheme triplet, pre-paint script ([e629684](https://github.com/jxsuite/jx/commit/e629684da928ff18f710857601741c9c7db7585d))


### Bug Fixes

* nix build ([96987cd](https://github.com/jxsuite/jx/commit/96987cd8abc4e6058702bca8beed37d1ff80795f))
* **schema:** don't polute tree on schema generation ([9c96c85](https://github.com/jxsuite/jx/commit/9c96c85226fb785920853f2b713b301606d49f21))

## [1.1.0](https://github.com/jxsuite/jx/compare/schema-v1.0.0...schema-v1.1.0) (2026-07-17)


### Features

* **compiler,server,create:** jx dev and jx preview — the scaffolded scripts now work ([c0ff0d9](https://github.com/jxsuite/jx/commit/c0ff0d9d36715886b3f819b8d7ceebd682593583))
* **runtime,schema,formulas:** pure method operators and the composite formula catalog (spec §19.4d) ([58be3b1](https://github.com/jxsuite/jx/commit/58be3b1aac98ae50b7b1be543fa765c5c83adc46))
* **runtime,schema,studio:** blessed Intl helpers and object-literal expression operands ([e77a1f2](https://github.com/jxsuite/jx/commit/e77a1f233d28221a9e7b7209c234914d7988ef4d))
* **schema,runtime,studio:** structured function bodies and the statement editor (spec §20) ([1bc949a](https://github.com/jxsuite/jx/commit/1bc949ad6961513152066aee33d7a95f5a975fb2))
* **schema,runtime:** conditional operators and editor evaluation trace (spec §19.4b, §19.9) ([7992624](https://github.com/jxsuite/jx/commit/79926245807f27773e55da61374c05aa5f33dbd4))
* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))

## [1.0.0](https://github.com/jxsuite/jx/compare/schema-v0.35.0...schema-v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

- move @jxsuite/parser to the extensions/ tree
- hosts switch to the extension model; migrate all projects to content sections

### Features

- **connector:** dynamic data tables extension — Kysely core, /_jx/data mount, db push ([3085ab4](https://github.com/jxsuite/jx/commit/3085ab4d29c2c0c9f0b3a3007aadbd17da1994d4))
- hosts switch to the extension model; migrate all projects to content sections ([c40b45c](https://github.com/jxsuite/jx/commit/c40b45c2c1ac2052cba4467d9353de22f4c0f060))
- **markup:** shared markup-conversion core package; sever studio/import from parser ([a075e74](https://github.com/jxsuite/jx/commit/a075e74a6c45e91b1d1c7c1a6007e2e344fbb341))
- move @jxsuite/parser to the extensions/ tree ([07cd6e0](https://github.com/jxsuite/jx/commit/07cd6e0ad1ef24fe60013de996e5cf0592ff1131))
- **schema:** manifest-driven extension registry ([ce04250](https://github.com/jxsuite/jx/commit/ce04250e6bf7819367c8957da8cf22312ad567ca))
- **schema:** shipped schema fragments + per-project schema emitters ([9e4a893](https://github.com/jxsuite/jx/commit/9e4a8936c4de73c6f1d0499c917340cfc6bf067a))
- **studio:** descriptor-contributed settings + fetched project schemas ([60f1465](https://github.com/jxsuite/jx/commit/60f1465cdc18c07c7d172372f4df2d67dee1ca88))

## [0.35.0](https://github.com/jxsuite/jx/compare/schema-v0.34.0...schema-v0.35.0) (2026-07-07)

### Features

- **schema:** build.deploy tracking block; fix stale adapter enum ([2c14856](https://github.com/jxsuite/jx/commit/2c148561f4f9329cb3e23d5d5fa3dc330fe121c5))
