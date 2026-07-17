# Changelog

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
