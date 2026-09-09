# Changelog

## [2.0.0](https://github.com/jxsuite/jx/compare/site-v1.1.0...site-v2.0.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* **runtime,compiler,site,studio:** `@jxsuite/runtime` no longer writes authored declarations to `el.style`, so code reading them back off an element after `applyStyle` sees nothing. The `elementStyleTags` export is replaced by `releaseElementStyles` and `resetDocumentStyles`, which refcount a shared rule set rather than handing out an element to remove by hand; `documentStyleText` reads back what was written.

### Features

* **runtime,compiler,site,studio:** authored styles become adopted CSS rules ([1542477](https://github.com/jxsuite/jx/commit/15424770e40f979eaaad78682004cf8d87f8180f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/runtime bumped to 4.0.0
    * @jxsuite/schema bumped to 2.2.0

## [1.1.0](https://github.com/jxsuite/jx/compare/site-v1.0.0...site-v1.1.0) (2026-08-30)


### Features

* **compiler,server:** a site deployed under a subpath resolves its URLs against url's path ([c4b7f27](https://github.com/jxsuite/jx/commit/c4b7f27c82a19bfa1f62eff8a75597c13a3f90be))
* **compiler,server:** a site deployed under a subpath resolves its URLs against url's path ([988abd8](https://github.com/jxsuite/jx/commit/988abd8d3614f0ba3ce6cd8b1c1db589fef0a511)), closes [#235](https://github.com/jxsuite/jx/issues/235)
* **runtime:** @jxsuite/runtime/css, so composing a stylesheet costs no renderer ([d27683a](https://github.com/jxsuite/jx/commit/d27683ad3a985e319d09c0a1bfef6fbbd9cfa167))
* **runtime:** @jxsuite/runtime/css, so composing a stylesheet costs no renderer ([61bb842](https://github.com/jxsuite/jx/commit/61bb8426cdaeec85634e4ad4244d73ff3bf3c52a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/runtime bumped to 3.1.0
    * @jxsuite/schema bumped to 2.1.0

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
