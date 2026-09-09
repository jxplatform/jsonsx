# Changelog

## [0.40.2](https://github.com/jxsuite/jx/compare/import-v0.40.1...import-v0.40.2) (2026-09-09)


### Bug Fixes

* **import:** stop pinning imported layouts to their capture viewport ([71132d7](https://github.com/jxsuite/jx/commit/71132d723e2c308a677c89e96eb887f25d341b31))
* **import:** stop pinning imported layouts to their capture viewport ([158e989](https://github.com/jxsuite/jx/commit/158e989c27d78c24f5eada237b802526cf8020ae))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.4.10
    * @jxsuite/schema bumped to 2.2.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 4.0.0

## [0.40.1](https://github.com/jxsuite/jx/compare/import-v0.40.0...import-v0.40.1) (2026-08-30)


### Bug Fixes

* **studio:** a lapsed Cloudflare grant no longer ends the connect flow before it starts ([83102d2](https://github.com/jxsuite/jx/commit/83102d2eaf64752895efe8118afacc605eaa2aff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.4.9
    * @jxsuite/schema bumped to 2.1.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 3.1.0

## [0.40.0](https://github.com/jxsuite/jx/compare/import-v0.39.8...import-v0.40.0) (2026-08-27)


### Features

* **import:** limit the breakpoints an import keeps, and strip the classes it cannot use ([9ac5b60](https://github.com/jxsuite/jx/commit/9ac5b600a0b6834bb031daa64e1283ab51346cff))
* **import:** make jx-import --verify able to fail ([71382d5](https://github.com/jxsuite/jx/commit/71382d54e604aad01beba52d08ec99d826b13bee)), closes [#232](https://github.com/jxsuite/jx/issues/232)
* **import:** the site-import workflow, end to end ([eab1109](https://github.com/jxsuite/jx/commit/eab1109e0fc21a5f311d2f1c8f90626c1d51c55d))
* Open in Browser previews the working tree through the runtime ([b02e0e5](https://github.com/jxsuite/jx/commit/b02e0e543016879c963810f770b568995023e6ed))
* **server,studio:** the import stream says what the run found, and can check its own fidelity ([2e4c0e3](https://github.com/jxsuite/jx/commit/2e4c0e3dd1b63aead94bb70379c7ad8738420fd8))
* **studio:** the site import is an agent turn — model, brief, live status, and a pause to ask ([775abee](https://github.com/jxsuite/jx/commit/775abeeb20a4f1a727072ea60191c32bea5d0d9f))


### Bug Fixes

* **desktop,import:** the two gates the live preview left red, and the coverage it owed ([72657b7](https://github.com/jxsuite/jx/commit/72657b7c636d63aecb831378e5f16e134b062adb))
* **import:** emit a project that actually builds into a working site ([6b808d6](https://github.com/jxsuite/jx/commit/6b808d6811de8ab6ec245ff1028ca681b8ee05c2))
* **import:** emit a project.json the schema accepts ([352c67f](https://github.com/jxsuite/jx/commit/352c67fb76dda22d5f32d8d33b1baf37d96c5327)), closes [#228](https://github.com/jxsuite/jx/issues/228)
* **import:** parse srcset without shredding a url that carries commas ([eeb8a7d](https://github.com/jxsuite/jx/commit/eeb8a7d5853175b656290b2b1b21dc434b692abb)), closes [#231](https://github.com/jxsuite/jx/issues/231)
* **import:** reference an asset by the path the built site serves ([34856ec](https://github.com/jxsuite/jx/commit/34856ec28d3b89eee93b8eb9816010f23c86ded4)), closes [#229](https://github.com/jxsuite/jx/issues/229)
* **import:** rewrite a font-face url to the font that was downloaded ([cc27b5f](https://github.com/jxsuite/jx/commit/cc27b5f5ce1d71679e40e77f1228558976b63988)), closes [#230](https://github.com/jxsuite/jx/issues/230)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.4.8
    * @jxsuite/schema bumped to 2.0.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 3.0.0

## [0.39.8](https://github.com/jxsuite/jx/compare/import-v0.39.7...import-v0.39.8) (2026-08-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.4.7
    * @jxsuite/schema bumped to 1.9.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 2.0.8

## [0.39.7](https://github.com/jxsuite/jx/compare/import-v0.39.6...import-v0.39.7) (2026-08-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.4.6
    * @jxsuite/schema bumped to 1.8.1
  * optionalDependencies
    * @jxsuite/compiler bumped to 2.0.7

## [0.39.6](https://github.com/jxsuite/jx/compare/import-v0.39.5...import-v0.39.6) (2026-08-24)


### Dependencies

* The following workspace dependencies were updated
  * optionalDependencies
    * @jxsuite/compiler bumped to 2.0.6

## [0.39.5](https://github.com/jxsuite/jx/compare/import-v0.39.4...import-v0.39.5) (2026-08-24)


### Dependencies

* The following workspace dependencies were updated
  * optionalDependencies
    * @jxsuite/compiler bumped to 2.0.5

## [0.39.4](https://github.com/jxsuite/jx/compare/import-v0.39.3...import-v0.39.4) (2026-08-23)


### Dependencies

* The following workspace dependencies were updated
  * optionalDependencies
    * @jxsuite/compiler bumped to 2.0.4

## [0.39.3](https://github.com/jxsuite/jx/compare/import-v0.39.2...import-v0.39.3) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * optionalDependencies
    * @jxsuite/compiler bumped to 2.0.3

## [0.39.2](https://github.com/jxsuite/jx/compare/import-v0.39.1...import-v0.39.2) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.4.5
    * @jxsuite/schema bumped to 1.8.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 2.0.2

## [0.39.1](https://github.com/jxsuite/jx/compare/import-v0.39.0...import-v0.39.1) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.4.4
    * @jxsuite/schema bumped to 1.7.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 2.0.1

## [0.39.0](https://github.com/jxsuite/jx/compare/import-v0.38.2...import-v0.39.0) (2026-08-19)


### Features

* **schema,runtime,compiler,studio:** a tag can be chosen at element creation ([e31a20f](https://github.com/jxsuite/jx/commit/e31a20fb52b7e718be67ed59338d149abf3562c1))
* **studio:** the Named Shell — P0–P8, the full UX redesign ([b576cbb](https://github.com/jxsuite/jx/commit/b576cbb24c7e0d8d36075f6d682e9b3b6b971166))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.4.3
    * @jxsuite/schema bumped to 1.6.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 2.0.0

## [0.38.2](https://github.com/jxsuite/jx/compare/import-v0.38.1...import-v0.38.2) (2026-07-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.4.2
    * @jxsuite/schema bumped to 1.5.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 1.5.0

## [0.38.1](https://github.com/jxsuite/jx/compare/import-v0.38.0...import-v0.38.1) (2026-07-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.4.1
    * @jxsuite/schema bumped to 1.4.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 1.4.0

## [0.38.0](https://github.com/jxsuite/jx/compare/import-v0.37.1...import-v0.38.0) (2026-07-22)


### Features

* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.4.0
    * @jxsuite/schema bumped to 1.3.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 1.3.0

## [0.37.1](https://github.com/jxsuite/jx/compare/import-v0.37.0...import-v0.37.1) (2026-07-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.3.1
    * @jxsuite/schema bumped to 1.2.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 1.2.0

## [0.37.0](https://github.com/jxsuite/jx/compare/import-v0.36.0...import-v0.37.0) (2026-07-17)


### Features

* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/markup bumped to 0.3.0
    * @jxsuite/schema bumped to 1.1.0
  * optionalDependencies
    * @jxsuite/compiler bumped to 1.1.0

## [0.36.0](https://github.com/jxsuite/jx/compare/import-v0.35.1...import-v0.36.0) (2026-07-13)

### Features

- **markup:** shared markup-conversion core package; sever studio/import from parser ([a075e74](https://github.com/jxsuite/jx/commit/a075e74a6c45e91b1d1c7c1a6007e2e344fbb341))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/markup bumped to 0.2.0
    - @jxsuite/schema bumped to 1.0.0
  - optionalDependencies
    - @jxsuite/compiler bumped to 1.0.0

## [0.35.1](https://github.com/jxsuite/jx/compare/import-v0.35.0...import-v0.35.1) (2026-07-07)

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/parser bumped to 0.35.1
    - @jxsuite/schema bumped to 0.35.0
  - optionalDependencies
    - @jxsuite/compiler bumped to 0.35.0

## [0.35.0](https://github.com/jxsuite/jx/compare/import-v0.34.0...import-v0.35.0) (2026-07-06)

### Features

- site import package, ui + starter templates & wizard ([9c44e4a](https://github.com/jxsuite/jx/commit/9c44e4abe7e9d75c1129c179a419f5a390f86da9))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/parser bumped to 0.35.0
  - optionalDependencies
    - @jxsuite/compiler bumped to 0.34.1
