# Changelog

## [0.0.14](https://github.com/jxsuite/jx/compare/formulas-v0.0.13...formulas-v0.0.14) (2026-08-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.9.0
  * devDependencies
    * @jxsuite/runtime bumped to 2.1.0

## [0.0.13](https://github.com/jxsuite/jx/compare/formulas-v0.0.12...formulas-v0.0.13) (2026-08-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.8.1
  * devDependencies
    * @jxsuite/runtime bumped to 2.0.5

## [0.0.12](https://github.com/jxsuite/jx/compare/formulas-v0.0.11...formulas-v0.0.12) (2026-08-24)


### Bug Fixes

* **tests:** make the Windows suites runnable ([1c23891](https://github.com/jxsuite/jx/commit/1c23891ec56dce22e1e900ae151a49cb1ecdbe25))

## [0.0.11](https://github.com/jxsuite/jx/compare/formulas-v0.0.10...formulas-v0.0.11) (2026-08-24)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/runtime bumped to 2.0.4

## [0.0.10](https://github.com/jxsuite/jx/compare/formulas-v0.0.9...formulas-v0.0.10) (2026-08-23)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/runtime bumped to 2.0.3

## [0.0.9](https://github.com/jxsuite/jx/compare/formulas-v0.0.8...formulas-v0.0.9) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.8.0
  * devDependencies
    * @jxsuite/runtime bumped to 2.0.2

## [0.0.8](https://github.com/jxsuite/jx/compare/formulas-v0.0.7...formulas-v0.0.8) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.7.0
  * devDependencies
    * @jxsuite/runtime bumped to 2.0.1

## [0.0.7](https://github.com/jxsuite/jx/compare/formulas-v0.0.6...formulas-v0.0.7) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.6.0
  * devDependencies
    * @jxsuite/runtime bumped to 2.0.0

## [0.0.6](https://github.com/jxsuite/jx/compare/formulas-v0.0.5...formulas-v0.0.6) (2026-07-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.5.0
  * devDependencies
    * @jxsuite/runtime bumped to 1.3.2

## [0.0.5](https://github.com/jxsuite/jx/compare/formulas-v0.0.4...formulas-v0.0.5) (2026-07-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.4.0
  * devDependencies
    * @jxsuite/runtime bumped to 1.3.1

## [0.0.4](https://github.com/jxsuite/jx/compare/formulas-v0.0.3...formulas-v0.0.4) (2026-07-22)


### Features

* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.3.0
  * devDependencies
    * @jxsuite/runtime bumped to 1.3.0

## [0.0.3](https://github.com/jxsuite/jx/compare/formulas-v0.0.2...formulas-v0.0.3) (2026-07-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.2.0
  * devDependencies
    * @jxsuite/runtime bumped to 1.2.0

## [0.0.2](https://github.com/jxsuite/jx/compare/formulas-v0.0.1...formulas-v0.0.2) (2026-07-17)


### Features

* **formulas:** packaging, docs, and studio copy-in consumption ([f5df14f](https://github.com/jxsuite/jx/commit/f5df14f125b2fca2224cce68aa4674b3c7d9071a))
* **runtime,schema,formulas:** pure method operators and the composite formula catalog (spec §19.4d) ([58be3b1](https://github.com/jxsuite/jx/commit/58be3b1aac98ae50b7b1be543fa765c5c83adc46))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.1.0
  * devDependencies
    * @jxsuite/runtime bumped to 1.1.0

## 0.0.1 (2026-07-16)

### Features

- Initial catalog: 15 composite pure formulas (`clamp`, `sum`, `average`,
  `count`, `min`, `max`, `first`, `last`, `isEmpty`, `compact`, `percent`,
  `roundTo`, `capitalize`, `truncate`, `initials`) authored as declarative
  `$expression` JSON with CEM parameter metadata, a purity-verifying catalog
  generator, and `formulaEntries()` for merging the catalog into document or
  project state.
