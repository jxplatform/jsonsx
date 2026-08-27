# Changelog

## [1.0.0](https://github.com/jxsuite/jx/compare/site-v0.1.0...site-v1.0.0) (2026-08-27)


### ⚠ BREAKING CHANGES

* **schema,site:** `@jxsuite/schema` no longer exports `./routes`, `./layout`, `./context` or `./head-merger`. Import them from `@jxsuite/site`; the modules and their behaviour are unchanged.

### Features

* Open in Browser previews the working tree through the runtime ([b02e0e5](https://github.com/jxsuite/jx/commit/b02e0e543016879c963810f770b568995023e6ed))
* **site:** compose a page at a route, and the document that boots it ([13594df](https://github.com/jxsuite/jx/commit/13594df2e6def236e4a3074effaea3b10497b1b2))


### Bug Fixes

* **desktop,import:** the two gates the live preview left red, and the coverage it owed ([72657b7](https://github.com/jxsuite/jx/commit/72657b7c636d63aecb831378e5f16e134b062adb))
* **site:** the composer discovers the components a page uses, not only the ones it declares ([ef539ac](https://github.com/jxsuite/jx/commit/ef539ac2c91fdd1a6ea6d8e5b461090853eb4b03))


### Code Refactoring

* **schema,site:** site composition gets its own package ([f9d270d](https://github.com/jxsuite/jx/commit/f9d270daf261eef9ac9566192787b7a4bba25135))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/runtime bumped to 3.0.0
    * @jxsuite/schema bumped to 2.0.0
