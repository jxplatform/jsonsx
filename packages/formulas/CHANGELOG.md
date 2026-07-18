# Changelog

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
