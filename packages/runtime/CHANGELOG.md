# Changelog

## [2.0.5](https://github.com/jxsuite/jx/compare/runtime-v2.0.4...runtime-v2.0.5) (2026-08-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.8.1

## [2.0.4](https://github.com/jxsuite/jx/compare/runtime-v2.0.3...runtime-v2.0.4) (2026-08-24)


### Bug Fixes

* **runtime:** a reflected property name no longer clobbers a declared default ([#188](https://github.com/jxsuite/jx/issues/188)) ([9e40d99](https://github.com/jxsuite/jx/commit/9e40d999719ac276e2927e5af5a7c313facae2c2))

## [2.0.3](https://github.com/jxsuite/jx/compare/runtime-v2.0.2...runtime-v2.0.3) (2026-08-23)


### Bug Fixes

* **canvas:** project files load on a host that does not serve them at its root ([#176](https://github.com/jxsuite/jx/issues/176)) ([eba67a9](https://github.com/jxsuite/jx/commit/eba67a9206eec389090a9fd4e0b77b29891ed32a))

## [2.0.2](https://github.com/jxsuite/jx/compare/runtime-v2.0.1...runtime-v2.0.2) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.8.0

## [2.0.1](https://github.com/jxsuite/jx/compare/runtime-v2.0.0...runtime-v2.0.1) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.7.0

## [2.0.0](https://github.com/jxsuite/jx/compare/runtime-v1.3.2...runtime-v2.0.0) (2026-08-19)


### ⚠ BREAKING CHANGES

* **runtime:** #/state/a/b.c addresses member "b.c" of "a" rather than walking three levels. 451 of 452 pointers in the corpus are pure-slash and the one dotted ref was in the spec sentence describing the behavior.

### Features

* **auth:** a loopback redirect with PKCE, and cookies a browser will keep ([053f67c](https://github.com/jxsuite/jx/commit/053f67cf94216020dd2a39982cea30b3802ba3aa))
* **i18n:** a page can render its own language switcher, and formats in its own language ([354e481](https://github.com/jxsuite/jx/commit/354e481b2bb45fc6be72d9af537d560c2f971d80))
* **i18n:** format for a language, and count what a reader sees ([fa8affd](https://github.com/jxsuite/jx/commit/fa8affdc2b1936d1ef9365379c490aa49608c552))
* **i18n:** multilingual sites, end to end — framework, Studio, extensions and a starter ([692e50f](https://github.com/jxsuite/jx/commit/692e50f9d7132daf71a63c950fd740b103766cb0))
* **runtime:** enforce private state against $props (spec.md §5.6) ([c8fffc5](https://github.com/jxsuite/jx/commit/c8fffc5a00a0b022717c81bc303b5331ca9b7488))
* **schema,runtime,compiler,studio:** a tag can be chosen at element creation ([e31a20f](https://github.com/jxsuite/jx/commit/e31a20fb52b7e718be67ed59338d149abf3562c1))
* **studio:** a Trusted Types policy that refuses, and two CSP profiles stated as permanent ([0efad17](https://github.com/jxsuite/jx/commit/0efad1772618bf8cc363591f0f89e6b2e154877b))
* **studio:** the Named Shell — P0–P8, the full UX redesign ([b576cbb](https://github.com/jxsuite/jx/commit/b576cbb24c7e0d8d36075f6d682e9b3b6b971166))


### Bug Fixes

* **compiler:** head identity, JSON-LD objects, and per-page lang ([61484bc](https://github.com/jxsuite/jx/commit/61484bcc4981eb51062c5fffc5c0574842140dd3))
* **parser:** localized content never reached its own locale's asset mount ([179311b](https://github.com/jxsuite/jx/commit/179311b3f56d001eea37c092d73956c20056c55d))
* **runtime:** one $ref tokenizer, so every lowered ref parses ([d57bed4](https://github.com/jxsuite/jx/commit/d57bed4495c0887b512a07d5e1b9f6e66c4462f3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.6.0

## [1.3.2](https://github.com/jxsuite/jx/compare/runtime-v1.3.1...runtime-v1.3.2) (2026-07-30)


### Performance Improvements

* **studio,runtime:** stop refetching on every canvas render, narrow the splice escalation ([bad5b08](https://github.com/jxsuite/jx/commit/bad5b084884ffae3cff7e4d7a0dba1d43508314a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.5.0

## [1.3.1](https://github.com/jxsuite/jx/compare/runtime-v1.3.0...runtime-v1.3.1) (2026-07-24)


### Bug Fixes

* **runtime:** trigger-independent proper component mapping ([28ab97b](https://github.com/jxsuite/jx/commit/28ab97b7795db7aa26dfd3abcf33198d0144b3f1))
* **runtime:** trigger-independent proper component mapping ([88157e3](https://github.com/jxsuite/jx/commit/88157e3cd100c0e497da934ef1cd7161e0946039))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.4.0

## [1.3.0](https://github.com/jxsuite/jx/compare/runtime-v1.2.0...runtime-v1.3.0) (2026-07-22)


### Features

* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))


### Bug Fixes

* harden dev server and unify runtime/compiler evaluation ([47a1d4c](https://github.com/jxsuite/jx/commit/47a1d4c90f29c6389049f389c97389857f24f855))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.3.0

## [1.2.0](https://github.com/jxsuite/jx/compare/runtime-v1.1.0...runtime-v1.2.0) (2026-07-18)


### Features

* color scheme support ([0f380c6](https://github.com/jxsuite/jx/commit/0f380c61a16c7bf0061628d0c7ccac5e3e045f4a))
* **styling:** forced color-scheme contract — dual emission, color-scheme triplet, pre-paint script ([e629684](https://github.com/jxsuite/jx/commit/e629684da928ff18f710857601741c9c7db7585d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.2.0

## [1.1.0](https://github.com/jxsuite/jx/compare/runtime-v1.0.0...runtime-v1.1.0) (2026-07-17)


### Features

* **runtime,compiler:** named formulas — call operator, $args scheme, blessed globals ([24d516b](https://github.com/jxsuite/jx/commit/24d516bd3310fdd2630507b38d25a0a87d080e46))
* **runtime,schema,formulas:** pure method operators and the composite formula catalog (spec §19.4d) ([58be3b1](https://github.com/jxsuite/jx/commit/58be3b1aac98ae50b7b1be543fa765c5c83adc46))
* **runtime,schema,studio:** blessed Intl helpers and object-literal expression operands ([e77a1f2](https://github.com/jxsuite/jx/commit/e77a1f233d28221a9e7b7209c234914d7988ef4d))
* **schema,runtime,studio:** structured function bodies and the statement editor (spec §20) ([1bc949a](https://github.com/jxsuite/jx/commit/1bc949ad6961513152066aee33d7a95f5a975fb2))
* **schema,runtime:** conditional operators and editor evaluation trace (spec §19.4b, §19.9) ([7992624](https://github.com/jxsuite/jx/commit/79926245807f27773e55da61374c05aa5f33dbd4))
* **studio:** inline editing of component property bound text ([898dbcb](https://github.com/jxsuite/jx/commit/898dbcbff5a9db6e1f4369515bec1f52baa2fa70))
* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.1.0

## [1.0.0](https://github.com/jxsuite/jx/compare/runtime-v0.34.2...runtime-v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

- move @jxsuite/parser to the extensions/ tree

### Features

- move @jxsuite/parser to the extensions/ tree ([07cd6e0](https://github.com/jxsuite/jx/commit/07cd6e0ad1ef24fe60013de996e5cf0592ff1131))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/schema bumped to 1.0.0

## [0.34.2](https://github.com/jxsuite/jx/compare/runtime-v0.34.1...runtime-v0.34.2) (2026-07-07)

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/schema bumped to 0.35.0

## [0.34.1](https://github.com/jxsuite/jx/compare/runtime-v0.34.0...runtime-v0.34.1) (2026-07-06)

### Bug Fixes

- **runtime:** proper handling of default content ([73ddb02](https://github.com/jxsuite/jx/commit/73ddb02eed74c69587739eb8f257736e30001158))
- **studio:** proper handling of relative component references ([eb20e2f](https://github.com/jxsuite/jx/commit/eb20e2f5ad5b8c27888f3b52d2ca76a24c5afb19))
